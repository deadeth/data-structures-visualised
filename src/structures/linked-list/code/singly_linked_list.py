# region node
class Node:
    def __init__(self, key):
        self.key = key
        self.next = None  # None marks the end of the list
# endregion


class SinglyLinkedList:
    """Singly linked list of unique integers, with head and tail."""

    def __init__(self):
        self.head = None
        self.tail = None
        self.size = 0
        self.keys = set()  # only used to refuse duplicates

    def __len__(self):
        return self.size

    def __iter__(self):
        node = self.head
        while node is not None:
            yield node.key
            node = node.next

    # region prepend
    def prepend(self, key):  #@page_limit
        """Add key at the front in two pointer writes."""
        # A set on the side: a bare list would have to walk.
        if key in self.keys:  #@check
            return False  #@duplicate
        self.keys.add(key)
        node = Node(key)  #@make
        if self.head is None:
            self.head = self.tail = node  #@first
        else:
            node.next = self.head  #@link
            self.head = node  #@move
        self.size += 1
        return True
    # endregion

    # region append
    def append(self, key):  #@page_limit
        """Add key at the back: tail saves walking there."""
        # A set on the side: a bare list would have to walk.
        if key in self.keys:  #@check
            return False  #@duplicate
        self.keys.add(key)
        node = Node(key)  #@make
        if self.head is None:
            self.head = self.tail = node  #@first
        else:
            self.tail.next = node  #@link
            self.tail = node  #@move
        self.size += 1
        return True
    # endregion

    # region search
    def search(self, key):
        """Walk from the head: a list cannot jump ahead."""
        node = self.head  #@start
        while node is not None:
            if node.key == key:  #@compare
                return True  #@found
            node = node.next  #@next
        return False  #@missing
    # endregion

    # region delete
    def delete(self, key):
        """Find key by walking, then unlink its node."""
        # No back pointers: remember the previous node.
        prev, node = None, self.head  #@start
        while node is not None and node.key != key:  #@compare
            prev, node = node, node.next  #@next
        if node is None:
            return False  #@missing
        if prev is None:
            self.head = node.next  #@unlink_head
        else:
            prev.next = node.next  #@unlink
        if node.next is None:  # it was the last node
            self.tail = prev  #@move_tail
        self.keys.discard(key)
        self.size -= 1
        return True  #@done
    # endregion
