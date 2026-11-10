import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { CAPACITY, create, insert, keys, layout, peek, popMin, type PQState } from './index';

const quiet = (s: PQState) => new Recorder(s, layout, false);
const loud = (s: PQState) => new Recorder(s, layout, true);

/** Throws if the array is not sorted largest first, holds a key twice, or disagrees with size. */
function check(s: PQState): void {
  expect(s.size).toBeGreaterThanOrEqual(0);
  expect(s.size).toBeLessThanOrEqual(s.slots.length);
  for (let i = 0; i < s.slots.length; i++) {
    if (i < s.size) expect(typeof s.slots[i]).toBe('number');
    else expect(s.slots[i]).toBeNull();
  }
  // Strictly descending: sorted, and no key twice.
  for (let i = 1; i < s.size; i++) expect(s.slots[i - 1] as number).toBeGreaterThan(s.slots[i] as number);
  expect(s.window).toBeNull();
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
    // Every slot of the array is drawn in every frame, each one once.
    const subs = f.scene.nodes.filter((n) => n.cells[0].sub !== undefined).map((n) => Number(n.cells[0].sub));
    expect(subs.sort((a, b) => a - b)).toEqual(Array.from({ length: subs.length }, (_, i) => i));
    // Magenta is only ever on the slot that holds the followed key.
    for (const n of f.scene.nodes) if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
    // The scene keeps the same pinned corners throughout.
    expect(f.scene.decor!.filter((d) => d.id.startsWith('corner'))).toEqual(frames[0].scene.decor!.filter((d) => d.id.startsWith('corner')));
  }
}

