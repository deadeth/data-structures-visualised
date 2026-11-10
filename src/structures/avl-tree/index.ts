import { tidyTree } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Compare, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';

/**
 * AVL tree of integers.
 *
 * A binary search tree in which every node stores the height of its own
 * subtree. The balance factor of a node is height(left) - height(right) and
 * must stay within -1..+1. After an insert or delete the code walks back up
 * the path it came down, refreshes the stored heights and rotates any node
 * that has gone out of range.
 *
 * Scene ids come from the key (the tree is a set, so keys are unique). A
 * rotation only changes pointers, so every node keeps its id and slides to its
 * new place. When a delete copies the successor's key into a node, the scene
 * node with that key slides up with it.
 */
export interface AvlNode {
  key: number;
  /** Height of the subtree rooted here. A leaf is 1, an empty subtree is 0. */
  h: number;
  left: AvlNode | null;
  right: AvlNode | null;
  /** Number of the last operation that wrote this node, so each node counts as one write per operation. */
  stamp: number;
  /** Key of the parent it was attached to. Only used to animate its arrival. */
  origin?: number;
}

export interface AvlState {
  root: AvlNode | null;
  size: number;
  /** Operation counter, used with AvlNode.stamp. */
  tick: number;
  /** Recorded inserts in a row that were each a new maximum (positive) or a new minimum (negative). */
  streak: number;
}

/** Largest tree the animated view will grow to. There is no limit with recording off. */
export const CAP = 24;

type Side = 'left' | 'right';
const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

const nid = (n: AvlNode) => `k${n.key}`;
const eid = (a: AvlNode, b: AvlNode) => `e${a.key}-${b.key}`;
const ht = (n: AvlNode | null) => (n ? n.h : 0);
const balanceOf = (n: AvlNode) => ht(n.left) - ht(n.right);

