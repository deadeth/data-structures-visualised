import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A skip list is a sorted linked list with express lanes stacked on top. Every key is on the bottom level, and a coin flip decides whether a key is also linked into the level above, so each level holds about half the keys of the one below. A search starts on the top level, takes long hops, and drops down a level each time the next hop would overshoot.',
  watch: [
    'The search only moves right or down. It drops a level at the moment the next key on the current level is too big.',
    'Compare the comparisons counter with the key’s position in the bottom row. The difference is what the upper levels saved.',
    'On insert, the coin flips alone decide how tall the new tower is. No other key moves and nothing is rebalanced.',
    'Insert and delete only touch the last node visited on each level. Watch the pointers changed counter: two per level of the tower on insert, one per level on delete.',
    'The same key is often compared again one level down. The textbook algorithm does this, and so does this page.',
    'Towers here stop at 5 levels with a promotion chance of 1/2, which suits a few dozen keys. With thousands of keys the top level fills up and searches slow down. Redis allows 32 levels and LevelDB 12, both with a chance of 1/4.',
  ],
  complexity: [
    { op: 'Search', average: 'O(log n) expected', worst: 'O(n)', note: 'The worst case needs unlucky coin flips, not unlucky input. Sorted inserts are no problem.' },
    { op: 'Insert', average: 'O(log n) expected', worst: 'O(n)', note: 'One search, then two pointer writes per level of the new tower. The average tower is 2 levels at p = 1/2.' },
    { op: 'Delete', average: 'O(log n) expected', worst: 'O(n)', note: 'One search, then one pointer write per level of the tower.' },
    { op: 'Range scan of k keys', average: 'O(log n + k)', worst: 'O(n)', note: 'Find the first key, then walk the bottom level.' },
  ],
  space:
    'O(n) expected. With promotion chance p a key has 1/(1 − p) pointers on average: 2 at p = 1/2, about 1.33 at p = 1/4.',
  usedIn: [
    {
      name: 'Redis sorted sets',
      how: 'A large sorted set (ZSET) is a skip list ordered by score plus a hash table from member to score. The skip list serves range and rank commands such as ZRANGE and ZRANK. The hash table serves ZSCORE in O(1).',
    },
    {
      name: 'LevelDB and RocksDB',
      how: 'The memtable, the in-memory buffer that takes every new write, is a skip list by default. It keeps recent writes sorted so they can be flushed to disk as a sorted file. RocksDB’s version accepts concurrent inserts.',
    },
    {
      name: 'Java ConcurrentSkipListMap',
      how: 'The JDK’s concurrent sorted map. Reads and writes are lock-free, built on compare-and-swap. HBase builds its in-memory store (the MemStore) on it.',
    },
  ],
  reachFor: [
    'A sorted map in memory with many threads writing at once.',
    'You want ordered iteration, range scans or rank queries, with less code than a red-black tree.',
    'A write buffer that must stay sorted, such as the memtable of an LSM tree.',
  ],
  costs: [
    'Extra pointers. Each key carries 1/(1 − p) forward pointers on average, and towers of different heights make allocation less tidy than fixed-size tree nodes.',
    'Poor cache locality. Every hop follows a pointer to a node somewhere else on the heap, so a search pays roughly one cache miss per hop. A B-tree packs many keys into each node and reads them together.',
    'The bound is a probability. O(log n) is what you expect, and a balanced tree is what you pick when you need it guaranteed.',
    'Not a disk structure. One node per key means one random read per hop, so on disk a B+ tree or sorted files do far better.',
  ],
  interview: [
    'One line to open with: a sorted linked list with express lanes, where a coin flip sets each key’s height, so balance comes from randomness and there are no rotations.',
    'Against a red-black or AVL tree: the same O(log n), but expected and not guaranteed. In return an insert changes only the pointers just before the new key. A tree rebalance rotates or recolours nodes on the way back to the root, so writers have to coordinate over a much wider area.',
    'Why it suits concurrency: an insert is a few local pointer swaps, each one a compare-and-swap, bottom level first. A key counts as present once its level 1 link is in. The upper levels are only shortcuts, so they can lag behind without breaking readers.',
    'Against a B+ tree: a B+ tree puts hundreds of keys in a page, so a lookup costs a few page reads or cache misses. A skip list chases one pointer per hop. Pick the skip list for concurrent, write-heavy data in memory, and the B+ tree for indexes on disk.',
    'The Redis example: a sorted set is a skip list plus a hash table. Say why it needs both. The hash table finds a member’s score in O(1), and the skip list keeps members in score order for ranges and ranks.',
    'Know the tuning knob. A lower promotion chance means fewer pointers per key and more comparisons per level. Redis and LevelDB both use 1/4, which costs about 1.33 pointers per key.',
    'In an LSM tree only the memtable is a skip list. It takes sorted inserts cheaply and flushes in key order. The files on disk are sorted tables, which is where the cache-friendly layout matters.',
  ],
};
