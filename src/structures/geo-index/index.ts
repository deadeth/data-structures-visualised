import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/GeoIndex.java?raw';
import python from './code/geo_index.py?raw';
import { info } from './info';

/**
 * Geospatial indexes: a geohash over a sorted list, or a point quadtree.
 *
 * The map is 8 by 8 cells, x from 0 (west) to 7 (east) and y from 0 (south)
 * to 7 (north). Every point sits on a cell and a cell holds at most one point,
 * so a point's full 6-bit code (3 bits of x, 3 of y, interleaved) names it
 * exactly. Distances are measured between cell coordinates.
 *
 * `pts` is the page's record of where each point is. The index itself is
 * `entries` (geohash: sorted by code) or `root` (quadtree), whichever `mode`
 * says is live.
 */
export type Mode = 'geohash' | 'quadtree';

export interface Pt {
  name: string;
  x: number;
  y: number;
}

export interface QNode {
  /** 'r' for the root, then one digit per level: 0 SW, 1 NW, 2 SE, 3 NE. */
  id: string;
  x: number;
  y: number;
  size: number;
  /** Points held, leaves only. */
  pts: Pt[];
  kids: QNode[] | null;
}

export type Query =
  | { kind: 'near'; x: number; y: number; r: number }
  | { kind: 'box'; x1: number; y1: number; x2: number; y2: number };

export interface GeoState {
  mode: Mode;
  capacity: number;
  pts: Pt[];
  entries: { code: number; name: string }[];
  root: QNode;
  /** The code builder: one slot per bit, '' while unknown. */
  bits: string[];
  builder: string;
  query: Query | null;
  /** Quadtree nodes shown in the walk panel, root first. */
  path: string[];
}

export const SIZE = 8;
export const BITS = 6;
export const MAX_POINTS = 12;
export const NAMES = 'ABCDEFGHIJKL';
/** Children in code order: the x bit, then the y bit. */
export const QUAD = ['SW', 'NW', 'SE', 'NE'];
/** The query's own block first, then its eight neighbours, north row first. */
export const BLOCKS: [number, number][] = [[0, 0], [-1, 1], [0, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [0, -1], [1, -1]];

export function newNode(id: string, x: number, y: number, size: number): QNode {
  return { id, x, y, size, pts: [], kids: null };
}

export function create(mode: Mode = 'geohash', capacity = 2): GeoState {
  return { mode, capacity, pts: [], entries: [], root: newNode('r', 0, 0, SIZE), bits: Array(BITS).fill(''), builder: '', query: null, path: ['r'] };
}

// ---- pure helpers ---------------------------------------------------------

/** Halve the map, x then y, one bit each time. With fewer bits, the code of the block holding (x, y). */
export function encode(x: number, y: number, bits = BITS): number {
  let xlo = 0, xhi = SIZE, ylo = 0, yhi = SIZE, code = 0;
  for (let i = 0; i < bits; i++) {
    let bit: number;
    if (i % 2 === 0) {
      const mid = (xlo + xhi) / 2;
      bit = x >= mid ? 1 : 0;
      if (bit) xlo = mid;
      else xhi = mid;
    } else {
      const mid = (ylo + yhi) / 2;
      bit = y >= mid ? 1 : 0;
      if (bit) ylo = mid;
      else yhi = mid;
    }
    code = code * 2 + bit;
  }
  return code;
}

export const bitStr = (code: number, bits = BITS) => (bits ? code.toString(2).padStart(bits, '0') : '');
export const d2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;
/** Squared distance from a cell to the nearest cell of a node's box. */
export function gap2(n: QNode, qx: number, qy: number): number {
  const dx = Math.max(n.x - qx, 0, qx - (n.x + n.size - 1));
  const dy = Math.max(n.y - qy, 0, qy - (n.y + n.size - 1));
  return dx * dx + dy * dy;
}
export function quadrant(n: QNode, x: number, y: number): number {
  const half = n.size / 2;
  return 2 * (x >= n.x + half ? 1 : 0) + (y >= n.y + half ? 1 : 0);
}
export function overlaps(n: QNode, x1: number, y1: number, x2: number, y2: number): boolean {
  return n.x <= x2 && x1 <= n.x + n.size - 1 && n.y <= y2 && y1 <= n.y + n.size - 1;
}
/** Smallest power of two at least r, and the prefix length whose blocks are that wide. */
export function blockFor(r: number): { side: number; bits: number } {
  let side = 1, bits = BITS;
  while (side < r) {
    side *= 2;
    bits -= 2;
  }
  return { side, bits };
}

export function findNode(s: GeoState, id: string): QNode {
  let n = s.root;
  for (const d of id.slice(1)) n = n.kids![Number(d)];
  return n;
}
const ancestry = (id: string) => Array.from({ length: id.length }, (_, i) => id.slice(0, i + 1));
export const nodeName = (id: string) => (id === 'r' ? 'root' : [...id.slice(1)].map((d) => QUAD[Number(d)]).join('·'));
const dims = (n: QNode) => `${n.size}×${n.size}`;
export function leaves(n: QNode, out: QNode[] = []): QNode[] {
  if (!n.kids) out.push(n);
  else for (const k of n.kids) leaves(k, out);
  return out;
}
export function depth(n: QNode): number {
  return n.kids ? 1 + Math.max(...n.kids.map(depth)) : 0;
}
const count = (n: QNode): number => (n.kids ? n.kids.reduce((a, k) => a + count(k), 0) : n.pts.length);
const at = (s: GeoState, x: number, y: number) => s.pts.find((p) => p.x === x && p.y === y);
const byName = (s: GeoState, name: string) => s.pts.find((p) => p.name === name);
const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sq = (r: number) => r * r;
const fmtD = (v: number) => (Number.isInteger(Math.sqrt(v)) ? String(Math.sqrt(v)) : `√${v} ≈ ${Math.sqrt(v).toFixed(1)}`);

// ---- ids and marks --------------------------------------------------------

const cid = (x: number, y: number) => `c${x}${y}`;
const eid = (name: string) => `e-${name}`;
const tid = (nodeId: string) => `t-${nodeId}`;
const BUILDER = 'code';

function tint(rec: Rec, x0: number, y0: number, w: number, h: number, tone: Tone): void {
  for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) rec.mark(cid(x, y), tone);
}
function clearMap(rec: Rec): void {
  for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) rec.unmark(cid(x, y));
}
const onCell = (text: string, x: number, y: number): Probe => ({ text, at: cid(x, y) });
/** A code as the listing's int would print in binary, for the Variables strip. */
const bin = (code: number, bits = BITS) => `0b${bitStr(code, bits) || '0'}`;
const names = (ns: QNode[]) => ns.map((n) => nodeName(n.id));

// ---- geohash --------------------------------------------------------------

