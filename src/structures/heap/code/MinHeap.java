/** A complete binary tree in an array: no parent is larger than its children. */
public class MinHeap {
    private final int[] items;
    private int size;

    public MinHeap(int capacity) {
        items = new int[capacity];
    }

    // region peek
    /** The smallest key, or null if the heap is empty. */
    public Integer peek() {
        if (size == 0) {
            return null; //@empty
        }
        return items[0]; //@peek
    }
    // endregion

    // region insert
    /** Add key. Returns false if the heap is full. */
    public boolean insert(int key) {
        if (size == items.length) {
            // This page stops at 15 items; a real heap grows.
            return false; //@full
        }
        items[size++] = key; //@append
        siftUp(size - 1);
        return true; //@done
    }
    // endregion

    // region sift_up
    /** Swap upwards until the parent is not larger. */
    private void siftUp(int i) {
        while (i > 0) {
            int parent = (i - 1) / 2; //@parent
            if (items[i] >= items[parent]) { //@compare_up
                break; //@stop_up
            }
            int held = items[i]; //@swap_up
            items[i] = items[parent]; //@swap_up
            items[parent] = held; //@swap_up
            i = parent; //@swap_up
        }
    }
    // endregion

    // region extract_min
    /** Remove and return the smallest key, if any. */
    public Integer extractMin() {
        if (size == 0) {
            return null; //@empty
        }
        int top = items[0]; //@top
        int last = items[--size]; //@last
        if (size > 0) {
            // The last item fills the hole: the shape is kept.
            items[0] = last; //@fill
            siftDown(0);
        }
        return top; //@done
    }
    // endregion

    // region sift_down
    /** Swap downwards until no child is smaller. */
    private void siftDown(int i) {
        while (true) {
            int left = 2 * i + 1; //@children
            if (left >= size) {
                break; //@leaf
            }
            int right = left + 1; //@children
            int child = left;
            if (right < size && items[right] < items[left]) { //@pick
                child = right; //@pick_right
            }
            if (items[i] <= items[child]) { //@compare_down
                break; //@stop_down
            }
            int held = items[i]; //@swap_down
            items[i] = items[child]; //@swap_down
            items[child] = held; //@swap_down
            i = child; //@swap_down
        }
    }
    // endregion
}
