class SortedArray:
    """A list of integers searched by halving. It must be sorted."""

    def __init__(self):
        self.items = []

    # region load_sorted
    def load_sorted(self, numbers):
        """Replace the contents with these numbers, sorted."""
        self.items = sorted(numbers)  #@load_sorted
    # endregion

    # region load
    def load(self, numbers):
        """Replace the contents as given. Nothing checks the order."""
        self.items = list(numbers)  #@load
    # endregion

    # region find
    def find(self, key):
        """Index of key, or -1 if it is not here."""
        a = self.items
        lo, hi = 0, len(a) - 1  #@init
        while lo <= hi:  #@loop
            # Not (lo + hi) // 2: in Java or C that sum can overflow.
            mid = lo + (hi - lo) // 2  #@mid
            if a[mid] == key:  #@test
                return mid  #@found
            if a[mid] < key:  #@test
                lo = mid + 1  #@go_right
            else:
                hi = mid - 1  #@go_left
        return -1  #@missing
    # endregion

    # region lower_bound
    def lower_bound(self, key):
        """First index whose item is at least key, or len if none is."""
        a = self.items
        lo, hi = 0, len(a)  #@lb_init
        while lo < hi:  #@lb_loop
            mid = lo + (hi - lo) // 2  #@lb_mid
            if a[mid] < key:  #@lb_test
                lo = mid + 1  #@lb_right
            else:
                hi = mid  #@lb_left
        return lo  #@lb_done
    # endregion
