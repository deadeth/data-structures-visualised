import { LABEL_MAX, PROBE_H, TITLE_ROOM, CAPTION_ROOM, probeWidth } from '../../core/fit';
import { CELL_GAP, CELL_H, TRAY_PAD, tagWidth } from '../../core/geometry';
import { pick, randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/Raft.java?raw';
import python from './code/raft.py?raw';
import { info } from './info';

/**
 * Raft: leader election and log replication, in one process.
 *
 * Every server keeps a term, the server it voted for in that term, and a log
 * of (term, value) entries; those three survive a crash. It also keeps a
 * commit index, which does not. A leader keeps, per peer, `next` (the index it
 * will send next) and `match` (the highest index it knows the peer holds).
 *
 * Messages are delivered one at a time, in server order, and at once. A real
 * cluster sends them in parallel and they can be delayed, lost or reordered.
 * `cut` marks the servers on the far side of a partition: a message gets
 * through only when both ends are up and on the same side.
 */
export type Role = 'follower' | 'candidate' | 'leader';

export interface Entry {
  term: number;
  /** A client value, or null for the no-op a new leader appends. */
  value: number | null;
}

export interface Server {
  id: number;
  role: Role;
  term: number;
  votedFor: number | null;
  log: Entry[];
  /** Highest index this server knows to be committed. Lost on a crash. */
  commit: number;
  up: boolean;
  /** Leader only: the next index to send, per peer id. */
  next: Record<number, number>;
  /** Leader only: the highest index known to match, per peer id. */
  match: Record<number, number>;
}

/** What the page draws while an operation runs. Not part of Raft. */
export interface View {
  /** The candidate whose vote count is shown, and its votes. */
  candidate: number | null;
  votes: number;
  /** The follower whose `next` tag is shown, and where it points. */
  nextFor: number | null;
  nextAt: number;
}

export interface RaftState {
  servers: Server[];
  /** cut[id - 1]: on the far side of a partition. */
  cut: boolean[];
  /** Most entries a log may hold. The page draws 6. */
  maxLog: number;
  view: View;
}

export const MAX_LOG = 6;
export const MAX_VALUE = 99;

function server(id: number): Server {
  return { id, role: 'follower', term: 0, votedFor: null, log: [], commit: 0, up: true, next: {}, match: {} };
}

export function create(n = 5, maxLog = MAX_LOG): RaftState {
  return {
    servers: Array.from({ length: n }, (_, i) => server(i + 1)),
    cut: new Array<boolean>(n).fill(false),
    maxLog,
    view: { candidate: null, votes: 0, nextFor: null, nextAt: 0 },
  };
}

// ---- helpers ------------------------------------------------------------------

export const majority = (s: RaftState) => Math.floor(s.servers.length / 2) + 1;
export const lastTerm = (v: Server) => (v.log.length ? v.log[v.log.length - 1].term : 0);
const peers = (s: RaftState, v: Server) => s.servers.filter((p) => p !== v);
const S = (v: Server | number) => `S${typeof v === 'number' ? v : v.id}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const valueText = (e: Entry) => (e.value === null ? 'nop' : String(e.value));
const entryName = (e: Entry) => (e.value === null ? `a no-op of term ${e.term}` : `(term ${e.term}, ${e.value})`);

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function range(from: number, to: number): string {
  return from === to ? `entry ${from}` : `entries ${from} to ${to}`;
}

export function reachable(s: RaftState, a: Server, b: Server): boolean {
  return a.up && b.up && s.cut[a.id - 1] === s.cut[b.id - 1];
}

/** Why a message from `a` cannot reach `b`. */
function why(s: RaftState, a: Server, b: Server): string {
  if (!b.up) return `${S(b)} is down`;
  return s.cut[b.id - 1] ? `${S(b)} is cut off by the partition` : `${S(a)} is cut off by the partition`;
}

function stepDown(v: Server, term: number): void {
  if (term > v.term) {
    v.term = term;
    v.votedFor = null;
  }
  v.role = 'follower';
}

/** The leader a client finds: the up leader with the newest term. */
export function clientLeader(s: RaftState): Server | null {
  let best: Server | null = null;
  for (const v of s.servers) if (v.up && v.role === 'leader' && (!best || v.term > best.term)) best = v;
  return best;
}

/** The newest leader that can reach `v`. */
export function leaderFor(s: RaftState, v: Server): Server | null {
  let best: Server | null = null;
  for (const l of s.servers) if (l.role === 'leader' && reachable(s, l, v) && (!best || l.term > best.term)) best = l;
  return best;
}

function find(s: RaftState, raw: number | string): Server | null {
  const id = Number(String(raw).trim().replace(/^s/i, ''));
  return Number.isInteger(id) && id >= 1 && id <= s.servers.length ? s.servers[id - 1] : null;
}

function clearView(s: RaftState): void {
  s.view = { candidate: null, votes: 0, nextFor: null, nextAt: 0 };
}

// ---- ids and probes -------------------------------------------------------------

const headId = (v: Server) => `h${v.id}`;
/** An entry is named by its server, index and term, so an overwritten slot is a new node. */
const entryId = (v: Server, i: number) => `e${v.id}-${i}-${v.log[i - 1].term}`;

/** What the page follows: a vote request or a heartbeat (index null), or one log entry. */
interface Follow {
  text: string;
  index: number | null;
}

const atHead = (f: Follow, v: Server): Probe => ({ text: f.text, at: headId(v) });
const atEntry = (f: Follow, v: Server, i: number): Probe => ({ text: f.text, at: entryId(v, i), cell: 1, place: 'right' });
/** At the followed entry in v's log when v holds it, else at v's header. */
const atFollowed = (f: Follow, v: Server): Probe => (f.index !== null && f.index <= v.log.length ? atEntry(f, v, f.index) : atHead(f, v));

function markHead(rec: Rec, v: Server, tone: Tone): void {
  rec.markCell(headId(v), 0, tone);
  rec.markCell(headId(v), 1, tone);
}

// ---- election -------------------------------------------------------------------

/** A server's election timer fires. Returns true when it becomes leader. */
export function timeout(s: RaftState, raw: number | string, rec: Rec): boolean {
  clearView(s);
  const c = find(s, raw);
  rec.vars(c ? { c: S(c), 'c.up': c.up, 'c.role': c.role } : undefined);
  rec.line('skip');
  if (!c) {
    rec.step(`This cluster has servers S1 to S${s.servers.length}. There is no server ${raw}.`);
    return false;
  }
  if (!c.up) {
    rec.step(`${S(c)} is down, so its election timer is not running. Recover it first.`);
    return false;
  }
  if (c.role === 'leader') {
    rec.step(`${S(c)} is the leader of term ${c.term}. A leader sends the heartbeats rather than waiting for them, so its election timer never fires.`);
    return false;
  }

  const before = c.term;
  c.role = 'candidate';
  c.term++;
  c.votedFor = c.id;
  let votes = 1;
  s.view.candidate = c.id;
  s.view.votes = votes;
  const follow: Follow = { text: `${S(c)} t${c.term}`, index: null };
  rec.vars({ c: S(c), 'c.term': c.term, 'c.voted_for': S(c), votes });
  rec.line('stand');
  rec.step(
    `${S(c)} has heard no heartbeat for its election timeout, a random wait of, say, 150 to 300 ms. It becomes a candidate: term ${before} becomes ${c.term}, it votes for itself, and it asks every other server for a vote. Follow the request.`,
    { probe: atHead(follow, c) },
  );

  let refusedForVote = false;
  for (const p of peers(s, c)) {
    rec.count('messages');
    const probe = atHead(follow, p);
    rec.vars({ c: S(c), 'c.term': c.term, votes, p: S(p), 'p.term': p.term });
    if (!reachable(s, c, p)) {
      markHead(rec, p, 'bad');
      rec.line('lost');
      rec.step(`${why(s, c, p)}, so the vote request to ${S(p)} is lost. No answer counts as no.`, { probe });
      rec.unmark(headId(p));
      continue;
    }

    rec.markCell(headId(p), 1, 'compare');
    rec.line('term');
    let adopted = false;
    if (p.term > c.term) {
      rec.compare(`${S(c)} term ${c.term}`, '<', `${S(p)} term ${p.term}`, `${S(c)} is behind, it gives up`, {
        probe,
        message: `${S(p)} is already in term ${p.term}, newer than ${c.term}. It refuses and replies with its term.`,
      });
      stepDown(c, p.term);
      clearView(s);
      rec.vars({ c: S(c), 'c.term': c.term, votes, p: S(p), 'p.term': p.term });
      rec.unmark(headId(p));
      rec.line('behind');
      rec.step(`A candidate that sees a newer term gives up at once. ${S(c)} moves to term ${p.term} as a follower, and there is no leader from this attempt.`, {
        probe: atHead(follow, c),
      });
      return false;
    }
    if (p.term < c.term) {
      const old = p.term;
      const was = p.role;
      rec.compare(`${S(c)} term ${c.term}`, '>', `${S(p)} term ${p.term}`, `${S(p)} moves to term ${c.term}`, {
        probe,
        message:
          `Term ${c.term} is newer than ${S(p)}'s term ${old}. Terms work as a logical clock: ${S(p)} adopts ${c.term} and forgets the vote it cast in term ${old}.` +
          (was === 'leader' ? ` It was the leader of term ${old}, so it steps down to follower.` : was === 'candidate' ? ` It gives up its own candidacy.` : ``),
      });
      stepDown(p, c.term);
      adopted = true;
    } else {
      rec.compare(`${S(c)} term ${c.term}`, '=', `${S(p)} term ${p.term}`, 'same term, check its vote', { probe });
    }
    rec.markCell(headId(p), 1, 'idle');

    rec.line(...(adopted ? ['adopt'] : []), 'voted');
    const vf = p.votedFor;
    rec.vars({ c: S(c), 'c.term': c.term, votes, p: S(p), 'p.term': p.term, 'p.voted_for': vf === null ? null : S(vf) });
    if (vf !== null && vf !== c.id) {
      rec.compare(`${S(p)} voted`, '=', S(vf), `already voted in term ${c.term}, refuse`, {
        probe,
        message: `${S(p)} already voted for ${S(vf)} in term ${c.term}. One vote per server per term is what keeps two leaders out of one term, so it refuses.`,
      });
      refusedForVote = true;
      markHead(rec, p, 'bad');
      rec.line('refuse');
      rec.step(`${S(p)} refuses ${S(c)}.`, { probe });
      rec.unmark(headId(p));
      continue;
    }
    rec.compare(`${S(p)} voted`, '=', vf === null ? 'nobody' : S(vf), vf === null ? `free to vote in term ${c.term}` : `already chose ${S(c)}, may repeat`, {
      probe,
      message: vf === null ? `${S(p)} is in term ${c.term} now and has not voted in it, so it is free to vote.` : `${S(p)} already voted for ${S(c)} in term ${c.term}; repeating the same vote is allowed.`,
    });

    // Is the candidate's log at least as up to date?
    const ct = lastTerm(c);
    const pt = lastTerm(p);
    const lastOf = (v: Server) => (v.log.length ? entryId(v, v.log.length) : null);
    const marks = [lastOf(c), lastOf(p)].filter((x): x is string => x !== null);
    for (const id of marks) rec.markCell(id, 0, 'compare');
    rec.vars({ c: S(c), votes, p: S(p), 'c.last_term()': ct, 'p.last_term()': pt });
    rec.line('log_check', 'last_term');
    let ok: boolean;
    if (ct !== pt) {
      ok = ct > pt;
      rec.line('log_check', 'last_term', 'newer');
      rec.compare(`${S(c)} last term ${ct}`, ok ? '>' : '<', `${S(p)} last term ${pt}`, ok ? `${S(c)}'s log is newer, grant` : `${S(p)}'s log is newer, refuse`, {
        probe,
        message: ok
          ? `${S(c)}'s last entry is from term ${ct}, newer than ${S(p)}'s ${pt === 0 ? 'empty log' : `last term ${pt}`}. A later last term wins, whatever the lengths.`
          : `${S(p)}'s last entry is from term ${pt}, newer than ${S(c)}'s ${ct === 0 ? 'empty log' : `last term ${ct}`}. ${S(c)} may be missing committed entries, so it must not lead.`,
      });
    } else {
      rec.compare(`${S(c)} last term ${ct}`, '=', `${S(p)} last term ${pt}`, 'same last term, compare lengths', { probe });
      for (const id of marks) rec.markCell(id, 1, 'compare');
      ok = c.log.length >= p.log.length;
      rec.vars({ c: S(c), votes, p: S(p), 'len(c.log)': c.log.length, 'len(p.log)': p.log.length });
      rec.line('log_check', 'last_index');
      rec.compare(`${S(c)} last index ${c.log.length}`, ok ? '≥' : '<', `${S(p)} last index ${p.log.length}`, ok ? 'at least as long, grant' : `${S(p)}'s log is longer, refuse`, {
        probe,
      });
    }
    for (const id of marks) rec.unmark(id);
    if (!ok) {
      markHead(rec, p, 'bad');
      rec.line('refuse');
      rec.step(`${S(p)} refuses. This check is what stops a server that missed committed entries from becoming leader: a majority holds every committed entry, so it cannot win.`, {
        probe,
      });
      rec.unmark(headId(p));
      continue;
    }
    p.votedFor = c.id;
    votes++;
    s.view.votes = votes;
    rec.vars({ c: S(c), 'c.term': c.term, votes, p: S(p), 'p.term': p.term, 'p.voted_for': S(c) });
    markHead(rec, p, 'ok');
    rec.line('grant');
    rec.step(`${S(p)} grants its vote and writes it to disk first, so a restart cannot make it vote twice in term ${c.term}. ${S(c)} has ${plural(votes, 'vote')}.`, { probe });
    rec.unmark(headId(p));
  }

  const maj = majority(s);
  const n = s.servers.length;
  rec.vars({ c: S(c), 'c.term': c.term, votes, 'majority()': maj });
  rec.line('tally');
  if (votes < maj) {
    rec.compare(`votes ${votes}`, '<', `majority ${maj}`, 'no leader this term', { probe: atHead(follow, c) });
    rec.line('split');
    rec.step(
      `${S(c)} has ${votes} of ${n} votes and needs ${maj}. It stays a candidate in term ${c.term}; a fresh random timeout will start term ${c.term + 1}. ` +
        (refusedForVote
          ? `This is a split vote. Random timeouts make it unlikely that two candidates collide again.`
          : `It cannot win until a majority of servers can hear it.`),
      { probe: atHead(follow, c) },
    );
    clearView(s);
    return false;
  }
  rec.compare(`votes ${votes}`, '≥', `majority ${maj}`, `${S(c)} wins term ${c.term}`, { probe: atHead(follow, c) });
  clearView(s);
  becomeLeader(s, c, follow, rec);
  return true;
}

