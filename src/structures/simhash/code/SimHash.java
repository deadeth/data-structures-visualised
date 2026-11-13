import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Pages kept by number, each as an 8-bit similarity fingerprint. */
public class SimHash {
    /** Kept small to fit the page; real fingerprints have 64. */
    static final int BITS = 8;
    /** Real indexes split 64 bits into 4 blocks of 16. */
    static final int BLOCKS = 4;
    static final int BLOCK_BITS = BITS / BLOCKS;
    static final int BLOCK_MASK = (1 << BLOCK_BITS) - 1;

    /** The most bits two near copies may differ in. */
    private final int threshold;
    /** Page number to fingerprint, in the order pages arrived. */
    private final Map<Integer, Integer> pages = new LinkedHashMap<>();
    /** One table per block: block value to the pages that have it. */
    private final List<Map<Integer, List<Integer>>> tables =
        new ArrayList<>();

    public SimHash(int threshold) {
        this.threshold = threshold;
        for (int block = 0; block < BLOCKS; block++) {
            tables.add(new HashMap<>());
        }
    }

    // region word_hash
    /** A small fixed hash: the same word always gives the same 8 bits. */
    static int wordHash(String word) {
        int h = 7;
        for (char ch : word.toCharArray()) {
            h = (h * 31 + ch) % 65521;
        }
        return (h ^ (h >> 8)) & 0xFF; //@hash
    }
    // endregion

    // region fingerprint
    /** One bit per column: 1 where more words voted 1 than 0. */
    static int fingerprint(List<String> words) {
        int[] totals = new int[BITS]; //@start
        for (String word : words) {
            int h = wordHash(word); //@hash
            for (int bit = 0; bit < BITS; bit++) {
                if ((h >> bit & 1) == 1) { //@vote
                    totals[bit] += 1; //@vote
                } else {
                    totals[bit] -= 1; //@vote
                }
            }
        }
        int fp = 0;
        for (int bit = BITS - 1; bit >= 0; bit--) {
            if (totals[bit] > 0) { // a tie counts as 0 //@sign
                fp |= 1 << bit; //@set_bit
            }
        }
        return fp;
    }
    // endregion

    // region block_key
    /** The bits of one block of a fingerprint, block 0 on the left. */
    static int blockKey(int fp, int block) {
        int shift = BITS - BLOCK_BITS * (block + 1);
        return (fp >> shift) & BLOCK_MASK; //@key
    }
    // endregion

    // region hamming
    /** How many bit positions differ between two fingerprints. */
    static int hamming(int a, int b) {
        int x = a ^ b; // 1 wherever the two differ //@xor
        int distance = 0;
        // Real code calls Long.bitCount on the 64-bit value.
        for (int bit = BITS - 1; bit >= 0; bit--) {
            if ((x >> bit & 1) == 1) { //@bit
                distance += 1; //@differ
            }
        }
        return distance;
    }
    // endregion

    // region add
    /** Fingerprint a page and keep it. False if already kept. */
    public boolean add(int page, List<String> words) {
        if (pages.containsKey(page)) { //@known_test
            return false; //@known
        }
        int fp = fingerprint(words);
        pages.put(page, fp); //@store
        for (int block = 0; block < BLOCKS; block++) {
            int key = blockKey(fp, block); //@file
            tables.get(block) //@file
                .computeIfAbsent(key, k -> new ArrayList<>()) //@file
                .add(page); //@file
        }
        return true;
    }
    // endregion

    // region is_near
    /** True when two stored pages count as near-duplicates. */
    public boolean isNear(int a, int b) {
        int distance = hamming(pages.get(a), pages.get(b)); //@call
        return distance <= threshold; //@threshold
    }
    // endregion

    // region near
    /** Stored pages within the threshold of a new page. */
    public List<Integer> near(List<String> words) {
        int fp = fingerprint(words); //@near_start
        List<Integer> found = new ArrayList<>();
        // A scan of every page. At scale, index blocks of bits.
        for (Map.Entry<Integer, Integer> e : pages.entrySet()) {
            int distance = hamming(fp, e.getValue()); //@near_distance
            if (distance <= threshold) { //@near_test
                found.add(e.getKey()); //@near_keep
            }
        }
        return found; //@near_done
    }
    // endregion

    // region near_blocks
    /** Near pages found through the block tables, without a scan. */
    public List<Integer> nearBlocks(List<String> words) {
        int fp = fingerprint(words); //@nb_start
        List<Integer> candidates = new ArrayList<>();
        for (int block = 0; block < BLOCKS; block++) { //@nb_blocks
            int key = blockKey(fp, block); //@nb_key
            List<Integer> bucket = //@nb_lookup
                tables.get(block).getOrDefault(key, List.of()); //@nb_lookup
            for (int page : bucket) {
                if (!candidates.contains(page)) { //@nb_new
                    candidates.add(page); //@nb_add
                }
            }
        }
        List<Integer> found = new ArrayList<>();
        // Only candidates are compared: the rest share no block.
        for (int page : candidates) { //@nb_each
            int distance = hamming(fp, pages.get(page)); //@nb_distance
            if (distance <= threshold) { //@nb_test
                found.add(page); //@nb_keep
            }
        }
        return found; //@nb_done
    }
    // endregion

    /** The stored fingerprint of a page, or null. */
    public Integer fingerprintOf(int page) {
        return pages.get(page);
    }
}
