import type { Concept } from '../types';

const page: Concept = {
  id: 'replication',
  title: 'Replication',
  group: 'Data',
  summary:
    "Replication keeps the same data on several machines. This page covers the three shapes (single-leader, multi-leader, leaderless), what the leader waits for before it says saved, what lag does to readers, how failover loses writes, and how to settle conflicts when more than one node takes writes.",
  minutes: 12,
  sections: [
    {
      id: 'why',
      title: 'Why replicate',
      blocks: [
        {
          p: "There are three reasons, and it helps to say which one you're solving. **Survive a failure**: a second copy can take over in seconds, where restoring a 500 GB backup takes hours. **Scale reads**: most products read far more than they write, and replicas share the reads. **Be near users**: a copy in the user's region answers in 5 ms where a cross-ocean hop takes 80.",
        },
        {
          p: "Replication doesn't scale writes. Every replica applies every write, so adding replicas adds no write capacity. That's what [partitioning](#/s/partitioning) is for. It isn't a backup either: a `DELETE` without a `WHERE` replicates faithfully in milliseconds.",
        },
        {
          diagram: {
            w: 600,
            h: 320,
            groups: [
              { label: 'Zone A', x: 10, y: 130, w: 180, h: 180 },
              { label: 'Zone B', x: 210, y: 130, w: 180, h: 180 },
              { label: 'Zone C', x: 410, y: 130, w: 180, h: 180 },
            ],
            nodes: [
              { id: 'app', label: 'Service', x: 230, y: 10, kind: 'client' },
              { id: 'f1', label: 'Follower 1', sub: 'reads', x: 30, y: 190, kind: 'store' },
              { id: 'leader', label: 'Leader', sub: 'every write', x: 230, y: 190, kind: 'store', tone: 'ok' },
              { id: 'f2', label: 'Follower 2', sub: 'reads', x: 430, y: 190, kind: 'store' },
            ],
            edges: [
              { from: 'app', to: 'leader', label: 'writes', tone: 'ok' },
              { from: 'app', to: 'f1', label: 'reads' },
              { from: 'app', to: 'f2', label: 'reads' },
              { from: 'leader', to: 'f1', label: 'log' },
              { from: 'leader', to: 'f2', label: 'log' },
            ],
          },
          caption:
            "The default shape. One leader in one zone takes every write and ships its log to a follower in each other zone. Lose any one zone and two copies remain. Reads spread across all three; writes do not.",
        },
      ],
    },
    {
      id: 'three-shapes',
      title: 'Three shapes',
      blocks: [
        {
          p: "The shapes differ in one thing: which nodes may accept a write. Everything else follows from that.",
        },
        {
          diagram: {
            w: 630,
            h: 230,
            groups: [
              { label: 'Single leader', x: 10, y: 10, w: 190, h: 210 },
              { label: 'Multi-leader', x: 220, y: 10, w: 190, h: 210 },
              { label: 'Leaderless', x: 430, y: 10, w: 190, h: 210 },
            ],
            nodes: [
              { id: 'l', label: 'Leader', x: 70, y: 50, w: 70, h: 40, tone: 'ok' },
              { id: 'fa', label: 'Follower', x: 20, y: 160, w: 70, h: 40 },
              { id: 'fb', label: 'Follower', x: 120, y: 160, w: 70, h: 40 },
              { id: 'la', label: 'Leader A', x: 280, y: 50, w: 70, h: 40, tone: 'ok' },
              { id: 'lb', label: 'Leader B', x: 280, y: 160, w: 70, h: 40, tone: 'ok' },
              { id: 'n1', label: 'Node', x: 490, y: 50, w: 70, h: 40, tone: 'ok' },
              { id: 'n2', label: 'Node', x: 440, y: 160, w: 70, h: 40, tone: 'ok' },
              { id: 'n3', label: 'Node', x: 540, y: 160, w: 70, h: 40, tone: 'ok' },
            ],
            edges: [
              { from: 'l', to: 'fa' },
              { from: 'l', to: 'fb' },
              { from: 'la', to: 'lb', label: 'both ways', both: true },
              { from: 'n1', to: 'n2', both: true },
              { from: 'n1', to: 'n3', both: true },
              { from: 'n2', to: 'n3', both: true },
            ],
          },
          caption:
            "Green nodes accept writes. With one green node there is one order of writes and nothing to reconcile. With two or more, two clients can change the same key at the same moment on different nodes, and something must decide the outcome.",
        },
        {
          table: {
            head: ['Shape', 'Problem it solves', 'How a write travels', 'What it costs', 'What breaks', 'Choose it when'],
            rows: [
              [
                'Single leader',
                'One order of writes, simple reads',
                'To the leader, then down a log to followers',
                'Writes limited to one node; failover needed',
                'Lost writes or split brain at failover',
                'Almost always. Balances, orders, anything with constraints',
              ],
              [
                'Multi-leader',
                'Local write latency in several regions; offline clients',
                'To the nearest leader, then asynchronously to the others',
                'Conflict handling in every table that two leaders can touch',
                'Concurrent writes to one key; unique constraints stop working',
                'Regions that mostly write their own data; collaborative or offline apps',
              ],
              [
                'Leaderless',
                'No failover; writes continue while nodes are down',
                'To all N replicas; succeeds when W acknowledge',
                'Weaker ordering; read repair and anti-entropy to run',
                'Concurrent writes, stale reads when R + W ≤ N',
                'High-volume key-value data where last-write-wins is acceptable',
              ],
            ],
          },
          caption: 'Start with a single leader and move only when you can name the limit you have hit.',
        },
        {
          see: [
            { href: '#/s/leader-replication', label: 'Leader and followers', why: 'Log positions, the three acknowledgement modes, lag and failover, one step at a time.' },
            { href: '#/s/quorum', label: 'Quorum reads and writes', why: 'Leaderless replication: N, W and R, read repair and what the overlap does not promise.' },
          ],
        },
      ],
    },
    {
      id: 'sync-async',
      title: 'When does the leader say saved?',
      blocks: [
        {
          p: "This is the single most consequential setting in a replicated database. The leader can acknowledge a write before any follower has it, after one has it, or after all of them do.",
        },
        {
          sequence: {
            actors: ['Client', 'Leader', 'Sync follower', 'Async follower'],
            messages: [
              { from: 'Client', to: 'Leader', label: 'write w7' },
              { from: 'Leader', to: 'Sync follower', label: 'w7' },
              { from: 'Sync follower', to: 'Leader', label: 'on disk', tone: 'ok' },
              { from: 'Leader', to: 'Client', label: 'saved', tone: 'ok', note: 'two copies exist' },
              { from: 'Leader', to: 'Async follower', label: 'w7', dashed: true, note: 'whenever it gets there' },
            ],
          },
          caption:
            "Semi-synchronous replication. The client waits for one extra round trip, and at the moment it hears saved the write is on two machines. The asynchronous follower is not on the critical path, so its slowness costs nothing and its copy is always a little old.",
        },
        {
          table: {
            head: ['Mode', 'Client waits for', 'Added latency', 'Acknowledged writes lost at failover', 'What stalls writes'],
            rows: [
              ['Asynchronous', 'The leader alone', 'None', 'Everything not yet shipped: lag × write rate', 'Nothing'],
              ['Semi-synchronous', 'The leader and one follower', 'One round trip: about 1 ms in a region', 'None, while the sync follower keeps up', 'The sync follower being slow or down'],
              ['Synchronous (all)', 'Every follower', 'The slowest follower', 'None', 'Any one follower being slow or down'],
            ],
          },
          caption: 'Fully synchronous is rarely run: one bad disk on one follower stops every write.',
        },
        {
          p: "Semi-sync has a trap. If the synchronous follower is slow, something has to give. MySQL's semi-sync falls back to asynchronous after a timeout and carries on. Postgres keeps waiting unless you list several candidates and let any one of them satisfy the commit. Know which your database does, because the first turns 'no lost writes' into 'no lost writes unless we were already having a bad day'.",
        },
        {
          callout:
            "Three nodes in three zones, commit waits for any one of the two followers. You survive a zone, lose nothing that was acknowledged, and a single slow follower doesn't stall writes because the other can answer. This is also what a consensus group does, which is no coincidence: see [Consensus and coordination](#/c/consensus-and-coordination).",
          kind: 'rule',
          title: 'A sound default',
        },
      ],
    },
    {
      id: 'lag',
      title: 'Replication lag and what it does to readers',
      blocks: [
        {
          p: "An asynchronous follower is behind by the time it takes to ship and apply the log. On a quiet system that's a few milliseconds. A bulk import, a long query on the replica or a slow disk can stretch it to minutes. Any read from that follower is that old.",
        },
        {
          p: "Lag produces three anomalies. The first, a stale read of your own write, is drawn on the [consistency models](#/c/consistency-models) page. Here is the second.",
        },
        {
          sequence: {
            actors: ['User', 'Replica B', 'Replica C'],
            messages: [
              { from: 'User', to: 'Replica B', label: 'list payments', note: 'B is at position 42' },
              { from: 'Replica B', to: 'User', label: '3 payments', tone: 'ok' },
              { from: 'User', to: 'Replica C', label: 'list payments', note: 'refresh; C is at position 40' },
              { from: 'Replica C', to: 'User', label: '2 payments', tone: 'bad', note: 'one has vanished' },
            ],
          },
          caption:
            "Monotonic reads broken. Each replica is correct for its own position, but the load balancer sent two requests to two positions, and the user watched a payment disappear. Support tickets follow.",
        },
        {
          table: {
            head: ['Anomaly', 'What the user sees', 'Fix', 'Cost of the fix'],
            rows: [
              ['No read-your-writes', 'I saved it and it is not there', 'Read from the leader for a few seconds after a write, or carry the write position and wait for it', 'More leader reads, or a short wait'],
              ['Non-monotonic reads', 'Data appears, then disappears', 'Pin a user to one replica (hash of user id), or carry the last position seen', 'Uneven load; re-pin when a replica dies'],
              ['Broken causal order', 'An answer shows before its question', 'Keep related writes in one partition so one log orders them', 'Constrains the partition key'],
            ],
          },
        },
        {
          p: "The position token fixes the first two with one mechanism. The leader returns the log position of each write. The client sends it back with later reads. A replica that hasn't reached that position waits a few milliseconds or hands the read to the leader.",
        },
        {
          sequence: {
            actors: ['User', 'Leader', 'Replica'],
            messages: [
              { from: 'User', to: 'Leader', label: 'pay £20' },
              { from: 'Leader', to: 'User', label: 'saved at position 42', tone: 'ok' },
              { from: 'User', to: 'Replica', label: 'list payments, at least 42', tone: 'compare' },
              { from: 'Leader', to: 'Replica', label: 'entries 41, 42', dashed: true, note: 'replica was at 40, so it holds the read about 20 ms' },
              { from: 'Replica', to: 'User', label: '3 payments', tone: 'ok' },
            ],
          },
          caption:
            "The same reload, with a token. The replica compares its position with the one the client carries and waits until it has caught up. Reads stay on replicas, and the user never sees less than they have already seen.",
        },
        {
          callout:
            "Reading from a replica inside a write path. A service reads the balance from a replica, decides the payment fits, and writes the debit to the leader. The decision was made on old data. Any read that feeds a write belongs on the leader, inside the same transaction as the write.",
          kind: 'pitfall',
          title: 'Stale read, fresh write',
        },
      ],
    },
    {
      id: 'failover',
      title: 'Failover',
      blocks: [
        {
          p: "Failover has four steps, and each can go wrong. **Detect**: followers or a monitor miss heartbeats for a timeout, say 10 seconds. **Promote**: pick the follower with the most log. **Reconfigure**: point clients and the other followers at it. **Fence**: make sure the old leader can never take a write again.",
        },
        {
          p: "Detection is a guess. A dead leader and a leader in a 15-second pause look the same from outside. Set the timeout short and you fail over during every load spike. Set it long and writes are down that long.",
        },
        { h: 'Lost writes on asynchronous promotion' },
        {
          sequence: {
            actors: ['Client', 'Leader A', 'Follower B'],
            messages: [
              { from: 'Client', to: 'Leader A', label: 'write w7' },
              { from: 'Leader A', to: 'Client', label: 'saved', tone: 'ok', note: 'B has up to w6 only' },
              { from: 'Leader A', to: 'Follower B', label: 'w7', dashed: true, tone: 'bad', note: 'A crashes; never sent' },
              { from: 'Client', to: 'Follower B', label: 'read w7', note: 'B has been promoted at w6' },
              { from: 'Follower B', to: 'Client', label: 'not found', tone: 'bad' },
              { from: 'Leader A', to: 'Follower B', label: 'rejoins, discards w7', tone: 'bad' },
            ],
          },
          caption:
            "The client was told saved, and the write is gone. When A comes back it must throw w7 away to match the new leader. At 5,000 writes a second and 200 ms of lag, that is about 1,000 acknowledged writes (5,000 × 0.2). Only waiting for a follower before acknowledging brings it to zero.",
        },
        { h: 'Split brain and fencing' },
        {
          p: "The worse failure is two leaders at once. The old leader wasn't dead, only slow or cut off, and it still accepts writes from clients that can reach it. Now two histories grow apart. The fix is an **epoch** (Raft calls it a term): a number that goes up at every promotion and travels with every message. Followers and storage refuse anything from an older epoch.",
        },
        {
          diagram: {
            w: 480,
            h: 340,
            nodes: [
              { id: 'c1', label: 'Client 1', x: 40, y: 20, kind: 'client' },
              { id: 'c2', label: 'Client 2', x: 300, y: 20, kind: 'client' },
              { id: 'a', label: 'Old leader A', sub: 'epoch 4, still running', x: 40, y: 140, kind: 'store', tone: 'bad' },
              { id: 'b', label: 'New leader B', sub: 'epoch 5', x: 300, y: 140, kind: 'store', tone: 'ok' },
              { id: 'c', label: 'Follower C', sub: 'has seen epoch 5', x: 170, y: 270, kind: 'store' },
            ],
            edges: [
              { from: 'c1', to: 'a', label: 'write' },
              { from: 'c2', to: 'b', label: 'write' },
              { from: 'a', to: 'c', label: 'e4: refused', dashed: true, tone: 'bad' },
              { from: 'b', to: 'c', label: 'e5: applied', tone: 'ok' },
            ],
          },
          caption:
            "Fencing by epoch. A still believes it leads, but C has seen a higher epoch and refuses A's entries, so A can never get a write acknowledged by another node. If A acknowledges on its own (asynchronous mode), Client 1's writes are still lost: the epoch protects the data, not the promise.",
        },
        {
          p: "Stronger fencing cuts the old leader off physically: revoke its storage, remove it from the load balancer, or power it off before promoting. Who decides there's a new leader matters too. Two monitors that disagree create the split brain they were meant to prevent, so the decision itself needs a majority. That's what [Raft](#/s/raft) provides, and why tools such as Patroni keep the leader key in etcd.",
        },
        { h: 'RPO and RTO' },
        {
          p: "Two numbers turn this into a requirement. **RPO**, recovery point objective, is how much acknowledged data you may lose: zero with a synchronous follower, lag × write rate without one. **RTO**, recovery time objective, is how long writes may be down: the detection timeout, plus promotion, plus clients reconnecting. A 10-second timeout rarely gives better than 20 to 30 seconds in practice.",
        },
        {
          callout:
            "Give both numbers and how you get them: 'RPO zero for the ledger, by committing to a synchronous standby in a second zone. RTO about 30 seconds: 10 to detect, a few to promote, the rest for connection pools to notice. Callers retry with idempotency keys, so a payment in flight during failover is applied once.' Then say what the old leader is prevented from doing, and by what.",
          kind: 'interview',
          title: 'What to say about failover',
        },
      ],
    },
    {
      id: 'read-replicas',
      title: 'Read replicas for scale',
      blocks: [
        {
          p: "Do the arithmetic before adding replicas. Say the product does 20,000 reads and 1,000 writes a second, and one node handles about 8,000 simple queries a second. One leader can't carry 21,000. A leader plus three replicas can: the leader takes the writes and the reads that feed them, and each replica takes about 6,000 reads on top of applying the same 1,000 writes.",
        },
        {
          p: "Two limits arrive later. Each replica spends capacity applying writes, so as the write rate grows, replicas have less room for reads and adding more helps less. And every replica is a full copy, so 2 TB of data on five nodes is 10 TB of disk. When the leader's write rate is the bottleneck, replicas can't help and it's time to partition.",
        },
        {
          callout:
            "Route by need, not by verb. Reads that feed a decision go to the leader. Reads just after the same user's write carry a position token. Everything else, usually well over 90% of reads, goes to replicas. Long analytical queries get their own replica so they can't hold back the ones serving users.",
          kind: 'rule',
          title: 'Routing reads',
        },
      ],
    },
    {
      id: 'conflicts',
      title: 'Conflicts when several nodes take writes',
      blocks: [
        {
          p: "With more than one writer, two clients can change the same key on different nodes before either node hears of the other. Neither write is wrong. The system needs a rule, and there are only three kinds.",
        },
        {
          sequence: {
            actors: ['Phone', 'Leader EU', 'Leader US', 'Laptop'],
            messages: [
              { from: 'Phone', to: 'Leader EU', label: 'cart = [milk, eggs]', note: 'stamped 12:00:00.100' },
              { from: 'Laptop', to: 'Leader US', label: 'cart = [milk, tea]', note: 'stamped 12:00:00.090' },
              { from: 'Leader EU', to: 'Leader US', label: 'replicate', dashed: true },
              { from: 'Leader US', to: 'Leader EU', label: 'replicate', dashed: true },
              { from: 'Leader US', to: 'Laptop', label: 'cart = [milk, eggs]', tone: 'bad', note: 'tea is gone, no error' },
            ],
          },
          caption:
            "Last-writer-wins. Both leaders keep the write with the later timestamp, so they agree, and the laptop's tea is silently dropped. If the US clock ran 20 ms fast, eggs would be dropped instead. The clocks decide, and they are never exactly right.",
        },
        {
          table: {
            head: ['Rule', 'How it decides', 'What you lose', 'Use it for'],
            rows: [
              ['Last-writer-wins', 'Highest timestamp replaces the rest', 'Every concurrent write but one, without an error', 'Caches, last-seen times, values where the newest is all that matters'],
              ['Version vectors + siblings', 'Detects that two writes were concurrent and keeps both', 'Nothing, but the application must merge', 'Carts, profiles: data with an obvious merge'],
              ['CRDTs', 'The data type merges itself the same way on every node', 'Rules that compare replicas: uniqueness, never below zero', 'Counters, sets, collaborative text, presence'],
            ],
          },
          caption: 'Version vectors detect; they do not resolve. A CRDT is a merge rule you no longer have to write.',
        },
        {
          see: [
            { href: '#/s/version-vectors', label: 'Version vectors', why: 'The cart example: how a vector tells "happened after" from "concurrent".' },
            { href: '#/s/crdt', label: 'CRDTs', why: 'Counters and sets that merge in any order, and what the tombstones cost.' },
          ],
        },
        {
          p: "The cheapest rule is to avoid the conflict. Give every record a home leader, such as the user's region, and route its writes there. Two leaders then only write the same key during a failover or when a user travels. Many 'multi-leader' deployments are really single-leader per record.",
        },
        {
          callout:
            "Proposing active-active across regions for a ledger. A balance has a rule (never below the limit) that no merge can enforce after the fact: both regions approve a £60 spend against £100 and the merge yields minus £20. Money needs one writer per account. Go multi-region with a home region per account, or with consensus, not with conflict resolution.",
          kind: 'pitfall',
          title: 'Active-active money',
        },
      ],
    },
    {
      id: 'choosing',
      title: 'Choosing, and what to say',
      blocks: [
        {
          diagram: {
            w: 520,
            h: 410,
            nodes: [
              { id: 'q1', label: 'Rules across writes?', sub: 'unique, balance, stock', x: 30, y: 10, w: 200, tone: 'compare' },
              { id: 'single', label: 'Single leader', sub: 'sync standby, replicas', x: 320, y: 10, w: 180, tone: 'ok' },
              { id: 'q2', label: 'Writes far from leader?', sub: 'offline, other regions', x: 30, y: 120, w: 200, tone: 'compare' },
              { id: 'multi', label: 'Multi-leader', sub: 'home leader per record', x: 320, y: 120, w: 180 },
              { id: 'q3', label: 'Must write through', sub: 'node loss, no failover?', x: 30, y: 230, w: 200, tone: 'compare' },
              { id: 'less', label: 'Leaderless quorum', sub: 'N = 3, W = 2, R = 2', x: 320, y: 230, w: 180 },
              { id: 'dflt', label: 'Single leader anyway', sub: 'the simplest that works', x: 30, y: 340, w: 200, tone: 'ok' },
            ],
            edges: [
              { from: 'q1', to: 'single', label: 'yes' },
              { from: 'q1', to: 'q2', label: 'no' },
              { from: 'q2', to: 'multi', label: 'yes' },
              { from: 'q2', to: 'q3', label: 'no' },
              { from: 'q3', to: 'less', label: 'yes' },
              { from: 'q3', to: 'dflt', label: 'no' },
            ],
          },
          caption:
            "Three questions, asked in order. Two of the four exits are a single leader. The other two are for when you can name the reason: write latency far from the leader, or writes that must continue without a failover.",
        },
        {
          callout:
            "Lead with the shape and the acknowledgement mode, then the two failure stories. 'Single leader per shard, three zones, commit waits for one of two followers, so RPO is zero. Reads that feed writes go to the leader; the rest go to replicas with a position token for read-your-writes. Failover is decided by a majority through etcd and the old leader is fenced by epoch.' That is five sentences and it answers most of the follow-ups before they're asked.",
          kind: 'interview',
          title: 'The thirty-second version',
        },
        {
          see: [
            { href: '#/s/raft', label: 'Raft', why: 'Single-leader replication with the failover made safe: terms, majorities and log repair.' },
            { href: '#/c/consistency-models', label: 'Consistency models', why: 'The names for what readers are and are not promised.' },
            { href: '#/c/consensus-and-coordination', label: 'Consensus and coordination', why: 'Who decides there is a new leader, and fencing in full.' },
          ],
        },
      ],
    },
  ],
  unverified: [
    'Latency figures (5 ms in-region, 80 ms across an ocean, about 1 ms for an in-region round trip) are rough orders of magnitude, not measurements.',
    '"Restoring a 500 GB backup takes hours" is an illustration; it depends on storage and log replay.',
    'The 8,000 queries a second per node in the read-replica arithmetic is an invented round number to show the working.',
    '"A 10-second timeout rarely gives better than 20 to 30 seconds" of write downtime is from experience, not a published figure.',
    'MySQL semi-sync falling back to asynchronous after a timeout, and Postgres waiting indefinitely unless several synchronous candidates are listed (ANY n in synchronous_standby_names), are stated from memory of the documentation.',
    'That Patroni keeps its leader key in etcd (or another consensus store) is from memory.',
    '"Well over 90% of reads" being safe for replicas is a typical figure, not a measurement of any system.',
  ],
};

export default page;
