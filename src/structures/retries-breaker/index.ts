import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_GAP, CELL_H, TAG_H, TRAY_PAD } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/RetriesBreaker.java?raw';
import python from './code/retries_breaker.py?raw';
import { info } from './info';

/**
 * Four clients call one downstream service through a client library.
 *
 * Each client has a retry policy, a circuit breaker and, once Budget has
 * turned them on, a retry budget and a deadline per call. The downstream is
 * healthy, failing (every request gets 503), slow (every request times out)
 * or recovering (it serves CAPACITY requests per tick and sheds the rest).
 *
 * Time is a clock in ticks. An attempt is answered in the tick it is sent, so
 * a half-open breaker never has two probes in flight at once.
 */
export type Health = 'healthy' | 'failing' | 'slow' | 'recovering';
export type BState = 'closed' | 'open' | 'half-open';
export type Result = 'ok' | '503' | 'timeout' | 'fast';

export const POLICIES = ['none', 'immediate', 'fixed', 'exponential', 'jitter'] as const;
export const POLICY_LABEL = ['No retries', 'Immediate retry', 'Fixed delay', 'Exponential backoff', 'Exponential backoff with jitter'];
export const NONE = 0;
export const IMMEDIATE = 1;
export const FIXED = 2;
export const EXPONENTIAL = 3;
export const JITTER = 4;

export const NAMES = ['A', 'B', 'C', 'D'] as const;
/** The first call and up to three retries. */
export const MAX_ATTEMPTS = 4;
export const BASE = 2;
export const CAP = 6;
export const FIXED_DELAY = 2;
export const THRESHOLD = 3;
/** Failures older than this many ticks no longer count. */
export const WINDOW = 10;
export const OPEN_FOR = 4;
/** Requests per tick a recovering downstream can serve. */
export const CAPACITY = 2;
/** Ticks in a row within capacity before a recovering downstream is healthy. */
export const CALM_TICKS = 5;
/** Ticks a storm keeps the downstream failing. */
export const DOWN_FOR = 3;
/** Retry budget, in tenths of a token: each call earns 0.2, each retry costs 1, at most 2 saved. */
export const EARN = 2;
export const COST = 10;
export const BUDGET_CAP = 20;
/** Ticks drawn on the timeline. */
export const SHOWN = 15;
export const MAX_TICK = 999;
export const SEED = 16;

export interface Mark {
  tick: number;
  attempt: number;
  result: Result;
}

export interface Chain {
  attempt: number;
  /** Tick of the next attempt, or null while it is being decided. */
  due: number | null;
  policy: number;
  /** Tick by which the caller wants an answer, or null. */
  deadline: number | null;
  /** False when the call skips the breaker (the storm). */
  guarded: boolean;
}

export interface Client {
  name: string;
  state: BState;
  /** Ticks of recent failures, oldest first. */
  failures: number[];
  openUntil: number;
  chain: Chain | null;
  /** Retry tokens in tenths, or null when there is no budget. */
  tokens: number | null;
  /** The page's record of attempts, for the timeline. */
  marks: Mark[];
  /** The page draws one request per client per tick. */
  lastSent: number;
}

export interface RBState {
  policy: number;
  breakerOn: boolean;
  clients: Client[];
  health: Health;
  calm: number;
  /** Requests received per tick. */
  load: Record<number, number>;
  /** Requests shed per tick while recovering. */
  shed: Record<number, number>;
  /** Health at each tick, for the bands under the load row. */
  healthAt: Record<number, Health>;
  now: number;
  /** First tick on the timeline. */
  viewFrom: number;
  /** Mulberry32 state, so jitter replays the same way. */
  rng: number;
  /** Ticks a call may take, 0 when Budget is off. */
  deadline: number;
}

export function create(policy = JITTER, breakerOn = true): RBState {
  return {
    policy,
    breakerOn,
    clients: NAMES.map((name) => ({ name, state: 'closed' as BState, failures: [], openUntil: 0, chain: null, tokens: null, marks: [], lastSent: -1 })),
    health: 'healthy',
    calm: 0,
    load: {},
    shed: {},
    healthAt: { 0: 'healthy' },
    now: 0,
    viewFrom: 0,
    rng: SEED,
    deadline: 0,
  };
}

/** Mulberry32, the same generator as the listings. */
export function nextRandom(s: RBState): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const recent = (c: Client, now: number) => c.failures.filter((t) => t > now - WINDOW).length;
export const busy = (c: Client) => c.chain !== null;
export const free = (s: RBState, c: Client) => !c.chain && c.lastSent < s.now;
export const clientOf = (s: RBState, raw: number | string) => s.clients.find((c) => c.name === String(raw).trim().toUpperCase()) ?? null;
export function policyOf(raw: number | string): number | null {
  const w = String(raw).trim().toLowerCase();
  if (w === 'exp') return EXPONENTIAL;
  const i = POLICIES.indexOf(w as (typeof POLICIES)[number]);
  if (i >= 0) return i;
  const n = Number(w);
  return Number.isInteger(n) && n >= 0 && n < POLICIES.length ? n : null;
}

const markId = (name: string, tick: number) => `m${name}${tick}`;
const loadId = (tick: number) => `L${tick}`;
const ticks = (n: number) => `${n} ${n === 1 ? 'tick' : 'ticks'}`;
const tokenText = (tenths: number) => (tenths / 10).toFixed(1);
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const policyName = (p: number) => POLICY_LABEL[p].toLowerCase();

// ---- the page's own bookkeeping ---------------------------------------------

/** Keep now and every due retry on the timeline. Jumps rather than creeps, so marks do not slide every tick. */
function ensureView(s: RBState): void {
  let need = s.now;
  for (const c of s.clients) if (c.chain?.due != null) need = Math.max(need, c.chain.due);
  if (need > s.viewFrom + SHOWN - 1) setView(s, Math.min(s.now, need - 10));
}

function setView(s: RBState, from: number): void {
  s.viewFrom = Math.max(0, from);
  for (const c of s.clients) c.marks = c.marks.filter((m) => m.tick >= s.viewFrom);
  for (const map of [s.load, s.shed, s.healthAt] as Record<number, unknown>[]) {
    for (const k of Object.keys(map)) if (Number(k) < s.viewFrom) delete map[Number(k)];
  }
}

