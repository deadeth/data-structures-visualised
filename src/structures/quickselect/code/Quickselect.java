import java.util.Arrays;

/** Quickselect for the k-th smallest, and a min-heap of k for the top k. */
public final class Quickselect {
    private Quickselect() {}

    // region quickselect
    /** The k-th smallest item of a, counting k from 1. Reorders a. */
    static int kthSmallest(int[] a, int k) { //@input
        if (k < 1 || k > a.length) {
            throw new IllegalArgumentException("need 1 <= k <= n"); //@bad_k
        }
        int target = k - 1; //@start
        int lo = 0, hi = a.length - 1; //@start
        while (lo < hi) { //@loop
            int p = partition(a, lo, hi); //@call
            if (p == target) { //@check
                return a[p]; //@found
            }
            if (target < p) { //@check
                hi = p - 1; //@go_left
            } else {
                lo = p + 1; //@go_right
            }
        }
        return a[lo]; //@last
    }
    // endregion

    // region partition
    /** Lomuto: the last item is the pivot. Returns its final index. */
    static int partition(int[] a, int lo, int hi) {
        // Real code first swaps a random item into a[hi].
        int pivot = a[hi]; //@pivot
        int i = lo; //@pivot
        for (int j = lo; j < hi; j++) { //@scan
            if (a[j] < pivot) { //@compare
                if (i != j) {
                    swap(a, i, j); //@swap
                }
                i++; //@swap
            }
        }
        swap(a, i, hi); //@place
        return i; //@place
    }
    // endregion

    static void swap(int[] a, int i, int j) {
        int t = a[i];
        a[i] = a[j];
        a[j] = t;
    }

    // region top_k
    /** The k largest items of stream, in heap order, not sorted. */
    static int[] topK(int[] stream, int k) { //@input
        int[] heap = new int[k]; //@begin
        int size = 0; //@begin
        for (int x : stream) { //@read
            if (size < k) { //@read
                heap[size++] = x; //@push
                siftUp(heap, size - 1); //@push
            } else if (x > heap[0]) { //@beat
                heap[0] = x; //@replace
                siftDown(heap, 0, size); //@replace
            }
        }
        return Arrays.copyOf(heap, size); //@done
    }
    // endregion

    // region sift_up
    /** Swap h[i] upwards until its parent is not larger. */
    static void siftUp(int[] h, int i) {
        while (i > 0) {
            int p = (i - 1) / 2; //@up_compare
            if (h[i] >= h[p]) { //@up_compare
                return; //@up_stop
            }
            swap(h, i, p); //@up_swap
            i = p; //@up_swap
        }
    }
    // endregion

    // region sift_down
    /** Swap h[i] downwards until no child is smaller. */
    static void siftDown(int[] h, int i, int n) {
        while (true) {
            int c = 2 * i + 1; //@down_child
            if (c >= n) { //@down_child
                return;
            }
            if (c + 1 < n && h[c + 1] < h[c]) { //@down_pick
                c++; //@down_pick
            }
            if (h[i] <= h[c]) { //@down_compare
                return; //@down_stop
            }
            swap(h, i, c); //@down_swap
            i = c; //@down_swap
        }
    }
    // endregion
}
