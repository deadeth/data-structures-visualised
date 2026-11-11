import { LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_H, TRAY_PAD, cellCentre } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/IdempotencyKeys.java?raw';
import python from './code/idempotency_keys.py?raw';
import { info } from './info';

/**
 * A payment API that makes retries safe with idempotency keys.
 *
 * A client pays through a network that can drop a request or a response. The
 * server keeps two tables in one database: `idempotency_keys` (key, hash of
 * the request body, status, stored response) and `payments`, plus the
 * account's balance. With keys on, the server inserts the key row, applies the
 * payment and stores the response in ONE transaction, so the key and the
 * effect commit together or not at all. A retry under the same key finds the
 * row and gets the stored response back without paying again.
 *
 * `order` is the page's own record of which payment the client meant to make,
 * so a second payment for the same order can be shown as a double charge. A
 * real server cannot see that, which is the whole problem.
 */
export type Mode = 'keys' | 'none';

export interface KeyRow {
  key: string;
  hash: number;
  status: 'in-progress' | 'done';
  /** The stored response, e.g. "201 p3". Empty until the payment is written. */
  response: string;
  /** Hour the row was written. */
  created: number;
  /** Written by a transaction that has not committed yet. */
  pending: boolean;
}

export interface Payment {
  id: number;
  amount: number;
  /** Which of the client's orders this pays for. Not known to the server. */
  order: number;
  /** A second payment for an order that was already paid. */
  double: boolean;
  pending: boolean;
}

export interface Req {
  key: string;
  amount: number;
  order: number;
}

interface Msg {
  label: string;
  tone?: Tone;
  dashed?: boolean;
}

export interface IdemState {
  mode: Mode;
  balance: number;
  /** The clock, in hours. */
  now: number;
  keys: KeyRow[];
  payments: Payment[];
  nextKey: number;
  /** A sequence: an id taken by a rolled-back transaction is not reused. */
  nextPayment: number;
  nextOrder: number;
  /** Committed payments per order. */
  charged: Record<number, number>;
  /** The client's most recent request, for Retry and Mismatch. */
  last: Req | null;
  serverUp: boolean;
  serverNote: string;
  clientNote: string;
  req: Msg | null;
  res: Msg | null;
  /** Rows the layout must show even when they are not among the newest. */
  focusKey: string | null;
  focusPay: number | null;
  received: number;
  applied: number;
  replays: number;
  doubles: number;
}

export const START_BALANCE = 1000;
/** Hours a key is kept. Stripe documents at least 24 hours for its API v1. */
export const WINDOW = 24;
/** How late the late retry in Expire comes back. */
export const LATE = 25;
export const MAX_AMOUNT = 500;
/** Rows drawn per table. */
export const SHOWN = 4;

export function create(mode: Mode = 'keys'): IdemState {
  return {
    mode,
    balance: START_BALANCE,
    now: 0,
    keys: [],
    payments: [],
    nextKey: 1,
    nextPayment: 1,
    nextOrder: 1,
    charged: {},
    last: null,
    serverUp: true,
    serverNote: 'idle',
    clientNote: 'idle',
    req: null,
    res: null,
    focusKey: null,
    focusPay: null,
    received: 0,
    applied: 0,
    replays: 0,
    doubles: 0,
  };
}

/** The same small hash in both listings. 1009 is prime, so two amounts under 1009 never collide. */
export function fingerprint(amount: number): number {
  return (31 * amount + 7) % 1009;
}

export const money = (n: number) => `${n < 0 ? '−' : ''}£${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const pid = (id: number) => `p${id}`;
const hours = (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'}`;
const show = (r: Req) => `${r.key} ${money(r.amount)}`;
const rowId = (key: string) => `kr-${key}`;
const payId = (id: number) => `pr-${id}`;

const atClient = (r: Req): Probe => ({ text: show(r), at: 'client' });
const atServer = (r: Req): Probe => ({ text: show(r), at: 'server' });
const atRow = (r: Req, key = r.key): Probe => ({ text: show(r), at: rowId(key), place: 'right' });
const atPay = (r: Req, id: number): Probe => ({ text: show(r), at: payId(id), place: 'left' });

function newKey(s: IdemState): string {
  return `k${s.nextKey++}`;
}

function newOrder(s: IdemState, amount: number): Req {
  s.now += 1;
  const order = s.nextOrder++;
  return { key: newKey(s), amount, order };
}

function reset(s: IdemState, rec: Rec): void {
  s.req = null;
  s.res = null;
  s.focusKey = null;
  s.focusPay = null;
  s.serverNote = 'idle';
  s.clientNote = 'idle';
  rec.clearMarks();
}

export function asAmount(raw: number | string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_AMOUNT ? n : null;
}

export function asMode(raw: number | string): Mode | null {
  const w = String(raw).trim().toLowerCase();
  if (['keys', 'key', 'with keys', 'on', 'with'].includes(w)) return 'keys';
  if (['none', 'no keys', 'no', 'off', 'without'].includes(w)) return 'none';
  return null;
}

// ---- the server -------------------------------------------------------------

type Crash = 'before' | 'after' | null;

/** What the server did with one request. `null` response: it died before replying. */
interface Served {
  response: string | null;
  kind: 'applied' | 'replay' | 'mismatch' | 'crashed';
}

