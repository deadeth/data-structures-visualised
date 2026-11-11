import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Two Kafka sources, a keyed counter and three sinks. */
public class StreamCheckpoints {
    /** A log sink, an upsert table and a two-phase sink. */
    static final int SINKS = 3;

    /** One result: a key and its count. */
    public record Result(int key, int count) {}

    /** What checkpoint storage keeps for one checkpoint. */
    static class Checkpoint {
        final int id;
        final int[] offsets; // where each source will resume
        Map<Integer, Integer> counts = new HashMap<>(); // at the barrier
        List<Result> txn = new ArrayList<>(); // pre-committed results
        int acks;

        Checkpoint(int id, int sources) {
            this.id = id;
            this.offsets = new int[sources];
        }
    }

    final List<List<Integer>> logs; // kept, so replayable by offset
    final int tasks;
    boolean running = true;
    int[] offsets; // in memory: lost in a crash
    Map<Integer, Integer> counts = new HashMap<>(); // in memory too
    Checkpoint done; // last completed checkpoint
    int nextId = 1;
    final List<Result> appended = new ArrayList<>(); // at-least-once sink
    final Map<Integer, Integer> table = new HashMap<>(); // idempotent
    List<Result> txn = new ArrayList<>(); // two-phase: open transaction
    final List<Result> committed = new ArrayList<>(); // two-phase: visible

    public StreamCheckpoints(List<List<Integer>> logs) {
        this.logs = logs;
        this.tasks = logs.size() + 1 + SINKS;
        this.offsets = new int[logs.size()];
        this.done = new Checkpoint(0, logs.size());
    }

    // region process
    /** Carries the next record of partition p through the job. */
    public Integer process(int p) {
        if (!running) { //@down
            return null; //@down
        }
        int key = logs.get(p).get(offsets[p]); //@read
        offsets[p]++; //@read
        return count(key); //@emit
    }
    // endregion

    // region count
    /** Count: adds one for the key, then hands the result on. */
    int count(int key) {
        int n = counts.getOrDefault(key, 0) + 1; //@count
        counts.put(key, n); //@count
        appended.add(new Result(key, n)); //@sink
        table.put(key, n); //@sink
        txn.add(new Result(key, n)); //@sink
        return n;
    }
    // endregion

    // region checkpoint
    /** Takes a checkpoint with barriers. Returns its id, or null. */
    public Integer checkpoint() {
        if (!running) { //@down
            return null; //@down
        }
        Checkpoint chk = new Checkpoint(nextId, logs.size()); //@trigger
        nextId++; //@trigger
        for (int p = 0; p < logs.size(); p++) { //@inject
            chk.offsets[p] = offsets[p]; //@inject
            chk.acks++; //@inject
        }
        int seen = 1; // the barrier from source 0 is first at Count //@first
        // Count holds channel 0. Source 0 keeps reading meanwhile.
        int held = logs.get(0).get(offsets[0]); //@hold
        offsets[0]++; //@hold
        seen++; // then the barrier from source 1 //@align
        if (seen == logs.size()) { //@align
            chk.counts = new HashMap<>(counts); //@snapshot
            chk.acks++; //@snapshot
        }
        chk.txn = txn; //@precommit
        txn = new ArrayList<>(); //@precommit
        chk.acks += SINKS; //@precommit
        count(held); //@release
        if (chk.acks == tasks) { //@complete
            done = chk; //@complete
            committed.addAll(chk.txn); //@commit
        }
        return chk.id; //@finish
    }
    // endregion

    // region crash
    /** A task fails. Every task restarts, so memory is lost. */
    public void crash() {
        running = false; //@lost
        offsets = null; //@lost
        counts = null; //@lost
    }
    // endregion

    // region recover
    /** Restarts from the last completed checkpoint. */
    public boolean recover() {
        if (running) { //@up
            return false; //@up
        }
        Checkpoint chk = done; //@restore
        counts = new HashMap<>(chk.counts); //@restore
        offsets = chk.offsets.clone(); //@rewind
        txn = new ArrayList<>(); //@abort
        running = true; //@resume
        return true; //@resume
    }
    // endregion
}
