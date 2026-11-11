import { CAPTION_ROOM, LABEL_MAX, PROBE_H, SUB_ROOM, TITLE_ROOM } from '../../core/fit';
import { CELL_H, TRAY_PAD } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/ColumnStore.java?raw';
import python from './code/column_store.py?raw';
import { info } from './info';

/**
 * Column-oriented storage, Parquet style.
 *
 * One small fact table is kept two ways. The row file stores each row's four
 * values together. The column file cuts the rows into row groups and stores
 * each column of a row group on its own, as a column chunk, with that chunk's
 * min and max. The table is sorted by country, so the country chunks have
 * tight ranges and long runs.
 *
 * `groups` holds the rows of every row group in the column files; the row
 * file is the same rows in the same order. `buffer` holds appended rows that
 * have not been written to a column file yet. `panel` is the page's own note
 * of what to draw under the table; a real store keeps none of it.
 */
export const COLS = ['day', 'country', 'product', 'amount'] as const;
export type Col = (typeof COLS)[number];
export type Val = string | number;
export type Layout = 'row' | 'column';

export interface Row {
  id: number;
  day: number;
  country: string;
  product: string;
  amount: number;
}

export type Panel =
  | { kind: 'none' }
  /** coded: values coded so far, per row group. runs: whether that chunk is shown as runs yet. */
  | { kind: 'encode'; col: Col; coded: number[]; runs: boolean[] }
  /** built: how many bitmaps exist so far, country values first. */
  | { kind: 'bitmap'; country: string; product: string; built: number; and: boolean };

export interface StoreState {
  groups: Row[][];
  buffer: Row[];
  /** The layout drawn, and the one the last query used. */
  layout: Layout;
  /** The page setting: the layout a query uses when none is given. */
  setting: Layout;
  /** Columns stored as a dictionary and runs, in every row group. */
  encoded: Col[];
  panel: Panel;
  nextId: number;
}

export const COUNTRIES = ['DE', 'FR', 'IT', 'UK'];
export const PRODUCTS = ['jam', 'pie', 'tea'];
export const GROUP_ROWS = 4;
/** The buffer is written out as a new file when it holds this many rows. */
export const FLUSH_ROWS = 2;
/** The page draws the 3 row groups of the example and room for 1 new file. */
export const MAX_GROUPS = 4;
/** Every value takes 4 bytes stored plainly, and so does a dictionary entry. */
export const VALUE_BYTES = 4;
export const ENTRY_BYTES = 4;
/** A dictionary code takes 1 byte, a run 2 (a code and a count). */
export const CODE_BYTES = 1;
export const RUN_BYTES = 2;
/** Day of the rows the page appends. The example covers days 1 to 3. */
export const NEW_DAY = 4;

export const SAMPLE: [number, string, string, number][] = [
  [1, 'DE', 'tea', 12], [1, 'DE', 'pie', 30], [2, 'DE', 'tea', 18], [3, 'DE', 'jam', 25],
  [1, 'FR', 'tea', 40], [2, 'FR', 'pie', 15], [2, 'FR', 'tea', 22], [3, 'FR', 'tea', 35],
  [2, 'IT', 'jam', 10], [1, 'UK', 'tea', 28], [2, 'UK', 'jam', 16], [3, 'UK', 'tea', 45],
];

const HEAD: Record<Col, string> = { day: 'day', country: 'ctry', product: 'prod', amount: 'amt' };

function sampleGroups(): Row[][] {
  const rows = SAMPLE.map(([day, country, product, amount], id) => ({ id, day, country, product, amount }));
  const groups: Row[][] = [];
  for (let i = 0; i < rows.length; i += GROUP_ROWS) groups.push(rows.slice(i, i + GROUP_ROWS));
  return groups;
}

export function create(setting: Layout = 'column'): StoreState {
  return { groups: sampleGroups(), buffer: [], layout: setting, setting, encoded: [], panel: { kind: 'none' }, nextId: SAMPLE.length };
}

// ---- helpers ----------------------------------------------------------------

export const val = (r: Row, c: Col): Val => r[c];
const gt = (a: Val, b: Val) => (typeof a === 'number' && typeof b === 'number' ? a > b : String(a) > String(b));
export const minOf = (vs: Val[]) => vs.reduce((m, v) => (gt(m, v) ? v : m));
export const maxOf = (vs: Val[]) => vs.reduce((m, v) => (gt(v, m) ? v : m));
export const chunk = (g: Row[], c: Col): Val[] => g.map((r) => val(r, c));
export const allRows = (s: StoreState): Row[] => [...s.groups.flat(), ...s.buffer];
export const fileRows = (s: StoreState): Row[] => s.groups.flat();

/** A chunk as Parquet would store it with dictionary encoding: a dictionary, codes, then runs of codes. */
export function encodeChunk(values: Val[]): { dictionary: Val[]; codes: number[]; runs: [number, number][] } {
  const dictionary: Val[] = [];
  const codes: number[] = [];
  for (const v of values) {
    if (!dictionary.includes(v)) dictionary.push(v);
    codes.push(dictionary.indexOf(v));
  }
  const runs: [number, number][] = [];
  for (const c of codes) {
    const last = runs[runs.length - 1];
    if (last && last[0] === c) last[1]++;
    else runs.push([c, 1]);
  }
  return { dictionary, codes, runs };
}

/** Bytes a chunk takes on disk, plain or encoded. */
export function chunkBytes(values: Val[], encoded: boolean): number {
  if (!encoded) return values.length * VALUE_BYTES;
  const e = encodeChunk(values);
  return e.dictionary.length * ENTRY_BYTES + e.runs.length * RUN_BYTES;
}

