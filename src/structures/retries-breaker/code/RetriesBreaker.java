import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Four clients, one downstream and a clock. */
public class RetriesBreaker {
    public static final int NONE = 0, IMMEDIATE = 1, FIXED = 2,
            EXPONENTIAL = 3, JITTER = 4;
    public enum Health { HEALTHY, FAILING, SLOW, RECOVERING }
    public enum State { CLOSED, OPEN, HALF_OPEN }
    public static final String OK = "ok", UNAVAILABLE = "503",
            TIMEOUT = "timeout", FAST = "fast";
    // Never 400, 404 or 422: the same request would fail again.
    static final Set<String> RETRYABLE = Set.of(UNAVAILABLE, TIMEOUT, "429");

    static final int MAX_ATTEMPTS = 4; // the first call and 3 retries
    static final int BASE = 2, CAP = 6, FIXED_DELAY = 2; // ticks
    static final int THRESHOLD = 3, WINDOW = 10, OPEN_FOR = 4;
    static final int CAPACITY = 2, CALM_TICKS = 5; // while recovering
    static final int DOWN_FOR = 3; // ticks a storm keeps it failing
    static final int EARN = 2, COST = 10, BUDGET_CAP = 20; // tenths

    /** Mulberry32: small, seeded, the same in every language. */
    static final class Rng {
        private int a;

        Rng(int seed) {
            a = seed;
        }

        double next() {
            a += 0x6D2B79F5;
            int t = a;
            t = (t ^ (t >>> 15)) * (t | 1);
            t ^= t + (t ^ (t >>> 7)) * (t | 61);
            return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
        }
    }

    /** The service every client calls. */
    static final class Downstream {
        Health health = Health.HEALTHY;
        int calm; // ticks in a row within capacity
        final Map<Integer, Integer> load = new HashMap<>();

        // region downstream
        /** Answers one request that arrives at tick now. */
        String handle(int now) {
            int n = load.merge(now, 1, Integer::sum); //@arrive
            if (health == Health.RECOVERING) {
                if (n <= CAPACITY) { //@capacity
                    return OK;
                }
                return UNAVAILABLE; //@shed
            }
            return switch (health) { //@outcome
                case HEALTHY -> OK;
                case FAILING -> UNAVAILABLE;
                default -> TIMEOUT;
            };
        }

        void setHealth(Health h) {
            health = h; //@health
            calm = 0;
        }

        /** A recovering service heals after enough calm ticks. */
        void endTick(int now) {
            if (health != Health.RECOVERING) {
                return;
            }
            if (load.getOrDefault(now, 0) <= CAPACITY) {
                calm++; //@calm
            } else {
                calm = 0; //@overload
            }
            if (calm >= CALM_TICKS) {
                setHealth(Health.HEALTHY); //@healed
            }
        }
        // endregion
    }

    /** Closed, open or half-open, one per client. */
    static final class Breaker {
        final boolean enabled;
        State state = State.CLOSED;
        final Deque<Integer> failures = new ArrayDeque<>();
        int openUntil;

        Breaker(boolean enabled) {
            this.enabled = enabled;
        }

        // region breaker
        /** May a request go out? One probe at a time when half-open. */
        boolean allow(int now) {
            return !enabled || state != State.OPEN;
        }

        void onSuccess() {
            if (enabled && state == State.HALF_OPEN) {
                state = State.CLOSED; //@close
                failures.clear(); //@close
            }
        }

        void onFailure(int now) {
            if (!enabled) {
                return;
            }
            if (state == State.HALF_OPEN) {
                trip(now); //@reopen
                return;
            }
            failures.addLast(now); //@count
            while (failures.peekFirst() <= now - WINDOW) {
                failures.removeFirst(); // only the last WINDOW ticks
            }
            if (failures.size() >= THRESHOLD) { //@threshold
                trip(now); //@trip
            }
        }

