import { LABEL_LINE, LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_GAP, CELL_H, TAG_H, TRAY_PAD } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/TokenManager.java?raw';
import python from './code/token_manager.py?raw';
import { info } from './info';

/**
 * Token manager (the "authentication manager" exercise).
 *
 * A token lives for `ttl` ticks after it is generated or renewed. The map
 * holds each token's expiry. The queue holds (expires, id) entries in the
 * order they were pushed; with one ttl for every token and a clock that only
 * moves forward, that is also expiry order, so expired entries are always at
 * the front. A renewal pushes a fresh entry and leaves the old one where it
 * is, stale: a count pops from the front and skips any entry that no longer
 * matches the map. That is lazy deletion.
 *
 * `tokens` keeps the map in insertion order so the picture is stable.
 */
export interface Token {
  id: string;
  expires: number;
}

export interface Entry {
  /** Unique per entry, for a stable node id. */
  seq: number;
  expires: number;
  id: string;
}

export interface TmState {
  ttl: number;
  /** The clock, in ticks. The caller passes it into every call. */
  now: number;
  tokens: Token[];
  queue: Entry[];
  seq: number;
}

/** Tokens the page draws at once. */
export const MAX_TOKENS = 7;
/** Queue entries the page draws at once. */
export const MAX_QUEUE = 8;
/** The page's clock stops here so expiries stay two digits wide. */
export const MAX_TICK = 90;
/** Longest token id, so it fits its cell. */
export const MAX_ID = 2;
/** Ticks drawn on the clock strip. */
export const TICKS_SHOWN = 12;

export function create(ttl = 5): TmState {
  return { ttl, now: 0, tokens: [], queue: [], seq: 0 };
}

export const find = (s: TmState, id: string) => s.tokens.find((t) => t.id === id);
/** The truth: tokens whose expiry is after now. A token is expired at exactly its expiry time. */
export const liveCount = (s: TmState) => s.tokens.filter((t) => t.expires > s.now).length;
/** An entry that no longer matches the map: its token was renewed, or is gone. */
export const isStale = (s: TmState, e: Entry) => find(s, e.id)?.expires !== e.expires;