/** A request reaches the server. */
function arrive(s: IdemState, rec: Rec, r: Req, copies = 1): void {
  s.received += copies;
  rec.count('received', copies);
  rec.line('mode');
  rec.step(
    (copies > 1 ? `Both copies of ${show(r)} reach the server at the same moment. ` : `${show(r)} reaches the server. `) +
      (s.mode === 'keys'
        ? `This server checks keys, so receive() hands it to handle().`
        : `This server has no idempotency keys. It ignores the Idempotency-Key header and goes straight to the charge.`),
    { probe: atServer(r) },
  );
}

/** Commit the open transaction: the key row and the payment become visible together. */
function commitTxn(s: IdemState): Payment | null {
  for (const k of s.keys) k.pending = false;
  const p = s.payments.find((x) => x.pending) ?? null;
  if (p) {
    p.pending = false;
    s.balance -= p.amount;
    const before = s.charged[p.order] ?? 0;
    s.charged[p.order] = before + 1;
    p.double = before > 0;
    s.applied++;
    if (p.double) s.doubles++;
  }
  return p;
}

/** Undo the open transaction, as the database does when the server's connection dies. */
function rollbackTxn(s: IdemState): void {
  s.keys = s.keys.filter((k) => !k.pending);
  s.payments = s.payments.filter((p) => !p.pending);
}

function crashFrames(s: IdemState, rec: Rec, r: Req, crash: 'before' | 'after', plain: boolean, p: Payment | null): void {
  s.serverUp = false;
  s.serverNote = 'crashed';
  rec.mark('server', 'bad');
  if (crash === 'before') {
    const row = s.keys.find((k) => k.pending);
    if (row) rec.mark(rowId(row.key), 'bad');
    if (p) rec.mark(payId(p.id), 'bad');
    rec.line(plain ? 'plain_commit' : 'commit');
    rec.step(
      `The server dies on the commit line, before the commit. ` +
        (plain ? `Payment ${pid(p!.id)} was written inside the transaction, not yet committed.` : `The key row and payment ${pid(p!.id)} were written inside the transaction, not yet committed.`),
      { probe: atServer(r) },
    );
    rollbackTxn(s);
    rec.line(plain ? 'plain_begin' : 'begin');
    rec.step(
      `Its database connection drops, so the database rolls the transaction back. ` +
        (plain ? `The payment is gone. ` : `The key row and the payment go together: there is no key without a payment and no payment without its key. `) +
        `The balance never moved. The sequence is not rolled back, so ${pid(p!.id)} stays unused.`,
      { probe: atServer(r) },
    );
    return;
  }
  rec.line(plain ? 'plain_reply' : 'reply');
  rec.step(
    `The commit succeeded, then the server dies before this line runs. ` +
      (plain ? `Payment ${pid(p!.id)} is in the database, and nobody was told.` : `Payment ${pid(p!.id)} and the key row holding its response are both in the database, and nobody was told.`),
    { probe: atServer(r) },
  );
}

/** handle_no_keys(): every request that arrives is charged. */
function servePlain(s: IdemState, rec: Rec, r: Req, crash: Crash): Served {
  s.serverNote = 'txn open';
  const p: Payment = { id: s.nextPayment++, amount: r.amount, order: r.order, double: false, pending: true };
  s.payments.push(p);
  s.focusPay = p.id;
  rec.mark(payId(p.id), 'path');
  rec.line('plain_begin', 'plain_apply');
  rec.step(`Open a transaction and insert payment ${pid(p.id)} for ${money(r.amount)}. Nothing asks whether this request was seen before.`, { probe: atPay(r, p.id) });
  if (crash === 'before') {
    crashFrames(s, rec, r, 'before', true, p);
    return { response: null, kind: 'crashed' };
  }
  const was = s.balance;
  commitTxn(s);
  rec.count('applied');
  if (p.double) rec.count('doubles');
  rec.mark(payId(p.id), p.double ? 'bad' : 'ok');
  rec.line('plain_commit');
  rec.step(
    `Commit. Balance ${money(was)} → ${money(s.balance)}. ` +
      (p.double
        ? `This is the second payment for order ${r.order}: the customer has been charged twice for one purchase.`
        : `Order ${r.order} is paid.`),
    { probe: atPay(r, p.id) },
  );
  s.serverNote = 'idle';
  const response = `201 ${pid(p.id)}`;
  if (crash === 'after') {
    crashFrames(s, rec, r, 'after', true, p);
    return { response: null, kind: 'crashed' };
  }
  rec.line('plain_reply');
  return { response, kind: 'applied' };
}

/**
 * handle(): insert the key, apply the payment, store the response, commit.
 * With `wait`, a second copy is blocked on the unique index first (the
 * concurrent case); the caller runs the first copy in between.
 */
