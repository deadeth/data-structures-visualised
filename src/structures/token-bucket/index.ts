import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_GAP, CELL_H, TAG_H, TRAY_PAD } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/TokenBucket.java?raw';
import python from './code/token_bucket.py?raw';
import { info } from './info';

/**
 * Token bucket rate limiter.
 *
 * The bucket earns `rate` tokens per tick and holds at most `capacity`. A
 * request takes `cost` tokens or is turned away at once. Nothing runs between
 * requests: the bucket stores a token count and the tick at which that count
 * was right (`last`), and works out what it has earned since then only when a
 * request asks. That is lazy refill.
 *
 * `now` is the page's clock. `requests` is the page's record of what arrived
 * and what happened to it; a real limiter keeps only `tokens` and `last`.
 */
export interface Req {
  /** Order of arrival since the last reset, from 1. */
  seq: number;
  cost: number;
  outcome: 'waiting' | 'allowed' | 'rejected';
}

export interface BucketState {
  capacity: number;
  /** Tokens earned per tick. */
  rate: number;
  /** Tokens stored, correct as of `last`. */
  tokens: number;
  /** The clock, in ticks. */
  now: number;
  /** The tick at which `tokens` was last brought up to date. */
  last: number;
  seq: number;
  /** The most recent requests, oldest first. At most SHOWN are kept. */
  requests: Req[];
  allowed: number;
  rejected: number;
}

/** Requests drawn across the canvas. */
export const SHOWN = 6;
/** Largest burst the page sends at once. */
export const MAX_BURST = SHOWN;
/** The page's clock stops here so tick numbers stay three digits wide. */
export const MAX_TICK = 999;
/** Ticks drawn on the timeline. */
export const TICKS_SHOWN = 9;
export const MAX_COST = 9;

export function create(capacity = 5, rate = 1): BucketState {
  return { capacity, rate, tokens: capacity, now: 0, last: 0, seq: 0, requests: [], allowed: 0, rejected: 0 };
}

/** What a request would find if it asked now: the stored tokens plus what has been earned since, capped. */
export function available(s: BucketState): number {
  return Math.min(s.capacity, s.tokens + (s.now - s.last) * s.rate);
}

/** Ticks until `cost` tokens are there, or null when the bucket can never hold that many. Assumes the bucket is up to date. */
export function retryAfter(s: BucketState, cost: number): number | null {
  if (cost > s.capacity) return null;
  return Math.max(0, Math.ceil((cost - s.tokens) / s.rate));
}

const BUCKET = 'bucket';
const rid = (r: Req) => `r${r.seq}`;
const tid = (tick: number) => `t${tick}`;
/** The name on the chip. It wraps after r999 so it always fits its box. */
export const label = (r: Req) => `r${((r.seq - 1) % 999) + 1}`;
const tok = (n: number) => `${n} ${n === 1 ? 'token' : 'tokens'}`;
const ticks = (n: number) => `${n} ${n === 1 ? 'tick' : 'ticks'}`;
const perTick = (s: BucketState) => `${tok(s.rate)} per tick`;

function arrive(s: BucketState, cost: number): Req {
  const r: Req = { seq: ++s.seq, cost, outcome: 'waiting' };
  s.requests.push(r);
  if (s.requests.length > SHOWN) s.requests.splice(0, s.requests.length - SHOWN);
  return r;
}

function markCells(rec: Rec, from: number, to: number, tone: Tone): void {
  for (let i = from; i < to; i++) rec.markCell(BUCKET, i, tone);
}

/**
 * Decide one request that has already arrived: refill lazily, then compare
 * tokens with the cost. `inBurst` keeps the frames short for requests that
 * share a tick, and leaves out the Retry-After line the burst listing lacks.
 */
