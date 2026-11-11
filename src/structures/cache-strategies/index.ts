import { LABEL_MAX } from '../../core/fit';
import { CELL_H, TRAY_PAD } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/CacheStrategies.java?raw';
import python from './code/cache_strategies.py?raw';
import { info } from './info';

/**
 * A cache in front of a database, and the rule that keeps them in step.
 *
 * The database holds four rows, each a value and a version that goes up by
 * one on every database write. The cache holds copies of some of them, each
 * with the version it was copied from and the tick at which it expires.
 * Comparing the two versions is how the page spots a stale read; a real
 * application cannot see both sides, which is the whole problem.
 *
 * Write-behind keeps a queue of writes the database has not seen yet. A
 * cache entry with a queued write is pinned (`expires` is null) until a flush
 * saves it, so the cache never drops the only copy of a write by expiry.
 *
 * `clients` and `lock` are the page's own props for the race and the
 * stampede, which script several clients at once. `ghost` is a key that is
 * not in the database, drawn in a spare row while a read of it is shown.
 */
export type Strategy = 'cache-aside' | 'write-through' | 'write-behind' | 'write-around';
export const STRATEGIES: Strategy[] = ['cache-aside', 'write-through', 'write-behind', 'write-around'];

export interface Row {
  value: number;
  version: number;
}

export interface Entry {
  value: number;
  version: number;
  /** The tick at which it expires, or null while a queued write pins it. */
  expires: number | null;
}

export interface Pending {
  key: number;
  value: number;
  version: number;
}

export interface Client {
  id: string;
  name: string;
  note?: string;
}

export interface CacheState {
  strategy: Strategy;
  ttl: number;
  now: number;
  /** The database's keys, in drawn order. */
  keys: number[];
  db: Map<number, Row>;
  cache: Map<number, Entry>;
  /** Write-behind queue, oldest first. One entry per key: a second write replaces the first. */
  queue: Pending[];
  clients: Client[];
  lock: { key: number; holder: string } | null;
  ghost: number | null;
  /** Totals since the page was built, for the status line. */
  hits: number;
  misses: number;
  stale: number;
  lost: number;
}

export const KEYS = [12, 27, 42, 63];
const START_VALUES = [50, 80, 250, 75];
export const TTL = 6;
export const MAX_TICK = 999;
export const READERS = 4;
const APP: Client[] = [{ id: 'app', name: 'app' }];

export function create(strategy: Strategy = 'cache-aside', ttl = TTL): CacheState {
  const db = new Map<number, Row>();
  KEYS.forEach((k, i) => db.set(k, { value: START_VALUES[i], version: 1 }));
  return {
    strategy,
    ttl,
    now: 0,
    keys: [...KEYS],
    db,
    cache: new Map(),
    queue: [],
    clients: APP.map((c) => ({ ...c })),
    lock: null,
    ghost: null,
    hits: 0,
    misses: 0,
    stale: 0,
    lost: 0,
  };
}

export function parseStrategy(raw: number | string): Strategy | null {
  const w = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (['cache-aside', 'aside', 'lazy', 'look-aside'].includes(w)) return 'cache-aside';
  if (['write-through', 'through'].includes(w)) return 'write-through';
  if (['write-behind', 'behind', 'write-back', 'back'].includes(w)) return 'write-behind';
  if (['write-around', 'around'].includes(w)) return 'write-around';
  return null;
}

// ---- ids, probes and words ----------------------------------------------------

const cid = (k: number) => `c${k}`;
const did = (k: number) => `d${k}`;
const qid = (k: number) => `q${k}`;
const clientId = (c: Client) => `cl-${c.id}`;

const atCache = (k: number): Probe => ({ text: String(k), at: cid(k), place: 'right' });
const atDb = (k: number): Probe => ({ text: String(k), at: did(k), place: 'left' });
const atQueue = (k: number): Probe => ({ text: String(k), at: qid(k), place: 'left' });
const atClient = (k: number, c: Client): Probe => ({ text: String(k), at: clientId(c) });

