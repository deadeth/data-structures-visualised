class BloomFilter:
    """A set of whole numbers from 0 to 999 that may say yes by mistake."""

    # region hash
    PRIME = 1009  # a prime just above the largest key
    # One (a, b) pair per hash function.
    HASHES = [(7, 3), (31, 5), (53, 8)]
    K = len(HASHES)

    def _hash(self, i, key):
        """Hash function i: (a * key + b) mod PRIME mod m."""
        a, b = self.HASHES[i]
        return (a * key + b) % self.PRIME % self.m  #@hash
    # endregion

    def __init__(self, m=32):
        self.m = m  # the number of bits, fixed for the filter's life
        self.bits = [0] * m

    # region add
    def add(self, key):
        """Set key's bits. Returns how many were 0 before."""
        fresh = 0
        for i in range(self.K):  #@start
            bit = self._hash(i, key)  #@hash
            # A real filter sets the bit without looking.
            if self.bits[bit] == 0:  #@test
                self.bits[bit] = 1  #@set
                fresh += 1
        return fresh  #@done
    # endregion

    # region check
    def check(self, key):
        """False: never added. True: probably added."""
        for i in range(self.K):  #@start
            bit = self._hash(i, key)  #@hash
            if self.bits[bit] == 0:  #@test
                return False  # one 0 is proof  #@absent
        # All set, but other keys may have set them.
        return True  #@probably
    # endregion
