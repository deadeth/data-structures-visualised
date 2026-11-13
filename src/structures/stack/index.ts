import { CELL_H } from '../../core/geometry';
import { SUB_ROOM } from '../../core/fit';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/Stack.java?raw';
import python from './code/stack.py?raw';
import { info } from './info';

/**
 * Stack of integers on a plain array.
 *
 * `slots` is the array and `size` counts the slots in use, so the top item is
 * slots[size - 1] and the next push writes slots[size]. When a push finds the
 * array full it allocates one twice the size and copies every item across.
 * The same value may be pushed more than once: a stack is a sequence, not a set.
 */
export interface StackState {
  slots: (number | null)[];
  size: number;
  /** The largest array the stack will grow to. The page stops at 16 slots so the row stays readable. */
  maxCapacity: number;
  /** Counts the arrays allocated so far, so the slots of a new array get ids of their own. */
  gen: number;
  /** The larger array while a growth is being recorded. It tells layout() to draw it under the old one. */
  next: (number | null)[] | null;
}

export const START_CAPACITY = 4;
export const MAX_CAPACITY = 16;

export function create(maxCapacity = MAX_CAPACITY): StackState {
  return { slots: new Array<number | null>(START_CAPACITY).fill(null), size: 0, maxCapacity, gen: 0, next: null };
}

/** Contents from the bottom of the stack to the top. */
export const items = (s: StackState): number[] => s.slots.slice(0, s.size) as number[];

