import { CELL_H, TAG_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/BinarySearch.java?raw';
import python from './code/binary_search.py?raw';

/**
 * Binary search over an array of integers.
 *
 * The page keeps the array plus the three indices the search moves (lo, mid,
 * hi), so the layout can draw them as tags. Nothing stops the reader loading
 * an unsorted array: the search runs on it anyway and the page shows where it
 * goes wrong.
 */
export interface BSState {
  items: number[];
  /** Indices drawn as tags while an operation runs. hi can be -1 or n. */
  tags: { lo?: number; mid?: number; hi?: number };
  /** Draw the empty slot at index n, past the end. */
  showEnd: boolean;
}

/** Most items the page draws. Fifteen slots, with the one past the end, fit in about 840px. */
export const MAX_ITEMS = 14;

export function create(): BSState {
  return { items: [], tags: {}, showEnd: false };
}

export const isSorted = (a: number[]): boolean => a.every((v, i) => i === 0 || a[i - 1] <= v);

/** Most comparisons a search of n items can take: floor(log2 n) + 1. */
export const worstCase = (n: number): number => (n === 0 ? 0 : 32 - Math.clz32(n));

const cid = (i: number) => `c${i}`;
const slotId = (s: BSState, i: number) => (i >= s.items.length ? 'end' : cid(i));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function dimRange(rec: Rec, from: number, to: number): void {
  for (let i = from; i <= to; i++) rec.mark(cid(i), 'dim');
}

/** Read typed numbers such as "5 2 9 1" or "5, 2, 9, 1". Returns null if any is not 0 to 999. */
export function parseNumbers(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n > 999) return null;
    out.push(n);
  }
  return out;
}

function randomItems(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(randomInt(1, 99));
  return out;
}

