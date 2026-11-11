import { LABEL_MAX, PROBE_H, SUB_ROOM, CAPTION_ROOM, TITLE_ROOM } from '../../core/fit';
import { CELL_GAP, CELL_H, TRAY_PAD, cellsWidth } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Cell, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/MapReduce.java?raw';
import python from './code/mapreduce.py?raw';
import { info } from './info';

/**
 * A MapReduce job, small enough to draw: nine click events in three HDFS
 * blocks, a users table of three rows, one map task per block and two or
 * three reduce tasks. Everything runs in one process and in lock step. A real
 * cluster runs the map tasks at the same time on the machines that hold the
 * blocks, and starts copying map output to reducers as soon as a map task
 * finishes.
 *
 * A click is just the id of the user who clicked. A pair or record is one
 * cell; the one being followed is magenta.
 */
export type Kind = 'one' | 'click' | 'user' | 'total' | 'joined';

export interface Pair {
  /** The record's identity, kept as it is copied from mapper to reducer. */
  id: string;
  kind: Kind;
  /** User id. */
  key: number;
  /** Country for user rows and joined rows, the total for totals. */
  value: string;
  /** Reducer, or -1 before the partitioner has run. */
  part: number;
  /** Map task that emitted it: 0 to 2 for the click blocks, 3 for the users table. */
  from: number;
  /** Already copied to its reducer. Map output stays on the mapper's local disk until the job ends. */
  fetched: boolean;
  tone?: Tone;
}

export type Job = 'none' | 'count' | 'join' | 'broadcast' | 'skew';

export interface MRState {
  reducers: number;
  /** The user id of each click, one array per HDFS block. */
  blocks: number[][];
  /** The users table: user id and country. */
  users: [number, string][];
  /** The hot user when the input is skewed. */
  hot: number | null;
  job: Job;
  stage: 'idle' | 'map' | 'shuffle' | 'reduced';
  /** Output of each map task: three click mappers, then the users mapper of a join. */
  maps: Pair[][];
  /** What each reducer holds: its merged input, then its output. */
  reds: Pair[][];
  /** Output files of a map-only job. */
  outs: Pair[][];
  /** Pairs each reducer received in the last job that shuffled. */
  loads: number[];
  /** Id of the record being followed. */
  follow: string | null;
}

export const EVEN: number[][] = [[2, 5, 1], [4, 2, 6], [1, 4, 2]];
export const USERS: [number, string][] = [[1, 'UK'], [2, 'FR'], [4, 'IT']];
export const MAX_USER = 6;
export const PRIME = 1009;
export const BLOCKS = 3;

/** Small enough to check by hand. Hadoop's HashPartitioner uses the key's hashCode(). */
export function hashKey(key: number): number {
  return (31 * key + 7) % PRIME;
}

export function partitionOf(key: number, reducers: number): number {
  return hashKey(key) % reducers;
}

/** One user makes 7 of the 9 clicks. */
export function hotInput(hot: number): number[][] {
  const [a, b] = [2, 5, 4].filter((u) => u !== hot).slice(0, 2);
  return [[hot, hot, a], [hot, hot, hot], [b, hot, hot]];
}

export function create(reducers = 2): MRState {
  return {
    reducers,
    blocks: EVEN.map((b) => [...b]),
    users: USERS.map(([k, c]) => [k, c] as [number, string]),
    hot: null,
    job: 'none',
    stage: 'idle',
    maps: [[], [], [], []],
    reds: Array.from({ length: reducers }, () => []),
    outs: [[], [], []],
    loads: [],
    follow: null,
  };
}

// ---- small helpers ------------------------------------------------------------

export const who = (k: number) => `u${k}`;
const tag = (p: Pair) => (p.kind === 'user' ? 0 : 1);
export function text(p: Pair): string {
  switch (p.kind) {
    case 'one':
      return `${who(p.key)} 1`;
    case 'click':
      return `${who(p.key)} c`;
    case 'total':
      return `${who(p.key)}=${p.value}`;
    default:
      return `${who(p.key)} ${p.value}`;
  }
}
/** Sort order inside one reducer's share: by key, and a user row before the clicks of that user. */
const less = (a: Pair, b: Pair) => a.key < b.key || (a.key === b.key && tag(a) < tag(b));
const same = (a: Pair, b: Pair) => a.key === b.key && tag(a) === tag(b);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const bid = (b: number) => `b${b}`;
export const USERS_ID = 'users';
export const mid = (i: number) => `m${i}`;
export const rid = (j: number) => `r${j}`;
export const oid = (i: number) => `o${i}`;

export function clicks(s: MRState): number {
  return s.blocks.reduce((n, b) => n + b.length, 0);
}

/** The first click by this user, in block order. */
export function findClick(s: MRState, user: number): { b: number; i: number } | null {
  for (let b = 0; b < s.blocks.length; b++) {
    const i = s.blocks[b].indexOf(user);
    if (i >= 0) return { b, i };
  }
  return null;
}

