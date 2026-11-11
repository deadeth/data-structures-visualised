import { PROBE_H } from '../../core/fit';
import { CELL_H, TAG_H, cellWidth, tagWidth } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/StreamJoins.java?raw';
import python from './code/stream_joins.py?raw';
import { info } from './info';

/**
 * One stream processor, keyed, with three jobs running on it.
 *
 * - A window join: impressions and clicks for the same ad, keyed by ad id. A
 *   click matches an impression when 0 ≤ click time − impression time ≤ the
 *   window. Each side keeps the events it has seen in keyed state, so the
 *   other side can find them later.
 * - A tumbling-window count of page views by event time.
 * - A stream-table join: orders enriched with the user's country, read from a
 *   local copy of a profiles table that a change stream keeps up to date.
 *
 * Time is in ticks of event time. The watermark `wm` says that no event before
 * tick `wm` is expected any more. Here it is moved by hand (Advance
 * watermark); a real source derives it from the event times it has seen.
 * An event behind the watermark is late. Up to `lateness` ticks behind, it is
 * still used, and state is kept that much longer so it can still match.
 *
 * `lanes`, `arrivals`, `out` and `side` are the page's drawing of the
 * streams. The processor itself keeps only `state`, `windows` and `table`.
 */
export type Side = 'i' | 'c';
export type Lane = Side | 'v';

export interface Ev {
  seq: number;
  kind: Lane;
  /** Ad id for impressions and clicks; 0 for views. */
  key: number;
  t: number;
  /** View number, for the label. 0 for impressions and clicks. */
  n: number;
  /** Sent to the side output: too late to use. */
  late: boolean;
}

/** One event held in keyed state. `seq` ties it to the event on the timeline. */
export interface Entry {
  seq: number;
  t: number;
}

export interface Win {
  start: number;
  count: number;
  /** Its result has been emitted at least once. It is still kept for late views. */
  fired: boolean;
}

export interface Arrival {
  seq: number;
  kind: 'cdc' | 'order';
  user: number;
  country: string;
}

export interface OutRec {
  id: number;
  text: string;
}

export interface StreamState {
  /** Most ticks a click may come after its impression and still match. */
  window: number;
  /** Ticks behind the watermark an event may be and still be used. */
  lateness: number;
  wm: number;
  /** Largest event time ever placed on a timeline. */
  top: number;
  seq: number;
  views: number;
  outSeq: number;
  lanes: Record<Lane, Ev[]>;
  /** Side, then ad id, then entries in time order. */
  state: Record<Side, Record<string, Entry[]>>;
  /** Count per tumbling window, in start order. */
  windows: Win[];
  /** The local copy of the profiles table: user id to country. */
  table: Record<string, string>;
  /** The page's note of each user's last change, so an order can say what it would have got before it. */
  changes: Record<string, { from: string | null; to: string; seq: number }>;
  arrivals: Arrival[];
  out: OutRec[];
  side: OutRec[];
  /** Where the event being followed can find a match, shaded on the other timeline. */
  shade: { lane: Lane; from: number; to: number } | null;
}

/** Tumbling window length, in ticks. */
export const SIZE = 4;
/** Ticks drawn on the timelines. */
export const TICKS = 14;
/** Ticks drawn after the newest event or the watermark, whichever is later. */
export const AHEAD = 2;
/** Entries the page draws in each side's state. */
export const MAX_STATE = 5;
/** Windows the page draws at once. */
export const MAX_WINDOWS = 3;
export const USERS = 4;
export const ADS = 9;
export const MAX_TIME = 99;
const KEEP = 10;

export function create(window = 3, lateness = 2): StreamState {
  return {
    window,
    lateness,
    wm: 0,
    top: 0,
    seq: 0,
    views: 0,
    outSeq: 0,
    lanes: { i: [], c: [], v: [] },
    state: { i: {}, c: {} },
    windows: [],
    table: {},
    changes: {},
    arrivals: [],
    out: [],
    side: [],
    shade: null,
  };
}

/** The ticks drawn: the newest event or the watermark, plus a little room ahead. */
export function span(s: StreamState, t = -1): { lo: number; hi: number } {
  const hi = Math.max(s.top, s.wm, t) + AHEAD;
  const lo = Math.max(0, hi - (TICKS - 1));
  return { lo, hi: lo + TICKS - 1 };
}

/** State entries older than this can never match an event that is still accepted. */
export const keepFrom = (s: StreamState) => s.wm - s.window - s.lateness;

export const entries = (s: StreamState, side: Side) => Object.values(s.state[side]).reduce((n, list) => n + list.length, 0);

export function asSide(raw: number | string): Side | null {
  const w = String(raw).trim().toLowerCase();
  if (w === 'i' || w === 'imp' || w === 'impression') return 'i';
  if (w === 'c' || w === 'click') return 'c';
  return null;
}

const NAME: Record<Lane, string> = { i: 'impression', c: 'click', v: 'view' };
const PLURAL: Record<Lane, string> = { i: 'impressions', c: 'clicks', v: 'views' };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const other = (side: Side): Side => (side === 'i' ? 'c' : 'i');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ticks = (n: number) => plural(n, 'tick');
const listOf = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const isInt = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

/** Text of an event: i7@5, c7@7, v3@9. */
export const label = (e: Ev) => (e.kind === 'v' ? `v${e.n}@${e.t}` : `${e.kind}${e.key}@${e.t}`);
const laneText = (e: Ev) => (e.kind === 'v' ? `v${e.n}` : `${e.kind}${e.key}`);
const entryText = (key: string | number, t: number) => `${key}@${t}`;
const winText = (w: Win) => `[${w.start},${w.start + SIZE}) ${w.count}`;

// ---- ids --------------------------------------------------------------------

const eid = (seq: number) => `ev${seq}`;
const sid = (seq: number) => `st${seq}`;
const wid = (start: number) => `win${start}`;
const tid = (t: number) => `tk${t}`;
const tbid = (user: number | string) => `tb${user}`;
const oid = (id: number) => `out${id}`;
const sdid = (id: number) => `sd${id}`;
const WM_TAG = 'tag-wm';
const KEEP_TAG = 'tag-keep';

// ---- helpers ----------------------------------------------------------------

function push<T>(list: T[], item: T, keep = KEEP): void {
  list.push(item);
  if (list.length > keep) list.splice(0, list.length - keep);
}

