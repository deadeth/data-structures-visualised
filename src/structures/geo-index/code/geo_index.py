import bisect

SIZE = 8  # the map is 8 by 8 cells
BITS = 6  # 3 bits of x and 3 of y pick one cell
# The query's own block first, then its 8 neighbours.
BLOCKS = ((0, 0), (-1, 1), (0, 1), (1, 1), (-1, 0), (1, 0),
          (-1, -1), (0, -1), (1, -1))


# region encode
def encode(x, y, bits=BITS):
    """Halve the map, x then y in turn, one bit per halving."""
    x_lo, x_hi, y_lo, y_hi = 0, SIZE, 0, SIZE
    code = 0
    for i in range(bits):
        if i % 2 == 0:
            mid = (x_lo + x_hi) // 2
            bit = 1 if x >= mid else 0  #@test_x
            x_lo, x_hi = (mid, x_hi) if bit else (x_lo, mid)
        else:
            mid = (y_lo + y_hi) // 2
            bit = 1 if y >= mid else 0  #@test_y
            y_lo, y_hi = (mid, y_hi) if bit else (y_lo, mid)
        code = code << 1 | bit  #@append
    return code
# endregion


class GeoHash:
    """Points kept in one list, sorted by their cell code."""

    def __init__(self):
        self.entries = []  # (code, name), sorted
        self.where = {}  # name -> (x, y)

    # region insert
    def insert(self, name, x, y):  #@start
        """Store a point under its cell code."""
        if (x, y) in self.where.values():
            return False  #@taken
        code = encode(x, y)  #@encode
        i = bisect.bisect_left(self.entries, (code, name))  #@slot
        self.entries.insert(i, (code, name))  #@slot
        self.where[name] = (x, y)
        return True  #@inserted
    # endregion

    # region near
    def near(self, qx, qy, r):
        """Points within r of (qx, qy): 9 range scans, then a filter."""
        side, bits = 1, BITS
        while side < r:  #@side
            side, bits = side * 2, bits - 2  #@side
        bx, by = qx - qx % side, qy - qy % side  #@side
        found = []
        for dx, dy in BLOCKS:  #@block
            cx, cy = bx + dx * side, by + dy * side
            if not (0 <= cx < SIZE and 0 <= cy < SIZE):
                continue  # off the map
            lo = encode(cx, cy, bits) << (BITS - bits)  #@prefix
            hi = lo + (1 << (BITS - bits))  #@prefix
            i = bisect.bisect_left(self.entries, (lo, ''))  #@seek
            while i < len(self.entries) and self.entries[i][0] < hi:  #@scan
                name = self.entries[i][1]
                x, y = self.where[name]
                if (x - qx) ** 2 + (y - qy) ** 2 <= r * r:  #@dist
                    found.append(name)
                i += 1
        return found  #@done
    # endregion

    # region box
    def box(self, x1, y1, x2, y2):
        """Points in a box: one range scan from corner to corner."""
        lo, hi = encode(x1, y1), encode(x2, y2)  #@b_corners
        found = []
        i = bisect.bisect_left(self.entries, (lo, ''))  #@b_seek
        while i < len(self.entries) and self.entries[i][0] <= hi:  #@b_scan
            name = self.entries[i][1]
            x, y = self.where[name]
            if x1 <= x <= x2 and y1 <= y <= y2:  #@b_inside
                found.append(name)
            i += 1
        return found  #@b_done
    # endregion

    # region move
    def move(self, name, x, y):  #@m_start
        """Delete under the old code, insert under the new one."""
        if (x, y) in self.where.values():
            return False  #@m_taken
        old = self.where.pop(name)  #@unlink
        i = bisect.bisect_left(self.entries, (encode(*old), name))  #@unlink
        del self.entries[i]  #@unlink
        return self.insert(name, x, y)  #@relink
    # endregion


class Node:
    """A square of the map: a leaf with points, or split in four."""

    def __init__(self, x, y, size):
        self.x, self.y, self.size = x, y, size
        self.points = {}  # name -> (x, y), leaves only
        self.kids = None  # [SW, NW, SE, NE] once split

    # region q_quadrant
    def quadrant(self, x, y):
        """0 SW, 1 NW, 2 SE, 3 NE: the x bit, then the y bit."""
        half = self.size // 2
        east = 1 if x >= self.x + half else 0  #@q_test_x
        north = 1 if y >= self.y + half else 0  #@q_test_y
        return 2 * east + north
    # endregion

    # region q_gap
    def gap2(self, qx, qy):
        """Squared distance from (qx, qy) to the nearest cell here."""
        dx = max(self.x - qx, 0, qx - (self.x + self.size - 1))
        dy = max(self.y - qy, 0, qy - (self.y + self.size - 1))
        return dx * dx + dy * dy
    # endregion

    # region q_overlaps
    def overlaps(self, x1, y1, x2, y2):
        """True when this square and the box share a cell."""
        x_end, y_end = self.x + self.size - 1, self.y + self.size - 1
        return self.x <= x2 and x1 <= x_end and self.y <= y2 and y1 <= y_end
    # endregion


