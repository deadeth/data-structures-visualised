# region quickselect
def kth_smallest(a, k):  #@input
    """The k-th smallest item of a, counting k from 1. Reorders a."""
    if not 1 <= k <= len(a):
        raise ValueError("need 1 <= k <= len(a)")  #@bad_k
    target = k - 1  #@start
    lo, hi = 0, len(a) - 1  #@start
    while lo < hi:  #@loop
        p = partition(a, lo, hi)  #@call
        if p == target:  #@check
            return a[p]  #@found
        if target < p:  #@check
            hi = p - 1  #@go_left
        else:
            lo = p + 1  #@go_right
    return a[lo]  #@last
# endregion


# region partition
def partition(a, lo, hi):
    """Lomuto: the last item is the pivot. Returns its final index."""
    # Real code first swaps a random item into a[hi].
    pivot = a[hi]  #@pivot
    i = lo  #@pivot
    for j in range(lo, hi):  #@scan
        if a[j] < pivot:  #@compare
            if i != j:
                a[i], a[j] = a[j], a[i]  #@swap
            i += 1  #@swap
    a[i], a[hi] = a[hi], a[i]  #@place
    return i  #@place
# endregion


# region top_k
def top_k(stream, k):  #@input
    """The k largest items of stream, in heap order, not sorted."""
    heap = []  #@begin
    for x in stream:  #@read
        if len(heap) < k:  #@read
            heap.append(x)  #@push
            sift_up(heap, len(heap) - 1)  #@push
        elif x > heap[0]:  #@beat
            heap[0] = x  #@replace
            sift_down(heap, 0)  #@replace
    return heap  #@done
# endregion


# region sift_up
def sift_up(h, i):
    """Swap h[i] upwards until its parent is not larger."""
    while i > 0:
        p = (i - 1) // 2  #@up_compare
        if h[i] >= h[p]:  #@up_compare
            return  #@up_stop
        h[i], h[p] = h[p], h[i]  #@up_swap
        i = p  #@up_swap
# endregion


# region sift_down
def sift_down(h, i):
    """Swap h[i] downwards until no child is smaller."""
    n = len(h)
    while True:
        c = 2 * i + 1  #@down_child
        if c >= n:  #@down_child
            return
        if c + 1 < n and h[c + 1] < h[c]:  #@down_pick
            c += 1  #@down_pick
        if h[i] <= h[c]:  #@down_compare
            return  #@down_stop
        h[i], h[c] = h[c], h[i]  #@down_swap
        i = c  #@down_swap
# endregion
