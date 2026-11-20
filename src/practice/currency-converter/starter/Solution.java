// Write a currency conversion service. convert(amount, from, to) returns
// the amount in the target currency. Exchange rates come from a third-party
// provider, which is stubbed for you. Assume the provider charges per call
// and is sometimes slow or down. Money is BigDecimal, never double.
// Set STAGE (in the tests) to your stage: main runs every stage up to it.

import java.math.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

@SuppressWarnings("serial")
public class Solution {
    // ===== Supplied code: do not change =====

    static final Map<String, Integer> MINOR_UNITS = Map.of(
            "GBP", 2, "USD", 2, "EUR", 2, "JPY", 0, "KWD", 3);

    /** The provider is down or timed out. Worth retrying. */
    static class ProviderDownException extends RuntimeException {
        ProviderDownException(String message) { super(message); }
    }

    /** The provider does not quote this pair. Retrying will not help. */
    static class UnknownPairException extends RuntimeException {
        UnknownPairException(String message) { super(message); }
    }

    /** A third-party rate source. Every call is charged. */
    interface RateProvider {
        /** How many units of `to` one unit of `from` buys. */
        BigDecimal rate(String from, String to);
    }

    interface Clock { long millis(); }

    static class FakeClock implements Clock {
        private volatile long now = 0;
        public long millis() { return now; }
        void advance(long millis) { now += millis; }
    }

    /** Rates from a table. Counts every call, failed or not. */
    static class FakeProvider implements RateProvider {
        private final Map<String, BigDecimal> rates = new ConcurrentHashMap<>();
        private final AtomicInteger calls = new AtomicInteger();
        private final AtomicInteger failuresLeft = new AtomicInteger();
        private volatile CountDownLatch gate;

        void put(String quote) { // such as "GBP/USD 1.25"
            String[] parts = quote.split(" ");
            rates.put(parts[0], new BigDecimal(parts[1]));
        }
        int calls() { return calls.get(); }
        /** The next n calls throw ProviderDownException. */
        void failNext(int n) { failuresLeft.set(n); }
        /** Calls wait until the gate opens, at most a second. */
        void holdCalls(CountDownLatch gate) { this.gate = gate; }

