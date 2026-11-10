import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Singly linked list of unique integers, with head and tail. */
public class SinglyLinkedList {
    // region node
    static class Node {
        final int key;
        Node next; // null marks the end of the list

        Node(int key) {
            this.key = key;
        }
    }
    // endregion

    private Node head;
    private Node tail;
    private int size;
    // Only used to refuse duplicates.
    private final Set<Integer> keys = new HashSet<>();

    public int size() {
        return size;
    }

    public List<Integer> toList() {
        List<Integer> out = new ArrayList<>();
        for (Node node = head; node != null; node = node.next) {
            out.add(node.key);
        }
        return out;
    }

    // region prepend
    /** Add key at the front in two pointer writes. */
    public boolean prepend(int key) { //@page_limit
        // A set on the side: a bare list would have to walk.
        if (keys.contains(key)) { //@check
            return false; //@duplicate
        }
        keys.add(key);
        Node node = new Node(key); //@make
        if (head == null) {
            head = node; //@first
            tail = node; //@first
        } else {
            node.next = head; //@link
            head = node; //@move
        }
        size++;
        return true;
    }
    // endregion

    // region append
    /** Add key at the back: tail saves walking there. */
    public boolean append(int key) { //@page_limit
        // A set on the side: a bare list would have to walk.
        if (keys.contains(key)) { //@check
            return false; //@duplicate
        }
        keys.add(key);
        Node node = new Node(key); //@make
        if (head == null) {
            head = node; //@first
            tail = node; //@first
        } else {
            tail.next = node; //@link
            tail = node; //@move
        }
        size++;
        return true;
    }
    // endregion

    // region search
    /** Walk from the head: a list cannot jump ahead. */
    public boolean search(int key) {
        Node node = head; //@start
        while (node != null) {
            if (node.key == key) { //@compare
                return true; //@found
            }
            node = node.next; //@next
        }
        return false; //@missing
    }
    // endregion

    // region delete
    /** Find key by walking, then unlink its node. */
    public boolean delete(int key) {
        // No back pointers: remember the previous node.
        Node prev = null;
        Node node = head; //@start
        while (node != null && node.key != key) { //@compare
            prev = node; //@next
            node = node.next; //@next
        }
        if (node == null) {
            return false; //@missing
        }
        if (prev == null) {
            head = node.next; //@unlink_head
        } else {
            prev.next = node.next; //@unlink
        }
        if (node.next == null) { // it was the last node
            tail = prev; //@move_tail
        }
        keys.remove(key);
        size--;
        return true; //@done
    }
    // endregion
}
