class Node:
    def __init__(self, key=None):
        self.key = key
        self.next = None  # the next node in the same bucket


class HashTable:
    """A set of whole numbers from 0 up, with separate chaining."""

    def __init__(self):
        self.buckets = self._empty_buckets(8)
        self.size = 0

    @staticmethod
    def _empty_buckets(count):
        # Each bucket is a dummy head node: its key is never read.
        return [Node() for _ in range(count)]

    # region find
    def _find(self, key):
        """Returns the node before key, or the chain's tail."""
        # The key is its own hash. Real tables scramble it.
        prev = self.buckets[key % len(self.buckets)]  #@bucket
        # Each bucket is a dummy head, so prev always exists.
        while prev.next is not None:
            if prev.next.key == key:  #@scan
                return prev  #@hit
            prev = prev.next  #@next
        return prev
    # endregion

    # region search
    def search(self, key):
        prev = self._find(key)
        return prev.next is not None  #@result
    # endregion

    # region insert
    def insert(self, key):
        prev = self._find(key)
        if prev.next is not None:
            return False  #@duplicate
        prev.next = Node(key)  #@append
        self.size += 1
        # Grow when keys / buckets passes 3/4.
        if self.size * 4 > len(self.buckets) * 3:  #@load
            self._resize()
        return True  #@done
    # endregion

    # region resize
    def _resize(self):
        """Double the array and hash every key again."""
        old = self.buckets
        self.buckets = self._empty_buckets(len(old) * 2)  #@grow
        # The last node of each new chain.
        tails = list(self.buckets)
        for head in old:
            node = head.next
            while node is not None:
                after, node.next = node.next, None
                b = node.key % len(self.buckets)  #@rehash
                tails[b].next = node  #@rehash
                tails[b] = node
                node = after
    # endregion

    # region delete
    def delete(self, key):
        prev = self._find(key)
        if prev.next is None:
            return False  #@missing
        prev.next = prev.next.next  #@unlink
        self.size -= 1
        return True  # the table never shrinks  #@done
    # endregion
