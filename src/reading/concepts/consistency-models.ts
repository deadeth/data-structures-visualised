import type { Concept } from '../types';

const page: Concept = {
  id: 'consistency-models',
  title: 'Consistency models',
  group: 'Data',
  summary:
    "A consistency model is a promise about what a read can return once data lives on more than one machine. This page orders the promises from strongest to weakest, says what each costs, and shows how to pick one per feature rather than per system.",
  minutes: 13,
  sections: [
    {
      id: 'what-it-means',
      title: 'What consistency means to a reader',
      blocks: [
        {
          p: "With one database on one machine, a read returns the last committed write. Nobody thinks about it. The question only appears when you copy the data: to a replica for failover, to a second region for latency, to a cache for speed. Now there are several copies and they don't change at the same instant.",
        },
        {
          p: "A **consistency model** is the promise the store makes about that gap. It answers three questions a caller cares about. If I write and then read, do I see my write? If you write and then tell me, do I see your write? If I read twice, can the second answer be older than the first?",
        },
        {
          diagram: {
            w: 480,
            h: 250,
            nodes: [
              { id: 'writer', label: 'Writer', sub: 'sets x = 2', x: 40, y: 20, kind: 'client' },
              { id: 'reader', label: 'Reader', sub: 'asks for x', x: 300, y: 20, kind: 'client', tone: 'follow' },
              { id: 'leader', label: 'Leader', sub: 'x = 2', x: 40, y: 170, kind: 'store', tone: 'ok' },
              { id: 'replica', label: 'Replica', sub: 'still x = 1', x: 300, y: 170, kind: 'store', tone: 'bad' },
            ],
            edges: [
              { from: 'writer', to: 'leader', label: 'write, acked' },
              { from: 'leader', to: 'replica', label: '200 ms behind', dashed: true },
              { from: 'reader', to: 'replica', label: 'read', tone: 'follow' },
            ],
          },
          caption:
            "The whole subject in one picture. The write was acknowledged, yet a read through the replica returns the old value for 200 ms. Every model below is a rule about whether this is allowed, and for whom.",
        },
        {
          p: "Two words get confused with this. The C in ACID is about application rules holding (a balance never negative). **Isolation** is about transactions that run at the same time. Both are covered below, as a separate axis. Consistency here means: how much do the copies look like one copy?",
        },
      ],
    },
    {
      id: 'the-models',
      title: 'The models, strongest first',
      blocks: [
        {
          p: "Each step down the ladder drops one promise and buys something back: lower latency, or staying up when the network splits.",
        },
        {
          diagram: {
            w: 360,
            h: 400,
            groups: [
              { label: 'Must refuse some requests in a partition', x: 20, y: 10, w: 320, h: 150 },
              { label: 'Can keep answering in a partition', x: 20, y: 176, w: 320, h: 214 },
            ],
            nodes: [
              { id: 'lin', label: 'Linearizable', sub: 'one order, in real time', x: 40, y: 40, w: 280, h: 44, tone: 'ok' },
              { id: 'seq', label: 'Sequential', sub: 'one order, may lag real time', x: 40, y: 104, w: 280, h: 44 },
              { id: 'causal', label: 'Causal', sub: 'cause always before effect', x: 40, y: 206, w: 280, h: 44 },
              { id: 'session', label: 'Session guarantees', sub: 'promises to one client only', x: 40, y: 270, w: 280, h: 44 },
              { id: 'eventual', label: 'Eventual', sub: 'copies agree once writes stop', x: 40, y: 334, w: 280, h: 44, tone: 'muted' },
            ],
            edges: [
              { from: 'lin', to: 'seq' },
              { from: 'seq', to: 'causal' },
              { from: 'causal', to: 'session' },
              { from: 'session', to: 'eventual' },
            ],
          },
          caption:
            "Each model allows everything the one above allows, and more. The line between the two groups is the one CAP draws: the top two need a majority or a single leader to answer, so a cut-off node must refuse. The lower three can answer from local data, provided a client keeps talking to the same replica.",
        },
        { h: 'Linearizable' },
        {
          p: "The store behaves like one copy. Every operation appears to take effect at a single instant between its start and its finish. Once any reader has seen the new value, no later reader sees the old one. This is what a lock, a unique username check or a balance check before a payment needs.",
        },
        {
          p: "The cost is coordination on every operation. A write waits for a majority, and a read must prove it isn't talking to a deposed leader. In one region that's about 1 to 2 ms extra. Across regions it's the round trip to the nearest majority, every time.",
        },
        { h: 'Sequential' },
        {
          p: "Everyone sees the same single order of operations, and each client's own operations stay in the order it issued them. What's dropped is real time: the order may lag the clock. You can finish a write, phone a colleague, and their read may still return the old value. A replicated log read by followers at different positions gives roughly this, as long as each client stays with one follower: same order, different progress.",
        },
        { h: 'Causal' },
        {
          p: "If one operation could have influenced another, everyone sees them in that order. A reply never appears before the comment it answers. Operations that didn't know about each other may be seen in different orders by different readers. This is roughly the strongest model that can keep working on both sides of a partition, which is why multi-region and offline-first designs aim for it. [Version vectors](#/s/version-vectors) are the usual mechanism for tracking what caused what.",
        },
        { h: 'Session guarantees' },
        {
          p: "These are promises to one client, not to everyone. There are four, and two do most of the work. **Read your writes**: after I write, my reads include it. **Monotonic reads**: my reads never go backwards in time. The other two are monotonic writes (my writes apply in the order I made them) and writes follow reads (my write lands after whatever I had read). They're cheap: a version token in the session or a sticky replica is enough.",
        },
        { h: 'Eventual' },
        {
          p: "If writes stop, the copies converge. That's the whole promise. It says nothing about how long that takes or what you read in the meantime. In a healthy system the window is milliseconds. Under load, or with a replica that's fallen behind, it can be minutes. Eventual consistency also needs a rule for concurrent writes, or the copies converge on the wrong answer: see [CRDTs](#/s/crdt).",
        },
        {
          callout:
            "Don't say strong and weak. Name the model and the operation: the payment decision reads linearizably from the leader; the transaction list is read-your-writes from a replica. Interviewers hear a lot of 'we need strong consistency' with nothing behind it.",
          kind: 'interview',
          title: 'Be specific',
        },
      ],
    },
    {
      id: 'cap-and-pacelc',
      title: 'CAP, stated correctly, and PACELC',
      blocks: [
        {
          p: "CAP is usually quoted as pick two of three. That's wrong in a useful way. You can't pick away partitions: networks fail whether you like it or not. What CAP says is narrower. **When a partition happens**, a node that can't reach the others has two options. It can refuse requests and stay consistent, or answer from what it has and risk being wrong.",
        },
        {
          diagram: {
            w: 520,
            h: 400,
            groups: [
              { label: 'Side A: two of three nodes', x: 20, y: 10, w: 480, h: 130 },
              { label: 'Side B: cut off', x: 20, y: 250, w: 480, h: 140, tone: 'compare' },
            ],
            nodes: [
              { id: 'n1', label: 'Node 1', sub: 'x = 2', x: 60, y: 60, kind: 'store', tone: 'ok' },
              { id: 'n2', label: 'Node 2', sub: 'x = 2', x: 320, y: 60, kind: 'store', tone: 'ok' },
              { id: 'n3', label: 'Node 3', sub: 'x = 1, and unsure', x: 320, y: 310, kind: 'store', tone: 'compare' },
              { id: 'cb', label: 'Client', sub: 'reads x', x: 60, y: 310, kind: 'client' },
            ],
            edges: [
              { from: 'n1', to: 'n2', label: 'in sync', both: true, tone: 'ok' },
              { from: 'n2', to: 'n3', label: 'link down', dashed: true, tone: 'bad' },
              { from: 'cb', to: 'n3', label: 'answer?', tone: 'compare' },
            ],
          },
          caption:
            "Node 3 can't tell whether it has missed a write. Answer with x = 1 and it stays available but may be stale (AP). Return an error and it stays consistent but is down for this client (CP). Side A has a majority and carries on either way.",
        },
        {
          p: "Three clarifications make this usable. The C in CAP means linearizable, nothing looser. The A means every node that's up must answer, which is stricter than 'five nines'. And the choice is per operation: one system can refuse a balance debit on the minority side while still serving the cached transaction list.",
        },
        {
          p: "Partitions are rare. A well-run cloud region might see minutes of them a year. **PACELC** covers the rest of the time: if there's a Partition, choose Availability or Consistency; Else, choose Latency or Consistency. The second half is the trade you pay every day. Waiting for a replica in another zone costs about 1 to 2 ms per write. Waiting for one across the Atlantic costs about 75 ms. Not waiting costs nothing and leaves replicas stale.",
        },
        {
          callout:
            "Saying 'we'll choose CP' and stopping. Finish the thought: during a partition the minority side returns errors for writes to this table, the client retries with an idempotency key, and reads of non-critical data fall back to a stale replica. Then say what you trade for latency when there's no partition.",
          kind: 'pitfall',
          title: 'CAP is not a product label',
        },
      ],
    },
    {
      id: 'real-stores',
      title: 'Where real stores sit',
      blocks: [
        {
          p: "Most stores offer more than one model. The model you get depends on where the read goes and what the write waited for.",
        },
        { h: 'Single-leader Postgres with replicas' },
        {
          p: "Reads and writes on the primary behave as one copy. Asynchronous replicas are eventually consistent with a lag you can measure, usually well under a second. A synchronous standby removes data loss at failover, and with `synchronous_commit = remote_apply` the commit waits until the standby has applied the change, so a read there sees it. The mechanics are on the [leader replication](#/s/leader-replication) page.",
        },
        {
          diagram: {
            w: 460,
            h: 350,
            nodes: [
              { id: 'client', label: 'Service', x: 20, y: 150, w: 120, kind: 'client' },
              { id: 'sync', label: 'Sync standby', sub: 'commit waits for it', x: 300, y: 20, kind: 'store' },
              { id: 'primary', label: 'Primary', sub: 'one copy, one order', x: 300, y: 150, kind: 'store', tone: 'ok' },
              { id: 'async', label: 'Async replica', sub: 'behind by the lag', x: 300, y: 280, kind: 'store', tone: 'muted' },
            ],
            edges: [
              { from: 'client', to: 'primary', label: 'writes + reads', tone: 'ok' },
              { from: 'client', to: 'sync', label: 'fresh reads' },
              { from: 'client', to: 'async', label: 'stale reads', dashed: true },
              { from: 'primary', to: 'sync', label: 'waits' },
              { from: 'primary', to: 'async', label: 'later', dashed: true },
            ],
          },
          caption:
            "One Postgres cluster, three consistency levels. The service picks per query by choosing a connection: the primary for decisions, the synchronous standby for reads that must include recent writes, the asynchronous replica for everything that can be a second old.",
        },
        {
          p: "One caveat: failover. If the primary dies and an asynchronous replica is promoted, writes the old primary acknowledged can vanish. Through a failover, a single-leader setup is only as strong as its replication mode.",
        },
        { h: 'Quorum stores' },
        {
          p: "Cassandra and Dynamo-style stores write to N replicas and let each request choose how many must answer. With N = 3, W = 2 and R = 2, any read overlaps the last successful write. That gives 'usually the latest value'. It doesn't give linearizability: two concurrent writes are settled by timestamp, a failed write can still be seen later, and nothing stops two clients both passing a check-then-write. The [quorum](#/s/quorum) page shows each of these. When you need a real compare-and-set, these stores add a consensus round for that one operation, at several times the latency.",
        },
        { h: 'Spanner-style' },
        {
          p: "Spanner, CockroachDB and YugabyteDB split data into ranges and run a consensus group ([Raft](#/s/raft) or Paxos) per range. Every write is a majority round trip. Transactions that span ranges add [two-phase commit](#/s/two-phase-commit) on top. The result is serializable transactions over linearizable storage, in several regions. The price is latency on every write and a system that's harder to run.",
        },
        {
          table: {
            head: ['Store shape', 'Strongest it offers', 'Default you get', 'What you pay for the strongest'],
            rows: [
              ['Postgres, primary only', 'Serializable, one copy', 'Read committed, one copy', 'Retries on serialization failures'],
              ['Postgres, async replicas', 'Same, on the primary', 'Eventual on replicas', 'Reads go back to the primary'],
              ['Quorum store (N = 3)', 'Compare-and-set by consensus', 'Eventual, tunable per request', 'Extra round trips; fewer nodes may fail'],
              ['Spanner-style', 'Serializable and linearizable, multi-region', 'The same', 'A majority round trip on every write'],
            ],
          },
          caption: 'The strongest level is rarely the default. Ask what the default is before you rely on it.',
        },
      ],
    },
    {
      id: 'isolation',
      title: 'Isolation is a separate axis',
      blocks: [
        {
          p: "Consistency models describe one object on several replicas. Isolation levels describe several objects touched by transactions that overlap in time. A store can be perfect on one axis and weak on the other. A single Postgres primary has no replica problem at all, and still loses updates at its default isolation level.",
        },
        {
          diagram: {
            w: 590,
            h: 230,
            nodes: [
              { id: 'c1', label: 'Weak isolation', x: 130, y: 10, w: 200, h: 36, kind: 'note' },
              { id: 'c2', label: 'Serializable', x: 370, y: 10, w: 200, h: 36, kind: 'note' },
              { id: 'r1', label: 'Fresh reads', x: 0, y: 70, w: 110, h: 36, kind: 'note' },
              { id: 'r2', label: 'Stale allowed', x: 0, y: 170, w: 110, h: 36, kind: 'note' },
              { id: 'a', label: 'Primary, read committed', sub: 'fresh, loses updates', x: 130, y: 60, w: 200, tone: 'compare' },
              { id: 'b', label: 'Strict serializable', sub: 'Spanner-style', x: 370, y: 60, w: 200, tone: 'ok' },
              { id: 'c', label: 'Replica, read committed', sub: 'stale and racy', x: 130, y: 160, w: 200, tone: 'muted' },
              { id: 'd', label: 'Snapshot on a replica', sub: 'consistent, but old', x: 370, y: 160, w: 200 },
            ],
            edges: [],
          },
          caption:
            "Two questions, not one. Left to right: can concurrent transactions break my rules? Top to bottom: can a read miss a finished write? Only the top-right cell answers no to both, and it is the most expensive.",
        },
        {
          p: "The levels, briefly: read committed sees only committed data but takes a fresh snapshot per statement. Snapshot isolation (Postgres calls it repeatable read) gives a transaction one snapshot throughout. Serializable makes the outcome equal to running the transactions one at a time.",
        },
        {
          see: [
            { href: '#/s/mvcc', label: 'MVCC', why: 'How snapshots work, and the lost update and write skew stories run step by step at each level.' },
            { href: '#/s/two-phase-locking', label: 'Two-phase locking and SSI', why: 'The two ways to get serializable: wait on locks, or abort at commit.' },
          ],
        },
      ],
    },
    {
      id: 'anomalies',
      title: 'Three anomalies as sequences',
      blocks: [
        {
          p: "Name an anomaly, then draw it. In an interview a four-line sequence beats a definition.",
        },
        { h: 'Stale read after write (a replica problem)' },
        {
          sequence: {
            actors: ['User', 'Leader', 'Replica'],
            messages: [
              { from: 'User', to: 'Leader', label: 'set name = Ada' },
              { from: 'Leader', to: 'User', label: 'saved', tone: 'ok' },
              { from: 'User', to: 'Replica', label: 'get name', note: 'page reload, 50 ms later' },
              { from: 'Replica', to: 'User', label: 'name = Adah (old)', tone: 'bad' },
              { from: 'Leader', to: 'Replica', label: 'name = Ada', dashed: true, note: 'arrives 200 ms after the write' },
            ],
          },
          caption:
            "The user saved a change and the next page shows the old value. Nothing is lost, but it looks lost, and users save again. Fix: read-your-writes. Send this user's reads to the leader for a short while, or carry the write's log position and wait for the replica to reach it.",
        },
        { h: 'Lost update (an isolation problem)' },
        {
          sequence: {
            actors: ['Deposit A', 'Database', 'Deposit B'],
            messages: [
              { from: 'Deposit A', to: 'Database', label: 'read balance: 50' },
              { from: 'Deposit B', to: 'Database', label: 'read balance: 50' },
              { from: 'Deposit A', to: 'Database', label: 'write 50 + 10 = 60', tone: 'ok' },
              { from: 'Deposit B', to: 'Database', label: 'write 50 + 20 = 70', tone: 'bad', note: 'should be 80: the 10 is gone' },
            ],
          },
          caption:
            "One database, no replicas, and money still disappears. Both transactions read before either wrote. Fix: let the database do the sum (`SET balance = balance + 20`), lock the row with `SELECT ... FOR UPDATE`, or run at snapshot isolation in Postgres, which aborts the second writer.",
        },
        { h: 'Write skew (an isolation problem that snapshots do not fix)' },
        {
          sequence: {
            actors: ['Alice', 'Database', 'Bob'],
            messages: [
              { from: 'Alice', to: 'Database', label: 'count on call: 2', tone: 'compare' },
              { from: 'Bob', to: 'Database', label: 'count on call: 2', tone: 'compare' },
              { from: 'Alice', to: 'Database', label: 'take Alice off call' },
              { from: 'Bob', to: 'Database', label: 'take Bob off call' },
              { from: 'Database', to: 'Alice', label: 'committed' },
              { from: 'Database', to: 'Bob', label: 'committed', tone: 'bad', note: 'nobody is on call' },
            ],
          },
          caption:
            "Each transaction checked the rule and wrote a different row, so no row was written twice and snapshot isolation sees no conflict. The rule 'at least one on call' is broken. The same shape appears as two card authorisations that each fit the limit and together exceed it. Fix: serializable, or lock the rows you checked.",
        },
      ],
    },
    {
      id: 'cost',
      title: 'Guarantees against cost',
      blocks: [
        {
          table: {
            head: ['Model', 'What a reader is promised', 'Typical mechanism', 'Extra latency', 'In a partition'],
            rows: [
              ['Linearizable', 'The latest finished write, always', 'Consensus, or one leader with fenced failover', 'A majority round trip: 1 to 2 ms in a region, 10 to 100 ms across regions', 'Minority side refuses'],
              ['Sequential', 'One shared order, possibly behind', 'Replicated log, readers at any position', 'None on reads', 'Writes need the leader'],
              ['Causal', 'Effects never before their causes', 'Version vectors or dependency tracking', 'Small: metadata on each write', 'Keeps working'],
              ['Read your writes', 'Your own writes, at least', 'Session token or sticky routing', 'Sometimes a wait or a hop to the leader', 'Works if your replica is reachable'],
              ['Eventual', 'Copies agree once writes stop', 'Asynchronous replication plus a merge rule', 'None', 'Keeps working'],
            ],
          },
          caption:
            'Latency figures are orders of magnitude for cloud networks, not measurements. The pattern holds: each stronger row waits for more machines.',
        },
        {
          callout:
            "Strength costs in three currencies: latency (you wait for more machines), availability (more machines must be up) and throughput (ordered work goes through one leader). If someone asks for linearizable everywhere, ask which of the three they'd like to pay with.",
          kind: 'rule',
          title: 'The three currencies',
        },
      ],
    },
    {
      id: 'choosing',
      title: 'Choosing per feature',
      blocks: [
        {
          p: "Start from the damage a stale or racing read does. If the answer is 'money moves twice' or 'two people own one thing', you need the top of the ladder for that operation. If it's 'a count is briefly off by a few', you don't.",
        },
        {
          table: {
            head: ['Feature', 'What goes wrong if weak', 'Model to ask for', 'How'],
            rows: [
              ['Balance check before a debit', 'Overspend, double spend', 'Linearizable read, serializable write', 'One transaction on the leader with a row lock or a CHECK constraint'],
              ['Showing the balance', 'User sees a stale figure after paying', 'Read your writes', 'Read from the leader just after a write, a replica otherwise'],
              ['Unique username, idempotency key', 'Two winners', 'Linearizable compare-and-set', 'A unique index on the leader'],
              ['Feed or timeline', 'A post appears a second late', 'Eventual, plus read your writes for the author', 'Replicas and caches; author reads their own post from the leader'],
              ['Comment threads', 'A reply shows before its parent', 'Causal', 'Keep a thread in one partition, or order by parent'],
              ['Like and view counters', 'Count off by a few for a moment', 'Eventual', 'Buffered increments or a CRDT counter'],
              ['Stock, quota, rate limit', 'Oversell', 'Linearizable decrement', 'Atomic conditional update on one leader per key'],
            ],
          },
          caption: 'A counter that only informs can be eventual. A counter that gates a decision is a balance.',
        },
        {
          callout:
            "Take a card payment. The authorisation debits available balance in one transaction on the ledger's primary: that is the only linearizable step, and it is small. The receipt screen reads from the primary for a few seconds. The monthly statement, the spending chart and the merchant's dashboard read from replicas or a warehouse and may be minutes old. One product, four consistency levels, and only one of them is expensive.",
          kind: 'example',
          title: 'One payment, four levels',
        },
        {
          callout:
            "Go operation by operation. For each one say the model, the reason and the price: 'Debits are linearizable because overspend is unrecoverable; that costs a write to the primary and a synchronous standby, about 2 ms. The feed is eventual with read-your-writes for the author, because a second of delay hurts nobody.' Then name the anomaly you're still exposed to and why it's acceptable. That last sentence is what separates a senior answer.",
          kind: 'interview',
          title: 'What to say',
        },
        {
          see: [
            { href: '#/c/replication', label: 'Replication', why: 'Where the stale copies come from, and the fixes for lag.' },
            { href: '#/c/consensus-and-coordination', label: 'Consensus and coordination', why: 'What the top of the ladder is built on, and what it costs.' },
            { href: '#/d/ledger', label: 'Ledger design', why: 'A balance kept correct with one leader, row locks and constraints.' },
          ],
        },
      ],
    },
  ],
  unverified: [
    'Latency figures (1 to 2 ms across zones, about 75 ms across the Atlantic, 10 to 100 ms across regions) are rough orders of magnitude from memory, not measurements.',
    '"Minutes of partition a year" for a well-run cloud region is an illustration, not a published figure.',
    'That causal consistency is about the strongest model that stays available under partition comes from memory of the literature (Mahajan, Alvisi and Dahlin; Bailis et al. on highly available transactions); the exact statement there is narrower.',
    'The grouping of sequential consistency with models that cannot stay fully available in a partition follows the Jepsen consistency map from memory.',
    'CockroachDB and YugabyteDB are grouped with Spanner as "serializable over linearizable storage"; their exact guarantees differ from Spanner\'s (no TrueTime) and were not checked.',
    'That Cassandra and DynamoDB add a consensus round for compare-and-set "at several times the latency" is from memory; no figure was checked.',
    'Postgres `synchronous_commit = remote_apply` behaviour is stated from memory of the documentation.',
  ],
};

export default page;
