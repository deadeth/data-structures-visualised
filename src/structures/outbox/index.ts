import { CAPTION_ROOM, LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_GAP, CELL_H, TAG_H, TRAY_PAD } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, VarValue } from '../../core/types';
import java from './code/Outbox.java?raw';
import python from './code/outbox.py?raw';
import { info } from './info';

/**
 * The transactional outbox. A service keeps account balances in its database
 * and must tell the rest of the system about every change by publishing an
 * event to a log. Two approaches:
 *
 * - dual write: commit to the database, then publish to the log as a second,
 *   separate step. A crash between the two loses the event (or, done the other
 *   way round, publishes an event for a change that never committed).
 * - outbox: one database transaction changes the balance AND inserts the event
 *   into an `outbox` table. A relay later reads unpublished rows in order,
 *   publishes each and marks it. A relay crash between publish and mark sends
 *   the event twice, so the consumer keeps the ids it has processed and skips
 *   repeats, recording each id in the same transaction as its own change.
 *
 * The followed thing (magenta) is the event.
 */
export type Approach = 'outbox' | 'dual';

export interface Event {
  id: number;
  account: number;
  amount: number;
}

export interface Row {
  event: Event;
  published: boolean;
}

export interface LogRecord {
  event: Event;
  /** Published, but the database change it announces never committed. */
  phantom: boolean;
}

/** A database transaction in progress, drawn but not yet visible to anyone else. */
interface Pending {
  account: number;
  amount: number;
  row: Row | null;
}

/** The consumer's transaction in progress. */
interface ConsumerPending {
  account: number;
  amount: number;
  id: number | null;
}

export interface OutboxState {
  approach: Approach;
  accounts: number[];
  /** The service's business table. */
  balances: Record<number, number>;
  /** The outbox table, oldest row first. */
  outbox: Row[];
  /** One partition. Offset i holds log[i]. Nothing is ever removed. */
  log: LogRecord[];
  nextId: number;
  /** The consumer's next offset. */
  position: number;
  /** The consumer's own copy of the balances, built only from events. */
  totals: Record<number, number>;
  /** Event ids the consumer has applied, in the order it applied them. */
  processed: number[];
  /** Drawing state for the moments inside an operation. */
  inflight: Event | null;
  pending: Pending | null;
  cpending: ConsumerPending | null;
  serviceDown: boolean;
  relayDown: boolean;
  /** Page limits so the picture stays readable. */
  maxOutbox: number;
  maxLag: number;
}

export const ACCOUNTS = [42, 63, 77];
export const START: Record<number, number> = { 42: 100, 63: 50, 77: 80 };
/** Outbox rows drawn. */
export const OUTBOX_MAX = 4;
/** Log records drawn. The consumer may be at most this far behind the end. */
export const LOG_SHOWN = 5;
/** Processed ids drawn. */
export const DONE_SHOWN = 3;

export function create(approach: Approach = 'outbox', maxOutbox = OUTBOX_MAX, maxLag = LOG_SHOWN): OutboxState {
  return {
    approach,
    accounts: [...ACCOUNTS],
    balances: { ...START },
    outbox: [],
    log: [],
    nextId: 1,
    position: 0,
    totals: { ...START },
    processed: [],
    inflight: null,
    pending: null,
    cpending: null,
    serviceDown: false,
    relayDown: false,
    maxOutbox,
    maxLag,
  };
}

