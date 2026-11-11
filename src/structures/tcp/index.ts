import { LABEL_LINE, LABEL_MAX, PROBE_H, SUB_ROOM } from '../../core/fit';
import { CELL_H, TAG_H } from '../../core/geometry';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/Tcp.java?raw';
import python from './code/tcp.py?raw';
import { info } from './info';

/**
 * TCP and UDP over one lossy link.
 *
 * A sender has eight segments to deliver. Under TCP it opens a connection
 * first, keeps at most `window` segments in flight, and slides the window as
 * cumulative acks come back. The receiver delivers in order, holds early
 * segments, and answers every arrival with the next segment it expects. Under
 * UDP the sender fires datagrams and nothing ever comes back.
 *
 * Simplified on purpose: segments are numbered 1 to 8 (real TCP numbers
 * bytes); the link moves in flights (everything sent arrives, then every ack
 * returns); acks are never lost; the send window is fixed, and the congestion
 * window is drawn on a strip of its own.
 */
export type Proto = 'tcp' | 'udp';
export type SegState = 'unsent' | 'sent' | 'acked' | 'lost';
export type Fault = 'drop' | 'reorder';
export type Conn = 'closed' | 'open' | 'done';

export interface Packet {
  /** Unique per transmission, so a resend is a new packet. */
  id: number;
  text: string;
  /** Data segment number, when this is data. */
  seq?: number;
  /** Ack number, when this is an ack: the next segment the receiver expects. */
  ack?: number;
  win?: number;
  sub?: string;
  /** 'drop': the link will lose it. 'reorder': it waits for the next packet to overtake it. */
  fault?: Fault | null;
  /** A window update: not a duplicate ack, whatever its number. */
  update?: boolean;
}

export interface TcpState {
  proto: Proto;
  /** Send window, in segments. */
  window: number;
  conn: Conn;
  segs: SegState[];
  /** Next new segment to send. */
  next: number;
  /** Oldest unacknowledged segment. */
  base: number;
  /** The receiver's last advertised window. */
  peerWindow: number;
  dupAcks: number;
  /** Armed faults, by segment number: they apply to its next transmission. */
  faults: Record<number, Fault>;
  /** In flight, oldest first. */
  data: Packet[];
  acks: Packet[];
  /** Arriving (drawn at the far end) or leaving (drawn at the near end). */
  dataIn: boolean;
  ackIn: boolean;
  expected: number;
  held: number[];
  unread: number[];
  app: number[];
  slow: boolean;
  /** The congestion strip. */
  cwnd: number[];
  ssthresh: number;
  lossRound: number;
  pid: number;
  /** Packet each receiver node grew out of. */
  from: Record<number, number>;
  totals: { sent: number; retransmissions: number; delivered: number; lost: number };
}

export const SEGMENTS = 8;
export const RCV_BUF = 4;
export const ISN = 100;
export const PEER_ISN = 300;
export const ROUNDS = 8;
export const LOSS_ROUND = 6;
export const SSTHRESH = 8;

export function create(proto: Proto = 'tcp', window = 4): TcpState {
  return {
    proto,
    window,
    conn: 'closed',
    segs: new Array<SegState>(SEGMENTS).fill('unsent'),
    next: 1,
    base: 1,
    peerWindow: RCV_BUF,
    dupAcks: 0,
    faults: {},
    data: [],
    acks: [],
    dataIn: false,
    ackIn: false,
    expected: 1,
    held: [],
    unread: [],
    app: [],
    slow: false,
    cwnd: [],
    ssthresh: SSTHRESH,
    lossRound: 0,
    pid: 0,
    from: {},
    totals: { sent: 0, retransmissions: 0, delivered: 0, lost: 0 },
  };
}

// ---- helpers ------------------------------------------------------------------

