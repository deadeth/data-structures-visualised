import { describe, expect, it, vi } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { sceneBounds } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  LETTERS,
  MENU,
  SCENE_W,
  concurrent,
  create,
  layout,
  order,
  replicate,
  resolve,
  setPolicy,
  write,
  type VVState,
  type Version,
} from './index';

const quiet = (s: VVState) => new Recorder(s, layout, false);
const loud = (s: VVState) => new Recorder(s, layout, true);
const lower = (r: number) => LETTERS[r].toLowerCase();

/**
 * A plain model of causality: each version's history is the set of writes it
 * has seen. Each replica remembers every version it has ever held. With
 * siblings, what it holds must be exactly the latest of those: the ones no
 * other has seen.
 */
class Model {
  hist = new Map<string, Set<string>>([['v0', new Set()]]);
  owner = new Map<string, number>();
  seen: Set<string>[] = [0, 1, 2].map(() => new Set(['v0']));

  wrote(v: Version, parents: Version[], r: number): void {
    const h = new Set<string>([v.name]);
    for (const p of parents) for (const e of this.hist.get(p.name)!) h.add(e);
    this.hist.set(v.name, h);
    this.owner.set(v.name, r);
    this.seen[r].add(v.name);
  }

  /** True when a has seen strictly less than b. */
  before(a: string, b: string): boolean {
    const ha = this.hist.get(a)!;
    const hb = this.hist.get(b)!;
    return ha.size < hb.size && [...ha].every((e) => hb.has(e));
  }

  latest(r: number): string[] {
    const all = [...this.seen[r]];
    return all.filter((n) => !all.some((m) => this.before(n, m))).sort();
  }

  reset(): void {
    this.seen = [0, 1, 2].map(() => new Set(['v0']));
  }
}

function verify(s: VVState, m: Model): void {
  expect(s.inbound).toBeNull();
  s.replicas.forEach((rep, r) => {
    const held = rep.versions.map((v) => v.name);
    expect(new Set(held).size).toBe(held.length);
    for (const v of rep.versions) {
      // Entry i counts exactly the writes by replica i that this version has seen.
      for (let i = 0; i < 3; i++) expect(v.vv[i]).toBe([...m.hist.get(v.name)!].filter((e) => m.owner.get(e) === i).length);
      for (const w of rep.versions) if (v !== w) expect(order(v, w)).toBe('concurrent');
    }
    expect(rep.versions.length).toBeLessThanOrEqual(3);
    if (s.policy === 'siblings') expect([...held].sort()).toEqual(m.latest(r));
    else expect(rep.versions.length).toBe(1);
  });
}

function boxes(scene: Scene) {
  return scene.nodes.map((n) => {
    const { w, h } = nodeSize(n);
    return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
  });
}

function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = f.scene.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    if (f.probe) expect(ids, `probe at ${f.probe.at}`).toContain(f.probe.at);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    for (const n of f.scene.nodes) {
      // Magenta is only ever on the version being followed.
      if (n.tone === 'key' || n.cells.some((c) => c.tone === 'key')) {
        expect(f.probe, `${n.id} is magenta with no probe`).toBeDefined();
        expect(n.id.split('-')[1]).toBe(f.probe!.text);
      }
    }
    const bs = boxes(f.scene);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) expect.fail(`${a.id} overlaps ${b.id}`);
      }
    }
    const bounds = sceneBounds(f.scene)!;
    expect(bounds.bw).toBeLessThanOrEqual(940);
    expect(bounds.bh).toBeLessThanOrEqual(440);
  }
}

