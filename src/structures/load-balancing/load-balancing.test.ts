import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  CACHE,
  HASH,
  POLICIES,
  WEIGHTS,
  burst,
  create,
  fail,
  failLb,
  finish,
  home,
  layout,
  recover,
  request,
  scale,
  setPolicy,
  slow,
  userHash,
  type LBState,
} from './index';

const quiet = (s: LBState) => new Recorder(s, layout, false);
const loud = (s: LBState) => new Recorder(s, layout, true);
const USERS = [null, 'ana', 'ben', 'cai', 'dev', 'eve', 'fin'];
const WORDS = ['round', 'weighted', 'least', 'two', 'hash'];

/** A plain model, written without looking at the page's code paths. */
class Model {
  srv: { name: string; w: number; open: [number, string | null, number, number][]; up: boolean; ans: boolean; slow: boolean; score: number; cache: string[]; served: number }[] = [];
  next = 0;
  now = 0;
  seq = 0;
  seed = 1;
  active = 0;
  constructor(n: number, public pol: number) {
    for (let i = 0; i < n; i++) this.add();
  }
  add(): void {
    const i = this.srv.length;
    this.srv.push({ name: 'ABCD'[i], w: WEIGHTS[i], open: [], up: true, ans: true, slow: false, score: 0, cache: [], served: 0 });
  }
  rnd(n: number): number {
    this.seed = (this.seed * 75 + 74) % 65537;
    return this.seed % n;
  }
  choose(user: string | null) {
    const ups = this.srv.map((_, i) => i).filter((i) => this.srv[i].up);
    if (!ups.length) return null;
    const n = this.srv.length;
    if (this.pol === HASH && user !== null) {
      const h = userHash(user);
      for (let q = 0; q < n; q++) if (this.srv[(h + q) % n].up) return this.srv[(h + q) % n];
    }
    if (this.pol === 2) return ups.map((i) => this.srv[i]).reduce((a, b) => (b.open.length < a.open.length ? b : a));
    if (this.pol === 3) {
      if (ups.length === 1) return this.srv[ups[0]];
      const i = this.rnd(ups.length);
      let j = this.rnd(ups.length - 1);
      if (j >= i) j++;
      const [a, b] = [this.srv[ups[i]], this.srv[ups[j]]];
      return b.open.length < a.open.length ? b : a;
    }
    if (this.pol === 1) {
      for (const i of ups) this.srv[i].score += this.srv[i].w;
      const best = ups.reduce((a, b) => (this.srv[b].score > this.srv[a].score ? b : a));
      this.srv[best].score -= ups.reduce((t, i) => t + this.srv[i].w, 0);
      return this.srv[best];
    }
    while (!this.srv[this.next].up) this.next = (this.next + 1) % n;
    const x = this.srv[this.next];
    this.next = (this.next + 1) % n;
    return x;
  }
  place(r: [number, string | null, number]): void {
    const x = this.choose(r[1]);
    if (!x) return;
    x.open.push([r[0], r[1], r[2], this.now + r[2] * (x.slow ? 5 : 1)]);
    x.served++;
    if (r[1] !== null) {
      x.cache = x.cache.filter((u) => u !== r[1]);
      x.cache.push(r[1]);
      x.cache = x.cache.slice(-CACHE);
    }
  }
  request(user: string | null, work: number): void {
    this.now++;
    for (const x of this.srv) x.open = x.open.filter((r) => r[3] > this.now);
    this.place([++this.seq, user, work]);
  }
  burst(c: number, users: (string | null)[]): void {
    for (let j = 0; j < c; j++) this.request(users[j % users.length], 3);
  }
}

function sameAs(s: LBState, m: Model): void {
  expect(s.now).toBe(m.now);
  expect(s.policy).toBe(m.pol);
  expect(s.active).toBe(m.active);
  expect(s.servers.length).toBe(m.srv.length);
  s.servers.forEach((x, i) => {
    const y = m.srv[i];
    expect(x.open.map((r) => r.id)).toEqual(y.open.map((r) => r[0]));
    expect([x.healthy, x.answering, x.slow, x.served]).toEqual([y.up, y.ans, y.slow, y.served]);
    expect(x.sessions).toEqual(y.cache);
  });
}

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = f.scene.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|—/);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      expect(f.probe.text).toMatch(/^r\d+$/);
    }
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
      // Magenta is only ever on the request being followed.
      if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
    expect(edge).toEqual(corners(frames[0].scene));
  }
}