/** Balance factor as the reader sees it: "+1", "0", "−1". */
export function signed(b: number): string {
  return b > 0 ? `+${b}` : b < 0 ? `−${-b}` : '0';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tall = (h: number) => (h === 0 ? 'empty' : `${plural(h, 'level')} tall`);

export function create(): AvlState {
  return { root: null, size: 0, tick: 0, streak: 0 };
}

export function height(s: AvlState): number {
  return ht(s.root);
}

/** Every key, in sorted order. */
export function keys(s: AvlState): number[] {
  const out: number[] = [];
  const stack: AvlNode[] = [];
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

function has(s: AvlState, key: number): boolean {
  let n = s.root;
  while (n) {
    if (key === n.key) return true;
    n = key < n.key ? n.left : n.right;
  }
  return false;
}

/** Count a node as written, once per operation however many of its fields change. */
function touch(s: AvlState, n: AvlNode, rec: Rec): void {
  if (n.stamp === s.tick) return;
  n.stamp = s.tick;
  rec.count('writes');
}

/** Point `parent` (or the root pointer) at `now` where it used to point at `old`. */
function relink(s: AvlState, parent: AvlNode | null, old: AvlNode, now: AvlNode | null, rec: Rec): void {
  if (!parent) {
    s.root = now;
    return;
  }
  if (parent.left === old) parent.left = now;
  else parent.right = now;
  touch(s, parent, rec);
}

/**
 * Rotate the subtree rooted at `z` in direction `dir` and return its new root.
 * A right rotation lifts z's left child; a left rotation lifts its right child.
 * The caller re-attaches the returned node where z used to hang.
 */
function rotate(s: AvlState, z: AvlNode, dir: Side, rec: Rec): AvlNode {
  let y: AvlNode;
  if (dir === 'right') {
    y = z.left!;
    z.left = y.right;
    y.right = z;
  } else {
    y = z.right!;
    z.right = y.left;
    y.left = z;
  }
  z.h = 1 + Math.max(ht(z.left), ht(z.right));
  y.h = 1 + Math.max(ht(y.left), ht(y.right));
  touch(s, z, rec);
  touch(s, y, rec);
  rec.count('rotations');
  return y;
}

function markPath(path: AvlNode[], upTo: number, rec: Rec): void {
  if (!rec.recording) return;
  for (let i = 0; i < upTo; i++) {
    rec.mark(nid(path[i]), 'path');
    if (i > 0) rec.markEdge(eid(path[i - 1], path[i]), 'path');
  }
}

type Mode = 'search' | 'insert' | 'delete';

const GO = { left: 'smaller, go left', right: 'larger, go right' };
const DEAD_END = { left: 'smaller, but there is no left child', right: 'larger, but there is no right child' };
const FREE = { left: 'smaller, and the left spot is free', right: 'larger, and the right spot is free' };

/**
 * Walk down from the root, one comparison per node, pushing every node visited
 * onto `path`. Returns true if the key was found (it is then the last node on
 * the path). The tree must not be empty.
 */
function descend(s: AvlState, key: number, rec: Rec, path: AvlNode[], mode: Mode): boolean {
  let n = s.root!;
  if (rec.recording) {
    rec.mark(nid(n), 'path');
    rec.step(`Start at the root, ${n.key}. Smaller keys are down the left branch, larger keys down the right.`, {
      probe: { text: String(key), at: nid(n) },
    });
  }
  for (;;) {
    rec.count('reads');
    path.push(n);
    // Ids and probes are only built when frames are being recorded.
    const id = rec.recording ? nid(n) : '';
    const extra = rec.recording ? { probe: { text: String(key), at: id } } : undefined;
    rec.mark(id, 'compare');
    if (key === n.key) {
      rec.compare(key, '=', n.key, 'match', extra);
      return true;
    }
    const side: Side = key < n.key ? 'left' : 'right';
    const next = n[side];
    rec.compare(key, side === 'left' ? '<' : '>', n.key, (next ? GO : mode === 'insert' ? FREE : DEAD_END)[side], extra);
    rec.mark(id, 'path');
    if (!next) return false;
    if (rec.recording) rec.markEdge(eid(n, next), 'path');
    n = next;
  }
}

/** Sentence for a rotation that has just happened. `moved` is the subtree that changed parent, if any. */
function rotationText(lead: string, z: AvlNode, y: AvlNode, moved: AvlNode | null, dir: Side): string {
  const start = lead ? `${lead} rotate` : 'Rotate';
  const why = lead === 'First,' ? ' to straighten the zig-zag' : '';
  let text = `${start} ${dir} at ${z.key}${why}: ${y.key} moves up into its place and ${z.key} drops down to become ${y.key}'s ${dir} child.`;
  if (moved) {
    text += ` ${moved.key}${moved.h > 1 ? ' and its subtree' : ''} sorts between the two, so it switches parent and becomes ${z.key}'s ${other(dir)} child.`;
  }
  return text;
}

/**
 * Walk back up `path` from its deepest node. At each node: refresh the stored
 * height, check the balance factor, rotate if it is out of range, and stop as
 * soon as a subtree is the same height as it was before the change, because
 * nothing above it can then be affected. Returns the number of rotations.
 *
 * `fresh` is the node that holds a newly inserted key; it keeps the key tone.
 */
function retrace(s: AvlState, path: AvlNode[], rec: Rec, what: 'insert' | 'delete', fresh: AvlNode | null): number {
  let rotations = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i];
    const parent = i > 0 ? path[i - 1] : null;
    const before = n.h;
    const h = 1 + Math.max(ht(n.left), ht(n.right));
    if (h !== n.h) {
      n.h = h;
      touch(s, n, rec);
    }
    const b = balanceOf(n);
    let top = n;

    if (b > 1 || b < -1) {
      const heavy: Side = b > 1 ? 'left' : 'right';
      const away = other(heavy);
      const y = n[heavy]!;
      const by = balanceOf(y);
      const zigzag = heavy === 'left' ? by < 0 : by > 0;
      if (rec.recording) {
        rec.mark(nid(n), 'bad');
        rec.step(
          `At ${n.key} the left side is ${tall(ht(n.left))} and the right side is ${tall(ht(n.right))}: balance ${signed(b)}. A gap of two levels is not allowed, so ${n.key} must be rebalanced.`,
          { compare: { left: `balance ${signed(b)}`, op: b > 1 ? '>' : '<', right: b > 1 ? '1' : '−1', verdict: `${n.key} is ${heavy}-heavy, rotate` } },
        );
        rec.mark(nid(y), 'compare');
        if (zigzag) {
          rec.step(
            `The extra height is on the inside: ${n.key} leans ${heavy}, but its ${heavy} child ${y.key} leans ${away}. One rotation would only tip this zig-zag the other way, so it takes two.`,
            { compare: { left: `balance ${signed(by)}`, op: heavy === 'left' ? '<' : '>', right: '0', verdict: `${heavy}-${away} case: rotate ${heavy}, then ${away}` } },
          );
        } else {
          rec.step(
            `The extra height is on the outside: ${n.key}'s ${heavy} child ${y.key} ${by === 0 ? `does not lean ${away}` : `leans ${heavy} as well`}. A straight ${heavy}-${heavy} line like this needs one ${away} rotation.`,
            { compare: { left: `balance ${signed(by)}`, op: heavy === 'left' ? '≥' : '≤', right: '0', verdict: `${heavy}-${heavy} case: one ${away} rotation` } },
          );
        }
      }
      if (zigzag) {
        const moved = y[away]![heavy];
        const x = rotate(s, y, heavy, rec);
        n[heavy] = x;
        touch(s, n, rec);
        rotations++;
        if (rec.recording) {
          rec.clearMarks();
          markPath(path, i, rec);
          if (parent) rec.markEdge(eid(parent, n), 'path');
          // Green edges are the pointers this rotation rewrote.
          rec.markEdge(eid(n, x), 'ok');
          rec.markEdge(eid(x, y), 'ok');
          if (moved) rec.markEdge(eid(y, moved), 'ok');
          rec.mark(nid(n), 'bad');
          rec.mark(nid(x), 'ok');
          rec.mark(nid(y), 'ok');
          if (fresh) rec.mark(nid(fresh), 'key');
          rec.step(rotationText('First,', y, x, moved, heavy));
        }
      }
      const moved = n[heavy]![away];
      top = rotate(s, n, away, rec);
      relink(s, parent, n, top, rec);
      rotations++;
      if (rec.recording) {
        rec.clearMarks();
        markPath(path, i, rec);
        if (parent) rec.markEdge(eid(parent, top), 'ok');
        rec.markEdge(eid(top, n), 'ok');
        if (moved) rec.markEdge(eid(n, moved), 'ok');
        rec.mark(nid(top), 'ok');
        rec.mark(nid(n), 'ok');
        if (zigzag) rec.mark(nid(y), 'ok');
        if (fresh) rec.mark(nid(fresh), 'key');
        rec.step(
          rotationText(zigzag ? 'Then' : '', n, top, moved, away) + (moved ? '' : ' A rotation only rewires pointers: no keys are compared.'),
        );
        const where = i === 0 ? `${top.key} is the new root, and the tree` : `This part of the tree, now headed by ${top.key},`;
        if (top.h === before) {
          rec.step(`${where} is ${tall(top.h)} again, the same as before the ${what}. Nothing ${i === 0 ? 'else' : `above ${top.key}`} needs to change.`);
        } else if (i > 0) {
          rec.step(`${where} is one level shorter than before the ${what}, so the check carries on at its parent, ${parent!.key}.`);
        } else {
          rec.step(`${where} is one level shorter than before the ${what}. There is nothing above the root to check.`);
        }
        rec.mark(nid(top), 'path');
        rec.unmark(nid(n));
        if (zigzag) rec.unmark(nid(y));
        if (fresh) rec.mark(nid(fresh), 'key');
      }
    } else if (rec.recording) {
      const changed = n.h !== before;
      const grew = n.h > before;
      let tail: string;
      let verdict: string;
      if (!changed) {
        tail = ` Its height is unchanged, so nothing above it is affected.`;
        verdict = `${n.key} is balanced and its height is unchanged, stop here`;
      } else if (i === 0) {
        tail = ` It is the root, so the walk back up is over.`;
        verdict = `the root ${n.key} is balanced, done`;
      } else {
        tail = ` It is now one level ${grew ? 'taller' : 'shorter'}, so check its parent too.`;
        verdict = `${n.key} is balanced but ${grew ? 'taller' : 'shorter'}, check its parent`;
      }
      const cmp: Compare = { left: `balance ${signed(b)}`, op: b < 0 ? '≥' : '≤', right: b < 0 ? '−1' : '1', verdict };
      rec.mark(nid(n), 'compare');
      rec.step(
        `At ${n.key} the left side is ${tall(ht(n.left))} and the right side is ${tall(ht(n.right))}: balance ${signed(b)}, within the allowed −1 to +1.${tail}`,
        { compare: cmp },
      );
      rec.mark(nid(n), 'path');
    }

    if (top.h === before) break;
  }
  return rotations;
}

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n: number) => ORDINALS[n] ?? `${n}th`;

