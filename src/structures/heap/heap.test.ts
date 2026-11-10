import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { CAPACITY, create, extractMin, insert, keys, layout, levels, peek, type HeapState } from './index';

const quiet = (s: HeapState) => new Recorder(s, layout, false);
const loud = (s: HeapState) => new Recorder(s, layout, true);

/** Throws if the heap rule is broken or two items share an id. */
function check(s: HeapState): void {
  const k = keys(s);
  for (let i = 1; i < k.length; i++) expect(k[(i - 1) >> 1]).toBeLessThanOrEqual(k[i]);
  expect(new Set(s.items.map((it) => it.uid)).size).toBe(s.items.length);
  expect(s.items.length).toBeLessThanOrEqual(s.capacity);
}

/** Unique node ids, edges that join existing nodes, and a probe that points at one. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    expect(new Set(f.scene.edges.map((e) => e.id)).size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
  }
}

/** Where a sorted copy keeps its smallest key. The model the heap is checked against. */
function modelInsert(model: number[], key: number): void {
  let i = model.length;
  while (i > 0 && model[i - 1] > key) i--;
  model.splice(i, 0, key);
}

describe('binary heap', () => {
  for (const capacity of [CAPACITY, 1000]) {
    it(`matches a sorted array through random inserts and extracts (capacity ${capacity})`, () => {
      const rnd = makeRng(capacity * 31 + 7);
      const s = create(capacity);
      const model: number[] = [];
      for (let i = 0; i < 6000; i++) {
        // Lean towards inserts for a while, then towards extracts, so the heap both fills and drains.
        const bias = Math.floor(i / 500) % 2 === 0 ? 0.65 : 0.35;
        if (rnd() < bias) {
          const key = Math.floor(rnd() * 1000);
          const room = model.length < capacity;
          expect(insert(s, key, quiet(s))).toBe(room);
          if (room) modelInsert(model, key);
        } else {
          expect(extractMin(s, quiet(s))).toBe(model.shift());
        }
        expect(peek(s, quiet(s))).toBe(model[0]);
        expect(s.items.length).toBe(model.length);
        if (i % 25 === 0) check(s);
      }
      check(s);
      // Draining the heap returns every key in order.
      const out: number[] = [];
      while (s.items.length) out.push(extractMin(s, quiet(s))!);
      expect(out).toEqual(model);
      expect(extractMin(s, quiet(s))).toBeUndefined();
      expect(peek(s, quiet(s))).toBeUndefined();
    });
  }

  it('keeps equal keys as separate items', () => {
    const s = create();
    for (const k of [7, 7, 3, 7, 3]) expect(insert(s, k, quiet(s))).toBe(true);
    check(s);
    expect(s.items.length).toBe(5);
    expect([1, 2, 3, 4, 5].map(() => extractMin(s, quiet(s)))).toEqual([3, 3, 7, 7, 7]);
  });

  it('refuses an insert when full, politely and without changing anything', () => {
    const s = create();
    for (let k = 0; k < CAPACITY; k++) insert(s, 100 - k, quiet(s));
    const before = keys(s);
    const rec = loud(s);
    expect(insert(s, 1, rec)).toBe(false);
    expect(keys(s)).toEqual(before);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toMatch(/full/);
    expect(rec.counters.comparisons ?? 0).toBe(0);
    checkFrames(rec.frames);
  });

  it('costs at most one comparison per level to insert and two to extract', () => {
    const rnd = makeRng(99);
    const s = create(5000);
    for (let i = 0; i < 5000; i++) {
      const rec = quiet(s);
      insert(s, Math.floor(rnd() * 1000), rec);
      expect(rec.counters.comparisons ?? 0).toBeLessThanOrEqual(levels(s) - 1);
      expect(rec.counters.writes ?? 0).toBeLessThanOrEqual(rec.counters.comparisons ?? 0);
    }
    expect(levels(s)).toBe(13);
    while (s.items.length) {
      const depth = levels(s) - 1;
      const rec = quiet(s);
      extractMin(s, rec);
      expect(rec.counters.comparisons ?? 0).toBeLessThanOrEqual(2 * depth);
      expect(rec.counters.writes ?? 0).toBeLessThanOrEqual(depth);
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    for (let i = 0; i < 400; i++) {
      const on = loud(a);
      const off = quiet(b);
      const roll = rnd();
      if (roll < 0.5) {
        const key = Math.floor(rnd() * 1000);
        expect(insert(a, key, on)).toBe(insert(b, key, off));
      } else if (roll < 0.9) {
        expect(extractMin(a, on)).toBe(extractMin(b, off));
      } else {
        expect(peek(a, on)).toBe(peek(b, off));
      }
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(keys(a)).toEqual(keys(b));
    }
  });

  it('follows the key with the probe and puts every comparison in its own frame', () => {
    const s = create();
    for (const k of [12, 30, 21, 47, 38, 90, 84]) insert(s, k, quiet(s));
    const up = loud(s);
    insert(s, 5, up);
    expect(keys(s)[0]).toBe(5);
    expect(up.counters).toEqual({ comparisons: 3, writes: 3 });
    expect(up.frames.filter((f) => f.compare).length).toBe(3);
    for (const f of up.frames.slice(0, -1)) expect(f.probe?.text).toBe('5');
    // The arithmetic for finding a parent is spelled out once.
    expect(up.frames.filter((f) => f.message.includes('floor((i - 1) / 2)')).length).toBe(1);

    const down = loud(s);
    expect(extractMin(s, down)).toBe(5);
    expect(keys(s)).toEqual([12, 30, 21, 47, 38, 90, 84]);
    expect(down.counters).toEqual({ comparisons: 4, writes: 2 });
    expect(down.frames.filter((f) => f.compare).length).toBe(4);
    expect(down.frames.filter((f) => f.message.includes('2i + 1 and 2i + 2')).length).toBe(1);
    for (const f of down.frames.slice(0, -1)) expect(f.probe?.text).toBe('47');

    // The same item is coloured in the tree and in the array on every comparison.
    for (const f of [...up.frames, ...down.frames]) {
      if (!f.compare) continue;
      const toned = f.scene.nodes.filter((n) => n.tone === 'compare').map((n) => n.id);
      expect(toned.length).toBeGreaterThan(0);
      for (const id of toned) {
        const twin = (id.startsWith('t') ? 'a' : 't') + id.slice(1);
        expect(toned).toContain(twin);
      }
    }
  });

  it('gives one frame for peek, pointing at the root', () => {
    const s = create();
    for (const k of [40, 10, 25]) insert(s, k, quiet(s));
    const rec = loud(s);
    expect(peek(s, rec)).toBe(10);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].probe).toEqual({ text: '10', at: `t${s.items[0].uid}` });
    expect(rec.counters.comparisons ?? 0).toBe(0);
  });

  it('keeps each array index in the same place while items move', () => {
    const s = create();
    for (const k of [12, 30, 21, 47, 38, 90, 84]) insert(s, k, quiet(s));
    const before = layout(s);
    const root = s.items[0];
    insert(s, 5, quiet(s));
    const after = layout(s);
    const at = (scene: typeof before, id: string) => scene.nodes.find((n) => n.id === id)!;
    // The old root now sits at index 1, exactly where the item at index 1 used to be drawn.
    expect(s.items[1]).toBe(root);
    const slot1 = before.nodes.filter((n) => n.id.startsWith('t'))[1];
    expect(at(after, `t${root.uid}`).x).toBe(slot1.x);
    expect(at(after, `t${root.uid}`).y).toBe(slot1.y);
    expect(at(after, `a${root.uid}`).x).toBeGreaterThan(at(before, `a${root.uid}`).x);
    // A full heap still draws without overlaps in either row.
    for (let k = 0; s.items.length < CAPACITY; k++) insert(s, 100 + k, quiet(s));
    const full = layout(s);
    const trees = full.nodes.filter((n) => n.id.startsWith('t'));
    for (const p of trees) for (const q of trees) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(50);
    const cells = full.nodes.filter((n) => n.id.startsWith('a')).sort((p, q) => p.x - q.x);
    expect(cells.length).toBe(CAPACITY);
    for (let i = 1; i < cells.length; i++) expect(cells[i].x - cells[i - 1].x).toBeGreaterThanOrEqual(44);
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
    expect(keys(s)).toEqual([12, 30, 21, 47, 38, 90, 84]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const counts = def.tour.map(([id, ...args]) => {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
      check(s);
      return [rec.counters.comparisons ?? 0, rec.counters.writes ?? 0];
    });
    // Peek, a climb to the root, a full sift down, an insert that stays put, a sift down that stops early.
    expect(counts).toEqual([[0, 0], [3, 3], [4, 2], [1, 0], [4, 1]]);
    expect(keys(s)).toEqual([21, 30, 70, 47, 38, 90, 84]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['7 of 15', '3', '21']);
    const [op, key] = def.fill!(s);
    expect(op).toBe('insert');
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).toBeLessThanOrEqual(999);
  });
});
