import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { START_BUCKETS, chipWidth, allKeys, create, has, insert, layout, loadFactor, longestChain, remove, search, type HashState } from './index';

const quiet = (s: HashState) => new Recorder(s, layout, false);
const loud = (s: HashState) => new Recorder(s, layout, true);

/** Throws if any hash table invariant is broken. */
function check(s: HashState): void {
  const n = s.buckets.length;
  expect(n).toBeGreaterThanOrEqual(START_BUCKETS);
  expect(Number.isInteger(Math.log2(n))).toBe(true);
  expect(s.mig).toBeNull();
  const seen = new Set<number>();
  s.buckets.forEach((chain, b) => {
    for (const k of chain) {
      expect(k % n).toBe(b);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
  expect(seen.size).toBe(s.size);
  expect(loadFactor(s)).toBeLessThanOrEqual(0.75);
}

/** Ids are unique, edges and the probe point at real nodes, and no two nodes overlap. */
function checkScene(scene: Scene, probe?: Frame['probe']): void {
  const ids = new Set(scene.nodes.map((n) => n.id));
  expect(ids.size).toBe(scene.nodes.length);
  expect(new Set(scene.edges.map((e) => e.id)).size).toBe(scene.edges.length);
  for (const e of scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  if (probe) expect(ids.has(probe.at)).toBe(true);
  const rects = scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, x2: n.x + w / 2, y1: n.y - h / 2, y2: n.y + h / 2 };
  });
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const apart = a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1;
      if (!apart) throw new Error(`${a.id} overlaps ${b.id}`);
    }
  }
  // The chip sits to the left of the node it points at. It must not cover any other node.
  if (probe) {
    expect(probe.place).toBe('left');
    const at = rects.find((r) => r.id === probe.at)!;
    const chip = { x1: at.x1 - 10 - chipWidth(probe.text.length), x2: at.x1 - 4, y1: (at.y1 + at.y2) / 2 - 13, y2: (at.y1 + at.y2) / 2 + 13 };
    for (const r of rects) {
      const apart = r.x2 <= chip.x1 || chip.x2 <= r.x1 || r.y2 <= chip.y1 || chip.y2 <= r.y1;
      if (!apart) throw new Error(`probe at ${probe.at} covers ${r.id}`);
    }
  }
}