const tid = (id: string) => `tok-${id}`;
const qid = (e: Entry) => `q${e.seq}`;
const kid = (t: number) => `t${t}`;
const ticks = (n: number) => `${n} ${n === 1 ? 'tick' : 'ticks'}`;
const toks = (n: number) => `${n} ${n === 1 ? 'token' : 'tokens'}`;
const entries = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
const pair = (e: { expires: number; id: string }) => `(${e.expires}, ${e.id})`;
const list = (ids: string[]) => (ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`);

function removeToken(s: TmState, id: string): void {
  s.tokens = s.tokens.filter((t) => t.id !== id);
}

// ---- generate ---------------------------------------------------------------

export function generate(s: TmState, raw: string, rec: Rec): boolean {
  const id = String(raw).toLowerCase();
  rec.vars({ token_id: id, now: s.now });
  rec.line('expires');
  if (!/^[a-z]+$/.test(id) || id.length > MAX_ID) {
    rec.step(`Sorry, this page keeps token ids to ${MAX_ID} letters so they fit their boxes. A real map takes any string.`);
    return false;
  }
  const old = find(s, id);
  if (old) {
    rec.mark(tid(id), 'key');
    rec.step(
      old.expires > s.now
        ? `${id} already has a live token, expiring at ${old.expires}. The task promises every generate uses a new id, so this page refuses a repeat. Renew ${id} instead.`
        : `${id} is still in the map: it expired at ${old.expires} and no count has cleared it yet. The task promises every generate uses a new id, so this page refuses a repeat. Run Count first, or pick another id.`,
      { probe: { text: id, at: tid(id) } },
    );
    rec.unmark(tid(id));
    return false;
  }
  if (s.tokens.length >= MAX_TOKENS || s.queue.length >= MAX_QUEUE) {
    rec.step(
      s.tokens.length >= MAX_TOKENS
        ? `Sorry, this page draws at most ${MAX_TOKENS} tokens. Run Count to clear expired ones, or Reset. A real map has no such limit.`
        : `Sorry, this page draws at most ${MAX_QUEUE} queue entries. Advance the clock and run Count to pop expired ones, or Reset.`,
    );
    return false;
  }
  const expires = s.now + s.ttl;
  s.tokens.push({ id, expires });
  rec.mark(tid(id), 'key');
  rec.markCell(tid(id), 1, 'ok');
  rec.count('writes');
  rec.vars({ token_id: id, now: s.now, expires });
  rec.line('expires', 'store');
  rec.step(`Generate ${id} at tick ${s.now}. It expires at now + ttl = ${s.now} + ${s.ttl} = ${expires}. Store that in the map under ${id}.`, {
    probe: { text: id, at: tid(id), cell: 1 },
  });
  const e: Entry = { seq: ++s.seq, expires, id };
  s.queue.push(e);
  rec.unmark(tid(id));
  rec.mark(qid(e), 'ok');
  rec.count('writes');
  rec.line('push');
  rec.step(
    `Push ${pair(e)} on the back of the queue. Every token gets the same ttl and the clock never goes back, so the newest entry always expires last: the queue stays in expiry order with no sorting. Two writes, O(1).`,
    { probe: { text: id, at: qid(e), cell: 1 } },
  );
  rec.unmark(qid(e));
  rec.vars();
  return true;
}

// ---- renew ------------------------------------------------------------------

export function renew(s: TmState, raw: string, rec: Rec): boolean {
  const id = String(raw).toLowerCase();
  const t = find(s, id);
  rec.vars({ token_id: id, now: s.now, expires: t ? t.expires : null });
  rec.line('look');
  if (!t) {
    rec.line('look', 'alive', 'ignore');
    rec.step(`Renew ${id} at tick ${s.now}. The map has no token called ${id}, so get returns nothing and renew does nothing. That is the rule: an unknown token is ignored, not created.`);
    rec.vars();
    return false;
  }
  const at: Probe = { text: id, at: tid(id), cell: 1 };
  rec.mark(tid(id), 'key');
  rec.count('reads');
  rec.step(`Renew ${id} at tick ${s.now}. Look it up: the map says it expires at ${t.expires}.`, { probe: at });
  const alive = t.expires > s.now;
  rec.markCell(tid(id), 1, 'compare');
  rec.line('alive');
  rec.compare(`${id}: expires ${t.expires}`, alive ? '>' : '≤', `now ${s.now}`, alive ? 'still live, extend it' : 'expired, ignore', {
    probe: at,
    message: alive
      ? `${id} expires at ${t.expires}, after now (${s.now}). It is still live, so it may be renewed.`
      : t.expires === s.now
        ? `${id} expires at ${t.expires} and the clock reads ${s.now}. A token counts as expired at exactly its expiry time, so this renew is too late, by no time at all.`
        : `${id} expired at ${t.expires}, before now (${s.now}). It is still in the map only because no count has cleared it yet.`,
  });
  if (!alive) {
    rec.markCell(tid(id), 1, 'bad');
    rec.line('alive', 'ignore');
    rec.step(
      `Renew refused. Nothing changes: ${id} stays in the map, expired, until a count clears it. The client has to sign in again.`,
      { probe: at },
    );
    rec.unmark(tid(id));
    rec.vars();
    return false;
  }
  if (s.queue.length >= MAX_QUEUE) {
    rec.unmark(tid(id));
    rec.step(`Sorry, this page draws at most ${MAX_QUEUE} queue entries, and a renewal adds one. Advance the clock and run Count to pop expired ones, or Reset.`);
    rec.vars();
    return false;
  }
  const before = t.expires;
  t.expires = s.now + s.ttl;
  rec.markCell(tid(id), 1, 'ok');
  rec.count('writes');
  rec.vars({ token_id: id, now: s.now, expires: t.expires });
  rec.line('extend');
  rec.step(`Set ${id}'s expiry in the map to now + ttl = ${s.now} + ${s.ttl} = ${t.expires}, up from ${before}.`, { probe: at });
  const e: Entry = { seq: ++s.seq, expires: t.expires, id };
  s.queue.push(e);
  rec.unmark(tid(id));
  rec.mark(qid(e), 'ok');
  rec.count('writes');
  rec.line('push_again');
  rec.step(
    `Push ${pair(e)} on the back. The old entry ${pair({ expires: before, id })} is now stale: it no longer matches the map. Removing it from the middle would cost O(n), so a count will skip it instead: lazy deletion.`,
    { probe: { text: id, at: qid(e), cell: 1 } },
  );
  rec.unmark(qid(e));
  rec.vars();
  return true;
}

// ---- count, from the front of the queue -------------------------------------

