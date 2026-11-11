import { describe, expect, it } from 'vitest';
import { codeProblems } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, {
  CITIES,
  HOT_RUN,
  MAX_NODES,
  MAX_ROWS,
  MAX_TOTAL,
  SENSORS,
  create,
  find,
  get,
  hashKey,
  hot,
  layout,
  nodeCount,
  partOf,
  put,
  rebalance,
  scan,
  termPart,
  views,
  type PState,
} from './index';

const quiet = (s: PState) => new Recorder(s, layout, false);
const loud = (s: PState) => new Recorder(s, layout, true);

function seeded(start = 3, scheme: 'range' | 'hash' = 'range', index: 'local' | 'global' = 'local'): PState {
  const s = create(start, scheme, index);
  for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
  return s;
}

/** Every row in exactly one partition, the one routing names; ranges sorted and covering 0 to 999. */
function verify(s: PState, model: Map<number, string>): void {
  expect(new Map(s.rows)).toEqual(model);
  for (const scheme of ['range', 'hash'] as const) {
    const vs = views(s, scheme);
    const all = vs.flatMap((v) => v.keys).sort((a, b) => a - b);
    expect(all).toEqual([...model.keys()].sort((a, b) => a - b));
    for (const v of vs) {
      expect(v.node).toBeGreaterThanOrEqual(0);
      expect(v.node).toBeLessThan(nodeCount(s, scheme));
      for (const k of v.keys) expect(partOf(s, k, scheme).pid).toBe(v.pid);
    }
    if (scheme === 'range') {
      expect(vs[0].lo).toBe(0);
      expect(vs[vs.length - 1].hi).toBe(999);
      for (let i = 1; i < vs.length; i++) expect(vs[i].lo).toBe(vs[i - 1].hi! + 1);
    } else {
      expect(vs.length).toBe(s.start * 2);
    }
  }
  expect(s.rows.size).toBeLessThanOrEqual(MAX_TOTAL);
  for (const scheme of ['range', 'hash'] as const) for (const v of views(s, scheme)) expect(v.keys.length).toBeLessThanOrEqual(MAX_ROWS);
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    expect(f.message).not.toMatch(/undefined|NaN|null|\[object/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}: ${f.message}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
    }
    if (f.compare) expect(f.probe, `a comparison follows something: ${f.message}`).toBeDefined();
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') throw new Error('magenta is for one cell, not a whole node');
      n.cells.forEach((c) => {
        // Magenta only on the cell holding the key being followed.
        if (c.tone === 'key') expect(c.text).toBe(f.probe?.text);
      });
    }
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
  }
}

