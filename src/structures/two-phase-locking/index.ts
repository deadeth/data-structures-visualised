import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_H, cellsWidth } from '../../core/geometry';
import { pick } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/TwoPhaseLocking.java?raw';
import python from './code/two_phase_locking.py?raw';
import { info } from './info';

/**
 * Two ways to make transactions serializable, run on the same tiny table.
 *
 * The table is two doctors with an on-call flag, and the hospital's rule is
 * that at least one of them is on call. Alice's request to go off call is T1
 * and Bob's is T2: each reads both rows, and goes off call only if it saw
 * two doctors on call. T3 belongs to no one, for experiments.
 *
 * Under two-phase locking (2PL) a read takes a shared lock and a write takes
 * the exclusive lock, and nothing is released until the transaction ends. A
 * request that conflicts waits in the row's queue, and every new wait is
 * checked for a cycle in the waits-for graph.
 *
 * Under serializable snapshot isolation (SSI) a transaction reads from a
 * snapshot and never waits. The database notes every read whose value a
 * concurrent transaction changes, and at commit it refuses a transaction
 * that read something a concurrent, committed transaction wrote.
 *
 * Both keep writes private until commit. Every committed version of a row is
 * kept, stamped with the commit timestamp that made it.
 */
export type Method = '2PL' | 'SSI';
export type Row = 'alice' | 'bob';
export type Mode = 'S' | 'X';
export type Status = 'active' | 'waiting' | 'committed' | 'aborted';

export const ROWS: Row[] = ['alice', 'bob'];
export const IDS = [1, 2, 3] as const;
/** The doctor each transaction belongs to. T3 belongs to no one. */
export const OWNER: Record<number, Row | undefined> = { 1: 'alice', 2: 'bob' };
export const METHODS: Method[] = ['2PL', 'SSI'];

export interface Txn {
  id: number;
  status: Status;
  /** SSI: the last commit timestamp this transaction can see. */
  snapshot: number;
  /** Row to the value it saw. */
  reads: Partial<Record<Row, number>>;
  /** Row to its new value, private until commit. */
  writes: Partial<Record<Row, number>>;
  /** SSI: rows it read whose value `by` changes. Stale if `by` commits. */
  stale: { row: Row; by: Txn }[];
  /** 2PL: the lock it is queued for. */
  pending: { row: Row; mode: Mode; value: number } | null;
  /** Why it was aborted, for the page. */
  why: string | null;
  commitTs: number | null;
}

export interface Version {
  ts: number;
  value: number;
  by: Txn | null;
}

export interface Lock {
  /** Ids holding a shared lock, in order. */
  shared: number[];
  exclusive: number | null;
  /** Queued requests, oldest first. */
  queue: { id: number; mode: Mode }[];
}

export interface TxState {
  method: Method;
  /** Commits so far: the newest commit timestamp. */
  clock: number;
  versions: Record<Row, Version[]>;
  locks: Record<Row, Lock>;
  txns: Record<number, Txn | undefined>;
  commits: number;
  aborts: number;
}

export function create(method: Method = '2PL'): TxState {
  return {
    method,
    clock: 0,
    versions: { alice: [{ ts: 0, value: 1, by: null }], bob: [{ ts: 0, value: 1, by: null }] },
    locks: { alice: { shared: [], exclusive: null, queue: [] }, bob: { shared: [], exclusive: null, queue: [] } },
    txns: {},
    commits: 0,
    aborts: 0,
  };
}

const NAME: Record<Row, string> = { alice: 'Alice', bob: 'Bob' };
const T = (id: number) => `T${id}`;
const flag = (v: number) => (v ? 'on call' : 'off call');
const short = (v: number) => (v ? 'on' : 'off');
const isOpen = (tx: Txn | undefined): tx is Txn => !!tx && (tx.status === 'active' || tx.status === 'waiting');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const sameTxn = (a: Txn, b: Txn) => a === b;

export const latest = (s: TxState, row: Row) => s.versions[row][s.versions[row].length - 1].value;
/** Doctors on call in the committed state. */
export const onCall = (s: TxState): Row[] => ROWS.filter((r) => latest(s, r) === 1);
export const openTxns = (s: TxState): Txn[] => IDS.map((i) => s.txns[i]).filter(isOpen);

export function asRow(raw: number | string): Row | null {
  const w = String(raw).trim().toLowerCase();
  if (w === 'alice' || w === 'a') return 'alice';
  if (w === 'bob' || w === 'b') return 'bob';
  return null;
}

export function asMethod(raw: number | string | undefined): Method | null {
  const w = String(raw ?? '').trim().toUpperCase();
  if (w === '2PL' || w === 'TWO-PHASE LOCKING' || w === '0') return '2PL';
  if (w === 'SSI' || w === '1') return 'SSI';
  return null;
}

// ---- ids and probes -----------------------------------------------------------

const card = (id: number) => `tx${id}`;
const gid = (id: number) => `g${id}`;
const rowId = (r: Row) => `row-${r}`;
const sId = (r: Row) => `s-${r}`;
const xId = (r: Row) => `x-${r}`;
const qId = (r: Row) => `q-${r}`;
const rdId = (r: Row) => `rd-${r}`;
const wrId = (r: Row) => `wr-${r}`;

const atCard = (id: number): Probe => ({ text: T(id), at: card(id) });
const atGraph = (who: number, at: number): Probe => ({ text: T(who), at: gid(at) });

// ---- recorder helpers -----------------------------------------------------------

/** Anchors of the caller (write skew, retry) that every frame inside a nested call also lights. */
let lead: string[] = [];
const ln = (rec: Rec, ...anchors: string[]) => rec.line(...lead, ...anchors);

function withLead<R>(anchors: string[], fn: () => R): R {
  const before = lead;
  lead = anchors;
  try {
    return fn();
  } finally {
    lead = before;
  }
}

/** Magenta goes on the transaction doing the step, and only while it is open. */
function follow(rec: Rec, s: TxState, id: number): void {
  for (const i of IDS) rec.unmark(card(i));
  if (isOpen(s.txns[id])) rec.mark(card(id), 'key');
}

/** Problems that stop an operation on transaction t before it starts, as a sentence. */
function notOpen(s: TxState, t: number, verb: string): string | null {
  if (!IDS.includes(t as 1 | 2 | 3)) return `This page has three transactions, T1 to T3. There is no ${T(t)}.`;
  const tx = s.txns[t];
  if (!tx) return `${T(t)} has not begun. Begin it first.`;
  if (tx.status === 'committed') return `${T(t)} has already committed. Begin it again to start a new transaction.`;
  if (tx.status === 'aborted') return `${T(t)} was aborted. Begin it again, or retry it, to start a new transaction.`;
  if (tx.status === 'waiting' && verb !== 'abort') {
    const p = tx.pending!;
    return `${T(t)} is blocked, waiting for ${p.mode === 'S' ? 'a shared' : 'the exclusive'} lock on ${NAME[p.row]}. A blocked transaction can do nothing else until the lock is granted or it is aborted.`;
  }
  return null;
}

