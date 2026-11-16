import type { Concept } from '../types';

const page: Concept = {
  id: 'consensus-and-coordination',
  title: 'Consensus and coordination',
  group: 'Data',
  summary:
    "Consensus is how several machines agree on one value and never go back on it. This page covers the few jobs that need it, Raft in outline, why leases and distributed locks are harder than they look, fencing tokens, and what a coordination service costs.",
  minutes: 13,
  sections: [
    {
      id: 'when',
      title: 'When you need it, and when you do not',
      blocks: [
        {
          p: "Consensus means a group of nodes decides one thing, every node that decides gets the same answer, and the decision survives crashes and lost messages. It's the only way to get a single answer when no single machine can be trusted to stay up.",
        },
        {
          p: "You need it when exactly one of something must exist and two would cause damage. That list is short.",
        },
        {
          table: {
            head: ['Job', 'Why two answers hurt', 'What the decision looks like'],
            rows: [
              ['Leader election', 'Two leaders both accept writes: split brain', 'Node B leads for term 5'],
              ['Locks and leases', 'Two workers run the same job or write the same file', 'Worker A holds the lease until it expires'],
              ['Configuration', 'Half the fleet routes with the old shard map', 'Version 18 of the map is current'],
              ['Membership', 'Nodes disagree about who is in the cluster, so majorities overlap wrongly', 'The members are A, B and D'],
              ['A unique sequence', 'Two events get the same number, or order differs by observer', 'This entry is number 9,041'],
              ['Atomic commit', 'One shard commits a transfer and the other aborts', 'Transaction 77 commits'],
            ],
          },
          caption: 'Every row is the same question: which one? Consensus answers it once.',
        },
        {
          p: "Most data doesn't need it. If writes commute (likes, view counts, adding to a set), let replicas merge: see [CRDTs](#/s/crdt). If a retry is the worry, an [idempotency key](#/s/idempotency-keys) with a unique index is enough. If everything involved is in one Postgres database, a transaction, a unique constraint or `SELECT ... FOR UPDATE` already gives you one answer. Unique ids don't need a shared counter either: a timestamp, a machine id and a local counter make ids unique without a round trip, and only the machine id needs assigning once at start-up.",
        },
        {
          diagram: {
            w: 520,
            h: 370,
            nodes: [
              { id: 'etcd', label: 'etcd cluster', sub: '3 nodes, Raft', x: 180, y: 20, w: 160, kind: 'store', tone: 'compare' },
              { id: 'a', label: 'Worker A', sub: 'holds the lease', x: 40, y: 160, tone: 'ok' },
              { id: 'b', label: 'Worker B', sub: 'standby', x: 340, y: 160, tone: 'muted' },
              { id: 'store', label: 'Shard data', sub: '5,000 writes a second', x: 40, y: 300, kind: 'store' },
            ],
            edges: [
              { from: 'a', to: 'etcd', label: 'renew every 3 s' },
              { from: 'b', to: 'etcd', label: 'watches', dashed: true },
              { from: 'a', to: 'store', label: 'every write', tone: 'ok' },
            ],
          },
          caption:
            "Consensus on the control path, not the data path. etcd decides who owns the shard and hears from the owner once every few seconds. The 5,000 writes a second go straight from Worker A to the data and never touch etcd. Keep it that way.",
        },
        {
          callout:
            "Before reaching for a coordination service, ask what goes wrong if two nodes both think they won. If the answer is 'some work is done twice and the second is a no-op', you don't need consensus: you need idempotent work. If the answer is 'data is corrupted', you do.",
          kind: 'rule',
          title: 'The two-winners test',
        },
      ],
    },
    {
      id: 'raft',
      title: 'Raft in outline',
      blocks: [
        {
          p: "Raft is the consensus algorithm most systems now use. It keeps a log identical on 3 or 5 servers. Three ideas carry it.",
        },
        {
          list: [
            "One leader per **term**. Terms are numbered. A server votes once per term, and a candidate needs votes from a majority of the whole cluster, so two leaders can't win the same term.",
            "A write is **committed** once a majority has it on disk. Any later leader must have won votes from a majority, and any two majorities share a server, so a new leader always holds every committed entry.",
            "A higher term always wins. A deposed leader learns of the new term from the first message it sees and steps down. That is fencing, built in.",
          ],
          ordered: true,
        },
        {
          diagram: {
            w: 600,
            h: 260,
            nodes: [
              { id: 's1', label: 'S1 leader', sub: 'term 3', x: 245, y: 20, w: 110, tone: 'ok' },
              { id: 's2', label: 'S2', sub: 'has entry 8', x: 20, y: 180, w: 110, tone: 'ok' },
              { id: 's3', label: 'S3', sub: 'has entry 8', x: 170, y: 180, w: 110, tone: 'ok' },
              { id: 's4', label: 'S4', sub: 'slow disk', x: 320, y: 180, w: 110, tone: 'muted' },
              { id: 's5', label: 'S5', sub: 'down', x: 470, y: 180, w: 110, tone: 'bad' },
            ],
            edges: [
              { from: 's1', to: 's2', label: 'ack', tone: 'ok' },
              { from: 's1', to: 's3', label: 'ack', tone: 'ok' },
              { from: 's1', to: 's4', label: 'waiting', dashed: true },
              { from: 's1', to: 's5', label: 'no reply', dashed: true, tone: 'bad' },
            ],
          },
          caption:
            "Entry 8 is committed with S5 down and S4 slow. The leader plus two acknowledgements is 3 of 5. The commit waits for the second-fastest follower, never the slowest, which is why a consensus group has steadier latency than waiting for every replica.",
        },
        {
          sequence: {
            actors: ['Client', 'Leader', 'Follower 1', 'Follower 2'],
            messages: [
              { from: 'Client', to: 'Leader', label: 'set owner = A' },
              { from: 'Leader', to: 'Follower 1', label: 'append (term 3, index 8)' },
              { from: 'Leader', to: 'Follower 2', label: 'append (term 3, index 8)' },
              { from: 'Follower 1', to: 'Leader', label: 'on disk', tone: 'ok' },
              { from: 'Leader', to: 'Client', label: 'committed', tone: 'ok', note: '2 of 3 hold it' },
              { from: 'Follower 2', to: 'Leader', label: 'on disk', dashed: true, note: 'late; not needed' },
            ],
          },
          caption:
            "One write in a three-node group. The cost is one round trip to the nearest follower plus a disk flush on two machines. That is the floor for every consensus write, and where the latency figures later on this page come from.",
        },
        {
          see: [
            { href: '#/s/raft', label: 'Raft', why: 'Elections, a partitioned leader, log repair and the commit rule, one message at a time.' },
            { href: '#/s/two-phase-commit', label: 'Two-phase commit', why: 'Atomic commit across shards. It blocks if the coordinator dies, which is why the coordinator itself is usually a consensus group.' },
          ],
        },
        {
          p: "Paxos and ZooKeeper's ZAB solve the same problem with the same majorities. For an interview you rarely need to tell them apart. You do need the majority argument, and the fact that reads need care too: a leader that has been deposed without knowing can serve a stale read unless it confirms its leadership first.",
        },
      ],
    },
    {
      id: 'leases',
      title: 'Leases, and why clocks make them hard',
      blocks: [
        {
          p: "A lock held by a crashed process is held for ever. A **lease** fixes that: it's a lock with an expiry. The holder must renew it, say every 3 seconds for a 10-second lease. If the holder dies, the lease runs out and someone else may take it.",
        },
        {
          p: "The difficulty is that the lease lives in two places. The service counts down 10 seconds on its clock. The holder counts down on its own. Safety depends on the holder stopping before the service gives the lease away, and three things break that.",
        },
        {
          table: {
            head: ['What happens', 'Why the holder is wrong', 'Typical size'],
            rows: [
              ['Process pause', 'A garbage collection, a VM migration or a swapped-out page stops the process between checking the lease and acting on it', 'Milliseconds, occasionally many seconds'],
              ['Network delay', 'The write left while the lease was valid and arrives after it expired', 'Milliseconds to the length of a TCP retry'],
              ['Clock jump', 'Wall-clock time is stepped by NTP or runs at a different rate, so "10 seconds" differs between machines', 'Usually milliseconds; unbounded when misconfigured'],
            ],
          },
          caption: 'None of these is a bug in the holder. Its code checked the lease and the check passed.',
        },
        {
          p: "Good practice narrows the window. Measure the lease on a monotonic clock, never wall-clock time. Start the holder's countdown from when it sent the request, not when the reply came. Treat the lease as shorter than granted, 8 seconds of a 10-second lease, to allow for drift. Stop work when a renewal fails.",
        },
        {
          p: "None of that closes it. Checking the lease and doing the write are two steps, and a pause can always fall between them. A lease alone makes two holders unlikely. It can't make them impossible.",
        },
      ],
    },
    {
      id: 'fencing',
      title: 'Fencing tokens',
      blocks: [
        {
          p: "Here is the failure, with a 10-second lease and a 15-second pause.",
        },
        {
          sequence: {
            actors: ['Worker 1', 'Lock service', 'Worker 2', 'Storage'],
            messages: [
              { from: 'Worker 1', to: 'Lock service', label: 'acquire lease' },
              { from: 'Lock service', to: 'Worker 1', label: 'granted, 10 s', tone: 'ok', note: 'Worker 1 pauses for 15 s' },
              { from: 'Worker 2', to: 'Lock service', label: 'acquire lease', note: 'lease expired at 10 s' },
              { from: 'Lock service', to: 'Worker 2', label: 'granted, 10 s', tone: 'ok' },
              { from: 'Worker 2', to: 'Storage', label: 'write file v2', tone: 'ok' },
              { from: 'Worker 1', to: 'Storage', label: 'write file v1', tone: 'bad', note: 'wakes, still thinks it holds the lease' },
            ],
          },
          caption:
            "Both workers behaved correctly by their own lights. The lock service never had two holders at once. The file is corrupt anyway, because storage accepted a write from a holder whose lease had gone. The lock was right and the outcome was wrong.",
        },
        {
          p: "The fix moves the check to the place the damage happens. Every time the lock service grants the lease it hands out a number that only goes up: a **fencing token**. The holder sends the token with every write. Storage remembers the highest token it has seen and refuses anything lower.",
        },
        {
          sequence: {
            actors: ['Worker 1', 'Lock service', 'Worker 2', 'Storage'],
            messages: [
              { from: 'Lock service', to: 'Worker 1', label: 'granted, token 33', note: 'Worker 1 pauses for 15 s' },
              { from: 'Lock service', to: 'Worker 2', label: 'granted, token 34', note: 'after expiry' },
              { from: 'Worker 2', to: 'Storage', label: 'write v2, token 34', tone: 'ok' },
              { from: 'Storage', to: 'Worker 2', label: 'ok, highest = 34', tone: 'ok' },
              { from: 'Worker 1', to: 'Storage', label: 'write v1, token 33', tone: 'compare' },
              { from: 'Storage', to: 'Worker 1', label: 'refused: 33 < 34', tone: 'bad' },
            ],
          },
          caption:
            "The same pause, now harmless. Storage compares 33 with 34 and refuses the late write. Worker 1 learns it lost the lease from the refusal and stops. Timing no longer matters: however long the pause, the stale token loses.",
        },
        {
          p: "In a SQL store the check is one conditional update. Zero rows changed means you've been fenced.",
        },
        {
          code: `UPDATE shard_state
   SET payload = $1,
       fence   = $2          -- the token this worker holds
 WHERE shard_id = $3
   AND fence <= $2;          -- refuse anything older

-- 0 rows updated: a newer holder exists. Stop working.`,
          lang: 'sql',
          title: 'The store enforces the token',
        },
        {
          p: "Two conditions apply. The token must come from the consensus service, so it's ordered: etcd's revision, ZooKeeper's zxid or a Raft term all work. And the resource must check it. A lock around a call to a third-party API that knows nothing of tokens can't be fenced. There you fall back on making the call idempotent.",
        },
        {
          callout:
            "When you say 'we take a lock', the next question is 'what if the holder pauses?'. Answer before it's asked: 'The lease comes with a fencing token from etcd, and the store rejects writes carrying an older token, so a paused holder can't overwrite the new one.' The same idea is the epoch that fences an old database leader on the [replication](#/c/replication) page.",
          kind: 'interview',
          title: 'The follow-up to expect',
        },
      ],
    },
    {
      id: 'services',
      title: 'ZooKeeper, etcd and Consul',
      blocks: [
        {
          p: "Nobody should write a consensus algorithm for a product feature. The usual answer is to run one of three services and build on its primitives. All three are small, replicated, linearizable key-value stores with a few extra features that make coordination possible.",
        },
        {
          table: {
            head: ['Primitive', 'What it gives you', 'ZooKeeper', 'etcd', 'Consul'],
            rows: [
              ['Linearizable writes', 'One order that every client agrees on', 'ZAB', 'Raft', 'Raft'],
              ['Compare-and-set', 'Create if absent, update if unchanged: the base of every lock', 'Versioned znodes', 'Transactions on revisions', 'Check-and-set on an index'],
              ['Keys that die with their owner', 'A crashed holder releases its lock without help', 'Ephemeral nodes', 'Keys attached to a lease', 'Keys attached to a session'],
              ['Watches', 'Learn of a change without polling', 'Watches', 'Watch streams', 'Blocking queries'],
              ['A counter that only rises', 'A ready-made fencing token', 'zxid', 'Revision', 'Index'],
            ],
          },
          caption: 'The names differ; the five primitives are the same. Leader election is compare-and-set on a key that dies with its owner.',
        },
        {
          p: "Kubernetes keeps its cluster state in etcd. Kafka used ZooKeeper for controller election and metadata for years and has since moved to its own Raft implementation, KRaft. Many databases with automatic failover lean on one of these services to decide who the leader is.",
        },
        {
          p: "They're built for small, precious data: megabytes to a few gigabytes, read often and written rarely. Don't use one as a queue or a general database. Every write is a majority round trip with a disk flush, and the whole data set sits in memory on every node.",
        },
        {
          callout:
            "In a design, say what you store there and how often it changes: 'The shard map and one leader key per shard live in etcd. That's a few hundred keys, written on failover and rebalancing, a handful of times a day. Services watch for changes and cache the map, so an etcd outage stops rebalancing but doesn't stop traffic.' The last clause matters: say what still works when coordination is down.",
          kind: 'interview',
          title: 'How to place it in a design',
        },
      ],
    },
    {
      id: 'locks',
      title: 'Distributed locks and their limits',
      blocks: [
        {
          p: "Ask what the lock is for. There are two answers and they need different tools.",
        },
        {
          diagram: {
            w: 540,
            h: 330,
            nodes: [
              { id: 'q', label: 'If two holders overlap?', x: 170, y: 10, w: 200, tone: 'compare' },
              { id: 'eff', label: 'Work is done twice', sub: 'wasteful, not wrong', x: 20, y: 130, w: 200 },
              { id: 'cor', label: 'Data is wrong', sub: 'double payment, corrupt file', x: 320, y: 130, w: 200, tone: 'bad' },
              { id: 'redis', label: 'Any lock with a timeout', sub: 'one Redis key is fine', x: 20, y: 250, w: 200 },
              { id: 'fence', label: 'Consensus + fencing', sub: 'or one database transaction', x: 320, y: 250, w: 200, tone: 'ok' },
            ],
            edges: [
              { from: 'q', to: 'eff', label: 'efficiency' },
              { from: 'q', to: 'cor', label: 'correctness' },
              { from: 'eff', to: 'redis' },
              { from: 'cor', to: 'fence' },
            ],
          },
          caption:
            "The two-winners test again, as a decision. A lock that only saves duplicate work can be cheap and occasionally wrong. A lock that protects data must be backed by consensus, and even then the store, not the lock, makes the final check.",
        },
        {
          p: "For efficiency, a single Redis key set with `SET key value NX PX 30000` is fine. If Redis fails over and two workers briefly hold the key, a report is generated twice. Nobody is hurt.",
        },
        {
          p: "For correctness, that lock isn't enough, and running it on several Redis nodes doesn't change the argument: without a fencing token checked by the resource, a paused holder still writes late. Use a lease from a consensus service with fencing. Better, avoid the lock. If the protected data is in one database, put the rule there: a unique constraint, a conditional update, a row lock inside the transaction that does the work.",
        },
        {
          callout:
            "Using a distributed lock to make a payment 'exactly once'. The lock stops two workers starting together. It doesn't stop one worker crashing after the bank call and before recording it, and the next holder repeating the call. What makes a payment safe is an idempotency key the bank honours and a unique constraint on your side. The lock, if you keep it, only saves wasted calls.",
          kind: 'pitfall',
          title: 'A lock is not idempotency',
        },
        {
          see: [
            { href: '#/s/idempotency-keys', label: 'Idempotency keys', why: 'How a repeated request becomes a no-op, which removes most reasons to lock.' },
            { href: '#/s/two-phase-locking', label: 'Two-phase locking', why: 'Locks inside one database, where the lock manager and the data fail together.' },
          ],
        },
      ],
    },
    {
      id: 'cost',
      title: 'What it costs',
      blocks: [
        {
          p: "Every consensus write waits for a majority, with a disk flush on each. That sets three limits: how many nodes, where they sit, and how much traffic goes through them.",
        },
        {
          table: {
            head: ['Nodes', 'Majority', 'Failures survived', 'Note'],
            rows: [
              ['3', '2', '1', 'The usual choice. One node per zone.'],
              ['4', '3', '1', 'No better than 3, and one more machine that can be slow.'],
              ['5', '3', '2', 'Survives a failure during maintenance on another node.'],
              ['7', '4', '3', 'Rare. Each write goes to more machines for little gain.'],
            ],
          },
          caption: 'Use odd numbers. An even count raises the majority without raising the failures survived.',
        },
        {
          p: "Placement decides latency. A commit waits for the fastest majority, so what matters is the round trip from the leader to the nodes that complete it.",
        },
        {
          diagram: {
            w: 540,
            h: 390,
            nodes: [
              { id: 'n1', label: 'N1 leader', sub: 'London', x: 20, y: 170, tone: 'ok' },
              { id: 'n2', label: 'N2', sub: 'London', x: 380, y: 20, tone: 'ok' },
              { id: 'n3', label: 'N3', sub: 'Dublin', x: 380, y: 120, tone: 'ok' },
              { id: 'n4', label: 'N4', sub: 'Dublin', x: 380, y: 220 },
              { id: 'n5', label: 'N5', sub: 'Virginia', x: 380, y: 320, tone: 'muted' },
            ],
            edges: [
              { from: 'n1', to: 'n2', label: '1 ms', tone: 'ok' },
              { from: 'n1', to: 'n3', label: '10 ms', tone: 'ok' },
              { from: 'n1', to: 'n4', label: '10 ms' },
              { from: 'n1', to: 'n5', label: '75 ms', dashed: true },
            ],
          },
          caption:
            "Five nodes, leader in London. The majority is N1, N2 and one Dublin node, so a write commits in about 10 ms and never waits for Virginia. Put one node on each of five continents instead and every write waits for an ocean crossing: 75 ms or more, each time.",
        },
        {
          p: "So a latency-sensitive path, such as a card authorisation with a budget of 100 ms end to end, can't afford a consensus group spread across oceans. Keep the group inside one region or two close ones, and replicate to distant regions asynchronously for disaster recovery. If the leader moves to the far region after a failover, every write pays the long round trip until it moves back.",
        },
        {
          p: "Throughput is bounded too. All writes go through one leader and one log, so a group handles thousands of small writes a second, not hundreds of thousands. Systems that need more run many groups, one per shard, as Spanner-style databases do. During an election, typically a few seconds, the group accepts no writes at all.",
        },
        {
          callout:
            "Give the three costs in one breath: 'Each write is a majority round trip, about 2 ms in-region. We run 3 nodes across 3 zones, which survives one zone. It's on the control path only, so data-path latency doesn't depend on it.' Then, if regions come up: 'I wouldn't stretch the group across the Atlantic for the authorisation path; that adds 75 ms to every write.'",
          kind: 'interview',
          title: 'What to say about cost',
        },
        {
          see: [
            { href: '#/c/replication', label: 'Replication', why: 'Failover, split brain and epochs: the problems consensus is brought in to solve.' },
            { href: '#/c/consistency-models', label: 'Consistency models', why: 'Linearizability, the guarantee a consensus group provides.' },
          ],
        },
      ],
    },
  ],
  unverified: [
    'Round-trip figures (1 ms within London, 10 ms London to Dublin, 75 ms London to Virginia, about 2 ms for an in-region majority) are rough orders of magnitude, not measurements.',
    'The table mapping primitives to ZooKeeper, etcd and Consul features (versioned znodes, etcd transactions on revisions, Consul check-and-set on ModifyIndex, sessions, blocking queries) is from memory of each product\'s documentation.',
    'That etcd, ZooKeeper and Consul each keep the whole data set in memory on every node, and suit "megabytes to a few gigabytes", is from memory; exact limits and defaults were not checked.',
    '"Thousands of small writes a second" for one consensus group and "a few seconds" for an election are typical figures, not benchmarks; both depend on configuration.',
    'Kafka\'s move from ZooKeeper to KRaft and Kubernetes\' use of etcd are stated from memory; no version numbers are given.',
    'The lease margins (renew every 3 s, treat a 10 s lease as 8 s) are illustrative, not any product\'s defaults.',
    'The argument that a multi-node Redis lock (Redlock) is still unsafe without fencing follows Martin Kleppmann\'s published critique from memory; Redis\'s author disputes parts of it.',
    'The SQL fencing example was not run.',
    'The 100 ms end-to-end budget for a card authorisation is an assumed figure.',
  ],
};

export default page;