function becomeLeader(s: RaftState, c: Server, vote: Follow, rec: Rec): void {
  c.role = 'leader';
  for (const p of peers(s, c)) {
    c.next[p.id] = c.log.length + 1;
    c.match[p.id] = 0;
  }
  rec.vars({ c: S(c), 'c.term': c.term, 'c.role': 'leader', 'len(c.log)': c.log.length, next: c.log.length + 1, match: 0 });
  rec.line('win', 'lead');
  rec.step(
    `${S(c)} is the leader of term ${c.term}, and no other server can be: each voted once, and two majorities always share a server. It does not know how far each follower's log goes, so it guesses they all match its own: next = ${c.log.length + 1} for every follower.`,
    { probe: atHead(vote, c) },
  );

  let follow: Follow;
  if (c.log.length < s.maxLog) {
    c.log.push({ term: c.term, value: null });
    const i = c.log.length;
    follow = { text: 'nop', index: i };
    rec.vars({ c: S(c), 'c.term': c.term, 'len(c.log)': i, 'c.log[-1]': [c.term, null] });
    rec.markCell(entryId(c, i), 1, 'key');
    rec.line('noop');
    rec.step(
      `It appends a no-op entry at index ${i}, in term ${c.term}. Once that commits, everything before it is committed too, and the leader knows which entries are safe to serve. Follow the no-op.`,
      { probe: atEntry(follow, c, i) },
    );
  } else {
    follow = { text: `${S(c)} t${c.term}`, index: null };
    rec.vars({ c: S(c), 'c.term': c.term, 'len(c.log)': c.log.length, 'self.max_log': s.maxLog });
    rec.line('noop');
    rec.step(`Sorry, this page draws at most ${s.maxLog} entries per log, so there is no room for the usual no-op. ${S(c)} sends an empty heartbeat instead.`, {
      probe: atHead(follow, c),
    });
  }
  if (broadcast(s, c, follow, ['send'], rec) && c.log.length > c.commit) advanceCommit(s, c, follow, ['count'], rec);
}

