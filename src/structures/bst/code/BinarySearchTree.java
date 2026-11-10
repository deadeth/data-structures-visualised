import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/** Unbalanced binary search tree of unique integers. */
public class BinarySearchTree {
    // region node
    static class Node {
        int key;
        Node left; // subtree of smaller keys
        Node right; // subtree of larger keys

        Node(int key) {
            this.key = key;
        }
    }
    // endregion

    private Node root;
    private int size;

    public int size() {
        return size;
    }

    /** Keys in sorted order: left subtree, node, right subtree. */
    public List<Integer> keys() {
        List<Integer> out = new ArrayList<>();
        Deque<Node> stack = new ArrayDeque<>();
        Node node = root;
        while (node != null || !stack.isEmpty()) {
            while (node != null) {
                stack.push(node);
                node = node.left;
            }
            node = stack.pop();
            out.add(node.key);
            node = node.right;
        }
        return out;
    }

    // region search
    /** Walk down from the root, one node per level. */
    public boolean search(int key) {
        // A loop, not recursion: sorted keys make a chain.
        Node node = root; //@start
        while (node != null) {
            if (key == node.key) { //@match
                return true; //@found
            }
            if (key < node.key) { //@less,left
                node = node.left; //@left
            } else { //@right
                node = node.right; //@right
            }
        }
        return false; //@missing
    }
    // endregion

    // region insert
    /** Add key as a new leaf. Nothing ever rebalances. */
    public boolean insert(int key) {
        if (root == null) { //@root
            root = new Node(key); //@root
            size++;
            return true;
        }
        // A loop, not recursion: sorted keys make a chain.
        Node node = root; //@start
        while (true) {
            if (key == node.key) { //@match
                return false; //@duplicate
            }
            if (key < node.key) { //@less,left,left_free
                if (node.left == null) { //@left,left_free
                    node.left = new Node(key); //@attach_left
                    break;
                }
                node = node.left; //@left
            } else { //@right,right_free
                if (node.right == null) { //@right,right_free
                    node.right = new Node(key); //@attach_right
                    break;
                }
                node = node.right; //@right
            }
        }
        size++;
        return true; //@done
    }
    // endregion

    // region delete
    /** Remove key: a leaf, one child or two children. */
    public boolean delete(int key) {
        Node parent = null;
        Node node = root; //@start
        while (node != null && key != node.key) { //@match
            parent = node;
            if (key < node.key) { //@less,left
                node = node.left; //@left
            } else { //@right
                node = node.right; //@right
            }
        }
        if (node == null) {
            return false; //@missing
        }
        if (node.left != null && node.right != null) { //@two_children
            // Successor: smallest key in the right subtree.
            Node above = node;
            Node succ = node.right; //@succ_start
            while (succ.left != null) { //@succ_left,succ_found
                above = succ; //@succ_left
                succ = succ.left; //@succ_left
            }
            // The node stays and takes the successor's key.
            node.key = succ.key; //@overwrite
            // The successor has no left child: unlink it.
            relink(above, succ, succ.right); //@remove_succ
        } else if (node.left != null || node.right != null) {
            Node child = node.left != null //@one_child
                    ? node.left : node.right; //@one_child
            relink(parent, node, child); //@one_child
        } else {
            relink(parent, node, null); //@leaf
        }
        size--;
        return true; //@done
    }
    // endregion

    // region relink
    /** Point the parent of old, or the root, at next. */
    private void relink(Node above, Node old, Node next) {
        if (above == null) {
            root = next; //@relink_root
        } else if (above.left == old) {
            above.left = next; //@relink_left
        } else {
            above.right = next; //@relink_right
        }
    }
    // endregion
}
