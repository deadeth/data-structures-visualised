import { CAPTION_ROOM, LABEL_LINE, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_H, TAG_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/PriorityQueue.java?raw';
import python from './code/priority_queue.py?raw';
import { info } from './info';

/**
 * Priority queue of integers on a sorted array. The smallest key is the most
 * urgent, as in Python's heapq.
 *
 * The array is kept sorted with the largest key first, so the smallest is
 * always the last slot in use and leaves without anything else moving. An
 * insert finds its slot by binary search, then shifts every smaller key one
 * slot to the right to open a gap. Keys are unique: this page keeps a set.
 */
export interface PQState {
  /** Fixed-size array. The first `size` slots hold keys, largest first. The rest are null. */
  slots: (number | null)[];
  size: number;
  /** The binary search window, lo up to but not including hi. Set only while an insert is being recorded. */
  window: { lo: number; hi: number } | null;
}

/** Slots the page draws. */
export const CAPACITY = 12;

export function create(capacity = CAPACITY): PQState {
  return { slots: new Array<number | null>(capacity).fill(null), size: 0, window: null };
}

/** Keys in array order: largest first, most urgent last. */
export const keys = (s: PQState): number[] => s.slots.slice(0, s.size) as number[];

const LO = 'lo';
const HI = 'hi';
const itemId = (key: number) => `k${key}`;
const emptyId = (i: number) => `e${i}`;
/** The node drawn in slot i: the key it holds, or the empty slot. */
const at = (s: PQState, i: number) => (s.slots[i] === null ? emptyId(i) : itemId(s.slots[i] as number));
const plural = (n: number, one: string, many = `${one}s`) => (n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`);
const range = (a: number, b: number) => (a === b ? `slot ${a} is` : `slots ${a} to ${b} are`);

/** Add `key`. Returns false, changing nothing, when the array is full or the key is already queued. */
export function insert(s: PQState, key: number, rec: Rec): boolean {
  const label = String(key);
  const n = s.size;
  rec.vars({ key, size: n });
  if (n === s.slots.length) {
    rec.line('full');
    rec.step(
      `Sorry, the array on this page has ${n} slots and all of them are in use, so ${key} is not inserted. Take the most urgent item to make room, then try again.`,
    );
    return false;
  }

  let lo = 0;
  let hi = n;
  let comparisons = 0;
  const middle = () => (lo + hi) >> 1;
  if (rec.recording) s.window = { lo, hi };
  rec.vars({ key, size: n, lo, hi });
  rec.line('window');
  rec.step(
    n === 0
      ? `The queue is empty, so there is nothing to compare ${key} with. lo and hi both start at 0.`
      : `The array is sorted, largest first, so binary search can find where ${key} belongs. The window starts as every item: lo is 0 and hi is ${hi}, one past the last.`,
    { probe: { text: label, at: at(s, n === 0 ? 0 : middle()) } },
  );

  while (lo < hi) {
    const mid = middle();
    const there = s.slots[mid] as number;
    const probe: Probe = { text: label, at: itemId(there) };
    const where =
      hi - lo === 1
        ? `Only slot ${mid} is left in the window, and it holds ${there}.`
        : `The window is slots ${lo} to ${hi - 1}, so the middle is slot ${mid}, which holds ${there}.`;
    comparisons++;
    rec.vars({ key, size: n, lo, hi, mid, 'items[mid]': there });
    rec.mark(itemId(there), 'compare');
    // One three-way decision per middle key, as in the listing. The frame that says which half is ruled out
    // already shows it dimmed and the tag moved, with the test and the branch it takes lit together.
    if (key < there) {
      const from = lo;
      for (let i = lo; i < mid; i++) rec.mark(at(s, i), 'dim');
      lo = mid + 1;
      if (rec.recording) s.window = { lo, hi };
      rec.vars({ key, size: n, lo, hi, mid, 'items[mid]': there });
      rec.line('mid', 'less', 'right');
      rec.compare(key, '<', there, `go right`, {
        probe,
        message: `${where} ${key} is smaller, and smaller keys sit further right, so ${range(from, mid)} ruled out. lo becomes ${lo}.`,
      });
      rec.mark(itemId(there), 'dim');
    } else if (key > there) {
      for (let i = mid + 1; i < hi; i++) rec.mark(at(s, i), 'dim');
      const top = hi - 1;
      hi = mid;
      if (rec.recording) s.window = { lo, hi };
      rec.vars({ key, size: n, lo, hi, mid, 'items[mid]': there });
      rec.line('mid', 'more', 'left');
      rec.compare(key, '>', there, `go left`, {
        probe,
        message: `${where} ${key} is larger, so it belongs here or further left, and ${range(mid, top)} ruled out. hi becomes ${mid}.`,
      });
      rec.mark(itemId(there), 'dim');
    } else {
      rec.line('mid', 'same', 'duplicate');
      rec.compare(key, '=', there, `already queued`, { probe, message: `${where} That is ${key} itself.` });
      rec.clearMarks();
      rec.mark(itemId(there), 'ok');
      s.window = null;
      rec.line('duplicate');
      rec.step(
        `${key} is already queued, so nothing changes. This page keeps one copy of each key. A real priority queue accepts equal priorities and needs a rule for ties, usually first come, first served.`,
        { probe },
      );
      return false;
    }
  }

  const pos = lo;
  rec.line('meet');
  rec.step(
    n === 0
      ? `With nothing to compare, ${key} belongs in slot 0.`
      : `lo and hi have met at ${pos}, so the window is empty and the search is over after ${plural(comparisons, 'comparison')} for ${plural(n, 'item')}. ${key} belongs in slot ${pos}: every key to its left is larger and every key from there on is smaller.`,
    { probe: { text: label, at: at(s, pos) } },
  );
  s.window = null;
  rec.clearMarks();

  const shifts = n - pos;
  for (let i = n; i > pos; i--) {
    const moved = s.slots[i - 1] as number;
    s.slots[i] = moved;
    s.slots[i - 1] = null;
    rec.vars({ key, size: n, lo: pos, i, 'items[i]': moved });
    rec.count('writes');
    rec.mark(itemId(moved), 'ok');
    rec.line('shift');
    rec.step(
      (i === n
        ? `Slot ${pos} is taken, so the ${shifts === 1 ? 'smaller key has' : `${shifts} smaller keys have`} to make room. Start at the end: move ${moved} from slot ${i - 1} to slot ${i}. Each move is one write.`
        : `Move ${moved} from slot ${i - 1} to slot ${i}.`) + (i === pos + 1 ? ` Slot ${pos} is now free.` : ``),
      { probe: { text: label, at: at(s, pos) } },
    );
  }

  s.slots[pos] = key;
  rec.vars({ key, size: n, lo: pos, 'items[lo]': key });
  rec.count('writes');
  rec.clearMarks();
  rec.mark(itemId(key), 'key');
  const probe: Probe = { text: label, at: itemId(key) };
  rec.line('place');
  rec.step(
    shifts === 0
      ? n === 0
        ? `Write ${key} into slot 0.`
        : `No key is smaller than ${key}, so nothing has to move. Write it into slot ${pos}, the first free slot at the end.`
      : `Write ${key} into the gap at slot ${pos}. The array is sorted again.`,
    { probe },
  );

  s.size++;
  rec.vars({ key, size: s.size, lo: pos });
  rec.line('done');
  const cost = `${key} is queued after ${plural(comparisons, 'comparison')} and ${plural(shifts, 'shift')}.`;
  rec.step(
    n === 0
      ? `${key} is queued. It is the only item, so it is the most urgent.`
      : shifts === 0
        ? `${cost} It is the new most urgent item, and a key that lands at the end is the cheapest insert there is.`
        : shifts === n
          ? `${cost} It is the largest key, so every item had to move: the worst case. The search is O(log n) but the shifting is O(n).`
          : `${cost} The search is O(log n) but the shifting is O(n), and that is the cost a binary heap avoids. The most urgent item is still ${s.slots[s.size - 1]}.`,
    { probe },
  );
  return true;
}

/** Take out the smallest key and return it, or null when the queue is empty. */
export function popMin(s: PQState, rec: Rec): number | null {
  rec.vars({ size: s.size });
  if (s.size === 0) {
    rec.line('empty');
    rec.step(`The queue is empty, so there is nothing to take.`);
    return null;
  }
  const last = s.size - 1;
  const key = s.slots[last] as number;
  const label = String(key);
  rec.vars({ size: s.size, 'size - 1': last, key });
  rec.mark(itemId(key), 'key');
  rec.line('last');
  rec.step(`The most urgent item is always in the last slot in use, at index size - 1, which is slot ${last}. That is ${key}. There is no search and no comparison.`, {
    probe: { text: label, at: itemId(key) },
  });

  s.slots[last] = null;
  rec.vars({ size: s.size, 'size - 1': last, key, 'items[size - 1]': null });
  rec.count('writes');
  rec.clearMarks();
  rec.mark(emptyId(last), 'bad');
  rec.line('clear');
  rec.step(`Take ${key} out and clear slot ${last}. Nothing sits after the last item, so nothing has to shift. Kept at the front, the smallest key would cost a shift of every other item.`, {
    probe: { text: label, at: emptyId(last) },
  });

  s.size--;
  rec.vars({ size: s.size, key });
  rec.clearMarks();
  rec.line('done');
  rec.step(
    `${key} is taken with 1 write and no comparisons, however many items are queued. ` +
      (s.size > 0 ? `The next most urgent is ${s.slots[s.size - 1]}.` : `The queue is now empty.`),
  );
  return key;
}

/** Read the smallest key without removing it, or null when the queue is empty. */
export function peek(s: PQState, rec: Rec): number | null {
  rec.vars({ size: s.size });
  if (s.size === 0) {
    rec.line('empty');
    rec.step(`The queue is empty, so there is no most urgent item to read.`);
    return null;
  }
  const last = s.size - 1;
  const key = s.slots[last] as number;
  rec.vars({ size: s.size, 'size - 1': last, 'items[size - 1]': key });
  rec.mark(itemId(key), 'ok');
  rec.line('last');
  rec.step(`The most urgent item is ${key}. It is always in the last slot in use, here slot ${last}, so peek reads it with no comparisons and no writes.`, {
    probe: { text: String(key), at: itemId(key) },
  });
  return key;
}

// ---- layout ---------------------------------------------------------------

const SLOT_W = 40;
const PITCH = SLOT_W + 3;
/** The caption under the most urgent item is wider than its slot, so the scene keeps this much clear at each end. */
const OVERHANG = 30;
/** The note above the array is two lines, so it starts a line higher, clear of the chip. */
const NOTE_Y = -(CELL_H / 2 + PROBE_H + 16 + 12 + LABEL_LINE);
/** The lo and hi tags sit on rows of their own under the two-line caption, so they can share a slot without touching. */
const LO_Y = CELL_H / 2 + SUB_ROOM + CAPTION_ROOM + LABEL_LINE + 6 + TAG_H / 2;
const HI_Y = LO_Y + TAG_H + 6;

export function layout(s: PQState): Scene {
  const nodes: SceneNode[] = [];
  // While keys are being shifted `size` lags behind, so find the last key by looking.
  let last = -1;
  s.slots.forEach((v, i) => {
    if (v !== null) last = i;
  });
  s.slots.forEach((v, i) => {
    if (v === null) nodes.push({ id: emptyId(i), x: i * PITCH, y: 0, cells: [{ text: '', w: SLOT_W, sub: String(i) }] });
    else nodes.push({ id: itemId(v), x: i * PITCH, y: 0, cells: [{ text: String(v), w: SLOT_W, sub: String(i) }], caption: i === last ? 'most\nurgent' : undefined });
  });
  if (s.window) {
    nodes.push({ id: LO, x: s.window.lo * PITCH, y: LO_Y, cells: [{ text: 'lo', w: SLOT_W }], shape: 'tag' });
    nodes.push({ id: HI, x: s.window.hi * PITCH, y: HI_Y, cells: [{ text: 'hi', w: SLOT_W }], shape: 'tag' });
  }
  const left = -SLOT_W / 2;
  const decor: Decor[] = [
    { id: 'note', type: 'label', x: left, y: NOTE_Y, text: 'Sorted, largest first.\nThe smallest key leaves first.', strong: true },
    // Two empty labels pin the corners, so the view holds still when the lo and hi tags come and go.
    { id: 'corner-a', type: 'label', x: left - OVERHANG, y: NOTE_Y, text: '' },
    { id: 'corner-b', type: 'label', x: (s.slots.length - 1) * PITCH + SLOT_W / 2 + OVERHANG, y: HI_Y + TAG_H / 2, text: '' },
  ];
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: PQState): number {
  const have = new Set(keys(s));
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!have.has(k)) return k;
  }
  for (let i = 0; i < 2000; i++) {
    const k = randomInt(100, 999);
    if (!have.has(k)) return k;
  }
  return randomInt(0, 999);
}

const def: StructureDef<PQState> = {
  id: 'priority-queue',
  create: () => create(),
  // Inserted out of order on purpose: the array sorts them as they arrive.
  seed: [41, 9, 67, 30, 84, 18, 52].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], code: ['insert'], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'popMin', label: 'Take most urgent', intent: 'danger', args: [], code: ['pop_min'], run: (s, _args, rec) => void popMin(s, rec) },
    { id: 'peek', label: 'Peek', args: [], code: ['peek'], run: (s, _args, rec) => void peek(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Slot writes' },
  ],
  status: (s) => [
    { label: 'Size', value: `${s.size} of ${s.slots.length}` },
    { label: 'Most urgent', value: s.size ? String(s.slots[s.size - 1]) : 'none' },
  ],
  // 35 lands in the middle and shifts three keys. 3 is smaller than everything, so it lands at the end and shifts none.
  tour: [['peek'], ['insert', 35], ['insert', 3], ['popMin'], ['popMin']],
  // A full array refuses the insert, so fill can never overfill the page.
  fill: (s) => ['insert', absentKey(s)],
  source: { python, java },
  info,
};

export default def;