/** Build p's code bit by bit, dimming the half it is not in each time. */
function encodeShown(s: GeoState, p: Pt, rec: Rec, lead: string[]): number {
  s.builder = `${p.name}: code`;
  s.bits = Array(BITS).fill('');
  let xlo = 0, xhi = SIZE, ylo = 0, yhi = SIZE, code = 0;
  const probe = onCell(p.name, p.x, p.y);
  for (let i = 0; i < BITS; i++) {
    const isX = i % 2 === 0;
    const lo = isX ? xlo : ylo;
    const hi = isX ? xhi : yhi;
    const mid = (lo + hi) / 2;
    const v = isX ? p.x : p.y;
    const bit = v >= mid ? 1 : 0;
    // Light the half it is in: what is left of the map after this bit.
    clearMap(rec);
    if (isX) tint(rec, bit ? mid : xlo, ylo, (bit ? xhi : mid) - (bit ? mid : xlo), yhi - ylo, 'path');
    else tint(rec, xlo, bit ? mid : ylo, xhi - xlo, (bit ? yhi : mid) - (bit ? mid : ylo), 'path');
    rec.mark(cid(p.x, p.y), 'key');
    code = code * 2 + bit;
    s.bits[i] = String(bit);
    rec.markCell(BUILDER, i, 'compare');
    rec.vars({ x: p.x, y: p.y, i, mid, bit, code: bin(code, i + 1) });
    const side = isX ? (bit ? 'right' : 'left') : bit ? 'top' : 'bottom';
    rec.line(...lead, 'encode', isX ? 'test_x' : 'test_y', 'append');
    rec.compare(`${p.name}: ${isX ? 'x' : 'y'} ${v}`, bit ? '≥' : '<', `mid ${mid}`, `${side} half, append ${bit}`, {
      probe,
      message:
        `Is ${p.name} in the ${isX ? 'left or right' : 'bottom or top'} half of ${isX ? 'x' : 'y'} ${lo} to ${hi - 1}? ` +
        `${isX ? 'x' : 'y'} = ${v} and the halves meet at ${mid}, so the ${side} half, lit blue: append ${bit}. Code so far: ${bitStr(code, i + 1)}.` +
        (i === 0 ? ` Bits alternate x, y, x, y: that interleaving is what turns two numbers into one.` : ``),
    });
    rec.markCell(BUILDER, i, 'idle');
    if (isX) {
      if (bit) xlo = mid;
      else xhi = mid;
    } else if (bit) ylo = mid;
    else yhi = mid;
  }
  return code;
}

/** Index of the first entry whose code is at least `code`. */
function seek(s: GeoState, code: number): number {
  let lo = 0, hi = s.entries.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (s.entries[m].code < code) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function geoInsert(s: GeoState, p: Pt, rec: Rec, lead: string[] = []): void {
  rec.vars({ name: p.name, x: p.x, y: p.y });
  if (!lead.length) {
    rec.line('start');
    rec.mark(cid(p.x, p.y), 'key');
    rec.step(
      `${p.name} arrives at (${p.x}, ${p.y}). A sorted list can only order one number, so turn the two coordinates into one code: halve the map, x then y, three times each.`,
      { probe: onCell(p.name, p.x, p.y) },
    );
  }
  const code = encodeShown(s, p, rec, lead);
  const i = seek(s, code);
  s.entries.splice(i, 0, { code, name: p.name });
  rec.mark(eid(p.name), 'key');
  rec.vars({ name: p.name, x: p.x, y: p.y, code: bin(code), i });
  const before = s.entries[i - 1];
  const after = s.entries[i + 1];
  const where = before && after ? `between ${before.name} and ${after.name}` : before ? `at the end, after ${before.name}` : after ? `at the front, before ${after.name}` : `as the only entry`;
  rec.line(...lead, 'slot');
  rec.step(
    `Only ${p.name}'s cell is left: 6 bits pick 1 cell of 64. A binary search finds where ${bitStr(code)} belongs in the sorted list, and it goes in ${where}.`,
    { probe: onCell(p.name, p.x, p.y) },
  );
  clearMap(rec);
  rec.mark(cid(p.x, p.y), 'ok');
  rec.mark(eid(p.name), 'ok');
  // The list neighbour that shares the longest prefix.
  let best: { name: string; k: number } | null = null;
  for (const nb of [before, after]) {
    if (!nb) continue;
    let k = 0;
    while (k < BITS && bitStr(nb.code)[k] === bitStr(code)[k]) k++;
    if (!best || k > best.k) best = { name: nb.name, k };
  }
  let tail = '';
  if (best && best.k >= 2) {
    const block = best.k % 2 === 0 ? `${SIZE >> (best.k / 2)}×${SIZE >> (best.k / 2)} block` : 'block';
    tail = ` Its list neighbour ${best.name} shares the first ${best.k} bits, so the two sit in the same ${block} of the map: close in the list, close on the map.`;
  } else if (best) {
    tail = ` Its list neighbour ${best.name} shares ${best.k === 0 ? 'no bits' : 'only the first bit'}, so the two are in different halves of the map. Next to each other in the list is not always next to each other on the map.`;
  }
  rec.line(...lead, 'inserted');
  rec.step(`${p.name} is stored under ${bitStr(code)}: 6 comparisons to build the code and one binary search to place it.${tail}`, {
    probe: onCell(p.name, p.x, p.y),
  });
}

function geoNear(s: GeoState, q: { x: number; y: number; r: number }, rec: Rec): string[] {
  const { side, bits } = blockFor(q.r);
  const bx = q.x - (q.x % side);
  const by = q.y - (q.y % side);
  const probe = onCell('Q', q.x, q.y);
  const keyQ = () => {
    if (!at(s, q.x, q.y)) rec.mark(cid(q.x, q.y), 'key');
  };
  keyQ();
  rec.vars({ qx: q.x, qy: q.y, r: q.r, side, bits, 'bx, by': `${bx}, ${by}` });
  rec.line('side');
  rec.step(
    `Find every point within ${q.r} of Q at (${q.x}, ${q.y}). First pick a block at least ${q.r} wide: ${side}×${side} cells, which is a ${plural(bits, 'bit')} prefix. ` +
      `Every point within ${q.r} of Q is then in Q's block or one of the 8 around it.`,
    { probe },
  );
  const found: string[] = [];
  const offMap = BLOCKS.filter(([dx, dy]) => {
    const cx = bx + dx * side, cy = by + dy * side;
    return cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE;
  }).length;
  let ranges = 0;
  let reads = 0;
  for (let b = 0; b < BLOCKS.length; b++) {
    const [dx, dy] = BLOCKS[b];
    const cx = bx + dx * side, cy = by + dy * side;
    if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) continue;
    const prefix = encode(cx, cy, bits);
    const lo = prefix * 2 ** (BITS - bits);
    const hi = lo + 2 ** (BITS - bits);
    s.builder = b === 0 ? `Q's block prefix` : `neighbour prefix`;
    s.bits = Array.from({ length: BITS }, (_, i) => (i < bits ? bitStr(prefix, bits)[i] : '*'));
    tint(rec, cx, cy, side, side, 'path');
    keyQ();
    let i = seek(s, lo);
    const inRange: string[] = [];
    for (let j = i; j < s.entries.length && s.entries[j].code < hi; j++) inRange.push(s.entries[j].name);
    ranges++;
    rec.count('ranges');
    for (const n of inRange) rec.mark(eid(n), 'path');
    const span = `${bitStr(lo)} to ${bitStr(hi - 1)}`;
    rec.vars({ 'cx, cy': `${cx}, ${cy}`, bits, lo: bin(lo), hi: bin(hi), i });
    rec.line('block', 'prefix', 'seek');
    rec.step(
      (b === 0
        ? `Q's own block, prefix ${bitStr(prefix, bits)}: every code from ${span}. They sit side by side in the sorted list, so one binary search and a short scan read them all. `
        : `Neighbour block at (${cx}, ${cy}), prefix ${bitStr(prefix, bits)}: codes ${span}. A separate range of the list, so a separate seek. `) +
        (inRange.length ? `${plural(inRange.length, 'entry', 'entries')} in range: ${list(inRange)}.` : `No entries in range.`),
      { probe },
    );
    for (; i < s.entries.length && s.entries[i].code < hi; i++) {
      const e = s.entries[i];
      const p = byName(s, e.name)!;
      rec.count('reads');
      reads++;
      const dist = d2(p.x, p.y, q.x, q.y);
      const ok = dist <= sq(q.r);
      rec.mark(eid(e.name), 'compare');
      rec.mark(cid(p.x, p.y), 'compare');
      rec.vars({ i, name: e.name, x: p.x, y: p.y, found: ok ? [...found, e.name] : [...found] });
      rec.line('scan', 'dist');
      rec.compare(`${e.name}: d² = ${dist}`, ok ? '≤' : '>', `r² = ${sq(q.r)}`, ok ? `within ${q.r}, keep ${e.name}` : `too far, drop ${e.name}`, {
        probe,
        message: ok
          ? `${e.name} at (${p.x}, ${p.y}) is ${fmtD(dist)} from Q, within ${q.r}. Keep it. Squared distances avoid a square root: ${dist} ≤ ${sq(q.r)}.`
          : `${e.name} at (${p.x}, ${p.y}) is ${fmtD(dist)} from Q, more than ${q.r}. The block is square and the search is a circle, so its corners hold points that are too far. Drop it.`,
      });
      rec.mark(eid(e.name), ok ? 'ok' : 'bad');
      rec.mark(cid(p.x, p.y), ok ? 'ok' : 'bad');
      if (ok) found.push(e.name);
    }
    if (b === 0) {
      // The boundary problem: what stopping here would miss.
      rec.vars({ 'cx, cy': `${cx}, ${cy}`, found: [...found] });
      const missed = s.pts.filter((p) => d2(p.x, p.y, q.x, q.y) <= sq(q.r) && !(p.x >= bx && p.x < bx + side && p.y >= by && p.y < by + side));
      rec.line('block');
      rec.step(
        missed.length
          ? `Stopping here would return ${found.length ? list(found) : 'nothing'}. But ${list(missed.map((p) => `${p.name} at (${p.x}, ${p.y})`))} ${missed.length === 1 ? 'is' : 'are'} within ${q.r} of Q, across a block edge, with a code far away in the list. That is the boundary problem. Scan the 8 neighbours too${offMap ? ` (${offMap} are off the map)` : ''}.`
          : `Q's block is done${found.length ? `: ${list(found)}` : ', with nothing in range'}. A point just across the block edge can be closer than anything inside it, so the 8 neighbours must be scanned too${offMap ? ` (${offMap} are off the map)` : ''}.`,
        { probe },
      );
    }
  }
  s.builder = '';
  s.bits = Array(BITS).fill('');
  rec.vars({ qx: q.x, qy: q.y, r: q.r, found });
  rec.line('done');
  rec.step(
    `${found.length ? `Found ${list(found)}` : 'Nothing found'} within ${q.r} of Q. Cost: ${plural(ranges, 'range scan')}, one seek each, and ${plural(reads, 'entry', 'entries')} read. A real geohash index does the same 9 range reads, in Redis or any ordered key-value store.`,
    { probe },
  );
  return found;
}

