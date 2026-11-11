import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Replicas that accept writes alone and converge when they merge. */
public class Crdt {
    static final String NAMES = "ABC";

    /** A tag no other add can have: a replica and its sequence number. */
    record Dot(char replica, int seq) {}

    /** One replica: a PN-counter and an add-wins observed-remove set. */
    static final class Replica {
        final int me;
        final int[] p = new int[NAMES.length()]; // increments, per replica
        final int[] n = new int[NAMES.length()]; // decrements, per replica
        int seq; // number of this replica's last dot
        final Map<Dot, Integer> entries = new LinkedHashMap<>();
        final Set<Dot> removed = new HashSet<>(); // tombstones

        Replica(int me) {
            this.me = me;
        }

        // region inc
        /** Counts one increment, in this replica's own slot. */
        void inc() {
            p[me]++; //@inc
        }
        // endregion

        // region dec
        /** Counts one decrement, in this replica's own slot. */
        void dec() {
            n[me]++; //@dec
        }
        // endregion

        // region value
        /** Reads the counter. */
        int value() {
            int total = 0;
            for (int r = 0; r < p.length; r++) {
                total += p[r] - n[r]; //@value
            }
            return total; //@value
        }
        // endregion

        // region add
        /** Adds under a dot no other replica can make. */
        void add(int element) {
            seq++; //@dot
            Dot dot = new Dot(NAMES.charAt(me), seq); //@dot
            entries.put(dot, element); //@store
        }
        // endregion

        // region remove
        /** Tombstones every live dot of element seen here. */
        void remove(int element) {
            for (var e : entries.entrySet()) { //@scan
                Dot dot = e.getKey();
                if (e.getValue() == element && !removed.contains(dot)) { //@test
                    removed.add(dot); //@tomb
                }
            }
        }
        // endregion

        // region read
        /** Reads the set: elements with a live dot. */
        Set<Integer> elements() {
            Set<Integer> out = new HashSet<>();
            for (var e : entries.entrySet()) {
                if (!removed.contains(e.getKey())) {
                    out.add(e.getValue()); //@read
                }
            }
            return out; //@read
        }
        // endregion

        // region merge
        /** Joins other's state into this one. */
        void merge(Replica other) {
            for (int r = 0; r < p.length; r++) { //@start
                if (other.p[r] > p[r]) { //@max_p
                    p[r] = other.p[r]; //@take_p
                }
            }
            for (int r = 0; r < n.length; r++) {
                if (other.n[r] > n[r]) { //@max_n
                    n[r] = other.n[r]; //@take_n
                }
            }
            for (var e : other.entries.entrySet()) {
                Dot dot = e.getKey();
                if (!entries.containsKey(dot)) { //@has
                    entries.put(dot, e.getValue()); //@copy
                }
                if (other.removed.contains(dot)) { //@gone
                    removed.add(dot); //@tomb_in
                }
            }
        }
        // endregion
    }

    // region sync
    /** Merges every replica into every other one. */
    static void sync(List<Replica> replicas) {
        for (Replica a : replicas) { //@pair
            for (Replica b : replicas) { //@pair
                if (a != b) { //@pair
                    a.merge(b); //@pair
                }
            }
        }
    }
    // endregion

    // region collect
    /** Drops dots that every replica has seen removed. */
    static void collect(List<Replica> replicas) {
        Replica first = replicas.get(0);
        for (Dot dot : List.copyOf(first.entries.keySet())) { //@each_tomb
            if (!first.removed.contains(dot)) { //@each_tomb
                continue;
            }
            boolean stable = true;
            for (Replica r : replicas) {
                stable &= r.removed.contains(dot); //@stable
            }
            if (stable) { //@stable
                for (Replica r : replicas) { //@drop
                    r.entries.remove(dot); //@drop
                    r.removed.remove(dot); //@drop
                }
            }
        }
    }
    // endregion
}
