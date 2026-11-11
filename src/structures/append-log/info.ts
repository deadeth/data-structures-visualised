import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'An append-only log is an array that only grows at the end. Each record gets the next number, its offset, and is never changed or moved. Readers do not take records out: each one just remembers the offset it has reached. That one idea gives many independent readers, replay, and at-least-once delivery. A Kafka topic is several such logs, called partitions, with a hash of the record key choosing between them.',
  watch: [
    'Produce follows the key. hash(key) mod the number of partitions picks the partition, and the record goes at the end: its offset is the count of records that partition has ever taken.',
    'Produce the same key twice. Both records land in one partition, in order. Records with different keys may land in different partitions, and nothing orders one partition against another.',
    'Consume copies a record and moves only that group\'s pos tag. The record stays put, and group B can read it later.',
    'pos is the next offset the consumer will read and lives in its memory. commit is the offset it has saved. The gap between the two tags is work that a crash would repeat.',
    'Crash a group that has read past its commit. pos falls back to commit, and the next Consume delivers a record for the second time. That is at-least-once delivery.',
    'Trim deletes the oldest segment whether or not it has been read. Run it on partition 0 at the start: group B has read nothing there, and it loses both records.',
    'The hash is (31 × key + 7) mod 1009, small enough to check by hand. Kafka runs murmur2 over the bytes of the key.',
    'This page keeps 2 records to a segment and at most 6 records in a partition so they stay readable. A Kafka segment is 1 GB by default.',
  ],
  complexity: [
    { op: 'Produce (append)', average: 'O(1)', worst: 'O(1)', note: 'One hash and one write at the end of one partition. The length of the log makes no difference.' },
    { op: 'Consume the next record', average: 'O(1)', worst: 'O(1)', note: 'Read at the group\'s position and add one to it. Nothing is deleted or shifted.' },
    { op: 'Read from any offset', average: 'O(1) here', worst: 'O(log n) on disk', note: 'Here it is an array index. Kafka finds the segment by its base offset, then uses a sparse index inside it.' },
    { op: 'Commit', average: 'O(1) per partition', worst: 'O(1) per partition', note: 'One saved number for each partition the group reads.' },
    { op: 'Trim the oldest segment', average: 'O(1)', worst: 'O(1)', note: 'A segment is a file, so retention deletes a file. No record is copied.' },
    { op: 'Find a record by key', average: 'O(n)', worst: 'O(n)', note: 'There is no index by key. If you need lookups, consume the log into a table.' },
    { op: 'Delete or change one record', average: 'Not supported', worst: 'Not supported', note: 'Append a newer record for the same key. Compaction can later drop the old one.' },
  ],
  space:
    'O(n) in the records retained, plus one committed offset per consumer group per partition. Retention bounds it by age or size: Kafka keeps seven days by default, in segments of 1 GB.',
  usedIn: [
    {
      name: 'Apache Kafka',
      how: 'A topic is a set of partitions and each partition is an append-only log of segment files. Records with a key go to murmur2(key) mod the partition count. Each consumer group commits its offsets to an internal topic, __consumer_offsets.',
    },
    {
      name: 'The web crawler design on this site',
      how: 'Its discovered-urls topic is keyed by host. Every link for one host lands in one partition and so reaches one node, and a new owner can replay the partition to rebuild its frontier after a failure.',
    },
    {
      name: 'PostgreSQL write-ahead log',
      how: 'Every change is appended to the WAL, in 16 MB segment files by default, before the data pages are written. Crash recovery replays it, and streaming replication ships the same log to standbys.',
    },
    {
      name: 'MySQL binary log',
      how: 'The primary appends each change to the binlog, and replicas fetch and replay it. Change data capture tools such as Debezium read the same log to publish row changes.',
    },
    {
      name: 'Raft (etcd, Consul)',
      how: 'Consensus is agreement on a replicated log. The leader appends an entry, followers copy it, and an entry counts as committed once a majority holds it.',
    },
    {
      name: 'LSM stores (RocksDB, Cassandra)',
      how: 'A write is appended to a commit log before it goes into the memtable, so a crash loses nothing that was acknowledged. The log is discarded once the memtable is flushed to an SSTable.',
    },
    {
      name: 'Amazon Kinesis Data Streams',
      how: 'The same model as a service: shards for partitions, a partition key that is hashed to pick the shard, and sequence numbers for offsets. Records are kept for 24 hours by default and up to 365 days.',
    },
    {
      name: 'Redis Streams',
      how: 'An append-only stream with consumer groups inside Redis. XADD appends an entry with an ID that only goes up, and XREADGROUP hands entries to the members of a group.',
    },
  ],
  reachFor: [
    'Several independent consumers need the same events: a search indexer, a cache updater and an analytics job all reading one stream of orders.',
    'You need replay: rebuild a derived store, backfill a new service, or run a fixed consumer over last week\'s records again.',
    'Order matters per entity, such as per account or per host, but not across all of them. Key by the entity.',
    'A fast producer and a slow consumer need a durable buffer between them that survives restarts of either side.',
    'Durability inside a store: write to a log first, then update the real structure at leisure. That is a write-ahead log.',
  ],
  costs: [
    'Order holds only inside a partition. For a total order you need a single partition, and with it a single consumer per group.',
    'A group reads a partition with one consumer at a time, so partitions cap parallelism. One slow record holds up everything behind it in that partition.',
    'Delivery is at least once unless you do more work. Consumers must cope with seeing a record twice.',
    'Skewed keys make hot partitions. If one customer sends half the traffic, one partition takes half the load.',
    'Changing the number of partitions changes hash mod n for most keys, so later records for a key can land in a different partition from its earlier ones. Choose the count with room to grow.',
    'Retention deletes by age or size, not by whether records were read. A consumer that is down for longer than the retention period loses data.',
    'No lookup by key, no deleting one record, no per-message delay or priority. For a job queue where each task is acknowledged on its own and retried on its own, a queue such as SQS or RabbitMQ is simpler.',
  ],
  interview: [
    'Log or queue: in a queue such as SQS or a classic RabbitMQ queue, a message is removed once a consumer acknowledges it, and consumers compete for messages. In a log, reading removes nothing: each group keeps its own offset, so ten groups can each read every record, and any of them can rewind and replay.',
    'Say the ordering guarantee exactly: "Order is per partition, and the key picks the partition, so I get order per key. I do not get order across keys, and I do not need it."',
    'Choose the key out loud. It is the thing whose events must stay in order: the account, the order, the host. Then check it for skew. A null key spreads records evenly and gives up per-key order.',
    'Consumer groups: each partition is read by exactly one consumer in a group, so more consumers than partitions adds nothing. When a consumer joins or dies, the group rebalances and the new owner of a partition resumes from the committed offset, which is the Crash button on this page.',
    'Delivery: commit after processing gives at-least-once, commit before gives at-most-once. "I would commit after processing and make the consumer idempotent: an upsert by record id, or a table of ids already handled." Exactly-once in Kafka means transactions that write the output and the offsets together, and it stops at the edge of Kafka.',
    'Retention and compaction: delete retention drops whole old segments by time or size. A compacted topic keeps at least the latest record for every key, which turns the log into a changelog you can rebuild a table from. A record with a null value is a tombstone that deletes the key.',
    'Watch consumer lag, the gap between the end of the log and a group\'s committed offset. It is the first sign that a consumer is too slow, and if it grows past retention you lose records.',
    'Why it is fast: appends and reads are sequential, records are sent in batches, and the broker hands file pages straight to the socket. It also explains the limits: no random updates and no index by key.',
    'The same idea runs through storage: a database write-ahead log, a replication log, the commit log of an LSM tree and a Raft log are all append-only logs. "State is what you get by replaying the log" is worth saying once.',
  ],
};
