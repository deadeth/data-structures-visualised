class InsertionSort:
    """A list sorted in place, one insertion at a time."""

    LIMIT = 12  # this page draws at most 12 items

    def __init__(self):
        self.items = []
        self.sorted = 0  # items[:sorted] is in order

    # region load
    def load(self, values):
        """Replace the items. One item on its own is sorted."""
        self.items = list(values)  #@load
        self.sorted = min(1, len(self.items))  #@load
    # endregion

    # region sort
    def sort(self):
        """Insert each unsorted item in turn."""
        while self.sorted < len(self.items):  #@next
            self.insert_next()
    # endregion

    # region insert_next
    def insert_next(self):
        """Slide the first unsorted item left to its place."""
        a = self.items
        i = self.sorted
        if i >= len(a):
            return False  #@all_sorted
        key = a[i]  #@lift
        j = i - 1  #@lift
        while j >= 0:
            if a[j] <= key:  #@compare
                break  #@stop
            a[j + 1] = a[j]  #@shift
            j -= 1  #@shift
        a[j + 1] = key  #@drop
        self.sorted = i + 1  #@drop
        return True  #@drop
    # endregion
