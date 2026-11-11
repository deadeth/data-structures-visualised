import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Doctors on call, made serializable by 2PL or by SSI. */
public class TwoPhaseLocking {
    static final List<String> ROWS = List.of("alice", "bob");
    /** T3 belongs to no doctor. */
    static final Map<Integer, String> OWNER = Map.of(1, "alice", 2, "bob");

    enum State { ACTIVE, WAITING, COMMITTED, ABORTED }

    /** One committed version of a row. */
    record Version(int ts, int value, Txn writer) {}

    /** SSI: reader's view of row is wrong if writer commits. */
    record Mark(String row, Txn writer) {}

    /** 2PL: what a waiting transaction asked for. */
    record Request(int tid, String row, char mode, int value) {}

    /** One transaction's private bookkeeping. */
    static class Txn {
        final int id;
        final int snapshot; // SSI: the last commit it can see
        State state = State.ACTIVE;
        final Map<String, Integer> reads = new LinkedHashMap<>();
        final Map<String, Integer> writes = new LinkedHashMap<>();
        final List<Mark> stale = new ArrayList<>();
        Request pending; // 2PL: what it waits for

        Txn(int id, int snapshot) {
            this.id = id;
            this.snapshot = snapshot;
        }

        boolean open() {
            return state == State.ACTIVE || state == State.WAITING;
        }
    }

    /** 2PL: who holds one row, and who is queued for it. */
    static class Lock {
        final Set<Integer> shared = new TreeSet<>();
        Integer exclusive;
        final List<Request> queue = new ArrayList<>(); // oldest first
    }

    final String method;
    int clock; // commits so far
    final Map<String, List<Version>> versions = new HashMap<>();
    final Map<String, Lock> locks = new HashMap<>();
    final Map<Integer, Txn> txns = new LinkedHashMap<>();

    public TwoPhaseLocking(String method) {
        this.method = method;
        for (String row : ROWS) {
            versions.put(row, new ArrayList<>(List.of(new Version(0, 1, null))));
            locks.put(row, new Lock());
        }
    }

    // region begin
    /** Start t. Under SSI it sees the database as of now. */
    public boolean begin(int t) {
        Txn old = txns.get(t);
        if (old != null && old.open()) { //@open
            return false; //@open
        }
        txns.put(t, new Txn(t, clock)); //@begin
        return true;
    }
    // endregion

    // region read
    /** The value t sees, or null if t must wait. */
    public Integer read(int t, String row) {
        Txn tx = txns.get(t); //@txn
        if (tx.writes.containsKey(row)) { //@own
            return tx.writes.get(row); //@own
        }
        int value;
        if (method.equals("2PL")) {
            if (!acquire(tx, row, 'S', 0)) { //@lock_s
                return null; //@blocked
            }
            value = latest(row); //@latest
        } else {
            value = snapshotRead(tx, row); //@snap
        }
        tx.reads.put(row, value); //@record
        return value; //@record
    }
    // endregion

    // region write
    /** Buffer the new value. False if t must wait. */
    public boolean write(int t, String row, int value) {
        Txn tx = txns.get(t); //@txn
        if (method.equals("2PL")) {
            if (!acquire(tx, row, 'X', value)) { //@lock_x
                return false; //@blocked
            }
        } else {
            warnReaders(tx, row); //@warn
        }
        tx.writes.put(row, value); //@buffer
        return true; //@buffer
    }
    // endregion

    // region commit
    /** Validate (SSI), apply the writes, release (2PL). */
    public boolean commit(int t) {
        Txn tx = txns.get(t); //@txn
        if (method.equals("SSI") && !validate(tx)) { //@validate
            abort(t); //@fail
            return false; //@fail
        }
        clock++; //@apply
        for (var w : tx.writes.entrySet()) {
            Version v = new Version(clock, w.getValue(), tx);
            versions.get(w.getKey()).add(v); //@apply
        }
        tx.state = State.COMMITTED; //@committed
        if (method.equals("2PL")) {
            release(t); //@shrink
        }
        return true; //@committed
    }
    // endregion

    // region abort
    /** Throw away t's writes. Under 2PL, free its locks. */
    public void abort(int t) {
        Txn tx = txns.get(t); //@txn
        tx.state = State.ABORTED; //@abort
        tx.writes.clear(); //@abort
        tx.pending = null; //@abort
        if (method.equals("2PL")) {
            release(t); //@shrink
        }
    }
    // endregion

    // region acquire
    /** Take the lock now, or queue and look for deadlock. */
    boolean acquire(Txn tx, String row, char mode, int value) {
        Lock lock = locks.get(row);
        if (grantable(lock, tx.id, mode)) { //@test
            grant(lock, tx.id, mode); //@grant
            return true; //@grant
        }
        Request r = new Request(tx.id, row, mode, value);
        lock.queue.add(r); //@queue
        tx.state = State.WAITING; //@queue
        tx.pending = r; //@queue
        if (deadlocked(tx.id)) { //@detect
            abort(tx.id); //@victim
        }
        return false; //@wait
    }
    // endregion

    // region grantable
    /** S needs no other writer; X needs no other holder. */
    boolean grantable(Lock lock, int t, char mode) {
        if (lock.exclusive != null && lock.exclusive != t) { //@x_held
            return false; //@x_held
        }
        boolean othersShare = lock.shared.stream().anyMatch(u -> u != t);
        return mode == 'S' || !othersShare; //@s_held
    }

    void grant(Lock lock, int t, char mode) {
        if (mode == 'X') {
            lock.shared.remove(t); //@grant
            lock.exclusive = t; //@grant
        } else if (lock.exclusive == null || lock.exclusive != t) {
            lock.shared.add(t); //@grant
        }
    }
    // endregion

