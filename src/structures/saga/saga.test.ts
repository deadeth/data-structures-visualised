import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { AMOUNT, BALANCE, LIMIT, create, free, inFlight, layout, type SagaState } from './index';

const run = (s: SagaState, id: string, args: (number | string)[], recording = true) => {
  const rec = new Recorder(s, layout, recording);
  def.ops.find((o) => o.id === id)!.run(s, args, rec);
  return rec;
};

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
      expect(f.probe.text).toMatch(/^S\d+$/);
    }
    expect(f.message).not.toMatch(/undefined|NaN|null|\[object/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.compare) expect(f.probe).toBeDefined();
    for (const e of f.scene.edges) {
      expect(ids.has(e.from) && ids.has(e.to), `edge ${e.id}`).toBe(true);
    }
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 0.5 || a.y1 < edge.y1) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    expect(edge).toEqual(corners(frames[0].scene));
    // Scene stays inside the size the brief allows.
    expect(edge.x2 - edge.x1).toBeLessThanOrEqual(1000);
    expect(edge.y2 - edge.y1).toBeLessThanOrEqual(440);
  }
}

/** Money and limit add up: what left is exactly the completed sagas, and nothing is held after a saga ends. */
function checkBooks(s: SagaState): void {
  const done = s.mode === 'orchestration' ? s.log.filter((r) => r.state === 'completed').reduce((a, r) => a + r.amount, 0) : null;
  if (done !== null) {
    expect(s.balance).toBe(BALANCE - done);
    const counting = s.log.filter((r) => r.state !== 'completed' && r.state !== 'compensated' && r.done >= 2).reduce((a, r) => a + r.amount, 0);
    expect(s.used).toBe(done + counting);
    expect(s.log.filter((r) => r.state === 'completed').length).toBe(s.completed);
    expect(s.log.filter((r) => r.state === 'compensated').length).toBe(s.compensated);
  }
  expect(s.used).toBeLessThanOrEqual(LIMIT);
  expect(free(s)).toBeGreaterThanOrEqual(0);
  if (s.mode === 'orchestration' && !inFlight(s)) expect(Object.keys(s.holds)).toEqual([]);
  if (s.mode === 'choreography' && !s.queue.length) expect(Object.keys(s.holds)).toEqual([]);
  expect(s.lost).toEqual([]);
  expect(s.crashAfter).toBeNull();
  for (const v of s.svcs) expect(v.refuse || v.down > 0).toBe(false);
}

describe('saga', () => {
  for (const mode of [0, 1]) {
    it(`keeps the books straight under random operations (${mode ? 'choreography' : 'orchestration'})`, () => {
      const rnd = makeRng(17 + mode);
      for (let round = 0; round < 6; round++) {
        const loud = def.create({ mode });
        const quiet = def.create({ mode });
        for (const [id, ...args] of def.seed) {
          run(loud, id, args);
          run(quiet, id, args, false);
        }
        for (let i = 0; i < 160; i++) {
          const op = def.ops[Math.floor(rnd() * def.ops.length)];
          const args = op.id === 'fail' || op.id === 'timeout' || op.id === 'crash_orchestrator' ? [1 + Math.floor(rnd() * 4)] : [];
          const a = run(loud, op.id, args);
          const b = run(quiet, op.id, args, false);
          // Counters agree with recording on and off.
          expect(b.counters).toEqual(a.counters);
          checkFrames(a.frames);
          checkBooks(loud);
          expect(JSON.stringify({ ...quiet, msgs: [], outage: null })).toBe(JSON.stringify({ ...loud, msgs: [], outage: null }));
        }
      }
    });
  }

  it('compensates in reverse order and never twice', () => {
    const s = create();
    const rec = run(s, 'fail', [3]);
    const undo = rec.frames.filter((f) => /sends (unhold|release)/.test(f.message)).map((f) => f.message.match(/sends (\w+)/)![1]);
    expect(undo).toEqual(['unhold', 'release']);
    expect(rec.counters.compensations).toBe(2);
    expect(rec.counters.compensated).toBe(1);
    expect(s.balance).toBe(BALANCE);
    expect(s.used).toBe(0);
  });

  it('answers a resent command from the record', () => {
    for (const op of ['timeout', 'crash_orchestrator']) {
      for (let k = 1; k <= 4; k++) {
        const s = create();
        const rec = run(s, op, [k]);
        expect(rec.counters.local).toBe(4);
        expect(rec.counters.completed).toBe(1);
        expect(rec.frames.some((f) => f.compare?.verdict === 'answer from the record')).toBe(true);
        expect(s.balance).toBe(BALANCE - AMOUNT);
      }
    }
  });

  it('lets a pivot failure only go forward', () => {
    const s = create();
    const rec = run(s, 'pivot', []);
    expect(rec.counters.retries).toBe(2);
    expect(rec.counters.compensations ?? 0).toBe(0);
    expect(rec.counters.completed).toBe(1);
  });

  it('parks the second saga on a semantic lock, then completes it', () => {
    const s = create();
    run(s, 'start', [], false);
    const rec = run(s, 'concurrent', []);
    expect(rec.frames.some((f) => f.lines?.includes('pending'))).toBe(true);
    expect(rec.counters.completed).toBe(1);
    expect(rec.counters.compensated).toBe(1);
    expect(s.balance).toBe(BALANCE - 2 * AMOUNT);
  });

  it('seed and tour tell the story in order', () => {
    expect(def.id).toBe('saga');
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    for (const mode of [0, 1]) {
      const s = def.create({ mode });
      for (const [id, ...args] of def.seed) run(s, id, args, false);
      const recs = def.tour.map(([id, ...args]) => {
        const rec = run(s, id, args);
        checkFrames(rec.frames);
        return rec;
      });
      if (mode === 0) {
        expect(recs.map((r) => r.counters.completed ?? 0)).toEqual([1, 0, 1, 1, 1, 1]);
        expect(recs.map((r) => r.counters.compensated ?? 0)).toEqual([0, 1, 0, 0, 1, 0]);
        expect(recs[2].counters.retries).toBe(1);
        expect(recs[5].counters.retries).toBe(2);
        for (const r of recs) expect(r.frames.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it('keeps both listings in step with every frame', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    const used = new Map<string, Set<string>>();
    for (const mode of [0, 1]) {
      const s = def.create({ mode });
      for (const [id, ...args] of def.seed) run(s, id, args, false);
      const go = (id: string, args: (number | string)[]) => {
        const rec = run(s, id, args);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
      };
      for (const [id, ...args] of def.tour) go(id, args);
      for (let round = 0; round < 30; round++) for (const op of def.ops) go(op.id, op.suggest?.(s) ?? []);
      for (const k of [1, 2, 3, 4]) for (const op of ['fail', 'timeout', 'crash_orchestrator', 'step']) go(op, [k]);
    }
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
  });
});
