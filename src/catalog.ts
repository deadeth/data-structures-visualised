import type { StructureDef } from './core/types';

export interface CatalogEntry {
  id: string;
  name: string;
  group: string;
  /** One line under the title and in the sidebar tooltip. */
  blurb: string;
  /** Row in the cheat sheet on the home page. */
  cheat: { lookup: string; insert: string; remove: string; ordered: string; pick: string };
}

export const GROUPS = ['Storage and indexes', 'Hashing and distribution', 'Caches and queues', 'Transactions', 'Replication and consensus', 'Data processing', 'Networking', 'Reliability patterns', 'Foundations', 'Sorting and searching'] as const;

/**
 * Every structure the site covers, in display order. A structure's page goes
 * live as soon as src/structures/<id>/index.ts exists; nothing else needs
 * registering.
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'b-plus-tree',
    name: 'B+ tree',
    group: 'Storage and indexes',
    blurb: 'The index behind almost every relational database. Wide nodes, few levels, sorted leaves.',
    cheat: { lookup: 'O(log n)', insert: 'O(log n)', remove: 'O(log n)', ordered: 'Yes', pick: 'Database indexes and range queries on disk.' },
  },
  {
    id: 'lsm-tree',
    name: 'LSM tree',
    group: 'Storage and indexes',
    blurb: 'Buffer writes in memory, flush sorted files, merge them later. Built for write-heavy stores.',
    cheat: { lookup: 'O(log n) per level', insert: 'O(1) amortised', remove: 'O(1) tombstone', ordered: 'Yes', pick: 'Write-heavy stores such as Cassandra and RocksDB.' },
  },
  {
    id: 'skip-list',
    name: 'Skip list',
    group: 'Storage and indexes',
    blurb: 'A sorted linked list with express lanes, balanced by coin flips instead of rotations.',
    cheat: { lookup: 'O(log n) expected', insert: 'O(log n) expected', remove: 'O(log n) expected', ordered: 'Yes', pick: 'In-memory sorted sets: Redis ZSET, LSM memtables.' },
  },
  {
    id: 'trie',
    name: 'Trie',
    group: 'Storage and indexes',
    blurb: 'A tree keyed by characters. Words that share a prefix share a path.',
    cheat: { lookup: 'O(k) key length', insert: 'O(k)', remove: 'O(k)', ordered: 'Yes', pick: 'Autocomplete, prefix search, IP routing tables.' },
  },
  {
    id: 'append-log',
    name: 'Append-only log',
    group: 'Storage and indexes',
    blurb: 'An array that only grows at the end. Readers keep their own place, so many can read and replay.',
    cheat: { lookup: 'O(1) by offset', insert: 'O(1) append', remove: 'Oldest segment only', ordered: 'By arrival, per partition', pick: 'Events for many readers, with replay.' },
  },
  {
    id: 'column-store',
    name: 'Column-oriented storage',
    group: 'Storage and indexes',
    blurb: 'Store each column on its own, Parquet style. Queries read only the columns they need and skip row groups.',
    cheat: { lookup: 'Reads only needed columns', insert: 'Batched into new files', remove: 'Rewrite or delete marker', ordered: 'By the chosen sort column', pick: 'Analytics over a few columns of many rows.' },
  },
  {
    id: 'inverted-index',
    name: 'Search indexes',
    group: 'Storage and indexes',
    blurb: 'Each word points to a sorted list of the documents that hold it. The index behind Lucene and Elasticsearch.',
    cheat: { lookup: 'O(log t) per segment + postings', insert: 'Buffered; searchable after refresh', remove: 'Tombstone; space back on merge', ordered: 'Terms sorted; hits by score', pick: 'Full-text search: "contains this word", ranked.' },
  },
  {
    id: 'geo-index',
    name: 'Geospatial indexes',
    group: 'Storage and indexes',
    blurb: 'Geohashes and quadtrees: turn two coordinates into one key, so an index that sorts can find what is nearby.',
    cheat: { lookup: 'O(log n) per cell, 9 cells', insert: 'O(log n)', remove: 'Exact shapes; filter by distance', ordered: 'Z-order (geohash), Hilbert (S2)', pick: 'Nearby drivers, shops or anything with a location.' },
  },
  {
    id: 'hash-table',
    name: 'Hash table',
    group: 'Hashing and distribution',
    blurb: 'Turn the key into an array index. Constant-time lookups, as long as the table stays roomy.',
    cheat: { lookup: 'O(1) average', insert: 'O(1) amortised', remove: 'O(1) average', ordered: 'No', pick: 'Exact-match lookups, caches, joins, deduplication.' },
  },
  {
    id: 'consistent-hashing',
    name: 'Consistent hash ring',
    group: 'Hashing and distribution',
    blurb: 'Place servers and keys on one ring so that adding a server moves only a slice of the keys.',
    cheat: { lookup: 'O(log N) servers', insert: 'Moves about K/N keys', remove: 'Moves about K/N keys', ordered: 'No', pick: 'Sharding keys across servers that come and go.' },
  },
  {
    id: 'partitioning',
    name: 'Partitioning and secondary indexes',
    group: 'Hashing and distribution',
    blurb: 'Split a table across nodes by key range or hash, and index it locally or globally. Each choice moves the cost.',
    cheat: { lookup: '1 partition by key', insert: '1 partition, 2 with a global index', remove: 'Range scans (hash) or even load (range)', ordered: 'By key within range partitions', pick: 'Data or writes too big for one node.' },
  },
  {
    id: 'bloom-filter',
    name: 'Bloom filter',
    group: 'Hashing and distribution',
    blurb: 'A few bits per key that answer "definitely not here" or "probably here".',
    cheat: { lookup: 'O(k) hashes', insert: 'O(k) hashes', remove: 'Not supported', ordered: 'No', pick: 'Skipping disk or network reads for keys that are absent.' },
  },
  {
    id: 'simhash',
    name: 'SimHash',
    group: 'Hashing and distribution',
    blurb: 'A fingerprint that stays close when the text stays close. Near-duplicate pages differ in only a few bits.',
    cheat: { lookup: 'O(1) to compare two', insert: 'O(words)', remove: 'Not shown', ordered: 'No', pick: 'Spotting near-duplicate pages in a crawl.' },
  },
  {
    id: 'lru-cache',
    name: 'LRU cache',
    group: 'Caches and queues',
    blurb: 'A hash map for speed and a linked list for recency. Evicts whatever was used longest ago.',
    cheat: { lookup: 'O(1)', insert: 'O(1)', remove: 'O(1)', ordered: 'By recency', pick: 'Any bounded cache in front of something slow.' },
  },
  {
    id: 'heap',
    name: 'Binary heap',
    group: 'Caches and queues',
    blurb: 'A tree packed into an array that always knows its smallest item.',
    cheat: { lookup: 'O(1) for the minimum', insert: 'O(log n)', remove: 'O(log n) for the minimum', ordered: 'Partially', pick: 'Priority queues, top-K, timers, merging sorted runs.' },
  },
  {
    id: 'queue',
    name: 'Ring buffer queue',
    group: 'Caches and queues',
    blurb: 'A fixed array with a head and a tail that wrap around. A full buffer is how backpressure starts.',
    cheat: { lookup: 'O(1) at the head', insert: 'O(1)', remove: 'O(1)', ordered: 'By arrival', pick: 'Bounded buffers between a producer and a consumer.' },
  },
  {
    id: 'token-bucket',
    name: 'Token bucket',
    group: 'Caches and queues',
    blurb: 'A rate limiter in two numbers. Tokens drip in at a steady rate; a request takes one or is turned away.',
    cheat: { lookup: 'O(1) check', insert: 'O(1) lazy refill', remove: 'O(1) take', ordered: 'No', pick: 'Rate limits that allow a short burst and hold a steady average.' },
  },
  {
    id: 'crawl-frontier',
    name: 'Crawl frontier',
    group: 'Caches and queues',
    blurb: 'Priority queues in front, one queue per host behind, and a heap of next allowed times.',
    cheat: { lookup: 'O(1) to see if anything is due', insert: 'O(1)', remove: 'O(log B) for B back queues', ordered: 'By priority, then by host delay', pick: 'Web crawlers.' },
  },
  {
    id: 'cache-strategies',
    name: 'Cache read and write strategies',
    group: 'Caches and queues',
    blurb: 'How a cache and its database stay in step: cache-aside, write-through, write-behind and write-around.',
    cheat: { lookup: 'Hit: 1 cache read', insert: 'Per strategy: 1 or 2 writes', remove: 'Freshness or durability', ordered: 'No', pick: 'Read-heavy data that can be a little stale.' },
  },
  {
    id: 'mvcc',
    name: 'Isolation levels and MVCC',
    group: 'Transactions',
    blurb: 'Writes add versions, reads pick the newest their snapshot may see. Readers and writers never block each other.',
    cheat: { lookup: 'O(versions) walk', insert: 'O(1) append, row lock', remove: 'Old versions until vacuum', ordered: 'By transaction id', pick: 'Consistent reads beside writes.' },
  },
  {
    id: 'two-phase-locking',
    name: 'Serializability: 2PL and SSI',
    group: 'Transactions',
    blurb: 'Two ways to make transactions serializable: lock and wait, or run on a snapshot and abort at commit.',
    cheat: { lookup: '2PL: shared lock; SSI: snapshot, never waits', insert: '2PL: exclusive lock; SSI: private, checked at commit', remove: 'Waits and deadlocks, or aborts and retries', ordered: 'As if one at a time', pick: 'Rules that span rows, such as at least one on call.' },
  },
  {
    id: 'two-phase-commit',
    name: 'Two-phase commit',
    group: 'Transactions',
    blurb: 'Prepare everywhere, then commit everywhere. All or nothing across databases, but a lost coordinator blocks.',
    cheat: { lookup: '2 round trips', insert: '2n + 1 forced writes', remove: 'Availability: blocks if the coordinator dies', ordered: 'Atomic, not ordered', pick: 'Atomic writes across shards you control.' },
  },
  {
    id: 'leader-replication',
    name: 'Single-leader replication',
    group: 'Replication and consensus',
    blurb: 'One leader takes every write and ships its log to followers. Fast reads, lag, and failover risks.',
    cheat: { lookup: '1 replica, maybe stale', insert: 'Leader + 0, 1 or all acks', remove: 'Async: writes at failover', ordered: 'One log order', pick: 'Read scaling and failover.' },
  },
  {
    id: 'version-vectors',
    name: 'Write conflicts and version vectors',
    group: 'Replication and consensus',
    blurb: 'Several leaders take writes at once. One counter per replica tells a later write from a concurrent one.',
    cheat: { lookup: 'O(R) to compare two versions', insert: 'O(R), local to one leader', remove: 'Siblings to merge, or a lost write', ordered: 'Causal only', pick: 'Multi-region or offline writes.' },
  },
  {
    id: 'crdt',
    name: 'CRDTs',
    group: 'Replication and consensus',
    blurb: 'Replicas take writes on their own and always converge: merge keeps the larger of every part.',
    cheat: { lookup: 'O(R) read, local', insert: 'O(1) local write', remove: 'Invariants; metadata grows', ordered: 'None; converges in any order', pick: 'Multi-region or offline writes.' },
  },
  {
    id: 'quorum',
    name: 'Quorum reads and writes',
    group: 'Replication and consensus',
    blurb: 'Leaderless replication: write to W of N replicas, read from R, and R + W > N makes the two overlap.',
    cheat: { lookup: 'R replies, newest version wins', insert: 'W acks of N', remove: 'Last write wins drops concurrent writes', ordered: 'No: no single order of writes', pick: 'Writes that must survive replicas being down; tunable per request.' },
  },
  {
    id: 'raft',
    name: 'Raft consensus',
    group: 'Replication and consensus',
    blurb: 'Elect one leader per term, copy its log to the others, and commit once a majority holds an entry.',
    cheat: { lookup: '1 round trip (read index)', insert: '1 round trip to a majority', remove: 'Availability on the minority side', ordered: 'Total order, one log', pick: 'Small, critical state: config, locks, metadata.' },
  },
  {
    id: 'mapreduce',
    name: 'MapReduce and batch joins',
    group: 'Data processing',
    blurb: 'Map to key and value, shuffle each key to one reducer, sorted, and reduce. Joins work the same way.',
    cheat: { lookup: 'A full scan of the input', insert: 'Append new input, re-run', remove: 'Latency: minutes, not ms', ordered: 'Sorted by key per reducer', pick: 'Large batch aggregates and joins over immutable input.' },
  },
  {
    id: 'stream-joins',
    name: 'Stream processing and joins',
    group: 'Data processing',
    blurb: 'Join and count events as they arrive, by when they happened. Keyed state, watermarks, late data.',
    cheat: { lookup: 'O(1) local state per event', insert: 'State: rate × window', remove: 'Matches outside the window', ordered: 'Event time, via watermarks', pick: 'Joins and counts over live events.' },
  },
  {
    id: 'stream-checkpoints',
    name: 'Exactly-once: Flink checkpoints',
    group: 'Data processing',
    blurb: 'Barriers flow with the records; each task saves its state as one passes. Restore, rewind, replay.',
    cheat: { lookup: 'O(1) per record', insert: 'O(state) per checkpoint', remove: 'Replay since last checkpoint', ordered: 'Per partition', pick: 'Stateful streams that must survive crashes.' },
  },
  {
    id: 'tcp',
    name: 'TCP and UDP',
    group: 'Networking',
    blurb: 'How TCP turns a lossy network into an ordered, reliable stream, and what UDP gives up to be fast.',
    cheat: { lookup: '1 round trip to connect', insert: 'Window per round trip', remove: 'UDP: delivery and order', ordered: 'TCP yes, UDP no', pick: 'TCP by default; UDP when latency beats completeness.' },
  },
  {
    id: 'realtime-push',
    name: 'Long polling, SSE and WebSockets',
    group: 'Networking',
    blurb: 'Four ways a server gets news to a client: poll, hold the request, stream events, or open a two-way socket.',
    cheat: { lookup: 'Delay: poll interval, or none', insert: '1 request per poll or message; 1 frame', remove: 'Open connections held per client', ordered: 'In order; SSE resumes by event id', pick: 'SSE for feeds, WebSocket for chat and games.' },
  },
  {
    id: 'load-balancing',
    name: 'Load balancing',
    group: 'Networking',
    blurb: 'One address in front of many servers. A policy picks who gets each request; health checks pick who may.',
    cheat: { lookup: 'O(1) to O(n) per pick', insert: 'Add a server: hash mod n moves most users', remove: 'Lost in-flight requests on a failure', ordered: 'No', pick: 'Spreading requests over a pool of servers.' },
  },
  {
    id: 'serialization',
    name: 'Serialisation and schema evolution',
    group: 'Networking',
    blurb: 'Protobuf, Avro and JSON byte by byte, and how a schema changes without breaking old or new readers.',
    cheat: { lookup: 'O(n) decode, skip unknown fields', insert: 'O(n) encode, about 1 byte per key', remove: 'Readability without the schema', ordered: 'Protobuf by number; Avro by schema order', pick: 'Data shared across services and versions.' },
  },
  {
    id: 'outbox',
    name: 'Transactional outbox',
    group: 'Reliability patterns',
    blurb: 'Write the change and its event in one transaction; a relay publishes later. Nothing lost, duplicates possible.',
    cheat: { lookup: '1 indexed id check per event', insert: '1 local transaction', remove: 'Gives up exactly-once and adds delay', ordered: 'Per aggregate, by partition key', pick: 'A service must publish an event for every change.' },
  },
  {
    id: 'saga',
    name: 'Sagas',
    group: 'Reliability patterns',
    blurb: 'A business transaction across services as local steps, each undone by a compensation if a later step fails.',
    cheat: { lookup: 'Read the saga log row', insert: '1 local txn per step', remove: 'Isolation', ordered: 'Steps in order, undone in reverse', pick: 'Multi-service workflows: payments, orders, bookings.' },
  },
  {
    id: 'idempotency-keys',
    name: 'Idempotency keys',
    group: 'Reliability patterns',
    blurb: 'One key per payment, stored with the payment in one transaction, so a retried request is answered, not repaid.',
    cheat: { lookup: '1 unique-index probe per request', insert: '1 key row in the same transaction', remove: 'Storage for the window; cannot fix bad keys', ordered: 'Per key: the first commit wins', pick: 'Any retried POST that moves money.' },
  },
  {
    id: 'retries-breaker',
    name: 'Retries, backoff and circuit breakers',
    group: 'Reliability patterns',
    blurb: 'How callers survive a failing service without making it worse: backoff with jitter, breakers, budgets.',
    cheat: { lookup: 'O(1) per call', insert: 'O(1) per retry', remove: 'Fails some calls fast', ordered: 'No', pick: 'Any call over a network to a service that can fail.' },
  },
  {
    id: 'stack',
    name: 'Stack',
    group: 'Foundations',
    blurb: 'Last in, first out. Everything happens at one end.',
    cheat: { lookup: 'O(1) at the top', insert: 'O(1) amortised', remove: 'O(1)', ordered: 'Newest first', pick: 'Undo, call stacks, parsing, depth-first search.' },
  },
  {
    id: 'fifo-queue',
    name: 'Queue',
    group: 'Foundations',
    blurb: 'First in, first out. Join at the back, leave from the front.',
    cheat: { lookup: 'O(1) at the front', insert: 'O(1)', remove: 'O(1)', ordered: 'By arrival', pick: 'Work that must be handled in the order it arrived.' },
  },
  {
    id: 'priority-queue',
    name: 'Priority queue',
    group: 'Foundations',
    blurb: 'The most urgent item leaves first, whenever it arrived.',
    cheat: { lookup: 'O(1) for the most urgent', insert: 'O(n) sorted array, O(log n) heap', remove: 'O(1) sorted array, O(log n) heap', ordered: 'By priority', pick: 'Schedulers, timers, shortest-path search.' },
  },
  {
    id: 'linked-list',
    name: 'Linked list',
    group: 'Foundations',
    blurb: 'Nodes joined by pointers. Cheap to splice, slow to search.',
    cheat: { lookup: 'O(n)', insert: 'O(1) at the ends', remove: 'O(1) given the node', ordered: 'By insertion', pick: 'A building block inside LRU caches, queues and hash chains.' },
  },
  {
    id: 'bst',
    name: 'Binary search tree',
    group: 'Foundations',
    blurb: 'Smaller keys go left, larger go right. Fast when balanced, a linked list when not.',
    cheat: { lookup: 'O(log n), O(n) worst', insert: 'O(log n), O(n) worst', remove: 'O(log n), O(n) worst', ordered: 'Yes', pick: 'The baseline that shows why balancing matters.' },
  },
  {
    id: 'avl-tree',
    name: 'AVL tree',
    group: 'Foundations',
    blurb: 'A binary search tree that rotates after every change to stay balanced.',
    cheat: { lookup: 'O(log n)', insert: 'O(log n)', remove: 'O(log n)', ordered: 'Yes', pick: 'In-memory ordered maps with guaranteed lookups.' },
  },
  {
    id: 'red-black-tree',
    name: 'Red-black tree',
    group: 'Foundations',
    blurb: 'A binary search tree kept roughly balanced by colouring nodes red or black and fixing the colours after each change.',
    cheat: { lookup: 'O(log n)', insert: 'O(log n), at most 2 rotations', remove: 'O(log n), at most 3 rotations', ordered: 'Yes', pick: 'In-memory ordered maps and sets with many updates.' },
  },
  {
    id: 'graph',
    name: 'Graph traversal',
    group: 'Foundations',
    blurb: 'Nodes and edges, explored breadth-first, depth-first, or by cheapest path.',
    cheat: { lookup: 'O(V + E) to traverse', insert: 'O(1) per edge', remove: 'O(degree)', ordered: 'No', pick: 'Dependencies, routing, social and service networks.' },
  },
  {
    id: 'binary-search',
    name: 'Binary search',
    group: 'Sorting and searching',
    blurb: 'Halve a sorted range until the key is found or there is nowhere left to look.',
    cheat: { lookup: 'O(log n)', insert: 'Needs sorted input', remove: 'O(1) extra space', ordered: 'Yes: input must be', pick: 'Any lookup or boundary in sorted data: index pages, SSTable blocks, offsets.' },
  },
  {
    id: 'merge-lists',
    name: 'Merging sorted lists',
    group: 'Sorting and searching',
    blurb: 'Two sorted lists become one by always taking the smaller front item. With a heap, k lists do the same.',
    cheat: { lookup: 'O(n + m), or O(n log k)', insert: 'O(n + m) output', remove: 'Stable: ties keep order', ordered: 'Yes: sorted in, sorted out', pick: 'Merge sort, LSM compaction, sort-merge joins, combining sorted shards.' },
  },
  {
    id: 'merge-sort',
    name: 'Merge sort',
    group: 'Sorting and searching',
    blurb: 'Split in half, sort each half, merge. The same cost on every input.',
    cheat: { lookup: 'O(n log n) always', insert: 'O(n) extra space', remove: 'Stable', ordered: 'Output sorted', pick: 'Stable sorts, linked lists, and data too big for memory (external sort).' },
  },
  {
    id: 'quicksort',
    name: 'Quicksort',
    group: 'Sorting and searching',
    blurb: 'Pick a pivot, put smaller items left and larger right, then sort each side.',
    cheat: { lookup: 'O(n log n) typical, O(n²) worst', insert: 'O(log n) stack', remove: 'Not stable', ordered: 'Output sorted', pick: 'In-memory sorting of arrays when stability does not matter.' },
  },
  {
    id: 'insertion-sort',
    name: 'Insertion sort',
    group: 'Sorting and searching',
    blurb: 'Take each item in turn and slide it left to its place. Slow in general, fast on nearly sorted data.',
    cheat: { lookup: 'O(n²), O(n) if nearly sorted', insert: 'O(1) extra space', remove: 'Stable', ordered: 'Output sorted', pick: 'Small or nearly sorted arrays; the base case inside faster sorts.' },
  },
  {
    id: 'quickselect',
    name: 'Quickselect and top k',
    group: 'Sorting and searching',
    blurb: 'Find the k-th smallest, or the k largest, without sorting everything.',
    cheat: { lookup: 'O(n) typical for the k-th', insert: 'O(n log k) with a heap of k', remove: 'O(k) space for the heap', ordered: 'No: only the cut is placed', pick: 'Medians, percentiles, leaderboards and top-k over a stream.' },
  },
];

const loaders = import.meta.glob<{ default: StructureDef }>('./structures/*/index.ts');

export function isReady(id: string): boolean {
  return `./structures/${id}/index.ts` in loaders;
}

export async function loadStructure(id: string): Promise<StructureDef> {
  const loader = loaders[`./structures/${id}/index.ts`];
  if (!loader) throw new Error(`No structure called "${id}"`);
  return (await loader()).default;
}

export function entry(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id);
}
