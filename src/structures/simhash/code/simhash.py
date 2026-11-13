BITS = 8  # kept small to fit the page; real fingerprints have 64
BLOCKS = 4  # real indexes split 64 bits into 4 blocks of 16
BLOCK_BITS = BITS // BLOCKS
BLOCK_MASK = (1 << BLOCK_BITS) - 1


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


# region block_key
def block_key(fp, block):
    """The bits of one block of a fingerprint, block 0 on the left."""
    shift = BITS - BLOCK_BITS * (block + 1)
    return (fp >> shift) & BLOCK_MASK  #@key
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
        # One table per block: block value to the pages that have it.
        self.tables = [{} for _ in range(BLOCKS)]

    # region add
    def add(self, page, words):
        """Fingerprint a page and keep it. False if already kept."""
        if page in self.pages:  #@known_test
            return False  #@known
        fp = fingerprint(words)
        self.pages[page] = fp  #@store
        for block in range(BLOCKS):
            key = block_key(fp, block)  #@file
            self.tables[block].setdefault(key, []).append(page)  #@file
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

    # region near_blocks
    def near_blocks(self, words):
        """Near pages found through the block tables, without a scan."""
        fp = fingerprint(words)  #@nb_start
        candidates = []
        for block in range(BLOCKS):  #@nb_blocks
            key = block_key(fp, block)  #@nb_key
            bucket = self.tables[block].get(key, [])  #@nb_lookup
            for page in bucket:
                if page not in candidates:  #@nb_new
                    candidates.append(page)  #@nb_add
        found = []
        # Only candidates are compared: the rest share no block.
        for page in candidates:  #@nb_each
            distance = hamming(fp, self.pages[page])  #@nb_distance
            if distance <= self.threshold:  #@nb_test
                found.append(page)  #@nb_keep
        return found  #@nb_done
    # endregion
