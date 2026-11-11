import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Two-phase commit: one coordinator, a few participants. */
public class TwoPhaseCommit {
    /** One durable log record, such as ("prepared", 4). */
    public record Entry(String kind, int txn) {}

    /** A row is locked by a transaction that is still in doubt. */
    public static class Blocked extends RuntimeException {
        Blocked(String name) {
            super(name);
        }
    }

    static String done(String decision) {
        return decision.equals("commit") ? "committed" : "aborted";
    }

    /** One database that does a part of every transaction. */
    public static class Participant {
        final String name;
        String state = "working";
        final Set<Integer> locks = new HashSet<>(); // lost in a crash
        final List<Entry> log = new ArrayList<>(); // survives a crash
        boolean up = true;
        boolean refuse = false; // vote no at the next prepare

        Participant(String name) {
            this.name = name;
        }

        // region begin
        /** Do txn's write here, under a lock on the row. */
        void begin(int txn) {
            if (!locks.isEmpty()) { //@wait
                throw new Blocked(name); // a real lock would queue //@wait
            }
            locks.add(txn); //@lock
            state = "working"; //@lock
        }
        // endregion

        // region prepare
        /** Phase 1: vote. Null means no answer came back. */
        Boolean prepare(int txn) {
            if (!up) { //@silent
                return null; // the coordinator times out //@silent
            }
            if (refuse) { // say a constraint check failed //@refuse
                refuse = false;
                log.add(new Entry("abort", txn)); //@refuse
                locks.remove(txn); //@refuse
                state = "aborted"; //@refuse
                return false; //@refuse
            }
            log.add(new Entry("prepared", txn)); // forced to disk //@prepared
            state = "prepared"; // in doubt until told //@prepared
            return true; //@prepared
        }
        // endregion

        // region finish
        /** Phase 2: apply the decision, unlock, ack. */
        boolean finish(int txn, String decision) {
            if (!up) { //@down
                return false; // no ack: the coordinator retries //@down
            }
            Entry e = new Entry(decision, txn);
            if (!log.contains(e)) { // idempotent //@apply
                log.add(e); //@apply
            }
            locks.remove(txn); //@release
            state = done(decision); //@release
            return true; //@release
        }
        // endregion

        /** Memory is lost: state and locks. The log is not. */
        void crash() {
            up = false;
            locks.clear();
        }

        /** Transactions prepared here with no decision after. */
        List<Integer> inDoubt() {
            Set<Integer> decided = new HashSet<>();
            for (Entry e : log) {
                if (!e.kind().equals("prepared")) {
                    decided.add(e.txn());
                }
            }
            List<Integer> out = new ArrayList<>();
            for (Entry e : log) {
                if (e.kind().equals("prepared") && !decided.contains(e.txn())) {
                    out.add(e.txn());
                }
            }
            return out;
        }

        // region restart
        /** Come back from the log, then ask what is in doubt. */
        void restart(Coordinator coordinator) {
            up = true; //@restart
            List<Integer> doubt = inDoubt(); //@scan
            if (doubt.isEmpty()) { //@scan
                state = "aborted"; // unvoted work rolls back //@undo
            }
            for (int txn : doubt) {
                locks.add(txn); // the record says what to lock //@relock
                state = "prepared"; //@relock
            }
            resolve(coordinator); //@resolve
        }
        // endregion

        // region resolve
        /** Ask how each in-doubt transaction ended. */
        void resolve(Coordinator coordinator) {
            for (int txn : inDoubt()) { //@doubt
                String decision = coordinator.ask(txn); //@ask
                if (decision == null) { // no answer //@block
                    continue; // cannot decide alone: keep the locks //@block
                }
                finish(txn, decision); //@learn
                coordinator.ack(txn, name); //@learn
            }
        }
        // endregion
    }

    /** Runs two-phase commit over a fixed set of participants. */
    public static class Coordinator {
        final List<Participant> participants;
        final List<Entry> log = new ArrayList<>(); // survives a crash
        // txn -> names yet to ack; in memory
        Map<Integer, Set<String>> waiting = new HashMap<>();
        boolean up = true;

        Coordinator(List<Participant> participants) {
            this.participants = participants;
        }

        // region commit
        /** Run txn at every participant: all or nothing. */
        String commit(int txn) {
            for (Participant p : participants) { //@begin
                p.begin(txn); //@begin
            }
            String decision = phaseOne(txn); //@phase_one
            log.add(new Entry(decision, txn)); // forced to disk //@decide
            phaseTwo(txn, decision); //@phase_two
            return decision; //@done
        }
        // endregion