// ---- replication ----------------------------------------------------------------

/** AppendEntries to every peer. Returns false if the leader was deposed. */
function broadcast(s: RaftState, L: Server, follow: Follow, lead: string[], rec: Rec): boolean {
  let brief = false;
  for (const p of peers(s, L)) {
    if (!reachable(s, L, p)) {
      rec.count('messages');
      markHead(rec, p, 'bad');
      rec.vars({ leader: S(L), p: S(p), reachable: false });
      rec.line(...lead, 'each', 'unreachable');
      rec.step(`${why(s, L, p)}, so the AppendEntries to ${S(p)} is lost. The leader keeps trying on every heartbeat, and ${S(p)} catches up when it can hear again.`, {
        probe: atHead(follow, p),
      });
      rec.unmark(headId(p));
      continue;
    }
    if (!replicate(s, L, p, follow, [...lead, 'each', 'rpc'], rec, brief)) return false;
    brief = true;
  }
  return true;
}

/** Bring one follower's log into line with the leader's. Returns false if the leader was deposed. */
function replicate(s: RaftState, L: Server, f: Server, follow: Follow, lead: string[], rec: Rec, brief = false): boolean {
  rec.count('messages');
  const probe = atHead(follow, f);
  const intro = follow.index === null ? `${S(L)}'s heartbeat reaches ${S(f)}` : `${S(L)}'s AppendEntries reaches ${S(f)}`;
  rec.markCell(headId(f), 1, 'compare');
  rec.vars({ leader: S(L), f: S(f), 'leader.term': L.term, 'f.term': f.term });
  rec.line(...lead, 'check_term');
  if (f.term > L.term) {
    rec.compare(`${S(L)} term ${L.term}`, '<', `${S(f)} term ${f.term}`, `${S(L)} is out of date, it steps down`, {
      probe,
      message: `${intro}. ${S(f)} is in term ${f.term}, newer than ${S(L)}'s ${L.term}, so it rejects the message and replies with its term.`,
    });
    stepDown(L, f.term);
    clearView(s);
    rec.vars({ leader: S(L), f: S(f), 'leader.term': L.term, 'leader.role': L.role });
    rec.unmark(headId(f));
    rec.line(...lead, 'deposed');
    rec.step(
      `${S(L)} learns that a newer term exists, so it is not the leader any more. It steps down to follower in term ${f.term}. Entries it could not commit stay in its log until a current leader overwrites them.`,
      { probe: atHead(follow, L) },
    );
    return false;
  }
  if (f.term < L.term) {
    const was = f.role;
    rec.line(...lead, 'check_term', 'follow');
    rec.compare(`${S(L)} term ${L.term}`, '>', `${S(f)} term ${f.term}`, `${S(f)} moves to term ${L.term}`, {
      probe,
      message:
        `${intro}. Term ${L.term} is newer than ${S(f)}'s ${f.term}, so ${S(f)} adopts it and accepts ${S(L)} as leader.` +
        (was === 'leader' ? ` ${S(f)} was a leader of term ${f.term}: it steps down.` : was === 'candidate' ? ` It stops being a candidate.` : ``),
    });
  } else {
    rec.line(...lead, 'check_term', 'follow');
    rec.compare(`${S(L)} term ${L.term}`, '=', `${S(f)} term ${f.term}`, f.role === 'candidate' ? `${S(f)} gives up its candidacy` : 'same term, check the logs', {
      probe,
      message:
        f.role === 'candidate'
          ? `${intro}. Both are in term ${L.term}. ${S(f)} was a candidate in this term and now knows the winner, so it becomes a follower.`
          : brief
            ? `${intro}. Same term.`
            : `${intro}. Both are in term ${L.term}, so ${S(f)} accepts ${S(L)} as leader. Now the consistency check.`,
    });
  }
  stepDown(f, L.term);
  rec.markCell(headId(f), 1, 'idle');

  // Walk next back until the entry before it matches.
  s.view.nextFor = f.id;
  let retries = 0;
  for (;;) {
    const prev = L.next[f.id] - 1;
    s.view.nextAt = prev + 1;
    rec.vars({ leader: S(L), f: S(f), 'leader.next[f]': prev + 1, prev, 'len(f.log)': f.log.length });
    if (prev === 0) {
      rec.line(...lead, 'prev', 'empty');
      rec.step(`next = 1, so the entry before it is index 0: there is nothing to check. An empty prefix always matches.`, { probe });
      break;
    }
    const lt = L.log[prev - 1].term;
    if (prev > f.log.length) {
      rec.line(...lead, 'prev', 'has_prev');
      rec.compare(`prev ${prev}: t${lt}`, '>', `${S(f)} last index ${f.log.length}`, `${S(f)} has no entry ${prev}, reject`, {
        probe,
        message: `The message carries the entry before next: index ${prev}, term ${lt}. ${S(f)}'s log stops at ${f.log.length}, so it has no entry ${prev} and cannot be sure the logs agree. It rejects.`,
      });
    } else {
      const ft = f.log[prev - 1].term;
      const same = lt === ft;
      rec.vars({ f: S(f), prev, 'f.log[prev-1][0]': ft, 'leader.log[prev-1][0]': lt });
      rec.markCell(entryId(f, prev), 0, 'compare');
      rec.markCell(entryId(L, prev), 0, 'compare');
      rec.line(...lead, 'prev', 'has_prev', 'same_term', ...(same ? ['agree'] : []));
      rec.compare(`prev ${prev}: t${lt}`, same ? '=' : '≠', `${S(f)} @${prev}: t${ft}`, same ? `logs match up to ${prev}, accept` : 'terms differ, reject', {
        probe,
        message: same
          ? brief
            ? `${S(f)} also has term ${ft} at index ${prev}, so the logs match up to there.`
            : `The message carries the entry before next: index ${prev}, term ${lt}. ${S(f)} has term ${ft} there too. Same index and term means the logs are identical up to ${prev}: that is the log matching property.`
          : `The message carries the entry before next: index ${prev}, term ${lt}. ${S(f)} has term ${ft} at ${prev}. The logs disagree there, so ${S(f)} rejects.`,
      });
      rec.markCell(entryId(f, prev), 0, 'idle');
      rec.markCell(entryId(L, prev), 0, 'idle');
      if (same) break;
    }
    L.next[f.id]--;
    retries++;
    s.view.nextAt = L.next[f.id];
    rec.vars({ leader: S(L), f: S(f), 'leader.next[f]': L.next[f.id], prev, 'len(f.log)': f.log.length });
    rec.count('messages');
    rec.line(...lead, 'back');
    rec.step(`${S(L)} moves next for ${S(f)} back one, to ${L.next[f.id]}, and sends again. Each retry is another round trip. Real servers skip back faster, for example a whole term at a time.`, {
      probe,
    });
  }

  // Copy the leader's entries after prev, deleting a conflicting suffix first.
  const prev = L.next[f.id] - 1;
  const copied: number[] = [];
  let removedFrom = 0;
  let removed = 0;
  for (let i = prev + 1; i <= L.log.length; i++) {
    const e = L.log[i - 1];
    if (i <= f.log.length) {
      const fe = f.log[i - 1];
      const id = entryId(f, i);
      rec.vars({ leader: S(L), f: S(f), prev, i, 'entry[0]': e.term, 'f.log[i-1][0]': fe.term });
      rec.markCell(id, 0, 'compare');
      rec.line(...lead, 'conflict');
      if (fe.term === e.term) {
        rec.line(...lead, 'conflict', 'already');
        rec.compare(`@${i} t${e.term}`, '=', `${S(f)} @${i}: t${fe.term}`, 'already there, skip', { probe: atFollowed(follow, f) });
        rec.markCell(id, 0, 'idle');
        continue;
      }
      const doomed: string[] = [];
      for (let j = i; j <= f.log.length; j++) doomed.push(entryId(f, j));
      for (const d of doomed) rec.mark(d, 'bad');
      rec.compare(`@${i} t${e.term}`, '≠', `${S(f)} @${i}: t${fe.term}`, `conflict, delete ${i} onwards`, {
        probe,
        message: `${S(L)} sends ${entryName(e)} for index ${i}, but ${S(f)} holds ${entryName(fe)} there. Same index, different term: ${S(f)}'s entry never committed, and nor did anything after it. They are deleted.`,
      });
      removedFrom = i;
      removed = f.log.length - (i - 1);
      f.log.length = i - 1;
      for (const d of doomed) rec.unmark(d);
      rec.count('overwritten', removed);
    }
    f.log.push({ ...e });
    copied.push(i);
  }

  const top = L.log.length;
  L.match[f.id] = top;
  L.next[f.id] = top + 1;
  const before = f.commit;
  f.commit = Math.max(f.commit, Math.min(L.commit, top));
  clearView(s);
  if (follow.index !== null && copied.includes(follow.index)) rec.markCell(entryId(f, follow.index), 1, 'key');
  markHead(rec, f, 'ok');
  rec.vars({ leader: S(L), f: S(f), 'leader.match[f]': top, 'leader.commit': L.commit, 'f.commit': f.commit });
  rec.line(...lead, ...(removed ? ['truncate'] : []), ...(copied.length ? ['copy'] : []), 'ack');
  rec.step(
    (removed
      ? `${S(f)} deletes ${range(removedFrom, removedFrom + removed - 1)}, then appends ${range(copied[0], copied[copied.length - 1])} from ${S(L)}. `
      : copied.length
        ? `${S(f)} appends ${range(copied[0], copied[copied.length - 1])}. `
        : `${S(f)} already holds everything up to ${top}, so nothing is copied. `) +
      `It replies success, and ${S(L)} records match = ${top} and next = ${top + 1} for it.` +
      (f.commit > before ? ` The message also said commit = ${L.commit}, so ${S(f)} marks ${range(before + 1, f.commit)} committed.` : ``) +
      (retries ? ` That took ${plural(retries + 1, 'round trip')}.` : ``),
    { probe: atFollowed(follow, f) },
  );
  rec.unmark(headId(f));
  return true;
}

