class QuorumFailed(Exception):
    """Fewer than R replicas answered."""


class Replica:
    """One copy of the data: key -> (value, version)."""

    def __init__(self):
        self.up = True
        self.data = {}

    def get(self, key):
        return self.data.get(key, (None, 0))


class QuorumStore:
    """Leaderless replication with read and write quorums."""

    def __init__(self, n=3, w=2, r=2):
        self.replicas = [Replica() for _ in range(n)]
        self.n, self.w, self.r = n, w, r
        self.clock = 0  # stands in for a write timestamp

    def version(self, i, key):
        return self.replicas[i].get(key)[1]

    # region write
    def write(self, key, value):
        """Send to every replica. Succeed on W acks."""
        self.clock += 1
        version = self.clock  #@send
        acks = 0
        for rep in self.replicas:
            if not rep.up:
                continue  #@skip
            _, have = rep.get(key)
            if version > have:  #@newer
                rep.data[key] = (value, version)  #@store
            acks += 1  #@store
        # A failed write is not undone where it landed.
        return acks >= self.w  #@quorum
    # endregion

    # region read
    def read(self, key, first=0):
        """Ask every replica. Answer from the first R replies."""
        replies = []
        for k in range(self.n):  #@ask
            i = (first + k) % self.n  # order replies arrive in
            if self.replicas[i].up:  #@reply
                replies.append(i)  #@reply
            if len(replies) == self.r:
                break
        if len(replies) < self.r:  #@enough
            raise QuorumFailed()  #@fail
        best = replies[0]
        for i in replies[1:]:
            if self.version(i, key) > self.version(best, key):  #@newest
                best = i  #@newest
        value, version = self.replicas[best].get(key)  #@answer
        for i in replies:  # read repair
            if self.version(i, key) < version:  #@stale
                self.replicas[i].data[key] = (value, version)  #@repair
        return value  #@answer
    # endregion

    # region down
    def down(self, i):
        """The replica stops answering. Its data stays."""
        self.replicas[i].up = False  #@stop
    # endregion

    # region up
    def up(self, i):
        """Back with what it held: stale until repaired."""
        self.replicas[i].up = True  #@start
    # endregion

    # region repair
    def repair(self, a, b):
        """Anti-entropy: copy the newer version each way."""
        ra, rb = self.replicas[a], self.replicas[b]
        for key in sorted(ra.data.keys() | rb.data.keys()):  #@each_key
            va, vb = ra.get(key), rb.get(key)
            if va[1] < vb[1]:  #@compare
                ra.data[key] = vb  #@copy
            elif vb[1] < va[1]:  #@compare
                rb.data[key] = va  #@copy
        # Real systems compare Merkle trees first.
    # endregion

    # region tune
    def tune(self, w, r):
        """New quorum sizes. Cassandra takes them per request."""
        if not (1 <= w <= self.n and 1 <= r <= self.n):
            raise ValueError("W and R must be 1 to N")
        self.w, self.r = w, r  #@set
        return self.r + self.w > self.n  #@rule
    # endregion
