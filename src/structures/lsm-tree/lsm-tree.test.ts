import { describe, expect, it } from 'vitest';
import { probeWidth } from '../../core/fit';
import { cellCentre, nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  L0_LIMIT,
  MEM_CAP,
  TABLE_CAP,
  compact,
  create,
  flush,
  get,
  layout,
  liveKeys,
  put,
  remove,
  tableLimit,
  writeAmp,
  type Entry,
  type LsmState,
} from './index';

const quiet = (s: LsmState) => new Recorder(s, layout, false);
const loud = (s: LsmState) => new Recorder(s, layout, true);

const sortedStrictly = (entries: Entry[]) => entries.every((e, i) => i === 0 || entries[i - 1].k < e.k);

/** Throws if any LSM tree invariant is broken. Valid after every finished operation. */
function check(s: LsmState): void {
  // Memtable: sorted, one entry per key, and flushed before it can sit full.
  expect(s.mem.length).toBeLessThan(MEM_CAP);
  expect(sortedStrictly(s.mem)).toBe(true);
  expect(s.merge).toBeNull();
  expect(s.levels.length).toBeGreaterThanOrEqual(3);
  expect(s.view.length).toBe(s.levels.length);

  const ids = new Set<number>();
  s.levels.forEach((tables, lv) => {
    for (const t of tables) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.entries.length).toBeGreaterThan(0);
      expect(t.entries.length).toBeLessThanOrEqual(lv === 0 ? MEM_CAP : TABLE_CAP);
      expect(sortedStrictly(t.entries)).toBe(true);
    }
    if (lv === 0) {
      // Compaction runs as soon as level 0 reaches its limit.
      expect(tables.length).toBeLessThan(L0_LIMIT);
      return;
    }
    expect(tables.length).toBeLessThanOrEqual(tableLimit(lv));
    // One sorted run: each table starts after the one before it ends.
    for (let i = 1; i < tables.length; i++) {
      const prev = tables[i - 1].entries;
      expect(prev[prev.length - 1].k).toBeLessThan(tables[i].entries[0].k);
    }
  });
  // Nothing can hide below the last level, so no tombstone is ever kept there.
  for (const t of s.levels[s.levels.length - 1]) expect(t.entries.some((e) => e.del)).toBe(false);
}

const shape = (s: LsmState) => ({
  mem: s.mem.map((e) => `${e.k}${e.del ? 'x' : ''}`),
  levels: s.levels.map((l) => l.map((t) => t.entries.map((e) => `${e.k}${e.del ? 'x' : ''}`).join(' '))),
  userWrites: s.userWrites,
  diskWrites: s.diskWrites,
});

interface Box {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function boxes(scene: Scene): Box[] {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

const overlap = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/**
 * Unique ids, a probe that points at a real cell, nodes that do not overlap each other or leave their lane,
 * and a probe chip that covers nothing. Plain throws: this runs on thousands of frames.
 */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const where = ` in "${f.message}"`;
    if (!f.message || /undefined|NaN|—|\b0 (comparisons|entries|tables|SSTables)\b/.test(f.message)) throw new Error(`bad message "${f.message}"`);
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    if (ids.size !== f.scene.nodes.length) throw new Error(`duplicate node id${where}`);
    const all = boxes(f.scene);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (overlap(all[i], all[j])) throw new Error(`${all[i].id} overlaps ${all[j].id}${where}`);
      }
    }
    const bands = (f.scene.decor ?? []).filter((d) => d.type === 'band');
    for (const b of all) {
      const inside = bands.some((d) => d.type === 'band' && b.x1 >= d.x && b.x2 <= d.x + d.w && b.y1 >= d.y && b.y2 <= d.y + d.h);
      if (!inside) throw new Error(`${b.id} is not inside a lane${where}`);
    }
    if (f.probe) {
      const node = f.scene.nodes.find((n) => n.id === f.probe!.at);
      if (!node) throw new Error(`probe points at missing node ${f.probe.at}${where}`);
      if (f.probe.cell != null && f.probe.cell >= node.cells.length) throw new Error(`probe points at missing cell ${f.probe.cell}${where}`);
      // The chip as the renderer draws it: 26 high, 9 above the node, centred on the cell.
      const { w, h } = nodeSize(node);
      const cx = f.probe.cell != null ? node.x - w / 2 + cellCentre(node.cells, f.probe.cell) : node.x;
      const cw = probeWidth(f.probe.text);
      const chip: Box = { id: 'probe', x1: cx - cw / 2, x2: cx + cw / 2, y1: node.y - h / 2 - 35, y2: node.y - h / 2 - 9 };
      for (const b of all) if (overlap(chip, b)) throw new Error(`the probe chip covers ${b.id}${where}`);
    }
  }
}

