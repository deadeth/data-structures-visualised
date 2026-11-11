import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, OpDef, Scene } from '../../core/types';
import def, {
  MAX_ACTIVE,
  MAX_VERSIONS,
  T,
  abort,
  active,
  begin,
  commit,
  create,
  dead,
  latest,
  layout,
  play,
  read,
  reset,
  setLevel,
  shownTxns,
  vacuum,
  write,
  type Level,
  type MvccState,
  type Outcome,
} from './index';

const quiet = (s: MvccState) => new Recorder(s, layout, false);
const loud = (s: MvccState) => new Recorder(s, layout, true);

/** The plainest correct model: snapshot isolation reads a copy of the committed data taken at begin; read committed reads the latest commit. */
class Model {
  committed: Record<string, number> = {};
  seq = 0;
  last: Record<string, number> = {};
  txns = new Map<number, { level: Level; status: string; start: Record<string, number>; startSeq: number; own: Record<string, number>; wants: [string, number] | null }>();
  locks: Record<string, number> = {};
  next = 1;
  constructor(public level: Level, rows: [string, number][]) {
    this.load(rows);
  }
  load(rows: [string, number][]): void {
    this.committed = Object.fromEntries(rows);
    this.last = Object.fromEntries(rows.map(([r]) => [r, 0]));
    this.seq = 0;
    this.txns.clear();
    this.locks = {};
    this.next = 1;
  }
  begin(): number {
    const x = this.next++;
    this.txns.set(x, { level: this.level, status: 'active', start: { ...this.committed }, startSeq: this.seq, own: {}, wants: null });
    return x;
  }
  read(x: number, r: string): number {
    const t = this.txns.get(x)!;
    if (r in t.own) return t.own[r];
    return t.level === 'snapshot' ? t.start[r] : this.committed[r];
  }
  cycle(holder: number | undefined, x: number): boolean {
    while (holder !== undefined) {
      if (holder === x) return true;
      const w = this.txns.get(holder)!.wants;
      holder = w ? this.locks[w[0]] : undefined;
    }
    return false;
  }
  write(x: number, r: string, v: number): Outcome {
    const t = this.txns.get(x)!;
    const h = this.locks[r];
    if (h !== undefined && h !== x) {
      if (this.cycle(h, x)) {
        this.abort(x);
        return 'aborted';
      }
      t.wants = [r, v];
      return 'waiting';
    }
    if (t.level === 'snapshot' && !(r in t.own) && this.last[r] > t.startSeq) {
      this.abort(x);
      return 'aborted';
    }
    this.locks[r] = x;
    t.own[r] = v;
    return 'written';
  }
  commit(x: number): void {
    const t = this.txns.get(x)!;
    t.status = 'committed';
    this.seq++;
    for (const [r, v] of Object.entries(t.own)) {
      this.committed[r] = v;
      this.last[r] = this.seq;
    }
    this.release(x);
  }
  abort(x: number): void {
    const t = this.txns.get(x)!;
    t.status = 'aborted';
    t.wants = null;
    this.release(x);
  }
  release(x: number): void {
    const freed = Object.keys(this.locks).filter((r) => this.locks[r] === x);
    for (const r of freed) delete this.locks[r];
    for (const y of [...this.txns.keys()].sort((a, b) => a - b)) {
      const w = this.txns.get(y)!;
      if (w.wants && freed.includes(w.wants[0])) {
        const [r, v] = w.wants;
        w.wants = null;
        this.write(y, r, v);
      }
    }
  }
}

