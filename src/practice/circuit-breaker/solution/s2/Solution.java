import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/*
 * Circuit breaker.
 *
 * Here is a small web client. Service A uses it to call two downstream
 * services, B and C. The remote calls are simulated for you.
 * Implement execute() so that when a downstream service keeps failing we
 * stop calling it for a while: three failures within ten minutes means no
 * calls to that service for the next five minutes. After that, try again.
 * A blocked call must not reach the remote: it returns Response.BLOCKED
 * at once (status 503 with the blocked flag set).
 *
 * Run it to see the tests. Raise STAGE near the bottom to add a stage.
 */
public class Solution {

    // ===== Supplied code: do not change =====

    /** A call to one downstream service. */
    record Request(String service, String path) {}

    /** blocked is true only when the client refused to make the call. */
    record Response(int status, boolean blocked) {
        static final Response BLOCKED = new Response(503, true);
        static Response of(int status) { return new Response(status, false); }
    }

    interface Remote { Response call(Request request); }
    interface Clock { long millis(); }

    /** Simulated services. Tests set the answers and count real calls. */
    static final class FakeRemote implements Remote {
        private final Map<String, Integer> answers = new ConcurrentHashMap<>();
        private final Map<String, Integer> calls = new ConcurrentHashMap<>();

        /** From now on calls to service return status; -1 means throw. */
        void respond(String service, int status) {
            answers.put(service, status);
        }

        /** How many calls really reached service. */
        int calls(String service) { return calls.getOrDefault(service, 0); }

        @Override
        public Response call(Request request) {
            calls.merge(request.service(), 1, Integer::sum);
            int status = answers.getOrDefault(request.service(), 200);
            if (status < 0) {
                throw new IllegalStateException("no route to service");
            }
            return Response.of(status);
        }
    }

    /** Time the tests control, in milliseconds from 0. */
    static final class FakeClock implements Clock {
        private final AtomicLong now = new AtomicLong();

        void advance(long millis) { now.addAndGet(millis); }
        @Override
        public long millis() { return now.get(); }
    }

    // ===== Your code =====

    static final class WebClient {
        private final Remote remote;
        private final Clock clock;
        private final int maxFailures;
        private final long windowMillis;
        private final long cooldownMillis;
        private final Breaker breaker = new Breaker();

        WebClient(Remote remote, Clock clock) {
            this(remote, clock, 3, Duration.ofMinutes(10),
                    Duration.ofMinutes(5));
        }

        WebClient(Remote remote, Clock clock, int maxFailures,
                Duration window, Duration cooldown) {
            this.remote = remote;
            this.clock = clock;
            this.maxFailures = maxFailures;
            this.windowMillis = window.toMillis();
            this.cooldownMillis = cooldown.toMillis();
        }

        // region execute-with-time
        public Response execute(Request request) {
            if (!breaker.allow(clock.millis())) {
                return Response.BLOCKED;
            }
            Response response;
            try {
                response = remote.call(request);
            } catch (RuntimeException e) {
                breaker.record(clock.millis(), true);
                throw e;
            }
            breaker.record(clock.millis(), response.status() >= 500);
            return response;
        }
        // endregion

        // TODO stage 5: one ALLOWED, BLOCKED or INVALID for each line.
        public List<String> replay(List<String> lines) {
            throw new UnsupportedOperationException("stage 5");
        }

        // region states
        private enum State { CLOSED, OPEN, HALF_OPEN }
        // endregion

        // region breaker-with-cooldown
        private final class Breaker {
            /** Times of recent failures, oldest first. */
            private final Deque<Long> failures = new ArrayDeque<>();
            private State state = State.CLOSED;
            private long openedAt;

            boolean allow(long now) {
                if (state == State.CLOSED) {
                    return true;
                }
                if (state == State.OPEN && now - openedAt >= cooldownMillis) {
                    state = State.HALF_OPEN;
                    return true;
                }
                return false;
            }

            void record(long now, boolean failed) {
                if (state == State.HALF_OPEN) {
                    if (failed) {
                        open(now);
                    } else {
                        state = State.CLOSED;
                        failures.clear();
                    }
                    return;
                }
                if (!failed) {
                    return;
                }
                failures.addLast(now);
                while (now - failures.peekFirst() >= windowMillis) {
                    failures.removeFirst();
                }
                if (failures.size() >= maxFailures) {
                    open(now);
                }
            }

            private void open(long now) {
                state = State.OPEN;
                openedAt = now;
            }
        }
        // endregion
    }

    // ===== Tests: set STAGE to run more =====

    static final int STAGE = 2;

    public static void main(String[] args) {
        if (STAGE >= 1) stage1();
        if (STAGE >= 2) stage2();
        if (STAGE >= 3) stage3();
        if (STAGE >= 4) stage4();
        if (STAGE >= 5) stage5();
        System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
    }

