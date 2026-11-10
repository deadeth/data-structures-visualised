import java.util.BitSet;

/** A set of whole numbers from 0 to 999 that may say yes by mistake. */
public class BloomFilter {
    // region hash
    /** A prime just above the largest key. */
    static final int PRIME = 1009;
    /** One {a, b} pair per hash function. */
    static final int[][] HASHES = {{7, 3}, {31, 5}, {53, 8}};
    static final int K = HASHES.length;

    /** Hash function i: (a * key + b) mod PRIME mod m. */
    private int hash(int i, int key) {
        int a = HASHES[i][0];
        int b = HASHES[i][1];
        return (a * key + b) % PRIME % m; //@hash
    }
    // endregion

    private final int m; // the number of bits, fixed for the filter's life
    private final BitSet bits;

    public BloomFilter(int m) {
        this.m = m;
        this.bits = new BitSet(m);
    }

    // region add
    /** Set key's bits. Returns how many were 0 before. */
    public int add(int key) {
        int fresh = 0;
        for (int i = 0; i < K; i++) { //@start
            int bit = hash(i, key); //@hash
            // A real filter sets the bit without looking.
            if (!bits.get(bit)) { //@test
                bits.set(bit); //@set
                fresh++;
            }
        }
        return fresh; //@done
    }
    // endregion

    // region check
    /** False: never added. True: probably added. */
    public boolean check(int key) {
        for (int i = 0; i < K; i++) { //@start
            int bit = hash(i, key); //@hash
            if (!bits.get(bit)) { //@test
                return false; // one 0 is proof //@absent
            }
        }
        // All set, but other keys may have set them.
        return true; //@probably
    }
    // endregion
}
