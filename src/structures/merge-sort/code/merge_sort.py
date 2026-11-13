# region merge_sort
def merge_sort(a):
    """Sort the list a in place. Equal items keep their order."""
    buf = [None] * len(a)  #@buffer
    sort(a, buf, 0, len(a))  #@start
    return a  #@done
# endregion


# region sort
def sort(a, buf, lo, hi):
    """Sort a[lo:hi], using the same slots of buf as scratch space."""
    if hi - lo < 2:  #@base
        return  #@base
    mid = (lo + hi) // 2  #@split
    sort(a, buf, lo, mid)  #@split
    sort(a, buf, mid, hi)  #@split
    merge(a, buf, lo, mid, hi)  #@merge_call
# endregion


# region merge
def merge(a, buf, lo, mid, hi):
    """Merge sorted a[lo:mid] and a[mid:hi] via buf, then copy back."""
    i, j, k = lo, mid, lo  #@merge_start
    while i < mid and j < hi:  #@compare
        if a[i] <= a[j]:  #@compare
            buf[k] = a[i]  # <= takes the left item on a tie #@take_left
            i += 1  #@take_left
        else:
            buf[k] = a[j]  #@take_right
            j += 1  #@take_right
        k += 1  #@take_left,take_right
    while i < mid:  # the right run is empty #@rest_left
        buf[k] = a[i]  #@rest_left
        i += 1  #@rest_left
        k += 1  #@rest_left
    while j < hi:  # the left run is empty #@rest_right
        buf[k] = a[j]  #@rest_right
        j += 1  #@rest_right
        k += 1  #@rest_right
    a[lo:hi] = buf[lo:hi]  #@copy_back
# endregion


# region set
def set_array(a, values, limit=12):
    """Replace the contents of a with values, up to the page's limit."""
    a[:] = values[:limit]  #@set
    return a  #@set
# endregion


# region load
def load(kind, n, rng):
    """A test input of n items: random, sorted, reversed or equal."""
    a = [rng.randint(1, 99) for _ in range(n)]  #@load_random
    if kind == "sorted":
        a.sort()  #@load_sorted
    elif kind == "reversed":
        a.sort(reverse=True)  #@load_reversed
    elif kind == "equal":
        few = a[:3]  # only three different values #@load_equal
        a = [rng.choice(few) for _ in range(n)]  #@load_equal
    return a  #@load_random,load_sorted,load_reversed,load_equal
# endregion