function serveKeys(s: IdemState, rec: Rec, r: Req, crash: Crash, opts: { quietHash?: boolean } = {}): Served {
  const h = fingerprint(r.amount);
  if (!opts.quietHash) {
    rec.line('hash');
    rec.step(`Fingerprint the body: (31 × ${r.amount} + 7) mod 1009 = ${h}. A retry must carry the same body, and this number is how the server will tell.`, { probe: atServer(r) });
  }
  s.serverNote = 'txn open';
  const row = s.keys.find((k) => k.key === r.key && !k.pending);
  if (row) return existing(s, rec, r, row, h);

  rec.line('begin', 'insert');
  rec.compare(r.key, '≠', 'every stored key', 'new key, insert the row', {
    probe: atServer(r),
    message: `Open one transaction and insert (${r.key}, ${h}, in-progress). The unique index on key has no row for ${r.key}, so the insert goes in.`,
  });
  const k: KeyRow = { key: r.key, hash: h, status: 'in-progress', response: '', created: s.now, pending: true };
  s.keys.push(k);
  s.focusKey = r.key;
  rec.markCell(rowId(r.key), 0, 'key');
  rec.step(`Row ${r.key} is in, marked in-progress. No other transaction can see it until this one commits.`, { probe: atRow(r) });
  return applyAndCommit(s, rec, r, k, crash);
}

function applyAndCommit(s: IdemState, rec: Rec, r: Req, k: KeyRow, crash: Crash): Served {
  const p: Payment = { id: s.nextPayment++, amount: r.amount, order: r.order, double: false, pending: true };
  s.payments.push(p);
  s.focusPay = p.id;
  rec.mark(payId(p.id), 'path');
  rec.line('apply');
  rec.step(`In the same transaction, insert payment ${pid(p.id)} for ${money(r.amount)}.`, { probe: atPay(r, p.id) });
  k.status = 'done';
  k.response = `201 ${pid(p.id)}`;
  rec.line('store');
  rec.step(`Store the response, 201 ${pid(p.id)}, on row ${r.key} and mark it done. Still the same transaction.`, { probe: atRow(r) });
  if (crash === 'before') {
    crashFrames(s, rec, r, 'before', false, p);
    return { response: null, kind: 'crashed' };
  }
  const was = s.balance;
  commitTxn(s);
  rec.count('applied');
  if (p.double) rec.count('doubles');
  rec.markCell(rowId(r.key), 0, 'idle');
  rec.mark(rowId(r.key), 'ok');
  rec.mark(payId(p.id), p.double ? 'bad' : 'ok');
  rec.line('commit');
  rec.step(
    `Commit. The key row and the payment become visible together. Balance ${money(was)} → ${money(s.balance)}. ` +
      (p.double
        ? `But order ${r.order} was already paid: this is a second charge. The server saw a key it had no row for, so it had no way to know.`
        : `From now on, any request with key ${r.key} gets this answer back.`),
    { probe: atRow(r) },
  );
  s.serverNote = 'idle';
  if (crash === 'after') {
    crashFrames(s, rec, r, 'after', false, p);
    return { response: null, kind: 'crashed' };
  }
  rec.line('reply');
  return { response: k.response, kind: 'applied' };
}

/** The insert hit the unique index: read the row and compare the request's hash with the stored one. */
function existing(s: IdemState, rec: Rec, r: Req, row: KeyRow, h: number, woke = false): Served {
  s.focusKey = row.key;
  if (!woke) {
    rec.mark(rowId(row.key), 'compare');
    rec.line('begin', 'insert');
    rec.compare(r.key, '=', `stored ${row.key}`, 'key exists, read the row', {
      probe: atRow(r),
      message: `Open a transaction and try the insert. The unique index rejects it: ${r.key} is already there. Nothing is charged by a failed insert.`,
    });
  }
  rec.mark(rowId(row.key), 'path');
  rec.line('read');
  rec.step(`Read row ${row.key}: hash ${row.hash}, ${row.status}, response ${row.response}.`, { probe: atRow(r) });
  const same = row.hash === h;
  rec.mark(rowId(row.key), 'compare');
  rec.line('compare');
  rec.compare(`h(${money(r.amount)}) = ${h}`, same ? '=' : '≠', `stored ${row.hash}`, same ? 'same request, replay' : 'different body, reject', { probe: atRow(r) });
  s.serverNote = 'idle';
  if (same) {
    s.replays++;
    rec.count('replays');
    rec.mark(rowId(row.key), 'ok');
    rec.line('replay');
    rec.step(
      `Same key, same body: this is a retry. Return the stored ${row.response} and charge nothing. The transaction ends with no writes. Balance stays ${money(s.balance)}.`,
      { probe: atRow(r) },
    );
    return { response: row.response, kind: 'replay' };
  }
  rec.mark(rowId(row.key), 'bad');
  rec.line('mismatch');
  rec.step(
    `Same key, different body. That is a client bug, not a retry: replaying ${row.response} would confirm a payment of the wrong amount, and charging would break the key's promise. Reject with 422 and change nothing.`,
    { probe: atRow(r) },
  );
  return { response: '422', kind: 'mismatch' };
}

function serve(s: IdemState, rec: Rec, r: Req, crash: Crash = null): Served {
  arrive(s, rec, r);
  return s.mode === 'keys' ? serveKeys(s, rec, r, crash) : servePlain(s, rec, r, crash);
}

// ---- the client and the network ------------------------------------------------

type Fate = 'ok' | 'request' | 'response';

