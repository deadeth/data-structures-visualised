import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { MAX_KEYS, MAX_LEVELS, bestHeight, create, height, insert, keys, layout, remove, search, type BstNode, type BstState } from './index';

const quiet = (s: BstState) => new Recorder(s, layout, false);
const loud = (s: BstState) => new Recorder(s, layout, true);

function build(order: number[]): BstState {
  const s = create();
  for (const k of order) insert(s, k, quiet(s));
  return s;
}

function find(s: BstState, key: number): BstNode | null {
  let n = s.root;
  while (n && n.key !== key) n = key < n.key ? n.left : n.right;
  return n;
}

/** Throws if the search-tree ordering, the size or the node ids are wrong. Iterative, so deep trees are fine. */
function check(s: BstState): void {
  const ids = new Set<number>();
  let count = 0;
  const stack: [BstNode, number, number][] = s.root ? [[s.root, -Infinity, Infinity]] : [];
  while (stack.length) {
    const [n, lo, hi] = stack.pop()!;
    count++;
    expect(n.key).toBeGreaterThan(lo);
    expect(n.key).toBeLessThan(hi);
    expect(ids.has(n.id)).toBe(false);
    ids.add(n.id);
    if (n.left) stack.push([n.left, lo, n.key]);
    if (n.right) stack.push([n.right, n.key, hi]);
  }
  expect(count).toBe(s.size);
  const inOrder = keys(s);
  for (let i = 1; i < inOrder.length; i++) expect(inOrder[i - 1]).toBeLessThan(inOrder[i]);
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null/);
  }
}

