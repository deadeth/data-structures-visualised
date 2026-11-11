SLOW = 5  # a slow server takes five times as long
FALL = 2  # failed health checks before a server is taken out
RISE = 2  # passed health checks before it is put back
MISSED = 3  # missed heartbeats before the standby takes over
CACHE = 3  # sessions each server keeps

RR = "round robin"
WRR = "weighted round robin"
LEAST = "least connections"
TWO = "power of two choices"
HASH = "hash by user"


class Request:
    def __init__(self, rid, user, work):
        self.rid = rid
        self.user = user  # None for an anonymous request
        self.work = work  # ticks of work on a healthy server
        self.end = 0  # the tick at which it is done


class Server:
    def __init__(self, name, weight=1):
        self.name = name
        self.weight = weight
        self.open = []  # requests in flight, oldest first
        self.healthy = True  # what the balancer believes
        self.answering = True  # what is really true
        self.slow = False
        self.misses = 0
        self.passes = 0
        self.score = 0  # for weighted round robin
        self.sessions = []  # cached users, least recent first
        self.served = 0


def user_hash(user):
    """Small enough to work out by hand: a=1 ... z=26, summed."""
    return sum(ord(c) - 96 for c in user)


class LoadBalancer:
    """A balancer in front of a few servers, with a standby."""

    def __init__(self, names, weights, policy=RR):
        self.servers = [Server(n, w) for n, w in zip(names, weights)]
        self.policy = policy
        self.next = 0  # round robin: index of the next server
        self.now = 0  # the clock, in ticks
        self.seq = 0  # last request id
        self.seed = 1  # for power of two choices
        self.active, self.standby = "LB 1", "LB 2"
        self.missed = 0

    def find(self, name):
        return next(s for s in self.servers if s.name == name)

    # region request
    def request(self, user=None, work=2):  #@arrive
        """One tick passes, then a new request is routed."""
        self.tick()  #@tick
        self.seq += 1
        return self.route(Request(self.seq, user, work))  #@arrive

    def route(self, req):
        server = self.pick(req.user)  #@pick
        if server is None:
            # the client gets 503 Service Unavailable
            return None  #@unavailable
        took = req.work * (SLOW if server.slow else 1)
        req.end = self.now + took  #@assign
        server.open.append(req)  #@assign
        server.served += 1  #@assign
        self.touch(server, req.user)  #@session
        return server
    # endregion

    # region pick
    def pick(self, user):
        """Choose a healthy server by the policy."""
        if not any(s.healthy for s in self.servers):
            return None  #@none_up
        if self.policy == HASH and user is not None:
            return self.by_user(user)  #@use_hash
        if self.policy == LEAST:
            return self.least_conn()  #@use_lc
        if self.policy == TWO:
            return self.two_choices()  #@use_p2
        if self.policy == WRR:
            return self.weighted()  #@use_wrr
        # round robin, and hash by user with no user
        return self.round_robin()  #@use_rr
    # endregion

    # region round_robin
    def round_robin(self):
        """Take servers in turn, skipping unhealthy ones."""
        n = len(self.servers)
        while True:
            s = self.servers[self.next]  #@rr_next
            self.next = (self.next + 1) % n  #@rr_next
            if s.healthy:  #@rr_check
                return s  #@rr_check
    # endregion

    # region weighted
    def weighted(self):
        """Smooth weighted round robin, as NGINX does it."""
        live = [s for s in self.servers if s.healthy]
        for s in live:
            s.score += s.weight  #@wrr_add
        best = live[0]
        for s in live[1:]:
            if s.score > best.score:  #@wrr_best
                best = s  #@wrr_best
        best.score -= sum(s.weight for s in live)  #@wrr_take
        return best  #@wrr_take
    # endregion

    # region least_conn
    def least_conn(self):
        """Fewest open connections; a tie goes to the first."""
        live = [s for s in self.servers if s.healthy]
        best = live[0]  #@lc_start
        for s in live[1:]:
            if len(s.open) < len(best.open):  #@lc_compare
                best = s  #@lc_compare
        return best  #@lc_pick
    # endregion

    # region two_choices
    def two_choices(self):
        """Sample two servers, keep the one with fewer open."""
        live = [s for s in self.servers if s.healthy]
        if len(live) == 1:
            return live[0]  #@p2_only
        i = self.rand(len(live))  #@p2_sample
        j = self.rand(len(live) - 1)  #@p2_sample
        if j >= i:
            j += 1  #@p2_sample
        a, b = live[i], live[j]
        if len(b.open) < len(a.open):  #@p2_compare
            return b  #@p2_compare
        return a  #@p2_compare

    def rand(self, n):
        """A tiny generator, so a run can be repeated."""
        self.seed = (self.seed * 75 + 74) % 65537
        return self.seed % n
    # endregion

    # region by_user
    def by_user(self, user):
        """Same user, same server: hash mod n."""
        n = len(self.servers)
        i = user_hash(user) % n  #@hash
        while not self.servers[i].healthy:  #@hash_check
            i = (i + 1) % n  #@hash_spill
        return self.servers[i]  #@hash_check
    # endregion

    # region session
    def touch(self, server, user):
        """Use the user's cached session, or load and cache it."""
        if user is None:
            return None
        if user in server.sessions:  #@session_check
            server.sessions.remove(user)  #@session_hit
            server.sessions.append(user)  #@session_hit
            return True  #@session_hit
        server.sessions.append(user)  #@session_miss
        if len(server.sessions) > CACHE:
            server.sessions.pop(0)  #@session_evict
        return False  #@session_miss
    # endregion

    # region tick
    def tick(self):
        """One tick passes; requests that are done close."""
        self.now += 1  #@tick
        for s in self.servers:
            s.open = [r for r in s.open if r.end > self.now]  #@done
    # endregion

    # region burst
    def burst(self, count, users=(None,), work=2):
        """Send count requests, one per tick."""
        for k in range(count):
            self.request(users[k % len(users)], work)  #@send
        return [len(s.open) for s in self.servers]  #@sent
    # endregion

    # region finish
    def finish(self, name):
        """Complete the oldest request on a server now."""
        s = self.find(name)
        if not s.open:
            return None  #@idle
        return s.open.pop(0)  #@finish
    # endregion

    # region slow
    def make_slow(self, name):
        """It still answers health checks, five times slower."""
        s = self.find(name)
        if s.slow:
            return  #@already
        s.slow = True  #@slow
        for r in s.open:
            r.end = self.now + (r.end - self.now) * SLOW  #@stretch
    # endregion

    # region health_check
    def health_check(self, s):
        """Probe one server; count misses or passes."""
        if not s.answering:  #@probe
            s.passes = 0
            s.misses += 1  #@miss
            if s.healthy and s.misses >= FALL:  #@fall
                s.healthy = False  #@down
        else:
            s.misses = 0
            s.passes += 1  #@pass
            if not s.healthy and s.passes >= RISE:  #@rise
                s.healthy = True  #@up
    # endregion

    # region fail
    def fail(self, name):
        """The server stops answering. Health checks find out."""
        s = self.find(name)
        if not s.answering:
            return 0  #@already
        s.answering = False  #@stop
        while s.healthy:
            self.health_check(s)  #@check
        lost, s.open = s.open, []  #@lost
        s.sessions = []  #@lost
        for req in lost:
            self.route(req)  #@retry
        return len(lost)  #@retried
    # endregion

    # region recover
    def recover(self, name):
        """The server answers again; checks bring it back."""
        s = self.find(name)
        s.answering = True  #@answer
        s.slow = False  #@answer
        while not s.healthy:
            self.health_check(s)  #@check
    # endregion

    # region scale
    def scale(self, name, weight=1):
        """Add a server. Under hash mod n, users move."""
        self.servers.append(Server(name, weight))  #@add
        if self.policy != HASH:
            return 0  #@no_pin
        lost = 0
        for s in self.servers:
            for user in list(s.sessions):
                if self.by_user(user) is not s:  #@moved
                    s.sessions.remove(user)  #@lose
                    lost += 1
        return lost  #@scaled
    # endregion

    # region use
    def use(self, policy):
        """Switch policy. Requests in flight stay put."""
        self.policy = policy  #@policy
        for s in self.servers:
            s.score = 0  #@policy
    # endregion

    # region fail_lb
    def heard(self, ok):
        """Standby side, once per heartbeat interval."""
        if ok:
            self.missed = 0
            return False
        self.missed += 1  #@missed
        return self.missed >= MISSED  #@missed

    def fail_lb(self):
        """The active balancer dies; the standby takes over."""
        while not self.heard(False):  #@heartbeat
            pass
        # it claims the virtual IP with a gratuitous ARP
        self.active, self.standby = self.standby, self.active  #@takeover
        lost = [r for s in self.servers for r in s.open]  #@cut
        for s in self.servers:
            s.open = []  #@cut
        for req in sorted(lost, key=lambda r: r.rid):
            self.route(req)  #@retry
        self.missed = 0
        return len(lost)  #@retried
    # endregion
