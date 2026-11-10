import { CELL_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import { info } from './info';

/**
 * Consistent hash ring.
 *
 * Positions run from 0 to 359 so they read as degrees: 0 is at the top and
 * they increase clockwise. Every server owns one or more points on the ring.
 * A key hashes to a position and belongs to the first live point at or after
 * it, wrapping past 359 back to the smallest point.
 *
 * Ownership is never stored. It is always worked out from the points, which is
 * the whole idea: change the points and only the keys in the affected arcs
 * change owner.
 */
export const RING = 360;
export const NAMES = 'ABCDEF';
export const MAX_SERVERS = NAMES.length;
export const MAX_VNODES = 3;

/**
 * Where each server's points sit, by server and then by replica number. A real
 * ring gets these by hashing "name#replica". A fixed table keeps the points at
 * least 11 degrees apart, so the drawing stays readable.
 */
const POINTS: readonly (readonly number[])[] = [
  [17, 148, 279],
  [100, 231, 2],
  [183, 314, 85],
  [266, 37, 168],
  [349, 120, 251],
  [72, 203, 334],
];

/** 197 shares no factor with 360, so neighbouring keys land far apart and every position is reachable. */
export const hashKey = (key: number): number => (key * 197 + 61) % RING;

export interface Point {
  pos: number;
  server: string;
  replica: number;
  /** A point that has been drawn but does not own anything yet. Only false while a join is being animated. */
  live: boolean;
}

export interface KeyEntry {
  pos: number;
  /** Which of the three inner circles the key is drawn on. Presentation only. */
  lane: number;
}

export interface RingState {
  vnodes: number;
  /** Server names, in alphabetical order. */
  servers: string[];
  /** Sorted by position. */
  points: Point[];
  keys: Map<number, KeyEntry>;
  /** Ring position of the key being followed. Only set while an operation is being recorded. */
  cursor: number | null;
  /** A key added by the running operation, so it can grow out of the cursor. Only set while recording. */
  born: number | null;
}

export function create(vnodes = 1, servers = 3): RingState {
  const s: RingState = { vnodes, servers: [], points: [], keys: new Map(), cursor: null, born: null };
  for (let i = 0; i < servers; i++) join(s, NAMES[i], true);
  return s;
}

function join(s: RingState, name: string, live: boolean): Point[] {
  const idx = NAMES.indexOf(name);
  const added: Point[] = [];
  for (let r = 0; r < s.vnodes; r++) added.push({ pos: POINTS[idx][r], server: name, replica: r, live });
  s.servers.push(name);
  s.servers.sort();
  s.points.push(...added);
  s.points.sort((a, b) => a.pos - b.pos);
  return added.sort((a, b) => a.pos - b.pos);
}

const livePoints = (s: RingState): Point[] => s.points.filter((p) => p.live);

/** The point that owns a position: the first live one at or after it, else the first on the ring. */
export function pointFor(s: RingState, pos: number): Point | null {
  const live = livePoints(s);
  if (!live.length) return null;
  return live.find((p) => p.pos >= pos) ?? live[0];
}

export function ownerOf(s: RingState, key: number): string | null {
  return pointFor(s, hashKey(key))?.server ?? null;
}

/** Keys held by each server. */
export function tally(s: RingState): Map<string, number> {
  const out = new Map<string, number>(s.servers.map((n) => [n, 0]));
  for (const key of s.keys.keys()) {
    const o = ownerOf(s, key);
    if (o) out.set(o, (out.get(o) ?? 0) + 1);
  }
  return out;
}

/** How many of these keys change shard when `hash mod N` sharding goes from `from` servers to `to`. */
export function modMoves(keys: Iterable<number>, from: number, to: number): number {
  let n = 0;
  for (const k of keys) if (k % from !== k % to) n++;
  return n;
}

// ---- geometry ---------------------------------------------------------------

const R = 164;
const CX = 226;
const CY = 222;
const POINT_R = 14;
/** The cursor dot sits just inside the ring, clear of the server circles drawn on it. */
const CURSOR_R = R - 21;
const KEY_W = 38;
/** Radius of each inner circle of keys. A key is drawn on the outermost one where its box touches no other. */
const LANES = [120, 76, 32] as const;
/** Clear space kept between two key boxes. */
const KEY_GAP = 4;
const TALLY_X = CX + R + 150;
const WIDTH = TALLY_X + 110;
const HEIGHT = CY + R + POINT_R + 26;

const polar = (r: number, pos: number) => {
  const t = (pos * Math.PI) / 180;
  return { x: Math.round((CX + r * Math.sin(t)) * 10) / 10, y: Math.round((CY - r * Math.cos(t)) * 10) / 10 };
};

/** The first inner circle where a key at this position would touch no other key, or -1 when none has room. */
export function laneFor(s: RingState, pos: number): number {
  const taken = [...s.keys.values()].map((e) => polar(LANES[e.lane], e.pos));
  for (let lane = 0; lane < LANES.length; lane++) {
    const at = polar(LANES[lane], pos);
    if (taken.every((t) => Math.abs(t.x - at.x) >= KEY_W + KEY_GAP || Math.abs(t.y - at.y) >= CELL_H + KEY_GAP)) return lane;
  }
  return -1;
}

/** The side of a ring position that faces away from the centre, for the probe chip. */
function outward(pos: number): NonNullable<Probe['place']> {
  if (pos >= 315 || pos < 45) return 'above';
  if (pos < 135) return 'right';
  if (pos < 225) return 'below';
  return 'left';
}

const CURSOR = 'pos';
const pid = (p: Point) => `p-${p.server}-${p.replica}`;
const kid = (key: number) => `k${key}`;
const tid = (name: string) => `t-${name}`;
const hueOf = (name: string) => NAMES.indexOf(name);

export function layout(s: RingState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [
    { id: 'ring', type: 'ring', cx: CX, cy: CY, r: R },
    // Two empty labels pin the corners so the view does not rescale as servers come and go.
    { id: 'corner-a', type: 'label', x: 0, y: 9, text: '' },
    { id: 'corner-b', type: 'label', x: WIDTH, y: HEIGHT - 9, text: '' },
  ];

  for (const p of s.points) {
    const at = polar(R, p.pos);
    nodes.push({ id: pid(p), x: at.x, y: at.y, shape: 'circle', r: POINT_R, cells: [{ text: p.server }], hue: hueOf(p.server) });
    const side = outward(p.pos);
    const l = polar(R + POINT_R + (side === 'above' || side === 'below' ? 13 : 8), p.pos);
    decor.push({
      id: `deg-${pid(p)}`,
      type: 'label',
      x: l.x,
      y: l.y + 4,
      text: `${p.pos}°`,
      anchor: side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle',
    });
  }

  for (const [key, e] of s.keys) {
    const at = polar(LANES[e.lane], e.pos);
    const owner = pointFor(s, e.pos);
    const n: SceneNode = { id: kid(key), x: at.x, y: at.y, cells: [{ text: String(key), w: KEY_W }], hue: owner ? hueOf(owner.server) : undefined };
    if (s.born === key) n.from = CURSOR;
    nodes.push(n);
  }

  if (s.cursor !== null) {
    const at = polar(CURSOR_R, s.cursor);
    nodes.push({ id: CURSOR, x: at.x, y: at.y, shape: 'circle', r: 5, cells: [{ text: '' }], tone: 'key' });
  }

  // Load per server, beside the ring.
  const counts = tally(s);
  const total = s.keys.size;
  const rowGap = CELL_H + 22;
  const top = CY - ((s.servers.length - 1) * rowGap) / 2;
  decor.push({ id: 'tally-head', type: 'label', x: TALLY_X - 44, y: top - CELL_H / 2 - 16, text: 'Keys on each server', anchor: 'start', strong: true });
  s.servers.forEach((name, i) => {
    const y = top + i * rowGap;
    const count = counts.get(name) ?? 0;
    nodes.push({ id: tid(name), x: TALLY_X, y, cells: [{ text: name, w: 40 }, { text: String(count), w: 44 }], hue: hueOf(name) });
    decor.push({
      id: `share-${name}`,
      type: 'label',
      x: TALLY_X + 58,
      y: y + 5,
      text: total ? `${Math.round((count / total) * 100)}%` : '',
      anchor: 'start',
    });
  });

  return { nodes, edges: [], decor };
}

// ---- operations -------------------------------------------------------------

const list = (items: (string | number)[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const formula = (key: number): string => `hash(${key}) = (${key} × 197 + 61) mod 360 = ${hashKey(key)}`;

function begin(s: RingState, pos: number, rec: Rec): void {
  rec.clearMarks();
  s.born = null;
  s.cursor = rec.recording ? pos : null;
}

function end(s: RingState): void {
  s.cursor = null;
  s.born = null;
}

/**
 * Find the point that owns `pos` the way a real client does: binary search over
 * the sorted list of points for the first one at or after the position.
 */
function locate(s: RingState, pos: number, rec: Rec, probe: Probe): { point: Point; wrapped: boolean; comparisons: number } {
  const live = livePoints(s);
  let lo = 0;
  let hi = live.length;
  let comparisons = 0;
  rec.step(
    `The client keeps the ${plural(live.length, 'point')} in a sorted list: ${live.map((p) => `${p.pos}°`).join(', ')}. It binary-searches that list for the first point at or after ${pos}°. No server is contacted yet.`,
    { probe },
  );
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = live[mid];
    comparisons++;
    rec.count('reads');
    rec.mark(pid(p), 'compare');
    if (pos <= p.pos) {
      rec.compare(`h(${probe.text}) = ${pos}°`, '≤', `${p.pos}°`, `${p.server}'s point is at or after the key, so it could be the owner: look earlier for a closer one`, { probe });
      hi = mid;
      rec.mark(pid(p), 'path');
    } else {
      rec.compare(`h(${probe.text}) = ${pos}°`, '>', `${p.pos}°`, `${p.server}'s point is behind the key, so the owner is later in the list`, { probe });
      lo = mid + 1;
      rec.mark(pid(p), 'dim');
    }
  }
  const wrapped = lo === live.length;
  const point = wrapped ? live[0] : live[lo];
  for (const p of live) rec.unmark(pid(p));
  rec.mark(pid(point), 'ok');
  return { point, wrapped, comparisons };
}

const found = (key: number, pos: number, hit: { point: Point; wrapped: boolean }): string =>
  hit.wrapped
    ? `No point lies at or after ${pos}°, so the search wraps past 359° to the first point on the ring: ${hit.point.server} at ${hit.point.pos}°. Server ${hit.point.server} owns key ${key}.`
    : `Server ${hit.point.server} owns key ${key}: its point at ${hit.point.pos}° is the first one clockwise from ${pos}°.`;

/** Which server holds this key? Returns its name. */
export function lookup(s: RingState, key: number, rec: Rec): string {
  const pos = hashKey(key);
  const text = String(key);
  begin(s, pos, rec);
  const probe: Probe = { text, at: CURSOR, place: outward(pos) };
  const stored = s.keys.has(key);
  if (stored) rec.mark(kid(key), 'key');
  rec.step(
    `${formula(key)}, so key ${key} belongs at ${pos}° on the ring${stored ? '' : ' (it is not stored, but any key has a place)'}. Its server is the first point clockwise from there.`,
    { probe },
  );
  const hit = locate(s, pos, rec, probe);
  rec.step(
    `${found(key, pos, hit)} The search took ${plural(hit.comparisons, 'comparison')} over ${plural(livePoints(s).length, 'point')}, all on the client, so the request goes straight to ${hit.point.server}.`,
    { probe: { text, at: pid(hit.point), place: outward(hit.point.pos) } },
  );
  end(s);
  return hit.point.server;
}

/** Store a key. Returns false when it was already there or cannot be drawn. */
export function put(s: RingState, key: number, rec: Rec): boolean {
  const pos = hashKey(key);
  const text = String(key);
  begin(s, pos, rec);
  if (s.keys.has(key)) {
    rec.mark(kid(key), 'key');
    rec.step(`${key} is already stored, on server ${ownerOf(s, key)}. A ring holds each key once, so there is nothing to do.`, {
      probe: { text, at: kid(key) },
    });
    end(s);
    return false;
  }
  const lane = laneFor(s, pos);
  const probe: Probe = { text, at: CURSOR, place: outward(pos) };
  if (lane < 0) {
    rec.step(`${formula(key)}. This small drawing has no room left for another key near ${pos}°, so ${key} is not added. Delete a key or try a different one.`, {
      probe,
    });
    end(s);
    return false;
  }
  rec.step(`${formula(key)}, so key ${key} belongs at ${pos}° on the ring. Its server is the first point clockwise from there.`, { probe });
  const hit = locate(s, pos, rec, probe);
  s.keys.set(key, { pos, lane });
  if (rec.recording) s.born = key;
  rec.count('writes');
  rec.mark(kid(key), 'key');
  rec.step(
    `${found(key, pos, hit)} The write goes to ${hit.point.server}, which now holds ${plural(tally(s).get(hit.point.server) ?? 0, 'key')}. Keys are tinted with their server's colour.`,
    { probe: { text, at: kid(key) } },
  );
  end(s);
  return true;
}

/** Delete a key. Returns false when it was not stored. */
export function remove(s: RingState, key: number, rec: Rec): boolean {
  const pos = hashKey(key);
  const text = String(key);
  begin(s, pos, rec);
  if (!s.keys.has(key)) {
    rec.step(`${formula(key)}. No key ${key} is stored at ${pos}°, so there is nothing to delete.`, { probe: { text, at: CURSOR, place: outward(pos) } });
    end(s);
    return false;
  }
  const probe: Probe = { text, at: kid(key) };
  rec.mark(kid(key), 'key');
  rec.step(`${formula(key)}, so key ${key} sits at ${pos}° on the ring. Find its server the same way a read would.`, { probe });
  const hit = locate(s, pos, rec, probe);
  rec.mark(kid(key), 'bad');
  rec.step(`${found(key, pos, hit)} Only ${hit.point.server} can hold it, so the delete goes there and nowhere else.`, { probe });
  s.keys.delete(key);
  rec.count('writes');
  rec.step(`${key} is deleted from server ${hit.point.server}, which now holds ${plural(tally(s).get(hit.point.server) ?? 0, 'key')}. No other key or server was touched.`);
  end(s);
  return true;
}

function owners(s: RingState): Map<number, string> {
  const out = new Map<number, string>();
  for (const key of s.keys.keys()) out.set(key, ownerOf(s, key) as string);
  return out;
}

const versusMod = (keys: number, from: number, to: number, naive: number): string =>
  keys === 0
    ? ''
    : ` Sharding by hash mod N instead, going from ${from} to ${plural(to, 'server')} would have moved ${naive} of ${plural(keys, 'key')}.`;

/** Add the next unused server. Returns its name and the keys that moved to it, or null when the ring is full. */
export function addServer(s: RingState, rec: Rec): { name: string; moved: number[] } | null {
  begin(s, 0, rec);
  s.cursor = null;
  if (s.servers.length >= MAX_SERVERS) {
    rec.step(`This drawing stops at ${MAX_SERVERS} servers. Remove one before adding another.`);
    return null;
  }
  const name = [...NAMES].find((n) => !s.servers.includes(n)) as string;
  const before = s.servers.length;
  const naive = modMoves(s.keys.keys(), before, before + 1);
  let current = owners(s);
  const points = join(s, name, false);
  for (const p of points) rec.mark(pid(p), 'ok');
  rec.mark(tid(name), 'ok');
  rec.step(
    `Server ${name} joins with ${plural(points.length, 'point')} at ${list(points.map((p) => `${p.pos}°`))}. A real ring gets these by hashing the server's name; this page uses a fixed table so the picture stays readable. No key has moved yet.`,
  );

  const moved: number[] = [];
  for (const p of points) {
    const live = livePoints(s);
    // The arc this point takes runs from the live point before it round to itself.
    const prev = [...live].reverse().find((q) => q.pos < p.pos) ?? live[live.length - 1];
    const loser = pointFor(s, p.pos)?.server ?? name;
    p.live = true;
    const next = owners(s);
    const here = [...next.keys()].filter((k) => next.get(k) !== current.get(k)).sort((a, b) => a - b);
    current = next;
    moved.push(...here);
    rec.count('moved', here.length);
    for (const k of moved) rec.mark(kid(k), 'ok');
    rec.step(
      `${name}'s point at ${p.pos}° takes over the arc from ${prev ? prev.pos : p.pos}° round to ${p.pos}°` +
        (loser === name ? `, which ${name} already covered from a point further on.` : `, which belonged to ${loser}.`) +
        (here.length
          ? ` ${list(here)} ${here.length === 1 ? 'sits' : 'sit'} in that arc, so ${here.length === 1 ? 'it moves' : 'they move'} from ${loser} to ${name}.`
          : ` No key sits in that arc, so nothing moves.`),
    );
  }

  rec.clearMarks();
  const total = s.keys.size;
  rec.step(
    `${name} is in. ${moved.length} of ${plural(total, 'key')} moved, all to ${name}, and no key moved between the old servers.` +
      versusMod(total, before, before + 1, naive),
  );
  return { name, moved: moved.sort((a, b) => a - b) };
}

/** Take a server off the ring. Returns the keys that had to move, or null when it cannot leave. */
export function removeServer(s: RingState, which: string, rec: Rec): { name: string; moved: number[] } | null {
  begin(s, 0, rec);
  s.cursor = null;
  const name = String(which).trim().toUpperCase().charAt(0);
  if (!s.servers.includes(name)) {
    rec.step(`There is no server called "${String(which).trim()}". The ring has ${list(s.servers)}.`);
    return null;
  }
  if (s.servers.length === 1) {
    rec.step(`${name} is the last server. If it left, its keys would have nowhere to go, so it stays.`);
    return null;
  }
  const before = s.servers.length;
  const naive = modMoves(s.keys.keys(), before, before - 1);
  const mine = [...s.keys.keys()].filter((k) => ownerOf(s, k) === name).sort((a, b) => a - b);
  const points = s.points.filter((p) => p.server === name);
  for (const p of points) rec.mark(pid(p), 'bad');
  rec.mark(tid(name), 'bad');
  for (const k of mine) rec.mark(kid(k), 'bad');
  rec.step(
    `Server ${name} leaves, or fails. Its ${points.length === 1 ? 'point comes' : `${points.length} points come`} off the ring at ${list(points.map((p) => `${p.pos}°`))}. ` +
      (mine.length ? `It held ${list(mine)}. Each of those now belongs to the next point clockwise.` : `It held no keys, so nothing needs a new home.`),
  );

  s.points = s.points.filter((p) => p.server !== name);
  s.servers = s.servers.filter((n) => n !== name);
  rec.count('moved', mine.length);
  rec.clearMarks();
  for (const k of mine) rec.mark(kid(k), 'ok');
  if (mine.length) {
    rec.step(`${mine.map((k) => `${k} goes to ${ownerOf(s, k)}`).join(', ')}. Every other key still hashes to the same server as before.`);
  }
  rec.clearMarks();
  const total = s.keys.size;
  rec.step(
    `${name} is gone. ${mine.length} of ${plural(total, 'key')} moved, only the ones ${name} held.` +
      versusMod(total, before, before - 1, naive) +
      ` In a real cluster the neighbours already hold replicas of those keys, so they can serve them at once.`,
  );
  return { name, moved: mine };
}

// ---- definition -------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function storedKey(s: RingState): number {
  const keys = [...s.keys.keys()];
  return keys.length ? keys[randomInt(0, keys.length - 1)] : randomInt(0, 999);
}

/** A key that is not stored and has room to be drawn. */
function freshKey(s: RingState): number {
  for (let i = 0; i < 200; i++) {
    const k = randomInt(1, 999);
    if (!s.keys.has(k) && laneFor(s, hashKey(k)) >= 0) return k;
  }
  return randomInt(1, 999);
}

function busiest(s: RingState): string {
  let best = s.servers[0] ?? 'A';
  let most = -1;
  for (const [name, n] of tally(s)) {
    if (n > most) {
      most = n;
      best = name;
    }
  }
  return best;
}

const def: StructureDef<RingState> = {
  id: 'consistent-hashing',
  params: [
    {
      id: 'vnodes',
      label: 'Points per server',
      options: [
        { value: 1, label: '1' },
        { value: 3, label: '3 (virtual nodes)' },
      ],
      default: 1,
    },
  ],
  create: (p) => create(p.vnodes ?? 1),
  seed: [14, 23, 32, 50, 59, 63, 68, 77, 86, 95, 104, 113].map((k) => ['put', k] as [string, number]),
  ops: [
    { id: 'lookup', label: 'Look up', args: [KEY], run: (s, [k], rec) => void lookup(s, Number(k), rec), suggest: (s) => [storedKey(s)] },
    { id: 'put', label: 'Put', intent: 'primary', args: [KEY], run: (s, [k], rec) => void put(s, Number(k), rec), suggest: (s) => [freshKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [storedKey(s)] },
    { id: 'addServer', label: 'Add a server', args: [], run: (s, _a, rec) => void addServer(s, rec) },
    {
      id: 'removeServer',
      label: 'Remove server',
      intent: 'danger',
      args: [{ name: 'server', label: 'Server', kind: 'word' }],
      run: (s, [name], rec) => void removeServer(s, String(name), rec),
      suggest: (s) => [busiest(s).toLowerCase()],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'moved', label: 'Keys moved' },
  ],
  status: (s) => {
    const counts = tally(s);
    const top = busiest(s);
    const total = s.keys.size;
    return [
      { label: 'Servers', value: String(s.servers.length) },
      { label: 'Points on the ring', value: String(s.points.length) },
      { label: 'Keys', value: String(total) },
      { label: 'Busiest server', value: total ? `${top} with ${counts.get(top)} of ${total}` : 'none yet' },
    ];
  },
  tour: [
    ['lookup', 63],
    ['put', 189],
    ['addServer'],
    ['lookup', 63],
    ['removeServer', 'a'],
  ],
  fill: (s) => ['put', freshKey(s)],
  info,
};

export default def;
