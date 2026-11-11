import { LABEL_MAX } from '../../core/fit';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/RealtimePush.java?raw';
import python from './code/realtime_push.py?raw';
import { info } from './info';

/**
 * How a server gets new data to a client: short polling, long polling,
 * server-sent events and WebSocket, run on one deterministic clock.
 *
 * The server numbers its messages m1, m2 and so on. The client remembers the
 * highest number it has (`seen`) and every method is a different way of
 * getting the ones after it across. `rows` is the page's sequence diagram:
 * what went over the wire, newest at the bottom. A real client and server keep
 * only `seen` and their connection.
 */
export type Method = 'short' | 'long' | 'sse' | 'ws';
export const METHODS: Method[] = ['short', 'long', 'sse', 'ws'];
export const METHOD_NAME: Record<Method, string> = { short: 'short polling', long: 'long polling', sse: 'server-sent events', ws: 'WebSocket' };
/** The word to type for each method in Replay. */
export const METHOD_WORD: Record<Method, string> = { short: 'short', long: 'long', sse: 'sse', ws: 'websocket' };

/** Ticks a long poll is held before it comes back empty: the proxy's idle timeout in this model. */
export const TIMEOUT = 6;
/** An idle stream or socket sends a heartbeat after this many quiet ticks, inside the proxy's timeout. */
export const HEARTBEAT = 5;
/** Ticks a client waits before reconnecting after a drop. */
export const RETRY = 1;
/** Replay: messages arrive at these ticks, and the clock runs to PLAY. */
export const PLAN = [2, 7];
export const PLAY = 9;
/** Rows of the sequence diagram drawn at once. */
export const ROWS = 7;
/** Messages drawn in the strip on the right. */
export const SHOWN = 5;
export const MAX_TICK = 999;
export const MAX_MISSED = 3;

export type Dir = 'up' | 'down' | 'note' | 'cut';
export interface Row {
  seq: number;
  /** Tick it happened. */
  t: number;
  /** up: client to server. down: server to client. note: a message reaches the server. cut: the connection broke. */
  dir: Dir;
  /** What went over the wire, drawn on the arrow. */
  text: string;
  /** The messages it carries, drawn at the server end. */
  carry: string;
  tone?: Tone;
}

export interface Msg {
  name: string;
  kind: 'server' | 'client';
  /** Tick it reached the server (a server message) or was sent (a client message). */
  at: number;
  /** Tick the client had it. Null while it waits at the server. */
  out: number | null;
}

export interface PushState {
  method: Method;
  /** Short polling interval, in ticks. */
  every: number;
  now: number;
  /** arrived[i] is the tick message i + 1 reached the server. */
  arrived: number[];
  /** Ticks at which messages are due, for Replay. Empty otherwise. */
  plan: number[];
  /** Highest message id the client has. */
  seen: number;
  /** A held request, a stream or a socket is open. Under short polling: the client is polling. */
  open: boolean;
  /** Last time the connection carried anything. */
  since: number;
  nextPoll: number;
  requests: number;
  empty: number;
  delays: number[];
  /** Client messages the server has. */
  received: number;
  rows: Row[];
  rowSeq: number;
  msgs: Msg[];
  /** Row of the long poll being held, if it is still drawn. */
  held: number | null;
  /** Set while a dropped connection is down. */
  broken: boolean;
}

export function create(method: Method = 'long', every = 3): PushState {
  return {
    method,
    every,
    now: 0,
    arrived: [],
    plan: [],
    seen: 0,
    open: false,
    since: 0,
    nextPoll: 0,
    requests: 0,
    empty: 0,
    delays: [],
    received: 0,
    rows: [],
    rowSeq: 0,
    msgs: [],
    held: null,
    broken: false,
  };
}

export function asMethod(raw: number | string): Method | null {
  const w = String(raw).trim().toLowerCase().replace(/[\s-]/g, '');
  if (w === 'short' || w === 'shortpolling' || w === 'poll' || w === 'polling') return 'short';
  if (w === 'long' || w === 'longpolling') return 'long';
  if (w === 'sse' || w === 'serversentevents' || w === 'eventsource') return 'sse';
  if (w === 'ws' || w === 'websocket' || w === 'websockets' || w === 'socket') return 'ws';
  return null;
}

