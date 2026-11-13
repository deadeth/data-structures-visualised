import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_H, cellWidth, cellsWidth } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneNode, StructureDef, VarValue } from '../../core/types';
import java from './code/Partitioning.java?raw';
import python from './code/partitioning.py?raw';
import { info } from './info';

/**
 * Partitioning a table, and indexing it by a second attribute.
 *
 * The table is a set of rows: an integer key from 0 to 999 and a city. It is
 * split into partitions, each held by one node, in one of two ways:
 *
 * - range: each partition owns a run of keys. Boundaries are sorted, so a key
 *   is routed by comparing it with them. An over-full partition splits at its
 *   median and the new half can go to another node.
 * - hash: a key goes to partition h(key) mod P, where P is fixed when the
 *   table is made (2 per starting node). Partitions are handed out to nodes
 *   whole; rebalancing moves partitions, never single keys.
 *
 * Rows are indexed by city in one of two ways: a local index in each
 * partition, covering only that partition's rows, or a global index that is
 * itself partitioned by city (term), so one city lives in one place.
 *
 * The page keeps one set of rows and the settings of both schemes, and draws
 * whichever scheme and index the last operation used. A real table is
 * partitioned one way: changing scheme means rewriting every row. Indexes are
 * worked out from the rows, so they are always up to date here; a real global
 * index is updated asynchronously and can lag.
 */
export type Scheme = 'range' | 'hash';
export type IndexKind = 'local' | 'global';

export const CITIES = ['Lima', 'Oslo', 'Rome'] as const;
export const NODE_NAMES = 'ABCD';
export const MAX_NODES = 4;
export const MAX_KEY = 999;
/** Rows drawn in one partition. A real partition is bounded by bytes, not by a page. */
export const MAX_ROWS = 7;
/** Rows drawn in the whole table. */
export const MAX_TOTAL = 21;
/** A range partition with fewer rows than this is not worth splitting. */
export const SPLIT_MIN = 4;
export const MAX_RANGE_PARTS = 8;
/** Sequential keys written by Hot. */
export const HOT_RUN = 4;
/** Sensors that lead the prefixed keys: the hundreds digit. */
export const SENSORS = [1, 4, 7] as const;
/**
 * Global index partitions, by first letter of the city. Partition i lives on
 * node i. The index has its own partitioning, independent of the rows'.
 */
export const TERM_STARTS = ['A', 'M', 'P'] as const;
export const TERM_LABELS = ['A–L', 'M–O', 'P–Z'] as const;

/** Small enough to work out by hand. Real stores use murmur3, MD5 or CRC16 over the key's bytes. */
export const hashKey = (key: number): number => (37 * key + 11) % 100;

export interface RangePart {
  id: number;
  /** Smallest key this partition owns. The next partition's lo, less one, is its largest. */
  lo: number;
  node: number;
}

export interface PState {
  rows: Map<number, string>;
  /** What the page draws now. */
  scheme: Scheme;
  index: IndexKind;
  /** Nodes at the start: 3 or 4. Range starts with one partition per node, hash with two. */
  start: number;
  range: { parts: RangePart[]; nodes: number; nextId: number };
  /** owner[p] is the node holding hash partition p. P = owner.length never changes. */
  hash: { owner: number[]; nodes: number };
}

export function create(start = 3, scheme: Scheme = 'range', index: IndexKind = 'local'): PState {
  const width = Math.ceil((MAX_KEY + 1) / start / 50) * 50;
  const parts: RangePart[] = Array.from({ length: start }, (_, i) => ({ id: i, lo: i * width, node: i }));
  return {
    rows: new Map(),
    scheme,
    index,
    start,
    range: { parts, nodes: start, nextId: start },
    hash: { owner: Array.from({ length: start * 2 }, (_, p) => p % start), nodes: start },
  };
}

// ---- views ------------------------------------------------------------------

/** One partition as the page draws it, under whichever scheme is in use. */
export interface PartView {
  pid: string;
  label: string;
  node: number;
  /** Position in key order (range) or partition number (hash). */
  order: number;
  keys: number[];
  lo?: number;
  hi?: number;
}

const sortedKeys = (s: PState) => [...s.rows.keys()].sort((a, b) => a - b);

export function views(s: PState, scheme: Scheme = s.scheme): PartView[] {
  const keys = sortedKeys(s);
  if (scheme === 'range') {
    const ps = s.range.parts;
    return ps.map((p, i) => {
      const hi = i + 1 < ps.length ? ps[i + 1].lo - 1 : MAX_KEY;
      return { pid: `r${p.id}`, label: `P${p.id}`, node: p.node, order: i, lo: p.lo, hi, keys: keys.filter((k) => k >= p.lo && k <= hi) };
    });
  }
  const P = s.hash.owner.length;
  return s.hash.owner.map((node, p) => ({ pid: `h${p}`, label: `P${p}`, node, order: p, keys: keys.filter((k) => hashKey(k) % P === p) }));
}

export function partOf(s: PState, key: number, scheme: Scheme = s.scheme): PartView {
  const vs = views(s, scheme);
  if (scheme === 'hash') return vs[hashKey(key) % vs.length];
  let at = vs[0];
  for (const v of vs) if (key >= v.lo!) at = v;
  return at;
}

export const nodeCount = (s: PState, scheme: Scheme = s.scheme) => (scheme === 'range' ? s.range.nodes : s.hash.nodes);

export function termPart(city: string): number {
  for (let i = 0; i < TERM_STARTS.length - 1; i++) if (city < TERM_STARTS[i + 1]) return i;
  return TERM_STARTS.length - 1;
}

/** Keys with this city, in key order. */
export const keysWith = (s: PState, city: string, among: number[] = sortedKeys(s)) => among.filter((k) => s.rows.get(k) === city);

/** Cities present among these keys, in order, with their keys. */
function terms(s: PState, keys: number[], only?: (city: string) => boolean): [string, number[]][] {
  return CITIES.filter((c) => !only || only(c))
    .map((c) => [c, keysWith(s, c, keys)] as [string, number[]])
    .filter(([, ks]) => ks.length > 0);
}

