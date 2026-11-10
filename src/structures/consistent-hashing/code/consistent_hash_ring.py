from collections import namedtuple

# region hash
RING = 360  # positions on the ring, read as degrees


def hash_key(key):
    """Where a key sits on the ring."""
    # 197 shares no factor with 360, so keys spread out.
    return (key * 197 + 61) % RING  #@hash


def clockwise(a, b):
    """Degrees travelled going clockwise from a to b."""
    return (b - a) % RING
# endregion


# One point on the ring and the server it belongs to. Sorts by position.
Point = namedtuple("Point", "pos server")


class ConsistentHashRing:
    def __init__(self, table, vnodes=1, servers=3):
        self.table = table  # server name -> its positions on the ring
        self.vnodes = vnodes  # points per server
        self.servers = []
        self.points = []  # sorted by position
        self.home = {}  # key -> the server that holds it
        for name in list(table)[:servers]:
            self.servers.append(name)
            self.points += [Point(p, name) for p in table[name][:vnodes]]
        self.points.sort()

    # region locate
    def _locate(self, pos):
        """Index of the first point at or after pos."""
        # Written out to show each comparison, as bisect does.
        lo, hi = 0, len(self.points)  #@search
        while lo < hi:
            mid = (lo + hi) // 2
            if pos <= self.points[mid].pos:  #@compare
                hi = mid  #@earlier
            else:
                lo = mid + 1  #@later
        if lo == len(self.points):
            return 0  # none at or after pos: wrap round  #@wrap
        return lo  #@owner
    # endregion

    # region lookup
    def lookup(self, key):
        """The server that owns key, stored or not."""
        pos = hash_key(key)  #@hash
        point = self.points[self._locate(pos)]
        return point.server  #@found
    # endregion

    # region put
    def put(self, key):
        """Store key; None if it was already stored."""
        pos = hash_key(key)  #@hash
        if key in self.home:
            return None  #@duplicate
        point = self.points[self._locate(pos)]
        self.home[key] = point.server  #@store
        return point.server
    # endregion

    # region delete
    def delete(self, key):
        """Remove key; None if it was not stored."""
        pos = hash_key(key)  #@hash
        if key not in self.home:
            return None  #@missing
        # Only the owner can hold it: delete there alone.
        point = self.points[self._locate(pos)]  #@route
        del self.home[key]  #@remove
        return point.server
    # endregion

    # region add_server
    def add_server(self):
        """Add the next unused server; return moved keys."""
        free = [n for n in self.table if n not in self.servers]
        if not free:
            return None  #@full
        name = free[0]
        # A real ring hashes "name#0", "name#1"... for these.
        spots = sorted(self.table[name][:self.vnodes])  #@join
        self.servers.append(name)
        moved = []
        for pos in spots:
            i = self._locate(pos)
            # That point owns this stretch until now.
            loser = self.points[i].server
            # The arc starts after the point before it.
            prev = self.points[i - 1].pos
            arc = clockwise(prev, pos)
            self.points.append(Point(pos, name))  #@take_arc
            self.points.sort()  #@take_arc
            if loser == name:
                continue  # our own point further on covers it  #@covered
            for key in sorted(self.home):
                gap = clockwise(prev, hash_key(key))
                if 0 < gap <= arc:  #@in_arc
                    self.home[key] = name  #@move
                    moved.append(key)
        return moved  #@done
    # endregion

    # region remove_server
    def remove_server(self, name):
        """Take a server off the ring; return moved keys."""
        if name not in self.servers:
            return None  #@unknown
        if len(self.servers) == 1:
            return None  # its keys would have nowhere to go  #@last
        held = self.home.items()
        mine = sorted(k for k, s in held if s == name)  #@leave
        self.servers.remove(name)  #@leave
        self.points = [  #@leave
            p for p in self.points if p.server != name]  #@leave
        for key in mine:
            # The next point clockwise takes each key.
            heir = self.points[self._locate(hash_key(key))]
            self.home[key] = heir.server  #@rehome
        return mine  #@done
    # endregion
