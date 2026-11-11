import { describe, expect, it } from 'vitest';
import { LANGS, codeProblems, listing } from '../../core/code';
import { LABEL_CHAR_W } from '../../core/fit';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  LIBRARY,
  MAX_DOCS,
  MAX_SEGMENTS,
  STOP_WORDS,
  combine,
  create,
  flush,
  heldDocs,
  index,
  layout,
  liveDocs,
  merge,
  rank,
  remove,
  search,
  termsOf,
  type IndexState,
} from './index';

const quiet = (s: IndexState) => new Recorder(s, layout, false);
const loud = (s: IndexState) => new Recorder(s, layout, true);
const VOCAB = ['cat', 'dog', 'fox', 'naps', 'red', 'runs', 'sees', 'the', 'owl'];

const tf = (doc: number, term: string) => termsOf(doc).filter((t) => t === term).length;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

/** The model: which documents are buffered, live in a segment, or deleted but not yet merged away. */
interface Model {
  buffered: Set<number>;
  live: Set<number>;
  dead: Set<number>;
}

function check(s: IndexState, m: Model): void {
  expect(s.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
  expect(heldDocs(s).length).toBeLessThanOrEqual(MAX_DOCS);
  expect(sorted(s.buffer.docs)).toEqual(sorted([...m.buffered]));
  expect(liveDocs(s)).toEqual(sorted([...m.live]));
  expect(sorted(s.segments.flatMap((g) => g.deleted))).toEqual(sorted([...m.dead]));
  for (const seg of [...s.segments, s.buffer]) {
    const isBuffer = seg === s.buffer;
    const terms = seg.terms.map((e) => e.term);
    expect(new Set(terms).size).toBe(terms.length);
    if (!isBuffer) {
      expect(terms).toEqual([...terms].sort());
      expect(seg.docs).toEqual(sorted(seg.docs));
      expect(seg.docs.length).toBeGreaterThan(0);
    }
    for (const d of seg.deleted) expect(seg.docs).toContain(d);
    // Postings hold exactly the analysed terms of the segment's documents, with their counts.
    const want = new Map<string, string>();
    for (const d of isBuffer ? seg.docs : sorted(seg.docs)) {
      for (const t of new Set(termsOf(d))) want.set(t, `${want.get(t) ?? ''}${d}:${tf(d, t)} `);
    }
    const got = new Map(seg.terms.map((e) => [e.term, e.postings.map((p) => `${p.doc}:${p.tf} `).join('')]));
    if (!isBuffer) expect(got).toEqual(want);
    else expect(new Map([...got].map(([k, v]) => [k, v.split(' ').sort().join(' ')]))).toEqual(new Map([...want].map(([k, v]) => [k, v.split(' ').sort().join(' ')])));
    for (const e of seg.terms) expect(STOP_WORDS.has(e.term)).toBe(false);
  }
}

const has = (m: Model, t: string) => [...m.live].filter((d) => termsOf(d).includes(t));

function corners(scene: Scene) {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

/** Unique ids, real probe targets, code lines, no overlaps, nothing off the pinned scene, colours used as the site means them. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = f.scene.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) {
      const at = f.scene.nodes.find((n) => n.id === f.probe!.at);
      expect(at, `probe at ${f.probe.at}`).toBeDefined();
      if (f.probe.cell != null) expect(f.probe.cell).toBeLessThan(at!.cells.length);
    }
    if (f.compare) expect(f.probe, 'a comparison follows something').toBeDefined();
    if (f.compare && f.probe) expect(String(f.compare.left)).toBe(f.probe.text);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|null|Infinity|\[object/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    expect(edge).toEqual(corners(frames[0].scene));
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      const sub = n.cells.some((c) => c.sub) ? 22 : 0;
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 + sub };
    });
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.x1 < edge.x1 - 0.5 || a.x2 > edge.x2 + 0.5 || a.y2 > edge.y2 + 0.5) throw new Error(`${a.id} is off the scene`);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5) throw new Error(`${a.id} overlaps ${b.id}`);
      }
    }
    // Postings under neighbouring terms never run into each other.
    const subs = f.scene.nodes.filter((n) => n.cells[0]?.sub).sort((p, q) => p.y - q.y || p.x - q.x);
    for (let i = 0; i + 1 < subs.length; i++) {
      const [p, q] = [subs[i], subs[i + 1]];
      if (p.y !== q.y) continue;
      const room = ((p.cells[0].sub!.length + q.cells[0].sub!.length) * LABEL_CHAR_W) / 2;
      if (q.x - p.x < room) throw new Error(`postings under ${p.id} and ${q.id} overlap`);
    }
    for (const n of f.scene.nodes) {
      expect(n.tone).not.toBe('key');
      for (const c of n.cells) expect(c.tone).not.toBe('key');
    }
  }
}

/** Run one random operation on the state, check it against the model, and update the model. */
function randomOp(s: IndexState, m: Model, rnd: () => number, rec: Recorder<IndexState>): string {
  const roll = rnd();
  const word = () => VOCAB[Math.floor(rnd() * VOCAB.length)];
  if (roll < 0.25) {
    const d = 1 + Math.floor(rnd() * (LIBRARY.length + 1));
    const ok = index(s, d, rec);
    const fits = m.buffered.size + m.live.size + m.dead.size < MAX_DOCS;
    expect(ok).toBe(d <= LIBRARY.length && !m.buffered.has(d) && !m.live.has(d) && !m.dead.has(d) && fits);
    if (ok) m.buffered.add(d);
    return `index ${d}`;
  }
  if (roll < 0.37) {
    const before = s.segments.length;
    const ok = flush(s, rec);
    expect(ok).toBe(m.buffered.size > 0 && before < MAX_SEGMENTS);
    if (ok) {
      for (const d of m.buffered) m.live.add(d);
      m.buffered.clear();
    }
    return 'flush';
  }
  if (roll < 0.5) {
    const d = 1 + Math.floor(rnd() * (LIBRARY.length + 1));
    const ok = remove(s, d, rec);
    expect(ok).toBe(m.live.has(d));
    if (ok) {
      m.live.delete(d);
      m.dead.add(d);
    }
    return `delete ${d}`;
  }
  if (roll < 0.62) {
    const k = 1 + Math.floor(rnd() * 3);
    const before = s.segments.length;
    const pair = s.segments.slice(k - 1, k + 1);
    const ok = merge(s, k, rec);
    expect(ok).toBe(before >= 2 && k <= before - 1);
    if (ok) {
      for (const g of pair) for (const d of g.deleted) m.dead.delete(d);
      expect(s.segments.length).toBe(pair.some((g) => g.docs.some((d) => m.live.has(d))) ? before - 1 : before - 2);
      for (const g of s.segments) expect(g.deleted.length).toBeLessThanOrEqual(m.dead.size);
    }
    return `merge ${k}`;
  }
  const a = word();
  const b = word();
  if (roll < 0.72) {
    expect(sorted(search(s, a, rec))).toEqual(sorted(has(m, a)));
    return `search ${a}`;
  }
  if (roll < 0.8) {
    expect(sorted(combine(s, 'and', a, b, rec))).toEqual(sorted(has(m, a).filter((d) => has(m, b).includes(d))));
    return `and ${a} ${b}`;
  }
  if (roll < 0.88) {
    const got = combine(s, 'or', a, b, rec);
    expect(got.length).toBe(new Set(got).size);
    expect(sorted(got)).toEqual(sorted([...new Set([...has(m, a), ...has(m, b)])]));
    return `or ${a} ${b}`;
  }
  const got = rank(s, a, b, rec);
  const n = m.live.size;
  const score = new Map<number, number>();
  for (const t of new Set([a, b])) {
    const docs = has(m, t);
    for (const d of docs) score.set(d, (score.get(d) ?? 0) + tf(d, t) * Math.log10(n / docs.length));
  }
  expect(sorted(got)).toEqual(sorted([...score.keys()]));
  for (let i = 0; i + 1 < got.length; i++) expect(score.get(got[i])!).toBeGreaterThanOrEqual(score.get(got[i + 1])! - 1e-12);
  return `rank ${a} ${b}`;
}

const emptyModel = (): Model => ({ buffered: new Set(), live: new Set(), dead: new Set() });

describe('inverted index', () => {
  it('agrees with a plain model of which documents hold which words, over thousands of operations', () => {
    for (const seed of [1, 2, 3, 4]) {
      const rnd = makeRng(seed * 97);
      const s = create();
      const m = emptyModel();
      for (let i = 0; i < 3000; i++) {
        randomOp(s, m, rnd, quiet(s));
        check(s, m);
      }
    }
  }, 120_000);

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    const ma = emptyModel();
    const mb = emptyModel();
    for (let i = 0; i < 600; i++) {
      const on = loud(a);
      const off = quiet(b);
      const r = rnd();
      const ra = makeRng(Math.floor(r * 1e9));
      const rb = makeRng(Math.floor(r * 1e9));
      const what = randomOp(a, ma, ra, on);
      expect(randomOp(b, mb, rb, off)).toBe(what);
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(0);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      checkFrames(on.frames);
      // The work area is drawn only; everything else must match exactly.
      expect({ ...a, work: null }).toEqual({ ...b, work: null });
    }
  }, 120_000);

  it('the scene stays within about 830 by 430 units, so it fits beside the code', () => {
    const s = create();
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    const c = corners(layout(s));
    expect(c.x2 - c.x1).toBeLessThanOrEqual(830);
    expect(c.y2 - c.y1).toBeLessThanOrEqual(430);
  });

  it('seed and tour run through the definition: index, flush, search, AND, delete, merge, rank', () => {
    expect(def.id).toBe('inverted-index');
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(s.segments.map((g) => g.docs)).toEqual([[1, 2, 3], [4]]);
    const used = new Map<string, Set<string>>();
    const results: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(0);
      expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      checkFrames(rec.frames);
      const set = used.get(id) ?? new Set<string>();
      used.set(id, set);
      for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      results.push(`${id}: ${rec.counters.comparisons ?? 0} comparisons, ${rec.frames.length} frames`);
    }
    expect(s.segments.map((g) => g.docs)).toEqual([[1, 2, 4], [5]]);
    expect(s.segments[0].terms.map((e) => e.term)).toEqual(['cat', 'dog', 'fox', 'naps', 'red', 'runs', 'sees']);
    // The answers the tour narrates.
    const q = quiet(s);
    expect(search(s, 'dog', q)).toEqual([2]);
    expect(rank(s, 'fox', 'red', q)).toEqual([1, 5, 4]);
    expect(results.length).toBe(7);
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
  });

  it('the tour shows the things it promises', () => {
    const s = def.create({});
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    const frames: Record<string, Frame[]> = {};
    for (const [id, ...args] of def.tour) {
      const rec = loud(s);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      frames[id] = rec.frames;
    }
    const text = (id: string) => frames[id].map((f) => f.message).join(' ');
    expect(text('index')).toMatch(/Lower-case “Fox”/);
    expect(text('index')).toMatch(/stop word/);
    expect(text('index')).toMatch(/term frequency goes up to 2/);
    expect(text('flush')).toMatch(/near real time/);
    expect(frames.search.filter((f) => f.compare).length).toBe(5);
    expect(text('search')).toMatch(/segment 2 has no “dog”/);
    expect(frames.and.filter((f) => f.compare).map((f) => f.compare!.op)).toEqual(['<', '>', '=']);
    expect(text('and')).toMatch(/Skip the whole segment/);
    expect(text('delete')).toMatch(/tombstone/);
    expect(text('merge')).toMatch(/Document 3 is deleted, so it is not copied/);
    expect(text('rank')).toMatch(/idf = log10\(4 \/ 3\) = 0\.125/);
    expect(text('rank')).toMatch(/BM25/);
  });

  it('refuses what the page cannot draw, and says why', () => {
    const s = create();
    const rec = () => loud(s);
    for (let d = 1; d <= MAX_DOCS; d++) expect(index(s, d, quiet(s))).toBe(true);
    const r = rec();
    expect(index(s, 6, r)).toBe(false);
    expect(r.frames[0].message).toMatch(/at most 5 documents/);
    expect(flush(s, quiet(s))).toBe(true);
    const r2 = rec();
    expect(remove(s, 9, r2)).toBe(false);
    expect(r2.frames[0].message).toMatch(/no document 9/);
    expect(remove(s, 2, quiet(s))).toBe(true);
    const r3 = rec();
    expect(index(s, 2, r3)).toBe(false);
    expect(r3.frames[0].message).toMatch(/deleted, but it still takes room/);
    const r4 = rec();
    expect(merge(s, 1, r4)).toBe(false);
    expect(r4.frames[0].message).toMatch(/only one segment/);
    expect(search(s, 'the', quiet(s))).toEqual([]);
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

  it('suggestions are accepted by the form, and their frames name real code lines', () => {
    const s = def.create({});
    for (const [id, ...args] of def.seed) def.ops.find((o) => o.id === id)!.run(s, args, quiet(s));
    const used = new Map<string, Set<string>>();
    for (let round = 0; round < 40; round++) {
      for (const op of def.ops) {
        const args = op.suggest?.(s) ?? [];
        expect(args.length).toBe(op.args.length);
        op.args.forEach((a, i) => {
          if (a.kind === 'int') {
            expect(Number.isInteger(args[i])).toBe(true);
            expect(args[i] as number).toBeGreaterThanOrEqual(a.min!);
            expect(args[i] as number).toBeLessThanOrEqual(a.max!);
          } else expect(String(args[i])).toMatch(/^[a-z]{1,12}$/);
        });
        const rec = loud(s);
        op.run(s, args, rec);
        checkFrames(rec.frames);
        const set = used.get(op.id) ?? new Set<string>();
        used.set(op.id, set);
        for (const f of rec.frames) for (const a of f.lines!) set.add(a);
      }
    }
    expect(codeProblems(def.source!, def.ops, used)).toEqual([]);
  });
});
