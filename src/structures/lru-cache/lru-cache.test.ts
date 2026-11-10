import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { create, get, keysByRecency, layout, put, type LNode, type LruState } from './index';

const quiet = (s: LruState) => new Recorder(s, layout, false);
const loud = (s: LruState) => new Recorder(s, layout, true);

/** The obvious model: an array of keys, most recent first. */
class Model {
  keys: number[] = [];
  constructor(readonly capacity: number) {}
  get(k: number): boolean {
    const i = this.keys.indexOf(k);
    if (i < 0) return false;
    this.keys.splice(i, 1);
    this.keys.unshift(k);
    return true;
  }
  put(k: number): number | null {
    if (this.get(k)) return null;
    let evicted: number | null = null;
    if (this.keys.length >= this.capacity) evicted = this.keys.pop()!;
    this.keys.unshift(k);
    return evicted;
  }
}

/** Throws if the map and the list disagree in any way. */
function check(s: LruState): void {
  expect(s.loose).toBe(null);
  expect(s.map.size).toBeLessThanOrEqual(s.capacity);
  const forward: LNode[] = [];
  for (let n = s.head; n; n = n.next) {
    forward.push(n);
    expect(forward.length).toBeLessThanOrEqual(s.capacity);
  }
  expect(forward.length).toBe(s.map.size);
  if (!forward.length) {
    expect(s.head).toBe(null);
    expect(s.tail).toBe(null);
  } else {
    expect(s.head!.prev).toBe(null);
    expect(s.tail!.next).toBe(null);
    expect(s.tail).toBe(forward[forward.length - 1]);
  }
  // Every prev pointer mirrors the next pointer before it.
  forward.forEach((n, i) => expect(n.prev).toBe(i ? forward[i - 1] : null));
  // The map points at exactly the nodes in the list.
  for (const n of forward) expect(s.map.get(n.key)).toBe(n);
  // Drawn map slots: one per key, the rest on the free stack.
  const slots = [...forward.map((n) => n.slot), ...s.free].sort((a, b) => a - b);
  expect(slots).toEqual(Array.from({ length: s.capacity }, (_, i) => i));
}

function boxes(scene: Scene): { id: string; x1: number; y1: number; x2: number; y2: number }[] {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, edges and probe that point at real nodes, nothing overlapping, sensible size. */
function checkFrame(f: Frame): void {
  const ids = new Set(f.scene.nodes.map((n) => n.id));
  expect(ids.size).toBe(f.scene.nodes.length);
  const edgeIds = new Set(f.scene.edges.map((e) => e.id));
  expect(edgeIds.size).toBe(f.scene.edges.length);
  for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  if (f.probe) {
    expect(ids.has(f.probe.at)).toBe(true);
    if (f.probe.cell != null) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at)!;
      expect(f.probe.cell).toBeLessThan(at.cells.length);
    }
  }
  expect(f.message.length).toBeGreaterThan(10);
  expect(f.message).not.toMatch(/undefined|null|NaN|—/);
  const bs = boxes(f.scene);
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      const apart = a.x2 + 8 <= b.x1 || b.x2 + 8 <= a.x1 || a.y2 + 8 <= b.y1 || b.y2 + 8 <= a.y1;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
  const minX = Math.min(...bs.map((b) => b.x1));
  const maxX = Math.max(...bs.map((b) => b.x2));
  const minY = Math.min(...bs.map((b) => b.y1));
  const maxY = Math.max(...bs.map((b) => b.y2));
  expect(maxX - minX).toBeLessThanOrEqual(1000);
  expect(maxY - minY).toBeLessThanOrEqual(380);
}

