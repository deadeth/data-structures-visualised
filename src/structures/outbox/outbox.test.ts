import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  ACCOUNTS,
  START,
  consume,
  crashBefore,
  crashBetween,
  crashRelay,
  create,
  drift,
  lag,
  layout,
  prune,
  relay,
  setApproach,
  unpublished,
  write,
  type OutboxState,
} from './index';

const quiet = (s: OutboxState) => new Recorder(s, layout, false);
const loud = (s: OutboxState) => new Recorder(s, layout, true);

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, real probe targets, a code line on every frame, plain tags, no overlaps, magenta only on the followed event. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') {
        expect(n.tone).toBeUndefined();
        expect(n.hue).toBeUndefined();
      }
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      n.cells.forEach((c) => {
        if (c.tone === 'key') expect(c.text).toBe(f.probe?.text);
      });
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

/** A plain model of the same system. */
interface Model {
  approach: 'outbox' | 'dual';
  bal: Record<number, number>;
  outbox: { id: number; account: number; amount: number; published: boolean }[];
  log: { id: number; account: number; amount: number }[];
  nextId: number;
  pos: number;
  totals: Record<number, number>;
  processed: Set<number>;
}

const model = (approach: 'outbox' | 'dual'): Model => ({
  approach,
  bal: { ...START },
  outbox: [],
  log: [],
  nextId: 1,
  pos: 0,
  totals: { ...START },
  processed: new Set(),
});

function same(s: OutboxState, m: Model): void {
  expect(s.approach).toBe(m.approach);
  expect(s.balances).toEqual(m.bal);
  expect(s.outbox.map((r) => [r.event.id, r.published])).toEqual(m.outbox.map((r) => [r.id, r.published]));
  expect(s.log.map((r) => r.event)).toEqual(m.log);
  expect(s.nextId).toBe(m.nextId);
  expect(s.position).toBe(m.pos);
  expect(s.totals).toEqual(m.totals);
  expect(new Set(s.processed)).toEqual(m.processed);
  expect(s.processed.length).toBe(m.processed.size);
  expect(s.pending).toBeNull();
  expect(s.cpending).toBeNull();
  expect(s.inflight).toBeNull();
  expect(s.serviceDown || s.relayDown).toBe(false);
}