function emit(s: StreamState, text: string): OutRec {
  const r = { id: ++s.outSeq, text };
  push(s.out, r);
  return r;
}

function toSide(s: StreamState, text: string): OutRec {
  const r = { id: ++s.outSeq, text };
  push(s.side, r);
  return r;
}

/** Put an event on its timeline. Events that have scrolled off the left edge are forgotten by the drawing. */
function place(s: StreamState, kind: Lane, key: number, t: number): Ev {
  const ev: Ev = { seq: ++s.seq, kind, key, t, n: kind === 'v' ? ++s.views : 0, late: false };
  s.lanes[kind].push(ev);
  s.top = Math.max(s.top, t);
  const { lo } = span(s);
  for (const l of ['i', 'c', 'v'] as Lane[]) s.lanes[l] = s.lanes[l].filter((e) => e.t >= lo);
  return ev;
}

/** The latest arrival on this lane with a later event time than t, if any. */
function overtaken(s: StreamState, lane: Lane, t: number): Ev | null {
  const later = s.lanes[lane].filter((e) => e.t > t);
  return later.length ? later.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
}

/** A reason the event cannot be drawn, or null. Checked before anything changes. */
function cannotDraw(s: StreamState, lane: Lane, t: number): string | null {
  const { lo, hi } = span(s, t);
  if (t < lo) return `Sorry, the timelines show ticks ${lo} to ${hi}, and tick ${t} is off the left edge. Pick a time from ${lo} on.`;
  const taken = s.lanes[lane].find((e) => e.t === t);
  if (taken) return `Sorry, this page draws one ${NAME[lane]} per tick so the timeline stays readable, and tick ${t} already has ${label(taken)}. Pick another tick.`;
  return null;
}

// ---- stream-stream join ---------------------------------------------------------

export interface Arrived {
  accepted: boolean;
  /** Joined pairs as [impression time, click time]. */
  joined: [number, number][];
}

/** An impression or a click arrives. Returns what happened, or null when the page could not take it. */
export function arrive(s: StreamState, rawSide: number | string, rawAd: number | string, rawT: number | string, rec: Rec, behind = 0): Arrived | null {
  const side = asSide(rawSide);
  const ad = Number(rawAd);
  const t = Number(rawT);
  rec.line('arrive');
  if (!side) {
    rec.step(`There are two streams to join: enter i for an impression or c for a click.`);
    return null;
  }
  if (!isInt(ad, 1, ADS)) {
    rec.step(`Ad ids on this page run from 1 to ${ADS}.`);
    return null;
  }
  if (!isInt(t, 0, MAX_TIME)) {
    rec.step(
      behind
        ? `The watermark is ${s.wm}, so an event ${ticks(behind)} behind it would have event time ${s.wm - behind}. Time starts at 0 here, so advance the watermark first.`
        : `Event times on this page run from 0 to ${MAX_TIME}.`,
    );
    return null;
  }
  const bad = cannotDraw(s, side, t);
  if (bad) {
    rec.step(bad);
    return null;
  }
  const accepted = t >= s.wm - s.lateness;
  if (accepted && entries(s, side) >= MAX_STATE) {
    rec.step(
      `Sorry, this page draws at most ${MAX_STATE} ${PLURAL[side]} in state, and it is full. Advance the watermark so expiry can drop the old ones, then send this ${NAME[side]} again. A real processor keeps state on local disk and is bounded only by its window and the event rate.`,
    );
    return null;
  }

  const W = s.window;
  const L = s.lateness;
  const ev = place(s, side, ad, t);
  const name = label(ev);
  const atEv: Probe = { text: name, at: eid(ev.seq) };
  const before = overtaken(s, side, t);
  rec.mark(eid(ev.seq), 'key');
  rec.step(
    `${cap(NAME[side])} ${name} arrives: ad ${ad}, event time ${t}. ` +
      (behind ? `That is ${ticks(behind)} behind the watermark. ` : ``) +
      (before
        ? `It turns up after ${label(before)}, which happened later. Streams arrive out of order, so each event is placed by the time it happened, not the time it arrived.`
        : `It is placed on the ${PLURAL[side]} timeline at tick ${t}, the time it happened.`),
    { probe: atEv },
  );

  // ---- is it late? -----------------------------------------------------------
  rec.line('late_test');
  if (t >= s.wm) {
    rec.compare(`t ${t}`, '≥', `wm ${s.wm}`, 'on time', {
      probe: atEv,
      message: `The watermark is at ${s.wm}: the processor has been told that no event before tick ${s.wm} should still arrive. ${t} ≥ ${s.wm}, so this one is on time.`,
    });
  } else {
    rec.compare(`t ${t}`, '<', `wm ${s.wm}`, 'late', {
      probe: atEv,
      message: `The watermark is at ${s.wm}, so events before tick ${s.wm} were not expected any more. This one is late by ${ticks(s.wm - t)}.`,
    });
    const floor = s.wm - L;
    rec.line('lateness_test');
    if (accepted) {
      rec.compare(`t ${t}`, '≥', `wm ${s.wm} − ${L} = ${floor}`, 'late, but allowed: use it', {
        probe: atEv,
        message: `Allowed lateness is ${ticks(L)}, so anything from tick ${floor} on is still used. State is kept ${ticks(L)} longer than the window needs for exactly this case.`,
      });
    } else {
      rec.compare(`t ${t}`, '<', `wm ${s.wm} − ${L} = ${floor}`, 'too late: side output', {
        probe: atEv,
        message: L
          ? `Allowed lateness is ${ticks(L)}, so only events from tick ${floor} on are used, and this one is older. The state it would need may already be gone.`
          : `Allowed lateness is 0, so nothing behind the watermark is used. The state it would need may already be gone.`,
      });
      ev.late = true;
      const r = toSide(s, name);
      rec.count('late');
      rec.mark(eid(ev.seq), 'bad');
      rec.mark(sdid(r.id), 'key');
      rec.line('side');
      rec.step(
        `${name} goes to the side output, a separate stream for late events. It is not stored and not joined; something else may reconcile it later, or it is dropped. ` +
          (L ? `` : `With an allowed lateness of 2 it would have been used. `) +
          `Waiting longer costs state and delay; giving up sooner loses events like this.`,
        { probe: { text: name, at: sdid(r.id) } },
      );
      return { accepted: false, joined: [] };
    }
  }

  // ---- store, then probe the other side ----------------------------------------
  const mine = (s.state[side][ad] ??= []);
  mine.push({ seq: ev.seq, t });
  mine.sort((a, b) => a.t - b.t || a.seq - b.seq);
  const atSt: Probe = { text: name, at: sid(ev.seq) };
  rec.mark(sid(ev.seq), 'key');
  rec.line('store');
  rec.step(
    `Store time ${t} in ${NAME[side]} state under key ${ad}. A matching ${NAME[other(side)]} may still be on its way, and when it comes it will look here. Nothing about any other ad is touched.`,
    { probe: atSt },
  );

  const o = other(side);
  const theirs = s.state[o][String(ad)] ?? [];
  s.shade = side === 'c' ? { lane: 'i', from: t - W, to: t } : { lane: 'c', from: t, to: t + W };
  const where = side === 'c' ? `from tick ${Math.max(0, t - W)} to ${t}` : `from tick ${t} to ${t + W}`;
  rec.line('probe');
  if (!theirs.length) {
    const gone = dropped(s, o, ad);
    rec.step(
      `Look up key ${ad} in ${NAME[o]} state: one hash lookup, no scan. Nothing is there. ` +
        (gone ? `${label(gone)} was dropped from state when the watermark passed ${gone.t} + ${W} + ${L} = ${gone.t + W + L}.` : missing(s, o, ad)),
      { probe: atSt },
    );
    if (gone) {
      rec.step(
        `${label(gone)} is ${ticks(Math.abs(t - gone.t))} from ${name}, outside the ${ticks(W)} window, as is anything else old enough to be dropped. Keeping every event for ever would let any pair match, but state would grow without limit. A window join keeps only what can still match: that is the price of bounded state.`,
        { probe: atSt },
      );
    }
  } else {
    rec.step(
      `Look up key ${ad} in ${NAME[o]} state: one hash lookup, with no scan of other ads. It holds ${listOf(theirs.map((e) => `${o}${ad}@${e.t}`))}. A match must sit ${where}: shaded on the ${PLURAL[o]} timeline.`,
      { probe: atSt },
    );
  }

  const joined: [number, number][] = [];
  for (const e of theirs) {
    const imp = side === 'i' ? t : e.t;
    const click = side === 'c' ? t : e.t;
    const gap = click - imp;
    const at: Probe = { text: name, at: sid(e.seq) };
    const lhs = `gap ${click} − ${imp} = ${gap}`;
    rec.mark(sid(e.seq), 'compare');
    rec.line('in_window');
    if (gap < 0) {
      rec.compare(lhs, '<', '0', 'click before impression: no match', {
        probe: at,
        message: `The click at ${click} came before the impression at ${imp}. A click cannot be caused by an ad shown later, so they do not match.`,
      });
      rec.mark(sid(e.seq), 'path');
    } else if (gap > W) {
      rec.compare(lhs, '>', `window ${W}`, 'too far apart: no match', {
        probe: at,
        message: `The click came ${ticks(gap)} after the impression, more than the ${ticks(W)} the window allows, so they do not match.`,
      });
      rec.mark(sid(e.seq), 'path');
    } else {
      rec.compare(lhs, '≤', `window ${W}`, 'inside the window: join', {
        probe: at,
        message: `The click came ${ticks(gap)} after the impression, within the ${ticks(W)} window. Same ad, close enough in time: they join.`,
      });
      const r = emit(s, `${ad}: i${imp} c${click}`);
      joined.push([imp, click]);
      rec.count('joined');
      rec.mark(sid(e.seq), 'ok');
      rec.mark(oid(r.id), 'ok');
      rec.line('emit');
      rec.step(`Emit the joined record ${r.text} to the output stream: ad ${ad}, shown at ${imp}, clicked at ${click}. Both events stay in state, since another event may match either of them.`, {
        probe: { text: name, at: oid(r.id) },
      });
    }
  }

  s.shade = null;
  rec.line('done');
  rec.step(
    `${name}: ${joined.length ? `${plural(joined.length, 'joined record')}` : 'no match yet'}, from 1 lookup and ${plural(theirs.length, 'time comparison')}. ` +
      `It stays in state until the watermark passes ${t} + ${W} + ${L} = ${t + W + L}. After that, no event that is still accepted could match it.`,
    { probe: atSt },
  );
  return { accepted: true, joined };
}

