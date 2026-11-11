import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, { BACK, HOSTS, SLOTS, add, create, frontSize, layout, next, tick, waiting, type FrontierState } from './index';

const quiet = (s: FrontierState) => new Recorder(s, layout, false);
const loud = (s: FrontierState) => new Recorder(s, layout, true);

/**
 * What the Python listing (code/crawl_frontier.py) did with 420 seeded operations on a frontier of the page's size:
 * A<host><priority><accepted>, N<leased URL or ->, T<ticks>. The Java listing replays the same kind of trace.
 */
const PYTHON_TRACE =
  'Ac11 Ac21 T1 Aa01 Ac01 T2 Ae11 Na/1 Ab21 Ad21 Ne/1 Aa11 Ab11 Ad11 Nb/1 Ab21 Nd/1 Ab11 Ad11 Nc/3 N- N- N- N- Ac11 Aa10 T2 Aa10 T3 Nb/2 Ab11 Ad21 Nc/1 Nd/2 Ab11 Na/2 T1 N- N- N- Ae21 N- Ad21 Ad11 Aa10 N- T1 Ac01 N- T2 Ac01 T2 Nb/4 Ad20 T3 Ac00 Ae20 Nd/3 Ab11 Ab20 Nc/2 T1 Nb/5 T2 Nc/5 Ab11 Nd/6 T3 Ac01 Nb/6 Nd/4 T3 Ac21 Ne/2 Ae01 Nc/6 Ab01 Nd/5 Nb/7 N- N- T3 Ab11 Ne/4 Nb/9 Nc/4 Ae21 Aa11 Na/6 N- T3 Ab01 Ac21 Nb/3 Ne/5 T2 Nc/8 N- N- Ad01 Ac11 Ab11 Nd/8 N- N- N- N- N- T3 Ab10 Nb/10 Nc/9 N- N- N- T2 N- T2 T2 Nb/11 Ae11 Aa21 Ne/6 Ac21 Na/7 Ab01 Ad11 T2 Ae21 Ae21 Nd/9 T1 Ae21 Ae01 Ad21 Ae10 Ae20 Ac11 Nc/10 Ac21 Ae00 Ne/7 Aa11 Ae20 Nb/12 T1 Ac20 N- T1 Ad01 Ac20 Ab20 Ab20 N- N- Ae11 Ac20 N- T2 Ne/10 Nd/11 Ac00 T3 Na/8 Ad01 Ae01 Nb/13 Aa01 Nc/11 Ad11 Aa20 Ae10 Ae10 Ae20 Ne/15 Nd/12 Ad20 N- N- N- T1 N- Aa11 N- T1 N- T2 Ad01 T1 T2 T3 Nc/12 Ae20 T2 Ne/16 Nb/15 T1 T2 Ab11 Na/9 Nd/15 Ae01 Nc/13 Ne/21 Nb/18 N- N- T2 N- N- N- N- Ae11 Ad21 N- Ae01 Ab11 Ac20 Ad20 T1 T2 T1 Nd/13 Ne/8 Ad20 Nb/19 T3 Aa11 T3 Na/11 Nd/10 Ab11 T2 Nc/14 T2 Ne/23 T1 Nb/20 Na/12 Aa01 Aa01 Ac01 Ad11 Ad21 Nd/16 Ab21 Ac01 Ab11 Ac21 Nc/20 Ab11 N- Aa21 N- N- Ae20 Ae20 Aa01 Ae11 Ab20 Aa20 N- T2 Ne/22 Ac01 N- Ad01 N- Ad10 Ae01 Ac10 Ac00 T3 Nc/21 Na/13 T1 Aa01 Ac01 Ab10 Ne/9 Ab20 Ac01 Ac10 Aa00 Ac00 T3 Nd/21 Ab01 Na/14 Ab00 Ad10 T2 Ac00 Aa20 Ac20 Ae00 Aa00 Aa20 Ac00 Nc/23 Ne/27 T1 Nb/27 Na/16 Nd/19 N- Ac11 Aa01 Aa20 N- N- Aa20 Ab11 Ad01 Ab10 N- N- N- N- N- N- Ac00 N- N- N- T3 Nc/26 Nb/22 Na/18 Nd/24 N- N- N- N- N- N- N- Ac01 N- N- N- Ad01 Aa11 N- Ad10 Ad10 Ae01 N- N- N- N- N- N- N- N- T1 N- N- T3 Aa20 T2 Na/23 Aa01 Nb/23 Ad10 Aa10 T1 Aa20 T2 Ae20 Ne/29 T3 Nd/25 Ad01 Nc/27 Na/28 Aa01 Ac20 Aa11 Aa00 T2 Ae10 Ne/26 Ad10 N- T3 Nd/29 Nb/29 Ae11 Ab01 Aa00 Na/31 Ab01 Ae01 T2 Nc/35 N- N- Aa01 N- N- N- Ae11 Ad21 N- Ab20 Ad00 N- N- Ad11 N- N- Ab00 Ae11 N- Ad20 T2 T2 Ae00 Ad20';

