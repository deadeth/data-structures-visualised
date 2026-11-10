import { randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import { info } from './info';

/**
 * LRU cache of integer keys.
 *
 * Two structures share the same nodes. A hash map goes from key to list node,
 * and a doubly linked list keeps the nodes in order of last use: head is the
 * most recent, tail is the least recent and the next to be evicted. Because
 * the map hands over the node itself, a hit is moved to the head by rewiring
 * a fixed number of pointers, with no walk along the list.
 *
 * Values are left out: the page shows keys only.
 */
export interface LNode {
  key: number;
  prev: LNode | null;
  next: LNode | null;
  /** Which cell of the drawn map holds this key. Kept so the map row never reshuffles. */
  slot: number;
}

/** A node that is out of the list for a moment, mid-operation. Only set while recording. */
interface Loose {
  node: LNode;
  /** List position it left behind, kept open until it lands. Null for a brand new node. */
  gap: number | null;
  /** True once it has been carried to the front and is waiting to be linked in. */
  front: boolean;
}

export interface LruState {
  capacity: number;
  map: Map<number, LNode>;
  head: LNode | null;
  tail: LNode | null;
  /** Free cells of the drawn map, lowest on top. */
  free: number[];
  /** Totals since the cache was built, for the hit rate. */
  hits: number;
  misses: number;
  evictions: number;
  loose: Loose | null;
}

const MAP = 'map';
const nid = (n: LNode) => `n${n.key}`;
/** Map entry to its list node. */
const pid = (n: LNode) => `p${n.key}`;
const nextId = (a: LNode, b: LNode) => `nx${a.key}-${b.key}`;
const prevId = (a: LNode, b: LNode) => `pv${a.key}-${b.key}`;

export function create(capacity: number): LruState {
  const cap = Math.max(1, Math.floor(capacity));
  const free: number[] = [];
  for (let i = cap - 1; i >= 0; i--) free.push(i);
  return { capacity: cap, map: new Map(), head: null, tail: null, free, hits: 0, misses: 0, evictions: 0, loose: null };
}

/** Keys from most recent to least recent. */
export function keysByRecency(s: LruState): number[] {
  const out: number[] = [];
  for (let n = s.head; n; n = n.next) out.push(n.key);
  return out;
}

/**
 * The chip while the key is at the map but not at any one entry. It sits beside
 * the map, because above the middle it would seem to point at whichever key is there.
 */
const atMap = (key: number): Probe => ({ text: String(key), at: MAP, place: 'left' });

/** Take a node out of the list. Two pointer writes, whatever its position. */
function unlink(s: LruState, x: LNode): void {
  if (x.prev) x.prev.next = x.next;
  else s.head = x.next;
  if (x.next) x.next.prev = x.prev;
  else s.tail = x.prev;
}

/** First half of linking at the head: the node's own two pointers. */
function aim(s: LruState, x: LNode): void {
  x.prev = null;
  x.next = s.head;
}

/** Second half: the old head's prev pointer (or the tail pointer of an empty list) and the head pointer. */
function attach(s: LruState, x: LNode): void {
  if (s.head) s.head.prev = x;
  else s.tail = x;
  s.head = x;
}

/** Position in the list. Walks it, so only call this while recording. */
function indexOf(s: LruState, x: LNode): number {
  let i = 0;
  for (let n = s.head; n && n !== x; n = n.next) i++;
  return i;
}

/**
 * The one hash lookup every operation starts with. Narrates the lookup and,
 * when the key is there, the equality check that confirms the entry.
 */
function find(s: LruState, key: number, rec: Rec, verdict: string): LNode | undefined {
  const text = String(key);
  rec.mark(MAP, 'path');
  rec.step(`Hash ${key} and look in the map. That is one lookup, and it costs the same in a cache of four keys or four million.`, {
    probe: atMap(key),
  });
  const x = s.map.get(key);
  if (!x) return undefined;
  rec.markCell(MAP, x.slot, 'compare');
  rec.compare(key, '=', x.key, verdict, { probe: { text, at: MAP, cell: x.slot } });
  rec.markCell(MAP, x.slot, 'path');
  return x;
}

/**
 * Move a node that is somewhere behind the head to the head: unlink (2 writes),
 * set its own pointers (2), then hook it in (2). Three frames.
 */
function moveToHead(s: LruState, x: LNode, rec: Rec, write: (n: number) => void): void {
  const probe: Probe = { text: String(x.key), at: nid(x) };
  const before = x.prev!;
  const after = x.next;
  const gap = rec.recording ? indexOf(s, x) : 0;

  unlink(s, x);
  write(2);
  if (rec.recording) s.loose = { node: x, gap, front: false };
  if (after) {
    rec.markEdge(nextId(before, after), 'ok');
    rec.markEdge(prevId(after, before), 'ok');
    rec.step(`Unlink ${x.key}. Its neighbours ${before.key} and ${after.key} now point at each other, so the list closes around the gap. Two pointer writes.`, { probe });
  } else {
    rec.step(`Unlink ${x.key} from the end. ${before.key}'s next pointer is cleared and ${before.key} becomes the tail. Two pointer writes.`, { probe });
  }

  const oldHead = s.head!;
  aim(s, x);
  write(2);
  if (rec.recording) s.loose = { node: x, gap, front: true };
  rec.markEdge(nextId(x, oldHead), 'ok');
  rec.step(`Carry ${x.key} to the front. Its next pointer aims at the current head, ${oldHead.key}, and its prev pointer is cleared. Two more writes.`, { probe });

  attach(s, x);
  write(2);
  s.loose = null;
  rec.markEdge(prevId(oldHead, x), 'ok');
  rec.step(`${oldHead.key}'s prev pointer and the cache's head pointer now aim at ${x.key}. Two more writes and it is linked in at the front.`, { probe });
}

/** Look a key up. A hit makes it the most recent. Returns whether it was cached. */
export function get(s: LruState, key: number, rec: Rec): boolean {
  let writes = 0;
  const write = (n: number) => {
    writes += n;
    rec.count('writes', n);
  };
  const x = find(s, key, rec, 'cached, follow its pointer to the node');
  if (!x) {
    s.misses++;
    rec.count('misses');
    rec.mark(MAP, 'bad');
    rec.step(`No entry for ${key}. The map alone answers "not cached", so the list is never searched.`, { probe: atMap(key) });
    rec.step(`Miss. Nothing in the cache changes. The caller has to fetch ${key} from the slow store behind the cache, and would normally put it afterwards.`);
    return false;
  }
  s.hits++;
  rec.count('hits');
  const probe: Probe = { text: String(key), at: nid(x) };
  rec.markEdge(pid(x), 'path');
  rec.mark(nid(x), 'path');
  if (s.head === x) {
    rec.step(`The entry points straight at the node. Nobody walked the list to find it.`, { probe });
    rec.clearMarks();
    rec.mark(nid(x), 'ok');
    rec.step(`Hit. ${key} is already the most recent, so nothing moves. Cost: one hash lookup and no pointer writes.`, { probe });
    return true;
  }
  rec.step(`The entry points straight at the node. Nobody walked the list to find it. Being read makes ${key} the most recent, so it must move to the head.`, { probe });
  moveToHead(s, x, rec, write);
  rec.clearMarks();
  rec.mark(nid(x), 'ok');
  rec.step(`Hit. ${key} is now the most recent and ${s.tail!.key} is next in line to be evicted. Cost: one hash lookup and ${writes} pointer writes, whatever the size of the cache.`, { probe });
  return true;
}

/**
 * Store a key. An existing key is refreshed and moved to the head. A new key
 * goes in at the head, after evicting the tail if the cache is full.
 * Returns the evicted key, or null.
 */
export function put(s: LruState, key: number, rec: Rec): number | null {
  let writes = 0;
  const write = (n: number) => {
    writes += n;
    rec.count('writes', n);
  };
  const text = String(key);
  const found = find(s, key, rec, 'already cached, refresh it');
  if (found) {
    const probe: Probe = { text, at: nid(found) };
    rec.markEdge(pid(found), 'path');
    rec.mark(nid(found), 'path');
    if (s.head === found) {
      rec.step(`Follow the pointer to the node. A real cache would overwrite the stored value here.`, { probe });
      rec.clearMarks();
      rec.mark(nid(found), 'ok');
      rec.step(`${key} was already cached and already the most recent, so nothing moves. Cost: one hash lookup and no pointer writes.`, { probe });
      return null;
    }
    rec.step(`Follow the pointer to the node. A real cache would overwrite the stored value here. A write counts as a use, so ${key} must move to the head.`, { probe });
    moveToHead(s, found, rec, write);
    rec.clearMarks();
    rec.mark(nid(found), 'ok');
    rec.step(`${key} was already cached, so the put only refreshed it. No new node and no eviction. Cost: one hash lookup and ${writes} pointer writes.`, { probe });
    return null;
  }

  const waiting = atMap(key);
  rec.step(`No entry for ${key}, so it is a new key and needs a node of its own. First check whether there is room.`, { probe: waiting });

  let evicted: number | null = null;
  const size = s.map.size;
  if (size >= s.capacity) {
    rec.compare(`size ${size}`, '=', `capacity ${s.capacity}`, 'full, evict the least recent', { probe: waiting });
    const victim = s.tail!;
    const before = victim.prev;
    rec.mark(nid(victim), 'bad');
    rec.markCell(MAP, victim.slot, 'bad');
    rec.markEdge(pid(victim), 'bad');
    rec.step(`The tail holds ${victim.key}, the key that has gone longest without being used. The list keeps it at the end, so picking the victim needs no search.`, { probe: waiting });

    unlink(s, victim);
    write(2);
    if (rec.recording) s.loose = { node: victim, gap: size - 1, front: false };
    rec.step(
      before
        ? `Unlink ${victim.key} from the list. ${before.key}'s next pointer is cleared and ${before.key} becomes the tail. Two pointer writes.`
        : `Unlink ${victim.key}. It was the only node, so the head and tail pointers are both cleared. Two pointer writes.`,
      { probe: waiting },
    );

    s.map.delete(victim.key);
    s.free.push(victim.slot);
    write(1);
    s.loose = null;
    s.evictions++;
    rec.count('evictions');
    evicted = victim.key;
    rec.markCell(MAP, victim.slot, 'idle');
    rec.step(`Delete ${victim.key} from the map as well, or the map would point at a node that no longer exists. ${victim.key} is evicted and its map slot is free.`, { probe: waiting });
  } else {
    rec.compare(`size ${size}`, '<', `capacity ${s.capacity}`, 'room for one more, nothing is evicted', { probe: waiting });
  }

  const oldHead = s.head;
  const x: LNode = { key, prev: null, next: null, slot: s.free.pop()! };
  aim(s, x);
  s.map.set(key, x);
  write(3);
  if (rec.recording) s.loose = { node: x, gap: null, front: true };
  rec.mark(nid(x), 'key');
  rec.markCell(MAP, x.slot, 'key');
  rec.markEdge(pid(x), 'ok');
  if (oldHead) rec.markEdge(nextId(x, oldHead), 'ok');
  rec.step(
    oldHead
      ? `Create a node for ${key} and add a map entry that points at it. The node's next pointer aims at the current head, ${oldHead.key}. Three writes: one map entry and the node's two pointers.`
      : `Create a node for ${key} and add a map entry that points at it. The list is empty, so both of the node's pointers stay empty. Three writes.`,
  );

  attach(s, x);
  write(2);
  s.loose = null;
  if (oldHead) rec.markEdge(prevId(oldHead, x), 'ok');
  rec.step(
    oldHead
      ? `${oldHead.key}'s prev pointer and the cache's head pointer now aim at ${key}. Two more writes and it is linked in at the front.`
      : `The head and tail pointers both aim at ${key}. Two more writes.`,
  );

  rec.clearMarks();
  rec.mark(nid(x), 'key');
  rec.markCell(MAP, x.slot, 'key');
  const full = s.map.size >= s.capacity;
  rec.step(
    evicted != null
      ? `${key} is cached as the most recent, and ${evicted} was evicted to make room. Cost: one hash lookup and ${writes} pointer writes, with no searching at any point.`
      : `${key} is cached as the most recent. The cache holds ${s.map.size} of ${s.capacity}${full ? `, so the next new key will evict ${s.tail!.key}` : ''}. Cost: one hash lookup and ${writes} pointer writes.`,
  );
  return evicted;
}

// ---- layout -----------------------------------------------------------------

/** Distance between list positions. */
const SPACING = 150;
const NODE_W = 56;
const MAP_CELL_W = 72;
const MAP_Y = 0;
const LIST_Y = 150;
/** A node that is out of the list is drawn raised, between the two rows. */
const LIFT_Y = LIST_Y - 52;
/** Where a node waits, raised and to the left of the head, before it is linked in. */
const STAGE_X = -SPACING * 0.75;
const LABEL_X = -52;

export function layout(s: LruState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  const cells: Cell[] = [];
  for (let i = 0; i < s.capacity; i++) cells.push({ text: '', w: MAP_CELL_W, tone: 'dim' });
  for (const n of s.map.values()) cells[n.slot] = { text: String(n.key), w: MAP_CELL_W };
  nodes.push({ id: MAP, x: ((s.capacity - 1) * SPACING) / 2, y: MAP_Y, cells });

  const loose = s.loose;
  const box = (n: LNode): Cell[] => [{ text: String(n.key), w: NODE_W }];
  let i = 0;
  let headX = 0;
  let tailX = 0;
  for (let n = s.head; n; n = n.next) {
    const slot = loose && loose.gap != null && i >= loose.gap ? i + 1 : i;
    const x = slot * SPACING;
    if (n === s.head) headX = x;
    if (n === s.tail) tailX = x;
    nodes.push({
      id: nid(n),
      x,
      y: LIST_Y,
      cells: box(n),
      caption: n === s.head ? (n === s.tail ? 'head and tail' : 'head') : n === s.tail ? 'tail' : undefined,
    });
    if (n.next) {
      edges.push({ id: nextId(n, n.next), from: nid(n), to: nid(n.next), kind: 'side', arrow: true, offset: -6 });
      edges.push({ id: prevId(n.next, n), from: nid(n.next), to: nid(n), kind: 'side', arrow: true, offset: 6 });
    }
    i++;
  }
  if (loose) {
    const x = loose.front ? STAGE_X : (loose.gap ?? 0) * SPACING;
    nodes.push({ id: nid(loose.node), x, y: LIFT_Y, cells: box(loose.node) });
    if (loose.front && loose.node.next) {
      edges.push({ id: nextId(loose.node, loose.node.next), from: nid(loose.node), to: nid(loose.node.next), kind: 'side', arrow: true, offset: -6 });
    }
  }
  for (const n of s.map.values()) edges.push({ id: pid(n), from: MAP, to: nid(n), kind: 'tree', fromCell: n.slot, arrow: true });

  decor.push({ id: 'l-map', type: 'label', x: LABEL_X, y: MAP_Y, text: 'Hash map', anchor: 'end', strong: true });
  decor.push({ id: 'l-list', type: 'label', x: LABEL_X, y: LIST_Y, text: 'Linked list', anchor: 'end', strong: true });
  // Two empty labels pin the scene's width to the full capacity plus the waiting spot,
  // so the view does not zoom in and out as nodes leave and join the list.
  decor.push({ id: 'pin-left', type: 'label', x: STAGE_X - NODE_W / 2, y: LIFT_Y, text: '' });
  decor.push({ id: 'pin-right', type: 'label', x: (s.capacity - 1) * SPACING + NODE_W / 2, y: LIFT_Y, text: '' });
  const labelY = LIST_Y + 54;
  if (s.head && s.head === s.tail) {
    decor.push({ id: 'l-recent', type: 'label', x: headX, y: labelY, text: 'most and least recent', anchor: 'middle' });
  } else if (s.head) {
    decor.push({ id: 'l-recent', type: 'label', x: headX, y: labelY, text: 'most recent', anchor: 'middle' });
    decor.push({ id: 'l-oldest', type: 'label', x: tailX, y: labelY, text: 'least recent', anchor: 'middle' });
  }
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: LruState): number {
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!s.map.has(k)) return k;
  }
  return randomInt(100, 999);
}