// ---- 2PL: locks -------------------------------------------------------------------

/**
 * Can `id` have this lock now? One comparison against the exclusive holder,
 * and for an exclusive request a second against the other shared holders.
 */
function grantable(s: TxState, row: Row, id: number, mode: Mode, rec: Rec, ctx: string[], probe: Probe): boolean {
  const lock = s.locks[row];
  const x = lock.exclusive;
  const name = NAME[row];
  rec.markCell(xId(row), 0, 'compare');
  const writerInWay = x !== null && x !== id;
  ln(rec, ...ctx, 'x_held', ...(writerInWay || mode === 'X' ? [] : ['s_held']));
  rec.compare(`X on ${name}: ${x === null ? 'none' : T(x)}`, writerInWay ? '≠' : '=', `none or ${T(id)}`, writerInWay ? 'another writer: wait' : mode === 'S' ? 'no writer in the way: grant' : 'no other writer', {
    probe,
    message: writerInWay
      ? `${T(x!)} holds the exclusive lock on ${name}, so ${T(id)} may not ${mode === 'S' ? 'read' : 'write'} it until ${T(x!)} ends.`
      : x === id
        ? `${T(id)} already holds the exclusive lock on ${name} itself.`
        : mode === 'S'
          ? `No one holds the exclusive lock on ${name}. Shared locks do not conflict with each other, so the read may go ahead.`
          : `No one else holds the exclusive lock on ${name}. A writer also needs every reader gone, so check the shared holders.`,
  });
  rec.markCell(xId(row), 0, 'idle');
  if (writerInWay) return false;
  if (mode === 'S') return true;

  const others = lock.shared.filter((u) => u !== id);
  for (const u of others) rec.markCell(sId(row), u - 1, 'compare');
  ln(rec, ...ctx, 's_held');
  rec.compare(`S on ${name}: ${others.length ? others.map(T).join(' ') : 'none'}`, others.length ? '≠' : '=', `none besides ${T(id)}`, others.length ? 'a reader is in the way: wait' : 'no other holder: grant', {
    probe,
    message: others.length
      ? `${list(others.map(T))} ${others.length === 1 ? 'holds' : 'hold'} a shared lock on ${name}. A writer must be alone, so ${T(id)} has to wait for ${others.length === 1 ? 'it' : 'them'} to end.`
      : `No other transaction holds any lock on ${name}, so ${T(id)} may have it to itself.`,
  });
  for (const u of others) rec.markCell(sId(row), u - 1, 'idle');
  return others.length === 0;
}

function grant(s: TxState, row: Row, id: number, mode: Mode): void {
  const lock = s.locks[row];
  if (mode === 'X') {
    lock.shared = lock.shared.filter((u) => u !== id);
    lock.exclusive = id;
  } else if (lock.exclusive !== id && !lock.shared.includes(id)) {
    lock.shared = [...lock.shared, id].sort();
  }
}

/** The transactions holding what `id` is queued for. */
export function waitsFor(s: TxState, id: number): number[] {
  const tx = s.txns[id];
  if (!tx || tx.status !== 'waiting' || !tx.pending) return [];
  const lock = s.locks[tx.pending.row];
  const out = lock.exclusive !== null && lock.exclusive !== id ? [lock.exclusive] : [];
  if (tx.pending.mode === 'X') out.push(...lock.shared.filter((u) => u !== id));
  return out;
}

/** Search the waits-for graph from `start`, one comparison per edge. Returns the cycle, or null. */
function deadlocked(s: TxState, start: number, rec: Rec): number[] | null {
  const parent = new Map<number, number>();
  const stack = [start];
  const seen = new Set([start]);
  ln(rec, 'detect', 'visit');
  rec.step(`Every new wait could close a loop. So the database searches the waits-for graph from ${T(start)}: whom does it wait for, whom do they wait for, and does any path lead back to ${T(start)}?`, {
    probe: atGraph(start, start),
  });
  while (stack.length) {
    const t = stack.pop()!;
    for (const u of waitsFor(s, t)) {
      const back = u === start;
      const fresh = !back && !seen.has(u);
      rec.markEdge(`w${t}-${u}`, 'compare');
      ln(rec, 'edge', 'cycle', ...(fresh ? ['follow'] : []));
      rec.compare(`next ${T(u)}`, back ? '=' : '≠', `start ${T(start)}`, back ? 'back at the start: deadlock' : fresh ? `follow ${T(u)}` : `${T(u)} already checked`, {
        probe: atGraph(start, u),
        message: back
          ? `${T(t)} waits for ${T(u)}, which is where the search began. That is a cycle.`
          : fresh
            ? `${T(t)} waits for ${T(u)}. That is not ${T(start)}, so follow ${T(u)}'s edges next.`
            : `${T(t)} waits for ${T(u)}, whose edges have already been followed.`,
      });
      if (back) {
        const cycle = [t];
        while (cycle[0] !== start) cycle.unshift(parent.get(cycle[0])!);
        return cycle;
      }
      rec.markEdge(`w${t}-${u}`, 'path');
      if (fresh) {
        seen.add(u);
        parent.set(u, t);
        stack.push(u);
      }
    }
  }
  return null;
}

