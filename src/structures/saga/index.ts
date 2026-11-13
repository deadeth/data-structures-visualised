import { LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_H, TRAY_PAD } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone, VarValue } from '../../core/types';
import java from './code/Saga.java?raw';
import python from './code/saga.py?raw';
import { info } from './info';

/**
 * A payment as a saga across three services, each with its own database.
 *
 *   1. Ledger reserves the money (undo: release the hold)
 *   2. Limits counts it against today's limit (undo: give the limit back)
 *   3. Gateway submits it to the payment scheme: the pivot, no undo
 *   4. Ledger posts the debit: after the pivot, retried until it works
 *
 * With orchestration, an orchestrator drives each saga from one durable row
 * in its saga log. With choreography, there is no row and no coordinator:
 * each service reacts to the event the one before it published.
 *
 * Every command carries an idempotency key, and a service stores the key with
 * its reply in the same local transaction, so a resent command has no second
 * effect. Durable: the saga log and each service's database. Lost in a crash:
 * the orchestrator's memory, which on this page holds nothing else.
 */
export type Mode = 'orchestration' | 'choreography';
export type RowState = 'running' | 'compensating' | 'waiting' | 'completed' | 'compensated';

export interface Row {
  id: number;
  amount: number;
  /** Steps in effect: the next step to do, or one more than the next to undo. */
  done: number;
  state: RowState;
}

export interface Svc {
  name: string;
  /** Idempotency key to stored reply. Same database as the rows. */
  replies: Record<string, string>;
  /** The latest keys stored, oldest first, for the picture. */
  recent: string[];
  /** Page switch: calls to drop before it answers. */
  down: number;
  /** Page switch: refuse the next command. */
  refuse: boolean;
  /** What this service's own rows say about each saga. */
  view: Record<number, string>;
}

export interface Msg {
  from: string;
  to: string;
  text: string;
  tone: Tone;
  dashed?: boolean;
  offset?: number;
}

export interface Event {
  name: string;
  saga: number;
}

export interface SagaState {
  mode: Mode;
  svcs: Svc[];
  balance: number;
  /** Ledger: saga to amount held. A semantic lock other sagas can see. */
  holds: Record<number, number>;
  limit: number;
  used: number;
  /** Limits: saga to amount counted against today's limit. */
  counted: Record<number, number>;
  /** Gateway: what the scheme said, newest last. */
  sent: { saga: number; result: string }[];
  /** The orchestrator's saga log. Durable. */
  log: Row[];
  orchUp: boolean;
  /** Page switches for the orchestrator: lose this reply, die after this key. */
  lost: string[];
  crashAfter: string | null;
  /** Choreography: events on the broker, oldest first. */
  queue: Event[];
  /** Choreography: the newest event seen per saga, for its caption. */
  lastEvent: Record<number, string>;
  /** The latest saga started. */
  next: number;
  /** The saga being followed. 0 before the first. */
  focus: number;
  /** Amounts of sagas in choreography, which keeps no row. */
  amounts: Record<number, number>;
  msgs: Msg[];
  /** The service drawn as down in this frame, if any. */
  outage: number | null;
  completed: number;
  compensated: number;
}

export const AMOUNT = 50;
export const BALANCE = 1000;
export const LIMIT = 2000;
export const LEDGER = 0;
export const LIMITS = 1;
export const GATEWAY = 2;
const NAMES = ['Ledger', 'Limits', 'Gateway'];

export interface StepDef {
  svc: number;
  action: string;
  undo: string | null;
}
export const STEPS: StepDef[] = [
  { svc: LEDGER, action: 'reserve', undo: 'release' },
  { svc: LIMITS, action: 'hold', undo: 'unhold' },
  { svc: GATEWAY, action: 'submit', undo: null },
  { svc: LEDGER, action: 'post', undo: null },
];
export const PIVOT = 2;
const N = STEPS.length;

/** Choreography: event to the service that listens, what it does and what it publishes. */
export const REACTIONS: Record<string, { svc: number; action: string; done: string; refused: string | null }> = {
  requested: { svc: LEDGER, action: 'reserve', done: 'reserved', refused: 'failed' },
  reserved: { svc: LIMITS, action: 'hold', done: 'held', refused: 'over_limit' },
  held: { svc: GATEWAY, action: 'submit', done: 'accepted', refused: 'rejected' },
  accepted: { svc: LEDGER, action: 'post', done: 'posted', refused: null },
  over_limit: { svc: LEDGER, action: 'release', done: 'failed', refused: null },
  rejected: { svc: LIMITS, action: 'unhold', done: 'returned', refused: null },
  returned: { svc: LEDGER, action: 'release', done: 'failed', refused: null },
};

export function create(mode: Mode = 'orchestration'): SagaState {
  return {
    mode,
    svcs: NAMES.map((name) => ({ name, replies: {}, recent: [], down: 0, refuse: false, view: {} })),
    balance: BALANCE,
    holds: {},
    limit: LIMIT,
    used: 0,
    counted: {},
    sent: [],
    log: [],
    orchUp: true,
    lost: [],
    crashAfter: null,
    queue: [],
    lastEvent: {},
    next: 0,
    focus: 0,
    amounts: {},
    msgs: [],
    outage: null,
    completed: 0,
    compensated: 0,
  };
}

