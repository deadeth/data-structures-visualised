/** First in, first out, on a singly linked list. */
public class FifoQueue {
    static class Node {
        final int key;
        Node next; // the node that joined after this one

        Node(int key) {
            this.key = key;
        }
    }

    private Node head; // the front: the next node to leave
    private Node tail; // the back: the node that joined last
    private int size;

    // region enqueue
    public void enqueue(int key) {
        Node node = new Node(key); //@node
        if (tail == null) { // the queue is empty
            head = node; //@first
        } else {
            tail.next = node; //@link
        }
        tail = node; //@tail
        size++; //@count
    }
    // endregion

    // region dequeue
    /** Returns null when the queue is empty. */
    public Integer dequeue() {
        if (head == null) {
            return null; //@empty
        }
        Node node = head; //@front
        head = node.next; //@advance
        if (head == null) { // that was the last node
            tail = null; //@clear_tail
        }
        size--; //@count
        return node.key; //@count
    }
    // endregion

    // region peek
    /** Returns null when the queue is empty. */
    public Integer peek() {
        if (head == null) {
            return null; //@empty
        }
        return head.key; //@front
    }
    // endregion

    public int size() {
        return size;
    }
}