/** Take the lock or queue for it. A wait that closes a cycle aborts the requester. */
function acquire(s: TxState, tx: Txn, row: Row, mode: Mode, value: number, rec: Rec): boolean {
  const lock = s.locks[row];
  const name = NAME[row];
  const probe: Probe = mode === 'S' ? { text: T(tx.id), at: sId(row), cell: tx.id - 1 } : { text: T(tx.id), at: xId(row) };
  const had = lock.exclusive === tx.id ? 'X' : lock.shared.includes(tx.id) ? 'S' : null;
  if (grantable(s, row, tx.id, mode, rec, ['test'], probe)) {
    grant(s, row, tx.id, mode);
    if (mode === 'S') rec.markCell(sId(row), tx.id - 1, 'ok');
    else rec.markCell(xId(row), 0, 'ok');
    ln(rec, 'grant');
    rec.step(
      had === 'X' || (had === 'S' && mode === 'S')
        ? `${T(tx.id)} already holds that lock on ${name}, so nothing changes.`
        : mode === 'S'
          ? `Granted. ${T(tx.id)} holds a shared lock on ${name}. Other readers may share it; a writer would have to wait.`
          : had === 'S'
            ? `Granted. ${T(tx.id)}'s shared lock on ${name} is upgraded to exclusive. No one else may read or write ${name} until ${T(tx.id)} ends.`
            : `Granted. ${T(tx.id)} holds the exclusive lock on ${name}. No one else may read or write ${name} until ${T(tx.id)} ends.`,
      { probe },
    );
    rec.unmark(sId(row));
    rec.unmark(xId(row));
    return true;
  }

  lock.queue.push({ id: tx.id, mode });
  tx.status = 'waiting';
  tx.pending = { row, mode, value };
  rec.count('waits');
  ln(rec, 'queue');
  rec.step(
    `${T(tx.id)} cannot have ${mode === 'S' ? 'a shared' : 'the exclusive'} lock on ${name} yet, so it joins ${name}'s queue and waits. It keeps every lock it already holds: under two-phase locking nothing is released before the end.`,
    { probe: { text: T(tx.id), at: qId(row), cell: lock.queue.length - 1 } },
  );

  const cycle = deadlocked(s, tx.id, rec);
  if (!cycle) {
    const on = waitsFor(s, tx.id);
    ln(rec, 'acyclic', 'wait');
    rec.step(`No path leads back to ${T(tx.id)}, so there is no deadlock. ${T(tx.id)} simply waits until ${list(on.map(T))} ${on.length === 1 ? 'ends' : 'end'}.`, { probe: atCard(tx.id) });
    return false;
  }
  for (let i = 0; i < cycle.length; i++) rec.markEdge(`w${cycle[i]}-${cycle[(i + 1) % cycle.length]}`, 'bad');
  const loop = [...cycle, cycle[0]].map(T).join(' waits for ');
  ln(rec, 'victim');
  rec.step(
    `Deadlock: ${loop}. None of them can ever move, so one must be aborted. This page aborts the transaction whose request closed the loop, ${T(tx.id)}. Real databases pick a victim by age or by how much work would be lost.`,
    { probe: atCard(tx.id) },
  );
  abortTxn(s, tx, rec, 'deadlock victim');
  return false;
}

/** Shrinking phase: drop every lock `tx` holds and its place in any queue, then wake whoever can go. */
function release(s: TxState, tx: Txn, rec: Rec): void {
  const held: string[] = [];
  for (const row of ROWS) {
    const lock = s.locks[row];
    if (lock.exclusive === tx.id) {
      held.push(`exclusive on ${NAME[row]}`);
      lock.exclusive = null;
    }
    if (lock.shared.includes(tx.id)) {
      held.push(`shared on ${NAME[row]}`);
      lock.shared = lock.shared.filter((u) => u !== tx.id);
    }
    lock.queue = lock.queue.filter((q) => q.id !== tx.id);
  }
  ln(rec, 'shrink', 'drop');
  rec.step(
    held.length
      ? `Shrinking phase: ${T(tx.id)} releases every lock it holds, all at once: ${list(held)}. Holding every lock to the very end is what makes two-phase locking serializable.`
      : `${T(tx.id)} holds no locks, so there is nothing to release.`,
    { probe: atCard(tx.id) },
  );
  wake(s, rec);
}

/** Grant queued requests that no longer conflict, oldest first, and finish them. */
function wake(s: TxState, rec: Rec): void {
  for (const row of ROWS) {
    const lock = s.locks[row];
    for (const q of [...lock.queue]) {
      const waiter = s.txns[q.id]!;
      follow(rec, s, q.id);
      const probe: Probe = { text: T(q.id), at: qId(row), cell: lock.queue.indexOf(q) };
      if (!grantable(s, row, q.id, q.mode, rec, ['wake', 'regrant'], probe)) continue;
      lock.queue = lock.queue.filter((x) => x !== q);
      grant(s, row, q.id, q.mode);
      const p = waiter.pending!;
      waiter.status = 'active';
      waiter.pending = null;
      if (p.mode === 'S') waiter.reads[row] = latest(s, row);
      else waiter.writes[row] = p.value;
      ln(rec, 'resume');
      rec.step(
        p.mode === 'S'
          ? `${T(q.id)} gets its shared lock on ${NAME[row]} at last and finishes its read: ${flag(latest(s, row))}. It is active again.`
          : `${T(q.id)} gets the exclusive lock on ${NAME[row]} at last and finishes its write: ${NAME[row]} ${flag(p.value)}, kept private until it commits. It is active again.`,
        { probe: atCard(q.id) },
      );
    }
  }
}

// ---- SSI: snapshots and stale reads ----------------------------------------------

function note(reader: Txn, row: Row, by: Txn): void {
  if (!reader.stale.some((m) => m.row === row && sameTxn(m.by, by))) reader.stale.push({ row, by });
}

/** The newest version the snapshot can see. Writers it cannot see are noted. */
function snapshotRead(s: TxState, tx: Txn, row: Row, rec: Rec): number {
  const name = NAME[row];
  for (const other of openTxns(s)) {
    if (other === tx || other.status !== 'active' || other.writes[row] === undefined) continue;
    note(tx, row, other);
    rec.markCell(wrId(row), other.id - 1, 'compare');
    ln(rec, 'uncommitted', 'note');
    rec.step(
      `${T(other.id)} has written ${name} but not committed, so ${T(tx.id)} cannot see that write. The database notes that ${T(tx.id)}'s view of ${name} goes stale if ${T(other.id)} commits.`,
      { probe: { text: T(tx.id), at: wrId(row), cell: other.id - 1 } },
    );
    rec.markCell(wrId(row), other.id - 1, 'idle');
  }
  const vs = s.versions[row];
  const shown = Math.max(0, vs.length - SHOWN_VERSIONS);
  for (let i = vs.length - 1; i >= 0; i--) {
    const v = vs[i];
    const cell = i >= shown ? 1 + i - shown : 0;
    const visible = v.ts <= tx.snapshot;
    rec.markCell(rowId(row), cell, 'compare');
    ln(rec, 'visible');
    rec.compare(`${name} ts ${v.ts}`, visible ? '≤' : '>', `snapshot ${tx.snapshot}`, visible ? 'visible: read it' : 'too new: skip it', {
      probe: { text: T(tx.id), at: rowId(row), cell },
      message: visible
        ? `The version from timestamp ${v.ts} is in ${T(tx.id)}'s snapshot, so this is what it reads: ${flag(v.value)}.`
        : `The version from timestamp ${v.ts} was committed after ${T(tx.id)} began, so ${T(tx.id)} does not see it.`,
    });
    if (visible) {
      rec.markCell(rowId(row), cell, 'path');
      return v.value;
    }
    rec.markCell(rowId(row), cell, 'idle');
    note(tx, row, v.by!);
    ln(rec, 'newer', 'note');
    rec.step(
      `${T(v.by!.id)} wrote that version and has committed, so ${T(tx.id)}'s view of ${name} is already out of date. The database notes it, and the commit check will find it.`,
      { probe: { text: T(tx.id), at: rowId(row), cell } },
    );
  }
  throw new Error('no version is visible');
}

