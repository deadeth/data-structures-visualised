from collections import deque

STEPS = [  # (service, action, compensation)
    ("ledger", "reserve", "release"),
    ("limits", "hold", "unhold"),
    ("gateway", "submit", None),  # the pivot: no way back
    ("ledger", "post", None),  # after the pivot: retry, never undo
]
LIVE = ("running", "compensating")


class Refused(Exception):
    """A business rule said no. The local transaction rolled back."""


class Unavailable(Exception):
    """The service is down. Nothing ran."""


class Pending(Exception):
    """Another saga's hold is in the way. Try again later."""


class Crash(Exception):
    """The page's way to stop the orchestrator mid-saga."""


class Service:
    """A service with its own database and local transactions."""

    def __init__(self):
        self.replies = {}  # idempotency key -> reply, in its own db
        self.refuse = False  # page switch: refuse the next command
        self.down = 0  # page switch: calls to drop

    # region handle
    def handle(self, key, action, saga, amount):
        """Run each key at most once, in one local transaction."""
        if self.down:  #@down
            self.down -= 1  #@down
            raise Unavailable(key)  #@down
        if key in self.replies:  #@dedupe
            return self.replies[key]  # no second effect  #@dedupe
        if self.refuse:  #@refuse
            self.refuse = False  #@refuse
            raise Refused(action)  # rolled back  #@refuse
        reply = getattr(self, action)(saga, amount)  #@local
        self.replies[key] = reply  # same transaction  #@local
        return reply  #@reply
    # endregion


class Ledger(Service):
    """The payer's balance, with a hold per saga in flight."""

    def __init__(self, balance):
        super().__init__()
        self.balance = balance
        self.holds = {}  # saga -> amount: a semantic lock

    # region ledger
    def reserve(self, saga, amount):
        """Hold the money. Others see it as pending."""
        held = sum(self.holds.values())
        free = self.balance - held  #@free
        if free >= amount:  #@check
            self.holds[saga] = amount  #@reserved
            return "reserved"  #@reserved
        if free + held >= amount:  # only holds in the way  #@pending
            raise Pending(saga)  #@pending
        raise Refused("insufficient funds")  #@insufficient

    def release(self, saga, amount):
        """Compensation: drop the hold."""
        self.holds.pop(saga, None)  #@release
        return "released"  #@release

    def post(self, saga, amount):
        """Turn the hold into a debit. Cannot refuse."""
        self.balance -= self.holds.pop(saga)  #@post
        return "posted"  #@post
    # endregion


class Limits(Service):
    """How much of today's payment limit is used."""

    def __init__(self, limit):
        super().__init__()
        self.limit = limit
        self.used = 0
        self.holds = {}  # saga -> amount

    # region limits
    def hold(self, saga, amount):
        """Count the payment against today's limit."""
        if self.used + amount > self.limit:  #@limit_check
            raise Refused("over the daily limit")  #@over_limit
        self.used += amount  #@held
        self.holds[saga] = amount  #@held
        return "held"  #@held

    def unhold(self, saga, amount):
        """Compensation: give the limit back."""
        self.used -= self.holds.pop(saga, 0)  #@unheld
        return "returned"  #@unheld
    # endregion


class Gateway(Service):
    """Submits payments to the scheme. Accepted is final."""

    def __init__(self):
        super().__init__()
        self.sent = {}  # saga -> amount the scheme accepted

    # region gateway
    def submit(self, saga, amount):
        """The pivot: once accepted, the money has gone."""
        self.sent[saga] = amount  #@submitted
        return "accepted"  #@submitted
    # endregion