/** The saga's name. It wraps after S99 so it always fits its cell. */
export const label = (id: number) => `S${((id - 1) % 99) + 1}`;
export const money = (n: number) => `£${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
export const stepKey = (id: number, i: number) => `${label(id)}-${i + 1}`;
export const undoKey = (id: number, i: number) => `${label(id)}-undo-${i + 1}`;
const held = (s: SagaState) => Object.values(s.holds).reduce((a, b) => a + b, 0);
export const free = (s: SagaState) => s.balance - held(s);
const LIVE: RowState[] = ['running', 'compensating'];
export const rowOf = (s: SagaState, id: number) => s.log.find((r) => r.id === id)!;
/** The saga still in flight, if any: running, compensating or parked. */
export function inFlight(s: SagaState): Row | null {
  return s.log.find((r) => LIVE.includes(r.state) || r.state === 'waiting') ?? null;
}
const steps = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

// ---- ids --------------------------------------------------------------------

const SAGA = 'saga';
const ORCH = 'orch';
const svcId = (i: number) => `svc${i}`;
const dbId = (i: number) => `db${i}`;
const keysId = (i: number) => `keys${i}`;
const rowId = (id: number) => `row${id}`;

const atSaga = (id: number): Probe => ({ text: label(id), at: SAGA });
const atOrch = (id: number): Probe => ({ text: label(id), at: ORCH });
const atSvc = (id: number, i: number): Probe => ({ text: label(id), at: svcId(i) });
/** Over the saga's row in the log. Only the newest row has room above it. */
function atRow(s: SagaState, id: number): Probe {
  const shown = shownRows(s);
  const i = shown.findIndex((r) => r.id === id);
  if (i < 0) return atOrch(id);
  return { text: label(id), at: rowId(id), place: i === 0 ? 'above' : 'left' };
}

// ---- the Variables strip -------------------------------------------------------

/** A string as the listing holds it. */
const q = (x: string) => `"${x}"`;

/** Orchestrator.step's locals. */
function stepVars(rec: Rec, row: Row, i: number, key: string, action: string): void {
  if (!rec.recording) return;
  rec.vars({ saga: q(label(row.id)), i, key: q(key), action: q(action), 'row["done"]': row.done, 'row["state"]': q(row.state) });
}

/** Orchestrator.compensate's locals. */
function compVars(rec: Rec, row: Row, i: number, key?: string, undo?: string): void {
  if (!rec.recording) return;
  rec.vars({ saga: q(label(row.id)), i, key: key && q(key), undo: undo && q(undo), 'row["done"]': row.done, 'row["state"]': q(row.state) });
}

/** Orchestrator.call's locals. */
function callVars(rec: Rec, svc: number, key: string, action: string, row: Row, reply?: string): void {
  if (!rec.recording) return;
  rec.vars({ name: q(NAMES[svc].toLowerCase()), key: q(key), action: q(action), saga: q(label(row.id)), amount: row.amount, reply: reply && q(reply) });
}

/** Service.handle's arguments, and the action's own locals. */
function handleVars(rec: Rec, key: string, action: string, id: number, amount: number, extra: Record<string, VarValue> = {}): void {
  if (!rec.recording) return;
  rec.vars({ key: q(key), action: q(action), saga: q(label(id)), amount, ...extra });
}

/** Orchestrator.run's view of one saga. */
function runVars(rec: Rec, row: Row): void {
  if (!rec.recording) return;
  rec.vars({ saga: q(label(row.id)), 'log[saga]["state"]': q(row.state) });
}

// ---- the services' local transactions ---------------------------------------

type Outcome = 'ok' | 'refused' | 'pending';

/** Would this step be refused by a business rule, switches aside? */
function naturalRefusal(s: SagaState, action: string, amount: number): boolean {
  if (action === 'reserve') return free(s) < amount;
  if (action === 'hold') return s.used + amount > s.limit;
  return false;
}

function keep(svc: Svc, key: string, reply: string): void {
  svc.replies[key] = reply;
  svc.recent.push(key);
  if (svc.recent.length > 2) svc.recent.shift();
}

function gateway(s: SagaState, id: number, result: string): void {
  s.sent = s.sent.filter((x) => x.saga !== id);
  s.sent.push({ saga: id, result });
  if (s.sent.length > 2) s.sent.shift();
}

/**
 * One command at one service, as Service.handle runs it, minus the switch
 * checks the caller narrates. Returns the reply, or a refusal.
 */
function local(s: SagaState, rec: Rec, i: number, key: string, action: string, id: number, amount: number, show: boolean, lead: string[], chor: boolean): Outcome {
  const svc = s.svcs[i];
  const t = label(id);
  const say = (lines: string[], msg: string, extra: Record<string, VarValue> = {}) => {
    if (!show) return;
    handleVars(rec, key, action, id, amount, extra);
    rec.line(...lead, ...lines);
    rec.step(msg, { probe: atSvc(id, i) });
  };
  const ok = chor ? ['ev_local', 'ev_done', 'emit'] : ['local', 'reply'];
  const refusedLines = chor ? ['ev_refused', 'emit'] : [];

  if (svc.refuse) {
    svc.refuse = false;
    svc.view[id] = i === GATEWAY ? 'rejected' : 'refused';
    if (i === GATEWAY) gateway(s, id, 'rejected');
    const why =
      i === LEDGER
        ? `say a fraud rule has frozen the payer's account`
        : i === LIMITS
          ? `say ${t} would take the payer over today's limit`
          : `the scheme rejects it: say the payee's account is closed`;
    say(
      [chor ? 'ev_local' : 'refuse', ...refusedLines, 'refuse'],
      `${svc.name} refuses ${action} for ${t}: ${why}. Its local transaction rolls back, so its database holds nothing new, not even the key.`,
      { 'self.refuse': true },
    );
    return 'refused';
  }

  let extra: Record<string, VarValue> = {};
  if (action === 'reserve') {
    const f = free(s);
    const h = held(s);
    extra = { held: h, free: f };
    if (show) {
      handleVars(rec, key, action, id, amount, extra);
      rec.markCell(dbId(LEDGER), 0, 'compare');
      rec.line(...lead, 'free', 'check');
      rec.compare(`free ${money(f)}`, f >= amount ? '≥' : '<', money(amount), f >= amount ? 'hold it' : f + h >= amount ? 'only holds in the way' : 'not enough money', {
        probe: atSvc(id, i),
        message:
          `Ledger works out the free money: balance ${money(s.balance)} minus ${money(h)} held for sagas in flight is ${money(f)}. ` +
          (f >= amount ? `That covers ${money(amount)}.` : `That does not cover ${money(amount)}.`),
      });
      rec.unmark(dbId(LEDGER));
    } else rec.count('comparisons');
    if (f < amount) {
      if (f + h >= amount) {
        svc.view[id] = 'pending';
        if (show) {
          for (let c = 1; c <= 2; c++) rec.markCell(dbId(LEDGER), c, 'compare');
          rec.line(...lead, 'pending');
          rec.step(
            `The money is there, but another saga's hold sits on it. Because the hold is labelled with its saga, Ledger can tell the difference and answer "pending, try later" instead of "insufficient funds". The hold is a semantic lock.`,
            { probe: atSvc(id, i) },
          );
          rec.unmark(dbId(LEDGER));
        }
        return 'pending';
      }
      svc.view[id] = 'refused';
      say(['insufficient', ...refusedLines], `Ledger refuses: ${t} needs ${money(amount)} and the payer has ${money(f)}. Nothing was written.`, extra);
      return 'refused';
    }
    s.holds[id] = amount;
  } else if (action === 'hold') {
    if (s.used + amount > s.limit) {
      svc.view[id] = 'refused';
      say(['limit_check', 'over_limit', ...refusedLines], `Limits refuses: ${money(s.used)} used plus ${money(amount)} is over today's limit of ${money(s.limit)}. Nothing was written.`, {
        'self.used': s.used,
        'self.limit': s.limit,
      });
      return 'refused';
    }
    s.used += amount;
    s.counted[id] = amount;
    extra = { 'self.used': s.used, 'self.limit': s.limit };
  } else if (action === 'submit') {
    gateway(s, id, 'accepted');
  } else if (action === 'post') {
    s.balance -= s.holds[id];
    delete s.holds[id];
    extra = { 'self.balance': s.balance };
  } else if (action === 'release') {
    delete s.holds[id];
  } else if (action === 'unhold') {
    s.used -= s.counted[id] ?? 0;
    delete s.counted[id];
  }
  const reply = VIEW[action];
  svc.view[id] = reply;
  keep(svc, key, reply);
  rec.count('local');
  if (action === 'release' || action === 'unhold') rec.count('compensations');
  if (!show) return 'ok';

  const cell = dbCell(s, i, action, id);
  if (cell !== null) rec.markCell(dbId(i), cell, 'ok');
  const anchor = ACTION_LINE[action];
  const tail = chor ? ` Then it publishes ${REACTIONS[s.lastEvent[id]]?.done ?? ''}.` : ` It replies ${reply}.`;
  const body: Record<string, string> = {
    reserve: `In one local transaction Ledger writes a hold of ${money(amount)} for ${t} and stores the key ${key} with its reply. Nothing is debited: the hold is visible to every reader as pending.`,
    hold: `Limits checks ${money(s.used - amount)} used plus ${money(amount)} against today's ${money(s.limit)}: fine. In one local transaction it counts ${money(amount)} against the limit and stores the key ${key}.`,
    submit: `Gateway submits ${t} to the payment scheme, which accepts it, and records that with the key ${key}. This is the pivot: the money has left and cannot be called back.`,
    post: `Ledger turns ${t}'s hold into a debit: the balance goes from ${money(s.balance + amount)} to ${money(s.balance)}. It stores the key ${key}. Posting cannot be refused: the hold already set the money aside.`,
    release: `Ledger drops ${t}'s hold of ${money(amount)} in a new local transaction and stores ${key}. This is a compensation: a new action that undoes the effect, not a rollback. The hold stays in Ledger's history.`,
    unhold: `Limits gives back ${money(amount)} of today's limit in a new local transaction and stores ${key}. Another forward action that cancels the first.`,
  };
  handleVars(rec, key, action, id, amount, { ...extra, reply: q(reply) });
  rec.line(...lead, ...(action === 'reserve' ? ['check', anchor] : action === 'hold' ? ['limit_check', anchor] : [anchor]), ...ok);
  rec.step(body[action] + tail, { probe: atSvc(id, i) });
  rec.unmark(dbId(i));
  return 'ok';
}

