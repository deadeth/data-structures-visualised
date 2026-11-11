import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  HEARTBEAT,
  METHODS,
  RETRY,
  ROWS,
  SHOWN,
  TIMEOUT,
  arrive,
  asMethod,
  clientSend,
  connectOp,
  create,
  drop,
  layout,
  openConnections,
  replay,
  tick,
  waitIdle,
  type Method,
  type PushState,
} from './index';

const quiet = (s: PushState) => new Recorder(s, layout, false);
const loud = (s: PushState) => new Recorder(s, layout, true);

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    expect(new Set(f.scene.edges.map((e) => e.id)).size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) {
      expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
      expect(f.probe.text).toMatch(/^[mc]\d+$/);
    }
    if (f.compare) expect(f.probe).toBeDefined();
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      // Magenta only on the message being followed.
      if (n.tone === 'key') expect(n.cells[0].text).toContain(f.probe?.text ?? '<no probe>');
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 || a.x2 > edge.x2 || a.y2 > edge.y2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

/** Every message reaches the client once and in order, with the delay its method allows. */
function checkState(s: PushState, late: Set<number>): void {
  expect(s.open).toBe(true);
  expect(s.broken).toBe(false);
  expect(s.delays.length).toBe(s.seen);
  expect(s.rows.length).toBeLessThanOrEqual(ROWS);
  expect(s.msgs.length).toBeLessThanOrEqual(SHOWN);
  s.delays.forEach((d, i) => {
    expect(d).toBeGreaterThanOrEqual(0);
    if (s.method === 'short') expect(d).toBeLessThanOrEqual(s.every);
    else expect(d).toBe(late.has(i + 1) ? RETRY : 0);
  });
  if (s.method === 'short') {
    expect(s.nextPoll - s.now).toBeGreaterThanOrEqual(1);
    expect(s.nextPoll - s.now).toBeLessThanOrEqual(s.every);
    expect(openConnections(s)).toBe(0);
  } else {
    expect(s.seen).toBe(s.arrived.length);
    const idle = s.now - s.since;
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(idle).toBeLessThan(s.method === 'long' ? TIMEOUT : HEARTBEAT);
    expect(openConnections(s)).toBe(1);
  }
}