        // region phase_one
        /** Ask everyone to prepare, then count the yes votes. */
        String phaseOne(int txn) {
            int yes = 0;
            // Sent to all at once in practice; one by one here.
            for (Participant p : participants) { //@send_prepare
                // null (timed out) counts as no
                if (Boolean.TRUE.equals(p.prepare(txn))) { //@vote
                    yes++; //@vote
                }
            }
            if (yes == participants.size()) { //@count
                return "commit"; //@count
            }
            return "abort"; //@count
        }
        // endregion

        // region phase_two
        /** Send the decision. Keep a commit until all ack. */
        void phaseTwo(int txn, String decision) {
            Set<String> missing = new HashSet<>();
            for (Participant p : participants) { //@send
                if (!p.finish(txn, decision)) { //@send
                    missing.add(p.name); //@missing
                }
            }
            if (decision.equals("abort")) { //@no_acks
                return; // presumed abort: nothing to keep //@no_acks
            }
            if (!missing.isEmpty()) { //@acks
                waiting.put(txn, missing); // retry until they ack //@missing
            } else {
                log.add(new Entry("end", txn)); // may forget txn //@end
            }
        }
        // endregion

        // region ack
        /** A late ack, from a participant that restarted. */
        void ack(int txn, String name) {
            Set<String> missing = waiting.get(txn);
            if (missing == null) { // an abort, or already ended
                return;
            }
            missing.remove(name); //@late_ack
            if (missing.isEmpty()) { //@late_ack
                waiting.remove(txn);
                log.add(new Entry("end", txn)); //@late_end
            }
        }
        // endregion

        // region ask
        /** Tell a participant in doubt how txn ended. */
        String ask(int txn) {
            if (!up) { //@no_answer
                return null; //@no_answer
            }
            for (Entry e : log) { //@lookup
                if (e.txn() == txn && !e.kind().equals("end")) { //@lookup
                    return e.kind(); //@known
                }
            }
            return "abort"; // no record: presumed abort //@presumed
        }
        // endregion

        // region recover
        /** Restart: finish each commit the log has not ended. */
        void recover() {
            if (up) { //@running
                return; //@running
            }
            up = true; //@reboot
            Set<Integer> ended = new HashSet<>();
            for (Entry e : log) {
                if (e.kind().equals("end")) {
                    ended.add(e.txn());
                }
            }
            for (Entry e : List.copyOf(log)) { //@replay
                if (e.kind().equals("commit") && !ended.contains(e.txn())) { //@found
                    phaseTwo(e.txn(), "commit"); //@found
                }
            }
            // Anyone still in doubt asks, and hears abort.
            for (Participant p : participants) { //@asked
                p.resolve(this); //@asked
            }
        }
        // endregion

        // region vote_no
        /** Run txn with one participant refusing to prepare. */
        String commitWithNo(int txn, Participant voter) {
            voter.refuse = true; //@arm
            return commit(txn); //@run
        }
        // endregion

        // region crash_participant
        /** Run txn while one participant fails in phase 1. */
        String commitWithCrash(int txn, Participant victim, boolean afterVote) {
            for (Participant p : participants) { //@begin
                p.begin(txn); //@begin
            }
            if (!afterVote) {
                victim.crash(); // before it can vote //@crash
            }
            String decision = phaseOne(txn); //@phase_one
            if (afterVote) {
                victim.crash(); // its yes vote was already sent //@crash
            }
            log.add(new Entry(decision, txn)); // forced to disk //@decide
            phaseTwo(txn, decision); //@phase_two
            victim.restart(this); //@restart_victim
            return decision; //@done
        }
        // endregion

        // region crash_coordinator
        /** Collect the votes, then fail before sending any. */
        void crashAfterVotes(int txn, boolean logged) {
            for (Participant p : participants) { //@begin
                p.begin(txn); //@begin
            }
            String decision = phaseOne(txn); //@phase_one
            if (logged) { //@logged
                log.add(new Entry(decision, txn)); //@decide
            }
            up = false; // memory is gone; the log is not //@crash
            waiting = new HashMap<>(); //@crash
            for (Participant p : participants) { //@wait_out
                p.resolve(this); // each times out and asks //@wait_out
            }
        }
        // endregion
    }
}
