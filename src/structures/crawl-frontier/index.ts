import { CAPTION_ROOM, LABEL_CHAR_W, LABEL_LINE, LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_H, cellsWidth } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/CrawlFrontier.java?raw';
import python from './code/crawl_frontier.py?raw';
import { info } from './info';

/**
 * The URL frontier of a web crawler, after Mercator (Heydon and Najork, 1999).
 *
 * It answers two questions at once: which URL matters most, and which host may
 * be contacted now. Front queues hold URLs by priority and know nothing about
 * hosts. Each back queue holds the URLs of exactly one host. A table maps a
 * host to its back queue, and a min-heap holds one entry per back queue: the
 * first tick at which its host may be contacted again. `next` only ever looks
 * at the root of that heap.
 *
 * URLs are written `a/1`, short for http://a.example/1. The clock counts
 * ticks and only moves when `tick` is called.
 */
export interface Url {
  uid: number;
  host: string;
  /** As drawn: host, a slash and a short path. */
  text: string;
  /** 0 high, 1 normal, 2 low. */
  priority: number;
}

export interface HeapEntry {
  /** First tick at which the queue's host may be contacted. */
  due: number;
  /** Index of the back queue. */
  q: number;
}

export interface FrontierState {
  clock: number;
  /** Ticks between two requests to one host. */
  delay: number;
  /** Three FIFO queues: high, normal, low. Index 0 of each is its head. */
  front: Url[][];
  /** FIFO queues, one host each. Index 0 is the head. */
  back: Url[][];
  /** The host each back queue serves, or null when it is idle. */
  host: (string | null)[];
  /** Host to the index of its back queue. */
  table: Map<string, number>;
  /** Host to the first tick it may be contacted again. Kept after the host gives up its queue. */
  ready: Map<string, number>;
  /** Binary min-heap by `due`, one entry per back queue that has a host. */
  heap: HeapEntry[];
  /** Host to the number of its URLs that are queued and not yet leased. */
  pending: Map<string, number>;
  /** The most recent leases, oldest first. Only these are drawn. */
  leased: { url: Url; at: number }[];
  /** Leases handed out since the frontier was made. */
  leases: number;
  frontCap: number;
  hostCap: number;
  nextUid: number;
  /** Last path number used for each host, so every new URL reads differently. */
  paths: Map<string, number>;
}

export const PRIORITIES = ['high', 'normal', 'low'] as const;
/** One fetcher is assumed, and Mercator suggests about three back queues for each. */
export const BACK = 3;
/** Slots drawn in every queue. */
export const SLOTS = 4;
/** Hosts the page draws: a stands for a.example, and so on. */
export const HOSTS = ['a', 'b', 'c', 'd', 'e'] as const;
export const DEFAULT_DELAY = 3;

export function create(delay = DEFAULT_DELAY, frontCap = SLOTS, hostCap = SLOTS, backQueues = BACK): FrontierState {
  return {
    clock: 0,
    delay,
    front: PRIORITIES.map(() => []),
    back: Array.from({ length: backQueues }, () => []),
    host: new Array<string | null>(backQueues).fill(null),
    table: new Map(),
    ready: new Map(),
    heap: [],
    pending: new Map(),
    leased: [],
    leases: 0,
    frontCap,
    hostCap,
    nextUid: 1,
    paths: new Map(),
  };
}

/** URLs waiting in the front queues. */
export const frontSize = (s: FrontierState): number => s.front.reduce((n, q) => n + q.length, 0);
/** URLs waiting anywhere: queued and not yet leased. */
export const waiting = (s: FrontierState): number => frontSize(s) + s.back.reduce((n, q) => n + q.length, 0);