/** Writing `row` makes every open reader of it stale. */
function warnReaders(s: TxState, tx: Txn, row: Row, rec: Rec): void {
  const name = NAME[row];
  const readers = openTxns(s).filter((o) => o !== tx && o.status === 'active' && o.reads[row] !== undefined);
  if (!readers.length) {
    ln(rec, 'warn');
    rec.step(`No other open transaction has read ${name}, so nobody's view goes stale. Nothing blocks under SSI: the write goes ahead.`, { probe: atCard(tx.id) });
    return;
  }
  for (const o of readers) {
    note(o, row, tx);
    rec.markCell(rdId(row), o.id - 1, 'compare');
    ln(rec, 'warn', 'reader', 'note');
    rec.step(
      `${T(o.id)} has read ${name}, and ${T(tx.id)} is changing it. So ${T(o.id)}'s view of ${name} is marked stale: if ${T(tx.id)} commits, ${T(o.id)} decided on an old value. Neither waits.`,
      { probe: { text: T(tx.id), at: rdId(row), cell: o.id - 1 } },
    );
    rec.markCell(rdId(row), o.id - 1, 'idle');
  }
}

// ---- operations -----------------------------------------------------------------

function abortTxn(s: TxState, tx: Txn, rec: Rec, why: string): void {
  const threw = ROWS.filter((r) => tx.writes[r] !== undefined).map((r) => `${NAME[r]} ${short(tx.writes[r]!)}`);
  tx.status = 'aborted';
  tx.why = why;
  tx.writes = {};
  tx.pending = null;
  s.aborts++;
  rec.count('aborts');
  rec.unmark(card(tx.id));
  ln(rec, 'abort');
  rec.step(
    `${T(tx.id)} is aborted. ` +
      (threw.length ? `Its private write${threw.length === 1 ? '' : 's'} (${list(threw)}) ${threw.length === 1 ? 'is' : 'are'} thrown away, so no one ever sees ${threw.length === 1 ? 'it' : 'them'}.` : `It had written nothing, so nothing is undone.`),
    { probe: atCard(tx.id) },
  );
  if (s.method === '2PL') release(s, tx, rec);
}

export function begin(s: TxState, t: number, rec: Rec): boolean {
  ln(rec, 'open');
  if (!IDS.includes(t as 1 | 2 | 3)) {
    rec.step(`This page has three transactions, T1 to T3. There is no ${T(t)}.`);
    return false;
  }
  if (isOpen(s.txns[t])) {
    rec.step(`${T(t)} is already open. Commit or abort it before beginning it again.`, { probe: atCard(t) });
    return false;
  }
  const tx: Txn = { id: t, status: 'active', snapshot: s.clock, reads: {}, writes: {}, stale: [], pending: null, why: null, commitTs: null };
  s.txns[t] = tx;
  follow(rec, s, t);
  const who = OWNER[t] ? `${T(t)} is ${NAME[OWNER[t]!]}'s request to go off call.` : `${T(t)} belongs to no doctor.`;
  ln(rec, 'begin');
  rec.step(
    s.method === '2PL'
      ? `${who} It begins holding no locks, in its growing phase: it will lock each row before touching it, and release nothing until it ends.`
      : `${who} It begins with a snapshot at timestamp ${s.clock}: it will see every commit up to ${s.clock} and none after, and no read of it will ever wait.`,
    { probe: atCard(t) },
  );
  return true;
}

/** Read one row. Returns the value, or null when the transaction must wait, was aborted, or could not read. */
export function read(s: TxState, t: number, rowArg: number | string, rec: Rec): number | null {
  ln(rec, 'txn');
  const row = asRow(rowArg);
  const problem = notOpen(s, t, 'read') ?? (row ? null : `There is no doctor called "${rowArg}". The table has Alice and Bob.`);
  if (problem) {
    rec.step(problem, isOpen(s.txns[t]) ? { probe: atCard(t) } : {});
    return null;
  }
  const tx = s.txns[t]!;
  const name = NAME[row!];
  follow(rec, s, t);
  if (tx.writes[row!] !== undefined) {
    ln(rec, 'own');
    rec.step(`${T(t)} has already written ${name}, so it reads its own new value: ${flag(tx.writes[row!]!)}. No lock or snapshot is needed for that.`, { probe: atCard(t) });
    return tx.writes[row!]!;
  }
  let value: number;
  if (s.method === '2PL') {
    ln(rec, 'lock_s');
    rec.step(`Before reading ${name}, ${T(t)} must hold a shared lock on it.`, { probe: { text: T(t), at: sId(row!), cell: t - 1 } });
    if (!acquire(s, tx, row!, 'S', 0, rec)) {
      follow(rec, s, t);
      ln(rec, 'blocked');
      rec.step(
        tx.status === 'aborted'
          ? `The read never happens: ${T(t)} was aborted to break the deadlock. The application must retry the whole transaction.`
          : `${T(t)} is blocked. The read finishes when the lock is granted.`,
        { probe: atCard(t) },
      );
      return null;
    }
    value = latest(s, row!);
    tx.reads[row!] = value;
    rec.markCell(rowId(row!), 1, 'path');
    ln(rec, 'latest', 'record');
    rec.step(`${T(t)} reads ${name}: ${flag(value)}, the latest committed value. Its shared lock stays until it ends, so no one can change ${name} under it.`, {
      probe: { text: T(t), at: rowId(row!), cell: 1 },
    });
    rec.unmark(rowId(row!));
    return value;
  }
  ln(rec, 'snap');
  rec.step(`${T(t)} reads ${name} from its snapshot, as of timestamp ${tx.snapshot}. There are no locks, so it never waits for anyone.`, { probe: atCard(t) });
  value = snapshotRead(s, tx, row!, rec);
  tx.reads[row!] = value;
  ln(rec, 'record');
  rec.step(
    `${T(t)} reads ${name}: ${flag(value)}. The database also records that ${T(t)} read ${name}. PostgreSQL calls this a SIREAD lock: it blocks no one, but a later write to ${name} is checked against it.`,
    { probe: { text: T(t), at: rdId(row!), cell: t - 1 } },
  );
  rec.unmark(rowId(row!));
  return value;
}

