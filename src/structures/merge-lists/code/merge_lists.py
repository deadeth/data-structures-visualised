# region load
def load(values):
    """A merge needs sorted inputs, so sort the numbers first."""
    return sorted(values)  #@load
# endregion


# region merge_two
def merge_two(a, b):
    """Merge two sorted lists into one sorted list."""
    out = []
    i = j = 0  #@start
    while i < len(a) and j < len(b):
        # <= takes from a on a tie: that keeps the merge stable.
        if a[i] <= b[j]:  #@compare
            out.append(a[i])  #@take_a
            i += 1  #@take_a
        else:
            out.append(b[j])  #@take_b
            j += 1  #@take_b
    # One list has run out. The rest of the other needs no comparing.
    while i < len(a):
        out.append(a[i])  #@rest_a
        i += 1  #@rest_a
    while j < len(b):
        out.append(b[j])  #@rest_b
        j += 1  #@rest_b
    return out  #@done
# endregion


# region merge_k
def merge_k(lists):
    """Merge k sorted lists with a min-heap of their front items."""
    # Each entry is (value, list number, index in that list).
    heap = []  #@start_k
    for n, items in enumerate(lists):
        if items:  #@seed
            heap_push(heap, (items[0], n, 0))  #@seed
    out = []
    while heap:
        value, n, i = heap[0]  #@pop
        out.append(value)  #@pop
        if i + 1 < len(lists[n]):  #@refill
            heap_replace(heap, (lists[n][i + 1], n, i + 1))  #@refill
        else:
            heap_pop(heap)  #@drained
    return out  #@done_k
# endregion


# region heap
def less(x, y):
    """Smaller value first. On a tie, the earlier list first."""
    return (x[0], x[1]) < (y[0], y[1])


def heap_push(heap, entry):
    """Add at the end, then swap up past larger parents."""
    heap.append(entry)  #@push
    i = len(heap) - 1
    while i > 0:
        parent = (i - 1) // 2
        if not less(heap[i], heap[parent]):  #@up_test
            return  #@up_stop
        heap[i], heap[parent] = heap[parent], heap[i]  #@up_swap
        i = parent  #@up_swap


def heap_replace(heap, entry):
    """Put entry where the root was taken out, then sift down."""
    heap[0] = entry  #@replace
    sift_down(heap)


def heap_pop(heap):
    """Drop the root. The last entry fills the hole."""
    last = heap.pop()  #@shrink
    if heap:
        heap[0] = last  #@shrink
        sift_down(heap)


def sift_down(heap):
    """Swap the root down past smaller children."""
    i, n = 0, len(heap)
    while True:
        child = 2 * i + 1  #@children
        if child >= n:
            return  #@leaf
        right = child + 1
        if right < n and less(heap[right], heap[child]):  #@pick
            child = right  #@pick_right
        if not less(heap[child], heap[i]):  #@down_test
            return  #@down_stop
        heap[i], heap[child] = heap[child], heap[i]  #@down_swap
        i = child  #@down_swap
# endregion