const urlId = (u: Url) => `u${u.uid}`;
const heapId = (q: number) => `h${q}`;
const rowId = (host: string) => `row-${host}`;
const CLOCK = 'clock';
/** Back queues are named B1, B2, B3 on the page. */
const B = (q: number) => `B${q + 1}`;
const plural = (n: number, one: string, many = `${one}s`) => (n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`);

/** Carried through one operation: comparisons so far, and the URL being followed once it is known. */
interface Ctx {
  cmp: number;
  probe?: Probe;
}

// ---- the heap of back queues ------------------------------------------------

/** Add an entry at the end of the heap and swap it up while its parent is later. `via` is the line that made the call. */
function heapPush(s: FrontierState, due: number, q: number, rec: Rec, ctx: Ctx, via: string, lead: string): void {
  const heap = s.heap;
  heap.push({ due, q });
  rec.count('writes');
  let i = heap.length - 1;
  const probe = ctx.probe;
  rec.mark(heapId(q), 'ok');
  rec.line(via, 'push');
  rec.step(`${lead} ${i === 0 ? `It is the only entry, so it is the root.` : `The entry goes in at the end of the heap's array, index ${i}.`}`, { probe });
  while (i > 0) {
    const p = (i - 1) >> 1;
    const parent = heap[p];
    rec.mark(heapId(parent.q), 'compare');
    ctx.cmp++;
    if (due >= parent.due) {
      rec.line('compare_up', 'stop_up');
      rec.compare(`${B(q)}: t${due}`, '≥', `${B(parent.q)}: t${parent.due}`, `stays below`, {
        probe,
        message: `Its parent, ${B(parent.q)}, is due at tick ${parent.due}, which is no later than tick ${due}. Heap order holds, so ${B(q)} stays where it is.`,
      });
      rec.unmark(heapId(parent.q));
      break;
    }
    rec.line('compare_up');
    rec.compare(`${B(q)}: t${due}`, '<', `${B(parent.q)}: t${parent.due}`, `swap up`, {
      probe,
      message: `Its parent, ${B(parent.q)}, is due later, at tick ${parent.due}. A parent must never be later than its child, so they swap.`,
    });
    heap[i] = parent;
    heap[p] = { due, q };
    rec.count('writes');
    rec.mark(heapId(parent.q), 'path');
    rec.line('swap_up');
    rec.step(p === 0 ? `${B(q)} rises to the root: it is now the soonest queue of all.` : `${B(q)} rises to index ${p}.`, { probe });
    i = p;
  }
}

/** Remove the root. The last entry fills the hole and swaps down while a child is sooner. */
function heapPop(s: FrontierState, rec: Rec, ctx: Ctx, lead: string): void {
  const heap = s.heap;
  const last = heap.pop() as HeapEntry;
  rec.count('writes');
  const probe = ctx.probe;
  rec.line('pop', 'take_root');
  if (heap.length === 0) {
    rec.step(`${lead} It was the only entry, so the heap is empty for a moment.`, { probe });
    return;
  }
  heap[0] = last;
  rec.mark(heapId(last.q), 'path');
  rec.step(`${lead} The last entry in the heap's array, ${B(last.q)}, fills the hole at the root.`, { probe });
  const n = heap.length;
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    const r = c + 1;
    if (r < n) {
      const left = heap[c];
      const right = heap[r];
      rec.mark(heapId(left.q), 'compare');
      rec.mark(heapId(right.q), 'compare');
      ctx.cmp++;
      if (right.due < left.due) {
        rec.line('pick', 'pick_right');
        rec.compare(`${B(right.q)}: t${right.due}`, '<', `${B(left.q)}: t${left.due}`, `the right child is sooner`, {
          probe,
          message: `${B(last.q)} has two children. Find the sooner one first: the right child, ${B(right.q)}, at tick ${right.due}.`,
        });
        c = r;
      } else {
        rec.line('pick');
        rec.compare(`${B(right.q)}: t${right.due}`, '≥', `${B(left.q)}: t${left.due}`, `the left child is no later`, {
          probe,
          message: `${B(last.q)} has two children. Find the sooner one first: the left child, ${B(left.q)}, at tick ${left.due}.`,
        });
      }
      rec.unmark(heapId(left.q));
      rec.unmark(heapId(right.q));
    }
    const child = heap[c];
    rec.mark(heapId(child.q), 'compare');
    ctx.cmp++;
    if (last.due <= child.due) {
      rec.line('compare_down', 'stop_down');
      rec.compare(`${B(last.q)}: t${last.due}`, '≤', `${B(child.q)}: t${child.due}`, `heap order holds`, {
        probe,
        message: `${B(last.q)} is due at tick ${last.due} and its child ${B(child.q)} at tick ${child.due}, which is no sooner. ${B(last.q)} stays ${i === 0 ? 'at the root' : 'here'}.`,
      });
      rec.unmark(heapId(child.q));
      break;
    }
    rec.line('compare_down');
    rec.compare(`${B(last.q)}: t${last.due}`, '>', `${B(child.q)}: t${child.due}`, `swap down`, {
      probe,
      message: `${B(last.q)} is due at tick ${last.due}, later than its child ${B(child.q)} at tick ${child.due}. The sooner one must be on top, so they swap.`,
    });
    heap[i] = child;
    heap[c] = last;
    rec.count('writes');
    rec.mark(heapId(child.q), 'path');
    rec.line('swap_down');
    rec.step(i === 0 ? `${B(child.q)} rises to the root: it is the soonest queue left.` : `${B(child.q)} rises to index ${i}.`, { probe });
    i = c;
  }
  rec.unmark(heapId(last.q));
}

