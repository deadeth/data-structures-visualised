import type { Compare, Probe, Rec } from '../../core/types';

/**
 * Log-structured merge tree of integer keys.
 *
 * Writes land in the memtable, a small sorted buffer in memory. A full
 * memtable is flushed to a new SSTable in level 0. Level 0 tables may overlap
 * and are kept newest first. Deeper levels are each one sorted run cut into
 * tables whose key ranges never overlap, and each may hold RATIO times as many
 * tables as the level above. Compaction merges a whole level into the one
 * below, newest version of each key winning. When the last level fills up, a
 * new level opens below it. A delete writes a tombstone, which is only dropped
 * when it reaches the last level.
 *
 * Real engines pick one table and the tables it overlaps in the next level.
 * Merging whole levels is simpler to follow and keeps the property that
 * matters: each entry is rewritten a bounded number of times per level.
 */
export interface Entry {
  k: number;
  /** True for a tombstone: the key was deleted. */
  del: boolean;
}

export interface SSTable {
  id: number;
  /** Sorted by key, never empty, never changed after it is written. */
  entries: Entry[];
}

/** What the canvas shows while a compaction is running. Only set while recording. */
export interface MergeView {
  from: number;
  to: number;
  phase: 'inputs' | 'run';
  /** Colour group of each input table, by table id. */
  hue: Map<number, number>;
  run: { text: string; del: boolean; hue: number; src: number }[];
  seq: number;
}

export interface LsmState {
  mem: Entry[];
  /** levels[0] is newest first and may overlap. Deeper levels are sorted by key range. There are always at least three. */
  levels: SSTable[][];
  nextId: number;
  /** Puts and deletes accepted so far. */
  userWrites: number;
  /** Entries written to disk so far, by flushes and compactions. */
  diskWrites: number;
  /** First table shown in each level's lane. Presentation only. */
  view: number[];
  merge: MergeView | null;
  /** Nodes created by the running operation, and the node each one grows out of. */
  born: Map<string, string>;
  mergeSeq: number;
}

export const MEM_CAP = 4;
export const TABLE_CAP = 4;
/** Level 0 is compacted when it reaches this many tables. LevelDB and RocksDB also default to 4. */
export const L0_LIMIT = 4;
/** Level 1 is compacted when it holds more than this many tables. */
export const L1_LIMIT = 4;
/** Each deeper level may hold this many times as many tables as the one above. Real engines default to 10. */
export const RATIO = 4;
/** Most tables level `lv` (1 or deeper) may hold before it is merged into the level below. */
export const tableLimit = (lv: number) => L1_LIMIT * RATIO ** (lv - 1);
/** Tables drawn per lane. A longer level shows a window. */
export const VISIBLE = 4;

