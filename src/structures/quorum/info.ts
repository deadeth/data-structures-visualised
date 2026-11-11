import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Leaderless replication keeps every key on N replicas and has no leader. A write goes to all N and succeeds once W of them acknowledge it. A read asks all N, waits for R replies and keeps the copy with the highest version. When R + W > N, the replicas that answer a read must include at least one that took the last successful write.',
  watch: [
    'The first write of the tour has R2 down. R1 and R3 ack, 2 ≥ W = 2, so it succeeds. R2 is not told it missed anything.',
    'Every copy carries a version. A read compares the versions of the replies it uses, never the values.',
    'R3 came back stale in the seed. The tour reads 17 with R3 answering first: its v2 loses to R1\'s v4, the client gets 21, and read repair writes v4 back to R3. Only R3, and only key 17.',
    'Key 5 is still stale on R3. With W = 1 and R = 1, R + W = 2 is not more than N = 3, and a read that R3 answers first returns 30, an old value, without any error.',
    'The last write fails: with R1 and R2 down, 1 ack < W = 2. R3 keeps the value anyway. A failed write is not rolled back.',
    'Run Anti-entropy between a stale replica and a peer. It walks every key, not just the one being read, and needs no client request.',
    'Rebuild with N = 5 and set W = 3, R = 3. Two replicas can be down and both reads and writes still succeed.',
  ],
  complexity: [
    { op: 'Write', average: 'N messages', worst: 'N messages', note: 'The client waits for the W-th fastest ack, so a slow replica only hurts when it is one of the first W.' },
    { op: 'Read', average: 'N messages, R used', worst: 'N messages', note: 'Latency is the R-th fastest reply. Cassandra sends the full read to one replica and asks the others only for a digest (a hash) of their copy.' },
    { op: 'Read repair', average: 'O(1) writes', worst: 'R − 1 writes', note: 'Only the key read, only on replicas that answered with an older version.' },
    { op: 'Anti-entropy', average: 'O(differences)', worst: 'O(keys)', note: 'With Merkle trees, matching ranges cost one hash comparison. This page compares every key.' },
    { op: 'Replicas that can be down', average: 'Writes: N − W', worst: 'Reads: N − R', note: 'N = 3, W = R = 2 survives one. N = 5, W = R = 3 survives two.' },
  ],
  space:
    'N full copies of every key, plus a version per value. Cassandra stores an 8-byte write timestamp with every cell. Hints for a down replica take space on other nodes until they are replayed or expire.',
  usedIn: [
    {
      name: 'Amazon Dynamo (2007 paper)',
      how: 'The design this page follows. N, R and W are set per application; the paper gives (3, 2, 2) as a common setting. It uses a sloppy quorum and hinted handoff, Merkle trees for anti-entropy, and vector clocks, handing conflicting versions back to the application to merge.',
    },
    {
      name: 'Apache Cassandra',
      how: 'The replication factor is N. The client picks a consistency level per request: ONE, QUORUM (a majority), ALL, LOCAL_QUORUM and others. Conflicts are settled by last write wins, using a timestamp on every cell. It has read repair, hinted handoff (hints kept for 3 hours of downtime by default) and nodetool repair, which compares Merkle trees.',
    },
    {
      name: 'ScyllaDB',
      how: 'A Cassandra-compatible database in C++. Same replication factor and consistency levels, hinted handoff and repair.',
    },
    {
      name: 'Riak KV',
      how: 'Dynamo-style: n_val replicas (3 by default) with r and w per request, sloppy quorums, hinted handoff, read repair and active anti-entropy built on hash trees. Concurrent writes can be kept as siblings for the application to merge.',
    },
    {
      name: 'Amazon DynamoDB, for contrast',
      how: 'Despite the name, it is not leaderless. The replicas of each partition form a group that elects a leader with Multi-Paxos, and only the leader serves writes and strongly consistent reads.',
    },
  ],
  reachFor: [
    'Writes must keep working when a replica, or a whole data centre, is unreachable, and the data can tolerate being briefly out of date.',
    'Tail latency matters. The client waits for the fastest W or R replicas, so one slow node does not stall every request.',
    'Different requests need different trade-offs on the same data. A dashboard reads at ONE; a balance check reads at QUORUM.',
    'Write-heavy data such as events, metrics or messages, where last write wins is an acceptable merge.',
  ],
  costs: [
    'R + W > N is not linearizability. A read running alongside a write can see the new value while a later read sees the old one. A write that failed may still surface later. Linearizable reads need an extra round: the reader writes what it read back to a quorum before answering (the ABD algorithm). Compare-and-set needs consensus (Cassandra\'s lightweight transactions use Paxos).',
    'Last write wins loses data. Two clients writing the same key at the same time both get success, and one value silently disappears. Clock skew between clients can make the older write win.',
    'A sloppy quorum breaks the overlap. When Dynamo or Riak count acks from stand-in nodes outside the key\'s N, a later read of the usual N may not include any of them.',
    'A replica that comes back is stale until something repairs it. Read repair only touches keys that are read, so rarely read keys need anti-entropy to run regularly.',
    'Deletes are writes of a tombstone. Drop the tombstone before every replica has seen it and the deleted value can come back from a stale replica.',
    'With a single leader instead, every replica applies writes in one order and reads from the leader are up to date. The price is a failover when the leader dies, and writes that all go through one node.',
  ],
  interview: [
    'State the rule and its arithmetic: with N = 3, W = 2, R = 2, any two replicas share at least one, because 2 + 2 > 3. The read sees the last successful write and the version picks it out.',
    'Then say what it does not promise: no protection from concurrent writes, no rollback of a failed write, and no linearizability without extra work. Interviewers listen for that.',
    'Tune by workload: W = N, R = 1 makes reads cheap but one replica down stops every write. W = 1, R = N is the reverse. W = R = majority balances them and survives a minority down.',
    'Three ways replicas catch up: read repair, on the read path, for the key read; hinted handoff, where another node keeps a missed write and replays it when the replica returns; and anti-entropy, a background comparison of Merkle trees that catches everything else.',
    'Hinted handoff in Cassandra keeps the overlap: hints do not count towards the consistency level, except at ANY. In Dynamo\'s sloppy quorum they do count, which keeps writes available but means R + W > N no longer guarantees the read sees them.',
    'Name the conflict rule: last write wins by timestamp (Cassandra) or version vectors with siblings that the application merges (Riak, Dynamo). Last write wins is simple and drops data; vectors keep it and push the merge to you.',
    'Across data centres, use LOCAL_QUORUM so a request waits only for a majority in its own region, and let the other regions catch up asynchronously.',
    'Compare with single-leader replication: leaderless avoids failover and keeps writing through partitions, at the cost of weaker ordering. Pick single-leader when you need unique constraints, counters that must not lose updates, or simple read-your-writes.',
  ],
};
