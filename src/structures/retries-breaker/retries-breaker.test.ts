import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  BUDGET_CAP,
  CAP,
  CAPACITY,
  DOWN_FOR,
  EXPONENTIAL,
  FIXED,
  IMMEDIATE,
  JITTER,
  MAX_ATTEMPTS,
  MAX_TICK,
  NONE,
  OPEN_FOR,
  POLICIES,
  SHOWN,
  THRESHOLD,
  budget,
  call,
  create,
  layout,
  nextRandom,
  reset,
  setDownstream,
  storm,
  tick,
  trip,
  type Health,
  type RBState,
} from './index';

const quiet = (s: RBState) => new Recorder(s, layout, false);
const loud = (s: RBState) => new Recorder(s, layout, true);

/**
 * The simplest correct model of the same rules, written plainly: a list of
 * attempts per client and a load per tick. The page must agree with it.
 */
class Model {
  now = 0;
  health: Health = 'healthy';
  calm = 0;
  load = new Map<number, number>();
  a: number;
  cl: { state: string; fails: number[]; until: number; chain: { att: number; due: number | null; p: number; g: boolean; dl: number | null } | null; tokens: number | null; dlTicks: number; sent: number }[];
  constructor(readonly policy: number, readonly on: boolean) {
    this.a = 16;
    this.cl = [0, 1, 2, 3].map(() => ({ state: 'closed', fails: [], until: 0, chain: null, tokens: null, dlTicks: 0, sent: -1 }));
  }
  rand(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  open(c: Model['cl'][number]) {
    c.state = 'open';
    c.until = this.now + OPEN_FOR;
    c.fails = [];
  }
  send(i: number) {
    const c = this.cl[i];
    const ch = c.chain!;
    ch.att++;
    ch.due = null;
    c.sent = this.now;
    const g = ch.g && this.on;
    if (g && c.state === 'open') return void (c.chain = null);
    const n = (this.load.get(this.now) ?? 0) + 1;
    this.load.set(this.now, n);
    const ok = this.health === 'healthy' || (this.health === 'recovering' && n <= CAPACITY);
    if (ok) {
      if (g && c.state === 'half-open') {
        c.state = 'closed';
        c.fails = [];
      }
      c.chain = null;
      return;
    }
    if (g) {
      if (c.state === 'half-open') this.open(c);
      else {
        c.fails = [...c.fails.filter((t) => t > this.now - 10), this.now];
        if (c.fails.length >= THRESHOLD) this.open(c);
      }
    }
    if (ch.p === NONE || ch.att >= MAX_ATTEMPTS) return void (c.chain = null);
    let d = ch.p === IMMEDIATE ? 1 : ch.p === FIXED ? 2 : Math.min(CAP, 2 * 2 ** (ch.att - 1));
    if (ch.p === JITTER) d = 1 + Math.floor(this.rand() * d);
    if (ch.dl !== null && this.now + d > ch.dl) return void (c.chain = null);
    if (c.tokens !== null) {
      if (c.tokens < 10) return void (c.chain = null);
      c.tokens -= 10;
    }
    ch.due = this.now + d;
  }
  call(i: number, p = this.policy, g = true) {
    const c = this.cl[i];
    c.chain = { att: 0, due: this.now, p, g, dl: c.dlTicks ? this.now + c.dlTicks : null };
    if (c.tokens !== null) c.tokens = Math.min(BUDGET_CAP, c.tokens + 2);
    this.send(i);
  }
  advance() {
    if (this.health === 'recovering') {
      this.calm = (this.load.get(this.now) ?? 0) <= CAPACITY ? this.calm + 1 : 0;
      if (this.calm >= 5) this.set('healthy');
    }
    this.now++;
    for (const c of this.cl) if (c.state === 'open' && this.now >= c.until) c.state = 'half-open';
  }
  fire() {
    this.cl.forEach((c, i) => c.chain?.due === this.now && this.send(i));
  }
  tick() {
    this.advance();
    this.fire();
  }
  set(h: Health) {
    this.health = h;
    this.calm = 0;
  }
}

function sameAs(s: RBState, m: Model): void {
  expect(s.now).toBe(m.now);
  expect(s.health).toBe(m.health);
  expect(s.calm).toBe(m.calm);
  s.clients.forEach((c, i) => {
    const x = m.cl[i];
    expect(c.state).toBe(x.state);
    if (c.state !== 'closed') expect(c.openUntil).toBe(x.until);
    expect(c.failures).toEqual(x.fails);
    expect(c.chain ? [c.chain.attempt, c.chain.due, c.chain.deadline] : null).toEqual(x.chain ? [x.chain.att, x.chain.due, x.chain.dl] : null);
    expect(c.tokens).toBe(x.tokens);
  });
  for (let t = s.viewFrom; t <= s.now; t++) expect(s.load[t] ?? 0).toBe(m.load.get(t) ?? 0);
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, probes on real nodes, a code line on every frame, no overlaps, nothing off the scene, magenta only on the attempt. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) {
      expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
      expect(f.probe.text).toMatch(/^[ABCD]\d$/);
    }
    if (f.compare) expect(f.probe, 'a comparison follows an attempt').toBeDefined();
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—|Infinity/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    for (const n of f.scene.nodes) {
      if (n.shape === 'tag') expect(n.tone).toBeUndefined();
      if (n.tone === 'key') expect(n.id.startsWith('m')).toBe(true);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    expect(f.scene.nodes.filter((n) => n.tone === 'key').length).toBeLessThanOrEqual(1);
    expect(edge).toEqual(corners(frames[0].scene));
    expect(edge.x2 - edge.x1).toBeLessThanOrEqual(940);
  }
}