const sid = (seq: number) => `s${seq}`;
const pid = (p: Packet) => `p${p.id}`;
const rid = (seq: number) => `r${seq}`;
export const segName = (s: TcpState, seq: number) => `${s.proto === 'tcp' ? 'seg' : 'dgram'} ${seq}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: (string | number)[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ordinal = (n: number) => ['first', 'second', 'third'][n - 1] ?? `${n}th`;
/** The window the sender may use: its own, or the receiver's when that is smaller. */
export const limitOf = (s: TcpState) => Math.min(s.window, s.peerWindow);
export const inFlight = (s: TcpState) => s.next - s.base;

function count(s: TcpState, rec: Rec, key: keyof TcpState['totals'], by = 1): void {
  s.totals[key] += by;
  rec.count(key, by);
}

/** The link: a delayed packet at the end of the wire is overtaken by the next one put on it. */
function put(s: TcpState, p: Packet): number | null {
  const last = s.data[s.data.length - 1];
  s.dataIn = false;
  if (last && last.fault === 'reorder') {
    last.fault = null;
    s.data.splice(s.data.length - 1, 0, p);
    return last.seq ?? null;
  }
  s.data.push(p);
  return null;
}

/** Put one data segment on the wire, applying any fault armed for it. */
function transmit(s: TcpState, seq: number, retrans: boolean, rec: Rec): { p: Packet; overtook: number | null; fault: Fault | null } {
  const fault = s.faults[seq] ?? null;
  delete s.faults[seq];
  const p: Packet = { id: ++s.pid, text: segName(s, seq), seq, fault };
  const overtook = put(s, p);
  count(s, rec, 'sent');
  if (retrans) count(s, rec, 'retransmissions');
  return { p, overtook, fault };
}

function faultNote(s: TcpState, t: { overtook: number | null; fault: Fault | null }): string {
  let out = '';
  if (t.overtook !== null) out += ` It overtakes ${segName(s, t.overtook)}, which the link is holding back.`;
  if (t.fault === 'drop') out += ` The link has been told to lose this one. The sender cannot know that.`;
  if (t.fault === 'reorder') out += ` The link will hold it back, so the next one sent overtakes it.`;
  return out;
}

/** In order: up to the application, or into the buffer while the application is not reading. */
function handUp(s: TcpState, seq: number, rec: Rec): void {
  if (s.slow) s.unread.push(seq);
  else {
    s.app.push(seq);
    count(s, rec, 'delivered');
  }
}

const atPacket = (p: Packet, text = p.text): Probe => ({ text, at: pid(p) });

// ---- TCP: handshake -------------------------------------------------------------

export function connect(s: TcpState, rec: Rec): boolean {
  if (s.proto === 'udp') {
    rec.line('none');
    rec.step('UDP has no connection and no handshake. The first datagram can leave at once, with no round trip spent first. Press Send.');
    return false;
  }
  if (s.conn !== 'closed') {
    rec.line('already');
    rec.step(s.conn === 'open' ? 'The connection is already open. Press Send.' : 'This connection has been closed. Reset to open a new one.');
    return false;
  }
  const syn: Packet = { id: ++s.pid, text: `SYN ${ISN}` };
  s.data = [syn];
  s.dataIn = false;
  rec.mark(pid(syn), 'key');
  rec.line('syn');
  rec.step(
    `Open a connection. The sender picks an initial sequence number, here ${ISN}, and sends it in a SYN. Real stacks pick it at random, so stray packets from an old connection do not fit the new one.`,
    { probe: atPacket(syn, 'SYN') },
  );
  s.dataIn = true;
  rec.step(`The SYN crosses the link to the receiver.`, { probe: atPacket(syn, 'SYN') });
  rec.unmark(pid(syn));
  s.data = [];

  const synAck: Packet = { id: ++s.pid, text: 'SYN-ACK', sub: `seq ${PEER_ISN}, ack ${ISN + 1}` };
  s.acks = [synAck];
  s.ackIn = false;
  rec.mark(pid(synAck), 'key');
  rec.line('syn_ack');
  rec.step(
    `The receiver picks its own number, ${PEER_ISN}, and answers with a SYN-ACK. "ack ${ISN + 1}" means: I have ${ISN}, send ${ISN + 1} next. The SYN itself uses up one sequence number.`,
    { probe: atPacket(synAck) },
  );
  s.ackIn = true;
  rec.line('check');
  rec.compare(`ack ${ISN + 1}`, '=', `ISN ${ISN} + 1`, 'my SYN got through', {
    probe: atPacket(synAck),
    message: `The SYN-ACK reaches the sender. It acknowledges ${ISN + 1}, one past the sender's own number, so the sender knows its SYN arrived and the receiver can hear it.`,
  });
  rec.unmark(pid(synAck));
  s.acks = [];

  const ack: Packet = { id: ++s.pid, text: `ACK ${PEER_ISN + 1}` };
  s.data = [ack];
  s.dataIn = false;
  rec.mark(pid(ack), 'key');
  rec.line('ack');
  rec.step(
    `The sender acknowledges the receiver's number with ACK ${PEER_ISN + 1}. Now each side knows the other's starting number and that the other can hear it.`,
    { probe: atPacket(ack, 'ACK') },
  );
  s.dataIn = true;
  rec.step(`The ACK crosses the link. Data may ride on this same packet.`, { probe: atPacket(ack, 'ACK') });
  rec.unmark(pid(ack));
  s.data = [];
  s.conn = 'open';
  rec.line('open');
  rec.step(
    `The connection is open. It cost one round trip before any data moved. Real TCP numbers bytes, so the first data byte would be ${ISN + 1}. This page numbers whole segments 1 to ${SEGMENTS} instead, to keep the picture readable.`,
  );
  return true;
}

// ---- TCP: the network ---------------------------------------------------------

/** One data segment reaches the receiver, which compares it with what it expects. */
function arrive(s: TcpState, p: Packet, rec: Rec): void {
  const seq = p.seq!;
  const e = s.expected;
  const name = segName(s, seq);
  rec.mark(pid(p), 'key');
  rec.line('to_receiver', 'in_order', ...(seq === e ? [] : ['early']));
  const verdict = seq === e ? 'in order: deliver it' : seq > e ? `early: hold it, ask for ${e} again` : 'a copy: ack again';
  rec.compare(name, seq === e ? '=' : seq > e ? '>' : '<', `expect ${e}`, verdict, {
    probe: atPacket(p, name),
    message:
      seq === e
        ? `${name} arrives. It is the one the receiver expects next.`
        : seq > e
          ? `${name} arrives, but the receiver is still waiting for ${e}. ${name} is early.`
          : `${name} arrives again. The receiver already has it, so it is a copy.`,
  });
  rec.unmark(pid(p));
  s.data.shift();
  s.from[seq] = p.id;

  if (seq === e) {
    handUp(s, seq, rec);
    s.expected++;
    rec.mark(rid(seq), 'key');
    rec.line('deliver', s.slow ? 'unread' : 'app');
    rec.step(
      s.slow
        ? `${name} is in order, but the application is not reading. It waits in the receive buffer, which leaves less room to advertise.`
        : `${name} goes straight up to the application, in order. The receiver now expects ${s.expected}.`,
      { probe: { text: name, at: rid(seq) } },
    );
    rec.unmark(rid(seq));
    const drained: number[] = [];
    while (s.held.includes(s.expected)) {
      s.held.splice(s.held.indexOf(s.expected), 1);
      handUp(s, s.expected, rec);
      drained.push(s.expected);
      s.expected++;
    }
    if (drained.length) {
      rec.line('drain', s.slow ? 'unread' : 'app');
      rec.step(
        `${list(drained.map((d) => segName(s, d)))} ${drained.length === 1 ? 'was' : 'were'} already waiting in the buffer. With ${seq} here the gap is filled, so ${drained.length === 1 ? 'it goes' : 'they all go'} up at once. ` +
          `Until now ${drained.length === 1 ? 'it' : 'they'} had arrived and still could not be used, because one segment before ${drained.length === 1 ? 'it' : 'them'} was missing. That is head-of-line blocking.`,
        { probe: { text: name, at: rid(seq) } },
      );
    }
  } else if (seq > e && !s.held.includes(seq)) {
    s.held.push(seq);
    s.held.sort((a, b) => a - b);
    rec.line('hold');
    rec.step(
      `Hold ${name} in the receive buffer. The application cannot have it yet: ${e} is missing and TCP promises order.`,
      { probe: { text: name, at: rid(seq) } },
    );
  }

  const win = RCV_BUF - s.unread.length;
  const ack: Packet = { id: ++s.pid, text: `ack ${s.expected}`, ack: s.expected, win, sub: `win ${win}` };
  s.acks.push(ack);
  s.ackIn = false;
  rec.mark(pid(ack), 'key');
  rec.line('ack', 'rwnd');
  rec.step(
    seq === e
      ? `Send ack ${s.expected}: everything before ${s.expected} has arrived, send ${s.expected} next. It also advertises room for ${plural(win, 'segment')}.`
      : `Send ack ${e} again. This is a duplicate ack: it tells the sender that ${e} is still missing, while saying that something later did arrive.`,
    { probe: atPacket(ack) },
  );
  rec.unmark(pid(ack));
}

