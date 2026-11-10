import java.util.ArrayList;
import java.util.List;

public class LsmTree {
    static final int MEM_CAP = 4; // entries the memtable holds before it is flushed
    static final int TABLE_CAP = 4; // entries in each SSTable a compaction writes
    static final int L0_LIMIT = 4; // level 0 is compacted when it reaches this many tables
    static final int L1_LIMIT = 4; // level 1 is compacted when it holds more than this many
    static final int RATIO = 4; // each deeper level may hold this many times as many tables
    static final String TOMBSTONE = null; // the value a delete writes

    /** One key and its value. The value is TOMBSTONE if the key was deleted. */
    record Entry(int key, String value) {}

    /** A sorted file of entries. Never changed once it is written. */
    record SSTable(List<Entry> entries) {
        // The key range is kept in memory.
        int smallest() {
            return entries.get(0).key();
        }

        int largest() {
            return entries.get(entries.size() - 1).key();
        }
    }

    private final List<Entry> memtable = new ArrayList<>(); // sorted by key
    // levels.get(0) is newest first and its tables may overlap. Each deeper
    // level is one sorted run cut into tables that never overlap.
    private final List<List<SSTable>> levels = new ArrayList<>();

    public LsmTree() {
        for (int i = 0; i < 3; i++) {
            levels.add(new ArrayList<>());
        }
    }

    // region put
    /** Store a value. Only the memtable is touched. */
    public void put(int key, String value) {
        int pos = scan(memtable, key); //@start
        if (pos >= 0) {
            memtable.set(pos, new Entry(key, value)); //@overwrite
            return;
        }
        // A real store logs the write to disk first.
        memtable.add(-(pos + 1), new Entry(key, value)); //@insert
        if (memtable.size() == MEM_CAP) { //@no_flush
            flush(); //@wrote
        }
    }
    // endregion

    // region delete
    /** Write a tombstone. SSTables are never edited. */
    public void delete(int key) {
        int pos = scan(memtable, key); //@start
        boolean found = pos >= 0;
        if (found && memtable.get(pos).value() == TOMBSTONE) {
            return; //@already
        }
        if (found) {
            memtable.set(pos, new Entry(key, TOMBSTONE)); //@replace
        } else {
            // No check that key exists: that would cost reads.
            memtable.add(-(pos + 1), new Entry(key, TOMBSTONE)); //@tombstone
        }
        if (memtable.size() == MEM_CAP) { //@no_flush
            flush(); //@wrote
        }
    }
    // endregion

    // region get
    /** The newest value for key, or null. */
    public String get(int key) {
        int pos = scan(memtable, key); //@start
        if (pos >= 0) {
            return memtable.get(pos).value(); //@mem_hit
        }
        // L0 tables overlap, so try each one, newest first.
        for (SSTable table : levels.get(0)) { //@l0
            if (side(table, key) == 0) {
                pos = scan(table.entries(), key);
                if (pos >= 0) {
                    return table.entries().get(pos).value(); //@l0_hit
                }
            }
        }
        // Deeper levels: one table at most can hold key.
        for (int i = 1; i < levels.size(); i++) {
            SSTable table = findTable(levels.get(i), key); //@level
            if (table != null) {
                pos = scan(table.entries(), key);
                if (pos >= 0) {
                    return table.entries().get(pos).value(); //@deep_hit
                }
            }
        }
        return null; //@miss
    }
    // endregion

