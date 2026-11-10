import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { CAP, create, height, insert, keys, layout, remove, search, type AvlNode, type AvlState } from './index';

const quiet = (s: AvlState) => new Recorder(s, layout, false);
const loud = (s: AvlState) => new Recorder(s, layout, true);

/**
 * Throws if the tree is not a valid AVL tree: keys in search-tree order, every
 * stored height correct, every balance factor in -1..1, and the size right.
 */
function check(s: AvlState): void {
  let count = 0;
  const walk = (n: AvlNode | null, lo: number, hi: number): number => {
    if (!n) return 0;
    count++;
    if (!(n.key > lo && n.key < hi)) throw new Error(`key ${n.key} is outside (${lo}, ${hi})`);
    const hl = walk(n.left, lo, n.key);
    const hr = walk(n.right, n.key, hi);
    if (n.h !== 1 + Math.max(hl, hr)) throw new Error(`stored height of ${n.key} is ${n.h}, should be ${1 + Math.max(hl, hr)}`);
    if (Math.abs(hl - hr) > 1) throw new Error(`balance factor of ${n.key} is ${hl - hr}`);
    return n.h;
  };
  const h = walk(s.root, -Infinity, Infinity);
  expect(count).toBe(s.size);
  expect(height(s)).toBe(h);
  // The AVL height bound: h < 1.4405 log2(n + 2) - 0.3277.
  if (count) expect(h).toBeLessThan(1.4405 * Math.log2(count + 2) - 0.3277 + 1e-9);
}

/** Every frame must be drawable: unique ids, edges that join real nodes, a probe that points at a real node. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const edgeIds = new Set(f.scene.edges.map((e) => e.id));
    expect(edgeIds.size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(4);
    // Narration is one or two sentences.
    expect(f.message.split(/[.?!]\s+(?=[A-Z0-9])/).length, f.message).toBeLessThanOrEqual(2);
    expect(f.message).not.toMatch(/undefined|NaN|null/);
  }
}

function build(order: number[]): AvlState {
  const s = create();
  for (const k of order) insert(s, k, quiet(s));
  return s;
}

/** Shape of the tree as nested arrays, for exact assertions on small trees. */
function shape(n: AvlNode | null): unknown {
  if (!n) return null;
  return n.left || n.right ? [n.key, shape(n.left), shape(n.right)] : n.key;
}