/** Write one row. Returns false when the transaction must wait, was aborted, or could not write. */
export function write(s: TxState, t: number, rowArg: number | string, valueArg: number | string, rec: Rec): boolean {
  ln(rec, 'txn');
  const row = asRow(rowArg);
  const value = Number(valueArg);
  const problem =
    notOpen(s, t, 'write') ??
    (row ? null : `There is no doctor called "${rowArg}". The table has Alice and Bob.`) ??
    (value === 0 || value === 1 ? null : `The on-call flag is 1 (on call) or 0 (off call), not ${valueArg}.`);
  if (problem) {
    rec.step(problem, isOpen(s.txns[t]) ? { probe: atCard(t) } : {});
    return false;
  }
  const tx = s.txns[t]!;
  const name = NAME[row!];
  follow(rec, s, t);
  if (s.method === '2PL') {
    ln(rec, 'lock_x');
    rec.step(`To write ${name}, ${T(t)} needs the exclusive lock on it: no other transaction may hold any lock on ${name}.`, { probe: { text: T(t), at: xId(row!) } });
    if (!acquire(s, tx, row!, 'X', value, rec)) {
      follow(rec, s, t);
      ln(rec, 'blocked');
      rec.step(
        tx.status === 'aborted'
          ? `The write never happens: ${T(t)} was aborted to break the deadlock. The application must retry the whole transaction.`
          : `${T(t)} is blocked. The write finishes when the lock is granted.`,
        { probe: atCard(t) },
      );
      return false;
    }
  } else {
    warnReaders(s, tx, row!, rec);
  }
  tx.writes[row!] = value;
  follow(rec, s, t);
  ln(rec, 'buffer');
  rec.step(`${T(t)} writes ${name} ${flag(value)}. The new value stays private to ${T(t)} until it commits.`, {
    probe: s.method === '2PL' ? { text: T(t), at: xId(row!) } : { text: T(t), at: wrId(row!), cell: t - 1 },
  });
  return true;
}

/** Commit. Under SSI the transaction is checked first and may be aborted instead. Returns true if it committed. */
export function commit(s: TxState, t: number, rec: Rec): boolean {
  ln(rec, 'txn');
  const problem = notOpen(s, t, 'commit');
  if (problem) {
    rec.step(problem, isOpen(s.txns[t]) ? { probe: atCard(t) } : {});
    return false;
  }
  const tx = s.txns[t]!;
  follow(rec, s, t);

  if (s.method === 'SSI') {
    if (!tx.stale.length) {
      ln(rec, 'validate', 'valid');
      rec.step(`Before ${T(t)} commits, the database checks its stale reads. It has none: nothing ${T(t)} read has been changed by a concurrent transaction. It passes.`, { probe: atCard(t) });
    } else {
      ln(rec, 'validate', 'check');
      rec.step(`Before ${T(t)} commits, the database checks every stale read it noted: has the transaction that changed that row committed?`, { probe: atCard(t) });
      for (const m of tx.stale) {
        const done = m.by.status === 'committed';
        const name = NAME[m.row];
        rec.markEdge(`w${t}-${m.by.id}`, 'compare');
        ln(rec, 'check', ...(done ? ['stale'] : []));
        rec.compare(`${name}: ${T(m.by.id)} ${m.by.status}`, done ? '=' : '≠', 'committed', done ? `stale read: abort ${T(t)}` : 'harmless so far', {
          probe: atGraph(t, m.by.id),
          message: done
            ? `${T(m.by.id)} committed a new ${name} that ${T(t)} never saw. ${T(t)} made its decision on the old value, so letting it commit could break a rule that each transaction kept on its own.`
            : m.by.status === 'aborted'
              ? `${T(m.by.id)} was aborted, so its change to ${name} never happened. This read is fine.`
              : `${T(m.by.id)} has not committed yet. If ${T(t)} commits first, it simply comes before ${T(m.by.id)} in the serial order.`,
        });
        rec.markEdge(`w${t}-${m.by.id}`, done ? 'bad' : 'path');
        if (done) {
          ln(rec, 'fail');
          abortTxn(s, tx, rec, 'stale read');
          ln(rec, 'fail');
          rec.step(
            `${T(t)} fails with a serialization failure. The application must retry the whole transaction: repeating only the commit would not help, because its reads are out of date.`,
            { probe: atCard(t) },
          );
          return false;
        }
      }
      ln(rec, 'valid');
      rec.step(`None of the transactions that changed what ${T(t)} read has committed. ${T(t)} passes.`, { probe: atCard(t) });
    }
  }

  s.clock++;
  tx.commitTs = s.clock;
  const wrote = ROWS.filter((r) => tx.writes[r] !== undefined);
  for (const r of wrote) s.versions[r].push({ ts: s.clock, value: tx.writes[r]!, by: tx });
  // The newest version is the last cell of its row.
  for (const r of wrote) rec.markCell(rowId(r), s.method === '2PL' ? 1 : Math.min(SHOWN_VERSIONS, s.versions[r].length), 'ok');
  ln(rec, 'apply');
  rec.step(
    wrote.length
      ? `${T(t)} commits at timestamp ${s.clock}. Its write lands: ${list(wrote.map((r) => `${NAME[r]} is now ${flag(tx.writes[r]!)}`))}.`
      : `${T(t)} commits at timestamp ${s.clock}. It wrote nothing.`,
    { probe: atCard(t) },
  );
  tx.status = 'committed';
  s.commits++;
  rec.count('commits');
  rec.unmark(card(t));
  if (s.method === '2PL') release(s, tx, rec);

  follow(rec, s, t);
  const doomed = s.method === 'SSI' ? openTxns(s).filter((o) => o.stale.some((m) => m.by === tx)) : [];
  const now = onCall(s);
  ln(rec, 'committed');
  rec.step(
    `${T(t)} is committed. On call: ${now.length ? list(now.map((r) => NAME[r])) : 'nobody'}. ` +
      (now.length
        ? `The rule "at least one doctor on call" holds.`
        : `The rule is broken, and no concurrency was involved: one transaction wrote both doctors off. Serializability only promises the result of some serial order, so each transaction must keep the rule on its own.`) +
      (doomed.length ? ` ${list(doomed.map((o) => T(o.id)))} read a row ${T(t)} just changed, so ${doomed.length === 1 ? 'it' : 'they'} will fail the check at commit.` : ''),
    { probe: atCard(t) },
  );
  return true;
}

