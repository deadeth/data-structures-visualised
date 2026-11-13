import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, VarValue } from '../../core/types';
import java from './code/LoadBalancing.java?raw';
import python from './code/load_balancing.py?raw';
import { info } from './info';

/**
 * A load balancer in front of three or four servers, with a standby beside it.
 *
 * Time moves in ticks: one tick passes before each new request. A request
 * needs `work` ticks on a healthy server (five times as many on a slow one)
 * and holds a connection until then. The balancer picks a server by the
 * policy, and only ever among the servers it believes are healthy. What it
 * believes (`healthy`) and what is true (`answering`) differ until the health
 * checks catch up.
 *
 * Each server keeps a tiny cache of user sessions, so the page can show what
 * sticky routing buys and what a reshuffle costs.
 */
export const POLICIES = ['round robin', 'weighted round robin', 'least connections', 'power of two choices', 'hash by user'] as const;
export const RR = 0;
export const WRR = 1;
export const LEAST = 2;
export const TWO = 3;
export const HASH = 4;

export const NAMES = 'ABCD';
export const MAX_SERVERS = NAMES.length;
export const WEIGHTS = [3, 1, 1, 2];
export const SLOW = 5;
export const FALL = 2;
export const RISE = 2;
export const MISSED = 3;
export const CACHE = 3;
/** Requests drawn in a server's row. More than this and the middle ones fold into a "+k" box. */
export const PILE = 3;
export const USERS = ['ana', 'ben', 'cai', 'dev', 'eve', 'fin'];
/** The users the hash-by-user demonstration sends: ana twice, so the second lands where the first did. */
export const STICKY_DEMO = ['ana', 'ben', 'ana', 'eve'];
/** Requests sent after a server is made slow, and after a policy switch. */
export const SLOW_DEMO = 6;
export const POLICY_DEMO = 4;
export const DEMO_WORK = 3;

export interface Req {
  id: number;
  user: string | null;
  work: number;
  end: number;
}

export interface Server {
  name: string;
  weight: number;
  open: Req[];
  healthy: boolean;
  answering: boolean;
  slow: boolean;
  misses: number;
  passes: number;
  score: number;
  sessions: string[];
  served: number;
}

export interface LBState {
  policy: number;
  servers: Server[];
  next: number;
  now: number;
  seq: number;
  seed: number;
  /** Which slot holds the active balancer: 0 is the upper one. */
  active: number;
  /** The balancer names in each slot. They swap places only in name. */
  lbNames: [string, string];
  /** Slot of a balancer that has died, while the failover is drawn. */
  lbDown: number | null;
  missed: number;
  /** A request on its way, drawn beside the clients or the balancer. Only set while recording. */
  transit: { req: Req; at: 'client' | 'lb' } | null;
}

export function create(servers = 3, policy = RR): LBState {
  const s: LBState = {
    policy,
    servers: [],
    next: 0,
    now: 0,
    seq: 0,
    seed: 1,
    active: 0,
    lbNames: ['LB 1', 'LB 2'],
    lbDown: null,
    missed: 0,
    transit: null,
  };
  for (let i = 0; i < servers; i++) s.servers.push(newServer(i));
  return s;
}

function newServer(i: number): Server {
  return { name: NAMES[i], weight: WEIGHTS[i], open: [], healthy: true, answering: true, slow: false, misses: 0, passes: 0, score: 0, sessions: [], served: 0 };
}

export const userHash = (user: string): number => [...user].reduce((h, c) => h + c.charCodeAt(0) - 96, 0);
const hashSum = (user: string): string => [...user].map((c) => c.charCodeAt(0) - 96).join(' + ');

/** The page's generator for power of two choices. The listings use the same one. */
export function rand(s: LBState, n: number): number {
  s.seed = (s.seed * 75 + 74) % 65537;
  return s.seed % n;
}

/** Where hash by user sends this user now: hash mod n, then on to the next healthy server. Null when none is healthy. */
export function home(s: LBState, user: string): Server | null {
  const n = s.servers.length;
  let i = userHash(user) % n;
  for (let k = 0; k < n; k++) {
    if (s.servers[i].healthy) return s.servers[i];
    i = (i + 1) % n;
  }
  return null;
}

export const label = (r: Req) => `r${((r.id - 1) % 99) + 1}`;
const live = (s: LBState) => s.servers.filter((x) => x.healthy);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const ticks = (n: number) => plural(n, 'tick');
const openOf = (x: Server) => `${x.name}: ${x.open.length} open`;

// ---- ids ----------------------------------------------------------------------

const rid = (r: Req) => `r${r.id}`;
const sid = (x: Server) => `srv-${x.name}`;
const cid = (x: Server) => `cache-${x.name}`;
const eid = (x: Server) => `e-${x.name}`;
const lid = (slot: number) => `lb${slot}`;

function findServer(s: LBState, raw: number | string): Server | null {
  const name = String(raw).trim().toUpperCase().charAt(0);
  return s.servers.find((x) => x.name === name) ?? null;
}

export function parsePolicy(raw: number | string): number | null {
  const w = String(raw).trim().toLowerCase();
  if (['roundrobin', 'round', 'rr'].includes(w)) return RR;
  if (['weighted', 'wrr', 'weight'].includes(w)) return WRR;
  if (['least', 'leastconn', 'lc', 'fewest'].includes(w)) return LEAST;
  if (['two', 'power', 'ptwo', 'choices', 'pick'].includes(w)) return TWO;
  if (['hash', 'sticky', 'user', 'byuser'].includes(w)) return HASH;
  return null;
}

/** A recorder that counts but draws nothing, for retries told in one frame each. */
function muted(rec: Rec): Rec {
  return {
    recording: false,
    step() {},
    vars() {},
    compare: () => rec.count('comparisons'),
    count: (c, by) => rec.count(c, by),
    line() {},
    mark() {},
    markCell() {},
    markEdge() {},
    unmark() {},
    clearMarks() {},
  };
}

// ---- choosing a server ----------------------------------------------------------

/** Pick a healthy server for this request by the policy, narrating each comparison. */
function pick(s: LBState, req: Req, rec: Rec, probe: Probe): Server | null {
  const name = label(req);
  const up = live(s);
  if (!up.length) {
    rec.vars({ user: req.user, server: null });
    rec.line('pick', 'none_up');
    rec.step(`${name} reaches the balancer, but every server is marked down. There is nowhere to send it.`, { probe });
    return null;
  }
  if (s.policy === HASH && req.user !== null) return byUser(s, req.user, rec, probe);
  if (s.policy === LEAST) return leastConn(s, rec, probe);
  if (s.policy === TWO) return twoChoices(s, rec, probe);
  if (s.policy === WRR) return weighted(s, rec, probe, name);
  return roundRobin(s, rec, probe, name, s.policy === HASH);
}

