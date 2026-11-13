public class RedBlackTree {
    static class Node {
        int key;
        boolean red = true; // every new node starts red
        Node left;
        Node right;
        Node parent;

        Node(int key, Node parent) {
            this.key = key;
            this.parent = parent;
        }
    }

    private Node root;
    private Node found; // set by descend: the match, or null

    // region colours
    /** null is a null leaf, and null leaves are black. */
    private static boolean isRed(Node node) {
        return node != null && node.red;
    }
    // endregion

    // region descend
    /** Walk down from the root. Return the parent; set found. */
    private Node descend(int key) {
        Node parent = null, node = root; //@start
        while (node != null) {
            if (key == node.key) { //@match
                found = node; //@match
                return parent; //@match
            }
            parent = node;
            if (key < node.key) { //@left,right
                node = node.left; //@left
            } else {
                node = node.right; //@right
            }
        }
        found = null;
        return parent;
    }
    // endregion

    // region search
    public boolean search(int key) {
        descend(key);
        return found != null; //@result
    }
    // endregion

    // region insert
    public boolean insert(int key) {
        Node parent = descend(key);
        if (found != null) {
            return false; //@duplicate
        }
        Node node = new Node(key, parent); //@first,attach_left,attach_right
        if (parent == null) {
            root = node; //@first
        } else if (key < parent.key) {
            parent.left = node; //@attach_left
        } else {
            parent.right = node; //@attach_right
        }
        fixInsert(node);
        return true; //@done
    }
    // endregion

    // region fix_insert
    /** Remove a red-red pair, working up the tree. */
    private void fixInsert(Node node) {
        while (isRed(node.parent)) { //@red_parent
            Node parent = node.parent;
            Node grand = parent.parent; // exists: the root is black
            if (parent == grand.left) {
                Node uncle = grand.right; //@left_uncle
                if (isRed(uncle)) { //@left_uncle
                    parent.red = false; //@left_recolour
                    uncle.red = false; //@left_recolour
                    grand.red = true; //@left_grand
                    node = grand; //@left_climb
                    continue;
                }
                if (node == parent.right) { // inner //@left_inner
                    rotateLeft(parent); //@left_inner_rot
                    node = parent; //@left_inner_rot
                    parent = node.parent; //@left_inner_rot
                }
                rotateRight(grand); //@left_outer_rot
                parent.red = false; //@left_top
                grand.red = true; //@left_down
            } else {
                Node uncle = grand.left; //@right_uncle
                if (isRed(uncle)) { //@right_uncle
                    parent.red = false; //@right_recolour
                    uncle.red = false; //@right_recolour
                    grand.red = true; //@right_grand
                    node = grand; //@right_climb
                    continue;
                }
                if (node == parent.left) { // inner //@right_inner
                    rotateRight(parent); //@right_inner_rot
                    node = parent; //@right_inner_rot
                    parent = node.parent; //@right_inner_rot
                }
                rotateLeft(grand); //@right_outer_rot
                parent.red = false; //@right_top
                grand.red = true; //@right_down
            }
        }
        root.red = false; // the root is always black //@root_black
    }
    // endregion

    // region delete
    public boolean delete(int key) {
        descend(key);
        Node node = found;
        if (node == null) {
            return false; //@missing
        }
        if (node.left != null && node.right != null) { //@two_children
            Node succ = node.right; //@step_right
            while (succ.left != null) { //@step_right,step_left
                succ = succ.left; //@step_left
            }
            node.key = succ.key; //@copy_key
            node = succ; // remove the successor's node instead //@copy_key
        }
        Node child = node.left != null ? node.left : node.right; //@one_child
        replace(node, child); //@unlink
        if (node.red) {
            return true; // a red node holds no black //@red_gone
        }
        if (isRed(child)) {
            child.red = false; // it takes over the black //@child_black
            return true; //@child_black
        }
        fixDelete(child, node.parent); //@double_black
        return true; //@done
    }
    // endregion

    // region fix_delete
    /** node is one black short: a "double black". */
    private void fixDelete(Node node, Node parent) {
        while (node != root && !isRed(node)) { //@db_loop
            if (node == parent.left) {
                Node sibling = parent.right; //@left_sibling
                if (sibling.red) { // case 1 //@left_sibling
                    rotateLeft(parent); //@left_c1_rot
                    sibling.red = false; //@left_c1_top
                    parent.red = true; //@left_c1_down
                    sibling = parent.right; //@left_c1_new
                }
                Node near = sibling.left, far = sibling.right; //@left_c2
                if (!isRed(near) && !isRed(far)) { //@left_c2
                    sibling.red = true; // case 2 //@left_c2_red
                    node = parent; //@left_c2_up
                    parent = parent.parent; //@left_c2_up
                    continue;
                }
                if (!isRed(far)) { // case 3 //@left_c3
                    rotateRight(sibling); //@left_c3_rot
                    near.red = false; //@left_c3_top
                    sibling.red = true; //@left_c3_down
                    far = sibling; //@left_c3_new
                    sibling = near; //@left_c3_new
                }
                rotateLeft(parent); // case 4 //@left_c4_rot
                sibling.red = parent.red; //@left_c4_top
                parent.red = false; //@left_c4_down
                far.red = false; //@left_c4_far
                return; //@left_c4_far
            } else {
                Node sibling = parent.left; //@right_sibling
                if (sibling.red) { // case 1 //@right_sibling
                    rotateRight(parent); //@right_c1_rot
                    sibling.red = false; //@right_c1_top
                    parent.red = true; //@right_c1_down
                    sibling = parent.left; //@right_c1_new
                }
                Node near = sibling.right, far = sibling.left; //@right_c2
                if (!isRed(near) && !isRed(far)) { //@right_c2
                    sibling.red = true; // case 2 //@right_c2_red
                    node = parent; //@right_c2_up
                    parent = parent.parent; //@right_c2_up
                    continue;
                }
                if (!isRed(far)) { // case 3 //@right_c3
                    rotateLeft(sibling); //@right_c3_rot
                    near.red = false; //@right_c3_top
                    sibling.red = true; //@right_c3_down
                    far = sibling; //@right_c3_new
                    sibling = near; //@right_c3_new
                }
                rotateRight(parent); // case 4 //@right_c4_rot
                sibling.red = parent.red; //@right_c4_top
                parent.red = false; //@right_c4_down
                far.red = false; //@right_c4_far
                return; //@right_c4_far
            }
        }
        if (node != null) {
            node.red = false; // red, or the root: absorb it //@db_end
        }
    }
    // endregion

    // region rotate
    /** Lift x's right child into x's place. */
    private void rotateLeft(Node x) {
        Node y = x.right;
        x.right = y.left; //@rotate_left
        if (y.left != null) {
            y.left.parent = x;
        }
        replace(x, y); //@rotate_left
        y.left = x; //@rotate_left
        x.parent = y;
    }

    /** Lift x's left child into x's place. */
    private void rotateRight(Node x) {
        Node y = x.left;
        x.left = y.right; //@rotate_right
        if (y.right != null) {
            y.right.parent = x;
        }
        replace(x, y); //@rotate_right
        y.right = x; //@rotate_right
        x.parent = y;
    }

    /** Hang next where old hung: on old's parent, or as root. */
    private void replace(Node old, Node next) {
        Node parent = old.parent;
        if (parent == null) {
            root = next;
        } else if (parent.left == old) {
            parent.left = next;
        } else {
            parent.right = next;
        }
        if (next != null) {
            next.parent = parent;
        }
    }
    // endregion
}
