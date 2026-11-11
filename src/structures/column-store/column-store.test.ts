import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { PROBE_H, TITLE_ROOM, probeWidth } from '../../core/fit';
import { cellCentre, nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  COLS,
  COUNTRIES,
  FLUSH_ROWS,
  MAX_GROUPS,
  PRODUCTS,
  allRows,
  append,
  bitmap,
  chunk,
  columnBytes,
  create,
  encode,
  encodeChunk,
  fileRows,
  layout,
  maxOf,
  minOf,
  reset,
  sum,
  type StoreState,
} from './index';

const quiet = (s: StoreState) => new Recorder(s, layout, false);
const loud = (s: StoreState) => new Recorder(s, layout, true);

function corners(scene: Scene): { x1: number; x2: number; y1: number; y2: number } {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Invariants of the store itself. */
function check(s: StoreState): void {
  expect(s.groups.length).toBeLessThanOrEqual(MAX_GROUPS);
  expect(s.buffer.length).toBeLessThan(FLUSH_ROWS);
  if (s.groups.length === MAX_GROUPS) expect(s.buffer.length).toBe(0);
  for (const g of s.groups) {
    expect(g.length).toBeGreaterThan(0);
    // Each row group is in country order inside.
    const c = chunk(g, 'country') as string[];
    expect(c).toEqual([...c].sort());
  }
  const ids = allRows(s).map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(s.encoded).size).toBe(s.encoded.length);
}

