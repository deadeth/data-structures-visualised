class Entry:
    """One log entry, stamped with the epoch of the leader that wrote it."""

    def __init__(self, epoch, key, value):
        self.epoch = epoch
        self.key = key
        self.value = value


class Replica:
    """A copy of the data: a log applied in order."""

    def __init__(self, name):
        self.name = name
        self.log = []  # entry i has LSN i + 1
        self.epoch = 1  # newest epoch this replica knows of
        self.alive = True
        self.held = False  # its link from the leader is slow

    def pos(self):
        """The LSN of the last entry applied."""
        return len(self.log)

    def get(self, key):
        """The newest value of key, or None."""
        for entry in reversed(self.log):
            if entry.key == key:
                return entry.value
        return None


# region agrees
def agrees(a, b, lsn):
    """Same entry at lsn? One leader writes each epoch."""
    return lsn <= b.pos() and a.log[lsn - 1].epoch == b.log[lsn - 1].epoch
# endregion


class Cluster:
    """One leader, its followers, and one client's positions."""

    def __init__(self, mode="semi-sync", names="ABC"):
        self.replicas = {n: Replica(n) for n in names}
        self.leader = self.replicas[names[0]]
        self.sync_name = names[1]
        self.mode = mode  # "async", "semi-sync" or "sync"
        self.epoch = 1
        self.semi_off = False  # semi-sync timed out; async for now
        self.wrote = 0  # LSN of the client's last write
        self.seen = 0  # newest position the client has read from

    def followers(self):
        """Live replicas other than the leader, in name order."""
        return [r for r in self.replicas.values()
                if r is not self.leader and r.alive]

    def sync_follower(self):
        """The follower semi-sync waits for, or None."""
        fs = self.followers()
        for f in fs:
            if f.name == self.sync_name:
                return f
        return fs[0] if fs else None

    def live(self, name):
        """The replica called name, if it is up."""
        r = self.replicas[name]
        if not r.alive:
            raise ValueError(f"{name} is down")
        return r

    def follower(self, name):
        """The replica called name, if it is a live follower."""
        r = self.live(name)
        if r is self.leader:
            raise ValueError(f"{name} is the leader")
        return r

    # region needed
    def needed(self):
        """Followers the leader waits for before it answers."""
        if self.mode == "sync":
            return self.followers()
        if self.mode == "semi-sync" and not self.semi_off:
            f = self.sync_follower()
            return [f] if f else []
        return []
    # endregion

    # region ship_all
    def ship_all(self, f):
        """Copy, in order, the leader's entries that f lacks."""
        log = self.leader.log
        sent = 0
        while f.pos() < len(log):  #@gap
            f.log.append(log[f.pos()])  #@copy
            sent += 1  #@copy
        return sent
    # endregion

    # region write
    def write(self, key, value):
        """Append on the leader, replicate, then answer."""
        lead = self.leader
        lead.log.append(Entry(self.epoch, key, value))  #@append
        acks = 0
        for f in self.needed():  #@wait
            if f.held:  #@held
                # The wait timed out: stop waiting from now on.
                self.semi_off = True  #@timeout
            else:
                self.ship_all(f)  #@sync_copy
                acks += 1  #@sync_copy
        self.wrote = lead.pos()  #@ack
        for f in self.followers():  #@async
            if not f.held and f.pos() < lead.pos():  #@async
                self.ship_all(f)  #@async_copy
        return self.wrote
    # endregion

    # region read
    def read(self, name, key):
        """Read from one replica as it is. It can be stale."""
        r = self.live(name)  #@r_pick
        # The newest position this client knows of, if it survived.
        want = min(max(self.wrote, self.seen), self.leader.pos())  #@want
        behind = r.pos() < want  #@stale
        self.seen = max(self.seen, r.pos())  #@serve
        return r.get(key), behind  #@serve
    # endregion

    # region read_your_writes
    def read_your_writes(self, name, key):
        """Read only from a replica that has the client's write."""
        r = self.live(name)  #@y_pick
        if r is not self.leader and r.pos() < self.wrote:  #@ryw_check
            # Waiting for r to catch up would also do.
            r = self.leader  #@route
        self.seen = max(self.seen, r.pos())  #@ryw_serve
        return r.get(key), r.name  #@ryw_serve
    # endregion

    # region lag
    def lag(self, name):
        """Hold back a follower's link. Sync mode refuses."""
        f = self.follower(name)  #@l_pick
        if self.mode == "sync":  #@sync_only
            return False  # it would stall every write  #@sync_only
        f.held = True  #@hold
        return True  #@hold
    # endregion

    # region catch_up
    def catch_up(self, name):
        """Release a held follower and send what it missed."""
        f = self.follower(name)  #@c_pick
        f.held = False  #@release
        sent = self.ship_all(f)  #@ship
        if f is self.sync_follower():  #@resync
            self.semi_off = False  #@resync
        return sent  #@c_done
    # endregion

    # region fail_leader
    def fail_leader(self):
        """The leader dies: promote the most up-to-date follower."""
        old = self.leader
        if not self.followers():  #@f_check
            return None  #@f_check
        old.alive = False  #@die
        best = None
        for f in self.followers():  #@candidates
            if best is None or f.pos() > best.pos():  #@better
                best = f  #@best
        self.epoch += 1  #@promote
        best.epoch = self.epoch  #@promote
        best.held = False  #@promote
        self.leader = best  #@promote
        lost = old.pos() - best.pos()  #@lost
        self.semi_off = False  #@repoint
        rest = self.followers()  #@repoint
        self.sync_name = rest[0].name if rest else None  #@repoint
        for f in rest:  #@repoint
            f.held = False  #@repoint
            f.epoch = self.epoch  #@repoint
            self.ship_all(f)  #@repoint
        return lost
    # endregion

    # region rejoin
    def rejoin(self, name):
        """A failed node returns, drops what the leader lacks, follows."""
        node = self.replicas[name]
        if node.alive:  #@j_check
            return None  #@j_check
        lead = self.leader
        if node.epoch < self.epoch:  #@fence
            node.epoch = self.epoch  # an old leader steps down  #@fence
        n = node.pos()
        while n > 0 and not agrees(node, lead, n):  #@match
            n -= 1  #@match
        dropped = node.pos() - n  #@truncate
        del node.log[n:]  #@truncate
        node.alive = True  #@follow
        node.held = False  #@follow
        self.ship_all(node)  #@follow
        return dropped
    # endregion
