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

export const GROUPS = ['Storage and indexes', 'Hashing and distribution', 'Caches and queues', 'Foundations'] as const;

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
    id: 'bloom-filter',
    name: 'Bloom filter',
    group: 'Hashing and distribution',
    blurb: 'A few bits per key that answer "definitely not here" or "probably here".',
    cheat: { lookup: 'O(k) hashes', insert: 'O(k) hashes', remove: 'Not supported', ordered: 'No', pick: 'Skipping disk or network reads for keys that are absent.' },
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
    id: 'graph',
    name: 'Graph traversal',
    group: 'Foundations',
    blurb: 'Nodes and edges, explored breadth-first, depth-first, or by cheapest path.',
    cheat: { lookup: 'O(V + E) to traverse', insert: 'O(1) per edge', remove: 'O(degree)', ordered: 'No', pick: 'Dependencies, routing, social and service networks.' },
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
