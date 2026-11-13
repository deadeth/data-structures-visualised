import { CELL_GAP, CELL_H } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/Quickselect.java?raw';
import python from './code/quickselect.py?raw';

/**
 * Two ways to find the k-th smallest item, or the k largest, without sorting.
 *
 * Quickselect partitions the array in place around a pivot (Lomuto: the last
 * item of the range) and then keeps only the side that holds index k - 1.
 * Top k reads the array once, left to right, as a stream, and keeps a
 * min-heap of at most k items whose root is the one to beat.
 *
 * Every item carries a unique id so that the same item slides to its new
 * place, and so that equal values stay separate items.
 */
export interface Item {
  uid: number;
  v: number;
}

export interface QState {
  items: Item[];
  k: number;
  nextUid: number;
  /** What the canvas is showing: a plain array, a quickselect, or a top-k run. */
  mode: 'idle' | 'select' | 'heap';
  // Quickselect.
  lo: number;
  hi: number;
  /** True while a partition is under way: i and j are shown and the parts are shaded. */
  part: boolean;
  i: number;
  j: number;
  /** Items a partition has put in their final sorted place. */
  placed: Record<number, true>;
  /** The uid of the answer, once found. */
  answer: number;
  // Top k.
  heap: Item[];
  /** Items read and not kept, by uid. */
  out: Record<number, true>;
  done: boolean;
  /** Last result, for the status line. */
  result: string;
}

/** Most items on the canvas. Longer inputs only ever run with recording off. */
export const MAX = 12;
/** Items loaded by the load operations. */
export const LOAD_N = 10;

export function create(): QState {
  return {
    items: [],
    k: 4,
    nextUid: 1,
    mode: 'idle',
    lo: 0,
    hi: -1,
    part: false,
    i: -1,
    j: -1,
    placed: {},
    answer: -1,
    heap: [],
    out: {},
    done: false,
    result: 'none yet',
  };
}

export const values = (s: QState): number[] => s.items.map((it) => it.v);

