import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  START_BALANCE,
  WINDOW,
  concurrent,
  crash,
  create,
  expire,
  fingerprint,
  layout,
  loseRequest,
  loseResponse,
  mismatch,
  pay,
  retry,
  retryNewKey,
  setMode,
  type IdemState,
} from './index';

const quiet = (s: IdemState) => new Recorder(s, layout, false);
const loud = (s: IdemState) => new Recorder(s, layout, true);

function check(s: IdemState): void {
  // Plain checks: this runs after every one of thousands of operations.
  const fail = (m: string) => {
    throw new Error(m);
  };
  // Nothing is left half done between operations.
  if (s.keys.some((k) => k.pending) || s.payments.some((p) => p.pending)) fail('an uncommitted row survived');
  if (!s.serverUp) fail('the server is still down');
  // One row per key: the unique index.
  if (new Set(s.keys.map((k) => k.key)).size !== s.keys.length) fail('two rows share a key');
  const byId = new Map(s.payments.map((p) => [p.id, p]));
  for (const k of s.keys) {
    if (k.status !== 'done') fail(`${k.key} is ${k.status}`);
    const p = byId.get(Number(k.response.replace('201 p', '')));
    if (!p) fail(`no payment for ${k.key}`);
    else if (fingerprint(p.amount) !== k.hash) fail(`${k.key} hash does not match its payment`);
  }
  // The balance is exactly what the committed payments took.
  if (s.balance !== START_BALANCE - s.payments.reduce((a, p) => a + p.amount, 0)) fail('balance');
  if (s.applied !== s.payments.length) fail('applied');
  if (s.doubles !== s.payments.filter((p) => p.double).length) fail('doubles flag');
  const perOrder = new Map<number, number>();
  for (const p of s.payments) perOrder.set(p.order, (perOrder.get(p.order) ?? 0) + 1);
  let extra = 0;
  for (const [o, n] of perOrder) {
    if (s.charged[o] !== n) fail(`order ${o}`);
    extra += n - 1;
  }
  if (s.doubles !== extra) fail('doubles count');
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    for (const e of f.scene.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    if (f.probe) expect(ids.has(f.probe.at), `probe at ${f.probe.at}: ${f.message}`).toBe(true);
    if (f.compare) expect(f.probe).toBeDefined();
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|\[object/);
    expect(f.lines?.length ?? 0, f.message).toBeGreaterThan(0);
    const edge = corners(f.scene);
    expect(edge.x2 - edge.x1).toBeLessThanOrEqual(940);
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
      // Magenta only on the key cell of the row that holds the followed request's key.
      expect(n.tone).not.toBe('key');
      n.cells.forEach((c, i) => {
        if (c.tone === 'key') {
          expect(i).toBe(0);
          expect(f.probe?.text.startsWith(`${c.text} `)).toBe(true);
        }
      });
    }
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

type Op = { id: string; args: (number | string)[] };

function randomOp(rnd: () => number, s: IdemState): Op {
  const amount = 1 + Math.floor(rnd() * 500);
  const r = rnd();
  if (r < 0.05) return { id: 'server', args: [rnd() < 0.5 ? 'keys' : 'none'] };
  if (r < 0.2) return { id: 'pay', args: [amount] };
  if (r < 0.35) return { id: 'lose_response', args: [amount] };
  if (r < 0.45) return { id: 'lose_request', args: [amount] };
  if (r < 0.6) return { id: 'retry', args: [] };
  if (r < 0.67) return { id: 'retry_new_key', args: [amount] };
  if (r < 0.77) return { id: 'concurrent', args: [amount] };
  if (r < 0.85) return { id: 'mismatch', args: [rnd() < 0.2 && s.last ? s.last.amount : amount] };
  if (r < 0.95) return { id: 'crash', args: [rnd() < 0.5 ? 'before' : 'after', amount] };
  return { id: 'expire', args: [amount] };
}

function run(s: IdemState, op: Op, recording: boolean): Recorder<IdemState> {
  const rec = new Recorder(s, layout, recording);
  def.ops.find((o) => o.id === op.id)!.run(s, op.args, rec);
  return rec;
}

/** What each operation must do to the number of payments, worked out from the state before it. */
function expected(s: IdemState, op: Op): { applied: number; doubles: number; replays: number } {
  const keys = s.mode === 'keys';
  const charged = (o: number) => (s.charged[o] ?? 0) > 0;
  switch (op.id) {
    case 'pay':
    case 'lose_request':
      return { applied: 1, doubles: 0, replays: 0 };
    case 'lose_response':
      return keys ? { applied: 1, doubles: 0, replays: 1 } : { applied: 2, doubles: 1, replays: 0 };
    case 'crash':
      if (op.args[0] === 'before') return { applied: 1, doubles: 0, replays: 0 };
      return keys ? { applied: 1, doubles: 0, replays: 1 } : { applied: 2, doubles: 1, replays: 0 };
    case 'retry_new_key':
      return { applied: 2, doubles: 1, replays: 0 };
    case 'concurrent':
      return keys ? { applied: 1, doubles: 0, replays: 1 } : { applied: 2, doubles: 1, replays: 0 };
    case 'expire':
      // The key is always older than the window by the time the late retry arrives.
      return { applied: 2, doubles: 1, replays: 0 };
    case 'retry': {
      const r = s.last!;
      const row = s.keys.find((k) => k.key === r.key);
      // A row under this key with another body: left by a key reused after it was pruned. Rejected.
      if (keys && row) return { applied: 0, doubles: 0, replays: row.hash === fingerprint(r.amount) ? 1 : 0 };
      return { applied: 1, doubles: charged(r.order) ? 1 : 0, replays: 0 };
    }
    case 'mismatch': {
      const r = s.last!;
      const row = s.keys.find((k) => k.key === r.key);
      if (keys && row) return { applied: 0, doubles: 0, replays: row.hash === fingerprint(Number(op.args[0])) ? 1 : 0 };
      return { applied: 1, doubles: 0, replays: 0 };
    }
    default:
      return { applied: 0, doubles: 0, replays: 0 };
  }
}

describe('idempotency keys', () => {
  for (const mode of ['keys', 'none'] as const) {
    it(`every operation charges exactly what the model says (starting ${mode})`, () => {
      const rnd = makeRng(mode === 'keys' ? 11 : 12);
      const s = create(mode);
      pay(s, 60, quiet(s));
      for (let i = 0; i < 4000; i++) {
        const op = randomOp(rnd, s);
        const want = expected(s, op);
        const before = { applied: s.applied, doubles: s.doubles, replays: s.replays, received: s.received };
        const rec = run(s, op, false);
        expect({ applied: s.applied - before.applied, doubles: s.doubles - before.doubles, replays: s.replays - before.replays }, `${op.id} ${op.args}`).toEqual(want);
        expect(rec.counters.applied ?? 0).toBe(want.applied);
        expect(rec.counters.doubles ?? 0).toBe(want.doubles);
        expect(rec.counters.replays ?? 0).toBe(want.replays);
        expect(rec.counters.received ?? 0).toBe(s.received - before.received);
        check(s);
      }
    });
  }

  it('with keys and same-key retries inside the window, no order is ever charged twice', () => {
    const rnd = makeRng(5);
    const s = create('keys');
    for (let i = 0; i < 3000; i++) {
      const amount = 1 + Math.floor(rnd() * 500);
      const r = rnd();
      if (r < 0.25) pay(s, amount, quiet(s));
      else if (r < 0.5) loseResponse(s, amount, quiet(s));
      else if (r < 0.6) loseRequest(s, amount, quiet(s));
      else if (r < 0.75) retry(s, quiet(s));
      else if (r < 0.85) concurrent(s, amount, quiet(s));
      else crash(s, rnd() < 0.5 ? 'before' : 'after', amount, quiet(s));
      check(s);
    }
    expect(s.doubles).toBe(0);
    expect(Object.values(s.charged).every((n) => n === 1)).toBe(true);
    expect(s.replays).toBeGreaterThan(500);
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(77);
    const a = create('keys');
    const b = create('keys');
    pay(a, 60, quiet(a));
    pay(b, 60, quiet(b));
    for (let i = 0; i < 400; i++) {
      const op = randomOp(rnd, a);
      const on = run(a, op, true);
      const off = run(b, op, false);
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('a lost response without keys charges twice; with keys the retry is a replay', () => {
    const s = create('none');
    pay(s, 60, quiet(s));
    const rec = loud(s);
    loseResponse(s, 40, rec);
    checkFrames(rec.frames);
    expect(rec.counters).toMatchObject({ applied: 2, doubles: 1, received: 2 });
    expect(s.balance).toBe(START_BALANCE - 60 - 80);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toMatch(/charged 2 times/);
    expect(last.scene.nodes.find((n) => n.id === 'pr-3')!.tone).toBe('bad');

    setMode(s, 'keys', quiet(s));
    const again = loud(s);
    loseResponse(s, 25, again);
    checkFrames(again.frames);
    expect(again.counters).toMatchObject({ applied: 1, replays: 1, received: 2 });
    expect(again.counters.doubles).toBeUndefined();
    const compares = again.frames.filter((f) => f.compare).map((f) => f.compare!);
    expect(compares.map((c) => c.verdict)).toEqual(['new key, insert the row', 'key exists, read the row', 'same request, replay']);
    expect(compares[2]).toEqual({ left: `h(£25) = ${fingerprint(25)}`, op: '=', right: `stored ${fingerprint(25)}`, verdict: 'same request, replay' });
    const lines = again.frames.map((f) => f.lines!.join(','));
    expect(lines).toContain('hash');
    expect(lines).toContain('commit');
    expect(lines).toContain('replay');
    expect(lines).toContain('retry,send');
  });

  it('the key and the payment commit together: a crash before commit leaves neither, after commit leaves both', () => {
    const s = create('keys');
    const before = loud(s);
    crash(s, 'before', 50, before);
    checkFrames(before.frames);
    // The rolled-back attempt took p1 from the sequence; the retry is p2.
    expect(s.payments.map((p) => p.id)).toEqual([2]);
    expect(s.keys.map((k) => k.response)).toEqual(['201 p2']);
    expect(before.counters).toMatchObject({ applied: 1, received: 2 });
    expect(before.frames.some((f) => /rolls the transaction back/.test(f.message))).toBe(true);

    const after = loud(s);
    crash(s, 'after', 70, after);
    checkFrames(after.frames);
    expect(after.counters).toMatchObject({ applied: 1, replays: 1, received: 2 });
    expect(after.frames.some((f) => f.scene.nodes.find((n) => n.id === 'server')!.tone === 'bad')).toBe(true);
    check(s);

    const plain = create('none');
    crash(plain, 'after', 70, quiet(plain));
    expect(plain.doubles).toBe(1);
  });

  it('two copies at once: the second waits on the unique index, then replays', () => {
    const s = create('keys');
    const rec = loud(s);
    concurrent(s, 30, rec);
    checkFrames(rec.frames);
    expect(rec.counters).toMatchObject({ received: 2, applied: 1, replays: 1 });
    const verdicts = rec.frames.filter((f) => f.compare).map((f) => f.compare!.verdict);
    expect(verdicts).toEqual(['copy 1 inserts the row', 'copy 2 waits', 'copy 2 wakes, key exists', 'same request, replay']);
    expect(rec.frames.some((f) => f.lines!.includes('wait'))).toBe(true);
    const last = rec.frames[rec.frames.length - 1].message;
    expect(last).toMatch(/409 Conflict/);

    const plain = create('none');
    concurrent(plain, 30, quiet(plain));
    expect(plain.doubles).toBe(1);
  });

  it('the same key with a different amount is rejected with 422 and changes nothing', () => {
    const s = create('keys');
    pay(s, 60, quiet(s));
    const snapshot = JSON.stringify({ k: s.keys, p: s.payments, b: s.balance });
    const rec = loud(s);
    mismatch(s, 90, rec);
    checkFrames(rec.frames);
    expect(JSON.stringify({ k: s.keys, p: s.payments, b: s.balance })).toBe(snapshot);
    const cmp = rec.frames.filter((f) => f.compare).pop()!.compare!;
    expect(cmp.op).toBe('≠');
    expect(cmp.verdict).toBe('different body, reject');
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/422/);
    // The client's last request is still the real one.
    expect(s.last!.amount).toBe(60);
  });

  it('a fresh key on retry charges twice even with keys on', () => {
    const s = create('keys');
    const rec = loud(s);
    retryNewKey(s, 15, rec);
    checkFrames(rec.frames);
    expect(rec.counters).toMatchObject({ applied: 2, doubles: 1 });
    expect(s.keys.map((k) => k.key)).toEqual(['k1', 'k2']);
    expect(rec.frames.some((f) => f.lines!.includes('fresh_key'))).toBe(true);
  });

  it('a retry later than the window is treated as new', () => {
    const s = create('keys');
    pay(s, 60, quiet(s));
    const rec = loud(s);
    expire(s, 45, rec);
    checkFrames(rec.frames);
    expect(rec.counters).toMatchObject({ applied: 2, doubles: 1 });
    const age = rec.frames.find((f) => f.compare?.verdict === 'drop it')!.compare!;
    expect(age).toMatchObject({ op: '≥', right: `window ${WINDOW} h`, verdict: 'drop it' });
    // The pruned key was written again by the late retry, so it is the only row left.
    expect(s.keys.map((k) => k.key)).toEqual(['k2']);
    expect(rec.frames[rec.frames.length - 1].message).toMatch(/longer than the longest a client will keep retrying/);
  });

  it('rejects bad input politely', () => {
    const s = create('keys');
    for (const [fn, label] of [
      [(r: Recorder<IdemState>) => pay(s, 0, r), 'pay 0'],
      [(r: Recorder<IdemState>) => pay(s, 501, r), 'pay 501'],
      [(r: Recorder<IdemState>) => retry(s, r), 'retry with nothing sent'],
      [(r: Recorder<IdemState>) => mismatch(s, 20, r), 'mismatch with nothing sent'],
      [(r: Recorder<IdemState>) => crash(s, 'during', 20, r), 'crash during'],
      [(r: Recorder<IdemState>) => setMode(s, 'maybe', r), 'mode maybe'],
    ] as const) {
      const rec = loud(s);
      fn(rec);
      expect(rec.frames.length, label).toBe(1);
      expect(rec.frames[0].lines!.length).toBeGreaterThan(0);
    }
    expect(s.payments.length).toBe(0);
  });

  it('seed and tour run through the definition and show the failures, not only the happy path', () => {
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    const params = Object.fromEntries(def.params!.map((p) => [p.id, p.default]));
    const s = def.create(params);
    expect(s.mode).toBe('keys');
    for (const [id, ...args] of def.seed) run(s, { id, args }, false);
    const used = new Map<string, Set<string>>();
    const story: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(s, { id, args }, true);
      checkFrames(rec.frames);
      check(s);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      story.push(`${id}: +${rec.counters.applied ?? 0} applied, +${rec.counters.replays ?? 0} replays, +${rec.counters.doubles ?? 0} doubles`);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
    }
    expect(story).toEqual([
      'server: +0 applied, +0 replays, +0 doubles',
      'lose_response: +2 applied, +0 replays, +1 doubles',
      'server: +0 applied, +0 replays, +0 doubles',
      'lose_response: +1 applied, +1 replays, +0 doubles',
      'concurrent: +1 applied, +1 replays, +0 doubles',
      'mismatch: +0 applied, +0 replays, +0 doubles',
      'retry_new_key: +2 applied, +0 replays, +1 doubles',
    ]);
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

  it('suggestions are accepted by the form for both servers, and their frames name real code lines', () => {
    for (const opt of def.params![0].options) {
      const s = def.create({ server: opt.value });
      for (const [id, ...args] of def.seedFor?.({ server: opt.value }) ?? def.seed) run(s, { id, args }, false);
      const used = new Map<string, Set<string>>();
      for (let round = 0; round < 12; round++) {
        for (const op of def.ops) {
          const args = op.suggest?.(s) ?? [];
          expect(args.length).toBe(op.args.length);
          op.args.forEach((a, i) => {
            if (a.kind === 'int') {
              expect(Number.isInteger(args[i])).toBe(true);
              expect(args[i] as number).toBeGreaterThanOrEqual(a.min!);
              expect(args[i] as number).toBeLessThanOrEqual(a.max!);
            }
          });
          const rec = new Recorder(s, def.layout, true);
          op.run(s, args, rec);
          expect(rec.frames.length).toBeGreaterThan(0);
          checkFrames(rec.frames);
          check(s);
          const set = used.get(op.id) ?? new Set<string>();
          used.set(op.id, set);
          for (const f of rec.frames) for (const a of f.lines!) set.add(a);
        }
      }
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
  });
});
