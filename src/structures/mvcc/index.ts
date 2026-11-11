import { CAPTION_ROOM, LABEL_LINE, LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_GAP, CELL_H, TAG_H, TRAY_PAD } from '../../core/geometry';
import { pick } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/Mvcc.java?raw';
import python from './code/mvcc.py?raw';
import { info } from './info';

/**
 * Multi-version concurrency control on a table of two rows.
 *
 * A write never changes a version in place. It adds a new version to the
 * front of the row's chain, stamped with the writer's id (xmin), and stamps
 * the same id on the version it replaces (xmax). A read walks the chain newest
 * first and returns the first version its snapshot is allowed to see. Writers
 * take a lock per row, held until they commit or abort, so two writers of one
 * row queue up; readers take no locks at all.
 *
 * Transaction ids only go up, so a larger id began later. A snapshot is the
 * set of ids running when it was taken plus the next id to be handed out (the
 * horizon). Snapshot isolation takes one at BEGIN; read committed takes a new
 * one for every statement. This is PostgreSQL's scheme, much simplified.
 */
export type Level = 'rc' | 'snapshot';
export type Status = 'active' | 'committed' | 'aborted';
export type Table = 'bank' | 'doctors';
export type Outcome = 'written' | 'waiting' | 'aborted';

export interface Version {
  /** Stable id for the drawing. */
  id: string;
  value: number;
  /** Id of the transaction that created it. */
  xmin: number;
  /** Id of the transaction that replaced it, or null. */
  xmax: number | null;
}

export interface Txn {
  xid: number;
  level: Level;
  status: Status;
  /** Ids running when the snapshot was taken. */
  inProgress: number[];
  /** The next id to be handed out when the snapshot was taken: ids from here up had not begun. */
  horizon: number;
  /** The write it is blocked on, while it waits for a lock. */
  wants: { row: string; value: number } | null;
  /** The page's note of what it read last from each row, for the drawing. Not part of the mechanism. */
  seen: [string, number][];
}

export interface MvccState {
  /** Level for transactions that begin from now on. */
  level: Level;
  table: Table;
  /** Row names, in drawing order. */
  order: string[];
  /** Each row's versions, newest first. */
  rows: Record<string, Version[]>;
  /** Indexed by id. txns[0] is the loader that wrote the table. */
  txns: Txn[];
  /** Row to the id of the transaction holding its write lock. */
  locks: Record<string, number>;
  nextXid: number;
  /** Ids of finished transactions, in the order they ended. The page uses it to choose which to draw. */
  ended: number[];
  /** Version ids, never reused, so a new version is a new node. */
  vseq: number;
}

