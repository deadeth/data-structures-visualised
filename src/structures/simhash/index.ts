import { LABEL_MAX, PROBE_H, probeWidth } from '../../core/fit';
import { CELL_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/SimHash.java?raw';
import python from './code/simhash.py?raw';
import { info } from './info';

/**
 * SimHash: a fingerprint that stays close when the text stays close.
 *
 * Every word of a page is hashed to BITS bits. Each bit column keeps a total:
 * a word adds 1 where its hash has a 1 and takes 1 away where it has a 0. The
 * sign of each total gives one bit of the fingerprint. Pages that share most
 * of their words cast mostly the same votes, so their fingerprints differ in
 * few bits, and the number of differing bits (the Hamming distance) measures
 * how far apart two pages are.
 *
 * The model uses 8 bits so the working fits on the canvas. Real systems use
 * 64 bits and treat 3 bits or fewer apart as near-duplicates.
 */

/** Width of a fingerprint in this model. */
export const BITS = 8;
/** Most stored pages the canvas draws. */
export const MAX_DOCS = 5;

/** The word hash, the same sum as the listings: a polynomial hash folded down to 8 bits. */
export function wordHash(word: string): number {
  let h = 7;
  for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) % 65521;
  return (h ^ (h >> 8)) & 0xff;
}

export function fingerprintOf(words: readonly string[]): number {
  const totals = new Array<number>(BITS).fill(0);
  for (const word of words) {
    const h = wordHash(word);
    for (let bit = 0; bit < BITS; bit++) totals[bit] += (h >> bit) & 1 ? 1 : -1;
  }
  let fp = 0;
  for (let bit = 0; bit < BITS; bit++) if (totals[bit] > 0) fp |= 1 << bit;
  return fp;
}

export function hamming(a: number, b: number): number {
  let x = a ^ b;
  let d = 0;
  for (; x; x >>= 1) d += x & 1;
  return d;
}

/**
 * The pages a reader can pick, by number. An operation takes one whole number
 * or one word, so a page is chosen by number from this fixed library. The
 * words come from a fixed vocabulary of lower-case words of up to 7 letters.
 *
 * `topic` is the page's own record of the truth, as on the Bloom filter page:
 * two pages with the same topic really are near copies. The fingerprints never
 * see it. It lets the narration say when a match is a false positive.
 */
export interface Page {
  words: readonly string[];
  topic: string;
}

const page = (text: string, topic: string): Page => ({ words: text.split(' '), topic });

export const PAGES: readonly Page[] = [
  page('storm shuts town path today', 'storm'),
  page('storm shuts town path tonight', 'storm'),
  page('storm shuts town path today sale', 'storm'),
  page('slow baked lamb with herbs', 'recipe'),
  page('slow baked lamb with lemon', 'recipe'),
  page('slow baked lamb with herbs deal', 'recipe'),
  page('rovers lift cup title again', 'football'),
  page('rovers lift cup title replay', 'football'),
  page('rovers lift cup title again offer', 'football'),
  page('new phone on sale today', 'phone'),
  page('train strike ends this week', 'train'),
  page('bank rates rise again', 'bank'),
];

export interface Doc {
  /** Page number in the library, from 1. */
  page: number;
  words: readonly string[];
  fp: number;
}

/** The working shown on the left of the canvas: the votes of a fingerprint, or two fingerprints and their XOR. */
export interface VoteWork {
  kind: 'vote';
  page: number;
  rows: { word: string; hash: number | null }[];
  /** Running total per bit, indexed by bit number. */
  totals: number[];
  /** Fingerprint bits decided so far, indexed by bit number. */
  bits: (number | null)[];
}

export interface XorWork {
  kind: 'xor';
  /** `ids` is the id prefix of the row's cells, so a row can slide in from the votes table. */
  top: { label: string; fp: number; ids: string; from?: string };
  bottom: { label: string; fp: number; from?: string } | null;
  showXor: boolean;
}

export interface SimState {
  /** Two fingerprints this many bits apart or fewer count as near-duplicates. */
  threshold: number;
  /** Stored pages, oldest first. */
  docs: Doc[];
  /** What the last operation worked out. Drawn, never read by an operation. */
  work: VoteWork | XorWork | null;
}

export function create(threshold = 2): SimState {
  return { threshold, docs: [], work: null };
}

