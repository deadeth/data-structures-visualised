class Node:
    """One cached entry, and a link in the list ordered by last use."""

    def __init__(self, key, value):
        self.key = key
        self.value = value
        self.prev = None  # towards the head: used more recently
        self.next = None  # towards the tail: used less recently


class LRUCache:
    def __init__(self, capacity):
        self.capacity = max(1, capacity)
        self.map = {}  # key -> its node in the list
        self.head = None  # most recently used
        self.tail = None  # least recently used: the next to be evicted

    # region get
    def get(self, key):
        """The value for key, or None on a miss."""
        node = self.map.get(key)  #@lookup
        if node is None:  #@check
            return None  #@miss
        # Being read makes it the most recent.
        if node is not self.head:  #@is_head
            self._unlink(node)
            self._push_front(node)
        return node.value  #@hit
    # endregion

    # region put
    def put(self, key, value):
        """Store key. Returns the evicted key, or None."""
        node = self.map.get(key)  #@lookup
        if node is not None:  #@check
            node.value = value  #@refresh
            # A write counts as a use.
            if node is not self.head:  #@is_head
                self._unlink(node)
                self._push_front(node)
            return None  #@refreshed
        evicted = None
        if len(self.map) >= self.capacity:  #@room
            victim = self.tail  # least recent: no search  #@victim
            self._unlink(victim)
            # Or the map would point at a node that is gone.
            del self.map[victim.key]  #@forget
            evicted = victim.key
        node = Node(key, value)  #@create
        self.map[key] = node  #@create
        self._push_front(node)
        return evicted  #@done
    # endregion

    # region unlink
    def _unlink(self, node):
        """Take a node out of the list: two pointer writes."""
        if node.prev:
            node.prev.next = node.next  #@unlink_prev
        else:
            self.head = node.next  #@unlink_head
        if node.next:
            node.next.prev = node.prev  #@unlink_next
        else:
            self.tail = node.prev  #@unlink_tail
    # endregion

    # region push_front
    def _push_front(self, node):
        """Link a node in at the head: four pointer writes."""
        node.prev = None  #@aim
        node.next = self.head  #@aim
        if self.head:
            self.head.prev = node  #@attach_old
        else:
            self.tail = node  #@attach_tail
        self.head = node  #@attach
    # endregion