describe('transactional outbox', () => {
  for (const start of ['outbox', 'dual'] as const) {
    it(`matches a plain model through random operations (starting ${start})`, () => {
      const rnd = makeRng(20261111 + start.length);
      const s = create(start, 1_000_000, 1_000_000);
      const m = model(start);
      const pick = (n: number) => Math.floor(rnd() * n);
      const totals = { dup: 0, lost: 0, phantom: 0, skipped: 0 };
      for (let i = 0; i < 5000; i++) {
        const roll = rnd();
        const a = ACCOUNTS[pick(3)];
        const amt = 1 + pick(99);
        const rec = quiet(s);
        if (roll < 0.05) {
          const ap = rnd() < 0.5 ? 'outbox' : 'dual';
          setApproach(s, ap, rec);
          m.approach = ap;
        } else if (roll < 0.25) {
          const e = write(s, a, amt, rec)!;
          expect(e).toEqual({ id: m.nextId, account: a, amount: amt });
          m.bal[a] += amt;
          if (m.approach === 'outbox') m.outbox.push({ ...e, published: false });
          else m.log.push(e);
          m.nextId++;
          expect(rec.counters.writes).toBe(1);
        } else if (roll < 0.32) {
          crashBetween(s, a, amt, rec);
          m.bal[a] += amt;
          if (m.approach === 'outbox') m.outbox.push({ id: m.nextId, account: a, amount: amt, published: false });
          else totals.lost++;
          expect(rec.counters.lost ?? 0).toBe(m.approach === 'dual' ? 1 : 0);
          m.nextId++;
        } else if (roll < 0.38) {
          crashBefore(s, a, amt, rec);
          if (m.approach === 'dual') {
            m.log.push({ id: m.nextId, account: a, amount: amt });
            totals.phantom++;
          }
          expect(rec.counters.writes ?? 0).toBe(0);
          expect(rec.counters.phantom ?? 0).toBe(m.approach === 'dual' ? 1 : 0);
          m.nextId++;
        } else if (roll < 0.56) {
          const crash = roll >= 0.5;
          const pend = m.outbox.filter((r) => !r.published);
          expect(crash ? crashRelay(s, rec) : relay(s, rec)).toBe(pend.length);
          if (crash && pend.length) {
            m.log.push({ id: pend[0].id, account: pend[0].account, amount: pend[0].amount });
            totals.dup++;
          }
          for (const r of pend) {
            m.log.push({ id: r.id, account: r.account, amount: r.amount });
            r.published = true;
          }
          expect(rec.counters.duplicates ?? 0).toBe(crash && pend.length ? 1 : 0);
        } else if (roll < 0.93) {
          const n = 1 + pick(3);
          let applied = 0;
          let skipped = 0;
          for (let k = 0; k < n && m.pos < m.log.length; k++) {
            const e = m.log[m.pos++];
            if (m.processed.has(e.id)) skipped++;
            else {
              applied++;
              m.processed.add(e.id);
              m.totals[e.account] += e.amount;
            }
          }
          totals.skipped += skipped;
          expect(consume(s, n, rec)).toEqual({ applied, skipped });
          expect(rec.counters.dupApplied).toBeUndefined();
        } else {
          const n = m.outbox.filter((r) => r.published).length;
          expect(prune(s, rec)).toBe(n);
          m.outbox = m.outbox.filter((r) => !r.published);
        }
        if (i % 10 !== 0) continue;
        same(s, m);
        // The consumer's totals are the start plus each distinct event read, once: no duplicate is ever applied.
        const once = new Map(m.log.slice(0, m.pos).map((e) => [e.id, e]));
        const want = { ...START };
        for (const e of once.values()) want[e.account] += e.amount;
        expect(s.totals).toEqual(want);
      }
      expect(totals.dup).toBeGreaterThan(20);
      expect(totals.skipped).toBeGreaterThan(20);
      expect(totals.lost).toBeGreaterThan(20);
      expect(totals.phantom).toBeGreaterThan(20);
      same(s, m);
    }, 60_000);
  }

  it('with the outbox, crashes anywhere still leave the consumer agreeing with the database', () => {
    const rnd = makeRng(77);
    const s = create('outbox', 1_000_000, 1_000_000);
    for (let i = 0; i < 3000; i++) {
      const roll = rnd();
      const a = ACCOUNTS[Math.floor(rnd() * 3)];
      if (roll < 0.3) write(s, a, 5, quiet(s));
      else if (roll < 0.4) crashBetween(s, a, 5, quiet(s));
      else if (roll < 0.5) crashBefore(s, a, 5, quiet(s));
      else if (roll < 0.6) relay(s, quiet(s));
      else if (roll < 0.7) crashRelay(s, quiet(s));
      else if (roll < 0.95) consume(s, 3, quiet(s));
      else prune(s, quiet(s));
    }
    relay(s, quiet(s));
    while (lag(s)) consume(s, 5, quiet(s));
    expect(drift(s)).toEqual([]);
    expect(unpublished(s)).toBe(0);
  });

  it('dual write: a crash after the commit keeps the write and loses the event', () => {
    const s = create('dual');
    const rec = loud(s);
    expect(crashBetween(s, 42, 25, rec)).toBeNull();
    checkFrames(rec.frames);
    expect(s.balances[42]).toBe(125);
    expect(s.log).toEqual([]);
    expect(rec.counters).toMatchObject({ writes: 1, lost: 1 });
    expect(rec.counters.published).toBeUndefined();
    const crash = rec.frames.find((f) => f.lines?.includes('between'))!;
    expect(crash.scene.nodes.find((n) => n.id === 'svc')!.cells[1]).toMatchObject({ text: 'e1', tone: 'bad' });
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/lost for good/);
    // The consumer can never catch up on account 42.
    consume(s, 5, quiet(s));
    expect(drift(s)).toEqual([{ account: 42, by: 25 }]);
  });

  it('dual write publishing first: the commit fails and the log carries a phantom', () => {
    const s = create('dual');
    const rec = loud(s);
    crashBefore(s, 42, 25, rec);
    checkFrames(rec.frames);
    expect(s.balances[42]).toBe(100);
    expect(s.log).toEqual([{ event: { id: 1, account: 42, amount: 25 }, phantom: true }]);
    expect(rec.counters).toMatchObject({ published: 1, phantom: 1 });
    expect(layout(s).nodes.find((n) => n.id === 'l0')!.tone).toBe('bad');
    consume(s, 1, quiet(s));
    expect(drift(s)).toEqual([{ account: 42, by: -25 }]);
  });

  it('outbox: a crash before commit rolls back both rows; after commit both survive', () => {
    const s = create('outbox');
    const before = loud(s);
    expect(crashBefore(s, 42, 25, before)).toBeUndefined();
    checkFrames(before.frames);
    expect(s.balances[42]).toBe(100);
    expect(s.outbox).toEqual([]);
    expect(before.counters.writes).toBeUndefined();
    const rolled = before.frames.find((f) => f.lines?.includes('restart_before'))!;
    expect(rolled.scene.nodes.find((n) => n.id === 'a42')!.tone).toBe('bad');
    expect(rolled.scene.nodes.find((n) => n.id === 'o1')!.tone).toBe('bad');

    const after = loud(s);
    expect(crashBetween(s, 42, 25, after)).toMatchObject({ id: 2 });
    checkFrames(after.frames);
    expect(s.balances[42]).toBe(125);
    expect(s.outbox).toEqual([{ event: { id: 2, account: 42, amount: 25 }, published: false }]);
    expect(after.counters.lost).toBeUndefined();
    // Inside the transaction both rows are drawn as uncommitted, then both commit.
    const inside = after.frames.find((f) => f.lines?.includes('tx_outbox'))!;
    expect(inside.scene.nodes.find((n) => n.id === 'a42')).toMatchObject({ tone: 'path', cells: [{ text: '125' }] });
    expect(inside.scene.nodes.find((n) => n.id === 'o2')!.cells[0]).toMatchObject({ text: 'e2', tone: 'key' });
    expect(inside.probe).toEqual({ text: 'e2', at: 'o2', cell: 0 });
  });

  it('a relay crash between publish and mark puts the same event on the log twice, and the consumer applies it once', () => {
    const s = create('outbox');
    write(s, 42, 25, quiet(s));
    const rec = loud(s);
    expect(crashRelay(s, rec)).toBe(1);
    checkFrames(rec.frames);
    expect(s.log.map((r) => r.event.id)).toEqual([1, 1]);
    expect(rec.counters).toMatchObject({ published: 2, duplicates: 1 });
    expect(rec.frames.some((f) => f.lines?.includes('relay_crash') && f.scene.nodes.find((n) => n.id === 'relay')!.tone === 'bad')).toBe(true);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/at-least-once/);

    const c = loud(s);
    expect(consume(s, 2, c)).toEqual({ applied: 1, skipped: 1 });
    checkFrames(c.frames);
    expect(s.totals[42]).toBe(125);
    expect(c.counters.dupApplied).toBeUndefined();
    const skip = c.frames.find((f) => f.compare?.verdict === 'seen before: skip it')!;
    expect(skip.probe).toMatchObject({ text: 'e1', at: 'done' });
    expect(drift(s)).toEqual([]);
  });

  it('prune deletes only published rows', () => {
    const s = create('outbox');
    write(s, 42, 5, quiet(s));
    relay(s, quiet(s));
    write(s, 63, 5, quiet(s));
    const rec = loud(s);
    expect(prune(s, rec)).toBe(1);
    checkFrames(rec.frames);
    expect(s.outbox.map((r) => r.event.id)).toEqual([2]);
    expect(prune(s, quiet(s))).toBe(0);
  });

  it('stops politely at the page limits and changes nothing', () => {
    const s = create('outbox');
    for (let i = 0; i < 4; i++) write(s, 42, 5, quiet(s));
    const full = JSON.stringify(s);
    const rec = loud(s);
    expect(write(s, 42, 5, rec)).toBeNull();
    expect(JSON.stringify(s)).toBe(full);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/Sorry/);
    checkFrames(rec.frames);
    // The relay stops when the consumer would fall out of the picture.
    const d = create('dual');
    for (let i = 0; i < 5; i++) expect(write(d, 42, 5, quiet(d))).not.toBeNull();
    const before = JSON.stringify(d);
    expect(write(d, 42, 5, quiet(d))).toBeNull();
    expect(crashBefore(d, 42, 5, quiet(d))).toBeUndefined();
    expect(JSON.stringify(d)).toBe(before);
  });

  it('answers bad arguments without changing anything', () => {
    const s = create('outbox');
    const before = JSON.stringify(s);
    for (const run of [
      (r: Recorder<OutboxState>) => write(s, 5, 10, r),
      (r: Recorder<OutboxState>) => write(s, 42, 0, r),
      (r: Recorder<OutboxState>) => crashBetween(s, 1, 10, r),
      (r: Recorder<OutboxState>) => consume(s, 9, r),
      (r: Recorder<OutboxState>) => setApproach(s, 'zebra', r),
    ]) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed and the scene one size', () => {
    const rnd = makeRng(4242);
    const a = create('outbox');
    const b = create('outbox');
    const size = sceneBounds(layout(a))!;
    expect(size.bw).toBeLessThanOrEqual(950);
    expect(size.bh).toBeLessThanOrEqual(420);
    const ops = def.ops;
    for (let i = 0; i < 500; i++) {
      const op = ops[Math.floor(rnd() * ops.length)];
      const args = op.id === 'approach' ? [rnd() < 0.5 ? 'dual' : 'outbox'] : op.args.length === 2 ? [ACCOUNTS[Math.floor(rnd() * 3)], 5] : op.args.length ? [1 + Math.floor(rnd() * 3)] : [];
      const on = loud(a);
      const off = quiet(b);
      op.run(a, args, on);
      op.run(b, args, off);
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      checkFrames(on.frames);
      for (const f of on.frames) expect(sceneBounds(f.scene)).toEqual(size);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('the seed and tour tell the story: lost, safe, duplicated, deduplicated, pruned', () => {
    const s = def.create({ approach: 0 });
    for (const [id, ...args] of def.seed) {
      const rec = quiet(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
    }
    expect(drift(s)).toEqual([]);
    expect(lag(s)).toBe(0);
    const recs = def.tour.map(([id, ...args]) => {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      checkFrames(rec.frames);
      expect(rec.frames.some((f) => /Sorry/.test(f.message))).toBe(false);
      return rec;
    });
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    expect(recs[1].counters.lost).toBe(1);
    expect(recs[3].counters.writes).toBe(1);
    expect(recs[4].counters.duplicates).toBe(1);
    expect(recs[5].frames.some((f) => f.compare?.verdict === 'seen before: skip it')).toBe(true);
    expect(recs[6].counters.pruned).toBe(3);
    expect(s.outbox).toEqual([]);
    // The event lost in step 2 is still missing: the outbox cannot recover what was never written.
    expect(drift(s)).toEqual([{ account: 42, by: 25 }]);
  });

  it('the dual-write seed runs every operation for real', () => {
    const s = def.create({ approach: 1 });
    for (const [id, ...args] of def.seedFor!({ approach: 1 })) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      expect(rec.counters.writes ?? rec.counters.comparisons ?? 0).toBeGreaterThan(0);
    }
    expect(s.log.length).toBe(2);
    expect(drift(s)).toEqual([]);
  });

  it('every operation has a listing in both languages, and every frame names a line it has', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    for (const approach of [0, 1]) {
      const s = def.create({ approach });
      for (const [id, ...args] of def.seedFor!({ approach })) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[]) => {
        const rec = loud(s);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
      };
      for (const [id, ...args] of def.tour) run(id, args);
      for (let round = 0; round < 15; round++) for (const op of def.ops) run(op.id, op.suggest?.(s) ?? []);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });
});