export const toBits = (n: number) => n.toString(2).padStart(BITS, '0');
/** A fingerprint or hash as the strip shows it: a Python binary literal, bit 7 first. */
const lit = (n: number) => `0b${toBits(n)}`;
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (words: readonly string[]) => `“${words.join(' ')}”`;
const list = (items: (string | number)[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : String(items[0] ?? '');
const pageOf = (n: number): Page | undefined => PAGES[n - 1];
const stored = (s: SimState, n: number) => s.docs.find((d) => d.page === n);
const sameTopic = (a: number, b: number) => pageOf(a)?.topic === pageOf(b)?.topic;

/** Chance that two unrelated 8-bit fingerprints land within `t` bits: the sum of C(8, k) for k up to t, over 256. */
export function chanceWithin(t: number): number {
  let ways = 0;
  let c = 1;
  for (let k = 0; k <= t && k <= BITS; k++) {
    ways += c;
    c = (c * (BITS - k)) / (k + 1);
  }
  return ways / (1 << BITS);
}
const percent = (p: number) => `${(p * 100).toFixed(p < 0.0995 ? 1 : 0)}%`;

// Node ids. Column c runs left to right, so column 0 is bit 7.
const col = (bit: number) => BITS - 1 - bit;
const wid = (r: number) => `w${r}`;
const hid = (r: number, c: number) => `h${r}-${c}`;
const vid = (c: number) => `v${c}`;
const fid = (c: number) => `f${c}`;
const aid = (c: number) => `a${c}`;
const bid = (c: number) => `b${c}`;
const xid = (c: number) => `x${c}`;
const did = (n: number) => `d${n}`;

/**
 * Hash every word, add its votes to the totals and take the signs.
 * With `brief` the hash and the votes of a word share one frame.
 */
function vote(w: VoteWork, rec: Rec, brief: boolean): number {
  const n = w.rows.length;
  w.rows.forEach((row, r) => {
    const h = wordHash(row.word);
    rec.count('hashes');
    row.hash = h;
    const probe: Probe = { text: row.word, at: wid(r), place: 'left' };
    rec.mark(wid(r), 'key');
    // totals is indexed by bit number, so totals[0] is the rightmost column.
    if (rec.recording) rec.vars({ word: row.word, h: lit(h), totals: [...w.totals] });
    if (rec.recording && !brief) {
      rec.line('hash');
      rec.step(
        `Hash ${quote([row.word])} to ${BITS} bits: ${toBits(h)}. The hash is fixed, so this word gives these bits on every page it appears in.`,
        { probe },
      );
    }
    for (let bit = 0; bit < BITS; bit++) {
      w.totals[bit] += (h >> bit) & 1 ? 1 : -1;
      rec.mark(vid(col(bit)), 'ok');
    }
    if (rec.recording) {
      rec.vars({ word: row.word, h: lit(h), totals: [...w.totals] });
      const after = `That is the score after ${r + 1} of ${plural(n, 'word')}.`;
      rec.line(...(brief ? ['hash', 'vote'] : ['vote']));
      rec.step(
        brief
          ? `${quote([row.word])} hashes to ${toBits(h)} and votes: add 1 to the total under each 1, take 1 away under each 0. ${after}`
          : `${quote([row.word])} votes in every column: add 1 to the total under each 1, take 1 away under each 0. ${after}`,
        { probe },
      );
      rec.mark(wid(r), 'path');
      for (let c = 0; c < BITS; c++) rec.mark(vid(c), 'idle');
    }
  });

  let fp = 0;
  for (let bit = BITS - 1; bit >= 0; bit--) {
    const c = col(bit);
    const total = w.totals[bit];
    const one = total > 0;
    if (one) fp |= 1 << bit;
    w.bits[bit] = one ? 1 : 0;
    rec.mark(vid(c), 'compare');
    rec.mark(fid(c), 'ok');
    if (rec.recording) rec.vars({ bit, 'totals[bit]': total, fp: lit(fp) });
    rec.line(...(one ? ['sign', 'set_bit'] : ['sign']));
    rec.compare(`total ${signed(total)}`, one ? '>' : '≤', 0, `bit ${bit} is ${one ? 1 : 0}`, {
      probe: { text: `bit ${bit}`, at: fid(c), place: 'below' },
      message: one
        ? `More words voted 1 than 0 in this column, so bit ${bit} of the fingerprint is 1.`
        : total < 0
          ? `More words voted 0 than 1 in this column, so bit ${bit} of the fingerprint is 0.`
          : `A tie: as many words voted 1 as 0. This listing gives a tie a 0, so bit ${bit} is 0. One changed word would flip it.`,
    });
    rec.mark(vid(c), 'path');
  }
  return fp;
}

function startVote(s: SimState, n: number): VoteWork {
  const w: VoteWork = {
    kind: 'vote',
    page: n,
    rows: pageOf(n)!.words.map((word) => ({ word, hash: null })),
    totals: new Array<number>(BITS).fill(0),
    bits: new Array<number | null>(BITS).fill(null),
  };
  s.work = w;
  return w;
}

const noSuchPage = (n: number) => `There is no page ${n}. The library holds pages 1 to ${PAGES.length}.`;

/** Fingerprint a library page and store it. Returns the fingerprint, or null when nothing was stored. */
export function fingerprint(s: SimState, n: number, rec: Rec): number | null {
  rec.clearMarks();
  rec.vars({ page: n });
  rec.line('known_test');
  const p = pageOf(n);
  if (!p) {
    rec.step(noSuchPage(n));
    return null;
  }
  const have = stored(s, n);
  if (have) {
    rec.mark(did(n), 'path');
    rec.vars({ page: n, 'pages[page]': lit(have.fp) });
    rec.line('known_test', 'known');
    rec.step(`Page ${n} is already stored with fingerprint ${toBits(have.fp)}. The same words always give the same fingerprint, so there is nothing to do.`);
    return null;
  }
  const w = startVote(s, n);
  rec.vars({ page: n, words: [...p.words], totals: [...w.totals] });
  rec.line('known_test', 'start');
  rec.step(
    `Fingerprint page ${n}: ${quote(p.words)}. Each word is hashed to ${BITS} bits and then votes on every bit. All ${BITS} totals start at 0.`,
  );
  const fp = vote(w, rec, false);
  rec.clearMarks();
  rec.vars({ page: n, 'pages[page]': lit(fp) });
  rec.line('store');
  if (s.docs.length >= MAX_DOCS) {
    const oldest = s.docs[0];
    if (rec.recording) {
      rec.mark(did(oldest.page), 'bad');
      rec.step(
        `This page draws at most ${MAX_DOCS} stored pages so they stay readable. The oldest, page ${oldest.page}, drops off to make room. A real index keeps every fingerprint.`,
      );
      rec.clearMarks();
    }
    s.docs.shift();
  }
  s.docs.push({ page: n, words: p.words, fp });
  if (rec.recording) {
    rec.mark(did(n), 'ok');
    for (let c = 0; c < BITS; c++) rec.mark(fid(c), 'ok');
    rec.step(
      `Page ${n} is stored as ${toBits(fp)}: ${plural(p.words.length, 'word')} hashed and ${BITS} totals tested. The fingerprint is ${BITS} bits however long the page is. Real systems use 64.`,
    );
  }
  return fp;
}

/** Count the bits in which two stored pages differ. Returns the distance, or null when a page is not stored. */
export function compare(s: SimState, a: number, b: number, rec: Rec): number | null {
  rec.clearMarks();
  rec.vars({ a, b });
  rec.line('call');
  const da = stored(s, a);
  const db = stored(s, b);
  if (!da || !db) {
    const missing = !da ? a : b;
    const have = s.docs.map((d) => d.page);
    rec.step(
      pageOf(missing)
        ? `Page ${missing} is not stored, so it has no fingerprint to compare. ${have.length ? `Stored now: ${plural(have.length, 'page')} ${list(have)}.` : 'Nothing is stored yet.'} Fingerprint it first.`
        : noSuchPage(missing),
    );
    return null;
  }
  const work: XorWork = {
    kind: 'xor',
    top: { label: `page ${a}`, fp: da.fp, ids: 'a', from: did(a) },
    bottom: { label: `page ${b}`, fp: db.fp, from: did(b) },
    showXor: false,
  };
  s.work = work;
  rec.vars({ a, b, 'pages[a]': lit(da.fp), 'pages[b]': lit(db.fp) });
  rec.mark(did(a), 'path');
  rec.mark(did(b), 'path');
  rec.step(
    a === b
      ? `Compare page ${a} with itself. Only the fingerprint is needed, not the words.`
      : `Compare pages ${a} and ${b}. Only the two fingerprints are needed, not the words: ${toBits(da.fp)} and ${toBits(db.fp)}.`,
  );
  const x = da.fp ^ db.fp;
  work.showXor = true;
  // Inside hamming, a and b are the two fingerprints.
  rec.vars({ a: lit(da.fp), b: lit(db.fp), x: lit(x), distance: 0 });
  rec.line('xor');
  rec.step(`XOR the two fingerprints. The result has a 1 wherever they differ and a 0 wherever they agree: ${toBits(x)}. Now count the 1s.`);

  let distance = 0;
  for (let bit = BITS - 1; bit >= 0; bit--) {
    const c = col(bit);
    const differs = ((x >> bit) & 1) === 1;
    const probe: Probe = { text: `bit ${bit}`, at: xid(c), place: 'below' };
    rec.mark(aid(c), 'compare');
    rec.mark(bid(c), 'compare');
    rec.mark(xid(c), 'compare');
    if (rec.recording) rec.vars({ a: lit(da.fp), b: lit(db.fp), x: lit(x), bit, 'x >> bit & 1': differs ? 1 : 0, distance: distance + (differs ? 1 : 0) });
    if (differs) {
      distance++;
      rec.line('bit', 'differ');
      rec.compare('xor 1', '=', 1, `differs, distance ${distance}`, {
        probe,
        message: `The pages differ at bit ${bit}. Add 1 to the distance, which makes ${distance}.`,
      });
    } else {
      rec.line('bit');
      rec.compare('xor 0', '≠', 1, 'same, move on', { probe, message: `Both pages have ${(da.fp >> bit) & 1} at bit ${bit}. Nothing to count.` });
    }
    rec.mark(aid(c), 'idle');
    rec.mark(bid(c), 'idle');
    rec.mark(xid(c), differs ? 'ok' : 'dim');
  }

  const isNear = distance <= s.threshold;
  const truly = sameTopic(a, b);
  if (isNear) {
    rec.mark(did(a), 'ok');
    rec.mark(did(b), 'ok');
  }
  const bitsApart = `${distance} of ${BITS} bits differ`;
  let message: string;
  if (a === b) message = `A page is 0 bits from itself. ${BITS} bit tests.`;
  else if (isNear && truly) {
    message = `${bitsApart}, within the threshold of ${s.threshold}, so pages ${a} and ${b} count as near-duplicates. They are: the words differ only slightly. ${BITS} bit tests, whatever the length of the pages.`;
  } else if (isNear) {
    message = `${bitsApart}, within the threshold of ${s.threshold}, so the pages count as near-duplicates. That is a false positive: they are different pages. With only ${BITS} bits, about ${percent(chanceWithin(s.threshold))} of unrelated pairs land this close.`;
  } else if (truly) {
    message = `${bitsApart}, over the threshold of ${s.threshold}, so the pages do not count as near-duplicates. That is a miss: they are near copies. With so few words, one changed word is a large share of the vote.`;
  } else {
    message = `${bitsApart}, over the threshold of ${s.threshold}, so pages ${a} and ${b} are not near-duplicates. Different words cast different votes, and the fingerprints end up far apart. ${BITS} bit tests.`;
  }
  rec.vars({ a, b, distance, threshold: s.threshold });
  rec.line('threshold');
  rec.compare(`distance ${distance}`, isNear ? '≤' : '>', s.threshold, isNear ? 'near-duplicate' : 'not a near-duplicate', {
    probe: { text: toBits(da.fp), at: did(b), place: 'left' },
    message,
  });
  return distance;
}

/** Find the stored pages within the threshold of a library page, without storing it. Returns their page numbers. */
export function near(s: SimState, n: number, rec: Rec): number[] {
  rec.clearMarks();
  rec.vars();
  rec.line('near_start');
  const p = pageOf(n);
  if (!p) {
    rec.step(noSuchPage(n));
    return [];
  }
  const w = startVote(s, n);
  rec.vars({ words: [...p.words], totals: [...w.totals] });
  rec.line('near_start', 'start');
  rec.step(
    `Is page ${n}, ${quote(p.words)}, a near copy of anything stored? First work out its fingerprint, exactly as Fingerprint does, shown here one word to a step. The page is not stored.`,
  );
  const fp = vote(w, rec, true);
  rec.clearMarks();

  const work: XorWork = { kind: 'xor', top: { label: 'new', fp, ids: 'f' }, bottom: null, showXor: false };
  s.work = work;
  const found: number[] = [];
  const distances: number[] = [];
  let probe: Probe | undefined;
  for (const doc of s.docs) {
    const x = fp ^ doc.fp;
    const distance = hamming(fp, doc.fp);
    work.bottom = { label: `page ${doc.page}`, fp: doc.fp, from: did(doc.page) };
    work.showXor = true;
    probe = { text: toBits(fp), at: did(doc.page), place: 'left' };
    if (rec.recording) rec.vars({ fp: lit(fp), page: doc.page, other: lit(doc.fp), distance, found: [...found] });
    if (rec.recording) {
      rec.mark(did(doc.page), 'compare');
      for (let bit = 0; bit < BITS; bit++) rec.mark(xid(col(bit)), (x >> bit) & 1 ? 'ok' : 'dim');
      rec.line('near_distance');
      rec.step(
        `Page ${doc.page}: ${toBits(fp)} XOR ${toBits(doc.fp)} is ${toBits(x)}, which holds ${plural(distance, 'one')}. Compare shows that count bit by bit.`,
        { probe },
      );
    }
    const within = distance <= s.threshold;
    if (within) {
      found.push(doc.page);
      distances.push(distance);
    }
    rec.mark(did(doc.page), within ? 'ok' : 'dim');
    if (rec.recording) rec.vars({ fp: lit(fp), page: doc.page, other: lit(doc.fp), distance, found: [...found] });
    rec.line(...(within ? ['near_test', 'near_keep'] : ['near_test']));
    rec.compare(`distance ${distance}`, within ? '≤' : '>', s.threshold, within ? 'near-duplicate, keep it' : 'too far, move on', {
      probe,
      message: within
        ? `${plural(distance, 'bit')} apart, within the threshold of ${s.threshold}. Page ${doc.page} goes on the list of near-duplicates.`
        : `${plural(distance, 'bit')} apart, over the threshold of ${s.threshold}. Page ${doc.page} is not a near-duplicate.`,
    });
  }

  if (rec.recording) {
    const scan = s.docs.length
      ? `That took ${plural(s.docs.length, 'comparison')}, one for each stored page. A real index avoids the scan by looking up blocks of the fingerprint.`
      : '';
    const wrong = found.filter((d) => d !== n && !sameTopic(d, n));
    let outcome: string;
    if (!s.docs.length) outcome = `Nothing is stored, so there is nothing to compare page ${n} with. A crawler would treat it as new.`;
    else if (!found.length) outcome = `No stored page is within ${plural(s.threshold, 'bit')} of page ${n}, so a crawler would treat it as new: index it and follow its links.`;
    else {
      const which = `${found.length === 1 ? 'page' : 'pages'} ${list(found)} (${list(distances.map((d) => plural(d, 'bit')))} apart)`;
      outcome =
        wrong.length === found.length
          ? `Page ${n} matches ${which}, but ${wrong.length === 1 ? 'that is a different page' : 'those are different pages'}: a false positive. With only ${BITS} bits, about ${percent(chanceWithin(s.threshold))} of unrelated pairs land this close.`
          : wrong.length
            ? `Page ${n} matches ${which}. ${wrong.length === 1 ? `Page ${wrong[0]} is` : `Pages ${list(wrong)} are`} a false positive, a different page that happens to land close. The rest are real near copies, so a crawler would skip page ${n}.`
            : `Page ${n} is a near-duplicate of ${which}. A crawler would not index it again or follow its links.`;
    }
    rec.vars({ fp: lit(fp), found: [...found] });
    rec.line('near_done');
    rec.step(`${outcome} ${scan}`.trim(), probe ? { probe } : {});
  }
  return found;
}

// ---- layout ---------------------------------------------------------------

/** Width of the word column. Fits 7 letters. */
const LABEL_W = 92;
const BIT_W = 34;
const BIT_PITCH = BIT_W + 3;
const BITS_X = LABEL_W + 12;
const TABLE_RIGHT = BITS_X + BITS * BIT_PITCH - 3;
const ROW = 38;
/** Most words a page can have, which fixes the height of the table. */
const MAX_WORDS = 6;
const HEAD_Y = -CELL_H / 2 - 14;
/** The word chip sits to the left of its word, so keep room for the longest one. */
const LEFT = -(probeWidth('tonight') + 14);
const TOP = HEAD_Y - LABEL_MAX;
const SIGN_Y = MAX_WORDS * ROW + 6 + ROW + 2;
const BOTTOM = SIGN_Y + CELL_H / 2 + 9 + PROBE_H + 6;

/** Stored pages: a column on the right, with room on its left for the fingerprint chip. */
const DOC_W = 104;
const DOC_LEFT = TABLE_RIGHT + probeWidth('00000000') + 22;
const DOC_PITCH = 68;
const DOC_TEXT_W = 290;
const RIGHT = DOC_LEFT + DOC_TEXT_W;

const bitX = (c: number) => BITS_X + c * BIT_PITCH + BIT_W / 2;

function bitRow(nodes: SceneNode[], id: (c: number) => string, y: number, text: (bit: number) => string, from?: string): void {
  for (let c = 0; c < BITS; c++) {
    nodes.push({ id: id(c), x: bitX(c), y, cells: [{ text: text(BITS - 1 - c), w: BIT_W }], from });
  }
}

const rowLabel = (id: string, y: number, text: string): Decor => ({ id, type: 'label', x: LABEL_W - 4, y: y + 5, text, anchor: 'end' });

export function layout(s: SimState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [
    // Two empty labels pin the corners, so the view does not rescale as rows come and go or the chip moves outside the nodes.
    { id: 'corner-a', type: 'label', x: LEFT, y: TOP, text: '' },
    { id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' },
    { id: 'bit-head', type: 'label', x: LABEL_W - 4, y: HEAD_Y, text: 'bit', anchor: 'end' },
  ];
  for (let c = 0; c < BITS; c++) decor.push({ id: `bit-${c}`, type: 'label', x: bitX(c), y: HEAD_Y, text: String(BITS - 1 - c), anchor: 'middle' });

  const w = s.work;
  if (!w) {
    decor.push({ id: 'hint', type: 'label', x: 0, y: 5, text: 'Fingerprint a page to see\nits words vote here.' });
  } else if (w.kind === 'vote') {
    w.rows.forEach((row, r) => {
      const y = r * ROW;
      nodes.push({ id: wid(r), x: LABEL_W / 2, y, cells: [{ text: row.word, w: LABEL_W }] });
      bitRow(nodes, (c) => hid(r, c), y, (bit) => (row.hash == null ? '' : String((row.hash >> bit) & 1)));
    });
    const votesY = w.rows.length * ROW + 6;
    const signY = votesY + ROW + 2;
    bitRow(nodes, vid, votesY, (bit) => signed(w.totals[bit]));
    bitRow(nodes, fid, signY, (bit) => (w.bits[bit] == null ? '' : String(w.bits[bit])));
    decor.push(rowLabel('lab-votes', votesY, 'totals'), rowLabel('lab-sign', signY, 'fingerprint'));
  } else {
    const id = w.top.ids === 'f' ? fid : aid;
    bitRow(nodes, id, 0, (bit) => String((w.top.fp >> bit) & 1), w.top.from);
    decor.push(rowLabel('lab-top', 0, w.top.label));
    if (w.bottom) {
      const bottom = w.bottom;
      bitRow(nodes, bid, ROW, (bit) => String((bottom.fp >> bit) & 1), bottom.from);
      decor.push(rowLabel('lab-bottom', ROW, bottom.label));
      const x = w.top.fp ^ bottom.fp;
      bitRow(nodes, xid, 2 * ROW + 8, (bit) => (w.showXor ? String((x >> bit) & 1) : ''));
      decor.push(rowLabel('lab-xor', 2 * ROW + 8, 'XOR'));
    }
  }

  decor.push({
    id: 'docs-head',
    type: 'label',
    x: DOC_LEFT,
    y: HEAD_Y,
    text: s.docs.length ? 'Stored pages' : 'No pages stored yet',
    strong: true,
  });
  s.docs.forEach((d, i) => {
    const y = i * DOC_PITCH;
    nodes.push({ id: did(d.page), x: DOC_LEFT + DOC_W / 2, y, cells: [{ text: toBits(d.fp), w: DOC_W }] });
    decor.push({ id: `doc-name-${d.page}`, type: 'label', x: DOC_LEFT + DOC_W + 10, y: y + 5, text: `page ${d.page}`, strong: true });
    decor.push({ id: `doc-words-${d.page}`, type: 'label', x: DOC_LEFT, y: y + CELL_H / 2 + 16, text: d.words.join(' ') });
  });
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

const PAGE = { name: 'page', label: 'Page', kind: 'int', min: 1, max: PAGES.length } as const;
const OTHER = { name: 'other', label: 'Other page', kind: 'int', min: 1, max: PAGES.length } as const;

/** A library page that is not stored, if there is one. */
function unstoredPage(s: SimState): number {
  const free = PAGES.map((_, i) => i + 1).filter((n) => !stored(s, n));
  return free.length ? free[randomInt(0, free.length - 1)] : randomInt(1, PAGES.length);
}

/** Two stored pages. Half the time a pair that really are near copies, when there is one. */
function storedPair(s: SimState): [number, number] {
  const pages = s.docs.map((d) => d.page);
  if (pages.length < 2) return [pages[0] ?? 1, pages[0] ?? 2];
  const pairs: [number, number][] = [];
  for (const a of pages) for (const b of pages) if (a < b) pairs.push([a, b]);
  const copies = pairs.filter(([a, b]) => sameTopic(a, b));
  const pool = copies.length && randomInt(0, 1) === 0 ? copies : pairs;
  return pool[randomInt(0, pool.length - 1)];
}

/** Seed pages, and the pages the tour uses. The test pins the distances between them. */
export const TOUR_PAGE = 1;
export const TOUR_COPY = 2;
export const TOUR_OTHER = 7;
export const TOUR_NEW = 3;
/**
 * The page the tour compares against and the unrelated one are stored from the
 * start, so the tour fingerprints word by word only twice (a near copy, then a
 * new page to look up) and spends the rest of its time on the comparisons.
 */
export const SEED_PAGES = [4, 5, TOUR_PAGE, TOUR_OTHER];

const def: StructureDef<SimState> = {
  id: 'simhash',
  params: [
    {
      id: 'threshold',
      label: 'Near if this many bits apart or fewer',
      default: 2,
      options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  create: (params) => create(params.threshold ?? 2),
  seed: SEED_PAGES.map((n) => ['fingerprint', n] as [string, number]),
  ops: [
    {
      id: 'fingerprint',
      label: 'Fingerprint',
      intent: 'primary',
      args: [PAGE],
      code: ['add', 'fingerprint', 'word_hash'],
      run: (s, [n], rec) => void fingerprint(s, Number(n), rec),
      suggest: (s) => [unstoredPage(s)],
    },
    {
      id: 'compare',
      label: 'Compare',
      args: [PAGE, OTHER],
      code: ['is_near', 'hamming'],
      run: (s, [a, b], rec) => void compare(s, Number(a), Number(b), rec),
      suggest: (s) => storedPair(s),
    },
    {
      id: 'near',
      label: 'Find near copies',
      args: [PAGE],
      code: ['near', 'hamming', 'fingerprint', 'word_hash'],
      run: (s, [n], rec) => void near(s, Number(n), rec),
      suggest: (s) => [unstoredPage(s)],
    },
  ],
  layout,
  source: { python, java },
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'hashes', label: 'Words hashed' },
  ],
  status: (s) => [
    { label: 'Stored pages', value: String(s.docs.length) },
    { label: 'Fingerprint width', value: `${BITS} bits (real systems: 64)` },
    { label: 'Near-duplicate threshold', value: `${plural(s.threshold, 'bit')} (real systems: 3 of 64)` },
    { label: 'Unrelated pairs that would match', value: `about ${percent(chanceWithin(s.threshold))}` },
  ],
  tour: [
    ['fingerprint', TOUR_COPY],
    ['compare', TOUR_PAGE, TOUR_COPY],
    ['compare', TOUR_PAGE, TOUR_OTHER],
    ['near', TOUR_NEW],
  ],
  info,
};

export default def;
