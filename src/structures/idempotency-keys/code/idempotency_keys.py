import threading
import uuid

WINDOW = 24  # hours a key is kept before it may be pruned


def fingerprint(amount):
    """A hash of the request body. Real servers hash every field."""
    return (31 * amount + 7) % 1009


def new_key():
    """A random key: the page shows k1, k2 instead."""
    return str(uuid.uuid4())


class PaymentUnknown(Exception):
    """Every attempt timed out: the payment may or may not exist."""

    def __init__(self, key, amount):
        super().__init__(key)
        self.key = key
        self.amount = amount


class ServerCrash(Exception):
    """The server process died part way through a request."""


class Row:
    """One row of idempotency_keys."""

    def __init__(self, request_hash, created):
        self.hash = request_hash
        self.status = "in-progress"
        self.response = None
        self.created = created


class Database:
    """Two tables and a balance, with a unique index on the key."""

    def __init__(self, balance=1000):
        self.keys = {}  # idempotency_keys, by key
        self.payments = {}  # payments: id -> amount
        self.balance = balance
        self.next_id = 1  # a sequence: never rolled back
        self.now = 0  # the clock, in hours
        self.held = set()  # keys inserted by open transactions
        self.cond = threading.Condition()
        self.crash = None  # test hook: "before" or "after" commit

    def begin(self):
        return Tx(self)

    # region prune
    def prune(self, now):
        """Forget keys older than the window."""
        for key in list(self.keys):  #@scan
            if now - self.keys[key].created >= WINDOW:  #@age
                del self.keys[key]  #@drop
    # endregion


class Tx:
    """One transaction: all of its writes commit, or none do."""

    def __init__(self, db):
        self.db = db
        self.rows = {}
        self.payments = {}
        self.done = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if not self.done:
            self.rollback()  # a crash or an early return
        return False

    # region insert_key
    def insert_key(self, key, request_hash):
        """INSERT under the unique index; False if the key exists."""
        db = self.db
        with db.cond:
            while key in db.held:  #@wait
                db.cond.wait()  # another transaction holds it
            if key in db.keys:
                return False  #@exists
            db.held.add(key)  #@hold
        self.rows[key] = Row(request_hash, db.now)
        return True
    # endregion

    def read_key(self, key):
        with self.db.cond:
            return self.db.keys[key]

    def insert_payment(self, amount):
        with self.db.cond:
            payment_id = f"p{self.db.next_id}"
            self.db.next_id += 1
        self.payments[payment_id] = amount
        return payment_id

    def finish_key(self, key, response):
        row = self.rows[key]
        row.status = "done"
        row.response = response

    def commit(self):
        db = self.db
        if db.crash == "before":
            db.crash = None
            raise ServerCrash()
        with db.cond:
            db.keys.update(self.rows)
            db.payments.update(self.payments)
            db.balance -= sum(self.payments.values())
            db.held -= set(self.rows)
            db.cond.notify_all()
        self.done = True
        if db.crash == "after":
            db.crash = None
            raise ServerCrash()

    def rollback(self):
        db = self.db
        with db.cond:
            db.held -= set(self.rows)
            db.cond.notify_all()
        self.done = True


class Server:
    """POST /payments, with or without idempotency keys."""

    def __init__(self, db, use_keys=True):
        self.db = db
        self.use_keys = use_keys

    # region receive
    def receive(self, key, amount):
        """One request: Idempotency-Key header and an amount."""
        if self.use_keys:  #@mode
            return self.handle(key, amount)
        return self.handle_no_keys(amount)  # the key is ignored
    # endregion

    # region handle
    def handle(self, key, amount):
        """Charge once per key; a repeat gets the first answer."""
        request_hash = fingerprint(amount)  #@hash
        with self.db.begin() as tx:  #@begin
            if not tx.insert_key(key, request_hash):  #@insert
                row = tx.read_key(key)  #@read
                if row.hash != request_hash:  #@compare
                    return (422, "key reused, body differs")  #@mismatch
                return row.response  #@replay
            payment_id = tx.insert_payment(amount)  #@apply
            response = (201, payment_id)
            tx.finish_key(key, response)  #@store
            tx.commit()  #@commit
        return response  #@reply
    # endregion

    # region handle_no_keys
    def handle_no_keys(self, amount):
        """Without keys, every request that arrives is charged."""
        with self.db.begin() as tx:  #@plain_begin
            payment_id = tx.insert_payment(amount)  #@plain_apply
            tx.commit()  #@plain_commit
        return (201, payment_id)  #@plain_reply
    # endregion


class Network:
    """Loses a request or a response when told to."""

    def __init__(self):
        self.fates = []  # per call: None, "request", "response", "twice"

    def call(self, server, key, amount):
        fate = self.fates.pop(0) if self.fates else None
        if fate == "request":
            raise TimeoutError()
        if fate == "twice":
            return self.twice(server, key, amount)
        try:
            response = server.receive(key, amount)
        except ServerCrash:
            raise TimeoutError()
        if fate == "response":
            raise TimeoutError()
        return response

    def twice(self, server, key, amount):
        """Deliver two copies at once and return both answers."""
        out = [None, None]

        def run(i):
            out[i] = server.receive(key, amount)

        threads = [threading.Thread(target=run, args=(i,)) for i in (0, 1)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return out[0], out[1]


class Client:
    """Pays through a lossy network and retries on timeout."""

    def __init__(self, server, network, attempts=3):
        self.server = server
        self.network = network
        self.attempts = attempts

    # region pay
    def pay(self, amount):
        """Pay once: one key, reused on every attempt."""
        key = new_key()  #@new_key
        for _ in range(self.attempts):  #@retry
            try:
                return self.network.call(self.server, key, amount)  #@send
            except TimeoutError:  #@timeout
                pass  # it may have worked: same key again
        raise PaymentUnknown(key, amount)  #@give_up
    # endregion

    # region pay_new_key
    def pay_new_key(self, amount):
        """The bug: a fresh key for every attempt."""
        for _ in range(self.attempts):  #@retry_new
            key = new_key()  #@fresh_key
            try:
                return self.network.call(self.server, key, amount)  #@send_new
            except TimeoutError:  #@timeout_new
                pass
        raise PaymentUnknown(None, amount)
    # endregion

    # region resend
    def resend(self, key, amount):
        """Send an earlier request again, under its own key."""
        return self.network.call(self.server, key, amount)  #@resend
    # endregion
