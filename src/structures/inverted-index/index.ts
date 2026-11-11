import { LABEL_MAX } from '../../core/fit';
import { CELL_GAP, CELL_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/InvertedIndex.java?raw';
import python from './code/inverted_index.py?raw';
import { info } from './info';

/**
 * An inverted index as Lucene keeps one: a few immutable segments plus an
 * in-memory buffer.
 *
 * Each segment has a sorted term dictionary. Each term points to a postings
 * list: the ids of the documents that hold it, in doc id order, each with the
 * number of times the term appears (the term frequency). A new document is
 * analysed into terms and added to the buffer, which nobody can search. A
 * flush sorts the buffer and writes it out as a new segment, searchable from
 * then on. Segments are never changed: a delete only clears a bit in the
 * segment's live-docs set, and the space comes back when a merge copies two
 * segments into one and leaves the deleted documents behind.
 *
 * Simplifications, said on the page too: a document's id is its number in the
 * library (Lucene numbers documents in arrival order, per segment), the page
 * draws at most 3 segments and 5 documents, and the score is plain tf-idf.
 */

/** The documents a reader can pick, by number. Each is 4 to 6 words from a fixed vocabulary. */
export const LIBRARY: readonly string[] = [
  'The red fox runs',
  'The dog naps and naps',
  'A red fox sees a dog',
  'The cat sees the fox',
  'Fox sees the fox',
  'Red dog runs and runs',
  'The red cat naps',
  'A cat sees the dog',
];

export const STOP_WORDS: ReadonlySet<string> = new Set(['a', 'and', 'the']);
/** Segments the page draws. Lucene has no such limit: its merge policy keeps the count down. */
export const MAX_SEGMENTS = 3;
/** Documents the page holds at once, buffered or in a segment, deleted ones included until merged away. */
export const MAX_DOCS = 5;

export interface Posting {
  doc: number;
  tf: number;
}

export interface TermEntry {
  term: string;
  postings: Posting[];
}

export interface Segment {
  /** Stable identity for drawing. A flushed segment keeps its buffer's gen. */
  gen: number;
  /** Sorted by term in a segment; arrival order in the buffer, which is a hash table. */
  terms: TermEntry[];
  /** Doc ids, sorted in a segment, arrival order in the buffer. */
  docs: number[];
  /** Tombstones: docs whose live bit is 0. */
  deleted: number[];
  /** Set on a segment made by a merge, so its terms grow out of the merge's rows. */
  merged?: boolean;
}

export interface Row {
  doc: number;
  dead: boolean;
}

/** What the last operation worked out, drawn on the right. Never read by an operation. */
export type Work =
  | { kind: 'tokens'; doc: number; rows: { raw: string; text: string; stop: boolean | null }[] }
  | { kind: 'hits'; title: string; rows: Row[] }
  | { kind: 'walk'; op: 'and' | 'or'; a: string; b: string; seg: number; xs: Posting[]; ys: Posting[]; out: Row[]; candidates: number[] }
  | { kind: 'merge'; title: string; rows: { term: string; docs: (Posting & { dropped: boolean })[] }[] }
  | { kind: 'rank'; title: string; rows: { doc: number; score: number | null }[] };

export interface IndexState {
  /** Oldest first. */
  segments: Segment[];
  buffer: Segment;
  nextGen: number;
  work: Work | null;
}

export function create(): IndexState {
  return { segments: [], buffer: { gen: 0, terms: [], docs: [], deleted: [] }, nextGen: 1, work: null };
}

// ---- helpers ----------------------------------------------------------------

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: (string | number)[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : String(items[0] ?? '');
export const fmt = (p: Posting) => (p.tf > 1 ? `${p.doc}×${p.tf}` : String(p.doc));
const fmtList = (ps: Posting[]) => list(ps.map(fmt));
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
export const score3 = (x: number) => x.toFixed(3);
const segName = (k: number) => `segment ${k + 1}`;
const noSuchDoc = (n: number) => `There is no document ${n}. The library holds documents 1 to ${LIBRARY.length}.`;

/** The analyser: split on spaces and lower-case. Stop words are dropped by the caller. */
export const analyse = (text: string) => text.split(' ').map((raw) => ({ raw, text: raw.toLowerCase() }));
export const termsOf = (doc: number) => analyse(LIBRARY[doc - 1]).map((t) => t.text).filter((t) => !STOP_WORDS.has(t));

export const isLive = (seg: Segment, doc: number) => !seg.deleted.includes(doc);
/** Every doc the page holds: buffered, live or deleted but not yet merged away. */
export const heldDocs = (s: IndexState) => [...s.buffer.docs, ...s.segments.flatMap((g) => g.docs)];
export const liveDocs = (s: IndexState) => s.segments.flatMap((g) => g.docs.filter((d) => isLive(g, d))).sort((a, b) => a - b);
export const deletedCount = (s: IndexState) => s.segments.reduce((n, g) => n + g.deleted.length, 0);
const segmentOf = (s: IndexState, doc: number) => s.segments.findIndex((g) => g.docs.includes(doc));
const norm = (raw: number | string) => String(raw).trim().toLowerCase();

/** Binary search with no frames. Returns the postings (empty when missing) and the comparisons made. */
export function lookup(seg: Segment, term: string): { postings: Posting[]; comparisons: number } {
  let lo = 0;
  let hi = seg.terms.length - 1;
  let comparisons = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    comparisons++;
    const t = seg.terms[mid].term;
    if (term < t) hi = mid - 1;
    else if (term > t) lo = mid + 1;
    else return { postings: seg.terms[mid].postings, comparisons };
  }
  return { postings: [], comparisons };
}

// ---- ids ----------------------------------------------------------------------

const hid = (gen: number) => `h${gen}`;
const tid = (gen: number, term: string) => `t${gen}-${term}`;
const kid = (i: number) => `k${i}`;
const rid = (doc: number) => `r${doc}`;
const xid = (seg: number, i: number) => `x${seg}-${i}`;
const yid = (seg: number, i: number) => `y${seg}-${i}`;
const oid = (doc: number) => `o${doc}`;
const mid = (term: string) => `m-${term}`;

// ---- index and flush ----------------------------------------------------------

/** Analyse a library document and add it to the buffer. Returns false when nothing was added. */
export function index(s: IndexState, n: number, rec: Rec): boolean {
  rec.clearMarks();
  rec.line('known_test');
  const text = LIBRARY[n - 1];
  if (!Number.isInteger(n) || !text) {
    rec.step(noSuchDoc(n));
    return false;
  }
  if (heldDocs(s).includes(n)) {
    const k = segmentOf(s, n);
    rec.line('known_test', 'known');
    if (k >= 0 && !isLive(s.segments[k], n)) {
      rec.mark(hid(s.segments[k].gen), 'path');
      rec.step(
        `Document ${n} is deleted, but it still takes room in ${segName(k)} until a merge leaves it behind. Merge that segment, then index it again. Lucene does an update the same way: delete the old copy, add a new one.`,
      );
    } else {
      rec.mark(hid(k >= 0 ? s.segments[k].gen : s.buffer.gen), 'path');
      rec.step(`Document ${n} is already ${k >= 0 ? `in ${segName(k)}` : 'in the buffer'}. Each document is indexed once.`);
    }
    return false;
  }
  if (heldDocs(s).length >= MAX_DOCS) {
    rec.step(
      `This page holds at most ${MAX_DOCS} documents so the picture fits, counting deleted ones until a merge drops them. Delete a document and merge its segment to make room.`,
    );
    return false;
  }
  const work: Work = { kind: 'tokens', doc: n, rows: analyse(text).map((t) => ({ raw: t.raw, text: t.raw, stop: null })) };
  s.work = work;
  s.buffer.docs.push(n);
  rec.mark(hid(s.buffer.gen), 'ok');
  rec.line('known_test', 'start');
  rec.step(`Index document ${n}: “${text}”. The analyser splits it into words, one token per word, then turns each token into a term for the buffer.`);

  work.rows.forEach((row, i) => {
    const term = row.raw.toLowerCase();
    const lowered = term !== row.raw;
    row.text = term;
    if (STOP_WORDS.has(term)) {
      row.stop = true;
      rec.mark(kid(i), 'bad');
      rec.line('token', 'lower', 'stop');
      rec.step(
        `${lowered ? `Lower-case “${row.raw}” to “${term}”. ` : ''}“${term}” is a stop word: it is in almost every document, so it says nothing about this one. Drop it.`,
        { probe: { text: term, at: kid(i), place: 'left' } },
      );
      return;
    }
    row.stop = false;
    let entry = s.buffer.terms.find((e) => e.term === term);
    const isNew = !entry;
    if (!entry) {
      entry = { term, postings: [] };
      s.buffer.terms.push(entry);
    }
    const last = entry.postings[entry.postings.length - 1];
    const bump = last?.doc === n;
    if (bump) last.tf++;
    else entry.postings.push({ doc: n, tf: 1 });
    rec.count('writes');
    rec.mark(kid(i), 'path');
    rec.mark(tid(s.buffer.gen, term), 'ok');
    const lower = lowered ? `Lower-case “${row.raw}” to “${term}”, so a search for either finds it. ` : '';
    rec.line(...(bump ? ['lower', 'add', 'tf'] : ['token', 'lower', 'add', 'posting']));
    rec.step(
      bump
        ? `${lower}“${term}” already has document ${n} in the buffer, so its term frequency goes up to ${last.tf}. Ranking will use that count.`
        : isNew
          ? `${lower}“${term}” is new to the buffer: add it with document ${n}. The buffer is a hash table, not a sorted list: terms are sorted only when it is flushed.`
          : `${lower}“${term}” is in the buffer already: add document ${n} to its postings.`,
      { probe: { text: term, at: tid(s.buffer.gen, term) } },
    );
    rec.mark(tid(s.buffer.gen, term), 'path');
  });

  rec.clearMarks();
  rec.mark(hid(s.buffer.gen), 'ok');
  rec.line('done');
  const kept = work.rows.filter((r) => !r.stop).length;
  rec.step(
    `Document ${n} is in the buffer: ${plural(kept, 'term')} written, ${plural(work.rows.length - kept, 'stop word')} dropped. A search cannot find it yet: the buffer is not searchable until a flush writes it out.`,
  );
  return true;
}

/** Sort the buffer and write it out as a new, immutable, searchable segment. */
export function flush(s: IndexState, rec: Rec): boolean {
  rec.clearMarks();
  s.work = null;
  rec.line('empty');
  if (!s.buffer.docs.length) {
    rec.step('The buffer is empty: there is nothing to flush.');
    return false;
  }
  if (s.segments.length >= MAX_SEGMENTS) {
    for (const g of s.segments) rec.mark(hid(g.gen), 'path');
    rec.step(
      `This page draws at most ${MAX_SEGMENTS} segments. Merge two of them first. Lucene has no such limit: it flushes, and its merge policy merges segments in the background.`,
    );
    return false;
  }
  const b = s.buffer;
  b.terms.sort((x, y) => (x.term < y.term ? -1 : 1));
  for (const e of b.terms) e.postings.sort((x, y) => x.doc - y.doc);
  b.docs.sort((x, y) => x - y);
  rec.mark(hid(b.gen), 'compare');
  rec.line('sort');
  rec.step(
    `Flush. First sort the buffer's terms, ${list(b.terms.map((e) => e.term))}, and each postings list by doc id. Sorted terms are what let a search use binary search.`,
  );
  const k = s.segments.length;
  s.segments.push(b);
  s.buffer = { gen: s.nextGen++, terms: [], docs: [], deleted: [] };
  const postings = b.terms.reduce((n, e) => n + e.postings.length, 0);
  rec.count('writes', postings);
  rec.mark(hid(b.gen), 'ok');
  for (const e of b.terms) rec.mark(tid(b.gen, e.term), 'ok');
  rec.line('write', 'publish');
  rec.step(
    `Write it out as ${segName(k)}: ${plural(b.terms.length, 'term')}, ${plural(postings, 'posting')}. The segment is never changed again, and from now on searches see ${b.docs.length === 1 ? `document ${b.docs[0]}` : `documents ${list(b.docs)}`}. This is near real time: Elasticsearch refreshes once a second by default.`,
  );
  return true;
}

// ---- search -----------------------------------------------------------------------

/** Binary search one segment's dictionary, a frame per comparison. Returns the postings, or null when missing. */
function lookupShown(s: IndexState, k: number, term: string, rec: Rec): { postings: Posting[] | null; made: number } {
  const seg = s.segments[k];
  rec.mark(hid(seg.gen), 'path');
  let lo = 0;
  let hi = seg.terms.length - 1;
  let last = seg.terms[0];
  let made = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const e = seg.terms[m];
    last = e;
    made++;
    const probe: Probe = { text: term, at: tid(seg.gen, e.term) };
    rec.mark(tid(seg.gen, e.term), 'compare');
    const where = made === 1 ? `${segName(k)}: start with the middle term, “${e.term}”. ` : '';
    if (term < e.term) {
      rec.line('mid', 'test', 'go_left');
      rec.compare(term, '<', e.term, 'look left', {
        probe,
        message: `${where}“${term}” sorts before “${e.term}”, so if it is here it is to the left.`,
      });
      for (let i = m; i <= hi; i++) rec.mark(tid(seg.gen, seg.terms[i].term), 'dim');
      hi = m - 1;
    } else if (term > e.term) {
      rec.line('mid', 'test', 'test_more', 'go_right');
      rec.compare(term, '>', e.term, 'look right', {
        probe,
        message: `${where}“${term}” sorts after “${e.term}”, so if it is here it is to the right.`,
      });
      for (let i = lo; i <= m; i++) rec.mark(tid(seg.gen, seg.terms[i].term), 'dim');
      lo = m + 1;
    } else {
      rec.mark(tid(seg.gen, e.term), 'ok');
      rec.line('mid', 'test', 'test_more', 'found');
      rec.compare(term, '=', e.term, 'found', {
        probe,
        message: `${where}Found “${term}” in ${segName(k)} after ${plural(made, 'comparison')}. Its postings: ${fmtList(e.postings)}.`,
      });
      return { postings: e.postings, made };
    }
  }
  rec.line('missing');
  rec.step(`${segName(k)} has no “${term}”: the range is empty after ${plural(made, 'comparison')}. There is nothing to read here.`, {
    probe: { text: term, at: tid(seg.gen, last.term) },
  });
  return { postings: null, made };
}