describe('partitioning', () => {
  it('hashes to the stated sum and routes ranges by boundary', () => {
    expect(hashKey(512)).toBe((37 * 512 + 11) % 100);
    const s = create(3);
    expect(views(s).map((v) => [v.lo, v.hi])).toEqual([[0, 349], [350, 699], [700, 999]]);
    expect(views(create(4)).map((v) => v.lo)).toEqual([0, 250, 500, 750]);
    expect(partOf(s, 349).label).toBe('P0');
    expect(partOf(s, 350).label).toBe('P1');
    expect(partOf(s, 999).label).toBe('P2');
    expect(termPart('Lima')).toBe(0);
    expect(termPart('Oslo')).toBe(1);
    expect(termPart('Rome')).toBe(2);
  });

  for (const start of [3, 4]) {
    for (const scheme of ['range', 'hash'] as const) {
      it(`matches a plain model through random operations (${start} nodes, ${scheme})`, () => {
        const rnd = makeRng(start * 17 + (scheme === 'hash' ? 5 : 0));
        const s = create(start, scheme);
        const model = new Map<number, string>();
        for (let i = 0; i < 2500; i++) {
          const roll = rnd();
          const key = Math.floor(rnd() * 1000);
          const city = CITIES[Math.floor(rnd() * 3)];
          if (rnd() < 0.05) s.scheme = s.scheme === 'range' ? 'hash' : 'range';
          if (rnd() < 0.05) s.index = s.index === 'local' ? 'global' : 'local';
          const rec = quiet(s);
          if (roll < 0.3) {
            const room = !model.has(key) && partOf(s, key, 'range').keys.length < MAX_ROWS && partOf(s, key, 'hash').keys.length < MAX_ROWS && model.size < MAX_TOTAL;
            expect(put(s, key, city, rec)).toBe(room);
            if (room) model.set(key, city);
            expect(rec.counters.writes ?? 0).toBe(room ? 2 : 0);
          } else if (roll < 0.45) {
            expect(get(s, key, rec)).toBe(model.get(key) ?? null);
            expect(rec.counters.asked).toBe(1);
          } else if (roll < 0.6) {
            const hi = Math.min(999, key + Math.floor(rnd() * 300));
            const want = [...model.keys()].filter((k) => k >= key && k <= hi).sort((a, b) => a - b);
            const which = rnd() < 0.5 ? 'range' : 'hash';
            expect(scan(s, key, hi, which, rec)).toEqual(want);
            const vs = views(s);
            if (which === 'hash') expect(rec.counters.asked).toBe(vs.length);
            else expect(rec.counters.asked).toBe(vs.filter((v) => v.hi! >= key && v.lo! <= hi).length);
          } else if (roll < 0.75) {
            const want = [...model.keys()].filter((k) => model.get(k) === city).sort((a, b) => a - b);
            const via = (['local', 'global', 'both'] as const)[Math.floor(rnd() * 3)];
            expect(find(s, city, via, rec)).toEqual(want);
            const n = views(s).length;
            expect(rec.counters.asked).toBe(via === 'local' ? n : via === 'global' ? 1 : n + 1);
          } else if (roll < 0.8) {
            const t = Math.floor(rnd() * (1000 - HOT_RUN));
            const sch = s.scheme;
            const before = new Map(model);
            hot(s, t, rec);
            for (const k of s.rows.keys()) if (!before.has(k)) model.set(k, s.rows.get(k)!);
            for (const [k, c] of before) expect(s.rows.get(k)).toBe(c);
            for (const k of s.rows.keys()) {
              if (before.has(k)) continue;
              const fromRun = k >= t && k < t + HOT_RUN;
              const fromFix = sch === 'range' && SENSORS.some((x) => x * 100 + ((t + HOT_RUN) % 100) === k);
              expect(fromRun || fromFix).toBe(true);
            }
          } else if (roll < 0.85) {
            const sch = s.scheme;
            const owners = views(s, 'hash').map((v) => v.keys.join());
            const n = nodeCount(s);
            rebalance(s, rec);
            expect(nodeCount(s)).toBe(Math.min(MAX_NODES, n + 1));
            // Hash partitions keep their keys; only owners change.
            expect(views(s, 'hash').map((v) => v.keys.join())).toEqual(owners);
            if (sch === 'hash') {
              const count = new Array(nodeCount(s)).fill(0);
              for (const v of views(s)) count[v.node]++;
              expect(Math.max(...count) - Math.min(...count)).toBeLessThanOrEqual(1);
            }
          }
          verify(s, model);
        }
      });
    }
  }

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    for (const start of [3, 4]) {
      const rnd = makeRng(99 + start);
      const a = seeded(start);
      const b = seeded(start);
      for (let i = 0; i < 400; i++) {
        const opIdx = Math.floor(rnd() * def.ops.length);
        const op = def.ops[opIdx];
        const args = op.suggest?.(a) ?? [];
        const on = loud(a);
        const off = quiet(b);
        op.run(a, args, on);
        op.run(b, args, off);
        expect(on.counters).toEqual(off.counters);
        expect([...a.rows]).toEqual([...b.rows]);
        checkFrames(on.frames);
      }
    }
  });

  it('a range scan asks adjacent partitions under range and every partition under hash', () => {
    const s = seeded();
    let rec = loud(s);
    expect(scan(s, 300, 420, 'range', rec)).toEqual([310, 377]);
    expect(rec.counters.asked).toBe(2);
    rec = loud(s);
    expect(scan(s, 300, 420, 'hash', rec)).toEqual([310, 377]);
    expect(rec.counters.asked).toBe(6);
    expect(s.scheme).toBe('hash');
  });

  it('sequential keys pile into one range partition, and the prefixed keys spread out', () => {
    const s = seeded();
    const rec = loud(s);
    hot(s, 900, rec);
    const p2 = views(s).find((v) => v.label === 'P2')!;
    for (let t = 900; t < 900 + HOT_RUN; t++) expect(p2.keys).toContain(t);
    const fixed = SENSORS.map((x) => x * 100 + 4);
    expect(new Set(fixed.map((k) => partOf(s, k).label)).size).toBe(3);
    expect(rec.frames.some((f) => /hot partition/.test(f.message))).toBe(true);
  });

  it('a range split moves only the upper half, to the new node', () => {
    const s = seeded();
    hot(s, 900, quiet(s));
    const before = views(s).map((v) => [v.label, v.node, v.keys.join()]);
    const rec = loud(s);
    expect(rebalance(s, rec)).toBe(true);
    const after = views(s);
    expect(after.length).toBe(4);
    const fresh = after.find((v) => v.label === 'P3')!;
    expect(fresh.node).toBe(3);
    expect(fresh.keys).toEqual([901, 902, 903]);
    expect(rec.counters.moved).toBe(3);
    for (const [label, node, keys] of before) if (label !== 'P2') expect(after.find((v) => v.label === label)).toMatchObject({ node, keys: String(keys).split(',').filter(Boolean).map(Number) });
    // No further node can join, and the page says so instead of splitting.
    const again = loud(s);
    expect(rebalance(s, again)).toBe(false);
    expect(views(s).length).toBe(4);
  });

  it('a hash rebalance moves whole partitions and reports what mod N would have moved', () => {
    const s = seeded(3, 'hash');
    const rec = loud(s);
    expect(rebalance(s, rec)).toBe(true);
    const counts = [0, 0, 0, 0];
    for (const v of views(s)) counts[v.node]++;
    expect(counts.sort()).toEqual([1, 1, 2, 2]);
    const modN = [...s.rows.keys()].filter((k) => hashKey(k) % 3 !== hashKey(k) % 4).length;
    expect(rec.frames[rec.frames.length - 1].message).toContain(`would have moved ${modN} of ${s.rows.size}`);
  });

  it('a find through local indexes asks every partition and through the global index asks one', () => {
    const s = seeded();
    let rec = loud(s);
    expect(find(s, 'Oslo', 'local', rec)).toEqual([42, 310, 590]);
    expect(rec.counters.asked).toBe(3);
    rec = loud(s);
    expect(find(s, 'oslo', 'global', rec)).toEqual([42, 310, 590]);
    expect(rec.counters.asked).toBe(1);
    expect(s.index).toBe('global');
  });

  it('refuses bad input without changing anything', () => {
    const s = seeded();
    const rows = [...s.rows];
    for (const run of [
      (rec: Recorder<PState>) => put(s, 5, 'Paris', rec),
      (rec: Recorder<PState>) => put(s, 1200, 'Oslo', rec),
      (rec: Recorder<PState>) => put(s, 42, 'Rome', rec),
      (rec: Recorder<PState>) => scan(s, 1, 2, 'sideways', rec),
      (rec: Recorder<PState>) => find(s, 'Oslo', 'nowhere', rec),
      (rec: Recorder<PState>) => hot(s, 998, rec),
    ]) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
    }
    expect([...s.rows]).toEqual(rows);
  });

  it('seed and tour run under every parameter set and fit the page', () => {
    for (const nodes of [3, 4]) {
      for (const scheme of [0, 1]) {
        for (const index of [0, 1]) {
          const s = def.create({ nodes, scheme, index });
          for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
          expect(s.rows.size).toBe(def.seed.length);
          const used = new Map<string, Set<string>>();
          for (const [op, ...args] of def.tour) {
            const rec = loud(s);
            def.ops.find((o) => o.id === op)!.run(s, args, rec);
            expect(rec.frames.length).toBeGreaterThan(0);
            checkFrames(rec.frames);
            const set = used.get(op) ?? new Set<string>();
            used.set(op, set);
            for (const f of rec.frames) {
              for (const a of f.lines ?? []) set.add(a);
              const b = sceneBounds(f.scene)!;
              expect(b.bw, `${op} is ${Math.round(b.bw)} wide`).toBeLessThanOrEqual(940);
              expect(b.bh, `${op} is ${Math.round(b.bh)} tall`).toBeLessThanOrEqual(420);
            }
          }
          expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
        }
      }
    }
  });

  it('tells the tour story in order under the default settings', () => {
    const s = def.create({ nodes: 3, scheme: 0, index: 0 });
    for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
    const asked: number[] = [];
    for (const [op, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === op)!.run(s, args, rec);
      asked.push(rec.counters.asked ?? 0);
    }
    // put, get, range scan, hot run, split, find both ways, scatter scan.
    expect(asked[0]).toBe(1);
    expect(asked[1]).toBe(1);
    expect(asked[2]).toBe(2);
    expect(asked[5]).toBe(4 + 1);
    expect(asked[6]).toBe(6);
    expect(nodeCount(s, 'range')).toBe(4);
  });

  it('suggests arguments the form accepts', () => {
    const s = seeded();
    for (let i = 0; i < 200; i++) {
      for (const op of def.ops) {
        const args = op.suggest?.(s) ?? [];
        expect(args.length).toBe(op.args.length);
        op.args.forEach((a, j) => {
          if (a.kind === 'int') {
            expect(Number.isInteger(args[j])).toBe(true);
            if (a.min != null) expect(args[j]).toBeGreaterThanOrEqual(a.min);
            if (a.max != null) expect(args[j]).toBeLessThanOrEqual(a.max);
          }
        });
      }
    }
  });
});
