import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A Raft cluster in one process, one message at a time. */
public class Raft {
    public enum Role { FOLLOWER, CANDIDATE, LEADER }

    /** One log entry. A null value is a leader's no-op. */
    public record Entry(int term, Integer value) {}

    /** One server. term, votedFor and log survive a crash. */
    public static final class Server {
        public final int id;
        public Role role = Role.FOLLOWER;
        public int term = 0;
        public Integer votedFor = null;
        public final List<Entry> log = new ArrayList<>(); // index 1 is get(0)
        public int commit = 0; // highest index known to be committed
        public boolean up = true;
        public Map<Integer, Integer> next = new HashMap<>(); // leader only
        public Map<Integer, Integer> match = new HashMap<>(); // leader only

        Server(int id) {
            this.id = id;
        }

        int lastTerm() {
            return log.isEmpty() ? 0 : log.get(log.size() - 1).term();
        }
    }

    public List<Server> servers = new ArrayList<>();
    public final Set<Integer> cut = new HashSet<>(); // ids on the far side
    private final int maxLog; // the page draws this many entries

    public Raft(int n, int maxLog) {
        for (int i = 1; i <= n; i++) {
            servers.add(new Server(i));
        }
        this.maxLog = maxLog;
    }

    public Server server(int id) {
        return servers.get(id - 1);
    }

    int majority() {
        return servers.size() / 2 + 1;
    }

    List<Server> peers(Server s) {
        return servers.stream().filter(p -> p != s).toList();
    }

    boolean reachable(Server a, Server b) {
        return a.up && b.up && cut.contains(a.id) == cut.contains(b.id);
    }

    void stepDown(Server s, int term) {
        if (term > s.term) {
            s.term = term;
            s.votedFor = null;
        }
        s.role = Role.FOLLOWER;
    }

    /** The leader a client finds: the newest term wins. */
    public Server clientLeader() {
        return servers.stream()
            .filter(s -> s.up && s.role == Role.LEADER)
            .max(Comparator.comparingInt(s -> s.term))
            .orElse(null);
    }

    /** The newest leader that can reach s. */
    Server leaderFor(Server s) {
        return servers.stream()
            .filter(l -> l.role == Role.LEADER && reachable(l, s))
            .max(Comparator.comparingInt(l -> l.term))
            .orElse(null);
    }

    // region timeout
    /** c heard no heartbeat in time, so it stands for leader. */
    public boolean timeout(Server c) {
        if (!c.up || c.role == Role.LEADER) { //@skip
            return false; //@skip
        }
        c.role = Role.CANDIDATE; //@stand
        c.term++; //@stand
        c.votedFor = c.id; //@stand
        int votes = 1; //@stand
        for (Server p : peers(c)) { // sent in parallel in real life
            if (!reachable(c, p)) { //@lost
                continue; //@lost
            }
            if (p.term > c.term) { //@term
                stepDown(c, p.term); //@behind
                return false; //@behind
            }
            if (p.term < c.term) { //@term
                stepDown(p, c.term); //@adopt
            }
            if (p.votedFor != null && p.votedFor != c.id) { //@voted
                continue; //@refuse
            }
            if (!upToDate(c, p)) { //@log_check
                continue; //@refuse
            }
            p.votedFor = c.id; //@grant
            votes++; //@grant
        }
        if (votes < majority()) { //@tally
            return false; //@split
        }
        becomeLeader(c); //@win
        return true;
    }
    // endregion

    // region up_to_date
    /** Is c's log at least as up to date as p's? */
    boolean upToDate(Server c, Server p) {
        if (c.lastTerm() != p.lastTerm()) { //@last_term
            return c.lastTerm() > p.lastTerm(); //@newer
        }
        return c.log.size() >= p.log.size(); //@last_index
    }
    // endregion

    // region become_leader
    /** Guesses every log matches its own, then adds a no-op. */
    void becomeLeader(Server c) {
        c.role = Role.LEADER; //@lead
        for (Server p : peers(c)) {
            c.next.put(p.id, c.log.size() + 1); //@lead
            c.match.put(p.id, 0); //@lead
        }
        if (c.log.size() < maxLog) {
            c.log.add(new Entry(c.term, null)); //@noop
        }
        if (broadcast(c)) { //@send
            advanceCommit(c); //@count
        }
    }
    // endregion

    // region write
    /** A client write. True once it is committed. */
    public boolean write(int value) {
        Server leader = clientLeader(); //@find
        if (leader == null) {
            return false; //@no_leader
        }
        if (leader.log.size() >= maxLog) { //@full
            return false; //@full
        }
        leader.log.add(new Entry(leader.term, value)); //@append
        int index = leader.log.size(); //@append
        if (!broadcast(leader)) { //@send
            return false; //@send
        }
        advanceCommit(leader); //@count
        return leader.commit >= index; //@count
    }
    // endregion