// ---- operations -------------------------------------------------------------

/**
 * Queue a URL for `host` at `priority` (0 high, 1 normal, 2 low). Returns the
 * URL, or null when the page's limits refuse it. `text` is for tests; left
 * out, the next short path for that host is used.
 */
export function add(s: FrontierState, host: string, priority: number, rec: Rec, text?: string): Url | null {
  const queue = s.front[priority];
  const name = PRIORITIES[priority];
  const held = s.pending.get(host) ?? 0;
  if (queue.length >= s.frontCap) {
    rec.line('check', 'full');
    rec.step(
      `Sorry, the ${name} front queue on this page holds at most ${s.frontCap} URLs and it is full, so nothing is added. Press Next to lease some, or choose another priority. A real frontier is bounded as well: when it is full, whatever is finding links has to slow down.`,
    );
    return null;
  }
  if (held >= s.hostCap) {
    rec.line('check', 'full');
    rec.step(
      `Sorry, host ${host} already has ${held} URLs waiting, the most this page draws for one host, so nothing is added. Press Next to lease some first. Real crawlers cap each host's share too, so that one huge site cannot crowd out the rest.`,
    );
    return null;
  }
  const path = ((s.paths.get(host) ?? 0) % 9) + 1;
  if (text === undefined) s.paths.set(host, path);
  const url: Url = { uid: s.nextUid++, host, text: text ?? `${host}/${path}`, priority };
  queue.push(url);
  s.pending.set(host, held + 1);
  rec.count('writes');
  const probe: Probe = { text: url.text, at: urlId(url) };
  rec.mark(urlId(url), 'key');
  rec.line('append');
  rec.step(
    `${url.text} has ${name} priority, so it joins the back of the ${name} front queue. Only the priority is read. Its host, ${host}, does not matter yet.`,
    { probe },
  );

  const ahead = s.front.slice(0, priority).reduce((n, q) => n + q.length, 0) + queue.length - 1;
  const owner = s.table.get(host);
  const idle = s.host.indexOf(null);
  rec.line('added');
  rec.step(
    `${url.text} is queued with 1 write and no comparisons: the table, the back queues and the heap were not touched. ` +
      (ahead === 0 ? `It is first in line. ` : `${plural(ahead, 'URL')} will be pulled before it. `) +
      (idle >= 0
        ? `${B(idle)} is idle, so the next call to Next pulls from the front queues.`
        : owner !== undefined
          ? `It waits until a back queue runs empty and pulls it across. The table will then send it to ${B(owner)}, the queue for host ${host}.`
          : `It waits until a back queue runs empty and pulls it across.`),
    { probe },
  );
  return url;
}

/**
 * Give back queue `q` a host: pull URLs from the front queues, highest
 * priority first. A URL whose host already has a back queue joins that queue.
 * The first URL whose host has none makes `q` that host's queue. Returns
 * false when the front queues ran dry first. `idle` is true for the pass at
 * the start of `next`, which stays quiet when there is nothing to pull.
 */