/** Commit the highest index a majority holds, if it is from the leader's term. Returns true when the commit index moved. */
function advanceCommit(s: RaftState, L: Server, follow: Follow, lead: string[], rec: Rec): boolean {
  const maj = majority(s);
  const n = s.servers.length;
  const probe = atFollowed(follow, L);
  let lastCopies = 1;
  for (let i = L.log.length; i > L.commit; i--) {
    const holders = [L, ...peers(s, L).filter((p) => (L.match[p.id] ?? 0) >= i)];
    const copies = holders.length;
    lastCopies = copies;
    const id = entryId(L, i);
    rec.vars({ leader: S(L), top: L.log.length, n: i, copies, 'majority()': maj, 'leader.commit': L.commit });
    rec.mark(id, 'compare');
    rec.line(...lead, 'scan', 'majority');
    if (copies < maj) {
      rec.line(...lead, 'scan', 'majority', 'fewer');
      rec.compare(`copies of ${i}: ${copies}`, '<', `majority ${maj}`, i - 1 > L.commit ? 'not enough, look lower' : 'not enough, nothing commits', {
        probe,
        message: `Entry ${i} is on ${copies} of ${n} servers (${list(holders.map(S))}). A majority is ${maj}, so it is not committed.`,
      });
      rec.unmark(id);
      continue;
    }
    rec.compare(`copies of ${i}: ${copies}`, '≥', `majority ${maj}`, 'a majority holds it', {
      probe,
      message: `Entry ${i} is on ${copies} of ${n} servers (${list(holders.map(S))}): a majority. Any future leader needs votes from a majority, and one of them holds this entry, so it will survive.`,
    });
    const t = L.log[i - 1].term;
    rec.vars({ leader: S(L), n: i, copies, 'leader.log[n-1][0]': t, 'leader.term': L.term });
    rec.line(...lead, 'own_term');
    if (t !== L.term) {
      rec.line(...lead, 'own_term', 'older');
      rec.compare(`entry ${i}: t${t}`, '≠', `term ${L.term}`, 'older term, do not commit by counting', {
        probe,
        message: `But entry ${i} is from term ${t}, not ${L.term}. A leader never commits an older term's entry by counting copies: that entry could still be overwritten (figure 8 of the Raft paper). It commits only when an entry of term ${L.term} above it does.`,
      });
      rec.unmark(id);
      return false;
    }
    rec.compare(`entry ${i}: t${t}`, '=', `term ${L.term}`, `commit up to ${i}`, {
      probe,
      message: `Entry ${i} is from term ${t}, the leader's own term, so a majority of copies is enough to commit it.`,
    });
    const from = L.commit;
    L.commit = i;
    rec.vars({ leader: S(L), n: i, 'leader.log[n-1][0]': t, 'leader.term': L.term, 'leader.commit': L.commit });
    rec.clearMarks();
    rec.line(...lead, 'commit');
    const what = `${S(L)} moves its commit index from ${from} to ${i}: ${range(from + 1, i)} ${from + 1 === i ? 'is' : 'are'} committed`;
    const written = follow.index !== null && L.log[follow.index - 1].value !== null;
    rec.step(
      follow.index !== null && follow.index > i
        ? `${what}. Entry ${follow.index} is not committed yet.`
        : written
          ? `${what} and applied, and the client gets its answer. The cost: one round trip to a majority, ${maj} of ${n} servers.`
          : follow.index !== null
            ? `${what}. Nobody waits on a no-op, but every entry before it is now committed too.`
            : `${what}.`,
      { probe: atFollowed(follow, L) },
    );

    const told: Server[] = [];
    const deaf: Server[] = [];
    for (const p of peers(s, L)) {
      if (!reachable(s, L, p)) {
        deaf.push(p);
        continue;
      }
      rec.count('messages');
      const was = p.commit;
      p.commit = Math.max(p.commit, Math.min(i, L.match[p.id] ?? 0));
      if (p.commit > was) told.push(p);
    }
    rec.vars({ leader: S(L), n: i, 'leader.commit': L.commit, told: told.map(S), deaf: deaf.map(S) });
    rec.line(...lead, 'tell');
    rec.step(
      (told.length
        ? `The next heartbeat carries commit = ${i}. ${list(told.map(S))} ${told.length === 1 ? 'marks' : 'mark'} the entries up to there committed and apply them.`
        : `The next heartbeat carries commit = ${i}, which the followers it reaches already knew.`) +
        (deaf.length ? ` ${list(deaf.map(S))} cannot hear it and will learn later.` : ``),
      { probe: atFollowed(follow, L) },
    );
    return follow.index === null || L.commit >= follow.index;
  }
  rec.vars({ leader: S(L), top: L.log.length, 'leader.commit': L.commit, copies: lastCopies, 'majority()': maj });
  rec.line(...lead, 'waiting');
  const reach = 1 + peers(s, L).filter((p) => reachable(s, L, p)).length;
  rec.step(
    reach < maj
      ? `Nothing commits. ${S(L)} can reach only ${reach} of ${n} servers, fewer than the ${maj} it needs, so ${follow.index !== null ? `entry ${follow.index}` : 'its entries'} cannot commit while that lasts. The client hears nothing back and cannot tell whether the write will happen.`
      : `Nothing new commits: the best entry has ${lastCopies} ${lastCopies === 1 ? 'copy' : 'copies'}. ${S(L)} keeps sending until a majority holds it.`,
    { probe },
  );
  return false;
}