const ev = (e: Event | number) => `e${typeof e === 'number' ? e : e.id}`;
const payload = (e: Event) => `${e.account} +${e.amount}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A string as the listing holds it, for the Variables strip. */
const q = (x: string) => `"${x}"`;
const approachName = (a: Approach) => (a === 'outbox' ? 'outbox' : 'dual write');

export function asApproach(raw: number | string): Approach | null {
  const w = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (w === 'outbox' || w === 'transactionaloutbox') return 'outbox';
  if (w === 'dual' || w === 'dualwrite') return 'dual';
  return null;
}

/** Events on the log the consumer has not read yet. */
export const lag = (s: OutboxState) => s.log.length - s.position;
export const unpublished = (s: OutboxState) => s.outbox.filter((r) => !r.published).length;
/** Accounts where the consumer's total differs from the database. */
export function drift(s: OutboxState): { account: number; by: number }[] {
  return s.accounts.flatMap((a) => (s.totals[a] !== s.balances[a] ? [{ account: a, by: s.balances[a] - s.totals[a] }] : []));
}
const canAppend = (s: OutboxState, n: number) => lag(s) + n <= s.maxLag;

function newEvent(s: OutboxState, account: number, amount: number): Event {
  return { id: s.nextId++, account, amount };
}

// ---- ids and probes -----------------------------------------------------------

const SVC = 'svc';
const RELAY = 'relay';
const CON = 'con';
const DONE = 'done';
const POS = 'pos';
const aid = (account: number) => `a${account}`;
const oid = (id: number) => `o${id}`;
const lid = (offset: number) => `l${offset}`;
const tid = (account: number) => `t${account}`;

const atService = (e: Event): Probe => ({ text: ev(e), at: SVC, cell: 1 });
const atRow = (e: Event): Probe => ({ text: ev(e), at: oid(e.id), cell: 0 });
const atLog = (e: Event, offset: number): Probe => ({ text: ev(e), at: lid(offset) });
const atTotal = (e: Event): Probe => ({ text: ev(e), at: tid(e.account), place: 'below' });
/** The processed-ids node shows the newest few: find the cell an id sits in, if it is drawn. */
function atDone(s: OutboxState, e: Event): Probe {
  const cells = doneCells(s);
  const i = cells.indexOf(e.id);
  return i >= 0 ? { text: ev(e), at: DONE, cell: i } : { text: ev(e), at: DONE };
}

// ---- operations -----------------------------------------------------------------

function checkArgs(s: OutboxState, account: number, amount: number, rec: Rec): boolean {
  if (!s.accounts.includes(account)) {
    rec.step(`This database has three accounts: ${s.accounts.slice(0, -1).join(', ')} and ${s.accounts[s.accounts.length - 1]}. There is no account ${account}.`);
    return false;
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 99) {
    rec.step(`Enter an amount from 1 to 99.`);
    return false;
  }
  return true;
}

function noRoomForOutbox(s: OutboxState, rec: Rec): boolean {
  if (s.outbox.length < s.maxOutbox) return false;
  rec.step(
    `Sorry, this page draws at most ${s.maxOutbox} outbox rows and the table is full. Run Relay to publish them, then Prune to delete the published ones. A real outbox table has no such limit, but it does grow until something prunes it.`,
  );
  return true;
}

function noRoomOnLog(s: OutboxState, n: number, rec: Rec): boolean {
  if (canAppend(s, n)) return false;
  rec.step(
    `Sorry, this page draws at most ${s.maxLag} events the consumer has not read, and it is ${plural(lag(s), 'event')} behind. Run Consume first. A real log has no such limit.`,
  );
  return true;
}

/** Apply a committed service transaction. */
function commitService(s: OutboxState): void {
  const p = s.pending!;
  s.balances[p.account] += p.amount;
  if (p.row) s.outbox.push(p.row);
  s.pending = null;
}

function append(s: OutboxState, e: Event, rec: Rec): number {
  const dup = s.log.some((r) => r.event.id === e.id);
  s.log.push({ event: e, phantom: false });
  rec.count('published');
  if (dup) rec.count('duplicates');
  return s.log.length - 1;
}

type CrashAt = 'after_commit' | 'before_commit' | null;

/** Commit to the database, then publish as a second step. */
function writeDual(s: OutboxState, account: number, amount: number, crash: CrashAt, rec: Rec): Event | null {
  const before = s.balances[account];
  const armed = crash ? q(crash) : null;
  const txv = before + amount;
  s.pending = { account, amount, row: null };
  rec.mark(aid(account), 'path');
  rec.vars({ account, amount, 'tx.accounts[account]': txv });
  rec.line('begin');
  rec.step(`Begin a database transaction and add ${amount} to account ${account}: ${before} becomes ${before + amount}. Nobody else can see the change until it commits.`);

  commitService(s);
  rec.count('writes');
  rec.mark(aid(account), 'ok');
  rec.line('commit');
  rec.step(`Commit. Account ${account} is ${before + amount}, durably. That was step one of two, and it cannot be taken back now.`);

  const e = newEvent(s, account, amount);
  s.inflight = e;
  rec.markCell(SVC, 1, 'key');
  rec.vars({ account, amount, 'tx.accounts[account]': txv, event: ev(e) });
  rec.line('event');
  rec.step(`Build event ${ev(e)}, "${payload(e)}", in the service's memory. Until it is published it exists nowhere else.`, { probe: atService(e) });

  if (crash === 'after_commit') {
    s.serviceDown = true;
    rec.mark(SVC, 'bad');
    rec.markCell(SVC, 1, 'bad');
    rec.count('lost');
    rec.vars({ account, amount, event: ev(e), armed });
    rec.line('between');
    rec.step(
      `The service crashes here, between the two steps. The commit is on disk. The event was only in memory, so it dies with the process.`,
      { probe: atService(e) },
    );
    s.serviceDown = false;
    s.inflight = null;
    rec.unmark(SVC);
    rec.vars({ account, amount, armed: null });
    rec.line('restart');
    rec.step(
      `The service restarts. Nothing on disk says an event is owed, so nobody will ever publish ${ev(e)}. The database says account ${account} holds ${s.balances[account]}; the consumer will go on believing ${s.totals[account]}. The event is lost for good.`,
    );
    return null;
  }

  const offset = append(s, e, rec);
  s.inflight = null;
  rec.markCell(SVC, 1, 'idle');
  rec.mark(lid(offset), 'key');
  rec.vars({ account, amount, event: ev(e), 'len(log)': s.log.length });
  rec.line('publish');
  rec.step(`Publish ${ev(e)} to the log, a separate call to a separate system. It lands at offset ${offset}.`, { probe: atLog(e, offset) });

  rec.line('dual_done');
  rec.step(
    `Both steps happened this time: 1 database write, 1 publish. Nothing tied them together. A crash between them would have kept the write and lost the event.`,
    { probe: atLog(e, offset) },
  );
  return e;
}