const vv = (r: { value: number; version: number }) => `${r.value} v${r.version}`;
const ticks = (n: number) => `${n} ${n === 1 ? 'tick' : 'ticks'}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const keyList = () => listOf(KEYS.map(String));

function setNote(s: CacheState, id: string, note: string | undefined): void {
  const c = s.clients.find((x) => x.id === id);
  if (c) c.note = note;
}

function dbWrite(s: CacheState, key: number, value: number, rec: Rec): number {
  const row = s.db.get(key)!;
  const version = row.version + 1;
  s.db.set(key, { value, version });
  rec.count('writes');
  return version;
}

function fill(s: CacheState, key: number, row: Row): Entry {
  const e: Entry = { value: row.value, version: row.version, expires: s.now + s.ttl };
  s.cache.set(key, e);
  return e;
}

/** Each operation starts from the plain picture: one app, no lock, no spare row. */
function begin(s: CacheState): void {
  s.ghost = null;
  s.lock = null;
  s.clients = APP.map((c) => ({ ...c }));
}

const STRATEGY_SAYS: Record<Strategy, string> = {
  'cache-aside': 'The application talks to both. A read that misses loads the database and fills the cache. A write goes to the database and then deletes the cached copy.',
  'write-through': 'A write goes to the database and the cache together, and the client waits for both. Reads are served as before.',
  'write-behind': 'A write goes to the cache and a queue, and the client is answered at once. The database catches up when the queue is flushed.',
  'write-around': 'A write goes to the database only. A cached copy is left alone until its TTL runs out.',
};

// ---- operations ---------------------------------------------------------------

/** Read a key: a hit, or a miss that loads the database and fills the cache. Returns the value, or null. */
export function read(s: CacheState, raw: number, rec: Rec): number | null {
  begin(s);
  const key = Math.floor(raw);
  if (!s.db.has(key)) s.ghost = key;
  const e = s.cache.get(key);
  rec.mark(cid(key), 'compare');
  rec.line('lookup');
  if (e) {
    rec.compare(`cache[${key}]`, '≠', 'none', 'hit, serve it from the cache', {
      probe: atCache(key),
      message:
        `Look up ${key} in the cache. It is there` +
        (e.expires === null ? `, pinned by a queued write.` : `, with ${ticks(e.expires - s.now)} left to live.`) +
        ` A hit: the database is not asked.`,
    });
    rec.count('hits');
    s.hits++;
    rec.mark(cid(key), 'key');
    const row = s.db.get(key)!;
    rec.line('hit');
    if (e.version < row.version) {
      rec.count('stale');
      s.stale++;
      rec.markCell(cid(key), 2, 'bad');
      rec.compare(`cache v${e.version}`, '<', `db v${row.version}`, 'stale read', {
        probe: atCache(key),
        message: `Served ${e.value}, but the database holds ${vv(row)}. This is a stale read, and the application cannot tell: only this page sees both sides. It stays wrong until the entry expires at tick ${e.expires}.`,
      });
    } else if (e.version === row.version) {
      rec.compare(`cache v${e.version}`, '=', `db v${row.version}`, 'fresh', {
        probe: atCache(key),
        message: `Served ${vv(e)}, the version the database holds. Cost: 1 cache read and no database read. That is the whole point of a cache.`,
      });
    } else {
      rec.compare(`cache v${e.version}`, '>', `db v${row.version}`, 'newer than the database', {
        probe: atCache(key),
        message: `Served ${vv(e)}. The database still holds ${vv(row)}: the newer write is waiting in the write-behind queue, and the cache holds the only copy of it.`,
      });
    }
    return e.value;
  }

  rec.compare(`cache[${key}]`, '=', 'none', 'miss, read the database', {
    probe: atCache(key),
    message: `Look up ${key} in the cache. It is not there: a miss.`,
  });
  rec.count('misses');
  s.misses++;
  rec.mark(cid(key), 'bad');
  rec.count('reads');
  rec.mark(did(key), 'key');
  const row = s.db.get(key);
  if (!row) {
    rec.line('miss', 'db_read', 'absent');
    rec.step(
      `The database has no row for ${key} either, so there is nothing to cache. Every read of ${key} will miss and reach the database. Once is fine. A flood of reads for keys that do not exist is cache penetration: cache the "none" for a short TTL, or check a Bloom filter of real keys first.`,
      { probe: atDb(key) },
    );
    return null;
  }
  rec.line('miss', 'db_read');
  rec.step(`Read ${key} from the database: ${vv(row)}.`, { probe: atDb(key) });
  rec.unmark(did(key));
  const e2 = fill(s, key, row);
  rec.mark(cid(key), 'key');
  rec.markCell(cid(key), 3, 'ok');
  rec.line('fill');
  rec.step(
    `Fill the cache: ${key} = ${vv(row)}, expiring at tick ${e2.expires}, ${ticks(s.ttl)} from now. The next read is a hit. This miss cost 1 cache read, 1 database read and 1 cache write.`,
    { probe: atCache(key) },
  );
  return row.value;
}

/** Write a key under the current strategy. Returns false when the key is not in the database. */
export function write(s: CacheState, rawKey: number, rawValue: number, rec: Rec): boolean {
  begin(s);
  const key = Math.floor(rawKey);
  const value = Math.max(0, Math.min(999, Math.floor(rawValue)));
  rec.line('write');
  if (!s.db.has(key)) {
    rec.step(`This page's database has four rows: ${keyList()}. Write to one of those.`);
    return false;
  }
  const before = { ...s.db.get(key)! };

  if (s.strategy === 'cache-aside') {
    const version = dbWrite(s, key, value, rec);
    rec.mark(did(key), 'key');
    rec.line('aside_db', 'db_write');
    rec.step(`Cache-aside: the application writes the database first. ${key} goes from ${vv(before)} to ${value} v${version}.`, { probe: atDb(key) });
    rec.unmark(did(key));
    const e = s.cache.get(key);
    rec.line('aside_delete');
    if (e) {
      rec.mark(cid(key), 'bad');
      rec.step(
        `Then delete ${key} from the cache. It held ${vv(e)}, which is now out of date. Delete it, do not overwrite it: the next read will miss and load the new value from the database.`,
        { probe: atCache(key) },
      );
      s.cache.delete(key);
      rec.unmark(cid(key));
    } else {
      rec.mark(cid(key), 'key');
      rec.step(
        `Then delete ${key} from the cache. There is no entry, so the delete does nothing. It is cheap and always safe, so the application never needs to check first.`,
        { probe: atCache(key) },
      );
      rec.unmark(cid(key));
    }
    rec.mark(did(key), 'ok');
    rec.line('ack');
    rec.step(
      `Done: 1 database write and 1 cache delete. The cache never holds a value the database does not, and the next read of ${key} misses once and loads ${value} v${version}.`,
      { probe: atDb(key) },
    );
    return true;
  }

  if (s.strategy === 'write-through') {
    const version = dbWrite(s, key, value, rec);
    rec.mark(did(key), 'key');
    rec.line('through_db', 'db_write');
    rec.step(`Write-through: the cache writes the database as part of the request. ${key} goes from ${vv(before)} to ${value} v${version}.`, { probe: atDb(key) });
    rec.mark(did(key), 'ok');
    const e = fill(s, key, { value, version });
    rec.mark(cid(key), 'key');
    rec.markCell(cid(key), 3, 'ok');
    rec.line('through_cache');
    rec.step(`And it stores the same value itself: ${key} = ${value} v${version}, expiring at tick ${e.expires}.`, { probe: atCache(key) });
    rec.line('ack');
    rec.step(
      `Only now is the client answered. The write paid for 2 writes and waited for the slower one, but cache and database agree and the next read of ${key} is a hit. A key that is written and never read still takes cache space.`,
      { probe: atCache(key) },
    );
    return true;
  }

  if (s.strategy === 'write-behind') {
    const queued = s.queue.find((p) => p.key === key);
    const version = (queued ? queued.version : before.version) + 1;
    s.cache.set(key, { value, version, expires: null });
    rec.mark(cid(key), 'key');
    rec.line('behind_cache', 'next_version');
    rec.step(
      `Write-behind: the write goes to the cache only. ${key} = ${value} v${version}, pinned so it cannot expire before it is saved.`,
      { probe: atCache(key) },
    );
    rec.unmark(cid(key));
    rec.line('behind_queue');
    if (queued) {
      const was = vv(queued);
      queued.value = value;
      queued.version = version;
      rec.mark(qid(key), 'key');
      rec.compare(`queue[${key}]`, '≠', 'none', 'replace it: two writes become one', {
        probe: atQueue(key),
        message: `${key} already has a queued write, ${was}. Replace it with ${value} v${version}: the database will only ever see the latest. Coalescing like this is one reason write-behind copes with heavy write loads.`,
      });
    } else {
      s.queue.push({ key, value, version });
      rec.mark(qid(key), 'key');
      rec.compare(`queue[${key}]`, '=', 'none', 'add it to the queue', {
        probe: atQueue(key),
        message: `Add ${key} = ${value} v${version} to the queue of writes the database has not seen.`,
      });
    }
    rec.line('ack');
    rec.step(
      `Answer the client now, after 0 database writes. The database still says ${vv(before)}. The write was fast, but until a flush its only copy is in the cache's memory.`,
      { probe: atQueue(key) },
    );
    return true;
  }

  // write-around
  const version = dbWrite(s, key, value, rec);
  rec.mark(did(key), 'key');
  rec.line('around_db', 'db_write');
  rec.step(`Write-around: the write goes to the database only. ${key} goes from ${vv(before)} to ${value} v${version}.`, { probe: atDb(key) });
  rec.unmark(did(key));
  const e = s.cache.get(key);
  rec.line('around_keep');
  if (e && e.expires !== null) {
    rec.mark(cid(key), 'key');
    rec.markCell(cid(key), 2, 'bad');
    rec.compare(`cache v${e.version}`, '<', `db v${version}`, `stale until tick ${e.expires}`, {
      probe: atCache(key),
      message: `The cache still holds ${vv(e)} and nothing removes it. Reads get this old value until it expires at tick ${e.expires}, ${ticks(e.expires - s.now)} from now. The TTL is the only bound.`,
    });
  } else {
    rec.mark(cid(key), 'key');
    rec.step(
      `${key} is not cached, so nothing can go stale. The next read misses and loads the new value. Data that is written once and seldom read never takes cache space: that is what write-around is for.`,
      { probe: atCache(key) },
    );
  }
  rec.unmark(cid(key));
  rec.mark(did(key), 'ok');
  rec.line('ack');
  rec.step(
    `Done: 1 database write and no cache work.` +
      (e ? ` Good for logs and bulk loads; a poor fit when a key is read straight after it is written.` : ``),
    { probe: atDb(key) },
  );
  return true;
}

