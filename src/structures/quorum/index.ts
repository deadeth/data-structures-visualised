import { LABEL_MAX } from '../../core/fit';
import { CELL_GAP, TRAY_PAD } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/Quorum.java?raw';
import python from './code/quorum.py?raw';
import { info } from './info';

/**
 * Leaderless, Dynamo-style replication. Every key is stored on all N
 * replicas. A write goes to all of them and succeeds when W have acknowledged
 * it; a read asks all of them and answers from the first R replies, taking the
 * copy with the highest version and writing it back to any replica that
 * answered with an older one (read repair).
 *
 * Simplified: every key lives on the same N replicas (a real cluster places
 * each key on N of many nodes, by consistent hashing); the version is a
 * counter that only goes up, standing in for a write timestamp from a clock
 * that never drifts; messages are handled one replica at a time so they can
 * be drawn; and the order replies arrive in is chosen by the reader.
 */
export interface Copy {
  value: number | null;
  /** 0 when this replica has never held the key. */
  version: number;
}

export interface QuorumState {
  n: number;
  w: number;
  r: number;
  up: boolean[];
  /** data[i][key]: what replica i holds for that key. */
  data: Record<number, Copy>[];
  /** Keys drawn as rows, ascending. */
  keys: number[];
  /** The last version handed out. */
  clock: number;
  /**
   * Not part of the store: the page's own note of the version of the last
   * write to each key that the client was told succeeded, so a read that
   * returns something older can be labelled stale.
   */
  latest: Record<number, number>;
}

/** Keys the page draws. A real store holds millions. */
export const MAX_KEYS = 3;
export const SIZES = [3, 5];
const NONE: Copy = { value: null, version: 0 };

export function create(n = 3, w = 2, r = 2): QuorumState {
  return {
    n,
    w: Math.min(Math.max(1, w), n),
    r: Math.min(Math.max(1, r), n),
    up: new Array<boolean>(n).fill(true),
    data: Array.from({ length: n }, () => ({})),
    keys: [],
    clock: 0,
    latest: {},
  };
}

export const copyOf = (s: QuorumState, i: number, key: number): Copy => s.data[i][key] ?? NONE;
export const upCount = (s: QuorumState) => s.up.filter(Boolean).length;
/** Highest version of a key on any replica, up or down. */
export const newestVersion = (s: QuorumState, key: number) => Math.max(0, ...s.data.map((d) => d[key]?.version ?? 0));
/** Copies older than the newest copy of the same key somewhere else. The page can see this; no replica can. */
export function staleCopies(s: QuorumState): number {
  let n = 0;
  for (const key of s.keys) {
    const top = newestVersion(s, key);
    for (let i = 0; i < s.n; i++) if (copyOf(s, i, key).version < top) n++;
  }
  return n;
}

// ---- ids and words ------------------------------------------------------------