const clickId = (b: number, i: number) => `c${b}${i}`;

/** Where a record is drawn now: its live copy in a mapper, a reducer or an output file. */
function locate(s: MRState, id: string): { at: string; cell: number } | null {
  const groups: [Pair[][], (i: number) => string][] = [
    [s.reds, rid],
    [s.outs, oid],
    [s.maps, mid],
  ];
  for (const [rows, name] of groups) {
    for (let n = 0; n < rows.length; n++) {
      const cell = rows[n].findIndex((p) => p.id === id && !p.fetched);
      if (cell >= 0) return { at: name(n), cell };
    }
  }
  return null;
}

function begin(s: MRState, job: Job): void {
  s.job = job;
  s.stage = job === 'none' ? 'idle' : 'map';
  s.maps = [[], [], [], []];
  s.reds = Array.from({ length: s.reducers }, () => []);
  s.outs = [[], [], []];
  s.loads = [];
  s.follow = null;
}

/** The step for a user with no clicks: nothing to follow, and nothing changes. */
function noClicks(s: MRState, user: number, rec: Rec): void {
  const present = [...new Set(s.blocks.flat())].sort((a, b) => a - b).map(who);
  rec.line('job');
  rec.step(`${who(user)} made no clicks in this input, so there is no record of theirs to follow. Users with clicks: ${list(present)}.`);
}

/** Each map task reads its block and emits one pair per click. */
function mapClicks(s: MRState, kind: 'one' | 'click', rec: Rec): void {
  s.blocks.forEach((block, b) => {
    s.maps[b] = block.map((key, i) => ({ id: clickId(b, i), kind, key, value: kind === 'one' ? '1' : '', part: -1, from: b, fetched: false }));
    rec.count('reads', block.length);
  });
}

/** Partition every pair. Only the followed one is shown; the rest are counted. Returns its reducer. */
function partitionAll(s: MRState, name: string, rec: Rec, chip: () => Probe, extra = ''): number {
  let followed: Pair | null = null;
  let others = 0;
  for (const run of s.maps) {
    for (const p of run) {
      p.part = partitionOf(p.key, s.reducers);
      if (p.id === s.follow) followed = p;
      else {
        others++;
        rec.count('comparisons');
      }
    }
  }
  const p = followed!;
  const h = hashKey(p.key);
  rec.compare(`h(${name}) mod ${s.reducers}`, '=', `R${p.part}`, `send to reducer ${p.part}`, {
    probe: chip(),
    message:
      `h(${name}) = (31 × ${p.key} + 7) mod ${PRIME} = ${h}, and ${h} mod ${s.reducers} = ${p.part}. ` +
      `Every ${name} pair, from every map task, gets the same answer, so they all meet at reducer ${p.part}. ` +
      extra +
      `The other ${others} pairs are routed the same way: see the R under each cell.`,
  });
  return p.part;
}

/** Sort each map task's output by reducer, then by key (a user row before clicks). Stable. */
function sortMaps(s: MRState): void {
  for (const run of s.maps) run.sort((a, b) => a.part - b.part || a.key - b.key || tag(a) - tag(b));
}

/**
 * One reducer fetches its share of every map task's sorted output and merges
 * the runs by repeatedly taking the smallest head. With `show` on, every
 * comparison is a frame until the followed record has been taken.
 */
function mergeReducer(s: MRState, r: number, rec: Rec, chip: () => Probe, show: boolean): number {
  const runs = s.maps.map((run) => run.filter((p) => p.part === r));
  const ptr = runs.map(() => 0);
  let live = show;
  let comps = 0;
  let took: string[] = [];
  const lead = () => {
    const t = took.length ? `Took ${list(took)}. ` : '';
    took = [];
    return t;
  };
  for (;;) {
    let best = -1;
    for (let i = 0; i < runs.length; i++) {
      if (ptr[i] >= runs[i].length) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const a = runs[i][ptr[i]];
      const b = runs[best][ptr[best]];
      const lt = less(a, b);
      comps++;
      if (live) {
        a.tone = 'compare';
        b.tone = 'compare';
        const eq = same(a, b);
        rec.line(...(lt ? ['cmp', 'new_best'] : ['cmp']));
        const verdict = lt ? `M${a.from} has the smaller head` : eq ? `tie, keep M${b.from}, the earlier run` : `keep M${b.from}`;
        const why = lt
          ? a.key === b.key
            ? `Same user, but a user row is tagged 0 and a click 1, so ${text(a)} sorts first.`
            : `${who(a.key)} comes before ${who(b.key)}.`
          : eq
            ? `Equal, so the earlier run keeps it. Any order of equal records would do.`
            : a.key === b.key
              ? `Same user, but the user row ${text(b)} is tagged 0 and sorts first.`
              : `${who(b.key)} comes before ${who(a.key)}.`;
        rec.compare(`M${a.from}: ${text(a)}`, lt ? '<' : eq ? '=' : '>', `M${b.from}: ${text(b)}`, verdict, {
          probe: chip(),
          message: `${lead()}Reducer ${r} compares the head of M${a.from}'s run, ${text(a)}, with the smallest head so far, M${b.from}'s ${text(b)}. ${why}`,
        });
        a.tone = undefined;
        b.tone = undefined;
      } else rec.count('comparisons');
      if (lt) best = i;
    }
    if (best < 0) break;
    const p = runs[best][ptr[best]++];
    p.fetched = true;
    s.reds[r].push({ ...p, fetched: false, tone: undefined });
    rec.count('shuffled');
    if (live) {
      if (p.id === s.follow) {
        rec.line('take');
        rec.step(
          `${lead()}Take ${text(p)} from M${p.from}, the followed record: it is the smallest head left. It has crossed the network from map task ${p.from} to reducer ${r}. In the mapper it is greyed out: the copy there stays on local disk until the job ends.`,
          { probe: chip() },
        );
        live = false;
      } else took.push(`${text(p)} from M${p.from}`);
    }
  }
  return comps;
}

