import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, OpDef } from '../../core/types';
import def, { CAP, create, layout, mergeK, mergeTwo, parseNumbers, setList, setLists, values, type Item, type MergeState } from './index';

const quiet = (s: MergeState) => new Recorder(s, layout, false);
const loud = (s: MergeState) => new Recorder(s, layout, true);

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length).toBeGreaterThan(0);
  }
}

/** The model: a stable sort of the concatenation, by value only. */
function model(lists: Item[][]): number[] {
  return lists
    .flat()
    .map((it, order) => ({ it, order }))
    .sort((a, b) => a.it.key - b.it.key || a.order - b.order)
    .map((x) => x.it.uid);
}

/** Comparisons the two-pointer merge must make: one per item written before either list runs out. */
function twoWayComparisons(a: number[], b: number[]): number {
  let i = 0, j = 0, c = 0;
  while (i < a.length && j < b.length) {
    c++;
    if (a[i] <= b[j]) i++;
    else j++;
  }
  return c;
}

function randomLists(rnd: () => number, k: number, maxLen: number): number[][] {
  const hi = [5, 50, 999][Math.floor(rnd() * 3)];
  return Array.from({ length: k }, () => Array.from({ length: Math.floor(rnd() * (maxLen + 1)) }, () => Math.floor(rnd() * (hi + 1))));
}

describe('merging sorted lists', () => {
  it('two-way: matches a stable sort, counts comparisons, and agrees with recording on and off', () => {
    const rnd = makeRng(11);
    const shapes: number[][][] = [[[], []], [[1], []], [[], [1]], [[4, 4, 4], [4, 4]], [[1, 2, 3], [4, 5, 6]], [[4, 5, 6], [1, 2, 3]], [[9, 8, 7, 6], [5, 4, 3]]];
    for (let t = 0; t < 3000; t++) {
      const lists = t < shapes.length ? shapes[t] : randomLists(rnd, 2, 8);
      const s = create();
      setLists(s, lists);
      const want = model(s.lists);
      const q = quiet(s);
      expect(mergeTwo(s, q).map((x) => x.uid)).toEqual(want);
      const s2 = create();
      setLists(s2, lists);
      const l = loud(s2);
      expect(mergeTwo(s2, l).map((x) => x.uid)).toEqual(want);
      expect(l.counters).toEqual(q.counters);
      expect(q.counters.comparisons ?? 0).toBe(twoWayComparisons(values(s.lists[0]), values(s.lists[1])));
      expect(q.counters.writes ?? 0).toBe(want.length);
      if (t < 200) checkFrames(l.frames);
    }
  });

  it('k-way: matches a stable sort and agrees with recording on and off', () => {
    const rnd = makeRng(29);
    for (let t = 0; t < 3000; t++) {
      const k = 2 + Math.floor(rnd() * 3);
      const lists = randomLists(rnd, k, CAP[k]);
      const s = create();
      setLists(s, lists);
      const want = model(s.lists);
      const q = quiet(s);
      expect(mergeK(s, q).map((x) => x.uid)).toEqual(want);
      const s2 = create();
      setLists(s2, lists);
      const l = loud(s2);
      expect(mergeK(s2, l).map((x) => x.uid)).toEqual(want);
      expect(l.counters).toEqual(q.counters);
      expect(q.counters.writes ?? 0).toBe(want.length);
      if (t < 200) checkFrames(l.frames);
    }
  });

  it('runs long inputs with recording off', () => {
    const rnd = makeRng(3);
    const lists = randomLists(rnd, 4, 5000).map((l) => l.concat([1, 2, 3]));
    const s = create();
    setLists(s, lists);
    const want = model(s.lists);
    expect(mergeK(s, quiet(s)).map((x) => x.uid)).toEqual(want);
    const s2 = create();
    setLists(s2, lists.slice(0, 2));
    expect(mergeTwo(s2, quiet(s2)).map((x) => x.uid)).toEqual(model(s2.lists));
  });

  it('two-way merge leaves C and D out', () => {
    const s = create();
    setLists(s, [[1, 5], [2, 6], [0, 3]]);
    expect(values(mergeTwo(s, quiet(s)))).toEqual([1, 2, 5, 6]);
    expect(values(mergeK(s, quiet(s)))).toEqual([0, 1, 2, 3, 5, 6]);
  });

  it('sets lists from typed numbers', () => {
    expect(parseNumbers('5 2, 9;1')).toEqual([5, 2, 9, 1]);
    expect(parseNumbers('abc')).toBeNull();
    const s = create();
    setLists(s, [[1, 5], [2, 6], [0, 3]]);
    const rec = loud(s);
    setList(s, 0, '9 3 5', rec);
    expect(s.lists.map(values)).toEqual([[3, 5, 9], [2, 6]]);
    expect(rec.frames[0].message).toMatch(/sorted first/);
    setList(s, 1, '1 2 3 4 5 6 7 8 9 10', quiet(s));
    expect(values(s.lists[1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const before = JSON.stringify(s.lists);
    setList(s, 0, 'hello', quiet(s));
    expect(JSON.stringify(s.lists)).toBe(before);
  });

  it('runs the seed, the tour and the suggestions through the definition', () => {
    const s = def.create({});
    const find = (id: string) => def.ops.find((o) => o.id === id) as OpDef<MergeState>;
    for (const [op, ...args] of def.seed) find(op).run(s, args, quiet(s));
    expect(s.lists.map(values)).toEqual([[4, 9, 15, 22, 31, 38], [6, 9, 17, 25]]);
    let frames = 0;
    for (const [op, ...args] of def.tour) {
      const rec = loud(s);
      find(op).run(s, args, rec);
      checkFrames(rec.frames);
      frames += rec.frames.length;
      expect(rec.frames.length).toBeGreaterThan(0);
    }
    expect(frames).toBeLessThan(150);
    for (let round = 0; round < 30; round++) {
      for (const op of def.ops) {
        const rec = loud(s);
        op.run(s, op.suggest?.(s) ?? [], rec);
        checkFrames(rec.frames);
        for (const f of rec.frames) {
          const xs = f.scene.nodes.map((n) => n.x);
          expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(900);
        }
      }
    }
  });
});