        void trip(int now) {
            state = State.OPEN; //@trip,reopen
            openUntil = now + OPEN_FOR; //@trip,reopen
            failures.clear();
        }

        void tick(int now) {
            if (state == State.OPEN && now >= openUntil) { //@wait
                state = State.HALF_OPEN; //@half_open
            }
        }
        // endregion
    }

    /** A token bucket for retries: each call earns a fifth of one. */
    static final class RetryBudget {
        int tenths = BUDGET_CAP;

        // region budget_bucket
        void deposit() {
            tenths = Math.min(BUDGET_CAP, tenths + EARN); //@earn
        }

        boolean spend() {
            if (tenths < COST) { //@budget
                return false; //@no_budget
            }
            tenths -= COST; //@spend
            return true;
        }
        // endregion
    }

    /** One call and its retries. */
    static final class Chain {
        int attempt;
        Integer due;
        final int policy;
        final Integer deadline; // a tick, or null
        final boolean guarded; // false: skip the breaker

        Chain(int now, int policy, Integer deadline, boolean guarded) {
            this.due = now;
            this.policy = policy;
            this.deadline = deadline;
            this.guarded = guarded;
        }
    }

    record Attempt(int tick, int attempt, String result) {}

    /** A caller with a retry policy, a breaker and maybe a budget. */
    static final class Client {
        final String name;
        final Downstream downstream;
        final Rng rng;
        final int policy;
        final Breaker breaker;
        RetryBudget budget;
        Integer deadline; // ticks a call may take, or null
        Chain chain;
        final List<Attempt> log = new ArrayList<>();

        Client(String name, Downstream d, Rng rng, int policy, boolean on) {
            this.name = name;
            this.downstream = d;
            this.rng = rng;
            this.policy = policy;
            this.breaker = new Breaker(on);
        }

        boolean call(int now) {
            return call(now, policy, true);
        }

        // region call
        /** Starts a call. Its first attempt goes out now. */
        boolean call(int now, int policy, boolean guarded) {
            if (chain != null) {
                return false; //@busy
            }
            Integer limit = deadline == null ? null : now + deadline;
            chain = new Chain(now, policy, limit, guarded); //@call
            if (budget != null) {
                budget.deposit(); //@deposit
            }
            attempt(now);
            return true;
        }
        // endregion

        // region attempt
        /** Sends one attempt, or fails fast. */
        String attempt(int now) {
            Chain c = chain;
            c.attempt++;
            c.due = null;
            if (c.guarded && !breaker.allow(now)) { //@allow
                log.add(new Attempt(now, c.attempt, FAST)); //@fast
                chain = null; //@fast
                return FAST;
            }
            String result = downstream.handle(now); //@send
            log.add(new Attempt(now, c.attempt, result));
            if (result.equals(OK)) { //@result
                if (c.guarded) {
                    breaker.onSuccess(); //@ok
                }
                chain = null; //@ok
                return OK;
            }
            if (c.guarded) {
                breaker.onFailure(now); //@failed
            }
            planRetry(now, result); //@plan
            return result;
        }
        // endregion

        // region retry
        /** Schedules the next attempt, or gives up. */
        void planRetry(int now, String error) {
            Chain c = chain;
            if (!RETRYABLE.contains(error) || c.policy == NONE
                    || c.attempt >= MAX_ATTEMPTS) { //@give_up_check
                chain = null; //@give_up
                return;
            }
            int delay = backoff(c.attempt - 1, c.policy); //@delay
            if (c.deadline != null && now + delay > c.deadline) { //@deadline
                chain = null; //@cut
                return;
            }
            if (budget != null && !budget.spend()) { //@budget
                chain = null; //@no_budget
                return;
            }
            c.due = now + delay; //@schedule
        }
        // endregion