/** Run one random operation on the page and the model alike. */
function step(s: LBState, m: Model, rnd: () => number, rec: Recorder<LBState>): void {
  const x = rnd();
  const name = 'ABCD'[Math.floor(rnd() * s.servers.length)];
  const find = () => m.srv.find((y) => y.name === name)!;
  if (x < 0.45) {
    const user = USERS[Math.floor(rnd() * USERS.length)];
    const work = 1 + Math.floor(rnd() * 9);
    request(s, user, work, rec);
    m.request(user, work);
    expect(rec.counters.requests).toBe(1);
  } else if (x < 0.5) {
    const c = 2 + Math.floor(rnd() * 5);
    burst(s, c, rec);
    m.burst(c, [null]);
  } else if (x < 0.58) {
    finish(s, name, rec);
    find().open.shift();
  } else if (x < 0.64) {
    const y = find();
    const did = slow(s, name, rec);
    expect(did).toBe(!y.slow && y.ans);
    if (did) {
      y.slow = true;
      for (const r of y.open) r[3] = m.now + (r[3] - m.now) * 5;
      m.burst(6, [null]);
    }
  } else if (x < 0.71) {
    const y = find();
    const lostSessions = y.ans ? y.cache.length : 0;
    const lostReqs = y.ans ? y.open.length : 0;
    fail(s, name, rec);
    if (y.ans) {
      y.ans = false;
      y.up = false;
      const lost = y.open;
      y.open = [];
      y.cache = [];
      for (const r of lost) m.place([r[0], r[1], r[2]]);
    }
    expect(rec.counters.retries ?? 0).toBe(lostReqs);
    expect(rec.counters.lost ?? 0).toBe(lostSessions);
  } else if (x < 0.8) {
    recover(s, name, rec);
    Object.assign(find(), { ans: true, up: true, slow: false });
  } else if (x < 0.84) {
    scale(s, rec);
    if (m.srv.length < 4) {
      m.add();
      if (m.pol === HASH) {
        const n = m.srv.length;
        let lost = 0;
        m.srv.forEach((y, idx) => {
          const keep = y.cache.filter((u) => {
            const h = userHash(u);
            for (let q = 0; q < n; q++) if (m.srv[(h + q) % n].up) return (h + q) % n === idx;
            return false;
          });
          lost += y.cache.length - keep.length;
          y.cache = keep;
        });
        expect(rec.counters.lost ?? 0).toBe(lost);
      }
    }
  } else if (x < 0.92) {
    const p = Math.floor(rnd() * 5);
    setPolicy(s, WORDS[p], rec);
    m.pol = p;
    for (const y of m.srv) y.score = 0;
    m.burst(4, p === HASH ? ['ana', 'ben', 'ana', 'eve'] : [null]);
  } else {
    const inFlight = m.srv.reduce((t, y) => t + y.open.length, 0);
    failLb(s, rec);
    m.active = 1 - m.active;
    const lost = m.srv.flatMap((y) => y.open).sort((a, b) => a[0] - b[0]);
    for (const y of m.srv) y.open = [];
    for (const r of lost) m.place([r[0], r[1], r[2]]);
    expect(rec.counters.retries ?? 0).toBe(inFlight);
  }
}

describe('load balancing', () => {
  for (const servers of [3, 4]) {
    for (let pol = 0; pol < POLICIES.length; pol++) {
      it(`agrees with a plain model (${servers} servers, ${POLICIES[pol]})`, () => {
        const rnd = makeRng(servers * 17 + pol);
        const s = create(servers, pol);
        const m = new Model(servers, pol);
        for (let i = 0; i < 1500; i++) {
          step(s, m, rnd, quiet(s));
          sameAs(s, m);
          for (const x of s.servers) {
            expect(x.sessions.length).toBeLessThanOrEqual(CACHE);
            for (const r of x.open) expect(r.end).toBeGreaterThan(s.now);
          }
          expect(s.transit).toBeNull();
        }
      });
    }
  }

  it('counts the same with recording on and off, and draws clean frames', () => {
    for (const pol of [0, 1, 2, 3, 4]) {
      const a = create(3, pol);
      const b = create(3, pol);
      const ma = new Model(3, pol);
      const mb = new Model(3, pol);
      const ra = makeRng(99 + pol);
      const rb = makeRng(99 + pol);
      for (let i = 0; i < 150; i++) {
        const qa = quiet(a);
        const lb = loud(b);
        step(a, ma, ra, qa);
        step(b, mb, rb, lb);
        expect(lb.counters).toEqual(qa.counters);
        checkFrames(lb.frames);
        if (lb.frames.length) expect(lb.frames[lb.frames.length - 1].counters).toEqual(lb.counters);
      }
    }
  }, 60000);

  it('hash by user sends a user to h mod n, past down servers', () => {
    const s = create(3, HASH);
    expect(userHash('ana')).toBe(16);
    expect(home(s, 'ana')!.name).toBe('B');
    s.servers[1].healthy = false;
    expect(home(s, 'ana')!.name).toBe('C');
  });

  it('plays the tour with the outcomes the notes describe', () => {
    const s = def.create({ servers: 3, policy: 0 });
    const used = new Map<string, Set<string>>();
    const out: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      checkFrames(rec.frames);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      out.push(`${id}: ${s.servers.map((x) => `${x.name}${x.open.length}`).join(' ')} retries ${rec.counters.retries ?? 0} lost ${rec.counters.lost ?? 0}`);
    }
    expect(out).toEqual([
      'burst: A1 B1 C1 retries 0 lost 0',
      'slow: A1 B3 C1 retries 0 lost 0',
      'policy: A2 B2 C1 retries 0 lost 0',
      'policy: A1 B4 C1 retries 0 lost 0',
      'fail: A2 B4 C0 retries 1 lost 1',
      'scale: A2 B4 C0 D0 retries 0 lost 2',
    ]);
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
  });

  it('every listing fits the panel, and suggestions run for every parameter choice', () => {
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
    for (const servers of [3, 4]) {
      for (let pol = 0; pol < 5; pol++) {
        const s = def.create({ servers, policy: pol });
        const used = new Map<string, Set<string>>();
        for (let round = 0; round < 6; round++) {
          for (const op of def.ops) {
            const args = op.suggest?.(s) ?? [];
            expect(args.length).toBe(op.args.length);
            const rec = loud(s);
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
  }, 60000);
});
