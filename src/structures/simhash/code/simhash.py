BITS = 8  # kept small to fit the page; real fingerprints have 64


# region word_hash
def word_hash(word):
    """A small fixed hash: the same word always gives the same 8 bits."""
    h = 7
    for ch in word:
        h = (h * 31 + ord(ch)) % 65521
    return (h ^ (h >> 8)) & 0xFF  #@hash
# endregion


# region fingerprint
def fingerprint(words):
    """One bit per column: 1 where more words voted 1 than 0."""
    totals = [0] * BITS  #@start
    for word in words:
        h = word_hash(word)  #@hash
        for bit in range(BITS):
            if h >> bit & 1:  #@vote
                totals[bit] += 1  #@vote
            else:
                totals[bit] -= 1  #@vote
    fp = 0
    for bit in range(BITS - 1, -1, -1):
        if totals[bit] > 0:  # a tie counts as 0  #@sign
            fp |= 1 << bit  #@set_bit
    return fp
# endregion


# region hamming
def hamming(a, b):
    """How many bit positions differ between two fingerprints."""
    x = a ^ b  # 1 wherever the two differ  #@xor
    distance = 0
    # Real code counts the 1s with a single popcount.
    for bit in range(BITS - 1, -1, -1):
        if x >> bit & 1:  #@bit
            distance += 1  #@differ
    return distance
# endregion


class SimHash:
    """Pages kept by number, each as an 8-bit similarity fingerprint."""

    def __init__(self, threshold=2):
        # The most bits two near copies may differ in.
        self.threshold = threshold
        # Page number to fingerprint, in the order pages arrived.
        self.pages = {}

    # region add
    def add(self, page, words):
        """Fingerprint a page and keep it. False if already kept."""
        if page in self.pages:  #@known_test
            return False  #@known
        self.pages[page] = fingerprint(words)  #@store
        return True
    # endregion

    # region is_near
    def is_near(self, a, b):
        """True when two stored pages count as near-duplicates."""
        distance = hamming(self.pages[a], self.pages[b])  #@call
        return distance <= self.threshold  #@threshold
    # endregion

    # region near
    def near(self, words):
        """Stored pages within the threshold of a new page."""
        fp = fingerprint(words)  #@near_start
        found = []
        # A scan of every page. At scale, index blocks of bits.
        for page, other in self.pages.items():
            distance = hamming(fp, other)  #@near_distance
            if distance <= self.threshold:  #@near_test
                found.append(page)  #@near_keep
        return found  #@near_done
    # endregion
