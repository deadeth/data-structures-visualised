import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** A tiny multi-version table with a write lock per row. */
public class Mvcc {
    public enum Level { READ_COMMITTED, SNAPSHOT }

    public enum Status { ACTIVE, COMMITTED, ABORTED }

    public enum Outcome { WRITTEN, WAITING, ABORTED }

    /** One version of a row. */
    static final class Version {
        final int value;
        final int xmin; // id of the transaction that made it
        Integer xmax; // id of the transaction that replaced it

        Version(int value, int xmin) {
            this.value = value;
            this.xmin = xmin;
        }
    }

    /** A transaction and the snapshot it reads through. */
    static final class Txn {
        final int xid;
        final Level level;
        Status status = Status.ACTIVE;
        Set<Integer> inProgress = new HashSet<>(); // running at snapshot
        int horizon; // ids from here up had not begun
        String wantsRow; // set while it waits for a lock
        int wantsValue;

        Txn(int xid, Level level) {
            this.xid = xid;
            this.level = level;
            this.horizon = xid;
        }
    }

    private Level level;
    private Map<Integer, Txn> txns; // sorted, so waiters retry in id order
    private Map<String, List<Version>> rows; // each chain newest first
    private Map<String, Integer> locks; // row -> id holding its lock
    private int nextXid;

    public Mvcc(Map<String, Integer> initial, Level level) {
        this.level = level;
        load(initial);
    }

    // region load
    /** Start again: transaction 0 writes every row. */
    public void load(Map<String, Integer> initial) {
        Txn loader = new Txn(0, level);
        loader.status = Status.COMMITTED;
        txns = new TreeMap<>(); //@load
        txns.put(0, loader); //@load
        rows = new LinkedHashMap<>(); //@load
        for (var e : initial.entrySet()) {
            List<Version> chain = new ArrayList<>();
            chain.add(new Version(e.getValue(), 0)); //@load
            rows.put(e.getKey(), chain);
        }
        locks = new HashMap<>();
        nextXid = 1;
    }
    // endregion

    // region level
    /** The level for transactions that begin from now on. */
    public void setLevel(Level level) {
        this.level = level; //@level
    }
    // endregion

    // region begin
    /** Starts a transaction and takes its snapshot. */
    public int begin() {
        Txn t = new Txn(nextXid, level); //@begin
        nextXid++; //@begin
        txns.put(t.xid, t);
        takeSnapshot(t); //@snapshot
        return t.xid;
    }

    /** Notes who is running, and the next id to be handed out. */
    private void takeSnapshot(Txn t) {
        t.inProgress = new HashSet<>();
        for (Txn o : txns.values()) {
            if (o.status == Status.ACTIVE && o.xid != t.xid) {
                t.inProgress.add(o.xid);
            }
        }
        t.horizon = nextXid; //@snapshot
    }
    // endregion

    // region read
    /** The value of row that xid is allowed to see. */
    public Integer read(int xid, String row) {
        Txn t = txns.get(xid);
        if (t.level == Level.READ_COMMITTED) {
            takeSnapshot(t); //@statement
        }
        // The chain is kept newest first.
        for (Version v : rows.get(row)) { //@walk
            if (visible(t, v)) { //@walk
                return v.value; //@found
            }
        }
        return null;
    }
    // endregion

    // region visible
    /** The visibility rule for one version. */
    private boolean visible(Txn t, Version v) {
        if (v.xmin == t.xid) { //@mine
            return v.xmax == null || v.xmax != t.xid; //@mine
        }
        if (!committedBefore(t, v.xmin)) { //@created
            return false; //@created
        }
        if (v.xmax == null) { //@not_deleted
            return true; //@not_deleted
        }
        if (v.xmax == t.xid) { //@not_deleted
            return false; //@not_deleted
        }
        return !committedBefore(t, v.xmax); //@deleted
    }

    /** Did xid commit before t's snapshot was taken? */
    private boolean committedBefore(Txn t, int xid) {
        if (txns.get(xid).status != Status.COMMITTED) { //@committed
            return false; //@committed
        }
        if (xid >= t.horizon) { //@after
            return false; //@after
        }
        return !t.inProgress.contains(xid); //@running
    }
    // endregion