/** The shuffle: every reducer fetches and merges its share. The followed record's reducer is shown first and in full. */
function shuffle(s: MRState, target: number, rec: Rec, chip: () => Probe, why: string): void {
  s.stage = 'shuffle';
  rec.line('fetch');
  rec.step(
    `Shuffle. Reducer ${target} fetches the pairs marked R${target} from every map task, and each other reducer does the same for its own. Every mapper sends to every reducer, over the network. ${why}`,
    { probe: chip() },
  );
  const order = [target, ...Array.from({ length: s.reducers }, (_, j) => j).filter((j) => j !== target)];
  let mine = 0;
  let rest = 0;
  for (const r of order) {
    const c = mergeReducer(s, r, rec, chip, r === target);
    if (r === target) mine = c;
    else rest += c;
  }
  s.loads = s.reds.map((red) => red.length);
  const others = order.slice(1);
  rec.line('merged');
  rec.step(
    `Reducer ${target} has merged all ${plural(s.reds[target].length, 'record')} into one sorted list with ${plural(mine, 'comparison')}. ` +
      (others.length === 1 ? `Reducer ${others[0]} merged its ${s.reds[others[0]].length}` : `Reducers ${list(others.map(String))} merged theirs`) +
      ` the same way, with ${plural(rest, 'comparison')}. Merging sorted runs needs only the head of each run in memory, which is why the map side sorts.`,
    { probe: chip() },
  );
}

// ---- operations ---------------------------------------------------------------

