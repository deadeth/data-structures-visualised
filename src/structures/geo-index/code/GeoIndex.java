import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Two geospatial indexes over one 8 by 8 map: geohash and quadtree. */
public class GeoIndex {
    static final int SIZE = 8; // the map is 8 by 8 cells
    static final int BITS = 6; // 3 bits of x and 3 of y pick one cell
    // The query's own block first, then its 8 neighbours.
    static final int[][] BLOCKS = {{0, 0}, {-1, 1}, {0, 1}, {1, 1},
        {-1, 0}, {1, 0}, {-1, -1}, {0, -1}, {1, -1}};

    record Pos(int x, int y) {}

    // region encode
    static int encode(int x, int y, int bits) {
        int xLo = 0, xHi = SIZE, yLo = 0, yHi = SIZE;
        int code = 0;
        for (int i = 0; i < bits; i++) {
            int bit;
            if (i % 2 == 0) {
                int mid = (xLo + xHi) / 2;
                bit = x >= mid ? 1 : 0; //@test_x
                if (bit == 1) xLo = mid; else xHi = mid;
            } else {
                int mid = (yLo + yHi) / 2;
                bit = y >= mid ? 1 : 0; //@test_y
                if (bit == 1) yLo = mid; else yHi = mid;
            }
            code = code << 1 | bit; //@append
        }
        return code;
    }
    // endregion

    static int encode(int x, int y) {
        return encode(x, y, BITS);
    }

    /** Points kept in one map, sorted by their cell code. */
    static final class GeoHash {
        // One point per cell on this page, so the code alone is the key.
        final TreeMap<Integer, String> entries = new TreeMap<>();
        final Map<String, Pos> where = new LinkedHashMap<>();

        // region insert
        boolean insert(String name, int x, int y) { //@start
            if (where.containsValue(new Pos(x, y))) {
                return false; //@taken
            }
            int code = encode(x, y); //@encode
            entries.put(code, name); //@slot
            where.put(name, new Pos(x, y));
            return true; //@inserted
        }
        // endregion

        // region near
        List<String> near(int qx, int qy, int r) {
            int side = 1, bits = BITS;
            while (side < r) { //@side
                side *= 2; //@side
                bits -= 2; //@side
            }
            int bx = qx - qx % side, by = qy - qy % side; //@side
            List<String> found = new ArrayList<>();
            for (int[] d : BLOCKS) { //@block
                int cx = bx + d[0] * side, cy = by + d[1] * side;
                if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) {
                    continue; // off the map
                }
                int lo = encode(cx, cy, bits) << (BITS - bits); //@prefix
                int hi = lo + (1 << (BITS - bits)); //@prefix
                var range = entries.subMap(lo, hi); //@seek
                for (String name : range.values()) { //@scan
                    Pos p = where.get(name);
                    int dx = p.x() - qx, dy = p.y() - qy;
                    if (dx * dx + dy * dy <= r * r) { //@dist
                        found.add(name);
                    }
                }
            }
            return found; //@done
        }
        // endregion

        // region box
        List<String> box(int x1, int y1, int x2, int y2) {
            int lo = encode(x1, y1), hi = encode(x2, y2); //@b_corners
            List<String> found = new ArrayList<>();
            var range = entries.subMap(lo, true, hi, true); //@b_seek
            for (String name : range.values()) { //@b_scan
                Pos p = where.get(name);
                if (x1 <= p.x() && p.x() <= x2
                        && y1 <= p.y() && p.y() <= y2) { //@b_inside
                    found.add(name);
                }
            }
            return found; //@b_done
        }
        // endregion

