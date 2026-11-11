DONE = {"commit": "committed", "abort": "aborted"}


class Blocked(Exception):
    """A row is locked by a transaction that is still in doubt."""


class Participant:
    """One database that does a part of every transaction."""

    def __init__(self, name):
        self.name = name
        self.state = "working"
        self.locks = set()  # in memory: a crash loses them
        self.log = []  # on disk: survives a crash
        self.up = True
        self.refuse = False  # vote no at the next prepare

    # region begin
    def begin(self, txn):
        """Do txn's write here, under a lock on the row."""
        if self.locks:  #@wait
            raise Blocked(self.name)  # a real lock would queue  #@wait
        self.locks.add(txn)  #@lock
        self.state = "working"  #@lock
    # endregion

    # region prepare
    def prepare(self, txn):
        """Phase 1: vote. None means no answer came back."""
        if not self.up:  #@silent
            return None  # the coordinator times out  #@silent
        if self.refuse:  # say a constraint check failed  #@refuse
            self.refuse = False
            self.log.append(("abort", txn))  #@refuse
            self.locks.discard(txn)  #@refuse
            self.state = "aborted"  #@refuse
            return False  #@refuse
        self.log.append(("prepared", txn))  # forced to disk  #@prepared
        self.state = "prepared"  # in doubt until told  #@prepared
        return True  #@prepared
    # endregion

    # region finish
    def finish(self, txn, decision):
        """Phase 2: apply the decision, unlock, ack."""
        if not self.up:  #@down
            return False  # no ack: the coordinator retries  #@down
        if (decision, txn) not in self.log:  # idempotent  #@apply
            self.log.append((decision, txn))  #@apply
        self.locks.discard(txn)  #@release
        self.state = DONE[decision]  #@release
        return True  #@release
    # endregion

    def crash(self):
        """Memory is lost: state and locks. The log is not."""
        self.up = False
        self.locks.clear()

    def in_doubt(self):
        """Transactions prepared here with no decision after."""
        decided = {t for kind, t in self.log if kind != "prepared"}
        return [t for kind, t in self.log
                if kind == "prepared" and t not in decided]

    # region restart
    def restart(self, coordinator):
        """Come back from the log, then ask what is in doubt."""
        self.up = True  #@restart
        doubt = self.in_doubt()  #@scan
        if not doubt:  #@scan
            self.state = "aborted"  # unvoted work rolls back  #@undo
        for txn in doubt:
            self.locks.add(txn)  # the record says what to lock  #@relock
            self.state = "prepared"  #@relock
        self.resolve(coordinator)  #@resolve
    # endregion

    # region resolve
    def resolve(self, coordinator):
        """Ask how each in-doubt transaction ended."""
        for txn in self.in_doubt():  #@doubt
            decision = coordinator.ask(txn)  #@ask
            if decision is None:  # no answer  #@block
                continue  # cannot decide alone: keep the locks  #@block
            self.finish(txn, decision)  #@learn
            coordinator.ack(txn, self.name)  #@learn
    # endregion


class Coordinator:
    """Runs two-phase commit over a fixed set of participants."""

    def __init__(self, participants):
        self.participants = participants
        self.log = []  # on disk: survives a crash
        self.waiting = {}  # txn -> names yet to ack; in memory
        self.up = True

    # region commit
    def commit(self, txn):
        """Run txn at every participant: all or nothing."""
        for p in self.participants:  #@begin
            p.begin(txn)  #@begin
        decision = self.phase_one(txn)  #@phase_one
        self.log.append((decision, txn))  # forced to disk  #@decide
        self.phase_two(txn, decision)  #@phase_two
        return decision  #@done
    # endregion

    # region phase_one
    def phase_one(self, txn):
        """Ask everyone to prepare, then count the yes votes."""
        yes = 0
        # Sent to all at once in practice; one by one here.
        for p in self.participants:  #@send_prepare
            if p.prepare(txn):  # None (timed out) counts as no  #@vote
                yes += 1  #@vote
        if yes == len(self.participants):  #@count
            return "commit"  #@count
        return "abort"  #@count
    # endregion

    # region phase_two
    def phase_two(self, txn, decision):
        """Send the decision. Keep a commit until all ack."""
        missing = set()
        for p in self.participants:  #@send
            if not p.finish(txn, decision):  #@send
                missing.add(p.name)  #@missing
        if decision == "abort":  #@no_acks
            return  # presumed abort: nothing to keep  #@no_acks
        if missing:  #@acks
            self.waiting[txn] = missing  # retry until they ack  #@missing
        else:
            self.log.append(("end", txn))  # may forget txn  #@end
    # endregion

    # region ack
    def ack(self, txn, name):
        """A late ack, from a participant that restarted."""
        missing = self.waiting.get(txn)
        if not missing:  # an abort, or already ended
            return
        missing.discard(name)  #@late_ack
        if not missing:  #@late_ack
            del self.waiting[txn]
            self.log.append(("end", txn))  #@late_end
    # endregion

    # region ask
    def ask(self, txn):
        """Tell a participant in doubt how txn ended."""
        if not self.up:  #@no_answer
            return None  #@no_answer
        for kind, t in self.log:  #@lookup
            if t == txn and kind != "end":  #@lookup
                return kind  #@known
        return "abort"  # no record: presumed abort  #@presumed
    # endregion

    # region recover
    def recover(self):
        """Restart: finish each commit the log has not ended."""
        if self.up:  #@running
            return  #@running
        self.up = True  #@reboot
        ended = {t for kind, t in self.log if kind == "end"}
        for kind, txn in list(self.log):  #@replay
            if kind == "commit" and txn not in ended:  #@found
                self.phase_two(txn, "commit")  #@found
        # Anyone still in doubt asks, and hears abort.
        for p in self.participants:  #@asked
            p.resolve(self)  #@asked
    # endregion

    # region vote_no
    def commit_with_no(self, txn, voter):
        """Run txn with one participant refusing to prepare."""
        voter.refuse = True  #@arm
        return self.commit(txn)  #@run
    # endregion

    # region crash_participant
    def commit_with_crash(self, txn, victim, after_vote):
        """Run txn while one participant fails in phase 1."""
        for p in self.participants:  #@begin
            p.begin(txn)  #@begin
        if not after_vote:
            victim.crash()  # before it can vote  #@crash
        decision = self.phase_one(txn)  #@phase_one
        if after_vote:
            victim.crash()  # its yes vote was already sent  #@crash
        self.log.append((decision, txn))  # forced to disk  #@decide
        self.phase_two(txn, decision)  #@phase_two
        victim.restart(self)  #@restart_victim
        return decision  #@done
    # endregion

    # region crash_coordinator
    def crash_after_votes(self, txn, logged):
        """Collect the votes, then fail before sending any."""
        for p in self.participants:  #@begin
            p.begin(txn)  #@begin
        decision = self.phase_one(txn)  #@phase_one
        if logged:  #@logged
            self.log.append((decision, txn))  #@decide
        self.up = False  # memory is gone; the log is not  #@crash
        self.waiting = {}  #@crash
        for p in self.participants:  #@wait_out
            p.resolve(self)  # each times out and asks  #@wait_out
    # endregion
