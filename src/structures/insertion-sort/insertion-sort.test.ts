import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { LIMIT, create, insertNext, inversions, label, layout, load, nearlySorted, sort, values, setArray, type Item, type SortState } from './index';

const quiet = (s: SortState) => new Recorder(s, layout, false);
const loud = (s: SortState) => new Recorder(s, layout, true);

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
    expect(f.lines?.length).toBeGreaterThan(0);
  }
}

function loaded(xs: number[]): SortState {
  const s = create();
  load(s, xs, quiet(s), 'test');
  return s;
}

/** The sort's own count: one comparison per shift, plus one for each item that stops before the front. */
function expectedComparisons(xs: number[]): number {
  let c = 0;
  for (let i = 1; i < xs.length; i++) {
    let reachesFront = true;
    for (let j = 0; j < i; j++) if (xs[j] <= xs[i]) reachesFront = false;
    const shifts = xs.slice(0, i).filter((v) => v > xs[i]).length;
    c += shifts + (reachesFront ? 0 : 1);
  }
  return c;
}

describe('insertion sort', () => {
  it('sorts thousands of inputs stably, with shifts equal to inversions', () => {
    const rnd = makeRng(11);
    const shapes = ['random', 'sorted', 'reversed', 'equal', 'few'] as const;
    for (let t = 0; t < 4000; t++) {
      const n = t < 10 ? t % 3 : Math.floor(rnd() * (LIMIT + 1));
      const shape = shapes[t % shapes.length];
      let xs = Array.from({ length: n }, () => Math.floor(rnd() * (shape === 'few' ? 4 : 1000)));
      if (shape === 'sorted') xs.sort((a, b) => a - b);
      if (shape === 'reversed') xs.sort((a, b) => b - a);
      if (shape === 'equal') xs = xs.map(() => 7);
      const s = loaded(xs);
      const order = (s.items as Item[]).map((it) => it.uid);
      const rec = quiet(s);
      sort(s, rec);
      expect(values(s)).toEqual([...xs].sort((a, b) => a - b));
      expect(s.sorted).toBe(n);
      expect(rec.counters.writes ?? 0).toBe(inversions(xs));
      expect(rec.counters.comparisons ?? 0).toBe(expectedComparisons(xs));
      // Stable: equal values keep the order their items arrived in.
      const items = s.items as Item[];
      for (let i = 1; i < items.length; i++) {
        if (items[i].value === items[i - 1].value) expect(order.indexOf(items[i - 1].uid)).toBeLessThan(order.indexOf(items[i].uid));
      }
    }
  });

  it('costs n - 1 comparisons when sorted and n(n - 1)/2 when reversed', () => {
    const up = loaded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const r1 = quiet(up);
    sort(up, r1);
    expect(r1.counters.comparisons).toBe(9);
    expect(r1.counters.writes ?? 0).toBe(0);
    const down = loaded([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const r2 = quiet(down);
    sort(down, r2);
    expect(r2.counters.comparisons).toBe(45);
    expect(r2.counters.writes).toBe(45);
  });

  it('makes nearly sorted inputs with one to three pairs out of order', () => {
    const s = create();
    for (let i = 0; i < 500; i++) {
      const xs = nearlySorted(s);
      expect(xs.length).toBe(10);
      const inv = inversions(xs);
      expect(inv).toBeGreaterThanOrEqual(2);
      expect(inv).toBeLessThanOrEqual(3);
    }
  });

  it('inserts one item at a time, keeping the left part sorted', () => {
    const rnd = makeRng(5);
    for (let t = 0; t < 300; t++) {
      const xs = Array.from({ length: 1 + Math.floor(rnd() * LIMIT) }, () => Math.floor(rnd() * 50));
      const s = loaded(xs);
      while (insertNext(s, quiet(s))) {
        const left = values(s).slice(0, s.sorted);
        expect(left).toEqual([...left].sort((a, b) => a - b));
      }
      expect(values(s)).toEqual([...xs].sort((a, b) => a - b));
    }
  });

  it('sets the array from typed numbers, with letters for repeats, and keeps at most the limit', () => {
    const s = create();
    setArray(s, '5 2 5 1', quiet(s));
    expect((s.items as Item[]).map(label)).toEqual(['5a', '2', '5b', '1']);
    expect(s.sorted).toBe(1);
    sort(s, quiet(s));
    expect((s.items as Item[]).map(label)).toEqual(['1', '2', '5a', '5b']);
    setArray(s, '5, 2,9  1', quiet(s));
    expect(values(s)).toEqual([5, 2, 9, 1]);
    const rec = loud(s);
    setArray(s, Array.from({ length: LIMIT + 3 }, (_, i) => i).join(' '), rec);
    expect(s.items.length).toBe(LIMIT);
    expect(rec.frames[0].message).toMatch(/at most/);
    setArray(s, '', quiet(s));
    expect(s.items.length).toBe(0);
    expect(sort(s, quiet(s))).toBeUndefined();
  });

  it('counts the same with recording on and off, with well-formed frames', () => {
    const rnd = makeRng(77);
    for (let t = 0; t < 200; t++) {
      const xs = Array.from({ length: Math.floor(rnd() * (LIMIT + 1)) }, () => Math.floor(rnd() * 20));
      const a = loaded(xs);
      const b = loaded(xs);
      const on = loud(a);
      const off = quiet(b);
      if (t % 2) {
        insertNext(a, on);
        insertNext(b, off);
      } else {
        sort(a, on);
        sort(b, off);
      }
      expect(on.counters).toEqual(off.counters);
      expect(values(a)).toEqual(values(b));
      checkFrames(on.frames);
    }
  });

  it('runs the seed and the tour through the definition', () => {
    const s = def.create({});
    const find = (id: string) => def.ops.find((o) => o.id === id)!;
    for (const [op, ...args] of def.seed) find(op).run(s, args, quiet(s));
    expect(s.sorted).toBe(4);
    for (const [op, ...args] of def.tour) {
      const rec = loud(s);
      find(op).run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
    }
    expect(values(s)).toEqual([...values(s)].sort((a, b) => a - b));
    for (const op of def.ops) {
      const rec = loud(s);
      op.run(s, op.suggest?.(s) ?? [], rec);
      checkFrames(rec.frames);
    }
  });
});
