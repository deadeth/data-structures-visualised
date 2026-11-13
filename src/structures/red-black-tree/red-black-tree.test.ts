import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { CAP, blackHeight, create, height, insert, keys, layout, levelLimit, redCount, remove, rulesHold, search, type RbNode, type RbState } from './index';

const quiet = (s: RbState) => new Recorder(s, layout, false);
const loud = (s: RbState) => new Recorder(s, layout, true);

/**
 * Throws if the tree is not a valid red-black tree: search-tree order, parent
 * pointers, a black root, no red node with a red child, the same number of
 * black nodes on every root-to-null path, the size right, and the height
 * within 2 log2(n + 1).
 */
function check(s: RbState): void {
  let count = 0;
  const walk = (n: RbNode | null, parent: RbNode | null, lo: number, hi: number): number => {
    if (!n) return 0;
    count++;
    if (n.parent !== parent) throw new Error(`parent pointer of ${n.key} is wrong`);
    if (!(n.key > lo && n.key < hi)) throw new Error(`key ${n.key} is outside (${lo}, ${hi})`);
    if (n.red && ((n.left && n.left.red) || (n.right && n.right.red))) throw new Error(`red ${n.key} has a red child`);
    const bl = walk(n.left, n, lo, n.key);
    const br = walk(n.right, n, n.key, hi);
    if (bl !== br) throw new Error(`black counts differ under ${n.key}: ${bl} and ${br}`);
    return bl + (n.red ? 0 : 1);
  };
  if (s.root && s.root.red) throw new Error('the root is red');
  const bh = walk(s.root, null, -Infinity, Infinity);
  expect(count).toBe(s.size);
  expect(blackHeight(s)).toBe(bh);
  expect(rulesHold(s)).toBe(true);
  if (count) expect(height(s)).toBeLessThanOrEqual(2 * Math.log2(count + 1) + 1e-9);
  expect(s.dbl).toBe(null);
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const edgeIds = new Set(f.scene.edges.map((e) => e.id));
    expect(edgeIds.size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(4);
    expect(f.message.split(/[.?!]\s+(?=[A-Z0-9])/).length, f.message).toBeLessThanOrEqual(2);
    expect(f.message).not.toMatch(/undefined|NaN|\bnull\b(?! lea)/);
    // Every tree node is drawn red or black, and says so in words.
    for (const n of f.scene.nodes) {
      expect(n.ink, n.id).toMatch(/^(red|black)$/);
      expect(n.cells[0].sub).toMatch(/^(red|black|double black)$/);
      if (n.cells[0].sub !== 'double black') expect(n.cells[0].sub).toBe(n.ink);
    }
  }
}

function build(order: number[]): RbState {
  const s = create();
  for (const k of order) insert(s, k, quiet(s));
  return s;
}

/** Shape with colours, e.g. [75, 'B', left, right], for exact assertions on small trees. */
function shape(n: RbNode | null): unknown {
  if (!n) return null;
  const c = `${n.key}${n.red ? 'R' : 'B'}`;
  return n.left || n.right ? [c, shape(n.left), shape(n.right)] : c;
}

