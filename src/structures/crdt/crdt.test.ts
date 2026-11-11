import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  MAX_ENTRIES,
  NAMES,
  REPLICAS,
  add,
  allDots,
  bump,
  canonical,
  collect,
  converged,
  create,
  elements,
  layout,
  merge,
  remove,
  sync,
  value,
  type CrdtState,
  type Replica,
} from './index';

const quiet = (s: CrdtState) => new Recorder(s, layout, false);
const loud = (s: CrdtState) => new Recorder(s, layout, true);
const letter = (i: number) => NAMES[i].toLowerCase();

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, probes on real nodes, a code line on every frame, nothing overlapping or off the scene, a view that never rescales. */
function checkFrames(frames: Frame[], first?: Scene): void {
  const ref = corners(first ?? frames[0].scene);
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
    }
    if (f.compare) expect(f.probe, 'a comparison follows something').toBeDefined();
    expect(f.message).not.toMatch(/undefined|NaN|null|\[object/);
    expect(f.lines?.length ?? 0, f.message).toBeGreaterThan(0);
    const edge = corners(f.scene);
    expect(edge).toEqual(ref);
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
    // Magenta only where the probe is.
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') expect(f.probe, `${n.id} is magenta with nothing followed`).toBeDefined();
      n.cells.forEach((c, i) => {
        if (c.tone === 'key') expect(f.probe, `${n.id}#${i} is magenta with nothing followed`).toBeDefined();
      });
    }
  }
  // The scene stays inside the brief's limits.
  expect(ref.x2 - ref.x1).toBeLessThanOrEqual(940);
  expect(ref.y2 - ref.y1).toBeLessThanOrEqual(420);
}