const nodeName = (i: number) => NODE_NAMES[i];
const rangeText = (v: PartView) => `${v.lo}–${v.hi}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: (number | string)[]) => (xs.length <= 1 ? String(xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function asCity(raw: number | string): string | null {
  const t = String(raw).trim().toLowerCase();
  return CITIES.find((c) => c.toLowerCase() === t) ?? null;
}
const asScheme = (raw: number | string | undefined, s: PState): Scheme | null => {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === '') return s.scheme;
  return t === 'range' || t === 'hash' ? t : null;
};
type Via = IndexKind | 'both';
const asVia = (raw: number | string | undefined, s: PState): Via | null => {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === '') return s.index;
  return t === 'local' || t === 'global' || t === 'both' ? t : null;
};

// ---- ids --------------------------------------------------------------------

const dId = (v: PartView) => `d-${v.pid}`;
const lId = (v: PartView) => `l-${v.pid}`;
const gId = (i: number) => `g${i}`;
const nId = (i: number) => `n${i}`;
/** Cell of a key in its partition: cell 0 is the header. */
const keyCell = (v: PartView, key: number) => 1 + v.keys.indexOf(key);
const localCell = (s: PState, v: PartView, city: string) => 1 + terms(s, v.keys).findIndex(([c]) => c === city);
const globalCell = (s: PState, g: number, city: string) => 1 + terms(s, sortedKeys(s), (c) => termPart(c) === g).findIndex(([c]) => c === city);

const at = (text: string, id: string, cell = 0): Probe => ({ text, at: id, cell });

// ---- routing ----------------------------------------------------------------

/**
 * Follow a key to its partition, recording each comparison. With `brief`, only
 * the comparison that decides is drawn; the others still count.
 */
function route(
  s: PState,
  key: number,
  rec: Rec,
  opts: { text?: string; brief?: boolean; lead?: string[]; what?: string; outer?: Record<string, VarValue> } = {},
): PartView {
  const text = opts.text ?? String(key);
  const lead = opts.lead ?? ['route'];
  const what = opts.what ?? String(key);
  // The caller's variables stay on show, then route's own.
  const outer = opts.outer ?? {};
  const vs = views(s);
  if (s.scheme === 'hash') {
    const h = hashKey(key);
    const v = vs[h % vs.length];
    rec.vars({ ...outer, key, h });
    if (!opts.brief) {
      rec.line(...lead, 'hash');
      rec.step(`Hash the key: h(${key}) = (37 × ${key} + 11) mod 100 = ${h}. The hash says nothing about order: ${key} and ${key + 1 > MAX_KEY ? key - 1 : key + 1} land far apart.`);
    }
    rec.mark(dId(v), 'compare');
    rec.vars({ ...outer, key, h, 'len(parts)': vs.length, 'h % len(parts)': h % vs.length });
    rec.line(...lead, 'mod');
    rec.compare(`h(${what}) = ${h}, mod ${vs.length}`, '=', h % vs.length, `${v.label}, on node ${nodeName(v.node)}`, {
      probe: at(text, dId(v)),
      message: `${h} mod ${vs.length} = ${h % vs.length}, so ${what} belongs to ${v.label}, held by node ${nodeName(v.node)}. The number of partitions, ${vs.length}, is fixed for the life of the table, so this answer never changes.`,
    });
    rec.unmark(dId(v));
    return v;
  }
  for (let i = 0; i < vs.length - 1; i++) {
    const v = vs[i];
    const next = vs[i + 1].lo!;
    const probe = at(text, dId(v));
    rec.vars({ ...outer, key, i, 'parts[i + 1].lo': next });
    rec.line(...lead, 'boundary');
    if (key < next) {
      rec.mark(dId(v), 'compare');
      rec.compare(what === text ? key : what, '<', next, `${v.label}, on node ${nodeName(v.node)}`, {
        probe,
        message: `${key} is below ${next}, where the next partition starts, so it belongs to ${v.label} (${rangeText(v)}) on node ${nodeName(v.node)}.`,
      });
      rec.unmark(dId(v));
      return v;
    }
    if (opts.brief) {
      rec.count('comparisons');
      continue;
    }
    rec.mark(dId(v), 'compare');
    rec.compare(what === text ? key : what, '≥', next, `past ${v.label}, keep going`, {
      probe,
      message: `${key} is at or above ${next}, where the next partition starts, so it is not in ${v.label} (${rangeText(v)}). Try the next boundary.`,
    });
    rec.mark(dId(v), 'path');
  }
  const v = vs[vs.length - 1];
  rec.mark(dId(v), 'compare');
  rec.vars({ ...outer, key, 'len(parts)': vs.length });
  rec.line(...lead, 'last');
  rec.step(`No boundary is left, so ${what} belongs to the last partition, ${v.label} (${rangeText(v)}), on node ${nodeName(v.node)}.`, { probe: at(text, dId(v)) });
  rec.unmark(dId(v));
  return v;
}

/** Follow a city to the global index partition that owns it. */
function routeTerm(city: string, rec: Rec, text: string, left: string, lead: string[], brief = false, outer: Record<string, VarValue> = {}): number {
  for (let i = 0; i < TERM_STARTS.length - 1; i++) {
    const next = TERM_STARTS[i + 1];
    const less = city < next;
    if (brief && !less) {
      rec.count('comparisons');
      continue;
    }
    rec.vars({ ...outer, city, i, 'terms[i + 1]': next });
    rec.mark(gId(i), 'compare');
    rec.line(...lead, 'term_cmp');
    rec.compare(left, less ? '<' : '≥', `"${next}"`, less ? `index partition ${TERM_LABELS[i]}, on node ${nodeName(i)}` : `not ${TERM_LABELS[i]}, keep going`, {
      probe: at(text, gId(i)),
      message: less
        ? `${city} sorts before "${next}", so its entries live in the index partition for ${TERM_LABELS[i]}, on node ${nodeName(i)}. The index is partitioned by city, not by row key.`
        : `${city} sorts at or after "${next}", so it is not in the index partition for ${TERM_LABELS[i]}.`,
    });
    if (less) {
      rec.unmark(gId(i));
      return i;
    }
    rec.mark(gId(i), 'path');
  }
  const g = TERM_STARTS.length - 1;
  rec.mark(gId(g), 'compare');
  rec.vars({ ...outer, city, 'len(terms) - 1': g });
  rec.line(...lead, 'term_last');
  rec.step(`No boundary is left, so ${city} belongs to the last index partition, ${TERM_LABELS[g]}, on node ${nodeName(g)}.`, { probe: at(text, gId(g)) });
  rec.unmark(gId(g));
  return g;
}

// ---- put --------------------------------------------------------------------

function checkKey(key: number, rec: Rec): boolean {
  if (Number.isInteger(key) && key >= 0 && key <= MAX_KEY) return true;
  rec.step(`Keys on this page run from 0 to ${MAX_KEY}.`);
  return false;
}

/**
 * Write one row. `brief` draws only the deciding comparison and one frame for
 * the write and its index entry, for runs of writes. Returns the partition
 * written to, or null when nothing was written.
 */
function putRow(
  s: PState,
  key: number,
  city: string,
  rec: Rec,
  brief: boolean,
  lead: string[] = [],
  outer: Record<string, VarValue> = {},
): PartView | null {
  const text = String(key);
  const v = route(s, key, rec, { brief, lead: [...lead, 'route'], outer: { ...outer, key, city } });
  rec.vars({ ...outer, key, city, part: v.label });
  if (s.rows.has(key)) {
    rec.markCell(dId(v), keyCell(v, key), 'key');
    rec.line(...lead, 'exists');
    rec.step(`${v.label} already holds a row with key ${key} (${s.rows.get(key)}). A key is unique, so nothing is written.`, { probe: at(text, dId(v), keyCell(v, key)) });
    rec.markCell(dId(v), keyCell(v, key), 'idle');
    return null;
  }
  const other: Scheme = s.scheme === 'range' ? 'hash' : 'range';
  const otherFull = partOf(s, key, other).keys.length >= MAX_ROWS;
  if (v.keys.length >= MAX_ROWS || otherFull || s.rows.size >= MAX_TOTAL) {
    rec.mark(dId(v), 'bad');
    rec.line(...lead, 'write');
    rec.step(
      v.keys.length >= MAX_ROWS
        ? `Sorry, this page draws at most ${MAX_ROWS} rows in a partition, and ${v.label} is full. ${s.scheme === 'range' ? 'Run Rebalance to split it.' : 'Hash partitions are fixed, so try a key that hashes elsewhere.'} A real partition is limited by bytes, not by a drawing.`
        : otherFull
          ? `Sorry, this page draws at most ${MAX_ROWS} rows in a partition, and drawn by ${other === 'hash' ? 'hash' : 'key range'} the partition for ${key} is already full, so it is not written.`
          : `Sorry, this page draws at most ${MAX_TOTAL} rows, so ${key} is not written.`,
      { probe: at(text, dId(v)) },
    );
    rec.unmark(dId(v));
    return null;
  }
  s.rows.set(key, city);
  rec.count('writes');
  rec.count('asked');
  const w = partOf(s, key);
  const cell = keyCell(w, key);
  rec.markCell(dId(w), cell, 'key');
  rec.vars({ ...outer, key, city, part: w.label });

  if (s.index === 'local') {
    const lc = localCell(s, w, city);
    if (!brief) {
      rec.line(...lead, 'write');
      rec.step(`Node ${nodeName(w.node)} writes row ${key} (${city}) into ${w.label}. Only this one partition is asked.`, { probe: at(text, dId(w), cell) });
    }
    rec.markCell(lId(w), lc, 'ok');
    rec.count('writes');
    rec.line(...lead, brief ? 'write' : 'local', ...(brief ? ['local'] : []));
    rec.step(
      brief
        ? `${key} (${city}) goes into ${w.label} on node ${nodeName(w.node)}, and into ${w.label}'s own index under ${city}.`
        : `Add ${key} under ${city} in ${w.label}'s local index. The index sits in the same partition on the same node, so the row and its entry are written together and the index is never behind its rows.`,
      { probe: at(text, lId(w), lc) },
    );
    return w;
  }

  if (!brief) {
    rec.line(...lead, 'write');
    rec.step(`Node ${nodeName(w.node)} writes row ${key} (${city}) into ${w.label}. The global index entry for ${city} may live on a different node, so it is a second write.`, { probe: at(text, dId(w), cell) });
  }
  const g = routeTerm(city, rec, text, `${key}: ${city}`, [...lead, 'term'], brief, { ...outer, key });
  rec.vars({ ...outer, key, city, part: w.label, g });
  const gc = globalCell(s, g, city);
  rec.markCell(gId(g), gc, 'ok');
  rec.count('writes');
  rec.count('asked');
  rec.line(...lead, brief ? 'write' : 'global', ...(brief ? ['global'] : []));
  const same = g === w.node;
  rec.step(
    brief
      ? `${key} (${city}) goes into ${w.label} on node ${nodeName(w.node)}; its index entry goes to node ${nodeName(g)}, later.`
      : `Send "${city} → ${key}" to the index partition on node ${nodeName(g)}${same ? ', which happens to be the same node' : ''}. Stores do this asynchronously: the write is acknowledged first, so for a moment a search by city can miss row ${key}.`,
    { probe: at(text, gId(g), gc) },
  );
  return w;
}