    // Stage 1. Calls go through to the remote. A 5xx or an exception is a
    // failure; a 4xx is not. Three failures within ten minutes open the
    // breaker: every later call is blocked without reaching the remote.
    static void stage1() {
        test("third failure opens the breaker", () -> {
            var t = new Env().answer("B", 500, 3);
            expect(Response.BLOCKED, t.hit("B"));
            expect(3, t.remote.calls("B"));
        });
        test("4xx answers pass through and are not failures", () -> {
            var t = new Env().answer("B", 404, 3);
            expect(Response.of(404), t.hit("B"));
            expect(4, t.remote.calls("B"));
        });
        test("exceptions count and are rethrown", () -> {
            var t = new Env().answer("B", -1, 0);
            int thrown = 0;
            for (int i = 0; i < 3; i++) {
                try { t.hit("B"); } catch (RuntimeException e) { thrown++; }
            }
            expect(3, thrown);
            expect(Response.BLOCKED, t.hit("B"));
        });
        test("failure exactly ten minutes old no longer counts", () -> {
            var t = new Env().answer("B", 500, 2).after(minutes(10));
            expect(Response.of(500), t.answer("B", 500, 2).last);
        });
        endStage(1);
    }

    // Stage 2. Five minutes after the breaker opens, let one call through as
    // a trial. If it succeeds, close the breaker and forget old failures.
    // If it fails, stay open for another five minutes.
    static void stage2() {
        test("trial at exactly five minutes closes it on success", () -> {
            var t = new Env().trip("B").after(minutes(5) - 1);
            expect(Response.BLOCKED, t.hit("B"));
            expect(Response.of(200), t.after(1).hit("B"));
            expect(Response.of(200), t.hit("B"));
            expect(5, t.remote.calls("B"));
        });
        test("failed trial opens it for another cooldown", () -> {
            var t = new Env().trip("B").after(minutes(5));
            t.answer("B", 500, 1).remote.respond("B", 200);
            expect(Response.BLOCKED, t.after(minutes(5) - 1).hit("B"));
            expect(Response.of(200), t.after(1).hit("B"));
        });
        test("recovery forgets earlier failures", () -> {
            var t = new Env().trip("B").after(minutes(5));
            t.hit("B");
            expect(Response.of(500), t.answer("B", 500, 3).last);
        });
        endStage(2);
    }

    // Stage 3. A calls both B and C through one client. Keep a breaker per
    // service: B failing must not block C, and each service has its own
    // failure count and its own cooldown.
    static void stage3() {
        test("open breaker on b does not block c", () -> {
            var t = new Env().trip("B");
            expect(Response.BLOCKED, t.hit("B"));
            expect(Response.of(200), t.hit("C"));
        });
        test("each service has its own cooldown", () -> {
            var t = new Env().trip("B").after(minutes(3));
            t.trip("C").after(minutes(2));
            expect(Response.of(200), t.hit("B"));
            expect(Response.BLOCKED, t.hit("C"));
            expect(Response.of(200), t.after(minutes(3)).hit("C"));
        });
        test("recovery of b leaves the failures of c alone", () -> {
            var t = new Env().answer("C", 500, 2);
            t.trip("B").after(minutes(5)).hit("B");
            t.answer("C", 500, 1);
            expect(Response.BLOCKED, t.hit("C"));
        });
        endStage(3);
    }

    // Stage 4. Many threads call execute at once. No failure may be lost.
    // When the cooldown ends exactly one trial goes out; the rest stay
    // blocked until it reports. A slow call must not hold up the others.
    static void stage4() {
        test("no failure is lost under contention", () -> {
            for (int round = 0; round < 16; round++) {
                var t = new Env(4000);
                var go = new CountDownLatch(1);
                var done = new CountDownLatch(8);
                for (int i = 0; i < 8; i++) {
                    start(() -> {
                        await(go);
                        t.answer("B", 500, 500);
                    }, done);
                }
                go.countDown();
                expect(true, await(done));
                expect(4000, t.remote.calls("B"));
                expect(Response.BLOCKED, t.hit("B"));
            }
        });
        test("exactly one trial after the cooldown", () -> {
            var t = new Env().trip("B").after(minutes(5)).hold("/");
            var out = new CountDownLatch(19);
            var done = new CountDownLatch(20);
            for (int i = 0; i < 20; i++) {
                start(() -> {
                    if (t.hit("B").blocked()) out.countDown();
                }, done);
            }
            boolean othersBlocked = await(out);
            t.gate.countDown();
            expect(true, othersBlocked && await(done));
            expect(4, t.remote.calls("B"));
        });
        test("a slow call does not hold up the next one", () -> {
            var t = new Env().hold("/");
            var slow = new CountDownLatch(1);
            var fast = new CountDownLatch(1);
            start(() -> t.hit("B"), slow);
            boolean ok = await(t.arrived);
            start(() -> t.hit("B", "/fast"), fast);
            ok &= await(fast, 500);
            t.gate.countDown();
            expect(true, ok && await(slow));
        });
        endStage(4);
    }

