import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, OpDef } from '../../core/types';
import def, {
  MAX_LOG,
  clientLeader,
  crash,
  create,
  heal,
  layout,
  majority,
  partition,
  recover,
  reset,
  timeout,
  write,
  type Entry,
  type RaftState,
} from './index';

const quiet = (s: RaftState) => new Recorder(s, layout, false);
const loud = (s: RaftState) => new Recorder(s, layout, true);
const sv = (s: RaftState, id: number) => s.servers[id - 1];
const same = (a: Entry, b: Entry) => a.term === b.term && a.value === b.value;

/**
 * The safety properties from the Raft paper, checked against a running record
 * of everything ever committed. Throws on the first violation.
 */
class Safety {
  leaders = new Map<number, number>();
  committed: Entry[] = [];
  /** Index -> term of a leader that had it committed: later leaders must hold it. */
  commitTerm = new Map<number, number>();
  acked: { index: number; value: number }[] = [];

  check(s: RaftState): void {
    for (const v of s.servers) {
      if (v.role !== 'leader') continue;
      const had = this.leaders.get(v.term);
      if (had !== undefined) expect(had, `two leaders in term ${v.term}`).toBe(v.id);
      this.leaders.set(v.term, v.id);
    }
    // Log matching: same index and term means identical up to there.
    for (const a of s.servers) {
      for (const b of s.servers) {
        for (let i = Math.min(a.log.length, b.log.length); i > 0; i--) {
          if (a.log[i - 1].term !== b.log[i - 1].term) continue;
          for (let j = 0; j < i; j++) expect(same(a.log[j], b.log[j]), `log matching S${a.id} S${b.id} at ${j + 1}`).toBe(true);
          break;
        }
      }
    }
    // State machine safety: every server's committed prefix agrees with every other's, forever.
    for (const v of s.servers) {
      expect(v.commit).toBeLessThanOrEqual(v.log.length);
      for (let i = 1; i <= v.commit; i++) {
        if (i <= this.committed.length) expect(same(this.committed[i - 1], v.log[i - 1]), `safety at ${i}`).toBe(true);
        else this.committed.push({ ...v.log[i - 1] });
      }
    }
    for (const v of s.servers) if (v.role === 'leader') for (let i = 1; i <= v.commit; i++) if (!this.commitTerm.has(i)) this.commitTerm.set(i, v.term);
    // Leader completeness.
    for (const v of s.servers) {
      if (v.role !== 'leader') continue;
      for (const [i, t] of this.commitTerm) {
        if (v.term > t) expect(v.log.length >= i && same(v.log[i - 1], this.committed[i - 1]), `S${v.id} lacks committed ${i}`).toBe(true);
      }
    }
    for (const a of this.acked) expect(this.committed[a.index - 1]?.value).toBe(a.value);
  }
}

function boxes(f: Frame) {
  return f.scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, a probe on a real node, code lines, plain tags, magenta only on the followed value, nothing overlapping, a scene that fits. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') {
        expect(n.tone).toBeUndefined();
        expect(n.hue).toBeUndefined();
        expect(n.cells[0].tone).toBeUndefined();
      }
      n.cells.forEach((c, i) => {
        if (c.tone === 'key') {
          expect(i).toBe(1);
          expect(c.text).toBe(f.probe?.text);
        }
      });
      expect(n.tone).not.toBe('key');
    }
    const bs = boxes(f);
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

/** One random operation, chosen by `roll`. Returns the write's result when it was a write. */
function randomOp(s: RaftState, rnd: () => number, rec: Recorder<RaftState>, value: number, cutLimit: number): boolean | null {
  const n = s.servers.length;
  const id = 1 + Math.floor(rnd() * n);
  const roll = rnd();
  if (roll < 0.25) timeout(s, id, rec);
  else if (roll < 0.6) return write(s, value, rec);
  else if (roll < 0.7) {
    if (s.servers.filter((v) => v.up).length > 1) crash(s, id, rec);
  } else if (roll < 0.8) recover(s, id, rec);
  else if (roll < 0.88) {
    if (s.cut.filter(Boolean).length < cutLimit) partition(s, id, rec);
  } else heal(s, rec);
  return null;
}