/** Word count, with users as the words: clicks per user. Returns the followed user's total, or null. */
export function count(s: MRState, user: number, rec: Rec): number | null {
  const at = findClick(s, user);
  if (!at) {
    noClicks(s, user, rec);
    return null;
  }
  const name = who(user);
  begin(s, 'count');
  const chip = (): Probe => {
    const w = locate(s, s.follow!);
    return w ? { text: name, ...w } : { text: name, at: bid(at.b), cell: at.i };
  };
  rec.markCell(bid(at.b), at.i, 'key');
  rec.line('job');
  rec.step(
    `Count clicks per user. The input is ${plural(clicks(s), 'click')} in ${BLOCKS} HDFS blocks, so the job runs ${BLOCKS} map tasks, one per block, and ${s.reducers} reduce tasks. Follow the click by ${name} in block ${at.b}.`,
    { probe: chip() },
  );

  mapClicks(s, 'one', rec);
  s.follow = clickId(at.b, at.i);
  rec.markCell(bid(at.b), at.i, 'path');
  rec.line('read', 'emit');
  rec.step(
    `Map. Each map task reads its own block, on a machine that holds a copy, so the input does not cross the network. It turns every click into the pair (user, 1). Map ${at.b} emits (${name}, 1).`,
    { probe: chip() },
  );

  rec.line('emit', 'hash', 'partition');
  const target = partitionAll(s, name, rec, chip);

  sortMaps(s);
  rec.line('sort');
  rec.step(
    `Each map task sorts its pairs by reducer, then by key, and writes them to its own local disk, not to HDFS. They are temporary: if a mapper dies, its task is simply run again.`,
    { probe: chip() },
  );

  shuffle(s, target, rec, chip, `This is the expensive part of a job: all ${plural(clicks(s), 'pair')} are written to disk, sent and merged.`);

  // Reduce: one pass over each merged list, adding while the key stays the same.
  rec.line('group');
  rec.step(
    `Reduce. Each reducer walks its merged list once. Equal keys sit next to each other, so a running total only needs the key before it: no hash table, and memory stays small however large the input.`,
    { probe: chip() },
  );
  const results: Pair[][] = [];
  for (let r = 0; r < s.reducers; r++) {
    const totals: Pair[] = [];
    for (const p of s.reds[r]) {
      const last = totals[totals.length - 1];
      const shown = r === target && p.key === user;
      if (last) {
        const eq = last.key === p.key;
        if (shown) {
          p.tone = 'compare';
          rec.line('same', eq ? 'sum' : 'new_key');
          rec.compare(`key ${who(p.key)}`, eq ? '=' : '≠', `last ${who(last.key)}`, eq ? `add 1, ${name} is now ${Number(last.value) + 1}` : `start a total for ${name}`, {
            probe: chip(),
            message: eq
              ? `The next pair is ${text(p)}, the same key as the last one, so add its 1: ${name} has ${Number(last.value) + 1} so far.`
              : `The next pair is ${text(p)}. The key before it was ${who(last.key)}, so ${who(last.key)}'s total is final, and ${name} starts at 1.`,
          });
          p.tone = 'path';
        } else rec.count('comparisons');
        if (eq) {
          last.value = String(Number(last.value) + 1);
          continue;
        }
      } else if (shown) {
        p.tone = 'path';
        rec.line('new_key');
        rec.step(`${text(p)} is the first pair in reducer ${r}'s list, so there is nothing to compare it with: ${name} starts at 1.`, { probe: chip() });
      }
      totals.push({ id: `t${p.key}`, kind: 'total', key: p.key, value: '1', part: r, from: -1, fetched: false });
    }
    results.push(totals);
  }
  s.reds = results;
  s.stage = 'reduced';
  for (const red of s.reds) for (const t of red) t.tone = 'ok';
  const written = s.reds.reduce((n, red) => n + red.length, 0);
  rec.count('written', written);
  const mineTotal = s.reds[target].find((t) => t.key === user)!;
  s.follow = mineTotal.id;
  const files = Array.from({ length: s.reducers }, (_, j) => `part-r-0000${j}`);
  rec.line('write');
  rec.step(
    `Done: ${name} made ${plural(Number(mineTotal.value), 'click')}. Each reducer writes its totals to HDFS as one file (${list(files)}), ${written} totals in all. The job read ${plural(clicks(s), 'record')} and sent ${clicks(s)} pairs across the network. A combiner, summing on the map side first, would have sent fewer.`,
    { probe: chip() },
  );
  s.follow = null;
  return Number(mineTotal.value);
}