const nid = (it: Item) => `n${it.uid}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Back to a plain array: no tags, no shading, no heap. */
function reset(s: QState): void {
  s.mode = 'idle';
  s.lo = 0;
  s.hi = -1;
  s.part = false;
  s.i = -1;
  s.j = -1;
  s.placed = {};
  s.answer = -1;
  s.heap = [];
  s.out = {};
  s.done = false;
}

// ---- inputs ---------------------------------------------------------------

/** Replace the array. Used by the loads and by tests; any length works with recording off. */
export function setArray(s: QState, vals: number[]): void {
  reset(s);
  s.items = vals.map((v) => ({ uid: s.nextUid++, v }));
}

function loaded(s: QState, rec: Rec, what: string): void {
  rec.vars({ a: s.items.map((it) => it.v), k: s.k });
  rec.line('input');
  const kNote = s.k > s.items.length ? ` k is ${s.k}, more than there are items: set k again.` : ` k is ${s.k}.`;
  rec.step(`${what}${kNote}`);
}

/** Set the array from typed numbers, "5 2 9 1". The page caps it at MAX items. */
export function setFromText(s: QState, text: string, rec: Rec): boolean {
  const vals = String(text)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((v) => Number.isInteger(v) && v >= 0 && v <= 999);
  rec.vars();
  if (vals.length === 0) {
    rec.line('input');
    rec.step(`No whole numbers from 0 to 999 there, so the array is unchanged.`);
    return false;
  }
  const cut = vals.length > MAX ? ` Only the first ${MAX} are kept, so that every cell stays readable.` : '';
  setArray(s, vals.slice(0, MAX));
  loaded(s, rec, `The array is now ${s.items.map((it) => it.v).join(', ')}.${cut}`);
  return true;
}

/** Inputs worth typing: a mixed one, a descending one, and one with many ties. */
export const EXAMPLES = ['62 15 88 41 7 93 29 70 54 47', '90 80 70 60 50 40 30 20 10', '30 10 30 30 50 30 30 20 30 30'];

export function setK(s: QState, k: number, rec: Rec): boolean {
  reset(s);
  const n = s.items.length;
  rec.vars({ k, 'len(a)': n });
  if (k < 1 || (n > 0 && k > n)) {
    rec.line('input', 'bad_k');
    rec.step(`k must be from 1 to the number of items, ${n}. It stays at ${s.k}.`);
    return false;
  }
  s.k = k;
  rec.line('input');
  rec.step(`k is now ${k}: quickselect will find the ${ordinal(k)} smallest, and top k will keep the ${k} largest.`);
  return true;
}

function distinct(count: number, rnd: () => number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  while (out.length < count) {
    const v = randomInt(1, 99, rnd);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function loadRandom(s: QState, rec: Rec, rnd: () => number = Math.random): void {
  setArray(s, distinct(LOAD_N, rnd));
  loaded(s, rec, `Loaded ${LOAD_N} different numbers in random order. A pivot from random input usually lands somewhere near the middle.`);
}

export function loadSorted(s: QState, rec: Rec, rnd: () => number = Math.random): void {
  setArray(s, distinct(LOAD_N, rnd).sort((a, b) => a - b));
  loaded(s, rec, `Loaded ${LOAD_N} numbers already in ascending order. With the last item as pivot, every pivot is the largest item left.`);
}

export function loadEqual(s: QState, rec: Rec, rnd: () => number = Math.random): void {
  const common = randomInt(40, 60, rnd);
  const vals = Array.from({ length: LOAD_N }, () => (rnd() < 0.7 ? common : randomInt(1, 99, rnd)));
  setArray(s, vals);
  loaded(s, rec, `Loaded ${LOAD_N} numbers, most of them ${common}. Equal items never go to the smaller side of a pivot, which this partition handles badly.`);
}

// ---- quickselect ----------------------------------------------------------

/** The k-th smallest by quickselect. Reorders the array. Returns undefined if k does not fit. */
export function kthSmallest(s: QState, rec: Rec): number | undefined {
  reset(s);
  const n = s.items.length;
  const k = s.k;
  rec.vars({ k, 'len(a)': n });
  rec.line('bad_k');
  if (n === 0) {
    rec.step(`There is nothing to search: the array is empty. Set the array or load an input first.`);
    return undefined;
  }
  if (k > n) {
    rec.step(`k is ${k}, but the array holds only ${plural(n, 'item')}, so there is no ${ordinal(k)} smallest. Set k again.`);
    return undefined;
  }
  const a = s.items;
  const t = k - 1;
  s.mode = 'select';
  s.lo = 0;
  s.hi = n - 1;
  // kth_smallest's variables; p is set once the first partition returns.
  let p: number | undefined;
  const showK = () => rec.vars({ k, target: t, lo: s.lo, hi: s.hi, p });
  showK();
  rec.line('start');
  rec.step(
    `Find the ${ordinal(k)} smallest. Once sorted it would sit at index ${t}, so the k tag marks index ${t}. Quickselect never sorts: it only has to get the right item into that one place.`,
  );

  let comparisons = 0;
  let rounds = 0;
  let worstRounds = 0;
  let firstDrop = 0;
  while (s.lo < s.hi) {
    rounds++;
    const lo = s.lo;
    const hi = s.hi;
    const pivot = a[hi];
    const pv = pivot.v;
    const probe: Probe = { text: String(pv), at: nid(pivot) };
    s.part = true;
    s.i = lo;
    s.j = lo;
    // partition's variables, while it runs.
    const showP = (j?: number) => rec.vars({ lo, hi, pivot: pv, i: s.i, j, 'a[j]': j === undefined ? undefined : a[j].v });
    showP();
    rec.line('loop', 'call', 'pivot');
    rec.step(
      rounds === 1
        ? `Partition index ${lo} to ${hi} around the last item, ${pv}, the same step Quicksort uses. j walks left to right; each item smaller than the pivot is swapped down to i, so everything left of i is smaller.`
        : `Partition what is left, index ${lo} to ${hi}, around its last item, ${pv}.`,
      { probe },
    );
    for (let j = lo; j < hi; j++) {
      s.j = j;
      const x = a[j];
      rec.mark(nid(x), 'compare');
      comparisons++;
      showP(j);
      rec.line('scan', 'compare');
      if (x.v < pv) {
        const i = s.i;
        if (i === j) {
          rec.compare(pv, '>', x.v, `smaller, and already at i, so i moves on`, { probe });
        } else {
          rec.compare(pv, '>', x.v, `smaller, so swap it down to i`, { probe });
        }
        rec.unmark(nid(x));
        if (i !== j) {
          const y = a[i];
          a[i] = x;
          a[j] = y;
          rec.count('writes', 2);
          s.i = i + 1;
          showP(j);
          rec.line('swap');
          rec.step(`Swap ${x.v} and ${y.v}: ${x.v} joins the smaller part at index ${i}, and i moves on to ${i + 1}.`, { probe });
        } else {
          s.i = i + 1;
        }
      } else {
        rec.compare(pv, '≤', x.v, `not smaller, so it stays right of i`, { probe });
        rec.unmark(nid(x));
      }
    }
    // The pivot goes between the two parts.
    p = s.i;
    const y = a[p];
    a[p] = pivot;
    a[hi] = y;
    rec.count('writes', 2);
    s.j = hi + 1;
    s.placed[pivot.uid] = true;
    showP();
    rec.line('place');
    const sides =
      p === lo
        ? `Nothing was smaller, so it lands at the left end, index ${p}.`
        : p === hi
          ? `Everything was smaller, so it stays at the right end, index ${p}.`
          : `Everything left of it is smaller and nothing right of it is.`;
    rec.step(
      p === hi
        ? `${sides} ${pv} is in its final sorted place.`
        : `Swap the pivot, ${pv}, into index ${p}. ${sides} So ${pv} is in its final sorted place, though neither side is sorted.`,
      { probe },
    );

    if (p === t) {
      s.part = false;
      s.answer = pivot.uid;
      s.lo = p;
      s.hi = p;
      showK();
      rec.line('check', 'found');
      rec.step(
        `The pivot landed on the k tag, index ${t}, so ${pv} is the ${ordinal(k)} smallest. Stop: neither side needs any more work.`,
        { probe },
      );
      return finish(s, rec, pivot, true, comparisons, rounds, worstRounds, firstDrop);
    }
    let dropped: number;
    let msg: string;
    if (t < p) {
      dropped = hi - p + 1;
      s.hi = p - 1;
      rec.line('check', 'go_left');
      msg = `The k tag, index ${t}, is left of ${p}, so the answer is among the ${plural(p - lo, 'smaller item')}. Drop index ${p} to ${hi}`;
    } else {
      dropped = p - lo + 1;
      s.lo = p + 1;
      rec.line('check', 'go_right');
      msg = `The k tag, index ${t}, is right of ${p}, so the answer is among the ${plural(hi - p, 'larger item')}. Drop index ${lo} to ${p}`;
    }
    if (rounds === 1) firstDrop = dropped;
    if (dropped === 1) worstRounds++;
    s.part = false;
    s.i = -1;
    s.j = -1;
    showK();
    msg +=
      dropped === 1
        ? `: only the pivot itself. That is the bad case, a whole pass over the range to rule out one item.`
        : `: ${plural(dropped, 'item')} never looked at again.`;
    rec.step(msg, { probe });
  }

  // One item left in the range: it is already in its place.
  const last = a[s.lo];
  s.answer = last.uid;
  if (rec.recording) rec.vars({ k, target: t, lo: s.lo, hi: s.hi, p, 'a[lo]': last.v });
  rec.line('last');
  rec.step(
    rounds === 0
      ? `There is only one item, so it is the 1st smallest. Nothing to compare.`
      : `Only index ${s.lo} is left in the range. Every item left of it is no larger and every item right of it is no smaller, so ${last.v} is the ${ordinal(k)} smallest, with no comparison needed.`,
    {
    probe: { text: String(last.v), at: nid(last) },
  });
  return finish(s, rec, last, false, comparisons, rounds, worstRounds, firstDrop);
}

function finish(s: QState, rec: Rec, ans: Item, found: boolean, comparisons: number, rounds: number, worstRounds: number, firstDrop: number): number {
  const n = s.items.length;
  s.result = `${ordinal(s.k)} smallest is ${ans.v}`;
  rec.clearMarks();
  rec.line(found ? 'found' : 'last');
  const sortCost = Math.round(n * Math.log2(Math.max(2, n)));
  let how: string;
  if (rounds > 1 && worstRounds === rounds - (found ? 1 : 0) && worstRounds >= 2) {
    how = `Every pivot was the largest or smallest item left, so each pass dropped one item: ${plural(comparisons, 'comparison')}, about n²/2. Real code picks the pivot at random, which makes this run very unlikely.`;
  } else if (rounds === 0) {
    how = `There was only one item, so no comparisons.`;
  } else {
    how = `${plural(comparisons, 'comparison')} for ${plural(n, 'item')}; the first pass alone dropped ${firstDrop}. Sorting first would cost about n log₂ n, ${sortCost} here.`;
  }
  rec.step(`The ${ordinal(s.k)} smallest is ${ans.v}. ${how} Quickselect needs the whole array in memory and leaves it reordered.`, {
    probe: { text: String(ans.v), at: nid(ans) },
  });
  return ans.v;
}

// ---- top k with a min-heap ------------------------------------------------

/** The k largest, by reading the array once with a min-heap of at most k items. Returns them in heap order. */
export function topK(s: QState, rec: Rec): number[] {
  reset(s);
  const n = s.items.length;
  const k = s.k;
  s.mode = 'heap';
  const h = s.heap;
  rec.vars({ k, heap: [] });
  rec.line('input', 'begin');
  if (n === 0) {
    s.done = true;
    rec.step(`The input is empty, so the heap stays empty. Set the array or load an input first.`);
    s.result = 'nothing to keep';
    return [];
  }
  rec.step(
    `Find the ${k} largest by reading the input once, left to right, as if it were a stream. Keep a min-heap of at most ${k} items: its root is the smallest of the best ${k} so far, the one a new item must beat.`,
  );

  let comparisons = 0;
  let kept = 0;
  let skipped = 0;
  for (const x of s.items) {
    const probe: Probe = { text: String(x.v), at: nid(x) };
    if (h.length < k) {
      h.push(x);
      if (rec.recording) rec.vars({ k, x: x.v, heap: h.map((it) => it.v) });
      rec.count('writes');
      rec.mark(nid(x), 'key');
      rec.line('read', 'push');
      rec.step(
        h.length === 1
          ? `Read ${x.v}. The heap is not full yet, so ${x.v} goes straight in at index 0.`
          : `Read ${x.v}. The heap holds ${h.length - 1} of ${k}, so ${x.v} goes in at index ${h.length - 1} and sifts up, as on the Binary heap page.`,
        { probe },
      );
      comparisons += siftUp(s, h.length - 1, rec, probe);
      rec.unmark(nid(x));
      continue;
    }
    const root = h[0];
    if (rec.recording) rec.vars({ k, x: x.v, heap: h.map((it) => it.v), 'heap[0]': root.v });
    rec.mark(nid(x), 'key');
    rec.mark(nid(root), 'compare');
    comparisons++;
    rec.line('read', 'beat');
    if (x.v > root.v) {
      rec.compare(x.v, '>', root.v, `larger than the root, so ${root.v} leaves the heap`, {
        probe,
        message: `Read ${x.v}. The heap is full, so compare it with the root, ${root.v}: the smallest of the best ${k} so far. ${x.v} is larger, so it takes the root's place.`,
      });
      h[0] = x;
      if (rec.recording) rec.vars({ k, x: x.v, heap: h.map((it) => it.v), 'heap[0]': x.v });
      s.out[root.uid] = true;
      rec.count('writes');
      kept++;
      rec.mark(nid(root), 'bad');
      rec.line('replace');
      rec.step(`${x.v} replaces ${root.v} at the root. ${root.v} is out for good: ${k} items at least as large have now been seen. ${x.v} may be too large for the root, so it sifts down.`, {
        probe,
      });
      rec.unmark(nid(root));
      comparisons += siftDown(s, rec, probe);
      rec.unmark(nid(x));
    } else {
      rec.compare(x.v, '≤', root.v, `not larger than the root, so skip it`, {
        probe,
        message: `Read ${x.v}. The heap is full, so compare it with the root, ${root.v}. ${x.v} is no larger, so it cannot be in the top ${k}: skip it. One comparison, nothing written.`,
      });
      s.out[x.uid] = true;
      skipped++;
      rec.unmark(nid(x));
      rec.unmark(nid(root));
    }
  }

  s.done = true;
  rec.clearMarks();
  const got = h.map((it) => it.v);
  rec.vars({ k, heap: got });
  s.result = `top ${h.length}: ${got.join(', ')}`;
  rec.line('done');
  const fewer = h.length < k ? ` The input had fewer than ${k} items, so all of them are kept.` : '';
  const counts =
    h.length < k
      ? ''
      : skipped === 0
        ? ` Every later item beat the root, so none was skipped: rising input is this method's slowest case.`
        : ` ${plural(kept, 'later item')} replaced the root; ${skipped} cost one comparison each and were skipped.`;
  rec.step(
    `The ${h.length} largest are ${got.join(', ')}, in heap order, not sorted.${fewer}${counts} ${plural(comparisons, 'comparison')} in all, O(n log k), with only ${k} items held at a time and the input left as it was. That is why it suits a stream.`,
  );
  return got;
}