/** The cell of a service's database row that an action just wrote, or null when it removed what it wrote. */
function dbCell(s: SagaState, i: number, action: string, id: number): number | null {
  if (action === 'post') return 0;
  if (action === 'release' || action === 'unhold') return null;
  if (i === GATEWAY) return s.sent.findIndex((x) => x.saga === id);
  const ids = Object.keys(i === LEDGER ? s.holds : s.counted).slice(-2).map(Number);
  const at = ids.indexOf(id);
  return at < 0 ? null : at + 1;
}

const BRIEF: Record<string, (amount: number) => string> = {
  reserve: (a) => `holds ${money(a)}`,
  hold: (a) => `counts ${money(a)} against today's limit`,
  submit: () => `submits it and the scheme accepts`,
  post: (a) => `debits ${money(a)}`,
};

const VIEW: Record<string, string> = { reserve: 'reserved', hold: 'held', submit: 'accepted', post: 'posted', release: 'released', unhold: 'returned' };
const ACTION_LINE: Record<string, string> = { reserve: 'reserved', hold: 'held', submit: 'submitted', post: 'post', release: 'release', unhold: 'unheld' };

// ---- the orchestrator -----------------------------------------------------------

type CallResult = Outcome | 'crash';

/** Orchestrator.call: send, and on silence send again with the same key. */
function call(s: SagaState, rec: Rec, row: Row, i: number, key: string, action: string, show: boolean, lead: string[]): CallResult {
  const svc = s.svcs[i];
  const cmd = { from: ORCH, to: svcId(i), text: `${action} ${key}`, tone: 'path' as Tone };
  let first = true;
  for (;;) {
    if (show && !first) {
      s.msgs = [cmd];
      callVars(rec, i, key, action, row);
      rec.line(...lead, 'send_cmd');
      rec.step(`The orchestrator sends ${action} to ${svc.name} again, with the same key ${key}.`, { probe: atOrch(row.id) });
    }
    first = false;
    if (svc.down > 0) {
      svc.down--;
      rec.count('retries');
      if (show) {
        s.msgs = [{ ...cmd, tone: 'bad', dashed: true }];
        s.outage = i;
        handleVars(rec, key, action, row.id, row.amount, { 'self.down': svc.down + 1 });
        rec.line(...lead, 'send_cmd', 'down');
        rec.step(`${svc.name} is down. The command goes nowhere and nothing runs.`, { probe: atSvc(row.id, i) });
        s.msgs = [];
        s.outage = null;
        callVars(rec, i, key, action, row);
        rec.line(...lead, 'timeout');
        rec.step(
          `No reply comes, so the orchestrator times out. It cannot tell "down" from "did it but the reply was lost", so it does the only safe thing: send the same command with the same key. Real code waits longer each time.`,
          { probe: atOrch(row.id) },
        );
      }
      continue;
    }
    let outcome: Outcome = 'ok';
    const stored = svc.replies[key];
    if (stored !== undefined) {
      if (show) {
        rec.markCell(keysId(i), 1 + Math.max(0, svc.recent.indexOf(key)), 'compare');
        handleVars(rec, key, action, row.id, row.amount, { 'key in self.replies': true });
        rec.line(...lead, 'dedupe');
        rec.compare(`key ${key}`, '=', `stored: ${stored}`, 'answer from the record', {
          probe: atSvc(row.id, i),
          message: `${svc.name} has seen ${key} before: it stored the key with its reply in the same local transaction. It sends back "${stored}" and does nothing else. No second ${action}.`,
        });
        rec.unmark(keysId(i));
      } else rec.count('comparisons');
    } else {
      outcome = local(s, rec, i, key, action, row.id, row.amount, show, lead, false);
    }
    const reply = outcome === 'ok' ? svc.replies[key] : outcome;
    if (outcome !== 'ok') {
      if (show) s.msgs = [{ from: svcId(i), to: ORCH, text: outcome, tone: outcome === 'pending' ? 'compare' : 'bad' }];
      return outcome;
    }
    if (s.crashAfter === key) {
      s.crashAfter = null;
      return 'crash';
    }
    const li = s.lost.indexOf(key);
    if (li >= 0) {
      s.lost.splice(li, 1);
      rec.count('retries');
      if (show) {
        s.msgs = [{ from: svcId(i), to: ORCH, text: `${reply}: lost`, tone: 'bad', dashed: true }];
        callVars(rec, i, key, action, row, String(reply));
        rec.line(...lead, 'lost');
        rec.step(
          `The reply "${reply}" is lost on the way back. ${svc.name} has done its part, but the orchestrator cannot know that. It times out and must try again.`,
          { probe: atOrch(row.id) },
        );
      }
      continue;
    }
    if (show) s.msgs = [{ from: svcId(i), to: ORCH, text: String(reply), tone: 'ok' }];
    return 'ok';
  }
}

interface Opts {
  /** Narrate in full. Otherwise one frame per step, unless something happens. */
  show: boolean;
}

/** Will something worth seeing happen at this step? Then it is narrated in full. */
function eventful(s: SagaState, row: Row, i: number, key: string): boolean {
  const svc = s.svcs[STEPS[i].svc];
  return svc.down > 0 || svc.refuse || s.lost.includes(key) || s.crashAfter === key || !!svc.replies[key] || naturalRefusal(s, STEPS[i].action, row.amount);
}

