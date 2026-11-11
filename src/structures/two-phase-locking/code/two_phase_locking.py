ROWS = ("alice", "bob")
OWNER = {1: "alice", 2: "bob"}  # T3 belongs to no doctor


class Txn:
    """One transaction's private bookkeeping."""

    def __init__(self, tid, snapshot):
        self.tid = tid
        self.state = "active"  # or waiting, committed, aborted
        self.snapshot = snapshot  # SSI: the last commit it can see
        self.reads = {}  # row -> value it saw
        self.writes = {}  # row -> new value, applied at commit
        self.stale = []  # SSI: (row, writer) pairs
        self.pending = None  # 2PL: (row, mode, value) it waits for


class Lock:
    """2PL: who holds one row, and who is queued for it."""

    def __init__(self):
        self.shared = set()
        self.exclusive = None
        self.queue = []  # (tid, mode), oldest first


class Database:
    """Doctors on call, made serializable by 2PL or by SSI."""

    def __init__(self, method="2PL"):
        self.method = method
        self.clock = 0  # commits so far
        # Every committed version of a row: (ts, value, writer).
        self.versions = {row: [(0, 1, None)] for row in ROWS}
        self.locks = {row: Lock() for row in ROWS}
        self.txns = {}

    # region begin
    def begin(self, t):
        """Start t. Under SSI it sees the database as of now."""
        old = self.txns.get(t)
        if old and old.state in ("active", "waiting"):  #@open
            return False  #@open
        self.txns[t] = Txn(t, self.clock)  #@begin
        return True
    # endregion

    # region read
    def read(self, t, row):
        """The value t sees, or None if t must wait."""
        tx = self.txns[t]  #@txn
        if row in tx.writes:  #@own
            return tx.writes[row]  #@own
        if self.method == "2PL":
            if not self.acquire(tx, row, "S"):  #@lock_s
                return None  #@blocked
            value = self.versions[row][-1][1]  #@latest
        else:
            value = self.snapshot_read(tx, row)  #@snap
        tx.reads[row] = value  #@record
        return value  #@record
    # endregion

    # region write
    def write(self, t, row, value):
        """Buffer the new value. False if t must wait."""
        tx = self.txns[t]  #@txn
        if self.method == "2PL":
            if not self.acquire(tx, row, "X", value):  #@lock_x
                return False  #@blocked
        else:
            self.warn_readers(tx, row)  #@warn
        tx.writes[row] = value  #@buffer
        return True  #@buffer
    # endregion

    # region commit
    def commit(self, t):
        """Validate (SSI), apply the writes, release (2PL)."""
        tx = self.txns[t]  #@txn
        if self.method == "SSI" and not self.validate(tx):  #@validate
            self.abort(t)  #@fail
            return False  #@fail
        self.clock += 1  #@apply
        for row, value in tx.writes.items():
            self.versions[row].append((self.clock, value, tx))  #@apply
        tx.state = "committed"  #@committed
        if self.method == "2PL":
            self.release(t)  #@shrink
        return True  #@committed
    # endregion

    # region abort
    def abort(self, t):
        """Throw away t's writes. Under 2PL, free its locks."""
        tx = self.txns[t]  #@txn
        tx.state = "aborted"  #@abort
        tx.writes.clear()  #@abort
        tx.pending = None  #@abort
        if self.method == "2PL":
            self.release(t)  #@shrink
    # endregion

    # region acquire
    def acquire(self, tx, row, mode, value=None):
        """Take the lock now, or queue and look for deadlock."""
        lock = self.locks[row]
        if self.grantable(lock, tx.tid, mode):  #@test
            self.grant(lock, tx.tid, mode)  #@grant
            return True  #@grant
        lock.queue.append((tx.tid, mode))  #@queue
        tx.state = "waiting"  #@queue
        tx.pending = (row, mode, value)  #@queue
        if self.deadlocked(tx.tid):  #@detect
            self.abort(tx.tid)  #@victim
        return False  #@wait
    # endregion

    # region grantable
    def grantable(self, lock, t, mode):
        """S needs no other writer; X needs no other holder."""
        if lock.exclusive not in (None, t):  #@x_held
            return False  #@x_held
        return mode == "S" or not lock.shared - {t}  #@s_held

    def grant(self, lock, t, mode):
        if mode == "X":
            lock.shared.discard(t)  #@grant
            lock.exclusive = t  #@grant
        elif lock.exclusive != t:
            lock.shared.add(t)  #@grant
    # endregion

    # region deadlock
    def deadlocked(self, start):
        """Follow waits-for edges from start. A way back is a cycle."""
        stack, seen = [start], {start}
        while stack:
            t = stack.pop()  #@visit
            for u in self.waits_for(t):  #@edge
                if u == start:  #@cycle
                    return True  #@cycle
                if u not in seen:
                    seen.add(u)  #@follow
                    stack.append(u)  #@follow
        return False  #@acyclic

    def waits_for(self, t):
        """The transactions holding what t is queued for."""
        tx = self.txns[t]
        if tx.state != "waiting":
            return []
        row, mode, _ = tx.pending
        lock = self.locks[row]
        out = [] if lock.exclusive in (None, t) else [lock.exclusive]
        if mode == "X":
            out += sorted(lock.shared - {t})
        return out  #@edge
    # endregion

    # region release
    def release(self, t):
        """Shrinking phase: drop every lock t holds, all at once."""
        for row in ROWS:
            lock = self.locks[row]
            lock.shared.discard(t)  #@drop
            if lock.exclusive == t:
                lock.exclusive = None  #@drop
            lock.queue = [q for q in lock.queue if q[0] != t]  #@drop
        self.wake()  #@wake

    def wake(self):
        """Grant queued requests that no longer conflict, in order."""
        for row in ROWS:
            lock = self.locks[row]
            for t, mode in list(lock.queue):
                if self.grantable(lock, t, mode):  #@regrant
                    lock.queue.remove((t, mode))  #@resume
                    self.grant(lock, t, mode)  #@resume
                    self.resume(self.txns[t])  #@resume

    def resume(self, tx):
        """Finish the request tx was waiting for."""
        row, mode, value = tx.pending
        tx.state, tx.pending = "active", None  #@resume
        if mode == "S":
            tx.reads[row] = self.versions[row][-1][1]  #@resume
        else:
            tx.writes[row] = value  #@resume
    # endregion

    # region snapshot_read
    def snapshot_read(self, tx, row):
        """Newest version tx can see. Notes writers it cannot see."""
        for other in self.txns.values():
            if other is not tx and other.state == "active":
                if row in other.writes:  #@uncommitted
                    self.note(tx, row, other)  #@uncommitted
        for ts, value, writer in reversed(self.versions[row]):
            if ts <= tx.snapshot:  #@visible
                return value  #@visible
            self.note(tx, row, writer)  #@newer
    # endregion

    # region warn
    def warn_readers(self, tx, row):
        """Writing row makes every open reader of it stale."""
        for other in self.txns.values():
            if other is not tx and other.state == "active":
                if row in other.reads:  #@reader
                    self.note(other, row, tx)  #@reader
    # endregion

    # region note
    def note(self, reader, row, writer):
        """reader's view of row is wrong if writer commits."""
        if (row, writer) not in reader.stale:
            reader.stale.append((row, writer))  #@note
    # endregion

    # region validate
    def validate(self, tx):
        """Fail if a writer of something tx read has committed."""
        for row, writer in tx.stale:  #@check
            if writer.state == "committed":  #@check
                return False  #@stale
        return True  #@valid
    # endregion


# region write_skew
def write_skew(method):
    """Alice (T1) and Bob (T2) both ask to go off call at once."""
    db = Database(method)  #@ws_reset
    for t in (1, 2):
        db.begin(t)  #@ws_begin
    on_call = {}
    for t in (1, 2):
        on_call[t] = sum(db.read(t, row) for row in ROWS)  #@ws_read
    for t in (1, 2):
        if on_call[t] >= 2:  #@ws_decide
            db.write(t, OWNER[t], 0)  #@ws_write
    return db  #@ws_done
# endregion


# region retry
def retry(db, t):
    """Run t's whole transaction again, from the start."""
    if not db.begin(t):  #@r_begin
        return None  #@r_begin
    on_call = 0
    for row in ROWS:
        value = db.read(t, row)  #@r_read
        if value is None:
            return None  #@r_stuck
        on_call += value
    me = OWNER.get(t)
    if me and on_call >= 2:  #@r_decide
        if not db.write(t, me, 0):  #@r_write
            return None  #@r_stuck
    return db.commit(t)  #@r_commit
# endregion
