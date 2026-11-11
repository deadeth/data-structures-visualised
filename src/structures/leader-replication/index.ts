import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/LeaderReplication.java?raw';
import python from './code/leader_replication.py?raw';
import { info } from './info';

/**
 * Single-leader replication with three replicas, A, B and C, and one client.
 *
 * Each replica keeps a log of entries. Entry i has log sequence number (LSN)
 * i + 1, and records the epoch of the leader that wrote it. A replica's
 * position is the LSN of the last entry it has applied, which here is simply
 * the length of its log. Followers' logs are always a prefix of the leader's.
 *
 * `mode` says whom the leader waits for before it answers a write: nobody
 * (async), one synchronous follower (semi-sync), or every follower (sync).
 * A held follower stands for a slow link or a busy follower: entries queue up
 * for it until it catches up.
 *
 * The client remembers `wrote`, the LSN of its own last write, and `seen`,
 * the highest position of any replica it has read from.
 */
export type Name = 'A' | 'B' | 'C';
export const NAMES: Name[] = ['A', 'B', 'C'];

export const ASYNC = 0;
export const SEMI = 1;
export const SYNC = 2;
export const MODE_NAMES = ['asynchronous', 'semi-synchronous', 'synchronous'] as const;

export interface Entry {
  epoch: number;
  key: string;
  value: number;
}

export interface Replica {
  name: Name;
  /** Entry i has LSN i + 1. */
  log: Entry[];
  /** The newest epoch this replica knows of. */
  epoch: number;
  alive: boolean;
  /** Its link from the leader is held back: new entries wait for it. */
  held: boolean;
}

export interface ReplState {
  mode: number;
  replicas: Record<Name, Replica>;
  leader: Name;
  /** The follower the leader waits for under semi-sync. */
  syncName: Name | null;
  epoch: number;
  /** Semi-sync timed out on its follower and now answers without waiting. */
  semiOff: boolean;
  /** LSN of the client's own last write. */
  wrote: number;
  /** Highest position of a replica the client has read from. */
  seen: number;
}

export const MAX_VALUE = 99;

export function create(mode = SEMI): ReplState {
  const replica = (name: Name): Replica => ({ name, log: [], epoch: 1, alive: true, held: false });
  return {
    mode,
    replicas: { A: replica('A'), B: replica('B'), C: replica('C') },
    leader: 'A',
    syncName: 'B',
    epoch: 1,
    semiOff: false,
    wrote: 0,
    seen: 0,
  };
}

// ---- model helpers ------------------------------------------------------------

export const pos = (r: Replica) => r.log.length;
export const leaderOf = (s: ReplState) => s.replicas[s.leader];
/** Live replicas other than the leader, in name order. */
export const followers = (s: ReplState) => NAMES.filter((n) => n !== s.leader && s.replicas[n].alive).map((n) => s.replicas[n]);

export function syncFollower(s: ReplState): Replica | null {
  const fs = followers(s);
  return fs.find((f) => f.name === s.syncName) ?? fs[0] ?? null;
}

/** The followers the leader waits for before it answers a write. */
export function needed(s: ReplState): Replica[] {
  if (s.mode === SYNC) return followers(s);
  if (s.mode === SEMI && !s.semiOff) {
    const f = syncFollower(s);
    return f ? [f] : [];
  }
  return [];
}

/** The newest value of `key` in a log, and its LSN, or null. */
export function lookup(log: Entry[], key: string): { value: number; lsn: number } | null {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].key === key) return { value: log[i].value, lsn: i + 1 };
  return null;
}

export function asName(raw: number | string): Name | null {
  const n = String(raw).trim().toUpperCase();
  return n === 'A' || n === 'B' || n === 'C' ? n : null;
}

export function asKey(raw: number | string): string | null {
  const k = String(raw).trim().toLowerCase();
  return /^[a-z]$/.test(k) ? k : null;
}

export function role(s: ReplState, r: Replica): string {
  if (!r.alive) return 'down';
  if (r.name === s.leader) return 'leader';
  const kind = s.mode === SYNC || (s.mode === SEMI && syncFollower(s) === r) ? 'sync' : 'async';
  return r.held ? `${kind}, held` : kind;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const said = (e: Entry) => `${e.key} = ${e.value}`;
const chip = (e: Entry) => `${e.key}=${e.value}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---- ids ------------------------------------------------------------------------

/** Named after the replica, the LSN and the epoch, so a truncated entry and its replacement differ. */
export const eid = (r: Name, lsn: number, epoch: number) => `e-${r}-${lsn}-${epoch}`;
export const gid = (r: Name, lsn: number) => `g-${r}-${lsn}`;
export const hid = (r: Name) => `h-${r}`;
export const CLIENT = 'client';
/** Header cells: name, role, position. */
const POS_CELL = 2;
const ROLE_CELL = 1;

/** LSN columns drawn. */
export const COLS = 6;
/** First LSN drawn: always leave one empty column for the next write. */
export function firstShown(s: ReplState): number {
  const end = Math.max(...NAMES.map((n) => pos(s.replicas[n])));
  return Math.max(1, end - COLS + 2);
}

/** The chip on an entry if it is drawn, otherwise on its replica's position. */
function entryProbe(s: ReplState, r: Name, lsn: number, text: string): Probe {
  const e = s.replicas[r].log[lsn - 1];
  if (e && lsn >= firstShown(s)) return { text, at: eid(r, lsn, e.epoch) };
  return { text, at: hid(r), cell: POS_CELL };
}

const atClient = (text: string): Probe => ({ text, at: CLIENT });

/** Copy the leader's entries that `f` lacks. With a recorder, one frame per entry. */
function shipAll(s: ReplState, f: Replica, rec: Rec | null, say?: (e: Entry, lsn: number) => string, anchors: string[] = [], probe?: Probe): number {
  const lead = leaderOf(s);
  let sent = 0;
  while (pos(f) < pos(lead)) {
    const lsn = pos(f) + 1;
    const e = lead.log[lsn - 1];
    f.log.push(e);
    sent++;
    if (rec) {
      rec.count('shipped');
      if (say) {
        // These copies are not the write being followed, so they go straight to green and the chip stays where it was.
        rec.mark(eid(f.name, lsn, e.epoch), 'ok');
        rec.line(...anchors, 'copy');
        rec.step(say(e, lsn), { probe });
      }
    }
  }
  return sent;
}

type Refusal = string | null;

/** Why `raw` is not a live follower, or null when it is one. */
function notFollower(s: ReplState, raw: number | string, r: Name | null): Refusal {
  if (!r) return `There are three replicas, A, B and C. Enter a, b or c, not "${raw}".`;
  const rep = s.replicas[r];
  if (!rep.alive) return `${r} is down. Use Rejoin to bring it back first.`;
  if (r === s.leader) return `${r} is the leader. Only a follower's link can be held back or released.`;
  return null;
}