/** Orchestrator.step forwards: one action. Returns what happened. */
function forward(s: SagaState, rec: Rec, row: Row, o: Opts, resent = false): CallResult {
  const i = row.done;
  const st = STEPS[i];
  const svc = s.svcs[st.svc];
  const key = stepKey(row.id, i);
  const t = label(row.id);
  const show = rec.recording && (o.show || eventful(s, row, i, key));
  s.focus = row.id;
  if (show) {
    s.msgs = [{ from: ORCH, to: svcId(st.svc), text: `${st.action} ${key}`, tone: 'path' }];
    rec.mark(rowId(row.id), 'path');
    stepVars(rec, row, i, key, st.action);
    rec.line('read', 'key', 'send', 'send_cmd');
    rec.step(
      resent
        ? `The row says ${row.done} of ${N} done, so step ${i + 1} is next. The orchestrator cannot know whether its command arrived before it died, so it sends ${st.action} again with the same key ${key}.`
        : `The orchestrator reads ${t}'s row: ${row.done} of ${N} done, so step ${i + 1} is next. It sends ${st.action} to ${svc.name} with the idempotency key ${key}. The key is the same on every retry.`,
      { probe: atOrch(row.id) },
    );
    rec.unmark(rowId(row.id));
  }
  const r = call(s, rec, row, st.svc, key, st.action, show, ['send']);
  if (r === 'crash') return r;
  if (r === 'refused') {
    row.state = 'compensating';
    if (show) {
      rec.mark(rowId(row.id), 'bad');
      stepVars(rec, row, i, key, st.action);
      rec.line('failed');
      rec.step(
        row.done === 0
          ? `The orchestrator writes compensating to ${t}'s row. Nothing is in effect yet, so there is nothing to undo.`
          : `The orchestrator writes compensating to ${t}'s row before it undoes anything, so a crash now would resume the undoing. ${steps(row.done)} in effect, undone newest first.`,
        { probe: atRow(s, row.id) },
      );
      rec.unmark(rowId(row.id));
    }
    s.msgs = [];
    return r;
  }
  if (r === 'pending') {
    row.state = 'waiting';
    if (show) {
      rec.mark(rowId(row.id), 'compare');
      stepVars(rec, row, i, key, st.action);
      rec.line('park');
      rec.step(`The orchestrator writes waiting to ${t}'s row and parks it. It will try step ${i + 1} again once the other saga has finished.`, { probe: atRow(s, row.id) });
      rec.unmark(rowId(row.id));
    }
    s.msgs = [];
    return r;
  }
  row.done = i + 1;
  if (row.done === N) row.state = 'completed';
  if (show) {
    rec.mark(rowId(row.id), 'ok');
    stepVars(rec, row, i, key, st.action);
    rec.line(...(row.done === N ? ['record', 'completed'] : ['record']));
    rec.step(
      row.done === N
        ? `The orchestrator writes ${t}'s row: ${N} of ${N} done, completed.`
        : `The orchestrator writes ${t}'s row: ${row.done} of ${N} done. Only then does it move on, so a crash can never make it skip a step.` +
            (i === PIVOT ? ` Past the pivot, ${t} can only go forward.` : ``),
      { probe: atRow(s, row.id) },
    );
    rec.unmark(rowId(row.id));
  } else if (rec.recording) {
    rec.mark(rowId(row.id), 'ok');
    const cell = dbCell(s, st.svc, st.action, row.id);
    if (cell !== null) rec.markCell(dbId(st.svc), cell, 'ok');
    stepVars(rec, row, i, key, st.action);
    rec.line('send', ACTION_LINE[st.action], 'local', 'record');
    rec.step(`Step ${i + 1}: ${svc.name} ${BRIEF[st.action](row.amount)} under key ${key} and replies. The row moves to ${row.done} of ${N} done.`, { probe: atSvc(row.id, st.svc) });
    rec.unmark(rowId(row.id));
    rec.unmark(dbId(st.svc));
  }
  s.msgs = [];
  return 'ok';
}

/** Orchestrator.compensate: undo the newest step still in effect. */
function compensate(s: SagaState, rec: Rec, row: Row, o: Opts): void {
  const t = label(row.id);
  const i = row.done - 1;
  s.focus = row.id;
  if (i < 0) {
    row.state = 'compensated';
    s.compensated++;
    rec.count('compensated');
    if (rec.recording) {
      rec.mark(rowId(row.id), 'bad');
      compVars(rec, row, i);
      rec.line('undo_next', 'compensated');
      rec.step(`Nothing of ${t} is in effect any more. The orchestrator writes compensated to its row.`, { probe: atRow(s, row.id) });
      rec.unmark(rowId(row.id));
    }
    return;
  }
  const st = STEPS[i];
  const undo = st.undo!;
  const key = undoKey(row.id, i);
  const svc = s.svcs[st.svc];
  const show = rec.recording && o.show;
  if (show) {
    s.msgs = [{ from: ORCH, to: svcId(st.svc), text: `${undo} ${key}`, tone: 'path' }];
    compVars(rec, row, i, key, undo);
    rec.line('read', 'to_comp', 'undo_next', 'undo_key', 'undo_send', 'send_cmd');
    rec.step(
      `${t} is compensating with ${steps(row.done)} in effect. Undo the newest first: the orchestrator sends ${undo} to ${svc.name} with the key ${key}.`,
      { probe: atOrch(row.id) },
    );
  }
  call(s, rec, row, st.svc, key, undo, show, ['undo_send']);
  row.done = i;
  if (show) {
    rec.mark(rowId(row.id), 'path');
    compVars(rec, row, i, key, undo);
    rec.line('undo_record');
    rec.step(`The orchestrator writes ${t}'s row: ${row.done} of ${N} still in effect.`, { probe: atRow(s, row.id) });
    rec.unmark(rowId(row.id));
  } else if (rec.recording) {
    compVars(rec, row, i, key, undo);
    rec.line('to_comp', 'undo_send', ACTION_LINE[undo], 'undo_record');
    rec.step(`Undo step ${i + 1}: ${svc.name} ${VIEW[undo] === 'released' ? 'releases the hold' : 'gives the limit back'} under key ${key}, and the row moves to ${row.done} of ${N} in effect.`, { probe: atSvc(row.id, st.svc) });
    rec.unmark(dbId(st.svc));
  }
  s.msgs = [];
}

/** Orchestrator.step. */
function stepOnce(s: SagaState, rec: Rec, row: Row, o: Opts): CallResult {
  if (row.state === 'compensating') {
    compensate(s, rec, row, o);
    return 'ok';
  }
  const r = forward(s, rec, row, o);
  if (row.state === 'completed') {
    s.completed++;
    rec.count('completed');
  }
  return r;
}

/** Orchestrator.run: step until the saga ends, waits or the orchestrator dies. */
function runSaga(s: SagaState, rec: Rec, row: Row, show: (row: Row) => boolean): CallResult {
  while (LIVE.includes(row.state)) {
    const r = stepOnce(s, rec, row, { show: show(row) });
    if (r === 'crash') return r;
  }
  return 'ok';
}

function begin(s: SagaState, rec: Rec, amount: number, lead: string[], show: boolean): Row {
  const row: Row = { id: ++s.next, amount, done: 0, state: 'running' };
  s.log.push(row);
  s.focus = row.id;
  rec.mark(SAGA, 'key');
  if (rec.recording) {
    rec.mark(rowId(row.id), 'ok');
    rec.vars({ saga: q(label(row.id)), amount, 'log[saga]["state"]': q(row.state) });
    rec.line(...lead, 'begin');
    rec.step(
      show
        ? `${label(row.id)} begins: pay ${money(amount)} from the payer's account by Faster Payments. Before it sends anything, the orchestrator writes ${label(row.id)}'s row to its saga log: 0 of ${N} done, running. That row is how it will find its place after a crash.`
        : `${label(row.id)} begins: a ${money(amount)} payment. The orchestrator writes its row first: 0 of ${N} done, running.`,
      { probe: atRow(s, row.id) },
    );
    rec.unmark(rowId(row.id));
  }
  return row;
}