    // Stage 5. Same rules, but time comes in the input. Each line is
    // "timestampMillis service statusCode", what the service would answer
    // then. Say ALLOWED or BLOCKED per line, using the same breaker. A line
    // that cannot be read gives INVALID and changes nothing.
    static void stage5() {
        test("replay blocks after the trip and keeps services apart", () -> {
            var t = new Env();
            expect(List.of("ALLOWED", "ALLOWED", "ALLOWED", "ALLOWED",
                    "BLOCKED"), t.client.replay(List.of("0 B 500",
                    "1000 B 500", "2000 B 502", "3000 C 200", "4000 B 200")));
            expect(0, t.remote.calls("B"));
        });
        test("replay applies the window and the cooldown", () -> expect(
                List.of("ALLOWED", "ALLOWED", "ALLOWED", "ALLOWED",
                        "BLOCKED", "ALLOWED", "ALLOWED"),
                new Env().client.replay(List.of("0 B 500", "60000 B 500",
                        "600000 B 500", "600001 B 500", "900000 B 200",
                        "900001 B 200", "900002 B 500"))));
        test("unreadable lines are invalid and change nothing", () -> expect(
                List.of("ALLOWED", "ALLOWED", "INVALID", "INVALID",
                        "INVALID", "INVALID", "ALLOWED", "BLOCKED"),
                new Env().client.replay(List.of("0 B 500", "1 B 500", "",
                        "2 B", "x B 500", "3 B 500 x", "4 B 500", "5 B 200"))));
        endStage(5);
    }

    // ----- Test helpers and harness -----

    /** A client on a fake clock and remote. Calls can be held by path. */
    static final class Env implements Remote {
        final FakeRemote remote = new FakeRemote();
        final FakeClock clock = new FakeClock();
        final WebClient client;
        volatile String heldPath;
        CountDownLatch gate, arrived;
        Response last;

        Env() { client = new WebClient(this, clock); }
        Env(int max) {
            client = new WebClient(this, clock, max,
                    Duration.ofMinutes(10), Duration.ofMinutes(5));
        }
        Response hit(String service) { return hit(service, "/"); }
        Response hit(String service, String path) {
            return client.execute(new Request(service, path));
        }
        /** Sets the answer, then calls the service that many times. */
        Env answer(String service, int status, int times) {
            remote.respond(service, status);
            for (int i = 0; i < times; i++) last = hit(service);
            return this;
        }
        /** Opens the breaker for service; calls after it would succeed. */
        Env trip(String service) {
            answer(service, 500, 3).remote.respond(service, 200);
            return this;
        }
        Env after(long millis) { clock.advance(millis); return this; }
        /** Calls to path wait at a gate until the test opens it. */
        Env hold(String path) {
            gate = new CountDownLatch(1);
            arrived = new CountDownLatch(1);
            heldPath = path;
            return this;
        }
        @Override
        public Response call(Request request) {
            if (request.path().equals(heldPath)) {
                arrived.countDown();
                await(gate);
            }
            return remote.call(request);
        }
    }

    static long minutes(long n) { return n * 60_000; }
    static void start(Runnable body, CountDownLatch done) {
        new Thread(() -> {
            try { body.run(); } catch (RuntimeException e) { /* checked */ }
            finally { done.countDown(); }
        }).start();
    }
    static boolean await(CountDownLatch latch) { return await(latch, 1000); }
    static boolean await(CountDownLatch latch, long millis) {
        try { return latch.await(millis, TimeUnit.MILLISECONDS); }
        catch (InterruptedException e) { return false; }
    }

    static int failed, stagePassed, stageRun;
    static void test(String name, Runnable body) {
        stageRun++;
        try {
            body.run();
            stagePassed++;
            System.out.println("PASS " + name);
        } catch (AssertionError | RuntimeException e) {
            failed++;
            System.out.println("FAIL " + name + ": " + (e instanceof
                    AssertionError ? e.getMessage() : "threw " + e));
        }
    }
    static void expect(Object expected, Object actual) {
        if (Objects.equals(expected, actual)) return;
        throw new AssertionError("expected " + expected + ", got " + actual);
    }
    static void endStage(int n) {
        System.out.println("Stage " + n + ": " + stagePassed + "/" + stageRun
                + " passed");
        stagePassed = stageRun = 0;
    }
}