function summary(s: AvlState): string {
  if (s.size === 0) return 'The tree is now empty.';
  return `The tree holds ${plural(s.size, 'key')} in ${plural(height(s), 'level')}.`;
}

function cost(comparisons: number, rotations: number): string {
  return `${plural(comparisons, 'comparison')} and ${rotations === 0 ? 'no rotations' : plural(rotations, 'rotation')}`;
}

export function search(s: AvlState, key: number, rec: Rec): boolean {
  s.tick++;
  if (!s.root) {
    rec.step(`The tree is empty, so ${key} cannot be in it.`);
    return false;
  }
  const path: AvlNode[] = [];
  const found = descend(s, key, rec, path, 'search');
  if (!rec.recording) return found;
  const last = path[path.length - 1];
  if (found) {
    rec.mark(nid(last), 'ok');
    rec.step(
      `Found ${key} after ${plural(path.length, 'comparison')}. The tree holds ${plural(s.size, 'key')} in ${plural(height(s), 'level')}, so no search needs more than ${height(s)}.`,
      { probe: { text: String(key), at: nid(last) } },
    );
  } else {
    rec.mark(nid(last), 'bad');
    rec.step(`${key} is not in the tree. The search ran out of nodes below ${last.key} after ${plural(path.length, 'comparison')}, and that is the only place ${key} could be.`);
  }
  return found;
}

