import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { LABEL_MAX, sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, OpDef, Scene } from '../../core/types';
import def, {
  RCV_BUF,
  SEGMENTS,
  arm,
  close,
  congestion,
  connect,
  create,
  dupAcks,
  inFlight,
  layout,
  reset,
  send,
  slowReceiver,
  timeout,
  udpCompare,
  type TcpState,
} from './index';

const quiet = (s: TcpState) => new Recorder(s, layout, false);
const loud = (s: TcpState) => new Recorder(s, layout, true);

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, real probe targets, a code line, nothing overlapping or off the scene, magenta only on the followed thing. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    if (f.probe) expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    if (f.compare) expect(f.probe).toBeDefined();
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + LABEL_MAX * 0.65 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    const keyed = f.scene.nodes.filter((n) => n.tone === 'key');
    expect(keyed.length).toBeLessThanOrEqual(1);
    if (keyed.length) expect(keyed[0].id).toBe(f.probe?.at);
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

/** Invariants that hold between operations. */
function verify(s: TcpState): void {
  expect(s.data).toEqual([]);
  expect(s.acks).toEqual([]);
  if (s.proto === 'tcp') {
    // The application sees 1, 2, 3 ... in order, never a gap and never a repeat.
    expect([...s.app, ...s.unread]).toEqual(Array.from({ length: s.expected - 1 }, (_, i) => i + 1));
    for (const h of s.held) expect(h).toBeGreaterThan(s.expected);
    expect(s.held.length + s.unread.length).toBeLessThanOrEqual(RCV_BUF);
    expect(s.base).toBe(s.expected);
    expect(inFlight(s)).toBeLessThanOrEqual(s.window);
    expect(s.totals.sent).toBe(s.next - 1 + s.totals.retransmissions);
    expect(s.totals.delivered).toBe(s.app.length);
    expect(s.totals.lost).toBe(0);
    s.segs.forEach((st, i) => expect(st).toBe(i + 1 < s.base ? 'acked' : i + 1 < s.next ? 'sent' : 'unsent'));
  } else {
    const got = [...s.app, ...s.unread];
    expect(new Set(got).size).toBe(got.length);
    expect(got.length + s.totals.lost).toBe(s.totals.sent);
    expect(s.totals.sent).toBe(s.next - 1);
    expect(s.totals.retransmissions).toBe(0);
    expect(s.unread.length).toBeLessThanOrEqual(RCV_BUF);
    let hi = 0;
    let inOrder = 0;
    for (const q of s.app) if (q > hi) ((hi = q), inOrder++);
    expect(s.totals.delivered).toBe(inOrder);
  }
}

type Step = (s: TcpState, rec: Recorder<TcpState>) => unknown;

function randomStep(rnd: () => number): Step {
  const r = rnd();
  const pick = (n: number) => 1 + Math.floor(rnd() * n);
  if (r < 0.08) return (s, rec) => connect(s, rec);
  if (r < 0.38) {
    const n = pick(SEGMENTS);
    return (s, rec) => send(s, n, rec);
  }
  if (r < 0.52) {
    const q = pick(SEGMENTS);
    const f = rnd() < 0.5 ? 'drop' : 'reorder';
    return (s, rec) => arm(s, q, f, rec);
  }
  if (r < 0.66) return (s, rec) => timeout(s, rec);
  if (r < 0.72) return (s, rec) => dupAcks(s, rec);
  if (r < 0.83) return (s, rec) => slowReceiver(s, rec);
  if (r < 0.86) return (s, rec) => congestion(s, rec);
  if (r < 0.95) return (s, rec) => close(s, rec);
  if (r < 0.98) {
    const proto = rnd() < 0.5 ? 'tcp' : 'udp';
    return (s, rec) => reset(s, proto, rec);
  }
  return (s, rec) => udpCompare(s, rec);
}