/** Drain the queue into the database. Shared by Flush and by a change of strategy. */
function drain(s: CacheState, rec: Rec): number {
  const n = s.queue.length;
  for (const p of s.queue) {
    s.db.set(p.key, { value: p.value, version: p.version });
    rec.count('writes');
    rec.mark(qid(p.key), 'key');
    rec.mark(did(p.key), 'ok');
    rec.line('drain', 'flush_write');
    rec.step(`Write ${p.key} = ${p.value} v${p.version} to the database.`, { probe: atQueue(p.key) });
    const e = s.cache.get(p.key)!;
    e.expires = s.now + s.ttl;
    rec.mark(cid(p.key), 'key');
    rec.markCell(cid(p.key), 3, 'ok');
    rec.line('unpin');
    rec.step(`${p.key} is saved, so its cache entry gets a normal TTL and expires at tick ${e.expires}.`, { probe: atCache(p.key) });
    rec.unmark(cid(p.key));
    rec.mark(qid(p.key), 'ok');
  }
  s.queue = [];
  rec.line('flushed');
  rec.step(`Flushed: ${plural(n, 'database write')} in one batch. Cache and database agree again.`);
  return n;
}

/** Send every queued write to the database. Returns how many went. */
export function flush(s: CacheState, rec: Rec): number {
  begin(s);
  rec.line('drain');
  if (!s.queue.length) {
    rec.step(
      s.strategy === 'write-behind'
        ? `The queue is empty: every write has reached the database.`
        : `The queue is empty. Only write-behind queues writes; under ${s.strategy} every write reaches the database before the client is answered.`,
    );
    return 0;
  }
  rec.step(
    `Flush: send the ${plural(s.queue.length, 'queued write')} to the database, oldest first. A real write-behind cache does this on a timer or when a batch fills; here you press Flush.`,
  );
  return drain(s, rec);
}