function decide(s: BucketState, r: Req, rec: Rec, inBurst: boolean): boolean {
  const name = label(r);
  const atReq: Probe = { text: name, at: rid(r) };
  const atSlot = (cell: number): Probe => ({ text: name, at: BUCKET, cell: Math.max(0, Math.min(s.capacity - 1, cell)) });
  const lead = inBurst ? ['send'] : [];
  const elapsed = s.now - s.last;
  rec.mark(rid(r), 'key');

  // ---- lazy refill ----------------------------------------------------------
  if (elapsed === 0) {
    if (!inBurst) {
      rec.line('arrive');
      rec.step(`${name} arrives at tick ${s.now} and asks for ${tok(r.cost)}. Before deciding, the bucket is brought up to date.`, { probe: atReq });
    }
    rec.line(...lead, 'refill', 'elapsed', 'no_time');
    rec.step(
      (inBurst ? `${name} arrives in the same tick and asks for ${tok(r.cost)}. ` : ``) +
        `elapsed = now − last = ${s.now} − ${s.last} = 0. No time has passed since the bucket was last brought up to date, so nothing has been earned. It holds ${tok(s.tokens)}.`,
      { probe: inBurst ? atReq : atSlot(s.tokens - 1) },
    );
  } else {
    rec.line(...lead, 'arrive');
    rec.step(
      `${name} arrives at tick ${s.now} and asks for ${tok(r.cost)}. The bucket shows ${tok(s.tokens)}, but that count was written at tick ${s.last} and nothing has touched it since. Bring it up to date first.`,
      { probe: atReq },
    );
    const earned = elapsed * s.rate;
    const sum = s.tokens + earned;
    const before = s.tokens;
    for (let t = s.last + 1; t <= s.now; t++) rec.mark(tid(t), 'path');
    rec.line('refill', 'elapsed', 'earned');
    rec.step(
      `elapsed = now − last = ${s.now} − ${s.last} = ${ticks(elapsed)}. earned = ${elapsed} × ${s.rate} = ${tok(earned)}. No timer added them as the ticks went by. One subtraction and one multiplication work it out now.`,
      { probe: atSlot(before) },
    );

    const over = sum > s.capacity;
    if (before < s.capacity) markCells(rec, before, Math.min(sum, s.capacity), 'compare');
    else rec.markCell(BUCKET, s.capacity - 1, 'compare');
    rec.line('cap');
    rec.compare(`tokens ${before} + ${earned} = ${sum}`, over ? '>' : '≤', `capacity ${s.capacity}`, over ? `keep ${s.capacity}, spill ${sum - s.capacity}` : `keep all ${sum}`, {
      probe: atSlot(Math.min(sum, s.capacity) - 1),
      message: over
        ? `${before} stored + ${earned} earned = ${sum}, which is more than the bucket holds. min(${s.capacity}, ${sum}) = ${s.capacity}: the other ${sum - s.capacity} spill. This cap is what bounds a burst, however long the client stayed quiet.`
        : `${before} stored + ${earned} earned = ${sum}, which fits under the capacity of ${s.capacity}. min(${s.capacity}, ${sum}) = ${sum}: keep them all.`,
    });

    s.tokens = Math.min(s.capacity, sum);
    s.last = s.now;
    rec.unmark(BUCKET);
    markCells(rec, before, s.tokens, 'ok');
    for (let t = 0; t <= elapsed; t++) rec.unmark(tid(s.now - t));
    rec.line('cap', 'stamp');
    rec.step(
      `Write tokens = ${s.tokens} and move last to tick ${s.now}. The bucket is up to date, and the next refill will count from here.`,
      { probe: atSlot(s.tokens - 1) },
    );
    rec.unmark(BUCKET);
  }

  // ---- tokens against cost --------------------------------------------------
  const enough = s.tokens >= r.cost;
  if (enough) markCells(rec, s.tokens - r.cost, s.tokens, 'compare');
  else markCells(rec, 0, s.tokens, 'compare');
  rec.line('test');
  rec.compare(`tokens ${s.tokens}`, enough ? '≥' : '<', `cost ${r.cost}`, enough ? `allow, take ${r.cost}` : `reject, ${r.cost - s.tokens} short`, {
    probe: atSlot(s.tokens - 1),
    message: enough
      ? `The bucket holds ${tok(s.tokens)} and ${name} needs ${r.cost}. There are enough, so it is allowed.`
      : `The bucket holds ${tok(s.tokens)} and ${name} needs ${r.cost}. It is ${r.cost - s.tokens} short, so it is rejected.`,
  });
  rec.unmark(BUCKET);
  rec.unmark(rid(r));

  if (enough) {
    s.tokens -= r.cost;
    r.outcome = 'allowed';
    s.allowed++;
    rec.count('allowed');
    markCells(rec, s.tokens, s.tokens + r.cost, 'bad');
    rec.line('take');
    rec.step(
      `Take ${tok(r.cost)}, leaving ${s.tokens}. ${name} is allowed at once: it never waited in a queue.` + (inBurst ? `` : ` Cost: two comparisons at most.`),
      { probe: atReq },
    );
    rec.unmark(BUCKET);
    return true;
  }

  r.outcome = 'rejected';
  s.rejected++;
  rec.count('rejected');
  if (inBurst) {
    rec.line('reject');
    rec.step(`${name} is rejected. Nothing is taken and nothing is queued: the bucket still holds ${tok(s.tokens)}.`, { probe: atReq });
    return false;
  }
  const wait = retryAfter(s, r.cost);
  rec.line('reject', 'retry');
  rec.step(
    wait === null
      ? `${name} is rejected, and it always will be: it asks for ${tok(r.cost)} and the bucket can never hold more than ${s.capacity}. Waiting will not help, so Retry-After would be a lie. The request itself has to change.`
      : `${name} is rejected. Nothing is taken and nothing is queued. A server would answer 429 Too Many Requests with Retry-After set to ${ticks(wait)}: ${r.cost - s.tokens} missing at ${perTick(s)}.`,
    { probe: atReq },
  );
  return false;
}

