import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  MAX_STATE,
  SEED,
  SIZE,
  advance,
  arrive,
  change,
  create,
  entries,
  keepFrom,
  layout,
  order,
  span,
  view,
  type Side,
  type StreamState,
} from './index';

const quiet = (s: StreamState) => new Recorder(s, layout, false);

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

/** Unique ids, a probe on a real node, a code line on every frame, plain tags, nothing overlapping, magenta only on the followed event. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const byId = new Map(f.scene.nodes.map((n) => [n.id, n]));
    expect(byId.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) expect(byId.has(f.probe.at), `probe at ${f.probe.at}: ${f.message}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') {
        expect(n.tone).toBeUndefined();
        expect(n.hue).toBeUndefined();
      }
      if (n.tone === 'key') {
        // The followed event's own text: c7 or 7@7 for c7@7, u3=DE, o3, v5 for v5@9.
        const p = f.probe!.text;
        const t = n.cells[0].text;
        expect(p === t || p.startsWith(`${t}@`) || p.slice(1) === t || /^u\d+ /.test(t), `${t} is magenta, following ${p}`).toBe(true);
      }
    }
    const bs = boxes(f.scene);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) expect.fail(`${a.id} overlaps ${b.id}`);
      }
    }
    const bounds = sceneBounds(f.scene)!;
    expect(bounds.bw).toBeLessThanOrEqual(950);
    expect(bounds.bh).toBeLessThanOrEqual(430);
  }
}

/** A plain model: every accepted event, every accepted view, the table. */
interface Model {
  acc: Record<Side, [number, number][]>;
  views: Map<number, number>;
  table: Map<number, string>;
  wm: number;
}

const runOp = (s: StreamState, id: string, args: (number | string)[], recording: boolean) => {
  const rec = new Recorder(s, def.layout, recording);
  def.ops.find((o) => o.id === id)!.run(s, args, rec);
  return rec;
};

