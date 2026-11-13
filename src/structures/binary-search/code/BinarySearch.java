import java.util.Arrays;

/** An array of integers searched by halving. It must be sorted. */
public class BinarySearch {
    private int[] items = new int[0];

    public int[] items() {
        return items;
    }

    // region load_sorted
    /** Replace the contents with these numbers, sorted. */
    public void loadSorted(int[] numbers) {
        items = numbers.clone(); //@load_sorted
        Arrays.sort(items); //@load_sorted
    }
    // endregion

    // region load
    /** Replace the contents as given. Nothing checks the order. */
    public void load(int[] numbers) {
        items = numbers.clone(); //@load
    }
    // endregion

    // region find
    /** Index of key, or -1 if it is not here. */
    public int find(int key) {
        int[] a = items;
        int lo = 0, hi = a.length - 1; //@init
        while (lo <= hi) { //@loop
            // Not (lo + hi) / 2: past 2^31 - 1 that sum overflows.
            int mid = lo + (hi - lo) / 2; //@mid
            if (a[mid] == key) { //@test
                return mid; //@found
            }
            if (a[mid] < key) { //@test
                lo = mid + 1; //@go_right
            } else {
                hi = mid - 1; //@go_left
            }
        }
        return -1; //@missing
    }
    // endregion

    // region lower_bound
    /** First index whose item is at least key, or length if none is. */
    public int lowerBound(int key) {
        int[] a = items;
        int lo = 0, hi = a.length; //@lb_init
        while (lo < hi) { //@lb_loop
            int mid = lo + (hi - lo) / 2; //@lb_mid
            if (a[mid] < key) { //@lb_test
                lo = mid + 1; //@lb_right
            } else {
                hi = mid; //@lb_left
            }
        }
        return lo; //@lb_done
    }
    // endregion
}
