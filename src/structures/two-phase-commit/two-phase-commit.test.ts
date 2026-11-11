import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  commit,
  crashCoordinator,
  crashParticipant,
  create,
  inDoubt,
  label,
  layout,
  recorded,
  recoverCoordinator,
  voteNo,
  type Decision,
  type TpcState,
} from './index';

const quiet = (s: TpcState) => new Recorder(s, layout, false);
const loud = (s: TpcState) => new Recorder(s, layout, true);

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, real probe targets, a code line on every frame, magenta only on the transaction, nothing overlapping. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const e of f.scene.edges) {
      expect(byId.has(e.from) && byId.has(e.to)).toBe(true);
      expect(e.tone).not.toBe('key');
    }
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') {
        expect(n.id).toBe('txn');
        expect(n.cells[0].text).toBe(f.probe?.text);
      }
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
  }
}

/** Atomicity: when nothing is in doubt, every participant agrees with the coordinator on every transaction. */
function verify(s: TpcState, outcomes: Map<number, Decision>, only?: number): void {
  if (only !== undefined) outcomes = new Map([[only, outcomes.get(only)!]]);
  for (const p of s.parts) {
    if (s.coord.up) {
      expect(p.up).toBe(true);
      expect(p.lock).toBeNull();
      expect(inDoubt(p)).toEqual([]);
    }
    for (const [id, out] of outcomes) {
      const mine = p.log.find((e) => e.txn === id && e.kind !== 'prepared')?.kind ?? 'abort';
      expect(mine, `${p.name} on T${id}`).toBe(out);
    }
  }
  for (const [id, out] of outcomes) {
    // A commit is always on the coordinator's log with an end record; an abort may leave no record at all.
    if (out === 'commit') {
      expect(recorded(s, id)).toBe('commit');
      expect(s.coord.log.some((e) => e.kind === 'end' && e.txn === id)).toBe(true);
    } else expect(recorded(s, id) ?? 'abort').toBe('abort');
  }
  if (only === undefined) expect(s.committed + s.aborted).toBe(outcomes.size);
}