/** The cache loses everything it held. Under write-behind, queued writes go with it. Returns how many writes were lost. */
export function crashCache(s: CacheState, rec: Rec): number {
  begin(s);
  const lost = [...s.queue];
  const first = lost[0];
  for (const k of s.cache.keys()) rec.mark(cid(k), 'bad');
  for (const p of lost) rec.mark(qid(p.key), 'bad');
  rec.line('wipe');
  rec.step(
    `The cache process dies. Everything it held in memory is gone: ${plural(s.cache.size, 'entry', 'entries')}` +
      (lost.length ? ` and ${plural(lost.length, 'queued write')}.` : `.`),
    first ? { probe: atQueue(first.key) } : {},
  );
  if (lost.length) {
    rec.count('lost', lost.length);
    s.lost += lost.length;
    rec.line('lost');
    const said = lost.map((p) => `${p.key} = ${p.value}`);
    const has = lost.map((p) => `${p.key} = ${s.db.get(p.key)!.value}`);
    rec.step(
      `The queued ${lost.length === 1 ? 'write is' : 'writes are'} lost: ${listOf(said)}. ${lost.length === 1 ? 'The client was told its write succeeded' : 'Each client was told its write succeeded'}, but the database still holds ${listOf(has)}. A write-behind write is only as safe as the cache it waits in, unless the queue itself is durable.`,
      { probe: atQueue(first.key) },
    );
  }
  s.cache.clear();
  s.queue = [];
  rec.clearMarks();
  rec.line('cold');
  if (first) {
    rec.mark(did(first.key), 'key');
    rec.step(
      `The cache restarts empty. A read of ${first.key} now misses and gets ${vv(s.db.get(first.key)!)} from the database, not the ${first.value} the client wrote. Until the cache warms up, every read misses and the database takes the full load.`,
      { probe: atDb(first.key) },
    );
  } else {
    rec.step(
      `The cache restarts empty. Nothing was lost: under ${s.strategy} the database already had every write. But every read misses until the cache warms up, so the database takes the full load for a while: a cold start.`,
    );
  }
  return lost.length;
}

/** Advance the clock; entries whose time is up are dropped. Returns false at the page's clock limit. */
export function tick(s: CacheState, k: number, rec: Rec): boolean {
  begin(s);
  const n = Math.max(1, Math.floor(k));
  rec.line('tick');
  if (s.now + n > MAX_TICK) {
    rec.step(`Sorry, this page's clock stops at tick ${MAX_TICK} so the numbers stay readable, and it reads ${s.now}. Reload the page to start again.`);
    return false;
  }
  const from = s.now;
  s.now += n;
  rec.step(`Advance the clock by ${ticks(n)}, from ${from} to ${s.now}. Each cache entry is checked against its expiry time.`);
  const gone = [...s.cache.entries()].filter(([, e]) => e.expires !== null && e.expires <= s.now).map(([key]) => key);
  if (!gone.length) {
    rec.line('expire_scan', 'expire_test');
    const pinned = [...s.cache.values()].some((e) => e.expires === null);
    rec.step(
      s.cache.size
        ? `No entry has reached its expiry time, so every cached value stays.` + (pinned ? ` Pinned entries never expire: their writes are still queued.` : ``)
        : `The cache is empty, so nothing can expire.`,
    );
    return true;
  }
  for (const key of gone) rec.mark(cid(key), 'bad');
  rec.line('expire_test', 'expire');
  rec.step(
    `${listOf(gone.map(String))} ${gone.length === 1 ? 'has' : 'have'} reached ${gone.length === 1 ? 'its' : 'their'} expiry time and ${gone.length === 1 ? 'is' : 'are'} dropped. The next read of ${gone.length === 1 ? 'it' : 'each'} misses and loads a fresh copy from the database.`,
  );
  for (const key of gone) {
    s.cache.delete(key);
    rec.unmark(cid(key));
  }
  rec.line('expire_scan');
  rec.step(`${plural(s.cache.size, 'entry', 'entries')} left in the cache. A TTL is how long you are willing to serve a value that might be out of date.`);
  return true;
}