    // region write
    /** Adds a version, or waits for the lock, or aborts. */
    public Outcome write(int xid, String row, int value) {
        Txn t = txns.get(xid);
        Integer holder = locks.get(row); //@lock
        if (holder != null && holder != xid) { //@lock
            if (waitsFor(holder, xid)) { //@deadlock
                abort(xid); //@deadlock
                return Outcome.ABORTED; //@deadlock
            }
            t.wantsRow = row; //@wait
            t.wantsValue = value; //@wait
            return Outcome.WAITING; //@wait
        }
        Version head = newest(row); //@head
        if (t.level == Level.SNAPSHOT && head.xmin != xid //@conflict
                && !committedBefore(t, head.xmin)) { //@conflict
            // First committer wins: someone changed it after my snapshot.
            abort(xid); //@first_wins
            return Outcome.ABORTED; //@first_wins
        }
        locks.put(row, xid); //@append
        head.xmax = xid; //@append
        rows.get(row).add(0, new Version(value, xid)); //@append
        return Outcome.WRITTEN; //@append
    }

    /** The newest version not left by an aborted transaction. */
    private Version newest(String row) {
        for (Version v : rows.get(row)) {
            if (txns.get(v.xmin).status != Status.ABORTED) {
                return v; //@head
            }
        }
        throw new IllegalStateException("no committed version");
    }

    /** Would xid waiting on holder close a cycle? */
    private boolean waitsFor(Integer holder, int xid) {
        while (holder != null) {
            if (holder == xid) {
                return true; //@deadlock
            }
            String wants = txns.get(holder).wantsRow;
            holder = wants == null ? null : locks.get(wants);
        }
        return false;
    }
    // endregion

    // region commit
    /** Later snapshots will count xid's versions. */
    public void commit(int xid) {
        txns.get(xid).status = Status.COMMITTED; //@commit
        release(xid); //@release
    }
    // endregion

    // region abort
    /** Its versions stay behind as garbage for vacuum. */
    public void abort(int xid) {
        Txn t = txns.get(xid);
        t.status = Status.ABORTED; //@abort
        t.wantsRow = null; //@abort
        release(xid); //@release
    }
    // endregion

    // region release
    /** Frees xid's locks and retries whoever waited on them. */
    private void release(int xid) {
        List<String> freed = new ArrayList<>();
        for (var e : locks.entrySet()) {
            if (e.getValue() == xid) {
                freed.add(e.getKey());
            }
        }
        for (String row : freed) {
            locks.remove(row); //@unlock
        }
        for (Txn w : new ArrayList<>(txns.values())) {
            if (w.wantsRow != null && freed.contains(w.wantsRow)) { //@waiter
                String row = w.wantsRow;
                w.wantsRow = null;
                write(w.xid, row, w.wantsValue); //@retry
            }
        }
    }
    // endregion

    // region vacuum
    /** Drops versions no transaction can ever see again. */
    public int vacuum() {
        List<Txn> active = new ArrayList<>();
        for (Txn t : txns.values()) {
            if (t.status == Status.ACTIVE) {
                active.add(t);
            }
        }
        int removed = 0;
        for (var e : rows.entrySet()) {
            List<Version> keep = new ArrayList<>();
            for (Version v : e.getValue()) { //@vac_scan
                if (dead(v, active)) { //@vac_test
                    removed++; //@vac_drop
                } else {
                    keep.add(v); //@vac_keep
                }
            }
            e.setValue(keep); //@vac_done
        }
        return removed; //@vac_done
    }

    /** Aborted, or replaced before every snapshot still open. */
    private boolean dead(Version v, List<Txn> active) {
        if (txns.get(v.xmin).status == Status.ABORTED) { //@vac_test
            return true;
        }
        if (v.xmax == null
                || txns.get(v.xmax).status != Status.COMMITTED) {
            return false;
        }
        for (Txn t : active) {
            // Read committed takes a new snapshot at its next statement.
            if (t.level == Level.SNAPSHOT && !committedBefore(t, v.xmax)) {
                return false;
            }
        }
        return true;
    }
    // endregion

    public Status status(int xid) {
        return txns.get(xid).status;
    }

    public boolean waiting(int xid) {
        return txns.get(xid).wantsRow != null;
    }

    public int versions(String row) {
        return rows.get(row).size();
    }
}