/** One random step against the model. Returns false when the step was refused. */
function randomStep(s: VVState, m: Model, rnd: () => number, rec: (s: VVState) => Recorder<VVState>): void {
  const roll = rnd();
  const r = Math.floor(rnd() * 3);
  const y = (r + 1 + Math.floor(rnd() * 2)) % 3;
  const item = MENU[Math.floor(rnd() * MENU.length)];
  if (roll < 0.35) {
    const before = [...s.replicas[r].versions];
    const v = write(s, lower(r), item, rec(s));
    if (before.length > 1) return void expect(v).toBeNull();
    m.wrote(v!, before, r);
    expect(v!.cart.includes(item)).toBe(!before[0].cart.includes(item));
  } else if (roll < 0.75) {
    const v = s.replicas[r].versions;
    const w = s.replicas[y].versions;
    if (s.policy === 'lww') {
      // One version each: causal order first, then the later timestamp.
      const [a, b] = [v[0], w[0]];
      const want = m.before(a.name, b.name) || a === b ? b : m.before(b.name, a.name) ? a : a.ts !== b.ts ? (a.ts > b.ts ? a : b) : a.writer > b.writer ? a : b;
      replicate(s, lower(r), lower(y), rec(s));
      expect(s.replicas[y].versions).toEqual([want]);
    } else {
      replicate(s, lower(r), lower(y), rec(s));
      for (const n of m.seen[r]) m.seen[y].add(n);
    }
  } else if (roll < 0.9) {
    const sibs = [...s.replicas[r].versions];
    const v = resolve(s, lower(r), rec(s));
    if (sibs.length < 2) return void expect(v).toBeNull();
    m.wrote(v!, sibs, r);
    expect(v!.cart).toEqual(MENU.filter((i) => sibs.some((u) => u.cart.includes(i))));
  } else if (roll < 0.97) {
    if ([r, y].some((k) => s.replicas[k].versions.length > 1)) return;
    const bx = s.replicas[r].versions[0];
    const by = s.replicas[y].versions[0];
    const lostBefore = s.lost;
    concurrent(s, lower(r), item, lower(y), MENU[(MENU.indexOf(item) + 1) % MENU.length], rec(s));
    const vx = s.replicas[r].versions[0];
    m.wrote(vx, [bx], r);
    const name = `v${s.made}`;
    const vy = s.replicas[y].versions.find((v) => v.name === name) ?? { name, cart: [], vv: [], ts: 0, writer: y };
    m.wrote(vy as Version, [by], y);
    if (s.policy === 'siblings') {
      for (const n of m.seen[r]) m.seen[y].add(n);
      expect(s.replicas[y].versions.length).toBe(2);
    } else expect(s.lost).toBe(lostBefore + 1);
  } else {
    if (setPolicy(s, rnd() < 0.5 ? 'siblings' : 'lww', rec(s))) m.reset();
  }
}

// The model checks run thousands of operations; leave room on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