function shuffle(a: number[]): number[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** Turn an op's argument into a list: typed numbers as text, or a count for random ones. */
function numbersFrom(arg: number | string | undefined, rec: Rec): number[] | null {
  if (typeof arg === 'string') {
    const nums = parseNumbers(arg);
    if (!nums) {
      rec.step(`Sorry, "${arg}" is not a list of whole numbers from 0 to 999. Type them with spaces between, such as 5 12 40.`);
      return null;
    }
    return nums;
  }
  const count = Math.max(1, Math.min(MAX_ITEMS, Number(arg ?? 10) || 10));
  return randomItems(count);
}

function tooMany(nums: number[], rec: Rec): boolean {
  if (nums.length <= MAX_ITEMS) return false;
  rec.step(`Sorry, this page draws at most ${MAX_ITEMS} items so every cell stays readable, and that list has ${nums.length}. Try a shorter one.`);
  return true;
}

// ---- loading ----------------------------------------------------------------

export function loadSorted(s: BSState, arg: number | string | undefined, rec: Rec): boolean {
  rec.line('load_sorted');
  const nums = numbersFrom(arg, rec);
  if (!nums || tooMany(nums, rec)) return false;
  s.items = [...nums].sort((a, b) => a - b);
  s.tags = {};
  s.showEnd = false;
  for (let i = 0; i < s.items.length; i++) rec.mark(cid(i), 'ok');
  const n = s.items.length;
  rec.step(
    `Loaded ${plural(n, 'item')} in sorted order: smallest at index 0, largest at index ${n - 1}. Equal items sit side by side. A search of ${n} items takes at most ${plural(worstCase(n), 'comparison')}.`,
  );
  return true;
}

export function loadUnsorted(s: BSState, arg: number | string | undefined, rec: Rec): boolean {
  rec.line('load');
  let nums: number[] | null;
  if (typeof arg === 'string') {
    nums = numbersFrom(arg, rec);
    if (!nums || tooMany(nums, rec)) return false;
  } else {
    const base = new Set(s.items).size >= 3 ? s.items : randomItems(10);
    nums = shuffle(base);
    // A shuffle can come out sorted by chance; swap two items that differ.
    if (isSorted(nums)) {
      const j = nums.findIndex((v) => v !== nums![0]);
      if (j > 0) [nums[0], nums[j]] = [nums[j], nums[0]];
    }
  }
  s.items = nums;
  s.tags = {};
  s.showEnd = false;
  for (let i = 0; i < s.items.length; i++) rec.mark(cid(i), 'ok');
  rec.step(
    isSorted(nums)
      ? `Loaded ${plural(nums.length, 'item')} as given. They happen to be in order, so binary search will still work.`
      : `Loaded ${plural(nums.length, 'item')} as given, out of order. Nothing in binary search checks the order: checking would mean reading every item, which is the cost it exists to avoid.`,
  );
  return true;
}

/** Set the array to typed numbers, in the order typed. An unsorted list is kept unsorted, so the failure can be seen. */
export function setArray(s: BSState, arg: number | string | undefined, rec: Rec): boolean {
  rec.line('load');
  const nums = numbersFrom(typeof arg === 'string' ? arg : String(arg ?? ''), rec);
  if (!nums || tooMany(nums, rec)) return false;
  s.items = nums;
  s.tags = {};
  s.showEnd = false;
  for (let i = 0; i < nums.length; i++) rec.mark(cid(i), 'ok');
  const n = nums.length;
  rec.step(
    isSorted(nums)
      ? `Set ${plural(n, 'item')} exactly as typed. They are in order, so binary search works: at most ${plural(worstCase(n), 'comparison')} per search.`
      : `Set ${plural(n, 'item')} exactly as typed, and they are not sorted. This page keeps them that way so you can watch binary search go wrong: try Find on a number that is here. Load sorted puts things right.`,
  );
  return true;
}

// ---- find ---------------------------------------------------------------------

export interface Trace {
  index: number;
  /** Indices compared, in order. */
  mids: number[];
}

export function find(s: BSState, key: number, rec: Rec): Trace {
  const a = s.items;
  const n = a.length;
  const mids: number[] = [];
  const sorted = isSorted(a);
  let lo = 0;
  let hi = n - 1;
  s.tags = { lo, hi };
  s.showEnd = true;
  const at = (i: number): Probe => ({ text: String(key), at: slotId(s, i) });
  // For an unsorted array: the comparison that ruled out the last copy of the key.
  let ruledOut: { step: number; mid: number; right: boolean } | null = null;
  const copies = a.map((v, i) => (v === key ? i : -1)).filter((i) => i >= 0);
  const live = (from: number, to: number) => copies.some((i) => i >= from && i <= to);
  if (n === 0) {
    rec.line('init', 'loop', 'missing');
    rec.step(`The array is empty, so there is nowhere to look for ${key}. No comparisons.`, { probe: at(0) });
    s.tags = {};
    s.showEnd = false;
    return { index: -1, mids };
  }

  rec.line('init');
  rec.step(
    `Find ${key}. lo and hi mark the range where ${key} could still be: all ${n} items, index 0 to ${n - 1}.` +
      (sorted ? '' : ' The array is not sorted, but binary search has no way to know that.'),
    { probe: at(lo + ((hi - lo) >> 1)) },
  );

  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    mids.push(mid);
    s.tags = { lo, mid, hi };
    const v = a[mid];
    rec.mark(cid(mid), 'compare');
    const where =
      mids.length === 1
        ? `mid = lo + (hi - lo) / 2, rounded down: ${lo} + (${hi} - ${lo}) / 2 = ${mid}, which holds ${v}.`
        : `mid = ${lo} + (${hi} - ${lo}) / 2 = ${mid}, which holds ${v}.`;
    if (v === key) {
      rec.line('mid', 'test', 'found');
      rec.compare(key, '=', v, 'found it', { probe: at(mid), message: `${where} That is ${key}.` });
      rec.mark(cid(mid), 'ok');
      const c = plural(mids.length, 'comparison');
      rec.step(
        sorted
          ? `Found ${key} at index ${mid} with ${c}. ${n} items never need more than ${worstCase(n)}, because each comparison halves the range.` +
              (copies.length > 1 ? ` ${key} appears ${copies.length} times; this search stops at whichever copy it meets first. Lower bound finds the first.` : '')
          : `Found ${key} at index ${mid} with ${c}, but only by luck. The array is not sorted, so a miss here would have meant nothing.`,
        { probe: at(mid) },
      );
      s.tags = {};
      s.showEnd = false;
      return { index: mid, mids };
    }
    if (v < key) {
      rec.line('mid', 'test', 'go_right');
      rec.compare(key, '>', v, 'go right half', {
        probe: at(mid),
        message: `${where} ${key} is larger, so if it is here it must be to the right.`,
      });
      if (!ruledOut && copies.length && live(lo, mid) && !live(mid + 1, hi)) ruledOut = { step: mids.length, mid, right: true };
      dimRange(rec, lo, mid);
      const was = lo;
      lo = mid + 1;
      s.tags = { lo, mid, hi };
      rec.line('go_right');
      rec.step(
        `${sorted ? `Everything from index ${was} to ${mid} is ${v} or less, because the array is sorted.` : `On a sorted array everything from index ${was} to ${mid} would be ${v} or less.`} Rule it out: lo = mid + 1 = ${lo}. ${rangeLeft(lo, hi)}`,
        { probe: at(Math.min(lo, n)) },
      );
    } else {
      rec.line('mid', 'test', 'go_left');
      rec.compare(key, '<', v, 'go left half', {
        probe: at(mid),
        message: `${where} ${key} is smaller, so if it is here it must be to the left.`,
      });
      if (!ruledOut && copies.length && live(mid, hi) && !live(lo, mid - 1)) ruledOut = { step: mids.length, mid, right: false };
      dimRange(rec, mid, hi);
      const was = hi;
      hi = mid - 1;
      s.tags = { lo, mid, hi };
      rec.line('go_left');
      rec.step(
        `${sorted ? `Everything from index ${mid} to ${was} is ${v} or more, because the array is sorted.` : `On a sorted array everything from index ${mid} to ${was} would be ${v} or more.`} Rule it out: hi = mid - 1 = ${hi}. ${rangeLeft(lo, hi)}`,
        { probe: at(Math.max(hi, 0)) },
      );
    }
  }

  s.tags = { lo, hi };
  const c = plural(mids.length, 'comparison');
  rec.line('loop', 'missing');
  rec.step(
    `lo (${lo}) has passed hi (${hi}), so the range is empty: ${key} is not here. ${c}; ${n} items never need more than ${worstCase(n)}. To insert ${key}, put it at index lo, ${lo}.`,
    { probe: at(lo) },
  );
  if (!sorted && copies.length) {
    for (const i of copies) rec.mark(cid(i), 'bad');
    const r = ruledOut!;
    const j = copies[0];
    rec.line('missing');
    rec.step(
      `But ${key} is right there at index ${j}. Comparison ${r.step} ruled it out: ${a[r.mid]} at index ${r.mid} was ${r.right ? 'smaller' : 'larger'} than ${key}, which on a sorted array means ${key} lies to the ${r.right ? 'right' : 'left'}. On unsorted input binary search gives a wrong answer and no error. Sort first, or scan every item.`,
      { probe: at(j) },
    );
  }
  s.tags = {};
  s.showEnd = false;
  return { index: -1, mids };
}