export const TABLES: Record<Table, [string, number][]> = {
  bank: [['a', 50], ['b', 50]],
  doctors: [['alice', 1], ['bob', 1]],
};
/** Versions drawn per row. */
export const MAX_VERSIONS = 4;
/** Transactions running at once. */
export const MAX_ACTIVE = 3;
/** The page stops handing out ids here so they stay two digits wide. */
export const MAX_XID = 99;
export const SCENARIOS = ['readskew', 'lostupdate', 'writeskew'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function create(level: Level = 'snapshot', table: Table = 'bank'): MvccState {
  const s: MvccState = { level, table, order: [], rows: {}, txns: [], locks: {}, nextXid: 1, ended: [], vseq: 0 };
  load(s, table);
  return s;
}

/** Start again: transaction 0 writes every row and commits. */
export function load(s: MvccState, table: Table): void {
  s.table = table;
  s.order = TABLES[table].map(([r]) => r);
  s.rows = {};
  for (const [r, v] of TABLES[table]) s.rows[r] = [{ id: `v${++s.vseq}`, value: v, xmin: 0, xmax: null }];
  s.txns = [{ xid: 0, level: s.level, status: 'committed', inProgress: [], horizon: 1, wants: null, seen: [] }];
  s.locks = {};
  s.nextXid = 1;
  s.ended = [];
}

// ---- the rules, without narration ------------------------------------------

export function committedBefore(s: MvccState, t: Txn, x: number): boolean {
  if (s.txns[x].status !== 'committed') return false;
  if (x >= t.horizon) return false;
  return !t.inProgress.includes(x);
}

export function visible(s: MvccState, t: Txn, v: Version): boolean {
  if (v.xmin === t.xid) return v.xmax !== t.xid;
  if (!committedBefore(s, t, v.xmin)) return false;
  if (v.xmax === null) return true;
  if (v.xmax === t.xid) return false;
  return !committedBefore(s, t, v.xmax);
}

function takeSnapshot(s: MvccState, t: Txn): void {
  t.inProgress = s.txns.filter((o) => o.status === 'active' && o.xid !== t.xid).map((o) => o.xid);
  t.horizon = s.nextXid;
}

/** The newest version not left by an aborted transaction. */
export function newest(s: MvccState, row: string): Version {
  return s.rows[row].find((v) => s.txns[v.xmin].status !== 'aborted')!;
}

/** Would `xid` waiting on `holder` close a cycle of waits? */
export function waitsFor(s: MvccState, holder: number | undefined, xid: number): boolean {
  let h = holder;
  while (h !== undefined) {
    if (h === xid) return true;
    const w = s.txns[h].wants;
    h = w ? s.locks[w.row] : undefined;
  }
  return false;
}

/** Can no transaction, running or still to begin, ever see this version? */
export function dead(s: MvccState, v: Version): boolean {
  if (s.txns[v.xmin].status === 'aborted') return true;
  if (v.xmax === null || s.txns[v.xmax].status !== 'committed') return false;
  return active(s).every((t) => t.level === 'rc' || committedBefore(s, t, v.xmax!));
}

/** Snapshot transactions that still need this version, though it has been replaced and the replacement committed. */
function holdersOf(s: MvccState, v: Version): Txn[] {
  if (v.xmax === null || s.txns[v.xmax].status !== 'committed') return [];
  return active(s).filter((t) => t.level === 'snapshot' && !committedBefore(s, t, v.xmax!));
}

export const active = (s: MvccState) => s.txns.filter((t) => t.status === 'active');
const waitingOn = (s: MvccState, row: string) => s.txns.filter((t) => t.wants?.row === row).length;

/** The newest committed value of a row: what a new transaction would read. */
export function latest(s: MvccState, row: string): number {
  return s.rows[row].find((v) => s.txns[v.xmin].status === 'committed')!.value;
}

// ---- words ------------------------------------------------------------------

export const T = (x: number) => `T${x}`;
const tid = (x: number) => `t${x}`;
const hid = (row: string) => `h-${row}`;
const lid = (row: string) => `lock-${row}`;
export const rowLabel = (s: MvccState, row: string) => (s.table === 'bank' ? row.toUpperCase() : row);
const levelName = (l: Level) => (l === 'rc' ? 'read committed' : 'snapshot isolation');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ids = (xs: number[]) => list(xs.map(T));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const inProgressText = (t: Txn) => (t.inProgress.length ? `in progress: ${t.inProgress.map(T).join(', ')}` : 'in progress: none');

export function parseLevel(raw: number | string): Level | null {
  const w = String(raw).trim().toLowerCase();
  if (['rc', 'read', 'committed', 'readcommitted'].includes(w)) return 'rc';
  if (['snapshot', 'si', 'rr', 'repeatable'].includes(w)) return 'snapshot';
  return null;
}
export function parseScenario(raw: number | string): Scenario | null {
  const w = String(raw).trim().toLowerCase();
  if (['readskew', 'skew', 'read', 'nonrepeatable'].includes(w)) return 'readskew';
  if (['lostupdate', 'lost', 'update'].includes(w)) return 'lostupdate';
  if (['writeskew', 'doctors', 'oncall', 'write'].includes(w)) return 'writeskew';
  return null;
}
export function parseTable(raw: number | string): Table | null {
  const w = String(raw).trim().toLowerCase();
  if (['bank', 'accounts', 'money'].includes(w)) return 'bank';
  if (['doctors', 'doctor', 'oncall', 'rota'].includes(w)) return 'doctors';
  return null;
}

// ---- narrated operations ----------------------------------------------------

/** Make `xid` the one followed: its box goes magenta, and every other mark is cleared. */
function focus(rec: Rec, xid: number): void {
  rec.clearMarks();
  rec.mark(tid(xid), 'key');
}
const atTxn = (xid: number): Probe => ({ text: T(xid), at: tid(xid) });
const atNode = (xid: number, node: string): Probe => ({ text: T(xid), at: node });

/** Checks shared by read, write and commit. Returns the transaction when it may act. */
function usable(s: MvccState, raw: number | string, rec: Rec, what: string, allowWaiting = false): Txn | null {
  const x = Number(raw);
  if (!Number.isInteger(x) || x < 0 || x >= s.txns.length) {
    rec.step(`There is no transaction ${raw}. ${s.txns.length > 1 ? `The ids so far run from T1 to ${T(s.txns.length - 1)}.` : `Begin one first.`}`);
    return null;
  }
  const t = s.txns[x];
  if (x === 0) {
    rec.step(`T0 is the loader that wrote the table. It committed before anything else began, so it cannot ${what}.`);
    return null;
  }
  if (t.status !== 'active') {
    rec.step(`${T(x)} has already ${t.status === 'committed' ? 'committed' : 'aborted'}. A finished transaction cannot ${what}. Begin a new one.`);
    return null;
  }
  if (t.wants && !allowWaiting) {
    rec.step(`${T(x)} is waiting for the lock on ${rowLabel(s, t.wants.row)}, held by ${T(s.locks[t.wants.row])}. It is blocked mid-statement and cannot ${what} until that transaction commits or aborts.`);
    return null;
  }
  return t;
}

function usableRow(s: MvccState, raw: number | string, rec: Rec): string | null {
  const row = String(raw).trim().toLowerCase();
  if (s.rows[row]) return row;
  rec.step(`This table has rows ${list(s.order.map((r) => r))}. There is no row "${raw}".`);
  return null;
}

/** Start a transaction. Returns its id, or null when the page's limits are reached. */
export function begin(s: MvccState, rec: Rec): number | null {
  rec.line('begin');
  if (active(s).length >= MAX_ACTIVE) {
    rec.step(`${ids(active(s).map((t) => t.xid))} are already running, and this page draws at most ${MAX_ACTIVE} at once. Commit or abort one first.`);
    return null;
  }
  if (s.nextXid > MAX_XID) {
    rec.step(`This page stops at ${T(MAX_XID)} so the ids stay short. Use Reset to start the table again. A real database hands out ids for ever (PostgreSQL wraps its 32-bit ids round with care).`);
    return null;
  }
  const t: Txn = { xid: s.nextXid, level: s.level, status: 'active', inProgress: [], horizon: 0, wants: null, seen: [] };
  s.nextXid++;
  s.txns.push(t);
  focus(rec, t.xid);
  rec.step(`${T(t.xid)} begins, at ${levelName(t.level)}. It gets the next id, ${t.xid}. Ids only go up, so a larger id always began later.`, { probe: atTxn(t.xid) });
  takeSnapshot(s, t);
  rec.line('snapshot');
  const running = t.inProgress.length ? `${ids(t.inProgress)} ${t.inProgress.length === 1 ? 'is' : 'are'} in progress` : `nothing else is in progress`;
  rec.step(
    t.level === 'snapshot'
      ? `It takes its snapshot: ${running}, and ids from ${t.horizon} up have not begun. Whatever those write stays invisible to ${T(t.xid)} for its whole life, even after they commit.`
      : `It notes that ${running}. Under read committed this matters little: every statement takes a fresh snapshot, so ${T(t.xid)} will see each commit from its next statement on.`,
    { probe: atTxn(t.xid) },
  );
  return t.xid;
}

/** The commit test, narrated: did `x` commit before t's snapshot? */
function committedBeforeShown(s: MvccState, t: Txn, x: number, which: 'xmin' | 'xmax', caller: string, rec: Rec, probe: Probe): boolean {
  const st = s.txns[x].status;
  rec.line(caller, 'committed');
  if (st !== 'committed') {
    rec.compare(
      `${which} ${T(x)}: ${st}`,
      '≠',
      'committed',
      which === 'xmin'
        ? st === 'aborted'
          ? 'aborted: garbage, skip'
          : 'not committed: skip, no dirty read'
        : st === 'aborted'
          ? 'the replacement aborted: still here'
          : 'replacement not committed: still here',
      { probe },
    );
    return false;
  }
  if (t.level === 'rc') {
    rec.line(caller, 'committed', 'after', 'running');
    rec.compare(`${which} ${T(x)}: committed`, '=', 'committed', 'committed before this statement', { probe });
    return true;
  }
  rec.line(caller, 'committed');
  rec.compare(`${which} ${T(x)}: committed`, '=', 'committed', 'but before my snapshot?', { probe });
  if (x >= t.horizon) {
    rec.line(caller, 'after');
    rec.compare(`${which} ${T(x)}`, '≥', `horizon ${t.horizon}`, which === 'xmin' ? 'began after my snapshot: skip' : 'replaced after my snapshot: still mine', { probe });
    return false;
  }
  if (t.inProgress.includes(x)) {
    rec.line(caller, 'running');
    rec.compare(`${which} ${T(x)}`, '=', inProgressText(t), which === 'xmin' ? 'running at my snapshot: skip' : 'replaced after my snapshot: still mine', { probe });
    return false;
  }
  rec.line(caller, 'after', 'running');
  rec.compare(`${which} ${T(x)}`, '<', `horizon ${t.horizon}, not running`, 'committed before my snapshot', { probe });
  return true;
}

/** The visibility rule, narrated, for one version. */
function visibleShown(s: MvccState, t: Txn, v: Version, rec: Rec): boolean {
  const probe = atNode(t.xid, v.id);
  rec.line('mine');
  if (v.xmin === t.xid) {
    const replaced = v.xmax === t.xid;
    rec.compare(`xmin ${T(v.xmin)}`, '=', `me ${T(t.xid)}`, replaced ? 'mine, but I replaced it: skip' : 'my own write: visible', { probe });
    return !replaced;
  }
  rec.compare(`xmin ${T(v.xmin)}`, '≠', `me ${T(t.xid)}`, 'not mine: was it committed?', { probe });
  if (!committedBeforeShown(s, t, v.xmin, 'xmin', 'created', rec, probe)) return false;
  rec.line('not_deleted');
  if (v.xmax === null) {
    rec.compare('xmax', '=', 'none', 'never replaced: visible', { probe });
    return true;
  }
  if (v.xmax === t.xid) {
    rec.compare(`xmax ${T(v.xmax)}`, '=', `me ${T(t.xid)}`, 'I replaced it: skip', { probe });
    return false;
  }
  rec.compare(`xmax ${T(v.xmax)}`, '≠', 'none', 'replaced: in my view?', { probe });
  return !committedBeforeShown(s, t, v.xmax, 'xmax', 'deleted', rec, probe);
}

/** Read a row through the transaction's snapshot. Returns the value seen, or null when it cannot read. */
export function read(s: MvccState, rawX: number | string, rawRow: number | string, rec: Rec): number | null {
  rec.line('walk');
  const t = usable(s, rawX, rec, 'read');
  if (!t) return null;
  const row = usableRow(s, rawRow, rec);
  if (!row) return null;
  const name = rowLabel(s, row);
  focus(rec, t.xid);
  if (t.level === 'rc') {
    takeSnapshot(s, t);
    rec.line('statement');
    rec.step(
      `${T(t.xid)} reads ${name}. Read committed takes a fresh snapshot for this statement: ${t.inProgress.length ? `${ids(t.inProgress)} ${t.inProgress.length === 1 ? 'is' : 'are'} in progress now` : `nothing else is in progress now`}.`,
      { probe: atTxn(t.xid) },
    );
  } else {
    rec.step(
      `${T(t.xid)} reads ${name} through the snapshot it took when it began (${inProgressText(t)}; horizon ${t.horizon}). It walks ${name}'s versions newest first and takes the first one it may see.`,
      { probe: atTxn(t.xid) },
    );
  }
  let looked = 0;
  for (const v of s.rows[row]) {
    looked++;
    rec.count('reads');
    rec.mark(v.id, 'compare');
    const ok = visibleShown(s, t, v, rec);
    if (ok) {
      rec.mark(v.id, 'ok');
      const at = t.seen.findIndex(([r]) => r === row);
      if (at >= 0) t.seen[at] = [row, v.value];
      else t.seen.push([row, v.value]);
      rec.line('found');
      rec.step(
        `${T(t.xid)} reads ${name} = ${v.value}, the version ${v.xmin === t.xid ? 'it wrote itself' : `${T(v.xmin)} made`}. ${plural(looked, 'version')} looked at${looked > 1 ? `; the newer ${looked === 2 ? 'one was' : 'ones were'} not in its view` : ''}. No lock was taken: a reader never blocks a writer.`,
        { probe: atNode(t.xid, v.id) },
      );
      return v.value;
    }
    rec.mark(v.id, 'dim');
  }
  rec.line('walk');
  rec.step(`No version of ${name} is visible to ${T(t.xid)}.`, { probe: atTxn(t.xid) });
  return null;
}

/** Write a row. Returns what happened, or null when the write could not be tried. */
export function write(s: MvccState, rawX: number | string, rawRow: number | string, rawValue: number | string, rec: Rec): Outcome | null {
  rec.line('lock');
  const t = usable(s, rawX, rec, 'write');
  if (!t) return null;
  const row = usableRow(s, rawRow, rec);
  if (!row) return null;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0 || value > 999) {
    rec.step(`Values on this page are whole numbers from 0 to 999.`);
    return null;
  }
  if (s.rows[row].length + 1 + waitingOn(s, row) > MAX_VERSIONS) {
    rec.step(
      `Sorry, this page draws at most ${MAX_VERSIONS} versions of a row, and ${rowLabel(s, row)} has no room for another${waitingOn(s, row) ? ' once the waiting writes go in' : ''}. Run Vacuum to clear versions nobody can see; if a running transaction still needs them, commit or abort it first. A real table has no such limit, which is exactly why it needs vacuum.`,
    );
    return null;
  }
  return writeCore(s, t, row, value, rec, false);
}