/** Change the strategy. Queued writes are flushed first so none is stranded. */
export function setStrategy(s: CacheState, raw: number | string, rec: Rec): boolean {
  begin(s);
  const next = parseStrategy(raw);
  rec.line('switch');
  if (!next) {
    rec.step(`Enter cache-aside, write-through, write-behind or write-around.`);
    return false;
  }
  if (s.queue.length) {
    rec.line('switch_flush');
    rec.step(`${plural(s.queue.length, 'write is', 'writes are')} still queued. Flush them first, so no write is stranded in the cache.`);
    drain(s, rec);
  }
  const was = s.strategy;
  s.strategy = next;
  rec.line('switch');
  rec.step((was === next ? `The strategy is already ${next}. ` : `From now on: ${next}. `) + STRATEGY_SAYS[next]);
  return true;
}

/**
 * The classic cache-aside race, as a fixed interleaving of two clients. Reader
 * A misses and reads the old value; writer B updates the database and deletes
 * the key; A then fills the cache with the old value.
 */
export function race(s: CacheState, raw: number, rec: Rec): boolean {
  begin(s);
  const key = Math.floor(raw);
  rec.line('lookup');
  if (!s.db.has(key)) {
    rec.step(`This page's database has four rows: ${keyList()}. Race on one of those.`);
    return false;
  }
  const A: Client = { id: 'a', name: 'A', note: 'reader' };
  const B: Client = { id: 'b', name: 'B', note: 'writer' };
  s.clients = [A, B];
  const wasCached = s.cache.delete(key);
  rec.mark(clientId(A), 'path');
  rec.mark(cid(key), 'compare');
  rec.compare(`cache[${key}]`, '=', 'none', 'miss, read the database', {
    probe: atCache(key),
    message:
      (s.strategy === 'cache-aside' ? `` : `This race belongs to cache-aside, so the clients follow its rules here. `) +
      `Client A reads ${key}. It looks in the cache and misses${wasCached ? `: the entry has just expired` : ``}.`,
  });
  rec.count('misses');
  s.misses++;
  rec.mark(cid(key), 'bad');

  const old = { ...s.db.get(key)! };
  rec.count('reads');
  setNote(s, 'a', `has ${vv(old)}`);
  rec.mark(did(key), 'key');
  rec.line('miss', 'db_read');
  rec.step(`A reads the database and gets ${vv(old)}.`, { probe: atDb(key) });
  rec.unmark(did(key));

  rec.line('fill');
  rec.step(
    `Then A stalls just before it fills the cache: a garbage collection pause, a slow network, a busy thread. A few milliseconds is enough.`,
    { probe: atClient(key, A) },
  );

  rec.unmark(clientId(A));
  rec.mark(clientId(B), 'path');
  const fresh = (old.value + 10) % 1000;
  const version = dbWrite(s, key, fresh, rec);
  setNote(s, 'b', `wrote ${fresh} v${version}`);
  rec.mark(did(key), 'key');
  rec.line('aside_db', 'db_write');
  rec.step(`Meanwhile client B writes ${key} = ${fresh}, database first. The database now holds ${fresh} v${version}.`, { probe: atDb(key) });
  rec.mark(did(key), 'ok');

  rec.mark(cid(key), 'key');
  rec.line('aside_delete');
  rec.step(
    `B deletes ${key} from the cache, as cache-aside says. There is nothing to delete: A has not written its copy yet. B is finished and did everything right.`,
    { probe: atCache(key) },
  );

  rec.unmark(clientId(B));
  rec.mark(clientId(A), 'path');
  const e = fill(s, key, old);
  setNote(s, 'a', `filled ${vv(old)}`);
  rec.markCell(cid(key), 2, 'bad');
  rec.line('fill');
  rec.step(
    `A wakes and fills the cache with what it read: ${vv(old)}. That value was replaced while A slept. The cache now holds an old value, and nothing is coming to delete it.`,
    { probe: atCache(key) },
  );

  rec.unmark(clientId(A));
  rec.count('hits');
  rec.count('stale');
  s.hits++;
  s.stale++;
  rec.line('lookup', 'hit');
  rec.compare(`cache v${old.version}`, '<', `db v${version}`, 'stale read', {
    probe: atCache(key),
    message: `Any reader now hits the cache and gets ${old.value}, while the database holds ${fresh}. A stale read, and every read of ${key} gets the same wrong answer.`,
  });

  rec.markCell(cid(key), 3, 'compare');
  rec.line('fill');
  rec.step(
    `What bounds it is the TTL set on this line. The entry expires at tick ${e.expires}, and the next read then loads ${fresh}. With no TTL it would stay wrong until the next write to ${key}.`,
    { probe: atCache(key) },
  );
  rec.markCell(cid(key), 3, 'idle');

  rec.line('aside_delete');
  rec.step(
    `Why delete and not set? If writers set the cache, two of them could set it in the opposite order to their database writes, leaving the older value with no reader involved. A delete carries no value, so its order cannot matter.`,
    { probe: atCache(key) },
  );
  rec.line('fill');
  rec.step(
    `The fix is to make that late fill fail. Facebook's memcache gives a reader a lease on a miss and a delete cancels it, so A's fill is refused. Cost of this race: 1 miss, 1 database read, 1 database write, 1 stale read.`,
    { probe: atCache(key) },
  );
  return true;
}

