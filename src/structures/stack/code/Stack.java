/** A stack on a plain array that doubles when it fills up. */
public class Stack {
    private Integer[] items = new Integer[4]; // the array: 4 slots to begin with
    private int size = 0; // slots in use; the top item is items[size - 1]

    // region push
    public void push(int key) {
        if (size == items.length) { //@full
            grow();
        }
        items[size] = key; //@write
        size++; //@up
    }
    // endregion

    // region grow
    /** Move every item into an array twice the size. */
    private void grow() {
        // java.util.ArrayList grows like this, by half.
        Integer[] bigger = new Integer[2 * items.length]; //@allocate
        for (int i = 0; i < size; i++) {
            bigger[i] = items[i]; //@copy
        }
        items = bigger; //@swap
    }
    // endregion

    // region pop
    /** Returns null when the stack is empty. */
    public Integer pop() {
        if (size == 0) { //@empty
            return null; //@nothing
        }
        Integer key = items[size - 1]; //@read
        items[size - 1] = null; //@clear
        size--; //@down
        return key;
    }
    // endregion

    // region peek
    /** Returns null when the stack is empty. */
    public Integer peek() {
        if (size == 0) { //@empty
            return null; //@nothing
        }
        return items[size - 1]; //@read
    }
    // endregion

    public int size() {
        return size;
    }

    public int capacity() {
        return items.length;
    }
}