function writeCore(s: MvccState, t: Txn, row: string, value: number, rec: Rec, retry: boolean): Outcome {
  const name = rowLabel(s, row);
  focus(rec, t.xid);
  const holder = s.locks[row];
  rec.line('lock');
  rec.step(
    retry
      ? `${T(t.xid)} wakes and runs its write again: set ${name} to ${value}. It starts from the lock, as before.`
      : `${T(t.xid)} wants to set ${name} to ${value}. A writer first needs the row's write lock, which it keeps until it commits or aborts.`,
    { probe: atTxn(t.xid) },
  );
  rec.mark(hid(row), 'compare');
  if (holder !== undefined && holder !== t.xid) {
    rec.compare(`lock on ${name}`, '=', `held by ${T(holder)}`, `wait for ${T(holder)}`, {
      probe: atNode(t.xid, hid(row)),
      message: `${T(holder)} holds ${name}'s lock: it wrote ${name} and has not finished. ${T(t.xid)} must wait, unless waiting would close a circle.`,
    });
    if (waitsFor(s, holder, t.xid)) {
      rec.mark(hid(row), 'bad');
      rec.line('deadlock');
      rec.step(
        `Deadlock: ${T(holder)} is itself waiting, directly or through others, for a lock that ${T(t.xid)} holds. Neither could ever go on, so ${T(t.xid)} is aborted. PostgreSQL finds such circles after deadlock_timeout, 1 second by default.`,
        { probe: atTxn(t.xid) },
      );
      abortCore(s, t, rec);
      return 'aborted';
    }
    t.wants = { row, value };
    rec.line('wait');
    rec.mark(hid(row), 'path');
    rec.step(
      `${T(t.xid)} waits. It is blocked until ${T(holder)} commits or aborts, and can do nothing else meanwhile. What happens then depends on its level.`,
      { probe: atTxn(t.xid) },
    );
    return 'waiting';
  }
  rec.compare(`lock on ${name}`, '=', holder === t.xid ? 'mine already' : 'free', holder === t.xid ? 'carry on' : 'no other writer: carry on', {
    probe: atNode(t.xid, hid(row)),
  });
  rec.mark(hid(row), 'path');
  const head = newest(s, row);
  rec.mark(head.id, 'compare');
  const probe = atNode(t.xid, head.id);
  if (t.level === 'rc') {
    rec.line('head', 'conflict');
    rec.step(
      `The newest version of ${name} is ${head.value}, made by ${T(head.xmin)}. Read committed makes no further check: ${T(t.xid)} writes on top of it, whatever it read earlier.`,
      { probe },
    );
  } else if (head.xmin === t.xid) {
    rec.line('head', 'conflict');
    rec.compare(`newest xmin ${T(head.xmin)}`, '=', `me ${T(t.xid)}`, 'my own version: no conflict', { probe });
  } else {
    rec.line('head', 'conflict', 'committed');
    rec.step(`The newest version of ${name} is ${head.value}, made by ${T(head.xmin)}. Under snapshot isolation it must be one that ${T(t.xid)}'s snapshot can see; otherwise someone changed ${name} behind its back.`, { probe });
    const x = head.xmin;
    if (x >= t.horizon || t.inProgress.includes(x)) {
      rec.line('conflict', x >= t.horizon ? 'after' : 'running');
      rec.compare(`newest xmin ${T(x)}`, x >= t.horizon ? '≥' : '=', x >= t.horizon ? `horizon ${t.horizon}` : inProgressText(t), 'changed after my snapshot: abort', { probe });
      rec.mark(head.id, 'path');
      rec.line('first_wins');
      rec.step(
        `First committer wins. ${T(x)} committed a new ${name} that ${T(t.xid)} never saw. Writing now would overwrite it unseen: a lost update. So ${T(t.xid)} aborts, and the application should run it again from the start. PostgreSQL says "could not serialize access due to concurrent update".`,
        { probe: atTxn(t.xid) },
      );
      abortCore(s, t, rec);
      return 'aborted';
    }
    rec.line('conflict', 'after', 'running');
    rec.compare(`newest xmin ${T(x)}`, '<', `horizon ${t.horizon}, not running`, 'unchanged since my snapshot', { probe });
  }
  s.locks[row] = t.xid;
  head.xmax = t.xid;
  const v: Version = { id: `v${++s.vseq}`, value, xmin: t.xid, xmax: null };
  s.rows[row].unshift(v);
  rec.count('writes');
  rec.mark(head.id, 'path');
  rec.mark(v.id, 'ok');
  rec.line('append');
  rec.step(
    `Add a new version of ${name}: ${value}, xmin ${T(t.xid)}. The old one gets xmax ${T(t.xid)} but stays where it is, because other snapshots may still need it. Nothing was overwritten in place.`,
    { probe: atNode(t.xid, v.id) },
  );
  return 'written';
}

