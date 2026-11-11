NONE, IMMEDIATE, FIXED, EXPONENTIAL, JITTER = range(5)
HEALTHY, FAILING, SLOW, RECOVERING = "healthy", "failing", "slow", "recovering"
CLOSED, OPEN, HALF_OPEN = "closed", "open", "half-open"
OK, UNAVAILABLE, TIMEOUT, FAST = "ok", "503", "timeout", "fast"
OUTCOME = {HEALTHY: OK, FAILING: UNAVAILABLE, SLOW: TIMEOUT}
RETRYABLE = {UNAVAILABLE, TIMEOUT, "429"}  # never 400, 404, 422

MAX_ATTEMPTS = 4  # the first call and up to 3 retries
BASE, CAP, FIXED_DELAY = 2, 6, 2  # in ticks
THRESHOLD, WINDOW, OPEN_FOR = 3, 10, 4  # failures, ticks, ticks
CAPACITY, CALM_TICKS = 2, 5  # while recovering
DOWN_FOR = 3  # ticks a storm keeps the downstream failing
EARN, COST, BUDGET_CAP = 2, 10, 20  # retry tokens, in tenths


class Rng:
    """Mulberry32: small, seeded, the same in every language."""

    def __init__(self, seed):
        self.a = seed & 0xFFFFFFFF

    def next(self):
        m = 0xFFFFFFFF
        self.a = (self.a + 0x6D2B79F5) & m
        t = self.a
        t = ((t ^ (t >> 15)) * (t | 1)) & m
        t ^= (t + ((t ^ (t >> 7)) * (t | 61))) & m
        return ((t ^ (t >> 14)) & m) / 4294967296


class Downstream:
    """The service every client calls."""

    def __init__(self):
        self.health = HEALTHY
        self.calm = 0  # ticks in a row within capacity
        self.load = {}  # tick -> requests received

    # region downstream
    def handle(self, now):
        """Answer one request that arrives at tick now."""
        self.load[now] = self.load.get(now, 0) + 1  #@arrive
        if self.health == RECOVERING:
            if self.load[now] <= CAPACITY:  #@capacity
                return OK
            return UNAVAILABLE  #@shed
        return OUTCOME[self.health]  #@outcome

    def set_health(self, health):
        self.health = health  #@health
        self.calm = 0

    def end_tick(self, now):
        """A recovering service heals after enough calm ticks."""
        if self.health != RECOVERING:
            return
        if self.load.get(now, 0) <= CAPACITY:
            self.calm += 1  #@calm
        else:
            self.calm = 0  #@overload
        if self.calm >= CALM_TICKS:
            self.set_health(HEALTHY)  #@healed
    # endregion


class Breaker:
    """Closed, open or half-open, one per client."""

    def __init__(self, enabled=True):
        self.enabled = enabled
        self.state = CLOSED
        self.failures = []  # ticks of recent failures
        self.open_until = 0

    # region breaker
    def allow(self, now):
        """May a request go out? One probe at a time when half-open."""
        return not self.enabled or self.state != OPEN

    def on_success(self):
        if self.enabled and self.state == HALF_OPEN:
            self.state = CLOSED  #@close
            self.failures.clear()  #@close

    def on_failure(self, now):
        if not self.enabled:
            return
        if self.state == HALF_OPEN:
            self.trip(now)  #@reopen
            return
        self.failures.append(now)  #@count
        while self.failures[0] <= now - WINDOW:
            self.failures.pop(0)  # only the last WINDOW ticks count
        if len(self.failures) >= THRESHOLD:  #@threshold
            self.trip(now)  #@trip

    def trip(self, now):
        self.state = OPEN  #@trip,reopen
        self.open_until = now + OPEN_FOR  #@trip,reopen
        self.failures.clear()

    def tick(self, now):
        if self.state == OPEN and now >= self.open_until:  #@wait
            self.state = HALF_OPEN  #@half_open
    # endregion


class RetryBudget:
    """A token bucket for retries: each call earns a fifth of one."""

    def __init__(self):
        self.tenths = BUDGET_CAP

    # region budget_bucket
    def deposit(self):
        self.tenths = min(BUDGET_CAP, self.tenths + EARN)  #@earn

    def spend(self):
        if self.tenths < COST:  #@budget
            return False  #@no_budget
        self.tenths -= COST  #@spend
        return True
    # endregion


class Chain:
    """One call and its retries."""

    def __init__(self, now, policy, deadline, guarded):
        self.attempt = 0
        self.due = now
        self.policy = policy
        self.deadline = deadline  # a tick, or None
        self.guarded = guarded  # False: skip the breaker


