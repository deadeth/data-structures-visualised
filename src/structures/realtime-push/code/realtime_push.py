SHORT, LONG, SSE, WS = "short", "long", "sse", "ws"
TIMEOUT = 6  # ticks a long poll is held before it comes back empty
HEARTBEAT = 5  # an idle stream or socket pings this often
RETRY = 1  # ticks a client waits before reconnecting


class PushChannel:
    """How new messages get from a server to a client, tick by tick."""

    def __init__(self, method=LONG, every=3):
        self.method = method
        self.every = every  # short polling interval, in ticks
        self.reset(method)

    def reset(self, method):
        """Forget everything and use this method."""
        self.method = method
        self.now = 0  # the clock, in ticks
        self.arrived = []  # tick message i + 1 reached the server
        self.plan = []  # ticks at which messages are due to arrive
        self.seen = 0  # highest message id the client has
        self.open = False  # held request, stream or socket
        self.since = 0  # last time the connection carried anything
        self.next_poll = 0
        self.requests = 0  # HTTP requests the client has made
        self.empty = 0  # responses that carried nothing
        self.delays = []  # ticks each message waited at the server
        self.received = 0  # client messages the server has
        self.wire = []  # (tick, "c" or "s", text): who sent what

    def names(self, ids):
        """m1, m2 and so on, for a response body."""
        return ", ".join(f"m{i}" for i in ids)

    def send(self, side, text):
        """Record one message on the wire."""
        self.wire.append((self.now, side, text))

    # region connect
    def connect(self):
        """Open the channel the way this method does."""
        self.open = True  #@open
        if self.method == SHORT:
            self.poll()  #@poll_now
            return
        self.requests += 1  #@request
        after = self.seen
        if self.method == LONG:
            self.send("c", f"GET /poll?after={after}")  #@long_open
        elif self.method == SSE:
            # On a reconnect the browser adds Last-Event-ID.
            self.send("c", f"GET /events, Last-Event-ID {after}")  #@sse_open
            self.send("s", "200 text/event-stream")  #@sse_open
        else:
            self.send("c", "GET, Upgrade: websocket")  #@ws_open
            self.send("s", "101 Switching Protocols")  #@ws_open
            if after:
                # WebSocket has no resume of its own: the app asks.
                self.send("c", f"resume after {after}")  #@resync
        self.since = self.now  #@opened
        self.push()  #@catch_up
    # endregion

    # region poll
    def poll(self):
        """Short polling: ask, and be answered at once."""
        self.requests += 1
        self.send("c", f"GET /poll?after={self.seen}")  #@ask
        new = self.newer()  #@check
        self.send("s", f"200 [{self.names(new)}]")  #@answer
        if not new:
            self.empty += 1  #@empty
        self.take(new)  #@got
        self.next_poll = self.now + self.every  #@schedule
    # endregion

    # region take
    def newer(self):
        """Ids of the messages the client does not have yet."""
        return list(range(self.seen + 1, len(self.arrived) + 1))  #@newer

    def take(self, ids):
        """Client: keep each message and note how long it waited."""
        for i in ids:
            self.delays.append(self.now - self.arrived[i - 1])  #@delay
            self.seen = i  #@seen
    # endregion

    # region push
    def push(self):
        """Server: hand new messages to an open connection."""
        if self.method == SHORT:
            return  # they wait for the next poll  #@wait_poll
        new = self.newer()
        if not new or not self.open:
            return  #@nothing
        if self.method == LONG:
            self.send("s", f"200 [{self.names(new)}]")  #@answer_held
            self.take(new)  #@answer_held
            self.open = False
            self.connect()  # the next poll goes out at once  #@repoll
            return
        for i in new:
            if self.method == SSE:
                self.send("s", f"id: {i}, data: m{i}")  #@sse_frame
            else:
                self.send("s", f"frame m{i}")  #@ws_frame
            self.take([i])  #@frame_taken
        self.since = self.now  #@pushed
    # endregion

    # region event
    def event(self):
        """A new message reaches the server."""
        self.arrived.append(self.now)  #@arrive
        self.push()  #@push
    # endregion

    # region tick
    def tick(self, ticks=1):
        """Advance the clock one tick at a time."""
        for _ in range(ticks):
            self.now += 1  #@clock
            while self.plan and self.plan[0] == self.now:
                self.plan.pop(0)
                self.event()  #@due
            if not self.open:
                continue
            idle = self.now - self.since
            if self.method == SHORT:
                if self.now >= self.next_poll:  #@poll_due
                    self.poll()  #@poll_due
            elif self.method == LONG:
                if idle >= TIMEOUT:  #@held_long
                    self.expire()  #@held_long
            elif idle >= HEARTBEAT:  #@idle
                self.heartbeat()  #@idle
    # endregion

    # region expire
    def expire(self):
        """A long poll held too long comes back empty."""
        self.send("s", "204 No Content")  #@expire
        self.empty += 1  #@expire
        self.open = False
        self.connect()  # and is reopened at once  #@reopen
    # endregion

    # region heartbeat
    def heartbeat(self):
        """Traffic on an idle connection, so proxies keep it."""
        if self.method == SSE:
            self.send("s", ": ping")  # a comment line  #@sse_ping
        else:
            self.send("s", "ping")  #@ws_ping
            self.send("c", "pong")  # the browser answers  #@ws_ping
        self.since = self.now  #@quiet
    # endregion

    # region wait_idle
    def wait_idle(self):
        """Let the connection sit idle until its limit acts."""
        if self.method == SHORT:
            return  # nothing is held open  #@short_idle
        limit = TIMEOUT if self.method == LONG else HEARTBEAT
        self.tick(self.since + limit - self.now)  #@wait
    # endregion

    # region client_send
    def client_send(self):
        """The client sends a message to the server."""
        if self.method == WS:
            self.send("c", f"frame c{self.received + 1}")  #@ws_send
            self.since = self.now  #@ws_send
        else:
            # Polling and SSE only carry data down: a new request.
            self.requests += 1  #@post
            self.send("c", f"POST /messages c{self.received + 1}")  #@post
            self.send("s", "201 Created")  #@created
        self.received += 1  #@received
    # endregion

    # region drop
    def drop(self, missed=1):
        """The connection breaks; messages arrive meanwhile."""
        self.open = False  #@broken
        for _ in range(missed):
            self.event()  #@missed
        self.now += RETRY  #@retry
        self.connect()  #@reconnect
    # endregion

    # region replay
    def replay(self, method, plan=(2, 7), ticks=9):
        """Start again under a method and play a fixed script."""
        self.reset(method)  #@reset
        self.plan = list(plan)  #@reset
        self.connect()  #@start
        self.tick(ticks)  #@play
    # endregion
