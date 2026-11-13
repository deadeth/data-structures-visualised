import { CELL_GAP, CELL_H, TAG_H } from '../../core/geometry';
import { PROBE_H, SUB_ROOM } from '../../core/fit';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/MergeSort.java?raw';
import python from './code/merge_sort.py?raw';

/**
 * Top-down merge sort with one buffer as long as the array.
 *
 * Every item carries a unique id, so the same item slides from the array into
 * the buffer and back. Equal values get letters (5a, 5b) in the order they
 * stand when a sort starts, which is how the page shows that the sort is
 * stable. The call stack is kept in the state only so the layout can draw it
 * as stacked brackets under the array.
 *
 * The picture lifts each item out of the array into the buffer, leaving an
 * empty slot. The code copies it, so the old value stays in the array until it
 * is overwritten. The page says so.
 */
export interface Item {
  uid: number;
  value: number;
  /** '' for a value that appears once, else a, b, c in order of position. */
  tag: string;
}

export type InputKind = 'empty' | 'single' | 'all equal' | 'sorted' | 'reversed' | 'random';

export interface Range {
  lo: number;
  hi: number;
  mid: number;
  merging: boolean;
}

export interface MSState {
  a: (Item | null)[];
  buf: (Item | null)[];
  nextUid: number;
  /** Calls to sort(lo, hi) that are open, outermost first. Ranges of one item are never pushed. */
  stack: Range[];
  tags: { i?: number; j?: number; k?: number; mid?: number };
  /** The range just copied back, drawn as written for one frame. */
  copied: { lo: number; hi: number } | null;
  finished: boolean;
  /** The previous sort, so the next one can be compared with it. */
  last: { n: number; kind: InputKind; comparisons: number; writes: number } | null;
}

/** Most items the page draws: twelve cells and the stack labels fit in about 760px. */
export const MAX_ITEMS = 12;

export function create(): MSState {
  return { a: [], buf: [], nextUid: 1, stack: [], tags: {}, copied: null, finished: false, last: null };
}

export const values = (s: MSState): number[] => s.a.map((it) => it!.value);

/** Levels of merging for n items: the depth of the call stack, counting only ranges of two or more. */
export const levels = (n: number): number => (n < 2 ? 0 : Math.ceil(Math.log2(n)));

export function kindOf(v: number[]): InputKind {
  if (v.length === 0) return 'empty';
  if (v.length === 1) return 'single';
  if (v.every((x) => x === v[0])) return 'all equal';
  if (v.every((x, i) => i === 0 || v[i - 1] <= x)) return 'sorted';
  if (v.every((x, i) => i === 0 || v[i - 1] >= x)) return 'reversed';
  return 'random';
}