/** Search one term. Returns the live doc ids that hold it, segment by segment. */
export function search(s: IndexState, raw: number | string, rec: Rec): number[] {
  rec.clearMarks();
  const term = norm(raw);
  const hits: number[] = [];
  const work: Work = { kind: 'hits', title: `hits for ${term}`, rows: [] };
  s.work = work;
  rec.line('search_start');
  if (STOP_WORDS.has(term)) {
    rec.line('search_start', 'stop_query');
    rec.step(`“${term}” is a stop word. The analyser drops it from queries as well as from documents, so it matches nothing.`);
    return hits;
  }
  if (!s.segments.length) {
    rec.line('segment');
    rec.step('There are no segments yet, so nothing is searchable. The buffer only becomes searchable when it is flushed.');
    return hits;
  }
  rec.line('segment');
  rec.step(
    `Search for “${term}”. Every segment has its own sorted term dictionary, so search each of the ${plural(s.segments.length, 'segment')} in turn with a binary search.`,
  );
  let made = 0;
  s.segments.forEach((seg, k) => {
    const r = lookupShown(s, k, term, rec);
    const found = r.postings;
    made += r.made;
    if (!found) {
      rec.mark(hid(seg.gen), 'dim');
      return;
    }
    rec.count('postings', found.length);
    const dead = found.filter((p) => !isLive(seg, p.doc)).map((p) => p.doc);
    for (const p of found) {
      const isDead = dead.includes(p.doc);
      work.rows.push({ doc: p.doc, dead: isDead });
      if (!isDead) hits.push(p.doc);
      rec.mark(rid(p.doc), isDead ? 'bad' : 'ok');
    }
    const live = found.filter((p) => !dead.includes(p.doc)).map((p) => p.doc);
    rec.line('postings', 'live', 'hit');
    rec.step(
      dead.length
        ? `Read the postings: ${fmtList(found)}. Check each against the live-docs set: ${plural(dead.length, 'document')} ${list(dead)} ${dead.length === 1 ? 'is' : 'are'} deleted, so ${dead.length === 1 ? 'it is' : 'they are'} left out.${live.length ? ` Hits: ${list(live)}.` : ''}`
        : `Read the postings: ${fmtList(found)}. ${found.length === 1 ? 'It is live, so it is a hit.' : 'All are live, so all are hits.'}`,
      { probe: { text: term, at: tid(seg.gen, term) } },
    );
  });
  const buffered = s.buffer.terms.find((e) => e.term === term);
  if (buffered) {
    rec.mark(hid(s.buffer.gen), 'compare');
    rec.mark(tid(s.buffer.gen, term), 'compare');
    rec.line('segment');
    rec.step(
      `The buffer holds “${term}” too, for ${plural(buffered.postings.length, 'document')} ${fmtList(buffered.postings)}, but search only reads segments. Those documents show up after the next flush.`,
    );
    rec.mark(hid(s.buffer.gen), 'idle');
    rec.mark(tid(s.buffer.gen, term), 'idle');
  }
  rec.line('hits');
  rec.step(
    `${hits.length ? `“${term}” is in ${hits.length === 1 ? `document ${hits[0]}` : `documents ${list(hits)}`}.` : `No searchable document holds “${term}”.`} That took ${plural(made, 'comparison')} over ${plural(s.segments.length, 'segment')}: each segment is a separate search, which is one reason to merge them.`,
  );
  return hits;
}

