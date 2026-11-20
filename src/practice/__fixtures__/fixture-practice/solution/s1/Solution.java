import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;

// A fixture for the practice page renderer, not a real task.
// Build a counter that counts calls to hit and, from stage 2, refuses
// calls once it reaches its limit.
// Set STAGE below to the stage you are on: main runs every stage up to it.
public class Solution {

    // ===== Supplied code: do not change =====

    /** Where the counter reports a refused call. */
    interface Audit {
        void refused(String who, int count);
    }

    /** An audit that keeps what it is told, for the tests. */
    static final class ListAudit implements Audit {
        final List<String> lines = new ArrayList<>();

        @Override
        public void refused(String who, int count) {
            lines.add(who + "@" + count);
        }
    }

    // ===== Your code =====

    static final class Counter {
        // region state
        private int count;
        // endregion

        Counter(int limit, Audit audit) {
            // TODO stage 2: keep the limit and the audit
        }

        // region hit
        /** Counts one call. Returns false when the call is refused. */
        boolean hit(String who) {
            count++;
            return true;
        }
        // endregion

        // region count
        int count() {
            return count;
        }
        // endregion
    }

    // ===== Tests: set STAGE to run more =====

    static final int STAGE = 1;

    static int failed = 0;
    static int stagePassed = 0;
    static int stageTotal = 0;

    public static void main(String[] args) {
        if (STAGE >= 1) stage1();
        if (STAGE >= 2) stage2();
        System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
    }

    // Stage 1: count every call to hit, starting from zero. Every call
    // is let through for now.
    static void stage1() {
        check("a new counter is at zero",
                () -> new Counter(3, new ListAudit()).count(), 0);
        check("each hit adds one", () -> {
            var c = new Counter(3, new ListAudit());
            c.hit("ann");
            c.hit("bob");
            return c.count();
        }, 2);
        check("a hit under the limit is let through",
                () -> new Counter(3, new ListAudit()).hit("ann"), true);
        endStage(1);
    }

    // Stage 2: the counter takes a limit. Once the count reaches it,
    // refuse the call, do not count it, and report it to the audit.
    static void stage2() {
        check("the call after the limit is refused", () -> {
            var c = new Counter(2, new ListAudit());
            c.hit("ann");
            c.hit("ann");
            return c.hit("ann");
        }, false);
        check("a refused call is not counted", () -> {
            var c = new Counter(1, new ListAudit());
            c.hit("ann");
            c.hit("bob");
            return c.count();
        }, 1);
        check("a refused call is reported", () -> {
            var audit = new ListAudit();
            var c = new Counter(1, audit);
            c.hit("ann");
            c.hit("bob");
            return audit.lines;
        }, List.of("bob@1"));
        check("a limit of zero refuses the first call",
                () -> new Counter(0, new ListAudit()).hit("ann"), false);
        endStage(2);
    }

    static void check(String name, Supplier<Object> run, Object want) {
        stageTotal++;
        try {
            Object got = run.get();
            if (Objects.equals(got, want)) {
                stagePassed++;
                System.out.println("PASS " + name);
            } else {
                failed++;
                System.out.println("FAIL " + name + ": expected " + want
                        + ", got " + got);
            }
        } catch (RuntimeException e) {
            failed++;
            System.out.println("FAIL " + name + ": threw " + e);
        }
    }

    static void endStage(int n) {
        System.out.println("Stage " + n + ": " + stagePassed + "/"
                + stageTotal + " passed");
        stagePassed = 0;
        stageTotal = 0;
    }
}
