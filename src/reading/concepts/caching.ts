import type { Concept } from '../types';

const page: Concept = {
  id: 'caching',
  title: 'Caching',
  group: 'Data',
  summary:
    "Where caches sit, how writes reach them, and the ways a cache serves the wrong answer: stale reads, stampedes, hot keys. Includes the rule for money: cache what you display, never what you decide on.",
  minutes: 13,
  sections: [
    {
      id: 'where',
      title: 'Where caches sit',
      blocks: [
        {
          p: "A cache is a copy kept closer to the reader than the original. Every layer of a web stack has one, and the cheapest hit is the one furthest from your database. Before adding Redis, ask whether an earlier layer could answer.",
        },
        {
          diagram: {
            w: 420,
            h: 420,
            nodes: [
              { id: 'browser', label: 'Browser or app', sub: 'private HTTP cache', x: 110, y: 10, w: 200, h: 48, kind: 'client' },
              { id: 'cdn', label: 'CDN edge', sub: 'shared, public content', x: 110, y: 98, w: 200, h: 48 },
              { id: 'svc', label: 'Service', sub: 'in-process map', x: 110, y: 186, w: 200, h: 48 },
              { id: 'redis', label: 'Redis or Memcached', sub: 'shared by all instances', x: 110, y: 274, w: 200, h: 48, kind: 'store' },
              { id: 'db', label: 'Database', sub: 'buffer pool in memory', x: 110, y: 362, w: 200, h: 48, kind: 'store', tone: 'ok' },
            ],
            edges: [
              { from: 'browser', to: 'cdn', label: 'miss' },
              { from: 'cdn', to: 'svc', label: 'miss' },
              { from: 'svc', to: 'redis', label: 'miss' },
              { from: 'redis', to: 'db', label: 'miss' },
            ],
          },
          caption:
            'Five places a read can be answered. Only the bottom box holds the truth. A hit at any layer saves everything below it, and each layer you add is one more place a stale copy can hide.',
        },
        {
          table: {
            head: ['Layer', 'Typical cost of a hit', 'Good for', 'Catch'],
            rows: [
              ['Browser or app', '0 ms, no request', 'Static assets, a response the user just fetched', "You can't purge it. Only the expiry you set ends it"],
              ['CDN edge', '10 to 30 ms, near the user', 'Public pages, images, public API responses', 'Shared between users: never cache a personal response without care'],
              ['In-process', 'Nanoseconds to microseconds', 'Config, feature flags, small reference tables', 'One copy per instance, each a little different. Lost on deploy'],
              ['Redis or Memcached', 'About 1 ms on the same network', 'Sessions, rendered objects, query results shared by all instances', 'A network hop and a new thing to run'],
              ['Database buffer pool', 'Part of the query', 'Hot pages of tables and indexes', 'Automatic. If the working set fits in memory, an extra cache may add little'],
            ],
          },
          caption: 'Cache layers compared. The latencies are orders of magnitude.',
        },
        {
          callout:
            "Add a cache when you can name the read it saves and the staleness you'll accept. 'Reads are 100 times writes, the query costs 40 ms, and a profile 60 seconds old is fine' is a reason. 'For performance' is not.",
          kind: 'rule',
        },
      ],
    },
    {
      id: 'strategies',
      title: 'Read and write strategies',
      blocks: [
        {
          p: "A cache in front of a database raises one question on every write: what happens to the copy? The five named strategies are five answers. Two describe reads, three describe writes, and you combine one of each.",
        },
        {
          diagram: {
            w: 600,
            h: 290,
            nodes: [
              { id: 'app', label: 'Service', x: 230, y: 20 },
              { id: 'cache', label: 'Cache', sub: 'copy, with a TTL', x: 20, y: 200, kind: 'store' },
              { id: 'db', label: 'Database', sub: 'the truth', x: 440, y: 200, kind: 'store', tone: 'ok' },
            ],
            edges: [
              { from: 'app', to: 'cache', label: '1 get, 3 fill' },
              { from: 'app', to: 'db', label: '2 read on miss' },
            ],
          },
          caption:
            "Cache-aside. The service does all the work: look in the cache, read the database on a miss, fill the cache. The cache and the database never talk to each other, so the cache can fail and reads still work, slowly.",
        },
        {
          table: {
            head: ['Strategy', 'What happens', 'Cost', 'Choose it when'],
            rows: [
              ['Cache-aside (read)', 'Service reads cache; on a miss reads the database and fills the cache', 'First read is slow. Fill logic lives in every service', 'The default. Read-heavy data over a database you already have'],
              ['Read-through (read)', 'Same, but the cache library or server loads the miss itself', 'The cache must know how to load each key', 'You want the fill logic in one place'],
              ['Write-through (write)', 'Write the database and update the cache in the same request', 'Every write pays for two. Caches keys nobody reads', 'Data read straight after it is written'],
              ['Write-behind (write)', 'Write only the cache; flush to the database later', 'A crash before the flush loses acknowledged writes', 'Hot counters where losing seconds is acceptable'],
              ['Write-around (write)', 'Write only the database; the cached copy waits for its TTL', 'Stale until the TTL ends', 'Bulk writes that are rarely read back'],
            ],
          },
          caption: 'The five strategies. With cache-aside the usual write is: update the database, then delete the key.',
        },
        {
          p: "On a write, cache-aside **deletes** the key instead of setting the new value. Two concurrent writers that each set the cache can finish in the opposite order to their database commits, leaving the older value cached for good. A delete can be repeated and reordered safely. The next reader pays one miss.",
        },
        {
          see: [
            { href: '#/s/cache-strategies', label: 'Cache strategies', why: 'All four write strategies step by step, with the stale-read race, the stampede and the lost write-behind.' },
          ],
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Eviction',
      blocks: [
        {
          p: "A cache holds the working set, not everything, so when it is full something has to go. Eviction is about **space**. Expiry (a TTL) is about **staleness**. You need both, and they are separate settings.",
        },
        {
          table: {
            head: ['Policy', 'Evicts', 'Good at', 'Bad at'],
            rows: [
              ['LRU (least recently used)', 'The entry untouched longest', 'Workloads where recent use predicts the next use. Simple, O(1)', 'One scan over cold data pushes out everything hot'],
              ['LFU (least frequently used)', 'The entry with the fewest hits', 'Keys that stay popular for a long time', 'Slow to forget old favourites; new keys start at a disadvantage'],
              ['FIFO', 'The oldest entry', 'Very cheap', "Ignores use altogether"],
              ['Random or sampled', 'One of a few sampled keys', 'No list to maintain. Close to LRU in practice', 'Approximate'],
            ],
          },
          caption: 'Eviction policies. LRU, or a sampled approximation of it, is the default almost everywhere.',
        },
        {
          p: "Size the cache from the hit rate you need, not the data size. If 20% of keys take 80% of reads, caching that 20% gets most of the benefit. Then watch two numbers: hit rate and evictions per second. A high eviction rate with a falling hit rate means the cache is too small for the working set, and making TTLs longer won't help.",
        },
        {
          see: [
            { href: '#/s/lru-cache', label: 'LRU cache', why: 'The hash map and doubly linked list that make get, put and evict all O(1).' },
          ],
        },
      ],
    },
    {
      id: 'invalidation',
      title: 'Invalidation and the stale-read race',
      blocks: [
        {
          p: "Invalidation is the hard part of caching. Every code path that changes the data must also remove the copy: the API, the batch job, the admin tool, the manual fix in a SQL console. Miss one and the cache is wrong until the TTL ends. Even when every path is covered, 'update the database, then delete the key' has a race.",
        },
        {
          sequence: {
            actors: ['Reader', 'Writer', 'Cache', 'Database'],
            messages: [
              { from: 'Reader', to: 'Cache', label: 'get user:42 → miss' },
              { from: 'Reader', to: 'Database', label: "read → 'Ann' (v1)", tone: 'visited', note: 'the reader now stalls: GC pause, slow network' },
              { from: 'Writer', to: 'Database', label: "update → 'Anne' (v2)", tone: 'ok' },
              { from: 'Writer', to: 'Cache', label: 'delete user:42', note: 'nothing there yet to delete' },
              { from: 'Reader', to: 'Cache', label: "set user:42 = 'Ann' (v1)", tone: 'bad', note: 'stale, and stays until the TTL' },
            ],
          },
          caption:
            "The delete-then-repopulate race. The reader fetched the old row before the write, and filled the cache after the delete. The database says 'Anne'; the cache says 'Ann' and nothing will correct it except expiry. Every step was correct on its own.",
        },
        {
          p: "The window is small, since the reader has to stall between its database read and its cache fill. At thousands of requests a second, small windows get hit daily. There are five fixes, in rising order of effort.",
        },
        {
          table: {
            head: ['Fix', 'How it works', 'What it costs'],
            rows: [
              ['A TTL on every key', 'The stale entry dies on its own', "Doesn't prevent the race; bounds how long it lasts"],
              ['Delayed second delete', 'Delete again a second or so after the write', 'A guess at how long a reader can stall. Simple, mostly works'],
              ['Versioned fill', 'Store a version with the value; a fill only succeeds if its version is newer', 'Needs a version on every row and a compare-and-set in the cache'],
              ['Leases', 'A miss hands the reader a token; a delete cancels outstanding tokens; a fill with a cancelled token is refused', 'Needs cache support. This is the fix in the Facebook memcache paper'],
              ['Invalidate from the database log', 'A change-data-capture consumer deletes keys as commits appear in the log', 'A pipeline to run, and a short delay. Catches every write path, including the SQL console'],
            ],
          },
          caption: 'Fixes for the race. A TTL is the safety net under all of them, not an alternative to them.',
        },
        {
          sequence: {
            actors: ['Reader', 'Writer', 'Cache', 'Database'],
            messages: [
              { from: 'Reader', to: 'Cache', label: 'get user:42 → miss, lease 7', tone: 'compare' },
              { from: 'Reader', to: 'Database', label: "read → 'Ann' (v1)", tone: 'visited' },
              { from: 'Writer', to: 'Database', label: "update → 'Anne' (v2)", tone: 'ok' },
              { from: 'Writer', to: 'Cache', label: 'delete user:42', note: 'cancels lease 7' },
              { from: 'Reader', to: 'Cache', label: "set 'Ann' with lease 7 → refused", tone: 'bad', note: 'the stale fill is rejected' },
              { from: 'Reader', to: 'Cache', label: 'next get → miss, lease 8' },
              { from: 'Reader', to: 'Database', label: "read → 'Anne' (v2)", tone: 'visited' },
              { from: 'Reader', to: 'Cache', label: "set 'Anne' with lease 8 → stored", tone: 'ok' },
            ],
          },
          caption:
            'The same race with leases. The delete cancels the token the slow reader holds, so its late fill is refused and the next read loads the new value. The cache stays empty for a moment, which is safe; it never holds the old value.',
        },
        {
          callout:
            "Saying 'we invalidate on write' and stopping. The follow-up is always 'what if a read is in flight?' Draw the race, then give a TTL plus one real fix: versioned fills or leases if the cache supports them, log-based invalidation if there are many write paths.",
          kind: 'pitfall',
        },
      ],
    },
    {
      id: 'ttl-stampede',
      title: 'TTLs, jitter and stampedes',
      blocks: [
        {
          p: "A TTL is a promise about staleness: with a 60-second TTL and no other invalidation, a reader sees data at most 60 seconds old. Choose it from what the product can tolerate, per kind of data, and write the number down. Exchange rates shown on a marketing page might take 60 seconds. A feature flag might take 10. A country list can take a day.",
        },
        {
          p: "Identical TTLs expire together. Warm a cache at 09:00 with a one-hour TTL and at 10:00 every key misses at once. **Jitter** spreads that out: set each TTL to the base plus or minus a random 10%, so the expiries smear over twelve minutes instead of one instant.",
        },
        {
          h: 'Stampedes',
        },
        {
          p: "A stampede is the same problem on one key. A popular key expires, and every request that arrives before the first refill finishes also misses. If the query takes 400 ms and the key gets 250 requests a second, that's 100 identical queries hitting the database at once, each making the others slower. A cold cache after a deploy or a restart is the same thing across every key.",
        },
        {
          sequence: {
            actors: ['Request 1', 'Requests 2–100', 'Service', 'Cache', 'Database'],
            messages: [
              { from: 'Request 1', to: 'Service', label: 'get rates:GBP' },
              { from: 'Service', to: 'Cache', label: 'get → miss (expired)' },
              { from: 'Service', to: 'Database', label: 'one query, 400 ms', tone: 'follow' },
              { from: 'Requests 2–100', to: 'Service', label: 'get rates:GBP', note: 'join the call in flight; no new query' },
              { from: 'Database', to: 'Service', label: 'result', tone: 'follow' },
              { from: 'Service', to: 'Cache', label: 'set, TTL 60 s ± 10%', tone: 'ok' },
              { from: 'Service', to: 'Request 1', label: 'value' },
              { from: 'Service', to: 'Requests 2–100', label: 'the same value' },
            ],
          },
          caption:
            'Request coalescing. A hundred requests miss the same key; the service runs the query once and hands the one result to all of them. Without it, the database would have run the same 400 ms query a hundred times.',
        },
        {
          table: {
            head: ['Defence', 'How it works', 'Limit'],
            rows: [
              ['Coalescing in process (single flight)', 'One in-flight load per key per instance; others wait on it', 'Per instance: 20 instances still make 20 queries'],
              ['Lock or lease in the cache', 'One instance wins the right to refill; the rest wait or retry', 'Needs a timeout in case the winner dies'],
              ['Serve stale while revalidating', 'Keep the old value past its soft expiry; refresh in the background', 'Readers see slightly older data. Usually the best trade'],
              ['Refresh ahead', 'Reload hot keys before they expire', 'Wastes work on keys nobody asks for again'],
            ],
          },
          caption: 'Stampede defences. They stack: single flight in each instance, serve-stale across the fleet.',
        },
        {
          h: 'Hot keys',
        },
        {
          p: "A hot key is one key taking a large share of traffic: the home-page config, a celebrity's profile, today's exchange rate. In a sharded cache, hashing puts it on one node, and that node saturates while the others idle. The fixes: hold it in process on every instance with a TTL of a few seconds, so most reads never reach Redis; or split it into copies (`rates:GBP#1` to `#8`), read one at random and write all eight. The same hashing limit applies to [sharded databases](#/c/sharding-and-partitioning).",
        },
        {
          h: 'Negative caching',
        },
        {
          p: "A lookup that finds nothing is still a database read, and if you cache only hits it repeats forever. Someone requesting random ids, by accident or on purpose, goes straight through the cache every time. Cache the 'not found' too, with a short TTL (30 seconds, say), and delete it when the row is created. For very large key spaces a Bloom filter in front answers 'definitely absent' without a lookup.",
        },
        {
          see: [
            { href: '#/s/cache-strategies', label: 'Cache strategies', why: 'Four readers miss one key and the database does the work four times; then once, with a lock per key.' },
            { href: '#/s/bloom-filter', label: 'Bloom filter', why: "How a few bits per key can say 'definitely not here'." },
            { href: '#/s/consistent-hashing', label: 'Consistent hashing', why: 'Why losing one cache node empties only its share, and why a hot key still lands on one node.' },
          ],
        },
      ],
    },
    {
      id: 'consistency',
      title: 'What each use case can tolerate',
      blocks: [
        {
          p: "A cache gives up strict consistency for speed, in every strategy. So the design question is per use case: how old may this answer be, and what happens if it is wrong?",
        },
        {
          table: {
            head: ['Data', 'Tolerable staleness', 'Approach'],
            rows: [
              ['Static assets with hashed filenames', 'Forever: a new version has a new name', 'Browser and CDN, one-year expiry'],
              ['Public page or public statistic', 'Seconds to minutes', 'CDN with a short TTL and serve-stale'],
              ['Product catalogue, exchange rates for display', 'Tens of seconds', 'Redis, cache-aside, TTL with jitter'],
              ['User profile', 'Seconds, but the user must see their own edit', 'Cache-aside with delete on write; read your own writes from the database for a moment after an edit'],
              ['Permissions and revocations', 'Close to zero', "Short TTL (seconds) or don't cache. A revoked card or session must stop working"],
              ['Balance shown on screen', 'A few seconds', "Cache if you must, labelled 'as of'"],
              ['Balance used to approve a payment', 'None', 'Read the ledger, inside the transaction'],
            ],
          },
          caption: 'Staleness by use case. The last two rows are the same number read for different purposes, and they get opposite answers.',
        },
        {
          h: 'Caching money',
        },
        {
          p: "Cache what you display. Don't cache what you decide on. A balance read from a cache to approve a payment is a check against the past: two payments can both see £100 and both spend £80. The decision has to read the ledger row and change it in one transaction, with a lock or a conditional update, so the check and the write can't be separated.",
        },
        {
          diagram: {
            w: 600,
            h: 320,
            nodes: [
              { id: 'show', label: 'Show balance', sub: 'app home screen', x: 20, y: 20, kind: 'client' },
              { id: 'auth', label: 'Approve payment', sub: 'card authorisation', x: 440, y: 20, kind: 'client', tone: 'follow' },
              { id: 'cache', label: 'Cache', sub: 'may be 5 s old', x: 20, y: 230, kind: 'store' },
              { id: 'ledger', label: 'Ledger', sub: 'Postgres, the truth', x: 440, y: 230, kind: 'store', tone: 'ok' },
            ],
            edges: [
              { from: 'show', to: 'cache', label: 'display only' },
              { from: 'cache', to: 'ledger', label: 'fill on miss', dashed: true },
              { from: 'auth', to: 'ledger', label: 'check + debit, one txn', tone: 'follow' },
            ],
          },
          caption:
            "Two paths to one number. The display path may read a copy a few seconds old. The decision path never touches the cache: it checks and debits in one database transaction. There is no line from 'Approve payment' to the cache, on purpose.",
        },
        {
          p: "The same rule covers limits, fraud counters used to block, stock at checkout, and idempotency keys. If a cache is the only place a decision's input lives, you've made the cache a database without giving it a database's guarantees. A cache may hold a decision's **output** for replay, such as a stored idempotent response, as long as the authoritative record is elsewhere.",
        },
        {
          callout:
            "'I'd cache the balance for the home screen with a short TTL, because a five-second-old number there is harmless. The authorisation path reads the account row under a lock in the ledger and never reads the cache. Caches are for showing; the ledger is for deciding.'",
          kind: 'interview',
        },
        {
          see: [
            { href: '#/d/ledger', label: 'Ledger design', why: 'The authorisation path that places a hold against the account row, with no cache in it.' },
            { href: '#/s/idempotency-keys', label: 'Idempotency keys', why: 'Replaying a stored response safely.' },
          ],
        },
      ],
    },
    {
      id: 'products',
      title: 'Redis, Memcached and the CDN',
      blocks: [
        {
          h: 'Redis or Memcached',
        },
        {
          table: {
            head: ['', 'Memcached', 'Redis'],
            rows: [
              ['Data model', 'Opaque values by key', 'Strings, hashes, lists, sets, sorted sets, streams'],
              ['Threads', 'Multi-threaded', 'Commands run on one main thread'],
              ['Persistence and replication', 'None built in', 'Snapshots, append-only file, replicas, cluster mode'],
              ['Scaling out', 'Clients hash keys over independent servers', 'Redis Cluster: fixed hash slots assigned to nodes'],
              ['Fits', 'A plain, large, volatile cache of rendered values', 'A cache that also needs counters, rate limits, leaderboards, locks or pub/sub'],
            ],
          },
          caption: "Redis and Memcached in brief. Most teams pick Redis because they'll want the data structures later; Memcached remains a sound choice for a pure cache.",
        },
        {
          p: "Whichever you choose, treat it as losable. If the service can't run with the cache empty, you don't have a cache, you have a second database with weaker durability. Test that by flushing it in a load test: the database should survive the miss storm, helped by coalescing and by bringing traffic back gradually.",
        },
        {
          h: 'A CDN for public pages',
        },
        {
          p: "A CDN is a cache-aside cache you rent, placed in hundreds of cities. The cache key is the URL, plus whatever headers you say the response varies on. You control it with HTTP headers: `Cache-Control: public, max-age=60` lets any edge keep the response for 60 seconds; `stale-while-revalidate` lets it serve the old copy while it fetches a new one; `private` or `no-store` keeps personal responses out of shared caches.",
        },
        {
          diagram: {
            w: 600,
            h: 300,
            nodes: [
              { id: 'uL', label: 'Users', sub: 'London', x: 20, y: 20, kind: 'client' },
              { id: 'uS', label: 'Users', sub: 'Singapore', x: 20, y: 220, kind: 'client' },
              { id: 'eL', label: 'Edge', sub: 'London', x: 230, y: 20, tone: 'ok' },
              { id: 'eS', label: 'Edge', sub: 'Singapore', x: 230, y: 220, tone: 'ok' },
              { id: 'origin', label: 'Origin', sub: 'one region', x: 440, y: 120 },
            ],
            edges: [
              { from: 'uL', to: 'eL', label: 'hit' },
              { from: 'uS', to: 'eS', label: 'hit' },
              { from: 'eL', to: 'origin', label: 'once per TTL', dashed: true },
              { from: 'eS', to: 'origin', label: 'once per TTL', dashed: true },
            ],
          },
          caption:
            'A CDN in front of a public page. Users everywhere get an answer from a nearby edge. With a 60-second TTL the origin sees about one request a minute from each edge location, whether the page has ten viewers or ten million.',
        },
        {
          p: "That last property is why a public statistics page is the best case for a CDN: one response, the same for everyone, tolerant of a minute's delay. The [money moved dashboard](#/d/money-moved-dashboard) design uses exactly this, and has to handle the two things that go wrong: a purge takes time to reach every edge, so prefer short TTLs to purging; and an origin outage should serve the last good copy, not an error.",
        },
        {
          callout:
            "Caching a personalised response at a shared edge. If `/account` is cached under its URL alone, the second visitor gets the first visitor's page. Mark personal responses `private`, or keep them off the CDN path.",
          kind: 'pitfall',
        },
        {
          see: [
            { href: '#/d/money-moved-dashboard', label: 'Money moved dashboard', why: 'A public aggregate served through an API and a CDN, with the staleness budget worked out.' },
            { href: '#/c/multi-region-data', label: 'Multi-region data', why: 'A CDN solves read latency for public data. Private, writable data needs the patterns there.' },
          ],
        },
      ],
    },
  ],
  unverified: [
    'Latencies in the layer table (CDN hit 10 to 30 ms, Redis about 1 ms on the same network, in-process nanoseconds to microseconds): orders of magnitude, not measurements.',
    'The "20% of keys take 80% of reads" sizing example is illustrative; real distributions differ.',
    'Leases as described (a delete cancels outstanding tokens) follow the 2013 "Scaling Memcache at Facebook" paper as remembered; stock Memcached and Redis do not provide them under that name.',
    'Memcached is multi-threaded with no built-in persistence or replication; Redis runs commands on one main thread and offers snapshots, an append-only file, replicas and cluster mode: from memory. Newer Redis versions use extra threads for network I/O.',
    'Redis Cluster using fixed hash slots: matches the partitioning page on this site (16,384 slots), not re-checked.',
    '`Cache-Control` directives `public`, `private`, `no-store`, `max-age` and `stale-while-revalidate`: standard HTTP as remembered; CDN support for `stale-while-revalidate` and serving stale on origin errors varies by provider.',
    'That the origin sees "about one request a minute from each edge location" with a 60-second TTL assumes each location coalesces its own misses and holds one copy; large CDNs have many caches per city and tiered layers.',
    'The money moved dashboard design is described only as "served through an API and a CDN"; its exact TTLs were not re-read for this page.',
    'The stampede sum (400 ms query × 250 requests a second = 100 concurrent misses) is a worked assumption.',
  ],
};

export default page;