// ---- one operation's context --------------------------------------------------

interface Ctx {
  rec: Rec;
  /** Highest load seen in one tick during this operation. */
  peak: number;
  /** The client whose attempts get every frame: one name, 'all' or none. */
  loud: string | 'all' | null;
  /** Anchor to light with the next attempt's first frame (the driver's line). */
  lead: string[];
  ok: number;
  gaveUp: number;
}

const isLoud = (ctx: Ctx, c: Client) => ctx.loud === 'all' || ctx.loud === c.name;

function takeLead(ctx: Ctx): string[] {
  const l = ctx.lead;
  ctx.lead = [];
  return l;
}

function noteLoad(ctx: Ctx, load: number): void {
  if (load > ctx.peak) {
    ctx.rec.count('peak', load - ctx.peak);
    ctx.peak = load;
  }
}

function setHealth(s: RBState, h: Health): void {
  s.health = h;
  s.calm = 0;
  s.healthAt[s.now] = h;
}

// ---- breaker ----------------------------------------------------------------

function tripBreaker(s: RBState, c: Client): void {
  c.state = 'open';
  c.openUntil = s.now + OPEN_FOR;
  c.failures = [];
}

/** Count a failure. Returns what happened, for the narration. */
function breakerFailure(s: RBState, c: Client, ctx: Ctx, probe: Probe): void {
  if (!s.breakerOn) return;
  const loud = isLoud(ctx, c);
  if (c.state === 'half-open') {
    tripBreaker(s, c);
    if (loud) {
      ctx.rec.line('failed', 'reopen');
      ctx.rec.step(`The probe failed, so ${c.name}'s breaker opens again, until tick ${c.openUntil}. The downstream is still not ready, and it was asked only once to find that out.`, { probe });
    }
    return;
  }
  c.failures.push(s.now);
  while (c.failures[0] <= s.now - WINDOW) c.failures.shift();
  const n = c.failures.length;
  const trips = n >= THRESHOLD;
  if (loud) {
    ctx.rec.markCell(`c${c.name}`, 2, 'compare');
    ctx.rec.line('failed', 'count', 'threshold');
    ctx.rec.compare(`${c.name} failures ${n}`, trips ? '≥' : '<', `threshold ${THRESHOLD}`, trips ? 'open the breaker' : 'stay closed', {
      probe,
      message: trips
        ? `${c.name} has had ${n} failures in the last ${WINDOW} ticks, which reaches the threshold of ${THRESHOLD}. The breaker opens.`
        : `${c.name} has had ${n} ${n === 1 ? 'failure' : 'failures'} in the last ${WINDOW} ticks, under the threshold of ${THRESHOLD}. The breaker stays closed.`,
    });
    ctx.rec.markCell(`c${c.name}`, 2, 'idle');
  }
  if (trips) {
    tripBreaker(s, c);
    if (loud) {
      ctx.rec.markCell(`c${c.name}`, 1, 'bad');
      ctx.rec.line('trip');
      ctx.rec.step(`${c.name}'s breaker is open until tick ${c.openUntil}. For ${ticks(OPEN_FOR)} its calls fail fast, without touching the downstream, which gets room to recover.`, { probe });
      ctx.rec.markCell(`c${c.name}`, 1, 'idle');
    }
  }
}

// ---- retry ------------------------------------------------------------------

/** Ticks to wait before retry n + 1, narrated for a loud client. Draws from the generator for jitter. */
function backoff(s: RBState, n: number, policy: number, ctx: Ctx, loud: boolean, probe: Probe): number {
  if (policy === IMMEDIATE) {
    if (loud) {
      ctx.rec.line('delay', 'immediate');
      ctx.rec.step(`Immediate retry: no wait at all. On this clock the soonest is the next tick, so every client that failed now retries together.`, { probe });
    }
    return 1;
  }
  if (policy === FIXED) {
    if (loud) {
      ctx.rec.line('delay', 'fixed');
      ctx.rec.step(`Fixed delay: wait ${ticks(FIXED_DELAY)}, every time. Clients that failed together stay together.`, { probe });
    }
    return FIXED_DELAY;
  }
  const raw = BASE * 2 ** n;
  const capped = Math.min(CAP, raw);
  if (loud) {
    ctx.rec.line('delay', 'exp');
    ctx.rec.compare(`${BASE} × 2^${n} = ${raw}`, raw > CAP ? '>' : '≤', `cap ${CAP}`, raw > CAP ? `cap it: ${CAP} ticks` : `${raw} ticks`, {
      probe,
      message:
        `Exponential backoff: base × 2^retries so far = ${BASE} × 2^${n} = ${raw}` +
        (raw > CAP ? `, more than the cap of ${CAP}, so wait ${CAP}.` : `, under the cap of ${CAP}.`) +
        (policy === EXPONENTIAL ? ` Every client that failed at this tick works out the same number.` : ``),
    });
  }
  if (policy !== JITTER) return capped;
  const d = 1 + Math.floor(nextRandom(s) * capped);
  if (loud) {
    ctx.rec.line('jitter');
    ctx.rec.step(`Full jitter: draw a random wait from 1 to ${capped} ticks. The draw is ${d}. Clients that failed together now come back apart.`, { probe });
  }
  return d;
}