/** Commit. Returns false when the transaction cannot commit. */
export function commit(s: MvccState, rawX: number | string, rec: Rec): boolean {
  rec.line('commit');
  const t = usable(s, rawX, rec, 'commit');
  if (!t) return false;
  focus(rec, t.xid);
  t.status = 'committed';
  s.ended.push(t.xid);
  const wrote = s.order.filter((r) => s.rows[r].some((v) => v.xmin === t.xid));
  for (const r of wrote) for (const v of s.rows[r]) if (v.xmin === t.xid) rec.mark(v.id, 'ok');
  const blind = active(s).filter((o) => o.level === 'snapshot' && !committedBefore(s, o, t.xid));
  rec.step(
    wrote.length
      ? `${T(t.xid)} commits. One flag flips in the commit log, and its ${wrote.length === 1 ? 'version' : 'versions'} of ${list(wrote.map((r) => rowLabel(s, r)))} now ${wrote.length === 1 ? 'counts' : 'count'} as committed for every snapshot taken from here on.` +
          (blind.length ? ` ${ids(blind.map((o) => o.xid))} took ${blind.length === 1 ? 'its snapshot' : 'their snapshots'} earlier and still will not see ${wrote.length === 1 ? 'it' : 'them'}.` : ``)
      : `${T(t.xid)} commits. It wrote nothing, so nothing changes for anyone else.`,
    { probe: atTxn(t.xid) },
  );
  rec.count('commits');
  release(s, t, rec);
  return true;
}