class QuadTree:
    """Squares that split in four when they hold too many points."""

    def __init__(self, capacity=2):
        self.capacity = capacity
        self.root = Node(0, 0, SIZE)
        self.where = {}  # name -> (x, y)

    # region q_insert
    def insert(self, name, x, y):  #@q_start
        """Walk down to a leaf, add the point, split if too full."""
        if (x, y) in self.where.values():
            return False  #@q_taken
        self.where[name] = (x, y)
        node = self.root
        while node.kids:  #@q_descend
            node = node.kids[node.quadrant(x, y)]  #@q_descend
        node.points[name] = (x, y)  #@q_add
        if len(node.points) > self.capacity:  #@q_full
            self.split(node)  #@q_split_call
        return True  #@q_inserted
    # endregion

    # region q_split
    def split(self, node):
        """Hand a leaf's points to four new children."""
        half = node.size // 2
        node.kids = [Node(node.x + e * half, node.y + n * half, half)  #@q_kids
                     for e in (0, 1) for n in (0, 1)]  #@q_kids
        for name, (x, y) in node.points.items():
            node.kids[node.quadrant(x, y)].points[name] = (x, y)  #@q_hand
        node.points = {}
        for kid in node.kids:
            if len(kid.points) > self.capacity:  #@q_again
                self.split(kid)  #@q_again
    # endregion

    # region q_near
    def near(self, qx, qy, r):
        """Depth first, skipping boxes further than r from the query."""
        found, stack = [], [self.root]  #@q_begin
        while stack:
            node = stack.pop()  #@q_pop
            if node.kids is None:
                for name, (x, y) in node.points.items():  #@q_leaf
                    if (x - qx) ** 2 + (y - qy) ** 2 <= r * r:  #@q_dist
                        found.append(name)
                continue
            for kid in node.kids:
                if kid.gap2(qx, qy) <= r * r:  #@q_prune
                    stack.append(kid)
        return found  #@q_done
    # endregion

    # region q_box
    def box(self, x1, y1, x2, y2):
        """Visit only the squares that overlap the box."""
        found, stack = [], [self.root]  #@q_box_begin
        while stack:
            node = stack.pop()  #@q_box_pop
            if node.kids is None:
                for name, (x, y) in node.points.items():  #@q_box_leaf
                    if x1 <= x <= x2 and y1 <= y <= y2:  #@q_inside
                        found.append(name)
                continue
            for kid in node.kids:
                if kid.overlaps(x1, y1, x2, y2):  #@q_overlap
                    stack.append(kid)
        return found  #@q_box_done
    # endregion

    # region q_move
    def move(self, name, x, y):  #@q_m_start
        """Remove from the old leaf, insert into the new one."""
        if (x, y) in self.where.values():
            return False  #@q_m_taken
        self.remove(name)  #@q_unlink
        return self.insert(name, x, y)  #@q_reinsert
    # endregion

    # region q_remove
    def remove(self, name):
        """Drop a point; fold four leaves into one if they fit."""
        x, y = self.where.pop(name)
        path = [self.root]
        while path[-1].kids:  #@q_walk
            path.append(path[-1].kids[path[-1].quadrant(x, y)])  #@q_walk
        del path[-1].points[name]  #@q_drop
        for node in reversed(path[:-1]):
            if any(kid.kids for kid in node.kids):
                break  # a child is still split
            points = {}
            for kid in node.kids:
                points.update(kid.points)
            if len(points) > self.capacity:  #@q_merge_test
                break
            node.points, node.kids = points, None  #@q_merge
    # endregion


# region switch
def rebuild(index, kind, capacity=2):
    """Index the same points again, the other way."""
    if kind == 'quadtree':  #@switch
        new = QuadTree(capacity)  #@switch
    else:
        new = GeoHash()  #@switch
    for name, (x, y) in index.where.items():  #@reinsert
        new.insert(name, x, y)  #@reinsert
    return new  #@switched
# endregion