function refill(s: FrontierState, q: number, rec: Rec, ctx: Ctx, idle: boolean): boolean {
  /** The line in `next` that made the call. */
  const via = idle ? 'idle' : 'refill';
  const probe = ctx.probe;
  let pulls = 0;
  for (;;) {
    const p = s.front.findIndex((f) => f.length > 0);
    if (p < 0) {
      if (!idle || pulls > 0) {
        rec.line(via, 'pull', 'dry');
        rec.step(
          `All three front queues are empty, so ${B(q)} stays idle: it has no host and no entry in the heap. The next call to Next tries again.`,
          { probe },
        );
      }
      return false;
    }
    const url = s.front[p][0];
    const host = url.host;
    const owner = s.table.get(host);
    const from =
      p === 0
        ? `the high front queue has URLs, so take its head`
        : `${PRIORITIES.slice(0, p).join(' and ')} ${p === 1 ? 'is' : 'are'} empty, so take the head of ${PRIORITIES[p]}`;
    const pulled = pulls === 0 ? `${B(q)} needs a host. Pull from the front queues, highest priority first: ${from}, ${url.text}.` : `${B(q)} is still empty, so pull again: ${from}, ${url.text}.`;
    pulls++;
    rec.mark(urlId(url), 'compare');
    rec.markCell(rowId(host), 1, 'compare');
    ctx.cmp++;
    rec.line(via, 'pull', 'lookup');
    if (owner !== undefined) {
      rec.compare(`${url.text}: host ${host}`, '=', `${host} → ${B(owner)}`, `join ${B(owner)}`, {
        probe,
        message: `${pulled} Look its host up in the table: ${host} already has ${B(owner)}.`,
      });
      s.front[p].shift();
      s.back[owner].push(url);
      rec.count('writes');
      rec.mark(urlId(url), 'ok');
      rec.markCell(rowId(host), 1, 'idle');
      rec.line('route');
      rec.step(
        `${url.text} joins the back of ${B(owner)}. A host never has URLs in two back queues, and that is what keeps it to one request at a time.`,
        { probe },
      );
      rec.unmark(urlId(url));
      continue;
    }
    rec.compare(`${url.text}: host ${host}`, '≠', `any host with a queue`, `${B(q)} takes host ${host}`, {
      probe,
      message: `${pulled} Look its host up in the table: ${host} has no back queue.`,
    });
    s.front[p].shift();
    s.table.set(host, q);
    s.host[q] = host;
    s.back[q].push(url);
    rec.count('writes', 2);
    rec.mark(urlId(url), 'ok');
    rec.markCell(rowId(host), 1, 'ok');
    rec.line('claim');
    rec.step(`${B(q)} becomes the queue for host ${host}: write ${host} → ${B(q)} in the table and move ${url.text} across. Every later URL for ${host} will be sent here.`, {
      probe,
    });
    rec.unmark(urlId(url));
    rec.markCell(rowId(host), 1, 'idle');
    const known = s.ready.get(host);
    heapPush(
      s,
      known ?? s.clock,
      q,
      rec,
      ctx,
      'schedule',
      known === undefined
        ? `Host ${host} has not been contacted before, so it is allowed at once: ${B(q)} goes on the heap with the current tick, ${s.clock}.`
        : `Host ${host} has been contacted before and its row in the table says tick ${known}, so ${B(q)} goes on the heap with that time. Giving up a queue does not reset a host's delay.`,
    );
    rec.unmark(heapId(q));
    return true;
  }
}