describe('binary search tree', () => {
  for (const seed of [1, 2, 3]) {
    it(`matches a Set through random inserts, searches and deletes (seed ${seed})`, () => {
      const rnd = makeRng(seed * 104729);
      const s = create();
      const model = new Set<number>();
      for (let i = 0; i < 4000; i++) {
        const k = Math.floor(rnd() * 300);
        const roll = rnd();
        if (roll < 0.5) {
          expect(insert(s, k, quiet(s))).toBe(!model.has(k));
          model.add(k);
        } else if (roll < 0.85) {
          expect(remove(s, k, quiet(s))).toBe(model.has(k));
          model.delete(k);
        } else {
          expect(search(s, k, quiet(s))).toBe(model.has(k));
        }
        if (i % 40 === 0) check(s);
      }
      check(s);
      expect(keys(s)).toEqual([...model].sort((a, b) => a - b));
      for (let k = 0; k < 300; k++) expect(search(s, k, quiet(s))).toBe(model.has(k));
      for (const k of [...model]) expect(remove(s, k, quiet(s))).toBe(true);
      expect(s.root).toBe(null);
      expect(s.size).toBe(0);
      expect(height(s)).toBe(0);
    });
  }

  it('in-order traversal gives sorted output whatever the arrival order', () => {
    const s = build([50, 27, 73, 14, 38, 62, 85, 33, 45]);
    expect(keys(s)).toEqual([14, 27, 33, 38, 45, 50, 62, 73, 85]);
  });

  it('best possible height is ceil(log2(n + 1))', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 9, 12, 15, 16, 5000].map(bestHeight)).toEqual([0, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5, 13]);
  });

  it('survives 5,000 sorted keys without recursion, and pays for it', () => {
    const s = create();
    const ins = quiet(s);
    for (let k = 1; k <= 5000; k++) insert(s, k, ins);
    expect(s.size).toBe(5000);
    expect(height(s)).toBe(5000);
    expect(bestHeight(s.size)).toBe(13);
    // Key k is compared with every key before it.
    expect(ins.counters.comparisons).toBe((5000 * 4999) / 2);
    const look = quiet(s);
    expect(search(s, 5000, look)).toBe(true);
    expect(look.counters.comparisons).toBe(5000);
    expect(look.counters.reads).toBe(5000);
    expect(search(s, 5001, quiet(s))).toBe(false);
    expect(keys(s).length).toBe(5000);
    expect(layout(s).nodes.length).toBe(5000);
    expect(def.status!(s).map((f) => f.value)).toEqual(['5000', '5000 levels', '13 levels']);
    expect(remove(s, 2500, quiet(s))).toBe(true);
    expect(remove(s, 1, quiet(s))).toBe(true);
    expect(remove(s, 5000, quiet(s))).toBe(true);
    check(s);
    // The same keys in descending order: a spine down the left.
    const t = create();
    for (let k = 5000; k >= 1; k--) insert(t, k, quiet(t));
    expect(height(t)).toBe(5000);
    expect(remove(t, 5000, quiet(t))).toBe(true);
    check(t);
  });

  it('deletes a leaf by unlinking it', () => {
    const s = build([50, 27, 73, 14]);
    const rec = loud(s);
    expect(remove(s, 14, rec)).toBe(true);
    expect(find(s, 27)!.left).toBe(null);
    expect(rec.counters.writes).toBe(1);
    expect(rec.frames.some((f) => /leaf/.test(f.message))).toBe(true);
    checkFrames(rec.frames);
    check(s);
  });

  it('deletes a node with one child by moving the child up', () => {
    const s = build([50, 27, 73, 14, 9, 20]);
    const fourteen = find(s, 14)!;
    const rec = loud(s);
    expect(remove(s, 27, rec)).toBe(true);
    expect(s.root!.left).toBe(fourteen);
    expect(rec.counters.writes).toBe(1);
    expect(rec.frames.some((f) => /one child/.test(f.message))).toBe(true);
    checkFrames(rec.frames);
    check(s);
    // The root with one child hands over to that child.
    const t = build([10, 20, 15, 30]);
    const twenty = find(t, 20)!;
    const rec2 = loud(t);
    expect(remove(t, 10, rec2)).toBe(true);
    expect(t.root).toBe(twenty);
    checkFrames(rec2.frames);
    check(t);
  });

  it('deletes a node with two children by copying its in-order successor', () => {
    //        50
    //    27      73
    //  14  38  62  85
    //     33 45 \
    //      \    66
    //      35
    const s = build([50, 27, 73, 14, 38, 62, 85, 33, 45, 35, 66]);
    const node = find(s, 27)!;
    const id = node.id;
    const rec = loud(s);
    expect(remove(s, 27, rec)).toBe(true);
    // Same node, same id, new key. The successor 33 had a right child, 35, which moved up.
    expect(node.id).toBe(id);
    expect(node.key).toBe(33);
    expect(s.root!.left).toBe(node);
    expect(find(s, 38)!.left!.key).toBe(35);
    expect(rec.counters.writes).toBe(2);
    // Found 27 in 2 reads, then walked 38 and 33.
    expect(rec.counters.reads).toBe(4);
    expect(rec.counters.comparisons).toBe(2);
    expect(rec.frames.some((f) => /successor/.test(f.message))).toBe(true);
    expect(rec.frames.some((f) => /Walk left to 33/.test(f.message))).toBe(true);
    // One frame shows the successor's key in two nodes at once.
    expect(rec.frames.some((f) => f.scene.nodes.filter((n) => n.cells[0].text === '33').length === 2)).toBe(true);
    checkFrames(rec.frames);
    check(s);
    expect(keys(s)).toEqual([14, 33, 35, 38, 45, 50, 62, 66, 73, 85]);

    // Successor is the right child itself (no walk left).
    const rec2 = loud(s);
    expect(remove(s, 62, rec2)).toBe(true);
    expect(find(s, 73)!.left!.key).toBe(66);
    checkFrames(rec2.frames);
    check(s);
    // Deleting the root.
    const rootId = s.root!.id;
    expect(remove(s, 50, loud(s))).toBe(true);
    expect(s.root!.id).toBe(rootId);
    expect(s.root!.key).toBe(66);
    check(s);
  });

  it('counts the same with recording on and off, and every frame is well formed', () => {
    const rnd = makeRng(77);
    const a = create();
    const b = create();
    for (let i = 0; i < 600; i++) {
      // A small key range keeps the tree inside the drawing limits most of the time.
      const k = Math.floor(rnd() * 28);
      const roll = rnd();
      const on = loud(a);
      const off = quiet(b);
      let ra: boolean;
      let rb: boolean;
      if (roll < 0.4) {
        ra = insert(a, k, on);
        rb = insert(b, k, off);
        if (ra !== rb) {
          // Refused by the drawing limits. Put the trees back in step and move on.
          expect(ra).toBe(false);
          expect(on.frames[on.frames.length - 1].message).toMatch(/stays readable/);
          expect(remove(b, k, quiet(b))).toBe(true);
          continue;
        }
      } else if (roll < 0.75) {
        ra = remove(a, k, on);
        rb = remove(b, k, off);
        expect(ra).toBe(rb);
      } else {
        ra = search(a, k, on);
        rb = search(b, k, off);
        expect(ra).toBe(rb);
      }
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(off.counters).toEqual(on.counters);
      const last = on.frames[on.frames.length - 1];
      expect(last.counters).toEqual(on.counters);
      expect(last.compare).toBeUndefined();
      checkFrames(on.frames);
      expect(keys(a)).toEqual(keys(b));
    }
    check(a);
  });

  it('every comparison is a frame with the probe on the node being compared', () => {
    const s = build([50, 27, 73, 14, 38, 62, 85, 33, 45]);
    const rec = loud(s);
    expect(search(s, 45, rec)).toBe(true);
    const cmp = rec.frames.filter((f) => f.compare);
    expect(cmp.map((f) => `${f.compare!.left} ${f.compare!.op} ${f.compare!.right}`)).toEqual(['45 < 50', '45 > 27', '45 > 38', '45 = 45']);
    expect(cmp.map((f) => f.compare!.verdict)).toEqual(['smaller, go left', 'larger, go right', 'larger, go right', 'match']);
    for (const f of cmp) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at)!;
      expect(at.cells[0].text).toBe(String(f.compare!.right));
      expect(at.tone).toBe('compare');
      expect(f.probe!.text).toBe('45');
    }
    expect(rec.counters).toEqual({ comparisons: 4, reads: 4 });
    // The right subtree of 50 was ruled out by the first comparison.
    const end = rec.frames[rec.frames.length - 1];
    for (const k of ['73', '62', '85']) expect(end.scene.nodes.find((n) => n.cells[0].text === k)!.tone).toBe('dim');
    // A miss.
    const miss = loud(s);
    expect(search(s, 40, miss)).toBe(false);
    expect(miss.frames[miss.frames.length - 1].message).toMatch(/not in the tree/);
    // A duplicate insert changes nothing.
    const dup = loud(s);
    expect(insert(s, 45, dup)).toBe(false);
    expect(dup.counters.writes).toBeUndefined();
    expect(s.size).toBe(9);
  });

  it('refuses politely at 7 levels and at 20 keys while recording, and has no limit otherwise', () => {
    const s = create();
    for (let k = 1; k <= MAX_LEVELS; k++) expect(insert(s, k * 10, loud(s))).toBe(true);
    expect(height(s)).toBe(MAX_LEVELS);
    const rec = loud(s);
    expect(insert(s, 99, rec)).toBe(false);
    expect(s.size).toBe(MAX_LEVELS);
    expect(height(s)).toBe(MAX_LEVELS);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/level 8.*stays readable/);
    expect(rec.counters.writes).toBeUndefined();
    checkFrames(rec.frames);
    // Shallow spots are still open.
    expect(insert(s, 5, loud(s))).toBe(true);
    // With recording off the same key goes in.
    expect(insert(s, 99, quiet(s))).toBe(true);
    expect(height(s)).toBe(MAX_LEVELS + 1);

    const rnd = makeRng(5);
    const t = create();
    while (t.size < MAX_KEYS) insert(t, Math.floor(rnd() * 1000), quiet(t));
    const full = loud(t);
    const absent = keys(t)[0] === 0 ? 1000 : 0;
    expect(insert(t, absent, full)).toBe(false);
    expect(t.size).toBe(MAX_KEYS);
    expect(full.frames[full.frames.length - 1].message).toMatch(/stops at 20 keys/);
    checkFrames(full.frames);
    expect(insert(t, absent, quiet(t))).toBe(true);
    expect(t.size).toBe(MAX_KEYS + 1);
  });

  it('lays out without overlaps, with left and right children on their own sides', () => {
    const rnd = makeRng(11);
    for (let round = 0; round < 60; round++) {
      const s = def.create({});
      // Fill to the drawing limits the way the page does.
      for (let i = 0; i < 400 && s.size < MAX_KEYS; i++) {
        const k = Math.floor(rnd() * 1000);
        let level = 1;
        for (let n = s.root; n; level++) n = k < n.key ? n.left : k > n.key ? n.right : null;
        if (level <= MAX_LEVELS) insert(s, k, quiet(s));
      }
      const scene = layout(s);
      const at = new Map(scene.nodes.map((n) => [n.id, n]));
      for (let i = 0; i < scene.nodes.length; i++) {
        for (let j = i + 1; j < scene.nodes.length; j++) {
          const p = scene.nodes[i];
          const q = scene.nodes[j];
          expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r! + q.r! + 6);
        }
      }
      const stack: BstNode[] = s.root ? [s.root] : [];
      while (stack.length) {
        const n = stack.pop()!;
        const me = at.get(`n${n.id}`)!;
        if (n.left) {
          expect(at.get(`n${n.left.id}`)!.x).toBeLessThan(me.x);
          stack.push(n.left);
        }
        if (n.right) {
          expect(at.get(`n${n.right.id}`)!.x).toBeGreaterThan(me.x);
          stack.push(n.right);
        }
      }
      const xs = scene.nodes.map((n) => n.x);
      const ys = scene.nodes.map((n) => n.y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1000);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(74 * (MAX_LEVELS - 1));
    }
    // An empty tree still gives a scene.
    const empty = layout(create());
    expect(empty.nodes.length).toBe(0);
    expect(empty.decor!.length).toBe(1);
  });

  it('seed and tour run cleanly through the definition and end on a runaway spine', () => {
    expect(def.id).toBe('bst');
    expect(def.bench).toEqual({ insert: 'insert', search: 'search' });
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(s.size).toBe(9);
    expect(def.status!(s).map((f) => f.value)).toEqual(['9', '4 levels', '4 levels']);

    const before = keys(s);
    let last: Recorder<BstState> | null = null;
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(2);
      expect(rec.frames.some((f) => f.compare && f.probe)).toBe(true);
      checkFrames(rec.frames);
      check(s);
      last = rec;
    }
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    // The tour's delete took out the root, which had two children; its node now holds the successor.
    expect(before).toContain(50);
    expect(keys(s)).not.toContain(50);
    expect(s.root!.key).toBe(56);
    expect(keys(s)).toEqual([14, 27, 33, 38, 45, 56, 62, 73, 85, 90, 94, 97]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['12', '6 levels', '4 levels']);
    const final = last!.frames[last!.frames.length - 1].message;
    expect(final).toMatch(/spine/);
    expect(final).toMatch(/6 levels now, where 12 keys need only 4/);
  });

  it('suggestions and fill stay inside the drawing limits', () => {
    const s = def.create({});
    const op = (id: string) => def.ops.find((o) => o.id === id)!;
    for (const [id, ...args] of def.seed) op(id).run(s, args, quiet(s));
    for (let i = 0; i < 60; i++) {
      const [id, ...args] = def.fill!(s);
      op(id).run(s, args, quiet(s));
      expect(s.size).toBeLessThanOrEqual(MAX_KEYS);
      expect(height(s)).toBeLessThanOrEqual(MAX_LEVELS);
    }
    expect(s.size).toBe(MAX_KEYS);
    check(s);
    expect(keys(s)).toContain(op('search').suggest!(s)[0]);
    expect(keys(s)).toContain(op('delete').suggest!(s)[0]);
    expect(keys(s)).not.toContain(op('insert').suggest!(s)[0]);
    const empty = def.create({});
    expect(typeof def.fill!(empty)[1]).toBe('number');
    expect(typeof op('delete').suggest!(empty)[0]).toBe('number');
  });
});