/** Ids of the messages the client does not have yet. */
export const newer = (s: PushState): number[] => Array.from({ length: s.arrived.length - s.seen }, (_, i) => s.seen + 1 + i);
export const average = (s: PushState): number | null => (s.delays.length ? s.delays.reduce((a, b) => a + b, 0) / s.delays.length : null);
export const openConnections = (s: PushState): number => (s.method !== 'short' && s.open ? 1 : 0);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ticks = (n: number) => plural(n, 'tick');
const names = (ids: number[]) => ids.map((i) => `m${i}`).join(', ');
/** What the server end of a row shows: two names at most, or a range. */
const carryOf = (ids: number[]) => (ids.length <= 2 ? ids.map((i) => `m${i}`).join(' ') : `m${ids[0]}–m${ids[ids.length - 1]}`);

// ---- ids ----------------------------------------------------------------------

const rowC = (seq: number) => `r${seq}c`;
const rowS = (seq: number) => `r${seq}s`;
const rowE = (seq: number) => `r${seq}e`;
const msgId = (name: string) => `msg-${name}`;
const atServer = (row: Row, text: string): Probe => ({ text, at: rowS(row.seq), place: 'right' });
const atClient = (row: Row, text: string): Probe => ({ text, at: rowC(row.seq), place: 'left' });

function addRow(s: PushState, dir: Dir, text: string, carry = '', tone?: Tone): Row {
  const row: Row = { seq: ++s.rowSeq, t: s.now, dir, text, carry, tone };
  s.rows.push(row);
  if (s.rows.length > ROWS) s.rows.splice(0, s.rows.length - ROWS);
  return row;
}

function addMsg(s: PushState, m: Msg): void {
  s.msgs.push(m);
  if (s.msgs.length > SHOWN) s.msgs.splice(0, s.msgs.length - SHOWN);
}

/** Client: keep each message and note how long it waited at the server. */
function take(s: PushState, ids: number[], rec: Rec): number[] {
  const waits: number[] = [];
  for (const i of ids) {
    const d = s.now - s.arrived[i - 1];
    s.delays.push(d);
    s.seen = i;
    waits.push(d);
    const m = s.msgs.find((x) => x.name === `m${i}`);
    if (m) m.out = s.now;
    rec.count('delivered');
    rec.count('waited', d);
  }
  return waits;
}

function follow(rec: Rec, name: string, ...nodes: string[]): void {
  rec.mark(msgId(name), 'key');
  for (const n of nodes) rec.mark(n, 'key');
}

function unfollow(rec: Rec, name: string, ...nodes: string[]): void {
  rec.unmark(msgId(name));
  for (const n of nodes) rec.unmark(n);
}

// ---- the methods ---------------------------------------------------------------

type Cause = 'open' | 'repoll' | 'reopen' | 'reconnect' | 'start';
const LEAD: Record<Cause, string[]> = { open: ['open'], repoll: ['repoll'], reopen: ['reopen'], reconnect: ['reconnect'], start: ['start'] };

/** Short polling: one ordinary request, answered at once, empty or not. */
function poll(s: PushState, rec: Rec, lead: string[]): void {
  s.requests++;
  rec.count('requests');
  const after = s.seen;
  const up = addRow(s, 'up', `GET /poll?after=${after}`);
  rec.line(...lead, 'ask');
  rec.step(
    `Tick ${s.now}: the client polls. GET /poll?after=${after} is an ordinary request: open, send the headers, wait for the answer. after=${after} tells the server which messages the client already has.`,
  );
  const fresh = newer(s);
  if (!fresh.length) {
    addRow(s, 'down', '200 []', '', 'bad');
    s.empty++;
    rec.count('empty');
    s.nextPoll = s.now + s.every;
    rec.line('check', 'answer', 'empty', 'schedule');
    rec.step(
      `Nothing is newer than ${after}, so the server answers at once with 200 and an empty list. A wasted round trip: a full set of headers each way and no news. The next poll is due at tick ${s.nextPoll}.`,
    );
    return;
  }
  const first = `m${fresh[0]}`;
  follow(rec, first);
  rec.line('check', 'newer');
  rec.compare(`id ${fresh[0]}`, '>', `after ${after}`, `send ${names(fresh)}`, {
    probe: atServer(up, first),
    message: `${first} has id ${fresh[0]}, newer than the ${after} the client asked after, so it goes in this answer${fresh.length > 1 ? ` with ${names(fresh.slice(1))}` : ''}.`,
  });
  const down = addRow(s, 'down', `200 [${names(fresh)}]`, carryOf(fresh), 'ok');
  const waits = take(s, fresh, rec);
  s.nextPoll = s.now + s.every;
  rec.mark(rowS(down.seq), 'key');
  rec.markEdge(rowE(down.seq), 'key');
  rec.line('answer', 'got', 'delay', 'schedule');
  rec.step(
    `200 [${names(fresh)}] goes back and the client has ${first}. It reached the server at tick ${s.arrived[fresh[0] - 1]} and sat there ${ticks(waits[0])} until this poll asked. That wait is the price of polling: on average about half the interval.`,
    { probe: atClient(down, first) },
  );
  unfollow(rec, first, rowS(down.seq));
  rec.markEdge(rowE(down.seq), 'ok');
}