    // region find_table
    /** Binary search a level for the table covering key. */
    private SSTable findTable(List<SSTable> tables, int key) {
        int lo = 0;
        int hi = tables.size() - 1;
        while (lo <= hi) {
            int mid = (lo + hi) / 2;
            int side = side(tables.get(mid), key);
            if (side == 0) {
                return tables.get(mid);
            }
            if (side < 0) {
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        return null;
    }

    /** -1 if key is below the table's range, 1 if above. */
    private static int side(SSTable table, int key) {
        if (key < table.smallest()) { //@range_lo
            return -1;
        }
        if (key > table.largest()) { //@range_hi
            return 1;
        }
        return 0;
    }
    // endregion

    // region scan
    /** Index of key in sorted entries, or -(its place) - 1. */
    private static int scan(List<Entry> entries, int key) {
        // Linear, as animated. A real memtable is a skip list
        // and a real SSTable has an index and a Bloom filter.
        int n = entries.size();
        int pos = 0;
        while (pos < n && entries.get(pos).key() < key) { //@scan
            pos++;
        }
        if (pos < n && entries.get(pos).key() == key) {
            return pos;
        }
        return -(pos + 1);
    }
    // endregion

    // region flush
    /** Write the memtable out as a new L0 SSTable. */
    public void flush() {
        if (memtable.isEmpty()) {
            return; //@flush_empty
        }
        SSTable table = new SSTable(List.copyOf(memtable)); //@flush_write
        levels.get(0).add(0, table); // newest first //@flush_l0
        memtable.clear(); //@flush_l0
        settle(); //@flush_done
    }
    // endregion

    // region settle
    /** Run the compactions the level limits call for. */
    private void settle() {
        if (levels.get(0).size() >= L0_LIMIT) { //@l0_full
            compactLevel(0);
        }
        cascade();
    }
    // endregion

    // region cascade
    /** Merge down each deeper level over its limit. */
    private void cascade() {
        int limit = L1_LIMIT;
        // levels.size() may grow as we go.
        for (int level = 1; level < levels.size(); level++) {
            if (levels.get(level).size() > limit) { //@over_limit
                compactLevel(level);
            }
            limit *= RATIO;
        }
    }
    // endregion

    // region compact
    /** Merge the shallowest level with tables downwards. */
    public void compact() {
        int bottom = levels.size() - 1;
        int level = 0;
        while (level < bottom && levels.get(level).isEmpty()) {
            level++;
        }
        if (level == bottom) {
            return; // the last level has nowhere to go //@nothing
        }
        compactLevel(level); //@pick
        cascade(); //@compact_done
    }
    // endregion

    // region compact_level
    /** Merge a whole level into the level below it. */
    private void compactLevel(int level) {
        // Real engines pick one table and its overlaps below.
        int below = level + 1;
        if (below == levels.size()) { // the tree grows a level
            levels.add(new ArrayList<>());
        }
        boolean last = below == levels.size() - 1;
        List<SSTable> upper = levels.get(level);
        List<SSTable> lower = levels.get(below);
        // Runs, newest first. Each L0 table is its own run.
        List<List<Entry>> runs = new ArrayList<>();
        if (level == 0) {
            upper.forEach(table -> runs.add(table.entries())); //@runs_l0
        } else {
            runs.add(entries(upper)); //@runs_level
        }
        if (!lower.isEmpty()) {
            runs.add(entries(lower)); //@runs_below
        }
        // A tombstone must not be moved into the last level.
        boolean tombstones = runs.get(0).stream()
                .anyMatch(e -> e.value() == TOMBSTONE);
        if (runs.size() == 1 && !(last && tombstones)) { //@lone_run
            // One sorted run, nothing below: move the files.
            levels.set(level, new ArrayList<>()); //@move
            levels.set(below, upper); //@move
            return;
        }
        List<Entry> merged = merge(runs, last); //@merge
        List<SSTable> fresh = new ArrayList<>();
        for (int i = 0; i < merged.size(); i += TABLE_CAP) { //@cut
            int end = Math.min(i + TABLE_CAP, merged.size());
            List<Entry> part = merged.subList(i, end);
            fresh.add(new SSTable(List.copyOf(part))); //@cut
        }
        levels.set(level, new ArrayList<>()); //@cut
        levels.set(below, fresh); //@cut
    }

    private static List<Entry> entries(List<SSTable> tables) {
        List<Entry> all = new ArrayList<>();
        tables.forEach(table -> all.addAll(table.entries()));
        return all;
    }
    // endregion

    // region merge
    /** Merge sorted runs, newest first, into one run. */
    private static List<Entry> merge(List<List<Entry>> runs,
                                     boolean dropTombstones) {
        // heads[r] is the next unread entry of run r.
        int[] heads = new int[runs.size()];
        List<Entry> out = new ArrayList<>();
        while (true) {
            // Find the smallest head. Many runs want a heap.
            int best = -1;
            int smallest = 0;
            List<Integer> ties = new ArrayList<>();
            for (int r = 0; r < runs.size(); r++) {
                if (heads[r] == runs.get(r).size()) {
                    continue; // this run is used up
                }
                int key = runs.get(r).get(heads[r]).key();
                if (best < 0 || key < smallest) { //@smallest
                    best = r; //@smallest
                    smallest = key; //@smallest
                    ties.clear();
                } else if (key == smallest) {
                    ties.add(r); // an older copy of the key
                }
            }
            if (best < 0) {
                return out;
            }
            Entry entry = runs.get(best).get(heads[best]);
            heads[best]++;
            for (int r : ties) {
                heads[r]++; // the newest copy wins //@stale
            }
            if (entry.value() == TOMBSTONE && dropTombstones) { //@tombstone
                continue; // nothing older is left to hide //@dropped
            }
            out.add(entry);
        }
    }
    // endregion
}