/** Bytes a whole column takes across the column files. */
export function columnBytes(s: StoreState, c: Col): number {
  return s.groups.reduce((sum, g) => sum + chunkBytes(chunk(g, c), s.encoded.includes(c)), 0);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: (string | number)[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const runText = (runs: [number, number][]) => runs.map(([c, n]) => `${c}×${n}`).join(', ');

export function parseLayout(raw: number | string | undefined): Layout | null {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === 'row' || t === 'rows' || t === 'r') return 'row';
  if (t === 'column' || t === 'columns' || t === 'col' || t === 'c') return 'column';
  return null;
}

export function parseCol(raw: number | string): Col | null {
  const t = String(raw).trim().toLowerCase();
  if (!t) return null;
  if (t === 'ctry') return 'country';
  if (t === 'prod') return 'product';
  if (t === 'amt') return 'amount';
  return COLS.find((c) => c.startsWith(t)) ?? null;
}

const asCountry = (raw: number | string) => String(raw).trim().toUpperCase();
const asProduct = (raw: number | string) => String(raw).trim().toLowerCase();

// ---- ids ------------------------------------------------------------------------

const cid = (r: Row, c: Col) => `r${r.id}-${c}`;
const sid = (i: number, c: Col) => `slot${i}-${c}`;
const dictId = (g: number) => `dict${g}`;
const codesId = (g: number) => `codes${g}`;
const runsId = (g: number) => `runs${g}`;
const bmId = (col: 'country' | 'product', v: string) => `bm-${col}-${v}`;
const AND_ID = 'bm-and';

/** The block a buffered row is drawn in: the slot after the last row group. */
const bufferBlock = (s: StoreState) => s.groups.length;

/** The top cell of a column in a block, where the chip sits. */
function topOf(s: StoreState, block: number, c: Col): string {
  if (block < s.groups.length) return cid(s.groups[block][0], c);
  return s.buffer.length ? cid(s.buffer[0], c) : sid(0, c);
}

const chipAt = (s: StoreState, text: string, block: number, c: Col): Probe => ({ text, at: topOf(s, block, c) });

function markCells(rec: Rec, rows: Row[], cols: readonly Col[], tone: Tone): void {
  for (const r of rows) for (const c of cols) rec.markCell(cid(r, c), 0, tone);
}

/** Encoding, bitmaps and appends are about the column file. Switch the drawing to it first. */
function toColumns(s: StoreState, rec: Rec, why: string): void {
  if (s.layout === 'column') return;
  s.layout = 'column';
  rec.step(`${why} The page switches to the column file: the same 12 rows, stored column by column.`);
}

// ---- sum ------------------------------------------------------------------------

/** SUM(amount) WHERE country = x, under either layout. Returns the total, or null for bad input. */
export function sum(s: StoreState, rawCountry: number | string, rawLayout: number | string | undefined, rec: Rec): number | null {
  const x = asCountry(rawCountry);
  const given = String(rawLayout ?? '').trim();
  const layout = given ? parseLayout(given) : s.setting;
  if (!layout) {
    rec.line('col_done');
    rec.step(`The layout is row or column. Leave it empty to use the page setting, which is ${s.setting}.`);
    return null;
  }
  if (!/^[A-Z]{2}$/.test(x)) {
    rec.line(layout === 'row' ? 'row_done' : 'col_done');
    rec.step(`Enter a two-letter country code, such as UK. This table has ${list(COUNTRIES)}.`);
    return null;
  }
  s.layout = layout;
  return layout === 'row' ? sumRows(s, x, rec) : sumColumns(s, x, rec);
}

function sumRows(s: StoreState, x: string, rec: Rec): number {
  const rows = allRows(s);
  const blocks = [...s.groups, ...(s.buffer.length ? [s.buffer] : [])];
  rec.line('row_read');
  rec.step(
    `SUM(amount) WHERE country = ${x}, on the row file. A row's 4 values are stored together, so the only way to see every country is to read every row, all 4 values of it.`,
    { probe: chipAt(s, x, 0, 'country') },
  );
  let total = 0;
  let hits = 0;
  let n = 0;
  blocks.forEach((block, b) => {
    for (const r of block) {
      markCells(rec, [r], COLS, 'path');
      rec.markCell(cid(r, 'country'), 0, 'compare');
      rec.count('values', COLS.length);
      rec.count('bytes', COLS.length * VALUE_BYTES);
      const hit = r.country === x;
      if (hit) {
        total += r.amount;
        hits++;
        rec.markCell(cid(r, 'amount'), 0, 'ok');
      }
      rec.line('row_read', 'row_test', ...(hit ? ['row_add'] : []));
      rec.compare(x, hit ? '=' : '≠', `row ${n}: ${r.country}`, hit ? `add ${r.amount}, total ${total}` : 'skip the row', {
        probe: chipAt(s, x, b, 'country'),
      });
      rec.markCell(cid(r, 'country'), 0, hit ? 'ok' : 'path');
      n++;
    }
  });
  rec.line('row_done');
  rec.step(
    `SUM = ${total}. The row file read all ${rows.length} rows: ${rows.length * 4} values and ${rows.length * 4 * VALUE_BYTES} bytes, to use ${plural(hits, 'amount')}. Every day and product was read too, only to be stepped over.`,
  );
  return total;
}

function sumColumns(s: StoreState, x: string, rec: Rec): number {
  const enc = s.encoded.includes('country');
  if (enc) s.panel = { kind: 'encode', col: 'country', coded: s.groups.map((g) => g.length), runs: s.groups.map(() => true) };
  else if (s.panel.kind === 'bitmap') s.panel = { kind: 'none' };
  for (const g of s.groups) markCells(rec, g, ['day', 'product'], 'dim');
  rec.line('group');
  rec.step(
    `The same query on the column file. It needs only country and amount, so the day and product chunks are never opened. The footer at the end of the file holds every chunk's min and max, so the reader checks those first.`,
    { probe: chipAt(s, x, 0, 'country') },
  );
  let valuesRead = 0;
  let bytesRead = 0;
  const tally = (what: 'values' | 'bytes', by = 1) => {
    rec.count(what, by);
    if (what === 'values') valuesRead += by;
    else bytesRead += by;
  };
  let total = 0;
  let read = 0;
  let skipped = 0;
  let falseHit = false;
  for (let g = 0; g < s.groups.length; g++) {
    const rows = s.groups[g];
    const values = chunk(rows, 'country');
    const lo = String(minOf(values));
    const hi = String(maxOf(values));
    const probe = chipAt(s, x, g, 'country');
    const above = x > hi;
    rec.line('group', 'above', ...(above ? ['skip'] : []));
    rec.compare(x, above ? '>' : '≤', `max ${hi}`, above ? `skip row group ${g}` : 'check the min', { probe });
    let skip = above;
    if (!above) {
      const below = x < lo;
      rec.line('below', ...(below ? ['skip'] : []));
      rec.compare(x, below ? '<' : '≥', `min ${lo}`, below ? `skip row group ${g}` : `row group ${g} may hold ${x}, read it`, { probe });
      skip = below;
    }
    if (skip) {
      markCells(rec, rows, ['country', 'amount'], 'dim');
      rec.count('skipped');
      skipped++;
      continue;
    }
    read++;

    // Filter on the country chunk.
    const hits: number[] = [];
    if (enc) {
      const e = encodeChunk(values);
      tally('bytes', e.dictionary.length * ENTRY_BYTES + e.runs.length * RUN_BYTES);
      const code = e.dictionary.indexOf(x);
      rec.markCell(dictId(g), Math.max(0, code), 'compare');
      if (code < 0) {
        rec.line('filter', 'dict_test', 'dict_miss');
        rec.compare(x, '≠', `dictionary ${e.dictionary.join(' ')}`, `not in this chunk, skip it`, {
          probe: { text: x, at: dictId(g), cell: 0 },
          message: `Read row group ${g}'s country chunk: a dictionary of ${e.dictionary.length} and ${plural(e.runs.length, 'run')}. ${x} is not in its dictionary, so no row here can match. Not one code had to be looked at.`,
        });
        rec.markCell(dictId(g), 0, 'idle');
        markCells(rec, rows, ['country', 'amount'], 'dim');
        falseHit = true;
        continue;
      }
      rec.line('filter', 'dict_test', 'dict_hit');
      rec.compare(x, '=', `entry ${code}`, `${x} is code ${code} in this chunk`, {
        probe: { text: x, at: dictId(g), cell: code },
        message: `Read row group ${g}'s country chunk: a dictionary of ${e.dictionary.length} and ${plural(e.runs.length, 'run')}, ${e.dictionary.length * ENTRY_BYTES + e.runs.length * RUN_BYTES} bytes. Look ${x} up once in its dictionary: it is code ${code}. From here on the filter compares small numbers, not strings.`,
      });
      rec.markCell(dictId(g), code, 'ok');
      let start = 0;
      e.runs.forEach(([c, count], j) => {
        const span = rows.slice(start, start + count);
        const match = c === code;
        tally('values');
        rec.markCell(runsId(g), j, 'compare');
        markCells(rec, span, ['country'], 'compare');
        rec.line('filter', 'run_test', ...(match ? ['run_hit'] : []));
        rec.compare(`run ${c}×${count}`, match ? '=' : '≠', `code ${code}`, match ? `rows ${start} to ${start + count - 1} match` : `skip ${plural(count, 'row')}`, {
          probe: { text: x, at: runsId(g), cell: j },
          message: match
            ? `Run ${c}×${count}: code ${c} is ${x}, so ${count === 1 ? `position ${start} matches` : `positions ${start} to ${start + count - 1} all match`}. One comparison covers ${plural(count, 'row')}.`
            : `Run ${c}×${count}: code ${c} is not ${code}, so ${count === 1 ? `position ${start} is` : `positions ${start} to ${start + count - 1} are`} skipped with one comparison.`,
        });
        rec.markCell(runsId(g), j, match ? 'ok' : 'path');
        markCells(rec, span, ['country'], match ? 'ok' : 'path');
        for (let i = start; i < start + count; i++) if (match) hits.push(i);
        start += count;
      });
    } else {
      tally('bytes', values.length * VALUE_BYTES);
      rows.forEach((r, i) => {
        const match = r.country === x;
        tally('values');
        rec.markCell(cid(r, 'country'), 0, 'compare');
        rec.line('filter', 'scan', ...(match ? ['hit'] : []));
        rec.compare(x, match ? '=' : '≠', `position ${i}: ${r.country}`, match ? `keep position ${i}` : 'no match', { probe });
        rec.markCell(cid(r, 'country'), 0, match ? 'ok' : 'path');
        if (match) hits.push(i);
      });
    }
    if (!hits.length) {
      falseHit = true;
      markCells(rec, rows, ['amount'], 'dim');
      rec.line('none');
      rec.step(
        `No row in row group ${g} holds ${x}. Its min and max allowed it, but ${x} falls in a gap between the values that are there. The amount chunk is never read.`,
        { probe },
      );
      continue;
    }

    // Read the amount chunk, then pick out the positions that matched.
    const amounts = chunk(rows, 'amount');
    const aEnc = s.encoded.includes('amount');
    tally('values', aEnc ? encodeChunk(amounts).runs.length : amounts.length);
    tally('bytes', chunkBytes(amounts, aEnc));
    markCells(rec, rows, ['amount'], 'path');
    rec.line('amounts');
    rec.step(
      `Now read row group ${g}'s amount chunk, ${chunkBytes(amounts, aEnc)} bytes. Amount is fetched only after the filter has run, and only for row groups that matched. That is late materialisation.`,
      { probe: chipAt(s, x, g, 'amount') },
    );
    const picked = hits.map((i) => rows[i].amount);
    total += picked.reduce((a, b) => a + b, 0);
    markCells(rec, hits.map((i) => rows[i]), ['amount'], 'ok');
    rec.line('add');
    rec.step(`Add the amounts at ${hits.length === 1 ? 'position' : 'positions'} ${list(hits)}: ${picked.join(' + ')}. Total so far ${total}.`, {
      probe: chipAt(s, x, g, 'amount'),
    });
  }

  // Rows still in the memory buffer are not in any file yet.
  const b = bufferBlock(s);
  for (const r of s.buffer) {
    const match = r.country === x;
    tally('values', 2);
    rec.markCell(cid(r, 'country'), 0, 'compare');
    if (match) total += r.amount;
    rec.line('buffer_test', ...(match ? ['buffer_add'] : []));
    rec.compare(x, match ? '=' : '≠', `buffered: ${r.country}`, match ? `add ${r.amount}, total ${total}` : 'skip the row', {
      probe: chipAt(s, x, b, 'country'),
      message: `One row is still in the memory buffer, not in any file. The query has to check it too: ${r.country}${match ? `, a match, so add ${r.amount}` : `, no match`}.`,
    });
    rec.markCell(cid(r, 'country'), 0, match ? 'ok' : 'path');
    if (match) rec.markCell(cid(r, 'amount'), 0, 'ok');
  }

  const n = allRows(s).length;
  rec.line('col_done');
  rec.step(
    `SUM = ${total}, from ${plural(valuesRead, 'value')} and ${bytesRead} bytes. The reader opened 2 of 4 columns in ${read} of ${plural(s.groups.length, 'row group')}, and skipped ${skipped} on min and max alone` +
      (falseHit ? `. Min and max cannot rule out a value that falls between them, so a row group was opened for nothing` : ``) +
      `. The row file needs ${n * 4} values and ${n * 4 * VALUE_BYTES} bytes for the same answer.`,
  );
  return total;
}

// ---- encode ---------------------------------------------------------------------

/** Dictionary-encode one column chunk by chunk, then run-length encode the codes. Returns false when there was nothing to do. */
export function encode(s: StoreState, raw: number | string, rec: Rec): boolean {
  const col = parseCol(raw);
  rec.line('mark');
  if (!col) {
    rec.step(`Enter a column to encode: day, country, product or amount.`);
    return false;
  }
  toColumns(s, rec, `Encoding works on one column stored on its own.`);
  if (s.encoded.includes(col)) {
    s.panel = { kind: 'encode', col, coded: s.groups.map((g) => g.length), runs: s.groups.map(() => true) };
    rec.line('already');
    rec.step(`The ${col} column is already stored as dictionaries and runs, ${columnBytes(s, col)} bytes. There is nothing to do.`);
    return false;
  }
  const panel: Panel & { kind: 'encode' } = { kind: 'encode', col, coded: s.groups.map(() => 0), runs: s.groups.map(() => false) };
  s.panel = panel;
  const n = fileRows(s).length;
  const plain = n * VALUE_BYTES;
  rec.line('mark', 'each_chunk');
  rec.step(
    `Encode the ${col} column. Stored plainly it takes ${n} × ${VALUE_BYTES} = ${plain} bytes. Each row group's chunk gets its own dictionary, so a reader can decode one chunk without the others.`,
  );
  let codesTotal = 0;
  s.groups.forEach((rows, g) => {
    const values = chunk(rows, col);
    const dict: Val[] = [];
    const codes: number[] = [];
    values.forEach((v, i) => {
      const found = dict.indexOf(v);
      const before = dict.join(' ');
      const code = found < 0 ? dict.length : found;
      if (found < 0) dict.push(v);
      codes.push(code);
      panel.coded[g] = i + 1;
      rec.markCell(cid(rows[i], col), 0, 'key');
      rec.markCell(dictId(g), code, found < 0 ? 'ok' : 'compare');
      rec.markCell(codesId(g), i, 'ok');
      rec.line('next_value', 'lookup', ...(found < 0 ? ['add'] : []), 'code');
      rec.compare(String(v), found < 0 ? '≠' : '=', found < 0 ? (before ? `dictionary ${before}` : 'empty dictionary') : `entry ${found}`, found < 0 ? `new, add it as code ${code}` : `seen, write code ${code}`, {
        probe: { text: String(v), at: dictId(g), cell: code },
      });
      rec.markCell(dictId(g), code, 'idle');
      rec.markCell(codesId(g), i, 'idle');
      rec.markCell(cid(rows[i], col), 0, 'path');
    });
    const runs: [number, number][] = [];
    codes.forEach((c, i) => {
      const probe: Probe = { text: String(values[i]), at: codesId(g), cell: i };
      rec.markCell(cid(rows[i], col), 0, 'key');
      if (i === 0) {
        runs.push([c, 1]);
        rec.markCell(codesId(g), 0, 'compare');
        rec.line('next_code', 'new_run');
        rec.step(`Now run-length encode row group ${g}'s codes: store each run of equal codes once, with a count. The first code, ${c}, starts a run: ${c}×1.`, { probe });
      } else {
        const prev = codes[i - 1];
        const same = c === prev;
        if (same) runs[runs.length - 1][1]++;
        else runs.push([c, 1]);
        const last = runs[runs.length - 1];
        rec.markCell(codesId(g), i - 1, 'compare');
        rec.markCell(codesId(g), i, 'compare');
        rec.line('next_code', 'same', same ? 'extend' : 'new_run');
        rec.compare(`code ${c}`, same ? '=' : '≠', `previous ${prev}`, same ? `same as previous, run becomes ${last[0]}×${last[1]}` : `different, start run ${c}×1`, { probe });
        rec.markCell(codesId(g), i - 1, 'idle');
      }
      rec.markCell(codesId(g), i, 'idle');
      rec.markCell(cid(rows[i], col), 0, 'path');
    });
    panel.runs[g] = true;
    codesTotal += dict.length * ENTRY_BYTES + codes.length * CODE_BYTES;
    const p = values.length * VALUE_BYTES;
    const withCodes = dict.length * ENTRY_BYTES + codes.length * CODE_BYTES;
    const withRuns = dict.length * ENTRY_BYTES + runs.length * RUN_BYTES;
    rec.line('store');
    rec.step(
      `Row group ${g}: a dictionary of ${dict.length} and ${plural(runs.length, 'run')} (${runText(runs)}). ${p} bytes plain, ${withCodes} as dictionary and codes, ${withRuns} as dictionary and runs.`,
    );
  });
  s.encoded.push(col);
  const after = columnBytes(s, col);
  const runsTotal = s.groups.reduce((sum, g) => sum + encodeChunk(chunk(g, col)).runs.length, 0);
  let why: string;
  if (after >= plain) {
    why = `That is no smaller than plain: almost every value in a chunk is different, so the dictionary repeats the data and the runs are all 1 long. A real writer would notice and keep this column plain.`;
  } else if (col === 'country') {
    why = `The runs are long because the table is sorted by country: equal values sit next to each other. With a million rows per row group sorted the same way, each chunk would still be a few runs.`;
  } else {
    why = `The dictionary helps because there are only a few distinct values. The runs are short because the table is sorted by country, not ${col}: equal ${col} values are scattered.`;
  }
  rec.line('each_chunk');
  rec.step(
    `${col}: ${plain} bytes plain, ${codesTotal} as dictionaries and codes, ${after} as dictionaries and ${plural(runsTotal, 'run')}. ${why}` +
      (s.buffer.length ? ` The row in the memory buffer is encoded when it is flushed.` : ``),
  );
  return true;
}

// ---- bitmap ---------------------------------------------------------------------

/** The bits of a bitmap, row 0 first. */
export function bitsOf(s: StoreState, c: 'country' | 'product', v: string): string {
  return fileRows(s).map((r) => (r[c] === v ? '1' : '0')).join('');
}

export function distinct(s: StoreState, c: 'country' | 'product'): string[] {
  return [...new Set(fileRows(s).map((r) => r[c]))].sort();
}

/** COUNT(*) WHERE country = x AND product = y, by ANDing two bitmaps. Returns the count, or null for bad input. */
export function bitmap(s: StoreState, rawCountry: number | string, rawProduct: number | string, rec: Rec): number | null {
  const x = asCountry(rawCountry);
  const y = asProduct(rawProduct);
  rec.line('build');
  if (!/^[A-Z]{2}$/.test(x) || !/^[a-z]{2,4}$/.test(y)) {
    rec.step(`Enter a two-letter country code and a product, such as FR and tea. This table sells ${list(PRODUCTS)} in ${list(COUNTRIES)}.`);
    return null;
  }
  toColumns(s, rec, `Bitmap indexes are built from column chunks.`);
  const rows = fileRows(s);
  const n = rows.length;
  const countries = distinct(s, 'country');
  const products = distinct(s, 'product');
  const panel: Panel & { kind: 'bitmap' } = { kind: 'bitmap', country: x, product: y, built: 0, and: false };
  s.panel = panel;
  rec.line('build', 'set_bit');
  rec.step(
    `COUNT(*) WHERE country = ${x} AND product = ${y}, with bitmap indexes. Read each of the two columns once and keep one bitmap per distinct value: bit i is 1 when row i holds that value.`,
  );
  const scan = (c: 'country' | 'product', values: string[]) => {
    rec.count('values', n);
    rec.count('bytes', columnBytes(s, c));
    for (const v of values) {
      panel.built++;
      for (const r of rows) rec.markCell(cid(r, c), 0, r[c] === v ? 'path' : 'idle');
      const at = rows.flatMap((r, i) => (r[c] === v ? [i] : []));
      rec.step(`${c} = ${v}: ${at.length === 1 ? 'row' : 'rows'} ${list(at)}, so bitmap ${bitsOf(s, c, v)}.`);
    }
    for (const r of rows) rec.markCell(cid(r, c), 0, 'idle');
  };
  scan('country', countries);
  scan('product', products);

  const bytesPer = Math.ceil(n / 8);
  const pickOne = (c: 'country' | 'product', v: string, values: string[], anchor: string) => {
    const has = values.includes(v);
    rec.count('bytes', bytesPer);
    if (has) rec.mark(bmId(c, v), 'compare');
    rec.line(anchor);
    rec.compare(v, has ? '=' : '≠', has ? `bitmap ${v}` : `every ${c} bitmap`, has ? `use the bitmap for ${v}` : `no row has ${v}, so all zeros`, {
      probe: has ? { text: v, at: bmId(c, v), cell: 0 } : chipAt(s, v, 0, c),
    });
  };
  pickOne('country', x, countries, 'pick_a');
  pickOne('product', y, products, 'pick_b');

  const a = countries.includes(x) ? bitsOf(s, 'country', x) : '0'.repeat(n);
  const b = products.includes(y) ? bitsOf(s, 'product', y) : '0'.repeat(n);
  const both = [...a].map((bit, i) => (bit === '1' && b[i] === '1' ? '1' : '0')).join('');
  panel.and = true;
  rec.mark(AND_ID, 'ok');
  const andProbe: Probe = { text: `${x} ${y}`, at: AND_ID, cell: 0 };
  rec.line('and');
  rec.step(`AND the two bitmaps, bit by bit: ${a} AND ${b} = ${both}. A CPU does this 64 rows at a time, one instruction per 64-bit word.`, { probe: andProbe });
  const hits = rows.filter((_r, i) => both[i] === '1');
  const at = rows.flatMap((_r, i) => (both[i] === '1' ? [i] : []));
  markCells(rec, hits, ['country', 'product'], 'ok');
  let count = hits.length;
  rec.line('count');
  rec.step(count ? `Count the 1 bits: ${plural(count, 'row')}, at ${count === 1 ? 'row' : 'rows'} ${list(at)}.` : `There are no 1 bits: no row in the files has both.`, { probe: andProbe });

  const bb = bufferBlock(s);
  for (const r of s.buffer) {
    const match = r.country === x && r.product === y;
    if (match) count++;
    rec.count('values', 2);
    rec.line('buffer_test', ...(match ? ['buffer_add'] : []));
    rec.compare(`${r.country} ${r.product}`, match ? '=' : '≠', `${x} ${y}`, match ? `count it, ${count} now` : 'not counted', {
      probe: chipAt(s, `${x} ${y}`, bb, 'country'),
      message: `The row in the memory buffer is not indexed yet, so check it directly: ${r.country} and ${r.product}${match ? ', a match' : ', no match'}.`,
    });
    if (match) markCells(rec, [r], ['country', 'product'], 'ok');
  }
  rec.line('both_done');
  rec.step(
    `COUNT = ${count}. Building the bitmaps read both columns once. After that, the filter reads 2 bitmaps of ${n} bits, ${bytesPer * 2} bytes, whatever the conditions. Bitmaps suit columns with few distinct values: ${countries.length} countries and ${products.length} products here.`,
  );
  return count;
}

// ---- append ---------------------------------------------------------------------

/** Append one row. Returns false when the input is bad or the page has no room. */
export function append(s: StoreState, rawCountry: number | string, rawProduct: number | string, rawAmount: number | string, rec: Rec): boolean {
  const x = asCountry(rawCountry);
  const y = asProduct(rawProduct);
  const amount = Number(rawAmount);
  rec.line('row_file');
  if (!COUNTRIES.includes(x) || !PRODUCTS.includes(y) || !Number.isInteger(amount) || amount < 1 || amount > 99) {
    rec.step(`This page's table sells ${list(PRODUCTS)} in ${list(COUNTRIES)}, for amounts from 1 to 99. Enter one of each.`);
    return false;
  }
  toColumns(s, rec, `In the row file an append is one write at the end of the file. The column file is where writes are awkward.`);
  // Bitmaps drawn for an earlier query would not include the new row: put them away.
  if (s.panel.kind === 'bitmap') s.panel = { kind: 'none' };
  if (s.groups.length >= MAX_GROUPS) {
    rec.line('buffer');
    rec.step(
      `Sorry, this page has room for one new file, and it is already there. Use Reset to start again. A real table keeps adding files, and compaction merges the small ones.`,
    );
    return false;
  }
  const row: Row = { id: s.nextId++, day: NEW_DAY, country: x, product: y, amount };
  const no = allRows(s).length;
  const b = bufferBlock(s);
  const name = `row ${no}`;
  rec.step(
    `Append ${name}: day ${NEW_DAY}, ${x}, ${y}, ${amount}. In a row file this is one write: put the 4 values at the end of the file, side by side.`,
    { probe: chipAt(s, name, b, 'country') },
  );
  const last = s.groups[s.groups.length - 1];
  markCells(rec, [last[last.length - 1]], COLS, 'compare');
  rec.line('buffer');
  rec.step(
    `In the column file the 4 values belong in 4 different column chunks, and each chunk's min, max and position are in the footer, written last. A Parquet file is never changed after it is written, so a new value cannot go in.`,
    { probe: chipAt(s, name, b, 'country') },
  );
  markCells(rec, [last[last.length - 1]], COLS, 'idle');
  s.buffer.push(row);
  markCells(rec, [row], COLS, 'ok');
  rec.step(`So the row goes into a buffer in memory instead, as an LSM tree's memtable does. Nothing on disk changes.`, { probe: chipAt(s, name, b, 'country') });

  const full = s.buffer.length >= FLUSH_ROWS;
  rec.line('full', ...(full ? ['flush'] : []));
  rec.compare(`buffer ${plural(s.buffer.length, 'row')}`, full ? '≥' : '<', `flush at ${FLUSH_ROWS}`, full ? 'write a new file' : 'keep waiting', {
    probe: chipAt(s, name, b, 'country'),
  });
  if (!full) {
    rec.step(
      `${name[0].toUpperCase()}${name.slice(1)} waits in memory, and queries read the buffer as well as the files. A crash would lose it, so a real system also appends it to a log first. Batching is the point: one new file of many rows instead of rewriting files for each row.`,
      { probe: chipAt(s, name, b, 'country') },
    );
    return true;
  }

  // Flush: sort, cut into column chunks with stats, write a new immutable file.
  s.buffer.sort((p, q) => (p.country < q.country ? -1 : p.country > q.country ? 1 : 0));
  rec.line('sort');
  rec.step(
    `The buffer is full. Sort its ${FLUSH_ROWS} rows by country, so the new file is in country order inside, like the rest of the table.`,
    { probe: chipAt(s, name, b, 'country') },
  );
  const rows = s.buffer;
  s.groups.push(rows);
  s.buffer = [];
  const g = s.groups.length - 1;
  const lo = String(minOf(chunk(rows, 'country')));
  const hi = String(maxOf(chunk(rows, 'country')));
  const aLo = minOf(chunk(rows, 'amount'));
  const aHi = maxOf(chunk(rows, 'amount'));
  markCells(rec, rows, COLS, 'ok');
  rec.line('split', 'stats');
  rec.step(
    `Cut the rows into 4 column chunks and work out each chunk's min and max: country ${lo} to ${hi}, amount ${aLo} to ${aHi}.` +
      (s.encoded.length ? ` ${list(s.encoded)} ${s.encoded.length === 1 ? 'is' : 'are'} encoded as ${s.encoded.length === 1 ? 'it is' : 'they are'} written, with dictionaries for this chunk.` : ``),
    { probe: chipAt(s, name, g, 'country') },
  );
  const bytes = COLS.reduce((sum, c) => sum + chunkBytes(chunk(rows, c), s.encoded.includes(c)), 0);
  rec.count('files');
  rec.line('write');
  rec.step(
    `Write it as a new file: ${FLUSH_ROWS} rows, 4 chunks and a footer, ${bytes} bytes of data. The old row groups are not touched. Files are only ever added, never changed.`,
    { probe: chipAt(s, name, g, 'country') },
  );
  const overlaps = s.groups.slice(0, g).flatMap((other, k) => {
    const v = chunk(other, 'country');
    return String(maxOf(v)) >= lo && String(minOf(v)) <= hi ? [k] : [];
  });
  rec.step(
    `This file holds countries ${lo} to ${hi}` +
      (overlaps.length
        ? `, which overlaps row ${overlaps.length === 1 ? 'group' : 'groups'} ${list(overlaps)}. A query for any country in that range now opens this file too.`
        : `.`) +
      ` Many small files with overlapping ranges make reads slower, so tables are compacted: small files merged and sorted into big ones, as an LSM tree merges its sorted runs.`,
  );
  return true;
}

/** Back to the example table, nothing encoded and nothing buffered. */
export function reset(s: StoreState, rec: Rec): void {
  const fresh = create(s.setting);
  Object.assign(s, fresh);
  rec.line('reset');
  rec.step(`Back to the ${SAMPLE.length} example rows, sorted by country into 3 row groups of 4. Nothing is encoded and the buffer is empty.`);
}

// ---- layout ---------------------------------------------------------------------

const CELL_W = 46;
/** In the column file a strip's cells touch and strips stand apart; in the row file it is the other way round. */
const COL_PITCH = 58;
const ROW_CELL_PITCH = CELL_W + 3;
const STRIP_ROW_PITCH = CELL_H + 3;
const RECORD_PITCH = CELL_H + 8;
const BLOCK_W = 3 * COL_PITCH + CELL_W;
const BLOCK_GAP = 14;
const BLOCK_PITCH = BLOCK_W + BLOCK_GAP;
const CODE_W = 32;
const RUN_W = 46;
const BM_LABEL_W = 44;
const BM_GAP = 10;
const CHIP_ROOM = PROBE_H + 9 + 6;
const TRAY_H = CELL_H + TRAY_PAD * 2;

const blockLeft = (b: number) => b * BLOCK_PITCH;
const blockMid = (b: number) => blockLeft(b) + BLOCK_W / 2;
/** Rows are drawn as records (row file, memory buffer) or as strips of column chunks. */
const cellX = (b: number, c: number, strips: boolean) => blockLeft(b) + c * (strips ? COL_PITCH : ROW_CELL_PITCH) + CELL_W / 2;
const cellY = (i: number, strips: boolean) => i * (strips ? STRIP_ROW_PITCH : RECORD_PITCH);
const GRID_BOTTOM = cellY(GROUP_ROWS - 1, false) + CELL_H / 2;
const LABEL_Y = GRID_BOTTOM + CAPTION_ROOM + LABEL_MAX / 2 + 2;
/** Panel rows: room above each for the chip, and sub labels under row A. */
export const A_Y = LABEL_Y + LABEL_MAX / 2 + CHIP_ROOM + TRAY_H / 2;
export const B_Y = A_Y + TRAY_H / 2 + SUB_ROOM + CHIP_ROOM + TRAY_H / 2;
const TOP = -CELL_H / 2 - TITLE_ROOM - PROBE_H - 9 - 4;
const BOTTOM = B_Y + TRAY_H / 2 + 4;
const LEFT = -6;
const RIGHT = blockLeft(MAX_GROUPS - 1) + BLOCK_W + 6;
/** Bands sit behind the cells and show what is stored together. */
const BAND_PAD = 4;

function recordBand(r: Row, b: number, i: number): Decor {
  const w = 3 * ROW_CELL_PITCH + CELL_W;
  return { id: `band-r${r.id}`, type: 'band', x: blockLeft(b) - BAND_PAD, y: cellY(i, false) - CELL_H / 2 - BAND_PAD, w: w + BAND_PAD * 2, h: CELL_H + BAND_PAD * 2 };
}

function bmNode(id: string, label: string, bits: string, k: number, y: number, n: number): SceneNode {
  const bitsW = Math.ceil(n * 9.9) + 22;
  const w = TRAY_PAD * 2 + BM_LABEL_W + 3 + bitsW;
  return { id, x: k * (w + BM_GAP) + w / 2, y, cells: [{ text: label, w: BM_LABEL_W }, { text: bits, w: bitsW }] };
}

export function layout(s: StoreState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const columnar = s.layout === 'column';

  // The row groups.
  s.groups.forEach((rows, g) => {
    rows.forEach((r, i) => {
      COLS.forEach((c, ci) => {
        const caption = columnar && i === rows.length - 1 ? `${minOf(chunk(rows, c))}–${maxOf(chunk(rows, c))}` : undefined;
        nodes.push({ id: cid(r, c), x: cellX(g, ci, columnar), y: cellY(i, columnar), cells: [{ text: String(r[c]), w: CELL_W }], title: i === 0 ? HEAD[c] : undefined, caption });
      });
      if (!columnar) decor.push(recordBand(r, g, i));
    });
    if (columnar) {
      COLS.forEach((_c, ci) => {
        decor.push({ id: `band-g${g}-${ci}`, type: 'band', x: cellX(g, ci, true) - CELL_W / 2 - BAND_PAD, y: -CELL_H / 2 - BAND_PAD, w: CELL_W + BAND_PAD * 2, h: cellY(rows.length - 1, true) + CELL_H + BAND_PAD * 2 });
      });
    }
    const first = s.groups.slice(0, g).reduce((sum, x) => sum + x.length, 0);
    const label = columnar ? (g < 3 ? `row group ${g}` : `new file`) : `rows ${first} to ${first + rows.length - 1}`;
    decor.push({ id: `label-${g}`, type: 'label', x: blockLeft(g), y: LABEL_Y, text: label, strong: true });
  });

  // The memory buffer, in the slot after the last row group.
  if (s.groups.length < MAX_GROUPS) {
    const b = bufferBlock(s);
    for (let i = 0; i < FLUSH_ROWS; i++) {
      const r = s.buffer[i];
      COLS.forEach((c, ci) => {
        nodes.push({ id: r ? cid(r, c) : sid(i, c), x: cellX(b, ci, false), y: cellY(i, false), cells: [{ text: r ? String(r[c]) : '', w: CELL_W }], title: i === 0 ? HEAD[c] : undefined });
      });
      if (r) decor.push(recordBand(r, b, i));
    }
    const first = fileRows(s).length;
    const label = columnar ? `memory buffer` : s.buffer.length ? `rows ${first} to ${first + s.buffer.length - 1}` : `end of file`;
    decor.push({ id: `label-${b}`, type: 'label', x: blockLeft(b), y: LABEL_Y, text: label, strong: true });
  }

  // What the last operation built, under the table. Only the column file has it.
  const p = s.panel;
  if (columnar && p.kind === 'encode') {
    const enc = s.encoded.includes(p.col);
    s.groups.forEach((rows, g) => {
      const values = chunk(rows, p.col);
      const k = Math.min(values.length, p.coded[g] ?? (enc ? values.length : 0));
      if (k === 0) return;
      const e = encodeChunk(values.slice(0, k));
      nodes.push({ id: dictId(g), x: blockMid(g), y: A_Y, cells: e.dictionary.map((v, j) => ({ text: String(v), sub: String(j) })) });
      if (p.runs[g] ?? enc) {
        nodes.push({ id: runsId(g), x: blockMid(g), y: B_Y, cells: e.runs.map(([c, n]) => ({ text: `${c}×${n}`, w: RUN_W })), from: codesId(g) });
      } else {
        nodes.push({ id: codesId(g), x: blockMid(g), y: B_Y, cells: e.codes.map((c) => ({ text: String(c), w: CODE_W })) });
      }
    });
    // Say what the two rows are, in the empty slot beside them when there is one.
    if (s.groups.length < MAX_GROUPS) {
      const x = blockLeft(s.groups.length);
      decor.push({ id: 'panel-a', type: 'label', x, y: A_Y - LABEL_MAX * 0.6, text: `${p.col}: a dictionary\nper chunk` });
      decor.push({ id: 'panel-b', type: 'label', x, y: B_Y - LABEL_MAX * 0.6, text: `codes, then runs\nas code×count` });
    }
  } else if (columnar && p.kind === 'bitmap') {
    const n = fileRows(s).length;
    const countries = distinct(s, 'country');
    const products = distinct(s, 'product');
    countries.slice(0, p.built).forEach((v, k) => nodes.push(bmNode(bmId('country', v), v, bitsOf(s, 'country', v), k, A_Y, n)));
    products.slice(0, Math.max(0, p.built - countries.length)).forEach((v, k) => nodes.push(bmNode(bmId('product', v), v, bitsOf(s, 'product', v), k, B_Y, n)));
    if (p.and) {
      const a = bitsOf(s, 'country', p.country);
      const b = bitsOf(s, 'product', p.product);
      const both = [...a].map((bit, i) => (bit === '1' && b[i] === '1' ? '1' : '0')).join('');
      nodes.push(bmNode(AND_ID, 'AND', both, 3, B_Y, n));
    }
  }

  // Two empty labels pin the corners, so the view keeps its size from one operation to the next.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------------

const layoutOf = (v: number | undefined): Layout => (v === 0 ? 'row' : 'column');

function suggestCountry(): string {
  return randomInt(0, 5) === 0 ? 'PL' : pick(COUNTRIES);
}

function suggestColumn(s: StoreState): Col {
  const open = COLS.filter((c) => !s.encoded.includes(c));
  if (open.includes('country') && randomInt(0, 1) === 0) return 'country';
  return open.length ? pick(open) : pick(COLS);
}

const def: StructureDef<StoreState> = {
  id: 'column-store',
  params: [
    {
      id: 'layout',
      label: 'Layout for queries',
      default: 1,
      options: [
        { value: 0, label: 'row' },
        { value: 1, label: 'column' },
      ],
    },
  ],
  create: (params) => create(layoutOf(params.layout)),
  // The example table is built by create(); there is nothing more to add.
  seed: [],
  ops: [
    {
      id: 'sum',
      label: 'Sum',
      intent: 'primary',
      args: [
        { name: 'country', label: 'Country', kind: 'word' },
        { name: 'layout', label: 'Layout (row or column)', kind: 'word' },
      ],
      code: ['sum_columns', 'matching', 'sum_rows'],
      run: (s, [c, l], rec) => void sum(s, c, l, rec),
      suggest: (s) => [suggestCountry(), s.setting],
    },
    {
      id: 'encode',
      label: 'Encode',
      args: [{ name: 'column', label: 'Column', kind: 'word' }],
      code: ['encode', 'encode_chunk'],
      run: (s, [c], rec) => void encode(s, c, rec),
      suggest: (s) => [suggestColumn(s)],
    },
    {
      id: 'bitmap',
      label: 'Bitmap AND',
      args: [
        { name: 'country', label: 'Country', kind: 'word' },
        { name: 'product', label: 'Product', kind: 'word' },
      ],
      code: ['bitmap', 'bitmaps'],
      run: (s, [c, p], rec) => void bitmap(s, c, p, rec),
      suggest: () => [pick(COUNTRIES), pick(PRODUCTS)],
    },
    {
      id: 'append',
      label: 'Append',
      args: [
        { name: 'country', label: 'Country', kind: 'word' },
        { name: 'product', label: 'Product', kind: 'word' },
        { name: 'amount', label: 'Amount', kind: 'int', min: 1, max: 99 },
      ],
      code: ['append', 'flush', 'chunk'],
      run: (s, [c, p, a], rec) => void append(s, c, p, a, rec),
      suggest: () => [pick(COUNTRIES), pick(PRODUCTS), randomInt(10, 60)],
    },
    { id: 'reset', label: 'Reset', intent: 'danger', args: [], code: ['reset'], run: (s, _args, rec) => reset(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'values', label: 'Values read' },
    { key: 'bytes', label: 'Bytes read' },
    { key: 'skipped', label: 'Row groups skipped' },
    { key: 'files', label: 'Files written' },
  ],
  status: (s) => [
    { label: 'Rows', value: `${fileRows(s).length} in files, ${s.buffer.length} in memory` },
    { label: 'Drawn as', value: s.layout === 'row' ? 'row file' : 'column file' },
    { label: 'Encoded', value: s.encoded.length ? s.encoded.join(', ') : 'nothing yet' },
    { label: 'Country column', value: `${columnBytes(s, 'country')} bytes` },
  ],
  tour: [
    ['encode', 'country'],
    ['sum', 'UK', 'row'],
    ['sum', 'UK', 'column'],
    ['bitmap', 'FR', 'tea'],
    ['append', 'IT', 'pie', 20],
    ['append', 'DE', 'tea', 30],
  ],
  source: { python, java },
  info,
};

export default def;
