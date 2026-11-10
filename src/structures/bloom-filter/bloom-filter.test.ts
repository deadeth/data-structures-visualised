import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, {
  HASHES,
  K,
  PRIME,
  SEED_KEYS,
  TOUR_ABSENT,
  TOUR_ADD,
  TOUR_PRESENT,
  add,
  check,
  create,
  estimatedRate,
  hash,
  layout,
  positions,
  type BloomState,
} from './index';

const quiet = (s: BloomState) => new Recorder(s, layout, false);
const loud = (s: BloomState) => new Recorder(s, layout, true);

/** Throws if the filter disagrees with the set of keys that were really added. */
function verify(s: BloomState, model: Set<number>): void {
  const expected = new Array<number>(s.m).fill(0);
  for (const k of model) for (const bit of positions(k, s.m)) expected[bit] = 1;
  expect(s.bits).toEqual(expected);
  expect(s.ones).toBe(expected.reduce((a, b) => a + b, 0));
  expect([...s.added].sort((a, b) => a - b)).toEqual([...model].sort((a, b) => a - b));
  for (let bit = 0; bit < s.m; bit++) {
    if (s.bits[bit] === 0) {
      expect(s.setBy[bit]).toBe(-1);
    } else {
      // The recorded setter was really added and really hashes to this bit.
      expect(model.has(s.setBy[bit])).toBe(true);
      expect(positions(s.setBy[bit], s.m)).toContain(bit);
    }
  }
}

