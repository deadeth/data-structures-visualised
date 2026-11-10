import java.util.ArrayDeque;
import java.util.Deque;

public class AvlTree {
    static class Node {
        int key;
        int height = 1; // of the subtree rooted here: a leaf is 1
        Node left;
        Node right;

        Node(int key) {
            this.key = key;
        }
    }

    private Node root;

    // region heights
    /** Height of a subtree: 0 if empty, 1 for a leaf. */
    private static int height(Node node) {
        return node == null ? 0 : node.height;
    }

    private static void updateHeight(Node node) {
        int left = height(node.left);
        int right = height(node.right);
        node.height = 1 + Math.max(left, right);
    }

    /** Above 0 leans left, below 0 leans right. */
    private static int balance(Node node) {
        return height(node.left) - height(node.right);
    }
    // endregion

    // region rotate
    /** Lift z's left child above z and return it. */
    private static Node rotateRight(Node z) {
        Node y = z.left;
        z.left = y.right; //@rotate_right
        y.right = z; //@rotate_right
        updateHeight(z); // z first: it now sits below y
        updateHeight(y);
        return y;
    }

    /** Lift z's right child above z and return it. */
    private static Node rotateLeft(Node z) {
        Node y = z.right;
        z.right = y.left; //@rotate_left
        y.left = z; //@rotate_left
        updateHeight(z);
        updateHeight(y);
        return y;
    }
    // endregion

    // region descend
    /** Walk down from the root, adding each node to path. */
    private boolean descend(int key, Deque<Node> path) {
        Node node = root; //@start
        while (node != null) {
            path.addLast(node);
            if (key == node.key) { //@match
                return true; //@match
            }
            if (key < node.key) { //@left,right
                node = node.left; //@left
            } else {
                node = node.right; //@right
            }
        }
        return false;
    }
    // endregion

    // region search
    public boolean search(int key) {
        return descend(key, new ArrayDeque<>()); //@result
    }
    // endregion

    // region insert
    public boolean insert(int key) { //@call
        if (root == null) {
            root = new Node(key); //@first
            return true;
        }
        Deque<Node> path = new ArrayDeque<>();
        if (descend(key, path)) {
            return false; //@duplicate
        }
        // A new key always starts as a leaf.
        Node parent = path.peekLast();
        if (key < parent.key) {
            parent.left = new Node(key); //@attach_left
        } else {
            parent.right = new Node(key); //@attach_right
        }
        retrace(path);
        return true; //@done
    }
    // endregion

    // region retrace
    /** Walk back up, fixing heights and rotating. */
    private void retrace(Deque<Node> path) {
        while (!path.isEmpty()) {
            Node node = path.removeLast();
            Node parent = path.peekLast(); // null at the root
            int before = node.height;
            updateHeight(node);
            int balance = balance(node); //@balance
            Node top = node;
            if (balance > 1) { // left-heavy //@left_heavy
                if (balance(node.left) < 0) { // left-right //@left_inner
                    node.left = rotateLeft(node.left); //@left_first
                }
                top = rotateRight(node); // left-left //@left_final
                replace(parent, node, top); //@left_final
            } else if (balance < -1) { // right-heavy //@right_heavy
                if (balance(node.right) > 0) { // right-left //@right_inner
                    node.right = rotateRight(node.right); //@right_first
                }
                top = rotateLeft(node); // right-right //@right_final
                replace(parent, node, top); //@right_final
            }
            if (top.height == before) { //@unchanged
                break; // nothing higher up can be affected //@stop
            }
        }
    }

    /** Hang now where old was: on parent or as root. */
    private void replace(Node parent, Node old, Node now) {
        if (parent == null) {
            root = now;
        } else if (parent.left == old) {
            parent.left = now;
        } else {
            parent.right = now;
        }
    }
    // endregion

    // region delete
    public boolean delete(int key) {
        Deque<Node> path = new ArrayDeque<>();
        if (!descend(key, path)) {
            return false; //@missing
        }
        Node node = path.peekLast();
        if (node.left != null && node.right != null) { //@two_children
            // Successor: smallest key in the right subtree.
            Node above = node;
            Node succ = node.right; //@step_right
            while (succ.left != null) { //@step_right,step_left
                path.addLast(succ);
                above = succ;
                succ = succ.left; //@step_left
            }
            node.key = succ.key; //@copy_key
            if (above == node) {
                node.right = succ.right; //@splice_right
            } else {
                above.left = succ.right; //@splice_left
            }
        } else {
            boolean hasLeft = node.left != null;
            Node child = hasLeft ? node.left : node.right; //@one_child
            path.removeLast();
            Node parent = path.peekLast(); // or null
            replace(parent, node, child); //@unlink
        }
        retrace(path);
        return true; //@done
    }
    // endregion
}
