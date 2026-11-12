import type { Design } from './types';

/**
 * Distributed web crawler, as a high-level design.
 *
 * The baseline is a continuous, polite crawl of about a billion pages a month:
 * a host-partitioned frontier on each crawler node, stateless fetchers and
 * parsers around it, and shared services for DNS, robots.txt, coordination and
 * storage. The alternatives on each component include the queue-centred design
 * (SQS, DynamoDB, Redis locks) often given for a one-off crawl.
 */
export const webCrawler: Design = {
  id: 'web-crawler',
  name: 'Distributed web crawler',
  blurb: 'Follow one URL round the crawl loop, then open any part to see what it does and what you could use instead.',
  rest: 'Press Play to follow one URL, or open any box or chip. In the diagram, arrow keys move and Enter opens.',
  restTouch: 'Press Play to follow one URL, or tap any box or chip to open it.',
  size: { w: 1280, h: 603 },
  frame: { x: 222, y: 76, w: 818, h: 290, label: 'Crawler node × 20', note: 'Inside a node: in-process calls' },

  components: [
    {
      id: 'seeds',
      name: 'Seeds',
      tech: 'sitemaps, API',
      x: 70, y: 148, w: 130, h: 56, kind: 'input',
      what: 'The crawl starts from a list of known-good sites, their sitemaps, and URLs an operator adds. Everything else is found by following links.',
      why: 'Seeds decide what the crawl can ever reach, and their quality sets the quality of the first few hops. The API is audited, and every seed carries a priority.',
      built: [
        { name: 'Sitemaps', what: 'A file a site publishes listing its URLs, often with the date each last changed. A job here reads the sitemaps of seed sites and posts the URLs it finds to the seeds API.', why: 'They hand over new and changed URLs without fetching and parsing a page. They can be stale or wrong, so the design treats them as hints, never as the truth.' },
        { name: 'Seeds API', what: 'A small internal web service, POST /v1/seeds, that operators and the sitemap job call to add starting URLs. It makes each URL canonical, records who added it and why, and queues it on the node that owns its host.', why: 'Seeds decide what the crawl can ever reach, so every change is audited and reviewed like code. A file dropped in a bucket would give the caller no answer about bad URLs and a weaker audit trail. Posting a seed twice queues it once, so callers can retry.' },
      ],
      fails: 'A poor seed list walks the crawl straight into link farms. Review it like code, and keep a per-domain kill switch beside it.',
      alternatives: [
        {
          name: 'Curated seed list plus sitemaps', chosen: true, good: 'Predictable coverage, and sitemaps hand you fresh URLs without parsing a page.', cost: 'Someone has to own the list. Sitemaps can be stale or wrong, so treat them as hints.',
          what: 'A reviewed list of known-good sites, each with a priority, posted through the audited seeds API. A job reads their sitemaps and posts the URLs it finds. It fits a continuous crawl because the list changes slowly and every change is recorded.',
          pros: ['Coverage is a decision someone made, not an accident of who links to whom.', 'Sitemaps hand over new and changed URLs without fetching and parsing a page.', 'Each seed carries a priority, so the first hops are spent on good sites.', 'The audit trail and the per-domain kill switch sit in one place.'],
          cons: ['Someone has to own and review the list, like code.', 'Sitemaps can be stale or wrong, so they are only hints.', 'Anything the list and its links never reach is never crawled.'],
        },
        {
          name: 'Start from an existing crawl', good: "Common Crawl's URL index gives billions of starting points when you only need the pages.", cost: 'You inherit its coverage and its age.',
          what: "Load URLs from Common Crawl's URL index and post them as seeds, ranked by whatever signal the index offers. The frontier starts with billions of URLs on day one instead of growing outward from a short list.",
          pros: ['Billions of starting points at once, with no discovery phase.', 'Good when you want the pages, not the act of finding them, such as a training corpus.', 'No list for anyone to curate.'],
          cons: ['You inherit its coverage, its gaps and its age.', 'Many of its URLs will be dead or moved, which costs fetches and politeness budget.', 'For a crawl meant to stay fresh it is only a starting point; this design still needs its own seeds.'],
        },
        {
          name: 'One root URL', good: 'Right for the single-site version of this question.', cost: 'Reaches only what that site links to.',
          what: 'Start from one home page and follow links, usually staying inside that one site. This is the single-site version of the question, on one machine, with a visited set and one rate limiter.',
          pros: ['Nothing to curate or explain.', 'Right for the single-site version of this question.', 'Scope is obvious: the crawl ends when the queue is empty and nothing is in flight.'],
          cons: ['Reaches only what that site links to.', 'One site at 1 request a second gives at most 86,400 pages a day, so it cannot feed a crawl of a billion pages a month.'],
        },
        {
          name: 'Seeds from usage signals', good: 'Search logs, submitted URLs or links shared by users point at pages people want.', cost: 'Noisy and open to abuse, so it needs the same review as any seed.',
          what: 'Take seeds from what people use: URLs in search logs, URLs site owners submit, links shared in a product. They go through the same seeds API with a lower priority than the curated list.',
          pros: ['Points the crawl at pages people actually want.', 'Finds new sites before anything links to them.', 'Fits a crawl that serves a search product.'],
          cons: ['Open to spam: anyone can submit a link farm.', 'Needs a product with users before it gives anything.', 'Adds privacy questions if the URLs come from logs.'],
        },
      ],
      say: 'Before choosing seeds I would ask what the crawl is for. Search, archive, monitoring and training data each want different coverage and freshness.',
    },
    {
      id: 'recrawl',
      name: 'Recrawl scheduler',
      tech: 'next_fetch_at',
      short: 'Recrawl',
      x: 70, y: 214, w: 130, h: 56, kind: 'input',
      what: 'Feeds URLs back into the frontier when they are due again. Each URL carries a next fetch time, set from how often the page has changed in the past.',
      why: 'A crawl that never revisits goes stale within weeks. One that revisits everything on a fixed timer wastes most of its budget on pages that never change.',
      built: [
        { name: 'next_fetch_at', what: 'A column on each URL\'s row in the metadata store: the time the page should next be fetched. It is set after every fetch from how often the page has changed before.', why: 'Visits go where a change is likely: a change halves the interval, no change lengthens it. It needs no new store, being one more column written with the outcome, and a second table keyed by the hour it falls in lets the scheduler read what is due without a scan of 10 billion rows.' },
        { name: 'Conditional requests', what: 'HTTP headers that ask the server to send the page only if it changed: If-None-Match with the saved ETag, If-Modified-Since with the saved date. An unchanged page answers 304 with headers and no body.', why: 'They make a wasted revisit almost free: a 304 against about 100 KB for a full page. That is what lets the scheduler err towards visiting.' },
      ],
      numbers: [{ text: 'Conditional requests (ETag, If-Modified-Since) turn an unchanged page into a small 304 reply.', from: 'No sum: this is how HTTP works. The fetcher sends the ETag or date saved from the last fetch; an unchanged page answers 304 with headers and no body, against about 100 KB for a full page (the page size in "Numbers to have ready").' }],
      fails: 'A bug here floods the frontier with work that is not new. Cap how much of each host\'s budget recrawl may take.',
      alternatives: [
        {
          name: 'Adaptive interval per URL', chosen: true, good: 'Spends visits where a change is likely. Halve the interval when the page changed, lengthen it when it did not.', cost: 'Needs history, and the estimate is noisy for pages seen only a few times.',
          what: 'Each URL in the metadata store carries a next fetch time. After every fetch the parser compares content hashes: a change halves the interval, no change lengthens it. The scheduler range-reads due URLs by time bucket and enqueues them.',
          pros: ['Spends visits where a change is likely, not on pages that never move.', 'Needs no new store: the next fetch time is one more column, written with the outcome.', 'Pairs with conditional requests, so a wasted visit is a 304 and costs almost nothing.'],
          cons: ['Needs history, and the estimate is noisy for pages seen only a few times.', 'A page that suddenly starts changing is caught late.', 'A bug here floods the frontier, so recrawl needs a cap on each host\'s budget.'],
        },
        {
          name: 'Fixed tiers', good: 'Simple and predictable: news hourly, most pages monthly. A good first version.', cost: 'Stale for fast pages and wasteful for slow ones.',
          what: 'Put each site or page into a tier by hand or by rule: news hourly, most pages monthly. The scheduler reads the same time buckets, but the interval comes from the tier, not from history.',
          pros: ['Simple and predictable, and easy to explain.', 'Works from day one with no history.', 'Load is easy to forecast: tier size divided by its interval.', 'A good first version; the Say line starts here.'],
          cons: ['Stale for fast pages and wasteful for slow ones.', 'Someone has to keep the tier rules up to date.', 'Passed over once there is enough history to estimate change rates.'],
        },
        {
          name: 'No recrawl', good: 'Right for a one-off crawl, such as gathering text for model training.', cost: 'The corpus is a snapshot.',
          what: 'Fetch each URL once and never come back. The scheduler, the next fetch time and the conditional requests all go away.',
          pros: ['Right for a one-off crawl, such as gathering text for model training.', 'One box and one connection fewer.', 'The whole fetch budget goes on new pages.'],
          cons: ['The corpus is a snapshot and goes stale within weeks.', 'This design is a continuous crawl, so it cannot drop revisits.'],
        },
      ],
      say: 'I would start with fixed tiers and move to change-rate estimates once there is data to justify them.',
    },
    {
      id: 'frontier',
      name: 'URL frontier',
      tech: 'RocksDB + memory',
      x: 334, y: 172, w: 180, h: 116, kind: 'node',
      lines: ['front: by priority', 'back: one per host', 'heap: next times'],
      what: 'The scheduler. It answers two questions at once: what should be fetched next, and when may this host be contacted again. Front queues order URLs by priority. Each back queue holds one host. A min-heap keeps the next allowed time for every host, and a fetcher is only handed a URL whose host timer has run out.',
      why: 'A plain first-in-first-out queue fails at once. Links cluster by host, so the next thousand URLs are often one site: you either hammer it or leave every worker idle. Keeping the frontier on the node that owns the host makes politeness a local decision with no locks.',
      built: [
        { name: 'RocksDB', what: 'An embedded key-value store: a library that runs inside the crawler process and keeps sorted keys on local disk. It is built on a log-structured merge tree (LSM tree), which turns random writes into sequential ones.', why: 'The frontier takes many small writes a second and must survive a restart, at about 15 GB a node. An embedded store gives that with no network hop, and because the seen set lives in the same store, a fingerprint and a queue entry go in one write batch. Redis or Postgres would put a network round trip on every decision and hold 300 GB centrally.' },
        { name: 'Memory', what: 'Part of the frontier is held in the process\'s memory, in front of RocksDB, so that the decision about what to hand out next does not wait on disk.', why: 'Hand-outs happen about 50 times a second a node and must be quick. All 2 billion pending URLs, about 300 GB, cannot sit in memory, so only part of it does.' },
        { name: 'Front queues, by priority', what: 'Several queues that order URLs by how much they matter. URLs move from them into the back queues.', why: 'Priority (what matters) is kept apart from politeness (when a host may be visited), so good pages are not stuck behind link farms and neither question starves the other.' },
        { name: 'Back queues, one per host', what: 'A queue per host holding that host\'s waiting URLs. The frontier can hold one host back while serving others.', why: 'One host per back queue makes one request in flight per host true by construction, with no locks. About three back queues per fetch slot, about 150 a node, keeps fetchers busy: a rule of thumb from the Manning, Raghavan and Schütze textbook.' },
        { name: 'Heap of next times', what: 'A binary min-heap: a tree kept in an array that always gives its smallest value first. Each entry is a host and the earliest time it may be contacted again.', why: 'Finding the next host whose wait is over is one look at the top, and moving a host\'s time takes a few steps however many hosts the node has. A scan of every host on each of about 50 hand-outs a second would cost far more.' },
      ],
      numbers: [
        { text: 'About 2 billion pending URLs, roughly 300 GB on disk, 15 GB per node.', from: '2 billion pending is an assumption: about two months of work at 1 billion fetches a month, out of the 10 billion known URLs in "Numbers to have ready". 2 billion × about 150 bytes an entry = 300 GB; 300 GB ÷ 20 nodes = 15 GB. The 150 bytes (the URL, its priority, host and times) is an assumption.' },
        { text: 'About three back queues for every fetch slot keeps fetchers busy.', from: 'A rule of thumb from the Manning, Raghavan and Schütze textbook named in the glossary. With 1,000 fetches in flight over 20 nodes, each node has about 50 fetch slots, so about 150 back queues.' },
        { text: 'Each hand-out is a lease with a deadline. If the worker dies, the URL goes back in the queue.', from: 'Not a sum: a rule of the design. The page sets no deadline; it only has to be well above the 1 second a fetch takes on average.' },
      ],
      fails: 'The node dies and its disk with it. Another node takes over its slots, restores the frontier from the last snapshot in the object store and replays the discovered-urls topic. The metadata store is the last resort.',
      alternatives: [
        {
          name: 'Host-partitioned frontier inside each node', chosen: true, good: 'One request in flight per host is true by construction. No network hop to decide what to fetch.', cost: 'It is custom, stateful code, and recovery needs snapshots and replay.',
          what: 'Each node owns about 51 of the 1,024 slots and keeps the frontier for their hosts in RocksDB and memory: front queues by priority, one back queue per host, a heap of next allowed times. Politeness becomes a local decision with no locks.',
          pros: ['One request in flight per host is true by construction.', 'No network hop to decide what to fetch: leases are in-process calls.', 'Priority and politeness are separate, so neither starves the other.', 'About 15 GB a node fits on local SSD.'],
          cons: ['Custom, stateful code that you build and test yourself.', 'Recovery needs snapshots to the object store and replay of the topic.', 'Needs a coordinator so that each slot has exactly one owner.'],
        },
        {
          name: 'A managed queue as the frontier (SQS)', good: 'Visibility timeouts give retries with back-off, and a dead-letter queue catches hopeless URLs. Enough for a one-off crawl.', cost: 'A queue cannot hold one host back while serving another, or reorder by priority. Politeness then needs a lock per domain and a re-queue on every miss.',
          what: 'All pending URLs go into one managed queue. Fetchers receive messages; the visibility timeout plays the lease, and a dead-letter queue catches URLs that keep failing. This is the queue-centred design used for a one-off crawl.',
          pros: ['No frontier code, no snapshots, no brokers to run.', 'Visibility timeouts give retries with back-off for free.', 'A dead-letter queue catches hopeless URLs.', 'Enough for a one-off crawl where nothing is revisited.'],
          cons: ['Cannot hold one host back while serving another.', 'No priority order, so good pages wait behind link farms.', 'Politeness needs a lock per domain and a re-queue on every miss, which wastes receives on busy hosts.'],
        },
        {
          name: 'Redis sorted set keyed by next fetch time', good: 'One place to reason about, and easy to build.', cost: 'Hundreds of millions of pending URLs held in memory, hot keys, and a network round trip per decision.',
          what: 'Hosts sit in a sorted set scored by their next allowed time, with a list of URLs per host. A fetcher pops the earliest due host, takes a URL and pushes the host back with a new score.',
          pros: ['One place to reason about, and easy to build.', 'The sorted set is the heap, with no code of your own.', 'Fetchers stay stateless and any of them can serve any host.'],
          cons: ['2 billion pending URLs (about 300 GB) would have to sit in memory.', 'A network round trip per decision, at about 1,000 a second.', 'Hot keys, and a single dependency every fetch waits on.'],
        },
        {
          name: 'Postgres with SKIP LOCKED', good: 'Fine at small scale and easy to query.', cost: 'About 1,000 dequeues and 50,000 inserts a second means lock and vacuum trouble.',
          what: 'Pending URLs are rows with a host and a due time. A fetcher selects the next due row with FOR UPDATE SKIP LOCKED, so two fetchers never take the same one, and deletes or updates it when done.',
          pros: ['Fine at small scale, and easy to query and debug.', 'Transactions make the seen check and the enqueue one step.', 'One system for queue and metadata in a single-site crawl.'],
          cons: ['About 1,000 dequeues and 50,000 inserts a second means lock and vacuum trouble.', 'Politeness per host still needs its own table or locks.', 'Sharding it by host rebuilds the partitioned frontier with more moving parts.'],
        },
      ],
      say: 'Kafka is good plumbing between stages, but it cannot be the frontier. It cannot delay one host while serving another. The frontier is a scheduler, so I would build it.',
      see: [
        { id: 'crawl-frontier', label: 'Crawl frontier' },
        { id: 'heap', label: 'Binary heap' },
        { id: 'priority-queue', label: 'Priority queue' },
        { id: 'lsm-tree', label: 'LSM tree (RocksDB)' },
      ],
    },
    {
      id: 'fetcher',
      name: 'Fetchers',
      tech: 'async HTTP',
      x: 640, y: 176, w: 150, h: 60, kind: 'node',
      what: 'Take a leased URL, resolve its host, check robots.txt, check the address is not private, then make the request with strict timeouts, a 10 MB cap and at most five redirects. On a recrawl they send conditional headers.',
      why: 'Fetching is input and output bound: thousands of open sockets and almost no processor time. Parsing is the opposite. Keeping them apart lets each scale and fail on its own.',
      built: [
        { name: 'Async HTTP', what: 'HTTP requests made from an event loop: one process opens many connections and waits on all of them at once, instead of one thread blocking per request.', why: 'Fetching is mostly waiting: about 1,000 requests in flight across the crawl, about 50 a node, each about 1 second. An event loop holds thousands of sockets per process for little memory each, where a thread per request pays a stack and context switches for every one.' },
        { name: 'Private-address check', what: 'Before connecting, the resolved address is checked against loopback, private and link-local ranges, and the fetcher then connects to exactly that address. Every redirect target is resolved and checked again.', why: 'A crawler fetches URLs chosen by strangers, so without the check anyone could make it read internal pages or cloud metadata (server-side request forgery).' },
      ],
      numbers: [
        { text: 'About 1 second per fetch, so about 1,000 requests in flight at the 1,000 a second built for (rate times latency).', from: "Little's law: 1,000 fetches a second × about 1 second each = about 1,000 open at once. The 1,000 a second is the build target in \"Numbers to have ready\" (about 400 average, with headroom). The 1 second is an assumption: lookup, connect, TLS and about 100 KB from a distant server take several round trips." },
        { text: 'About 50 pages a second per node.', from: 'The assumption in "Numbers to have ready", which gives 1,000 ÷ 50 = 20 nodes. It is modest: at 10 to 20 milliseconds of parsing a page, one core parses 50 to 100 pages a second, and 50 pages × 100 KB is about 40 Mbit/s a node.' },
      ],
      fails: 'Slow or hostile servers hold sockets open for ever, so every phase has a deadline. On a 429 or 503, honour Retry-After, otherwise double the host\'s delay and shorten it slowly after successes. Many errors in a row pause the host for hours.',
      alternatives: [
        {
          name: 'Event-loop fetchers, many small nodes', chosen: true, good: 'Thousands of sockets per process, cheap to add and lose.', cost: 'Back-pressure has to be designed, not assumed.',
          what: 'Each of the 20 nodes runs fetchers on an event loop: one process holds many open sockets and waits on all of them at once. A node carries about 50 fetches in flight, well inside what one event loop can hold.',
          pros: ['Thousands of sockets per process for almost no memory each.', 'Cheap to add and to lose: a dead node costs about 5 per cent of the crawl.', 'Sits beside the frontier, so leases never cross the network.'],
          cons: ['Back-pressure has to be designed, not assumed: a slow parser or object store must stop new leases.', 'Every phase needs its own deadline, or slow servers pin sockets.', 'Callback or async code is harder to read than one thread per request.'],
        },
        {
          name: 'A few very large network-optimised machines', good: 'For a one-off crawl of 10 billion pages in five days at about 100 KB a page: 1 PB in 432,000 seconds, about 18.5 Gbit/s. One 200 Gbit/s instance carries that bandwidth; two or three give a spare and room for slow sites.', cost: 'Each machine is a large blast radius, and the estimate needs load testing.',
          what: 'Run the fetchers on two or three machines with very fast network cards, fed from a shared queue. This is the one-off framing: 10 billion pages in five days at 100 KB is 1 PB in 432,000 seconds, about 18.5 Gbit/s.',
          pros: ['Few machines to deploy and watch.', 'One 200 Gbit/s instance carries 18.5 Gbit/s with room to spare.', 'Fits a short, one-off crawl with a deadline.'],
          cons: ['Each machine is a large blast radius: losing one loses a third or half of the crawl.', 'Bandwidth is rarely the limit; politeness and DNS are, so the estimate needs load testing.', 'For this design, 400 pages a second needs about 320 Mbit/s, so big machines buy nothing.'],
        },
        {
          name: 'A thread per request', good: 'Simple code.', cost: 'Memory and context switching at thousands of concurrent fetches.',
          what: 'Each fetch runs on its own thread with blocking calls: resolve, connect, read, return. 1,000 fetches in flight means about 1,000 threads across the crawl.',
          pros: ['Simple, straight-line code that is easy to debug.', 'Fine for the single-site crawl, where a few threads do.', 'Timeouts can use the standard library as it is.'],
          cons: ['Each thread holds its own stack, so memory grows with sockets.', 'Context switching costs grow at thousands of concurrent fetches.', 'Blocking DNS calls hold a thread each, the problem Mercator measured.'],
        },
        {
          name: 'A separate fetcher pool behind gRPC', good: 'Fetchers scale on their own, apart from frontiers.', cost: 'A network hop on every lease, and a second fleet to run.',
          what: 'Fetchers run as their own fleet and call Lease and Complete on the frontier nodes over gRPC. The frontier still owns politeness; only the hand-out crosses the network.',
          pros: ['Fetch capacity scales without moving any slots.', 'A fetcher crash never touches frontier state.', 'Different machine shapes for sockets and for storage.'],
          cons: ['A network hop on every lease and every completion, about 1,000 a second each way.', 'A second fleet to deploy, size and watch.', 'At 20 nodes there is no need: in-process leases are simpler.'],
        },
      ],
      say: 'A crawler fetches URLs chosen by strangers, so it is a request-forgery engine by design. I check every resolved address against private ranges, connect to exactly that address, and check again on each redirect.',
    },
    {
      id: 'dns',
      name: 'DNS resolver',
      tech: 'caching resolvers',
      x: 540, y: 35, w: 160, h: 56, kind: 'shared',
      what: 'Turns host names into addresses for every fetcher, with a shared cache and many lookups in flight at once.',
      why: 'It is the hidden bottleneck. An uncached lookup takes tens to hundreds of milliseconds, and standard library resolvers can block a thread each. The Mercator crawler found lookups took 87 per cent of each thread\'s time until its authors wrote their own resolver, which cut that to 25 per cent.',
      built: [
        { name: 'DNS', what: 'The Domain Name System: the internet\'s directory from names such as example.org to addresses such as 203.0.113.27. Here queries go over UDP, one small packet each way.', why: 'Every fetch needs an address first, which makes DNS the hidden bottleneck of a crawler. It is also where the private-address check starts.' },
        { name: 'Caching resolvers', what: 'DNS servers that answer lookups and remember each answer for as long as it allows. Here one runs on each machine or rack beside the fetchers, with more than one outside provider upstream.', why: 'Without a cache every fetch pays a lookup of tens to hundreds of milliseconds, at most 400 a second; with one, each host is resolved about once per answer lifetime, tens a second. Running it locally keeps the round trip in the rack, merges duplicate lookups, and avoids the blocking standard library call that Mercator found took 87 per cent of each thread\'s time.' },
      ],
      numbers: [{ text: 'About 50 million hosts a month: at most 400 lookups a second before caching, tens a second after.', from: '50 million hosts is an assumption: an average of 20 pages a host across 1 billion pages. With no cache, one lookup per fetch = about 400 a second, the average rate in "Numbers to have ready". With a cache, each host once a month is 50 million ÷ 2.6 million seconds = about 19 a second; short DNS lifetimes make it a few times that, so tens.' }],
      fails: 'A resolver that stops answering stalls every fetch. Collapse duplicate lookups into one, use more than one upstream provider, and trip a circuit breaker so fetchers skip hosts they cannot resolve.',
      alternatives: [
        {
          name: 'Caching resolvers run beside the fetchers', chosen: true, good: 'Shared cache, parallel lookups, no thread held per lookup.', cost: 'One more service to run and watch.',
          what: 'A caching resolver on each machine or rack answers every fetcher, with many lookups in flight and duplicate lookups collapsed into one. The cache cuts at most 400 lookups a second to tens.',
          pros: ['Shared cache, so each host is resolved once per DNS lifetime, not once per fetch.', 'Parallel lookups, with no thread held per lookup.', 'One place for the circuit breaker on hosts that will not resolve.'],
          cons: ['One more service to run and watch.', 'If it stops answering, every fetch stalls, so it needs more than one upstream.', 'Cached answers can be out of date for a while after a site moves.'],
        },
        {
          name: 'Several outside DNS providers in rotation', good: 'Spreads load and survives one provider limiting you.', cost: 'No shared cache unless you add one.',
          what: 'Fetchers send lookups straight to two or three public resolvers in turn, over UDP, TCP or HTTPS. The chosen design can use them as its upstreams; on their own they replace the local cache.',
          pros: ['Nothing to run yourself.', 'Spreads load and survives one provider limiting you.', 'Their large shared caches answer popular hosts quickly.'],
          cons: ['No shared cache of your own unless you add one, so every fetch pays a round trip.', 'At 400 lookups a second you may hit their rate limits.', 'Every lookup leaves your network, which adds tens of milliseconds.'],
        },
        {
          name: 'The operating system resolver', good: 'Nothing to build.', cost: 'Blocking calls, one cache per process.',
          what: 'Each fetcher calls the standard library lookup, which asks whatever resolver the machine is set up with. It is what you get if you do nothing.',
          pros: ['Nothing to build or run.', 'Fine for the single-site crawl, which resolves one host.', 'Respects the machine\'s own settings and hosts file.'],
          cons: ['Blocking calls hold a thread each, which does not suit an event loop.', 'One cache per process, or none.', 'Mercator found lookups took 87 per cent of each thread\'s time this way.'],
        },
      ],
      say: 'I would call out DNS before being asked. It is the classic thing people forget, and it caps throughput long before bandwidth does.',
      see: [{ id: 'lru-cache', label: 'LRU cache' }],
    },
    {
      id: 'robots',
      name: 'robots.txt cache',
      tech: 'per host, 24 h max',
      x: 942, y: 182, w: 160, h: 56, kind: 'node',
      what: 'Holds each host\'s parsed robots.txt rules so a fetcher can ask "may I fetch this path?" without another request. It lives in memory on the node that owns the host, so the check is an in-process read. The rules follow RFC 9309: the longest matching rule wins, and Allow wins a tie.',
      why: 'Obeying robots.txt is the minimum a site expects of a crawler, and checking it on every fetch would double the traffic. Caching it per host for at most 24 hours is what the standard asks for.',
      built: [
        { name: 'robots.txt (RFC 9309)', what: 'A text file at the root of a site saying which paths crawlers may fetch, standardised as RFC 9309 in 2022. The longest matching rule wins, and Allow wins a tie.', why: 'Obeying it is the minimum a site expects of a crawler. The RFC also sets the error rules this box follows: a 4xx means no restrictions, and a 5xx or no answer means disallow everything.' },
        { name: 'Per-host cache, 24 h max', what: 'The parsed rules for each host, held in memory on the node that owns the host and refreshed after at most 24 hours.', why: 'Fetching robots.txt before every page would double the traffic, and 24 hours is the most RFC 9309 allows. Because one node owns each host, only that node needs the rules, so a local cache is enough; a shared cache or a database read would add about 400 network calls a second.' },
        { name: 'Crawl-delay', what: 'A line some sites add to robots.txt asking for a gap between requests, 2 seconds for example.org. It is not part of RFC 9309.', why: 'It is a clear signal of what the site can bear, so the design honours it, with a cap on absurd values, as one input to the gap between requests.' },
      ],
      numbers: [
        { text: 'A 4xx for robots.txt means no restrictions. A 5xx or no answer means assume everything is disallowed.', from: 'Not a sum: the error rules of RFC 9309, cited in Sources.' },
        { text: 'Crawl-delay is not in the standard. Honour it, with a cap on absurd values.', from: 'Not a sum. RFC 9309 (Sources) does not define Crawl-delay. The cap is this design\'s choice; the page sets no value for it.' },
      ],
      fails: 'A stale or wrongly parsed file means fetching what a site asked you not to. Log every fetch against the rule that allowed it and treat any violation as an incident.',
      alternatives: [
        {
          name: 'Cache per host, refreshed daily', chosen: true, good: 'Matches the standard and keeps the check local to the node that owns the host.', cost: 'A rule change can take up to a day to be seen.',
          what: 'The node that owns a host keeps its parsed rules in memory for at most 24 hours. On a miss the fetcher requests /robots.txt like any page, through the same rate limit. Partitioning by host is what makes this cache local.',
          pros: ['Matches RFC 9309: cache for at most 24 hours.', 'The check is an in-process read, with no network hop on a fetch.', 'One fetch of robots.txt a day per host, not one per page.'],
          cons: ['A rule change can take up to a day to be seen.', 'A restart or failover empties the cache, so the new owner refetches robots.txt for its hosts.', 'Parsing must be exactly right: a mistake fetches what a site forbade.'],
        },
        {
          name: 'Parsed rules in the metadata database', good: 'Survives restarts and is shared by every crawler without a separate cache.', cost: 'A database read on the hot path unless you cache it anyway.',
          what: 'Store each host\'s parsed rules and fetch time as a row in the metadata store, and read it before each fetch. The row is refreshed when it is more than a day old.',
          pros: ['Survives restarts and failovers.', 'Shared by every crawler without a separate cache.', 'Easy to audit which rules allowed a fetch.'],
          cons: ['A database read on the hot path, about 400 a second, unless you cache it anyway.', 'Adds load to the store that every other write depends on.', 'Partitioning by host already makes a local cache enough.'],
        },
        {
          name: 'Ignore Crawl-delay', good: 'Some large crawlers do, and set their own rate.', cost: 'You lose a clear signal from the site about what it can bear.',
          what: 'Obey the Allow and Disallow rules but skip the Crawl-delay line, and pace every host by your own rule: at least 1 second, or ten times the last response time.',
          pros: ['Some large crawlers do, and set their own rate.', 'One pacing rule to test, not two.', 'No absurd values, such as a delay of a day, to cap.'],
          cons: ['You lose a clear signal from the site about what it can bear.', 'Sites that set it will see you as impolite.', 'The design honours it with a cap, which costs little.'],
        },
      ],
      say: 'A server error on robots.txt means stop. An overloaded site is telling you something.',
    },
    {
      id: 'iplimit',
      name: 'Per-IP limiter',
      tech: 'token buckets',
      x: 750, y: 35, w: 160, h: 56, kind: 'shared',
      what: 'A small shared service that limits requests per resolved address and per registrable domain, consulted only for addresses known to host many sites.',
      why: 'Shared hosting puts thousands of hosts on one address, and blog platforms put millions of subdomains on a few servers. Those hosts land on different crawler nodes, so the per-host limit in each frontier cannot see the total.',
      built: [
        { name: 'Token buckets', what: 'A rate-limiting technique. Tokens drip into a bucket at a fixed rate up to a maximum, each request takes one, and an empty bucket means wait.', why: 'It allows a short burst while holding the average. Buckets are kept per resolved address and per registrable domain, so a shared-hosting server is limited in total, however many nodes own its hosts.' },
        { name: 'Redis', what: 'An in-memory data store run as a network service, often used for counters and rate limits. A small script runs inside Redis to take a token, so two nodes cannot both take the last one.', why: 'The buckets must be shared by all 20 nodes, because the hosts on one address are owned by different nodes. Only addresses known to host many sites ask it, so its load is small; if it cannot be reached, fetchers fall back to a slow fixed rate.' },
        { name: 'Registrable domain', what: 'The part of a host name that one owner registers, such as example.org for a.example.org. It is worked out with the Public Suffix List, which knows that co.uk is a suffix anyone can register under.', why: 'Many hosts under one owner can share one set of servers. A bucket per registrable domain limits them together, which per-host limits cannot.' },
      ],
      numbers: [{ text: 'Per host: one connection, and a gap of the largest of 1 second, Crawl-delay, and ten times the last response time.', from: 'Not a sum: a pacing rule. 1 second is the polite rate in "Numbers to have ready". Ten times the last response time is the heuristic from the Mercator line of work (Sources): a slow site is a busy one. A page that took 300 milliseconds gives a gap of 3 seconds.' }],
      fails: 'If the limiter is down, fetchers must slow down, not speed up. Fail safe: fall back to a conservative fixed rate for those addresses.',
      alternatives: [
        {
          name: 'Structural per-host limit, shared bucket only for busy addresses', chosen: true, good: 'Most fetches need no network call to stay polite.', cost: 'Two mechanisms to explain and test.',
          what: 'The frontier\'s shape already gives one request in flight per host. On top, a small Redis service holds token buckets per resolved address and per registrable domain, asked only for addresses known to host many sites.',
          pros: ['Most fetches need no network call to stay polite.', 'Catches shared hosting and blog platforms, which the per-host limit cannot see.', 'The shared service is small, because only busy addresses use it.'],
          cons: ['Two mechanisms to explain and test.', 'Needs a list of busy addresses, built from what the crawl sees.', 'If the limiter is down those addresses drop to a slow fixed rate.'],
        },
        {
          name: 'A central limiter for every request', good: 'One Redis sliding window per domain, with a lock per domain. Easy to reason about and common in queue-based designs.', cost: 'A network hop on every fetch and a hot dependency for the whole crawl.',
          what: 'Every fetch first takes a lock and a slot in a Redis sliding window for its domain, then releases the lock when done. This is how the queue-centred design keeps stateless fetchers polite.',
          pros: ['Easy to reason about: one place decides every rate.', 'Works with any fetcher, since none needs to own a host.', 'Common in queue-based designs, so interviewers know it.'],
          cons: ['A network hop on every fetch, about 400 a second on average.', 'A hot dependency: if it stalls, the whole crawl stalls.', 'Here the frontier already gives per-host politeness, so most of those calls would buy nothing.'],
        },
        {
          name: 'Per-host limits only', good: 'Simplest.', cost: 'Hammers shared hosts and platforms.',
          what: 'Rely only on the frontier\'s one request per host and the gap between requests. There is no shared service at all.',
          pros: ['Simplest: no service, no network call.', 'Nothing to fail open or closed.', 'Fine for the single-site crawl, where host and address are one.'],
          cons: ['Hammers shared hosts and platforms: thousands of hosts on one address are fetched at once.', 'Those hosts land on different nodes, so no node can see the total.'],
        },
      ],
      say: 'Politeness has three layers: one request in flight per host from the frontier\'s shape, token buckets per address for shared hosting, and back-off when a site says slow down.',
      see: [{ id: 'token-bucket', label: 'Token bucket' }],
    },
    {
      id: 'web',
      name: 'The web',
      tech: 'origin servers',
      x: 1192, y: 35, w: 136, h: 56, kind: 'outside',
      what: 'Everyone else\'s servers. The one part of the diagram you do not control and must not hurt.',
      why: 'At one request a second a single site yields at most 86,400 pages a day, however many machines you own. The crawl is fast because it is wide, not because it pushes any one site hard.',
      built: [
        { name: 'Origin servers', what: 'The web servers that hold the pages: everyone else\'s machines, run by site owners and hosting companies, reached over HTTPS on the public internet.', why: 'They are the one part the crawl does not control and must not hurt. At 1 request a second a site yields at most 86,400 pages a day, so the crawl is fast because it is wide, not because it pushes any one site hard.' },
        { name: 'User-Agent', what: 'The request header naming the client, here ExampleBot/1.0 with a link to a page that explains the crawler and how to opt out.', why: 'A stable name with a contact lets a site owner reach you before they block you, and robots.txt rules are matched by the crawler\'s name, so it must not change.' },
      ],
      numbers: [{ text: 'Identify yourself: a stable User-Agent with a contact address and a page that explains the crawler and how to opt out.', from: 'Not a sum: common practice, so a site owner can reach you before they block you. RFC 9309 (Sources) also matches robots.txt rules by the crawler\'s product token, so the name must be stable.' }],
      fails: 'The web fights back without meaning to. Calendars and session identifiers make endless URLs, some servers answer one byte a second, some pages are gigabytes. Defences: a page budget and depth cap per host, URL length limits, size caps and an alarm when a host keeps producing near-identical pages.',
      alternatives: [
        {
          name: 'Budgets per host plus a near-duplicate alarm', chosen: true, good: 'Catches traps by their effect, whatever shape they take.', cost: 'Needs a fingerprint for near-duplicates and a place to count.',
          what: 'Each host gets a page budget and a depth cap, counted on the node that owns it. The parser\'s SimHash shows when a host keeps producing near-identical pages, and that raises an alarm.',
          pros: ['Catches traps by their effect, whatever shape they take.', 'Counting is local, because one node owns each host.', 'Reuses the SimHash the parser computes anyway.'],
          cons: ['Needs a fingerprint for near-duplicates and a place to count.', 'A budget set too low cuts off a large, real site.', 'Pages up to the budget are still fetched before it trips.'],
        },
        {
          name: 'A depth limit of 15 to 20 hops from a seed', good: 'One number, trivial to build.', cost: 'Cuts off deep but real content and misses wide, shallow traps.',
          what: 'Each URL carries its distance from a seed, and links past the limit are dropped in the URL filter. The design can keep depth as one signal among others.',
          pros: ['One number, trivial to build.', 'Bounds every trap that goes deeper and deeper, such as a calendar.', 'Easy to explain in one sentence.'],
          cons: ['Cuts off deep but real content, such as long archives.', 'Misses wide, shallow traps such as filters that combine without limit.', 'Depth from a seed says little once the crawl has run for months.'],
        },
        {
          name: 'URL pattern rules', good: 'Stops known offenders such as calendar pages straight away.', cost: 'Always one trap behind.',
          what: 'The URL filter drops links that match known trap shapes: date paths far in the future, session identifiers, repeated path segments. Rules are added when the alarm fires.',
          pros: ['Stops known offenders such as calendar pages straight away.', 'Cheap: a check in the filter, before the seen check.', 'Works well with budgets, as the drill for the calendar shows.'],
          cons: ['Always one trap behind.', 'A broad rule can drop real pages.', 'The rule list grows and needs owning.'],
        },
      ],
      say: 'I would measure politeness violations and aim for zero: overlapping requests to a host, gaps shorter than its delay, and fetches its rules disallow.',
    },
    {
      id: 'parser',
      name: 'Parser',
      tech: 'sandboxed',
      x: 897, y: 328, w: 130, h: 56, kind: 'node',
      what: 'Pulls the text and the links out of each page, then computes two fingerprints: an exact hash of the content, and a SimHash that stays close when two pages differ only slightly.',
      why: 'Parsing uses the processor and handles hostile input, so it runs in a sandbox apart from the fetchers. Raw pages are stored first, which means a parser bug is fixed by reprocessing stored pages and never by fetching again.',
      built: [
        { name: 'Sandboxed process', what: 'The parser runs as a separate process with limits on what it can reach and on how much memory and time it may use.', why: 'It reads hostile input all day. A crash or a takeover stays inside the sandbox: the fetcher and its sockets carry on, and the page is retried from storage.' },
        { name: 'Streaming tokenizer', what: 'A parser that reads HTML as a stream of tags and text and acts as it goes, instead of building the whole page as a tree in memory.', why: 'Memory stays flat whatever the nesting, so tags nested fifty thousand deep cannot exhaust it, and no backtracking regular expression can run for minutes. At 10 to 20 milliseconds a page it is about one core a node.' },
        { name: 'Content hash (SHA-256)', what: 'A cryptographic hash of the page body after light normalisation. The same content always gives the same hash.', why: 'It spots exact copies at different URLs, so the second copy is stored as a pointer. Comparing it with the last fetch\'s hash says whether the page changed, which sets the next fetch time.' },
        { name: 'SimHash', what: 'A 64-bit fingerprint that stays similar when text is similar: pages whose fingerprints differ in three bits or fewer are treated as near-duplicates. Charikar described it in 2002.', why: 'Exact hashes differ completely when only an advert or a timestamp changes. SimHash catches those with one fingerprint a page, where MinHash needs many values, and it drives the alarm for a host that keeps producing near-identical pages.' },
      ],
      numbers: [
        { text: '10 to 20 milliseconds of processor time per page.', from: 'An assumption for a streaming parse of about 100 KB of HTML plus two hashes. At 400 pages a second that is 4 to 8 cores across the crawl; at 50 pages a second a node it is about one core a node.' },
        { text: 'About 50 links per page, so about 20,000 URL-seen checks a second.', from: '400 pages a second × 50 links = 20,000 checks a second, both from "Numbers to have ready". 50 links a page is an assumption: menus, footers and body links. At the 1,000 pages a second built for it is 50,000.' },
      ],
      fails: 'A poison page (tags nested fifty thousand deep, a pattern that makes a regular expression run for ever) crashes the parser again and again. Quarantine a page after three failures and carry on.',
      alternatives: [
        {
          name: 'Streaming tokenizer in a sandbox', chosen: true, good: 'Time grows with the page and memory does not, whatever the nesting.', cost: 'Less convenient than a document tree for complex extraction.',
          what: 'A separate sandboxed process on each node reads the page as a stream of tags and text, picks out links and text, and hashes as it goes. It gets the page over a pipe from the fetcher, in memory.',
          pros: ['Time grows with the page and memory does not, whatever the nesting.', 'A crash cannot take the fetcher down, and the page is retried from the object store.', 'About one core a node at 10 to 20 milliseconds a page.'],
          cons: ['Less convenient than a document tree for complex extraction.', 'A sandbox and a pipe to set up and watch.', 'Poison pages still need the three-strikes quarantine.'],
        },
        {
          name: 'Queue-fed parser workers that scale on backlog', good: 'Serverless functions or containers scale to zero and absorb bursts. A good fit when fetch and parse are joined by a queue.', cost: 'Another hop and another queue to watch.',
          what: 'Fetchers publish a message per stored page, and a separate pool of parser workers reads the page back from the object store. The pool grows and shrinks with the backlog.',
          pros: ['Serverless functions or containers scale to zero and absorb bursts.', 'Parsing scales apart from fetching.', 'A good fit when fetch and parse are joined by a queue, as in the one-off design.'],
          cons: ['Another hop and another queue to watch.', 'Every page is read back from the object store, about 400 reads a second.', 'Parsing needs about one core a node here, so there is little to scale.'],
        },
        {
          name: 'Parse inside the fetcher', good: 'One stage fewer.', cost: 'A parser crash loses the fetch, and processor work competes with sockets.',
          what: 'The fetcher parses each response in its own process as soon as the body arrives, then passes links straight to the filter.',
          pros: ['One stage fewer, and no pipe.', 'Lowest delay from fetch to new links.', 'Simplest code for the single-site crawl.'],
          cons: ['A parser crash loses the fetch and every socket the process held.', 'Processor work competes with sockets on the event loop.', 'Hostile input is parsed in the process that can reach the network.'],
        },
        {
          name: 'A full document tree, or regular expressions', good: 'Quick to write.', cost: 'Deep nesting exhausts memory, and backtracking patterns can run for minutes.',
          what: 'Build the whole page as a tree and query it, or pull links out with regular expressions. Either is the first thing most people write.',
          pros: ['Quick to write.', 'A tree makes complex extraction, such as main-text detection, easy.', 'Libraries for both are everywhere.'],
          cons: ['Deep nesting exhausts memory.', 'Backtracking patterns can run for minutes on a crafted page.', 'Regular expressions miss links that real HTML hides in odd places.'],
        },
      ],
      say: 'Fetching and parsing scale and fail differently, so I split them, and I store the raw page between the two so I can replay the parser without touching the web.',
      see: [{ id: 'simhash', label: 'SimHash' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'render',
      name: 'JS render pool',
      tech: 'headless',
      x: 1182, y: 535, w: 152, h: 56, kind: 'shared',
      what: 'Runs a page in a headless browser when its content only appears after scripts run. The rendered page is written to the object store like any fetched page, and the parser reads it back from there.',
      why: 'Rendering costs ten to a hundred times a plain fetch in processor, memory and time. It is a separate pool so that it can be small, sandboxed, and switched off.',
      built: [
        { name: 'Headless browser', what: 'A real web browser with no window, such as headless Chromium, driven by code: it loads a page, runs its scripts and hands back the result.', why: 'Some sites build their content with scripts, so their plain HTML is almost empty. A browser costs ten to a hundred times a plain fetch and is the largest attack surface in the system, so it runs as a small, sandboxed pool with no route to anything internal, fed only the pages that need it, and it can be switched off.' },
      ],
      fails: 'A browser is the largest attack surface in the system. Sandbox it, cap its time and memory, and give it no route to anything internal.',
      alternatives: [
        {
          name: 'Render only pages that need it', chosen: true, good: 'Detect empty bodies or known frameworks and send just those.', cost: 'The detection is a heuristic and will miss some.',
          what: 'The parser spots pages with an almost empty body or a known script framework and publishes their URLs to a render topic. A small pool of headless browsers renders them and writes the result to the object store.',
          pros: ['Pays ten to a hundred times the cost of a fetch only where it is needed.', 'A slow pool builds lag on its topic and never slows the crawl.', 'The pool is small, sandboxed and can be switched off.'],
          cons: ['The detection is a heuristic and will miss some.', 'A second fetch of the page, through the browser, costs the site another visit.', 'A browser is the largest attack surface in the system.'],
        },
        {
          name: 'No rendering', good: 'Often out of scope, and most text on the web is in the HTML.', cost: 'Script-built sites come back empty.',
          what: 'Keep only what the HTML says. Pages that build their content with scripts are stored as they come, mostly empty.',
          pros: ['Often out of scope, and most text on the web is in the HTML.', 'No browser to sandbox, the largest attack surface gone.', 'The right first version, as the Say line puts it.'],
          cons: ['Script-built sites come back empty.', 'Coverage gaps fall on newer sites, which use scripts more.'],
        },
        {
          name: 'Render everything', good: 'Complete.', cost: 'Throughput falls by one or two orders of magnitude.',
          what: 'Every fetch goes through a headless browser, so each page is seen as a user would see it.',
          pros: ['Complete: nothing is missed for lack of scripts.', 'One path for every page, with no detection heuristic.', 'Sees what users see, links added by scripts included.'],
          cons: ['Throughput falls by one or two orders of magnitude, so 20 nodes would become hundreds or thousands.', 'Every page runs untrusted code in a browser.', 'Browsers load images and scripts too, which costs each site many more requests.'],
        },
      ],
      say: 'I would keep rendering out of the first version and add it as a separate pool, used only where the product needs it.',
    },
    {
      id: 'filter',
      name: 'URL filter',
      tech: 'normalise, route',
      x: 612.5, y: 328, w: 143, h: 56, kind: 'node',
      what: 'Turns every extracted link into one canonical form (lower-case host, default port removed, fragment dropped, relative links resolved), applies scope and trap rules, then works out which node owns the link\'s host.',
      why: 'Without one canonical form the same page enters the frontier under a dozen spellings. Routing by host is what keeps politeness local: slot = hash(host) mod 1,024, and each slot belongs to one node.',
      built: [
        { name: 'Normalise', what: 'Rewriting each URL into one standard spelling (canonicalisation): lower-case scheme and host, default port removed, fragment dropped, relative links resolved, tracking parameters stripped.', why: 'Without it one page enters the frontier under a dozen spellings. The rules live in one tested library used by every stage, because normalising too hard merges different pages and too gently lets duplicates through.' },
        { name: 'Route', what: 'slot = hash(host) mod 1,024, and the coordinator\'s map says which node owns each slot, about 51 a node. A link for this node goes to the seen check; any other goes to the discovered-urls topic.', why: 'Routing by host puts everything about a host on one node: its queue, its rate limit and its robots rules, so politeness needs no locks. A host\'s slot never changes, and moving a slot is an explicit, versioned step, where hash(host) mod 20 would move almost every host when a node is added or lost.' },
        { name: 'Scope and trap rules', what: 'Checks that drop links outside the crawl\'s scope or shaped like known traps, such as dates far in the future or session identifiers in the path.', why: 'They are cheap, run before the seen check, and stop known offenders at once. Budgets per host catch the traps the rules miss.' },
      ],
      numbers: [{ text: 'Most links point to the same host, so most never leave the node.', from: 'An assumption: menus, footers and body links mostly stay on the site. A link to another host lands on this node only by chance, about 1 time in 20 with 20 nodes, so the share that leaves is roughly the share of links that point off-site.' }],
      fails: 'Normalise too hard and two different pages collapse into one. Too gently and duplicates flood the frontier. Keep the rules in one tested library used by every stage.',
      alternatives: [
        {
          name: 'Fixed slots mapped to nodes by a coordinator', chosen: true, good: 'Moving a slot is an explicit, versioned step. Redis Cluster and Kafka\'s keyed partitions work the same way.', cost: 'Needs a coordinator to hold the map.',
          what: 'slot = hash(host) mod 1,024, and the coordinator\'s map says which node owns each slot, about 51 each across 20 nodes. The filter reads the map to route each link; the slot number is also the topic partition.',
          pros: ['Moving a slot is an explicit, versioned step with an epoch, so it can be fenced.', 'The slot count never changes, so a host\'s slot never changes.', 'One slot is one partition, so the topic and the frontier move together.', 'Redis Cluster and Kafka\'s keyed partitions work the same way.'],
          cons: ['Needs a coordinator to hold the map.', 'More than 1,024 nodes would need a re-slot.', 'A slot with one huge site can be uneven, so it may need a slot of its own.'],
        },
        {
          name: 'A consistent hash ring with virtual nodes', good: 'Adding a node moves only about one share in N of the hosts, with no map to store.', cost: 'Harder to fence a node that is paused and comes back.',
          what: 'Nodes and hosts are hashed onto one ring, and each host belongs to the next node clockwise. Virtual nodes give each machine many points so the load evens out.',
          pros: ['Adding a node moves only about one share in N of the hosts, with no map to store.', 'Every node can work out an owner from the member list alone.', 'Well known, and UbiCrawler used it.'],
          cons: ['Harder to fence a node that is paused and comes back.', 'Nodes must agree on the member list, which is the hard part anyway.', 'Ranges on a ring do not line up with fixed topic partitions.'],
        },
        {
          name: 'hash(host) mod N', good: 'One line.', cost: 'Changing N moves almost every host to a new owner.',
          what: 'The owner is hash(host) mod the number of nodes, 20 here. No map and no coordinator for routing.',
          pros: ['One line, no map.', 'Even spread when the node count is fixed.', 'Fine for a fixed cluster that never changes size.'],
          cons: ['Changing N moves almost every host to a new owner.', 'A node failure changes N, so every frontier would move at once.'],
        },
      ],
      say: 'I partition by host, not by URL, so that everything about a host (its queue, its rate limit, its robots rules) lives on one node.',
      see: [{ id: 'consistent-hashing', label: 'Consistent hash ring' }],
    },
    {
      id: 'seen',
      name: 'URL-seen check',
      tech: '64-bit fingerprints',
      x: 334, y: 328, w: 158, h: 56, kind: 'node',
      what: 'Answers "have we met this URL before?" for every link. Only new URLs go on to the frontier. Each URL is kept as a 64-bit fingerprint in an on-disk store, with a small in-memory cache of popular URLs in front.',
      why: 'About 20,000 checks a second against about 10 billion URLs. Partitioned by host, each node holds about 500 million and answers about 1,000 a second, so a local disk store is fast enough and all but exact.',
      built: [
        { name: '64-bit fingerprints', what: 'Each canonical URL is hashed to 8 bytes, and the hash is stored in place of the URL.', why: '10 billion URLs take about 80 GB, about 4 GB a node, with about three collisions expected in all. A Bloom filter at 1 per cent would take 12 GB but skip up to 100 million new pages for good, with nothing to report it.' },
        { name: 'On-disk store (RocksDB)', what: 'The fingerprints sit in the node\'s RocksDB, the same embedded store as the frontier, on local SSD.', why: 'About 1,000 checks a second a node is easy for local disk behind a cache. Sharing the store with the frontier lets the fingerprint and the queue entry go in one write batch, so a crash cannot mark a URL seen that was never queued.' },
        { name: 'Cache of popular URLs', what: 'A small in-memory cache in front of the disk store, holding fingerprints of URLs that turn up again and again.', why: 'Menus, footers and home-page links repeat on every page of a site, so a small cache answers most checks without a disk read.' },
      ],
      numbers: [
        { text: 'Fingerprints: 8 bytes each, about 80 GB in total, about three collisions in 10 billion.', from: '10 billion known URLs (from "Numbers to have ready": discovery outruns fetching tenfold, an assumption) × 8 bytes = 80 GB, about 4 GB a node across 20. Collisions by the birthday bound: n² ÷ 2⁶⁵ = 10²⁰ ÷ 3.7 × 10¹⁹ = about 2.7, so about three.' },
        { text: 'Bloom filter at 1 per cent false positives: 9.6 bits each, about 12 GB.', from: 'The standard sizing: bits per item = −ln(0.01) ÷ (ln 2)² = 4.61 ÷ 0.48 = about 9.6. 10 billion × 9.6 bits = 96 billion bits = 12 GB.' },
        { text: 'Links to home pages and menus repeat constantly, so a small cache answers most checks.', from: 'Not a sum: an assumption. Of about 50 links a page, menus, footers and home-page links are the same on every page of a site, so a cache of popular URLs catches them.' },
      ],
      fails: 'A false "seen" is silent: the page is never crawled and nothing reports it. That is the case against a Bloom filter here, because the same URL hits the same bits every time. It is also why the fingerprint and the frontier entry go in one write batch: a fingerprint written alone, then a crash, would mark a URL seen that was never queued.',
      alternatives: [
        {
          name: '64-bit fingerprints on local disk', chosen: true, good: 'Near-exact: about three collisions in 10 billion, against 100 million misses for a 1 per cent Bloom filter. Supports deletes, cheap on SSD.', cost: 'About 80 GB of disk, and a disk read on a cache miss.',
          what: 'Each canonical URL is hashed to 8 bytes and kept in the node\'s RocksDB, about 500 million and 4 GB a node, with a cache of popular URLs in front. The fingerprint and the frontier entry go in one write batch.',
          pros: ['Near-exact: about three collisions in 10 billion, against 100 million misses for a 1 per cent Bloom filter.', 'Supports deletes, so a URL can be forgotten and found again.', 'About 1,000 checks a second a node, easy for local SSD behind a cache.', 'Shares one write batch with the frontier, so a crash cannot split them.'],
          cons: ['About 80 GB of disk in total, against 12 GB for a Bloom filter.', 'A disk read on a cache miss.', 'Moves with its slot, so a failover must restore it too.'],
        },
        {
          name: 'Bloom filter', good: 'Tiny and in memory. Fine where losing 1 per cent of the long tail does not matter, such as a training corpus.', cost: 'At 1 per cent, up to 100 million pages are skipped for good. No deletes, and it cannot grow.',
          what: 'A bit array per node, about 12 GB in total at 9.6 bits a URL, answering "definitely new" or "probably seen". A URL is enqueued only on "definitely new".',
          pros: ['Tiny and in memory: about 600 MB a node.', 'No disk read, ever.', 'Fine where losing 1 per cent of the long tail does not matter, such as a training corpus.'],
          cons: ['At 1 per cent, up to 100 million of 10 billion pages are skipped for good, and nothing reports it.', 'No deletes, and it cannot grow past its planned size without a rebuild.', 'The same URL hits the same bits every time, so a false positive never clears.'],
        },
        {
          name: 'Check the metadata database before enqueueing', good: 'No extra store. An indexed lookup is fine at lower rates.', cost: 'A network round trip per link at 20,000 a second.',
          what: 'For each link, read the URL\'s row in the metadata store; enqueue it only if no row exists, and write the row as you do.',
          pros: ['No extra store: the metadata store already holds every URL.', 'Exact, with no collisions at all.', 'An indexed lookup is fine at lower rates, as in the single-site crawl.'],
          cons: ['A network round trip per link at 20,000 a second.', 'Puts the busiest read on the store every result depends on.', 'The check and the enqueue are on two systems, so a crash can split them.'],
        },
        {
          name: 'A shared in-memory set (Redis)', good: 'One set for every node, simple to reason about.', cost: 'About 80 GB of memory and a network hop per link.',
          what: 'All nodes add fingerprints to one sharded in-memory set; an add that reports "already there" means seen. No node holds its own store.',
          pros: ['One set for every node, simple to reason about.', 'Exact up to 64-bit collisions, like the chosen design.', 'Nothing to restore on failover.'],
          cons: ['About 80 GB of memory for 10 billion fingerprints, before overhead.', 'A network hop per link, 20,000 a second.', 'Partitioning by host already makes each node\'s set local, so the shared set buys little.'],
        },
      ],
      say: "A Bloom filter's false positive is not a retry. It is a page we will never crawl. So I keep 64-bit fingerprints on each node, and use a Bloom filter only where a miss is cheap.",
      see: [
        { id: 'bloom-filter', label: 'Bloom filter' },
        { id: 'lsm-tree', label: 'LSM tree (RocksDB)' },
      ],
    },
    {
      id: 'kafka',
      name: 'discovered-urls topic',
      tech: 'Kafka, keyed by host',
      short: 'discovered-urls',
      x: 480, y: 535, w: 186, h: 64, kind: 'queue',
      what: 'Carries links whose host belongs to another node. Messages are keyed by host, with one partition per slot, and each node reads exactly the partitions for the slots it owns.',
      why: 'Cross-node traffic needs batching, buffering and replay. A log gives all three, and the same log is what a new owner replays to rebuild a frontier after a failure.',
      built: [
        { name: 'Kafka', what: 'Apache Kafka, a distributed log: producers append messages to topics split into partitions, a cluster of servers called brokers stores them durably, and each consumer reads from a position (offset) it chooses.', why: 'Traffic between nodes needs batching, buffering and replay, and a log gives all three. Replay from a saved offset is how a new owner rebuilds a frontier. A managed queue such as SQS deletes a message once it is read and has no keyed partitions, so it gives neither replay nor one owner per host.' },
        { name: 'Keyed by host', what: 'Each message\'s key is its host, and its partition is the host\'s slot: 1,024 partitions in all. Each node reads exactly the partitions of the slots it owns, assigned from the coordinator\'s map.', why: 'A host\'s links reach one node, in order, and when a slot moves its partition moves with it. Assigning partitions from the slot map, not through a consumer group, means the broker can never disagree with the coordinator about who owns a slot.' },
      ],
      fails: 'If consumers fall behind, discovery lags but nothing is lost. If the topic itself is unavailable, nodes buffer to local disk and keep crawling what they already hold.',
      alternatives: [
        {
          name: 'A partitioned log between nodes', chosen: true, good: 'Keyed routing keeps a host on one consumer, and the log can be replayed.', cost: 'Partitions to plan and consumer lag to watch.',
          what: 'One Kafka topic with 1,024 partitions, one per slot, keyed by host. Each node consumes the partitions of the slots it owns, and saves its offsets with each frontier snapshot.',
          pros: ['Keyed routing keeps a host on one consumer, in order.', 'The log can be replayed, which is how a new owner rebuilds a frontier.', 'Batches and buffers cross-node traffic, so a slow node shows as lag, not errors.'],
          cons: ['Partitions to plan and consumer lag to watch.', 'A cluster of brokers to run, or pay for.', 'Discovery lags if a consumer falls behind.'],
        },
        {
          name: 'Direct calls between nodes', good: 'No broker.', cost: 'Retries, buffering and back-pressure become your problem.',
          what: 'The filter calls Enqueue on the owning node over gRPC, batching links per destination. Each node keeps a local buffer for peers that are down.',
          pros: ['No broker to run.', 'Lowest delay from discovery to the far frontier.', 'Same call as the scheduler already uses.'],
          cons: ['Retries, buffering and back-pressure become your problem.', 'No replay, so a failed node\'s incoming links must be rebuilt another way.', 'Every node must track every other node\'s address and health.'],
        },
        {
          name: 'A managed queue (SQS)', good: 'No brokers to run.', cost: 'No keyed partitions, so it cannot keep a host on one owner without a queue per host, and per-request pricing adds up at 50,000 messages a second.',
          what: 'Each node sends links to a managed queue and reads from it. To keep a host on one owner it would need a queue per node or per slot.',
          pros: ['No brokers to run.', 'Retries and a dead-letter queue come with it.', 'Scales without planning partitions.'],
          cons: ['No keyed partitions, so it cannot keep a host on one owner without a queue per host.', 'A message is gone once read, so there is no replay after a failover.', 'Per-request pricing adds up at tens of thousands of messages a second.'],
        },
        {
          name: 'Write links to the metadata store and let owners poll', good: 'No broker, and the store already holds every URL.', cost: 'Turns cross-node traffic into a polling load on the busiest store.',
          what: 'The filter writes each foreign link as a row keyed by slot; each node range-reads new rows for its slots every few seconds.',
          pros: ['No broker, and the store already holds every URL.', 'Durable as soon as it is written.', 'Replay is a range read from a saved point.'],
          cons: ['Turns cross-node traffic into a polling load on the busiest store.', 'Delay is the polling interval.', 'Needs a time-ordered key per slot, which is a log built by hand.'],
        },
      ],
      say: 'The log carries URLs between nodes and gives me replay. It does not decide what to fetch.',
      see: [{ id: 'append-log', label: 'Append-only log' }],
    },
    {
      id: 'coord',
      name: 'Coordinator',
      tech: 'slot map, leases',
      x: 94, y: 39, w: 150, h: 56, kind: 'shared',
      what: 'Holds the map from slots to nodes. Each node keeps a lease on its slots and renews it every few seconds. When a lease runs out, the slots go to another node with a higher epoch number.',
      why: 'Two nodes fetching for the same host would break politeness, so ownership must be exclusive. The old owner stops handing out URLs as soon as it cannot renew, and the new owner waits out the full lease before its first fetch.',
      built: [
        { name: 'etcd or ZooKeeper', what: 'Small clusters, typically of three or five servers, that agree on every change before confirming it (consensus). They are built to hold small, critical shared state; etcd offers leases and watches, ZooKeeper sessions and ephemeral nodes.', why: 'Ownership of a slot must be exclusive, because two nodes fetching for one host breaks politeness. Consensus gives one agreed view. Gossip or consistent hashing alone can leave two nodes each believing they own a host.' },
        { name: 'Slot map', what: 'The table of 1,024 slots and the node that owns each, about 51 a node across 20, with an epoch for every slot.', why: 'One versioned map makes routing, the assignment of topic partitions and failover agree. Nodes watch it and hear of a change at once.' },
        { name: 'Leases', what: 'Each node holds a lease of about 30 seconds on its slots and renews it every few seconds, every 10 in the example. When a lease runs out, its slots move to another node and their epoch goes up by one.', why: 'A lease turns "this node is dead" into a timeout nobody has to judge. The epoch fences a node that was only paused: anything carrying the old number is refused. The price is that a dead node\'s hosts wait about 30 seconds, plus a margin for clock drift.' },
      ],
      numbers: [
        { text: '1,024 slots across about 20 nodes.', from: '20 nodes is 1,000 pages a second ÷ 50 a node, from "Numbers to have ready". 1,024 ÷ 20 = about 51 slots a node. 1,024 is a choice: a power of two, far more slots than nodes, so losing one node moves about 51 small slots spread over 19 others, and the crawl can grow to hundreds of nodes without re-slotting.' },
        { text: 'A lease of about 30 seconds.', from: 'An assumption. With renewal "every few seconds" (say every 10), a node can miss two renewals before losing its slots, so a short network blip does not move them. The price: a dead node\'s hosts wait about 30 seconds, plus the margin for clock drift, before the new owner fetches.' },
      ],
      fails: 'If the coordinator is unreachable, nodes pause. A pause costs minutes of crawling. Two owners for one host costs a site its patience and you your reputation.',
      alternatives: [
        {
          name: 'Coordinator with leases and epochs (etcd, ZooKeeper)', chosen: true, good: 'Easy to fence a node that was only paused, and one place for a kill switch.', cost: 'A dependency that must itself be highly available.',
          what: 'A small consensus cluster holds the map of 1,024 slots to 20 nodes. Each node renews a lease of about 30 seconds on its slots; when one runs out, the slots move with a higher epoch.',
          pros: ['Easy to fence a node that was only paused: its old epoch is refused.', 'One agreed view, so a host never has two owners.', 'One place for a kill switch.', 'Nodes watch the map and hear of changes at once.'],
          cons: ['A dependency that must itself be highly available.', 'If it is unreachable, nodes pause: minutes of crawling lost.', 'A dead node\'s hosts wait out the full lease before anyone fetches them.'],
        },
        {
          name: 'No coordinator: nodes agree by consistent hashing alone', good: 'UbiCrawler worked this way. Nothing central to fail.', cost: 'Membership changes and stale nodes are much harder to reason about.',
          what: 'Each node learns the member list, by gossip or configuration, and works out owners on a hash ring itself. No service decides who owns what.',
          pros: ['UbiCrawler worked this way.', 'Nothing central to fail or to run.', 'Owners can be worked out locally with no call.'],
          cons: ['Membership changes and stale nodes are much harder to reason about.', 'Two nodes with different member lists can both think they own a host.', 'No epoch, so a paused node that wakes up is not fenced.'],
        },
        {
          name: 'One central frontier service', good: 'Politeness is decided in one place.', cost: 'It has to shard anyway, and every fetcher depends on it.',
          what: 'Take the frontier out of the nodes and run it as one service that every fetcher asks for work. Ownership of hosts is then that service\'s internal concern.',
          pros: ['Politeness is decided in one place.', 'Fetchers become stateless and need no slots.', 'Easy to inspect the whole queue.'],
          cons: ['It has to shard anyway at 2 billion pending URLs, which brings back slots and owners.', 'Every fetcher depends on it, at about 1,000 leases a second.', 'Its failure stops the whole crawl, not 1 node in 20.'],
        },
        {
          name: 'Kafka consumer-group rebalancing', good: 'Comes with the log.', cost: 'During a rebalance two consumers can briefly hold the same partition.',
          what: 'Let the discovered-urls consumer group assign partitions, and treat a node\'s partitions as its slots. The broker does the membership and the reassignment.',
          pros: ['Comes with the log: no extra cluster.', 'Membership and failure detection are built in.', 'Slots and partitions cannot drift apart.'],
          cons: ['During a rebalance two consumers can briefly hold the same partition.', 'No fencing epoch that the fetchers and stores can check.', 'A consumer that is slow to poll can be dropped from the group, so ownership moves for reasons the crawl does not choose.'],
        },
      ],
      say: 'Fail closed. A lost lease or a coordinator outage means pause, never two owners.',
      see: [{ id: 'consistent-hashing', label: 'Consistent hash ring' }],
    },
    {
      id: 'meta',
      name: 'Metadata store',
      tech: 'Cassandra, ScyllaDB',
      x: 790, y: 535, w: 170, h: 70, kind: 'store',
      what: 'The durable record of every URL and host: state, last status, ETag, content hashes, next fetch time. Everything else in the crawler can be rebuilt from it.',
      why: 'The workload is tens of thousands of small writes a second by known key, and almost no joins. Writes are upserts keyed by URL, so doing one twice is harmless. That is what makes at-least-once delivery safe everywhere upstream.',
      built: [
        { name: 'Cassandra', what: 'Apache Cassandra, an open-source wide-column database spread over many machines. Rows are found by key, writes are appended and merged later (an LSM tree), and each row is copied to several machines.', why: 'The workload is tens of thousands of small writes a second by known key, with almost no joins: about 3 TB, or 9 TB with three copies. Upserts by key are its natural write, so repeats are harmless. PostgreSQL would struggle with the write volume at 10 billion rows, and DynamoDB would be costly at this write rate.' },
        { name: 'ScyllaDB', what: 'A database that speaks Cassandra\'s query language (CQL) and uses its data model, reimplemented for more throughput per machine.', why: 'Named as an equal alternative: the same two tables and the same CQL work on either, so the choice is about running costs and operations, not about the design.' },
      ],
      numbers: [{ text: '10 billion URLs at about 300 bytes each is about 3 TB, or 9 TB with three replicas.', from: '10 billion known URLs from "Numbers to have ready". 300 bytes a row is an assumption: the URL itself, status, ETag, two hashes, times and the WARC file and byte range. 10 billion × 300 bytes = 3 TB; × 3 replicas, a common setting for this kind of store, = 9 TB.' }],
      fails: 'If it is unavailable, nodes buffer results locally and then stop fetching. Crawling pages whose outcome you cannot record is wasted politeness budget.',
      alternatives: [
        {
          name: 'A wide-column store (Cassandra, ScyllaDB)', chosen: true, good: 'Turns random writes into sequential appends and scales by adding nodes.', cost: 'Queries must be designed up front. No ad hoc joins.',
          what: 'One table keyed by URL for the record of each page, and one keyed by time bucket so the recrawl scheduler can range-read due URLs. About 3 TB of data, 9 TB with three replicas.',
          pros: ['Turns random writes into sequential appends and scales by adding nodes.', 'Upserts by key are its natural write, so repeats are harmless.', 'A time-bucket table makes "what is due now" a range read, not a scan.'],
          cons: ['Queries must be designed up front. No ad hoc joins.', 'Two tables to keep in step for each URL.', 'A cluster to run, tune and repair.'],
        },
        {
          name: 'DynamoDB', good: 'Nothing to operate, and a natural fit for a queue-based design.', cost: 'On-demand pricing at about 50,000 writes a second is high, and hot keys need care.',
          what: 'The same two tables as a managed key-value service: the URL as the partition key, and a second index on the next fetch time.',
          pros: ['Nothing to operate.', 'A natural fit for a queue-based design built on managed services.', 'Conditional writes come built in.'],
          cons: ['On-demand pricing at tens of thousands of writes a second is high.', 'Hot keys need care: a time-bucket key is hot by design.', 'Ties the crawl to one cloud.'],
        },
        {
          name: 'PostgreSQL', good: 'The right answer for a single-site or modest crawl: transactions, indexes, easy queries.', cost: 'Write volume and table size at 10 billion rows.',
          what: 'One urls table with indexes on URL and on next fetch time. The scheduler queries for due rows; the parser upserts with ON CONFLICT.',
          pros: ['The right answer for a single-site or modest crawl.', 'Transactions, indexes and easy ad hoc queries.', 'Everyone on the team already knows it.'],
          cons: ['Write volume and table size at 10 billion rows.', 'Sharding it by hand is the hard part you were avoiding.', 'Updates leave dead rows for vacuum to clean up at a high rate.'],
        },
        {
          name: 'A distributed SQL database', good: 'SQL and transactions at scale.', cost: 'Consensus adds latency that idempotent upserts do not need.',
          what: 'A database that shards and replicates for you behind SQL, with transactions across rows. The schema is the PostgreSQL one.',
          pros: ['SQL and transactions at scale.', 'Ad hoc queries for debugging and reports.', 'Shards and rebalances without help.'],
          cons: ['Consensus adds latency that idempotent upserts do not need.', 'More costly per write than a wide-column store.', 'This design keeps every write an upsert, so transactions buy little.'],
        },
      ],
      say: 'I choose at-least-once delivery with idempotent writes over exactly-once. It is far simpler, and the cost is a rare repeated fetch.',
      see: [
        { id: 'lsm-tree', label: 'LSM tree' },
        { id: 'b-plus-tree', label: 'B+ tree' },
      ],
    },
    {
      id: 'blob',
      name: 'Object store',
      tech: 'S3, WARC batches',
      x: 1182, y: 324, w: 154, h: 70, kind: 'store',
      what: 'Keeps the raw response for every page. Fetchers buffer about 500 pages, compress them into one WARC file and upload it, then record each page\'s byte range in the metadata store.',
      why: 'Raw pages are the expensive thing to obtain, so they are stored before anything parses them. Batching cuts upload requests five-hundred-fold, and byte ranges let a reader pull out one page.',
      built: [
        { name: 'S3', what: 'Amazon S3, a managed object store: files (objects) are written with PUT and read with GET over HTTP, including ranged GETs for part of an object. Other clouds have equivalents.', why: 'Raw pages are about 100 TB a month, 20 TB compressed, and are read rarely. Object storage costs far less per byte than database disks and keeps data safe once it acknowledges a PUT. The same store holds the frontier snapshots.' },
        { name: 'WARC batches', what: 'WARC (ISO 28500) is the standard archive format for web responses. About 500 pages, each record its own gzip member, go into one file of about 10 MB.', why: 'Batching cuts uploads from about 400 a second to under one. Separate gzip members mean one page can be read back by byte range, and using the standard format lets other archive tools read the files.' },
      ],
      numbers: [{ text: 'About 100 TB a month raw, about 20 TB compressed.', from: '1 billion pages a month × about 100 KB a page = 100 TB, both from "Numbers to have ready". HTML is mostly text and markup; gzip or zstd usually gets about 5 to 1 on it, so 100 TB becomes about 20 TB. The ratio is an assumption. Batches of 500 pages are about 50 MB raw and 10 MB compressed, and 400 pages a second ÷ 500 is under one upload a second.' }],
      fails: 'An outage here is the one that stops the crawl: buffer to local disk, then stop fetching when the buffer is full. Never drop a page you have already cost a site to serve.',
      alternatives: [
        {
          name: 'Batched WARC files with a byte-range index', chosen: true, good: 'Cheap, standard, and replayable.', cost: 'Needs an index, and a batch lost before upload is refetched.',
          what: 'Fetchers buffer about 500 pages, compress them into one WARC file of about 10 MB and upload it with one PUT. Each page\'s file and byte range go to the metadata store, so a ranged GET reads one page back.',
          pros: ['Cheap: under one upload a second instead of 400.', 'WARC is the standard format, so other tools can read the archive.', 'Replayable: a parser fix reprocesses stored pages, never the web.'],
          cons: ['Needs an index of byte ranges, kept in the metadata store.', 'A batch lost before upload is refetched, up to 500 pages.', 'Pages wait in a buffer until the batch fills.'],
        },
        {
          name: 'One object per page', good: 'Simple to write and to read.', cost: 'Billions of small objects and a request charge for each.',
          what: 'Each fetched page is compressed and uploaded as its own object, named by URL hash. Reading one page is a plain GET.',
          pros: ['Simple to write and to read.', 'Nothing buffered, so nothing lost on a crash after the PUT.', 'No byte-range index to keep.'],
          cons: ['Billions of small objects and a request charge for each: 1 billion PUTs a month.', 'About 400 PUTs a second, against under one batched.', 'Listing or moving the archive is slow at billions of keys.'],
        },
        {
          name: 'Store only the extracted text', good: 'A fraction of the size, and enough for a training corpus.', cost: 'A parser bug means fetching the web again.',
          what: 'The parser keeps the text and links and the raw HTML is thrown away. The object store holds text files, not WARC.',
          pros: ['A fraction of the size.', 'Enough for a training corpus.', 'Consumers get clean text with no parsing of their own.'],
          cons: ['A parser bug means fetching the web again, which costs every site a second visit.', 'New extractors cannot run on old pages.', 'Breaks this design\'s rule: store first, parse after.'],
        },
        {
          name: 'Pages as blobs in the database', good: 'One system fewer.', cost: 'Large values stall compaction and strain memory.',
          what: 'Put the compressed page in a column of the URL\'s row in the metadata store, beside its status and hashes.',
          pros: ['One system fewer.', 'The page and its record are written together.', 'One read gets both.'],
          cons: ['Large values stall compaction and strain memory.', 'The store grows by about 20 TB a month before replicas, against about 3 TB for all its metadata.', 'Database disks cost far more per byte than object storage.'],
        },
      ],
      say: 'Reprocess from stored pages, never refetch. That is why the raw page is written before it is parsed.',
    },
    {
      id: 'downstream',
      name: 'Link graph, events',
      tech: 'Parquet, event topic',
      short: 'Link graph',
      x: 985, y: 535, w: 164, h: 70, kind: 'store',
      what: 'One event per crawled page and a table of links between pages, for whoever uses the crawl: an indexer, a ranking job, a training pipeline.',
      why: 'It keeps the crawler ignorant of its consumers. They read events and files, not the crawler\'s own tables.',
      built: [
        { name: 'Parquet', what: 'Apache Parquet, a columnar file format: values are stored and compressed column by column, so a job reads only the columns it needs.', why: 'The link table (from_url, to_url, anchor_text, found_at) is read by analysis jobs such as ranking that want a few columns over billions of rows. Files also keep consumers off the crawler\'s own tables.' },
        { name: 'Event topic (crawl.pages)', what: 'A Kafka topic with one event per crawled page, about 400 a second, keyed by URL, carrying status, hashes, the number of links and the next fetch time.', why: 'Consumers such as an indexer read at their own pace and can replay, and a slow one builds lag that never slows the crawl. Pushing into each consumer directly would make the crawler wait on them.' },
      ],
      fails: 'A slow consumer must not slow the crawl. Events go to a log it reads at its own pace.',
      alternatives: [
        {
          name: 'Publish events and columnar files', chosen: true, good: 'Consumers are decoupled and can replay.', cost: 'A schema to version.',
          what: 'The parser publishes one event per crawled page on crawl.pages, carrying the URL and content hash, and link tables are written as Parquet files. Consumers read at their own pace.',
          pros: ['Consumers are decoupled and can replay.', 'A slow consumer builds lag and never slows the crawl.', 'Parquet lets analysis jobs read only the columns they need.'],
          cons: ['A schema to version.', 'Events are at-least-once, so consumers must drop repeats by URL and hash.', 'Two outputs, a topic and files, to keep consistent.'],
        },
        {
          name: 'Let consumers query the metadata store', good: 'Nothing new to build.', cost: 'Their queries compete with the crawl, and your schema becomes their interface.',
          what: 'Indexers and jobs read the crawler\'s own tables directly, and fetch pages from the object store using the byte ranges there.',
          pros: ['Nothing new to build.', 'Always up to date, with no lag.', 'Fine while there is one consumer and it is your own team.'],
          cons: ['Their queries compete with the crawl.', 'Your schema becomes their interface, so you cannot change it.', 'A wide-column store answers only the queries it was designed for.'],
        },
        {
          name: 'Push into each consumer directly', good: 'Consumers get data in the shape they want, with no topic in between.', cost: 'The crawler now knows its consumers and waits on them.',
          what: 'The parser calls each consumer\'s API, such as the indexer\'s, with the page and its links as soon as it is parsed.',
          pros: ['Consumers get data in the shape they want.', 'Lowest delay from fetch to index.', 'No topic or files to run.'],
          cons: ['The crawler now knows its consumers and waits on them.', 'A slow or failed consumer slows the crawl, the case the page rules out.', 'No replay for a new consumer.'],
        },
      ],
      say: 'The crawler\'s output is a contract: stored pages, an event per page and a link table. Indexing is someone else\'s system.',
      see: [{ id: 'graph', label: 'Graph traversal' }],
    },
  ],

  flows: [
    {
      id: 'seed', from: 'seeds', to: 'frontier', d: 'M135,148 H244', label: 'seed URLs',
      mode: 'call', via: 'REST', chip: 0.39,
      how: 'An operator, or a job reading sitemaps, posts URLs to a small audited API (POST /v1/seeds). The API puts each URL into canonical form and enqueues it on the node that owns its host.',
      delivery: 'Safe to repeat: posting a seed twice enqueues it once.',
      alts: ['A file dropped in the object store and picked up by a job.', 'Publishing seeds straight onto the discovered-urls topic.'],
      ways: [
        { name: 'REST', chosen: true, what: 'An operator or the sitemap job posts URLs to POST /v1/seeds. The API makes each URL canonical and enqueues it on the node that owns its host.', pros: ['Every change is audited, with who added what.', 'The caller hears at once if a URL is rejected.', 'Safe to repeat: a seed posted twice is queued once.'], cons: ['A small service to run and secure.', 'Bulk loads of millions of URLs need batching on the client.'] },
        { name: 'A file in the object store', what: 'Drop a file of URLs in a known bucket; a job reads it, makes each URL canonical and enqueues them. Good for large one-off loads.', pros: ['Handles millions of URLs with no API limits.', 'The file itself is the record of what was added.'], cons: ['No answer to the caller about bad URLs.', 'Audit depends on who could write to the bucket.', 'Picked up on the job\'s schedule, not at once.'] },
        { name: 'Straight onto discovered-urls', what: 'Produce seeds to the discovered-urls topic, keyed by host, as if another node had found them. The owning node consumes them like any link.', pros: ['No new service: routing by host is already done.', 'Replayable like any other link.'], cons: ['Skips the audit and the priority a seed carries.', 'Anyone who can produce to the topic can seed the crawl.'] },
      ],
      examples: [
        {
          title: 'Request',
          lang: 'http',
          code: `POST /v1/seeds HTTP/1.1
Host: seeds.crawler.internal
Authorization: Bearer <operator token>
Content-Type: application/json

{
  "seeds": [
    {
      "url": "HTTPS://Example.org:443/news#top",
      "priority": 1,
      "reason": "news sites list, reviewed"
    }
  ]
}`,
        },
        {
          title: 'Response',
          lang: 'http',
          code: `HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "audit_id": "seed-2026-11-12-0042",
  "results": [
    {
      "url": "https://example.org/news",
      "slot": 417,
      "owner": "crawler-07",
      "status": "queued"
    }
  ]
}`,
          note: 'The canonical URL is the key: posting the same seed again returns "already_known" and queues nothing.',
        },
      ],
    },
    {
      id: 'due', from: 'recrawl', to: 'frontier', d: 'M135,214 H244', label: 'due again',
      mode: 'call', via: 'gRPC', chip: 0.4,
      how: 'The scheduler calls Enqueue(urls) on the owning node for every URL whose time has come. It is the same call used for new links, so priorities and limits apply.',
      delivery: 'At-least-once. Enqueue ignores a URL that is already queued.',
      alts: ['The frontier scanning its own store for due URLs.', 'A delay queue with one timer per URL, which does not scale to billions.'],
      ways: [
        { name: 'gRPC', chosen: true, what: 'The scheduler calls Enqueue(urls) on the owning node, batched, for every URL now due. It is the same call new links use, so priority and limits apply.', pros: ['One entry point for new and due URLs.', 'Batched, so a few calls a second carry hundreds of URLs.', 'Enqueue ignores URLs already queued, so retries are safe.'], cons: ['The scheduler must know the slot map to find the owner.', 'If the owner is down, due URLs wait until it is replaced.'] },
        { name: 'The frontier scans its own store', what: 'Each node keeps next fetch times for its own hosts in RocksDB and scans for due ones itself. No scheduler service at all.', pros: ['No network hop and no extra service.', 'Recrawl moves with the slot automatically.'], cons: ['Each node holds every URL it owns, not only pending ones: about 500 million a node.', 'The metadata store and the node can disagree about what is due.'] },
        { name: 'A delay queue with a timer per URL', what: 'Put each URL on a queue that delivers it at its next fetch time. The queue does the waiting.', pros: ['Simple to explain: each URL comes back when due.', 'No range reads on the metadata store.'], cons: ['Does not scale to billions of URLs, each with a timer.', 'Queues are built to hold messages for minutes or days, not for a monthly interval.'] },
        { name: 'Through the discovered-urls topic', what: 'The scheduler produces due URLs to the topic keyed by host, and owners consume them like new links.', pros: ['Routing by host is already done.', 'Buffered and replayable if an owner is down.'], cons: ['Due URLs and new links mix, so a recrawl burst delays discovery.', 'One more producer on the busiest topic.'] },
      ],
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `syntax = "proto3";

service Frontier {
  // The same call for new links and for URLs due again.
  rpc Enqueue(EnqueueRequest) returns (EnqueueReply);
}

message EnqueueRequest {
  repeated QueuedUrl urls = 1;
}

message QueuedUrl {
  string url = 1;
  int32 priority = 2;
  string etag = 3;           // sent back as If-None-Match
  string last_modified = 4;  // sent back as If-Modified-Since
}

message EnqueueReply {
  int32 queued = 1;
  int32 already_queued = 2;  // ignored, so a retry is safe
}`,
        },
        {
          title: 'Example call',
          lang: 'text',
          code: `// recrawl scheduler -> crawler-07, owner of slot 417
Enqueue {
  urls: [
    { url: "https://example.org/news", priority: 1,
      etag: '"6731-a91c"',
      last_modified: "Thu, 12 Nov 2026 10:12:00 GMT" },
    ... 311 more URLs due in crawler-07's slots
  ]
}
-> EnqueueReply { queued: 312, already_queued: 0 }

// the same call retried after a timeout
-> EnqueueReply { queued: 0, already_queued: 312 }`,
          note: 'The ETag and date from the last fetch ride with the URL, so the fetcher can ask "only if changed".',
        },
      ],
    },
    {
      id: 'lease', from: 'frontier', to: 'fetcher', d: 'M424,176 H565', label: 'lease',
      mode: 'local', via: 'in-process', chip: 0.5,
      how: 'Fetchers ask the frontier for work: Lease(worker, max) returns URLs, each with a lease id and a deadline. Frontier and fetchers share a process, so the politeness decision never crosses the network.',
      delivery: 'At-least-once. A lease that is not completed by its deadline expires, and the URL is queued again.',
      alts: ['gRPC, when fetchers run as a separate pool that scales on its own.', 'A queue the fetchers poll. With SQS, receiving a message hides it for a visibility timeout, which plays the part of the lease.', 'Deleting the message from the queue as the acknowledgement, in a queue-based design.'],
      ways: [
        { name: 'in-process', chosen: true, what: 'Fetchers call Lease(worker, max) on the frontier in the same process, and Complete(lease, outcome, next fetch time) when done. About 50 leases a second a node.', pros: ['The politeness decision never crosses the network.', 'Cannot be slow or lost short of the process dying.', 'Complete frees the host at once for its next request.'], cons: ['Fetchers and frontier scale together, one node at a time.', 'A process crash loses both, and the leases expire and requeue.'] },
        { name: 'gRPC to a separate fetcher pool', what: 'Fetchers run as their own fleet and call Lease and Complete on the owning node over gRPC.', pros: ['Fetchers scale on their own.', 'A fetcher crash never touches frontier state.'], cons: ['A network hop on every lease and completion.', 'Fetchers must know the slot map to find the right frontier.'] },
        { name: 'A queue the fetchers poll (SQS)', what: 'Due URLs go onto a queue; receiving a message hides it for a visibility timeout, which plays the part of the lease.', pros: ['The lease comes free with the queue.', 'Fetchers are fully stateless.'], cons: ['The queue cannot tell when a host is next allowed, so politeness moves to locks.', 'A hop to the queue for every URL.'] },
        { name: 'Delete as the acknowledgement', what: 'In a queue-based design the fetcher deletes the message when the page is stored; until then it reappears after the timeout.', pros: ['No separate Complete call or lease table.', 'At-least-once with no code of your own.'], cons: ['Carries no outcome or next fetch time; those need their own write.', 'A fetch slower than the timeout is handed out twice.'] },
      ],
      examples: [
        {
          title: 'Lease',
          lang: 'text',
          code: `lease(worker: str, max: int) -> list[Lease]
Lease = (lease_id, url, slot, epoch, deadline)

frontier.lease(worker="fetch-03", max=8)
-> [Lease(lease_id="L417-55120",
          url="https://example.org/news",
          slot=417, epoch=7,
          deadline="2026-11-12T10:21:00Z")]

# Only hosts whose heap time has passed are offered,
# and one URL per host is out at a time.`,
        },
        {
          title: 'Complete (the reply)',
          lang: 'text',
          code: `complete(lease_id: str, outcome: Outcome,
         next_fetch_at: datetime) -> None

frontier.complete("L417-55120",
    outcome=Fetched(status=200, bytes=101872, took_ms=840),
    next_fetch_at="2026-11-12T10:50:01Z")

# example.org may be fetched again after
# max(1 s, Crawl-delay 2 s, 10 x 0.84 s) = 8.4 s.

# If fetch-03 dies, nothing calls complete. At 10:21:00
# the lease expires and the URL is queued again.
# A second or late complete("L417-55120", ...) is ignored.`,
          note: 'The lease id is what makes a repeated or late Complete harmless.',
        },
      ],
      reply: {
        id: 'result', label: 'complete',
        how: 'Complete(lease, outcome, next fetch time) frees the host for its next request and records what happened.',
        delivery: 'Safe to repeat, because it is keyed by lease id.',
      },
    },
    {
      id: 'coord', from: 'frontier', to: 'coord', d: 'M400,114 V49 Q400,39 390,39 H169', label: 'lease on slots',
      mode: 'call', via: 'gRPC keep-alive', chip: 0.633,
      how: 'Each node holds a session with the coordinator and renews the lease on its slots every few seconds. It also watches the slot map, so it hears at once when ownership changes.',
      delivery: 'Strongly consistent. This is the one conversation where everyone must agree, so it goes through consensus.',
      alts: ['ZooKeeper sessions with ephemeral nodes.', 'Gossip between nodes, with no single agreed view.'],
      ways: [
        { name: 'gRPC keep-alive', chosen: true, what: 'Each node holds a session with the coordinator, renews its lease of about 30 seconds every few seconds, and watches the slot map for changes. This is how etcd leases and watches work.', pros: ['Strongly consistent: one agreed owner per slot.', 'A watch tells a node of changes at once.', 'Epochs fence a node that was only paused.'], cons: ['A coordinator outage pauses every node.', 'A dead node\'s slots wait out the full lease.'] },
        { name: 'ZooKeeper sessions with ephemeral nodes', what: 'Each node registers an ephemeral node for each slot it owns; when its session ends, ZooKeeper deletes them and others are told.', pros: ['The same guarantee, from a long-proven tool.', 'Ownership vanishes by itself when a node dies.'], cons: ['Another cluster with its own operations.', 'Session timeouts need tuning against pauses, as leases do.'] },
        { name: 'Gossip between nodes', what: 'Nodes tell each other who is alive and work out slot owners from that. No central view exists.', pros: ['Nothing central to fail.', 'Scales to many nodes.'], cons: ['No single agreed view, so two nodes can briefly own one host.', 'That breaks politeness, the one thing this line protects.'] },
      ],
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `syntax = "proto3";

service Coordinator {
  rpc KeepAlive(stream Renew) returns (stream Renewed);
  rpc WatchSlots(WatchRequest) returns (stream SlotChange);
}

message Renew   { string node = 1; int64 lease_id = 2; }
message Renewed { int64 lease_id = 1; int32 ttl_seconds = 2; }

message WatchRequest { int64 from_revision = 1; }

message SlotChange {
  int32 slot = 1;
  string owner = 2;
  int64 epoch = 3;   // goes up by one on every move
}`,
        },
        {
          title: 'Example call, and the failure',
          lang: 'text',
          code: `// crawler-07 every 10 s; one lease covers its 51 slots
Renew   { node: "crawler-07", lease_id: 7041 }
Renewed { lease_id: 7041, ttl_seconds: 30 }

// 10:56:30 the last Renew. crawler-07 dies just after.
// 10:57:00 lease 7041 runs out and its slots move:
SlotChange { slot: 417, owner: "crawler-12", epoch: 8 }

// if crawler-07 was only paused and wakes up:
Renew { node: "crawler-07", lease_id: 7041 }
-> error NOT_FOUND: lease 7041 has expired
// It stops handing out leases at once. Anything it
// still sends carries epoch 7 and is refused.`,
          note: 'The epoch, 7 then 8, is what lets everyone tell the old owner from the new one.',
        },
      ],
    },
    {
      id: 'dns', from: 'fetcher', to: 'dns', d: 'M598,146 V63', label: 'resolve', travels: 'hostname, then IP addresses',
      mode: 'call', via: 'DNS', chip: 0.4,
      how: 'A DNS query over UDP to a caching resolver on the same machine or rack. Identical lookups in flight share one answer.',
      delivery: 'Best effort, with a short timeout and one retry. Repeated failures open a circuit breaker for that host.',
      alts: ['DNS over TCP or HTTPS to outside providers, in rotation.', 'The blocking resolver in the standard library.'],
      ways: [
        { name: 'DNS', chosen: true, what: 'A plain DNS query over UDP to a caching resolver on the same machine or rack. Identical lookups in flight share one answer.', pros: ['Fast: one short round trip inside the rack.', 'The cache cuts at most 400 lookups a second to tens.', 'Non-blocking, so it suits an event loop.'], cons: ['UDP answers can be lost, so it needs a timeout and a retry.', 'A local resolver to run.'] },
        { name: 'DNS over TCP or HTTPS to outside providers', what: 'Send lookups to two or three outside providers in turn, over TCP or HTTPS.', pros: ['Encrypted and harder to tamper with.', 'Survives one provider limiting you.'], cons: ['A connection and tens of milliseconds per uncached lookup.', 'No shared cache of your own.'] },
        { name: 'The blocking standard library resolver', what: 'Each fetch calls the operating system lookup and waits.', pros: ['Nothing to build.', 'Fine for a single-site crawl.'], cons: ['Holds a thread per lookup, the bottleneck Mercator measured.', 'One cache per process at best.'] },
        { name: 'Resolve once in the frontier', what: 'Resolve each host when its back queue is created and store the address with it, refreshing on expiry. Fetchers get the address with the lease.', pros: ['No lookup on the fetch path at all.', 'The address is known before the fetch, so the private-range check can happen early.'], cons: ['Addresses go stale between refreshes.', 'Moves the resolver call, it does not remove it.'] },
      ],
      examples: [
        {
          title: 'Query and answer',
          lang: 'text',
          code: `; fetch-03 -> rack resolver 10.4.0.53, UDP port 53
;; QUESTION
example.org.          IN  A

;; ANSWER (from the cache; a miss takes tens of ms)
example.org.   300    IN  A   203.0.113.27

; no answer within the timeout: one retry. Repeated
; failures open the breaker and the host is skipped.`,
        },
        {
          title: 'Then the address check',
          lang: 'text',
          code: `check 203.0.113.27
  not loopback      127.0.0.0/8
  not private       10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  not link-local    169.254.0.0/16 (cloud metadata lives here)
  -> allowed

connect to 203.0.113.27:443, TLS name example.org
# never a second lookup: that is the rebinding gap
# every redirect target is resolved and checked again`,
          note: 'Addresses on this page are from the documentation range 203.0.113.0/24.',
        },
      ],
    },
    {
      id: 'robots', from: 'fetcher', to: 'robots', d: 'M715,192 H862', label: 'allowed?',
      mode: 'local', via: 'cache read', chip: 0.4762,
      how: 'A lookup in memory of the host\'s parsed rules. On a miss, or after 24 hours, the fetcher requests /robots.txt over HTTPS like any other page and through the same rate limit.',
      delivery: 'Fail closed. No usable rules after a server error means no fetch.',
      alts: ['A shared cache, so every node sees one copy.', 'Rules kept in the metadata database and read on each fetch.'],
      ways: [
        { name: 'cache read', chosen: true, what: 'A lookup in memory of the host\'s parsed rules on the node that owns it. On a miss, or after 24 hours, the fetcher requests /robots.txt through the same rate limit.', pros: ['No network hop on the fetch path.', 'Only one node ever needs a host\'s rules, so one copy is enough.', 'Fail closed is easy: no usable rules, no fetch.'], cons: ['A failover empties the cache for the moved hosts.', 'Memory on each node for its hosts\' rules.'] },
        { name: 'A shared cache', what: 'All nodes read rules from one shared cache, such as Redis, filled by whichever node fetched them first.', pros: ['Survives a node restart or failover.', 'One copy to inspect or purge.'], cons: ['A network hop on every fetch, about 400 a second.', 'Partitioning by host means no other node needs the copy.'] },
        { name: 'Read from the metadata database', what: 'Rules are stored with the host\'s row and read before each fetch.', pros: ['Durable and auditable.', 'No separate cache service.'], cons: ['A database read on the hot path.', 'Load on the store every result depends on.'] },
      ],
      examples: [
        {
          title: 'Cache read',
          lang: 'text',
          code: `allowed(host: str, path: str) -> Decision

robots.allowed("example.org", "/news")
-> Allowed(rule=None)         # no rule matches: allowed
robots.allowed("example.org", "/news/drafts/q4")
-> Disallowed(rule="Disallow: /news/drafts/")
robots.allowed("example.org", "/news/drafts/public/a")
-> Allowed(rule="Allow: /news/drafts/public/")  # longer

# cached rules for example.org, fetched 09:41 today
User-agent: *
Disallow: /search
Disallow: /news/drafts/
Allow: /news/drafts/public/
Crawl-delay: 2`,
          note: 'The longest matching rule wins, which is why the public drafts folder is allowed.',
        },
        {
          title: 'On a miss, or after 24 hours',
          lang: 'http',
          code: `GET /robots.txt HTTP/1.1
Host: example.org
User-Agent: ExampleBot/1.0 (+https://crawler.example.net/bot)

HTTP/1.1 200 OK            -> parse, cache for 24 h
HTTP/1.1 404 Not Found     -> no restrictions
HTTP/1.1 503, or no answer -> disallow everything`,
        },
      ],
    },
    {
      id: 'ip', from: 'fetcher', to: 'iplimit', d: 'M690,146 V63', label: 'shared IP?',
      mode: 'call', via: 'Redis', chip: 0.4,
      how: 'One round trip to take a token from the bucket for this address. Asked only for addresses known to serve many sites.',
      delivery: 'Fail safe: if the limiter cannot be reached, fall back to a slow fixed rate for those addresses.',
      alts: ['A sliding-window counter and a lock per domain, checked on every request.', 'Nodes gossiping their per-address counts to each other.'],
      ways: [
        { name: 'Redis', chosen: true, what: 'One round trip to take a token from the bucket for this address, done atomically in Redis. Asked only for addresses known to serve many sites.', pros: ['Exact, shared counts across all 20 nodes.', 'Most fetches skip it, so its load is small.', 'Fails safe to a slow fixed rate.'], cons: ['A network hop for busy addresses.', 'A Redis to keep available.'] },
        { name: 'Sliding window and a lock per domain on every request', what: 'Every fetch takes a domain lock and a slot in a sliding-window counter, the queue-based design\'s approach.', pros: ['One rule for every fetch.', 'Works with fully stateless fetchers.'], cons: ['A hop on every fetch, about 400 a second, to protect what the frontier already protects.', 'A hot dependency for the whole crawl.'] },
        { name: 'Gossip per-address counts', what: 'Nodes share how often they hit each busy address, and each slows down when the total is high.', pros: ['No central service.', 'Nothing on the fetch path.'], cons: ['Counts are always a little old, so bursts slip through.', 'Each node can only guess its share of the limit.'] },
        { name: 'Route busy addresses to one owner', what: 'Assign each busy address to one slot, so all its hosts land on one node and the local limit covers them.', pros: ['No limiter service at all.', 'Politeness stays local and lock-free.'], cons: ['Addresses are only known after a lookup, and hosts move between them.', 'One node carries every host on a big platform.'] },
      ],
      examples: [
        {
          title: 'Commands',
          lang: 'text',
          code: `# 203.0.113.27 is on the busy list: many hosts share it.
# A script takes one token, atomically.
# args: rate a second, burst, now in ms, cost
EVALSHA <take_token> 1 tb:ip:203.0.113.27 4 8 1794478800120 1
# -> 1   token taken

# and from the registrable domain's bucket
EVALSHA <take_token> 1 tb:dom:example.org 1 2 1794478800121 1
# -> 1   token taken: fetch now

# an empty bucket returns 0: the host goes back on the
# heap and waits. Redis unreachable: use the slow fixed
# rate for this address instead.`,
          note: 'The rates here (4 a second per address, 1 per domain) are illustrations; the page sets none.',
        },
      ],
    },
    {
      id: 'get', from: 'fetcher', to: 'web', d: 'M715,160 H735 Q745,160 745,150 V146 Q745,136 755,136 H1180 Q1190,136 1190,126 V63', label: 'GET',
      mode: 'external', via: 'HTTPS', chip: 0.655,
      how: 'An HTTP GET over TLS, sent to the address that was checked. There is a deadline for connecting, for the handshake and for reading, and a cap on size and on redirects.',
      delivery: 'Nothing is promised by the other side. Timeouts, 429 and 5xx go to retry with back-off, three attempts in all.',
      alts: ['HTTP/2, to reuse one connection per host.', 'A HEAD request first, to skip very large files.', 'A headless browser, for pages that need scripts.', 'Streaming the body straight into the archive file as it arrives.'],
      ways: [
        { name: 'HTTPS', chosen: true, what: 'An HTTP GET over TLS to the address that was checked, with deadlines on connect, handshake and read, a 10 MB cap and at most five redirects. Recrawls send conditional headers.', pros: ['Works with every server on the web.', 'Deadlines and caps bound what any one server can cost.', 'Conditional headers make an unchanged page a 304.'], cons: ['A new connection per fetch costs a TLS handshake each time.', 'Nothing is promised by the other side.'] },
        { name: 'HTTP/2, one connection per host', what: 'Keep one connection open per host and send each request on it, with one request in flight at a time.', pros: ['Saves the handshake on every fetch after the first.', 'Gentler on the server.'], cons: ['With a gap of a second or more between fetches, connections sit idle or close anyway.', 'Not every server supports it, so HTTP/1.1 stays as a fallback.'] },
        { name: 'A HEAD request first', what: 'Ask for headers only, check type and size, then GET if worth it.', pros: ['Skips very large files and non-HTML before downloading them.', 'A HEAD reply is tiny, so the check itself costs the server little.'], cons: ['Two requests per page, which doubles the politeness cost.', 'Servers often omit or misstate the size; the 10 MB cap does the job anyway.'] },
        { name: 'A headless browser', what: 'Load the page in a browser so scripts run before the content is read.', pros: ['Sees script-built pages.', 'Finds links that scripts add.'], cons: ['Ten to a hundred times the cost of a fetch.', 'The design keeps it in a separate render pool for the few pages that need it.'] },
        { name: 'Stream the body into the archive file', what: 'Write bytes into the WARC batch as they arrive instead of holding the whole body in memory.', pros: ['Memory per fetch stays small, even near the 10 MB cap.', 'No second copy of the body before upload.'], cons: ['The parser then cannot be handed the page from memory.', 'A failed fetch leaves a partial record to clean up.'] },
      ],
      examples: [
        {
          title: 'Request',
          lang: 'http',
          code: `GET /news HTTP/1.1
Host: example.org
User-Agent: ExampleBot/1.0 (+https://crawler.example.net/bot)
Accept: text/html

# over TLS to 203.0.113.27:443, the checked address
# deadlines on connect, handshake and read
# caps: 10 MB of body, at most 5 redirects`,
        },
        {
          title: 'Response',
          lang: 'http',
          code: `HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Length: 101872
ETag: "6731-a91c"
Last-Modified: Thu, 12 Nov 2026 10:12:00 GMT

<!doctype html>
<html lang="en"><head><title>News</title>
# 101,872 bytes in all; reading stops at 10 MB`,
        },
        {
          title: 'Recrawl, and a busy site',
          lang: 'http',
          code: `# 10:50:01, the same URL due again
GET /news HTTP/1.1
Host: example.org
If-None-Match: "6731-a91c"
If-Modified-Since: Thu, 12 Nov 2026 10:12:00 GMT

HTTP/1.1 304 Not Modified
ETag: "6731-a91c"
# headers only: nothing changed, nothing to store

# or, if the site is struggling:
HTTP/1.1 429 Too Many Requests
Retry-After: 120`,
          note: 'Retry-After is obeyed; without it the host\'s delay doubles.',
        },
      ],
      reply: {
        id: 'resp', label: 'response',
        how: 'The reply on the same connection: a status, headers and up to 10 MB of body. A 304 on a recrawl means nothing changed.',
        delivery: 'Read with a deadline. A server that sends one byte a second is cut off.',
      },
    },
    {
      id: 'raw', from: 'fetcher', to: 'blob', d: 'M690,206 V216 Q690,226 700,226 H1210 Q1220,226 1220,236 V289', label: 'raw page',
      mode: 'write', via: 'S3 PUT', chip: 0.69,
      how: 'About 500 pages are compressed into one WARC file and uploaded with a single PUT. The byte range of each page then goes to the metadata store.',
      delivery: 'At-least-once. A batch lost before upload is fetched again.',
      alts: ['One PUT per page.', 'Appending to a log first and archiving from it later.'],
      ways: [
        { name: 'S3 PUT', chosen: true, what: 'About 500 pages are compressed into one WARC file of about 10 MB and uploaded with a single PUT. Each page\'s byte range then goes to the metadata store.', pros: ['Under one upload a second across the crawl, against about 400.', 'Durable once acknowledged.', 'A new object each time, so a retry is harmless.'], cons: ['Up to 500 pages wait in a buffer and are refetched if it is lost.', 'The byte-range write is a second step that must follow the PUT.'] },
        { name: 'One PUT per page', what: 'Each page is compressed and uploaded on its own as soon as it is fetched.', pros: ['Nothing buffered, so nothing lost after the PUT.', 'Reading a page back is a plain GET.'], cons: ['About 400 PUTs a second, 1 billion a month, each with a request charge.', 'Billions of small objects to list and manage.'] },
        { name: 'Append to a log, archive later', what: 'Write each page to a durable log such as Kafka first; a separate job batches the log into WARC files.', pros: ['Durable within milliseconds, with no local buffer to lose.', 'Archiving can be retried without refetching.'], cons: ['About 320 Mbit/s of pages through the log, a much bigger cluster.', 'Two copies of every page for a while.'] },
      ],
      examples: [
        {
          title: 'Upload one batch',
          lang: 'http',
          code: `PUT /crawl-raw/warc/2026/11/12/crawler-07/000183.warc.gz HTTP/1.1
Host: <object store endpoint>
Content-Type: application/gzip
Content-Length: 10391522
Content-MD5: <base64 MD5 of the body>

<500 WARC records, each gzipped on its own>

HTTP/1.1 200 OK
# a retry writes the same bytes to the same key`,
          note: 'Each record is its own gzip member, so one page can be read back by byte range.',
        },
        {
          title: 'One record in the file',
          lang: 'text',
          code: `WARC/1.1
WARC-Type: response
WARC-Target-URI: https://example.org/news
WARC-Date: 2026-11-12T10:20:01Z
WARC-IP-Address: 203.0.113.27
WARC-Record-ID: <urn:uuid:1b0e6c2a-5f43-4c1e-9d7a-2a61f0c8e915>
Content-Type: application/http; msgtype=response
Content-Length: 102118

HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
ETag: "6731-a91c"

<!doctype html>`,
        },
        {
          title: 'Then the byte range, in the metadata store (CQL)',
          lang: 'sql',
          code: `UPDATE crawl.urls
SET warc_file = 'warc/2026/11/12/crawler-07/000183.warc.gz',
    warc_offset = 4812330,
    warc_length = 20517
WHERE url = 'https://example.org/news';`,
          note: 'About 100 KB of HTML is about 20 KB compressed, so the record spans 20,517 bytes.',
        },
      ],
    },
    {
      id: 'page', from: 'fetcher', to: 'parser', d: 'M600,206 V268 Q600,278 610,278 H910 Q920,278 920,288 V300', label: 'page',
      mode: 'local', via: 'pipe', chip: 0.57,
      how: 'The fetched bytes are handed over a pipe to a sandboxed parser process on the same node, straight from memory. There is no network hop and no read from storage on the hot path, and a crash in the parser cannot take the fetcher down.',
      delivery: 'Retried from the stored raw page. A page that fails three times is quarantined.',
      alts: ['A pages-fetched topic that parser workers consume, so parsing scales apart from fetching.', 'A queue of page ids, with the bytes read back from the object store.'],
      ways: [
        { name: 'pipe', chosen: true, what: 'The fetched bytes go over a pipe, in memory, to a sandboxed parser process on the same node. No network hop and no read from storage on the hot path.', pros: ['Fast and cheap: the page is already in memory.', 'A parser crash cannot take the fetcher down.', 'A failed parse is retried from the stored raw page.'], cons: ['Parsing scales with the node, not on its own.', 'A full pipe must slow the fetcher, so back-pressure is designed in.'] },
        { name: 'A pages-fetched topic', what: 'Fetchers publish each page, or a pointer to it, on a topic that a pool of parser workers consumes.', pros: ['Parsing scales and fails apart from fetching.', 'Lag on the topic shows when parsing falls behind.'], cons: ['Pages through a broker are about 320 Mbit/s; pointers mean a read back instead.', 'Another topic to run and watch.'] },
        { name: 'A queue of page ids, bytes from the object store', what: 'Fetchers queue the id and byte range of each stored page; parsers read it back with a ranged GET.', pros: ['Small messages, and the parser always reads the stored copy.', 'One path for live pages and reprocessing.'], cons: ['Every page is read back, about 400 GETs a second.', 'The parser waits for the batch upload, up to 500 pages later.'] },
      ],
      examples: [
        {
          title: 'One frame on the pipe',
          lang: 'text',
          code: `# fetcher -> sandboxed parser on crawler-07
# a JSON header line, then exactly body_bytes of body
{"url": "https://example.org/news", "status": 200,
 "content_type": "text/html; charset=utf-8",
 "fetched_at": "2026-11-12T10:20:01Z",
 "lease_id": "L417-55120", "body_bytes": 101872}
<!doctype html>
<html lang="en"><head><title>News</title>

# parser exits on this page: failure 1 of 3. The page
# is retried later from its stored WARC record, and
# quarantined after the third failure.`,
        },
      ],
    },
    {
      id: 'replay', from: 'blob', to: 'parser', d: 'M1105,314 H962', label: 'reprocess',
      mode: 'call', via: 'S3 GET', chip: 0.6, cold: true,
      how: 'Off the hot path. When a parser bug is fixed or a new extractor ships, a job reads stored WARC batches back with ranged GETs and feeds every page to the parser again, so the web is never asked twice. Pages the render pool has rendered come back the same way. On the hot path the parser gets each page in memory from the fetcher on the same node.',
      delivery: 'Read-only and repeatable. Reprocessing a page writes the same upserts again, which changes nothing.',
      alts: ['Fetching the pages again, which costs every site a second visit.', 'Keeping only extracted text, which makes a parser bug permanent.'],
      ways: [
        { name: 'S3 GET', chosen: true, what: 'A job reads stored WARC batches with ranged GETs and feeds every page to the parser again. Rendered pages come back the same way.', pros: ['The web is never asked twice.', 'Read-only and repeatable: the upserts it causes change nothing.', 'Runs at whatever pace the job chooses.'], cons: ['Reads of up to 20 TB a month of compressed pages cost transfer and requests.', 'Needs the byte-range index in the metadata store.'] },
        { name: 'Fetch the pages again', what: 'Treat a parser fix as a recrawl: put the affected URLs back in the frontier.', pros: ['No archive needed at all.', 'Gets the current page, not an old one.'], cons: ['Costs every site a second visit.', 'At 1 request a second per host, a large site takes days.'] },
        { name: 'Keep only extracted text', what: 'Reprocess the stored text instead of the raw page.', pros: ['A fraction of the storage and the read.', 'Fine for changes that only touch text.'], cons: ['A parser bug is permanent: what it dropped is gone.', 'New extractors, such as for links or metadata, cannot run.'] },
      ],
      examples: [
        {
          title: 'Find the record (CQL)',
          lang: 'sql',
          code: `SELECT warc_file, warc_offset, warc_length
FROM crawl.urls
WHERE url = 'https://example.org/news';

-- warc/2026/11/12/crawler-07/000183.warc.gz
--   | 4812330 | 20517`,
        },
        {
          title: 'Ranged GET',
          lang: 'http',
          code: `GET /crawl-raw/warc/2026/11/12/crawler-07/000183.warc.gz HTTP/1.1
Host: <object store endpoint>
Range: bytes=4812330-4832846

HTTP/1.1 206 Partial Content
Content-Range: bytes 4812330-4832846/10391522
Content-Length: 20517

<one gzip member: the WARC record for /news>`,
          note: 'The range ends at offset plus length minus one: 4,812,330 + 20,517 - 1.',
        },
      ],
    },
    {
      id: 'snapshot', from: 'frontier', to: 'blob', d: 'M424,216 H490 Q500,216 500,226 V412 Q500,422 510,422 H1130 Q1140,422 1140,412 V359', label: 'snapshot',
      mode: 'write', via: 'S3 PUT, GET', chip: 0.12, chipY: 265, cold: true,
      how: 'Every few minutes the node writes a snapshot of its frontier (queues, heap and leases) to the object store, with the discovered-urls offsets it had read up to. A node that takes over these slots restores the latest snapshot and replays the topic from those offsets.',
      delivery: 'Each snapshot is a new object, written once, and the newest complete one wins. Losing one only means replaying more of the topic.',
      alts: ['Replicating the frontier to a standby node, which is faster to fail over and doubles the disks.', 'Rebuilding the frontier from the metadata store, which is the slow last resort.'],
      ways: [
        { name: 'S3 PUT, GET', chosen: true, what: 'Every few minutes the node writes its frontier, about 15 GB, as a new object with the topic offsets it had read to. A new owner reads the newest complete one and replays the topic from those offsets.', pros: ['Cheap: no standby machines.', 'Snapshot and offsets always agree, so replay starts at the right place.', 'Losing one snapshot only means replaying more.'], cons: ['Recovery takes a download and a replay, minutes not seconds.', 'Leases and back-offs are a few minutes old after restore, so some URLs are fetched again.', 'A full 15 GB copy every 5 minutes would be about 50 MB/s a node, ten times its page traffic, so snapshots need to be incremental.'] },
        { name: 'Replicate to a standby node', what: 'Stream every frontier change to a standby that can take over the slots at once.', pros: ['Fastest failover, with almost nothing to replay.', 'No object store on the recovery path.'], cons: ['Doubles the disks and the machines.', 'The standby must be fenced too, or there are two owners.'] },
        { name: 'Rebuild from the metadata store', what: 'Range-read every URL in the moved slots that is pending or due, and rebuild the queues from that.', pros: ['No snapshot to write.', 'The store is the record of truth anyway.'], cons: ['The slow last resort: a node\'s share is about 500 million URLs to read.', 'Heavy read load on the store while the crawl runs.'] },
      ],
      examples: [
        {
          title: 'Write the snapshot',
          lang: 'http',
          code: `# crawler-07 at 10:55:00, one set of objects per slot
PUT /crawl-frontier/slot-0417/20261112T105500Z/queues.sst
PUT /crawl-frontier/slot-0417/20261112T105500Z/heap.bin
PUT /crawl-frontier/slot-0417/20261112T105500Z/leases.bin
# the manifest goes last; a set without one is incomplete
PUT /crawl-frontier/slot-0417/20261112T105500Z/manifest.json`,
        },
        {
          title: 'The manifest',
          lang: 'json',
          code: `{
  "slot": 417,
  "node": "crawler-07",
  "epoch": 7,
  "taken_at": "2026-11-12T10:55:00Z",
  "discovered_urls": {
    "partition": 417,
    "next_offset": 88214305
  },
  "files": ["queues.sst", "heap.bin", "leases.bin"]
}`,
          note: 'The topic offset is saved in the same object as the frontier, so the two always agree.',
        },
        {
          title: 'Restore (the reply)',
          lang: 'http',
          code: `# crawler-12, owner of slot 417 since epoch 8
GET /crawl-frontier?list-type=2&prefix=slot-0417/
# newest set with a manifest: 20261112T105500Z
GET /crawl-frontier/slot-0417/20261112T105500Z/manifest.json
GET /crawl-frontier/slot-0417/20261112T105500Z/queues.sst
GET /crawl-frontier/slot-0417/20261112T105500Z/heap.bin
GET /crawl-frontier/slot-0417/20261112T105500Z/leases.bin
# URLs leased at 10:55 go back in the queue
# then replay discovered-urls partition 417 from 88214305
# an unreadable manifest: use the set before it`,
        },
      ],
      reply: {
        id: 'restore', label: 'restore', via: 'S3 GET', mode: 'call', chip: 'S3 GET, restore',
        how: 'After a failover the new owner reads the newest complete snapshot with an S3 GET and rebuilds its queues and heap from it.',
        delivery: 'Read-only and repeatable. A snapshot that cannot be read means falling back to an older one and replaying more of the topic.',
      },
    },
    {
      id: 'render', from: 'parser', to: 'render', d: 'M962,338 H1078 Q1088,338 1088,348 V525 Q1088,535 1098,535 H1106', label: 'needs scripts',
      mode: 'async', via: 'Kafka render', chip: 0.6, chipY: 470,
      how: 'A render-requests topic. The parser publishes the URL, and a small pool of headless browsers consumes it at its own pace.',
      delivery: 'At-least-once. A slow pool builds up lag, and never pushes back on the crawl.',
      alts: ['A direct call with a tight timeout.', 'A managed queue with a dead-letter queue for pages that crash the browser.'],
      ways: [
        { name: 'Kafka render', chosen: true, what: 'The parser publishes the URL on a render-requests topic, and a small pool of headless browsers consumes it at its own pace.', pros: ['A slow pool builds lag and never pushes back on the crawl.', 'The pool can be sized, paused or switched off without touching the nodes.', 'Requests survive a pool restart.'], cons: ['At-least-once, so a page may be rendered twice.', 'Pages that crash the browser need their own retry limit.'] },
        { name: 'A direct call with a tight timeout', what: 'The parser calls the render pool and waits for the rendered page, giving up after a few seconds.', pros: ['Simplest: no topic.', 'The parser gets the result at once.'], cons: ['Rendering costs ten to a hundred times a fetch, so the parser waits on the slowest part.', 'A busy pool turns into timeouts and lost requests.'] },
        { name: 'A managed queue with a dead-letter queue', what: 'Render requests go on a managed queue; pages that crash the browser three times go to a dead-letter queue.', pros: ['No brokers to run for a small, bursty stream.', 'Poison pages are set aside by the queue itself.'], cons: ['A second messaging system beside Kafka.', 'No replay once a message is deleted.'] },
      ],
      examples: [
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic:      render-requests
key:        host ("example.org")
partitions: a few; the pool is small
the key:    a host's requests reach one consumer, so the
            pool can pace its own visit to that host`,
        },
        {
          title: 'Message value',
          lang: 'json',
          code: `{
  "url": "https://example.org/live",
  "host": "example.org",
  "reason": "almost_empty_body",
  "text_bytes": 212,
  "requested_at": "2026-11-12T10:20:02Z",
  "attempt": 1
}`,
          note: 'Not the page the tour follows, which is plain HTML: /live is a page on the same site whose text appears only after scripts run.',
        },
      ],
    },
    {
      id: 'rendered', from: 'render', to: 'blob', d: 'M1214,507 V359', label: 'rendered',
      mode: 'write', via: 'S3 PUT', chip: 0.7, chipY: 405,
      how: 'The rendered page is written to the object store in a WARC batch, like any fetched page, and the parser picks it up from there on the reprocessing path. The browser never calls the parser directly.',
      delivery: 'At-least-once. Rendering twice stores the page twice, and the content hash makes the second copy a pointer.',
      alts: ['Returning the rendered HTML on a results topic the parser consumes.', 'A direct call back to the parser, which couples the pool to the crawl.'],
      ways: [
        { name: 'S3 PUT', chosen: true, what: 'The rendered page goes into a WARC batch in the object store, like any fetched page. The parser picks it up on the reprocessing path.', pros: ['Stored before it is parsed, like every page.', 'The browser never calls the parser, so the pool cannot slow the crawl.', 'One archive for fetched and rendered pages.'], cons: ['The parser reads it back later, so rendered pages arrive with a delay.', 'Rendering twice stores two copies; the content hash makes the second a pointer.'] },
        { name: 'A results topic the parser consumes', what: 'The pool publishes rendered HTML on a topic, and parsers consume it like a pipe from a fetcher.', pros: ['Lower delay than going through the object store.', 'Back-pressure is lag, not errors.'], cons: ['Large messages on a topic.', 'The page must still be stored, so it is written twice.'] },
        { name: 'A direct call back to the parser', what: 'The pool calls a parser endpoint with the rendered page.', pros: ['Fastest path to the parser.', 'No topic or extra storage step.'], cons: ['Couples the pool to the crawl.', 'The rendered page is not stored first, which breaks the store-first rule.'] },
      ],
      examples: [
        {
          title: 'Upload',
          lang: 'http',
          code: `PUT /crawl-raw/warc/2026/11/12/render-02/000041.warc.gz HTTP/1.1
Host: <object store endpoint>
Content-Type: application/gzip
Content-MD5: <base64 MD5 of the body>

<WARC records for the pages this browser rendered>

HTTP/1.1 200 OK`,
        },
        {
          title: 'One record in the file',
          lang: 'text',
          code: `WARC/1.1
WARC-Type: conversion
WARC-Target-URI: https://example.org/live
WARC-Date: 2026-11-12T10:20:09Z
WARC-Record-ID: <urn:uuid:7c2d9e41-0b6a-4f8e-a3d5-6e19b2c47f08>
Content-Type: text/html; charset=utf-8
Content-Length: 88410

<!doctype html>
# the page as the browser left it, after scripts ran`,
          note: 'Its byte range goes to the metadata store as for a fetched page, and the parser reads it from there.',
        },
      ],
    },
    {
      id: 'events', from: 'parser', to: 'downstream', d: 'M935,356 V500', label: 'events',
      mode: 'async', via: 'Kafka events', chip: 0.2, chipY: 389,
      how: 'One event per crawled page on a crawl.pages topic, and link tables written as Parquet files. Consumers read at their own pace and can replay.',
      delivery: 'At-least-once. Events carry the URL and content hash, so consumers can drop repeats.',
      alts: ['Notifications from the object store.', 'Consumers polling the metadata store.'],
      ways: [
        { name: 'Kafka events', chosen: true, what: 'One event per crawled page on a crawl.pages topic, about 400 a second, and link tables as Parquet files. Consumers read at their own pace and can replay.', pros: ['A slow consumer never slows the crawl.', 'New consumers can replay from the start of retention.', 'Events carry URL and hash, so repeats can be dropped.'], cons: ['A schema to version.', 'At-least-once, so every consumer must handle repeats.'] },
        { name: 'Notifications from the object store', what: 'The object store sends a notice for each new WARC batch, and consumers read the batch.', pros: ['Nothing for the crawler to publish.', 'Consumers always get the stored page.'], cons: ['One notice per batch of 500 pages, with no per-page outcome or links.', 'No replay beyond what the notice system keeps.'] },
        { name: 'Consumers poll the metadata store', what: 'Consumers range-read rows changed since their last read.', pros: ['Nothing new to build.', 'Always the current state.'], cons: ['Their reads compete with the crawl.', 'The crawler\'s schema becomes their interface.'] },
      ],
      examples: [
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic:   crawl.pages
key:     URL ("https://example.org/news")
rate:    about 400 events a second
the key: every event for a URL lands on one partition,
         in order, so a consumer drops repeats by URL
         and content hash`,
        },
        {
          title: 'Message value',
          lang: 'json',
          code: `{
  "url": "https://example.org/news",
  "fetched_at": "2026-11-12T10:20:01Z",
  "status": 200,
  "content_hash": "sha256:4be1c0f29d7a5e3b",
  "simhash": "5d21c8a4f00e9b37",
  "changed": true,
  "links_out": 52,
  "next_fetch_at": "2026-11-12T10:50:01Z"
}`,
          note: 'The hashes are shortened here; a SHA-256 is 64 hex digits.',
        },
        {
          title: 'Link table (Parquet)',
          lang: 'text',
          code: `file:    links/date=2026-11-12/crawler-07-0031.parquet
columns: from_url, to_url, anchor_text, found_at

one row:
  from_url     https://example.org/news
  to_url       https://example.org/news/2026/11/rates
  anchor_text  "Rates held this month"
  found_at     2026-11-12T10:20:02Z`,
        },
      ],
    },
    {
      id: 'links', from: 'parser', to: 'filter', d: 'M832,328 H684', label: 'links',
      mode: 'local', via: 'in-process', chip: 0.4223,
      how: 'A function call inside the node. The parser passes each batch of extracted links to the filter.',
      delivery: 'Cannot be lost short of the process dying, in which case the page is parsed again.',
      alts: ['A topic of extracted links, if filtering ran as its own service.'],
      ways: [
        { name: 'in-process', chosen: true, what: 'A function call inside the node: the parser passes each batch of extracted links to the filter. About 50 links a page.', pros: ['Cannot be slow or lost short of the process dying.', 'No serialising of about 2,500 links a second a node.', 'If the process dies, the page is parsed again from storage.'], cons: ['Filter rules ship with the parser.', 'Both scale together.'] },
        { name: 'A topic of extracted links', what: 'The parser publishes links, and a separate filter service consumes them, canonicalises and routes.', pros: ['Filtering scales and deploys on its own.', 'One filter service could serve several parsers.'], cons: ['20,000 links a second through a broker for work that takes microseconds.', 'Another hop before a link reaches its owner.'] },
      ],
      examples: [
        {
          title: 'The call',
          lang: 'text',
          code: `route(page: str, links: list[str]) -> None

filter.route(page="https://example.org/news", links=[
  "/news/2026/11/rates",
  "HTTPS://Example.org:443/about#team",
  "https://blog.example.net/p/12",
  "/calendar/2099/01/",
  ... 48 more, 52 in all
])`,
          note: 'Links arrive as written in the page: relative, mixed case, with fragments.',
        },
      ],
    },
    {
      id: 'local', from: 'filter', to: 'seen', d: 'M541,328 H413', label: 'mine',
      mode: 'local', via: 'in-process', chip: 0.4928,
      how: 'A function call for links whose host this node owns, which is most of them.',
      delivery: 'In memory. Repeats are harmless, because the seen-check drops them.',
      alts: ['Sending every link through the topic, local ones included, for one code path at the cost of a broker round trip.'],
      ways: [
        { name: 'in-process', chosen: true, what: 'A function call for links whose host this node owns, which is most of them. They go straight to the seen check.', pros: ['Most links never leave the node.', 'No broker load for the bulk of 20,000 links a second.', 'Repeats are harmless, because the seen check drops them.'], cons: ['Two code paths, local and remote, to test.', 'Local links are not in the log; after a failover they come back only when pages fetched since the snapshot are fetched again.'] },
        { name: 'Every link through the topic', what: 'Produce every link to discovered-urls, local ones included, and let each node consume only its own.', pros: ['One code path for every link.', 'Every link is in the log, so replay covers them all.'], cons: ['A broker round trip for links that never needed to leave the node.', 'Topic traffic rises to all 20,000 links a second.'] },
      ],
      examples: [
        {
          title: 'What the filter does with them',
          lang: 'text',
          code: `# canonical form, rules, then slot = hash(host) mod 1,024
/news/2026/11/rates
  -> https://example.org/news/2026/11/rates   slot 417, mine
HTTPS://Example.org:443/about#team
  -> https://example.org/about                slot 417, mine
https://blog.example.net/p/12
  -> slot 88, owner crawler-03: to discovered-urls
/calendar/2099/01/
  -> dropped: a date far in the future (trap rule)`,
        },
        {
          title: 'The call',
          lang: 'text',
          code: `check(slot: int, urls: list[str]) -> None

seen.check(slot=417, urls=[
  "https://example.org/news/2026/11/rates",
  "https://example.org/about",
])`,
        },
      ],
    },
    {
      id: 'new', from: 'seen', to: 'frontier', d: 'M334,300 V230', label: 'new only',
      mode: 'local', via: 'in-process', chip: 0.4286,
      how: 'Enqueue(urls) inside the node, for URLs that have never been met before.',
      delivery: 'The fingerprint and the frontier entry are written to the same RocksDB in one write batch, so a crash cannot leave a URL marked seen but never queued, or queued twice.',
      alts: ['Marking the URL seen when it is fetched, not when it is queued, which lets duplicates pile up in the frontier.'],
      ways: [
        { name: 'in-process', chosen: true, what: 'Enqueue(urls) inside the node for URLs never met before. The fingerprint and the frontier entry go into the same RocksDB in one write batch.', pros: ['A crash cannot leave a URL seen but never queued, or queued twice.', 'No network hop.', 'Marking at enqueue keeps duplicates out of the frontier.'], cons: ['The seen set and the frontier must live in one store on one node.', 'A failover must restore both together.'] },
        { name: 'Mark seen when fetched', what: 'Queue every link that is not yet fetched, and record the fingerprint only after the fetch.', pros: ['The seen set records only pages truly crawled.', 'A URL dropped from the frontier can be found again.'], cons: ['Duplicates pile up in the frontier: a menu link is queued once per page that shows it.', 'The frontier grows far past 2 billion pending URLs.'] },
        { name: 'Two separate writes', what: 'Write the fingerprint, then enqueue, as two steps in two stores.', pros: ['The seen set and the frontier can live in different systems.', 'Each can be scaled or replaced alone.'], cons: ['A crash between the two marks a URL seen that was never queued: a page never crawled.', 'Needs a repair job to find such URLs.'] },
      ],
      examples: [
        {
          title: 'Seen check',
          lang: 'text',
          code: `# 64-bit fingerprint of each canonical URL
fp("https://example.org/news/2026/11/rates")
  = 9f3c51e07a2b4d18   not in the set: new
fp("https://example.org/about")
  = 41d7a0c95e6b2f03   in the set: dropped

frontier.enqueue(slot=417, urls=[
  "https://example.org/news/2026/11/rates",
])`,
        },
        {
          title: 'One write batch (RocksDB)',
          lang: 'text',
          code: `batch = WriteBatch()
batch.put("seen/9f3c51e07a2b4d18", "")
batch.put("queue/417/example.org/000918273",
          "https://example.org/news/2026/11/rates p=2")
db.write(batch)   # both keys, or neither`,
          note: 'Fingerprint and queue entry land together, so a crash cannot mark a URL seen that was never queued.',
        },
      ],
    },
    {
      id: 'cross', from: 'filter', to: 'kafka', d: 'M558,356 V503', label: 'not mine', travels: 'URLs whose host another node owns',
      mode: 'async', via: 'Kafka produce', chip: 0.65, chipY: 455,
      how: 'Links whose host belongs to another node are produced to the discovered-urls topic, keyed by host and sent in batches. There is one partition per slot.',
      delivery: 'At-least-once, and in order per host. The seen-check at the far end makes repeats harmless.',
      alts: ['Direct calls between nodes, with local buffering and retries.', 'A queue per node, which cannot move with a slot when its owner fails.'],
      ways: [
        { name: 'Kafka produce', chosen: true, what: 'Links whose host belongs to another node are produced to discovered-urls, keyed by host and sent in batches. There is one partition per slot, 1,024 in all.', pros: ['In order per host, and replayable.', 'Batched, so cost per link is small.', 'The partition moves with its slot when an owner fails.'], cons: ['At-least-once: repeats rely on the seen check at the far end.', 'If the topic is down, links buffer on local disk.'] },
        { name: 'Direct calls between nodes', what: 'The filter calls Enqueue on the owner over gRPC, batched, buffering locally and retrying when the owner is down.', pros: ['No broker.', 'Lowest delay to the far frontier.'], cons: ['Retries, buffering and back-pressure are your code.', 'No replay for a new owner after a failover.'] },
        { name: 'A queue per node', what: 'Each node has its own inbound queue, and senders look up the owner and send there.', pros: ['Simple routing once the owner is known.', 'Each node reads one queue.'], cons: ['Cannot move with a slot when its owner fails: messages for moved slots are stranded.', 'Senders must re-route during every ownership change.'] },
      ],
      examples: [
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic:      discovered-urls
partitions: 1,024, one per slot
key:        host ("blog.example.net")
partition:  88, set to the slot, hash(host) mod 1,024
the key:    a host's links reach one node, in order, and
            the partition moves with the slot on failover
producer:   acks=all, batched per partition`,
        },
        {
          title: 'Message value',
          lang: 'json',
          code: `{
  "url": "https://blog.example.net/p/12",
  "host": "blog.example.net",
  "slot": 88,
  "found_on": "https://example.org/news",
  "found_at": "2026-11-12T10:20:02Z",
  "priority": 2
}`,
          note: 'Sending it twice is harmless: the seen check on crawler-03 drops the repeat.',
        },
      ],
    },
    {
      id: 'inbound', from: 'kafka', to: 'seen', d: 'M387,535 H344 Q334,535 334,525 V356', label: 'from other nodes',
      mode: 'async', via: 'Kafka consume', chip: 0.6, chipY: 445,
      how: 'Each node consumes exactly the partitions of the slots it owns, assigned from the coordinator\'s slot map. After a failover the new owner replays from the offset saved with the last snapshot.',
      delivery: 'At-least-once, with replay. Offsets are saved with the frontier snapshot, so the two always agree.',
      alts: ['Consumer groups, which are simpler, but two consumers can briefly hold one partition during a rebalance.'],
      ways: [
        { name: 'Kafka consume', chosen: true, what: 'Each node is assigned the partitions of its slots from the coordinator\'s slot map, about 51 each. Offsets are saved with the frontier snapshot.', pros: ['Ownership of partitions and slots comes from one map, so they cannot disagree.', 'Snapshot and offsets agree, so replay starts at the right place.', 'Repeats are dropped by the seen check.'], cons: ['Assignment is your code, not the broker\'s.', 'Lag must be watched per partition.'] },
        { name: 'Consumer groups', what: 'All nodes join one consumer group, and the broker shares out the partitions and moves them when a node leaves.', pros: ['Simpler: membership and assignment are built in.', 'No slot map to read for consuming.'], cons: ['Two consumers can briefly hold one partition during a rebalance.', 'The broker\'s assignment can disagree with the coordinator\'s slot map.'] },
        { name: 'Offsets committed to the broker', what: 'Keep the explicit assignment, but commit offsets to Kafka instead of saving them with the snapshot.', pros: ['Standard tooling shows lag and position.', 'Nothing extra in the snapshot.'], cons: ['Offsets and snapshot can disagree after a crash, so replay starts too late or too early.', 'Too late loses links for good.'] },
      ],
      examples: [
        {
          title: 'Assignment',
          lang: 'text',
          code: `# partitions come from the slot map, not a consumer group
# crawler-07, before the failure: its 51 slots
assign("discovered-urls", partitions=[..., 417, ...])

# crawler-12, after taking slot 417 at epoch 8
assign("discovered-urls", partitions=[417, ...])
seek(partition=417, offset=88214305)  # from the manifest
poll()`,
        },
        {
          title: 'One message replayed',
          lang: 'text',
          code: `partition 417  offset 88214311  key "example.org"
{
  "url": "https://example.org/news/2026/11/jobs",
  "host": "example.org",
  "slot": 417,
  "found_on": "https://blog.example.net/p/12",
  "found_at": "2026-11-12T10:56:10Z",
  "priority": 2
}
# seen check: new, so it goes to the frontier.
# If it was already queued before the snapshot, the
# seen check drops it.`,
          note: 'The same fields the producing node sent on the cross-node line.',
        },
      ],
    },
    {
      id: 'state', from: 'parser', to: 'meta', d: 'M842,356 V500', label: 'status, next fetch',
      mode: 'write', via: 'upsert', chip: 0.7, chipY: 455,
      how: 'One write per page, keyed by URL: status, hashes, ETag and next fetch time. Writes are batched and carry a timestamp.',
      delivery: 'Safe to repeat. Writing the same outcome twice changes nothing, which is what makes at-least-once safe everywhere upstream.',
      alts: ['Publishing results to a topic and letting a sink write them.', 'Conditional writes that reject an update older than the stored one.'],
      ways: [
        { name: 'upsert', chosen: true, what: 'One write per page, keyed by URL: status, hashes, ETag and next fetch time, batched and timestamped. About 400 a second on average.', pros: ['Safe to repeat, which makes at-least-once safe upstream.', 'No read before the write.', 'Batched, so the store sees few large requests.'], cons: ['A late, older write can overwrite a newer one; the timestamp decides.', 'If the store is down, results buffer and then fetching stops.'] },
        { name: 'A topic and a sink', what: 'The parser publishes each outcome to a topic, and a sink job writes them to the store.', pros: ['A store outage becomes lag, not stopped fetching.', 'Other consumers can read the same outcomes.'], cons: ['The recrawl scheduler sees outcomes late.', 'One more topic and job between the crawl and its record.'] },
        { name: 'Conditional writes', what: 'Each write carries the fetch time and is rejected if the stored row is newer.', pros: ['An old retry can never overwrite a newer outcome.', 'Clear rule, easy to test.'], cons: ['A read or a lightweight transaction per write, far dearer than a blind upsert.', 'Timestamps from one node per host already order its writes.'] },
      ],
      examples: [
        {
          title: 'One page, both tables (CQL)',
          lang: 'sql',
          code: `BEGIN BATCH USING TIMESTAMP 1794478801000000
  UPDATE crawl.urls
  SET status = 200,
      etag = '"6731-a91c"',
      last_modified = '2026-11-12 10:12:00+0000',
      content_hash = 'sha256:4be1c0f29d7a5e3b',
      simhash = 0x5d21c8a4f00e9b37,
      fetched_at = '2026-11-12 10:20:01+0000',
      next_fetch_at = '2026-11-12 10:50:01+0000'
  WHERE url = 'https://example.org/news';
  INSERT INTO crawl.urls_due
    (bucket, next_fetch_at, url, etag, last_modified)
  VALUES ('2026-11-12T10', '2026-11-12 10:50:01+0000',
    'https://example.org/news', '"6731-a91c"',
    '2026-11-12 10:12:00+0000');
APPLY BATCH;`,
          note: 'The write timestamp is the fetch time, so a late retry of an older outcome loses to a newer one.',
        },
        {
          title: 'The URL table',
          lang: 'sql',
          code: `CREATE TABLE crawl.urls (
  url           text PRIMARY KEY,
  status        int,
  etag          text,
  last_modified timestamp,
  content_hash  text,
  simhash       blob,
  fetched_at    timestamp,
  next_fetch_at timestamp,
  warc_file     text,
  warc_offset   bigint,
  warc_length   int
);`,
        },
      ],
    },
    {
      id: 'again', from: 'meta', to: 'recrawl', d: 'M790,570 V574 Q790,584 780,584 H80 Q70,584 70,574 V242', label: 'due URLs',
      mode: 'call', via: 'range read', chip: 0.8, chipY: 420,
      how: 'The scheduler reads URLs by time bucket: every URL whose next fetch time falls in the current window. The table is keyed so that this is a range read, not a full scan.',
      delivery: 'Read-only and repeatable.',
      alts: ['A time-ordered queue on each node.', 'A change feed from the store.'],
      ways: [
        { name: 'range read', chosen: true, what: 'The scheduler reads every URL whose next fetch time falls in the current window, from a table keyed by time bucket. A range read, not a full scan.', pros: ['Read-only and repeatable.', 'The store stays the one record of what is due.', 'Works for any window size.'], cons: ['Needs a second table keyed by time, kept in step with the URL table.', 'A bucket of popular times can be hot.'] },
        { name: 'A time-ordered queue on each node', what: 'Each node keeps its own URLs ordered by next fetch time on local disk and takes the due ones itself.', pros: ['No reads on the shared store.', 'Moves with the slot.'], cons: ['Each node holds all its URLs, about 500 million, not only pending ones.', 'Must be restored after a failover like the frontier.'] },
        { name: 'A change feed from the store', what: 'The scheduler reads the store\'s stream of changes and sets a timer for each URL\'s next fetch.', pros: ['No polling of time buckets.', 'Sees each new next fetch time at once.'], cons: ['Still needs somewhere to hold billions of timers until due.', 'Change feeds keep only recent history.'] },
      ],
      examples: [
        {
          title: 'Range read (CQL)',
          lang: 'sql',
          code: `SELECT url, etag, last_modified, next_fetch_at
FROM crawl.urls_due
WHERE bucket = '2026-11-12T10'
  AND next_fetch_at >= '2026-11-12 10:50:00+0000'
  AND next_fetch_at <  '2026-11-12 11:00:00+0000';

-- https://example.org/news | "6731-a91c"
--   | 2026-11-12 10:12:00+0000 | 2026-11-12 10:50:01+0000
-- and the rest of the window, grouped by owning node`,
          note: 'The hour is the partition key, so a window is one partition read; it is also why a busy hour can be hot.',
        },
        {
          title: 'The due table',
          lang: 'sql',
          code: `CREATE TABLE crawl.urls_due (
  bucket        text,       -- the hour, '2026-11-12T10'
  next_fetch_at timestamp,
  url           text,
  etag          text,
  last_modified timestamp,
  PRIMARY KEY ((bucket), next_fetch_at, url)
);`,
        },
      ],
    },
  ],

  tour: [
    {
      title: 'A URL enters the crawl',
      text: "The crawl starts from seeds: known-good sites, their sitemaps (lists of URLs a site publishes) and anything an operator adds. Follow one of them: https://example.org/news. The seeds API tidies its spelling and sends it to the frontier, the queue of work, on the node that owns example.org. One owner per host means one machine decides when that site is visited.",
      focus: ['seeds', 'frontier'],
      path: ['seed'],
      labels: ['URL'],
      story: {
        context: "Nothing has been fetched yet. An operator, or a job that reads sitemaps, posts https://example.org/news to the seeds API (POST /v1/seeds) with priority 1. The API answers 202 Accepted: slot 417, owner crawler-07, status queued.",
        problem: "Everything else the crawl finds is reached by following links from somewhere, so the starting list decides what can ever be reached. The URL also arrives as HTTPS://Example.org:443/news#top, and one page can arrive under a dozen spellings.",
        consequence: "A poor seed list walks the crawl into link farms in its first few hops. Without one canonical spelling the same page would be queued and fetched many times, wasting the site's patience and the crawl's budget.",
        fix: "Seeds come from a reviewed list, each with a priority, through an audited API with a per-domain kill switch beside it. The API rewrites the URL as https://example.org/news, hashes the host to slot 417 of 1,024 and queues it on crawler-07, the node that owns that slot. Posting the same seed again returns already_known and queues nothing. The cost is someone owning and reviewing the list like code.",
      },
      explain: [
        { q: 'What is a seed?', a: 'A starting URL that the crawl did not find by following a link. It comes from a curated list of known-good sites, from those sites\' sitemaps, or from an operator. Each one carries a priority.' },
        { q: 'What is a sitemap?', a: 'A file a site publishes listing its URLs, often with the date each last changed. A job reads the sitemaps of seed sites and posts the URLs to the seeds API. They are treated as hints, because they can be stale or wrong.' },
        { q: 'What is the frontier?', a: 'The URL frontier is the crawl\'s to-do list and scheduler. It holds every URL waiting to be fetched and decides which comes next and when. Each crawler node has its own frontier for the hosts it owns.' },
        { q: 'What does "the node that owns example.org" mean?', a: 'The crawl runs on about 20 machines, the crawler nodes. Every host name is hashed into one of 1,024 slots, and each slot belongs to exactly one node at a time. example.org lands in slot 417, which crawler-07 owns, so only crawler-07 queues and fetches its pages.' },
        { q: 'Who confirms the seed was accepted?', a: 'The seeds API replies 202 Accepted with an audit id and, for each URL, its canonical form, slot, owner and status "queued". The audit id records who added what and why.' },
      ],
    },
    {
      title: 'The frontier decides what and when',
      text: "Inside crawler-07's frontier the URL waits in two queues. A front queue ranks it by priority. A back queue holds every URL for example.org, and a heap (a structure that always gives the earliest time first) records when that host may next be contacted. Nothing leaves until the timer has run out, so no site gets a burst of requests.",
      focus: ['frontier'],
      path: [],
      labels: ['URL'],
      story: {
        context: "https://example.org/news is now an entry in crawler-07's frontier, kept in RocksDB on the node's local disk and in memory. It sits beside the other pending URLs for the hosts in crawler-07's 51 or so slots.",
        problem: "Links cluster by host, so the next thousand URLs in a plain first-in-first-out queue are often from one site. The frontier must answer two questions at once: which URL matters most, and which hosts may be contacted now. At 1 request a second, one site gives at most 86,400 pages a day however many machines the crawl has.",
        consequence: "With one plain queue the crawl either hammers example.org with many requests at once, which harms the site and gets the crawler blocked, or leaves every fetcher idle waiting for that host's turn. Good pages would also wait behind link farms.",
        fix: "The frontier splits the two questions. Front queues order URLs by priority. Each back queue holds one host's URLs, and a min-heap holds each host's next allowed time. A fetcher is only handed a URL whose host time has passed. About three back queues per fetch slot, about 150 a node, keeps the fetchers busy. The cost is custom, stateful code that needs snapshots to survive a crash.",
      },
      explain: [
        { q: 'What is a front queue?', a: 'One of several queues ordered by priority. URLs with higher priority, such as seeds from the reviewed list, move on towards fetching first. It decides what matters, not when.' },
        { q: 'What is a back queue?', a: 'A queue holding the URLs of one host, here example.org. Because each host has its own back queue, the frontier can hold that host back while serving others. It decides when, not what.' },
        { q: 'What is the heap, and what are "next times"?', a: 'A min-heap is a structure that always hands back its smallest value first. Here it holds, for each host, the earliest time that host may be contacted again. The frontier looks at the top of the heap to find the next host whose wait is over.' },
        { q: 'Where is the frontier stored?', a: 'In RocksDB, a key-value store that runs inside the crawler process and keeps its data on the node\'s local disk, with part of the frontier in memory. That is about 15 GB a node, out of about 300 GB for 2 billion pending URLs across the crawl.' },
        { q: 'Why not use Kafka or a managed queue as the frontier?', a: 'A queue hands out messages in order and cannot delay one host while serving another. Politeness would then need a lock per domain and a re-queue on every miss. The frontier is a scheduler, so this design builds it.' },
      ],
    },
    {
      title: 'A fetcher leases it',
      text: "When example.org is due, the frontier hands the URL to a fetcher (a download worker in the same process) as a lease: a loan with a deadline, here 10:21:00. If the fetcher dies before reporting back, the lease expires and the URL goes back in the queue, so a crash never loses it. That is what makes fetching at-least-once: never zero times, rarely twice.",
      focus: ['frontier', 'fetcher'],
      path: ['lease'],
      labels: ['URL'],
      story: {
        context: "example.org's time on the heap has passed. Fetcher fetch-03 on crawler-07 asks for work with lease(worker=\"fetch-03\", max=8) and gets lease L417-55120 for https://example.org/news: slot 417, epoch 7, deadline 10:21:00.",
        problem: "A fetcher can crash, hang or be killed at any moment while it holds the URL. If the frontier forgot the URL when it handed it out, a crash would lose it. If it waited for the fetcher no matter what, a dead fetcher would block example.org for ever.",
        consequence: "A lost URL is a page silently never crawled. A host stuck behind a dead fetcher stops being crawled at all. Neither shows up unless something checks.",
        fix: "Every hand-out is a lease with a deadline, well above the 1 second a fetch takes on average. When done, the fetcher calls complete with the lease id, the outcome and the next fetch time, which frees the host. If nothing calls complete by the deadline, the lease expires and the URL is queued again. A late or repeated complete for the same lease id is ignored. The cost is a rare repeated fetch.",
      },
      explain: [
        { q: 'What is a fetcher?', a: 'The worker that downloads pages. Each crawler node runs fetchers on an event loop, one process holding many open connections, about 50 fetches in flight a node. They run in the same process as the frontier, so the hand-out never crosses the network.' },
        { q: 'What is a lease?', a: 'A hand-out with a deadline. The fetcher may work on the URL until the deadline; after that the frontier takes it back and queues it again. Here the lease id is L417-55120 and the deadline is 10:21:00.' },
        { q: 'Who is told the fetch finished, and how?', a: 'The fetcher calls complete on the frontier with the lease id, the outcome (status 200, 101,872 bytes, 840 ms) and the next fetch time. That call frees example.org for its next request. It is a function call inside the process.' },
        { q: 'What does at-least-once mean?', a: 'Every URL is fetched one or more times, never zero. A crash can cause a second fetch, but never a lost one. It is safe because every later write is keyed so that doing it twice changes nothing.' },
        { q: 'What is the epoch 7 on the lease?', a: 'A number that goes up each time slot 417 changes owner. It rides on the lease so that work from an old owner can be told apart from a new owner\'s. Steps 13 and 14 show it change from 7 to 8.' },
      ],
    },
    {
      title: 'Resolve the host, then check the address',
      text: "fetch-03 asks a local caching resolver (a DNS server on its rack that remembers recent answers) for example.org's address: 203.0.113.27. Then it checks that the address is not private or internal, because a crawler fetches URLs chosen by strangers and one could point inside our network. It will connect to exactly the address it checked.",
      focus: ['fetcher', 'dns'],
      path: ['dns', '<dns'],
      labels: ['IP?', 'IP'],
      story: {
        context: "fetch-03 holds the lease for https://example.org/news. Before it can connect it needs the server's network address, which DNS, the internet's directory of names, provides. It asks the rack resolver at 10.4.0.53 and gets 203.0.113.27 from the cache, valid for 300 seconds.",
        problem: "An uncached lookup takes tens to hundreds of milliseconds, and the standard library's lookup can block a whole thread while it waits. Separately, anyone can publish a link whose host name resolves to a private address, such as one in 10.0.0.0/8 or the cloud metadata range 169.254.0.0/16.",
        consequence: "Slow lookups cap the crawl long before bandwidth does: the Mercator crawler found lookups took 87 per cent of each thread's time. And a fetch to a private address would let a stranger make the crawler read internal admin pages or cloud credentials, an attack called server-side request forgery (SSRF).",
        fix: "A caching resolver on each machine or rack answers every fetcher, runs many lookups at once and merges identical ones, cutting at most 400 lookups a second to tens. The fetcher checks the answer against loopback, private and link-local ranges, connects to exactly that address with the TLS name example.org, and checks again on every redirect. Repeated lookup failures open a circuit breaker so the host is skipped. The cost is one more service to run.",
      },
      explain: [
        { q: 'What is DNS?', a: 'The Domain Name System, which turns a name like example.org into a numeric address like 203.0.113.27. Here a query is one small UDP message, a network packet sent with no connection set up first, and one reply.' },
        { q: 'What is a caching resolver?', a: 'A DNS server that remembers each answer for as long as the answer allows, here 300 seconds. Each host is looked up about once per lifetime instead of once per fetch. This one runs on the same machine or rack as the fetchers.' },
        { q: 'What does "private or internal" mean?', a: 'Address ranges that only reach machines inside a network: 127.0.0.0/8 (the machine itself), 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and 169.254.0.0/16, where cloud metadata lives. A public web page should never resolve to one.' },
        { q: 'Why connect to exactly the checked address?', a: 'If the fetcher looked the name up again, a hostile DNS server could answer with a public address the first time and a private one the second (DNS rebinding). Connecting to the address it checked closes that gap.' },
        { q: 'What happens if DNS stops answering?', a: 'Each lookup has a short timeout and one retry. Repeated failures open a circuit breaker: fetchers skip hosts they cannot resolve and carry on with the rest.' },
      ],
    },
    {
      title: 'Ask whether the fetch is allowed',
      text: "May we fetch /news? The fetcher reads example.org's robots.txt rules (the file where a site lists what crawlers may fetch) from this node's memory, cached for at most a day. The longest matching rule wins. For an address shared by many sites, the per-IP limiter is asked as well, so that thousands of hosts on one server are not all fetched at once.",
      focus: ['fetcher', 'robots', 'iplimit'],
      path: ['robots', '<robots', 'ip', '<ip'],
      labels: ['path ok?', 'allowed', 'IP quota', 'granted'],
      story: {
        context: "fetch-03 knows example.org is at 203.0.113.27 and that the address is public. Before sending the request it checks two things: that the site allows this path, and that the server behind the address has room for one more request.",
        problem: "A site may publish a robots.txt saying which paths crawlers must not fetch, and requesting it before every page would double the traffic. Separately, the frontier's one-request-per-host rule cannot see that 203.0.113.27 also serves many other hosts, which other nodes own.",
        consequence: "Fetching a path the site forbade is the fastest way to be blocked and to damage the crawler's name. Ignoring shared addresses means a shared-hosting server or blog platform is hit by every node at once, once for each of its hosts.",
        fix: "Each node keeps the parsed rules of the hosts it owns in memory for at most 24 hours, as RFC 9309 asks, so the check is an in-process read. /news matches no rule, so it is allowed; /news/drafts/q4 would be refused. Because 203.0.113.27 is on the list of busy addresses, the fetcher also takes one token from its bucket in the Redis limiter, and one from example.org's domain bucket. The cost is two politeness mechanisms to test, and a rule change can take up to a day to be seen.",
      },
      explain: [
        { q: 'What is robots.txt?', a: 'A plain text file at the root of a site, here example.org/robots.txt, listing paths crawlers may or may not fetch. RFC 9309 standardised it in 2022: cache it for at most 24 hours, and treat a server error as "disallow everything".' },
        { q: 'What does "the longest matching rule wins" mean?', a: 'When several rules match a path, the one with the longest path wins, and Allow wins a tie. example.org disallows /news/drafts/ but allows /news/drafts/public/, so /news/drafts/public/a is allowed. /news matches neither, so it is allowed.' },
        { q: 'Where are the rules kept?', a: 'In memory on crawler-07, the node that owns example.org; these were fetched at 09:41 today. On a miss or after 24 hours the fetcher requests /robots.txt like any other page. A 404 means no restrictions; a 503 or no answer means fetch nothing.' },
        { q: 'What is the per-IP limiter?', a: 'A small shared service, in Redis, holding token buckets per network address and per registrable domain (the name one owner registers, such as example.org). It is asked only for addresses known to host many sites, so most fetches never call it.' },
        { q: 'What is a token bucket?', a: 'A rate limiter. Tokens drip into a bucket at a fixed rate and each request takes one; an empty bucket means wait. Here the fetcher took one token for 203.0.113.27 and one for example.org, so it may fetch now.' },
        { q: 'What if the limiter says no, or cannot be reached?', a: 'An empty bucket sends the host back on the heap to wait. If Redis cannot be reached, fetchers slow down, never speed up: they use a slow fixed rate for those addresses.' },
      ],
    },
    {
      title: 'Fetch the page, politely',
      text: "fetch-03 sends GET /news to example.org over HTTPS, with one request in flight per host. Every phase (connect, secure handshake, read) has a deadline, the body is capped at 10 MB and at most five redirects are followed, so no server can hold it for ever. If the site answers 429 or 503 (too busy), the host's delay doubles, and it shortens again slowly after successes.",
      focus: ['fetcher', 'web'],
      path: ['get', 'resp'],
      labels: ['GET', '200 HTML'],
      story: {
        context: "The fetch is allowed. fetch-03 connects to 203.0.113.27 on port 443 and sends GET /news with the crawler's name, ExampleBot/1.0, and a link to a page about the bot. The site answers 200 OK with 101,872 bytes of HTML in 840 milliseconds, and an ETag of \"6731-a91c\".",
        problem: "This is the one hop to a server nobody here controls. Some servers answer one byte a second, some pages are gigabytes, some redirect for ever, and a busy site may say slow down with a 429 or 503.",
        consequence: "Without limits, slow or hostile servers pin the fetcher's connections and the crawl stalls. Without back-off, a struggling site gets more load just when it can bear least, and it blocks the crawler.",
        fix: "The frontier lets out one URL per host at a time, and after each fetch the host waits the largest of 1 second, its Crawl-delay and ten times the last response time: here max(1 s, 2 s, 8.4 s) = 8.4 s. Deadlines, a 10 MB cap and five redirects bound what any server can cost. On 429 or 503 the fetcher obeys Retry-After or doubles the delay, shortens it slowly after successes, and pauses the host for hours after many errors in a row. The cost: one host yields at most one page every few seconds.",
      },
      explain: [
        { q: 'What are HTTPS and GET?', a: 'HTTP is how browsers and crawlers ask a web server for a page; GET means "send me this page". HTTPS is HTTP inside TLS, an encrypted connection that also proves the server really is example.org.' },
        { q: 'What does "one request in flight per host" mean?', a: 'Never more than one unanswered request to example.org at a time, from the whole crawl. It holds by construction: only crawler-07 owns the host, and its frontier lends out one URL per host at a time.' },
        { q: 'What are 429 and 503?', a: 'HTTP status codes. 429 means "too many requests" and 503 means "service unavailable". Either is the site asking the crawler to slow down; a Retry-After header, such as 120 seconds, says for how long.' },
        { q: 'How long until example.org is fetched again?', a: 'The gap is the largest of 1 second, the site\'s Crawl-delay of 2 seconds and ten times the last response time. This fetch took 0.84 seconds, so the gap is 8.4 seconds. A slow site is treated as a busy one.' },
        { q: 'What is the ETag in the reply?', a: 'A tag the server gives this version of the page, here "6731-a91c". It is saved so that next time the crawler can ask "send it only if it changed" (step 12).' },
      ],
    },
    {
      title: 'Store the raw page first',
      text: "The fetcher adds the response to a batch of about 500 pages, compressed into one WARC file (the standard archive format for web pages) and uploaded to the object store, a cheap store for large files such as S3. Each page's place in the file is recorded. From here on, a parser bug is fixed by reprocessing stored pages: the web is never asked twice.",
      focus: ['fetcher', 'blob'],
      path: ['raw'],
      labels: ['HTML'],
      pill: ['below'],
      story: {
        context: "fetch-03 has the 101,872-byte response in memory. Pages collect in a buffer until about 500 are ready; this batch becomes warc/2026/11/12/crawler-07/000183.warc.gz, about 10 MB compressed.",
        problem: "A raw page is the expensive thing to get: it costs the site a visit and the crawl part of its politeness budget. Parsers have bugs, and new needs, such as a new extractor, come after the fact. Uploading each page on its own would mean about 400 uploads a second and a billion small objects a month.",
        consequence: "If only the parsed result were kept, every parser fix would mean fetching the web again, costing every site a second visit and taking days for a large site at 1 request a second. One object per page would multiply request charges and make the archive slow to list or move.",
        fix: "About 500 pages are compressed into one WARC file and uploaded with one PUT: under one upload a second across the crawl. Each record is its own gzip member, and its file, offset and length (4,812,330 and 20,517 bytes here) go to the metadata store, so one page can be read back by byte range. The cost: pages wait in the buffer, and a batch lost before upload means fetching up to 500 pages again.",
      },
      explain: [
        { q: 'What is an object store?', a: 'A storage service for large files, called objects, written with PUT and read with GET over HTTP. S3 is Amazon\'s; other clouds have their own. It costs little per byte and keeps data safe once it has acknowledged a write.' },
        { q: 'What is a WARC file?', a: 'Web ARChive, the standard file format for stored web responses (ISO 28500). Each record holds the URL, the date, the server\'s address, the response headers and the body. Many records go into one compressed file.' },
        { q: 'Why batch 500 pages?', a: 'One upload per 500 pages cuts upload requests five-hundred-fold, from about 400 a second to under one. A batch is about 50 MB raw and 10 MB compressed.' },
        { q: 'How is one page found again later?', a: 'Its WARC file name, byte offset and length are written to the page\'s row in the metadata store. A reader asks the object store for just those bytes with a ranged GET and gets back one gzip member: this page\'s record.' },
        { q: 'Does the parser wait for the upload?', a: 'No. The parser gets the page from memory straight away (step 8), and the stored copy is what any retry or reprocessing reads. That is why a batch lost before upload means fetching its pages again.' },
        { q: 'What does "the web is never asked twice" mean?', a: 'When a parser bug is fixed or a new extractor ships, a job reads the stored pages back and parses them again. No site is visited a second time for the same page.' },
      ],
    },
    {
      title: 'Parse in a sandbox',
      text: "The page goes over a pipe, in memory, to the parser: a separate sandboxed process, walled off so hostile pages cannot harm the node. It extracts the text and the links and computes two fingerprints: an exact hash to spot copies, and a SimHash to spot near-copies. A page whose content only appears when scripts run goes to the render pool, and few do.",
      focus: ['fetcher', 'parser'],
      path: ['page'],
      labels: ['HTML'],
      story: {
        context: "The response for https://example.org/news is in the WARC batch. fetch-03 writes a header line (URL, status 200, lease L417-55120, 101,872 body bytes) and then the body into a pipe read by the parser process on crawler-07.",
        problem: "Parsing uses the processor, while fetching mostly waits on the network, so they scale differently. Pages are written by strangers: tags nested fifty thousand deep, or text that makes a regular expression run for ever. The same content also turns up at many URLs, exactly or with small changes such as adverts or timestamps.",
        consequence: "Parsing inside the fetcher would let one poison page crash the process and drop every connection it held. Without fingerprints the archive and its users would fill with copies, and a crawler trap producing near-identical pages would go unnoticed.",
        fix: "A separate sandboxed process reads the page as a stream of tags and text, so memory stays flat whatever the nesting, at 10 to 20 milliseconds of processor time a page. It computes an exact content hash (SHA-256) and a 64-bit SimHash. A page that crashes the parser is retried from its stored WARC record and quarantined after three failures. Pages with an almost empty body or a known script framework have their URL published to a render-requests topic for a small pool of headless browsers. The cost is a sandbox and a pipe to run and watch.",
      },
      explain: [
        { q: 'What is a pipe?', a: 'A one-way channel between two processes on the same machine, held in memory. The fetcher writes the page into it and the parser reads it out. There is no network hop and no read from storage.' },
        { q: 'What is a sandbox?', a: 'A process run with tight limits on what it can touch: no route to internal services, capped memory and time. If a hostile page crashes or takes over the parser, the fetcher and the rest of the node carry on.' },
        { q: 'What is the exact hash for?', a: 'It is a SHA-256 hash of the page body, here sha256:4be1c0f29d7a5e3b (shortened). Two URLs with identical content get the same hash, so the second copy is stored as a pointer and its links are not extracted again. Comparing it with last time\'s says whether the page changed.' },
        { q: 'What is a SimHash?', a: 'A 64-bit fingerprint that stays similar when the text is similar, here 5d21c8a4f00e9b37. Two pages whose fingerprints differ in three bits or fewer are treated as near-copies. It is how the crawl notices a host producing endless near-identical pages.' },
        { q: 'What is the render pool, and why do few pages go there?', a: 'A small pool of headless browsers, browsers with no window driven by code, that run a page\'s scripts and store the result. Rendering costs ten to a hundred times a plain fetch, so only pages with an almost empty body or a known script framework are sent. Most text on the web is in the HTML already.' },
        { q: 'How does a page reach the render pool?', a: 'The parser publishes the URL, not the page, on a Kafka topic called render-requests, and the pool reads it at its own pace. A page such as example.org/live, whose text appears only after scripts run, would go this way. /news is plain HTML, so it does not.' },
      ],
    },
    {
      title: 'Clean up each link and find its owner',
      text: "The URL filter puts every link into one canonical spelling, checks it against scope and trap rules, and hashes its host to find the node that owns it. Most links stay on this node, and the token follows one of those. Links to another node's hosts, such as blog.example.net, branch off on the discovered-urls topic, a shared message log keyed by host.",
      focus: ['parser', 'filter', 'kafka'],
      path: ['links'],
      labels: ['links'],
      branch: { path: ['cross'], label: 'not mine' },
      story: {
        context: "The parser found 52 links on https://example.org/news, written as they appear in the page: relative (/news/2026/11/rates), mixed case with a port and a fragment (HTTPS://Example.org:443/about#team), on other sites (https://blog.example.net/p/12), and odd (/calendar/2099/01/). It passes them to the URL filter with a function call.",
        problem: "The same page can be written many ways, and some links lead into traps such as a calendar with a next-month link for ever. Each link also belongs to a host, and only the node that owns that host may queue it, or two nodes could fetch one site at once.",
        consequence: "Without one spelling the same page enters the frontier a dozen times. Without trap rules a calendar fills the frontier with empty pages. Without routing by host, politeness would need a lock shared by every node on every fetch.",
        fix: "The filter lower-cases the scheme and host, drops the default port and the fragment, and resolves relative links, with one tested library used by every stage. /calendar/2099/01/ is dropped as a date far in the future. Each host is hashed into one of 1,024 slots: example.org is slot 417, crawler-07's own, so its links go straight to the seen check. blog.example.net is slot 88, owned by crawler-03, so that link is produced to partition 88 of the discovered-urls Kafka topic. The cost is two code paths, local and remote, to test.",
      },
      explain: [
        { q: 'What is a canonical form?', a: 'One standard spelling for a URL. HTTPS://Example.org:443/about#team becomes https://example.org/about: lower-case scheme and host, default port removed, fragment (#team) dropped. /news/2026/11/rates becomes https://example.org/news/2026/11/rates.' },
        { q: 'What are scope and trap rules?', a: 'Scope rules say which sites this crawl wants at all. Trap rules drop links shaped like known endless URL generators, such as dates far in the future. Here /calendar/2099/01/ is dropped.' },
        { q: 'How is the owner found?', a: 'slot = hash(host) mod 1,024, and the coordinator\'s slot map says which node owns each slot. Every node reads the same map, so every node sends a given link to the same owner.' },
        { q: 'What is the discovered-urls topic?', a: 'A Kafka topic: a durable, ordered log of messages kept by a cluster of servers called brokers. It has 1,024 partitions, one per slot. A node sends a foreign link to the partition for that host\'s slot, and the owning node reads it from there.' },
        { q: 'Why key the messages by host?', a: 'All links for one host go to one partition, in order, and so to one owning node. When a slot moves to a new owner, its partition moves with it.' },
        { q: 'Do most links really stay on this node?', a: 'Menus, footers and body links mostly point to the same site, so they share its slot. A link to another host lands on this node only by chance, about 1 time in 20 with 20 nodes.' },
      ],
    },
    {
      title: 'Drop what has been seen before',
      text: "The URL-seen check turns each link into a 64-bit fingerprint (a short hash of the URL) and looks it up in an on-disk set that is near-exact: about three collisions in 10 billion URLs. Only URLs never met before enter the frontier, and the loop closes. A Bloom filter would be smaller, but each of its false positives is a page never crawled.",
      focus: ['filter', 'seen', 'frontier'],
      path: ['local', 'new'],
      labels: ['link', 'new URL'],
      story: {
        context: "Two links reach crawler-07's URL-seen check: https://example.org/news/2026/11/rates and https://example.org/about. Across the crawl about 20,000 such checks happen every second, about 1,000 a node.",
        problem: "Most links point to pages already known, because menus and footers repeat on every page. The crawl knows about 10 billion URLs, too many to keep as text in memory, and any compact set risks saying \"seen\" for a URL that is new.",
        consequence: "Without the check, the frontier fills with repeats and the same page is fetched again and again. With a wrong \"seen\", the page is never crawled and nothing reports it, because the same URL gives the same wrong answer every time.",
        fix: "Each canonical URL is hashed to 8 bytes and kept in the node's RocksDB, about 500 million and 4 GB a node, with a small in-memory cache of popular URLs in front. /about's fingerprint 41d7a0c95e6b2f03 is already there, so it is dropped. /rates' fingerprint 9f3c51e07a2b4d18 is new, so the fingerprint and the frontier entry are written in one RocksDB write batch: both or neither. The cost is about 80 GB of disk across the crawl, against 12 GB for a Bloom filter.",
      },
      explain: [
        { q: 'What is a 64-bit fingerprint?', a: 'A 64-bit hash of the canonical URL, 8 bytes, stored in place of the URL itself. Ten billion take about 80 GB. Two different URLs share one by chance only about three times in 10 billion.' },
        { q: 'Where is the set kept?', a: 'In RocksDB on crawler-07\'s local disk, the same store as the frontier, with a small cache of popular URLs in memory in front. Each node holds only the URLs of the hosts it owns.' },
        { q: 'What is a Bloom filter?', a: 'A bit array that answers "definitely new" or "probably seen" in very little memory: 9.6 bits a URL at 1 per cent false positives, about 12 GB in all. But at 1 per cent, up to 100 million new pages would be skipped for good.' },
        { q: 'What is a write batch, and why use one?', a: 'A group of writes that RocksDB applies all together or not at all. The fingerprint and the queue entry go in one batch. With two separate writes, a crash between them could mark a URL seen that was never queued, and it would never be crawled.' },
        { q: 'What does "the loop closes" mean?', a: 'The new URL is now in the frontier, where the tour was at step 2. In time a fetcher will lease it and the cycle repeats for that page.' },
      ],
    },
    {
      title: 'Record the outcome',
      text: "The parser writes the page's outcome (status, hashes, ETag and next fetch time) to the metadata store, the durable record of every URL. Each write is an upsert keyed by URL: insert or overwrite, so writing twice is harmless. Then an event and the page's links go out, on a topic and in files, for whoever uses the crawl, such as a search indexer.",
      focus: ['parser', 'meta', 'downstream'],
      path: ['state', 'events'],
      labels: ['result', 'event'],
      story: {
        context: "https://example.org/news has been fetched, stored and parsed. The parser knows its status (200), content hash, SimHash, ETag, when it was fetched (10:20:01) and when it is due again (10:50:01). It found 52 links, and the page changed since last time.",
        problem: "Every earlier hop is at-least-once: a lease can expire and a page be fetched and parsed twice. The record must also serve the recrawl scheduler, which asks what is due now across 10 billion URLs. And other teams want the results without leaning on the crawler's own tables.",
        consequence: "If a repeated write could double-count or damage a row, at-least-once delivery would be unsafe and every hop would need costly exactly-once machinery. If consumers queried the crawler's tables, their load would slow the crawl and the schema could never change.",
        fix: "One batched write, stamped with the fetch time, updates the row in crawl.urls and adds the URL to crawl.urls_due under the hour 2026-11-12T10. Both are upserts by key, so a repeat changes nothing, and a late retry of an older outcome loses to the newer timestamp. The parser then publishes one event on the crawl.pages Kafka topic (URL, status, hashes, links_out 52, changed true) and writes the links to Parquet files. The cost is a schema to version for consumers.",
      },
      explain: [
        { q: 'What is the metadata store?', a: 'A Cassandra or ScyllaDB cluster holding one row per URL: state, last status, ETag, hashes, next fetch time and where the raw page sits in the archive. About 10 billion rows, 3 TB, or 9 TB with three copies. Everything else in the crawler can be rebuilt from it.' },
        { q: 'What is an upsert?', a: 'A write that inserts the row if it is missing and overwrites it if not, by key, here the URL. Doing it twice leaves the same result as doing it once. That is what makes at-least-once delivery safe everywhere upstream.' },
        { q: 'Why two tables?', a: 'crawl.urls is keyed by URL, for looking up one page. crawl.urls_due is keyed by the hour each URL is next due, so the scheduler can read everything due between 10:50 and 11:00 without scanning all 10 billion rows.' },
        { q: 'Who receives the event, and how?', a: 'Whoever uses the crawl, such as an indexer, a ranking job or a training pipeline. They read the crawl.pages topic at their own pace and can replay it. A slow consumer builds a backlog (lag) and never slows the crawl.' },
        { q: 'What is Parquet?', a: 'A file format that stores values column by column, so a job that needs only from_url and to_url reads only those. Each row of the link table holds from_url, to_url, the anchor text and when the link was found.' },
        { q: 'How do consumers cope with repeated events?', a: 'Events are at-least-once too. Each carries the URL and content hash, and the topic is keyed by URL so one URL\'s events stay in order. A consumer drops a repeat it has already seen.' },
      ],
    },
    {
      title: 'Come back when it is due',
      text: "Pages that change often get a short interval and stable pages a long one. The recrawl scheduler reads due URLs from the metadata store by time bucket (here, the hour they fall due) and sends them back to the owning frontier. The fetch is conditional, \"send it only if it changed\": an unchanged page answers 304 and costs almost nothing.",
      focus: ['meta', 'recrawl', 'frontier'],
      path: ['again', 'due'],
      labels: ['due URLs', 'URL'],
      story: {
        context: "It is 10:50. The recrawl scheduler reads the window from 10:50 to 11:00 in crawl.urls_due, bucket 2026-11-12T10, and finds https://example.org/news with its ETag \"6731-a91c\" and last-modified time. It calls Enqueue on crawler-07 with it and 311 other URLs due in crawler-07's slots.",
        problem: "A crawl that never revisits goes stale within weeks, but most pages rarely change. Revisiting everything on a fixed timer spends most of the budget on pages that never move. And finding what is due must not mean scanning 10 billion rows.",
        consequence: "Stale copies make whatever is built on the crawl, such as search results, wrong. Wasted revisits use up each site's politeness budget, so new pages wait longer.",
        fix: "Each URL carries a next fetch time: the interval halves when the page changed and lengthens when it did not. The due table is keyed by hour, so a window is one partition read. Enqueue is the same call new links use, so priority and politeness apply, and it ignores URLs already queued, so a retry is safe. The ETag and date ride with the URL, so the fetcher sends If-None-Match and If-Modified-Since, and an unchanged page answers 304 Not Modified, headers only. The cost: estimates are noisy for pages seen only a few times, and a busy hour can be a hot partition.",
      },
      explain: [
        { q: 'What is the recrawl scheduler?', a: 'A small service that brings URLs back when they are due again. It reads the due table in the metadata store and sends each URL to the node that owns its host, found from the slot map.' },
        { q: 'What is a time bucket?', a: 'The hour a URL is next due, here "2026-11-12T10". It is the partition key of crawl.urls_due, so all URLs due in one hour are stored together and read in one go.' },
        { q: 'What is a conditional fetch?', a: 'A GET that carries what the crawler saw last time: If-None-Match with the ETag and If-Modified-Since with the date. If the page has not changed, the server answers 304 Not Modified with headers and no body, against about 100 KB for the full page.' },
        { q: 'How is the interval chosen?', a: 'From the page\'s history. After every fetch the parser compares content hashes: a change halves the interval and no change lengthens it. Here /news was due again 30 minutes after its last fetch.' },
        { q: 'What if the scheduler sends the same URLs twice?', a: 'Enqueue ignores a URL that is already queued. The same call retried after a timeout returns queued 0, already_queued 312.' },
      ],
    },
    {
      title: 'The lease runs out',
      text: "Now crawler-07 dies. A node owns its slots of hosts only while it renews a lease on them with the coordinator every 10 seconds. crawler-07 stops, so its 30-second lease runs out: the red dashes. The coordinator gives those slots to another node with a higher epoch (a count of owner changes), 8. Anything the old owner still sends carries epoch 7 and is refused.",
      focus: ['frontier', 'coord'],
      path: ['coord'],
      labels: ['renewal missed'],
      failed: ['coord'],
      hide: ['replay'],
      story: {
        context: "The loop has been running normally. Now crawler-07, owner of slot 417 and 50 others, sends its last renewal at 10:56:30 and dies just after. Its frontier, seen set and robots cache lived on its local disk and in its memory.",
        problem: "Someone must take over example.org and the other hosts in crawler-07's slots, or they stop being crawled. But a node that looks dead may only be paused, by a long stop in the process or a network blip, and wake up still believing it owns the slots.",
        consequence: "If two nodes fetched example.org at once, the one-request-per-host rule would break, and a site that sees overlapping requests loses patience with the crawler. Two owners could also overwrite each other's work. Waiting for a person to notice would leave the slots uncrawled for hours.",
        fix: "The coordinator, a small consensus cluster such as etcd or ZooKeeper, holds the slot map. Lease 7041 covers crawler-07's 51 slots and lasts 30 seconds; with no renewal it runs out at 10:57:00, and slot 417 moves to crawler-12 with epoch 8. If crawler-07 wakes, its renewal is refused because lease 7041 has expired, it stops handing out leases at once, and anything it still sends carries epoch 7 and is refused. The cost: example.org goes unfetched for at least 30 seconds, and a coordinator outage pauses every node.",
      },
      explain: [
        { q: 'What is the coordinator?', a: 'A small cluster, such as etcd or ZooKeeper, whose members agree on every change before confirming it (consensus). It holds the map from the 1,024 slots to nodes, and the leases that keep that map current.' },
        { q: 'What is a lease on slots?', a: 'A time-limited claim: crawler-07 owns its slots only while it keeps renewing. It renews every 10 seconds for 30 seconds at a time, so it can miss two renewals before losing them. It is a different lease from the per-URL lease in step 3, but the same idea: a hand-out with a deadline.' },
        { q: 'What do the red dashes show?', a: 'The line from crawler-07\'s frontier to the coordinator has failed: renewals stopped arriving. That silence is all the coordinator ever sees of a dead node.' },
        { q: 'What is an epoch?', a: 'A number that goes up by one every time a slot changes owner: slot 417 was epoch 7 under crawler-07 and is epoch 8 under crawler-12. It lets every part of the system tell the old owner\'s work from the new owner\'s.' },
        { q: 'Who refuses the old owner, and how does it know?', a: 'The coordinator refuses its renewal with "lease 7041 has expired", and the node then stops handing out leases. Stores reject writes that carry an older epoch than the slot\'s current one, so anything stamped 7 is turned away.' },
        { q: 'What happens to URLs crawler-07 had leased out?', a: 'Nothing calls complete for them, so they count as unfinished. The new owner restores them from a snapshot and queues them again (step 14), so they are fetched a second time: the at-least-once price.' },
      ],
    },
    {
      title: 'A new owner takes over',
      text: "crawler-12, the new owner, reads the frontier's last snapshot (a copy saved every few minutes) from the object store with an S3 GET, then replays the discovered-urls topic from the positions saved with it. Before it fetches, it waits a further margin for clock drift. By then the old owner has certainly stopped, so a host never has two fetchers.",
      focus: ['blob', 'frontier', 'kafka', 'seen'],
      path: ['restore', 'inbound', 'new'],
      labels: ['snapshot', 'replay', 'URL'],
      pill: ['below'],
      hide: ['replay'],
      story: {
        context: "crawler-12 has owned slot 417 since 10:57:00, at epoch 8. crawler-07's disk is gone, but every few minutes it wrote each slot's frontier (queues, heap and leases) to the object store, with the topic position it had read up to. The last set for slot 417 was taken at 10:55:00.",
        problem: "The snapshot is two minutes older than the crash. Links that other nodes sent to slot 417 since then sit in partition 417 of discovered-urls. URLs leased at 10:55 may or may not have been fetched. And the two machines' clocks may disagree, so \"the lease has run out\" is not quite the same moment for both.",
        consequence: "Rebuilding from the metadata store alone would mean reading about 500 million URLs, slow and heavy on the store. Starting the replay at the wrong position would lose links for good or repeat many. Fetching before the old owner has surely stopped could put two fetchers on example.org.",
        fix: "crawler-12 lists slot-0417/, takes the newest set with a manifest (20261112T105500Z), reads its queues, heap and leases, and puts the URLs leased at 10:55 back in the queue. It then reads partition 417 from offset 88214305, the one in the manifest. At offset 88214311 it finds https://example.org/news/2026/11/jobs, found on blog.example.net/p/12 at 10:56:10; the seen check says new, so it enters the frontier. Only after a margin for clock drift does it fetch. The cost: minutes of recovery and some URLs fetched twice.",
      },
      explain: [
        { q: 'What is a snapshot?', a: 'A copy of a slot\'s frontier, written as new objects in the object store every few minutes: the queues, the heap of host times, the leases, and a manifest. The manifest goes last, so a set without one is incomplete and is ignored.' },
        { q: 'What is an offset, and why is it saved with the snapshot?', a: 'An offset is a message\'s position in a Kafka partition. The manifest records that the snapshot had read partition 417 up to 88214305. Saving it in the same set of objects means the frontier and the replay point always agree.' },
        { q: 'What does replaying the topic mean?', a: 'Reading partition 417 again from the saved offset, so every link other nodes sent for slot 417 since the snapshot is processed again. Each goes through the seen check, so links already queued before the snapshot are dropped.' },
        { q: 'What is clock drift, and why wait for it?', a: 'Machine clocks run at slightly different speeds, so a paused crawler-07 may think its lease ends a little later than the coordinator does. Waiting a margin past the lease means crawler-07 has surely stopped handing out URLs before crawler-12 starts.' },
        { q: 'Is anything lost?', a: 'Links that crawler-07 found for its own hosts after 10:55 never went through the topic. They come back only when the pages that hold them are fetched again. URLs in flight at the crash are fetched a second time.' },
        { q: 'What if the snapshot cannot be read?', a: 'crawler-12 uses the set before it and replays more of the topic. The metadata store, the record of every URL, is the last resort.' },
      ],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        'One site or the whole web? Many interviews start with a single domain and one machine, then scale it.',
        'What is it for? Search, archive, monitoring and model training want different priority and freshness.',
        'How big and how fast? Pages a month, or a fixed corpus by a deadline.',
        'What counts as polite? robots.txt, a rate per host, how to be contacted.',
        'What is out of scope? Indexing, images and video, pages behind a login, script-rendered content.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Crawl outward from seed URLs and store each page for later use.',
        'Never fetch the same URL twice in a cycle, and revisit pages when they are due.',
        'Obey robots.txt and never overload a host.',
        'Lose no progress when a machine dies.',
        'Scale by adding machines.',
      ],
    },
  ],

  numbers: [
    { what: 'Fetch rate', assumption: '1 billion pages a month over 2.6 million seconds', result: 'about 400 a second on average, build for 1,000' },
    { what: 'Bandwidth', assumption: 'about 100 KB a page', result: 'about 320 Mbit/s on average, provision 1 Gbit/s' },
    { what: 'Storage', assumption: 'HTML compresses about 5 to 1', result: 'about 100 TB a month raw, 20 TB compressed' },
    { what: 'Links found', assumption: 'about 50 a page, most already seen', result: 'about 20,000 URL-seen checks a second' },
    { what: 'Known URLs', assumption: 'discovery outruns fetching tenfold', result: 'about 10 billion: 80 GB as fingerprints, 12 GB as a Bloom filter' },
    { what: 'In flight', assumption: '1,000 fetches a second, about 1 second each', result: 'about 1,000 requests open at once' },
    { what: 'Machines', assumption: 'about 50 pages a second a node', result: 'about 20 crawler nodes' },
    { what: 'One host, politely', assumption: '1 request a second', result: '86,400 pages a day from any one site' },
  ],

  framings: [
    {
      name: 'Continuous crawl (this diagram)',
      scale: '1 billion pages a month, revisited for ever',
      shape: 'A scheduler per node that owns its hosts, so politeness and priority are decided locally. The hard parts are the frontier, deduplication and recovery.',
    },
    {
      name: 'One-off crawl for a corpus',
      scale: '10 billion pages in under five days: at about 100 KB a page, about 18.5 Gbit/s',
      shape: 'A queue with visibility timeouts and a dead-letter queue, stateless fetchers on two or three large network-optimised machines (one 200 Gbit/s instance carries the bandwidth), a metadata table, and a lock and counter per domain in Redis. Simpler to build, and enough when nothing is revisited.',
    },
    {
      name: 'One site, one machine',
      scale: 'thousands to millions of pages',
      shape: 'A coordinator and a pool of workers, a visited set marked when a URL is queued, one rate limiter. Finished when the queue is empty and nothing is in flight.',
    },
  ],

  decisions: [
    { choice: 'Where politeness lives', a: 'A partitioned frontier: each host has one owner, so the decision is local and lock-free.', b: 'A central limiter or frontier service: one place to reason about, and a dependency for every fetch.', call: 'Partitioned, with a small shared limiter for busy addresses.' },
    { choice: 'URL-seen set', a: '64-bit fingerprints on disk: about 80 GB, about three misses in 10 billion.', b: 'Bloom filter: about 12 GB, and 1 per cent of new pages lost for good.', call: 'Fingerprints, unless losing the tail is acceptable.' },
    { choice: 'Delivery', a: 'At-least-once with idempotent upserts and leases.', b: 'Exactly-once across fetch, store and enqueue.', call: 'At-least-once. A rare repeated fetch is the price.' },
    { choice: 'What the log is for', a: 'Transport between nodes, and replay after a failure.', b: 'The frontier itself, one topic per stage.', call: 'Transport only. A log cannot delay one host while serving another.' },
    { choice: 'Crawl order', a: 'Breadth-first: simple, and it finds good pages early.', b: 'Priority from links in, change rate and business value.', call: 'Priority, with depth as one of the signals.' },
  ],

  drills: [
    { name: 'A crawler node dies', what: 'Its leases expire, its slots move with a higher epoch, the new owner restores from a snapshot and replays the topic. In-flight URLs are fetched again.' },
    { name: 'A site starts answering 429', what: 'Honour Retry-After, double the delay, recover slowly. After many errors in a row, pause the host for hours.' },
    { name: 'A calendar with endless next links', what: 'The host hits its page budget, the near-duplicate alarm fires, and a pattern rule is added.' },
    { name: 'DNS stops answering', what: 'Duplicate lookups collapse into one, the breaker opens, fetchers skip unresolved hosts and work on the rest.' },
    { name: 'One huge site', what: 'It is a backlog, not a hot spot: politeness caps it at about one request a second whatever its size. Give it a slot of its own.' },
    { name: 'The object store is down', what: 'Buffer to local disk, then stop fetching. Never drop a page a site has already paid to serve.' },
  ],

  interview: [
    'Open with scope and one sentence of design: seeds feed a frontier, fetchers pull from it politely, parsers extract links, new links go back in. Then say where the hard parts are.',
    'Do the sums early. A billion pages a month is about 400 a second and twenty machines, so this is a scheduling problem far more than a compute problem.',
    'Spend your depth on the frontier. Priority and politeness are two separate questions, and a plain queue answers neither.',
    'Say "partition by host" and explain what it buys: the queue, the rate limit and the robots rules for a host all live on one node.',
    'Treat failure as states, not afterthoughts: queued, leased, fetched, waiting to retry, dead. The lease is how a crashed worker is survived.',
    'Raise security yourself. A crawler is a request-forgery engine, and a parser reads hostile input all day.',
    'Close with the trade-offs you made and what you would build first: one machine, then distribution, then quality, then rendering.',
  ],

  sources: [
    { label: 'Hello Interview: Design a Web Crawler', href: 'https://www.hellointerview.com/learn/system-design/problem-breakdowns/web-crawler', note: 'The one-off, queue-centred framing: SQS with a dead-letter queue, DynamoDB, Redis locks and counters, and the five-day capacity estimate.' },
    { label: 'Heydon and Najork, Mercator: A Scalable, Extensible Web Crawler (1999)', href: 'https://doi.org/10.1023/A:1019213109274', note: 'Per-host queues for politeness, and the DNS finding. The front and back queue design is from the authors\' later work.' },
    { label: 'RFC 9309, Robots Exclusion Protocol (2022)', href: 'https://www.rfc-editor.org/rfc/rfc9309', note: 'Matching rules, caching for at most 24 hours, and what to do on errors.' },
    { label: 'Manku, Jain and Das Sarma, Detecting Near-Duplicates for Web Crawling (2007)', href: 'https://doi.org/10.1145/1242572.1242592', note: 'SimHash at web scale.' },
  ],

  keyNotes: [
    { mode: 'local', text: 'A "pipe" chip is the same kind of hop, to a sandboxed process on the same node.' },
  ],

  glossary: [
    { term: 'SimHash', see: { id: 'simhash', label: 'SimHash' }, also: ['near-duplicate fingerprint', 'Charikar'], where: 'parser', text: 'A 64-bit fingerprint that stays similar when the text is similar. Each word or shingle is hashed, and every bit position takes a weighted vote: add the weight if the bit is 1, subtract it if 0. The sign of each total gives one bit. Two pages whose fingerprints differ in three bits or fewer are treated as near-duplicates. Charikar described it in 2002; Manku, Jain and Das Sarma showed it working on 8 billion pages in 2007.' },
    { term: 'Near-duplicate', also: ['near-dup'], where: 'parser', text: 'Two pages with the same content but different adverts, timestamps or session tokens. Their exact hashes differ completely, so spotting them needs a similarity fingerprint such as SimHash.' },
    { term: 'MinHash', where: 'parser', text: 'Estimates how much two sets of shingles overlap by comparing the smallest hash values in each. Good for measuring the similarity of two given documents. It needs many values per page, where SimHash needs one fingerprint.' },
    { term: 'Shingle', also: ['n-gram'], where: 'parser', text: 'A run of a few consecutive words from a page. Comparing sets of shingles compares content while ignoring small edits.' },
    { term: 'Content hash', also: ['SHA-256', 'exact duplicate'], where: 'parser', text: 'A hash of the page body after light normalisation. The same content at two URLs gives the same hash, so the second copy is stored as a pointer and its links are not extracted again.' },
    { term: 'WARC', also: ['Web ARChive'], where: 'blob', text: 'The standard file format for stored web responses (ISO 28500). Each record holds the request, the response headers and the body. Many records go into one compressed file, with an index of byte ranges so one page can be read back.' },
    { term: 'Mercator frontier', see: { id: 'crawl-frontier', label: 'Crawl frontier' }, also: ['front queue', 'back queue', 'dual queue'], where: 'frontier', text: 'A frontier in two halves, named after the Mercator crawler. The 1999 paper used one queue per worker thread, chosen by host; the front and back queues with a heap come from later work by the same authors and the Manning, Raghavan and Schütze textbook. Front queues order URLs by priority. Back queues hold one host each, and a heap of next-allowed times decides which back queue may be served. Priority and politeness are separated, so neither starves the other.' },
    { term: 'Lease', see: { id: 'crawl-frontier', label: 'Crawl frontier' }, also: ['visibility timeout'], where: 'frontier', text: 'A hand-out with a deadline. The frontier gives a URL to a fetcher for a fixed time. If the work is not completed by then, the URL goes back in the queue. An SQS visibility timeout is the same idea.' },
    { term: 'Dead-letter queue', also: ['DLQ'], where: 'frontier', text: 'Where a message goes after failing a set number of times, so that it stops blocking the queue and can be inspected. Here, a URL that fails three fetches is marked dead and retried rarely.' },
    { term: 'Epoch', also: ['fencing token', 'generation'], where: 'coord', text: 'A number that goes up each time a slot changes owner. Stores reject writes that carry an older epoch, so a node that was paused and woke up cannot overwrite the work of its replacement.' },
    { term: 'Slot', also: ['partition', 'shard'], where: 'filter', text: 'One of 1,024 buckets that hosts are hashed into. Each slot belongs to exactly one node at a time. Moving a slot moves every host in it, with its queue, rate limit and robots rules.' },
    { term: 'Consistent hashing', see: { id: 'consistent-hashing', label: 'Consistent hash ring' }, where: 'filter', text: 'Placing nodes and keys on one ring so that adding or removing a node moves only about one share in N of the keys. Fixed slots mapped by a coordinator get the same effect with an explicit, versioned map.' },
    { term: 'Bloom filter', see: { id: 'bloom-filter', label: 'Bloom filter' }, where: 'seen', text: 'A bit array that answers "definitely not seen" or "probably seen" in very little memory. At 1 per cent false positives it needs 9.6 bits per URL. In a crawler a false positive is a page that is never fetched, and it stays wrong until the filter is rebuilt.' },
    { term: 'URL fingerprint', also: ['64-bit hash'], where: 'seen', text: 'A 64-bit hash of the canonical URL, stored in place of the URL itself. Ten billion of them take about 80 GB, with about three collisions expected.' },
    { term: 'Canonicalisation', also: ['URL normalisation', 'normalization'], where: 'filter', text: 'Putting a URL into one standard spelling: lower-case scheme and host, default port removed, fragment dropped, relative links resolved, tracking parameters stripped. Without it one page enters the frontier under many names.' },
    { term: 'robots.txt', also: ['RFC 9309', 'Robots Exclusion Protocol'], where: 'robots', text: 'A file at the root of a site saying which paths crawlers may fetch. Standardised as RFC 9309 in 2022: the longest matching rule wins, cache it for at most 24 hours, treat a server error as "disallow everything".' },
    { term: 'Crawl-delay', where: 'robots', text: 'A line some sites put in robots.txt asking for a gap between requests. It is not part of the standard. Honour it, with a cap on absurd values.' },
    { term: 'Politeness', also: ['rate limit'], where: 'iplimit', text: 'Not overloading the sites you crawl: one request in flight per host, a gap between requests, limits per shared address, and slowing down when a site asks. Target: zero violations.' },
    { term: 'Token bucket', see: { id: 'token-bucket', label: 'Token bucket' }, where: 'iplimit', text: 'A rate limiter. Tokens drip into a bucket at a fixed rate, and each request takes one. An empty bucket means wait. It allows short bursts while holding the average.' },
    { term: 'Public Suffix List', also: ['registrable domain', 'eTLD+1'], where: 'iplimit', text: 'A list of suffixes under which anyone can register a name, such as co.uk. It tells you that a.example.co.uk and b.example.co.uk belong to one owner while two different .co.uk sites do not.' },
    { term: 'AIMD', also: ['additive increase multiplicative decrease', 'back-off'], where: 'fetcher', text: 'The rule TCP uses for congestion, applied to a host\'s request rate: on a 429 or 503 double the delay, and after successes shorten it in small steps.' },
    { term: 'Circuit breaker', where: 'fetcher', text: 'After many failures in a row, stop calling for a while and fail fast. Here it pauses a host for hours, or makes fetchers skip hosts whose names will not resolve.' },
    { term: 'SSRF', also: ['server-side request forgery'], where: 'fetcher', text: 'Tricking a server into requesting something only it can reach, such as a cloud metadata address or an internal admin page. A crawler fetches URLs chosen by strangers, so every resolved address is checked against private ranges, on every redirect.' },
    { term: 'DNS rebinding', where: 'fetcher', text: 'Answering a first lookup with a public address and a second with a private one. The defence is to connect to exactly the address that was checked.' },
    { term: 'Tarpit', also: ['Slowloris', 'slow server'], where: 'fetcher', text: 'A server that answers very slowly on purpose or by accident, holding a connection open for minutes. Deadlines on every phase of the request are the defence.' },
    { term: "Little's law", where: 'fetcher', text: 'Requests in flight equal arrival rate times time in the system. At the 1,000 fetches a second the crawl is built for, and about one second each, about 1,000 are open at once.' },
    { term: 'Conditional GET', also: ['ETag', 'If-Modified-Since', '304 Not Modified'], where: 'recrawl', text: 'A request that says "send this only if it changed", using the ETag or date from the last fetch. An unchanged page answers 304 with no body.' },
    { term: 'Freshness', also: ['change rate', 'recrawl interval'], where: 'recrawl', text: 'How closely the stored copy matches the live page. Visits are spent where a change is likely, estimated from how often each page changed before.' },
    { term: 'Sitemap', where: 'seeds', text: 'A file a site publishes listing its URLs, often with last-modified dates. A cheap source of new and changed pages, to be treated as a hint.' },
    { term: 'Crawler trap', also: ['spider trap', 'infinite calendar'], where: 'web', text: 'Part of a site that produces endless URLs: calendars with a "next month" link for ever, session identifiers in paths, filters that combine without limit. Caught by budgets per host and by noticing near-identical pages.' },
    { term: 'At-least-once', see: { id: 'append-log', label: 'Append-only log' }, also: ['exactly-once', 'delivery guarantee'], where: 'meta', text: 'Every piece of work is done one or more times, never zero. It is easy to guarantee with leases and retries, and safe when repeating the work changes nothing.' },
    { term: 'Idempotent upsert', also: ['idempotence'], where: 'meta', text: 'A write that inserts or overwrites by key, so doing it twice leaves the same result as doing it once. It is what makes at-least-once delivery safe.' },
    { term: 'Back-pressure', where: 'kafka', text: 'A slow stage telling the stages before it to slow down, in place of dropping work or running out of memory. A log between stages turns it into lag that can be measured.' },
    { term: 'Poison page', also: ['quarantine', 'catastrophic backtracking'], where: 'parser', text: 'Input that crashes or hangs the parser every time: tags nested tens of thousands deep, or text that makes a regular expression run for minutes. After three failures the page is set aside.' },
    { term: 'Headless browser', also: ['Chromium', 'JavaScript rendering'], where: 'render', text: 'A browser with no window, driven by code, used to run a page\'s scripts and read the result. It costs ten to a hundred times a plain fetch.' },
    { term: 'RocksDB', see: { id: 'lsm-tree', label: 'LSM tree' }, also: ['LSM', 'embedded store'], where: 'frontier', text: 'An embedded key-value store built on a log-structured merge tree. It runs inside the crawler process and keeps hundreds of millions of pending URLs on local disk.' },
    { term: 'Parquet', where: 'downstream', text: 'A columnar file format. The link graph is written as Parquet so that analysis jobs can read only the columns they need.' },
  ],
};
