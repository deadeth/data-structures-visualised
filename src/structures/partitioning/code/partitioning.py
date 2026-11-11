from bisect import insort

CITIES = ("Lima", "Oslo", "Rome")
SPLIT_MIN = 4  # fewer rows than this is not worth splitting


def add(index, term, key):
    """Put key under term in an index."""
    insort(index.setdefault(term, []), key)


def drop(index, term, key):
    """Take key out from under term."""
    index[term].remove(key)
    if not index[term]:
        del index[term]


class Partition:
    """A slice of the table, with a local index on city."""

    def __init__(self, lo, node):
        self.lo = lo  # smallest key it owns (range scheme only)
        self.node = node
        self.rows = {}  # key -> city
        self.index = {}  # local index: city -> sorted keys


class Table:
    """Rows split by key range or by hash, indexed by city."""

    def __init__(self, scheme="range", index="local", nodes=3,
                 bounds=(0, 350, 700), terms=("A", "M", "P")):
        self.scheme = scheme
        self.index = index
        self.nodes = nodes
        if scheme == "range":
            self.parts = [Partition(lo, i) for i, lo in enumerate(bounds)]
        else:
            # Fixed for the life of the table: two per starting node.
            self.parts = [Partition(None, p % nodes)
                          for p in range(2 * nodes)]
        self.terms = list(terms)  # first letter of each index partition
        self.glob = [{} for _ in terms]  # index partition i is on node i

    # region route
    def route(self, key):
        """The partition that owns key."""
        if self.scheme == "hash":
            h = (37 * key + 11) % 100  #@hash
            return self.parts[h % len(self.parts)]  #@mod
        for i in range(len(self.parts) - 1):
            if key < self.parts[i + 1].lo:  #@boundary
                return self.parts[i]  #@boundary
        return self.parts[-1]  #@last
    # endregion

    # region term_part
    def term_part(self, city):
        """The global index partition that owns a city."""
        for i in range(len(self.terms) - 1):
            if city < self.terms[i + 1]:  #@term_cmp
                return i  #@term_cmp
        return len(self.terms) - 1  #@term_last
    # endregion

    # region put
    def put(self, key, city):
        """Store a row and index it by city."""
        part = self.route(key)  #@route
        if key in part.rows:
            return False  #@exists
        part.rows[key] = city  #@write
        if self.index == "local":
            add(part.index, city, key)  #@local
        else:
            g = self.term_part(city)  #@term
            # A real store sends this asynchronously.
            add(self.glob[g], city, key)  #@global
        return True  #@done
    # endregion

    # region get
    def get(self, key):
        """The city of key, or None."""
        part = self.route(key)  #@route
        return part.rows.get(key)  #@lookup
    # endregion

    # region scan
    def scan(self, lo, hi):
        """Keys from lo to hi inclusive, in order."""
        if self.scheme == "hash":
            found = []
            for part in self.parts:  #@scatter
                found += [k for k in part.rows if lo <= k <= hi]  #@scatter
            return sorted(found)  #@gather
        i = self.parts.index(self.route(lo))  #@first
        found = []
        while True:
            part = self.parts[i]
            found += sorted(k for k in part.rows if lo <= k <= hi)  #@collect
            i += 1
            if i == len(self.parts) or self.parts[i].lo > hi:  #@next_part
                return found  #@done_scan
    # endregion

    # region find
    def find(self, city):
        """Keys of the rows in city, in order."""
        if self.index == "local":
            found = []
            for part in self.parts:  #@ask_local
                found += part.index.get(city, [])  #@ask_local
            return sorted(found)  #@merge
        g = self.term_part(city)  #@term
        return list(self.glob[g].get(city, []))  #@postings
    # endregion

    # region hot
    def write_events(self, start, count=4):
        """Timestamps as keys: each one more than the last."""
        for t in range(start, start + count):
            self.put(t, CITIES[t % 3])  #@sequential

    def write_prefixed(self, time, sensors=(1, 4, 7)):
        """The sensor number leads and the time follows."""
        for i, sensor in enumerate(sensors):
            key = sensor * 100 + time % 100  #@prefix
            self.put(key, CITIES[i])  #@spread
    # endregion

    # region rebalance
    def rebalance(self, join=True):
        """Maybe add a node, then even out the load."""
        if join:
            self.nodes += 1  #@join
        if self.scheme == "range":
            return self.split()  #@split_call
        return self.move_partitions()  #@move_call
    # endregion

    # region split
    def split(self):
        """Split the fullest range partition at its median."""
        part = max(self.parts, key=lambda p: len(p.rows))  #@fullest
        if len(part.rows) < SPLIT_MIN:
            return None  #@fullest
        node = self.least_loaded()  #@pick_node
        keys = sorted(part.rows)
        mid = keys[len(keys) // 2]  #@median
        new = Partition(mid, node)  #@new_part
        for k in keys[len(keys) // 2:]:
            city = part.rows.pop(k)  #@move
            new.rows[k] = city  #@move
            if self.index == "local":
                drop(part.index, city, k)  #@move
                add(new.index, city, k)  #@move
        self.parts.insert(self.parts.index(part) + 1, new)  #@new_part
        return new  #@done_split
    # endregion

    # region least_loaded
    def least_loaded(self):
        """The node holding the fewest rows."""
        load = [0] * self.nodes
        for part in self.parts:
            load[part.node] += len(part.rows)
        return load.index(min(load))  #@pick_node
    # endregion

    # region move_partitions
    def move_partitions(self):
        """Hand whole partitions from the busiest node to the idlest."""
        moved = 0
        while True:
            count = [0] * self.nodes
            for part in self.parts:
                count[part.node] += 1
            busy = count.index(max(count))
            idle = count.index(min(count))
            if count[busy] - count[idle] <= 1:  #@balanced
                return moved  #@balanced
            mine = [p for p in self.parts if p.node == busy]
            # Only the owner changes: no key is hashed again.
            mine[-1].node = idle  #@steal
            moved += 1  #@steal
    # endregion