export const MEM = 'mem';
export const tid = (t: SSTable) => `t${t.id}`;
export const entryText = (e: Entry) => (e.del ? `${e.k}✗` : String(e.k));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: (string | number)[]) =>
  items.length <= 1 ? String(items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export type GetResult = 'found' | 'deleted' | 'missing';

export function create(): LsmState {
  return { mem: [], levels: [[], [], []], nextId: 1, userWrites: 0, diskWrites: 0, view: [0, 0, 0], merge: null, born: new Map(), mergeSeq: 0 };
}

/** Every key that a get would find, in order. A full scan: for status, suggestions and tests only. */
export function liveKeys(s: LsmState): number[] {
  const seen = new Map<number, boolean>();
  const take = (e: Entry) => {
    if (!seen.has(e.k)) seen.set(e.k, e.del);
  };
  s.mem.forEach(take);
  for (const level of s.levels) for (const t of level) t.entries.forEach(take);
  const out: number[] = [];
  for (const [k, del] of seen) if (!del) out.push(k);
  return out.sort((a, b) => a - b);
}

export function writeAmp(s: LsmState): number {
  return s.userWrites ? s.diskWrites / s.userWrites : 0;
}

const ampSentence = (s: LsmState) =>
  `Write amplification so far: ${s.diskWrites} entries written to disk for ${s.userWrites} puts and deletes, or ${writeAmp(s).toFixed(1)}×.`;

/** Work done by the running operation, for the closing sentence. */
interface Cost {
  cmp: number;
  /** SSTables read. */
  reads: number;
  /** Entries written to disk. */
  writes: number;
  /** SSTables a get read without finding the key. */
  wasted: number;
  /** SSTables moved down a level without being rewritten. */
  moved: number;
}
const newCost = (): Cost => ({ cmp: 0, reads: 0, writes: 0, wasted: 0, moved: 0 });

function cmp(rec: Rec, cost: Cost, left: number, op: Compare['op'], right: string | number, verdict: string, extra: { probe?: Probe; message?: string }): void {
  cost.cmp++;
  rec.compare(left, op, right, verdict, extra);
}

function begin(s: LsmState): void {
  if (s.born.size) s.born = new Map();
  s.merge = null;
}

/** Slide a level's window so that table `idx` is on the canvas. */
function reveal(s: LsmState, lv: number, idx: number, rec: Rec): void {
  if (!rec.recording) return;
  const maxStart = Math.max(0, s.levels[lv].length - VISIBLE);
  const start = Math.min(Math.max(s.view[lv], 0), maxStart);
  s.view[lv] = idx < start || idx >= start + VISIBLE ? Math.min(Math.max(idx - 1, 0), maxStart) : start;
}

/** Where the newest copy of `key` lives. Recording only: it may scan every table. */
function locate(s: LsmState, key: number): { id: string; cell: number; lv: number; idx: number } | null {
  const m = s.mem.findIndex((e) => e.k === key);
  if (m >= 0) return { id: MEM, cell: m, lv: -1, idx: 0 };
  for (let lv = 0; lv < s.levels.length; lv++) {
    const tables = s.levels[lv];
    for (let idx = 0; idx < tables.length; idx++) {
      const cell = tables[idx].entries.findIndex((e) => e.k === key);
      if (cell >= 0) return { id: tid(tables[idx]), cell, lv, idx };
    }
  }
  return null;
}

/** Keep the followed key highlighted wherever it has moved to. */
function markKey(s: LsmState, key: number | undefined, rec: Rec): void {
  if (!rec.recording || key === undefined) return;
  const at = locate(s, key);
  if (!at) return;
  if (at.lv >= 0) reveal(s, at.lv, at.idx, rec);
  rec.markCell(at.id, at.cell, 'key');
}

/** Copies of `key` in tables older than the given place. Recording only. */
function olderCopies(s: LsmState, key: number, afterLv: number, afterIdx: number): { id: string; cell: number; lv: number }[] {
  const out: { id: string; cell: number; lv: number }[] = [];
  for (let lv = Math.max(afterLv, 0); lv < s.levels.length; lv++) {
    const tables = s.levels[lv];
    for (let idx = 0; idx < tables.length; idx++) {
      if (lv === afterLv && (lv > 0 || idx <= afterIdx)) continue;
      const cell = tables[idx].entries.findIndex((e) => e.k === key && !e.del);
      if (cell >= 0) out.push({ id: tid(tables[idx]), cell, lv });
    }
  }
  return out;
}

// ---- memtable ---------------------------------------------------------------

/** Scan the sorted memtable for `key`. Returns where it is, or where it would go. */
function scanMem(s: LsmState, key: number, rec: Rec, cost: Cost, mode: 'read' | 'write'): { found: boolean; pos: number } {
  const n = s.mem.length;
  for (let i = 0; i < n; i++) {
    const e = s.mem[i];
    const probe: Probe = { text: String(key), at: MEM, cell: i };
    rec.markCell(MEM, i, 'compare');
    rec.line('scan');
    if (key === e.k) {
      const verdict = mode === 'write' ? `${key} is already in the memtable` : e.del ? `match, but this entry is a tombstone` : `match`;
      cmp(rec, cost, key, '=', entryText(e), verdict, { probe });
      return { found: true, pos: i };
    }
    if (key < e.k) {
      const verdict = mode === 'write' ? `${key} goes just before ${e.k}` : `${key} would sit before ${e.k}, so it is not in the memtable`;
      cmp(rec, cost, key, '<', entryText(e), verdict, { probe });
      rec.markCell(MEM, i, 'idle');
      return { found: false, pos: i };
    }
    const end = mode === 'write' ? `past the last entry, so ${key} goes at the end` : `past the last entry, so it is not in the memtable`;
    cmp(rec, cost, key, '>', entryText(e), i === n - 1 ? end : `keep scanning right`, { probe });
    rec.markCell(MEM, i, 'idle');
  }
  return { found: false, pos: n };
}

/** Write the memtable to a new SSTable at the front of level 0. */
function flushMem(s: LsmState, rec: Rec, cost: Cost, why: 'full' | 'manual', key?: number): void {
  const n = s.mem.length;
  rec.clearMarks();
  rec.mark(MEM, 'path');
  markKey(s, key, rec);
  rec.line('flush_write');
  rec.step(
    why === 'full'
      ? `The memtable is full: ${n} of ${MEM_CAP} entries. Flush it: write the whole buffer to disk as one sorted file, called an SSTable.`
      : `Flush on request: write the ${plural(n, 'entry', 'entries')} in the memtable to disk as one sorted file, called an SSTable.`,
  );
  const table: SSTable = { id: s.nextId++, entries: s.mem };
  s.mem = [];
  s.levels[0].unshift(table);
  s.diskWrites += n;
  cost.writes += n;
  rec.count('writes', n);
  if (rec.recording) s.born.set(tid(table), MEM);
  rec.clearMarks();
  rec.mark(tid(table), 'ok');
  markKey(s, key, rec);
  rec.line('flush_l0');
  rec.step(
    `Flushed: ${plural(n, 'entry', 'entries')} written in one sequential pass to a new SSTable at the front of L0. The file is never changed again, and its key range may overlap the other L0 tables.`,
  );
}

// ---- compaction -------------------------------------------------------------

type CompactWhy = 'limit' | 'manual' | 'cascade';

/**
 * Compact level `lv`: merge every table in it with every table of the level below, into a new level below.
 * If the level below does not exist yet, it is opened first.
 */
function compactLevel(s: LsmState, lv: number, rec: Rec, cost: Cost, why: CompactWhy, key?: number): void {
  const to = lv + 1;
  // The last level has nowhere to merge into, so the tree grows a level.
  const opened = to === s.levels.length;
  if (opened) {
    s.levels.push([]);
    s.view.push(0);
  }
  const last = to === s.levels.length - 1;
  const upper = s.levels[lv];
  const lower = s.levels[to];
  const from = `L${lv}`;
  const into = `L${to}`;
  const recording = rec.recording;
  // The line that asked for this compaction.
  const trigger = why === 'limit' ? 'l0_full' : why === 'cascade' ? 'over_limit' : 'pick';

  // Runs, newest first. Level 0 tables overlap, so each is its own run. A deeper level is one run.
  const groups: SSTable[][] = lv === 0 ? upper.map((t) => [t]) : [upper];
  if (lower.length) groups.push(lower);

  const n = upper.length;
  const reason = () =>
    why === 'limit'
      ? `L0 has reached ${n} tables, its limit, and a get may have to read every one of them.`
      : why === 'cascade'
        ? `${from} now holds ${n} tables, over its limit of ${tableLimit(lv)}.${opened ? ` It was the last level, so a new level, ${into}, opens below it.` : ''}`
        : lv === 0
          ? `Compact on request.`
          : `Nothing is waiting above ${from}, so compact ${from} itself.`;

  // A single sorted run with nothing below it is already a valid level, so its tables can move down untouched.
  // The exception: tombstones must not reach the last level, so a run that holds any is rewritten without them.
  if (groups.length === 1 && !(last && upper.some((t) => t.entries.some((e) => e.del)))) {
    if (recording) {
      rec.clearMarks();
      for (const t of upper) rec.mark(tid(t), 'path');
      markKey(s, key, rec);
      rec.line(trigger, 'lone_run');
      rec.step(`${reason()} ${into} is empty, so there is nothing to merge ${n === 1 ? 'this table' : `these ${n} tables`} with.`);
    }
    s.levels[to] = upper;
    s.levels[lv] = [];
    cost.moved += n;
    if (recording) {
      s.view[to] = s.view[lv];
      s.view[lv] = 0;
      rec.clearMarks();
      for (const t of upper) rec.mark(tid(t), 'ok');
      markKey(s, key, rec);
      rec.line('move');
      rec.step(
        `${n === 1 ? 'The table moves' : `The ${n} tables move`} down to ${into} as ${n === 1 ? 'it is' : 'they are'}. Nothing is read or rewritten, only the list of which file belongs to which level changes. LevelDB and RocksDB call this a trivial move.`,
      );
    }
    return;
  }
  const runs: Entry[][] = groups.map((g) => (g.length === 1 ? g[0].entries : g.flatMap((t) => t.entries)));
  // Recording only: which table and cell each run position came from.
  const origin: { t: SSTable; cell: number }[][] = recording ? groups.map((g) => g.flatMap((t) => t.entries.map((_, cell) => ({ t, cell })))) : [];

  const inputs = upper.length + lower.length;
  cost.reads += inputs;
  rec.count('reads', inputs);

  if (recording) {
    const hue = new Map<number, number>();
    groups.forEach((g, gi) => g.forEach((t) => hue.set(t.id, lower.length && gi === groups.length - 1 ? 3 : gi % 3)));
    s.merge = { from: lv, to, phase: 'inputs', hue, run: [], seq: ++s.mergeSeq };
    s.view[lv] = 0;
    s.view[to] = 0;
    rec.clearMarks();
    for (const t of upper) rec.mark(tid(t), 'path');
    for (const t of lower) rec.mark(tid(t), 'path');
    markKey(s, key, rec);
    // A lone run is only here because the move was ruled out. Otherwise show the runs being gathered.
    if (groups.length === 1) rec.line(trigger, 'lone_run');
    else rec.line(trigger, lv === 0 ? 'runs_l0' : 'runs_level', ...(lower.length ? ['runs_below'] : []));
    rec.step(
      groups.length === 1
        ? `${reason()} ${into} is empty, but it is the last level, where tombstones are dropped, so ${n === 1 ? 'the table is' : `the ${n} tables are`} rewritten without them.`
        : `${reason()} Compaction reads ${plural(n, `${from} table`)}${lower.length ? ` and ${plural(lower.length, `${into} table`)}` : ''} and merges them into a new ${into}.`,
    );
  }

  // k-way merge: keep taking the smallest head. On a tie the newest run wins and the older copies are dropped.
  const heads = runs.map(() => 0);
  const out: Entry[] = [];
  const outSrc: number[] = [];
  const stale: { t: SSTable; cell: number; k: number }[] = [];
  const droppedTombs: { t: SSTable; cell: number; k: number }[] = [];
  const keptTombs: number[] = [];
  const ties: number[] = [];
  let comparisons = 0;
  for (;;) {
    let best = -1;
    ties.length = 0;
    for (let r = 0; r < runs.length; r++) {
      if (heads[r] >= runs[r].length) continue;
      if (best < 0) {
        best = r;
        continue;
      }
      comparisons++;
      const a = runs[r][heads[r]].k;
      const b = runs[best][heads[best]].k;
      if (a < b) {
        best = r;
        ties.length = 0;
      } else if (a === b) {
        ties.push(r);
      }
    }
    if (best < 0) break;
    const e = runs[best][heads[best]];
    for (const r of ties) {
      if (recording) stale.push({ ...origin[r][heads[r]], k: e.k });
      heads[r]++;
    }
    if (e.del && last) {
      if (recording) droppedTombs.push({ ...origin[best][heads[best]], k: e.k });
    } else {
      out.push(e);
      if (recording) {
        outSrc.push(origin[best][heads[best]].t.id);
        if (e.del) keptTombs.push(e.k);
      }
    }
    heads[best]++;
  }
  cost.cmp += comparisons;
  rec.count('comparisons', comparisons);

  if (recording && s.merge) {
    if (stale.length || droppedTombs.length || keptTombs.length) {
      for (const d of stale) rec.markCell(tid(d.t), d.cell, 'dim');
      for (const d of droppedTombs) rec.markCell(tid(d.t), d.cell, 'dim');
      const parts: string[] = [];
      if (stale.length) {
        const keys = [...new Set(stale.map((d) => d.k))];
        parts.push(
          `${list(keys)} ${keys.length === 1 ? 'appears' : 'appear'} in more than one input. The newest copy wins, and the older ${stale.length === 1 ? 'copy (greyed out) is' : 'copies (greyed out) are'} dropped.`,
        );
      }
      if (droppedTombs.length) {
        const marks = droppedTombs.map((d) => `${d.k}✗`);
        parts.push(
          `${into} is the last level, so nothing older can hide below it: the ${marks.length === 1 ? 'tombstone' : 'tombstones'} ${list(marks)} can finally be dropped too.`,
        );
      }
      if (keptTombs.length) {
        const marks = keptTombs.map((k) => `${k}✗`);
        parts.push(
          `The ${marks.length === 1 ? 'tombstone' : 'tombstones'} ${list(marks)} must be kept: an older copy could still sit in a deeper level, and only the tombstone hides it.`,
        );
      }
      rec.line(...(stale.length ? ['stale'] : []), ...(droppedTombs.length || keptTombs.length ? ['tombstone'] : []), ...(droppedTombs.length ? ['dropped'] : []));
      rec.step(parts.join(' '));
    }
    s.merge.phase = 'run';
    s.merge.run = out.map((e, i) => ({ text: entryText(e), del: e.del, hue: s.merge!.hue.get(outSrc[i]) ?? 0, src: outSrc[i] }));
    rec.clearMarks();
    // The upper inputs stay on the canvas, faded, so the colours in the run can be traced back to them.
    for (const t of upper) rec.mark(tid(t), 'dim');
    // With several inputs the work is in the merge loop. With one, or nothing left, there is no loop to show.
    rec.line(out.length && groups.length > 1 ? 'smallest' : 'merge');
    rec.step(
      !out.length
        ? `Every entry was a stale copy or a spent tombstone, so nothing is left to write.`
        : groups.length === 1
          ? `There is only one input, so no merging is needed: the ${plural(out.length, 'entry', 'entries')} that ${out.length === 1 ? 'is' : 'are'} left ${out.length === 1 ? 'is' : 'are'} copied across in order.`
          : `Merge sort: keep taking the smallest key at the front of any input. ${plural(comparisons, 'comparison')} give one sorted run of ${plural(out.length, 'entry', 'entries')}, each coloured by the input it came from.`,
    );
  }

  // Cut the run into tables and replace both levels.
  const fresh: SSTable[] = [];
  for (let i = 0; i < out.length; i += TABLE_CAP) {
    const t: SSTable = { id: s.nextId++, entries: out.slice(i, i + TABLE_CAP) };
    fresh.push(t);
    if (recording && s.merge) s.born.set(tid(t), `r${s.merge.seq}-${i}`);
  }
  s.levels[lv] = [];
  s.levels[to] = fresh;
  s.diskWrites += out.length;
  cost.writes += out.length;
  rec.count('writes', out.length);
  s.merge = null;
  if (recording) {
    s.view[lv] = 0;
    s.view[to] = 0;
    rec.clearMarks();
    for (const t of fresh) rec.mark(tid(t), 'ok');
    markKey(s, key, rec);
    rec.line('cut');
    if (out.length) {
      rec.step(
        `The run is cut into ${plural(fresh.length, 'SSTable')} of up to ${TABLE_CAP} entries and written to ${into}: ${plural(out.length, 'entry', 'entries')} in one sequential pass. ${fresh.length > 1 ? 'Their key ranges never overlap, so a get reads at most one of them. ' : ''}Only now are the input files deleted, which leaves ${from} empty.`,
      );
    } else {
      rec.step(`Nothing survived the merge, so the input files are deleted and ${into} is empty. The space is free again.`);
    }
  }
}

/** Run whatever compactions the level limits call for. Returns true if any ran. */
function settle(s: LsmState, rec: Rec, cost: Cost, key?: number): boolean {
  let ran = false;
  if (s.levels[0].length >= L0_LIMIT) {
    compactLevel(s, 0, rec, cost, 'limit', key);
    ran = true;
  }
  return cascade(s, rec, cost, key) || ran;
}

/** Push any deeper level that is over its limit into the level below it. The loop also covers a level it has just opened. */
function cascade(s: LsmState, rec: Rec, cost: Cost, key?: number): boolean {
  let ran = false;
  for (let lv = 1; lv < s.levels.length; lv++) {
    if (s.levels[lv].length > tableLimit(lv)) {
      compactLevel(s, lv, rec, cost, 'cascade', key);
      ran = true;
    }
  }
  return ran;
}

/** Close a put or delete: flush and compact if the memtable is now full, then state the cost. */
function finishWrite(s: LsmState, key: number, rec: Rec, cost: Cost, what: string, quietTail: string): void {
  if (s.mem.length < MEM_CAP) {
    rec.line('no_flush');
    rec.step(
      `${what} done: ${cost.cmp ? `${plural(cost.cmp, 'comparison')} in memory` : 'the memtable was empty, so there was nothing to compare,'} and no disk I/O. ${quietTail}`,
    );
    return;
  }
  flushMem(s, rec, cost, 'full', key);
  const compacted = settle(s, rec, cost, key);
  if (!rec.recording) return;
  rec.clearMarks();
  markKey(s, key, rec);
  rec.line('wrote');
  rec.step(
    `${what} done. It happened to fill the memtable, so it paid for a flush${compacted ? ' and a compaction' : ''}: ${plural(cost.writes, 'entry', 'entries')} written to disk. ${ampSentence(s)}`,
  );
}

// ---- operations -------------------------------------------------------------

export function put(s: LsmState, key: number, rec: Rec): void {
  begin(s);
  s.userWrites++;
  const cost = newCost();
  rec.mark(MEM, 'path');
  rec.line('start');
  rec.step(`A put goes straight to the memtable, a small sorted buffer in memory. Nothing on disk is read first, or changed in place.`, {
    probe: { text: String(key), at: MEM },
  });
  const { found, pos } = scanMem(s, key, rec, cost, 'write');
  if (found) {
    rec.line('overwrite');
    if (s.mem[pos].del) {
      s.mem[pos] = { k: key, del: false };
      rec.mark(MEM, 'ok');
      rec.markCell(MEM, pos, 'key');
      rec.step(`The memtable held a tombstone for ${key}. The put overwrites it in place, so ${key} is live again and the memtable is no bigger.`);
    } else {
      rec.mark(MEM, 'ok');
      rec.markCell(MEM, pos, 'key');
      rec.step(
        `${key} is already in the memtable, so its value is overwritten in place. The memtable still holds ${plural(s.mem.length, 'entry', 'entries')}, and no disk I/O was needed.`,
      );
    }
    return;
  }
  s.mem.splice(pos, 0, { k: key, del: false });
  rec.mark(MEM, 'ok');
  rec.markCell(MEM, pos, 'key');
  rec.line('insert');
  if (rec.recording) {
    const older = olderCopies(s, key, -1, -1);
    rec.step(
      older.length
        ? `${key} is in the memtable. An older ${key} sits in L${older[0].lv}, but the put did not look for it: gets check the memtable first, so the new copy wins.`
        : `${key} is in the memtable, kept in sorted order. A real store appends each write to a log file first (the write-ahead log), so a crash cannot lose what is only in memory.`,
    );
  }
  finishWrite(s, key, rec, cost, `Put ${key}`, `The memtable holds ${s.mem.length} of ${MEM_CAP} entries.`);
}

export function remove(s: LsmState, key: number, rec: Rec): void {
  begin(s);
  s.userWrites++;
  const cost = newCost();
  rec.mark(MEM, 'path');
  rec.line('start');
  rec.step(
    `A delete cannot take ${key} out of the SSTables, because they are never changed. It writes a tombstone to the memtable instead: a marker that says ${key} is deleted.`,
    { probe: { text: String(key), at: MEM } },
  );
  const { found, pos } = scanMem(s, key, rec, cost, 'write');
  if (found && s.mem[pos].del) {
    rec.markCell(MEM, pos, 'key');
    rec.line('already');
    rec.step(`The memtable already holds a tombstone for ${key}. Nothing to do.`);
    return;
  }
  if (found) {
    s.mem[pos] = { k: key, del: true };
    rec.mark(MEM, 'ok');
    rec.markCell(MEM, pos, 'key');
    rec.line('replace');
    rec.step(`${key} was still in the memtable, so the tombstone ${key}✗ replaces it there. The tombstone has to stay: older copies of ${key} may sit in the SSTables.`);
  } else {
    s.mem.splice(pos, 0, { k: key, del: true });
    rec.mark(MEM, 'ok');
    rec.markCell(MEM, pos, 'key');
    rec.line('tombstone');
    if (rec.recording) {
      const older = olderCopies(s, key, -1, -1);
      rec.step(
        older.length
          ? `${key}✗ is the tombstone. Every get for ${key} now stops here and reports "not found". The old ${key} in L${older[0].lv} is still on disk, untouched.`
          : `${key}✗ is the tombstone. The delete did not check whether ${key} exists: looking would cost disk reads, and a tombstone is correct either way.`,
      );
    }
  }
  finishWrite(
    s,
    key,
    rec,
    cost,
    `Delete ${key}`,
    `No space is freed yet: the tombstone takes room of its own until compaction carries it to the last level.`,
  );
}

/** Compare `key` with a table's smallest and largest key. Returns -1 below, 1 above, 0 inside. */
function rangeCheck(t: SSTable, key: number, rec: Rec, cost: Cost, verdicts: { below: string; above: string }): -1 | 0 | 1 {
  const id = tid(t);
  const lastCell = t.entries.length - 1;
  const lo = t.entries[0];
  const hi = t.entries[lastCell];
  const text = String(key);
  rec.markCell(id, 0, 'compare');
  rec.line('range_lo');
  if (key < lo.k) {
    cmp(rec, cost, key, '<', entryText(lo), verdicts.below, { probe: { text, at: id, cell: 0 } });
    rec.markCell(id, 0, 'idle');
    return -1;
  }
  cmp(rec, cost, key, '≥', entryText(lo), `not below this table's smallest key, so check its largest`, { probe: { text, at: id, cell: 0 } });
  rec.markCell(id, 0, 'idle');
  rec.markCell(id, lastCell, 'compare');
  rec.line('range_hi');
  if (key > hi.k) {
    cmp(rec, cost, key, '>', entryText(hi), verdicts.above, { probe: { text, at: id, cell: lastCell } });
    rec.markCell(id, lastCell, 'idle');
    return 1;
  }
  cmp(rec, cost, key, '≤', entryText(hi), `inside this table's range ${lo.k}..${hi.k}, so it has to be read`, { probe: { text, at: id, cell: lastCell } });
  rec.markCell(id, lastCell, 'idle');
  return 0;
}

/** Read one SSTable and scan it for `key`. Returns the cell that holds it, or -1. */
function readTable(t: SSTable, key: number, rec: Rec, cost: Cost): number {
  const id = tid(t);
  cost.reads++;
  rec.count('reads');
  rec.mark(id, 'path');
  rec.line('scan');
  for (let i = 0; i < t.entries.length; i++) {
    const e = t.entries[i];
    const probe: Probe = { text: String(key), at: id, cell: i };
    rec.markCell(id, i, 'compare');
    if (key === e.k) {
      cmp(rec, cost, key, '=', entryText(e), e.del ? `match, but this entry is a tombstone` : `match`, { probe });
      return i;
    }
    if (key < e.k) {
      cost.wasted++;
      rec.mark(id, 'bad');
      cmp(rec, cost, key, '<', entryText(e), `${key} would sit before ${e.k}, so it is not in this table`, {
        probe,
        message:
          cost.wasted === 1
            ? `Not in this table, so that read was wasted. Real stores first ask a small Bloom filter held in memory, which rules out most tables like this without touching the disk.`
            : `Not in this table either: another wasted read.`,
      });
      rec.markCell(id, i, 'idle');
      return -1;
    }
    cmp(rec, cost, key, '>', entryText(e), `keep scanning right`, { probe });
    rec.markCell(id, i, 'idle');
  }
  return -1;
}

/** Binary search a sorted, non-overlapping level for the one table whose range holds `key`. */
function findInLevel(s: LsmState, lv: number, key: number, rec: Rec, cost: Cost): number {
  const tables = s.levels[lv];
  const name = `L${lv}`;
  let lo = 0;
  let hi = tables.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    reveal(s, lv, mid, rec);
    const side = rangeCheck(tables[mid], key, rec, cost, {
      below: mid > lo ? `below this table's range, skip it and look left` : `below this table's range, and nothing is left to check: not in ${name}`,
      above: mid < hi ? `above this table's range, skip it and look right` : `above this table's range, and nothing is left to check: not in ${name}`,
    });
    if (side === 0) return mid;
    if (side < 0) {
      if (rec.recording) for (let i = mid; i <= hi; i++) rec.mark(tid(tables[i]), 'dim');
      hi = mid - 1;
    } else {
      if (rec.recording) for (let i = lo; i <= mid; i++) rec.mark(tid(tables[i]), 'dim');
      lo = mid + 1;
    }
  }
  return -1;
}