/** Abort. Returns false when there is nothing to abort. */
export function abort(s: MvccState, rawX: number | string, rec: Rec): boolean {
  rec.line('abort');
  const t = usable(s, rawX, rec, 'abort', true);
  if (!t) return false;
  focus(rec, t.xid);
  abortCore(s, t, rec);
  return true;
}

function abortCore(s: MvccState, t: Txn, rec: Rec): void {
  t.status = 'aborted';
  s.ended.push(t.xid);
  const was = t.wants;
  t.wants = null;
  rec.count('aborts');
  const left = s.order.filter((r) => s.rows[r].some((v) => v.xmin === t.xid));
  rec.mark(tid(t.xid), 'key');
  rec.line('abort');
  rec.step(
    left.length
      ? `${T(t.xid)} aborts. Its ${left.length === 1 ? 'version' : 'versions'} of ${list(left.map((r) => rowLabel(s, r)))} stay in the chain, but no snapshot will ever see them, because their creator never committed. They are garbage now, waiting for vacuum.`
      : `${T(t.xid)} aborts. It wrote nothing, so nothing is left behind.` + (was ? ` It stops waiting for ${rowLabel(s, was.row)}.` : ``),
    { probe: atTxn(t.xid) },
  );
  release(s, t, rec);
}

/** Free the locks and run the writes that were waiting for them, oldest transaction first. */
function release(s: MvccState, t: Txn, rec: Rec): void {
  const freed = s.order.filter((r) => s.locks[r] === t.xid);
  for (const r of freed) delete s.locks[r];
  if (!freed.length) return;
  rec.line('unlock');
  rec.step(`${T(t.xid)} releases its write ${freed.length === 1 ? 'lock' : 'locks'} on ${list(freed.map((r) => rowLabel(s, r)))}.`, { probe: atTxn(t.xid) });
  for (const w of [...s.txns]) {
    if (!w.wants || !freed.includes(w.wants.row)) continue;
    const { row, value } = w.wants;
    w.wants = null;
    focus(rec, w.xid);
    rec.line('waiter');
    rec.step(`${T(w.xid)} was waiting for ${rowLabel(s, row)}'s lock. It is free now, so ${T(w.xid)} carries on.`, { probe: atTxn(w.xid) });
    rec.line('retry');
    writeCore(s, w, row, value, rec, true);
  }
}

/** Drop every version no transaction can ever see again. Returns how many went. */
export function vacuum(s: MvccState, rec: Rec): number {
  rec.clearMarks();
  rec.line('vac_scan');
  const total = s.order.reduce((n, r) => n + s.rows[r].length, 0);
  rec.step(
    `Vacuum checks all ${total} versions. A version can go when its creator aborted, or when it was replaced by a commit that every open snapshot already sees.`,
  );
  let removed = 0;
  const held = new Set<number>();
  for (const row of s.order) {
    for (const v of s.rows[row]) {
      const d = dead(s, v);
      const who = holdersOf(s, v);
      const name = rowLabel(s, row);
      rec.line('vac_test', d ? 'vac_drop' : 'vac_keep');
      rec.mark(v.id, d ? 'bad' : 'ok');
      let why: string;
      if (d) {
        removed++;
        why = s.txns[v.xmin].status === 'aborted'
          ? `${name} = ${v.value} was made by ${T(v.xmin)}, which aborted. Nobody can see it: drop it.`
          : `${name} = ${v.value} was replaced by ${T(v.xmax!)}, and every open snapshot already sees that commit. Drop it.`;
      } else if (who.length) {
        who.forEach((o) => held.add(o.xid));
        why = `${name} = ${v.value} was replaced by ${T(v.xmax!)}, but ${ids(who.map((o) => o.xid))} took ${who.length === 1 ? 'its snapshot' : 'their snapshots'} before that commit and may still read it. Keep it.`;
      } else if (v.xmax !== null && s.txns[v.xmax].status === 'active') {
        why = `${name} = ${v.value} is being replaced by ${T(v.xmax)}, which has not committed. Keep it.`;
      } else if (s.txns[v.xmin].status === 'active') {
        why = `${name} = ${v.value} was made by ${T(v.xmin)}, still running. Keep it.`;
      } else {
        why = `${name} = ${v.value} is the newest committed version. Keep it.`;
      }
      rec.step(why);
    }
  }
  for (const row of s.order) s.rows[row] = s.rows[row].filter((v) => !dead(s, v));
  rec.count('vacuumed', removed);
  rec.line('vac_done');
  rec.step(
    removed
      ? `Vacuum removed ${plural(removed, 'version')}.` + (held.size ? ` ${ids([...held])} held back the rest: one long-running transaction keeps every version it might read, on every table it could touch.` : ` Each row is back to the versions someone can still see.`)
      : held.size
        ? `Nothing could go. ${ids([...held])} still ${held.size === 1 ? 'needs' : 'need'} the old versions: this is how one long transaction makes a table bloat.`
        : `Nothing to remove: every version is still visible to someone.`,
  );
  return removed;
}

