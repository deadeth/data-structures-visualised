import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { MAX_CAPACITY, START_CAPACITY, create, items, layout, peek, pop, push, type StackState } from './index';

const quiet = (s: StackState) => new Recorder(s, layout, false);
const loud = (s: StackState) => new Recorder(s, layout, true);

/** Throws if the array and the size counter disagree. */
function check(s: StackState): void {
  const capacity = s.slots.length;
  // The capacity is the starting size doubled some whole number of times.
  expect(Number.isInteger(Math.log2(capacity / START_CAPACITY))).toBe(true);
  expect(capacity).toBeLessThanOrEqual(s.maxCapacity);
  expect(s.size).toBeGreaterThanOrEqual(0);
  expect(s.size).toBeLessThanOrEqual(capacity);
  for (let i = 0; i < capacity; i++) {
    if (i < s.size) expect(typeof s.slots[i]).toBe('number');
    else expect(s.slots[i]).toBeNull();
  }
  expect(s.next).toBeNull();
}

/** Unique ids, a probe that points at a node, a sentence, a code line, and no two boxes on top of each other. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|\u2014/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
    // Magenta is only ever on the slot that holds the followed key.
    for (const n of f.scene.nodes) if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
  }
}

describe('stack', () => {
  it('matches a plain array through random pushes, pops and peeks', () => {
    const rnd = makeRng(20261110);
    const s = create(1 << 20);
    const model: number[] = [];
    let capacity = START_CAPACITY;
    let pushes = 0;
    let copies = 0;
    let growths = 0;
    for (let i = 0; i < 6000; i++) {
      // Lean towards pushes for a while, then towards pops, so the stack grows tall and also empties.
      const lean = Math.floor(i / 500) % 2 === 0 ? 0.7 : 0.25;
      const roll = rnd();
      if (roll < lean) {
        const key = Math.floor(rnd() * 1000);
        const full = model.length === capacity;
        const rec = quiet(s);
        expect(push(s, key, rec)).toBe(true);
        model.push(key);
        pushes++;
        if (full) {
          // A full array doubles, copying every item once.
          expect(rec.counters).toEqual({ comparisons: 1, copies: capacity, writes: capacity + 1 });
          copies += capacity;
          capacity *= 2;
          growths++;
        } else {
          expect(rec.counters).toEqual({ comparisons: 1, writes: 1 });
        }
      } else if (roll < 0.95) {
        const rec = quiet(s);
        const want = model.length ? model.pop()! : null;
        expect(pop(s, rec)).toBe(want);
        expect(rec.counters).toEqual(want === null ? { comparisons: 1 } : { comparisons: 1, writes: 1 });
      } else {
        const rec = quiet(s);
        expect(peek(s, rec)).toBe(model.length ? model[model.length - 1] : null);
        expect(rec.counters).toEqual({ comparisons: 1 });
      }
      expect(s.size).toBe(model.length);
      expect(s.slots.length).toBe(capacity);
      if (i % 20 === 0) {
        check(s);
        expect(items(s)).toEqual(model);
      }
    }
    check(s);
    expect(items(s)).toEqual(model);
    expect(growths).toBeGreaterThan(5);
    // The amortised bound: all the copying so far comes to less than two writes per push.
    expect(copies).toBeLessThan(2 * pushes);
    // Last in, first out all the way down.
    while (model.length) expect(pop(s, quiet(s))).toBe(model.pop()!);
    expect(pop(s, quiet(s))).toBeNull();
    expect(peek(s, quiet(s))).toBeNull();
    check(s);
  });

  it('keeps the total cost of n pushes under 3n writes', () => {
    const s = create(1 << 20);
    let writes = 0;
    for (let n = 1; n <= 5000; n++) {
      const rec = quiet(s);
      push(s, n % 1000, rec);
      writes += rec.counters.writes;
      expect(writes).toBeLessThan(3 * n);
    }
    expect(s.slots.length).toBe(8192);
  });

  it('doubles from 4 to 8 on the fifth push and copies four items', () => {
    const s = create();
    for (const k of [1, 2, 3, 4]) push(s, k, quiet(s));
    expect(s.slots.length).toBe(4);
    const rec = loud(s);
    expect(push(s, 5, rec)).toBe(true);
    expect(s.slots).toEqual([1, 2, 3, 4, 5, null, null, null]);
    expect(rec.counters).toEqual({ comparisons: 1, copies: 4, writes: 5 });
    checkFrames(rec.frames);
    // One frame for each copy, each showing both arrays.
    const copying = rec.frames.filter((f) => f.lines?.includes('copy'));
    expect(copying.length).toBe(4);
    for (const f of copying) expect(f.scene.nodes.filter((n) => /^a\d+s\d+$/.test(n.id)).length).toBe(12);
    // The new array keeps its ids when it takes the old one's place, so it slides up.
    const during = copying[3].scene.nodes.find((n) => n.id === 'a1s0')!;
    const after = rec.frames[rec.frames.length - 1].scene.nodes.find((n) => n.id === 'a1s0')!;
    expect(during.y).toBeGreaterThan(after.y);
    expect(after.y).toBe(0);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/5 writes: 4 copies/);
  });

  it('allows the same value twice, because a stack is a sequence', () => {
    const s = create();
    for (const k of [7, 7, 7]) expect(push(s, k, quiet(s))).toBe(true);
    expect(items(s)).toEqual([7, 7, 7]);
  });

  it('narrates a pop or peek on an empty stack without changing anything', () => {
    const s = create();
    for (const run of [pop, peek]) {
      const rec = loud(s);
      expect(run(s, rec)).toBeNull();
      expect(rec.counters).toEqual({ comparisons: 1 });
      expect(rec.frames.length).toBe(2);
      expect(rec.frames[0].compare).toMatchObject({ left: 'size 0', op: '=', right: 0 });
      expect(rec.frames[1].message).toMatch(/empty/);
      checkFrames(rec.frames);
      check(s);
    }
  });

  it('stops politely at the page limit and changes nothing', () => {
    const s = create();
    for (let k = 0; k < MAX_CAPACITY; k++) expect(push(s, k, quiet(s))).toBe(true);
    expect(s.slots.length).toBe(MAX_CAPACITY);
    const before = JSON.stringify(s);
    const rec = loud(s);
    expect(push(s, 99, rec)).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    expect(rec.counters).toEqual({ comparisons: 1 });
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/Sorry/);
    checkFrames(rec.frames);
    const off = quiet(s);
    expect(push(s, 99, off)).toBe(false);
    expect(off.counters).toEqual(rec.counters);
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    for (let i = 0; i < 800; i++) {
      const on = loud(a);
      const off = quiet(b);
      const lean = Math.floor(i / 60) % 2 === 0 ? 0.65 : 0.25;
      const roll = rnd();
      if (roll < lean) {
        const key = Math.floor(rnd() * 1000);
        expect(push(a, key, on)).toBe(push(b, key, off));
      } else if (roll < 0.9) {
        expect(pop(a, on)).toBe(pop(b, off));
      } else {
        expect(peek(a, on)).toBe(peek(b, off));
      }
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(1);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(a).toEqual(b);
      check(a);
    }
  });

  it('follows the key with the probe and shows the check as a comparison', () => {
    const s = create();
    for (const k of [17, 42, 8]) push(s, k, quiet(s));
    const put = loud(s);
    push(s, 63, put);
    expect(put.frames[0].compare).toEqual({ left: 'size 3', op: '<', right: 'capacity 4', verdict: expect.any(String) });
    expect(put.frames[0].probe).toEqual({ text: '63', at: 'size' });
    expect(put.frames[1].probe).toEqual({ text: '63', at: 'a0s3' });
    expect(put.frames[1].scene.nodes.find((n) => n.id === 'a0s3')!.tone).toBe('key');
    // The top tag sits under the top slot.
    const last = put.frames[put.frames.length - 1].scene;
    expect(last.nodes.find((n) => n.id === 'top')!.x).toBe(last.nodes.find((n) => n.id === 'a0s3')!.x);

    const take = loud(s);
    expect(pop(s, take)).toBe(63);
    expect(take.frames[0].compare).toMatchObject({ left: 'size 4', op: '>', right: 0 });
    for (const f of take.frames.slice(0, -1)) expect(f.probe).toEqual({ text: '63', at: 'a0s3' });

    const look = loud(s);
    expect(peek(s, look)).toBe(8);
    expect(look.frames.length).toBe(2);
    expect(look.frames[1].probe).toEqual({ text: '8', at: 'a0s2' });
    expect(items(s)).toEqual([17, 42, 8]);
  });

  it('seed and tour run cleanly through the definition, and the tour shows a doubling', () => {
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(items(s)).toEqual([17, 42, 8]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    let copies = 0;
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(1);
      expect(rec.frames.some((f) => f.compare)).toBe(true);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      copies += rec.counters.copies ?? 0;
      check(s);
    }
    expect(copies).toBe(4);
    expect(s.slots.length).toBe(8);
    expect(items(s)).toEqual([17, 42, 8]);
    expect(def.status!(s)).toEqual([
      { label: 'Size', value: '3' },
      { label: 'Capacity', value: '8' },
      { label: 'Top', value: '8' },
    ]);
  });

  it('suggests keys the form accepts, and fill never breaks the stack', () => {
    const s = def.create({});
    const op = def.ops.find((o) => o.id === 'push')!;
    for (let i = 0; i < 40; i++) {
      const [k] = op.suggest!(s);
      expect(Number.isInteger(k)).toBe(true);
      expect(k as number).toBeGreaterThanOrEqual(0);
      expect(k as number).toBeLessThanOrEqual(999);
      const [id, ...args] = def.fill!(s);
      def.ops.find((o) => o.id === id)!.run(s, args, new Recorder(s, def.layout, false));
      check(s);
    }
    expect(s.size).toBe(MAX_CAPACITY);
  });
});
