import { randomInt } from '../../core/rng';
import type { Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/SinglyLinkedList.java?raw';
import python from './code/singly_linked_list.py?raw';

/**
 * Singly linked list of integers with head and tail pointers.
 *
 * The list is treated as a set. Ruling out a duplicate would cost a full walk
 * in a bare list, which would hide the O(1) prepend and append this page is
 * about, so the state also keeps a Set of the keys present. That set is used
 * for the duplicate check only, with recording on or off. Search and delete
 * never look at it: they walk.
 */
export interface LNode {
  id: number;
  key: number;
  next: LNode | null;
}

export interface ListState {
  head: LNode | null;
  tail: LNode | null;
  size: number;
  nextId: number;
  /** Keys present. Only ever used to refuse duplicates in one step. */
  keys: Set<number>;
  // The three fields below exist only while an operation is being recorded. They tell layout() what to draw.
  /** A node that has been created but is not fully linked in yet. */
  draft: { node: LNode; where: 'front' | 'back' } | null;
  /** A node that has been unlinked but not yet let go, and the slot it used to fill. */
  ghost: { node: LNode; slot: number } | null;
  /** The node a delete is remembering as "previous". */
  prev: LNode | null;
}

/** Most nodes the page will draw. Applies only while recording, so the head-to-head page can load thousands. */
export const CAP = 12;

const NULL_ID = 'null';
const nid = (n: LNode) => `n${n.id}`;
/** Each node has one outgoing pointer, so its edge is named after the node. */
const eid = (n: LNode) => `e${n.id}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function create(): ListState {
  return { head: null, tail: null, size: 0, nextId: 1, keys: new Set(), draft: null, ghost: null, prev: null };
}

export function toArray(s: ListState): number[] {
  const out: number[] = [];
  for (let n = s.head; n; n = n.next) out.push(n.key);
  return out;
}

/** Walk to the node holding `key`. Only for highlighting while recording; the algorithms do their own walks. */
function locate(s: ListState, key: number): LNode | null {
  for (let n = s.head; n; n = n.next) if (n.key === key) return n;
  return null;
}

function insert(s: ListState, key: number, where: 'front' | 'back', rec: Rec): boolean {
  const label = String(key);
  if (s.keys.has(key)) {
    if (rec.recording) {
      const at = locate(s, key);
      if (at) rec.mark(nid(at), 'ok');
      rec.line('duplicate');
      rec.step(
        `${key} is already in the list, so nothing changes. This page looked it up in a set of keys it keeps on the side; a bare list would have had to walk its nodes to know.`,
        at ? { probe: { text: label, at: nid(at) } } : {},
      );
    }
    return false;
  }
  if (rec.recording && s.size >= CAP) {
    // The cap belongs to the page, not the algorithm, so no line of the body is lit.
    rec.line('page_limit');
    rec.step(
      `Sorry, this page draws at most ${CAP} nodes so they stay readable, and the list is full. Delete a key to make room. A real linked list has no such limit.`,
    );
    return false;
  }

  const node: LNode = { id: s.nextId++, key, next: null };
  const probe = { text: label, at: nid(node) };
  const before = s.size;
  s.keys.add(key);
  if (rec.recording) {
    rec.line('check');
    rec.step(
      `A bare list could only rule out a duplicate by walking every node, so this page keeps a set of its keys on the side. The set says ${key} is new.`,
    );
    s.draft = { node, where };
    rec.mark(nid(node), 'key');
  }

  if (!s.head) {
    rec.line('make');
    rec.step(`Make a node for ${key}. Its next pointer is null, and nothing points to it yet.`, { probe });
    s.head = node;
    s.tail = node;
    s.size++;
    rec.count('writes', 2);
    s.draft = null;
    rec.line('first');
    rec.step(`The list was empty, so head and tail both take the new node. ${key} is stored with 2 pointer writes.`, { probe });
    return true;
  }

  if (where === 'front') {
    const old = s.head;
    rec.line('make');
    rec.step(`Make a node for ${key}. Nothing points to it yet, so it is not part of the list.`, { probe });
    node.next = old;
    rec.count('writes');
    rec.markEdge(eid(node), 'ok');
    rec.line('link');
    rec.step(`Write 1: point the new node's next at the current head, ${old.key}. Anyone walking from head still sees the old list.`, { probe });
    s.head = node;
    rec.count('writes');
    s.size++;
    s.draft = null;
    rec.clearMarks();
    rec.mark(nid(node), 'key');
    rec.line('move');
    rec.step(
      `Write 2: move head to the new node. ${key} is now first after 2 pointer writes and no walk. It would cost the same with ${plural(before, 'node')} or a million.`,
      { probe },
    );
    return true;
  }

  const old = s.tail!;
  rec.line('make');
  rec.step(`Make a node for ${key}. Its next pointer is null because it will be the last node.`, { probe });
  old.next = node;
  rec.count('writes');
  rec.markEdge(eid(old), 'ok');
  rec.line('link');
  rec.step(`Write 1: the tail pointer leads straight to the last node, ${old.key}. Change its next pointer from null to the new node.`, { probe });
  s.tail = node;
  rec.count('writes');
  s.size++;
  s.draft = null;
  rec.clearMarks();
  rec.mark(nid(node), 'key');
  rec.line('move');
  rec.step(
    `Write 2: move tail to the new node. ${key} is now last after 2 pointer writes. Without a tail pointer, getting here would have meant walking ${before === 1 ? 'the node' : `all ${before} nodes`} first.`,
    { probe },
  );
  return true;
}

