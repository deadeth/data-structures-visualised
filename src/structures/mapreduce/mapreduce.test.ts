import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  EVEN,
  MAX_USER,
  RIGHT,
  USERS,
  broadcast,
  clicks,
  count,
  create,
  findClick,
  hashKey,
  hotInput,
  join,
  layout,
  partitionOf,
  reset,
  skew,
  type MRState,
} from './index';

const quiet = (s: MRState) => new Recorder(s, layout, false);
const loud = (s: MRState) => new Recorder(s, layout, true);

/** The simplest correct answers, with no partitioning at all. */
function modelCount(blocks: number[][]): Map<number, number> {
  const m = new Map<number, number>();
  for (const u of blocks.flat()) m.set(u, (m.get(u) ?? 0) + 1);
  return m;
}
function modelJoin(blocks: number[][], users: [number, string][]): string[] {
  const t = new Map(users);
  return blocks
    .flat()
    .filter((u) => t.has(u))
    .map((u) => `u${u} ${t.get(u)}`)
    .sort();
}
const totals = (s: MRState) => new Map(s.reds.flat().map((p) => [p.key, Number(p.value)]));
const joinedRows = (rows: { key: number; value: string }[]) => rows.map((p) => `u${p.key} ${p.value}`).sort();

function corners(scene: Scene) {
  const c = scene.decor!.filter((d) => d.id.startsWith('corner')).map((d) => (d.type === 'label' ? [d.x, d.y] : [0, 0]));
  return c;
}