/** Server: hand new messages to whatever is open. `followed` is set when one message is being followed in. */
function push(s: PushState, rec: Rec, lead: string[], followed?: { name: string; note: Row }): void {
  if (s.method === 'short') {
    if (!followed) return;
    const { name, note } = followed;
    if (!s.open) {
      rec.line(...lead, 'wait_poll');
      rec.step(`Nothing is open, and short polling never pushes anyway. ${name} waits at the server for the client's next request.`, { probe: atServer(note, name) });
      return;
    }
    const wait = s.nextPoll - s.now;
    rec.line(...lead, 'wait_poll');
    rec.compare(`${name} at tick ${s.now}`, '<', `next poll at ${s.nextPoll}`, `${name} waits ${ticks(wait)}`, {
      probe: atServer(note, name),
      message: `The server cannot tell the client. Short polling only answers when asked, and the next poll is due at tick ${s.nextPoll}, so ${name} waits ${ticks(wait)}.`,
    });
    return;
  }
  const fresh = newer(s);
  if (!fresh.length) return;
  if (!s.open) {
    if (!followed) return;
    const { name, note } = followed;
    rec.line(...lead, 'nothing');
    rec.step(`The connection is down, so the server has nowhere to send ${name}. It keeps it until the client is back.`, { probe: atServer(note, name) });
    return;
  }
  const first = `m${fresh[0]}`;
  // The arrival row stops being magenta once the message has left it.
  if (followed) rec.unmark(rowS(followed.note.seq));
  if (s.method === 'long') {
    const down = addRow(s, 'down', `200 [${names(fresh)}]`, carryOf(fresh), 'ok');
    const waits = take(s, fresh, rec);
    s.held = null;
    s.open = false;
    follow(rec, first, rowS(down.seq));
    rec.markEdge(rowE(down.seq), 'key');
    rec.line(...lead, 'answer_held');
    rec.step(
      followed
        ? `The server has been holding the client's request open, so it answers it now: 200 [${names(fresh)}]. ${first} reaches the client in the same tick it arrived: a wait of 0.`
        : `The server has ${names(fresh)} the client has not seen, so it answers the new request at once: 200 [${names(fresh)}]. ${first} waited ${ticks(waits[0])}, the time the client was away.`,
      { probe: atClient(down, first) },
    );
    unfollow(rec, first, rowS(down.seq));
    rec.markEdge(rowE(down.seq), 'ok');
    connect(s, rec, 'repoll');
    return;
  }
  for (const i of fresh) {
    const name = `m${i}`;
    const down = addRow(s, 'down', s.method === 'sse' ? `id: ${i}, data: ${name}` : `frame ${name}`, name, 'ok');
    const [wait] = take(s, [i], rec);
    follow(rec, name, rowS(down.seq));
    rec.markEdge(rowE(down.seq), 'key');
    rec.line(...lead, s.method === 'sse' ? 'sse_frame' : 'ws_frame', 'frame_taken');
    const late = wait ? ` It waited ${ticks(wait)}, the time the connection was down.` : ` It waited 0 ticks.`;
    rec.step(
      s.method === 'sse'
        ? `The server writes one more event down the response it never finished: "id: ${i}" and "data: ${name}", then a blank line. No new request, no new headers.${late}`
        : `The server sends ${name} as one frame on the open socket. A frame header is a few bytes, not a set of HTTP headers.${late}`,
      { probe: atClient(down, name) },
    );
    unfollow(rec, name, rowS(down.seq));
    rec.markEdge(rowE(down.seq), 'ok');
  }
  s.since = s.now;
}