export const prepend = (s: ListState, key: number, rec: Rec): boolean => insert(s, key, 'front', rec);
export const append = (s: ListState, key: number, rec: Rec): boolean => insert(s, key, 'back', rec);

export function search(s: ListState, key: number, rec: Rec): boolean {
  const label = String(key);
  if (!s.head) {
    rec.markCell(NULL_ID, 0, 'bad');
    rec.line('start', 'missing');
    rec.step(`The list is empty: head is null, so there is nothing to walk and ${key} is not here.`, { probe: { text: label, at: NULL_ID } });
    return false;
  }
  rec.line('start');
  rec.step(`Start at head. A list has no index, so the only way to reach a node is to follow next pointers from the front.`, {
    probe: { text: label, at: nid(s.head) },
  });
  let seen = 0;
  for (let cur: LNode | null = s.head; cur; cur = cur.next) {
    seen++;
    rec.count('reads');
    const probe = { text: label, at: nid(cur) };
    rec.mark(nid(cur), 'compare');
    if (cur.key === key) {
      rec.line('compare');
      rec.compare(key, '=', cur.key, `match`, { probe });
      rec.mark(nid(cur), 'ok');
      rec.line('found');
      rec.step(
        `Found ${key} after reading ${seen} of the ${plural(s.size, 'node')}, one comparison each. The further along a key sits, the longer the walk.`,
        { probe },
      );
      return true;
    }
    rec.line('compare', 'next');
    rec.compare(key, '≠', cur.key, cur.next ? `not this one, follow its next pointer` : `not this one, and its next pointer is null`, { probe });
    rec.mark(nid(cur), 'path');
    rec.markEdge(eid(cur), 'path');
  }
  rec.markCell(NULL_ID, 0, 'bad');
  rec.line('missing');
  rec.step(`Reached null, the end of the list, so ${key} is not here. A miss always reads every node: ${seen} this time.`, {
    probe: { text: label, at: NULL_ID },
  });
  return false;
}

