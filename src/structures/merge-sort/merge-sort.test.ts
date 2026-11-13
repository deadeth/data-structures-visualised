import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { create, layout, levels, makeInput, mergeSort, parseNumbers, setArray, setValues, stableOrder, values, type MSState } from './index';

const quiet = (s: MSState) => new Recorder(s, layout, false);
const loud = (s: MSState) => new Recorder(s, layout, true);

function setTo(v: number[]): MSState {
  const s = create();
  setValues(s, v);
  return s;
}

/** Comparisons a plain top-down merge sort makes, counted independently. */
function modelCount(v: number[]): number {
  if (v.length < 2) return 0;
  const mid = v.length >> 1;
  const l = [...v.slice(0, mid)].sort((a, b) => a - b);
  const r = [...v.slice(mid)].sort((a, b) => a - b);
  let i = 0, j = 0, c = 0;
  while (i < l.length && j < r.length) {
    c++;
    if (l[i] <= r[j]) i++;
    else j++;
  }
  return modelCount(v.slice(0, mid)) + modelCount(v.slice(mid)) + c;
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
    expect(f.lines?.length).toBeGreaterThan(0);
  }
}

describe('merge sort', () => {
  it('sorts stably and counts like a plain merge sort on thousands of inputs', () => {
    const rnd = makeRng(11);
    const cases: number[][] = [[], [5], [7, 7, 7, 7], [1, 2, 3, 4, 5, 6], [9, 8, 7, 6, 5, 4, 3]];
    for (let t = 0; t < 4000; t++) {
      const kind = (['random', 'sorted', 'reversed', 'equal'] as const)[t % 4];
      const n = t % 50 === 0 ? 200 + Math.floor(rnd() * 400) : Math.floor(rnd() * 17);
      cases.push(makeInput(kind, n, rnd));
    }
    for (const v of cases) {
      const s = setTo(v);
      const before = s.a.map((it) => it!.uid);
      const rec = quiet(s);
      mergeSort(s, rec);
      expect(values(s)).toEqual([...v].sort((a, b) => a - b));
      // Stable: equal values keep their original order of ids.
      const byUid = new Map(before.map((u, i) => [u, i]));
      for (let i = 1; i < s.a.length; i++) {
        if (s.a[i - 1]!.value === s.a[i]!.value) expect(byUid.get(s.a[i - 1]!.uid)!).toBeLessThan(byUid.get(s.a[i]!.uid)!);
      }
      expect(stableOrder(s)).toBe(true);
      expect(rec.counters.comparisons ?? 0).toBe(modelCount(v));
      // Every item goes into the buffer and back once per level of a power-of-two input; in general 2n per level touched.
      if (v.length >= 2 && (v.length & (v.length - 1)) === 0) expect(rec.counters.writes).toBe(2 * v.length * levels(v.length));
      expect(s.stack.length).toBe(0);
      expect(s.buf.every((b) => b === null)).toBe(true);
    }
  });

  it('counts the same with recording on and off', () => {
    const rnd = makeRng(3);
    for (let t = 0; t < 60; t++) {
      const v = makeInput('random', 2 + Math.floor(rnd() * 11), rnd);
      const a = setTo(v);
      const b = setTo(v);
      const qa = quiet(a);
      const lb = loud(b);
      mergeSort(a, qa);
      mergeSort(b, lb);
      expect(lb.counters).toEqual(qa.counters);
      expect(values(a)).toEqual(values(b));
      checkFrames(lb.frames);
      // Every comparison is a frame.
      expect(lb.frames.filter((f) => f.compare).length).toBe(lb.counters.comparisons);
    }
  });

  it('writes the same on sorted and random input of the same size', () => {
    const r = quiet(setTo([38, 27, 43, 3, 9, 82, 10, 5]));
    const s1 = setTo([38, 27, 43, 3, 9, 82, 10, 5]);
    const q1 = quiet(s1);
    mergeSort(s1, q1);
    const q2 = quiet(s1);
    mergeSort(s1, q2);
    expect(q2.counters.writes).toBe(q1.counters.writes);
    expect(q2.counters.comparisons).toBe(12);
    expect(r.recording).toBe(false);
  });

  it('sets the array from typed numbers, cut to the limit, and refuses junk', () => {
    const s = create();
    const rec = loud(s);
    setArray(s, '5 2 5 9 2 5 1 3 4 6 7 8 9 10', rec);
    expect(values(s)).toEqual([5, 2, 5, 9, 2, 5, 1, 3, 4, 6, 7, 8]);
    expect(s.a.map((it) => it!.tag).slice(0, 6)).toEqual(['a', 'a', 'b', '', 'b', 'c']);
    expect(rec.frames[0].message).toMatch(/stops at 12/);
    const bad = loud(s);
    setArray(s, '5 x', bad);
    expect(values(s).length).toBe(12);
    expect(bad.frames[0].message).toMatch(/Sorry/);
  });

  it('parses typed numbers', () => {
    expect(parseNumbers('5 2, 9 1')).toEqual([5, 2, 9, 1]);
    expect(parseNumbers('5 x')).toBeNull();
    expect(parseNumbers('1000')).toBeNull();
  });

  it('runs the seed and the tour through the definition', () => {
    const s = def.create({});
    for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
    expect(values(s)).toEqual([38, 27, 43, 3, 9, 82, 10, 5]);
    let last = '';
    for (const [op, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === op)!.run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
      last = rec.frames[rec.frames.length - 1].message;
    }
    expect(last).toMatch(/kept their order: 8? ?.*17a 17b/);
    for (const op of def.ops) {
      const rec = loud(s);
      op.run(s, op.suggest?.(s) ?? [], rec);
      checkFrames(rec.frames);
    }
  });
});
