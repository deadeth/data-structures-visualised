import java.util.ArrayList;
import java.util.List;
import java.util.StringJoiner;

/** How new messages get from a server to a client, tick by tick. */
public class RealtimePush {
    public enum Method { SHORT, LONG, SSE, WS }

    /** One message on the wire: who sent it, and when. */
    public record Wire(int tick, char side, String text) {}

    static final int TIMEOUT = 6; // ticks a long poll is held
    static final int HEARTBEAT = 5; // an idle connection pings this often
    static final int RETRY = 1; // ticks before reconnecting

    Method method;
    int every; // short polling interval, in ticks
    int now; // the clock, in ticks
    List<Integer> arrived; // tick message i + 1 reached the server
    List<Integer> plan; // ticks at which messages are due
    int seen; // highest message id the client has
    boolean open; // held request, stream or socket
    int since; // last time the connection carried anything
    int nextPoll;
    int requests; // HTTP requests the client has made
    int empty; // responses that carried nothing
    List<Integer> delays; // ticks each message waited
    int received; // client messages the server has
    List<Wire> wire;

    public RealtimePush(Method method, int every) {
        this.every = every;
        reset(method);
    }

    /** Forgets everything and uses this method. */
    void reset(Method method) {
        this.method = method;
        now = 0;
        arrived = new ArrayList<>();
        plan = new ArrayList<>();
        seen = 0;
        open = false;
        since = 0;
        nextPoll = 0;
        requests = 0;
        empty = 0;
        delays = new ArrayList<>();
        received = 0;
        wire = new ArrayList<>();
    }

    /** m1, m2 and so on, for a response body. */
    static String names(List<Integer> ids) {
        StringJoiner j = new StringJoiner(", ");
        for (int i : ids) {
            j.add("m" + i);
        }
        return j.toString();
    }

    void send(char side, String text) {
        wire.add(new Wire(now, side, text));
    }

    // region connect
    /** Opens the channel the way this method does. */
    public void connect() {
        open = true; //@open
        if (method == Method.SHORT) {
            poll(); //@poll_now
            return;
        }
        requests++; //@request
        int after = seen;
        if (method == Method.LONG) {
            send('c', "GET /poll?after=" + after); //@long_open
        } else if (method == Method.SSE) {
            // On a reconnect the browser adds Last-Event-ID.
            send('c', "GET /events, Last-Event-ID " + after); //@sse_open
            send('s', "200 text/event-stream"); //@sse_open
        } else {
            send('c', "GET, Upgrade: websocket"); //@ws_open
            send('s', "101 Switching Protocols"); //@ws_open
            if (after > 0) {
                // WebSocket has no resume of its own: the app asks.
                send('c', "resume after " + after); //@resync
            }
        }
        since = now; //@opened
        push(); //@catch_up
    }
    // endregion

    // region poll
    /** Short polling: asks, and is answered at once. */
    void poll() {
        requests++;
        send('c', "GET /poll?after=" + seen); //@ask
        List<Integer> fresh = newer(); //@check
        send('s', "200 [" + names(fresh) + "]"); //@answer
        if (fresh.isEmpty()) {
            empty++; //@empty
        }
        take(fresh); //@got
        nextPoll = now + every; //@schedule
    }
    // endregion

    // region take
    /** Ids of the messages the client does not have yet. */
    List<Integer> newer() {
        List<Integer> ids = new ArrayList<>();
        for (int i = seen + 1; i <= arrived.size(); i++) {
            ids.add(i); //@newer
        }
        return ids;
    }

    /** Client: keeps each message and notes how long it waited. */
    void take(List<Integer> ids) {
        for (int i : ids) {
            delays.add(now - arrived.get(i - 1)); //@delay
            seen = i; //@seen
        }
    }
    // endregion

    // region push
    /** Server: hands new messages to an open connection. */
    void push() {
        if (method == Method.SHORT) {
            return; // they wait for the next poll //@wait_poll
        }
        List<Integer> fresh = newer();
        if (fresh.isEmpty() || !open) {
            return; //@nothing
        }
        if (method == Method.LONG) {
            send('s', "200 [" + names(fresh) + "]"); //@answer_held
            take(fresh); //@answer_held
            open = false;
            connect(); // the next poll goes out at once //@repoll
            return;
        }
        for (int i : fresh) {
            if (method == Method.SSE) {
                send('s', "id: " + i + ", data: m" + i); //@sse_frame
            } else {
                send('s', "frame m" + i); //@ws_frame
            }
            take(List.of(i)); //@frame_taken
        }
        since = now; //@pushed
    }
    // endregion

    // region event
    /** A new message reaches the server. */
    public void event() {
        arrived.add(now); //@arrive
        push(); //@push
    }
    // endregion

    // region tick
    /** Advances the clock one tick at a time. */
    public void tick(int ticks) {
        for (int k = 0; k < ticks; k++) {
            now++; //@clock
            while (!plan.isEmpty() && plan.get(0) == now) {
                plan.remove(0);
                event(); //@due
            }
            if (!open) {
                continue;
            }
            int idle = now - since;
            if (method == Method.SHORT) {
                if (now >= nextPoll) { //@poll_due
                    poll(); //@poll_due
                }
            } else if (method == Method.LONG) {
                if (idle >= TIMEOUT) { //@held_long
                    expire(); //@held_long
                }
            } else if (idle >= HEARTBEAT) { //@idle
                heartbeat(); //@idle
            }
        }
    }
    // endregion

    // region expire
    /** A long poll held too long comes back empty. */
    void expire() {
        send('s', "204 No Content"); //@expire
        empty++; //@expire
        open = false;
        connect(); // and is reopened at once //@reopen
    }
    // endregion

    // region heartbeat
    /** Traffic on an idle connection, so proxies keep it. */
    void heartbeat() {
        if (method == Method.SSE) {
            send('s', ": ping"); // a comment line //@sse_ping
        } else {
            send('s', "ping"); //@ws_ping
            send('c', "pong"); // the browser answers //@ws_ping
        }
        since = now; //@quiet
    }
    // endregion

    // region wait_idle
    /** Lets the connection sit idle until its limit acts. */
    public void waitIdle() {
        if (method == Method.SHORT) {
            return; // nothing is held open //@short_idle
        }
        int limit = method == Method.LONG ? TIMEOUT : HEARTBEAT;
        tick(since + limit - now); //@wait
    }
    // endregion

    // region client_send
    /** The client sends a message to the server. */
    public void clientSend() {
        if (method == Method.WS) {
            send('c', "frame c" + (received + 1)); //@ws_send
            since = now; //@ws_send
        } else {
            // Polling and SSE only carry data down: a new request.
            requests++; //@post
            send('c', "POST /messages c" + (received + 1)); //@post
            send('s', "201 Created"); //@created
        }
        received++; //@received
    }
    // endregion

    // region drop
    /** The connection breaks; messages arrive meanwhile. */
    public void drop(int missed) {
        open = false; //@broken
        for (int k = 0; k < missed; k++) {
            event(); //@missed
        }
        now += RETRY; //@retry
        connect(); //@reconnect
    }
    // endregion

    // region replay
    /** Starts again under a method and plays a fixed script. */
    public void replay(Method m) {
        reset(m); //@reset
        plan = new ArrayList<>(List.of(2, 7)); //@reset
        connect(); //@start
        tick(9); //@play
    }
    // endregion
}