export function put(s: PState, key: number, rawCity: number | string, rec: Rec): boolean {
  const city = asCity(rawCity);
  rec.vars({ key, city: city ?? String(rawCity) });
  rec.line('route');
  if (!checkKey(key, rec)) return false;
  if (!city) {
    rec.step(`The cities on this page are ${list([...CITIES])}. Enter one of them.`);
    return false;
  }
  const v = putRow(s, key, city, rec, false);
  if (!v) return false;
  rec.line('done');
  rec.step(
    s.index === 'local'
      ? `Stored: ${key} (${city}) in ${v.label} on node ${nodeName(v.node)}, with its index entry beside it. 1 partition asked, 2 writes on 1 node.`
      : `Stored: ${key} (${city}) in ${v.label} on node ${nodeName(v.node)}, and an index entry on node ${nodeName(termPart(city))}. 2 partitions touched for one row: global indexes make writes dearer and reads cheaper.`,
    { probe: at(String(key), dId(v), keyCell(v, key)) },
  );
  return true;
}

// ---- get --------------------------------------------------------------------

export function get(s: PState, key: number, rec: Rec): string | null {
  rec.vars({ key });
  rec.line('route');
  if (!checkKey(key, rec)) return null;
  const v = route(s, key, rec);
  rec.count('asked');
  rec.line('lookup');
  const city = s.rows.get(key);
  rec.vars({ key, part: v.label, 'part.rows.get(key)': city ?? null });
  if (city === undefined) {
    rec.mark(dId(v), 'bad');
    rec.step(`${v.label} has no row with key ${key}. The answer is still certain: no other partition could hold it, so 1 partition was asked and the rest never heard of this read.`, { probe: at(String(key), dId(v)) });
    return null;
  }
  rec.mark(dId(v), 'path');
  rec.markCell(dId(v), keyCell(v, key), 'key');
  rec.step(`Found ${key}: ${city}, in ${v.label} on node ${nodeName(v.node)}. 1 partition asked out of ${views(s).length}. A read by key costs the same however many partitions there are.`, {
    probe: at(String(key), dId(v), keyCell(v, key)),
  });
  return city;
}