function geoBox(s: GeoState, x1: number, y1: number, x2: number, y2: number, rec: Rec): string[] {
  const lo = encode(x1, y1);
  const hi = encode(x2, y2);
  const probe = onCell('Q', x1, y1);
  s.builder = 'lo';
  s.bits = bitStr(lo).split('');
  rec.vars({ x1, y1, x2, y2, lo: bin(lo), hi: bin(hi) });
  rec.line('b_corners');
  rec.step(
    `Box from (${x1}, ${y1}) to (${x2}, ${y2}). A code only grows when x or y grows, so every point in the box has a code between lo = code(${x1}, ${y1}) = ${bitStr(lo)} and hi = code(${x2}, ${y2}) = ${bitStr(hi)}. One range scan covers the box.`,
    { probe },
  );
  let i = seek(s, lo);
  const inRange: string[] = [];
  for (let j = i; j < s.entries.length && s.entries[j].code <= hi; j++) inRange.push(s.entries[j].name);
  for (const n of inRange) rec.mark(eid(n), 'path');
  rec.count('ranges');
  rec.vars({ x1, y1, x2, y2, lo: bin(lo), hi: bin(hi), i });
  rec.line('b_seek');
  rec.step(
    `Seek to ${bitStr(lo)} and read up to ${bitStr(hi)}: ${plural(inRange.length, 'entry', 'entries')}${inRange.length ? ` (${list(inRange)})` : ''}. Each must still be checked, because the code range is wider than the box.`,
    { probe },
  );
  const found: string[] = [];
  let wasted = 0;
  for (; i < s.entries.length && s.entries[i].code <= hi; i++) {
    const e = s.entries[i];
    const p = byName(s, e.name)!;
    rec.count('reads');
    rec.count('comparisons', 4);
    const inside = p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
    rec.mark(eid(e.name), inside ? 'ok' : 'bad');
    rec.mark(cid(p.x, p.y), inside ? 'ok' : 'bad');
    rec.vars({ hi: bin(hi), i, name: e.name, x: p.x, y: p.y, found: inside ? [...found, e.name] : [...found] });
    rec.line('b_scan', 'b_inside');
    if (inside) {
      found.push(e.name);
      rec.step(`${e.name} at (${p.x}, ${p.y}): ${x1} ≤ ${p.x} ≤ ${x2} and ${y1} ≤ ${p.y} ≤ ${y2}. Inside the box: keep it.`, { probe });
    } else {
      wasted++;
      rec.step(
        `${e.name} at (${p.x}, ${p.y}) has a code in range but lies outside the box. The Z-shaped curve that orders the codes left the box and came back. Skip it.`,
        { probe },
      );
    }
  }
  s.builder = '';
  s.bits = Array(BITS).fill('');
  rec.vars({ x1, y1, x2, y2, found });
  rec.line('b_done');
  rec.step(
    `${found.length ? `Found ${list(found)}` : 'Nothing found'} in the box. Read ${plural(inRange.length, 'entry', 'entries')}, ${wasted} of them wasted on the detour. Real systems split the box into a few smaller ranges to cut that waste.`,
    { probe },
  );
  return found;
}

// ---- quadtree -------------------------------------------------------------

function showPath(s: GeoState, id: string): void {
  s.path = ancestry(id);
}

