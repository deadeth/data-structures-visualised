import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A service, its database, a relay, a log and one consumer. */
public class Outbox {
    /** The process died at an armed fail point. */
    static class Crash extends RuntimeException {
        Crash(String point) {
            super(point);
        }
    }

    public record Event(int id, int account, int amount) {}

    /** One outbox row. Only the relay changes published. */
    static class Row {
        final Event event;
        boolean published;

        Row(Event event, boolean published) {
            this.event = event;
            this.published = published;
        }
    }

    /** The service's database: a business table and the outbox. */
    static class ServiceDb {
        final Map<Integer, Integer> accounts = new HashMap<>();
        List<Row> outbox = new ArrayList<>();

        /** A transaction works on a copy; commit swaps it in. */
        ServiceDb begin() {
            ServiceDb tx = new ServiceDb();
            tx.accounts.putAll(accounts);
            for (Row r : outbox) {
                tx.outbox.add(new Row(r.event, r.published));
            }
            return tx;
        }
    }

    /** The consumer's own database: its totals and processed ids. */
    static class ConsumerDb {
        final Map<Integer, Integer> totals = new HashMap<>();
        final Set<Integer> processed = new HashSet<>();

        ConsumerDb begin() {
            ConsumerDb tx = new ConsumerDb();
            tx.totals.putAll(totals);
            tx.processed.addAll(processed);
            return tx;
        }
    }

    String approach;
    ServiceDb db = new ServiceDb();
    final List<Event> log = new ArrayList<>(); // offset i holds log.get(i)
    int nextId = 1;
    ConsumerDb consumerDb = new ConsumerDb();
    int position; // the consumer's next offset
    String armed; // fail point that will crash, if any

    public Outbox(Map<Integer, Integer> balances, String approach) {
        this.approach = approach;
        db.accounts.putAll(balances);
        consumerDb.totals.putAll(balances);
    }

    void failPoint(String name) {
        if (name.equals(armed)) {
            throw new Crash(name);
        }
    }

    Event newEvent(int account, int amount) {
        return new Event(nextId++, account, amount);
    }

    // region approach
    /** Later writes use "dual" or "outbox". */
    public void setApproach(String approach) {
        this.approach = approach; //@set
    }
    // endregion

    // region write
    public Event write(int account, int amount) {
        if (approach.equals("outbox")) { //@choose
            return writeOutbox(account, amount); //@choose
        }
        return writeDual(account, amount); //@choose
    }
    // endregion

    // region write_dual
    /** Two systems, two steps, and nothing ties them. */
    Event writeDual(int account, int amount) {
        ServiceDb tx = db.begin(); //@begin
        tx.accounts.merge(account, amount, Integer::sum); //@begin
        db = tx; // commit //@commit
        Event event = newEvent(account, amount); //@event
        failPoint("after_commit"); //@between
        log.add(event); //@publish
        return event; //@dual_done
    }
    // endregion

    // region write_outbox
    /** One transaction holds the change and its event. */
    Event writeOutbox(int account, int amount) {
        ServiceDb tx = db.begin(); //@tx_begin
        tx.accounts.merge(account, amount, Integer::sum); //@tx_begin
        Event event = newEvent(account, amount); //@tx_outbox
        tx.outbox.add(new Row(event, false)); //@tx_outbox
        failPoint("before_commit"); //@before_commit
        db = tx; // commit //@tx_commit
        failPoint("after_commit"); //@after_commit
        return event; //@tx_done
    }
    // endregion

    // region crash_between
    /** The service dies straight after its database commit. */
    public Event crashBetween(int account, int amount) {
        armed = "after_commit"; //@arm
        try {
            return write(account, amount); //@arm
        } catch (Crash c) {
            return null; //@restart
        } finally {
            armed = null; //@restart
        }
    }
    // endregion

    // region crash_before
    /** The service dies inside its transaction. */
    public Event crashBeforeCommit(int account, int amount) {
        armed = "before_commit"; //@arm_before
        try {
            if (approach.equals("outbox")) { //@arm_before
                return writeOutbox(account, amount);
            }
            return publishFirst(account, amount);
        } catch (Crash c) {
            return null; //@restart_before
        } finally {
            armed = null; //@restart_before
        }
    }
    // endregion

    // region publish_first
    /** Dual write the other way round: publish, then commit. */
    Event publishFirst(int account, int amount) {
        Event event = newEvent(account, amount); //@pf_event
        log.add(event); //@pf_publish
        ServiceDb tx = db.begin(); //@pf_begin
        tx.accounts.merge(account, amount, Integer::sum); //@pf_begin
        failPoint("before_commit"); //@pf_fail
        db = tx; // commit //@pf_commit
        return event; //@pf_commit
    }
    // endregion

    // region relay
    /** Publishes unpublished rows in outbox order, then marks them. */
    public int relay() {
        List<Row> rows = new ArrayList<>(); //@query
        for (Row r : db.outbox) { //@query
            if (!r.published) rows.add(r); //@query
        }
        for (Row row : rows) {
            log.add(row.event); //@relay_publish
            failPoint("relay"); //@relay_crash
            row.published = true; // UPDATE outbox //@mark
        }
        return rows.size(); //@relay_done
    }
    // endregion

    // region crash_relay
    /** The relay dies between publish and mark, then restarts. */
    public int crashRelay() {
        armed = "relay"; //@relay_arm
        try {
            relay(); //@relay_arm
        } catch (Crash c) {
            // the process is gone; nothing to clean up //@relay_restart
        } finally {
            armed = null; //@relay_restart
        }
        return relay(); //@relay_restart
    }
    // endregion

    // region consume
    /** Applies the next event once, however often it arrives. */
    public Boolean consume() {
        if (position >= log.size()) { //@caught_up
            return null; //@caught_up
        }
        Event event = log.get(position); //@read
        if (consumerDb.processed.contains(event.id())) { //@seen
            position++; //@skip
            return false; //@skip
        }
        ConsumerDb tx = consumerDb.begin(); //@apply
        tx.totals.merge(event.account(), event.amount(), Integer::sum); //@apply
        tx.processed.add(event.id()); //@record
        consumerDb = tx; // commit both //@commit_c
        position++; //@commit_c
        return true; //@commit_c
    }
    // endregion

    // region prune
    /** Deletes outbox rows the relay has already published. */
    public int prune() {
        List<Row> kept = new ArrayList<>();
        for (Row row : db.outbox) { //@prune_each
            if (!row.published) { //@prune_check
                kept.add(row); //@prune_keep
            }
        }
        int removed = db.outbox.size() - kept.size(); //@prune_delete
        db.outbox = kept; // DELETE ... WHERE published //@prune_delete
        return removed; //@prune_delete
    }
    // endregion
}