export function abort(s: TxState, t: number, rec: Rec): boolean {
  ln(rec, 'txn');
  const problem = notOpen(s, t, 'abort');
  if (problem) {
    rec.step(problem);
    return false;
  }
  const tx = s.txns[t]!;
  follow(rec, s, t);
  abortTxn(s, tx, rec, 'aborted on request');
  follow(rec, s, t);
  ln(rec, 'abort');
  rec.step(`${T(t)} is gone. Nothing it did is visible, and it holds nothing. To try again, begin it afresh or retry it.`, { probe: atCard(t) });
  return true;
}

/** Start again under `method` and run the doctors' schedule up to the commits. */
export function writeSkew(s: TxState, methodArg: number | string | undefined, rec: Rec): void {
  const method = asMethod(methodArg) ?? s.method;
  Object.assign(s, create(method));
  ln(rec, 'ws_reset');
  rec.step(
    `Start again under ${method === '2PL' ? 'two-phase locking' : 'serializable snapshot isolation'}, with both doctors on call. Alice (T1) and Bob (T2) each ask to go off call at the same moment. Each will go only if it sees two doctors on call.`,
  );
  withLead(['ws_begin'], () => IDS.slice(0, 2).forEach((t) => begin(s, t, rec)));
  const seen: Record<number, number> = {};
  withLead(['ws_read'], () => {
    for (const t of [1, 2]) seen[t] = ROWS.reduce((sum, r) => sum + (read(s, t, r, rec) ?? 0), 0);
  });
  for (const t of [1, 2]) {
    const tx = s.txns[t]!;
    follow(rec, s, t);
    const go = seen[t] >= 2;
    ln(rec, 'ws_decide', ...(go ? ['ws_write'] : []));
    rec.compare(`${T(t)} saw ${seen[t]} on call`, go ? '≥' : '<', 2, go ? `${NAME[OWNER[t]!]} may go off call` : `${NAME[OWNER[t]!]} must stay`, {
      probe: atCard(t),
      message: go
        ? `${T(t)} saw both doctors on call, so it decides ${NAME[OWNER[t]!]} can safely go off call. That decision rests on what it read.`
        : `${T(t)} did not see two doctors on call, so ${NAME[OWNER[t]!]} stays.`,
    });
    if (go && tx.status === 'active') withLead(['ws_write'], () => write(s, t, OWNER[t]!, 0, rec));
  }
  for (const i of IDS) rec.unmark(card(i));
  ln(rec, 'ws_done');
  const t1 = s.txns[1]!;
  const t2 = s.txns[2]!;
  rec.step(
    method === '2PL'
      ? t2.status === 'aborted' && t1.status === 'active'
        ? `Where things stand: T2 was aborted to break the deadlock, and T1 holds the exclusive lock on Alice with its write ready. Commit T1 next. Bob is still on call.`
        : `The schedule has run as far as it can before the commits.`
      : `Nobody waited at any point. Both transactions hold a private write, and each is marked as having read a row the other is changing. Each one alone would keep the rule; together they would break it. Commit T1, then T2.`,
  );
}

/** The application's retry: run the transaction's whole body again from the start. Returns true if it committed. */
export function retry(s: TxState, t: number, rec: Rec): boolean | null {
  ln(rec, 'r_begin');
  if (!IDS.includes(t as 1 | 2 | 3)) {
    rec.step(`This page has three transactions, T1 to T3. There is no ${T(t)}.`);
    return null;
  }
  if (isOpen(s.txns[t])) {
    rec.step(`${T(t)} is still open. A retry starts the transaction again from scratch, so commit or abort this one first.`, { probe: atCard(t) });
    return null;
  }
  const me = OWNER[t];
  rec.step(
    `Retry ${T(t)}: the application runs ${me ? `${NAME[me]}'s` : `${T(t)}'s`} whole transaction again from the start: begin, read both doctors, decide, ${me ? 'write, ' : ''}commit. It cannot just repeat the old write, because the reads that justified it may be out of date.`,
  );
  withLead(['r_begin'], () => begin(s, t, rec));
  const tx = s.txns[t]!;
  let seen = 0;
  for (const r of ROWS) {
    const v = withLead(['r_read'], () => read(s, t, r, rec));
    if (v === null) {
      ln(rec, 'r_stuck');
      rec.step(
        tx.status === 'aborted'
          ? `The retry stops: ${T(t)} was aborted again. It can be retried once more.`
          : `The retry stops here because ${T(t)} is blocked. Finish it by hand once the lock is granted: decide, write, commit.`,
        isOpen(tx) ? { probe: atCard(t) } : {},
      );
      return null;
    }
    seen += v;
  }
  follow(rec, s, t);
  if (me) {
    const go = seen >= 2;
    ln(rec, 'r_decide', ...(go ? ['r_write'] : []));
    rec.compare(`${T(t)} saw ${seen} on call`, go ? '≥' : '<', 2, go ? `${NAME[me]} may go off call` : `${NAME[me]} must stay on call`, {
      probe: atCard(t),
      message: go
        ? `${T(t)} sees two doctors on call this time, so ${NAME[me]} may go off call.`
        : `This time ${T(t)} sees only ${plural(seen, 'doctor')} on call, so ${NAME[me]} must stay. No write.`,
    });
    if (go && !withLead(['r_write'], () => write(s, t, me, 0, rec))) {
      ln(rec, 'r_stuck');
      rec.step(
        tx.status === 'aborted' ? `The retry stops: ${T(t)} was aborted again. It can be retried once more.` : `The retry stops here because ${T(t)} is blocked. Commit it by hand once the lock is granted.`,
        isOpen(tx) ? { probe: atCard(t) } : {},
      );
      return null;
    }
  } else {
    ln(rec, 'r_decide');
    rec.step(`${T(t)} belongs to no doctor, so it writes nothing. It is a report of who is on call.`, { probe: atCard(t) });
  }
  const ok = withLead(['r_commit'], () => commit(s, t, rec));
  ln(rec, 'r_commit');
  rec.step(ok ? `The retry succeeded: ${T(t)} committed with reads that were up to date.` : `The retry failed its commit check too. The application can retry again.`);
  return ok;
}

// ---- layout ------------------------------------------------------------------------