function roundRobin(s: LBState, rec: Rec, probe: Probe, name: string, fallback: boolean): Server {
  const n = s.servers.length;
  let first = true;
  for (;;) {
    const i = s.next;
    const x = s.servers[i];
    s.next = (i + 1) % n;
    rec.mark(sid(x), 'compare');
    rec.vars({ n, s: x.name, 'self.next': s.next, 's.healthy': x.healthy });
    rec.line('use_rr', 'rr_next', 'rr_check');
    const lead = first && fallback ? `${name} has no user to hash, so it falls back to round robin. ` : '';
    first = false;
    if (x.healthy) {
      rec.compare(`next = ${i}: ${x.name}`, '=', 'healthy', `send ${name} to ${x.name}, next becomes ${s.next}`, {
        probe,
        message: `${lead}next points at ${x.name}, which is healthy, so ${name} goes there and next moves on to ${s.next}. Round robin looks at nothing else: not how busy ${x.name} is, not how long its requests take.`,
      });
      rec.unmark(sid(x));
      return x;
    }
    rec.compare(`next = ${i}: ${x.name}`, '≠', 'healthy', `skip ${x.name}, try the next`, {
      probe,
      message: `${lead}next points at ${x.name}, but ${x.name} is marked down, so it is skipped and next moves on to ${s.next}.`,
    });
    rec.mark(sid(x), 'dim');
  }
}

