"""TCP's sliding window over a lossy link, and UDP for contrast."""

SEGMENTS = 8
RCV_BUF = 4  # receive buffer, in segments


class Link:
    """Delivers packets in the order sent, unless told to lose or delay one."""

    def __init__(self):
        self.faults = {}  # segment number -> "drop" or "reorder"
        self.wire = []  # [seq, fault], oldest first

    # region arm
    def arm(self, seq, fault):
        """Lose ("drop") or delay ("reorder") the next copy of seq."""
        self.faults[seq] = fault  #@arm
    # endregion

    # region link
    def put(self, seq):
        """Puts a segment on the wire, with any fault armed for it."""
        packet = [seq, self.faults.pop(seq, None)]  #@put
        last = self.wire[-1] if self.wire else None
        if last is not None and last[1] == "reorder":  #@overtake
            last[1] = None  # overtaken: it arrives after this one
            self.wire.insert(len(self.wire) - 1, packet)  #@overtake
        else:
            self.wire.append(packet)  #@put
    # endregion


class Receiver:
    """Puts segments back in order and says what it expects next."""

    def __init__(self):
        self.expected = 1  # next in-order segment
        self.held = set()  # arrived early, waiting for a gap to fill
        self.unread = []  # in order, not yet read by the application
        self.app = []  # what the application has read
        self.slow = False

    # region on_segment
    def on_segment(self, seq):
        """Returns the ack: (next expected, window, update)."""
        if seq == self.expected:  #@in_order
            self.hand_up(seq)  #@deliver
            self.expected += 1  #@deliver
            while self.expected in self.held:  #@drain
                self.held.remove(self.expected)  #@drain
                self.hand_up(self.expected)  #@drain
                self.expected += 1  #@drain
        elif seq > self.expected:  #@early
            self.held.add(seq)  #@hold
        # A duplicate is ignored, but still acknowledged.
        return self.expected, self.window(), False  #@ack
    # endregion

    # region hand_up
    def hand_up(self, seq):
        """Gives a segment to the application, or keeps it until read."""
        if self.slow:
            self.unread.append(seq)  #@unread
        else:
            self.app.append(seq)  #@app

    def window(self):
        """Free space in the receive buffer: the advertised window."""
        return RCV_BUF - len(self.unread)  #@rwnd
    # endregion

    # region read
    def set_slow(self, slow):
        """Returns a window update when reading frees space."""
        self.slow = slow  #@toggle
        if slow or not self.unread:
            return None
        self.app.extend(self.unread)  #@read
        self.unread.clear()  #@read
        return self.expected, self.window(), True  #@read
    # endregion


class Tcp:
    """A sender and a receiver joined by a lossy link."""

    def __init__(self, window=4):
        self.window = window  # send window, in segments
        self.state = "closed"
        self.base = 1  # oldest segment not yet acknowledged
        self.next = 1  # next new segment to send
        self.peer_window = RCV_BUF  # last window the receiver advertised
        self.dup_acks = 0
        self.link = Link()
        self.rcv = Receiver()
        self.acks = []  # acks on their way back
        self.sent = 0
        self.retransmissions = 0

    # region connect
    def connect(self, isn=100, peer_isn=300):
        """Three-way handshake. Each side picks a starting number."""
        if self.state != "closed":
            return False  #@already
        syn = isn  #@syn
        # The SYN uses up one number, so the reply asks for isn + 1.
        syn_ack = (peer_isn, syn + 1)  #@syn_ack
        seq, ack = syn_ack
        if ack != isn + 1:  #@check
            raise ConnectionError("SYN-ACK acknowledges the wrong number")
        self.ack_sent = seq + 1  #@ack
        self.state = "open"  #@open
        return True
    # endregion

    # region send
    def send(self, count):
        """One flight: as many segments as the windows allow."""
        if self.state != "open":
            return 0  #@closed
        sent = 0
        for _ in range(count):
            if self.next > SEGMENTS:
                break  #@all_sent
            limit = min(self.window, self.peer_window)  #@limit
            in_flight = self.next - self.base  #@limit
            if in_flight >= limit:  #@full
                break  # wait for acks
            self.sent += 1  #@send
            self.link.put(self.next)  #@send
            self.next += 1  #@send
            sent += 1
        self.run()  #@run
        return sent
    # endregion

    # region run
    def run(self):
        """Lets the link deliver until nothing is in flight."""
        while self.link.wire or self.acks:
            while self.link.wire:  #@arrive
                seq, fault = self.link.wire.pop(0)  #@arrive
                if fault == "drop":  #@lost
                    continue  # lost: nobody is told  #@lost
                self.acks.append(self.rcv.on_segment(seq))  #@to_receiver
            while self.acks:  #@ack_back
                self.on_ack(*self.acks.pop(0))  #@ack_back
    # endregion

    # region on_ack
    def on_ack(self, ack, window, update=False):
        """Slides the window, or counts a duplicate ack."""
        self.peer_window = window  #@peer_window
        if ack > self.base:  #@new_ack
            self.base = ack  # everything below ack has arrived  #@slide
            self.dup_acks = 0  #@slide
        elif ack == self.base < self.next and not update:  #@dup
            self.dup_acks += 1  #@dup
            if self.dup_acks == 3:  #@three
                self.retransmit(self.base)  #@fast
    # endregion

    # region retransmit
    def retransmit(self, seq):
        """Sends a segment again, after a loss."""
        self.retransmissions += 1  #@resend
        self.sent += 1  #@resend
        self.link.put(seq)  #@resend
    # endregion

    # region timeout
    def timeout(self):
        """The timer for the oldest unacknowledged segment fires."""
        if self.state != "open" or self.base == self.next:
            return False  # nothing outstanding, no timer  #@idle
        self.dup_acks = 0  #@expire
        self.retransmit(self.base)  #@expire
        self.run()  #@run
        return True
    # endregion

    # region dup_acks
    def lose_and_send(self):
        """Loses the next new segment, then sends a full window."""
        self.link.arm(self.next, "drop")  #@lose_next
        return self.send(self.window)  #@lose_next
    # endregion

    # region slow
    def set_slow(self, slow):
        """The receiving application stops or starts reading."""
        update = self.rcv.set_slow(slow)  #@toggle
        if update is not None and self.state == "open":
            self.acks.append(update)  #@update
            self.run()  #@update
    # endregion

    # region close
    def close(self):
        """FIN and ACK each way, once all data is acknowledged."""
        if self.state != "open" or self.base < self.next:
            return False  #@pending
        self.state = "FIN_WAIT_1"  # our FIN is out  #@fin
        self.state = "FIN_WAIT_2"  # the peer acked it  #@fin_ack
        self.state = "TIME_WAIT"  # peer's FIN in, our ACK out  #@peer_fin
        self.state = "done"  # after 2 x maximum segment lifetime  #@time_wait
        return True
    # endregion