// ---- operations -----------------------------------------------------------------

/** A client write. Returns true once the written entry is committed. */
export function write(s: RaftState, raw: number | string, rec: Rec): boolean {
  clearView(s);
  const value = Number(raw);
  rec.vars({ value });
  rec.line('find');
  if (!Number.isInteger(value) || value < 1 || value > MAX_VALUE) {
    rec.step(`Values on this page are whole numbers from 1 to ${MAX_VALUE}.`);
    return false;
  }
  const L = clientLeader(s);
  rec.vars({ value, leader: L ? S(L) : null });
  if (!L) {
    rec.line('find', 'no_leader');
    rec.step(`No server is leader, so the client has nobody to send ${value} to. It retries after an election: time out a follower.`);
    return false;
  }
  if (L.log.length >= s.maxLog) {
    rec.vars({ value, leader: S(L), 'len(leader.log)': L.log.length, 'self.max_log': s.maxLog });
    rec.line('full');
    rec.step(`Sorry, this page draws at most ${s.maxLog} entries per log, and ${S(L)}'s log is full. Use Start over for a fresh cluster. A real server compacts its log into a snapshot instead.`);
    return false;
  }
  L.log.push({ term: L.term, value });
  const i = L.log.length;
  const follow: Follow = { text: String(value), index: i };
  const stale = peers(s, L).some((p) => p.up && p.term > L.term);
  rec.vars({ value, leader: S(L), 'leader.term': L.term, index: i });
  rec.markCell(entryId(L, i), 1, 'key');
  rec.line('find', 'append');
  rec.step(
    `The client sends ${value} to ${S(L)}, the leader of term ${L.term}` +
      (s.cut[L.id - 1] || stale ? `, as far as ${S(L)} knows. Nothing tells a server it has been cut off.` : `.`) +
      ` ${S(L)} appends (term ${L.term}, ${value}) at index ${i} of its own log. It is not committed: one copy is not enough.`,
    { probe: atEntry(follow, L, i) },
  );
  if (!broadcast(s, L, follow, ['send'], rec)) {
    rec.vars({ value, leader: S(L), index: i, 'broadcast()': false });
    rec.line('send');
    rec.step(`The write is not acknowledged. The client retries with the new leader, and entry ${i} on ${S(L)} will be overwritten if it never reached a majority.`, {
      probe: atFollowed(follow, L),
    });
    return false;
  }
  return advanceCommit(s, L, follow, ['count'], rec);
}