// ---- range scan -----------------------------------------------------------------

function switchScheme(s: PState, scheme: Scheme): string {
  if (s.scheme === scheme) return '';
  s.scheme = scheme;
  return scheme === 'hash'
    ? `Draw the same rows partitioned by hash instead: ${s.hash.owner.length} fixed partitions on nodes ${list([...NODE_NAMES.slice(0, s.hash.nodes)])}. `
    : `Draw the same rows partitioned by key range instead, on nodes ${list([...NODE_NAMES.slice(0, s.range.nodes)])}. `;
}

/** Every row with lo ≤ key ≤ hi, in key order. */
export function scan(s: PState, a: number, b: number, rawScheme: number | string | undefined, rec: Rec): number[] {
  const scheme = asScheme(rawScheme, s);
  rec.vars({ lo: Math.min(a, b), hi: Math.max(a, b) });
  rec.line('first');
  if (!checkKey(a, rec) || !checkKey(b, rec)) return [];
  if (!scheme) {
    rec.step(`The scheme is range or hash.`);
    return [];
  }
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const text = `${lo}–${hi}`;
  const lead = switchScheme(s, scheme);
  const found: number[] = [];

  if (scheme === 'hash') {
    rec.vars({ lo, hi, found: [] });
    rec.line('scatter');
    const vs = views(s);
    rec.step(`${lead}Scan keys ${lo} to ${hi}. Hashing scatters neighbouring keys, so any of the ${vs.length} partitions could hold one. The only way to be sure is to ask every partition: scatter, then gather.`);
    for (const v of vs) {
      const hits = v.keys.filter((k) => k >= lo && k <= hi);
      rec.count('asked');
      rec.mark(dId(v), 'path');
      for (const k of hits) rec.markCell(dId(v), keyCell(v, k), 'ok');
      found.push(...hits);
      rec.vars({ lo, hi, part: v.label, found: [...found] });
      rec.step(
        hits.length
          ? `Ask ${v.label} on node ${nodeName(v.node)}: it has ${list(hits)}.`
          : `Ask ${v.label} on node ${nodeName(v.node)}: nothing in ${text}. It still had to look, and the query waits for its answer.`,
        { probe: at(text, dId(v)) },
      );
    }
    found.sort((x, y) => x - y);
    rec.vars({ lo, hi, found: [...found] });
    rec.line('gather');
    rec.step(
      `Gather and sort: ${found.length ? list(found) : 'no rows'}. ${vs.length} partitions asked for ${plural(found.length, 'row')}. The slowest of the ${vs.length} sets the response time, and every scan loads every node.`,
    );
    return found;
  }

  if (lead) {
    rec.step(`${lead}Scan keys ${lo} to ${hi}. Rows are kept in key order across the partitions, so first find the one that holds ${lo}.`);
  }
  const first = route(s, lo, rec, { text, lead: ['first'], what: `lo ${lo}`, outer: { lo, hi } });
  const vs = views(s);
  let i = first.order;
  for (;;) {
    const v = vs[i];
    const hits = v.keys.filter((k) => k >= lo && k <= hi);
    rec.count('asked');
    rec.mark(dId(v), 'path');
    for (const k of hits) rec.markCell(dId(v), keyCell(v, k), 'ok');
    found.push(...hits);
    rec.vars({ lo, hi, i, part: v.label, found: [...found] });
    rec.line('collect');
    rec.step(
      hits.length
        ? `${v.label} (${rangeText(v)}) reads its rows in order from ${Math.max(lo, v.lo!)}: ${list(hits)}.`
        : `${v.label} (${rangeText(v)}) has no rows in ${text}.`,
      { probe: at(text, dId(v)) },
    );
    i++;
    if (i >= vs.length) break;
    const next = vs[i];
    rec.vars({ lo, hi, i, 'parts[i].lo': next.lo, found: [...found] });
    rec.line('next_part');
    if (next.lo! > hi) {
      rec.compare(`hi ${hi}`, '<', `${next.label} lo ${next.lo}`, `stop: ${next.label} starts past the scan`, { probe: at(text, dId(next)) });
      break;
    }
    rec.compare(`hi ${hi}`, '≥', `${next.label} lo ${next.lo}`, `keep scanning into ${next.label}`, { probe: at(text, dId(next)) });
  }
  for (const v of vs) if (v.order < first.order || v.order >= i) rec.mark(dId(v), 'dim');
  const asked = i - first.order;
  rec.vars({ lo, hi, found: [...found] });
  rec.line('done_scan');
  rec.step(
    `Found ${found.length ? list(found) : 'no rows'} by asking ${plural(asked, 'adjacent partition')} of ${vs.length}. The others never heard of this scan. This is what range partitioning buys.`,
  );
  return found;
}

// ---- find by city ---------------------------------------------------------------

