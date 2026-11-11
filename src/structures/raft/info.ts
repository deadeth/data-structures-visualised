import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Raft keeps a replicated log identical on a group of servers, usually 3 or 5, so they act as one machine that survives failures. One server is elected leader for a numbered term; it appends each write to its log, copies it to the others, and the entry is committed once a majority holds it. Majorities are the whole trick: any two majorities share a server, so two leaders cannot win the same term and a committed entry is never lost.',
  watch: [
    'Each column is a server: its role on top, its name and current term, the vote it cast in that term, then its log. An entry shows its term and its value. Green means committed on that server. Uncommitted entries are tinted by term, so a stale suffix stands out.',
    'Timeout follows a vote request. Each server compares terms first, then checks it has not voted for someone else in this term, then checks the candidate\'s log is at least as up to date: a later last term wins, and with equal last terms the longer log wins.',
    'A new leader appends a no-op entry in its own term and replicates it. That is how it learns which entries are committed, because it may only commit by counting entries from its own term.',
    'Write follows the value. Each follower checks the entry just before next (prev index and term). A match means the logs agree up to there; then the follower deletes anything that conflicts and appends.',
    'The tour cuts S1, the leader, off on its own. It still accepts write 8, but 1 copy of 5 is not a majority, so nothing commits and the client hears nothing.',
    'The majority side elects S2 in term 2. Crash S2 and S3 wins term 3. When the partition heals, S3\'s heartbeat tells S1 there is a newer term: S1 steps down, and the next tag walks back until the logs match, then entry 3 (term 1, 8) is overwritten.',
    'What this page simplifies: messages arrive one at a time, in server order, instantly and never twice. Real messages go out in parallel and can be delayed, lost or reordered. Timers are not drawn: you choose which server times out. A heartbeat is drawn only when it matters. Logs hold at most 6 entries, and there are no snapshots or membership changes.',
  ],
  complexity: [
    { op: 'Write (commit)', average: '1 round trip', worst: 'Unbounded without a majority', note: 'Leader to a majority and back, plus a disk write on each of them before they reply. The slowest server in the fastest majority sets the latency.' },
    { op: 'Linearizable read', average: '1 round trip', worst: 'Unbounded without a majority', note: 'Read index: the leader confirms with a heartbeat to a majority that it is still leader. A lease avoids the round trip but depends on bounded clock drift.' },
    { op: 'Election', average: 'A timeout + 1 round trip', worst: 'Several timeouts', note: 'Split votes repeat the election. Random timeouts, such as 150 to 300 ms, make repeats rare.' },
    { op: 'Repair a lagging follower', average: 'O(entries missing)', worst: 'O(log length) round trips', note: 'As drawn, next steps back one entry per round trip. Real servers skip back a term at a time, or send a snapshot.' },
  ],
  space:
    'Every server keeps the whole log, so a cluster of n stores n copies. Each server also keeps its term and vote, and the leader keeps two numbers per follower. The log is compacted by snapshotting the state machine and dropping the entries the snapshot covers.',
  usedIn: [
    {
      name: 'etcd (and so Kubernetes)',
      how: 'etcd is a key-value store replicated with Raft. Kubernetes keeps all its cluster state in etcd, so every change to a pod or a deployment is a Raft write.',
    },
    {
      name: 'HashiCorp Consul',
      how: 'Consul servers replicate their catalogue and key-value data with Raft. Its docs recommend 3 or 5 servers, which tolerate 1 or 2 failures.',
    },
    {
      name: 'CockroachDB',
      how: 'Data is split into ranges and each range is its own Raft group, so one cluster runs many thousands of small Raft logs. Reads go to the range\'s leaseholder, which can answer without a round of Raft.',
    },
    {
      name: 'Apache Kafka (KRaft)',
      how: 'KRaft replaces ZooKeeper for Kafka\'s metadata. A small quorum of controllers keeps the metadata in a log replicated by a Raft variant in which followers pull from the leader.',
    },
    {
      name: 'ZooKeeper (ZAB, a cousin)',
      how: 'ZooKeeper uses ZAB, an atomic broadcast protocol of the same shape: an elected leader, an epoch number that plays the part of Raft\'s term, and a commit once a majority acknowledges.',
    },
  ],
  reachFor: [
    'A small amount of critical state that must never disagree: configuration, cluster membership, who holds a lock, which node owns a shard.',
    'Leader election for a service where two leaders at once would corrupt data.',
    'A strongly consistent, linearizable key-value store for metadata, where writes are rare enough to pay a round trip each.',
    'As the replication layer under each shard of a bigger database (one Raft group per range), so each shard keeps working while any minority of its replicas is down.',
  ],
  costs: [
    'Every write waits for a majority, so latency is at least one round trip plus a disk write. Spread replicas across regions and that round trip is tens of milliseconds.',
    'One leader handles every write, so a single group\'s write throughput is one machine\'s. Scale by running many groups over different shards.',
    'A minority cannot do anything. Lose 3 of 5 servers, or sit on the small side of a partition, and the group stops taking writes, as the tour shows. That is the CP choice: consistency over availability.',
    'More servers add failure tolerance but slow writes: 5 tolerates 2 failures, 7 tolerates 3, and every write waits for 4 of 7.',
    'Not for bulk data or high write rates in one group. Not for data that can merge on its own, such as counters or carts: leaderless replication or CRDTs stay available through a partition.',
  ],
  interview: [
    'Terms are a logical clock. Every message carries the sender\'s term; anyone who sees a higher term adopts it and becomes a follower. That one rule is how a stale leader, like S1 after the heal, finds out and steps down.',
    'Election safety: at most one leader per term, because each server votes once per term and any two majorities overlap. Say "majority of the whole cluster", not "of the servers I can reach".',
    'Log matching: if two logs have an entry with the same index and term, they are identical up to that entry. The prev index and term check on every AppendEntries keeps that true by induction, which is why a follower can delete a conflicting suffix safely.',
    'The election restriction: a server only votes for a candidate whose log is at least as up to date as its own. A committed entry is on a majority, so a candidate missing it cannot collect a majority of votes. That gives leader completeness: every leader holds every committed entry.',
    'A leader commits only entries from its own term by counting replicas. An older entry on a majority can still be overwritten (figure 8 of the Raft paper). It becomes committed when a current-term entry above it commits, which is why new leaders append a no-op.',
    'Split votes and timeouts: if two candidates split the votes, nobody wins and both time out again. Random election timeouts, much longer than a round trip, make that rare. Pre-vote stops a server that rejoins after a partition from bumping the term and disrupting a healthy leader.',
    'Cost of a write: one round trip from the leader to a majority, with a disk write on each before it replies. With 5 servers in 3 zones, the commit waits for the second-fastest follower.',
    'Linearizable reads: reading from the leader\'s memory is not enough, because it may have been deposed without knowing. Use a read index (confirm leadership with a heartbeat round, then serve once the state machine has applied up to the commit index) or a lease (skip the round trip, rely on clocks). Reads from followers are stale unless they do the same.',
    'Raft and Paxos: Multi-Paxos solves the same problem with the same majorities and the same fault tolerance. Raft was designed to be easier to understand and build: one strong leader, entries only flow from leader to followers, a leader must already hold every committed entry, and the log has no gaps. Paxos papers leave much of that (leader election, log repair, membership) open, so real Paxos systems differ widely.',
    'ZooKeeper\'s ZAB is a cousin: a leader per epoch (its term), a zxid of epoch and counter (its index), and commit on a majority of acknowledgements. It syncs a new leader\'s followers before it starts broadcasting.',
  ],
};
