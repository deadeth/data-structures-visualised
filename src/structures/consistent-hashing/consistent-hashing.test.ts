import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { OpDef } from '../../core/types';
import def, {
  MAX_SERVERS,
  RING,
  addServer,
  create,
  hashKey,
  laneFor,
  layout,
  lookup,
  modMoves,
  ownerOf,
  put,
  remove,
  removeServer,
  type RingState,
} from './index';

const quiet = (s: RingState) => new Recorder(s, layout, false);
const loud = (s: RingState) => new Recorder(s, layout, true);

/** Owner by walking the ring one degree at a time. Slow and obviously right. */
function walk(s: RingState, key: number): string {
  const start = hashKey(key);
  for (let i = 0; i < RING; i++) {
    const p = s.points.find((q) => q.pos === (start + i) % RING);
    if (p) return p.server;
  }
  throw new Error('empty ring');
}

function check(s: RingState): void {
  expect(s.cursor).toBeNull();
  expect(s.points.every((p) => p.live)).toBe(true);
  expect(s.points.length).toBe(s.servers.length * s.vnodes);
  for (let i = 1; i < s.points.length; i++) expect(s.points[i - 1].pos).toBeLessThan(s.points[i].pos);
  expect(new Set(s.points.map((p) => p.pos)).size).toBe(s.points.length);
  for (const key of s.keys.keys()) expect(ownerOf(s, key)).toBe(walk(s, key));
}

/** No two key boxes on the canvas may touch. */
function expectNoKeyOverlap(s: RingState): void {
  const keys = layout(s).nodes.filter((n) => n.id.startsWith('k'));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i];
      const b = keys[j];
      const sa = nodeSize(a);
      const sb = nodeSize(b);
      const apart = Math.abs(a.x - b.x) >= (sa.w + sb.w) / 2 || Math.abs(a.y - b.y) >= (sa.h + sb.h) / 2;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
}