function findLocal(s: PState, city: string, rec: Rec, lead: string): number[] {
  const vs = views(s);
  rec.vars({ city, found: [] });
  rec.line('ask_local');
  rec.step(`${lead}Find rows in ${city} with local indexes. Each partition indexes only its own rows, so a row in ${city} could be in any of them: ask all ${vs.length}.`);
  const found: number[] = [];
  for (const v of vs) {
    rec.count('asked');
    const hits = keysWith(s, city, v.keys);
    const lc = localCell(s, v, city);
    rec.vars({ city, part: v.label, 'part.index[city]': hits, found: [...found, ...hits] });
    if (hits.length) {
      rec.markCell(lId(v), lc, 'ok');
      for (const k of hits) rec.markCell(dId(v), keyCell(v, k), 'ok');
      found.push(...hits);
      rec.step(`${v.label} on node ${nodeName(v.node)} looks up ${city} in its own index: ${list(hits)}.`, { probe: at(city, lId(v), lc) });
    } else {
      rec.mark(lId(v), 'path');
      rec.step(`${v.label} on node ${nodeName(v.node)} has no ${city} in its index. It still had to be asked.`, { probe: at(city, lId(v)) });
    }
  }
  found.sort((x, y) => x - y);
  rec.vars({ city, found: [...found] });
  rec.line('merge');
  rec.step(`Merge the answers: ${found.length ? list(found) : 'no rows'}. ${vs.length} partitions asked for ${plural(found.length, 'row')}. Elasticsearch searches its shards this way.`);
  return found;
}

function findGlobal(s: PState, city: string, rec: Rec, lead: string): number[] {
  rec.vars({ city });
  rec.line('term');
  rec.step(`${lead}Find rows in ${city} with the global index. It is partitioned by city, so every ${city} entry is in one index partition. Work out which.`);
  const g = routeTerm(city, rec, city, city, ['term']);
  rec.count('asked');
  const hits = keysWith(s, city);
  rec.vars({ city, g, 'glob[g][city]': hits });
  rec.line('postings');
  if (!hits.length) {
    rec.mark(gId(g), 'path');
    rec.step(`The index partition on node ${nodeName(g)} has no entry for ${city}, so there are no such rows. 1 partition asked.`, { probe: at(city, gId(g)) });
    return [];
  }
  const gc = globalCell(s, g, city);
  rec.markCell(gId(g), gc, 'ok');
  const vs = views(s);
  const holders = new Set<string>();
  for (const k of hits) {
    const v = partOf(s, k);
    holders.add(v.label);
    rec.markCell(dId(v), keyCell(v, k), 'ok');
  }
  rec.step(
    `Node ${nodeName(g)} reads one entry: ${city} → ${list(hits)}. 1 partition asked, not ${vs.length}. The rows themselves sit in ${list([...holders])}: an index that holds only keys needs a read by key for each, and one that copies the columns in (DynamoDB calls it a projection) needs none.`,
    { probe: at(city, gId(g), gc) },
  );
  return hits;
}

export function find(s: PState, rawCity: number | string, rawVia: number | string | undefined, rec: Rec): number[] {
  const city = asCity(rawCity);
  const via = asVia(rawVia, s);
  rec.vars({ city: city ?? String(rawCity) });
  rec.line('ask_local');
  if (!city) {
    rec.step(`The cities on this page are ${list([...CITIES])}. Enter one of them.`);
    return [];
  }
  if (!via) {
    rec.step(`The index is local, global or both.`);
    return [];
  }
  const swap = (to: IndexKind) => {
    if (s.index === to) return '';
    s.index = to;
    return to === 'global' ? 'Now draw the global index in place of the local ones. ' : 'Now draw the local indexes in place of the global one. ';
  };
  if (via === 'local') return findLocal(s, city, rec, swap('local'));
  if (via === 'global') return findGlobal(s, city, rec, swap('global'));
  const a = findLocal(s, city, rec, swap('local'));
  const asked = views(s).length;
  rec.clearMarks();
  const b = findGlobal(s, city, rec, `The same query, with a global index. ${swap('global')}`);
  rec.line('postings');
  rec.step(`Same answer both ways: ${b.length ? list(b) : 'no rows'}. Local indexes asked ${asked} partitions; the global index asked 1. The global index paid for that on every write, with a second, asynchronous write that can lag.`);
  return a;
}

// ---- hot keys -----------------------------------------------------------------

/** Clear the marks of one write and show every row written so far as written, where it now sits. */
function markWritten(s: PState, keys: number[], rec: Rec): void {
  rec.clearMarks();
  for (const k of keys) {
    const v = partOf(s, k);
    rec.markCell(dId(v), keyCell(v, k), 'ok');
  }
}

