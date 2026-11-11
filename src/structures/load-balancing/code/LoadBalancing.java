import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** A balancer in front of a few servers, with a standby. */
public class LoadBalancing {
    static final int SLOW = 5; // a slow server takes five times as long
    static final int FALL = 2; // failed checks before a server is taken out
    static final int RISE = 2; // passed checks before it is put back
    static final int MISSED = 3; // missed heartbeats before a takeover
    static final int CACHE = 3; // sessions each server keeps

    enum Policy { RR, WRR, LEAST, TWO, HASH }

    static final class Request {
        final int rid;
        final String user; // null for an anonymous request
        final int work; // ticks of work on a healthy server
        long end; // the tick at which it is done

        Request(int rid, String user, int work) {
            this.rid = rid;
            this.user = user;
            this.work = work;
        }
    }

    static final class Server {
        final String name;
        final int weight;
        List<Request> open = new ArrayList<>(); // oldest first
        boolean healthy = true; // what the balancer believes
        boolean answering = true; // what is really true
        boolean slow;
        int misses;
        int passes;
        int score; // for weighted round robin
        List<String> sessions = new ArrayList<>(); // least recent first
        int served;

        Server(String name, int weight) {
            this.name = name;
            this.weight = weight;
        }
    }

    /** Small enough to work out by hand: a=1 ... z=26, summed. */
    static int userHash(String user) {
        int h = 0;
        for (char c : user.toCharArray()) {
            h += c - 'a' + 1;
        }
        return h;
    }

    final List<Server> servers = new ArrayList<>();
    Policy policy;
    int next; // round robin: index of the next server
    long now; // the clock, in ticks
    int seq; // last request id
    int seed = 1; // for power of two choices
    String active = "LB 1";
    String standby = "LB 2";
    int missed;

    public LoadBalancing(String[] names, int[] weights, Policy policy) {
        for (int i = 0; i < names.length; i++) {
            servers.add(new Server(names[i], weights[i]));
        }
        this.policy = policy;
    }

    Server find(String name) {
        for (Server s : servers) {
            if (s.name.equals(name)) {
                return s;
            }
        }
        throw new IllegalArgumentException(name);
    }

    // region request
    /** One tick passes, then a new request is routed. */
    public Server request(String user, int work) { //@arrive
        tick(); //@tick
        seq++;
        return route(new Request(seq, user, work)); //@arrive
    }

    Server route(Request req) {
        Server server = pick(req.user); //@pick
        if (server == null) {
            // the client gets 503 Service Unavailable
            return null; //@unavailable
        }
        int took = req.work * (server.slow ? SLOW : 1);
        req.end = now + took; //@assign
        server.open.add(req); //@assign
        server.served++; //@assign
        touch(server, req.user); //@session
        return server;
    }
    // endregion

    // region pick
    /** Chooses a healthy server by the policy. */
    Server pick(String user) {
        if (servers.stream().noneMatch(s -> s.healthy)) {
            return null; //@none_up
        }
        if (policy == Policy.HASH && user != null) {
            return byUser(user); //@use_hash
        }
        if (policy == Policy.LEAST) {
            return leastConn(); //@use_lc
        }
        if (policy == Policy.TWO) {
            return twoChoices(); //@use_p2
        }
        if (policy == Policy.WRR) {
            return weighted(); //@use_wrr
        }
        // round robin, and hash by user with no user
        return roundRobin(); //@use_rr
    }
    // endregion

    List<Server> live() {
        List<Server> out = new ArrayList<>();
        for (Server s : servers) {
            if (s.healthy) {
                out.add(s);
            }
        }
        return out;
    }

    // region round_robin
    /** Takes servers in turn, skipping unhealthy ones. */
    Server roundRobin() {
        int n = servers.size();
        while (true) {
            Server s = servers.get(next); //@rr_next
            next = (next + 1) % n; //@rr_next
            if (s.healthy) { //@rr_check
                return s; //@rr_check
            }
        }
    }
    // endregion

    // region weighted
    /** Smooth weighted round robin, as NGINX does it. */
    Server weighted() {
        List<Server> live = live();
        int total = 0;
        for (Server s : live) {
            s.score += s.weight; //@wrr_add
            total += s.weight; //@wrr_add
        }
        Server best = live.get(0);
        for (Server s : live.subList(1, live.size())) {
            if (s.score > best.score) { //@wrr_best
                best = s; //@wrr_best
            }
        }
        best.score -= total; //@wrr_take
        return best; //@wrr_take
    }
    // endregion

    // region least_conn
    /** Fewest open connections; a tie goes to the first. */
    Server leastConn() {
        List<Server> live = live();
        Server best = live.get(0); //@lc_start
        for (Server s : live.subList(1, live.size())) {
            if (s.open.size() < best.open.size()) { //@lc_compare
                best = s; //@lc_compare
            }
        }
        return best; //@lc_pick
    }
    // endregion

    // region two_choices
    /** Samples two servers, keeps the one with fewer open. */
    Server twoChoices() {
        List<Server> live = live();
        if (live.size() == 1) {
            return live.get(0); //@p2_only
        }
        int i = rand(live.size()); //@p2_sample
        int j = rand(live.size() - 1); //@p2_sample
        if (j >= i) {
            j++; //@p2_sample
        }
        Server a = live.get(i);
        Server b = live.get(j);
        if (b.open.size() < a.open.size()) { //@p2_compare
            return b; //@p2_compare
        }
        return a; //@p2_compare
    }