function rangeLeft(lo: number, hi: number): string {
  const left = hi - lo + 1;
  if (left <= 0) return 'Nothing is left to look at.';
  return left === 1 ? `One item is left to look at.` : `${left} items are left to look at.`;
}

// ---- lower bound ------------------------------------------------------------

export function lowerBound(s: BSState, key: number, rec: Rec): Trace {
  const a = s.items;
  const n = a.length;
  const mids: number[] = [];
  const sorted = isSorted(a);
  let lo = 0;
  let hi = n;
  s.tags = { lo, hi };
  s.showEnd = true;
  const at = (i: number): Probe => ({ text: String(key), at: slotId(s, i) });

  rec.line('lb_init');
  rec.step(
    `Lower bound of ${key}: the first index whose item is ${key} or more. The answer can be ${n}, past the end, if every item is smaller, so hi starts at ${n}, the empty slot.` +
      (sorted ? '' : ' The array is not sorted, but nothing checks.'),
    { probe: at(lo + ((hi - lo) >> 1)) },
  );

  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    mids.push(mid);
    s.tags = { lo, mid, hi };
    const v = a[mid];
    rec.mark(cid(mid), 'compare');
    const where =
      mids.length === 1
        ? `mid = lo + (hi - lo) / 2, rounded down: ${lo} + (${hi} - ${lo}) / 2 = ${mid}, which holds ${v}.`
        : `mid = ${lo} + (${hi} - ${lo}) / 2 = ${mid}, which holds ${v}.`;
    if (v < key) {
      rec.line('lb_mid', 'lb_test', 'lb_right');
      rec.compare(key, '>', v, 'go right half', {
        probe: at(mid),
        message: `${where} ${v} is below ${key}, so neither it nor anything to its left can be the answer.`,
      });
      dimRange(rec, lo, mid);
      lo = mid + 1;
      s.tags = { lo, mid, hi };
      rec.line('lb_right');
      rec.step(`Rule out up to index ${mid}: lo = mid + 1 = ${lo}. ${candidates(lo, hi, n)}`, { probe: at(lo) });
    } else {
      rec.line('lb_mid', 'lb_test', 'lb_left');
      rec.compare(key, '≤', v, 'keep mid, go left half', {
        probe: at(mid),
        message: `${where} ${v} is ${v === key ? 'equal to' : 'above'} ${key}, so index ${mid} could be the answer, but an earlier one might be too.`,
      });
      dimRange(rec, mid + 1, hi - 1);
      rec.mark(cid(mid), 'path');
      hi = mid;
      s.tags = { lo, mid, hi };
      rec.line('lb_left');
      rec.step(
        `Keep index ${mid} as the best answer so far and rule out everything after it: hi = mid = ${hi}, not mid - 1. ${candidates(lo, hi, n)}`,
        { probe: at(hi) },
      );
    }
  }

  s.tags = { lo, hi };
  const c = plural(mids.length, 'comparison');
  rec.mark(slotId(s, lo), 'ok');
  rec.line('lb_loop', 'lb_done');
  if (lo === n) {
    rec.step(
      `lo and hi meet at ${n}, past the end: every item is below ${key}, so it would be appended at index ${n}. ${c}.`,
      { probe: at(lo) },
    );
  } else if (a[lo] === key) {
    const dup = lo + 1 < n && a[lo + 1] === key;
    rec.step(
      `lo and hi meet at index ${lo}, which holds ${key}: ${c}. ${dup ? `${key} appears more than once and this is the first copy, which plain find does not promise.` : `One check of a[lo] == key turns lower bound into a search.`} Real indexes use this form to find where a range starts, then read on in order.`,
      { probe: at(lo) },
    );
  } else {
    rec.step(
      `lo and hi meet at index ${lo}, which holds ${a[lo]}: the first item at or above ${key}. ${key} itself is not here, and putting it at index ${lo} keeps the array sorted. ${c}. A range scan from ${key} starts reading here.`,
      { probe: at(lo) },
    );
  }

  if (!sorted) {
    let j = -1;
    for (let i = lo; i < n && j < 0; i++) if (a[i] < key) j = i;
    for (let i = 0; i < lo && j < 0; i++) if (a[i] >= key) j = i;
    if (j >= 0) {
      rec.mark(cid(j), 'bad');
      rec.line('lb_done');
      rec.step(
        j > lo
          ? `That answer is wrong: ${a[j]} at index ${j} is below ${key} yet sits after index ${lo}. The array is not sorted, so ruling out half of it on one comparison was not safe.`
          : `That answer is wrong: ${a[j]} at index ${j} is ${key} or more and sits before index ${lo}. The array is not sorted, so ruling out half of it on one comparison was not safe.`,
        { probe: at(j) },
      );
    }
  }
  s.tags = {};
  s.showEnd = false;
  return { index: lo, mids };
}

