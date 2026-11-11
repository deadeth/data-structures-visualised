import { describe, expect, it } from 'vitest';
import { labelLines, labelWidth, LABEL_MAX, LABEL_LINE } from '../../core/fit';
import { listing } from '../../core/code';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame, Scene } from '../../core/types';
import def, {
  BITS,
  MAX_DOCS,
  PAGES,
  SEED_PAGES,
  TOUR_COPY,
  TOUR_NEW,
  TOUR_OTHER,
  TOUR_PAGE,
  chanceWithin,
  compare,
  create,
  fingerprint,
  fingerprintOf,
  hamming,
  layout,
  near,
  toBits,
  wordHash,
  type SimState,
} from './index';

const quiet = (s: SimState) => new Recorder(s, layout, false);
const loud = (s: SimState) => new Recorder(s, layout, true);
const fp = (n: number) => fingerprintOf(PAGES[n - 1].words);
const popcount = (x: number) => x.toString(2).replace(/0/g, '').length;

/** A fingerprint worked out the slow way, straight from the definition. */
function reference(words: readonly string[]): number {
  let out = '';
  for (let bit = BITS - 1; bit >= 0; bit--) {
    const ones = words.filter((w) => toBits(wordHash(w))[BITS - 1 - bit] === '1').length;
    out += ones > words.length - ones ? '1' : '0';
  }
  return parseInt(out, 2);
}

function corners(scene: Scene): { x1: number; x2: number; y1: number; y2: number } {
  const a = scene.decor!.find((d) => d.id === 'corner-a') as { x: number; y: number };
  const b = scene.decor!.find((d) => d.id === 'corner-b') as { x: number; y: number };
  return { x1: a.x, x2: b.x, y1: a.y, y2: b.y };
}

interface Box { id: string; x1: number; y1: number; x2: number; y2: number }
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;

