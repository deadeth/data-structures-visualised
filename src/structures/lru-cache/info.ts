import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'An LRU cache holds a fixed number of items and, when it is full, throws out the one that was used longest ago. A hash map finds any item in one step, and a doubly linked list keeps the items in order of last use. Each map entry points at its list node, so a hit can be moved to the front without searching for it.',
  watch: [
    'A get never walks the list. The map hands over a pointer to the node, and the list is only rewired around it.',
    'Moving a node to the head is always six pointer writes: two to unlink it, two for its own pointers, two to hook it in. The count does not grow with the cache.',
    'The tail is always the next victim. Watch "next to be evicted" change after every hit.',
    'The map row is in no useful order and the list row has no fast lookup. Each covers what the other lacks.',
    'After an eviction, a get for the evicted key misses. The cache has no memory of what it threw away.',
  ],
  complexity: [
    { op: 'Get', average: 'O(1)', worst: 'O(n)', note: 'One hash lookup, then a fixed six pointer writes on a hit. The worst case belongs to the hash map, when many keys collide.' },
    { op: 'Put, existing key', average: 'O(1)', worst: 'O(n)', note: 'The same work as a hit: look up, overwrite, move to the head.' },
    { op: 'Put, new key', average: 'O(1)', worst: 'O(n)', note: 'Evict the tail if full, then link a new node at the head. Rehashing a growing map is amortised.' },
    { op: 'Pick the victim', average: 'O(1)', worst: 'O(1)', note: 'It is always the tail. No scan and no timestamps to compare.' },
  ],
  space:
    'O(capacity). Each item carries two list pointers and a map entry on top of its key and value. For small values that bookkeeping can be larger than the data.',
  usedIn: [
    {
      name: 'Memcached',
      how: 'Keeps a separate LRU for each slab class, a group of items of similar size. Newer versions split each one into hot, warm and cold segments, which protects popular items from one-off reads and eases contention on the list lock.',
    },
    {
      name: 'Redis',
      how: 'With maxmemory set and an LRU policy, Redis samples a few keys and evicts the one idle longest. It stores a small clock value per key, so it needs no linked list. LFU policies are offered as an alternative.',
    },
    {
      name: 'Linux page cache',
      how: 'File pages sit on an active list and an inactive list. A page is promoted only if it is used again while inactive, and reclaim takes pages from the inactive end. It is an approximation of LRU, not an exact one.',
    },
    {
      name: 'Database buffer pools',
      how: 'MySQL InnoDB uses an LRU list with midpoint insertion: a page read from disk enters partway down and moves to the front only if it is used again. PostgreSQL uses clock sweep, a cheaper stand-in for LRU with a small usage count per buffer.',
    },
    {
      name: 'CPU caches',
      how: 'Each cache set tracks which of its few entries was used least recently, often with a pseudo-LRU scheme that needs only a few bits per set.',
    },
    {
      name: 'CDNs and HTTP caches',
      how: 'Edge caches hold a bounded store of objects. Varnish and the NGINX proxy cache both remove the least recently used objects when storage runs out, alongside TTL expiry.',
    },
    {
      name: 'Java LinkedHashMap',
      how: 'Built with access order turned on and removeEldestEntry overridden, it is an LRU cache in a few lines. It is this same design: a hash table with a doubly linked list threaded through its entries.',
    },
    {
      name: 'Python functools.lru_cache',
      how: 'Memoises function calls. Inside CPython it is a dict plus a circular doubly linked list, the same pairing as on this page.',
    },
  ],
  reachFor: [
    'A bounded cache in front of something slow, where items used recently are likely to be used again.',
    'You want an eviction rule that is easy to explain and costs O(1) per operation.',
    'Small in-process caches: sessions, parsed templates, DNS answers, prepared statements, memoised function results.',
  ],
  costs: [
    'Every read is also a write, because a hit rewires the list. With many threads the lock around the list becomes the bottleneck, which is why large systems sample, use a clock hand, or batch the reordering.',
    'Two pointers and a map entry per item. With millions of small values the bookkeeping can outweigh the data.',
    'Recency is not frequency. One pass over cold data pushes out everything hot. LFU, 2Q, ARC and midpoint insertion all guard against that.',
    'It bounds the number of items, not their age or their size. Stale data still needs a TTL, and items of very different sizes need a byte budget instead of an item count.',
  ],
  interview: [
    'Say why it takes two structures. A hash map alone finds a key in O(1) but has no order, so finding the oldest item means scanning all of them. A linked list alone keeps the order but needs an O(n) walk to find a key. Keeping a pointer to the list node in the map gives O(1) for both.',
    'Why doubly linked? Unlinking a node from the middle needs its predecessor. A prev pointer makes that O(1). With a singly linked list you would have to walk from the head to find it.',
    'Choose the eviction policy out loud. LRU fits when recent use predicts the next use. LFU keeps items that stay popular over a long time but is slow to forget old favourites. A TTL is about staleness, not space, and is usually combined with one of the other two.',
    'Bring up cache stampede. When a hot key expires or is evicted, every request for it misses at once and they all hit the database. Let one caller rebuild the value while the others wait or are served the stale copy, add jitter to TTLs so keys do not expire together, or refresh hot keys before they expire.',
    'A table scan or a backup job touches every key once and can flush a plain LRU of everything useful. Midpoint insertion, 2Q and ARC make a new item prove itself with a second hit before it can displace the hot set.',
    'Exact LRU needs a lock on every read, because every read reorders the list. That is why Redis samples, PostgreSQL sweeps a clock hand and Memcached splits its lists. Say you would accept approximate recency to remove the contention.',
    'Say where the cache sits and what a miss costs. An in-process cache is fastest, but each server warms its own copy. A shared cache such as Redis adds a network hop, but one warm copy serves every server. Size it from the hit rate you need and the price of a miss.',
  ],
};
