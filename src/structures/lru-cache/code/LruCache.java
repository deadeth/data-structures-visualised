import java.util.HashMap;
import java.util.Map;

public class LruCache {
    /** One cached entry, and a link in the list ordered by last use. */
    private static final class Node {
        final int key;
        int value;
        Node prev; // towards the head: used more recently
        Node next; // towards the tail: used less recently

        Node(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final Map<Integer, Node> map = new HashMap<>();
    private Node head; // most recently used
    private Node tail; // least recently used: the next to be evicted

    public LruCache(int capacity) {
        this.capacity = Math.max(1, capacity);
    }

    // region get
    /** The value for key, or null on a miss. */
    public Integer get(int key) {
        Node node = map.get(key); //@lookup
        if (node == null) { //@check
            return null; //@miss
        }
        // Being read makes it the most recent.
        if (node != head) { //@is_head
            unlink(node);
            pushFront(node);
        }
        return node.value; //@hit
    }
    // endregion

    // region put
    /** Store key. Returns the evicted key, or null. */
    public Integer put(int key, int value) {
        Node node = map.get(key); //@lookup
        if (node != null) { //@check
            node.value = value; //@refresh
            // A write counts as a use.
            if (node != head) { //@is_head
                unlink(node);
                pushFront(node);
            }
            return null; //@refreshed
        }
        Integer evicted = null;
        if (map.size() >= capacity) { //@room
            Node victim = tail; // least recent: no search //@victim
            unlink(victim);
            // Or the map would point at a node that is gone.
            map.remove(victim.key); //@forget
            evicted = victim.key;
        }
        node = new Node(key, value); //@create
        map.put(key, node); //@create
        pushFront(node);
        return evicted; //@done
    }
    // endregion

    // region unlink
    /** Take a node out of the list: two pointer writes. */
    private void unlink(Node node) {
        if (node.prev != null) {
            node.prev.next = node.next; //@unlink_prev
        } else {
            head = node.next; //@unlink_head
        }
        if (node.next != null) {
            node.next.prev = node.prev; //@unlink_next
        } else {
            tail = node.prev; //@unlink_tail
        }
    }
    // endregion

    // region push_front
    /** Link a node in at the head: four pointer writes. */
    private void pushFront(Node node) {
        node.prev = null; //@aim
        node.next = head; //@aim
        if (head != null) {
            head.prev = node; //@attach_old
        } else {
            tail = node; //@attach_tail
        }
        head = node; //@attach
    }
    // endregion
}
