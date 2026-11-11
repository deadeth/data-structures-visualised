import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** A payment API that makes retries safe with idempotency keys. */
public class IdempotencyKeys {
    static final int WINDOW = 24; // hours a key is kept before pruning

    /** A hash of the request body. Real servers hash every field. */
    static int fingerprint(int amount) {
        return (31 * amount + 7) % 1009;
    }

    /** A random key: the page shows k1, k2 instead. */
    static String newKey() {
        return UUID.randomUUID().toString();
    }

    record Response(int status, String body) {}

    /** Every attempt timed out: the payment may or may not exist. */
    static class PaymentUnknown extends RuntimeException {
        final String key;
        final int amount;

        PaymentUnknown(String key, int amount) {
            super(key);
            this.key = key;
            this.amount = amount;
        }
    }

    /** The server process died part way through a request. */
    static class ServerCrash extends RuntimeException {}

    /** No answer came back in time. */
    static class Timeout extends Exception {}

    /** One row of idempotency_keys. */
    static class Row {
        final int hash;
        final long created;
        String status = "in-progress";
        Response response;

        Row(int hash, long created) {
            this.hash = hash;
            this.created = created;
        }
    }

    /** Two tables and a balance, with a unique index on the key. */
    static class Database {
        final Map<String, Row> keys = new HashMap<>();
        final Map<String, Integer> payments = new HashMap<>();
        long balance = 1000;
        int nextId = 1; // a sequence: never rolled back
        long now; // the clock, in hours
        final Set<String> held = new HashSet<>(); // keys of open txns
        String crash; // test hook: "before" or "after" commit

        Tx begin() {
            return new Tx(this);
        }

        // region prune
        /** Forgets keys older than the window. */
        synchronized void prune(long now) {
            for (String key : List.copyOf(keys.keySet())) { //@scan
                if (now - keys.get(key).created >= WINDOW) { //@age
                    keys.remove(key); //@drop
                }
            }
        }
        // endregion
    }

    /** One transaction: all of its writes commit, or none do. */
    static class Tx implements AutoCloseable {
        final Database db;
        final Map<String, Row> rows = new HashMap<>();
        final Map<String, Integer> payments = new HashMap<>();
        boolean done;

        Tx(Database db) {
            this.db = db;
        }

        // region insert_key
        /** INSERT under the unique index; false if the key exists. */
        boolean insertKey(String key, int hash) throws InterruptedException {
            synchronized (db) {
                while (db.held.contains(key)) { //@wait
                    db.wait(); // another transaction holds it
                }
                if (db.keys.containsKey(key)) {
                    return false; //@exists
                }
                db.held.add(key); //@hold
                rows.put(key, new Row(hash, db.now));
                return true;
            }
        }
        // endregion

        Row readKey(String key) {
            synchronized (db) {
                return db.keys.get(key);
            }
        }

        String insertPayment(int amount) {
            String id;
            synchronized (db) {
                id = "p" + db.nextId++;
            }
            payments.put(id, amount);
            return id;
        }

        void finishKey(String key, Response response) {
            Row row = rows.get(key);
            row.status = "done";
            row.response = response;
        }

        void commit() {
            synchronized (db) {
                if ("before".equals(db.crash)) {
                    db.crash = null;
                    throw new ServerCrash();
                }
                db.keys.putAll(rows);
                db.payments.putAll(payments);
                for (int amount : payments.values()) {
                    db.balance -= amount;
                }
                db.held.removeAll(rows.keySet());
                db.notifyAll();
                done = true;
                if ("after".equals(db.crash)) {
                    db.crash = null;
                    throw new ServerCrash();
                }
            }
        }

        /** Rolls back unless committed: a crash or an early return. */
        @Override
        public void close() {
            if (done) {
                return;
            }
            synchronized (db) {
                db.held.removeAll(rows.keySet());
                db.notifyAll();
            }
            done = true;
        }
    }

    /** POST /payments, with or without idempotency keys. */
    static class Server {
        final Database db;
        boolean useKeys;

        Server(Database db, boolean useKeys) {
            this.db = db;
            this.useKeys = useKeys;
        }

