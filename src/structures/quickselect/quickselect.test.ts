import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { create, kthSmallest, layout, MAX, ordinal, setArray, setFromText, topK, type QState } from './index';

const quiet = (s: QState) => new Recorder(s, layout, false);
const loud = (s: QState) => new Recorder(s, layout, true);

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—|\[object/);
  }
}

function inputs(rnd: () => number): number[][] {
  const out: number[][] = [[], [7], [3, 3], [5, 1]];
  for (let t = 0; t < 2500; t++) {
    const n = Math.floor(rnd() * (t % 10 === 0 ? 300 : 16));
    const kind = t % 5;
    let a = Array.from({ length: n }, () => Math.floor(rnd() * 1000));
    if (kind === 1) a.sort((x, y) => x - y);
    if (kind === 2) a.sort((x, y) => y - x);
    if (kind === 3) a = a.map(() => 42);
    if (kind === 4) a = a.map(() => 1 + Math.floor(rnd() * 3));
    out.push(a);
  }
  return out;
}

describe('quickselect and top k', () => {
  it('quickselect finds the k-th smallest and leaves the array split around it', () => {
    const rnd = makeRng(5);
    for (const a of inputs(rnd)) {
      const sorted = [...a].sort((x, y) => x - y);
      const ks = a.length ? [1, a.length, 1 + Math.floor(rnd() * a.length)] : [1];
      for (const k of ks) {
        const s = create();
        setArray(s, a);
        s.k = k;
        const got = kthSmallest(s, quiet(s));
        if (!a.length) {
          expect(got).toBeUndefined();
          continue;
        }
        expect(got).toBe(sorted[k - 1]);
        const b = s.items.map((it) => it.v);
        expect([...b].sort((x, y) => x - y)).toEqual(sorted);
        for (let i = 0; i < k - 1; i++) expect(b[i]).toBeLessThanOrEqual(got!);
        for (let i = k; i < b.length; i++) expect(b[i]).toBeGreaterThanOrEqual(got!);
      }
    }
  });

  it('refuses a k larger than the array', () => {
    const s = create();
    setArray(s, [4, 2]);
    s.k = 3;
    const before = s.items.map((it) => it.v);
    expect(kthSmallest(s, quiet(s))).toBeUndefined();
    expect(s.items.map((it) => it.v)).toEqual(before);
  });

  it('top k keeps the k largest in a valid min-heap and leaves the input alone', () => {
    const rnd = makeRng(9);
    for (const a of inputs(rnd)) {
      for (const k of [1, 2, 1 + Math.floor(rnd() * 12)]) {
        const s = create();
        setArray(s, a);
        s.k = k;
        const got = topK(s, quiet(s));
        expect(s.items.map((it) => it.v)).toEqual(a);
        const want = [...a].sort((x, y) => x - y).slice(Math.max(0, a.length - k));
        expect([...got].sort((x, y) => x - y)).toEqual(want);
        for (let i = 1; i < got.length; i++) expect(got[(i - 1) >> 1]).toBeLessThanOrEqual(got[i]);
      }
    }
  });

  it('counts the same with recording on and off, and draws sane frames', () => {
    const rnd = makeRng(3);
    for (let t = 0; t < 300; t++) {
      const n = Math.floor(rnd() * 13);
      const a = Array.from({ length: n }, () => Math.floor(rnd() * (t % 3 === 0 ? 4 : 100)));
      const k = 1 + Math.floor(rnd() * Math.max(1, n));
      for (const run of [kthSmallest, topK]) {
        const s1 = create();
        setArray(s1, a);
        s1.k = k;
        const s2 = create();
        setArray(s2, a);
        s2.k = k;
        const r1 = quiet(s1);
        const r2 = loud(s2);
        expect(run(s1, r1)).toEqual(run(s2, r2));
        expect(r2.counters).toEqual(r1.counters);
        checkFrames(r2.frames);
      }
    }
  });

  it('quickselect on sorted input with the last item as pivot is quadratic', () => {
    const s = create();
    setArray(s, Array.from({ length: 10 }, (_, i) => i * 10));
    s.k = 1;
    const r = quiet(s);
    expect(kthSmallest(s, r)).toBe(0);
    expect(r.counters.comparisons).toBe(45);
  });

  it('sets the array from typed numbers, capped at the page limit', () => {
    const s = create();
    expect(setFromText(s, '5 2, 9 1', quiet(s))).toBe(true);
    expect(s.items.map((it) => it.v)).toEqual([5, 2, 9, 1]);
    expect(setFromText(s, Array.from({ length: 20 }, (_, i) => i).join(' '), quiet(s))).toBe(true);
    expect(s.items.length).toBe(MAX);
    expect(setFromText(s, '', quiet(s))).toBe(false);
    expect(s.items.length).toBe(MAX);
  });

  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  });

  it('runs the seed and the tour through the definition', () => {
    const s = def.create({});
    const find = (id: string) => def.ops.find((o) => o.id === id)!;
    for (const [id, ...args] of def.seed) find(id).run(s, args, quiet(s));
    expect(s.items.length).toBe(10);
    expect(s.k).toBe(4);
    const all: Frame[] = [];
    for (const [id, ...args] of def.tour) {
      const r = loud(s);
      find(id).run(s, args, r);
      expect(r.frames.length).toBeGreaterThan(0);
      all.push(...r.frames);
    }
    checkFrames(all);
    for (const op of def.ops) {
      const r = loud(s);
      op.run(s, op.suggest?.(s) ?? [], r);
      checkFrames(r.frames);
    }
  });
});