// ---- and / or -------------------------------------------------------------------------

/** AND or OR of two terms, a segment at a time, with two pointers. Returns live doc ids. */
export function combine(s: IndexState, op: 'and' | 'or', rawA: number | string, rawB: number | string, rec: Rec): number[] {
  rec.clearMarks();
  const a = norm(rawA);
  const b = norm(rawB);
  const and = op === 'and';
  const A = and ? 'and_' : 'or_';
  const name = `“${a}” ${op.toUpperCase()} “${b}”`;
  const hits: number[] = [];
  const work: Extract<Work, { kind: 'walk' }> = { kind: 'walk', op, a, b, seg: -1, xs: [], ys: [], out: [], candidates: [] };
  s.work = work;
  rec.line(`${A}segment`);
  if (!s.segments.length) {
    rec.line(and ? 'and_done' : 'or_done');
    rec.step('There are no segments yet, so nothing is searchable. Flush the buffer first.');
    return hits;
  }
  rec.step(
    and
      ? `${name}. In each segment, look up both postings lists, then walk them together with one pointer each. Both are sorted by doc id, so one pass finds every document on both.`
      : `${name}. In each segment, look up both postings lists, then walk them together with one pointer each, taking the smaller doc id each time, as merge sort does.`,
  );
  let docComparisons = 0;
  let termComparisons = 0;
  s.segments.forEach((seg, k) => {
    const la = lookup(seg, a);
    const lb = lookup(seg, b);
    rec.count('comparisons', la.comparisons + lb.comparisons);
    termComparisons += la.comparisons + lb.comparisons;
    const xs = la.postings;
    const ys = lb.postings;
    rec.count('postings', xs.length + ys.length);
    work.seg = seg.gen;
    work.xs = xs;
    work.ys = ys;
    work.candidates = [];
    rec.clearMarks();
    rec.mark(hid(seg.gen), 'path');
    if (xs.length) rec.mark(tid(seg.gen, a), 'path');
    if (ys.length) rec.mark(tid(seg.gen, b), 'path');
    const found = `${plural(la.comparisons + lb.comparisons, 'term comparison')}, as Search shows`;
    const has = (t: string, ps: Posting[]) => (ps.length ? `“${t}” is in ${list(ps.map((p) => p.doc))}` : `there is no “${t}”`);
    rec.line(`${A}segment`, `${A}lookup`);
    if (and && (!xs.length || !ys.length)) {
      const missing = !xs.length ? a : b;
      rec.mark(hid(seg.gen), 'dim');
      rec.step(`${segName(k)} has no “${missing}” (${found}), so no document in it can hold both. Skip the whole segment.`);
      return;
    }
    if (!and && !xs.length && !ys.length) {
      rec.mark(hid(seg.gen), 'dim');
      rec.step(`${segName(k)} holds neither term (${found}). Skip it.`);
      return;
    }
    rec.step(`${segName(k)}: ${has(a, xs)}; ${has(b, ys)} (${found}).`);

    let i = 0;
    let j = 0;
    while (i < xs.length && j < ys.length) {
      const x = xs[i].doc;
      const y = ys[j].doc;
      docComparisons++;
      rec.mark(xid(seg.gen, i), 'compare');
      rec.mark(yid(seg.gen, j), 'compare');
      const probe: Probe = { text: String(x), at: xid(seg.gen, i), place: 'left' };
      if (and) {
        if (x === y) {
          const live = isLive(seg, x);
          work.out.push({ doc: x, dead: !live });
          if (live) hits.push(x);
          rec.mark(oid(x), live ? 'ok' : 'bad');
          rec.mark(xid(seg.gen, i), live ? 'ok' : 'bad');
          rec.mark(yid(seg.gen, j), live ? 'ok' : 'bad');
          rec.line(...(live ? ['walk', 'cmp', 'and_live', 'match', 'advance'] : ['walk', 'cmp', 'and_live', 'advance']));
          rec.compare(x, '=', y, live ? 'a hit: move both pointers on' : 'deleted: move both pointers on', {
            probe,
            message: live
              ? `Both lists hold document ${x}, and it is live: a hit. Move both pointers on.`
              : `Both lists hold document ${x}, but it is deleted: its live bit is 0, so it is not a hit. Move both pointers on.`,
          });
          i++;
          j++;
        } else if (x < y) {
          rec.line('walk', 'cmp', 'cmp_less', 'skip_a');
          rec.compare(x, '<', y, `skip ${x}: move the ${a} pointer on`, {
            probe,
            message: `Document ${x} has “${a}”, but the “${b}” list is already at ${y}, so ${x} cannot be on both. Skip it: move the “${a}” pointer on.`,
          });
          rec.mark(xid(seg.gen, i), 'dim');
          i++;
        } else {
          rec.line('walk', 'cmp', 'cmp_less', 'skip_b');
          rec.compare(x, '>', y, `skip ${y}: move the ${b} pointer on`, {
            probe,
            message: `Document ${y} has “${b}”, but the “${a}” list is already at ${x}, so ${y} cannot be on both. Skip it: move the “${b}” pointer on.`,
          });
          rec.mark(yid(seg.gen, j), 'dim');
          j++;
        }
      } else {
        if (x === y) {
          work.candidates.push(x);
          rec.mark(xid(seg.gen, i), 'path');
          rec.mark(yid(seg.gen, j), 'path');
          rec.line('or_walk', 'or_cmp', 'or_both');
          rec.compare(x, '=', y, 'take it once, move both on', {
            probe,
            message: `Both lists hold document ${x}: take it once and move both pointers on.`,
          });
          i++;
          j++;
        } else if (x < y) {
          work.candidates.push(x);
          rec.mark(xid(seg.gen, i), 'path');
          rec.mark(yid(seg.gen, j), 'idle');
          rec.line('or_walk', 'or_cmp', 'or_less', 'take_x');
          rec.compare(x, '<', y, `take ${x}, move the ${a} pointer on`, {
            probe,
            message: `${x} is the smaller doc id: take it and move the “${a}” pointer on.`,
          });
          i++;
        } else {
          work.candidates.push(y);
          rec.mark(yid(seg.gen, j), 'path');
          rec.mark(xid(seg.gen, i), 'idle');
          rec.line('or_walk', 'or_cmp', 'or_less', 'take_y');
          rec.compare(x, '>', y, `take ${y}, move the ${b} pointer on`, {
            probe,
            message: `${y} is the smaller doc id: take it and move the “${b}” pointer on.`,
          });
          j++;
        }
      }
    }

    if (and) {
      const ran = i >= xs.length && j >= ys.length ? 'Both lists have' : `The “${i >= xs.length ? a : b}” list has`;
      rec.line('walk');
      rec.step(`${ran} run out, so nothing else in ${segName(k)} can be on both.`);
      return;
    }
    const rest = [...xs.slice(i), ...ys.slice(j)].map((p) => p.doc);
    if (rest.length) {
      for (let q = i; q < xs.length; q++) rec.mark(xid(seg.gen, q), 'path');
      for (let q = j; q < ys.length; q++) rec.mark(yid(seg.gen, q), 'path');
      work.candidates.push(...rest);
      rec.line('or_walk', 'rest');
      rec.step(
        `${!xs.length || !ys.length ? `Only one term is in ${segName(k)}, so there is nothing to compare.` : 'One list has run out.'} The rest of the other list needs no comparisons: take ${list(rest)}.`,
      );
    }
    const dead = work.candidates.filter((d) => !isLive(seg, d));
    for (const d of work.candidates) {
      const isDead = dead.includes(d);
      work.out.push({ doc: d, dead: isDead });
      if (!isDead) hits.push(d);
      rec.mark(oid(d), isDead ? 'bad' : 'ok');
    }
    work.candidates = [];
    rec.line('rest', 'or_live');
    rec.step(
      dead.length
        ? `Check each against the live-docs set: ${list(dead)} ${dead.length === 1 ? 'is' : 'are'} deleted and left out.`
        : `All of them are live, so all are hits.`,
    );
  });

  rec.clearMarks();
  for (const r of work.out) rec.mark(oid(r.doc), r.dead ? 'bad' : 'ok');
  rec.line(and ? 'and_done' : 'or_done');
  const result = hits.length ? (hits.length === 1 ? `document ${hits[0]}` : `documents ${list(hits)}`) : 'no document';
  rec.step(
    and
      ? `${name} matches ${result}: ${plural(docComparisons, 'doc id comparison')} and ${plural(termComparisons, 'term comparison')}. The walk costs at most the two lists' lengths added. When one list is far shorter, Lucene uses skip data to jump ahead in the long one instead of stepping through it.`
      : `${name} matches ${result}: ${plural(docComparisons, 'doc id comparison')} and ${plural(termComparisons, 'term comparison')}. An OR has to visit every entry of both lists, so it costs more than an AND.`,
  );
  return hits;
}