/** The isolation level for transactions that begin from now on. */
export function setLevel(s: MvccState, raw: number | string, rec: Rec): boolean {
  rec.line('level');
  const level = parseLevel(raw);
  if (!level) {
    rec.step(`Enter rc for read committed or snapshot for snapshot isolation.`);
    return false;
  }
  const was = s.level;
  s.level = level;
  const running = active(s);
  rec.step(
    (was === level ? `New transactions already use ${levelName(level)}. ` : `From now on, new transactions use ${levelName(level)}. `) +
      (level === 'rc'
        ? `Each statement will take a fresh snapshot, so a transaction sees every commit as soon as it happens.`
        : `Each transaction will take one snapshot when it begins and read through it until it ends.`) +
      (running.length && was !== level ? ` ${ids(running.map((t) => t.xid))} keep${running.length === 1 ? 's' : ''} the level ${running.length === 1 ? 'it' : 'they'} began with.` : ``),
  );
  return true;
}

/** Load a fresh table. */
export function reset(s: MvccState, raw: number | string, rec: Rec): boolean {
  rec.line('load');
  const table = parseTable(raw);
  if (!table) {
    rec.step(`Enter bank for two accounts, or doctors for an on-call rota.`);
    return false;
  }
  load(s, table);
  rec.step(
    table === 'bank'
      ? `A fresh table: accounts A and B hold 50 each, both written by T0, the loader, which committed. No transaction is running.`
      : `A fresh table: alice and bob are both on call (1 means on call, 0 off). The rule is that at least one doctor stays on call. T0, the loader, wrote both rows and committed.`,
  );
  return true;
}

// ---- the three stories --------------------------------------------------------

/** Play out one anomaly from a fresh table at the current level. */
export function play(s: MvccState, raw: number | string, rec: Rec): boolean {
  rec.line('load');
  const sc = parseScenario(raw);
  if (!sc) {
    rec.step(`Enter readskew, lostupdate or writeskew.`);
    return false;
  }
  const lv = levelName(s.level);
  if (sc === 'readskew') {
    load(s, 'bank');
    rec.step(`Read skew, at ${lv}. A and B hold 50 each: 100 in all. T1 will move 30 from B to A. T2, an audit, will add up both balances while it does.`);
    const t1 = begin(s, rec)!;
    write(s, t1, 'b', 20, rec);
    const t2 = begin(s, rec)!;
    write(s, t1, 'a', 80, rec);
    const a = read(s, t2, 'a', rec)!;
    commit(s, t1, rec);
    const b = read(s, t2, 'b', rec)!;
    commit(s, t2, rec);
    rec.clearMarks();
    rec.line('commit');
    rec.step(
      a + b === 100
        ? `T2 saw A = ${a} and B = ${b}: ${a + b}, the right total. Every read used the snapshot T2 took when it began, so T1's transfer stayed invisible to it throughout. No read skew. A report or a backup needs exactly this.`
        : `T2 saw A = ${a} and B = ${b}: ${a + b}, yet 100 was there all along. It never saw T1's uncommitted 80, so no dirty read. But its reads came from either side of T1's commit, and ${100 - a - b} vanished. That is read skew: read A again and T2 would get ${latest(s, 'a')}.`,
    );
    return true;
  }
  if (sc === 'lostupdate') {
    load(s, 'bank');
    rec.step(`Lost update, at ${lv}. A holds 50. T1 deposits 10 and T2 deposits 20, each by reading the balance, adding in the application and writing the sum back. Afterwards A should be 80.`);
    const t1 = begin(s, rec)!;
    const t2 = begin(s, rec)!;
    const r1 = read(s, t1, 'a', rec)!;
    const r2 = read(s, t2, 'a', rec)!;
    write(s, t1, 'a', r1 + 10, rec);
    write(s, t2, 'a', r2 + 20, rec);
    commit(s, t1, rec);
    if (s.txns[t2].status === 'active') {
      commit(s, t2, rec);
      rec.clearMarks();
      rec.line('commit');
      rec.step(
        `A = ${latest(s, 'a')}, but two deposits on 50 should make 80. T1's 10 is lost: T2 wrote a sum based on a balance that was stale by then. Fixes: SET balance = balance + 20, which works on the newest version after the wait; SELECT … FOR UPDATE; or snapshot isolation.`,
      );
      return true;
    }
    rec.clearMarks();
    rec.line('first_wins');
    rec.step(`The application catches the error and runs T2's deposit again, as a new transaction.`);
    const t3 = begin(s, rec)!;
    const r3 = read(s, t3, 'a', rec)!;
    write(s, t3, 'a', r3 + 20, rec);
    commit(s, t3, rec);
    rec.clearMarks();
    rec.line('commit');
    rec.step(`A = ${latest(s, 'a')}: both deposits count. Snapshot isolation refused the stale write rather than lose T1's, and the retry read the new balance. The price is that the application must be ready to retry.`);
    return true;
  }
  load(s, 'doctors');
  rec.step(
    `Write skew, at ${lv}. Alice and Bob are both on call. The rule: at least one must stay on. Each feels unwell and asks to go off at the same moment. Each transaction checks the rule, then changes only its own row.`,
  );
  const t1 = begin(s, rec)!;
  const t2 = begin(s, rec)!;
  const on1 = read(s, t1, 'alice', rec)! + read(s, t1, 'bob', rec)!;
  const on2 = read(s, t2, 'alice', rec)! + read(s, t2, 'bob', rec)!;
  rec.clearMarks();
  rec.step(`T1 counts ${on1} doctors on call and T2 counts ${on2}, so each concludes that going off still leaves someone on. Each writes only its own row.`);
  write(s, t1, 'alice', 0, rec);
  write(s, t2, 'bob', 0, rec);
  commit(s, t1, rec);
  commit(s, t2, rec);
  const now = latest(s, 'alice') + latest(s, 'bob');
  rec.clearMarks();
  rec.line('commit');
  rec.step(
    `Both committed, and ${now === 0 ? 'nobody is on call' : `${now} on call`}. Each wrote a different row, so no lock and no first committer wins. That is write skew. Serializable isolation stops it (see the two-phase locking and serializable snapshot isolation pages), as does SELECT … FOR UPDATE on both rows.`,
  );
  return true;
}

