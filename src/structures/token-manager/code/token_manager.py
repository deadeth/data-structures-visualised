from collections import deque


class TokenManager:
    """Tokens that expire ttl ticks after they are issued or renewed."""

    def __init__(self, ttl):
        self.ttl = ttl
        self.expiry = {}  # token id -> tick it expires at
        self.queue = deque()  # (expires, token id), soonest first

    # region generate
    def generate(self, token_id, now):
        """Issue a token. The task promises a new id each time."""
        expires = now + self.ttl  #@expires
        self.expiry[token_id] = expires  #@store
        # One ttl for all and a clock that only goes forward,
        # so the back of the queue is always the latest.
        self.queue.append((expires, token_id))  #@push
    # endregion

    # region renew
    def renew(self, token_id, now):
        """Extend a live token. Unknown or expired: do nothing."""
        expires = self.expiry.get(token_id)  #@look
        if expires is None or expires <= now:  #@alive
            return  #@ignore
        expires = now + self.ttl  #@extend
        self.expiry[token_id] = expires  #@extend
        # The old entry stays in the queue, now stale.
        self.queue.append((expires, token_id))  #@push_again
    # endregion

    # region count
    def count_unexpired(self, now):
        """Drop what has expired from the front, then count."""
        queue = self.queue
        while queue and queue[0][0] <= now:  #@front
            expires, token_id = queue.popleft()  #@pop
            if self.expiry.get(token_id) != expires:  #@check
                continue  #@stale
            del self.expiry[token_id]  #@drop
        return len(self.expiry)  #@size
    # endregion

    # region count_scan
    def count_by_scan(self, now):
        """The simple way: look at every token."""
        live = 0  #@scan_start
        for expires in self.expiry.values():  #@scan
            if expires > now:  #@scan_test
                live += 1  #@scan_live
        return live  #@scan_done
    # endregion

    # region count_fifo
    def count_fifo(self, now):
        """The bug: believes every entry, as a plain FIFO does."""
        queue = self.queue
        while queue and queue[0][0] <= now:  #@f_front
            expires, token_id = queue.popleft()  #@f_pop
            self.expiry.pop(token_id, None)  #@f_drop
        return len(self.expiry)  #@f_size
    # endregion


class Clock:
    """Stands in for the caller, who passes the time into each call."""

    def __init__(self):
        self.now = 0

    # region tick
    def advance(self, ticks):
        """Move time on. No token is touched."""
        self.now += ticks  #@tick
    # endregion