/**
 * Pop expired entries from the front. With `trusting`, believe each entry's
 * expiry as a plain FIFO does (the bug); otherwise check it against the map
 * first and skip stale ones.
 */
function popFront(s: TmState, rec: Rec, trusting: boolean): { looked: number; popped: number; stale: number; wrong: string[] } {
  const L = trusting
    ? { front: 'f_front', pop: 'f_pop', drop: 'f_drop' }
    : { front: 'front', pop: 'pop', drop: 'drop' };
  let looked = 0;
  let popped = 0;
  let stale = 0;
  const wrong: string[] = [];
  for (;;) {
    const e = s.queue[0];
    let drop = false;
    rec.vars({ now: s.now, 'queue[0]': e ? pair(e) : null });
    rec.line(L.front);
    if (!e) {
      rec.step(`The queue is empty, so the loop stops.`);
      break;
    }
    looked++;
    rec.count('reads');
    const expired = e.expires <= s.now;
    rec.markCell(qid(e), 0, 'compare');
    const at: Probe = { text: e.id, at: qid(e), cell: 0 };
    rec.compare(`${e.id}: entry ${e.expires}`, expired ? '≤' : '>', `now ${s.now}`, expired ? 'expired, pop it' : 'stop, the rest are later', {
      probe: at,
      message: expired
        ? `The front entry ${pair(e)} expires at ${e.expires}, not after now (${s.now}). Pop it.`
        : `The front entry ${pair(e)} expires at ${e.expires}, after now (${s.now}). Every entry behind it expires at ${e.expires} or later, so stop here without looking at them.`,
    });
    if (!expired) {
      rec.unmark(qid(e));
      break;
    }
    popped++;
    rec.count('pops');
    rec.markCell(qid(e), 0, 'idle');
    const t = find(s, e.id);
    if (trusting) {
      drop = true;
      rec.vars({ now: s.now, expires: e.expires, token_id: e.id });
      rec.line(L.pop, L.drop);
      if (t && t.expires > s.now) {
        wrong.push(e.id);
        rec.mark(qid(e), 'bad');
        rec.mark(tid(e.id), 'bad');
        rec.step(
          `Delete ${e.id}, because the entry says it expired at ${e.expires}. But the map says ${e.id} expires at ${t.expires}: it was renewed and is still live. This count has just signed out a user who renewed in time.`,
          { probe: { text: e.id, at: tid(e.id), cell: 1 } },
        );
      } else if (t) {
        rec.mark(qid(e), 'bad');
        rec.mark(tid(e.id), 'bad');
        rec.step(`Delete ${e.id}. Here the entry is right: ${e.id} did expire at ${e.expires}.`, { probe: { text: e.id, at: tid(e.id), cell: 1 } });
      } else {
        rec.mark(qid(e), 'bad');
        rec.step(`Delete ${e.id}: it is already gone from the map, so there is nothing to delete.`, { probe: at });
      }
    } else {
      rec.count('reads');
      const current = t ? t.expires : null;
      const isOld = current !== e.expires;
      rec.vars({ now: s.now, expires: e.expires, token_id: e.id, 'expiry[token_id]': current });
      if (t) rec.markCell(tid(e.id), 1, 'compare');
      rec.line(L.pop, 'check');
      rec.compare(`${e.id}: map ${current ?? 'none'}`, isOld ? '≠' : '=', `entry ${e.expires}`, isOld ? 'stale entry, skip it' : 'really expired, delete', {
        probe: t ? { text: e.id, at: tid(e.id), cell: 1 } : at,
        message: isOld
          ? t
            ? `Before deleting, check the map. It says ${e.id} expires at ${current}, not ${e.expires}: ${e.id} was renewed after this entry was pushed.`
            : `Before deleting, check the map. ${e.id} is not in it any more, so this entry is left over.`
          : `Before deleting, check the map. It also says ${e.expires}, so this entry is current and ${e.id} really has expired.`,
      });
      if (t) rec.markCell(tid(e.id), 1, 'idle');
      if (isOld) {
        stale++;
        rec.count('stale');
        if (t) rec.unmark(tid(e.id));
        rec.mark(qid(e), 'bad');
        rec.line('stale');
        rec.step(
          t
            ? `Stale: throw the entry away and leave ${e.id} alone. Its newer entry, ${pair(t)}, is further back and will be checked when its time comes.`
            : `Stale: throw the entry away.`,
          { probe: at },
        );
      } else {
        drop = true;
        rec.mark(qid(e), 'bad');
        rec.mark(tid(e.id), 'bad');
        rec.line('drop');
        rec.step(`Delete ${e.id} from the map. It expired at ${e.expires}, and the map never needs to keep it again.`, { probe: { text: e.id, at: tid(e.id), cell: 1 } });
      }
    }
    s.queue.shift();
    if (drop) removeToken(s, e.id);
    rec.unmark(qid(e));
    rec.unmark(tid(e.id));
  }
  return { looked, popped, stale, wrong };
}

