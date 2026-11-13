class Node:
    def __init__(self, key, parent=None):
        self.key = key
        self.red = True  # every new node starts red
        self.left = None
        self.right = None
        self.parent = parent


# region colours
def _is_red(node):
    """None is a null leaf, and null leaves are black."""
    return node is not None and node.red
# endregion


class RedBlackTree:
    def __init__(self):
        self.root = None

    # region descend
    def _descend(self, key):
        """Walk down from the root. Return (parent, match)."""
        parent, node = None, self.root  #@start
        while node:
            if key == node.key:  #@match
                return parent, node  #@match
            parent = node
            if key < node.key:  #@left,right
                node = node.left  #@left
            else:
                node = node.right  #@right
        return parent, None
    # endregion

    # region search
    def search(self, key):
        _, node = self._descend(key)
        return node is not None  #@result
    # endregion

    # region insert
    def insert(self, key):
        parent, node = self._descend(key)
        if node:
            return False  #@duplicate
        node = Node(key, parent)  #@first,attach_left,attach_right
        if parent is None:
            self.root = node  #@first
        elif key < parent.key:
            parent.left = node  #@attach_left
        else:
            parent.right = node  #@attach_right
        self._fix_insert(node)
        return True  #@done
    # endregion

    # region fix_insert
    def _fix_insert(self, node):
        """Remove a red-red pair, working up the tree."""
        while _is_red(node.parent):  #@red_parent
            parent = node.parent
            grand = parent.parent  # exists: the root is black
            if parent is grand.left:
                uncle = grand.right  #@left_uncle
                if _is_red(uncle):  #@left_uncle
                    parent.red = False  #@left_recolour
                    uncle.red = False  #@left_recolour
                    grand.red = True  #@left_grand
                    node = grand  #@left_climb
                    continue
                if node is parent.right:  # inner  #@left_inner
                    self._rotate_left(parent)  #@left_inner_rot
                    node, parent = parent, node  #@left_inner_rot
                self._rotate_right(grand)  #@left_outer_rot
                parent.red = False  #@left_top
                grand.red = True  #@left_down
            else:
                uncle = grand.left  #@right_uncle
                if _is_red(uncle):  #@right_uncle
                    parent.red = False  #@right_recolour
                    uncle.red = False  #@right_recolour
                    grand.red = True  #@right_grand
                    node = grand  #@right_climb
                    continue
                if node is parent.left:  # inner  #@right_inner
                    self._rotate_right(parent)  #@right_inner_rot
                    node, parent = parent, node  #@right_inner_rot
                self._rotate_left(grand)  #@right_outer_rot
                parent.red = False  #@right_top
                grand.red = True  #@right_down
        self.root.red = False  # the root is always black  #@root_black
    # endregion

    # region delete
    def delete(self, key):
        _, node = self._descend(key)
        if node is None:
            return False  #@missing
        if node.left and node.right:  #@two_children
            succ = node.right  #@step_right
            while succ.left:  #@step_right,step_left
                succ = succ.left  #@step_left
            node.key = succ.key  #@copy_key
            node = succ  # remove the successor's node instead  #@copy_key
        child = node.left or node.right  #@one_child
        self._replace(node, child)  #@unlink
        if node.red:
            return True  # a red node holds no black  #@red_gone
        if _is_red(child):
            child.red = False  # it takes over the black  #@child_black
            return True  #@child_black
        self._fix_delete(child, node.parent)  #@double_black
        return True  #@done
    # endregion

    # region fix_delete
    def _fix_delete(self, node, parent):
        """node is one black short: a "double black"."""
        while node is not self.root and not _is_red(node):  #@db_loop
            if node is parent.left:
                sibling = parent.right  #@left_sibling
                if sibling.red:  # case 1  #@left_sibling
                    self._rotate_left(parent)  #@left_c1_rot
                    sibling.red = False  #@left_c1_top
                    parent.red = True  #@left_c1_down
                    sibling = parent.right  #@left_c1_new
                near, far = sibling.left, sibling.right  #@left_c2
                if not _is_red(near) and not _is_red(far):  #@left_c2
                    sibling.red = True  # case 2  #@left_c2_red
                    node, parent = parent, parent.parent  #@left_c2_up
                    continue
                if not _is_red(far):  # case 3  #@left_c3
                    self._rotate_right(sibling)  #@left_c3_rot
                    near.red = False  #@left_c3_top
                    sibling.red = True  #@left_c3_down
                    sibling, far = near, sibling  #@left_c3_new
                self._rotate_left(parent)  # case 4  #@left_c4_rot
                sibling.red = parent.red  #@left_c4_top
                parent.red = False  #@left_c4_down
                far.red = False  #@left_c4_far
                return  #@left_c4_far
            else:
                sibling = parent.left  #@right_sibling
                if sibling.red:  # case 1  #@right_sibling
                    self._rotate_right(parent)  #@right_c1_rot
                    sibling.red = False  #@right_c1_top
                    parent.red = True  #@right_c1_down
                    sibling = parent.left  #@right_c1_new
                near, far = sibling.right, sibling.left  #@right_c2
                if not _is_red(near) and not _is_red(far):  #@right_c2
                    sibling.red = True  # case 2  #@right_c2_red
                    node, parent = parent, parent.parent  #@right_c2_up
                    continue
                if not _is_red(far):  # case 3  #@right_c3
                    self._rotate_left(sibling)  #@right_c3_rot
                    near.red = False  #@right_c3_top
                    sibling.red = True  #@right_c3_down
                    sibling, far = near, sibling  #@right_c3_new
                self._rotate_right(parent)  # case 4  #@right_c4_rot
                sibling.red = parent.red  #@right_c4_top
                parent.red = False  #@right_c4_down
                far.red = False  #@right_c4_far
                return  #@right_c4_far
        if node:
            node.red = False  # red, or the root: absorb the black  #@db_end
    # endregion

    # region rotate
    def _rotate_left(self, x):
        """Lift x's right child into x's place."""
        y = x.right
        x.right = y.left  #@rotate_left
        if y.left:
            y.left.parent = x
        self._replace(x, y)  #@rotate_left
        y.left = x  #@rotate_left
        x.parent = y

    def _rotate_right(self, x):
        """Lift x's left child into x's place."""
        y = x.left
        x.left = y.right  #@rotate_right
        if y.right:
            y.right.parent = x
        self._replace(x, y)  #@rotate_right
        y.right = x  #@rotate_right
        x.parent = y

    def _replace(self, old, new):
        """Hang new where old hung: on old's parent, or as root."""
        parent = old.parent
        if parent is None:
            self.root = new
        elif parent.left is old:
            parent.left = new
        else:
            parent.right = new
        if new:
            new.parent = parent
    # endregion
