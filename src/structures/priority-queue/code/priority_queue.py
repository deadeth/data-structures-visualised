class PriorityQueue:
    """The smallest key is the most urgent. A sorted array keeps it last."""

    def __init__(self, capacity=12):
        self.items = [None] * capacity  # largest first, smallest last
        self.size = 0

    # region insert
    def insert(self, key):
        if self.size == len(self.items):
            return False  #@full
        lo, hi = 0, self.size  #@window
        while lo < hi:  #@meet
            mid = (lo + hi) // 2  #@mid
            if key < self.items[mid]:  #@less
                lo = mid + 1  #@right
            elif key > self.items[mid]:  #@more
                hi = mid  #@left
            else:  # key == self.items[mid]  #@same
                return False  #@duplicate
        i = self.size
        while i > lo:  # smaller items move one slot right
            self.items[i] = self.items[i - 1]  #@shift
            i -= 1
        self.items[lo] = key  #@place
        self.size += 1  #@done
        return True  #@done
    # endregion

    # region pop_min
    def pop_min(self):
        if self.size == 0:
            return None  #@empty
        key = self.items[self.size - 1]  #@last
        self.items[self.size - 1] = None  #@clear
        self.size -= 1  #@done
        return key  #@done
    # endregion

    # region peek
    def peek(self):
        if self.size == 0:
            return None  #@empty
        return self.items[self.size - 1]  #@last
    # endregion