    // region broadcast
    /** AppendEntries to every peer. False if deposed. */
    boolean broadcast(Server leader) {
        for (Server p : peers(leader)) { //@each
            if (!reachable(leader, p)) { //@unreachable
                continue; //@unreachable
            }
            if (!replicate(leader, p)) { //@rpc
                return false; //@rpc
            }
        }
        return true;
    }
    // endregion

    // region replicate
    /** Brings f's log into line with the leader's. */
    boolean replicate(Server leader, Server f) {
        if (f.term > leader.term) { //@check_term
            stepDown(leader, f.term); //@deposed
            return false; //@deposed
        }
        stepDown(f, leader.term); //@follow
        int prev;
        while (true) {
            prev = leader.next.get(f.id) - 1; //@prev
            if (prev == 0) { //@empty
                break; //@empty
            }
            if (prev <= f.log.size()) { //@has_prev
                int want = leader.log.get(prev - 1).term(); //@same_term
                if (f.log.get(prev - 1).term() == want) { //@same_term
                    break; //@agree
                }
            }
            // each retry is another round trip
            leader.next.merge(f.id, -1, Integer::sum); //@back
        }
        int top = leader.log.size();
        for (int i = prev + 1; i <= top; i++) {
            Entry entry = leader.log.get(i - 1);
            if (i <= f.log.size()) {
                if (f.log.get(i - 1).term() == entry.term()) { //@conflict
                    continue; //@already
                }
                f.log.subList(i - 1, f.log.size()).clear(); //@truncate
            }
            f.log.add(entry); //@copy
        }
        leader.match.put(f.id, top); //@ack
        leader.next.put(f.id, top + 1); //@ack
        int learned = Math.min(leader.commit, top); //@ack
        f.commit = Math.max(f.commit, learned); //@ack
        return true;
    }
    // endregion

    // region advance_commit
    /** Commits the highest index a majority holds. */
    boolean advanceCommit(Server leader) {
        for (int n = leader.log.size(); n > leader.commit; n--) { //@scan
            int copies = 1; //@scan
            for (int m : leader.match.values()) { //@scan
                if (m >= n) {
                    copies++; //@scan
                }
            }
            if (copies < majority()) { //@majority
                continue; //@fewer
            }
            if (leader.log.get(n - 1).term() != leader.term) { //@own_term
                return false; // wait for an entry of this term //@older
            }
            leader.commit = n; //@commit
            for (Server p : peers(leader)) { // the next heartbeat //@tell
                if (reachable(leader, p)) { //@tell
                    int known = Math.min(n, leader.match.get(p.id)); //@tell
                    p.commit = Math.max(p.commit, known); //@tell
                }
            }
            return true;
        }
        return false; //@waiting
    }
    // endregion

    // region crash
    /** s stops. Its term, vote and log are on disk. */
    public void crash(Server s) {
        s.up = false; //@crash
        s.next = new HashMap<>(); //@crash
        s.match = new HashMap<>(); //@crash
    }
    // endregion

    // region recover
    /** s restarts as a follower and hears from a leader. */
    public void recover(Server s) {
        s.up = true; //@restart
        s.role = Role.FOLLOWER; //@restart
        s.commit = 0; // only in memory: learned again //@restart
        Server leader = leaderFor(s); //@find_leader
        if (leader == null) {
            return; //@no_leader
        }
        if (replicate(leader, s)) { //@rpc
            advanceCommit(leader); //@rpc
        }
    }
    // endregion

    // region partition
    /** Cuts s off from the servers on the other side. */
    public boolean partition(Server s) {
        if (!cut.contains(s.id)) {
            if (cut.size() + 1 == servers.size()) {
                return false; // nobody left on the other side //@refuse
            }
            cut.add(s.id); //@cut
        }
        return true; //@cut
    }
    // endregion

    // region heal
    /** Reconnects everyone. Leaders send heartbeats. */
    public void heal() {
        cut.clear(); //@heal
        List<Server> leaders = new ArrayList<>(servers.stream()
            .filter(s -> s.role == Role.LEADER).toList());
        leaders.sort((a, b) -> b.term - a.term); // newest first //@leaders
        for (Server leader : leaders) {
            if (leader.up && leader.role == Role.LEADER) { //@heartbeat
                if (broadcast(leader)) { //@heartbeat
                    advanceCommit(leader); //@heartbeat
                }
            }
        }
    }
    // endregion

    // region reset
    /** A fresh cluster: every server a follower in term 0. */
    public void reset() {
        int n = servers.size(); //@reset
        servers = new ArrayList<>(); //@reset
        for (int i = 1; i <= n; i++) {
            servers.add(new Server(i)); //@reset
        }
        cut.clear(); //@reset
    }
    // endregion
}
