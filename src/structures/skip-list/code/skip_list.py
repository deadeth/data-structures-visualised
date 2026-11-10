import random

MAX_LEVEL = 5  # the tallest a tower may grow: small, to fit the screen
P = 0.5  # the chance that a key is promoted one more level


class Node:
    """A tower: one key, with a forward pointer on each of its levels."""

    def __init__(self, key, height):
        self.key = key
        self.next = [None] * height  # next[i] is the pointer on level i + 1


class SkipList:
    def __init__(self, max_level=MAX_LEVEL):
        self.max_level = max_level
        self.head = Node(None, max_level)  # sentinel: holds no key
        self.level = 1  # levels in use

    # region search
    def search(self, key):
        node = self.head  #@start
        for i in reversed(range(self.level)):  # from the top  #@down
            while node.next[i] and node.next[i].key < key:  #@right,down,bottom
                node = node.next[i]  # move right  #@right
            if node.next[i] and node.next[i].key == key:  #@match
                return True  #@found
        return False  #@miss
    # endregion

    # region insert
    def insert(self, key):
        # update[i] is the node just before key on level i.
        update = [self.head] * self.max_level
        node = self.head  #@start
        for i in reversed(range(self.level)):  # from the top  #@down
            while node.next[i] and node.next[i].key < key:  #@right,down,bottom
                node = node.next[i]  # move right  #@right
            if node.next[i] and node.next[i].key == key:  #@match
                return False  # a set keeps each key once  #@duplicate
            update[i] = node  #@place
        height = self._random_height()
        self.level = max(self.level, height)  #@grow
        fresh = Node(key, height)
        for i in range(height):  # bottom level first
            fresh.next[i] = update[i].next[i]  #@splice
            update[i].next[i] = fresh  #@splice
        return True  #@done
    # endregion

    # region random_height
    def _random_height(self):
        """Flip a coin until tails. Each heads adds a level."""
        height = 1
        while height < self.max_level and random.random() < P:  #@heads,tails
            height += 1  #@heads
        return height  #@tails
    # endregion

    # region delete
    def delete(self, key):
        update = [None] * self.level
        node = self.head  #@start
        for i in reversed(range(self.level)):  # from the top  #@down
            while node.next[i] and node.next[i].key < key:  #@right,down,bottom,hit
                node = node.next[i]  # move right  #@right
            update[i] = node  # its pointer may lead to key  #@hit
        target = node.next[0]
        if target is None or target.key != key:
            return False  #@missing
        for i in reversed(range(len(target.next))):  #@found
            update[i].next[i] = target.next[i]  # unlink it  #@unlink
            if i > 0 and self.head.next[i] is None:
                self.level -= 1  # that level is empty now  #@shrink
        return True  #@done
    # endregion
