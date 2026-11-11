import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  KEYS,
  READERS,
  STRATEGIES,
  STRATEGY_PARAM,
  crashCache,
  create,
  flush,
  layout,
  race,
  read,
  setStrategy,
  stampede,
  tick,
  write,
  type CacheState,
  type Strategy,
} from './index';

const quiet = (s: CacheState) => new Recorder(s, layout, false);
const loud = (s: CacheState) => new Recorder(s, layout, true);

/** The plainest statement of each strategy, kept apart from the page's code. */
class Model {
  db = new Map<number, [number, number]>();
  cached = new Map<number, [number, number, number | null]>();
  pending: [number, number, number][] = [];
  now = 0;
  constructor(public strategy: Strategy, readonly ttl: number, start: CacheState) {
    for (const [k, r] of start.db) this.db.set(k, [r.value, r.version]);
  }
  read(key: number): number | null {
    const e = this.cached.get(key);
    if (e) return e[0];
    const r = this.db.get(key);
    if (!r) return null;
    this.cached.set(key, [r[0], r[1], this.now + this.ttl]);
    return r[0];
  }
  write(key: number, value: number): void {
    if (this.strategy === 'write-behind') {
      const q = this.pending.find((p) => p[0] === key);
      const ver = (q ? q[2] : this.db.get(key)![1]) + 1;
      if (q) [q[1], q[2]] = [value, ver];
      else this.pending.push([key, value, ver]);
      this.cached.set(key, [value, ver, null]);
      return;
    }
    const ver = this.db.get(key)![1] + 1;
    this.db.set(key, [value, ver]);
    if (this.strategy === 'cache-aside') this.cached.delete(key);
    if (this.strategy === 'write-through') this.cached.set(key, [value, ver, this.now + this.ttl]);
  }
  flush(): number {
    for (const [k, v, ver] of this.pending) {
      this.db.set(k, [v, ver]);
      this.cached.set(k, [v, ver, this.now + this.ttl]);
    }
    const n = this.pending.length;
    this.pending = [];
    return n;
  }
  crash(): number {
    const n = this.pending.length;
    this.pending = [];
    this.cached.clear();
    return n;
  }
  tick(n: number): void {
    this.now += n;
    for (const [k, e] of [...this.cached]) if (e[2] !== null && e[2] <= this.now) this.cached.delete(k);
  }
}

function agree(s: CacheState, m: Model): void {
  expect([...s.db].map(([k, r]) => [k, r.value, r.version])).toEqual([...m.db].map(([k, r]) => [k, ...r]));
  const cache = [...s.cache].map(([k, e]) => [k, e.value, e.version, e.expires]).sort((a, b) => (a[0] as number) - (b[0] as number));
  const want = [...m.cached].map(([k, e]) => [k, ...e]).sort((a, b) => (a[0] as number) - (b[0] as number));
  expect(cache).toEqual(want);
  expect(s.queue.map((p) => [p.key, p.value, p.version])).toEqual(m.pending);
  expect(s.now).toBe(m.now);
  // Invariants: one queued write per key, and every queued key is pinned in the cache.
  expect(new Set(s.queue.map((p) => p.key)).size).toBe(s.queue.length);
  for (const p of s.queue) expect(s.cache.get(p.key)).toMatchObject({ value: p.value, version: p.version, expires: null });
  for (const e of s.cache.values()) if (e.expires !== null) expect(e.expires).toBeGreaterThan(s.now);
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
    }
    if (f.compare) expect(f.probe, 'a comparison follows a key').toBeDefined();
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      // Magenta only on a row that holds the followed key.
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    expect(edge).toEqual(corners(frames[0].scene));
    // Within about 940 by 420 scene units.
    expect(edge.x2 - edge.x1).toBeLessThanOrEqual(940);
    expect(edge.y2 - edge.y1).toBeLessThanOrEqual(420);
  }
}

