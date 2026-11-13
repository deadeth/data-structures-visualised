import { LABEL_MAX, SUB_ROOM } from '../../core/fit';
import { CELL_H, TAG_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone, VarValue } from '../../core/types';
import java from './code/StreamCheckpoints.java?raw';
import python from './code/stream_checkpoints.py?raw';
import { info } from './info';

/**
 * A small Flink job: two sources, each reading one Kafka partition by offset,
 * feed a keyed counter. The counter sends every new count to three sinks that
 * differ only in how they cope with a replay: one appends, one upserts by key,
 * one writes inside a transaction that commits with the checkpoint.
 *
 * Operations are atomic here: a record is carried all the way to the sinks in
 * one operation, and a checkpoint runs from trigger to completion in one. So
 * a crash never lands in the middle of either; the notes say what changes
 * when it does.
 */

/** The keys the logs hold. Count draws one cell per key, in this order. */
export const KEYS = [7, 13, 42] as const;
/** The partitions repeat these keys for ever, so the sources never run dry. */
export const LOGS: readonly (readonly number[])[] = [
  [7, 42, 7, 13, 7, 42],
  [42, 13, 42, 7, 13],
];
export const SOURCES = LOGS.length;
/** Tasks that ack a checkpoint: two sources, Count and three sinks. */
export const SINKS = 3;
export const TASKS = SOURCES + 1 + SINKS;

export const keyAt = (p: number, offset: number) => LOGS[p][offset % LOGS[p].length];
const ki = (key: number) => KEYS.indexOf(key as (typeof KEYS)[number]);

export interface Result {
  key: number;
  n: number;
  /** The log sink already had this exact result: it is a duplicate. */
  dup?: boolean;
}

export interface Snapshot {
  id: number;
  /** Where each source resumes. */
  offsets: number[];
  /** Count's keyed state at the barrier, one entry per key in KEYS. */
  counts: number[];
  /** The two-phase sink's transaction pre-committed with this checkpoint, if any. */
  txn: number | null;
  acks: number;
}

export interface JobState {
  running: boolean;
  /** Next offset per source. In memory: lost in a crash. */
  offsets: number[];
  /** Count's keyed state, one per key in KEYS. In memory: lost in a crash. */
  counts: number[];
  /** At-least-once sink: every result, appended. */
  appended: Result[];
  /** Idempotent sink: the latest count per key, or null before any write. */
  table: (number | null)[];
  /** Two-phase sink: the open transaction, hidden from readers. */
  txnId: number;
  txn: Result[];
  /** Two-phase sink: pre-committed with a checkpoint that has not completed yet. */
  pre: { id: number; items: Result[] } | null;
  /** Two-phase sink: what readers can see. */
  committed: Result[];
  /** The last completed checkpoint. Checkpoint 0 is the start of the job. */
  done: Snapshot;
  /** A checkpoint in progress (only while the checkpoint operation runs). */
  pending: Snapshot | null;
  nextId: number;
  /** Count has the barrier from S0 but not from S1: it holds channel 0. */
  aligning: boolean;
  /** The record Count holds in its channel 0 buffer while aligning. */
  held: { key: number; offset: number } | null;
  // The page's own notes, not part of the job:
  /** Furthest offset each source has ever read, so a replay can be told apart. */
  reached: number[];
  /** Records counted since the last completed checkpoint, in order: what a recovery replays. */
  history: { p: number; offset: number }[];
  /** Count's state just before the last crash, to compare with after the replay. */
  before: number[] | null;
}

