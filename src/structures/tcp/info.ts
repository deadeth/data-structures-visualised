import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'TCP turns a network that loses, delays and reorders packets into a reliable byte stream that arrives in order. It numbers what it sends, the receiver acknowledges what it has, and anything left unacknowledged is sent again. UDP skips all of that: each datagram is sent once, with no connection, no acks and no ordering, so it is faster to start and never waits, but it guarantees nothing.',
  watch: [
    'The handshake costs a full round trip before any data moves: SYN 100, SYN-ACK with ack 101, ACK 301. Each ack names the next number expected, and a SYN uses up one number.',
    'The sender compares segments in flight with the window before every send. With a window of 4, the fifth segment waits until an ack slides the window on.',
    'Each ack is cumulative: "ack 4" means everything before 4 has arrived. One ack can acknowledge several segments at once.',
    'In the tour, segment 4 is lost. Segments 5, 6 and 7 arrive and wait in the receive buffer, and each one makes the receiver send ack 4 again. The third duplicate triggers fast retransmit, with no wait for the timer.',
    'When 4 finally arrives, 4, 5, 6 and 7 all go up to the application at once. Until then 5 to 7 had arrived but could not be used. That is head-of-line blocking.',
    'Rebuild with a send window of 3 and do the same. Only 2 duplicate acks come back, so fast retransmit never fires and the sender stalls until you press Timeout.',
    'Under UDP the same loss is never noticed and never repaired, and the application gets 1, 3, 2 in the order the link delivered them. Counters: lost for good goes up, retransmissions stay at 0.',
    'Slow receiver: the application stops reading, the buffer fills, and each ack advertises less room. At 0 the sender pauses. That is flow control. Congestion control is a different window, drawn on the cwnd strip.',
  ],
  complexity: [
    { op: 'Connection set-up', average: '1 round trip', worst: '1 round trip + timeouts', note: 'Before the first byte. TLS on top adds 1 more round trip with TLS 1.3, 2 with TLS 1.2.' },
    { op: 'Send one segment', average: 'O(1)', worst: 'Waits for the window', note: 'At most min(send window, receiver window, congestion window) in flight.' },
    { op: 'Recover one loss, fast retransmit', average: '~1 extra round trip', worst: '~1 extra round trip', note: 'Needs 3 duplicate acks, so needs at least 3 segments sent after the lost one.' },
    { op: 'Recover one loss, timeout', average: 'The timeout', worst: 'Doubles each try', note: 'RFC 6298 advises at least 1 second; Linux uses a 200 ms minimum. Much longer than a round trip in a data centre.' },
    { op: 'UDP send', average: 'O(1)', worst: 'O(1)', note: 'No set-up, no state, no waiting. A lost datagram costs nothing to the sender and is simply gone.' },
  ],
  space:
    'TCP keeps state per connection on both ends: sequence numbers, the send buffer of unacknowledged data, the receive buffer, timers and the congestion window. That is kilobytes of buffer per connection, so a server holding 100,000 connections spends real memory on them. Header: 20 bytes minimum for TCP, 8 for UDP. UDP keeps no per-peer state at all.',
  usedIn: [
    { name: 'HTTP/1.1 and HTTP/2', how: 'Run over TCP, usually with TLS on top. HTTP/2 multiplexes many streams over one TCP connection, so one lost packet stalls every stream behind it: head-of-line blocking at the transport.' },
    { name: 'HTTP/3 and QUIC', how: 'QUIC (RFC 9000) runs over UDP and does its own reliability, ordering and congestion control, per stream. A loss stalls only the stream it belongs to. TLS 1.3 is built in, so a new connection takes 1 round trip in total, and a resumed one can send data in the first flight.' },
    { name: 'DNS', how: 'Ordinary queries go over UDP on port 53: one small question, one small answer, no handshake. It falls back to TCP when an answer is too large, and zone transfers use TCP.' },
    { name: 'Voice and video calls', how: 'RTP over UDP, which WebRTC uses for media. A late audio packet is useless, so it is better skipped than waited for.' },
    { name: 'Fast multiplayer games', how: 'Commonly send state updates over UDP and only make some messages reliable themselves. The newest position matters more than an old one that went missing.' },
    { name: 'Databases and service clients', how: 'PostgreSQL, MySQL and Redis clients speak over TCP. Applications keep those connections open and reuse them, usually through a pool, so a request skips the handshake and the slow start of a new connection.' },
    { name: 'Linux', how: 'Uses CUBIC congestion control by default and starts a new connection with a congestion window of 10 segments (RFC 6928). A connection that closed first stays in TIME_WAIT for 60 seconds.' },
  ],
  reachFor: [
    'TCP by default: anything where every byte matters and order matters. APIs, database traffic, file transfer, payments.',
    'UDP when a late answer is worthless: live audio and video, game state, telemetry where the next reading replaces the last.',
    'UDP for tiny request and reply exchanges where a handshake would double the cost, such as DNS, and the client can simply ask again.',
    'UDP as the base for your own protocol when you need reliability but not TCP\'s rules: QUIC is the main example, with independent streams and faster set-up.',
    'Long-lived TCP connections, reused through keep-alive and connection pools, for service-to-service calls: pay the handshake, TLS and slow start once.',
  ],
  costs: [
    'The handshake: one round trip before any data, plus TLS. Across an ocean at 80 ms a round trip, a fresh HTTPS request over TLS 1.3 waits about 160 ms before the request itself goes out.',
    'Head-of-line blocking: one lost segment holds back everything after it, even data for unrelated requests multiplexed on the same connection.',
    'State per connection on both sides: buffers, timers and windows. Many idle connections cost memory, and half-open ones can be used for attack (a SYN flood; SYN cookies are the defence).',
    'A loss slows the whole connection: congestion control halves the window, and a timeout drops it back to the start.',
    'UDP costs the other way: no delivery, no order, no flow or congestion control, no protection against duplicates. If you need any of these you must build them, and building them well is hard.',
    'Some networks block or throttle UDP, so products that use it (QUIC, calls) keep a TCP fallback.',
  ],
  interview: [
    'Say what each guarantees in one line. TCP: reliable, ordered, connection-oriented byte stream, with flow and congestion control. UDP: best-effort datagrams with a checksum, nothing else.',
    'Say how TCP gets reliability: sequence numbers, cumulative acks, a retransmission timer, and fast retransmit after three duplicate acks. Real TCP numbers bytes, not segments, with 32-bit sequence numbers starting at a random value.',
    'Keep the two windows apart. Flow control protects the receiver: it advertises how much buffer it has left. Congestion control protects the network: the sender guesses with cwnd, slow start then additive increase, halving on loss. The sender uses the smaller of the two.',
    'Name the cost of TCP: a round trip to connect, head-of-line blocking, and state on both ends. Then name the fixes: keep-alive and connection pooling to reuse connections, TLS 1.3 for one round trip of TLS, and QUIC for streams that do not block each other.',
    'TLS sits on top of TCP and adds encryption and authentication; it relies on TCP to deliver its records reliably and in order.',
    'Choose TCP by default. Say UDP only when latency beats completeness: "for the live video feed I would use UDP, through WebRTC, because a frame that arrives late is worse than one that never arrives."',
    'Know where reliability lives if you choose UDP: in the application or a library such as QUIC. "UDP is faster" is only true because it does less; if you add everything back, you have rebuilt TCP.',
    'For service-to-service calls, mention connection pools and their limits. A pool too small queues requests; too large and the database spends memory on idle connections.',
  ],
};