/** One attempt through the network. Returns the response the client got, or null on a timeout. */
function attempt(s: IdemState, rec: Rec, r: Req, fate: Fate, crash: Crash = null): { got: string | null; served: Served | null } {
  if (fate === 'request') {
    s.req = { label: `${show(r)} lost`, tone: 'bad', dashed: true };
    rec.line(...sendLine);
    rec.step(`The network drops the request. The server never sees it.`, { probe: atClient(r) });
    return { got: null, served: null };
  }
  const served = serve(s, rec, r, crash);
  if (served.response === null) return { got: null, served };
  const bad = served.kind === 'mismatch';
  if (fate === 'response') {
    s.res = { label: `${served.response} lost`, tone: 'bad', dashed: true };
    rec.line(s.mode === 'keys' ? (served.kind === 'replay' ? 'replay' : 'reply') : 'plain_reply');
    rec.step(`The server replies ${served.response}, but the network drops the response.`, { probe: atServer(r) });
    return { got: null, served };
  }
  s.res = { label: served.kind === 'replay' ? `${served.response} again` : served.response, tone: bad ? 'bad' : 'ok', dashed: bad };
  s.clientNote = `got ${served.response}`;
  rec.line(...gotLine);
  rec.step(`The client gets ${served.response}.`, { probe: atClient(r) });
  return { got: served.response, served };
}

/** Anchors for the client's send and receive lines. Set by the operation, as each uses a different client method. */
let sendLine: string[] = ['send'];
let gotLine: string[] = ['send'];

function send(s: IdemState, rec: Rec, r: Req, text: string): void {
  s.req = { label: show(r) };
  s.res = null;
  s.clientNote = `sent ${r.key}`;
  rec.line(...sendLine);
  rec.step(text, { probe: atClient(r) });
}

function timeout(s: IdemState, rec: Rec, r: Req, anchor: string): void {
  s.clientNote = 'timed out';
  rec.line(anchor);
  rec.step(
    `The client's timeout fires with no answer. It cannot tell a lost request from a lost response or a dead server, so it does not know whether ${money(r.amount)} was taken.`,
    { probe: atClient(r) },
  );
}

function restart(s: IdemState, rec: Rec, r: Req): void {
  if (s.serverUp) return;
  s.serverUp = true;
  s.serverNote = 'restarted';
  rec.unmark('server');
  rec.line('timeout');
  rec.step(`The server restarts. It remembers nothing in memory; everything it knows is in the database.`, { probe: atClient(r) });
}

function closing(s: IdemState, r: Req, before: { applied: number; doubles: number }): string {
  const paid = s.applied - before.applied;
  const doubled = s.doubles - before.doubles;
  if (doubled) return `Order ${r.order} has been charged ${s.charged[r.order]} times. Balance ${money(s.balance)}.`;
  if (paid === 1) return `Order ${r.order} was charged exactly once. Balance ${money(s.balance)}.`;
  return `Order ${r.order} was charged ${s.charged[r.order] ?? 0} times so far. Balance ${money(s.balance)}.`;
}

function guard(s: IdemState, rec: Rec, raw: number | string, anchor: string): number | null {
  const amount = asAmount(raw);
  if (amount === null) {
    rec.line(anchor);
    rec.step(`Enter an amount in whole pounds from 1 to ${MAX_AMOUNT}.`);
  }
  void s;
  return amount;
}

const tally = (s: IdemState) => ({ applied: s.applied, doubles: s.doubles });

/** Pay, with every attempt's fate given. The client makes one key and reuses it on every attempt. */
function payWith(s: IdemState, rec: Rec, amount: number, fates: Fate[], crash: Crash = null, story = ''): string | null {
  sendLine = ['send'];
  gotLine = ['send'];
  const r = newOrder(s, amount);
  s.last = r;
  const before = tally(s);
  sendLine = ['new_key', 'send'];
  send(s, rec, r, `Order ${r.order}: the client makes key ${r.key} once, before the first attempt, and sends POST /payments with Idempotency-Key ${r.key} and ${money(amount)}.${story}`);
  sendLine = ['send'];
  let got: string | null = null;
  for (let i = 0; i < fates.length; i++) {
    if (i > 0) {
      sendLine = ['retry', 'send'];
      send(
        s,
        rec,
        r,
        `So it sends the same request again, with the same key ${r.key} and the same body. ` +
          (s.mode === 'keys' ? `If the first one worked, the key lets the server say so.` : `This server will not look at the key.`),
      );
      sendLine = ['send'];
    }
    const out = attempt(s, rec, r, fates[i], i === 0 ? crash : null);
    got = out.got;
    if (got !== null) break;
    if (i < fates.length - 1) {
      timeout(s, rec, r, 'timeout');
      restart(s, rec, r);
    }
  }
  rec.line('send');
  rec.step(`${closing(s, r, before)}`, { probe: atClient(r) });
  return got;
}

export function pay(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const amount = guard(s, rec, raw, 'new_key');
  if (amount === null) return null;
  return payWith(s, rec, amount, ['ok']);
}

export function loseRequest(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const amount = guard(s, rec, raw, 'new_key');
  if (amount === null) return null;
  return payWith(s, rec, amount, ['request', 'ok']);
}

export function loseResponse(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const amount = guard(s, rec, raw, 'new_key');
  if (amount === null) return null;
  return payWith(s, rec, amount, ['response', 'ok']);
}