function checkAgainst(s: MvccState, m: Model): void {
  for (const [x, t] of m.txns) {
    expect(s.txns[x].status).toBe(t.status);
    expect(s.txns[x].wants !== null).toBe(t.wants !== null);
  }
  expect(s.locks).toEqual(m.locks);
  for (const r of s.order) {
    expect(latest(s, r)).toBe(m.committed[r]);
    // The chains stay within what the page can draw.
    expect(s.rows[r].length).toBeLessThanOrEqual(MAX_VERSIONS);
    // Exactly one version per row is the newest live one: no xmax from a committed transaction.
    expect(s.rows[r].filter((v) => s.txns[v.xmin].status === 'committed' && (v.xmax === null || s.txns[v.xmax].status !== 'committed')).length).toBe(1);
  }
  expect(active(s).length).toBeLessThanOrEqual(MAX_ACTIVE);
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Ids unique, probes on real nodes, a code line on every frame, magenta only on the followed transaction, nothing overlapping. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = f.scene.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(f.message).not.toMatch(/undefined|NaN|null|\[object|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.probe) {
      expect(ids, `probe at ${f.probe.at}: ${f.message}`).toContain(f.probe.at);
      expect(f.probe.text).toMatch(/^T\d+$/);
    }
    if (f.compare) expect(f.probe, `compare without a probe: ${f.message}`).toBeDefined();
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      if (n.tone === 'key') {
        expect(f.probe, 'magenta with nothing followed').toBeDefined();
        expect(n.id).toBe(`t${f.probe!.text.slice(1)}`);
      }
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    const edge = corners(f.scene);
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

function randomRun(seed: number, level: Level, steps: number, onFrames?: (f: Frame[]) => void) {
  const rnd = makeRng(seed);
  const s = create(level);
  const m = new Model(level, [['a', 50], ['b', 50]]);
  const tally = { written: 0, waiting: 0, aborted: 0, vacuumed: 0, reads: 0 };
  const recFor = () => (onFrames ? loud(s) : quiet(s));
  const done = (rec: Recorder<MvccState>) => onFrames?.(rec.frames);
  for (let i = 0; i < steps; i++) {
    const running = active(s).map((t) => t.xid);
    const free = running.filter((x) => !s.txns[x].wants);
    const roll = rnd();
    const rec = recFor();
    const any = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    if (roll < 0.15) {
      const x = begin(s, rec);
      if (running.length < MAX_ACTIVE) expect(x).toBe(m.begin());
      else expect(x).toBeNull();
    } else if (roll < 0.4 && free.length) {
      const x = any(free);
      const r = any(s.order);
      expect(read(s, x, r, rec)).toBe(m.read(x, r));
      tally.reads++;
    } else if (roll < 0.65 && free.length) {
      const x = any(free);
      const r = any(s.order);
      const v = Math.floor(rnd() * 1000);
      const room = s.rows[r].length + 1 + s.txns.filter((t) => t.wants?.row === r).length <= MAX_VERSIONS;
      const got = write(s, x, r, v, rec);
      if (!room) expect(got).toBeNull();
      else {
        const want = m.write(x, r, v);
        expect(got).toBe(want);
        tally[want]++;
      }
    } else if (roll < 0.78 && free.length) {
      const x = any(free);
      expect(commit(s, x, rec)).toBe(true);
      m.commit(x);
    } else if (roll < 0.84 && running.length) {
      const x = any(running);
      expect(abort(s, x, rec)).toBe(true);
      m.abort(x);
    } else if (roll < 0.94) {
      const before = free.flatMap((x) => s.order.map((r) => [x, r, m.read(x, r)] as const));
      tally.vacuumed += vacuum(s, rec);
      for (const [x, r, v] of before) expect(read(s, x, r, quiet(s))).toBe(v);
      if (!active(s).length) for (const r of s.order) expect(s.rows[r].length).toBe(1);
      expect(vacuum(s, quiet(s))).toBe(0);
    } else if (roll < 0.98) {
      const lv: Level = rnd() < 0.5 ? 'rc' : 'snapshot';
      expect(setLevel(s, lv, rec)).toBe(true);
      m.level = lv;
    } else {
      expect(reset(s, 'bank', rec)).toBe(true);
      m.load([['a', 50], ['b', 50]]);
    }
    done(rec);
    checkAgainst(s, m);
  }
  return tally;
}

describe('isolation levels and MVCC', () => {
  for (const level of ['snapshot', 'rc'] as const) {
    it(`matches a copy-the-database model through random operations (${level})`, () => {
      const total = { written: 0, waiting: 0, aborted: 0, vacuumed: 0, reads: 0 };
      for (let seed = 1; seed <= 8; seed++) {
        const t = randomRun(seed * 17 + (level === 'rc' ? 1 : 0), level, 600);
        for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += t[k];
      }
      // The runs reach every path: waits, aborts, vacuum.
      expect(total.waiting).toBeGreaterThan(20);
      expect(total.aborted).toBeGreaterThan(3);
      expect(total.vacuumed).toBeGreaterThan(50);
      expect(total.reads).toBeGreaterThan(500);
    });
  }

  it('keeps every frame well formed through random operations', () => {
    let frames = 0;
    randomRun(5, 'snapshot', 300, (f) => {
      checkFrames(f);
      frames += f.length;
    });
    randomRun(6, 'rc', 300, (f) => {
      checkFrames(f);
      frames += f.length;
    });
    expect(frames).toBeGreaterThan(1000);
  });

  it('counts the same with recording on and off', () => {
    for (const [sc, level] of [['readskew', 'rc'], ['lostupdate', 'snapshot'], ['writeskew', 'snapshot'], ['lostupdate', 'rc']] as const) {
      const a = create(level);
      const b = create(level);
      const on = loud(a);
      const off = quiet(b);
      play(a, sc, on);
      play(b, sc, off);
      expect(on.counters).toEqual(off.counters);
      expect(a).toEqual(b);
      checkFrames(on.frames);
    }
  });

  it('read skew: read committed sees 70 of 100, snapshot isolation sees 100, and neither sees a dirty value', () => {
    for (const level of ['rc', 'snapshot'] as const) {
      const s = create(level);
      const rec = loud(s);
      play(s, 'readskew', rec);
      const t2 = s.txns[2];
      expect(Object.fromEntries(t2.seen)).toEqual(level === 'rc' ? { a: 50, b: 20 } : { a: 50, b: 50 });
      // The dirty 80 was looked at and refused.
      expect(rec.frames.some((f) => f.compare?.left === 'xmin T1: active' && f.compare.verdict.includes('no dirty read'))).toBe(true);
      const end = rec.frames[rec.frames.length - 1].message;
      expect(end).toMatch(level === 'rc' ? /70, yet 100.*read skew/ : /100, the right total/);
      if (level === 'snapshot') {
        // B's new version was skipped because T1 was in progress at T2's snapshot.
        expect(rec.frames.some((f) => f.compare?.left === 'xmin T1' && f.compare.right === 'in progress: T1')).toBe(true);
      }
      expect(latest(s, 'a') + latest(s, 'b')).toBe(100);
    }
  });

  it('lost update: read committed loses a deposit, snapshot isolation aborts and the retry keeps both', () => {
    const rc = create('rc');
    play(rc, 'lostupdate', quiet(rc));
    expect(latest(rc, 'a')).toBe(70);
    expect(rc.txns.map((t) => t.status)).toEqual(['committed', 'committed', 'committed']);

    const si = create('snapshot');
    const rec = loud(si);
    play(si, 'lostupdate', rec);
    expect(latest(si, 'a')).toBe(80);
    expect(si.txns.map((t) => t.status)).toEqual(['committed', 'committed', 'aborted', 'committed']);
    expect(rec.counters.aborts).toBe(1);
    expect(rec.frames.some((f) => f.lines?.includes('first_wins'))).toBe(true);
    // T2 waited for T1's lock first, then was woken and refused.
    expect(rec.frames.some((f) => f.lines?.includes('wait'))).toBe(true);
    expect(rec.frames.some((f) => f.lines?.includes('waiter'))).toBe(true);
  });

  it('write skew slips through both levels: nobody is left on call', () => {
    for (const level of ['rc', 'snapshot'] as const) {
      const s = create(level);
      const rec = loud(s);
      play(s, 'writeskew', rec);
      expect(latest(s, 'alice') + latest(s, 'bob')).toBe(0);
      expect(rec.counters.aborts ?? 0).toBe(0);
      expect(rec.frames[rec.frames.length - 1].message).toMatch(/serializable/i);
    }
  });

  it('finds a deadlock and aborts the transaction that would close the circle', () => {
    const s = create('rc');
    const q = () => quiet(s);
    begin(s, q());
    begin(s, q());
    expect(write(s, 1, 'a', 1, q())).toBe('written');
    expect(write(s, 2, 'b', 2, q())).toBe('written');
    expect(write(s, 1, 'b', 3, q())).toBe('waiting');
    const rec = loud(s);
    expect(write(s, 2, 'a', 4, rec)).toBe('aborted');
    checkFrames(rec.frames);
    expect(rec.frames.some((f) => f.lines?.includes('deadlock'))).toBe(true);
    // T2's abort freed B, so T1's write went in.
    expect(s.txns[1].wants).toBeNull();
    expect(s.rows.b[0]).toMatchObject({ value: 3, xmin: 1 });
    expect(s.rows.b[1]).toMatchObject({ value: 2, xmin: 2 });
    expect(dead(s, s.rows.b[1])).toBe(true);
  });

  it('a long snapshot holds vacuum back, and its end lets vacuum finish', () => {
    const s = create('snapshot');
    const q = () => quiet(s);
    const old = begin(s, q())!;
    for (let i = 0; i < 2; i++) {
      const x = begin(s, q())!;
      write(s, x, 'a', 60 + i, q());
      commit(s, x, q());
    }
    expect(s.rows.a.length).toBe(3);
    const rec = loud(s);
    // Even 60, which no snapshot would pick, stays: it was replaced after the old snapshot began.
    expect(vacuum(s, rec)).toBe(0);
    checkFrames(rec.frames);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(new RegExp(`Nothing could go. ${T(old)} still needs`));
    // The old snapshot still reads the original value.
    expect(read(s, old, 'a', q())).toBe(50);
    commit(s, old, q());
    expect(vacuum(s, q())).toBe(2);
    expect(s.rows.a.map((v) => v.value)).toEqual([61]);
  });

  it('answers bad input without changing anything', () => {
    const s = create('snapshot');
    begin(s, quiet(s));
    const snap = JSON.stringify(s);
    for (const run of [
      (rec: Recorder<MvccState>) => read(s, 7, 'a', rec),
      (rec: Recorder<MvccState>) => read(s, 0, 'a', rec),
      (rec: Recorder<MvccState>) => read(s, 1, 'zebra', rec),
      (rec: Recorder<MvccState>) => write(s, 1, 'a', 1000, rec),
      (rec: Recorder<MvccState>) => commit(s, 9, rec),
      (rec: Recorder<MvccState>) => setLevel(s, 'zebra', rec),
      (rec: Recorder<MvccState>) => play(s, 'zebra', rec),
      (rec: Recorder<MvccState>) => reset(s, 'zebra', rec),
    ]) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].lines?.length).toBeGreaterThan(0);
      expect(JSON.stringify(s)).toBe(snap);
    }
  });

  it('every operation has a listing in both languages with the anchors its frames name', () => {
    const find = (id: string) => def.ops.find((o) => o.id === id) as OpDef<MvccState>;
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    for (const level of [0, 1]) {
      const s = def.create({ level });
      for (const [id, ...args] of def.seed) find(id).run(s, args, quiet(s));
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[]) => {
        const rec = loud(s);
        find(id).run(s, args, rec);
        checkFrames(rec.frames);
        const set = used.get(id) ?? new Set<string>();
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        used.set(id, set);
      };
      for (const [id, ...args] of def.tour) run(id, args);
      for (let round = 0; round < 30; round++) for (const op of def.ops) run(op.id, op.suggest?.(s) ?? []);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });

  it('seed and tour run through the definition and tell the story in order', () => {
    const s = def.create({ level: 1 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    // The seed leaves a writer running, so the canvas starts with an uncommitted version.
    expect(s.rows.a[0]).toMatchObject({ value: 80, xmin: 1 });
    expect(s.locks.a).toBe(1);
    const endings: string[] = [];
    let tallest = 0;
    let widest = 0;
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      endings.push(rec.frames[rec.frames.length - 1].message);
      for (const f of rec.frames) {
        const b = sceneBounds(f.scene)!;
        tallest = Math.max(tallest, b.bh);
        widest = Math.max(widest, b.bw);
      }
    }
    expect(endings[1]).toMatch(/read skew/);
    expect(endings[2]).toMatch(/T1's 10 is lost/);
    expect(endings[4]).toMatch(/right total/);
    expect(endings[5]).toMatch(/both deposits count/);
    expect(endings[6]).toMatch(/write skew/);
    expect(widest).toBeLessThanOrEqual(940);
    expect(tallest).toBeLessThanOrEqual(425);
  });

  it('draws the followed transaction and keeps finished ones in the order they ended', () => {
    const s = create('snapshot');
    const q = () => quiet(s);
    for (let i = 0; i < 3; i++) begin(s, q());
    commit(s, 3, q());
    commit(s, 1, q());
    begin(s, q());
    begin(s, q());
    abort(s, 4, q());
    // Running: T2, T5. Ended, newest last: T3, T1, T4. Four slots: T2, T5, T1, T4.
    expect(shownTxns(s).map((t) => t.xid)).toEqual([1, 2, 4, 5]);
  });
});
