import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;

// Our gateway sits in front of several internal services. Each service can
// take only so many requests. Write a rate limiter with one method,
// boolean allow(String service), that says whether a request to that
// service may go ahead right now.
//
// Start with one rule for everyone: at most 3 requests in any 10 seconds.
//
// Supplied: a clock the tests control and a Limit record (max requests,
// window in milliseconds). RateLimiter takes the clock and a default limit
// in its constructor.
//
// Set STAGE below to the stage you are on: main runs every stage up to it.
public class Solution {

    // ===== Supplied code: do not change =====

    /** The time now, in milliseconds. */
    interface Clock {
        long millis();
    }

    /** A clock the tests move by hand. Starts at 0. */
    static final class FakeClock implements Clock {
        private volatile long now;
        @Override public long millis() { return now; }
        void set(long millis) { now = millis; }
    }

    /** At most maxRequests requests in any windowMillis milliseconds. */
    record Limit(int maxRequests, long windowMillis) {
        Limit {
            if (maxRequests < 1 || windowMillis < 1) {
                throw new IllegalArgumentException("limit must be positive");
            }
        }
    }

    // ===== Your code =====

    static final class RateLimiter {
        RateLimiter(Clock clock, Limit defaultLimit) {
            // TODO stage 1: keep what allow needs
        }

        boolean allow(String service) {
            // TODO stage 1: count each service's requests in fixed windows
            throw new UnsupportedOperationException("stage 1");
        }

        void setLimit(String service, Limit limit) {
            // TODO stage 2: give one service its own limit
            throw new UnsupportedOperationException("stage 2");
        }

        long retryAfterMillis(String service) {
            // TODO stage 4: how long until a request would be allowed
            throw new UnsupportedOperationException("stage 4");
        }

        int evictIdle() {
            // TODO stage 5: forget services that have gone quiet
            throw new UnsupportedOperationException("stage 5");
        }

        int trackedServices() {
            // TODO stage 5: count the services held
            throw new UnsupportedOperationException("stage 5");
        }
    }

    // ===== Tests: set STAGE to run more =====

    static final int STAGE = 1;
    static int failed, stagePassed, stageTotal;

    public static void main(String[] args) {
        if (STAGE >= 1) stage1();
        if (STAGE >= 2) stage2();
        if (STAGE >= 3) stage3();
        if (STAGE >= 4) stage4();
        if (STAGE >= 5) stage5();
        System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
    }

    // Each test gets a new clock at 0 and a limiter with this default.
    // Results read y for a request allowed and n for one refused.
    static final Limit DEFAULT = new Limit(3, 10_000);

    // Stage 1: one rule for every service, 3 requests per 10 seconds.
    // Count in fixed windows: the window number is now / window length.
    // Refuse once a service has used its limit in the current window; the
    // next window starts again from zero. Count each service on its own.
    static void stage1() {
        check("first request is allowed",
                (clock, limiter) -> calls(limiter, "orders", 1), "y");
        check("fourth request in a window is refused",
                (clock, limiter) -> calls(limiter, "orders", 4), "yyyn");
        check("refused until the window ends", (clock, limiter) ->
                tries(clock, limiter, "orders", 0, 0, 0, 9_999), "yyyn");
        check("count starts again at the window edge", (clock, limiter) ->
                tries(clock, limiter, "orders",
                        0, 0, 0, 10_000, 10_000, 10_000, 10_000), "yyyyyyn");
        check("services are counted separately", (clock, limiter) ->
                calls(limiter, "orders", 4) + calls(limiter, "payments", 4),
                "yyynyyyn");
        endStage(1);
    }

    // Stage 2: some services can take more than others. setLimit(service,
    // limit) gives one service its own limit from its next call; the rest
    // keep the default. A null or blank service name is a bug in the
    // caller: throw IllegalArgumentException.
    static void stage2() {
        check("a service uses its own limit", (clock, limiter) -> {
            limiter.setLimit("search", new Limit(5, 1_000));
            return tries(clock, limiter, "search", 0, 0, 0, 0, 0, 0, 1_000);
        }, "yyyyyny");
        check("other services keep the default", (clock, limiter) -> {
            limiter.setLimit("search", new Limit(5, 1_000));
            return calls(limiter, "orders", 4);
        }, "yyyn");
        check("a lowered limit applies on the next call", (clock, limiter) -> {
            String before = calls(limiter, "orders", 2);
            limiter.setLimit("orders", new Limit(2, 10_000));
            return before + calls(limiter, "orders", 1);
        }, "yyn");
        check("a raised limit applies on the next call", (clock, limiter) -> {
            String before = calls(limiter, "orders", 4);
            limiter.setLimit("orders", new Limit(5, 10_000));
            return before + calls(limiter, "orders", 3);
        }, "yyynyyn");
        check("a null or blank service name is rejected", (clock, limiter) ->
                rejected(() -> limiter.allow(null))
                + " " + rejected(() -> limiter.allow(" ")), "true true");
        endStage(2);
    }

    // Stage 3: a fixed window lets a burst through at its edge: 3 requests
    // just before it and 3 just after, 6 in two seconds. Make the limit
    // hold over any 10 seconds: count only the requests allowed in the
    // last window length.
    static void stage3() {
        check("no burst of six across a window edge", (clock, limiter) ->
                tries(clock, limiter, "orders",
                        9_000, 9_500, 9_999, 10_000, 10_500, 11_000), "yyynnn");
        check("a slot frees exactly one window after its request",
                (clock, limiter) -> tries(clock, limiter, "orders", 0, 4_000,
                        8_000, 9_999, 10_000, 10_000, 13_999, 14_000),
                "yyynynny");
        check("refused requests are not counted", (clock, limiter) ->
                tries(clock, limiter, "orders",
                        0, 0, 0, 9_000, 9_000, 9_000, 10_000), "yyynnny");
        endStage(3);
    }

