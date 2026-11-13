import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Random;

/** Quicksort with a Lomuto partition and an explicit stack. */
public class Quicksort {

    // region quicksort
    /** Sort a in place. */
    public static void quicksort(int[] a, boolean median3) {
        Deque<int[]> stack = new ArrayDeque<>();
        push(stack, 0, a.length - 1); //@start
        while (!stack.isEmpty()) { //@empty
            int[] range = stack.pop(); //@pop
            int lo = range[0], hi = range[1]; //@pop
            int p = partition(a, lo, hi, median3);
            // Push the larger side first, so the smaller is sorted
            // next and the stack stays O(log n) deep.
            if (p - lo > hi - p) { //@left_big,right_big
                push(stack, lo, p - 1); //@left_big
                push(stack, p + 1, hi); //@left_big
            } else {
                push(stack, p + 1, hi); //@right_big
                push(stack, lo, p - 1); //@right_big
            }
        }
    }

    /** Queue a range; 0 or 1 items are already sorted. */
    static void push(Deque<int[]> stack, int lo, int hi) {
        if (lo < hi) { //@push
            stack.push(new int[] {lo, hi});
        }
    }
    // endregion

    // region partition
    /** Put the pivot in its final place and return its index. */
    static int partition(int[] a, int lo, int hi, boolean median3) {
        if (median3 && hi - lo >= 2) {
            medianOfThree(a, lo, hi); //@median
        }
        int pivot = a[hi]; //@pivot
        int i = lo; // a[lo..i-1] holds the items <= pivot //@pivot
        for (int j = lo; j < hi; j++) { //@compare
            if (a[j] <= pivot) { //@compare
                if (i != j) {
                    swap(a, i, j); //@swap
                }
                i++; //@grow
            }
        }
        if (i != hi) {
            swap(a, i, hi); //@place
        }
        return i; //@place,stay
    }
    // endregion

    // region median_of_three
    /** Sort a[lo], a[mid], a[hi], then move the median to hi. */
    static void medianOfThree(int[] a, int lo, int hi) {
        int mid = (lo + hi) >>> 1; //@m_mid
        if (a[mid] < a[lo]) { //@m_one
            swap(a, lo, mid); //@m_one_swap
        }
        if (a[hi] < a[lo]) { //@m_two
            swap(a, lo, hi); //@m_two_swap
        }
        if (a[hi] < a[mid]) { //@m_three
            swap(a, mid, hi); //@m_three_swap
        }
        swap(a, mid, hi); //@m_use
    }
    // endregion

    static void swap(int[] a, int i, int j) {
        int t = a[i];
        a[i] = a[j];
        a[j] = t;
    }

    // region set_array
    /** Replace the contents of a. This page stops at 12 items. */
    public static void setArray(List<Integer> a, List<Integer> values) {
        a.clear(); //@set
        a.addAll(values.subList(0, Math.min(values.size(), 12))); //@set
    }
    // endregion

    /** n distinct values from 1 to 99, in random order. */
    static int[] distinct(int n, Random rng) {
        List<Integer> all = new ArrayList<>();
        for (int v = 1; v <= 99; v++) {
            all.add(v);
        }
        java.util.Collections.shuffle(all, rng);
        int[] out = new int[n];
        for (int k = 0; k < n; k++) {
            out[k] = all.get(k);
        }
        return out;
    }

    // region load_sorted
    /** n distinct values in increasing order. */
    public static int[] loadSorted(int n, Random rng) {
        int[] a = distinct(n, rng); //@load
        java.util.Arrays.sort(a); //@load
        return a; //@load
    }
    // endregion

    // region load_reversed
    /** n distinct values in decreasing order. */
    public static int[] loadReversed(int n, Random rng) {
        int[] a = loadSorted(n, rng); //@load
        for (int k = 0; k < n / 2; k++) { //@load
            swap(a, k, n - 1 - k); //@load
        }
        return a; //@load
    }
    // endregion

    // region load_equal
    /** n items drawn from only three values. */
    public static int[] loadEqual(int n, Random rng) {
        int[] values = distinct(3, rng); //@load
        int[] a = new int[n]; //@load
        for (int k = 0; k < n; k++) { //@load
            a[k] = values[rng.nextInt(3)]; //@load
        }
        return a; //@load
    }
    // endregion

    // region load_random
    /** n values from 1 to 99; repeats are allowed. */
    public static int[] loadRandom(int n, Random rng) {
        int[] a = new int[n]; //@load
        for (int k = 0; k < n; k++) { //@load
            a[k] = 1 + rng.nextInt(99); //@load
        }
        return a; //@load
    }
    // endregion
}