function finish(_s: SagaState, rec: Rec, row: Row, tail = ''): void {
  if (!rec.recording) return;
  const t = label(row.id);
  runVars(rec, row);
  rec.line('loop');
  rec.step(
    row.state === 'completed'
      ? `${t} completed: ${N} local transactions in 3 services, each committed on its own. No lock was held across services and no service waited for another's commit.${tail}`
      : `${t} compensated: every step that took effect has been undone by a new action, newest first, and the payer's money is free again.${tail}`,
    { probe: atSaga(row.id) },
  );
}

/** Refuse to start another saga while one is in flight. Returns true when it refused. */
function busy(s: SagaState, rec: Rec, anchor: string): boolean {
  if (s.mode === 'choreography') {
    if (!s.queue.length) return false;
    rec.vars({ 'len(queue)': s.queue.length });
    rec.line(anchor);
    rec.step(`${label(s.focus)} still has events on the broker. Use Step to deliver them first.`, { probe: atSaga(s.focus) });
    return true;
  }
  const row = inFlight(s);
  if (!row) return false;
  s.focus = row.id;
  runVars(rec, row);
  rec.line(anchor);
  rec.step(`${label(row.id)} is still in flight, ${row.done} of ${N} done. Use Step to take it to the end first: this page follows one saga at a time.`, { probe: atSaga(row.id) });
  return true;
}

// ---- choreography -------------------------------------------------------------

/** Choreography.deliver: one event to the service that listens for it. */
function deliver(s: SagaState, rec: Rec): void {
  const ev = s.queue.shift()!;
  const id = ev.saga;
  const t = label(id);
  s.focus = id;
  s.lastEvent[id] = ev.name;
  const r = REACTIONS[ev.name];
  if (!r) {
    const ok = ev.name === 'posted';
    if (ok) {
      s.completed++;
      rec.count('completed');
    } else {
      s.compensated++;
      rec.count('compensated');
    }
    if (rec.recording) {
      s.msgs = [];
      rec.vars({ event: q(ev.name), saga: q(t), amount: s.amounts[id] });
      rec.line('listener', 'end');
      rec.step(
        ok
          ? `${ev.name} reaches the broker and nobody listens for it: ${t} is complete. But no single service knows that. Ledger says posted, Limits says held, Gateway says accepted.`
          : `failed reaches the broker and nobody listens: ${t} has been undone. To see that from outside, you would have to read Ledger, Limits and Gateway and join what they say. There is no row that says "${t}: compensated".`,
        { probe: atOrch(id) },
      );
    }
    return;
  }
  const key = `${t}-${ev.name}`;
  const svc = s.svcs[r.svc];
  const out = local(s, rec, r.svc, key, r.action, id, s.amounts[id], false, [], true);
  const next = out === 'ok' ? r.done : (r.refused ?? 'failed');
  s.queue.push({ name: next, saga: id });
  if (!rec.recording) return;
  // One arrow per frame: the event this service publishes. The sentence names the one it heard.
  s.msgs = [{ from: svcId(r.svc), to: ORCH, text: next, tone: out === 'ok' ? 'ok' : 'bad' }];
  const what: Record<string, string> = {
    reserve: `holds ${money(s.amounts[id])}`,
    hold: `counts ${money(s.amounts[id])} against today's limit`,
    submit: `submits it to the scheme, which accepts: the pivot`,
    post: `turns the hold into a debit`,
    release: `releases the hold, a compensation`,
    unhold: `gives the limit back, a compensation`,
  };
  const comp = r.action === 'release' || r.action === 'unhold';
  const cell = out === 'ok' ? dbCell(s, r.svc, r.action, id) : null;
  if (cell !== null) rec.markCell(dbId(r.svc), cell, 'ok');
  rec.vars({ event: q(ev.name), saga: q(t), amount: s.amounts[id], action: q(r.action), key: q(key), nxt: q(next) });
  rec.line('listener', 'ev_key', ...(out === 'ok' ? ['ev_local', ACTION_LINE[r.action], 'ev_done'] : ['ev_local', 'ev_refused']), 'emit');
  rec.step(
    out === 'ok'
      ? `${svc.name} listens for ${ev.name}. It ${what[r.action]} for ${t} in one local transaction, keyed ${key}, and publishes ${next} through its outbox in the same transaction.` +
          (comp ? ` Nobody told it to: its own code knows that ${ev.name} means undo.` : ``)
      : `${svc.name} listens for ${ev.name}, but refuses ${r.action} for ${t}: ${r.svc === GATEWAY ? `the scheme rejects it, say the payee's account is closed` : r.svc === LIMITS ? `say ${t} is over today's limit` : `say the account is frozen`}. Its transaction rolls back, and it publishes ${next}. Whoever listens for ${next} must undo their own part.`,
    { probe: atSvc(id, r.svc) },
  );
  rec.unmark(dbId(r.svc));
  s.msgs = [];
}

function publish(s: SagaState, rec: Rec, amount: number): number {
  const id = ++s.next;
  s.amounts[id] = amount;
  s.focus = id;
  s.lastEvent[id] = 'requested';
  s.queue.push({ name: 'requested', saga: id });
  rec.mark(SAGA, 'key');
  if (rec.recording) {
    s.msgs = [{ from: SAGA, to: ORCH, text: 'requested', tone: 'path' }];
    rec.vars({ saga: q(label(id)), amount });
    rec.line('request');
    rec.step(
      `${label(id)} begins: the payments API publishes requested for ${money(amount)}. There is no orchestrator and no saga row. Each service has its own code saying which event it listens for and what it publishes next.`,
      { probe: atSaga(id) },
    );
    s.msgs = [];
  }
  return id;
}

function drainAll(s: SagaState, rec: Rec): void {
  while (s.queue.length) deliver(s, rec);
}

function chorOnly(s: SagaState, rec: Rec, anchor: string, what: string): boolean {
  if (s.mode !== 'choreography') return false;
  rec.vars();
  rec.line(anchor);
  rec.step(`This page shows ${what} with an orchestrator: set Coordination to orchestration to run it. With choreography the idea is the same, but the broker redelivers events and each service dedupes them by key.`);
  return true;
}

// ---- operations ---------------------------------------------------------------

export function start(s: SagaState, rec: Rec): void {
  rec.vars();
  if (s.mode === 'choreography') {
    if (busy(s, rec, 'request')) return;
    const id = publish(s, rec, AMOUNT);
    drainAll(s, rec);
    if (rec.recording) {
      rec.vars({ 'len(queue)': s.queue.length });
      rec.line('deliver');
      rec.step(
        `The same ${N} local transactions as with an orchestrator, chained by events: requested, reserved, held, accepted, posted. Easy to follow when it works. Now picture the failure paths: they are spread across three codebases.`,
        { probe: atSaga(id) },
      );
    }
    return;
  }
  if (busy(s, rec, 'begin')) return;
  const row = begin(s, rec, AMOUNT, [], true);
  runSaga(s, rec, row, () => true);
  finish(s, rec, row);
}

/** One step of the saga in flight, or begin a new one. */
export function step(s: SagaState, rec: Rec): void {
  rec.vars();
  if (s.mode === 'choreography') {
    if (!s.queue.length) {
      publish(s, rec, AMOUNT);
      return;
    }
    deliver(s, rec);
    return;
  }
  const row = inFlight(s);
  if (!row) {
    const r = begin(s, rec, AMOUNT, ['run'], true);
    if (rec.recording) {
      runVars(rec, r);
      rec.line('run', 'loop');
      rec.step(`Press Step again to send step 1.`, { probe: atRow(s, r.id) });
    }
    return;
  }
  if (row.state === 'waiting') {
    row.state = 'running';
    s.focus = row.id;
    if (rec.recording) {
      rec.vars({ saga: q(label(row.id)), 'row["state"]': q(row.state) });
      rec.line('parked', 'unpark');
      rec.step(`${label(row.id)} was parked. The orchestrator marks it running and tries again.`, { probe: atRow(s, row.id) });
    }
  }
  stepOnce(s, rec, row, { show: true });
  if (row.state === 'completed' || row.state === 'compensated') finish(s, rec, row);
}

