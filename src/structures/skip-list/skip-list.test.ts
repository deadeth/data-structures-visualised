import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { MAX_LEVEL, allKeys, create, has, heights, insert, layout, remove, search, type SNode, type SkipState } from './index';

const quiet = (s: SkipState) => new Recorder(s, layout, false);
const loud = (s: SkipState) => new Recorder(s, layout, true);

/** Throws if any skip list invariant is broken. */
function check(s: SkipState): void {
  expect(s.pending).toBeNull();
  expect(s.head.next.length).toBe(MAX_LEVEL);
  expect(s.level).toBeGreaterThanOrEqual(1);
  expect(s.level).toBeLessThanOrEqual(MAX_LEVEL);
  for (let i = s.level; i < MAX_LEVEL; i++) expect(s.head.next[i]).toBeNull();
  if (s.level > 1) expect(s.head.next[s.level - 1]).not.toBeNull();

  // The bottom level holds every key once, in order.
  const base: SNode[] = [];
  for (let n = s.head.next[0]; n; n = n.next[0]) base.push(n);
  expect(base.length).toBe(s.size);
  let pointers = 0;
  for (let j = 0; j < base.length; j++) {
    const n = base[j];
    if (j > 0) expect(base[j - 1].key).toBeLessThan(n.key);
    expect(n.next.length).toBeGreaterThanOrEqual(1);
    expect(n.next.length).toBeLessThanOrEqual(s.level);
    pointers += n.next.length;
  }
  expect(s.pointers).toBe(pointers);

  // Level i links exactly the towers that reach it, in the same order.
  for (let i = 0; i < s.level; i++) {
    const want = base.filter((n) => n.next.length > i);
    const got: SNode[] = [];
    for (let n = s.head.next[i]; n; n = n.next[i]) got.push(n);
    expect(got.length).toBe(want.length);
    for (let j = 0; j < got.length; j++) expect(got[j]).toBe(want[j]);
  }
}