/** Open the channel the way this method does, then catch up on anything newer. */
function connect(s: PushState, rec: Rec, cause: Cause): void {
  s.open = true;
  s.broken = false;
  const lead = LEAD[cause];
  if (s.method === 'short') {
    poll(s, rec, [...lead, 'poll_now']);
    return;
  }
  s.requests++;
  rec.count('requests');
  const after = s.seen;
  if (s.method === 'long') {
    const up = addRow(s, 'up', `GET /poll?after=${after}`);
    s.held = up.seq;
    s.since = s.now;
    const why =
      cause === 'repoll'
        ? `The client sends the next poll straight away`
        : cause === 'reopen'
          ? `The client opens a new poll at once`
          : cause === 'reconnect'
            ? `The client simply issues its next request`
            : `The client opens a long poll`;
    rec.line(...lead, 'request', 'long_open', 'opened');
    rec.step(
      `${why}: GET /poll?after=${after}. It looks like any request, but the server does not answer until it has something newer than ${after}, or until the hold limit. One request is now held open.`,
    );
  } else if (s.method === 'sse') {
    addRow(s, 'up', after ? `GET /events, Last-Event-ID ${after}` : 'GET /events');
    addRow(s, 'down', '200 text/event-stream');
    s.since = s.now;
    rec.line(...lead, 'request', 'sse_open', 'opened');
    rec.step(
      (cause === 'reconnect'
        ? `EventSource reconnects by itself. It sends the id of the last event it got, Last-Event-ID: ${after}, so the server can resume from the right place. `
        : `One GET for the stream. `) +
        `The server answers 200 with Content-Type: text/event-stream and never finishes the response: every event will be written down this one connection.`,
    );
  } else {
    addRow(s, 'up', 'GET, Upgrade: websocket');
    addRow(s, 'down', '101 Switching Protocols');
    s.since = s.now;
    rec.line(...lead, 'request', 'ws_open', 'opened');
    rec.step(
      (cause === 'reconnect' ? `The application's own code reconnects: the browser will not do it. ` : ``) +
        `The handshake is one HTTP GET with Upgrade: websocket. The server agrees with 101 Switching Protocols, and from then on the same TCP connection carries WebSocket frames both ways.`,
    );
    if (after) {
      addRow(s, 'up', `resume after ${after}`);
      rec.line('resync');
      rec.step(
        `WebSocket has no resume of its own. The application sends a message of its own design, "resume after ${after}", or the server would never know what this client missed.`,
      );
    }
  }
  push(s, rec, ['catch_up']);
}

function event(s: PushState, rec: Rec, lead: string[]): void {
  s.arrived.push(s.now);
  const name = `m${s.arrived.length}`;
  addMsg(s, { name, kind: 'server', at: s.now, out: null });
  const note = addRow(s, 'note', '', name);
  follow(rec, name, rowS(note.seq));
  rec.line(...lead, 'arrive');
  rec.step(`Tick ${s.now}: a new chat message, ${name}, reaches the server. Follow it to the client.`, { probe: atServer(note, name) });
  push(s, rec, ['push'], { name, note });
  unfollow(rec, name, rowS(note.seq));
}

function expire(s: PushState, rec: Rec): void {
  addRow(s, 'down', '204 No Content', '', 'bad');
  s.empty++;
  rec.count('empty');
  s.open = false;
  rec.line('held_long', 'expire');
  rec.step(
    `The request has been held ${ticks(TIMEOUT)}, the proxy's idle timeout in this model, and comes back empty: 204 No Content. A real server answers a little before the proxy's limit, say at 25 seconds against 30, because a proxy that cuts the request first hands the client an error such as 504.`,
  );
  s.held = null;
  connect(s, rec, 'reopen');
}