/** Walk down to the leaf for (x, y), showing the two tests at each level. */
function descend(s: GeoState, p: Pt, rec: Rec, lead: string[], anchor: string): QNode {
  let node = s.root;
  const probe = onCell(p.name, p.x, p.y);
  while (node.kids) {
    showPath(s, node.id);
    clearMap(rec);
    tint(rec, node.x, node.y, node.size, node.size, 'path');
    rec.mark(cid(p.x, p.y), 'key');
    const half = node.size / 2;
    const east = p.x >= node.x + half;
    const north = p.y >= node.y + half;
    const q = 2 * (east ? 1 : 0) + (north ? 1 : 0);
    rec.vars({ x: p.x, y: p.y, node: nodeName(node.id), half, east: east ? 1 : 0 });
    rec.line(...lead, anchor, 'q_test_x');
    rec.compare(`${p.name}: x ${p.x}`, east ? '≥' : '<', `mid ${node.x + half}`, east ? 'east half' : 'west half', {
      probe,
      message: `At ${nodeName(node.id)} (${dims(node)}). Is ${p.name} in the west or east half? x = ${p.x}, the halves meet at ${node.x + half}: ${east ? 'east' : 'west'}.`,
    });
    rec.markCell(tid(node.id), q, 'path');
    rec.vars({ x: p.x, y: p.y, node: nodeName(node.id), half, east: east ? 1 : 0, north: north ? 1 : 0 });
    rec.line(...lead, anchor, 'q_test_y');
    rec.compare(`${p.name}: y ${p.y}`, north ? '≥' : '<', `mid ${node.y + half}`, `go ${QUAD[q]}`, {
      probe,
      message: `South or north? y = ${p.y}, the halves meet at ${node.y + half}: ${north ? 'north' : 'south'}. So go down to the ${QUAD[q]} child. These are the same two tests as one level of a geohash.`,
    });
    node = node.kids[q];
  }
  showPath(s, node.id);
  clearMap(rec);
  tint(rec, node.x, node.y, node.size, node.size, 'path');
  rec.mark(cid(p.x, p.y), 'key');
  return node;
}

function split(s: GeoState, node: QNode, p: Pt, rec: Rec, lead: string[]): void {
  const half = node.size / 2;
  node.kids = [0, 1].flatMap((e) => [0, 1].map((n) => newNode(node.id + (2 * e + n), node.x + half * e, node.y + half * n, half)));
  const moving = node.pts;
  node.pts = [];
  rec.count('splits');
  showPath(s, node.id);
  rec.vars({ node: nodeName(node.id), half });
  rec.line(...lead, 'q_split_call', 'q_kids');
  rec.step(`Split ${nodeName(node.id)}: four ${half}×${half} children, one per quadrant. Then hand each of its ${moving.length} points down to the child it falls in.`, {
    probe: onCell(p.name, p.x, p.y),
  });
  for (const m of moving) {
    const q = quadrant(node, m.x, m.y);
    node.kids[q].pts.push(m);
    rec.count('comparisons', 2);
    rec.markCell(tid(node.id), q, 'ok');
    rec.vars({ node: nodeName(node.id), half, name: m.name, x: m.x, y: m.y, 'node.quadrant(x, y)': q });
    rec.line(...lead, 'q_hand');
    rec.step(
      `${m.name} at (${m.x}, ${m.y}): x ${m.x} ${m.x >= node.x + half ? '≥' : '<'} ${node.x + half} and y ${m.y} ${m.y >= node.y + half ? '≥' : '<'} ${node.y + half}, so it goes to ${QUAD[q]}.`,
      { probe: onCell(p.name, p.x, p.y) },
    );
    rec.markCell(tid(node.id), q, 'idle');
  }
  const over = node.kids.filter((k) => k.pts.length > s.capacity);
  rec.count('comparisons', 4);
  if (!over.length) {
    rec.vars({ node: nodeName(node.id), 'self.capacity': s.capacity });
    rec.line(...lead, 'q_again');
    rec.step(`No child holds more than ${s.capacity}, so the split stops here.`, { probe: onCell(p.name, p.x, p.y) });
    return;
  }
  for (const k of over) {
    showPath(s, k.id);
    clearMap(rec);
    tint(rec, k.x, k.y, k.size, k.size, 'compare');
    rec.mark(cid(p.x, p.y), 'key');
    rec.vars({ node: nodeName(node.id), kid: nodeName(k.id), 'len(kid.points)': k.pts.length, 'self.capacity': s.capacity });
    rec.line(...lead, 'q_again');
    rec.step(
      `${nodeName(k.id)} got all ${k.pts.length} points (${list(k.pts.map((m) => m.name))}), still more than ${s.capacity}. Crowded areas split again and again; empty ones stay as one big leaf.`,
      { probe: onCell(p.name, p.x, p.y) },
    );
    split(s, k, p, rec, lead);
  }
}

function leafOf(s: GeoState, x: number, y: number): QNode {
  let n = s.root;
  while (n.kids) n = n.kids[quadrant(n, x, y)];
  return n;
}

function qtInsert(s: GeoState, p: Pt, rec: Rec, lead: string[] = []): void {
  rec.vars({ name: p.name, x: p.x, y: p.y, node: 'root' });
  if (!lead.length) {
    rec.line('q_start');
    rec.mark(cid(p.x, p.y), 'key');
    rec.step(`${p.name} arrives at (${p.x}, ${p.y}). Walk down from the root, choosing one of four children at each level, until reaching a leaf.`, {
      probe: onCell(p.name, p.x, p.y),
    });
  }
  const leaf = descend(s, p, rec, lead, 'q_descend');
  leaf.pts.push({ ...p });
  rec.markCell(tid(leaf.id), leaf.pts.length - 1, 'key');
  rec.vars({ name: p.name, x: p.x, y: p.y, node: nodeName(leaf.id), 'node.points': leaf.pts.map((m) => m.name), 'self.capacity': s.capacity });
  rec.line(...lead, 'q_add');
  rec.step(`${nodeName(leaf.id)} is a leaf (${dims(leaf)}). Add ${p.name}: it now holds ${list(leaf.pts.map((m) => m.name))}.`, { probe: onCell(p.name, p.x, p.y) });
  const full = leaf.pts.length > s.capacity;
  rec.line(...lead, 'q_full');
  rec.compare(`${nodeName(leaf.id)}: ${plural(leaf.pts.length, 'point')}`, full ? '>' : '≤', `capacity ${s.capacity}`, full ? 'too full, split' : 'fits, no split', {
    probe: onCell(p.name, p.x, p.y),
  });
  rec.markCell(tid(leaf.id), leaf.pts.length - 1, 'idle');
  if (full) split(s, leaf, p, rec, lead);
  const home = leafOf(s, p.x, p.y);
  showPath(s, home.id);
  clearMap(rec);
  rec.mark(cid(p.x, p.y), 'ok');
  rec.vars({ name: p.name, x: p.x, y: p.y, node: nodeName(home.id) });
  rec.line(...lead, 'q_inserted');
  rec.step(
    `${p.name} is stored in leaf ${nodeName(home.id)} at depth ${home.id.length - 1}. ` +
      (full ? `The tree is now ${depth(s.root)} levels deep where the points are dense, and stays shallow where they are sparse.` : `Cost: two comparisons per level on the way down.`),
    { probe: onCell(p.name, p.x, p.y) },
  );
}