// ---- delete and merge -------------------------------------------------------------------

/** Delete a document with a tombstone. Returns false when nothing changed. */
export function remove(s: IndexState, n: number, rec: Rec): boolean {
  rec.clearMarks();
  s.work = null;
  rec.line('not_found');
  if (!Number.isInteger(n) || !LIBRARY[n - 1]) {
    rec.step(noSuchDoc(n));
    return false;
  }
  if (s.buffer.docs.includes(n)) {
    rec.mark(hid(s.buffer.gen), 'path');
    rec.step(
      `Document ${n} is still in the buffer, not in a segment. Lucene would remember the delete and apply it when the buffer is flushed. This page asks you to flush first.`,
    );
    return false;
  }
  if (segmentOf(s, n) < 0) {
    rec.step(`Document ${n} is not in the index, so there is nothing to delete.`);
    return false;
  }
  for (let k = 0; k < s.segments.length; k++) {
    const seg = s.segments[k];
    const at = seg.docs.indexOf(n);
    const probe: Probe = { text: String(n), at: hid(seg.gen) };
    if (at < 0) {
      rec.mark(hid(seg.gen), 'dim');
      rec.line('find', 'find_test');
      rec.step(`Document ${n} is not in ${segName(k)}.`, { probe });
      continue;
    }
    probe.cell = at;
    if (!isLive(seg, n)) {
      rec.mark(hid(seg.gen), 'path');
      rec.line('find', 'find_test', 'not_found');
      rec.step(`Document ${n} is in ${segName(k)} but already deleted. Its tombstone stays until a merge leaves it behind.`, { probe });
      return false;
    }
    rec.mark(hid(seg.gen), 'path');
    rec.markCell(hid(seg.gen), at, 'compare');
    rec.line('find', 'find_test');
    rec.step(`Document ${n} is in ${segName(k)}.`, { probe });
    seg.deleted.push(n);
    rec.count('writes');
    rec.markCell(hid(seg.gen), at, 'idle');
    const terms = seg.terms.filter((e) => e.postings.some((p) => p.doc === n)).map((e) => `“${e.term}”`);
    rec.line('tombstone');
    rec.step(
      `Clear document ${n}'s bit in ${segName(k)}'s live-docs set: a tombstone. The segment is immutable, so nothing else changes: ${list(terms)} still list ${n}, and every search skips it from now on. The space comes back when a merge copies the segment without it.`,
      { probe },
    );
    return true;
  }
  return false;
}

