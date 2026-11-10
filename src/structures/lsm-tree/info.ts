import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A log-structured merge tree never updates data in place. Writes go into a small sorted buffer in memory, the memtable. When it fills, it is written to disk in one pass as a sorted, read-only file, an SSTable. Compaction later merges those files into larger sorted runs. Writes become cheap sequential appends, and the price is paid by reads and by the background merging.',
  watch: [
    'A put touches only the memtable. Nothing on disk is read or changed, however large the store is.',
    'A get works from newest to oldest: the memtable, then every level 0 table (they overlap, so each one may hold the key), then at most one table in each deeper level.',
    'Deeper levels are one sorted run cut into tables that never overlap, so a key-range check picks the single table worth reading.',
    'Compaction is a merge sort across files. When the same key appears twice, the newer copy wins and the older one is dropped.',
    'A delete writes a tombstone. The old value is still on disk underneath until compaction carries the tombstone down to the last level.',
    'Watch write amplification climb in the status line: each entry is written to disk again every time compaction moves it down a level.',
  ],
  complexity: [
    { op: 'Put', average: 'O(1) amortised disk work', worst: 'a flush plus compactions', note: 'An in-memory insert and an append to the write-ahead log. The disk work is deferred and batched.' },
    { op: 'Get', average: 'O(L) table reads', worst: 'O(L + level 0 tables)', note: 'L levels. A Bloom filter per table lets most reads skip tables that cannot hold the key.' },
    { op: 'Delete', average: 'O(1) amortised', worst: 'same as put', note: 'Writes a tombstone. Space comes back only after compaction.' },
    { op: 'Range scan', average: 'O(L + k)', worst: 'O(L + k)', note: 'Merges one iterator per level and per level 0 table, for k results.' },
    { op: 'Compaction, per entry', average: 'O(log n) rewrites', worst: 'O(log n) rewrites', note: 'Once per level with size-tiered merging, several times per level with levelled.' },
  ],
  space:
    'O(n) plus whatever is waiting to be compacted away: overwritten values, deleted values and their tombstones. Levelled compaction keeps that overhead small; size-tiered compaction can briefly need about twice the data size.',
  usedIn: [
    {
      name: 'Google Bigtable and LevelDB',
      how: 'The 2006 Bigtable paper described the memtable and SSTable design that most later stores copied. LevelDB is an open-source library built on the same ideas, with levelled compaction.',
    },
    {
      name: 'RocksDB',
      how: 'A fork of LevelDB tuned for flash and many cores. It is the storage engine inside TiKV, MyRocks (MySQL), Kafka Streams state stores and many others.',
    },
    {
      name: 'Apache Cassandra and ScyllaDB',
      how: 'Each table is a memtable plus SSTables on disk, with a choice of compaction strategy per table: size-tiered for write-heavy data, levelled for read-heavy data, time-windowed for time series.',
    },
    {
      name: 'Apache HBase',
      how: 'An open-source Bigtable. Each region server keeps a MemStore and flushes it to HFiles, which minor and major compactions merge.',
    },
    {
      name: 'CockroachDB',
      how: 'Stores everything in Pebble, a Go key-value engine in the RocksDB tradition, underneath its SQL layer.',
    },
    {
      name: 'The original paper',
      how: "O'Neil, Cheng, Gawlick and O'Neil described the LSM tree in 1996, to make index maintenance cheap for tables with heavy insert traffic.",
    },
  ],
  reachFor: [
    'Write-heavy workloads: event logs, metrics, time series, message metadata, anything that ingests faster than it reads.',
    'Data much larger than memory on flash storage, where sequential writes and good compression matter.',
    'Keys that arrive in no particular order. A B+ tree would dirty a random page per write; an LSM tree batches them.',
    'When you can give background compaction spare disk throughput and CPU.',
  ],
  costs: [
    'Reads are slower than on a B+ tree. A point read may check several files, and a read of a missing key is the worst case, which is why every table carries a Bloom filter.',
    'Write amplification. The same entry is rewritten each time it moves down a level, which wears flash and competes with foreground traffic for disk.',
    'Compaction debt. If writes outrun compaction, level 0 fills up, reads slow down and the store has to stall writes until it catches up.',
    'Deletes are not free. A tombstone must be read past until it is compacted away, and a range full of tombstones can make scans crawl.',
    'Three costs trade against each other: read, write and space amplification. Levelled compaction favours reads and space; size-tiered favours writes. You tune for two.',
    'This page does not draw the write-ahead log, the Bloom filters or the per-table block index, all of which a real engine needs.',
  ],
  interview: [
    'Lead with the trade: an LSM tree turns random writes into sequential ones by never updating in place, and pays for it with extra work on reads and in the background.',
    'Walk the write path out loud: append to the write-ahead log for durability, insert into the memtable, flush to an immutable SSTable when full, compact later.',
    'Walk the read path too: memtable, then newest files first, stopping at the first hit. Bloom filters skip files that cannot contain the key, and that is what makes point reads tolerable.',
    'Compare it with a B+ tree. B+ tree: one place per key, fast and predictable reads, a random page write per update. LSM: many places per key, cheap writes, reads and space that depend on how far compaction has got.',
    'Name the compaction strategies. Size-tiered merges files of similar size and writes less. Levelled keeps each level as one sorted run, so a read touches one file per level, at the cost of rewriting data more often.',
    'Mention tombstones when deletes come up: a delete is a write, the space returns later, and heavy delete workloads need care.',
    'Bring up the operational risk: write stalls when compaction falls behind. Capacity planning has to include compaction throughput, not just ingest rate.',
  ],
};