describe('raft', () => {
  for (const n of [3, 5]) {
    for (const cutLimit of [Math.floor(n / 2), n - 1]) {
      it(`keeps the Raft safety properties through random operations (${n} servers, up to ${cutLimit} cut off)`, () => {
        const rnd = makeRng(20261111 + n * 10 + cutLimit);
        const s = create(n, 1_000_000);
        const safety = new Safety();
        let commits = 0;
        let elections = 0;
        let overwritten = 0;
        for (let i = 1; i <= 4000; i++) {
          const rec = quiet(s);
          const leadersBefore = s.servers.filter((v) => v.role === 'leader').length;
          const value = 1 + (i % 99);
          const ok = randomOp(s, rnd, rec, value, cutLimit);
          if (ok) {
            // The written entry is the last in the leader's log, and it is committed.
            const L = clientLeader(s)!;
            expect(L.log[L.log.length - 1].value).toBe(value);
            expect(L.commit).toBe(L.log.length);
            safety.acked.push({ index: L.log.length, value });
            commits++;
          }
          if (s.servers.filter((v) => v.role === 'leader').length > leadersBefore) elections++;
          overwritten += rec.counters.overwritten ?? 0;
          if (i % 25 === 0) safety.check(s);
        }
        safety.check(s);
        expect(commits).toBeGreaterThan(300);
        expect(elections).toBeGreaterThan(40);
        expect(overwritten).toBeGreaterThan(10);
      }, 60_000);
    }
  }

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    for (const n of [3, 5]) {
      const a = create(n);
      const b = create(n);
      for (let i = 1; i <= 500; i++) {
        const on = loud(a);
        const off = quiet(b);
        const seed = Math.floor(rnd() * 1e9);
        if (i % 97 === 0) {
          reset(a, on);
          reset(b, off);
        } else {
          expect(randomOp(a, makeRng(seed), on, 1 + (i % 99), n - 1)).toBe(randomOp(b, makeRng(seed), off, 1 + (i % 99), n - 1));
        }
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        checkFrames(on.frames);
      }
    }
  });

  it('plays the tour: commit, a minority that cannot commit, two elections, and a repair', () => {
    const s = def.create({ servers: 5 });
    const find = (id: string) => def.ops.find((o) => o.id === id) as OpDef<RaftState>;
    for (const [op, ...args] of def.seed) find(op).run(s, args, quiet(s));
    expect(clientLeader(s)?.id).toBe(1);
    expect(s.servers.every((v) => v.commit === 1 && v.log.length === 1)).toBe(true);

    const runs: Recorder<RaftState>[] = [];
    for (const [op, ...args] of def.tour) {
      const rec = loud(s);
      find(op).run(s, args, rec);
      checkFrames(rec.frames);
      runs.push(rec);
    }
    const [w7, cut, w8, t2, , t3, healed] = runs;
    // write 7 commits everywhere.
    expect(w7.frames.some((f) => f.lines?.includes('commit'))).toBe(true);
    void cut;
    // write 8 on the cut-off leader: one copy, never committed.
    expect(w8.frames.some((f) => f.compare?.left === 'copies of 3: 1' && f.compare.op === '<')).toBe(true);
    expect(w8.frames[w8.frames.length - 1].lines).toContain('waiting');
    // S2 wins term 2 and S3 wins term 3 after S2 crashes.
    expect(t2.frames.some((f) => f.lines?.includes('win'))).toBe(true);
    expect(t3.frames.some((f) => f.lines?.includes('win'))).toBe(true);
    expect(clientLeader(s)?.id).toBe(3);
    expect(sv(s, 3).term).toBe(3);
    // The heal: S1 steps down, next walks back, entry 3 is overwritten.
    expect(sv(s, 1).role).toBe('follower');
    expect(sv(s, 1).term).toBe(3);
    expect(healed.frames.some((f) => f.lines?.includes('back'))).toBe(true);
    expect(healed.frames.some((f) => f.lines?.includes('truncate'))).toBe(true);
    expect(healed.counters.overwritten).toBe(1);
    expect(sv(s, 1).log).toEqual(sv(s, 3).log);
    expect(sv(s, 1).log.map((e) => e.value)).toEqual([null, 7, null, null]);
    expect(sv(s, 1).commit).toBe(4);
    // Write 8 never reached a majority, so it is nowhere now.
    expect(s.servers.some((v) => v.log.some((e) => e.value === 8))).toBe(false);
    // Room is left to play after the tour.
    expect(clientLeader(s)!.log.length).toBeLessThan(MAX_LOG);
  });

  it('refuses a vote to a candidate whose log is behind', () => {
    const s = create(5);
    timeout(s, 1, quiet(s));
    crash(s, 5, quiet(s));
    expect(write(s, 42, quiet(s))).toBe(true);
    crash(s, 1, quiet(s));
    recover(s, 5, quiet(s));
    // S5 missed entry 2 and no leader is left to repair it.
    expect(sv(s, 5).log.length).toBe(1);
    const rec = loud(s);
    expect(timeout(s, 5, rec)).toBe(false);
    checkFrames(rec.frames);
    expect(rec.frames.filter((f) => f.compare?.left === 'S5 last index 1' && f.compare.op === '<').length).toBe(3);
    expect(rec.frames.filter((f) => f.lines?.includes('refuse')).length).toBe(3);
    expect(sv(s, 5).role).toBe('candidate');
    expect(rec.frames[rec.frames.length - 1].lines).toContain('split');
  });

  it('never commits an older term\'s entry by counting copies', () => {
    // A log of 2 leaves no room for a no-op, so the new leader holds only an older entry.
    const s = create(5, 2);
    timeout(s, 1, quiet(s));
    for (const id of [3, 4, 5]) partition(s, id, quiet(s));
    expect(write(s, 10, quiet(s))).toBe(false);
    crash(s, 1, quiet(s));
    heal(s, quiet(s));
    const rec = loud(s);
    expect(timeout(s, 2, rec)).toBe(true);
    checkFrames(rec.frames);
    const own = rec.frames.find((f) => f.lines?.includes('own_term') && f.compare?.op === '≠');
    expect(own?.compare?.left).toBe('entry 2: t1');
    expect(sv(s, 2).commit).toBe(1);
    expect(sv(s, 3).log.length).toBe(2);
  });

  it('a stale leader steps down when a follower has a newer term', () => {
    const s = create(3);
    timeout(s, 1, quiet(s));
    partition(s, 1, quiet(s));
    expect(timeout(s, 2, quiet(s))).toBe(true);
    expect(sv(s, 1).role).toBe('leader');
    expect(sv(s, 2).role).toBe('leader');
    crash(s, 2, quiet(s));
    // S2 is down, so S1 (term 1) sends the heartbeat. S3 is in term 2.
    const rec = loud(s);
    heal(s, rec);
    checkFrames(rec.frames);
    expect(rec.frames.some((f) => f.lines?.includes('deposed'))).toBe(true);
    expect(sv(s, 1).role).toBe('follower');
    expect(sv(s, 1).term).toBe(2);
    expect(clientLeader(s)).toBeNull();
    expect(majority(s)).toBe(2);
  });

  it('answers impossible requests without changing anything', () => {
    const s = create(3);
    timeout(s, 1, quiet(s));
    const before = JSON.stringify(s);
    const runs: ((rec: Recorder<RaftState>) => unknown)[] = [
      (rec) => timeout(s, 9, rec),
      (rec) => timeout(s, 1, rec),
      (rec) => write(s, 0, rec),
      (rec) => write(s, 100, rec),
      (rec) => crash(s, 4, rec),
      (rec) => recover(s, 2, rec),
      (rec) => partition(s, 'x', rec),
      (rec) => heal(s, rec),
    ];
    for (const run of runs) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
    // Two of three may be cut off, but not all three.
    partition(s, 1, quiet(s));
    partition(s, 2, quiet(s));
    const rec = loud(s);
    expect(partition(s, 3, rec)).toBe(false);
    expect(rec.frames[0].lines).toEqual(['refuse']);
  });

  it('stops politely when a log is full', () => {
    const s = create(3);
    timeout(s, 1, quiet(s));
    for (let v = 1; v < MAX_LOG; v++) expect(write(s, v, quiet(s))).toBe(true);
    const before = JSON.stringify(s);
    const rec = loud(s);
    expect(write(s, 50, rec)).toBe(false);
    expect(rec.frames[0].message).toMatch(/Sorry/);
    expect(JSON.stringify(s)).toBe(before);
    // A new leader with a full log sends a heartbeat in place of the no-op.
    crash(s, 1, quiet(s));
    const elect = loud(s);
    expect(timeout(s, 2, elect)).toBe(true);
    checkFrames(elect.frames);
    expect(sv(s, 2).log.length).toBe(MAX_LOG);
  });

  it('keeps its code listings in step with every frame', () => {
    const find = (id: string) => def.ops.find((o) => o.id === id) as OpDef<RaftState>;
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, `${op.id} ${lang}: ${line}`).toBeLessThanOrEqual(80);
      }
    }
    for (const n of [3, 5]) {
      const s = def.create({ servers: n });
      for (const [op, ...args] of def.seed) find(op).run(s, args, quiet(s));
      const used = new Map<string, Set<string>>();
      const run = (opId: string, args: (number | string)[]) => {
        const rec = loud(s);
        find(opId).run(s, args, rec);
        const set = used.get(opId) ?? new Set<string>();
        used.set(opId, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        checkFrames(rec.frames);
      };
      for (const [op, ...args] of def.tour) run(op, args);
      for (let round = 0; round < 40; round++) for (const op of def.ops) if (op.id !== 'reset' || round % 10 === 9) run(op.id, op.suggest?.(s) ?? []);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });
});