export function remove(s: ListState, key: number, rec: Rec): boolean {
  const label = String(key);
  if (!s.head) {
    rec.line('start', 'missing');
    rec.step(`The list is empty, so there is nothing to delete.`);
    return false;
  }
  rec.line('start');
  rec.step(
    `Start at head. Unlinking a node means changing the node before it, and a node cannot look backwards, so the walk remembers the previous node as it goes.`,
    { probe: { text: label, at: nid(s.head) } },
  );
  let prev: LNode | null = null;
  let cur: LNode | null = s.head;
  let slot = 0;
  let seen = 0;
  while (cur) {
    seen++;
    rec.count('reads');
    const probe = { text: label, at: nid(cur) };
    rec.mark(nid(cur), 'compare');
    if (cur.key === key) {
      rec.line('compare');
      rec.compare(key, '=', cur.key, `match, this is the node to unlink`, { probe });
      break;
    }
    rec.line('compare', 'next');
    rec.compare(key, '≠', cur.key, cur.next ? `not this one, remember it as prev and move on` : `not this one, and its next pointer is null`, { probe });
    rec.mark(nid(cur), 'path');
    rec.markEdge(eid(cur), 'path');
    prev = cur;
    if (rec.recording) s.prev = cur;
    cur = cur.next;
    slot++;
  }
  if (!cur) {
    s.prev = null;
    rec.markCell(NULL_ID, 0, 'bad');
    rec.line('missing');
    rec.step(`Reached null without a match. ${key} is not in the list, so nothing is deleted. The walk read all ${plural(seen, 'node')}.`, {
      probe: { text: label, at: NULL_ID },
    });
    return false;
  }

  const next = cur.next;
  const probe = { text: label, at: nid(cur) };
  let writes = 0;
  rec.mark(nid(cur), 'bad');
  if (rec.recording) s.ghost = { node: cur, slot };
  if (prev) {
    prev.next = next;
    rec.count('writes');
    writes++;
    rec.markEdge(eid(prev), 'ok');
    rec.line('unlink');
    rec.step(
      next
        ? `Write prev's next pointer to skip ${key}: ${prev.key} now points at ${next.key}. Nothing in the list leads to ${key} any more.`
        : `Write prev's next pointer to skip ${key}: ${prev.key} now points at null. No next pointer leads to ${key} any more, but tail still does.`,
      { probe },
    );
  } else {
    s.head = next;
    rec.count('writes');
    writes++;
    rec.line('unlink_head');
    rec.step(
      next
        ? `${key} is the head, so there is no previous node to rewire. Move head to its next node, ${next.key}.`
        : `${key} is the only node, so there is no previous node to rewire. Head becomes null.`,
      { probe },
    );
  }
  if (!next) {
    s.tail = prev;
    rec.count('writes');
    writes++;
    rec.line('move_tail');
    rec.step(
      prev
        ? `${key} was also the tail, so the tail pointer moves back to prev, ${prev.key}. Forgetting this write is a classic bug.`
        : `It was the tail as well, so tail becomes null too. The list is empty.`,
      { probe },
    );
  }
  s.keys.delete(key);
  s.size--;
  s.ghost = null;
  s.prev = null;
  rec.clearMarks();
  rec.line('done');
  rec.step(
    `${key} is deleted and its node can be freed. Finding it took ${plural(seen, 'comparison')}; unlinking it took ${plural(writes, 'pointer write')}. The walk is the cost, not the unlink.`,
  );
  return true;
}

// ---- layout ----------------------------------------------------------------

const BOX_W = 50;
const PITCH = 74;
/** How far below the row a node sits while it is not part of the list. */
const DROP = 84;

export function layout(s: ListState): Scene {
  // The row in drawing order: the list itself, plus any node that is half in or half out.
  const row: LNode[] = [];
  for (let n = s.head; n; n = n.next) row.push(n);
  const draft = s.draft;
  if (draft && !row.includes(draft.node)) {
    if (draft.where === 'front') row.unshift(draft.node);
    else row.push(draft.node);
  }
  const ghost = s.ghost;
  if (ghost && !row.includes(ghost.node)) row.splice(Math.min(ghost.slot, row.length), 0, ghost.node);

  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  row.forEach((n, i) => {
    const isDraft = draft?.node === n;
    const isGhost = ghost?.node === n;
    const out = isDraft || isGhost;
    const names: string[] = [];
    if (n === s.head) names.push('head');
    if (n === s.tail) names.push('tail');
    nodes.push({
      id: nid(n),
      x: i * PITCH,
      y: out ? DROP : 0,
      cells: [{ text: String(n.key), w: BOX_W }],
      title: names.length ? names.join(', ') : undefined,
      caption: isDraft ? 'new' : isGhost ? 'unlinked' : n === s.prev ? 'prev' : undefined,
    });
    // A new node at the front has no next pointer worth drawing until it is written.
    if (n.next || !(isDraft && draft!.where === 'front' && s.head)) {
      edges.push({ id: eid(n), from: nid(n), to: n.next ? nid(n.next) : NULL_ID, kind: 'side', arrow: true, dashed: isGhost });
    }
  });
  nodes.push({
    id: NULL_ID,
    x: row.length * PITCH,
    y: 0,
    cells: [{ text: 'null', w: BOX_W, tone: 'dim' }],
    title: s.head ? undefined : 'head, tail',
  });
  // An empty label that reserves the space below the row, so the view holds still when a node drops out of line.
  return { nodes, edges, decor: [{ id: 'reserve', type: 'label', x: 0, y: DROP + 27, text: '' }] };
}