    /** A tiny generator, so a run can be repeated. */
    int rand(int n) {
        seed = (seed * 75 + 74) % 65537;
        return seed % n;
    }
    // endregion

    // region by_user
    /** Same user, same server: hash mod n. */
    Server byUser(String user) {
        int n = servers.size();
        int i = userHash(user) % n; //@hash
        while (!servers.get(i).healthy) { //@hash_check
            i = (i + 1) % n; //@hash_spill
        }
        return servers.get(i); //@hash_check
    }
    // endregion

    // region session
    /** Uses the user's cached session, or loads and caches it. */
    Boolean touch(Server server, String user) {
        if (user == null) {
            return null;
        }
        if (server.sessions.contains(user)) { //@session_check
            server.sessions.remove(user); //@session_hit
            server.sessions.add(user); //@session_hit
            return true; //@session_hit
        }
        server.sessions.add(user); //@session_miss
        if (server.sessions.size() > CACHE) {
            server.sessions.remove(0); //@session_evict
        }
        return false; //@session_miss
    }
    // endregion

    // region tick
    /** One tick passes; requests that are done close. */
    void tick() {
        now++; //@tick
        for (Server s : servers) {
            s.open.removeIf(r -> r.end <= now); //@done
        }
    }
    // endregion

    // region burst
    /** Sends count requests, one per tick. */
    public int[] burst(int count, String[] users, int work) {
        for (int k = 0; k < count; k++) {
            request(users[k % users.length], work); //@send
        }
        return servers.stream().mapToInt(s -> s.open.size()).toArray(); //@sent
    }
    // endregion

    // region finish
    /** Completes the oldest request on a server now. */
    public Request finish(String name) {
        Server s = find(name);
        if (s.open.isEmpty()) {
            return null; //@idle
        }
        return s.open.remove(0); //@finish
    }
    // endregion

    // region slow
    /** It still answers health checks, five times slower. */
    public void makeSlow(String name) {
        Server s = find(name);
        if (s.slow) {
            return; //@already
        }
        s.slow = true; //@slow
        for (Request r : s.open) {
            r.end = now + (r.end - now) * SLOW; //@stretch
        }
    }
    // endregion

    // region health_check
    /** Probes one server; counts misses or passes. */
    void healthCheck(Server s) {
        if (!s.answering) { //@probe
            s.passes = 0;
            s.misses++; //@miss
            if (s.healthy && s.misses >= FALL) { //@fall
                s.healthy = false; //@down
            }
        } else {
            s.misses = 0;
            s.passes++; //@pass
            if (!s.healthy && s.passes >= RISE) { //@rise
                s.healthy = true; //@up
            }
        }
    }
    // endregion

    // region fail
    /** The server stops answering. Health checks find out. */
    public int fail(String name) {
        Server s = find(name);
        if (!s.answering) {
            return 0; //@already
        }
        s.answering = false; //@stop
        while (s.healthy) {
            healthCheck(s); //@check
        }
        List<Request> lost = s.open; //@lost
        s.open = new ArrayList<>(); //@lost
        s.sessions = new ArrayList<>(); //@lost
        for (Request req : lost) {
            route(req); //@retry
        }
        return lost.size(); //@retried
    }
    // endregion

    // region recover
    /** The server answers again; checks bring it back. */
    public void recover(String name) {
        Server s = find(name);
        s.answering = true; //@answer
        s.slow = false; //@answer
        while (!s.healthy) {
            healthCheck(s); //@check
        }
    }
    // endregion

    // region scale
    /** Adds a server. Under hash mod n, users move. */
    public int scale(String name, int weight) {
        servers.add(new Server(name, weight)); //@add
        if (policy != Policy.HASH) {
            return 0; //@no_pin
        }
        int lost = 0;
        for (Server s : servers) {
            for (String user : List.copyOf(s.sessions)) {
                if (byUser(user) != s) { //@moved
                    s.sessions.remove(user); //@lose
                    lost++;
                }
            }
        }
        return lost; //@scaled
    }
    // endregion

    // region use
    /** Switches policy. Requests in flight stay put. */
    public void use(Policy p) {
        policy = p; //@policy
        for (Server s : servers) {
            s.score = 0; //@policy
        }
    }
    // endregion

    // region fail_lb
    /** Standby side, once per heartbeat interval. */
    boolean heard(boolean ok) {
        if (ok) {
            missed = 0;
            return false;
        }
        missed++; //@missed
        return missed >= MISSED; //@missed
    }

    /** The active balancer dies; the standby takes over. */
    public int failLb() {
        while (!heard(false)) { //@heartbeat
        }
        // it claims the virtual IP with a gratuitous ARP
        String was = active; //@takeover
        active = standby; //@takeover
        standby = was; //@takeover
        List<Request> lost = new ArrayList<>(); //@cut
        for (Server s : servers) {
            lost.addAll(s.open); //@cut
            s.open = new ArrayList<>(); //@cut
        }
        lost.sort(Comparator.comparingInt(r -> r.rid));
        for (Request req : lost) {
            route(req); //@retry
        }
        missed = 0;
        return lost.size(); //@retried
    }
    // endregion
}