/**
 * A hot key expires and several readers miss at once, then the same moment
 * with a lock per key so only one of them loads.
 */
export function stampede(s: CacheState, raw: number, rec: Rec): boolean {
  begin(s);
  const key = Math.floor(raw);
  rec.line('lookup');
  if (!s.db.has(key)) {
    rec.step(`This page's database has four rows: ${keyList()}. Pick one of those as the hot key.`);
    return false;
  }
  const readers: Client[] = Array.from({ length: READERS }, (_, i) => ({ id: `r${i + 1}`, name: `r${i + 1}` }));
  s.clients = readers;
  const row = s.db.get(key)!;
  const wasCached = s.cache.delete(key);
  rec.step(
    `${key} is a hot key. ${wasCached ? `Its entry has just expired` : `It is not in the cache`}, and ${READERS} requests for it arrive within the same few milliseconds, before any of them has an answer.`,
    { probe: atCache(key) },
  );

  // ---- without protection ----
  for (const r of readers) {
    rec.mark(clientId(r), 'path');
    rec.mark(cid(key), 'compare');
    rec.compare(`cache[${key}]`, '=', 'none', `${r.name} misses`, { probe: atCache(key), message: `${r.name} looks in the cache: a miss.` });
    rec.count('misses');
    s.misses++;
    r.note = 'missed';
  }
  rec.mark(cid(key), 'bad');
  for (const r of readers) r.note = 'reading db';
  rec.count('reads', READERS);
  rec.mark(did(key), 'key');
  rec.line('miss', 'db_read');
  rec.step(`All ${READERS} go to the database for the same row at the same moment: ${READERS} database reads for one value.`, { probe: atDb(key) });
  rec.unmark(did(key));
  fill(s, key, row);
  for (const r of readers) r.note = `has ${row.value}`;
  rec.mark(cid(key), 'key');
  rec.line('fill');
  rec.step(
    `Each one writes the same value back. Scale it up: at 10,000 reads a second and a 50 ms query, about 500 requests miss before the first answer returns, and all reach the database. That is a stampede, or thundering herd.`,
    { probe: atCache(key) },
  );

  // ---- with a lock per key ----
  for (const r of readers) {
    rec.unmark(clientId(r));
    r.note = undefined;
  }
  s.cache.delete(key);
  rec.unmark(cid(key));
  rec.line('first');
  rec.step(`Now the same moment again, with a lock per key. The entry expires again and the same ${READERS} requests arrive.`, { probe: atCache(key) });
  const [first, ...rest] = readers;
  rec.mark(clientId(first), 'path');
  rec.mark(cid(key), 'compare');
  rec.compare(`cache[${key}]`, '=', 'none', `${first.name} misses`, { probe: atCache(key), message: `${first.name} looks in the cache: a miss.` });
  rec.count('misses');
  s.misses++;
  s.lock = { key, holder: first.name };
  first.note = 'has lock';
  rec.line('lock');
  rec.step(`${first.name} takes the lock for ${key}. Only the holder may load it from the database.`, { probe: atCache(key) });
  rec.line('first');
  for (const r of rest) {
    rec.mark(clientId(r), 'path');
    rec.compare(`cache[${key}]`, '=', 'none', `${r.name} misses`, { probe: atCache(key), message: `${r.name} looks in the cache: a miss too.` });
    rec.count('misses');
    s.misses++;
    r.note = 'waiting';
  }
  rec.line('lock');
  rec.step(`${listOf(rest.map((r) => r.name))} find the lock held by ${first.name} and wait. None of them goes to the database.`, { probe: atCache(key) });

  rec.line('recheck');
  rec.compare(`cache[${key}]`, '=', 'none', 'still empty: load it', {
    probe: atCache(key),
    message: `${first.name} looks once more now that it holds the lock. Still empty, so it loads.`,
  });
  rec.count('reads');
  rec.mark(cid(key), 'bad');
  rec.mark(did(key), 'key');
  rec.line('load', 'db_read');
  rec.step(`${first.name} reads the database: 1 read, ${vv(row)}.`, { probe: atDb(key) });
  rec.unmark(did(key));
  fill(s, key, row);
  s.lock = null;
  first.note = `has ${row.value}`;
  rec.mark(cid(key), 'key');
  rec.markCell(cid(key), 3, 'ok');
  rec.line('fill');
  rec.step(`${first.name} fills the cache and releases the lock.`, { probe: atCache(key) });

  for (const r of rest) {
    rec.unmark(clientId(r));
    rec.mark(clientId(r), 'path');
    rec.line('recheck', 'waited');
    rec.compare(`cache[${key}]`, '≠', 'none', 'hit, no database read', {
      probe: atCache(key),
      message: `${r.name} gets the lock, looks again and finds the value ${first.name} loaded.`,
    });
    rec.count('hits');
    s.hits++;
    r.note = `has ${row.value}`;
  }
  rec.line('waited');
  rec.step(
    `Without the lock: ${READERS} database reads. With it: 1, while the other ${READERS - 1} waited about one query's time. Across servers the lock is a key in the shared cache, set only if absent, with a short expiry.`,
    { probe: atCache(key) },
  );
  return true;
}