describe('priority queue on a sorted array', () => {
  for (const capacity of [CAPACITY, 400]) {
    it(`matches a sorted set through random inserts and takes (capacity ${capacity})`, () => {
      const rnd = makeRng(capacity * 31 + 7);
      const s = create(capacity);
      const model: number[] = []; // ascending, so model[0] is the most urgent
      let duplicates = 0;
      let refused = 0;
      for (let i = 0; i < 6000; i++) {
        // Lean towards inserts for a while, then towards takes, so the array both fills and drains.
        const lean = Math.floor(i / 300) % 2 === 0 ? 0.7 : 0.3;
        const roll = rnd();
        if (roll < lean) {
          const key = Math.floor(rnd() * (capacity === CAPACITY ? 40 : 1000));
          const rec = quiet(s);
          const n = model.length;
          const full = n === capacity;
          const present = model.includes(key);
          expect(insert(s, key, rec)).toBe(!full && !present);
          const comparisons = rec.counters.comparisons ?? 0;
          if (full) {
            refused++;
            expect(rec.counters).toEqual({});
          } else {
            // Binary search: never more than floor(log2 n) + 1 comparisons.
            expect(comparisons).toBeLessThanOrEqual(n === 0 ? 0 : Math.floor(Math.log2(n)) + 1);
            if (present) {
              duplicates++;
              expect(rec.counters.writes ?? 0).toBe(0);
            } else {
              // One shift for every smaller key, plus the write that places the new one.
              const smaller = model.filter((k) => k < key).length;
              expect(rec.counters.writes).toBe(smaller + 1);
              model.push(key);
              model.sort((a, b) => a - b);
            }
          }
        } else if (roll < 0.95) {
          const rec = quiet(s);
          const want = model.length ? model.shift()! : null;
          expect(popMin(s, rec)).toBe(want);
          expect(rec.counters).toEqual(want === null ? {} : { writes: 1 });
        } else {
          const rec = quiet(s);
          expect(peek(s, rec)).toBe(model.length ? model[0] : null);
          expect(rec.counters).toEqual({});
        }
        expect(s.size).toBe(model.length);
        if (i % 20 === 0) {
          check(s);
          expect(keys(s)).toEqual([...model].reverse());
        }
      }
      check(s);
      expect(keys(s)).toEqual([...model].reverse());
      expect(duplicates).toBeGreaterThan(20);
      if (capacity === CAPACITY) expect(refused).toBeGreaterThan(20);
      // Draining the queue returns every key, smallest first.
      const out: number[] = [];
      while (s.size) out.push(popMin(s, quiet(s))!);
      expect(out).toEqual(model);
      expect(popMin(s, quiet(s))).toBeNull();
      expect(peek(s, quiet(s))).toBeNull();
    });
  }

  it('sorts whatever order the keys arrive in', () => {
    const s = create();
    for (const k of [41, 9, 67, 30, 84, 18, 52]) expect(insert(s, k, quiet(s))).toBe(true);
    expect(keys(s)).toEqual([84, 67, 52, 41, 30, 18, 9]);
    check(s);
  });

  it('shows every comparison of the binary search and one frame per shift', () => {
    const s = create();
    for (const k of [41, 9, 67, 30, 84, 18, 52]) insert(s, k, quiet(s));
    const rec = loud(s);
    expect(insert(s, 35, rec)).toBe(true);
    expect(keys(s)).toEqual([84, 67, 52, 41, 35, 30, 18, 9]);
    expect(rec.counters).toEqual({ comparisons: 3, writes: 4 });
    checkFrames(rec.frames);
    const compares = rec.frames.filter((f) => f.compare);
    expect(compares.map((f) => [f.compare!.left, f.compare!.op, f.compare!.right])).toEqual([
      [35, '<', 41],
      [35, '>', 18],
      [35, '>', 30],
    ]);
    // The chip sits on the key being compared, and that key is marked.
    for (const f of compares) {
      const node = f.scene.nodes.find((n) => n.id === f.probe!.at)!;
      expect(node.cells[0].text).toBe(String(f.compare!.right));
      expect(node.tone).toBe('compare');
      expect(f.lines).toContain('mid');
    }
    // The frame that says a half is ruled out already shows it: dimmed, the tag moved, and the test and its branch lit.
    const first = compares[0].scene;
    for (const k of [84, 67, 52]) expect(first.nodes.find((n) => n.id === `k${k}`)!.tone).toBe('dim');
    expect(first.nodes.find((n) => n.id === 'lo')!.x).toBe(first.nodes.find((n) => n.id === 'k30')!.x);
    expect(compares[0].lines).toEqual(expect.arrayContaining(['less', 'right']));
    expect(compares[1].lines).toEqual(expect.arrayContaining(['more', 'left']));
    expect(compares[1].scene.nodes.find((n) => n.id === 'hi')!.x).toBe(compares[1].scene.nodes.find((n) => n.id === 'k18')!.x);
    // After the first comparison the left half is ruled out and drawn dim, and lo has moved past it.
    const second = compares[1].scene;
    for (const k of [84, 67, 52, 41]) expect(second.nodes.find((n) => n.id === `k${k}`)!.tone).toBe('dim');
    expect(second.nodes.find((n) => n.id === 'lo')!.x).toBe(second.nodes.find((n) => n.id === 'k30')!.x);
    // lo and hi end on the same slot without touching each other.
    const meet = rec.frames.find((f) => f.lines?.includes('meet'))!.scene;
    const lo = meet.nodes.find((n) => n.id === 'lo')!;
    const hi = meet.nodes.find((n) => n.id === 'hi')!;
    expect(lo.x).toBe(hi.x);
    expect(Math.abs(lo.y - hi.y)).toBeGreaterThanOrEqual(nodeSize(lo).h);
    // Three smaller keys move one slot each, from the end backwards.
    const shifts = rec.frames.filter((f) => f.lines?.includes('shift'));
    expect(shifts.length).toBe(3);
    expect(shifts.map((f) => f.message.match(/ove (\d+) from/)![1])).toEqual(['9', '18', '30']);
    // The followed key is the chip in every frame.
    for (const f of rec.frames) expect(f.probe?.text).toBe('35');
    expect(rec.frames[rec.frames.length - 1].probe!.at).toBe('k35');
  });

  it('inserts a new most urgent key at the end without shifting, and a new largest key by shifting everything', () => {
    const s = create();
    for (const k of [40, 30, 20, 10]) insert(s, k, quiet(s));
    const small = loud(s);
    expect(insert(s, 5, small)).toBe(true);
    expect(small.counters.writes).toBe(1);
    expect(small.frames.some((f) => f.lines?.includes('shift'))).toBe(false);
    expect(small.frames[small.frames.length - 1].message).toMatch(/new most urgent/);
    const large = loud(s);
    expect(insert(s, 99, large)).toBe(true);
    expect(large.counters.writes).toBe(6);
    expect(large.frames[large.frames.length - 1].message).toMatch(/worst case/);
    expect(keys(s)).toEqual([99, 40, 30, 20, 10, 5]);
    checkFrames([...small.frames, ...large.frames]);
  });

  it('treats a key that is already queued as a no-op and says so', () => {
    const s = create();
    for (const k of [40, 30, 20, 10]) insert(s, k, quiet(s));
    const before = keys(s);
    const rec = loud(s);
    expect(insert(s, 30, rec)).toBe(false);
    expect(keys(s)).toEqual(before);
    expect(rec.counters.writes ?? 0).toBe(0);
    expect(rec.frames.some((f) => f.compare?.op === '=')).toBe(true);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/already queued/);
    checkFrames(rec.frames);
    check(s);
  });

  it('refuses an insert when full, politely and without changing anything', () => {
    const s = create();
    for (let k = 0; k < CAPACITY; k++) expect(insert(s, k * 3, quiet(s))).toBe(true);
    const before = keys(s);
    const rec = loud(s);
    expect(insert(s, 1, rec)).toBe(false);
    expect(keys(s)).toEqual(before);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toMatch(/Sorry/);
    expect(rec.counters).toEqual({});
    checkFrames(rec.frames);
    check(s);
  });

  it('takes the smallest key from the end with one write and no comparisons', () => {
    const s = create();
    for (const k of [41, 9, 67, 30]) insert(s, k, quiet(s));
    const look = loud(s);
    expect(peek(s, look)).toBe(9);
    expect(look.frames.length).toBe(1);
    expect(look.frames[0].probe).toEqual({ text: '9', at: 'k9' });
    const take = loud(s);
    expect(popMin(s, take)).toBe(9);
    expect(take.counters).toEqual({ writes: 1 });
    expect(keys(s)).toEqual([67, 41, 30]);
    checkFrames([...look.frames, ...take.frames]);
    // No other key moved.
    const first = take.frames[0].scene;
    const last = take.frames[take.frames.length - 1].scene;
    for (const k of [67, 41, 30]) expect(last.nodes.find((n) => n.id === `k${k}`)!.x).toBe(first.nodes.find((n) => n.id === `k${k}`)!.x);
    expect(last.nodes.find((n) => n.caption === 'most\nurgent')!.cells[0].text).toBe('30');
    const empty = create();
    for (const run of [popMin, peek]) {
      const rec = loud(empty);
      expect(run(empty, rec)).toBeNull();
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(/empty/);
      checkFrames(rec.frames);
    }
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    for (let i = 0; i < 800; i++) {
      const on = loud(a);
      const off = quiet(b);
      const lean = Math.floor(i / 50) % 2 === 0 ? 0.65 : 0.3;
      const roll = rnd();
      if (roll < lean) {
        const key = Math.floor(rnd() * 60);
        expect(insert(a, key, on)).toBe(insert(b, key, off));
      } else if (roll < 0.9) {
        expect(popMin(a, on)).toBe(popMin(b, off));
      } else {
        expect(peek(a, on)).toBe(peek(b, off));
      }
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(a).toEqual(b);
      check(a);
    }
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
    expect(keys(s)).toEqual([84, 67, 52, 41, 30, 18, 9]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const costs: Record<string, number>[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      check(s);
      costs.push(rec.counters);
    }
    // Peek is free, the middle insert shifts three keys, the new most urgent key shifts none, and each take is one write.
    expect(costs).toEqual([{}, { comparisons: 3, writes: 4 }, { comparisons: 3, writes: 1 }, { writes: 1 }, { writes: 1 }]);
    expect(keys(s)).toEqual([84, 67, 52, 41, 35, 30, 18]);
    expect(def.status!(s)).toEqual([
      { label: 'Size', value: '7 of 12' },
      { label: 'Most urgent', value: '18' },
    ]);
  });

  it('suggests keys the form accepts, and fill never overfills the page', () => {
    const s = def.create({});
    const op = def.ops.find((o) => o.id === 'insert')!;
    for (let i = 0; i < 40; i++) {
      const [k] = op.suggest!(s);
      expect(Number.isInteger(k)).toBe(true);
      expect(k as number).toBeGreaterThanOrEqual(0);
      expect(k as number).toBeLessThanOrEqual(999);
      expect(keys(s)).not.toContain(k);
      const [id, ...args] = def.fill!(s);
      def.ops.find((o) => o.id === id)!.run(s, args, new Recorder(s, def.layout, false));
      check(s);
    }
    expect(s.size).toBe(CAPACITY);
  });
});