/** One transaction: the business change and the outbox row. */
function writeOutbox(s: OutboxState, account: number, amount: number, crash: CrashAt, rec: Rec): Event | null {
  const before = s.balances[account];
  const armed = crash ? q(crash) : null;
  const txv = before + amount;
  s.pending = { account, amount, row: null };
  rec.mark(aid(account), 'path');
  rec.vars({ account, amount, 'tx.accounts[account]': txv });
  rec.line('tx_begin');
  rec.step(`Begin one database transaction and add ${amount} to account ${account}: ${before} becomes ${before + amount}, not yet committed.`);

  const e = newEvent(s, account, amount);
  s.pending.row = { event: e, published: false };
  rec.markCell(oid(e.id), 0, 'key');
  rec.vars({ account, amount, 'tx.accounts[account]': txv, event: ev(e) });
  rec.line('tx_outbox');
  rec.step(
    `In the same transaction, insert ${ev(e)}, "${payload(e)}", into the outbox table, marked unpublished. The event is a row in the same database as the change it describes.`,
    { probe: atRow(e) },
  );

  if (crash === 'before_commit') {
    s.serviceDown = true;
    rec.mark(SVC, 'bad');
    rec.vars({ account, amount, event: ev(e), armed });
    rec.line('before_commit');
    rec.step(`The service crashes before COMMIT.`, { probe: atRow(e) });
    rec.mark(aid(account), 'bad');
    rec.mark(oid(e.id), 'bad');
    rec.markCell(oid(e.id), 0, 'bad');
    rec.vars({ account, amount, armed: null });
    rec.line('restart_before');
    rec.step(
      `The database rolls the transaction back: the change to account ${account} and the outbox row vanish together. No event without the write, no write without the event. The caller gets an error and can retry.`,
      { probe: atRow(e) },
    );
    s.pending = null;
    s.serviceDown = false;
    rec.unmark(SVC);
    rec.unmark(aid(account));
    rec.unmark(oid(e.id));
    rec.step(`Account ${account} is still ${before}. Nothing was written, so nothing was lost. ${ev(e)} is never used again, as a database sequence skips a number after a rollback.`);
    return null;
  }

  commitService(s);
  rec.count('writes');
  rec.mark(aid(account), 'ok');
  rec.line('tx_commit');
  rec.step(`Commit. The new balance and the outbox row become durable in one step: both or neither.`, { probe: atRow(e) });

  if (crash === 'after_commit') {
    s.serviceDown = true;
    rec.mark(SVC, 'bad');
    rec.vars({ account, amount, event: ev(e), armed });
    rec.line('after_commit');
    rec.step(`The service crashes straight after the commit, the same moment that lost the event in dual write.`, { probe: atRow(e) });
    s.serviceDown = false;
    rec.unmark(SVC);
    rec.vars({ account, amount, armed: null });
    rec.line('restart');
    rec.step(
      `Nothing is lost. ${ev(e)} is a committed row, marked unpublished, and the relay will find it. The service did not have to survive for its event to go out.`,
      { probe: atRow(e) },
    );
    return e;
  }

  rec.line('tx_done');
  rec.step(
    `Done: 1 transaction, 0 calls to the broker. ${ev(e)} waits in the outbox until the relay publishes it. The outbox now has ${plural(unpublished(s), 'unpublished row')}.`,
    { probe: atRow(e) },
  );
  return e;
}

/** Dual write the other way round: publish first, then the commit fails. */
function publishFirst(s: OutboxState, account: number, amount: number, rec: Rec): void {
  const before = s.balances[account];
  const armed = q('before_commit');
  const e = newEvent(s, account, amount);
  s.inflight = e;
  rec.markCell(SVC, 1, 'key');
  rec.vars({ account, amount, event: ev(e) });
  rec.line('pf_event');
  rec.step(`Dual write, publishing first this time. Build event ${ev(e)}, "${payload(e)}".`, { probe: atService(e) });

  const offset = append(s, e, rec);
  s.inflight = null;
  rec.markCell(SVC, 1, 'idle');
  rec.mark(lid(offset), 'key');
  rec.vars({ account, amount, event: ev(e), 'len(log)': s.log.length });
  rec.line('pf_publish');
  rec.step(`Publish ${ev(e)} before touching the database. It is at offset ${offset}, and any consumer may read it from now on.`, { probe: atLog(e, offset) });

  s.pending = { account, amount, row: null };
  rec.mark(aid(account), 'path');
  rec.vars({ account, amount, event: ev(e), 'tx.accounts[account]': before + amount });
  rec.line('pf_begin');
  rec.step(`Begin the database transaction and add ${amount} to account ${account}.`, { probe: atLog(e, offset) });

  s.serviceDown = true;
  rec.mark(SVC, 'bad');
  rec.vars({ account, amount, event: ev(e), armed });
  rec.line('pf_fail');
  rec.step(`The service crashes before COMMIT. A deadlock or a broken constraint would end the same way: the commit fails.`, { probe: atLog(e, offset) });

  s.pending = null;
  s.serviceDown = false;
  s.log[offset].phantom = true;
  rec.count('phantom');
  rec.unmark(SVC);
  rec.mark(aid(account), 'bad');
  rec.mark(lid(offset), 'bad');
  rec.vars({ account, amount, armed: null });
  rec.line('restart_before');
  rec.step(
    `The database rolls back: account ${account} stays ${before}. But ${ev(e)} is already on the log, announcing a change that never happened. That is a phantom event, and the consumer will apply it. Retrying the write would publish a second event for the same money.`,
    { probe: atLog(e, offset) },
  );
}

