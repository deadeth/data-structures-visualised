import { CELL_H, cellWidth } from '../../core/geometry';
import { makeRng, pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/InsertionSort.java?raw';
import python from './code/insertion_sort.py?raw';

/**
 * Insertion sort on a small array of integers.
 *
 * Items left of `sorted` are in order. One insertion lifts items[sorted] out,
 * leaving a gap, compares it with the item left of the gap, and shifts that
 * item right while it is larger. The lifted item drops into the gap when the
 * item to its left is not larger, or when the gap reaches index 0.
 *
 * Equal values are allowed. Each item carries a unique id (so it slides by
 * id) and, when its value appears more than once, a letter given in the order
 * the items stood when they arrived. The letters show stability: after a sort
 * 41a still comes before 41b.
 */
export interface Item {
  uid: number;
  value: number;
  /** '' when the value is unique, otherwise a, b, c in arrival order. */
  tag: string;
}

/** An insertion in progress. */
export interface Lift {
  item: Item;
  /** Where the item was lifted from. */
  i: number;
  /** The index being compared: the item left of the gap. -1 once the gap reaches the front. */
  j: number;
}

export interface SortState {
  /** null marks the gap while an item is lifted. */
  items: (Item | null)[];
  /** items[0 .. sorted) is in order. */
  sorted: number;
  lift: Lift | null;
  nextUid: number;
  rnd: () => number;
}

/** Most items the page draws, so the row stays under about 950 wide. */
export const LIMIT = 12;
/** Size of the inputs the load buttons make. */
export const LOAD_SIZE = 10;
/** The page's opening example: ties at 41 and 17, a far traveller at 8. */
export const EXAMPLE = [41, 17, 63, 41, 8, 29, 17, 55];

export function create(): SortState {
  return { items: [], sorted: 0, lift: null, nextUid: 1, rnd: makeRng(20261113) };
}

export const label = (it: Item): string => `${it.value}${it.tag}`;
export const values = (s: SortState): number[] => s.items.map((it) => it!.value);

const nid = (it: Item) => `n${it.uid}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Pairs i < j with items[i] > items[j]. Insertion sort makes exactly this many shifts. */
export function inversions(xs: number[]): number {
  let n = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (xs[i] > xs[j]) n++;
  return n;
}

/** Give each repeated value letters a, b, c in its current left-to-right order. */
function retag(items: Item[]): void {
  const count = new Map<number, number>();
  for (const it of items) count.set(it.value, (count.get(it.value) ?? 0) + 1);
  const seen = new Map<number, number>();
  for (const it of items) {
    if (count.get(it.value)! < 2) {
      it.tag = '';
      continue;
    }
    const k = seen.get(it.value) ?? 0;
    seen.set(it.value, k + 1);
    it.tag = String.fromCharCode(97 + k);
  }
}

// ---- loading ---------------------------------------------------------------

export function load(s: SortState, xs: number[], rec: Rec, message: string): void {
  const items = xs.slice(0, LIMIT).map((value) => ({ uid: s.nextUid++, value, tag: '' }));
  retag(items);
  s.items = items;
  s.sorted = Math.min(1, items.length);
  s.lift = null;
  rec.vars({ values: items.map((it) => it.value), 'self.sorted': s.sorted });
  rec.line('load');
  rec.step(message);
}

function distinctSorted(s: SortState, n: number): number[] {
  const pool = new Set<number>();
  while (pool.size < n) pool.add(randomInt(1, 99, s.rnd));
  return [...pool].sort((a, b) => a - b);
}

export function loadExample(s: SortState, rec: Rec): void {
  load(
    s,
    EXAMPLE,
    rec,
    `Loaded ${EXAMPLE.length} items. 41 and 17 each appear twice, so they carry letters in their starting order: watch whether 41a stays ahead of 41b. Index 0 on its own is the sorted part.`,
  );
}

export function loadSorted(s: SortState, rec: Rec): void {
  const xs = distinctSorted(s, LOAD_SIZE);
  load(s, xs, rec, `Loaded ${xs.length} items already in order. Insertion sort does not know that yet: it still has to check each item against its left neighbour.`);
}

/** Sorted, then one item moved two places left and, half the time, one neighbouring pair swapped. */
export function nearlySorted(s: SortState, n = LOAD_SIZE): number[] {
  const xs = distinctSorted(s, n);
  const p = randomInt(2, n - 1, s.rnd);
  const [moved] = xs.splice(p, 1);
  xs.splice(p - 2, 0, moved);
  if (s.rnd() < 0.5) {
    // Swap a pair clear of the move, so the two disturbances stay separate.
    const choices: number[] = [];
    for (let q = 0; q + 1 < n; q++) if (q + 1 < p - 2 || q > p) choices.push(q);
    if (choices.length) {
      const q = choices[Math.floor(s.rnd() * choices.length)];
      [xs[q], xs[q + 1]] = [xs[q + 1], xs[q]];
    }
  }
  return xs;
}

export function loadNearly(s: SortState, rec: Rec): void {
  const xs = nearlySorted(s);
  const inv = inversions(xs);
  load(
    s,
    xs,
    rec,
    `Loaded ${xs.length} items in order apart from one or two out of place: ${plural(inv, 'pair')} out of order. Data like this is common, such as events that arrive a little late.`,
  );
}

export function loadReversed(s: SortState, rec: Rec): void {
  const xs = distinctSorted(s, LOAD_SIZE).reverse();
  const n = xs.length;
  load(s, xs, rec, `Loaded ${n} items in reverse order. Every one of the ${(n * (n - 1)) / 2} pairs is out of order, the worst input there is.`);
}

export function loadRandom(s: SortState, rec: Rec): void {
  const xs = Array.from({ length: LOAD_SIZE }, () => randomInt(1, 99, s.rnd));
  const n = xs.length;
  load(s, xs, rec, `Loaded ${n} items in random order: ${inversions(xs)} of the ${(n * (n - 1)) / 2} pairs are out of order. That is the number of shifts the sort will make.`);
}

/** Set the array from typed numbers, given as one string such as "5 2 9 1". */
export function setArray(s: SortState, text: string, rec: Rec): void {
  const xs = String(text)
    .split(/[\s,]+/)
    .filter((t) => t !== '')
    .map(Number)
    .filter((v) => Number.isInteger(v) && v >= 0 && v <= 999);
  const kept = xs.slice(0, LIMIT);
  const cut = xs.length > LIMIT ? ` This page draws at most ${LIMIT} items, so the rest were left out.` : '';
  if (kept.length === 0) {
    load(s, kept, rec, `The array is empty. Type some numbers, such as 5 2 9 1.`);
    return;
  }
  const n = kept.length;
  const inv = inversions(kept);
  const ties = new Set(kept).size < n ? ' Repeated values carry letters in their starting order, so you can check the sort keeps them.' : '';
  load(s, kept, rec, `Set ${plural(n, 'item')}: ${inv} of the ${(n * (n - 1)) / 2} pairs are out of order, so the sort will make ${plural(inv, 'shift')}.${ties}${cut}`);
}

// ---- the sort --------------------------------------------------------------

/**
 * Insert items[sorted] into the sorted part. With `brief` set (the Sort
 * operation) a shift is shown by the next frame rather than a frame of its
 * own, and the sentences are shorter.
 */
/** What one insertion cost. */
export interface Cost {
  comparisons: number;
  shifts: number;
}

export function insertNext(s: SortState, rec: Rec, brief = false): Cost | null {
  const a = s.items;
  const i = s.sorted;
  rec.vars();
  if (i >= a.length) {
    rec.vars({ i });
    rec.line('all_sorted');
    rec.step(a.length === 0 ? `The array is empty, so there is nothing to insert.` : `Every item is already in the sorted part. Load or set a new input.`);
    return null;
  }
  const item = a[i]!;
  const key = label(item);
  const probe: Probe = { text: key, at: nid(item) };
  rec.clearMarks();
  rec.mark(nid(item), 'key');
  a[i] = null;
  const lift: Lift = { item, i, j: i - 1 };
  s.lift = lift;
  // insert_next's variables. a[j] is left out once j is below 0.
  const show = (j: number) => rec.vars({ i, key: item.value, j, 'a[j]': j >= 0 ? a[j]?.value : undefined });
  show(i - 1);
  rec.line('lift');
  rec.step(
    brief
      ? `Lift ${key} out of index ${i}. Indexes 0 to ${i - 1} are sorted.`
      : `Indexes 0 to ${i - 1} are sorted. Lift the next item, ${key} at index ${i}, out of the array. Its slot becomes a gap that larger items can shift into.`,
    { probe },
  );

  let comparisons = 0;
  let shifts = 0;
  let j = i - 1;
  let tie: Item | null = null;
  let stoppedAt: Item | null = null;
  while (j >= 0) {
    const other = a[j]!;
    const ol = label(other);
    show(j);
    rec.mark(nid(other), 'compare');
    comparisons++;
    if (other.value <= item.value) {
      stoppedAt = other;
      rec.line('compare', 'stop');
      if (other.value === item.value) {
        tie = other;
        rec.compare(key, '=', ol, 'stop: equal items keep their order', {
          probe,
          message: brief
            ? `${key} equals ${ol}. Stop, so ${key} stays after ${ol}.`
            : `${key} equals ${ol}. The loop shifts only items that are larger, so it stops here and ${key} stays after ${ol}. That is what makes the sort stable.`,
        });
      } else {
        rec.compare(key, '>', ol, 'stop: it goes after this one', {
          probe,
          message: brief
            ? `${ol} is smaller. Stop: ${key} goes just after it.`
            : `${ol} is smaller than ${key}. Everything further left is smaller still, because that part is sorted, so the search stops here.`,
        });
      }
      rec.mark(nid(other), 'path');
      break;
    }
    rec.line('compare', 'shift');
    rec.compare(key, '<', ol, 'shift it right', {
      probe,
      message: brief
        ? `${ol} is larger, so it shifts right into the gap.`
        : `Compare ${key} with ${ol}, the item left of the gap. ${ol} is larger, so it must end up to the right of ${key}.`,
    });
    a[j + 1] = other;
    a[j] = null;
    rec.count('writes');
    shifts++;
    lift.j = j - 1;
    rec.mark(nid(other), 'path');
    if (!brief) {
      // j -= 1 is on this lit line, so the strip shows j after it.
      show(j - 1);
      rec.line('shift');
      rec.step(
        j === 0
          ? `Shift ${ol} one place right. The gap is at index 0 now, with nothing left of it to compare.`
          : `Shift ${ol} one place right, into the gap. The gap moves to index ${j}.`,
        { probe },
      );
    }
    j--;
  }

  a[j + 1] = item;
  s.sorted = i + 1;
  s.lift = null;
  rec.vars({ i, key: item.value, j });
  rec.line('drop');
  const cost = `${plural(comparisons, 'comparison')}, ${plural(shifts, 'shift')}`;
  let why: string;
  if (j < 0) why = i === 0 ? `It is the only item.` : `Nothing was left of the gap, so ${key} is the smallest so far.`;
  else if (shifts === 0) why = tie ? `Nothing moved.` : `It was already larger than everything before it: one comparison, no shifts.`;
  else why = `It sits after ${label(stoppedAt!)}.`;
  // At index 0 a chip above the item would cover the band's label, so it sits to the left.
  const dropped: Probe = j < 0 ? { ...probe, place: 'left' } : probe;
  rec.step(
    brief
      ? `Drop ${key} into index ${j + 1} (${cost}). ${why}`
      : `Drop ${key} into the gap at index ${j + 1}. ${why} The sorted part is now indexes 0 to ${i}. This insertion cost ${cost}.`,
    { probe: dropped },
  );
  if (s.sorted === a.length && !brief) {
    rec.clearMarks();
    rec.step(`That was the last item, so the whole array is sorted.`);
  }
  return { comparisons, shifts };
}

function tiesInOrder(items: Item[]): string | null {
  const firstSeen = new Map<number, Item[]>();
  for (const it of items) if (it.tag) firstSeen.set(it.value, [...(firstSeen.get(it.value) ?? []), it]);
  const groups = [...firstSeen.values()].filter((g) => g.length > 1).map((g) => g.map(label).join(' before '));
  return groups.length ? groups.join(', ') : null;
}

export function sort(s: SortState, rec: Rec): void {
  const n = s.items.length;
  rec.vars();
  if (s.sorted >= n) {
    rec.vars({ 'self.sorted': s.sorted, 'len(self.items)': n });
    rec.line('next');
    rec.step(n === 0 ? `The array is empty, so there is nothing to sort.` : `The array is already sorted. Load or set a new input.`);
    return;
  }
  const start = s.sorted;
  const remaining = inversions(values(s));
  let c = 0;
  let w = 0;
  while (s.sorted < n) {
    rec.line('next', 'lift');
    const cost = insertNext(s, rec, true)!;
    c += cost.comparisons;
    w += cost.shifts;
  }
  rec.clearMarks();
  rec.vars({ 'self.sorted': s.sorted, 'len(self.items)': n });
  for (const it of s.items) rec.mark(nid(it!), 'ok');
  const most = (n * (n - 1)) / 2;
  let verdict: string;
  if (start > 1) verdict = `It started with ${start} items already in the sorted part, so this run did only the rest.`;
  else if (remaining === 0) verdict = `The input was already sorted: n - 1 = ${n - 1} comparisons and no shifts, the best case, O(n).`;
  else if (remaining === most) verdict = `Reversed input is the worst case: every item travels to the front, so comparisons and shifts are both n(n - 1)/2 = ${most}, O(n²).`;
  else if (remaining <= n) verdict = `Each item moved at most a place or two, so the cost stayed close to n = ${n}. Comparisons are n - 1 plus one per shift, near enough.`;
  else verdict = `Shifts always equal the pairs that were out of order: ${remaining} of a possible ${most}. Random input averages about a quarter of n², still O(n²).`;
  const ties = tiesInOrder(s.items as Item[]);
  const stable = ties ? ` Equal items kept their order (${ties}): the sort is stable.` : '';
  rec.line('next');
  rec.step(`Sorted ${n} items with ${plural(c, 'comparison')} and ${plural(w, 'shift')}. ${verdict}${stable}`);
}

// ---- layout ----------------------------------------------------------------

const GAP = 8;
const LIFT_Y = -82;
const INDEX_Y = CELL_H / 2 + 14;
const TAG_Y = INDEX_Y + 30;

export function layout(s: SortState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const all = s.items.filter((x): x is Item => !!x);
  if (s.lift) all.push(s.lift.item);
  const w = Math.max(48, ...all.map((it) => cellWidth({ text: label(it) })));
  const pitch = w + GAP;
  const x = (k: number) => k * pitch;
  const n = s.items.length;
  const done = n > 0 && s.sorted >= n && !s.lift;

  if (s.sorted > 0) {
    // The sorted part. Its label sits inside the band, above the cells.
    // While an item is lifted the band reaches its old slot: shifts fill it from the left.
    const right = x(Math.max(s.sorted - 1, s.lift?.i ?? 0)) + w / 2 + 6;
    const left = x(0) - w / 2 - 6;
    decor.push({ id: 'band', type: 'band', x: left, y: -CELL_H / 2 - 32, w: right - left, h: CELL_H + 38, label: 'sorted' });
  }
  for (let k = 0; k < n; k++) {
    const it = s.items[k];
    if (it) nodes.push({ id: nid(it), x: x(k), y: 0, tone: done ? 'ok' : undefined, cells: [{ text: label(it), w }] });
    else nodes.push({ id: 'gap', x: x(k), y: 0, cells: [{ text: '', w }] });
    decor.push({ id: `ix${k}`, type: 'label', x: x(k), y: INDEX_Y, text: String(k), anchor: 'middle' });
  }
  if (s.lift) {
    const hole = s.items.indexOf(null);
    nodes.push({ id: nid(s.lift.item), x: x(hole), y: LIFT_Y, cells: [{ text: label(s.lift.item), w }] });
    nodes.push({ id: 'tag-i', x: x(s.lift.i), y: TAG_Y, shape: 'tag', cells: [{ text: 'i' }] });
    nodes.push({ id: 'tag-j', x: x(s.lift.j), y: TAG_Y, shape: 'tag', cells: [{ text: 'j' }] });
  }
  // A zero-size anchor left of index 0 keeps room for the j tag at -1 and for
  // the chip beside an item dropped at index 0, so the scene never jumps.
  if (n > 0) nodes.push({ id: 'room', x: x(-1) - 6, y: 0, shape: 'circle', r: 0, cells: [{ text: '' }] });
  if (n === 0) decor.push({ id: 'empty', type: 'label', x: 0, y: 0, text: 'Empty array', anchor: 'start' });
  return { nodes, edges: [], decor };
}

// ---- definition ------------------------------------------------------------

const NUMBERS = { name: 'numbers', label: 'Numbers, e.g. 5 2 9 1', kind: 'ints', min: 0, max: 999, maxItems: LIMIT } as const;

/** Typed examples: a tie, nearly sorted, reversed, one far traveller. */
const SUGGESTIONS = ['5 2 9 1 5 6', '3 7 4 10 12 15 18 20', '9 8 7 6 5 4 3 2', '20 30 40 50 60 70 10', '4 2 4 1 2 4'];

const def: StructureDef<SortState> = {
  id: 'insertion-sort',
  create: () => create(),
  seed: [['loadExample'], ['insertNext'], ['insertNext'], ['insertNext']],
  ops: [
    { id: 'insertNext', label: 'Insert next item', intent: 'primary', args: [], code: ['insert_next'], run: (s, _a, rec) => void insertNext(s, rec) },
    { id: 'sort', label: 'Sort the rest', intent: 'primary', args: [], code: ['sort', 'insert_next'], run: (s, _a, rec) => sort(s, rec) },
    { id: 'loadNearly', label: 'Load nearly sorted', args: [], code: ['load'], run: (s, _a, rec) => loadNearly(s, rec) },
    { id: 'loadReversed', label: 'Load reversed', args: [], code: ['load'], run: (s, _a, rec) => loadReversed(s, rec) },
    { id: 'loadRandom', label: 'Load random', args: [], code: ['load'], run: (s, _a, rec) => loadRandom(s, rec) },
    { id: 'loadSorted', label: 'Load sorted', args: [], code: ['load'], run: (s, _a, rec) => loadSorted(s, rec) },
    { id: 'loadExample', label: 'Load the example', args: [], code: ['load'], run: (s, _a, rec) => loadExample(s, rec) },
    {
      id: 'setArray',
      label: 'Set the array',
      args: [NUMBERS],
      code: ['load'],
      run: (s, [text], rec) => setArray(s, String(text), rec),
      suggest: () => [pick(SUGGESTIONS)],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Shifts' },
  ],
  status: (s) => {
    const xs = s.items.filter((x): x is Item => !!x).map((it) => it.value);
    return [
      { label: 'Items', value: `${s.items.length} of ${LIMIT}` },
      { label: 'Sorted part', value: s.items.length ? `indexes 0 to ${s.sorted - 1}` : 'empty' },
      { label: 'Pairs out of order', value: String(inversions(xs)) },
    ];
  },
  tour: [['insertNext'], ['sort'], ['loadNearly'], ['sort'], ['loadReversed'], ['sort']],
  source: { python, java },
  info: {
    summary:
      'Insertion sort keeps a sorted part on the left and grows it by one item at a time. It lifts the next item out, shifts every larger item one place right, and drops the item into the gap. On data that is already nearly in order it does almost no work, which is why fast library sorts hand small or nearly sorted pieces to it.',
    watch: [
      'The band is the sorted part. Each insertion compares the lifted item only with the items to its left, from right to left, and stops at the first one that is not larger.',
      'A shift moves an item one place right into the gap, and the gap moves one place left. The lifted item never swaps: it is written once, when it drops.',
      'Shifts equal the pairs that were out of order (the inversions in the status). Sorted input has none, so it costs n - 1 comparisons and no shifts. Reversed input has n(n - 1)/2.',
      'Equal items carry letters in their starting order. The loop stops at an equal item rather than passing it, so 41a stays ahead of 41b: the sort is stable.',
      'Simplified: this page draws at most 12 items, and the Sort button shows each shift as part of the next frame rather than a frame of its own.',
    ],
    complexity: [
      { op: 'Sort, best case', average: 'O(n)', worst: 'O(n)', note: 'Already sorted: one comparison per item, no shifts.' },
      { op: 'Sort, nearly sorted', average: 'O(n + d)', worst: 'O(n + d)', note: 'd is the number of pairs out of order. Each shift removes exactly one.' },
      { op: 'Sort, random or reversed', average: 'O(n²)', worst: 'O(n²)', note: 'About n²/4 pairs are out of order on random input, n²/2 when reversed, and each costs a shift.' },
      { op: 'Insert one item into a sorted part of k', average: 'O(k)', worst: 'O(k)', note: 'It may have to pass every item before it.' },
      { op: 'Binary insertion sort', average: 'O(n log n) comparisons', worst: 'O(n²) shifts', note: 'Finding the place by binary search cuts comparisons to about log2 k, but the items still have to move.' },
    ],
    space: 'O(1) extra: the array is sorted in place, with one item held aside.',
    usedIn: [
      { name: 'Library sorts, for small ranges', how: 'Quicksort and merge sort implementations stop dividing once a range is small (a few dozen items or fewer) and finish it with insertion sort, because it has almost no overhead per item.' },
      { name: 'Timsort (Python list.sort, Java object sorts)', how: 'Short runs in the input are extended to a minimum length with binary insertion sort before they are merged.' },
      { name: 'Sorted-array nodes', how: 'Putting a key into a B+ tree leaf or a page\'s sorted slot array is one insertion: find the place, shift the larger keys one slot right.' },
    ],
    reachFor: [
      'Small arrays, up to a few dozen items, where the simple loop beats the setup cost of a cleverer sort.',
      'Data that is already nearly in order, such as events that arrive a little late by timestamp. The cost grows with how far items are out of place, not with n².',
      'Items that arrive one at a time and must stay sorted: each arrival is one insertion (insertion sort is "online").',
      'When you need a stable, in-place sort and n is small.',
    ],
    costs: [
      'O(n²) on random or reversed input. At 10,000 items that is about 25 million shifts on random input, where an O(n log n) sort needs about 130,000 comparisons.',
      'Binary insertion sort finds the place in O(log k) comparisons but still shifts O(k) items, so it helps only when a comparison costs much more than a move.',
      'On a linked list there is no shifting, but there is no binary search either, so finding each place stays linear.',
      'For large inputs pick merge sort (stable) or quicksort (in place, not stable), which both use insertion sort at the bottom anyway.',
    ],
    interview: [
      '"Insertion sort does one shift per inversion, so its cost is O(n + d), where d is the number of pairs out of order. Sorted input is O(n), reversed is O(n²)."',
      '"It is adaptive, stable, in place and online. That combination is why real sorts use it for small ranges and short runs."',
      '"Binary insertion saves comparisons, not moves: O(n log n) comparisons but still O(n²) shifts. Worth it when comparing is expensive, such as strings or objects with a custom comparator."',
      '"For a stream that is nearly in time order, keep a small sorted buffer and insert each arrival from the end. Most land after one comparison." That is how you handle late events without sorting everything.',
      'If asked why not bubble sort: both are O(n²), but insertion sort does fewer writes (one shift per inversion, with the item written once) and stops each pass early, so it is faster in practice.',
    ],
  },
};

export default def;
