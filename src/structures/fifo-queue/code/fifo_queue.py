class Node:
    def __init__(self, key):
        self.key = key
        self.next = None  # the node that joined after this one


class FifoQueue:
    """First in, first out, on a singly linked list."""

    def __init__(self):
        self.head = None  # the front: the next node to leave
        self.tail = None  # the back: the node that joined last
        self.size = 0

    # region enqueue
    def enqueue(self, key):
        node = Node(key)  #@node
        if self.tail is None:  # the queue is empty
            self.head = node  #@first
        else:
            self.tail.next = node  #@link
        self.tail = node  #@tail
        self.size += 1  #@count
    # endregion

    # region dequeue
    def dequeue(self):
        if self.head is None:
            return None  #@empty
        node = self.head  #@front
        self.head = node.next  #@advance
        if self.head is None:  # that was the last node
            self.tail = None  #@clear_tail
        self.size -= 1  #@count
        return node.key  #@count
    # endregion

    # region peek
    def peek(self):
        if self.head is None:
            return None  #@empty
        return self.head.key  #@front
    # endregion