/** Every error this page produces (503 and timeouts) is one that may pass, so all are retryable. */
function planRetry(s: RBState, c: Client, ctx: Ctx, probe: Probe): void {
  const ch = c.chain!;
  const loud = isLoud(ctx, c);
  if (ch.policy === NONE || ch.attempt >= MAX_ATTEMPTS) {
    c.chain = null;
    ctx.gaveUp++;
    if (loud) {
      ctx.rec.line('give_up_check', 'give_up');
      if (ch.policy === NONE) ctx.rec.step(ch.policy === s.policy ? `The policy is no retries, so ${c.name} gives up and its caller gets the error.` : `This call was made without retries, so it ends here with the error.`, { probe });
      else ctx.rec.compare(`attempt ${ch.attempt}`, '≥', `max ${MAX_ATTEMPTS}`, 'give up', { probe, message: `${c.name} has made ${MAX_ATTEMPTS} attempts, the most its policy allows. It gives up and its caller gets the error.` });
    }
    return;
  }
  const delay = backoff(s, ch.attempt - 1, ch.policy, ctx, loud, probe);
  const at = s.now + delay;
  if (ch.deadline !== null) {
    const late = at > ch.deadline;
    if (loud) {
      ctx.rec.line('deadline');
      ctx.rec.compare(`${s.now} + ${delay} = ${at}`, late ? '>' : '≤', `deadline ${ch.deadline}`, late ? 'stop now' : 'in time, go on', {
        probe,
        message: late
          ? `The retry would go out at tick ${at}, after the caller's deadline of tick ${ch.deadline}. Nobody would be waiting for the answer, so ${c.name} stops now and reports the error.`
          : `The retry would go out at tick ${at}, before the caller's deadline of tick ${ch.deadline}. It is worth making.`,
      });
    }
    if (late) {
      c.chain = null;
      ctx.gaveUp++;
      if (loud) {
        ctx.rec.line('cut');
        ctx.rec.step(`${c.name} gives up at tick ${s.now} after ${ch.attempt} ${ch.attempt === 1 ? 'attempt' : 'attempts'}, though its policy allowed ${MAX_ATTEMPTS}. The deadline cut the chain short.`, { probe });
      }
      return;
    }
  }
  if (c.tokens !== null) {
    const enough = c.tokens >= COST;
    if (loud) {
      ctx.rec.markCell(`c${c.name}`, 3, 'compare');
      ctx.rec.line('budget');
      ctx.rec.compare(`${c.name} tokens ${tokenText(c.tokens)}`, enough ? '≥' : '<', `cost ${tokenText(COST)}`, enough ? 'spend one, retry' : 'no retry', {
        probe,
        message: enough
          ? `${c.name}'s retry budget holds ${tokenText(c.tokens)} tokens and a retry costs 1. It can afford this one.`
          : `${c.name}'s retry budget holds ${tokenText(c.tokens)} tokens and a retry costs 1. Retries are already their full share of the traffic, so this one is not made.`,
      });
      ctx.rec.markCell(`c${c.name}`, 3, 'idle');
    }
    if (!enough) {
      c.chain = null;
      ctx.gaveUp++;
      if (loud) {
        ctx.rec.line('no_budget');
        ctx.rec.step(`${c.name} gives up. Each call earns 0.2 tokens, so under a long outage retries settle at about 1 for every 5 calls instead of 3 for every call.`, { probe });
      }
      return;
    }
    c.tokens -= COST;
  }
  ch.due = at;
  ensureView(s);
  if (loud) {
    const next: Probe = { text: `${c.name}${ch.attempt + 1}`, at: markId(c.name, at) };
    ctx.rec.unmark(markId(c.name, s.now));
    ctx.rec.line(c.tokens !== null ? 'spend' : 'schedule', 'schedule');
    ctx.rec.step(`${c.name}${ch.attempt + 1} is due at tick ${at}.` + (c.tokens !== null ? ` One token spent, ${tokenText(c.tokens)} left.` : ``), { probe: next });
  }
}

// ---- one attempt --------------------------------------------------------------

/** Send the next attempt of c's call at tick now, or fail fast. */
function attempt(s: RBState, c: Client, ctx: Ctx, first: boolean): Result {
  const ch = c.chain!;
  ch.attempt++;
  ch.due = null;
  const n = ch.attempt;
  const loud = isLoud(ctx, c);
  const id = markId(c.name, s.now);
  const probe: Probe = { text: `${c.name}${n}`, at: id };
  const lead = loud ? takeLead(ctx) : [];
  if (n > 1) ctx.rec.count('retries');
  c.lastSent = s.now;
  const guarded = ch.guarded && s.breakerOn;

  if (guarded && c.state === 'open') {
    c.marks.push({ tick: s.now, attempt: n, result: 'fast' });
    c.chain = null;
    ctx.rec.count('fast');
    if (loud) {
      ctx.rec.mark(id, 'key');
      ctx.rec.markCell(`c${c.name}`, 1, 'compare');
      ctx.rec.line(...lead, 'allow', 'fast');
      ctx.rec.compare(`tick ${s.now}`, '<', `open to ${c.openUntil}`, 'fail fast, send nothing', {
        probe,
        message: `${c.name}'s breaker is open until tick ${c.openUntil}, so ${c.name}${n} fails at once with no request sent. The caller learns in microseconds instead of waiting for a timeout, and the downstream sees no load from it.`,
      });
      ctx.rec.markCell(`c${c.name}`, 1, 'idle');
    }
    return 'fast';
  }

  const load = (s.load[s.now] ?? 0) + 1;
  s.load[s.now] = load;
  ctx.rec.count('reached');
  noteLoad(ctx, load);
  let result: Result;
  if (s.health === 'recovering') result = load <= CAPACITY ? 'ok' : '503';
  else result = s.health === 'healthy' ? 'ok' : s.health === 'failing' ? '503' : 'timeout';
  if (s.health === 'recovering' && result === '503') s.shed[s.now] = (s.shed[s.now] ?? 0) + 1;
  c.marks.push({ tick: s.now, attempt: n, result });

  if (loud) {
    ctx.rec.mark(id, 'key');
    ctx.rec.line(...lead, ...(first ? [] : ['fire']), 'allow', 'send', 'arrive');
    const why = guarded ? (c.state === 'half-open' ? `${c.name}'s breaker is half-open, so this request is the probe: the one call let through to test the downstream. ` : `${c.name}'s breaker is closed, so it goes out. `) : ``;
    ctx.rec.step(`${why}${c.name}${n} reaches the downstream at tick ${s.now}. That is ${load} ${load === 1 ? 'request' : 'requests'} it has received this tick.`, { probe });
    if (s.health === 'recovering') {
      ctx.rec.mark(loadId(s.now), 'compare');
      ctx.rec.line(result === 'ok' ? 'capacity' : 'shed');
      ctx.rec.compare(`tick ${s.now} load ${load}`, load <= CAPACITY ? '≤' : '>', `capacity ${CAPACITY}`, result === 'ok' ? 'served' : 'shed with 503', {
        probe,
        message:
          result === 'ok'
            ? `The downstream is recovering and can serve ${CAPACITY} a tick. This is request ${load}, so it is served.`
            : `The downstream is recovering and can serve only ${CAPACITY} a tick. This is request ${load}, so it is shed with 503. It cost the service something all the same.`,
      });
      ctx.rec.unmark(loadId(s.now));
    } else {
      ctx.rec.line('outcome');
      ctx.rec.step(
        s.health === 'healthy'
          ? `The downstream is healthy: 200 OK.`
          : s.health === 'failing'
            ? `503 Service Unavailable: the downstream is failing. An error like this may pass, so it is safe to retry, if the call itself is safe to repeat.`
            : `No answer within the per-attempt timeout, so ${c.name} stops waiting. The downstream may still finish the work, which is why only idempotent calls are retried.`,
        { probe },
      );
    }
  }

  if (result === 'ok') {
    c.chain = null;
    ctx.ok++;
    const closing = guarded && c.state === 'half-open';
    if (closing) {
      c.state = 'closed';
      c.failures = [];
    }
    if (loud) {
      ctx.rec.line('result', 'ok', ...(closing ? ['close'] : []));
      ctx.rec.step(
        closing
          ? `The probe succeeded, so ${c.name}'s breaker closes and its failure count is cleared. Calls flow again.`
          : `${c.name}${n} succeeded${n > 1 ? ` on attempt ${n}` : ``}. The call is done.`,
        { probe },
      );
    }
    return 'ok';
  }
  if (guarded) breakerFailure(s, c, ctx, probe);
  planRetry(s, c, ctx, probe);
  return result;
}