class Client:
    """A caller with a retry policy, a breaker and maybe a budget."""

    def __init__(self, name, downstream, rng, policy, breaker_on):
        self.name = name
        self.downstream = downstream
        self.rng = rng
        self.policy = policy
        self.breaker = Breaker(breaker_on)
        self.budget = None
        self.deadline = None  # ticks a call may take, or None
        self.chain = None
        self.log = []  # (tick, attempt, result)

    # region call
    def call(self, now, policy=None, guarded=True):
        """Start a call. Its first attempt goes out now."""
        if self.chain is not None:
            return False  #@busy
        if policy is None:
            policy = self.policy
        limit = None if self.deadline is None else now + self.deadline
        self.chain = Chain(now, policy, limit, guarded)  #@call
        if self.budget is not None:
            self.budget.deposit()  #@deposit
        self.attempt(now)
        return True
    # endregion

    # region attempt
    def attempt(self, now):
        """Send one attempt, or fail fast."""
        chain = self.chain
        chain.attempt += 1
        chain.due = None
        if chain.guarded and not self.breaker.allow(now):  #@allow
            self.log.append((now, chain.attempt, FAST))  #@fast
            self.chain = None  #@fast
            return FAST
        result = self.downstream.handle(now)  #@send
        self.log.append((now, chain.attempt, result))
        if result == OK:  #@result
            if chain.guarded:
                self.breaker.on_success()  #@ok
            self.chain = None  #@ok
            return OK
        if chain.guarded:
            self.breaker.on_failure(now)  #@failed
        self.plan_retry(now, result)  #@plan
        return result
    # endregion

    # region retry
    def plan_retry(self, now, error):
        """Schedule the next attempt, or give up."""
        chain = self.chain
        if (error not in RETRYABLE or chain.policy == NONE
                or chain.attempt >= MAX_ATTEMPTS):  #@give_up_check
            self.chain = None  #@give_up
            return
        delay = self.backoff(chain.attempt - 1, chain.policy)  #@delay
        if chain.deadline is not None and now + delay > chain.deadline:  #@deadline
            self.chain = None  #@cut
            return
        if self.budget is not None and not self.budget.spend():  #@budget
            self.chain = None  #@no_budget
            return
        chain.due = now + delay  #@schedule
    # endregion

    # region backoff
    def backoff(self, n, policy):
        """Ticks to wait before retry n + 1."""
        if policy == IMMEDIATE:
            return 1  #@immediate
        if policy == FIXED:
            return FIXED_DELAY  #@fixed
        delay = min(CAP, BASE * 2 ** n)  #@exp
        if policy == JITTER:
            # Full jitter, in whole ticks from 1 to delay.
            delay = 1 + int(self.rng.next() * delay)  #@jitter
        return delay  #@exp,jitter
    # endregion


class System:
    """Four clients, one downstream and a clock."""

    def __init__(self, policy=JITTER, breaker_on=True, seed=1):
        self.now = 0
        self.downstream = Downstream()
        self.rng = Rng(seed)
        self.breaker_on = breaker_on
        self.clients = [
            Client(n, self.downstream, self.rng, policy, breaker_on)
            for n in "ABCD"
        ]

    # region tick
    def tick(self):
        """Advance the clock one tick and fire what is due."""
        self.advance()
        self.fire_due()

    def advance(self):
        self.downstream.end_tick(self.now)  #@end_tick
        self.now += 1  #@clock
        for c in self.clients:
            c.breaker.tick(self.now)  #@breakers

    def fire_due(self):
        for c in self.clients:
            if c.chain is not None and c.chain.due == self.now:  #@due
                c.attempt(self.now)  #@fire
    # endregion

    # region storm
    def storm(self, policy):
        """Every client calls at the tick the downstream fails."""
        for c in self.clients:
            c.chain = None  #@storm_drop
        self.tick()  #@storm_drop
        start = self.now
        self.downstream.set_health(FAILING)  #@storm_fail
        for c in self.clients:
            c.call(self.now, policy, guarded=False)  #@storm_call
        while any(c.chain is not None for c in self.clients):  #@storm_loop
            self.advance()  #@storm_tick
            if self.now == start + DOWN_FOR:
                self.downstream.set_health(RECOVERING)  #@storm_recover
            self.fire_due()  #@storm_fire
    # endregion

    # region trip
    def trip(self, client):
        """Drive one breaker round its states."""
        b = client.breaker
        if not b.enabled:
            return  #@no_breaker
        self.tick()  #@trip_tick
        calm = self.downstream.health in (HEALTHY, RECOVERING)
        if b.state == CLOSED and calm:
            self.downstream.set_health(FAILING)  #@trip_fail
        while b.state == CLOSED:  #@trip_loop
            client.call(self.now, NONE)  #@trip_call
            if b.state == CLOSED:
                self.tick()  #@trip_tick
        self.tick()  #@trip_tick
        if b.state == OPEN:
            client.call(self.now, NONE)  #@trip_fast
            while b.state == OPEN:  #@trip_wait
                self.tick()  #@trip_tick
        client.call(self.now, NONE)  #@trip_probe
    # endregion

    # region budget
    def use_budget(self, client, deadline):
        """Deadlines and retry budgets for every call."""
        for c in self.clients:
            c.deadline = deadline or None  #@budget_on
            c.budget = RetryBudget() if deadline else None  #@budget_on
        if not deadline:
            return  #@budget_off
        if self.downstream.health in (HEALTHY, RECOVERING):
            self.downstream.set_health(SLOW)  #@budget_slow
        client.call(self.now)  #@budget_call
        while client.chain is not None:  #@budget_wait
            self.tick()  #@budget_wait
    # endregion

    # region reset
    def reset(self, seed=1):
        policy = self.clients[0].policy
        self.__init__(policy, self.breaker_on, seed)  #@reset
    # endregion
