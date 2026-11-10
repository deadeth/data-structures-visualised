import { tidyTree } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/BinarySearchTree.java?raw';
import python from './code/binary_search_tree.py?raw';

/**
 * Plain binary search tree of integers. Nothing ever rebalances it.
 *
 * Every key in a node's left subtree is smaller than the node's key and every
 * key in its right subtree is larger. All operations are loops, never
 * recursion: fed sorted keys the tree becomes one long chain, and a chain of
 * 5,000 nodes would overflow the call stack.
 */
export interface BstNode {
  id: number;
  key: number;
  left: BstNode | null;
  right: BstNode | null;
  /** Parent at the time of insertion. Only used to animate the node's arrival. */
  origin?: number;
}

export interface BstState {
  root: BstNode | null;
  size: number;
  nextId: number;
}

/** Limits that apply only while an operation is being animated, so the drawing stays readable. */
export const MAX_LEVELS = 7;
export const MAX_KEYS = 20;

const nid = (n: BstNode) => `n${n.id}`;
const eid = (a: BstNode, b: BstNode) => `e${a.id}-${b.id}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function create(): BstState {
  return { root: null, size: 0, nextId: 1 };
}

/** Number of levels: nodes on the longest path from the root down. An empty tree has 0. */
export function height(s: BstState): number {
  if (!s.root) return 0;
  let best = 0;
  const stack: [BstNode, number][] = [[s.root, 1]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (d > best) best = d;
    if (n.left) stack.push([n.left, d + 1]);
    if (n.right) stack.push([n.right, d + 1]);
  }
  return best;
}

/** Fewest levels that can hold n keys: ceil(log2(n + 1)). */
export function bestHeight(n: number): number {
  let h = 0;
  while (2 ** h - 1 < n) h++;
  return h;
}

/** In-order traversal: left subtree, node, right subtree. Yields the keys in sorted order. */
export function keys(s: BstState): number[] {
  const out: number[] = [];
  const stack: BstNode[] = [];
  let n = s.root;
  while (n || stack.length) {
    while (n) {
      stack.push(n);
      n = n.left;
    }
    n = stack.pop()!;
    out.push(n.key);
    n = n.right;
  }
  return out;
}

/** Grey out a subtree the search has just ruled out. Only does anything while recording. */
function dimSubtree(rec: Rec, parent: BstNode, top: BstNode | null): void {
  if (!rec.recording || !top) return;
  rec.markEdge(eid(parent, top), 'dim');
  const stack = [top];
  while (stack.length) {
    const n = stack.pop()!;
    rec.mark(nid(n), 'dim');
    for (const c of [n.left, n.right]) {
      if (!c) continue;
      rec.markEdge(eid(n, c), 'dim');
      stack.push(c);
    }
  }
}

interface Walk {
  /** The node holding the key, or null if the walk fell off the tree. */
  node: BstNode | null;
  /** Parent of `node`, or the last node visited when the key is absent. */
  parent: BstNode | null;
  /** Side of `parent` the walk left by, or would have. */
  side: 'left' | 'right';
  /** Level of the last node visited. The root is level 1. */
  level: number;
  comparisons: number;
  /** True if every move so far went the same way. */
  allLeft: boolean;
  allRight: boolean;
}

/** Walk down from the root towards `key`, one comparison per node. */
function descend(s: BstState, key: number, rec: Rec, mode: 'search' | 'insert' | 'delete'): Walk {
  const w: Walk = { node: null, parent: null, side: 'left', level: 0, comparisons: 0, allLeft: true, allRight: true };
  let node = s.root;
  if (!rec.recording) {
    // Head-to-head runs: the bare walk, with no sentences built along the way.
    while (node) {
      w.level++;
      if (key === node.key) {
        w.node = node;
        break;
      }
      w.parent = node;
      if (key < node.key) {
        w.side = 'left';
        w.allRight = false;
        node = node.left;
      } else {
        w.side = 'right';
        w.allLeft = false;
        node = node.right;
      }
    }
    w.comparisons = w.level;
    rec.count('reads', w.level);
    rec.count('comparisons', w.level);
    return w;
  }
  while (node) {
    const k = node.key;
    const probe: Probe = { text: String(key), at: nid(node) };
    rec.count('reads');
    rec.mark(nid(node), 'compare');
    w.level++;
    w.comparisons++;
    if (key === k) {
      const verdict = mode === 'insert' ? 'match, already stored' : mode === 'delete' ? 'match, this is the node to delete' : 'match';
      rec.line('match');
      rec.compare(key, '=', k, verdict, { probe });
      w.node = node;
      return w;
    }
    const goLeft = key < k;
    const side = goLeft ? 'left' : 'right';
    const word = goLeft ? 'smaller' : 'larger';
    const next = goLeft ? node.left : node.right;
    const other = goLeft ? node.right : node.left;
    let verdict: string;
    let message: string;
    if (next) {
      verdict = `${word}, go ${side}`;
      message = other
        ? `${key} is ${word} than ${k}, so it can only be in the ${side} subtree. The other side is ruled out without being read.`
        : `${key} is ${word} than ${k}, so go ${side}.`;
    } else if (mode === 'insert') {
      verdict = `${word}, and the ${side} spot is free`;
      message = `${key} is ${word} than ${k}, and ${k} has no ${side} child. This is where ${key} belongs.`;
    } else {
      verdict = `${word}, but there is no ${side} child`;
      message = `${key} is ${word} than ${k}, but ${k} has no ${side} child. The walk has run out of tree.`;
    }
    // An insert that finds the spot free stops on the test for it; every other move takes the child pointer.
    rec.line(!next && mode === 'insert' ? `${side}_free` : side);
    rec.compare(key, goLeft ? '<' : '>', k, verdict, { probe, message });
    rec.mark(nid(node), 'path');
    dimSubtree(rec, node, other);
    if (next) rec.markEdge(eid(node, next), 'path');
    if (goLeft) w.allRight = false;
    else w.allLeft = false;
    w.parent = node;
    w.side = side;
    node = next;
  }
  return w;
}

export function search(s: BstState, key: number, rec: Rec): boolean {
  if (!s.root) {
    rec.line('start', 'missing');
    rec.step(`The tree is empty, so ${key} is not here.`);
    return false;
  }
  rec.line('start');
  rec.step(`Start at the root. Each comparison picks one side and throws the other away.`, { probe: { text: String(key), at: nid(s.root) } });
  const w = descend(s, key, rec, 'search');
  if (w.node) {
    rec.mark(nid(w.node), 'ok');
    rec.line('found');
    rec.step(`Found ${key} after ${plural(w.comparisons, 'comparison')}, one per level on the way down. A search never costs more than the height of the tree.`, {
      probe: { text: String(key), at: nid(w.node) },
    });
    return true;
  }
  const last = w.parent!;
  rec.mark(nid(last), 'bad');
  rec.line('missing');
  rec.step(`${key} is not in the tree. The empty ${w.side} spot under ${last.key} is the only place it could be. That took ${plural(w.comparisons, 'comparison')}.`);
  return false;
}

export function insert(s: BstState, key: number, rec: Rec): boolean {
  if (!s.root) {
    const root: BstNode = { id: s.nextId++, key, left: null, right: null };
    s.root = root;
    s.size++;
    rec.count('writes');
    rec.mark(nid(root), 'key');
    rec.line('root');
    rec.step(`The tree is empty, so ${key} becomes the root. No comparisons needed.`, { probe: { text: String(key), at: nid(root) } });
    return true;
  }
  rec.line('start');
  rec.step(`Start at the root. Smaller keys go left and larger keys go right, until the walk reaches an empty spot.`, {
    probe: { text: String(key), at: nid(s.root) },
  });
  const w = descend(s, key, rec, 'insert');
  if (w.node) {
    rec.mark(nid(w.node), 'ok');
    rec.line('duplicate');
    rec.step(`${key} is already stored, so nothing changes. The tree holds each key once.`);
    return false;
  }
  const parent = w.parent!;
  const level = w.level + 1;
  // The limits exist only to keep the drawing readable. With recording off the tree grows freely.
  // Their frames keep the line of the last comparison lit: the walk found the free spot and stopped there.
  if (rec.recording && s.size >= MAX_KEYS) {
    rec.step(
      `${key} belongs under ${parent.key}, but this page stops at ${MAX_KEYS} keys so the drawing stays readable. Nothing was added. Delete a key or reset to make room.`,
    );
    return false;
  }
  if (rec.recording && level > MAX_LEVELS) {
    rec.step(
      `${key} belongs under ${parent.key}, on level ${level}, but this page stops at ${MAX_LEVELS} levels so the drawing stays readable. Nothing was added. A real tree has no such limit and keeps growing.`,
    );
    return false;
  }
  const node: BstNode = { id: s.nextId++, key, left: null, right: null, origin: parent.id };
  if (w.side === 'left') parent.left = node;
  else parent.right = node;
  s.size++;
  rec.count('writes');
  if (!rec.recording) return true;

  rec.mark(nid(node), 'key');
  rec.markEdge(eid(parent, node), 'ok');
  rec.line(`attach_${w.side}`);
  rec.step(`Attach ${key} as the ${w.side} child of ${parent.key}. A new key always becomes a leaf, and nothing else in the tree moves.`, {
    probe: { text: String(key), at: nid(node) },
  });
  const h = height(s);
  const best = bestHeight(s.size);
  const cost = `${key} is stored after ${plural(w.comparisons, 'comparison')}.`;
  let shape: string;
  if (h === best) {
    shape = `The tree holds ${plural(s.size, 'key')} in ${plural(h, 'level')}, the fewest possible.`;
  } else if (level >= 3 && (w.allRight || w.allLeft)) {
    const order = w.allRight ? 'ascending' : 'descending';
    shape = `Keys arriving in ${order} order always go ${w.side}, so the tree grows a spine like a linked list: ${h} levels now, where ${s.size} keys need only ${best}.`;
  } else {
    shape = `The tree is ${h} levels tall. Balanced, ${s.size} keys would fit in ${best}.`;
  }
  rec.clearMarks();
  rec.mark(nid(node), 'key');
  rec.line('done');
  rec.step(`${cost} ${shape}`);
  return true;
}

export function remove(s: BstState, key: number, rec: Rec): boolean {
  if (!s.root) {
    rec.line('start', 'missing');
    rec.step(`The tree is empty, so there is nothing to delete.`);
    return false;
  }
  rec.line('start');
  rec.step(`To delete ${key}, first find it, exactly as a search would.`, { probe: { text: String(key), at: nid(s.root) } });
  const w = descend(s, key, rec, 'delete');
  const node = w.node;
  if (!node) {
    rec.mark(nid(w.parent!), 'bad');
    rec.line('missing');
    rec.step(`${key} is not in the tree, so there is nothing to delete. That took ${plural(w.comparisons, 'comparison')}.`);
    return false;
  }
  const parent = w.parent;
  /** Point whatever held `old` (a parent's left or right, or the root) at `next` instead. */
  const relink = (above: BstNode | null, old: BstNode, next: BstNode | null) => {
    if (!above) s.root = next;
    else if (above.left === old) above.left = next;
    else above.right = next;
  };
  /** The line of the listing's relink helper that such a call runs. */
  const relinkLine = (above: BstNode | null, old: BstNode) => (!above ? 'relink_root' : above.left === old ? 'relink_left' : 'relink_right');
  const probe: Probe = { text: String(key), at: nid(node) };
  let writes = 1;

  if (node.left && node.right) {
    rec.mark(nid(node), 'key');
    rec.line('two_children');
    rec.step(
      `${key} has two children, so it cannot simply be unlinked. Find its in-order successor, the smallest key larger than ${key}, and let that key take over.`,
      { probe },
    );
    let above = node;
    let succ = node.right;
    rec.count('reads');
    rec.markEdge(eid(above, succ), 'path');
    rec.mark(nid(succ), 'compare');
    rec.line('succ_start');
    rec.step(`The successor is in the right subtree, where every key is larger than ${key}. Step right once, to ${succ.key}, then look for the smallest key there.`, { probe });
    rec.line('succ_left');
    while (succ.left) {
      rec.mark(nid(succ), 'path');
      rec.markEdge(eid(succ, succ.left), 'path');
      above = succ;
      succ = succ.left;
      rec.count('reads');
      rec.mark(nid(succ), 'compare');
      if (rec.recording) rec.step(`${above.key} has a left child, so there is something smaller. Walk left to ${succ.key}.`, { probe });
    }
    rec.mark(nid(succ), 'ok');
    rec.line('succ_found');
    rec.step(`${succ.key} has no left child, so nothing in this subtree is smaller. ${succ.key} is the successor of ${key}.`, { probe });
    node.key = succ.key;
    rec.count('writes');
    rec.mark(nid(node), 'ok');
    rec.mark(nid(succ), 'bad');
    rec.line('overwrite');
    rec.step(
      `Write ${succ.key} over ${key}. The node stays where it is and keeps both children: only its key changes. For a moment ${succ.key} is in the tree twice.`,
    );
    const up = succ.right;
    rec.line('remove_succ', relinkLine(above, succ));
    relink(above, succ, up);
    rec.count('writes');
    writes = 2;
    rec.step(
      up
        ? `Remove the old ${succ.key}. It has no left child, so this is the one-child case: its right child ${up.key} moves up into its place.`
        : `Remove the old ${succ.key}. It has no children, so this is the leaf case: it is unlinked from ${above.key}.`,
    );
  } else if (node.left || node.right) {
    const child = (node.left ?? node.right)!;
    rec.mark(nid(node), 'bad');
    rec.mark(nid(child), 'ok');
    rec.line('one_child', relinkLine(parent, node));
    rec.step(
      parent
        ? `${key} has one child, ${child.key}. That child takes its place. Everything under ${child.key} was already on the correct side of ${parent.key}, so nothing else moves.`
        : `${key} is the root and has one child, ${child.key}. That child becomes the new root, and nothing else moves.`,
      { probe },
    );
    relink(parent, node, child);
    rec.count('writes');
  } else {
    rec.mark(nid(node), 'bad');
    rec.line('leaf', relinkLine(parent, node));
    rec.step(
      parent
        ? `${key} is a leaf, with no children. This is the easy case: unlink it from ${parent.key} and it is gone.`
        : `${key} is the only key in the tree. Remove it and the tree is empty.`,
      { probe },
    );
    relink(parent, node, null);
    rec.count('writes');
  }
  s.size--;
  if (!rec.recording) return true;

  rec.clearMarks();
  // In the two-children case the node survives, holding the successor's key.
  if (writes === 2) rec.mark(nid(node), 'ok');
  const cost = `${plural(w.comparisons, 'comparison')} to find it and ${plural(writes, 'write')} to remove it`;
  rec.line('done');
  rec.step(
    s.size
      ? `${key} is deleted: ${cost}. The tree now holds ${plural(s.size, 'key')} in ${plural(height(s), 'level')}.`
      : `${key} is deleted: ${cost}. The tree is empty.`,
  );
  return true;
}

const R = 22;

export function layout(s: BstState): Scene {
  if (!s.root) return { nodes: [], edges: [], decor: [{ id: 'empty', type: 'label', x: 0, y: 0, text: 'The tree is empty', anchor: 'middle' }] };
  const pos = tidyTree<BstNode>({
    root: s.root,
    // A missing child still holds its side, so a lone left child does not sit straight below its parent.
    children: (n) => (n.left || n.right ? [n.left, n.right] : []),
    width: () => R * 2,
    gapX: 14,
    gapY: 74,
    nullWidth: 24,
  });
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  for (const [n, p] of pos) {
    nodes.push({
      id: nid(n),
      x: p.x,
      y: p.y,
      shape: 'circle',
      r: R,
      cells: [{ text: String(n.key) }],
      from: n.origin != null ? `n${n.origin}` : undefined,
    });
    if (n.left) edges.push({ id: eid(n, n.left), from: nid(n), to: nid(n.left), kind: 'line' });
    if (n.right) edges.push({ id: eid(n, n.right), from: nid(n), to: nid(n.right), kind: 'line' });
  }
  return { nodes, edges };
}

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

/** Level a key would land on if inserted now, or 0 if it is already present. */
function landingLevel(s: BstState, key: number): number {
  let level = 1;
  for (let n = s.root; n; level++) {
    if (key === n.key) return 0;
    n = key < n.key ? n.left : n.right;
  }
  return level;
}

/** A random key that is not stored and would fit inside the drawing limits, if there is one. */
function roomyKey(s: BstState): number | null {
  if (s.size >= MAX_KEYS) return null;
  for (let i = 0; i < 80; i++) {
    const k = randomInt(1, 99);
    const level = landingLevel(s, k);
    if (level > 0 && level <= MAX_LEVELS) return k;
  }
  return null;
}

function absentKey(s: BstState): number {
  const roomy = roomyKey(s);
  if (roomy != null) return roomy;
  for (let i = 0; i < 200; i++) {
    const k = randomInt(0, 999);
    if (landingLevel(s, k) > 0) return k;
  }
  return 0;
}

function presentKey(s: BstState): number {
  const all = keys(s);
  return all.length ? all[randomInt(0, all.length - 1)] : 42;
}

/** Prefer a node with two children: it is the delete worth watching. */
function deleteSuggestion(s: BstState): number {
  const both: number[] = [];
  const stack: BstNode[] = s.root ? [s.root] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.left && n.right) both.push(n.key);
    if (n.left) stack.push(n.left);
    if (n.right) stack.push(n.right);
  }
  return both.length && Math.random() < 0.6 ? both[randomInt(0, both.length - 1)] : presentKey(s);
}

const def: StructureDef<BstState> = {
  id: 'bst',
  create: () => create(),
  // Arrival order matters: this order gives a bushy tree. The same keys sorted would give a chain.
  seed: [50, 27, 73, 14, 38, 62, 85, 33, 45].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], code: ['insert', 'node'], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], code: ['search', 'node'], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], code: ['delete', 'relink', 'node'], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [deleteSuggestion(s)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Nodes visited' },
    { key: 'writes', label: 'Writes' },
  ],
  status: (s) => [
    { label: 'Keys', value: String(s.size) },
    { label: 'Height', value: plural(height(s), 'level') },
    { label: 'Best possible height', value: plural(bestHeight(s.size), 'level') },
  ],
  tour: [
    ['search', 45],
    ['insert', 56],
    ['delete', 50],
    ['insert', 90],
    ['insert', 94],
    ['insert', 97],
  ],
  // "Add random keys" stays inside the drawing limits. When the tree is full it re-offers a stored key, which is a no-op.
  fill: (s) => ['insert', roomyKey(s) ?? s.root?.key ?? randomInt(1, 99)],
  bench: { insert: 'insert', search: 'search' },
  source: { python, java },
  info: {
    summary:
      'A binary search tree stores one key per node, with smaller keys in the left subtree and larger keys in the right. Each comparison throws away one side, so a lookup costs one comparison per level. Nothing keeps the tree short, though: its shape depends entirely on the order the keys arrived in.',
    watch: [
      'Each comparison greys out the side that has been ruled out. In a bushy tree that is about half of what is left.',
      'Compare the height with the best possible height under the canvas. Lookups cost up to one comparison per level, so that gap is wasted work.',
      'Insert a few keys in ascending order. Each one goes right of the last and the tree grows a spine, which is a linked list in all but name.',
      'Delete a node with two children. The node stays put and takes the key of its in-order successor, the smallest key in its right subtree. Then the successor is removed from where it was.',
    ],
    complexity: [
      { op: 'Search', average: 'O(log n)', worst: 'O(n)', note: 'Cost is the depth of the key. Random arrival order gives about 1.39 log₂ n comparisons on average.' },
      { op: 'Insert', average: 'O(log n)', worst: 'O(n)', note: 'Keys arriving in sorted order hit the worst case every time.' },
      { op: 'Delete', average: 'O(log n)', worst: 'O(n)', note: 'Find the node, then at most one more walk down to its successor.' },
      { op: 'In-order traversal', average: 'O(n)', worst: 'O(n)', note: 'Left subtree, node, right subtree: the keys come out sorted.' },
    ],
    space: 'O(n): one node per key, each with two child pointers.',
    usedIn: [
      {
        name: 'Almost nothing, as is',
        how: 'Production code very rarely uses an unbalanced tree, because one sorted batch of keys ruins it. What gets used is one of the self-balancing or wide-node relatives below.',
      },
      { name: 'Java TreeMap and TreeSet', how: 'Red-black trees: binary search trees that recolour and rotate on every change, so the height stays within 2 log₂(n + 1).' },
      { name: 'C++ std::map and std::set', how: 'Red-black trees in libstdc++, libc++ and the Microsoft standard library.' },
      {
        name: 'Linux kernel',
        how: 'Its rbtree library is a red-black tree. The CFS scheduler, the default up to kernel 6.5, kept runnable tasks in one ordered by virtual runtime. Memory areas of a process were also tracked in one until the maple tree replaced it in 6.1.',
      },
      { name: 'PostgreSQL, MySQL InnoDB, SQLite', how: 'B+ trees. Each node holds hundreds of keys, so the tree is three or four levels deep and a lookup reads very few disk pages.' },
      { name: 'Redis, LevelDB, RocksDB', how: 'Skip lists, for Redis sorted sets and for the in-memory write buffer of LevelDB and RocksDB. Ordered like a tree, balanced by coin flips instead of rotations.' },
    ],
    reachFor: [
      'Explaining ordered lookup. Every balanced tree, B-tree and skip list is this idea plus a way to stay short.',
      'Small, in-memory sets where the keys are known to arrive in random order and nobody else chooses them.',
      'Anything that needs sorted output, range queries or "next key after x", provided you use a balanced variant in practice.',
    ],
    costs: [
      'No worst-case guarantee. Sorted or nearly sorted input gives a tree as deep as it is large, and every operation becomes a linear scan.',
      'Real keys are often in order already: timestamps, auto-increment ids, a sorted file being loaded.',
      'If the keys come from users, an attacker can send them in order on purpose and slow the service down.',
      'One key per node means one pointer hop, and probably one cache miss, per comparison. On disk that would be one page read per level, which is why databases use wide nodes instead.',
      'If you never need order, a hash table gives O(1) lookups with less trouble.',
    ],
    interview: [
      'Give both numbers: O(log n) while the tree happens to be balanced, O(n) when keys arrive in order. Then say that real data often does arrive in order, so the worst case is the normal case.',
      'Name the trap out loud: loading sorted keys into a plain binary search tree builds a linked list. With a million auto-increment ids a lookup can take a million comparisons, where a balanced tree needs about 20.',
      'Say what you would use instead: a red-black or AVL tree in memory, a B+ tree on disk, a skip list when you want simple concurrent writes. All of them keep the height at O(log n) whatever the arrival order.',
      'Link it to the AVL tree page: an AVL tree is this structure plus rotations after each change, which hold the two sides of every node within one level of each other.',
      'Link it to the B+ tree page: databases went further and made nodes wide. A billion keys need about 30 levels of binary tree but only 4 levels at 400 keys per node, and on disk each level is a page read.',
      'An in-order traversal gives sorted output. That is what a tree offers over a hash table: range scans, ORDER BY and nearest-key queries.',
      'Know the three delete cases: a leaf is unlinked, a node with one child is replaced by that child, and a node with two children takes the key of its in-order successor.',
    ],
  },
};

export default def;