/** One request for `cost` tokens. Returns true when it is allowed. */
export function request(s: BucketState, cost: number, rec: Rec): boolean {
  return decide(s, arrive(s, cost), rec, false);
}

/** Send `count` requests of one token each in the same tick. Returns how many were allowed. */
export function burst(s: BucketState, count: number, rec: Rec): number {
  const batch: Req[] = [];
  for (let i = 0; i < count; i++) batch.push(arrive(s, 1));
  const could = available(s);
  rec.line('next');
  rec.step(
    `${count} requests arrive in the same tick, ${label(batch[0])} to ${label(batch[count - 1])}, each asking for 1 token. They are decided one at a time, in order. No time passes between them, so only tokens that are already earned can pay for them.`,
  );
  let allowed = 0;
  for (const r of batch) if (decide(s, r, rec, true)) allowed++;
  const turned = count - allowed;
  rec.line('done');
  rec.step(
    `Burst of ${count}: ${allowed} allowed, ${turned} rejected. ` +
      (turned
        ? `The bucket paid out the ${tok(could)} it had and then said no. That is the burst allowance: at most ${s.capacity} at once from a full bucket, then ${perTick(s)} for as long as the pressure lasts.`
        : `The bucket had ${tok(could)}, enough for all of them at once. That is the burst allowance: up to ${s.capacity} in one instant from a full bucket. ${s.tokens === 0 ? `It is now empty.` : `${tok(s.tokens)} left.`}`),
  );
  return allowed;
}

/** Advance the clock. The bucket is not touched. Returns false only at the page's clock limit. */
export function tick(s: BucketState, k: number, rec: Rec): boolean {
  rec.line('tick');
  if (s.now + k > MAX_TICK) {
    rec.step(`Sorry, this page's clock stops at tick ${MAX_TICK} so the numbers stay readable, and it reads ${s.now}. Use Reset to start again from tick 0. A real limiter reads the system clock, which has no such limit.`);
    return false;
  }
  const from = s.now;
  s.now += k;
  for (let t = from + 1; t <= s.now; t++) rec.mark(tid(t), 'path');
  const owed = available(s) - s.tokens;
  const spare = s.capacity - s.tokens;
  rec.step(
    `Advance the clock by ${ticks(k)}, from ${from} to ${s.now}. That is all that happens: no timer runs and the bucket is not touched. It still shows ${tok(s.tokens)}, as of tick ${s.last}. ` +
      (spare === 0
        ? `It is already full, so this time earns nothing. A bucket cannot save up more than its capacity of ${s.capacity}.`
        : `The next request will add the ${tok(owed)} earned since then${(s.now - s.last) * s.rate > spare ? `, which is all the room it has` : ``}. An idle bucket costs no work at all.`),
  );
  return true;
}