/** Start a call for c at tick now. Assumes c is free. */
function startCall(s: RBState, c: Client, policy: number, guarded: boolean, ctx: Ctx, lead: string[]): Result {
  c.chain = { attempt: 0, due: s.now, policy, deadline: s.deadline ? s.now + s.deadline : null, guarded };
  ctx.rec.count('calls');
  if (c.tokens !== null) c.tokens = Math.min(BUDGET_CAP, c.tokens + EARN);
  const loud = isLoud(ctx, c);
  if (loud) {
    const probe: Probe = { text: `${c.name}1`, at: markId(c.name, s.now) };
    ctx.rec.mark(markId(c.name, s.now), 'key');
    ctx.rec.line(...lead, 'call', ...(c.tokens !== null ? ['deposit', 'earn'] : []));
    ctx.rec.step(
      `${c.name} calls the downstream at tick ${s.now}. ${c.name}1 is its first attempt` +
        (policy === s.policy && guarded ? `.` : `, with ${policyName(policy)}.`) +
        (c.chain.deadline !== null ? ` Its caller will wait until tick ${c.chain.deadline} at most.` : ``) +
        (c.tokens !== null ? ` The call earns 0.2 retry tokens: ${c.name} now has ${tokenText(c.tokens)}.` : ``),
      { probe },
    );
  }
  const r = attempt(s, c, ctx, true);
  ctx.rec.unmark(markId(c.name, s.now));
  return r;
}

// ---- the clock ----------------------------------------------------------------

/** End the current tick and move to the next. Returns true when anything happened worth a frame. */
function advance(s: RBState, ctx: Ctx, lead: string[]): void {
  let event: 'healed' | 'overload' | null = null;
  if (s.health === 'recovering') {
    const load = s.load[s.now] ?? 0;
    if (load <= CAPACITY) s.calm++;
    else {
      s.calm = 0;
      event = 'overload';
    }
    if (s.calm >= CALM_TICKS) {
      s.health = 'healthy';
      s.calm = 0;
      event = 'healed';
    }
  }
  const was = s.now;
  s.now++;
  s.healthAt[s.now] = s.health;
  const opened: Client[] = [];
  for (const c of s.clients) {
    if (c.state === 'open' && s.now >= c.openUntil) {
      c.state = 'half-open';
      opened.push(c);
    }
  }
  ensureView(s);
  if (event === 'overload') {
    ctx.rec.mark(loadId(was), 'bad');
    ctx.rec.line(...lead, 'end_tick', 'overload');
    ctx.rec.step(`Tick ${was} sent the recovering downstream ${s.load[was]} requests, more than the ${CAPACITY} it can serve. Its count of calm ticks starts again from 0: retries arriving together are keeping it down.`);
    ctx.rec.unmark(loadId(was));
  } else if (event === 'healed') {
    ctx.rec.line(...lead, 'end_tick', 'healed');
    ctx.rec.step(`The downstream has stayed within its capacity for ${CALM_TICKS} ticks in a row. From tick ${s.now} it is healthy again.`);
  }
  for (const c of opened) {
    if (!isLoud(ctx, c)) continue;
    ctx.rec.markCell(`c${c.name}`, 1, 'compare');
    ctx.rec.line(...lead, 'breakers', 'wait', 'half_open');
    ctx.rec.step(`Tick ${s.now} has reached ${c.name}'s open-until time, so its breaker goes half-open. The next call will be let through as a probe; any others wait for its answer.`);
    ctx.rec.markCell(`c${c.name}`, 1, 'idle');
  }
}

const dueNow = (s: RBState) => s.clients.filter((c) => c.chain?.due === s.now);

/** Fire every retry due now, in client order. Quiet clients get one summary frame between them. */
function fireDue(s: RBState, ctx: Ctx, lead: string[]): void {
  const quiet: { c: Client; n: number; r: Result }[] = [];
  for (const c of s.clients) {
    if (!c.chain || c.chain.due !== s.now) continue;
    if (isLoud(ctx, c)) {
      ctx.lead = lead;
      attempt(s, c, ctx, false);
      ctx.rec.unmark(markId(c.name, s.now));
    } else {
      quiet.push({ c, n: c.chain.attempt + 1, r: attempt(s, c, ctx, false) });
    }
  }
  if (quiet.length) summarise(s, ctx, quiet, [...lead, 'fire']);
}