// ---- layout -------------------------------------------------------------------

const KEY_W = 48;
const VAL_W = 56;
const VER_W = 56;
const TTL_W = 76;
const ROW_W = (cells: number[]) => TRAY_PAD * 2 + cells.reduce((a, b) => a + b, 0) + 3 * (cells.length - 1);
const CACHE_W = ROW_W([KEY_W, VAL_W, VER_W, TTL_W]);
const DB_W = ROW_W([KEY_W, VAL_W, VER_W]);
/** Room on the left for the lock tag. */
const CACHE_X0 = 92;
/** The gap between cache and database holds the chip, on whichever side it is. */
const DB_X0 = CACHE_X0 + CACHE_W + 110;
const Q_X0 = DB_X0 + DB_W + 84;
const RIGHT = Q_X0 + DB_W;
const CLIENT_Y = 0;
const HEAD_Y = 86;
const ROW_Y0 = 124;
const PITCH = 52;
const ROWS = KEYS.length + 1;
const rowY = (i: number) => ROW_Y0 + i * PITCH;
const TOP = CLIENT_Y - CELL_H / 2 - 44;
const BOTTOM = rowY(ROWS - 1) + CELL_H / 2 + TRAY_PAD;
const CLIENT_W = 56;

function clientXs(n: number): number[] {
  const cacheMid = CACHE_X0 + CACHE_W / 2;
  const dbMid = DB_X0 + DB_W / 2;
  if (n === 1) return [cacheMid];
  if (n === 2) return [cacheMid, dbMid];
  const pitch = 108;
  const x0 = (cacheMid + dbMid) / 2 - (pitch * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => x0 + i * pitch);
}

