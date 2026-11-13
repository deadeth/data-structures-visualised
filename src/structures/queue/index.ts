import { LABEL_LINE, PROBE_H, probeWidth } from '../../core/fit';
import { CELL_H, boxWidth } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, VarValue } from '../../core/types';
import java from './code/RingBufferQueue.java?raw';
import python from './code/ring_buffer_queue.py?raw';
import { info } from './info';

/**
 * Bounded FIFO queue of integers, stored as a ring buffer.
 *
 * `slots` is a fixed array. `tail` is the index the next enqueue writes to and
 * `head` is the index the next dequeue reads from. Both wrap to 0 after the
 * last slot. head === tail when the buffer is empty and also when it is full,
 * so `size` is kept to tell the two apart.
 */
export interface QueueState {
  capacity: number;
  slots: (number | null)[];
  head: number;
  tail: number;
  size: number;
}

export function create(capacity: number): QueueState {
  return { capacity, slots: new Array<number | null>(capacity).fill(null), head: 0, tail: 0, size: 0 };
}

/** Contents from oldest to newest. */
export function items(s: QueueState): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.size; i++) out.push(s.slots[(s.head + i) % s.capacity] as number);
  return out;
}

// ---- scene ids --------------------------------------------------------------

const HUB = 'size';
const HEAD = 'head';
const TAIL = 'tail';
const PRODUCER = 'producer';
const CONSUMER = 'consumer';
const slotId = (i: number) => `s${i}`;

// ---- geometry ---------------------------------------------------------------

const SLOT_W = 48;
const TAG_W = 52;
/** Gap between a slot and the head or tail tag that sits outside it. */
const TAG_GAP = 6;
/** The probe chip as the renderer draws it. The widest one holds a three-digit key. */
const CHIP_W = probeWidth('999');
const CHIP_H = PROBE_H;
const CHIP_GAP_X = 10;
const CHIP_GAP_Y = 9;
/** The renderer keeps this much clear above every node for the chip. */
const CHIP_ROOM_ABOVE = PROBE_H + 16;
const END_W = boxWidth(['producer']);
/** Room under the producer and consumer for their captions. */
const END_BELOW = 18 + LABEL_LINE;

type Place = NonNullable<Probe['place']>;

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const boxAt = (x: number, y: number, w: number, h: number): Box => ({ x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 });

/** Where the chip is drawn next to a w by h node centred on (x, y). */
function chipBeside(x: number, y: number, w: number, h: number, place: Place): Box {
  if (place === 'above') return boxAt(x, y - h / 2 - CHIP_GAP_Y - CHIP_H / 2, CHIP_W, CHIP_H);
  if (place === 'below') return boxAt(x, y + h / 2 + CHIP_GAP_Y + CHIP_H / 2, CHIP_W, CHIP_H);
  if (place === 'left') return boxAt(x - w / 2 - CHIP_GAP_X - CHIP_W / 2, y, CHIP_W, CHIP_H);
  return boxAt(x + w / 2 + CHIP_GAP_X + CHIP_W / 2, y, CHIP_W, CHIP_H);
}

/** True when two boxes come within 2px of each other. */
const crowds = (a: Box, b: Box) => a.x1 < b.x2 + 2 && b.x1 < a.x2 + 2 && a.y1 < b.y2 + 2 && b.y1 < a.y2 + 2;

/** Ring radius per capacity: just wide enough that neighbouring slots do not touch. */
function radius(capacity: number): number {
  if (capacity <= 6) return 84;
  if (capacity <= 8) return 92;
  return Math.max(114, Math.ceil(9.5 * capacity));
}

/** How far a w by h box reaches from its centre along the unit direction (ux, uy). */
const reach = (w: number, h: number, ux: number, uy: number) => (w / 2) * Math.abs(ux) + (h / 2) * Math.abs(uy);

const round = (v: number) => Math.round(v * 100) / 100;

/** Unit vector from the ring centre to slot i. Index 0 is at the top and indices run clockwise. */
function direction(capacity: number, i: number): { ux: number; uy: number } {
  const angle = (2 * Math.PI * i) / capacity;
  return { ux: Math.sin(angle), uy: -Math.cos(angle) };
}

/**
 * Centre of a tag on slot i, measured from the ring centre. A tag sits just
 * outside its slot. When head and tail share a slot the two tags sit side by
 * side: `side` is -1 for the one behind (anticlockwise) and 1 for the one ahead.
 */