/** Clear the page's switches, so one that was never reached cannot hit the next saga. */
function disarm(s: SagaState): void {
  for (const v of s.svcs) {
    v.refuse = false;
    v.down = 0;
  }
  s.lost = [];
  s.crashAfter = null;
}

const REASON = ['a fraud rule has frozen the account', "the payment would go over today's limit", "the scheme rejects it: the payee's account is closed"];

/** Make step k (1 to 3) refuse, and watch the compensations run in reverse. */
export function fail(s: SagaState, k: number, rec: Rec): void {
  rec.vars();
  if (!Number.isInteger(k) || k < 1 || k > N) {
    rec.line('refuse');
    rec.step(`Enter a step from 1 to 3. Step 4 comes after the pivot and is built never to refuse; use Pivot to see it fail anyway.`);
    return;
  }
  if (k === N) {
    rec.line('post');
    rec.step(`Step 4, post, comes after the pivot: the money has left, so it must not refuse. Ledger set the money aside at step 1, so it has no reason to. If it fails for a technical reason, it is retried. Use Pivot to see that.`);
    return;
  }
  const st = STEPS[k - 1];
  const svc = s.svcs[st.svc];
  if (s.mode === 'choreography') {
    if (busy(s, rec, 'request')) return;
    svc.refuse = true;
    rec.mark(svcId(st.svc), 'compare');
    rec.vars({ 'self.refuse': true });
    rec.line('refuse');
    rec.step(`${svc.name} will refuse the next ${st.action}, at step ${k}: say ${REASON[k - 1]}.`);
    rec.unmark(svcId(st.svc));
    const id = publish(s, rec, AMOUNT);
    drainAll(s, rec);
    disarm(s);
    if (rec.recording) {
      rec.vars({ 'len(queue)': s.queue.length });
      rec.line('deliver');
      rec.step(
        `${label(id)} is undone, by ${k === 1 ? 'nobody: nothing had happened' : `a chain of events nobody drew in one place: ${k === 3 ? 'rejected made Limits give the limit back, returned made Ledger release the hold' : 'over_limit made Ledger release the hold'}`}. To find out where a choreographed saga is stuck, you read every service's logs. That is the price of having no coordinator.`,
        { probe: atSaga(id) },
      );
    }
    return;
  }
  if (busy(s, rec, 'refuse')) return;
  svc.refuse = true;
  rec.mark(svcId(st.svc), 'compare');
  rec.vars({ 'self.refuse': true });
  rec.line('refuse');
  rec.step(`${svc.name} will refuse the next ${st.action}, at step ${k}: say ${REASON[k - 1]}.`);
  rec.unmark(svcId(st.svc));
  const row = begin(s, rec, AMOUNT, [], false);
  runSaga(s, rec, row, (r) => r.state === 'compensating');
  disarm(s);
  finish(
    s,
    rec,
    row,
    k === 1 ? ` Here the first step failed, so there was nothing to undo.` : ` ${k - 1} ${k === 2 ? 'compensation' : 'compensations'}, in reverse order, each its own local transaction with its own key.`,
  );
}

/** Lose the reply to step k, so the orchestrator resends the same command. */
export function timeout(s: SagaState, k: number, rec: Rec): void {
  rec.vars();
  if (chorOnly(s, rec, 'lost', 'a lost reply')) return;
  if (!Number.isInteger(k) || k < 1 || k > N) {
    rec.line('lost');
    rec.step(`Enter a step from 1 to ${N}: the step whose reply will be lost.`);
    return;
  }
  if (busy(s, rec, 'lost')) return;
  const st = STEPS[k - 1];
  const key = stepKey(s.next + 1, k - 1);
  s.lost.push(key);
  rec.vars({ 'self.lost': s.lost.map(q) });
  rec.line('lost');
  rec.step(`The reply to step ${k}, ${st.action} at ${NAMES[st.svc]}, will be lost on the network. The command itself will arrive.`);
  const row = begin(s, rec, AMOUNT, [], false);
  runSaga(s, rec, row, () => false);
  disarm(s);
  finish(s, rec, row, ` One retry, and no double ${st.action}: the key made the resend harmless.`);
}

/** Kill the orchestrator after the service did step k but before the row records it. */
export function crashOrchestrator(s: SagaState, k: number, rec: Rec): void {
  rec.vars();
  if (s.mode === 'choreography') {
    rec.line('crash');
    rec.step(
      `With choreography there is no orchestrator to crash. A service that dies mid-event leaves the event unacknowledged on the broker, which delivers it again when the service is back; the key makes that harmless. Set Coordination to orchestration to watch a coordinator die.`,
    );
    return;
  }
  if (!Number.isInteger(k) || k < 1 || k > N) {
    rec.line('crash');
    rec.step(`Enter a step from 1 to ${N}: the orchestrator dies just after that step runs.`);
    return;
  }
  if (busy(s, rec, 'crash')) return;
  const st = STEPS[k - 1];
  s.crashAfter = stepKey(s.next + 1, k - 1);
  const row = begin(s, rec, AMOUNT, [], false);
  const r = runSaga(s, rec, row, (x) => x.done === k - 1);
  disarm(s);
  if (r !== 'crash') {
    finish(s, rec, row);
    return;
  }
  s.orchUp = false;
  s.msgs = [];
  if (rec.recording) {
    callVars(rec, st.svc, stepKey(row.id, k - 1), st.action, row, VIEW[st.action]);
    rec.line('crash');
    rec.step(
      `The orchestrator dies with the reply in its hands, before it writes the row. ${NAMES[st.svc]} did step ${k}; the saga log still says ${row.done} of ${N} done. Its memory is gone. The log and the services' databases are not.`,
      { probe: atSaga(row.id) },
    );
  }
  s.orchUp = true;
  if (rec.recording) {
    rec.mark(rowId(row.id), 'compare');
    rec.vars({ saga: q(label(row.id)), 'row["done"]': row.done, 'row["state"]': q(row.state) });
    rec.line('scan', 'unfinished');
    rec.compare(`${label(row.id)}: ${row.done} of ${N} done`, '=', 'running', 'resume it', {
      probe: atRow(s, row.id),
      message: `The orchestrator restarts and reads its saga log from the top. ${label(row.id)}'s row says running, ${row.done} of ${N} done: unfinished, so it resumes it from that step.`,
    });
    rec.unmark(rowId(row.id));
  } else rec.count('comparisons');
  forward(s, rec, row, { show: true }, true);
  if (row.state === 'completed') {
    s.completed++;
    rec.count('completed');
  }
  runSaga(s, rec, row, () => false);
  finish(s, rec, row, ` The crash cost one resend. Nothing was done twice and nothing was skipped, because the row was written after each reply and every command carried its key.`);
}

