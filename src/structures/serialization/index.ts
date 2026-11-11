import { CAPTION_ROOM, LABEL_MAX, PROBE_H, SUB_ROOM, labelWidth } from '../../core/fit';
import { CELL_H, TRAY_PAD, cellsWidth } from '../../core/geometry';
import type { Cell, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/Serialization.java?raw';
import python from './code/serialization.py?raw';
import { info } from './info';

/**
 * Serialisation and schema evolution.
 *
 * One small record is written by a writer with one version of the schema and
 * read by a reader with another. The bytes are real: the protobuf ones match
 * what the protobuf library writes, and the Avro ones match fastavro. The
 * page follows one field (magenta) through the bytes.
 *
 * `groups` is the message: one group of bytes per field written. `read` is
 * what the reader made of it. `bench` is the scratch arithmetic for the
 * current step (key bits, 7-bit groups, sizes).
 */
export type Format = 'protobuf' | 'avro' | 'json';
export type Kind = 'int' | 'sint' | 'string' | 'opt' | 'ints';
export type Value = number | string | number[] | null;
export type SchemaId = 'v1' | 'v2' | 'v3' | 'reuse' | 'sint' | 'nodefault' | 'rename' | 'jtype';

export interface Field {
  num: number;
  name: string;
  kind: Kind;
  /** An Avro reader field with no default. */
  noDefault?: boolean;
}

export interface Schema {
  id: SchemaId;
  label: string;
  fields: Field[];
}

export interface ByteCell {
  v: number;
  /** What the byte is: key, len, a character. */
  role: string;
}

export interface Group {
  id: string;
  /** The writer's field this group holds. */
  field: Field;
  bytes: ByteCell[];
  /** JSON only: the text of the fragment. */
  text?: string;
  state: 'plain' | 'read' | 'skipped' | 'bad';
}

export interface ReadValue {
  text: string;
  tone?: 'ok' | 'bad';
  /** Filled from a default, not from the bytes. */
  def?: boolean;
}

export interface SerState {
  format: Format;
  writer: SchemaId;
  reader: SchemaId;
  /** The schema the current bytes were written with. */
  wrote: SchemaId;
  groups: Group[];
  read: Record<string, ReadValue>;
  bench: Cell[][];
}

const ID: Field = { num: 1, name: 'id', kind: 'int' };
const NAME: Field = { num: 2, name: 'name', kind: 'string' };
const EMAIL: Field = { num: 3, name: 'email', kind: 'opt' };
const SCORES: Field = { num: 4, name: 'scores', kind: 'ints' };
const PLAN: Field = { num: 5, name: 'plan', kind: 'string' };

export const SCHEMAS: Record<SchemaId, Schema> = {
  v1: { id: 'v1', label: 'v1', fields: [ID, NAME, EMAIL, SCORES] },
  v2: { id: 'v2', label: 'v2', fields: [ID, NAME, EMAIL, SCORES, PLAN] },
  v3: { id: 'v3', label: 'v3', fields: [ID, NAME, SCORES, PLAN] },
  reuse: { id: 'reuse', label: 'v3, 4 reused', fields: [ID, NAME, EMAIL, { num: 4, name: 'nick', kind: 'string' }] },
  sint: { id: 'sint', label: 'v3, id sint32', fields: [{ num: 1, name: 'id', kind: 'sint' }, NAME, EMAIL, SCORES] },
  nodefault: { id: 'nodefault', label: 'v3, no default', fields: [ID, NAME, SCORES, { ...PLAN, noDefault: true }] },
  rename: { id: 'rename', label: 'v3, renamed', fields: [ID, { num: 2, name: 'fullName', kind: 'string' }, EMAIL, SCORES] },
  jtype: { id: 'jtype', label: 'v3, id as text', fields: [{ num: 1, name: 'id', kind: 'string' }, NAME, EMAIL, SCORES] },
};

/** The record every writer writes. */
export const RECORD: Record<string, Value> = { id: 1337, name: 'Ada', email: null, scores: [3, 7], plan: 'pro', nick: 'Ada', fullName: 'Ada' };

export function valueOf(schema: SchemaId, f: Field): Value {
  if (schema === 'jtype' && f.name === 'id') return '1337';
  return RECORD[f.name] ?? null;
}

export function typeName(format: Format, k: Kind): string {
  if (format === 'protobuf') return { int: 'int32', sint: 'sint32', string: 'string', opt: 'string?', ints: 'int32[]' }[k];
  if (format === 'avro') return { int: 'int', sint: 'int', string: 'string', opt: 'string?', ints: 'int[]' }[k];
  return { int: 'number', sint: 'number', string: 'string', opt: 'string?', ints: 'array' }[k];
}

/** The reader's default for a field it did not find, or undefined when it has none. */
export function defaultOf(format: Format, f: Field): Value | undefined {
  if (f.noDefault) return undefined;
  if (f.kind === 'opt') return null;
  if (f.kind === 'ints') return [];
  if (format === 'avro' && f.name === 'plan') return 'free';
  return f.kind === 'string' ? '' : 0;
}

// ---- pure encoders, the same as the listings --------------------------------

export function varintBytes(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
export const unzigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const wireOf = (k: Kind) => (k === 'int' || k === 'sint' ? 0 : 2);

export function encodeProto(schema: SchemaId): number[] {
  const out: number[] = [];
  for (const f of SCHEMAS[schema].fields) {
    const v = valueOf(schema, f);
    if (v === null || (Array.isArray(v) && v.length === 0)) continue;
    out.push(...varintBytes((f.num << 3) | wireOf(f.kind)));
    if (typeof v === 'string') {
      const b = utf8(v);
      out.push(...varintBytes(b.length), ...b);
    } else if (Array.isArray(v)) {
      const packed = v.flatMap(varintBytes);
      out.push(...varintBytes(packed.length), ...packed);
    } else out.push(...varintBytes(f.kind === 'sint' ? zigzag(v) : v));
  }
  return out;
}

function avroValue(f: Field, v: Value): number[] {
  if (f.kind === 'opt') return v === null ? [0] : [2, ...avroValue({ ...f, kind: 'string' }, v)];
  if (typeof v === 'string') {
    const b = utf8(v);
    return [...varintBytes(zigzag(b.length)), ...b];
  }
  if (Array.isArray(v)) return v.length ? [...varintBytes(zigzag(v.length)), ...v.flatMap((x) => varintBytes(zigzag(x))), 0] : [0];
  return varintBytes(zigzag(v ?? 0));
}

export function encodeAvro(schema: SchemaId): number[] {
  return SCHEMAS[schema].fields.flatMap((f) => avroValue(f, valueOf(schema, f)));
}

function jsonParts(schema: SchemaId): { f: Field; text: string }[] {
  const parts = SCHEMAS[schema].fields.filter((f) => valueOf(schema, f) !== null).map((f) => ({ f, text: `${JSON.stringify(f.name)}:${JSON.stringify(valueOf(schema, f))}` }));
  return parts.map((p, i) => ({ f: p.f, text: (i === 0 ? '{' : ',') + p.text + (i === parts.length - 1 ? '}' : '') }));
}

export function encodeJson(schema: SchemaId): string {
  const parts = jsonParts(schema);
  return parts.length ? parts.map((p) => p.text).join('') : '{}';
}

export function sizeIn(format: Format, schema: SchemaId): number {
  if (format === 'protobuf') return encodeProto(schema).length;
  if (format === 'avro') return encodeAvro(schema).length;
  return utf8(encodeJson(schema)).length;
}

// ---- helpers for the animation ----------------------------------------------

export const hex = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const bin = (n: number, w: number) => n.toString(2).padStart(w, '0');
const bytesWord = (n: number) => `${n} ${n === 1 ? 'byte' : 'bytes'}`;

/** How a value is drawn in a table cell. */
export function show(v: Value | undefined, quote = false): string {
  if (v === undefined) return '';
  if (v === null) return 'unset';
  if (Array.isArray(v)) return `[${v.join(',')}]`;
  if (typeof v === 'number') return String(v);
  const esc = v.replace(/[\u0000-\u001f]/g, (c) => `\\x${hex(c.charCodeAt(0)).toLowerCase()}`);
  return quote || v === '' ? `"${esc}"` : esc;
}

const same = (a: Value | undefined, b: Value | undefined) => JSON.stringify(a) === JSON.stringify(b);
const gid = (f: Field) => `g-${f.name}`;
const wrow = (name: string) => `w-${name}`;
const rrow = (name: string) => `r-${name}`;
const reader = (s: SerState) => SCHEMAS[s.reader].fields;
const wrote = (s: SerState) => SCHEMAS[s.wrote].fields;

/** The leftmost node of a table row, for a probe placed to its left. */
const firstCell = (s: SerState, row: string) => row + (s.format === 'protobuf' ? ':num' : ':name');
const ROW_PARTS = ['', ':num', ':name', ':type'];
function markRow(rec: Rec, row: string, tone: Tone): void {
  for (const p of ROW_PARTS) rec.mark(row + p, tone);
}
function unmarkRow(rec: Rec, row: string): void {
  for (const p of ROW_PARTS) rec.unmark(row + p);
}

function newGroup(s: SerState, f: Field): Group {
  const g: Group = { id: gid(f), field: f, bytes: [], state: 'plain' };
  s.groups.push(g);
  return g;
}

function startMessage(s: SerState): void {
  s.wrote = s.writer;
  s.groups = [];
  s.read = {};
  s.bench = [];
}

/** Every byte of the message, with the group and cell it is drawn in. */
function flat(s: SerState): { g: Group; c: number; v: number }[] {
  return s.groups.flatMap((g) => g.bytes.map((b, c) => ({ g, c, v: b.v })));
}

/** The 7-bit groups of n, most significant first, for the bench. */
function sevens(n: number): Cell[] {
  const out: Cell[] = [];
  let i = 0;
  do {
    out.unshift({ text: bin(n % 128, 7), sub: i === 0 ? 'low 7' : 'next 7' });
    n = Math.floor(n / 128);
    i++;
  } while (n > 0);
  return out;
}

interface VarintOpts {
  detail: boolean;
  /** Anchors lit with the write, before w_more or w_last. */
  lead: string[];
  /** Whose number this is, for the comparison pill. */
  what: string;
  /** Probe text: the field being written. */
  follow: string;
  /** The role under each byte written. */
  roles: (i: number) => string;
  /** Said before the first comparison. */
  intro?: string;
  /** Show the 7-bit groups and the bytes on the bench. */
  bits?: boolean;
}

/** Write n as a varint into group g, one comparison per byte, as write_varint does. */
function writeVarint(s: SerState, rec: Rec, g: Group, n: number, o: VarintOpts): void {
  const bytes = varintBytes(n);
  if (o.detail && o.bits) s.bench = [sevens(n), []];
  let rest = n;
  bytes.forEach((b, i) => {
    const last = i === bytes.length - 1;
    g.bytes.push({ v: b, role: o.roles(i) });
    rec.count('written');
    if (!o.detail) {
      rest = Math.floor(rest / 128);
      return;
    }
    const cell = g.bytes.length - 1;
    if (o.bits) s.bench[1].push({ text: `${last ? 0 : 1} ${bin(rest % 128, 7)}`, sub: hex(b) });
    rec.markCell(g.id, cell, 'key');
    rec.line(...o.lead, last ? 'w_last' : 'w_more');
    const lead = i === 0 && o.intro ? `${o.intro} ` : '';
    rec.compare(`${o.what}: ${rest}`, last ? '<' : '≥', 128, last ? 'last byte: top bit clear' : 'more bytes follow: top bit set', {
      probe: { text: o.follow, at: g.id, cell },
      message: last
        ? `${lead}${rest} < 128, so it fits in 7 bits. Write ${hex(b)} with the top bit clear: the number ends at this byte.`
        : `${lead}${rest} ≥ 128, so 7 bits are not enough. Write its low 7 bits, ${bin(rest % 128, 7)}, with the top bit set to mean "more follows": ${hex(b)}. That leaves ${Math.floor(rest / 128)}.`,
    });
    rec.markCell(g.id, cell, 'ok');
    rest = Math.floor(rest / 128);
  });
}

/** Labels under the bytes of one varint: lowest group first. */
const varintRoles = (len: number) => (i: number) => (len === 1 ? 'value' : i === 0 ? 'low' : i === len - 1 ? 'high' : 'mid');

function pushBytes(rec: Rec, g: Group, bytes: number[], roles: (i: number) => string): number[] {
  const from = g.bytes.length;
  bytes.forEach((v, i) => g.bytes.push({ v, role: roles(i) }));
  rec.count('written', bytes.length);
  return bytes.map((_, i) => from + i);
}

const chars = (v: string) => {
  const list = [...v];
  return (i: number) => (list.length === utf8(v).length ? list[i] ?? '' : '');
};

function sizesBench(s: SerState): void {
  // One node, so no arrows: these are three sizes side by side, not steps.
  s.bench = [
    [
      { text: `${sizeIn('protobuf', s.wrote)} B`, sub: 'protobuf', w: 64 },
      { text: `${sizeIn('avro', s.wrote)} B`, sub: 'Avro', w: 64 },
      { text: `${sizeIn('json', s.wrote)} B`, sub: 'JSON', w: 64 },
    ],
  ];
}

// ---- encode -----------------------------------------------------------------

type Level = 'full' | 'field' | 'none';

function encodeProtoAnim(s: SerState, rec: Rec, level: Level): void {
  startMessage(s);
  const detail = level === 'full';
  for (const f of wrote(s)) {
    const v = valueOf(s.wrote, f);
    const row = wrow(f.name);
    const atRow: Probe = { text: f.name, at: firstCell(s, row), place: 'left' };
    if (detail) markRow(rec, row, 'path');
    if (v === null || (Array.isArray(v) && v.length === 0)) {
      if (detail) {
        rec.line('e_field', 'e_absent');
        rec.step(`Field ${f.num}, ${f.name}, is unset. Nothing is written for it, not even a key: an absent field costs 0 bytes.`, { probe: atRow });
        unmarkRow(rec, row);
      }
      continue;
    }
    const wire = wireOf(f.kind);
    const g = newGroup(s, f);
    const type = typeName('protobuf', f.kind);
    if (detail) {
      rec.line('e_field');
      rec.step(
        `Field ${f.num}, ${f.name} = ${show(v, true)}. Its type, ${type}, travels as wire type ${wire}, ${wire === 0 ? 'a varint' : 'length-delimited: a length, then that many bytes'}.`,
        { probe: atRow },
      );
    }
    const key = (f.num << 3) | wire;
    if (detail) s.bench = [[{ text: '0', sub: 'more?' }, { text: bin(f.num, 4), sub: `field ${f.num}` }, { text: bin(wire, 3), sub: `wire ${wire}` }], [{ text: hex(key), sub: 'key' }]];
    writeVarint(s, rec, g, key, {
      detail,
      lead: ['e_key'],
      what: `${f.name} key`,
      follow: f.name,
      roles: () => 'key',
      intro: `The key is (field number << 3) | wire type = (${f.num} << 3) | ${wire} = ${key}. The name "${f.name}" is never sent.`,
    });
    if (typeof v === 'string') {
      const b = utf8(v);
      if (detail) s.bench = [];
      writeVarint(s, rec, g, b.length, { detail, lead: ['e_len'], what: `${f.name} length`, follow: f.name, roles: () => 'len', intro: `Then the length: "${v}" is ${bytesWord(b.length)} of UTF-8.` });
      const cells = pushBytes(rec, g, b, chars(v));
      if (detail) {
        for (const c of cells) rec.markCell(g.id, c, 'key');
        rec.line('e_bytes');
        rec.step(`Then the ${bytesWord(b.length)} themselves: ${b.map(hex).join(' ')}. A reader that does not know field ${f.num} can jump over them using the length alone.`, {
          probe: { text: f.name, at: g.id, cell: cells[0] },
        });
        for (const c of cells) rec.markCell(g.id, c, 'ok');
      }
    } else if (Array.isArray(v)) {
      // Pack the values first, on the bench, so the length is known.
      const packed: number[] = [];
      if (detail) s.bench = [[]];
      for (const x of v) {
        const xb = varintBytes(x);
        if (detail) {
          s.bench[0].push(...xb.map((b) => ({ text: hex(b), sub: String(x) })));
          rec.line('e_pack', xb.length > 1 ? 'w_more' : 'w_last');
          rec.compare(`${f.name}: ${x}`, xb.length > 1 ? '≥' : '<', 128, xb.length > 1 ? 'more than one byte' : 'one byte', {
            probe: { text: f.name, at: 'b0', cell: s.bench[0].length - 1 },
            message: `Packed: the values go one after another as varints, with one key for the lot. ${x} ${xb.length > 1 ? '≥' : '<'} 128, so it takes ${bytesWord(xb.length)}: ${xb.map(hex).join(' ')}.`,
          });
          for (let k = 1; k < xb.length; k++) rec.count('comparisons');
        }
        packed.push(...xb);
      }
      writeVarint(s, rec, g, packed.length, { detail, lead: ['e_len'], what: `${f.name} length`, follow: f.name, roles: () => 'len', intro: `The packed values take ${bytesWord(packed.length)}, so the length is ${packed.length}.` });
      const cells = pushBytes(rec, g, packed, (i) => {
        let at = 0;
        for (const x of v) {
          const n = varintBytes(x).length;
          if (i < at + n) return String(x);
          at += n;
        }
        return '';
      });
      if (detail) {
        for (const c of cells) rec.markCell(g.id, c, 'key');
        rec.line('e_bytes');
        rec.step(`Then the packed bytes: ${packed.map(hex).join(' ')}. Two numbers under one key and one length.`, { probe: { text: f.name, at: g.id, cell: cells[0] } });
        for (const c of cells) rec.markCell(g.id, c, 'ok');
      }
    } else {
      const n = f.kind === 'sint' ? zigzag(v) : v;
      if (f.kind === 'sint' && detail) {
        s.bench = [[{ text: String(v), sub: 'value' }], [{ text: String(n), sub: 'zigzag' }]];
        rec.line('e_zigzag', 'z_enc');
        rec.step(`sint32 zigzags first: zigzag(${v}) = ${n}. Small negative numbers then stay short, but the bytes are different from int32's.`, { probe: { text: f.name, at: g.id, cell: 0 } });
      }
      writeVarint(s, rec, g, n, {
        detail,
        lead: [f.kind === 'sint' ? 'e_zigzag' : 'e_value'],
        what: f.name,
        follow: f.name,
        roles: varintRoles(varintBytes(n).length),
        intro: `Now the value as a varint: 7 bits per byte, lowest group first, with the top bit of each byte saying whether another follows. ${n} = ${bin(n, 0)} in binary.`,
        bits: true,
      });
    }
    if (detail) unmarkRow(rec, row);
  }
  const total = flat(s).length;
  const jsonLen = sizeIn('json', s.wrote);
  sizesBench(s);
  rec.line('e_done');
  if (level === 'none') return;
  rec.step(
    `Done: ${bytesWord(total)}. The same record as JSON is ${jsonLen} bytes, ${encodeJson(s.wrote)}, because every name and digit goes as text. Here a field name costs part of one key byte and 1337 costs 2 bytes, not 4.`,
  );
}

function encodeAvroAnim(s: SerState, rec: Rec, level: Level): void {
  startMessage(s);
  const fields = wrote(s);
  fields.forEach((f, idx) => {
    const v = valueOf(s.wrote, f);
    const row = wrow(f.name);
    const detail = level === 'full';
    if (level !== 'none') markRow(rec, row, 'path');
    const g = newGroup(s, f);
    const atRow: Probe = { text: f.name, at: firstCell(s, row), place: 'left' };
    if (detail) {
      rec.line('a_field');
      rec.step(
        idx === 0
          ? `Avro writes no keys and no names, only values, in the order of the writer's schema. First ${f.name} = ${show(v, true)}, ${typeName('avro', f.kind)}.`
          : `Next in schema order: ${f.name} = ${show(v, true)}, ${typeName('avro', f.kind)}. It goes straight after the previous value, with nothing to say where one ends and the next begins except the schema.`,
        { probe: atRow },
      );
    }
    const o = (lead: string[], what: string, roles: (i: number) => string, intro?: string, bits = false): VarintOpts => ({ detail, lead, what, follow: f.name, roles, intro, bits });
    if (f.kind === 'opt') {
      if (v === null) writeVarint(s, rec, g, 0, o(['a_branch'], `${f.name} branch`, () => 'null', `${f.name} is a union of null and string, and it is null: write the branch number, 0, zigzagged, which is 0.`));
      else {
        writeVarint(s, rec, g, 2, o(['a_branch'], `${f.name} branch`, () => 'br 1', `${f.name} is a union of null and string: write branch 1, zigzagged, which is 2.`));
        const b = utf8(String(v));
        writeVarint(s, rec, g, zigzag(b.length), o(['a_len', 'z_enc'], `${f.name} length`, () => 'len', `Then the length, zigzagged: ${b.length} becomes ${zigzag(b.length)}.`));
        pushBytes(rec, g, b, chars(String(v)));
      }
    } else if (typeof v === 'string') {
      const b = utf8(v);
      writeVarint(s, rec, g, zigzag(b.length), o(['a_len', 'z_enc'], `${f.name} length`, () => 'len', `A string is its length, then its bytes. Avro zigzags every number, even a length that cannot be negative: ${b.length} becomes ${zigzag(b.length)}.`));
      const cells = pushBytes(rec, g, b, chars(v));
      if (detail) {
        for (const c of cells) rec.markCell(g.id, c, 'key');
        rec.line('a_bytes');
        rec.step(`Then the ${bytesWord(b.length)} of "${v}": ${b.map(hex).join(' ')}.`, { probe: { text: f.name, at: g.id, cell: cells[0] } });
        for (const c of cells) rec.markCell(g.id, c, 'ok');
      }
    } else if (Array.isArray(v)) {
      if (v.length) {
        writeVarint(s, rec, g, zigzag(v.length), o(['a_count', 'z_enc'], `${f.name} count`, () => 'count', `An array is written in blocks: a count, then that many items. ${v.length} items, zigzagged, is ${zigzag(v.length)}.`));
        for (const x of v) writeVarint(s, rec, g, zigzag(x), o(['a_item', 'z_enc'], `${f.name} item`, () => String(x), `Item ${x}, zigzagged, is ${zigzag(x)}.`));
      }
      writeVarint(s, rec, g, 0, o(['a_end'], `${f.name} end`, () => 'end', `A block with a count of 0 ends the array.`));
    } else {
      const n = zigzag(v ?? 0);
      if (detail) {
        s.bench = [[{ text: String(v), sub: 'value' }], [{ text: String(n), sub: 'zigzag' }]];
        rec.line('a_int', 'z_enc');
        rec.step(`Avro zigzags every int: zigzag(${v}) = ${n}. 0, −1, 1, −2 become 0, 1, 2, 3, so small negative numbers stay one byte.`, { probe: { text: f.name, at: g.id } });
      }
      writeVarint(s, rec, g, n, o(['a_int'], f.name, varintRoles(varintBytes(n).length), `Then ${n} as a varint, as protobuf does.`, true));
    }
    if (level === 'field') {
      for (let c = 0; c < g.bytes.length; c++) rec.markCell(g.id, c, 'ok');
      rec.line('a_field', ...anchorsForAvroWrite(f.kind));
      rec.step(
        (idx === 0 ? `In Avro, values go out in the writer's schema order with no keys and no names. ` : ``) +
          `${f.name} = ${show(v, true)}: ${g.bytes.map((b) => hex(b.v)).join(' ')}. ${avroExplain(f.kind, v)}`,
        { probe: { text: f.name, at: g.id, cell: g.bytes.length - 1 } },
      );
    }
    if (level !== 'none') unmarkRow(rec, row);
  });
  sizesBench(s);
  rec.line('a_done');
  if (level === 'none') return;
  rec.step(
    `Done: ${bytesWord(flat(s).length)}, against ${sizeIn('protobuf', s.wrote)} for protobuf and ${sizeIn('json', s.wrote)} for JSON. Avro is smallest because it writes no keys at all, and the price is that the bytes mean nothing without the writer's schema.`,
  );
}

function anchorsForAvroWrite(k: Kind): string[] {
  if (k === 'opt') return ['a_branch'];
  if (k === 'ints') return ['a_count', 'a_item', 'a_end'];
  if (k === 'string') return ['a_len', 'a_bytes'];
  return ['a_int', 'z_enc'];
}

function avroExplain(k: Kind, v: Value): string {
  if (k === 'opt') return v === null ? `A union writes its branch: 0 means null.` : `Branch 1 means string, then the string.`;
  if (k === 'ints') return `A count, zigzagged, the items, zigzagged, and a 0 to end.`;
  if (k === 'string') return `A length, zigzagged, then the bytes.`;
  return `zigzag(${v}) = ${zigzag(Number(v))}, then a varint.`;
}

function encodeJsonAnim(s: SerState, rec: Rec, level: Level): void {
  startMessage(s);
  const parts = jsonParts(s.wrote);
  for (const f of wrote(s)) {
    const part = parts.find((p) => p.f === f);
    const row = wrow(f.name);
    if (level === 'full') markRow(rec, row, 'path');
    if (!part) {
      if (level === 'full') {
        rec.line('j_field');
        rec.step(`${f.name} is null, so the key is left out.`, { probe: { text: f.name, at: firstCell(s, row), place: 'left' } });
        unmarkRow(rec, row);
      }
      continue;
    }
    const g = newGroup(s, f);
    g.text = part.text;
    g.bytes = utf8(part.text).map((v) => ({ v, role: '' }));
    rec.count('written', g.bytes.length);
    if (level === 'full') {
      rec.markCell(g.id, 0, 'key');
      rec.line('j_field');
      rec.step(`${f.name}: ${part.text} is ${bytesWord(g.bytes.length)}. The name goes out in full, in quotes, on every record, and ${show(valueOf(s.wrote, f), true)} goes as text.`, {
        probe: { text: f.name, at: g.id },
      });
      rec.markCell(g.id, 0, 'ok');
      unmarkRow(rec, row);
    }
  }
  sizesBench(s);
  rec.line('j_done');
  if (level === 'none') return;
  rec.step(`Done: ${bytesWord(flat(s).length)} of JSON, against ${sizeIn('protobuf', s.wrote)} for protobuf and ${sizeIn('avro', s.wrote)} for Avro. It needs no schema to read, and that is both its strength and its weakness.`);
}

function encodeAny(s: SerState, rec: Rec, level: Level): void {
  if (s.format === 'protobuf') encodeProtoAnim(s, rec, level);
  else if (s.format === 'avro') encodeAvroAnim(s, rec, level);
  else encodeJsonAnim(s, rec, level);
}

// ---- decode -----------------------------------------------------------------

/** Read a varint from the flat bytes. Past the end it stops, so a broken read cannot run away. */
function readVarintAt(bytes: { v: number }[], pos: number): { n: number; len: number } {
  let n = 0;
  let mul = 1;
  let len = 0;
  while (pos + len < bytes.length) {
    const b = bytes[pos + len].v;
    n += (b % 128) * mul;
    mul *= 128;
    len++;
    if (b < 128) break;
  }
  return { n, len };
}

function setRead(s: SerState, name: string, v: ReadValue): void {
  s.read[name] = v;
}

function protoDecodeAnim(s: SerState, rec: Rec, focus: Set<string> | 'all'): void {
  s.read = {};
  for (const g of s.groups) g.state = 'plain';
  const bytes = flat(s);
  const fields = reader(s);
  const nums = fields.map((f) => f.num).join(', ');
  let skipped = 0;
  let bad = 0;
  if (focus === 'all') {
    rec.line('d_loop');
    rec.step(`The reader has ${bytesWord(bytes.length)} and its own schema, ${SCHEMAS[s.reader].label}. It does not need the writer's schema: every field carries its own number.`);
  }
  let pos = 0;
  while (pos < bytes.length) {
    const k = readVarintAt(bytes, pos);
    const at = bytes[pos];
    const g = at.g;
    const num = Math.floor(k.n / 8);
    const wire = k.n % 8;
    const f = fields.find((x) => x.num === num);
    const known = !!f && wire === wireOf(f.kind);
    const wf = wrote(s).find((x) => x.num === num);
    const wrong = known && (!wf || wf.name !== f!.name || wf.kind !== f!.kind);
    const detail = focus === 'all' || !known || wrong || focus.has(f!.name);
    const keyCells = Array.from({ length: k.len }, (_, i) => bytes[pos + i].c);
    rec.count('read', k.len);
    if (detail) {
      for (let i = 0; i < k.len; i++) {
        const b = bytes[pos + i];
        const last = i === k.len - 1;
        rec.markCell(g.id, b.c, 'key');
        rec.line('d_key', last ? 'v_stop' : 'v_bits');
        rec.compare(`key byte ${hex(b.v)}`, last ? '<' : '≥', '80', last ? 'top bit clear: the key ends here' : 'top bit set: read on', {
          probe: { text: hex(b.v), at: g.id, cell: b.c },
          message: last ? `Read the next byte, ${hex(b.v)}. Its top bit is clear, so the key is ${k.len === 1 ? 'this one byte' : 'complete'}: ${k.n}.` : `Read ${hex(b.v)}. Its top bit is set: the key goes on.`,
        });
      }
      s.bench = [[{ text: bin(k.n, 8), sub: `key = ${k.n}` }], [{ text: bin(num, 5), sub: `field ${num}` }, { text: bin(wire, 3), sub: `wire ${wire}` }]];
      rec.line('d_split');
      for (const c of keyCells) rec.markCell(g.id, c, 'path');
      rec.step(`Split the key ${k.n} = ${bin(k.n, 8)}: the low 3 bits are the wire type, ${wire}, and the rest is the field number, ${num}.`, { probe: { text: `field ${num}`, at: g.id, cell: keyCells[0] } });
    }
    pos += k.len;
    if (!known) {
      if (detail) {
        rec.line('d_lookup', 'd_unknown');
        if (f) rec.compare(`field ${num} wire ${wire}`, '≠', `wire ${wireOf(f.kind)}`, 'wrong wire type: skip it as unknown', { probe: { text: `field ${num}`, at: g.id, cell: keyCells[0] } });
        else
          rec.compare(`field ${num}`, '≠', `fields ${nums}`, 'unknown: skip it by its wire type', {
            probe: { text: `field ${num}`, at: g.id, cell: keyCells[0] },
            message: `The reader's schema has fields ${nums}. Field ${num} is not one of them: it was added after this reader was built. It cannot know what the bytes mean, but the wire type, ${wire}, tells it how many there are.`,
          });
      }
      const start = pos;
      if (wire === 0) {
        const v = readVarintAt(bytes, pos);
        pos += v.len;
        rec.line('s_varint');
      } else if (wire === 2) {
        const len = readVarintAt(bytes, pos);
        rec.line('s_len', 'v_stop');
        if (detail) rec.markCell(g.id, bytes[pos]?.c ?? 0, 'key');
        if (detail)
          rec.compare(`length byte ${hex(bytes[pos]?.v ?? 0)}`, '<', '80', 'one byte: the length', {
            probe: { text: `field ${num}`, at: g.id, cell: bytes[pos]?.c ?? 0 },
            message: `Wire type 2 means a length comes next. Read it: ${len.n}.`,
          });
        pos += len.len + len.n;
        rec.line('s_jump');
      } else pos += wire === 1 ? 8 : wire === 5 ? 4 : bytes.length;
      pos = Math.min(pos, bytes.length);
      rec.count('read', pos - start);
      rec.count('skipped');
      skipped++;
      g.state = 'skipped';
      rec.unmark(g.id);
      if (detail)
        rec.step(
          `Jump ${bytesWord(pos - start)} ahead without looking at them. The old reader carries on with the next key. This is forward compatibility: old code reads data written by new code.`,
          { probe: { text: `field ${num}`, at: g.id, cell: keyCells[0] } },
        );
      continue;
    }
    const field = f!;
    const type = typeName('protobuf', field.kind);
    // Read the value first, as the listing does, then narrate.
    let value: Value;
    const valueStart = pos;
    const frames: (() => void)[] = [];
    if (wire === 0) {
      const v = readVarintAt(bytes, pos);
      let acc = 0;
      let mul = 1;
      for (let i = 0; i < v.len; i++) {
        const b = bytes[pos + i];
        const last = i === v.len - 1;
        acc += (b.v % 128) * mul;
        const part = (b.v % 128) * mul;
        const sofar = acc;
        const shift = i * 7;
        mul *= 128;
        frames.push(() => {
          rec.markCell(b.g.id, b.c, 'key');
          rec.line('d_varint', 'v_bits', last ? 'v_stop' : 'v_bits');
          rec.compare(`${field.name}: byte ${hex(b.v)}`, last ? '<' : '≥', '80', last ? 'last byte' : 'more bytes follow', {
            probe: { text: field.name, at: b.g.id, cell: b.c },
            message: `${hex(b.v)}: its low 7 bits are ${bin(b.v % 128, 7)}, ${shift ? `shifted left by ${shift}, which is ${part}` : `which is ${part}`}. So far ${sofar}. ${last ? 'The top bit is clear, so this is the last byte.' : 'The top bit is set, so read on.'}`,
          });
          rec.markCell(b.g.id, b.c, 'path');
        });
      }
      pos += v.len;
      value = field.kind === 'sint' ? unzigzag(v.n) : v.n;
      if (field.kind === 'sint')
        frames.push(() => {
          rec.line('d_zigzag', 'z_dec');
          rec.step(`sint32: undo the zigzag. ${v.n} becomes ${value}.`, { probe: { text: field.name, at: g.id, cell: keyCells[0] } });
        });
    } else {
      const len = readVarintAt(bytes, pos);
      const lb = bytes[pos];
      frames.push(() => {
        rec.markCell(lb.g.id, lb.c, 'key');
        rec.line('d_len', 'v_stop');
        rec.compare(`${field.name} length byte ${hex(lb.v)}`, '<', '80', 'one byte: the length', {
          probe: { text: field.name, at: lb.g.id, cell: lb.c },
          message: `Wire type 2: a length comes first. ${hex(lb.v)} has its top bit clear, so the length is ${len.n}.`,
        });
        rec.markCell(lb.g.id, lb.c, 'path');
      });
      pos += len.len;
      const end = Math.min(bytes.length, pos + len.n);
      const body = bytes.slice(pos, end);
      if (field.kind === 'ints') {
        const items: number[] = [];
        let p = 0;
        while (p < body.length) {
          const it = readVarintAt(body, p);
          const cells = body.slice(p, p + it.len);
          items.push(it.n);
          const sofar = [...items];
          frames.push(() => {
            for (const b of cells) rec.markCell(b.g.id, b.c, 'key');
            rec.line('d_unpack', 'v_stop');
            rec.compare(`${field.name}: byte ${hex(cells[cells.length - 1].v)}`, '<', '80', `item ${it.n}`, {
              probe: { text: field.name, at: cells[0].g.id, cell: cells[0].c },
              message: `Inside the ${len.n} bytes, read varints until they run out: ${cells.map((b) => hex(b.v)).join(' ')} is ${it.n}. So far ${show(sofar)}.`,
            });
            for (const b of cells) rec.markCell(b.g.id, b.c, 'path');
          });
          p += Math.max(1, it.len);
        }
        value = items;
      } else {
        value = new TextDecoder().decode(new Uint8Array(body.map((b) => b.v)));
        frames.push(() => {
          for (const b of body) rec.markCell(b.g.id, b.c, 'key');
          rec.line('d_text');
          rec.step(`The next ${bytesWord(body.length)}, ${body.map((b) => hex(b.v)).join(' ')}, are the string in UTF-8: "${value}".`, { probe: { text: field.name, at: g.id, cell: body[0]?.c ?? 0 } });
          for (const b of body) rec.markCell(b.g.id, b.c, 'path');
        });
      }
      pos = end;
    }
    rec.count('read', pos - valueStart);
    const row = rrow(field.name);
    if (detail) {
      markRow(rec, row, 'compare');
      rec.line('d_lookup');
      rec.compare(`field ${num}`, '=', `${field.name} (${num})`, `known: read it as ${type}`, {
        probe: { text: `field ${num}`, at: row, place: 'right' },
        message: `The reader's schema has field ${num}: ${field.name}, ${type}. ${wrong ? `It has no way to know that the writer meant field ${num} to be ${wf ? `${wf.name}, ${typeName('protobuf', wf.kind)}` : 'something else'}.` : `Read it as that.`}`,
      });
      unmarkRow(rec, row);
      for (const fr of frames) fr();
    }
    setRead(s, field.name, { text: show(value, field.kind === 'string' && wrong), tone: wrong ? 'bad' : 'ok' });
    g.state = wrong ? 'bad' : 'read';
    if (wrong) {
      bad++;
      rec.markCell(row, 0, 'bad');
    }
    if (detail) {
      rec.line(wire === 0 ? 'd_varint' : field.kind === 'ints' ? 'd_unpack' : 'd_text');
      rec.step(
        wrong
          ? `${field.name} = ${show(value)}, and it is wrong. The writer wrote ${wf!.name} = ${show(valueOf(s.wrote, wf!), true)}, but the bytes fit the reader's type, so no error is raised.`
          : `${field.name} = ${show(value, true)}.`,
        { probe: { text: field.name, at: row, place: 'right' } },
      );
    } else {
      markRow(rec, row, 'compare');
      rec.line('d_lookup', wire === 0 ? 'd_varint' : field.kind === 'ints' ? 'd_unpack' : 'd_text');
      rec.compare(`field ${num}`, '=', `${field.name} (${num})`, `known: ${field.name} = ${show(value)}`, {
        probe: { text: `field ${num}`, at: row, place: 'right' },
        message: `Key ${keyCells.map((c) => hex(g.bytes[c].v)).join(' ')}: field ${num}, wire type ${wire}. The reader knows field ${num} as ${field.name}, and reads ${show(value, true)}.`,
      });
      unmarkRow(rec, row);
    }
  }
  const defaults = finishDefaults(s, rec, 'd_default');
  rec.clearMarks();
  rec.line('d_done');
  rec.step(
    `Read ${bytesWord(bytes.length)}: ${Object.keys(s.read).length - defaults} fields from the bytes, ${skipped} skipped, ${defaults} from defaults.` +
      (bad ? ` No error was raised, and the value in red is wrong. Protobuf trusts the field number completely.` : ``),
  );
}

/** Reader fields that never appeared get their defaults. Returns how many. */
function finishDefaults(s: SerState, rec: Rec, anchor: string): number {
  let n = 0;
  for (const f of reader(s)) {
    if (s.read[f.name]) continue;
    const d = defaultOf(s.format, f);
    const row = rrow(f.name);
    const lost = s.format === 'json' && s.wrote === 'rename' && f.name === 'name';
    setRead(s, f.name, { text: show(d), def: f.kind !== 'opt', tone: lost ? 'bad' : undefined });
    n++;
    markRow(rec, row, 'compare');
    rec.line(anchor);
    rec.step(
      lost
        ? `No "name" key arrived, so name falls back to "". The writer renamed it to "fullName", and nothing in JSON can say that the two are the same field. Ada's name is silently gone.`
        : f.kind === 'opt'
          ? `${f.name} never appeared, so it is unset. Because the field is optional, the reader can tell "unset" from an empty string.`
          : `${f.name} never appeared, so it takes its default, ${show(d, true)}. ` +
            (s.format === 'protobuf'
              ? `In proto3 that is the zero value for the type: 0, "" or an empty list. This is backward compatibility: new code reads data written by old code.`
              : s.format === 'avro'
                ? `The default comes from the reader's schema. This is backward compatibility: new code reads data written by old code.`
                : `The default lives in the reader's code, because JSON has no schema to put it in.`),
      { probe: { text: f.name, at: row, place: 'right' } },
    );
    unmarkRow(rec, row);
  }
  return n;
}

/** Read one Avro value of a writer's type from the flat bytes. */
function avroReadValue(bytes: { v: number }[], pos: number, k: Kind): { value: Value; end: number; how: string } {
  const first = readVarintAt(bytes, pos);
  let p = pos + first.len;
  const str = (at: number, zz: number) => {
    const len = Math.max(0, unzigzag(zz));
    const end = Math.min(bytes.length, at + len);
    const value = new TextDecoder().decode(new Uint8Array(bytes.slice(at, end).map((b) => b.v)));
    return { value, end, how: `length ${zz}, unzigzagged ${len}, then the ${bytesWord(end - at)} "${show(value)}"` };
  };
  if (k === 'int' || k === 'sint') return { value: unzigzag(first.n), end: p, how: `varint ${first.n}, unzigzagged ${unzigzag(first.n)}` };
  if (k === 'string') return str(p, first.n);
  if (k === 'opt') {
    if (unzigzag(first.n) === 0) return { value: null, end: p, how: 'branch 0: null' };
    const s2 = readVarintAt(bytes, p);
    const r = str(p + s2.len, s2.n);
    return { ...r, how: `branch 1, then ${r.how}` };
  }
  const items: number[] = [];
  let count = unzigzag(first.n);
  while (count !== 0 && p < bytes.length) {
    for (let i = 0; i < Math.abs(count) && p < bytes.length; i++) {
      const it = readVarintAt(bytes, p);
      items.push(unzigzag(it.n));
      p += it.len;
    }
    const next = readVarintAt(bytes, p);
    p += next.len;
    count = unzigzag(next.n);
  }
  return { value: items, end: p, how: items.length ? `count ${items.length}, items ${items.join(', ')}, then 0` : `count 0: an empty array` };
}

function avroReadAnim(s: SerState, rec: Rec, focus: Set<string> | 'all', asWriter?: SchemaId): void {
  s.read = {};
  for (const g of s.groups) g.state = 'plain';
  const bytes = flat(s);
  const wSchema = SCHEMAS[asWriter ?? s.wrote];
  const want = reader(s);
  const actual = wrote(s);
  let pos = 0;
  let bad = 0;
  let skipped = 0;
  rec.line('r_read');
  rec.step(
    asWriter
      ? `The reader skips the writer's schema and walks the ${bytesWord(bytes.length)} with its own, ${SCHEMAS[s.reader].label}: id, name, scores, plan. The writer's were id, name, email, scores.`
      : `Avro bytes carry no numbers and no names. The reader is handed the writer's schema, ${wSchema.label}, walks it in order to find each value, and keeps a field when its own schema, ${SCHEMAS[s.reader].label}, has the same NAME.`,
  );
  for (const wf of wSchema.fields) {
    const r = avroReadValue(bytes, pos, wf.kind);
    const cells = bytes.slice(pos, Math.max(pos, r.end));
    rec.count('read', r.end - pos);
    pos = r.end;
    const mine = want.find((x) => x.name === wf.name);
    const truthField = actual.find((x) => x.name === wf.name);
    const wrong = !truthField || !same(r.value, valueOf(s.wrote, truthField));
    const detail = focus === 'all' || !mine || wrong || focus.has(wf.name);
    const probeAt: Probe = cells.length ? { text: wf.name, at: cells[0].g.id, cell: cells[0].c } : { text: wf.name, at: firstCell(s, wrow(actual[0].name)), place: 'left' };
    if (detail) {
      for (const b of cells) rec.markCell(b.g.id, b.c, 'key');
      rec.line('r_read', 'r_varint', readAnchor(wf.kind));
      rec.step(`Read ${wf.name} with the ${asWriter ? "reader's" : "writer's"} type, ${typeName('avro', wf.kind)}: ${cells.map((b) => hex(b.v)).join(' ') || 'no bytes left'}, ${r.how}.`, { probe: probeAt });
      for (const b of cells) rec.markCell(b.g.id, b.c, wrong ? 'bad' : 'path');
    }
    if (mine) {
      const row = rrow(mine.name);
      setRead(s, mine.name, { text: show(r.value, wrong && typeof r.value === 'string'), tone: wrong ? 'bad' : 'ok' });
      if (wrong) bad++;
      for (const b of cells) b.g.state = wrong ? 'bad' : 'read';
      markRow(rec, row, 'compare');
      rec.line('r_match', 'r_keep');
      rec.compare(`writer ${wf.name}`, '=', `reader ${mine.name}`, 'same name: keep it', {
        probe: { text: wf.name, at: row, place: 'right' },
        message: wrong
          ? `The reader keeps ${wf.name} = ${show(r.value, true)}, and it is wrong: those bytes were written as ${cells.length ? [...new Set(cells.map((b) => b.g.field.name))].join(' and ') : 'nothing'}. Nothing in the bytes says so.`
          : detail
            ? `The reader's schema has a field called ${wf.name} too, so it keeps ${show(r.value, true)}. Matching is by name, so the reader could list its fields in any order.`
            : `${wf.name}: ${cells.map((b) => hex(b.v)).join(' ')}, ${r.how}. The reader has a field with that name, so it keeps ${show(r.value, true)}.`,
      });
      unmarkRow(rec, row);
    } else {
      rec.count('skipped');
      skipped++;
      for (const b of cells) b.g.state = 'skipped';
      rec.line('r_match', 'r_drop');
      rec.compare(`writer ${wf.name}`, '≠', 'any reader field', 'not in the reader: drop it', {
        probe: probeAt,
        message: `The reader's schema has no field called ${wf.name}. It still had to read the value, using the writer's type, to know where the next one starts. Then it drops it.`,
      });
    }
  }
  // Reader fields the writer never wrote.
  let defaults = 0;
  for (const f of want) {
    if (s.read[f.name]) continue;
    const row = rrow(f.name);
    markRow(rec, row, 'compare');
    if (f.noDefault) {
      setRead(s, f.name, { text: 'error', tone: 'bad' });
      rec.markCell(row, 0, 'bad');
      rec.line('r_missing', 'r_error');
      rec.step(
        `${f.name} is in the reader's schema but not the writer's, and it has no default. Avro cannot make a value up, so the read fails with an error. A schema registry checking backward compatibility would have refused this schema before it shipped.`,
        { probe: { text: f.name, at: row, place: 'right' } },
      );
      rec.line('r_error');
      rec.step(`Read failed. Every record written before ${f.name} existed is now unreadable by the new code. The rule: a field you add must have a default.`);
      return;
    }
    const d = defaultOf('avro', f);
    setRead(s, f.name, { text: show(d), def: f.kind !== 'opt' });
    defaults++;
    rec.line('r_missing', 'r_default');
    rec.step(`${f.name} is in the reader's schema but the writer never wrote it. The reader's schema gives a default, ${show(d, true)}, so it is used. This is backward compatibility: new code reads data written by old code.`, {
      probe: { text: f.name, at: row, place: 'right' },
    });
    unmarkRow(rec, row);
  }
  rec.clearMarks();
  rec.line('r_done');
  const left = bytes.length - pos;
  rec.step(
    `Resolved: ${Object.keys(s.read).length - defaults} fields from the bytes, ${skipped} dropped, ${defaults} from defaults.` +
      (bad ? ` No error was raised, and the values in red are wrong.${left > 0 ? ` ${bytesWord(left)} were left over, unread.` : ``} Avro bytes are only meaningful with the writer's exact schema.` : ``),
  );
}

function readAnchor(k: Kind): string {
  if (k === 'opt') return 'r_null';
  if (k === 'ints') return 'r_block';
  if (k === 'string') return 'r_text';
  return 'r_int';
}

function jsonDecodeAnim(s: SerState, rec: Rec, focus: Set<string> | 'all'): void {
  s.read = {};
  const want = reader(s);
  let skipped = 0;
  let bad = 0;
  if (focus === 'all') {
    rec.line('j_key');
    rec.step(`The reader parses the text and looks each key up by name. There is no schema: whatever keys arrive, arrive.`);
  }
  for (const g of s.groups) {
    const f = g.field;
    const v = valueOf(s.wrote, f);
    rec.count('read', g.bytes.length);
    const mine = want.find((x) => x.name === f.name);
    if (!mine) {
      rec.count('skipped');
      skipped++;
      g.state = 'skipped';
      rec.markCell(g.id, 0, 'key');
      rec.line('j_key', 'j_skip');
      rec.compare(`"${f.name}"`, '≠', 'any reader key', 'unknown key: ignore it', {
        probe: { text: f.name, at: g.id },
        message: `The reader has no use for "${f.name}", so it ignores it. A tolerant reader like this one is what makes adding a field safe in JSON. A strict one that rejects unknown keys would fail here.`,
      });
      rec.markCell(g.id, 0, 'dim');
      continue;
    }
    const wrong = typeName('json', mine.kind) !== typeName('json', f.kind);
    g.state = wrong ? 'bad' : 'read';
    if (wrong) bad++;
    setRead(s, mine.name, { text: show(v, wrong), tone: wrong ? 'bad' : 'ok' });
    const row = rrow(mine.name);
    markRow(rec, row, 'compare');
    if (wrong) rec.markCell(row, 0, 'bad');
    const detail = focus === 'all' || wrong || focus.has(f.name);
    rec.line('j_key', 'j_keep');
    rec.compare(`"${f.name}"`, '=', `reader ${mine.name}`, 'known key: keep it', {
      probe: { text: f.name, at: row, place: 'right' },
      message: wrong
        ? `The reader keeps id = "1337", a string where its code expects a number. Nothing checks. In JavaScript "1337" + 1 is "13371", so the mistake surfaces far from here, if at all.`
        : detail
          ? `"${f.name}" is a key the reader knows, so it keeps ${show(v, true)}. It had to read ${bytesWord(g.bytes.length)} of text to get it.`
          : `"${f.name}": the reader knows it and keeps ${show(v, true)}.`,
    });
    unmarkRow(rec, row);
  }
  const defaults = finishDefaults(s, rec, 'j_default');
  rec.clearMarks();
  rec.line('j_end');
  rec.step(
    `Read ${bytesWord(flat(s).length)} of text: ${Object.keys(s.read).length - defaults} keys used, ${skipped} ignored, ${defaults} from defaults.` +
      (bad || s.wrote === 'rename' ? ` Nothing failed, and the values in red are wrong. With no schema, nobody checks the contract.` : ``),
  );
}

function decodeAny(s: SerState, rec: Rec, focus: Set<string> | 'all'): void {
  if (s.format === 'protobuf') protoDecodeAnim(s, rec, focus);
  else if (s.format === 'avro') avroReadAnim(s, rec, focus);
  else jsonDecodeAnim(s, rec, focus);
}

// ---- operations ---------------------------------------------------------------

export function encode(s: SerState, rec: Rec): void {
  encodeAny(s, rec, 'full');
}

export function decode(s: SerState, rec: Rec): void {
  decodeAny(s, rec, 'all');
}

export const EVOLVE_WORDS = ['old', 'new'] as const;
export const BREAK_WORDS: Record<Format, readonly string[]> = { protobuf: ['reuse', 'type'], avro: ['noschema', 'nodefault'], json: ['rename', 'type'] };

const firstReadAnchor = (s: SerState) => (s.format === 'protobuf' ? 'd_loop' : s.format === 'avro' ? 'r_read' : 'j_key');

/** old: an old reader meets new data. new: a new reader meets old data. */
export function evolve(s: SerState, word: string, rec: Rec): boolean {
  if (word !== 'old' && word !== 'new') {
    rec.line(firstReadAnchor(s));
    rec.step(`Type old, for an old reader meeting data from a newer writer, or new, for a new reader meeting old data.`);
    return false;
  }
  const fmt = s.format;
  if (word === 'old') {
    s.writer = 'v2';
    s.reader = 'v1';
    encodeAny(s, rec, 'none');
    rec.step(
      fmt === 'protobuf'
        ? `The writer is upgraded to v2, which adds field 5, plan = "pro". It writes ${bytesWord(flat(s).length)}, the last 5 for plan. The reader is still on v1 and has never heard of field 5.`
        : fmt === 'avro'
          ? `The writer is upgraded to v2, which adds plan = "pro" at the end. It writes ${bytesWord(flat(s).length)}. The reader is still on v1, and is handed v2 as the writer's schema.`
          : `The writer is upgraded and adds "plan":"pro". It writes ${bytesWord(flat(s).length)}. The reader's code is still the old one.`,
    );
    decodeAny(s, rec, new Set(['plan']));
  } else {
    s.writer = 'v1';
    s.reader = 'v2';
    encodeAny(s, rec, 'none');
    rec.step(
      `Now the other way round. The reader has been upgraded to v2, which knows plan, while a service still on v1 writes ${bytesWord(flat(s).length)} with no plan in them. During a rolling upgrade both happen at once.`,
    );
    decodeAny(s, rec, new Set());
  }
  return true;
}

/** The mistakes schema rules exist to prevent. */
export function breakIt(s: SerState, word: string, rec: Rec): boolean {
  const words = BREAK_WORDS[s.format];
  if (!words.includes(word)) {
    rec.line(firstReadAnchor(s));
    rec.step(`In ${s.format === 'json' ? 'JSON' : s.format === 'avro' ? 'Avro' : 'protobuf'}, type ${words[0]} or ${words[1]}.`);
    return false;
  }
  s.reader = 'v1';
  if (s.format === 'protobuf') {
    s.writer = word === 'reuse' ? 'reuse' : 'sint';
    encodeAny(s, rec, 'none');
    rec.step(
      word === 'reuse'
        ? `A careless v3 deletes scores and gives its number, 4, to a new field, string nick = "Ada". It should have reserved 4. The writer sends ${bytesWord(flat(s).length)}, and a reader still on v1 decodes them.`
        : `v3 changes id from int32 to sint32. The number and the wire type stay the same, so nothing looks wrong. But sint32 writes zigzag(1337) = 2674, and a reader on v1 decodes it.`,
    );
    protoDecodeAnim(s, rec, new Set());
  } else if (s.format === 'avro') {
    s.writer = 'v1';
    s.reader = word === 'noschema' ? 'v3' : 'nodefault';
    encodeAny(s, rec, 'none');
    rec.step(
      word === 'noschema'
        ? `A v1 writer sends ${bytesWord(flat(s).length)}. The reader, on v3, does not fetch the writer's schema and reads the bytes with its own as if it were the writer's.`
        : `A v1 writer sends ${bytesWord(flat(s).length)}. The new reader adds plan, but this time with no default.`,
    );
    avroReadAnim(s, rec, new Set(), word === 'noschema' ? 'v3' : undefined);
  } else {
    s.writer = word === 'rename' ? 'rename' : 'jtype';
    encodeAny(s, rec, 'none');
    rec.step(
      word === 'rename'
        ? `The writer's team renames name to fullName and ships. JSON has no schema to check against, so nothing stops it.`
        : `The writer starts sending id as a string, "1337". Nothing checks that either.`,
    );
    jsonDecodeAnim(s, rec, new Set());
  }
  return true;
}

/** Switch to Avro: the same record, written with v1 and resolved against a v3 reader. */
export function avro(s: SerState, rec: Rec): void {
  s.format = 'avro';
  s.writer = 'v1';
  s.reader = 'v3';
  encodeAvroAnim(s, rec, 'field');
  avroReadAnim(s, rec, 'all');
}

// ---- layout -----------------------------------------------------------------

const BYTE_W = 40;
const GROUP_GAP = 12;
const NUM_W = 40;
const NAME_W = 96;
const TYPE_W = 84;
const VALUE_W = 120;
const TABLE_GAP = 20;
const SIDE = 96;
const COL_GAP = 3;
const ROW_PITCH = CELL_H + 4;
const STRIP_Y = 0;
const STRIP_H = CELL_H + TRAY_PAD * 2;
const BENCH_Y = STRIP_Y + STRIP_H / 2 + SUB_ROOM + CAPTION_ROOM + 6 + STRIP_H / 2;
const TITLE_Y = BENCH_Y + STRIP_H / 2 + SUB_ROOM + 12;
const ROW0 = TITLE_Y + LABEL_MAX + 4 + CELL_H / 2;
const ROWS = 5;
const TOP = STRIP_Y - STRIP_H / 2 - PROBE_H - 16;
const BOTTOM = ROW0 + (ROWS - 1) * ROW_PITCH + CELL_H / 2 + SUB_ROOM;
const TABLE_W = NUM_W + NAME_W + TYPE_W + VALUE_W + 3 * COL_GAP;
const READER_X = TABLE_W + TABLE_GAP;
const RIGHT = READER_X + TABLE_W + SIDE;

/** A table row is one node per column; the value node carries the row's id. */
function tableRow(s: SerState, f: Field, value: Cell): { suffix: string; cell: Cell }[] {
  const cells: { suffix: string; cell: Cell }[] = [];
  if (s.format === 'protobuf') cells.push({ suffix: ':num', cell: { text: String(f.num), w: NUM_W } });
  cells.push({ suffix: ':name', cell: { text: f.name, w: NAME_W } }, { suffix: ':type', cell: { text: typeName(s.format, f.kind), w: TYPE_W } }, { suffix: '', cell: { ...value, w: VALUE_W } });
  return cells;
}

export function layout(s: SerState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  // The message: one tray of bytes per field written.
  let x = 0;
  s.groups.forEach((g, i) => {
    const tone: Tone | undefined = g.state === 'skipped' ? 'dim' : g.state === 'bad' ? 'bad' : undefined;
    const cells: Cell[] =
      s.format === 'json' && g.text
        ? [{ text: g.text, sub: bytesWord(g.bytes.length), tone }]
        : g.bytes.map((b) => ({ text: hex(b.v), sub: b.role, w: BYTE_W, tone }));
    const w = cellsWidth(cells);
    const hue = s.format === 'json' ? i % 6 : (g.field.num - 1) % 6;
    const v = valueOf(s.wrote, g.field);
    const caption = s.format === 'json' ? g.field.name : `${g.field.name} = ${show(v, true)}`;
    // A caption can be wider than a one-byte group: give it room so captions never touch.
    const slot = Math.max(w, labelWidth(caption));
    nodes.push({ id: g.id, x: x + slot / 2, y: STRIP_Y, cells, hue, tone, caption });
    x += slot + GROUP_GAP;
  });
  if (!s.groups.length) decor.push({ id: 'empty', type: 'label', x: 0, y: STRIP_Y - 8, text: 'No bytes: every field is unset' });

  // Scratch arithmetic for the current step.
  let bx = 0;
  s.bench.forEach((cells, i) => {
    if (!cells.length) return;
    const w = cellsWidth(cells);
    nodes.push({ id: `b${i}`, x: bx + w / 2, y: BENCH_Y, cells });
    if (i > 0 && s.bench[i - 1].length) edges.push({ id: `be${i}`, from: `b${i - 1}`, to: `b${i}`, kind: 'side', arrow: true });
    bx += w + 40;
  });

  // Writer and reader schemas, side by side.
  const tables: [string, number, Field[], (f: Field) => Cell, (name: string) => string][] = [
    [`Writer schema ${SCHEMAS[s.wrote].label}`, 0, wrote(s), (f) => ({ text: show(valueOf(s.wrote, f)) }), wrow],
    [
      `Reader schema ${SCHEMAS[s.reader].label}`,
      READER_X,
      reader(s),
      (f) => {
        const r = s.read[f.name];
        return r ? { text: r.text, tone: r.tone, sub: r.def ? 'default' : undefined, subValue: r.def } : { text: '' };
      },
      rrow,
    ],
  ];
  for (const [title, left, fields, val, id] of tables) {
    decor.push({ id: `title-${left}`, type: 'label', x: left, y: TITLE_Y, text: title, anchor: 'start', strong: true });
    fields.forEach((f, i) => {
      let cx = left;
      for (const { suffix, cell } of tableRow(s, f, val(f))) {
        nodes.push({ id: id(f.name) + suffix, x: cx + cell.w! / 2, y: ROW0 + i * ROW_PITCH, cells: [cell] });
        cx += cell.w! + COL_GAP;
      }
    });
  }

  // Pin the corners so the view does not rescale between steps.
  decor.push({ id: 'corner-a', type: 'label', x: -SIDE, y: TOP, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges, decor };
}

export const SCENE = { left: -SIDE, right: RIGHT, top: TOP, bottom: BOTTOM };

// ---- definition -----------------------------------------------------------------

export const FORMATS: Format[] = ['protobuf', 'avro', 'json'];

export function create(format: Format = 'protobuf'): SerState {
  return { format, writer: 'v1', reader: 'v1', wrote: 'v1', groups: [], read: {}, bench: [] };
}

const def: StructureDef<SerState> = {
  id: 'serialization',
  params: [{ id: 'format', label: 'Format', default: 0, options: FORMATS.map((f, i) => ({ value: i, label: f === 'json' ? 'JSON' : f === 'avro' ? 'Avro' : 'Protocol Buffers' })) }],
  create: (params) => create(FORMATS[params.format ?? 0] ?? 'protobuf'),
  seed: [['encode']],
  ops: [
    { id: 'encode', label: 'Encode', intent: 'primary', args: [], code: ['encode', 'write_varint', 'zigzag', 'encode_avro', 'write_value', 'encode_json'], run: (s, _a, rec) => encode(s, rec) },
    { id: 'decode', label: 'Decode', args: [], code: ['decode', 'read_varint', 'skip', 'zigzag', 'read_avro', 'read_value', 'read_json'], run: (s, _a, rec) => decode(s, rec) },
    {
      id: 'evolve',
      label: 'Evolve',
      args: [{ name: 'reader', label: 'Reader: old or new', kind: 'word' }],
      code: ['decode', 'skip', 'read_varint', 'read_avro', 'read_value', 'read_json', 'encode', 'encode_avro', 'encode_json'],
      run: (s, [w], rec) => void evolve(s, String(w ?? '').trim().toLowerCase(), rec),
      suggest: (s) => [s.writer === 'v2' && s.reader === 'v1' ? 'new' : 'old'],
    },
    {
      id: 'break',
      label: 'Break it',
      intent: 'danger',
      args: [{ name: 'mistake', label: 'Mistake', kind: 'word' }],
      code: ['decode', 'read_varint', 'skip', 'zigzag', 'read_avro', 'read_value', 'read_json', 'encode', 'encode_avro', 'encode_json'],
      run: (s, [w], rec) => void breakIt(s, String(w ?? '').trim().toLowerCase(), rec),
      suggest: (s) => {
        const words = BREAK_WORDS[s.format];
        return [s.writer === 'reuse' || s.reader === 'v3' || s.writer === 'rename' ? words[1] : words[0]];
      },
    },
    { id: 'avro', label: 'Avro: resolve', args: [], code: ['encode_avro', 'write_value', 'read_avro', 'read_value', 'zigzag'], run: (s, _a, rec) => avro(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'written', label: 'Bytes written' },
    { key: 'read', label: 'Bytes read' },
    { key: 'skipped', label: 'Fields skipped' },
  ],
  status: (s) => [
    { label: 'Format', value: s.format === 'json' ? 'JSON' : s.format === 'avro' ? 'Avro' : 'Protocol Buffers' },
    { label: 'Writer, reader', value: `${SCHEMAS[s.wrote].label}, ${SCHEMAS[s.reader].label}` },
    { label: 'Message', value: bytesWord(flat(s).length) },
    { label: 'Same record in JSON', value: bytesWord(sizeIn('json', s.wrote)) },
  ],
  tour: [['encode'], ['decode'], ['evolve', 'old'], ['evolve', 'new'], ['break', 'reuse'], ['avro']],
  source: { python, java },
  info,
};

export default def;
