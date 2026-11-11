import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** A cache in front of a database, kept in step by one strategy. */
public class CacheStrategies {
    public enum Strategy { CACHE_ASIDE, WRITE_THROUGH, WRITE_BEHIND, WRITE_AROUND }

    /** A database row: the value and its version. */
    public record Row(int value, int version) {}

    /** A cached value, the version it came from, and when it expires. */
    public static final class Entry {
        final int value;
        final int version;
        Long expires; // null while a queued write pins it

        Entry(int value, int version, Long expires) {
            this.value = value;
            this.version = version;
            this.expires = expires;
        }
    }

    final Map<Integer, Row> db; // key -> row
    final Map<Integer, Entry> cache = new HashMap<>();
    final Map<Integer, Row> queue = new LinkedHashMap<>(); // write-behind
    final Map<Integer, Object> locks = new ConcurrentHashMap<>();
    Strategy strategy;
    final long ttl;
    long now; // the clock, in ticks

    public CacheStrategies(Map<Integer, Row> db, Strategy strategy, long ttl) {
        this.db = db;
        this.strategy = strategy;
        this.ttl = ttl;
    }

    // region read
    /** Serves from the cache, or loads from the database. */
    public Integer read(int key) {
        Entry entry = cache.get(key); //@lookup
        if (entry != null) { //@lookup
            return entry.value; //@hit
        }
        return load(key); //@miss
    }
    // endregion

    // region load
    /** Reads the database and fills the cache. */
    Integer load(int key) {
        Row row = db.get(key); //@db_read
        if (row == null) {
            return null; //@absent
        }
        long expires = now + ttl; //@fill
        cache.put(key, new Entry(row.value(), row.version(), expires)); //@fill
        return row.value(); //@fill
    }
    // endregion

    // region read_locked
    /** A read where only one caller per key loads on a miss. */
    public Integer readLocked(int key) {
        Entry entry = cache.get(key); //@first
        if (entry != null) { //@first
            return entry.value;
        }
        Object lock = locks.computeIfAbsent(key, k -> new Object());
        synchronized (lock) { //@lock
            entry = cache.get(key); //@recheck
            if (entry != null) { //@recheck
                return entry.value; //@waited
            }
            return load(key); //@load
        }
    }
    // endregion

    // region write
    /** Writes one key under the current strategy. */
    public boolean write(int key, int value) { //@write
        switch (strategy) {
            case CACHE_ASIDE -> {
                dbWrite(key, value); //@aside_db
                cache.remove(key); //@aside_delete
            }
            case WRITE_THROUGH -> {
                int version = dbWrite(key, value); //@through_db
                long expires = now + ttl; //@through_cache
                cache.put(key, new Entry(value, version, expires)); //@through_cache
            }
            case WRITE_BEHIND -> {
                int version = nextVersion(key); //@behind_cache
                cache.put(key, new Entry(value, version, null)); //@behind_cache
                queue.put(key, new Row(value, version)); //@behind_queue
            }
            case WRITE_AROUND -> {
                dbWrite(key, value); //@around_db
                // a cached copy is left to expire //@around_keep
            }
        }
        return true; //@ack
    }
    // endregion

    // region db_write
    /** One write to the database. Returns the new version. */
    int dbWrite(int key, int value) {
        int version = db.get(key).version() + 1; //@db_write
        db.put(key, new Row(value, version)); //@db_write
        return version;
    }
    // endregion

    // region next_version
    /** The version a write-behind write will get. */
    int nextVersion(int key) {
        if (queue.containsKey(key)) { //@next_version
            return queue.get(key).version() + 1; //@next_version
        }
        return db.get(key).version() + 1; //@next_version
    }
    // endregion

    // region flush
    /** Sends every queued write to the database. */
    public void flush() {
        for (var e : queue.entrySet()) { //@drain
            db.put(e.getKey(), e.getValue()); //@flush_write
            Entry entry = cache.get(e.getKey()); //@unpin
            entry.expires = now + ttl; //@unpin
        }
        queue.clear(); //@flushed
    }
    // endregion

    // region crash
    /** The cache loses its memory, queue and all. */
    public int crashCache() {
        int lost = queue.size(); //@lost
        cache.clear(); //@wipe
        queue.clear(); //@lost
        return lost; //@cold
    }
    // endregion

    // region tick
    /** Moves the clock and drops expired entries. */
    public void tick(long ticks) {
        now += ticks; //@tick
        var it = cache.values().iterator(); //@expire_scan
        while (it.hasNext()) { //@expire_scan
            Long expires = it.next().expires; //@expire_scan
            if (expires != null && expires <= now) { //@expire_test
                it.remove(); //@expire
            }
        }
    }
    // endregion

    // region strategy
    /** Changes strategy. Queued writes go out first. */
    public void setStrategy(Strategy next) {
        if (!queue.isEmpty()) { //@switch_flush
            flush(); //@switch_flush
        }
        strategy = next; //@switch
    }
    // endregion
}