/** Lease the next URL that is polite to fetch. Returns its text, or null when nothing is due or nothing is queued. */
export function next(s: FrontierState, rec: Rec): string | null {
  const ctx: Ctx = { cmp: 0 };
  const idle: number[] = [];
  s.host.forEach((h, q) => {
    if (h === null) idle.push(q);
  });
  if (idle.length && frontSize(s) > 0) {
    rec.line('idle');
    rec.step(
      `${idle.map(B).join(idle.length === 2 ? ' and ' : ', ')} ${idle.length === 1 ? 'has' : 'have'} no host. Before anything is leased, each idle back queue tries to take one from the front queues.`,
    );
  }
  for (const q of idle) refill(s, q, rec, ctx, true);
  rec.clearMarks();

  if (s.heap.length === 0) {
    rec.line('none');
    rec.step(`No back queue has a host, so the heap is empty and there is nothing to lease. Add a URL first.`);
    return null;
  }

  const root = s.heap[0];
  const q = root.q;
  const host = s.host[q] as string;
  const url = s.back[q][0];
  const probe: Probe = { text: url.text, at: urlId(url) };
  ctx.probe = probe;
  rec.mark(heapId(q), 'compare');
  rec.mark(urlId(url), 'key');
  rec.line('peek');
  rec.step(
    `The root of the heap is the back queue that may be contacted soonest: ${B(q)}, host ${host}, from tick ${root.due}. Its head, ${url.text}, is the only candidate. No other queue is looked at.`,
    { probe },
  );

  rec.mark(CLOCK, 'compare');
  ctx.cmp++;
  if (root.due > s.clock) {
    const wait = root.due - s.clock;
    rec.line('due', 'wait');
    rec.compare(`${B(q)}: t${root.due}`, '>', `clock: t${s.clock}`, `not due, wait ${plural(wait, 'tick')}`, {
      probe,
      message: `Host ${host} was contacted less than ${plural(s.delay, 'tick')} ago and may not be contacted again before tick ${root.due}. The clock says tick ${s.clock}.`,
    });
    rec.unmark(CLOCK);
    rec.mark(heapId(q), 'bad');
    rec.line('wait');
    rec.step(
      `Nothing is handed out. The root is the soonest entry, so every other host has at least as long to wait: 1 comparison settles it, however many hosts are queued. A fetcher thread would sleep for ${plural(wait, 'tick')} and ask again. On this page, press Tick.`,
      { probe },
    );
    return null;
  }
  rec.line('due');
  rec.compare(`${B(q)}: t${root.due}`, '≤', `clock: t${s.clock}`, `due, lease from ${B(q)}`, {
    probe,
    message: `${B(q)} is allowed from tick ${root.due} and the clock says tick ${s.clock}, so host ${host} may be contacted now.`,
  });
  rec.unmark(CLOCK);
  rec.unmark(heapId(q));

  heapPop(s, rec, ctx, `Take ${B(q)} off the heap: it is about to get a new time.`);

  s.back[q].shift();
  s.pending.set(host, (s.pending.get(host) ?? 1) - 1);
  s.leased.push({ url, at: s.clock });
  if (s.leased.length > SLOTS) s.leased.shift();
  s.leases++;
  rec.count('writes');
  rec.clearMarks();
  rec.mark(urlId(url), 'key');
  rec.line('lease');
  rec.step(`Hand ${url.text} to a fetcher as a lease. It leaves the head of ${B(q)}, which is first in, first out, like every queue here.`, { probe });

  const due = s.clock + s.delay;
  s.ready.set(host, due);
  rec.count('writes');
  rec.markCell(rowId(host), 2, 'ok');
  rec.line('ready');
  rec.step(
    `Write down when host ${host} may next be contacted: clock + delay = ${s.clock} + ${s.delay} = tick ${due}. This is the politeness rule. It is kept for each host, not for each URL.`,
    { probe },
  );
  rec.markCell(rowId(host), 2, 'idle');

  const left = s.back[q].length;
  if (left > 0) {
    heapPush(s, due, q, rec, ctx, 'again', `${B(q)} still holds ${plural(left, 'URL')} for host ${host}, so it goes back on the heap with time ${due}.`);
  } else {
    s.table.delete(host);
    s.host[q] = null;
    rec.count('writes');
    rec.mark(rowId(host), 'bad');
    rec.line('release');
    rec.step(
      `${B(q)} is now empty, so host ${host} gives it up. Its row in the table loses the queue but keeps the time, in case more URLs for ${host} turn up.`,
      { probe },
    );
    rec.unmark(rowId(host));
    refill(s, q, rec, ctx, false);
  }

  rec.clearMarks();
  rec.mark(urlId(url), 'key');
  const soonest = s.heap[0];
  rec.line('done');
  rec.step(
    `${url.text} is leased at tick ${s.clock} after ${plural(ctx.cmp, 'comparison')}. ` +
      (soonest === undefined
        ? `No back queue has a host now, so nothing is left to lease.`
        : soonest.due <= s.clock
          ? `Next in line is ${B(soonest.q)}, host ${s.host[soonest.q]}, which is already due.`
          : `Nothing else is due before tick ${soonest.due}.`),
    { probe },
  );
  return url.text;
}