export function count(s: TmState, rec: Rec): number {
  const before = s.tokens.length;
  rec.vars({ now: s.now });
  rec.line('front');
  rec.step(
    `Count live tokens at tick ${s.now}. The queue is in expiry order, so every expired entry is at the front. Pop from the front until the front entry is still live.`,
  );
  const r = popFront(s, rec, false);
  const n = s.tokens.length;
  rec.vars({ now: s.now, 'len(expiry)': n });
  rec.line('size');
  rec.step(
    `${toks(n)} live: the map now holds only live tokens, so its size is the answer. It looked at ${entries(r.looked)} and popped ${r.popped}${r.stale ? `, ${r.stale} stale` : ``}. A scan reads all ${toks(before)} every time. Each entry is pushed once and popped once: O(1) amortised.`,
  );
  rec.vars();
  return n;
}

// ---- count by scanning --------------------------------------------------------

export function countByScan(s: TmState, rec: Rec): number {
  let live = 0;
  rec.vars({ now: s.now, live });
  rec.line('scan_start');
  rec.step(`Count by scanning: look at every token in the map and count those that expire after now (${s.now}).`);
  for (const t of s.tokens) {
    rec.count('reads');
    const alive = t.expires > s.now;
    if (alive) live++;
    rec.mark(tid(t.id), 'key');
    rec.markCell(tid(t.id), 1, 'compare');
    rec.vars({ now: s.now, live, expires: t.expires });
    rec.line('scan', 'scan_test', ...(alive ? ['scan_live'] : []));
    rec.compare(`${t.id}: expires ${t.expires}`, alive ? '>' : '≤', `now ${s.now}`, alive ? `live, so live = ${live}` : 'expired, skip', {
      probe: { text: t.id, at: tid(t.id), cell: 1 },
    });
    rec.unmark(tid(t.id));
    rec.mark(tid(t.id), alive ? 'path' : 'dim');
  }
  rec.vars({ now: s.now, live });
  rec.line('scan_done');
  rec.step(
    s.tokens.length
      ? `${toks(live)} live. The scan read all ${toks(s.tokens.length)} to find that, and deleted none, so expired tokens stay in the map. O(n) on every count: with a million live tokens, a million reads.`
      : `The map is empty, so the count is 0.`,
  );
  for (const t of s.tokens) rec.unmark(tid(t.id));
  rec.vars();
  return live;
}

// ---- the plain FIFO bug ------------------------------------------------------

export function countFifo(s: TmState, rec: Rec): number {
  const saved: TmState = { ...s, tokens: s.tokens.map((t) => ({ ...t })), queue: s.queue.map((e) => ({ ...e })) };
  const truth = liveCount(s);
  rec.vars({ now: s.now });
  rec.line('f_front');
  rec.step(
    `What if the count believed every queue entry? That is what a plain FIFO of tokens does, with renew changing only the map. This runs that count on a copy; your tokens come back afterwards.`,
  );
  const r = popFront(s, rec, true);
  const n = s.tokens.length;
  rec.vars({ now: s.now, 'len(expiry)': n });
  rec.line('f_size');
  rec.step(
    r.wrong.length
      ? `It reports ${n}, but ${truth} are live: it deleted ${list(r.wrong)}, renewed and still valid. A renewal moves a token's expiry later, so the queue's copy of it goes stale. Only the check against the map catches that.`
      : `It reports ${n}, which happens to be right: no renewed token's old entry had reached the front. Renew a token, advance past its old expiry and try again.`,
  );
  Object.assign(s, saved);
  rec.step(`The page puts your tokens and queue back as they were, so the right count can run on the same state.`);
  rec.vars();
  return n;
}

// ---- the clock ----------------------------------------------------------------