/** Sequential keys from `start`, then (range only) the same writes with a sensor number in front. */
export function hot(s: PState, start: number, rec: Rec): number {
  rec.vars({ start });
  rec.line('sequential');
  if (!Number.isInteger(start) || start < 0 || start + HOT_RUN - 1 > MAX_KEY) {
    rec.step(`Start the run between 0 and ${MAX_KEY - HOT_RUN + 1}, so ${HOT_RUN} keys fit below ${MAX_KEY + 1}.`);
    return 0;
  }
  const run = Array.from({ length: HOT_RUN }, (_, i) => start + i);
  rec.step(
    `Write ${HOT_RUN} events keyed by timestamp: ${list(run)}. Each key is one more than the last, as with timestamps or auto-increment ids. Watch where they go.`,
  );
  const hit = new Map<string, number>();
  const done: number[] = [];
  let written = 0;
  for (const t of run) {
    const v = putRow(s, t, CITIES[t % 3], rec, true, ['sequential'], { start, t });
    if (v) {
      written++;
      done.push(t);
      hit.set(v.label, (hit.get(v.label) ?? 0) + 1);
    }
    markWritten(s, done, rec);
  }
  const vs = views(s);
  const nodesHit = new Set(vs.filter((v) => hit.has(v.label)).map((v) => v.node));
  rec.vars({ start });
  if (s.scheme === 'hash') {
    rec.line('sequential');
    rec.step(
      `Hashing spread ${plural(written, 'write')} over ${plural(hit.size, 'partition')} on ${plural(nodesHit.size, 'node')}: no partition is hot. The price is the range scan: reading ${start} to ${start + HOT_RUN - 1} back now asks all ${vs.length} partitions.`,
    );
    return written;
  }
  const top = [...hit.entries()].sort((a, b) => b[1] - a[1])[0];
  const idle = nodeCount(s) - nodesHit.size;
  if (top) for (const v of vs) if (v.label === top[0]) rec.mark(dId(v), 'compare');
  rec.line('sequential');
  rec.step(
    top && hit.size === 1
      ? `All ${plural(written, 'write')} landed in ${top[0]}, the partition that owns the newest keys. ${idle ? `${plural(idle, 'node')} sat idle.` : ''} With a steady stream of timestamps one node takes every write while the rest wait: a hot partition.`
      : `The ${plural(written, 'write')} landed in ${plural(hit.size, 'partition')}. Sequential keys crowd into whichever partition owns the newest range: a hot partition.`,
  );
  rec.clearMarks();

  const time = (start + HOT_RUN) % 100;
  const keys = SENSORS.map((sensor) => sensor * 100 + time);
  rec.vars({ time, sensors: [...SENSORS] });
  rec.line('prefix');
  rec.step(
    `The fix: lead the key with something that varies, such as the sensor that sent the event. Here the hundreds digit is the sensor and the last two digits the time, so sensors ${list([...SENSORS])} writing at time ${String(time).padStart(2, '0')} give keys ${list(keys)}.`,
  );
  const spread = new Set<string>();
  const spreadNodes = new Set<number>();
  const fixed: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const v = putRow(s, keys[i], CITIES[i], rec, true, ['prefix', 'spread'], { time, sensor: SENSORS[i] });
    if (v) {
      written++;
      fixed.push(keys[i]);
      spread.add(v.label);
      spreadNodes.add(v.node);
    }
    markWritten(s, fixed, rec);
  }
  rec.vars({ time, sensors: [...SENSORS] });
  rec.line('spread');
  rec.step(
    `${plural(keys.length, 'write')} at the same moment went to ${plural(spread.size, 'partition')} on ${plural(spreadNodes.size, 'node')}. The price: reading one time window now takes one scan per sensor, ${SENSORS.length} here, each still cheap and in key order.`,
  );
  return written;
}

// ---- rebalance ------------------------------------------------------------------

/** Rows per node in the range scheme. */
function rangeLoad(s: PState): number[] {
  const load = new Array<number>(s.range.nodes).fill(0);
  for (const v of views(s, 'range')) load[v.node] += v.keys.length;
  return load;
}

function splitRange(s: PState, rec: Rec, joined: string): boolean {
  const vs = views(s, 'range');
  let full = vs[0];
  for (const v of vs) if (v.keys.length > full.keys.length) full = v;
  const total = s.rows.size;
  rec.mark(dId(full), 'compare');
  rec.vars({ part: full.label, 'len(part.rows)': full.keys.length });
  rec.line('split_call', 'fullest');
  if (full.keys.length < SPLIT_MIN) {
    rec.step(`${joined}The fullest partition, ${full.label}, holds ${plural(full.keys.length, 'row')}. That is under ${SPLIT_MIN}, too few to be worth splitting, so nothing changes.`, { probe: at(full.label, dId(full)) });
    return false;
  }
  if (vs.length >= MAX_RANGE_PARTS) {
    rec.step(`${joined}Sorry, this page draws at most ${MAX_RANGE_PARTS} range partitions, so ${full.label} is not split.`, { probe: at(full.label, dId(full)) });
    return false;
  }
  rec.step(`${joined}${full.label} (${rangeText(full)}) holds ${full.keys.length} of ${total} rows, more than any other partition. A store splits a partition when it grows past a size; this one is over-full.`, {
    probe: at(full.label, dId(full)),
  });

  const load = rangeLoad(s);
  const target = load.indexOf(Math.min(...load));
  rec.mark(nId(target), 'path');
  rec.vars({ part: full.label, 'len(part.rows)': full.keys.length, load, node: target });
  rec.line('pick_node');
  rec.step(
    `Pick a node for the new half: the one holding the fewest rows. Rows per node: ${load.map((n, i) => `${nodeName(i)} ${n}`).join(', ')}. That is node ${nodeName(target)}.`,
    { probe: at(full.label, nId(target)) },
  );

  const mid = full.keys[Math.floor(full.keys.length / 2)];
  const upper = full.keys.filter((k) => k >= mid);
  rec.markCell(dId(full), keyCell(full, mid), 'compare');
  rec.vars({ part: full.label, node: target, keys: full.keys, mid });
  rec.line('median');
  rec.step(`Its median key is ${mid}. Rows from ${mid} up, ${list(upper)}, form a new partition, so the two halves end up about the same size.`, { probe: at(full.label, dId(full), keyCell(full, mid)) });

  const id = s.range.nextId++;
  const parts = s.range.parts;
  parts.splice(parts.findIndex((p) => `r${p.id}` === full.pid) + 1, 0, { id, lo: mid, node: target });
  const moved = target === full.node ? 0 : upper.length;
  rec.count('moved', moved);
  rec.clearMarks();
  const nv = views(s, 'range').find((v) => v.pid === `r${id}`)!;
  const old = views(s, 'range').find((v) => v.pid === full.pid)!;
  rec.mark(dId(nv), 'ok');
  rec.vars({ part: old.label, node: target, mid, new: nv.label, 'new.rows': nv.keys });
  rec.line('new_part', 'move');
  rec.step(
    moved
      ? `P${id} (${rangeText(nv)}) is made on node ${nodeName(target)}, and its ${plural(moved, 'row')} with their local index entries are copied across. ${old.label} now ends at ${old.hi}.`
      : `P${id} (${rangeText(nv)}) is made on node ${nodeName(target)}, the node that already held them, so no row crosses the network. ${old.label} now ends at ${old.hi}.`,
    { probe: at(`P${id}`, dId(nv)) },
  );

  rec.vars({ part: old.label, node: target, mid, new: nv.label });
  rec.line('done_split');
  rec.step(
    `Split done: ${old.label} holds ${plural(old.keys.length, 'row')} and P${id} holds ${nv.keys.length}. ${moved ? `${plural(moved, 'row')} moved` : 'No rows moved'}; every other partition was untouched, and the global index needs no change because row keys did not change. HBase and MongoDB split ranges like this as they grow.`,
  );
  return true;
}