/** Unique ids, a probe on a real node, a code line, nothing overlapping or outside the pinned corners. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const decorIds = (f.scene.decor ?? []).map((d) => d.id);
    expect(new Set(decorIds).size).toBe(decorIds.length);
    if (f.probe) expect(ids.has(f.probe.at), `probe at ${f.probe.at}`).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
    expect(f.lines?.length ?? 0).toBeGreaterThan(0);
    const edge = corners(f.scene);
    const boxes: Box[] = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, y1: n.y - h / 2, x2: n.x + w / 2, y2: n.y + h / 2 };
    });
    for (const d of f.scene.decor ?? []) {
      if (d.type !== 'label' || !d.text) continue;
      const tw = labelWidth(d.text);
      const x1 = d.anchor === 'end' ? d.x - tw : d.anchor === 'middle' ? d.x - tw / 2 : d.x;
      boxes.push({ id: d.id, x1, y1: d.y - LABEL_MAX * 0.65, x2: x1 + tw, y2: d.y + (labelLines(d.text).length - 1) * LABEL_LINE + LABEL_MAX * 0.65 });
    }
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      expect(a.x1, `${a.id} left`).toBeGreaterThanOrEqual(edge.x1 - 0.5);
      expect(a.x2, `${a.id} right`).toBeLessThanOrEqual(edge.x2 + 0.5);
      expect(a.y1, `${a.id} top`).toBeGreaterThanOrEqual(edge.y1 - LABEL_MAX);
      expect(a.y2, `${a.id} bottom`).toBeLessThanOrEqual(edge.y2 + 0.5);
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(a, boxes[j]), `${a.id} overlaps ${boxes[j].id}`).toBe(false);
    }
    // Magenta is only ever on the cell that holds the followed key.
    for (const n of f.scene.nodes) if (n.tone === 'key') expect(n.cells[0].text).toBe(f.probe?.text);
    expect(f.scene.edges.length).toBe(0);
  }
}

describe('SimHash', () => {
  it('uses the word hash printed in the listings', () => {
    expect(wordHash('storm')).toBe((() => {
      let h = 7;
      for (const ch of 'storm') h = (h * 31 + ch.charCodeAt(0)) % 65521;
      return (h ^ (h >> 8)) & 0xff;
    })());
    for (const p of PAGES) for (const w of p.words) {
      expect(wordHash(w)).toBeGreaterThanOrEqual(0);
      expect(wordHash(w)).toBeLessThan(1 << BITS);
    }
    for (const lang of ['python', 'java'] as const) {
      const text = listing(def.source![lang], lang, ['word_hash']).lines.join('\n');
      expect(text).toContain('65521');
      expect(text).toContain('* 31');
      expect(text).toContain('0xFF');
    }
  });

  it('the library is short lower-case words, 4 to 6 to a page', () => {
    expect(PAGES.length).toBe(12);
    for (const p of PAGES) {
      expect(p.words.length).toBeGreaterThanOrEqual(4);
      expect(p.words.length).toBeLessThanOrEqual(6);
      for (const w of p.words) expect(w).toMatch(/^[a-z]{1,7}$/);
      expect(p.words.join(' ').length).toBeLessThanOrEqual(33);
    }
  });

  it('a fingerprint is the sign of the votes, with a tie counting as 0', () => {
    for (const p of PAGES) expect(fingerprintOf(p.words)).toBe(reference(p.words));
    const rnd = makeRng(2002);
    const vocab = [...new Set(PAGES.flatMap((p) => p.words))];
    for (let i = 0; i < 3000; i++) {
      const words = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => vocab[Math.floor(rnd() * vocab.length)]);
      expect(fingerprintOf(words)).toBe(reference(words));
      // Order does not matter, and a word used twice votes twice.
      expect(fingerprintOf([...words].reverse())).toBe(fingerprintOf(words));
    }
    expect(fingerprintOf(['storm'])).toBe(wordHash('storm'));
    expect(fingerprintOf(['storm', 'lamb'])).toBe(wordHash('storm') & wordHash('lamb'));
    expect(fingerprintOf(['storm', 'lamb', 'lamb'])).toBe(wordHash('lamb'));
  });

  it('pins the fingerprints and distances the tour and the notes rely on', () => {
    expect(toBits(fp(1))).toBe('00001100');
    expect(toBits(fp(2))).toBe('00011100');
    expect(toBits(fp(7))).toBe('10110010');
    expect(hamming(fp(TOUR_PAGE), fp(TOUR_COPY))).toBe(1);
    expect(hamming(fp(TOUR_PAGE), fp(TOUR_OTHER))).toBe(6);
    expect(hamming(fp(TOUR_NEW), fp(TOUR_PAGE))).toBe(1);
    expect(hamming(fp(TOUR_NEW), fp(TOUR_COPY))).toBe(2);
    // Every copy within a topic is within 2 bits, and 2 and 3 are exactly 2 apart (a miss at threshold 1).
    for (let a = 1; a <= 9; a++) for (let b = a + 1; b <= 9; b++) {
      const same = PAGES[a - 1].topic === PAGES[b - 1].topic;
      if (same) expect(hamming(fp(a), fp(b)), `${a} and ${b}`).toBeLessThanOrEqual(2);
      else expect(hamming(fp(a), fp(b)), `${a} and ${b}`).toBeGreaterThanOrEqual(3);
    }
    expect(hamming(fp(2), fp(3))).toBe(2);
    // Page 10 is a false positive against the storm story. Page 11 is clear of everything.
    expect(hamming(fp(10), fp(1))).toBe(1);
    for (let a = 1; a <= 10; a++) expect(hamming(fp(11), fp(a))).toBeGreaterThanOrEqual(3);
    // Page 12 has four words and three level columns.
    const totals = Array.from({ length: BITS }, (_, bit) => PAGES[11].words.reduce((t, w) => t + ((wordHash(w) >> bit) & 1 ? 1 : -1), 0));
    expect(totals.filter((t) => t === 0).length).toBe(3);
  });

  it('chance of an unrelated pair matching follows the binomial sum', () => {
    expect(chanceWithin(0)).toBeCloseTo(1 / 256, 12);
    expect(chanceWithin(1)).toBeCloseTo(9 / 256, 12);
    expect(chanceWithin(2)).toBeCloseTo(37 / 256, 12);
    expect(chanceWithin(3)).toBeCloseTo(93 / 256, 12);
    expect(chanceWithin(8)).toBe(1);
  });

  for (const threshold of [1, 2, 3]) {
    it(`matches a simple model through random operations (threshold ${threshold})`, () => {
      const rnd = makeRng(threshold * 7919);
      const s = create(threshold);
      const model: { page: number; fp: number }[] = [];
      for (let i = 0; i < 4000; i++) {
        const n = 1 + Math.floor(rnd() * PAGES.length);
        const roll = rnd();
        const rec = quiet(s);
        if (roll < 0.3) {
          const known = model.some((d) => d.page === n);
          const got = fingerprint(s, n, rec);
          if (known) {
            expect(got).toBeNull();
            expect(rec.counters).toEqual({});
          } else {
            expect(got).toBe(reference(PAGES[n - 1].words));
            if (model.length === MAX_DOCS) model.shift();
            model.push({ page: n, fp: got! });
            expect(rec.counters).toEqual({ hashes: PAGES[n - 1].words.length, comparisons: BITS });
          }
        } else if (roll < 0.65) {
          const m = 1 + Math.floor(rnd() * PAGES.length);
          const a = model.find((d) => d.page === n);
          const b = model.find((d) => d.page === m);
          const got = compare(s, n, m, rec);
          if (!a || !b) {
            expect(got).toBeNull();
            expect(rec.counters).toEqual({});
          } else {
            expect(got).toBe(popcount(a.fp ^ b.fp));
            // One test per bit, then one against the threshold.
            expect(rec.counters).toEqual({ comparisons: BITS + 1 });
          }
        } else {
          const want = model.filter((d) => popcount(d.fp ^ fp(n)) <= threshold).map((d) => d.page);
          expect(near(s, n, rec)).toEqual(want);
          expect(rec.counters).toEqual({ hashes: PAGES[n - 1].words.length, comparisons: BITS + model.length });
        }
        expect(s.docs.map((d) => ({ page: d.page, fp: d.fp }))).toEqual(model);
        expect(s.docs.length).toBeLessThanOrEqual(MAX_DOCS);
      }
    });
  }

  it('counts the same with recording on and off, and keeps every frame well formed', () => {
    const rnd = makeRng(4242);
    for (const threshold of [1, 2, 3]) {
      const a = create(threshold);
      const b = create(threshold);
      for (let i = 0; i < 150; i++) {
        const n = 1 + Math.floor(rnd() * PAGES.length);
        const m = 1 + Math.floor(rnd() * PAGES.length);
        const roll = rnd();
        const on = loud(a);
        const off = quiet(b);
        if (roll < 0.35) expect(fingerprint(a, n, on)).toBe(fingerprint(b, n, off));
        else if (roll < 0.7) expect(compare(a, n, m, on)).toBe(compare(b, n, m, off));
        else expect(near(a, n, on)).toEqual(near(b, n, off));
        expect(off.frames.length).toBe(0);
        expect(on.frames.length).toBeGreaterThan(0);
        expect(on.counters).toEqual(off.counters);
        expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
        expect(a.docs).toEqual(b.docs);
        if (i % 5 === 0) checkFrames(on.frames);
      }
    }
  }, 60_000);

  it('fingerprinting follows each word, then each bit, and shows every sign test', () => {
    const s = create();
    const rec = loud(s);
    expect(fingerprint(s, 1, rec)).toBe(fp(1));
    checkFrames(rec.frames);
    const words = PAGES[0].words;
    // Opening, two frames a word, one per bit, and the store.
    expect(rec.frames.length).toBe(1 + 2 * words.length + BITS + 1);
    words.forEach((word, r) => {
      const [hashed, voted] = [rec.frames[1 + 2 * r], rec.frames[2 + 2 * r]];
      expect(hashed.probe).toEqual({ text: word, at: `w${r}`, place: 'left' });
      expect(hashed.lines).toEqual(['hash']);
      expect(hashed.message).toContain(toBits(wordHash(word)));
      expect(hashed.scene.nodes.find((n) => n.id === `w${r}`)!.tone).toBe('key');
      expect(voted.lines).toEqual(['vote']);
      // The row shows the hash, leftmost cell first.
      const row = Array.from({ length: BITS }, (_, c) => voted.scene.nodes.find((n) => n.id === `h${r}-${c}`)!.cells[0].text).join('');
      expect(row).toBe(toBits(wordHash(word)));
    });
    const signs = rec.frames.filter((f) => f.compare);
    expect(signs.length).toBe(BITS);
    signs.forEach((f, i) => {
      const bit = BITS - 1 - i;
      expect(f.probe).toEqual({ text: `bit ${bit}`, at: `f${i}`, place: 'below' });
      const one = (fp(1) >> bit) & 1;
      expect(f.compare!.op).toBe(one ? '>' : '≤');
      expect(f.compare!.verdict).toBe(`bit ${bit} is ${one}`);
      expect(f.lines).toEqual(one ? ['sign', 'set_bit'] : ['sign']);
      expect(f.scene.nodes.find((n) => n.id === `v${i}`)!.tone).toBe('compare');
      expect(f.scene.nodes.find((n) => n.id === `f${i}`)!.cells[0].text).toBe(String(one));
    });
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toContain('00001100');
    expect(last.scene.nodes.find((n) => n.id === 'd1')!.tone).toBe('ok');
  });

  it('a tie is narrated as a tie', () => {
    const s = create();
    const rec = loud(s);
    fingerprint(s, 12, rec);
    expect(rec.frames.filter((f) => /A tie/.test(f.message)).length).toBe(3);
    for (const f of rec.frames.filter((x) => /A tie/.test(x.message))) expect(f.compare).toMatchObject({ left: 'total 0', op: '≤', right: 0 });
  });

  it('storing a page twice changes nothing', () => {
    const s = create();
    fingerprint(s, 4, quiet(s));
    const before = JSON.stringify(s.docs);
    const rec = loud(s);
    expect(fingerprint(s, 4, rec)).toBeNull();
    expect(JSON.stringify(s.docs)).toBe(before);
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toContain('already stored');
    expect(rec.frames[0].lines).toEqual(['known_test', 'known']);
    checkFrames(rec.frames);
  });

  it('drops the oldest page when the canvas is full, and says so', () => {
    const s = create();
    for (let n = 1; n <= MAX_DOCS; n++) fingerprint(s, n, quiet(s));
    const rec = loud(s);
    fingerprint(s, 11, rec);
    checkFrames(rec.frames);
    expect(s.docs.map((d) => d.page)).toEqual([2, 3, 4, 5, 11]);
    const drop = rec.frames.find((f) => /drops off/.test(f.message))!;
    expect(drop.scene.nodes.find((n) => n.id === 'd1')!.tone).toBe('bad');
  });

  it('compare counts the differing bits one at a time and tests the total against the threshold', () => {
    const s = create();
    for (const n of [1, 2, 7]) fingerprint(s, n, quiet(s));
    let rec = loud(s);
    expect(compare(s, 1, 2, rec)).toBe(1);
    checkFrames(rec.frames);
    let tests = rec.frames.filter((f) => f.compare);
    expect(tests.length).toBe(BITS + 1);
    const x = fp(1) ^ fp(2);
    tests.slice(0, BITS).forEach((f, i) => {
      const bit = BITS - 1 - i;
      const differs = (x >> bit) & 1;
      expect(f.probe).toEqual({ text: `bit ${bit}`, at: `x${i}`, place: 'below' });
      expect(f.compare).toMatchObject(differs ? { left: 'xor 1', op: '=', right: 1 } : { left: 'xor 0', op: '≠', right: 1 });
      expect(f.lines).toEqual(differs ? ['bit', 'differ'] : ['bit']);
      expect(f.scene.nodes.find((n) => n.id === `x${i}`)!.tone).toBe('compare');
    });
    expect(tests[BITS].compare).toEqual({ left: 'distance 1', op: '≤', right: 2, verdict: 'near-duplicate' });
    expect(tests[BITS].probe).toEqual({ text: '00001100', at: 'd2', place: 'left' });
    expect(tests[BITS].lines).toEqual(['threshold']);

    rec = loud(s);
    expect(compare(s, 1, 7, rec)).toBe(6);
    checkFrames(rec.frames);
    tests = rec.frames.filter((f) => f.compare);
    expect(tests[BITS].compare).toEqual({ left: 'distance 6', op: '>', right: 2, verdict: 'not a near-duplicate' });

    rec = loud(s);
    expect(compare(s, 1, 9, rec)).toBeNull();
    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].message).toContain('Page 9 is not stored');
    checkFrames(rec.frames);
  });

  it('labels false positives and misses truthfully', () => {
    let s = create(2);
    for (const n of [1, 10]) fingerprint(s, n, quiet(s));
    let rec = loud(s);
    compare(s, 1, 10, rec);
    expect(rec.frames[rec.frames.length - 1].message).toContain('false positive');
    rec = loud(s);
    expect(near(s, 10, rec)).toEqual([1, 10]);
    s = create(2);
    fingerprint(s, 1, quiet(s));
    rec = loud(s);
    expect(near(s, 10, rec)).toEqual([1]);
    expect(rec.frames[rec.frames.length - 1].message).toContain('false positive');
    checkFrames(rec.frames);

    s = create(1);
    for (const n of [2, 3]) fingerprint(s, n, quiet(s));
    rec = loud(s);
    expect(compare(s, 2, 3, rec)).toBe(2);
    expect(rec.frames[rec.frames.length - 1].message).toContain('a miss');
  });

  it('near works out the fingerprint, scans every stored page and does not store the new one', () => {
    const s = create();
    for (const n of [4, 5, 1, 2, 7]) fingerprint(s, n, quiet(s));
    const rec = loud(s);
    expect(near(s, 3, rec)).toEqual([1, 2]);
    checkFrames(rec.frames);
    expect(s.docs.map((d) => d.page)).toEqual([4, 5, 1, 2, 7]);
    const words = PAGES[2].words;
    // Opening, one frame a word, one per bit, two per stored page, and the outcome.
    expect(rec.frames.length).toBe(1 + words.length + BITS + 2 * 5 + 1);
    const scan = rec.frames.filter((f) => f.compare && String(f.compare.left).startsWith('distance'));
    expect(scan.map((f) => f.probe!.at)).toEqual(['d4', 'd5', 'd1', 'd2', 'd7']);
    for (const f of scan) expect(f.probe!.text).toBe(toBits(fp(3)));
    expect(scan.map((f) => f.compare!.op)).toEqual(['>', '>', '≤', '≤', '>']);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toContain('pages 1 and 2 (1 bit and 2 bits apart)');
    expect(last.scene.nodes.find((n) => n.id === 'd1')!.tone).toBe('ok');
    expect(last.scene.nodes.find((n) => n.id === 'd7')!.tone).toBe('dim');

    const empty = create();
    const rec2 = loud(empty);
    expect(near(empty, 3, rec2)).toEqual([]);
    expect(rec2.frames[rec2.frames.length - 1].message).toContain('Nothing is stored');
    checkFrames(rec2.frames);
  });

  it('the scene stays the same size and inside a readable canvas whatever is shown', () => {
    const s = create();
    const rec = loud(s);
    rec.line('start');
    rec.step('empty');
    for (const n of [3, 6, 9, 12, 1]) fingerprint(s, n, rec);
    compare(s, 3, 9, rec);
    near(s, 10, rec);
    checkFrames(rec.frames);
    const first = corners(rec.frames[0].scene);
    for (const f of rec.frames) expect(corners(f.scene)).toEqual(first);
    expect(first.x2 - first.x1).toBeLessThanOrEqual(950);
    expect(first.y2 - first.y1).toBeLessThanOrEqual(400);
  });

  it('seed and tour run cleanly through the definition', () => {
    expect(def.id).toBe('simhash');
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const s = def.create({ threshold: 2 });
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const rec = new Recorder(s, def.layout, recording);
      def.ops.find((o) => o.id === id)!.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    expect(s.docs.map((d) => d.page)).toEqual(SEED_PAGES);
    const finals: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = run(id, args, true);
      checkFrames(rec.frames);
      expect(rec.frames.some((f) => f.probe)).toBe(true);
      finals.push(rec.frames[rec.frames.length - 1].message);
    }
    // No page is dropped during the tour.
    expect(s.docs.map((d) => d.page)).toEqual([...SEED_PAGES, TOUR_PAGE, TOUR_COPY, TOUR_OTHER]);
    expect(finals[2]).toContain('1 of 8 bits differ');
    expect(finals[2]).toContain('near-duplicates');
    expect(finals[4]).toContain('6 of 8 bits differ');
    expect(finals[4]).toContain('not near-duplicates');
    expect(finals[5]).toContain('near-duplicate of pages 1 and 2');
    for (const op of def.ops) {
      for (let i = 0; i < 8; i++) {
        const args = op.suggest!(s);
        expect(args.length).toBe(op.args.length);
        for (const a of args) expect(Number(a) >= 1 && Number(a) <= PAGES.length).toBe(true);
        checkFrames(run(op.id, args, true).frames);
      }
    }
    expect(def.status!(s).length).toBe(4);
  }, 60_000);
});
