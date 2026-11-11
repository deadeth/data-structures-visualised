import { LABEL_MAX, PROBE_H } from '../../core/fit';
import { CELL_H, TRAY_PAD } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/TwoPhaseCommit.java?raw';
import python from './code/two_phase_commit.py?raw';
import { info } from './info';

/**
 * Two-phase commit between one coordinator and two or three participants.
 *
 * Every transaction writes one row at each participant. Phase 1: the
 * coordinator asks each participant to prepare; a participant that can
 * promise to commit forces "prepared" to its log and votes yes. Phase 2: the
 * coordinator forces its decision to its own log, then sends it; each
 * participant applies it, releases its lock and acks.
 *
 * Logs are durable and survive a crash. Locks, a participant's state and the
 * coordinator's tally of votes and acks are in memory and do not. Messages
 * are not lost on this page except to a node that is down, and timeouts
 * happen at once.
 */
export type PState = 'idle' | 'working' | 'prepared' | 'committed' | 'aborted';
export type Kind = 'prepared' | 'commit' | 'abort' | 'end';
export type Decision = 'commit' | 'abort';

export interface Entry {
  kind: Kind;
  txn: number;
}

export interface Part {
  name: string;
  /** In memory. Shown as "down" while the participant is down. */
  state: PState;
  /** The transaction holding this participant's row lock, if any. In memory. */
  lock: number | null;
  /** Durable. */
  log: Entry[];
  up: boolean;
}

/** A message drawn as an arrow between the coordinator and one participant. */
export interface Msg {
  to: number;
  /** True for participant to coordinator. */
  back: boolean;
  text: string;
  tone: Tone;
  dashed?: boolean;
}

export interface TpcState {
  parts: Part[];
  coord: {
    log: Entry[];
    up: boolean;
    /** Commits sent but not yet acked by everyone: txn to participant indexes. In memory. */
    waiting: Record<number, number[]>;
  };
  /** The latest transaction started, from 1. 0 before the first. */
  txn: number;
  /** What the latest transaction is doing, for its caption. */
  phase: string;
  /** A transaction left undecided by a coordinator crash. */
  inDoubt: number | null;
  /** The coordinator's tally of replies, one cell per participant. In memory. */
  tally: { kind: 'votes' | 'acks'; cells: string[] };
  /** The page's own drawing of messages in flight. Empty between operations. */
  msgs: Msg[];
  committed: number;
  aborted: number;
}

export const NAMES = ['A', 'B', 'C'];
const DONE: Record<Decision, PState> = { commit: 'committed', abort: 'aborted' };

export function create(n = 3): TpcState {
  return {
    parts: Array.from({ length: n }, (_, i) => ({ name: NAMES[i], state: 'idle', lock: null, log: [], up: true })),
    coord: { log: [], up: true, waiting: {} },
    txn: 0,
    phase: '',
    inDoubt: null,
    tally: { kind: 'votes', cells: new Array<string>(n).fill('') },
    msgs: [],
    committed: 0,
    aborted: 0,
  };
}

/** The name on the chip and in the logs. It wraps after T99 so it always fits its cell. */
export const label = (id: number) => `T${((id - 1) % 99) + 1}`;

/** Transactions prepared at this participant with no decision logged after. */
export function inDoubt(p: Part): number[] {
  const decided = new Set(p.log.filter((e) => e.kind !== 'prepared').map((e) => e.txn));
  return p.log.filter((e) => e.kind === 'prepared' && !decided.has(e.txn)).map((e) => e.txn);
}

/** How the coordinator's log says a transaction ended, or null when it has no decision for it. */
export function recorded(s: TpcState, id: number): Decision | null {
  const e = s.coord.log.find((x) => x.txn === id && x.kind !== 'end');
  return e ? (e.kind as Decision) : null;
}

