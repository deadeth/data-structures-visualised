import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Merging sorted arrays: two at a time, or k at once with a heap. */
public class MergeLists {

    // region load
    /** A merge needs sorted inputs, so sort the numbers first. */
    static int[] load(int[] values) {
        int[] sorted = values.clone();
        Arrays.sort(sorted); //@load
        return sorted; //@load
    }
    // endregion

    // region merge_two
    /** Merge two sorted arrays into one sorted array. */
    static int[] mergeTwo(int[] a, int[] b) {
        int[] out = new int[a.length + b.length];
        int i = 0, j = 0, k = 0; //@start
        while (i < a.length && j < b.length) {
            // <= takes from a on a tie: that keeps the merge stable.
            if (a[i] <= b[j]) { //@compare
                out[k++] = a[i++]; //@take_a
            } else {
                out[k++] = b[j++]; //@take_b
            }
        }
        // One array has run out. The rest of the other needs no comparing.
        while (i < a.length) {
            out[k++] = a[i++]; //@rest_a
        }
        while (j < b.length) {
            out[k++] = b[j++]; //@rest_b
        }
        return out; //@done
    }
    // endregion

    // region merge_k
    /** Merge k sorted arrays with a min-heap of their front items. */
    static int[] mergeK(int[][] lists) {
        // Each entry is {value, list number, index in that list}.
        List<int[]> heap = new ArrayList<>(); //@start_k
        int total = 0;
        for (int n = 0; n < lists.length; n++) {
            total += lists[n].length;
            if (lists[n].length > 0) { //@seed
                push(heap, new int[] {lists[n][0], n, 0}); //@seed
            }
        }
        int[] out = new int[total];
        int k = 0;
        while (!heap.isEmpty()) {
            int[] top = heap.get(0); //@pop
            out[k++] = top[0]; //@pop
            int n = top[1], i = top[2];
            if (i + 1 < lists[n].length) { //@refill
                replace(heap, new int[] {lists[n][i + 1], n, i + 1}); //@refill
            } else {
                pop(heap); //@drained
            }
        }
        return out; //@done_k
    }
    // endregion

    // region heap
    /** Smaller value first. On a tie, the earlier list first. */
    static boolean less(int[] x, int[] y) {
        return x[0] < y[0] || (x[0] == y[0] && x[1] < y[1]);
    }

    /** Add at the end, then swap up past larger parents. */
    static void push(List<int[]> heap, int[] entry) {
        heap.add(entry); //@push
        int i = heap.size() - 1;
        while (i > 0) {
            int parent = (i - 1) / 2;
            if (!less(heap.get(i), heap.get(parent))) { //@up_test
                return; //@up_stop
            }
            Collections.swap(heap, i, parent); //@up_swap
            i = parent; //@up_swap
        }
    }

    /** Put entry where the root was taken out, then sift down. */
    static void replace(List<int[]> heap, int[] entry) {
        heap.set(0, entry); //@replace
        siftDown(heap);
    }

    /** Drop the root. The last entry fills the hole. */
    static void pop(List<int[]> heap) {
        int[] last = heap.remove(heap.size() - 1); //@shrink
        if (!heap.isEmpty()) {
            heap.set(0, last); //@shrink
            siftDown(heap);
        }
    }

    /** Swap the root down past smaller children. */
    static void siftDown(List<int[]> heap) {
        int i = 0, n = heap.size();
        while (true) {
            int child = 2 * i + 1; //@children
            if (child >= n) {
                return; //@leaf
            }
            int right = child + 1;
            if (right < n && less(heap.get(right), heap.get(child))) { //@pick
                child = right; //@pick_right
            }
            if (!less(heap.get(child), heap.get(i))) { //@down_test
                return; //@down_stop
            }
            Collections.swap(heap, i, child); //@down_swap
            i = child; //@down_swap
        }
    }
    // endregion
}
