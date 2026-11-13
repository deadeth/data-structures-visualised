import { tidyTree } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Compare, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/RedBlackTree.java?raw';
import python from './code/red_black_tree.py?raw';

/**
 * Red-black tree of integers.
 *
 * A binary search tree in which every node is red or black, with parent
 * pointers, following the listings step for step: insert attaches a red leaf
 * and repairs any red-red pair (recolour when the uncle is red, otherwise one
 * or two rotations); delete removes a node with at most one child (copying the
 * in-order successor's key first when there are two) and repairs a black
 * shortfall, the "double black", with the four sibling cases.
 *
 * Scene ids come from a serial number per node, not from the key, because a
 * delete copies the successor's key into another node for a moment and both
 * nodes are drawn. A rotation only changes pointers, so nodes keep their ids
 * and slide to their new places.
 */
export interface RbNode {
  id: number;
  key: number;
  red: boolean;
  left: RbNode | null;
  right: RbNode | null;
  parent: RbNode | null;
  /** Number of the last operation that wrote this node, so each node counts as one write per operation. */
  stamp: number;
  /** Id of the node it was attached to. Only used to animate its arrival. */
  origin?: number;
}

export interface RbState {
  root: RbNode | null;
  size: number;
  tick: number;
  serial: number;
  /** Display only: where the double black sits during a delete. A null node means a null leaf under `parent`. */
  dbl: { node: RbNode | null; parent: RbNode | null } | null;
  /** Rotations and recolours done by the current operation, for its closing sentence. */
  work: { rotations: number; recolours: number };
}

/** Largest tree the animated view will grow to. There is no limit with recording off. */
export const CAP = 20;

type Side = 'left' | 'right';
const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

const nid = (n: RbNode) => `n${n.id}`;
const eid = (a: RbNode, b: RbNode) => `e${a.id}-${b.id}`;
const isRed = (n: RbNode | null): boolean => n !== null && n.red;
const colour = (n: RbNode | null) => (isRed(n) ? 'red' : 'black');
const nm = (n: RbNode | null) => (n ? String(n.key) : 'a null leaf');
const kv = (n: RbNode | null) => (n ? n.key : null);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function create(): RbState {
  return { root: null, size: 0, tick: 0, serial: 0, dbl: null, work: { rotations: 0, recolours: 0 } };
}

/** Levels on the longest path from the root to a leaf. */
export function height(s: RbState): number {
  let best = 0;
  const stack: [RbNode, number][] = s.root ? [[s.root, 1]] : [];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    best = Math.max(best, d);
    if (n.left) stack.push([n.left, d + 1]);
    if (n.right) stack.push([n.right, d + 1]);
  }
  return best;
}

/** Black nodes on a path from the root down to a null leaf, counting the root and not the null leaf. */
export function blackHeight(s: RbState): number {
  let c = 0;
  for (let n = s.root; n; n = n.left) if (!n.red) c++;
  return c;
}

export function redCount(s: RbState): number {
  let c = 0;
  const stack: RbNode[] = s.root ? [s.root] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.red) c++;
    if (n.left) stack.push(n.left);
    if (n.right) stack.push(n.right);
  }
  return c;
}

/** True if every rule holds: root black, no red node with a red child, the same black count on every path, parent pointers right. */
export function rulesHold(s: RbState): boolean {
  if (isRed(s.root)) return false;
  if (s.root && s.root.parent) return false;
  let ok = true;
  let target = -1;
  const stack: [RbNode | null, RbNode | null, number][] = [[s.root, null, 0]];
  while (stack.length && ok) {
    const [n, parent, blacks] = stack.pop()!;
    if (!n) {
      if (target < 0) target = blacks;
      else if (target !== blacks) ok = false;
      continue;
    }
    if (n.parent !== parent) ok = false;
    if (n.red && (isRed(n.left) || isRed(n.right))) ok = false;
    const b = blacks + (n.red ? 0 : 1);
    stack.push([n.left, n, b], [n.right, n, b]);
  }
  return ok;
}