// ---- operations -------------------------------------------------------------------

/** The client writes key = value. Returns the LSN it was given, or null when refused. */
export function write(s: ReplState, rawKey: number | string, rawValue: number | string, rec: Rec): number | null {
  const key = asKey(rawKey);
  const value = Number(rawValue);
  rec.line('append');
  if (!key) {
    rec.step(`Keys on this page are single letters, a to z. "${rawKey}" is not one.`);
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_VALUE) {
    rec.step(`Values on this page are whole numbers from 0 to ${MAX_VALUE}, so they fit in a cell.`);
    return null;
  }
  const lead = leaderOf(s);
  const L = lead.name;
  const text = `${key}=${value}`;
  rec.step(
    `The client sends ${key} = ${value} to ${L}, the leader. Only the leader accepts writes. The followers copy its log, entry by entry, in the same order.`,
    { probe: atClient(text) },
  );

  lead.log.push({ epoch: s.epoch, key, value });
  const lsn = pos(lead);
  const mine = (r: Name) => eid(r, lsn, s.epoch);
  rec.mark(mine(L), 'key');
  rec.step(
    `${L} appends ${key} = ${value} to its log at LSN ${lsn}, stamped with epoch ${s.epoch}. LSN means log sequence number: the entry's place in the log. Every replica that applies this log in order ends up with the same data.`,
    { probe: entryProbe(s, L, lsn, text) },
  );

  const need = needed(s);
  rec.line('wait');
  if (need.length === 0) {
    const sync = syncFollower(s);
    rec.step(
      s.mode === ASYNC
        ? `Asynchronous replication: ${L} waits for no follower before it answers. The client gets the fastest answer, and the write is on ${L} alone for now.`
        : s.mode === SEMI && s.semiOff
          ? `Semi-synchronous replication has fallen back to asynchronous, because ${sync ? sync.name : 'the synchronous follower'} timed out on an earlier write. ${L} answers without waiting until it catches up.`
          : `No follower is up, so there is nobody to wait for. ${L} answers on its own.`,
      { probe: entryProbe(s, L, lsn, text) },
    );
  }
  let acks = 0;
  for (const f of need) {
    if (f.held) {
      rec.markCell(hid(f.name), ROLE_CELL, 'compare');
      rec.line('held');
      rec.step(
        `${L} sends LSN ${lsn} to ${f.name}, its synchronous follower, and waits for an acknowledgement before answering. ${f.name} is held back, so none comes. The client is still waiting.`,
        { probe: entryProbe(s, L, lsn, text) },
      );
      s.semiOff = true;
      rec.markCell(hid(f.name), ROLE_CELL, 'bad');
      rec.line('timeout');
      rec.step(
        `The wait times out. ${L} stops waiting for ${f.name} and carries on as if replication were asynchronous. MySQL's semi-synchronous replication does this after rpl_semi_sync_source_timeout, 10 seconds by default. PostgreSQL's synchronous replication would keep the client waiting instead.`,
        { probe: entryProbe(s, L, lsn, text) },
      );
      rec.markCell(hid(f.name), ROLE_CELL, 'idle');
    } else {
      shipAll(s, f, rec);
      acks++;
      rec.mark(mine(L), 'ok');
      rec.mark(mine(f.name), 'key');
      rec.line('sync_copy', 'copy');
      rec.step(
        `${L} sends LSN ${lsn} to ${f.name} and waits. ${f.name} appends it and acknowledges. Now two replicas have the write, so losing one of them cannot lose it.`,
        { probe: entryProbe(s, f.name, lsn, text) },
      );
      rec.mark(mine(f.name), 'ok');
    }
  }

  const ok = acks >= need.length;
  s.wrote = lsn;
  rec.mark(mine(L), 'ok');
  rec.line('ack');
  rec.compare(`acks ${acks}`, ok ? '≥' : '<', `needed ${need.length}`, ok ? 'answer the client' : 'timed out: answer anyway', {
    probe: atClient(text),
    message: ok
      ? `${L} has the ${need.length === 1 ? 'acknowledgement' : 'acknowledgements'} it waits for (${acks} of ${need.length}), so it tells the client the write is saved. The client remembers LSN ${lsn}, the position of its own last write.`
      : `No acknowledgement came, but ${L} tells the client the write is saved anyway. Right now it is on ${L} alone. The client remembers LSN ${lsn}, the position of its own last write.`,
  });
  rec.count('acked');

  for (const f of followers(s)) {
    if (pos(f) >= lsn) continue;
    if (f.held) {
      rec.line('async');
      rec.step(
        `${f.name} is held back, so LSN ${lsn} waits in ${L}'s log for it. ${f.name} is now ${plural(lsn - pos(f), 'entry', 'entries')} behind. Reads from ${f.name} will not see this write until it catches up.`,
        { probe: entryProbe(s, L, lsn, text) },
      );
      continue;
    }
    shipAll(s, f, rec);
    rec.mark(mine(f.name), 'key');
    rec.line('async_copy', 'copy');
    rec.step(
      `${f.name} receives LSN ${lsn} and applies it. The client already had its answer: nobody waited for ${f.name}.`,
      { probe: entryProbe(s, f.name, lsn, text) },
    );
    rec.mark(mine(f.name), 'ok');
  }

  const holders = NAMES.filter((n) => s.replicas[n].alive && pos(s.replicas[n]) >= lsn && s.replicas[n].log[lsn - 1].epoch === s.epoch);
  const behind = followers(s).filter((f) => pos(f) < lsn).map((f) => f.name);
  rec.line('async');
  rec.step(
    `Written: ${key} = ${value} is at LSN ${lsn} on ${list(holders)}. The client waited for ${plural(acks, 'follower')}. ` +
      (holders.length === 1
        ? `If ${L} died now, this write would be lost, though the client was told it was saved.`
        : `It survives the loss of ${L}.`) +
      (behind.length ? ` ${list(behind)} ${behind.length === 1 ? 'is' : 'are'} behind.` : ''),
    { probe: entryProbe(s, L, lsn, text) },
  );
  return lsn;
}