/** Unique node ids, edges that join existing nodes, a probe that points at one. Plain throws: this runs on thousands of frames. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    if (ids.size !== f.scene.nodes.length) throw new Error(`duplicate node id in "${f.message}"`);
    const edgeIds = new Set(f.scene.edges.map((e) => e.id));
    if (edgeIds.size !== f.scene.edges.length) throw new Error(`duplicate edge id in "${f.message}"`);
    for (const e of f.scene.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`edge ${e.id} joins ${e.from} to ${e.to}, one of which is missing, in "${f.message}"`);
    }
    if (f.probe && !ids.has(f.probe.at)) throw new Error(`probe points at missing node ${f.probe.at} in "${f.message}"`);
    if (!f.message || /undefined|NaN|—/.test(f.message)) throw new Error(`bad message "${f.message}"`);
  }
}

describe('skip list', () => {
  for (const seed of [1, 7, 2995]) {
    it(`stays valid through random inserts and deletes (seed ${seed})`, () => {
      const rnd = makeRng(seed * 7919);
      const s = create(seed);
      const model = new Set<number>();
      for (let i = 0; i < 4000; i++) {
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
      for (let k = 0; k < 400; k++) {
        expect(search(s, k, quiet(s))).toBe(model.has(k));
        expect(has(s, k)).toBe(model.has(k));
      }
      // Empty it completely.
      for (const k of [...model]) remove(s, k, quiet(s));
      check(s);
      expect(s.size).toBe(0);
      expect(s.level).toBe(1);
      expect(s.pointers).toBe(0);
    });
  }

  it('gives the same towers, counters and results with recording on and off', () => {
    const rnd = makeRng(99);
    const a = create(5);
    const b = create(5);
    for (let i = 0; i < 600; i++) {
      const k = Math.floor(rnd() * 120);
      const r = rnd();
      const op = r < 0.45 ? insert : r < 0.75 ? search : remove;
      const on = loud(a);
      const off = quiet(b);
      expect(op(a, k, on)).toBe(op(b, k, off));
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(1);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(heights(a)).toEqual(heights(b));
      expect(allKeys(a)).toEqual(allKeys(b));
      if (i % 25 === 0) check(a);
    }
    check(a);
    check(b);
  });

  it('replays identically from the same seed', () => {
    const build = () => {
      const s = create(321);
      for (let k = 0; k < 300; k += 3) insert(s, (k * 37) % 300, quiet(s));
      return heights(s);
    };
    expect(build()).toEqual(build());
  });

  it('promotes about half the towers at each level', () => {
    const s = create(11);
    for (let k = 0; k < 1000; k++) insert(s, k, quiet(s));
    const hs = heights(s);
    // Expected height with p = 1/2 and a cap of 5 is 1 + 1/2 + 1/4 + 1/8 + 1/16 = 1.9375.
    const mean = s.pointers / s.size;
    expect(mean).toBeGreaterThan(1.8);
    expect(mean).toBeLessThan(2.08);
    const taller = hs.filter((h) => h >= 2).length;
    expect(taller).toBeGreaterThan(440);
    expect(taller).toBeLessThan(560);
    expect(Math.max(...hs)).toBe(MAX_LEVEL);
  });

  it('searches far faster than a walk along the bottom level', () => {
    const s = create(3);
    for (let k = 0; k < 64; k++) insert(s, k * 3, quiet(s));
    const rec = quiet(s);
    for (let k = 0; k < 64; k++) search(s, k * 3, rec);
    // A plain list would average 32.5 comparisons per hit.
    expect(rec.counters.comparisons / 64).toBeLessThan(12);
  });

  it('shows one frame per comparison and one per coin flip', () => {
    const s = create();
    for (const [, k] of def.seed) insert(s, Number(k), quiet(s));
    const before = heights(s).length;
    const rec = loud(s);
    insert(s, 20, rec);
    checkFrames(rec.frames);
    expect(rec.frames.filter((f) => f.compare).length).toBe(rec.counters.comparisons);
    const flips = rec.frames.filter((f) => f.message.startsWith('Flip:'));
    const h = heights(s)[allKeys(s).indexOf(20)];
    expect(heights(s).length).toBe(before + 1);
    expect(flips.filter((f) => f.message.startsWith('Flip: heads')).length).toBe(h - 1);
    expect(flips.length).toBe(h < MAX_LEVEL ? h : h - 1);
    expect(rec.counters.writes).toBe(2 * h);
    // The followed key is on every frame of an insert.
    for (const f of rec.frames) expect(f.probe?.text).toBe('20');
    // Every comparison frame puts the probe on the box being compared.
    for (const f of rec.frames) {
      if (!f.compare) continue;
      const box = f.scene.nodes.find((n) => n.id === f.probe!.at)!;
      expect(box.tone).toBe('compare');
      expect(box.cells[0].text).toBe(String(f.compare.right));
    }
  });

  it('marks the route of a search and counts the nodes on it', () => {
    const s = create();
    for (const [, k] of def.seed) insert(s, Number(k), quiet(s));
    const rec = loud(s);
    expect(search(s, 85, rec)).toBe(true);
    const last = rec.frames[rec.frames.length - 1];
    const onPath = last.scene.edges.filter((e) => e.kind === 'side' && e.tone === 'path').length;
    // The head, then one node per hop.
    expect(rec.counters.reads).toBe(onPath + 1);
    expect(last.scene.nodes.filter((n) => n.tone === 'ok').every((n) => n.id.startsWith('k85:'))).toBe(true);
    expect(last.probe?.at.startsWith('k85:')).toBe(true);
    expect(rec.counters.comparisons).toBeLessThan(allKeys(s).indexOf(85) + 1);
  });

  it('inserting a stored key changes nothing', () => {
    const s = create();
    for (const k of [10, 20, 30]) insert(s, k, quiet(s));
    const before = heights(s);
    const probe = create();
    for (const k of [10, 20, 30]) insert(probe, k, quiet(probe));
    const rec = loud(s);
    expect(insert(s, 20, rec)).toBe(false);
    expect(heights(s)).toEqual(before);
    expect(rec.counters.writes ?? 0).toBe(0);
    // A duplicate must not use up a coin flip, or later runs would not replay.
    expect(s.rnd()).toBe(probe.rnd());
  });

  it('deleting the only tall tower drops the empty levels', () => {
    const s = create();
    for (const [, k] of def.seed) insert(s, Number(k), quiet(s));
    const hs = heights(s);
    const tallest = allKeys(s)[hs.indexOf(Math.max(...hs))];
    const levels = s.level;
    const rec = loud(s);
    expect(remove(s, tallest, rec)).toBe(true);
    checkFrames(rec.frames);
    expect(rec.counters.writes).toBe(levels);
    expect(s.level).toBeLessThan(levels);
    check(s);
  });

  it('works on an empty list', () => {
    const s = create();
    for (const op of [search, remove, insert, search, remove]) {
      const rec = loud(s);
      op(s, 42, rec);
      checkFrames(rec.frames);
      check(s);
    }
    expect(s.size).toBe(0);
  });

  it('seed, tour and fill run cleanly through the definition', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(s.size).toBe(def.seed.length);
    expect(s.level).toBeGreaterThanOrEqual(3);
    checkFrames([{ scene: def.layout(s), message: 'rest', counters: {} }]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);

    const tall = (key: number) => heights(s)[allKeys(s).indexOf(key)];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      checkFrames(rec.frames);
      check(s);
    }
    // The tour's first insert is promoted at least two levels, and its delete has removed a key.
    expect(tall(20)).toBeGreaterThanOrEqual(3);
    expect(has(s, 54)).toBe(false);

    for (let i = 0; i < 40; i++) {
      const [id, ...args] = def.fill!(s);
      const size = s.size;
      run(id, args, false);
      expect(s.size).toBe(size + 1);
    }
    check(s);
    for (const op of def.ops) {
      const args = op.suggest!(s);
      expect(args.length).toBe(op.args.length);
    }
    expect(def.status!(s).length).toBe(3);
  });
});