const CLIENT = 'client';
const CONFIG = 'cfg';
const hid = (i: number) => `h${i}`;
const cid = (i: number, key: number) => `c${i}k${key}`;
const kid = (key: number) => `k${key}`;
const eid = (i: number) => `e${i}`;
const rn = (i: number) => `R${i + 1}`;
const vn = (c: Copy) => `v${c.version}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const show = (key: number, c: Copy) => (c.version ? `${key} = ${c.value} at ${vn(c)}` : `nothing for ${key}`);
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
/** Cells of the config node: N, W, R. */
const W_CELL = 1;
const R_CELL = 2;

function addKey(s: QuorumState, key: number): void {
  if (s.keys.includes(key)) return;
  s.keys.push(key);
  s.keys.sort((a, b) => a - b);
}

const validReplica = (s: QuorumState, i: number) => Number.isInteger(i) && i >= 1 && i <= s.n;
const validKey = (k: number) => Number.isInteger(k) && k >= 0 && k <= 999;

// ---- operations -----------------------------------------------------------------

/** Write key = value to every replica that is up. Returns true when W acknowledged it. */
export function write(s: QuorumState, key: number, value: number, rec: Rec): boolean {
  rec.line('send');
  if (!validKey(key) || !validKey(value)) {
    rec.step(`Keys and values on this page are whole numbers from 0 to 999.`);
    return false;
  }
  const isNew = !s.keys.includes(key);
  if (isNew && s.keys.length >= MAX_KEYS) {
    rec.step(
      `Sorry, this page draws at most ${MAX_KEYS} keys so the replicas stay readable, and it has ${list(s.keys.map(String))}. Write to one of those instead. A real store holds millions of keys.`,
    );
    return false;
  }
  addKey(s, key);
  const version = ++s.clock;
  const atClient: Probe = { text: String(key), at: CLIENT };
  const at = (i: number): Probe => ({ text: String(key), at: cid(i, key) });
  rec.mark(kid(key), 'key');
  rec.step(
    `Write ${key} = ${value}. The coordinator stamps it with version v${version}, newer than any version so far, and sends it to all ${s.n} replicas at once. It needs W = ${s.w} ${s.w === 1 ? 'ack' : 'acks'} to call the write a success.`,
    { probe: atClient },
  );

  let acks = 0;
  const missed: string[] = [];
  for (let i = 0; i < s.n; i++) {
    rec.markEdge(eid(i), 'path');
    if (!s.up[i]) {
      rec.markEdge(eid(i), 'bad');
      rec.mark(cid(i, key), 'bad');
      missed.push(rn(i));
      rec.line('skip');
      rec.step(
        `${rn(i)} is down, so the write never reaches it and no ack comes back. The coordinator cannot tell a dead replica from a slow one: it waits until its timeout, then counts ${rn(i)} as missing.`,
        { probe: at(i) },
      );
      continue;
    }
    const had = copyOf(s, i, key);
    rec.mark(cid(i, key), 'compare');
    rec.line('newer');
    rec.compare(`new v${version}`, '>', `${rn(i)} ${vn(had)}`, `${rn(i)} stores it`, {
      probe: at(i),
      message: had.version
        ? `${rn(i)} holds ${show(key, had)}. The incoming version v${version} is higher, so it replaces it.`
        : `${rn(i)} has no copy of ${key} yet (version 0), so it stores the incoming one.`,
    });
    s.data[i][key] = { value, version };
    acks++;
    rec.count('writes');
    rec.mark(cid(i, key), 'ok');
    rec.markEdge(eid(i), 'ok');
    rec.line('store');
    rec.step(`${rn(i)} now holds ${key} = ${value} at v${version} and acks. ${plural(acks, 'ack')} so far, of the ${s.w} needed.`, { probe: at(i) });
  }

  const ok = acks >= s.w;
  rec.markCell(CONFIG, W_CELL, 'compare');
  rec.line('quorum');
  rec.compare(`acks ${acks}`, ok ? '≥' : '<', `W ${s.w}`, ok ? 'the write succeeds' : 'the write fails', {
    probe: atClient,
    message: ok
      ? `${plural(acks, 'ack')} came back and W is ${s.w}, so the write has its quorum. A real coordinator answers the client as soon as the ${s.w === 1 ? 'first ack' : `${ordinal(s.w)} ack`} arrives.`
      : `Only ${plural(acks, 'ack')} came back and W is ${s.w}. The coordinator has no quorum.`,
  });
  rec.markCell(CONFIG, W_CELL, 'idle');
  rec.mark(CLIENT, ok ? 'ok' : 'bad');
  if (ok) {
    s.latest[key] = version;
    rec.step(
      `The client is told the write of ${key} = ${value} succeeded: ${s.n} sent, ${plural(acks, 'ack')}. ` +
        (missed.length
          ? `${list(missed)} missed it and ${missed.length === 1 ? 'is' : 'are'} now stale for key ${key}. Nothing tells ${missed.length === 1 ? 'it' : 'them'} so; a read repair, anti-entropy or a hint will have to.`
          : `Every replica has it.`),
      { probe: atClient },
    );
  } else {
    rec.count('failed');
    const kept = s.up.flatMap((u, i) => (u ? [rn(i)] : []));
    if (acks === 0) s.keys = s.keys.filter((k) => k !== key || s.data.some((d) => d[key]));
    rec.step(
      `The client is told the write failed. ` +
        (acks
          ? `But ${list(kept)} stored ${key} = ${value} and ${acks === 1 ? 'keeps it' : 'keep it'}: a failed write is not rolled back. A later read may return it or may not, and the client cannot tell which.`
          : `No replica stored it, so nothing changed.`),
      { probe: atClient },
    );
  }
  return ok;
}

function ordinal(n: number): string {
  return n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

/**
 * Read a key. `first` is the replica whose reply arrives first (1-based); the
 * rest follow in order. Returns the copy returned, or null when the read failed.
 */
export function read(s: QuorumState, key: number, first: number, rec: Rec): Copy | null {
  rec.line('ask');
  if (!validKey(key)) {
    rec.step(`Keys on this page are whole numbers from 0 to 999.`);
    return null;
  }
  if (!validReplica(s, first)) {
    rec.step(`There are ${s.n} replicas, R1 to R${s.n}. Choose one of them to answer first.`);
    return null;
  }
  if (!s.keys.includes(key)) {
    rec.step(`Nothing has been written to key ${key}, so every replica would answer "not found". Try ${list(s.keys.map(String))}.`);
    return null;
  }
  const atClient: Probe = { text: String(key), at: CLIENT };
  const at = (i: number): Probe => ({ text: String(key), at: cid(i, key) });
  rec.mark(kid(key), 'key');
  rec.step(
    `Read ${key}. The coordinator asks all ${s.n} replicas and will answer from the first R = ${s.r} ${s.r === 1 ? 'reply' : 'replies'}. Replies arrive in whatever order the network delivers them; here ${rn(first - 1)} is first.`,
    { probe: atClient },
  );

  const replies: number[] = [];
  for (let k = 0; k < s.n && replies.length < s.r; k++) {
    const i = (first - 1 + k) % s.n;
    rec.markEdge(eid(i), 'path');
    rec.line('reply');
    if (!s.up[i]) {
      rec.markEdge(eid(i), 'bad');
      rec.mark(cid(i, key), 'bad');
      rec.step(`${rn(i)} is down and never replies.`, { probe: at(i) });
      continue;
    }
    replies.push(i);
    rec.count('reads');
    rec.mark(cid(i, key), 'path');
    rec.markEdge(eid(i), 'ok');
    rec.step(`${rn(i)} replies: ${show(key, copyOf(s, i, key))}. ${plural(replies.length, 'reply', 'replies')} of the ${s.r} needed.`, { probe: at(i) });
  }

  const late = s.up.flatMap((u, i) => (u && !replies.includes(i) ? [i] : []));
  for (const i of late) rec.mark(cid(i, key), 'dim');
  const enough = replies.length >= s.r;
  rec.markCell(CONFIG, R_CELL, 'compare');
  rec.line('enough');
  rec.compare(`replies ${replies.length}`, enough ? '≥' : '<', `R ${s.r}`, enough ? 'enough to answer' : 'the read fails', {
    probe: atClient,
    message: enough
      ? `${plural(replies.length, 'reply', 'replies')} and R is ${s.r}: enough to answer.` +
        (late.length ? ` ${list(late.map(rn))}'s ${late.length === 1 ? 'reply arrives' : 'replies arrive'} after that and ${late.length === 1 ? 'is' : 'are'} not used.` : ``)
      : `Every replica that is up has answered, ${plural(replies.length, 'reply', 'replies')} in all, and R is ${s.r}. There is no read quorum.`,
  });
  rec.markCell(CONFIG, R_CELL, 'idle');
  if (!enough) {
    rec.count('failed');
    rec.mark(CLIENT, 'bad');
    rec.line('fail');
    rec.step(
      `The client gets an error rather than an answer the quorum cannot vouch for. Only ${plural(upCount(s), 'replica is', 'replicas are')} up and R is ${s.r}. Lower R, or bring a replica back.`,
      { probe: atClient },
    );
    return null;
  }

  // Keep the newest of the replies.
  let best = replies[0];
  for (const i of replies.slice(1)) {
    const a = copyOf(s, i, key);
    const b = copyOf(s, best, key);
    rec.mark(cid(i, key), 'compare');
    rec.mark(cid(best, key), 'compare');
    rec.line('newest');
    const newer = a.version > b.version;
    rec.compare(`${rn(i)} ${vn(a)}`, newer ? '>' : a.version === b.version ? '=' : '<', `${rn(best)} ${vn(b)}`, newer ? `${rn(i)}'s copy is newer: keep it` : `keep ${rn(best)}'s copy`, {
      probe: at(i),
    });
    rec.mark(cid(i, key), 'path');
    rec.mark(cid(best, key), 'path');
    if (newer) best = i;
  }
  const answer = { ...copyOf(s, best, key) };
  rec.mark(cid(best, key), 'ok');
  rec.line('answer');
  rec.step(
    replies.length === 1
      ? `With R = 1 there is nothing to compare: ${rn(best)}'s copy is the answer, ${show(key, answer)}.`
      : `The newest reply is ${rn(best)}'s: ${show(key, answer)}. That is the answer.`,
    { probe: at(best) },
  );

  // Read repair: write the answer back to any replica that answered with something older.
  let repaired = 0;
  for (const i of replies) {
    const c = copyOf(s, i, key);
    const stale = c.version < answer.version;
    if (i !== best) rec.mark(cid(i, key), 'compare');
    rec.line('stale');
    rec.compare(`${rn(i)} ${vn(c)}`, stale ? '<' : '=', vn(answer), stale ? 'stale: repair it' : 'up to date', {
      probe: at(i),
      message: stale
        ? `Read repair: ${rn(i)} answered with ${vn(c)}, older than ${vn(answer)}. Write the newer copy back to it.`
        : i === best
          ? `Read repair checks each replica that answered. ${rn(i)} supplied the answer, so it is up to date.`
          : `${rn(i)} answered with ${vn(c)} as well. It is up to date.`,
    });
    if (stale) {
      s.data[i][key] = { ...answer };
      repaired++;
      rec.count('writes');
      rec.count('repairs');
      rec.mark(cid(i, key), 'ok');
      rec.line('repair');
      rec.step(`${rn(i)} now holds ${show(key, answer)} too. The next read that reaches it will not need repairing.`, { probe: at(i) });
    } else if (i !== best) rec.mark(cid(i, key), 'path');
  }

  const latest = s.latest[key] ?? 0;
  const isStale = answer.version < latest;
  const holders = s.data.flatMap((d, i) => ((d[key]?.version ?? 0) >= latest && latest ? [rn(i)] : []));
  if (isStale) {
    rec.count('stale');
    // The answer was found, but it is out of date: show it as a miss.
    rec.mark(cid(best, key), 'bad');
  }
  rec.mark(CLIENT, isStale ? 'bad' : 'ok');
  rec.line('answer');
  const sum = `R + W = ${s.r} + ${s.w} = ${s.r + s.w}`;
  rec.step(
    `The client gets ${show(key, answer)}: ${s.n} asked, ${plural(replies.length, 'reply', 'replies')} used, ${plural(repaired, 'stale copy', 'stale copies')} repaired. ` +
      (isStale
        ? `This is a stale read. The last write of ${key} that succeeded was v${latest}, and ${list(holders)} ${holders.length === 1 ? 'holds' : 'hold'} it, but no reply that counted came from ${holders.length === 1 ? 'it' : 'them'}. ${sum}, not more than N = ${s.n}, so a read quorum need not overlap a write quorum.`
        : s.r + s.w > s.n
          ? `${sum} > N = ${s.n}, so the replies that counted had to include a replica that took the last successful write.`
          : `It happens to be the newest, but ${sum} is not more than N = ${s.n}, so nothing promised that.`),
    { probe: atClient },
  );
  return answer;
}