export function asParticipant(s: TpcState, raw: number | string): number | null {
  const i = NAMES.indexOf(String(raw).trim().toUpperCase());
  return i >= 0 && i < s.parts.length ? i : null;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const everyone = (s: TpcState) => list(s.parts.map((p) => p.name));
/** "a or b", "a, b or c": what the form accepts. */
const either = (s: TpcState) => list(s.parts.map((p) => p.name.toLowerCase())).replace(/ and (\w)$/, ' or $1');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- ids --------------------------------------------------------------------

const TXN = 'txn';
const COORD = 'coord';
const TALLY = 'tally';
const CLOG = 'clog';
const pid = (i: number) => `p${i}`;
const lid = (i: number) => `l${i}`;
/** The lock is the third cell of a participant's header, after its name and state. */
const LOCK_CELL = 2;
/** Records drawn per log. */
export const PLOG_SHOWN = 2;
export const CLOG_SHOWN = 3;

const atTxn = (id: number): Probe => ({ text: label(id), at: TXN });
const atCoord = (id: number): Probe => ({ text: label(id), at: COORD });
const atPart = (id: number, i: number): Probe => ({ text: label(id), at: pid(i) });
/** Over the newest record of the coordinator's log, so a phone scrolls to the write. */
const atNewest = (s: TpcState, id: number): Probe => ({ text: label(id), at: CLOG, cell: lastCell(s.coord.log, CLOG_SHOWN) });

/** The cell index the last record of a log is drawn in. */
const lastCell = (log: Entry[], shown: number) => Math.min(log.length, shown) - 1;

/** What one run of an operation cost, for its closing sentence. */
interface Cost {
  messages: number;
  writes: number;
  forced: number;
}

function send(rec: Rec, cost: Cost, k = 1): void {
  rec.count('messages', k);
  cost.messages += k;
}

function write(rec: Rec, cost: Cost, forced: boolean): void {
  rec.count('writes');
  cost.writes++;
  if (forced) cost.forced++;
}

// ---- the protocol, step by step ----------------------------------------------

/** Start a transaction: take the row lock at every participant that is up. */
function begin(s: TpcState, rec: Rec, lead: string[]): number {
  const id = ++s.txn;
  const t = label(id);
  s.phase = 'working';
  s.tally = { kind: 'votes', cells: new Array<string>(s.parts.length).fill('') };
  for (const p of s.parts) {
    p.lock = id;
    p.state = 'working';
  }
  rec.mark(TXN, 'key');
  s.parts.forEach((_p, i) => rec.markCell(pid(i), LOCK_CELL, 'ok'));
  rec.line(...lead, 'begin', 'lock');
  rec.step(
    `${t} starts. It writes one row at each of ${everyone(s)}, and each participant locks its row first. Nothing is permanent yet: each of them could still undo its part.`,
    { probe: atTxn(id) },
  );
  s.parts.forEach((_p, i) => rec.markCell(pid(i), LOCK_CELL, 'idle'));
  return id;
}

/** Phase 1. Returns the decision. `refuse` is the participant that will vote no, if any. */
function phaseOne(s: TpcState, rec: Rec, id: number, cost: Cost, refuse: number | null): Decision {
  const t = label(id);
  const n = s.parts.length;
  s.phase = 'phase 1';
  s.msgs = s.parts.map((_p, i) => ({ to: i, back: false, text: 'prepare', tone: 'path' as Tone }));
  send(rec, cost, n);
  rec.line('phase_one', 'send_prepare');
  rec.step(
    `Phase 1. The coordinator sends prepare ${t} to ${everyone(s)}. It is asking each one: can you promise to commit ${t}, whatever happens to you next?`,
    { probe: atCoord(id) },
  );

  let yes = 0;
  let firstYes = true;
  s.parts.forEach((p, i) => {
    if (p.up) rec.mark(pid(i), 'path');
    if (!p.up) {
      s.msgs = [{ to: i, back: false, text: 'no reply', tone: 'bad', dashed: true }];
      s.tally.cells[i] = `${p.name} —`;
      rec.line('phase_one', 'vote', 'silent');
      rec.step(`${p.name} does not answer: it is down. The coordinator waits until its timeout runs out, then counts the missing vote as a no.`, { probe: atPart(id, i) });
    } else if (refuse === i) {
      p.log.push({ kind: 'abort', txn: id });
      p.lock = null;
      p.state = 'aborted';
      write(rec, cost, false);
      send(rec, cost);
      s.msgs = [{ to: i, back: true, text: 'no', tone: 'bad' }];
      s.tally.cells[i] = `${p.name} no`;
      rec.markCell(lid(i), lastCell(p.log, PLOG_SHOWN), 'bad');
      rec.line('phase_one', 'vote', 'refuse');
      rec.step(
        `${p.name}'s check fails: say the write would take a balance below zero. It writes abort ${t} to its log, releases its lock at once and votes no. A participant that has not voted yes may abort on its own.`,
        { probe: atPart(id, i) },
      );
    } else {
      p.log.push({ kind: 'prepared', txn: id });
      p.state = 'prepared';
      write(rec, cost, true);
      send(rec, cost);
      yes++;
      s.msgs = [{ to: i, back: true, text: 'yes', tone: 'ok' }];
      s.tally.cells[i] = `${p.name} yes`;
      rec.markCell(lid(i), lastCell(p.log, PLOG_SHOWN), 'ok');
      rec.line('phase_one', 'vote', 'prepared');
      rec.step(
        firstYes
          ? `${p.name} forces prepared ${t} to its log, then votes yes. The vote is a promise: from now on ${p.name} may not abort ${t} on its own, and it keeps its lock until it hears the decision.`
          : `${p.name} does the same: prepared ${t} is on its disk before it votes yes. It is now bound to wait for the decision.`,
        { probe: atPart(id, i) },
      );
      firstYes = false;
    }
    rec.unmark(pid(i));
    rec.unmark(lid(i));
  });

  s.msgs = [];
  const decision: Decision = yes === n ? 'commit' : 'abort';
  for (let i = 0; i < n; i++) rec.markCell(TALLY, i, 'compare');
  rec.line('phase_one', 'count');
  rec.compare(`${t}: ${yes} yes`, yes === n ? '=' : '<', `${n} participants`, `decide ${decision}`, {
    probe: atCoord(id),
    message:
      yes === n
        ? `All ${n} participants voted yes, so the decision is commit. A single no, or a single silence, would have made it abort.`
        : `Only ${yes} of ${n} voted yes. One no or one silence is enough: the decision is abort.`,
  });
  rec.unmark(TALLY);
  return decision;
}

/** The coordinator writes its decision. That write is the commit point. */
function decide(s: TpcState, rec: Rec, id: number, decision: Decision, cost: Cost, lead: string[]): void {
  const t = label(id);
  s.phase = 'deciding';
  s.coord.log.push({ kind: decision, txn: id });
  write(rec, cost, true);
  rec.markCell(CLOG, lastCell(s.coord.log, CLOG_SHOWN), decision === 'commit' ? 'ok' : 'bad');
  rec.line(...lead, 'decide');
  rec.step(
    decision === 'commit'
      ? `The coordinator forces commit ${t} to its own log before it tells anyone. This write is the commit point: once it is on disk, ${t} will commit, whatever crashes next.`
      : `The coordinator writes abort ${t} to its log. Nobody can have committed ${t}, so aborting is safe.`,
    { probe: atNewest(s, id) },
  );
  rec.unmark(CLOG);
}

/** Phase 2. `via` is the line that called it. Returns the participants that did not get the decision. */
function phaseTwo(s: TpcState, rec: Rec, id: number, decision: Decision, cost: Cost, via: string): number[] {
  const t = label(id);
  const n = s.parts.length;
  const ok: Tone = decision === 'commit' ? 'ok' : 'bad';
  s.phase = 'phase 2';
  s.msgs = s.parts.map((p, i) => ({ to: i, back: false, text: decision, tone: ok, dashed: !p.up }));
  send(rec, cost, n);
  if (decision === 'commit') s.tally = { kind: 'acks', cells: new Array<string>(n).fill('') };
  rec.line(via, 'send');
  rec.step(`Phase 2. The coordinator sends ${decision} ${t} to ${everyone(s)}.`, { probe: atCoord(id) });

  const missing: number[] = [];
  let first = true;
  s.parts.forEach((p, i) => {
    if (p.up) rec.mark(pid(i), 'path');
    if (!p.up) {
      missing.push(i);
      s.msgs = [{ to: i, back: false, text: decision, tone: 'bad', dashed: true }];
      if (decision === 'commit') {
        s.tally.cells[i] = `${p.name} —`;
        rec.line(via, 'send', 'missing', 'down');
        rec.step(
          `${p.name} is down, so the commit does not reach it and no ack comes back. The coordinator may not forget ${t} until every participant has it, so it keeps ${t} open and will try ${p.name} again.`,
          { probe: atPart(id, i) },
        );
      } else {
        rec.line(via, 'send', 'down');
        rec.step(`${p.name} is down and does not hear the abort. That is fine: an abort needs no ack.`, { probe: atPart(id, i) });
      }
    } else {
      const already = p.log.some((e) => e.kind === decision && e.txn === id);
      const wasDoubt = p.state === 'prepared';
      if (!already) {
        p.log.push({ kind: decision, txn: id });
        write(rec, cost, decision === 'commit');
        rec.markCell(lid(i), lastCell(p.log, PLOG_SHOWN), ok);
      }
      p.lock = null;
      p.state = DONE[decision];
      if (decision === 'commit') {
        send(rec, cost);
        s.msgs = [{ to: i, back: true, text: 'ack', tone: 'ok' }];
        s.tally.cells[i] = `${p.name} ack`;
      } else s.msgs = [];
      rec.line(via, 'send', 'apply', 'release');
      const waited = wasDoubt && via === 'found' ? `${p.name} has been in doubt since the crash, holding its lock. ` : ``;
      rec.step(
        already
          ? `${p.name} voted no and has aborted already. Its log has abort ${t}, so it writes nothing new: a participant must handle the same message twice without harm.`
          : decision === 'commit'
            ? waited
              ? `${waited}It writes commit ${t}, releases the lock and acks.`
              : first
                ? `${p.name} writes commit ${t} to its log, makes its write visible and releases its lock. Then it sends an ack.`
                : `${p.name} does the same: commit ${t} on disk, lock released, ack sent.`
            : `${p.name} writes abort ${t}, undoes its write and releases its lock. No ack is sent for an abort.`,
        { probe: atPart(id, i) },
      );
      first = false;
    }
    rec.unmark(pid(i));
    rec.unmark(lid(i));
  });
  s.msgs = [];

  if (decision === 'abort') {
    rec.line(via, 'no_acks');
    rec.step(
      `An abort needs no acks and no end record. This is presumed abort: if anyone asks later about a transaction the coordinator holds no decision for, the answer is abort.`,
      { probe: atCoord(id) },
    );
  } else if (missing.length) {
    s.coord.waiting[id] = missing;
    rec.line(via, 'acks', 'missing');
    rec.step(
      `${n - missing.length} of ${n} acks are in. The coordinator keeps ${t} in memory and keeps resending commit to ${list(missing.map((i) => s.parts[i].name))} until it answers.`,
      { probe: atCoord(id) },
    );
  } else {
    s.coord.log.push({ kind: 'end', txn: id });
    write(rec, cost, false);
    rec.markCell(CLOG, lastCell(s.coord.log, CLOG_SHOWN), 'ok');
    rec.line(via, 'acks', 'end');
    rec.step(
      `Every participant has acked, so the coordinator writes end ${t} and can forget ${t}. This write need not be forced: if it is lost, the coordinator resends commit and collects the acks again.`,
      { probe: atNewest(s, id) },
    );
    rec.unmark(CLOG);
  }
  return missing;
}

/** A participant in doubt asks the coordinator, which is up, how a transaction ended. */
function askAndLearn(s: TpcState, rec: Rec, id: number, i: number, cost: Cost, lead: string[]): Decision {
  const t = label(id);
  const p = s.parts[i];
  const found = recorded(s, id);
  const decision: Decision = found ?? 'abort';
  s.msgs = [{ to: i, back: true, text: 'ask', tone: 'path' }];
  send(rec, cost);
  const at = s.coord.log.findIndex((e) => e.txn === id && e.kind !== 'end');
  const shownFrom = Math.max(0, s.coord.log.length - CLOG_SHOWN);
  const shown = at >= shownFrom;
  if (shown) rec.markCell(CLOG, at - shownFrom, 'compare');
  rec.mark(pid(i), 'path');
  rec.line(...lead, 'doubt', 'ask', 'lookup');
  rec.compare(`${t} in log`, '=', found ?? 'no record', found ? `answer ${found}` : 'presumed abort', {
    probe: shown ? { text: t, at: CLOG, cell: at - shownFrom } : atCoord(id),
    message: found
      ? `${p.name} asks the coordinator how ${t} ended. The coordinator finds ${found} ${t} in its log.`
      : `${p.name} asks how ${t} ended. The coordinator's log holds no decision for ${t}, so it never sent one and nobody can have committed: the answer is abort.`,
  });
  rec.unmark(CLOG);

  send(rec, cost);
  if (!p.log.some((e) => e.kind === decision && e.txn === id)) {
    p.log.push({ kind: decision, txn: id });
    write(rec, cost, decision === 'commit');
  }
  p.lock = null;
  p.state = DONE[decision];
  s.msgs = [{ to: i, back: false, text: decision, tone: decision === 'commit' ? 'ok' : 'bad' }];
  rec.markCell(lid(i), lastCell(p.log, PLOG_SHOWN), decision === 'commit' ? 'ok' : 'bad');
  rec.line(...lead, 'learn', found ? 'known' : 'presumed', 'apply', 'release');
  rec.step(
    decision === 'commit'
      ? `${p.name} hears commit. It writes commit ${t}, applies its write and releases its lock.`
      : `${p.name} hears abort. It writes abort ${t}, undoes its write and releases its lock.`,
    { probe: atPart(id, i) },
  );
  rec.unmark(lid(i));

  const waiting = s.coord.waiting[id];
  if (decision === 'commit' && waiting) {
    s.coord.waiting[id] = waiting.filter((j) => j !== i);
    send(rec, cost);
    s.msgs = [{ to: i, back: true, text: 'ack', tone: 'ok' }];
    s.tally.cells[i] = `${p.name} ack`;
    if (s.coord.waiting[id].length === 0) {
      delete s.coord.waiting[id];
      s.coord.log.push({ kind: 'end', txn: id });
      write(rec, cost, false);
      rec.markCell(CLOG, lastCell(s.coord.log, CLOG_SHOWN), 'ok');
      rec.line(...lead, 'learn', 'late_ack', 'late_end');
      rec.step(`${p.name} acks. That was the last ack the coordinator was waiting for, so it writes end ${t} and forgets ${t}.`, { probe: atNewest(s, id) });
      rec.unmark(CLOG);
    } else {
      rec.line(...lead, 'learn', 'late_ack');
      rec.step(`${p.name} acks. The coordinator still waits for ${plural(s.coord.waiting[id].length, 'more ack')}.`, { probe: atCoord(id) });
    }
  }
  rec.unmark(pid(i));
  s.msgs = [];
  return decision;
}

/** Refuse to start a transaction while one is stuck in doubt. Returns true when it refused. */
function blocked(s: TpcState, rec: Rec): boolean {
  if (s.coord.up) return false;
  const t = label(s.inDoubt ?? s.txn);
  const p = s.parts[0];
  rec.markCell(pid(0), LOCK_CELL, 'compare');
  rec.line('wait');
  rec.compare(`${p.name} lock`, '=', t, 'wait for the lock', {
    message: `Sorry, no new transaction can go through now. This page has one coordinator and it is down, and ${t} is in doubt: ${everyone(s)} still hold its locks. A new transaction that writes the same rows stops at its first lock, here, and waits for as long as the coordinator is down. Use Recover coordinator.`,
  });
  return true;
}

// ---- operations ---------------------------------------------------------------

export interface Result {
  txn: number;
  decision: Decision | null;
}

/** Run one transaction through both phases. `refuse` makes one participant vote no. */
function run(s: TpcState, rec: Rec, refuse: number | null, lead: string[]): Result {
  const cost: Cost = { messages: 0, writes: 0, forced: 0 };
  const id = begin(s, rec, lead);
  const decision = phaseOne(s, rec, id, cost, refuse);
  decide(s, rec, id, decision, cost, []);
  phaseTwo(s, rec, id, decision, cost, 'phase_two');
  finishTxn(s, decision);
  rec.line('done');
  rec.step(closing(s, id, decision, cost, refuse), { probe: atTxn(id) });
  return { txn: id, decision };
}

function finishTxn(s: TpcState, decision: Decision): void {
  s.phase = DONE[decision];
  if (decision === 'commit') s.committed++;
  else s.aborted++;
}

function closing(s: TpcState, id: number, decision: Decision, cost: Cost, refuse: number | null): string {
  const t = label(id);
  const costs = `${plural(cost.messages, 'message')} and ${plural(cost.writes, 'log write')}, ${cost.forced} of them forced to disk`;
  if (decision === 'commit') {
    return `${t} committed at ${everyone(s)}: all of them or none of them. It took 2 round trips, ${costs}, and every row stayed locked from the start until its participant heard commit.`;
  }
  const who = refuse !== null ? s.parts[refuse].name : '';
  return `${t} aborted everywhere: ${who ? `${who}'s no` : 'one missing vote'} outweighs any number of yeses. ${costs.charAt(0).toUpperCase() + costs.slice(1)}, and the others held their locks for a round trip for nothing.`;
}

export function commit(s: TpcState, rec: Rec): Result | null {
  if (blocked(s, rec)) return null;
  return run(s, rec, null, []);
}

export function voteNo(s: TpcState, who: number | string, rec: Rec): Result | null {
  const i = asParticipant(s, who);
  rec.line('arm');
  if (i === null) {
    rec.step(`There are participants ${everyone(s)} on this page. Enter ${either(s)} as the one to vote no.`);
    return null;
  }
  if (blocked(s, rec)) return null;
  rec.mark(pid(i), 'compare');
  rec.step(
    `${s.parts[i].name} will refuse the next transaction, ${label(s.txn + 1)}. When it is asked to prepare, a check will fail and it will vote no. Real causes: a constraint, a deadlock, a full disk, a timeout.`,
  );
  rec.unmark(pid(i));
  return run(s, rec, i, ['run']);
}

/** Run a transaction while one participant crashes before or after it votes, then restart it. */
export function crashParticipant(s: TpcState, who: number | string, when: number | string, rec: Rec): Result | null {
  const i = asParticipant(s, who);
  const w = String(when).trim().toLowerCase();
  rec.line('crash');
  if (i === null) {
    rec.step(`There are participants ${everyone(s)} on this page. Enter ${either(s)} as the one to crash.`);
    return null;
  }
  if (w !== 'before' && w !== 'after') {
    rec.step(`Enter before or after: does ${s.parts[i].name} crash before it votes, or just after it votes yes?`);
    return null;
  }
  if (blocked(s, rec)) return null;
  const after = w === 'after';
  const cost: Cost = { messages: 0, writes: 0, forced: 0 };
  const p = s.parts[i];
  const id = begin(s, rec, []);
  const t = label(id);

  if (!after) {
    p.up = false;
    p.lock = null;
    rec.line('crash');
    rec.step(
      `${p.name} crashes before the prepare reaches it. Its lock and its half-done write were only in memory, so they are gone, and its log holds nothing about ${t}.`,
      { probe: atPart(id, i) },
    );
  }
  const decision = phaseOne(s, rec, id, cost, null);
  if (after) {
    p.up = false;
    p.lock = null;
    rec.line('crash');
    rec.step(
      `${p.name} crashes just after its yes vote leaves. Its lock goes with its memory, but prepared ${t} is safe in its log. The coordinator has the vote and does not know ${p.name} is down.`,
      { probe: atPart(id, i) },
    );
  }
  decide(s, rec, id, decision, cost, []);
  phaseTwo(s, rec, id, decision, cost, 'phase_two');

  // The victim comes back and rebuilds from its log.
  p.up = true;
  rec.mark(pid(i), 'path');
  rec.line('restart_victim', 'restart');
  rec.step(`${p.name} restarts. Its memory starts empty, so it rebuilds what it knows from its log.`, { probe: atPart(id, i) });
  const doubt = inDoubt(p).includes(id);
  if (doubt) rec.markCell(lid(i), lastCell(p.log, PLOG_SHOWN), 'compare');
  rec.line('restart_victim', 'scan');
  rec.compare(`${p.name} log: ${t}`, '=', doubt ? 'prepared' : 'no record', doubt ? 'in doubt: relock and ask' : 'never voted: roll back', {
    probe: atPart(id, i),
    message: doubt
      ? `${p.name}'s log has prepared ${t} and no decision after it. ${p.name} promised to commit if told to, so it is in doubt: it may neither commit nor abort on its own.`
      : `${p.name}'s log has nothing about ${t}: it never voted. It is free to abort on its own, and that agrees with what the coordinator decided.`,
  });
  rec.unmark(lid(i));
  if (!doubt) {
    p.state = 'aborted';
    rec.line('restart_victim', 'undo');
    rec.step(`${p.name} rolls back its part of ${t}. Every participant now agrees: ${t} aborted.`, { probe: atPart(id, i) });
  } else {
    p.lock = id;
    p.state = 'prepared';
    rec.markCell(pid(i), LOCK_CELL, 'ok');
    rec.line('restart_victim', 'relock');
    rec.step(
      `${p.name} takes the lock on its row again before anything else runs. The prepared record has to hold enough to do that, or another transaction could change the row while ${t} is undecided.`,
      { probe: atPart(id, i) },
    );
    rec.unmark(pid(i));
    askAndLearn(s, rec, id, i, cost, ['restart_victim', 'resolve']);
  }
  rec.unmark(pid(i));
  finishTxn(s, decision);
  rec.line('done');
  rec.step(
    decision === 'commit'
      ? `${t} committed at ${everyone(s)}, ${p.name} last of all. A participant that voted yes and crashed must ask on recovery: its own log cannot tell it the answer. ${plural(cost.messages, 'message')}, ${plural(cost.writes, 'log write')}.`
      : `${t} aborted at ${everyone(s)}. A participant that fails before it votes costs only a timeout: nobody waited on it after that. ${plural(cost.messages, 'message')}, ${plural(cost.writes, 'log write')}.`,
    { probe: atTxn(id) },
  );
  return { txn: id, decision };
}

/** Run a transaction's phase 1, then crash the coordinator before it sends the decision. */
export function crashCoordinator(s: TpcState, when: number | string, rec: Rec): Result | null {
  const w = String(when).trim().toLowerCase();
  rec.line('logged');
  if (w !== 'before' && w !== 'after') {
    rec.step(`Enter before or after: does the coordinator crash before or after it writes its decision to its log?`);
    return null;
  }
  if (blocked(s, rec)) return null;
  const logged = w === 'after';
  const cost: Cost = { messages: 0, writes: 0, forced: 0 };
  const id = begin(s, rec, []);
  const t = label(id);
  const decision = phaseOne(s, rec, id, cost, null);
  if (logged) decide(s, rec, id, decision, cost, ['logged']);

  s.coord.up = false;
  s.coord.waiting = {};
  s.tally = { kind: s.tally.kind, cells: new Array<string>(s.parts.length).fill('') };
  s.inDoubt = id;
  s.phase = 'in doubt';
  rec.line('logged', 'crash');
  rec.step(
    logged
      ? `Then the coordinator crashes, before a single ${decision} message leaves. Its memory, with the votes, is gone. Its log survives, and it says ${decision} ${t}.`
      : `The coordinator crashes before it writes any decision. Its memory, with the votes, is gone, and its log has nothing about ${t}.`,
    { probe: atTxn(id) },
  );

  const waiting = s.parts.map((_p, i) => i).filter((i) => inDoubt(s.parts[i]).includes(id));
  s.msgs = waiting.map((i) => ({ to: i, back: true, text: 'ask', tone: 'bad' as Tone, dashed: true }));
  send(rec, cost, waiting.length);
  rec.line('wait_out', 'doubt', 'ask', 'no_answer');
  rec.step(
    `${everyone(s)} each wait for the decision, time out and ask the coordinator about ${t}. Nobody answers.`,
    { probe: atPart(id, 0) },
  );
  s.msgs = [];
  const a = s.parts[0].name;
  rec.line('wait_out', 'block');
  rec.step(
    `Can ${a} decide alone? It voted yes, so it may not abort: the coordinator may have decided commit. It may not commit either: it cannot know that the others voted yes. Asking the others does not help, because they are prepared and in doubt too.`,
    { probe: atPart(id, 0) },
  );
  rec.step(
    `So ${everyone(s)} wait, holding their locks on ${t}'s rows, for as long as the coordinator is down. Any other transaction that needs those rows waits behind them. This is why two-phase commit is called a blocking protocol.` +
      (logged ? ` Recovery will find commit ${t} in the log.` : ` From where they sit, a logged decision and no decision at all look exactly the same.`),
    { probe: atTxn(id) },
  );
  return { txn: id, decision: null };
}

/** Restart the coordinator: replay its log, finish a logged commit, and answer anyone still in doubt. */
export function recoverCoordinator(s: TpcState, rec: Rec): Result | null {
  if (s.coord.up) {
    rec.line('running');
    rec.step(`The coordinator is running, so there is nothing to recover. Use Crash coordinator first.`);
    return null;
  }
  const id = s.inDoubt!;
  const t = label(id);
  const cost: Cost = { messages: 0, writes: 0, forced: 0 };
  s.coord.up = true;
  rec.mark(TXN, 'key');
  rec.line('reboot');
  rec.step(`The coordinator restarts. Its memory is empty: it knows only what its log says.`, { probe: atCoord(id) });

  const found = s.coord.log.some((e) => e.kind === 'commit' && e.txn === id) && !s.coord.log.some((e) => e.kind === 'end' && e.txn === id);
  if (found) rec.markCell(CLOG, lastCell(s.coord.log, CLOG_SHOWN), 'compare');
  rec.line('replay', 'found');
  rec.compare(`${t} in log`, '=', found ? 'commit, no end' : 'no record', found ? 'send commit again' : 'nothing to resend', {
    probe: found ? atNewest(s, id) : atCoord(id),
    message: found
      ? `It reads its log from the start, looking for a commit with no end record after it. It finds commit ${t}: decided, but nobody was told.`
      : `It reads its log from the start, looking for a commit with no end record after it. There is nothing about ${t}: it was never decided, so it cannot have committed anywhere.`,
  });
  rec.unmark(CLOG);

  let decision: Decision;
  if (found) {
    decision = 'commit';
    phaseTwo(s, rec, id, 'commit', cost, 'found');
  } else {
    decision = 'abort';
    s.parts.forEach((p, i) => {
      if (inDoubt(p).includes(id)) askAndLearn(s, rec, id, i, cost, ['asked']);
    });
  }
  s.inDoubt = null;
  finishTxn(s, decision);
  rec.line(found ? 'found' : 'asked');
  rec.step(
    found
      ? `${t} committed at ${everyone(s)}, one crash later. Nothing was lost and nobody disagreed, but every row stayed locked for the whole outage. Two-phase commit is safe, and it can block.`
      : `${t} aborted at ${everyone(s)}. With no decision in the log, presumed abort is always safe. The rows stayed locked for the whole outage all the same.`,
    { probe: atTxn(id) },
  );
  return { txn: id, decision };
}

// ---- layout -------------------------------------------------------------------

const TXN_W = 56;
const TALLY_W = 72;
const COORD_W = 131;
const CLOG_W = 118;
const NAME_W = 44;
const STATE_W = 112;
const LOCK_W = 100;
const PLOG_W = 134;
const GAP = 3;
/** Right edge of the scene: the coordinator's log and the last participant's log end here. */
const RIGHT = 880;
const COORD_X = 420;
const COORD_Y = 0;
const PART_Y = 180;
const PLOG_Y = PART_Y + (CELL_H / 2 + TRAY_PAD) * 2 + LABEL_MAX + 22;
const PITCH = 300;
const COLUMN0 = 140;
const LEFT = -36;
const TOP = COORD_Y - CELL_H / 2 - PROBE_H - 16;
const BOTTOM = PLOG_Y + CELL_H / 2 + TRAY_PAD;

const multiW = (count: number, w: number) => TRAY_PAD * 2 + count * w + (count - 1) * GAP;

export function columnX(n: number, i: number): number {
  const span = (n - 1) * PITCH;
  const mid = COLUMN0 + PITCH;
  return mid - span / 2 + i * PITCH;
}

const toneOf = (cell: string): Tone | undefined => (/(yes|ack)$/.test(cell) ? 'ok' : /(no|—)$/.test(cell) ? 'bad' : undefined);
const record = (e: Entry) => `${e.kind} ${label(e.txn)}`;

function logCells(log: Entry[], shown: number, w: number) {
  const tail = log.slice(-shown);
  return Array.from({ length: shown }, (_, i) => ({ text: i < tail.length ? record(tail[i]) : '', w }));
}

export function layout(s: TpcState): Scene {
  const n = s.parts.length;
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  // The coordinator's row: the transaction, the tally of replies, the coordinator, its log.
  const clogW = multiW(CLOG_SHOWN, CLOG_W);
  const tallyW = multiW(n, TALLY_W);
  const coordLeft = COORD_X - COORD_W / 2;
  const tallyRight = coordLeft - 26;
  nodes.push({
    id: TXN,
    x: TXN_W / 2,
    y: COORD_Y,
    cells: [{ text: s.txn ? label(s.txn) : '', w: TXN_W }],
    caption: s.txn ? `transaction,\n${s.phase}` : 'no transaction\nyet',
  });
  nodes.push({
    id: TALLY,
    x: tallyRight - tallyW / 2,
    y: COORD_Y,
    cells: s.tally.cells.map((c) => ({ text: c, w: TALLY_W, tone: toneOf(c) })),
    title: s.coord.up ? `${s.tally.kind}, in memory` : 'lost in the crash',
  });
  nodes.push({
    id: COORD,
    x: COORD_X,
    y: COORD_Y,
    cells: [{ text: 'Coordinator', w: COORD_W }],
    tone: s.coord.up ? undefined : 'bad',
    title: s.coord.up ? undefined : 'crashed',
  });
  nodes.push({ id: CLOG, x: RIGHT - clogW / 2, y: COORD_Y, cells: logCells(s.coord.log, CLOG_SHOWN, CLOG_W), title: 'coordinator log, on disk' });

  // One column per participant: name, state and lock, then its log.
  s.parts.forEach((p, i) => {
    const x = columnX(n, i);
    const state = p.up ? p.state : 'down';
    nodes.push({
      id: pid(i),
      x,
      y: PART_Y,
      tone: p.up ? undefined : 'bad',
      cells: [
        { text: p.name, w: NAME_W },
        { text: state, w: STATE_W, tone: state === 'committed' ? 'ok' : state === 'aborted' || state === 'down' ? 'bad' : undefined },
        { text: p.lock !== null ? `lock ${label(p.lock)}` : '', w: LOCK_W },
      ],
    });
    nodes.push({ id: lid(i), x, y: PLOG_Y, cells: logCells(p.log, PLOG_SHOWN, PLOG_W), title: `${p.name}'s log, on disk` });
  });

  for (const m of s.msgs) {
    const p = pid(m.to);
    edges.push({
      id: `m${m.to}${m.back ? 'u' : 'd'}`,
      from: m.back ? p : COORD,
      to: m.back ? COORD : p,
      kind: 'line',
      arrow: true,
      label: m.text,
      tone: m.tone,
      dashed: m.dashed,
    });
  }

  // Two empty labels pin the corners, so the scene keeps its size whatever happens.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------

const WHO = { name: 'participant', label: 'Participant (a, b or c)', kind: 'word' } as const;

function suggestWho(s: TpcState): string {
  return s.parts[randomInt(0, s.parts.length - 1)].name.toLowerCase();
}

const def: StructureDef<TpcState> = {
  id: 'two-phase-commit',
  params: [
    {
      id: 'participants',
      label: 'Participants',
      default: 3,
      options: [2, 3].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  create: (params) => create(params.participants ?? 3),
  // One committed transaction, so the logs already show what a finished one leaves behind.
  seed: [['commit']],
  ops: [
    {
      id: 'commit',
      label: 'Commit',
      intent: 'primary',
      args: [],
      code: ['commit', 'phase_one', 'prepare', 'phase_two', 'finish', 'begin'],
      run: (s, _args, rec) => void commit(s, rec),
    },
    {
      id: 'vote_no',
      label: 'Vote no',
      args: [WHO],
      code: ['vote_no', 'commit', 'phase_one', 'prepare', 'phase_two', 'finish', 'begin'],
      run: (s, [who], rec) => void voteNo(s, who, rec),
      suggest: (s) => [suggestWho(s)],
    },
    {
      id: 'crash_participant',
      label: 'Crash participant',
      intent: 'danger',
      args: [WHO, { name: 'when', label: 'When (before or after its vote)', kind: 'word' }],
      code: ['crash_participant', 'phase_one', 'prepare', 'phase_two', 'finish', 'restart', 'resolve', 'ask', 'ack', 'begin'],
      run: (s, [who, when], rec) => void crashParticipant(s, who, when, rec),
      suggest: (s) => [suggestWho(s), randomInt(0, 1) ? 'after' : 'before'],
    },
    {
      id: 'crash_coordinator',
      label: 'Crash coordinator',
      intent: 'danger',
      args: [{ name: 'when', label: 'When (before or after logging)', kind: 'word' }],
      code: ['crash_coordinator', 'phase_one', 'prepare', 'resolve', 'ask', 'begin'],
      run: (s, [when], rec) => void crashCoordinator(s, when, rec),
      suggest: () => [randomInt(0, 3) ? 'after' : 'before'],
    },
    {
      id: 'recover_coordinator',
      label: 'Recover coordinator',
      args: [],
      code: ['recover', 'phase_two', 'finish', 'resolve', 'ask', 'ack'],
      run: (s, _args, rec) => void recoverCoordinator(s, rec),
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'messages', label: 'Messages' },
    { key: 'writes', label: 'Log writes' },
  ],
  status: (s) => [
    { label: 'Coordinator', value: s.coord.up ? 'up' : 'down' },
    { label: 'In doubt', value: s.inDoubt ? `${label(s.inDoubt)} at ${everyone(s)}` : 'nothing' },
    { label: 'Locks held', value: String(s.parts.filter((p) => p.lock !== null).length) },
    { label: 'Committed, aborted', value: `${s.committed}, ${s.aborted}` },
  ],
  tour: [['commit'], ['vote_no', 'b'], ['crash_coordinator', 'after'], ['recover_coordinator'], ['crash_participant', 'b', 'after']],
  source: { python, java },
  info,
};

export default def;