function tagOffset(capacity: number, r: number, i: number, side: -1 | 0 | 1): { x: number; y: number } {
  const { ux, uy } = direction(capacity, i);
  const out = r + reach(SLOT_W, CELL_H, ux, uy) + TAG_GAP + reach(TAG_W, CELL_H, ux, uy);
  // Clockwise tangent.
  const tx = -uy;
  const ty = ux;
  const shift = side * (reach(TAG_W, CELL_H, tx, ty) + 3);
  return { x: ux * out + tx * shift, y: uy * out + ty * shift };
}

/** The chip sits on the side of a tag that faces away from the ring. */
function placeFor(dx: number, dy: number): Place {
  return Math.abs(dy) > Math.abs(dx) + 0.5 ? (dy < 0 ? 'above' : 'below') : dx > 0 ? 'right' : 'left';
}

interface Frame {
  r: number;
  cx: number;
  cy: number;
  /** Fixed outer bounds, so the view does not rescale as the tags travel round. */
  width: number;
  height: number;
}

const frames = new Map<number, Frame>();

/**
 * Size the scene once per capacity, from every position a tag can take and the
 * chip beside it, so nothing is ever drawn outside the pinned corners.
 */
function frame(capacity: number): Frame {
  const cached = frames.get(capacity);
  if (cached) return cached;
  const r = radius(capacity);
  const tags: Box[] = [];
  const chips: Box[] = [];
  for (let i = 0; i < capacity; i++) {
    for (const side of [-1, 0, 1] as const) {
      const t = tagOffset(capacity, r, i, side);
      tags.push(boxAt(t.x, t.y, TAG_W, CELL_H));
      chips.push(chipBeside(t.x, t.y, TAG_W, CELL_H, placeFor(t.x, t.y)));
    }
  }
  let outX = 0;
  let up = 0;
  let down = 0;
  for (const b of tags) {
    outX = Math.max(outX, -b.x1, b.x2);
    up = Math.max(up, CHIP_ROOM_ABOVE - b.y1);
    down = Math.max(down, b.y2);
  }
  for (const b of chips) {
    outX = Math.max(outX, -b.x1, b.x2);
    up = Math.max(up, -b.y1);
    down = Math.max(down, b.y2);
  }
  const cx = Math.ceil(outX) + 2;
  const cy = Math.ceil(up) + 2;
  const width = cx * 2;
  let height = cy + Math.ceil(down) + 2;
  // The producer and consumer sit in the bottom corners. Lower the floor until each of them, with a chip
  // above it, is clear of every tag position, and no tag's chip lands on them.
  for (;;) {
    const y = height - END_BELOW - CELL_H / 2 - cy;
    const clash = [END_W / 2 - cx, cx - END_W / 2].some((x) => {
      const box = boxAt(x, y, END_W, CELL_H);
      const chip = chipBeside(x, y, END_W, CELL_H, 'above');
      return tags.some((t) => crowds(t, box) || crowds(t, chip)) || chips.some((c) => crowds(c, box));
    });
    if (!clash) break;
    height += 2;
  }
  const f: Frame = { r, cx, cy, width, height };
  frames.set(capacity, f);
  return f;
}

function slotAt(f: Frame, capacity: number, i: number): { x: number; y: number; ux: number; uy: number } {
  const { ux, uy } = direction(capacity, i);
  return { x: f.cx + f.r * ux, y: f.cy + f.r * uy, ux, uy };
}

/** Which side of a shared slot a tag takes. Empty: head caught tail, so head is behind. Full: tail caught head. */
function tagSide(s: QueueState, which: typeof HEAD | typeof TAIL): -1 | 0 | 1 {
  if (s.head !== s.tail) return 0;
  const headBehind = s.size === 0;
  return (which === HEAD) === headBehind ? -1 : 1;
}

/** Centre of the head or tail tag in the scene. */
function tagAt(s: QueueState, f: Frame, which: typeof HEAD | typeof TAIL): { x: number; y: number } {
  const t = tagOffset(s.capacity, f.r, which === HEAD ? s.head : s.tail, tagSide(s, which));
  return { x: round(f.cx + t.x), y: round(f.cy + t.y) };
}

function tagProbe(s: QueueState, which: typeof HEAD | typeof TAIL, text: string): Probe {
  const t = tagOffset(s.capacity, radius(s.capacity), which === HEAD ? s.head : s.tail, tagSide(s, which));
  return { text, at: which, place: placeFor(t.x, t.y) };
}