function heartbeat(s: PushState, rec: Rec): void {
  if (s.method === 'sse') {
    addRow(s, 'down', ': ping');
    rec.line('idle', 'sse_ping', 'quiet');
    rec.step(
      `The stream has carried nothing for ${ticks(HEARTBEAT)}. Proxies and load balancers close connections that stay idle too long, so the server writes a comment line, ": ping". EventSource ignores lines that start with a colon.`,
    );
  } else {
    addRow(s, 'down', 'ping');
    addRow(s, 'up', 'pong');
    rec.line('idle', 'ws_ping', 'quiet');
    rec.step(
      `The socket has carried nothing for ${ticks(HEARTBEAT)}, so the server sends a ping control frame and the browser answers pong by itself. Page scripts cannot send pings, so many apps also send a heartbeat message of their own.`,
    );
  }
  s.since = s.now;
}

/** Advance the clock tick by tick, doing whatever falls due. */
function run(s: PushState, k: number, rec: Rec): void {
  for (let i = 0; i < k; i++) {
    s.now++;
    while (s.plan.length && s.plan[0] === s.now) {
      s.plan.shift();
      event(s, rec, ['due']);
    }
    if (!s.open) continue;
    const idle = s.now - s.since;
    if (s.method === 'short') {
      if (s.now >= s.nextPoll) poll(s, rec, ['poll_due']);
    } else if (s.method === 'long') {
      if (idle >= TIMEOUT) expire(s, rec);
    } else if (idle >= HEARTBEAT) heartbeat(s, rec);
  }
}

function sorry(s: PushState, rec: Rec, anchor: string): void {
  rec.line(anchor);
  rec.step(`Sorry, this page's clock stops at tick ${MAX_TICK} so the numbers stay readable, and it reads ${s.now}. Use Replay to start again from tick 0.`);
}

// ---- operations ----------------------------------------------------------------

export function tick(s: PushState, k: number, rec: Rec): boolean {
  if (s.now + k > MAX_TICK) {
    sorry(s, rec, 'clock');
    return false;
  }
  const from = s.now;
  const req = s.requests;
  const empty = s.empty;
  run(s, k, rec);
  const idle = s.now - s.since;
  const sent = s.requests - req;
  const wasted = s.empty - empty;
  rec.line('clock');
  rec.step(
    `Clock moved from tick ${from} to ${s.now}. ` +
      (s.method === 'short'
        ? `${plural(sent, 'request')} went out and ${wasted} came back empty. The next poll is due at tick ${s.nextPoll}.`
        : s.method === 'long'
          ? `The current poll has been held ${ticks(idle)} of the ${TIMEOUT} allowed. While nothing happens it costs one open connection and no traffic.`
          : `The ${s.method === 'sse' ? 'stream' : 'socket'} stays open, costing memory on the server and no traffic. ${ticks(idle)} since it last carried anything.`),
  );
  return true;
}

export function arrive(s: PushState, rec: Rec): void {
  event(s, rec, []);
  const m = s.msgs[s.msgs.length - 1];
  rec.line('arrive', 'push');
  rec.step(
    m.out === null
      ? `${m.name} is waiting at the server. Under short polling it goes out with the poll at tick ${s.nextPoll}.`
      : `${m.name} reached the client ${ticks(m.out - m.at)} after it reached the server, without the client asking.`,
  );
}

export function clientSend(s: PushState, rec: Rec): void {
  const name = `c${s.received + 1}`;
  addMsg(s, { name, kind: 'client', at: s.now, out: s.now });
  if (s.method === 'ws') {
    const up = addRow(s, 'up', `frame ${name}`, name, 'ok');
    s.since = s.now;
    follow(rec, name, rowS(up.seq));
    rec.markEdge(rowE(up.seq), 'key');
    rec.line('ws_send');
    rec.step(`The client sends ${name} as a frame on the socket it already has. No new request and no HTTP headers: one connection carries both directions.`, {
      probe: atServer(up, name),
    });
  } else {
    s.requests++;
    rec.count('requests');
    const up = addRow(s, 'up', `POST /messages ${name}`, name, 'ok');
    addRow(s, 'down', '201 Created');
    follow(rec, name, rowS(up.seq));
    rec.markEdge(rowE(up.seq), 'key');
    rec.line('post');
    rec.step(
      (s.method === 'sse'
        ? `Server-sent events only carry data from server to client, so ${name} needs a separate request: POST /messages, with a full set of HTTP headers.`
        : `Polling only fetches news, so ${name} goes up in a separate request: POST /messages, with a full set of HTTP headers.`) +
        (s.method === 'long' ? ` Over HTTP/1.1 it cannot use the connection the held poll is on, so it needs a second one.` : ``),
      { probe: atServer(up, name) },
    );
  }
  s.received++;
  rec.line(s.method === 'ws' ? 'ws_send' : 'created', 'received');
  rec.step(`${name} reached the server at tick ${s.now}. ${s.method === 'ws' ? 'Cost: one frame.' : 'Cost: one more request and its response.'}`, {
    probe: { text: name, at: msgId(name), place: 'right' },
  });
}