function moveHash(s: PState, rec: Rec, joined: string): number {
  const P = s.hash.owner.length;
  const total = s.rows.size;
  let movedParts = 0;
  let movedRows = 0;
  let first = true;
  for (;;) {
    const count = new Array<number>(s.hash.nodes).fill(0);
    for (const n of s.hash.owner) count[n]++;
    const busy = count.indexOf(Math.max(...count));
    const idle = count.indexOf(Math.min(...count));
    rec.vars({ moved: movedParts, count, busy, idle });
    rec.line(...(first ? ['move_call'] : []), 'balanced');
    const tally = count.map((n, i) => `${nodeName(i)} ${n}`).join(', ');
    if (count[busy] - count[idle] <= 1) {
      rec.step(`${first ? joined : ''}Partitions per node: ${tally}. No node has more than one partition more than another, so this is as even as ${P} partitions allow.`);
      break;
    }
    const p = s.hash.owner.lastIndexOf(busy);
    const v = views(s, 'hash')[p];
    rec.mark(dId(v), 'compare');
    rec.step(`${first ? joined : ''}Partitions per node: ${tally}. Node ${nodeName(busy)} has the most and node ${nodeName(idle)} the fewest, so ${nodeName(busy)} hands over a whole partition, its last: ${v.label}.`, {
      probe: at(v.label, dId(v)),
    });
    first = false;
    s.hash.owner[p] = idle;
    movedParts++;
    movedRows += v.keys.length;
    rec.count('moved', v.keys.length);
    rec.unmark(dId(v));
    rec.mark(dId(v), 'ok');
    rec.vars({ moved: movedParts, count, busy, idle, 'mine[-1]': v.label });
    rec.line('steal');
    rec.step(
      `${v.label} moves to node ${nodeName(idle)} whole: ${plural(v.keys.length, 'row')} and their local index entries, copied as one block. No key is rehashed: h(key) mod ${P} is the same as before, only the owner of ${v.label} changed.`,
      { probe: at(v.label, dId(v)) },
    );
    rec.unmark(dId(v));
  }
  if (movedParts) {
    const was = s.hash.nodes - 1;
    const modN = [...s.rows.keys()].filter((k) => hashKey(k) % was !== hashKey(k) % s.hash.nodes).length;
    rec.vars({ moved: movedParts });
    rec.line('balanced');
    rec.step(
      `Moved ${plural(movedParts, 'partition')} of ${P}, ${plural(movedRows, 'row')} of ${total}. Had rows been placed by h(key) mod number of nodes, going from ${was} to ${s.hash.nodes} would have moved ${modN} of ${total}. Riak, Couchbase and Elasticsearch fix the partition count up front for this reason.`,
    );
  }
  return movedParts;
}

export function rebalance(s: PState, rec: Rec): boolean {
  const nodes = nodeCount(s);
  const join = nodes < MAX_NODES;
  rec.vars({ join, nodes: join ? nodes + 1 : nodes });
  rec.line('join');
  let joined: string;
  if (join) {
    if (s.scheme === 'range') s.range.nodes++;
    else s.hash.nodes++;
    rec.mark(nId(nodes), 'ok');
    rec.step(`Node ${nodeName(nodes)} joins the cluster. It holds nothing yet, and gets no traffic until some data is moved onto it.`);
    rec.unmark(nId(nodes));
    joined = '';
  } else {
    joined = `This page draws at most ${MAX_NODES} nodes, so no node joins; just even out the ones there are. `;
  }
  if (s.scheme === 'range') {
    if (!join) {
      rec.step(
        `Sorry, this page draws at most ${MAX_NODES} nodes, each with its own range partition, so it does not split here. Rebuild with 3 nodes to watch a split move to a new node. A real store splits whenever a partition passes a size, and a node holds many partitions.`,
      );
      return false;
    }
    rec.line('split_call');
    return splitRange(s, rec, joined);
  }
  rec.line('move_call');
  return moveHash(s, rec, joined) > 0;
}

// ---- layout -----------------------------------------------------------------

const NODE_W = 48;
const KEY_W = 52;
const PART_GAP = 14;
const INDEX_GAP = 6;
/** Cells, the city or range under them, then room for the chip above the next row. */
export const ROW_H = CELL_H / 2 + SUB_ROOM + PROBE_H + 16 + CELL_H / 2;
const TOP = -(CELL_H / 2 + PROBE_H + 16);
const BOTTOM = (MAX_NODES - 1) * ROW_H + CELL_H / 2 + SUB_ROOM;

/** Drawn width of a sub label: the text face, or the mono face when it is data. */
const subWidth = (sub: string, value: boolean) => Math.ceil(sub.length * (value ? 9.6 : 8.8)) + 10;
function cell(text: string, sub?: string, value = false, min = 0): Cell {
  const w = Math.max(min, cellWidth({ text }), sub ? subWidth(sub, value) : 0);
  return { text, sub, subValue: value || undefined, w };
}

function localCells(s: PState, v: PartView): Cell[] {
  return [cell('local', 'index'), ...terms(s, v.keys).map(([c, ks]) => cell(c, ks.join(' '), true))];
}

function globalCells(s: PState, g: number): Cell[] {
  return [cell('global', TERM_LABELS[g]), ...terms(s, sortedKeys(s), (c) => termPart(c) === g).map(([c, ks]) => cell(c, ks.join(' '), true))];
}