/** The newest position the client knows of, unless the failover lost it. */
export const wanted = (s: ReplState) => Math.min(Math.max(s.wrote, s.seen), pos(leaderOf(s)));

/** Read `key` from one replica as it is. Returns the value (null if absent) and whether the read was visibly stale. */
export function read(s: ReplState, rawName: number | string, rawKey: number | string, rec: Rec): { value: number | null; stale: boolean } | null {
  const name = asName(rawName);
  const key = asKey(rawKey);
  rec.line('r_pick');
  if (!name) {
    rec.step(`There are three replicas, A, B and C. Enter a, b or c, not "${rawName}".`);
    return null;
  }
  if (!key) {
    rec.step(`Keys on this page are single letters, a to z. "${rawKey}" is not one.`);
    return null;
  }
  const r = s.replicas[name];
  if (!r.alive) {
    rec.step(`${name} is down, so it cannot answer. Read from another replica, or use Rejoin.`);
    return null;
  }
  const text = `read ${key}`;
  const L = s.leader;
  rec.step(
    name === L
      ? `The client reads ${key} from ${name}, the leader. It has every write, but every read sent here adds to the leader's load.`
      : `The client reads ${key} from ${name}. Any replica can answer a read: that is how followers take read load off the leader.`,
    { probe: atClient(text) },
  );

  const want = wanted(s);
  const p = pos(r);
  const behind = p < want;
  const own = want === s.wrote;
  rec.markCell(hid(name), POS_CELL, 'compare');
  rec.line('want', 'stale');
  rec.compare(`${name} pos ${p}`, behind ? '<' : '≥', `want ${want}`, behind ? 'behind: answer anyway' : 'up to date', {
    probe: { text, at: hid(name), cell: POS_CELL },
    message: behind
      ? `${name} has applied up to LSN ${p}. The client knows of LSN ${want}, ${own ? 'its own last write' : 'the newest position it has read from'}. A plain read does not check this: ${name} answers from what it has.`
      : `${name} has applied up to LSN ${p}, which includes LSN ${want}, ${own ? "the client's own last write" : 'the newest position it has read from'}.`,
  });
  rec.markCell(hid(name), POS_CELL, 'idle');

  const got = lookup(r.log, key);
  const fresh = lookup(leaderOf(s).log, key);
  const differs = (got?.value ?? null) !== (fresh?.value ?? null);
  const stale = behind && differs;
  const seenBefore = s.seen;
  s.seen = Math.max(s.seen, p);
  rec.count('reads');
  if (stale) rec.count('stale');

  const answer = got ? `${key} = ${got.value} (LSN ${got.lsn})` : `that it has no ${key}`;
  const probe = got ? entryProbe(s, name, got.lsn, text) : { text, at: hid(name), cell: POS_CELL };
  if (got) rec.mark(eid(name, got.lsn, r.log[got.lsn - 1].epoch), stale ? 'bad' : 'key');
  let message: string;
  if (!stale) {
    message =
      `${name} answers ${answer}. ` +
      (behind ? `It is behind, but the entries it lacks are for other keys, so this answer happens to match the leader's. ` : `That is the newest value. `) +
      `1 replica read, no waiting.`;
  } else {
    if (fresh) rec.mark(eid(L, fresh.lsn, leaderOf(s).log[fresh.lsn - 1].epoch), 'compare');
    const newest = fresh ? `${key} = ${fresh.value} at LSN ${fresh.lsn}` : `no ${key} at all`;
    if (!own) {
      message = `Stale read: ${name} answers ${answer}, but the leader has ${newest}. This client earlier read from a replica at LSN ${seenBefore}, and now sees older data than it saw then: time has gone backwards. That breaks monotonic reads. Sending each client's reads to the same replica prevents it.`;
    } else {
      const ahead = NAMES.map((n) => s.replicas[n]).find((x) => x.alive && x.name !== name && x.name !== L && pos(x) >= want) ?? leaderOf(s);
      message =
        `Stale read: ${name} answers ${answer}, but the leader has ${newest}. The client wrote ${key} and does not see its own write. That breaks read-your-writes. ` +
        (fresh && got ? `Had it just read ${key} from ${ahead.name}, it would see ${key} go back from ${fresh.value} to ${got.value}: two followers at different positions also break monotonic reads.` : `Use Read your writes to see the fix.`);
    }
  }
  rec.line('serve');
  rec.step(message, { probe });
  return { value: got?.value ?? null, stale };
}