/** A normal write, by whichever approach is chosen. */
export function write(s: OutboxState, account: number, amount: number, rec: Rec): Event | null {
  rec.vars({ account, amount, approach: q(s.approach) });
  rec.line('choose');
  if (!checkArgs(s, account, amount, rec)) return null;
  if (s.approach === 'outbox' ? noRoomForOutbox(s, rec) : noRoomOnLog(s, 1, rec)) return null;
  rec.step(
    s.approach === 'outbox'
      ? `Write: account ${account} receives ${amount}. The approach is outbox, so the change and its event go into one database transaction.`
      : `Write: account ${account} receives ${amount}. The approach is dual write: commit to the database, then publish to the log as a separate step.`,
  );
  return s.approach === 'outbox' ? writeOutbox(s, account, amount, null, rec) : writeDual(s, account, amount, null, rec);
}

/** The service dies straight after its database commit. */
export function crashBetween(s: OutboxState, account: number, amount: number, rec: Rec): Event | null {
  rec.vars({ account, amount, armed: q('after_commit') });
  rec.line('arm');
  if (!checkArgs(s, account, amount, rec)) return null;
  if (s.approach === 'outbox' && noRoomForOutbox(s, rec)) return null;
  rec.step(
    `Write ${amount} to account ${account}, and make the service crash straight after its database commit. The approach is ${approachName(s.approach)}.`,
  );
  return s.approach === 'outbox' ? writeOutbox(s, account, amount, 'after_commit', rec) : writeDual(s, account, amount, 'after_commit', rec);
}

/** The service dies inside its transaction. Dual write publishes first, so the event escapes. */
export function crashBefore(s: OutboxState, account: number, amount: number, rec: Rec): void {
  rec.vars({ account, amount, armed: q('before_commit'), approach: q(s.approach) });
  rec.line('arm_before');
  if (!checkArgs(s, account, amount, rec)) return;
  if (s.approach === 'outbox' ? noRoomForOutbox(s, rec) : noRoomOnLog(s, 1, rec)) return;
  rec.step(
    s.approach === 'outbox'
      ? `Write ${amount} to account ${account}, and make the service crash before its transaction commits.`
      : `Write ${amount} to account ${account}, and make the service crash before its database commit. In dual write either order is possible; this run publishes first.`,
  );
  if (s.approach === 'outbox') writeOutbox(s, account, amount, 'before_commit', rec);
  else publishFirst(s, account, amount, rec);
}

/** Publish unpublished rows in outbox order. Returns how many were published and marked, and whether it crashed. */
function relayRun(s: OutboxState, crash: boolean, rec: Rec, armed?: VarValue): { marked: number; crashed: boolean } {
  const rows = s.outbox.filter((r) => !r.published);
  const ids = rows.map((r) => ev(r.event));
  rec.vars({ armed, rows: ids });
  rec.line('query');
  if (!rows.length) {
    rec.step(
      s.outbox.length
        ? `The relay polls the outbox for unpublished rows, oldest first. Every row is already published, so there is nothing to send.`
        : `The relay polls the outbox for unpublished rows. The table is empty: nothing to send.`,
    );
    return { marked: 0, crashed: false };
  }
  for (const r of rows) rec.mark(oid(r.event.id), 'path');
  rec.step(
    `The relay polls the outbox: unpublished rows, oldest first. It finds ${rows.map((r) => ev(r.event)).join(', ')}.`,
    { probe: atRow(rows[0].event) },
  );
  let marked = 0;
  for (const r of rows) {
    const e = r.event;
    if (!canAppend(s, 1)) {
      rec.line('query');
      rec.step(
        `Sorry, this page draws at most ${s.maxLag} events the consumer has not read, so the relay stops here. Run Consume, then Relay again. A real log has no such limit.`,
        { probe: atRow(e) },
      );
      break;
    }
    const again = s.log.some((x) => x.event.id === e.id);
    const offset = append(s, e, rec);
    rec.markCell(oid(e.id), 0, 'key');
    rec.mark(lid(offset), 'key');
    rec.vars({ armed, rows: ids, row: ev(e), 'row["published"]': false });
    rec.line('relay_publish');
    rec.step(
      again
        ? `Publish ${ev(e)} again, at offset ${offset}. The log now holds ${ev(e)} twice. The broker cannot tell it is a repeat: to the log it is just another record.`
        : `Publish ${ev(e)}, "${payload(e)}", to the log at offset ${offset}. A real relay would key the record by account ${e.account}, so all of that account's events share a partition and keep their order.`,
      { probe: atLog(e, offset) },
    );
    if (crash) {
      s.relayDown = true;
      rec.mark(RELAY, 'bad');
      rec.line('relay_crash');
      rec.step(
        `The relay crashes after the broker accepted ${ev(e)} and before it marked the row. In the outbox, ${ev(e)} is still unpublished.`,
        { probe: atRow(e) },
      );
      return { marked, crashed: true };
    }
    r.published = true;
    marked++;
    rec.unmark(oid(e.id));
    rec.unmark(lid(offset));
    rec.markCell(oid(e.id), 0, 'key');
    rec.markCell(oid(e.id), 1, 'ok');
    rec.vars({ armed, rows: ids, row: ev(e), 'row["published"]': true });
    rec.line('mark');
    rec.step(`Mark ${ev(e)} published: a one-row update in the database. The relay will not send it again.`, { probe: atRow(e) });
    rec.markCell(oid(e.id), 0, 'idle');
  }
  return { marked, crashed: false };
}