describe('two-phase commit', () => {
  for (const n of [2, 3]) {
    it(`keeps every participant in agreement through random operations (${n} participants)`, () => {
      const rnd = makeRng(20261111 + n);
      const s = create(n);
      const outcomes = new Map<number, Decision>();
      let pending: { id: number; out: Decision } | null = null;
      let blockedRuns = 0;
      const who = () => 'abc'[Math.floor(rnd() * n)];
      for (let i = 0; i < 1500; i++) {
        const roll = rnd();
        const last = s.txn;
        const rec = quiet(s);
        if (!s.coord.up) {
          // Everyone is in doubt about the pending transaction and holds its lock.
          for (const p of s.parts) {
            expect(p.state).toBe('prepared');
            expect(p.lock).toBe(pending!.id);
            expect(inDoubt(p)).toEqual([pending!.id]);
          }
          if (roll < 0.4) {
            const before = JSON.stringify(s);
            expect(roll < 0.2 ? commit(s, rec) : voteNo(s, who(), rec)).toBeNull();
            expect(JSON.stringify(s)).toBe(before);
            expect(rec.counters).toEqual({ comparisons: 1 });
            blockedRuns++;
            continue;
          }
          expect(recoverCoordinator(s, rec)).toEqual({ txn: pending!.id, decision: pending!.out });
          outcomes.set(pending!.id, pending!.out);
          pending = null;
        } else if (roll < 0.3) {
          const r = commit(s, rec)!;
          expect(r.decision).toBe('commit');
          outcomes.set(r.txn, 'commit');
          // 4 messages a participant, and 2n + 2 log writes counting the end record.
          expect(rec.counters).toEqual({ comparisons: 1, messages: 4 * n, writes: 2 * n + 2 });
        } else if (roll < 0.5) {
          const r = voteNo(s, who(), rec)!;
          expect(r.decision).toBe('abort');
          outcomes.set(r.txn, 'abort');
        } else if (roll < 0.75) {
          const after = rnd() < 0.5;
          const r = crashParticipant(s, who(), after ? 'after' : 'before', rec)!;
          expect(r.decision).toBe(after ? 'commit' : 'abort');
          outcomes.set(r.txn, r.decision!);
          expect(rec.counters.comparisons).toBe(after ? 3 : 2);
        } else if (roll < 0.9) {
          const logged = rnd() < 0.5;
          const r = crashCoordinator(s, logged ? 'after' : 'before', rec)!;
          expect(r.decision).toBeNull();
          pending = { id: r.txn, out: logged ? 'commit' : 'abort' };
          expect(s.coord.up).toBe(false);
        } else {
          // Recovering a coordinator that is up changes nothing.
          const before = JSON.stringify(s);
          expect(recoverCoordinator(s, rec)).toBeNull();
          expect(JSON.stringify(s)).toBe(before);
        }
        expect(s.msgs).toEqual([]);
        if (outcomes.has(last)) verify(s, outcomes, last);
        if (outcomes.has(s.txn)) verify(s, outcomes, s.txn);
        if (i % 500 === 0) verify(s, outcomes);
      }
      verify(s, outcomes);
      expect(blockedRuns).toBeGreaterThan(50);
      expect(outcomes.size).toBeGreaterThan(700);
    }, 30_000);
  }

  it('commits cleanly: two round trips, then end', () => {
    const s = create(3);
    const rec = loud(s);
    expect(commit(s, rec)).toEqual({ txn: 1, decision: 'commit' });
    checkFrames(rec.frames);
    expect(s.parts.map((p) => p.log)).toEqual(s.parts.map(() => [{ kind: 'prepared', txn: 1 }, { kind: 'commit', txn: 1 }]));
    expect(s.coord.log).toEqual([{ kind: 'commit', txn: 1 }, { kind: 'end', txn: 1 }]);
    const cmp = rec.frames.find((f) => f.compare)!.compare!;
    expect(cmp).toEqual({ left: 'T1: 3 yes', op: '=', right: '3 participants', verdict: 'decide commit' });
    // The transaction is followed from start to finish.
    expect(rec.frames.every((f) => f.probe?.text === 'T1')).toBe(true);
    const last = rec.frames[rec.frames.length - 1].message;
    expect(last).toContain('12 messages and 8 log writes, 7 of them forced');
  });

  it('a no vote aborts everywhere and releases the locks', () => {
    const s = create(3);
    const rec = loud(s);
    expect(voteNo(s, 'B', rec)).toEqual({ txn: 1, decision: 'abort' });
    checkFrames(rec.frames);
    expect(s.parts.map((p) => p.state)).toEqual(['aborted', 'aborted', 'aborted']);
    expect(s.parts.every((p) => p.lock === null)).toBe(true);
    expect(s.parts[1].log).toEqual([{ kind: 'abort', txn: 1 }]);
    expect(s.coord.log).toEqual([{ kind: 'abort', txn: 1 }]);
    expect(rec.frames.find((f) => f.compare)!.compare).toMatchObject({ left: 'T1: 2 yes', op: '<', verdict: 'decide abort' });
    expect(rec.frames.some((f) => f.lines?.includes('no_acks'))).toBe(true);
    // B already aborted: the decision is applied once, not twice.
    expect(rec.frames.some((f) => /writes nothing new/.test(f.message))).toBe(true);
  });

  it('a coordinator crash leaves everyone in doubt, holding locks, until recovery', () => {
    for (const when of ['after', 'before'] as const) {
      const s = create(3);
      const rec = loud(s);
      expect(crashCoordinator(s, when, rec)).toEqual({ txn: 1, decision: null });
      checkFrames(rec.frames);
      expect(s.parts.every((p) => p.state === 'prepared' && p.lock === 1)).toBe(true);
      expect(s.coord.log).toEqual(when === 'after' ? [{ kind: 'commit', txn: 1 }] : []);
      expect(rec.frames[rec.frames.length - 1].message).toMatch(/blocking protocol/);
      // Nothing else can run.
      const stuck = loud(s);
      expect(commit(s, stuck)).toBeNull();
      checkFrames(stuck.frames);
      expect(stuck.frames[0].message).toMatch(/^Sorry/);
      const back = loud(s);
      expect(recoverCoordinator(s, back)).toEqual({ txn: 1, decision: when === 'after' ? 'commit' : 'abort' });
      checkFrames(back.frames);
      expect(back.frames.find((f) => f.compare)!.compare!.right).toBe(when === 'after' ? 'commit, no end' : 'no record');
      verify(s, new Map([[1, when === 'after' ? 'commit' : 'abort']]));
      expect(s.inDoubt).toBeNull();
    }
  });

  it('a participant that crashed after voting yes asks on restart; one that crashed before rolls back', () => {
    const s = create(3);
    const rec = loud(s);
    expect(crashParticipant(s, 'c', 'after', rec)).toEqual({ txn: 1, decision: 'commit' });
    checkFrames(rec.frames);
    const scan = rec.frames.find((f) => f.lines?.includes('scan'))!;
    expect(scan.compare).toMatchObject({ left: 'C log: T1', right: 'prepared' });
    expect(rec.frames.some((f) => f.lines?.includes('late_end'))).toBe(true);
    verify(s, new Map([[1, 'commit']]));

    const rec2 = loud(s);
    expect(crashParticipant(s, 'a', 'before', rec2)).toEqual({ txn: 2, decision: 'abort' });
    checkFrames(rec2.frames);
    expect(rec2.frames.find((f) => f.lines?.includes('scan'))!.compare).toMatchObject({ left: 'A log: T2', right: 'no record' });
    expect(rec2.frames.find((f) => f.lines?.includes('count'))!.compare).toMatchObject({ left: 'T2: 2 yes', op: '<' });
    verify(s, new Map<number, Decision>([[1, 'commit'], [2, 'abort']]));
  });

  it('answers bad arguments without changing anything', () => {
    const s = create(2);
    commit(s, quiet(s));
    const before = JSON.stringify(s);
    const runs: ((rec: Recorder<TpcState>) => unknown)[] = [
      (rec) => voteNo(s, 'c', rec),
      (rec) => voteNo(s, 'zebra', rec),
      (rec) => crashParticipant(s, 'c', 'after', rec),
      (rec) => crashParticipant(s, 'a', 'later', rec),
      (rec) => crashCoordinator(s, 'soon', rec),
    ];
    for (const run of runs) {
      const rec = loud(s);
      expect(run(rec)).toBeNull();
      expect(rec.frames.length).toBe(1);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
    expect(loud(s).recording).toBe(true);
    const r = loud(s);
    voteNo(s, 'c', r);
    expect(r.frames[0].message).toContain('Enter a or b');
  });

  it('counts the same with recording on and off', () => {
    const rnd = makeRng(4242);
    for (const n of [2, 3]) {
      const a = create(n);
      const b = create(n);
      for (let i = 0; i < 300; i++) {
        const on = loud(a);
        const off = quiet(b);
        const roll = rnd();
        const who = 'abc'[Math.floor(rnd() * n)];
        const when = rnd() < 0.5 ? 'before' : 'after';
        if (roll < 0.25) expect(commit(a, on)).toEqual(commit(b, off));
        else if (roll < 0.45) expect(voteNo(a, who, on)).toEqual(voteNo(b, who, off));
        else if (roll < 0.65) expect(crashParticipant(a, who, when, on)).toEqual(crashParticipant(b, who, when, off));
        else if (roll < 0.8) expect(crashCoordinator(a, when, on)).toEqual(crashCoordinator(b, when, off));
        else expect(recoverCoordinator(a, on)).toEqual(recoverCoordinator(b, off));
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    }
  });

  it('keeps the scene the same size and inside the page', () => {
    for (const n of [2, 3]) {
      const s = create(n);
      const empty = sceneBounds(layout(s))!;
      for (let i = 0; i < 120; i++) commit(s, quiet(s));
      crashCoordinator(s, 'after', quiet(s));
      const busy = sceneBounds(layout(s))!;
      expect(busy).toEqual(empty);
      expect(busy.bw).toBeLessThanOrEqual(950);
      expect(busy.bh).toBeLessThanOrEqual(420);
      expect(label(100)).toBe('T1');
    }
  });

  it('every operation has a listing in both languages with the anchors its frames name', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    for (const param of def.params![0].options) {
      const s = def.create({ participants: param.value });
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
      for (let round = 0; round < 40; round++) for (const op of def.ops) run(op.id, op.suggest?.(s) ?? [], true);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });

  it('seed and tour tell the story in order', () => {
    expect(def.id).toBe('two-phase-commit');
    const s = def.create({ participants: 3 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const rec = new Recorder(s, def.layout, recording);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(s.committed).toBe(1);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    const recs = def.tour.map(([id, ...args]) => {
      const rec = run(id, args, true);
      checkFrames(rec.frames);
      expect(rec.frames.some((f) => /Sorry|Enter/.test(f.message))).toBe(false);
      return rec;
    });
    const end = (i: number) => recs[i].frames[recs[i].frames.length - 1].message;
    expect(end(0)).toMatch(/^T2 committed/);
    expect(end(1)).toMatch(/^T3 aborted everywhere: B's no/);
    expect(end(2)).toMatch(/blocking protocol/);
    expect(end(3)).toMatch(/^T4 committed .* one crash later/);
    expect(end(4)).toMatch(/^T5 committed .* B last of all/);
    expect(def.status!(s)).toEqual([
      { label: 'Coordinator', value: 'up' },
      { label: 'In doubt', value: 'nothing' },
      { label: 'Locks held', value: '0' },
      { label: 'Committed, aborted', value: '4, 1' },
    ]);
    // The tour works with two participants as well.
    const two = def.create({ participants: 2 });
    for (const [id, ...args] of [...def.seed, ...def.tour]) {
      const rec = new Recorder(two, def.layout, true);
      def.ops.find((o) => o.id === id)!.run(two, args, rec);
      expect(rec.frames.some((f) => /Sorry|Enter/.test(f.message))).toBe(false);
    }
  });
});