/** Read `key`, but only from a replica that has the client's last write; otherwise from the leader. Returns the value and who answered. */
export function readYourWrites(s: ReplState, rawName: number | string, rawKey: number | string, rec: Rec): { value: number | null; from: Name } | null {
  const name = asName(rawName);
  const key = asKey(rawKey);
  rec.line('y_pick');
  if (!name) {
    rec.step(`There are three replicas, A, B and C. Enter a, b or c, not "${rawName}".`);
    return null;
  }
  if (!key) {
    rec.step(`Keys on this page are single letters, a to z. "${rawKey}" is not one.`);
    return null;
  }
  if (!s.replicas[name].alive) {
    rec.step(`${name} is down, so it cannot answer. Read from another replica, or use Rejoin.`);
    return null;
  }
  const text = `read ${key}`;
  const L = s.leader;
  rec.step(
    `The client reads ${key} from ${name} and sends along LSN ${s.wrote}, the position of its own last write. A replica may answer only once it has applied at least that much.`,
    { probe: atClient(text) },
  );

  let r = s.replicas[name];
  rec.line('ryw_check');
  if (name === L) {
    rec.step(`${name} is the leader, so it has every write the client made. No wait and no detour.`, { probe: { text, at: hid(name), cell: POS_CELL } });
  } else {
    const p = pos(r);
    const behind = p < s.wrote;
    rec.markCell(hid(name), POS_CELL, 'compare');
    rec.compare(`${name} pos ${p}`, behind ? '<' : '≥', `wrote ${s.wrote}`, behind ? 'route to the leader' : 'serve here', {
      probe: { text, at: hid(name), cell: POS_CELL },
      message: behind
        ? `${name} has applied up to LSN ${p}, short of LSN ${s.wrote}. It has not got the client's write yet.`
        : `${name} has applied up to LSN ${p}, which includes the client's write at LSN ${s.wrote}. It may answer.`,
    });
    rec.markCell(hid(name), POS_CELL, 'idle');
    if (behind) {
      r = leaderOf(s);
      rec.line('route');
      rec.step(
        `It could wait until ${name} reaches LSN ${s.wrote}${s.replicas[name].held ? `, but ${name} is held back, so that wait could be long` : ''}. Instead the read goes to the leader, ${L}, which always has the client's writes. The cost is load on the leader.`,
        { probe: { text, at: hid(L), cell: POS_CELL } },
      );
    }
  }

  const got = lookup(r.log, key);
  s.seen = Math.max(s.seen, pos(r));
  rec.count('reads');
  if (got) rec.mark(eid(r.name, got.lsn, r.log[got.lsn - 1].epoch), 'key');
  const lost = s.wrote > pos(leaderOf(s));
  rec.line('ryw_serve');
  rec.step(
    `${r.name} answers ${got ? `${key} = ${got.value} (LSN ${got.lsn})` : `that it has no ${key}`}. ` +
      (lost
        ? `The client's write at LSN ${s.wrote} was lost in a failover, so no replica can show it. Comparing LSNs alone cannot tell; a real system compares the epoch as well.`
        : `The client is guaranteed to see its own writes. ${r.name === name ? '1 replica read.' : '1 extra hop, to the leader.'}`),
    { probe: got ? entryProbe(s, r.name, got.lsn, text) : { text, at: hid(r.name), cell: POS_CELL } },
  );
  return { value: got?.value ?? null, from: r.name };
}

/** Hold back a follower's link. Returns false when refused. */
export function lag(s: ReplState, raw: number | string, rec: Rec): boolean {
  const name = asName(raw);
  rec.line('l_pick');
  const why = notFollower(s, raw, name);
  if (why) {
    rec.step(why);
    return false;
  }
  const f = s.replicas[name!];
  if (s.mode === SYNC) {
    rec.line('sync_only');
    rec.step(
      `Refused. Under synchronous replication the leader waits for every follower on every write, so a slow follower does not fall behind: it makes every write slow. That is the price of sync. Rebuild the page as semi-synchronous or asynchronous to see lag.`,
    );
    return false;
  }
  rec.line('hold');
  if (f.held) {
    rec.step(`${f.name} is already held back. Use Catch up to release it.`);
    return true;
  }
  f.held = true;
  const isSync = s.mode === SEMI && syncFollower(s) === f;
  rec.markCell(hid(f.name), ROLE_CELL, 'compare');
  rec.step(
    `${f.name}'s link is held back: new entries will queue in the leader's log for it. In real life this is a busy follower, a slow network or a long query delaying replay. ` +
      (isSync ? `${f.name} is the synchronous follower, so the next write will wait for it.` : `${f.name} is asynchronous, so writes will not wait for it: it will just fall behind.`),
  );
  return true;
}