function swapHeap(s: QState, a: number, b: number): void {
  const t = s.heap[a];
  s.heap[a] = s.heap[b];
  s.heap[b] = t;
}

/** Sift the item at heap index i upwards. Returns the number of comparisons. */
function siftUp(s: QState, i: number, rec: Rec, probe: Probe): number {
  const h = s.heap;
  const x = h[i];
  let c = 0;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const parent = h[p];
    if (rec.recording) rec.vars({ h: h.map((it) => it.v), i, p, 'h[i]': x.v, 'h[p]': parent.v });
    rec.mark(nid(parent), 'compare');
    c++;
    if (x.v >= parent.v) {
      rec.line('up_compare', 'up_stop');
      rec.compare(x.v, '≥', parent.v, `not smaller than its parent at index ${p}, so stop`, { probe });
      rec.unmark(nid(parent));
      return c;
    }
    rec.line('up_compare');
    rec.compare(x.v, '<', parent.v, `smaller than its parent at index ${p}, so swap up`, { probe });
    swapHeap(s, i, p);
    // i = p is on the same lit line, so the strip shows i after it.
    if (rec.recording) rec.vars({ h: h.map((it) => it.v), i: p, p, 'h[i]': x.v, 'h[p]': x.v });
    rec.count('writes', 2);
    rec.unmark(nid(parent));
    rec.line('up_swap');
    rec.step(`Swap: ${x.v} rises to index ${p} and ${parent.v} drops to index ${i}.`, { probe });
    i = p;
  }
  return c;
}

