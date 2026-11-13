import { CAPTION_ROOM, LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_H, TAG_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/FifoQueue.java?raw';
import python from './code/fifo_queue.py?raw';
import { info } from './info';

/**
 * First-in, first-out queue of integers on a singly linked list.
 *
 * `head` is the front, the next node to leave. `tail` is the back, the node
 * that joined last. Enqueue links a node after the tail and dequeue unlinks
 * the head, so neither ever walks the list. The same value may be queued more
 * than once: a queue is a sequence, not a set.
 */
export interface QNode {
  id: number;
  key: number;
  next: QNode | null;
  /** Where the node is drawn, counted in nodes since the queue was made. It never changes, so a node never slides along. */
  pos: number;
}

export interface FifoState {
  head: QNode | null;
  tail: QNode | null;
  size: number;
  nextId: number;
  /** Most nodes the queue will accept. The page draws 8; a real linked queue has no limit. */
  maxSize: number;
  /** The `pos` the next node will take. The null marker is drawn there. */
  nextPos: number;
  /** The `pos` drawn in the leftmost place on the canvas. Moves only when the row reaches the right-hand edge. */
  origin: number;
  // The two fields below exist only while an operation is being recorded. They tell layout() what to draw.
  /** A node that has been made but that tail does not point at yet. */
  draft: QNode | null;
  /** The old front node, after head has moved off it and before it is let go. */
  ghost: QNode | null;
}

/** Places across the canvas: up to eight nodes and the null marker after them. */
export const PLACES = 9;
export const MAX_SIZE = PLACES - 1;
export function create(maxSize = MAX_SIZE): FifoState {
  return { head: null, tail: null, size: 0, nextId: 1, maxSize, nextPos: 0, origin: 0, draft: null, ghost: null };
}

/** Contents from the front of the queue to the back. */
export function toArray(s: FifoState): number[] {
  const out: number[] = [];
  for (let n = s.head; n; n = n.next) out.push(n.key);
  return out;
}

const NULL_ID = 'null';
const nid = (n: QNode) => `n${n.id}`;
/** Each node has one outgoing pointer, so its edge is named after the node. */
const eid = (n: QNode) => `e${n.id}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Keep the row on the canvas. When the next node and the null marker after it
 * would fall off the right-hand edge, the drawing slides back so the front is
 * in the leftmost place again. A phone shows the left of the row first.
 * Only `origin` changes: no node and no pointer is touched.
 */
function reframe(s: FifoState): boolean {
  if (s.nextPos - s.origin <= PLACES - 2) return false;
  s.origin = s.head ? s.head.pos : s.nextPos;
  return true;
}

/** Join the back of the queue. Returns false only when the page's drawing limit is reached. */
export function enqueue(s: FifoState, key: number, rec: Rec): boolean {
  rec.vars({ key, size: s.size });
  rec.line('node');
  if (s.size >= s.maxSize) {
    rec.step(
      `Sorry, this page draws at most ${s.maxSize} nodes so they stay readable, and the queue holds ${s.size}. Dequeue one to make room for ${key}. A real linked queue has no limit, and that is its danger: it grows until memory runs out.`,
    );
    return false;
  }
  const slid = reframe(s);
  const node: QNode = { id: s.nextId++, key, next: null, pos: s.nextPos++ };
  const probe: Probe = { text: String(key), at: nid(node) };
  const before = s.size;
  if (rec.recording) s.draft = node;
  rec.vars({ key, node: key, head: s.head?.key ?? null, tail: s.tail?.key ?? null, size: s.size });
  rec.mark(nid(node), 'key');
  rec.step(
    `Make a node for ${key}. Its next pointer is null because it will be last in line. Nothing points at it yet, so it is not in the queue.` +
      (slid ? ` The drawing has slid back to the left to make room. Only the picture moved: no node was copied and no pointer changed.` : ``),
    { probe },
  );

  const old = s.tail;
  if (!old) {
    s.head = node;
    rec.vars({ key, node: key, head: key, tail: null, size: s.size });
    rec.count('writes');
    rec.line('first');
    rec.step(`The queue is empty, so the new node is the front as well as the back. Point head at it.`, { probe });
  } else {
    old.next = node;
    rec.vars({ key, node: key, head: s.head?.key ?? null, tail: old.key, 'tail.next': key, size: s.size });
    rec.count('writes');
    rec.markEdge(eid(old), 'ok');
    rec.line('link');
    rec.step(
      `tail leads straight to the last node, ${old.key}. Point its next at the new node. There is no walk from the front, however long the queue is.`,
      { probe },
    );
  }

  s.tail = node;
  rec.vars({ key, node: key, head: s.head?.key ?? null, tail: key, size: s.size });
  rec.count('writes');
  s.draft = null;
  rec.line('tail');
  rec.step(`Move tail to the new node. ${key} is now the back of the queue.`, { probe });

  s.size++;
  rec.vars({ key, node: key, head: s.head?.key ?? null, tail: key, size: s.size });
  rec.clearMarks();
  rec.mark(nid(node), 'key');
  rec.line('count');
  rec.step(
    `Add one to size, which makes ${s.size}. ${key} joined with 2 pointer writes and no reads. ` +
      (before === 0
        ? `It is the only item, so it is both the front and the back.`
        : `Nothing was searched, and the ${before === 1 ? 'item' : `${before} items`} ahead of it did not move.`),
    { probe },
  );
  return true;
}

/** Take the front item off and return it, or null when the queue is empty. */
export function dequeue(s: FifoState, rec: Rec): number | null {
  const node = s.head;
  rec.vars({ head: node?.key ?? null, tail: s.tail?.key ?? null, size: s.size });
  if (!node) {
    rec.mark(NULL_ID, 'bad');
    rec.line('empty');
    rec.step(`The queue is empty: head is null, so there is nothing to take. A real consumer would wait here until something is enqueued.`);
    return null;
  }
  const key = node.key;
  const probe: Probe = { text: String(key), at: nid(node) };
  rec.vars({ node: key, head: key, tail: s.tail?.key ?? null, size: s.size });
  rec.count('reads');
  rec.mark(nid(node), 'key');
  rec.line('front');
  rec.step(`Follow head. It leads straight to the front node, ${key}, which has waited longest, so it leaves first. Nothing is searched.`, { probe });

  const next = node.next;
  s.head = next;
  rec.vars({ node: key, 'node.next': next?.key ?? null, head: next?.key ?? null, tail: s.tail?.key ?? null, size: s.size });
  rec.count('writes');
  let writes = 1;
  if (rec.recording) s.ghost = node;
  rec.mark(nid(node), 'bad');
  rec.line('advance');
  rec.step(
    next
      ? `Point head at the next node, ${next.key}. That one write takes ${key} out of the queue. Nothing behind it shifts forward.`
      : `Point head at the next node. There is none, so head becomes null: ${key} was the only item.`,
    { probe },
  );

  if (!next) {
    s.tail = null;
    rec.vars({ node: key, 'node.next': null, head: null, tail: null, size: s.size });
    rec.count('writes');
    writes++;
    rec.line('clear_tail');
    rec.step(
      `tail still points at ${key}, which has left. Clear it as well. Forgetting this write is the classic bug: the next enqueue would link onto a node that is no longer in the queue.`,
      { probe },
    );
  }

  s.size--;
  rec.vars({ node: key, 'node.key': key, head: s.head?.key ?? null, tail: s.tail?.key ?? null, size: s.size });
  s.ghost = null;
  rec.clearMarks();
  rec.line('count');
  rec.step(
    `Take one from size, which leaves ${s.size}. ${key} is dequeued after 1 read and ${plural(writes, 'pointer write')}, whatever the length of the queue. ` +
      (s.head ? `${s.head.key} is the new front.` : `The queue is now empty.`),
  );
  return key;
}

/** Read the front item without removing it, or null when the queue is empty. */
export function peek(s: FifoState, rec: Rec): number | null {
  const node = s.head;
  rec.vars({ head: node?.key ?? null, 'head.key': node?.key });
  if (!node) {
    rec.mark(NULL_ID, 'bad');
    rec.line('empty');
    rec.step(`The queue is empty: head is null, so there is no front item to read.`);
    return null;
  }
  rec.count('reads');
  rec.mark(nid(node), 'ok');
  rec.line('front');
  rec.step(`head points straight at the front node, ${node.key}. Peek returns it and changes nothing: 1 read and no writes.`, {
    probe: { text: String(node.key), at: nid(node) },
  });
  return node.key;
}

// ---- layout ---------------------------------------------------------------

const BOX_W = 48;
const PITCH = 68;
/** How far below the row a node sits while it is not part of the queue. */
const DROP = 84;
const TOP = -(CELL_H / 2 + PROBE_H + 16);
/** head and tail are pointer tags just under the node they point at (over a node that has dropped out of the row). */
const TAG_GAP = 8;
const TAG_W = BOX_W;
const BOTTOM = DROP + CELL_H / 2 + CAPTION_ROOM + 4;

export function layout(s: FifoState): Scene {
  const x = (pos: number) => (pos - s.origin) * PITCH;
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  // Where each pointer points: a node's place, or the null marker.
  const tags: { name: 'head' | 'tail'; x: number; y: number }[] = [];
  const point = (name: 'head' | 'tail', px: number, py: number) => tags.push({ name, x: px, y: py });
  const draw = (n: QNode, out: 'new' | 'unlinked' | null) => {
    const y = out ? DROP : 0;
    if (n === s.head) point('head', x(n.pos), y);
    if (n === s.tail) point('tail', x(n.pos), y);
    nodes.push({
      id: nid(n),
      x: x(n.pos),
      y,
      cells: [{ text: String(n.key), w: BOX_W }],
      caption: out ?? undefined,
    });
    edges.push({ id: eid(n), from: nid(n), to: n.next ? nid(n.next) : NULL_ID, kind: 'side', arrow: true, dashed: out === 'unlinked' });
  };
  if (s.ghost) draw(s.ghost, 'unlinked');
  for (let n = s.head; n; n = n.next) if (n !== s.draft) draw(n, null);
  if (s.draft) draw(s.draft, 'new');

  if (!s.head) point('head', x(s.nextPos), 0);
  if (!s.tail) point('tail', x(s.nextPos), 0);
  nodes.push({
    id: NULL_ID,
    x: x(s.nextPos),
    y: 0,
    cells: [{ text: 'null', w: BOX_W, tone: 'dim' }],
  });
  // Under a node in the row, or over one that has dropped below it. Two on one node stack, head nearer.
  for (const t of tags) {
    const shared = t.name === 'tail' && tags.some((o) => o.name === 'head' && o.x === t.x && o.y === t.y);
    const dy = t.y === 0 ? CELL_H / 2 + TAG_GAP + TAG_H / 2 + (shared ? TAG_H + 4 : 0) : -(CELL_H / 2 + 4 + TAG_H / 2);
    nodes.push({ id: `ptr-${t.name}`, x: t.x, y: t.y + dy, cells: [{ text: t.name, w: TAG_W }], shape: 'tag' });
  }
  // Two empty labels pin the corners of the scene. The view then never re-centres, so a node that stays put in
  // memory stays put on screen, and it is plain that a dequeue shifts nothing.
  const decor: Decor[] = [
    { id: 'corner-a', type: 'label', x: -BOX_W / 2, y: TOP + LABEL_MAX * 0.65, text: '' },
    { id: 'corner-b', type: 'label', x: (PLACES - 1) * PITCH + BOX_W / 2, y: BOTTOM - LABEL_MAX * 0.65, text: '' },
  ];
  return { nodes, edges, decor };
}

// ---- definition -----------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

/** A key the queue does not hold yet, so the new item is easy to tell apart. */
function freshKey(s: FifoState): number {
  const have = new Set(toArray(s));
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!have.has(k)) return k;
  }
  return randomInt(1, 99);
}

const def: StructureDef<FifoState> = {
  id: 'fifo-queue',
  create: () => create(),
  seed: [17, 62, 41, 88].map((k) => ['enqueue', k] as [string, number]),
  ops: [
    { id: 'enqueue', label: 'Enqueue', intent: 'primary', args: [KEY], code: ['enqueue'], run: (s, [k], rec) => void enqueue(s, Number(k), rec), suggest: (s) => [freshKey(s)] },
    { id: 'dequeue', label: 'Dequeue', intent: 'danger', args: [], code: ['dequeue'], run: (s, _args, rec) => void dequeue(s, rec) },
    { id: 'peek', label: 'Peek', args: [], code: ['peek'], run: (s, _args, rec) => void peek(s, rec) },
  ],
  layout,
  counters: [
    { key: 'writes', label: 'Pointer writes' },
    { key: 'reads', label: 'Node reads' },
  ],
  status: (s) => [
    { label: 'Size', value: String(s.size) },
    { label: 'Front', value: s.head ? String(s.head.key) : 'none' },
    { label: 'Back', value: s.tail ? String(s.tail.key) : 'none' },
  ],
  tour: [['peek'], ['enqueue', 35], ['enqueue', 70], ['dequeue'], ['dequeue']],
  // Once the page's limit is reached the enqueue is refused, so fill can never overfill the canvas.
  fill: (s) => ['enqueue', freshKey(s)],
  source: { python, java },
  info,
};

export default def;
