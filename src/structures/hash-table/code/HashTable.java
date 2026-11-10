/** A set of whole numbers from 0 up, with separate chaining. */
public class HashTable {
    static class Node {
        final int key;
        Node next; // the next node in the same bucket

        Node(int key) {
            this.key = key;
        }
    }

    private Node[] buckets = emptyBuckets(8);
    private int size;

    private static Node[] emptyBuckets(int count) {
        Node[] heads = new Node[count];
        for (int b = 0; b < count; b++) {
            heads[b] = new Node(-1); // a dummy head: its key is never read
        }
        return heads;
    }

    // region find
    /** Returns the node before key, or the chain's tail. */
    private Node find(int key) {
        // The key is its own hash. Real tables scramble it.
        Node prev = buckets[key % buckets.length]; //@bucket
        // Each bucket is a dummy head, so prev always exists.
        while (prev.next != null) {
            if (prev.next.key == key) { //@scan
                return prev; //@hit
            }
            prev = prev.next; //@next
        }
        return prev;
    }
    // endregion

    // region search
    public boolean search(int key) {
        Node prev = find(key);
        return prev.next != null; //@result
    }
    // endregion

    // region insert
    public boolean insert(int key) {
        Node prev = find(key);
        if (prev.next != null) {
            return false; //@duplicate
        }
        prev.next = new Node(key); //@append
        size++;
        // Grow when keys / buckets passes 3/4.
        if (size * 4 > buckets.length * 3) { //@load
            resize();
        }
        return true; //@done
    }
    // endregion

    // region resize
    /** Double the array and hash every key again. */
    private void resize() {
        Node[] old = buckets;
        buckets = emptyBuckets(old.length * 2); //@grow
        // The last node of each new chain.
        Node[] tails = buckets.clone();
        for (Node head : old) {
            Node node = head.next;
            while (node != null) {
                Node after = node.next;
                node.next = null;
                int b = node.key % buckets.length; //@rehash
                tails[b].next = node; //@rehash
                tails[b] = node;
                node = after;
            }
        }
    }
    // endregion

    // region delete
    public boolean delete(int key) {
        Node prev = find(key);
        if (prev.next == null) {
            return false; //@missing
        }
        prev.next = prev.next.next; //@unlink
        size--;
        return true; // the table never shrinks //@done
    }
    // endregion
}
