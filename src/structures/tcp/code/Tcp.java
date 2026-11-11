import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/** TCP's sliding window over a lossy link, and UDP for contrast. */
public class Tcp {
    static final int SEGMENTS = 8;
    static final int RCV_BUF = 4; // receive buffer, in segments

    /** A segment on the wire, with the fault the link will apply. */
    static final class Packet {
        final int seq;
        String fault; // "drop", "reorder" or null

        Packet(int seq, String fault) {
            this.seq = seq;
            this.fault = fault;
        }
    }

    /** An ack on its way back to the sender. */
    record Ack(int ack, int window, boolean update) {}

    /** Delivers packets in the order sent, unless told otherwise. */
    static final class Link {
        final Map<Integer, String> faults = new HashMap<>();
        final List<Packet> wire = new ArrayList<>(); // oldest first

        // region arm
        /** Loses ("drop") or delays ("reorder") the next copy of seq. */
        void arm(int seq, String fault) {
            faults.put(seq, fault); //@arm
        }
        // endregion

        // region link
        /** Puts a segment on the wire, with any fault armed for it. */
        void put(int seq) {
            Packet packet = new Packet(seq, faults.remove(seq)); //@put
            Packet last = wire.isEmpty() ? null : wire.get(wire.size() - 1);
            if (last != null && "reorder".equals(last.fault)) { //@overtake
                last.fault = null; // overtaken: it arrives after this
                wire.add(wire.size() - 1, packet); //@overtake
            } else {
                wire.add(packet); //@put
            }
        }
        // endregion
    }

    /** Puts segments back in order and says what it expects next. */
    static final class Receiver {
        int expected = 1; // next in-order segment
        final TreeSet<Integer> held = new TreeSet<>(); // arrived early
        final List<Integer> unread = new ArrayList<>(); // not yet read
        final List<Integer> app = new ArrayList<>(); // read by the app
        boolean slow;

        // region on_segment
        /** Returns the ack: next expected and the window. */
        Ack onSegment(int seq) {
            if (seq == expected) { //@in_order
                handUp(seq); //@deliver
                expected++; //@deliver
                while (held.contains(expected)) { //@drain
                    held.remove(expected); //@drain
                    handUp(expected); //@drain
                    expected++; //@drain
                }
            } else if (seq > expected) { //@early
                held.add(seq); //@hold
            }
            // A duplicate is ignored, but still acknowledged.
            return new Ack(expected, window(), false); //@ack
        }
        // endregion

        // region hand_up
        /** Gives a segment to the app, or keeps it until read. */
        void handUp(int seq) {
            if (slow) {
                unread.add(seq); //@unread
            } else {
                app.add(seq); //@app
            }
        }

        /** Free space in the receive buffer: the advertised window. */
        int window() {
            return RCV_BUF - unread.size(); //@rwnd
        }
        // endregion

        // region read
        /** Returns a window update when reading frees space. */
        Ack setSlow(boolean slow) {
            this.slow = slow; //@toggle
            if (slow || unread.isEmpty()) {
                return null;
            }
            app.addAll(unread); //@read
            unread.clear(); //@read
            return new Ack(expected, window(), true); //@read
        }
        // endregion
    }

    final int window; // send window, in segments
    String state = "closed";
    int base = 1; // oldest segment not yet acknowledged
    int next = 1; // next new segment to send
    int peerWindow = RCV_BUF; // last window the receiver advertised
    int dupAcks;
    int ackSent;
    final Link link = new Link();
    final Receiver rcv = new Receiver();
    final ArrayDeque<Ack> acks = new ArrayDeque<>();
    int sent;
    int retransmissions;

    public Tcp(int window) {
        this.window = window;
    }

    // region connect
    /** Three-way handshake. Each side picks a starting number. */
    public boolean connect(int isn, int peerIsn) {
        if (!state.equals("closed")) {
            return false; //@already
        }
        int syn = isn; //@syn
        // The SYN uses up one number, so the reply asks for isn + 1.
        int[] synAck = {peerIsn, syn + 1}; //@syn_ack
        if (synAck[1] != isn + 1) { //@check
            throw new IllegalStateException("wrong ack in SYN-ACK");
        }
        ackSent = synAck[0] + 1; //@ack
        state = "open"; //@open
        return true;
    }
    // endregion

    // region send
    /** One flight: as many segments as the windows allow. */
    public int send(int count) {
        if (!state.equals("open")) {
            return 0; //@closed
        }
        int done = 0;
        for (int i = 0; i < count; i++) {
            if (next > SEGMENTS) {
                break; //@all_sent
            }
            int limit = Math.min(window, peerWindow); //@limit
            int inFlight = next - base; //@limit
            if (inFlight >= limit) { //@full
                break; // wait for acks
            }
            sent++; //@send
            link.put(next); //@send
            next++; //@send
            done++;
        }
        run(); //@run
        return done;
    }
    // endregion

    // region run
    /** Lets the link deliver until nothing is in flight. */
    void run() {
        while (!link.wire.isEmpty() || !acks.isEmpty()) {
            while (!link.wire.isEmpty()) { //@arrive
                Packet p = link.wire.remove(0); //@arrive
                if ("drop".equals(p.fault)) { //@lost
                    continue; // lost: nobody is told //@lost
                }
                acks.add(rcv.onSegment(p.seq)); //@to_receiver
            }
            while (!acks.isEmpty()) { //@ack_back
                onAck(acks.poll()); //@ack_back
            }
        }
    }
    // endregion