export function relay(s: OutboxState, rec: Rec): number {
  rec.vars();
  const { marked } = relayRun(s, false, rec);
  if (marked) {
    rec.vars({ 'len(rows)': marked });
    rec.line('relay_done');
    rec.step(
      `Relayed ${plural(marked, 'event')} in outbox order, which is commit order, so events for one account reach the log in the order they happened. The relay needed nothing from the service: only the database.`,
    );
  }
  return marked;
}

export function crashRelay(s: OutboxState, rec: Rec): number {
  rec.vars({ armed: q('relay') });
  rec.line('relay_arm');
  rec.step(`Make the relay crash between publishing a row and marking it published.`);
  const first = relayRun(s, true, rec, q('relay'));
  if (!first.crashed) {
    rec.vars({ armed: null });
    rec.line('relay_restart');
    rec.step(`There was no unpublished row, so there was nothing to crash on. Write something first.`);
    return 0;
  }
  s.relayDown = false;
  rec.unmark(RELAY);
  rec.clearMarks();
  rec.vars({ armed: null });
  rec.line('relay_restart');
  rec.step(`The relay restarts. It keeps no memory of what it sent: the outbox is its only record, and the outbox says nothing was sent.`);
  const second = relayRun(s, false, rec, null);
  rec.vars({ armed: null, 'len(rows)': second.marked });
  rec.line('relay_done');
  rec.step(
    `Relayed ${plural(second.marked, 'event')}, one of them for the second time. This is at-least-once delivery: an event is never lost, but it can arrive twice. Every consumer must cope with that.`,
  );
  return second.marked;
}

/** Read one event and apply it unless its id was processed before. Returns null when caught up. */
function consumeOne(s: OutboxState, rec: Rec): 'applied' | 'skipped' | null {
  const pos = s.position;
  const end = s.log.length;
  rec.vars({ position: pos, 'len(log)': end });
  rec.line('caught_up');
  if (pos >= end) {
    rec.mark(lid(pos), 'compare');
    rec.compare(`pos ${pos}`, '=', `end ${end}`, 'nothing new to read', {
      message: `The consumer's position is offset ${pos}, the end of the log. Nothing new has been published.`,
    });
    rec.unmark(lid(pos));
    return null;
  }
  rec.mark(lid(pos), 'compare');
  rec.compare(`pos ${pos}`, '<', `end ${end}`, 'an event is waiting', {
    message: `The consumer's position is offset ${pos}, and the log ends at ${end}: there is an event to read.`,
  });
  const record = s.log[pos];
  const e = record.event;
  rec.mark(lid(pos), 'key');
  rec.vars({ position: pos, event: ev(e) });
  rec.line('read');
  rec.step(
    `Read offset ${pos}: ${ev(e)}, "${payload(e)}".` + (record.phantom ? ` The consumer cannot know this one is a phantom: it looks like any other event.` : ``),
    { probe: atLog(e, pos) },
  );

  const seen = s.processed.includes(e.id);
  rec.vars({ position: pos, event: ev(e), 'event.id in processed': seen });
  rec.line('seen');
  if (seen) {
    const probe = atDone(s, e);
    if (probe.cell !== undefined) rec.markCell(DONE, probe.cell, 'compare');
    rec.compare(ev(e), '=', `${ev(e)} in processed`, 'seen before: skip it', {
      message: `Look ${ev(e)} up in the processed-ids table. It is there: this event was applied already.`,
      probe,
    });
    if (probe.cell !== undefined) rec.markCell(DONE, probe.cell, 'idle');
    s.position = pos + 1;
    rec.mark(lid(pos), 'path');
    rec.vars({ position: pos + 1, event: ev(e), 'event.id in processed': seen });
    rec.line('skip');
    rec.step(
      `Skip it. Account ${e.account}'s total stays ${s.totals[e.account]}, and duplicates applied stay at 0. Move on to offset ${pos + 1}.`,
      { probe: atLog(e, pos) },
    );
    rec.unmark(lid(pos));
    return 'skipped';
  }
  rec.compare(ev(e), '≠', 'every processed id', 'new: apply it', {
    message: `Look ${ev(e)} up in the processed-ids table. It is not there, so this is the first time the consumer sees it.`,
    probe: { text: ev(e), at: DONE },
  });

  const before = s.totals[e.account];
  s.cpending = { account: e.account, amount: e.amount, id: null };
  rec.mark(tid(e.account), 'path');
  rec.vars({ position: pos, event: ev(e), 'tx.totals[event.account]': before + e.amount });
  rec.line('apply');
  rec.step(
    `Begin a transaction in the consumer's own database and add ${e.amount} to its total for account ${e.account}: ${before} becomes ${before + e.amount}.`,
    { probe: atTotal(e) },
  );

  s.cpending.id = e.id;
  const cell = doneCells(s).indexOf(e.id);
  rec.markCell(DONE, cell, 'key');
  rec.line('record');
  rec.step(`In the same transaction, insert ${ev(e)} into the processed-ids table.`, { probe: atDone(s, e) });

  s.totals[e.account] = before + e.amount;
  s.processed.push(e.id);
  s.cpending = null;
  s.position = pos + 1;
  rec.mark(tid(e.account), 'ok');
  rec.markCell(DONE, doneCells(s).indexOf(e.id), 'ok');
  rec.mark(lid(pos), 'path');
  rec.vars({ position: pos + 1, event: ev(e), 'tx.totals[event.account]': before + e.amount });
  rec.line('commit_c');
  rec.step(
    `Commit both together, then move to offset ${pos + 1}. A crash before this commit loses both, so the event is simply read again. A crash after it leaves the id recorded, so a second copy is skipped.`,
    { probe: atTotal(e) },
  );
  rec.clearMarks();
  return 'applied';
}