/** Take a server down. */
export function crash(s: RaftState, raw: number | string, rec: Rec): boolean {
  clearView(s);
  const v = find(s, raw);
  rec.vars(v ? { s: S(v), 's.up': v.up } : undefined);
  rec.line('crash');
  if (!v) {
    rec.step(`This cluster has servers S1 to S${s.servers.length}. There is no server ${raw}.`);
    return false;
  }
  if (!v.up) {
    rec.step(`${S(v)} is already down.`);
    return false;
  }
  const was = v.role;
  v.up = false;
  v.next = {};
  v.match = {};
  rec.vars({ s: S(v), 's.up': false, 's.term': v.term, 's.voted_for': v.votedFor === null ? null : S(v.votedFor), 'len(s.log)': v.log.length });
  rec.step(
    `${S(v)} crashes. Its term (${v.term}), its vote and its log are on disk and survive; its commit index and any leader state are lost. ` +
      (was === 'leader'
        ? `It was the leader, so the followers stop hearing heartbeats. When one of their election timers fires, that server stands in term ${v.term + 1}.`
        : `The others carry on: ${s.servers.filter((x) => x.up).length} of ${s.servers.length} servers are up, and a majority is ${majority(s)}.`),
  );
  return true;
}

/** Bring a crashed server back. A leader that can reach it repairs its log. */
export function recover(s: RaftState, raw: number | string, rec: Rec): boolean {
  clearView(s);
  const v = find(s, raw);
  rec.vars(v ? { s: S(v), 's.up': v.up } : undefined);
  rec.line('restart');
  if (!v) {
    rec.step(`This cluster has servers S1 to S${s.servers.length}. There is no server ${raw}.`);
    return false;
  }
  if (v.up) {
    rec.step(`${S(v)} is already up.`);
    return false;
  }
  v.up = true;
  v.role = 'follower';
  v.commit = 0;
  v.next = {};
  v.match = {};
  rec.vars({ s: S(v), 's.up': true, 's.role': 'follower', 's.term': v.term, 's.commit': 0 });
  rec.step(
    `${S(v)} restarts as a follower. Its term (${v.term}), vote and log were on disk, so they are back. Its commit index was only in memory, so it starts at 0 until a leader says otherwise.`,
  );
  const L = leaderFor(s, v);
  rec.vars({ s: S(v), 's.term': v.term, 's.commit': 0, leader: L ? S(L) : null });
  rec.line('find_leader');
  if (!L) {
    rec.line('find_leader', 'no_leader');
    rec.step(`No leader can reach ${S(v)} right now. It waits; if its own election timer fires first, it will stand.`);
    return true;
  }
  const follow: Follow = { text: `${S(L)} t${L.term}`, index: null };
  if (!replicate(s, L, v, follow, ['rpc'], rec)) return true;
  if (L.log.length > L.commit) advanceCommit(s, L, follow, ['rpc'], rec);
  rec.vars({ s: S(v), 's.term': v.term, 's.commit': v.commit, leader: S(L), 'len(s.log)': v.log.length });
  rec.line('rpc');
  rec.step(`${S(v)} is back in step: its log is the same as ${S(L)}'s up to ${L.log.length}, and it knows entries up to ${v.commit} are committed.`, {
    probe: atHead(follow, v),
  });
  return true;
}

