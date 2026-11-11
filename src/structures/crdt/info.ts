import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A CRDT (conflict-free replicated data type) lets every replica accept writes on its own, with no leader and no lock, and still guarantees that replicas which have seen the same updates hold the same state. The trick is in the shape of the state: each replica only adds information, and merge combines two states by taking the larger of each part. Merge can then run in any order, any number of times, and the answer is the same.',
  watch: [
    'The counter is first in each row. P[A] counts the increments made at A, P[B] those made at B, and so on. A replica only ever writes its own slot. The value is sum(P) − sum(N).',
    'In the tour A and B each increment once, starting from 2. Each reads 3. A merges B and takes the larger number slot by slot: it reads 4. A plain counter with last write wins would have kept 3 and lost one increment.',
    'Merge shows every comparison: 6 counter slots, then one per entry the other replica holds. It never lowers a number and never deletes an entry, which is why a stale or repeated merge does no harm.',
    'In the set, every add gets a dot: the replica\'s name and its next number, such as A2. Remove marks the dots it has seen, in red, and keeps them as tombstones.',
    'B removes 42 while A adds 42 again. B\'s remove covers A1, the dot it saw. A\'s add made A2, which B never saw. When B merges A, A1 stays removed and A2 arrives live: 42 is back. That is add wins.',
    'Sync merges all six ordered pairs. Several find nothing new, and the replicas end identical whatever order you merge in. Try merging the same pair twice: the second merge changes nothing.',
    'Tombstones pile up. This page holds at most 5 dots in the whole system. Collect tombstones drops a dot only once all three replicas have seen it removed.',
    'Simplified here: 3 fixed replicas, merges that copy a whole state instantly with no network, and tombstones kept per dot. Real sets such as Riak\'s use a version vector to avoid most tombstones.',
  ],
  complexity: [
    { op: 'Increment or decrement', average: 'O(1)', worst: 'O(1)', note: 'One slot, local. No other replica is contacted.' },
    { op: 'Read the counter', average: 'O(R)', worst: 'O(R)', note: 'Sum of 2R slots for R replicas.' },
    { op: 'Add or remove', average: 'O(1) add, O(E) remove', worst: 'O(E)', note: 'Remove scans the entries for the element. A real set keeps a map from element to its dots.' },
    { op: 'Merge (state-based)', average: 'O(R + E)', worst: 'O(R + E)', note: 'Every slot and every entry of the other state is compared. The whole state is sent, which is why delta-state CRDTs send only recent changes.' },
    { op: 'Sync of R replicas, all pairs', average: 'O(R² (R + E))', worst: 'O(R² (R + E))', note: 'Gossip to a few peers at a time is the usual way; any connected pattern converges.' },
  ],
  space:
    'A PN-counter holds 2 numbers per replica that has ever written: 3 replicas means 6 slots, 100 replicas means 200, even when the value is 0. The set here holds an entry for every add ever made, live or removed, until the tombstone is collected. Removing does not shrink it.',
  usedIn: [
    {
      name: 'Riak KV',
      how: 'Riak 2.0 added data types: counters, sets, maps, registers, flags and later HyperLogLogs. Clients send operations, and Riak converges them with state-based merges behind the scenes. If an element is added and removed at the same time, the add wins.',
    },
    {
      name: 'Redis Enterprise Active-Active',
      how: 'A database written in several regions at once. Sets behave as an OR-set: a remove only removes what it has seen, and otherwise the add wins. Strings are last write wins, except when used as counters with INCR or INCRBY, where every region\'s increments are summed.',
    },
    {
      name: 'Automerge',
      how: 'A CRDT library for JSON-like documents, built for local-first apps where each device edits offline and changes merge later.',
    },
    {
      name: 'Yjs',
      how: 'A CRDT framework for shared editing of text, arrays and maps, used to build collaborative editors that sync peer to peer or through a server.',
    },
  ],
  reachFor: [
    'Writes in several regions or on devices that go offline, where waiting for a leader or a quorum is too slow or impossible.',
    'Counters that must not lose updates under concurrency: likes, views, active sessions per region.',
    'Sets where a concurrent add should beat a remove: a shopping cart, a list of followers, a tag set.',
    'Collaborative editing and local-first apps, through a sequence CRDT library such as Yjs or Automerge.',
  ],
  costs: [
    'Cannot hold an invariant across replicas. "Balance never below zero" needs coordination: two replicas can each see 10 and each allow a withdrawal of 10, and the merged balance is −10. Use a single leader, a consensus log or escrow (split the allowance between replicas).',
    'Metadata grows. A counter keeps a slot for every replica that ever wrote. A set keeps a tombstone for every remove until every replica has seen it, and finding that out needs knowledge of all replicas.',
    'The merge rule is the meaning. Add wins is right for a cart and wrong for a ban list, where remove should win. Choose the type for the behaviour you want; you cannot change it after the fact.',
    'Eventual, not strong, consistency. Two replicas can read different values until they merge. Nothing here helps a read that must see the latest write.',
    'State-based merge ships the whole state. For large objects send deltas, or use operation-based CRDTs, which need reliable, exactly-once, causal delivery instead.',
  ],
  interview: [
    'Define it: "Each replica takes writes locally. Merge is commutative, associative and idempotent, so replicas that have seen the same updates converge, whatever the order or the duplicates." That is strong eventual consistency.',
    'The join-semilattice in plain words: states can only grow, and any two states have a smallest state that contains both. Merge computes it. A per-slot max and a set union are the two everyday examples.',
    'State-based vs operation-based: state-based CRDTs send the whole state and tolerate lost, duplicated and reordered messages. Operation-based CRDTs send only the update, such as "+1 at A", which is small, but each must arrive exactly once and in causal order.',
    'Why a counter needs one slot per replica: with one shared number, A and B both read 5, both write 6, and one increment is lost. With slots, A writes P[A] and B writes P[B], and the merge keeps both.',
    'Add wins, explained by dots: every add gets a unique tag, and a remove only removes the tags it has seen. A concurrent add has a tag the remover never saw, so it survives.',
    'Garbage collection is the hard part: a tombstone or a departed replica\'s slot can only go once every replica has seen it. Real systems avoid most tombstones with a version vector (the ORSWOT design) and compact rarely.',
    'Say what CRDTs cannot do: uniqueness, "never below zero", or any rule that compares writes on different replicas. Those need a leader or consensus, at least for that operation.',
    'Sequence CRDTs for text give every character a unique, ordered identifier, and a delete leaves a tombstone. Concurrent inserts at the same place are ordered by a fixed tie-break, such as replica id, so every replica builds the same text. RGA, Logoot, LSEQ and YATA (behind Yjs) are examples. The cost is metadata per character, which libraries compress hard.',
    'CRDTs vs operational transformation: OT sends operations and rewrites each against concurrent ones, which in practice needs a central server to fix the order, as Google Docs does. CRDTs make concurrent operations commute by design, so they can sync peer to peer and offline, at the cost of more metadata.',
  ],
};
