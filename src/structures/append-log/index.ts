import { LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_GAP, CELL_H, TAG_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';
import java from './code/AppendLog.java?raw';
import python from './code/append_log.py?raw';
import { info } from './info';

/**
 * A topic as Kafka keeps it: a few partitions, each an append-only array of
 * records, read by two independent consumer groups.
 *
 * A record never moves and is never changed. Its offset is the count of
 * records appended to its partition before it. A consumer group does not take
 * records out of the log. It only keeps two numbers per partition: `position`,
 * the next offset it will read, which lives in the consumer's memory, and
 * `committed`, the offset it has saved and will restart from.
 */
export interface Partition {
  /** Offset of the oldest record still kept. Moves up only when retention drops a segment. */
  start: number;
  /** Record keys. `records[i]` has offset `start + i`. */
  records: number[];
}

export interface Group {
  /** Next offset to read, per partition. Lost when the consumer crashes. */
  position: number[];
  /** Saved offset, per partition. A restarted consumer resumes from here. */
  committed: number[];
  /**
   * Not part of the log or the consumer: the page's own note of how far this
   * group has ever read, so a read after a crash can be labelled as a repeat.
   */
  seen: number[];
}

export const GROUPS = ['a', 'b'] as const;
export type GroupId = (typeof GROUPS)[number];

export interface LogState {
  partitions: Partition[];
  groups: Record<GroupId, Group>;
  /** Most records a partition may keep. The page draws 6; a real partition is bounded only by retention. */
  maxRecords: number;
}

/** Records per segment. Retention drops a whole segment at a time. Kafka's default segment is 1 GB. */
export const SEGMENT = 2;
/** Segments drawn per partition. */
export const MAX_SEGMENTS = 3;
export const MAX_RECORDS = SEGMENT * MAX_SEGMENTS;
/** A prime just above the largest key. */
export const PRIME = 1009;

/** Small enough to check by hand. Kafka's default partitioner runs murmur2 over the key's bytes. */
export function hashKey(key: number): number {
  return (31 * key + 7) % PRIME;
}

export function partitionOf(key: number, partitions: number): number {
  return hashKey(key) % partitions;
}

export function create(partitions = 3, maxRecords = MAX_RECORDS): LogState {
  const group = (): Group => ({
    position: new Array<number>(partitions).fill(0),
    committed: new Array<number>(partitions).fill(0),
    seen: new Array<number>(partitions).fill(0),
  });
  return {
    partitions: Array.from({ length: partitions }, () => ({ start: 0, records: [] })),
    groups: { a: group(), b: group() },
    maxRecords,
  };
}

/** The offset the next record in this partition will get. */
export const endOf = (part: Partition) => part.start + part.records.length;

/** Records a group has still to read, over every partition. */
export function lag(s: LogState, g: GroupId): number {
  return s.partitions.reduce((sum, part, p) => sum + endOf(part) - s.groups[g].position[p], 0);
}

/** Records a group has read but not committed, over every partition. */
export function uncommitted(s: LogState, g: GroupId): number {
  return s.partitions.reduce((sum, _part, p) => sum + s.groups[g].position[p] - s.groups[g].committed[p], 0);
}

export function asGroup(raw: number | string): GroupId | null {
  const g = String(raw).trim().toLowerCase();
  return g === 'a' || g === 'b' ? g : null;
}

const name = (g: GroupId) => g.toUpperCase();
const other = (g: GroupId): GroupId => (g === 'a' ? 'b' : 'a');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const validPartition = (s: LogState, p: number) => Number.isInteger(p) && p >= 0 && p < s.partitions.length;

// ---- ids --------------------------------------------------------------------

const hid = (p: number) => `h${p}`;
/**
 * A slot is named after its offset, which never changes, so a record keeps its
 * id for life and slides along when older records are dropped. The empty slot
 * at the end of the log has the id of the record that will fill it.
 */
const oid = (p: number, offset: number) => `p${p}o${offset}`;
const bid = (p: number, segment: number) => `p${p}s${segment}`;
const tid = (p: number, g: GroupId, which: 'pos' | 'commit') => `t${p}${g}${which}`;

const probeAt = (key: number, p: number, offset: number): Probe => ({ text: String(key), at: oid(p, offset) });

// ---- operations ---------------------------------------------------------------

/** Append a record. Returns where it went, or null when the page's drawing limit is reached. */
export function produce(s: LogState, key: number, rec: Rec): { partition: number; offset: number } | null {
  const count = s.partitions.length;
  const raw = 31 * key + 7;
  const h = hashKey(key);
  rec.line('hash');
  rec.step(
    `Produce a record with key ${key}. The producer does not choose a partition by hand. It hashes the key: 31 × ${key} + 7 = ${raw}, and ${raw} mod ${PRIME} = ${h}.`,
  );

  const p = h % count;
  const part = s.partitions[p];
  rec.mark(hid(p), 'path');
  rec.line('pick');
  rec.step(
    `${h} mod ${count} = ${p}, so the record goes to partition ${p}. The same key always gives the same sum, so every record with key ${key} lands in this one partition.`,
    { probe: { text: String(key), at: hid(p) } },
  );
  if (part.records.length >= s.maxRecords) {
    rec.step(
      `Sorry, this page draws at most ${s.maxRecords} records in a partition so they stay readable, and partition ${p} is full. Run Trim on partition ${p} to drop its oldest segment, then produce ${key} again. A real partition has no such limit: it grows until retention deletes old segments.`,
      { probe: { text: String(key), at: hid(p) } },
    );
    return null;
  }

  const offset = endOf(part);
  rec.line('offset');
  rec.step(
    `Partition ${p} has taken ${plural(offset, 'record')} since it was made, so its next free offset is ${offset}. The record goes there, at the end. A log never writes into the middle.`,
    { probe: probeAt(key, p, offset) },
  );

  const earlier = part.records.flatMap((k, i) => (k === key ? [part.start + i] : []));
  const rolled = part.records.length > 0 && part.records.length % SEGMENT === 0;
  part.records.push(key);
  rec.count('writes');
  const probe = probeAt(key, p, offset);
  rec.mark(oid(p, offset), 'key');
  rec.line('append');
  rec.step(
    `Append ${key} at offset ${offset}. ` +
      (rolled ? `The last segment was full, so this record starts a new one. ` : ``) +
      `No record already in the log is moved or rewritten, which is why this is one sequential write.`,
    { probe },
  );

  rec.line('done');
  const list = earlier.length > 1 ? `${earlier.slice(0, -1).join(', ')} and ${earlier[earlier.length - 1]}` : String(earlier[0]);
  rec.step(
    `${key} is stored at partition ${p}, offset ${offset}: 1 hash and 1 write, whatever the length of the log. ` +
      (earlier.length
        ? `It sits after the earlier ${key} at ${earlier.length === 1 ? 'offset' : 'offsets'} ${list}, so a reader of this partition meets key ${key} in the order it was produced. `
        : `It is the only record with key ${key} in the log so far. `) +
      `No consumer was told: group A is ${behind(s, 'a', p)} here and group B is ${behind(s, 'b', p)}.`,
    { probe },
  );
  return { partition: p, offset };
}

function behind(s: LogState, g: GroupId, p: number): string {
  const n = endOf(s.partitions[p]) - s.groups[g].position[p];
  return n === 0 ? 'caught up' : `${plural(n, 'record')} behind`;
}

/** Read the record at a group's position in one partition and move the position on. Nothing is committed. */
export function consume(s: LogState, group: number | string, partition: number | string, rec: Rec): number | null {
  const g = asGroup(group);
  const p = Number(partition);
  rec.line('check');
  if (!g) {
    rec.step(`There are two consumer groups on this page, A and B. Enter a or b as the group.`);
    return null;
  }
  if (!validPartition(s, p)) {
    rec.step(`This topic has partitions 0 to ${s.partitions.length - 1}. There is no partition ${partition} to read from.`);
    return null;
  }
  const grp = s.groups[g];
  const part = s.partitions[p];
  const pos = grp.position[p];
  const end = endOf(part);
  const slot = oid(p, pos);

  if (pos >= end) {
    rec.mark(slot, 'compare');
    rec.compare(`${name(g)} pos ${pos}`, '=', `end ${end}`, 'nothing new to read', {
      message: `Group ${name(g)} asks partition ${p} for the record at its position, offset ${pos}. That is the end of the log: nothing has been appended there yet.`,
    });
    rec.mark(slot, 'bad');
    rec.line('caught_up');
    rec.step(
      `Group ${name(g)} is caught up on partition ${p}, so nothing is read. A real consumer waits here: its fetch stays open until a record arrives or a timeout passes.`,
    );
    return null;
  }

  rec.mark(slot, 'compare');
  rec.compare(`${name(g)} pos ${pos}`, '<', `end ${end}`, 'a record is waiting', {
    message: `Group ${name(g)} asks partition ${p} for the record at its position, offset ${pos}. The log ends at offset ${end}, so there is a record to read.`,
  });

  const key = part.records[pos - part.start];
  const probe = probeAt(key, p, pos);
  const again = pos < grp.seen[p];
  rec.count('reads');
  if (again) rec.count('redelivered');
  rec.mark(slot, 'key');
  rec.line('read');
  rec.step(
    `Read offset ${pos}: key ${key}. The record is copied to the consumer and stays in the log. Reading deletes nothing, so group ${name(other(g))} can read the same record whenever it gets here.` +
      (again ? ` Group ${name(g)} read this record once already, before it crashed. This is the repeat that at-least-once delivery allows.` : ``),
    { probe },
  );

  grp.position[p] = pos + 1;
  grp.seen[p] = Math.max(grp.seen[p], pos + 1);
  const open = grp.position[p] - grp.committed[p];
  rec.line('advance');
  rec.step(
    `Move ${name(g)}'s position to ${pos + 1}. That number lives only in the consumer's memory. Its committed offset here is still ${grp.committed[p]}, so a crash now would deliver ${open === 1 ? 'this record' : `the last ${open} records`} again. 1 record read, none removed.`,
    { probe },
  );
  return key;
}

/** Save a group's position on every partition. Returns how many committed offsets moved. */
export function commit(s: LogState, group: number | string, rec: Rec): number {
  const g = asGroup(group);
  rec.line('each');
  if (!g) {
    rec.step(`There are two consumer groups on this page, A and B. Enter a or b as the group.`);
    return 0;
  }
  const grp = s.groups[g];
  rec.step(
    `Commit for group ${name(g)}: save its position on each partition, so a restart knows where to carry on. Kafka stores a commit as a record in an internal topic, __consumer_offsets, so it is itself an append to a log.`,
  );
  let moved = 0;
  let records = 0;
  for (let p = 0; p < s.partitions.length; p++) {
    const c = grp.committed[p];
    const pos = grp.position[p];
    rec.line('ahead');
    if (c < pos) {
      rec.compare(`${name(g)} commit ${c}`, '<', `pos ${pos}`, `save ${pos}`, {
        message: `Partition ${p}: the committed offset is ${c} and the position is ${pos}. ${plural(pos - c, 'record has', 'records have')} been read but not saved.`,
      });
      grp.committed[p] = pos;
      moved++;
      records += pos - c;
      rec.line('save');
      rec.step(`Partition ${p}: the committed offset moves to ${pos}. Records below offset ${pos} will not be handed to group ${name(g)} again, whatever happens to its consumer.`);
    } else {
      rec.compare(`${name(g)} commit ${c}`, '=', `pos ${pos}`, 'nothing new to save', {
        message: `Partition ${p}: the committed offset already equals the position, ${pos}. Nothing new to save.`,
      });
    }
  }
  rec.line('done');
  rec.step(
    moved
      ? `Group ${name(g)} committed ${plural(records, 'record')} on ${plural(moved, 'partition')}. Committing after the work is done, as here, gives at-least-once delivery. Commit before the work and a crash loses records where this order would repeat them: at-most-once.`
      : `Group ${name(g)} had nothing to commit: every committed offset already matched its position.`,
  );
  return moved;
}

/** The group's consumer dies and restarts from its committed offsets. Returns how many records it will read again. */
export function crash(s: LogState, group: number | string, rec: Rec): number {
  const g = asGroup(group);
  rec.line('each');
  if (!g) {
    rec.step(`There are two consumer groups on this page, A and B. Enter a or b as the group.`);
    return 0;
  }
  const grp = s.groups[g];
  rec.step(
    `Group ${name(g)}'s consumer crashes and restarts. Its positions were only in its memory, so they are gone. The committed offsets are kept by the broker and survive.`,
  );
  let again = 0;
  for (let p = 0; p < s.partitions.length; p++) {
    const c = grp.committed[p];
    const pos = grp.position[p];
    const n = pos - c;
    again += n;
    grp.position[p] = c;
    if (n === 0) continue;
    for (let o = c; o < pos; o++) rec.mark(oid(p, o), 'path');
    rec.line('rewind');
    rec.step(
      `Partition ${p}: the position falls back from ${pos} to the committed offset, ${c}. ` +
        (n === 1 ? `The record at offset ${c} was read but never committed, so it will be delivered again.` : `The ${n} records at offsets ${c} to ${pos - 1} were read but never committed, so they will be delivered again.`),
    );
  }
  rec.line('done');
  rec.step(
    again
      ? `Group ${name(g)} resumes from its committed offsets and will read ${plural(again, 'record')} a second time. This is at-least-once delivery: nothing is lost, but work can repeat. The consumer must be idempotent, meaning that handling a record twice leaves the same result as handling it once.`
      : `Group ${name(g)} resumes exactly where it stopped. Every position was already committed, so nothing will be read twice.`,
  );
  return again;
}

/** Retention drops the oldest segment of a partition. Returns how many unread records the groups were moved past. */
export function trim(s: LogState, partition: number | string, rec: Rec): number {
  const p = Number(partition);
  rec.line('oldest');
  if (!validPartition(s, p)) {
    rec.step(`This topic has partitions 0 to ${s.partitions.length - 1}. There is no partition ${partition} to trim.`);
    return 0;
  }
  const part = s.partitions[p];
  if (part.records.length < SEGMENT) {
    rec.line('oldest', 'keep');
    rec.step(
      `Partition ${p} has no full segment. Retention deletes whole segments only, and never the one still being written, so nothing is dropped.`,
    );
    return 0;
  }
  const first = part.start;
  for (let o = first; o < first + SEGMENT; o++) rec.mark(oid(p, o), 'bad');
  rec.step(
    `Retention runs on partition ${p}. Its oldest segment, offsets ${first} to ${first + SEGMENT - 1}, is past the limit. The limit is an age or a total size (Kafka keeps seven days by default). Whether anyone has read the records plays no part.`,
  );

  part.records.splice(0, SEGMENT);
  part.start += SEGMENT;
  const start = part.start;
  rec.line('drop');
  rec.step(
    `The whole segment is deleted at once. On disk it is one file, so no other record is touched. The log now starts at offset ${start}. Offsets are never reused: the next record here still gets offset ${endOf(part)}.`,
  );

  let skipped = 0;
  const lost: string[] = [];
  for (const g of GROUPS) {
    const grp = s.groups[g];
    const pos = grp.position[p];
    rec.line('behind');
    if (pos < start) {
      const n = start - pos;
      rec.compare(`${name(g)} pos ${pos}`, '<', `start ${start}`, `behind: ${plural(n, 'record')} gone`, {
        message: `Group ${name(g)}'s position is ${pos}, an offset that no longer exists. ${plural(n, 'record was', 'records were')} deleted before group ${name(g)} got to ${n === 1 ? 'it' : 'them'}.`,
      });
      grp.position[p] = start;
      grp.committed[p] = start;
      grp.seen[p] = Math.max(grp.seen[p], start);
      skipped += n;
      rec.count('skipped', n);
      lost.push(`group ${name(g)} missed ${n}`);
      rec.line('reset');
      rec.step(
        `Group ${name(g)} is moved up to the new start, offset ${start}, and carries on from there. In Kafka the consumer finds out on its next fetch: the broker answers "offset out of range" and the consumer resets as its auto.offset.reset setting says. The skipped records are gone for good.`,
      );
    } else {
      rec.compare(`${name(g)} pos ${pos}`, '≥', `start ${start}`, 'not affected', {
        message: `Group ${name(g)}'s position is ${pos}, at or past the new start. It had already read the deleted records and notices nothing.`,
      });
      if (grp.committed[p] < start) {
        const c = grp.committed[p];
        grp.committed[p] = start;
        rec.line('stale');
        rec.step(
          `Group ${name(g)}'s committed offset, ${c}, pointed into the deleted segment, so it moves up to ${start}. The records it had read but not committed can no longer be replayed after a crash.`,
        );
      }
    }
  }
  const last = endOf(part) - 1;
  const kept =
    part.records.length === 0
      ? `Partition ${p} is now empty, and its next record will still get offset ${start}`
      : part.records.length === 1
        ? `Partition ${p} now keeps only offset ${start}`
        : `Partition ${p} now keeps offsets ${start} to ${last}`;
  rec.line('done');
  rec.step(
    kept +
      `. ${SEGMENT} records dropped by deleting 1 file. ` +
      (lost.length
        ? `A slow reader pays for it: ${lost.join(' and ')}. Size retention to cover the longest outage a consumer must survive, and alert on consumer lag.`
        : `Both groups had already read them, so no reader lost anything.`),
  );
  return skipped;
}

// ---- layout -----------------------------------------------------------------

/** A slot is wide enough for a group's two tags to sit side by side under it. */
const CELL_W = 114;
const COMMIT_W = 66;
const POS_W = 45;
const HEAD_W = 44;
/** A segment is drawn as a tray behind its records. */
const TRAY_PAD = 4;
const SEG_W = TRAY_PAD * 2 + CELL_GAP + CELL_W * 2;
const SEG_PITCH = SEG_W + 6;
const X0 = HEAD_W + 14;
/** Centre of each group's row of tags, below the offsets under the cells. */
const TAG_Y: Record<GroupId, number> = {
  a: CELL_H / 2 + SUB_ROOM + 2 + TAG_H / 2,
  b: CELL_H / 2 + SUB_ROOM + 2 + TAG_H / 2 + TAG_H + 2,
};
const ROW_BOTTOM = TAG_Y.b + TAG_H / 2;
/** Cells, offsets, two rows of tags, then room for the probe chip above the next partition. */
export const ROW_H = ROW_BOTTOM + PROBE_H + 12 + CELL_H / 2;
const LABEL_X = HEAD_W;
const LEFT = LABEL_X - 62;
const RIGHT = X0 + MAX_SEGMENTS * SEG_PITCH + TRAY_PAD + CELL_W;
const TOP = -(CELL_H / 2 + PROBE_H + 16);

/** Centre of the slot `index` places after the start of a partition. */
function slotX(index: number): number {
  return X0 + Math.floor(index / SEGMENT) * SEG_PITCH + TRAY_PAD + (index % SEGMENT) * (CELL_W + CELL_GAP) + CELL_W / 2;
}

export function layout(s: LogState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  s.partitions.forEach((part, p) => {
    const y = p * ROW_H;
    const count = part.records.length;
    nodes.push({ id: hid(p), x: HEAD_W / 2, y, cells: [{ text: `P${p}`, w: HEAD_W }] });

    // A tray for every segment that holds a record. The slot at the end of the log sits outside
    // the trays until a record starts the next segment.
    for (let i = 0; i < count; i += SEGMENT) {
      decor.push({ id: bid(p, (part.start + i) / SEGMENT), type: 'band', x: X0 + (i / SEGMENT) * SEG_PITCH, y: y - CELL_H / 2 - TRAY_PAD, w: SEG_W, h: CELL_H + TRAY_PAD * 2 });
    }
    // One slot per record, and an empty one for the offset the next record will take.
    for (let i = 0; i <= count; i++) {
      nodes.push({ id: oid(p, part.start + i), x: slotX(i), y, cells: [{ text: i < count ? String(part.records[i]) : '', sub: String(part.start + i), w: CELL_W }] });
    }

    for (const g of GROUPS) {
      const grp = s.groups[g];
      // Never drawn before the start of the log, even in the moment between a trim and the reset that follows it.
      const at = (offset: number) => slotX(Math.max(offset, part.start) - part.start);
      const ty = y + TAG_Y[g];
      nodes.push({ id: tid(p, g, 'commit'), x: at(grp.committed[p]) - CELL_W / 2 + COMMIT_W / 2, y: ty, cells: [{ text: 'commit', w: COMMIT_W }], shape: 'tag' });
      nodes.push({ id: tid(p, g, 'pos'), x: at(grp.position[p]) + CELL_W / 2 - POS_W / 2, y: ty, cells: [{ text: 'pos', w: POS_W }], shape: 'tag' });
      decor.push({ id: `row${p}${g}`, type: 'label', x: LABEL_X, y: ty + 5, text: `group ${name(g)}`, anchor: 'end' });
    }
  });
  // Two empty labels pin the corners, so the scene keeps its size as partitions fill and empty.
  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: (s.partitions.length - 1) * ROW_H + ROW_BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;
const GROUP = { name: 'group', label: 'Group (a or b)', kind: 'word' } as const;
const PARTITION = { name: 'partition', label: 'Partition', kind: 'int', min: 0, max: 3 } as const;

/** The keys the seed and the tour use. Think of each as the id of a host. */
export const SEED_KEYS = [42, 6, 16, 8, 21, 7, 6];
export const TOUR_KEY = 42;
export const TOUR_OTHER = 16;

const hasRoom = (s: LogState, key: number) => s.partitions[partitionOf(key, s.partitions.length)].records.length < s.maxRecords;

/** Half the time a key that is already in the log, to show records with one key lining up; otherwise a new one. */
function suggestKey(s: LogState): number {
  const present = [...new Set(s.partitions.flatMap((part) => part.records))].filter((k) => hasRoom(s, k));
  if (present.length && randomInt(0, 1) === 0) return present[randomInt(0, present.length - 1)];
  for (let i = 0; i < 60; i++) {
    const k = randomInt(1, 99);
    if (hasRoom(s, k)) return k;
  }
  return randomInt(1, 99);
}

/** A group and partition with something to read, if there is one. */
function suggestConsume(s: LogState): [GroupId, number] {
  const waiting: [GroupId, number][] = [];
  for (const g of GROUPS) s.partitions.forEach((part, p) => void (s.groups[g].position[p] < endOf(part) && waiting.push([g, p])));
  return waiting.length ? waiting[randomInt(0, waiting.length - 1)] : ['a', 0];
}

/** A group with reads it has not committed, if there is one. */
function suggestGroup(s: LogState): GroupId {
  const open = GROUPS.filter((g) => uncommitted(s, g) > 0);
  return open.length ? open[randomInt(0, open.length - 1)] : 'a';
}

/** A partition with a full segment, and for preference one where a group is still behind it. */
function suggestTrim(s: LogState): number {
  const full = s.partitions.map((_part, p) => p).filter((p) => s.partitions[p].records.length >= SEGMENT);
  const behindIt = full.filter((p) => GROUPS.some((g) => s.groups[g].position[p] < s.partitions[p].start + SEGMENT));
  const from = behindIt.length ? behindIt : full;
  return from.length ? from[randomInt(0, from.length - 1)] : 0;
}

const def: StructureDef<LogState> = {
  id: 'append-log',
  params: [
    {
      id: 'partitions',
      label: 'Partitions',
      default: 3,
      options: [2, 3, 4].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  create: (params) => create(params.partitions ?? 3),
  // Group A has read and committed most of the log. Group B has barely started, which is what Trim is there to show.
  seed: [
    ...SEED_KEYS.map((k) => ['produce', k] as [string, number]),
    ['consume', 'a', 0],
    ['consume', 'a', 0],
    ['consume', 'a', 1],
    ['consume', 'a', 1],
    ['consume', 'a', 2],
    ['commit', 'a'],
    ['consume', 'b', 1],
    ['commit', 'b'],
  ],
  ops: [
    { id: 'produce', label: 'Produce', intent: 'primary', args: [KEY], code: ['produce', 'hash', 'end'], run: (s, [k], rec) => void produce(s, Number(k), rec), suggest: (s) => [suggestKey(s)] },
    { id: 'consume', label: 'Consume', args: [GROUP, PARTITION], code: ['consume', 'end'], run: (s, [g, p], rec) => void consume(s, g, p, rec), suggest: (s) => suggestConsume(s) },
    { id: 'commit', label: 'Commit', args: [GROUP], code: ['commit'], run: (s, [g], rec) => void commit(s, g, rec), suggest: (s) => [suggestGroup(s)] },
    { id: 'crash', label: 'Crash', intent: 'danger', args: [GROUP], code: ['crash'], run: (s, [g], rec) => void crash(s, g, rec), suggest: (s) => [suggestGroup(s)] },
    { id: 'trim', label: 'Trim', intent: 'danger', args: [PARTITION], code: ['trim'], run: (s, [p], rec) => void trim(s, p, rec), suggest: (s) => [suggestTrim(s)] },
  ],
  layout,
  counters: [
    { key: 'writes', label: 'Records appended' },
    { key: 'reads', label: 'Records read' },
    { key: 'redelivered', label: 'Read a second time' },
    { key: 'skipped', label: 'Skipped by retention' },
  ],
  status: (s) => [
    { label: 'Records kept', value: String(s.partitions.reduce((sum, part) => sum + part.records.length, 0)) },
    { label: 'Next offsets', value: s.partitions.map((part) => endOf(part)).join(', ') },
    { label: 'Group A', value: `${lag(s, 'a')} behind, ${uncommitted(s, 'a')} uncommitted` },
    { label: 'Group B', value: `${lag(s, 'b')} behind, ${uncommitted(s, 'b')} uncommitted` },
  ],
  tour: [
    ['produce', TOUR_KEY],
    ['produce', TOUR_OTHER],
    ['produce', TOUR_KEY],
    ['consume', 'a', 0],
    ['commit', 'a'],
    ['consume', 'a', 0],
    ['crash', 'a'],
    ['consume', 'a', 0],
    ['produce', TOUR_KEY],
  ],
  // A full partition refuses the record, so fill can never overfill the canvas.
  fill: (s) => ['produce', suggestKey(s)],
  source: { python, java },
  info,
};

export default def;