/** Every key, in sorted order. */
export function keys(s: RbState): number[] {
  const out: number[] = [];
  const stack: RbNode[] = [];
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

function has(s: RbState, key: number): boolean {
  let n = s.root;
  while (n) {
    if (key === n.key) return true;
    n = key < n.key ? n.left : n.right;
  }
  return false;
}

/** Count a node as written, once per operation however many of its fields change. */
function touch(s: RbState, n: RbNode, rec: Rec): void {
  if (n.stamp === s.tick) return;
  n.stamp = s.tick;
  rec.count('writes');
}

/** Change a node's colour. Only a real change counts as a recolour. */
function paint(s: RbState, n: RbNode, red: boolean, rec: Rec): void {
  if (n.red === red) return;
  n.red = red;
  s.work.recolours++;
  rec.count('recolours');
  touch(s, n, rec);
}

/** Hang `now` where `old` hung: on old's parent, or as the root. */
function replace(s: RbState, old: RbNode, now: RbNode | null, rec: Rec): void {
  const parent = old.parent;
  if (!parent) s.root = now;
  else {
    if (parent.left === old) parent.left = now;
    else parent.right = now;
    touch(s, parent, rec);
  }
  if (now) {
    now.parent = parent;
    touch(s, now, rec);
  }
}

/**
 * Rotate at x in direction `dir`: a left rotation lifts x's right child into
 * x's place. Returns the subtree that changed parent, if any.
 */
function rotate(s: RbState, x: RbNode, dir: Side, rec: Rec): RbNode | null {
  const up: Side = other(dir);
  const y = x[up]!;
  const moved = y[dir];
  x[up] = moved;
  if (moved) {
    moved.parent = x;
    touch(s, moved, rec);
  }
  replace(s, x, y, rec);
  y[dir] = x;
  x.parent = y;
  touch(s, x, rec);
  touch(s, y, rec);
  s.work.rotations++;
  rec.count('rotations');
  return moved;
}

/** Sentence for a rotation at x that lifted y. `clause` is added to the end of the first sentence. */
function rotationText(x: RbNode, y: RbNode, moved: RbNode | null, dir: Side, clause = ''): string {
  let text = `Rotate ${dir} at ${x.key}: ${y.key} moves up into its place and ${x.key} drops down to become its ${dir} child${clause}.`;
  if (moved) {
    const sub = moved.left || moved.right ? ' and its subtree' : '';
    text += ` ${moved.key}${sub} sorts between the two, so it switches parent to ${x.key}.`;
  } else {
    text += ' A rotation only rewires pointers: no keys are compared.';
  }
  return text;
}

/** Mark the edges and nodes a rotation at x (lifting y) rewrote. */
function markRotation(rec: Rec, x: RbNode, y: RbNode, moved: RbNode | null): void {
  rec.mark(nid(x), 'ok');
  rec.mark(nid(y), 'ok');
  rec.markEdge(eid(y, x), 'ok');
  if (moved) rec.markEdge(eid(x, moved), 'ok');
  if (y.parent) rec.markEdge(eid(y.parent, y), 'ok');
}

type Mode = 'search' | 'insert' | 'delete';

const GO = { left: 'smaller, go left', right: 'larger, go right' };
const DEAD_END = { left: 'smaller, but there is no left child', right: 'larger, but there is no right child' };
const FREE = { left: 'smaller, and the left spot is free', right: 'larger, and the right spot is free' };

/**
 * Walk down from the root, one comparison per node, as `_descend` does.
 * Returns the last node visited before the match (or the spot), and the match.
 */
function descend(s: RbState, key: number, rec: Rec, path: RbNode[], mode: Mode): { parent: RbNode | null; node: RbNode | null } {
  let parent: RbNode | null = null;
  let node = s.root;
  if (!node) return { parent, node };
  if (rec.recording) {
    rec.mark(nid(node), 'path');
    rec.vars({ key, parent: null, node: node.key });
    rec.line('start');
    rec.step(`Start at the root, ${node.key}. Smaller keys are down the left branch, larger keys down the right.`, {
      probe: { text: String(key), at: nid(node) },
    });
  }
  while (node) {
    rec.count('reads');
    path.push(node);
    const id = rec.recording ? nid(node) : '';
    const extra = rec.recording ? { probe: { text: String(key), at: id } } : undefined;
    if (rec.recording) {
      rec.mark(id, 'compare');
      rec.vars({ key, parent: kv(parent), node: node.key });
    }
    if (key === node.key) {
      rec.line('match');
      rec.compare(key, '=', node.key, 'match', extra);
      return { parent, node };
    }
    parent = node;
    const side: Side = key < node.key ? 'left' : 'right';
    const next: RbNode | null = node[side];
    rec.line(side);
    rec.compare(key, side === 'left' ? '<' : '>', node.key, (next ? GO : mode === 'insert' ? FREE : DEAD_END)[side], extra);
    if (rec.recording) {
      rec.mark(id, 'path');
      if (next) rec.markEdge(eid(node, next), 'path');
    }
    node = next;
  }
  return { parent, node: null };
}

function summary(s: RbState): string {
  if (s.size === 0) return 'The tree is now empty.';
  return `The tree holds ${plural(s.size, 'key')} in ${plural(height(s), 'level')}, with black height ${blackHeight(s)}.`;
}

function cost(comparisons: number, s: RbState): string {
  const r = s.work.rotations;
  const c = s.work.recolours;
  const rs = r === 0 ? 'no rotations' : plural(r, 'rotation');
  const cs = c === 0 ? 'no recolours' : plural(c, 'recolour');
  return `${plural(comparisons, 'comparison')}, ${rs} and ${cs}`;
}

/** Start an operation: a new write stamp, no double black, no work done yet. */
function begin(s: RbState): void {
  s.tick++;
  s.dbl = null;
  s.work = { rotations: 0, recolours: 0 };
}

export function search(s: RbState, key: number, rec: Rec): boolean {
  begin(s);
  if (!s.root) {
    rec.vars({ key, found: false });
    rec.line('result');
    rec.step(`The tree is empty, so ${key} cannot be in it.`);
    return false;
  }
  const path: RbNode[] = [];
  const { node } = descend(s, key, rec, path, 'search');
  const found = node !== null;
  if (!rec.recording) return found;
  const last = path[path.length - 1];
  rec.vars({ key, found });
  rec.line('result');
  if (found) {
    rec.mark(nid(last), 'ok');
    rec.step(
      `Found ${key} after ${plural(path.length, 'comparison')}. Colours play no part in a search: it is a plain binary search, kept short because the tree is only ${plural(height(s), 'level')} deep.`,
      { probe: { text: String(key), at: nid(last) } },
    );
  } else {
    rec.mark(nid(last), 'bad');
    rec.step(`${key} is not in the tree. The search ran out of nodes below ${last.key} after ${plural(path.length, 'comparison')}, and that is the only place ${key} could be.`);
  }
  return found;
}

/**
 * The insert repair, as `_fix_insert`. Returns true if it ended by turning
 * the root black (a frame of its own), false if the root was black already.
 */
function fixInsert(s: RbState, start: RbNode, rec: Rec): boolean {
  const R = rec.recording;
  const fresh = start;
  let node = start;
  let climbed: Side | null = null;
  const reset = () => {
    rec.clearMarks();
    rec.mark(nid(fresh), 'key');
  };
  for (;;) {
    const parent = node.parent;
    if (!isRed(parent)) {
      if (R && parent) {
        reset();
        rec.mark(nid(node), 'compare');
        rec.mark(nid(parent), 'compare');
        rec.vars({ node: node.key, parent: parent.key });
        rec.line(...(climbed ? [`${climbed}_climb`, 'red_parent'] : ['red_parent']));
        const lead = climbed ? `${node.key} is now red, so check it against its own parent. ` : '';
        rec.step(`${lead}${parent.key} is black, so ${node.key} has no red parent and no rule is broken.`, {
          compare: { left: `colour of ${parent.key}`, op: '=', right: 'black', verdict: 'no red-red pair, stop' },
        });
      }
      break;
    }
    const p = parent!;
    const grand = p.parent!;
    const side: Side = p === grand.left ? 'left' : 'right';
    const o = other(side);
    const uncle = grand[o];
    if (R) {
      reset();
      rec.mark(nid(node), 'compare');
      rec.mark(nid(p), 'compare');
      rec.vars({ node: node.key, parent: p.key, grand: grand.key });
      rec.line(...(climbed ? [`${climbed}_climb`, 'red_parent'] : ['red_parent']));
      const lead = climbed ? `${node.key} is now red, so check it against its own parent. ` : '';
      rec.step(`${lead}${node.key} and its parent ${p.key} are both red, which breaks the rule that a red node never has a red child.`, {
        compare: { left: `colour of ${p.key}`, op: '=', right: 'red', verdict: 'two reds in a row, check the uncle' },
      });
      reset();
      rec.mark(nid(node), 'path');
      rec.mark(nid(p), 'path');
      if (uncle) rec.mark(nid(uncle), 'compare');
      rec.vars({ node: node.key, parent: p.key, grand: grand.key, uncle: kv(uncle) });
      rec.line(`${side}_uncle`);
      let text: string;
      if (isRed(uncle)) text = `The uncle is ${uncle!.key}, ${grand.key}'s other child, and it is red. Recolouring alone will fix this, with no rotation.`;
      else if (uncle) text = `The uncle is ${uncle.key}, ${grand.key}'s other child, and it is black. Recolouring alone cannot fix this, so it takes a rotation.`;
      else text = `${grand.key} has no ${o} child, so the uncle is a null leaf, and null leaves count as black. Recolouring alone cannot fix this, so it takes a rotation.`;
      rec.step(text, {
        compare: { left: `colour of ${uncle ? uncle.key : 'null leaf'}`, op: '=', right: colour(uncle), verdict: isRed(uncle) ? 'red uncle: recolour' : 'black uncle: rotate' },
      });
    }
    if (isRed(uncle)) {
      const u = uncle!;
      paint(s, p, false, rec);
      paint(s, u, false, rec);
      if (R) {
        reset();
        rec.mark(nid(p), 'ok');
        rec.mark(nid(u), 'ok');
        rec.line(`${side}_recolour`);
        rec.step(`Turn ${p.key} and ${u.key} black. That ends the red-red pair, but every path through ${grand.key} now has one black node too many.`);
      }
      paint(s, grand, true, rec);
      if (R) {
        reset();
        rec.mark(nid(grand), 'ok');
        rec.line(`${side}_grand`);
        rec.step(`Turn ${grand.key} red to take that extra black back off, so every path has the same black count as before.`);
      }
      node = grand;
      climbed = side;
      continue;
    }
    climbed = null;
    const inner = side === 'left' ? node === p.right : node === p.left;
    if (R) {
      reset();
      rec.mark(nid(node), 'compare');
      rec.mark(nid(p), 'compare');
      rec.line(`${side}_inner`);
      const cmp: Compare = {
        left: `side of ${node.key}`,
        op: inner ? '≠' : '=',
        right: `side of ${p.key}`,
        verdict: inner ? `zig-zag: rotate ${side} at ${p.key} first` : `straight line: rotate ${o} at ${grand.key}`,
      };
      rec.step(
        inner
          ? `${node.key} is a ${o} child but ${p.key} is a ${side} child: a zig-zag. Rotate ${side} at ${p.key} first to straighten it into a line.`
          : `${node.key} and its parent ${p.key} are both ${side} children: a straight line, so one rotation at ${grand.key} will do.`,
        { compare: cmp },
      );
    }
    let n = node;
    let top = p;
    if (inner) {
      const moved = rotate(s, p, side, rec);
      if (R) {
        reset();
        markRotation(rec, p, n, moved);
        rec.vars({ node: p.key, parent: n.key, grand: grand.key, uncle: kv(uncle) });
        rec.line(`${side}_inner_rot`, `rotate_${side}`);
        rec.step(rotationText(p, n, moved, side, `, so ${p.key} is now the lower red node, in a straight line under ${n.key}`));
      }
      top = n;
      n = p;
    }
    const moved = rotate(s, grand, o, rec);
    if (R) {
      reset();
      markRotation(rec, grand, top, moved);
      rec.vars({ node: n.key, parent: top.key, grand: grand.key, uncle: kv(uncle) });
      rec.line(`${side}_outer_rot`, `rotate_${o}`);
      rec.step(rotationText(grand, top, moved, o));
    }
    paint(s, top, false, rec);
    if (R) {
      reset();
      rec.mark(nid(top), 'ok');
      rec.line(`${side}_top`);
      rec.step(`Turn ${top.key} black. It now heads this part of the tree in ${grand.key}'s place, so ${n.key} no longer has a red parent.`);
    }
    paint(s, grand, true, rec);
    if (R) {
      reset();
      rec.mark(nid(grand), 'ok');
      rec.line(`${side}_down`);
      rec.step(`Turn ${grand.key} red. It has moved down below ${top.key}, and without this the paths through it would carry one black too many.`);
    }
    node = n;
  }
  const root = s.root!;
  if (!root.red) return false;
  paint(s, root, false, rec);
  if (R) {
    reset();
    rec.mark(nid(root), 'ok');
    rec.vars({ node: node.key, root: root.key });
    rec.line(...(climbed ? [`${climbed}_climb`, 'red_parent', 'root_black'] : ['red_parent', 'root_black']));
    const bh = blackHeight(s);
    if (s.size === 1) {
      rec.step(`${root.key} has no parent to clash with, but the root must always be black. Turn it black: the black height is now 1.`);
    } else {
      rec.step(`The red has climbed all the way to the root, ${root.key}, and the root must always be black. Turning it black adds one black to every path at once, so the counts stay equal and the black height grows to ${bh}.`);
    }
  }
  return true;
}

export function insert(s: RbState, key: number, rec: Rec): boolean {
  begin(s);
  if (rec.recording && s.size >= CAP && !has(s, key)) {
    rec.vars({ key });
    rec.line('start');
    rec.step(`Sorry, ${key} was not inserted: this page keeps the tree to ${CAP} keys so that every node stays readable. Please delete a key first, or press Reset.`);
    return false;
  }
  const path: RbNode[] = [];
  const { parent, node: found } = descend(s, key, rec, path, 'insert');
  if (found) {
    if (rec.recording) {
      rec.mark(nid(found), 'ok');
      rec.vars({ key, found: true });
      rec.line('duplicate');
      rec.step(`${key} is already stored. The tree holds each key once, so nothing changes.`);
    }
    return false;
  }
  const node: RbNode = { id: ++s.serial, key, red: true, left: null, right: null, parent, stamp: s.tick, origin: parent?.id };
  rec.count('writes');
  s.size++;
  if (!parent) {
    s.root = node;
    if (rec.recording) {
      rec.mark(nid(node), 'key');
      rec.vars({ key, parent: null, node: key });
      rec.line('first');
      rec.step(`The tree is empty, so ${key} becomes the root. It starts red, like every new node.`);
    }
  } else {
    const side: Side = key < parent.key ? 'left' : 'right';
    parent[side] = node;
    touch(s, parent, rec);
    if (rec.recording) {
      rec.mark(nid(node), 'key');
      rec.markEdge(eid(parent, node), 'path');
      rec.vars({ key, parent: parent.key, node: key });
      rec.line(`attach_${side}`);
      rec.step(`${key} becomes the ${side} child of ${parent.key}. Every new node starts red: a red node adds no black to any path, so the black counts all stay equal.`);
    }
  }

  const rootFrame = fixInsert(s, node, rec);

  if (rec.recording) {
    rec.clearMarks();
    rec.mark(nid(node), 'key');
    rec.vars({ key });
    rec.line(...(rootFrame ? ['done'] : ['root_black', 'done']));
    rec.step(`${key} is stored after ${cost(path.length, s)}. ${summary(s)}`);
  }
  node.origin = undefined;
  return true;
}

/** The delete repair, as `_fix_delete`. `x` is one black short; it may be a null leaf under `parent`. */
function fixDelete(s: RbState, start: RbNode | null, startParent: RbNode, rec: Rec): void {
  const R = rec.recording;
  let x: RbNode | null = start;
  let parent: RbNode | null = startParent;
  let up: Side | null = null;
  const show = () => {
    s.dbl = { node: x, parent };
  };
  while (x !== s.root && !isRed(x)) {
    const pa: RbNode = parent!;
    if (R && up) {
      rec.clearMarks();
      rec.mark(nid(x!), 'compare');
      rec.vars({ node: kv(x), parent: kv(pa) });
      rec.line(`${up}_c2_up`, 'db_loop');
      rec.step(`The double black moves up to ${x!.key}. It is black and not the root, so it is still one black short: look at its sibling.`, {
        compare: { left: `colour of ${x!.key}`, op: '=', right: 'black', verdict: 'still short, look at the sibling' },
      });
    }
    const side: Side = x === pa.left ? 'left' : 'right';
    const o = other(side);
    let sib = pa[o]!;
    if (R) {
      rec.clearMarks();
      rec.mark(nid(sib), 'compare');
      rec.vars({ node: kv(x), parent: pa.key, sibling: sib.key });
      rec.line(`${side}_sibling`);
      rec.step(
        sib.red
          ? `The sibling is ${sib.key}, ${pa.key}'s other child, and it is red. Rotate it up first, so that the double black gets a black sibling to work with.`
          : `The sibling is ${sib.key}, ${pa.key}'s other child, and it is black. What happens next depends on its children.`,
        { compare: { left: `colour of ${sib.key}`, op: '=', right: colour(sib), verdict: sib.red ? 'case 1: rotate the red sibling up' : 'black: look at its children' } },
      );
    }
    if (sib.red) {
      const s1 = sib;
      const moved = rotate(s, pa, side, rec);
      if (R) {
        rec.clearMarks();
        markRotation(rec, pa, s1, moved);
        rec.line(`${side}_c1_rot`, `rotate_${side}`);
        rec.step(rotationText(pa, s1, moved, side));
      }
      paint(s, s1, false, rec);
      if (R) {
        rec.clearMarks();
        rec.mark(nid(s1), 'ok');
        rec.line(`${side}_c1_top`);
        rec.step(`Turn ${s1.key} black: it has moved up into the place where black ${pa.key} was.`);
      }
      paint(s, pa, true, rec);
      sib = pa[o]!;
      if (R) {
        rec.clearMarks();
        rec.mark(nid(pa), 'ok');
        rec.vars({ node: kv(x), parent: pa.key, sibling: sib.key });
        rec.line(`${side}_c1_down`, `${side}_c1_new`);
        rec.step(`Turn ${pa.key} red, so the paths through it keep the black count they had. The double black's new sibling is ${sib.key}, which is black because a red node's children are always black.`);
      }
    }
    const near = sib[side];
    let far = sib[o];
    const bothBlack = !isRed(near) && !isRed(far);
    if (R) {
      rec.clearMarks();
      rec.mark(nid(sib), 'path');
      if (near) rec.mark(nid(near), 'compare');
      if (far) rec.mark(nid(far), 'compare');
      rec.vars({ node: kv(x), parent: pa.key, sibling: sib.key, near: kv(near), far: kv(far) });
      rec.line(`${side}_c2`);
      let text: string;
      if (!bothBlack) text = `${sib.key} has a red child, so a rotation can bring a red node across to the double black's side and turn it black.`;
      else if (!near && !far) text = `Both of ${sib.key}'s children are null leaves, which count as black, so ${sib.key} can turn red without making a red-red pair.`;
      else text = `Both of ${sib.key}'s children, ${nm(near)} and ${nm(far)}, are black, so ${sib.key} can turn red without making a red-red pair.`;
      rec.step(text, {
        compare: { left: `children of ${sib.key}`, op: bothBlack ? '=' : '≠', right: 'both black', verdict: bothBlack ? 'case 2: turn the sibling red' : 'a red child: rotate' },
      });
    }
    if (bothBlack) {
      paint(s, sib, true, rec);
      if (R) {
        rec.clearMarks();
        rec.mark(nid(sib), 'ok');
        rec.line(`${side}_c2_red`);
        rec.step(`Turn ${sib.key} red. Now both sides of ${pa.key} are one black short, so the shortfall moves up to ${pa.key}.`);
      }
      x = pa;
      parent = pa.parent;
      up = side;
      if (R) show();
      continue;
    }
    if (!isRed(far)) {
      const nr = near!;
      if (R) {
        rec.clearMarks();
        rec.mark(nid(nr), 'compare');
        if (far) rec.mark(nid(far), 'compare');
        rec.line(`${side}_c3`);
        rec.step(
          `The red child is the near one, ${nr.key}, on the double black's side, and the far child ${far ? far.key : '(a null leaf)'} is black. Rotate ${nr.key} up over ${sib.key} first, so that the red child ends up on the far side.`,
          { compare: { left: `colour of ${far ? far.key : 'null leaf'}`, op: '=', right: 'black', verdict: 'case 3: rotate the near child up first' } },
        );
      }
      const moved = rotate(s, sib, o, rec);
      if (R) {
        rec.clearMarks();
        markRotation(rec, sib, nr, moved);
        rec.line(`${side}_c3_rot`, `rotate_${o}`);
        rec.step(rotationText(sib, nr, moved, o));
      }
      paint(s, nr, false, rec);
      if (R) {
        rec.clearMarks();
        rec.mark(nid(nr), 'ok');
        rec.line(`${side}_c3_top`);
        rec.step(`Turn ${nr.key} black: it has moved up into the place where black ${sib.key} was.`);
      }
      paint(s, sib, true, rec);
      far = sib;
      sib = nr;
      if (R) {
        rec.clearMarks();
        rec.mark(nid(far), 'ok');
        rec.vars({ node: kv(x), parent: pa.key, sibling: sib.key, near: kv(sib[side]), far: far.key });
        rec.line(`${side}_c3_down`, `${side}_c3_new`);
        rec.step(`Turn ${far.key} red, so the paths through it keep their black count. Now ${sib.key} is the sibling and ${far.key} its red far child, which is case 4.`);
      }
    } else if (R) {
      rec.clearMarks();
      rec.mark(nid(far!), 'compare');
      rec.line(`${side}_c3`);
      rec.step(`The far child, ${far!.key}, is red. One rotation at ${pa.key} and three colour changes will finish the job.`, {
        compare: { left: `colour of ${far!.key}`, op: '=', right: 'red', verdict: 'case 4: one rotation finishes' },
      });
    }
    const f = far!;
    const moved = rotate(s, pa, side, rec);
    if (R) {
      rec.clearMarks();
      markRotation(rec, pa, sib, moved);
      rec.line(`${side}_c4_rot`, `rotate_${side}`);
      rec.step(rotationText(pa, sib, moved, side));
    }
    const was = pa.red;
    paint(s, sib, was, rec);
    if (R) {
      rec.clearMarks();
      rec.mark(nid(sib), 'ok');
      rec.line(`${side}_c4_top`);
      rec.step(`${sib.key} takes ${pa.key}'s old colour, ${was ? 'red' : 'black'}, so this part of the tree looks the same from above.`);
    }
    paint(s, pa, false, rec);
    if (R) {
      rec.clearMarks();
      rec.mark(nid(pa), 'ok');
      rec.line(`${side}_c4_down`);
      rec.step(
        was
          ? `Turn ${pa.key} black. The double black's side now has one more black above it, which makes up the shortfall.`
          : `${pa.key} stays black, with ${sib.key} now black above it. The double black's side has one more black above it than before, which makes up the shortfall.`,
      );
    }
    paint(s, f, false, rec);
    s.dbl = null;
    if (R) {
      rec.clearMarks();
      rec.mark(nid(f), 'ok');
      rec.line(`${side}_c4_far`);
      rec.step(`Turn ${f.key} black. It lost black ${sib.key} from above it when ${sib.key} moved up, and this puts that black back.`);
    }
    return;
  }
  // The loop ended on a red node, or at the root.
  const n = x!;
  const lead = up ? `The double black moves up to ${n.key}. ` : '';
  const upLine = up ? [`${up}_c2_up`] : [];
  if (n.red) {
    if (R) {
      rec.clearMarks();
      rec.mark(nid(n), 'compare');
      rec.vars({ node: n.key, parent: kv(parent) });
      rec.line(...upLine, 'db_loop');
      rec.step(`${lead}${n.key} is red, so it can absorb the shortfall itself.`, {
        compare: { left: `colour of ${n.key}`, op: '=', right: 'red', verdict: 'red: turn it black' },
      });
    }
    paint(s, n, false, rec);
    s.dbl = null;
    if (R) {
      rec.clearMarks();
      rec.mark(nid(n), 'ok');
      rec.line('db_end');
      rec.step(`Turn ${n.key} black. That adds back the missing black on every path through it, and every rule holds again.`);
    }
  } else {
    s.dbl = null;
    if (R) {
      rec.clearMarks();
      rec.mark(nid(n), 'ok');
      rec.vars({ node: n.key, parent: null });
      rec.line(...upLine, 'db_loop', 'db_end');
      rec.step(`${lead}It has reached the root, which every path passes through, so the extra black is simply dropped: every path is one black shorter and the black height falls to ${blackHeight(s)}.`);
    }
  }
}

export function remove(s: RbState, key: number, rec: Rec): boolean {
  begin(s);
  if (!s.root) {
    rec.vars({ key, found: false });
    rec.line('missing');
    rec.step(`The tree is empty, so there is nothing to delete.`);
    return false;
  }
  const path: RbNode[] = [];
  const { node: found } = descend(s, key, rec, path, 'delete');
  if (!found) {
    if (rec.recording) {
      rec.mark(nid(path[path.length - 1]), 'bad');
      rec.vars({ key, found: false });
      rec.line('missing');
      rec.step(`${key} is not in the tree, so there is nothing to delete.`);
    }
    return false;
  }
  const R = rec.recording;
  let node = found;
  if (found.left && found.right) {
    if (R) {
      rec.mark(nid(found), 'bad');
      rec.vars({ key, node: key });
      rec.line('two_children');
      rec.step(
        `Found ${key}. It has two children, so its node stays and takes a new key instead: its in-order successor, the smallest key in its right subtree.`,
        { probe: { text: String(key), at: nid(found) } },
      );
    }
    let above = found;
    let succ = found.right;
    for (;;) {
      rec.count('reads');
      if (R) {
        rec.markEdge(eid(above, succ), 'path');
        rec.mark(nid(succ), succ.left ? 'path' : 'ok');
        const how = above === found ? `Step right from ${key} to ${succ.key}.` : `Step left to ${succ.key}.`;
        rec.vars({ key, node: key, succ: succ.key });
        rec.line(above === found ? 'step_right' : 'step_left');
        rec.step(
          succ.left
            ? `${how} It has a left child, so there is a smaller key below it: keep going left.`
            : `${how} It has no left child, so nothing in this subtree is smaller: ${succ.key} is the successor of ${key}.`,
          { probe: { text: String(key), at: nid(found) } },
        );
      }
      if (!succ.left) break;
      above = succ;
      succ = succ.left;
    }
    found.key = succ.key;
    touch(s, found, rec);
    if (R) {
      rec.clearMarks();
      rec.mark(nid(found), 'ok');
      rec.mark(nid(succ), 'bad');
      rec.vars({ key, node: succ.key, succ: succ.key });
      rec.line('copy_key');
      rec.step(
        `Copy ${succ.key} into ${key}'s node: ${key} is gone, and the order still holds because ${succ.key} was the next key after it. Now the old node that held ${succ.key} must go instead; it has no left child, so it has at most one child.`,
      );
    }
    node = succ;
  } else if (R) {
    const c = found.left ?? found.right;
    rec.mark(nid(found), 'bad');
    rec.vars({ key, node: key, child: kv(c) });
    rec.line('two_children', 'one_child');
    rec.step(
      c ? `Found ${key}. It has one child, ${c.key}, so its node can be unlinked and ${c.key} moved up into its place.` : `Found ${key}. It is a leaf, so its node can simply be unlinked.`,
      { probe: { text: String(key), at: nid(found) } },
    );
  }
  const child = node.left ?? node.right;
  const parent = node.parent;
  const label = node === found ? `${key}` : `the old ${node.key} node`;
  replace(s, node, child, rec);
  s.size--;
  if (R) {
    rec.clearMarks();
    if (child) rec.mark(nid(child), 'path');
    rec.vars({ key, node: node.key, child: kv(child) });
    rec.line('one_child', 'unlink');
    const where = child ? `; ${child.key} moves up into its place` : parent ? ` from ${parent.key}` : '';
    if (s.root) rec.step(`Unlink ${label}${where}. It was ${node.red ? 'red' : 'black'}, and that decides what happens next.`);
  }
  let last = 'done';
  if (node.red) {
    last = 'red_gone';
    if (R) {
      rec.line('red_gone');
      rec.step(`A red node adds no black to any path, so removing it changes no black count and cannot put two reds together. Every rule still holds.`);
    }
  } else if (isRed(child)) {
    last = 'child_black';
    paint(s, child!, false, rec);
    if (R) {
      rec.mark(nid(child!), 'ok');
      rec.line('child_black');
      rec.step(`Paths through ${child!.key} lost a black node, so they are one black short. ${child!.key} is red, so turning it black puts the missing black back.`);
    }
  } else if (s.root) {
    s.dbl = { node: child, parent };
    if (R) {
      if (child) rec.mark(nid(child), 'compare');
      rec.vars({ node: kv(child), parent: kv(parent) });
      rec.line('double_black', 'db_loop');
      rec.step(
        child
          ? `Every path through ${child.key} is now one black short. Mark ${child.key} "double black": it has to count as two blacks until the shortfall is made up.`
          : `Every path through the empty spot under ${parent!.key} is now one black short. Mark that null leaf "double black" (null leaves count as black): it has to count as two blacks until the shortfall is made up.`,
      );
    }
    fixDelete(s, child, parent!, rec);
  }
  s.dbl = null;

  if (R) {
    rec.clearMarks();
    rec.vars({ key });
    rec.line(last);
    rec.step(`${key} is deleted after ${cost(path.length, s)}. ${summary(s)}`);
  }
  return true;
}

const R_NODE = 22;
const GHOST = { ghost: true } as const;
type Item = RbNode | typeof GHOST;

export function layout(s: RbState): Scene {
  if (!s.root) {
    return { nodes: [], edges: [], decor: [{ id: 'empty', type: 'label', x: 0, y: 0, text: 'The tree is empty. Insert a key to start.', anchor: 'middle' }] };
  }
  // A double black on a null leaf is drawn as a small "nil" under its parent.
  const ghostParent = s.dbl && !s.dbl.node ? s.dbl.parent : null;
  const ghostSide: Side | null = ghostParent ? (ghostParent.left === null ? 'left' : 'right') : null;
  const kid = (n: RbNode, side: Side): Item | null => n[side] ?? (n === ghostParent && side === ghostSide ? GHOST : null);
  const pos = tidyTree<Item>({
    root: s.root,
    children: (it) => {
      if ('ghost' in it) return [];
      const l = kid(it, 'left');
      const r = kid(it, 'right');
      return l || r ? [l, r] : [];
    },
    width: () => R_NODE * 2,
    gapX: 24,
    gapY: 82,
    nullWidth: 60,
  });
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const dblNode = s.dbl?.node ?? null;
  for (const [it, p] of pos) {
    if ('ghost' in it) {
      nodes.push({ id: 'nil', x: p.x, y: p.y, shape: 'circle', r: 17, ink: 'black', cells: [{ text: 'nil', sub: 'double black', subValue: true }] });
      edges.push({ id: `e${ghostParent!.id}-nil`, from: nid(ghostParent!), to: 'nil', kind: 'line', dashed: true });
      continue;
    }
    const n = it;
    nodes.push({
      id: nid(n),
      x: p.x,
      y: p.y,
      shape: 'circle',
      r: R_NODE,
      ink: n.red ? 'red' : 'black',
      cells: [n === dblNode ? { text: String(n.key), sub: 'double black', subValue: true } : { text: String(n.key), sub: n.red ? 'red' : 'black' }],
      from: n.origin != null ? `n${n.origin}` : undefined,
    });
    if (n.left) edges.push({ id: eid(n, n.left), from: nid(n), to: nid(n.left), kind: 'line' });
    if (n.right) edges.push({ id: eid(n, n.right), from: nid(n), to: nid(n.right), kind: 'line' });
  }
  return { nodes, edges };
}

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: RbState): number {
  for (let i = 0; i < 60; i++) {
    const k = randomInt(1, 99);
    if (!has(s, k)) return k;
  }
  for (;;) {
    const k = randomInt(100, 999);
    if (!has(s, k)) return k;
  }
}