/** Take a replica down. It keeps its data. */
export function down(s: QuorumState, replica: number, rec: Rec): boolean {
  rec.line('stop');
  if (!validReplica(s, replica)) {
    rec.step(`There are ${s.n} replicas, R1 to R${s.n}. There is no R${replica}.`);
    return false;
  }
  const i = replica - 1;
  if (!s.up[i]) {
    rec.step(`${rn(i)} is already down.`);
    return false;
  }
  s.up[i] = false;
  const live = upCount(s);
  const lost = [live < s.w ? `writes (W = ${s.w})` : '', live < s.r ? `reads (R = ${s.r})` : ''].filter(Boolean);
  rec.step(
    `${rn(i)} goes down: it stops answering, but everything on its disk stays. ${plural(live, 'replica is', 'replicas are')} still up. ` +
      (lost.length ? `That is too few for ${list(lost)}, which will now fail.` : `That is enough for W = ${s.w} and R = ${s.r}, so reads and writes carry on.`),
  );
  return true;
}

/** Bring a replica back. It returns with exactly what it held. */
export function up(s: QuorumState, replica: number, rec: Rec): boolean {
  rec.line('start');
  if (!validReplica(s, replica)) {
    rec.step(`There are ${s.n} replicas, R1 to R${s.n}. There is no R${replica}.`);
    return false;
  }
  const i = replica - 1;
  if (s.up[i]) {
    rec.step(`${rn(i)} is already up.`);
    return false;
  }
  s.up[i] = true;
  const behind = s.keys.filter((k) => copyOf(s, i, k).version < newestVersion(s, k));
  for (const k of behind) rec.mark(cid(i, k), 'bad');
  rec.step(
    `${rn(i)} is back, holding exactly what it held when it went down. ` +
      (behind.length
        ? `It missed the writes to ${list(behind.map(String))}, so ${behind.length === 1 ? 'that copy is' : 'those copies are'} stale (red, dashed). The page can see that; ${rn(i)} cannot. It stays stale until a read repairs it, anti-entropy runs, or a hint is replayed.`
        : `Nothing was written while it was away, so it is up to date.`),
  );
  return true;
}