export function connectOp(s: PushState, rec: Rec): void {
  if (s.open) {
    s.held = null;
    rec.line('open');
    rec.step(
      s.method === 'short'
        ? `Under short polling, opening is just a poll: an ordinary request answered at once.`
        : `Close the current ${s.method === 'long' ? 'poll' : s.method === 'sse' ? 'stream' : 'socket'} and open a fresh one, to see what opening costs under ${METHOD_NAME[s.method]}.`,
    );
  }
  connect(s, rec, 'open');
}

export function drop(s: PushState, missed: number, rec: Rec): void {
  if (s.now + RETRY > MAX_TICK) {
    sorry(s, rec, 'broken');
    return;
  }
  s.open = false;
  s.broken = true;
  s.held = null;
  addRow(s, 'cut', 'connection lost', '', 'bad');
  rec.line('broken');
  rec.step(
    s.method === 'short'
      ? `The network drops. Short polling held nothing open, so nothing breaks: the client will just ask again.`
      : s.method === 'long'
        ? `The connection drops and the held request dies with it. No answer will come on it.`
        : s.method === 'sse'
          ? `The connection drops and the stream ends. EventSource notices and will reconnect by itself after its retry delay.`
          : `The connection drops and the socket closes. The browser will not reopen it: the application's code must reconnect, usually with a growing back-off.`,
  );
  const before = s.seen;
  for (let i = 0; i < missed; i++) event(s, rec, ['missed']);
  s.now += RETRY;
  rec.line('retry');
  rec.step(`Tick ${s.now}: ${ticks(RETRY)} later, the client reconnects.`);
  connect(s, rec, 'reconnect');
  const got = s.seen - before;
  rec.line('reconnect');
  rec.step(
    (missed ? `${plural(got, 'missed message')} arrived ${ticks(RETRY)} late, and none was lost or sent twice. ` : `Nothing was missed while the connection was down. `) +
      (s.method === 'sse'
        ? `Last-Event-ID did that, and the browser sent it without any code from the page.`
        : s.method === 'ws'
          ? `That resume was application code: WebSocket itself would have carried on from nothing.`
          : `The after= in the request did that: the client says what it has, and the server sends the rest.`),
  );
}

export function waitIdle(s: PushState, rec: Rec): void {
  if (s.method === 'short') {
    rec.line('short_idle');
    rec.step(`Short polling holds nothing open: every request finishes at once, so no idle timeout can catch it. Its cost is the other way round, requests that find nothing.`);
    return;
  }
  const limit = s.method === 'long' ? TIMEOUT : HEARTBEAT;
  const k = s.since + limit - s.now;
  if (s.now + k > MAX_TICK) {
    sorry(s, rec, 'wait');
    return;
  }
  rec.line('wait');
  rec.step(
    `Nothing to send for ${ticks(k)}. The connection has been quiet since tick ${s.since}, and ${s.method === 'long' ? `a long poll is held at most ${ticks(TIMEOUT)}` : `the server sends a heartbeat after ${ticks(HEARTBEAT)} of quiet`}.`,
  );
  run(s, k, rec);
}