/** Release a follower and send it what it missed. Returns how many entries were copied. */
export function catchUp(s: ReplState, raw: number | string, rec: Rec): number {
  const name = asName(raw);
  rec.line('c_pick');
  const why = notFollower(s, raw, name);
  if (why) {
    rec.step(why);
    return 0;
  }
  const f = s.replicas[name!];
  const lead = leaderOf(s);
  f.held = false;
  rec.line('release');
  rec.step(`${f.name}'s link is released. ${lead.name} sends it every entry it missed, oldest first, and ${f.name} applies them in order.`);
  let sent = 0;
  for (;;) {
    const p = pos(f);
    const lp = pos(lead);
    const last = lead.log[Math.min(p, lp - 1)];
    const probe = last ? entryProbe(s, lead.name, Math.min(p + 1, lp), chip(last)) : undefined;
    rec.markCell(hid(f.name), POS_CELL, 'compare');
    rec.line('ship', 'gap');
    if (p >= lp) {
      rec.compare(`${f.name} pos ${p}`, '=', `${lead.name} pos ${lp}`, 'caught up', { probe });
      rec.markCell(hid(f.name), POS_CELL, 'idle');
      break;
    }
    rec.compare(`${f.name} pos ${p}`, '<', `${lead.name} pos ${lp}`, `copy LSN ${p + 1}`, { probe });
    rec.markCell(hid(f.name), POS_CELL, 'idle');
    const e = lead.log[p];
    f.log.push(e);
    sent++;
    rec.count('shipped');
    rec.mark(eid(f.name, p + 1, e.epoch), 'key');
    rec.line('ship', 'copy');
    rec.step(`${f.name} applies LSN ${p + 1}: ${said(e)}.`, { probe: entryProbe(s, f.name, p + 1, chip(e)) });
    rec.mark(eid(f.name, p + 1, e.epoch), 'ok');
  }
  if (s.semiOff && s.mode === SEMI && syncFollower(s) === f) {
    s.semiOff = false;
    rec.line('resync');
    rec.step(`${f.name} is the synchronous follower and has caught up, so semi-synchronous replication switches back on. The next write waits for ${f.name} again.`);
  }
  rec.line('c_done');
  rec.step(
    sent
      ? `${f.name} has caught up: ${plural(sent, 'entry', 'entries')} copied, and it is at LSN ${pos(f)} like ${lead.name}. Reads from ${f.name} now see every write so far.`
      : `${f.name} was not behind, so nothing was copied. It is at LSN ${pos(f)} like ${lead.name}.`,
  );
  return sent;
}