/** Throws if the queues, the table and the heap disagree with each other. */
function check(s: FrontierState): void {
  const hosted = s.host.filter((h) => h !== null) as string[];
  // A host has at most one back queue, and the table is exactly the hosts that have one.
  expect(new Set(hosted).size).toBe(hosted.length);
  expect([...s.table.entries()].sort()).toEqual(s.host.flatMap((h, q) => (h === null ? [] : [[h, q] as [string, number]])).sort());
  s.back.forEach((queue, q) => {
    // Outside an operation a back queue is empty exactly when it has no host.
    expect(queue.length === 0, `B${q + 1}`).toBe(s.host[q] === null);
    for (const u of queue) expect(u.host).toBe(s.host[q]);
  });
  // One heap entry for each back queue that has a host, and no parent later than its child.
  expect(s.heap.map((e) => e.q).sort()).toEqual(s.host.flatMap((h, q) => (h === null ? [] : [q])));
  s.heap.forEach((e, i) => {
    if (i > 0) expect(s.heap[(i - 1) >> 1].due).toBeLessThanOrEqual(e.due);
    // A host that has been contacted is never scheduled before its recorded time.
    const ready = s.ready.get(s.host[e.q] as string);
    if (ready !== undefined) expect(e.due).toBe(ready);
  });
  const count = new Map<string, number>();
  for (const queue of [...s.front, ...s.back]) for (const u of queue) count.set(u.host, (count.get(u.host) ?? 0) + 1);
  for (const [h, n] of s.pending) expect(n, `pending ${h}`).toBe(count.get(h) ?? 0);
  s.front.forEach((queue, p) => {
    expect(queue.length).toBeLessThanOrEqual(s.frontCap);
    for (const u of queue) expect(u.priority).toBe(p);
  });
  expect(s.leased.length).toBeLessThanOrEqual(SLOTS);
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
    expect(f.message).not.toMatch(/undefined|NaN|null|\u2014/);
    if (f.compare) expect(`${f.compare.left}${f.compare.right}${f.compare.verdict}`).not.toMatch(/undefined|NaN|null/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    const wrong: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 0.5) wrong.push(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        const overlap = a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
        if (overlap) wrong.push(`${a.id} overlaps ${b.id}`);
      }
    }
    expect(wrong).toEqual([]);
    // Magenta is only ever on the URL being followed.
    for (const n of f.scene.nodes) {
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      if (n.cells.some((c) => c.tone === 'key')) expect.fail(`${n.id} has a magenta cell`);
    }
  }
}

const runOp = (s: FrontierState, id: string, args: (number | string)[], recording: boolean) => {
  const rec = new Recorder(s, def.layout, recording);
  def.ops.find((o) => o.id === id)!.run(s, args, rec);
  return rec;
};