/** One frame for attempts that went out without frames of their own. */
function summarise(s: RBState, ctx: Ctx, done: { c: Client; n: number; r: Result }[], lines: string[]): void {
  const compares = s.health === 'recovering' || (s.shed[s.now] ?? 0) > 0;
  // With recording off, only the counter a comparison would have bumped matters.
  if (!ctx.rec.recording) return void (compares && ctx.rec.count('comparisons'));
  const names = done.map((d) => `${d.c.name}${d.n}`);
  const by = (pred: (r: Result) => boolean) => done.filter((d) => pred(d.r)).map((d) => `${d.c.name}${d.n}`);
  const served = by((r) => r === 'ok');
  const failed = by((r) => r === '503' || r === 'timeout');
  const fast = by((r) => r === 'fast');
  const next = done.filter((d) => d.c.chain?.due != null).map((d) => `${d.c.name} at tick ${d.c.chain!.due}`);
  const quit = done.filter((d) => d.r !== 'ok' && d.r !== 'fast' && !d.c.chain).map((d) => d.c.name);
  const load = s.load[s.now] ?? 0;
  const first = done[0];
  const probe: Probe = { text: `${first.c.name}${first.n}`, at: markId(first.c.name, s.now) };
  const parts = [
    `${list(names)} ${done.length === 1 ? 'goes' : 'go'} out at tick ${s.now}.`,
    served.length ? `${list(served)} ${served.length === 1 ? 'is' : 'are'} served.` : ``,
    failed.length ? `${list(failed)} ${failed.length === 1 ? 'fails' : 'fail'}${s.health === 'slow' ? ' with a timeout' : ' with 503'}.` : ``,
    fast.length ? `${list(fast)} ${fast.length === 1 ? 'fails' : 'fail'} fast at an open breaker.` : ``,
    next.length ? `Next: ${list(next)}.` : ``,
    quit.length ? `${list(quit)} ${quit.length === 1 ? 'gives' : 'give'} up.` : ``,
  ].filter(Boolean);
  for (const d of done) ctx.rec.mark(markId(d.c.name, s.now), 'path');
  ctx.rec.mark(markId(first.c.name, s.now), 'key');
  if (compares) {
    const over = load > CAPACITY;
    ctx.rec.mark(loadId(s.now), 'compare');
    ctx.rec.line(...lines, over ? 'shed' : 'capacity');
    ctx.rec.compare(`tick ${s.now} load ${load}`, over ? '>' : '≤', `capacity ${CAPACITY}`, over ? `${load - CAPACITY} shed with 503` : 'all served', { probe, message: parts.join(' ') });
    ctx.rec.unmark(loadId(s.now));
  } else {
    ctx.rec.line(...lines, 'send');
    ctx.rec.step(parts.join(' ') + ` The downstream received ${load} this tick.`, { probe });
  }
  for (const d of done) ctx.rec.unmark(markId(d.c.name, s.now));
}

function newCtx(rec: Rec, loud: Ctx['loud']): Ctx {
  return { rec, peak: 0, loud, lead: [], ok: 0, gaveUp: 0 };
}

// ---- operations ---------------------------------------------------------------

export function call(s: RBState, who: number | string, rec: Rec): Result | null {
  const c = clientOf(s, who);
  if (!c) {
    rec.line('call');
    rec.step(`There are four clients, a to d. Enter one of them.`);
    return null;
  }
  if (c.chain) {
    rec.line('busy');
    rec.step(`${c.name} is still working on its last call: ${c.name}${c.chain.attempt + 1} is due at tick ${c.chain.due}. Each client makes one call at a time here. Tick to let it finish.`);
    return null;
  }
  if (c.lastSent >= s.now) {
    rec.line('call');
    rec.step(`${c.name} has already sent a request at tick ${s.now}, and this page draws one per client per tick. Tick first, then call again.`);
    return null;
  }
  const ctx = newCtx(rec, c.name);
  return startCall(s, c, s.policy, true, ctx, []);
}

/** Advance the clock by k ticks, firing whatever is due. Returns false at the page's clock limit. */
export function tick(s: RBState, k: number, rec: Rec): boolean {
  if (s.now + k > MAX_TICK) {
    rec.line('clock');
    rec.step(`Sorry, this page's clock stops at tick ${MAX_TICK} so the numbers stay readable, and it reads ${s.now}. Use Reset to start again from tick 0.`);
    return false;
  }
  const ctx = newCtx(rec, 'all');
  const from = s.now;
  for (let i = 0; i < k; i++) {
    advance(s, ctx, []);
    const due = dueNow(s);
    if (due.length) {
      rec.line('clock', 'due');
      rec.step(`The clock moves to tick ${s.now}. Due now: ${list(due.map((c) => `${c.name}${c.chain!.attempt + 1}`))}.`);
      fireDue(s, ctx, []);
    }
  }
  const waiting = s.clients.filter((c) => c.chain?.due != null).map((c) => `${c.name}${c.chain!.attempt + 1} at tick ${c.chain!.due}`);
  rec.line('clock');
  rec.step(
    `The clock reads tick ${s.now}${k > 1 ? `, ${ticks(k)} after ${from}` : ``}. ` +
      (waiting.length ? `Still waiting: ${list(waiting)}.` : `No retries are waiting.`),
  );
  return true;
}

const HEALTH_TEXT: Record<Health, string> = {
  healthy: 'healthy: it answers every request',
  failing: 'failing: every request gets 503 Service Unavailable',
  slow: 'slow: every request takes longer than the caller will wait, so it times out',
  recovering: `recovering: it can serve ${CAPACITY} requests a tick and sheds the rest with 503. After ${CALM_TICKS} ticks in a row within that, it is healthy again`,
};

export function setDownstream(s: RBState, h: Health, rec: Rec): void {
  rec.line('health');
  if (s.health === h) {
    rec.step(`The downstream is already ${h}. Nothing changes.`);
    return;
  }
  if (h === 'recovering' && s.health === 'healthy') {
    rec.step(`The downstream is healthy, so there is nothing to recover from. Fail it or slow it first.`);
    return;
  }
  setHealth(s, h);
  rec.step(`From tick ${s.now} the downstream is ${HEALTH_TEXT[h]}.`);
}

/** Room on the clock for an operation that may run this many ticks. */
function room(s: RBState, need: number, rec: Rec, line: string): boolean {
  if (s.now + need <= MAX_TICK) return true;
  rec.line(line);
  rec.step(`Sorry, this needs up to ${need} more ticks and the page's clock stops at ${MAX_TICK}. Use Reset to start again from tick 0.`);
  return false;
}

