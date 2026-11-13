import { describe, expect, it } from 'vitest';
import { listing } from '../../core/code';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { SEED, create, setArray, isSorted, layout, load, partition, setItems, sort, values, type QState } from './index';

const quiet = (s: QState) => new Recorder(s, layout, false);
const loud = (s: QState) => new Recorder(s, layout, true);

function withValues(vals: number[]): QState {
  const s = create();
  setItems(s, vals);
  return s;
}

/** Unique node ids, a probe that points at a node, readable messages, tags on cells. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—|\s\s/);
    const cellXs = new Set(f.scene.nodes.filter((n) => n.id.startsWith('it')).map((n) => n.x));
    for (const t of f.scene.nodes.filter((n) => n.shape === 'tag')) expect(cellXs.has(t.x)).toBe(true);
    // Only one item holds the followed key.
    expect(f.scene.nodes.filter((n) => n.tone === 'key').length).toBeLessThanOrEqual(1);
  }
}

function randomInput(rnd: () => number): number[] {
  const n = Math.floor(rnd() * 40);
  const top = [3, 10, 1000][Math.floor(rnd() * 3)];
  return Array.from({ length: n }, () => Math.floor(rnd() * top));
}

describe('quicksort', () => {
  it('sorts like the built-in sort, with either pivot rule', () => {
    const rnd = makeRng(5);
    const inputs: number[][] = [[], [7], [4, 4, 4, 4, 4], Array.from({ length: 30 }, (_, k) => k), Array.from({ length: 30 }, (_, k) => 30 - k)];
    for (let t = 0; t < 3000; t++) inputs.push(randomInput(rnd));
    for (const vals of inputs) {
      for (const m of [false, true]) {
        const s = withValues(vals);
        sort(s, m, quiet(s));
        expect(values(s)).toEqual([...vals].sort((p, q) => p - q));
        expect(isSorted(s)).toBe(true);
      }
    }
  });

  it('copes with long sorted input without deep recursion, and keeps the stack short', () => {
    const vals = Array.from({ length: 20000 }, (_, k) => k);
    const s = withValues(vals);
    const rec = quiet(s);
    sort(s, true, rec);
    expect(values(s)).toEqual(vals);
    expect(s.peak).toBeLessThanOrEqual(Math.ceil(Math.log2(vals.length)) + 1);
    const r = withValues(Array.from({ length: 3000 }, (_, k) => k));
    const worst = quiet(r);
    sort(r, false, worst);
    expect(worst.counters.comparisons).toBe((3000 * 2999) / 2);
    // Smaller side first: even the worst case leaves at most one range waiting.
    expect(r.peak).toBe(1);
  });

  it('puts the pivot in its final place in one partition', () => {
    const rnd = makeRng(9);
    for (let t = 0; t < 2000; t++) {
      const vals = randomInput(rnd);
      const s = withValues(vals);
      const p = partition(s, quiet(s));
      if (vals.length < 2) {
        expect(p).toBeUndefined();
        continue;
      }
      const a = values(s);
      expect([...a].sort((x, y) => x - y)).toEqual([...vals].sort((x, y) => x - y));
      expect(a[p!]).toBe(vals[vals.length - 1]);
      for (let k = 0; k < a.length; k++) {
        if (k < p!) expect(a[k]).toBeLessThanOrEqual(a[p!]);
        if (k > p!) expect(a[k]).toBeGreaterThan(a[p!]);
      }
    }
  });

  it('counts the comparisons and swaps the Python listing makes', () => {
    // From /tmp/algo/quicksort/counts.py, which counts the listing's own comparisons and swaps.
    const expected: [number[], boolean, number, number][] = [
      [SEED, false, 19, 13],
      [SEED, true, 28, 15],
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false, 45, 0],
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true, 28, 6],
      [[10, 9, 8, 7, 6, 5, 4, 3, 2, 1], false, 45, 5],
      [[10, 9, 8, 7, 6, 5, 4, 3, 2, 1], true, 31, 19],
      [[5, 5, 5, 5, 5, 5], false, 15, 0],
      [[5, 5, 5, 5, 5, 5], true, 27, 4],
      [[3, 7, 3, 7, 1, 3, 7, 1, 3, 7], false, 27, 7],
      [[3, 7, 3, 7, 1, 3, 7, 1, 3, 7], true, 38, 13],
      [[64, 25, 12, 22, 11, 90, 3, 45, 77, 50, 8, 31], false, 26, 15],
      [[64, 25, 12, 22, 11, 90, 3, 45, 77, 50, 8, 31], true, 42, 23],
    ];
    for (const [vals, m, c, w] of expected) {
      const s = withValues(vals);
      const rec = loud(s);
      sort(s, m, rec);
      expect([rec.counters.comparisons ?? 0, rec.counters.swaps ?? 0]).toEqual([c, w]);
      // Every comparison has its own frame.
      expect(rec.frames.filter((f) => f.compare).length).toBe(c);
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(77);
    for (let t = 0; t < 300; t++) {
      const n = Math.floor(rnd() * 13);
      const vals = Array.from({ length: n }, () => Math.floor(rnd() * (t % 2 ? 5 : 100)));
      for (const m of [false, true]) {
        const a = withValues(vals);
        const b = withValues(vals);
        const on = loud(a);
        const off = quiet(b);
        sort(a, m, on);
        sort(b, m, off);
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(values(a)).toEqual(values(b));
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
      }
    }
  });

  it('says when equal items lose their order', () => {
    // 5a sits behind 5b's swap partner and is jumped over it.
    const s = withValues([5, 5, 1]);
    const rec = loud(s);
    sort(s, false, rec);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/not stable/);
  });

  it('sets the array from typed numbers', () => {
    const s = create();
    let rec = loud(s);
    setArray(s, '5 9 5 2', rec);
    expect(values(s)).toEqual([5, 9, 5, 2]);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].scene.nodes.filter((n) => n.id.startsWith('it')).map((n) => n.cells[0].text)).toEqual(['5a', '9', '5b', '2']);
    setArray(s, Array.from({ length: 15 }, (_, k) => k).join(' '), (rec = loud(s)));
    expect(values(s).length).toBe(12);
    expect(rec.frames[0].message).toMatch(/stops at 12/);
    setArray(s, '', (rec = loud(s)));
    expect(values(s)).toEqual([]);
    sort(s, false, (rec = loud(s)));
    partition(s, (rec = loud(s)));
    checkFrames(rec.frames);
    for (const ex of [0, 1, 2, 3]) {
      const t = create();
      const op = def.ops.find((o) => o.id === 'set')!;
      op.run(t, op.suggest!(t), quiet(t));
      expect(values(t).length).toBeGreaterThan(0);
      void ex;
    }
  });

  it('loads the inputs it promises', () => {
    const s = create();
    for (let t = 0; t < 200; t++) {
      load(s, 'sorted', quiet(s));
      expect(isSorted(s)).toBe(true);
      expect(new Set(values(s)).size).toBe(10);
      load(s, 'reversed', quiet(s));
      expect(values(s)).toEqual([...values(s)].sort((p, q) => q - p));
      load(s, 'equal', quiet(s));
      expect(new Set(values(s)).size).toBeLessThanOrEqual(3);
      load(s, 'random', quiet(s));
      expect(values(s).every((v) => v >= 1 && v <= 99)).toBe(true);
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
    expect(values(s)).toEqual(SEED);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const counts = def.tour.map(([id, ...args]) => {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
      return [rec.counters.comparisons ?? 0, rec.counters.swaps ?? 0];
    });
    // One partition of 10 items; a random input; the sorted worst case; the same with median of three.
    expect(counts[0][0]).toBe(9);
    expect(counts[4]).toEqual([45, 0]);
    expect(counts[5][0]).toBe(28);
    expect(isSorted(s)).toBe(true);
  });

  it('names a line of both listings on every frame, on every path', () => {
    const seen = new Set<string>();
    const rnd = makeRng(31);
    const s = create();
    const ids = def.ops.map((o) => o.id);
    for (let t = 0; t < 800; t++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      const op = def.ops.find((o) => o.id === id)!;
      const rec = loud(s);
      op.run(s, id === 'set' ? op.suggest!(s) : [], rec);
      const anchors = (['python', 'java'] as const).map((lang) => listing(def.source![lang], lang, op.code!).anchors);
      for (const f of rec.frames) {
        expect(f.lines?.length, `${id}: "${f.message}"`).toBeGreaterThan(0);
        for (const a of f.lines!) {
          for (const known of anchors) expect(known.has(a), `${id} names "${a}"`).toBe(true);
          seen.add(`${id}:${a}`);
        }
      }
    }
    for (const lang of ['python', 'java'] as const) {
      for (const op of def.ops) {
        for (const a of listing(def.source![lang], lang, op.code!).anchors.keys()) {
          // The median of three call sits in the partition listing, but only one op takes that branch.
          if (a === 'median' && op.id !== 'sortMedian') continue;
          expect(seen.has(`${op.id}:${a}`), `${op.id}:${a}`).toBe(true);
        }
      }
    }
  });
});