/** Advance the clock. Nothing else changes: due times are only compared with the clock inside `next`. */
export function tick(s: FrontierState, ticks: number, rec: Rec): number {
  const before = s.clock;
  s.clock += ticks;
  rec.mark(CLOCK, 'ok');
  rec.line('tick');
  rec.step(
    `Time passes: the clock moves from tick ${before} to tick ${s.clock}. Nothing in the queues or the heap changes. The heap holds fixed times, and they are only compared with the clock when Next is called.`,
  );
  rec.clearMarks();
  const root = s.heap[0];
  rec.line('ticked');
  if (root === undefined) {
    rec.step(`The heap is empty, so there is nothing to wait for.`);
  } else if (root.due <= s.clock) {
    rec.mark(heapId(root.q), 'ok');
    rec.step(`The root of the heap, ${B(root.q)} for host ${s.host[root.q]}, is allowed from tick ${root.due}, so a URL is due. Press Next.`);
  } else {
    rec.step(`The root of the heap, ${B(root.q)} for host ${s.host[root.q]}, is not due until tick ${root.due}: ${plural(root.due - s.clock, 'more tick')} to wait.`);
  }
  rec.clearMarks();
  return s.clock;
}

// ---- layout ---------------------------------------------------------------

const SLOT_W = 44;
const PITCH = SLOT_W + 3;
/** Rows are far enough apart for the probe chip to sit above a URL without touching the row above. */
const ROW = CELL_H + PROBE_H + 16;
const LANE_GAP = 10;
/** Front queues start at x = 0. */
const FRONT_X = 0;
const FRONT_RIGHT = FRONT_X + (SLOTS - 1) * PITCH + SLOT_W / 2;
/** The widest label beside a back queue is "host a". */
const BACK_LABEL_W = 6 * LABEL_CHAR_W;
const BACK_X = FRONT_RIGHT + 30 + BACK_LABEL_W + LANE_GAP + SLOT_W / 2;
const BACK_RIGHT = BACK_X + (SLOTS - 1) * PITCH + SLOT_W / 2;
const LEASE_Y = BACK * ROW;
const TABLE_CELLS = [44, 48, 48];
const TABLE_W = cellsWidth(TABLE_CELLS.map((w) => ({ text: '', w })));
const TABLE_X = BACK_RIGHT + 34 + TABLE_W / 2;
const TABLE_PITCH = CELL_H + 8 + 6;
const HEAP_CELL = 40;
const HEAP_W = cellsWidth([{ text: '', w: HEAP_CELL }, { text: '', w: HEAP_CELL }]);
const HEAP_GAP = 14;
const HEAP_X = TABLE_X + TABLE_W / 2 + 34 + HEAP_W + HEAP_GAP / 2;
const HEAP_ROW = 80;
const HEAD_Y = -(CELL_H / 2 + PROBE_H + 16 + 12);
const LEFT = FRONT_X - SLOT_W / 2 - LANE_GAP - 6 * LABEL_CHAR_W;
const RIGHT = HEAP_X + HEAP_GAP / 2 + HEAP_W;
const BOTTOM = LEASE_Y + CELL_H / 2 + CAPTION_ROOM;

/** Heap index to its place: the root on top, its two children under it. */
function heapPlace(i: number): { x: number; y: number } {
  if (i === 0) return { x: HEAP_X, y: 0 };
  const depth = Math.floor(Math.log2(i + 1));
  const first = (1 << depth) - 1;
  const span = HEAP_W + HEAP_GAP;
  return { x: HEAP_X + (i - first - ((1 << depth) - 1) / 2) * span, y: depth * HEAP_ROW };
}

