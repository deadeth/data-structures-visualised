import java.util.Arrays;
import java.util.Random;

/** Top-down merge sort with one buffer the size of the input. */
public class MergeSort {

    // region merge_sort
    /** Sort a in place. Equal items keep their order. */
    public static void mergeSort(int[] a) {
        int[] buf = new int[a.length]; //@buffer
        sort(a, buf, 0, a.length); //@start
    } //@done
    // endregion

    // region sort
    /** Sort a[lo..hi), using the same slots of buf as scratch space. */
    private static void sort(int[] a, int[] buf, int lo, int hi) {
        if (hi - lo < 2) { //@base
            return; //@base
        }
        int mid = (lo + hi) >>> 1; //@split
        sort(a, buf, lo, mid); //@split
        sort(a, buf, mid, hi); //@split
        merge(a, buf, lo, mid, hi); //@merge_call
    }
    // endregion

    // region merge
    /** Merge the sorted runs a[lo..mid) and a[mid..hi) via buf. */
    private static void merge(int[] a, int[] buf, int lo, int mid, int hi) {
        int i = lo, j = mid, k = lo; //@merge_start
        while (i < mid && j < hi) { //@compare
            if (a[i] <= a[j]) { //@compare
                buf[k] = a[i]; // <= takes the left item on a tie //@take_left
                i++; //@take_left
            } else {
                buf[k] = a[j]; //@take_right
                j++; //@take_right
            }
            k++; //@take_left,take_right
        }
        while (i < mid) { // the right run is empty //@rest_left
            buf[k++] = a[i++]; //@rest_left
        }
        while (j < hi) { // the left run is empty //@rest_right
            buf[k++] = a[j++]; //@rest_right
        }
        System.arraycopy(buf, lo, a, lo, hi - lo); //@copy_back
    }
    // endregion

    // region set
    /** The array to sort: values, cut to the page's limit. */
    public static int[] setArray(int[] values, int limit) {
        return Arrays.copyOf(values, Math.min(values.length, limit)); //@set
    }
    // endregion

    // region load
    /** A test input of n items: random, sorted, reversed or equal. */
    public static int[] load(String kind, int n, Random rng) {
        int[] a = new int[n]; //@load_random
        for (int i = 0; i < n; i++) { //@load_random
            a[i] = 1 + rng.nextInt(99); //@load_random
        }
        switch (kind) {
            case "sorted" -> Arrays.sort(a); //@load_sorted
            case "reversed" -> { //@load_reversed
                Arrays.sort(a); //@load_reversed
                for (int i = 0, j = n - 1; i < j; i++, j--) { //@load_reversed
                    int t = a[i]; //@load_reversed
                    a[i] = a[j]; //@load_reversed
                    a[j] = t; //@load_reversed
                }
            }
            case "equal" -> {
                int[] few = Arrays.copyOf(a, Math.min(3, n)); //@load_equal
                for (int i = 0; i < n; i++) { //@load_equal
                    a[i] = few[rng.nextInt(few.length)]; //@load_equal
                }
            }
            default -> { }
        }
        return a; //@load_random,load_sorted,load_reversed,load_equal
    }
    // endregion
}