describe('cache strategies', () => {
  for (const strategy of STRATEGIES) {
    it(`agrees with a plain model under random operations (${strategy})`, () => {
      const rnd = makeRng(STRATEGY_PARAM[strategy] * 97 + 5);
      const s = create(strategy);
      const m = new Model(strategy, s.ttl, s);
      for (let i = 0; i < 4000; i++) {
        const roll = rnd();
        const key = rnd() < 0.1 ? 99 : KEYS[Math.floor(rnd() * KEYS.length)];
        const rec = i % 50 === 0 ? loud(s) : quiet(s);
        if (roll < 0.35) {
          expect(read(s, key, rec)).toBe(m.read(key));
          if (key !== 99) expect(rec.counters.hits ?? 0).toBe(rec.counters.misses ? 0 : 1);
        } else if (roll < 0.6) {
          const v = Math.floor(rnd() * 1000);
          const ok = write(s, key, v, rec);
          expect(ok).toBe(key !== 99);
          if (ok) m.write(key, v);
        } else if (roll < 0.68) {
          expect(flush(s, rec)).toBe(m.flush());
        } else if (roll < 0.71) {
          expect(crashCache(s, rec)).toBe(m.crash());
        } else if (roll < 0.9) {
          const n = 1 + Math.floor(rnd() * 4);
          if (s.now + n <= 999) {
            tick(s, n, rec);
            m.tick(n);
          }
        } else if (roll < 0.95) {
          // The race and the stampede end with the key cached from the database, like a read after a write.
          const k = KEYS[Math.floor(rnd() * KEYS.length)];
          if (s.queue.some((p) => p.key === k)) continue;
          if (rnd() < 0.5) {
            race(s, k, rec);
            const r = m.db.get(k)!;
            m.db.set(k, [(r[0] + 10) % 1000, r[1] + 1]);
            m.cached.set(k, [r[0], r[1], m.now + m.ttl]);
          } else {
            stampede(s, k, rec);
            const r = m.db.get(k)!;
            m.cached.set(k, [r[0], r[1], m.now + m.ttl]);
          }
        } else {
          const next = STRATEGIES[Math.floor(rnd() * 4)];
          setStrategy(s, next, rec);
          m.flush();
          m.strategy = next;
        }
        if (rec.recording) checkFrames(rec.frames);
        agree(s, m);
      }
    });
  }

  it('counts the same with recording on and off', () => {
    const script: [string, ...(number | string)[]][] = [...def.seed, ...def.tour, ['tick', 3], ['read', 99], ['flush'], ['strategy', 'write-around'], ['read', 27], ['write', 27, 5], ['read', 27]];
    const totals = (recording: boolean) => {
      const s = def.create({ strategy: 0 });
      const out: Record<string, number>[] = [];
      for (const [id, ...args] of script) {
        const rec = new Recorder(s, layout, recording);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        out.push(rec.counters);
        if (recording) {
          expect(rec.frames.length).toBeGreaterThan(0);
          expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
          checkFrames(rec.frames);
        }
      }
      return out;
    };
    expect(totals(true)).toEqual(totals(false));
  });

  it('the race leaves an old value cached and reads it as stale', () => {
    const s = create('cache-aside');
    const rec = loud(s);
    race(s, 42, rec);
    expect(rec.counters).toMatchObject({ misses: 1, reads: 1, writes: 1, hits: 1, stale: 1 });
    expect(s.cache.get(42)!.version).toBe(s.db.get(42)!.version - 1);
    const after = loud(s);
    read(s, 42, after);
    expect(after.counters.stale).toBe(1);
    // Once the TTL has passed, the next read loads the new value.
    tick(s, s.ttl, quiet(s));
    const late = loud(s);
    expect(read(s, 42, late)).toBe(s.db.get(42)!.value);
    expect(late.counters.stale ?? 0).toBe(0);
  });

  it('the stampede makes one database read per reader, and one with the lock', () => {
    const s = create('cache-aside');
    const rec = loud(s);
    stampede(s, 63, rec);
    expect(rec.counters.reads).toBe(READERS + 1);
    expect(rec.counters.hits).toBe(READERS - 1);
    expect(rec.frames.some((f) => f.scene.nodes.some((n) => n.id === 'lock' && n.shape === 'tag'))).toBe(true);
    expect(s.lock).toBeNull();
  });

  it('write-behind answers with no database write and loses the write in a crash', () => {
    const s = create('write-behind');
    const w = loud(s);
    write(s, 42, 330, w);
    expect(w.counters.writes ?? 0).toBe(0);
    expect(read(s, 42, quiet(s))).toBe(330);
    const c = loud(s);
    expect(crashCache(s, c)).toBe(1);
    expect(c.counters.lost).toBe(1);
    // The red queue entry is shown before it disappears.
    expect(c.frames.some((f) => f.scene.nodes.some((n) => n.id === 'q42' && n.tone === 'bad'))).toBe(true);
    expect(read(s, 42, quiet(s))).toBe(250);
  });

  it('a read of a key the database lacks is not cached', () => {
    const s = create('cache-aside');
    const rec = loud(s);
    expect(read(s, 99, rec)).toBeNull();
    expect(s.cache.has(99)).toBe(false);
    expect(rec.frames.at(-1)!.scene.nodes.some((n) => n.id === 'd99')).toBe(true);
    expect(rec.counters).toMatchObject({ misses: 1, reads: 1 });
  });

  it('seed and tour run through the definition', () => {
    expect(def.id).toBe('cache-strategies');
    const s = def.create({ strategy: 0 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    expect(s.now).toBe(2);
    expect([...s.cache.keys()].sort()).toEqual([12, 63]);
    const used = new Map<string, Set<string>>();
    const outcomes: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      checkFrames(rec.frames);
      const c = rec.counters;
      outcomes.push(`${id}: ${c.hits ?? 0}h ${c.misses ?? 0}m ${c.reads ?? 0}r ${c.writes ?? 0}w ${c.stale ?? 0}s ${c.lost ?? 0}l`);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
    }
    expect(outcomes).toEqual([
      'read: 0h 1m 1r 0w 0s 0l',
      'read: 1h 0m 0r 0w 0s 0l',
      'write: 0h 0m 0r 1w 0s 0l',
      'race: 1h 1m 1r 1w 1s 0l',
      'stampede: 3h 8m 5r 0w 0s 0l',
      'strategy: 0h 0m 0r 0w 0s 0l',
      'write: 0h 0m 0r 0w 0s 0l',
      'crash_cache: 0h 0m 0r 0w 0s 1l',
    ]);
    expect(s.db.get(42)).toEqual({ value: 320, version: 4 });
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

  it('suggestions work for every strategy and their frames name real code lines', () => {
    for (const opt of def.params![0].options) {
      const s = def.create({ strategy: opt.value });
      for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
      const used = new Map<string, Set<string>>();
      for (let round = 0; round < 15; round++) {
        for (const op of def.ops) {
          const args = op.suggest?.(s) ?? [];
          expect(args.length).toBe(op.args.length);
          const rec = loud(s);
          op.run(s, args, rec);
          checkFrames(rec.frames);
          const set = used.get(op.id) ?? new Set<string>();
          used.set(op.id, set);
          for (const f of rec.frames) for (const a of f.lines!) set.add(a);
        }
      }
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });
});