// ---- layout -----------------------------------------------------------------

const HEAD_W = 72;
const VAL_W = 52;
const XID_W = 52;
const V_W = TRAY_PAD * 2 + VAL_W + XID_W * 2 + CELL_GAP * 2;
const V_GAP = 28;
const V_PITCH = V_W + V_GAP;
const V0_X = HEAD_W + 34 + V_W / 2;
const CHIP_ROOM = PROBE_H + 16;
const TRAY_H = CELL_H + TRAY_PAD * 2;
const TOP_LABEL_Y = 0;
const ROW0_Y = TOP_LABEL_Y + 14 + CHIP_ROOM + TRAY_H / 2;
/** Below a row: its captions, or the lock tag under the row's name. */
const LOCK_DY = CELL_H / 2 + 6 + TAG_H / 2;
const ROW_PITCH = LOCK_DY + TAG_H / 2 + CHIP_ROOM + TRAY_H / 2;
const NAME_W = 52;
const STATUS_W = 112;
const TXN_W = TRAY_PAD * 2 + NAME_W + STATUS_W + CELL_GAP;
const TXN_PITCH = TXN_W + 34;
/** Transactions drawn: every running one, then the most recent finished ones. */
export const TXNS_SHOWN = 4;
const LEFT = -6;
const RIGHT = V0_X + (MAX_VERSIONS - 1) * V_PITCH + V_W / 2 + 4;

function rowY(i: number): number {
  return ROW0_Y + i * ROW_PITCH;
}
function txnLabelY(rows: number): number {
  return rowY(rows - 1) + LOCK_DY + TAG_H / 2 + 22;
}
function txnY(rows: number): number {
  return txnLabelY(rows) + 10 + CHIP_ROOM + TRAY_H / 2;
}
function bottom(rows: number): number {
  return txnY(rows) + TRAY_H / 2 + CAPTION_ROOM + LABEL_LINE;
}

/** The transactions drawn, in id order: all the running ones, then the latest finished ones. */
export function shownTxns(s: MvccState): Txn[] {
  const running = s.txns.slice(1).filter((t) => t.status === 'active');
  const room = Math.max(0, TXNS_SHOWN - running.length);
  const done = room ? s.ended.slice(-room).map((x) => s.txns[x]) : [];
  return [...running, ...done].sort((a, b) => a.xid - b.xid);
}

/** The row's name rides along in the caption, so a phone that has scrolled past the row names can still tell the rows apart. */
function versionCaption(s: MvccState, row: string, v: Version): string {
  const st = s.txns[v.xmin].status;
  return `${rowLabel(s, row)} · ${st === 'committed' ? 'committed' : st === 'active' ? 'uncommitted' : 'aborted'}`;
}

export function layout(s: MvccState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];
  decor.push({ id: 'table-label', type: 'label', x: 0, y: TOP_LABEL_Y, text: 'Versions, newest first: value · xmin · xmax', strong: true });

  s.order.forEach((row, i) => {
    const y = rowY(i);
    nodes.push({ id: hid(row), x: HEAD_W / 2, y, cells: [{ text: rowLabel(s, row), w: HEAD_W }] });
    const holder = s.locks[row];
    if (holder !== undefined) nodes.push({ id: lid(row), x: 45, y: y + LOCK_DY, cells: [{ text: `lock: ${T(holder)}` }], shape: 'tag' });
    let prev = hid(row);
    s.rows[row].slice(0, MAX_VERSIONS).forEach((v, j) => {
      nodes.push({
        id: v.id,
        x: V0_X + j * V_PITCH,
        y,
        cells: [
          { text: String(v.value), w: VAL_W },
          { text: T(v.xmin), w: XID_W },
          { text: v.xmax === null ? '–' : T(v.xmax), w: XID_W },
        ],
        tone: s.txns[v.xmin].status === 'aborted' ? 'bad' : undefined,
        caption: versionCaption(s, row, v),
      });
      edges.push({ id: `e-${prev}-${v.id}`, from: prev, to: v.id, kind: 'side', arrow: true });
      prev = v.id;
    });
  });

  const rows = s.order.length;
  decor.push({ id: 'txn-label', type: 'label', x: 0, y: txnLabelY(rows), text: 'Transactions', strong: true });
  shownTxns(s).forEach((t, i) => {
    const status = t.status === 'active' ? (t.wants ? `waits ${T(s.locks[t.wants.row])}` : 'active') : t.status;
    const view = t.level === 'rc' ? 'read committed' : `snapshot, ${t.inProgress.length ? `${t.inProgress.map(T).join(', ')} running` : 'none running'}`;
    const saw = t.seen.length ? `read ${t.seen.map(([r, v]) => `${rowLabel(s, r)} ${v}`).join(', ')}` : 'read nothing yet';
    nodes.push({
      id: tid(t.xid),
      x: TXN_W / 2 + i * TXN_PITCH,
      y: txnY(rows),
      cells: [{ text: T(t.xid), w: NAME_W }, { text: status, w: STATUS_W }],
      tone: t.status === 'committed' ? 'ok' : t.status === 'aborted' ? 'bad' : undefined,
      caption: `${view}\n${saw}`,
    });
  });
  if (!shownTxns(s).length) {
    decor.push({ id: 'txn-none', type: 'label', x: 0, y: txnY(rows), text: 'None yet. Begin one, or play a story.' });
  }

  // Two empty labels pin the corners, so the view does not rescale as versions come and go.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP_LABEL_Y, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: bottom(rows) - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges, decor };
}