/** Depth first, keeping only children whose box comes within r of Q. */
function qtNear(s: GeoState, q: { x: number; y: number; r: number }, rec: Rec): string[] {
  const probe = onCell('Q', q.x, q.y);
  const keyQ = () => {
    if (!at(s, q.x, q.y)) rec.mark(cid(q.x, q.y), 'key');
  };
  keyQ();
  rec.vars({ qx: q.x, qy: q.y, r: q.r, found: [], stack: ['root'] });
  rec.line('q_begin');
  rec.step(`Find every point within ${q.r} of Q at (${q.x}, ${q.y}). Start at the root. At each node, skip any child whose box is further than ${q.r} from Q: nothing inside it can be close enough.`, { probe });
  const found: string[] = [];
  const stack: QNode[] = [s.root];
  let pruned = 0;
  while (stack.length) {
    const node = stack.pop()!;
    rec.count('reads');
    showPath(s, node.id);
    tint(rec, node.x, node.y, node.size, node.size, 'path');
    keyQ();
    if (!node.kids) {
      rec.vars({ node: nodeName(node.id), 'node.points': node.pts.map((m) => m.name), found: [...found], stack: names(stack) });
      rec.line('q_pop', 'q_leaf');
      rec.step(`Leaf ${nodeName(node.id)} (${dims(node)}) holds ${node.pts.length ? `${list(node.pts.map((m) => m.name))}. Check each against Q.` : 'nothing.'}`, { probe });
      node.pts.forEach((m, i) => {
        const dist = d2(m.x, m.y, q.x, q.y);
        const ok = dist <= sq(q.r);
        rec.mark(cid(m.x, m.y), 'compare');
        rec.markCell(tid(node.id), i, 'compare');
        rec.vars({ node: nodeName(node.id), name: m.name, x: m.x, y: m.y, found: ok ? [...found, m.name] : [...found] });
        rec.line('q_leaf', 'q_dist');
        rec.compare(`${m.name}: d² = ${dist}`, ok ? '≤' : '>', `r² = ${sq(q.r)}`, ok ? `within ${q.r}, keep ${m.name}` : `too far, drop ${m.name}`, {
          probe,
          message: `${m.name} at (${m.x}, ${m.y}) is ${fmtD(dist)} from Q: ${ok ? `within ${q.r}, keep it` : `more than ${q.r}, drop it`}.`,
        });
        rec.mark(cid(m.x, m.y), ok ? 'ok' : 'bad');
        rec.markCell(tid(node.id), i, ok ? 'ok' : 'bad');
        if (ok) found.push(m.name);
      });
      continue;
    }
    rec.vars({ node: nodeName(node.id), found: [...found], stack: names(stack) });
    rec.line('q_pop');
    rec.step(`Visit ${nodeName(node.id)} (${dims(node)}). It is split, so test its four children's boxes against the circle around Q.`, { probe });
    node.kids.forEach((k, i) => {
      const g = gap2(k, q.x, q.y);
      const keep = g <= sq(q.r);
      rec.markCell(tid(node.id), i, 'compare');
      rec.vars({ node: nodeName(node.id), kid: nodeName(k.id), 'kid.gap2(qx, qy)': g, found: [...found], stack: names(keep ? [...stack, k] : stack) });
      rec.line('q_prune');
      rec.compare(`${QUAD[i]} box: gap² = ${g}`, keep ? '≤' : '>', `r² = ${sq(q.r)}`, keep ? `visit ${QUAD[i]}` : `prune ${QUAD[i]}`, {
        probe,
        message: keep
          ? `The ${QUAD[i]} box ${g === 0 ? 'contains Q' : `comes within ${fmtD(g)} of Q`}, so it may hold a match. Keep it to visit.`
          : `The nearest cell of the ${QUAD[i]} box is ${fmtD(g)} from Q, more than ${q.r}. Prune it: none of its ${plural(count(k), 'point')} is read.`,
      });
      if (keep) {
        stack.push(k);
        rec.markCell(tid(node.id), i, 'path');
      } else {
        pruned++;
        rec.count('pruned');
        rec.markCell(tid(node.id), i, 'dim');
        tint(rec, k.x, k.y, k.size, k.size, 'dim');
        keyQ();
      }
    });
  }
  rec.vars({ qx: q.x, qy: q.y, r: q.r, found });
  rec.line('q_done');
  rec.step(
    `${found.length ? `Found ${list(found)}` : 'Nothing found'} within ${q.r} of Q. ${plural(pruned, 'box was', 'boxes were')} pruned without reading what is inside. No boundary problem: a child is pruned only when no part of it is close enough.`,
    { probe },
  );
  return found;
}

function qtBox(s: GeoState, x1: number, y1: number, x2: number, y2: number, rec: Rec): string[] {
  const probe = onCell('Q', x1, y1);
  rec.vars({ x1, y1, x2, y2, found: [], stack: ['root'] });
  rec.line('q_box_begin');
  rec.step(`Find every point in the box from (${x1}, ${y1}) to (${x2}, ${y2}). Start at the root and visit only children whose box overlaps the query box.`, { probe });
  const found: string[] = [];
  const stack: QNode[] = [s.root];
  let pruned = 0;
  while (stack.length) {
    const node = stack.pop()!;
    rec.count('reads');
    showPath(s, node.id);
    tint(rec, node.x, node.y, node.size, node.size, 'path');
    if (!node.kids) {
      rec.vars({ node: nodeName(node.id), 'node.points': node.pts.map((m) => m.name), found: [...found], stack: names(stack) });
      rec.line('q_box_pop', 'q_box_leaf');
      rec.step(`Leaf ${nodeName(node.id)} (${dims(node)}) holds ${node.pts.length ? list(node.pts.map((m) => m.name)) : 'nothing'}.`, { probe });
      node.pts.forEach((m, i) => {
        const inside = m.x >= x1 && m.x <= x2 && m.y >= y1 && m.y <= y2;
        rec.count('comparisons', 4);
        rec.mark(cid(m.x, m.y), inside ? 'ok' : 'bad');
        rec.markCell(tid(node.id), i, inside ? 'ok' : 'bad');
        rec.vars({ node: nodeName(node.id), name: m.name, x: m.x, y: m.y, found: inside ? [...found, m.name] : [...found] });
        rec.line('q_box_leaf', 'q_inside');
        rec.step(`${m.name} at (${m.x}, ${m.y}) is ${inside ? 'inside the box: keep it' : 'outside the box: skip it'}.`, { probe });
        if (inside) found.push(m.name);
      });
      continue;
    }
    rec.vars({ node: nodeName(node.id), found: [...found], stack: names(stack) });
    rec.line('q_box_pop');
    rec.step(`Visit ${nodeName(node.id)} (${dims(node)}). Test each child's box against the query box.`, { probe });
    node.kids.forEach((k, i) => {
      const hit = overlaps(k, x1, y1, x2, y2);
      rec.count('comparisons', 4);
      if (hit) {
        stack.push(k);
        rec.markCell(tid(node.id), i, 'path');
      } else {
        pruned++;
        rec.count('pruned');
        rec.markCell(tid(node.id), i, 'dim');
        tint(rec, k.x, k.y, k.size, k.size, 'dim');
      }
    });
    rec.vars({ node: nodeName(node.id), found: [...found], stack: names(stack) });
    rec.line('q_overlap');
    const kept = node.kids.map((k, i) => (overlaps(k, x1, y1, x2, y2) ? QUAD[i] : null)).filter(Boolean) as string[];
    rec.step(`${kept.length ? `${list(kept)} overlap${kept.length === 1 ? 's' : ''} the box` : 'No child overlaps the box'}; ${4 - kept.length ? `the other ${4 - kept.length} ${4 - kept.length === 1 ? 'is' : 'are'} pruned` : 'nothing is pruned'}.`, { probe });
  }
  rec.vars({ x1, y1, x2, y2, found });
  rec.line('q_box_done');
  rec.step(`${found.length ? `Found ${list(found)}` : 'Nothing found'} in the box. ${plural(pruned, 'box was', 'boxes were')} pruned. Unlike one Z-order range, the tree never reads a point outside a box it kept for nothing: only the leaves that overlap are read.`, { probe });
  return found;
}