    // Stage 4: when we refuse, the gateway wants to tell the caller when
    // to come back. retryAfterMillis(service) is 0 if a request would be
    // allowed now, otherwise how long until one would be. Asking must not
    // use up a slot.
    static void stage4() {
        check("nothing to wait for on a new service",
                (clock, limiter) -> limiter.retryAfterMillis("orders"), 0L);
        check("a full service waits until its oldest request leaves",
                (clock, limiter) -> {
            tries(clock, limiter, "orders", 0, 1_000, 2_000, 5_000);
            long wait = limiter.retryAfterMillis("orders");
            return wait + " " + tries(clock, limiter, "orders",
                    5_000 + wait - 1, 5_000 + wait);
        }, "5000 ny");
        check("asking does not use a slot", (clock, limiter) ->
                calls(limiter, "orders", 2)
                + " " + limiter.retryAfterMillis("orders")
                + " " + limiter.retryAfterMillis("orders")
                + " " + calls(limiter, "orders", 2), "yy 0 0 yn");
        check("a lowered limit waits for enough requests to leave",
                (clock, limiter) -> {
            tries(clock, limiter, "orders", 0, 1_000, 2_000);
            limiter.setLimit("orders", new Limit(2, 10_000));
            return limiter.retryAfterMillis("orders") + " "
                    + tries(clock, limiter, "orders", 10_999, 11_000);
        }, "9000 ny");
        endStage(4);
    }

    // Stage 5: many threads call the limiter at once; for one service
    // exactly its limit may succeed. Services that go quiet must not stay
    // in memory for ever: evictIdle() drops services with nothing left in
    // their window and says how many; trackedServices() counts the rest.
    static void stage5() {
        check("parallel callers get exactly the limit", (clock, limiter) ->
                parallel(shared -> shared.allow("orders")), Set.of(100));
        check("idle services are evicted", (clock, limiter) -> {
            calls(limiter, "orders", 1);
            calls(limiter, "payments", 1);
            clock.set(10_000);
            return limiter.evictIdle() + " " + limiter.trackedServices();
        }, "2 0");
        check("a service with recent requests is kept", (clock, limiter) -> {
            tries(clock, limiter, "orders", 0);
            tries(clock, limiter, "payments", 9_000);
            clock.set(10_000);
            return limiter.evictIdle() + " " + limiter.trackedServices()
                    + " " + calls(limiter, "payments", 3);
        }, "1 1 yyn");
        check("eviction during traffic loses no request", (clock, limiter) ->
                parallel(shared -> {
                    shared.evictIdle();
                    return shared.allow("orders");
                }), Set.of(100));
        endStage(5);
    }

    static String calls(RateLimiter limiter, String service, int n) {
        String out = "";
        for (int i = 0; i < n; i++) out += limiter.allow(service) ? "y" : "n";
        return out;
    }

    static String tries(FakeClock clock, RateLimiter limiter, String service,
            long... times) {
        String out = "";
        for (long t : times) {
            clock.set(t);
            out += limiter.allow(service) ? "y" : "n";
        }
        return out;
    }

    static boolean rejected(Runnable call) {
        try {
            call.run();
        } catch (IllegalArgumentException e) {
            return true;
        }
        return false;
    }

    // 20 rounds. Each makes a limiter of 100 per 10 s and has 8 threads
    // call it 50 times each, all at once. Returns the allowed counts seen.
    static Set<Integer> parallel(Predicate<RateLimiter> call)
            throws Exception {
        var counts = new TreeSet<Integer>();
        var pool = Executors.newFixedThreadPool(8,
                Thread.ofPlatform().daemon().factory());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        for (int round = 0; round < 20; round++) {
            var shared =
                    new RateLimiter(new FakeClock(), new Limit(100, 10_000));
            var start = new CountDownLatch(1);
            var allowed = new AtomicInteger();
            var results = new ArrayList<Future<?>>();
            for (int i = 0; i < 8; i++) {
                results.add(pool.submit(() -> {
                    start.await();
                    for (int j = 0; j < 50; j++) {
                        if (call.test(shared)) allowed.incrementAndGet();
                    }
                    return null;
                }));
            }
            start.countDown();
            for (var result : results) {
                result.get(deadline - System.nanoTime(), TimeUnit.NANOSECONDS);
            }
            counts.add(allowed.get());
        }
        pool.shutdown();
        return counts;
    }

    interface Check {
        Object run(FakeClock clock, RateLimiter limiter) throws Exception;
    }

    static void check(String name, Check test, Object want) {
        stageTotal++;
        try {
            var clock = new FakeClock();
            Object got = test.run(clock, new RateLimiter(clock, DEFAULT));
            boolean ok = Objects.equals(got, want);
            if (ok) stagePassed++; else failed++;
            System.out.println(ok ? "PASS " + name
                    : "FAIL " + name + ": expected " + want + ", got " + got);
        } catch (Exception e) {
            failed++;
            System.out.println("FAIL " + name + ": threw " + e);
        }
    }

    static void endStage(int n) {
        System.out.println("Stage " + n + ": " + stagePassed + "/"
                + stageTotal + " passed");
        stagePassed = stageTotal = 0;
    }
}
