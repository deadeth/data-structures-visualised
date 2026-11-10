import { describe, expect, it } from 'vitest';
import { CHAR_W, nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { create, dequeue, enqueue, items, layout, type QueueState } from './index';

const quiet = (s: QueueState) => new Recorder(s, layout, false);
const loud = (s: QueueState) => new Recorder(s, layout, true);

/** Throws if any ring buffer invariant is broken. */
function check(s: QueueState): void {
  expect(s.slots.length).toBe(s.capacity);
  expect(s.size).toBeGreaterThanOrEqual(0);
  expect(s.size).toBeLessThanOrEqual(s.capacity);
  expect(s.head).toBeGreaterThanOrEqual(0);
  expect(s.head).toBeLessThan(s.capacity);
  expect(s.tail).toBeGreaterThanOrEqual(0);
  expect(s.tail).toBeLessThan(s.capacity);
  // Tail is always `size` slots clockwise of head.
  expect((s.head + s.size) % s.capacity).toBe(s.tail);
  // Exactly the slots from head up to tail hold a value.
  for (let i = 0; i < s.capacity; i++) {
    const live = (i - s.head + s.capacity) % s.capacity < s.size;
    if (live) expect(typeof s.slots[i]).toBe('number');
    else expect(s.slots[i]).toBeNull();
  }
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;

function nodeBoxes(scene: Scene): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const n of scene.nodes) {
    const { w, h } = nodeSize(n);
    out.set(n.id, { x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 });
  }
  return out;
}

/** The pinned corners of the scene, which the layout promises never to draw outside. */
function bounds(scene: Scene): Box {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, y1: a.y - 9, x2: b.x, y2: b.y + 9 };
}

/** Where the renderer draws the probe chip for this frame (mirrors Renderer.aimProbe). */
function chipBox(f: Frame): Box | null {
  if (!f.probe) return null;
  const n = f.scene.nodes.find((x) => x.id === f.probe!.at)!;
  const { w: nw, h: nh } = nodeSize(n);
  const w = Math.max(34, f.probe.text.length * CHAR_W + 20);
  const h = 26;
  const place = f.probe.place ?? 'above';
  let x = n.x;
  let y = n.y;
  if (place === 'above') y = n.y - nh / 2 - h / 2 - 9 - (n.title ? 16 : 0);
  else if (place === 'below') y = n.y + nh / 2 + h / 2 + 9 + (n.caption ? 16 : 0);
  else if (place === 'left') x = n.x - nw / 2 - w / 2 - 10;
  else x = n.x + nw / 2 + w / 2 + 10;
  return { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 };
}

/** Nothing overlaps and nothing leaves the scene, including the chip. */
function checkFrame(f: Frame): void {
  const boxes = nodeBoxes(f.scene);
  const ids = [...boxes.keys()];
  expect(new Set(f.scene.nodes.map((n) => n.id)).size).toBe(f.scene.nodes.length);
  const edge = bounds(f.scene);
  for (let i = 0; i < ids.length; i++) {
    const a = boxes.get(ids[i])!;
    expect(a.x1, `${ids[i]} left`).toBeGreaterThanOrEqual(edge.x1 - 0.5);
    expect(a.x2, `${ids[i]} right`).toBeLessThanOrEqual(edge.x2 + 0.5);
    expect(a.y1, `${ids[i]} top`).toBeGreaterThanOrEqual(edge.y1 - 0.5);
    expect(a.y2, `${ids[i]} bottom`).toBeLessThanOrEqual(edge.y2 + 0.5);
    for (let j = i + 1; j < ids.length; j++) expect(overlaps(a, boxes.get(ids[j])!), `${ids[i]} overlaps ${ids[j]}`).toBe(false);
  }
  const chip = chipBox(f);
  if (f.probe) expect(boxes.has(f.probe.at)).toBe(true);
  if (chip) {
    expect(chip.x1, 'chip left').toBeGreaterThanOrEqual(edge.x1 - 0.5);
    expect(chip.x2, 'chip right').toBeLessThanOrEqual(edge.x2 + 0.5);
    expect(chip.y1, 'chip top').toBeGreaterThanOrEqual(edge.y1 - 0.5);
    expect(chip.y2, 'chip bottom').toBeLessThanOrEqual(edge.y2 + 0.5);
    for (const [id, b] of boxes) expect(overlaps(chip, b), `chip at ${f.probe!.at} (${f.probe!.place}) overlaps ${id}: ${JSON.stringify(chip)} ${JSON.stringify(b)} ${f.message}`).toBe(false);
  }
}