export function tick(s: TmState, k: number, rec: Rec): boolean {
  rec.vars({ ticks: k, now: s.now });
  rec.line('tick');
  if (s.now + k > MAX_TICK) {
    rec.step(`Sorry, this page's clock stops at tick ${MAX_TICK} so the numbers stay two digits wide, and it reads ${s.now}. Use Reset to start again.`);
    return false;
  }
  const from = s.now;
  s.now += k;
  for (let t = from + 1; t <= s.now; t++) rec.mark(kid(t), 'path');
  rec.vars({ ticks: k, now: s.now });
  const lapsed = s.tokens.filter((t) => t.expires > from && t.expires <= s.now);
  const exact = lapsed.filter((t) => t.expires === s.now).map((t) => t.id);
  rec.step(
    `Advance the clock by ${ticks(k)}, from ${from} to ${s.now}. No timer runs and no token is touched. ` +
      (lapsed.length
        ? `${list(lapsed.map((t) => t.id))} expired on the way${exact.length ? `; ${list(exact)} at exactly ${s.now}, which already counts as expired` : ``}. They stay in the map until a count clears them.`
        : `No token expired on the way.`),
  );
  for (let t = from + 1; t <= s.now; t++) rec.unmark(kid(t));
  return true;
}

// ---- layout -----------------------------------------------------------------

const ID_W = 42;
const EXP_W = 42;
const PAIR_W = TRAY_PAD * 2 + CELL_GAP + ID_W + EXP_W;
const PITCH = PAIR_W + 10;
const NODE_H = CELL_H + TRAY_PAD * 2;
const TICK_W = 40;
const TICK_PITCH = 42;
const CHIP_ROOM = PROBE_H + 16;
const MAP_Y = 0;
const MAP_LABEL_Y = MAP_Y - NODE_H / 2 - CHIP_ROOM - LABEL_LINE / 2;
const QUEUE_LABEL_Y = MAP_Y + NODE_H / 2 + 24 + LABEL_LINE / 2;
const QUEUE_Y = QUEUE_LABEL_Y + LABEL_LINE / 2 + CHIP_ROOM + NODE_H / 2;
const FRONT_Y = QUEUE_Y + NODE_H / 2 + 6 + TAG_H / 2;
const CLOCK_LABEL_Y = FRONT_Y + TAG_H / 2 + 22 + LABEL_LINE / 2;
const CLOCK_Y = CLOCK_LABEL_Y + LABEL_LINE / 2 + 10 + CELL_H / 2;
const NOW_Y = CLOCK_Y + CELL_H / 2 + 6 + TAG_H / 2;
const WIDTH = MAX_QUEUE * PITCH - 10;
const TOP = MAP_LABEL_Y - LABEL_MAX;
/** The now tag is wider than a tick, so it overhangs tick 0 a little. */
const LEFT = -4;
const BOTTOM = NOW_Y + TAG_H / 2 + 4;

/** The ticks on the clock strip: a few behind now, and at least the longest ttl ahead. */
export function strip(s: TmState): number[] {
  const lo = Math.max(0, s.now - 3);
  return Array.from({ length: TICKS_SHOWN }, (_, i) => lo + i);
}

export function layout(s: TmState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];

  decor.push({ id: 'map-label', type: 'label', x: 0, y: MAP_LABEL_Y, text: 'Map: token id → expires', strong: true });
  s.tokens.forEach((t, i) => {
    nodes.push({
      id: tid(t.id),
      x: i * PITCH + PAIR_W / 2,
      y: MAP_Y,
      cells: [
        { text: t.id, w: ID_W, tone: t.expires <= s.now ? 'dim' : undefined },
        { text: String(t.expires), w: EXP_W, tone: t.expires <= s.now ? 'dim' : undefined },
      ],
    });
  });
  if (!s.tokens.length) nodes.push({ id: 'map-empty', x: PAIR_W / 2, y: MAP_Y, cells: [{ text: '', w: ID_W }, { text: '', w: EXP_W }] });

  decor.push({ id: 'queue-label', type: 'label', x: 0, y: QUEUE_LABEL_Y, text: 'Queue of (expires, id), soonest first', strong: true });
  s.queue.forEach((e, i) => {
    nodes.push({
      id: qid(e),
      x: i * PITCH + PAIR_W / 2,
      y: QUEUE_Y,
      cells: [
        { text: String(e.expires), w: EXP_W, tone: isStale(s, e) ? 'dim' : undefined },
        { text: e.id, w: ID_W, tone: isStale(s, e) ? 'dim' : undefined },
      ],
    });
  });
  if (!s.queue.length) nodes.push({ id: 'q-empty', x: PAIR_W / 2, y: QUEUE_Y, cells: [{ text: '', w: EXP_W }, { text: '', w: ID_W }] });
  nodes.push({ id: 'ptr-front', x: PAIR_W / 2, y: FRONT_Y, cells: [{ text: 'front' }], shape: 'tag' });

  decor.push({ id: 'clock-label', type: 'label', x: 0, y: CLOCK_LABEL_Y, text: `Clock, in ticks. ttl = ${s.ttl}`, strong: true });
  let nowX = 0;
  strip(s).forEach((t, i) => {
    const x = i * TICK_PITCH + TICK_W / 2;
    if (t === s.now) nowX = x;
    nodes.push({ id: kid(t), x, y: CLOCK_Y, cells: [{ text: String(t), w: TICK_W }] });
  });
  nodes.push({ id: 'ptr-now', x: nowX, y: NOW_Y, cells: [{ text: 'now' }], shape: 'tag' });

  // Two empty labels pin the corners, so the view does not rescale as tokens come and go.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: WIDTH, y: BOTTOM, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