describe('AVL tree', () => {
  for (const seed of [1, 2, 3]) {
    it(`keeps the AVL invariant and search-tree order through random operations (seed ${seed})`, () => {
      const rnd = makeRng(seed * 104729);
      const s = create();
      const model = new Set<number>();
      for (let i = 0; i < 4000; i++) {
        const k = Math.floor(rnd() * 1000);
        const r = rnd();
        if (r < 0.5) {
          expect(insert(s, k, quiet(s))).toBe(!model.has(k));
          model.add(k);
        } else if (r < 0.9) {
          expect(remove(s, k, quiet(s))).toBe(model.has(k));
          model.delete(k);
        } else {
          expect(search(s, k, quiet(s))).toBe(model.has(k));
        }
        if (i % 25 === 0) {
          check(s);
          expect(keys(s)).toEqual([...model].sort((a, b) => a - b));
        }
      }
      check(s);
      expect(keys(s)).toEqual([...model].sort((a, b) => a - b));
      for (let k = 0; k < 1000; k++) expect(search(s, k, quiet(s))).toBe(model.has(k));
      // Empty it completely, checking after every delete.
      for (const k of [...model]) {
        expect(remove(s, k, quiet(s))).toBe(true);
        check(s);
      }
      expect(s.size).toBe(0);
      expect(s.root).toBe(null);
    });
  }

  it('stays valid after every single operation on a small, busy key range', () => {
    const rnd = makeRng(77);
    const s = create();
    const model = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      const k = Math.floor(rnd() * 40);
      if (rnd() < 0.55) {
        insert(s, k, quiet(s));
        model.add(k);
      } else {
        remove(s, k, quiet(s));
        model.delete(k);
      }
      check(s);
    }
    expect(keys(s)).toEqual([...model].sort((a, b) => a - b));
  });

  it('takes 5,000 sorted inserts with recording off and stays logarithmic', () => {
    const up = create();
    const rec = new Recorder(up, () => {
      throw new Error('layout must not be called with recording off');
    }, false);
    for (let k = 1; k <= 5000; k++) insert(up, k, rec);
    check(up);
    expect(up.size).toBe(5000);
    // 5,000 ascending keys make a plain search tree 5,000 levels deep. Here it is as shallow as a tree can be.
    expect(height(up)).toBe(13);
    expect(rec.frames.length).toBe(0);
    expect(rec.counters.comparisons).toBeLessThan(5000 * 13);
    expect(rec.counters.rotations).toBeLessThan(5000);

    const down = create();
    for (let k = 5000; k >= 1; k--) insert(down, k, quiet(down));
    check(down);
    expect(height(down)).toBe(13);

    const look = quiet(up);
    for (let k = 1; k <= 5000; k++) expect(search(up, k, look)).toBe(true);
    expect(look.counters.comparisons / 5000).toBeLessThanOrEqual(13);

    for (let k = 1; k <= 5000; k++) remove(up, k, rec);
    check(up);
    expect(up.size).toBe(0);
  });

  it('uses the right rotation for each of the four cases', () => {
    const run = (order: number[]) => {
      const s = create();
      const rec = quiet(s);
      for (const k of order) insert(s, k, rec);
      check(s);
      return { tree: shape(s.root), rotations: rec.counters.rotations ?? 0 };
    };
    expect(run([30, 20, 10])).toEqual({ tree: [20, 10, 30], rotations: 1 }); // left-left: single right
    expect(run([10, 20, 30])).toEqual({ tree: [20, 10, 30], rotations: 1 }); // right-right: single left
    expect(run([30, 10, 20])).toEqual({ tree: [20, 10, 30], rotations: 2 }); // left-right: left then right
    expect(run([10, 30, 20])).toEqual({ tree: [20, 10, 30], rotations: 2 }); // right-left: right then left
    expect(run([20, 10, 30])).toEqual({ tree: [20, 10, 30], rotations: 0 });
  });

  it('moves the middle subtree across in a rotation', () => {
    // 50 leans left; inserting 5 makes it left-left. 40 sorts between 30 and 50 and must change parent.
    const s = build([50, 30, 60, 20, 40]);
    insert(s, 5, quiet(s));
    check(s);
    expect(shape(s.root)).toEqual([30, [20, 5, null], [50, 40, 60]]);
  });

  it('deletes with the in-order successor and rebalances', () => {
    const s = build([50, 30, 70, 20, 40, 60, 80, 65]);
    const rec = quiet(s);
    // 50 has two children. Its successor is 60, whose right child 65 takes 60's old place.
    expect(remove(s, 50, rec)).toBe(true);
    check(s);
    expect(shape(s.root)).toEqual([60, [30, 20, 40], [70, 65, 80]]);
    expect(rec.counters.rotations ?? 0).toBe(0);

    // The successor is the right child itself, and its removal forces a rotation.
    const t = build([50, 30, 70, 20, 40, 10]);
    expect(shape(t.root)).toEqual([30, [20, 10, null], [50, 40, 70]]);
    const rec2 = quiet(t);
    remove(t, 50, rec2);
    remove(t, 40, rec2);
    check(t);
    expect(shape(t.root)).toEqual([30, [20, 10, null], 70]);
    remove(t, 70, rec2);
    check(t);
    expect(shape(t.root)).toEqual([20, 10, 30]);
    expect(rec2.counters.rotations).toBe(1);
  });

  it('can rotate more than once on the way up after a delete', () => {
    // A Fibonacci tree is the sparsest tree the AVL rule allows. Removing a key from its shallow side
    // leaves every ancestor leaning the other way, so the repair cascades.
    const s = build([50, 30, 80, 20, 40, 70, 100, 10, 35, 60, 75, 90, 110, 65, 85, 105, 120, 130]);
    check(s);
    let most = 0;
    for (const k of keys(s)) {
      const copy = build([50, 30, 80, 20, 40, 70, 100, 10, 35, 60, 75, 90, 110, 65, 85, 105, 120, 130]);
      const rec = quiet(copy);
      remove(copy, k, rec);
      check(copy);
      most = Math.max(most, rec.counters.rotations ?? 0);
    }
    expect(most).toBeGreaterThanOrEqual(2);

    // And over random trees every delete leaves a valid tree, however many rotations it took.
    const rnd = makeRng(2026);
    let cascades = 0;
    for (let round = 0; round < 300; round++) {
      const t = create();
      for (let i = 0; i < 40; i++) insert(t, Math.floor(rnd() * 1000), quiet(t));
      const all = keys(t);
      const rec = quiet(t);
      remove(t, all[Math.floor(rnd() * all.length)], rec);
      check(t);
      if ((rec.counters.rotations ?? 0) >= 2) cascades++;
    }
    expect(cascades).toBeGreaterThan(0);
  });

  it('counts the same with recording on and off, and every frame is drawable', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    let frames = 0;
    for (let i = 0; i < 1500; i++) {
      const k = Math.floor(rnd() * 60);
      const r = rnd();
      // Keep below the display limit so the recorded tree and the silent one see the same inserts.
      const op = r < 0.45 && a.size < CAP ? insert : r < 0.8 ? remove : search;
      const on = loud(a);
      const off = quiet(b);
      expect(op(a, k, on)).toBe(op(b, k, off));
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      checkFrames(on.frames);
      // The last frame carries the final totals.
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      frames += on.frames.length;
      check(a);
      expect(keys(a)).toEqual(keys(b));
    }
    expect(frames).toBeGreaterThan(5000);
  });

  it('a lookup reads one node per comparison and never more than the height', () => {
    const s = build(Array.from({ length: 500 }, (_, i) => i * 2));
    for (const k of [0, 1, 250, 499, 998, 999]) {
      const rec = quiet(s);
      search(s, k, rec);
      expect(rec.counters.reads).toBe(rec.counters.comparisons);
      expect(rec.counters.comparisons).toBeLessThanOrEqual(height(s));
      expect(rec.counters.writes ?? 0).toBe(0);
    }
  });

  it('follows the key with the probe on every comparison', () => {
    const s = build([50, 30, 70, 20, 40, 60, 10]);
    const rec = loud(s);
    search(s, 40, rec);
    const compares = rec.frames.filter((f) => f.compare);
    expect(compares.map((f) => `${f.compare!.left} ${f.compare!.op} ${f.compare!.right}`)).toEqual(['40 < 50', '40 > 30', '40 = 40']);
    expect(compares.map((f) => f.probe?.at)).toEqual(['k50', 'k30', 'k40']);
    expect(rec.counters.comparisons).toBe(3);
  });

  it('shows the unbalanced node as bad, then both steps of a double rotation', () => {
    const s = build([50, 30, 70, 20, 40, 60]);
    const rec = loud(s);
    insert(s, 65, rec);
    check(s);
    expect(rec.counters.rotations).toBe(2);
    const tone = (f: Frame, id: string) => f.scene.nodes.find((n) => n.id === id)?.tone;
    const parentOf = (f: Frame, id: string) => f.scene.edges.find((e) => e.to === id)?.from;
    const bad = rec.frames.findIndex((f) => tone(f, 'k70') === 'bad');
    expect(bad).toBeGreaterThan(0);
    expect(rec.frames[bad].compare).toMatchObject({ left: 'balance +2', op: '>', right: '1' });
    // First rotation: 65 rises above 60, still under 70.
    const first = rec.frames.findIndex((f) => parentOf(f, 'k60') === 'k65' && parentOf(f, 'k65') === 'k70');
    // Second rotation: 65 is on top with 60 and 70 below it.
    const second = rec.frames.findIndex((f) => parentOf(f, 'k60') === 'k65' && parentOf(f, 'k70') === 'k65');
    expect(first).toBeGreaterThan(bad);
    expect(second).toBe(first + 1);
    expect(rec.frames[first].counters.rotations).toBe(1);
    expect(rec.frames[second].counters.rotations).toBe(2);
    expect(tone(rec.frames[second], 'k70')).toBe('ok');
    expect(tone(rec.frames[second], 'k60')).toBe('ok');
    // Comparisons on the way back up are shown but are not key comparisons.
    expect(rec.counters.comparisons).toBe(3);
    // Each node's balance factor is its sub label.
    const last = rec.frames[rec.frames.length - 1];
    expect(Object.fromEntries(last.scene.nodes.map((n) => [n.id, n.cells[0].sub]))).toEqual({
      k50: '0', k30: '0', k20: '0', k40: '0', k65: '0', k60: '0', k70: '0',
    });
  });

  it(`refuses, politely, to draw more than ${CAP} keys, but has no limit with recording off`, () => {
    const s = build(Array.from({ length: CAP }, (_, i) => i * 10));
    const rec = loud(s);
    expect(insert(s, 5, rec)).toBe(false);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toMatch(/^Sorry/);
    expect(rec.counters).toEqual({});
    expect(s.size).toBe(CAP);
    // A key that is already there gets the usual answer, not the refusal.
    const dup = loud(s);
    expect(insert(s, 30, dup)).toBe(false);
    expect(dup.frames[dup.frames.length - 1].message).toMatch(/already stored/);
    expect(insert(s, 5, quiet(s))).toBe(true);
    expect(s.size).toBe(CAP + 1);
    check(s);
    // The quick-fill button stops at the limit.
    const full = build(Array.from({ length: CAP }, (_, i) => i * 10));
    expect(def.fill!(full)[0]).toBe('search');
    expect(def.fill!(build([1, 2, 3]))[0]).toBe('insert');
  });

  it('handles the empty tree and the last key', () => {
    const s = create();
    expect(layout(s).nodes.length).toBe(0);
    for (const op of [search, remove]) {
      const rec = loud(s);
      expect(op(s, 7, rec)).toBe(false);
      expect(rec.frames.length).toBe(1);
    }
    const ins = loud(s);
    expect(insert(s, 7, ins)).toBe(true);
    expect(ins.counters).toEqual({ writes: 1 });
    const again = loud(s);
    expect(insert(s, 7, again)).toBe(false);
    checkFrames(again.frames);
    const del = loud(s);
    expect(remove(s, 7, del)).toBe(true);
    checkFrames(del.frames);
    expect(del.frames[del.frames.length - 1].message).toMatch(/now empty/);
    expect(s.root).toBe(null);
  });

  it('lays the tree out without overlaps, even at the display limit', () => {
    const rnd = makeRng(99);
    for (let round = 0; round < 40; round++) {
      const s = create();
      while (s.size < CAP) insert(s, Math.floor(rnd() * 1000), quiet(s));
      const scene = layout(s);
      let minX = Infinity;
      let maxX = -Infinity;
      for (const a of scene.nodes) {
        const { w } = nodeSize(a);
        minX = Math.min(minX, a.x - w / 2);
        maxX = Math.max(maxX, a.x + w / 2);
        for (const b of scene.nodes) {
          if (a === b) continue;
          if (a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(w + 8);
        }
      }
      expect(maxX - minX).toBeLessThan(1250);
    }
  });

  it('seed and tour run cleanly through the definition', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(s.size).toBe(7);
    expect(shape(s.root)).toEqual([50, [30, [20, 10, null], 40], [70, 60, null]]);

    const rotations: number[] = [];
    const cases: string[] = [];
    let streakNoted = false;
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      checkFrames(rec.frames);
      check(s);
      rotations.push(rec.counters.rotations ?? 0);
      for (const f of rec.frames) {
        const m = f.compare?.verdict.match(/^(left|right)-(left|right) case/);
        if (m) cases.push(`${id} ${args[0]}: ${m[1]}-${m[2]}`);
        if (/in a row to arrive as the new largest/.test(f.message)) streakNoted = true;
      }
      // The last frame states the outcome and the cost.
      expect(rec.frames[rec.frames.length - 1].message).toMatch(/after \d+ comparisons? and (no rotations|\d+ rotations?)\./);
    }
    // Four to six steps that between them show every rotation case, and a delete that has to rotate.
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    expect(cases).toEqual(['insert 5: left-left', 'insert 65: left-right', 'insert 90: right-right', 'insert 75: right-left', 'delete 30: left-left']);
    expect(rotations).toEqual([1, 2, 0, 1, 2, 1]);
    expect(streakNoted).toBe(true);
    expect(keys(s)).toEqual([5, 10, 20, 40, 50, 60, 65, 70, 75, 80, 90]);
    expect(shape(s.root)).toEqual([50, [10, 5, [40, 20, null]], [70, [65, 60, null], [80, 75, 90]]]);
    expect(height(s)).toBe(4);
    expect(def.status!(s).map((f) => f.value)).toEqual(['11', '4', '11 levels']);
    expect(def.bench).toEqual({ insert: 'insert', search: 'search' });
  });
});