/** Merge segment k (from 1) with the next one, leaving deleted documents behind. */
export function merge(s: IndexState, k1: number, rec: Rec): boolean {
  rec.clearMarks();
  s.work = null;
  rec.line('merge_start');
  const count = s.segments.length;
  if (count < 2) {
    rec.step(count ? 'There is only one segment, so there is nothing to merge it with.' : 'There are no segments to merge yet.');
    return false;
  }
  const k = k1 - 1;
  if (!Number.isInteger(k1) || k < 0 || k >= count - 1) {
    rec.step(`Merge joins a segment with the next one, so pick ${count === 2 ? 'segment 1' : `a segment from 1 to ${count - 1}`}.`);
    return false;
  }
  const A = s.segments[k];
  const B = s.segments[k + 1];
  const work: Extract<Work, { kind: 'merge' }> = { kind: 'merge', title: `new segment`, rows: [] };
  s.work = work;
  rec.mark(hid(A.gen), 'path');
  rec.mark(hid(B.gen), 'path');
  const dead = [...A.deleted, ...B.deleted].sort((x, y) => x - y);
  rec.step(
    `Merge ${segName(k)} and ${segName(k + 1)} into one new segment. Both term dictionaries are sorted, so walk them together as merge sort does, copying each term's postings${dead.length ? ` without the deleted ${dead.length === 1 ? `document ${dead[0]}` : `documents ${list(dead)}`}` : ''}.`,
  );

  let read = 0;
  let written = 0;
  const copy = (sources: { seg: Segment; e: TermEntry }[]) => {
    const docs: (Posting & { dropped: boolean })[] = [];
    for (const { seg, e } of sources) {
      read += e.postings.length;
      for (const p of e.postings) docs.push({ ...p, dropped: !isLive(seg, p.doc) });
    }
    docs.sort((x, y) => x.doc - y.doc);
    const term = sources[0].e.term;
    const kept = docs.filter((d) => !d.dropped);
    written += kept.length;
    work.rows.push({ term, docs });
    const gone = docs.filter((d) => d.dropped).map((d) => d.doc);
    const drop = gone.length
      ? kept.length
        ? ` ${gone.length === 1 ? `Document ${gone[0]} is` : `Documents ${list(gone)} are`} deleted, so ${gone.length === 1 ? 'it is' : 'they are'} not copied.`
        : ` Every document with “${term}” is deleted, so the term is left out of the new segment altogether.`
      : '';
    return { term, kept, gone, drop };
  };

  let i = 0;
  let j = 0;
  while (i < A.terms.length || j < B.terms.length) {
    const ea = A.terms[i];
    const eb = B.terms[j];
    if (ea && eb) {
      rec.mark(tid(A.gen, ea.term), 'compare');
      rec.mark(tid(B.gen, eb.term), 'compare');
      const probe: Probe = { text: ea.term, at: tid(A.gen, ea.term) };
      if (ea.term < eb.term) {
        const r = copy([{ seg: A, e: ea }]);
        rec.mark(mid(r.term), r.kept.length ? 'ok' : 'bad');
        rec.line(...['merge_walk', 'merge_cmp', 'take_a', ...(r.kept.length ? ['keep'] : []), ...(r.gone.length ? ['drop'] : [])]);
        rec.compare(ea.term, '<', eb.term, `copy ${ea.term} from ${segName(k)}`, {
          probe,
          message: `“${ea.term}” sorts before “${eb.term}”, so it comes next: copy it from ${segName(k)}.${r.drop}`,
        });
        rec.mark(tid(A.gen, ea.term), 'path');
        rec.mark(tid(B.gen, eb.term), 'idle');
        i++;
      } else if (ea.term > eb.term) {
        const r = copy([{ seg: B, e: eb }]);
        rec.mark(mid(r.term), r.kept.length ? 'ok' : 'bad');
        rec.line(...['merge_walk', 'merge_cmp', 'merge_cmp_more', 'take_b', ...(r.kept.length ? ['keep'] : []), ...(r.gone.length ? ['drop'] : [])]);
        rec.compare(ea.term, '>', eb.term, `copy ${eb.term} from ${segName(k + 1)}`, {
          probe,
          message: `“${eb.term}” sorts before “${ea.term}”, so it comes next: copy it from ${segName(k + 1)}.${r.drop}`,
        });
        rec.mark(tid(B.gen, eb.term), 'path');
        rec.mark(tid(A.gen, ea.term), 'idle');
        j++;
      } else {
        const r = copy([{ seg: A, e: ea }, { seg: B, e: eb }]);
        rec.mark(mid(r.term), r.kept.length ? 'ok' : 'bad');
        rec.line(...['merge_walk', 'merge_cmp', 'merge_cmp_more', 'same', ...(r.kept.length ? ['keep'] : []), ...(r.gone.length ? ['drop'] : [])]);
        rec.compare(ea.term, '=', eb.term, `join both ${ea.term} lists`, {
          probe,
          message: `Both segments have “${ea.term}”: join the two postings lists in doc id order.${r.drop}`,
        });
        rec.mark(tid(A.gen, ea.term), 'path');
        rec.mark(tid(B.gen, eb.term), 'path');
        i++;
        j++;
      }
    } else {
      const fromA = !!ea;
      const e = (ea ?? eb)!;
      const g = fromA ? A : B;
      const r = copy([{ seg: g, e }]);
      rec.mark(tid(g.gen, e.term), 'compare');
      rec.mark(mid(r.term), r.kept.length ? 'ok' : 'bad');
      rec.line(...['merge_walk', fromA ? 'take_a' : 'take_b', ...(r.kept.length ? ['keep'] : []), ...(r.gone.length ? ['drop'] : [])]);
      rec.step(
        `${segName(fromA ? k + 1 : k)} has no terms left, so there is nothing to compare: copy “${e.term}” from ${segName(fromA ? k : k + 1)}.${r.drop}`,
        { probe: { text: e.term, at: tid(g.gen, e.term) } },
      );
      rec.mark(tid(g.gen, e.term), 'path');
      if (fromA) i++;
      else j++;
    }
  }

  rec.count('postings', read);
  rec.count('writes', written);
  const docs = [...A.docs.filter((d) => isLive(A, d)), ...B.docs.filter((d) => isLive(B, d))].sort((x, y) => x - y);
  const merged: Segment = {
    gen: s.nextGen++,
    terms: work.rows
      .map((r) => ({ term: r.term, postings: r.docs.filter((d) => !d.dropped).map(({ doc, tf }) => ({ doc, tf })) }))
      .filter((e) => e.postings.length),
    docs,
    deleted: [],
    merged: true,
  };
  s.segments.splice(k, 2, ...(docs.length ? [merged] : []));
  s.work = null;
  rec.clearMarks();
  rec.line('replace');
  if (!docs.length) {
    rec.step(`Every document in both segments was deleted, so the merge leaves no segment at all: ${plural(read, 'posting')} read, none written.`);
    return true;
  }
  rec.mark(hid(merged.gen), 'ok');
  rec.step(
    `The new segment replaces both, holding ${plural(docs.length, 'document')}${dead.length ? `. ${dead.length === 1 ? `Document ${dead[0]} is` : `Documents ${list(dead)} are`} gone for good` : ''}. The merge read ${plural(read, 'posting')} and wrote ${written}: it rewrites everything it touches, which is why Lucene merges in the background, a few segments of similar size at a time.`,
  );
  return true;
}

