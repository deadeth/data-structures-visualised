import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A payment saga: orchestrated, or choreographed by events. */
public class Saga {
    /** One step: a service, its action and how to undo it. */
    record Step(String service, String action, String undo) {}

    static final List<Step> STEPS = List.of(
        new Step("ledger", "reserve", "release"),
        new Step("limits", "hold", "unhold"),
        new Step("gateway", "submit", null), // the pivot: no way back
        new Step("ledger", "post", null)); // after it: retry, never undo

    /** A business rule said no. The local transaction rolled back. */
    static class Refused extends RuntimeException {}

    /** The service is down. Nothing ran. */
    static class Unavailable extends RuntimeException {}

    /** Another saga's hold is in the way. Try again later. */
    static class Pending extends RuntimeException {}

    /** The page's way to stop the orchestrator mid-saga. */
    static class Crash extends RuntimeException {}

    /** A service with its own database and local transactions. */
    abstract static class Service {
        final Map<String, String> replies = new HashMap<>(); // key -> reply
        boolean refuse; // page switch: refuse the next command
        int down; // page switch: calls to drop

        abstract String apply(String action, String saga, long amount);

        // region handle
        /** Runs each key at most once, in one local transaction. */
        String handle(String key, String action, String saga, long amount) {
            if (down > 0) { //@down
                down--; //@down
                throw new Unavailable(); //@down
            }
            if (replies.containsKey(key)) { //@dedupe
                return replies.get(key); // no second effect //@dedupe
            }
            if (refuse) { //@refuse
                refuse = false; //@refuse
                throw new Refused(); // rolled back //@refuse
            }
            String reply = apply(action, saga, amount); //@local
            replies.put(key, reply); // same transaction //@local
            return reply; //@reply
        }
        // endregion
    }

    /** The payer's balance, with a hold per saga in flight. */
    static class Ledger extends Service {
        long balance;
        final Map<String, Long> holds = new HashMap<>(); // semantic locks

        Ledger(long balance) {
            this.balance = balance;
        }

        String apply(String action, String saga, long amount) {
            return switch (action) {
                case "reserve" -> reserve(saga, amount);
                case "release" -> release(saga);
                default -> post(saga);
            };
        }

        // region ledger
        /** Holds the money. Others see it as pending. */
        String reserve(String saga, long amount) {
            long held = holds.values().stream().mapToLong(x -> x).sum();
            long free = balance - held; //@free
            if (free >= amount) { //@check
                holds.put(saga, amount); //@reserved
                return "reserved"; //@reserved
            }
            if (free + held >= amount) { // only holds in the way //@pending
                throw new Pending(); //@pending
            }
            throw new Refused(); // insufficient funds //@insufficient
        }

        /** Compensation: drops the hold. */
        String release(String saga) {
            holds.remove(saga); //@release
            return "released"; //@release
        }

        /** Turns the hold into a debit. Cannot refuse. */
        String post(String saga) {
            balance -= holds.remove(saga); //@post
            return "posted"; //@post
        }
        // endregion
    }

    /** How much of today's payment limit is used. */
    static class Limits extends Service {
        final long limit;
        long used;
        final Map<String, Long> holds = new HashMap<>();

        Limits(long limit) {
            this.limit = limit;
        }

        String apply(String action, String saga, long amount) {
            return action.equals("hold") ? hold(saga, amount) : unhold(saga);
        }

        // region limits
        /** Counts the payment against today's limit. */
        String hold(String saga, long amount) {
            if (used + amount > limit) { //@limit_check
                throw new Refused(); // over the daily limit //@over_limit
            }
            used += amount; //@held
            holds.put(saga, amount); //@held
            return "held"; //@held
        }

        /** Compensation: gives the limit back. */
        String unhold(String saga) {
            used -= holds.getOrDefault(saga, 0L); //@unheld
            holds.remove(saga); //@unheld
            return "returned"; //@unheld
        }
        // endregion
    }

    /** Submits payments to the scheme. Accepted is final. */
    static class Gateway extends Service {
        final Map<String, Long> sent = new HashMap<>();

        String apply(String action, String saga, long amount) {
            return submit(saga, amount);
        }

        // region gateway
        /** The pivot: once accepted, the money has gone. */
        String submit(String saga, long amount) {
            sent.put(saga, amount); //@submitted
            return "accepted"; //@submitted
        }
        // endregion
    }

    /** One saga's row in the saga log. */
    static final class Row {
        final long amount;
        int done;
        String state = "running";

        Row(long amount) {
            this.amount = amount;
        }

        boolean live() {
            return state.equals("running") || state.equals("compensating");
        }
    }

    /** Drives sagas. The only memory that matters is the saga log. */
    static class Orchestrator {
        final Map<String, Service> services; // name -> service
        final Map<String, Row> log; // on disk: survives a crash
        final Set<String> lost = new HashSet<>(); // page switch
        String crashAfter; // page switch: die after this key
        int retries;

        Orchestrator(Map<String, Service> services, Map<String, Row> log) {
            this.services = services;
            this.log = log;
        }

        // region start
        /** Writes the saga's row before doing anything else. */
        void start(String saga, long amount) {
            log.put(saga, new Row(amount)); //@begin
            run(saga); //@run
        }
        // endregion