export function storm(s: RBState, raw: number | string, rec: Rec): void {
  const policy = policyOf(raw);
  if (policy === null) {
    rec.line('storm_drop');
    rec.step(`Choose a retry policy for the storm: none, immediate, fixed, exponential or jitter.`);
    return;
  }
  if (!room(s, 20, rec, 'storm_drop')) return;
  const ctx = newCtx(rec, 'A');
  const dropped = s.clients.filter((c) => c.chain).length;
  for (const c of s.clients) c.chain = null;
  advance(s, newCtx(rec, null), []);
  setView(s, s.now);
  const start = s.now;
  rec.line('storm_drop');
  rec.step(
    `A storm with ${policyName(policy)}. At tick ${start} all four clients call, just as the downstream fails. ` +
      `Breakers are set aside for this run so you see what retries alone do` +
      (dropped ? `, and the ${dropped === 1 ? 'retry' : 'retries'} still waiting ${dropped === 1 ? 'was' : 'were'} dropped.` : `.`) +
      ` Follow A; the others are summed up each tick.`,
  );
  setHealth(s, 'failing');
  rec.line('storm_fail', 'health');
  rec.step(`The downstream fails at tick ${start}. It will come back at tick ${start + DOWN_FOR}, able to serve only ${CAPACITY} requests a tick while it warms up.`);

  const quiet: { c: Client; n: number; r: Result }[] = [];
  for (const c of s.clients) {
    if (c.name === 'A') startCall(s, c, policy, false, ctx, ['storm_call']);
    else {
      ctx.rec.count('calls');
      c.chain = { attempt: 0, due: s.now, policy, deadline: s.deadline ? s.now + s.deadline : null, guarded: false };
      if (c.tokens !== null) c.tokens = Math.min(BUDGET_CAP, c.tokens + EARN);
      quiet.push({ c, n: 1, r: attempt(s, c, ctx, true) });
    }
  }
  summarise(s, ctx, quiet, ['storm_call']);

  while (s.clients.some((c) => c.chain)) {
    advance(s, ctx, ['storm_tick']);
    if (s.now === start + DOWN_FOR) {
      setHealth(s, 'recovering');
      rec.line('storm_recover', 'health');
      rec.step(`Tick ${s.now}: the downstream is back, recovering. It can serve ${CAPACITY} requests a tick and sheds the rest with 503.`);
    }
    const due = dueNow(s);
    if (!due.length) continue;
    rec.line('storm_tick', 'clock', 'due');
    rec.step(`Tick ${s.now}. Due now: ${list(due.map((c) => `${c.name}${c.chain!.attempt + 1}`))}.`);
    fireDue(s, ctx, ['storm_fire']);
  }
  const since = (map: Record<number, number>, from: number) => Object.entries(map).filter(([t]) => Number(t) >= from);
  const reached = since(s.load, start).reduce((sum, [, n]) => sum + n, 0);
  const shed = since(s.shed, start).reduce((sum, [, n]) => sum + n, 0);
  const later = Math.max(0, ...since(s.load, start + 1).map(([, n]) => n));
  rec.line('storm_loop');
  rec.step(
    `Storm over at tick ${s.now}, ${ticks(s.now - start)} after it began. 4 calls sent ${reached} requests to the downstream, ${(reached / 4).toFixed(1)} per call. ` +
      `${ctx.ok} succeeded and ${ctx.gaveUp} gave up. After the first tick the most in one tick was ${later}, and ${shed} ${shed === 1 ? 'request was' : 'requests were'} shed while it recovered. The downstream is ${s.health}.`,
  );
}

export function trip(s: RBState, who: number | string, rec: Rec): void {
  const c = clientOf(s, who);
  if (!c) {
    rec.line('trip_loop');
    rec.step(`There are four clients, a to d. Enter one of them.`);
    return;
  }
  if (!s.breakerOn) {
    rec.line('no_breaker');
    rec.step(`The breakers are switched off on this page, so there is nothing to trip: every call goes out, however long the downstream has been failing. Turn Breaker on to see it.`);
    return;
  }
  if (c.chain) {
    rec.line('trip_loop');
    rec.step(`${c.name} is still working on its last call: ${c.name}${c.chain.attempt + 1} is due at tick ${c.chain.due}. Tick to let it finish, then trip it.`);
    return;
  }
  if (!room(s, 20, rec, 'trip_loop')) return;
  const ctx = newCtx(rec, c.name);
  const step = (lead: string) => {
    advance(s, ctx, [lead]);
    if (dueNow(s).length) fireDue(s, ctx, [lead]);
  };
  // Start on a fresh tick, so the first call never shares one with an earlier request.
  step('trip_tick');
  if (c.state === 'closed' && (s.health === 'healthy' || s.health === 'recovering')) {
    setHealth(s, 'failing');
    rec.line('trip_fail', 'health');
    rec.step(`For failures to pile up the downstream must be failing, so it fails now, at tick ${s.now}. ${c.name} calls once a tick with no retries, so the failures are easy to count.`);
  } else if (c.state === 'closed') {
    rec.line('trip_loop');
    rec.step(`The downstream is ${s.health}. ${c.name} calls once a tick with no retries, so the failures are easy to count.`);
  } else {
    rec.line('trip_loop');
    rec.step(`${c.name}'s breaker is ${c.state} and the downstream is ${s.health}. ${c.name} calls once a tick with no retries until the next probe.`);
  }
  while (c.state === 'closed') {
    startCall(s, c, NONE, true, ctx, ['trip_call']);
    if (c.state === 'closed') step('trip_tick');
  }
  step('trip_tick');
  if (c.state === 'open') {
    startCall(s, c, NONE, true, ctx, ['trip_fast']);
    while (c.state === 'open') step('trip_tick');
  }
  startCall(s, c, NONE, true, ctx, ['trip_probe']);
  const closed = (c.state as BState) === 'closed';
  rec.line('trip_probe');
  rec.step(
    closed
      ? `${c.name}'s breaker went closed, open, half-open and closed again. While it was open, ${c.name}'s calls cost the downstream nothing.`
      : `${c.name}'s breaker is open again until tick ${c.openUntil}: the probe found the downstream still ${s.health}. Recover the downstream, then trip ${c.name} again to see the probe succeed.`,
  );
}