/** Remove p from the quadtree, folding four leaves back into one when they fit. */
function qtRemove(s: GeoState, p: Pt, rec: Rec): void {
  const path: QNode[] = [s.root];
  while (path[path.length - 1].kids) {
    const n = path[path.length - 1];
    path.push(n.kids![quadrant(n, p.x, p.y)]);
    rec.count('comparisons', 2);
  }
  const leaf = path[path.length - 1];
  showPath(s, leaf.id);
  clearMap(rec);
  rec.mark(cid(p.x, p.y), 'bad');
  rec.markCell(tid(leaf.id), leaf.pts.findIndex((m) => m.name === p.name), 'bad');
  rec.vars({ name: p.name, x: p.x, y: p.y, path: names(path), 'path[-1].points': leaf.pts.filter((m) => m.name !== p.name).map((m) => m.name) });
  rec.line('q_unlink', 'q_walk', 'q_drop');
  rec.step(`${p.name} leaves (${p.x}, ${p.y}). Walk down to its leaf, ${nodeName(leaf.id)}, the same way as an insert, and drop it there.`, { probe: onCell(p.name, p.x, p.y) });
  leaf.pts = leaf.pts.filter((m) => m.name !== p.name);
  rec.unmark(tid(leaf.id));
  for (let i = path.length - 2; i >= 0; i--) {
    const n = path[i];
    if (n.kids!.some((k) => k.kids)) break;
    const total = n.kids!.reduce((a, k) => a + k.pts.length, 0);
    const fold = total <= s.capacity;
    showPath(s, n.id);
    rec.vars({ name: p.name, node: nodeName(n.id), points: n.kids!.flatMap((k) => k.pts.map((m) => m.name)), 'self.capacity': s.capacity });
    rec.line('q_unlink', 'q_merge_test');
    rec.compare(`${nodeName(n.id)}: ${plural(total, 'point')}`, fold ? '≤' : '>', `capacity ${s.capacity}`, fold ? 'fold back into one leaf' : 'stay split', {
      probe: onCell(p.name, p.x, p.y),
    });
    if (!fold) break;
    n.pts = n.kids!.flatMap((k) => k.pts);
    n.kids = null;
    rec.count('merges');
    rec.vars({ name: p.name, node: nodeName(n.id), 'node.points': n.pts.map((m) => m.name), 'node.kids': null });
    rec.line('q_unlink', 'q_merge');
    rec.step(`${nodeName(n.id)}'s four children together hold ${plural(total, 'point')}, which fits in one leaf. Fold them back, so the tree does not keep splits that emptied out.`, {
      probe: onCell(p.name, p.x, p.y),
    });
  }
}

// ---- operations -----------------------------------------------------------

const nextName = (s: GeoState) => [...NAMES].find((c) => !byName(s, c))!;
const inMap = (v: number) => Number.isInteger(v) && v >= 0 && v < SIZE;

export function insert(s: GeoState, x: number, y: number, rec: Rec): boolean {
  s.query = null;
  const start = s.mode === 'geohash' ? 'start' : 'q_start';
  rec.vars({ x, y });
  if (!inMap(x) || !inMap(y)) {
    rec.line(start);
    rec.step(`(${x}, ${y}) is off the map. x and y run from 0 to ${SIZE - 1}.`);
    return false;
  }
  if (s.pts.length >= MAX_POINTS) {
    rec.line(start);
    rec.step(`This page draws at most ${MAX_POINTS} points, and the map has ${s.pts.length}. Use Move to send one somewhere else.`);
    return false;
  }
  const there = at(s, x, y);
  if (there) {
    rec.mark(cid(x, y), 'compare');
    rec.line(s.mode === 'geohash' ? 'taken' : 'q_taken');
    rec.step(`(${x}, ${y}) already holds ${there.name}. On this page a cell holds one point, so nothing changes. (A real geohash has codes 60 bits long, so two points rarely share one.)`, {
      probe: onCell(there.name, x, y),
    });
    return false;
  }
  const p: Pt = { name: nextName(s), x, y };
  s.pts.push(p);
  if (s.mode === 'geohash') geoInsert(s, p, rec);
  else qtInsert(s, p, rec);
  return true;
}

export function near(s: GeoState, x: number, y: number, r: number, rec: Rec): string[] {
  s.query = null;
  const begin = s.mode === 'geohash' ? 'side' : 'q_begin';
  rec.vars({ qx: x, qy: y, r });
  if (!inMap(x) || !inMap(y) || !(r >= 1 && r <= 3)) {
    rec.line(begin);
    rec.step(`Pick a cell on the map (0 to ${SIZE - 1}) and a radius from 1 to 3.`);
    return [];
  }
  s.query = { kind: 'near', x, y, r };
  return s.mode === 'geohash' ? geoNear(s, { x, y, r }, rec) : qtNear(s, { x, y, r }, rec);
}

export function box(s: GeoState, ax: number, ay: number, bx: number, by: number, rec: Rec): string[] {
  s.query = null;
  rec.vars({ x1: ax, y1: ay, x2: bx, y2: by });
  if (![ax, ay, bx, by].every(inMap)) {
    rec.line(s.mode === 'geohash' ? 'b_corners' : 'q_box_begin');
    rec.step(`Both corners must be on the map: 0 to ${SIZE - 1}.`);
    return [];
  }
  const x1 = Math.min(ax, bx), x2 = Math.max(ax, bx), y1 = Math.min(ay, by), y2 = Math.max(ay, by);
  s.query = { kind: 'box', x1, y1, x2, y2 };
  return s.mode === 'geohash' ? geoBox(s, x1, y1, x2, y2, rec) : qtBox(s, x1, y1, x2, y2, rec);
}