export function crash(s: IdemState, when: number | string, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const w = String(when).trim().toLowerCase();
  if (w !== 'before' && w !== 'after') {
    rec.line('commit');
    rec.step(`Say when the server dies: before (it commits nothing) or after (it commits, then dies before replying).`);
    return null;
  }
  const amount = guard(s, rec, raw, 'new_key');
  if (amount === null) return null;
  return payWith(s, rec, amount, ['ok', 'ok'], w);
}

/** The client resends its last request under the same key. */
export function retry(s: IdemState, rec: Rec): string | null {
  reset(s, rec);
  sendLine = ['resend'];
  gotLine = ['resend'];
  const r = s.last;
  if (!r) {
    rec.line('resend');
    rec.step(`The client has not sent anything yet, so there is nothing to retry. Pay first.`);
    return null;
  }
  const before = tally(s);
  send(s, rec, r, `The client sends its last request again: key ${r.key}, ${money(r.amount)}, for order ${r.order}.`);
  const out = attempt(s, rec, r, 'ok');
  rec.line('resend');
  rec.step(closing(s, r, before), { probe: atClient(r) });
  return out.got;
}

/** The mistake: the response is lost and the client retries under a fresh key. */
export function retryNewKey(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const amount = guard(s, rec, raw, 'fresh_key');
  if (amount === null) return null;
  sendLine = ['retry_new', 'fresh_key', 'send_new'];
  gotLine = ['send_new'];
  const r = newOrder(s, amount);
  s.last = r;
  const before = tally(s);
  send(s, rec, r, `Order ${r.order}: this client makes its key inside the retry loop. It sends ${r.key} and ${money(amount)}.`);
  attempt(s, rec, r, 'response');
  timeout(s, rec, r, 'timeout_new');
  const again: Req = { key: newKey(s), amount, order: r.order };
  s.last = again;
  sendLine = ['retry_new', 'fresh_key', 'send_new'];
  send(s, rec, again, `It retries, and the loop makes a fresh key, ${again.key}. To the server this is a different payment that happens to have the same amount.`);
  attempt(s, rec, again, 'ok');
  rec.line('send_new');
  rec.step(
    `${closing(s, r, before)} ` +
      (s.mode === 'keys'
        ? `Keys did not help: the server compared ${again.key} with what it had and found nothing. A key must be made once per payment, before the first attempt, and saved with the order so even a restarted client resends the same one.`
        : `The fresh key changed nothing here, as this server ignores keys, but with keys on it would charge twice as well.`),
    { probe: atClient(again) },
  );
  return null;
}

/** Same key as the last request, different amount. */
export function mismatch(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  sendLine = ['resend'];
  gotLine = ['resend'];
  const amount = guard(s, rec, raw, 'resend');
  if (amount === null) return null;
  const last = s.last;
  if (!last) {
    rec.line('resend');
    rec.step(`The client has not sent anything yet, so there is no key to reuse. Pay first.`);
    return null;
  }
  // A new order that wrongly reuses the last key. It does not become the client's last request.
  s.now += 1;
  const r: Req = { key: last.key, amount, order: s.nextOrder++ };
  const before = tally(s);
  send(
    s,
    rec,
    r,
    `A buggy client starts order ${r.order} for ${money(amount)} but sends it under key ${r.key}, which belongs to order ${last.order} (${money(last.amount)}).` +
      (amount === last.amount ? ` The amount happens to match, so the server cannot tell it from a retry.` : ``),
  );
  const out = attempt(s, rec, r, 'ok');
  rec.line('resend');
  rec.step(
    out.served?.kind === 'mismatch'
      ? `Rejected with 422. Order ${r.order} was not charged and order ${last.order} is untouched. The client must use a new key for a new payment.`
      : closing(s, r, before) + (s.mode === 'none' ? ` This server ignored the key, so nothing caught the reuse.` : ``),
    { probe: atClient(r) },
  );
  return out.got;
}