function suggestGenerate(s: TmState): string {
  return LETTERS.find((l) => !find(s, l)) ?? 'zz';
}

function suggestRenew(s: TmState): string {
  const live = s.tokens.filter((t) => t.expires > s.now);
  const dead = s.tokens.filter((t) => t.expires <= s.now);
  if (dead.length && (randomInt(0, 3) === 0 || !live.length)) return pick(dead).id;
  if (live.length) return pick(live).id;
  return 'zz';
}

const def: StructureDef<TmState> = {
  id: 'token-manager',
  params: [{ id: 'ttl', label: 'Time to live', default: 5, options: [3, 5, 8].map((v) => ({ value: v, label: ticks(v) })) }],
  create: (params) => create(params.ttl ?? 5),
  // Four tokens issued a tick apart, so they expire a tick apart.
  seed: [['generate', 'a'], ['tick', 1], ['generate', 'b'], ['tick', 1], ['generate', 'c'], ['tick', 1], ['generate', 'd']],
  ops: [
    {
      id: 'generate',
      label: 'Generate',
      intent: 'primary',
      args: [{ name: 'id', label: 'Token id', kind: 'word' }],
      code: ['generate'],
      run: (s, [id], rec) => void generate(s, String(id), rec),
      suggest: (s) => [suggestGenerate(s)],
    },
    {
      id: 'renew',
      label: 'Renew',
      args: [{ name: 'id', label: 'Token id', kind: 'word' }],
      code: ['renew'],
      run: (s, [id], rec) => void renew(s, String(id), rec),
      suggest: (s) => [suggestRenew(s)],
    },
    { id: 'count', label: 'Count', args: [], code: ['count'], run: (s, _a, rec) => void count(s, rec) },
    { id: 'count_scan', label: 'Count by scan', args: [], code: ['count_scan'], run: (s, _a, rec) => void countByScan(s, rec) },
    { id: 'count_fifo', label: 'Plain FIFO count (bug)', intent: 'danger', args: [], code: ['count_fifo'], run: (s, _a, rec) => void countFifo(s, rec) },
    {
      id: 'tick',
      label: 'Advance clock',
      args: [{ name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 }],
      code: ['tick'],
      run: (s, [k], rec) => void tick(s, Number(k), rec),
      suggest: (s) => [Math.max(1, Math.min(randomInt(1, 3), MAX_TICK - s.now))],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Reads' },
    { key: 'pops', label: 'Popped' },
    { key: 'writes', label: 'Writes' },
  ],
  status: (s) => {
    const stale = s.queue.filter((e) => isStale(s, e)).length;
    return [
      { label: 'Tokens in the map', value: String(s.tokens.length) },
      { label: 'Live now', value: String(liveCount(s)) },
      { label: 'Queue entries', value: stale ? `${s.queue.length}, ${stale} stale` : String(s.queue.length) },
      { label: 'Clock', value: `tick ${s.now}` },
    ];
  },
  tour: [['generate', 'e'], ['renew', 'a'], ['tick', 3], ['renew', 'b'], ['count_scan'], ['count_fifo'], ['count']],
  source: { python, java },
  info,
};

export default def;