        // region move
        boolean move(String name, int x, int y) { //@m_start
            if (where.containsValue(new Pos(x, y))) {
                return false; //@m_taken
            }
            Pos old = where.remove(name); //@unlink
            entries.remove(encode(old.x(), old.y())); //@unlink
            return insert(name, x, y); //@relink
        }
        // endregion
    }

    /** A square of the map: a leaf with points, or split in four. */
    static final class Node {
        final int x, y, size;
        Map<String, Pos> points = new LinkedHashMap<>(); // leaves only
        Node[] kids; // SW, NW, SE, NE once split

        Node(int x, int y, int size) {
            this.x = x;
            this.y = y;
            this.size = size;
        }

        // region q_quadrant
        int quadrant(int px, int py) {
            int half = size / 2;
            int east = px >= x + half ? 1 : 0; //@q_test_x
            int north = py >= y + half ? 1 : 0; //@q_test_y
            return 2 * east + north;
        }
        // endregion

        // region q_gap
        int gap2(int qx, int qy) {
            int dx = Math.max(Math.max(x - qx, 0), qx - (x + size - 1));
            int dy = Math.max(Math.max(y - qy, 0), qy - (y + size - 1));
            return dx * dx + dy * dy;
        }
        // endregion

        // region q_overlaps
        boolean overlaps(int x1, int y1, int x2, int y2) {
            int xEnd = x + size - 1, yEnd = y + size - 1;
            return x <= x2 && x1 <= xEnd && y <= y2 && y1 <= yEnd;
        }
        // endregion
    }

    /** Squares that split in four when they hold too many points. */
    static final class QuadTree {
        final int capacity;
        final Node root = new Node(0, 0, SIZE);
        final Map<String, Pos> where = new LinkedHashMap<>();

        QuadTree(int capacity) {
            this.capacity = capacity;
        }

        // region q_insert
        boolean insert(String name, int x, int y) { //@q_start
            if (where.containsValue(new Pos(x, y))) {
                return false; //@q_taken
            }
            where.put(name, new Pos(x, y));
            Node node = root;
            while (node.kids != null) { //@q_descend
                node = node.kids[node.quadrant(x, y)]; //@q_descend
            }
            node.points.put(name, new Pos(x, y)); //@q_add
            if (node.points.size() > capacity) { //@q_full
                split(node); //@q_split_call
            }
            return true; //@q_inserted
        }
        // endregion

        // region q_split
        void split(Node node) {
            int half = node.size / 2;
            node.kids = new Node[4]; //@q_kids
            for (int q = 0; q < 4; q++) { //@q_kids
                int e = q / 2, n = q % 2;
                node.kids[q] = new Node(node.x + e * half, //@q_kids
                        node.y + n * half, half); //@q_kids
            }
            for (var p : node.points.entrySet()) {
                Pos at = p.getValue();
                int q = node.quadrant(at.x(), at.y()); //@q_hand
                node.kids[q].points.put(p.getKey(), at); //@q_hand
            }
            node.points = new LinkedHashMap<>();
            for (Node kid : node.kids) {
                if (kid.points.size() > capacity) { //@q_again
                    split(kid); //@q_again
                }
            }
        }
        // endregion

        // region q_near
        List<String> near(int qx, int qy, int r) {
            List<String> found = new ArrayList<>(); //@q_begin
            List<Node> stack = new ArrayList<>(List.of(root)); //@q_begin
            while (!stack.isEmpty()) {
                Node node = stack.remove(stack.size() - 1); //@q_pop
                if (node.kids == null) {
                    for (var p : node.points.entrySet()) { //@q_leaf
                        int dx = p.getValue().x() - qx;
                        int dy = p.getValue().y() - qy;
                        if (dx * dx + dy * dy <= r * r) { //@q_dist
                            found.add(p.getKey());
                        }
                    }
                    continue;
                }
                for (Node kid : node.kids) {
                    if (kid.gap2(qx, qy) <= r * r) { //@q_prune
                        stack.add(kid);
                    }
                }
            }
            return found; //@q_done
        }
        // endregion

        // region q_box
        List<String> box(int x1, int y1, int x2, int y2) {
            List<String> found = new ArrayList<>(); //@q_box_begin
            List<Node> stack = new ArrayList<>(List.of(root)); //@q_box_begin
            while (!stack.isEmpty()) {
                Node node = stack.remove(stack.size() - 1); //@q_box_pop
                if (node.kids == null) {
                    for (var p : node.points.entrySet()) { //@q_box_leaf
                        Pos at = p.getValue();
                        if (x1 <= at.x() && at.x() <= x2
                                && y1 <= at.y() && at.y() <= y2) { //@q_inside
                            found.add(p.getKey());
                        }
                    }
                    continue;
                }
                for (Node kid : node.kids) {
                    if (kid.overlaps(x1, y1, x2, y2)) { //@q_overlap
                        stack.add(kid);
                    }
                }
            }
            return found; //@q_box_done
        }
        // endregion

        // region q_move
        boolean move(String name, int x, int y) { //@q_m_start
            if (where.containsValue(new Pos(x, y))) {
                return false; //@q_m_taken
            }
            remove(name); //@q_unlink
            return insert(name, x, y); //@q_reinsert
        }
        // endregion

        // region q_remove
        void remove(String name) {
            Pos at = where.remove(name);
            List<Node> path = new ArrayList<>(List.of(root));
            Node node = root;
            while (node.kids != null) { //@q_walk
                node = node.kids[node.quadrant(at.x(), at.y())]; //@q_walk
                path.add(node); //@q_walk
            }
            node.points.remove(name); //@q_drop
            for (int i = path.size() - 2; i >= 0; i--) {
                Node up = path.get(i);
                Map<String, Pos> all = new LinkedHashMap<>();
                boolean leaves = true;
                for (Node kid : up.kids) {
                    if (kid.kids != null) leaves = false;
                    all.putAll(kid.points);
                }
                if (!leaves) break; // a child is still split
                if (all.size() > capacity) { //@q_merge_test
                    break;
                }
                up.points = all; //@q_merge
                up.kids = null; //@q_merge
            }
        }
        // endregion
    }

    // region switch
    /** Index the same points again, the other way. */
    static Object rebuild(Map<String, Pos> where, String kind, int cap) {
        if (kind.equals("quadtree")) { //@switch
            QuadTree tree = new QuadTree(cap); //@switch
            where.forEach((n, p) -> tree.insert(n, p.x(), p.y())); //@reinsert
            return tree; //@switched
        }
        GeoHash hash = new GeoHash(); //@switch
        where.forEach((n, p) -> hash.insert(n, p.x(), p.y())); //@reinsert
        return hash; //@switched
    }
    // endregion
}
