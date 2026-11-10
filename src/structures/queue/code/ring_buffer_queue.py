class RingBufferQueue:
    """Bounded FIFO queue of integers, stored as a ring buffer."""

    # region fields
    def __init__(self, capacity=8):
        self.capacity = capacity
        self.slots = [None] * capacity  # never grows
        self.head = 0  # index of the oldest item
        self.tail = 0  # index of the next free slot
        # head == tail when empty and also when full.
        self.size = 0  # tells the two apart
    # endregion

    # region enqueue
    def enqueue(self, key):
        """Add key at the tail, or refuse it if full."""
        if self.size == self.capacity:  #@check
            return False  #@rejected
        self.slots[self.tail] = key  #@write
        self.tail = (self.tail + 1) % self.capacity  #@advance
        self.size += 1  #@advance
        return True  #@done
    # endregion

    # region dequeue
    def dequeue(self):
        """Take the oldest item, or None if empty."""
        if self.size == 0:  #@check
            return None  #@empty
        key = self.slots[self.head]  #@read
        # Optional: head moving on is what removes it.
        self.slots[self.head] = None  #@free
        self.head = (self.head + 1) % self.capacity  #@advance
        self.size -= 1  #@advance
        return key  #@done
    # endregion