/** Anti-entropy between two replicas: copy the newer version of every key each way. Returns copies made. */
export function repair(s: QuorumState, a: number, b: number, rec: Rec): number {
  rec.line('each_key');
  if (!validReplica(s, a) || !validReplica(s, b)) {
    rec.step(`There are ${s.n} replicas, R1 to R${s.n}. Choose two of them.`);
    return 0;
  }
  if (a === b) {
    rec.step(`A replica cannot repair against itself. Choose two different replicas.`);
    return 0;
  }
  const i = a - 1;
  const j = b - 1;
  const downs = [i, j].filter((x) => !s.up[x]);
  if (downs.length) {
    rec.step(`${list(downs.map(rn))} ${downs.length === 1 ? 'is' : 'are'} down. Anti-entropy needs both replicas up.`);
    return 0;
  }
  rec.step(
    `Anti-entropy between ${rn(i)} and ${rn(j)}: walk the keys and compare versions, copying the newer one across. It runs in the background, on a schedule, whether or not anyone reads.`,
  );
  let copied = 0;
  for (const key of s.keys) {
    const ca = copyOf(s, i, key);
    const cb = copyOf(s, j, key);
    const probe: Probe = { text: String(key), at: cid(i, key) };
    rec.mark(kid(key), 'key');
    rec.mark(cid(i, key), 'compare');
    rec.mark(cid(j, key), 'compare');
    rec.line('compare');
    const op = ca.version < cb.version ? '<' : ca.version > cb.version ? '>' : '=';
    const [from, to, src] = op === '<' ? [j, i, cb] : [i, j, ca];
    rec.compare(`${rn(i)} ${vn(ca)}`, op, `${rn(j)} ${vn(cb)}`, op === '=' ? 'in sync' : `copy ${rn(from)}'s to ${rn(to)}`, { probe });
    if (op !== '=') {
      s.data[to][key] = { ...src };
      copied++;
      rec.count('writes');
      rec.count('repairs');
      rec.mark(cid(to, key), 'ok');
      rec.mark(cid(from, key), 'path');
      rec.line('copy');
      rec.step(`${rn(to)} now holds ${show(key, src)}, the same as ${rn(from)}.`, { probe: { text: String(key), at: cid(to, key) } });
    } else {
      rec.mark(cid(i, key), 'path');
      rec.mark(cid(j, key), 'path');
    }
    rec.unmark(kid(key));
  }
  rec.line('each_key');
  rec.step(
    `Repair done: ${plural(s.keys.length, 'key')} compared, ${plural(copied, 'copy', 'copies')} made. A real store does not compare key by key: each replica builds a Merkle tree, a tree of hashes over ranges of keys. Equal hashes prove a range matches, so only ranges whose hashes differ are walked and sent.`,
  );
  return copied;
}

