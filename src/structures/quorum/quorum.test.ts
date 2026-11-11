import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { MAX_KEYS, copyOf, create, down, layout, newestVersion, read, repair, staleCopies, tune, up, write, type Copy, type QuorumState } from './index';

const quiet = (s: QuorumState) => new Recorder(s, layout, false);
const loud = (s: QuorumState) => new Recorder(s, layout, true);

/** A plain model: what each replica holds, who is up, and the quorum sizes. */
interface Model {
  n: number;
  w: number;
  r: number;
  up: boolean[];
  data: Map<number, Copy>[];
  clock: number;
  /** Version of the last write the client was told succeeded, with the W it used. */
  latest: Map<number, { version: number; w: number }>;
}

const model = (n: number, w: number, r: number): Model => ({ n, w, r, up: new Array(n).fill(true), data: Array.from({ length: n }, () => new Map()), clock: 0, latest: new Map() });
const mget = (m: Model, i: number, key: number): Copy => m.data[i].get(key) ?? { value: null, version: 0 };

function verify(s: QuorumState, m?: Model): void {
  expect(s.keys).toEqual([...s.keys].sort((a, b) => a - b));
  expect(s.keys.length).toBeLessThanOrEqual(MAX_KEYS);
  for (let i = 0; i < s.n; i++) for (const c of Object.values(s.data[i])) expect(c.version).toBeLessThanOrEqual(s.clock);
  if (!m) return;
  expect(s.up).toEqual(m.up);
  expect([s.w, s.r]).toEqual([m.w, m.r]);
  for (let i = 0; i < s.n; i++) {
    for (const [key, c] of m.data[i]) expect(copyOf(s, i, key)).toEqual(c);
    expect(Object.keys(s.data[i]).length).toBe(m.data[i].size);
  }
}

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, a real probe target, a code line, plain tags, nothing overlapping, magenta only on the followed key. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const e of f.scene.edges) expect(byId.has(e.from) && byId.has(e.to)).toBe(true);
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    const bs = boxes(f.scene);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) expect.fail(`${a.id} overlaps ${b.id}`);
      }
    }
    const bounds = sceneBounds(f.scene)!;
    expect(bounds.bw).toBeLessThanOrEqual(940);
    expect(bounds.bh).toBeLessThanOrEqual(425);
  }
}

const KEYS = [5, 17, 42];

