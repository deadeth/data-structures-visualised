import { describe, expect, it } from 'vitest';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { CAP, append, create, layout, prepend, remove, search, toArray, type LNode, type ListState } from './index';

const quiet = (s: ListState) => new Recorder(s, layout, false);
const loud = (s: ListState) => new Recorder(s, layout, true);

/** Throws if the list is not a well-formed chain that matches the model. */
function check(s: ListState, model: number[]): void {
  expect(toArray(s)).toEqual(model);
  expect(s.size).toBe(model.length);
  expect([...s.keys].sort((a, b) => a - b)).toEqual([...model].sort((a, b) => a - b));
  if (model.length === 0) {
    expect(s.head).toBeNull();
    expect(s.tail).toBeNull();
  } else {
    let last: LNode = s.head!;
    while (last.next) last = last.next;
    expect(s.tail).toBe(last);
    expect(s.head!.key).toBe(model[0]);
    expect(s.tail!.key).toBe(model[model.length - 1]);
  }
  // Nothing transient is left behind for layout to draw.
  expect(s.draft).toBeNull();
  expect(s.ghost).toBeNull();
  expect(s.prev).toBeNull();
}

/** Every frame must be drawable: unique ids, edges that join real nodes, a probe that points at one. */
function checkFrames(frames: Frame[]): void {
  // Plain checks with one assertion at the end: this runs over tens of thousands of frames.
  const problems: string[] = [];
  frames.forEach((f, i) => {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    if (ids.size !== f.scene.nodes.length) problems.push(`frame ${i}: duplicate node id`);
    if (new Set(f.scene.edges.map((e) => e.id)).size !== f.scene.edges.length) problems.push(`frame ${i}: duplicate edge id`);
    for (const e of f.scene.edges) if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`frame ${i}: edge ${e.id} joins a missing node`);
    if (f.probe && !ids.has(f.probe.at)) problems.push(`frame ${i}: probe at missing node ${f.probe.at}`);
    if (new Set(f.scene.nodes.map((n) => `${n.x},${n.y}`)).size !== f.scene.nodes.length) problems.push(`frame ${i}: two nodes share a position`);
    if (!f.message || /undefined|NaN|\[object/.test(f.message)) problems.push(`frame ${i}: bad message "${f.message}"`);
  });
  expect(problems).toEqual([]);
}

type Op = 'prepend' | 'append' | 'search' | 'delete';
const OPS = { prepend, append, search, delete: remove } as const;

/** Apply an op to the plain-array model and say what the list should return. */
function applyModel(model: number[], op: Op, k: number): boolean {
  const i = model.indexOf(k);
  if (op === 'search') return i >= 0;
  if (op === 'delete') {
    if (i < 0) return false;
    model.splice(i, 1);
    return true;
  }
  if (i >= 0) return false;
  if (op === 'prepend') model.unshift(k);
  else model.push(k);
  return true;
}

