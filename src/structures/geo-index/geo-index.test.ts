import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, OpDef } from '../../core/types';
import def, {
  BITS,
  MAX_POINTS,
  SCENE,
  SIZE,
  box,
  create,
  encode,
  depth,
  leaves,
  layout,
  move,
  near,
  insert,
  rebuild,
  type GeoState,
  type QNode,
} from './index';

const quiet = (s: GeoState) => new Recorder(s, layout, false);
const loud = (s: GeoState) => new Recorder(s, layout, true);

function seeded(mode: 'geohash' | 'quadtree', capacity = 2): GeoState {
  const s = create(mode, capacity);
  for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
  return s;
}

/** Internal exactly when the square holds more than capacity; every point inside its leaf's square. */
function checkTree(n: QNode, cap: number): number {
  if (!n.kids) {
    expect(n.pts.length <= cap || n.size === 1).toBe(true);
    for (const p of n.pts) {
      expect(p.x >= n.x && p.x < n.x + n.size && p.y >= n.y && p.y < n.y + n.size).toBe(true);
    }
    return n.pts.length;
  }
  const c = n.kids.reduce((a, k) => a + checkTree(k, cap), 0);
  expect(c).toBeGreaterThan(cap);
  return c;
}

function check(s: GeoState): void {
  const names = new Set(s.pts.map((p) => p.name));
  expect(names.size).toBe(s.pts.length);
  expect(new Set(s.pts.map((p) => `${p.x},${p.y}`)).size).toBe(s.pts.length);
  expect(s.pts.length).toBeLessThanOrEqual(MAX_POINTS);
  if (s.mode === 'geohash') {
    expect(s.entries.map((e) => e.code)).toEqual(s.pts.map((p) => encode(p.x, p.y)).sort((a, b) => a - b));
    for (const e of s.entries) {
      const p = s.pts.find((m) => m.name === e.name)!;
      expect(e.code).toBe(encode(p.x, p.y));
    }
  } else {
    expect(checkTree(s.root, s.capacity)).toBe(s.pts.length);
    const held = leaves(s.root).flatMap((l) => l.pts.map((p) => `${p.name}${p.x}${p.y}`)).sort();
    expect(held).toEqual(s.pts.map((p) => `${p.name}${p.x}${p.y}`).sort());
  }
}

function checkFrames(frames: Frame[], s: GeoState): void {
  for (const f of frames) {
    const ids = f.scene.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(f.lines?.length ?? 0, f.message).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    if (f.probe) {
      const node = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(node, `probe at ${f.probe.at}`).toBeDefined();
    }
    if (f.compare) expect(f.probe).toBeDefined();
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < SCENE.left || a.x2 > SCENE.right || a.y1 < SCENE.top || a.y2 > SCENE.bottom) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      // Magenta only on the followed point, or on Q's empty cell.
      if (n.tone === 'key') expect([f.probe?.text, 'Q']).toContain(n.cells[0].text === 'Q' ? 'Q' : n.cells[0].text);
    }
  }
  check(s);
}