export function move(s: GeoState, name: string, x: number, y: number, rec: Rec): boolean {
  s.query = null;
  const geo = s.mode === 'geohash';
  const p = byName(s, String(name).trim().toUpperCase());
  rec.vars({ name: p ? p.name : String(name), x, y });
  if (!p) {
    rec.line(geo ? 'm_start' : 'q_m_start');
    rec.step(`There is no point called ${name}. The points are ${list(s.pts.map((m) => m.name))}.`);
    return false;
  }
  if (!inMap(x) || !inMap(y)) {
    rec.line(geo ? 'm_start' : 'q_m_start');
    rec.step(`(${x}, ${y}) is off the map. x and y run from 0 to ${SIZE - 1}.`);
    return false;
  }
  const there = at(s, x, y);
  if (there) {
    rec.mark(cid(x, y), 'compare');
    rec.line(geo ? 'm_taken' : 'q_m_taken');
    rec.step(
      there === p
        ? `${p.name} is already at (${x}, ${y}). Nothing to do. (With real coordinates most updates from a moving driver stay inside the same cell, and only the stored position changes.)`
        : `(${x}, ${y}) already holds ${there.name}, and this page keeps one point per cell. Nothing changes.`,
      { probe: onCell(p.name, p.x, p.y) },
    );
    return false;
  }
  if (geo) {
    const old = encode(p.x, p.y);
    rec.mark(eid(p.name), 'bad');
    rec.mark(cid(p.x, p.y), 'bad');
    rec.vars({ name: p.name, x, y, old: `(${p.x}, ${p.y})`, i: seek(s, old) });
    rec.line('unlink');
    rec.step(`${p.name} moves from (${p.x}, ${p.y}) to (${x}, ${y}), into a different cell, so its code changes. An index cannot edit a key in place: delete the entry under the old code ${bitStr(old)}, then insert under the new one.`, {
      probe: onCell(p.name, p.x, p.y),
    });
    s.entries.splice(seek(s, old), 1);
    rec.unmark(eid(p.name));
    rec.unmark(cid(p.x, p.y));
    p.x = x;
    p.y = y;
    geoInsert(s, p, rec, ['relink']);
  } else {
    qtRemove(s, p, rec);
    clearMap(rec);
    p.x = x;
    p.y = y;
    qtInsert(s, p, rec, ['q_reinsert']);
  }
  return true;
}

/** Index the same points the other way. */
export function rebuild(s: GeoState, rec: Rec): void {
  s.query = null;
  const to: Mode = s.mode === 'geohash' ? 'quadtree' : 'geohash';
  rec.vars({ kind: to, 'len(index.where)': s.pts.length });
  rec.line('switch');
  rec.step(
    to === 'quadtree'
      ? `Index the same ${plural(s.pts.length, 'point')} again, this time in a quadtree: a tree whose every node is a square, split into four children once it holds more than ${s.capacity} points.`
      : `Index the same ${plural(s.pts.length, 'point')} again, this time by geohash: each point's 6-bit code in one list sorted by code.`,
  );
  s.mode = to;
  s.entries = [];
  s.root = newNode('r', 0, 0, SIZE);
  s.bits = Array(BITS).fill('');
  s.builder = '';
  for (const p of s.pts) {
    if (to === 'geohash') s.entries.splice(seek(s, encode(p.x, p.y)), 0, { code: encode(p.x, p.y), name: p.name });
    else qtInsert(s, p, silent);
  }
  s.path = ['r'];
  rec.line('reinsert', 'switched');
  rec.step(
    to === 'quadtree'
      ? `Each point was inserted in turn. The tree has ${plural(leaves(s.root).length, 'leaf', 'leaves')} and is ${depth(s.root)} levels deep. The grey boxes on the map are its leaves: small where points crowd together, large where the map is empty.`
      : `Each point was encoded and slotted into the sorted list: ${plural(s.entries.length, 'entry', 'entries')}. The cells are now a fixed grid, the same size everywhere however crowded.`,
  );
}

/** A recorder that records nothing, for the quiet inserts of a rebuild. */
const silent: Rec = {
  recording: false,
  step() {},
  vars() {},
  compare() {},
  count() {},
  line() {},
  mark() {},
  markCell() {},
  markEdge() {},
  unmark() {},
  clearMarks() {},
};

// ---- layout ---------------------------------------------------------------

const CELL = 36;
const gapAt = (i: number) => (i === 4 ? 14 : i % 2 === 0 ? 8 : 4);
/** Left edge of column i (or top edge of screen row i). Wider gaps fall where the map halves. */
const EDGE: number[] = [];
for (let i = 0, acc = 0; i < SIZE; i++) {
  if (i > 0) acc += CELL + gapAt(i);
  EDGE.push(acc);
}
export const MAP_W = EDGE[SIZE - 1] + CELL;
const cx = (x: number) => EDGE[x] + CELL / 2;
const cy = (y: number) => EDGE[SIZE - 1 - y] + CELL / 2;
const PANEL_X = MAP_W + 50;
const ENTRY_W = 36 + 82 + 3 + 8;
const COL_PITCH = 150;
const ROWS = 6;
const LIST_Y = 108;
const ROW_PITCH = 44;
const TRAY_PITCH = 100;
/** Width of a split node's tray; narrower leaves are centred under it. */
const TRAY_W = 8 + 9 + 4 * 44;
export const SCENE = { left: -30, top: -50, right: PANEL_X + COL_PITCH + ENTRY_W + 27, bottom: MAP_W + 28 };

function inQuery(q: Query | null, x: number, y: number): boolean {
  if (!q) return false;
  if (q.kind === 'near') return d2(x, y, q.x, q.y) <= q.r * q.r;
  return x >= q.x1 && x <= q.x2 && y >= q.y1 && y <= q.y2;
}

