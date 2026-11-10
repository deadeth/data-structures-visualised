import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.TreeMap;

public class Trie {
    static class Node {
        // Sorted by letter, so a prefix query can list words in order.
        final TreeMap<Character, Node> children = new TreeMap<>();
        boolean end; // true if the path to here spells a stored word
    }

    /** A node waiting to be visited, and the text that leads to it. */
    record Visit(Node node, String text) {}

    static final int LIMIT = 8; // the most words a prefix query returns

    final Node root = new Node(); // stands for the empty string

    // region walk
    /** Walk down from the root, one lookup per letter. */
    private boolean walk(String word, List<Node> path) {
        Node node = root; //@start
        path.add(node);
        for (char ch : word.toCharArray()) {
            // One lookup, not a scan of the children.
            Node child = node.children.get(ch); //@lookup
            if (child == null) {
                return false; //@miss
            }
            node = child; //@down
            path.add(node);
        }
        return true;
    }
    // endregion

    // region search
    public boolean search(String word) { //@call
        List<Node> path = new ArrayList<>();
        if (!walk(word, path)) {
            return false; //@missing
        }
        // A prefix of a longer word is not a word.
        return path.getLast().end; //@result
    }
    // endregion

    // region insert
    public boolean insert(String word) { //@call
        Node node = root; //@start
        for (char ch : word.toCharArray()) {
            Node child = node.children.get(ch); //@lookup
            if (child == null) { //@absent
                child = new Node(); //@create
                node.children.put(ch, child); //@create
            }
            node = child; //@down
        }
        if (node.end) {
            return false; //@duplicate
        }
        node.end = true; //@mark_end
        return true; //@done
    }
    // endregion

    // region delete
    public boolean delete(String word) { //@call
        List<Node> path = new ArrayList<>();
        if (!walk(word, path)) {
            return false; //@missing
        }
        Node last = path.getLast();
        if (!last.end) {
            return false; //@prefix_only
        }
        last.end = false; //@unmark
        // Prune upwards: path.get(i) is i letters down.
        for (int i = word.length(); i > 0; i--) {
            Node node = path.get(i);
            if (!node.children.isEmpty() || node.end) { //@prune
                break; // still needed //@kept
            }
            Node parent = path.get(i - 1);
            parent.children.remove(word.charAt(i - 1)); //@prune
        }
        return true; //@done
    }
    // endregion

    // region prefix
    /** The first LIMIT words that start with prefix. */
    public List<String> withPrefix(String prefix) { //@call
        List<Node> path = new ArrayList<>();
        if (!walk(prefix, path)) {
            return List.of(); //@none
        }
        List<String> out = new ArrayList<>();
        Deque<Visit> stack = new ArrayDeque<>();
        stack.push(new Visit(path.getLast(), prefix));
        while (!stack.isEmpty()) {
            Visit v = stack.pop(); //@visit
            if (v.node().end) {
                out.add(v.text()); //@collect
                if (out.size() == LIMIT) {
                    break; //@limit
                }
            }
            // Reversed, so the smallest letter pops first.
            var kids = v.node().children.descendingMap();
            kids.forEach((ch, kid) ->
                    stack.push(new Visit(kid, v.text() + ch)));
        }
        return out; //@done
    }
    // endregion
}