export function layout(s: FrontierState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  /** One tint per host, so a URL, its table row and its heap entry read as one group. */
  const hue = (host: string | null): number | undefined => {
    const i = HOSTS.indexOf(host as (typeof HOSTS)[number]);
    return i < 0 ? undefined : i;
  };
  const urlNode = (u: Url, x: number, y: number, caption?: string): SceneNode => ({
    id: urlId(u),
    x,
    y,
    cells: [{ text: u.text, w: SLOT_W }],
    hue: hue(u.host),
    caption,
  });
  const slot = (id: string, x: number, y: number): SceneNode => ({ id, x, y, cells: [{ text: '', w: SLOT_W }] });
  const decor: Decor[] = [
    { id: 'head-front', type: 'label', x: FRONT_X - SLOT_W / 2, y: HEAD_Y, text: 'Front queues', strong: true },
    { id: 'head-back', type: 'label', x: BACK_X - SLOT_W / 2, y: HEAD_Y, text: 'Back queues', strong: true },
    { id: 'head-table', type: 'label', x: TABLE_X - TABLE_W / 2, y: HEAD_Y, text: 'Host table', strong: true },
    { id: 'head-heap', type: 'label', x: HEAP_X - HEAP_GAP / 2 - HEAP_W, y: HEAD_Y, text: 'Heap, soonest on top', strong: true },
    // Two empty labels pin the corners, so the view holds still as heap entries and leases come and go.
    { id: 'corner-a', type: 'label', x: LEFT, y: HEAD_Y, text: '' },
    { id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' },
  ];

  // Front queues: one row per priority, head on the left.
  s.front.forEach((queue, p) => {
    const y = p * ROW;
    decor.push({ id: `lane-${p}`, type: 'label', x: FRONT_X - SLOT_W / 2 - LANE_GAP, y: y + 5, text: PRIORITIES[p], anchor: 'end' });
    for (let i = 0; i < Math.max(SLOTS, queue.length); i++) {
      if (i < queue.length) nodes.push(urlNode(queue[i], FRONT_X + i * PITCH, y));
      else nodes.push(slot(`f${p}.${i}`, FRONT_X + i * PITCH, y));
    }
  });

  // Back queues: one row per queue, one host each, head on the left.
  s.back.forEach((queue, q) => {
    const y = q * ROW;
    const h = s.host[q];
    decor.push({
      id: `back-${q}`,
      type: 'label',
      x: BACK_X - SLOT_W / 2 - LANE_GAP,
      y: y + 5 - LABEL_LINE / 2,
      text: `${B(q)}\n${h === null ? 'idle' : `host ${h}`}`,
      anchor: 'end',
    });
    for (let i = 0; i < Math.max(SLOTS, queue.length); i++) {
      if (i < queue.length) nodes.push(urlNode(queue[i], BACK_X + i * PITCH, y));
      else nodes.push(slot(`b${q}.${i}`, BACK_X + i * PITCH, y));
    }
  });

  // The latest leases, under the back queues they came from.
  decor.push({ id: 'lane-leased', type: 'label', x: BACK_X - SLOT_W / 2 - LANE_GAP, y: LEASE_Y + 5 - LABEL_LINE / 2, text: 'leased\nat tick', anchor: 'end' });
  for (let i = 0; i < SLOTS; i++) {
    const lease = s.leased[i];
    if (lease) nodes.push(urlNode(lease.url, BACK_X + i * PITCH, LEASE_Y, `t${lease.at}`));
    else nodes.push(slot(`l${i}`, BACK_X + i * PITCH, LEASE_Y));
  }

  // Host table: one row per host the page knows, with its back queue and the tick it is next allowed.
  HOSTS.forEach((host, r) => {
    const q = s.table.get(host);
    const ready = s.ready.get(host);
    const last = r === HOSTS.length - 1;
    nodes.push({
      id: rowId(host),
      x: TABLE_X,
      y: r * TABLE_PITCH,
      hue: hue(host),
      cells: [
        { text: host, w: TABLE_CELLS[0], sub: last ? 'host' : undefined },
        { text: q === undefined ? '' : B(q), w: TABLE_CELLS[1], sub: last ? 'queue' : undefined },
        { text: ready === undefined ? '' : `t${ready}`, w: TABLE_CELLS[2], sub: last ? 'ready' : undefined },
      ],
    });
  });

  // The heap: one entry per back queue that has a host, as the tree its array stands for.
  s.heap.forEach((e, i) => {
    const at = heapPlace(i);
    nodes.push({
      id: heapId(e.q),
      x: at.x,
      y: at.y,
      hue: hue(s.host[e.q]),
      cells: [
        { text: `t${e.due}`, w: HEAP_CELL },
        { text: B(e.q), w: HEAP_CELL },
      ],
    });
    if (i > 0) edges.push({ id: `he${i}`, from: heapId(s.heap[(i - 1) >> 1].q), to: heapId(e.q), kind: 'tree' });
  });

  nodes.push({
    id: CLOCK,
    x: HEAP_X,
    y: LEASE_Y,
    cells: [{ text: `t${s.clock}`, w: 56 }],
    title: 'clock',
    caption: `delay ${s.delay}`,
  });
  return { nodes, edges, decor };
}

// ---- definition -----------------------------------------------------------

const HOST = { name: 'host', label: 'Host (a to e)', kind: 'word' } as const;
const PRIORITY = { name: 'priority', label: 'Priority (1 high to 3 low)', kind: 'int', min: 1, max: 3 } as const;
const TICKS = { name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 } as const;

/** A host and a priority that the page will accept, when there is one. */
function roomFor(s: FrontierState): [string, number] {
  const hosts = HOSTS.filter((h) => (s.pending.get(h) ?? 0) < s.hostCap);
  const lanes = [0, 1, 2].filter((p) => s.front[p].length < s.frontCap);
  return [hosts.length ? pick(hosts) : pick(HOSTS), (lanes.length ? pick(lanes) : randomInt(0, 2)) + 1];
}

function runAdd(s: FrontierState, args: (number | string)[], rec: Rec): void {
  const host = String(args[0]).toLowerCase();
  const priority = Math.min(3, Math.max(1, Number(args[1]) || 2)) - 1;
  if (!HOSTS.includes(host as (typeof HOSTS)[number])) {
    rec.line('check');
    rec.step(`Sorry, this page draws five hosts, a to e, where a is short for a.example. "${host}" is not one of them, so nothing is added.`);
    return;
  }
  add(s, host, priority, rec);
}

const def: StructureDef<FrontierState> = {
  id: 'crawl-frontier',
  params: [
    {
      id: 'delay',
      label: 'Crawl delay',
      options: [
        { value: 2, label: '2 ticks' },
        { value: 3, label: '3 ticks' },
        { value: 5, label: '5 ticks' },
      ],
      default: DEFAULT_DELAY,
    },
  ],
  create: (params) => create(params.delay ?? DEFAULT_DELAY),
  // Eight URLs for three hosts, then two leases, so the page opens on a crawl in progress:
  // every back queue has a host, the heap is full, and b is due while c is still inside its delay.
  seed: [
    ['add', 'a', 1],
    ['add', 'a', 1],
    ['add', 'b', 1],
    ['add', 'b', 1],
    ['add', 'c', 2],
    ['add', 'a', 2],
    ['add', 'b', 2],
    ['add', 'c', 2],
    ['next'],
    ['tick', 1],
    ['next'],
    ['tick', 2],
  ],
  ops: [
    { id: 'add', label: 'Add URL', intent: 'primary', args: [HOST, PRIORITY], code: ['add'], run: runAdd, suggest: roomFor },
    { id: 'next', label: 'Next', args: [], code: ['next', 'refill', 'heap_pop', 'heap_push'], run: (s, _args, rec) => void next(s, rec) },
    {
      id: 'tick',
      label: 'Tick',
      args: [TICKS],
      code: ['tick'],
      run: (s, [n], rec) => void tick(s, Math.min(9, Math.max(1, Number(n) || 1)), rec),
      // Exactly as long as the soonest host still has to wait, so the next Next leases something.
      suggest: (s) => [s.heap.length && s.heap[0].due > s.clock ? Math.min(9, s.heap[0].due - s.clock) : 1],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Queue, table and heap writes' },
  ],
  status: (s) => {
    const root = s.heap[0];
    return [
      { label: 'Clock', value: `tick ${s.clock}` },
      { label: 'Waiting', value: plural(waiting(s), 'URL') },
      { label: 'Soonest', value: root === undefined ? 'nothing queued' : root.due <= s.clock ? `host ${s.host[root.q]}, due now` : `host ${s.host[root.q]}, at tick ${root.due}` },
      { label: 'Leased', value: String(s.leases) },
    ];
  },
  // Two adds at different priorities for two hosts; two leases that alternate between hosts b and a;
  // a third call that has to wait because only c is left and it is inside its delay; one tick;
  // then the lease that empties c's back queue and refills it from the front queues.
  tour: [['add', 'a', 1], ['add', 'd', 3], ['next'], ['next'], ['next'], ['tick', 1], ['next']],
  fill: (s) => ['add', ...roomFor(s)],
  source: { python, java },
  info,
};

export default def;
