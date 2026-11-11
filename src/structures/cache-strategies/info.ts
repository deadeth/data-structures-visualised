import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A cache in front of a database holds copies, so every write raises one question: what happens to the copy? Cache-aside deletes it, write-through updates it in the same request, write-behind updates only the copy and saves it to the database later, and write-around leaves it to expire. Each answer trades freshness, write speed and the risk of losing a write in a different way.',
  watch: [
    'A miss costs three steps: look in the cache, read the database, fill the cache. The next read of the same key is one step. Watch the database reads counter stay still on a hit.',
    'Each row carries a version. The page compares the cached version with the database version on every hit, which a real application cannot do. That is why a stale read is silent.',
    'Under cache-aside a write deletes the cached copy rather than overwriting it. The race shows how a delete can still lose: a slow reader puts the old value back after the delete, and only the TTL ends it.',
    'In the stampede, four readers miss the same key at once and the database does the same work four times. With a lock per key it does it once and three readers wait.',
    'Under write-behind the write is answered after 0 database writes, and the cache entry is pinned until a flush. Crash the cache before the flush and the write is gone, though the client was told it succeeded.',
    'Switch to write-around, read a key, then write it. The cache goes on serving the old value until its TTL runs out.',
  ],
  complexity: [
    { op: 'Read, hit', average: '1 cache read', worst: '1 cache read', note: 'Typically well under a millisecond from an in-memory cache on the same network.' },
    { op: 'Read, miss', average: '1 cache read + 1 database read + 1 cache write', worst: 'The same, once per concurrent reader', note: 'Without a lock or coalescing, N readers that miss together make N database reads.' },
    { op: 'Write, cache-aside', average: '1 database write + 1 cache delete', worst: 'The same', note: 'The next read of that key is a miss.' },
    { op: 'Write, write-through', average: '1 database write + 1 cache write', worst: 'The same', note: 'The client waits for both. The next read is a hit.' },
    { op: 'Write, write-behind', average: '1 cache write', worst: '1 cache write', note: 'The database write happens on a flush. Several writes to one key in a batch become one.' },
    { op: 'Write, write-around', average: '1 database write', worst: '1 database write', note: 'A cached copy stays stale until its TTL ends.' },
  ],
  space:
    'O(keys cached) in the cache: each entry is the key, the value and an expiry time, plus the cache\'s own bookkeeping. Write-behind adds O(keys with unsaved writes) for the queue. The database keeps everything; the cache is sized to the working set, often a small fraction of the data.',
  usedIn: [
    {
      name: 'Facebook memcache',
      how: 'A look-aside cache filled on demand: a web server reads memcache, and on a miss reads the database and sets the value. A write updates the database and then deletes the key, because deletes are idempotent. Leases stop the stale fill shown in the race and limit thundering herds. All of this is in the 2013 paper "Scaling Memcache at Facebook".',
    },
    {
      name: 'Redis and Memcached',
      how: 'The usual cache-aside stores. The application does the lookup, the database read and the fill itself, and sets a TTL on each key.',
    },
    {
      name: 'Amazon DynamoDB Accelerator (DAX)',
      how: 'An in-memory cache that sits in front of DynamoDB and speaks its API. Reads are served from the cache when they can be; writes go through DAX to DynamoDB and update the cache once the table write succeeds.',
    },
    {
      name: 'Hazelcast and other data grids',
      how: 'A map backed by a MapStore writes to the database through the cache. With a write delay of 0 it is write-through; with a delay above 0 it is write-behind, and writes are batched and saved later.',
    },
    {
      name: 'Operating systems and CPUs',
      how: 'The Linux page cache is write-back: a write dirties a page in memory and the kernel writes it to disk later, which is why fsync exists. CPU caches mostly work the same way.',
    },
    {
      name: 'NGINX and Varnish',
      how: 'HTTP caches with stampede protection built in. NGINX proxy_cache_lock lets one request fill a new cache entry while the rest wait, and proxy_cache_use_stale updating serves the old copy while it is refreshed. Varnish coalesces identical requests for an object that is being fetched.',
    },
    {
      name: 'CDNs',
      how: 'A cache at the edge, close to users. Most pull: an edge that misses fetches from the origin and keeps the copy; push means uploading content to the CDN before anyone asks. The cache key is usually the URL plus any headers or query parameters it varies on, and a purge removes an object by URL or by tag across every edge, which takes time to reach them all.',
    },
  ],
  reachFor: [
    'Cache-aside: the default for read-heavy data with a database you already have. Only what is read gets cached, and the cache can fail without losing data.',
    'Write-through: data read soon after it is written, where a stale read hurts more than a slower write. Pair it with read-through so the cache loads misses itself.',
    'Write-behind: heavy writes to a few hot keys (counters, scores, session state) where losing the last few seconds is acceptable, or where the queue is made durable.',
    'Write-around: data written in bulk and rarely read back, such as logs or imports, which would only push useful entries out of the cache.',
    'What to cache: data read far more often than written, expensive to compute, and fine to serve a little old. Profiles, product pages, configuration, rendered fragments.',
    'What not to cache: data that must be exact at the moment it is read (a balance being debited, stock at checkout, permissions just revoked), data that changes on most reads, and data read once.',
  ],
  costs: [
    'Every strategy can serve stale data in some failure or race. A cache gives up strict consistency for speed. If a read must be current, read the database.',
    'Invalidation is the hard part. Every code path that writes the data must delete or update the cache too, including batch jobs and manual fixes. A TTL is the safety net for the path someone forgot.',
    'Write-behind can lose acknowledged writes and lets the database fall behind, so anything else reading the database sees old data. A durable queue fixes the loss and adds a moving part.',
    'Write-through makes every write pay for two writes, and caches keys that may never be read.',
    'A cold cache after a restart or a deploy sends the full read load to the database. Warm it first, or bring it back slowly.',
    'Many keys given the same TTL at the same time all expire together (sometimes called a cache avalanche). Add random jitter to TTLs, say plus or minus 10%.',
  ],
  interview: [
    'Name the read path and the write path separately. "Reads are cache-aside with a TTL of 5 minutes. Writes go to the database and then delete the key." Most designs need nothing more.',
    'Say why delete beats update on write. Two writers can update the database in one order and the cache in the other, leaving the older value cached. A delete has no value to get out of order, and the next read loads the truth. Facebook chose deletes for this reason: they are idempotent.',
    'Then admit the delete still has a race: a reader that misses, reads the old row, and fills the cache after the writer\'s delete. It needs bad timing, and a TTL bounds it. Leases, a version check on fill, or a second delete a moment later close it further.',
    'Invalidation and TTL do different jobs. Invalidation makes data fresh quickly when you know it changed. A TTL bounds how stale it can ever be when you miss a change. Use both.',
    'Negative caching: when the database has no row, cache "not found" with a short TTL, as DNS does for a name that does not exist. Without it, requests for missing keys pass straight through to the database every time.',
    'Cache penetration is that problem used as an attack: a flood of requests for random keys that do not exist. Negative caching cannot hold them all. Put a Bloom filter of real keys in front (see the Bloom filter page): it answers "definitely not here" with no false negatives, so only possible keys reach the database.',
    'Thundering herd on a hot key, three fixes. A lock per key, or request coalescing in one process (Go\'s singleflight package), so one caller loads and the rest wait. Early probabilistic refresh: each reader refreshes a little before expiry with a probability that rises as expiry nears (the XFetch method). Stale-while-revalidate: serve the old value and refresh in the background, as HTTP\'s Cache-Control extension of that name does.',
    'Distributed cache: partition keys across nodes with consistent hashing (see that page), so adding a node moves only about 1/N of the keys. Replicate hot or important partitions so a node loss is not a cold start. Redis Cluster splits keys into 16,384 hash slots spread over its primaries, which is the same idea with a fixed table.',
    'Redis or Memcached, honestly. Memcached stores opaque values under string keys, runs many threads, and has no replication of its own and nothing that survives a crash: clients spread keys across servers. Redis has data structures (strings, hashes, lists, sets, sorted sets, streams), optional persistence with snapshots and an append-only file, asynchronous primary to replica replication, and runs commands on one thread, with optional I/O threads since version 6. Pick Memcached for a plain, multithreaded cache of blobs; Redis when you need the structures, replication or persistence.',
    'Size the win with numbers. With a 95% hit rate, 1 ms hits and 20 ms misses, the average read is 0.95 × 1 + 0.05 × 21 = 2 ms, and the database sees 5% of the reads. Losing the cache multiplies its load by 20.',
  ],
};
