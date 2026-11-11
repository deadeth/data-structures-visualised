NAMES = "ABC"


class Replica:
    """One replica: a PN-counter and an add-wins observed-remove set."""

    def __init__(self, name):
        self.name = name
        self.p = {r: 0 for r in NAMES}  # increments seen, per replica
        self.n = {r: 0 for r in NAMES}  # decrements seen, per replica
        self.seq = 0  # number of this replica's last dot
        self.entries = {}  # dot -> element, in the order learnt
        self.removed = set()  # tombstones: dots seen removed

    # region inc
    def inc(self):
        """Count one increment, in this replica's own slot."""
        self.p[self.name] += 1  #@inc
    # endregion

    # region dec
    def dec(self):
        """Count one decrement, in this replica's own slot."""
        self.n[self.name] += 1  #@dec
    # endregion

    # region value
    def value(self):
        """Read the counter."""
        return sum(self.p.values()) - sum(self.n.values())  #@value
    # endregion

    # region add
    def add(self, element):
        """Add under a dot no other replica can make."""
        self.seq += 1  #@dot
        dot = (self.name, self.seq)  #@dot
        self.entries[dot] = element  #@store
    # endregion

    # region remove
    def remove(self, element):
        """Tombstone every live dot of element seen here."""
        for dot, e in self.entries.items():  #@scan
            if e == element and dot not in self.removed:  #@test
                self.removed.add(dot)  #@tomb
    # endregion

    # region read
    def elements(self):
        """Read the set: elements with a live dot."""
        return {e for dot, e in self.entries.items()  #@read
                if dot not in self.removed}  #@read
    # endregion

    # region merge
    def merge(self, other):
        """Join other's state into this one."""
        for r in NAMES:  #@start
            if other.p[r] > self.p[r]:  #@max_p
                self.p[r] = other.p[r]  #@take_p
        for r in NAMES:
            if other.n[r] > self.n[r]:  #@max_n
                self.n[r] = other.n[r]  #@take_n
        for dot, e in other.entries.items():
            if dot not in self.entries:  #@has
                self.entries[dot] = e  #@copy
            if dot in other.removed:  #@gone
                self.removed.add(dot)  #@tomb_in
    # endregion


# region sync
def sync(replicas):
    """Merge every replica into every other one."""
    for a in replicas:  #@pair
        for b in replicas:  #@pair
            if a is not b:  #@pair
                a.merge(b)  #@pair
# endregion


# region collect
def collect(replicas):
    """Drop dots that every replica has seen removed."""
    first = replicas[0]
    for dot in list(first.entries):  #@each_tomb
        if dot not in first.removed:  #@each_tomb
            continue
        if all(dot in r.removed for r in replicas):  #@stable
            for r in replicas:  #@drop
                del r.entries[dot]  #@drop
                r.removed.discard(dot)  #@drop
# endregion