function candidates(lo: number, hi: number, n: number): string {
  if (lo === hi) return `lo equals hi, so one place is left: index ${lo}${lo === n ? ', past the end' : ''}.`;
  return `The answer is one of index ${lo} to ${hi}${hi === n ? `, where ${n} means past the end` : ''}.`;
}

// ---- layout -------------------------------------------------------------------

const CELL_W = 52;
const PITCH = 56;
/** Under the cells and their index labels. */
const TAG_TOP = CELL_H / 2 + 30 + TAG_H / 2;
const TAG_ROW = TAG_H + 6;
const ROWS = { lo: 0, mid: 1, hi: 2 } as const;

export function layout(s: BSState): Scene {
  const n = s.items.length;
  const x = (i: number) => (i - (n - 1) / 2) * PITCH;
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: cid(i), x: x(i), y: 0, cells: [{ text: String(s.items[i]), w: CELL_W, sub: String(i) }] });
  }
  if (s.showEnd) {
    nodes.push({ id: 'end', x: x(n), y: 0, cells: [{ text: '', w: CELL_W, sub: String(n) }] });
  }
  for (const name of ['lo', 'mid', 'hi'] as const) {
    const i = s.tags[name];
    if (i === undefined) continue;
    nodes.push({ id: name, x: x(i), y: TAG_TOP + ROWS[name] * TAG_ROW, shape: 'tag', cells: [{ text: name }] });
  }
  if (n > 1 && !isSorted(s.items)) {
    decor.push({
      id: 'unsorted',
      type: 'label',
      x: x(0) - CELL_W / 2,
      y: TAG_TOP + 2 * TAG_ROW + TAG_H / 2 + 20,
      text: 'Not sorted: halving\nis not safe here.',
    });
  }
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;
const NUMS = { name: 'numbers', label: 'Numbers, used as typed', kind: 'ints', min: 0, max: 999, maxItems: MAX_ITEMS } as const;
const COUNT = { name: 'count', label: 'How many', kind: 'int', min: 1, max: MAX_ITEMS } as const;