/** Unique ids, a probe on a real node with room for it, code lines, nothing overlapping, magenta only on the followed value. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|\[object|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
      // The chip sits above its node, clear of every other node and inside the scene.
      const { w, h } = nodeSize(at!);
      const cx = f.probe.cell != null ? at!.x - w / 2 + cellCentre(at!.cells, f.probe.cell) : at!.x;
      const cy = at!.y - h / 2 - PROBE_H / 2 - 9 - (at!.title ? TITLE_ROOM : 0);
      const pw = probeWidth(f.probe.text);
      const chip = { x1: cx - pw / 2, x2: cx + pw / 2, y1: cy - PROBE_H / 2, y2: cy + PROBE_H / 2 };
      expect(chip.y1, `chip above ${at!.id} is off the top`).toBeGreaterThanOrEqual(edge.y1 - 12);
      for (const b of boxes) {
        const hit = chip.x1 < b.x2 && b.x1 < chip.x2 && chip.y1 < b.y2 && b.y1 < chip.y2;
        if (hit) throw new Error(`chip at ${at!.id} covers ${b.id}`);
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 12) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      // Magenta only ever marks the value being followed.
      expect(n.tone).not.toBe('key');
      for (const c of n.cells) if (c.tone === 'key') expect(c.text).toBe(f.probe?.text);
    }
    // The view never rescales.
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

type Model = { country: string; product: string; amount: number }[];
const modelOf = (s: StoreState): Model => allRows(s).map(({ country, product, amount }) => ({ country, product, amount }));
const naiveSum = (m: Model, x: string) => m.filter((r) => r.country === x).reduce((a, r) => a + r.amount, 0);
const naiveCount = (m: Model, x: string, y: string) => m.filter((r) => r.country === x && r.product === y).length;

describe('column store', () => {
  it('both layouts agree with a plain scan, under thousands of random operations', () => {
    const rnd = makeRng(2024);
    const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    let skippedSeen = 0;
    for (const setting of ['row', 'column'] as const) {
      const s = create(setting);
      for (let i = 0; i < 3000; i++) {
        const roll = rnd();
        const rec = quiet(s);
        const before = modelOf(s);
        if (roll < 0.35) {
          const x = pickOf([...COUNTRIES, 'PL', 'AA', 'ZZ']);
          const lay = pickOf(['row', 'column', '']);
          expect(sum(s, x, lay, rec)).toBe(naiveSum(before, x));
          const n = before.length;
          if ((lay || setting) === 'row') {
            expect(rec.counters.values).toBe(n * 4);
            expect(rec.counters.bytes).toBe(n * 16);
          } else {
            // Never more than two columns of every row.
            expect(rec.counters.values ?? 0).toBeLessThanOrEqual(n * 2);
            expect(rec.counters.bytes ?? 0).toBeLessThan(n * 16);
            skippedSeen += rec.counters.skipped ?? 0;
          }
        } else if (roll < 0.55) {
          const x = pickOf([...COUNTRIES, 'PL']);
          const y = pickOf([...PRODUCTS, 'bun']);
          expect(bitmap(s, x, y, rec)).toBe(naiveCount(before, x, y));
        } else if (roll < 0.75) {
          const col = pickOf(COLS);
          const was = s.encoded.includes(col);
          expect(encode(s, col, rec)).toBe(!was);
          expect(s.encoded).toContain(col);
          // Encoding changes how the column is stored, never what it holds.
          expect(modelOf(s)).toEqual(before);
        } else if (roll < 0.97) {
          const x = pickOf(COUNTRIES);
          const y = pickOf(PRODUCTS);
          const amount = 1 + Math.floor(rnd() * 99);
          const full = s.groups.length >= MAX_GROUPS;
          const groups = s.groups.length;
          expect(append(s, x, y, amount, rec)).toBe(!full);
          if (full) expect(modelOf(s)).toEqual(before);
          else {
            expect(modelOf(s).length).toBe(before.length + 1);
            expect(naiveSum(modelOf(s), x)).toBe(naiveSum(before, x) + amount);
            // A flush adds a file and leaves the old ones as they were.
            expect(rec.counters.files ?? 0).toBe(s.groups.length - groups);
          }
        } else {
          reset(s, rec);
          expect(s).toEqual(create(setting));
        }
        check(s);
      }
    }
    expect(skippedSeen).toBeGreaterThan(100);
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(77);
    for (const setting of ['row', 'column'] as const) {
      const a = create(setting);
      const b = create(setting);
      for (let i = 0; i < 160; i++) {
        const op = def.ops[Math.floor(rnd() * def.ops.length)];
        if (op.id === 'reset' && rnd() < 0.8) continue;
        const args = op.suggest?.(a) ?? [];
        const on = loud(a);
        const off = quiet(b);
        op.run(a, args, on);
        op.run(b, args, off);
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(a).toEqual(b);
      }
    }
  });

  it('the row file reads everything; the column file reads two columns of one row group', () => {
    const s = create('column');
    const row = loud(s);
    expect(sum(s, 'UK', 'row', row)).toBe(89);
    checkFrames(row.frames);
    expect(row.counters).toEqual({ comparisons: 12, values: 48, bytes: 192 });

    const col = loud(s);
    expect(sum(s, 'UK', 'column', col)).toBe(89);
    checkFrames(col.frames);
    // UK > max rules a row group out with one check; row group 2 needs both, then 4 values.
    expect(col.counters).toEqual({ comparisons: 1 + 1 + 2 + 4, values: 8, bytes: 32, skipped: 2 });
    expect(col.frames.filter((f) => f.compare).slice(0, 2).map((f) => f.compare)).toEqual([
      { left: 'UK', op: '>', right: 'max DE', verdict: 'skip row group 0' },
      { left: 'UK', op: '>', right: 'max FR', verdict: 'skip row group 1' },
    ]);
  });

  it('encodes the sorted column into a few runs and shows every "same as previous?" comparison', () => {
    const s = create('column');
    const rec = loud(s);
    expect(columnBytes(s, 'country')).toBe(48);
    expect(encode(s, 'country', rec)).toBe(true);
    checkFrames(rec.frames);
    expect(columnBytes(s, 'country')).toBe(24);
    const rle = rec.frames.filter((f) => f.compare && f.compare.right.toString().startsWith('previous'));
    // Every code but the first of each chunk is compared with the one before it.
    expect(rle.length).toBe(12 - 3);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/48 bytes plain, 28 as dictionaries and codes, 24 as dictionaries and 4 runs/);
    expect(s.groups.map((g) => encodeChunk(chunk(g, 'country')).runs)).toEqual([[[0, 4]], [[0, 4]], [[0, 1], [1, 3]]]);
    // A second time is a no-op that says so.
    const again = loud(s);
    expect(encode(s, 'country', again)).toBe(false);
    expect(again.frames[again.frames.length - 1].message).toMatch(/already/);
  });

  it('after encoding, the filter compares codes per run and a dictionary rules out a value min and max let through', () => {
    const s = create('column');
    encode(s, 'country', quiet(s));
    const uk = loud(s);
    expect(sum(s, 'UK', 'column', uk)).toBe(89);
    checkFrames(uk.frames);
    expect(uk.counters).toEqual({ comparisons: 1 + 1 + 2 + 1 + 2, values: 6, bytes: 28, skipped: 2 });
    expect(uk.frames.some((f) => f.compare?.left === 'run 1×3')).toBe(true);

    const pl = loud(s);
    expect(sum(s, 'PL', 'column', pl)).toBe(0);
    checkFrames(pl.frames);
    // IT ≤ PL ≤ UK, so row group 2 is opened, but its dictionary has no PL: no runs, no amounts.
    expect(pl.counters).toEqual({ comparisons: 1 + 1 + 2 + 1, bytes: 12, skipped: 2 });
  });

  it('answers a two-condition filter by ANDing bitmaps', () => {
    const s = create('row');
    const rec = loud(s);
    expect(bitmap(s, 'FR', 'tea', rec)).toBe(3);
    checkFrames(rec.frames);
    expect(s.layout).toBe('column');
    expect(rec.frames.some((f) => f.message.includes('000011110000 AND 101010110101 = 000010110000'))).toBe(true);
  });

  it('buffers appends, flushes a sorted, immutable file at the threshold, and then has no room', () => {
    const s = create('column');
    encode(s, 'country', quiet(s));
    const before = s.groups.map((g) => g.map((r) => r.id));
    const one = loud(s);
    expect(append(s, 'IT', 'pie', 20, one)).toBe(true);
    checkFrames(one.frames);
    expect(s.buffer.length).toBe(1);
    expect(one.counters.files ?? 0).toBe(0);
    // A query sees the buffered row.
    expect(sum(s, 'IT', 'column', quiet(s))).toBe(30);

    const two = loud(s);
    expect(append(s, 'DE', 'tea', 30, two)).toBe(true);
    checkFrames(two.frames);
    expect(two.counters.files).toBe(1);
    expect(s.buffer.length).toBe(0);
    expect(s.groups.length).toBe(4);
    expect(s.groups.slice(0, 3).map((g) => g.map((r) => r.id))).toEqual(before);
    expect(chunk(s.groups[3], 'country')).toEqual(['DE', 'IT']);
    expect([minOf(chunk(s.groups[3], 'amount')), maxOf(chunk(s.groups[3], 'amount'))]).toEqual([20, 30]);
    expect(two.frames[two.frames.length - 1].message).toMatch(/overlaps row groups 0, 1 and 2/);
    // Now a query for FR has to open the new file as well.
    const fr = quiet(s);
    expect(sum(s, 'FR', 'column', fr)).toBe(112);
    expect(fr.counters.skipped).toBe(2);

    const full = loud(s);
    expect(append(s, 'UK', 'jam', 9, full)).toBe(false);
    expect(full.frames[full.frames.length - 1].message).toMatch(/Sorry/);
    checkFrames(full.frames);
    reset(s, quiet(s));
    expect(fileRows(s).length).toBe(12);
  });

  it('turns bad input away with a sentence', () => {
    const s = create('column');
    for (const [run, re] of [
      [(r: Recorder<StoreState>) => sum(s, 'germany', '', r), /two-letter/],
      [(r: Recorder<StoreState>) => sum(s, 'UK', 'diagonal', r), /row or column/],
      [(r: Recorder<StoreState>) => encode(s, 'colour', r), /day, country, product or amount/],
      [(r: Recorder<StoreState>) => append(s, 'PL', 'tea', 5, r), /sells/],
      [(r: Recorder<StoreState>) => bitmap(s, 'F', 'tea', r), /two-letter/],
    ] as const) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(re);
      checkFrames(rec.frames);
    }
    expect(s).toEqual(create('column'));
  });

  it('seed and tour run through the definition and name real code lines', () => {
    expect(def.id).toBe('column-store');
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    const s = def.create({ layout: def.params![0].default });
    expect(s.setting).toBe('column');
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    const used = new Map<string, Set<string>>();
    const outcomes: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
      check(s);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      const c = rec.counters;
      outcomes.push(`${id}: ${c.values ?? 0} values, ${c.bytes ?? 0} bytes, ${c.skipped ?? 0} skipped, ${c.files ?? 0} files`);
    }
    expect(outcomes).toEqual([
      'encode: 0 values, 0 bytes, 0 skipped, 0 files',
      'sum: 48 values, 192 bytes, 0 skipped, 0 files',
      'sum: 6 values, 28 bytes, 2 skipped, 0 files',
      'bitmap: 24 values, 76 bytes, 0 skipped, 0 files',
      'append: 0 values, 0 bytes, 0 skipped, 0 files',
      'append: 0 values, 0 bytes, 0 skipped, 1 files',
    ]);
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

  it('suggestions run for both settings, and their frames name real code lines', () => {
    for (const opt of def.params![0].options) {
      const s = def.create({ layout: opt.value });
      const used = new Map<string, Set<string>>();
      for (let round = 0; round < 24; round++) {
        for (const op of def.ops) {
          if (op.id === 'reset' && round % 8 !== 7) continue;
          const args = op.suggest?.(s) ?? [];
          expect(args.length).toBe(op.args.length);
          const rec = loud(s);
          op.run(s, args, rec);
          checkFrames(rec.frames);
          check(s);
          const set = used.get(op.id) ?? new Set<string>();
          used.set(op.id, set);
          for (const f of rec.frames) for (const a of f.lines!) set.add(a);
        }
      }
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });
});
