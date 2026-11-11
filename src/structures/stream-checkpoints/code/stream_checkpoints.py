SINKS = 3  # a log sink, an upsert table and a two-phase sink


class Checkpoint:
    """What checkpoint storage keeps for one checkpoint."""

    def __init__(self, cid, sources):
        self.cid = cid
        self.offsets = [0] * sources  # where each source will resume
        self.counts = {}  # Count's keyed state at the barrier
        self.txn = []  # the two-phase sink's pre-committed results
        self.acks = 0


class Job:
    """Two Kafka sources, a keyed counter and three sinks."""

    def __init__(self, logs):
        self.logs = logs  # two partitions: kept, so replayable by offset
        self.tasks = len(logs) + 1 + SINKS
        self.running = True
        self.offsets = [0] * len(logs)  # in memory: lost in a crash
        self.counts = {}  # in memory: lost in a crash
        self.done = Checkpoint(0, len(logs))  # last completed checkpoint
        self.next_id = 1
        self.appended = []  # at-least-once sink: appends every result
        self.table = {}  # idempotent sink: upserts by key
        self.txn = []  # two-phase sink: the open transaction
        self.committed = []  # two-phase sink: what readers can see

    # region process
    def process(self, p):
        """Carry the next record of partition p through the job."""
        if not self.running:  #@down
            return None  #@down
        key = self.logs[p][self.offsets[p]]  #@read
        self.offsets[p] += 1  #@read
        return self.count(key)  #@emit
    # endregion

    # region count
    def count(self, key):
        """Count: add one for the key, then hand the result on."""
        n = self.counts.get(key, 0) + 1  #@count
        self.counts[key] = n  #@count
        self.appended.append((key, n))  #@sink
        self.table[key] = n  #@sink
        self.txn.append((key, n))  #@sink
        return n
    # endregion

    # region checkpoint
    def checkpoint(self):
        """Take a checkpoint with barriers. Returns its id."""
        if not self.running:  #@down
            return None  #@down
        chk = Checkpoint(self.next_id, len(self.logs))  #@trigger
        self.next_id += 1  #@trigger
        for p in range(len(self.logs)):  #@inject
            chk.offsets[p] = self.offsets[p]  #@inject
            chk.acks += 1  #@inject
        seen = 1  # the barrier from source 0 reaches Count first  #@first
        # Count holds channel 0. Source 0 keeps reading meanwhile.
        held = self.logs[0][self.offsets[0]]  #@hold
        self.offsets[0] += 1  #@hold
        seen += 1  # then the barrier from source 1  #@align
        if seen == len(self.logs):  #@align
            chk.counts = dict(self.counts)  #@snapshot
            chk.acks += 1  #@snapshot
        chk.txn = self.txn  #@precommit
        self.txn = []  #@precommit
        chk.acks += SINKS  #@precommit
        self.count(held)  #@release
        if chk.acks == self.tasks:  #@complete
            self.done = chk  #@complete
            self.committed += chk.txn  #@commit
        return chk.cid  #@finish
    # endregion

    # region crash
    def crash(self):
        """A task fails. Every task restarts, so memory is lost."""
        self.running = False  #@lost
        self.offsets = None  #@lost
        self.counts = None  #@lost
    # endregion

    # region recover
    def recover(self):
        """Restart from the last completed checkpoint."""
        if self.running:  #@up
            return False  #@up
        chk = self.done  #@restore
        self.counts = dict(chk.counts)  #@restore
        self.offsets = list(chk.offsets)  #@rewind
        self.txn = []  #@abort
        self.running = True  #@resume
        return True  #@resume
    # endregion