export function layout(s: CacheState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];

  // Clients across the top.
  const xs = clientXs(s.clients.length);
  s.clients.forEach((c, i) => {
    nodes.push({ id: clientId(c), x: xs[i], y: CLIENT_Y, cells: [{ text: c.name, w: CLIENT_W }], caption: c.note });
  });
  decor.push({ id: 'mode', type: 'label', x: Q_X0, y: CLIENT_Y - 8, text: `Strategy: ${s.strategy}\nClock: tick ${s.now}`, strong: true });

  decor.push({ id: 'h-cache', type: 'label', x: CACHE_X0, y: HEAD_Y, text: `Cache (TTL ${s.ttl} ticks)`, strong: true });
  decor.push({ id: 'h-db', type: 'label', x: DB_X0, y: HEAD_Y, text: 'Database', strong: true });
  decor.push({ id: 'h-queue', type: 'label', x: Q_X0, y: HEAD_Y, text: 'Write-behind queue', strong: true });

  const rows = s.ghost !== null && !s.db.has(s.ghost) ? [...s.keys, s.ghost] : s.keys;
  rows.forEach((key, i) => {
    const y = rowY(i);
    const e = s.cache.get(key);
    const cells: Cell[] = e
      ? [
          { text: String(key), w: KEY_W },
          { text: String(e.value), w: VAL_W },
          { text: `v${e.version}`, w: VER_W },
          { text: e.expires === null ? 'pinned' : `ttl ${e.expires - s.now}`, w: TTL_W },
        ]
      : [
          { text: String(key), w: KEY_W, tone: 'dim' },
          { text: '', w: VAL_W },
          { text: '', w: VER_W },
          { text: '', w: TTL_W },
        ];
    nodes.push({ id: cid(key), x: CACHE_X0 + CACHE_W / 2, y, cells });
    const row = s.db.get(key);
    nodes.push({
      id: did(key),
      x: DB_X0 + DB_W / 2,
      y,
      cells: row
        ? [
            { text: String(key), w: KEY_W },
            { text: String(row.value), w: VAL_W },
            { text: `v${row.version}`, w: VER_W },
          ]
        : [
            { text: String(key), w: KEY_W },
            { text: 'no row', w: VAL_W + VER_W + 3 },
          ],
    });
    if (s.lock && s.lock.key === key) nodes.push({ id: 'lock', x: CACHE_X0 / 2, y, cells: [{ text: `lock ${s.lock.holder}` }], shape: 'tag' });
  });

  s.queue.forEach((p, i) => {
    nodes.push({
      id: qid(p.key),
      x: Q_X0 + DB_W / 2,
      y: rowY(i),
      cells: [
        { text: String(p.key), w: KEY_W },
        { text: String(p.value), w: VAL_W },
        { text: `v${p.version}`, w: VER_W },
      ],
    });
  });
  if (!s.queue.length) {
    decor.push({
      id: 'q-empty',
      type: 'label',
      x: Q_X0,
      y: rowY(0) - 6,
      text: s.strategy === 'write-behind' ? 'Empty: nothing is\nwaiting to be saved' : `Empty. Only\nwrite-behind uses it`,
    });
  }

  // Two empty labels pin the corners, so the view keeps its size as rows and clients come and go.
  decor.push({ id: 'corner-a', type: 'label', x: 0, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------

export const STRATEGY_PARAM: Record<Strategy, number> = { 'cache-aside': 0, 'write-through': 1, 'write-behind': 2, 'write-around': 3 };
const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;
const VALUE = { name: 'value', label: 'Value', kind: 'int', min: 0, max: 999 } as const;

/** Mostly a key in the database, cached or not; now and then one that is not there. */
function suggestRead(s: CacheState): number {
  if (randomInt(0, 7) === 0) return pick([7, 99, 404]);
  const missing = s.keys.filter((k) => !s.cache.has(k));
  if (missing.length && randomInt(0, 1) === 0) return pick(missing);
  return pick(s.keys);
}

function suggestWrite(s: CacheState): [number, number] {
  const key = pick(s.keys);
  return [key, (s.db.get(key)!.value + randomInt(1, 9) * 10) % 1000];
}

const def: StructureDef<CacheState> = {
  id: 'cache-strategies',
  params: [
    {
      id: 'strategy',
      label: 'Strategy',
      default: STRATEGY_PARAM['cache-aside'],
      options: STRATEGIES.map((st) => ({ value: STRATEGY_PARAM[st], label: st })),
    },
  ],
  create: (params) => create(STRATEGIES[params.strategy ?? 0] ?? 'cache-aside'),
  // 42 has been written once, 12 and 63 are cached and two ticks old.
  seed: [['write', 42, 300], ['read', 12], ['read', 63], ['tick', 2]],
  ops: [
    { id: 'read', label: 'Read', intent: 'primary', args: [KEY], code: ['read', 'load'], run: (s, [k], rec) => void read(s, Number(k), rec), suggest: (s) => [suggestRead(s)] },
    {
      id: 'write',
      label: 'Write',
      args: [KEY, VALUE],
      code: ['write', 'db_write', 'next_version'],
      run: (s, [k, v], rec) => void write(s, Number(k), Number(v), rec),
      suggest: (s) => suggestWrite(s),
    },
    { id: 'flush', label: 'Flush queue', args: [], code: ['flush'], run: (s, _a, rec) => void flush(s, rec) },
    { id: 'race', label: 'Race', args: [KEY], code: ['read', 'load', 'write', 'db_write'], run: (s, [k], rec) => void race(s, Number(k), rec), suggest: (s) => [pick(s.keys)] },
    {
      id: 'stampede',
      label: 'Stampede',
      args: [KEY],
      code: ['read_locked', 'read', 'load'],
      run: (s, [k], rec) => void stampede(s, Number(k), rec),
      suggest: (s) => [pick(s.keys)],
    },
    {
      id: 'tick',
      label: 'Tick',
      args: [{ name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 }],
      code: ['tick'],
      run: (s, [k], rec) => void tick(s, Number(k), rec),
      suggest: (s) => [Math.max(1, Math.min(randomInt(1, 4), MAX_TICK - s.now))],
    },
    {
      id: 'strategy',
      label: 'Strategy',
      args: [{ name: 'strategy', label: 'cache-aside, write-through, write-behind or write-around', kind: 'word' }],
      code: ['strategy', 'flush'],
      run: (s, [w], rec) => void setStrategy(s, w, rec),
      suggest: (s) => [pick(STRATEGIES.filter((st) => st !== s.strategy))],
    },
    { id: 'crash_cache', label: 'Crash cache', intent: 'danger', args: [], code: ['crash'], run: (s, _a, rec) => void crashCache(s, rec) },
  ],
  layout,
  counters: [
    { key: 'hits', label: 'Cache hits' },
    { key: 'misses', label: 'Cache misses' },
    { key: 'reads', label: 'Database reads' },
    { key: 'writes', label: 'Database writes' },
    { key: 'stale', label: 'Stale reads' },
    { key: 'lost', label: 'Writes lost' },
  ],
  status: (s) => [
    { label: 'Strategy', value: s.strategy },
    { label: 'Clock', value: `tick ${s.now}` },
    { label: 'Cached', value: `${s.cache.size} of ${s.keys.length} keys` },
    { label: 'Queued writes', value: String(s.queue.length) },
  ],
  tour: [
    ['read', 42],
    ['read', 42],
    ['write', 42, 310],
    ['race', 42],
    ['stampede', 63],
    ['strategy', 'write-behind'],
    ['write', 42, 330],
    ['crash_cache'],
  ],
  source: { python, java },
  info,
};

export default def;
