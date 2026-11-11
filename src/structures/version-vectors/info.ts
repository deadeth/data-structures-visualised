import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'In multi-leader replication several replicas accept writes for the same key and copy them to each other later, so two clients can change one key at the same time on two replicas. A version vector, one counter per replica, travels with each version and records which writes it has seen. Compare two vectors entry by entry: if one is ahead or level everywhere, it happened after the other and replaces it; if each is ahead somewhere, the writes were concurrent, and the system must keep both or deliberately drop one.',
  watch: [
    'The key is a shopping cart. A write reads the cart at one replica, adds or removes one item and writes it back there. Nothing is sent anywhere until you replicate.',
    'A new version copies the vector of the version the client read and adds one to its own replica\'s entry. Entry B = 1 means "has seen B\'s first write".',
    'Replicate compares every entry, one comparison each. Ahead or level on all three means one version happened before the other and the older is dropped. Ahead on one entry and behind on another means concurrent.',
    'Concurrent versions stay side by side as siblings. In the tour, B adds jam and C adds fig without hearing of each other, and C ends up holding both carts.',
    'Resolve is the application\'s job. For a cart it takes the union of the items, and its vector is the entry-by-entry maximum plus one at the replica that writes the merge. That vector is ahead of both siblings, so the merge replaces them wherever it goes.',
    'Under last write wins, the same two writes produce no siblings. The later timestamp is kept and the other version is dropped in red, with no error to anyone.',
    'C\'s clock runs 3 ticks slow. Its fig is written at real time 17, after B\'s jam at 16, but is stamped t14. Last write wins keeps jam and drops the write that really came last.',
    'Simplified: 3 replicas, one key, a clock that moves one tick per write, replication only when you ask, and a Switch policy button that puts every replica back to v0 so the same writes can be replayed. A real cluster replicates continuously and never resets.',
  ],
  complexity: [
    { op: 'Write at one leader', average: 'O(R)', worst: 'O(R)', note: 'Copy the vector of R entries and raise one. No other replica is asked, so latency is local.' },
    { op: 'Compare two versions', average: 'O(R)', worst: 'O(R)', note: 'One comparison per entry. R is the number of replicas that write, not the size of the data.' },
    { op: 'Receive a version', average: 'O(R)', worst: 'O(S × R)', note: 'Compared with each of the S siblings already held. S is usually 1.' },
    { op: 'Resolve siblings', average: 'O(S × R)', worst: 'O(S × R) + merge', note: 'Entry-by-entry maximum, plus whatever the application\'s merge costs.' },
    { op: 'Last write wins', average: 'O(1)', worst: 'O(1)', note: 'Compare two timestamps. Cheap, and one of the two writes is lost.' },
  ],
  space:
    'One counter per writing replica on every version: 3 small integers here. Dynamo-style stores keep a (node, counter) pair per coordinator that has written the key, and the Dynamo paper truncates the oldest pair once there are about 10. Siblings multiply the space until someone reads and merges them.',
  usedIn: [
    {
      name: 'Amazon Dynamo',
      how: 'The 2007 paper\'s store attaches a vector clock to each version. Concurrent versions are all returned on a read and the client reconciles them. The shopping cart merges by union, so an added item is never lost, but a deleted item can come back.',
    },
    {
      name: 'Riak',
      how: 'Built on Dynamo\'s design. With allow_mult on, concurrent writes become siblings that the client must resolve; Riak 2.0 added dotted version vectors to stop siblings multiplying, and convergent data types (counters, sets, maps) that merge themselves.',
    },
    {
      name: 'CouchDB',
      how: 'Every document has a revision id (_rev). When replication brings in conflicting revisions, CouchDB picks the same winner on every node deterministically, keeps the losers under _conflicts, and leaves the application to merge and delete them. It tracks a revision tree, not a version vector.',
    },
    {
      name: 'Cassandra',
      how: 'Last write wins per cell: every column value carries a timestamp, and on conflict the higher timestamp wins. No siblings and no vectors, so clock skew between writers decides which concurrent write survives.',
    },
    {
      name: 'DynamoDB global tables',
      how: 'In their default, eventually consistent mode, every region takes writes, and concurrent updates to the same item are settled between regions by last writer wins.',
    },
    {
      name: 'Collaborative and offline-first apps',
      how: 'Each device is a leader for its own copy. CouchDB with PouchDB syncs offline edits this way, and CRDT libraries such as Automerge and Yjs merge concurrent edits automatically.',
    },
  ],
  reachFor: [
    'Several datacentres, each taking writes locally, so a user is not paying a cross-ocean round trip on every write and one region can keep working while the link to another is down.',
    'Clients that work offline: a phone or laptop is its own leader and syncs when it reconnects.',
    'Collaborative editing, where every user\'s edits apply locally at once and are merged as they arrive.',
    'Any leaderless or multi-leader store where you need to tell "this write followed that one" apart from "these two raced", so that a race is never resolved silently.',
  ],
  costs: [
    'Conflicts are real and the database cannot merge them for you. Every read path must handle siblings, and every merge needs a rule the business agrees with.',
    'Union merges resurrect deletes: remove an item on one replica, add another on a second, and the union brings the removed item back. Deletes need tombstones, or a data type built for it.',
    'Last write wins is simple and loses data by design. Two concurrent writes always cost one of them, and clock skew means it can be the newer one. Use it only where losing a write is acceptable, or where each key is written once.',
    'Vectors grow with the number of writers. Per-client entries explode, and per-server entries need care (dotted version vectors) to avoid false conflicts and runaway siblings.',
    'Multi-leader breaks things a single leader gives for free: unique constraints, auto-increment ids and "check then write" invariants cannot be enforced across leaders without coordination.',
    'If you can tolerate a single leader per key, do. Conflict avoidance, routing all of a user\'s writes to one home leader, is the most common answer in practice.',
  ],
  interview: [
    'Why multi-leader: write latency and availability across datacentres, offline clients, and collaborative editing. Then say the price straight away: concurrent writes to the same key, which a single leader never has.',
    'Topologies: a ring or a star passes each write along through other nodes, so one failed node can cut the flow. All-to-all is more resilient, but writes can arrive out of order, which is one more reason to track causality rather than trust arrival order.',
    'Happens-before: write B happened after write A if B\'s client had seen A, directly or through other writes. If neither saw the other, they are concurrent, whatever the clocks say. Concurrency is about knowledge, not time.',
    'Version vectors versus vector clocks versus Lamport timestamps: a version vector has one counter per replica and moves only when a replica writes the data. A vector clock has one counter per process and moves on every event, including sends and receives. A Lamport timestamp is a single counter: it gives a total order that respects causality, but it cannot tell you that two writes were concurrent.',
    'Detect, then resolve. Version vectors only detect. Then pick: keep siblings for the application to merge, merge automatically with a CRDT, or drop one with last write wins and accept the loss.',
    'Last write wins in one sentence: "It picks the larger timestamp and silently discards the other write, so concurrent writes lose data, and with clock skew the write that really came last can be the one discarded." Cassandra works this way per cell.',
    'Conflict avoidance first: give each user or record a home leader and route its writes there. Conflicts then happen only when that leader fails over.',
    'Custom merge: on read (Dynamo and Riak hand siblings to the client) or on write (a conflict handler runs as the change arrives). Name the rule: union for a cart, max for a high score, a field-by-field merge for a profile.',
    'CRDTs are data types whose merge is built in: counters, sets, maps and text sequences that converge to the same value whatever order the updates arrive in. Riak\'s data types, Automerge and Yjs use them.',
  ],
};