export function budget(s: RBState, deadline: number, rec: Rec): void {
  if (!Number.isInteger(deadline) || deadline < 0 || deadline > 20) {
    rec.line('budget_on');
    rec.step(`Give a deadline from 1 to 20 ticks, or 0 to turn deadlines and retry budgets off.`);
    return;
  }
  if (deadline === 0) {
    s.deadline = 0;
    for (const c of s.clients) c.tokens = null;
    rec.line('budget_on', 'budget_off');
    rec.step(`Deadlines and retry budgets are off. Calls retry as far as their policy allows.`);
    return;
  }
  const c = s.clients.find((x) => free(s, x));
  if (!c) {
    rec.line('budget_on');
    rec.step(`Every client is busy with a call or has already sent at tick ${s.now}. Tick first, then try again.`);
    return;
  }
  if (!room(s, 30, rec, 'budget_on')) return;
  const ctx = newCtx(rec, c.name);
  s.deadline = deadline;
  for (const x of s.clients) x.tokens = BUDGET_CAP;
  rec.line('budget_on');
  rec.step(
    `From now on every call carries a deadline: its caller waits ${ticks(deadline)} at most. And every client has a retry budget, a token bucket: a call earns 0.2 tokens, a retry costs 1, and at most ${tokenText(BUDGET_CAP)} are saved. Each starts full.`,
  );
  if (s.health === 'healthy' || s.health === 'recovering') {
    setHealth(s, 'slow');
    rec.line('budget_slow', 'health');
    rec.step(`To have something to retry, the downstream turns slow: every attempt times out.`);
  }
  startCall(s, c, s.policy, true, ctx, ['budget_call']);
  while (c.chain) {
    advance(s, ctx, ['budget_wait']);
    if (dueNow(s).length) fireDue(s, ctx, ['budget_wait']);
  }
  rec.line('budget_wait');
  rec.step(`${c.name}'s call is over at tick ${s.now}. Without a deadline or a budget it could have made ${MAX_ATTEMPTS} attempts. Budget 0 turns both off again.`);
}

export function reset(s: RBState, rec: Rec): void {
  Object.assign(s, create(s.policy, s.breakerOn));
  rec.line('reset');
  rec.step(`Reset: clock at tick 0, the downstream healthy, every breaker closed, no deadlines or budgets.`);
}

// ---- layout -------------------------------------------------------------------

const PITCH = 40;
const MARK_W = 36;
const LANE_PITCH = 72;
const NAME_W = 40;
const STATE_W = 132;
const FAIL_W = 52;
const BUD_W = 56;
const LEFT_W = TRAY_PAD * 2 + NAME_W + STATE_W + FAIL_W + BUD_W + CELL_GAP * 3;
const X0 = LEFT_W + 24 + PITCH / 2;
const LOAD_Y = NAMES.length * LANE_PITCH;
const NOW_Y = LOAD_Y + CELL_H / 2 + SUB_ROOM + 2 + TAG_H / 2;
const TOP = -CELL_H / 2 - PROBE_H - 16;
const RIGHT = X0 + (SHOWN - 1) * PITCH + MARK_W / 2 + 4;
const BOTTOM = NOW_Y + TAG_H / 2 + 2;

const tickX = (s: RBState, t: number) => X0 + (t - s.viewFrom) * PITCH;
const stateText = (s: RBState, c: Client) => (!s.breakerOn ? 'no breaker' : c.state === 'open' ? `open to ${c.openUntil}` : c.state);
const SERVES: Record<Health, string> = { healthy: 'all', failing: '0', slow: '0', recovering: String(CAPACITY) };