describe('linked list', () => {
  it('matches an array model through random operations with recording off', () => {
    const rnd = makeRng(4242);
    const s = create();
    const model: number[] = [];
    const ops: Op[] = ['prepend', 'append', 'append', 'search', 'delete', 'delete'];
    for (let i = 0; i < 6000; i++) {
      const op = ops[Math.floor(rnd() * ops.length)];
      const k = Math.floor(rnd() * 120);
      const want = applyModel(model, op, k);
      expect(OPS[op](s, k, quiet(s))).toBe(want);
      if (i % 40 === 0) check(s, model);
    }
    check(s, model);
    expect(model.length).toBeGreaterThan(CAP);
    // Empty it from alternating ends and the middle.
    while (model.length) {
      const k = model[Math.floor(rnd() * model.length)];
      applyModel(model, 'delete', k);
      expect(remove(s, k, quiet(s))).toBe(true);
    }
    check(s, []);
  });

  it('gives the same result, state and counters with recording on and off', () => {
    const rnd = makeRng(99);
    const a = create();
    const b = create();
    const model: number[] = [];
    const ops: Op[] = ['prepend', 'append', 'search', 'delete'];
    for (let i = 0; i < 2500; i++) {
      // Stay under the cap so the recorded run is never refused.
      let op = ops[Math.floor(rnd() * ops.length)];
      if (model.length >= CAP - 1 && (op === 'prepend' || op === 'append')) op = 'delete';
      const k = Math.floor(rnd() * 30);
      const want = applyModel(model, op, k);
      const on = loud(a);
      const off = quiet(b);
      expect(OPS[op](a, k, on)).toBe(want);
      expect(OPS[op](b, k, off)).toBe(want);
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      if (i % 10 === 0) {
        check(a, model);
        check(b, model);
      }
    }
    check(a, model);
    check(b, model);
  }, 30_000);

  it('prepend and append cost two pointer writes and no comparisons at any length', () => {
    const s = create();
    for (let k = 0; k < 5000; k++) {
      const rec = quiet(s);
      expect(k % 2 ? prepend(s, k, rec) : append(s, k, rec)).toBe(true);
      expect(rec.counters).toEqual({ writes: 2 });
    }
    expect(s.size).toBe(5000);
    // A duplicate is refused without walking.
    const rec = quiet(s);
    expect(append(s, 2500, rec)).toBe(false);
    expect(prepend(s, 2500, rec)).toBe(false);
    expect(rec.counters).toEqual({});
    expect(s.size).toBe(5000);
  });

  it('search compares once per node walked', () => {
    const s = create();
    for (const k of [5, 10, 15, 20, 25, 30]) append(s, k, quiet(s));
    const hit = quiet(s);
    expect(search(s, 20, hit)).toBe(true);
    expect(hit.counters).toEqual({ comparisons: 4, reads: 4 });
    const miss = quiet(s);
    expect(search(s, 99, miss)).toBe(false);
    expect(miss.counters).toEqual({ comparisons: 6, reads: 6 });
    const on = loud(s);
    search(s, 99, on);
    expect(on.frames.filter((f) => f.compare).length).toBe(6);
    expect(on.frames.every((f) => f.probe)).toBe(true);
    expect(on.frames[on.frames.length - 1].probe!.at).toBe('null');
  });

  it('delete rewires head, middle, tail and the only node', () => {
    const s = create();
    for (const k of [1, 2, 3, 4, 5]) append(s, k, quiet(s));
    const mid = loud(s);
    expect(remove(s, 3, mid)).toBe(true);
    expect(mid.counters).toEqual({ comparisons: 3, reads: 3, writes: 1 });
    checkFrames(mid.frames);
    // While 3 is unlinked but still drawn, 2 already points past it at 4.
    const rewired = mid.frames.find((f) => f.scene.nodes.some((n) => n.caption === 'unlinked'))!;
    const idOf = (text: string) => rewired.scene.nodes.find((n) => n.cells[0].text === text)!.id;
    expect(rewired.scene.edges.find((e) => e.from === idOf('2'))!.to).toBe(idOf('4'));
    expect(rewired.scene.edges.find((e) => e.from === idOf('3'))!.dashed).toBe(true);
    check(s, [1, 2, 4, 5]);

    const head = loud(s);
    expect(remove(s, 1, head)).toBe(true);
    expect(head.counters).toEqual({ comparisons: 1, reads: 1, writes: 1 });
    checkFrames(head.frames);
    check(s, [2, 4, 5]);

    const tail = loud(s);
    expect(remove(s, 5, tail)).toBe(true);
    expect(tail.counters).toEqual({ comparisons: 3, reads: 3, writes: 2 });
    checkFrames(tail.frames);
    check(s, [2, 4]);

    const miss = loud(s);
    expect(remove(s, 9, miss)).toBe(false);
    expect(miss.counters).toEqual({ comparisons: 2, reads: 2 });
    checkFrames(miss.frames);
    check(s, [2, 4]);

    remove(s, 2, quiet(s));
    const only = loud(s);
    expect(remove(s, 4, only)).toBe(true);
    expect(only.counters).toEqual({ comparisons: 1, reads: 1, writes: 2 });
    checkFrames(only.frames);
    check(s, []);

    const empty = loud(s);
    expect(remove(s, 4, empty)).toBe(false);
    expect(search(s, 4, empty)).toBe(false);
    checkFrames(empty.frames);
    // An empty list can be refilled from either end.
    const refill = loud(s);
    expect(prepend(s, 7, refill)).toBe(true);
    expect(append(s, 8, refill)).toBe(true);
    checkFrames(refill.frames);
    check(s, [7, 8]);
  });

  it('node ids stay put, so a prepend slides the rest along', () => {
    const s = create();
    for (const k of [10, 20, 30]) append(s, k, quiet(s));
    const before = new Map(layout(s).nodes.map((n) => [n.cells[0].text, n]));
    prepend(s, 5, quiet(s));
    const after = new Map(layout(s).nodes.map((n) => [n.cells[0].text, n]));
    for (const k of ['10', '20', '30']) {
      expect(after.get(k)!.id).toBe(before.get(k)!.id);
      expect(after.get(k)!.x).toBeGreaterThan(before.get(k)!.x);
    }
    expect(after.get('5')!.title).toBe('head');
    expect(after.get('30')!.title).toBe('tail');
  });

  it('refuses inserts past the cap while recording, and has no cap otherwise', () => {
    const s = create();
    for (let k = 0; k < CAP; k++) append(s, k, quiet(s));
    for (const op of [prepend, append]) {
      const rec = loud(s);
      expect(op(s, 500, rec)).toBe(false);
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(/Sorry/);
      expect(rec.counters).toEqual({});
      checkFrames(rec.frames);
    }
    expect(s.size).toBe(CAP);
    // A duplicate in a full list is reported as a duplicate, not as a full list.
    const dup = loud(s);
    expect(append(s, 3, dup)).toBe(false);
    expect(dup.frames[0].message).toMatch(/already in the list/);
    expect(dup.frames[0].probe).toBeDefined();
    checkFrames(dup.frames);
    expect(append(s, 500, quiet(s))).toBe(true);
    expect(s.size).toBe(CAP + 1);
  });

  it('seed, tour and fill run cleanly through the definition', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(toArray(s)).toEqual([23, 7, 61, 42, 15]);
    expect(def.status!(s).map((f) => f.value)).toEqual(['5', '23', '15']);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      checkFrames(rec.frames);
      // The scene stays within the size the page is designed for.
      for (const f of rec.frames) {
        const xs = f.scene.nodes.map((n) => n.x);
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1000);
      }
    }
    expect(toArray(s)).toEqual([88, 23, 7, 42, 15, 30]);
    check(s, [88, 23, 7, 42, 15, 30]);
    // Every op suggests arguments it can run with.
    for (const op of def.ops) {
      const args = op.suggest!(s);
      expect(args.length).toBe(op.args.length);
      for (const a of args) expect(Number.isInteger(a) && Number(a) >= 0 && Number(a) <= 999).toBe(true);
    }
    // "Add random keys" runs quietly, so fill must hold itself to the cap.
    for (let i = 0; i < 40; i++) {
      const [id, ...args] = def.fill!(s);
      run(id, args, false);
    }
    expect(s.size).toBe(CAP);
    checkFrames([{ scene: def.layout(s), message: 'rest', counters: {} }]);
    expect(def.bench).toEqual({ insert: 'append', search: 'search' });
  });
});