const nid = (it: Item) => `n${it.uid}`;
const lab = (it: Item) => `${it.value}${it.tag}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (items: (Item | null)[]) => items.map((it) => lab(it!)).join(' ');

/** Give equal values letters in the order they stand now. */
function letter(s: MSState): void {
  const count = new Map<number, number>();
  for (const it of s.a) count.set(it!.value, (count.get(it!.value) ?? 0) + 1);
  const seen = new Map<number, number>();
  for (const it of s.a) {
    const v = it!.value;
    if (count.get(v)! < 2) {
      it!.tag = '';
      continue;
    }
    const k = seen.get(v) ?? 0;
    seen.set(v, k + 1);
    it!.tag = k < 26 ? String.fromCharCode(97 + k) : `${k}`;
  }
}

/** Equal values still stand in letter order: a before b before c. */
export function stableOrder(s: MSState): boolean {
  const lastTag = new Map<number, string>();
  for (const it of s.a) {
    if (!it || !it.tag) continue;
    const prev = lastTag.get(it.value);
    if (prev !== undefined && prev.localeCompare(it.tag, 'en', { numeric: true }) >= 0) return false;
    lastTag.set(it.value, it.tag);
  }
  return true;
}

export function setValues(s: MSState, v: number[]): void {
  s.a = v.map((value) => ({ uid: s.nextUid++, value, tag: '' }));
  s.buf = v.map(() => null);
  s.stack = [];
  s.tags = {};
  s.copied = null;
  s.finished = false;
  letter(s);
}

/** Read typed numbers such as "5 2 9 1". Returns null if any is not 0 to 999. */
export function parseNumbers(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p) || Number(p) > 999) return null;
    out.push(Number(p));
  }
  return out;
}

// ---- sorting --------------------------------------------------------------

interface Run {
  comparisons: number;
  writes: number;
  ties: number;
  merges: number;
}

export function mergeSort(s: MSState, rec: Rec): void {
  const n = s.a.length;
  s.stack = [];
  s.tags = {};
  s.copied = null;
  s.finished = false;
  letter(s);
  const kind = kindOf(values(s));
  if (n < 2) {
    rec.line('start', 'base');
    rec.step(n === 0 ? 'The array is empty, so there is nothing to sort.' : `One item is already sorted. sort(0, 1) returns at once, with nothing to compare.`);
    s.finished = n === 1;
    return;
  }
  s.buf = s.a.map(() => null);
  rec.line('buffer');
  rec.step(
    `Merge sort needs a buffer as long as the array: the ${n} empty slots at the bottom. Every merge writes into it, then copies back. That buffer is the O(n) extra memory an in-place sort does without.`,
  );
  const run: Run = { comparisons: 0, writes: 0, ties: 0, merges: 0 };
  sort(s, 0, n, rec, run);

  s.tags = {};
  s.copied = null;
  s.finished = true;
  rec.clearMarks();
  rec.line('done');
  rec.step(finalMessage(s, kind, run));
  s.last = { n, kind, comparisons: run.comparisons, writes: run.writes };
}

function finalMessage(s: MSState, kind: InputKind, run: Run): string {
  const n = s.a.length;
  const L = levels(n);
  const cost = `${plural(run.comparisons, 'comparison')} and ${plural(run.writes, 'write')}`;
  const last = s.last && s.last.n === n && s.last.kind !== kind ? s.last : null;
  const parts: string[] = [];
  if (kind === 'sorted' || kind === 'reversed' || kind === 'all equal') {
    const was = kind === 'all equal' ? 'All the items were equal' : `The input was already ${kind === 'sorted' ? 'sorted' : 'in reverse order'}`;
    parts.push(`Sorted ${n} items with ${cost}. ${was}, yet merge sort split and merged every range just the same.`);
    if (last) {
      parts.push(
        `The last run, on ${last.kind} input of the same size, took ${last.comparisons} comparisons and ${last.writes} writes. The writes never change; comparisons drop only because a merge stops comparing once one half runs out.`,
      );
    } else {
      parts.push(`The writes never change; comparisons drop only because a merge stops comparing once one half runs out.`);
    }
  } else {
    parts.push(
      `Sorted ${n} items with ${cost}: ${L} levels of merging, each writing every item into the buffer and back. That is n log n, whatever the order of the input.`,
    );
    if (last) parts.push(`The last run, on ${last.kind} input of the same size, took ${last.comparisons} comparisons and ${last.writes} writes.`);
  }
  const letters = s.a.filter((it) => it!.tag);
  if (letters.length) {
    const groups = new Map<number, string[]>();
    for (const it of letters) groups.set(it!.value, [...(groups.get(it!.value) ?? []), lab(it!)]);
    const shown = [...groups.values()].map((g) => g.join(' ')).join(', ');
    parts.push(stableOrder(s) ? `Equal items kept their order: ${shown}.` : `Equal items changed order: ${shown}.`);
  }
  return parts.join(' ');
}

function sort(s: MSState, lo: number, hi: number, rec: Rec, run: Run): void {
  if (hi - lo < 2) return;
  const mid = (lo + hi) >> 1;
  s.stack.push({ lo, hi, mid, merging: false });
  s.tags = { mid };
  s.copied = null;
  if (rec.recording) {
    const range = s.a.slice(lo, hi);
    const call = `sort(${lo}, ${hi})`;
    rec.line('split');
    if (hi - lo === 2) {
      rec.step(`${call} holds ${list(range)}. Split it into two single items. One item on its own is already sorted, so both calls return at once.`);
    } else if (s.stack.length === 1) {
      rec.step(
        `${call} covers the whole array. Split it in the middle, at index ${mid}: ${list(s.a.slice(lo, mid))} and ${list(s.a.slice(mid, hi))}. Sort the left half first. Each open call adds a bracket under the array.`,
      );
    } else {
      rec.step(`${call}: split ${list(range)} at index ${mid} into ${list(s.a.slice(lo, mid))} and ${list(s.a.slice(mid, hi))}. The left half goes first; this call waits on the stack.`);
    }
  }
  sort(s, lo, mid, rec, run);
  sort(s, mid, hi, rec, run);
  merge(s, lo, mid, hi, rec, run);
  s.stack.pop();
}

function moveToBuffer(s: MSState, from: number, k: number): Item {
  const it = s.a[from]!;
  s.a[from] = null;
  s.buf[k] = it;
  return it;
}

function merge(s: MSState, lo: number, mid: number, hi: number, rec: Rec, run: Run): void {
  const top = s.stack[s.stack.length - 1];
  top.merging = true;
  let i = lo;
  let j = mid;
  let k = lo;
  s.tags = { i, j, k };
  s.copied = null;
  run.merges++;
  rec.line('merge_call', 'merge_start');
  if (rec.recording) {
    const first = run.merges === 1 ? ` The page Merging sorted lists shows this step on its own.` : '';
    rec.step(
      `Both halves are sorted: ${list(s.a.slice(lo, mid))} and ${list(s.a.slice(mid, hi))}. Merge them: compare the two front items and copy the smaller into the buffer.${first}`,
    );
  }
  while (i < mid && j < hi) {
    const L = s.a[i]!;
    const R = s.a[j]!;
    rec.mark(nid(L), 'compare');
    rec.mark(nid(R), 'compare');
    run.comparisons++;
    const left = L.value <= R.value;
    const win = left ? L : R;
    const probe: Probe = { text: lab(win), at: nid(win) };
    if (left) {
      rec.line('compare', 'take_left');
      if (L.value === R.value) {
        run.ties++;
        rec.compare(lab(L), '=', lab(R), 'a tie, so take from the left', {
          probe,
          message:
            run.ties === 1
              ? `${lab(L)} and ${lab(R)} are equal. The test is <=, so a tie takes from the left half, which holds the items that came first. That is what makes merge sort stable: ${lab(L)} stays ahead of ${lab(R)}.`
              : `A tie again: take from the left, so ${lab(L)} stays ahead of ${lab(R)}.`,
        });
      } else {
        rec.compare(lab(L), '<', lab(R), 'take from the left', { probe });
      }
    } else {
      rec.line('compare', 'take_right');
      rec.compare(lab(L), '>', lab(R), 'take from the right', { probe });
    }
    rec.unmark(nid(L));
    rec.unmark(nid(R));
    moveToBuffer(s, left ? i : j, k);
    if (left) i++;
    else j++;
    run.writes++;
    rec.count('writes');
    const slot = k;
    k++;
    s.tags = { i: i < mid ? i : undefined, j: j < hi ? j : undefined, k: k < hi ? k : undefined };
    rec.line(left ? 'take_left' : 'take_right');
    rec.step(`Copy ${lab(win)} into buffer slot ${slot} and move ${left ? 'i' : 'j'} on to the next item ${left ? 'in the left half' : 'in the right half'}.`, {
      probe: { ...probe, place: 'below' },
    });
  }
  const restLeft = i < mid;
  const rest = restLeft ? s.a.slice(i, mid) : s.a.slice(j, hi);
  const count = rest.length;
  if (count > 0) {
    if (restLeft) while (i < mid) moveToBuffer(s, i++, k++);
    else while (j < hi) moveToBuffer(s, j++, k++);
    run.writes += count;
    rec.count('writes', count);
    s.tags = {};
    rec.line(restLeft ? 'rest_left' : 'rest_right');
    if (rec.recording) {
      const other = restLeft ? 'right' : 'left';
      const mine = restLeft ? 'left' : 'right';
      rec.step(
        count === 1
          ? `The ${other} half has run out, so the last item of the ${mine} half, ${lab(rest[0]!)}, goes into the buffer with no comparison.`
          : `The ${other} half has run out, so the rest of the ${mine} half, ${list(rest)}, goes into the buffer as it is. No comparisons: it is already sorted.`,
        { probe: { text: lab(rest[count - 1]!), at: nid(rest[count - 1]!), place: 'below' } },
      );
    }
  }
  for (let p = lo; p < hi; p++) {
    s.a[p] = s.buf[p];
    s.buf[p] = null;
  }
  const size = hi - lo;
  run.writes += size;
  rec.count('writes', size);
  s.tags = {};
  s.copied = { lo, hi };
  rec.line('copy_back');
  if (rec.recording) {
    const done = s.stack.length === 1 ? 'That was the last merge.' : `sort(${lo}, ${hi}) is done and its bracket comes off the stack.`;
    rec.step(`Copy the ${size} merged items back into the array: ${size} more writes. ${done}`);
  }
  s.copied = null;
}

// ---- other operations -----------------------------------------------------

/** Set the array from typed numbers, such as "38 27 43 3". */
export function setArray(s: MSState, arg: number | string | undefined, rec: Rec): void {
  const parsed = typeof arg === 'string' ? parseNumbers(arg) : typeof arg === 'number' ? [arg] : null;
  rec.line('set');
  if (!parsed) {
    rec.step(`Sorry, "${arg ?? ''}" is not a list of whole numbers from 0 to 999. Type them with spaces between, such as 38 27 43 3.`);
    return;
  }
  const v = parsed.slice(0, MAX_ITEMS);
  setValues(s, v);
  const cut = parsed.length > MAX_ITEMS ? ` This page stops at ${MAX_ITEMS} items, so the rest were left off.` : '';
  const ties = s.a.some((it) => it!.tag) ? ' Equal values get letters, so you can check that the sort keeps them in order.' : '';
  rec.step(`The array is now ${list(s.a)}: ${plural(v.length, 'item')}.${ties}${cut}`);
}

/** Telling inputs for the Set box: ties, a reversed run, a nearly sorted one. */
const EXAMPLES = ['5 2 5 9 2 5 1', '64 25 12 22 11 90 3 47', '1 2 3 4 5 6 8 7', '9 8 7 6 5 4 3 2 1', '30 10 30 20 10 30 20 10'];

const LOADS = {
  sorted: { anchor: 'load_sorted', say: 'in sorted order. Merge sort will do the same work as on a random input of the same size' },
  reversed: { anchor: 'load_reversed', say: 'in reverse order, the worst case for insertion sort. Merge sort does not mind' },
  equal: { anchor: 'load_equal', say: 'with only three different values, so there are many ties. Letters tell equal items apart, so you can check that a tie keeps them in order' },
  random: { anchor: 'load_random', say: 'in random order' },
} as const;

type LoadKind = keyof typeof LOADS;

/** Values for a load: random 1 to 99, then sorted, reversed or cut down to three values. */
export function makeInput(kind: LoadKind, n: number, rnd: () => number = Math.random): number[] {
  let v = Array.from({ length: n }, () => randomInt(1, 99, rnd));
  if (kind === 'sorted') v.sort((x, y) => x - y);
  else if (kind === 'reversed') v.sort((x, y) => y - x);
  else if (kind === 'equal') {
    const few = v.slice(0, 3);
    v = v.map(() => few[randomInt(0, few.length - 1, rnd)]);
  }
  return v;
}

/**
 * Load an input. The page passes no argument and gets random values; the tour
 * and the seed pass typed numbers as text, such as "38 27 43 3".
 */
export function load(s: MSState, kind: LoadKind, arg: number | string | undefined, rec: Rec): void {
  let v: number[];
  if (typeof arg === 'string') {
    const parsed = parseNumbers(arg);
    if (!parsed) {
      rec.line(LOADS[kind].anchor);
      rec.step(`Sorry, "${arg}" is not a list of whole numbers from 0 to 999.`);
      return;
    }
    v = parsed.slice(0, MAX_ITEMS);
  } else {
    const n = s.a.length >= 4 ? s.a.length : 8;
    v = makeInput(kind, n);
  }
  setValues(s, v);
  rec.line(LOADS[kind].anchor);
  rec.step(`Loaded ${plural(v.length, 'item')} ${LOADS[kind].say}.`);
}

// ---- layout ---------------------------------------------------------------

const CELL_W = 44;
const PITCH = CELL_W + CELL_GAP;
const ARRAY_Y = 0;
const TAG_Y = ARRAY_Y + CELL_H / 2 + SUB_ROOM + TAG_H / 2 + 4;
const BAND_TOP = TAG_Y + TAG_H / 2 + 14;
const BAND_ROW = 22;
const BAND_H = 10;

const slotX = (p: number) => p * PITCH;

export function layout(s: MSState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const n = s.a.length;
  const L = levels(n);
  const kTagY = BAND_TOP + L * BAND_ROW + TAG_H / 2 + 4;
  const bufY = kTagY + TAG_H / 2 + 8 + CELL_H / 2;
  const top = s.stack[s.stack.length - 1];

  for (let p = 0; p < n; p++) {
    const it = s.a[p];
    const x = slotX(p);
    if (!it) {
      nodes.push({ id: `as${p}`, x, y: ARRAY_Y, cells: [{ text: '', w: CELL_W }] });
      continue;
    }
    let tone: SceneNode['tone'];
    if (s.finished || (s.copied && p >= s.copied.lo && p < s.copied.hi)) tone = 'ok';
    else if (top && (p < top.lo || p >= top.hi)) tone = 'dim';
    nodes.push({ id: nid(it), x, y: ARRAY_Y, tone, cells: [{ text: String(it.value), w: CELL_W, sub: it.tag || undefined, subValue: it.tag ? true : undefined }] });
  }
  for (let k = 0; k < n; k++) {
    const it = s.buf[k];
    const x = slotX(k);
    if (!it) nodes.push({ id: `bs${k}`, x, y: bufY, cells: [{ text: '', w: CELL_W }] });
    else nodes.push({ id: nid(it), x, y: bufY, tone: 'ok', cells: [{ text: String(it.value), w: CELL_W, sub: it.tag || undefined, subValue: it.tag ? true : undefined }] });
  }

  const tag = (name: string, p: number | undefined, y: number) => {
    if (p === undefined || p >= n) return;
    nodes.push({ id: `t-${name}`, x: slotX(p), y, shape: 'tag', cells: [{ text: name }] });
  };
  tag('mid', s.tags.mid, TAG_Y);
  tag('i', s.tags.i, TAG_Y);
  tag('j', s.tags.j, TAG_Y);
  tag('k', s.tags.k, kTagY);

  // The call stack: one bracket per open call, outermost on top.
  s.stack.forEach((r, d) => {
    const x1 = slotX(r.lo) - CELL_W / 2;
    const x2 = slotX(r.hi - 1) + CELL_W / 2;
    const y = BAND_TOP + d * BAND_ROW;
    decor.push({ id: `band${d}`, type: 'band', x: x1, y, w: x2 - x1, h: BAND_H });
    const last = d === s.stack.length - 1;
    const text = last && r.merging ? `merge(${r.lo}, ${r.mid}, ${r.hi})` : `sort(${r.lo}, ${r.hi})`;
    decor.push({ id: `call${d}`, type: 'label', x: x2 + 8, y: y + BAND_H / 2, text, strong: last });
  });

  if (n > 0) {
    const left = slotX(0) - CELL_W / 2 - 10;
    decor.push({ id: 'row-a', type: 'label', x: left, y: ARRAY_Y, text: 'array', anchor: 'end', strong: true });
    decor.push({ id: 'row-b', type: 'label', x: left, y: bufY, text: 'buffer', anchor: 'end', strong: true });
    // Pin room for the stack labels and for the chip under the buffer, so the view does not jump.
    decor.push({ id: 'pin-r', type: 'label', x: slotX(n - 1) + CELL_W / 2 + 8, y: BAND_TOP, text: '' });
    decor.push({ id: 'pin-b', type: 'label', x: slotX(0), y: bufY + CELL_H / 2 + SUB_ROOM + PROBE_H + 12, text: '' });
  }
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

const SEED = '38 27 43 3 9 82 10 5';
const TIES = '42 17 42 63 17 42 8 63';

const def: StructureDef<MSState> = {
  id: 'merge-sort',
  create,
  seed: [['set', SEED]],
  ops: [
    {
      id: 'sort',
      label: 'Sort',
      intent: 'primary',
      args: [],
      code: ['merge_sort', 'sort', 'merge'],
      run: (s, _a, rec) => mergeSort(s, rec),
    },
    {
      id: 'set',
      label: 'Set the array',
      args: [{ name: 'values', label: 'Numbers', kind: 'ints', min: 0, max: 999, maxItems: MAX_ITEMS }],
      code: ['set'],
      run: (s, [v], rec) => setArray(s, v, rec),
      suggest: () => [EXAMPLES[randomInt(0, EXAMPLES.length - 1)]],
    },
    { id: 'loadRandom', label: 'Load random', args: [], code: ['load'], run: (s, [a], rec) => load(s, 'random', a, rec) },
    { id: 'loadSorted', label: 'Load sorted', args: [], code: ['load'], run: (s, [a], rec) => load(s, 'sorted', a, rec) },
    { id: 'loadReversed', label: 'Load reversed', args: [], code: ['load'], run: (s, [a], rec) => load(s, 'reversed', a, rec) },
    { id: 'loadEqual', label: 'Load many equal', args: [], code: ['load'], run: (s, [a], rec) => load(s, 'equal', a, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Writes' },
  ],
  status: (s) => [
    { label: 'Items', value: `${s.a.length} of ${MAX_ITEMS}` },
    { label: 'Input', value: kindOf(s.a.filter((it): it is Item => !!it).map((it) => it.value)) },
    { label: 'Levels of merging', value: String(levels(s.a.length)) },
    { label: 'Buffer', value: plural(s.a.length, 'slot') },
  ],
  tour: [['sort'], ['sort'], ['loadEqual', TIES], ['sort']],
  source: { python, java },
  info: {
    summary:
      'Merge sort splits the array in half, sorts each half, then merges the two sorted halves by repeatedly taking the smaller front item. It does the same work on every input, n log n, and it keeps equal items in their original order. The price is a buffer as large as the input.',
    watch: [
      'The brackets under the array are the call stack. Each split opens a call one row lower; each finished merge closes one. There are never more than log2 n rows.',
      'Every comparison is between the two front items, one from each half, marked i and j. The smaller goes into the buffer at k. The page Merging sorted lists shows this step on its own.',
      'When one half runs out, the rest of the other half is copied with no comparisons. That is the only way the comparison count changes with the input.',
      'Sort the array again once it is sorted. The writes are exactly the same, and the comparisons fall only a little.',
      'Load many equal values. A tie always takes from the left half, so 42a stays ahead of 42b. That is stability.',
      'Simplified: the picture lifts each item into the buffer and leaves an empty slot. The code copies it, so the old value stays in the array until the copy back overwrites it.',
    ],
    complexity: [
      { op: 'Sort, any input', average: 'O(n log n)', worst: 'O(n log n)', note: 'Halving gives log2 n levels, and each level merges all n items once.' },
      { op: 'Comparisons', average: 'About n log2 n', worst: 'Under n log2 n', note: 'A merge of two runs of m items makes between m and 2m - 1 comparisons. Sorted input hits the low end.' },
      { op: 'Writes', average: '2n per level', worst: '2n per level', note: 'Every item goes into the buffer and back on every level, whatever the order.' },
      { op: 'One merge', average: 'O(m)', worst: 'O(m)', note: 'One pass over both runs: each comparison places one item.' },
    ],
    space: 'O(n) extra for the buffer, plus O(log n) for the call stack. Merging linked lists needs no buffer: relinking nodes is enough.',
    usedIn: [
      { name: 'Python sorted() and list.sort()', how: 'Timsort: a merge sort that finds runs already in order and merges them, with insertion sort for short runs. Stable, and close to O(n) on input that is nearly sorted.' },
      { name: 'Java Arrays.sort for objects', how: 'Also Timsort, because sorting objects must be stable. Arrays of primitives use a dual-pivot quicksort instead, where stability cannot be seen.' },
      { name: 'External sort in databases', how: 'When rows to sort do not fit in memory, PostgreSQL and others sort chunks that fit, write each to disk as a sorted run, then merge the runs. That is merge sort with the merge done from disk.' },
      { name: 'LSM compaction', how: 'LevelDB, RocksDB and Cassandra merge sorted files into new sorted files: the merge step of merge sort, many inputs at once.' },
      { name: 'Sort-merge join', how: 'Sort both tables on the join key, then walk them together like a merge. Databases pick it when inputs are large or already sorted.' },
      { name: 'MapReduce and Spark shuffles', how: 'Each map task writes sorted output; each reducer merges the sorted pieces it receives, so it sees keys in order.' },
    ],
    reachFor: [
      'You need a stable sort: sort by date, then by customer, and keep the date order within each customer.',
      'You need a guaranteed O(n log n) with no bad input, such as data an attacker can choose.',
      'The data does not fit in memory. Sort chunks, write them as runs, merge the runs. Reads and writes are sequential, which suits disks.',
      'Linked lists. Splitting and merging need only pointer changes and no buffer, while quicksort and heapsort want random access.',
      'The work can be split across machines or threads: each sorts its own share, and a final merge combines them.',
    ],
    costs: [
      'O(n) extra memory for the buffer. Quicksort and heapsort sort in place.',
      'It does not get faster on sorted input. Plain merge sort does every split and every merge; Timsort fixes that by finding runs first.',
      'In memory it is usually a little slower than a good quicksort: more data movement, and the buffer is extra memory traffic.',
      'For small arrays, the splitting overhead costs more than it saves. Real versions switch to insertion sort below a few dozen items.',
    ],
    interview: [
      'Say why it is n log n: "Halving gives log2 n levels. Each level merges all n items once, and a merge is linear. So n times log n, on every input."',
      'Say how to sort data bigger than memory: "External merge sort. Read as much as fits, say 1 GB, sort it, write it out as a sorted run. Repeat. Then merge all the runs at once with a min-heap of the run heads, reading each run sequentially. 100 GB with 1 GB of memory is 100 runs and one merge pass." If there are too many runs to open at once, merge them in batches over several passes.',
      'Stability: "On a tie, the merge takes from the left half, which holds the earlier items. So equal items keep their order. That lets you sort by one key, then by another, and keep the first order within each group."',
      'Merge sort or quicksort? "Quicksort for arrays in memory where stability does not matter: in place and fast in practice. Merge sort when I need stability, a guaranteed worst case, linked lists, or data on disk."',
      'Connect it to storage: the merge step is what LSM compaction, sort-merge joins and the reduce side of MapReduce all do. The data is already sorted in runs, so only the merge is needed.',
      'Space: O(n) for the buffer and O(log n) for the stack. If asked for in-place merging: it exists, but it is complex and slower, and real libraries do not use it.',
    ],
  },
};

export default def;