export function insert(s: AvlState, key: number, rec: Rec): boolean {
  s.tick++;
  if (rec.recording && s.size >= CAP && !has(s, key)) {
    rec.step(
      `Sorry, ${key} was not inserted: this page keeps the tree to ${CAP} keys so that every node stays readable. Please delete a key first, or press Reset.`,
    );
    return false;
  }
  if (!s.root) {
    const root: AvlNode = { key, h: 1, left: null, right: null, stamp: s.tick };
    s.root = root;
    s.size = 1;
    s.streak = 0;
    rec.count('writes');
    if (rec.recording) {
      rec.mark(nid(root), 'key');
      rec.step(`The tree is empty, so ${key} becomes the root. No comparisons needed.`);
    }
    return true;
  }
  const path: AvlNode[] = [];
  if (descend(s, key, rec, path, 'insert')) {
    if (rec.recording) {
      rec.mark(nid(path[path.length - 1]), 'ok');
      rec.step(`${key} is already stored. The tree holds each key once, so nothing changes.`);
    }
    return false;
  }
  const comparisons = path.length;
  const parent = path[path.length - 1];
  const side: Side = key < parent.key ? 'left' : 'right';
  const node: AvlNode = { key, h: 1, left: null, right: null, stamp: s.tick, origin: parent.key };
  parent[side] = node;
  s.size++;
  rec.count('writes');
  touch(s, parent, rec);

  if (rec.recording) {
    // A run of keys that each arrive as the new largest (or smallest) is what flattens a plain search tree.
    const edge = side === 'right' ? 1 : -1;
    let extreme = true;
    for (const p of path) if ((edge > 0 && key < p.key) || (edge < 0 && key > p.key)) extreme = false;
    s.streak = extreme ? (Math.sign(s.streak) === edge ? s.streak + edge : edge) : 0;
    rec.mark(nid(node), 'key');
    rec.markEdge(eid(parent, node), 'path');
    rec.step(`${key} becomes the ${side} child of ${parent.key}, because a new key always starts as a leaf. Now walk back up the path and check the balance of each node on it.`);
  } else {
    s.streak = 0;
  }

  const rotations = retrace(s, path, rec, 'insert', node);

  if (rec.recording) {
    rec.clearMarks();
    rec.mark(nid(node), 'key');
    const run = Math.abs(s.streak);
    if (run >= 2) {
      rec.step(
        `${key} is the ${ordinal(run)} key in a row to arrive as the new ${s.streak > 0 ? 'largest' : 'smallest'}. Sorted input like this turns a plain binary search tree into a linked list, one level per key, but this tree is still only ${plural(height(s), 'level')} deep.`,
      );
    }
    rec.step(`${key} is stored after ${cost(comparisons, rotations)}. ${summary(s)}`);
  }
  node.origin = undefined;
  return true;
}