/** Reduce-side join of clicks with users. Returns the followed click's joined row, or null when it has no user row. */
export function join(s: MRState, user: number, rec: Rec): string | null {
  const at = findClick(s, user);
  if (!at) {
    noClicks(s, user, rec);
    return null;
  }
  const name = who(user);
  const row = s.users.find(([k]) => k === user);
  begin(s, 'join');
  const chip = (): Probe => {
    const w = locate(s, s.follow!);
    return w ? { text: name, ...w } : { text: name, at: bid(at.b), cell: at.i };
  };
  rec.markCell(bid(at.b), at.i, 'key');
  rec.line('job');
  rec.step(
    `Sort-merge join: attach each user's country to their clicks. Both inputs are large in principle, so neither is held in memory. The clicks are ${BLOCKS} blocks and the users table is one more, so ${BLOCKS + 1} map tasks. Follow the click by ${name} in block ${at.b}.`,
    { probe: chip() },
  );

  mapClicks(s, 'click', rec);
  s.maps[3] = s.users.map(([key, value]) => ({ id: `u${key}`, kind: 'user' as Kind, key, value, part: -1, from: 3, fetched: false }));
  rec.count('reads', s.users.length);
  s.follow = clickId(at.b, at.i);
  rec.markCell(bid(at.b), at.i, 'path');
  rec.line('read', 'emit', 'emit_user');
  rec.step(
    `Map. Both datasets are keyed by user id. A click becomes (${name}, c), and a user row becomes (user, country) with a tag that makes it sort before that user's clicks. Map ${at.b} emits (${name}, c).`,
    { probe: chip() },
  );

  rec.line('emit', 'hash', 'partition');
  const target = partitionAll(
    s,
    name,
    rec,
    chip,
    row ? `The user row ${who(user)} ${row[1]} has the same key, so it goes to reducer ${partitionOf(user, s.reducers)} too. ` : `There is no user row for ${name} to meet it there. `,
  );

  sortMaps(s);
  rec.line('sort');
  rec.step(`Each map task sorts its output by reducer, then by user, with user rows first, and writes it to local disk.`, { probe: chip() });

  shuffle(s, target, rec, chip, `Clicks and user rows travel alike: ${plural(clicks(s) + s.users.length, 'record')} in all.`);

  rec.line('group');
  rec.step(
    `Reduce. Reducer ${target} walks its merged list once. Because of the tag, a user's row arrives just before that user's clicks, so the reducer remembers one country at a time: the join needs memory for one row, not a table.`,
    { probe: chip() },
  );
  const results: Pair[][] = [];
  let result: string | null = null;
  let dropped = 0;
  for (let r = 0; r < s.reducers; r++) {
    const out: Pair[] = [];
    let current: number | null = null;
    let country: string | null = null;
    for (const p of s.reds[r]) {
      const shown = r === target && p.key === user;
      if (p.key !== current) {
        current = p.key;
        country = null;
      }
      if (p.kind === 'user') {
        country = p.value;
        if (shown) {
          p.tone = 'compare';
          rec.line('user_first', 'remember');
          rec.compare(`${name} group starts`, '=', 'user row', `remember ${p.value}`, {
            probe: chip(),
            message: `${name}'s group starts with the user row ${text(p)}. Keep its country, ${p.value}, for the clicks that follow.`,
          });
          p.tone = 'path';
        } else rec.count('comparisons');
      } else if (country === null) {
        dropped++;
        if (shown) {
          p.tone = 'compare';
          rec.line('match', 'drop');
          rec.compare(`${name} country`, '=', 'none', 'no user row, drop the click', {
            probe: chip(),
            message: `${text(p)} is a click, and no user row came before it, so there is no country for ${name}. An inner join drops the click. A left outer join would keep it with an empty country.`,
          });
          p.tone = 'bad';
          if (p.id === s.follow) {
            // The record is gone from here on, so it is no longer drawn magenta.
            const cell = s.reds[r].indexOf(p);
            s.follow = null;
            rec.line('drop');
            rec.step(`${name}'s click is dropped. Nothing about it reaches the output file.`, { probe: { text: name, at: rid(r), cell } });
            s.follow = p.id;
          }
        } else rec.count('comparisons');
      } else {
        const j: Pair = { id: `j${p.id}`, kind: 'joined', key: p.key, value: country, part: r, from: -1, fetched: false };
        out.push(j);
        if (shown) {
          p.tone = 'compare';
          rec.line('match', 'joined');
          rec.compare(`${name} country`, '=', country, `emit ${text(j)}`, {
            probe: chip(),
            message: `${text(p)} is a click and the country in hand is ${country}, so emit the joined row ${text(j)}.`,
          });
          p.tone = 'ok';
          if (p.id === s.follow) result = text(j);
        } else rec.count('comparisons');
      }
    }
    results.push(out);
  }
  s.reds = results;
  s.stage = 'reduced';
  for (const red of s.reds) for (const t of red) t.tone = 'ok';
  const written = s.reds.reduce((n, red) => n + red.length, 0);
  rec.count('written', written);
  s.follow = result ? `j${s.follow}` : null;
  const moved = clicks(s) + s.users.length;
  rec.line('write');
  rec.step(
    (result ? `Done: the click became ${result}. ` : `Done: ${name}'s click is not in the output, because the users table has no row for ${name}. `) +
      `${written} joined rows written, ${plural(dropped, 'click')} without a user dropped. The join sent all ${moved} records across the network and sorted them, to bring 3 user rows next to their clicks.`,
    { probe: result ? chip() : { text: name, at: rid(target) } },
  );
  s.follow = null;
  return result;
}

