import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

public class BPlusTree {
    static class Node {
        final boolean leaf;
        final List<Integer> keys = new ArrayList<>();
        final List<Node> children = new ArrayList<>(); // internal nodes only
        Node next; // leaves only: the next leaf to the right

        Node(boolean leaf) {
            this.leaf = leaf;
        }
    }

    /** One step on the way down: a node, and the index of the child taken out of it. */
    record Step(Node node, int index) {}

    private final int order; // the most children an internal node may have
    private Node root = new Node(true);

    public BPlusTree(int order) {
        this.order = order;
    }

    // region find_leaf
    /** Walk from the root to the leaf that would hold key, recording the path. */
    private Node findLeaf(int key, Deque<Step> path) {
        Node node = root; //@start
        while (!node.leaf) {
            int i = 0;
            while (i < node.keys.size() && key >= node.keys.get(i)) { //@separator
                i++;
            }
            path.push(new Step(node, i));
            node = node.children.get(i); //@down
        }
        return node;
    }
    // endregion

    // region position
    /** Index of the first key in the leaf that is not smaller than key. */
    private static int position(Node leaf, int key) {
        int pos = 0;
        while (pos < leaf.keys.size() && leaf.keys.get(pos) < key) { //@scan
            pos++;
        }
        return pos;
    }
    // endregion

    // region search
    public boolean search(int key) {
        Node leaf = findLeaf(key, new ArrayDeque<>());
        int pos = position(leaf, key);
        return pos < leaf.keys.size() && leaf.keys.get(pos) == key; //@result
    }
    // endregion

    // region insert
    public boolean insert(int key) {
        Deque<Step> path = new ArrayDeque<>();
        Node leaf = findLeaf(key, path);
        int pos = position(leaf, key);
        if (pos < leaf.keys.size() && leaf.keys.get(pos) == key) {
            return false; //@duplicate
        }
        leaf.keys.add(pos, key); //@place
        Node node = leaf;
        while (node.keys.size() > order - 1) { // one key too many
            Node right = new Node(node.leaf);
            int separator = split(node, right);
            if (path.isEmpty()) { // the root split: grow a level
                root = new Node(false); //@new_root
                root.keys.add(separator); //@new_root
                root.children.addAll(List.of(node, right)); //@new_root
                break;
            }
            Step up = path.pop();
            up.node().keys.add(up.index(), separator); //@push_up
            up.node().children.add(up.index() + 1, right); //@push_up
            node = up.node();
        }
        return true; //@done
    }
    // endregion

    // region split
    /** Move the upper half of node into right and return the separator. */
    private int split(Node node, Node right) {
        if (node.leaf) {
            int mid = (node.keys.size() + 1) / 2;
            moveTail(node.keys, mid, right.keys); //@split_leaf
            right.next = node.next; //@split_leaf
            node.next = right; //@split_leaf
            // A leaf keeps its separator: the key is copied up.
            return right.keys.get(0);
        }
        int mid = node.keys.size() / 2;
        int separator = node.keys.get(mid); //@split_inner
        moveTail(node.keys, mid + 1, right.keys); //@split_inner
        moveTail(node.children, mid + 1, right.children); //@split_inner
        node.keys.remove(mid); //@split_inner
        // An internal node gives its separator away: the key moves up.
        return separator;
    }

    private static <T> void moveTail(List<T> from, int start, List<T> to) {
        List<T> tail = from.subList(start, from.size());
        to.addAll(tail);
        tail.clear();
    }
    // endregion

    // region delete
    public boolean delete(int key) {
        Deque<Step> path = new ArrayDeque<>();
        Node leaf = findLeaf(key, path);
        int pos = position(leaf, key);
        if (pos == leaf.keys.size() || leaf.keys.get(pos) != key) {
            return false; //@missing
        }
        leaf.keys.remove(pos); //@remove
        Node node = leaf;
        while (!path.isEmpty()) {
            Step up = path.pop();
            Node parent = up.node();
            int i = up.index();
            if (node.keys.size() >= minKeys(node)) {
                return true; //@done
            }
            Node left = i > 0 ? parent.children.get(i - 1) : null; //@underfull
            boolean last = i + 1 == parent.children.size();
            Node right = last ? null : parent.children.get(i + 1); //@underfull
            if (left != null && left.keys.size() > minKeys(left)) {
                borrowFromLeft(node, left, parent, i); //@borrow_left
                return true;
            }
            if (right != null && right.keys.size() > minKeys(right)) {
                borrowFromRight(node, right, parent, i); //@borrow_right
                return true;
            }
            if (left != null) { // fold the right-hand node into the left-hand one
                merge(left, node, parent, i - 1); //@merge
            } else {
                merge(node, right, parent, i); //@merge
            }
            node = parent;
        }
        if (!node.leaf && node.keys.isEmpty()) { // root has no separators left
            root = node.children.get(0); //@shrink
        }
        return true; //@done
    }
    // endregion

    // region rebalance
    private int minKeys(Node node) {
        return node.leaf ? order / 2 : (order + 1) / 2 - 1;
    }

    private void borrowFromLeft(Node node, Node left, Node parent, int i) {
        if (node.leaf) {
            node.keys.add(0, left.keys.remove(left.keys.size() - 1)); //@borrow_left
            parent.keys.set(i - 1, node.keys.get(0)); //@borrow_left
        } else { // rotate through the parent
            node.keys.add(0, parent.keys.get(i - 1)); //@borrow_left
            parent.keys.set(i - 1, left.keys.remove(left.keys.size() - 1)); //@borrow_left
            node.children.add(0, left.children.remove(left.children.size() - 1)); //@borrow_left
        }
    }

    private void borrowFromRight(Node node, Node right, Node parent, int i) {
        if (node.leaf) {
            node.keys.add(right.keys.remove(0)); //@borrow_right
            parent.keys.set(i, right.keys.get(0)); //@borrow_right
        } else { // rotate through the parent
            node.keys.add(parent.keys.get(i)); //@borrow_right
            parent.keys.set(i, right.keys.remove(0)); //@borrow_right
            node.children.add(right.children.remove(0)); //@borrow_right
        }
    }

    /** Fold gone into its left neighbour and drop the separator between them. */
    private void merge(Node into, Node gone, Node parent, int sep) {
        if (into.leaf) {
            into.keys.addAll(gone.keys); //@merge
            into.next = gone.next; //@merge
        } else { // the separator comes down between the halves
            into.keys.add(parent.keys.get(sep)); //@merge
            into.keys.addAll(gone.keys); //@merge
            into.children.addAll(gone.children); //@merge
        }
        parent.keys.remove(sep); //@merge
        parent.children.remove(sep + 1); //@merge
    }
    // endregion

    // region range
    public List<Integer> range(int lo, int hi) {
        Node leaf = findLeaf(lo, new ArrayDeque<>());
        List<Integer> out = new ArrayList<>();
        while (leaf != null) {
            for (int k : leaf.keys) {
                if (k < lo) { //@before
                    continue;
                }
                if (k > hi) { //@past
                    return out; //@done
                }
                out.add(k); //@collect
            }
            leaf = leaf.next; //@next_leaf
        }
        return out; //@done
    }
    // endregion
}
