import { makeRng, pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/Quicksort.java?raw';
import python from './code/quicksort.py?raw';

/**
 * Quicksort on a small array of integers, with a Lomuto partition and an
 * explicit stack of ranges still to sort.
 *
 * Lomuto: the pivot is the last item of the range (after median of three has
 * moved its choice there). j scans the range from the left; i is the next slot
 * for an item no larger than the pivot. Every such item is swapped into slot i
 * and i moves on. At the end the pivot is swapped into slot i, its final place.
 *
 * Equal values are allowed, so every item carries a unique id. The id lets an
 * item slide to its new slot, and it is how equal items are told apart
 * (42a, 42b) to show that quicksort does not keep their order.
 */
export interface Item {
  uid: number;
  v: number;
}

/** What the current step is looking at. Only the layout reads it. */
export interface View {
  range: [number, number] | null;
  i?: number;
  j?: number;
  mid?: number;
  /** uid of the pivot. */
  pivot?: number;
  /** uids being compared now. */
  cmp: number[];
  /** Ranges waiting to be sorted, bottom of the stack first. */
  stack: [number, number][];
}

export interface QState {
  items: Item[];
  nextUid: number;
  rnd: () => number;
  /** uids known to be in their final place. */
  done: Set<number>;
  view: View;
  /** Most ranges waiting on the stack at once during the last sort. */
  peak: number;
}

/** Most items the page will take: 12 cells keep the scene under 700 wide. */
export const MAX_ITEMS = 12;
/** How many items the load operations put in. */
export const LOAD_N = 10;

export function create(seed = 11): QState {
  return { items: [], nextUid: 1, rnd: makeRng(seed), done: new Set(), view: blankView(), peak: 0 };
}

const blankView = (): View => ({ range: null, cmp: [], stack: [] });

export const values = (s: QState): number[] => s.items.map((it) => it.v);

export const isSorted = (s: QState): boolean => s.items.every((it, k) => k === 0 || s.items[k - 1].v <= it.v);

const nid = (it: Item) => `it${it.uid}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const span = (lo: number, hi: number) => (lo === hi ? `index ${lo}` : `${lo} to ${hi}`);

/**
 * Names for the items: the value, plus a letter when the value occurs more
 * than once (42a, 42b, in the order the items were added).
 */
export function names(s: QState): Map<number, string> {
  const byValue = new Map<number, Item[]>();
  for (const it of s.items) {
    const list = byValue.get(it.v) ?? [];
    list.push(it);
    byValue.set(it.v, list);
  }
  const out = new Map<number, string>();
  for (const [v, list] of byValue) {
    if (list.length === 1) {
      out.set(list[0].uid, String(v));
      continue;
    }
    [...list].sort((p, q) => p.uid - q.uid).forEach((it, k) => out.set(it.uid, `${v}${String.fromCharCode(97 + k)}`));
  }
  return out;
}

/** Names for messages, built only when frames are being recorded. */
function namer(s: QState, rec: Rec): (it: Item) => string {
  const map = rec.recording ? names(s) : null;
  return (it) => (map ? map.get(it.uid)! : '');
}

function swap(s: QState, i: number, j: number, rec: Rec): void {
  const a = s.items;
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
  rec.count('swaps');
}

export function setItems(s: QState, vals: number[]): void {
  s.items = vals.map((v) => ({ uid: s.nextUid++, v }));
  s.done.clear();
  s.view = blankView();
  s.peak = 0;
}

// ---- partition --------------------------------------------------------------

/** Sort a[lo], a[mid], a[hi] with three comparisons, then move the median to hi. */
function medianOfThree(s: QState, lo: number, hi: number, popped: boolean, rec: Rec, nm: (it: Item) => string): void {
  const a = s.items;
  const v = s.view;
  const mid = (lo + hi) >> 1;
  v.mid = mid;
  // median_of_three's variables, read from the array as it stands.
  const showM = () => rec.recording && rec.vars({ lo, hi, mid, 'a[lo]': a[lo].v, 'a[mid]': a[mid].v, 'a[hi]': a[hi].v });
  showM();
  const head = popped ? ['pop', 'median'] : ['median'];
  rec.line(...head, 'm_mid');
  rec.step(
    `${popped ? `Take ${span(lo, hi)} off the stack. ` : ''}Median of three: look at the first, middle and last items, ${nm(a[lo])}, ${nm(a[mid])} and ${nm(a[hi])}. Put those three in order, then use the middle one as the pivot.`,
  );
  const step = (x: number, y: number, anchor: string, which: string) => {
    // Compare a[y] < a[x], with x the lower slot. Swap if so.
    v.cmp = [a[x].uid, a[y].uid];
    if (a[y].v < a[x].v) {
      rec.line('median', anchor);
      rec.compare(nm(a[y]), '<', nm(a[x]), `out of order: swap them`, {
        message: `Compare the ${which}. ${nm(a[y])} is smaller than ${nm(a[x])}, so they swap.`,
      });
      swap(s, x, y, rec);
      showM();
      rec.line('median', `${anchor}_swap`);
      rec.step(`Swap: ${nm(a[x])} moves to slot ${x} and ${nm(a[y])} to slot ${y}.`);
    } else {
      rec.line('median', anchor);
      rec.compare(nm(a[y]), '≥', nm(a[x]), `already in order: leave them`, {
        message: `Compare the ${which}. ${nm(a[y])} is not smaller than ${nm(a[x])}, so they stay.`,
      });
    }
  };
  step(lo, mid, 'm_one', 'middle item with the first');
  step(lo, hi, 'm_two', 'last item with the first');
  step(mid, hi, 'm_three', 'last item with the middle one');
  v.cmp = [];
  const median = a[mid];
  const largest = a[hi];
  swap(s, mid, hi, rec);
  showM();
  v.pivot = median.uid;
  rec.line('median', 'm_use');
  rec.step(
    `The three are in order. The median, ${nm(median)}, swaps to the end to be the pivot, and the largest, ${nm(largest)}, takes the middle slot. The pivot is the median of the three, so it is neither the smallest nor the largest of them.`,
    { probe: { text: nm(median), at: nid(median) } },
  );
  v.mid = undefined;
}

/**
 * Lomuto partition of a[lo..hi]. Returns the pivot's final index.
 * `popped` says the range came off the sort's stack, so the frames light the
 * pop as well.
 */
function partitionRange(s: QState, lo: number, hi: number, median3: boolean, popped: boolean, first: boolean, rec: Rec, nm: (it: Item) => string): number {
  const a = s.items;
  const v = s.view;
  v.range = [lo, hi];
  v.cmp = [];
  v.i = undefined;
  v.j = undefined;
  let usedMedian = false;
  if (median3 && hi - lo >= 2) {
    medianOfThree(s, lo, hi, popped, rec, nm);
    usedMedian = true;
  }
  const pivot = a[hi];
  const P = nm(pivot);
  v.pivot = pivot.uid;
  let i = lo;
  v.i = i;
  v.j = lo;
  // partition's variables. j is undefined outside the loop.
  const show = (j?: number) => rec.vars({ lo, hi, pivot: pivot.v, i, j, 'a[j]': j === undefined ? undefined : a[j].v });
  show();
  rec.line(...(popped && !usedMedian ? ['pop'] : []), 'pivot');
  const where = popped ? (usedMedian ? '' : `Take ${span(lo, hi)} off the stack. `) : `Partition the whole array, ${span(lo, hi)}. `;
  const range2 = usedMedian
    ? `The pivot is ${P}, now at the end of the range.`
    : median3
      ? `Two items are too few for median of three, so the pivot is the last item, ${P}.`
      : `The pivot is the last item, ${P}.`;
  rec.step(
    first
      ? `${where}${range2} j scans from the left. i marks the slot where the next item no larger than ${P} goes, so everything left of i is no larger than ${P}.`
      : `${where}${range2}`,
    { probe: { text: P, at: nid(pivot) } },
  );
  let explained = !first;
  for (let j = lo; j < hi; j++) {
    v.j = j;
    v.i = i;
    const it = a[j];
    v.cmp = [it.uid];
    show(j);
    const probe: Probe = { text: P, at: nid(it) };
    if (it.v <= pivot.v) {
      if (i !== j) {
        rec.line('compare');
        rec.compare(P, '≥', nm(it), `no larger: swap it into slot i`, {
          probe,
          message: `${nm(it)} is no larger than ${P}, so it belongs on the left. Slot i, ${i}, holds an item larger than ${P}: swap them.`,
        });
        const out = a[i];
        swap(s, i, j, rec);
        v.cmp = [];
        i++;
        v.i = i;
        show(j);
        rec.line('swap', 'grow');
        rec.step(
          explained
            ? `Swap: ${nm(it)} moves to slot ${i - 1} and ${nm(out)} to slot ${j}. i moves on to ${i}.`
            : `Swap: ${nm(it)} moves to slot ${i - 1} and ${nm(out)}, which is larger than ${P}, to slot ${j}. i moves on to ${i}, so the left part has grown by one.`,
          { probe: { text: P, at: nid(it) } },
        );
        explained = true;
      } else {
        rec.line('compare', 'grow');
        rec.compare(P, '≥', nm(it), `no larger, and already in slot i: move i on`, {
          probe,
          message: `${nm(it)} is no larger than ${P} and is already in slot i, so no swap is needed. i moves on to ${i + 1}.`,
        });
        i++;
      }
    } else {
      rec.line('compare');
      rec.compare(P, '<', nm(it), `larger: leave it where it is`, {
        probe,
        message: `${nm(it)} is larger than ${P}, so it stays right of i. Only j moves on.`,
      });
    }
    v.cmp = [];
  }
  v.j = undefined;
  v.i = i;
  const moved = a[i];
  if (i !== hi) swap(s, i, hi, rec);
  show();
  s.done.add(pivot.uid);
  rec.line(i !== hi ? 'place' : 'stay');
  const L = i - lo;
  const R = hi - i;
  rec.step(
    i !== hi
      ? `j has reached the pivot. Swap ${P} into slot i, ${i}, and ${nm(moved)} goes to the end. ${L === 0 ? 'Nothing' : `Everything to its left (${plural(L, 'item')})`} is no larger than ${P} and ${R === 0 ? 'nothing' : `everything to its right (${plural(R, 'item')})`} is larger, so ${P} is in its final place.`
      : `j has reached the pivot, and i is at the end too: no item is larger than ${P}. It stays in slot ${i}, its final place, with ${plural(L, 'item')} on its left and none on its right.`,
    { probe: { text: P, at: nid(pivot) } },
  );
  return i;
}

// ---- operations ---------------------------------------------------------------

/** One partition of the whole array, with the last item as pivot. */
export function partition(s: QState, rec: Rec): number | undefined {
  const n = s.items.length;
  s.done.clear();
  s.view = blankView();
  rec.vars();
  if (n < 2) {
    rec.line('pivot');
    rec.step(n === 0 ? `The array is empty, so there is nothing to partition. Type some numbers or load an input.` : `One item is already in its place. There is nothing to partition.`);
    return undefined;
  }
  const nm = namer(s, rec);
  const p = partitionRange(s, 0, n - 1, false, false, true, rec, nm);
  const pv = nm(s.items[p]);
  s.view = blankView();
  rec.line('place');
  const L = p;
  const R = n - 1 - p;
  rec.step(
    `One partition: ${pv} is in its final place, index ${p}, after ${plural(n - 1, 'comparison')}. The ${plural(L, 'item')} on its left and the ${plural(R, 'item')} on its right are not sorted yet. Quicksort now does the same to each side.`,
  );
  return p;
}

/** Sort the whole array. `median3` picks the pivot by median of three; otherwise the last item. */
export function sort(s: QState, median3: boolean, rec: Rec): void {
  const a = s.items;
  const n = a.length;
  const nm = namer(s, rec);
  s.done.clear();
  s.view = blankView();
  s.peak = 0;
  const before = rec.recording ? a.slice() : [];
  rec.vars();
  if (n < 2) {
    for (const it of a) s.done.add(it.uid);
    rec.line('start', 'push');
    rec.step(n === 0 ? `The array is empty, so there is nothing to sort.` : `One item is already sorted. Nothing to do.`);
    return;
  }
  const stack = s.view.stack;
  stack.push([0, n - 1]);
  s.peak = 1;
  rec.vars({ stack: tuples(stack) });
  rec.line('start', 'push');
  rec.step(
    `Push the whole array, 0 to ${n - 1}, onto a stack of ranges still to sort. The stack replaces recursion, so a long input cannot overflow the call stack. The pivot is ${median3 ? 'chosen by median of three' : 'always the last item of a range'}.`,
  );
  let first = true;
  let worst = true;
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    const p = partitionRange(s, lo, hi, median3, true, first, rec, nm);
    first = false;
    const L = p - lo;
    const R = hi - p;
    if (Math.min(L, R) > 0) worst = false;
    if (L === 1) s.done.add(a[lo].uid);
    if (R === 1) s.done.add(a[hi].uid);
    const leftBig = L > R;
    if (leftBig) {
      if (L > 1) stack.push([lo, p - 1]);
      if (R > 1) stack.push([p + 1, hi]);
    } else {
      if (R > 1) stack.push([p + 1, hi]);
      if (L > 1) stack.push([lo, p - 1]);
    }
    s.peak = Math.max(s.peak, stack.length);
    s.view.range = null;
    s.view.i = undefined;
    s.view.pivot = undefined;
    if (rec.recording) rec.vars({ stack: tuples(stack), lo, hi, p });
    rec.line(leftBig ? 'left_big' : 'right_big', 'push');
    if (rec.recording) rec.step(sides(lo, hi, p, nm(a[p]), stack));
  }
  s.view = blankView();
  for (const it of a) s.done.add(it.uid);
  rec.vars({ stack: [] });
  rec.line('empty');
  if (!rec.recording) return;
  const log = Math.round(n * Math.log2(n));
  const most = (n * (n - 1)) / 2;
  const cost = worst
    ? `Every partition split off just one item, the worst case: n(n - 1) / 2 = ${most} comparisons for ${n} items, where a typical run needs about n log2 n = ${log}.`
    : `For ${n} items, n log2 n is about ${log}. The worst case, every split as uneven as possible, would take n(n - 1) / 2 = ${most}.`;
  rec.step(`The stack is empty, so the array is sorted. ${cost} ${stability(before, a, nm)}`.trim());
}

/** The stack as the listing holds it: a list of (lo, hi) pairs. */
const tuples = (stack: [number, number][]) => stack.map(([lo, hi]) => `(${lo}, ${hi})`);

/** The sentence after a partition: how the range split and what goes on the stack. */
function sides(lo: number, hi: number, p: number, P: string, stack: [number, number][]): string {
  const L = p - lo;
  const R = hi - p;
  const left = L === 0 ? null : [lo, p - 1];
  const right = R === 0 ? null : [p + 1, hi];
  const parts: string[] = [];
  if (L === 0 || R === 0) {
    const side = L === 0 ? 'left' : 'right';
    const other = L === 0 ? R : L;
    parts.push(`${P} splits ${span(lo, hi)} as unevenly as possible: nothing on its ${side}, ${plural(other, 'item')} on the other side. The next partition is only one item shorter.`);
  } else {
    parts.push(`${P} splits ${span(lo, hi)} into ${plural(L, 'item')} on the left and ${plural(R, 'item')} on the right.`);
  }
  const ones = [left, right].filter((r) => r && r[0] === r[1]) as number[][];
  if (ones.length) parts.push(`A part of one item is already in its place.`);
  const pushed = [left, right].filter((r) => r && r[0] < r[1]) as number[][];
  if (pushed.length === 2) {
    const [big, small] = L > R ? [left!, right!] : [right!, left!];
    parts.push(`Push the larger part, ${span(big[0], big[1])}, first, so the smaller, ${span(small[0], small[1])}, is on top and sorted next. That keeps the stack O(log n) deep.`);
  } else if (pushed.length === 1) {
    parts.push(`Push ${span(pushed[0][0], pushed[0][1])} onto the stack.`);
  } else if (stack.length === 0) {
    parts.push(`Nothing new to push.`);
  } else {
    parts.push(`Nothing new to push. Next, the range on top of the stack.`);
  }
  return parts.join(' ');
}

/** Whether equal items kept their order, as a sentence. */
function stability(before: Item[], after: Item[], nm: (it: Item) => string): string {
  const pos = new Map(before.map((it, k) => [it.uid, k]));
  const seen = new Map<number, Item>();
  let dup = false;
  for (const it of after) {
    const prev = seen.get(it.v);
    if (prev) {
      dup = true;
      if (pos.get(prev.uid)! > pos.get(it.uid)!) {
        return `Equal items went in as ${nm(it)} then ${nm(prev)} and came out as ${nm(prev)} then ${nm(it)}: quicksort is not stable, because a long-distance swap can jump one equal item over another.`;
      }
    }
    seen.set(it.v, it);
  }
  return dup ? `Equal items happen to keep their order this time, but quicksort does not promise it.` : ``;
}

/** Replace the array with typed numbers: a string such as "5 2 9 1", or the numbers themselves. */
export function setArray(s: QState, input: string | number[], rec: Rec): void {
  const all = typeof input === 'string' ? input.split(/[\s,]+/).filter(Boolean).map(Number) : input;
  const vals = all.filter((v) => Number.isInteger(v) && v >= 0 && v <= 999).slice(0, MAX_ITEMS);
  setItems(s, vals);
  rec.vars({ values: vals });
  const cut = all.length > MAX_ITEMS ? ` This page stops at ${MAX_ITEMS} items, so the rest were left out.` : '';
  rec.line('set');
  const nm = namer(s, rec);
  const dup = s.items.some((it) => nm(it) !== String(it.v));
  rec.step(
    vals.length === 0
      ? `The array is empty. Type some numbers or load an input.`
      : `The array now holds ${plural(vals.length, 'item')}.${dup ? ' Letters tell equal items apart, so you can see whether a sort keeps their order.' : ''}${cut}`,
  );
}

type Kind = 'sorted' | 'reversed' | 'equal' | 'random';

/** Distinct values from 1 to 99, in random order. */
function distinct(s: QState, n: number): number[] {
  const all = Array.from({ length: 99 }, (_, k) => k + 1);
  for (let k = all.length - 1; k > 0; k--) {
    const r = Math.floor(s.rnd() * (k + 1));
    [all[k], all[r]] = [all[r], all[k]];
  }
  return all.slice(0, n);
}

export function load(s: QState, kind: Kind, rec: Rec): void {
  const n = LOAD_N;
  let vals: number[];
  let note: string;
  if (kind === 'sorted') {
    vals = distinct(s, n).sort((p, q) => p - q);
    note = `${n} items already in increasing order. With the last item as pivot, every pivot is the largest in its range: the worst case.`;
  } else if (kind === 'reversed') {
    vals = distinct(s, n).sort((p, q) => q - p);
    note = `${n} items in decreasing order. With the last item as pivot, every pivot is the smallest or largest in its range, so this is a bad case too.`;
  } else if (kind === 'equal') {
    const three = distinct(s, 3);
    vals = Array.from({ length: n }, () => three[Math.floor(s.rnd() * 3)]);
    note = `${n} items drawn from only three values. Letters tell equal items apart, so you can see whether their order survives.`;
  } else {
    vals = Array.from({ length: n }, () => randomInt(1, 99, s.rnd));
    note = `${n} random items from 1 to 99. Repeats are allowed; letters tell equal items apart.`;
  }
  setItems(s, vals);
  rec.vars({ n });
  rec.line('load');
  rec.step(`Loaded ${note}`);
}

// ---- layout -----------------------------------------------------------------

const CW = 50;
const PITCH = 58;
const ROW_J = 70;
const ROW_I = 102;
const ROW_LH = 134;
const STACK_Y = 168;
const x = (k: number) => k * PITCH;

export function layout(s: QState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const v = s.view;
  const nm = names(s);
  const n = s.items.length;
  const cols = Math.max(n, 1);
  // Two empty labels pin the corners, so the zoom stays put while tags come and go.
  decor.push({ id: 'corner-a', type: 'label', x: -PITCH / 2, y: -30, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: x(cols - 1) + PITCH / 2, y: STACK_Y, text: '' });
  if (v.range) {
    const [lo, hi] = v.range;
    decor.push({ id: 'range', type: 'band', x: x(lo) - PITCH / 2 + 2, y: -30, w: (hi - lo + 1) * PITCH - 4, h: 78 });
  }
  if (n === 0) {
    nodes.push({ id: 'empty', x: 0, y: 0, cells: [{ text: '', w: CW }] });
    decor.push({ id: 'empty-note', type: 'label', x: PITCH / 2 + 4, y: 0, text: 'Empty: type numbers\nor load an input' });
  }
  s.items.forEach((it, k) => {
    let tone: Tone | undefined;
    if (v.cmp.includes(it.uid)) tone = 'compare';
    else if (v.pivot === it.uid && !s.done.has(it.uid)) tone = 'key';
    else if (s.done.has(it.uid)) tone = 'ok';
    else if (v.range && (k < v.range[0] || k > v.range[1])) tone = 'dim';
    nodes.push({ id: nid(it), x: x(k), y: 0, tone, cells: [{ text: nm.get(it.uid)!, w: CW, sub: String(k) }] });
  });
  const tag = (id: string, text: string, k: number | undefined, y: number) => {
    if (k === undefined) return;
    nodes.push({ id: `tag-${id}`, x: x(k), y, shape: 'tag', cells: [{ text }] });
  };
  tag('j', 'j', v.j, ROW_J);
  tag('i', 'i', v.i, ROW_I);
  if (v.range) {
    tag('lo', 'lo', v.range[0], ROW_LH);
    tag('hi', 'hi', v.range[1], ROW_LH);
  }
  tag('mid', 'mid', v.mid, ROW_LH);
  if (v.stack.length) {
    const list = [...v.stack].reverse().map(([lo, hi]) => `${lo} to ${hi}`).join(', ');
    decor.push({ id: 'stack', type: 'label', x: -PITCH / 2, y: STACK_Y, text: `Waiting, top first: ${list}` });
  }
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------

const NUMBERS = { name: 'numbers', label: 'Numbers', kind: 'ints', min: 0, max: 999, maxItems: MAX_ITEMS } as const;
/** Telling inputs for an empty box: equal items that change order, sorted, all equal. */
const EXAMPLES = ['5 9 5 2 8 5 1 7', '1 2 3 4 5 6 7 8', '7 7 7 7 7 7', '60 20 50 10 40 30'];
export const SEED = [38, 81, 22, 47, 9, 63, 15, 70, 29, 41];

const def: StructureDef<QState> = {
  id: 'quicksort',
  create: () => create(),
  seed: [['set', SEED.join(' ')]],
  ops: [
    { id: 'sort', label: 'Sort, last item as pivot', intent: 'primary', args: [], code: ['quicksort', 'partition'], run: (s, _a, rec) => sort(s, false, rec) },
    { id: 'sortMedian', label: 'Sort, median of three', intent: 'primary', args: [], code: ['quicksort', 'partition', 'median_of_three'], run: (s, _a, rec) => sort(s, true, rec) },
    { id: 'partition', label: 'Partition once', args: [], code: ['partition'], run: (s, _a, rec) => void partition(s, rec) },
    { id: 'set', label: 'Set the array', args: [NUMBERS], code: ['set_array'], run: (s, [v], rec) => setArray(s, String(v), rec), suggest: () => [pick(EXAMPLES)] },
    { id: 'loadRandom', label: 'Load random', args: [], code: ['load_random'], run: (s, _a, rec) => load(s, 'random', rec) },
    { id: 'loadSorted', label: 'Load sorted', args: [], code: ['load_sorted'], run: (s, _a, rec) => load(s, 'sorted', rec) },
    { id: 'loadReversed', label: 'Load reversed', args: [], code: ['load_reversed'], run: (s, _a, rec) => load(s, 'reversed', rec) },
    { id: 'loadEqual', label: 'Load many equal', args: [], code: ['load_equal'], run: (s, _a, rec) => load(s, 'equal', rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'swaps', label: 'Swaps' },
  ],
  status: (s) => [
    { label: 'Items', value: `${s.items.length} of ${MAX_ITEMS}` },
    { label: 'In order', value: isSorted(s) ? 'yes' : 'no' },
    { label: 'Most ranges waiting', value: String(s.peak) },
  ],
  tour: [['partition'], ['loadRandom'], ['sort'], ['loadSorted'], ['sort'], ['sortMedian']],
  source: { python, java },
  info: {
    summary:
      'Quicksort picks one item, the pivot, and moves every item no larger than it to its left and every larger item to its right. The pivot is then in its final place, and the same is done to each side. It sorts in place and is fast on average, but a pivot that is always the smallest or largest item makes it quadratic.',
    watch: [
      'One partition: j walks the range once and compares each item with the pivot. i is the boundary: everything left of i is no larger than the pivot. A small item is swapped into slot i and i moves on.',
      'When j reaches the end, the pivot swaps into slot i. It goes green: it never moves again. Nothing else is in its final place yet.',
      'The stack of ranges replaces recursion. The larger side is pushed first, so the smaller side is sorted next and the stack never holds more than about log2 n ranges.',
      'Sorted input with the last item as pivot: every pivot is the largest in its range, so each partition peels off one item. 10 items take 45 comparisons; median of three, next, takes 28.',
      'Median of three on the same input picks the middle value as pivot, and the splits come out even.',
      'Equal items carry letters (53a, 53b). Watch them change order: quicksort is not stable.',
      'Simplified here: at most 12 items, Lomuto partition only, and no switch to insertion sort for short ranges, which real libraries make.',
    ],
    complexity: [
      { op: 'Sort, average', average: 'O(n log n)', worst: 'O(n²)', note: 'Each level of splitting compares every item once, and even splits give log2 n levels. Random input needs about 1.39 n log2 n comparisons.' },
      { op: 'Sort, worst case', average: 'O(n²)', worst: 'O(n²)', note: 'A pivot that is always the smallest or largest leaves n - 1 items for the next pass: (n - 1) + (n - 2) + ... + 1 = n(n - 1) / 2.' },
      { op: 'One partition', average: 'O(n)', worst: 'O(n)', note: 'One pass, one comparison per item. Lomuto swaps up to once per item; Hoare\'s scheme, scanning in from both ends, does fewer swaps.' },
      { op: 'Median of three', average: 'O(1) per partition', worst: 'O(1)', note: 'Three comparisons and up to four swaps. It fixes sorted and reversed input, but crafted inputs can still force O(n²).' },
      { op: 'Quickselect (k-th smallest)', average: 'O(n)', worst: 'O(n²)', note: 'Partition, then carry on into the one side that holds index k. n + n/2 + n/4 + ... is about 2n.' },
    ],
    space: 'O(log n) for the stack of ranges, if the smaller side is always sorted first; otherwise O(n) in the worst case. The items are sorted in place, with no second array.',
    usedIn: [
      { name: 'C++ std::sort', how: 'Typical implementations (libstdc++, for one) use introsort: quicksort with median-of-three pivots, a switch to heapsort if the recursion gets too deep, and insertion sort for short ranges. The standard requires O(n log n) comparisons and does not promise stability; std::stable_sort is the stable one.' },
      { name: 'Java Arrays.sort on primitives', how: 'A dual-pivot quicksort: two pivots split the range into three parts. Stability cannot be seen with primitives. Arrays.sort on objects uses TimSort instead, which is stable.' },
      { name: 'Go sort.Sort and slices.Sort', how: 'Pattern-defeating quicksort (pdqsort) since Go 1.19. Not stable; sort.Stable is the stable one.' },
      { name: 'Rust sort_unstable', how: 'A quicksort variant, as the name warns. slice::sort is the stable, merge-based one.' },
      { name: 'PostgreSQL', how: 'Sorts in memory with quicksort when the rows fit in work_mem. EXPLAIN ANALYZE shows "Sort Method: quicksort". When they do not fit it switches to an external merge sort on disk.' },
      { name: 'Python', how: 'list.sort and sorted use no quicksort: they are a stable, merge-based sort (Timsort). Worth knowing when someone assumes every built-in sort is quicksort.' },
    ],
    reachFor: [
      'Sorting an array in memory when equal items need not keep their order, such as plain numbers or keys that are unique.',
      'Memory is tight: it sorts in place with an O(log n) stack, where merge sort needs a second array of n items.',
      'Finding the k-th smallest item, a median or a percentile without sorting everything: quickselect does one partition per step and keeps only one side.',
      'Top k when the data fits in memory and can be reordered: partition around the k-th item and keep one side. For a stream, use a heap of k instead.',
    ],
    costs: [
      'Not stable. The final swap of a partition, and every swap of a small item into slot i, can jump an item over an equal one. Sorting by a second key after a first then breaks the first order. Use a stable sort (merge sort, Timsort) or add the original index as a tie-breaker.',
      'Quadratic in the worst case. A fixed pivot rule meets a matching input: last item on sorted data, here. Median of three or a random pivot makes that unlikely; introsort makes it impossible by switching to heapsort.',
      'Many equal values hurt this two-way partition. With "no larger goes left", all-equal input sends every item left: the worst case again. Three-way partitioning (Dijkstra\'s Dutch national flag) gathers the items equal to the pivot in the middle and never touches them again, so many duplicates make it faster, not slower.',
      'Not for data that does not fit in memory. Partitioning jumps around the array; an external merge sort reads and writes in long sequential runs instead.',
      'Not for linked lists. Partitioning needs fast access by index; merge sort suits lists.',
    ],
    interview: [
      'Say the trade in one line: "Quicksort is in place and fast on average, O(n log n), but O(n²) in the worst case and not stable. Merge sort is O(n log n) always and stable, but needs O(n) extra space."',
      'Explain the worst case: "If the pivot is always the smallest or largest item, each partition only removes one item, so the work is n + (n - 1) + ... = O(n²). Sorted input with a last-item pivot does exactly that. Median of three or a random pivot fixes it in practice."',
      'Explain why it is not stable: a swap moves an item a long way, past items equal to it. Show it with two equal keys and one smaller item at the end.',
      'For "find the k-th largest" or "the median", offer quickselect: average O(n), because only one side is kept. Then mention a heap of size k as the O(n log k) choice for a stream.',
      'Say what real libraries do: introsort or pdqsort for unstable sorts, Timsort or another merge sort for stable ones, and insertion sort for ranges below a few dozen items, where it beats both.',
      'Recursion depth: sort the smaller side first and loop on the larger, and the stack stays O(log n) even when the splits are bad.',
      'Link it to systems: a database sorts in memory with quicksort until the data outgrows its memory budget, then spills sorted runs to disk and merges them. That merge is the same one LSM compaction and sort-merge joins use.',
    ],
  },
};

export default def;
