MEM_CAP = 4  # entries the memtable holds before it is flushed
TABLE_CAP = 4  # entries in each SSTable a compaction writes
L0_LIMIT = 4  # level 0 is compacted when it reaches this many tables
L1_LIMIT = 4  # level 1 is compacted when it holds more than this many
RATIO = 4  # each deeper level may hold this many times as many tables
TOMBSTONE = None  # the value a delete writes


class Entry:
    def __init__(self, key, value):
        self.key = key
        self.value = value  # TOMBSTONE if the key was deleted


class SSTable:
    """A sorted file of entries. Never changed once it is written."""

    def __init__(self, entries):
        self.entries = entries
        self.smallest = entries[0].key  # the key range is kept in memory
        self.largest = entries[-1].key


class LSMTree:
    def __init__(self):
        self.memtable = []  # entries sorted by key
        # levels[0] is newest first and its tables may overlap. Each deeper
        # level is one sorted run cut into tables that never overlap.
        self.levels = [[], [], []]

    # region put
    def put(self, key, value):
        """Store a value. Only the memtable is touched."""
        pos, found = self._scan(self.memtable, key)  #@start
        if found:
            self.memtable[pos] = Entry(key, value)  #@overwrite
            return
        # A real store logs the write to disk first.
        self.memtable.insert(pos, Entry(key, value))  #@insert
        if len(self.memtable) == MEM_CAP:  #@no_flush
            self.flush()  #@wrote
    # endregion

    # region delete
    def delete(self, key):
        """Write a tombstone. SSTables are never edited."""
        pos, found = self._scan(self.memtable, key)  #@start
        if found and self.memtable[pos].value is TOMBSTONE:
            return  #@already
        if found:
            self.memtable[pos] = Entry(key, TOMBSTONE)  #@replace
        else:
            # No check that key exists: that would cost reads.
            self.memtable.insert(pos, Entry(key, TOMBSTONE))  #@tombstone
        if len(self.memtable) == MEM_CAP:  #@no_flush
            self.flush()  #@wrote
    # endregion

    # region get
    def get(self, key):
        """The newest value for key, or None."""
        pos, found = self._scan(self.memtable, key)  #@start
        if found:
            return self.memtable[pos].value  #@mem_hit
        # L0 tables overlap, so try each one, newest first.
        for table in self.levels[0]:  #@l0
            if self._side(table, key) == 0:
                pos, found = self._scan(table.entries, key)
                if found:
                    return table.entries[pos].value  #@l0_hit
        # Deeper levels: one table at most can hold key.
        for tables in self.levels[1:]:
            table = self._find_table(tables, key)  #@level
            if table:
                pos, found = self._scan(table.entries, key)
                if found:
                    return table.entries[pos].value  #@deep_hit
        return None  #@miss
    # endregion

    # region find_table
    def _find_table(self, tables, key):
        """Binary search a level for the table covering key."""
        lo, hi = 0, len(tables) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            side = self._side(tables[mid], key)
            if side == 0:
                return tables[mid]
            if side < 0:
                hi = mid - 1
            else:
                lo = mid + 1
        return None

    @staticmethod
    def _side(table, key):
        """-1 if key is below the table's range, 1 if above."""
        if key < table.smallest:  #@range_lo
            return -1
        if key > table.largest:  #@range_hi
            return 1
        return 0
    # endregion

    # region scan
    @staticmethod
    def _scan(entries, key):
        """Where key is in sorted entries, or would go."""
        # Linear, as animated. A real memtable is a skip list
        # and a real SSTable has an index and a Bloom filter.
        pos = 0
        while pos < len(entries) and entries[pos].key < key:  #@scan
            pos += 1
        found = pos < len(entries) and entries[pos].key == key
        return pos, found
    # endregion

    # region flush
    def flush(self):
        """Write the memtable out as a new L0 SSTable."""
        if not self.memtable:
            return  #@flush_empty
        table = SSTable(self.memtable)  #@flush_write
        self.levels[0].insert(0, table)  # newest first  #@flush_l0
        self.memtable = []  #@flush_l0
        self._settle()  #@flush_done
    # endregion

    # region settle
    def _settle(self):
        """Run the compactions the level limits call for."""
        if len(self.levels[0]) >= L0_LIMIT:  #@l0_full
            self._compact_level(0)
        self._cascade()
    # endregion

    # region cascade
    def _cascade(self):
        """Merge down each deeper level over its limit."""
        level, limit = 1, L1_LIMIT
        while level < len(self.levels):  # may grow as we go
            if len(self.levels[level]) > limit:  #@over_limit
                self._compact_level(level)
            level, limit = level + 1, limit * RATIO
    # endregion

    # region compact
    def compact(self):
        """Merge the shallowest level with tables downwards."""
        bottom = len(self.levels) - 1
        level = 0
        while level < bottom and not self.levels[level]:
            level += 1
        if level == bottom:
            return  # the last level has nowhere to go  #@nothing
        self._compact_level(level)  #@pick
        self._cascade()  #@compact_done
    # endregion

    # region compact_level
    def _compact_level(self, level):
        """Merge a whole level into the level below it."""
        # Real engines pick one table and its overlaps below.
        below = level + 1
        if below == len(self.levels):
            self.levels.append([])  # the tree grows a level
        last = below == len(self.levels) - 1
        upper, lower = self.levels[level], self.levels[below]
        # Runs, newest first. Each L0 table is its own run.
        if level == 0:
            runs = [table.entries for table in upper]  #@runs_l0
        else:
            runs = [self._entries(upper)]  #@runs_level
        if lower:
            runs.append(self._entries(lower))  #@runs_below
        # A tombstone must not be moved into the last level.
        tombstones = any(e.value is TOMBSTONE for e in runs[0])
        if len(runs) == 1 and not (last and tombstones):  #@lone_run
            # One sorted run, nothing below: move the files.
            self.levels[level], self.levels[below] = [], upper  #@move
            return
        merged = self._merge(runs, drop_tombstones=last)  #@merge
        fresh = []
        for i in range(0, len(merged), TABLE_CAP):  #@cut
            fresh.append(SSTable(merged[i:i + TABLE_CAP]))  #@cut
        self.levels[level], self.levels[below] = [], fresh  #@cut

    @staticmethod
    def _entries(tables):
        return [e for table in tables for e in table.entries]
    # endregion

    # region merge
    @staticmethod
    def _merge(runs, drop_tombstones):
        """Merge sorted runs, newest first, into one run."""
        heads = [0] * len(runs)  # next unread entry of each run
        out = []
        while True:
            # Find the smallest head. Many runs want a heap.
            best, smallest, ties = None, None, []
            for r, run in enumerate(runs):
                if heads[r] == len(run):
                    continue  # this run is used up
                key = run[heads[r]].key
                if best is None or key < smallest:  #@smallest
                    best, smallest, ties = r, key, []  #@smallest
                elif key == smallest:
                    ties.append(r)  # an older copy of the key
            if best is None:
                return out
            entry = runs[best][heads[best]]
            heads[best] += 1
            for r in ties:
                heads[r] += 1  # the newest copy wins  #@stale
            if entry.value is TOMBSTONE and drop_tombstones:  #@tombstone
                continue  # nothing older is left to hide  #@dropped
            out.append(entry)  #@emit
    # endregion