export function replay(s: PushState, method: Method, rec: Rec): void {
  Object.assign(s, create(method, s.every));
  s.plan = [...PLAN];
  rec.line('reset');
  rec.step(
    `Start again under ${METHOD_NAME[method]}. The same script plays every time: messages arrive at ticks ${PLAN.join(' and ')}, and the clock runs to tick ${PLAY}.`,
  );
  connect(s, rec, 'start');
  run(s, PLAY, rec);
  const avg = average(s);
  rec.line('play');
  rec.step(
    `Under ${METHOD_NAME[method]}: ${plural(s.requests, 'request')}, ${plural(s.empty, 'empty response')}, ${s.delays.length} delivered, average delay ${avg === null ? 'none' : `${fmt(avg)} ticks`}. ` +
      (method === 'short'
        ? `Shorter polls cut the delay and add empty answers.`
        : method === 'long'
          ? `No empty answers and no delay, at the price of one request per message.`
          : `One request in all: the connection stayed open.`),
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ---- layout ----------------------------------------------------------------------

const CX = 0;
const CW = 64;
const SX = 350;
const SW = 80;
const HEAD_W = 80;
const STRIP_X = 500;
const MSG_W = 52;
const HEAD_Y = 0;
const ROW_Y0 = 70;
const ROW_PITCH = 44;
const MSG_PITCH = 58;
const BOTTOM = ROW_Y0 + (ROWS - 1) * ROW_PITCH + 18;
const LEFT = -120;
const RIGHT = STRIP_X + 112;
const TOP = HEAD_Y - 18 - 44;

export function layout(s: PushState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];

  decor.push({ id: 'life-c', type: 'band', x: CX - 3, y: HEAD_Y + 18, w: 6, h: BOTTOM - HEAD_Y - 18 });
  decor.push({ id: 'life-s', type: 'band', x: SX - 3, y: HEAD_Y + 18, w: 6, h: BOTTOM - HEAD_Y - 18 });
  decor.push({ id: 'title', type: 'label', x: CX - 24, y: HEAD_Y - 40, text: `${METHOD_NAME[s.method]}, tick ${s.now}`, strong: true });
  nodes.push({ id: 'client', x: CX, y: HEAD_Y, cells: [{ text: 'Client', w: HEAD_W }] });
  nodes.push({ id: 'server', x: SX, y: HEAD_Y, cells: [{ text: 'Server', w: HEAD_W }] });
  if (s.method === 'short') {
    decor.push({ id: 'conn-note', type: 'label', x: SX / 2, y: HEAD_Y, text: s.broken ? 'network down' : 'nothing held open', anchor: 'middle' });
  } else {
    const what = s.method === 'long' ? '1 request held' : s.method === 'sse' ? 'stream open' : 'socket open';
    edges.push({
      id: 'conn',
      from: 'client',
      to: 'server',
      kind: 'line',
      label: s.broken ? 'connection lost' : s.open ? what : 'nothing open',
      dashed: !s.open,
      tone: s.broken ? 'bad' : undefined,
    });
  }

  s.rows.forEach((row, i) => {
    const y = ROW_Y0 + i * ROW_PITCH;
    const text = row.seq === s.held ? `held ${s.now - row.t}` : row.carry;
    nodes.push({ id: rowC(row.seq), x: CX, y, cells: [{ text: `t${row.t}`, w: CW }] });
    nodes.push({ id: rowS(row.seq), x: SX, y, cells: [{ text, w: SW }] });
    if (row.dir === 'note') {
      decor.push({ id: `note-${row.seq}`, type: 'label', x: SX - SW / 2 - 10, y, text: `${row.carry} arrives`, anchor: 'end' });
      return;
    }
    const down = row.dir === 'down';
    edges.push({
      id: rowE(row.seq),
      from: down ? rowS(row.seq) : rowC(row.seq),
      to: down ? rowC(row.seq) : rowS(row.seq),
      kind: 'line',
      arrow: row.dir !== 'cut',
      dashed: row.tone === 'bad',
      tone: row.tone,
      label: row.text,
      // Shifts the arrow off the row's centre line so its label sits on the centre, inside its own row.
      offset: -10,
    });
  });

  decor.push({ id: 'strip', type: 'label', x: STRIP_X, y: HEAD_Y, text: s.msgs.length ? 'Messages' : 'Messages:\nnone yet', anchor: 'middle', strong: true });
  s.msgs.forEach((m, i) => {
    const sub = m.kind === 'client' ? `sent t${m.at}` : m.out === null ? `t${m.at}, waiting` : `t${m.at} → t${m.out}, +${m.out - m.at}`;
    nodes.push({
      id: msgId(m.name),
      x: STRIP_X,
      y: ROW_Y0 + i * MSG_PITCH,
      cells: [{ text: m.name, w: MSG_W, sub, subValue: true }],
      tone: m.out !== null ? 'ok' : undefined,
    });
  });

  decor.push({ id: 'corner-a', type: 'label', x: LEFT, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: RIGHT, y: BOTTOM, text: '' });
  return { nodes, edges, decor };
}

// ---- definition ------------------------------------------------------------------

function suggestTicks(s: PushState): number {
  const room = Math.max(1, MAX_TICK - s.now);
  if (s.method === 'short') return Math.min(room, Math.max(1, s.nextPoll - s.now));
  return Math.min(room, randomInt(2, 4));
}

const def: StructureDef<PushState> = {
  id: 'realtime-push',
  params: [
    { id: 'method', label: 'Method', default: 1, options: METHODS.map((m, i) => ({ value: i, label: METHOD_NAME[m] })) },
    { id: 'every', label: 'Short poll every', default: 3, options: [2, 3, 4].map((v) => ({ value: v, label: `${v} ticks` })) },
  ],
  create: (p) => create(METHODS[p.method ?? 1] ?? 'long', p.every ?? 3),
  seed: [['connect']],
  ops: [
    {
      id: 'event',
      label: 'Message arrives',
      intent: 'primary',
      args: [],
      code: ['event', 'push', 'take', 'connect'],
      run: (s, _a, rec) => arrive(s, rec),
    },
    {
      id: 'tick',
      label: 'Tick',
      args: [{ name: 'ticks', label: 'Ticks', kind: 'int', min: 1, max: 9 }],
      code: ['tick', 'poll', 'expire', 'heartbeat', 'event', 'push', 'take', 'connect'],
      run: (s, [k], rec) => void tick(s, Number(k), rec),
      suggest: (s) => [suggestTicks(s)],
    },
    { id: 'client_send', label: 'Client sends', args: [], code: ['client_send'], run: (s, _a, rec) => clientSend(s, rec) },
    { id: 'connect', label: 'Connect', args: [], code: ['connect', 'push', 'poll', 'take'], run: (s, _a, rec) => connectOp(s, rec) },
    {
      id: 'drop',
      label: 'Drop connection',
      intent: 'danger',
      args: [{ name: 'missed', label: 'Messages while down', kind: 'int', min: 0, max: MAX_MISSED }],
      code: ['drop', 'connect', 'event', 'push', 'take', 'poll'],
      run: (s, [n], rec) => drop(s, Number(n), rec),
      suggest: () => [randomInt(1, 2)],
    },
    {
      id: 'timeout',
      label: 'Sit idle',
      args: [],
      code: ['wait_idle', 'tick', 'expire', 'heartbeat', 'connect', 'push'],
      run: (s, _a, rec) => waitIdle(s, rec),
    },
    {
      id: 'replay',
      label: 'Replay under',
      args: [{ name: 'method', label: 'short, long, sse or websocket', kind: 'word' }],
      code: ['replay', 'tick', 'connect', 'poll', 'event', 'push', 'take', 'expire', 'heartbeat'],
      run: (s, [w], rec) => {
        const m = asMethod(w);
        if (!m) {
          rec.line('reset');
          rec.step(`"${String(w)}" is not a method here. Type short, long, sse or websocket.`);
          return;
        }
        replay(s, m, rec);
      },
      suggest: (s) => [METHOD_WORD[METHODS[(METHODS.indexOf(s.method) + 1) % METHODS.length]]],
    },
  ],
  layout,
  counters: [
    { key: 'requests', label: 'Requests made' },
    { key: 'empty', label: 'Empty responses' },
    { key: 'delivered', label: 'Events delivered' },
    { key: 'waited', label: 'Ticks waited' },
  ],
  status: (s) => {
    const avg = average(s);
    return [
      { label: 'Method, clock', value: `${METHOD_NAME[s.method]}, tick ${s.now}` },
      { label: 'Requests, empty', value: `${s.requests}, ${s.empty}` },
      { label: 'Average delay', value: avg === null ? 'nothing delivered yet' : `${fmt(avg)} ticks over ${s.delays.length}` },
      { label: 'Open connections', value: String(openConnections(s)) },
    ];
  },
  tour: [['replay', 'short'], ['replay', 'long'], ['timeout'], ['replay', 'sse'], ['drop', 1], ['replay', 'websocket'], ['client_send']],
  source: { python, java },
  info,
};

export default def;