export function consume(s: OutboxState, count: number | string, rec: Rec): { applied: number; skipped: number } {
  const n = Number(count);
  rec.vars();
  rec.line('caught_up');
  if (!Number.isInteger(n) || n < 1 || n > LOG_SHOWN) {
    rec.step(`Read from 1 to ${LOG_SHOWN} events at a time.`);
    return { applied: 0, skipped: 0 };
  }
  let applied = 0;
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const r = consumeOne(s, rec);
    if (r === null) break;
    if (r === 'applied') applied++;
    else skipped++;
  }
  const off = drift(s);
  const state = off.length
    ? `Its totals still differ from the database: ${off.map((d) => `account ${d.account} by ${Math.abs(d.by)}`).join(', ')}. ${off.some((d) => d.by > 0) ? 'An event that was never published cannot be replayed.' : 'A phantom event changed a total the database never changed.'}`
    : lag(s) || unpublished(s)
      ? `Its totals will match the database once it has read everything.`
      : `Its totals match the database exactly.`;
  rec.step(
    applied + skipped === 0
      ? `The consumer is caught up. ${state}`
      : `Read ${plural(applied + skipped, 'event')}: applied ${applied}, skipped ${plural(skipped, 'duplicate')}. ${state}`,
  );
  return { applied, skipped };
}

export function prune(s: OutboxState, rec: Rec): number {
  const kept: string[] = [];
  rec.vars({ 'len(outbox)': s.outbox.length, kept });
  rec.line('prune_each');
  if (!s.outbox.length) {
    rec.step(`The outbox table is empty. Nothing to prune.`);
    return 0;
  }
  rec.step(`Prune: delete outbox rows the relay has already published. Without this the table grows by one row for every write, for ever.`);
  for (const r of s.outbox) {
    const e = r.event;
    rec.mark(oid(e.id), 'compare');
    rec.vars({ 'len(outbox)': s.outbox.length, kept: [...kept], row: ev(e), 'row["published"]': r.published });
    if (!r.published) kept.push(ev(e));
    rec.line('prune_check');
    if (r.published) {
      rec.compare(`${ev(e)} published`, '=', 'yes', 'delete it', { probe: atRow(e) });
      rec.mark(oid(e.id), 'bad');
    } else {
      rec.vars({ 'len(outbox)': s.outbox.length, kept: [...kept], row: ev(e), 'row["published"]': r.published });
      rec.line('prune_check', 'prune_keep');
      rec.compare(`${ev(e)} published`, '=', 'no', 'keep it: the relay still owes it', { probe: atRow(e) });
      rec.mark(oid(e.id), 'path');
    }
  }
  const before = s.outbox.length;
  s.outbox = s.outbox.filter((r) => !r.published);
  const removed = before - s.outbox.length;
  rec.count('pruned', removed);
  rec.clearMarks();
  rec.vars({ 'len(outbox)': before, kept, removed });
  rec.line('prune_delete');
  rec.step(
    removed
      ? `Deleted ${plural(removed, 'row')}. ${s.outbox.length ? `${plural(s.outbox.length, 'unpublished row')} stay${s.outbox.length === 1 ? 's' : ''}.` : 'The table is empty.'} The events themselves are untouched: they live on the log now.`
      : `Every row is still waiting for the relay, so nothing was deleted.`,
  );
  return removed;
}

export function setApproach(s: OutboxState, raw: number | string, rec: Rec): void {
  const a = asApproach(raw);
  rec.vars({ approach: q(a ?? String(raw).trim()) });
  rec.line('set');
  if (!a) {
    rec.step(`There are two approaches: dual or outbox.`);
    return;
  }
  if (a === s.approach) {
    rec.step(`The approach is already ${approachName(a)}.`);
    return;
  }
  s.approach = a;
  rec.step(
    a === 'outbox'
      ? `From now on, writes use the outbox: one transaction holds the change and its event, and the relay publishes. Rows already in the outbox are unaffected.`
      : `From now on, writes use dual write: commit to the database, then publish to the log. Two systems, two steps, no transaction across them.`,
  );
}

// ---- layout -----------------------------------------------------------------------

const SVC_X = 70;
const ROW_A = 0;
const ROW_B = 100;
const ROW_C = 230;
const LABEL_X = 172;
const X0 = 250;
const ACC_W = 60;
const ACC_PITCH = 68;
const EID_W = 50;
const FLAG_W = 36;
const OUT_W = TRAY_PAD * 2 + CELL_GAP + EID_W + FLAG_W;
const OUT_PITCH = 100;
const LOG_W = 60;
const LOG_PITCH = 84;
const CX = 855;
const TOT_W = 50;
const TOT_PITCH = 56;
const DONE_W = 46;
const DB_RIGHT = X0 + OUT_PITCH * OUTBOX_MAX + OUT_W + 12;
const CON_LEFT = 766;
const RIGHT = 944;
const TOP = ROW_A - CELL_H / 2 - PROBE_H - 16;
const TAG_Y = ROW_C + CELL_H / 2 + SUB_ROOM + CAPTION_ROOM + 2 + TAG_H / 2;
const BOTTOM = TAG_Y + TAG_H / 2;

