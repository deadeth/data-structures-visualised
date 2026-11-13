import random


# region quicksort
def quicksort(a, median3=False):
    """Sort a in place. Lomuto partition, explicit stack."""
    stack = []
    push(stack, 0, len(a) - 1)  #@start
    while stack:  #@empty
        lo, hi = stack.pop()  #@pop
        p = partition(a, lo, hi, median3)
        # Push the larger side first, so the smaller is sorted
        # next and the stack stays O(log n) deep.
        if p - lo > hi - p:  #@left_big,right_big
            push(stack, lo, p - 1)  #@left_big
            push(stack, p + 1, hi)  #@left_big
        else:
            push(stack, p + 1, hi)  #@right_big
            push(stack, lo, p - 1)  #@right_big


def push(stack, lo, hi):
    """Queue a range; 0 or 1 items are already sorted."""
    if lo < hi:  #@push
        stack.append((lo, hi))
# endregion


# region partition
def partition(a, lo, hi, median3=False):
    """Put the pivot in its final place and return its index."""
    if median3 and hi - lo >= 2:
        median_of_three(a, lo, hi)  #@median
    pivot = a[hi]  #@pivot
    i = lo  # a[lo:i] holds the items <= pivot  #@pivot
    for j in range(lo, hi):  #@compare
        if a[j] <= pivot:  #@compare
            if i != j:
                a[i], a[j] = a[j], a[i]  #@swap
            i += 1  #@grow
    if i != hi:
        a[i], a[hi] = a[hi], a[i]  #@place
    return i  #@place,stay
# endregion


# region median_of_three
def median_of_three(a, lo, hi):
    """Sort a[lo], a[mid], a[hi], then move the median to hi."""
    mid = (lo + hi) // 2  #@m_mid
    if a[mid] < a[lo]:  #@m_one
        a[lo], a[mid] = a[mid], a[lo]  #@m_one_swap
    if a[hi] < a[lo]:  #@m_two
        a[lo], a[hi] = a[hi], a[lo]  #@m_two_swap
    if a[hi] < a[mid]:  #@m_three
        a[mid], a[hi] = a[hi], a[mid]  #@m_three_swap
    a[mid], a[hi] = a[hi], a[mid]  #@m_use
# endregion


# region set_array
def set_array(a, values):
    """Replace the contents of a. This page stops at 12 items."""
    a.clear()  #@set
    a.extend(values[:12])  #@set
# endregion


# region load_sorted
def load_sorted(n, rng=random):
    """n distinct values in increasing order."""
    return sorted(rng.sample(range(1, 100), n))  #@load
# endregion


# region load_reversed
def load_reversed(n, rng=random):
    """n distinct values in decreasing order."""
    return sorted(rng.sample(range(1, 100), n), reverse=True)  #@load
# endregion


# region load_equal
def load_equal(n, rng=random):
    """n items drawn from only three values."""
    values = rng.sample(range(1, 100), 3)  #@load
    return [rng.choice(values) for _ in range(n)]  #@load
# endregion


# region load_random
def load_random(n, rng=random):
    """n values from 1 to 99; repeats are allowed."""
    return [rng.randint(1, 99) for _ in range(n)]  #@load
# endregion