        // region run
        /** Takes steps until the saga ends or has to wait. */
        void run(String saga) {
            while (log.get(saga).live()) { //@loop
                step(saga); //@loop
            }
        }
        // endregion

        // region step
        /** Does the next action, or undoes the newest one. */
        void step(String saga) {
            Row row = log.get(saga); //@read
            if (row.state.equals("compensating")) { //@read
                compensate(saga); //@to_comp
                return; //@to_comp
            }
            int i = row.done; //@read
            Step s = STEPS.get(i);
            String key = saga + "-" + (i + 1); // same on every retry //@key
            try {
                call(s.service(), key, s.action(), saga); //@send
            } catch (Refused e) { // only before the pivot //@failed
                row.state = "compensating"; // on disk //@failed
                return; //@failed
            } catch (Pending e) { //@park
                row.state = "waiting"; // on disk //@park
                return; //@park
            }
            row.done = i + 1; // on disk: progress //@record
            if (row.done == STEPS.size()) { //@record
                row.state = "completed"; //@completed
            }
        }
        // endregion

        // region compensate
        /** Undoes the newest step still in effect, then records it. */
        void compensate(String saga) {
            Row row = log.get(saga);
            int i = row.done - 1; // newest step in effect //@undo_next
            if (i < 0) { //@undo_next
                row.state = "compensated"; // on disk //@compensated
                return; //@compensated
            }
            Step s = STEPS.get(i);
            String key = saga + "-undo-" + (i + 1); //@undo_key
            call(s.service(), key, s.undo(), saga); // until done //@undo_send
            row.done = i; // on disk //@undo_record
        }
        // endregion

        // region call
        /** Sends a command. On silence, sends it again: same key. */
        String call(String name, String key, String action, String saga) {
            long amount = log.get(saga).amount;
            while (true) {
                String reply;
                try {
                    reply = services.get(name) //@send_cmd
                        .handle(key, action, saga, amount); //@send_cmd
                } catch (Unavailable e) { //@timeout
                    retries++; // real code backs off //@timeout
                    continue; //@timeout
                }
                if (key.equals(crashAfter)) { // page switch //@crash
                    throw new Crash(); // dies before it records //@crash
                }
                if (lost.remove(key)) { // the reply never arrives //@lost
                    retries++; //@lost
                    continue; //@lost
                }
                return reply; //@got
            }
        }
        // endregion

        // region recover
        /** After a restart: resumes what the log says is unfinished. */
        void recover() {
            for (var e : log.entrySet()) { //@scan
                if (e.getValue().live()) { //@unfinished
                    run(e.getKey()); //@resume
                }
            }
        }
        // endregion

        // region retry_waiting
        /** Tries parked sagas again once the holds have cleared. */
        void retryWaiting() {
            for (var e : log.entrySet()) {
                if (e.getValue().state.equals("waiting")) { //@parked
                    e.getValue().state = "running"; //@unpark
                    run(e.getKey()); //@unpark
                }
            }
        }
        // endregion
    }

    /** What a service does on an event, and what it publishes next. */
    record Reaction(String service, String action, String done,
                    String refused) {}

    static final Map<String, Reaction> REACTIONS = Map.of(
        "requested", new Reaction("ledger", "reserve", "reserved", "failed"),
        "reserved", new Reaction("limits", "hold", "held", "over_limit"),
        "held", new Reaction("gateway", "submit", "accepted", "rejected"),
        "accepted", new Reaction("ledger", "post", "posted", null),
        "over_limit", new Reaction("ledger", "release", "failed", null),
        "rejected", new Reaction("limits", "unhold", "returned", null),
        "returned", new Reaction("ledger", "release", "failed", null));

    /** An event on the broker. */
    record Event(String name, String saga, long amount) {}

    /** No coordinator: each service reacts to the event before. */
    static class Choreography {
        final Map<String, Service> services;
        final Deque<Event> queue = new ArrayDeque<>(); // the broker

        Choreography(Map<String, Service> services) {
            this.services = services;
        }

        // region chor_start
        /** Publishes the request. Nobody keeps a saga row. */
        void start(String saga, long amount) {
            queue.add(new Event("requested", saga, amount)); //@request
            drain(); //@request
        }

        /** Delivers events until none are left. */
        void drain() {
            while (!queue.isEmpty()) { //@deliver
                deliver(); //@deliver
            }
        }
        // endregion

        // region react
        /** One service takes one event: a local txn, then an event. */
        void deliver() {
            Event ev = queue.poll(); //@listener
            Reaction r = REACTIONS.get(ev.name()); //@listener
            if (r == null) { // posted or failed: the end //@end
                return; //@end
            }
            String key = ev.saga() + "-" + ev.name(); // deduplicated //@ev_key
            String next;
            try {
                services.get(r.service()) //@ev_local
                    .handle(key, r.action(), ev.saga(), ev.amount()); //@ev_local
                next = r.done(); //@ev_done
            } catch (Refused e) { //@ev_refused
                next = r.refused(); //@ev_refused
            }
            queue.add(new Event(next, ev.saga(), ev.amount())); // outbox //@emit
        }
        // endregion
    }

    /** The three services, by name. */
    static Map<String, Service> world(long balance, long limit) {
        Map<String, Service> m = new LinkedHashMap<>();
        m.put("ledger", new Ledger(balance));
        m.put("limits", new Limits(limit));
        m.put("gateway", new Gateway());
        return m;
    }
}
