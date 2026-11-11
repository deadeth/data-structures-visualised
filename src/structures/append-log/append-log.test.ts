import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  GROUPS,
  MAX_RECORDS,
  PRIME,
  SEED_KEYS,
  SEGMENT,
  TOUR_KEY,
  TOUR_OTHER,
  commit,
  consume,
  crash,
  create,
  endOf,
  hashKey,
  lag,
  layout,
  partitionOf,
  produce,
  trim,
  uncommitted,
  type GroupId,
  type LogState,
} from './index';

const quiet = (s: LogState) => new Recorder(s, layout, false);
const loud = (s: LogState) => new Recorder(s, layout, true);

/** A plain model: every record ever appended to each partition, and three numbers per group. */
interface Model {
  all: number[][];
  start: number[];
  position: Record<GroupId, number[]>;
  committed: Record<GroupId, number[]>;
}

function model(partitions: number): Model {
  const zeros = () => new Array<number>(partitions).fill(0);
  return {
    all: Array.from({ length: partitions }, () => []),
    start: zeros(),
    position: { a: zeros(), b: zeros() },
    committed: { a: zeros(), b: zeros() },
  };
}

/** Throws if the offsets are out of order or the state disagrees with the model. */
function verify(s: LogState, m?: Model): void {
  s.partitions.forEach((part, p) => {
    const end = endOf(part);
    expect(part.start % SEGMENT).toBe(0);
    expect(part.records.length).toBeLessThanOrEqual(s.maxRecords);
    for (const g of GROUPS) {
      const grp = s.groups[g];
      // start <= committed <= position <= seen <= end, always.
      expect(grp.committed[p]).toBeGreaterThanOrEqual(part.start);
      expect(grp.position[p]).toBeGreaterThanOrEqual(grp.committed[p]);
      expect(grp.seen[p]).toBeGreaterThanOrEqual(grp.position[p]);
      expect(end).toBeGreaterThanOrEqual(grp.seen[p]);
      if (m) {
        expect(grp.position[p]).toBe(m.position[g][p]);
        expect(grp.committed[p]).toBe(m.committed[g][p]);
      }
    }
    if (m) {
      expect(part.start).toBe(m.start[p]);
      expect(end).toBe(m.all[p].length);
      // What is kept is exactly the tail of everything ever appended: nothing moved, nothing rewritten.
      expect(part.records).toEqual(m.all[p].slice(m.start[p]));
    }
  });
}

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, a probe that points at a real cell, a code line, plain tags, nothing overlapping, magenta only on the key. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') {
        // Pointers never take a tone or a hue.
        expect(n.tone).toBeUndefined();
        expect(n.hue).toBeUndefined();
        expect(n.cells[0].tone).toBeUndefined();
      }
      // Magenta is only ever on the record that holds the followed key.
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
    }
    const bs = boxes(f.scene);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        const overlap = a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
        if (overlap) expect.fail(`${a.id} overlaps ${b.id}`);
      }
    }
  }
}

/** The offset a tag points at: the label under the slot it sits beneath. */
function tagOffset(scene: Scene, id: string): number {
  const tag = scene.nodes.find((n) => n.id === id)!;
  const slots = scene.nodes.filter((n) => n.id.startsWith(`p${id[1]}o`));
  slots.sort((a, b) => Math.abs(a.x - tag.x) - Math.abs(b.x - tag.x));
  expect(tag.y).toBeGreaterThan(slots[0].y);
  return Number(slots[0].cells[0].sub);
}

