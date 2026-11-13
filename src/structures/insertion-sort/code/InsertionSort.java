/** An array sorted in place, one insertion at a time. */
public class InsertionSort {
    /** This page draws at most 12 items. */
    static final int LIMIT = 12;

    private int[] items = new int[LIMIT];
    private int size;
    /** items[0..sorted) is in order. */
    private int sorted;

    // region load
    /** Replace the items. One item on its own is sorted. */
    public void load(int[] values) {
        items = values.clone(); //@load
        size = values.length; //@load
        sorted = Math.min(1, size); //@load
    }
    // endregion

    // region sort
    /** Insert each unsorted item in turn. */
    public void sort() {
        while (sorted < size) { //@next
            insertNext();
        }
    }
    // endregion

    // region insert_next
    /** Slide the first unsorted item left to its place. */
    public boolean insertNext() {
        int[] a = items;
        int i = sorted;
        if (i >= size) {
            return false; //@all_sorted
        }
        int key = a[i]; //@lift
        int j = i - 1; //@lift
        while (j >= 0) {
            if (a[j] <= key) { //@compare
                break; //@stop
            }
            a[j + 1] = a[j]; //@shift
            j--; //@shift
        }
        a[j + 1] = key; //@drop
        sorted = i + 1; //@drop
        return true; //@drop
    }
    // endregion

    /** The items, in their current order. */
    public int[] toArray() {
        return java.util.Arrays.copyOf(items, size);
    }
}