/** Committed versions drawn per row under SSI. Two-phase locking draws only the latest. */
export const SHOWN_VERSIONS = 3;
const NAME_W = 72;
const VER_W = 72;
const SLOT_W = 44;
const WIDE_W = 84;
const X_W = 96;
const QUEUE_W = 72;
const STATUS_W = 112;
const GAP = 16;
/** Two rows of the table, far enough apart for the chip above Bob to clear Alice's labels. */
const ROW_Y: Record<Row, number> = { alice: 0, bob: CELL_H + SUB_ROOM + PROBE_H + 16 + 8 };
/** Left edge of the lock table (2PL) or the read and write records (SSI): just right of the widest row. */
const lockX = (m: Method) => cellsWidth([{ text: '', w: NAME_W }, ...Array.from({ length: m === '2PL' ? 1 : SHOWN_VERSIONS }, () => ({ text: '', w: VER_W }))]) + 30;
const THREE = cellsWidth(Array.from({ length: 3 }, () => ({ text: '', w: SLOT_W })));
const CARD_Y = ROW_Y.bob + 132;
const CARD_PITCH = 200;
const G: Record<number, { x: number; y: number }> = { 1: { x: 660, y: CARD_Y + 56 }, 2: { x: 860, y: CARD_Y + 56 }, 3: { x: 760, y: CARD_Y - 26 } };
const G_R = 22;
const LEFT = -4;
const RIGHT = 926;
const TOP = -(CELL_H / 2 + PROBE_H + 16);
const BOTTOM = G[1].y + G_R + 36;

function versionCells(s: TxState, row: Row): Cell[] {
  const vs = s.versions[row];
  const shown = s.method === '2PL' ? vs.slice(-1) : vs.slice(-SHOWN_VERSIONS);
  return shown.map((v) => ({ text: short(v.value), sub: v.by ? `ts ${v.ts}, ${T(v.by.id)}` : `ts ${v.ts}`, w: VER_W }));
}

function slots(texts: string[], w: number, sub: string, subAt = 1): Cell[] {
  return texts.map((text, i) => ({ text, w, sub: i === subAt ? sub : undefined }));
}

export function layout(s: TxState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];
  const LX = lockX(s.method);
  let tableRight = 0;

  for (const row of ROWS) {
    const y = ROW_Y[row];
    const cells: Cell[] = [{ text: NAME[row], w: NAME_W }, ...versionCells(s, row)];
    const w = cellsWidth(cells);
    nodes.push({ id: rowId(row), x: w / 2, y, cells });

    if (s.method === '2PL') {
      const lock = s.locks[row];
      nodes.push({ id: sId(row), x: LX + THREE / 2, y, cells: slots(IDS.map((i) => (lock.shared.includes(i) ? T(i) : '')), SLOT_W, `S on ${NAME[row]}`) });
      const x = lock.exclusive;
      const xw = x !== null ? s.txns[x]?.writes[row] : undefined;
      const xx = LX + THREE + GAP;
      nodes.push({ id: xId(row), x: xx + X_W / 2, y, cells: [{ text: x === null ? '' : xw === undefined ? T(x) : `${T(x)}→${short(xw)}`, w: X_W, sub: `X on ${NAME[row]}` }] });
      const qx = xx + X_W + GAP;
      const q = [0, 1].map((i) => (lock.queue[i] ? `${T(lock.queue[i].id)} ${lock.queue[i].mode}` : ''));
      const qCells = slots(q, QUEUE_W, `${NAME[row]} queue`, 0);
      nodes.push({ id: qId(row), x: qx + cellsWidth(qCells) / 2, y, cells: qCells });
      tableRight = qx + cellsWidth(qCells);
    } else {
      const open = IDS.map((i) => s.txns[i]).map((tx) => (isOpen(tx) ? tx : undefined));
      nodes.push({ id: rdId(row), x: LX + THREE / 2, y, cells: slots(open.map((tx, i) => (tx && tx.reads[row] !== undefined ? T(i + 1) : '')), SLOT_W, `${NAME[row]} read by`) });
      const wCells = slots(open.map((tx, i) => (tx && tx.writes[row] !== undefined ? `${T(i + 1)}→${short(tx.writes[row]!)}` : '')), WIDE_W, `${NAME[row]}: uncommitted writes`);
      nodes.push({ id: wrId(row), x: LX + THREE + GAP + cellsWidth(wCells) / 2, y, cells: wCells });
      tableRight = LX + THREE + GAP + cellsWidth(wCells);
    }
  }

  const now = onCall(s);
  decor.push({ id: 'rule', type: 'label', x: tableRight + 20, y: -8, text: `Rule: at least one\ndoctor on call.\nNow: ${now.length ? now.map((r) => NAME[r]).join(', ') : 'nobody'}`, strong: true });

  // Transactions.
  for (const i of IDS) {
    const tx = s.txns[i];
    const status = tx ? tx.status : 'not begun';
    let title: string | undefined;
    let caption: string | undefined;
    if (tx && s.method === '2PL') {
      const held = ROWS.filter((r) => s.locks[r].exclusive === i || s.locks[r].shared.includes(i)).length;
      title = isOpen(tx) ? `growing: ${plural(held, 'lock')}` : 'released all locks';
    } else if (tx) {
      title = `snapshot ts ${tx.snapshot}`;
    }
    if (tx?.status === 'waiting' && tx.pending) caption = `wants ${tx.pending.mode} on ${NAME[tx.pending.row]}`;
    else if (tx?.status === 'active' && tx.stale.length) caption = tx.stale.slice(0, 2).map((m) => `stale: ${NAME[m.row]} (${T(m.by.id)})`).join('\n');
    else if (tx?.status === 'aborted') caption = tx.why ?? undefined;
    else if (tx?.status === 'committed') caption = `commit ts ${tx.commitTs}`;
    else if (!tx) caption = OWNER[i] ? `${NAME[OWNER[i]!]}'s request` : 'no doctor';
    nodes.push({
      id: card(i),
      x: cellsWidth([{ text: '', w: SLOT_W }, { text: '', w: STATUS_W }]) / 2 + (i - 1) * CARD_PITCH,
      y: CARD_Y,
      cells: [{ text: T(i), w: SLOT_W }, { text: status, w: STATUS_W }],
      tone: status === 'committed' ? 'ok' : status === 'aborted' ? 'bad' : status === 'not begun' ? 'dim' : undefined,
      title,
      caption,
    });
  }

  // The graph: who waits for whom (2PL), or whose read a writer made stale (SSI).
  for (const i of IDS) {
    const tx = s.txns[i];
    nodes.push({
      id: gid(i),
      x: G[i].x,
      y: G[i].y,
      cells: [{ text: T(i) }],
      shape: 'circle',
      r: G_R,
      tone: !tx ? 'dim' : tx.status === 'committed' ? 'ok' : tx.status === 'aborted' ? 'bad' : undefined,
    });
  }
  const pairs: [number, number][] = [];
  if (s.method === '2PL') {
    for (const i of IDS) for (const u of waitsFor(s, i)) pairs.push([i, u]);
  } else {
    for (const tx of openTxns(s)) {
      for (const m of tx.stale) {
        if (s.txns[m.by.id] !== m.by || m.by.status === 'aborted') continue;
        if (!pairs.some(([a, b]) => a === tx.id && b === m.by.id)) pairs.push([tx.id, m.by.id]);
      }
    }
  }
  for (const [a, b] of pairs) {
    const both = pairs.some(([c, d]) => c === b && d === a);
    edges.push({ id: `w${a}-${b}`, from: gid(a), to: gid(b), kind: 'line', arrow: true, offset: both ? 7 : 0 });
  }
  decor.push({
    id: 'graph-label',
    type: 'label',
    x: G[3].x,
    y: G[1].y + G_R + 22,
    text: s.method === '2PL' ? 'Waits-for graph' : 'Stale reads: reader → writer',
    anchor: 'middle',
    strong: true,
  });

  // Two empty labels pin the corners, so the view does not rescale as transactions come and go.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ----------------------------------------------------------------------