/** One ack reaches the sender. */
function onAck(s: TcpState, a: Packet, rec: Rec): void {
  const before = s.peerWindow;
  s.peerWindow = a.win!;
  rec.mark(pid(a), 'key');
  if (a.update) {
    rec.line('peer_window');
    rec.step(`The window update arrives: the receiver has room for ${plural(a.win!, 'segment')} again, so the sender may carry on.`, { probe: atPacket(a) });
    rec.unmark(pid(a));
    s.acks.shift();
    return;
  }
  const n = a.ack!;
  const shrank = s.peerWindow < before ? ` The receiver now advertises room for only ${s.peerWindow}: the sender will keep no more than that in flight.` : '';
  if (n > s.base) {
    rec.line('peer_window', 'new_ack');
    rec.compare(`ack ${n}`, '>', `base ${s.base}`, 'new: slide the window', {
      probe: atPacket(a),
      message: `ack ${n} reaches the sender. It is past the oldest unacknowledged segment, ${s.base}, so it acknowledges something new.`,
    });
    const from = s.base;
    for (let q = s.base; q < n; q++) s.segs[q - 1] = 'acked';
    s.base = n;
    s.dupAcks = 0;
    s.acks.shift();
    rec.unmark(pid(a));
    rec.line('slide');
    rec.step(
      `${n - from === 1 ? `Segment ${from} is` : `Segments ${from} to ${n - 1} are`} acknowledged and the window slides on to start at ${n}. ` +
        (s.base < s.next ? `The timer restarts for segment ${s.base}.` : `Nothing is outstanding, so the timer stops.`) +
        shrank,
    );
    return;
  }
  if (n === s.base && s.base < s.next) {
    s.dupAcks++;
    rec.line('dup');
    rec.compare(`ack ${n}`, '=', `base ${s.base}`, `duplicate ${s.dupAcks} of 3`, {
      probe: atPacket(a),
      message: `ack ${n} again: the ${ordinal(s.dupAcks)} duplicate. Segment ${n} is probably missing, but a duplicate can also mean it was only overtaken, so the sender waits for three.` + shrank,
    });
    s.acks.shift();
    rec.unmark(pid(a));
    if (s.dupAcks === 3) {
      const t = transmit(s, s.base, true, rec);
      rec.mark(pid(t.p), 'key');
      rec.line('three', 'fast', 'resend');
      rec.step(
        `Three duplicate acks: fast retransmit. The sender resends segment ${s.base} now instead of waiting for its timer, which is set well above a round trip.` + faultNote(s, t),
        { probe: atPacket(t.p) },
      );
      rec.unmark(pid(t.p));
    }
    return;
  }
  rec.line('new_ack', 'dup');
  rec.compare(`ack ${n}`, '=', `base ${s.base}`, 'nothing outstanding: ignore', { probe: atPacket(a) });
  s.acks.shift();
  rec.unmark(pid(a));
}

/** Let the link deliver until nothing is in flight. */
function network(s: TcpState, rec: Rec): void {
  while (s.data.length || s.acks.length) {
    if (s.data.length) {
      s.dataIn = true;
      const order = s.data.map((p) => p.seq);
      const sorted = [...order].sort((a, b) => a! - b!);
      rec.line('arrive');
      rec.step(
        `The ${s.data.length === 1 ? 'segment crosses' : 'segments cross'} the link` +
          (order.join() !== sorted.join() ? `, and not in the order sent: ${list(order as number[])}.` : '.'),
        { probe: atPacket(s.data[0]) },
      );
      while (s.data.length) {
        const p = s.data[0];
        if (p.fault === 'drop') {
          rec.mark(pid(p), 'bad');
          rec.line('lost');
          rec.step(`${p.text} never arrives: the link lost it. Neither side is told.`, { probe: atPacket(p) });
          rec.unmark(pid(p));
          s.data.shift();
          continue;
        }
        arrive(s, p, rec);
      }
    }
    if (s.acks.length) {
      s.ackIn = true;
      rec.line('ack_back');
      rec.step(`The ${s.acks.length === 1 ? 'ack travels' : 'acks travel'} back to the sender.`, { probe: atPacket(s.acks[0]) });
      while (s.acks.length) onAck(s, s.acks[0], rec);
    }
  }
}

function afterFlight(s: TcpState, sent: number, rec: Rec): void {
  const out = s.next - s.base;
  rec.line('run');
  if (out === 0) {
    rec.step(
      `Done${sent ? `: ${plural(sent, 'new segment')} sent` : ''}. Everything sent so far is acknowledged, ${s.base - 1} of ${SEGMENTS}, and the application has ${s.totals.delivered} in order.` +
        (s.next > SEGMENTS ? ` All ${SEGMENTS} are through. Press Close to end the connection.` : ` The window now starts at ${s.base}.`),
    );
  } else if (s.dupAcks >= 3) {
    rec.step(`Segment ${s.base} was lost again, after its fast retransmit. Only the retransmission timer can recover it now: press Timeout.`);
  } else {
    rec.step(
      `Segment ${s.base} is still unacknowledged. Only ${plural(s.dupAcks, 'duplicate ack')} came back, fewer than the 3 that trigger fast retransmit. ` +
        `Its retransmission timer is running, and the window cannot slide past it: press Timeout to let the timer fire.`,
    );
  }
}

// ---- TCP: operations ------------------------------------------------------------