describe('ring buffer queue', () => {
  for (const capacity of [6, 8, 12]) {
    it(`matches a plain array through random enqueues and dequeues (capacity ${capacity})`, () => {
      const rnd = makeRng(capacity * 7919);
      const s = create(capacity);
      const model: number[] = [];
      let wraps = 0;
      let rejected = 0;
      // Lean towards enqueues for a while, then towards dequeues, so the buffer is often full and often empty.
      for (let i = 0; i < 4000; i++) {
        const lean = Math.floor(i / 250) % 2 === 0 ? 0.65 : 0.35;
        if (rnd() < lean) {
          const k = Math.floor(rnd() * 1000);
          const before = s.tail;
          const ok = enqueue(s, k, quiet(s));
          expect(ok).toBe(model.length < capacity);
          if (ok) {
            model.push(k);
            if (s.tail < before) wraps++;
          } else {
            rejected++;
            expect(s.tail).toBe(before);
          }
        } else {
          const got = dequeue(s, quiet(s));
          expect(got).toBe(model.length ? model.shift()! : null);
        }
        check(s);
        expect(s.size).toBe(model.length);
        if (i % 20 === 0) expect(items(s)).toEqual(model);
      }
      expect(items(s)).toEqual(model);
      expect(wraps).toBeGreaterThan(50);
      expect(rejected).toBeGreaterThan(50);
      // Drain it completely.
      while (model.length) expect(dequeue(s, quiet(s))).toBe(model.shift()!);
      check(s);
      expect(s.size).toBe(0);
      expect(dequeue(s, quiet(s))).toBeNull();
    });
  }

  it('wraps tail and head back to slot 0 and keeps first in, first out across the wrap', () => {
    const s = create(6);
    for (const k of [1, 2, 3, 4, 5]) enqueue(s, k, quiet(s));
    expect(dequeue(s, quiet(s))).toBe(1);
    expect(dequeue(s, quiet(s))).toBe(2);
    expect(s.tail).toBe(5);
    enqueue(s, 6, quiet(s));
    expect(s.tail).toBe(0);
    enqueue(s, 7, quiet(s));
    expect(s.slots).toEqual([7, null, 3, 4, 5, 6]);
    expect(s.tail).toBe(1);
    expect(items(s)).toEqual([3, 4, 5, 6, 7]);
    for (const k of [3, 4, 5, 6]) expect(dequeue(s, quiet(s))).toBe(k);
    expect(s.head).toBe(0);
    expect(dequeue(s, quiet(s))).toBe(7);
    check(s);
  });

  it('rejects a write to a full buffer after one comparison and changes nothing', () => {
    const s = create(6);
    for (let k = 1; k <= 6; k++) expect(enqueue(s, k, quiet(s))).toBe(true);
    expect(s.head).toBe(s.tail);
    const before = JSON.stringify(s);
    const rec = quiet(s);
    expect(enqueue(s, 99, rec)).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    expect(rec.counters).toEqual({ comparisons: 1, rejected: 1 });
    // One dequeue makes room for exactly one more.
    expect(dequeue(s, quiet(s))).toBe(1);
    expect(enqueue(s, 99, quiet(s))).toBe(true);
    expect(enqueue(s, 100, quiet(s))).toBe(false);
    expect(items(s)).toEqual([2, 3, 4, 5, 6, 99]);
  });

  it('costs the same whatever the queue holds: one comparison, then one write or one read', () => {
    for (const fill of [0, 1, 5, 11]) {
      const s = create(12);
      for (let k = 0; k < fill; k++) enqueue(s, k, quiet(s));
      const put = quiet(s);
      enqueue(s, 500, put);
      expect(put.counters).toEqual({ comparisons: 1, writes: 1 });
      const take = quiet(s);
      dequeue(s, take);
      expect(take.counters).toEqual({ comparisons: 1, reads: 1 });
    }
    const empty = create(6);
    const rec = quiet(empty);
    expect(dequeue(empty, rec)).toBeNull();
    expect(rec.counters).toEqual({ comparisons: 1 });
  });

  it('counts the same with recording on and off', () => {
    const rnd = makeRng(4242);
    const a = create(8);
    const b = create(8);
    for (let i = 0; i < 600; i++) {
      const on = loud(a);
      const off = quiet(b);
      if (rnd() < 0.55) {
        const k = Math.floor(rnd() * 1000);
        expect(enqueue(a, k, on)).toBe(enqueue(b, k, off));
      } else {
        expect(dequeue(a, on)).toBe(dequeue(b, off));
      }
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(1);
      expect(on.counters).toEqual(off.counters);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      expect(a).toEqual(b);
    }
  });

  it('records the full-or-empty check as a comparison and follows the key with the probe', () => {
    const s = create(8);
    for (const k of [10, 20, 30]) enqueue(s, k, quiet(s));
    const put = loud(s);
    enqueue(s, 40, put);
    expect(put.frames[0].compare).toEqual({ left: 'size 3', op: '<', right: 'capacity 8', verdict: expect.any(String) });
    expect(put.frames[0].probe).toMatchObject({ text: '40', at: 'producer' });
    expect(put.frames[1].probe).toMatchObject({ text: '40', at: 'tail' });
    // Magenta is only ever on the slot that holds the followed key.
    for (const f of put.frames) {
      for (const n of f.scene.nodes) if (n.tone === 'key') expect(n.cells[0].text).toBe('40');
    }
    const take = loud(s);
    expect(dequeue(s, take)).toBe(10);
    expect(take.frames[0].compare).toMatchObject({ left: 'size 4', op: '>', right: 0 });
    expect(take.frames[1].probe).toMatchObject({ text: '10', at: 'head' });
    expect(take.frames[take.frames.length - 1].probe).toMatchObject({ text: '10', at: 'consumer' });
    for (const f of take.frames) {
      for (const n of f.scene.nodes) if (n.tone === 'key') expect(n.cells[0].text).toBe('10');
    }
  });

  for (const capacity of [6, 8, 12]) {
    it(`draws every frame without overlaps or anything off the scene (capacity ${capacity})`, () => {
      const s = create(capacity);
      let key = 100;
      // Two and a bit laps: fill to the brim, hit a rejection, drain to empty, hit an empty read, and repeat
      // from a different starting slot, so head and tail meet (full and empty) on every side of the ring.
      const script: ('in' | 'out')[] = [];
      for (let lap = 0; lap < 3; lap++) {
        for (let i = 0; i <= capacity; i++) script.push('in');
        for (let i = 0; i <= capacity; i++) script.push('out');
        for (let i = 0; i < Math.floor(capacity / 3) + lap; i++) script.push('in', 'out');
      }
      let frames = 0;
      for (const what of script) {
        const rec = loud(s);
        if (what === 'in') enqueue(s, key++, rec);
        else dequeue(s, rec);
        for (const f of rec.frames) {
          checkFrame(f);
          frames++;
        }
        check(s);
      }
      expect(frames).toBeGreaterThan(100);
      // The scene keeps the same outer size all the way round, so the view never rescales.
      const sizes = new Set<string>();
      for (let i = 0; i < capacity * 2; i++) {
        const b = bounds(layout(s));
        sizes.add(`${b.x2 - b.x1}x${b.y2 - b.y1}`);
        enqueue(s, key++, quiet(s));
        if (i % 2) dequeue(s, quiet(s));
      }
      expect(sizes.size).toBe(1);
    });
  }

  it('seed and tour run cleanly through the definition, and the tour shows a wrap and a rejection', () => {
    for (const p of def.params![0].options) {
      const s = def.create({ capacity: p.value });
      const run = (id: string, args: (number | string)[], recording: boolean) => {
        const op = def.ops.find((o) => o.id === id)!;
        const rec = new Recorder(s, def.layout, recording);
        op.run(s, args, rec);
        return rec;
      };
      for (const [id, ...args] of def.seed) run(id, args, false);
      check(s);
      expect(s.size).toBeGreaterThan(0);
      let wrapped = false;
      let rejected = 0;
      let filled = false;
      for (const [id, ...args] of def.tour) {
        const tailBefore = s.tail;
        const rec = run(id, args, true);
        expect(rec.frames.length).toBeGreaterThan(1);
        for (const f of rec.frames) checkFrame(f);
        expect(rec.frames.some((f) => f.compare)).toBe(true);
        expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
        if (s.tail < tailBefore) wrapped = true;
        if (s.size === s.capacity) filled = true;
        rejected += rec.counters.rejected ?? 0;
        check(s);
      }
      if (p.value === def.params![0].default) {
        expect(def.tour.length).toBeGreaterThanOrEqual(4);
        expect(def.tour.length).toBeLessThanOrEqual(6);
        expect(wrapped).toBe(true);
        expect(filled).toBe(true);
        expect(rejected).toBe(1);
        // The key that was turned away gets in on the retry.
        expect(items(s)).toContain(50);
      }
    }
  });

  it('suggests keys the form accepts', () => {
    const s = def.create({ capacity: 8 });
    const op = def.ops.find((o) => o.id === 'enqueue')!;
    for (let i = 0; i < 50; i++) {
      const [k] = op.suggest!(s);
      expect(Number.isInteger(k)).toBe(true);
      expect(k as number).toBeGreaterThanOrEqual(0);
      expect(k as number).toBeLessThanOrEqual(999);
    }
  });
});