export function create(): JobState {
  return {
    running: true,
    offsets: new Array<number>(SOURCES).fill(0),
    counts: KEYS.map(() => 0),
    appended: [],
    table: KEYS.map(() => null),
    txnId: 1,
    txn: [],
    pre: null,
    committed: [],
    done: { id: 0, offsets: new Array<number>(SOURCES).fill(0), counts: KEYS.map(() => 0), txn: null, acks: TASKS },
    pending: null,
    nextId: 1,
    aligning: false,
    held: null,
    reached: new Array<number>(SOURCES).fill(0),
    history: [],
    before: null,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const fmtCounts = (counts: number[]) => KEYS.map((k, i) => `${k}: ${counts[i]}`).join(', ');
const fmtResults = (rs: Result[]) => {
  const t = rs.map((r) => `${r.key}=${r.n}`);
  return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
};
/** Keyed state as the listing's dict holds it: only keys counted so far. */
const dict = (counts: number[]) => `{${KEYS.flatMap((k, i) => (counts[i] ? [`${k}: ${counts[i]}`] : [])).join(', ')}}`;
const tuples = (rs: Result[]) => rs.map((r) => `(${r.key}, ${r.n})`);
const validSource = (p: number) => Number.isInteger(p) && p >= 0 && p < SOURCES;

// ---- ids ----------------------------------------------------------------------

const oid = (p: number, offset: number) => `p${p}o${offset}`;
const sid = (p: number) => `s${p}`;
const eid = (p: number) => `e${p}`;
const COUNT = 'count';
const HELD = 'held';
const ALO = 'alo';
const IDEM = 'idem';
const TXN = 'txn';
const COM = 'com';
const DONE = 'done';
const PENDING = 'pending';
const SINK_EDGES = ['ea', 'ei', 'et'];

// ---- the moving parts -----------------------------------------------------------

/** Last few entries a sink row can show. */
export const ALO_SHOWN = 5;
export const TXN_SHOWN = 3;
export const COM_SHOWN = 5;
const lastIndex = (length: number, shown: number) => Math.min(length, shown) - 1;

/**
 * Count takes one record and hands the new count to the three sinks: two
 * frames, the second followed at the log sink, where a duplicate shows.
 */
function countAndWrite(s: JobState, key: number, rec: Rec, call: string): number {
  const i = ki(key);
  const old = s.counts[i];
  const n = old + 1;
  s.counts[i] = n;
  rec.vars({ key, n });
  rec.markCell(COUNT, i, 'ok');
  rec.line(call, 'count');
  rec.step(
    `Count adds one for key ${key}: ${old} → ${n}. The count is Count's keyed state. It lives in this task's memory, which is fast, and why a crash loses it.`,
    { probe: { text: String(key), at: COUNT, cell: i } },
  );
  rec.markCell(COUNT, i, 'idle');

  const dup = s.appended.some((r) => r.key === key && r.n === n);
  const prev = s.table[i];
  s.appended.push({ key, n, dup });
  s.table[i] = n;
  s.txn.push({ key, n });
  if (dup) rec.count('duplicates');
  if (!dup) rec.markCell(ALO, lastIndex(s.appended.length, ALO_SHOWN), 'ok');
  rec.markCell(IDEM, i, prev === n ? 'compare' : 'ok');
  rec.markCell(TXN, lastIndex(s.txn.length, TXN_SHOWN), 'ok');
  for (const e of SINK_EDGES) rec.markEdge(e, 'path');
  rec.line(call, 'sink');
  const table =
    prev === n
      ? `The table already says ${key}=${n}, so writing it again changes nothing.`
      : prev !== null && prev > n
        ? `The table goes back from ${key}=${prev} to ${key}=${n} for now: a reader during the replay can see an old value.`
        : `The table sets ${key} to ${n}.`;
  rec.step(
    (dup
      ? `Count sends ${key}=${n} to the three sinks. The log sink appends it a second time, in red: this is the duplicate that at-least-once allows. `
      : `Count sends ${key}=${n} to the three sinks. The log sink appends it. `) +
      `${table} The two-phase sink adds it to transaction ${s.txnId}, which readers cannot see until a checkpoint commits it.`,
    { probe: { text: String(key), at: ALO, cell: lastIndex(s.appended.length, ALO_SHOWN), place: 'left' } },
  );
  rec.markCell(ALO, lastIndex(s.appended.length, ALO_SHOWN), 'idle');
  rec.markCell(IDEM, i, 'idle');
  rec.markCell(TXN, lastIndex(s.txn.length, TXN_SHOWN), 'idle');
  rec.clearMarks();
  return n;
}

/** A source reads its next record and carries it through Count to the sinks, one hop a frame. */
function carry(s: JobState, p: number, rec: Rec, replay: boolean): number {
  const offset = s.offsets[p];
  const key = keyAt(p, offset);
  const probe: Probe = { text: String(key), at: oid(p, offset) };
  s.offsets[p] = offset + 1;
  rec.count('reads');
  if (replay) rec.count('replayed');
  else {
    s.history.push({ p, offset });
    s.reached[p] = Math.max(s.reached[p], offset + 1);
  }
  rec.vars({ p, 'offsets[p]': offset + 1, key });
  rec.mark(oid(p, offset), 'key');
  rec.line('read');
  rec.step(
    replay
      ? `Replay: S${p} reads offset ${offset} of P${p} again: key ${key}. The job read it before the crash, but its count was lost, so it must be counted again.`
      : `S${p} reads offset ${offset} of partition P${p}: key ${key}, and moves its offset to ${offset + 1}. Reading takes nothing out of Kafka, so the record can be read again later.`,
    { probe },
  );
  rec.mark(oid(p, offset), 'path');

  rec.markEdge(eid(p), 'path');
  rec.line('emit');
  rec.step(
    `S${p} sends ${key} to Count, one hop along its channel. In Flink, keyBy routes every record with the same key to the same Count task, so one task owns the count for ${key}.`,
    { probe: { text: String(key), at: COUNT, cell: ki(key) } },
  );
  rec.clearMarks();
  rec.mark(oid(p, offset), 'path');
  const n = countAndWrite(s, key, rec, 'emit');
  rec.vars({ p, 'offsets[p]': offset + 1, key, 'count(key)': n });
  rec.unmark(oid(p, offset));
  return n;
}

// ---- operations -----------------------------------------------------------------

/** Read one record from partition p and carry it to the sinks. Returns the new count, or null. */
export function process(s: JobState, partition: number | string, rec: Rec): number | null {
  const p = Number(partition);
  rec.vars({ p: partition, running: s.running });
  rec.line('down');
  if (!validSource(p)) {
    rec.step(`This job reads partitions 0 and 1. There is no partition ${partition}.`);
    return null;
  }
  if (!s.running) {
    rec.step(`The job is down after the crash, so nothing is read. Press Recover to restart it from the last completed checkpoint.`);
    return null;
  }
  const n = carry(s, p, rec, false);
  const key = keyAt(p, s.offsets[p] - 1);
  rec.line('emit');
  rec.step(
    `Done: 1 read, 1 state update, 3 sink writes. Count holds ${fmtCounts(s.counts)}. If the job failed now it would restart from checkpoint ${s.done.id} and count ${key} again.`,
    { probe: { text: String(key), at: COUNT, cell: ki(key) } },
  );
  return n;
}

/** Take a checkpoint with barriers. Returns its id, or null when the job is down. */
export function checkpoint(s: JobState, rec: Rec): number | null {
  rec.vars({ running: s.running });
  rec.line('down');
  if (!s.running) {
    rec.step(`The job is down, so no checkpoint can be taken. Press Recover first.`);
    return null;
  }
  const id = s.nextId++;
  const b = `B${id}`;
  const chk: Snapshot = { id, offsets: new Array<number>(SOURCES).fill(0), counts: [], txn: null, acks: 0 };
  s.pending = chk;
  rec.vars({ 'chk.cid': id, next_id: s.nextId, 'chk.acks': 0 });
  rec.line('trigger');
  rec.step(
    `The checkpoint coordinator, in Flink's JobManager, starts checkpoint ${id}. It asks each source to put barrier ${b} into its stream. A barrier is a marker that travels with the records and splits them into before and after.`,
  );

  for (let p = 0; p < SOURCES; p++) {
    chk.offsets[p] = s.offsets[p];
    chk.acks++;
    rec.markCell(PENDING, p, 'ok');
    rec.vars({ 'chk.cid': id, next_id: s.nextId, 'chk.acks': chk.acks, p, 'chk.offsets': [...chk.offsets] });
    rec.line('inject');
    rec.step(
      `S${p} is about to read offset ${s.offsets[p]}. It saves "S${p}: ${s.offsets[p]}" to checkpoint storage, acks, and sends ${b} downstream behind every record it has already sent. ${chk.acks} of ${TASKS} tasks have acked.`,
      { probe: { text: b, at: sid(p) } },
    );
    rec.markCell(PENDING, p, 'idle');
  }

  const atCount: Probe = { text: b, at: COUNT, cell: 1 };
  s.aligning = true;
  let seen = 1;
  const base = (extra: Record<string, VarValue> = {}) => ({ 'chk.cid': id, 'chk.acks': chk.acks, seen, ...extra });
  rec.vars(base());
  rec.markEdge(eid(0), 'path');
  rec.line('first');
  rec.step(
    `${b} from S0 reaches Count first. Count reads two channels and has not had ${b} from S1 yet. It stops taking records from channel 0: they come after the barrier, and counting them now would put them in checkpoint ${id} by mistake.`,
    { probe: atCount },
  );
  rec.clearMarks();

  const offset = s.offsets[0];
  const key = keyAt(0, offset);
  s.offsets[0] = offset + 1;
  s.reached[0] = Math.max(s.reached[0], offset + 1);
  s.held = { key, offset };
  rec.count('reads');
  rec.vars(base({ held: key, 'offsets[0]': offset + 1 }));
  rec.mark(oid(0, offset), 'path');
  rec.line('hold');
  rec.step(
    `Sources do not stop for a checkpoint. S0 reads offset ${offset}, key ${key}, and sends it. It arrives behind ${b}, so Count puts it in a buffer instead of counting it. This wait is called barrier alignment.`,
    { probe: atCount },
  );
  rec.unmark(oid(0, offset));

  seen++;
  rec.vars(base({ held: key, 'offsets[0]': offset + 1 }));
  rec.markEdge(eid(1), 'path');
  rec.line('align');
  rec.compare(`${b} seen 2`, '=', 'inputs 2', 'aligned: take the snapshot', {
    probe: atCount,
    message: `${b} arrives from S1 too. Count has now counted every record before the barrier on both channels, and none after it.`,
  });
  rec.clearMarks();

  chk.counts = [...s.counts];
  chk.acks++;
  rec.vars(base({ held: key, 'chk.counts': dict(chk.counts) }));
  KEYS.forEach((_k, i) => rec.markCell(PENDING, SOURCES + i, 'ok'));
  rec.line('snapshot');
  rec.step(
    `Count saves its keyed state to checkpoint storage: ${fmtCounts(chk.counts)}. Flink copies it quickly and uploads it in the background, so Count is not held up for long. Count acks and sends ${b} on to the sinks. ${chk.acks} of ${TASKS} acked.`,
    { probe: atCount },
  );
  KEYS.forEach((_k, i) => rec.markCell(PENDING, SOURCES + i, 'idle'));

  s.pre = { id: s.txnId, items: s.txn };
  chk.txn = s.txnId;
  s.txn = [];
  s.txnId++;
  chk.acks += SINKS;
  rec.vars({ 'chk.cid': id, 'chk.acks': chk.acks, held: key, 'chk.txn': tuples(s.pre.items) });
  rec.markCell(PENDING, SOURCES + KEYS.length, 'ok');
  for (const e of SINK_EDGES) rec.markEdge(e, 'path');
  rec.line('precommit');
  rec.step(
    `${b} reaches the three sinks. The log sink and the table have nothing to save. The two-phase sink pre-commits transaction ${s.pre.id}` +
      (s.pre.items.length ? `: ${fmtResults(s.pre.items)} are flushed but stay hidden.` : `, which is empty.`) +
      ` It notes "txn ${s.pre.id}" in the checkpoint and opens transaction ${s.txnId} for what comes next. ${chk.acks} of ${TASKS} acked.`,
    { probe: { text: b, at: TXN, cell: 0, place: 'left' } },
  );
  rec.markCell(PENDING, SOURCES + KEYS.length, 'idle');
  rec.clearMarks();

  rec.vars(base({ held: key }));
  rec.line('release');
  rec.step(
    `Count no longer needs to hold channel 0, so it takes the buffered record, key ${key}. It is counted after the snapshot, so it belongs to checkpoint ${id + 1}.`,
    { probe: { text: String(key), at: HELD } },
  );
  s.aligning = false;
  s.held = null;
  s.history.push({ p: 0, offset });
  countAndWrite(s, key, rec, 'release');

  rec.vars(base({ tasks: TASKS }));
  rec.line('complete');
  rec.compare(`${b} acks ${chk.acks}`, '=', `tasks ${TASKS}`, `checkpoint ${id} is complete`, {
    probe: { text: b, at: PENDING, cell: 0 },
    message: `The coordinator counts the acks for checkpoint ${id}: all ${TASKS} tasks have stored their part, so the checkpoint is complete.`,
  });
  const old = s.done.id;
  s.done = chk;
  s.pending = null;
  s.history = s.history.filter((h) => h.offset >= chk.offsets[h.p]);
  rec.count('checkpoints');
  rec.vars(base({ tasks: TASKS, 'done.cid': chk.id }));
  rec.mark(DONE, 'ok');
  rec.step(
    `Checkpoint ${id} replaces checkpoint ${old} as the one to restart from: ${chk.offsets.map((o, p) => `S${p} at offset ${o}`).join(', ')}, with ${fmtCounts(chk.counts)}.`,
    { probe: { text: b, at: DONE, cell: 0 } },
  );
  rec.unmark(DONE);

  const pre = s.pre!;
  s.committed.push(...pre.items);
  s.pre = null;
  const shown = Math.min(pre.items.length, COM_SHOWN);
  for (let i = 0; i < shown; i++) rec.markCell(COM, lastIndex(s.committed.length, COM_SHOWN) - i, 'ok');
  rec.vars({ 'chk.cid': id, 'chk.acks': chk.acks, 'done.cid': chk.id, 'chk.txn': tuples(pre.items) });
  rec.line('commit');
  rec.step(
    `The coordinator tells every task that checkpoint ${id} is complete. Only now does the two-phase sink commit transaction ${pre.id}` +
      (pre.items.length ? `: ${fmtResults(pre.items)} become visible to readers.` : `. It was empty, so readers see nothing new.`),
    { probe: { text: b, at: COM, cell: 0, place: 'left' } },
  );
  for (let i = 0; i < shown; i++) rec.markCell(COM, lastIndex(s.committed.length, COM_SHOWN) - i, 'idle');

  rec.vars({ 'chk.cid': id });
  rec.line('finish');
  rec.step(
    `Checkpoint ${id} done: ${TASKS} acks, one barrier per source, and no stop to the stream apart from a short wait on channel 0. A crash from now on loses at most the work since ${b}.`,
  );
  return id;
}

/** A task fails. Every task restarts, so all in-memory state is gone. */
export function crash(s: JobState, rec: Rec): boolean {
  rec.vars({ running: s.running });
  rec.line('lost');
  if (!s.running) {
    rec.step(`The job is already down. Press Recover to restart it.`);
    return false;
  }
  s.before = [...s.counts];
  s.running = false;
  rec.vars({ running: false, offsets: null, counts: null });
  rec.mark(COUNT, 'bad');
  rec.step(
    `The Count task fails: say its machine dies. Its keyed state lived in that task's memory, so the counts ${fmtCounts(s.before)} are gone.`,
  );
  for (let p = 0; p < SOURCES; p++) rec.mark(sid(p), 'bad');
  const since = s.history.length;
  rec.step(
    `Flink cancels the other tasks too, because they all exchange records with Count. The sources lose their offsets. The sinks keep what they already wrote to the outside world, including open transaction ${s.txnId} with ${plural(s.txn.length, 'result')}.`,
  );
  rec.step(
    `The job is down. The last completed checkpoint is ${s.done.id}. The job has counted ${plural(since, 'record')} since then that a restart will have to count again.`,
  );
  rec.clearMarks();
  return true;
}

/** Restart from the last completed checkpoint and replay. Returns how many records were replayed. */
export function recover(s: JobState, rec: Rec): number {
  rec.vars({ running: s.running });
  rec.line('up');
  if (s.running) {
    rec.step(`Nothing has failed: the job is running. Press Crash first to see a recovery.`);
    return 0;
  }
  const chk = s.done;
  rec.vars({ running: false, 'chk.cid': chk.id, counts: null, offsets: null });
  rec.mark(DONE, 'path');
  rec.line('restore');
  rec.step(
    chk.id === 0
      ? `Flink restarts every task. No checkpoint has completed yet, so it starts from the very beginning: offset 0 everywhere and empty state.`
      : `Flink restarts every task and loads checkpoint ${chk.id}, the last one that completed. A checkpoint that had started but not completed would be ignored.`,
  );
  s.counts = [...chk.counts];
  rec.vars({ running: false, 'chk.cid': chk.id, counts: dict(s.counts), offsets: null });
  rec.mark(COUNT, 'ok');
  rec.step(
    `Count's keyed state is restored: ${fmtCounts(s.counts)}. These are the counts at barrier B${chk.id}: every record before it, none after.`,
  );
  rec.unmark(COUNT);

  s.offsets = [...chk.offsets];
  for (const h of s.history) rec.mark(oid(h.p, h.offset), 'path');
  rec.vars({ running: false, 'chk.cid': chk.id, counts: dict(s.counts), offsets: [...s.offsets] });
  rec.line('rewind');
  rec.step(
    `The sources rewind to the offsets saved with that state: ${chk.offsets.map((o, p) => `S${p} to ${o}`).join(', ')}. Kafka still holds the records after them, so they can be read again. This is why the source has to be replayable.`,
  );

  const aborted = s.txn;
  const abortedId = s.txnId;
  for (let i = 0; i <= lastIndex(aborted.length, TXN_SHOWN); i++) rec.markCell(TXN, i, 'bad');
  rec.vars({ running: false, 'chk.cid': chk.id, counts: dict(s.counts), offsets: [...s.offsets], txn: [] });
  rec.line('abort');
  rec.step(
    (aborted.length
      ? `The two-phase sink aborts transaction ${abortedId}. Its ${plural(aborted.length, 'result')} ${aborted.length === 1 ? 'was' : 'were'} never visible to readers, so dropping ${aborted.length === 1 ? 'it' : 'them'} loses nothing: the replay makes ${aborted.length === 1 ? 'it' : 'them'} again.`
      : `The two-phase sink aborts transaction ${abortedId}, which is empty.`) +
      (chk.txn !== null ? ` Transaction ${chk.txn}, named in the checkpoint, is already committed. Had the crash come before that commit, Flink would commit it now.` : ''),
  );
  s.txn = [];
  s.txnId++;
  rec.clearMarks();

  s.running = true;
  const replay = [...s.history];
  rec.vars({ running: true, 'chk.cid': chk.id, counts: dict(s.counts), offsets: [...s.offsets], txn: [] });
  rec.mark(DONE, 'path');
  rec.line('resume');
  rec.step(
    replay.length
      ? `The job runs again from checkpoint ${chk.id}. Replay: ${replay.length === 1 ? 'the 1 record counted since then comes' : `the ${replay.length} records counted since then come`} through a second time.`
      : `The job runs again from checkpoint ${chk.id}. Nothing was counted after it, so there is nothing to replay.`,
  );
  rec.unmark(DONE);
  for (const h of replay) {
    // The rewound source is at exactly the offset the record had the first time.
    if (s.offsets[h.p] !== h.offset) throw new Error('replay out of step');
    carry(s, h.p, rec, true);
  }

  const before = s.before ?? s.counts;
  const same = before.every((n, i) => n === s.counts[i]);
  rec.vars({ running: true, 'chk.cid': chk.id, counts: dict(s.counts), offsets: [...s.offsets] });
  rec.line('resume');
  rec.compare('counts now', same ? '=' : '≠', 'before crash', same ? 'state is exactly-once' : 'state differs', {
    message: `Count now holds ${fmtCounts(s.counts)}. Before the crash it held ${fmtCounts(before)}. ` + (replay.length ? `Every record counts once, even though ${replay.length} ${replay.length === 1 ? 'was' : 'were'} processed twice.` : `Nothing needed replaying.`),
  });
  const dups = s.appended.filter((r) => r.dup).length;
  rec.step(
    `State is exactly-once; side effects are not. The log sink holds ${plural(dups, 'duplicate')}, in red. The table got the same values again, so it ends right. Readers of the two-phase sink saw nothing twice: the replayed results wait in transaction ${s.txnId} until the next checkpoint commits them.`,
  );
  return replay.length;
}

// ---- layout -----------------------------------------------------------------------

/** Log slots on the left, sources, Count with its buffer, then the sinks and checkpoint storage. */
const HEAD_W = 44;
const SLOT_W = 40;
const SLOT_GAP = 3;
export const SLOTS = 5;
const X0 = HEAD_W + 10 + SLOT_W / 2;
const TAG_W = 54;
const ROW_Y = [0, 160];
/** next on the first row of tags, chk on the second, each centred under its slot. */
const NEXT_Y = CELL_H / 2 + SUB_ROOM + 2 + TAG_H / 2;
const CHK_Y = NEXT_Y + TAG_H + 2;
const SRC_X = 340;
const COUNT_X = 520;
const COUNT_Y = 75;
const COUNT_W = 60;
const HELD_X = 400;
const HELD_Y = 25;
const SINK_X = 650;
const SINK_W = 52;
const SINK_Y = { [ALO]: 0, [IDEM]: 75, [TXN]: 150, [COM]: 225 } as const;
const STORE_Y = 320;
const STORE_W = 70;
const STORE_GAP = 30;
const STORE_CELLS = SOURCES + KEYS.length + 1;
const STORE_NODE_W = 8 + (STORE_CELLS - 1) * 3 + STORE_CELLS * STORE_W;
const LEFT = -4;
const RIGHT = SINK_X + 8 + (ALO_SHOWN - 1) * 3 + ALO_SHOWN * SINK_W + 4;
const TOP = -(CELL_H / 2 + 28 + 16);
const BOTTOM = STORE_Y + CELL_H / 2 + 4;

const slotX = (i: number) => X0 + i * (SLOT_W + SLOT_GAP);
const rowWidth = (n: number, w: number) => (n > 1 ? 8 + (n - 1) * 3 + n * w : w);

/** The offset the chk tag shows: a source's new one as soon as it has saved it, else the last completed one. */
const chkOffset = (s: JobState, p: number) => (s.pending && s.pending.acks > p ? s.pending.offsets[p] : s.done.offsets[p]);

/** First offset drawn for partition p: the checkpointed offset and the next one, when they fit. */
export function windowStart(s: JobState, p: number): number {
  const next = s.running ? s.offsets[p] : s.reached[p];
  const chk = chkOffset(s, p);
  let start = Math.max(0, next - (SLOTS - 2));
  start = Math.min(start, chk);
  return Math.max(start, next - (SLOTS - 1));
}

function sinkRow(id: string, y: number, items: Cell[], shown: number, caption: string): SceneNode {
  const cells = [...items];
  while (cells.length < shown) cells.push({ text: '', w: SINK_W });
  return { id, x: SINK_X + rowWidth(shown, SINK_W) / 2, y, cells, caption };
}

const resultCell = (r: Result, tone?: Tone): Cell => ({ text: `${r.key}=${r.n}`, w: SINK_W, tone: r.dup ? 'bad' : tone });

function storeCells(chk: Snapshot | null, partial: boolean): Cell[] {
  const cells: Cell[] = [];
  for (let p = 0; p < SOURCES; p++) cells.push({ text: chk && (!partial || p < chk.acks) ? `S${p}: ${chk.offsets[p]}` : '', w: STORE_W });
  KEYS.forEach((k, i) => cells.push({ text: chk && chk.counts.length ? `${k}: ${chk.counts[i]}` : '', w: STORE_W }));
  cells.push({ text: chk && chk.txn !== null ? `txn ${chk.txn}` : '', w: STORE_W });
  return cells;
}

export function layout(s: JobState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  for (let p = 0; p < SOURCES; p++) {
    const y = ROW_Y[p];
    nodes.push({ id: `h${p}`, x: HEAD_W / 2, y, cells: [{ text: `P${p}`, w: HEAD_W }] });
    const start = windowStart(s, p);
    for (let i = 0; i < SLOTS; i++) {
      const off = start + i;
      nodes.push({ id: oid(p, off), x: slotX(i), y, cells: [{ text: String(keyAt(p, off)), sub: String(off), w: SLOT_W }] });
    }
    const at = (off: number) => slotX(Math.max(0, Math.min(SLOTS - 1, off - start)));
    const chkOff = chkOffset(s, p);
    nodes.push({
      id: `t${p}chk`,
      x: chkOff < start ? slotX(0) - SLOT_W / 2 - TAG_W / 2 + 10 : at(chkOff),
      y: y + CHK_Y,
      cells: [{ text: chkOff < start ? '‹chk' : 'chk', w: TAG_W }],
      shape: 'tag',
    });
    if (s.running) {
      nodes.push({ id: `t${p}next`, x: at(s.offsets[p]), y: y + NEXT_Y, cells: [{ text: 'next', w: TAG_W }], shape: 'tag' });
    }
    nodes.push({ id: sid(p), x: SRC_X, y, cells: [{ text: `S${p}` }], caption: s.running ? 'source' : 'stopped', tone: s.running ? undefined : 'bad' });
    edges.push({ id: eid(p), from: sid(p), to: COUNT, kind: 'line', arrow: true, dashed: p === 0 && s.aligning, tone: p === 0 && s.aligning ? 'bad' : undefined });
  }

  nodes.push({
    id: COUNT,
    x: COUNT_X,
    y: COUNT_Y,
    cells: KEYS.map((k, i) => ({ text: s.running ? `${k}: ${s.counts[i]}` : `${k}: ?`, w: COUNT_W, tone: s.running ? undefined : 'bad' })),
    caption: s.running ? 'Count, by key' : 'Count: state lost',
  });
  if (s.aligning) nodes.push({ id: HELD, x: HELD_X, y: HELD_Y, cells: [{ text: s.held ? String(s.held.key) : '', w: SLOT_W }], title: 'held' });

  nodes.push(sinkRow(ALO, SINK_Y[ALO], s.appended.slice(-ALO_SHOWN).map((r) => resultCell(r)), ALO_SHOWN, 'at-least-once: appends'));
  nodes.push(
    sinkRow(IDEM, SINK_Y[IDEM], KEYS.map((k, i) => (s.table[i] === null ? { text: '', w: SINK_W } : { text: `${k}=${s.table[i]}`, w: SINK_W })), KEYS.length, 'idempotent: upsert by key'),
  );
  const txnItems = s.txn.slice(-TXN_SHOWN).map((r) => ({ text: `${r.key}=${r.n}`, w: SINK_W, tone: 'dim' as Tone }));
  const more = s.txn.length - TXN_SHOWN;
  nodes.push(sinkRow(TXN, SINK_Y[TXN], txnItems, TXN_SHOWN, `two-phase: txn ${s.txnId}, hidden${more > 0 ? ` (+${more})` : ''}`));
  const visible: Cell[] = s.committed.map((r) => resultCell(r));
  const pre: Cell[] = s.pre ? s.pre.items.map((r) => ({ text: `${r.key}=${r.n}`, w: SINK_W, tone: 'dim' as Tone })) : [];
  nodes.push(sinkRow(COM, SINK_Y[COM], [...visible, ...pre].slice(-COM_SHOWN), COM_SHOWN, s.pre && s.pre.items.length ? 'grey: pre-committed' : 'two-phase: committed'));
  edges.push({ id: 'ea', from: COUNT, to: ALO, kind: 'line', arrow: true, toCell: 0 });
  edges.push({ id: 'ei', from: COUNT, to: IDEM, kind: 'line', arrow: true, toCell: 0 });
  edges.push({ id: 'et', from: COUNT, to: TXN, kind: 'line', arrow: true, toCell: 0 });

  const done = s.done;
  nodes.push({
    id: DONE,
    x: STORE_NODE_W / 2,
    y: STORE_Y,
    cells: storeCells(done, false),
    title: done.id === 0 ? 'no checkpoint yet: start of job' : `checkpoint ${done.id}: complete`,
  });
  if (s.pending) {
    nodes.push({
      id: PENDING,
      x: STORE_NODE_W + STORE_GAP + STORE_NODE_W / 2,
      y: STORE_Y,
      cells: storeCells(s.pending, true),
      title: `checkpoint ${s.pending.id}: ${s.pending.acks} of ${TASKS} acks`,
    });
  }

  // Two empty labels pin the corners, so the scene keeps its size between operations.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------------

const PARTITION = { name: 'partition', label: 'Partition (0 or 1)', kind: 'int', min: 0, max: 1 } as const;

const def: StructureDef<JobState> = {
  id: 'stream-checkpoints',
  create: () => create(),
  // Two records counted and checkpoint 1 taken, so the page opens with a checkpoint to fall back on.
  seed: [
    ['process', 0],
    ['process', 1],
    ['checkpoint'],
  ],
  ops: [
    {
      id: 'process',
      label: 'Process',
      intent: 'primary',
      args: [PARTITION],
      code: ['process', 'count'],
      run: (s, [p], rec) => void process(s, p, rec),
      suggest: () => [randomInt(0, SOURCES - 1)],
    },
    { id: 'checkpoint', label: 'Checkpoint', args: [], code: ['checkpoint', 'count'], run: (s, _a, rec) => void checkpoint(s, rec) },
    { id: 'crash', label: 'Crash', intent: 'danger', args: [], code: ['crash'], run: (s, _a, rec) => void crash(s, rec) },
    { id: 'recover', label: 'Recover', args: [], code: ['recover', 'process', 'count'], run: (s, _a, rec) => void recover(s, rec) },
  ],
  layout,
  counters: [
    { key: 'reads', label: 'Records read' },
    { key: 'checkpoints', label: 'Checkpoints completed' },
    { key: 'replayed', label: 'Records replayed' },
    { key: 'duplicates', label: 'Duplicates at the log sink' },
  ],
  status: (s) => [
    { label: 'Job', value: s.running ? 'running' : 'down' },
    { label: 'Restart point', value: s.done.id === 0 ? 'start of job' : `checkpoint ${s.done.id}` },
    { label: 'Source offsets', value: s.running ? s.offsets.map((o, p) => `S${p} ${o}`).join(', ') : 'lost' },
    { label: 'Duplicates in the log sink', value: String(s.appended.filter((r) => r.dup).length) },
  ],
  tour: [
    ['process', 0],
    ['checkpoint'],
    ['process', 1],
    ['process', 0],
    ['crash'],
    ['recover'],
    ['checkpoint'],
  ],
  source: { python, java },
  info,
};

export default def;