/** One flight: send up to `count` segments, as far as the windows allow, and let the round trip finish. */
export function send(s: TcpState, count: number, rec: Rec): number {
  if (s.proto === 'udp') return udpSend(s, count, rec);
  if (s.conn !== 'open') {
    rec.line('closed');
    rec.step(
      s.conn === 'closed'
        ? 'There is no connection yet. TCP sends no data before the handshake: press Connect first.'
        : 'This connection has been closed. Reset to open a new one.',
    );
    return 0;
  }
  let sent = 0;
  for (let i = 0; i < count; i++) {
    if (s.next > SEGMENTS) {
      rec.line('all_sent');
      rec.step(`All ${SEGMENTS} segments have been sent.${sent ? '' : ' Press Close to end the connection, or Reset to start again.'}`);
      break;
    }
    const seq = s.next;
    const limit = limitOf(s);
    const flight = inFlight(s);
    const name = segName(s, seq);
    const ok = flight < limit;
    const byReceiver = s.peerWindow < s.window;
    rec.mark(sid(seq), 'compare');
    rec.line('limit', 'full');
    rec.compare(`in flight ${flight}`, ok ? '<' : '≥', byReceiver ? `rwnd ${limit}` : `window ${limit}`, ok ? `room: send ${seq}` : byReceiver ? 'receiver is full: pause' : 'window full: wait for acks', {
      probe: { text: name, at: sid(seq) },
      message: ok
        ? `${name} is next. ${plural(flight, 'segment is', 'segments are')} in flight, unacknowledged, and the window allows ${limit}. There is room, so it goes.`
        : byReceiver
          ? `The receiver last advertised room for ${plural(s.peerWindow, 'segment')}, and ${flight} ${flight === 1 ? 'is' : 'are'} in flight. The sender pauses: this is flow control.` +
            (s.peerWindow === 0 ? ' Real TCP sends a small probe now and then to learn when the window opens again.' : '')
          : `The window is full: ${plural(flight, 'segment is', 'segments are')} in flight and the window is ${limit}. ${name} must wait for an ack.`,
    });
    rec.unmark(sid(seq));
    if (!ok) break;
    s.segs[seq - 1] = 'sent';
    s.next++;
    const t = transmit(s, seq, false, rec);
    rec.mark(pid(t.p), 'key');
    rec.line('send', t.overtook !== null ? 'overtake' : 'put');
    rec.step(`${name} goes on the wire.` + faultNote(s, t), { probe: atPacket(t.p) });
    rec.unmark(pid(t.p));
    sent++;
  }
  if (!sent) return 0;
  network(s, rec);
  afterFlight(s, sent, rec);
  return sent;
}

/** Arm the link to lose or delay the next copy of a segment. */
export function arm(s: TcpState, seq: number, fault: Fault, rec: Rec): boolean {
  rec.line('arm');
  const what = fault === 'drop' ? 'lose' : 'hold back';
  if (!Number.isInteger(seq) || seq < 1 || seq > SEGMENTS) {
    rec.step(`The sender has segments 1 to ${SEGMENTS}. There is no segment ${seq}.`);
    return false;
  }
  if (s.proto === 'tcp' && s.segs[seq - 1] === 'acked') {
    rec.step(`Segment ${seq} has already been acknowledged, so it will never be sent again. Pick a later one.`);
    return false;
  }
  if (s.proto === 'udp' && seq < s.next) {
    rec.step(`Datagram ${seq} has already gone, and UDP never sends anything twice. Pick one from ${s.next} on.`);
    return false;
  }
  s.faults[seq] = fault;
  const name = segName(s, seq);
  rec.mark(sid(seq), 'compare');
  rec.step(
    `The link will ${what} the next copy of ${name}` +
      (fault === 'reorder' ? `, so whatever is sent after it arrives first.` : `.`) +
      (s.proto === 'tcp' && s.segs[seq - 1] === 'sent' ? ` That copy is its retransmission.` : ` Press Send to see what each side does about it.`),
    { probe: { text: name, at: sid(seq) } },
  );
  rec.unmark(sid(seq));
  return true;
}

/** The retransmission timer fires for the oldest unacknowledged segment. */
export function timeout(s: TcpState, rec: Rec): boolean {
  if (s.proto === 'udp') {
    rec.line('none');
    rec.step('UDP keeps no timer. Nothing is acknowledged, so the sender never learns that a datagram was lost, and nothing is sent again.');
    return false;
  }
  if (s.conn !== 'open' || s.base === s.next) {
    rec.line('idle');
    rec.step(s.conn !== 'open' ? 'There is no open connection, so no timer is running.' : 'No timer is running: every segment sent so far has been acknowledged.');
    return false;
  }
  const seq = s.base;
  s.dupAcks = 0;
  rec.mark(sid(seq), 'compare');
  rec.line('expire');
  rec.step(
    `The retransmission timer for segment ${seq} fires: no ack for it arrived in time. Real TCP also doubles the timeout for next time and cuts its congestion window to 1, because a timeout suggests heavy loss.`,
    { probe: { text: segName(s, seq), at: sid(seq) } },
  );
  rec.unmark(sid(seq));
  const t = transmit(s, seq, true, rec);
  rec.mark(pid(t.p), 'key');
  rec.line('expire', 'resend');
  rec.step(`Resend ${segName(s, seq)}.` + faultNote(s, t), { probe: atPacket(t.p) });
  rec.unmark(pid(t.p));
  network(s, rec);
  afterFlight(s, 0, rec);
  return true;
}

/** Lose the next new segment, then send a full window: the setting for fast retransmit. */
export function dupAcks(s: TcpState, rec: Rec): number {
  if (s.proto === 'udp') {
    rec.line('none');
    rec.step('UDP sends no acks, so there are no duplicate acks to count and nothing is retransmitted.');
    return 0;
  }
  if (s.conn !== 'open' || s.next > SEGMENTS) {
    rec.line('lose_next');
    rec.step(s.conn !== 'open' ? 'Connect first: fast retransmit needs a connection with data flowing.' : `All ${SEGMENTS} segments have been sent. Reset to try again.`);
    return 0;
  }
  s.faults[s.next] = 'drop';
  rec.mark(sid(s.next), 'compare');
  rec.line('lose_next');
  rec.step(
    `The link will lose segment ${s.next}. The sender then sends a full window of ${s.window}, so ${s.window - 1} later ${s.window - 1 === 1 ? 'segment arrives' : 'segments arrive'} behind the gap. ` +
      (s.window - 1 >= 3 ? `That is enough for three duplicate acks.` : `That gives only ${s.window - 1} duplicate acks, one short of three.`),
    { probe: { text: segName(s, s.next), at: sid(s.next) } },
  );
  rec.unmark(sid(s.next));
  return send(s, s.window, rec);
}

