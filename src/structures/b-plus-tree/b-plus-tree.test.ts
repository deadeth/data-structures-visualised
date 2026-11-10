import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import def, { allKeys, create, height, insert, layout, range, remove, search, type BNode, type BPlusState } from './index';

const quiet = (s: BPlusState) => new Recorder(s, layout, false);

/** Throws if any B+ tree invariant is broken. */
function check(s: BPlusState): void {
  const max = s.order - 1;
  const minLeaf = Math.ceil((s.order - 1) / 2);
  const minKids = Math.ceil(s.order / 2);
  let leafDepth = -1;
  const leaves: BNode[] = [];
  const walk = (n: BNode, depth: number, lo: number, hi: number) => {
    expect(n.keys.length).toBeLessThanOrEqual(max);
    for (let i = 1; i < n.keys.length; i++) expect(n.keys[i - 1]).toBeLessThan(n.keys[i]);
    for (const k of n.keys) {
      expect(k).toBeGreaterThanOrEqual(lo);
      expect(k).toBeLessThan(hi);
    }
    if (n.leaf) {
      if (leafDepth === -1) leafDepth = depth;
      expect(depth).toBe(leafDepth);
      if (n !== s.root) expect(n.keys.length).toBeGreaterThanOrEqual(minLeaf);
      expect(n.kids.length).toBe(0);
      leaves.push(n);
      return;
    }
    expect(n.kids.length).toBe(n.keys.length + 1);
    if (n !== s.root) expect(n.kids.length).toBeGreaterThanOrEqual(minKids);
    else expect(n.kids.length).toBeGreaterThanOrEqual(2);
    n.kids.forEach((c, i) => walk(c, depth + 1, i === 0 ? lo : n.keys[i - 1], i === n.keys.length ? hi : n.keys[i]));
  };
  walk(s.root, 0, -Infinity, Infinity);
  // The leaf chain visits every leaf, left to right.
  for (let i = 0; i < leaves.length; i++) expect(leaves[i].next).toBe(leaves[i + 1] ?? null);
  expect(allKeys(s).length).toBe(s.size);
}

describe('B+ tree', () => {
  for (const order of [3, 4, 5, 6]) {
    it(`stays valid through random inserts and deletes (order ${order})`, () => {
      const rnd = makeRng(order * 7919);
      const s = create(order);
      const model = new Set<number>();
      for (let i = 0; i < 3000; i++) {
        const k = Math.floor(rnd() * 400);
        if (rnd() < 0.6) {
          expect(insert(s, k, quiet(s))).toBe(!model.has(k));
          model.add(k);
        } else {
          expect(remove(s, k, quiet(s))).toBe(model.has(k));
          model.delete(k);
        }
        if (i % 50 === 0) check(s);
      }
      check(s);
      expect(allKeys(s)).toEqual([...model].sort((a, b) => a - b));
      for (let k = 0; k < 400; k++) expect(search(s, k, quiet(s))).toBe(model.has(k));
      // Empty it completely.
      for (const k of [...model]) remove(s, k, quiet(s));
      check(s);
      expect(s.size).toBe(0);
      expect(height(s)).toBe(1);
    });
  }

  it('range scan returns exactly the keys in the range', () => {
    const s = create(4);
    const keys = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
    for (const k of keys) insert(s, k, quiet(s));
    expect(range(s, 18, 42, quiet(s))).toEqual([20, 25, 30, 35, 40]);
    expect(range(s, 42, 18, quiet(s))).toEqual([20, 25, 30, 35, 40]);
    expect(range(s, 0, 4, quiet(s))).toEqual([]);
    expect(range(s, 60, 999, quiet(s))).toEqual([60]);
    expect(range(s, 0, 999, quiet(s))).toEqual(keys);
  });

  it('a lookup reads one node per level', () => {
    const s = create(4);
    for (let k = 1; k <= 200; k++) insert(s, k, quiet(s));
    const rec = quiet(s);
    search(s, 137, rec);
    expect(rec.counters.reads).toBe(height(s));
  });

  it('records frames with a probe and running counters, and none when recording is off', () => {
    const s = create(4);
    for (const k of [10, 20, 30, 40, 50, 60, 70]) insert(s, k, quiet(s));
    const rec = new Recorder(s, layout, true);
    search(s, 50, rec);
    expect(rec.frames.length).toBeGreaterThan(3);
    expect(rec.frames.some((f) => f.compare && f.probe)).toBe(true);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.counters.comparisons).toBe(rec.counters.comparisons);
    for (const f of rec.frames) {
      const ids = new Set(f.scene.nodes.map((n) => n.id));
      expect(ids.size).toBe(f.scene.nodes.length);
      for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    }
    const off = quiet(s);
    search(s, 50, off);
    expect(off.frames.length).toBe(0);
    expect(off.counters.comparisons).toBe(rec.counters.comparisons);
  });

  it('seed and tour run cleanly through the definition', () => {
    const s = def.create({ order: 4 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      check(s);
    }
  });
});