    // region deadlock
    /** Follow waits-for edges from start. A way back is a cycle. */
    boolean deadlocked(int start) {
        Deque<Integer> stack = new ArrayDeque<>(List.of(start));
        Set<Integer> seen = new HashSet<>(List.of(start));
        while (!stack.isEmpty()) {
            int t = stack.pop(); //@visit
            for (int u : waitsFor(t)) { //@edge
                if (u == start) { //@cycle
                    return true; //@cycle
                }
                if (seen.add(u)) { //@follow
                    stack.push(u); //@follow
                }
            }
        }
        return false; //@acyclic
    }

    /** The transactions holding what t is queued for. */
    List<Integer> waitsFor(int t) {
        Txn tx = txns.get(t);
        List<Integer> out = new ArrayList<>();
        if (tx.state != State.WAITING) {
            return out;
        }
        Lock lock = locks.get(tx.pending.row());
        if (lock.exclusive != null && lock.exclusive != t) {
            out.add(lock.exclusive);
        }
        if (tx.pending.mode() == 'X') {
            for (int u : lock.shared) {
                if (u != t) {
                    out.add(u);
                }
            }
        }
        return out; //@edge
    }
    // endregion

    // region release
    /** Shrinking phase: drop every lock t holds, all at once. */
    void release(int t) {
        for (String row : ROWS) {
            Lock lock = locks.get(row);
            lock.shared.remove(t); //@drop
            if (lock.exclusive != null && lock.exclusive == t) {
                lock.exclusive = null; //@drop
            }
            lock.queue.removeIf(r -> r.tid() == t); //@drop
        }
        wake(); //@wake
    }

    /** Grant queued requests that no longer conflict, in order. */
    void wake() {
        for (String row : ROWS) {
            Lock lock = locks.get(row);
            for (Request r : List.copyOf(lock.queue)) {
                if (grantable(lock, r.tid(), r.mode())) { //@regrant
                    lock.queue.remove(r); //@resume
                    grant(lock, r.tid(), r.mode()); //@resume
                    resume(txns.get(r.tid())); //@resume
                }
            }
        }
    }

    /** Finish the request tx was waiting for. */
    void resume(Txn tx) {
        Request r = tx.pending;
        tx.state = State.ACTIVE; //@resume
        tx.pending = null; //@resume
        if (r.mode() == 'S') {
            tx.reads.put(r.row(), latest(r.row())); //@resume
        } else {
            tx.writes.put(r.row(), r.value()); //@resume
        }
    }
    // endregion

    // region snapshot_read
    /** Newest version tx can see. Notes writers it cannot see. */
    int snapshotRead(Txn tx, String row) {
        for (Txn other : txns.values()) {
            if (other != tx && other.state == State.ACTIVE) {
                if (other.writes.containsKey(row)) { //@uncommitted
                    note(tx, row, other); //@uncommitted
                }
            }
        }
        List<Version> vs = versions.get(row);
        for (int i = vs.size() - 1; ; i--) {
            Version v = vs.get(i);
            if (v.ts() <= tx.snapshot) { //@visible
                return v.value(); //@visible
            }
            note(tx, row, v.writer()); //@newer
        }
    }
    // endregion

    // region warn
    /** Writing row makes every open reader of it stale. */
    void warnReaders(Txn tx, String row) {
        for (Txn other : txns.values()) {
            if (other != tx && other.state == State.ACTIVE) {
                if (other.reads.containsKey(row)) { //@reader
                    note(other, row, tx); //@reader
                }
            }
        }
    }
    // endregion

    // region note
    /** reader's view of row is wrong if writer commits. */
    void note(Txn reader, String row, Txn writer) {
        Mark m = new Mark(row, writer);
        if (!reader.stale.contains(m)) {
            reader.stale.add(m); //@note
        }
    }
    // endregion

    // region validate
    /** Fail if a writer of something tx read has committed. */
    boolean validate(Txn tx) {
        for (Mark m : tx.stale) { //@check
            if (m.writer().state == State.COMMITTED) { //@check
                return false; //@stale
            }
        }
        return true; //@valid
    }
    // endregion

    int latest(String row) {
        List<Version> vs = versions.get(row);
        return vs.get(vs.size() - 1).value();
    }

    // region write_skew
    /** Alice (T1) and Bob (T2) both ask to go off call at once. */
    static TwoPhaseLocking writeSkew(String method) {
        var db = new TwoPhaseLocking(method); //@ws_reset
        for (int t = 1; t <= 2; t++) {
            db.begin(t); //@ws_begin
        }
        int[] onCall = new int[3];
        for (int t = 1; t <= 2; t++) {
            for (String row : ROWS) {
                onCall[t] += db.read(t, row); //@ws_read
            }
        }
        for (int t = 1; t <= 2; t++) {
            if (onCall[t] >= 2) { //@ws_decide
                db.write(t, OWNER.get(t), 0); //@ws_write
            }
        }
        return db; //@ws_done
    }
    // endregion

    // region retry
    /** Run t's whole transaction again, from the start. */
    static Boolean retry(TwoPhaseLocking db, int t) {
        if (!db.begin(t)) { //@r_begin
            return null; //@r_begin
        }
        int onCall = 0;
        for (String row : ROWS) {
            Integer value = db.read(t, row); //@r_read
            if (value == null) {
                return null; //@r_stuck
            }
            onCall += value;
        }
        String me = OWNER.get(t);
        if (me != null && onCall >= 2) { //@r_decide
            if (!db.write(t, me, 0)) { //@r_write
                return null; //@r_stuck
            }
        }
        return db.commit(t); //@r_commit
    }
    // endregion
}