/** The receiving application stops reading, or starts again. */
export function slowReceiver(s: TcpState, rec: Rec): void {
  s.slow = !s.slow;
  if (s.proto === 'udp') {
    if (s.slow) {
      rec.line('udp_toggle');
      rec.step(
        `The application stops reading. Datagrams now wait in the socket buffer, which holds ${RCV_BUF}. UDP has no flow control: the sender is never told, and once the buffer is full the next datagrams are dropped.`,
      );
      return;
    }
    const read = [...s.unread];
    for (const q of read) udpDeliver(s, q, rec);
    s.unread = [];
    rec.line('udp_read');
    rec.step(read.length ? `The application reads again and takes ${list(read)} from the buffer, in the order they arrived.` : `The application reads again. Nothing was waiting.`);
    return;
  }
  if (s.slow) {
    rec.line('toggle');
    rec.step(
      `The application stops reading. Segments that arrive in order now wait in the receive buffer, and each ack advertises the room left: ${RCV_BUF} minus what waits. When it reaches 0 the sender must stop.`,
    );
    return;
  }
  const read = [...s.unread];
  s.unread = [];
  for (const q of read) {
    s.app.push(q);
    count(s, rec, 'delivered');
  }
  rec.line('toggle', 'read');
  rec.step(read.length ? `The application reads again and takes ${list(read)} from the buffer. The buffer has room for ${RCV_BUF} again.` : `The application reads again. Nothing was waiting.`);
  if (!read.length || s.conn !== 'open') return;
  const upd: Packet = { id: ++s.pid, text: `ack ${s.expected}`, ack: s.expected, win: RCV_BUF, sub: `win ${RCV_BUF}`, update: true };
  s.acks.push(upd);
  s.ackIn = false;
  rec.mark(pid(upd), 'key');
  rec.line('update');
  rec.step(`The receiver sends a window update: the same ack number, with room for ${RCV_BUF}. It is not a duplicate ack, because the window changed.`, { probe: atPacket(upd) });
  rec.unmark(pid(upd));
  network(s, rec);
  rec.line('update');
  rec.step(`Flow control: the sender went only as fast as the receiving application read. It can now send ${limitOf(s) - inFlight(s)} more.`);
}

/** The congestion window over eight round trips: slow start, additive increase, halving on loss. */
export function congestion(s: TcpState, rec: Rec): void {
  if (s.proto === 'udp') {
    rec.line('none');
    rec.step('UDP has no congestion control. An application that sends a lot over UDP must slow down by itself when the network is busy. QUIC, for example, does its own.');
    return;
  }
  s.cwnd = [];
  s.lossRound = 0;
  let cwnd = 1;
  s.ssthresh = SSTHRESH;
  rec.line('start');
  rec.step(
    `A second window, the congestion window, guesses what the network can carry. It starts small, here at 1 segment, with a slow-start threshold of ${SSTHRESH}. The sender keeps no more in flight than the smaller of this and the receiver's window.`,
  );
  for (let r = 1; r <= ROUNDS; r++) {
    s.cwnd.push(cwnd);
    if (r === LOSS_ROUND) {
      s.lossRound = r;
      const half = Math.floor(cwnd / 2);
      rec.line('round', 'loss', 'halve');
      rec.step(
        `Round ${r}: ${cwnd} in flight, and three duplicate acks show a loss. The sender halves: threshold and window both become ${half}. A timeout would be treated as worse: back to 1 and slow start again.`,
      );
      s.ssthresh = half;
      cwnd = half;
    } else if (cwnd < s.ssthresh) {
      rec.line('round', 'slow_start', 'double');
      rec.step(`Round ${r}: ${cwnd} in flight, below the threshold of ${s.ssthresh}. Slow start: each ack adds 1, so the window doubles to ${cwnd * 2}.`);
      cwnd *= 2;
    } else {
      rec.line('round', 'slow_start', 'additive');
      rec.step(`Round ${r}: ${cwnd} in flight, at or over the threshold of ${s.ssthresh}. Additive increase: 1 more per round trip, to ${cwnd + 1}.`);
      cwnd += 1;
    }
  }
  rec.line('round');
  rec.step(
    `Fast growth to find the limit, careful growth near it, a sharp cut on loss. That is the sawtooth of Reno-style TCP. Linux uses CUBIC by default, which grows differently but also backs off on loss. Real stacks start at 10 segments, not 1.`,
  );
}

/** FIN and ACK both ways. */
export function close(s: TcpState, rec: Rec): boolean {
  if (s.proto === 'udp') {
    rec.line('none');
    rec.step('There is nothing to close. UDP has no connection: the socket simply stops sending, and the receiver is not told.');
    return false;
  }
  if (s.conn !== 'open' || s.base < s.next) {
    rec.line('pending');
    rec.step(
      s.conn !== 'open'
        ? 'There is no open connection to close.'
        : `Segment ${s.base} is not acknowledged yet. This page closes only when all data is through: press Timeout first. A real stack queues its FIN behind the data.`,
    );
    return false;
  }
  const leg = (lane: 'data' | 'ack', text: string, anchor: string, msg: string) => {
    const p: Packet = { id: ++s.pid, text };
    if (lane === 'data') {
      s.data = [p];
      s.dataIn = false;
    } else {
      s.acks = [p];
      s.ackIn = false;
    }
    rec.mark(pid(p), 'key');
    rec.line(anchor);
    rec.step(msg, { probe: atPacket(p) });
    if (lane === 'data') s.dataIn = true;
    else s.ackIn = true;
    rec.step(`${text} crosses the link.`, { probe: atPacket(p) });
    rec.unmark(pid(p));
    s.data = [];
    s.acks = [];
  };
  leg('data', 'FIN', 'fin', 'The sender has nothing more to send, so it sends a FIN. It can still receive.');
  leg('ack', 'ACK', 'fin_ack', 'The receiver acknowledges the FIN. Its own side stays open until its application has finished too.');
  leg('ack', 'FIN', 'peer_fin', 'The receiving application closes as well, so the receiver sends its own FIN.');
  leg('data', 'ACK', 'time_wait', 'The sender acknowledges it. Four packets in all, though the middle two often travel as one.');
  s.conn = 'done';
  rec.line('time_wait');
  rec.step(
    'Closed. The side that closed first waits in TIME_WAIT for twice the maximum segment lifetime before it forgets the connection, so a late packet cannot be mistaken for part of a new one.',
  );
  return true;
}