        // region backoff
        /** Ticks to wait before retry n + 1. */
        int backoff(int n, int policy) {
            if (policy == IMMEDIATE) {
                return 1; //@immediate
            }
            if (policy == FIXED) {
                return FIXED_DELAY; //@fixed
            }
            int delay = Math.min(CAP, BASE * (1 << n)); //@exp
            if (policy == JITTER) {
                // Full jitter, in whole ticks from 1 to delay.
                delay = 1 + (int) (rng.next() * delay); //@jitter
            }
            return delay; //@exp,jitter
        }
        // endregion
    }

    final Downstream downstream = new Downstream();
    final List<Client> clients = new ArrayList<>();
    int now;

    public RetriesBreaker(int policy, boolean breakerOn, int seed) {
        Rng rng = new Rng(seed);
        for (String n : List.of("A", "B", "C", "D")) {
            clients.add(new Client(n, downstream, rng, policy, breakerOn));
        }
    }

    // region tick
    /** Advances the clock one tick and fires what is due. */
    void tick() {
        advance();
        fireDue();
    }

    void advance() {
        downstream.endTick(now); //@end_tick
        now++; //@clock
        for (Client c : clients) {
            c.breaker.tick(now); //@breakers
        }
    }

    void fireDue() {
        for (Client c : clients) {
            if (c.chain != null && c.chain.due == now) { //@due
                c.attempt(now); //@fire
            }
        }
    }
    // endregion

    boolean anyBusy() {
        return clients.stream().anyMatch(c -> c.chain != null);
    }

    // region storm
    /** Every client calls at the tick the downstream fails. */
    void storm(int policy) {
        for (Client c : clients) {
            c.chain = null; //@storm_drop
        }
        tick(); //@storm_drop
        int start = now;
        downstream.setHealth(Health.FAILING); //@storm_fail
        for (Client c : clients) {
            c.call(now, policy, false); //@storm_call
        }
        while (anyBusy()) { //@storm_loop
            advance(); //@storm_tick
            if (now == start + DOWN_FOR) {
                downstream.setHealth(Health.RECOVERING); //@storm_recover
            }
            fireDue(); //@storm_fire
        }
    }
    // endregion

    boolean calmEnough() {
        Health h = downstream.health;
        return h == Health.HEALTHY || h == Health.RECOVERING;
    }

    // region trip
    /** Drives one breaker round its states. */
    void trip(Client client) {
        Breaker b = client.breaker;
        if (!b.enabled) {
            return; //@no_breaker
        }
        tick(); //@trip_tick
        if (b.state == State.CLOSED && calmEnough()) {
            downstream.setHealth(Health.FAILING); //@trip_fail
        }
        while (b.state == State.CLOSED) { //@trip_loop
            client.call(now, NONE, true); //@trip_call
            if (b.state == State.CLOSED) {
                tick(); //@trip_tick
            }
        }
        tick(); //@trip_tick
        if (b.state == State.OPEN) {
            client.call(now, NONE, true); //@trip_fast
            while (b.state == State.OPEN) { //@trip_wait
                tick(); //@trip_tick
            }
        }
        client.call(now, NONE, true); //@trip_probe
    }
    // endregion

    // region budget
    /** Deadlines and retry budgets for every call. */
    void useBudget(Client client, int deadline) {
        for (Client c : clients) {
            c.deadline = deadline > 0 ? deadline : null; //@budget_on
            c.budget = deadline > 0 ? new RetryBudget() : null; //@budget_on
        }
        if (deadline == 0) {
            return; //@budget_off
        }
        if (calmEnough()) {
            downstream.setHealth(Health.SLOW); //@budget_slow
        }
        client.call(now); //@budget_call
        while (client.chain != null) { //@budget_wait
            tick(); //@budget_wait
        }
    }
    // endregion

    // region reset
    /** A fresh system, as built. */
    static RetriesBreaker reset(int policy, boolean on, int seed) {
        return new RetriesBreaker(policy, on, seed); //@reset
    }
    // endregion
}
