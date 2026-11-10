class Stack:
    """A stack on a plain array that doubles when it fills up."""

    def __init__(self):
        self.items = [None] * 4  # the array: 4 slots to begin with
        self.size = 0  # slots in use; the top item is items[size - 1]

    # region push
    def push(self, key):
        if self.size == len(self.items):  #@full
            self._grow()
        self.items[self.size] = key  #@write
        self.size += 1  #@up
    # endregion

    # region grow
    def _grow(self):
        """Move every item into an array twice the size."""
        # A Python list does this for you.
        bigger = [None] * (2 * len(self.items))  #@allocate
        for i in range(self.size):
            bigger[i] = self.items[i]  #@copy
        self.items = bigger  #@swap
    # endregion

    # region pop
    def pop(self):
        if self.size == 0:  #@empty
            return None  #@nothing
        key = self.items[self.size - 1]  #@read
        self.items[self.size - 1] = None  #@clear
        self.size -= 1  #@down
        return key
    # endregion

    # region peek
    def peek(self):
        if self.size == 0:  #@empty
            return None  #@nothing
        return self.items[self.size - 1]  #@read
    # endregion