export function layout(s: QueueState): Scene {
  const f = frame(s.capacity);
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [
    { id: 'ring', type: 'ring', cx: f.cx, cy: f.cy, r: f.r },
    // Two empty labels pin the corners of the scene so the zoom stays put while the tags move.
    { id: 'corner-a', type: 'label', x: 0, y: 9, text: '' },
    { id: 'corner-b', type: 'label', x: f.width, y: f.height - 9, text: '' },
  ];
  for (let i = 0; i < s.capacity; i++) {
    const p = slotAt(f, s.capacity, i);
    const v = s.slots[i];
    nodes.push({
      id: slotId(i),
      x: round(p.x),
      y: round(p.y),
      cells: [{ text: v === null ? '' : String(v), w: SLOT_W }],
      hue: v === null ? undefined : 1,
    });
    // Index label just inside the ring.
    const inset = reach(SLOT_W, CELL_H, p.ux, p.uy) + 11;
    decor.push({ id: `i${i}`, type: 'label', x: round(p.x - p.ux * inset), y: round(p.y - p.uy * inset), text: String(i), anchor: 'middle' });
  }
  const head = tagAt(s, f, HEAD);
  const tail = tagAt(s, f, TAIL);
  nodes.push({ id: HEAD, x: head.x, y: head.y, cells: [{ text: 'head', w: TAG_W }], shape: 'tag' });
  nodes.push({ id: TAIL, x: tail.x, y: tail.y, cells: [{ text: 'tail', w: TAG_W }], shape: 'tag' });
  nodes.push({ id: HUB, x: f.cx, y: f.cy, cells: [{ text: String(s.size) }], title: 'size', caption: `of ${s.capacity}` });
  // The two ends of the pipe sit in the bottom corners, clear of the tags.
  const endY = f.height - 18 - CELL_H / 2;
  nodes.push({ id: PRODUCER, x: END_W / 2, y: endY, cells: [{ text: 'producer' }], hue: 5, caption: 'enqueues\nat tail' });
  nodes.push({ id: CONSUMER, x: f.width - END_W / 2, y: endY, cells: [{ text: 'consumer' }], hue: 5, caption: 'dequeues\nat head' });
  return { nodes, edges: [], decor };
}

// ---- operations -------------------------------------------------------------

const used = (s: QueueState) => `${s.size} of ${s.capacity} slots are in use`;

/** Add `key` at the tail. Returns false, writing nothing, when the buffer is full. */
export function enqueue(s: QueueState, key: number, rec: Rec): boolean {
  const label = String(key);
  const waiting: Probe = { text: label, at: PRODUCER };
  // The listing's fields, after the operation's argument.
  // capacity only where the lit line reads it, as the strip is narrow.
  const show = (extra?: Record<string, VarValue>) =>
    rec.vars({ key, size: s.size, capacity: extra ? undefined : s.capacity, head: s.head, tail: s.tail, ...extra });
  rec.vars();
  show();
  rec.mark(HUB, 'compare');
  rec.line('check');
  if (s.size === s.capacity) {
    rec.compare(`size ${s.size}`, '=', `capacity ${s.capacity}`, `the buffer is full, so nothing can be written`, { probe: waiting });
    rec.count('rejected');
    rec.mark(HUB, 'bad');
    rec.mark(PRODUCER, 'bad');
    rec.line('rejected');
    rec.step(
      `There is no free slot, so nothing is written and tail stays on slot ${s.tail}. The producer must now wait, drop ${key} or return an error.`,
      { probe: waiting },
    );
    rec.step(`${key} is rejected after one check and no writes. Pushing the problem back to the sender like this is called backpressure.`, {
      probe: waiting,
    });
    return false;
  }
  rec.compare(`size ${s.size}`, '<', `capacity ${s.capacity}`, `there is room, so write at tail`, { probe: waiting });
  rec.unmark(HUB);

  const at = s.tail;
  s.slots[at] = key;
  rec.count('writes');
  rec.mark(slotId(at), 'key');
  show({ 'slots[tail]': key });
  rec.line('write');
  rec.step(
    `Write ${key} into slot ${at}, the slot tail points at. Tail always marks the next free slot, so there is nothing to search for or shift.`,
    { probe: rec.recording ? tagProbe(s, TAIL, label) : undefined },
  );

  const next = (at + 1) % s.capacity;
  s.tail = next;
  s.size++;
  const full = s.size === s.capacity;
  const wrapped = next === 0;
  rec.mark(TAIL, 'ok');
  show();
  rec.line('advance');
  rec.step(
    `tail = (${at} + 1) mod ${s.capacity} = ${next}. ` +
      (wrapped && full
        ? `Tail wraps round to slot 0 and meets head there, so the buffer is now full.`
        : wrapped
          ? `Tail ran off the end of the array, so it wraps round to slot 0, which a dequeue freed earlier.`
          : full
            ? `Tail has caught up with head, so the buffer is now full.`
            : `Tail moves on to the next slot, ready for the next write.`),
  );

  rec.clearMarks();
  rec.mark(slotId(at), 'key');
  rec.line('done');
  rec.step(`${key} is enqueued. It took one check and one write, whatever the queue holds. ${used(s)}.`);
  return true;
}