class Udp:
    """Datagrams: no handshake, no acks, no order."""

    def __init__(self):
        self.link = Link()
        self.next = 1
        self.app = []
        self.unread = []
        self.slow = False
        self.sent = 0
        self.delivered = 0  # in order: later than all before it
        self.lost = 0

    # region udp_send
    def send(self, count):
        """Fires datagrams. Nothing ever comes back."""
        for _ in range(count):
            if self.next > SEGMENTS:
                break  #@udp_all_sent
            self.sent += 1  #@fire
            self.link.put(self.next)  #@fire
            self.next += 1  #@fire
        while self.link.wire:  #@udp_arrive
            seq, fault = self.link.wire.pop(0)  #@udp_arrive
            if fault == "drop":  #@udp_lost
                self.lost += 1  # only this simulation knows  #@udp_lost
            elif self.slow and len(self.unread) == RCV_BUF:  #@overflow
                self.lost += 1  # socket buffer full: dropped  #@overflow
            elif self.slow:
                self.unread.append(seq)  #@udp_unread
            else:
                self.deliver(seq)  #@udp_deliver
    # endregion

    # region udp_deliver
    def deliver(self, seq):
        """Hands a datagram up, in whatever order it came."""
        if not self.app or seq > max(self.app):
            self.delivered += 1  # nothing later came first
        self.app.append(seq)  #@udp_up
    # endregion

    # region udp_slow
    def set_slow(self, slow):
        """The application stops or starts reading."""
        self.slow = slow  #@udp_toggle
        if not slow:
            for seq in self.unread:  #@udp_read
                self.deliver(seq)  #@udp_read
            self.unread.clear()  #@udp_read
    # endregion

    # region udp_none
    def connect(self):
        """No connection, no acks, no timer, no window to manage."""
        return False  #@none
    # endregion


# region congestion
def cwnd_trace(rounds=8, loss_round=6):
    """Congestion window per round trip, Reno style, simplified."""
    cwnd, ssthresh = 1, 8  #@start
    trace = []
    for r in range(1, rounds + 1):
        trace.append(cwnd)  #@round
        if r == loss_round:  #@loss
            ssthresh = cwnd // 2  #@halve
            cwnd = ssthresh  #@halve
        elif cwnd < ssthresh:  #@slow_start
            cwnd *= 2  # one more per ack: doubles each round  #@double
        else:
            cwnd += 1  # one more per round trip  #@additive
    return trace
# endregion


# region reset
def open_socket(protocol, window=4):
    """A fresh sender and receiver."""
    if protocol == "udp":  #@reset
        return Udp()  #@reset
    return Tcp(window)  #@reset
# endregion
