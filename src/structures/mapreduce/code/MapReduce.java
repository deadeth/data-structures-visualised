import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** MapReduce phases, run in one process. */
public class MapReduce {
    static final int[][] EVEN = {{2, 5, 1}, {4, 2, 6}, {1, 4, 2}};
    static final int[] USER_IDS = {1, 2, 4};
    static final String[] COUNTRIES = {"UK", "FR", "IT"};

    /** Anything the shuffle routes: it knows its reducer. */
    interface Routed {
        int part();
    }

    /** A count pair: reducer, user and a one. */
    record One(int part, int user, int one)
            implements Routed, Comparable<One> {
        public int compareTo(One o) {
            if (part != o.part) {
                return Integer.compare(part, o.part);
            }
            return Integer.compare(user, o.user);
        }
    }

    /** A join record: tag 0 is a user row, tag 1 a click. */
    record Tagged(int part, int user, int tag, String value)
            implements Routed, Comparable<Tagged> {
        public int compareTo(Tagged o) {
            if (part != o.part) {
                return Integer.compare(part, o.part);
            }
            if (user != o.user) {
                return Integer.compare(user, o.user);
            }
            if (tag != o.tag) {
                return Integer.compare(tag, o.tag);
            }
            return value.compareTo(o.value);
        }
    }

    record Total(int user, int clicks) {}

    record Joined(int user, String country) {}

    private final int reducers;
    int[][] blocks; // user id of each click
    int[] userIds = USER_IDS.clone();
    String[] countries = COUNTRIES.clone();

    public MapReduce(int reducers) {
        this.reducers = reducers;
        evenInput();
    }

    /** Pairs of one run that belong to reducer r. */
    static <T extends Routed> List<T> slice(List<T> run, int r) {
        List<T> out = new ArrayList<>();
        for (T t : run) {
            if (t.part() == r) {
                out.add(t);
            }
        }
        return out;
    }

    // region partition
    /** The reducer that owns this key. */
    int partition(int key) {
        int h = (31 * key + 7) % 1009; //@hash
        return h % reducers; //@partition
    }
    // endregion

    // region count
    /** Clicks per user. */
    public List<Total> count() {
        List<List<One>> runs = new ArrayList<>();
        for (int[] block : blocks) { //@job
            List<One> out = new ArrayList<>();
            for (int user : block) { //@read
                out.add(new One(partition(user), user, 1)); //@emit
            }
            Collections.sort(out); // by reducer, then key //@sort
            runs.add(out); // on the mapper's local disk
        }
        List<Total> totals = new ArrayList<>();
        for (int r = 0; r < reducers; r++) {
            List<List<One>> mine = new ArrayList<>();
            for (List<One> run : runs) {
                mine.add(slice(run, r)); //@fetch
            }
            totals.addAll(sumByKey(merge(mine))); //@group
        }
        return totals; //@write
    }
    // endregion

    // region sort_merge_join
    /** Reduce-side join of clicks with users. */
    public List<Joined> sortMergeJoin() {
        List<List<Tagged>> runs = new ArrayList<>();
        for (int[] block : blocks) { //@job
            List<Tagged> out = new ArrayList<>();
            for (int user : block) { //@read
                out.add(new Tagged(partition(user), user, 1, "")); //@emit
            }
            Collections.sort(out); //@sort
            runs.add(out);
        }
        List<Tagged> rows = new ArrayList<>();
        for (int i = 0; i < userIds.length; i++) {
            int user = userIds[i];
            // Tag 0 sorts a user row before its clicks.
            rows.add(new Tagged(partition(user), user, 0, countries[i])); //@emit_user
        }
        Collections.sort(rows); //@sort
        runs.add(rows);
        List<Joined> joined = new ArrayList<>();
        for (int r = 0; r < reducers; r++) {
            List<List<Tagged>> mine = new ArrayList<>();
            for (List<Tagged> run : runs) {
                mine.add(slice(run, r)); //@fetch
            }
            joined.addAll(joinSorted(merge(mine))); //@group
        }
        return joined; //@write
    }
    // endregion