// ---- definition ------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: ListState): number {
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!s.keys.has(k)) return k;
  }
  for (let i = 0; i < 2000; i++) {
    const k = randomInt(100, 999);
    if (!s.keys.has(k)) return k;
  }
  return randomInt(0, 999);
}

/** The key a given fraction of the way along the list. */
function keyAt(s: ListState, fraction: number): number {
  if (!s.head) return 42;
  let n = s.head;
  for (let i = Math.round((s.size - 1) * fraction); i > 0 && n.next; i--) n = n.next;
  return n.key;
}

const def: StructureDef<ListState> = {
  id: 'linked-list',
  create: () => create(),
  seed: [23, 7, 61, 42, 15].map((k) => ['append', k] as [string, number]),
  ops: [
    { id: 'prepend', label: 'Prepend', intent: 'primary', args: [KEY], code: ['prepend', 'node'], run: (s, [k], rec) => void prepend(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'append', label: 'Append', intent: 'primary', args: [KEY], code: ['append', 'node'], run: (s, [k], rec) => void append(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], code: ['search', 'node'], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [keyAt(s, 0.8)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], code: ['delete', 'node'], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [keyAt(s, 0.5)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Nodes visited' },
    { key: 'writes', label: 'Pointer writes' },
  ],
  status: (s) => [
    { label: 'Length', value: String(s.size) },
    { label: 'Head', value: s.head ? String(s.head.key) : 'null' },
    { label: 'Tail', value: s.tail ? String(s.tail.key) : 'null' },
  ],
  tour: [
    ['search', 42],
    ['prepend', 88],
    ['append', 30],
    ['delete', 61],
    ['search', 99],
  ],
  // Fill runs with recording off, where there is no cap, so it holds itself to the cap: once full it re-offers a key already present, which is a no-op.
  fill: (s) => ['append', s.size >= CAP && s.head ? s.head.key : absentKey(s)],
  bench: { insert: 'append', search: 'search' },
  source: { python, java },
  info: {
    summary:
      'A linked list is a chain of nodes. Each node holds a key and a pointer to the next node, and the list itself keeps just two pointers, to the first node (head) and the last (tail). Nothing is stored by position, so adding or removing a node is a pointer write or two, and finding one means walking from the head.',
    watch: [
      'Prepend and append never walk. Each is two pointer writes, however long the list is.',
      'Search has no shortcut. It reads one node at a time from the head, and a miss reads all of them.',
      'Delete is a search followed by one pointer write. It has to remember the previous node, because a singly linked node cannot look backwards.',
      'Deleting the head or the tail also moves the head or tail pointer. Those edge cases are where list code usually goes wrong.',
      'This page treats the list as a set and checks a hidden set of keys before each insert. A bare list would need a full walk to rule out a duplicate.',
    ],
    complexity: [
      { op: 'Prepend', average: 'O(1)', worst: 'O(1)', note: 'Two pointer writes.' },
      { op: 'Append', average: 'O(1)', worst: 'O(1)', note: 'Only because of the tail pointer. Without one it is O(n).' },
      { op: 'Search', average: 'O(n)', worst: 'O(n)', note: 'About n/2 nodes for a hit on average, all n for a miss.' },
      { op: 'Delete by key', average: 'O(n)', worst: 'O(n)', note: 'The walk dominates. The unlink is one write.' },
      { op: 'Insert or remove at a known node', average: 'O(1)', worst: 'O(1)', note: 'A singly linked list also needs the node before it. A doubly linked list stores that in every node.' },
      { op: 'Access by position', average: 'O(n)', worst: 'O(n)', note: 'No random access: the i-th node is i hops from the head.' },
    ],
    space: 'O(n), with one pointer per node on top of the key (two if doubly linked). Each node is usually its own allocation, which adds allocator overhead.',
    usedIn: [
      { name: 'LRU caches', how: 'A hash map finds the entry and a doubly linked list keeps entries in order of last use. A hit moves its node to the front in O(1) and eviction takes the node at the back. Java\'s LinkedHashMap in access order works this way.' },
      { name: 'Hash table chains', how: 'Separate chaining hangs a short linked list off each bucket to hold colliding keys. Java\'s HashMap does this, and turns a bucket into a red-black tree if its chain grows long.' },
      { name: 'Memory allocators', how: 'Free blocks of one size are threaded into a singly linked free list through the freed memory itself, so allocate and free are a pop and a push. glibc malloc keeps its tcache and fast bins like this.' },
      { name: 'Linux kernel list_head', how: 'An intrusive, circular, doubly linked list: the next and prev pointers are embedded in the struct being listed, so no separate node is allocated. It is used throughout the kernel, including the list of all tasks.' },
      { name: 'Michael-Scott queue', how: 'A lock-free FIFO queue built from singly linked nodes, with head and tail moved by compare-and-swap. Java\'s ConcurrentLinkedQueue is based on it.' },
      { name: 'Java LinkedBlockingQueue', how: 'A blocking queue of linked nodes with one lock for the head and another for the tail, so a producer and a consumer can work at the same time.' },
      { name: 'Graph adjacency lists', how: 'Each vertex keeps a list of its neighbours. The textbook form is a linked list per vertex, though many implementations now use arrays for faster iteration.' },
    ],
    reachFor: [
      'You already hold the node and need to remove or move it in constant time, as an LRU cache does on every hit.',
      'A queue or stack where all the work is at the ends and an occasional resize pause is not acceptable.',
      'Other parts of the system hold references to elements, and those must stay valid while neighbours come and go.',
      'Concurrent queues, where a new node can be linked in with a single compare-and-swap.',
    ],
    costs: [
      'Search and access by position are O(n). Even with sorted keys there is no binary search, because there is no way to jump to the middle.',
      'Nodes are scattered across the heap, so a walk misses the CPU cache again and again. Scanning an array of the same keys is usually much faster.',
      'A pointer per node, plus allocator overhead. For small keys the bookkeeping can outweigh the data.',
      'A singly linked node cannot reach its predecessor. Removing a node needs the one before it, and removing the tail means a walk to find the new tail.',
      'For a plain sequence, a dynamic array is the better default: appends are amortised O(1) and iteration is fast.',
    ],
    interview: [
      'A linked list is rarely the answer on its own, but it is inside many answers: the recency list in an LRU cache, the chains in a hash table, the nodes of a concurrent queue.',
      'Say when it beats an array: constant-time removal when you already hold the node, references that stay valid as the collection changes, and no resize pauses, since a dynamic array sometimes copies everything to grow.',
      'Say when it loses: anything that searches or iterates. An array is one block of memory that the cache can read ahead in; list nodes are scattered.',
      'The O(1) insert and delete come with a condition: you must already hold the node. Finding it by key is O(n), which is why an LRU cache pairs the list with a hash map that points straight at the nodes.',
      'Singly or doubly linked? Singly saves a pointer and is enough for stacks, queues and hash chains. Unlinking an arbitrary node in O(1) needs a prev pointer, so LRU lists are doubly linked.',
      'A head and a tail pointer give you a FIFO queue with O(1) at both ends: add at the tail, take from the head.',
    ],
  },
};

export default def;
