import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/*
 * Our service calls a partner API that needs an access token on every
 * request. Getting a token means a call to the partner's auth server,
 * which is slow and rate limited. Write a token manager with one method,
 * getToken(), that returns a token that is valid right now and calls the
 * auth server as rarely as it can.
 *
 * The tests at the bottom run stage by stage: raise STAGE to run more.
 */
@SuppressWarnings("serial")
public class Solution {

    // ===== Supplied code: do not change =====

    /** expiresAt: when it stops working, in milliseconds on our clock. */
    record Token(String authToken, String refreshToken, long expiresAt) {}

    /** The partner's auth server: slow and rate limited. Both calls throw
     *  AuthUnavailableException when it is down; refresh() throws
     *  RefreshRejectedException if it will not take the refresh token. */
    interface AuthApi {
        Token login();
        Token refresh(String refreshToken);
    }

    static class AuthUnavailableException extends RuntimeException {}
    static class RefreshRejectedException extends RuntimeException {}

    interface Clock { long nowMillis(); }

    /** Issues a1, a2, ... with refresh tokens r1, r2, ..., each valid for
     *  an hour. Only the latest refresh token works: any login makes older
     *  ones stale. Every call is logged, failed ones too. */
    static class FakeAuthApi implements AuthApi {
        static final long LIFETIME = 3_600_000; // milliseconds
        private final Clock clock;
        private final Queue<String> log = new ConcurrentLinkedQueue<>();
        private final AtomicInteger issued = new AtomicInteger();
        private final AtomicInteger toFail = new AtomicInteger();
        private volatile CountDownLatch gate;

        FakeAuthApi(Clock clock) { this.clock = clock; }

        public Token login() { return answer("login", false); }

        public Token refresh(String refreshToken) {
            boolean stale = !refreshToken.equals("r" + issued.get());
            return answer("refresh " + refreshToken, stale);
        }

        /** The next call fails with AuthUnavailableException. */
        void failNextCall() { toFail.incrementAndGet(); }
        /** Calls wait, for at most a second, until releaseCalls(). */
        void holdCalls() { gate = new CountDownLatch(1); }
        void releaseCalls() { gate.countDown(); }
        /** Calls so far, such as [login, refresh r1 (down)]. */
        String log() { return log.toString(); }