/** Cut a server off from the other side. */
export function partition(s: RaftState, raw: number | string, rec: Rec): boolean {
  clearView(s);
  const v = find(s, raw);
  rec.vars(v ? { s: S(v), 'self.cut': s.servers.filter((x) => s.cut[x.id - 1]).map(S) } : undefined);
  rec.line('cut');
  if (!v) {
    rec.step(`This cluster has servers S1 to S${s.servers.length}. There is no server ${raw}.`);
    return false;
  }
  if (s.cut[v.id - 1]) {
    rec.step(`${S(v)} is already cut off.`);
    return true;
  }
  const n = s.servers.length;
  const far = s.cut.filter(Boolean).length;
  if (far + 1 === n) {
    rec.line('refuse');
    rec.step(`Cutting ${S(v)} off too would put every server on the same side, which is no partition at all.`);
    return false;
  }
  s.cut[v.id - 1] = true;
  rec.vars({ s: S(v), 'self.cut': s.servers.filter((x) => s.cut[x.id - 1]).map(S) });
  const farSide = s.servers.filter((x) => s.cut[x.id - 1]);
  const nearSide = s.servers.filter((x) => !s.cut[x.id - 1]);
  const maj = majority(s);
  const sideNote = (side: Server[]) => `${list(side.map(S))} (${side.length} of ${n}${side.length >= maj ? ', a majority' : ''})`;
  rec.step(
    `The network splits. ${sideNote(farSide)} on one side, ${sideNote(nearSide)} on the other. ` +
      (v.role === 'leader' && v.up
        ? `${S(v)} still believes it is the leader: nothing tells a server it has been cut off. `
        : ``) +
      `Only a side with a majority can elect a leader or commit anything.`,
  );
  return true;
}

/** Reconnect everyone. Leaders, newest term first, send a heartbeat round. */
export function heal(s: RaftState, rec: Rec): boolean {
  clearView(s);
  rec.vars({ 'self.cut': s.servers.filter((x) => s.cut[x.id - 1]).map(S) });
  rec.line('heal');
  if (!s.cut.some(Boolean)) {
    rec.step(`There is no partition: every server that is up can already reach every other.`);
    return false;
  }
  s.cut.fill(false);
  rec.vars({ 'self.cut': [] });
  rec.step(`The partition heals and messages flow between every pair of servers again. Nothing changes until someone sends something: the next heartbeats.`);
  const leaders = s.servers.filter((v) => v.role === 'leader').sort((a, b) => b.term - a.term);
  rec.vars({ 'self.cut': [], leaders: leaders.map(S) });
  rec.line('leaders');
  if (!leaders.some((v) => v.up)) {
    rec.step(`No server that is up is a leader. The first election timer to fire starts an election.`);
    return true;
  }
  const summary: string[] = [];
  for (const L of leaders) {
    if (!L.up || L.role !== 'leader') continue;
    const follow: Follow = { text: `${S(L)} t${L.term}`, index: null };
    rec.vars({ leaders: leaders.map(S), leader: S(L), 'leader.term': L.term });
    rec.line('heartbeat');
    rec.step(`${S(L)}, leader of term ${L.term}, sends its heartbeat to every server. A heartbeat is an AppendEntries carrying whatever that follower is missing, usually nothing, so it runs the same checks.`, {
      probe: atHead(follow, L),
    });
    if (broadcast(s, L, follow, ['heartbeat'], rec)) {
      if (L.log.length > L.commit) advanceCommit(s, L, follow, ['heartbeat'], rec);
      summary.push(`${S(L)} leads term ${L.term}`);
    } else summary.push(`${S(L)} stepped down`);
  }
  rec.vars({ leaders: leaders.map(S) });
  rec.line('heartbeat');
  const now = clientLeader(s);
  const down = s.servers.filter((v) => !v.up);
  rec.step(
    `${list(summary)}. ` +
      (now
        ? `Every server ${S(now)} can reach now holds a copy of its log, and there is one leader again.` +
          (down.length ? ` ${list(down.map(S))} ${down.length === 1 ? 'is' : 'are'} still down and will be repaired on recovery.` : ``)
        : `No leader is left; an election comes next.`),
  );
  return true;
}

/** A fresh cluster. */
export function reset(s: RaftState, rec: Rec): void {
  const fresh = create(s.servers.length, s.maxLog);
  s.servers = fresh.servers;
  s.cut = fresh.cut;
  clearView(s);
  rec.vars({ n: s.servers.length, 'self.cut': [] });
  rec.line('reset');
  rec.step(`A fresh cluster: every server is a follower in term 0 with an empty log. Time out any server to elect a leader.`);
}

// ---- layout -----------------------------------------------------------------

const NAME_W = 42;
const TERM_W = 42;
const VALUE_W = 42;
const ENTRY_W = TRAY_PAD * 2 + CELL_GAP + TERM_W + VALUE_W;
const BOX_H = CELL_H + TRAY_PAD * 2;
const NEXT_W = tagWidth('next');
/** Column pitch: an entry, the next tag on its left and room on its right for the probe chip. */
export const PITCH = 167;
const HEAD_Y = 0;
const ENTRY_Y0 = HEAD_Y + BOX_H / 2 + CAPTION_ROOM + 4 + BOX_H / 2;
const ENTRY_PITCH = 47;
const INDEX_X = -ENTRY_W / 2 - 6 - NEXT_W - 12;
const entryY = (i: number) => ENTRY_Y0 + (i - 1) * ENTRY_PITCH;
const colX = (v: Server) => (v.id - 1) * PITCH;
/** Hues for terms 1, 2, 3...: grouping only. Teal, lime and blue are left out: they read as committed or visited. */
const TERM_HUES = [1, 2, 5];
const termHue = (t: number) => (t <= 0 ? undefined : TERM_HUES[(t - 1) % TERM_HUES.length]);