/** A full bucket at tick 0, and an empty record of requests. */
export function reset(s: BucketState, rec: Rec): void {
  s.tokens = s.capacity;
  s.now = 0;
  s.last = 0;
  s.seq = 0;
  s.requests = [];
  s.allowed = 0;
  s.rejected = 0;
  rec.line('reset');
  rec.step(`Reset: the bucket is full again with ${tok(s.capacity)}, and the clock and last are back at tick 0. A new bucket starts full, so a new client gets its burst straight away.`);
}

// ---- layout ---------------------------------------------------------------

const REQ_W = 52;
const REQ_PITCH = 62;
const SLOT_W = 44;
const TICK_W = 40;
const TICK_PITCH = 42;
/** Room above a row for the probe chip, then the row's label above that. */
const CHIP_ROOM = PROBE_H + 16;
const REQ_Y = 0;
const REQ_LABEL_Y = REQ_Y - CELL_H / 2 - CHIP_ROOM - 10;
const BUCKET_LABEL_Y = REQ_Y + CELL_H / 2 + SUB_ROOM + LABEL_MAX;
const BUCKET_H = CELL_H + TRAY_PAD * 2;
const BUCKET_Y = BUCKET_LABEL_Y + 8 + CHIP_ROOM + BUCKET_H / 2;
const CLOCK_LABEL_Y = BUCKET_Y + BUCKET_H / 2 + LABEL_MAX + 10;
const TICK_Y = CLOCK_LABEL_Y + 12 + CELL_H / 2;
const NOW_Y = TICK_Y + CELL_H / 2 + 8 + TAG_H / 2;
const LAST_Y = NOW_Y + TAG_H + 4;
const LEFT = -8;
/** Narrow enough to fit a phone at the smallest scale without scrolling sideways. */
const WIDTH = 392;
const TOP = REQ_LABEL_Y - LABEL_MAX * 0.65;
const BOTTOM = LAST_Y + TAG_H / 2 + 4;
const TOKEN = '●';

/** The ticks on the timeline. When `last` is too far back to fit, it is drawn first with a gap after it. */
export function timeline(s: BucketState): (number | null)[] {
  const lo = Math.max(0, s.now - (TICKS_SHOWN - 1));
  if (s.last >= lo) return Array.from({ length: TICKS_SHOWN }, (_, i) => lo + i);
  const tail = Array.from({ length: TICKS_SHOWN - 2 }, (_, i) => s.now - (TICKS_SHOWN - 3) + i);
  return [s.last, null, ...tail];
}

export function layout(s: BucketState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];

  // Requests, oldest on the left.
  s.requests.forEach((r, i) => {
    nodes.push({
      id: rid(r),
      x: i * REQ_PITCH + REQ_W / 2,
      y: REQ_Y,
      cells: [{ text: label(r), sub: `cost ${r.cost}`, w: REQ_W }],
      tone: r.outcome === 'allowed' ? 'ok' : r.outcome === 'rejected' ? 'bad' : undefined,
    });
  });
  decor.push({
    id: 'requests',
    type: 'label',
    x: 0,
    y: REQ_LABEL_Y,
    text: s.requests.length ? 'Requests, oldest on the left' : 'Requests: none yet',
    strong: true,
  });

  // The bucket: one slot per token it can hold, filled from the left.
  const bucketW = TRAY_PAD * 2 + s.capacity * SLOT_W + (s.capacity - 1) * CELL_GAP;
  nodes.push({
    id: BUCKET,
    x: bucketW / 2,
    y: BUCKET_Y,
    cells: Array.from({ length: s.capacity }, (_, i) => ({ text: i < s.tokens ? TOKEN : '', w: SLOT_W })),
  });
  decor.push({
    id: 'bucket-label',
    type: 'label',
    x: 0,
    y: BUCKET_LABEL_Y,
    text: `Bucket: ${s.tokens} of ${s.capacity} at tick ${s.last}, +${available(s) - s.tokens} earned since`,
    strong: true,
  });

  // The clock: a strip of ticks with now and last pointing at theirs.
  const strip = timeline(s);
  let nowX = 0;
  let lastX = 0;
  strip.forEach((t, i) => {
    const x = i * TICK_PITCH + TICK_W / 2;
    if (t === null) {
      nodes.push({ id: 'gap', x, y: TICK_Y, cells: [{ text: '…', w: TICK_W, tone: 'dim' }] });
      return;
    }
    if (t === s.now) nowX = x;
    if (t === s.last) lastX = x;
    nodes.push({ id: tid(t), x, y: TICK_Y, cells: [{ text: String(t), w: TICK_W }] });
  });
  decor.push({ id: 'clock-label', type: 'label', x: 0, y: CLOCK_LABEL_Y, text: `Clock, in ticks. Refill: ${perTick(s)}`, strong: true });
  // Each tag has a row of its own, because both point at the same tick straight after a refill.
  nodes.push({ id: 'ptr-now', x: nowX, y: NOW_Y, cells: [{ text: 'now' }], shape: 'tag' });
  nodes.push({ id: 'ptr-last', x: lastX, y: LAST_Y, cells: [{ text: 'last' }], shape: 'tag' });

  // Two empty labels pin the corners, so the view does not rescale as requests come and go.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: WIDTH, y: BOTTOM, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