describe('tcp and udp', () => {
  for (const proto of ['tcp', 'udp'] as const) {
    for (const window of [3, 4]) {
      it(`keeps its promises under thousands of random operations (${proto}, window ${window})`, () => {
        const rnd = makeRng(window * 97 + (proto === 'tcp' ? 1 : 2));
        let s = create(proto, window);
        let repaired = 0;
        let fast = 0;
        for (let i = 0; i < 6000; i++) {
          if (i % 150 === 0) s = create(proto, window);
          const sent0 = s.totals.retransmissions;
          const step = randomStep(rnd);
          step(s, quiet(s));
          if (s.totals.retransmissions > sent0) {
            repaired++;
            // A retransmission outside Timeout can only be a fast retransmit.
            if (!/timeout/.test(step.toString())) fast++;
          }
          verify(s);
          // Liveness: with the faults cleared and the application reading, timeouts always finish the job.
          if (s.proto === 'tcp' && s.conn === 'open' && i % 7 === 0) {
            const c: TcpState = structuredClone(s);
            c.faults = {};
            if (c.slow) slowReceiver(c, quiet(c));
            for (let k = 0; k < 10; k++) timeout(c, quiet(c));
            expect(c.base).toBe(c.next);
            expect(c.app).toEqual(Array.from({ length: c.next - 1 }, (_, k) => k + 1));
          }
        }
        if (proto === 'tcp') expect(repaired).toBeGreaterThan(15);
        if (proto === 'tcp' && window === 4) expect(fast).toBeGreaterThan(0);
      });
    }
  }

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    for (const proto of ['tcp', 'udp'] as const) {
      for (const window of [3, 4]) {
        const a = create(proto, window);
        const b = create(proto, window);
        for (let i = 0; i < 300; i++) {
          const step = randomStep(rnd);
          const on = loud(a);
          const off = quiet(b);
          expect(step(a, on)).toEqual(step(b, off));
          expect(on.counters).toEqual(off.counters);
          expect(off.frames.length).toBe(0);
          expect(on.frames.length).toBeGreaterThan(0);
          checkFrames(on.frames);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        }
      }
    }
  }, 60_000);

  it('runs the tour: handshake, a sliding window, fast retransmit with head-of-line blocking, then UDP', () => {
    const s = create('tcp', 4);
    const run = (opId: string, args: (number | string)[]) => {
      const rec = loud(s);
      def.ops.find((o) => o.id === opId)!.run(s, args, rec);
      checkFrames(rec.frames);
      return rec;
    };
    const hs = run('connect', []);
    expect(s.conn).toBe('open');
    expect(hs.frames.map((f) => f.lines![0])).toEqual(expect.arrayContaining(['syn', 'syn_ack', 'check', 'ack', 'open']));
    expect(hs.frames.some((f) => /SYN-ACK/.test(f.message) && /101/.test(f.message))).toBe(true);

    const first = run('send', [3]);
    expect(s.base).toBe(4);
    expect(s.app).toEqual([1, 2, 3]);
    expect(first.counters).toEqual({ comparisons: 9, sent: 3, delivered: 3 });

    run('drop', [4]);
    const loss = run('send', [4]);
    // 4 lost; 5, 6, 7 held; three duplicate acks; one fast retransmit; then all four go up at once.
    expect(loss.counters.sent).toBe(5);
    expect(loss.counters.retransmissions).toBe(1);
    expect(loss.counters.delivered).toBe(4);
    expect(s.app).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.base).toBe(8);
    const held = loss.frames.find((f) => f.lines!.includes('hold') && /7/.test(f.message))!;
    expect(held.scene.nodes.filter((n) => /^r[567]$/.test(n.id)).map((n) => n.y)).toEqual([0, 0, 0]);
    expect(loss.frames.some((f) => f.lines!.includes('fast'))).toBe(true);
    expect(loss.frames.some((f) => /head-of-line blocking/.test(f.message))).toBe(true);
    expect(loss.frames.filter((f) => /duplicate/.test(f.compare?.verdict ?? '')).length).toBe(3);

    const udp = run('udp', []);
    expect(s.proto).toBe('udp');
    expect(s.app).toEqual([1, 3, 2]);
    expect(s.totals.lost).toBe(1);
    expect(udp.counters).toEqual({ sent: 4, delivered: 2, lost: 1 });
    expect(udp.frames[udp.frames.length - 1].message).toMatch(/1, 3 and 2/);
  });

  it('with a window of 3 there are too few duplicate acks, so the timer has to recover the loss', () => {
    const s = create('tcp', 3);
    connect(s, quiet(s));
    const rec = loud(s);
    dupAcks(s, rec);
    expect(s.base).toBe(1);
    expect(s.held).toEqual([2, 3]);
    expect(s.totals.retransmissions).toBe(0);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/press Timeout/);
    // The window is full: a send has to wait.
    const blocked = loud(s);
    expect(send(s, 1, blocked)).toBe(0);
    expect(blocked.frames[0].compare?.verdict).toBe('window full: wait for acks');
    const t = loud(s);
    expect(timeout(s, t)).toBe(true);
    checkFrames(t.frames);
    expect(s.app).toEqual([1, 2, 3]);
    expect(s.base).toBe(4);
    expect(t.counters.retransmissions).toBe(1);
  });

  it('flow control: a receiver that stops reading closes the window, and a window update reopens it', () => {
    const s = create('tcp', 4);
    connect(s, quiet(s));
    slowReceiver(s, quiet(s));
    send(s, 4, quiet(s));
    expect(s.unread).toEqual([1, 2, 3, 4]);
    expect(s.peerWindow).toBe(0);
    expect(s.totals.delivered).toBe(0);
    const rec = loud(s);
    expect(send(s, 1, rec)).toBe(0);
    expect(rec.frames[0].compare?.verdict).toBe('receiver is full: pause');
    expect(rec.frames[0].message).toMatch(/probe/);
    const open = loud(s);
    slowReceiver(s, open);
    checkFrames(open.frames);
    expect(s.app).toEqual([1, 2, 3, 4]);
    expect(s.peerWindow).toBe(RCV_BUF);
    expect(open.counters.delivered).toBe(4);
    expect(send(s, 4, quiet(s))).toBe(4);
  });

  it('a reordered segment is put back in order by TCP, and handed up out of order by UDP', () => {
    const t = create('tcp', 4);
    connect(t, quiet(t));
    arm(t, 2, 'reorder', quiet(t));
    send(t, 4, quiet(t));
    expect(t.app).toEqual([1, 2, 3, 4]);
    expect(t.totals.retransmissions).toBe(0);
    const u = create('udp', 4);
    arm(u, 2, 'reorder', quiet(u));
    send(u, 4, quiet(u));
    expect(u.app).toEqual([1, 3, 2, 4]);
    expect(u.totals.delivered).toBe(3);
  });

  it('UDP has no flow control: a full socket buffer drops datagrams', () => {
    const s = create('udp', 4);
    slowReceiver(s, quiet(s));
    send(s, 6, quiet(s));
    expect(s.unread).toEqual([1, 2, 3, 4]);
    expect(s.totals.lost).toBe(2);
    expect(s.segs.slice(4, 6)).toEqual(['lost', 'lost']);
  });

  it('draws the congestion strip: slow start, additive increase, halving on loss', () => {
    const s = create('tcp', 4);
    const rec = loud(s);
    congestion(s, rec);
    checkFrames(rec.frames);
    expect(s.cwnd).toEqual([1, 2, 4, 8, 9, 10, 5, 6]);
    expect(s.ssthresh).toBe(5);
    expect(layout(s).nodes.find((n) => n.id === 'cw6')!.tone).toBe('bad');
  });

  it('closes only when everything is acknowledged, and refuses politely otherwise', () => {
    const s = create('tcp', 4);
    expect(close(s, quiet(s))).toBe(false);
    connect(s, quiet(s));
    arm(s, 1, 'drop', quiet(s));
    send(s, 1, quiet(s));
    const before = JSON.stringify(s);
    expect(close(s, quiet(s))).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    timeout(s, quiet(s));
    const rec = loud(s);
    expect(close(s, rec)).toBe(true);
    checkFrames(rec.frames);
    expect(s.conn).toBe('done');
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/TIME_WAIT/);
    expect(send(s, 1, quiet(s))).toBe(0);
  });

  it('fits the page: no scene wider than 940 or taller than about 420', () => {
    const s = create('tcp', 4);
    connect(s, quiet(s));
    for (let i = 0; i < 2; i++) send(s, 4, quiet(s));
    for (const st of [s, create('udp', 4), create('tcp', 3)]) {
      const b = sceneBounds(layout(st))!;
      expect(b.bw).toBeLessThanOrEqual(940);
      expect(b.bh).toBeLessThanOrEqual(430);
    }
    // Eight datagrams in flight at once still fit the lane.
    const u = create('udp', 4);
    const rec = loud(u);
    send(u, 8, rec);
    checkFrames(rec.frames);
  });

  it('keeps the code listings in step with the animation, for every parameter', () => {
    const find = (id: string) => def.ops.find((o) => o.id === id) as OpDef<TcpState>;
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, `${op.id} ${lang}: ${line}`).toBeLessThanOrEqual(80);
      }
    }
    for (const params of [{ protocol: 0, window: 4 }, { protocol: 1, window: 4 }, { protocol: 0, window: 3 }]) {
      const s = def.create(params);
      const used = new Map<string, Set<string>>();
      const run = (opId: string, args: (number | string)[]) => {
        const rec = loud(s);
        find(opId).run(s, args, rec);
        const set = used.get(opId) ?? new Set<string>();
        used.set(opId, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        checkFrames(rec.frames);
      };
      for (const [opId, ...args] of def.tour) run(opId, args);
      for (let round = 0; round < 12; round++) for (const op of def.ops) run(op.id, op.suggest?.(s) ?? []);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });
});