// ---- UDP ------------------------------------------------------------------------

function udpDeliver(s: TcpState, seq: number, rec: Rec): boolean {
  const inOrder = s.app.every((q) => q < seq);
  s.app.push(seq);
  if (inOrder) count(s, rec, 'delivered');
  return inOrder;
}

function udpSend(s: TcpState, n: number, rec: Rec): number {
  let sent = 0;
  for (let i = 0; i < n; i++) {
    if (s.next > SEGMENTS) {
      rec.line('udp_all_sent');
      rec.step(`All ${SEGMENTS} datagrams have been sent. Reset to start again.`);
      break;
    }
    const seq = s.next;
    s.segs[seq - 1] = 'sent';
    s.next++;
    const t = transmit(s, seq, false, rec);
    rec.mark(pid(t.p), 'key');
    rec.line('fire', t.overtook !== null ? 'overtake' : 'put');
    rec.step(
      `${segName(s, seq)} goes out at once: no handshake, no window, no timer.` +
        (seq === 1 ? ' UDP has no sequence numbers at all. The numbers here are only for you to follow; an application that needs them adds its own.' : '') +
        faultNote(s, t),
      { probe: atPacket(t.p) },
    );
    rec.unmark(pid(t.p));
    sent++;
  }
  if (!sent) return 0;
  s.dataIn = true;
  const order = s.data.map((p) => p.seq!);
  rec.line('udp_arrive');
  rec.step(
    `The ${sent === 1 ? 'datagram crosses' : 'datagrams cross'} the link` + (order.join() !== [...order].sort((a, b) => a - b).join() ? `, in the order ${list(order)}.` : '.'),
    { probe: atPacket(s.data[0]) },
  );
  while (s.data.length) {
    const p = s.data[0];
    const seq = p.seq!;
    const name = segName(s, seq);
    if (p.fault === 'drop') {
      rec.mark(pid(p), 'bad');
      rec.line('udp_lost');
      count(s, rec, 'lost');
      s.segs[seq - 1] = 'lost';
      rec.step(`${name} is lost on the link. Nothing will ever notice: no ack is missing, no timer runs, nothing is resent. Only this page knows.`, { probe: atPacket(p) });
      rec.unmark(pid(p));
      s.data.shift();
      continue;
    }
    s.data.shift();
    s.from[seq] = p.id;
    if (s.slow && s.unread.length >= RCV_BUF) {
      count(s, rec, 'lost');
      s.segs[seq - 1] = 'lost';
      rec.line('overflow');
      rec.step(`${name} arrives, but the socket buffer is full because the application is not reading. It is dropped, and the sender is not told.`);
      continue;
    }
    if (s.slow) {
      s.unread.push(seq);
      rec.mark(rid(seq), 'key');
      rec.line('udp_unread');
      rec.step(`${name} waits in the socket buffer: the application is not reading.`, { probe: { text: name, at: rid(seq) } });
      rec.unmark(rid(seq));
      continue;
    }
    const before = [...s.app];
    const inOrder = udpDeliver(s, seq, rec);
    rec.mark(rid(seq), 'key');
    rec.line('udp_deliver', 'udp_up');
    const earlier = before.filter((q) => q > seq);
    const missing = Array.from({ length: seq - 1 }, (_, k) => k + 1).filter((q) => !before.includes(q));
    rec.step(
      `${name} goes straight up to the application` +
        (!inOrder
          ? `, after ${list(earlier)}. It is out of order, and UDP does not fix that.`
          : missing.length
            ? `, although ${list(missing)} ${missing.length === 1 ? 'has' : 'have'} not arrived. UDP does not wait for anything.`
            : `.`),
      { probe: { text: name, at: rid(seq) } },
    );
    rec.unmark(rid(seq));
  }
  rec.line('udp_arrive');
  const lostNow = s.segs.map((st, i) => (st === 'lost' ? i + 1 : 0)).filter(Boolean);
  rec.step(
    `The application got ${s.app.length ? list(s.app) : 'nothing'}, in that order.` +
      (lostNow.length ? ` ${list(lostNow)} ${lostNow.length === 1 ? 'is' : 'are'} lost for good.` : '') +
      ` No round trip was spent and no state was kept. Whether that is acceptable is up to the application.`,
  );
  return sent;
}

// ---- reset and the UDP comparison ---------------------------------------------

export function reset(s: TcpState, proto: number | string, rec: Rec): boolean {
  const p = String(proto).trim().toLowerCase();
  rec.line('reset');
  if (p !== 'tcp' && p !== 'udp') {
    rec.step(`Enter tcp or udp.`);
    return false;
  }
  Object.assign(s, create(p, s.window), { pid: s.pid });
  rec.step(
    p === 'tcp'
      ? `A fresh TCP sender and receiver, with no connection yet. Press Connect.`
      : `A fresh UDP sender and receiver. There is no connection to open: press Send.`,
  );
  return true;
}

/** The same loss over UDP: datagrams 1 to 4, where 4 is lost and 2 is overtaken by 3. */
export function udpCompare(s: TcpState, rec: Rec): void {
  Object.assign(s, create('udp', s.window), { pid: s.pid });
  rec.line('reset');
  rec.step(`Now the same link under UDP: a fresh sender and receiver, datagrams 1 to ${SEGMENTS}, and no connection.`);
  s.faults[2] = 'reorder';
  s.faults[4] = 'drop';
  rec.line('arm');
  rec.step(`The link will lose datagram 4, the same loss as before, and hold back datagram 2 so that 3 overtakes it.`);
  udpSend(s, 4, rec);
}

// ---- layout -----------------------------------------------------------------------