/** A second saga meets the first one's hold: no isolation, and the semantic lock that copes. */
export function concurrent(s: SagaState, rec: Rec): void {
  rec.vars();
  if (chorOnly(s, rec, 'pending', 'two sagas meeting')) return;
  if (busy(s, rec, 'pending')) return;
  const f = free(s);
  if (f < AMOUNT + 30) {
    rec.vars({ amount: AMOUNT, held: held(s), free: f });
    rec.line('insufficient');
    rec.step(`The payer has only ${money(f)} free, not enough to show two payments competing. Change Coordination to start again with ${money(BALANCE)}.`);
    return;
  }
  // The first saga takes most of the free money and stops after two steps.
  const a = begin(s, rec, f - 30, [], false);
  for (let i = 0; i < 2 && a.state === 'running'; i++) forward(s, rec, a, { show: false });
  if (a.state !== 'running') {
    runSaga(s, rec, a, () => false);
    finish(s, rec, a, ` It stopped before the second saga could meet it. Try again.`);
    return;
  }
  const b = begin(s, rec, AMOUNT, [], true);
  if (forward(s, rec, b, { show: true }) !== 'pending') {
    runSaga(s, rec, b, () => false);
    runSaga(s, rec, a, () => false);
    finish(s, rec, a);
    return;
  }
  if (rec.recording) {
    rec.line('park');
    rec.step(
      `This is the missing I in ACID. ${label(a.id)} has not finished, yet ${label(b.id)} sees its effect. A single database would hide ${label(a.id)}'s hold or make ${label(b.id)} wait on a lock. A saga holds no lock across services, so every other reader sees its half-done state.`,
      { probe: atSaga(b.id) },
    );
    rec.step(
      `Without the semantic lock, step 1 would have been a plain debit, and ${label(b.id)} would be refused outright for lack of money. If ${label(a.id)} then failed and paid the money back, that refusal was based on money that never left: a dirty read.`,
      { probe: atSaga(b.id) },
    );
  }
  // The first saga fails at the pivot and gives the money back.
  s.svcs[GATEWAY].refuse = true;
  s.focus = a.id;
  if (rec.recording) {
    runVars(rec, a);
    rec.line('loop');
    rec.step(`Back to ${label(a.id)}. Say the scheme rejects it: the payee's account is closed.`, { probe: atSaga(a.id) });
  }
  runSaga(s, rec, a, () => false);
  disarm(s);
  if (rec.recording) {
    runVars(rec, a);
    rec.line('loop');
    rec.step(`${label(a.id)} is compensated: its hold is gone, so the ${money(a.amount)} never left.`, { probe: atSaga(a.id) });
  }
  // Then the parked saga goes again.
  b.state = 'running';
  s.focus = b.id;
  if (rec.recording) {
    rec.mark(rowId(b.id), 'path');
    rec.vars({ saga: q(label(b.id)), 'row["state"]': q(b.state) });
    rec.line('parked', 'unpark');
    rec.step(`The orchestrator retries parked sagas. ${label(b.id)} is waiting, so it marks it running and sends step 1 again.`, { probe: atRow(s, b.id) });
    rec.unmark(rowId(b.id));
  }
  runSaga(s, rec, b, (x) => x.done === 0);
  finish(s, rec, b, ` It waited instead of being refused on money that was only on hold. Other fixes for missing isolation: commutative updates, re-reading a value before using it, and routing by value.`);
}

/** After the pivot succeeds, a failure can only be retried. */
export function pivot(s: SagaState, rec: Rec): void {
  rec.vars();
  if (chorOnly(s, rec, 'post', 'a failure after the pivot')) return;
  if (busy(s, rec, 'post')) return;
  const row = begin(s, rec, AMOUNT, [], false);
  for (let i = 0; i < 3 && row.state === 'running'; i++) forward(s, rec, row, { show: i === PIVOT });
  if (row.state !== 'running') {
    runSaga(s, rec, row, () => false);
    finish(s, rec, row);
    return;
  }
  s.svcs[LEDGER].down = 2;
  if (rec.recording) {
    rec.mark(svcId(LEDGER), 'bad');
    rec.vars({ saga: q(label(row.id)), amount: row.amount });
    rec.line('submitted');
    rec.step(
      `That was the point of no return. Now say Ledger goes down for a while. Before the pivot, the orchestrator could give up and compensate. Not now: the scheme has the money and cannot hand it back. ${label(row.id)} can only go forward.`,
      { probe: atSaga(row.id) },
    );
    rec.unmark(svcId(LEDGER));
  }
  runSaga(s, rec, row, () => true);
  disarm(s);
  finish(
    s,
    rec,
    row,
    ` Two retries of post with the same key. That is why the order matters: put the steps that can be undone first, the irreversible one next, and after it only steps that are certain to succeed in the end.`,
  );
}

// ---- layout -------------------------------------------------------------------

const SAGA_W = 56;
const ORCH_W = 140;
const NAME_W = 84;
const STATE_W = 104;
const ROW_ID_W = 52;
const ROW_DONE_W = 118;
const ROW_STATE_W = 128;
const BAL_W = 84;
const HOLD_W = 100;
const SENT_W = 140;
const KEY_LABEL_W = 52;
const KEY_W = 112;
const GAP = 3;
const RIGHT = 940;
const ORCH_X = 400;
const COL_X = [150, 470, 790];
const TOP_Y = 0;
const ROW_PITCH = CELL_H + 8;
const ROWS_SHOWN = 3;
const SVC_Y = 230;
const tray = (cells: number[]) => TRAY_PAD * 2 + cells.reduce((a, b) => a + b, 0) + (cells.length - 1) * GAP;
const DB_Y = SVC_Y + CELL_H / 2 + LABEL_MAX + 10 + CELL_H / 2 + TRAY_PAD;
const KEYS_Y = DB_Y + CELL_H + TRAY_PAD * 2 + 8;
const LEFT = -44;
const TOP = TOP_Y - CELL_H / 2 - PROBE_H - 16 - LABEL_MAX;
const BOTTOM = KEYS_Y + CELL_H / 2 + TRAY_PAD;

function shownRows(s: SagaState): Row[] {
  return s.log.slice(-ROWS_SHOWN).reverse();
}

const stateTone = (t: string): Tone | undefined =>
  ['reserved', 'held', 'accepted', 'posted', 'completed'].includes(t) ? 'ok' : ['released', 'returned', 'rejected', 'refused', 'compensated', 'down'].includes(t) ? 'bad' : undefined;