const SEED = '3 8 15 21 27 27 34 42 56 63 71 88';

/** A key worth searching for: on a sorted array a hit or a miss, on an unsorted one a key it will wrongly miss. */
function suggestKey(s: BSState): number {
  const a = s.items;
  if (a.length === 0) return randomInt(0, 99);
  if (!isSorted(a)) {
    const quiet = { recording: false } as Rec;
    const missed = [...new Set(a)].filter((k) => find({ items: a, tags: {}, showEnd: false }, k, noop(quiet)).index < 0);
    if (missed.length) return missed[randomInt(0, missed.length - 1)];
    return a[randomInt(0, a.length - 1)];
  }
  if (Math.random() < 0.5) return a[randomInt(0, a.length - 1)];
  return gapKey(a);
}

/** A key that falls between two neighbours, or past either end. */
function gapKey(a: number[]): number {
  const absent: number[] = [];
  for (let k = 0; k <= Math.min(999, (a[a.length - 1] ?? 0) + 10); k++) if (!a.includes(k)) absent.push(k);
  return absent.length ? absent[randomInt(0, absent.length - 1)] : randomInt(0, 999);
}

function noop(r: Rec): Rec {
  const f = () => {};
  return { recording: r.recording, step: f, compare: f, count: f, line: f, mark: f, markCell: f, markEdge: f, unmark: f, clearMarks: f };
}