function presentKey(s: RbState): number {
  const all = keys(s);
  return all.length ? all[randomInt(0, all.length - 1)] : 42;
}

/** The most levels the rules allow for n keys: 2 log2(n + 1), rounded down. */
export const levelLimit = (n: number) => Math.floor(2 * Math.log2(n + 1) + 1e-9);

const def: StructureDef<RbState> = {
  id: 'red-black-tree',
  create: () => create(),
  seed: [95, 75, 40, 90, 25, 80, 15, 55].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], code: ['insert', 'fix_insert', 'rotate', 'colours', 'descend'], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], code: ['search', 'descend'], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], code: ['delete', 'fix_delete', 'rotate', 'colours', 'descend'], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Key comparisons' },
    { key: 'reads', label: 'Nodes visited' },
    { key: 'rotations', label: 'Rotations' },
    { key: 'recolours', label: 'Recolours' },
    { key: 'writes', label: 'Nodes written' },
  ],
  status: (s) => [
    { label: 'Keys', value: String(s.size) },
    { label: 'Levels', value: `${height(s)} (limit ${levelLimit(s.size)})` },
    { label: 'Black height', value: String(blackHeight(s)) },
    { label: 'Red nodes', value: String(redCount(s)) },
    { label: 'Rules', value: rulesHold(s) ? 'all hold' : 'broken' },
  ],
  // 85: red uncle, recolour only. 45: zig-zag, two rotations. 50: the recolour climbs two levels to the
  // root and the black height grows. 55: a search. 40: a black leaf goes, leaving a double black that
  // takes case 3 and then case 4 to repair.
  tour: [
    ['insert', 85],
    ['insert', 45],
    ['insert', 50],
    ['search', 55],
    ['delete', 40],
  ],
  fill: (s) => (s.size < CAP ? ['insert', absentKey(s)] : ['search', s.root!.key]),
  bench: { insert: 'insert', search: 'search' },
  source: { python, java },
  info: {
    summary:
      'A red-black tree is a binary search tree in which every node is coloured red or black, and a few colour rules keep the longest path from the root at most twice as long as the shortest. After an insert or delete the tree repairs the rules near the change, mostly by recolouring and with at most two rotations for an insert or three for a delete, so it stays at most 2 log2(n + 1) levels deep and every operation is O(log n).',
    watch: [
      'The five rules. 1: every node is red or black. 2: the root is black. 3: every null leaf (an empty child slot) counts as black. 4: a red node never has a red child. 5: every path from a node down to a null leaf passes the same number of black nodes. That number, counted from the root, is the black height.',
      'The colour is written under each node as well as drawn. Null leaves are not drawn, except when a delete leaves a "double black" on one: it then appears as a small nil.',
      'A new key always goes in red, because a red node adds no black to any path, so rule 5 cannot break. Only rule 4 (no red-red pair) or rule 2 (black root) can.',
      'Insert: if the uncle is red, recolour the parent and uncle black and the grandparent red, then check again two levels up. This can climb all the way to the root, which is the only way the black height grows.',
      'Insert: if the uncle is black (or a null leaf), rotate. A zig-zag needs two rotations, a straight line one, and then the repair is finished.',
      'Delete: removing a red node breaks nothing. Removing a black one leaves its place one black short, the "double black", and the four sibling cases either fix it with at most three rotations or push it up the tree.',
      'A search never looks at colours. The colours only exist to keep the tree shallow.',
    ],
    complexity: [
      { op: 'Search', average: 'O(log n)', worst: 'O(log n)', note: 'The height is at most 2 log2(n + 1), so that bounds the comparisons.' },
      { op: 'Insert', average: 'O(log n)', worst: 'O(log n)', note: 'One trip down, then at most two rotations. Recolouring can climb O(log n) levels, but averaged over many inserts it is O(1).' },
      { op: 'Delete', average: 'O(log n)', worst: 'O(log n)', note: 'At most three rotations. Case 2 can push the shortfall up O(log n) levels.' },
      { op: 'One rotation or recolour', average: 'O(1)', worst: 'O(1)', note: 'A rotation rewires a few pointers; a recolour flips one bit. Neither compares keys.' },
      { op: 'Range scan of k keys', average: 'O(log n + k)', worst: 'O(log n + k)', note: 'Find the first key, then walk the tree in order.' },
    ],
    space: 'O(n). Each key carries two child pointers, usually a parent pointer, and one bit of colour. Implementations often hide the bit in a spare low bit of a pointer.',
    usedIn: [
      { name: 'Java TreeMap and TreeSet', how: 'The sorted map and set in the Java standard library are red-black trees, which is why firstKey, ceilingKey and subMap are O(log n).' },
      { name: 'Java HashMap', how: 'Since Java 8, a bucket that collects many colliding keys is turned from a linked list into a red-black tree, so one bad bucket costs O(log n) per lookup rather than O(n).' },
      { name: 'C++ std::map and std::set', how: 'The standard only asks for O(log n) ordered operations, but the common implementations (GCC libstdc++ and LLVM libc++) build them as red-black trees.' },
      { name: 'Linux kernel', how: 'The kernel has a shared rbtree library. The CFS scheduler kept runnable tasks in one, ordered by virtual run time, so the next task to run was always the leftmost node; epoll keeps its watched file descriptors in one.' },
    ],
    reachFor: [
      'An in-memory ordered map or set with a steady mix of inserts, deletes and lookups.',
      'You need a worst-case bound on every operation, not a good average: O(log n) whatever order the keys arrive in.',
      'You need order as well as lookup: smallest, largest, next key after x, everything in a range.',
      'Writes must touch little memory: at most two or three rotations per update keeps the changed nodes few, which also suits persistent (copy-on-write) versions.',
    ],
    costs: [
      'Lookups are a little slower than in an AVL tree, because the tree can be up to about 2 log2 n deep rather than about 1.44 log2 n.',
      'The delete repair has many cases and is easy to get wrong. If you write one yourself, test it against a simple model and check the rules after every operation.',
      'Every step down follows a pointer to somewhere else in memory. A sorted array or a B-tree uses the CPU cache far better.',
      'It does not belong on disk: a binary tree of a billion keys is about 30 to 60 levels deep, one page read each. A B+ tree needs three or four.',
      'If you only need exact-match lookups, a hash table is simpler and O(1) on average.',
    ],
    interview: [
      'The rules in one breath: the root is black, null leaves are black, a red node has no red child, and every root-to-null path has the same number of black nodes.',
      'Why that bounds the height: if every path has b black nodes, the tree holds at least 2^b − 1 keys, so b ≤ log2(n + 1). Reds cannot sit in a row, so no path is longer than 2b. That gives height ≤ 2 log2(n + 1): for a million keys, at most 40 levels.',
      'Against AVL: AVL keeps the two sides of every node within one level, so it is shallower (about 1.44 log2 n) and lookups are slightly faster. Red-black allows more slack, so it rotates less on writes: at most two rotations per insert and three per delete, where an AVL delete can rotate at every level. Libraries usually pick red-black because they cannot predict the read-to-write mix.',
      'A red-black tree is a 2-3-4 tree (a B-tree of order 4) drawn as a binary tree. Merge each black node with its red children and you get a node holding one to three keys, with every leaf at the same depth: that depth is the black height. The red-uncle recolour is a full 4-node splitting and pushing its middle key up.',
      'A new node is red because that can only break the no-red-red rule, which is local and cheap to repair. Making it black would break the equal-black-count rule on every path through it.',
      'An ordered in-memory map (an order book keyed by price, a timer wheel, a scheduler run queue) needs insert, delete and "next key above x" in O(log n). A balanced tree or a skip list gives that; a hash table cannot answer ordered queries.',
      'Why a database index is not a red-black tree: on disk the cost is page reads, not comparisons. A B+ tree node holds hundreds of keys, so a billion rows sit 3 or 4 levels deep.',
    ],
  },
};

export default def;
