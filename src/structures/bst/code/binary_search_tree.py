# region node
class Node:
    def __init__(self, key):
        self.key = key
        self.left = None  # subtree of smaller keys
        self.right = None  # subtree of larger keys
# endregion


class BinarySearchTree:
    """Unbalanced binary search tree of unique integers."""

    def __init__(self):
        self.root = None
        self.size = 0

    def __len__(self):
        return self.size

    def keys(self):
        """Keys in sorted order: left subtree, node, right subtree."""
        out, stack, node = [], [], self.root
        while node is not None or stack:
            while node is not None:
                stack.append(node)
                node = node.left
            node = stack.pop()
            out.append(node.key)
            node = node.right
        return out

    # region search
    def search(self, key):
        """Walk down from the root, one node per level."""
        # A loop, not recursion: sorted keys make a chain.
        node = self.root  #@start
        while node is not None:
            if key == node.key:  #@match
                return True  #@found
            if key < node.key:  #@left
                node = node.left  #@left
            else:  #@right
                node = node.right  #@right
        return False  #@missing
    # endregion

    # region insert
    def insert(self, key):
        """Add key as a new leaf. Nothing ever rebalances."""
        if self.root is None:  #@root
            self.root = Node(key)  #@root
            self.size += 1
            return True
        # A loop, not recursion: sorted keys make a chain.
        node = self.root  #@start
        while True:
            if key == node.key:  #@match
                return False  #@duplicate
            if key < node.key:  #@left,left_free
                if node.left is None:  #@left,left_free
                    node.left = Node(key)  #@attach_left
                    break
                node = node.left  #@left
            else:  #@right,right_free
                if node.right is None:  #@right,right_free
                    node.right = Node(key)  #@attach_right
                    break
                node = node.right  #@right
        self.size += 1
        return True  #@done
    # endregion

    # region delete
    def delete(self, key):
        """Remove key: a leaf, one child or two children."""
        parent, node = None, self.root  #@start
        while node is not None and key != node.key:  #@match
            parent = node
            if key < node.key:  #@left
                node = node.left  #@left
            else:  #@right
                node = node.right  #@right
        if node is None:
            return False  #@missing
        if node.left is not None and node.right is not None:  #@two_children
            # Successor: smallest key in the right subtree.
            above, succ = node, node.right  #@succ_start
            while succ.left is not None:  #@succ_left,succ_found
                above, succ = succ, succ.left  #@succ_left
            # The node stays and takes the successor's key.
            node.key = succ.key  #@overwrite
            # The successor has no left child: unlink it.
            self._relink(above, succ, succ.right)  #@remove_succ
        elif node.left is not None or node.right is not None:
            child = node.left or node.right  #@one_child
            self._relink(parent, node, child)  #@one_child
        else:
            self._relink(parent, node, None)  #@leaf
        self.size -= 1
        return True  #@done
    # endregion

    # region relink
    def _relink(self, above, old, new):
        """Point the parent of old, or the root, at new."""
        if above is None:
            self.root = new  #@relink_root
        elif above.left is old:
            above.left = new  #@relink_left
        else:
            above.right = new  #@relink_right
    # endregion