const SIZE = 'size';
const TOP = 'top';
const slotId = (gen: number, i: number) => `a${gen}s${i}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Allocate an array twice the size and copy every item into it, one frame per copy. */
function grow(s: StackState, rec: Rec, probe: Probe): number {
  const old = s.slots;
  const bigger = new Array<number | null>(old.length * 2).fill(null);
  if (rec.recording) s.next = bigger;
  rec.vars({ size: s.size, 'len(items)': old.length, 'len(bigger)': bigger.length });
  rec.line('allocate');
  rec.step(
    `Allocate a new array with twice the room: ${bigger.length} slots. An array cannot be stretched where it sits, so every item has to move to the new one.`,
    { probe },
  );
  for (let i = 0; i < s.size; i++) {
    bigger[i] = old[i];
    rec.count('copies');
    rec.count('writes');
    rec.mark(slotId(s.gen, i), 'path');
    rec.mark(slotId(s.gen + 1, i), 'ok');
    rec.vars({ size: s.size, i, 'items[i]': old[i], 'bigger[i]': bigger[i] });
    rec.line('copy');
    rec.step(
      i === 0
        ? `Copy ${old[i]} from slot 0 of the old array to slot 0 of the new one. Each item costs one write, so growing a stack of ${s.size} costs ${s.size} writes.`
        : `Copy ${old[i]} into slot ${i} of the new array. That is ${i + 1} of ${s.size} copies.`,
      { probe },
    );
  }
  s.slots = bigger;
  s.gen++;
  s.next = null;
  rec.clearMarks();
  rec.vars({ size: s.size, 'len(items)': bigger.length });
  rec.line('swap');
  rec.step(
    `Point the stack at the new array and let the old one go. Capacity is now ${bigger.length}, so ${plural(bigger.length - s.size, 'slot')} are free.`,
    { probe },
  );
  return s.size;
}

/** Put `key` on top. Returns false only when the page's drawing limit stops the array growing. */
export function push(s: StackState, key: number, rec: Rec): boolean {
  const label = String(key);
  const waiting: Probe = { text: label, at: SIZE };
  const capacity = s.slots.length;
  let copies = 0;
  rec.vars({ key, size: s.size, 'len(items)': capacity });
  rec.mark(SIZE, 'compare');
  rec.line('full');
  if (s.size === capacity) {
    rec.compare(`size ${s.size}`, '=', `capacity ${capacity}`, `the array is full, so it must grow before ${key} can be written`, { probe: waiting });
    if (capacity >= s.maxCapacity) {
      rec.mark(SIZE, 'bad');
      rec.step(
        `A real stack would now double to ${capacity * 2} slots. Sorry, this page stops at ${capacity} so the slots stay readable. Pop something to make room for ${key}.`,
        { probe: waiting },
      );
      return false;
    }
    rec.unmark(SIZE);
    copies = grow(s, rec, waiting);
  } else {
    rec.compare(`size ${s.size}`, '<', `capacity ${capacity}`, `there is a free slot, so nothing has to grow`, { probe: waiting });
    rec.unmark(SIZE);
  }

  const at = s.size;
  s.slots[at] = key;
  rec.count('writes');
  rec.mark(slotId(s.gen, at), 'key');
  rec.vars({ key, size: s.size, 'items[size]': key });
  const probe: Probe = { text: label, at: slotId(s.gen, at) };
  rec.line('write');
  rec.step(`Write ${key} into slot ${at}. The first free slot is always at index size, so there is nothing to search for and nothing to shift.`, {
    probe,
  });

  s.size++;
  rec.vars({ key, size: s.size, 'len(items)': s.slots.length });
  rec.mark(SIZE, 'ok');
  rec.line('up');
  const free = s.slots.length - s.size;
  rec.step(
    copies > 0
      ? `Add one to size: ${key} is on top. This push cost ${copies + 1} writes: ${plural(copies, 'copy', 'copies')} and 1 for ${key} itself. ` +
        (free > 0 ? `The next ${plural(free, 'push', 'pushes')} need no copying, so` : `Each doubling pays for as many cheap pushes as it copied, so`) +
        ` the average stays near one extra write per push. That is what amortised O(1) means.`
      : `Add one to size: ${key} is on top. The push cost one check and one write, however many items sit below it.` +
          (free === 0 ? ` The array is now full, so the next push will have to grow it.` : ``),
    { probe },
  );
  return true;
}

/** Take the top item off and return it, or null when the stack is empty. */
export function pop(s: StackState, rec: Rec): number | null {
  rec.vars({ size: s.size });
  rec.mark(SIZE, 'compare');
  rec.line('empty');
  if (s.size === 0) {
    rec.compare(`size ${s.size}`, '=', 0, `the stack is empty, so there is nothing to pop`);
    rec.mark(SIZE, 'bad');
    rec.line('nothing');
    rec.step(`Nothing is popped. One check showed the stack is empty, and no slot was touched. This is not an error here: pop simply returns nothing.`);
    return null;
  }
  const at = s.size - 1;
  const key = s.slots[at] as number;
  const probe: Probe = { text: String(key), at: slotId(s.gen, at) };
  rec.compare(`size ${s.size}`, '>', 0, `the stack is not empty, so there is a top item to take`, { probe });
  rec.unmark(SIZE);

  rec.mark(slotId(s.gen, at), 'key');
  rec.vars({ size: s.size, 'size - 1': at, key });
  rec.line('read');
  rec.step(`The top item is always at index size - 1, which is slot ${at}. Read ${key} from it. It was pushed last, so it leaves first.`, { probe });

  s.slots[at] = null;
  rec.vars({ size: s.size, 'size - 1': at, key, 'items[size - 1]': null });
  rec.count('writes');
  rec.mark(slotId(s.gen, at), 'bad');
  rec.line('clear');
  rec.step(`Clear slot ${at} so the stack no longer holds on to ${key}.`, { probe });

  s.size--;
  rec.vars({ size: s.size, key });
  rec.clearMarks();
  rec.mark(SIZE, 'ok');
  rec.line('down');
  rec.step(
    `Take one from size: ${key} is popped. It cost one check and one write, and no other item moved. ` +
      (s.size > 0 ? `The new top is ${s.slots[s.size - 1]}.` : `The stack is now empty.`) +
      (s.slots.length > START_CAPACITY && s.size <= s.slots.length / 4 ? ` The array keeps its ${s.slots.length} slots: this stack never shrinks.` : ``),
  );
  return key;
}

/** Read the top item without removing it, or null when the stack is empty. */
export function peek(s: StackState, rec: Rec): number | null {
  rec.vars({ size: s.size });
  rec.mark(SIZE, 'compare');
  rec.line('empty');
  if (s.size === 0) {
    rec.compare(`size ${s.size}`, '=', 0, `the stack is empty, so there is no top item`);
    rec.mark(SIZE, 'bad');
    rec.line('nothing');
    rec.step(`There is nothing to read. One check showed the stack is empty.`);
    return null;
  }
  const at = s.size - 1;
  const key = s.slots[at] as number;
  const probe: Probe = { text: String(key), at: slotId(s.gen, at) };
  rec.compare(`size ${s.size}`, '>', 0, `the stack is not empty, so there is a top item to read`, { probe });
  rec.unmark(SIZE);
  rec.mark(slotId(s.gen, at), 'ok');
  rec.vars({ size: s.size, 'size - 1': at, 'items[size - 1]': key });
  rec.line('read');
  rec.step(`The top item is ${key}, at index size - 1, which is slot ${at}. Peek reads it and leaves it where it is: one check and no writes.`, { probe });
  return key;
}

// ---- layout ---------------------------------------------------------------

const SLOT_W = 40;
const PITCH = SLOT_W + 3;
/** The size counter sits to the left of the array, clear of slot 0. */
const SIZE_X = -(SLOT_W + 14);
/** The top tag slides along under the index labels. */
const TAG_Y = CELL_H / 2 + SUB_ROOM + 4 + CELL_H / 2;
/** Where a new, larger array is drawn while items are copied into it. */
const NEXT_Y = TAG_Y + CELL_H + 18;
const NEXT_LABEL_Y = NEXT_Y + CELL_H / 2 + SUB_ROOM + 12;

function row(nodes: SceneNode[], slots: (number | null)[], gen: number, y: number): void {
  slots.forEach((v, i) => {
    nodes.push({ id: slotId(gen, i), x: i * PITCH, y, cells: [{ text: v === null ? '' : String(v), w: SLOT_W, sub: String(i) }] });
  });
}

export function layout(s: StackState): Scene {
  const nodes: SceneNode[] = [];
  nodes.push({ id: SIZE, x: SIZE_X, y: 0, cells: [{ text: String(s.size), w: SLOT_W }], title: 'size', caption: `of ${s.slots.length}` });
  row(nodes, s.slots, s.gen, 0);
  if (s.size > 0) nodes.push({ id: TOP, x: (s.size - 1) * PITCH, y: TAG_Y, cells: [{ text: 'top', w: SLOT_W + 4 }], shape: 'tag' });
  // An empty label that keeps the room under the array, so the view holds still when a new array appears there.
  const decor: Decor[] = [{ id: 'reserve', type: 'label', x: 0, y: NEXT_LABEL_Y + 10, text: '' }];
  if (s.next) {
    row(nodes, s.next, s.gen + 1, NEXT_Y);
    decor.push({ id: 'next-label', type: 'label', x: -SLOT_W / 2, y: NEXT_LABEL_Y, text: `New array, ${s.next.length} slots`, strong: true });
  }
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

/** A key the stack does not hold yet, so the new item is easy to tell apart. */
function freshKey(s: StackState): number {
  const have = new Set(items(s));
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!have.has(k)) return k;
  }
  return randomInt(1, 99);
}

const def: StructureDef<StackState> = {
  id: 'stack',
  create: () => create(),
  seed: [17, 42, 8].map((k) => ['push', k] as [string, number]),
  ops: [
    { id: 'push', label: 'Push', intent: 'primary', args: [KEY], code: ['push', 'grow'], run: (s, [k], rec) => void push(s, Number(k), rec), suggest: (s) => [freshKey(s)] },
    { id: 'pop', label: 'Pop', intent: 'danger', args: [], code: ['pop'], run: (s, _args, rec) => void pop(s, rec) },
    { id: 'peek', label: 'Peek', args: [], code: ['peek'], run: (s, _args, rec) => void peek(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Slot writes' },
    { key: 'copies', label: 'Copies on growth' },
  ],
  status: (s) => [
    { label: 'Size', value: String(s.size) },
    { label: 'Capacity', value: String(s.slots.length) },
    { label: 'Top', value: s.size ? String(s.slots[s.size - 1]) : 'none' },
  ],
  // The first push fills the last free slot, so the second one has to double the array.
  tour: [['peek'], ['push', 63], ['push', 25], ['pop'], ['pop']],
  fill: (s) => ['push', freshKey(s)],
  source: { python, java },
  info,
};

export default def;