export function remove(s: AvlState, key: number, rec: Rec): boolean {
  s.tick++;
  s.streak = 0;
  if (!s.root) {
    rec.step(`The tree is empty, so there is nothing to delete.`);
    return false;
  }
  const path: AvlNode[] = [];
  if (!descend(s, key, rec, path, 'delete')) {
    if (rec.recording) {
      rec.mark(nid(path[path.length - 1]), 'bad');
      rec.step(`${key} is not in the tree, so there is nothing to delete.`);
    }
    return false;
  }
  const comparisons = path.length;
  const node = path[path.length - 1];
  const parent = path.length > 1 ? path[path.length - 2] : null;

  if (node.left && node.right) {
    // Two children: the in-order successor (smallest key in the right subtree) takes this node's place.
    if (rec.recording) {
      rec.mark(nid(node), 'bad');
      rec.step(
        `Found ${key}. It has two children, so it cannot simply be unlinked: its in-order successor, the smallest key in its right subtree, takes its place.`,
        { probe: { text: String(key), at: nid(node) } },
      );
    }
    let above = node;
    let succ = node.right;
    for (;;) {
      rec.count('reads');
      if (rec.recording) {
        rec.markEdge(eid(above, succ), 'path');
        rec.mark(nid(succ), succ.left ? 'path' : 'ok');
        const how = above === node ? `Step right from ${key} to ${succ.key}.` : `Step left to ${succ.key}.`;
        rec.step(
          succ.left
            ? `${how} It has a left child, so there is a smaller key below it: keep going left.`
            : `${how} It has no left child, so nothing in this subtree is smaller: ${succ.key} is the successor of ${key}.`,
          { probe: { text: String(key), at: nid(node) } },
        );
      }
      if (!succ.left) break;
      path.push(succ);
      above = succ;
      succ = succ.left;
    }
    const orphan = succ.right;
    node.key = succ.key;
    touch(s, node, rec);
    if (above === node) node.right = orphan;
    else above.left = orphan;
    touch(s, above, rec);
    s.size--;
    if (rec.recording) {
      rec.clearMarks();
      markPath(path, path.length, rec);
      rec.mark(nid(node), 'ok');
      rec.step(
        `${succ.key} moves up into ${key}'s place${orphan ? `, ${orphan.key} takes the spot ${succ.key} left behind` : ''} and ${key} is gone. ` +
          `The order still holds because ${succ.key} was the next key after ${key}, so now check balances from ${above.key} upwards.`,
      );
    }
  } else {
    const child = node.left ?? node.right;
    if (rec.recording) {
      rec.mark(nid(node), 'bad');
      rec.step(
        child
          ? `Found ${key}. It has one child, ${child.key}, which can take its place.`
          : `Found ${key}. It is a leaf, so it can simply be unlinked.`,
        { probe: { text: String(key), at: nid(node) } },
      );
    }
    relink(s, parent, node, child, rec);
    s.size--;
    path.pop();
    if (rec.recording) {
      rec.clearMarks();
      markPath(path, path.length, rec);
      if (child) rec.mark(nid(child), 'ok');
      const gone = child
        ? `${key} is unlinked and ${child.key} moves up one level${parent ? ` to hang from ${parent.key}` : ' to become the root'}.`
        : `${key} is unlinked${parent ? ` from ${parent.key}` : ''}.`;
      if (parent) rec.step(`${gone} That side just got shorter, so walk back up the path and check the balance of each node on it.`);
      else if (s.root) rec.step(`${gone} Nothing is above it, so there are no balances to check.`);
    }
  }

  const rotations = retrace(s, path, rec, 'delete', null);

  if (rec.recording) {
    rec.clearMarks();
    rec.step(`${key} is deleted after ${cost(comparisons, rotations)}. ${summary(s)}`);
  }
  return true;
}

