import { describe, expect, it } from 'vitest';
import { LANGS, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  ASYNC,
  NAMES,
  SEMI,
  SYNC,
  catchUp,
  create,
  failLeader,
  followers,
  layout,
  lag,
  leaderOf,
  pos,
  read,
  readYourWrites,
  rejoin,
  write,
  type Name,
  type ReplState,
} from './index';

const quiet = (s: ReplState) => new Recorder(s, layout, false);
const loud = (s: ReplState) => new Recorder(s, layout, true);

/** Positions as plain integers over one shared history of write ids: an independent model of the same rules. */
class Model {
  tl: { id: number; key: string; value: number }[] = [];
  pos: Record<Name, number> = { A: 0, B: 0, C: 0 };
  alive: Record<Name, boolean> = { A: true, B: true, C: true };
  held: Record<Name, boolean> = { A: false, B: false, C: false };
  hist: Partial<Record<Name, number[]>> = {};
  leader: Name = 'A';
  syncName: Name | null = 'B';
  semiOff = false;
  wrote = 0;
  seen = 0;
  next = 0;
  constructor(readonly mode: number) {}
  fols(): Name[] {
    return NAMES.filter((n) => n !== this.leader && this.alive[n]);
  }
  syncf(): Name | null {
    const fs = this.fols();
    return fs.includes(this.syncName as Name) ? this.syncName : (fs[0] ?? null);
  }
  value(upto: number, key: string): number | null {
    let v: number | null = null;
    for (const e of this.tl.slice(0, upto)) if (e.key === key) v = e.value;
    return v;
  }
  write(key: string, value: number): number {
    this.tl.push({ id: ++this.next, key, value });
    const n = this.tl.length;
    this.pos[this.leader] = n;
    const need = this.mode === SYNC ? this.fols() : this.mode === SEMI && !this.semiOff && this.syncf() ? [this.syncf()!] : [];
    for (const f of need) {
      if (this.held[f]) this.semiOff = true;
      else this.pos[f] = n;
    }
    this.wrote = n;
    for (const f of this.fols()) if (!this.held[f]) this.pos[f] = n;
    return n;
  }
  fail(): number | null {
    if (!this.fols().length) return null;
    const old = this.leader;
    this.hist[old] = this.tl.map((e) => e.id);
    this.alive[old] = false;
    let best: Name | null = null;
    for (const f of this.fols()) if (best === null || this.pos[f] > this.pos[best]) best = f;
    const lost = this.tl.length - this.pos[best!];
    this.tl = this.tl.slice(0, this.pos[best!]);
    this.leader = best!;
    this.held[best!] = false;
    this.semiOff = false;
    const rest = this.fols();
    this.syncName = rest[0] ?? null;
    for (const f of rest) {
      this.held[f] = false;
      this.pos[f] = this.tl.length;
    }
    return lost;
  }
  rejoin(n: Name): number | null {
    if (this.alive[n]) return null;
    const h = this.hist[n]!;
    let common = 0;
    while (common < Math.min(h.length, this.tl.length) && h[common] === this.tl[common].id) common++;
    this.alive[n] = true;
    this.held[n] = false;
    this.pos[n] = this.tl.length;
    return h.length - common;
  }
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Unique ids, real probe targets, a code line on every frame, nothing overlapping or outside the pinned corners. */
const anchorCache = new Map<string, Set<string>>();
function anchorsFor(ops: string[]): Set<string> {
  const key = ops.join(',');
  let anchors = anchorCache.get(key);
  if (anchors) return anchors;
  anchors = new Set<string>();
  for (const { id } of LANGS) for (const op of def.ops.filter((o) => !ops.length || ops.includes(o.id))) for (const a of listing(def.source![id], id, op.code!).anchors.keys()) anchors.add(a);
  anchorCache.set(key, anchors);
  return anchors;
}

function checkFrames(frames: Frame[], ops: string[] = []): void {
  const anchors = anchorsFor(ops);
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
    }
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const a of f.lines!) expect(anchors.has(a), `anchor ${a}`).toBe(true);
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      // Magenta only on what the chip follows, and never on more than one copy at once.
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    expect(f.scene.nodes.filter((n) => n.tone === 'key').length).toBeLessThanOrEqual(1);
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

function checkInvariants(s: ReplState): void {
  const lead = leaderOf(s);
  expect(lead.alive).toBe(true);
  for (const f of followers(s)) {
    // A follower's log is always a prefix of the leader's, and only a held one is behind.
    expect(f.log).toEqual(lead.log.slice(0, pos(f)));
    if (!f.held) expect(pos(f)).toBe(pos(lead));
  }
  if (s.mode === SYNC) for (const n of NAMES) expect(s.replicas[n].held).toBe(false);
}