/** Map-side join: every map task loads the users table into a hash table. Returns the followed click's joined row, or null. */
export function broadcast(s: MRState, user: number, rec: Rec): string | null {
  const at = findClick(s, user);
  if (!at) {
    noClicks(s, user, rec);
    return null;
  }
  const name = who(user);
  begin(s, 'broadcast');
  const atInput: Probe = { text: name, at: bid(at.b), cell: at.i };
  rec.markCell(bid(at.b), at.i, 'key');
  rec.line('job');
  rec.step(
    `Broadcast hash join: the same join, but the users table is small, ${plural(s.users.length, 'row')}. Send a copy of it to every map task instead of shuffling the clicks. Follow the click by ${name} in block ${at.b}.`,
    { probe: atInput },
  );

  rec.mark(USERS_ID, 'path');
  for (let b = 0; b < BLOCKS; b++) {
    s.maps[b] = s.users.map(([key, value]) => ({ id: `h${b}u${key}`, kind: 'user' as Kind, key, value, part: -1, from: b, fetched: false }));
    rec.count('reads', s.users.length);
  }
  rec.line('load');
  rec.step(
    `Each of the ${BLOCKS} map tasks reads the whole users table into an in-memory hash table before it reads a single click. The table is read ${BLOCKS} times, ${BLOCKS * s.users.length} rows, which is cheap while it is small.`,
    { probe: atInput },
  );

  let result: string | null = null;
  let dropped = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const table = new Map(s.users);
    s.blocks[b].forEach((key, i) => {
      rec.count('reads');
      const country = table.get(key);
      const followed = b === at.b && i === at.i;
      const cell = s.users.findIndex(([k]) => k === key);
      if (followed) {
        if (cell >= 0) s.maps[b][cell].tone = 'compare';
        rec.line('read', 'lookup');
        rec.compare(name, country ? '=' : '≠', country ? `row ${who(key)} ${country}` : 'any row', country ? `emit ${name} ${country}` : 'no match, drop the click', {
          probe: country ? { text: name, at: mid(b), cell } : atInput,
          message: country
            ? `Map ${b} reads ${name}'s click and looks ${name} up in its own copy of the table: one hash lookup, found, country ${country}.`
            : `Map ${b} reads ${name}'s click and looks ${name} up in its own copy of the table: one hash lookup, not there.`,
        });
        if (cell >= 0) s.maps[b][cell].tone = undefined;
      } else rec.count('comparisons');
      if (!country) {
        dropped++;
        if (followed) {
          rec.markCell(bid(b), i, 'bad');
          rec.line('drop');
          rec.step(`An inner join drops ${name}'s click: there is no user row for it. Nothing was sent anywhere to find that out.`, { probe: atInput });
        }
        return;
      }
      const j: Pair = { id: `j${clickId(b, i)}`, kind: 'joined', key, value: country, part: -1, from: b, fetched: false };
      s.outs[b].push(j);
      if (followed) {
        result = text(j);
        s.follow = j.id;
        rec.markCell(bid(b), i, 'path');
        rec.line('joined');
        rec.step(`Map ${b} writes ${text(j)} straight to its output. The click never left the machine it was read on.`, { probe: { text: name, at: oid(b), cell: s.outs[b].length - 1 } });
        s.follow = null;
      }
    });
  }
  s.stage = 'reduced';
  for (const out of s.outs) for (const t of out) t.tone = 'ok';
  const written = s.outs.reduce((n, out) => n + out.length, 0);
  rec.count('written', written);
  rec.unmark(USERS_ID);
  if (result) s.follow = `j${clickId(at.b, at.i)}`;
  const where = result ? locate(s, s.follow!) : null;
  rec.line('write');
  rec.step(
    `Done: the same ${written} joined rows as the sort-merge join, ${plural(dropped, 'click')} dropped. A map-only job: no shuffle, no sort, no reducers, 0 records sent between machines. Each mapper writes its own file, part-m-00000 to 00002. It only works while the small side fits in every mapper's memory.`,
    { probe: where ? { text: name, ...where } : atInput },
  );
  s.follow = null;
  return result;
}

/** Load a skewed input where one user makes 7 of the 9 clicks, and show where the pairs of a count land. Returns the loads. */
export function skew(s: MRState, hot: number, rec: Rec): number[] {
  s.blocks = hotInput(hot);
  s.hot = hot;
  begin(s, 'skew');
  const name = who(hot);
  const at = findClick(s, hot)!;
  const chip = (): Probe => {
    const w = locate(s, s.follow!);
    return w ? { text: name, ...w } : { text: name, at: bid(at.b), cell: at.i };
  };
  rec.markCell(bid(at.b), at.i, 'key');
  rec.line('hot');
  rec.step(
    `A skewed input: ${name} makes 7 of the 9 clicks. Real data often has keys like this: a crawler, a celebrity account, or an empty user id that every anonymous click shares. Run the count again and follow one of ${name}'s clicks.`,
    { probe: chip() },
  );

  mapClicks(s, 'one', rec);
  s.follow = clickId(at.b, at.i);
  rec.markCell(bid(at.b), at.i, 'path');
  rec.line('read', 'load_up', 'hash', 'partition');
  const target = partitionAll(s, name, rec, chip, `That includes all 7 of ${name}'s pairs. `);

  s.stage = 'shuffle';
  for (const run of s.maps) {
    for (const p of run) {
      p.fetched = true;
      s.reds[p.part].push({ ...p, fetched: false, tone: undefined });
      rec.count('shuffled');
    }
  }
  s.loads = s.reds.map((red) => red.length);
  rec.line('load_up');
  rec.step(
    `Shuffle. The pairs land at their reducers: ${s.loads.map((n, j) => `reducer ${j} gets ${n}`).join(', ')}. A key is never split, so all 7 of ${name}'s pairs pile up at reducer ${target}.`,
    { probe: chip() },
  );

  const total = clicks(s);
  const max = Math.max(...s.loads);
  const fair = total / s.reducers;
  const fairText = Number.isInteger(fair) ? String(fair) : fair.toFixed(1);
  const ratio = (max / fair).toFixed(1);
  rec.mark(rid(target), 'compare');
  rec.line('imbalance');
  rec.compare(`R${target} load ${max}`, '>', `fair share ${fairText}`, `${ratio} times its share`, {
    probe: chip(),
    message: `${total} pairs over ${s.reducers} reducers is ${fairText} each if the keys were even. Reducer ${target} has ${max}. A job ends when its slowest task ends, so reducer ${target} sets the finishing time while the others sit idle.`,
  });
  rec.unmark(rid(target));

  // With a combiner each map task would send one (user, n) pair per user it saw.
  const combined = s.maps.reduce((n, run) => n + new Set(run.filter((p) => p.part === target).map((p) => p.key)).size, 0);
  const tasks = s.blocks.filter((b) => b.includes(hot)).length;
  rec.line('imbalance');
  rec.step(
    `Fixes for a count. More reducers do not help: one key still goes to one reducer. A combiner sums on the map side, so reducer ${target} would get ${combined} pairs, not ${max}: one per user per map task, and ${name} is in ${tasks} blocks. ` +
      `Salting spreads ${name} over reducers as ${name}#0, ${name}#1 and so on, and a second small step adds the parts.`,
    { probe: chip() },
  );
  rec.step(
    `Fixes for a join, where a combiner cannot help. Broadcast the small side, so nothing is shuffled. Or split the hot key's records over several reducers and copy its one user row to each. Spark's adaptive execution splits skewed join partitions like this by itself.`,
    { probe: chip() },
  );
  s.follow = null;
  return s.loads;
}