export function get(s: LsmState, key: number, rec: Rec): GetResult {
  begin(s);
  const cost = newCost();
  const text = String(key);
  rec.mark(MEM, 'path');
  rec.line('start');
  rec.step(
    s.mem.length
      ? `A get starts in the memtable. It holds the newest writes, so a hit here is the latest version and costs no disk read.`
      : `A get starts in the memtable, which holds the newest writes. It is empty, so the search moves to disk.`,
    { probe: { text, at: MEM } },
  );
  const m = scanMem(s, key, rec, cost, 'read');
  if (m.found) {
    const probe: Probe = { text, at: MEM, cell: m.pos };
    rec.line('mem_hit');
    if (s.mem[m.pos].del) {
      rec.mark(MEM, 'bad');
      rec.markCell(MEM, m.pos, 'bad');
      rec.step(`The memtable holds a tombstone for ${key}, so the key is deleted. The get stops here and reports "not found" without reading the disk.${hideOlder(s, key, rec, -1, -1)}`, {
        probe,
      });
      return 'deleted';
    }
    rec.mark(MEM, 'ok');
    rec.markCell(MEM, m.pos, 'ok');
    rec.step(`Found ${key} in the memtable after ${plural(cost.cmp, 'comparison')}. No SSTable was read: the newest data is the cheapest to reach.`, { probe });
    return 'found';
  }
  rec.mark(MEM, 'dim');
  let lead = s.mem.length ? `Not in the memtable, so go to disk. ` : '';

  const hit = (lv: number, idx: number, cell: number): GetResult => {
    const t = s.levels[lv][idx];
    const id = tid(t);
    const probe: Probe = { text, at: id, cell };
    const reads = plural(cost.reads, 'SSTable');
    rec.line(lv === 0 ? 'l0_hit' : 'deep_hit');
    if (t.entries[cell].del) {
      rec.mark(id, 'bad');
      rec.markCell(id, cell, 'bad');
      rec.step(`${key}✗ is a tombstone: ${key} was deleted, so the get stops and reports "not found" after reading ${reads}.${hideOlder(s, key, rec, lv, idx)}`, { probe });
      return 'deleted';
    }
    rec.mark(id, 'ok');
    rec.markCell(id, cell, 'ok');
    const wasted = cost.wasted ? `, ${cost.wasted} of them for nothing` : '';
    rec.step(
      cost.reads > 1
        ? `Found ${key} in L${lv} after reading ${reads}${wasted}. One get, several files: that is read amplification.`
        : `Found ${key} in L${lv} after reading ${reads}.${lv < s.levels.length - 1 ? ` Deeper levels are not read once a copy turns up, because the newest copy wins.` : ''}`,
      { probe },
    );
    return 'found';
  };

  // Level 0: tables overlap, so every one whose range covers the key must be read, newest first.
  const l0 = s.levels[0];
  if (l0.length) {
    rec.line('l0');
    rec.step(
      `${lead}L0 tables can overlap in key range, so ${l0.length === 1 ? 'the one table here has' : l0.length === 2 ? 'both have' : `all ${l0.length} have`} to be checked, newest first. Each table's smallest and largest key are kept in memory, so a table whose range rules ${key} out is skipped without a read.`,
      { probe: { text, at: tid(l0[0]) } },
    );
    lead = `Not in L0. `;
    for (let i = 0; i < l0.length; i++) {
      const t = l0[i];
      const side = rangeCheck(t, key, rec, cost, { below: `below this table's range, skip it`, above: `above this table's range, skip it` });
      if (side !== 0) {
        rec.mark(tid(t), 'dim');
        continue;
      }
      const cell = readTable(t, key, rec, cost);
      if (cell >= 0) return hit(0, i, cell);
    }
  } else {
    lead += `L0 is empty. `;
  }

  // Deeper levels: ranges do not overlap, so at most one table per level can hold the key.
  for (let lv = 1; lv < s.levels.length; lv++) {
    const tables = s.levels[lv];
    const name = `L${lv}`;
    if (!tables.length) {
      lead += `${name} is empty. `;
      continue;
    }
    if (rec.recording) {
      const mid = (tables.length - 1) >> 1;
      reveal(s, lv, mid, rec);
      rec.line('level');
      rec.step(
        tables.length === 1
          ? `${lead}${name} holds one table. Check its key range before reading it.`
          : `${lead}${name} is one sorted run cut into tables that never overlap, so at most one can hold ${key}. Binary search their key ranges to find it.`,
        { probe: { text, at: tid(tables[mid]) } },
      );
    }
    lead = `Not in ${name} either. `;
    const idx = findInLevel(s, lv, key, rec, cost);
    if (idx < 0) continue;
    const cell = readTable(tables[idx], key, rec, cost);
    if (cell >= 0) return hit(lv, idx, cell);
  }

  rec.line('miss');
  rec.step(
    cost.reads
      ? `${key} is not stored. Proving that took the memtable and ${plural(cost.reads, 'SSTable read')}. A miss is the slow case, which is why real stores put a Bloom filter in front of every table.`
      : `${key} is not stored. The key ranges ruled out every table, so no SSTable was read.`,
  );
  return 'missing';
}

