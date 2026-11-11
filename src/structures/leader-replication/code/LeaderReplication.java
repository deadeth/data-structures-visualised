import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** One leader, its followers, and one client's positions. */
public class LeaderReplication {
    /** Whom the leader waits for before it answers a write. */
    public enum Mode { ASYNC, SEMI_SYNC, SYNC }

    /** One log entry, stamped with the epoch of the leader that wrote it. */
    public record Entry(int epoch, String key, int value) {}

    /** What a read returned, and from which replica. */
    public record Read(Integer value, boolean behind, String from) {}

    /** A copy of the data: a log applied in order. */
    static class Replica {
        final String name;
        final List<Entry> log = new ArrayList<>(); // entry i has LSN i + 1
        int epoch = 1; // newest epoch this replica knows of
        boolean alive = true;
        boolean held = false; // its link from the leader is slow

        Replica(String name) {
            this.name = name;
        }

        /** The LSN of the last entry applied. */
        int pos() {
            return log.size();
        }

        /** The newest value of key, or null. */
        Integer get(String key) {
            for (int i = log.size() - 1; i >= 0; i--) {
                if (log.get(i).key().equals(key)) {
                    return log.get(i).value();
                }
            }
            return null;
        }
    }

    final Map<String, Replica> replicas = new LinkedHashMap<>();
    final Mode mode;
    Replica leader;
    String syncName;
    int epoch = 1;
    boolean semiOff = false; // semi-sync timed out; async for now
    int wrote = 0; // LSN of the client's last write
    int seen = 0; // newest position the client has read from

    public LeaderReplication(Mode mode, String... names) {
        this.mode = mode;
        for (String n : names) {
            replicas.put(n, new Replica(n));
        }
        leader = replicas.get(names[0]);
        syncName = names[1];
    }

    /** Live replicas other than the leader, in name order. */
    List<Replica> followers() {
        List<Replica> out = new ArrayList<>();
        for (Replica r : replicas.values()) {
            if (r != leader && r.alive) {
                out.add(r);
            }
        }
        return out;
    }

    /** The follower semi-sync waits for, or null. */
    Replica syncFollower() {
        List<Replica> fs = followers();
        for (Replica f : fs) {
            if (f.name.equals(syncName)) {
                return f;
            }
        }
        return fs.isEmpty() ? null : fs.get(0);
    }

    /** The replica called name, if it is up. */
    Replica live(String name) {
        Replica r = replicas.get(name);
        if (r == null || !r.alive) {
            throw new IllegalArgumentException(name + " is not up");
        }
        return r;
    }

    /** The replica called name, if it is a live follower. */
    Replica follower(String name) {
        Replica r = live(name);
        if (r == leader) {
            throw new IllegalArgumentException(name + " is the leader");
        }
        return r;
    }

    // region needed
    /** Followers the leader waits for before it answers. */
    List<Replica> needed() {
        if (mode == Mode.SYNC) {
            return followers();
        }
        if (mode == Mode.SEMI_SYNC && !semiOff) {
            Replica f = syncFollower();
            return f == null ? List.of() : List.of(f);
        }
        return List.of();
    }
    // endregion

    // region ship_all
    /** Copies, in order, the leader's entries that f lacks. */
    int shipAll(Replica f) {
        List<Entry> log = leader.log;
        int sent = 0;
        while (f.pos() < log.size()) { //@gap
            f.log.add(log.get(f.pos())); //@copy
            sent++; //@copy
        }
        return sent;
    }
    // endregion

    // region agrees
    /** Same entry at lsn? One leader writes each epoch. */
    static boolean agrees(Replica a, Replica b, int lsn) {
        return lsn <= b.pos()
            && a.log.get(lsn - 1).epoch() == b.log.get(lsn - 1).epoch();
    }
    // endregion