/** The leader dies and the most up-to-date follower is promoted. Returns how many acknowledged writes were lost, or null when refused. */
export function failLeader(s: ReplState, rec: Rec): number | null {
  const old = leaderOf(s);
  const fs = followers(s);
  rec.line('f_check');
  if (fs.length === 0) {
    rec.step(`${old.name} is the only replica up. There is no follower to promote, so losing it would lose the database. Use Rejoin first.`);
    return null;
  }
  old.alive = false;
  const last = old.log[old.log.length - 1];
  const probe = last ? entryProbe(s, old.name, pos(old), chip(last)) : undefined;
  if (last) rec.mark(eid(old.name, pos(old), last.epoch), 'key');
  rec.line('die');
  rec.step(
    `${old.name}, the leader, crashes. ` + (last ? `Its newest entry is ${said(last)} at LSN ${pos(old)}. ` : ``) + `No writes can be taken until a follower is promoted.`,
    { probe },
  );

  rec.line('candidates');
  rec.step(
    `Pick the follower that has applied the most: it is missing the fewest of ${old.name}'s writes. Before this, a real system must decide that ${old.name} is dead and not just slow, usually when heartbeats stop for a timeout.`,
    { probe },
  );
  let best: Replica | null = null;
  for (const f of fs) {
    rec.markCell(hid(f.name), POS_CELL, 'compare');
    if (!best) {
      best = f;
      rec.line('better', 'best');
      rec.step(`${f.name} is at LSN ${pos(f)}: the first candidate.`, { probe });
      rec.markCell(hid(f.name), POS_CELL, 'idle');
      continue;
    }
    const ahead = pos(f) > pos(best);
    rec.line('better');
    rec.compare(`${f.name} pos ${pos(f)}`, ahead ? '>' : '≤', `${best.name} pos ${pos(best)}`, ahead ? `pick ${f.name}` : `keep ${best.name}`, {
      probe,
      message: ahead ? `${f.name} is at LSN ${pos(f)}, ahead of ${best.name} at LSN ${pos(best)}, so ${f.name} is the better choice.` : `${f.name} is at LSN ${pos(f)}, no further than ${best.name} at LSN ${pos(best)}. Keep ${best.name}.`,
    });
    rec.markCell(hid(f.name), POS_CELL, 'idle');
    if (ahead) best = f;
  }
  const b = best!;
  s.epoch++;
  b.epoch = s.epoch;
  b.held = false;
  s.leader = b.name;
  rec.line('promote');
  rec.markCell(hid(b.name), ROLE_CELL, 'ok');
  rec.step(
    `${b.name} becomes the leader for epoch ${s.epoch}. Every new entry is stamped with epoch ${s.epoch}, so it can always be told apart from what ${old.name} wrote. Clients now send their writes to ${b.name}.`,
    { probe },
  );

  const lost = pos(old) - pos(b);
  rec.line('lost');
  const gone = old.log.slice(pos(b)).map(said);
  for (let lsn = pos(b) + 1; lsn <= pos(old); lsn++) rec.mark(eid(old.name, lsn, old.log[lsn - 1].epoch), 'bad');
  rec.compare(`${b.name} pos ${pos(b)}`, lost > 0 ? '<' : '=', `${old.name} pos ${pos(old)}`, lost > 0 ? `${plural(lost, 'write')} lost` : 'nothing lost', {
    probe,
    message:
      lost > 0
        ? `${old.name} told the client ${list(gone)} ${lost === 1 ? 'was' : 'were'} saved, but no follower received ${lost === 1 ? 'it' : 'them'}. ${b.name} does not have ${lost === 1 ? 'it' : 'them'}, so ${lost === 1 ? 'it is' : 'they are'} gone. ` +
          (s.mode === ASYNC ? `That is the price of asynchronous replication.` : `Semi-synchronous replication had fallen back to asynchronous after the timeout, so the write was on ${old.name} alone.`)
        : `Every write ${old.name} acknowledged is on ${b.name} too.` +
          (s.mode === SEMI ? ` Semi-synchronous replication made sure a follower had each one, and the most up-to-date follower was promoted.` : s.mode === SYNC ? ` Synchronous replication made sure every follower had each one.` : ``),
  });
  if (lost > 0) rec.count('lost', lost);

  s.semiOff = false;
  const rest = followers(s);
  s.syncName = rest[0]?.name ?? null;
  for (const f of rest) {
    f.held = false;
    f.epoch = s.epoch;
    rec.unmark(hid(f.name));
    shipAll(s, f, rec, (e, lsn) => `${f.name} now follows ${b.name} and copies the LSN ${lsn} it was missing: ${said(e)}.`, ['repoint'], probe);
  }
  rec.line('repoint');
  rec.step(
    `Failover done: ${b.name} leads epoch ${s.epoch}` +
      (rest.length ? ` and ${list(rest.map((f) => f.name))} ${rest.length === 1 ? 'follows' : 'follow'} it. ` : ` with no follower. `) +
      `${old.name} is down. ` +
      (lost > 0
        ? `${plural(lost, 'acknowledged write')} lost. The client still remembers LSN ${s.wrote} as its last write and cannot tell on its own that it is gone.`
        : `No acknowledged write was lost.`),
    { probe },
  );
  return lost;
}

/** A replica that was down comes back as a follower. Returns how many entries it discarded, or null when refused. */
export function rejoin(s: ReplState, raw: number | string, rec: Rec): number | null {
  const name = asName(raw);
  rec.line('j_check');
  if (!name) {
    rec.step(`There are three replicas, A, B and C. Enter a, b or c, not "${raw}".`);
    return null;
  }
  const r = s.replicas[name];
  if (r.alive) {
    rec.step(`${name} is already up. Only a replica that is down can rejoin.`);
    return null;
  }
  const lead = leaderOf(s);
  const L = lead.name;
  const tail = r.log[r.log.length - 1];
  const probe = tail ? entryProbe(s, name, pos(r), chip(tail)) : undefined;
  rec.markCell(hid(name), ROLE_CELL, 'compare');
  rec.line('fence');
  rec.compare(`${name} epoch ${r.epoch}`, '<', `epoch ${s.epoch}`, `step down, follow ${L}`, {
    probe,
    message: `${name} restarts still believing it leads epoch ${r.epoch}. If it took writes while ${L} did too, there would be two leaders and two diverging histories: split brain. ${L}'s epoch, ${s.epoch}, is newer, so ${name} steps down. Fencing makes that stick: followers and storage refuse anything stamped with an older epoch.`,
  });
  rec.markCell(hid(name), ROLE_CELL, 'idle');
  r.epoch = s.epoch;

  let n = pos(r);
  while (n > 0) {
    const mine = r.log[n - 1];
    const theirs = lead.log[n - 1];
    const id = eid(name, n, mine.epoch);
    const at = entryProbe(s, name, n, chip(mine));
    rec.mark(id, 'compare');
    rec.line('match');
    if (theirs && theirs.epoch === mine.epoch) {
      rec.compare(`${name} #${n} e${mine.epoch}`, '=', `${L} #${n} e${theirs.epoch}`, 'agree: keep from here', {
        probe: at,
        message: `LSN ${n} has epoch ${mine.epoch} on both ${name} and ${L}. One leader writes each epoch, so the entries are the same, and so is everything before them.`,
      });
      rec.unmark(id);
      break;
    }
    rec.compare(`${name} #${n} e${mine.epoch}`, '≠', theirs ? `${L} #${n} e${theirs.epoch}` : `${L} has no #${n}`, 'discard', {
      probe: at,
      message: theirs
        ? `LSN ${n} on ${name} was written in epoch ${mine.epoch}, but ${L}'s LSN ${n} was written in epoch ${theirs.epoch}. ${name}'s entry never made it into the new history.`
        : `${name} has LSN ${n}, ${said(mine)}, but ${L}'s log ends at LSN ${pos(lead)}. No follower ever received it.`,
    });
    rec.mark(id, 'bad');
    n--;
  }
  const dropped = r.log.slice(n);
  rec.line('truncate');
  if (dropped.length) {
    rec.step(
      `${name} cuts its log back to LSN ${n}, deleting ${list(dropped.map(said))}. ` +
        `${dropped.length === 1 ? 'That write was acknowledged to a client once and is' : 'Those writes were acknowledged to a client once and are'} now gone for good. Keeping ${dropped.length === 1 ? 'it' : 'them'} would leave ${name} with data no other replica has.`,
      { probe },
    );
    r.log.splice(n);
    rec.count('discarded', dropped.length);
  } else {
    rec.step(`Nothing to discard: every entry ${name} has is on ${L} too.`, { probe });
  }

  r.alive = true;
  r.held = false;
  rec.line('follow');
  rec.step(`${name} is back, as a follower of ${L}. Now it copies whatever ${L} has that it lacks.`);
  shipAll(s, r, rec, (e, lsn) => `${name} copies LSN ${lsn} from ${L}: ${said(e)}.`, ['follow']);
  rec.line('follow');
  rec.step(
    `${name} has rejoined at LSN ${pos(r)}, the same as ${L}, as ${role(s, r).startsWith('sync') ? 'its synchronous' : 'an asynchronous'} follower. ` +
      (dropped.length ? `${plural(dropped.length, 'entry', 'entries')} discarded. ` : ``) +
      `In PostgreSQL, pg_rewind does this for an old primary whose history has split from the new one.`,
  );
  return dropped.length;
}

