/** Rate limiter: tokens are earned at a steady rate, up to a cap. */
public class TokenBucket {
    private final int capacity; // most tokens the bucket can hold
    private final int rate; // tokens earned per tick
    private int tokens; // a new bucket starts full
    private long now; // the clock, in ticks
    private long last; // the tick at which tokens was last brought up to date

    public TokenBucket(int capacity, int rate) {
        this.capacity = capacity;
        this.rate = rate;
        this.tokens = capacity;
    }

    // region request
    /** Takes cost tokens, or refuses at once. */
    public boolean request(int cost) { //@arrive
        refill(); //@refill
        if (tokens >= cost) { //@test
            tokens -= cost; //@take
            return true; //@take
        }
        return false; //@reject
    }
    // endregion

    // region refill
    /** Adds what was earned since the last call. */
    private void refill() {
        long elapsed = now - last; //@elapsed
        if (elapsed == 0) {
            return; //@no_time
        }
        long earned = elapsed * rate; //@earned
        tokens = (int) Math.min(capacity, tokens + earned); //@cap
        last = now; //@stamp
    }
    // endregion

    // region retry_after
    /** Ticks to wait after a rejection, or -1. */
    public int retryAfter(int cost) {
        if (cost > capacity) {
            return -1; // can never fit
        }
        int shortBy = cost - tokens;
        // Divide, rounding up.
        int wait = (shortBy + rate - 1) / rate;
        return Math.max(0, wait); //@retry
    }
    // endregion

    // region burst
    /** Sends count requests in the same tick. */
    public int burst(int count) {
        int allowed = 0;
        for (int i = 0; i < count; i++) { //@next
            if (request(1)) { //@send
                allowed++;
            }
        }
        return allowed; //@done
    }
    // endregion

    // region tick
    /** Stands in for a real clock. */
    public void tick(int ticks) {
        now += ticks; //@tick
        // tokens and last stay as they are
    }
    // endregion

    // region reset
    /** Back to a full bucket at tick 0. */
    public void reset() {
        tokens = capacity; //@reset
        now = 0; //@reset
        last = 0; //@reset
    }
    // endregion

    public int tokens() {
        return tokens;
    }
}