    // region on_ack
    /** Slides the window, or counts a duplicate ack. */
    void onAck(Ack a) {
        peerWindow = a.window(); //@peer_window
        if (a.ack() > base) { //@new_ack
            base = a.ack(); // everything below has arrived //@slide
            dupAcks = 0; //@slide
        } else if (a.ack() == base && base < next && !a.update()) { //@dup
            dupAcks++; //@dup
            if (dupAcks == 3) { //@three
                retransmit(base); //@fast
            }
        }
    }
    // endregion

    // region retransmit
    /** Sends a segment again, after a loss. */
    void retransmit(int seq) {
        retransmissions++; //@resend
        sent++; //@resend
        link.put(seq); //@resend
    }
    // endregion

    // region timeout
    /** The timer for the oldest unacknowledged segment fires. */
    public boolean timeout() {
        if (!state.equals("open") || base == next) {
            return false; // nothing outstanding, no timer //@idle
        }
        dupAcks = 0; //@expire
        retransmit(base); //@expire
        run(); //@run
        return true;
    }
    // endregion

    // region dup_acks
    /** Loses the next new segment, then sends a full window. */
    public int loseAndSend() {
        link.arm(next, "drop"); //@lose_next
        return send(window); //@lose_next
    }
    // endregion

    // region slow
    /** The receiving application stops or starts reading. */
    public void setSlow(boolean slow) {
        Ack update = rcv.setSlow(slow); //@toggle
        if (update != null && state.equals("open")) {
            acks.add(update); //@update
            run(); //@update
        }
    }
    // endregion

    // region close
    /** FIN and ACK each way, once all data is acknowledged. */
    public boolean close() {
        if (!state.equals("open") || base < next) {
            return false; //@pending
        }
        state = "FIN_WAIT_1"; // our FIN is out //@fin
        state = "FIN_WAIT_2"; // the peer acked it //@fin_ack
        state = "TIME_WAIT"; // peer's FIN in, our ACK out //@peer_fin
        state = "done"; // after 2 x maximum segment lifetime //@time_wait
        return true;
    }
    // endregion

    /** Datagrams: no handshake, no acks, no order. */
    static final class Udp {
        final Link link = new Link();
        int next = 1;
        final List<Integer> app = new ArrayList<>();
        final List<Integer> unread = new ArrayList<>();
        boolean slow;
        int sent;
        int delivered; // in order: later than all before it
        int lost;
        int highest;

        // region udp_send
        /** Fires datagrams. Nothing ever comes back. */
        void send(int count) {
            for (int i = 0; i < count; i++) {
                if (next > SEGMENTS) {
                    break; //@udp_all_sent
                }
                sent++; //@fire
                link.put(next); //@fire
                next++; //@fire
            }
            while (!link.wire.isEmpty()) { //@udp_arrive
                Packet p = link.wire.remove(0); //@udp_arrive
                if ("drop".equals(p.fault)) { //@udp_lost
                    lost++; // only this simulation knows //@udp_lost
                } else if (slow && unread.size() == RCV_BUF) { //@overflow
                    lost++; // socket buffer full: dropped //@overflow
                } else if (slow) {
                    unread.add(p.seq); //@udp_unread
                } else {
                    deliver(p.seq); //@udp_deliver
                }
            }
        }
        // endregion

        // region udp_deliver
        /** Hands a datagram up, in whatever order it came. */
        void deliver(int seq) {
            if (seq > highest) {
                delivered++; // nothing later came first
                highest = seq;
            }
            app.add(seq); //@udp_up
        }
        // endregion

        // region udp_slow
        /** The application stops or starts reading. */
        void setSlow(boolean slow) {
            this.slow = slow; //@udp_toggle
            if (!slow) {
                for (int seq : unread) { //@udp_read
                    deliver(seq); //@udp_read
                }
                unread.clear(); //@udp_read
            }
        }
        // endregion

        // region udp_none
        /** No connection, no acks, no timer, no window to manage. */
        boolean connect() {
            return false; //@none
        }
        // endregion
    }

    // region congestion
    /** Congestion window per round trip, Reno style, simplified. */
    static List<Integer> cwndTrace(int rounds, int lossRound) {
        int cwnd = 1, ssthresh = 8; //@start
        List<Integer> trace = new ArrayList<>();
        for (int r = 1; r <= rounds; r++) {
            trace.add(cwnd); //@round
            if (r == lossRound) { //@loss
                ssthresh = cwnd / 2; //@halve
                cwnd = ssthresh; //@halve
            } else if (cwnd < ssthresh) { //@slow_start
                cwnd *= 2; // one more per ack: doubles each round //@double
            } else {
                cwnd += 1; // one more per round trip //@additive
            }
        }
        return trace;
    }
    // endregion

    // region reset
    /** A fresh sender and receiver: a Tcp or a Udp. */
    static Object openSocket(String protocol, int window) {
        if (protocol.equals("udp")) { //@reset
            return new Udp(); //@reset
        }
        return new Tcp(window); //@reset
    }
    // endregion
}
