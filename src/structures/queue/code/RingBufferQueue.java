/** Bounded FIFO queue of integers, stored as a ring buffer. */
public class RingBufferQueue {
    // region fields
    private final int capacity;
    private final Integer[] slots; // never grows
    private int head; // index of the oldest item
    private int tail; // index of the next free slot
    // head == tail when empty and also when full.
    private int size; // tells the two apart

    public RingBufferQueue(int capacity) {
        this.capacity = capacity;
        this.slots = new Integer[capacity];
    }
    // endregion

    // region enqueue
    /** Add key at the tail, or refuse it if full. */
    public boolean enqueue(int key) {
        if (size == capacity) { //@check
            return false; //@rejected
        }
        slots[tail] = key; //@write
        tail = (tail + 1) % capacity; //@advance
        size++; //@advance
        return true; //@done
    }
    // endregion

    // region dequeue
    /** Take the oldest item, or null if empty. */
    public Integer dequeue() {
        if (size == 0) { //@check
            return null; //@empty
        }
        Integer key = slots[head]; //@read
        // Optional: head moving on is what removes it.
        slots[head] = null; //@free
        head = (head + 1) % capacity; //@advance
        size--; //@advance
        return key; //@done
    }
    // endregion
}