/** Remove and return the oldest item, or null when the buffer is empty. */
export function dequeue(s: QueueState, rec: Rec): number | null {
  // key is the local the listing reads into; undefined leaves it out until then.
  const show = (key?: number, extra?: Record<string, VarValue>) =>
    rec.vars({ key, size: s.size, capacity: extra ? undefined : s.capacity, head: s.head, tail: s.tail, ...extra });
  rec.vars();
  show();
  rec.mark(HUB, 'compare');
  rec.line('check');
  if (s.size === 0) {
    rec.compare(`size ${s.size}`, '=', 0, `there is nothing to read`);
    rec.mark(HUB, 'bad');
    rec.line('empty');
    rec.step(
      `Nothing is dequeued. One check showed the queue is empty: head and tail both sit on slot ${s.head}, and a real consumer would wait here until something is enqueued.`,
    );
    return null;
  }
  rec.compare(`size ${s.size}`, '>', 0, `there is something to read, so read at head`);
  rec.unmark(HUB);

  const at = s.head;
  const value = s.slots[at] as number;
  const label = String(value);
  rec.count('reads');
  rec.mark(slotId(at), 'key');
  show(value, { 'slots[head]': value });
  rec.line('read');
  rec.step(`Read ${value} from slot ${at}, the slot head points at. It has waited longest, so it leaves first: first in, first out.`, {
    probe: rec.recording ? tagProbe(s, HEAD, label) : undefined,
  });

  const gone: Probe = { text: label, at: CONSUMER };
  s.slots[at] = null;
  rec.mark(slotId(at), 'bad');
  rec.mark(CONSUMER, 'ok');
  show(value, { 'slots[head]': null });
  rec.line('free');
  rec.step(`${value} goes to the consumer and slot ${at} is free again. Real ring buffers rarely wipe the slot: moving head past it is enough.`, {
    probe: gone,
  });

  const next = (at + 1) % s.capacity;
  s.head = next;
  s.size--;
  const empty = s.size === 0;
  const wrapped = next === 0;
  rec.mark(HEAD, 'ok');
  show(value);
  rec.line('advance');
  rec.step(
    `head = (${at} + 1) mod ${s.capacity} = ${next}. ` +
      (wrapped && empty
        ? `Head wraps round to slot 0 and meets tail there, so the queue is now empty.`
        : wrapped
          ? `Head ran off the end of the array, so it wraps round to slot 0 just as tail did.`
          : empty
            ? `Head has caught up with tail, so the queue is now empty.`
            : `Head moves on to the next oldest item.`),
    { probe: gone },
  );

  rec.clearMarks();
  rec.line('done');
  rec.step(`${value} is dequeued. It took one check and one read, and nothing had to shift. ${used(s)}.`, { probe: gone });
  return value;
}

// ---- definition -------------------------------------------------------------

const def: StructureDef<QueueState> = {
  id: 'queue',
  params: [
    {
      id: 'capacity',
      label: 'Capacity',
      default: 8,
      options: [6, 8, 12].map((v) => ({ value: v, label: `${v} slots` })),
    },
  ],
  create: (params) => create(params.capacity ?? 8),
  // Seven in, two out: five items left in slots 2 to 6, so tail is one write away from wrapping.
  seed: [['enqueue', 17], ['enqueue', 62], ['enqueue', 41], ['enqueue', 88], ['enqueue', 23], ['enqueue', 35], ['enqueue', 91], ['dequeue'], ['dequeue']],
  ops: [
    {
      id: 'enqueue',
      label: 'Enqueue',
      intent: 'primary',
      args: [{ name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 }],
      code: ['enqueue', 'fields'],
      run: (s, [k], rec) => void enqueue(s, Number(k), rec),
      suggest: () => [randomInt(1, 99)],
    },
    { id: 'dequeue', label: 'Dequeue', args: [], code: ['dequeue', 'fields'], run: (s, _args, rec) => void dequeue(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Slot writes' },
    { key: 'reads', label: 'Slot reads' },
    { key: 'rejected', label: 'Rejected' },
  ],
  status: (s) => [
    { label: 'Size', value: `${s.size} of ${s.capacity}` },
    { label: 'Head index', value: String(s.head) },
    { label: 'Tail index', value: String(s.tail) },
  ],
  // Written for the default capacity of 8: tail wraps on the first step, the buffer fills on the third,
  // the fourth is rejected, and the key that was turned away gets in once a dequeue has made room.
  tour: [['enqueue', 56], ['enqueue', 9], ['enqueue', 74], ['enqueue', 50], ['dequeue'], ['enqueue', 50]],
  info,
  source: { python, java },
};

export default def;
