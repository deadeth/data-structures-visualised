import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'One replica, the leader, takes every write and appends it to a log. The followers copy that log and apply it in the same order, so they end up with the same data. Reads can go to any replica. The one choice that shapes everything else is when the leader tells the client "saved": before any follower has the write (fast, but a crash can lose it), or after one or all of them have it (safe, but slower).',
  watch: [
    'The columns are log positions (LSN, log sequence number). A row that stops short of the leader\'s is a follower that is behind. Its "applied" number is how far it has got.',
    'Semi-sync write: the leader appends, waits for B, the synchronous follower, then answers. C, the asynchronous one, is held back and falls behind. Nothing waits for it.',
    'Read x from C: it answers with the old value. The client wrote x a moment ago and does not see it. Read your writes compares C\'s position with the client\'s last write and sends the read to the leader instead.',
    'Two followers at different positions also break monotonic reads: read the new value from B, then the old one from C, and time seems to go backwards.',
    'Lag B, then write. The leader waits for B, times out and answers anyway. That write is on the leader alone, as if replication were asynchronous.',
    'Fail leader: B and C compare positions, and the one further on is promoted. The write only the old leader had is gone, though the client was told it was saved.',
    'Rejoin A: it sees the newer epoch and steps down, then walks back through its log until it agrees with the new leader, and deletes the rest. The red entry is the lost write.',
    'Rebuild with "Every follower (sync)": Lag is refused, because a slow follower would slow every write rather than fall behind. Nothing acknowledged is ever lost at failover.',
    'Simplified: three replicas, one client, logs that never get compacted, and a held link standing in for slowness. Failure detection is a button, not a timeout. Each entry is applied the moment it arrives.',
  ],
  complexity: [
    { op: 'Write, asynchronous', average: '1 local write', worst: '1 local write', note: 'The leader answers before any follower has the entry. Followers get it after.' },
    { op: 'Write, semi-synchronous', average: '1 round trip', worst: 'Timeout, then async', note: 'Waits for one follower. If it is slow, the leader either waits or (MySQL) gives up after a timeout.' },
    { op: 'Write, synchronous', average: 'Slowest follower', worst: 'Blocks', note: 'Waits for every follower named as synchronous, so one slow or dead follower stalls writes.' },
    { op: 'Read from any replica', average: '1 replica', worst: '1 replica', note: 'No coordination, so it can be stale by the replication lag.' },
    { op: 'Read your writes', average: '1 replica', worst: 'Wait or a hop to the leader', note: 'Compare the replica\'s position with the client\'s last write.' },
    { op: 'Catch up', average: 'O(entries missed)', worst: 'Snapshot, then the log', note: 'If the leader no longer keeps the log that far back, the follower is rebuilt from a snapshot.' },
    { op: 'Failover', average: 'Timeout + O(followers)', worst: 'Lost writes', note: 'Detecting the failure dominates. Choosing the leader is a comparison of positions.' },
  ],
  space:
    'A full copy of the data on every replica, so three replicas store everything three times. On top of that, the leader keeps enough recent log for its followers to catch up from. PostgreSQL bounds that with wal_keep_size or a replication slot; a slot keeps log for a dead follower forever unless capped, and can fill the disk.',
  usedIn: [
    {
      name: 'PostgreSQL',
      how: 'Streaming replication ships the write-ahead log (WAL) from the primary to standbys, which replay it and can serve read-only queries. synchronous_standby_names and synchronous_commit choose whom a commit waits for. pg_basebackup takes the snapshot a new standby starts from, and pg_rewind lets an old primary follow the new one after a failover.',
    },
    {
      name: 'MySQL',
      how: 'Replicas read the source\'s binary log. The binlog can hold statements, row changes or a mix; row-based is the default. Semi-synchronous replication waits for one replica to acknowledge, and falls back to asynchronous after rpl_semi_sync_source_timeout, 10 seconds by default.',
    },
    {
      name: 'MongoDB',
      how: 'A replica set has one primary and secondaries that copy its oplog. If the primary fails, the members elect a new one. A write with write concern "majority" is acknowledged once most members have it; a former primary rolls back writes that no majority had.',
    },
    {
      name: 'Apache Kafka',
      how: 'Each partition has a leader and follower replicas that fetch from it. With acks=all a write is acknowledged once every in-sync replica has it, and min.insync.replicas sets how few that may be. Unclean leader election, off by default, would promote an out-of-sync replica and lose writes.',
    },
    {
      name: 'Debezium (change data capture)',
      how: 'Reads the same replication streams, the MySQL binlog, PostgreSQL logical decoding and MongoDB change streams, and turns every committed change into an event for Kafka. The log built for replicas doubles as a feed for search indexes, caches and warehouses.',
    },
  ],
  reachFor: [
    'Read-heavy workloads. Add followers to spread reads; the leader keeps only the writes.',
    'Surviving the loss of a machine. A follower holds a warm copy and can be promoted in seconds rather than restored from a backup in hours.',
    'Reads close to users. A follower in another region answers local reads without a round trip to the leader.',
    'Backups and analytics without touching the leader: run them against a follower.',
    'Any system where one ordering of writes matters, such as a bank balance: one leader means one order, with no conflicts to resolve.',
  ],
  costs: [
    'Writes do not scale. Every write goes through one leader. Once it is the bottleneck, partition the data, so each partition has its own leader.',
    'Asynchronous followers lag. Usually by a fraction of a second, but under load or a long-running query it can be minutes, and every read from that follower is that old.',
    'Asynchronous replication can lose acknowledged writes at failover. Synchronous replication cannot, but then one slow follower slows every write. Semi-sync sits between, and may quietly become async under a timeout.',
    'Failover is risky. Too short a timeout promotes a new leader while the old one is merely slow; too long and writes are down for that long. Two nodes that both think they lead (split brain) can corrupt data.',
    'A promoted follower that lacked some writes can hand out IDs that were already used. At GitHub in 2012, an out-of-date MySQL follower was promoted, reused primary keys that Redis also held, and showed some private data to the wrong users.',
    'If any node may take writes, pick multi-leader or leaderless replication instead, and accept conflict resolution as the price.',
  ],
  interview: [
    'State the trade-off first: "The leader takes all writes and ships its log to followers. The question is when it says saved. Async: before any follower has it, fast but a failover can lose it. Sync: after every follower, safe but one slow follower stalls writes. Semi-sync: after one, which is what most people run."',
    'Three ways to ship the log. Statements (INSERT ... NOW()) break on anything non-deterministic. The write-ahead log is exact but tied to the storage engine\'s byte layout, so both sides must run the same version. A logical, row-based log ("row 7 now has x = 5") is portable between versions and readable by other systems, which is why change data capture is built on it.',
    'Name the lag anomalies and their fixes. Read-your-writes: send the client\'s reads to the leader for a while after it writes, or have it carry its last LSN and only read from a replica that has reached it. Monotonic reads: pin each user to one replica, for example by hashing the user ID. Consistent prefix: write causally related data to the same partition, so it is seen in order.',
    'Failover in four steps: detect (no heartbeat for, say, 10 seconds), choose (the follower with the highest position), reconfigure (clients and followers move to it), fence (the old leader must not take writes, so bump an epoch and have everyone reject the old one).',
    'Say what can go wrong at failover: lost writes under async, split brain if the old leader comes back still leading, and a timeout that is either too eager (needless failovers under load) or too slow (long outage).',
    'A new follower starts from a snapshot that records its exact log position, then replays the log from there. That way it never needs the leader to stop taking writes.',
    'Back-of-envelope: at 5,000 writes a second with 200 ms of lag, an async failover can lose about 1,000 acknowledged writes. Halving the lag halves the loss; only waiting for a follower makes it zero.',
    'For stronger guarantees than this, the next step is consensus: Raft or Paxos acknowledge a write once a majority has it and elect leaders with terms, which is single-leader replication with failover made safe.',
  ],
};