        public BigDecimal rate(String from, String to) {
            calls.incrementAndGet();
            CountDownLatch g = gate;
            try {
                if (g != null) g.await(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (failuresLeft.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
                throw new ProviderDownException("provider unavailable");
            }
            BigDecimal rate = rates.get(from + "/" + to);
            if (rate == null) throw new UnknownPairException(from + "/" + to);
            return rate;
        }
    }

    // ===== Your code =====

    /** What convert returns. stale: the provider was down; rate is old. */
    record Conversion(BigDecimal amount, BigDecimal rate,
            long rateAgeMillis, boolean stale) {}

    /** No fresh rate, and no cached one young enough to serve stale. */
    static class RateUnavailableException extends RuntimeException {
        RateUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    static class CurrencyConverter {
        private final RateProvider provider;
        private final Clock clock;
        private final long ttlMillis;
        private final long staleLimitMillis;

        CurrencyConverter(RateProvider provider, Clock clock) {
            this(provider, clock, 60_000, 600_000); // 1 min, 10 min
        }

        CurrencyConverter(RateProvider provider, Clock clock,
                long ttlMillis, long staleLimitMillis) {
            this.provider = provider;
            this.clock = clock;
            this.ttlMillis = ttlMillis;
            this.staleLimitMillis = staleLimitMillis;
        }

        Conversion convert(BigDecimal amount, String from, String to) {
            // TODO stage 1: validate, convert, round to the minor units
            throw new UnsupportedOperationException("stage 1");
        }
    }

    // ===== Tests: set STAGE to run more =====

    static final int STAGE = 1;

    public static void main(String[] args) {
        if (STAGE >= 1) stage1();
        if (STAGE >= 2) stage2();
        if (STAGE >= 3) stage3();
        if (STAGE >= 4) stage4();
        if (STAGE >= 5) stage5();
        System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
    }

    static int failed = 0, passed = 0, total = 0;
    static FakeProvider p;          // fresh for every test, as are
    static FakeClock clock;         // the clock and the converter
    static CurrencyConverter c;

    static void check(String name, String expected, Callable<Object> test) {
        clock = new FakeClock();
        quotes("GBP/USD 1.2534", "USD/GBP 0.7978", "GBP/JPY 191.237",
                "USD/KWD 0.30712");
        total++;
        String outcome = outcome(test), got = outcome + " calls " + p.calls();
        boolean ok = got.equals(expected), threw = outcome.startsWith("threw")
                && !expected.startsWith("threw");
        if (ok) passed++; else failed++;
        System.out.println(ok ? "PASS " + name : "FAIL " + name + ": "
                + (threw ? outcome : "expected " + expected + ", got " + got));
    }

    static void endStage(int n) {
        System.out.printf("Stage %d: %d/%d passed%n", n, passed, total);
        passed = total = 0;
    }

    static String outcome(Callable<Object> code) {
        try {
            return String.valueOf(code.call());
        } catch (Exception e) {
            return "threw " + e.getClass().getSimpleName();
        }
    }

    static void quotes(String... quotes) {
        p = new FakeProvider();
        for (String q : quotes) p.put(q);
        c = new CurrencyConverter(p, clock);
    }

    static BigDecimal conv(String amount, String from, String to) {
        return c.convert(new BigDecimal(amount), from, to).amount();
    }

    static String tenGbp() {
        Conversion r = c.convert(new BigDecimal("10.00"), "GBP", "USD");
        return r.amount() + " age " + r.rateAgeMillis() + " stale " + r.stale();
    }

    // Stage 1: return the amount in the target currency, rounded half to
    // even to its minor units. Reject a null or negative amount and unknown
    // codes. The same currency needs no rate. Stale is false for now.
    static void stage1() {
        check("each currency rounds to its minor units",
                "12.53 1912 3.071 calls 3", () -> conv("10.00", "GBP", "USD")
                        + " " + conv("10.00", "GBP", "JPY")
                        + " " + conv("10.00", "USD", "KWD"));
        check("a half rounds to the even neighbour", "1.12 1.14 calls 2",
                () -> { quotes("GBP/EUR 1.125", "USD/EUR 1.135");
                        return conv("1.00", "GBP", "EUR") + " "
                                + conv("1.00", "USD", "EUR"); });
        check("same currency returns the amount without a call",
                "10.00 calls 0", () -> conv("10.00", "GBP", "GBP"));
        check("null, negative and unknown inputs are rejected",
                "[threw IllegalArgumentException] calls 0",
                () -> new TreeSet<>(List.of(
                        outcome(() -> c.convert(null, "GBP", "USD")),
                        outcome(() -> conv("-0.01", "GBP", "USD")),
                        outcome(() -> conv("1.00", null, "USD")),
                        outcome(() -> conv("1.00", "GBP", "XYZ")),
                        outcome(() -> conv("1.00", "gbp", "USD")))));
        endStage(1);
    }

    // Stage 2: provider calls cost money. Reuse each pair's rate for a time
    // to live (constructor argument, default 60 s); at exactly the time to
    // live it has expired. GBP to USD and USD to GBP are separate entries.
    static void stage2() {
        check("rate is reused a millisecond before the ttl",
                "12.53 age 59999 stale false calls 1",
                () -> { tenGbp(); clock.advance(59_999); return tenGbp(); });
        check("rate is fetched again at exactly the ttl",
                "13.00 age 0 stale false calls 2", () -> {
            c = new CurrencyConverter(p, clock, 1_000, 600_000);
            tenGbp();
            p.put("GBP/USD 1.30");
            clock.advance(1_000);
            return tenGbp();
        });
        check("reverse pair is a separate entry", "7.98 calls 2",
                () -> { tenGbp(); return conv("10.00", "USD", "GBP"); });
        endStage(2);
    }

    static String downAfter(long millis) {
        tenGbp();
        clock.advance(millis);
        p.failNext(3);
        return tenGbp();
    }

    // Stage 3: the provider is sometimes down. Retry at once, 3 attempts in
    // all. Then serve the pair's last rate, marked stale, if it is no older
    // than the stale limit (default 10 min, inclusive). Else fail clearly.
    static void stage3() {
        check("two failures then a success is fresh",
                "12.53 age 0 stale false calls 3",
                () -> { p.failNext(2); return tenGbp(); });
        check("down provider serves a stale rate, then a fresh one",
                "12.53 age 61000 stale true, 12.53 age 0 stale false calls 5",
                () -> downAfter(61_000) + ", " + tenGbp());
        check("stale rate is served at exactly the stale limit",
                "12.53 age 600000 stale true calls 4",
                () -> downAfter(600_000));
        check("past the stale limit the conversion fails",
                "threw RateUnavailableException calls 4",
                () -> downAfter(600_001));
        check("down with nothing cached fails after 3 calls",
                "threw RateUnavailableException calls 3",
                () -> { p.failNext(10); return tenGbp(); });
        endStage(3);
    }

    // Stage 4: some pairs are not quoted. Try the inverse (1 / rate), then
    // go through USD. Keep full precision until the final rounding.
    static void stage4() {
        check("inverse pair is used when the direct one is missing",
                "13.33 400.00 calls 2", () -> { quotes("USD/GBP 0.75");
                    return conv("10.00", "GBP", "USD") + " "
                            + conv("300.00", "GBP", "USD"); });
        check("cross rate goes through usd and is cached",
                "1877 rate 187.65375 calls 4", () -> {
            quotes("GBP/USD 1.25", "USD/JPY 150.123");
            conv("10.00", "GBP", "JPY");
            Conversion r = c.convert(new BigDecimal("10.00"), "GBP", "JPY");
            return r.amount() + " rate " + r.rate();
        });
        // 7 JPY is 0.0462 USD. Rounded to 0.05 USD first, it gives 0.05 EUR.
        check("intermediate amount is not rounded", "0.04 calls 4",
                () -> { quotes("JPY/USD 0.0066", "USD/EUR 0.92");
                        return conv("7", "JPY", "EUR"); });
        endStage(4);
    }

    static String fromThreads(String... pairs) throws InterruptedException {
        CountDownLatch gate = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(100);
        Map<String, Integer> results = new ConcurrentHashMap<>();
        p.holdCalls(gate);
        for (int i = 0; i < 100; i++) {
            String[] pair = pairs[i % pairs.length].split("/");
            new Thread(() -> {
                String r = outcome(() -> conv("10.00", pair[0], pair[1]));
                results.merge(r, 1, Integer::sum);
                done.countDown();
            }).start();
        }
        gate.countDown();
        done.await(1, TimeUnit.SECONDS);
        return new TreeMap<>(results).toString();
    }

    // Stage 5: many threads convert one pair at once. The provider is slow
    // and charges per call: one call, not a hundred, cold or on expiry.
    static void stage5() {
        check("hundred threads on a cold cache make one call",
                "{12.53=100} calls 1", () -> fromThreads("GBP/USD"));
        check("an expired rate is refreshed by one call",
                "{12.53=100} calls 2", () -> { tenGbp(); clock.advance(60_000);
                    return fromThreads("GBP/USD"); });
        check("two pairs at once make one call each",
                "{12.53=50, 7.98=50} calls 2",
                () -> fromThreads("GBP/USD", "USD/GBP"));
        endStage(5);
    }
}