// ---- layout -----------------------------------------------------------------------

const NAME_W = 44;
const ROLE_W = 124;
const POS_W = 52;
const HEAD_W = 8 + 6 + NAME_W + ROLE_W + POS_W;
const CLIENT_W = HEAD_W - 8 - 6 - POS_W * 2;
/** Wide enough for its label, which names the replica so a row reads on its own when the headers scroll away on a phone. */
const ENTRY_W = 90;
const PITCH = 96;
const X0 = HEAD_W + 18 + ENTRY_W / 2;
const CHIP_ROOM = PROBE_H + 16;
const CLIENT_Y = 0;
const ROW_PITCH = CELL_H + SUB_ROOM + CHIP_ROOM;
const rowY = (i: number) => CLIENT_Y + ROW_PITCH * (i + 1);
const LEFT = 0;
const RIGHT = X0 + (COLS - 1) * PITCH + ENTRY_W / 2;
const TOP = CLIENT_Y - CELL_H / 2 - 4 - CHIP_ROOM;
const BOTTOM = rowY(NAMES.length - 1) + CELL_H / 2 + 4 + SUB_ROOM;
const colX = (s: ReplState, lsn: number) => X0 + (lsn - firstShown(s)) * PITCH;

export function layout(s: ReplState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const lo = firstShown(s);
  const lead = leaderOf(s);

  nodes.push({
    id: CLIENT,
    x: HEAD_W / 2,
    y: CLIENT_Y,
    cells: [
      { text: 'client', w: CLIENT_W },
      { text: String(s.wrote), sub: 'wrote', w: POS_W },
      { text: String(s.seen), sub: 'seen', w: POS_W },
    ],
  });
  for (let c = 0; c < COLS; c++) {
    decor.push({ id: `lsn-${c}`, type: 'label', x: X0 + c * PITCH, y: CLIENT_Y + 5, text: `LSN ${lo + c}`, anchor: 'middle', strong: true });
  }

  NAMES.forEach((name, i) => {
    const r = s.replicas[name];
    const y = rowY(i);
    const lastRow = i === NAMES.length - 1;
    const dim = r.alive ? undefined : ('dim' as const);
    nodes.push({
      id: hid(name),
      x: HEAD_W / 2,
      y,
      cells: [
        { text: name, w: NAME_W, tone: dim, sub: lastRow ? 'replica' : undefined },
        { text: role(s, r), w: ROLE_W, tone: dim, sub: lastRow ? 'role' : undefined },
        { text: String(pos(r)), w: POS_W, tone: dim, sub: lastRow ? 'applied' : undefined },
      ],
    });
    for (let lsn = lo; lsn < lo + COLS; lsn++) {
      const e = r.log[lsn - 1];
      const x = colX(s, lsn);
      if (!e) {
        nodes.push({ id: gid(name, lsn), x, y, cells: [{ text: '', w: ENTRY_W }] });
        continue;
      }
      const src = lead.log[lsn - 1];
      nodes.push({
        id: eid(name, lsn, e.epoch),
        x,
        y,
        cells: [{ text: chip(e), sub: `${name}, epoch ${e.epoch}`, w: ENTRY_W }],
        tone: dim,
        from: name !== lead.name && src && src.epoch === e.epoch ? eid(lead.name, lsn, e.epoch) : undefined,
      });
    }
  });
  // Two empty labels pin the corners, so the view holds still as logs grow and shrink.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------------

const REPLICA = { name: 'replica', label: 'Replica (a, b or c)', kind: 'word' } as const;
const KEY = { name: 'key', label: 'Key (a letter)', kind: 'word' } as const;
const VALUE = { name: 'value', label: 'Value', kind: 'int', min: 0, max: MAX_VALUE } as const;

const KEYS = ['x', 'y', 'z'];
const pick = <T,>(xs: T[]): T => xs[randomInt(0, xs.length - 1)];

/** The key of the leader's newest entry, so a read finds something interesting. */
function lastKey(s: ReplState): string {
  const log = leaderOf(s).log;
  return log.length ? log[log.length - 1].key : 'x';
}

/** A follower that is behind, where a plain read is most likely to be stale. */
function suggestRead(s: ReplState): [string, string] {
  const fs = followers(s);
  const behind = fs.filter((f) => pos(f) < pos(leaderOf(s)));
  const from = behind.length ? behind : fs.length ? fs : [leaderOf(s)];
  return [pick(from).name.toLowerCase(), lastKey(s)];
}

function suggestLag(s: ReplState): string {
  const fs = followers(s).filter((f) => !f.held);
  const async = fs.filter((f) => !(s.mode === SEMI && syncFollower(s) === f));
  const from = async.length ? async : fs.length ? fs : followers(s);
  return (from.length ? pick(from).name : 'b').toLowerCase();
}

function suggestCatchUp(s: ReplState): string {
  const fs = followers(s);
  const held = fs.filter((f) => f.held || pos(f) < pos(leaderOf(s)));
  const from = held.length ? held : fs;
  return (from.length ? pick(from).name : 'b').toLowerCase();
}

function suggestRejoin(s: ReplState): string {
  const down = NAMES.filter((n) => !s.replicas[n].alive);
  return (down.length ? pick(down) : 'a').toLowerCase();
}

export const SEED: [string, ...(number | string)[]][] = [
  ['write', 'x', 1],
  ['write', 'y', 2],
  ['lag', 'c'],
];

const def: StructureDef<ReplState> = {
  id: 'leader-replication',
  params: [
    {
      id: 'mode',
      label: 'Leader waits for',
      default: SEMI,
      options: [
        { value: ASYNC, label: 'No follower (async)' },
        { value: SEMI, label: 'One follower (semi-sync)' },
        { value: SYNC, label: 'Every follower (sync)' },
      ],
    },
  ],
  create: (params) => create(params.mode ?? SEMI),
  // Under sync a follower cannot be held back, so the seed leaves every follower up to date.
  seedFor: (params) => ((params.mode ?? SEMI) === SYNC ? SEED.filter(([op]) => op !== 'lag') : SEED),
  seed: SEED,
  ops: [
    {
      id: 'write',
      label: 'Write',
      intent: 'primary',
      args: [KEY, VALUE],
      code: ['write', 'needed', 'ship_all'],
      run: (s, [k, v], rec) => void write(s, k, v, rec),
      suggest: () => [pick(KEYS), randomInt(3, MAX_VALUE)],
    },
    { id: 'read', label: 'Read', args: [REPLICA, KEY], code: ['read'], run: (s, [r, k], rec) => void read(s, r, k, rec), suggest: (s) => suggestRead(s) },
    {
      id: 'ryw',
      label: 'Read your writes',
      args: [REPLICA, KEY],
      code: ['read_your_writes'],
      run: (s, [r, k], rec) => void readYourWrites(s, r, k, rec),
      suggest: (s) => suggestRead(s),
    },
    { id: 'lag', label: 'Lag', args: [REPLICA], code: ['lag'], run: (s, [r], rec) => void lag(s, r, rec), suggest: (s) => [suggestLag(s)] },
    { id: 'catch_up', label: 'Catch up', args: [REPLICA], code: ['catch_up', 'ship_all'], run: (s, [r], rec) => void catchUp(s, r, rec), suggest: (s) => [suggestCatchUp(s)] },
    { id: 'fail_leader', label: 'Fail leader', intent: 'danger', args: [], code: ['fail_leader', 'ship_all'], run: (s, _args, rec) => void failLeader(s, rec) },
    { id: 'rejoin', label: 'Rejoin', args: [REPLICA], code: ['rejoin', 'agrees', 'ship_all'], run: (s, [r], rec) => void rejoin(s, r, rec), suggest: (s) => [suggestRejoin(s)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'acked', label: 'Writes acknowledged' },
    { key: 'shipped', label: 'Entries copied to followers' },
    { key: 'stale', label: 'Stale reads' },
    { key: 'lost', label: 'Acknowledged writes lost' },
  ],
  status: (s) => [
    { label: 'Leader', value: `${s.leader}, epoch ${s.epoch}` },
    { label: 'Positions', value: NAMES.map((n) => `${n} ${pos(s.replicas[n])}${s.replicas[n].alive ? '' : ' (down)'}`).join(', ') },
    {
      label: 'Leader waits for',
      value:
        s.mode === ASYNC
          ? 'no follower'
          : s.mode === SYNC
            ? 'every follower'
            : s.semiOff
              ? 'nobody: timed out, now async'
              : (syncFollower(s)?.name ?? 'nobody: no follower up'),
    },
    { label: 'Client', value: `wrote LSN ${s.wrote}, has read up to ${s.seen}` },
  ],
  tour: [
    ['write', 'x', 5],
    ['read', 'c', 'x'],
    ['ryw', 'c', 'x'],
    ['lag', 'b'],
    ['write', 'y', 8],
    ['fail_leader'],
    ['rejoin', 'a'],
  ],
  fill: () => ['write', pick(KEYS), randomInt(3, MAX_VALUE)],
  source: { python, java },
  info,
};

export default def;