const def: StructureDef<BSState> = {
  id: 'binary-search',
  create,
  seed: [['load', SEED]],
  ops: [
    {
      id: 'find',
      label: 'Find',
      intent: 'primary',
      args: [KEY],
      code: ['find'],
      run: (s, [k], rec) => void find(s, Number(k), rec),
      suggest: (s) => [suggestKey(s)],
    },
    {
      id: 'lowerBound',
      label: 'Lower bound',
      args: [KEY],
      code: ['lower_bound'],
      run: (s, [k], rec) => void lowerBound(s, Number(k), rec),
      suggest: (s) => [isSorted(s.items) && Math.random() < 0.25 ? s.items[randomInt(0, s.items.length - 1)] ?? 0 : gapKey(s.items)],
    },
    {
      id: 'set',
      label: 'Set the array',
      args: [NUMS],
      code: ['load'],
      run: (s, [arg], rec) => void setArray(s, arg, rec),
      suggest: () => [Math.random() < 0.5 ? '5 12 19 33 40 58 61 77 84 90' : '42 8 63 3 27 88 15 56 21 71 34 27'],
    },
    {
      id: 'load',
      label: 'Load sorted',
      args: [COUNT],
      code: ['load_sorted'],
      run: (s, [arg], rec) => void loadSorted(s, arg, rec),
      suggest: () => [randomInt(8, 12)],
    },
    {
      id: 'loadUnsorted',
      label: 'Shuffle it',
      intent: 'danger',
      args: [],
      code: ['load'],
      run: (s, [arg], rec) => void loadUnsorted(s, arg, rec),
    },
  ],
  layout,
  counters: [{ key: 'comparisons', label: 'Comparisons' }],
  status: (s) => [
    { label: 'Items', value: String(s.items.length) },
    { label: 'Sorted', value: isSorted(s.items) ? 'yes' : 'no' },
    { label: 'Most comparisons', value: String(worstCase(s.items.length)) },
  ],
  tour: [
    ['find', 42],
    ['find', 30],
    ['lowerBound', 30],
    ['lowerBound', 27],
    ['set', '42 8 63 3 27 88 15 56 21 71 34 27'],
    ['find', 8],
  ],
  source: { python, java },
  info: {
    summary:
      'Binary search finds a key in a sorted array by looking at the middle item and throwing away the half that cannot hold it. Each comparison halves what is left, so a million items take at most 20 comparisons. It only works if the array is sorted, and nothing in it checks.',
    watch: [
      'lo and hi bound the range where the key could still be. Everything outside it is dimmed: one comparison rules out half the range at once.',
      'mid is lo + (hi - lo) / 2, rounded down. The listing says why it is not (lo + hi) / 2: with 32-bit integers the sum can overflow on a large array.',
      'A miss ends when lo passes hi. lo is then where the key would be inserted, which is free information.',
      'Lower bound never stops early on a match. It keeps the match as a candidate (hi = mid) and looks further left, so it finds the first copy of a repeated key, or the first item above a missing one.',
      'Shuffle the array and search again. The halving rule still runs, still costs log n, and confidently misses a key that is there.',
    ],
    complexity: [
      { op: 'Find', average: 'O(log n)', worst: 'O(log n)', note: 'Each comparison halves the range, so n items take at most floor(log2 n) + 1.' },
      { op: 'Lower bound', average: 'O(log n)', worst: 'O(log n)', note: 'Always runs until lo meets hi: about log2 n comparisons, hit or miss.' },
      { op: 'Range scan from a key', average: 'O(log n + k)', worst: 'O(log n + k)', note: 'Lower bound to find the start, then read k items in order.' },
      { op: 'Insert or delete', average: 'O(n)', worst: 'O(n)', note: 'Finding the place is O(log n), but every later item has to shift along by one.' },
      { op: 'Search unsorted data', average: 'O(n)', worst: 'O(n)', note: 'Binary search gives wrong answers, so you scan. Sorting first is O(n log n), worth it only if you search many times.' },
    ],
    space: 'O(1) extra: two or three indices. The array itself is the only storage.',
    usedIn: [
      { name: 'B+ tree pages', how: 'Inside one page the keys are kept sorted, and the database finds the right key or child pointer by binary search over them. PostgreSQL does this in its B-tree code.' },
      { name: 'LevelDB and RocksDB SSTables', how: 'Each file ends with an index block of sorted keys, one per data block. A read binary-searches the index to pick the one data block that could hold the key, then searches inside that block.' },
      { name: 'Kafka offset index', how: 'Each log segment has an index file of offsets in increasing order, each pointing at a byte position. Fetching from an offset binary-searches that file for the nearest entry, then reads forward through the log.' },
      { name: 'Python bisect and C++ lower_bound', how: 'bisect_left and std::lower_bound are this page\'s lower bound: the first position at or after the key, which is also where to insert it.' },
      { name: 'Java Arrays.binarySearch', how: 'Returns the index if found, otherwise -(insertion point) - 1, so a miss still says where the key would go.' },
      { name: 'git bisect', how: 'The same halving over commits instead of numbers: test the middle commit, keep the half that holds the first bad one.' },
    ],
    reachFor: [
      'The data is sorted and read far more often than it changes: a lookup table, a read-only file, a sorted index built once.',
      'You need a boundary, not just a match: the first event after a timestamp, the first key in a range, where to insert. That is lower bound.',
      'Memory is tight. A sorted array has no pointers and no per-item overhead, and the search needs no extra space.',
      'Any yes-or-no question that flips once as a number grows: the smallest batch size that fits, the first bad build. Binary search the answer.',
    ],
    costs: [
      'Inserting or deleting shifts everything after that point: O(n). For data that changes, use a balanced tree, a B+ tree or a skip list, which keep the O(log n) search and make updates O(log n).',
      'The input must be sorted, and binary search cannot tell when it is not. It returns a wrong answer, not an error.',
      'A hash table finds an exact key in O(1) on average. Binary search wins when you also need order: ranges, nearest key, first at or after.',
      'Each step jumps across memory, so on a large array most comparisons miss the cache. Layouts such as B-trees or the Eytzinger order keep the next few steps close together.',
      'On this page the array holds at most 14 items and the search compares plain integers. Real code compares keys of any type with a comparator.',
    ],
    interview: [
      'Say the cost with its reason: "Each comparison halves the range, so n items need at most log2 n plus one. A billion keys is about 30 comparisons."',
      'Name the form you need. "find" stops on any match; "lower bound" finds the first position at or after the key. Ranges, inserts and repeated keys all want lower bound.',
      'Write the midpoint as lo + (hi - lo) / 2 and say why: (lo + hi) can overflow a 32-bit int on a huge array. A bug of exactly this kind sat in Java\'s own Arrays.binarySearch for years.',
      'Be precise about the bounds. With hi inclusive the loop is while lo <= hi and you move hi = mid - 1; with hi exclusive it is while lo < hi and hi = mid. Mixing the two loops forever or skips an item.',
      'In a design, binary search is the step inside the bigger structure: within a B+ tree page, within an SSTable index block, within a Kafka offset index. The outer structure gets you to a small sorted run; binary search finishes the job.',
      'If asked to search unsorted data, do not reach for binary search. Scan once in O(n), or sort once in O(n log n) if many searches will follow.',
    ],
  },
};

export default def;