describe('realtime push', () => {
  for (const method of METHODS) {
    for (const every of [2, 3, 4]) {
      it(`delivers every message once, in order, with recording off and on agreeing (${method}, every ${every})`, () => {
        const rnd = makeRng(METHODS.indexOf(method) * 17 + every);
        const a = create(method, every);
        const b = create(method, every);
        connectOp(a, quiet(a));
        connectOp(b, loud(b));
        let late = new Set<number>();
        let sends = 0;
        for (let i = 0; i < 1500; i++) {
          const on = i % 25 === 0 ? loud(b) : quiet(b);
          const off = quiet(a);
          const roll = rnd();
          const before = a.arrived.length;
          const fromRequests = a.requests;
          if (roll < 0.3) {
            const k = 1 + Math.floor(rnd() * 9);
            if (a.now + k > 990) {
              replay(a, a.method, off);
              replay(b, b.method, on);
              late = new Set();
              sends = 0;
            } else {
              tick(a, k, off);
              tick(b, k, on);
            }
          } else if (roll < 0.55) {
            arrive(a, off);
            arrive(b, on);
          } else if (roll < 0.65) {
            clientSend(a, off);
            clientSend(b, on);
            sends++;
            expect(a.requests - fromRequests).toBe(a.method === 'ws' ? 0 : 1);
          } else if (roll < 0.72) {
            connectOp(a, off);
            connectOp(b, on);
          } else if (roll < 0.84) {
            const m = Math.floor(rnd() * 4);
            drop(a, m, off);
            drop(b, m, on);
            if (a.method !== 'short') for (let j = before + 1; j <= before + m; j++) late.add(j);
          } else if (roll < 0.95) {
            waitIdle(a, off);
            waitIdle(b, on);
          } else {
            replay(a, a.method, off);
            replay(b, b.method, on);
            late = new Set();
            sends = 0;
          }
          expect(on.counters).toEqual(off.counters);
          if (on.recording) {
            expect(on.frames.length).toBeGreaterThan(0);
            expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
            checkFrames(on.frames);
          }
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
          expect(a.received).toBe(sends);
          checkState(a, late);
        }
      });
    }
  }

  it('replays the tour script with the numbers the page quotes', () => {
    const s = create('long', 3);
    const want: Record<Method, { requests: number; empty: number; delays: number[] }> = {
      short: { requests: 4, empty: 2, delays: [1, 2] },
      long: { requests: 3, empty: 0, delays: [0, 0] },
      sse: { requests: 1, empty: 0, delays: [0, 0] },
      ws: { requests: 1, empty: 0, delays: [0, 0] },
    };
    for (const m of METHODS) {
      const rec = loud(s);
      replay(s, m, rec);
      checkFrames(rec.frames);
      expect({ requests: s.requests, empty: s.empty, delays: s.delays }).toEqual(want[m]);
    }
  });

  it('short polling shows the wait as a comparison with the next poll', () => {
    const s = create('short', 3);
    const rec = loud(s);
    replay(s, 'short', rec);
    const compares = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(compares).toContainEqual({ left: 'm1 at tick 2', op: '<', right: 'next poll at 3', verdict: 'm1 waits 1 tick' });
    expect(compares).toContainEqual({ left: 'm2 at tick 7', op: '<', right: 'next poll at 9', verdict: 'm2 waits 2 ticks' });
  });

  it('a long poll held to the timeout comes back empty and is reopened', () => {
    const s = create('long', 3);
    replay(s, 'long', quiet(s));
    const rec = loud(s);
    waitIdle(s, rec);
    checkFrames(rec.frames);
    expect(s.now).toBe(13);
    expect(rec.counters).toEqual({ requests: 1, empty: 1 });
    expect(rec.frames.some((f) => f.message.includes('204 No Content'))).toBe(true);
    expect(s.rows.slice(-2).map((r) => r.text)).toEqual(['204 No Content', 'GET /poll?after=2']);
  });

  it('a dropped SSE stream resumes from Last-Event-ID; WebSocket resumes only by its own message', () => {
    const s = create('sse', 3);
    replay(s, 'sse', quiet(s));
    const rec = loud(s);
    drop(s, 1, rec);
    checkFrames(rec.frames);
    expect(s.rows.map((r) => r.text)).toContain('GET /events, Last-Event-ID 2');
    expect(s.rows[s.rows.length - 1].text).toBe('id: 3, data: m3');
    expect(s.delays).toEqual([0, 0, RETRY]);
    expect(rec.frames.some((f) => f.lines!.includes('resync'))).toBe(false);

    const w = create('ws', 3);
    replay(w, 'ws', quiet(w));
    const wr = loud(w);
    drop(w, 2, wr);
    checkFrames(wr.frames);
    expect(w.rows.map((r) => r.text)).toContain('resume after 2');
    expect(wr.frames.some((f) => f.lines!.includes('resync'))).toBe(true);
    expect(w.seen).toBe(4);
  });

  it('a client message is a POST except on a WebSocket', () => {
    for (const m of METHODS) {
      const s = create(m, 3);
      connectOp(s, quiet(s));
      const rec = loud(s);
      clientSend(s, rec);
      checkFrames(rec.frames);
      expect(rec.counters.requests ?? 0).toBe(m === 'ws' ? 0 : 1);
      expect(s.rows.some((r) => r.text === (m === 'ws' ? 'frame c1' : 'POST /messages c1'))).toBe(true);
    }
  });

  it('reads method names', () => {
    expect(asMethod('short')).toBe('short');
    expect(asMethod('websocket')).toBe('ws');
    expect(asMethod('sse')).toBe('sse');
    expect(asMethod('long')).toBe('long');
    expect(asMethod('carrier')).toBeNull();
  });

  it('runs the seed and the tour through the definition, for every parameter', () => {
    for (const method of [0, 1, 2, 3]) {
      for (const every of [2, 3, 4]) {
        const s = def.create({ method, every });
        for (const [op, ...args] of def.seed) def.ops.find((o) => o.id === op)!.run(s, args, quiet(s));
        for (const [op, ...args] of def.tour) {
          const rec = loud(s);
          def.ops.find((o) => o.id === op)!.run(s, args, rec);
          expect(rec.frames.length).toBeGreaterThan(0);
          checkFrames(rec.frames);
        }
        for (let r = 0; r < 6; r++) {
          for (const op of def.ops) {
            const rec = loud(s);
            op.run(s, op.suggest?.(s) ?? [], rec);
            expect(rec.frames.length).toBeGreaterThan(0);
            checkFrames(rec.frames);
          }
        }
      }
    }
  });
});