export function layout(s: GeoState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  // Quadtree leaves as grey boxes behind the cells.
  if (s.mode === 'quadtree') {
    for (const l of leaves(s.root)) {
      const c0 = l.x, c1 = l.x + l.size; // columns [c0, c1)
      const r0 = SIZE - (l.y + l.size), r1 = SIZE - l.y; // screen rows [r0, r1)
      const m = (line: number) => (line <= 0 || line >= SIZE ? 5 : gapAt(line) / 2 - 1.5);
      const x1 = EDGE[c0] - m(c0), x2 = EDGE[c1 - 1] + CELL + m(c1);
      const y1 = EDGE[r0] - m(r0), y2 = EDGE[r1 - 1] + CELL + m(r1);
      decor.push({ id: `leaf-${l.id}`, type: 'band', x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
  }

  // The map.
  const q = s.query;
  for (let y = SIZE - 1; y >= 0; y--) {
    for (let x = 0; x < SIZE; x++) {
      const p = at(s, x, y);
      const isQ = q?.kind === 'near' && q.x === x && q.y === y;
      const text = p ? p.name : isQ ? 'Q' : inQuery(q, x, y) ? '·' : '';
      nodes.push({ id: cid(x, y), x: cx(x), y: cy(y), cells: [{ text, w: CELL, sub: y === 0 ? String(x) : undefined }] });
    }
    decor.push({ id: `row-${y}`, type: 'label', x: -12, y: cy(y), text: String(y), anchor: 'end' });
  }
  decor.push({ id: 'axis-x', type: 'label', x: MAP_W + 8, y: cy(0) + CELL / 2 + 14, text: 'x', anchor: 'start' });
  decor.push({ id: 'axis-y', type: 'label', x: -12, y: -14, text: 'y', anchor: 'end' });

  if (s.mode === 'geohash') {
    const bw = 8 + 15 + 6 * 34;
    nodes.push({
      id: BUILDER,
      x: PANEL_X + bw / 2,
      y: cy(SIZE - 1),
      title: s.builder || 'cell code',
      cells: s.bits.map((b, i) => ({ text: b, w: 34, sub: i % 2 === 0 ? 'x' : 'y' })),
    });
    decor.push({ id: 'list-label', type: 'label', x: PANEL_X, y: LIST_Y - 34, text: 'Sorted by code', strong: true });
    s.entries.forEach((e, i) => {
      nodes.push({
        id: eid(e.name),
        x: PANEL_X + Math.floor(i / ROWS) * COL_PITCH + ENTRY_W / 2,
        y: LIST_Y + (i % ROWS) * ROW_PITCH,
        cells: [{ text: e.name, w: 36 }, { text: bitStr(e.code), w: 82 }],
      });
    });
  } else {
    const shown = s.path.map((id) => findNode(s, id));
    shown.forEach((n, d) => {
      const y = cy(SIZE - 1) + d * TRAY_PITCH;
      const cells = n.kids
        ? n.kids.map((k, i) => ({ text: String(count(k)), w: 44, sub: QUAD[i] }))
        : n.pts.length
          ? n.pts.map((m) => ({ text: m.name, w: 40 }))
          : [{ text: '', w: 40 }];
      const w = cells.length > 1 ? 8 + 3 * (cells.length - 1) + cells.reduce((a, c) => a + c.w, 0) : cells[0].w;
      // No edges: the parent's chosen child is lit, and the title names the step.
      nodes.push({ id: tid(n.id), x: PANEL_X + Math.max(w, TRAY_W) / 2, y, cells, title: `${d ? '↓ ' : ''}${nodeName(n.id)} ${dims(n)}${n.kids ? '' : ', leaf'}` });
    });
    decor.push({ id: 'walk-label', type: 'label', x: PANEL_X + 230, y: cy(SIZE - 1), text: 'The walk,\nroot first', anchor: 'start', strong: true });
  }

  decor.push({ id: 'corner-a', type: 'label', x: SCENE.left, y: SCENE.top, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: SCENE.right, y: SCENE.bottom, text: '' });
  return { nodes, edges, decor };
}

// ---- definition -----------------------------------------------------------

const SEED: [number, number][] = [[2, 5], [4, 4], [5, 6], [1, 3], [6, 1], [0, 7], [7, 7], [3, 0], [6, 4], [1, 1]];

function freeCell(s: GeoState): [number, number] {
  for (let tries = 0; tries < 200; tries++) {
    const x = randomInt(0, SIZE - 1), y = randomInt(0, SIZE - 1);
    if (!at(s, x, y)) return [x, y];
  }
  return [0, 0];
}

const def: StructureDef<GeoState> = {
  id: 'geo-index',
  params: [
    { id: 'mode', label: 'Index', default: 0, options: [{ value: 0, label: 'Geohash' }, { value: 1, label: 'Quadtree' }] },
    { id: 'capacity', label: 'Quadtree leaf holds', default: 2, options: [2, 4].map((v) => ({ value: v, label: `${v} points` })) },
  ],
  create: (params) => create(params.mode === 1 ? 'quadtree' : 'geohash', params.capacity ?? 2),
  seed: SEED.map(([x, y]) => ['insert', x, y]),
  ops: [
    {
      id: 'insert',
      label: 'Insert',
      intent: 'primary',
      args: [
        { name: 'x', label: 'x', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'y', label: 'y', kind: 'int', min: 0, max: SIZE - 1 },
      ],
      code: ['insert', 'encode', 'q_insert', 'q_split', 'q_quadrant'],
      run: (s, [x, y], rec) => void insert(s, Number(x), Number(y), rec),
      suggest: (s) => freeCell(s),
    },
    {
      id: 'near',
      label: 'Near',
      args: [
        { name: 'x', label: 'x', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'y', label: 'y', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'r', label: 'Radius', kind: 'int', min: 1, max: 3 },
      ],
      code: ['near', 'q_near', 'q_gap'],
      run: (s, [x, y, r], rec) => void near(s, Number(x), Number(y), Number(r), rec),
      suggest: (s) => [...freeCell(s), randomInt(0, 3) === 0 ? 1 : 2],
    },
    {
      id: 'box',
      label: 'Box',
      args: [
        { name: 'x1', label: 'x1', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'y1', label: 'y1', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'x2', label: 'x2', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'y2', label: 'y2', kind: 'int', min: 0, max: SIZE - 1 },
      ],
      code: ['box', 'q_box', 'q_overlaps'],
      run: (s, [a, b, c, d], rec) => void box(s, Number(a), Number(b), Number(c), Number(d), rec),
      suggest: () => {
        const x1 = randomInt(0, 4), y1 = randomInt(0, 4);
        return [x1, y1, Math.min(SIZE - 1, x1 + randomInt(1, 3)), Math.min(SIZE - 1, y1 + randomInt(1, 3))];
      },
    },
    {
      id: 'move',
      label: 'Move',
      args: [
        { name: 'name', label: 'Point', kind: 'word' },
        { name: 'x', label: 'x', kind: 'int', min: 0, max: SIZE - 1 },
        { name: 'y', label: 'y', kind: 'int', min: 0, max: SIZE - 1 },
      ],
      code: ['move', 'insert', 'encode', 'q_move', 'q_remove', 'q_insert', 'q_split', 'q_quadrant'],
      run: (s, [n, x, y], rec) => void move(s, String(n), Number(x), Number(y), rec),
      suggest: (s) => {
        if (!s.pts.length) return ['A', 0, 0];
        const p = s.pts[randomInt(0, s.pts.length - 1)];
        // A driver moves a cell or two; fall back to anywhere free.
        for (let t = 0; t < 30; t++) {
          const x = p.x + randomInt(-2, 2), y = p.y + randomInt(-2, 2);
          if (inMap(x) && inMap(y) && !at(s, x, y)) return [p.name, x, y];
        }
        return [p.name, ...freeCell(s)];
      },
    },
    { id: 'switch', label: 'Switch index', args: [], code: ['switch'], run: (s, _a, rec) => rebuild(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Entries or nodes read' },
    { key: 'ranges', label: 'Range scans' },
    { key: 'pruned', label: 'Boxes pruned' },
  ],
  status: (s) => [
    { label: 'Index', value: s.mode === 'geohash' ? 'Geohash, sorted list' : `Quadtree, ${s.capacity} per leaf` },
    { label: 'Points', value: `${s.pts.length} of ${MAX_POINTS}` },
    s.mode === 'geohash'
      ? { label: 'Cells', value: '64 fixed, 6-bit codes' }
      : { label: 'Leaves, depth', value: `${leaves(s.root).length}, ${depth(s.root)}` },
  ],
  tour: [
    ['insert', 5, 2],
    ['near', 3, 4, 2],
    ['box', 2, 3, 5, 5],
    ['switch'],
    ['insert', 4, 0],
    ['near', 1, 5, 1],
  ],
  source: { python, java },
  info,
};

export default def;
