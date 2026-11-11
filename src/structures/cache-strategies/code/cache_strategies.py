import threading


class Entry:
    """A cached value, the version it came from, and when it expires."""

    def __init__(self, value, version, expires):
        self.value = value
        self.version = version
        self.expires = expires  # None while a queued write pins it


class CacheStrategies:
    """A cache in front of a database, kept in step by one strategy."""

    def __init__(self, db, strategy="cache-aside", ttl=6):
        self.db = db  # key -> (value, version)
        self.cache = {}  # key -> Entry
        self.queue = {}  # write-behind: key -> (value, version)
        self.locks = {}  # key -> lock, for read_locked
        self.strategy = strategy
        self.ttl = ttl
        self.now = 0  # the clock, in ticks

    # region read
    def read(self, key):
        """Serve from the cache, or load from the database."""
        entry = self.cache.get(key)  #@lookup
        if entry is not None:  #@lookup
            return entry.value  #@hit
        return self.load(key)  #@miss
    # endregion

    # region load
    def load(self, key):
        """Read the database and fill the cache."""
        row = self.db.get(key)  #@db_read
        if row is None:
            return None  #@absent
        value, version = row
        expires = self.now + self.ttl  #@fill
        self.cache[key] = Entry(value, version, expires)  #@fill
        return value  #@fill
    # endregion

    # region read_locked
    def read_locked(self, key):
        """A read where only one caller per key loads on a miss."""
        entry = self.cache.get(key)  #@first
        if entry is not None:  #@first
            return entry.value
        lock = self.locks.setdefault(key, threading.Lock())
        with lock:  #@lock
            entry = self.cache.get(key)  #@recheck
            if entry is not None:  #@recheck
                return entry.value  #@waited
            return self.load(key)  #@load
    # endregion

    # region write
    def write(self, key, value):  #@write
        """Write one key under the current strategy."""
        if self.strategy == "cache-aside":
            self.db_write(key, value)  #@aside_db
            self.cache.pop(key, None)  #@aside_delete
        elif self.strategy == "write-through":
            version = self.db_write(key, value)  #@through_db
            expires = self.now + self.ttl  #@through_cache
            self.cache[key] = Entry(value, version, expires)  #@through_cache
        elif self.strategy == "write-behind":
            version = self.next_version(key)  #@behind_cache
            self.cache[key] = Entry(value, version, None)  #@behind_cache
            self.queue[key] = (value, version)  #@behind_queue
        else:  # write-around
            self.db_write(key, value)  #@around_db
            # a cached copy is left to expire  #@around_keep
        return True  #@ack
    # endregion

    # region db_write
    def db_write(self, key, value):
        """One write to the database. Returns the new version."""
        version = self.db[key][1] + 1  #@db_write
        self.db[key] = (value, version)  #@db_write
        return version
    # endregion

    # region next_version
    def next_version(self, key):
        """The version a write-behind write will get."""
        if key in self.queue:  #@next_version
            return self.queue[key][1] + 1  #@next_version
        return self.db[key][1] + 1  #@next_version
    # endregion

    # region flush
    def flush(self):
        """Send every queued write to the database."""
        for key, (value, version) in self.queue.items():  #@drain
            self.db[key] = (value, version)  #@flush_write
            entry = self.cache[key]  #@unpin
            entry.expires = self.now + self.ttl  #@unpin
        self.queue.clear()  #@flushed
    # endregion

    # region crash
    def crash_cache(self):
        """The cache loses its memory, queue and all."""
        lost = len(self.queue)  #@lost
        self.cache.clear()  #@wipe
        self.queue.clear()  #@lost
        return lost  #@cold
    # endregion

    # region tick
    def tick(self, ticks=1):
        """Move the clock and drop expired entries."""
        self.now += ticks  #@tick
        for key in list(self.cache):  #@expire_scan
            expires = self.cache[key].expires  #@expire_scan
            if expires is not None and expires <= self.now:  #@expire_test
                del self.cache[key]  #@expire
    # endregion

    # region strategy
    def set_strategy(self, strategy):
        """Change strategy. Queued writes go out first."""
        if self.queue:  #@switch_flush
            self.flush()  #@switch_flush
        self.strategy = strategy  #@switch
    # endregion
