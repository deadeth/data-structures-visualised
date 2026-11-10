class Node:
    def __init__(self, key):
        self.key = key
        self.height = 1  # of the subtree rooted here: a leaf is 1
        self.left = None
        self.right = None


# region heights
def _height(node):
    """Height of a subtree: 0 if empty, 1 for a leaf."""
    return node.height if node else 0


def _update_height(node):
    taller = max(_height(node.left), _height(node.right))
    node.height = 1 + taller


def _balance(node):
    """Above 0 leans left, below 0 leans right."""
    return _height(node.left) - _height(node.right)
# endregion


# region rotate
def _rotate_right(z):
    """Lift z's left child above z and return it."""
    y = z.left
    z.left = y.right  #@rotate_right
    y.right = z  #@rotate_right
    _update_height(z)  # z first: it now sits below y
    _update_height(y)
    return y


def _rotate_left(z):
    """Lift z's right child above z and return it."""
    y = z.right
    z.right = y.left  #@rotate_left
    y.left = z  #@rotate_left
    _update_height(z)
    _update_height(y)
    return y
# endregion


class AVLTree:
    def __init__(self):
        self.root = None

    # region descend
    def _descend(self, key):
        """Walk down from the root, keeping the path."""
        node, path = self.root, []  #@start
        while node:
            path.append(node)
            if key == node.key:  #@match
                return path, True  #@match
            if key < node.key:  #@left,right
                node = node.left  #@left
            else:
                node = node.right  #@right
        return path, False
    # endregion

    # region search
    def search(self, key):
        _, found = self._descend(key)
        return found  #@result
    # endregion

    # region insert
    def insert(self, key):  #@call
        if self.root is None:
            self.root = Node(key)  #@first
            return True
        path, found = self._descend(key)
        if found:
            return False  #@duplicate
        # A new key always starts as a leaf.
        parent = path[-1]
        if key < parent.key:
            parent.left = Node(key)  #@attach_left
        else:
            parent.right = Node(key)  #@attach_right
        self._retrace(path)
        return True  #@done
    # endregion

    # region retrace
    def _retrace(self, path):
        """Walk back up, fixing heights and rotating."""
        while path:
            node = path.pop()
            parent = path[-1] if path else None
            before = node.height
            _update_height(node)
            balance = _balance(node)  #@balance
            top = node
            if balance > 1:  # left-heavy  #@left_heavy
                if _balance(node.left) < 0:  # left-right  #@left_inner
                    node.left = _rotate_left(node.left)  #@left_first
                top = _rotate_right(node)  # left-left  #@left_final
                self._replace(parent, node, top)  #@left_final
            elif balance < -1:  # right-heavy  #@right_heavy
                if _balance(node.right) > 0:  # right-left  #@right_inner
                    node.right = _rotate_right(node.right)  #@right_first
                top = _rotate_left(node)  # right-right  #@right_final
                self._replace(parent, node, top)  #@right_final
            if top.height == before:  #@unchanged
                break  # nothing higher up can be affected  #@stop

    def _replace(self, parent, old, new):
        """Hang new where old was: on parent or as root."""
        if parent is None:
            self.root = new
        elif parent.left is old:
            parent.left = new
        else:
            parent.right = new
    # endregion

    # region delete
    def delete(self, key):
        path, found = self._descend(key)
        if not found:
            return False  #@missing
        node = path[-1]
        if node.left and node.right:  #@two_children
            # Successor: smallest key in the right subtree.
            above, succ = node, node.right  #@step_right
            while succ.left:  #@step_right,step_left
                path.append(succ)
                above, succ = succ, succ.left  #@step_left
            node.key = succ.key  #@copy_key
            if above is node:
                node.right = succ.right  #@splice_right
            else:
                above.left = succ.right  #@splice_left
        else:
            child = node.left or node.right  #@one_child
            path.pop()
            parent = path[-1] if path else None
            self._replace(parent, node, child)  #@unlink
        self._retrace(path)
        return True  #@done
    # endregion