export function layout(s: PState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const vs = views(s);
  const rows = nodeCount(s);
  let right = 0;
  for (let i = 0; i < rows; i++) {
    const y = i * ROW_H;
    nodes.push({ id: nId(i), x: NODE_W / 2, y, cells: [{ text: nodeName(i), sub: 'node', w: NODE_W }], hue: i });
    let x = NODE_W + PART_GAP;
    for (const v of vs.filter((p) => p.node === i)) {
      const cells: Cell[] = [
        s.scheme === 'range' ? cell(v.label, rangeText(v), false, 70) : cell(v.label, undefined, false, 44),
        ...v.keys.map((k) => ({ text: String(k), sub: s.rows.get(k), subValue: true, w: KEY_W })),
      ];
      const w = cellsWidth(cells);
      nodes.push({ id: dId(v), x: x + w / 2, y, cells });
      x += w;
      if (s.index === 'local') {
        const lc = localCells(s, v);
        const lw = cellsWidth(lc);
        x += INDEX_GAP;
        nodes.push({ id: lId(v), x: x + lw / 2, y, cells: lc });
        x += lw;
      }
      x += PART_GAP;
    }
    if (s.index === 'global' && i < TERM_STARTS.length) {
      const gc = globalCells(s, i);
      const gw = cellsWidth(gc);
      x += 8;
      nodes.push({ id: gId(i), x: x + gw / 2, y, cells: gc });
      x += gw + PART_GAP;
    }
    right = Math.max(right, x - PART_GAP);
  }
  // Pin the height to the most nodes the page draws, so a node joining does not rescale the view.
  decor.push({ id: 'corner-a', type: 'label', x: -4, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: Math.max(right, 700), y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------------

/** Eight rows spread over the key space. */
export const SEED: [number, string][] = [
  [42, 'Oslo'],
  [118, 'Rome'],
  [205, 'Lima'],
  [310, 'Oslo'],
  [377, 'Rome'],
  [461, 'Lima'],
  [590, 'Oslo'],
  [868, 'Rome'],
];

function freeKey(s: PState): number {
  for (let i = 0; i < 80; i++) {
    const k = randomInt(0, MAX_KEY);
    const full = partOf(s, k, 'range').keys.length >= MAX_ROWS || partOf(s, k, 'hash').keys.length >= MAX_ROWS;
    if (!s.rows.has(k) && !full) return k;
  }
  return randomInt(0, MAX_KEY);
}

function suggestHot(s: PState): number {
  // Just past the largest key, like the next timestamps, where there is room.
  const top = Math.max(0, ...s.rows.keys());
  const start = Math.min(MAX_KEY - HOT_RUN + 1, top + 1);
  return start;
}

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: MAX_KEY } as const;
const CITY = { name: 'city', label: 'City (Lima, Oslo or Rome)', kind: 'word' } as const;

const def: StructureDef<PState> = {
  id: 'partitioning',
  params: [
    { id: 'scheme', label: 'Partition by', default: 0, options: [{ value: 0, label: 'Key range' }, { value: 1, label: 'Hash of key' }] },
    { id: 'index', label: 'Index on city', default: 0, options: [{ value: 0, label: 'Local' }, { value: 1, label: 'Global' }] },
    { id: 'nodes', label: 'Nodes', default: 3, options: [3, 4].map((v) => ({ value: v, label: String(v) })) },
  ],
  create: (params) => create(params.nodes ?? 3, params.scheme === 1 ? 'hash' : 'range', params.index === 1 ? 'global' : 'local'),
  seed: SEED.map(([k, c]) => ['put', k, c]),
  ops: [
    {
      id: 'put',
      label: 'Put',
      intent: 'primary',
      args: [KEY, CITY],
      code: ['put', 'route', 'term_part'],
      run: (s, [k, c], rec) => void put(s, Number(k), c, rec),
      suggest: (s) => [freeKey(s), CITIES[randomInt(0, 2)]],
    },
    {
      id: 'get',
      label: 'Get',
      args: [KEY],
      code: ['get', 'route'],
      run: (s, [k], rec) => void get(s, Number(k), rec),
      suggest: (s) => {
        const keys = [...s.rows.keys()];
        return [keys.length && randomInt(0, 3) > 0 ? keys[randomInt(0, keys.length - 1)] : randomInt(0, MAX_KEY)];
      },
    },
    {
      id: 'range',
      label: 'Range scan',
      args: [
        { name: 'lo', label: 'From key', kind: 'int', min: 0, max: MAX_KEY },
        { name: 'hi', label: 'To key', kind: 'int', min: 0, max: MAX_KEY },
        { name: 'scheme', label: 'Scheme (range or hash)', kind: 'word' },
      ],
      code: ['scan', 'route'],
      run: (s, [a, b, sc], rec) => void scan(s, Number(a), Number(b), sc, rec),
      suggest: (s) => {
        const lo = randomInt(0, 800);
        return [lo, lo + randomInt(60, 180), s.scheme];
      },
    },
    {
      id: 'find',
      label: 'Find by city',
      args: [CITY, { name: 'via', label: 'Index (local, global or both)', kind: 'word' }],
      code: ['find', 'term_part'],
      run: (s, [c, via], rec) => void find(s, c, via, rec),
      suggest: (s) => [CITIES[randomInt(0, 2)], s.index],
    },
    {
      id: 'hot',
      label: 'Hot keys',
      args: [{ name: 'start', label: 'First timestamp', kind: 'int', min: 0, max: MAX_KEY - HOT_RUN + 1 }],
      code: ['hot', 'put', 'route', 'term_part'],
      run: (s, [t], rec) => void hot(s, Number(t), rec),
      suggest: (s) => [suggestHot(s)],
    },
    {
      id: 'rebalance',
      label: 'Rebalance',
      intent: 'danger',
      args: [],
      code: ['rebalance', 'split', 'least_loaded', 'move_partitions'],
      run: (s, _args, rec) => void rebalance(s, rec),
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'asked', label: 'Partitions asked' },
    { key: 'writes', label: 'Rows and index entries written' },
    { key: 'moved', label: 'Rows moved' },
  ],
  status: (s) => {
    const vs = views(s);
    const busiest = vs.reduce((a, b) => (b.keys.length > a.keys.length ? b : a), vs[0]);
    return [
      { label: 'Drawn as', value: `${s.scheme === 'range' ? 'key range' : 'hash'}, ${s.index} index` },
      { label: 'Rows', value: String(s.rows.size) },
      { label: 'Partitions on nodes', value: `${vs.length} on ${nodeCount(s)}` },
      { label: 'Busiest partition', value: s.rows.size ? `${busiest.label}, ${busiest.keys.length} of ${s.rows.size} rows` : 'none' },
    ];
  },
  tour: [
    ['put', 512, 'Lima'],
    ['get', 205],
    ['range', 300, 420, 'range'],
    ['hot', 900],
    ['rebalance'],
    ['find', 'Oslo', 'both'],
    ['range', 300, 420, 'hash'],
  ],
  fill: (s) => ['put', freeKey(s), CITIES[randomInt(0, 2)]],
  source: { python, java },
  info,
};

export default def;