/** Enough to drain what is there and still see a rejection or two. */
function suggestBurst(s: BucketState): number {
  return Math.max(2, Math.min(MAX_BURST, available(s) + 2));
}

/** Long enough to earn a token or two, or a long idle stretch now and then to show the cap. */
function suggestTicks(s: BucketState): number {
  const room = Math.max(1, MAX_TICK - s.now);
  return Math.min(room, randomInt(0, 4) === 0 ? randomInt(6, 9) : randomInt(1, 3));
}

const def: StructureDef<BucketState> = {
  id: 'token-bucket',
  params: [
    { id: 'capacity', label: 'Bucket capacity', default: 5, options: [3, 5, 8].map((v) => ({ value: v, label: `${v} tokens` })) },
    { id: 'rate', label: 'Refill rate', default: 1, options: [1, 2, 3].map((v) => ({ value: v, label: `${v} per tick` })) },
  ],
  create: (params) => create(params.capacity ?? 5, params.rate ?? 1),
  // A few ticks on the clock, so the first request has some arithmetic to do.
  seed: [['tick', 3]],
  ops: [
    {
      id: 'request',
      label: 'Request',
      intent: 'primary',
      args: [{ name: 'cost', label: 'Tokens', kind: 'int', min: 1, max: MAX_COST }],
      code: ['request', 'refill', 'retry_after'],
      run: (s, [n], rec) => void request(s, Number(n), rec),
      suggest: () => [randomInt(0, 3) === 0 ? 2 : 1],
    },
    {
      id: 'tick',
      label: 'Tick',
      args: [{ name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 }],
      code: ['tick'],
      run: (s, [k], rec) => void tick(s, Number(k), rec),
      suggest: (s) => [suggestTicks(s)],
    },
    {
      id: 'burst',
      label: 'Burst',
      args: [{ name: 'count', label: 'Requests', kind: 'int', min: 2, max: MAX_BURST }],
      code: ['burst', 'request', 'refill'],
      run: (s, [n], rec) => void burst(s, Number(n), rec),
      suggest: (s) => [suggestBurst(s)],
    },
    { id: 'reset', label: 'Reset', intent: 'danger', args: [], code: ['reset'], run: (s, _args, rec) => reset(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'allowed', label: 'Allowed' },
    { key: 'rejected', label: 'Rejected' },
  ],
  status: (s) => [
    { label: 'Tokens stored', value: `${s.tokens} of ${s.capacity}` },
    { label: 'Available if asked now', value: String(available(s)) },
    { label: 'Clock', value: `tick ${s.now}` },
    { label: 'Allowed, rejected', value: `${s.allowed}, ${s.rejected}` },
  ],
  tour: [['request', 1], ['burst', 5], ['request', 2], ['tick', 2], ['request', 2]],
  source: { python, java },
  info,
};

export default def;
