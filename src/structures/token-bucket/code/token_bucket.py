class TokenBucket:
    """Rate limiter: tokens are earned at a steady rate, up to a cap."""

    def __init__(self, capacity=5, rate=1):
        self.capacity = capacity  # most tokens the bucket can hold
        self.rate = rate  # tokens earned per tick
        self.tokens = capacity  # a new bucket starts full
        self.now = 0  # the clock, in ticks
        self.last = 0  # the tick at which tokens was last brought up to date

    # region request
    def request(self, cost=1):  #@arrive
        """Take cost tokens, or refuse at once."""
        self.refill()  #@refill
        if self.tokens >= cost:  #@test
            self.tokens -= cost  #@take
            return True  #@take
        return False  #@reject
    # endregion

    # region refill
    def refill(self):
        """Add what was earned since the last call."""
        elapsed = self.now - self.last  #@elapsed
        if elapsed == 0:
            return  #@no_time
        earned = elapsed * self.rate  #@earned
        self.tokens = min(self.capacity, self.tokens + earned)  #@cap
        self.last = self.now  #@stamp
    # endregion

    # region retry_after
    def retry_after(self, cost=1):
        """Ticks to wait after a rejection."""
        if cost > self.capacity:
            return None  # can never fit
        short = cost - self.tokens
        # Divide, rounding up.
        wait = (short + self.rate - 1) // self.rate
        return max(0, wait)  #@retry
    # endregion

    # region burst
    def burst(self, count):
        """Send count requests in the same tick."""
        allowed = 0
        for _ in range(count):  #@next
            if self.request(1):  #@send
                allowed += 1
        return allowed  #@done
    # endregion

    # region tick
    def tick(self, ticks=1):
        """Stand in for a real clock."""
        self.now += ticks  #@tick
        # tokens and last stay as they are
    # endregion

    # region reset
    def reset(self):
        """Back to a full bucket at tick 0."""
        self.tokens = self.capacity  #@reset
        self.now = 0  #@reset
        self.last = 0  #@reset
    # endregion