describe('LSM tree', () => {
  for (const seed of [1, 7, 2026]) {
    it(`agrees with a Set through random puts, deletes, gets, flushes and compactions (seed ${seed})`, () => {
      const rnd = makeRng(seed * 7919);
      const s = create();
      const model = new Set<number>();
      let diskWrites = 0;
      for (let i = 0; i < 6000; i++) {
        const k = Math.floor(rnd() * 300);
        const r = rnd();
        const rec = quiet(s);
        if (r < 0.42) {
          put(s, k, rec);
          model.add(k);
        } else if (r < 0.64) {
          remove(s, k, rec);
          model.delete(k);
        } else if (r < 0.92) {
          expect(get(s, k, rec) === 'found').toBe(model.has(k));
        } else if (r < 0.96) {
          flush(s, rec);
        } else {
          compact(s, rec);
        }
        diskWrites += rec.counters.writes ?? 0;
        if (i % 40 === 0) check(s);
      }
      check(s);
      expect(s.diskWrites).toBe(diskWrites);
      expect(liveKeys(s)).toEqual([...model].sort((a, b) => a - b));
      for (let k = 0; k < 300; k++) expect(get(s, k, quiet(s)) === 'found').toBe(model.has(k));
    });
  }

  it('grows new levels as it fills and never keeps more tables in a level than its limit', () => {
    const rnd = makeRng(5);
    const s = create();
    const keys = Array.from({ length: 1000 }, (_, i) => i);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    keys.forEach((k, i) => {
      put(s, k, quiet(s));
      if (i % 25 === 0) check(s);
    });
    check(s);
    expect(s.levels.length).toBeGreaterThan(3);
    expect(liveKeys(s)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    for (const k of [0, 1, 499, 998, 999]) expect(get(s, k, quiet(s))).toBe('found');
    expect(get(s, 1000, quiet(s))).toBe('missing');
    // Deleting everything and compacting to the bottom leaves nothing on disk at all.
    for (const k of keys) remove(s, k, quiet(s));
    flush(s, quiet(s));
    for (let i = 0; i < 20; i++) compact(s, quiet(s));
    check(s);
    expect(liveKeys(s)).toEqual([]);
    expect(s.levels.every((l) => l.length === 0)).toBe(true);
  });

  it('gives the same state, results and counters with recording on and off', () => {
    const rnd = makeRng(99);
    const a = create();
    const b = create();
    for (let i = 0; i < 1500; i++) {
      // Three-digit keys now and then, to exercise the wider cells.
      const k = rnd() < 0.15 ? 100 + Math.floor(rnd() * 900) : Math.floor(rnd() * 90);
      const r = rnd();
      const on = loud(a);
      const off = quiet(b);
      if (r < 0.45) {
        put(a, k, on);
        put(b, k, off);
      } else if (r < 0.65) {
        remove(a, k, on);
        remove(b, k, off);
      } else if (r < 0.9) {
        expect(get(a, k, on)).toBe(get(b, k, off));
      } else if (r < 0.95) {
        flush(a, on);
        flush(b, off);
      } else {
        compact(a, on);
        compact(b, off);
      }
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(shape(a)).toEqual(shape(b));
      if (i % 25 === 0) check(a);
    }
    check(a);
    check(b);
    expect(a.levels.length).toBeGreaterThan(3);
  });

  it('reads the memtable, then level 0 newest first, then one table per deeper level', () => {
    const s = create();
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    check(s);
    expect(shape(s)).toMatchObject({
      mem: ['16', '39', '64'],
      levels: [['20 27 54x', '12 33 61'], ['9 18 27 36', '45 54 72 90'], ['5 14 23 31', '42 58 67 76']],
    });

    // In the memtable: no table is read.
    let rec = loud(s);
    expect(get(s, 39, rec)).toBe('found');
    expect(rec.counters).toEqual({ comparisons: 2 });
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/No SSTable was read/);

    // In the last level: one L0 table is skipped by its range, one is read for nothing, then one table each in L1 and L2.
    rec = loud(s);
    expect(get(s, 58, rec)).toBe('found');
    expect(rec.counters.reads).toBe(3);
    expect(rec.frames.filter((f) => f.compare).length).toBe(rec.counters.comparisons);
    expect(rec.frames.some((f) => /skip it/.test(f.message))).toBe(true);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/after reading 3 SSTables, 2 of them for nothing/);
    // The probe visits the lanes top to bottom and never goes back up.
    const lanes = rec.frames.filter((f) => f.probe).map((f) => f.scene.nodes.find((n) => n.id === f.probe!.at)!.y);
    expect(lanes).toEqual([...lanes].sort((x, y) => x - y));
    expect(new Set(lanes).size).toBe(4);

    // The newer copy in level 0 hides the older one in level 1.
    rec = quiet(s);
    expect(get(s, 27, rec)).toBe('found');
    expect(rec.counters.reads).toBe(1);

    // A tombstone in level 0 ends the search before the live copy in level 1 is reached.
    rec = loud(s);
    expect(get(s, 54, rec)).toBe('deleted');
    expect(rec.counters.reads).toBe(1);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/tombstone.*after reading 1 SSTable/);

    // Outside every key range: proved absent without reading a single table.
    rec = loud(s);
    expect(get(s, 99, rec)).toBe('missing');
    expect(rec.counters.reads).toBeUndefined();
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/no SSTable was read/);
  });

  it('keeps a tombstone until it reaches the last level, then drops it with the key', () => {
    const s = create();
    for (const k of [10, 20, 30, 40]) put(s, k, quiet(s)); // flushed to L0
    compact(s, quiet(s)); // L0 to L1
    compact(s, quiet(s)); // L1 to L2, the last level
    expect(shape(s).levels).toEqual([[], [], ['10 20 30 40']]);

    remove(s, 20, quiet(s));
    expect(get(s, 20, quiet(s))).toBe('deleted');
    expect(liveKeys(s)).toEqual([10, 30, 40]);
    flush(s, quiet(s));
    expect(shape(s).levels[0]).toEqual(['20x']);
    expect(get(s, 20, quiet(s))).toBe('deleted');

    // Into L1 the tombstone survives: the 20 it hides is still below, in L2.
    compact(s, quiet(s));
    expect(shape(s).levels).toEqual([[], ['20x'], ['10 20 30 40']]);
    // Into the last level both the tombstone and the old copy go.
    const rec = loud(s);
    compact(s, rec);
    expect(shape(s).levels).toEqual([[], [], ['10 30 40']]);
    expect(rec.frames.some((f) => /can finally be dropped/.test(f.message))).toBe(true);
    expect(get(s, 20, quiet(s))).toBe('missing');
    check(s);
  });

  it('moves a lone run down without rewriting it, unless tombstones would reach the last level', () => {
    const s = create();
    for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) put(s, k, quiet(s));
    compact(s, quiet(s)); // a real merge of two L0 tables
    const before = s.diskWrites;
    const ids = s.levels[1].map((t) => t.id);
    const rec = loud(s);
    compact(s, rec); // nothing in L2 to merge with
    expect(s.diskWrites).toBe(before);
    expect(rec.counters.writes).toBeUndefined();
    expect(s.levels[2].map((t) => t.id)).toEqual(ids);
    expect(rec.frames.some((f) => /trivial move/.test(f.message))).toBe(true);
    checkFrames(rec.frames);

    // Start again, with a tombstone in the run that is about to become the last level.
    const t = create();
    put(t, 1, quiet(t));
    remove(t, 2, quiet(t));
    flush(t, quiet(t));
    compact(t, quiet(t));
    expect(shape(t).levels).toEqual([[], ['1 2x'], []]);
    compact(t, quiet(t));
    expect(shape(t).levels).toEqual([[], [], ['1']]);
    check(t);
  });

  it('counts write amplification as entries written to disk per put or delete', () => {
    const s = create();
    expect(writeAmp(s)).toBe(0);
    for (const k of [1, 2, 3]) put(s, k, quiet(s));
    expect(writeAmp(s)).toBe(0);
    const rec = quiet(s);
    put(s, 4, rec); // fills the memtable, so it is flushed
    expect(rec.counters.writes).toBe(4);
    expect(writeAmp(s)).toBe(1);
    for (let k = 5; k <= 16; k++) put(s, k, quiet(s)); // the fourth flush sets off a compaction
    expect(shape(s).levels[0]).toEqual([]);
    expect(s.diskWrites).toBe(32);
    expect(writeAmp(s)).toBe(2);
  });

  it('treats a put or delete of a key already in the memtable as an overwrite, not a second entry', () => {
    const s = create();
    put(s, 7, quiet(s));
    put(s, 7, quiet(s));
    expect(shape(s).mem).toEqual(['7']);
    remove(s, 7, quiet(s));
    remove(s, 7, quiet(s));
    expect(shape(s).mem).toEqual(['7x']);
    expect(get(s, 7, quiet(s))).toBe('deleted');
    put(s, 7, quiet(s));
    expect(shape(s).mem).toEqual(['7']);
    expect(get(s, 7, quiet(s))).toBe('found');
  });

  it('takes 100,000 inserts with recording off without going quadratic', () => {
    const n = 100_000;
    const rnd = makeRng(3);
    const keys = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const s = def.create({});
    const insert = def.ops.find((o) => o.id === def.bench!.insert)!;
    const search = def.ops.find((o) => o.id === def.bench!.search)!;
    const ins = quiet(s);
    const t0 = performance.now();
    for (const k of keys) insert.run(s, [k], ins);
    const ms = performance.now() - t0;
    check(s);
    // About 0.4 s on a laptop. The work per insert is the real guard: it grows with the number of levels, not with n.
    expect(ms).toBeLessThan(4000);
    expect(ins.counters.writes / n).toBeLessThan(30);
    expect(ins.counters.comparisons / n).toBeLessThan(40);
    const look = quiet(s);
    for (let i = 0; i < 500; i++) search.run(s, [keys[Math.floor(rnd() * n)]], look);
    expect(look.counters.reads / 500).toBeLessThanOrEqual(L0_LIMIT - 1 + s.levels.length - 1);
    expect(get(s, keys[0], quiet(s))).toBe('found');
    expect(get(s, n + 1, quiet(s))).toBe('missing');
  });

  it('seed and tour run cleanly through the definition', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    // The starting picture: a part-full memtable, two L0 tables, and data in L1 and L2.
    expect(s.mem.length).toBe(3);
    expect(s.levels.map((l) => l.length)).toEqual([2, 2, 2]);
    checkFrames([{ scene: def.layout(s), message: 'rest', counters: {} }]);
    for (const f of def.status!(s)) expect(f.value).not.toMatch(/NaN|undefined/);

    const seen: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      checkFrames(rec.frames);
      check(s);
      seen.push(rec.frames.map((f) => f.message).join(' '));
    }
    const all = seen.join(' ');
    expect(seen[0]).toMatch(/Found 39 in the memtable/);
    expect(seen[1]).toMatch(/Found 58 in L2/);
    expect(seen[2]).toMatch(/Flushed/);
    expect(seen[3]).toMatch(/Merge sort/);
    expect(seen[5]).toMatch(/tombstone for 23/);
    expect(all).toMatch(/Bloom filter/);
    expect(all).toMatch(/write-ahead log/);

    // Suggestions and fill give arguments the ops accept.
    for (const op of def.ops) {
      const args = op.suggest?.(s) ?? [];
      expect(args.length).toBe(op.args.length);
      for (const a of args) expect(Number.isInteger(a)).toBe(true);
    }
    for (let i = 0; i < 40; i++) {
      const [id, ...args] = def.fill!(s);
      run(id, args, false);
    }
    check(s);
    checkFrames([{ scene: def.layout(s), message: 'filled', counters: {} }]);
  });
});
