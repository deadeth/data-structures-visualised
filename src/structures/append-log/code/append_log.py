SEGMENT = 2  # records per segment file; Kafka's default is 1 GB


# region hash
def hash_key(key):
    """Kafka hashes the key's bytes with murmur2."""
    return (31 * key + 7) % 1009
# endregion


class Partition:
    """One append-only run of records. records[i] has offset start + i."""

    def __init__(self):
        self.start = 0  # offset of the oldest record still kept
        self.records = []

    # region end
    def end(self):
        """The offset the next record will get."""
        return self.start + len(self.records)
    # endregion


class Group:
    """A consumer group keeps two offsets for every partition."""

    def __init__(self, partitions):
        self.position = [0] * partitions  # next to read; in memory only
        self.committed = [0] * partitions  # saved; survives a crash


class AppendLog:
    """A topic: a few partitions, read by independent consumer groups."""

    def __init__(self, partitions=3, groups=("a", "b")):
        self.partitions = [Partition() for _ in range(partitions)]
        self.groups = {name: Group(partitions) for name in groups}

    # region produce
    def produce(self, key):
        h = hash_key(key)  #@hash
        p = h % len(self.partitions)  #@pick
        part = self.partitions[p]
        offset = part.end()  #@offset
        part.records.append(key)  #@append
        return p, offset  #@done
    # endregion

    # region consume
    def consume(self, group, p):
        """Read one record for this group. Nothing is removed."""
        g = self.groups[group]
        part = self.partitions[p]
        pos = g.position[p]
        if pos >= part.end():  #@check
            return None  #@caught_up
        key = part.records[pos - part.start]  #@read
        g.position[p] = pos + 1  #@advance
        return key  #@advance
    # endregion

    # region commit
    def commit(self, group):
        """Save the group's positions. Returns how many moved."""
        g = self.groups[group]
        moved = 0
        for p in range(len(self.partitions)):  #@each
            if g.committed[p] < g.position[p]:  #@ahead
                g.committed[p] = g.position[p]  #@save
                moved += 1  #@save
        return moved  #@done
    # endregion

    # region crash
    def crash(self, group):
        """Restart the consumer. Returns how many records repeat."""
        g = self.groups[group]
        again = 0
        for p in range(len(self.partitions)):  #@each
            again += g.position[p] - g.committed[p]  #@rewind
            g.position[p] = g.committed[p]  #@rewind
        return again  #@done
    # endregion

    # region trim
    def trim(self, p):
        """Retention: drop the oldest segment, read or not."""
        part = self.partitions[p]
        if len(part.records) < SEGMENT:  #@oldest
            return 0  #@keep
        del part.records[:SEGMENT]  #@drop
        part.start += SEGMENT  #@drop
        skipped = 0
        # Kafka: a consumer finds this out on its next fetch.
        for g in self.groups.values():
            if g.position[p] < part.start:  #@behind
                skipped += part.start - g.position[p]  #@reset
                g.position[p] = part.start  #@reset
            if g.committed[p] < part.start:  #@stale
                g.committed[p] = part.start  #@reset,stale
        return skipped  #@done
    # endregion