describe('single-leader replication', () => {
  for (const mode of [ASYNC, SEMI, SYNC]) {
    it(`agrees with a model of positions over thousands of operations (mode ${mode})`, () => {
      for (const seed of [1, 2]) {
        const rnd = makeRng(seed * 31 + mode);
        const s = create(mode);
        const m = new Model(mode);
        let lostTotal = 0;
        for (let i = 0; i < 2000; i++) {
          const x = rnd();
          const n = NAMES[Math.floor(rnd() * 3)];
          const k = 'xyz'[Math.floor(rnd() * 3)];
          const recording = i % 50 === 0;
          const rec = recording ? loud(s) : quiet(s);
          if (x < 0.35) {
            const v = Math.floor(rnd() * 100);
            expect(write(s, k, v, rec)).toBe(m.write(k, v));
            expect(rec.counters.acked).toBe(1);
          } else if (x < 0.5) {
            const got = read(s, n, k, rec);
            if (!m.alive[n]) expect(got).toBeNull();
            else {
              const want = Math.min(Math.max(m.wrote, m.seen), m.tl.length);
              const p = m.pos[n];
              m.seen = Math.max(m.seen, p);
              expect(got!.value).toBe(m.value(p, k));
              const differs = m.value(p, k) !== m.value(m.tl.length, k);
              expect(got!.stale).toBe(p < want && differs);
              expect(rec.counters.stale ?? 0).toBe(got!.stale ? 1 : 0);
            }
          } else if (x < 0.6) {
            const got = readYourWrites(s, n, k, rec);
            if (!m.alive[n]) expect(got).toBeNull();
            else {
              const r = n !== m.leader && m.pos[n] < m.wrote ? m.leader : n;
              m.seen = Math.max(m.seen, m.pos[r]);
              expect(got).toEqual({ value: m.value(m.pos[r], k), from: r });
            }
          } else if (x < 0.72) {
            const ok = lag(s, n, rec);
            const follower = m.alive[n] && n !== m.leader;
            expect(ok).toBe(follower && mode !== SYNC);
            if (ok) m.held[n] = true;
          } else if (x < 0.82) {
            const sent = catchUp(s, n, rec);
            if (m.alive[n] && n !== m.leader) {
              m.held[n] = false;
              expect(sent).toBe(m.tl.length - m.pos[n]);
              expect(rec.counters.shipped ?? 0).toBe(sent);
              m.pos[n] = m.tl.length;
              if (n === m.syncf()) m.semiOff = false;
            } else expect(sent).toBe(0);
          } else if (x < 0.9) {
            const want = m.fail();
            expect(failLeader(s, rec)).toBe(want);
            if (want) lostTotal += want;
            expect(rec.counters.lost ?? 0).toBe(want ?? 0);
            if (mode === SYNC) expect(want ?? 0).toBe(0);
          } else {
            expect(rejoin(s, n, rec)).toBe(m.rejoin(n));
          }
          if (recording) checkFrames(rec.frames);
          for (const r of NAMES) {
            expect(pos(s.replicas[r])).toBe(m.pos[r]);
            expect(s.replicas[r].alive).toBe(m.alive[r]);
          }
          expect(s.leader).toBe(m.leader);
          expect(s.semiOff).toBe(m.semiOff);
          expect(leaderOf(s).log.map((e) => [e.key, e.value])).toEqual(m.tl.map((e) => [e.key, e.value]));
          checkInvariants(s);
        }
        if (mode !== SYNC) expect(lostTotal).toBeGreaterThan(0);
      }
    }, 60_000);
  }

  it('counts the same with recording on and off', () => {
    const script: [string, ...(number | string)[]][] = [...def.seed, ...def.tour, ['catch_up', 'c'], ['write', 'z', 4], ['fail_leader'], ['rejoin', 'b'], ['read', 'a', 'z']];
    const totals = (recording: boolean) => {
      const s = create(SEMI);
      const sum: Record<string, number> = {};
      for (const [id, ...args] of script) {
        const rec = new Recorder(s, layout, recording);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        for (const [k, v] of Object.entries(rec.counters)) sum[k] = (sum[k] ?? 0) + v;
      }
      return { sum, s };
    };
    const on = totals(true);
    const off = totals(false);
    expect(on.sum).toEqual(off.sum);
    expect(on.s).toEqual(off.s);
  });

  it('tells the tour story: a stale read, its fix, a lost write and a truncation', () => {
    const s = def.create({ mode: SEMI });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    expect(s.replicas.C.held).toBe(true);
    const frames: Frame[] = [];
    const counters: Record<string, number> = {};
    const results: unknown[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      const before = JSON.stringify(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames, [id]);
      frames.push(...rec.frames);
      for (const [k, v] of Object.entries(rec.counters)) counters[k] = (counters[k] ?? 0) + v;
      results.push(before !== JSON.stringify(s));
    }
    expect(counters.stale).toBe(1);
    expect(counters.lost).toBe(1);
    expect(counters.discarded).toBe(1);
    expect(s.leader).toBe('B');
    expect(s.epoch).toBe(2);
    expect(NAMES.map((n) => pos(s.replicas[n]))).toEqual([3, 3, 3]);
    const compares = frames.filter((f) => f.compare).map((f) => `${f.compare!.left} ${f.compare!.op} ${f.compare!.right}: ${f.compare!.verdict}`);
    expect(compares).toEqual([
      'acks 1 ≥ needed 1: answer the client',
      'C pos 2 < want 3: behind: answer anyway',
      'C pos 2 < wrote 3: route to the leader',
      'acks 0 < needed 1: timed out: answer anyway',
      'C pos 2 ≤ B pos 3: keep B',
      'B pos 3 < A pos 4: 1 write lost',
      'A epoch 1 < epoch 2: step down, follow B',
      'A #4 e1 ≠ B has no #4: discard',
      'A #3 e1 = B #3 e1: agree: keep from here',
    ]);
    // Every comparison follows a write or a read.
    for (const f of frames.filter((x) => x.compare)) expect(f.probe).toBeDefined();
    expect(frames.some((f) => /monotonic reads/.test(f.message))).toBe(true);
    expect(frames.some((f) => /split brain/.test(f.message) && /Fencing/.test(f.message))).toBe(true);
  });

  it('never loses an acknowledged write under semi-sync while the synchronous follower keeps up', () => {
    const s = create(SEMI);
    for (let i = 0; i < 5; i++) write(s, 'x', i, quiet(s));
    lag(s, 'c', quiet(s));
    write(s, 'y', 9, quiet(s));
    expect(failLeader(s, quiet(s))).toBe(0);
    expect(s.leader).toBe('B');
    expect(readYourWrites(s, 'c', 'y', quiet(s))).toEqual({ value: 9, from: 'C' });
  });

  it('refuses what it should, with a sentence and a code line', () => {
    const s = create(SYNC);
    write(s, 'x', 1, quiet(s));
    const cases: [string, (number | string)[]][] = [
      ['lag', ['b']],
      ['lag', ['a']],
      ['lag', ['q']],
      ['write', ['xy', 1]],
      ['write', ['x', 500]],
      ['read', ['d', 'x']],
      ['ryw', ['a', '7']],
      ['rejoin', ['a']],
      ['catch_up', ['a']],
    ];
    for (const [id, args] of cases) {
      const before = JSON.stringify(s);
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      checkFrames(rec.frames, [id]);
      expect(JSON.stringify(s)).toBe(before);
    }
    failLeader(s, quiet(s));
    failLeader(s, quiet(s));
    const rec = loud(s);
    expect(failLeader(s, rec)).toBeNull();
    checkFrames(rec.frames, ['fail_leader']);
    expect(read(s, 'a', 'x', quiet(s))).toBeNull();
  });

  it('runs the seed and the tour for every mode, and suggestions keep working', () => {
    for (const mode of [ASYNC, SEMI, SYNC]) {
      const s = def.create({ mode });
      for (const [id, ...args] of def.seedFor!({ mode })) {
        const rec = loud(s);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        // No seed step is a silent no-op.
        expect(rec.frames.some((f) => /Refused|is already held/.test(f.message))).toBe(false);
      }
      for (const [id, ...args] of def.tour) {
        const rec = loud(s);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        checkFrames(rec.frames, [id]);
      }
      const rnd = makeRng(mode + 5);
      for (let i = 0; i < 300; i++) {
        const op = def.ops[Math.floor(rnd() * def.ops.length)];
        const rec = loud(s);
        op.run(s, op.suggest?.(s) ?? [], rec);
        checkFrames(rec.frames, [op.id]);
        checkInvariants(s);
      }
      expect(def.status!(s).length).toBeGreaterThan(1);
    }
  }, 60_000);

  it('keeps the scene inside 940 by 420', () => {
    const s = create(SEMI);
    for (let i = 0; i < 20; i++) write(s, 'x', i, quiet(s));
    const { x1, x2, y1, y2 } = corners(layout(s));
    expect(x2 - x1).toBeLessThanOrEqual(940);
    expect(y2 - y1).toBeLessThanOrEqual(420);
  });
});
