import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

/** Tokens that expire ttl ticks after they are issued or renewed. */
public class TokenManager {
    /** One queue entry: when it expires, and whose it is. */
    record Entry(int expires, String tokenId) {}

    private final int ttl;
    private final Map<String, Integer> expiry = new HashMap<>();
    private final ArrayDeque<Entry> queue = new ArrayDeque<>();

    public TokenManager(int ttl) {
        this.ttl = ttl;
    }

    // region generate
    /** Issues a token. The task promises a new id each time. */
    public void generate(String tokenId, int now) {
        int expires = now + ttl; //@expires
        expiry.put(tokenId, expires); //@store
        // One ttl for all and a clock that only goes forward,
        // so the back of the queue is always the latest.
        queue.addLast(new Entry(expires, tokenId)); //@push
    }
    // endregion

    // region renew
    /** Extends a live token. Unknown or expired: does nothing. */
    public void renew(String tokenId, int now) {
        Integer expires = expiry.get(tokenId); //@look
        if (expires == null || expires <= now) { //@alive
            return; //@ignore
        }
        expires = now + ttl; //@extend
        expiry.put(tokenId, expires); //@extend
        // The old entry stays in the queue, now stale.
        queue.addLast(new Entry(expires, tokenId)); //@push_again
    }
    // endregion

    // region count
    /** Drops what has expired from the front, then counts. */
    public int countUnexpired(int now) {
        while (!queue.isEmpty() && queue.peekFirst().expires() <= now) { //@front
            Entry e = queue.pollFirst(); //@pop
            if (expiry.getOrDefault(e.tokenId(), -1) != e.expires()) { //@check
                continue; //@stale
            }
            expiry.remove(e.tokenId()); //@drop
        }
        return expiry.size(); //@size
    }
    // endregion

    // region count_scan
    /** The simple way: looks at every token. */
    public int countByScan(int now) {
        int live = 0; //@scan_start
        for (int expires : expiry.values()) { //@scan
            if (expires > now) { //@scan_test
                live++; //@scan_live
            }
        }
        return live; //@scan_done
    }
    // endregion

    // region count_fifo
    /** The bug: believes every entry, as a plain FIFO does. */
    public int countFifo(int now) {
        while (!queue.isEmpty() && queue.peekFirst().expires() <= now) { //@f_front
            Entry e = queue.pollFirst(); //@f_pop
            expiry.remove(e.tokenId()); //@f_drop
        }
        return expiry.size(); //@f_size
    }
    // endregion

    /** Stands in for the caller, who passes the time into each call. */
    public static class Clock {
        private int now;

        // region tick
        /** Moves time on. No token is touched. */
        public void advance(int ticks) {
            now += ticks; //@tick
        }
        // endregion

        public int now() {
            return now;
        }
    }
}