describe('consistent hash ring', () => {
  it('hashes every key to a ring position and reaches every position', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 1000; k++) {
      const h = hashKey(k);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(RING);
      seen.add(h);
    }
    expect(seen.size).toBe(RING);
  });

  for (const vnodes of [1, 3]) {
    it(`matches a brute-force ring under random operations (${vnodes} point${vnodes > 1 ? 's' : ''} per server)`, () => {
      const rnd = makeRng(90 + vnodes);
      const s = create(vnodes);
      const model = new Set<number>();
      for (let i = 0; i < 4000; i++) {
        const roll = rnd();
        const key = Math.floor(rnd() * 1000);
        if (roll < 0.4) {
          const fits = !model.has(key) && laneFor(s, hashKey(key)) >= 0;
          expect(put(s, key, quiet(s))).toBe(fits);
          if (fits) model.add(key);
        } else if (roll < 0.65) {
          expect(remove(s, key, quiet(s))).toBe(model.delete(key));
        } else if (roll < 0.85) {
          expect(lookup(s, key, quiet(s))).toBe(walk(s, key));
        } else if (roll < 0.93) {
          const before = new Map([...s.keys.keys()].map((k) => [k, ownerOf(s, k)]));
          const full = s.servers.length === MAX_SERVERS;
          const out = addServer(s, quiet(s));
          if (full) {
            expect(out).toBeNull();
          } else {
            // Every key that changed owner went to the new server, and the report lists exactly those.
            const changed = [...before.keys()].filter((k) => ownerOf(s, k) !== before.get(k)).sort((a, b) => a - b);
            for (const k of changed) expect(ownerOf(s, k)).toBe(out!.name);
            expect(out!.moved).toEqual(changed);
          }
        } else {
          const name = s.servers[Math.floor(rnd() * s.servers.length)];
          const before = new Map([...s.keys.keys()].map((k) => [k, ownerOf(s, k)]));
          const last = s.servers.length === 1;
          const out = removeServer(s, name.toLowerCase(), quiet(s));
          if (last) {
            expect(out).toBeNull();
          } else {
            // Only the keys the server held changed owner.
            const changed = [...before.keys()].filter((k) => ownerOf(s, k) !== before.get(k)).sort((a, b) => a - b);
            const held = [...before.keys()].filter((k) => before.get(k) === name).sort((a, b) => a - b);
            expect(changed).toEqual(held);
            expect(out!.moved).toEqual(held);
          }
        }
        expect([...s.keys.keys()].sort((a, b) => a - b)).toEqual([...model].sort((a, b) => a - b));
        check(s);
        if (i % 50 === 0) expectNoKeyOverlap(s);
      }
    });
  }

  it('counts the same with recording on and off', () => {
    const script: [string, ...(number | string)[]][] = [
      ['lookup', 63],
      ['put', 189],
      ['put', 189],
      ['addServer'],
      ['lookup', 14],
      ['delete', 50],
      ['delete', 50],
      ['removeServer', 'a'],
      ['removeServer', 'z'],
      ['addServer'],
      ['lookup', 999],
    ];
    for (const vnodes of [1, 3]) {
      const a = create(vnodes);
      const b = create(vnodes);
      for (const state of [a, b]) for (const [id, ...args] of def.seed) (def.ops.find((o) => o.id === id) as OpDef<RingState>).run(state, args, quiet(state));
      for (const [id, ...args] of script) {
        const op = def.ops.find((o) => o.id === id) as OpDef<RingState>;
        const ra = loud(a);
        const rb = quiet(b);
        op.run(a, args, ra);
        op.run(b, args, rb);
        expect(ra.counters).toEqual(rb.counters);
        expect(ra.frames.length).toBeGreaterThan(0);
        expect(rb.frames.length).toBe(0);
        expect([...a.keys.keys()]).toEqual([...b.keys.keys()]);
        expect(a.points).toEqual(b.points);
        check(a);
      }
    }
  });

  it('moves far fewer keys than hash mod N when a server joins', () => {
    const s = create(3);
    const rnd = makeRng(7);
    while (s.keys.size < 14) put(s, Math.floor(rnd() * 1000), quiet(s));
    const naive = modMoves(s.keys.keys(), 3, 4);
    const out = addServer(s, quiet(s))!;
    expect(out.moved.length).toBeLessThan(naive);
  });

  it('shows the followed key on every lookup frame and ends on the owner', () => {
    const s = create(1);
    for (const [, k] of def.seed) put(s, Number(k), quiet(s));
    const rec = loud(s);
    const owner = lookup(s, 63, rec);
    expect(owner).toBe(walk(s, 63));
    for (const f of rec.frames) expect(f.probe?.text).toBe('63');
    const lastFrame = rec.frames[rec.frames.length - 1];
    expect(lastFrame.probe?.at.startsWith(`p-${owner}-`)).toBe(true);
    expect(rec.frames.filter((f) => f.compare).length).toBe(rec.counters.comparisons);
  });

  it('runs its seed and tour through the definition for every parameter choice', () => {
    for (const option of def.params![0].options) {
      const s = def.create({ vnodes: option.value });
      for (const [id, ...args] of def.seed) (def.ops.find((o) => o.id === id) as OpDef<RingState>).run(s, args, quiet(s));
      expect(s.keys.size).toBe(def.seed.length);
      expectNoKeyOverlap(s);
      for (const [id, ...args] of def.tour) {
        const rec = loud(s);
        (def.ops.find((o) => o.id === id) as OpDef<RingState>).run(s, args, rec);
        expect(rec.frames.length).toBeGreaterThan(1);
        for (const f of rec.frames) expect(f.message.length).toBeGreaterThan(10);
        check(s);
      }
      expect(def.status!(s).length).toBeGreaterThan(1);
      const [fillOp, fillKey] = def.fill!(s);
      expect(fillOp).toBe('put');
      expect(typeof fillKey).toBe('number');
    }
  });
});