export function layout(s: SagaState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];
  const chor = s.mode === 'choreography';
  const focus = s.focus;
  const row = focus && !chor ? s.log.find((r) => r.id === focus) : undefined;

  nodes.push({
    id: SAGA,
    x: SAGA_W / 2,
    y: TOP_Y,
    cells: [{ text: focus ? label(focus) : '', w: SAGA_W }],
    caption: !focus ? 'no saga\nyet' : chor ? `saga, last\nevent ${s.lastEvent[focus] ?? ''}` : row ? `saga, ${row.done} of ${N}\n${row.state}` : 'saga',
  });
  nodes.push({
    id: ORCH,
    x: ORCH_X,
    y: TOP_Y,
    cells: [{ text: chor ? 'Broker' : 'Orchestrator', w: ORCH_W }],
    tone: s.orchUp ? undefined : 'bad',
    title: s.orchUp ? undefined : 'crashed',
    caption: chor ? 'passes events on,\nknows no saga' : undefined,
  });

  const logW = tray([ROW_ID_W, ROW_DONE_W, ROW_STATE_W]);
  const logX = RIGHT - logW / 2;
  if (chor) {
    nodes.push({ id: 'nolog', x: logX, y: TOP_Y, cells: [{ text: '', w: logW - TRAY_PAD * 2 }], title: 'no saga log', caption: 'each service knows\nonly its own part' });
  } else {
    shownRows(s).forEach((r, i) => {
      nodes.push({
        id: rowId(r.id),
        x: logX,
        y: TOP_Y + i * ROW_PITCH,
        cells: [
          { text: label(r.id), w: ROW_ID_W },
          { text: `${r.done} of ${N} done`, w: ROW_DONE_W },
          { text: r.state, w: ROW_STATE_W, tone: stateTone(r.state) },
        ],
        title: i === 0 ? 'saga log, on disk' : undefined,
      });
    });
    if (!s.log.length) nodes.push({ id: 'emptylog', x: logX, y: TOP_Y, cells: [{ text: '', w: logW - TRAY_PAD * 2 }], title: 'saga log, on disk' });
  }

  s.svcs.forEach((v, i) => {
    const x = COL_X[i];
    const down = s.outage === i;
    const state = down ? 'down' : focus ? (v.view[focus] ?? '') : '';
    nodes.push({
      id: svcId(i),
      x,
      y: SVC_Y,
      tone: down ? 'bad' : undefined,
      cells: [
        { text: v.name, w: NAME_W },
        { text: state, w: STATE_W, tone: stateTone(state) },
      ],
    });
    let cells: { text: string; w: number }[];
    let title: string;
    if (i === LEDGER) {
      const hs = Object.entries(s.holds).slice(-2);
      cells = [{ text: money(s.balance), w: BAL_W }, ...[0, 1].map((j) => ({ text: hs[j] ? `${label(Number(hs[j][0]))} ${money(hs[j][1])}` : '', w: HOLD_W }))];
      title = 'balance, holds';
    } else if (i === LIMITS) {
      const cs = Object.entries(s.counted).slice(-2);
      cells = [{ text: money(s.used), w: BAL_W }, ...[0, 1].map((j) => ({ text: cs[j] ? `${label(Number(cs[j][0]))} ${money(cs[j][1])}` : '', w: HOLD_W }))];
      title = `used of ${money(s.limit)} today`;
    } else {
      cells = [0, 1].map((j) => ({ text: s.sent[j] ? `${label(s.sent[j].saga)} ${s.sent[j].result}` : '', w: SENT_W }));
      title = 'sent to the scheme';
    }
    nodes.push({ id: dbId(i), x, y: DB_Y, cells, title: `${v.name} db: ${title}` });
    const keys = chor ? v.recent.slice(-1) : v.recent;
    const kw = chor ? KEY_W * 2 + GAP : KEY_W;
    nodes.push({
      id: keysId(i),
      x,
      y: KEYS_Y,
      cells: [{ text: 'keys', w: KEY_LABEL_W, tone: 'dim' }, ...(chor ? [0] : [0, 1]).map((j) => ({ text: keys[j] ?? '', w: kw }))],
    });
  });

  for (const m of s.msgs) {
    edges.push({ id: `m-${m.from}-${m.to}`, from: m.from, to: m.to, kind: 'line', arrow: true, label: m.text, tone: m.tone, dashed: m.dashed, offset: m.offset });
  }

  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------

const STEP_ARG = { name: 'step', label: 'Step (1 to 4)', kind: 'int', min: 1, max: 4 } as const;

const def: StructureDef<SagaState> = {
  id: 'saga',
  params: [
    {
      id: 'mode',
      label: 'Coordination',
      default: 0,
      options: [
        { value: 0, label: 'Orchestration' },
        { value: 1, label: 'Choreography' },
      ],
    },
  ],
  create: (params) => create(params.mode === 1 ? 'choreography' : 'orchestration'),
  // One finished payment, so the log and the databases already show what one leaves behind.
  seed: [['start']],
  ops: [
    {
      id: 'start',
      label: 'Start saga',
      intent: 'primary',
      args: [],
      code: ['start', 'run', 'step', 'call', 'handle', 'ledger', 'limits', 'gateway', 'compensate', 'chor_start', 'react'],
      run: (s, _a, rec) => start(s, rec),
    },
    {
      id: 'step',
      label: 'Step',
      args: [],
      code: ['step', 'compensate', 'call', 'handle', 'ledger', 'limits', 'gateway', 'run', 'start', 'retry_waiting', 'chor_start', 'react'],
      run: (s, _a, rec) => step(s, rec),
    },
    {
      id: 'fail',
      label: 'Fail a step',
      intent: 'danger',
      args: [{ name: 'step', label: 'Step (1 to 3)', kind: 'int', min: 1, max: 4 }],
      code: ['step', 'compensate', 'handle', 'call', 'ledger', 'limits', 'gateway', 'start', 'run', 'chor_start', 'react'],
      run: (s, [k], rec) => fail(s, Number(k), rec),
      suggest: () => [randomInt(2, 3)],
    },
    {
      id: 'timeout',
      label: 'Lose a reply',
      args: [STEP_ARG],
      code: ['call', 'handle', 'step', 'ledger', 'limits', 'gateway', 'start', 'run', 'compensate'],
      run: (s, [k], rec) => timeout(s, Number(k), rec),
      suggest: () => [randomInt(1, 4)],
    },
    {
      id: 'crash_orchestrator',
      label: 'Crash orchestrator',
      intent: 'danger',
      args: [STEP_ARG],
      code: ['recover', 'step', 'call', 'handle', 'ledger', 'limits', 'gateway', 'start', 'run', 'compensate'],
      run: (s, [k], rec) => crashOrchestrator(s, Number(k), rec),
      suggest: () => [randomInt(1, 4)],
    },
    {
      id: 'concurrent',
      label: 'Concurrent saga',
      args: [],
      code: ['ledger', 'step', 'retry_waiting', 'compensate', 'call', 'handle', 'limits', 'gateway', 'start', 'run'],
      run: (s, _a, rec) => concurrent(s, rec),
    },
    {
      id: 'pivot',
      label: 'Fail after pivot',
      args: [],
      code: ['step', 'call', 'handle', 'ledger', 'limits', 'gateway', 'start', 'run', 'compensate'],
      run: (s, _a, rec) => pivot(s, rec),
    },
  ],
  layout,
  counters: [
    { key: 'local', label: 'Local transactions' },
    { key: 'compensations', label: 'Compensations' },
    { key: 'retries', label: 'Retries' },
    { key: 'completed', label: 'Sagas completed' },
    { key: 'compensated', label: 'Sagas compensated' },
  ],
  status: (s) => {
    const row = s.mode === 'orchestration' ? inFlight(s) : null;
    return [
      { label: 'Coordination', value: s.mode },
      { label: 'In flight', value: row ? `${label(row.id)}, ${row.done} of ${N} done` : s.queue.length ? `${label(s.focus)}, ${s.queue.length} event on the broker` : 'nothing' },
      { label: 'Payer', value: `${money(free(s))} free of ${money(s.balance)}` },
      { label: 'Completed, compensated', value: `${s.completed}, ${s.compensated}` },
    ];
  },
  tour: [['start'], ['fail', 3], ['timeout', 2], ['crash_orchestrator', 2], ['concurrent'], ['pivot']],
  source: { python, java },
  info,
};

export default def;