/** Sift the root downwards. Returns the number of comparisons. */
function siftDown(s: QState, rec: Rec, probe: Probe): number {
  const h = s.heap;
  const n = h.length;
  const x = h[0];
  let i = 0;
  let count = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) return count;
    const both = c + 1 < n;
    if (both) {
      const l = h[c];
      const r = h[c + 1];
      rec.mark(nid(l), 'compare');
      rec.mark(nid(r), 'compare');
      count++;
      // c += 1 is on the lit line when the right child wins, so show c after it.
      if (rec.recording) rec.vars({ h: h.map((it) => it.v), i, c: r.v < l.v ? c + 1 : c, 'h[i]': x.v, 'h[c]': (r.v < l.v ? r : l).v });
      rec.line('down_child', 'down_pick');
      if (r.v < l.v) {
        rec.compare(l.v, '>', r.v, `the right child, ${r.v}, is the smaller`, { probe });
        c++;
      } else if (r.v === l.v) {
        rec.compare(l.v, '=', r.v, `a tie, so take the left child`, { probe });
      } else {
        rec.compare(l.v, '<', r.v, `the left child, ${l.v}, is the smaller`, { probe });
      }
      rec.unmark(nid(c === 2 * i + 1 ? r : l));
    } else {
      rec.mark(nid(h[c]), 'compare');
    }
    const child = h[c];
    if (rec.recording) rec.vars({ h: h.map((it) => it.v), i, c, 'h[i]': x.v, 'h[c]': child.v });
    count++;
    const lines = both ? ['down_compare'] : ['down_child', 'down_compare'];
    if (x.v <= child.v) {
      rec.line(...lines, 'down_stop');
      rec.compare(x.v, '≤', child.v, `no larger than its smaller child, so stop`, { probe });
      rec.unmark(nid(child));
      return count;
    }
    rec.line(...lines);
    rec.compare(x.v, '>', child.v, `larger than its smaller child, so swap down`, { probe });
    swapHeap(s, i, c);
    if (rec.recording) rec.vars({ h: h.map((it) => it.v), i: c, c, 'h[i]': x.v, 'h[c]': x.v });
    rec.count('writes', 2);
    rec.unmark(nid(child));
    rec.line('down_swap');
    rec.step(`Swap: ${child.v} rises to index ${i} and ${x.v} drops to index ${c}.`, { probe });
    i = c;
  }
}