// ---- definition -------------------------------------------------------------

const TXN_ARG = { name: 'txn', label: 'Transaction', kind: 'int', min: 0, max: MAX_XID } as const;
const ROW_ARG = { name: 'row', label: 'Row', kind: 'word' } as const;

function someRunning(s: MvccState, free: boolean): number {
  const r = active(s).filter((t) => !free || !t.wants);
  return r.length ? pick(r).xid : Math.max(1, s.txns.length - 1);
}

function suggestWrite(s: MvccState): (number | string)[] {
  const x = someRunning(s, true);
  const row = pick(s.order);
  const t = s.txns[x];
  const seen = t?.seen.find(([r]) => r === row)?.[1];
  const value = s.table === 'doctors' ? (seen === 0 ? 1 : 0) : Math.min(999, Math.max(0, (seen ?? latest(s, row)) + pick([-30, -10, 10, 20, 30])));
  return [x, row, value];
}

export const LEVEL_PARAM = { rc: 0, snapshot: 1 } as const;

const def: StructureDef<MvccState> = {
  id: 'mvcc',
  params: [
    {
      id: 'level',
      label: 'Isolation level',
      default: LEVEL_PARAM.snapshot,
      options: [
        { value: LEVEL_PARAM.rc, label: 'Read committed' },
        { value: LEVEL_PARAM.snapshot, label: 'Snapshot' },
      ],
    },
  ],
  create: (params) => create(params.level === LEVEL_PARAM.rc ? 'rc' : 'snapshot'),
  // A writer still running, so the first read already has an uncommitted version to step past.
  seed: [['begin'], ['write', 1, 'a', 80]],
  ops: [
    { id: 'begin', label: 'Begin', intent: 'primary', args: [], code: ['begin'], run: (s, _a, rec) => void begin(s, rec) },
    { id: 'vacuum', label: 'Vacuum', args: [], code: ['vacuum'], run: (s, _a, rec) => void vacuum(s, rec) },
    {
      id: 'read',
      label: 'Read',
      args: [TXN_ARG, ROW_ARG],
      code: ['read', 'visible'],
      run: (s, [x, r], rec) => void read(s, x, r, rec),
      suggest: (s) => [someRunning(s, true), pick(s.order)],
    },
    {
      id: 'write',
      label: 'Write',
      args: [TXN_ARG, ROW_ARG, { name: 'value', label: 'Value', kind: 'int', min: 0, max: 999 }],
      code: ['write', 'visible', 'abort', 'release'],
      run: (s, [x, r, v], rec) => void write(s, x, r, v, rec),
      suggest: suggestWrite,
    },
    {
      id: 'commit',
      label: 'Commit',
      args: [TXN_ARG],
      code: ['commit', 'release', 'write', 'abort', 'visible'],
      run: (s, [x], rec) => void commit(s, x, rec),
      suggest: (s) => [someRunning(s, true)],
    },
    {
      id: 'abort',
      label: 'Abort',
      intent: 'danger',
      args: [TXN_ARG],
      code: ['abort', 'release', 'write', 'visible'],
      run: (s, [x], rec) => void abort(s, x, rec),
      suggest: (s) => [someRunning(s, false)],
    },
    {
      id: 'level',
      label: 'Set level',
      args: [{ name: 'level', label: 'Level (rc or snapshot)', kind: 'word' }],
      code: ['level'],
      run: (s, [l], rec) => void setLevel(s, l, rec),
      suggest: (s) => [s.level === 'rc' ? 'snapshot' : 'rc'],
    },
    {
      id: 'play',
      label: 'Play story',
      args: [{ name: 'story', label: 'Story (readskew, lostupdate, writeskew)', kind: 'word' }],
      code: ['load', 'begin', 'read', 'visible', 'write', 'commit', 'abort', 'release'],
      run: (s, [w], rec) => void play(s, w, rec),
      suggest: () => [pick(SCENARIOS)],
    },
    {
      id: 'reset',
      label: 'Reset',
      intent: 'danger',
      args: [{ name: 'table', label: 'Table (bank or doctors)', kind: 'word' }],
      code: ['load'],
      run: (s, [w], rec) => void reset(s, w, rec),
      suggest: (s) => [s.table],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Versions read' },
    { key: 'writes', label: 'Versions written' },
    { key: 'aborts', label: 'Aborts' },
  ],
  status: (s) => {
    const running = active(s);
    const stored = s.order.reduce((n, r) => n + s.rows[r].length, 0);
    const garbage = s.order.reduce((n, r) => n + s.rows[r].filter((v) => dead(s, v)).length, 0);
    return [
      { label: 'New transactions', value: levelName(s.level) },
      { label: 'Running', value: running.length ? running.map((t) => T(t.xid)).join(', ') : 'none' },
      { label: 'Versions stored', value: `${stored}, ${garbage} removable` },
      s.table === 'bank'
        ? { label: 'A + B, committed', value: String(latest(s, 'a') + latest(s, 'b')) }
        : { label: 'On call, committed', value: String(latest(s, 'alice') + latest(s, 'bob')) },
    ];
  },
  tour: [
    ['level', 'rc'],
    ['play', 'readskew'],
    ['play', 'lostupdate'],
    ['level', 'snapshot'],
    ['play', 'readskew'],
    ['play', 'lostupdate'],
    ['play', 'writeskew'],
  ],
  source: { python, java },
  info,
};

export default def;