const R = 22;

export function layout(s: AvlState): Scene {
  if (!s.root) {
    return { nodes: [], edges: [], decor: [{ id: 'empty', type: 'label', x: 0, y: 0, text: 'The tree is empty. Insert a key to start.', anchor: 'middle' }] };
  }
  const pos = tidyTree<AvlNode>({
    root: s.root,
    // A missing child still holds its side, so a lone left child does not sit straight under its parent.
    children: (n) => (n.left || n.right ? [n.left, n.right] : []),
    width: () => R * 2,
    gapX: 26,
    gapY: 80,
    nullWidth: 36,
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
      cells: [{ text: String(n.key), sub: signed(balanceOf(n)) }],
      from: n.origin != null ? `k${n.origin}` : undefined,
    });
    if (n.left) edges.push({ id: eid(n, n.left), from: nid(n), to: nid(n.left), kind: 'line' });
    if (n.right) edges.push({ id: eid(n, n.right), from: nid(n), to: nid(n.right), kind: 'line' });
  }
  return { nodes, edges };
}

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: AvlState): number {
  for (let i = 0; i < 60; i++) {
    const k = randomInt(1, 99);
    if (!has(s, k)) return k;
  }
  for (;;) {
    const k = randomInt(100, 999);
    if (!has(s, k)) return k;
  }
}

function presentKey(s: AvlState): number {
  const all = keys(s);
  return all.length ? all[randomInt(0, all.length - 1)] : 42;
}