/** Back to the even input. */
export function reset(s: MRState, rec: Rec): void {
  const was = s.hot;
  s.blocks = EVEN.map((b) => [...b]);
  s.hot = null;
  begin(s, 'none');
  rec.line('reset');
  rec.step(
    was === null
      ? `The input is already the even one: 9 clicks by 5 users, no user with more than 3. The job outputs are cleared.`
      : `Back to the even input: 9 clicks by 5 users, no user with more than 3. ${who(was)} is no longer hot.`,
  );
}

// ---- layout -------------------------------------------------------------------

/** Every cell is this wide, so columns line up whatever they hold. */
const CW = 64;
/** Reducer cells are a little narrower: one reducer can hold most of the records. */
const RW = 58;
const NODE_H = CELL_H + TRAY_PAD * 2;
const COLUMN_W = 3 * CW + 2 * CELL_GAP + 2 * TRAY_PAD;
const COL_GAP = 20;
const colX = (c: number) => c * (COLUMN_W + COL_GAP) + COLUMN_W / 2;
const CHIP_ROOM = PROBE_H + 16;
const Y_IN = 0;
/** The input row has no labels under it; the map row has a title above. */
const Y_MAP = Y_IN + NODE_H / 2 + 6 + CHIP_ROOM + TITLE_ROOM + NODE_H / 2;
/** The map row has R labels under it; the reduce row has captions below, not titles above. */
const Y_RED = Y_MAP + NODE_H / 2 + SUB_ROOM + 4 + CHIP_ROOM + NODE_H / 2;
const RED_GAP = 16;
export const RIGHT = colX(3) + COLUMN_W / 2;
const TOP = Y_IN - NODE_H / 2 - CHIP_ROOM - TITLE_ROOM;
const BOTTOM = Y_RED + NODE_H / 2 + SUB_ROOM + CAPTION_ROOM;

const empty = (w = CW): Cell => ({ text: '', w });

function toneOf(s: MRState, p: Pair): Tone | undefined {
  if (p.fetched) return 'dim';
  if (p.id === s.follow) return 'key';
  return p.tone;
}