export function layout(s: RaftState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const n = s.servers.length;
  const maj = majority(s);
  const bottom = entryY(s.maxLog) + BOX_H / 2;
  const bandTop = HEAD_Y - BOX_H / 2 - TITLE_ROOM - 6;
  const L = clientLeader(s);

  for (const v of s.servers) {
    const x = colX(v);
    const cut = s.cut[v.id - 1];
    if (cut) decor.push({ id: `cut${v.id}`, type: 'band', x: x - PITCH / 2 + 8, y: bandTop, w: PITCH - 16, h: bottom + 8 - bandTop });
    const role = v.up ? v.role : 'down';
    const dim: Tone | undefined = v.up ? undefined : 'dim';
    nodes.push({
      id: headId(v),
      x,
      y: HEAD_Y,
      cells: [
        { text: S(v), w: NAME_W, tone: dim },
        { text: `t${v.term}`, w: TERM_W, tone: dim },
      ],
      hue: v.up ? termHue(v.term) : undefined,
      title: cut ? `${role}, cut off` : role,
      caption: s.view.candidate === v.id ? `votes ${s.view.votes}, need ${maj}` : `vote: ${v.votedFor === null ? 'none' : S(v.votedFor)}`,
    });
    v.log.forEach((e, k) => {
      const i = k + 1;
      const tone: Tone | undefined = !v.up ? 'dim' : i <= v.commit ? 'ok' : undefined;
      const id = entryId(v, i);
      // A copy grows out of the leader's entry for the same index and term.
      const src = L && L !== v && L.log[k]?.term === e.term ? entryId(L, i) : undefined;
      nodes.push({
        id,
        x,
        y: entryY(i),
        cells: [
          { text: `t${e.term}`, w: TERM_W, tone },
          { text: valueText(e), w: VALUE_W, tone },
        ],
        hue: tone ? undefined : termHue(e.term),
        from: src,
      });
    });
  }

  for (let i = 1; i <= s.maxLog; i++) decor.push({ id: `idx${i}`, type: 'label', x: INDEX_X, y: entryY(i), text: String(i), anchor: 'end' });

  // With a full log, next can point past the last row drawn; the narration says where.
  if (s.view.nextFor !== null && s.view.nextAt <= s.maxLog) {
    const f = s.servers[s.view.nextFor - 1];
    // Empty slots down to next, so the tag points at a place in this follower's log.
    for (let i = f.log.length + 1; i <= s.view.nextAt; i++) {
      nodes.push({ id: `slot${f.id}-${i}`, x: colX(f), y: entryY(i), cells: [{ text: '', w: TERM_W }, { text: '', w: VALUE_W }] });
    }
    nodes.push({ id: 'next', x: colX(f) - ENTRY_W / 2 - 6 - NEXT_W / 2, y: entryY(s.view.nextAt), cells: [{ text: 'next' }], shape: 'tag' });
  }

  // Two empty labels pin the corners, so the scene keeps its size as logs grow and shrink.
  const right = (n - 1) * PITCH + ENTRY_W / 2 + 10 + probeWidth('nop');
  const top = HEAD_Y - BOX_H / 2 - TITLE_ROOM - PROBE_H - 16;
  decor.push({ id: 'corner-a', type: 'label', x: INDEX_X - 12, y: top + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: right, y: bottom - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------------

const SERVER = { name: 'server', label: 'Server', kind: 'int', min: 1, max: 5 } as const;
const VALUE = { name: 'value', label: 'Value', kind: 'int', min: 1, max: MAX_VALUE } as const;

/** A follower that is up, preferring one on a side with no leader. */
function suggestTimeout(s: RaftState): number {
  const up = s.servers.filter((v) => v.up && v.role !== 'leader');
  if (!up.length) return 1;
  const leaderless = up.filter((v) => !leaderFor(s, v));
  return pick(leaderless.length ? leaderless : up).id;
}

function suggestCrash(s: RaftState): number {
  const L = clientLeader(s);
  if (L && randomInt(0, 2) > 0) return L.id;
  const up = s.servers.filter((v) => v.up);
  return (up.length ? pick(up) : s.servers[0]).id;
}

function suggestRecover(s: RaftState): number {
  const down = s.servers.filter((v) => !v.up);
  return (down.length ? pick(down) : s.servers[0]).id;
}

/** The leader first, then servers on the near side while the far side stays a minority. */
function suggestPartition(s: RaftState): number {
  const L = clientLeader(s);
  if (L && !s.cut[L.id - 1]) return L.id;
  const near = s.servers.filter((v) => !s.cut[v.id - 1]);
  return (near.length > 1 ? pick(near) : s.servers[0]).id;
}

const def: StructureDef<RaftState> = {
  id: 'raft',
  params: [{ id: 'servers', label: 'Servers', default: 5, options: [3, 5].map((v) => ({ value: v, label: `${v} servers` })) }],
  create: (params) => create(params.servers ?? 5),
  // S1 wins term 1 and commits its no-op, so the page opens on a working cluster.
  seed: [['timeout', 1]],
  ops: [
    {
      id: 'timeout',
      label: 'Timeout',
      intent: 'primary',
      args: [SERVER],
      code: ['timeout', 'up_to_date', 'become_leader', 'broadcast', 'replicate', 'advance_commit'],
      run: (s, [v], rec) => void timeout(s, v, rec),
      suggest: (s) => [suggestTimeout(s)],
    },
    {
      id: 'write',
      label: 'Write',
      intent: 'primary',
      args: [VALUE],
      code: ['write', 'broadcast', 'replicate', 'advance_commit'],
      run: (s, [v], rec) => void write(s, v, rec),
      suggest: () => [randomInt(1, MAX_VALUE)],
    },
    { id: 'crash', label: 'Crash', intent: 'danger', args: [SERVER], code: ['crash'], run: (s, [v], rec) => void crash(s, v, rec), suggest: (s) => [suggestCrash(s)] },
    {
      id: 'recover',
      label: 'Recover',
      args: [SERVER],
      code: ['recover', 'replicate', 'advance_commit'],
      run: (s, [v], rec) => void recover(s, v, rec),
      suggest: (s) => [suggestRecover(s)],
    },
    { id: 'partition', label: 'Partition', intent: 'danger', args: [SERVER], code: ['partition'], run: (s, [v], rec) => void partition(s, v, rec), suggest: (s) => [suggestPartition(s)] },
    { id: 'heal', label: 'Heal', args: [], code: ['heal', 'broadcast', 'replicate', 'advance_commit'], run: (s, _a, rec) => void heal(s, rec) },
    { id: 'reset', label: 'Start over', intent: 'danger', args: [], code: ['reset'], run: (s, _a, rec) => reset(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'messages', label: 'Messages sent' },
    { key: 'overwritten', label: 'Entries overwritten' },
  ],
  status: (s) => {
    const L = clientLeader(s);
    const down = s.servers.filter((v) => !v.up).map(S);
    const cut = s.servers.filter((v) => s.cut[v.id - 1]).map(S);
    return [
      { label: 'Leader', value: L ? `${S(L)}, term ${L.term}` : 'none' },
      { label: 'Committed (leader)', value: L ? `up to ${L.commit}` : 'n/a' },
      { label: 'Down', value: down.length ? down.join(', ') : 'none' },
      { label: 'Cut off', value: cut.length ? cut.join(', ') : 'none' },
    ];
  },
  tour: [
    ['write', 7],
    ['partition', 1],
    ['write', 8],
    ['timeout', 2],
    ['crash', 2],
    ['timeout', 3],
    ['heal'],
  ],
  source: { python, java },
  info,
};

export default def;