// ---- rank ------------------------------------------------------------------------------

/** Score the live documents that hold either term with tf-idf, best first. Returns doc ids. */
export function rank(s: IndexState, rawA: number | string, rawB: number | string, rec: Rec): number[] {
  rec.clearMarks();
  const query = [...new Set([norm(rawA), norm(rawB)])];
  const work: Extract<Work, { kind: 'rank' }> = { kind: 'rank', title: 'scores', rows: [] };
  s.work = work;
  const n = liveDocs(s).length;
  rec.line('count');
  if (!n) {
    rec.step('No live document is in a segment yet, so there is nothing to rank. Flush the buffer first.');
    return [];
  }
  const q = query.map((t) => `“${t}”`).join(' or ');
  rec.step(
    `Rank the documents that hold ${q}. A document scores tf × idf for each query term, added up. tf is how often the term is in it; idf = log10(N / df), where df is how many documents hold the term and N = ${n}, the live documents.`,
  );
  const tfs = new Map<string, Map<number, number>>(query.map((t) => [t, new Map()]));
  s.segments.forEach((seg, k) => {
    const parts: string[] = [];
    const dead: number[] = [];
    let made = 0;
    for (const t of query) {
      const r = lookup(seg, t);
      made += r.comparisons;
      rec.count('comparisons', r.comparisons);
      rec.count('postings', r.postings.length);
      if (r.postings.length) {
        parts.push(`“${t}” in ${fmtList(r.postings)}`);
        rec.mark(tid(seg.gen, t), 'path');
      }
      for (const p of r.postings) {
        if (!isLive(seg, p.doc)) {
          if (!dead.includes(p.doc)) dead.push(p.doc);
          continue;
        }
        tfs.get(t)!.set(p.doc, p.tf);
        if (!work.rows.some((row) => row.doc === p.doc)) work.rows.push({ doc: p.doc, score: null });
      }
    }
    rec.mark(hid(seg.gen), parts.length ? 'path' : 'dim');
    rec.line('gather');
    rec.step(
      `${segName(k)}: ${parts.length ? parts.join('; ') : 'neither term'} (${plural(made, 'term comparison')}).${dead.length ? ` ${list(dead)} ${dead.length === 1 ? 'is' : 'are'} deleted and skipped.` : ''}`,
    );
  });
  work.rows.sort((x, y) => x.doc - y.doc);

  const idf = new Map<string, number>();
  for (const t of query) {
    const df = tfs.get(t)!.size;
    if (df) idf.set(t, Math.log10(n / df));
  }
  rec.line('idf');
  rec.step(
    query
      .map((t) => {
        const df = tfs.get(t)!.size;
        return df
          ? `“${t}” is in ${df} of ${n}: idf = log10(${n} / ${df}) = ${score3(idf.get(t)!)}.`
          : `“${t}” is in no live document, so it adds nothing.`;
      })
      .join(' ') + (idf.size === 2 && [...idf.values()][0] !== [...idf.values()][1] ? ' The rarer term is worth more.' : ''),
  );

  const scores = new Map<number, number>();
  for (const row of work.rows) {
    let score = 0;
    const parts: string[] = [];
    for (const [t, w] of idf) {
      const tf = tfs.get(t)!.get(row.doc) ?? 0;
      score += tf * w;
      if (tf) parts.push(`“${t}” ${times(tf)}, ${tf} × ${score3(w)}`);
    }
    row.score = score;
    scores.set(row.doc, score);
    rec.mark(rid(row.doc), 'ok');
    rec.line('score');
    rec.step(`Document ${row.doc}: ${parts.join('; plus ')}. Score ${score3(score)}.`, {
      probe: { text: String(row.doc), at: rid(row.doc), place: 'left' },
    });
  }
  const order = work.rows.map((r) => r.doc).sort((x, y) => scores.get(y)! - scores.get(x)! || x - y);
  work.rows.sort((x, y) => order.indexOf(x.doc) - order.indexOf(y.doc));
  rec.line('sort');
  if (!order.length) {
    rec.step(`No live document holds ${q}.`);
    return order;
  }
  const top = order[0];
  const ranked =
    order.length === 1
      ? `Only document ${top} matches, with ${score3(scores.get(top)!)}`
      : `Best first: ${order.map((d) => `${d} (${score3(scores.get(d)!)})`).join(', ')}`;
  rec.step(
    `${ranked}. A real engine keeps only the top k in a heap. Lucene and Elasticsearch score with BM25 by default: like tf-idf, but each repeat of a term adds less than the one before, and long documents count for less.`,
  );
  return order;
}

