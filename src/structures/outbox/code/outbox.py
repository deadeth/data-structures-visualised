import copy
from dataclasses import dataclass


class Crash(Exception):
    """The process died at an armed fail point."""


@dataclass(frozen=True)
class Event:
    id: int
    account: int
    amount: int


class ServiceDb:
    """The service's database: a business table and the outbox."""

    def __init__(self, balances):
        self.accounts = dict(balances)  # account id -> balance
        self.outbox = []  # rows: {"event": Event, "published": bool}

    def begin(self):
        """A transaction works on a copy; commit swaps it in."""
        return copy.deepcopy(self)


class ConsumerDb:
    """The consumer's own database: its totals and processed ids."""

    def __init__(self, balances):
        self.totals = dict(balances)
        self.processed = set()

    def begin(self):
        return copy.deepcopy(self)


class Outbox:
    """A service, its database, a relay, a log and one consumer."""

    def __init__(self, balances, approach="outbox"):
        self.approach = approach
        self.db = ServiceDb(balances)
        self.log = []  # one partition: offset i holds log[i]
        self.next_id = 1
        self.consumer_db = ConsumerDb(balances)
        self.position = 0  # the consumer's next offset
        self.armed = None  # fail point that will crash, if any

    def fail_point(self, name):
        if self.armed == name:
            raise Crash(name)

    def new_event(self, account, amount):
        event = Event(self.next_id, account, amount)
        self.next_id += 1
        return event

    # region approach
    def set_approach(self, approach):
        """Later writes use "dual" or "outbox"."""
        self.approach = approach  #@set
    # endregion

    # region write
    def write(self, account, amount):
        if self.approach == "outbox":  #@choose
            return self.write_outbox(account, amount)  #@choose
        return self.write_dual(account, amount)  #@choose
    # endregion

    # region write_dual
    def write_dual(self, account, amount):
        """Two systems, two steps, and nothing ties them."""
        tx = self.db.begin()  #@begin
        tx.accounts[account] += amount  #@begin
        self.db = tx  # commit  #@commit
        event = self.new_event(account, amount)  #@event
        self.fail_point("after_commit")  #@between
        self.log.append(event)  #@publish
        return event  #@dual_done
    # endregion

    # region write_outbox
    def write_outbox(self, account, amount):
        """One transaction holds the change and its event."""
        tx = self.db.begin()  #@tx_begin
        tx.accounts[account] += amount  #@tx_begin
        event = self.new_event(account, amount)  #@tx_outbox
        tx.outbox.append({"event": event, "published": False})  #@tx_outbox
        self.fail_point("before_commit")  #@before_commit
        self.db = tx  # commit  #@tx_commit
        self.fail_point("after_commit")  #@after_commit
        return event  #@tx_done
    # endregion

    # region crash_between
    def crash_between(self, account, amount):
        """The service dies straight after its database commit."""
        self.armed = "after_commit"  #@arm
        try:
            return self.write(account, amount)  #@arm
        except Crash:
            return None  #@restart
        finally:
            self.armed = None  #@restart
    # endregion

    # region crash_before
    def crash_before_commit(self, account, amount):
        """The service dies inside its transaction."""
        self.armed = "before_commit"  #@arm_before
        try:
            if self.approach == "outbox":  #@arm_before
                return self.write_outbox(account, amount)
            return self.publish_first(account, amount)
        except Crash:
            return None  #@restart_before
        finally:
            self.armed = None  #@restart_before
    # endregion

    # region publish_first
    def publish_first(self, account, amount):
        """Dual write the other way round: publish, then commit."""
        event = self.new_event(account, amount)  #@pf_event
        self.log.append(event)  #@pf_publish
        tx = self.db.begin()  #@pf_begin
        tx.accounts[account] += amount  #@pf_begin
        self.fail_point("before_commit")  #@pf_fail
        self.db = tx  # commit  #@pf_commit
        return event  #@pf_commit
    # endregion

    # region relay
    def relay(self):
        """Publish unpublished rows in outbox order, then mark them."""
        rows = [r for r in self.db.outbox if not r["published"]]  #@query
        for row in rows:  #@query
            self.log.append(row["event"])  #@relay_publish
            self.fail_point("relay")  #@relay_crash
            row["published"] = True  # UPDATE outbox  #@mark
        return len(rows)  #@relay_done
    # endregion

    # region crash_relay
    def crash_relay(self):
        """The relay dies between publish and mark, then restarts."""
        self.armed = "relay"  #@relay_arm
        try:
            self.relay()  #@relay_arm
        except Crash:
            pass  #@relay_restart
        finally:
            self.armed = None  #@relay_restart
        return self.relay()  #@relay_restart
    # endregion

    # region consume
    def consume(self):
        """Apply the next event once, however often it arrives."""
        if self.position >= len(self.log):  #@caught_up
            return None  #@caught_up
        event = self.log[self.position]  #@read
        if event.id in self.consumer_db.processed:  #@seen
            self.position += 1  #@skip
            return False  #@skip
        tx = self.consumer_db.begin()  #@apply
        tx.totals[event.account] += event.amount  #@apply
        tx.processed.add(event.id)  #@record
        self.consumer_db = tx  # commit both  #@commit_c
        self.position += 1  #@commit_c
        return True  #@commit_c
    # endregion

    # region prune
    def prune(self):
        """Delete outbox rows the relay has already published."""
        kept = []
        for row in self.db.outbox:  #@prune_each
            if not row["published"]:  #@prune_check
                kept.append(row)  #@prune_keep
        removed = len(self.db.outbox) - len(kept)  #@prune_delete
        self.db.outbox = kept  # DELETE ... WHERE published  #@prune_delete
        return removed  #@prune_delete
    # endregion