describe('hash table', () => {
  it('matches a Set through random inserts, searches and deletes', () => {
    for (const seed of [1, 2, 3]) {
      const rnd = makeRng(seed * 104729);
      const s = create();
      const model = new Set<number>();
      for (let i = 0; i < 4000; i++) {
        const k = Math.floor(rnd() * 600);
        const r = rnd();
        if (r < 0.5) {
          expect(insert(s, k, quiet(s))).toBe(!model.has(k));
          model.add(k);
        } else if (r < 0.8) {
          expect(remove(s, k, quiet(s))).toBe(model.has(k));
          model.delete(k);
        } else {
          expect(search(s, k, quiet(s))).toBe(model.has(k));
        }
        if (i % 40 === 0) check(s);
      }
      check(s);
      expect(allKeys(s).sort((a, b) => a - b)).toEqual([...model].sort((a, b) => a - b));
      for (let k = 0; k < 600; k++) expect(has(s, k)).toBe(model.has(k));
      for (const k of [...model]) expect(remove(s, k, quiet(s))).toBe(true);
      check(s);
      expect(s.size).toBe(0);
    }
  });

  it('doubles when the load factor would pass 0.75 and rehashes every key', () => {
    const s = create();
    for (const k of [8, 16, 24, 3, 5, 6]) insert(s, k, quiet(s));
    expect(s.buckets.length).toBe(8);
    expect(loadFactor(s)).toBe(0.75);
    expect(longestChain(s)).toBe(3);
    const rec = quiet(s);
    insert(s, 32, rec);
    expect(s.buckets.length).toBe(16);
    expect(rec.counters.moved).toBe(7);
    // 8 and 24 move up by eight; 16 and 32 stay in bucket 0, in their old order.
    expect(s.buckets[0]).toEqual([16, 32]);
    expect(s.buckets[8]).toEqual([8, 24]);
    check(s);
    // A duplicate never triggers anything.
    const again = quiet(s);
    expect(insert(s, 32, again)).toBe(false);
    expect(again.counters.moved ?? 0).toBe(0);
    expect(again.counters.writes ?? 0).toBe(0);
  });

  it('a search reads one bucket plus the chain nodes it walks, and compares once per node', () => {
    const s = create();
    for (const k of [2, 10, 18, 26, 7]) insert(s, k, quiet(s));
    const hit = quiet(s);
    expect(search(s, 18, hit)).toBe(true);
    expect(hit.counters).toEqual({ reads: 4, comparisons: 3 });
    const miss = quiet(s);
    expect(search(s, 34, miss)).toBe(false);
    expect(miss.counters).toEqual({ reads: 5, comparisons: 4 });
    const empty = quiet(s);
    expect(search(s, 4, empty)).toBe(false);
    expect(empty.counters).toEqual({ reads: 1 });
  });

  it('counts the same with recording on and off, and every frame is well formed', () => {
    const rnd = makeRng(77);
    const a = create();
    const b = create();
    let frames = 0;
    for (let i = 0; i < 400; i++) {
      // Mostly two-digit keys, then three-digit ones, which switch the drawing to its wider spacing.
      const k = Math.floor(rnd() * (i < 250 ? 100 : 1000));
      const r = rnd();
      const op = r < 0.55 ? insert : r < 0.8 ? remove : search;
      const on = loud(a);
      const off = quiet(b);
      expect(op(a, k, on)).toBe(op(b, k, off));
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(1);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      // The first frame is always the hash calculation, with the probe on the bucket it names.
      const first = on.frames[0];
      expect(first.compare?.left).toBe(`${k} mod ${first.scene.nodes.filter((n) => n.id.startsWith('b')).length}`);
      expect(first.probe?.at).toBe(`b${first.compare?.right}`);
      for (const f of on.frames) checkScene(f.scene, f.probe);
      frames += on.frames.length;
      expect(a.buckets).toEqual(b.buckets);
    }
    expect(frames).toBeGreaterThan(1000);
    check(a);
  });

  it('keeps key ids stable across a resize and shows one frame per key', () => {
    const s = create();
    for (const k of [16, 42, 50, 13, 87, 21]) insert(s, k, quiet(s));
    const before = layout(s).nodes.filter((n) => n.id.startsWith('k')).map((n) => n.id).sort();
    const rec = loud(s);
    insert(s, 74, rec);
    const rehash = rec.frames.filter((f) => f.compare && String(f.compare.left).endsWith('mod 16'));
    expect(rehash.map((f) => f.compare!.left)).toEqual(['16 mod 16', '42 mod 16', '50 mod 16', '74 mod 16', '13 mod 16', '21 mod 16', '87 mod 16']);
    for (const f of rec.frames) {
      const ids = new Set(f.scene.nodes.map((n) => n.id));
      for (const id of before) expect(ids.has(id)).toBe(true);
    }
    // Rehashing is not comparing: only the two chain nodes in bucket 2 were compared.
    expect(rec.counters.comparisons).toBe(2);
    expect(rec.counters.moved).toBe(7);
    // A key stays in its row on screen: its row is key mod 8 before and after.
    const y = (scene: Scene, id: string) => scene.nodes.find((n) => n.id === id)!.y;
    for (const id of before) expect(y(rec.frames[0].scene, id)).toBe(y(rec.frames[rec.frames.length - 1].scene, id));
  });

  it('keeps a resize under about 40 frames however large the table is', () => {
    const s = create();
    let resizes = 0;
    for (let k = 0; k < 400; k++) {
      const key = (k * 37) % 1000;
      const rec = loud(s);
      const buckets = s.buckets.length;
      insert(s, key, rec);
      if (s.buckets.length !== buckets) {
        resizes++;
        expect(rec.frames.length).toBeLessThanOrEqual(42);
        for (const f of rec.frames) checkScene(f.scene, f.probe);
      }
    }
    expect(resizes).toBe(7);
    expect(s.buckets.length).toBe(1024);
    check(s);
    checkScene(layout(s));
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
    expect(s.size).toBe(5);
    expect(longestChain(s)).toBe(2);
    checkScene(def.layout(s));
    const buckets: number[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      for (const f of rec.frames) checkScene(f.scene, f.probe);
      check(s);
      buckets.push(s.buckets.length);
    }
    // The fourth step is the insert that triggers the resize.
    expect(buckets).toEqual([8, 8, 8, 16, 16]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['6', '16', '0.38', '1']);
    for (const op of def.ops) expect(op.suggest!(s).length).toBe(1);
    expect(def.fill!(s)[0]).toBe('insert');
  });
});