// ---- layout ---------------------------------------------------------------------------

/** Vertical distance between bands: a segment's terms and the postings under them. */
const BAND = 96;
const BUFFER_Y = MAX_SEGMENTS * BAND;
/** Doc id cells in a band's header. */
const DOC_W = 24;
const HEADER_CX = 70;
const TERM_W = 58;
const TERM_PITCH = 66;
const TERMS_X = 2 * HEADER_CX + 14;
/** Left edge of the working column on the right. */
const WORK_X = 672;
const WORK_ROW = 40;
/** Rows that are trays of several cells are taller. */
const TRAY_ROW = 48;
const WORK_COL = 56;
const TOP = -18 - 44 - LABEL_MAX - 6;
const LEFT = 0;
const RIGHT = 820;
const BOTTOM = BUFFER_Y + CELL_H / 2 + LABEL_MAX + 10;

const trayLeft = (x: number, cells: number[]) => x + (4 + cells.reduce((w, c) => w + c, 0) + CELL_GAP * (cells.length - 1) + 4) / 2;
const oneCell = (x: number, w: number) => x + w / 2;

function band(seg: Segment, y: number, title: string, nodes: SceneNode[], caption?: string): void {
  const cells = seg.docs.length
    ? seg.docs.map((d) => ({ text: String(d), w: DOC_W, tone: isLive(seg, d) ? undefined : ('bad' as const) }))
    : [{ text: '', w: DOC_W }];
  nodes.push({ id: hid(seg.gen), x: HEADER_CX, y, cells, title, caption });
  seg.terms.forEach((e, i) => {
    nodes.push({
      id: tid(seg.gen, e.term),
      x: TERMS_X + i * TERM_PITCH + TERM_W / 2,
      y,
      cells: [{ text: e.term, w: TERM_W, sub: e.postings.map(fmt).join(' '), subValue: true }],
      from: seg.merged ? mid(e.term) : undefined,
    });
  });
}