const TXN = { name: 'txn', label: 'Transaction (1 to 3)', kind: 'int', min: 1, max: 3 } as const;
const ROW = { name: 'doctor', label: 'Doctor (alice or bob)', kind: 'word' } as const;
const VALUE = { name: 'value', label: 'On call (1) or off (0)', kind: 'int', min: 0, max: 1 } as const;
const METHOD = { name: 'method', label: 'Method (2PL or SSI)', kind: 'word' } as const;

const active = (s: TxState) => openTxns(s).filter((tx) => tx.status === 'active');

function suggestRead(s: TxState): [number, string] {
  const a = active(s);
  if (!a.length) return [1, 'alice'];
  const tx = pick(a);
  const unread = ROWS.filter((r) => tx.reads[r] === undefined);
  return [tx.id, unread.length ? unread[0] : pick(ROWS)];
}

function suggestWrite(s: TxState): [number, string, number] {
  const a = active(s);
  if (!a.length) return [1, 'alice', 0];
  const tx = pick(a);
  return [tx.id, OWNER[tx.id] ?? pick(ROWS), 0];
}

function suggestBegin(s: TxState): number {
  const free = IDS.filter((i) => !isOpen(s.txns[i]));
  return free.length ? free[0] : 3;
}

function suggestOpen(s: TxState, which: 'active' | 'open'): number {
  const xs = which === 'active' ? active(s) : openTxns(s);
  return xs.length ? pick(xs).id : 1;
}

function suggestRetry(s: TxState): number {
  const aborted = IDS.filter((i) => s.txns[i]?.status === 'aborted');
  if (aborted.length) return aborted[0];
  return suggestBegin(s);
}

const READ_REGIONS = ['read', 'acquire', 'grantable', 'deadlock', 'abort', 'release', 'snapshot_read', 'note'];
const WRITE_REGIONS = ['write', 'acquire', 'grantable', 'deadlock', 'abort', 'release', 'warn', 'note'];
const COMMIT_REGIONS = ['commit', 'validate', 'abort', 'release', 'grantable'];

const def: StructureDef<TxState> = {
  id: 'two-phase-locking',
  params: [{ id: 'method', label: 'Method', default: 0, options: [{ value: 0, label: '2PL' }, { value: 1, label: 'SSI' }] }],
  create: (params) => create(params.method === 1 ? 'SSI' : '2PL'),
  // Two transactions open, so Read and Write have something to act on straight away.
  seed: [
    ['begin', 1],
    ['begin', 2],
  ],
  ops: [
    { id: 'read', label: 'Read', intent: 'primary', args: [TXN, ROW], code: READ_REGIONS, run: (s, [t, r], rec) => void read(s, Number(t), r, rec), suggest: (s) => suggestRead(s) },
    { id: 'write', label: 'Write', intent: 'primary', args: [TXN, ROW, VALUE], code: WRITE_REGIONS, run: (s, [t, r, v], rec) => void write(s, Number(t), r, v, rec), suggest: (s) => suggestWrite(s) },
    { id: 'begin', label: 'Begin', args: [TXN], code: ['begin'], run: (s, [t], rec) => void begin(s, Number(t), rec), suggest: (s) => [suggestBegin(s)] },
    { id: 'commit', label: 'Commit', args: [TXN], code: COMMIT_REGIONS, run: (s, [t], rec) => void commit(s, Number(t), rec), suggest: (s) => [suggestOpen(s, 'active')] },
    { id: 'abort', label: 'Abort', intent: 'danger', args: [TXN], code: ['abort', 'release', 'grantable'], run: (s, [t], rec) => void abort(s, Number(t), rec), suggest: (s) => [suggestOpen(s, 'open')] },
    {
      id: 'retry',
      label: 'Retry',
      args: [TXN],
      code: ['retry', 'begin', 'read', 'write', 'commit', 'acquire', 'grantable', 'deadlock', 'abort', 'release', 'snapshot_read', 'warn', 'note', 'validate'],
      run: (s, [t], rec) => void retry(s, Number(t), rec),
      suggest: (s) => [suggestRetry(s)],
    },
    {
      id: 'skew',
      label: 'Write skew',
      args: [METHOD],
      code: ['write_skew', 'begin', 'read', 'write', 'acquire', 'grantable', 'deadlock', 'abort', 'release', 'snapshot_read', 'warn', 'note'],
      run: (s, [m], rec) => writeSkew(s, m, rec),
      suggest: (s) => [s.method],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'waits', label: 'Waits' },
    { key: 'aborts', label: 'Aborts' },
    { key: 'commits', label: 'Commits' },
  ],
  status: (s) => {
    const open = openTxns(s);
    const now = onCall(s);
    return [
      { label: 'Method', value: s.method === '2PL' ? 'Two-phase locking' : 'Serializable snapshot isolation' },
      { label: 'On call', value: now.length ? now.map((r) => NAME[r]).join(', ') : 'nobody' },
      { label: 'Open', value: open.length ? open.map((tx) => `${T(tx.id)} ${tx.status}`).join(', ') : 'none' },
      { label: 'Committed, aborted', value: `${s.commits}, ${s.aborts}` },
    ];
  },
  tour: [
    ['skew', '2PL'],
    ['commit', 1],
    ['retry', 2],
    ['skew', 'SSI'],
    ['commit', 1],
    ['commit', 2],
    ['retry', 2],
  ],
  source: { python, java },
  info,
};

export default def;