/** Two copies of the same request arrive together. */
export function concurrent(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const amount = guard(s, rec, raw, 'new_key');
  if (amount === null) return null;
  sendLine = ['new_key', 'send'];
  gotLine = ['send'];
  const r = newOrder(s, amount);
  s.last = r;
  const before = tally(s);
  send(s, rec, r, `Order ${r.order}: the client sends ${r.key} and ${money(amount)}. A proxy retries it on a slow link, and two identical copies are now in flight.`);
  s.req = { label: `${show(r)} ×2` };
  arrive(s, rec, r, 2);
  sendLine = ['send'];

  if (s.mode === 'none') {
    servePlain(s, rec, r, null);
    servePlain(s, rec, r, null);
    rec.line('plain_reply');
  } else {
    const h = fingerprint(amount);
    rec.line('hash');
    rec.step(`Each copy fingerprints the body: (31 × ${amount} + 7) mod 1009 = ${h}.`, { probe: atServer(r) });
    // Copy 1 inserts the key row; its transaction stays open.
    rec.line('begin', 'insert', 'hold');
    rec.compare(r.key, '≠', 'every stored key', 'copy 1 inserts the row', {
      probe: atServer(r),
      message: `Copy 1 opens a transaction and inserts (${r.key}, ${h}, in-progress). There is no row for ${r.key} yet, so it goes in, uncommitted.`,
    });
    const k: KeyRow = { key: r.key, hash: h, status: 'in-progress', response: '', created: s.now, pending: true };
    s.keys.push(k);
    s.focusKey = r.key;
    s.serverNote = 'copy 2 waits';
    rec.markCell(rowId(r.key), 0, 'key');
    rec.line('insert', 'wait');
    rec.compare(r.key, '=', `${r.key}, held by copy 1`, 'copy 2 waits', {
      probe: atRow(r),
      message: `Copy 2 opens its own transaction and tries the same insert. The unique index already holds ${r.key} for copy 1's open transaction, so copy 2 blocks until that transaction commits or rolls back.`,
    });
    // Copy 1 finishes while copy 2 waits.
    applyAndCommit(s, rec, r, k, null);
    s.serverNote = 'copy 2 waits';
    rec.line('insert', 'exists');
    rec.compare(r.key, '=', `committed ${r.key}`, 'copy 2 wakes, key exists', {
      probe: atRow(r),
      message: `Copy 1 committed, so copy 2 wakes up and its insert fails: ${r.key} now exists. Had copy 1 rolled back, copy 2's insert would have gone in instead.`,
    });
    existing(s, rec, r, k, h, true);
  }
  const first = `201 ${pid(s.nextPayment - (s.mode === 'none' ? 2 : 1))}`;
  const second = `201 ${pid(s.nextPayment - 1)}`;
  s.res = { label: first === second ? `${first} ×2` : `${first}, ${second}`, tone: 'ok' };
  s.clientNote = 'got 2 answers';
  rec.line(...gotLine);
  rec.step(
    `${closing(s, r, before)} ` +
      (s.mode === 'keys'
        ? `Both copies got ${first}. This server waits on the unique index because the key and the payment share one transaction. A server that must call an outside provider cannot hold a transaction open that long: it commits an in-progress row first, and a duplicate that sees in-progress gets 409 Conflict and retries later. Stripe answers 409 in that case.`
        : `Without keys both copies were charged, ${first} and ${second}.`),
    { probe: atClient(r) },
  );
  return first;
}

/** Keys older than the window are pruned, and a very late retry comes back. */
export function expire(s: IdemState, raw: number | string, rec: Rec): string | null {
  reset(s, rec);
  const amount = guard(s, rec, raw, 'new_key');
  if (amount === null) return null;
  sendLine = ['new_key', 'send'];
  gotLine = ['send'];
  const r = newOrder(s, amount);
  s.last = r;
  const before = tally(s);
  send(s, rec, r, `Order ${r.order}: the client sends ${r.key} and ${money(amount)}.`);
  sendLine = ['send'];
  attempt(s, rec, r, 'response');
  s.clientNote = 'gave up';
  rec.line('give_up');
  rec.step(
    `Every attempt times out (say the client's network stayed down) and it gives up for now, keeping ${r.key} and the amount in a queue to try again later. Order ${r.order} was in fact paid.`,
    { probe: atClient(r) },
  );

  s.now += LATE;
  s.res = null;
  s.req = null;
  s.serverNote = 'pruning';
  rec.line('scan');
  rec.step(`${hours(LATE)} pass. The pruning job scans idempotency_keys. It is now hour ${s.now}.`, { probe: atClient(r) });
  const old = s.keys.filter((k) => s.now - k.created >= WINDOW);
  const mine = s.keys.find((k) => k.key === r.key);
  if (mine) {
    s.focusKey = mine.key;
    rec.mark(rowId(mine.key), 'compare');
    rec.line('age');
    rec.compare(`${mine.key}: age ${s.now - mine.created} h`, s.now - mine.created >= WINDOW ? '≥' : '<', `window ${WINDOW} h`, 'drop it', { probe: atRow(r) });
  }
  for (const k of old) rec.mark(rowId(k.key), 'bad');
  rec.line('drop');
  rec.step(
    old.length
      ? `Drop every row at least ${WINDOW} hours old: ${old.map((k) => k.key).join(', ')}. The payments stay; only the memory of the keys goes.`
      : `No row is ${WINDOW} hours old yet, so nothing is dropped.`,
    { probe: atClient(r) },
  );
  s.keys = s.keys.filter((k) => s.now - k.created < WINDOW);
  s.focusKey = null;
  for (const k of old) rec.unmark(rowId(k.key));
  s.serverNote = 'idle';

  sendLine = ['resend'];
  gotLine = ['resend'];
  send(s, rec, r, `The client's queue finally resends ${r.key} and ${money(amount)}, ${hours(LATE)} after the first attempt.`);
  attempt(s, rec, r, 'ok');
  rec.line('resend');
  rec.step(
    `${closing(s, r, before)} ` +
      (s.mode === 'keys'
        ? `The key was pruned after ${WINDOW} hours, so the late retry looked new. The window must be longer than the longest a client will keep retrying. Stripe keeps keys for at least 24 hours and tells clients to stop retrying after 24 hours and check what happened instead.`
        : `Without keys, a retry charges again whether it is late or not.`),
    { probe: atClient(r) },
  );
  return null;
}

