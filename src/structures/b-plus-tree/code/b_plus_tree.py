class Node:
    def __init__(self, leaf):
        self.leaf = leaf
        self.keys = []
        self.children = []  # internal nodes only
        self.next = None  # leaves only: the next leaf to the right


class BPlusTree:
    def __init__(self, order=4):
        self.order = order  # the most children an internal node may have
        self.root = Node(leaf=True)

    # region find_leaf
    def _find_leaf(self, key):
        """Walk from the root to the leaf that would hold key."""
        node, path = self.root, []  #@start
        while not node.leaf:
            i = 0
            while i < len(node.keys) and key >= node.keys[i]:  #@separator
                i += 1
            path.append((node, i))
            node = node.children[i]  #@down
        return node, path
    # endregion

    # region position
    @staticmethod
    def _position(leaf, key):
        """Index of the first key in the leaf that is not smaller than key."""
        pos = 0
        while pos < len(leaf.keys) and leaf.keys[pos] < key:  #@scan
            pos += 1
        return pos
    # endregion

    # region search
    def search(self, key):
        leaf, _ = self._find_leaf(key)
        pos = self._position(leaf, key)
        return pos < len(leaf.keys) and leaf.keys[pos] == key  #@result
    # endregion

    # region insert
    def insert(self, key):
        leaf, path = self._find_leaf(key)
        pos = self._position(leaf, key)
        if pos < len(leaf.keys) and leaf.keys[pos] == key:
            return False  #@duplicate
        leaf.keys.insert(pos, key)  #@place
        node = leaf
        while len(node.keys) > self.order - 1:  # one key too many
            separator, right = self._split(node)
            if not path:  # the root split: grow a level
                self.root = Node(leaf=False)  #@new_root
                self.root.keys = [separator]  #@new_root
                self.root.children = [node, right]  #@new_root
                break
            parent, i = path.pop()
            parent.keys.insert(i, separator)  #@push_up
            parent.children.insert(i + 1, right)  #@push_up
            node = parent
        return True  #@done
    # endregion

    # region split
    def _split(self, node):
        right = Node(node.leaf)
        if node.leaf:
            mid = (len(node.keys) + 1) // 2
            right.keys = node.keys[mid:]  #@split_leaf
            node.keys = node.keys[:mid]  #@split_leaf
            right.next, node.next = node.next, right  #@split_leaf
            # A leaf keeps its separator: the key is copied up.
            return right.keys[0], right
        mid = len(node.keys) // 2
        separator = node.keys[mid]  #@split_inner
        right.keys = node.keys[mid + 1:]  #@split_inner
        right.children = node.children[mid + 1:]  #@split_inner
        node.keys = node.keys[:mid]  #@split_inner
        node.children = node.children[:mid + 1]  #@split_inner
        # An internal node gives its separator away: the key moves up.
        return separator, right
    # endregion

    # region delete
    def delete(self, key):
        leaf, path = self._find_leaf(key)
        pos = self._position(leaf, key)
        if pos == len(leaf.keys) or leaf.keys[pos] != key:
            return False  #@missing
        del leaf.keys[pos]  #@remove
        node = leaf
        while path:
            parent, i = path.pop()
            if len(node.keys) >= self._min_keys(node):
                return True  #@done
            left = parent.children[i - 1] if i > 0 else None  #@underfull
            last = i + 1 == len(parent.children)
            right = None if last else parent.children[i + 1]  #@underfull
            if left and len(left.keys) > self._min_keys(left):
                self._borrow_from_left(node, left, parent, i)  #@borrow_left
                return True
            if right and len(right.keys) > self._min_keys(right):
                self._borrow_from_right(node, right, parent, i)  #@borrow_right
                return True
            if left:  # fold the right-hand node into the left-hand one
                self._merge(left, node, parent, i - 1)  #@merge
            else:
                self._merge(node, right, parent, i)  #@merge
            node = parent
        if not node.leaf and not node.keys:  # root has no separators left
            self.root = node.children[0]  #@shrink
        return True  #@done
    # endregion

    # region rebalance
    def _min_keys(self, node):
        if node.leaf:
            return self.order // 2
        return (self.order + 1) // 2 - 1

    def _borrow_from_left(self, node, left, parent, i):
        if node.leaf:
            node.keys.insert(0, left.keys.pop())  #@borrow_left
            parent.keys[i - 1] = node.keys[0]  #@borrow_left
        else:  # rotate through the parent
            node.keys.insert(0, parent.keys[i - 1])  #@borrow_left
            parent.keys[i - 1] = left.keys.pop()  #@borrow_left
            node.children.insert(0, left.children.pop())  #@borrow_left

    def _borrow_from_right(self, node, right, parent, i):
        if node.leaf:
            node.keys.append(right.keys.pop(0))  #@borrow_right
            parent.keys[i] = right.keys[0]  #@borrow_right
        else:  # rotate through the parent
            node.keys.append(parent.keys[i])  #@borrow_right
            parent.keys[i] = right.keys.pop(0)  #@borrow_right
            node.children.append(right.children.pop(0))  #@borrow_right

    def _merge(self, into, gone, parent, sep):
        """Fold gone into its left neighbour and drop their separator."""
        if into.leaf:
            into.keys += gone.keys  #@merge
            into.next = gone.next  #@merge
        else:  # the separator comes down between the halves
            into.keys += [parent.keys[sep]] + gone.keys  #@merge
            into.children += gone.children  #@merge
        del parent.keys[sep]  #@merge
        del parent.children[sep + 1]  #@merge
    # endregion

    # region range
    def range(self, lo, hi):
        leaf, _ = self._find_leaf(lo)
        out = []
        while leaf:
            for k in leaf.keys:
                if k < lo:  #@before
                    continue
                if k > hi:  #@past
                    return out  #@done
                out.append(k)  #@collect
            leaf = leaf.next  #@next_leaf
        return out  #@done
    # endregion