describe('stream processing and joins', () => {
  for (const [W, L] of [
    [3, 2],
    [3, 0],
    [5, 2],
    [5, 0],
  ]) {
    it(`matches a plain model through random operations (window ${W}, lateness ${L})`, () => {
      const rnd = makeRng(1111 + W * 10 + L);
      const pick = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
      let joins = 0;
      let lateSeen = 0;
      let refused = 0;
      let s = create(W, L);
      let m: Model = { acc: { i: [], c: [] }, views: new Map(), table: new Map(), wm: 0 };
      for (let step = 0; step < 4000; step++) {
        // The page's clock stops at 99: start again well before it.
        if (m.wm > 85) {
          s = create(W, L);
          m = { acc: { i: [], c: [] }, views: new Map(), table: new Map(), wm: 0 };
        }
        const roll = rnd();
        const before = JSON.stringify(s);
        const rec = quiet(s);
        if (roll < 0.45) {
          const side: Side = rnd() < 0.5 ? 'i' : 'c';
          const ad = pick(1, 4);
          const t = pick(Math.max(0, m.wm - 6), m.wm + 6);
          const got = arrive(s, side, ad, t, rec);
          if (got === null) {
            refused++;
            expect(JSON.stringify(s)).toBe(before);
            continue;
          }
          const ok = t >= m.wm - L;
          expect(got.accepted).toBe(ok);
          if (!ok) {
            lateSeen++;
            expect(rec.counters.late).toBe(1);
          } else {
            const o: Side = side === 'i' ? 'c' : 'i';
            const want = m.acc[o]
              .filter(([a, u]) => a === ad && (side === 'i' ? u - t : t - u) >= 0 && (side === 'i' ? u - t : t - u) <= W)
              .map(([, u]) => (side === 'i' ? [t, u] : [u, t]) as [number, number]);
            const key = (p: [number, number]) => p.join(',');
            expect(got.joined.map(key).sort()).toEqual(want.map(key).sort());
            expect(rec.counters.joined ?? 0).toBe(want.length);
            m.acc[side].push([ad, t]);
            joins += want.length;
          }
        } else if (roll < 0.6) {
          const k = pick(1, 4);
          advance(s, k, rec);
          m.wm += k;
          const keep = m.wm - W - L;
          for (const side of ['i', 'c'] as Side[]) {
            const want: Record<string, number[]> = {};
            for (const [a, u] of m.acc[side]) if (u >= keep) (want[a] ??= []).push(u);
            for (const k2 of Object.keys(want)) want[k2].sort((x, y) => x - y);
            const got: Record<string, number[]> = {};
            for (const [a, list] of Object.entries(s.state[side])) got[a] = list.map((e) => e.t);
            expect(got).toEqual(want);
          }
        } else if (roll < 0.8) {
          const t = pick(Math.max(0, m.wm - 8), m.wm + 6);
          const start = t - (t % SIZE);
          const got = view(s, t, rec);
          const kept = start + SIZE + L > m.wm;
          if (kept) {
            if (got === null) {
              refused++;
              expect(JSON.stringify(s)).toBe(before);
              continue;
            }
            expect(got).toBe(start);
            m.views.set(start, (m.views.get(start) ?? 0) + 1);
          } else if (JSON.stringify(s) !== before) {
            expect(got).toBeNull();
            expect(rec.counters.late).toBe(1);
          }
        } else if (roll < 0.9) {
          const u = pick(1, 4);
          const c = ['fr', 'de', 'it'][pick(0, 2)];
          expect(change(s, u, c, rec)).toBe(m.table.get(u) ?? null);
          m.table.set(u, c.toUpperCase());
        } else {
          const u = pick(1, 4);
          expect(order(s, u, rec)).toBe(m.table.get(u) ?? null);
          expect(s.out[s.out.length - 1].text).toBe(`o${u} ${m.table.get(u) ?? 'null'}`);
        }
        // Windows: every window still kept holds the model's count, and none is kept past its lateness.
        for (const w of s.windows) {
          expect(w.count).toBe(m.views.get(w.start));
          expect(w.start + SIZE + L).toBeGreaterThan(s.wm);
          expect(w.fired).toBe(w.start + SIZE <= s.wm);
        }
        expect(entries(s, 'i')).toBeLessThanOrEqual(MAX_STATE);
        expect(entries(s, 'c')).toBeLessThanOrEqual(MAX_STATE);
      }
      expect(joins).toBeGreaterThan(50);
      expect(lateSeen).toBeGreaterThan(20);
      expect(refused).toBeGreaterThan(0);
    });
  }

  it('never loses a match to expiry: everything dropped is out of reach of any accepted event', () => {
    const rnd = makeRng(77);
    for (const [W, L] of [
      [3, 2],
      [5, 0],
    ]) {
      const s = create(W, L);
      for (let i = 0; i < 2000; i++) {
        if (rnd() < 0.2) advance(s, 1 + Math.floor(rnd() * 3), quiet(s));
        else arrive(s, rnd() < 0.5 ? 'i' : 'c', 1 + Math.floor(rnd() * 3), Math.max(0, s.wm - L + Math.floor(rnd() * 6)), quiet(s));
        for (const side of ['i', 'c'] as Side[]) for (const list of Object.values(s.state[side])) for (const e of list) expect(e.t).toBeGreaterThanOrEqual(keepFrom(s));
      }
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    for (const params of [
      { window: 3, lateness: 2 },
      { window: 5, lateness: 0 },
    ]) {
      const a = def.create(params);
      const b = def.create(params);
      for (const [id, ...args] of SEED) {
        runOp(a, id, args, false);
        runOp(b, id, args, false);
      }
      for (let i = 0; i < 300; i++) {
        const op = def.ops[Math.floor(rnd() * def.ops.length)];
        const args = op.suggest!(a);
        const on = runOp(a, op.id, args, true);
        const off = runOp(b, op.id, args, false);
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(JSON.stringify({ ...a, shade: null })).toBe(JSON.stringify({ ...b, shade: null }));
      }
    }
  });

  it('every operation has a listing in both languages with the anchors its frames name', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    for (const window of [3, 5]) {
      for (const lateness of [0, 2]) {
        const s = def.create({ window, lateness });
        const used = new Map<string, Set<string>>();
        const run = (id: string, args: (number | string)[], recording: boolean) => {
          const rec = runOp(s, id, args, recording);
          const set = used.get(id) ?? new Set<string>();
          used.set(id, set);
          for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
          checkFrames(rec.frames);
        };
        for (const [id, ...args] of def.seed) run(id, args, false);
        for (const [id, ...args] of def.tour) run(id, args, true);
        for (let round = 0; round < 40; round++) for (const op of def.ops) run(op.id, op.suggest!(s), true);
        expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
      }
    }
  });

  it('seed and tour tell the story in order', () => {
    expect(def.id).toBe('stream-joins');
    const s = def.create({ window: 3, lateness: 2 });
    for (const [id, ...args] of def.seed) {
      const rec = runOp(s, id, args, true);
      // No seed step is refused.
      expect(rec.frames.some((f) => /Sorry|run from|Enter/.test(f.message))).toBe(false);
    }
    expect(s.wm).toBe(7);
    expect(s.state.i).toEqual({ 5: [{ seq: 5, t: 4 }], 7: [{ seq: 4, t: 2 }, { seq: 6, t: 5 }] });
    expect(s.windows.map((w) => [w.start, w.count, w.fired])).toEqual([
      [4, 2, false],
      [8, 1, false],
      [12, 1, false],
    ]);
    expect(s.out.map((r) => r.text)).toEqual(['5: i4 c6', 'o1 IT']);

    const recs = def.tour.map(([id, ...args]) => {
      const rec = runOp(s, id, args, true);
      checkFrames(rec.frames);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      return rec;
    });
    const last = (i: number) => recs[i].frames[recs[i].frames.length - 1].message;
    // 1. A click joins the impression 2 ticks before it, and not the one 5 ticks before.
    expect(recs[0].counters).toEqual({ comparisons: 3, joined: 1 });
    expect(recs[0].frames.some((f) => f.compare?.verdict === 'too far apart: no match')).toBe(true);
    expect(recs[0].frames.some((f) => f.scene.decor!.some((d) => d.id === 'shade'))).toBe(true);
    // 2. A click whose impression was dropped from state.
    expect(recs[1].counters).toEqual({ comparisons: 1 });
    expect(recs[1].frames.some((f) => /i3@1 was dropped from state when the watermark passed 1 \+ 3 \+ 2 = 6/.test(f.message))).toBe(true);
    expect(recs[1].frames.some((f) => /i3@1 is 7 ticks from c3@8.*price of bounded state/.test(f.message))).toBe(true);
    // 3 and 4. A profile change, then an order that reads it.
    expect(s.table[3]).toBe('DE');
    expect(last(3)).toMatch(/o3 got DE.*got FR/);
    // 5. An out-of-order view counted in its own window.
    expect(recs[4].frames[0].message).toMatch(/after v4@12/);
    // 6. The watermark passes: state is dropped and two windows go out.
    expect(recs[5].counters.expired).toBe(4);
    expect(s.out.map((r) => r.text)).toContain('[8,12) 2');
    expect(s.out.map((r) => r.text)).toContain('[4,8) 2');
    expect(s.windows.map((w) => w.start)).toEqual([8, 12]);
    // 7. A late click past the allowed lateness goes to the side output.
    expect(recs[6].counters).toEqual({ comparisons: 2, late: 1 });
    expect(s.side.map((r) => r.text)).toEqual(['c7@9']);
    expect(def.tour.length).toBeLessThanOrEqual(7);
  });

  it('the tour runs for every parameter, and the scene stays the same size', () => {
    for (const window of [3, 5]) {
      for (const lateness of [0, 2]) {
        const s = def.create({ window, lateness });
        for (const [id, ...args] of def.seed) runOp(s, id, args, false);
        const size = sceneBounds(layout(s));
        for (const [id, ...args] of def.tour) {
          const rec = runOp(s, id, args, true);
          expect(rec.frames.some((f) => /Sorry/.test(f.message))).toBe(false);
          checkFrames(rec.frames);
        }
        expect(sceneBounds(layout(s))).toEqual(size);
      }
    }
  });

  it('answers bad input without changing anything', () => {
    const s = def.create({ window: 3, lateness: 2 });
    for (const [id, ...args] of def.seed) runOp(s, id, args, false);
    const before = JSON.stringify(s);
    const runs: [string, (number | string)[]][] = [
      ['stream_stream', ['x', 3, 9]],
      ['stream_stream', ['c', 0, 9]],
      ['stream_stream', ['i', 7, 5]],
      ['stream_stream', ['c', 3, 0]],
      ['expire', [0]],
      ['window', [8]],
      ['cdc', [9, 'fr']],
      ['cdc', [2, 'france']],
      ['stream_table', [7]],
    ];
    for (const [id, args] of runs) {
      const rec = runOp(s, id, args, true);
      expect(rec.frames.length, id).toBe(1);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
  });

  it('keeps the timelines on screen as time moves on', () => {
    const s = create(3, 2);
    for (let t = 0; t < 60; t += 2) {
      arrive(s, 'i', 1, t, quiet(s));
      arrive(s, 'c', 1, t + 1, quiet(s));
      advance(s, 2, quiet(s));
      const { lo, hi } = span(s);
      expect(hi - lo).toBe(13);
      const scene = layout(s);
      for (const n of scene.nodes) if (n.id.startsWith('tk')) expect(Number(n.cells[0].text)).toBeGreaterThanOrEqual(lo);
      expect(scene.nodes.some((n) => n.id === 'tag-wm')).toBe(true);
    }
  });
});