const def: StructureDef<AvlState> = {
  id: 'avl-tree',
  create: () => create(),
  seed: [50, 30, 70, 20, 40, 60, 10].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Key comparisons' },
    { key: 'reads', label: 'Nodes visited' },
    { key: 'rotations', label: 'Rotations' },
    { key: 'writes', label: 'Nodes written' },
  ],
  status: (s) => [
    { label: 'Keys', value: String(s.size) },
    { label: 'Levels', value: String(height(s)) },
    { label: 'Plain BST at its worst', value: plural(s.size, 'level') },
  ],
  // One of each rotation case: 5 is left-left (one right rotation), 65 is left-right (double), 90 is
  // right-right (one left rotation, and the second new maximum in a row), 75 is right-left (double).
  // Deleting 30 then pulls up its successor and rotates on the way back up.
  tour: [
    ['insert', 5],
    ['insert', 65],
    ['insert', 80],
    ['insert', 90],
    ['insert', 75],
    ['delete', 30],
  ],
  // The quick-fill button runs with recording off, so it keeps to the display limit itself.
  fill: (s) => (s.size < CAP ? ['insert', absentKey(s)] : ['search', s.root!.key]),
  bench: { insert: 'insert', search: 'search' },
  info: {
    summary:
      'An AVL tree is a binary search tree that stores a height in every node and never lets the two sides of any node differ by more than one level. After each insert or delete it walks back up the path it came down and fixes any node that has tipped over with a rotation, which rewires two or three pointers. The tree therefore stays shallow whatever order the keys arrive in, and every lookup is O(log n).',
    watch: [
      'The small number under each node is its balance factor: the height of its left side minus the height of its right side. Only −1, 0 and +1 are allowed.',
      'After a change, the walk back up stops at the first node whose height is unchanged. Nothing above that node can be affected.',
      'A rotation compares no keys. Two nodes swap levels, and the subtree that sorts between them changes parent.',
      'Extra height on the outside (left-left or right-right) takes one rotation. Extra height on the inside (a left-right or right-left zig-zag) takes two.',
      'An insert is repaired by at most one single or double rotation. A delete can need a rotation at every level on the way up.',
      'Insert keys in ascending order. A plain binary search tree becomes a chain; this one stays flat. The status line shows how deep the plain tree could be.',
    ],
    complexity: [
      { op: 'Search', average: 'O(log n)', worst: 'O(log n)', note: 'The height is at most about 1.44 log_2 n, so that is the most comparisons a lookup can need.' },
      { op: 'Insert', average: 'O(log n)', worst: 'O(log n)', note: 'One trip down, a partial trip back up, and at most one single or double rotation.' },
      { op: 'Delete', average: 'O(log n)', worst: 'O(log n)', note: 'Each level on the way back up may need a rotation, so up to O(log n) of them.' },
      { op: 'One rotation', average: 'O(1)', worst: 'O(1)', note: 'Three pointers and two stored heights change. No keys are compared.' },
      { op: 'Range scan of k keys', average: 'O(log n + k)', worst: 'O(log n + k)', note: 'Find the first key, then walk the tree in order.' },
    ],
    space: 'O(n). Each key carries two child pointers and a height. Two bits for the balance factor are enough if space is tight.',
    usedIn: [
      {
        name: 'Windows kernel',
        how: 'The run-time library gives drivers an AVL-backed ordered table (RTL_AVL_TABLE), and the memory manager keeps the address ranges of each process in an AVL tree.',
      },
      {
        name: 'OpenZFS and illumos',
        how: 'A shared AVL library holds many of the in-memory sorted indexes in the kernel and the file system code.',
      },
      {
        name: 'HSQLDB',
        how: 'This in-memory Java SQL database builds its table indexes as AVL trees.',
      },
      {
        name: 'Most standard libraries (red-black instead)',
        how: 'Java TreeMap, the usual implementations of C++ std::map, and the Linux kernel rbtree all use red-black trees, which do the same job with looser balance and fewer rotations per write.',
      },
    ],
    reachFor: [
      'An ordered map or set held in memory where lookups far outnumber writes.',
      'You need a hard worst-case bound, not a good average: every operation is O(log n) whatever order the keys arrive in.',
      'You need order as well as lookup: smallest, largest, next key after x, everything in a range.',
    ],
    costs: [
      'Writes do more rebalancing than in a red-black tree, and a delete can rotate at every level on the way up.',
      'Every step down the tree follows a pointer to a different place in memory. A sorted array or a B-tree makes far better use of the CPU cache.',
      'It does not belong on disk. A binary tree of a billion keys is about 30 levels deep and each level would be a page read. A B+ tree needs three or four.',
      'If you only need exact-match lookups, a hash table is simpler and O(1) on average.',
      'Rotations change several nodes at once, which makes fine-grained locking hard. Concurrent ordered maps often use a skip list instead, as Java ConcurrentSkipListMap does.',
    ],
    interview: [
      'Why balance matters: a binary search tree is only as fast as it is shallow. Sorted input is common in real data (timestamps, auto-increment ids) and turns a plain tree into a linked list with O(n) lookups. Balancing puts a ceiling on the height, so O(log n) is a guarantee.',
      'Put a number on it: an AVL tree of a million keys is at most 28 levels deep. A perfectly balanced tree would be 20, and an unbalanced one could be a million.',
      'AVL against red-black in one sentence: AVL is more strictly balanced, so lookups are slightly faster, while red-black tolerates up to about 2 log_2 n levels and rotates less on writes, which is why most libraries choose it.',
      'An in-memory ordered map (a sorted leaderboard, an order book keyed by price, a schedule of intervals) needs insert, delete and "next key above x" in O(log n). A balanced tree or a skip list gives that. A hash table cannot answer ordered queries, and a sorted array costs O(n) per insert.',
      'Why a database index is not a binary tree: on disk the cost is page reads, not comparisons. A B+ tree node holds hundreds of keys, so a billion rows sit 3 or 4 levels deep, where a binary tree would be about 30.',
      'A rotation is O(1) and keeps the sorted order intact, so the tree rebalances by moving pointers and never has to re-sort or copy keys.',
    ],
  },
};

export default def;
