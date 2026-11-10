import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { MAX_SIZE, PLACES, create, dequeue, enqueue, layout, peek, toArray, type FifoState, type QNode } from './index';

const quiet = (s: FifoState) => new Recorder(s, layout, false);
const loud = (s: FifoState) => new Recorder(s, layout, true);

/** The node (or the null marker) a pointer tag points at: the one it sits under, or over when that node has dropped out of the row. */
function pointsAt(scene: Scene, name: 'head' | 'tail'): string {
  const tag = scene.nodes.find((n) => n.shape === 'tag' && n.cells[0].text === name)!;
  const near = scene.nodes.filter((n) => n.shape !== 'tag' && Math.abs(n.x - tag.x) < nodeSize(n).w);
  near.sort((a, b) => Math.abs(a.y - tag.y) - Math.abs(b.y - tag.y));
  return near[0].id;
}

/** Throws if head, tail, size and the chain of next pointers disagree. */
function check(s: FifoState): void {
  let count = 0;
  let last: QNode | null = null;
  for (let n = s.head; n; n = n.next) {
    // Each node sits one place after the node in front of it, for good.
    if (last) expect(n.pos).toBe(last.pos + 1);
    count++;
    last = n;
  }
  expect(count).toBe(s.size);
  expect(s.tail).toBe(last);
  // Empty means both pointers are null, never just one.
  expect(s.head === null).toBe(s.tail === null);
  if (s.tail) {
    expect(s.tail.next).toBeNull();
    expect(s.nextPos).toBe(s.tail.pos + 1);
  }
  expect(s.size).toBeLessThanOrEqual(s.maxSize);
  expect(s.draft).toBeNull();
  expect(s.ghost).toBeNull();
}

/** With the page's limit, every node and the null marker stay inside the fixed places on the canvas. */
function checkOnCanvas(s: FifoState): void {
  if (s.head) expect(s.head.pos - s.origin).toBeGreaterThanOrEqual(0);
  expect(s.nextPos - s.origin).toBeGreaterThanOrEqual(0);
  expect(s.nextPos - s.origin).toBeLessThanOrEqual(PLACES - 1);
}

function corners(scene: Scene): { x1: number; x2: number; y1: number; y2: number } {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, edges that join nodes, a probe that points at a node, a code line, nothing overlapping or off the scene. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    expect(new Set(f.scene.edges.map((e) => e.id)).size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to), `edge ${e.id}`).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|\u2014/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      expect(a.x1, `${a.id} left`).toBeGreaterThanOrEqual(edge.x1 - 0.5);
      expect(a.x2, `${a.id} right`).toBeLessThanOrEqual(edge.x2 + 0.5);
      expect(a.y2, `${a.id} bottom`).toBeLessThanOrEqual(edge.y2 + 0.5);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        const overlap = a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
    // Magenta is only ever on the node that holds the followed key.
    for (const n of f.scene.nodes) if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
  }
}

/** Where each queue node is drawn, by id. */
function positions(scene: Scene): Map<string, number> {
  return new Map(scene.nodes.filter((n) => /^n\d+$/.test(n.id)).map((n) => [n.id, n.x]));
}