/** Switch the server between checking keys and ignoring them. */
export function setMode(s: IdemState, raw: number | string, rec: Rec): boolean {
  reset(s, rec);
  const m = asMode(raw);
  rec.line('mode');
  if (!m) {
    rec.step(`Enter keys (the server checks idempotency keys) or none (it ignores them).`);
    return false;
  }
  if (m === s.mode) {
    rec.step(`The server is already ${m === 'keys' ? 'checking keys' : 'running without keys'}. Nothing changes.`);
    return false;
  }
  s.mode = m;
  rec.mark('server', 'path');
  rec.step(
    m === 'keys'
      ? `Deploy the server that checks keys. Same tables, same client: from now on receive() calls handle(), which inserts the key, charges and stores the response in one transaction.`
      : `Deploy a server with no idempotency keys. receive() calls handle_no_keys(), which charges every request that arrives. The client still sends a key; the server just ignores it.`,
  );
  return true;
}

// ---- layout -------------------------------------------------------------------

const CLIENT_X = 60;
const SERVER_X = 500;
const CLOCK_X = 860;
const TOP_Y = 0;
const TITLE_Y = 102;
const COLS_Y = 130;
const ROW0 = 166;
const PITCH = 46;
const KEY_W = [56, 72, 132, 96];
const PAY_W = [56, 80, 112];
const PAY_LEFT = 520;
const BAL_X = 860;
const LEFT = 0;
const RIGHT = 914;
const TOP = TOP_Y - CELL_H / 2 - TRAY_PAD - PROBE_H - 16;
const BOTTOM = ROW0 + (SHOWN - 1) * PITCH + CELL_H / 2 + TRAY_PAD + 12;

const trayW = (ws: number[]) => TRAY_PAD * 2 + ws.reduce((a, b) => a + b, 0) + (ws.length - 1) * 3;
const KEYS_TW = trayW(KEY_W);
const PAY_TW = trayW(PAY_W);

/** The newest rows, with the focused one kept in view. */
function visible<T>(all: T[], focus: (t: T) => boolean): T[] {
  const tail = all.slice(-SHOWN);
  const f = all.find(focus);
  if (f && !tail.includes(f)) return [f, ...tail.slice(1)].sort((a, b) => all.indexOf(a) - all.indexOf(b));
  return tail;
}

function columnLabels(prefix: string, left: number, ws: number[], names: string[]): Decor[] {
  const cells: Cell[] = ws.map((w) => ({ text: '', w }));
  return names.map((text, i) => ({ id: `${prefix}${i}`, type: 'label' as const, x: left + cellCentre(cells, i), y: COLS_Y, text, anchor: 'middle' as const }));
}