describe('geo index', () => {
  for (const [mode, cap] of [['geohash', 2], ['quadtree', 2], ['quadtree', 4]] as const) {
    it(`agrees with a plain list of points under random operations (${mode}, ${cap})`, () => {
      const rnd = makeRng(cap * 7 + mode.length);
      const s = create(mode, cap);
      const r = (n: number) => Math.floor(rnd() * n);
      let splits = 0;
      for (let i = 0; i < 4000; i++) {
        const roll = rnd();
        const recording = i % 50 === 0;
        const rec = recording ? loud(s) : quiet(s);
        if (roll < 0.3) {
          const x = r(SIZE), y = r(SIZE);
          const want = s.pts.length < MAX_POINTS && !s.pts.some((p) => p.x === x && p.y === y);
          expect(insert(s, x, y, rec)).toBe(want);
          splits += rec.counters.splits ?? 0;
        } else if (roll < 0.5 && s.pts.length) {
          const p = s.pts[r(s.pts.length)];
          const x = r(SIZE), y = r(SIZE);
          const want = !s.pts.some((m) => m.x === x && m.y === y);
          expect(move(s, p.name, x, y, rec)).toBe(want);
          if (want) expect(p).toMatchObject({ x, y });
          splits += rec.counters.splits ?? 0;
        } else if (roll < 0.75) {
          const x = r(SIZE), y = r(SIZE), rad = 1 + r(3);
          const want = s.pts.filter((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= rad * rad).map((p) => p.name).sort();
          expect(near(s, x, y, rad, rec).sort()).toEqual(want);
        } else if (roll < 0.97) {
          const a = r(SIZE), b = r(SIZE), c = r(SIZE), d = r(SIZE);
          const want = s.pts
            .filter((p) => p.x >= Math.min(a, c) && p.x <= Math.max(a, c) && p.y >= Math.min(b, d) && p.y <= Math.max(b, d))
            .map((p) => p.name)
            .sort();
          expect(box(s, a, b, c, d, rec).sort()).toEqual(want);
        } else {
          rebuild(s, rec);
          rebuild(s, quiet(s));
        }
        if (recording) checkFrames(rec.frames, s);
        check(s);
      }
      if (mode === 'quadtree') expect(splits).toBeGreaterThan(0);
    });
  }

  it('counts the same with recording on and off', () => {
    for (const mode of ['geohash', 'quadtree'] as const) {
      const a = seeded(mode);
      const b = seeded(mode);
      for (const [op, ...args] of def.tour) {
        const ra = loud(a);
        const rb = quiet(b);
        def.ops.find((o) => o.id === op)!.run(a, args, ra);
        def.ops.find((o) => o.id === op)!.run(b, args, rb);
        expect(ra.counters).toEqual(rb.counters);
        checkFrames(ra.frames, a);
      }
      expect(a.pts).toEqual(b.pts);
    }
  });

  it('builds the code bit by bit, x first', () => {
    const s = seeded('geohash');
    const rec = loud(s);
    insert(s, 5, 2, rec);
    const compares = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(compares.map((c) => `${c.left} ${c.op} ${c.right}`)).toEqual([
      'K: x 5 ≥ mid 4',
      'K: y 2 < mid 4',
      'K: x 5 < mid 6',
      'K: y 2 ≥ mid 2',
      'K: x 5 ≥ mid 5',
      'K: y 2 < mid 3',
    ]);
    expect(encode(5, 2)).toBe(0b100110);
    expect(rec.counters.comparisons).toBe(BITS);
  });

  it('shows the boundary problem: the point across the edge is found only in a neighbour block', () => {
    const s = seeded('geohash');
    insert(s, 5, 2, quiet(s));
    const rec = loud(s);
    expect(near(s, 3, 4, 2, rec).sort()).toEqual(['A', 'B']);
    const warn = rec.frames.find((f) => f.message.startsWith('Stopping here would return A.'));
    expect(warn?.message).toContain('B at (4, 4)');
    expect(rec.counters.ranges).toBe(9);
  });

  it('the box query reads entries on the Z curve detour and drops them', () => {
    const s = seeded('geohash');
    insert(s, 5, 2, quiet(s));
    const rec = loud(s);
    box(s, 2, 3, 5, 5, rec);
    expect(rec.frames.some((f) => f.message.includes('The Z-shaped curve'))).toBe(true);
  });

  it('the tour splits a crowded leaf and prunes three quadrants at the root', () => {
    const s = seeded('geohash');
    const run = (op: string, args: (number | string)[]) => {
      const rec = loud(s);
      (def.ops.find((o) => o.id === op) as OpDef<GeoState>).run(s, args, rec);
      return rec;
    };
    const [i1, n1, b1, sw, i2, n2] = def.tour.map(([op, ...args]) => run(op, args));
    expect([i1, n1, b1].every((r) => r.frames.length > 0)).toBe(true);
    expect(sw.frames.length).toBe(2);
    expect(s.mode).toBe('quadtree');
    expect(i2.counters.splits).toBe(1);
    expect(depth(s.root)).toBe(2);
    expect(n2.frames.filter((f) => f.compare?.verdict.startsWith('prune')).length).toBe(3);
    expect(n2.counters.pruned).toBe(3);
  });

  it('every frame of the tour names code that exists in both listings', () => {
    for (const mode of [0, 1]) {
      const s = def.create({ mode, capacity: 2 });
      for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
      const used = new Map<string, Set<string>>();
      for (const [op, ...args] of def.tour) {
        const rec = loud(s);
        def.ops.find((o) => o.id === op)!.run(s, args, rec);
        const set = used.get(op) ?? new Set();
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        used.set(op, set);
      }
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
    for (const { id } of LANGS) for (const op of def.ops) for (const l of listing(def.source![id], id, op.code!).lines) expect(l.length).toBeLessThanOrEqual(80);
  });
});
