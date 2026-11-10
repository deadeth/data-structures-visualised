import java.util.Arrays;
import java.util.Random;

public class SkipList {
    static final int MAX_LEVEL = 5; // the tallest a tower may grow: small, to fit the screen
    static final double P = 0.5; // the chance that a key is promoted one more level

    /** A tower: one key, with a forward pointer on each of its levels. */
    static class Node {
        final int key;
        final Node[] next; // next[i] is the pointer on level i + 1

        Node(int key, int height) {
            this.key = key;
            this.next = new Node[height];
        }
    }

    private final int maxLevel;
    private final Node head; // sentinel: holds no key
    private final Random random = new Random();
    private int level = 1; // levels in use

    public SkipList() {
        this(MAX_LEVEL);
    }

    public SkipList(int maxLevel) {
        this.maxLevel = maxLevel;
        this.head = new Node(Integer.MIN_VALUE, maxLevel);
    }

    // region search
    public boolean search(int key) {
        Node node = head; //@start
        for (int i = level - 1; i >= 0; i--) { // from the top //@down
            Node next = node.next[i];
            while (next != null && next.key < key) { //@right,down,bottom
                node = next; // move right //@right
                next = node.next[i]; //@right
            }
            if (next != null && next.key == key) { //@match
                return true; //@found
            }
        }
        return false; //@miss
    }
    // endregion

    // region insert
    public boolean insert(int key) {
        // update[i] is the node just before key on level i.
        Node[] update = new Node[maxLevel];
        Arrays.fill(update, head);
        Node node = head; //@start
        for (int i = level - 1; i >= 0; i--) { // from the top //@down
            Node next = node.next[i];
            while (next != null && next.key < key) { //@right,down,bottom
                node = next; // move right //@right
                next = node.next[i]; //@right
            }
            if (next != null && next.key == key) { //@match
                return false; // a set keeps each key once //@duplicate
            }
            update[i] = node; //@place
        }
        int height = randomHeight();
        level = Math.max(level, height); //@grow
        Node fresh = new Node(key, height);
        for (int i = 0; i < height; i++) { // bottom level first
            fresh.next[i] = update[i].next[i]; //@splice
            update[i].next[i] = fresh; //@splice
        }
        return true; //@done
    }
    // endregion

    // region random_height
    /** Flip a coin until tails. Each heads adds a level. */
    private int randomHeight() {
        int height = 1;
        while (height < maxLevel && random.nextDouble() < P) { //@heads,tails
            height++; //@heads
        }
        return height; //@tails
    }
    // endregion

    // region delete
    public boolean delete(int key) {
        Node[] update = new Node[level];
        Node node = head; //@start
        for (int i = level - 1; i >= 0; i--) { // from the top //@down
            Node next = node.next[i];
            while (next != null && next.key < key) { //@right,down,bottom,hit
                node = next; // move right //@right
                next = node.next[i]; //@right
            }
            update[i] = node; // its pointer may lead to key //@hit
        }
        Node target = node.next[0];
        if (target == null || target.key != key) {
            return false; //@missing
        }
        for (int i = target.next.length - 1; i >= 0; i--) { //@found
            update[i].next[i] = target.next[i]; // unlink it //@unlink
            if (i > 0 && head.next[i] == null) {
                level--; // that level is empty now //@shrink
            }
        }
        return true; //@done
    }
    // endregion
}