describe('Red-black tree', () => {
  for (const seed of [1, 2, 3]) {
    it(`keeps every rule and matches a sorted set through random operations (seed ${seed})`, () => {
      const rnd = makeRng(seed * 7919);
      const s = create();
      const model = new Set<number>();
      const range = [40, 300, 1000][seed - 1];
      for (let i = 0; i < 4000; i++) {
        const k = Math.floor(rnd() * range);
        const r = rnd();
        if (r < 0.5) {
          expect(insert(s, k, quiet(s))).toBe(!model.has(k));
          model.add(k);
        } else if (r < 0.85) {
          expect(remove(s, k, quiet(s))).toBe(model.has(k));
          model.delete(k);
        } else {
          expect(search(s, k, quiet(s))).toBe(model.has(k));
        }
        check(s);
        if (i % 50 === 0) expect(keys(s)).toEqual([...model].sort((a, b) => a - b));
      }
      expect(keys(s)).toEqual([...model].sort((a, b) => a - b));
      for (let k = 0; k < range; k++) expect(search(s, k, quiet(s))).toBe(model.has(k));
      for (const k of [...model]) {
        expect(remove(s, k, quiet(s))).toBe(true);
        check(s);
      }
      expect(s.size).toBe(0);
      expect(s.root).toBe(null);
    });
  }

  it('takes 5,000 sorted inserts with recording off and stays shallow', () => {
    const up = create();
    const rec = new Recorder(up, () => {
      throw new Error('layout must not be called with recording off');
    }, false);
    const t0 = performance.now();
    for (let k = 1; k <= 5000; k++) insert(up, k, rec);
    check(up);
    expect(up.size).toBe(5000);
    // A plain search tree would be 5,000 levels deep. The bound here is 2 log2(5001), about 24.6.
    expect(height(up)).toBeLessThanOrEqual(levelLimit(5000));
    expect(height(up)).toBeLessThan(25);
    expect(rec.frames.length).toBe(0);
    expect(rec.counters.rotations).toBeLessThan(5000);
    const look = quiet(up);
    for (let k = 1; k <= 5000; k++) expect(search(up, k, look)).toBe(true);
    expect(look.counters.comparisons / 5000).toBeLessThanOrEqual(height(up));
    for (let k = 1; k <= 5000; k++) remove(up, k, rec);
    check(up);
    expect(up.size).toBe(0);
    expect(performance.now() - t0).toBeLessThan(2000);

    const down = create();
    for (let k = 5000; k >= 1; k--) insert(down, k, quiet(down));
    check(down);
    expect(height(down)).toBeLessThan(25);
  });

  it('recolours when the uncle is red, and rotates when it is black', () => {
    // 10 under 20 with red uncle 30: recolour only, and the red reaches the root, which turns black again.
    const s = build([20, 10, 30]);
    const rec = quiet(s);
    insert(s, 5, rec);
    check(s);
    expect(shape(s.root)).toEqual(['20B', ['10B', '5R', null], '30B']);
    expect(rec.counters.rotations ?? 0).toBe(0);
    expect(rec.counters.recolours).toBe(4); // 10, 30 black; 20 red; then the root black again

    const run = (order: number[]) => {
      const t = create();
      const r = quiet(t);
      for (const k of order) insert(t, k, r);
      check(t);
      return { tree: shape(t.root), rotations: r.counters.rotations ?? 0 };
    };
    expect(run([30, 20, 10])).toEqual({ tree: ['20B', '10R', '30R'], rotations: 1 }); // outer: one rotation
    expect(run([10, 20, 30])).toEqual({ tree: ['20B', '10R', '30R'], rotations: 1 });
    expect(run([30, 10, 20])).toEqual({ tree: ['20B', '10R', '30R'], rotations: 2 }); // inner: two
    expect(run([10, 30, 20])).toEqual({ tree: ['20B', '10R', '30R'], rotations: 2 });
  });

  it('never needs more than two rotations per insert or three per delete', () => {
    const rnd = makeRng(31337);
    const s = create();
    let most = { insert: 0, delete: 0 };
    for (let i = 0; i < 5000; i++) {
      const k = Math.floor(rnd() * 500);
      const rec = quiet(s);
      if (rnd() < 0.55) {
        insert(s, k, rec);
        most.insert = Math.max(most.insert, rec.counters.rotations ?? 0);
      } else {
        remove(s, k, rec);
        most.delete = Math.max(most.delete, rec.counters.rotations ?? 0);
      }
    }
    check(s);
    expect(most.insert).toBe(2);
    expect(most.delete).toBe(3);
    most = { insert: 0, delete: 0 };
  });

  it('reaches every delete case on both sides', () => {
    const rnd = makeRng(2026);
    const seen = new Set<string>();
    for (let round = 0; round < 300 && seen.size < 12; round++) {
      const s = create();
      for (let i = 0; i < 18; i++) insert(s, Math.floor(rnd() * 100), quiet(s));
      const all = keys(s);
      const rec = loud(s);
      remove(s, all[Math.floor(rnd() * all.length)], rec);
      check(s);
      checkFrames(rec.frames);
      for (const f of rec.frames) for (const a of f.lines ?? []) if (/_c[1-4]_rot$|_c2_red$/.test(a) || a === 'db_end' || a === 'red_gone' || a === 'child_black') seen.add(a);
    }
    for (const side of ['left', 'right']) for (const c of ['c1_rot', 'c2_red', 'c3_rot', 'c4_rot']) expect(seen.has(`${side}_${c}`), `${side}_${c}`).toBe(true);
    for (const a of ['db_end', 'red_gone', 'child_black']) expect(seen.has(a), a).toBe(true);
  });

  it('counts the same with recording on and off, and every frame is drawable', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    let frames = 0;
    for (let i = 0; i < 400; i++) {
      const k = Math.floor(rnd() * 60);
      const r = rnd();
      const op = r < 0.45 && a.size < CAP ? insert : r < 0.8 ? remove : search;
      const on = loud(a);
      const off = quiet(b);
      expect(op(a, k, on)).toBe(op(b, k, off));
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      checkFrames(on.frames);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      frames += on.frames.length;
      check(a);
      expect(shape(a.root)).toEqual(shape(b.root));
    }
    expect(frames).toBeGreaterThan(1500);
  });

  it('follows the key with the probe on every comparison', () => {
    const s = build([95, 75, 40, 90, 25, 80, 15, 55]);
    const rec = loud(s);
    search(s, 55, rec);
    const compares = rec.frames.filter((f) => f.compare);
    expect(compares.map((f) => `${f.compare!.left} ${f.compare!.op} ${f.compare!.right}`)).toEqual(['55 < 75', '55 > 25', '55 > 40', '55 = 55']);
    for (const f of compares) expect(f.probe?.text).toBe('55');
    expect(rec.counters.comparisons).toBe(4);
    expect(rec.counters.recolours ?? 0).toBe(0);
  });

  it('gives every recolour a frame of its own', () => {
    const s = build([95, 75, 40, 90, 25, 80, 15, 55]);
    const rec = loud(s);
    insert(s, 45, rec);
    const inks = (f: Frame) => Object.fromEntries(f.scene.nodes.map((n) => [n.id, n.ink]));
    let changes = 0;
    for (let i = 1; i < rec.frames.length; i++) {
      const before = inks(rec.frames[i - 1]);
      const after = inks(rec.frames[i]);
      const flipped = Object.keys(after).filter((id) => before[id] && before[id] !== after[id]);
      if (flipped.length) {
        changes += flipped.length;
        // Only recolour frames change colours, never a rotation frame.
        expect(rec.frames[i].message).toMatch(/^Turn |takes .* old colour|turning it black/);
        expect(rec.frames[i].counters.rotations).toBe(rec.frames[i - 1].counters.rotations);
      }
    }
    expect(changes).toBe(rec.counters.recolours);
  });

  it('draws a double black on a null leaf as a nil node', () => {
    const s = build([95, 75, 40, 90, 25, 80, 15, 55, 85, 45, 50]);
    const rec = loud(s);
    remove(s, 40, rec);
    check(s);
    const withNil = rec.frames.filter((f) => f.scene.nodes.some((n) => n.id === 'nil'));
    expect(withNil.length).toBeGreaterThan(2);
    const nil = withNil[0].scene.nodes.find((n) => n.id === 'nil')!;
    expect(nil.cells[0]).toMatchObject({ text: 'nil', sub: 'double black' });
    expect(rec.frames[rec.frames.length - 1].scene.nodes.some((n) => n.id === 'nil')).toBe(false);
  });

  it(`refuses, politely, to draw more than ${CAP} keys, but has no limit with recording off`, () => {
    const s = build(Array.from({ length: CAP }, (_, i) => i * 10));
    const rec = loud(s);
    expect(insert(s, 5, rec)).toBe(false);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toMatch(/^Sorry/);
    expect(insert(s, 5, quiet(s))).toBe(true);
    check(s);
    expect(def.fill!(build(Array.from({ length: CAP }, (_, i) => i)))[0]).toBe('search');
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
    checkFrames(ins.frames);
    expect(shape(s.root)).toBe('7B');
    const del = loud(s);
    expect(remove(s, 7, del)).toBe(true);
    checkFrames(del.frames);
    expect(del.frames[del.frames.length - 1].message).toMatch(/now empty/);
    expect(s.root).toBe(null);
  });

  it('lays the tree out without overlaps at the display limit', () => {
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
        for (const b of scene.nodes) if (a !== b && a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(w + 8);
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
    expect(shape(s.root)).toEqual(['75B', ['25R', '15B', ['40B', null, '55R']], ['90B', '80R', '95R']]);

    const lines: string[][] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      checkFrames(rec.frames);
      check(s);
      lines.push([...new Set(rec.frames.flatMap((f) => f.lines ?? []))]);
      if (id !== 'search') expect(rec.frames[rec.frames.length - 1].message).toMatch(/after \d+ comparisons?, (no rotations|\d+ rotations?) and (no recolours|\d+ recolours?)\./);
    }
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const [ins85, ins45, ins50, , del40] = lines;
    // A red uncle: recolour only.
    expect(ins85).toContain('left_recolour');
    expect(ins85.some((a) => a.endsWith('_rot'))).toBe(false);
    // A zig-zag: inner rotation, then outer.
    expect(ins45).toEqual(expect.arrayContaining(['right_inner_rot', 'right_outer_rot']));
    // The recolour climbs twice and reaches the root.
    expect(ins50).toEqual(expect.arrayContaining(['right_recolour', 'left_recolour', 'left_climb', 'root_black']));
    // A delete with a double black fixed by cases 3 and 4.
    expect(del40).toEqual(expect.arrayContaining(['double_black', 'left_c3_rot', 'left_c4_rot']));
    expect(shape(s.root)).toEqual(['75B', ['25B', '15B', ['50R', '45B', '55B']], ['90B', ['80B', null, '85R'], '95B']]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['10', '4 (limit 6)', '3', '2', 'all hold']);
    expect(redCount(s)).toBe(2);
    expect(def.bench).toEqual({ insert: 'insert', search: 'search' });
  });
});