class Orchestrator:
    """Drives sagas. The only memory that matters is the saga log."""

    def __init__(self, services, log):
        self.services = services  # name -> service
        self.log = log  # saga -> row, on disk: survives a crash
        self.lost = set()  # page switch: keys whose reply is lost
        self.crash_after = None  # page switch: die after this key
        self.retries = 0

    # region start
    def start(self, saga, amount):
        """Write the saga's row before doing anything else."""
        self.log[saga] = {"amount": amount, "done": 0,  #@begin
                          "state": "running"}  #@begin
        self.run(saga)  #@run
    # endregion

    # region run
    def run(self, saga):
        """Take steps until the saga ends or has to wait."""
        while self.log[saga]["state"] in LIVE:  #@loop
            self.step(saga)  #@loop
    # endregion

    # region step
    def step(self, saga):
        """Do the next action, or undo the newest one."""
        row = self.log[saga]  #@read
        if row["state"] == "compensating":  #@read
            self.compensate(saga)  #@to_comp
            return  #@to_comp
        i = row["done"]  #@read
        name, action, _ = STEPS[i]
        key = f"{saga}-{i + 1}"  # same key on every retry  #@key
        try:
            self.call(name, key, action, saga)  #@send
        except Refused:  # only before the pivot  #@failed
            row["state"] = "compensating"  # on disk  #@failed
            return  #@failed
        except Pending:  #@park
            row["state"] = "waiting"  # on disk  #@park
            return  #@park
        row["done"] = i + 1  # on disk: progress  #@record
        if row["done"] == len(STEPS):  #@record
            row["state"] = "completed"  #@completed
    # endregion

    # region compensate
    def compensate(self, saga):
        """Undo the newest step still in effect, then record it."""
        row = self.log[saga]
        i = row["done"] - 1  # newest step in effect  #@undo_next
        if i < 0:  #@undo_next
            row["state"] = "compensated"  # on disk  #@compensated
            return  #@compensated
        name, _, undo = STEPS[i]
        key = f"{saga}-undo-{i + 1}"  #@undo_key
        self.call(name, key, undo, saga)  # retried until done  #@undo_send
        row["done"] = i  # on disk  #@undo_record
    # endregion

    # region call
    def call(self, name, key, action, saga):
        """Send a command. On silence, send it again: same key."""
        amount = self.log[saga]["amount"]
        while True:
            try:
                reply = self.services[name].handle(  #@send_cmd
                    key, action, saga, amount)  #@send_cmd
            except Unavailable:  #@timeout
                self.retries += 1  # real code backs off  #@timeout
                continue  #@timeout
            if key == self.crash_after:  # page switch  #@crash
                raise Crash(key)  # dies before it records  #@crash
            if key in self.lost:  # the reply never arrives  #@lost
                self.lost.discard(key)  #@lost
                self.retries += 1  #@lost
                continue  #@lost
            return reply  #@got
    # endregion

    # region recover
    def recover(self):
        """After a restart: resume what the log says is unfinished."""
        for saga, row in self.log.items():  #@scan
            if row["state"] in LIVE:  #@unfinished
                self.run(saga)  #@resume
    # endregion

    # region retry_waiting
    def retry_waiting(self):
        """Try parked sagas again once the holds have cleared."""
        for saga, row in self.log.items():
            if row["state"] == "waiting":  #@parked
                row["state"] = "running"  #@unpark
                self.run(saga)  #@unpark
    # endregion


REACTIONS = {  # event -> (service, action, if done, if refused)
    "requested": ("ledger", "reserve", "reserved", "failed"),
    "reserved": ("limits", "hold", "held", "over_limit"),
    "held": ("gateway", "submit", "accepted", "rejected"),
    "accepted": ("ledger", "post", "posted", None),
    "over_limit": ("ledger", "release", "failed", None),
    "rejected": ("limits", "unhold", "returned", None),
    "returned": ("ledger", "release", "failed", None),
}


class Choreography:
    """No coordinator: each service reacts to the event before."""

    def __init__(self, services):
        self.services = services
        self.queue = deque()  # the broker

    # region chor_start
    def start(self, saga, amount):
        """Publish the request. Nobody keeps a saga row."""
        self.queue.append(("requested", saga, amount))  #@request
        self.drain()  #@request

    def drain(self):
        """Deliver events until none are left."""
        while self.queue:  #@deliver
            self.deliver()  #@deliver
    # endregion

    # region react
    def deliver(self):
        """One service takes one event: a local txn, then an event."""
        event, saga, amount = self.queue.popleft()  #@listener
        if event not in REACTIONS:  # posted or failed: the end  #@end
            return  #@end
        name, action, done, refused = REACTIONS[event]  #@listener
        key = f"{saga}-{event}"  # a redelivery is deduplicated  #@ev_key
        try:
            self.services[name].handle(key, action, saga, amount)  #@ev_local
            nxt = done  #@ev_done
        except Refused:  #@ev_refused
            nxt = refused  #@ev_refused
        self.queue.append((nxt, saga, amount))  # via an outbox  #@emit
    # endregion
