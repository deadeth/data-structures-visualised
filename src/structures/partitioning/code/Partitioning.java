import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Rows split by key range or by hash, indexed by city. */
public class Partitioning {
    static final String[] CITIES = {"Lima", "Oslo", "Rome"};
    static final int SPLIT_MIN = 4; // fewer rows is not worth splitting

    /** A slice of the table, with a local index on city. */
    static class Partition {
        final int lo; // smallest key it owns (range scheme only)
        int node;
        final TreeMap<Integer, String> rows = new TreeMap<>();
        final Map<String, List<Integer>> index = new TreeMap<>();

        Partition(int lo, int node) {
            this.lo = lo;
            this.node = node;
        }
    }

    final boolean hashed;
    final boolean local;
    int nodes;
    final List<Partition> parts = new ArrayList<>();
    final String[] terms; // first letter of each index partition
    final List<Map<String, List<Integer>>> glob = new ArrayList<>();

    public Partitioning(boolean hashed, boolean local, int nodes,
                        int[] bounds, String[] terms) {
        this.hashed = hashed;
        this.local = local;
        this.nodes = nodes;
        if (hashed) {
            // Fixed for the life of the table: two per starting node.
            for (int p = 0; p < 2 * nodes; p++) {
                parts.add(new Partition(-1, p % nodes));
            }
        } else {
            for (int i = 0; i < bounds.length; i++) {
                parts.add(new Partition(bounds[i], i));
            }
        }
        this.terms = terms;
        for (String ignored : terms) {
            glob.add(new TreeMap<>()); // index partition i is on node i
        }
    }

    static void add(Map<String, List<Integer>> index, String term, int key) {
        List<Integer> keys = index.computeIfAbsent(term, t -> new ArrayList<>());
        int at = 0;
        while (at < keys.size() && keys.get(at) < key) {
            at++;
        }
        keys.add(at, key);
    }

    static void drop(Map<String, List<Integer>> index, String term, int key) {
        List<Integer> keys = index.get(term);
        keys.remove(Integer.valueOf(key));
        if (keys.isEmpty()) {
            index.remove(term);
        }
    }

    // region route
    /** The partition that owns key. */
    Partition route(int key) {
        if (hashed) {
            int h = (37 * key + 11) % 100; //@hash
            return parts.get(h % parts.size()); //@mod
        }
        for (int i = 0; i < parts.size() - 1; i++) {
            if (key < parts.get(i + 1).lo) { //@boundary
                return parts.get(i); //@boundary
            }
        }
        return parts.get(parts.size() - 1); //@last
    }
    // endregion

    // region term_part
    /** The global index partition that owns a city. */
    int termPart(String city) {
        for (int i = 0; i < terms.length - 1; i++) {
            if (city.compareTo(terms[i + 1]) < 0) { //@term_cmp
                return i; //@term_cmp
            }
        }
        return terms.length - 1; //@term_last
    }
    // endregion

    // region put
    /** Stores a row and indexes it by city. */
    public boolean put(int key, String city) {
        Partition part = route(key); //@route
        if (part.rows.containsKey(key)) {
            return false; //@exists
        }
        part.rows.put(key, city); //@write
        if (local) {
            add(part.index, city, key); //@local
        } else {
            int g = termPart(city); //@term
            // A real store sends this asynchronously.
            add(glob.get(g), city, key); //@global
        }
        return true; //@done
    }
    // endregion

    // region get
    /** The city of key, or null. */
    public String get(int key) {
        Partition part = route(key); //@route
        return part.rows.get(key); //@lookup
    }
    // endregion

