import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A topic: a few partitions, read by independent consumer groups. */
public class AppendLog {
    /** Records per segment file. Kafka's default is 1 GB. */
    static final int SEGMENT = 2;

    /** One append-only run of records. records.get(i) has offset start + i. */
    static class Partition {
        int start; // offset of the oldest record still kept
        final List<Integer> records = new ArrayList<>();

        // region end
        /** The offset the next record will get. */
        int end() {
            return start + records.size();
        }
        // endregion
    }

    /** A consumer group keeps two offsets for every partition. */
    static class Group {
        final int[] position; // next to read; in memory only
        final int[] committed; // saved; survives a crash

        Group(int partitions) {
            position = new int[partitions];
            committed = new int[partitions];
        }
    }

    /** Where a record was stored. */
    public record Placed(int partition, int offset) {}

    final List<Partition> partitions = new ArrayList<>();
    final Map<String, Group> groups = new LinkedHashMap<>();

    public AppendLog(int partitionCount, String... groupNames) {
        for (int p = 0; p < partitionCount; p++) {
            partitions.add(new Partition());
        }
        for (String name : groupNames) {
            groups.put(name, new Group(partitionCount));
        }
    }

    // region hash
    /** Kafka hashes the key's bytes with murmur2. */
    static int hashKey(int key) {
        return (31 * key + 7) % 1009;
    }
    // endregion

    // region produce
    public Placed produce(int key) {
        int h = hashKey(key); //@hash
        int p = h % partitions.size(); //@pick
        Partition part = partitions.get(p);
        int offset = part.end(); //@offset
        part.records.add(key); //@append
        return new Placed(p, offset); //@done
    }
    // endregion

    // region consume
    /** Reads one record for this group, or null. Nothing is removed. */
    public Integer consume(String group, int p) {
        Group g = groups.get(group);
        Partition part = partitions.get(p);
        int pos = g.position[p];
        if (pos >= part.end()) { //@check
            return null; //@caught_up
        }
        int key = part.records.get(pos - part.start); //@read
        g.position[p] = pos + 1; //@advance
        return key; //@advance
    }
    // endregion

    // region commit
    /** Saves the group's positions. Returns how many moved. */
    public int commit(String group) {
        Group g = groups.get(group);
        int moved = 0;
        for (int p = 0; p < partitions.size(); p++) { //@each
            if (g.committed[p] < g.position[p]) { //@ahead
                g.committed[p] = g.position[p]; //@save
                moved++; //@save
            }
        }
        return moved; //@done
    }
    // endregion

    // region crash
    /** Restarts the consumer. Returns how many records repeat. */
    public int crash(String group) {
        Group g = groups.get(group);
        int again = 0;
        for (int p = 0; p < partitions.size(); p++) { //@each
            again += g.position[p] - g.committed[p]; //@rewind
            g.position[p] = g.committed[p]; //@rewind
        }
        return again; //@done
    }
    // endregion

    // region trim
    /** Retention: drops the oldest segment, read or not. */
    public int trim(int p) {
        Partition part = partitions.get(p);
        if (part.records.size() < SEGMENT) { //@oldest
            return 0; //@keep
        }
        part.records.subList(0, SEGMENT).clear(); //@drop
        part.start += SEGMENT; //@drop
        int skipped = 0;
        // Kafka: a consumer finds this out on its next fetch.
        for (Group g : groups.values()) {
            if (g.position[p] < part.start) { //@behind
                skipped += part.start - g.position[p]; //@reset
                g.position[p] = part.start; //@reset
            }
            if (g.committed[p] < part.start) { //@stale
                g.committed[p] = part.start; //@reset,stale
            }
        }
        return skipped; //@done
    }
    // endregion
}
