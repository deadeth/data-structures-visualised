import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/** Leaderless replication with read and write quorums. */
public class Quorum {
    /** A value and the version it was written with. */
    public record Versioned(Integer value, long version) {}

    /** Fewer than R replicas answered. */
    public static class QuorumFailed extends RuntimeException {}

    /** One copy of the data. */
    static class Replica {
        boolean up = true;
        final Map<Integer, Versioned> data = new HashMap<>();

        Versioned get(int key) {
            return data.getOrDefault(key, new Versioned(null, 0));
        }
    }

    private final List<Replica> replicas = new ArrayList<>();
    private final int n;
    private int w;
    private int r;
    private long clock; // stands in for a write timestamp

    public Quorum(int n, int w, int r) {
        for (int i = 0; i < n; i++) {
            replicas.add(new Replica());
        }
        this.n = n;
        this.w = w;
        this.r = r;
    }

    private long version(int i, int key) {
        return replicas.get(i).get(key).version();
    }

    // region write
    /** Sends to every replica. Succeeds on W acks. */
    public boolean write(int key, int value) {
        long version = ++clock; //@send
        int acks = 0;
        for (Replica rep : replicas) {
            if (!rep.up) {
                continue; //@skip
            }
            long have = rep.get(key).version();
            if (version > have) { //@newer
                rep.data.put(key, new Versioned(value, version)); //@store
            }
            acks++; //@store
        }
        // A failed write is not undone where it landed.
        return acks >= w; //@quorum
    }
    // endregion

    // region read
    /** Asks every replica. Answers from the first R replies. */
    public Integer read(int key, int first) {
        List<Integer> replies = new ArrayList<>();
        for (int k = 0; k < n; k++) { //@ask
            int i = (first + k) % n; // order replies arrive in
            if (replicas.get(i).up) { //@reply
                replies.add(i); //@reply
            }
            if (replies.size() == r) {
                break;
            }
        }
        if (replies.size() < r) { //@enough
            throw new QuorumFailed(); //@fail
        }
        int best = replies.get(0);
        for (int i : replies.subList(1, replies.size())) {
            if (version(i, key) > version(best, key)) { //@newest
                best = i; //@newest
            }
        }
        Versioned newest = replicas.get(best).get(key); //@answer
        for (int i : replies) { // read repair
            if (version(i, key) < newest.version()) { //@stale
                replicas.get(i).data.put(key, newest); //@repair
            }
        }
        return newest.value(); //@answer
    }
    // endregion

    // region down
    /** The replica stops answering. Its data stays. */
    public void down(int i) {
        replicas.get(i).up = false; //@stop
    }
    // endregion

    // region up
    /** Back with what it held: stale until repaired. */
    public void up(int i) {
        replicas.get(i).up = true; //@start
    }
    // endregion

    // region repair
    /** Anti-entropy: copies the newer version each way. */
    public void repair(int a, int b) {
        Replica ra = replicas.get(a);
        Replica rb = replicas.get(b);
        TreeSet<Integer> keys = new TreeSet<>(ra.data.keySet());
        keys.addAll(rb.data.keySet());
        for (int key : keys) { //@each_key
            Versioned va = ra.get(key);
            Versioned vb = rb.get(key);
            if (va.version() < vb.version()) { //@compare
                ra.data.put(key, vb); //@copy
            } else if (vb.version() < va.version()) { //@compare
                rb.data.put(key, va); //@copy
            }
        }
        // Real systems compare Merkle trees first.
    }
    // endregion

    // region tune
    /** New quorum sizes. Cassandra takes them per request. */
    public boolean tune(int w, int r) {
        if (w < 1 || w > n || r < 1 || r > n) {
            throw new IllegalArgumentException("W and R must be 1 to N");
        }
        this.w = w; //@set
        this.r = r; //@set
        return this.r + this.w > n; //@rule
    }
    // endregion

    public boolean isUp(int i) {
        return replicas.get(i).up;
    }

    public Versioned peek(int i, int key) {
        return replicas.get(i).get(key);
    }
}