/** A cached key that is not already at the head, so the run shows a move. */
function cachedKey(s: LruState): number {
  const keys = keysByRecency(s);
  if (!keys.length) return 42;
  if (keys.length === 1) return keys[0];
  return keys[randomInt(1, keys.length - 1)];
}

const def: StructureDef<LruState> = {
  id: 'lru-cache',
  params: [
    {
      id: 'capacity',
      label: 'Capacity',
      default: 4,
      options: [3, 4, 5].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  create: (params) => create(params.capacity ?? 4),
  seed: [41, 12, 27].map((k) => ['put', k] as [string, number]),
  ops: [
    { id: 'get', label: 'Get', intent: 'primary', args: [KEY], run: (s, [k], rec) => void get(s, Number(k), rec), suggest: (s) => [cachedKey(s)] },
    { id: 'put', label: 'Put', args: [KEY], run: (s, [k], rec) => void put(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
  ],
  layout,
  counters: [
    { key: 'hits', label: 'Hits' },
    { key: 'misses', label: 'Misses' },
    { key: 'evictions', label: 'Evictions' },
    { key: 'writes', label: 'Pointer writes' },
  ],
  status: (s) => {
    const gets = s.hits + s.misses;
    return [
      { label: 'Size', value: `${s.map.size} of ${s.capacity}` },
      { label: 'Hit rate so far', value: gets ? `${Math.round((s.hits / gets) * 100)}% (${s.hits} of ${gets} gets)` : 'no gets yet' },
      { label: 'Next to be evicted', value: s.tail ? String(s.tail.key) : 'nothing' },
    ];
  },
  tour: [
    ['get', 41],
    ['put', 63],
    ['put', 85],
    ['get', 12],
    ['put', 41],
  ],
  info,
};

export default def;