export const WIDTH = 926;
const HEAD_W = 80;
const SEG_W = 40;
const PITCH = 43;
const SEG_X0 = HEAD_W + 12 + SEG_W / 2;
const RX0 = 466;
const R_X0 = RX0 + HEAD_W + 12 + SEG_W / 2;
const segX = (i: number) => SEG_X0 + i * PITCH;
const rX = (i: number) => R_X0 + i * PITCH;
const PKT_W = 92;
const PKT_PITCH = 98;
const LANE_L = 112;
const LANE_R = WIDTH - 4;
const CHIP = PROBE_H + 16;
export const ROW_Y = 0;
const TAG_Y = CELL_H / 2 + SUB_ROOM + TAG_H / 2;
export const DATA_Y = TAG_Y + TAG_H / 2 + CHIP + CELL_H / 2;
export const ACK_Y = DATA_Y + CELL_H + CHIP;
export const BOT_Y = ACK_Y + CELL_H / 2 + SUB_ROOM + CHIP + CELL_H / 2;
const EXPECT_Y = BOT_Y + CELL_H / 2 + SUB_ROOM + TAG_H / 2 - 18;
const TOP = ROW_Y - CELL_H / 2 - CHIP;
export const BOTTOM = EXPECT_Y + TAG_H / 2;

const segTone: Record<SegState, Tone | undefined> = { unsent: undefined, sent: 'path', acked: 'ok', lost: 'bad' };

export function layout(s: TcpState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const tcp = s.proto === 'tcp';

  // Lanes first, so they sit behind everything.
  decor.push({ id: 'lane-d', type: 'band', x: 0, y: DATA_Y - 26, w: WIDTH, h: 52 });
  decor.push({ id: 'lane-a', type: 'band', x: 0, y: ACK_Y - 26, w: WIDTH, h: 26 + CELL_H / 2 + SUB_ROOM });
  decor.push({ id: 'lane-d-label', type: 'label', x: 10, y: DATA_Y - LABEL_LINE / 2, text: tcp ? 'segments\n→' : 'datagrams\n→', strong: true });
  decor.push({ id: 'lane-a-label', type: 'label', x: 10, y: ACK_Y - LABEL_LINE / 2, text: tcp ? 'acks\n←' : 'nothing\ncomes back', strong: true });

  // Sender: the window behind the segments, then the segments.
  const limit = tcp ? limitOf(s) : 0;
  if (tcp && s.conn === 'open' && s.base <= SEGMENTS && limit > 0) {
    const last = Math.min(SEGMENTS, s.base + limit - 1);
    const x1 = segX(s.base - 1) - SEG_W / 2 - 5;
    decor.push({ id: 'window', type: 'band', x: x1, y: -CELL_H / 2 - 5, w: segX(last - 1) + SEG_W / 2 + 5 - x1, h: CELL_H + 10 });
  }
  const conn = s.conn === 'done' ? 'closed' : s.conn;
  nodes.push({
    id: 'h-snd',
    x: HEAD_W / 2,
    y: ROW_Y,
    cells: [{ text: 'sender', w: HEAD_W }],
    caption: tcp ? `${conn}\nwindow ${limit}` : 'UDP\nno window',
  });
  for (let q = 1; q <= SEGMENTS; q++) {
    const timer = tcp && s.conn === 'open' && q === s.base && s.base < s.next;
    nodes.push({
      id: sid(q),
      x: segX(q - 1),
      y: ROW_Y,
      cells: [{ text: String(q), w: SEG_W, ...(timer ? { sub: 'timer', subValue: true } : {}) }],
      tone: segTone[s.segs[q - 1]],
    });
  }
  if (s.next <= SEGMENTS) nodes.push({ id: 'tag-next', x: segX(s.next - 1), y: TAG_Y, cells: [{ text: 'next' }], shape: 'tag' });

  // Receiver: the buffer, then the application.
  nodes.push({ id: 'h-buf', x: RX0 + HEAD_W / 2, y: ROW_Y, cells: [{ text: 'buffer', w: HEAD_W }], caption: tcp ? `rwnd ${RCV_BUF - s.unread.length}` : `holds ${RCV_BUF}` });
  const inBuffer: [number, string][] = [...s.unread.map((q): [number, string] => [q, 'unread']), ...s.held.map((q): [number, string] => [q, 'held'])];
  for (let i = 0; i < RCV_BUF; i++) {
    const item = inBuffer[i];
    if (item) nodes.push({ id: rid(item[0]), x: rX(i), y: ROW_Y, cells: [{ text: String(item[0]), w: SEG_W, sub: item[1] }], from: s.from[item[0]] ? `p${s.from[item[0]]}` : undefined });
    else nodes.push({ id: `bs${i}`, x: rX(i), y: ROW_Y, cells: [{ text: '', w: SEG_W }] });
  }
  nodes.push({ id: 'h-app', x: RX0 + HEAD_W / 2, y: BOT_Y, cells: [{ text: 'app', w: HEAD_W }], caption: s.slow ? 'not reading' : 'reading' });
  const appSlots: (number | null)[] = new Array(SEGMENTS).fill(null);
  // TCP's application only ever holds 1, 2, 3 ... so segment q has slot q - 1. UDP's holds them as they came.
  s.app.forEach((q, i) => (appSlots[tcp ? q - 1 : i] = q));
  appSlots.forEach((q, i) => {
    if (q !== null) nodes.push({ id: rid(q), x: rX(i), y: BOT_Y, cells: [{ text: String(q), w: SEG_W }], tone: 'ok', from: s.from[q] ? `p${s.from[q]}` : undefined });
    else nodes.push({ id: `as${i}`, x: rX(i), y: BOT_Y, cells: [{ text: '', w: SEG_W }] });
  });
  if (tcp && s.expected <= SEGMENTS) nodes.push({ id: 'tag-expect', x: rX(s.expected - 1), y: EXPECT_Y, cells: [{ text: 'expect' }], shape: 'tag' });

  // Congestion strip.
  nodes.push({ id: 'h-cw', x: HEAD_W / 2, y: BOT_Y, cells: [{ text: 'cwnd', w: HEAD_W }], caption: tcp ? `ssthresh ${s.ssthresh}` : 'none' });
  for (let r = 1; r <= ROUNDS; r++) {
    const v = s.cwnd[r - 1];
    nodes.push({ id: `cw${r}`, x: segX(r - 1), y: BOT_Y, cells: [{ text: v === undefined ? '' : String(v), w: SEG_W, sub: `r${r}` }], tone: r === s.lossRound && v !== undefined ? 'bad' : undefined });
  }

  // Packets in flight. Leaving: the newest nearest its sender. Arriving: the oldest nearest its receiver.
  const n = s.data.length;
  s.data.forEach((p, i) => {
    const x = s.dataIn ? LANE_R - PKT_W / 2 - i * PKT_PITCH : LANE_L + PKT_W / 2 + (n - 1 - i) * PKT_PITCH;
    nodes.push({ id: pid(p), x, y: DATA_Y, cells: [{ text: p.text, w: PKT_W }], from: p.seq ? sid(p.seq) : 'h-snd' });
  });
  const m = s.acks.length;
  s.acks.forEach((p, i) => {
    const x = s.ackIn ? LANE_L + PKT_W / 2 + i * PKT_PITCH : LANE_R - PKT_W / 2 - (m - 1 - i) * PKT_PITCH;
    nodes.push({ id: pid(p), x, y: ACK_Y, cells: [{ text: p.text, w: PKT_W, ...(p.sub ? { sub: p.sub, subValue: true } : {}) }], from: 'h-buf' });
  });

  // Two empty labels pin the corners, so the view never rescales.
  decor.push({ id: 'corner-a', type: 'label', x: 0, y: TOP + LABEL_MAX * 0.65, text: '' });
  decor.push({ id: 'corner-b', type: 'label', x: WIDTH, y: BOTTOM - LABEL_MAX * 0.65, text: '' });
  return { nodes, edges: [], decor };
}