/** Grey out copies that a tombstone now hides, and say where they are. Recording only. */
function hideOlder(s: LsmState, key: number, rec: Rec, lv: number, idx: number): string {
  if (!rec.recording) return '';
  const older = olderCopies(s, key, lv, idx);
  if (!older.length) return '';
  for (const o of older) rec.markCell(o.id, o.cell, 'dim');
  return ` The old ${key} in L${older[0].lv} is still on disk, hidden by the tombstone until compaction removes them both.`;
}

export function flush(s: LsmState, rec: Rec): void {
  begin(s);
  const cost = newCost();
  if (!s.mem.length) {
    rec.line('flush_empty');
    rec.step(`The memtable is empty, so there is nothing to flush.`);
    return;
  }
  flushMem(s, rec, cost, 'manual');
  const compacted = settle(s, rec, cost);
  if (!rec.recording) return;
  rec.clearMarks();
  rec.line('flush_done');
  rec.step(
    compacted
      ? `Flush done, and it set off a compaction: ${plural(cost.writes, 'entry', 'entries')} written to disk in total. ${ampSentence(s)}`
      : `Flush done: ${plural(cost.writes, 'entry', 'entries')} written to disk. L0 holds ${s.levels[0].length} of the ${L0_LIMIT} tables that set off a compaction.`,
  );
}

export function compact(s: LsmState, rec: Rec): void {
  begin(s);
  const cost = newCost();
  // The shallowest level that holds anything is merged into the one below it. The last level has nowhere to go.
  const bottom = s.levels.length - 1;
  let lv = 0;
  while (lv < bottom && !s.levels[lv].length) lv++;
  if (lv === bottom) {
    rec.line('nothing');
    rec.step(
      s.levels[bottom].length
        ? `Everything on disk is already in L${bottom}, the last level, so there is nothing to merge down.`
        : `There are no SSTables yet, so there is nothing to compact.`,
    );
    return;
  }
  compactLevel(s, lv, rec, cost, 'manual');
  cascade(s, rec, cost);
  if (!rec.recording) return;
  rec.clearMarks();
  rec.line('compact_done');
  rec.step(
    cost.reads
      ? `Compaction done: ${plural(cost.reads, 'SSTable')} read and ${plural(cost.writes, 'entry', 'entries')} rewritten, and no put asked for any of it. ${ampSentence(s)}`
      : `Compaction done, and this one was free: ${plural(cost.moved, 'table')} changed level and nothing was rewritten.`,
  );
}