function weighted(s: LBState, rec: Rec, probe: Probe, name: string): Server {
  const up = live(s);
  const before = up.map((x) => x.score);
  for (const x of up) x.score += x.weight;
  for (const x of up) rec.markCell(sid(x), 2, 'path');
  if (rec.recording) rec.vars({ live: up.map((x) => x.name), ...Object.fromEntries(up.map((x) => [`${x.name}.score`, x.score])) });
  rec.line('use_wrr', 'wrr_add');
  rec.step(
    `Smooth weighted round robin (A×3 means A has weight 3). Every healthy server adds its weight to its score: ${up.map((x, i) => `${x.name} ${signed(before[i])} + ${x.weight} = ${signed(x.score)}`).join(', ')}.`,
    { probe },
  );
  let best = up[0];
  for (const x of up.slice(1)) {
    rec.markCell(sid(x), 2, 'compare');
    rec.markCell(sid(best), 2, 'compare');
    const wins = x.score > best.score;
    rec.vars({ live: up.map((y) => y.name), best: best.name, s: x.name, 's.score': x.score, 'best.score': best.score });
    rec.line('use_wrr', 'wrr_best');
    rec.compare(`${x.name}: score ${signed(x.score)}`, wins ? '>' : '≤', `best ${best.name}: ${signed(best.score)}`, wins ? `${x.name} is the best so far` : `${best.name} stays the best`, { probe });
    rec.markCell(sid(x), 2, 'path');
    rec.markCell(sid(best), 2, 'path');
    if (wins) best = x;
  }
  const total = up.reduce((t, x) => t + x.weight, 0);
  const had = best.score;
  best.score -= total;
  for (const x of up) rec.markCell(sid(x), 2, 'idle');
  rec.markCell(sid(best), 2, 'ok');
  rec.vars({ live: up.map((y) => y.name), best: best.name, 'best.score': best.score });
  rec.line('use_wrr', 'wrr_take');
  rec.step(
    `${best.name} has the highest score, so ${name} goes to ${best.name}, and ${best.name} pays for it: ${signed(had)} − ${total} (the sum of the weights) = ${signed(best.score)}. Over every ${total} requests each server gets exactly its weight, and the heavy one's turns are spread out, not bunched.`,
    { probe },
  );
  rec.markCell(sid(best), 2, 'idle');
  return best;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

function leastConn(s: LBState, rec: Rec, probe: Probe): Server {
  const up = live(s);
  let best = up[0];
  rec.markCell(sid(best), 1, 'compare');
  rec.vars({ live: up.map((y) => y.name), best: best.name, 'len(best.open)': best.open.length });
  rec.line('use_lc', 'lc_start');
  rec.step(`Least connections. Start with ${best.name}, which has ${plural(best.open.length, 'open connection')}, and look for fewer.`, { probe });
  for (const x of up.slice(1)) {
    rec.markCell(sid(x), 1, 'compare');
    const fewer = x.open.length < best.open.length;
    rec.vars({ live: up.map((y) => y.name), best: best.name, 'len(best.open)': best.open.length, s: x.name, 'len(s.open)': x.open.length });
    rec.line('use_lc', 'lc_compare');
    rec.compare(openOf(x), fewer ? '<' : '≥', `best ${openOf(best)}`, fewer ? `${x.name} is the least busy so far` : `${best.name} stays the least busy`, { probe });
    rec.markCell(sid(fewer ? best : x), 1, 'idle');
    if (fewer) best = x;
  }
  rec.markCell(sid(best), 1, 'idle');
  return best;
}

function twoChoices(s: LBState, rec: Rec, probe: Probe): Server {
  const up = live(s);
  if (up.length === 1) {
    rec.vars({ live: [up[0].name] });
    rec.line('use_p2', 'p2_only');
    rec.step(`Power of two choices, but only ${up[0].name} is healthy, so there is nothing to choose between.`, { probe });
    return up[0];
  }
  const i = rand(s, up.length);
  let j = rand(s, up.length - 1);
  if (j >= i) j++;
  const a = up[i];
  const b = up[j];
  for (const x of s.servers) if (x !== a && x !== b) rec.mark(sid(x), 'dim');
  rec.markCell(sid(a), 1, 'compare');
  rec.markCell(sid(b), 1, 'compare');
  rec.vars({ live: up.map((y) => y.name), i, j, a: a.name, b: b.name });
  rec.line('use_p2', 'p2_sample');
  rec.step(`Power of two choices. Two different healthy servers are drawn at random: ${a.name} and ${b.name}. The others are not looked at, so the balancer reads two counts, not ${up.length}.`, { probe });
  const fewer = b.open.length < a.open.length;
  rec.vars({ i, j, a: a.name, b: b.name, 'len(a.open)': a.open.length, 'len(b.open)': b.open.length });
  rec.line('use_p2', 'p2_compare');
  rec.compare(openOf(b), fewer ? '<' : '≥', openOf(a), fewer ? `send to ${b.name}` : `send to ${a.name}`, { probe });
  for (const x of s.servers) rec.unmark(sid(x));
  return fewer ? b : a;
}

function byUser(s: LBState, user: string, rec: Rec, probe: Probe): Server {
  const n = s.servers.length;
  const h = userHash(user);
  let i = h % n;
  rec.mark(sid(s.servers[i]), 'compare');
  rec.vars({ user, n, 'user_hash(user)': h, i });
  rec.line('use_hash', 'hash');
  rec.step(
    `Hash by user. h(${user}) = ${hashSum(user)} = ${h}, and ${h} mod ${n} = ${i}, so ${user} belongs to ${s.servers[i].name}. Every request from ${user} lands on the same server for as long as there are ${n}.`,
    { probe },
  );
  for (;;) {
    const x = s.servers[i];
    rec.mark(sid(x), 'compare');
    if (x.healthy) {
      rec.vars({ user, n, 'user_hash(user)': h, i, 'self.servers[i]': x.name, healthy: true });
      rec.line('use_hash', 'hash_check');
      rec.compare(`server ${x.name}`, '=', 'healthy', `send to ${x.name}`, { probe });
      rec.unmark(sid(x));
      return x;
    }
    i = (i + 1) % n;
    rec.vars({ user, n, 'user_hash(user)': h, i, 'self.servers[i]': s.servers[i].name, healthy: s.servers[i].healthy });
    rec.line('use_hash', 'hash_check', 'hash_spill');
    rec.compare(`server ${x.name}`, '≠', 'healthy', `${x.name} is down: spill to ${s.servers[i].name}, the next server`, { probe });
    rec.mark(sid(x), 'dim');
  }
}

// ---- requests -------------------------------------------------------------------

function tick(s: LBState, rec: Rec, args: Record<string, VarValue> = {}): void {
  s.now++;
  rec.vars({ ...args, 'self.now': s.now });
  const done: { r: Req; x: Server }[] = [];
  for (const x of s.servers) for (const r of x.open) if (r.end <= s.now) done.push({ r, x });
  if (done.length) {
    for (const { r } of done) rec.mark(rid(r), 'ok');
    rec.line('tick', 'done');
    rec.step(
      `Tick ${s.now}. ${list(done.map(({ r, x }) => `${label(r)} on ${x.name}`))} ${done.length === 1 ? 'is' : 'are'} done: the response goes back and the connection closes.`,
    );
    for (const { r } of done) rec.unmark(rid(r));
  }
  for (const x of s.servers) x.open = x.open.filter((r) => r.end > s.now);
}

/** Put a request on its server: the connection opens, then the session is looked up. */
function assign(s: LBState, x: Server, req: Req, rec: Rec, probe: Probe, quiet: boolean): boolean | null {
  const took = req.work * (x.slow ? SLOW : 1);
  req.end = s.now + took;
  x.open.push(req);
  x.served++;
  s.transit = null;
  const name = label(req);
  const at: Probe = { text: name, at: rid(req) };
  rec.markEdge(eid(x), 'path');
  if (!quiet) {
    rec.vars({ req: name, server: x.name, took, 'req.end': req.end, 'len(server.open)': x.open.length });
    rec.line('assign');
    rec.step(
      `${name} goes to ${x.name}, which now has ${plural(x.open.length, 'open connection')}. ` +
        (x.slow ? `${x.name} is slow, so ${ticks(req.work)} of work takes ${took}: it holds the connection until tick ${req.end}.` : `It holds the connection until tick ${req.end}.`),
      { probe: at },
    );
  }
  const hit = touch(x, req.user);
  if (!quiet && hit !== null) {
    const slot = x.sessions.indexOf(req.user!);
    rec.markCell(cid(x), slot, 'ok');
    rec.vars({ req: name, server: x.name, user: req.user, 'server.sessions': x.sessions });
    rec.line('session', 'session_check', hit ? 'session_hit' : 'session_miss');
    rec.step(
      hit
        ? `${req.user}'s session is already in ${x.name}'s cache: a hit, served from memory.`
        : `${x.name} has no session for ${req.user}: a miss. It loads the session from the shared store, one extra round trip, and caches it${hit === false && lastEvicted ? `, pushing out ${lastEvicted}, the least recently used` : ''}.`,
      { probe: at },
    );
    rec.markCell(cid(x), slot, 'idle');
  }
  rec.markEdge(eid(x), 'idle');
  void probe;
  return hit;
}

let lastEvicted: string | null = null;

function touch(x: Server, user: string | null): boolean | null {
  lastEvicted = null;
  if (user === null) return null;
  const i = x.sessions.indexOf(user);
  if (i >= 0) {
    x.sessions.splice(i, 1);
    x.sessions.push(user);
    return true;
  }
  x.sessions.push(user);
  if (x.sessions.length > CACHE) lastEvicted = x.sessions.shift()!;
  return false;
}

/** Route a request that is at the balancer. Returns its server, or null when none is healthy. */
function route(s: LBState, req: Req, rec: Rec): Server | null {
  const name = label(req);
  const probe: Probe = { text: name, at: rid(req) };
  if (rec.recording) s.transit = { req, at: 'lb' };
  const x = pick(s, req, rec, probe);
  if (!x) {
    rec.mark(rid(req), 'bad');
    rec.vars({ req: name, server: null });
    rec.line('unavailable');
    rec.step(`${name} is answered with 503 Service Unavailable. Nothing was healthy to take it.`, { probe });
    rec.unmark(rid(req));
    s.transit = null;
    return null;
  }
  assign(s, x, req, rec, probe, false);
  return x;
}

/** Retry a request in one frame: the choice is made without drawing each comparison. */
function retry(s: LBState, req: Req, rec: Rec, why: string): Server | null {
  rec.count('retries');
  const quiet = muted(rec);
  const x = pick(s, req, quiet, { text: label(req), at: rid(req) });
  const name = label(req);
  rec.line('retry');
  if (!x) {
    rec.vars({ req: name, server: null });
    rec.step(`${name} cannot be retried: no server is healthy. Its client gets 503 Service Unavailable.`);
    return null;
  }
  assign(s, x, req, quiet, { text: name, at: rid(req) }, true);
  rec.mark(rid(req), 'key');
  rec.vars({ req: name, server: x.name, 'req.end': req.end, 'len(server.open)': x.open.length });
  rec.step(`${name} is retried ${why}: ${POLICIES[s.policy]} sends it to ${x.name}, which starts its ${ticks(req.work)} of work again.`, {
    probe: { text: name, at: rid(req) },
  });
  rec.unmark(rid(req));
  return x;
}

/** One request, from `user` (or nobody) needing `work` ticks. Returns the server it went to. */
export function request(s: LBState, user: string | null, work: number, rec: Rec, brief = false): Server | null {
  rec.clearMarks();
  rec.vars();
  tick(s, rec, { user, work });
  const req: Req = { id: ++s.seq, user, work, end: 0 };
  rec.count('requests');
  rec.vars({ user, work, 'self.now': s.now, 'self.seq': s.seq });
  const name = label(req);
  if (rec.recording) s.transit = { req, at: brief ? 'lb' : 'client' };
  rec.mark(rid(req), 'key');
  rec.line('arrive');
  rec.step(
    `${brief ? '' : `Tick ${s.now}. `}${name} arrives${user ? ` from ${user}` : ''}, needing ${ticks(work)} of work. ` +
      (brief ? `The balancer picks a server.` : `The client sends it to the balancer's virtual IP. It never learns which server answers.`),
    { probe: { text: name, at: rid(req) } },
  );
  const x = route(s, req, rec);
  rec.clearMarks();
  s.transit = null;
  return x;
}

/** `count` requests, one per tick. The users are taken in turn. */
function send(s: LBState, count: number, users: (string | null)[], rec: Rec): void {
  for (let k = 0; k < count; k++) {
    request(s, users[k % users.length], DEMO_WORK, rec, true);
  }
}

const spread = (s: LBState) => s.servers.map((x) => `${x.name} ${x.open.length}`).join(', ');

export function burst(s: LBState, count: number, rec: Rec): void {
  rec.clearMarks();
  rec.vars({ count, work: DEMO_WORK });
  rec.line('send');
  rec.step(`${count} requests arrive, one per tick, each needing ${ticks(DEMO_WORK)} of work. Watch where ${POLICIES[s.policy]} sends them.`);
  send(s, count, [null], rec);
  rec.vars({ count, work: DEMO_WORK, 'len(s.open)': s.servers.map((x) => x.open.length) });
  rec.line('sent');
  rec.step(`Open connections now: ${spread(s)}. Served so far: ${s.servers.map((x) => `${x.name} ${x.served}`).join(', ')}.`);
}

/** Complete the oldest request on a server at once. */
export function finish(s: LBState, raw: number | string, rec: Rec): Req | null {
  rec.clearMarks();
  rec.vars({ name: String(raw).trim() });
  const x = findServer(s, raw);
  if (!x) {
    rec.line('idle');
    rec.step(`There is no server called "${String(raw).trim()}". The servers are ${list(s.servers.map((y) => y.name))}.`);
    return null;
  }
  if (!x.open.length) {
    rec.vars({ name: x.name, 's.open': [] });
    rec.line('idle');
    rec.step(`${x.name} has no requests in flight, so there is nothing to finish.`);
    return null;
  }
  const r = x.open[0];
  const name = label(r);
  rec.mark(rid(r), 'key');
  rec.vars({ name: x.name, 's.open': x.open.map(label) });
  rec.line('finish');
  rec.step(`${name} is the oldest request on ${x.name}. It finishes now, ahead of its tick ${r.end}: the response goes back to the client.`, { probe: { text: name, at: rid(r) } });
  x.open.shift();
  rec.clearMarks();
  rec.vars({ name: x.name, 's.open': x.open.map(label) });
  rec.step(`${x.name}'s connection for ${name} closes. ${x.name} has ${plural(x.open.length, 'open connection')} left.`);
  return r;
}

/** Make a server slow, then let traffic flow so the reader sees what the policy does about it. */
export function slow(s: LBState, raw: number | string, rec: Rec): boolean {
  rec.clearMarks();
  rec.vars({ name: String(raw).trim() });
  const x = findServer(s, raw);
  if (!x) {
    rec.line('already');
    rec.step(`There is no server called "${String(raw).trim()}". The servers are ${list(s.servers.map((y) => y.name))}.`);
    return false;
  }
  if (x.slow || !x.answering) {
    rec.vars({ name: x.name, 's.slow': x.slow, 's.answering': x.answering });
    rec.line('already');
    rec.step(x.slow ? `${x.name} is already slow. Recover it to bring it back to full speed.` : `${x.name} is not answering at all, which is worse than slow. Recover it first.`);
    return false;
  }
  x.slow = true;
  for (const r of x.open) r.end = s.now + (r.end - s.now) * SLOW;
  rec.mark(sid(x), 'compare');
  rec.vars({ name: x.name, 's.slow': true, 'self.now': s.now, 'r.end': x.open.map((q) => q.end) });
  rec.line('slow', 'stretch');
  rec.step(
    `${x.name} slows down: a long garbage collection, a noisy neighbour, a cold cache. Everything on it now takes ${SLOW} times as long` +
      (x.open.length ? `, including the ${plural(x.open.length, 'request')} already there. ` : `. `) +
      `It still answers health checks, so the balancer keeps it in rotation. Now ${SLOW_DEMO} requests arrive.`,
  );
  rec.unmark(sid(x));
  send(s, SLOW_DEMO, [null], rec);
  const others = s.servers.filter((y) => y !== x && y.healthy);
  const busiestOther = Math.max(0, ...others.map((y) => y.open.length));
  rec.mark(sid(x), 'compare');
  rec.vars({ name: x.name, count: SLOW_DEMO, 'len(s.open)': s.servers.map((y) => y.open.length) });
  rec.line('sent');
  rec.step(
    `Open connections: ${spread(s)}. ` +
      (x.open.length > busiestOther
        ? `${x.name} is piling up. ${s.policy === RR || s.policy === WRR || s.policy === HASH ? `${cap(POLICIES[s.policy])} does not look at load, so it keeps handing ${x.name} its share, and every one of those requests waits ${SLOW} times longer. Switch to least connections and the balancer steers around it.` : `Even so, ${POLICIES[s.policy]} sends ${x.name} only what it can see it is able to take.`}`
        : `${POLICIES[s.policy]} saw ${x.name}'s connections stay open and sent new work elsewhere, so ${x.name} is no busier than the others.`),
  );
  rec.clearMarks();
  return true;
}

/** Probe a server once and narrate the count against the threshold. Returns true when its state changed. */
function healthCheck(x: Server, rec: Rec): boolean {
  rec.markEdge(eid(x), 'compare');
  rec.mark(sid(x), 'compare');
  if (!x.answering) {
    x.passes = 0;
    x.misses++;
    const out = x.healthy && x.misses >= FALL;
    rec.vars({ s: x.name, 's.answering': false, 's.misses': x.misses, 's.passes': 0, 's.healthy': out ? false : x.healthy });
    rec.line('check', 'probe', 'miss', 'fall');
    rec.compare(`${x.name}: ${plural(x.misses, 'miss', 'misses')}`, out ? '≥' : '<', `fall ${FALL}`, out ? `take ${x.name} out of rotation` : `keep ${x.name} in for now: one miss could be a dropped packet`, {
      message: out
        ? `Health check: GET /health on ${x.name} times out again. That is ${x.misses} in a row, which reaches the threshold of ${FALL}: take ${x.name} out of rotation.`
        : `Health check: GET /health on ${x.name} times out. ${plural(x.misses, 'miss', 'misses')} in a row is under the threshold of ${FALL}, and one miss could be a dropped packet, so ${x.name} stays in rotation for now.`,
    });
    if (out) x.healthy = false;
    rec.markEdge(eid(x), 'idle');
    rec.unmark(sid(x));
    return out;
  }
  x.misses = 0;
  x.passes++;
  const back = !x.healthy && x.passes >= RISE;
  rec.vars({ s: x.name, 's.answering': true, 's.misses': 0, 's.passes': x.passes, 's.healthy': back ? true : x.healthy });
  rec.line('check', 'pass', 'rise');
  rec.compare(`${x.name}: ${plural(x.passes, 'pass', 'passes')}`, back ? '≥' : '<', `rise ${RISE}`, back ? `put ${x.name} back` : `keep ${x.name} out until it passes again`, {
    message: back
      ? `Health check: ${x.name} answers 200 again. ${x.passes} passes in a row reaches the threshold of ${RISE}: put it back.`
      : `Health check: ${x.name} answers 200. One pass is not enough to trust it after a failure, so it stays out until it reaches ${RISE}.`,
  });
  if (back) x.healthy = true;
  rec.markEdge(eid(x), 'idle');
  rec.unmark(sid(x));
  return back;
}

/** A server stops answering. Health checks notice, it is taken out, and its in-flight requests are retried. */
export function fail(s: LBState, raw: number | string, rec: Rec): number {
  rec.clearMarks();
  rec.vars({ name: String(raw).trim() });
  const x = findServer(s, raw);
  if (!x) {
    rec.line('already');
    rec.step(`There is no server called "${String(raw).trim()}". The servers are ${list(s.servers.map((y) => y.name))}.`);
    return 0;
  }
  if (!x.answering) {
    rec.vars({ name: x.name, 's.answering': false });
    rec.line('already');
    rec.step(`${x.name} has already stopped answering${x.healthy ? '' : ' and is marked down'}.`);
    return 0;
  }
  x.answering = false;
  rec.mark(sid(x), 'bad');
  rec.vars({ name: x.name, 's.answering': false, 's.healthy': x.healthy });
  rec.line('stop');
  rec.step(`${x.name} stops answering: the process has hung or the machine has gone. The balancer does not know yet. To it, ${x.name} is still healthy. This page pauses traffic while the health checks run, every 2 seconds or so in a real setup.`);
  rec.unmark(sid(x));
  while (x.healthy) healthCheck(x, rec);
  rec.mark(sid(x), 'bad');
  rec.markEdge(eid(x), 'bad');
  rec.vars({ name: x.name, 's.answering': false, 's.misses': x.misses, 's.healthy': false });
  rec.line('down');
  rec.step(`${x.name} is marked down. New requests skip it. Between the first miss and now, requests would still have been sent to ${x.name} and failed: that gap is why balancers also watch real traffic (passive checks).`);
  const lost = [...x.open];
  for (const r of lost) rec.mark(rid(r), 'bad');
  if (lost.length || x.sessions.length) {
    x.sessions.forEach((_u, i) => rec.markCell(cid(x), i, 'bad'));
    rec.vars({ name: x.name, lost: lost.map(label), 's.open': [], 's.sessions': [] });
    rec.line('lost');
    rec.step(
      (lost.length
        ? `${list(lost.map(label))} ${lost.length === 1 ? 'was' : 'were'} in flight on ${x.name}. ${lost.length === 1 ? 'Its connection times' : 'Their connections time'} out. `
        : `Nothing was in flight on ${x.name}. `) +
        (x.sessions.length ? `The ${plural(x.sessions.length, 'session')} cached on ${x.name} (${list(x.sessions)}) ${x.sessions.length === 1 ? 'is' : 'are'} gone with it.` : ''),
    );
  }
  rec.count('lost', x.sessions.length);
  x.open = [];
  x.sessions = [];
  rec.clearMarks();
  for (const r of lost) retry(s, r, rec, `on another server (safe only because it is idempotent)`);
  rec.clearMarks();
  rec.vars({ name: x.name, lost: lost.map(label), 'len(lost)': lost.length });
  rec.line('retried');
  rec.step(`${x.name} is out. ${plural(lost.length, 'request')} retried. Open connections: ${spread(s)}. Recover ${x.name} to watch it come back.`);
  return lost.length;
}

/** A server answers again (and is no longer slow). Health checks bring it back. */
export function recover(s: LBState, raw: number | string, rec: Rec): boolean {
  rec.clearMarks();
  rec.vars({ name: String(raw).trim() });
  const x = findServer(s, raw);
  if (!x) {
    rec.line('answer');
    rec.step(`There is no server called "${String(raw).trim()}". The servers are ${list(s.servers.map((y) => y.name))}.`);
    return false;
  }
  if (x.answering && x.healthy && !x.slow) {
    rec.vars({ name: x.name, 's.answering': true, 's.slow': false, 's.healthy': true });
    rec.line('answer');
    rec.step(`${x.name} is healthy and at full speed. There is nothing to recover.`);
    return false;
  }
  const wasSlow = x.slow;
  x.answering = true;
  x.slow = false;
  rec.mark(sid(x), 'ok');
  rec.vars({ name: x.name, 's.answering': true, 's.slow': false, 's.healthy': x.healthy });
  rec.line('answer');
  rec.step(
    x.healthy
      ? `${x.name} is back to full speed. New requests take their normal time; the ones already there keep the finish times they were given.`
      : `${x.name} answers again${wasSlow ? ' at full speed' : ''}. The balancer still has it marked down until the health checks agree.`,
  );
  rec.unmark(sid(x));
  if (!x.healthy) {
    while (!x.healthy) healthCheck(x, rec);
    rec.mark(sid(x), 'ok');
    rec.vars({ s: x.name, 's.answering': true, 's.misses': 0, 's.passes': x.passes, 's.healthy': true });
    rec.line('up');
    rec.step(
      `${x.name} is back in rotation with ${plural(x.open.length, 'open connection')}. Under least connections it would now take every new request until it caught up. Real balancers can ramp a returning server up gently instead (slow start).`,
    );
    rec.clearMarks();
  }
  return true;
}

/** Add a server. Under hash by user, most users move and lose their cached session. */
export function scale(s: LBState, rec: Rec): number {
  rec.clearMarks();
  rec.vars();
  if (s.servers.length >= MAX_SERVERS) {
    rec.vars({ 'len(self.servers)': s.servers.length });
    rec.line('add');
    rec.step(`This drawing stops at ${MAX_SERVERS} servers. A real pool can be far larger.`);
    return 0;
  }
  const before = s.servers.length;
  const x = newServer(before);
  s.servers.push(x);
  rec.mark(sid(x), 'ok');
  rec.vars({ name: x.name, weight: x.weight, 'len(self.servers)': s.servers.length, 'self.policy': POLICIES[s.policy] });
  rec.line('add');
  rec.step(`Server ${x.name} joins the pool${s.policy === WRR ? ` with weight ${x.weight}` : ''}. It starts empty: no connections and no cached sessions. The balancer now has ${s.servers.length} servers to choose from.`);
  rec.unmark(sid(x));
  if (s.policy !== HASH) {
    rec.vars({ name: x.name, weight: x.weight, 'len(self.servers)': s.servers.length, 'self.policy': POLICIES[s.policy], lost: 0 });
    rec.line('no_pin');
    rec.step(`Under ${POLICIES[s.policy]} no user is tied to a server, so nothing moves and no session is lost. The other side of that: each user's requests were already scattered, so their sessions were cached in several places, or loaded again each time.`);
    return 0;
  }
  const lost: { x: Server; user: string }[] = [];
  let checked = 0;
  for (const y of s.servers) {
    for (const user of [...y.sessions]) {
      checked++;
      const slot = y.sessions.indexOf(user);
      const now = home(s, user)!;
      const h = userHash(user);
      const moved = now !== y;
      rec.markCell(cid(y), slot, 'compare');
      rec.vars({ name: x.name, s: y.name, user, 'by_user(user)': now.name, lost: lost.length });
      rec.line('moved');
      rec.compare(`${user}: ${h} mod ${s.servers.length} → ${now.name}`, moved ? '≠' : '=', `cached on ${y.name}`, moved ? `${user} now goes to ${now.name}: the session on ${y.name} is lost` : `${user} stays on ${y.name}`, {
        message: moved
          ? `h(${user}) = ${h}. ${user} has been going to ${y.name}. With ${s.servers.length} servers, ${h} mod ${s.servers.length} = ${h % s.servers.length}${now.name !== s.servers[h % s.servers.length].name ? `, down, so on to ${now.name}` : `: ${now.name}`}. ${user}'s session on ${y.name} is useless now.`
          : `h(${user}) = ${h}. ${h} mod ${s.servers.length} still lands on ${y.name}${now !== s.servers[h % s.servers.length] ? ` (after spilling past a down server)` : ''}, so ${user} keeps its session.`,
      });
      rec.markCell(cid(y), slot, moved ? 'bad' : 'ok');
      if (moved) lost.push({ x: y, user });
    }
  }
  if (lost.length) {
    rec.vars({ name: x.name, lost: lost.length });
    rec.line('lose');
    rec.step(`${list(lost.map((l) => l.user))} lose their sessions. Their next requests are cache misses on new servers, all at once, which lands on the session store as a burst.`);
    for (const l of lost) l.x.sessions = l.x.sessions.filter((u) => u !== l.user);
    rec.count('lost', lost.length);
  }
  rec.clearMarks();
  rec.vars({ name: x.name, lost: lost.length });
  rec.line('scaled');
  rec.step(
    `${lost.length} of ${plural(checked, 'cached user')} moved. Going from ${before} to ${s.servers.length} servers, h mod n keeps a user in place only about 1 time in ${s.servers.length}. Consistent hashing (its own page on this site) turns that round: only about 1 in ${s.servers.length} users move, the share the new server takes.`,
  );
  return lost.length;
}

/** Switch the policy, then send a few requests to show it at work. */
export function setPolicy(s: LBState, raw: number | string, rec: Rec): boolean {
  rec.clearMarks();
  rec.vars();
  const p = parsePolicy(raw);
  rec.vars({ policy: p === null ? String(raw).trim() : POLICIES[p] });
  if (p === null) {
    rec.line('policy');
    rec.step(`"${String(raw).trim()}" is not a policy here. Try round, weighted, least, two or hash.`);
    return false;
  }
  const was = s.policy;
  s.policy = p;
  for (const x of s.servers) x.score = 0;
  rec.vars({ policy: POLICIES[p], 'self.policy': POLICIES[p], 's.score': s.servers.map((x) => x.score) });
  rec.line('policy');
  rec.step(
    (p === was ? `The balancer already uses ${POLICIES[p]}. ` : `The balancer switches from ${POLICIES[was]} to ${POLICIES[p]}, as a config reload would. Requests in flight stay where they are. `) +
      (p === HASH ? `${STICKY_DEMO.length} requests arrive, from ${list([...new Set(STICKY_DEMO)])}: ${STICKY_DEMO[0]} sends two.` : `${POLICY_DEMO} requests arrive.`),
  );
  const servedBefore = s.servers.map((x) => x.served);
  send(s, p === HASH ? STICKY_DEMO.length : POLICY_DEMO, p === HASH ? STICKY_DEMO : [null], rec);
  const got = s.servers.map((x, i) => `${x.name} ${x.served - servedBefore[i]}`).join(', ');
  rec.vars({ policy: POLICIES[p], 'self.policy': POLICIES[p], 'len(s.open)': s.servers.map((x) => x.open.length) });
  rec.line('sent');
  rec.step(
    p === HASH
      ? `${STICKY_DEMO[0]}'s two requests landed on the same server, and the second found the session cached. That is sticky routing. The cost: the hash ignores load, so a busy or slow server keeps its users.`
      : `Of the ${POLICY_DEMO} requests: ${got}. Open connections now: ${spread(s)}.` +
          (p === LEAST || p === TWO ? ` A server whose requests are slow keeps its connections open, so it reads as busy and gets less new work.` : ''),
  );
  return true;
}

/** The active balancer dies. The standby notices the missing heartbeats and takes over the virtual IP. */
export function failLb(s: LBState, rec: Rec): number {
  rec.clearMarks();
  rec.vars();
  const dead = s.active;
  const standby = 1 - dead;
  const [deadName, newName] = [s.lbNames[dead], s.lbNames[standby]];
  s.lbDown = dead;
  rec.mark(lid(dead), 'bad');
  rec.markEdge('hb', 'bad');
  rec.vars({ 'self.active': deadName, 'self.standby': newName, 'self.missed': 0 });
  rec.line('heartbeat');
  rec.step(`${deadName}, the active balancer, crashes. It stops sending heartbeats to ${newName}, the standby, which expects one every second.`);
  s.missed = 0;
  while (s.missed < MISSED) {
    s.missed++;
    const enough = s.missed >= MISSED;
    rec.mark(lid(standby), 'compare');
    rec.vars({ 'self.active': deadName, 'self.standby': newName, 'self.missed': s.missed, ok: false });
    rec.line('heartbeat', 'missed');
    rec.compare(`missed ${s.missed}`, enough ? '≥' : '<', `limit ${MISSED}`, enough ? `${deadName} is dead: take over` : `wait: a heartbeat can be lost on its own`);
  }
  s.active = standby;
  rec.mark(lid(standby), 'ok');
  rec.vars({ 'self.active': newName, 'self.standby': deadName, 'self.missed': s.missed });
  rec.line('takeover');
  rec.step(`${newName} takes over the virtual IP and announces it with a gratuitous ARP, so the network now delivers the VIP's traffic to ${newName}. Clients still use the same address and change nothing. On this page the active balancer is always drawn beside the VIP, so the two swap places.`);
  const lost: Req[] = [];
  for (const x of s.servers) lost.push(...x.open);
  lost.sort((a, b) => a.id - b.id);
  for (const r of lost) rec.mark(rid(r), 'bad');
  rec.vars({ 'self.active': newName, 'self.standby': deadName, lost: lost.map(label) });
  rec.line('cut');
  rec.step(
    lost.length
      ? `${list(lost.map(label))} ${lost.length === 1 ? 'was' : 'were'} in flight through ${deadName}. This balancer is a layer 7 proxy, so it held both ends of every connection, and they died with it. The clients retry.`
      : `Nothing was in flight, so no connection was cut.`,
  );
  for (const x of s.servers) x.open = [];
  rec.clearMarks();
  rec.mark(lid(dead), 'bad');
  for (const r of lost) retry(s, r, rec, `by its client through ${newName}`);
  s.missed = 0;
  s.lbDown = null;
  rec.clearMarks();
  rec.vars({ 'self.active': newName, 'self.standby': deadName, 'self.missed': 0, 'len(lost)': lost.length });
  rec.line('retried');
  rec.step(`${newName} is active. ${plural(lost.length, 'request')} retried. On this page ${deadName} is restarted at once and rejoins as the standby; in life that takes an operator or an orchestrator.`);
  return lost.length;
}

// ---- layout -----------------------------------------------------------------------

const ROW_Y = [104, 188, 272, 356];
const SRV_LEFT = 310;
const CACHE_LEFT = 510;
const SLOT_W = 46;
const CHIP_W = 52;
const PILE_X = [700, 756, 812];
const SERVED_X = 846;
const NEXT_X = 272;
const LB_X = 190;
const LB_Y = [210, 350];
const CLIENT = { x: 48, y: 240 };
const VIP_X = 124;
const WIDTH = 940;
const HEIGHT = 404;

function serverCells(s: LBState, x: Server) {
  const status = !x.answering ? (x.healthy ? 'no reply' : 'down') : !x.healthy ? 'checking' : x.slow ? 'slow' : 'up';
  const cells = [
    { text: s.policy === WRR ? `${x.name}×${x.weight}` : x.name, sub: status, w: s.policy === WRR ? 52 : 40 },
    { text: String(x.open.length), sub: 'open', w: 40 },
  ];
  if (s.policy === WRR) {
    cells.push({ text: signed(x.score), sub: 'score', w: 46 });
  }
  return cells;
}

/** A tray's width from its cells, as geometry draws it. */
const trayW = (ws: number[]) => (ws.length > 1 ? 8 + ws.reduce((a, b) => a + b, 0) + 3 * (ws.length - 1) : ws[0]);

export function layout(s: LBState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [
    { id: 'corner-a', type: 'label', x: 0, y: 12, text: '' },
    { id: 'corner-b', type: 'label', x: WIDTH, y: HEIGHT, text: '' },
    { id: 'h-servers', type: 'label', x: SRV_LEFT, y: 44, text: 'Servers', anchor: 'start', strong: true },
    { id: 'h-cache', type: 'label', x: CACHE_LEFT, y: 44, text: 'Session cache', anchor: 'start', strong: true },
    { id: 'h-open', type: 'label', x: PILE_X[0] - CHIP_W / 2, y: 44, text: 'In flight, oldest first', anchor: 'start', strong: true },
  ];

  nodes.push({ id: 'clients', x: CLIENT.x, y: CLIENT.y, cells: [{ text: 'clients' }] });

  // The active balancer always sits in the upper place, beside the VIP. On a failover the two swap places.
  for (const slot of [0, 1]) {
    const y = slot === s.active ? LB_Y[0] : LB_Y[1];
    nodes.push({ id: lid(slot), x: LB_X, y, cells: [{ text: s.lbNames[slot] }], tone: s.lbDown === slot ? 'bad' : undefined });
    if (slot !== s.active) {
      decor.push({ id: 'role', type: 'label', x: LB_X - 42, y: y + 5, text: s.lbDown === slot ? 'down' : 'standby', anchor: 'end' });
    }
  }
  nodes.push({ id: 'vip', x: VIP_X, y: LB_Y[0], cells: [{ text: 'VIP' }], shape: 'tag' });
  edges.push({ id: 'hb', from: lid(s.active), to: lid(1 - s.active), kind: 'line', dashed: true, arrow: true });
  decor.push({ id: 'hb-label', type: 'label', x: LB_X - 8, y: (LB_Y[0] + LB_Y[1]) / 2 + 5, text: 'heartbeats', anchor: 'end' });

  s.servers.forEach((x, i) => {
    const y = ROW_Y[i];
    const cells = serverCells(s, x);
    const w = trayW(cells.map((c) => c.w));
    nodes.push({ id: sid(x), x: SRV_LEFT + w / 2, y, cells, tone: x.healthy ? undefined : 'bad' });
    edges.push({ id: eid(x), from: lid(s.active), to: sid(x), kind: 'line', toCell: 0, arrow: true, dashed: !x.healthy, tone: x.healthy ? undefined : 'dim' });

    const cache = Array.from({ length: CACHE }, (_, k) => ({ text: x.sessions[k] ?? '', w: SLOT_W }));
    nodes.push({ id: cid(x), x: CACHE_LEFT + trayW(cache.map((c) => c.w)) / 2, y, cells: cache });

    const pile: (Req | number)[] = x.open.length <= PILE ? [...x.open] : [x.open[0], x.open.length - 2, x.open[x.open.length - 1]];
    pile.forEach((p, k) => {
      if (typeof p === 'number') nodes.push({ id: `more-${x.name}`, x: PILE_X[k], y, cells: [{ text: `+${p}`, w: CHIP_W, tone: 'dim' }] });
      else nodes.push({ id: rid(p), x: PILE_X[k], y, cells: [{ text: label(p), w: CHIP_W }] });
    });
    decor.push({ id: `served-${x.name}`, type: 'label', x: SERVED_X, y: y + 5, text: `${x.name} served ${x.served}`, anchor: 'start' });
  });

  if (s.policy === RR || s.policy === HASH) {
    const i = Math.min(s.next, s.servers.length - 1);
    nodes.push({ id: 'ptr-next', x: NEXT_X, y: ROW_Y[i], cells: [{ text: 'next' }], shape: 'tag' });
  }

  if (s.transit) {
    const { req, at } = s.transit;
    const pos = at === 'client' ? { x: CLIENT.x, y: CLIENT.y - 58 } : { x: LB_X, y: LB_Y[0] - 58 };
    nodes.push({ id: rid(req), x: pos.x, y: pos.y, cells: [{ text: label(req), w: CHIP_W }], from: at === 'client' ? 'clients' : undefined });
  }
  return { nodes, edges, decor };
}

// ---- definition -------------------------------------------------------------------

const SERVER_ARG = { name: 'server', label: 'Server', kind: 'word' } as const;

function busiest(s: LBState): string {
  let best = s.servers[0];
  for (const x of s.servers) if (x.open.length > best.open.length) best = x;
  return best.name.toLowerCase();
}

const def: StructureDef<LBState> = {
  id: 'load-balancing',
  params: [
    { id: 'policy', label: 'Policy', default: RR, options: POLICIES.map((p, i) => ({ value: i, label: p.charAt(0).toUpperCase() + p.slice(1) })) },
    { id: 'servers', label: 'Servers', default: 3, options: [3, 4].map((v) => ({ value: v, label: `${v} servers` })) },
  ],
  create: (p) => create(p.servers ?? 3, p.policy ?? RR),
  seed: [],
  ops: [
    {
      id: 'request',
      label: 'Request',
      intent: 'primary',
      args: [
        { name: 'user', label: 'User (or anon)', kind: 'word' },
        { name: 'work', label: 'Ticks of work', kind: 'int', min: 1, max: 9 },
      ],
      code: ['request', 'pick', 'round_robin', 'weighted', 'least_conn', 'two_choices', 'by_user', 'session', 'tick'],
      run: (s, [u, w], rec) => {
        const word = String(u).trim().toLowerCase();
        void request(s, word === 'anon' || word === 'none' || word === '' ? null : word, Number(w), rec);
      },
      suggest: () => [randomInt(0, 3) === 0 ? 'anon' : USERS[randomInt(0, USERS.length - 1)], randomInt(2, 4)],
    },
    {
      id: 'burst',
      label: 'Send several',
      args: [{ name: 'count', label: 'Requests', kind: 'int', min: 2, max: 6 }],
      code: ['burst', 'request', 'pick', 'round_robin', 'weighted', 'least_conn', 'two_choices', 'by_user', 'tick'],
      run: (s, [n], rec) => burst(s, Number(n), rec),
      suggest: () => [randomInt(3, 5)],
    },
    { id: 'finish', label: 'Finish oldest', args: [SERVER_ARG], code: ['finish'], run: (s, [n], rec) => void finish(s, n, rec), suggest: (s) => [busiest(s)] },
    {
      id: 'slow',
      label: 'Make slow',
      args: [SERVER_ARG],
      code: ['slow', 'burst', 'request', 'pick', 'round_robin', 'weighted', 'least_conn', 'two_choices', 'by_user', 'tick'],
      run: (s, [n], rec) => void slow(s, n, rec),
      suggest: (s) => [(s.servers.find((x) => x.healthy && x.answering && !x.slow) ?? s.servers[0]).name.toLowerCase()],
    },
    {
      id: 'fail',
      label: 'Fail',
      intent: 'danger',
      args: [SERVER_ARG],
      code: ['fail', 'health_check', 'pick', 'request'],
      run: (s, [n], rec) => void fail(s, n, rec),
      suggest: (s) => [(s.servers.find((x) => x.answering && x.open.length) ?? s.servers.find((x) => x.answering) ?? s.servers[0]).name.toLowerCase()],
    },
    {
      id: 'recover',
      label: 'Recover',
      args: [SERVER_ARG],
      code: ['recover', 'health_check'],
      run: (s, [n], rec) => void recover(s, n, rec),
      suggest: (s) => [(s.servers.find((x) => !x.answering || !x.healthy || x.slow) ?? s.servers[0]).name.toLowerCase()],
    },
    { id: 'scale', label: 'Add a server', args: [], code: ['scale', 'by_user'], run: (s, _a, rec) => void scale(s, rec) },
    { id: 'fail_lb', label: 'Fail the balancer', intent: 'danger', args: [], code: ['fail_lb', 'pick', 'request'], run: (s, _a, rec) => void failLb(s, rec) },
    {
      id: 'policy',
      label: 'Switch policy',
      args: [{ name: 'policy', label: 'Policy', kind: 'word' }],
      code: ['use', 'burst', 'request', 'pick', 'round_robin', 'weighted', 'least_conn', 'two_choices', 'by_user', 'session', 'tick'],
      run: (s, [p], rec) => void setPolicy(s, p, rec),
      suggest: (s) => [['round', 'weighted', 'least', 'two', 'hash'][(s.policy + 1 + randomInt(0, 3)) % 5]],
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'requests', label: 'Requests' },
    { key: 'retries', label: 'Retries' },
    { key: 'lost', label: 'Sessions lost' },
  ],
  status: (s) => [
    { label: 'Policy', value: POLICIES[s.policy] },
    { label: 'Clock', value: `tick ${s.now}` },
    { label: 'Open connections', value: spread(s) },
    { label: 'Served (the spread)', value: s.servers.map((x) => `${x.name} ${x.served}`).join(', ') },
  ],
  tour: [['burst', 3], ['slow', 'b'], ['policy', 'least'], ['policy', 'hash'], ['fail', 'c'], ['scale']],
  source: { python, java },
  info,
};

export default def;