    // region broadcast_join
    /** Map-side join: every map task holds all users. */
    public List<Joined> broadcastJoin() {
        List<Joined> joined = new ArrayList<>();
        for (int[] block : blocks) { //@job
            Map<Integer, String> table = new HashMap<>(); //@load
            for (int i = 0; i < userIds.length; i++) {
                table.put(userIds[i], countries[i]); //@load
            }
            for (int user : block) { //@read
                String country = table.get(user); //@lookup
                if (country == null) { //@lookup
                    continue; //@drop
                }
                joined.add(new Joined(user, country)); //@joined
            }
        }
        // No shuffle, no sort and no reducers.
        return joined; //@write
    }
    // endregion

    // region skew
    /** One user makes 7 of the 9 clicks. */
    public void hotInput(int hot) {
        int[] others = new int[2];
        int n = 0;
        for (int u : new int[] {2, 5, 4}) {
            if (u != hot && n < 2) {
                others[n++] = u;
            }
        }
        int a = others[0];
        int b = others[1];
        blocks = new int[][] {{hot, hot, a}, {hot, hot, hot}, {b, hot, hot}}; //@hot
    }

    /** Pairs each reducer receives in a count. */
    public int[] reducerLoads() {
        int[] loads = new int[reducers];
        for (int[] block : blocks) { //@read
            for (int user : block) {
                loads[partition(user)]++; //@load_up
            }
        }
        return loads; //@imbalance
    }
    // endregion

    // region reset
    /** Back to the even input. */
    public void evenInput() {
        blocks = new int[EVEN.length][]; //@reset
        for (int i = 0; i < EVEN.length; i++) {
            blocks[i] = EVEN[i].clone(); //@reset
        }
    }
    // endregion

    // region merge
    /** Merges sorted runs, smallest head first. */
    static <T extends Comparable<T>> List<T> merge(List<List<T>> runs) {
        List<ArrayDeque<T>> heads = new ArrayList<>();
        for (List<T> run : runs) {
            heads.add(new ArrayDeque<>(run));
        }
        List<T> out = new ArrayList<>();
        while (true) {
            int best = -1;
            for (int i = 0; i < heads.size(); i++) {
                T head = heads.get(i).peek();
                if (head == null) {
                    continue;
                }
                if (best < 0) {
                    best = i;
                } else if (head.compareTo(heads.get(best).peek()) < 0) { //@cmp
                    best = i; //@new_best
                }
            }
            if (best < 0) {
                return out; //@merged
            }
            // Hadoop keeps the heads in a heap.
            out.add(heads.get(best).poll()); //@take
        }
    }
    // endregion

    // region reduce_count
    /** Totals each run of equal keys in one pass. */
    static List<Total> sumByKey(List<One> merged) {
        List<Total> totals = new ArrayList<>();
        for (One p : merged) { //@group
            int last = totals.size() - 1;
            if (last >= 0 && totals.get(last).user() == p.user()) { //@same
                Total t = totals.get(last);
                totals.set(last, new Total(t.user(), t.clicks() + p.one())); //@sum
            } else {
                totals.add(new Total(p.user(), p.one())); //@new_key
            }
        }
        return totals;
    }
    // endregion

    // region reduce_join
    /** One pass: a user row comes just before its clicks. */
    static List<Joined> joinSorted(List<Tagged> merged) {
        List<Joined> joined = new ArrayList<>();
        Integer current = null;
        String country = null;
        for (Tagged t : merged) { //@group
            if (current == null || current != t.user()) {
                current = t.user();
                country = null;
            }
            if (t.tag() == 0) { //@user_first
                country = t.value(); //@remember
            } else if (country == null) { //@match
                continue; //@drop
            } else {
                joined.add(new Joined(t.user(), country)); //@joined
            }
        }
        return joined;
    }
    // endregion
}
