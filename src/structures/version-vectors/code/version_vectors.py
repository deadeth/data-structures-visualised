SIBLINGS, LWW = "siblings", "lww"
EQUAL, AHEAD, BEHIND, CONCURRENT = "equal", "ahead", "behind", "concurrent"


class Version:
    """A stored value and the version vector that says what it has seen."""

    def __init__(self, name, cart, vv, ts, writer):
        self.name = name
        self.cart = frozenset(cart)
        self.vv = tuple(vv)  # one counter per replica
        self.ts = ts  # wall-clock time on the writer's clock
        self.writer = writer


START = Version("v0", (), (0, 0, 0), 0, -1)


class Replica:
    """A leader. It holds one version of the key, or several siblings."""

    def __init__(self, skew):
        self.skew = skew  # how far this replica's wall clock is off
        self.versions = [START]


# region compare
def compare(v, w):
    """Compare two version vectors entry by entry."""
    ahead = behind = False
    for mine, theirs in zip(v.vv, w.vv):  #@entry
        if mine > theirs:  #@entry
            ahead = True  #@ahead
        elif mine < theirs:  #@elif
            behind = True  #@behind
    if ahead and behind:  #@concurrent,dominates,covered
        return CONCURRENT  #@concurrent
    if ahead:  #@dominates,covered
        return AHEAD  #@dominates
    return BEHIND if behind else EQUAL  #@covered
# endregion


# region newer
def newer(v, w):
    """Last write wins: the later timestamp, ties to the later replica."""
    return (v.ts, v.writer) > (w.ts, w.writer)  #@lww
# endregion


class Cluster:
    """Three leaders, A, B and C, that each accept writes for one key."""

    def __init__(self, policy=SIBLINGS, skews=(0, 0, -3)):
        self.policy = policy
        self.now = 10  # real time, in ticks
        self.made = 0
        self.replicas = [Replica(s) for s in skews]

    # region stamp
    def stamp(self, cart, vv, r):
        """A new version, timed by the writing replica's own clock."""
        self.now += 1  # the page's clock moves one tick per write
        self.made += 1
        ts = self.now + self.replicas[r].skew  #@stamp
        return Version(f"v{self.made}", cart, vv, ts, r)  #@stamp
    # endregion

    # region write
    def write(self, r, item):
        """A client reads the replica's cart, toggles one item, writes."""
        rep = self.replicas[r]
        if len(rep.versions) > 1:  #@check
            return None  #@refuse
        base = rep.versions[0]  #@read
        cart = base.cart ^ {item}  #@cart
        vv = list(base.vv)  #@bump
        vv[r] += 1  #@bump
        v = self.stamp(cart, vv, r)  #@stamp
        rep.versions = [v]  #@replace
        return v  #@written
    # endregion

    # region replicate
    def replicate(self, src, dst):
        """Send every version src holds to dst."""
        target = self.replicas[dst]
        for v in list(self.replicas[src].versions):  #@each
            keep = True
            for w in list(target.versions):  #@against
                order = compare(v, w)  #@against
                if order in (EQUAL, BEHIND):  #@known
                    keep = False  #@known
                    break  #@known
                if order == AHEAD:  #@supersede
                    target.versions.remove(w)  #@supersede
                elif self.policy == SIBLINGS:  #@sibling
                    continue  #@sibling
                elif newer(v, w):  #@lww
                    target.versions.remove(w)  #@lost_old
                else:
                    keep = False  #@lost_new
                    break  #@lost_new
            if keep:  #@keep
                target.versions.append(v)  #@keep
        return target.versions  #@done
    # endregion

    # region resolve
    def resolve(self, r):
        """A client merges the siblings at a replica into one version."""
        sibs = self.replicas[r].versions
        if len(sibs) < 2:  #@check
            return None  #@nothing
        n = len(sibs[0].vv)
        vv = [max(s.vv[i] for s in sibs) for i in range(n)]  #@max
        cart = frozenset().union(*(s.cart for s in sibs))  #@union
        vv[r] += 1  #@bump
        v = self.stamp(cart, vv, r)  #@stamp
        self.replicas[r].versions = [v]  #@replace
        return v  #@merged
    # endregion

    # region concurrent
    def concurrent(self, x, item_x, y, item_y):
        """Two clients write before either replica hears of the other."""
        self.write(x, item_x)  #@first
        self.write(y, item_y)  #@second
        return self.replicate(x, y)  #@sync
    # endregion

    # region set_policy
    def set_policy(self, policy):
        """Page only: switch the policy and start the key again."""
        self.policy = policy  #@policy
        for rep in self.replicas:  #@reset
            rep.versions = [START]  #@reset
    # endregion