    // region scan
    /** Keys from lo to hi inclusive, in order. */
    public List<Integer> scan(int lo, int hi) {
        List<Integer> found = new ArrayList<>();
        if (hashed) {
            for (Partition part : parts) { //@scatter
                found.addAll(part.rows.subMap(lo, true, hi, true).keySet()); //@scatter
            }
            found.sort(null); //@gather
            return found; //@gather
        }
        int i = parts.indexOf(route(lo)); //@first
        while (true) {
            Partition part = parts.get(i);
            found.addAll(part.rows.subMap(lo, true, hi, true).keySet()); //@collect
            i++;
            if (i == parts.size() || parts.get(i).lo > hi) { //@next_part
                return found; //@done_scan
            }
        }
    }
    // endregion

    // region find
    /** Keys of the rows in city, in order. */
    public List<Integer> find(String city) {
        if (local) {
            List<Integer> found = new ArrayList<>();
            for (Partition part : parts) { //@ask_local
                found.addAll(part.index.getOrDefault(city, List.of())); //@ask_local
            }
            found.sort(null); //@merge
            return found; //@merge
        }
        int g = termPart(city); //@term
        return new ArrayList<>(glob.get(g).getOrDefault(city, List.of())); //@postings
    }
    // endregion

    // region hot
    /** Timestamps as keys: each one more than the last. */
    public void writeEvents(int start, int count) {
        for (int t = start; t < start + count; t++) {
            put(t, CITIES[t % 3]); //@sequential
        }
    }

    /** The sensor number leads and the time follows. */
    public void writePrefixed(int time, int[] sensors) {
        for (int i = 0; i < sensors.length; i++) {
            int key = sensors[i] * 100 + time % 100; //@prefix
            put(key, CITIES[i]); //@spread
        }
    }
    // endregion

    // region rebalance
    /** Maybe adds a node, then evens out the load. */
    public void rebalance(boolean join) {
        if (join) {
            nodes++; //@join
        }
        if (!hashed) {
            split(); //@split_call
        } else {
            movePartitions(); //@move_call
        }
    }
    // endregion

    // region split
    /** Splits the fullest range partition at its median. */
    Partition split() {
        Partition part = parts.get(0);
        for (Partition p : parts) {
            if (p.rows.size() > part.rows.size()) { //@fullest
                part = p; //@fullest
            }
        }
        if (part.rows.size() < SPLIT_MIN) {
            return null; //@fullest
        }
        int node = leastLoaded(); //@pick_node
        List<Integer> keys = new ArrayList<>(part.rows.keySet());
        int mid = keys.get(keys.size() / 2); //@median
        Partition fresh = new Partition(mid, node); //@new_part
        for (int k : keys.subList(keys.size() / 2, keys.size())) {
            String city = part.rows.remove(k); //@move
            fresh.rows.put(k, city); //@move
            if (local) {
                drop(part.index, city, k); //@move
                add(fresh.index, city, k); //@move
            }
        }
        parts.add(parts.indexOf(part) + 1, fresh); //@new_part
        return fresh; //@done_split
    }
    // endregion

    // region least_loaded
    /** The node holding the fewest rows. */
    int leastLoaded() {
        int[] load = new int[nodes];
        for (Partition part : parts) {
            load[part.node] += part.rows.size();
        }
        int best = 0;
        for (int n = 1; n < nodes; n++) {
            if (load[n] < load[best]) {
                best = n;
            }
        }
        return best; //@pick_node
    }
    // endregion

    // region move_partitions
    /** Hands whole partitions from the busiest node to the idlest. */
    int movePartitions() {
        int moved = 0;
        while (true) {
            int[] count = new int[nodes];
            for (Partition part : parts) {
                count[part.node]++;
            }
            int busy = 0;
            int idle = 0;
            for (int n = 1; n < nodes; n++) {
                if (count[n] > count[busy]) busy = n;
                if (count[n] < count[idle]) idle = n;
            }
            if (count[busy] - count[idle] <= 1) { //@balanced
                return moved; //@balanced
            }
            Partition last = null;
            for (Partition p : parts) {
                if (p.node == busy) last = p;
            }
            // Only the owner changes: no key is hashed again.
            last.node = idle; //@steal
            moved++; //@steal
        }
    }
    // endregion
}