// ---- layout ---------------------------------------------------------------

const CELL_W = 44;
const PITCH = CELL_W + CELL_GAP;
const sx = (i: number) => i * PITCH;
/** Index labels under a row of cells. */
const SUB_DY = CELL_H / 2 + 13;
/** Tag rows under the array: i and j, then lo and hi, then k. */
const ROW_IJ = 64;
const ROW_LOHI = 96;
const ROW_K = 128;
/** The heap row, far enough below the input for the probe chip to fit between them. */
const HEAP_Y = 116;

function tag(nodes: SceneNode[], id: string, text: string, x: number, y: number): void {
  nodes.push({ id, x, y, shape: 'tag', cells: [{ text }] });
}

/** Two tags that may point at the same index: side by side when they do. */
function pair(nodes: SceneNode[], a: { id: string; text: string; at: number }, b: { id: string; text: string; at: number }, y: number): void {
  const same = a.at === b.at;
  tag(nodes, a.id, a.text, sx(a.at) - (same ? 23 : 0), y);
  tag(nodes, b.id, b.text, sx(b.at) + (same ? 23 : 0), y);
}

export function layout(s: QState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const n = Math.min(s.items.length, MAX);

  if (n === 0) {
    nodes.push({ id: 'empty', x: 0, y: 0, tone: 'dim', cells: [{ text: '', w: CELL_W }] });
    decor.push({ id: 'empty-note', type: 'label', x: CELL_W / 2 + 12, y: 5, text: 'The array is empty.' });
    return { nodes, edges: [], decor };
  }

  if (s.mode === 'heap') {
    const inHeap = new Map<number, number>();
    s.heap.forEach((it, h) => inHeap.set(it.uid, h));
    for (let i = 0; i < n; i++) {
      const it = s.items[i];
      const h = inHeap.get(it.uid);
      if (h != null) {
        nodes.push({ id: `slot${i}`, x: sx(i), y: 0, cells: [{ text: '', w: CELL_W }] });
        nodes.push({ id: nid(it), x: sx(h), y: HEAP_Y, tone: s.done ? 'ok' : undefined, cells: [{ text: String(it.v), w: CELL_W }] });
      } else {
        nodes.push({ id: nid(it), x: sx(i), y: 0, tone: s.out[it.uid] ? 'dim' : undefined, cells: [{ text: String(it.v), w: CELL_W }] });
      }
      decor.push({ id: `ix${i}`, type: 'label', x: sx(i), y: SUB_DY, text: String(i), anchor: 'middle' });
    }
    for (let h = 0; h < s.k && h < MAX; h++) {
      if (h >= s.heap.length) nodes.push({ id: `hslot${h}`, x: sx(h), y: HEAP_Y, cells: [{ text: '', w: CELL_W }] });
      decor.push({ id: `hx${h}`, type: 'label', x: sx(h), y: HEAP_Y + SUB_DY, text: String(h), anchor: 'middle' });
    }
    decor.push({ id: 'row-in', type: 'label', x: -CELL_W / 2 - 12, y: 5, text: 'Input', anchor: 'end', strong: true });
    decor.push({ id: 'row-heap', type: 'label', x: -CELL_W / 2 - 12, y: HEAP_Y - 4, text: `Heap\nof ${s.k}`, anchor: 'end', strong: true });
    return { nodes, edges: [], decor };
  }

  const sel = s.mode === 'select';
  for (let i = 0; i < n; i++) {
    const it = s.items[i];
    let tone: Tone | undefined;
    let hue: number | undefined;
    if (sel) {
      if (s.placed[it.uid] || s.answer === it.uid) tone = 'ok';
      else if (i < s.lo || i > s.hi) tone = 'dim';
      else if (s.part) {
        if (i === s.hi) tone = 'key';
        else if (i < s.i) hue = 2;
        else if (i < s.j) tone = 'path';
      }
    }
    nodes.push({ id: nid(it), x: sx(i), y: 0, tone, hue, cells: [{ text: String(it.v), w: CELL_W }] });
    decor.push({ id: `ix${i}`, type: 'label', x: sx(i), y: SUB_DY, text: String(i), anchor: 'middle' });
  }
  if (sel) {
    const t = s.k - 1;
    if (s.part && s.j <= s.hi) pair(nodes, { id: 'tag-i', text: 'i', at: s.i }, { id: 'tag-j', text: 'j', at: s.j }, ROW_IJ);
    if (s.answer < 0) pair(nodes, { id: 'tag-lo', text: 'lo', at: s.lo }, { id: 'tag-hi', text: 'hi', at: s.hi }, ROW_LOHI);
    tag(nodes, 'tag-k', `k = ${s.k}`, sx(t), s.answer < 0 ? ROW_K : ROW_LOHI);
  }
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

const SEED = [62, 15, 88, 41, 7, 93, 29, 70, 54, 47];

const def: StructureDef<QState> = {
  id: 'quickselect',
  create: () => create(),
  seed: [['set', SEED.join(' ')], ['setK', 4]],
  ops: [
    {
      id: 'kth',
      label: 'K-th smallest (quickselect)',
      intent: 'primary',
      args: [],
      code: ['quickselect', 'partition'],
      run: (s, _a, rec) => void kthSmallest(s, rec),
    },
    {
      id: 'topk',
      label: 'Top k (heap)',
      intent: 'primary',
      args: [],
      code: ['top_k', 'sift_down', 'sift_up'],
      run: (s, _a, rec) => void topK(s, rec),
    },
    {
      id: 'setK',
      label: 'Set k',
      args: [{ name: 'k', label: 'k', kind: 'int', min: 1, max: MAX }],
      code: ['quickselect', 'top_k'],
      run: (s, [k], rec) => void setK(s, Number(k), rec),
      suggest: (s) => [randomInt(1, Math.max(1, s.items.length))],
    },
    {
      id: 'set',
      label: 'Set the array',
      args: [{ name: 'values', label: 'Numbers', kind: 'ints', min: 0, max: 999, maxItems: MAX }],
      code: ['quickselect', 'top_k'],
      run: (s, [v], rec) => void setFromText(s, String(v), rec),
      suggest: () => [pick(EXAMPLES)],
    },
    { id: 'random', label: 'Load random', args: [], code: ['quickselect', 'top_k'], run: (s, _a, rec) => loadRandom(s, rec) },
    { id: 'sorted', label: 'Load sorted', args: [], code: ['quickselect', 'top_k'], run: (s, _a, rec) => loadSorted(s, rec) },
    { id: 'equal', label: 'Load many equal', args: [], code: ['quickselect', 'top_k'], run: (s, _a, rec) => loadEqual(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Writes' },
  ],
  status: (s) => [
    { label: 'Items', value: `${s.items.length} of ${MAX}` },
    { label: 'k', value: String(s.k) },
    { label: 'Last result', value: s.result },
  ],
  tour: [['topk'], ['kth'], ['sorted'], ['kth']],
  source: { python, java },
  info: {
    summary:
      'Two ways to answer "what is the k-th smallest?" or "which are the k largest?" without sorting everything. Quickselect partitions the array around a pivot, as Quicksort does, then carries on only into the side that holds position k. A min-heap of k items reads the input once, keeping the best k seen so far.',
    watch: [
      'The k tag marks the index the answer would have once sorted. After each partition the pivot is in its final place, and the side without the k tag goes grey: it is never looked at again.',
      'In a partition, j walks right and compares each item with the pivot. Smaller items are swapped down to i, so the shaded cells left of i are smaller and the blue ones between i and j are not.',
      'On sorted input the last item is always the largest left, so each pass rules out only the pivot. Watch the comparisons climb.',
      'In top k, an item only enters a full heap if it beats the root. Most items late in a long random stream cost one comparison and are skipped.',
      'Simplified: the pivot is always the last item in the range, so the bad case is easy to show. Real code picks it at random.',
    ],
    complexity: [
      { op: 'Quickselect, k-th smallest', average: 'O(n)', worst: 'O(n²)', note: 'A good pivot halves the range: n + n/2 + n/4 + ... is under 2n. A pivot that is always the largest drops one item per pass: n + (n-1) + ... is about n²/2.' },
      { op: 'Top k with a min-heap', average: 'O(n log k)', worst: 'O(n log k)', note: 'Each item costs one comparison with the root, plus a sift of up to log₂ k levels if it gets in.' },
      { op: 'Sort, then read index k - 1', average: 'O(n log n)', worst: 'O(n log n)', note: 'Simple, and worth it if you will ask for many different k.' },
      { op: 'Median of medians', average: 'O(n)', worst: 'O(n)', note: 'Picks a pivot that is guaranteed to drop a fixed share of the range. Slower in practice; mostly a fallback.' },
    ],
    space: 'Quickselect: O(1) extra, as a loop with no recursion, but it reorders the input. Heap: O(k), and the input is read once and left alone.',
    usedIn: [
      { name: 'C++ std::nth_element', how: 'Puts the k-th item in its sorted place with smaller items before it and larger after, in linear time on average. Common implementations use introselect: quickselect that falls back to a guaranteed method if it recurses too deep.' },
      { name: 'NumPy partition', how: 'numpy.partition and argpartition use introselect by default. A common way to take the k smallest of a large array, or a median, without a full sort.' },
      { name: 'Python heapq.nlargest', how: 'Keeps a heap of k items while it reads the iterable, the method on this page, so memory stays at k.' },
      { name: 'PostgreSQL ORDER BY ... LIMIT', how: 'With a small limit, EXPLAIN ANALYZE can show "top-N heapsort": a bounded heap of the rows wanted rather than a sort of every row.' },
      { name: 'Leaderboards and "top queries" jobs', how: 'Each worker keeps a heap of its own top k; a coordinator merges the workers\' lists. Each worker\'s memory is k, not the number of distinct keys.' },
    ],
    reachFor: [
      'Quickselect: one k-th smallest, median or percentile of an array that is already in memory and that you are allowed to reorder.',
      'Quickselect: splitting a data set at a value, such as choosing a split point for a k-d tree or a partition boundary, where you need the item and the two sides, not the order within them.',
      'Heap of k: the input is a stream, too big for memory, or arrives over time. Memory is k items however long it runs.',
      'Heap of k: k is much smaller than n and you will want to keep the answer up to date as new items arrive.',
    ],
    costs: [
      'Quickselect needs the whole array in memory and reorders it. Copy the array first if the original order matters, which costs O(n) memory.',
      'Quickselect with a fixed pivot rule goes quadratic on the wrong input: sorted input with the last item as pivot, as here. Pick the pivot at random, or use median of three.',
      'This partition puts equal items on the larger side, so an input of many equal values also drops one item per pass. A three-way partition (smaller, equal, larger) fixes it.',
      'The heap gives the k largest in heap order, not sorted. Sorting them costs another O(k log k).',
      'Neither answers "what is the k-th" again cheaply after the data changes. For many ranks or a changing set, keep a sorted structure, such as a balanced tree with subtree sizes or a Redis sorted set.',
      'Exact percentiles over a huge stream need every item. Monitoring systems use sketches such as t-digest or HDR histograms, which trade a small error for fixed memory.',
    ],
    interview: [
      'Say the two and when each wins: "If the data is in memory and I may reorder it, quickselect is O(n) on average. If it is a stream or too big, a min-heap of size k is O(n log k) time and O(k) memory."',
      'Explain why a min-heap for the k largest: the root is the weakest of the current top k, the one to evict, so a new item only has to beat that one item.',
      'Know the bad case: a fixed pivot on sorted input drops one item per pass, O(n²). The fix is a random pivot, and introselect or median of medians if you need a guaranteed bound.',
      'For a distributed top k: each shard keeps its own heap of k and sends k items, and a coordinator merges them. Say that this is exact for a top k of values, but for top k by count over keys spread across shards it can miss a key that is middling everywhere. Systems then ask each shard for more than k, or accept an approximate answer.',
      'Quickselect is Quicksort that recurses into one side only. That one change takes the expected cost from O(n log n) to O(n).',
    ],
  },
};

export default def;
