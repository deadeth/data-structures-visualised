import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  IDS,
  ROWS,
  abort,
  begin,
  commit,
  create,
  latest,
  layout,
  onCall,
  read,
  retry,
  waitsFor,
  write,
  writeSkew,
  type Method,
  type Txn,
  type TxState,
} from './index';

const quiet = (s: TxState) => new Recorder(s, layout, false);
const loud = (s: TxState) => new Recorder(s, layout, true);

/** Is there an order of the committed transactions that explains every read and the final table? */
function serializable(committed: { reads: Record<string, number>; writes: Record<string, number> }[], final: Record<string, number>): boolean {
  const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  for (const order of perms(committed.map((_, i) => i))) {
    const state: Record<string, number> = { alice: 1, bob: 1 };
    let ok = true;
    for (const i of order) {
      const tx = committed[i];
      if (Object.entries(tx.reads).some(([r, v]) => state[r] !== v)) {
        ok = false;
        break;
      }
      Object.assign(state, tx.writes);
    }
    if (ok && ROWS.every((r) => state[r] === final[r])) return true;
  }
  return false;
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, real probe targets, a code line on every frame, magenta only on the followed transaction, nothing overlapping. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    expect(f.lines?.length ?? 0, f.message).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—|\[object/);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
      expect(f.probe.text).toMatch(/^T[123]$/);
    }
    if (f.compare) expect(f.probe, `comparison without a probe: ${f.message}`).toBeDefined();
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    for (const e of f.scene.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
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

/** Random work against one fresh table. Returns what happened, checking the invariants as it goes. */
function episode(method: Method, rnd: () => number, recording: boolean, frames?: Frame[][]) {
  const s = create(method);
  const instances: Txn[] = [];
  const steps = 5 + Math.floor(rnd() * 36);
  const rec = () => (recording ? loud(s) : quiet(s));
  const counters: Record<string, number>[] = [];
  for (let k = 0; k < steps; k++) {
    const t = 1 + Math.floor(rnd() * 3);
    const tx = s.txns[t];
    const op = rnd();
    const r = rec();
    const open = tx && (tx.status === 'active' || tx.status === 'waiting');
    if (!open) {
      if (instances.length >= 6) continue;
      if (op < 0.2) retry(s, t, r);
      else expect(begin(s, t, r)).toBe(true);
      instances.push(s.txns[t]!);
    } else if (tx.status === 'waiting') {
      if (op < 0.1) abort(s, t, r);
      else expect(read(s, t, 'alice', r)).toBeNull();
    } else {
      const row = ROWS[Math.floor(rnd() * 2)];
      if (op < 0.35) read(s, t, row, r);
      else if (op < 0.6) write(s, t, row, Math.floor(rnd() * 2), r);
      else if (op < 0.9) commit(s, t, r);
      else abort(s, t, r);
    }
    counters.push({ ...r.counters });
    if (recording) {
      expect(r.frames.length).toBeGreaterThan(0);
      expect(r.frames[r.frames.length - 1].counters).toEqual(r.counters);
      frames?.push(r.frames);
    } else expect(r.frames.length).toBe(0);
    if (method === '2PL') {
      for (const row of ROWS) {
        const lock = s.locks[row];
        if (lock.exclusive !== null) expect(lock.shared.filter((u) => u !== lock.exclusive)).toEqual([]);
        for (const q of lock.queue) expect(s.txns[q.id]!.status).toBe('waiting');
      }
      // Every wait that closed a cycle was broken at once.
      for (const i of IDS) {
        const seen = new Set<number>();
        const stack = waitsFor(s, i);
        while (stack.length) {
          const u = stack.pop()!;
          expect(u).not.toBe(i);
          if (!seen.has(u)) {
            seen.add(u);
            stack.push(...waitsFor(s, u));
          }
        }
      }
    } else {
      expect(IDS.some((i) => s.txns[i]?.status === 'waiting')).toBe(false);
    }
  }
  for (const i of IDS) if (s.txns[i] && (s.txns[i]!.status === 'active' || s.txns[i]!.status === 'waiting')) abort(s, i, quiet(s));
  const committed = instances.filter((tx) => tx.status === 'committed').map((tx) => ({ reads: { ...tx.reads } as Record<string, number>, writes: { ...tx.writes } as Record<string, number> }));
  const final = Object.fromEntries(ROWS.map((r) => [r, latest(s, r)]));
  return { s, committed, final, counters };
}

describe('serializability: 2PL and SSI', () => {
  for (const method of ['2PL', 'SSI'] as const) {
    it(`${method}: every history of committed transactions matches some serial order`, () => {
      const rnd = makeRng(method === '2PL' ? 17 : 29);
      let commits = 0;
      let aborted = 0;
      for (let e = 0; e < 1500; e++) {
        const { s, committed, final } = episode(method, rnd, false);
        expect(serializable(committed, final), `episode ${e}`).toBe(true);
        commits += s.commits;
        aborted += s.aborts;
      }
      expect(commits).toBeGreaterThan(2000);
      expect(aborted).toBeGreaterThan(500);
    });

    it(`${method}: counts the same with recording on and off, and every frame is well formed`, () => {
      for (let e = 0; e < 60; e++) {
        const a = episode(method, makeRng(1000 + e), true, []);
        const b = episode(method, makeRng(1000 + e), false);
        expect(a.counters).toEqual(b.counters);
        expect(a.final).toEqual(b.final);
      }
      const frames: Frame[][] = [];
      for (let e = 0; e < 25; e++) episode(method, makeRng(5000 + e), true, frames);
      for (const f of frames) checkFrames(f);
    });
  }

  it('plain snapshot isolation would let write skew through: the model check is not vacuous', () => {
    // Both doctors read 2 on call from the same snapshot and both go off.
    const t1 = { reads: { alice: 1, bob: 1 }, writes: { alice: 0 } };
    const t2 = { reads: { alice: 1, bob: 1 }, writes: { bob: 0 } };
    expect(serializable([t1, t2], { alice: 0, bob: 0 })).toBe(false);
    expect(serializable([t1], { alice: 0, bob: 1 })).toBe(true);
  });
});

describe('two-phase locking', () => {
  it('write skew deadlocks, the cycle check finds it edge by edge, and the victim is aborted', () => {
    const s = create('2PL');
    const rec = loud(s);
    writeSkew(s, '2PL', rec);
    checkFrames(rec.frames);
    expect(s.txns[2]!.status).toBe('aborted');
    expect(s.txns[2]!.why).toBe('deadlock victim');
    expect(s.txns[1]!.status).toBe('active');
    expect(s.txns[1]!.writes).toEqual({ alice: 0 });
    expect(s.locks.alice).toEqual({ shared: [], exclusive: 1, queue: [] });
    expect(s.locks.bob).toEqual({ shared: [1], exclusive: null, queue: [] });
    expect(rec.counters.waits).toBe(2);
    expect(rec.counters.aborts).toBe(1);
    const cycle = rec.frames.filter((f) => f.compare?.left.toString().startsWith('next'));
    expect(cycle.map((f) => f.compare)).toEqual([
      // T1's wait: T1 waits for T2, and T2 waits for no one.
      { left: 'next T2', op: '≠', right: 'start T1', verdict: 'follow T2' },
      // T2's wait closes the loop.
      { left: 'next T1', op: '≠', right: 'start T2', verdict: 'follow T1' },
      { left: 'next T2', op: '=', right: 'start T2', verdict: 'back at the start: deadlock' },
    ]);
    expect(rec.frames.some((f) => /^Deadlock: T2 waits for T1 waits for T2/.test(f.message))).toBe(true);

    const c = loud(s);
    expect(commit(s, 1, c)).toBe(true);
    checkFrames(c.frames);
    expect(onCall(s)).toEqual(['bob']);
    expect(c.frames[c.frames.length - 1].message).toMatch(/On call: Bob\. The rule "at least one doctor on call" holds\./);
    expect(s.locks.alice).toEqual({ shared: [], exclusive: null, queue: [] });

    const r = loud(s);
    expect(retry(s, 2, r)).toBe(true);
    checkFrames(r.frames);
    expect(s.txns[2]!.writes).toEqual({});
    expect(r.frames.find((f) => f.compare?.left === 'T2 saw 1 on call')!.compare!.op).toBe('<');
    expect(onCall(s)).toEqual(['bob']);
  });

  it('a wait with no cycle just waits, and the commit that frees the lock finishes the waiting read', () => {
    const s = create('2PL');
    begin(s, 1, quiet(s));
    begin(s, 3, quiet(s));
    write(s, 1, 'alice', 0, quiet(s));
    const rec = loud(s);
    expect(read(s, 3, 'alice', rec)).toBeNull();
    checkFrames(rec.frames);
    expect(s.txns[3]!.status).toBe('waiting');
    expect(rec.frames.some((f) => f.lines!.includes('acyclic'))).toBe(true);
    // Blocked transactions can do nothing else.
    expect(write(s, 3, 'bob', 0, quiet(s))).toBe(false);
    const c = loud(s);
    commit(s, 1, c);
    checkFrames(c.frames);
    expect(s.txns[3]!.status).toBe('active');
    // It reads the value T1 committed, never the one before it.
    expect(s.txns[3]!.reads).toEqual({ alice: 0 });
    expect(c.frames.some((f) => f.lines!.includes('resume'))).toBe(true);
  });

  it('locks are released only at the end', () => {
    const s = create('2PL');
    begin(s, 1, quiet(s));
    read(s, 1, 'alice', quiet(s));
    read(s, 1, 'bob', quiet(s));
    write(s, 1, 'bob', 0, quiet(s));
    expect(s.locks.alice.shared).toEqual([1]);
    expect(s.locks.bob.exclusive).toBe(1);
    abort(s, 1, quiet(s));
    expect(s.locks.alice.shared).toEqual([]);
    expect(s.locks.bob.exclusive).toBeNull();
    expect(onCall(s)).toEqual(['alice', 'bob']);
  });
});

describe('serializable snapshot isolation', () => {
  it('nobody blocks, the first committer wins and the second fails its check', () => {
    const s = create('SSI');
    const rec = loud(s);
    writeSkew(s, 'SSI', rec);
    checkFrames(rec.frames);
    expect(rec.counters.waits ?? 0).toBe(0);
    expect(s.txns[1]!.stale.map((m) => [m.row, m.by.id])).toEqual([['bob', 2]]);
    expect(s.txns[2]!.stale.map((m) => [m.row, m.by.id])).toEqual([['alice', 1]]);

    const c1 = loud(s);
    expect(commit(s, 1, c1)).toBe(true);
    checkFrames(c1.frames);
    expect(c1.frames.find((f) => f.compare)!.compare).toEqual({ left: 'Bob: T2 active', op: '≠', right: 'committed', verdict: 'harmless so far' });

    const c2 = loud(s);
    expect(commit(s, 2, c2)).toBe(false);
    checkFrames(c2.frames);
    expect(c2.frames.find((f) => f.compare)!.compare).toEqual({ left: 'Alice: T1 committed', op: '=', right: 'committed', verdict: 'stale read: abort T2' });
    expect(s.txns[2]!.status).toBe('aborted');
    expect(onCall(s)).toEqual(['bob']);

    const r = loud(s);
    expect(retry(s, 2, r)).toBe(true);
    checkFrames(r.frames);
    expect(s.txns[2]!.snapshot).toBe(1);
    expect(s.txns[2]!.reads).toEqual({ alice: 0, bob: 1 });
    expect(onCall(s)).toEqual(['bob']);
  });

  it('a snapshot skips versions committed after it began, and notes them as stale', () => {
    const s = create('SSI');
    begin(s, 3, quiet(s));
    begin(s, 1, quiet(s));
    write(s, 1, 'alice', 0, quiet(s));
    commit(s, 1, quiet(s));
    const rec = loud(s);
    expect(read(s, 3, 'alice', rec)).toBe(1);
    checkFrames(rec.frames);
    expect(rec.frames.filter((f) => f.compare).map((f) => f.compare!.op)).toEqual(['>', '≤']);
    expect(s.txns[3]!.stale.map((m) => m.by.id)).toEqual([1]);
    // A transaction that only read can still be refused: its view was out of date.
    expect(commit(s, 3, quiet(s))).toBe(false);
  });
});

describe('definition', () => {
  it('seed and tour run through the definition: deadlock under 2PL, abort at commit under SSI, both retried', () => {
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    for (const params of [{ method: 0 }, { method: 1 }]) {
      const s = def.create(params);
      const run = (id: string, args: (number | string)[], recording: boolean) => {
        const op = def.ops.find((o) => o.id === id)!;
        const rec = new Recorder(s, def.layout, recording);
        op.run(s, args, rec);
        return rec;
      };
      for (const [id, ...args] of def.seed) {
        const rec = run(id, args, true);
        expect(rec.frames.length).toBeGreaterThan(0);
      }
      const used = new Map<string, Set<string>>();
      const outcomes: string[] = [];
      for (const [id, ...args] of def.tour) {
        const rec = run(id, args, true);
        checkFrames(rec.frames);
        const set = used.get(id) ?? new Set<string>();
        for (const f of rec.frames) for (const a of f.lines!) set.add(a);
        used.set(id, set);
        outcomes.push(`${s.method} ${IDS.map((i) => s.txns[i]?.status ?? '-').join(' ')} ${onCall(s).join(',')}`);
      }
      expect(outcomes).toEqual([
        '2PL active aborted - alice,bob',
        '2PL committed aborted - bob',
        '2PL committed committed - bob',
        'SSI active active - alice,bob',
        'SSI committed active - bob',
        'SSI committed aborted - bob',
        'SSI committed committed - bob',
      ]);
      // A dozen rounds of suggestions from here must also be well formed and name real code.
      for (let round = 0; round < 12; round++) {
        for (const op of def.ops) {
          const rec = run(op.id, op.suggest?.(s) ?? [], true);
          checkFrames(rec.frames);
          const set = used.get(op.id) ?? new Set<string>();
          for (const f of rec.frames) for (const a of f.lines!) set.add(a);
          used.set(op.id, set);
        }
      }
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });

  it('listings fit the panel and every op has one in both languages', () => {
    for (const op of def.ops) {
      for (const { id } of LANGS) {
        const l = listing(def.source![id], id, op.code!);
        expect(l.anchors.size).toBeGreaterThan(0);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
  });

  it('turns away bad arguments politely, with a frame', () => {
    const s = create('2PL');
    for (const [fn, expected] of [
      [(r: Recorder<TxState>) => read(s, 1, 'alice', r), /has not begun/],
      [(r: Recorder<TxState>) => begin(s, 7, r), /no T7/],
      [(r: Recorder<TxState>) => commit(s, 2, r), /has not begun/],
      [(r: Recorder<TxState>) => retry(s, 4, r), /no T4/],
    ] as const) {
      const rec = loud(s);
      fn(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(expected);
      checkFrames(rec.frames);
    }
    begin(s, 1, quiet(s));
    const rec = loud(s);
    expect(read(s, 1, 'carol', rec)).toBeNull();
    expect(rec.frames[0].message).toMatch(/no doctor called "carol"/);
    const again = loud(s);
    expect(begin(s, 1, again)).toBe(false);
    expect(again.frames[0].message).toMatch(/already open/);
  });
});
