import type { Reading } from '../types';

/**
 * Walkthrough of the web crawler design (`src/designs/web-crawler.ts`).
 *
 * Where the design page's figures disagree with each other, this page picks one and shows
 * the working: 20,000 link checks a second (the average rate), hourly slot snapshots,
 * seen keys that carry the slot, a due table keyed by hour and slot and dropped after
 * hand-out, and a small hosts table.
 */
const page: Reading = {
  id: 'web-crawler',
  title: 'Design a web crawler: the walkthrough',
  summary:
    "How to answer \"design a web crawler\" in 45 to 60 minutes: what to ask, the sums, the design drawn in five stages, and the reasoning behind each box. It's a scheduling problem far more than a compute problem.",
  minutes: 23,
  sections: [
    {
      id: 'scope',
      title: 'What to ask before drawing',
      blocks: [
        {
          p: "The same six words cover three different systems. Ask which one you're building before you draw anything, because the answer changes the hard part.",
        },
        {
          table: {
            head: ['Framing', 'Scale', 'Shape', 'Hard part'],
            rows: [
              ['One site, one machine', 'Thousands to millions of pages', 'A queue, a visited set, one rate limiter, a worker pool', 'Knowing when you are done: queue empty and nothing in flight'],
              ['One-off crawl for a corpus', '10 billion pages in five days', 'A managed queue with visibility timeouts, stateless fetchers, a lock per domain', 'Bandwidth: 1 PB in 432,000 seconds is about 18.5 Gbit/s'],
              ['Continuous crawl (this page)', '1 billion pages a month, revisited for ever', 'A scheduler on each node that owns its hosts', 'The frontier, deduplication and recovery'],
            ],
          },
          caption: 'Three questions hiding in one. This page answers the third and says where the others differ.',
        },
        {
          list: [
            "**What is it for?** Search, archive, price monitoring and model training want different coverage and freshness.",
            "**How big and how fast?** Pages a month, or a fixed corpus by a deadline.",
            "**What counts as polite?** robots.txt, a rate per host, a way for site owners to contact you.",
            "**What is out of scope?** Indexing, images and video, pages behind a login, content that only appears after scripts run.",
          ],
        },
        {
          p: "Then state the requirements back. Crawl outward from seeds and store every page. Never fetch a URL twice in a cycle, and revisit pages when they're due. Obey robots.txt and never overload a host. Lose no progress when a machine dies.",
        },
        {
          callout:
            "\"I'll assume a continuous crawl of about a billion pages a month, HTML only, no rendering in the first version. In one sentence: seeds feed a frontier, fetchers pull from it politely, parsers extract links, and new links go back in. The hard parts are the frontier, deduplication and what happens when a node dies.\"",
          kind: 'interview',
          title: 'Open with this',
        },
      ],
    },
    {
      id: 'numbers',
      title: 'The numbers, with working',
      blocks: [
        {
          p: "Do the sums in the first ten minutes. They show that twenty modest machines carry the load, which is your licence to spend the hour on scheduling.",
        },
        {
          table: {
            head: ['What', 'Working', 'Result'],
            rows: [
              ['Fetch rate', '1 billion pages ÷ 2.6 million seconds in a month', 'About 400 a second. Build for 1,000.'],
              ['Bandwidth', '400 × 100 KB a page = 40 MB a second', 'About 320 Mbit/s. Provision 1 Gbit/s.'],
              ['Raw storage', '1 billion × 100 KB; HTML compresses about 5 to 1', '100 TB a month raw, 20 TB compressed'],
              ['Link checks', '400 pages × about 50 links a page', '20,000 URL-seen checks a second'],
              ['Known URLs', 'Assume discovery outruns fetching tenfold', '10 billion: 80 GB as 8-byte fingerprints'],
              ['Pending URLs', 'Assume two months of work, 150 bytes an entry', '2 billion, 300 GB'],
              ['In flight', '1,000 fetches a second × about 1 second each', 'About 1,000 open requests'],
              ['Machines', '1,000 a second ÷ 50 pages a second a node', '20 crawler nodes'],
              ['One host, politely', '1 request a second × 86,400 seconds', 'At most 86,400 pages a day from any one site'],
            ],
          },
          caption: 'Every later figure on this page divides one of these by 20 nodes or 1,024 slots.',
        },
        {
          p: "This page uses the average rate, 400 pages and 20,000 link checks a second, for every throughput and storage figure. The build rate of 1,000 pages a second is headroom: at that ceiling the link checks reach 50,000 a second, so size the hot path for that and quote 20,000.",
        },
        {
          p: "Per node, divide by 20: 20 pages a second on average and 50 at the ceiling, 1,000 link checks a second, 15 GB of pending URLs, 4 GB of fingerprints.",
        },
        {
          callout:
            "The last row shapes the design. One site gives you 86,400 pages a day however many machines you own. The crawl is fast because it's wide, across about 50 million hosts.",
          kind: 'rule',
          title: 'Wide, not deep',
        },
      ],
    },
    {
      id: 'the-loop',
      title: 'Stage 1: draw the loop',
      blocks: [
        {
          p: "Draw seven boxes in a ring first, on one imaginary machine. A URL leaves the frontier, is fetched and parsed, and its links pass a filter and a seen check before the new ones rejoin the frontier.",
        },
        {
          design: { id: 'web-crawler', lit: ['seeds', 'frontier', 'fetcher', 'web', 'parser', 'filter', 'seen'], flows: ['seed', 'lease', 'get', 'page', 'links', 'local', 'new'] },
          caption: 'The loop, and nothing else. Every later stage hangs a box off this ring to fix one thing a naive loop gets wrong.',
        },
        {
          p: "Then say what's wrong with it; that list is your agenda. A plain queue can't be polite. The seen check has to hold 10 billion URLs. A parser bug would mean fetching the web again. And with twenty machines, one will die.",
        },
        {
          p: "Seeds get one sentence: a reviewed list of sites with priorities, plus their sitemaps, posted through a small audited API. They decide what the crawl can ever reach, so review them like code and keep a per-domain kill switch beside the list.",
        },
      ],
    },
    {
      id: 'frontier',
      title: 'Stage 2: the frontier and politeness',
      blocks: [
        {
          p: "The frontier is a scheduler, not a queue. It answers two questions at once: which URL matters most, and which host may be contacted now.",
        },
        { h: 'The problem' },
        {
          p: "Links cluster by host. The next thousand URLs in a first-in-first-out queue are often one site, so you either hit it with a thousand requests or leave every fetcher idle. Good pages also queue behind link farms.",
        },
        { h: 'Options weighed' },
        {
          table: {
            head: ['Option', 'What it gives', 'Why not here'],
            rows: [
              ['Managed queue (SQS standard)', 'No code; visibility timeouts as retries; a dead-letter queue', "Can't hold one host back while serving another, and has no priority order. Politeness needs a lock per domain and a re-queue on every miss."],
              ['Redis sorted set by next fetch time', 'The sorted set is the heap; fetchers stay stateless', '2 billion pending URLs is 300 GB of memory, and every decision is a network round trip'],
              ['Postgres with SKIP LOCKED', 'Transactions; easy to query. Right for one site.', '400 dequeues and up to 20,000 link checks a second mean lock and vacuum trouble'],
              ['Front and back queues on each node (chosen)', 'One request per host by construction, no locks, no network hop', 'Custom stateful code that needs snapshots and replay'],
            ],
          },
          caption: 'Every rejected option fails the same test: it cannot say "not this host yet" cheaply.',
        },
        { h: 'How the chosen one works' },
        {
          diagram: {
            w: 640,
            h: 400,
            groups: [
              { label: 'Front queues: what matters', x: 20, y: 5, w: 600, h: 100 },
              { label: 'Back queues: one host each', x: 20, y: 195, w: 600, h: 100 },
            ],
            nodes: [
              { id: 'f1', label: 'Priority 1', sub: 'seeds, news', x: 40, y: 34, kind: 'queue' },
              { id: 'f2', label: 'Priority 2', x: 250, y: 34, kind: 'queue' },
              { id: 'f3', label: 'Priority 3', sub: 'deep, low value', x: 460, y: 34, kind: 'queue' },
              { id: 'refill', label: 'Refill an empty queue', sub: 'highest priority first', x: 220, y: 130, w: 200, h: 44 },
              { id: 'b1', label: 'example.org', sub: 'due 10:20:09', x: 40, y: 224, kind: 'queue', tone: 'follow' },
              { id: 'b2', label: 'shop.example', sub: 'due 10:20:03', x: 250, y: 224, kind: 'queue' },
              { id: 'b3', label: 'blog.example', sub: 'due 10:20:15', x: 460, y: 224, kind: 'queue' },
              { id: 'heap', label: 'Min-heap of next times', sub: 'top: shop.example', x: 40, y: 330, w: 350, tone: 'compare' },
              { id: 'fetch', label: 'Fetchers', sub: 'lease if top is due', x: 460, y: 330 },
            ],
            edges: [
              { from: 'f1', to: 'refill' },
              { from: 'f2', to: 'refill' },
              { from: 'f3', to: 'refill' },
              { from: 'refill', to: 'b1' },
              { from: 'refill', to: 'b2' },
              { from: 'refill', to: 'b3' },
              { from: 'b1', to: 'heap' },
              { from: 'b2', to: 'heap' },
              { from: 'b3', to: 'heap' },
              { from: 'heap', to: 'fetch', label: 'lease', tone: 'compare' },
            ],
          },
          caption: 'Priority acts only in the top half, politeness only in the bottom. One comparison of the heap top with the clock says whether anything is due; if not, nothing is handed out, however many URLs wait.',
        },
        {
          p: "Each back queue holds one host, so \"one request in flight per host\" is true by construction. After a fetch the host goes back on the heap with a new time: now plus the largest of 1 second, the site's Crawl-delay, and ten times the last response time. A slow site is a busy site, so it gets a longer gap.",
        },
        {
          p: "A node keeps about 150 back queues, three for each of its 50 fetch slots. The sum checks out: 150 hosts each yielding one page every 3 seconds is 50 pages a second. The queues live in RocksDB on local SSD, 15 GB a node, with the heap and both ends of each queue in memory.",
        },
        {
          sequence: {
            actors: ['Frontier', 'Fetcher', 'Resolver', 'example.org'],
            messages: [
              { from: 'Fetcher', to: 'Frontier', label: 'lease(max 8)' },
              { from: 'Frontier', to: 'Fetcher', label: '/news, deadline 10:21:00', tone: 'follow', note: 'the host is now off the heap' },
              { from: 'Fetcher', to: 'Resolver', label: 'example.org?' },
              { from: 'Resolver', to: 'Fetcher', label: '203.0.113.27', note: 'not private; robots allows /news' },
              { from: 'Fetcher', to: 'example.org', label: 'GET /news', tone: 'follow' },
              { from: 'example.org', to: 'Fetcher', label: '200, 100 KB in 840 ms' },
              { from: 'Fetcher', to: 'Frontier', label: 'complete, gap 8.4 s', tone: 'ok', note: 'max(1 s, Crawl-delay 2 s, 10 × 0.84 s)' },
              { from: 'Fetcher', to: 'Frontier', label: 'lease(max 8)' },
              { from: 'Frontier', to: 'Fetcher', label: 'other hosts only', tone: 'muted', note: 'example.org not due until 10:20:09' },
            ],
          },
          caption: 'One fetch and the wait after it. The gap is set by the site, not by the crawler: the last response took 840 ms, so the host rests for 8.4 seconds.',
        },
        {
          p: "Every hand-out is a lease with a deadline. The URL stays in the on-disk queue until the fetcher calls complete, so a fetcher that dies loses nothing: the lease expires and the URL is offered again. That makes fetching at-least-once, never zero times and rarely twice.",
        },
        { h: 'What can still go wrong' },
        {
          p: "Shared hosting puts thousands of hosts on one address, and those hosts belong to different nodes, so no frontier sees the total. A small Redis service holds a [token bucket](#/s/token-bucket) per address and per registrable domain, asked only for addresses known to serve many sites. If it's down, fetchers fall back to a slow fixed rate. They never speed up.",
        },
        {
          callout:
            "\"Politeness has three layers. One request in flight per host comes from the frontier's shape. Token buckets per address cover shared hosting. And when a site answers 429 or 503 I honour Retry-After or double its delay, then shorten it slowly. I'd measure violations and aim for zero.\"",
          kind: 'interview',
        },
        {
          see: [
            { href: '#/s/crawl-frontier', label: 'Crawl frontier', why: 'Watch a refusal: URLs waiting, nothing due, nothing handed out.' },
            { href: '#/s/heap', label: 'Binary heap', why: 'Why moving a host to a later time costs a few steps.' },
            { href: '#/s/lsm-tree', label: 'LSM tree', why: 'What RocksDB does with many small writes.' },
          ],
        },
      ],
    },
    {
      id: 'fetch-path',
      title: 'Stage 3: DNS, robots and the fetch',
      blocks: [
        {
          design: { id: 'web-crawler', lit: ['fetcher', 'dns', 'robots', 'iplimit', 'web'], flows: ['dns', 'robots', 'ip', 'get'] },
          caption: "Three questions before one request: where is it, may I, and is the server behind it already busy? Only the last two cross the network, and the limiter only for busy addresses.",
        },
        { h: 'DNS' },
        {
          p: "DNS is the bottleneck candidates forget. An uncached lookup takes tens to hundreds of milliseconds, and the standard library call blocks a thread while it waits. The options are the operating system resolver (nothing to build, one cache per process), public resolvers in rotation (nothing to run, but every lookup leaves your network), or caching resolvers beside the fetchers.",
        },
        {
          p: "Choose the last. With no cache it's 400 lookups a second. With one, 50 million hosts a month is about 19 a second, a few times that with short record lifetimes. What still breaks: a resolver that stops answering stalls every fetch, so use more than one upstream and open a circuit breaker so fetchers skip hosts that won't resolve.",
        },
        { h: 'robots.txt' },
        {
          p: "Fetching robots.txt before every page would double the traffic, so each node caches the parsed rules for the hosts it owns, for at most 24 hours. The check is an in-process read. A 4xx on robots.txt means no restrictions. A 5xx or no answer means disallow everything: an overloaded site is telling you something. The cost is that a rule change can take a day to be seen.",
        },
        { h: 'Fetchers' },
        {
          p: "Fetching is waiting: 1,000 open sockets and almost no processor time. Run it on an event loop, about 50 requests in flight per node. A thread per request is simpler and fine for one site, but pays a stack and context switches for each socket.",
        },
        {
          p: "The other side promises nothing: some servers answer one byte a second and some pages are gigabytes. So every phase has its own deadline, bodies are capped at 10 MB and redirects at five.",
        },
        {
          callout:
            "A crawler fetches URLs chosen by strangers, which makes it a request-forgery engine by design. Check every resolved address against loopback, private and link-local ranges, connect to exactly the address you checked, and check again on every redirect. Raise this yourself.",
          kind: 'pitfall',
          title: 'Server-side request forgery',
        },
      ],
    },
    {
      id: 'dedupe',
      title: 'URL dedupe: have we met this one?',
      blocks: [
        {
          p: "Dedupe is two steps, and the first is easy to skip. **Canonicalise** every link into one spelling: lower-case scheme and host, default port removed, fragment dropped, relative links resolved, tracking parameters stripped. Otherwise `HTTPS://Example.org:443/news#top` and `https://example.org/news` are two pages. Keep the rules in one tested library, because normalising too hard merges different pages and too gently lets duplicates flood in.",
        },
        {
          p: "Then the seen check: 20,000 lookups a second against 10 billion URLs. Partitioned by host, each node holds about 500 million URLs and answers 1,000 lookups a second.",
        },
        {
          table: {
            head: ['Option', 'Size', 'When it is wrong', 'Choose it when'],
            rows: [
              ['Bloom filter at 1 per cent', '9.6 bits a URL: 12 GB', 'Says "seen" for 1 new URL in 100: up to 100 million pages never crawled, silently. No deletes.', 'Losing the long tail is fine, such as a training corpus'],
              ['64-bit fingerprints on local disk (chosen)', '8 bytes a URL: 80 GB, 4 GB a node', 'About three collisions in 10 billion', 'You want to delete, and misses matter'],
              ['A row lookup in the metadata store', 'No extra store', 'A network round trip per link, 20,000 a second', 'A small crawl'],
            ],
          },
          caption: 'Bloom sizing: −ln(0.01) ÷ (ln 2)² = 9.6 bits. Collisions by the birthday bound: (10¹⁰)² ÷ 2⁶⁵ is about 2.7.',
        },
        {
          callout:
            "A Bloom filter's false positive is usually a wasted disk read. Here it's a page that is never fetched, and the same URL hits the same bits every time, so nothing ever corrects it.",
          kind: 'pitfall',
          title: 'The wrong place for a Bloom filter',
        },
        {
          diagram: {
            w: 620,
            h: 350,
            nodes: [
              { id: 'url', label: 'Canonical URL', sub: 'hashed to 8 bytes', x: 250, y: 10, kind: 'client', tone: 'follow' },
              { id: 'cache', label: 'Popular-URL cache', sub: 'memory, 8 MB', x: 250, y: 100, tone: 'compare' },
              { id: 'filt', label: 'File Bloom filters', sub: 'memory, 600 MB', x: 250, y: 190, tone: 'compare' },
              { id: 'disk', label: 'RocksDB read', sub: 'seen/<slot>/<fp>', x: 250, y: 280, kind: 'store', tone: 'compare' },
              { id: 'drop', label: 'Seen: drop it', x: 460, y: 190, tone: 'muted' },
              { id: 'batch', label: 'One write batch', sub: 'seen key + queue key', x: 20, y: 250, w: 150, tone: 'ok' },
            ],
            edges: [
              { from: 'url', to: 'cache' },
              { from: 'cache', to: 'drop', label: 'hit' },
              { from: 'cache', to: 'filt', label: 'miss' },
              { from: 'filt', to: 'batch', label: 'absent' },
              { from: 'filt', to: 'disk', label: 'maybe' },
              { from: 'disk', to: 'drop', label: 'found' },
              { from: 'disk', to: 'batch', label: 'new' },
            ],
          },
          caption: "Most checks end in memory. A Bloom filter does appear, inside RocksDB, where its false positive costs one disk read and never a page. A new URL's fingerprint and queue entry go in one batch: both or neither.",
        },
        {
          p: "Menus and footers repeat on every page of a site, so a cache of a million popular fingerprints (8 MB) answers most checks. The batch matters too: a fingerprint written alone, then a crash, would mark a URL seen that was never queued.",
        },
        {
          p: "Seen keys carry the slot, `seen/<slot>/<fingerprint>`, like the queue keys. One slot is then one key range, which a snapshot can copy and a failover can move.",
        },
        {
          see: [
            { href: '#/s/bloom-filter', label: 'Bloom filter', why: 'See a false positive happen, and why it cannot be undone.' },
            { href: '#/s/hash-table', label: 'Hash table', why: 'The exact set the fingerprints stand in for.' },
          ],
        },
      ],
    },
    {
      id: 'parse',
      title: 'Parsing, near-duplicates and traps',
      blocks: [
        {
          p: "Store the raw page before anything parses it. A page costs the site a visit, and parsers have bugs. With the raw bytes kept, a parser fix means reprocessing stored pages, never fetching again.",
        },
        {
          p: "The parser is a separate sandboxed process fed over a pipe. It reads hostile input all day: tags nested fifty thousand deep, text that makes a regular expression run for minutes. A streaming tokenizer keeps memory flat whatever the nesting, at 10 to 20 ms of processor a page. Parsing inside the fetcher saves a stage, but one poison page then drops every open socket. A page that crashes the parser three times is quarantined.",
        },
        { h: 'Two fingerprints per page' },
        {
          p: "A SHA-256 of the body catches exact copies at different URLs and tells the recrawl scheduler whether the page changed. It can't catch the same article with a different advert, because one changed byte changes the whole hash. [SimHash](#/s/simhash) can: a 64-bit fingerprint where similar text gives similar bits. Pages 3 bits or fewer apart are treated as near-duplicates.",
        },
        {
          p: "Comparing two fingerprints is one XOR and a bit count. Finding near-copies among a billion is the hard part, since a scan is a billion comparisons per page. The block-table trick: split the 64 bits into 4 blocks of 16. Three differing bits can spoil at most three blocks, so two fingerprints within 3 bits must agree exactly on at least one. Keep four tables, one keyed by each block, and look the new fingerprint up in all four.",
        },
        {
          diagram: {
            w: 640,
            h: 400,
            nodes: [
              { id: 'fp', label: 'New fingerprint', sub: '64 bits', x: 250, y: 10, tone: 'follow' },
              { id: 'k1', label: 'Bits 0 to 15', sub: '2 bits differ', x: 20, y: 110, w: 120, tone: 'bad' },
              { id: 'k2', label: 'Bits 16 to 31', sub: 'identical', x: 180, y: 110, w: 120, tone: 'ok' },
              { id: 'k3', label: 'Bits 32 to 47', sub: '1 bit differs', x: 340, y: 110, w: 120, tone: 'bad' },
              { id: 'k4', label: 'Bits 48 to 63', sub: 'identical', x: 500, y: 110, w: 120, tone: 'ok' },
              { id: 't1', label: 'Table 1', sub: 'keyed by block 1', x: 20, y: 215, w: 120, kind: 'store' },
              { id: 't2', label: 'Table 2', sub: 'keyed by block 2', x: 180, y: 215, w: 120, kind: 'store' },
              { id: 't3', label: 'Table 3', sub: 'keyed by block 3', x: 340, y: 215, w: 120, kind: 'store' },
              { id: 't4', label: 'Table 4', sub: 'keyed by block 4', x: 500, y: 215, w: 120, kind: 'store' },
              { id: 'xor', label: 'XOR, count the bits', sub: 'keep if 3 or fewer', x: 230, y: 325, w: 180, tone: 'compare' },
            ],
            edges: [
              { from: 'fp', to: 'k1' },
              { from: 'fp', to: 'k2' },
              { from: 'fp', to: 'k3' },
              { from: 'fp', to: 'k4' },
              { from: 'k1', to: 't1', label: 'miss', dashed: true },
              { from: 'k2', to: 't2', label: 'hit', tone: 'ok' },
              { from: 'k3', to: 't3', label: 'miss', dashed: true },
              { from: 'k4', to: 't4', label: 'hit', tone: 'ok' },
              { from: 't2', to: 'xor', label: 'hits' },
              { from: 't4', to: 'xor' },
            ],
          },
          caption: 'A near-copy 3 bits away, seen from the new page. The differing bits fall in blocks 1 and 3, so those lookups miss it; blocks 2 and 4 match exactly and find it. With 4 blocks and 3 bits, at least one block always survives.',
        },
        {
          callout:
            "With 1 billion stored fingerprints, a 16-bit block has 65,536 values, so each lookup returns about 15,000 candidates. Four lookups give about 61,000 XORs for a page, against a billion for the scan. The price is four copies of every fingerprint: 4 × 8 bytes × 1 billion = 32 GB.",
          kind: 'example',
          title: 'The block-table sum',
        },
        {
          p: "That index is an offline job, off the fetch path. On the fetch path the design asks a smaller question: is this host producing the same page over and over? The owning node keeps each host's last 64 fingerprints in memory, 512 bytes a host, and compares the new one with each.",
        },
        { h: 'Crawler traps' },
        {
          p: "A calendar with a \"next month\" link for ever, or session identifiers in paths, makes endless URLs that are all new to the seen check. A depth cap cuts off real content and misses wide, shallow traps. Pattern rules are always one trap behind. So use a page budget and depth cap per host, counted on its owning node, plus an alarm when a host's recent fingerprints are nearly identical. That catches a trap by its effect, whatever its shape, and each alarm adds a pattern rule.",
        },
      ],
    },
    {
      id: 'storage',
      title: 'Stage 4: storage and recrawl',
      blocks: [
        {
          design: { id: 'web-crawler', lit: ['fetcher', 'parser', 'blob', 'meta', 'downstream', 'recrawl', 'frontier'], flows: ['raw', 'state', 'events', 'again', 'due'] },
          caption: 'Three outputs and one way back in. Raw pages go to the object store before parsing; the outcome goes to the metadata store; consumers get events and files, never the crawler\'s own tables.',
        },
        { h: 'Raw pages' },
        {
          p: "One object per page would be 400 uploads a second and a billion small objects a month. So fetchers buffer about 500 pages into one WARC file, 50 MB raw and 10 MB compressed, and upload it with one PUT: under one a second. Each record is compressed on its own, and its file, offset and length go to the metadata store, so a ranged GET reads one page back. The cost is that a batch lost before upload means fetching up to 500 pages again.",
        },
        { h: 'Metadata' },
        {
          p: "The metadata store is the durable record: status, ETag, hashes, next fetch time and the WARC byte range. The workload is small writes by known key with no joins, about 400 outcomes a second, growing towards 10 billion rows at 300 bytes: 3 TB, 9 TB with three replicas. That suits a wide-column store such as Cassandra. PostgreSQL is right for one site and struggles at this row count.",
        },
        {
          p: "Every write is an upsert keyed by URL and stamped with the fetch time. Writing twice changes nothing, and a late retry of an older outcome loses.",
        },
        {
          callout:
            "\"I choose at-least-once delivery with idempotent writes over exactly-once. Leases can expire and a page can be fetched twice. Because every write downstream is an upsert by key, the only cost is a rare repeated fetch.\"",
          kind: 'interview',
        },
        {
          p: "Hosts need a durable row too: the page budget, the error streak, whether an operator has paused the host. That's a small `hosts` table, 50 million rows at about 200 bytes, 10 GB. Pacing state (next allowed time, current delay) stays in the frontier.",
        },
        { h: 'Recrawl' },
        {
          p: "Revisiting everything on one timer spends the budget on pages that never change. Start with fixed tiers (news hourly, most pages monthly), which need no history. Move to an adaptive interval once there's data: halve it when the content hash changed, lengthen it when it didn't.",
        },
        {
          p: "Finding what's due mustn't scan 10 billion rows. A second table, `urls_due`, is partitioned by hour and slot, with rows sorted by due time. At most 400 × 3,600 = 1.44 million URLs fall due in an hour; spread over 1,024 slots that's about 1,400 rows a partition. The scheduler reads a slot's partition and calls Enqueue on its owner. Once an hour has been handed out its partitions are deleted whole, so the table stays about an hour or two deep.",
        },
        {
          p: "Recrawls send the saved ETag and date. An unchanged page answers 304 with no body, so a wasted visit costs almost nothing. What still breaks: a scheduler bug floods the frontier with old work, so cap the share of each host's budget that recrawl may take.",
        },
      ],
    },
    {
      id: 'partitioning',
      title: 'Stage 5: twenty nodes',
      blocks: [
        {
          p: "Partition by host, not by URL. Then everything about a host (its queue, its rate limit, its robots rules, its seen fingerprints) lives on one node, and politeness needs no locks.",
        },
        {
          table: {
            head: ['Scheme', 'Adding a node', 'Paused node that wakes up', 'Verdict'],
            rows: [
              ['hash(host) mod 20', 'Moves almost every host', 'No defence', 'One line, and wrong'],
              ['Consistent hash ring, no coordinator', 'Moves about 1 host in 20', 'Two nodes can each believe they own a host', 'Nothing central to fail; hard to fence'],
              ['1,024 fixed slots mapped by a coordinator (chosen)', 'Moves about 51 slots, each an explicit versioned step', 'Refused: its epoch is old', 'Needs a consensus cluster'],
            ],
          },
          caption: 'The middle column is about cost. The right-hand one is about safety, and it decides.',
        },
        {
          diagram: {
            w: 640,
            h: 300,
            nodes: [
              { id: 'host', label: 'example.org', x: 250, y: 10, h: 44, kind: 'client', tone: 'follow' },
              { id: 'slot', label: 'Slot 417', sub: 'hash(host) mod 1,024', x: 240, y: 104, w: 160 },
              { id: 'map', label: 'Slot map', sub: 'crawler-07, epoch 7', x: 20, y: 224, w: 130, kind: 'store' },
              { id: 'part', label: 'Kafka partition', sub: 'discovered-urls 417', x: 175, y: 224, w: 135, kind: 'queue' },
              { id: 'keys', label: 'RocksDB range', sub: 'queue/417/, seen/417/', x: 335, y: 224, w: 140, kind: 'store' },
              { id: 'snap', label: 'Snapshot folder', sub: 'slot-0417/', x: 500, y: 224, w: 125, kind: 'store' },
            ],
            edges: [
              { from: 'host', to: 'slot' },
              { from: 'slot', to: 'map' },
              { from: 'slot', to: 'part' },
              { from: 'slot', to: 'keys' },
              { from: 'slot', to: 'snap' },
            ],
          },
          caption: "One number, four uses. The slot names the owner, the topic partition, the key range on disk and the snapshot folder, so moving a slot moves a host's whole world in one step.",
        },
        {
          p: "A parsed link whose host is in one of this node's slots goes straight to the local seen check. Any other is produced to a Kafka topic, `discovered-urls`, with partition equal to slot. Most links stay on their own site. If one in five points elsewhere (an assumption), that's about 4,000 messages a second.",
        },
        {
          design: { id: 'web-crawler', lit: ['filter', 'seen', 'kafka', 'coord', 'frontier'], flows: ['local', 'cross', 'inbound', 'coord'] },
          caption: 'Two paths out of the URL filter. Local links never touch the network. Foreign links ride the log to their owner, whose seen check makes repeats harmless.',
        },
        {
          p: "Kafka is here for transport and replay only. Direct calls between nodes would save the brokers and hand you retries and buffering to build. Each node assigns itself the partitions of its slots from the coordinator's map. It doesn't use a consumer group, so the broker can never disagree with the coordinator about who owns a host.",
        },
        {
          p: "The coordinator is a small etcd or ZooKeeper cluster holding the slot map. Each node holds a 30-second lease and renews it every 10 seconds, so it can miss two renewals before losing its slots. If the coordinator is unreachable, nodes pause.",
        },
        {
          see: [
            { href: '#/s/consistent-hashing', label: 'Consistent hash ring', why: 'The alternative: what moves when a node joins.' },
            { href: '#/s/partitioning', label: 'Partitioning', why: 'Hash against range, and which queries stay on one node.' },
            { href: '#/s/append-log', label: 'Append-only log', why: 'Offsets and replay, the property the failover relies on.' },
          ],
        },
      ],
    },
    {
      id: 'failure',
      title: 'The failure: a lease runs out',
      blocks: [
        {
          p: "Tell this story unprompted. crawler-07 owns slot 417 and 50 others. It renews at 10:56:30 and dies. Its frontier, fingerprints and robots cache were on its local disk and in its memory.",
        },
        {
          p: "Someone must take over its hosts, or they stop being crawled. But a node that looks dead may only be paused, and wake up still believing it owns them. Two fetchers on one host breaks the promise the design makes to site owners.",
        },
        {
          sequence: {
            actors: ['crawler-07', 'Coordinator', 'crawler-12', 'Object store', 'Kafka'],
            messages: [
              { from: 'crawler-07', to: 'Coordinator', label: 'renew lease, 10:56:30', note: 'crawler-07 dies just after' },
              { from: 'Coordinator', to: 'crawler-12', label: 'slot 417 is yours, epoch 8', tone: 'ok', note: '10:57:00: 30 s with no renewal' },
              { from: 'crawler-12', to: 'Object store', label: 'newest snapshot of slot 417?' },
              { from: 'Object store', to: 'crawler-12', label: 'queues, seen keys, offset 88214305' },
              { from: 'crawler-12', to: 'Kafka', label: 'read partition 417 from that offset' },
              { from: 'Kafka', to: 'crawler-12', label: 'links sent since the snapshot', note: 'then wait a margin for clock drift' },
              { from: 'crawler-07', to: 'Coordinator', label: 'renew (it was only paused)', dashed: true },
              { from: 'Coordinator', to: 'crawler-07', label: 'refused: lease expired', tone: 'bad', note: 'it stops leasing URLs and drops the slot' },
            ],
          },
          caption: "The epoch is what makes this safe. crawler-12 holds epoch 8; anything crawler-07 still sends carries 7 and is refused. The new owner fetches only after the old lease has certainly ended on both clocks.",
        },
        {
          design: { id: 'web-crawler', lit: ['coord', 'blob', 'frontier', 'kafka', 'seen'], flows: ['coord', 'snapshot', 'inbound', 'new'] },
          caption: 'The recovery paths, usually hidden on the design page. State comes back from two places: a snapshot in the object store, and the log from the offset saved with it.',
        },
        { h: 'How often to snapshot' },
        {
          p: "A snapshot of one slot is its queue keys, host state and seen fingerprints, with the topic offset in a manifest written last. That's about 300 MB of queue plus 80 MB of fingerprints. A node's 51 slots come to 19 GB.",
        },
        {
          p: "Copying 19 GB every five minutes is 63 MB a second, about 500 Mbit/s, more than ten times the 40 Mbit/s the node spends on pages. Copying it once an hour, one slot every 70 seconds, is 5 MB a second, about as much as the crawl itself. This page picks hourly full copies. Uploading only the files RocksDB has added since the last copy would bring the interval back to minutes, at the price of more recovery code.",
        },
        {
          p: "An older snapshot loses nothing, and here's why. URLs fetched since the snapshot are still in its queue, so they're fetched again and their links are found again. Links from other nodes are replayed from the topic. The cost is repeated fetches: a node averages 20 pages a second, so a failover repeats at most 72,000 fetches spread over its hosts, each still paced by its own delay.",
        },
        { h: 'What can still go wrong' },
        {
          list: [
            "The dead node's hosts go unfetched for the 30-second lease, the drift margin and the restore: about a minute.",
            "Recrawl enqueues made since the snapshot are gone, so the scheduler re-sends the last hour's due partitions for any slot that moves.",
            "Robots rules were in memory only, so the new owner fetches robots.txt again for each host before its first page.",
            "If no snapshot is usable, the metadata store is the last resort: a scan of every row to find one node's share.",
          ],
        },
        {
          callout:
            "Fail closed. A lost lease or a coordinator outage means pause, never two owners. And treat failure as states you can name (queued, leased, fetched, waiting to retry, dead), not as an afterthought.",
          kind: 'rule',
        },
        {
          see: [
            { href: '#/s/raft', label: 'Raft', why: 'How the coordinator agrees on one owner per slot.' },
            { href: '#/s/stream-checkpoints', label: 'Stream checkpoints', why: 'The same idea: state and log offset saved together.' },
          ],
        },
      ],
    },
    {
      id: 'operating',
      title: 'Operating it',
      blocks: [
        {
          p: "Watch four things. Politeness violations (overlapping requests to a host, gaps shorter than its delay, fetches its rules disallow), with a target of zero. Pages fetched a second against the 400 target. Lag on each `discovered-urls` partition. And the share of fetches that are repeats, which shows lease deadlines set too short.",
        },
        {
          table: {
            head: ['What happens', 'What the design does'],
            rows: [
              ['A site starts answering 429', 'Honour Retry-After or double the delay; recover slowly; pause the host for hours after many errors in a row'],
              ['DNS stops answering', 'Identical lookups merge, the breaker opens, fetchers skip unresolved hosts and work on the rest'],
              ['The object store is down', 'Buffer to local disk, then stop fetching. Never drop a page a site has already paid to serve.'],
              ['The metadata store is down', "Buffer outcomes, then stop. Fetching pages whose outcome you can't record wastes each host's budget."],
              ['One enormous site', "A backlog, not a hot spot. Politeness caps it at about a request a second whatever its size. Give it a slot of its own."],
            ],
          },
          caption: 'Every row slows or stops. None speeds up or drops data, and that asymmetry is the thing to point out.',
        },
        {
          p: "Identify yourself: a stable User-Agent with a contact address and a page explaining how to opt out.",
        },
        {
          p: "Rendering stays out of the first version. A headless browser costs ten to a hundred times a plain fetch and is the largest attack surface in the system. Later, a small sandboxed pool renders only the pages whose HTML body is almost empty.",
        },
      ],
    },
    {
      id: 'pacing',
      title: 'Pacing the interview',
      blocks: [
        {
          table: {
            head: ['Minutes', 'Do', 'Draw'],
            rows: [
              ['0 to 5', 'Ask the four questions. State the requirements and what is out of scope.', 'Nothing'],
              ['5 to 10', 'The sums: 400 a second, 20 nodes, 86,400 pages a day a host', 'The numbers in a corner'],
              ['10 to 15', "The loop, and the list of what's wrong with it", 'Stage 1'],
              ['15 to 30', 'Frontier and politeness, then the seen check. This is where the marks are.', 'Stages 2 and 3, the two queues'],
              ['30 to 40', 'Partition by host, the log between nodes, the lease running out', 'Stage 5, the takeover'],
              ['40 to 50', 'Storage, recrawl, near-duplicates and traps, at whatever depth is asked', 'Stage 4'],
              ['Last 5', 'The trade-offs you made, and what you would build first', 'Nothing'],
            ],
          },
          caption: 'For a 45-minute slot, shorten the 40 to 50 row to a few sentences and keep the failure story.',
        },
        {
          p: "If time runs short, protect the frontier, dedupe and the failure. Those three separate this answer from a queue with workers.",
        },
        {
          table: {
            head: ['Decision', 'The call', 'The price'],
            rows: [
              ['Where politeness lives', 'In a frontier partitioned by host', 'Custom stateful code, snapshots and replay'],
              ['URL-seen set', '64-bit fingerprints on disk', '80 GB against 12 GB for a Bloom filter'],
              ['Delivery', 'At-least-once with idempotent upserts', 'A rare repeated fetch'],
              ['What the log is for', 'Transport and replay only', 'The frontier still has to be built'],
              ['Ownership', 'Leases and epochs from a coordinator', 'About a minute of silence per failover, and a dependency'],
            ],
          },
          caption: 'The closing summary, in the form to say it: the call, then what it cost.',
        },
        {
          callout:
            "\"I'd build it in four steps. One machine with the two-level frontier and the seen set. Then partitioning, the log and the coordinator. Then quality: priorities, adaptive recrawl, near-duplicate detection. Rendering last, and only if the product needs it.\"",
          kind: 'interview',
          title: 'Close with this',
        },
        {
          see: [{ href: '#/d/web-crawler', label: 'The design page', why: 'Follow one URL round all 14 steps, and open any box for its tables and queries.' }],
        },
      ],
    },
  ],
  unverified: [
    'Mercator found DNS lookups took 87 per cent of each thread\'s time (design page; not on this page as a figure, but the DNS argument rests on it).',
    'The rule of thumb of about three back queues per fetcher, attributed on the design page to Manning, Raghavan and Schütze.',
    '"Ten times the last response time" as a politeness gap, attributed on the design page to the Mercator line of work.',
    'RFC 9309 detail: cache robots.txt for at most 24 hours; 4xx means no restrictions; 5xx or no answer means disallow everything.',
    'SimHash at 64 bits with a 3-bit threshold, from Manku, Jain and Das Sarma (2007), and that their tables give the same candidates as four maps keyed by 16-bit blocks.',
    'HTML compressing about 5 to 1, 100 KB as an average page, 50 links a page, 20 pages a host: all assumptions.',
    'That one link in five points to another host (this page\'s assumption, used for the 4,000 messages a second on Kafka).',
    'That a Kafka consumer-group rebalance can leave two consumers briefly holding one partition, the reason given for assigning partitions by hand.',
    'RocksDB per-file Bloom filters at about 10 bits a key (the 600 MB a node), and that a snapshot can upload only newly added files.',
    'A headless browser costing ten to a hundred times a plain fetch.',
    'Sizes that follow from assumed row sizes: 150 bytes a frontier entry, 300 bytes a metadata row, 200 bytes a host row.',
    'The restore taking well under a minute: about 380 MB per slot at local network speeds, not measured.',
  ],
};

export default page;