        // region receive
        /** One request: Idempotency-Key header and an amount. */
        Response receive(String key, int amount)
                throws InterruptedException {
            if (useKeys) { //@mode
                return handle(key, amount);
            }
            return handleNoKeys(amount); // the key is ignored
        }
        // endregion

        // region handle
        /** Charges once per key; a repeat gets the first answer. */
        Response handle(String key, int amount)
                throws InterruptedException {
            int requestHash = fingerprint(amount); //@hash
            Response response;
            try (Tx tx = db.begin()) { //@begin
                if (!tx.insertKey(key, requestHash)) { //@insert
                    Row row = tx.readKey(key); //@read
                    if (row.hash != requestHash) { //@compare
                        return new Response(422, "body differs"); //@mismatch
                    }
                    return row.response; //@replay
                }
                String paymentId = tx.insertPayment(amount); //@apply
                response = new Response(201, paymentId);
                tx.finishKey(key, response); //@store
                tx.commit(); //@commit
            }
            return response; //@reply
        }
        // endregion

        // region handle_no_keys
        /** Without keys, every request that arrives is charged. */
        Response handleNoKeys(int amount) {
            String paymentId;
            try (Tx tx = db.begin()) { //@plain_begin
                paymentId = tx.insertPayment(amount); //@plain_apply
                tx.commit(); //@plain_commit
            }
            return new Response(201, paymentId); //@plain_reply
        }
        // endregion
    }

    /** Loses a request or a response when told to. */
    static class Network {
        // per call: null, "request", "response" or "twice"
        final List<String> fates = new ArrayList<>();
        Response second; // the other answer, after "twice"

        Response call(Server server, String key, int amount)
                throws Timeout, InterruptedException {
            String fate = fates.isEmpty() ? null : fates.remove(0);
            if ("request".equals(fate)) {
                throw new Timeout();
            }
            if ("twice".equals(fate)) {
                return twice(server, key, amount);
            }
            Response response;
            try {
                response = server.receive(key, amount);
            } catch (ServerCrash e) {
                throw new Timeout();
            }
            if ("response".equals(fate)) {
                throw new Timeout();
            }
            return response;
        }

        /** Delivers two copies at once; returns the first answer. */
        Response twice(Server server, String key, int amount)
                throws InterruptedException {
            Response[] out = new Response[2];
            Thread[] threads = new Thread[2];
            for (int i = 0; i < 2; i++) {
                int at = i;
                threads[i] = new Thread(() -> {
                    try {
                        out[at] = server.receive(key, amount);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
                threads[i].start();
            }
            for (Thread t : threads) {
                t.join();
            }
            second = out[1];
            return out[0];
        }
    }

    /** Pays through a lossy network and retries on timeout. */
    static class Client {
        final Server server;
        final Network network;
        final int attempts;

        Client(Server server, Network network, int attempts) {
            this.server = server;
            this.network = network;
            this.attempts = attempts;
        }

        // region pay
        /** Pays once: one key, reused on every attempt. */
        Response pay(int amount) throws InterruptedException {
            String key = newKey(); //@new_key
            for (int i = 0; i < attempts; i++) { //@retry
                try {
                    return network.call(server, key, amount); //@send
                } catch (Timeout e) { //@timeout
                    // it may have worked: same key again
                }
            }
            throw new PaymentUnknown(key, amount); //@give_up
        }
        // endregion

        // region pay_new_key
        /** The bug: a fresh key for every attempt. */
        Response payNewKey(int amount) throws InterruptedException {
            for (int i = 0; i < attempts; i++) { //@retry_new
                String key = newKey(); //@fresh_key
                try {
                    return network.call(server, key, amount); //@send_new
                } catch (Timeout e) { //@timeout_new
                    // fall through to the next attempt
                }
            }
            throw new PaymentUnknown(null, amount);
        }
        // endregion

        // region resend
        /** Sends an earlier request again, under its own key. */
        Response resend(String key, int amount)
                throws Timeout, InterruptedException {
            return network.call(server, key, amount); //@resend
        }
        // endregion
    }
}