export function layout(s: IndexState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [
    // Two empty labels pin the corners, so the view does not rescale as segments come and go.
    { id: 'corner-a', type: 'label', x: LEFT, y: TOP, text: '' },
    { id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' },
  ];
  s.segments.forEach((seg, k) => band(seg, k * BAND, `segment ${k + 1}`, nodes));
  band(s.buffer, BUFFER_Y, 'buffer', nodes, 'not searchable');
  if (!s.segments.length) decor.push({ id: 'no-seg', type: 'label', x: TERMS_X, y: 5, text: 'No segments yet: index\na document and flush.' });
  if (!s.buffer.terms.length) decor.push({ id: 'buf-empty', type: 'label', x: TERMS_X, y: BUFFER_Y + 5, text: 'empty' });

  const w = s.work;
  const title = (text: string) => decor.push({ id: 'work-title', type: 'label', x: WORK_X, y: -62, text, strong: true });
  const head = (id: string, x: number, text: string) => decor.push({ id, type: 'label', x, y: -32, text, anchor: 'middle' });
  if (!w) {
    decor.push({ id: 'legend', type: 'label', x: WORK_X, y: 0, text: 'Under each term:\nits postings.\n5×2 = document 5,\nterm twice.' });
  } else if (w.kind === 'tokens') {
    title(`document ${w.doc}`);
    w.rows.forEach((r, i) => {
      nodes.push({ id: kid(i), x: oneCell(WORK_X, TERM_W), y: i * WORK_ROW, cells: [{ text: r.text, w: TERM_W, tone: r.stop ? 'bad' : undefined }] });
    });
  } else if (w.kind === 'hits') {
    title(w.title);
    w.rows.forEach((r, i) => {
      nodes.push({ id: rid(r.doc), x: oneCell(WORK_X, DOC_W + 4), y: i * WORK_ROW, cells: [{ text: String(r.doc), w: DOC_W + 4, tone: r.dead ? 'bad' : 'ok' }] });
      if (r.dead) decor.push({ id: `hit-${r.doc}`, type: 'label', x: WORK_X + DOC_W + 14, y: i * WORK_ROW + 5, text: 'deleted' });
    });
  } else if (w.kind === 'walk') {
    title(`${w.a} ${w.op.toUpperCase()} ${w.b}`);
    const colX = (c: number) => oneCell(WORK_X + c * WORK_COL, DOC_W + 4);
    head('col-a', colX(0), w.a);
    head('col-b', colX(1), w.b);
    head('col-out', colX(2), 'hits');
    w.xs.forEach((p, i) => nodes.push({ id: xid(w.seg, i), x: colX(0), y: i * WORK_ROW, cells: [{ text: String(p.doc), w: DOC_W + 4 }] }));
    w.ys.forEach((p, i) => nodes.push({ id: yid(w.seg, i), x: colX(1), y: i * WORK_ROW, cells: [{ text: String(p.doc), w: DOC_W + 4 }] }));
    w.out.forEach((r, i) =>
      nodes.push({ id: oid(r.doc), x: colX(2), y: i * WORK_ROW, cells: [{ text: String(r.doc), w: DOC_W + 4, tone: r.dead ? 'bad' : 'ok' }] }),
    );
    w.candidates.forEach((d, i) =>
      nodes.push({ id: oid(d), x: colX(2), y: (w.out.length + i) * WORK_ROW, cells: [{ text: String(d), w: DOC_W + 4, tone: 'path' }] }),
    );
  } else if (w.kind === 'merge') {
    title(w.title);
    w.rows.forEach((r, i) => {
      const cells = [{ text: r.term, w: TERM_W }, ...r.docs.map((d) => ({ text: fmt(d), w: d.tf > 1 ? 38 : DOC_W, tone: d.dropped ? ('bad' as const) : undefined }))];
      nodes.push({ id: mid(r.term), x: trayLeft(WORK_X - 56, cells.map((c) => c.w)), y: i * TRAY_ROW, cells });
    });
  } else {
    title(w.title);
    w.rows.forEach((r, i) => {
      nodes.push({
        id: rid(r.doc),
        x: trayLeft(WORK_X, [DOC_W + 4, 66]),
        y: i * TRAY_ROW,
        cells: [{ text: String(r.doc), w: DOC_W + 4 }, { text: r.score == null ? '' : score3(r.score), w: 66 }],
      });
    });
  }
  return { nodes, edges: [], decor };
}

// ---- definition -------------------------------------------------------------------------

const DOC = { name: 'doc', label: `Document (1 to ${LIBRARY.length})`, kind: 'int', min: 1, max: LIBRARY.length } as const;
const TERM = { name: 'term', label: 'Term', kind: 'word' } as const;
const OTHER = { name: 'other', label: 'Second term', kind: 'word' } as const;
const SEGMENT = { name: 'segment', label: 'Segment (merged with the next)', kind: 'int', min: 1, max: MAX_SEGMENTS - 1 } as const;

const pick = <T>(xs: readonly T[]): T => xs[randomInt(0, xs.length - 1)];
const segTerms = (s: IndexState) => [...new Set(s.segments.flatMap((g) => g.terms.map((e) => e.term)))].sort();
const VOCAB = [...new Set(LIBRARY.flatMap((_, i) => termsOf(i + 1)))].sort();

function suggestTerm(s: IndexState): string {
  const terms = segTerms(s);
  return terms.length ? pick(terms) : pick(VOCAB);
}

/** Two different terms, ideally ones that share a document. */
function suggestPair(s: IndexState): [string, string] {
  const docs = liveDocs(s);
  const pairs: [string, string][] = [];
  for (const d of docs) {
    const ts = [...new Set(termsOf(d))];
    for (const x of ts) for (const y of ts) if (x < y) pairs.push([x, y]);
  }
  if (pairs.length) return pick(pairs);
  const a = suggestTerm(s);
  return [a, pick(VOCAB.filter((t) => t !== a))];
}

function suggestMerge(s: IndexState): number {
  if (s.segments.length < 2) return 1;
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k + 1 < s.segments.length; k++) {
    const a = s.segments[k];
    const b = s.segments[k + 1];
    // Favour reclaiming deletes, then small merges, as Lucene's tiered policy does.
    const score = (a.deleted.length + b.deleted.length) * 10 - a.docs.length - b.docs.length;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best + 1;
}

export const SEED: [string, ...(number | string)[]][] = [
  ['index', 1],
  ['index', 2],
  ['index', 3],
  ['flush'],
  ['index', 4],
  ['flush'],
];

const def: StructureDef<IndexState> = {
  id: 'inverted-index',
  create: () => create(),
  seed: SEED,
  ops: [
    {
      id: 'index',
      label: 'Index',
      intent: 'primary',
      args: [DOC],
      code: ['index'],
      run: (s, [n], rec) => void index(s, Number(n), rec),
      suggest: (s) => {
        const held = heldDocs(s);
        const free = LIBRARY.map((_, i) => i + 1).filter((d) => !held.includes(d));
        return [free.length ? pick(free) : randomInt(1, LIBRARY.length)];
      },
    },
    {
      id: 'flush',
      label: 'Flush',
      args: [],
      code: ['flush'],
      run: (s, _args, rec) => void flush(s, rec),
      suggest: () => [],
    },
    {
      id: 'search',
      label: 'Search',
      intent: 'primary',
      args: [TERM],
      code: ['search', 'lookup'],
      run: (s, [t], rec) => void search(s, t, rec),
      suggest: (s) => [suggestTerm(s)],
    },
    {
      id: 'and',
      label: 'AND',
      args: [TERM, OTHER],
      code: ['and', 'lookup'],
      run: (s, [a, b], rec) => void combine(s, 'and', a, b, rec),
      suggest: (s) => suggestPair(s),
    },
    {
      id: 'or',
      label: 'OR',
      args: [TERM, OTHER],
      code: ['or', 'lookup'],
      run: (s, [a, b], rec) => void combine(s, 'or', a, b, rec),
      suggest: (s) => suggestPair(s),
    },
    {
      id: 'delete',
      label: 'Delete',
      intent: 'danger',
      args: [DOC],
      code: ['delete'],
      run: (s, [n], rec) => void remove(s, Number(n), rec),
      suggest: (s) => {
        const live = liveDocs(s);
        return [live.length ? pick(live) : randomInt(1, LIBRARY.length)];
      },
    },
    {
      id: 'merge',
      label: 'Merge',
      args: [SEGMENT],
      code: ['merge', 'live_postings'],
      run: (s, [k], rec) => void merge(s, Number(k), rec),
      suggest: (s) => [suggestMerge(s)],
    },
    {
      id: 'rank',
      label: 'Rank',
      args: [TERM, OTHER],
      code: ['rank', 'lookup'],
      run: (s, [a, b], rec) => void rank(s, a, b, rec),
      suggest: (s) => suggestPair(s),
    },
  ],
  layout,
  source: { python, java },
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'postings', label: 'Postings read' },
    { key: 'writes', label: 'Postings written' },
  ],
  status: (s) => {
    const held = heldDocs(s);
    const free = LIBRARY.map((_, i) => i + 1).filter((d) => !held.includes(d));
    return [
      { label: 'Segments', value: `${s.segments.length} of ${MAX_SEGMENTS} drawn` },
      { label: 'Searchable documents', value: `${liveDocs(s).length}${deletedCount(s) ? `, plus ${deletedCount(s)} deleted` : ''}` },
      { label: 'In the buffer', value: s.buffer.docs.length ? `${plural(s.buffer.docs.length, 'document')}, not searchable` : 'nothing' },
      { label: 'Not yet indexed', value: free.length ? list(free) : 'none' },
    ];
  },
  tour: [
    ['index', 5],
    ['flush'],
    ['search', 'dog'],
    ['and', 'fox', 'dog'],
    ['delete', 3],
    ['merge', 1],
    ['rank', 'fox', 'red'],
  ],
  info,
};

export default def;