/** Unique ids, edges with both ends present, probe on an existing node. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    for (const n of f.scene.nodes) for (const c of n.cells) expect(c.tone).not.toBe('key');
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
  }
}

describe('Bloom filter', () => {
  it('hash functions are the stated sums and stay inside the array', () => {
    expect(HASHES.length).toBe(K);
    expect(hash(0, 374, 32)).toBe(((7 * 374 + 3) % 1009) % 32);
    expect(positions(374, 32)).toEqual([27, 20, 19]);
    expect(PRIME).toBeGreaterThan(999);
    for (const m of [16, 32, 64]) {
      for (let key = 0; key <= 999; key++) {
        for (const bit of positions(key, m)) {
          expect(Number.isInteger(bit)).toBe(true);
          expect(bit).toBeGreaterThanOrEqual(0);
          expect(bit).toBeLessThan(m);
        }
      }
    }
  });

  it('keys m apart do not share all three bits', () => {
    for (const m of [32, 64]) {
      for (let key = 0; key + m <= 999; key++) expect(positions(key, m)).not.toEqual(positions(key + m, m));
    }
  });

  for (const m of [16, 32, 64]) {
    it(`never gives a false negative and labels false positives truthfully (${m} bits)`, () => {
      const rnd = makeRng(m * 7919);
      let s = create(m);
      let model = new Set<number>();
      let falsePositives = 0;
      for (let i = 0; i < 4000; i++) {
        // Start again now and then, so the filter is tested sparse as well as full.
        if (i % 400 === 0) {
          s = create(m);
          model = new Set();
          falsePositives = 0;
        }
        const key = Math.floor(rnd() * 1000);
        if (rnd() < 0.08) {
          const before = s.ones;
          const fresh = add(s, key, quiet(s));
          expect(s.ones - before).toBe(fresh);
          model.add(key);
        } else {
          const rec = quiet(s);
          const answer = check(s, key, rec);
          const bitsAllSet = positions(key, m).every((bit) => s.bits[bit] === 1);
          expect(answer).toBe(bitsAllSet);
          if (model.has(key)) expect(answer).toBe(true);
          if (!answer) expect(model.has(key)).toBe(false);
          const isFalsePositive = answer && !model.has(key);
          if (isFalsePositive) falsePositives++;
          expect(rec.counters.falsePositives ?? 0).toBe(isFalsePositive ? 1 : 0);
          expect(rec.counters.comparisons).toBeGreaterThanOrEqual(1);
          expect(rec.counters.comparisons).toBeLessThanOrEqual(K);
          if (answer) expect(rec.counters.comparisons).toBe(K);
        }
        expect(s.falsePositives).toBe(falsePositives);
        if (i % 40 === 0) verify(s, model);
      }
      verify(s, model);
      for (const key of model) expect(check(s, key, quiet(s))).toBe(true);
    });
  }

  it('adding a key twice changes nothing', () => {
    const s = create(32);
    expect(add(s, 374, quiet(s))).toBe(3);
    const bits = [...s.bits];
    const rec = loud(s);
    expect(add(s, 374, rec)).toBe(0);
    expect(s.bits).toEqual(bits);
    expect(s.added.size).toBe(1);
    expect(rec.counters.writes ?? 0).toBe(0);
    expect(rec.frames[rec.frames.length - 1].message).toContain('nothing changed');
  });

  it('a check on an empty filter stops at the first bit', () => {
    const s = create(32);
    const rec = loud(s);
    expect(check(s, 500, rec)).toBe(false);
    expect(rec.counters.comparisons).toBe(1);
    expect(rec.frames[rec.frames.length - 1].message).toContain('definitely not in the set');
  });

  it('counters match with recording on and off', () => {
    const rnd = makeRng(42);
    for (const m of [16, 32, 64]) {
      const a = create(m);
      const b = create(m);
      for (let i = 0; i < 300; i++) {
        const key = Math.floor(rnd() * 1000);
        const isAdd = rnd() < 0.2;
        const on = loud(a);
        const off = quiet(b);
        if (isAdd) expect(add(a, key, on)).toBe(add(b, key, off));
        else expect(check(a, key, on)).toBe(check(b, key, off));
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(1);
        expect(off.counters).toEqual(on.counters);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        expect(b.bits).toEqual(a.bits);
        expect(b.falsePositives).toBe(a.falsePositives);
        if (i % 25 === 0) checkFrames(on.frames);
      }
    }
  });

  it('records a probe on every hash step and a comparison for every bit checked', () => {
    const s = create(32);
    for (const k of SEED_KEYS) add(s, k, quiet(s));
    const rec = loud(s);
    check(s, TOUR_PRESENT, rec);
    checkFrames(rec.frames);
    const compares = rec.frames.filter((f) => f.compare);
    expect(compares.length).toBe(K);
    expect(rec.counters.comparisons).toBe(K);
    const bits = positions(TOUR_PRESENT, 32);
    compares.forEach((f, i) => {
      expect(f.compare).toMatchObject({ left: `bit ${bits[i]}`, op: '=', right: 1 });
      expect(f.probe).toEqual({ text: String(TOUR_PRESENT), at: `b${bits[i]}` });
      // The bit being read is highlighted as the one under comparison.
      expect(f.scene.nodes.find((n) => n.id === `b${bits[i]}`)!.tone).toBe('compare');
    });
    // Only the opening sentence has no probe.
    expect(rec.frames.filter((f) => !f.probe).length).toBe(1);
    // The sums in the narration are the real ones.
    expect(rec.frames.some((f) => f.message.includes(`7 × ${TOUR_PRESENT} + 3 = ${7 * TOUR_PRESENT + 3}`))).toBe(true);
  });

  it('an add marks new bits ok and counts only bits that changed', () => {
    const s = create(32);
    for (const k of SEED_KEYS) add(s, k, quiet(s));
    const before = [...s.bits];
    const rec = loud(s);
    add(s, TOUR_ADD, rec);
    checkFrames(rec.frames);
    const bits = positions(TOUR_ADD, 32);
    const fresh = bits.filter((b) => before[b] === 0);
    expect(fresh.length).toBe(2);
    expect(rec.counters.writes).toBe(fresh.length);
    expect(rec.counters.comparisons ?? 0).toBe(0);
    const last = rec.frames[rec.frames.length - 1];
    for (const b of bits) {
      const node = last.scene.nodes.find((n) => n.id === `b${b}`)!;
      expect(node.cells[0].text).toBe('1');
      expect(node.tone).toBe(before[b] === 0 ? 'ok' : 'path');
    }
    expect(rec.frames.some((f) => f.message.includes('already 1, set earlier by 265'))).toBe(true);
  });

  it('layout puts 16 bits on a row without overlaps, for every size', () => {
    for (const m of [16, 32, 64]) {
      const s = create(m);
      for (const k of SEED_KEYS) add(s, k, quiet(s));
      const scene = layout(s);
      expect(scene.nodes.length).toBe(m);
      const rows = new Map<number, number[]>();
      for (const n of scene.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), n.x]);
      expect(rows.size).toBe(m / 16);
      for (const xs of rows.values()) {
        expect(xs.length).toBe(16);
        for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(34);
      }
      const ys = [...rows.keys()].sort((a, b) => a - b);
// Cell, index label, then room for the probe chip (26 tall, 9 above the next cell).
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(36 + 18 + 35);
      scene.nodes.forEach((n, i) => {
        expect(n.cells[0].text).toBe(String(s.bits[i]));
        expect(n.cells[0].sub).toBe(String(i));
      });
      const keyLine = scene.decor!.find((d) => d.id === 'keys')!;
      expect(keyLine.type === 'label' && keyLine.text).toBe('Keys added (5): 11, 265, 540, 686, 798');
    }
  });

  it('the key list stays short however many keys are added', () => {
    const s = create(64);
    for (let k = 0; k < 400; k += 7) add(s, k, quiet(s));
    const keyLine = layout(s).decor!.find((d) => d.id === 'keys')!;
    expect(keyLine.type === 'label' && keyLine.text.length).toBeLessThan(95);
  });

  it('estimated rate follows (1 - e^(-kn/m))^k', () => {
    expect(estimatedRate(0, 32)).toBe(0);
    expect(estimatedRate(5, 32)).toBeCloseTo(Math.pow(1 - Math.exp(-15 / 32), 3), 12);
    expect(estimatedRate(5, 32)).toBeCloseTo(0.052, 3);
    expect(estimatedRate(50, 16)).toBeGreaterThan(0.99);
  });

  it('seed and tour run cleanly through the definition, and the tour ends on a real false positive', () => {
    expect(def.id).toBe('bloom-filter');
    expect(def.bench).toBeUndefined();
    const bitsParam = def.params!.find((p) => p.id === 'bits')!;
    expect(bitsParam.default).toBe(32);
    expect(bitsParam.options.map((o) => o.value)).toEqual([16, 32, 64]);
    expect(def.seed.length).toBeGreaterThanOrEqual(4);
    expect(def.seed.length).toBeLessThanOrEqual(5);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);

    const s = def.create({ bits: 32 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    const model = new Set(SEED_KEYS);
    verify(s, model);

    const [present, absent, adding, falsePositive] = def.tour.map(([id, ...args]) => ({ id, args }));
    expect([present.id, absent.id, adding.id, falsePositive.id]).toEqual(['check', 'check', 'add', 'check']);

    // 1. A key that was added: all three bits match.
    expect(model.has(Number(present.args[0]))).toBe(true);
    let rec = run(present.id, present.args, true);
    checkFrames(rec.frames);
    expect(rec.counters.comparisons).toBe(3);
    expect(rec.counters.falsePositives ?? 0).toBe(0);
    expect(rec.frames[rec.frames.length - 1].message).toContain('and it is');

    // 2. A key that was never added: the check stops at a 0 before reading all three bits.
    const ghost = Number(absent.args[0]);
    expect(ghost).toBe(TOUR_ABSENT);
    expect(model.has(ghost)).toBe(false);
    rec = run(absent.id, absent.args, true);
    checkFrames(rec.frames);
    expect(rec.counters.comparisons).toBe(2);
    expect(rec.counters.falsePositives ?? 0).toBe(0);
    expect(rec.frames.filter((f) => f.compare).pop()!.compare).toMatchObject({ left: 'bit 19', op: '=', right: 0 });
    expect(rec.frames[rec.frames.length - 1].message).toContain('definitely not in the set');

    // 3. Add a different key. One of its bits was already set.
    const newcomer = Number(adding.args[0]);
    expect(newcomer).not.toBe(ghost);
    rec = run(adding.id, adding.args, true);
    checkFrames(rec.frames);
    model.add(newcomer);
    verify(s, model);
    expect(rec.counters.writes).toBe(2);

    // 4. The same absent key is now a false positive: never added, yet every bit is 1,
    //    and the three bits were set by three different keys.
    expect(Number(falsePositive.args[0])).toBe(ghost);
    expect(s.added.has(ghost)).toBe(false);
    expect(model.has(ghost)).toBe(false);
    const ghostBits = positions(ghost, s.m);
    expect(ghostBits).toEqual([16, 19, 5]);
    expect(ghostBits.every((bit) => s.bits[bit] === 1)).toBe(true);
    expect(ghostBits.map((bit) => s.setBy[bit])).toEqual([11, 374, 798]);
    rec = run(falsePositive.id, falsePositive.args, true);
    checkFrames(rec.frames);
    expect(rec.counters.comparisons).toBe(3);
    expect(rec.counters.falsePositives).toBe(1);
    expect(s.falsePositives).toBe(1);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toContain('False positive');
    expect(last.message).toContain('bit 16 by 11, bit 19 by 374 and bit 5 by 798');
    verify(s, model);

    const status = def.status!(s);
    expect(status.map((f) => f.value)).toEqual(['6', '15 of 32', '8.0%', '1']);
  });

  it('tour also runs at the other sizes, and fill and suggest give usable arguments', () => {
    for (const bits of [16, 64]) {
      const s = def.create({ bits });
      for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
      for (const [id, ...args] of def.tour) {
        const rec = loud(s);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        expect(rec.frames.length).toBeGreaterThan(1);
        checkFrames(rec.frames);
      }
      for (let i = 0; i < 40; i++) {
        const [id, ...args] = def.fill!(s);
        expect(id).toBe('add');
        expect(Number.isInteger(args[0])).toBe(true);
        def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
        for (const op of def.ops) {
          const [k] = op.suggest!(s);
          expect(Number(k)).toBeGreaterThanOrEqual(0);
          expect(Number(k)).toBeLessThanOrEqual(999);
        }
      }
      verify(s, new Set(s.added));
    }
  });
});
