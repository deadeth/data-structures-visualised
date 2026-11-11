EVEN = [[2, 5, 1], [4, 2, 6], [1, 4, 2]]
USERS = [(1, "UK"), (2, "FR"), (4, "IT")]


class MapReduce:
    """MapReduce phases, run in one process."""

    def __init__(self, reducers=2):
        self.reducers = reducers
        self.blocks = [list(b) for b in EVEN]  # user id of each click
        self.users = list(USERS)  # (user id, country)

    # region partition
    def partition(self, key):
        """The reducer that owns this key."""
        h = (31 * key + 7) % 1009  #@hash
        return h % self.reducers  #@partition
    # endregion

    # region count
    def count(self):
        """Clicks per user, as [user, total] pairs."""
        runs = []
        for block in self.blocks:  #@job
            out = []
            for user in block:  #@read
                out.append((self.partition(user), user, 1))  #@emit
            out.sort()  # by reducer, then key  #@sort
            runs.append(out)  # on the mapper's local disk
        totals = []
        for r in range(self.reducers):
            mine = [[p for p in run if p[0] == r] for run in runs]  #@fetch
            totals.extend(sum_by_key(merge(mine)))  #@group
        return totals  #@write
    # endregion

    # region sort_merge_join
    def sort_merge_join(self):
        """Reduce-side join of clicks with users."""
        runs = []
        for block in self.blocks:  #@job
            out = []
            for user in block:  #@read
                out.append((self.partition(user), user, 1, ""))  #@emit
            out.sort()  #@sort
            runs.append(out)
        rows = []
        for user, country in self.users:
            # Tag 0 sorts a user row before its clicks.
            rows.append((self.partition(user), user, 0, country))  #@emit_user
        rows.sort()  #@sort
        runs.append(rows)
        joined = []
        for r in range(self.reducers):
            mine = [[t for t in run if t[0] == r] for run in runs]  #@fetch
            joined.extend(join_sorted(merge(mine)))  #@group
        return joined  #@write
    # endregion

    # region broadcast_join
    def broadcast_join(self):
        """Map-side join: every map task holds all users."""
        joined = []
        for block in self.blocks:  #@job
            table = dict(self.users)  #@load
            for user in block:  #@read
                country = table.get(user)  #@lookup
                if country is None:  #@lookup
                    continue  #@drop
                joined.append((user, country))  #@joined
        # No shuffle, no sort and no reducers.
        return joined  #@write
    # endregion

    # region skew
    def hot_input(self, hot):
        """One user makes 7 of the 9 clicks."""
        a, b = [u for u in (2, 5, 4) if u != hot][:2]
        self.blocks = [[hot, hot, a], [hot, hot, hot], [b, hot, hot]]  #@hot

    def reducer_loads(self):
        """Pairs each reducer receives in a count."""
        loads = [0] * self.reducers
        for block in self.blocks:  #@read
            for user in block:
                loads[self.partition(user)] += 1  #@load_up
        return loads  #@imbalance
    # endregion

    # region reset
    def even_input(self):
        """Back to the even input."""
        self.blocks = [list(b) for b in EVEN]  #@reset
    # endregion


# region merge
def merge(runs):
    """Merge sorted runs, smallest head first."""
    runs = [list(run) for run in runs]
    out = []
    while True:
        best = None
        for i, run in enumerate(runs):
            if not run:
                continue
            if best is None:
                best = i
            elif run[0] < runs[best][0]:  #@cmp
                best = i  #@new_best
        if best is None:
            return out  #@merged
        # Hadoop keeps the heads in a heap.
        out.append(runs[best].pop(0))  #@take
# endregion


# region reduce_count
def sum_by_key(merged):
    """Total each run of equal keys in one pass."""
    totals = []
    for _, key, one in merged:  #@group
        if totals and totals[-1][0] == key:  #@same
            totals[-1][1] += one  #@sum
        else:
            totals.append([key, one])  #@new_key
    return totals
# endregion


# region reduce_join
def join_sorted(merged):
    """One pass: a user row comes just before its clicks."""
    joined = []
    current, country = None, None
    for _, key, tag, value in merged:  #@group
        if key != current:
            current, country = key, None
        if tag == 0:  #@user_first
            country = value  #@remember
        elif country is None:  #@match
            continue  #@drop
        else:
            joined.append((key, country))  #@joined
    return joined
# endregion