export function layout(s: IdemState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  decor.push({ id: 'db', type: 'band', x: LEFT - 8, y: TITLE_Y - 20, w: RIGHT - LEFT + 8, h: BOTTOM - TITLE_Y + 14 });

  nodes.push({ id: 'client', x: CLIENT_X, y: TOP_Y, cells: [{ text: 'client' }], caption: s.clientNote });
  nodes.push({
    id: 'server',
    x: SERVER_X,
    y: TOP_Y,
    tone: s.serverUp ? undefined : 'bad',
    cells: [{ text: 'API server' }, { text: s.mode === 'keys' ? 'with keys' : 'no keys', w: 112 }, { text: s.serverNote, w: 140 }],
  });
  nodes.push({ id: 'clock', x: CLOCK_X, y: TOP_Y, cells: [{ text: `hour ${s.now}`, w: 104 }], title: 'clock' });

  if (s.req) edges.push({ id: 'req', from: 'client', to: 'server', kind: 'line', arrow: true, offset: 8, label: s.req.label, tone: s.req.tone, dashed: s.req.dashed });
  if (s.res) edges.push({ id: 'res', from: 'server', to: 'client', kind: 'line', arrow: true, offset: 8, label: s.res.label, tone: s.res.tone, dashed: s.res.dashed });

  // idempotency_keys
  decor.push({
    id: 'keys-title',
    type: 'label',
    x: LEFT,
    y: TITLE_Y,
    text: s.mode === 'keys' ? `idempotency_keys, ${s.keys.length} ${s.keys.length === 1 ? 'row' : 'rows'}` : `idempotency_keys: not read`,
    strong: true,
  });
  decor.push(...columnLabels('kc', LEFT, KEY_W, ['key', 'hash', 'status', 'response']));
  visible(s.keys, (k) => k.key === s.focusKey).forEach((k, i) => {
    nodes.push({
      id: rowId(k.key),
      x: LEFT + KEYS_TW / 2,
      y: ROW0 + i * PITCH,
      tone: s.mode === 'none' ? 'dim' : undefined,
      cells: [
        { text: k.key, w: KEY_W[0] },
        { text: String(k.hash), w: KEY_W[1] },
        { text: k.status, w: KEY_W[2] },
        { text: k.response, w: KEY_W[3] },
      ],
    });
  });

  // payments
  decor.push({ id: 'pay-title', type: 'label', x: PAY_LEFT, y: TITLE_Y, text: `payments, ${s.payments.length} ${s.payments.length === 1 ? 'row' : 'rows'}`, strong: true });
  decor.push(...columnLabels('pc', PAY_LEFT, PAY_W, ['id', 'amount', 'for']));
  visible(s.payments, (p) => p.id === s.focusPay).forEach((p, i) => {
    nodes.push({
      id: payId(p.id),
      x: PAY_LEFT + PAY_TW / 2,
      y: ROW0 + i * PITCH,
      tone: p.double ? 'bad' : undefined,
      cells: [
        { text: pid(p.id), w: PAY_W[0] },
        { text: money(p.amount), w: PAY_W[1] },
        { text: p.double ? `order ${p.order}!` : `order ${p.order}`, w: PAY_W[2] },
      ],
    });
  });

  nodes.push({ id: 'balance', x: BAL_X, y: ROW0, cells: [{ text: money(s.balance), w: 104 }], title: 'balance' });

  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------

const AMOUNT = { name: 'amount', label: 'Amount (£1 to £500)', kind: 'int' as const, min: 1, max: MAX_AMOUNT };
const suggestAmount = () => randomInt(1, 40) * 5;

const def: StructureDef<IdemState> = {
  id: 'idempotency-keys',
  params: [
    {
      id: 'server',
      label: 'Server at start',
      default: 1,
      options: [
        { value: 1, label: 'with keys' },
        { value: 0, label: 'no keys' },
      ],
    },
  ],
  create: (params) => create((params.server ?? 1) === 1 ? 'keys' : 'none'),
  // One paid order, so Retry and Mismatch have a key to reuse from the start.
  seed: [['pay', 60]],
  ops: [
    {
      id: 'pay',
      label: 'Pay',
      intent: 'primary',
      args: [AMOUNT],
      code: ['pay', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [a], rec) => void pay(s, a, rec),
      suggest: () => [suggestAmount()],
    },
    {
      id: 'lose_response',
      label: 'Lose the response',
      args: [AMOUNT],
      code: ['pay', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [a], rec) => void loseResponse(s, a, rec),
      suggest: () => [suggestAmount()],
    },
    {
      id: 'lose_request',
      label: 'Lose the request',
      args: [AMOUNT],
      code: ['pay', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [a], rec) => void loseRequest(s, a, rec),
      suggest: () => [suggestAmount()],
    },
    {
      id: 'retry',
      label: 'Retry last',
      args: [],
      code: ['resend', 'receive', 'handle', 'handle_no_keys'],
      run: (s, _args, rec) => void retry(s, rec),
    },
    {
      id: 'retry_new_key',
      label: 'Retry with a new key',
      intent: 'danger',
      args: [AMOUNT],
      code: ['pay_new_key', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [a], rec) => void retryNewKey(s, a, rec),
      suggest: () => [suggestAmount()],
    },
    {
      id: 'concurrent',
      label: 'Two copies at once',
      args: [AMOUNT],
      code: ['pay', 'receive', 'handle', 'insert_key', 'handle_no_keys'],
      run: (s, [a], rec) => void concurrent(s, a, rec),
      suggest: () => [suggestAmount()],
    },
    {
      id: 'mismatch',
      label: 'Same key, new amount',
      args: [AMOUNT],
      code: ['resend', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [a], rec) => void mismatch(s, a, rec),
      suggest: (s) => {
        let a = suggestAmount();
        if (s.last && a === s.last.amount) a = a === MAX_AMOUNT ? 5 : a + 5;
        return [a];
      },
    },
    {
      id: 'crash',
      label: 'Crash the server',
      intent: 'danger',
      args: [{ name: 'when', label: 'When (before or after commit)', kind: 'word' }, AMOUNT],
      code: ['pay', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [w, a], rec) => void crash(s, w, a, rec),
      suggest: () => [randomInt(0, 1) ? 'after' : 'before', suggestAmount()],
    },
    {
      id: 'expire',
      label: 'Retry after expiry',
      args: [AMOUNT],
      code: ['prune', 'pay', 'resend', 'receive', 'handle', 'handle_no_keys'],
      run: (s, [a], rec) => void expire(s, a, rec),
      suggest: () => [suggestAmount()],
    },
    {
      id: 'server',
      label: 'Switch server',
      args: [{ name: 'mode', label: 'Server (keys or none)', kind: 'word' }],
      code: ['receive'],
      run: (s, [m], rec) => void setMode(s, m, rec),
      suggest: (s) => [s.mode === 'keys' ? 'none' : 'keys'],
    },
  ],
  layout,
  counters: [
    { key: 'received', label: 'Requests received' },
    { key: 'applied', label: 'Payments applied' },
    { key: 'replays', label: 'Replays served' },
    { key: 'doubles', label: 'Double payments' },
  ],
  status: (s) => [
    { label: 'Server', value: s.mode === 'keys' ? 'with keys' : 'no keys' },
    { label: 'Balance', value: money(s.balance) },
    { label: 'Orders, payments', value: `${s.nextOrder - 1}, ${s.payments.length}` },
    { label: 'Double payments', value: String(s.doubles) },
  ],
  tour: [
    ['server', 'none'],
    ['lose_response', 40],
    ['server', 'keys'],
    ['lose_response', 25],
    ['concurrent', 30],
    ['mismatch', 90],
    ['retry_new_key', 15],
  ],
  source: { python, java },
  info,
};

export default def;
