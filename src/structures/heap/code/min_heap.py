class MinHeap:
    """A complete binary tree in a list: no parent is larger than its children."""

    def __init__(self, capacity=15):
        self.items = []
        self.capacity = capacity

    # region peek
    def peek(self):
        """The smallest key, or None if the heap is empty."""
        if not self.items:
            return None  #@empty
        return self.items[0]  #@peek
    # endregion

    # region insert
    def insert(self, key):
        """Add key. Returns False if the heap is full."""
        if len(self.items) >= self.capacity:
            # This page stops at 15 items; a real heap grows.
            return False  #@full
        self.items.append(key)  #@append
        self._sift_up(len(self.items) - 1)
        return True  #@done
    # endregion

    # region sift_up
    def _sift_up(self, i):
        """Swap upwards until the parent is not larger."""
        items = self.items
        while i > 0:
            parent = (i - 1) // 2  #@parent
            if items[i] >= items[parent]:  #@compare_up
                break  #@stop_up
            items[i], items[parent] = items[parent], items[i]  #@swap_up
            i = parent  #@swap_up
    # endregion

    # region extract_min
    def extract_min(self):
        """Remove and return the smallest key, if any."""
        if not self.items:
            return None  #@empty
        top = self.items[0]  #@top
        last = self.items.pop()  #@last
        if self.items:
            # The last item fills the hole: the shape is kept.
            self.items[0] = last  #@fill
            self._sift_down(0)
        return top  #@done
    # endregion

    # region sift_down
    def _sift_down(self, i):
        """Swap downwards until no child is smaller."""
        items = self.items
        n = len(items)
        while True:
            left = 2 * i + 1  #@children
            if left >= n:
                break  #@leaf
            right = left + 1  #@children
            child = left
            if right < n and items[right] < items[left]:  #@pick
                child = right  #@pick_right
            if items[i] <= items[child]:  #@compare_down
                break  #@stop_down
            items[i], items[child] = items[child], items[i]  #@swap_down
            i = child  #@swap_down
    # endregion