/** Unique ids, a probe on a real node and cell, a code line on every frame, nothing overlapping, magenta only where the chip is. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) {
        expect(f.probe.cell).toBeGreaterThanOrEqual(0);
        expect(f.probe.cell).toBeLessThan(at!.cells.length);
      }
      expect(f.probe.text).toMatch(/^u\d$/);
    }
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—|\[object/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.compare) expect(f.probe, 'a comparison follows a record').toBeDefined();
    let magenta = 0;
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      expect(n.tone).not.toBe('key');
      for (const c of n.cells) if (c.tone === 'key') magenta++;
    }
    expect(magenta).toBeLessThanOrEqual(1);
    if (magenta) {
      expect(f.probe).toBeDefined();
      // The magenta cell holds the followed user's record.
      const cell = f.scene.nodes.flatMap((n) => n.cells).find((c) => c.tone === 'key')!;
      expect(cell.text.startsWith(f.probe!.text)).toBe(true);
    }
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < -0.5 || a.x2 > RIGHT + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const e of f.scene.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
    expect(corners(f.scene)).toEqual(corners(frames[0].scene));
  }
}

function randomInput(rnd: () => number): number[][] {
  if (rnd() < 0.3) return hotInput(1 + Math.floor(rnd() * MAX_USER));
  return Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => 1 + Math.floor(rnd() * MAX_USER)));
}

describe('mapreduce', () => {
  it('partitions by h(key) mod reducers', () => {
    expect(hashKey(4)).toBe(131);
    expect(partitionOf(4, 2)).toBe(1);
    expect(partitionOf(4, 3)).toBe(2);
    expect([1, 2, 3, 4, 5, 6].map((u) => partitionOf(u, 2))).toEqual([0, 1, 0, 1, 0, 1]);
  });

  for (const reducers of [2, 3]) {
    it(`count and both joins agree with a plain model over random inputs (${reducers} reducers)`, () => {
      const rnd = makeRng(1000 + reducers);
      for (let i = 0; i < 1500; i++) {
        const s = create(reducers);
        s.blocks = randomInput(rnd);
        const user = s.blocks.flat()[Math.floor(rnd() * 9)];
        const model = modelCount(s.blocks);
        const n = clicks(s);

        const rc = quiet(s);
        expect(count(s, user, rc)).toBe(model.get(user));
        expect(totals(s)).toEqual(model);
        // Each key's total comes from exactly one reducer: the one its hash names.
        for (let r = 0; r < reducers; r++) for (const t of s.reds[r]) expect(partitionOf(t.key, reducers)).toBe(r);
        // A reducer's output is in key order: it came from a sorted merge.
        for (const red of s.reds) expect(red.map((p) => p.key)).toEqual([...red.map((p) => p.key)].sort((a, b) => a - b));
        expect(rc.counters.reads).toBe(n);
        expect(rc.counters.shuffled).toBe(n);
        expect(rc.counters.written).toBe(model.size);
        expect(s.loads.reduce((a, b) => a + b, 0)).toBe(n);
        expect(s.follow).toBeNull();

        const want = modelJoin(s.blocks, s.users);
        const rj = quiet(s);
        const got = join(s, user, rj);
        expect(joinedRows(s.reds.flat())).toEqual(want);
        expect(got).toBe(s.users.some(([k]) => k === user) ? `u${user} ${new Map(s.users).get(user)}` : null);
        expect(rj.counters.shuffled).toBe(n + s.users.length);
        expect(rj.counters.written).toBe(want.length);

        const rb = quiet(s);
        expect(broadcast(s, user, rb)).toBe(got);
        expect(joinedRows(s.outs.flat())).toEqual(want);
        expect(rb.counters.shuffled ?? 0).toBe(0);
        expect(rb.counters.reads).toBe(n + 3 * s.users.length);
        expect(rb.counters.comparisons).toBe(n);
      }
    });
  }

  it('merges by comparing run heads: the count of comparisons is what a head scan makes', () => {
    // u4 in the even input with two reducers: reducer 1 merges runs [u2], [u2 u4 u6] and [u2 u4].
    const s = create(2);
    const rec = loud(s);
    expect(count(s, 4, rec)).toBe(2);
    checkFrames(rec.frames);
    const merge = rec.frames.filter((f) => f.lines!.includes('cmp')).map((f) => `${f.compare!.left} ${f.compare!.op} ${f.compare!.right}`);
    expect(merge).toEqual(['M1: u2 1 = M0: u2 1', 'M2: u2 1 = M0: u2 1', 'M2: u2 1 = M1: u2 1', 'M2: u2 1 < M1: u4 1', 'M2: u4 1 = M1: u4 1']);
    // The routing frame comes after all 9 routing decisions have been counted.
    const parts = rec.frames.find((f) => f.compare && f.compare.left === 'h(u4) mod 2')!;
    expect(parts.compare!.right).toBe('R1');
    expect(parts.counters.comparisons).toBe(9);
    // The followed pair is taken from map 1, where it started.
    const take = rec.frames.find((f) => f.lines!.includes('take'))!;
    expect(take.message).toMatch(/from M1/);
    expect(take.probe!.at).toBe('r1');
    const last = rec.frames[rec.frames.length - 1];
    expect(last.lines).toEqual(['write']);
    expect(last.message).toMatch(/u4 made 2 clicks/);
    const out = last.scene.nodes.find((n) => n.id === 'r1')!;
    expect(out.cells.map((c) => c.text)).toEqual(['u2=3', 'u4=2', 'u6=1']);
    expect(out.cells[1].tone).toBe('key');
    expect(rec.counters).toMatchObject({ reads: 9, shuffled: 9, written: 5 });
  });

  it('a sort-merge join brings the user row first and drops clicks with no user', () => {
    const s = create(2);
    const rec = loud(s);
    expect(join(s, 4, rec)).toBe('u4 IT');
    checkFrames(rec.frames);
    const remember = rec.frames.find((f) => f.lines!.includes('remember'))!;
    expect(remember.compare).toMatchObject({ left: 'u4 group starts', right: 'user row' });
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/became u4 IT/);

    const t = create(2);
    const r2 = loud(t);
    expect(join(t, 5, r2)).toBeNull();
    checkFrames(r2.frames);
    const drop = r2.frames.find((f) => f.lines!.includes('drop') && !f.compare)!;
    const red = drop.scene.nodes.find((n) => n.id === drop.probe!.at)!;
    expect(red.cells[drop.probe!.cell!].tone).toBe('bad');
    expect(r2.frames[r2.frames.length - 1].message).toMatch(/no row for u5/);
  });

  it('a broadcast join gives the same rows in far fewer frames, with nothing shuffled', () => {
    const a = create(2);
    const b = create(2);
    const ra = loud(a);
    const rb = loud(b);
    join(a, 4, ra);
    broadcast(b, 4, rb);
    checkFrames(rb.frames);
    expect(joinedRows(b.outs.flat())).toEqual(joinedRows(a.reds.flat()));
    expect(rb.frames.length * 3).toBeLessThan(ra.frames.length);
    expect(rb.counters.shuffled ?? 0).toBe(0);
    expect(ra.counters.shuffled).toBe(12);
  });

  it('a hot key sends most pairs to one reducer, with either number of reducers', () => {
    for (const reducers of [2, 3]) {
      for (let hot = 1; hot <= MAX_USER; hot++) {
        const s = create(reducers);
        const rec = loud(s);
        const loads = skew(s, hot, rec);
        checkFrames(rec.frames);
        expect(loads[partitionOf(hot, reducers)]).toBeGreaterThanOrEqual(7);
        expect(loads.reduce((x, y) => x + y, 0)).toBe(9);
        const cmp = rec.frames.find((f) => f.lines!.includes('imbalance') && f.compare)!;
        expect(cmp.compare!.op).toBe('>');
        expect(rec.frames[rec.frames.length - 1].message).toMatch(/combiner/);
        expect(s.blocks.flat().filter((u) => u === hot).length).toBe(7);
        reset(s, quiet(s));
        expect(s.blocks).toEqual(EVEN);
        expect(s.hot).toBeNull();
      }
    }
  });

  it('a user with no clicks is turned away without changing anything', () => {
    const s = create(2);
    count(s, 4, quiet(s));
    const before = JSON.stringify(s);
    for (const op of [count, join, broadcast]) {
      const rec = loud(s);
      expect(op(s, 3, rec)).toBeNull();
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(/u3 made no clicks/);
      checkFrames(rec.frames);
    }
    expect(JSON.stringify(s)).toBe(before);
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(77);
    for (const reducers of [2, 3]) {
      const a = create(reducers);
      const b = create(reducers);
      for (let i = 0; i < 200; i++) {
        const roll = rnd();
        const user = 1 + Math.floor(rnd() * MAX_USER);
        const on = loud(a);
        const off = quiet(b);
        if (roll < 0.3) expect(count(a, user, on)).toBe(count(b, user, off));
        else if (roll < 0.55) expect(join(a, user, on)).toBe(join(b, user, off));
        else if (roll < 0.8) expect(broadcast(a, user, on)).toBe(broadcast(b, user, off));
        else if (roll < 0.93) expect(skew(a, user, on)).toEqual(skew(b, user, off));
        else {
          reset(a, on);
          reset(b, off);
        }
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(a).toEqual(b);
        expect(a.follow).toBeNull();
      }
    }
  });

  it('every operation has a listing in both languages with lines that fit the panel', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        expect(l.anchors.size).toBeGreaterThan(0);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
  });

  it('seed and tour run through the definition: count, join, broadcast join, hot key', () => {
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    for (const p of def.params![0].options) {
      const s = def.create({ reducers: p.value });
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[], recording: boolean) => {
        const op = def.ops.find((o) => o.id === id)!;
        const rec = new Recorder(s, def.layout, recording);
        op.run(s, args, rec);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const x of f.lines!) set.add(x);
        return rec;
      };
      for (const [id, ...args] of def.seed) run(id, args, false);
      const frames: number[] = [];
      for (const [id, ...args] of def.tour) {
        const rec = run(id, args, true);
        expect(rec.frames.length).toBeGreaterThan(1);
        checkFrames(rec.frames);
        frames.push(rec.frames.length);
      }
      // The broadcast join takes far fewer steps than the sort-merge join.
      expect(frames[2] * 2).toBeLessThan(frames[1]);
      expect(def.status!(s).length).toBeGreaterThanOrEqual(2);
      // Suggestions are accepted by the form and run cleanly.
      for (let round = 0; round < 15; round++) {
        for (const op of def.ops) {
          const args = op.suggest?.(s) ?? [];
          expect(args.length).toBe(op.args.length);
          op.args.forEach((a, i) => {
            expect(args[i] as number).toBeGreaterThanOrEqual(a.min!);
            expect(args[i] as number).toBeLessThanOrEqual(a.max!);
          });
          const rec = run(op.id, args, true);
          checkFrames(rec.frames);
        }
      }
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });

  it('the users table and even input are what the listings use', () => {
    expect(USERS).toEqual([[1, 'UK'], [2, 'FR'], [4, 'IT']]);
    expect(findClick(create(2), 4)).toEqual({ b: 1, i: 0 });
  });
});
