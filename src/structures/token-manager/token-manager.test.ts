import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { MAX_QUEUE, MAX_TICK, MAX_TOKENS, count, countByScan, countFifo, create, generate, isStale, layout, liveCount, renew, tick, type TmState } from './index';

const quiet = (s: TmState) => new Recorder(s, layout, false);
const loud = (s: TmState) => new Recorder(s, layout, true);

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, a probe on a real node and cell, a code line, magenta only on the followed token, nothing overlapping. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
      // The chip names the token, and its node shows that token.
      expect(at!.cells.some((c) => c.text === f.probe!.text)).toBe(true);
    }
    expect(f.message).not.toMatch(/undefined|NaN|null|—|-\d/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.compare) expect(f.probe).toBeDefined();
    const edge = corners(f.scene);
    expect(edge).toEqual(corners(frames[0].scene));
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
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
    }
  }
}

function check(s: TmState): void {
  expect(s.tokens.length).toBeLessThanOrEqual(MAX_TOKENS);
  expect(s.queue.length).toBeLessThanOrEqual(MAX_QUEUE);
  expect(new Set(s.tokens.map((t) => t.id)).size).toBe(s.tokens.length);
  for (let i = 1; i < s.queue.length; i++) expect(s.queue[i - 1].expires).toBeLessThanOrEqual(s.queue[i].expires);
  // Every token in the map has its current entry in the queue.
  for (const t of s.tokens) expect(s.queue.some((e) => e.id === t.id && e.expires === t.expires)).toBe(true);
}

describe('token manager', () => {
  for (const ttl of [3, 5, 8]) {
    it(`agrees with a plain map under random operations (ttl ${ttl})`, () => {
      const rnd = makeRng(ttl * 977);
      const s = create(ttl);
      const model = new Map<string, number>();
      let refused = 0;
      let fifoWrong = 0;
      for (let i = 0; i < 4000; i++) {
        const roll = rnd();
        const id = 'abcdefgh'[Math.floor(rnd() * 8)];
        if (roll < 0.3) {
          const ok = generate(s, id, quiet(s));
          if (ok) model.set(id, s.now + ttl);
        } else if (roll < 0.55) {
          const live = model.has(id) && model.get(id)! > s.now;
          const full = s.queue.length >= MAX_QUEUE;
          expect(renew(s, id, quiet(s))).toBe(live && !full);
          if (live && !full) model.set(id, s.now + ttl);
          else if (model.has(id)) refused++;
        } else if (roll < 0.75) {
          if (s.now + 3 > MAX_TICK) continue;
          tick(s, 1 + Math.floor(rnd() * 3), quiet(s));
        } else {
          const truth = [...model.values()].filter((e) => e > s.now).length;
          expect(liveCount(s)).toBe(truth);
          expect(countByScan(s, quiet(s))).toBe(truth);
          const before = JSON.stringify(s);
          const f = countFifo(s, quiet(s));
          expect(f).toBeLessThanOrEqual(truth);
          if (f !== truth) fifoWrong++;
          expect(JSON.stringify(s)).toBe(before);
          expect(count(s, quiet(s))).toBe(truth);
          for (const [k, e] of [...model]) if (e <= s.now) model.delete(k);
          expect(s.tokens.every((t) => t.expires > s.now)).toBe(true);
        }
        check(s);
        if (s.now > MAX_TICK - 5) {
          Object.assign(s, create(ttl));
          model.clear();
        }
      }
      expect(refused).toBeGreaterThan(0);
      expect(fifoWrong).toBeGreaterThan(0);
    });
  }

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(42);
    const a = create(5);
    const b = create(5);
    for (let i = 0; i < 600; i++) {
      const op = def.ops[Math.floor(rnd() * def.ops.length)];
      const args = op.id === 'tick' ? [1 + Math.floor(rnd() * 3)] : op.args.length ? ['abcdef'[Math.floor(rnd() * 6)]] : [];
      if (op.id === 'tick' && a.now > MAX_TICK - 5) continue;
      const ra = loud(a);
      const rb = quiet(b);
      op.run(a, args, ra);
      op.run(b, args, rb);
      expect(ra.counters).toEqual(rb.counters);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      checkFrames(ra.frames);
    }
  });

  it('refuses a renew at exactly the expiry time', () => {
    const s = create(5);
    generate(s, 'b', quiet(s));
    tick(s, 5, quiet(s));
    const r = loud(s);
    expect(renew(s, 'b', r)).toBe(false);
    expect(r.frames.some((f) => f.compare?.op === '≤' && f.compare.right === 'now 5')).toBe(true);
    expect(s.tokens[0].expires).toBe(5);
  });

  it('the stale check keeps a renewed token that the plain FIFO deletes', () => {
    const s = create(5);
    generate(s, 'a', quiet(s));
    tick(s, 3, quiet(s));
    renew(s, 'a', quiet(s));
    expect(isStale(s, s.queue[0])).toBe(true);
    tick(s, 3, quiet(s));
    expect(countFifo(s, quiet(s))).toBe(0);
    expect(count(s, quiet(s))).toBe(1);
  });

  it('seed and tour run through the definition', () => {
    const s = def.create({ ttl: 5 });
    for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
    expect(s.tokens.map((t) => `${t.id}${t.expires}`)).toEqual(['a5', 'b6', 'c7', 'd8']);
    const results: Frame[][] = [];
    for (const [op, ...args] of def.tour) {
      const r = loud(s);
      def.ops.find((o) => o.id === op)!.run(s, args, r);
      checkFrames(r.frames);
      results.push(r.frames);
    }
    const last = (i: number) => results[i][results[i].length - 1].message;
    expect(last(3)).toMatch(/Renew refused/);
    expect(last(4)).toMatch(/^4 tokens live\. The scan read all 5/);
    expect(results[5].some((f) => /signed out a user who renewed in time/.test(f.message))).toBe(true);
    expect(results[5][results[5].length - 2].message).toMatch(/^It reports 3, but 4 are live/);
    expect(last(6)).toMatch(/^4 tokens live: .* looked at 3 entries and popped 2, 1 stale/);
    expect(s.tokens.map((t) => t.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(results.every((f) => f.length <= 24)).toBe(true);
  });
});