// ---- definition -------------------------------------------------------------------

const SEG_ARG = { name: 'seq', label: 'Segment', kind: 'int', min: 1, max: SEGMENTS } as const;

/** The next segment that will go out, which is the one worth tampering with. */
function suggestSeg(s: TcpState): number {
  return Math.min(SEGMENTS, s.next);
}

const def: StructureDef<TcpState> = {
  id: 'tcp',
  params: [
    { id: 'protocol', label: 'Protocol', default: 0, options: [{ value: 0, label: 'TCP' }, { value: 1, label: 'UDP' }] },
    { id: 'window', label: 'Send window', default: 4, options: [3, 4].map((v) => ({ value: v, label: `${v} segments` })) },
  ],
  create: (params) => create(params.protocol === 1 ? 'udp' : 'tcp', params.window ?? 4),
  // An empty seed: TCP starts with no connection, which is the first thing the tour shows.
  seed: [],
  ops: [
    { id: 'connect', label: 'Connect', args: [], code: ['connect', 'udp_none'], run: (s, _a, rec) => void connect(s, rec) },
    {
      id: 'send',
      label: 'Send',
      intent: 'primary',
      args: [{ name: 'count', label: 'Segments', kind: 'int', min: 1, max: SEGMENTS }],
      code: ['send', 'link', 'run', 'on_segment', 'hand_up', 'on_ack', 'retransmit', 'udp_send', 'udp_deliver'],
      run: (s, [n], rec) => void send(s, Number(n), rec),
      suggest: (s) => [Math.max(1, Math.min(s.proto === 'tcp' ? s.window : 4, SEGMENTS - s.next + 1))],
    },
    { id: 'drop', label: 'Drop', intent: 'danger', args: [SEG_ARG], code: ['arm'], run: (s, [q], rec) => void arm(s, Number(q), 'drop', rec), suggest: (s) => [suggestSeg(s)] },
    { id: 'reorder', label: 'Reorder', args: [SEG_ARG], code: ['arm', 'link'], run: (s, [q], rec) => void arm(s, Number(q), 'reorder', rec), suggest: (s) => [suggestSeg(s)] },
    {
      id: 'timeout',
      label: 'Timeout',
      args: [],
      code: ['timeout', 'retransmit', 'link', 'run', 'on_segment', 'hand_up', 'on_ack', 'udp_none'],
      run: (s, _a, rec) => void timeout(s, rec),
    },
    {
      id: 'dup_acks',
      label: 'Fast retransmit',
      args: [],
      code: ['dup_acks', 'on_ack', 'retransmit', 'send', 'link', 'run', 'on_segment', 'hand_up', 'udp_none'],
      run: (s, _a, rec) => void dupAcks(s, rec),
    },
    { id: 'slow_receiver', label: 'Slow receiver', args: [], code: ['slow', 'read', 'run', 'on_ack', 'udp_slow', 'udp_deliver'], run: (s, _a, rec) => slowReceiver(s, rec) },
    { id: 'congestion', label: 'Congestion', args: [], code: ['congestion', 'udp_none'], run: (s, _a, rec) => congestion(s, rec) },
    { id: 'close', label: 'Close', args: [], code: ['close', 'udp_none'], run: (s, _a, rec) => void close(s, rec) },
    { id: 'udp', label: 'Same loss, UDP', args: [], code: ['udp_send', 'udp_deliver', 'arm', 'reset', 'link'], run: (s, _a, rec) => udpCompare(s, rec) },
    {
      id: 'reset',
      label: 'Reset',
      intent: 'danger',
      args: [{ name: 'protocol', label: 'tcp or udp', kind: 'word' }],
      code: ['reset'],
      run: (s, [p], rec) => void reset(s, p, rec),
      suggest: (s) => [s.proto],
    },
  ],
  layout,
  counters: [
    { key: 'sent', label: 'Segments sent' },
    { key: 'retransmissions', label: 'Retransmissions' },
    { key: 'delivered', label: 'Delivered in order' },
    { key: 'lost', label: 'Lost for good' },
  ],
  status: (s) =>
    s.proto === 'tcp'
      ? [
          { label: 'Connection', value: `TCP, ${s.conn === 'done' ? 'closed' : s.conn}` },
          { label: 'In flight', value: `${inFlight(s)} of ${limitOf(s)}` },
          { label: 'Receiver expects', value: s.expected <= SEGMENTS ? `segment ${s.expected}` : 'nothing more' },
          { label: 'Duplicate acks', value: String(s.dupAcks) },
        ]
      : [
          { label: 'Connection', value: 'UDP, none' },
          { label: 'Sent', value: String(s.totals.sent) },
          { label: 'Application got', value: s.app.length ? s.app.join(', ') : 'nothing' },
          { label: 'Lost for good', value: String(s.totals.lost) },
        ],
  tour: [['connect'], ['send', 3], ['drop', 4], ['send', 4], ['udp']],
  source: { python, java },
  info,
};

export default def;
