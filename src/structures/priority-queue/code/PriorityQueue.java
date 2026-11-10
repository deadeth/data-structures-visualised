/** The smallest key is the most urgent. A sorted array keeps it last. */
public class PriorityQueue {
    private final Integer[] items; // largest first, smallest last
    private int size = 0;

    public PriorityQueue(int capacity) {
        items = new Integer[capacity];
    }

    // region insert
    public boolean insert(int key) {
        if (size == items.length) {
            return false; //@full
        }
        int lo = 0, hi = size; //@window
        while (lo < hi) { //@meet
            int mid = (lo + hi) / 2; //@mid
            if (key < items[mid]) { //@less
                lo = mid + 1; //@right
            } else if (key > items[mid]) { //@more
                hi = mid; //@left
            } else { // key == items[mid] //@same
                return false; //@duplicate
            }
        }
        for (int i = size; i > lo; i--) { // smaller items move right
            items[i] = items[i - 1]; //@shift
        }
        items[lo] = key; //@place
        size++; //@done
        return true; //@done
    }
    // endregion

    // region pop_min
    /** Returns null when the queue is empty. */
    public Integer popMin() {
        if (size == 0) {
            return null; //@empty
        }
        Integer key = items[size - 1]; //@last
        items[size - 1] = null; //@clear
        size--; //@done
        return key; //@done
    }
    // endregion

    // region peek
    /** Returns null when the queue is empty. */
    public Integer peek() {
        if (size == 0) {
            return null; //@empty
        }
        return items[size - 1]; //@last
    }
    // endregion

    public int size() {
        return size;
    }
}