/** Change W and R. Returns whether R + W > N. */
export function tune(s: QuorumState, w: number, r: number, rec: Rec): boolean {
  rec.line('set');
  const ok = (x: number) => Number.isInteger(x) && x >= 1 && x <= s.n;
  if (!ok(w) || !ok(r)) {
    rec.step(`W and R must each be from 1 to N = ${s.n}.`);
    return s.r + s.w > s.n;
  }
  s.w = w;
  s.r = r;
  rec.markCell(CONFIG, W_CELL, 'ok');
  rec.markCell(CONFIG, R_CELL, 'ok');
  rec.step(
    `Set W = ${w} and R = ${r}. Nothing on the replicas changes: these numbers only say how many replies the coordinator waits for. Cassandra calls this the consistency level, and a client picks it per request.`,
  );
  const strong = r + w > s.n;
  rec.markCell(CONFIG, W_CELL, 'compare');
  rec.markCell(CONFIG, R_CELL, 'compare');
  rec.line('rule');
  rec.compare(`R + W = ${r + w}`, strong ? '>' : '≤', `N ${s.n}`, strong ? 'every read quorum overlaps every write quorum' : 'quorums need not overlap', {
    message: strong
      ? `${r} + ${w} = ${r + w}, more than ${s.n}. Any ${r} replicas and any ${w} replicas must share at least ${r + w - s.n}, so a read's replies include a replica that took the last successful write.` +
        (w === s.n ? ` But W = N: one replica down and every write fails.` : r === s.n ? ` But R = N: one replica down and every read fails.` : ``)
      : `${r} + ${w} = ${r + w}, not more than ${s.n}. A read can be answered entirely by replicas the last write never reached, so it can return an older value. In exchange, each request waits for fewer replies and survives more replicas being down.`,
  });
  return strong;
}