describe('queue on a linked list', () => {
  it('matches a plain array through random enqueues, dequeues and peeks', () => {
    const rnd = makeRng(20261110);
    const s = create(1_000_000);
    const model: number[] = [];
    let emptied = 0;
    let longest = 0;
    for (let i = 0; i < 6000; i++) {
      // Lean towards enqueues for a while, then towards dequeues, so the queue grows long and also runs dry.
      const lean = Math.floor(i / 300) % 2 === 0 ? 0.65 : 0.25;
      const roll = rnd();
      if (roll < lean) {
        const key = Math.floor(rnd() * 1000);
        const rec = quiet(s);
        expect(enqueue(s, key, rec)).toBe(true);
        model.push(key);
        // Two pointer writes and no reads, whatever the length.
        expect(rec.counters).toEqual({ writes: 2 });
      } else if (roll < 0.95) {
        const rec = quiet(s);
        const want = model.length ? model.shift()! : null;
        expect(dequeue(s, rec)).toBe(want);
        if (want === null) expect(rec.counters).toEqual({});
        else if (model.length === 0) {
          // The last item out: tail is cleared too.
          expect(rec.counters).toEqual({ reads: 1, writes: 2 });
          emptied++;
        } else expect(rec.counters).toEqual({ reads: 1, writes: 1 });
      } else {
        const rec = quiet(s);
        expect(peek(s, rec)).toBe(model.length ? model[0] : null);
        expect(rec.counters).toEqual(model.length ? { reads: 1 } : {});
      }
      longest = Math.max(longest, model.length);
      expect(s.size).toBe(model.length);
      expect(s.head?.key).toBe(model[0]);
      expect(s.tail?.key).toBe(model[model.length - 1]);
      if (i % 20 === 0) {
        check(s);
        expect(toArray(s)).toEqual(model);
      }
    }
    check(s);
    expect(toArray(s)).toEqual(model);
    expect(emptied).toBeGreaterThan(5);
    expect(longest).toBeGreaterThan(50);
    // First in, first out all the way down.
    while (model.length) expect(dequeue(s, quiet(s))).toBe(model.shift()!);
    expect(dequeue(s, quiet(s))).toBeNull();
    expect(peek(s, quiet(s))).toBeNull();
    check(s);
  });

  it('clears tail when the last item leaves, so the next enqueue starts a fresh list', () => {
    const s = create();
    enqueue(s, 5, quiet(s));
    const rec = loud(s);
    expect(dequeue(s, rec)).toBe(5);
    expect(s.head).toBeNull();
    expect(s.tail).toBeNull();
    expect(rec.counters).toEqual({ reads: 1, writes: 2 });
    expect(rec.frames.some((f) => f.lines?.includes('clear_tail'))).toBe(true);
    checkFrames(rec.frames);
    enqueue(s, 6, quiet(s));
    enqueue(s, 7, quiet(s));
    check(s);
    expect(toArray(s)).toEqual([6, 7]);
    expect(dequeue(s, quiet(s))).toBe(6);
  });

  it('keeps every other node exactly where it was through a dequeue and an enqueue', () => {
    const s = create();
    for (const k of [1, 2, 3, 4]) enqueue(s, k, quiet(s));
    const before = positions(layout(s));
    const take = loud(s);
    dequeue(s, take);
    const put = loud(s);
    enqueue(s, 5, put);
    checkFrames([...take.frames, ...put.frames]);
    for (const f of [...take.frames, ...put.frames]) {
      for (const [id, x] of positions(f.scene)) if (before.has(id)) expect(x, `${id} moved`).toBe(before.get(id));
      // The corners are pinned, so the view never re-centres either.
      expect(corners(f.scene)).toEqual(corners(take.frames[0].scene));
    }
  });

  it('stays on the canvas however long it runs, and says so when the drawing slides back', () => {
    const rnd = makeRng(77);
    const s = create();
    let slides = 0;
    for (let i = 0; i < 1500; i++) {
      const lean = Math.floor(i / 40) % 2 === 0 ? 0.6 : 0.4;
      const rec = loud(s);
      const originBefore = s.origin;
      if (rnd() < lean) {
        const full = s.size === MAX_SIZE;
        const before = positions(layout(s));
        expect(enqueue(s, Math.floor(rnd() * 1000), rec)).toBe(!full);
        if (s.origin !== originBefore) {
          slides++;
          expect(rec.frames[0].message).toMatch(/Only the picture moved/);
          // Every node slides by the same amount: the drawing moved, not the items.
          const after = positions(rec.frames[0].scene);
          const shifts = new Set([...before].map(([id, x]) => x - after.get(id)!));
          expect(shifts.size).toBeLessThanOrEqual(1);
        } else {
          expect(rec.frames[0].message).not.toMatch(/picture/);
        }
      } else {
        dequeue(s, rec);
        expect(s.origin).toBe(originBefore);
      }
      checkFrames(rec.frames);
      check(s);
      checkOnCanvas(s);
    }
    expect(slides).toBeGreaterThan(20);
  });

  it('stops politely at the page limit and changes nothing', () => {
    const s = create();
    for (let k = 0; k < MAX_SIZE; k++) expect(enqueue(s, k, quiet(s))).toBe(true);
    const before = toArray(s);
    const rec = loud(s);
    expect(enqueue(s, 99, rec)).toBe(false);
    expect(toArray(s)).toEqual(before);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toMatch(/Sorry/);
    expect(rec.counters).toEqual({});
    checkFrames(rec.frames);
    check(s);
    checkOnCanvas(s);
  });

  it('narrates an empty queue without changing anything', () => {
    const s = create();
    for (const run of [dequeue, peek]) {
      const rec = loud(s);
      expect(run(s, rec)).toBeNull();
      expect(rec.counters).toEqual({});
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(/empty/);
      checkFrames(rec.frames);
      check(s);
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    for (let i = 0; i < 800; i++) {
      const on = loud(a);
      const off = quiet(b);
      const lean = Math.floor(i / 50) % 2 === 0 ? 0.6 : 0.3;
      const roll = rnd();
      if (roll < lean) {
        const key = Math.floor(rnd() * 1000);
        expect(enqueue(a, key, on)).toBe(enqueue(b, key, off));
      } else if (roll < 0.9) {
        expect(dequeue(a, on)).toBe(dequeue(b, off));
      } else {
        expect(peek(a, on)).toBe(peek(b, off));
      }
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(toArray(a)).toEqual(toArray(b));
      expect(a.origin).toBe(b.origin);
      check(a);
      check(b);
    }
  });

  it('follows the key with the probe from the new node to the back, and from the front out', () => {
    const s = create();
    for (const k of [17, 62, 41]) enqueue(s, k, quiet(s));
    const put = loud(s);
    enqueue(s, 35, put);
    expect(put.frames.length).toBe(4);
    const id = `n${s.tail!.id}`;
    for (const f of put.frames) expect(f.probe).toEqual({ text: '35', at: id });
    // The node waits below the row until tail points at it.
    const y = put.frames.map((f) => f.scene.nodes.find((n) => n.id === id)!.y);
    expect(y[0]).toBeGreaterThan(0);
    expect(y[1]).toBeGreaterThan(0);
    expect(y[2]).toBe(0);
    expect(pointsAt(put.frames[3].scene, 'tail')).toBe(id);

    const take = loud(s);
    expect(dequeue(s, take)).toBe(17);
    expect(take.frames[0].probe?.text).toBe('17');
    expect(pointsAt(take.frames[0].scene, 'head')).toBe(take.frames[0].probe!.at);
    // Once head has moved on, the old front drops out of the row and the next node carries the head label.
    const gone = take.frames[1].scene.nodes.find((n) => n.id === take.frames[1].probe!.at)!;
    expect(gone.caption).toBe('unlinked');
    expect(gone.y).toBeGreaterThan(0);
    expect(take.frames[1].scene.nodes.find((n) => n.id === pointsAt(take.frames[1].scene, 'head'))!.cells[0].text).toBe('62');
    expect(take.frames[take.frames.length - 1].scene.nodes.some((n) => n.cells[0].text === '17')).toBe(false);
  });

  it('seed and tour run cleanly through the definition', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(toArray(s)).toEqual([17, 62, 41, 88]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const origin = s.origin;
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      check(s);
      checkOnCanvas(s);
    }
    // The tour never needs the drawing to slide.
    expect(s.origin).toBe(origin);
    expect(toArray(s)).toEqual([41, 88, 35, 70]);
    expect(def.status!(s)).toEqual([
      { label: 'Size', value: '4' },
      { label: 'Front', value: '41' },
      { label: 'Back', value: '70' },
    ]);
  });

  it('suggests keys the form accepts, and fill never overfills the page', () => {
    const s = def.create({});
    const op = def.ops.find((o) => o.id === 'enqueue')!;
    for (let i = 0; i < 40; i++) {
      const [k] = op.suggest!(s);
      expect(Number.isInteger(k)).toBe(true);
      expect(k as number).toBeGreaterThanOrEqual(0);
      expect(k as number).toBeLessThanOrEqual(999);
      const [id, ...args] = def.fill!(s);
      def.ops.find((o) => o.id === id)!.run(s, args, new Recorder(s, def.layout, false));
      check(s);
      checkOnCanvas(s);
    }
    expect(s.size).toBe(MAX_SIZE);
  });
});