        private Token answer(String call, boolean refuse) {
            CountDownLatch g = gate;
            try {
                if (g != null) g.await(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (toFail.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
                log.add(call + " (down)");
                throw new AuthUnavailableException();
            }
            if (refuse) {
                log.add(call + " (refused)");
                throw new RefreshRejectedException();
            }
            log.add(call);
            int n = issued.incrementAndGet();
            return new Token("a" + n, "r" + n, clock.nowMillis() + LIFETIME);
        }
    }

    // ===== Your code =====

    static class TokenManager {
        static final long DEFAULT_MARGIN_MILLIS = 30_000;

        // region state
        private final AuthApi auth;
        private final Clock clock;
        private final long marginMillis;
        private Token token;
        // endregion

        TokenManager(AuthApi auth, Clock clock) {
            this(auth, clock, DEFAULT_MARGIN_MILLIS);
        }

        // region constructor
        TokenManager(AuthApi auth, Clock clock, long marginMillis) {
            this.auth = auth;
            this.clock = clock;
            this.marginMillis = marginMillis;
        }
        // endregion

        // region get-token
        /** Returns an access token that is valid now. */
        String getToken() {
            long now = clock.nowMillis();
            // Renew early so a request in flight never carries a dead token.
            if (token == null || now >= token.expiresAt() - marginMillis) {
                token = auth.login();
            }
            return token.authToken();
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

    // Each test starts at time 0 with a manager on the default margin that
    // has fetched its first token, a1. a1 expires at EXPIRES.
    static final long EXPIRES = FakeAuthApi.LIFETIME;
    static final long MARGIN = 30_000;

    // Stage 1: log in on the first call and keep the token. Later calls
    // return it without calling the auth server.
    static void stage1() {
        test("first call logs in", () -> expect("[login]", auth.log()));
        test("later calls reuse the token", () -> {
            for (int i = 0; i < 10; i++) expect("a1", token());
            expect("[login]", auth.log());
        });
        test("each manager keeps its own token", () -> {
            expect("a2", new TokenManager(auth, clock::get).getToken());
            expect("a1", token());
        });
        endStage(1);
    }

    // Stage 2: replace a token that has expired, or will within a margin
    // (30 s by default), so no request in flight carries a dead token.
    static void stage2() {
        test("token is kept until one ms before the margin", () -> {
            expect("a1", tokenAt(EXPIRES - MARGIN - 1));
            expect("[login]", auth.log());
        });
        test("token is replaced exactly at the margin", () -> {
            expect("a2", tokenAt(EXPIRES - MARGIN));
            expect("a2", token());
        });
        test("expired token is replaced", () -> expect("a2", tokenAt(EXPIRES)));
        test("margin of zero keeps the token to its expiry", () -> {
            manager = new TokenManager(auth, clock::get, 0);
            expect("a2", token());
            expect("a2", tokenAt(EXPIRES - 1));
            expect("a3", tokenAt(EXPIRES));
        });
        endStage(2);
    }

    // Stage 3: renew with refresh() and the token's refresh token; if the
    // server refuses it, log in. A failed renewal must break nothing.
    static void stage3() {
        test("renewal uses the refresh token", () -> {
            expect("a2", tokenAt(EXPIRES));
            expect("a3", tokenAt(2 * EXPIRES));
            expect("[login, refresh r1, refresh r2]", auth.log());
        });
        test("refused refresh token falls back to login", () -> {
            new TokenManager(auth, clock::get).getToken(); // r1 goes stale
            expect("a3", tokenAt(EXPIRES));
            expect("[login, login, refresh r1 (refused), login]", auth.log());
        });
        test("failed refresh keeps the old token for the retry", () -> {
            auth.failNextCall();
            tokenAt(EXPIRES);
            expect("a2", token());
            expect("[login, refresh r1 (down), refresh r1]", auth.log());
        });
        endStage(3);
    }

    // Stage 4: if the server is down, keep using the token until it expires
    // and retry next call; then throw a clear exception. Never keep a failure.
    static void stage4() {
        test("server down inside the margin gives the old token", () -> {
            auth.failNextCall();
            expect("a1", tokenAt(EXPIRES - 1));
            expect("a2", token()); // the call after a failure tries again
            expect("[login, refresh r1 (down), refresh r1]", auth.log());
        });
        test("server down at expiry throws", () -> {
            auth.failNextCall();
            expect("IllegalStateException", tokenAt(EXPIRES));
        });
        test("failed first login throws and is not kept", () -> {
            manager = new TokenManager(auth, clock::get);
            auth.failNextCall();
            expect("IllegalStateException", token());
            expect("a2", token());
        });
        endStage(4);
    }

    // Stage 5: a hundred threads call getToken() on an expired token at
    // once: one call reaches the auth server and all get the new token.
    // Readers of a valid token wait no more than the simplest design needs.
    static void stage5() {
        test("hundred threads on an expired token share one call", () -> {
            clock.set(EXPIRES);
            expect("{a2=100}", hundredCalls());
            expect("[login, refresh r1]", auth.log());
        });
        test("hundred threads on a valid token make no call", () -> {
            expect("{a1=100}", hundredCalls());
            expect("[login]", auth.log());
        });
        test("after a failed renewal the next waiter renews", () -> {
            clock.set(EXPIRES);
            auth.failNextCall();
            expect("{IllegalStateException=1, a2=99}", hundredCalls());
            expect("[login, refresh r1 (down), refresh r1]", auth.log());
        });
        endStage(5);
    }

    // ----- Harness -----

    static AtomicLong clock;
    static FakeAuthApi auth;
    static TokenManager manager;

    // The token getToken() returns, or the simple name of what it threw.
    static String token() {
        try {
            return manager.getToken();
        } catch (RuntimeException e) {
            return e.getClass().getSimpleName();
        }
    }

    static String tokenAt(long millis) {
        clock.set(millis);
        return token();
    }

    // Calls to the server wait until all hundred threads wait or are done.
    static String hundredCalls() throws InterruptedException {
        var counts = new ConcurrentHashMap<String, Integer>();
        var done = new CountDownLatch(100);
        var threads = new ArrayList<Thread>();
        auth.holdCalls();
        for (int i = 0; i < 100; i++) {
            threads.add(Thread.ofPlatform().start(() -> {
                counts.merge(token(), 1, Integer::sum);
                done.countDown();
            }));
        }
        long deadline = System.nanoTime() + 1_000_000_000L;
        while (System.nanoTime() < deadline && threads.stream()
                .anyMatch(t -> t.getState() == Thread.State.RUNNABLE)) {
            Thread.onSpinWait();
        }
        auth.releaseCalls();
        done.await(1, TimeUnit.SECONDS);
        if (counts.size() > 3) return counts.size() + " different outcomes";
        return new TreeMap<>(counts).toString();
    }

    interface Body { void run() throws Exception; }

    static int failed, passed, total;

    static void test(String name, Body body) {
        total++;
        try {
            clock = new AtomicLong();
            auth = new FakeAuthApi(clock::get);
            manager = new TokenManager(auth, clock::get);
            expect("a1", token());
            body.run();
            passed++;
            System.out.println("PASS " + name);
        } catch (Throwable e) {
            failed++;
            System.out.println("FAIL " + name + ": "
                    + (e instanceof AssertionError ? e.getMessage()
                            : "threw " + e));
        }
    }

    static void expect(Object want, Object got) {
        if (!Objects.equals(want, got)) {
            throw new AssertionError("expected " + want + ", got " + got);
        }
    }

    static void endStage(int n) {
        System.out.printf("Stage %d: %d/%d passed%n", n, passed, total);
        passed = total = 0;
    }
}
