class Version:
    """One version of a row."""

    def __init__(self, value, xmin):
        self.value = value
        self.xmin = xmin  # id of the transaction that made it
        self.xmax = None  # id of the transaction that replaced it


class Txn:
    """A transaction and the snapshot it reads through."""

    def __init__(self, xid, level):
        self.xid = xid
        self.level = level  # 'read committed' or 'snapshot'
        self.status = 'active'  # then 'committed' or 'aborted'
        self.in_progress = set()  # running when the snapshot was taken
        self.horizon = xid  # ids from here up had not begun
        self.wants = None  # (row, value) while it waits for a lock


class MVCC:
    """A tiny multi-version table with a write lock per row."""

    def __init__(self, rows, level='snapshot'):
        self.level = level
        self.load(rows)

    # region load
    def load(self, rows):
        """Start again: transaction 0 writes every row."""
        loader = Txn(0, self.level)
        loader.status = 'committed'
        self.txns = {0: loader}  #@load
        self.rows = {r: [Version(v, 0)] for r, v in rows.items()}  #@load
        self.locks = {}  # row -> id of the transaction holding it
        self.next_xid = 1
    # endregion

    # region level
    def set_level(self, level):
        """The level for transactions that begin from now on."""
        self.level = level  #@level
    # endregion

    # region begin
    def begin(self):
        """Start a transaction and take its snapshot."""
        t = Txn(self.next_xid, self.level)  #@begin
        self.next_xid += 1  #@begin
        self.txns[t.xid] = t
        self.take_snapshot(t)  #@snapshot
        return t.xid

    def take_snapshot(self, t):
        """Note who is running, and the next id to be handed out."""
        t.in_progress = {x for x, o in self.txns.items()
                         if o.status == 'active' and x != t.xid}
        t.horizon = self.next_xid  #@snapshot
    # endregion

    # region read
    def read(self, xid, row):
        """The value of row that xid is allowed to see."""
        t = self.txns[xid]
        if t.level == 'read committed':
            self.take_snapshot(t)  #@statement
        # The chain is kept newest first.
        for v in self.rows[row]:  #@walk
            if self.visible(t, v):  #@walk
                return v.value  #@found
        return None
    # endregion

    # region visible
    def visible(self, t, v):
        """The visibility rule for one version."""
        if v.xmin == t.xid:  #@mine
            return v.xmax != t.xid  #@mine
        if not self.committed_before(t, v.xmin):  #@created
            return False  #@created
        if v.xmax is None:  #@not_deleted
            return True  #@not_deleted
        if v.xmax == t.xid:  #@not_deleted
            return False  #@not_deleted
        return not self.committed_before(t, v.xmax)  #@deleted

    def committed_before(self, t, xid):
        """Did xid commit before t's snapshot was taken?"""
        if self.txns[xid].status != 'committed':  #@committed
            return False  #@committed
        if xid >= t.horizon:  #@after
            return False  #@after
        return xid not in t.in_progress  #@running
    # endregion

    # region write
    def write(self, xid, row, value):
        """Add a version. Returns written, waiting or aborted."""
        t = self.txns[xid]
        holder = self.locks.get(row)  #@lock
        if holder is not None and holder != xid:  #@lock
            if self.waits_for(holder, xid):  #@deadlock
                self.abort(xid)  #@deadlock
                return 'aborted'  #@deadlock
            t.wants = (row, value)  #@wait
            return 'waiting'  #@wait
        head = self.newest(row)  #@head
        if (t.level == 'snapshot' and head.xmin != xid  #@conflict
                and not self.committed_before(t, head.xmin)):  #@conflict
            # First committer wins: someone changed it after my snapshot.
            self.abort(xid)  #@first_wins
            return 'aborted'  #@first_wins
        self.locks[row] = xid  #@append
        head.xmax = xid  #@append
        self.rows[row].insert(0, Version(value, xid))  #@append
        return 'written'  #@append

    def newest(self, row):
        """The newest version not left by an aborted transaction."""
        for v in self.rows[row]:
            if self.txns[v.xmin].status != 'aborted':
                return v  #@head

    def waits_for(self, holder, xid):
        """Would xid waiting on holder close a cycle?"""
        while holder is not None:
            if holder == xid:
                return True  #@deadlock
            wants = self.txns[holder].wants
            holder = self.locks.get(wants[0]) if wants else None
        return False
    # endregion

    # region commit
    def commit(self, xid):
        """Later snapshots will count xid's versions."""
        self.txns[xid].status = 'committed'  #@commit
        self.release(xid)  #@release
    # endregion

    # region abort
    def abort(self, xid):
        """Its versions stay behind as garbage for vacuum."""
        t = self.txns[xid]
        t.status = 'aborted'  #@abort
        t.wants = None  #@abort
        self.release(xid)  #@release
    # endregion

    # region release
    def release(self, xid):
        """Free xid's locks and retry whoever waited on them."""
        freed = [r for r, h in self.locks.items() if h == xid]
        for row in freed:
            del self.locks[row]  #@unlock
        for w in list(self.txns.values()):
            if w.wants and w.wants[0] in freed:  #@waiter
                row, value = w.wants
                w.wants = None
                self.write(w.xid, row, value)  #@retry
    # endregion

    # region vacuum
    def vacuum(self):
        """Drop versions no transaction can ever see again."""
        active = [t for t in self.txns.values() if t.status == 'active']
        removed = 0
        for row, chain in self.rows.items():
            keep = []
            for v in chain:  #@vac_scan
                if self.dead(v, active):  #@vac_test
                    removed += 1  #@vac_drop
                else:
                    keep.append(v)  #@vac_keep
            self.rows[row] = keep  #@vac_done
        return removed  #@vac_done

    def dead(self, v, active):
        """Aborted, or replaced before every snapshot still open."""
        if self.txns[v.xmin].status == 'aborted':  #@vac_test
            return True
        if v.xmax is None or self.txns[v.xmax].status != 'committed':
            return False
        # Read committed takes a new snapshot at its next statement.
        return all(t.level == 'read committed'
                   or self.committed_before(t, v.xmax) for t in active)
    # endregion