describe('version vectors', () => {
  for (const policy of ['siblings', 'lww'] as const) {
    it(`agrees with a model of who has seen which write (${policy})`, () => {
      const rnd = makeRng(policy === 'lww' ? 7 : 3);
      for (let round = 0; round < 4; round++) {
        const s = create(policy);
        const m = new Model();
        for (let i = 0; i < 1500; i++) {
          randomStep(s, m, rnd, quiet);
          verify(s, m);
        }
      }
    });
  }

  it('a write copies the vector it read, raises its own entry and replaces what it read', () => {
    const s = create();
    const v = write(s, 'b', 'tea', quiet(s))!;
    expect(v.vv).toEqual([0, 1, 0]);
    expect(v.cart).toEqual(['tea']);
    expect(s.replicas[1].versions).toEqual([v]);
    expect(s.replicas[0].versions[0].name).toBe('v0');
    // Writing the same item again takes it out.
    expect(write(s, 'b', 'tea', quiet(s))!.cart).toEqual([]);
  });

  it('replicating a newer version drops the older one after three comparisons', () => {
    const s = create();
    write(s, 'a', 'egg', quiet(s));
    const rec = loud(s);
    expect(replicate(s, 'a', 'b', rec)).toBe(1);
    expect(rec.counters.comparisons).toBe(3);
    expect(s.replicas[1].versions.map((v) => v.name)).toEqual(['v1']);
    expect(rec.frames.some((f) => /v0 happened before v1/.test(f.message))).toBe(true);
    checkFrames(rec.frames);
    // Sending it again changes nothing: every entry is level.
    const again = loud(s);
    expect(replicate(s, 'a', 'b', again)).toBe(0);
    expect(again.frames.some((f) => /already holds/.test(f.message))).toBe(true);
    checkFrames(again.frames);
  });

  it('concurrent writes become siblings, and a merge replaces both', () => {
    const s = create();
    const rec = loud(s);
    concurrent(s, 'b', 'jam', 'c', 'fig', rec);
    checkFrames(rec.frames);
    expect(s.replicas[2].versions.map((v) => v.name)).toEqual(['v2', 'v1']);
    expect(rec.counters.siblings).toBe(1);
    expect(rec.frames.some((f) => /they are concurrent/.test(f.message))).toBe(true);
    // A write on top of siblings is refused.
    expect(write(s, 'c', 'egg', quiet(s))).toBeNull();
    const merged = resolve(s, 'c', quiet(s))!;
    expect(merged.cart).toEqual(['jam', 'fig']);
    expect(merged.vv).toEqual([0, 1, 2]);
    expect(s.replicas[2].versions).toEqual([merged]);
    // The merge goes back to B and replaces jam there.
    replicate(s, 'c', 'b', quiet(s));
    expect(s.replicas[1].versions).toEqual([merged]);
  });

  it('last write wins drops one of two concurrent writes, and skew makes it the newer one', () => {
    const s = create('lww');
    const rec = loud(s);
    concurrent(s, 'b', 'jam', 'c', 'fig', rec);
    checkFrames(rec.frames);
    expect(s.replicas[2].versions.map((v) => v.cart)).toEqual([['jam']]);
    expect(rec.counters.lost).toBe(1);
    expect(rec.counters.siblings ?? 0).toBe(0);
    const lost = rec.frames.find((f) => /The newer write loses/.test(f.message));
    expect(lost?.compare).toMatchObject({ left: 'v1 t11', op: '>', right: 'v2 t9' });
    expect(rec.frames.some((f) => f.scene.nodes.some((n) => n.id === 'c-v2' && n.tone === 'bad'))).toBe(true);
    // Nothing to resolve.
    expect(resolve(s, 'c', quiet(s))).toBeNull();
  });

  it('refuses bad input without changing anything', () => {
    const s = create();
    const snap = JSON.stringify(s.replicas);
    for (const run of [
      (rec: Recorder<VVState>) => write(s, 'd', 'egg', rec),
      (rec: Recorder<VVState>) => write(s, 'a', 'cake', rec),
      (rec: Recorder<VVState>) => replicate(s, 'a', 'a', rec),
      (rec: Recorder<VVState>) => replicate(s, 'x', 'a', rec),
      (rec: Recorder<VVState>) => concurrent(s, 'a', 'egg', 'a', 'tea', rec),
      (rec: Recorder<VVState>) => resolve(s, 'a', rec),
      (rec: Recorder<VVState>) => setPolicy(s, 'siblings', rec),
      (rec: Recorder<VVState>) => setPolicy(s, 'random', rec),
    ]) {
      const rec = loud(s);
      run(rec);
      expect(rec.frames.length).toBeGreaterThan(0);
      checkFrames(rec.frames);
    }
    expect(JSON.stringify(s.replicas)).toBe(snap);
  });

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rndA = makeRng(11);
    const rndB = makeRng(11);
    const a = create();
    const b = create();
    const ma = new Model();
    const mb = new Model();
    let frames = 0;
    for (let i = 0; i < 300; i++) {
      const on = loud(a);
      const off = quiet(b);
      randomStep(a, ma, rndA, () => on);
      randomStep(b, mb, rndB, () => off);
      expect(on.counters).toEqual(off.counters);
      expect(JSON.stringify(a.replicas)).toBe(JSON.stringify(b.replicas));
      checkFrames(on.frames);
      frames += on.frames.length;
    }
    expect(frames).toBeGreaterThan(1000);
  });

  it('keeps the scene the same size whatever the replicas hold', () => {
    const sizes = new Set<string>();
    const s = create();
    const rnd = makeRng(5);
    const m = new Model();
    for (let i = 0; i < 200; i++) {
      randomStep(s, m, rnd, quiet);
      const b = sceneBounds(layout(s))!;
      sizes.add(`${Math.round(b.bw)}x${Math.round(b.bh)}`);
    }
    expect(sizes.size).toBe(1);
    expect(SCENE_W).toBeLessThanOrEqual(940);
  });

  it('seed and tour run through the definition and tell the story in order', () => {
    expect(def.id).toBe('version-vectors');
    const s = def.create({ policy: 0 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const rec = new Recorder(s, def.layout, recording);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(s.replicas.map((r) => r.versions.map((v) => `${v.name} ${v.cart.join(',')} ${v.vv.join('')}`))).toEqual([['v1 egg 100'], ['v1 egg 100'], ['v1 egg 100']]);

    const after: Version[][][] = [];
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(7);
    const recs = def.tour.map(([id, ...args]) => {
      const rec = run(id, args, true);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      after.push(s.replicas.map((r) => r.versions.map((v) => ({ ...v }))));
      return rec;
    });
    const last = (i: number) => recs[i].frames[recs[i].frames.length - 1].message;
    // 1. A writes tea. 2. B takes it cleanly: v2 dominates v1.
    expect(recs[0].counters).toEqual({ writes: 1 });
    expect(recs[1].counters).toEqual({ comparisons: 3 });
    expect(last(1)).toContain('B now holds v2');
    // 3. B and C write concurrently; C keeps both as siblings.
    expect(after[2][2]).toHaveLength(2);
    expect(recs[2].counters).toEqual({ writes: 2, comparisons: 3, siblings: 1 });
    expect(recs[2].frames.some((f) => /C now holds 2 siblings, v4 and v3/.test(f.message))).toBe(true);
    // 4. The merge: union of the carts, max of the vectors, plus one at C.
    expect(after[3][2]).toHaveLength(1);
    expect(after[3][2][0]).toMatchObject({ name: 'v5', cart: ['egg', 'tea', 'jam', 'fig'], vv: [2, 1, 2] });
    // 5. Switch to last write wins: back to v0. 6. The same writes: fig is lost although it came last.
    expect(last(4)).toContain('v0');
    expect(recs[5].counters).toEqual({ writes: 2, comparisons: 4, lost: 1 });
    expect(recs[5].frames.some((f) => /runs 3 ticks slow/.test(f.message) && /The newer write loses/.test(f.message))).toBe(true);
    expect(s.replicas[2].versions[0]).toMatchObject({ cart: ['jam'], writer: 1 });
    expect(def.status!(s)[0]).toEqual({ label: 'Policy', value: 'last write wins' });
  });

  it('every operation has a listing in both languages with the anchors its frames name, in lines that fit', () => {
    for (const param of def.params![0].options) {
      const s = def.create({ policy: param.value });
      const used = new Map<string, Set<string>>();
      const run = (id: string, args: (number | string)[], recording: boolean) => {
        const rec = new Recorder(s, def.layout, recording);
        def.ops.find((o) => o.id === id)!.run(s, args, rec);
        const set = used.get(id) ?? new Set<string>();
        used.set(id, set);
        for (const f of rec.frames) for (const a of f.lines ?? []) set.add(a);
        checkFrames(rec.frames);
      };
      for (const [id, ...args] of def.seedFor?.({ policy: param.value }) ?? def.seed) run(id, args, false);
      for (const [id, ...args] of def.tour) run(id, args, true);
      for (let round = 0; round < 40; round++) for (const op of def.ops) run(op.id, op.suggest!(s), true);
      expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
    }
    for (const { id: lang } of LANGS) {
      for (const op of def.ops) {
        const l = listing(def.source![lang], lang, op.code!);
        for (const line of l.lines) expect(line.length, line).toBeLessThanOrEqual(80);
      }
    }
  });

  it('suggests arguments the form accepts', () => {
    const s = def.create({ policy: 0 });
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    for (let i = 0; i < 80; i++) {
      for (const op of def.ops) {
        const args = op.suggest!(s);
        expect(args.length).toBe(op.args.length);
        for (const a of args) expect(String(a)).toMatch(/^[a-z]{1,12}$/);
        op.run(s, args, quiet(s));
      }
    }
  });
});