/** The newest processed ids, padded with empty slots, including one being recorded. */
function doneCells(s: OutboxState): (number | null)[] {
  const ids = [...s.processed];
  if (s.cpending?.id != null) ids.push(s.cpending.id);
  const shown: (number | null)[] = ids.slice(-DONE_SHOWN);
  while (shown.length < DONE_SHOWN) shown.push(null);
  return shown;
}

export function layout(s: OutboxState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];

  decor.push({ id: 'db', type: 'band', x: LABEL_X - 12, y: ROW_A - CELL_H / 2 - 12, w: DB_RIGHT - LABEL_X + 12, h: ROW_B + 76 - (ROW_A - CELL_H / 2 - 12) });
  decor.push({ id: 'db-label', type: 'label', x: LABEL_X, y: ROW_B + 58, text: 'database' });
  decor.push({ id: 'acc-label', type: 'label', x: LABEL_X, y: ROW_A, text: 'accounts' });
  decor.push({ id: 'out-label', type: 'label', x: LABEL_X, y: ROW_B, text: 'outbox' });
  decor.push({ id: 'log-label', type: 'label', x: LABEL_X, y: ROW_C, text: 'log' });
  decor.push({ id: 'cdb', type: 'band', x: CON_LEFT, y: ROW_A + 40, w: RIGHT - CON_LEFT, h: ROW_C + 72 - (ROW_A + 40), label: 'its own database' });

  // The service: its name, and the event it holds in memory during a dual write.
  nodes.push({
    id: SVC,
    x: SVC_X,
    y: ROW_A,
    cells: [{ text: 'service', w: 84 }, { text: s.inflight ? ev(s.inflight) : '', w: 48 }],
    caption: s.serviceDown ? 'crashed' : approachName(s.approach),
  });
  nodes.push({ id: RELAY, x: SVC_X, y: ROW_C, cells: [{ text: 'relay', w: 100 }], caption: s.relayDown ? 'crashed' : 'polls the outbox' });
  nodes.push({ id: CON, x: CX, y: ROW_A, cells: [{ text: 'consumer', w: 130 }] });

  // The business table. A change inside an open transaction is drawn, but nobody else can see it yet.
  s.accounts.forEach((a, i) => {
    const staged = s.pending?.account === a;
    nodes.push({
      id: aid(a),
      x: X0 + ACC_W / 2 + i * ACC_PITCH,
      y: ROW_A,
      cells: [{ text: String(s.balances[a] + (staged ? s.pending!.amount : 0)), sub: String(a), w: ACC_W }],
    });
  });

  // The outbox: committed rows, a row inside an open transaction, then an empty slot for the next.
  const rows: { row: Row; staged: boolean }[] = s.outbox.map((row) => ({ row, staged: false }));
  if (s.pending?.row) rows.push({ row: s.pending.row, staged: true });
  rows.forEach(({ row, staged }, j) => {
    nodes.push({
      id: oid(row.event.id),
      x: X0 + OUT_W / 2 + j * OUT_PITCH,
      y: ROW_B,
      tone: staged ? 'path' : undefined,
      cells: [
        { text: ev(row.event), sub: payload(row.event), subValue: true, w: EID_W },
        { text: row.published ? '✓' : '', w: FLAG_W, tone: row.published ? 'ok' : undefined },
      ],
    });
  });
  if (rows.length < s.maxOutbox && rows.length < OUTBOX_MAX + 1) {
    nodes.push({ id: oid(s.nextId), x: X0 + OUT_W / 2 + rows.length * OUT_PITCH, y: ROW_B, cells: [{ text: '', w: EID_W }, { text: '', w: FLAG_W }] });
  }

  // The log: the newest records and the slot the next one will fill. The consumer is never further back than that.
  const from = Math.max(0, s.log.length - LOG_SHOWN);
  for (let o = from; o <= s.log.length; o++) {
    const r = s.log[o];
    nodes.push({
      id: lid(o),
      x: X0 + LOG_W / 2 + (o - from) * LOG_PITCH,
      y: ROW_C,
      cells: [{ text: r ? ev(r.event) : '', sub: String(o), w: LOG_W }],
      tone: r?.phantom ? 'bad' : undefined,
      caption: r ? payload(r.event) : undefined,
    });
  }
  const at = Math.max(s.position, from);
  nodes.push({ id: POS, x: X0 + LOG_W / 2 + (at - from) * LOG_PITCH, y: TAG_Y, cells: [{ text: 'pos' }], shape: 'tag' });

  // The consumer's database: its totals, and the ids it has applied.
  s.accounts.forEach((a, i) => {
    const staged = s.cpending?.account === a;
    nodes.push({
      id: tid(a),
      x: CX + (i - (s.accounts.length - 1) / 2) * TOT_PITCH,
      y: ROW_B,
      cells: [{ text: String(s.totals[a] + (staged ? s.cpending!.amount : 0)), sub: String(a), w: TOT_W }],
    });
  });
  const hidden = Math.max(0, s.processed.length + (s.cpending?.id != null ? 1 : 0) - DONE_SHOWN);
  nodes.push({
    id: DONE,
    x: CX,
    y: ROW_C,
    cells: doneCells(s).map((id) => ({ text: id === null ? '' : ev(id), w: DONE_W })),
    caption: hidden ? `processed ids\n+${hidden} older` : 'processed ids',
  });

  // Two empty labels pin the corners, so the scene keeps its size.
  decor.push({ id: 'corner-a', type: 'label', x: -2, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -------------------------------------------------------------------

const ACCOUNT = { name: 'account', label: 'Account (42, 63 or 77)', kind: 'int', min: 0, max: 999 } as const;
const AMOUNT = { name: 'amount', label: 'Amount', kind: 'int', min: 1, max: 99 } as const;

const pick = <T,>(xs: T[]): T => xs[randomInt(0, xs.length - 1)];
const suggestWrite = (): [number, number] => [pick(ACCOUNTS), randomInt(1, 8) * 5];

/** The seed for dual write: the same two writes, published directly, and read. */
const DUAL_SEED: [string, ...(number | string)[]][] = [
  ['write', 63, 20],
  ['write', 77, 15],
  ['consume', 2],
];

export const APPROACH_PARAM: Record<Approach, number> = { outbox: 0, dual: 1 };

const def: StructureDef<OutboxState> = {
  id: 'outbox',
  params: [
    {
      id: 'approach',
      label: 'Approach',
      default: APPROACH_PARAM.outbox,
      options: [
        { value: APPROACH_PARAM.outbox, label: 'outbox' },
        { value: APPROACH_PARAM.dual, label: 'dual write' },
      ],
    },
  ],
  create: (params) => create(params.approach === APPROACH_PARAM.dual ? 'dual' : 'outbox'),
  seedFor: (params) => (params.approach === APPROACH_PARAM.dual ? DUAL_SEED : def.seed),
  // Two writes, relayed and read: the consumer is caught up and agrees with the database. Their rows wait to be pruned.
  seed: [
    ['write', 63, 20],
    ['write', 77, 15],
    ['relay'],
    ['consume', 2],
  ],
  ops: [
    {
      id: 'write',
      label: 'Write',
      intent: 'primary',
      args: [ACCOUNT, AMOUNT],
      code: ['write', 'write_outbox', 'write_dual'],
      run: (s, [a, m], rec) => void write(s, Number(a), Number(m), rec),
      suggest: () => suggestWrite(),
    },
    {
      id: 'crash_between',
      label: 'Crash after commit',
      intent: 'danger',
      args: [ACCOUNT, AMOUNT],
      code: ['crash_between', 'write_dual', 'write_outbox'],
      run: (s, [a, m], rec) => void crashBetween(s, Number(a), Number(m), rec),
      suggest: () => suggestWrite(),
    },
    {
      id: 'crash_before',
      label: 'Crash before commit',
      intent: 'danger',
      args: [ACCOUNT, AMOUNT],
      code: ['crash_before', 'publish_first', 'write_outbox'],
      run: (s, [a, m], rec) => void crashBefore(s, Number(a), Number(m), rec),
      suggest: () => suggestWrite(),
    },
    { id: 'relay', label: 'Relay', args: [], code: ['relay'], run: (s, _a, rec) => void relay(s, rec) },
    { id: 'crash_relay', label: 'Crash relay', intent: 'danger', args: [], code: ['crash_relay', 'relay'], run: (s, _a, rec) => void crashRelay(s, rec) },
    {
      id: 'consume',
      label: 'Consume',
      args: [{ name: 'count', label: 'Events to read', kind: 'int', min: 1, max: LOG_SHOWN }],
      code: ['consume'],
      run: (s, [n], rec) => void consume(s, n, rec),
      suggest: (s) => [Math.max(1, Math.min(lag(s), 2))],
    },
    { id: 'prune', label: 'Prune', args: [], code: ['prune'], run: (s, _a, rec) => void prune(s, rec) },
    {
      id: 'approach',
      label: 'Approach',
      args: [{ name: 'approach', label: 'dual or outbox', kind: 'word' }],
      code: ['approach'],
      run: (s, [w], rec) => void setApproach(s, w, rec),
      suggest: (s) => [s.approach === 'outbox' ? 'dual' : 'outbox'],
    },
  ],
  layout,
  counters: [
    { key: 'writes', label: 'Business writes' },
    { key: 'published', label: 'Events published' },
    { key: 'duplicates', label: 'Duplicates on the log' },
    { key: 'dupApplied', label: 'Duplicates applied' },
    { key: 'lost', label: 'Events lost' },
    { key: 'phantom', label: 'Phantom events' },
  ],
  status: (s) => {
    const off = drift(s);
    return [
      { label: 'Approach', value: approachName(s.approach) },
      { label: 'Outbox', value: `${plural(s.outbox.length, 'row')}, ${unpublished(s)} unpublished` },
      { label: 'Consumer', value: lag(s) ? `${plural(lag(s), 'event')} behind` : 'caught up' },
      { label: 'Consumer agrees', value: off.length ? `no: ${off.map((d) => `${d.account} off by ${Math.abs(d.by)}`).join(', ')}` : 'yes' },
    ];
  },
  tour: [
    ['approach', 'dual'],
    ['crash_between', 42, 25],
    ['approach', 'outbox'],
    ['write', 42, 25],
    ['crash_relay'],
    ['consume', 2],
    ['prune'],
  ],
  source: { python, java },
  info,
};

export default def;
