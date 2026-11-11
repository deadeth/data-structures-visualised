class Server:
    """One Raft server. term, voted_for and log survive a crash."""

    def __init__(self, sid):
        self.id = sid
        self.role = "follower"
        self.term = 0
        self.voted_for = None
        self.log = []  # (term, value) pairs; index 1 is log[0]
        self.commit = 0  # highest index known to be committed
        self.up = True
        self.next = {}  # leader only: next index to send, per peer
        self.match = {}  # leader only: highest index known to match

    def last_term(self):
        return self.log[-1][0] if self.log else 0


class Raft:
    """A Raft cluster in one process, one message at a time."""

    def __init__(self, n=5, max_log=6):
        self.servers = [Server(i) for i in range(1, n + 1)]
        self.cut = set()  # ids on the far side of a partition
        self.max_log = max_log  # the page draws this many entries

    def majority(self):
        return len(self.servers) // 2 + 1

    def peers(self, s):
        return [p for p in self.servers if p is not s]

    def reachable(self, a, b):
        return a.up and b.up and (a.id in self.cut) == (b.id in self.cut)

    def step_down(self, s, term):
        if term > s.term:
            s.term = term
            s.voted_for = None
        s.role = "follower"

    def client_leader(self):
        """The leader a client finds: the newest term wins."""
        leaders = [s for s in self.servers if s.up and s.role == "leader"]
        return max(leaders, key=lambda s: s.term, default=None)

    def leader_for(self, s):
        """The newest leader that can reach s."""
        leaders = [
            l for l in self.servers
            if l.role == "leader" and self.reachable(l, s)
        ]
        return max(leaders, key=lambda l: l.term, default=None)

    # region timeout
    def timeout(self, c):
        """c heard no heartbeat in time, so it stands for leader."""
        if not c.up or c.role == "leader":  #@skip
            return False  #@skip
        c.role = "candidate"  #@stand
        c.term += 1  #@stand
        c.voted_for = c.id  #@stand
        votes = 1  #@stand
        for p in self.peers(c):  # sent in parallel in real life
            if not self.reachable(c, p):  #@lost
                continue  #@lost
            if p.term > c.term:  #@term
                self.step_down(c, p.term)  #@behind
                return False  #@behind
            if p.term < c.term:  #@term
                self.step_down(p, c.term)  #@adopt
            if p.voted_for not in (None, c.id):  #@voted
                continue  #@refuse
            if not self.up_to_date(c, p):  #@log_check
                continue  #@refuse
            p.voted_for = c.id  #@grant
            votes += 1  #@grant
        if votes < self.majority():  #@tally
            return False  #@split
        self.become_leader(c)  #@win
        return True
    # endregion

    # region up_to_date
    def up_to_date(self, c, p):
        """Is c's log at least as up to date as p's?"""
        if c.last_term() != p.last_term():  #@last_term
            return c.last_term() > p.last_term()  #@newer
        return len(c.log) >= len(p.log)  #@last_index
    # endregion

    # region become_leader
    def become_leader(self, c):
        """Guess every log matches ours, then add a no-op."""
        c.role = "leader"  #@lead
        for p in self.peers(c):
            c.next[p.id] = len(c.log) + 1  #@lead
            c.match[p.id] = 0  #@lead
        if len(c.log) < self.max_log:
            c.log.append((c.term, None))  #@noop
        if self.broadcast(c):  #@send
            self.advance_commit(c)  #@count
    # endregion

    # region write
    def write(self, value):
        """A client write. True once it is committed."""
        leader = self.client_leader()  #@find
        if leader is None:
            return False  #@no_leader
        if len(leader.log) >= self.max_log:  #@full
            return False  #@full
        leader.log.append((leader.term, value))  #@append
        index = len(leader.log)  #@append
        if not self.broadcast(leader):  #@send
            return False  #@send
        self.advance_commit(leader)  #@count
        return leader.commit >= index  #@count
    # endregion

    # region broadcast
    def broadcast(self, leader):
        """AppendEntries to every peer. False if deposed."""
        for p in self.peers(leader):  #@each
            if not self.reachable(leader, p):  #@unreachable
                continue  #@unreachable
            if not self.replicate(leader, p):  #@rpc
                return False  #@rpc
        return True
    # endregion

    # region replicate
    def replicate(self, leader, f):
        """Bring f's log into line with the leader's."""
        if f.term > leader.term:  #@check_term
            self.step_down(leader, f.term)  #@deposed
            return False  #@deposed
        self.step_down(f, leader.term)  #@follow
        while True:
            prev = leader.next[f.id] - 1  #@prev
            if prev == 0:  #@empty
                break  #@empty
            if prev <= len(f.log):  #@has_prev
                if f.log[prev - 1][0] == leader.log[prev - 1][0]:  #@same_term
                    break  #@agree
            leader.next[f.id] -= 1  # each retry is a round trip  #@back
        for i in range(prev + 1, len(leader.log) + 1):
            entry = leader.log[i - 1]
            if i <= len(f.log):
                if f.log[i - 1][0] == entry[0]:  #@conflict
                    continue  #@already
                del f.log[i - 1:]  #@truncate
            f.log.append(entry)  #@copy
        leader.match[f.id] = len(leader.log)  #@ack
        leader.next[f.id] = len(leader.log) + 1  #@ack
        learned = min(leader.commit, len(leader.log))  #@ack
        f.commit = max(f.commit, learned)  #@ack
        return True
    # endregion

    # region advance_commit
    def advance_commit(self, leader):
        """Commit the highest index a majority holds."""
        top = len(leader.log)
        for n in range(top, leader.commit, -1):  #@scan
            copies = 1 + sum(  #@scan
                1 for m in leader.match.values() if m >= n
            )
            if copies < self.majority():  #@majority
                continue  #@fewer
            if leader.log[n - 1][0] != leader.term:  #@own_term
                return False  # wait for an entry of this term  #@older
            leader.commit = n  #@commit
            for p in self.peers(leader):  # the next heartbeat  #@tell
                if self.reachable(leader, p):  #@tell
                    known = min(n, leader.match[p.id])  #@tell
                    p.commit = max(p.commit, known)  #@tell
            return True
        return False  #@waiting
    # endregion

    # region crash
    def crash(self, s):
        """s stops. Its term, vote and log are on disk."""
        s.up = False  #@crash
        s.next, s.match = {}, {}  #@crash
    # endregion

    # region recover
    def recover(self, s):
        """s restarts as a follower and hears from a leader."""
        s.up = True  #@restart
        s.role = "follower"  #@restart
        s.commit = 0  # only in memory: learned again  #@restart
        leader = self.leader_for(s)  #@find_leader
        if leader is None:
            return  #@no_leader
        if self.replicate(leader, s):  #@rpc
            self.advance_commit(leader)  #@rpc
    # endregion

    # region partition
    def partition(self, s):
        """Cut s off from the servers on the other side."""
        if s.id not in self.cut:
            if len(self.cut) + 1 == len(self.servers):
                return False  # nobody left on the other side  #@refuse
            self.cut.add(s.id)  #@cut
        return True  #@cut
    # endregion

    # region heal
    def heal(self):
        """Reconnect everyone. Leaders send heartbeats."""
        self.cut.clear()  #@heal
        leaders = [s for s in self.servers if s.role == "leader"]
        leaders.sort(key=lambda s: -s.term)  # newest first  #@leaders
        for leader in leaders:
            if leader.up and leader.role == "leader":  #@heartbeat
                if self.broadcast(leader):  #@heartbeat
                    self.advance_commit(leader)  #@heartbeat
    # endregion

    # region reset
    def reset(self):
        """A fresh cluster: every server a follower in term 0."""
        n = len(self.servers)  #@reset
        self.servers = [Server(i) for i in range(1, n + 1)]  #@reset
        self.cut.clear()  #@reset
    # endregion