describe('append-only log', () => {
  it('hashes a key to the stated sum and to a partition that exists', () => {
    expect(hashKey(42)).toBe((31 * 42 + 7) % 1009);
    expect(hashKey(42)).toBe(300);
    expect(PRIME).toBeGreaterThan(999);
    for (const n of [2, 3, 4]) {
      const used = new Set<number>();
      for (let key = 0; key <= 999; key++) {
        const p = partitionOf(key, n);
        expect(Number.isInteger(p) && p >= 0 && p < n).toBe(true);
        used.add(p);
      }
      expect(used.size).toBe(n);
    }
  });

  for (const partitions of [2, 3, 4]) {
    it(`matches a plain model through random operations (${partitions} partitions)`, () => {
      const rnd = makeRng(20261111 + partitions);
      const s = create(partitions, 1_000_000);
      const m = model(partitions);
      const pick = (n: number) => Math.floor(rnd() * n);
      let repeats = 0;
      let skips = 0;
      for (let i = 0; i < 6000; i++) {
        const roll = rnd();
        const g = GROUPS[pick(2)];
        const p = pick(partitions);
        const rec = quiet(s);
        if (roll < 0.3) {
          const key = pick(40);
          const want = partitionOf(key, partitions);
          const placed = produce(s, key, rec);
          // The offset is the number of records the partition had ever taken.
          expect(placed).toEqual({ partition: want, offset: m.all[want].length });
          m.all[want].push(key);
          expect(rec.counters).toEqual({ writes: 1 });
        } else if (roll < 0.7) {
          const pos = m.position[g][p];
          const want = pos < m.all[p].length ? m.all[p][pos] : null;
          const seen = s.groups[g].seen[p];
          expect(consume(s, g, p, rec)).toBe(want);
          if (want === null) expect(rec.counters).toEqual({ comparisons: 1 });
          else {
            m.position[g][p]++;
            const again = pos < seen;
            if (again) repeats++;
            expect(rec.counters).toEqual(again ? { comparisons: 1, reads: 1, redelivered: 1 } : { comparisons: 1, reads: 1 });
          }
        } else if (roll < 0.82) {
          let moved = 0;
          for (let q = 0; q < partitions; q++) {
            if (m.committed[g][q] < m.position[g][q]) moved++;
            m.committed[g][q] = m.position[g][q];
          }
          expect(commit(s, g, rec)).toBe(moved);
          expect(uncommitted(s, g)).toBe(0);
        } else if (roll < 0.92) {
          let again = 0;
          for (let q = 0; q < partitions; q++) {
            again += m.position[g][q] - m.committed[g][q];
            m.position[g][q] = m.committed[g][q];
          }
          expect(crash(s, g, rec)).toBe(again);
          // A crash never loses a record: the group is only ever moved back.
          expect(uncommitted(s, g)).toBe(0);
        } else {
          const kept = m.all[p].length - m.start[p];
          let skipped = 0;
          if (kept >= SEGMENT) {
            m.start[p] += SEGMENT;
            for (const h of GROUPS) {
              if (m.position[h][p] < m.start[p]) {
                skipped += m.start[p] - m.position[h][p];
                m.position[h][p] = m.start[p];
              }
              m.committed[h][p] = Math.max(m.committed[h][p], m.start[p]);
            }
          }
          expect(trim(s, p, rec)).toBe(skipped);
          expect(rec.counters.skipped ?? 0).toBe(skipped);
          skips += skipped;
        }
        if (i % 25 === 0) verify(s, m);
      }
      verify(s, m);
      expect(repeats).toBeGreaterThan(20);
      expect(skips).toBeGreaterThan(20);
      for (const g of GROUPS) {
        expect(lag(s, g)).toBe(m.all.reduce((sum, all, p) => sum + all.length - m.position[g][p], 0));
      }
    });
  }

  it('keeps every record with one key in one partition, in the order produced', () => {
    const rnd = makeRng(7);
    const s = create(3, 1_000_000);
    const sent = new Map<number, number[]>();
    for (let i = 0; i < 600; i++) {
      const key = Math.floor(rnd() * 12);
      const placed = produce(s, key, quiet(s))!;
      sent.set(key, [...(sent.get(key) ?? []), placed.offset]);
      expect(placed.partition).toBe(partitionOf(key, 3));
    }
    for (const [key, offsets] of sent) {
      const part = s.partitions[partitionOf(key, 3)];
      // Offsets for a key only ever go up, and reading the partition meets them in that order.
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      expect(part.records.flatMap((k, i) => (k === key ? [i] : []))).toEqual(offsets);
    }
  });

  it('reading removes nothing: both groups read the same records in the same order', () => {
    const s = create(2);
    for (const k of [42, 7, 42, 21]) produce(s, k, quiet(s));
    const before = JSON.stringify(s.partitions);
    const read = (g: GroupId) => {
      const out: number[] = [];
      for (let k = consume(s, g, 0, quiet(s)); k !== null; k = consume(s, g, 0, quiet(s))) out.push(k);
      return out;
    };
    expect(read('a')).toEqual([42, 7, 42, 21]);
    expect(JSON.stringify(s.partitions)).toBe(before);
    expect(read('b')).toEqual([42, 7, 42, 21]);
    expect(JSON.stringify(s.partitions)).toBe(before);
  });

  it('a crash re-delivers exactly the uncommitted records, and says it is at-least-once', () => {
    const s = create(3);
    for (const k of [42, 42, 42, 42]) produce(s, k, quiet(s));
    consume(s, 'a', 0, quiet(s));
    commit(s, 'a', quiet(s));
    consume(s, 'a', 0, quiet(s));
    consume(s, 'a', 0, quiet(s));
    const rec = loud(s);
    expect(crash(s, 'a', rec)).toBe(2);
    checkFrames(rec.frames);
    expect(s.groups.a.position[0]).toBe(1);
    expect(s.groups.a.committed[0]).toBe(1);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/at-least-once/);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/idempotent/);
    // The two records that will repeat are shown as already visited.
    const rewind = rec.frames.find((f) => f.lines?.includes('rewind'))!;
    const tones = [0, 1, 2, 3, 4].map((o) => rewind.scene.nodes.find((n) => n.id === `p0o${o}`)!.tone);
    expect(tones).toEqual([undefined, 'path', 'path', undefined, undefined]);
    // Group B is untouched by A's crash.
    expect(s.groups.b.position).toEqual([0, 0, 0]);

    const again = loud(s);
    expect(consume(s, 'a', 0, again)).toBe(42);
    expect(again.counters).toEqual({ comparisons: 1, reads: 1, redelivered: 1 });
    expect(again.frames.some((f) => /at-least-once/.test(f.message))).toBe(true);
    const next = quiet(s);
    consume(s, 'a', 0, next);
    expect(next.counters.redelivered).toBe(1);
    // Past the point it had reached before, a read is new again.
    const fresh = quiet(s);
    consume(s, 'a', 0, fresh);
    expect(fresh.counters.redelivered).toBeUndefined();
  });

  it('trim drops the oldest segment whether or not it was read, and moves a slow group past it', () => {
    const s = create(3);
    for (const k of [42, 42, 42, 42, 42]) produce(s, k, quiet(s));
    for (let i = 0; i < 3; i++) consume(s, 'a', 0, quiet(s));
    const rec = loud(s);
    expect(trim(s, 0, rec)).toBe(2);
    checkFrames(rec.frames);
    expect(s.partitions[0]).toEqual({ start: 2, records: [42, 42, 42] });
    // A had read past the segment: its position stays, its stale commit moves up. B loses both records.
    expect(s.groups.a.position[0]).toBe(3);
    expect(s.groups.a.committed[0]).toBe(2);
    expect(s.groups.b.position[0]).toBe(2);
    expect(s.groups.b.committed[0]).toBe(2);
    expect(rec.counters).toEqual({ comparisons: 2, skipped: 2 });
    for (const id of ['p0o0', 'p0o1']) {
      expect(rec.frames[0].scene.nodes.find((n) => n.id === id)!.tone).toBe('bad');
      expect(rec.frames[1].scene.nodes.some((n) => n.id === id)).toBe(false);
    }
    // The segment's tray goes with it, and the records that stay keep their ids, so they slide to the front.
    expect(rec.frames[0].scene.decor!.some((d) => d.id === 'p0s0')).toBe(true);
    expect(rec.frames[1].scene.decor!.some((d) => d.id === 'p0s0')).toBe(false);
    const x = (i: number) => rec.frames[i].scene.nodes.find((n) => n.id === 'p0o2')!.x;
    expect(x(1)).toBeLessThan(x(0));
    expect(rec.frames.some((f) => f.lines?.includes('stale'))).toBe(true);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/group B missed 2/);
    // Offsets are never reused.
    expect(produce(s, 42, quiet(s))).toEqual({ partition: 0, offset: 5 });
    // B carries on from the new start.
    expect(consume(s, 'b', 0, quiet(s))).toBe(42);
    expect(s.groups.b.position[0]).toBe(3);
    verify(s);
  });

  it('never trims a segment that is not full', () => {
    const s = create(3);
    produce(s, 42, quiet(s));
    const rec = loud(s);
    expect(trim(s, 0, rec)).toBe(0);
    expect(s.partitions[0].records).toEqual([42]);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].lines).toEqual(['oldest', 'keep']);
    expect(rec.counters).toEqual({});
    // Two records fill a segment; trimming it leaves the partition empty with its offsets intact.
    produce(s, 42, quiet(s));
    const full = loud(s);
    expect(trim(s, 0, full)).toBe(4);
    checkFrames(full.frames);
    expect(s.partitions[0]).toEqual({ start: 2, records: [] });
    expect(full.frames[full.frames.length - 1].message).toMatch(/empty/);
    expect(produce(s, 42, quiet(s))).toEqual({ partition: 0, offset: 2 });
  });

  it('stops politely at the page limit and changes nothing', () => {
    const s = create(3);
    for (let i = 0; i < MAX_RECORDS; i++) expect(produce(s, 42, quiet(s))).not.toBeNull();
    const before = JSON.stringify(s);
    const rec = loud(s);
    expect(produce(s, 42, rec)).toBeNull();
    expect(JSON.stringify(s)).toBe(before);
    expect(rec.counters).toEqual({});
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/Sorry/);
    checkFrames(rec.frames);
    // A full partition still fits the scene, with its end slot.
    const b = sceneBounds(layout(s))!;
    expect(b.bw).toBeLessThanOrEqual(950);
  });

  it('answers a group or partition that does not exist without changing anything', () => {
    const s = create(3);
    produce(s, 42, quiet(s));
    const before = JSON.stringify(s);
    const runs: ((rec: Recorder<LogState>) => unknown)[] = [
      (rec) => consume(s, 'c', 0, rec),
      (rec) => consume(s, 'a', 3, rec),
      (rec) => commit(s, 'zebra', rec),
      (rec) => crash(s, 7, rec),
      (rec) => trim(s, 9, rec),
    ];
    for (const run of runs) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
    // Group names are accepted in either case.
    expect(consume(s, 'A', 0, quiet(s))).toBe(42);
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    for (const partitions of [2, 3, 4]) {
      const a = create(partitions);
      const b = create(partitions);
      const pick = (n: number) => Math.floor(rnd() * n);
      for (let i = 0; i < 400; i++) {
        const on = loud(a);
        const off = quiet(b);
        const roll = rnd();
        const g = GROUPS[pick(2)];
        const p = pick(partitions);
        if (roll < 0.3) {
          const key = pick(30);
          expect(produce(a, key, on)).toEqual(produce(b, key, off));
        } else if (roll < 0.65) expect(consume(a, g, p, on)).toBe(consume(b, g, p, off));
        else if (roll < 0.77) expect(commit(a, g, on)).toBe(commit(b, g, off));
        else if (roll < 0.87) expect(crash(a, g, on)).toBe(crash(b, g, off));
        else expect(trim(a, p, on)).toBe(trim(b, p, off));
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        verify(a);
      }
    }
  });

  it('draws each tag under the offset it holds, and offsets under every record', () => {
    const rnd = makeRng(99);
    const s = create(3);
    const pick = (n: number) => Math.floor(rnd() * n);
    for (let i = 0; i < 500; i++) {
      const roll = rnd();
      const g = GROUPS[pick(2)];
      if (roll < 0.35) produce(s, pick(30), quiet(s));
      else if (roll < 0.7) consume(s, g, pick(3), quiet(s));
      else if (roll < 0.8) commit(s, g, quiet(s));
      else if (roll < 0.9) crash(s, g, quiet(s));
      else trim(s, pick(3), quiet(s));
      const scene = layout(s);
      const tags = scene.nodes.filter((n) => n.shape === 'tag');
      expect(tags.length).toBe(3 * 2 * 2);
      s.partitions.forEach((part, p) => {
        for (const g2 of GROUPS) {
          expect(tagOffset(scene, `t${p}${g2}pos`)).toBe(s.groups[g2].position[p]);
          expect(tagOffset(scene, `t${p}${g2}commit`)).toBe(s.groups[g2].committed[p]);
        }
        // Record cells carry their keys, and the labels under them count up from the start of the log.
        const cells = scene.nodes.filter((n) => n.id.startsWith(`p${p}o`)).sort((x, y) => x.x - y.x).flatMap((n) => n.cells);
        // One tray for each segment that holds a record.
        expect(scene.decor!.filter((d) => d.type === 'band' && d.id.startsWith(`p${p}s`)).length).toBe(Math.ceil(part.records.length / SEGMENT));
        expect(cells.filter((c) => c.text !== '').map((c) => Number(c.text))).toEqual(part.records);
        cells.forEach((c, j) => expect(c.sub).toBe(String(part.start + j)));
        // There is always a slot drawn for the end of the log, where the next record will go.
        expect(cells[cells.length - 1]).toMatchObject({ text: '', sub: String(endOf(part)) });
      });
    }
  });

  it('keeps the scene the same size whatever the partitions hold', () => {
    for (const partitions of [2, 3, 4]) {
      const s = create(partitions);
      const empty = sceneBounds(layout(s))!;
      for (let k = 0; k < 400; k++) produce(s, k, quiet(s));
      const full = sceneBounds(layout(s))!;
      expect(full).toEqual(empty);
      expect(full.bw).toBeLessThanOrEqual(950);
    }
  });

  it('follows the key: a probe on every frame after the hash, a write marked as the key', () => {
    const s = create(3);
    const rec = loud(s);
    expect(produce(s, 42, rec)).toEqual({ partition: 0, offset: 0 });
    checkFrames(rec.frames);
    expect(rec.frames.map((f) => f.lines)).toEqual([['hash'], ['pick'], ['offset'], ['append'], ['done']]);
    expect(rec.frames[0].message).toContain('31 × 42 + 7 = 1309');
    expect(rec.frames[0].message).toContain('1309 mod 1009 = 300');
    expect(rec.frames[1].message).toContain('300 mod 3 = 0');
    expect(rec.frames.slice(1).every((f) => f.probe?.text === '42')).toBe(true);
    expect(rec.frames[1].probe!.at).toBe('h0');
    // The empty slot at the end of the log is the slot the record fills.
    expect(rec.frames[2].probe!.at).toBe('p0o0');
    expect(rec.frames[2].scene.nodes.find((n) => n.id === 'p0o0')!.cells[0].text).toBe('');
    expect(rec.frames[3].probe).toEqual({ text: '42', at: 'p0o0' });
    expect(rec.frames[3].scene.nodes.find((n) => n.id === 'p0o0')).toMatchObject({ tone: 'key', cells: [{ text: '42' }] });
  });

  it('every operation has a listing in both languages with the anchors its frames name', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    for (const param of def.params![0].options) {
      const s = def.create({ partitions: param.value });
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[], recording: boolean) => {
        const rec = new Recorder(s, def.layout, recording);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        checkFrames(rec.frames);
      };
      for (const [id, ...args] of def.seedFor!({ partitions: param.value })) run(id, args, false);
      for (const [id, ...args] of def.tour) run(id, args, true);
      for (let round = 0; round < 40; round++) for (const op of def.ops) run(op.id, op.suggest!(s), true);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
      verify(s);
    }
  });

  it('seed and tour run cleanly through the definition and tell the story in order', () => {
    expect(def.id).toBe('append-log');
    expect(def.bench).toBeUndefined();
    const s = def.create({ partitions: 3 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const rec = new Recorder(s, def.layout, recording);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    verify(s);
    expect(s.partitions.map((part) => part.records)).toEqual([[42, 8], [6, 21, 6], [16, 7]]);
    expect(SEED_KEYS.length).toBe(7);
    // Group A is caught up and committed on partition 0. Group B has not started there.
    expect(s.groups.a.position).toEqual([2, 2, 1]);
    expect(s.groups.a.committed).toEqual([2, 2, 1]);
    expect(s.groups.b.position).toEqual([0, 1, 0]);
    expect(partitionOf(TOUR_KEY, 3)).toBe(0);
    expect(partitionOf(TOUR_OTHER, 3)).toBe(2);

    const recs = def.tour.map(([id, ...args]) => {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      verify(s);
      return rec;
    });
    expect(def.tour.map(([id]) => id)).toEqual(['produce', 'produce', 'produce', 'consume', 'commit', 'consume', 'crash', 'consume', 'produce']);
    // Three records, two keys, each key in order on its own partition.
    expect(recs[0].frames[recs[0].frames.length - 1].message).toContain('partition 0, offset 2');
    expect(recs[1].frames[recs[1].frames.length - 1].message).toContain('partition 2, offset 2');
    expect(recs[2].frames[recs[2].frames.length - 1].message).toContain('partition 0, offset 3');
    // Read offset 2, commit it, read offset 3, crash, read offset 3 again.
    expect(recs[3].counters).toEqual({ comparisons: 1, reads: 1 });
    expect(recs[5].counters).toEqual({ comparisons: 1, reads: 1 });
    expect(recs[6].frames[recs[6].frames.length - 1].message).toMatch(/read 1 record a second time.*at-least-once/);
    expect(recs[7].counters).toEqual({ comparisons: 1, reads: 1, redelivered: 1 });
    // The same key again lands after the others.
    expect(recs[8].frames[recs[8].frames.length - 1].message).toContain('after the earlier 42 at offsets 0, 2 and 3');
    expect(s.partitions[0].records).toEqual([42, 8, 42, 42, 42]);
    expect(s.groups.a.position[0]).toBe(4);
    expect(s.groups.a.committed[0]).toBe(3);
    expect(def.status!(s)).toEqual([
      { label: 'Records kept', value: '11' },
      { label: 'Next offsets', value: '5, 3, 3' },
      { label: 'Group A', value: '4 behind, 1 uncommitted' },
      { label: 'Group B', value: '10 behind, 0 uncommitted' },
    ]);
  });

  it('the seed and the tour fit the page for every number of partitions', () => {
    for (const partitions of [1, 2, 3]) {
      const s = def.create({ partitions });
      const seed = def.seedFor!({ partitions });
      // Every consume in the seed reads a partition that exists, and reads a record.
      for (const [id, , p] of seed) if (id === 'consume') expect(Number(p)).toBeLessThan(partitions);
      for (const [id, ...args] of seed) {
        const rec = new Recorder(s, def.layout, false);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        if (id === 'consume') expect(rec.counters.reads).toBe(1);
      }
      for (const [id, ...args] of def.tour) {
        const rec = new Recorder(s, def.layout, true);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        expect(rec.frames.some((f) => /Sorry/.test(f.message))).toBe(false);
        checkFrames(rec.frames);
      }
      verify(s);
      // Every tour record was stored: the tour key always hashes to partition 0.
      expect(partitionOf(TOUR_KEY, partitions)).toBe(0);
      const produced = seed.filter(([id]) => id === 'produce').length;
      expect(s.partitions.reduce((sum, part) => sum + part.records.length, 0)).toBe(produced + 4);
    }
  });

  it('suggests arguments the form accepts, and fill never overfills a partition', () => {
    const s = def.create({ partitions: 3 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, new Recorder(s, def.layout, false));
    for (let i = 0; i < 60; i++) {
      for (const op of def.ops) {
        const args = op.suggest!(s);
        expect(args.length).toBe(op.args.length);
        op.args.forEach((a, j) => {
          if (a.kind === 'int') {
            expect(Number.isInteger(args[j])).toBe(true);
            expect(args[j] as number).toBeGreaterThanOrEqual(a.min ?? 0);
            expect(args[j] as number).toBeLessThanOrEqual(a.max ?? 999);
          } else expect(String(args[j])).toMatch(/^[a-z]{1,12}$/);
        });
      }
      const [id, ...args] = def.fill!(s);
      def.ops.find((o) => o.id === id)!.run(s, args, new Recorder(s, def.layout, false));
      verify(s);
    }
    expect(s.partitions.every((part) => part.records.length === MAX_RECORDS)).toBe(true);
  });
});