describe('quorum reads and writes', () => {
  for (const [n, w, r] of [[3, 2, 2], [3, 1, 1], [3, 3, 1], [5, 3, 3], [5, 2, 2], [5, 1, 5]]) {
    it(`matches a plain model through random operations (N ${n}, W ${w}, R ${r})`, () => {
      const rnd = makeRng(1000 * n + 10 * w + r);
      const pick = (k: number) => Math.floor(rnd() * k);
      const s = create(n, w, r);
      const m = model(n, w, r);
      let staleSeen = 0;
      let fails = 0;
      for (let step = 0; step < 5000; step++) {
        const roll = rnd();
        const rec = quiet(s);
        if (roll < 0.35) {
          const key = KEYS[pick(3)];
          const value = pick(1000);
          m.clock++;
          let acks = 0;
          for (let i = 0; i < n; i++) if (m.up[i]) (m.data[i].set(key, { value, version: m.clock }), acks++);
          const ok = write(s, key, value, rec);
          expect(ok).toBe(acks >= m.w);
          expect(rec.counters.writes ?? 0).toBe(acks);
          if (ok) m.latest.set(key, { version: m.clock, w: m.w });
          else fails++;
        } else if (roll < 0.65) {
          const key = KEYS[pick(3)];
          const first = 1 + pick(n);
          const order = Array.from({ length: n }, (_, k) => (first - 1 + k) % n);
          const replies = order.filter((i) => m.up[i]).slice(0, m.r);
          const known = s.keys.includes(key);
          const got = read(s, key, first, rec);
          if (!known) expect(got).toBeNull();
          else if (replies.length < m.r) {
            expect(got).toBeNull();
            expect(rec.counters.failed).toBe(1);
          } else {
            let best = replies[0];
            for (const i of replies.slice(1)) if (mget(m, i, key).version > mget(m, best, key).version) best = i;
            const want = mget(m, best, key);
            expect(got).toEqual(want);
            expect(rec.counters.reads).toBe(m.r);
            const latest = m.latest.get(key);
            // The rule itself: when the read quorum and the write quorum must overlap, the read is never stale.
            if (latest && m.r + latest.w > n) expect(want.version).toBeGreaterThanOrEqual(latest.version);
            if (rec.counters.stale) staleSeen++;
            let fixed = 0;
            for (const i of replies) if (mget(m, i, key).version < want.version) (m.data[i].set(key, { ...want }), fixed++);
            expect(rec.counters.repairs ?? 0).toBe(fixed);
          }
        } else if (roll < 0.75) {
          const i = pick(n);
          expect(down(s, i + 1, rec)).toBe(m.up[i]);
          m.up[i] = false;
        } else if (roll < 0.87) {
          const i = pick(n);
          expect(up(s, i + 1, rec)).toBe(!m.up[i]);
          m.up[i] = true;
        } else if (roll < 0.95) {
          const a = pick(n);
          const b = pick(n);
          let copies = 0;
          if (a !== b && m.up[a] && m.up[b]) {
            for (const key of new Set([...m.data[a].keys(), ...m.data[b].keys()])) {
              const ca = mget(m, a, key);
              const cb = mget(m, b, key);
              if (ca.version < cb.version) (m.data[a].set(key, { ...cb }), copies++);
              else if (cb.version < ca.version) (m.data[b].set(key, { ...ca }), copies++);
            }
          }
          expect(repair(s, a + 1, b + 1, rec)).toBe(copies);
        } else {
          const nw = 1 + pick(n);
          const nr = 1 + pick(n);
          expect(tune(s, nw, nr, rec)).toBe(nr + nw > n);
          m.w = nw;
          m.r = nr;
        }
        if (step % 20 === 0) verify(s, m);
      }
      verify(s, m);
      expect(fails).toBeGreaterThan(0);
      if (n === 3 && w === 1) expect(staleSeen).toBeGreaterThan(0);
    });
  }

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(77);
    for (const n of [3, 5]) {
      const a = create(n, 2, 2);
      const b = create(n, 2, 2);
      const pick = (k: number) => Math.floor(rnd() * k);
      for (let step = 0; step < 300; step++) {
        const on = loud(a);
        const off = quiet(b);
        const roll = rnd();
        const key = KEYS[pick(3)];
        if (roll < 0.35) {
          const v = pick(100);
          expect(write(a, key, v, on)).toBe(write(b, key, v, off));
        } else if (roll < 0.65) {
          const f = 1 + pick(n);
          expect(read(a, key, f, on)).toEqual(read(b, key, f, off));
        } else if (roll < 0.75) {
          const i = 1 + pick(n);
          expect(down(a, i, on)).toBe(down(b, i, off));
        } else if (roll < 0.87) {
          const i = 1 + pick(n);
          expect(up(a, i, on)).toBe(up(b, i, off));
        } else if (roll < 0.95) {
          const x = 1 + pick(n);
          const y = 1 + pick(n);
          expect(repair(a, x, y, on)).toBe(repair(b, x, y, off));
        } else {
          const w = 1 + pick(n);
          const r = 1 + pick(n);
          expect(tune(a, w, r, on)).toBe(tune(b, w, r, off));
        }
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    }
  });

  it('a write with one replica down still succeeds, and leaves that replica stale', () => {
    const s = create(3, 2, 2);
    write(s, 42, 10, quiet(s));
    down(s, 2, quiet(s));
    const rec = loud(s);
    expect(write(s, 42, 11, rec)).toBe(true);
    checkFrames(rec.frames);
    expect(rec.counters).toEqual({ comparisons: 3, writes: 2 });
    expect(copyOf(s, 1, 42)).toEqual({ value: 10, version: 1 });
    expect(copyOf(s, 0, 42)).toEqual({ value: 11, version: 2 });
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toMatch(/succeeded/);
    expect(last.message).toMatch(/R2 missed it/);
    const quorum = rec.frames.find((f) => f.compare?.right === 'W 2')!;
    expect(quorum.compare).toMatchObject({ left: 'acks 2', op: '≥' });
    // The magenta key is the row label for 42, and the chip carries 42 all the way.
    expect(rec.frames.every((f) => f.probe?.text === '42')).toBe(true);
    expect(rec.frames[0].scene.nodes.find((n) => n.id === 'k42')!.tone).toBe('key');
    expect(staleCopies(s)).toBe(1);
  });

  it('a failed write is not rolled back', () => {
    const s = create(3, 2, 2);
    write(s, 42, 10, quiet(s));
    down(s, 1, quiet(s));
    down(s, 2, quiet(s));
    const rec = loud(s);
    expect(write(s, 42, 12, rec)).toBe(false);
    checkFrames(rec.frames);
    expect(rec.counters).toEqual({ comparisons: 2, writes: 1, failed: 1 });
    expect(copyOf(s, 2, 42)).toEqual({ value: 12, version: 2 });
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/not rolled back/);
    expect(s.latest[42]).toBe(1);
    // A later read with everything back can return the value of the failed write.
    up(s, 1, quiet(s));
    up(s, 2, quiet(s));
    expect(read(s, 42, 3, quiet(s))).toEqual({ value: 12, version: 2 });
  });

  it('a new key that no replica stored leaves no row behind', () => {
    const s = create(3, 1, 1);
    for (const i of [1, 2, 3]) down(s, i, quiet(s));
    const rec = loud(s);
    expect(write(s, 9, 1, rec)).toBe(false);
    expect(s.keys).toEqual([]);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/nothing changed/);
  });

  it('read repair fixes only the replicas that answered, and only the key read', () => {
    const s = create(3, 2, 2);
    write(s, 17, 20, quiet(s));
    write(s, 5, 30, quiet(s));
    down(s, 3, quiet(s));
    write(s, 17, 21, quiet(s));
    write(s, 5, 31, quiet(s));
    up(s, 3, quiet(s));
    down(s, 2, quiet(s));
    const rec = loud(s);
    expect(read(s, 17, 3, rec)).toEqual({ value: 21, version: 3 });
    checkFrames(rec.frames);
    expect(copyOf(s, 2, 17)).toEqual({ value: 21, version: 3 });
    expect(copyOf(s, 2, 5)).toEqual({ value: 30, version: 2 });
    expect(rec.counters).toEqual({ comparisons: 4, reads: 2, writes: 1, repairs: 1 });
    const newest = rec.frames.find((f) => f.lines?.includes('newest'))!;
    expect(newest.compare).toMatchObject({ left: 'R1 v3', op: '>', right: 'R3 v1' });
  });

  it('with R + W ≤ N a read can be stale, and says why', () => {
    const s = create(3, 2, 2);
    write(s, 5, 30, quiet(s));
    down(s, 3, quiet(s));
    write(s, 5, 31, quiet(s));
    up(s, 3, quiet(s));
    const t = loud(s);
    expect(tune(s, 1, 1, t)).toBe(false);
    expect(t.frames[t.frames.length - 1].compare).toMatchObject({ left: 'R + W = 2', op: '≤', right: 'N 3' });
    const rec = loud(s);
    expect(read(s, 5, 3, rec)).toEqual({ value: 30, version: 1 });
    checkFrames(rec.frames);
    expect(rec.counters.stale).toBe(1);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/stale read.*R \+ W = 1 \+ 1 = 2, not more than N = 3/);
    // With R = 2 the same read cannot miss it.
    tune(s, 1, 2, quiet(s));
    expect(read(s, 5, 3, quiet(s))).toEqual({ value: 31, version: 2 });
  });

  it('anti-entropy copies the newer version each way', () => {
    const s = create(3, 1, 1);
    write(s, 5, 1, quiet(s));
    write(s, 17, 2, quiet(s));
    down(s, 1, quiet(s));
    write(s, 5, 3, quiet(s));
    up(s, 1, quiet(s));
    down(s, 2, quiet(s));
    write(s, 17, 4, quiet(s));
    up(s, 2, quiet(s));
    const rec = loud(s);
    expect(repair(s, 1, 2, rec)).toBe(2);
    checkFrames(rec.frames);
    expect(copyOf(s, 0, 5)).toEqual(copyOf(s, 1, 5));
    expect(copyOf(s, 0, 17)).toEqual(copyOf(s, 1, 17));
    expect(copyOf(s, 0, 5).version).toBe(newestVersion(s, 5));
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/Merkle tree/);
  });

  it('answers bad input without changing anything', () => {
    const s = def.create({ n: 3, w: 2, r: 2 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    const before = JSON.stringify(s);
    const runs: ((rec: Recorder<QuorumState>) => unknown)[] = [
      (rec) => down(s, 4, rec),
      (rec) => up(s, 1, rec),
      (rec) => down(s, 2, rec),
      (rec) => repair(s, 1, 1, rec),
      (rec) => repair(s, 1, 2, rec),
      (rec) => tune(s, 4, 1, rec),
      (rec) => read(s, 5, 9, rec),
      (rec) => read(s, 99, 1, rec),
      (rec) => write(s, 99, 1, rec),
      (rec) => write(s, 1000, 1, rec),
    ];
    for (const run of runs) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
  });

  it('every operation has a listing in both languages with the anchors its frames name', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) for (const line of listing(def.source![lang], lang, op.code!).lines) expect(line.length, line).toBeLessThanOrEqual(80);
    }
    for (const params of [{ n: 3, w: 2, r: 2 }, { n: 5, w: 2, r: 2 }, { n: 3, w: 3, r: 1 }, { n: 5, w: 3, r: 3 }, { n: 3, w: 1, r: 1 }]) {
      const s = def.create(params);
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[], recording: boolean) => {
        const rec = new Recorder(s, def.layout, recording);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        checkFrames(rec.frames);
      };
      for (const [id, ...args] of def.seed) run(id, args, false);
      for (const [id, ...args] of def.tour) run(id, args, true);
      for (let round = 0; round < 40; round++) for (const op of def.ops) run(op.id, op.suggest!(s), true);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
      verify(s);
    }
  });

  it('seed and tour tell the story in order', () => {
    const s = def.create({ n: 3, w: 2, r: 2 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    expect(s.keys).toEqual([5, 17, 42]);
    expect(s.up).toEqual([true, false, true]);
    expect(staleCopies(s)).toBe(2);
    const recs = def.tour.map(([id, ...args]) => {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
      verify(s);
      return rec;
    });
    const last = (i: number) => recs[i].frames[recs[i].frames.length - 1];
    // 1. A write with R2 down still succeeds.
    expect(last(0).message).toMatch(/succeeded.*R2 missed it/);
    expect(recs[0].counters.failed).toBeUndefined();
    // 2. A read finds R3 stale on 17 and repairs it.
    expect(recs[1].counters.repairs).toBe(1);
    expect(copyOf(s, 2, 17).value).toBe(21);
    // 3, 4. W = 1, R = 1 and a stale read of 5.
    expect(last(2).compare?.op).toBe('≤');
    expect(recs[3].counters.stale).toBe(1);
    expect(last(3).message).toMatch(/This is a stale read/);
    // 5, 6, 7. Back to 2 and 2, R1 down too, and the write fails but stays on R3.
    expect(last(4).compare?.op).toBe('>');
    expect(recs[6].counters.failed).toBe(1);
    expect(last(6).message).toMatch(/not rolled back/);
    expect(copyOf(s, 2, 42).value).toBe(12);
    expect(def.status!(s)).toEqual([
      { label: 'Quorums', value: 'N 3, W 2, R 2' },
      { label: 'R + W > N', value: 'yes, 4 > 3' },
      { label: 'Replicas up', value: '1 of 3' },
      { label: 'Stale copies', value: '3' },
    ]);
  });

  it('the seed and the tour run for every parameter choice', () => {
    for (const n of [3, 5]) for (const w of [1, 2, 3]) for (const r of [1, 2, 3]) {
      const s = def.create({ n, w, r });
      for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
      expect(s.keys).toEqual([5, 17, 42]);
      for (const [id, ...args] of def.tour) {
        const rec = loud(s);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        checkFrames(rec.frames);
        expect(rec.frames.some((f) => /Sorry/.test(f.message))).toBe(false);
      }
    }
  });

  it('suggests arguments the form accepts', () => {
    const s = def.create({ n: 5, w: 2, r: 2 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    for (let i = 0; i < 80; i++) {
      for (const op of def.ops) {
        const args = op.suggest!(s);
        expect(args.length).toBe(op.args.length);
        op.args.forEach((a, j) => {
          expect(Number.isInteger(args[j])).toBe(true);
          expect(args[j] as number).toBeGreaterThanOrEqual(a.min ?? 0);
          expect(args[j] as number).toBeLessThanOrEqual(a.max ?? 999);
        });
        op.run(s, args, quiet(s));
      }
      verify(s);
    }
  });
});