/** The latest event for this ad on the other side that was used and has since been dropped from state, if any. */
function dropped(s: StreamState, o: Side, ad: number): Ev | null {
  return s.lanes[o].filter((e) => e.key === ad && !e.late).sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** Why the other side holds nothing for this ad, when nothing was ever there. */
function missing(s: StreamState, o: Side, ad: number): string {
  return o === 'i'
    ? `No impression for ad ${ad} has arrived, or none that is still kept. If one turns up within the window, it will find this click.`
    : `No click for ad ${ad} has arrived yet. If one comes within ${ticks(s.window)}, it will find this impression.`;
}

// ---- watermark and expiry -----------------------------------------------------

/** Move the watermark on, drop state that can no longer match, and close windows. Returns the entries dropped. */
export function advance(s: StreamState, rawK: number | string, rec: Rec): number {
  const k = Number(rawK);
  rec.line('advance');
  if (!isInt(k, 1, 9)) {
    rec.step(`Advance the watermark by 1 to 9 ticks.`);
    return 0;
  }
  if (s.wm + k > MAX_TIME) {
    rec.step(`Sorry, this page's clock stops at tick ${MAX_TIME} so the numbers stay readable, and the watermark is at ${s.wm}. Rebuild the page to start again from 0.`);
    return 0;
  }
  const from = s.wm;
  s.wm += k;
  const wmText = `wm ${s.wm}`;
  const atWm: Probe = { text: wmText, at: WM_TAG };
  rec.step(
    `The watermark moves from ${from} to ${s.wm}: a marker carried through the stream, promising that nothing before tick ${s.wm} should still arrive. You move it by hand here; a real source derives it from event times, such as the largest seen minus a fixed delay.`,
    { probe: atWm },
  );

  const W = s.window;
  const L = s.lateness;
  const keep = keepFrom(s);
  rec.line('horizon');
  rec.step(
    `Which state can still be useful? An event is still used if its time is at least ${s.wm} − ${L} = ${s.wm - L}, and it can match only within ${ticks(W)}. So keep entries from ${s.wm} − ${W} − ${L} = ${keep} on and drop the rest.`,
    { probe: span(s).lo <= keep ? { text: wmText, at: KEEP_TAG } : atWm },
  );

  let dropped = 0;
  for (const side of ['i', 'c'] as Side[]) {
    const byAd = s.state[side];
    for (const ad of Object.keys(byAd).sort((a, b) => Number(a) - Number(b))) {
      const list = byAd[ad];
      while (list.length) {
        const e = list[0];
        const at: Probe = { text: wmText, at: sid(e.seq) };
        rec.mark(sid(e.seq), 'compare');
        if (e.t < keep) {
          rec.line('expire_test', 'drop');
          rec.compare(`keep from ${keep}`, '>', `${side}${ad} at ${e.t}`, 'drop it', {
            probe: at,
            message: `${side}${ad}@${e.t} is older than ${keep}. No event that can still arrive is close enough in time to match it, so it is dropped from state.`,
          });
          list.shift();
          dropped++;
          rec.count('expired');
        } else {
          rec.line('expire_test');
          rec.compare(`keep from ${keep}`, '≤', `${side}${ad} at ${e.t}`, `keep it, and the rest for ad ${ad}`, {
            probe: at,
            message: `${side}${ad}@${e.t} is recent enough to keep. The entries for ad ${ad} are in time order, so the ones after it are kept too.`,
          });
          rec.unmark(sid(e.seq));
          break;
        }
      }
      if (!list.length) delete byAd[ad];
    }
  }

  // ---- close windows ---------------------------------------------------------
  let fired = 0;
  for (const w of [...s.windows]) {
    const end = w.start + SIZE;
    const at: Probe = { text: wmText, at: wid(w.start) };
    rec.mark(wid(w.start), 'compare');
    rec.line('close', 'open_test');
    if (end > s.wm) {
      rec.compare(wmText, '<', `end ${end}`, `[${w.start},${end}) stays open`, {
        probe: at,
        message: `Window [${w.start},${end}) ends at ${end}, after the watermark: views for it may still come. It stays open, and so do the windows after it.`,
      });
      rec.unmark(wid(w.start));
      break;
    }
    rec.compare(wmText, '≥', `end ${end}`, w.fired ? 'already emitted' : 'complete: emit it', {
      probe: at,
      message: w.fired
        ? `Window [${w.start},${end}) was emitted earlier and is only being kept for late views.`
        : `Window [${w.start},${end}) ends at ${end}, and the watermark says nothing before ${s.wm} is still coming. Its count is complete.`,
    });
    if (!w.fired) {
      w.fired = true;
      fired++;
      const r = emit(s, winText(w));
      rec.mark(wid(w.start), 'ok');
      rec.mark(oid(r.id), 'ok');
      rec.line('close', 'fire');
      rec.step(`Emit ${r.text}: ${plural(w.count, 'view')} between tick ${w.start} and ${end}. It goes out once the watermark says the window is complete, not when the clock on the wall passes ${end}.`, {
        probe: { text: wmText, at: oid(r.id) },
      });
    }
    rec.mark(wid(w.start), 'compare');
    rec.line('close', 'purge_test');
    if (end + L <= s.wm) {
      rec.compare(wmText, '≥', `end ${end} + ${L}`, 'past allowed lateness: drop it', {
        probe: at,
        message: L
          ? `The watermark is at least ${ticks(L)} past the end of [${w.start},${end}), the allowed lateness. No late view can be used for it any more, so its state is dropped.`
          : `Allowed lateness is 0, so nothing is kept once a window is emitted. Its state is dropped.`,
      });
      rec.mark(wid(w.start), 'bad');
      rec.line('close', 'purge');
      rec.step(`Drop window [${w.start},${end}) from state. A view for it that turns up now goes to the side output.`, { probe: at });
      s.windows.splice(s.windows.indexOf(w), 1);
    } else {
      rec.compare(wmText, '<', `end ${end} + ${L}`, 'keep it for late views', {
        probe: at,
        message: `Allowed lateness is ${ticks(L)}, so [${w.start},${end}) is kept until the watermark reaches ${end + L}. A late view for it will update the count and emit a corrected result.`,
      });
      rec.unmark(wid(w.start));
    }
  }

  rec.line('done');
  const held = entries(s, 'i') + entries(s, 'c');
  rec.step(
    `Watermark ${s.wm}: ${plural(dropped, 'state entry', 'state entries')} dropped and ${plural(fired, 'window')} emitted. State now holds ${plural(held, 'event')}. Without this clean-up it would grow with every event for as long as the job runs.`,
    { probe: atWm },
  );
  return dropped;
}

// ---- tumbling window count --------------------------------------------------------

/** A page view arrives and is counted in its tumbling window. Returns the window start, or null. */
export function view(s: StreamState, rawT: number | string, rec: Rec): number | null {
  const t = Number(rawT);
  rec.line('arrive');
  if (!isInt(t, 0, MAX_TIME)) {
    rec.step(`Event times on this page run from 0 to ${MAX_TIME}.`);
    return null;
  }
  const bad = cannotDraw(s, 'v', t);
  if (bad) {
    rec.step(bad);
    return null;
  }
  const start = t - (t % SIZE);
  const end = start + SIZE;
  const L = s.lateness;
  const kept = end + L > s.wm;
  const existing = s.windows.find((w) => w.start === start);
  if (kept && !existing && s.windows.length >= MAX_WINDOWS) {
    rec.step(`Sorry, this page draws at most ${MAX_WINDOWS} windows at once, and a view at ${t} would open a fourth. Advance the watermark to close and drop the old ones first.`);
    return null;
  }

  const ev = place(s, 'v', 0, t);
  const name = label(ev);
  const atEv: Probe = { text: name, at: eid(ev.seq) };
  const before = overtaken(s, 'v', t);
  rec.mark(eid(ev.seq), 'key');
  rec.step(
    `Page view ${name} arrives with event time ${t}. ` +
      (before ? `It turns up after ${label(before)}, which happened later: it is out of order.` : `It is placed on the views timeline at tick ${t}.`),
    { probe: atEv },
  );

  s.shade = { lane: 'v', from: start, to: end - 1 };
  rec.line('assign');
  rec.step(
    `Tumbling windows are ${ticks(SIZE)} long and never overlap: [0,4), [4,8), and so on. ${t} − ${t} mod ${SIZE} = ${start}, so ${name} belongs to [${start},${end}).` +
      (before ? ` Placed by processing time, it would have gone in with ${label(before)}. By event time it goes where it happened.` : ``),
    { probe: atEv },
  );

  rec.line('kept_test');
  if (existing) rec.mark(wid(start), 'compare');
  const lhs = `[${start},${end}) end ${end} + ${L}`;
  if (!kept) {
    rec.compare(lhs, '≤', `wm ${s.wm}`, 'window already dropped: side output', {
      probe: atEv,
      message: `The watermark is at ${s.wm}, past the end of [${start},${end}) plus the allowed lateness of ${L}. That window's result went out and its state is gone.`,
    });
    ev.late = true;
    const r = toSide(s, name);
    rec.count('late');
    rec.mark(eid(ev.seq), 'bad');
    rec.mark(sdid(r.id), 'key');
    s.shade = null;
    rec.line('side');
    rec.step(`${name} goes to the side output. The count already sent for [${start},${end}) stays one short; whatever reads the side output must correct it, or accept the error.`, {
      probe: { text: name, at: sdid(r.id) },
    });
    return null;
  }
  rec.compare(lhs, '>', `wm ${s.wm}`, t >= s.wm ? 'on time: count it' : 'late, but the window is kept: count it', {
    probe: atEv,
    message:
      t >= s.wm
        ? `The window is still open, so the view is counted.`
        : `${name} is behind the watermark, but its window is still kept: ${end} + ${L} > ${s.wm}. It is counted.`,
  });

  let w = existing;
  if (!w) {
    w = { start, count: 0, fired: false };
    s.windows.push(w);
    s.windows.sort((a, b) => a.start - b.start);
  }
  w.count++;
  rec.mark(wid(start), 'ok');
  rec.line('count');
  rec.step(`Add 1 to [${start},${end}): it now holds ${plural(w.count, 'view')}. The state for a window is one number, not the views themselves.`, {
    probe: { text: name, at: wid(start) },
  });

  rec.line('closed_test');
  if (end <= s.wm) {
    rec.compare(`[${start},${end}) end ${end}`, '≤', `wm ${s.wm}`, 'already complete: emit a correction', {
      probe: { text: name, at: wid(start) },
      message: `[${start},${end}) ended before the watermark, so its result has been sent, or is due now.`,
    });
    const was = w.fired;
    w.fired = true;
    const r = emit(s, winText(w));
    rec.mark(oid(r.id), 'ok');
    rec.line('refire');
    rec.step(
      was
        ? `Emit ${r.text} again with the new count. Flink calls this a late firing. Whatever reads the output must treat it as a correction to the earlier result for the same window, not as a new one.`
        : `Emit ${r.text} at once: the watermark is already past this window.`,
      { probe: { text: name, at: oid(r.id) } },
    );
  } else {
    rec.compare(`[${start},${end}) end ${end}`, '>', `wm ${s.wm}`, 'still open: emit later', {
      probe: { text: name, at: wid(start) },
      message: `[${start},${end}) ends at ${end}, after the watermark at ${s.wm}. Nothing is emitted yet: the count goes out when the watermark passes ${end}.`,
    });
  }

  s.shade = null;
  rec.line('done');
  rec.step(
    `${name} counted in [${start},${end}), which holds ${plural(w.count, 'view')}. ` + (before ? `It arrived late in processing time but was counted where it happened.` : `One sum and one write to a counter.`),
    { probe: { text: name, at: wid(start) } },
  );
  return start;
}

// ---- stream-table join ------------------------------------------------------------

const validUser = (u: number) => isInt(u, 1, USERS);

/** A change event for the profiles table. Returns the old country, or null. */
export function change(s: StreamState, rawUser: number | string, rawCountry: number | string, rec: Rec): string | null {
  const u = Number(rawUser);
  const c = String(rawCountry).trim().toUpperCase();
  rec.line('arrive');
  if (!validUser(u)) {
    rec.step(`User ids on this page run from 1 to ${USERS}.`);
    return null;
  }
  if (!/^[A-Z]{2}$/.test(c)) {
    rec.step(`Enter a two-letter country code, such as fr or de.`);
    return null;
  }
  const a: Arrival = { seq: ++s.seq, kind: 'cdc', user: u, country: c };
  push(s.arrivals, a);
  const name = `u${u}=${c}`;
  rec.mark(eid(a.seq), 'key');
  rec.step(
    `A change event arrives: user ${u}'s country is now ${c}. Change data capture reads the database's own log of committed changes and turns each changed row into an event like this one.`,
    { probe: { text: name, at: eid(a.seq) } },
  );
  const old = s.table[u] ?? null;
  s.table[u] = c;
  s.changes[u] = { from: old, to: c, seq: a.seq };
  rec.mark(tbid(u), 'key');
  rec.line('upsert');
  rec.step(
    (old === null ? `Insert user ${u} with ${c} into the local copy of the table.` : old === c ? `User ${u} already has ${c}. Writing it again changes nothing.` : `Overwrite user ${u}: ${old} becomes ${c} in the local copy.`) +
      ` The copy keeps only the latest value for each key, like a compacted Kafka topic.`,
    { probe: { text: name, at: tbid(u) } },
  );
  rec.line('done');
  rec.step(`No output: a table change only alters what later orders will see. The processor keeps the whole table in its own state, so it never has to call the database.`, {
    probe: { text: name, at: tbid(u) },
  });
  return old;
}

/** An order arrives and is enriched with the user's country. Returns the country, or null when unknown. */
export function order(s: StreamState, rawUser: number | string, rec: Rec): string | null {
  const u = Number(rawUser);
  rec.line('arrive');
  if (!validUser(u)) {
    rec.step(`User ids on this page run from 1 to ${USERS}.`);
    return null;
  }
  const a: Arrival = { seq: ++s.seq, kind: 'order', user: u, country: '' };
  push(s.arrivals, a);
  const name = `o${u}`;
  rec.mark(eid(a.seq), 'key');
  rec.step(`Order ${name} arrives from user ${u}. Before it goes on, it needs the user's country, which lives in the profiles table.`, {
    probe: { text: name, at: eid(a.seq) },
  });

  const country = s.table[u] ?? null;
  if (country !== null) rec.mark(tbid(u), 'compare');
  rec.line('lookup');
  rec.step(
    `Look up user ${u} in the local copy of the profiles table. It is part of this processor's state, filled from the change stream, so this is a local read: no network call and no load on the database. ` +
      (country === null ? `There is no row for user ${u}.` : `It says ${country}.`),
    { probe: { text: name, at: country === null ? eid(a.seq) : tbid(u) } },
  );

  const r = emit(s, `${name} ${country ?? 'null'}`);
  if (country !== null) rec.mark(tbid(u), 'path');
  rec.mark(oid(r.id), 'ok');
  rec.line('enrich');
  rec.step(
    country === null
      ? `Emit ${r.text}. This is a left join, so an order with no profile still goes out, with the country empty. An inner join would drop it.`
      : `Emit ${r.text}: the order with the country added.`,
    { probe: { text: name, at: oid(r.id) } },
  );

  const ch = s.changes[u];
  rec.line('done');
  rec.step(
    ch && ch.from !== null && ch.from !== ch.to
      ? `${name} got ${ch.to} because u${u}=${ch.to} arrived before it. An order processed before that change got ${ch.from}. Same events, different arrival order, different answer: the lookup reads the table as it is now, not as it was when the order was placed.`
      : country === null
        ? `If a profile for user ${u} arrives a moment later, this order will not be corrected: a stream-table join reacts only to the stream side. The answer depends on which arrived first.`
        : `The answer is whatever the table holds when the order is processed. Had a change for user ${u} arrived first, the order would carry the new value.`,
    { probe: { text: name, at: oid(r.id) } },
  );
  return country;
}

// ---- layout -------------------------------------------------------------------

const PITCH = 38;
const EV_W = 36;
const LANE_W = TICKS * PITCH;
const RX = LANE_W + 34;
const RIGHT = 940;
const LANE_Y: Record<Lane, number> = { i: 0, c: 80, v: 160 };
const AXIS_Y = 204;
const TAG_Y = AXIS_Y + CELL_H / 2 + 4 + TAG_H / 2;
const OUT_Y = 240;
const TABLE_Y = 320;
/** Labels sit in the room kept above each row for the probe chip. */
const LABEL_UP = CELL_H / 2 + 13;
const GAP = 3;
const GROUP_GAP = 10;
const TOP = LANE_Y.i - CELL_H / 2 - PROBE_H - 16;
const BOTTOM = TABLE_Y + CELL_H / 2;

const xOf = (lo: number, t: number) => (t - lo) * PITCH + PITCH / 2;

export function layout(s: StreamState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const { lo, hi } = span(s);

  // Tumbling windows as trays on the time axis, drawn first so everything sits on top.
  for (let a = lo - (lo % SIZE); a <= hi; a += SIZE) {
    const from = Math.max(a, lo);
    const to = Math.min(a + SIZE - 1, hi);
    decor.push({ id: `tray${a}`, type: 'band', x: xOf(lo, from) - PITCH / 2 + 1, y: AXIS_Y - 14, w: (to - from + 1) * PITCH - 2, h: 28 });
  }
  if (s.shade) {
    const from = Math.max(lo, s.shade.from);
    const to = Math.min(hi, s.shade.to);
    if (from <= to) {
      const y = LANE_Y[s.shade.lane];
      decor.push({ id: 'shade', type: 'band', x: xOf(lo, from) - PITCH / 2 + 1, y: y - CELL_H / 2 - 5, w: (to - from + 1) * PITCH - 2, h: CELL_H + 10 });
    }
  }
  // The watermark: a line between tick wm - 1 and tick wm, through every timeline.
  if (s.wm >= lo && s.wm <= hi) {
    decor.push({ id: 'wm-line', type: 'band', x: xOf(lo, s.wm) - PITCH / 2 - 2, y: LANE_Y.i - CELL_H / 2 - 6, w: 4, h: AXIS_Y + CELL_H / 2 - (LANE_Y.i - CELL_H / 2 - 6) });
  }

  // ---- timelines ----
  // An event the processor no longer holds (expired, or its window dropped) is drawn dim.
  const held = new Set<number>();
  for (const side of ['i', 'c'] as Side[]) for (const list of Object.values(s.state[side])) for (const e of list) held.add(e.seq);
  const open = new Set(s.windows.map((w) => w.start));
  for (const lane of ['i', 'c', 'v'] as Lane[]) {
    for (const e of s.lanes[lane]) {
      if (e.t < lo || e.t > hi) continue;
      const kept = lane === 'v' ? open.has(e.t - (e.t % SIZE)) : held.has(e.seq);
      nodes.push({ id: eid(e.seq), x: xOf(lo, e.t), y: LANE_Y[lane], cells: [{ text: laneText(e), w: EV_W }], tone: e.late ? 'bad' : kept ? undefined : 'dim' });
    }
  }
  decor.push({ id: 'lbl-i', type: 'label', x: 0, y: LANE_Y.i - LABEL_UP, text: 'Impressions, by event time', strong: true });
  decor.push({ id: 'lbl-c', type: 'label', x: 0, y: LANE_Y.c - LABEL_UP, text: 'Clicks, by event time', strong: true });
  decor.push({ id: 'lbl-v', type: 'label', x: 0, y: LANE_Y.v - LABEL_UP, text: `Page views; trays below are ${SIZE}-tick windows`, strong: true });

  for (let t = lo; t <= hi; t++) decor.push({ id: tid(t), type: 'label', x: xOf(lo, t), y: AXIS_Y, text: String(t), anchor: 'middle' });
  // A tag sits under its tick, but never hangs past the left edge of the timelines.
  const tagX = (t: number, text: string) => Math.max(xOf(lo, t), tagWidth(text) / 2 - 2);
  const wmText = `wm ${s.wm}`;
  nodes.push({ id: WM_TAG, x: tagX(Math.max(lo, Math.min(hi, s.wm)), wmText), y: TAG_Y, cells: [{ text: wmText }], shape: 'tag' });
  const keep = keepFrom(s);
  const keepText = `keep ≥${keep}`;
  if (keep >= lo && keep <= hi) nodes.push({ id: KEEP_TAG, x: tagX(keep, keepText), y: TAG_Y, cells: [{ text: keepText }], shape: 'tag' });

  // ---- keyed state ----
  for (const side of ['i', 'c'] as Side[]) {
    const y = LANE_Y[side];
    let x = RX;
    const ads = Object.keys(s.state[side]).sort((a, b) => Number(a) - Number(b));
    ads.forEach((ad, g) => {
      if (g) x += GROUP_GAP - GAP;
      for (const e of s.state[side][ad]) {
        const text = entryText(ad, e.t);
        const w = Math.max(52, cellWidth({ text }));
        nodes.push({ id: sid(e.seq), x: x + w / 2, y, cells: [{ text, w }], from: eid(e.seq) });
        x += w + GAP;
      }
    });
    const n = entries(s, side);
    decor.push({ id: `lbl-s${side}`, type: 'label', x: RX, y: y - LABEL_UP, text: n ? `${cap(NAME[side])} state, by ad` : `${cap(NAME[side])} state: empty`, strong: true });
  }

  // ---- window counts ----
  {
    let x = RX;
    for (const w of s.windows) {
      const text = winText(w);
      const cw = cellWidth({ text });
      nodes.push({ id: wid(w.start), x: x + cw / 2, y: LANE_Y.v, cells: [{ text, w: cw }], tone: w.fired ? 'ok' : undefined });
      x += cw + GROUP_GAP;
    }
    decor.push({ id: 'lbl-w', type: 'label', x: RX, y: LANE_Y.v - LABEL_UP, text: s.windows.length ? 'Count per window; green: emitted' : 'Count per window: none open', strong: true });
  }

  // ---- output and side output ----
  {
    const side = s.side.slice(-2);
    const sideW = side.reduce((sum, r) => sum + cellWidth({ text: r.text }) + GAP, 0) - (side.length ? GAP : 0);
    const sideX = RIGHT - Math.max(sideW, 150);
    let sx = sideX;
    for (const r of side) {
      const w = cellWidth({ text: r.text });
      nodes.push({ id: sdid(r.id), x: sx + w / 2, y: OUT_Y, cells: [{ text: r.text, w }], tone: 'bad' });
      sx += w + GAP;
    }
    decor.push({ id: 'lbl-side', type: 'label', x: sideX, y: OUT_Y - LABEL_UP, text: side.length ? 'Side output' : 'Side output: none', strong: true });
    const room = sideX - GROUP_GAP * 2 - RX;
    const shown: OutRec[] = [];
    let used = 0;
    for (let i = s.out.length - 1; i >= 0; i--) {
      const w = cellWidth({ text: s.out[i].text }) + GAP;
      if (used + w - GAP > room) break;
      used += w;
      shown.unshift(s.out[i]);
    }
    let x = RX;
    for (const r of shown) {
      const w = cellWidth({ text: r.text });
      nodes.push({ id: oid(r.id), x: x + w / 2, y: OUT_Y, cells: [{ text: r.text, w }] });
      x += w + GAP;
    }
    decor.push({ id: 'lbl-out', type: 'label', x: RX, y: OUT_Y - LABEL_UP, text: s.out.length ? 'Output, newest last' : 'Output: nothing yet', strong: true });
  }

  // ---- changes and orders, in arrival order; and the table ----
  {
    const shown: Arrival[] = [];
    let used = 0;
    for (let i = s.arrivals.length - 1; i >= 0; i--) {
      const w = cellWidth({ text: arrivalText(s.arrivals[i]) }) + GAP * 2;
      if (used + w > LANE_W) break;
      used += w;
      shown.unshift(s.arrivals[i]);
    }
    let x = 0;
    for (const a of shown) {
      const text = arrivalText(a);
      const w = cellWidth({ text });
      nodes.push({ id: eid(a.seq), x: x + w / 2, y: TABLE_Y, cells: [{ text, w }] });
      x += w + GAP * 2;
    }
    decor.push({ id: 'lbl-a', type: 'label', x: 0, y: TABLE_Y - LABEL_UP, text: 'Profile changes and orders, in arrival order', strong: true });
    let tx = RX;
    for (const u of Object.keys(s.table).sort((a, b) => Number(a) - Number(b))) {
      const text = `u${u} ${s.table[u]}`;
      const w = cellWidth({ text });
      nodes.push({ id: tbid(u), x: tx + w / 2, y: TABLE_Y, cells: [{ text, w }] });
      tx += w + GROUP_GAP;
    }
    decor.push({ id: 'lbl-t', type: 'label', x: RX, y: TABLE_Y - LABEL_UP, text: Object.keys(s.table).length ? 'Profiles table, local copy' : 'Profiles table: empty', strong: true });
  }

  // Two empty labels pin the corners, so the scene keeps its size.
  decor.push({ id: 'corner-a', type: 'label', x: -4, y: TOP, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges: [], decor };
}

const arrivalText = (a: Arrival) => (a.kind === 'cdc' ? `u${a.user}=${a.country}` : `o${a.user}`);

// ---- definition -----------------------------------------------------------------

const SIDE_ARG = { name: 'stream', label: 'Stream (i or c)', kind: 'word' } as const;
const AD_ARG = { name: 'ad', label: 'Ad', kind: 'int', min: 1, max: ADS } as const;
const USER_ARG = { name: 'user', label: 'User', kind: 'int', min: 1, max: USERS } as const;
const COUNTRIES = ['fr', 'de', 'it', 'es', 'nl', 'gb'];

const free = (s: StreamState, lane: Lane, t: number) => t >= 0 && t <= MAX_TIME && cannotDraw(s, lane, t) === null;

function freeIn(s: StreamState, lane: Lane, from: number, to: number): number | null {
  const options: number[] = [];
  for (let t = Math.max(0, from); t <= Math.min(MAX_TIME, to); t++) if (free(s, lane, t)) options.push(t);
  return options.length ? options[randomInt(0, options.length - 1)] : null;
}

/** Most of the time an event that can match something already in state, on time. */
function suggestEvent(s: StreamState): [string, number, number] {
  const sides: Side[] = randomInt(0, 1) ? ['c', 'i'] : ['i', 'c'];
  for (const side of sides) {
    if (entries(s, side) >= MAX_STATE) continue;
    const o = other(side);
    const theirs = Object.entries(s.state[o]).flatMap(([ad, list]) => list.map((e) => [Number(ad), e.t] as const));
    if (theirs.length && randomInt(0, 3) > 0) {
      const [ad, u] = theirs[randomInt(0, theirs.length - 1)];
      const t = side === 'c' ? freeIn(s, side, Math.max(s.wm, u), u + s.window) : freeIn(s, side, Math.max(s.wm, u - s.window), u);
      if (t !== null) return [side, ad, t];
    }
    const t = freeIn(s, side, s.wm, s.wm + 4);
    if (t !== null) return [side, randomInt(1, 6), t];
  }
  return [sides[0], randomInt(1, 6), s.wm];
}

function suggestLate(s: StreamState): [string, number, number] {
  const side: Side = randomInt(0, 1) ? 'c' : 'i';
  const ads = Object.keys(s.state[other(side)]).map(Number);
  const ad = ads.length ? ads[randomInt(0, ads.length - 1)] : randomInt(1, 6);
  const options: number[] = [];
  for (let b = 1; b <= Math.min(6, s.wm); b++) if (free(s, side, s.wm - b)) options.push(b);
  return [side, ad, options.length ? options[randomInt(0, options.length - 1)] : 1];
}

function suggestView(s: StreamState): number {
  const newest = s.lanes.v.length ? Math.max(...s.lanes.v.map((e) => e.t)) : s.wm;
  const fits = (t: number) => {
    const start = t - (t % SIZE);
    return s.windows.some((w) => w.start === start) || s.windows.length < MAX_WINDOWS || start + SIZE + s.lateness <= s.wm;
  };
  for (let i = 0; i < 30; i++) {
    const t = randomInt(Math.max(0, Math.min(s.wm, newest - 3)), Math.max(s.wm, newest) + 2);
    if (free(s, 'v', t) && fits(t)) return t;
  }
  return freeIn(s, 'v', s.wm, s.wm + 6) ?? s.wm;
}

function suggestChange(s: StreamState): [number, string] {
  const u = randomInt(1, USERS);
  const now = (s.table[u] ?? '').toLowerCase();
  const choices = COUNTRIES.filter((c) => c !== now);
  return [u, choices[randomInt(0, choices.length - 1)]];
}

function suggestOrder(s: StreamState): number {
  const known = Object.keys(s.table).map(Number);
  return known.length && randomInt(0, 4) > 0 ? known[randomInt(0, known.length - 1)] : randomInt(1, USERS);
}

/** The keys and times the seed and the tour use. */
export const SEED: [string, ...(number | string)[]][] = [
  ['cdc', 3, 'fr'],
  ['cdc', 1, 'it'],
  ['stream_stream', 'i', 3, 1],
  ['stream_stream', 'i', 7, 2],
  ['stream_stream', 'i', 5, 4],
  ['stream_stream', 'i', 7, 5],
  ['window', 5],
  ['window', 6],
  ['stream_stream', 'c', 5, 6],
  ['expire', 7],
  ['window', 8],
  ['window', 12],
  ['stream_table', 1],
];

const def: StructureDef<StreamState> = {
  id: 'stream-joins',
  params: [
    { id: 'window', label: 'Join window', default: 3, options: [3, 5].map((v) => ({ value: v, label: `${v} ticks` })) },
    { id: 'lateness', label: 'Allowed lateness', default: 2, options: [0, 2].map((v) => ({ value: v, label: v ? `${v} ticks` : 'none' })) },
  ],
  create: (params) => create(params.window ?? 3, params.lateness ?? 2),
  // Profiles for two users, a few impressions, a joined click, views in two windows, and the watermark at 7.
  seed: SEED,
  ops: [
    {
      id: 'stream_stream',
      label: 'Impression or click',
      intent: 'primary',
      args: [SIDE_ARG, AD_ARG, { name: 'time', label: 'Event time', kind: 'int', min: 0, max: MAX_TIME }],
      code: ['stream_stream'],
      run: (s, [side, ad, t], rec) => void arrive(s, side, ad, t, rec),
      suggest: (s) => suggestEvent(s),
    },
    {
      id: 'late',
      label: 'Late event',
      args: [SIDE_ARG, AD_ARG, { name: 'behind', label: 'Ticks behind watermark', kind: 'int', min: 1, max: 6 }],
      code: ['stream_stream'],
      run: (s, [side, ad, b], rec) => void arrive(s, side, ad, s.wm - Number(b), rec, Number(b)),
      suggest: (s) => suggestLate(s),
    },
    {
      id: 'expire',
      label: 'Advance watermark',
      args: [{ name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 }],
      code: ['expire', 'close'],
      run: (s, [k], rec) => void advance(s, k, rec),
      suggest: (s) => [Math.max(1, Math.min(randomInt(1, 4), MAX_TIME - s.wm))],
    },
    {
      id: 'window',
      label: 'Page view (count)',
      args: [{ name: 'time', label: 'Event time', kind: 'int', min: 0, max: MAX_TIME }],
      code: ['window'],
      run: (s, [t], rec) => void view(s, t, rec),
      suggest: (s) => [suggestView(s)],
    },
    {
      id: 'cdc',
      label: 'Profile change',
      args: [USER_ARG, { name: 'country', label: 'Country (2 letters)', kind: 'word' }],
      code: ['cdc'],
      run: (s, [u, c], rec) => void change(s, u, c, rec),
      suggest: (s) => suggestChange(s),
    },
    {
      id: 'stream_table',
      label: 'Order (enrich)',
      args: [USER_ARG],
      code: ['stream_table'],
      run: (s, [u], rec) => void order(s, u, rec),
      suggest: (s) => [suggestOrder(s)],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'joined', label: 'Joined' },
    { key: 'expired', label: 'State dropped' },
    { key: 'late', label: 'Sent to side output' },
  ],
  status: (s) => [
    { label: 'Watermark', value: `${s.wm}, keeping state from ${keepFrom(s)}` },
    { label: 'State', value: `${entries(s, 'i')} impressions, ${entries(s, 'c')} clicks` },
    { label: 'Windows', value: `${s.windows.filter((w) => !w.fired).length} open, ${s.windows.filter((w) => w.fired).length} kept for late views` },
    { label: 'Profiles', value: String(Object.keys(s.table).length) },
  ],
  tour: [
    ['stream_stream', 'c', 7, 7],
    ['stream_stream', 'c', 3, 8],
    ['cdc', 3, 'de'],
    ['stream_table', 3],
    ['window', 9],
    ['expire', 5],
    ['late', 'c', 7, 3],
  ],
  source: { python, java },
  info,
};

export default def;