const HEALTH_OP: Record<string, Health> = { fail: 'failing', slow: 'slow', recover: 'recovering' };

describe('retries, backoff and circuit breakers', () => {
  it('matches mulberry32 as the listings implement it', () => {
    const s = create();
    s.rng = 1;
    expect([nextRandom(s), nextRandom(s), nextRandom(s)].map((x) => x.toFixed(6))).toEqual(['0.627074', '0.002736', '0.527447']);
  });

  for (const policy of [NONE, IMMEDIATE, FIXED, EXPONENTIAL, JITTER]) {
    for (const on of [true, false]) {
      it(`agrees with a plain model under random operations (${POLICIES[policy]}, breaker ${on ? 'on' : 'off'})`, () => {
        const rnd = makeRng(policy * 10 + (on ? 1 : 0) + 3);
        const s = create(policy, on);
        let m = new Model(policy, on);
        for (let i = 0; i < 600; i++) {
          const roll = rnd();
          const rec = quiet(s);
          if (s.now > 900) {
            reset(s, rec);
            m = new Model(policy, on);
          } else if (roll < 0.35) {
            const idx = Math.floor(rnd() * 4);
            const c = s.clients[idx];
            const accepted = !c.chain && c.lastSent < s.now;
            const r = call(s, c.name.toLowerCase(), rec);
            expect(r !== null).toBe(accepted);
            if (accepted) m.call(idx);
          } else if (roll < 0.6) {
            const k = 1 + Math.floor(rnd() * 4);
            tick(s, k, rec);
            for (let j = 0; j < k; j++) m.tick();
          } else if (roll < 0.72) {
            const key = ['fail', 'slow', 'recover'][Math.floor(rnd() * 3)];
            const h = HEALTH_OP[key];
            const changes = s.health !== h && !(h === 'recovering' && s.health === 'healthy');
            setDownstream(s, h, rec);
            if (changes) m.set(h);
          } else if (roll < 0.8) {
            const p = Math.floor(rnd() * 5);
            storm(s, POLICIES[p], rec);
            for (const c of m.cl) c.chain = null;
            m.tick();
            const start = m.now;
            m.set('failing');
            for (let j = 0; j < 4; j++) m.call(j, p, false);
            while (m.cl.some((c) => c.chain)) {
              m.advance();
              if (m.now === start + DOWN_FOR) m.set('recovering');
              m.fire();
            }
            expect(s.clients.every((c) => !c.chain)).toBe(true);
          } else if (roll < 0.88) {
            const idx = Math.floor(rnd() * 4);
            const c = s.clients[idx];
            const accepted = on && !c.chain;
            trip(s, c.name, rec);
            if (accepted) {
              const x = m.cl[idx];
              m.tick();
              if (x.state === 'closed' && (m.health === 'healthy' || m.health === 'recovering')) m.set('failing');
              while (x.state === 'closed') {
                m.call(idx, NONE);
                if (x.state === 'closed') m.tick();
              }
              m.tick();
              if (x.state === 'open') {
                m.call(idx, NONE);
                while (x.state === 'open') m.tick();
              }
              m.call(idx, NONE);
              // A trip always ends with a probe, which decides.
              expect(['closed', 'open']).toContain(c.state);
            }
          } else if (roll < 0.97) {
            const d = [0, 3, 4, 6][Math.floor(rnd() * 4)];
            const idx = s.clients.findIndex((c) => !c.chain && c.lastSent < s.now);
            budget(s, d, rec);
            if (d === 0) for (const c of m.cl) [c.dlTicks, c.tokens] = [0, null];
            else if (idx >= 0) {
              for (const c of m.cl) [c.dlTicks, c.tokens] = [d, BUDGET_CAP];
              if (m.health === 'healthy' || m.health === 'recovering') m.set('slow');
              m.call(idx);
              while (m.cl[idx].chain) m.tick();
            }
          }
          sameAs(s, m);
          // Tokens stay in range; every chain has at most MAX_ATTEMPTS attempts.
          for (const c of s.clients) {
            if (c.tokens !== null) expect(c.tokens).toBeGreaterThanOrEqual(0);
            if (c.tokens !== null) expect(c.tokens).toBeLessThanOrEqual(BUDGET_CAP);
            if (c.chain) expect(c.chain.attempt).toBeLessThan(MAX_ATTEMPTS);
            if (c.chain) expect(c.chain.due!).toBeLessThanOrEqual(s.viewFrom + SHOWN - 1);
          }
          expect(s.now).toBeGreaterThanOrEqual(s.viewFrom);
          expect(s.now).toBeLessThanOrEqual(s.viewFrom + SHOWN - 1);
        }
      });
    }
  }

  it('immediate retries hammer the failing service; jitter spreads the same calls', () => {
    const runStorm = (p: string) => {
      const s = create();
      const rec = loud(s);
      storm(s, p, rec);
      checkFrames(rec.frames);
      const start = s.viewFrom;
      const loads = Array.from({ length: s.now - start + 1 }, (_, i) => s.load[start + i] ?? 0);
      return { s, rec, loads, start };
    };
    const imm = runStorm('immediate');
    expect(imm.loads.slice(0, 4)).toEqual([4, 4, 4, 4]);
    expect(imm.rec.counters.reached).toBe(16);
    const exp = runStorm('exponential');
    // Waves of 4 at 0, 2 and 6 ticks: the one at 6 lands on the recovering service and half is shed.
    expect(exp.loads.slice(0, 7)).toEqual([4, 0, 4, 0, 0, 0, 4]);
    expect(exp.s.shed[exp.start + 6]).toBe(2);
    const jit = runStorm('jitter');
    const afterFirst = jit.loads.slice(DOWN_FOR);
    expect(Math.max(...afterFirst)).toBeLessThanOrEqual(CAPACITY);
    expect(Object.values(jit.s.shed).reduce((a, b) => a + b, 0)).toBe(0);
    // Every storm reports its numbers in its last frame.
    expect(jit.rec.frames[jit.rec.frames.length - 1].message).toMatch(/Storm over at tick \d+/);
  });

  it('a breaker opens at the threshold, fails fast, goes half-open and closes on a good probe', () => {
    const s = create();
    const rec = loud(s);
    trip(s, 'a', rec);
    checkFrames(rec.frames);
    const cmp = rec.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(cmp.map((c) => c.left)).toEqual(expect.arrayContaining(['A failures 1', 'A failures 2', 'A failures 3']));
    expect(cmp.find((c) => c.left === 'A failures 3')).toMatchObject({ op: '≥', right: `threshold ${THRESHOLD}`, verdict: 'open the breaker' });
    expect(rec.counters.fast).toBe(1);
    expect(s.clients[0].marks.map((m) => m.result)).toEqual(['503', '503', '503', 'fast', '503']);
    expect(s.clients[0].state).toBe('open');
    // Now the downstream comes back; the next trip ends with a probe that closes the breaker.
    setDownstream(s, 'recovering', quiet(s));
    const again = loud(s);
    trip(s, 'a', again);
    checkFrames(again.frames);
    expect(s.clients[0].state).toBe('closed');
    expect(again.frames[again.frames.length - 1].message).toMatch(/closed, open, half-open and closed again/);
  });

  it('a deadline stops a retry that would come too late', () => {
    const s = create();
    tick(s, 2, quiet(s));
    const rec = loud(s);
    budget(s, 3, rec);
    checkFrames(rec.frames);
    const cut = rec.frames.find((f) => f.compare?.verdict === 'stop now');
    expect(cut).toBeDefined();
    expect(cut!.lines).toContain('deadline');
    expect(rec.frames.some((f) => f.lines!.includes('cut'))).toBe(true);
    expect(s.clients[0].chain).toBeNull();
  });

  it('a retry budget refuses once its tokens are spent', () => {
    const s = create(EXPONENTIAL, false);
    tick(s, 1, quiet(s));
    budget(s, 20, quiet(s));
    // 2.0 saved (the earned 0.2 does not fit over the cap) pays for 2 retries; the third is refused.
    expect(s.clients[0].marks.length).toBe(3);
    expect(s.clients[0].tokens).toBe(0);
  });

  it('the breaker off: trip explains and changes nothing', () => {
    const s = create(JITTER, false);
    const before = JSON.stringify(s);
    const rec = loud(s);
    trip(s, 'b', rec);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].lines).toEqual(['no_breaker']);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('refusals change nothing', () => {
    const s = create();
    call(s, 'a', quiet(s));
    const before = JSON.stringify(s);
    for (const [f, arg] of [[call, 'a'], [call, 'z'], [storm, 'often'], [trip, 'q'], [budget, 99]] as const) {
      const rec = loud(s);
      (f as (s: RBState, a: unknown, r: Recorder<RBState>) => void)(s, arg, rec);
      expect(rec.frames.length).toBe(1);
      checkFrames(rec.frames);
      expect(JSON.stringify(s)).toBe(before);
    }
    while (s.now + 9 <= MAX_TICK) tick(s, 9, quiet(s));
    const rec = loud(s);
    expect(tick(s, 9, rec)).toBe(false);
    expect(rec.frames[0].message).toMatch(/Sorry/);
  });

  it('counts the same with recording on and off', () => {
    const rnd = makeRng(77);
    const a = create();
    const b = create();
    for (let i = 0; i < 150; i++) {
      const op = def.ops[Math.floor(rnd() * (def.ops.length - 1))];
      const args = op.id === 'call' || op.id === 'trip' ? ['abcd'[Math.floor(rnd() * 4)]] : op.id === 'tick' ? [1 + Math.floor(rnd() * 3)] : op.id === 'storm' ? [POLICIES[Math.floor(rnd() * 5)]] : op.id === 'budget' ? [[0, 3, 6][Math.floor(rnd() * 3)]] : [];
      const on = loud(a);
      const off = quiet(b);
      op.run(a, args, on);
      op.run(b, args, off);
      expect(on.counters).toEqual(off.counters);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(a).toEqual(b);
      if (a.now > 900) {
        reset(a, quiet(a));
        reset(b, quiet(b));
      }
    }
  });

  it('seed and tour run through the definition and show the failures', () => {
    const params = Object.fromEntries(def.params!.map((p) => [p.id, p.default]));
    expect(params).toEqual({ policy: JITTER, breaker: 1 });
    const s = def.create(params);
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const rec = new Recorder(s, def.layout, recording);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(s.now).toBe(2);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    const used = new Map<string, Set<string>>();
    const ends: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      checkFrames(rec.frames);
      ends.push(rec.frames[rec.frames.length - 1].message);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
    }
    expect(ends[0]).toMatch(/2 succeeded and 2 gave up/);
    expect(ends[1]).toMatch(/2 requests were shed/);
    expect(ends[2]).toMatch(/0 requests were shed/);
    expect(ends[3]).toMatch(/open again/);
    expect(ends[5]).toMatch(/closed again/);
    expect(used.get('budget')!.has('cut')).toBe(true);
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

  it('suggestions are accepted for every parameter choice and name real code lines', () => {
    for (const p of def.params![0].options) {
      for (const b of def.params![1].options) {
        const s = def.create({ policy: p.value, breaker: b.value });
        const used = new Map<string, Set<string>>();
        for (let round = 0; round < 8; round++) {
          for (const op of def.ops) {
            if (op.id === 'reset' && round !== 7) continue;
            const args = op.suggest?.(s) ?? [];
            expect(args.length).toBe(op.args.length);
            const rec = new Recorder(s, def.layout, true);
            op.run(s, args, rec);
            checkFrames(rec.frames);
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
