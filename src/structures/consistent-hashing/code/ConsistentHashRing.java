import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

public class ConsistentHashRing {
    // region hash
    static final int RING = 360; // positions, read as degrees

    /** Where a key sits on the ring. */
    static int hashKey(int key) {
        // 197 shares no factor with 360, so keys spread out.
        return (key * 197 + 61) % RING; //@hash
    }

    /** Degrees travelled going clockwise from a to b. */
    static int clockwise(int a, int b) {
        return Math.floorMod(b - a, RING);
    }
    // endregion

    /** One point on the ring and the server it belongs to. */
    record Point(int pos, String server) {}

    /** Server name to its positions on the ring, in the order servers join. */
    private final Map<String, int[]> table;
    private final int vnodes; // points per server
    private final List<String> servers = new ArrayList<>();
    private final List<Point> points = new ArrayList<>(); // sorted by position
    /** Key to the server that holds it, in key order. */
    private final Map<Integer, String> home = new TreeMap<>();

    public ConsistentHashRing(Map<String, int[]> table, int vnodes, int servers) {
        this.table = table;
        this.vnodes = vnodes;
        for (String name : table.keySet()) {
            if (this.servers.size() == servers) {
                break;
            }
            this.servers.add(name);
            for (int r = 0; r < vnodes; r++) {
                points.add(new Point(table.get(name)[r], name));
            }
        }
        points.sort(Comparator.comparingInt(Point::pos));
    }

    // region locate
    /** Index of the first point at or after pos. */
    private int locate(int pos) {
        // Written out to show each comparison.
        int lo = 0;
        int hi = points.size(); //@search
        while (lo < hi) {
            int mid = (lo + hi) / 2;
            if (pos <= points.get(mid).pos()) { //@compare
                hi = mid; //@earlier
            } else {
                lo = mid + 1; //@later
            }
        }
        if (lo == points.size()) {
            return 0; // none at or after pos: wrap round //@wrap
        }
        return lo; //@owner
    }
    // endregion

    // region lookup
    /** The server that owns key, stored or not. */
    public String lookup(int key) {
        int pos = hashKey(key); //@hash
        Point point = points.get(locate(pos));
        return point.server(); //@found
    }
    // endregion

    // region put
    /** Store key; null if it was already stored. */
    public String put(int key) {
        int pos = hashKey(key); //@hash
        if (home.containsKey(key)) {
            return null; //@duplicate
        }
        Point point = points.get(locate(pos));
        home.put(key, point.server()); //@store
        return point.server();
    }
    // endregion

    // region delete
    /** Remove key; null if it was not stored. */
    public String delete(int key) {
        int pos = hashKey(key); //@hash
        if (!home.containsKey(key)) {
            return null; //@missing
        }
        // Only the owner can hold it: delete there alone.
        Point point = points.get(locate(pos)); //@route
        home.remove(key); //@remove
        return point.server();
    }
    // endregion

    // region add_server
    /** Add the next unused server; return moved keys. */
    public List<Integer> addServer() {
        Optional<String> free = table.keySet().stream()
                .filter(n -> !servers.contains(n)).findFirst();
        if (free.isEmpty()) {
            return null; //@full
        }
        String name = free.get();
        // A real ring hashes "name#0", "name#1"... for these.
        int[] spots = Arrays.copyOf(table.get(name), vnodes); //@join
        Arrays.sort(spots); //@join
        servers.add(name);
        List<Integer> moved = new ArrayList<>();
        for (int pos : spots) {
            int i = locate(pos);
            // That point owns this stretch until now.
            String loser = points.get(i).server();
            // The arc starts after the point before it.
            int before = i == 0 ? points.size() - 1 : i - 1;
            int prev = points.get(before).pos();
            int arc = clockwise(prev, pos);
            points.add(new Point(pos, name)); //@take_arc
            points.sort(Comparator.comparingInt(Point::pos)); //@take_arc
            if (loser.equals(name)) {
                continue; // our own point further on covers it //@covered
            }
            for (int key : home.keySet()) {
                int gap = clockwise(prev, hashKey(key));
                if (0 < gap && gap <= arc) { //@in_arc
                    home.put(key, name); //@move
                    moved.add(key);
                }
            }
        }
        return moved; //@done
    }
    // endregion

    // region remove_server
    /** Take a server off the ring; return moved keys. */
    public List<Integer> removeServer(String name) {
        if (!servers.contains(name)) {
            return null; //@unknown
        }
        if (servers.size() == 1) {
            return null; // its keys would have nowhere to go //@last
        }
        List<Integer> mine = new ArrayList<>();
        for (var held : home.entrySet()) {
            if (held.getValue().equals(name)) {
                mine.add(held.getKey()); //@leave
            }
        }
        servers.remove(name); //@leave
        points.removeIf(p -> p.server().equals(name)); //@leave
        for (int key : mine) {
            // The next point clockwise takes each key.
            Point heir = points.get(locate(hashKey(key)));
            home.put(key, heir.server()); //@rehome
        }
        return mine; //@done
    }
    // endregion
}