/** The simplest correct model: one global list of adds and one global set of removed dots, and the true count. */
class Model {
  total = 0;
  adds: { dot: string; elem: number }[] = [];
  removed = new Set<string>();
  /** What a replica that has seen everything should read. */
  read(): number[] {
    return [...new Set(this.adds.filter((a) => !this.removed.has(a.dot)).map((a) => a.elem))].sort((a, b) => a - b);
  }
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

function clone(r: Replica): Replica {
  return { p: [...r.p], n: [...r.n], seq: r.seq, entries: r.entries.map((e) => ({ ...e })) };
}

/** x merged with y, as a new replica: x takes y's state. */
function joined(x: Replica, y: Replica): Replica {
  const s: CrdtState = { replicas: [clone(x), clone(y), create().replicas[2]] };
  merge(s, 'a', 'b', quiet(s));
  return s.replicas[0];
}

/** Random replica states that could have come from one history: run random ops and partial merges. */
function randomStates(rnd: () => number, steps: number): CrdtState {
  const s = create();
  for (let i = 0; i < steps; i++) {
    const r = Math.floor(rnd() * REPLICAS);
    const roll = rnd();
    if (roll < 0.25) bump(s, letter(r), 'p', quiet(s));
    else if (roll < 0.35) bump(s, letter(r), 'n', quiet(s));
    else if (roll < 0.55) {
      if (allDots(s).size < MAX_ENTRIES) add(s, letter(r), Math.floor(rnd() * 4), quiet(s));
    } else if (roll < 0.75) remove(s, letter(r), Math.floor(rnd() * 4), quiet(s));
    else {
      const f = (r + 1 + Math.floor(rnd() * (REPLICAS - 1))) % REPLICAS;
      merge(s, letter(r), letter(f), quiet(s));
    }
  }
  return s;
}

describe('CRDTs: PN-counter and add-wins OR-set', () => {
  it('converges to the model after a sync, under thousands of random operations', () => {
    const rnd = makeRng(2026);
    let s = create();
    let model = new Model();
    let syncs = 0;
    let addWins = 0;
    for (let i = 0; i < 6000; i++) {
      const r = Math.floor(rnd() * REPLICAS);
      const roll = rnd();
      const rec = quiet(s);
      if (roll < 0.22) {
        expect(bump(s, letter(r), 'p', rec)).toBe(true);
        model.total++;
        expect(rec.counters).toEqual({ writes: 1 });
      } else if (roll < 0.34) {
        expect(bump(s, letter(r), 'n', rec)).toBe(true);
        model.total--;
      } else if (roll < 0.52) {
        const x = Math.floor(rnd() * 5);
        const full = allDots(s).size >= MAX_ENTRIES;
        const dot = add(s, letter(r), x, rec);
        if (full) expect(dot).toBeNull();
        else {
          expect(dot).toBe(`${NAMES[r]}${s.replicas[r].seq}`);
          expect(model.adds.some((a) => a.dot === dot)).toBe(false);
          model.adds.push({ dot: dot!, elem: x });
          expect(elements(s.replicas[r])).toContain(x);
        }
      } else if (roll < 0.7) {
        const x = Math.floor(rnd() * 5);
        const live = s.replicas[r].entries.filter((e) => e.elem === x && !e.removed).map((e) => e.dot);
        expect(remove(s, letter(r), x, rec)).toBe(live.length);
        for (const d of live) model.removed.add(d);
        expect(elements(s.replicas[r])).not.toContain(x);
        // One comparison per entry the replica holds.
        expect(rec.counters.comparisons ?? 0).toBe(s.replicas[r].entries.length);
      } else if (roll < 0.9) {
        const f = (r + 1 + Math.floor(rnd() * (REPLICAS - 1))) % REPLICAS;
        const before = canonical(s.replicas[f]);
        const had = elements(s.replicas[r]);
        const res = merge(s, letter(r), letter(f), rec)!;
        // A merge is one way, and costs 6 slot comparisons plus one per entry of the sender.
        expect(canonical(s.replicas[f])).toBe(before);
        expect(rec.counters.comparisons).toBe(2 * REPLICAS + s.replicas[f].entries.length);
        // The receiver now knows everything the sender knows.
        expect(canonical(joined(s.replicas[r], s.replicas[f]))).toBe(canonical(s.replicas[r]));
        for (const d of res.copied) {
          const e = s.replicas[r].entries.find((x) => x.dot === d)!;
          if (!e.removed && !had.includes(e.elem) && s.replicas[r].entries.some((x) => x.elem === e.elem && x.removed)) addWins++;
        }
      } else if (roll < 0.97) {
        sync(s, rec);
        syncs++;
        expect(converged(s)).toBe(true);
        for (const rep of s.replicas) {
          expect(value(rep)).toBe(model.total);
          expect(sorted(elements(rep))).toEqual(model.read());
        }
        // Syncing again changes nothing.
        const again = quiet(s);
        expect(sync(s, again)).toBe(0);
      } else {
        sync(s, quiet(s));
        const tombs = s.replicas[0].entries.filter((e) => e.removed).length;
        const reads = s.replicas.map((x) => elements(x));
        expect(collect(s, rec)).toBe(tombs);
        for (const rep of s.replicas) expect(rep.entries.every((e) => !e.removed)).toBe(true);
        expect(s.replicas.map((x) => elements(x))).toEqual(reads);
        for (const rep of s.replicas) for (const e of rep.entries) expect(model.removed.has(e.dot)).toBe(false);
        model.adds = model.adds.filter((a) => !model.removed.has(a.dot));
        model.removed.clear();
      }
      // Every entry is unique per replica, and no replica holds more than the page draws.
      for (const rep of s.replicas) {
        expect(new Set(rep.entries.map((e) => e.dot)).size).toBe(rep.entries.length);
        expect(rep.entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
      }
      if (i % 300 === 299) {
        s = create();
        model = new Model();
      }
    }
    expect(syncs).toBeGreaterThan(200);
    expect(addWins).toBeGreaterThan(5);
  });

  it('merge is commutative, associative and idempotent', () => {
    const rnd = makeRng(7);
    for (let round = 0; round < 400; round++) {
      const s = randomStates(rnd, 4 + Math.floor(rnd() * 30));
      const [x, y, z] = s.replicas;
      const c = (r: Replica) => canonical(r);
      // Same state whichever way round.
      expect(c(joined(x, y))).toBe(c(joined(y, x)));
      // Same state however grouped.
      expect(c(joined(joined(x, y), z))).toBe(c(joined(x, joined(y, z))));
      // Merging a state into itself, or merging twice, changes nothing.
      expect(c(joined(x, x))).toBe(c(x));
      expect(c(joined(joined(x, y), y))).toBe(c(joined(x, y)));
      // And merging in a different order of whole replicas gives the same final state.
      const a = { replicas: s.replicas.map(clone) };
      const b = { replicas: s.replicas.map(clone) };
      for (const [t, f] of [['a', 'b'], ['a', 'c'], ['b', 'a'], ['c', 'a']]) merge(a, t, f, quiet(a));
      for (const [t, f] of [['c', 'b'], ['c', 'a'], ['c', 'a'], ['a', 'c'], ['b', 'c']]) merge(b, t, f, quiet(b));
      expect(converged(a)).toBe(true);
      expect(converged(b)).toBe(true);
      expect(c(a.replicas[0])).toBe(c(b.replicas[0]));
    }
  });

  it('two concurrent increments both survive; last write wins would lose one', () => {
    const s = create();
    sync(s, quiet(s));
    bump(s, 'a', 'p', quiet(s));
    bump(s, 'b', 'p', quiet(s));
    const rec = loud(s);
    merge(s, 'a', 'b', rec);
    checkFrames(rec.frames);
    expect(value(s.replicas[0])).toBe(2);
    const compares = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(compares.slice(0, 3)).toEqual([
      { left: 'B: 0', op: '<', right: 'A: 1', verdict: 'A keeps 1' },
      { left: 'B: 1', op: '>', right: 'A: 0', verdict: 'A takes 1' },
      { left: 'B: 0', op: '=', right: 'A: 0', verdict: 'equal, keep' },
    ]);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/last write wins would have kept 1 or 1/);
    merge(s, 'b', 'a', quiet(s));
    expect(value(s.replicas[1])).toBe(2);
  });

  it('a concurrent add and remove of one element: the add wins', () => {
    const s = create();
    add(s, 'a', 42, quiet(s));
    sync(s, quiet(s));
    remove(s, 'b', 42, quiet(s));
    add(s, 'a', 42, quiet(s));
    expect(elements(s.replicas[1])).toEqual([]);
    const rec = loud(s);
    merge(s, 'b', 'a', rec);
    checkFrames(rec.frames);
    expect(elements(s.replicas[1])).toEqual([42]);
    expect(rec.frames.some((f) => /the add wins/.test(f.message))).toBe(true);
    // A1 stays removed at B: B's tombstone is newer news than A's live copy.
    expect(s.replicas[1].entries.map((e) => `${e.dot}${e.removed ? 'x' : ''}`)).toEqual(['A1x', 'A2']);
    sync(s, quiet(s));
    for (const r of s.replicas) expect(elements(r)).toEqual([42]);
  });

  it('collect drops only tombstones every replica has seen', () => {
    const s = create();
    add(s, 'a', 5, quiet(s));
    sync(s, quiet(s));
    remove(s, 'a', 5, quiet(s));
    merge(s, 'b', 'a', quiet(s));
    let rec = loud(s);
    expect(collect(s, rec)).toBe(0);
    checkFrames(rec.frames);
    expect(rec.frames.find((f) => f.compare)!.compare).toEqual({ left: 'removed at 2', op: '<', right: 'all 3', verdict: 'keep: C not told yet' });
    // C still holds A1 live: dropping it at A and B now would let C hand it back.
    sync(s, quiet(s));
    rec = loud(s);
    expect(collect(s, rec)).toBe(1);
    checkFrames(rec.frames);
    for (const r of s.replicas) expect(r.entries).toEqual([]);
  });

  it('refuses politely at the page limits and on bad input', () => {
    const s = create();
    for (let i = 0; i < MAX_ENTRIES; i++) expect(add(s, 'a', i, quiet(s))).not.toBeNull();
    const rec = loud(s);
    expect(add(s, 'b', 9, rec)).toBeNull();
    expect(rec.frames[0].message).toMatch(/^Sorry/);
    checkFrames(rec.frames);
    for (const [fn, frames] of [
      [(r: Recorder<CrdtState>) => bump(s, 'z', 'p', r), 1],
      [(r: Recorder<CrdtState>) => merge(s, 'a', 'a', r), 1],
      [(r: Recorder<CrdtState>) => remove(s, 'q', 1, r), 1],
    ] as const) {
      const r = loud(s);
      fn(r);
      expect(r.frames.length).toBe(frames);
      checkFrames(r.frames, rec.frames[0].scene);
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(99);
    const a = def.create({});
    const b = def.create({});
    for (const [id, ...args] of def.seed) {
      def.ops.find((o) => o.id === id)!.run(a, args, quiet(a));
      def.ops.find((o) => o.id === id)!.run(b, args, quiet(b));
    }
    const ref = layout(a);
    for (let i = 0; i < 400; i++) {
      const op = def.ops[Math.floor(rnd() * def.ops.length)];
      const args = op.suggest?.(a) ?? [];
      const on = loud(a);
      const off = quiet(b);
      op.run(a, args, on);
      op.run(b, args, off);
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames, ref);
      expect(a.replicas.map(canonical)).toEqual(b.replicas.map(canonical));
    }
  });

  it('seed and tour run through the definition: concurrent counts, then add wins, then sync', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const rec = new Recorder(s, def.layout, recording);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(converged(s)).toBe(true);
    expect(value(s.replicas[0])).toBe(2);
    expect(elements(s.replicas[0])).toEqual([7, 42]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    const ref = layout(s);
    const reads: string[] = [];
    const used = new Map<string, Set<string>>();
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      checkFrames(rec.frames, ref);
      reads.push(`${id}: ${s.replicas.map((r) => `${value(r)} {${elements(r).join(',')}}`).join(' | ')}`);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      if (id === 'merge' && args[0] === 'a') expect(rec.frames[rec.frames.length - 1].message).toMatch(/last write wins would have kept 3 or 3/);
      if (id === 'merge' && args[0] === 'b') expect(rec.frames.some((f) => /the add wins/.test(f.message))).toBe(true);
    }
    expect(reads).toEqual([
      'inc: 3 {7,42} | 2 {7,42} | 2 {7,42}',
      'inc: 3 {7,42} | 3 {7,42} | 2 {7,42}',
      'merge: 4 {7,42} | 3 {7,42} | 2 {7,42}',
      'remove: 4 {7,42} | 3 {7} | 2 {7,42}',
      'add: 4 {7,42} | 3 {7} | 2 {7,42}',
      'merge: 4 {7,42} | 4 {7,42} | 2 {7,42}',
      'sync: 4 {7,42} | 4 {7,42} | 4 {7,42}',
    ]);
    expect(converged(s)).toBe(true);
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
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

  it('suggestions are accepted by the form, and their frames name real code lines', () => {
    const s = def.create({});
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    const used = new Map<string, Set<string>>();
    for (let round = 0; round < 30; round++) {
      for (const op of def.ops) {
        const args = op.suggest?.(s) ?? [];
        expect(args.length).toBe(op.args.length);
        op.args.forEach((a, i) => {
          if (a.kind === 'int') {
            expect(Number.isInteger(args[i])).toBe(true);
            expect(args[i] as number).toBeGreaterThanOrEqual(a.min!);
            expect(args[i] as number).toBeLessThanOrEqual(a.max!);
          } else expect(String(args[i])).toMatch(/^[abc]$/);
        });
        const rec = loud(s);
        op.run(s, args, rec);
        const set = used.get(op.id) ?? new Set<string>();
        used.set(op.id, set);
        for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      }
    }
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
  });
});