export function layout(s: RBState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const last = s.viewFrom + SHOWN - 1;
  const inView = (t: number) => t >= s.viewFrom && t <= last;

  s.clients.forEach((c, i) => {
    const y = i * LANE_PITCH;
    nodes.push({
      id: `c${c.name}`,
      x: LEFT_W / 2,
      y,
      cells: [
        { text: c.name, w: NAME_W },
        { text: stateText(s, c), w: STATE_W },
        { text: s.breakerOn ? `${recent(c, s.now)}/${THRESHOLD}` : '–', w: FAIL_W },
        { text: c.tokens === null ? 'off' : tokenText(c.tokens), w: BUD_W },
      ],
    });
    for (const m of c.marks) {
      if (!inView(m.tick)) continue;
      nodes.push({
        id: markId(c.name, m.tick),
        x: tickX(s, m.tick),
        y,
        // The client's letter is in the box, so a lane still reads on a phone once the names have scrolled away.
        cells: [{ text: `${c.name}${m.result === 'fast' ? '×' : m.attempt}`, w: MARK_W }],
        tone: m.result === 'ok' ? 'ok' : m.result === 'fast' ? 'dim' : 'bad',
      });
    }
    const due = c.chain?.due;
    if (due != null && inView(due) && !c.marks.some((m) => m.tick === due)) {
      nodes.push({ id: markId(c.name, due), x: tickX(s, due), y, cells: [{ text: '', w: MARK_W }] });
    }
  });

  // Column heads over the clients.
  const headY = -CELL_H / 2 - 14;
  let x = TRAY_PAD;
  [['client', NAME_W], ['breaker', STATE_W], ['fails', FAIL_W], ['budget', BUD_W]].forEach(([text, w]) => {
    decor.push({ id: `head-${text}`, type: 'label', x: x + (w as number) / 2, y: headY, text: text as string, anchor: 'middle' });
    x += (w as number) + CELL_GAP;
  });

  // The downstream and its load per tick.
  nodes.push({
    id: 'server',
    x: LEFT_W / 2,
    y: LOAD_Y,
    cells: [
      { text: 'S', w: NAME_W, sub: 'server' },
      { text: s.health, w: STATE_W, sub: 'health' },
      { text: SERVES[s.health], w: FAIL_W + BUD_W + CELL_GAP, sub: 'serves a tick' },
    ],
  });
  for (let t = s.viewFrom; t <= last; t++) {
    const load = t <= s.now ? (s.load[t] ?? 0) : 0;
    nodes.push({ id: loadId(t), x: tickX(s, t), y: LOAD_Y, cells: [{ text: load ? String(load) : '', w: MARK_W, sub: String(t) }], tone: (s.shed[t] ?? 0) > 0 ? 'bad' : undefined });
  }
  // Bands under the load row for each stretch the downstream was not healthy.
  let t = s.viewFrom;
  while (t <= Math.min(s.now, last)) {
    const h = healthAt(s, t);
    let u = t;
    while (u + 1 <= Math.min(s.now, last) && healthAt(s, u + 1) === h) u++;
    if (h !== 'healthy') {
      const w = (u - t + 1) * PITCH - 4;
      const fits = h.length * LABEL_MAX * 0.55 + 16 <= w;
      decor.push({ id: `band-${t}`, type: 'band', x: tickX(s, t) - PITCH / 2 + 2, y: LOAD_Y - CELL_H / 2 - 28, w, h: CELL_H + 28 + SUB_ROOM, label: fits ? h : undefined });
    }
    t = u + 1;
  }
  nodes.push({ id: 'ptr-now', x: tickX(s, s.now), y: NOW_Y, cells: [{ text: 'now' }], shape: 'tag' });

  decor.push({ id: 'corner-a', type: 'label', x: 0, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges: [], decor };
}

/** Health at a tick: the last value recorded at or before it. */
function healthAt(s: RBState, t: number): Health {
  for (let u = t; u >= s.viewFrom; u--) if (s.healthAt[u]) return s.healthAt[u];
  return 'healthy';
}

// ---- definition -----------------------------------------------------------------

function suggestClient(s: RBState): string {
  const ready = s.clients.filter((c) => free(s, c));
  return (ready.length ? pick(ready) : pick(s.clients)).name.toLowerCase();
}

const CLIENT_ARG = { name: 'client', label: 'Client', kind: 'word' as const };

const def: StructureDef<RBState> = {
  id: 'retries-breaker',
  params: [
    { id: 'policy', label: 'Retry policy', default: JITTER, options: POLICY_LABEL.map((label, value) => ({ value, label })) },
    { id: 'breaker', label: 'Circuit breaker', default: 1, options: [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }] },
  ],
  create: (p) => create(p.policy ?? JITTER, (p.breaker ?? 1) === 1),
  // A few calls that went through, so the timeline is not empty.
  seed: [['call', 'a'], ['call', 'b'], ['tick', 1], ['call', 'c'], ['call', 'd'], ['tick', 1]],
  ops: [
    {
      id: 'call',
      label: 'Call',
      intent: 'primary',
      args: [CLIENT_ARG],
      code: ['call', 'attempt', 'retry', 'backoff', 'breaker', 'budget_bucket', 'downstream'],
      run: (s, [w], rec) => void call(s, w, rec),
      suggest: (s) => [suggestClient(s)],
    },
    {
      id: 'tick',
      label: 'Tick',
      args: [{ name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 }],
      code: ['tick', 'attempt', 'retry', 'backoff', 'breaker', 'budget_bucket', 'downstream'],
      run: (s, [k], rec) => void tick(s, Number(k), rec),
      suggest: (s) => [Math.min(randomInt(1, 3), Math.max(1, MAX_TICK - s.now))],
    },
    { id: 'fail_downstream', label: 'Fail downstream', intent: 'danger', args: [], code: ['downstream'], run: (s, _a, rec) => setDownstream(s, 'failing', rec) },
    { id: 'slow_downstream', label: 'Slow downstream', args: [], code: ['downstream'], run: (s, _a, rec) => setDownstream(s, 'slow', rec) },
    { id: 'recover_downstream', label: 'Recover downstream', args: [], code: ['downstream'], run: (s, _a, rec) => setDownstream(s, 'recovering', rec) },
    {
      id: 'storm',
      label: 'Storm',
      args: [{ name: 'policy', label: 'Policy', kind: 'word' }],
      code: ['storm', 'tick', 'attempt', 'retry', 'backoff', 'breaker', 'budget_bucket', 'downstream', 'call'],
      run: (s, [p], rec) => storm(s, p, rec),
      suggest: (s) => [POLICIES[s.policy]],
    },
    {
      id: 'trip',
      label: 'Trip',
      args: [CLIENT_ARG],
      code: ['trip', 'breaker', 'attempt', 'tick', 'call', 'retry', 'backoff', 'budget_bucket', 'downstream'],
      run: (s, [w], rec) => trip(s, w, rec),
      suggest: (s) => [suggestClient(s)],
    },
    {
      id: 'budget',
      label: 'Budget',
      args: [{ name: 'deadline', label: 'Deadline', kind: 'int', min: 0, max: 20 }],
      code: ['budget', 'retry', 'budget_bucket', 'backoff', 'call', 'attempt', 'tick', 'breaker', 'downstream'],
      run: (s, [d], rec) => budget(s, Number(d), rec),
      suggest: () => [randomInt(4, 8)],
    },
    { id: 'reset', label: 'Reset', intent: 'danger', args: [], code: ['reset'], run: (s, _a, rec) => reset(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'calls', label: 'Calls made' },
    { key: 'reached', label: 'Reached downstream' },
    { key: 'fast', label: 'Failed fast' },
    { key: 'retries', label: 'Retries' },
    { key: 'peak', label: 'Peak load in a tick' },
  ],
  status: (s) => [
    { label: 'Clock', value: `tick ${s.now}` },
    { label: 'Downstream', value: s.health === 'recovering' ? `recovering, ${s.calm} of ${CALM_TICKS} calm ticks` : s.health },
    { label: 'Retry policy', value: POLICY_LABEL[s.policy] },
    { label: 'Deadline, budget', value: s.deadline ? `${ticks(s.deadline)}, on` : 'off' },
  ],
  tour: [
    ['storm', 'immediate'],
    ['storm', 'exponential'],
    ['storm', 'jitter'],
    ['trip', 'a'],
    ['recover_downstream'],
    ['trip', 'a'],
    ['budget', 3],
  ],
  source: { python, java },
  info,
};

export default def;