export function layout(s: MRState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];
  const bc = s.job === 'broadcast';

  // Input: three blocks of clicks and the users table, as HDFS holds them.
  s.blocks.forEach((block, b) => {
    nodes.push({ id: bid(b), x: colX(b), y: Y_IN, title: `Block ${b}: clicks`, cells: block.map((u) => ({ text: who(u), w: CW })) });
  });
  nodes.push({ id: USERS_ID, x: colX(3), y: Y_IN, title: 'users table', cells: s.users.map(([k, c]) => ({ text: `${who(k)} ${c}`, w: CW })) });

  // Map tasks. A join adds a fourth, for the users table.
  const mappers = s.job === 'join' ? 4 : BLOCKS;
  for (let i = 0; i < mappers; i++) {
    const run = s.maps[i];
    const title = i === 3 ? 'Map 3: users' : bc ? `Map ${i} + users` : `Map ${i}`;
    nodes.push({
      id: mid(i),
      x: colX(i),
      y: Y_MAP,
      title,
      cells: run.length
        ? run.map((p) => ({ text: text(p), w: CW, tone: toneOf(s, p), ...(p.part >= 0 ? { sub: `R${p.part}`, subValue: true } : {}) }))
        : [empty(), empty(), empty()],
    });
  }

  if (bc) {
    // A map-only job: each mapper writes its own output file.
    for (let i = 0; i < BLOCKS; i++) {
      const out = s.outs[i];
      nodes.push({ id: oid(i), x: colX(i), y: Y_RED, caption: `Map ${i} output`, cells: out.length ? out.map((p) => ({ text: text(p), w: CW, tone: toneOf(s, p) })) : [empty()] });
    }
  } else {
    // Centred under the mappers, so a phone that follows the chip down from a mapper finds its reducer near by.
    const rows = Array.from({ length: s.reducers }, (_, j) => {
      const red = s.reds[j] ?? [];
      const cells: Cell[] = red.length
        ? red.map((p) => ({ text: text(p), w: RW, tone: toneOf(s, p), ...(p.from >= 0 ? { sub: `M${p.from}` } : {}) }))
        : [empty(RW)];
      return { cells, w: cellsWidth(cells) };
    });
    const total = rows.reduce((n, r) => n + r.w, 0) + RED_GAP * (rows.length - 1);
    let x = Math.max(0, (RIGHT - total) / 2);
    rows.forEach(({ cells, w }, j) => {
      nodes.push({ id: rid(j), x: x + w / 2, y: Y_RED, caption: `Reduce ${j}`, cells });
      x += w + RED_GAP;
    });
    // The shuffle: an edge from each mapper to each reducer it sends to.
    if (s.stage === 'shuffle' || s.stage === 'reduced') {
      const follow = s.follow ? s.maps.flat().find((p) => p.id === s.follow) : undefined;
      for (let i = 0; i < mappers; i++) {
        const run = s.maps[i];
        for (let j = 0; j < s.reducers; j++) {
          const idx = run.flatMap((p, k) => (p.part === j ? [k] : []));
          if (!idx.length) continue;
          const lo = idx[0];
          const hi = idx[idx.length - 1];
          const contiguous = hi - lo + 1 === idx.length;
          edges.push({
            id: `e${i}-${j}`,
            from: mid(i),
            to: rid(j),
            kind: 'tree',
            arrow: true,
            // Leave from the edge of the run of cells bound for this reducer, clear of the labels under them.
            ...(contiguous ? { fromSlot: lo > 0 ? lo : hi + 1 } : {}),
            tone: follow && follow.from === i && follow.part === j ? 'path' : undefined,
          });
        }
      }
    }
  }

  // Two empty labels pin the corners, so the view keeps its size from one job to the next.
  decor.push({ id: 'corner-a', type: 'label', x: 0, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ---------------------------------------------------------------

const USER = { name: 'user', label: 'Follow user', kind: 'int', min: 1, max: MAX_USER } as const;
const HOT = { name: 'hot', label: 'Hot user', kind: 'int', min: 1, max: MAX_USER } as const;

/** A user with at least one click, so there is a record to follow. */
function suggestUser(s: MRState): number {
  const present = [...new Set(s.blocks.flat())];
  return present[randomInt(0, present.length - 1)];
}

const JOB_NAMES: Record<Job, string> = {
  none: 'none yet',
  count: 'count',
  join: 'sort-merge join',
  broadcast: 'broadcast join',
  skew: 'skew check',
};

const def: StructureDef<MRState> = {
  id: 'mapreduce',
  params: [{ id: 'reducers', label: 'Reducers', default: 2, options: [2, 3].map((v) => ({ value: v, label: String(v) })) }],
  create: (params) => create(params.reducers ?? 2),
  // The input is there from the start; nothing needs to run first.
  seed: [],
  ops: [
    { id: 'count', label: 'Count', intent: 'primary', args: [USER], code: ['count', 'partition', 'merge', 'reduce_count'], run: (s, [u], rec) => void count(s, Number(u), rec), suggest: (s) => [suggestUser(s)] },
    { id: 'join', label: 'Sort-merge join', args: [USER], code: ['sort_merge_join', 'partition', 'merge', 'reduce_join'], run: (s, [u], rec) => void join(s, Number(u), rec), suggest: (s) => [suggestUser(s)] },
    { id: 'broadcast', label: 'Broadcast join', args: [USER], code: ['broadcast_join'], run: (s, [u], rec) => void broadcast(s, Number(u), rec), suggest: (s) => [suggestUser(s)] },
    { id: 'skew', label: 'Hot key', intent: 'danger', args: [HOT], code: ['skew', 'partition'], run: (s, [u], rec) => void skew(s, Number(u), rec), suggest: () => [randomInt(1, MAX_USER)] },
    { id: 'reset', label: 'Even input', args: [], code: ['reset'], run: (s, _args, rec) => reset(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Records read' },
    { key: 'shuffled', label: 'Sent over the network' },
    { key: 'written', label: 'Output records' },
  ],
  status: (s) => [
    { label: 'Input', value: `${clicks(s)} clicks${s.hot !== null ? `, ${who(s.hot)} hot` : ''}; ${s.users.length} user rows` },
    { label: 'Reducers', value: String(s.reducers) },
    { label: 'Last job', value: JOB_NAMES[s.job] },
    { label: 'Records per reducer', value: s.loads.length ? s.loads.join(', ') : 'nothing shuffled yet' },
  ],
  tour: [
    ['count', 4],
    ['join', 4],
    ['broadcast', 4],
    ['skew', 1],
  ],
  source: { python, java },
  info,
};

export default def;
