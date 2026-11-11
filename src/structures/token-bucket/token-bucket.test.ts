import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  MAX_BURST,
  MAX_TICK,
  SHOWN,
  TICKS_SHOWN,
  available,
  burst,
  create,
  label,
  layout,
  request,
  reset,
  retryAfter,
  tick,
  timeline,
  type BucketState,
} from './index';

const quiet = (s: BucketState) => new Recorder(s, layout, false);
const loud = (s: BucketState) => new Recorder(s, layout, true);

/** The simplest correct limiter: top the bucket up on every single tick. The lazy one must agree with it. */
class Eager {
  tokens: number;
  constructor(readonly capacity: number, readonly rate: number) {
    this.tokens = capacity;
  }
  tick(k: number): void {
    for (let i = 0; i < k; i++) this.tokens = Math.min(this.capacity, this.tokens + this.rate);
  }
  take(cost: number): boolean {
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

function check(s: BucketState): void {
  expect(s.tokens).toBeGreaterThanOrEqual(0);
  expect(s.tokens).toBeLessThanOrEqual(s.capacity);
  expect(s.last).toBeLessThanOrEqual(s.now);
  expect(s.now).toBeLessThanOrEqual(MAX_TICK);
  expect(s.requests.length).toBeLessThanOrEqual(SHOWN);
  // Nothing is left waiting once an operation has finished.
  for (const r of s.requests) expect(r.outcome).not.toBe('waiting');
}

function corners(scene: Scene): { x1: number; x2: number; y1: number; y2: number } {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** The tick a pointer tag sits under. */
function pointsAt(scene: Scene, name: 'now' | 'last'): string {
  const tag = scene.nodes.find((n) => n.shape === 'tag' && n.cells[0].text === name)!;
  return scene.nodes.find((n) => /^t\d+$/.test(n.id) && n.x === tag.x)!.cells[0].text;
}

/** Unique ids, a probe that points at a real node and cell, a code line, nothing overlapping or off the scene. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
      expect(f.probe.text).toMatch(/^r\d+$/);
    }
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—|-\d/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.compare) expect(f.probe, 'a comparison follows a request').toBeDefined();
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    // Plain checks here: this loop runs millions of times across the random runs.
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        const overlap = a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
        if (overlap) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      // Pointers never take a tone.
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      // Magenta is only ever on the request being followed.
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    // The view never rescales.
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

describe('token bucket', () => {
  for (const [capacity, rate] of [[5, 1], [3, 1], [8, 1], [5, 2], [5, 3], [3, 3], [8, 2]] as const) {
    it(`lazy refill agrees with a bucket topped up every tick (capacity ${capacity}, rate ${rate})`, () => {
      const rnd = makeRng(capacity * 131 + rate);
      const s = create(capacity, rate);
      let model = new Eager(capacity, rate);
      let allowed = 0;
      let rejected = 0;
      let capped = 0;
      for (let i = 0; i < 5000; i++) {
        const roll = rnd();
        const rec = quiet(s);
        if (roll < 0.4) {
          const cost = 1 + Math.floor(rnd() * 9);
          const had = s.tokens;
          const elapsed = s.now - s.last;
          if (had + elapsed * rate > capacity) capped++;
          const want = model.take(cost);
          expect(request(s, cost, rec)).toBe(want);
          // One comparison against the capacity when time has passed, one against the cost.
          expect(rec.counters.comparisons).toBe(elapsed > 0 ? 2 : 1);
          expect(rec.counters.allowed ?? 0).toBe(want ? 1 : 0);
          expect(rec.counters.rejected ?? 0).toBe(want ? 0 : 1);
          if (want) allowed++;
          else {
            rejected++;
            // A rejection takes nothing, and Retry-After is the first tick at which it would pass.
            expect(s.tokens).toBe(model.tokens);
            const wait = retryAfter(s, cost);
            if (cost > capacity) expect(wait).toBeNull();
            else {
              expect(wait).toBeGreaterThanOrEqual(1);
              expect(s.tokens + wait! * rate).toBeGreaterThanOrEqual(cost);
              expect(s.tokens + (wait! - 1) * rate).toBeLessThan(cost);
            }
          }
          expect(s.last).toBe(s.now);
          expect(s.tokens).toBe(model.tokens);
        } else if (roll < 0.75) {
          const k = 1 + Math.floor(rnd() * 9);
          const stored = s.tokens;
          const last = s.last;
          if (s.now + k > MAX_TICK) {
            expect(tick(s, k, rec)).toBe(false);
            reset(s, quiet(s));
            model = new Eager(capacity, rate);
          } else {
            expect(tick(s, k, rec)).toBe(true);
            model.tick(k);
            // Time passing changes nothing in the bucket.
            expect(s.tokens).toBe(stored);
            expect(s.last).toBe(last);
            expect(rec.counters).toEqual({});
          }
        } else if (roll < 0.97) {
          const n = 2 + Math.floor(rnd() * (MAX_BURST - 1));
          const could = available(s);
          expect(could).toBe(model.tokens);
          const got = burst(s, n, rec);
          // A burst is paid for only with what is already there.
          expect(got).toBe(Math.min(n, could));
          for (let j = 0; j < got; j++) model.take(1);
          expect(rec.counters.allowed ?? 0).toBe(got);
          expect(rec.counters.rejected ?? 0).toBe(n - got);
          expect(s.tokens).toBe(model.tokens);
          allowed += got;
          rejected += n - got;
        } else {
          reset(s, rec);
          model = new Eager(capacity, rate);
          expect(s).toEqual(create(capacity, rate));
          allowed = 0;
          rejected = 0;
        }
        expect(available(s)).toBe(model.tokens);
        expect(s.allowed).toBe(allowed);
        expect(s.rejected).toBe(rejected);
        check(s);
      }
      expect(capped).toBeGreaterThan(50);
    });
  }

  it('never lets more than capacity + rate × T through in any stretch of T ticks', () => {
    const rnd = makeRng(99);
    for (const [capacity, rate] of [[5, 1], [3, 2], [8, 3]] as const) {
      const s = create(capacity, rate);
      const passedAt: number[] = [];
      for (let i = 0; i < 400 && s.now < MAX_TICK - 3; i++) {
        if (rnd() < 0.5) tick(s, 1 + Math.floor(rnd() * 3), quiet(s));
        const got = burst(s, MAX_BURST, quiet(s));
        for (let j = 0; j < got; j++) passedAt.push(s.now);
      }
      for (let a = 0; a < passedAt.length; a += 7) {
        for (const span of [0, 1, 5, 20]) {
          const inWindow = passedAt.filter((t) => t >= passedAt[a] && t <= passedAt[a] + span).length;
          expect(inWindow).toBeLessThanOrEqual(capacity + rate * span);
        }
      }
    }
  });

  it('shows the lazy arithmetic as the comparisons: against the capacity, then against the cost', () => {
    const s = create(5, 1);
    tick(s, 3, quiet(s));
    const rec = loud(s);
    expect(request(s, 1, rec)).toBe(true);
    checkFrames(rec.frames);
    const compares = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(compares).toEqual([
      { left: 'tokens 5 + 3 = 8', op: '>', right: 'capacity 5', verdict: 'keep 5, spill 3' },
      { left: 'tokens 5', op: '≥', right: 'cost 1', verdict: 'allow, take 1' },
    ]);
    expect(rec.frames.some((f) => f.message.includes('elapsed = now − last = 3 − 0 = 3 ticks. earned = 3 × 1 = 3 tokens.'))).toBe(true);
    expect(rec.frames.map((f) => f.lines)).toEqual([['arrive'], ['refill', 'elapsed', 'earned'], ['cap'], ['cap', 'stamp'], ['test'], ['take']]);
    // The request is magenta while it is being decided, and green once it is through.
    const node = (f: Frame) => f.scene.nodes.find((n) => n.id === 'r1')!;
    expect(node(rec.frames[0]).tone).toBe('key');
    expect(node(rec.frames[rec.frames.length - 1]).tone).toBe('ok');
    // The slot the token left is an empty slot again: spending on an allowed request is not drawn as a failure.
    const bucket = rec.frames[rec.frames.length - 1].scene.nodes.find((n) => n.id === 'bucket')!;
    expect(bucket.cells.map((c) => c.text)).toEqual(['●', '●', '●', '●', '']);
    expect(bucket.cells[4].tone).not.toBe('bad');
    expect(s).toMatchObject({ tokens: 4, last: 3, now: 3 });
  });

  it('a request in the same tick as the last refill earns nothing and makes one comparison', () => {
    const s = create(5, 1);
    const rec = loud(s);
    expect(request(s, 2, rec)).toBe(true);
    checkFrames(rec.frames);
    expect(rec.counters).toEqual({ comparisons: 1, allowed: 1 });
    expect(rec.frames.map((f) => f.lines)).toEqual([['arrive'], ['refill', 'elapsed', 'no_time'], ['test'], ['take']]);
    expect(s.tokens).toBe(3);
  });

  it('a rejection takes nothing, queues nothing and says how long to wait', () => {
    const s = create(5, 1);
    burst(s, 5, quiet(s));
    const rec = loud(s);
    expect(request(s, 2, rec)).toBe(false);
    checkFrames(rec.frames);
    expect(s.tokens).toBe(0);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toMatch(/429 Too Many Requests with Retry-After set to 2 ticks/);
    expect(last.lines).toEqual(['reject', 'retry']);
    expect(last.scene.nodes.find((n) => n.id === 'r6')!.tone).toBe('bad');
    expect(rec.frames.find((f) => f.compare)!.compare).toEqual({ left: 'tokens 0', op: '<', right: 'cost 2', verdict: 'reject, 2 short' });
    // Wait exactly that long and the same request passes.
    tick(s, 2, quiet(s));
    expect(request(s, 2, quiet(s))).toBe(true);
  });

  it('a request for more than the capacity is told it can never pass', () => {
    const s = create(3, 1);
    const rec = loud(s);
    expect(request(s, 4, rec)).toBe(false);
    checkFrames(rec.frames);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/always will be/);
    expect(s.tokens).toBe(3);
  });

  it('a burst pays out what is stored and rejects the rest, in order', () => {
    const s = create(5, 1);
    request(s, 1, quiet(s));
    const rec = loud(s);
    expect(burst(s, 5, rec)).toBe(4);
    expect(s.requests.length).toBe(SHOWN);
    checkFrames(rec.frames);
    expect(s.requests.map((r) => r.outcome)).toEqual(['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'rejected']);
    expect(rec.counters).toEqual({ comparisons: 5, allowed: 4, rejected: 1 });
    // All five are drawn waiting before the first is decided.
    expect(rec.frames[0].scene.nodes.filter((n) => /^r\d+$/.test(n.id)).length).toBe(6);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/Burst of 5: 4 allowed, 1 rejected/);
    // The burst listing has no Retry-After region, so no frame names it.
    expect(rec.frames.some((f) => f.lines!.includes('retry'))).toBe(false);
  });

  it('tick moves only the clock, and the tags show the gap the next refill will measure', () => {
    const s = create(5, 1);
    burst(s, 5, quiet(s));
    const rec = loud(s);
    expect(tick(s, 4, rec)).toBe(true);
    checkFrames(rec.frames);
    expect(rec.frames.length).toBe(1);
    expect(rec.counters).toEqual({});
    expect(s).toMatchObject({ tokens: 0, last: 0, now: 4 });
    const scene = rec.frames[0].scene;
    expect(pointsAt(scene, 'now')).toBe('4');
    expect(pointsAt(scene, 'last')).toBe('0');
    const note = scene.decor!.find((d) => d.id === 'bucket-label')!;
    expect(note.type === 'label' && note.text).toBe('Bucket: 0 of 5 at tick 0,\n+4 earned since');
    request(s, 1, quiet(s));
    const after = layout(s);
    expect(pointsAt(after, 'now')).toBe('4');
    expect(pointsAt(after, 'last')).toBe('4');
  });

  it('keeps last on the timeline however long the bucket sits idle', () => {
    const s = create(5, 1);
    for (let i = 0; i < 30; i++) {
      tick(s, 9, quiet(s));
      const strip = timeline(s);
      expect(strip.length).toBe(TICKS_SHOWN);
      expect(strip).toContain(s.now);
      expect(strip).toContain(s.last);
      const scene = layout(s);
      expect(pointsAt(scene, 'last')).toBe(String(s.last));
      expect(pointsAt(scene, 'now')).toBe(String(s.now));
      if (i === 15) request(s, 1, quiet(s));
    }
    expect(timeline(s).includes(null)).toBe(true);
  });

  it('stops politely at the clock limit, and reset starts again', () => {
    const s = create(5, 1);
    while (s.now + 9 <= MAX_TICK) tick(s, 9, quiet(s));
    const now = s.now;
    const rec = loud(s);
    expect(tick(s, 9, rec)).toBe(false);
    expect(s.now).toBe(now);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toMatch(/Sorry/);
    checkFrames(rec.frames);
    const again = loud(s);
    reset(s, again);
    checkFrames(again.frames);
    expect(s).toEqual(create(5, 1));
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    for (const [capacity, rate] of [[5, 1], [3, 3], [8, 2]] as const) {
      const a = create(capacity, rate);
      const b = create(capacity, rate);
      for (let i = 0; i < 300; i++) {
        const on = loud(a);
        const off = quiet(b);
        const roll = rnd();
        if (roll < 0.4) {
          const cost = 1 + Math.floor(rnd() * 9);
          expect(request(a, cost, on)).toBe(request(b, cost, off));
        } else if (roll < 0.75) {
          const k = 1 + Math.floor(rnd() * 9);
          expect(tick(a, k, on)).toBe(tick(b, k, off));
        } else if (roll < 0.97) {
          const n = 2 + Math.floor(rnd() * (MAX_BURST - 1));
          expect(burst(a, n, on)).toBe(burst(b, n, off));
        } else {
          reset(a, on);
          reset(b, off);
        }
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        checkFrames(on.frames);
        expect(a).toEqual(b);
        check(a);
      }
    }
  });

  it('request names wrap so they always fit their box', () => {
    expect(label({ seq: 1, cost: 1, outcome: 'waiting' })).toBe('r1');
    expect(label({ seq: 999, cost: 1, outcome: 'waiting' })).toBe('r999');
    expect(label({ seq: 1000, cost: 1, outcome: 'waiting' })).toBe('r1');
  });

  it('seed and tour run through the definition: allow, drain, reject, wait, allow', () => {
    expect(def.id).toBe('token-bucket');
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const params = Object.fromEntries(def.params!.map((p) => [p.id, p.default]));
    expect(params).toEqual({ capacity: 5, rate: 1 });
    const s = def.create(params);
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(s).toMatchObject({ tokens: 5, now: 3, last: 0 });
    const outcomes: string[] = [];
    const used = new Map<string, Set<string>>();
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      check(s);
      outcomes.push(`${id}: ${rec.counters.allowed ?? 0} allowed, ${rec.counters.rejected ?? 0} rejected, ${s.tokens} left`);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
    }
    expect(outcomes).toEqual([
      'request: 1 allowed, 0 rejected, 4 left',
      'burst: 4 allowed, 1 rejected, 0 left',
      'request: 0 allowed, 1 rejected, 0 left',
      'tick: 0 allowed, 0 rejected, 0 left',
      'request: 1 allowed, 0 rejected, 0 left',
    ]);
    expect(def.status!(s)).toEqual([
      { label: 'Tokens stored', value: '0 of 5' },
      { label: 'Available if asked now', value: '0' },
      { label: 'Clock', value: 'tick 5' },
      { label: 'Allowed, rejected', value: '6, 2' },
    ]);
    // Every anchor the tour names is in both listings.
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

  it('suggestions are accepted by the form for every parameter choice, and their frames name real code lines', () => {
    for (const cap of def.params![0].options) {
      for (const rate of def.params![1].options) {
        const s = def.create({ capacity: cap.value, rate: rate.value });
        const used = new Map<string, Set<string>>();
        for (let round = 0; round < 20; round++) {
          for (const op of def.ops) {
            // Reset now and then only, or nothing else would get anywhere.
            if (op.id === 'reset' && round % 10 !== 9) continue;
            const args = op.suggest?.(s) ?? [];
            expect(args.length).toBe(op.args.length);
            op.args.forEach((a, i) => {
              expect(Number.isInteger(args[i])).toBe(true);
              expect(args[i] as number).toBeGreaterThanOrEqual(a.min!);
              expect(args[i] as number).toBeLessThanOrEqual(a.max!);
            });
            const rec = new Recorder(s, def.layout, true);
            op.run(s, args, rec);
            checkFrames(rec.frames);
            check(s);
            const set = used.get(op.id) ?? new Set<string>();
            used.set(op.id, set);
            for (const f of rec.frames) for (const a of f.lines!) set.add(a);
          }
        }
        expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
      }
    }
  });
});