    // region write
    /** Appends on the leader, replicates, then answers. */
    public int write(String key, int value) {
        Replica lead = leader;
        lead.log.add(new Entry(epoch, key, value)); //@append
        int acks = 0;
        for (Replica f : needed()) { //@wait
            if (f.held) { //@held
                // The wait timed out: stop waiting from now on.
                semiOff = true; //@timeout
            } else {
                shipAll(f); //@sync_copy
                acks++; //@sync_copy
            }
        }
        wrote = lead.pos(); //@ack
        for (Replica f : followers()) { //@async
            if (!f.held && f.pos() < lead.pos()) { //@async
                shipAll(f); //@async_copy
            }
        }
        return wrote;
    }
    // endregion

    // region read
    /** Reads from one replica as it is. It can be stale. */
    public Read read(String name, String key) {
        Replica r = live(name); //@r_pick
        // The newest position this client knows of, if it survived.
        int want = Math.min(Math.max(wrote, seen), leader.pos()); //@want
        boolean behind = r.pos() < want; //@stale
        seen = Math.max(seen, r.pos()); //@serve
        return new Read(r.get(key), behind, r.name); //@serve
    }
    // endregion

    // region read_your_writes
    /** Reads only from a replica that has the client's write. */
    public Read readYourWrites(String name, String key) {
        Replica r = live(name); //@y_pick
        if (r != leader && r.pos() < wrote) { //@ryw_check
            // Waiting for r to catch up would also do.
            r = leader; //@route
        }
        seen = Math.max(seen, r.pos()); //@ryw_serve
        return new Read(r.get(key), false, r.name); //@ryw_serve
    }
    // endregion

    // region lag
    /** Holds back a follower's link. Sync mode refuses. */
    public boolean lag(String name) {
        Replica f = follower(name); //@l_pick
        if (mode == Mode.SYNC) { //@sync_only
            return false; // it would stall every write //@sync_only
        }
        f.held = true; //@hold
        return true; //@hold
    }
    // endregion

    // region catch_up
    /** Releases a held follower and sends what it missed. */
    public int catchUp(String name) {
        Replica f = follower(name); //@c_pick
        f.held = false; //@release
        int sent = shipAll(f); //@ship
        if (f == syncFollower()) { //@resync
            semiOff = false; //@resync
        }
        return sent; //@c_done
    }
    // endregion

    // region fail_leader
    /** The leader dies: promotes the most up-to-date follower. */
    public Integer failLeader() {
        Replica old = leader;
        if (followers().isEmpty()) { //@f_check
            return null; //@f_check
        }
        old.alive = false; //@die
        Replica best = null;
        for (Replica f : followers()) { //@candidates
            if (best == null || f.pos() > best.pos()) { //@better
                best = f; //@best
            }
        }
        epoch++; //@promote
        best.epoch = epoch; //@promote
        best.held = false; //@promote
        leader = best; //@promote
        int lost = old.pos() - best.pos(); //@lost
        semiOff = false; //@repoint
        List<Replica> rest = followers(); //@repoint
        syncName = rest.isEmpty() ? null : rest.get(0).name; //@repoint
        for (Replica f : rest) { //@repoint
            f.held = false; //@repoint
            f.epoch = epoch; //@repoint
            shipAll(f); //@repoint
        }
        return lost;
    }
    // endregion

    // region rejoin
    /** A failed node returns, drops what the leader lacks, follows. */
    public Integer rejoin(String name) {
        Replica node = replicas.get(name);
        if (node.alive) { //@j_check
            return null; //@j_check
        }
        Replica lead = leader;
        if (node.epoch < epoch) { //@fence
            node.epoch = epoch; // an old leader steps down //@fence
        }
        int n = node.pos();
        while (n > 0 && !agrees(node, lead, n)) { //@match
            n--; //@match
        }
        int dropped = node.pos() - n; //@truncate
        node.log.subList(n, node.pos()).clear(); //@truncate
        node.alive = true; //@follow
        node.held = false; //@follow
        shipAll(node); //@follow
        return dropped;
    }
    // endregion
}