describe('LRU cache', () => {
  for (const capacity of [1, 2, 3, 4, 5, 40]) {
    it(`matches a simple model through random gets and puts (capacity ${capacity})`, () => {
      const rnd = makeRng(capacity * 104729);
      const s = create(capacity);
      const model = new Model(capacity);
      let hits = 0;
      let misses = 0;
      let evictions = 0;
      for (let i = 0; i < 4000; i++) {
        const k = Math.floor(rnd() * capacity * 3);
        if (rnd() < 0.5) {
          const want = model.get(k);
          expect(get(s, k, quiet(s))).toBe(want);
          if (want) hits++;
          else misses++;
        } else {
          const want = model.put(k);
          expect(put(s, k, quiet(s))).toBe(want);
          if (want != null) evictions++;
        }
        expect(keysByRecency(s)).toEqual(model.keys);
        if (i % 40 === 0) check(s);
      }
      check(s);
      expect(s.hits).toBe(hits);
      expect(s.misses).toBe(misses);
      expect(s.evictions).toBe(evictions);
    });
  }

  it('counts the same with recording on and off, and never lays out when off', () => {
    const rnd = makeRng(2024);
    for (const capacity of [3, 4, 5]) {
      const a = create(capacity);
      const b = create(capacity);
      const noLayout = () => {
        throw new Error('layout called with recording off');
      };
      for (let i = 0; i < 600; i++) {
        const k = Math.floor(rnd() * 12);
        const op = rnd() < 0.5 ? get : put;
        const on = loud(a);
        const off = new Recorder(b, noLayout, false);
        op(a, k, on);
        op(b, k, off);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(1);
        expect(off.counters).toEqual(on.counters);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        expect(keysByRecency(b)).toEqual(keysByRecency(a));
        expect(a.loose).toBe(null);
      }
      check(a);
      check(b);
    }
  });

  it('every frame is well formed through a few hundred random operations', () => {
    const rnd = makeRng(7);
    for (const capacity of [3, 4, 5]) {
      const s = create(capacity);
      for (let i = 0; i < 300; i++) {
        const k = Math.floor(rnd() * 9) * 111;
        const rec = loud(s);
        (rnd() < 0.5 ? get : put)(s, k, rec);
        for (const f of rec.frames) checkFrame(f);
        checkFrame({ scene: layout(s), message: 'at rest, nothing moving', counters: {} });
      }
    }
  });

  it('costs a fixed number of pointer writes', () => {
    const s = create(4);
    const run = (op: typeof get | typeof put, k: number) => {
      const rec = quiet(s);
      op(s, k, rec);
      return rec.counters;
    };
    expect(run(put, 1).writes).toBe(5); // map entry, two node pointers, tail and head
    expect(run(put, 2).writes).toBe(5);
    expect(run(put, 3).writes).toBe(5);
    expect(run(put, 4).writes).toBe(5);
    expect(run(get, 4)).toEqual({ comparisons: 1, hits: 1 }); // already the head: nothing to rewire
    expect(run(get, 1)).toEqual({ comparisons: 1, hits: 1, writes: 6 }); // from the tail
    expect(run(get, 3)).toEqual({ comparisons: 1, hits: 1, writes: 6 }); // from the middle
    expect(run(put, 4)).toEqual({ comparisons: 1, writes: 6 }); // refresh
    expect(run(put, 9)).toEqual({ comparisons: 1, evictions: 1, writes: 8 }); // unlink 2, map delete 1, insert 5
    expect(run(get, 77)).toEqual({ misses: 1 });
  });

  it('a hit goes to the map entry first, then follows the pointer to the list node', () => {
    const s = create(4);
    for (const k of [10, 20, 30]) put(s, k, quiet(s));
    const rec = loud(s);
    get(s, 10, rec);
    const stops = rec.frames.map((f) => f.probe?.at);
    expect(stops[0]).toBe('map');
    expect(stops[1]).toBe('map');
    expect(rec.frames[1].probe!.cell).toBe(0);
    expect(rec.frames[1].compare).toMatchObject({ left: 10, op: '=', right: 10 });
    expect(stops.slice(2).every((at) => at === 'n10')).toBe(true);
    // The node keeps its id the whole way, so it slides instead of being redrawn.
    for (const f of rec.frames) expect(f.scene.nodes.filter((n) => n.id === 'n10').length).toBe(1);
    // It ends at the head position, with the others shifted along.
    const last = rec.frames[rec.frames.length - 1].scene;
    const x = (id: string) => last.nodes.find((n) => n.id === id)!.x;
    expect(x('n10')).toBeLessThan(x('n30'));
    expect(x('n30')).toBeLessThan(x('n20'));
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/^Hit\./);
  });

  it('a put into a full cache checks capacity, marks the tail bad and evicts it before inserting', () => {
    const s = create(3);
    for (const k of [10, 20, 30]) put(s, k, quiet(s));
    const rec = loud(s);
    expect(put(s, 40, rec)).toBe(10);
    const cmp = rec.frames.find((f) => f.compare)!;
    expect(cmp.compare).toMatchObject({ left: 'size 3', op: '=', right: 'capacity 3', verdict: 'full, evict the least recent' });
    const marked = rec.frames.find((f) => f.scene.nodes.some((n) => n.id === 'n10' && n.tone === 'bad'))!;
    expect(marked).toBeTruthy();
    const firstWith40 = rec.frames.findIndex((f) => f.scene.nodes.some((n) => n.id === 'n40'));
    const lastWith10 = rec.frames.map((f) => f.scene.nodes.some((n) => n.id === 'n10')).lastIndexOf(true);
    expect(lastWith10).toBeLessThan(firstWith40);
    expect(keysByRecency(s)).toEqual([40, 30, 20]);
    expect(get(s, 10, quiet(s))).toBe(false);
  });

  it('seed and tour run cleanly through the definition and show what they promise', () => {
    const s = def.create({ capacity: 4 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(keysByRecency(s)).toEqual([27, 12, 41]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['3 of 4', 'no gets yet', '41']);
    checkFrame({ scene: def.layout(s), message: 'at rest, nothing moving', counters: {} });

    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const seen: Record<string, number>[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(2);
      for (const f of rec.frames) checkFrame(f);
      check(s);
      seen.push(rec.counters);
    }
    // 1: a hit on the tail jumps to the front. 2: fills. 3: evicts. 4: misses on the evicted key. 5: refreshes.
    expect(seen[0]).toMatchObject({ hits: 1, writes: 6 });
    expect(seen[1].evictions ?? 0).toBe(0);
    expect(seen[2]).toMatchObject({ evictions: 1 });
    expect(seen[3]).toMatchObject({ misses: 1 });
    expect(seen[4].evictions ?? 0).toBe(0);
    expect(seen[4].writes).toBe(6);
    expect(keysByRecency(s)).toEqual([41, 85, 63, 27]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['4 of 4', '50% (1 of 2 gets)', '27']);
  });

  it('suggestions make a visible run: get picks a cached key behind the head, put picks a new key', () => {
    const s = def.create({ capacity: 4 });
    for (const k of [41, 12, 27]) put(s, k, quiet(s));
    const [getOp, putOp] = def.ops;
    for (let i = 0; i < 50; i++) {
      const [g] = getOp.suggest!(s);
      expect(s.map.has(Number(g))).toBe(true);
      expect(g).not.toBe(s.head!.key);
      const [p] = putOp.suggest!(s);
      expect(s.map.has(Number(p))).toBe(false);
    }
    const empty = def.create({ capacity: 3 });
    expect(getOp.suggest!(empty).length).toBe(1);
  });
});