// ---- layout -----------------------------------------------------------------------

const VAL_W = 52;
const VER_W = 48;
export const NODE_W = TRAY_PAD * 2 + VAL_W + CELL_GAP + VER_W;
const PITCH = NODE_W + 12;
const KEY_W = 52;
const X0 = KEY_W + 18;
const CFG_W = 54;
const CLIENT_Y = 0;
const HEAD_Y = 76;
const ROW_Y0 = 160;
/** Each row keeps 44 units clear above it for the probe chip. */
const ROW_PITCH = 88;
const colX = (i: number) => X0 + NODE_W / 2 + i * PITCH;
const rowY = (k: number) => ROW_Y0 + k * ROW_PITCH;

export function layout(s: QuorumState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  nodes.push({
    id: CONFIG,
    x: (TRAY_PAD * 2 + CELL_GAP * 2 + CFG_W * 3) / 2,
    y: CLIENT_Y,
    cells: [
      { text: `N ${s.n}`, w: CFG_W },
      { text: `W ${s.w}`, w: CFG_W },
      { text: `R ${s.r}`, w: CFG_W },
    ],
  });
  nodes.push({ id: CLIENT, x: colX(s.n === 3 ? 1 : 2), y: CLIENT_Y, cells: [{ text: 'client' }] });

  for (let i = 0; i < s.n; i++) {
    const x = colX(i);
    nodes.push({ id: hid(i), x, y: HEAD_Y, cells: [{ text: s.up[i] ? rn(i) : `${rn(i)} down`, w: NODE_W }], tone: s.up[i] ? undefined : 'bad' });
    edges.push({ id: eid(i), from: CLIENT, to: hid(i), kind: 'line', arrow: true, dashed: !s.up[i] });
    s.keys.forEach((key, k) => {
      const c = copyOf(s, i, key);
      nodes.push({
        id: cid(i, key),
        x,
        y: rowY(k),
        cells: [
          { text: c.version ? String(c.value) : '', w: VAL_W },
          { text: c.version ? vn(c) : '', w: VER_W },
        ],
        tone: s.up[i] ? undefined : 'dim',
      });
    });
  }
  s.keys.forEach((key, k) => nodes.push({ id: kid(key), x: KEY_W / 2, y: rowY(k), cells: [{ text: String(key), w: KEY_W }] }));
  decor.push({ id: 'key-label', type: 'label', x: KEY_W / 2, y: HEAD_Y, text: 'key', anchor: 'middle', strong: true });
  // An empty label pins the bottom right, so the scene keeps its size as keys are added.
  decor.push({ id: 'corner', type: 'label', x: colX(s.n - 1) + NODE_W / 2, y: rowY(MAX_KEYS - 1) + 22 - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;
const REPLICA = { name: 'replica', label: 'Replica (1 to N)', kind: 'int', min: 1, max: 5 } as const;

/** A replica that holds an older copy of some key, if one is up. */
function staleUp(s: QuorumState): { i: number; key: number } | null {
  for (const key of s.keys) {
    const top = newestVersion(s, key);
    for (let i = 0; i < s.n; i++) if (s.up[i] && copyOf(s, i, key).version < top) return { i, key };
  }
  return null;
}

function suggestRead(s: QuorumState): [number, number] {
  const st = staleUp(s);
  if (st && randomInt(0, 3) > 0) return [st.key, st.i + 1];
  const key = s.keys.length ? s.keys[randomInt(0, s.keys.length - 1)] : 42;
  return [key, randomInt(1, s.n)];
}

function suggestWrite(s: QuorumState): [number, number] {
  const key = s.keys.length >= MAX_KEYS || (s.keys.length && randomInt(0, 2) > 0) ? s.keys[randomInt(0, s.keys.length - 1)] : randomInt(1, 99);
  return [key, randomInt(1, 99)];
}

function suggestRepair(s: QuorumState): [number, number] {
  const st = staleUp(s);
  const live = s.up.flatMap((u, i) => (u ? [i] : []));
  if (st) {
    const peer = live.find((j) => j !== st.i && copyOf(s, j, st.key).version > copyOf(s, st.i, st.key).version);
    if (peer !== undefined) return [st.i + 1, peer + 1];
  }
  if (live.length >= 2) return [live[0] + 1, live[1] + 1];
  return [1, 2];
}

/** Down when most are up, up when one is down. */
function suggestToggle(s: QuorumState, wantUp: boolean): number {
  const pick = s.up.flatMap((u, i) => (u === wantUp ? [i + 1] : []));
  return pick.length ? pick[randomInt(0, pick.length - 1)] : 1;
}

const def: StructureDef<QuorumState> = {
  id: 'quorum',
  params: [
    { id: 'n', label: 'Replicas (N)', default: 3, options: SIZES.map((v) => ({ value: v, label: String(v) })) },
    { id: 'w', label: 'Write quorum (W)', default: 2, options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })) },
    { id: 'r', label: 'Read quorum (R)', default: 2, options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })) },
  ],
  create: (params) => create(params.n ?? 3, params.w ?? 2, params.r ?? 2),
  // Three keys on every replica. Then R3 misses two writes while it is down and comes back stale,
  // and R2 goes down, so the tour starts with one replica down and another one behind.
  seed: [
    ['write', 42, 10],
    ['write', 17, 20],
    ['write', 5, 30],
    ['down', 3],
    ['write', 17, 21],
    ['write', 5, 31],
    ['up', 3],
    ['down', 2],
  ],
  ops: [
    {
      id: 'write',
      label: 'Write',
      intent: 'primary',
      args: [KEY, { name: 'value', label: 'Value', kind: 'int', min: 0, max: 999 }],
      code: ['write'],
      run: (s, [k, v], rec) => void write(s, Number(k), Number(v), rec),
      suggest: (s) => suggestWrite(s),
    },
    {
      id: 'read',
      label: 'Read',
      intent: 'primary',
      args: [KEY, { name: 'first', label: 'First to answer (1 to N)', kind: 'int', min: 1, max: 5 }],
      code: ['read'],
      run: (s, [k, f], rec) => void read(s, Number(k), Number(f), rec),
      suggest: (s) => suggestRead(s),
    },
    { id: 'down', label: 'Down', intent: 'danger', args: [REPLICA], code: ['down'], run: (s, [i], rec) => void down(s, Number(i), rec), suggest: (s) => [suggestToggle(s, true)] },
    { id: 'up', label: 'Up', args: [REPLICA], code: ['up'], run: (s, [i], rec) => void up(s, Number(i), rec), suggest: (s) => [suggestToggle(s, false)] },
    {
      id: 'repair',
      label: 'Anti-entropy',
      args: [REPLICA, { name: 'peer', label: 'Peer (1 to N)', kind: 'int', min: 1, max: 5 }],
      code: ['repair'],
      run: (s, [a, b], rec) => void repair(s, Number(a), Number(b), rec),
      suggest: (s) => suggestRepair(s),
    },
    {
      id: 'tune',
      label: 'Set W and R',
      args: [
        { name: 'w', label: 'W', kind: 'int', min: 1, max: 5 },
        { name: 'r', label: 'R', kind: 'int', min: 1, max: 5 },
      ],
      code: ['tune'],
      run: (s, [w, r], rec) => void tune(s, Number(w), Number(r), rec),
      suggest: (s) => (s.r + s.w > s.n ? [1, 1] : [Math.floor(s.n / 2) + 1, Math.floor(s.n / 2) + 1]),
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Replies used' },
    { key: 'writes', label: 'Copies written' },
    { key: 'stale', label: 'Stale reads' },
    { key: 'failed', label: 'Failed requests' },
  ],
  status: (s) => [
    { label: 'Quorums', value: `N ${s.n}, W ${s.w}, R ${s.r}` },
    { label: 'R + W > N', value: s.r + s.w > s.n ? `yes, ${s.r + s.w} > ${s.n}` : `no, ${s.r + s.w} ≤ ${s.n}` },
    { label: 'Replicas up', value: `${upCount(s)} of ${s.n}` },
    { label: 'Stale copies', value: String(staleCopies(s)) },
  ],
  tour: [
    ['write', 42, 11],
    ['read', 17, 3],
    ['tune', 1, 1],
    ['read', 5, 3],
    ['tune', 2, 2],
    ['down', 1],
    ['write', 42, 12],
  ],
  source: { python, java },
  info,
};

export default def;
