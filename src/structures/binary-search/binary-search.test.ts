import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { create, find, isSorted, layout, loadSorted, loadUnsorted, lowerBound, parseNumbers, setArray, worstCase, type BSState } from './index';

const quiet = (s: BSState) => new Recorder(s, layout, false);
const loud = (s: BSState) => new Recorder(s, layout, true);

function withItems(items: number[]): BSState {
  const s = create();
  s.items = [...items];
  return s;
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
  }
}

/** Arrays of the shapes worth testing: empty, one item, all equal, sorted, reversed, random. */
function randomArray(rnd: () => number): number[] {
  const shape = Math.floor(rnd() * 6);
  const n = shape === 0 ? 0 : shape === 1 ? 1 : Math.floor(rnd() * 15);
  const v = Math.floor(rnd() * 1000);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (shape === 2) out.push(v);
    else if (shape === 3) out.push(i * 7);
    else if (shape === 4) out.push(999 - i * 7);
    else out.push(Math.floor(rnd() * (shape === 5 ? 20 : 1000)));
  }
  return out;
}

const firstAtLeast = (a: number[], k: number) => {
  const i = a.findIndex((v) => v >= k);
  return i < 0 ? a.length : i;
};

describe('binary search', () => {
  it('matches a linear scan on thousands of sorted arrays', () => {
    const rnd = makeRng(42);
    for (let t = 0; t < 4000; t++) {
      const a = randomArray(rnd).sort((x, y) => x - y);
      const s = withItems(a);
      for (let r = 0; r < 4; r++) {
        const key = a.length && rnd() < 0.5 ? a[Math.floor(rnd() * a.length)] : Math.floor(rnd() * 1000);
        const f = find(s, key, quiet(s));
        if (a.includes(key)) expect(a[f.index]).toBe(key);
        else expect(f.index).toBe(-1);
        expect(f.mids.length).toBeLessThanOrEqual(worstCase(a.length));
        const lb = lowerBound(s, key, quiet(s));
        expect(lb.index).toBe(firstAtLeast(a, key));
        expect(lb.mids.length).toBeLessThanOrEqual(worstCase(a.length));
        expect(s.items).toEqual(a);
      }
    }
  });

  it('counts the same comparisons with recording on and off', () => {
    const rnd = makeRng(9);
    for (let t = 0; t < 300; t++) {
      const raw = randomArray(rnd);
      const a = rnd() < 0.5 ? raw.sort((x, y) => x - y) : raw;
      const key = Math.floor(rnd() * 1000);
      for (const op of [find, lowerBound]) {
        const s1 = withItems(a);
        const s2 = withItems(a);
        const r1 = quiet(s1);
        const r2 = loud(s2);
        const x = op(s1, key, r1);
        const y = op(s2, key, r2);
        expect(x).toEqual(y);
        expect(r1.counters.comparisons ?? 0).toBe(x.mids.length);
        expect(r2.counters.comparisons ?? 0).toBe(x.mids.length);
        checkFrames(r2.frames);
        expect(s2.tags).toEqual({});
      }
    }
  });

  it('shows the miss on an unsorted array, naming the comparison that ruled the key out', () => {
    const s = withItems([42, 8, 63, 3, 27, 88, 15, 56, 21, 71, 34, 27]);
    const rec = loud(s);
    expect(find(s, 8, rec).index).toBe(-1);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toMatch(/at index 1/);
    expect(last.message).toMatch(/Comparison 3/);
  });

  it('flags a wrong lower bound on an unsorted array', () => {
    const s = withItems([50, 10, 60, 20, 70]);
    const rec = loud(s);
    lowerBound(s, 30, rec);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/wrong/);
  });

  it('loads typed numbers and refuses bad or long lists without changing anything', () => {
    expect(parseNumbers('5 2, 9 1')).toEqual([5, 2, 9, 1]);
    expect(parseNumbers('5 x')).toBeNull();
    expect(parseNumbers('1000')).toBeNull();
    const s = create();
    expect(loadSorted(s, '9 3 3 1', quiet(s))).toBe(true);
    expect(s.items).toEqual([1, 3, 3, 9]);
    expect(loadSorted(s, 'nope', quiet(s))).toBe(false);
    expect(loadSorted(s, Array.from({ length: 20 }, (_, i) => i).join(' '), quiet(s))).toBe(false);
    expect(s.items).toEqual([1, 3, 3, 9]);
    expect(setArray(s, '4 1 2', quiet(s))).toBe(true);
    expect(s.items).toEqual([4, 1, 2]);
    expect(setArray(s, '1 x', quiet(s))).toBe(false);
    expect(s.items).toEqual([4, 1, 2]);
    expect(loadUnsorted(s, '4 1 2', quiet(s))).toBe(true);
    expect(s.items).toEqual([4, 1, 2]);
    for (let t = 0; t < 200; t++) {
      expect(loadSorted(s, 10, quiet(s))).toBe(true);
      expect(isSorted(s.items)).toBe(true);
      expect(loadUnsorted(s, undefined, quiet(s))).toBe(true);
      expect(isSorted(s.items)).toBe(false);
    }
  });

  it('runs the seed and the tour through the definition', () => {
    const s = def.create({});
    for (const [opId, ...args] of def.seed) def.ops.find((o) => o.id === opId)!.run(s, args, quiet(s));
    expect(s.items).toEqual([3, 8, 15, 21, 27, 27, 34, 42, 56, 63, 71, 88]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    for (const [opId, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === opId)!.run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
    }
    for (const op of def.ops) {
      const rec = loud(s);
      op.run(s, op.suggest?.(s) ?? [], rec);
      checkFrames(rec.frames);
    }
  });
});