describe('crawl frontier', () => {
  it('does exactly what the Python listing does, operation for operation', () => {
    const s = create();
    const serial = new Map<string, number>();
    let leases = 0;
    let refusals = 0;
    for (const op of PYTHON_TRACE.split(' ')) {
      if (op[0] === 'A') {
        const host = op[1];
        serial.set(host, (serial.get(host) ?? 0) + 1);
        const got = add(s, host, Number(op[2]), quiet(s), `${host}/${serial.get(host)}`);
        expect(got !== null, op).toBe(op[3] === '1');
        if (!got) refusals++;
      } else if (op[0] === 'N') {
        const got = next(s, quiet(s));
        expect(got ?? '-', op).toBe(op.slice(1));
        if (got) leases++;
      } else {
        tick(s, Number(op.slice(1)), quiet(s));
      }
      check(s);
    }
    expect(leases).toBeGreaterThan(80);
    expect(refusals).toBeGreaterThan(20);
  });

  it('is polite, loses nothing and keeps its parts consistent through random operations', () => {
    for (const [seed, delay, backs, hosts] of [
      [1, 3, 3, 5],
      [2, 1, 3, 3],
      [3, 5, 2, 8],
      [4, 2, 6, 8],
      [5, 4, 1, 4],
    ]) {
      const rnd = makeRng(20261111 + seed);
      const names = 'abcdefgh'.slice(0, hosts).split('');
      const s = create(delay, 6, 6, backs);
      const queued = new Map<string, { priority: number; order: number }>();
      const last = new Map<string, number>();
      const order = new Map<string, number>();
      let serial = 0;
      let leases = 0;
      let waits = 0;
      const lease = (text: string) => {
        const host = text.split('/')[0];
        const was = queued.get(text);
        // Handed out once, and only if it was added.
        expect(was, text).toBeDefined();
        queued.delete(text);
        // Never twice inside the delay, whichever back queue the host was in.
        if (last.has(host)) expect(s.clock - last.get(host)!, `${text} at ${s.clock}`).toBeGreaterThanOrEqual(delay);
        last.set(host, s.clock);
        // Within one host and one priority, first in is first out.
        const k = `${host}:${was!.priority}`;
        expect(order.get(k) ?? 0).toBeLessThan(was!.order);
        order.set(k, was!.order);
      };
      for (let i = 0; i < 1600; i++) {
        const lean = Math.floor(i / 100) % 2 === 0 ? 0.5 : 0.2;
        const roll = rnd();
        if (roll < lean) {
          const host = names[Math.floor(rnd() * names.length)];
          const p = Math.floor(rnd() * 3);
          const room = s.front[p].length < s.frontCap && (s.pending.get(host) ?? 0) < s.hostCap;
          const rec = quiet(s);
          const url = add(s, host, p, rec, `${host}/${++serial}`);
          expect(url !== null).toBe(room);
          expect(rec.counters).toEqual(room ? { writes: 1 } : {});
          if (url) queued.set(url.text, { priority: p, order: serial });
        } else if (roll < 0.85) {
          const hadHeap = s.heap.length > 0;
          const got = next(s, quiet(s));
          if (got === null) {
            // Nothing is due: every host with a back queue is inside its delay.
            for (const h of s.host) if (h !== null) expect(s.ready.get(h)!).toBeGreaterThan(s.clock);
            if (s.heap.length) waits++;
            else expect(waiting(s)).toBe(0);
            if (!hadHeap && s.heap.length === 0) expect(frontSize(s)).toBe(0);
          } else {
            lease(got);
            leases++;
          }
          // A back queue is only idle when the front queues have nothing to give it.
          if (s.host.includes(null)) expect(frontSize(s)).toBe(0);
        } else {
          const before = s.clock;
          const rec = quiet(s);
          expect(tick(s, 1 + Math.floor(rnd() * 3), rec)).toBe(s.clock);
          expect(s.clock).toBeGreaterThan(before);
          expect(rec.counters).toEqual({});
        }
        check(s);
      }
      // Everything that was added is leased in the end.
      for (let guard = 0; queued.size > 0; guard++) {
        expect(guard).toBeLessThan(5000);
        const got = next(s, quiet(s));
        if (got === null) tick(s, 1, quiet(s));
        else lease(got);
      }
      check(s);
      expect(s.heap.length).toBe(0);
      expect(waiting(s)).toBe(0);
      expect(leases).toBeGreaterThan(100);
      if (delay > 1) expect(waits).toBeGreaterThan(20);
    }
  });

  it('decides that nothing is due with one comparison and changes nothing', () => {
    const s = create();
    add(s, 'a', 1, quiet(s));
    add(s, 'a', 1, quiet(s));
    expect(next(s, quiet(s))).toBe('a/1');
    const before = JSON.stringify([s.front, s.back, s.heap, [...s.table], [...s.ready]]);
    const rec = loud(s);
    expect(next(s, rec)).toBeNull();
    expect(JSON.stringify([s.front, s.back, s.heap, [...s.table], [...s.ready]])).toBe(before);
    expect(rec.counters).toEqual({ comparisons: 1 });
    const cmp = rec.frames.find((f) => f.compare)!.compare!;
    expect(cmp).toEqual({ left: 'B1: t3', op: '>', right: 'clock: t0', verdict: 'not due, wait 3 ticks' });
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/Nothing is handed out/);
    expect(rec.frames.every((f) => f.probe?.text === 'a/2')).toBe(true);
    checkFrames(rec.frames);
    // The Tick button offers exactly the wait.
    expect(def.ops.find((o) => o.id === 'tick')!.suggest!(s)).toEqual([3]);
    tick(s, 3, quiet(s));
    expect(next(s, quiet(s))).toBe('a/2');
  });

  it('alternates between hosts instead of draining one', () => {
    const s = create();
    for (let i = 0; i < 4; i++) add(s, 'a', 0, quiet(s));
    for (let i = 0; i < 4; i++) add(s, 'b', 1, quiet(s));
    const got: (string | null)[] = [];
    for (let t = 0; t < 12; t++) {
      got.push(next(s, quiet(s)));
      tick(s, 1, quiet(s));
    }
    // With a delay of 3 ticks, each host is served once every three ticks, in turn.
    expect(got).toEqual(['a/1', 'b/1', null, 'a/2', 'b/2', null, 'a/3', 'b/3', null, 'a/4', 'b/4', null]);
  });

  it('routes pulled URLs through the table and gives an empty back queue a new host', () => {
    const s = create();
    add(s, 'a', 1, quiet(s));
    add(s, 'b', 1, quiet(s));
    add(s, 'c', 1, quiet(s));
    expect(next(s, quiet(s))).toBe('a/1');
    // a gave up B1 and nothing was left to pull, so B1 is idle and off the heap.
    expect(s.host).toEqual([null, 'b', 'c']);
    expect(s.heap.map((e) => e.q).sort()).toEqual([1, 2]);
    add(s, 'b', 0, quiet(s));
    add(s, 'c', 0, quiet(s));
    add(s, 'd', 2, quiet(s));
    const rec = loud(s);
    expect(next(s, rec)).toBe('c/1');
    // The idle queue pulled b/2 and c/2 (high priority first), which went to their hosts' queues, then took d.
    expect(s.host).toEqual(['d', 'b', 'c']);
    expect(s.back.map((q) => q.map((u) => u.text))).toEqual([['d/1'], ['b/1', 'b/2'], ['c/2']]);
    expect(frontSize(s)).toBe(0);
    const lookups = rec.frames.filter((f) => f.compare && /host/.test(String(f.compare.left))).map((f) => f.compare!);
    expect(lookups.map((c) => `${c.left} ${c.op} ${c.right}`)).toEqual(['b/2: host b = b → B2', 'c/2: host c = c → B3', 'd/1: host d ≠ any host with a queue']);
    expect(rec.frames[0].lines).toEqual(['idle']);
    checkFrames(rec.frames);
    check(s);
  });

  it('remembers a host that gave up its queue, so it cannot come back early', () => {
    const s = create();
    add(s, 'a', 1, quiet(s));
    add(s, 'b', 1, quiet(s));
    expect(next(s, quiet(s))).toBe('a/1');
    expect(s.table.has('a')).toBe(false);
    expect(s.ready.get('a')).toBe(3);
    tick(s, 1, quiet(s));
    add(s, 'a', 0, quiet(s));
    // B1 is idle and takes a again, but with a's old time, not the current tick.
    const rec = loud(s);
    expect(next(s, rec)).toBe('b/1');
    expect(s.host[0]).toBe('a');
    expect(s.heap).toEqual([{ due: 3, q: 0 }]);
    expect(rec.frames.some((f) => /does not reset a host's delay/.test(f.message))).toBe(true);
    checkFrames(rec.frames);
    expect(next(s, quiet(s))).toBeNull();
    tick(s, 2, quiet(s));
    expect(next(s, quiet(s))).toBe('a/2');
  });

  it('refuses politely at the page limits and for an unknown host, changing nothing', () => {
    const s = def.create({ delay: 3 }) as FrontierState;
    for (const h of ['a', 'b', 'c', 'd']) expect(add(s, h, 0, quiet(s))).not.toBeNull();
    for (const args of [
      ['e', 1],
      ['zebra', 2],
    ] as [string, number][]) {
      const before = waiting(s);
      const rec = runOp(s, 'add', args, true);
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(/^Sorry/);
      expect(rec.counters).toEqual({});
      expect(waiting(s)).toBe(before);
      checkFrames(rec.frames);
    }
    for (let i = 0; i < 3; i++) expect(add(s, 'a', 1 + (i % 2), quiet(s))).not.toBeNull();
    const rec = loud(s);
    expect(add(s, 'a', 2, rec)).toBeNull();
    expect(rec.frames[0].message).toMatch(/host a already has 4 URLs waiting/);
    check(s);
    // An empty frontier has nothing to lease and says so.
    const empty = create();
    const none = loud(empty);
    expect(next(empty, none)).toBeNull();
    expect(none.frames.length).toBe(1);
    expect(none.frames[0].lines).toEqual(['none']);
    expect(none.counters).toEqual({});
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    for (const delay of [2, 3, 5]) {
      const rnd = makeRng(4242 + delay);
      const a = create(delay);
      const b = create(delay);
      let frames = 0;
      for (let i = 0; i < 400; i++) {
        const on = loud(a);
        const off = quiet(b);
        const lean = Math.floor(i / 60) % 2 === 0 ? 0.45 : 0.2;
        const roll = rnd();
        if (roll < lean) {
          const host = HOSTS[Math.floor(rnd() * HOSTS.length)];
          const p = Math.floor(rnd() * 3);
          expect(add(a, host, p, on)?.text ?? null).toBe(add(b, host, p, off)?.text ?? null);
        } else if (roll < 0.85) {
          expect(next(a, on)).toBe(next(b, off));
        } else {
          const n = 1 + Math.floor(rnd() * 3);
          expect(tick(a, n, on)).toBe(tick(b, n, off));
        }
        expect(on.counters).toEqual(off.counters);
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        // Every comparison the counter saw is a frame with a comparison on it.
        expect(on.frames.filter((f) => f.compare).length).toBe(on.counters.comparisons ?? 0);
        checkFrames(on.frames);
        frames += on.frames.length;
        expect(JSON.stringify([a.front, a.back, a.heap, a.host, a.clock])).toBe(JSON.stringify([b.front, b.back, b.heap, b.host, b.clock]));
        check(a);
      }
      expect(frames).toBeGreaterThan(1000);
    }
  });

  it('keeps the view still: the corners never move', () => {
    const s = create();
    const first = corners(layout(s));
    const rnd = makeRng(9);
    for (let i = 0; i < 300; i++) {
      const roll = rnd();
      if (roll < 0.45) add(s, HOSTS[Math.floor(rnd() * 5)], Math.floor(rnd() * 3), quiet(s));
      else if (roll < 0.85) next(s, quiet(s));
      else tick(s, 1, quiet(s));
      expect(corners(layout(s))).toEqual(first);
    }
    // Wide enough to read, narrow enough to sit beside the step log.
    expect(first.x2 - first.x1).toBeLessThanOrEqual(950);
    expect(first.y2 - first.y1).toBeLessThanOrEqual(380);
  });

  it('seed and tour run cleanly through the definition and show what they promise', () => {
    const s = def.create({ delay: 3 }) as FrontierState;
    for (const [id, ...args] of def.seed) runOp(s, id, args, false);
    check(s);
    // A crawl in progress: every back queue has a host, b is due, a becomes due this tick and c is inside its delay.
    expect(s.clock).toBe(3);
    expect(s.host).toEqual(['a', 'b', 'c']);
    expect(s.back.map((q) => q.map((u) => u.text))).toEqual([['a/2', 'a/3'], ['b/1', 'b/2', 'b/3'], ['c/2']]);
    expect(frontSize(s)).toBe(0);
    expect(s.heap).toEqual([
      { due: 0, q: 1 },
      { due: 3, q: 0 },
      { due: 4, q: 2 },
    ]);
    expect(s.leased.map((l) => `${l.url.text}@${l.at}`)).toEqual(['a/1@0', 'c/1@1']);

    const recs = def.tour.map(([id, ...args]) => {
      const rec = runOp(s, id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      check(s);
      return rec;
    });
    const last = (i: number) => recs[i].frames[recs[i].frames.length - 1].message;
    // Two adds at different priorities for two hosts.
    expect(last(0)).toMatch(/^a\/4 is queued/);
    expect(last(1)).toMatch(/^d\/1 is queued/);
    // Two leases that alternate between hosts.
    expect(last(2)).toMatch(/^b\/1 is leased at tick 3/);
    expect(last(3)).toMatch(/^a\/2 is leased at tick 3/);
    // The only host left is inside its delay.
    expect(last(4)).toMatch(/Nothing is handed out/);
    expect(recs[4].counters).toEqual({ comparisons: 1 });
    // After one tick, c's last URL is leased, its queue empties and is refilled: a/4 goes to a's queue, d takes B3.
    expect(last(6)).toMatch(/^c\/2 is leased at tick 4/);
    const refill = recs[6].frames.flatMap((f) => f.lines ?? []);
    for (const anchor of ['release', 'pull', 'lookup', 'route', 'claim', 'schedule', 'push', 'swap_up']) expect(refill, anchor).toContain(anchor);
    expect(s.host).toEqual(['a', 'b', 'd']);
    expect(s.back.map((q) => q.map((u) => u.text))).toEqual([['a/3', 'a/4'], ['b/2', 'b/3'], ['d/1']]);
    expect(s.heap[0]).toEqual({ due: 4, q: 2 });
    // The tour shows a swap in the heap in both directions.
    expect(recs[2].frames.flatMap((f) => f.lines ?? [])).toContain('swap_down');
    expect(def.status!(s)).toEqual([
      { label: 'Clock', value: 'tick 4' },
      { label: 'Waiting', value: '5 URLs' },
      { label: 'Soonest', value: 'host d, due now' },
      { label: 'Leased', value: '5' },
    ]);
  });

  it('names code lines that exist in both listings, for every frame of every path', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, `${lang}: ${line}`).toBeLessThanOrEqual(80);
      }
    }
    const used = new Map<string, Set<string>>();
    for (const delay of [2, 3, 5]) {
      const s = def.create({ delay }) as FrontierState;
      for (const [id, ...args] of def.seed) runOp(s, id, args, false);
      const run = (id: string, args: (number | string)[]) => {
        const rec = runOp(s, id, args, true);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
      };
      for (const [id, ...args] of def.tour) run(id, args);
      for (let round = 0; round < 150; round++) for (const op of def.ops) run(op.id, op.suggest?.(s) ?? []);
      run('add', ['zebra', 1]);
      // Fill one host to the page's limit so the refusal is reached, then try once more.
      for (let i = 0; i < 6; i++) run('add', ['e', 1 + (i % 3)]);
      const empty = def.create({ delay }) as FrontierState;
      const none = runOp(empty, 'next', [], true);
      for (const f of none.frames) for (const a of f.lines ?? []) used.get('next')!.add(a);
    }
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    // The random runs reach every branch the listing marks, bar the two a heap of three can never take.
    const all = new Set([...used.values()].flatMap((set) => [...set]));
    const marked = new Set(def.ops.flatMap((op) => [...listing(def.source!.python, 'python', op.code!).anchors.keys()]));
    expect([...marked].filter((a) => !all.has(a)).sort()).toEqual(['pick', 'pick_right']);
  });

  it('suggests arguments the form accepts, and fill never overfills the page', () => {
    const s = def.create({ delay: 3 }) as FrontierState;
    const op = def.ops.find((o) => o.id === 'add')!;
    for (let i = 0; i < 60; i++) {
      const [host, priority] = op.suggest!(s);
      expect(HOSTS).toContain(host);
      expect(priority as number).toBeGreaterThanOrEqual(1);
      expect(priority as number).toBeLessThanOrEqual(3);
      const [id, ...args] = def.fill!(s);
      runOp(s, id, args, false);
      check(s);
      for (const q of [...s.front, ...s.back]) expect(q.length).toBeLessThanOrEqual(SLOTS);
    }
    expect(s.back.length).toBe(BACK);
    expect(waiting(s)).toBeGreaterThan(8);
  });
});
