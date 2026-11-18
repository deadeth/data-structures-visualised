import type { Extras } from './types';
import { bitRate, commas, duration, said, saidValue, shown, size, trim, words } from './live';

/**
 * Interview extras for the web crawler.
 *
 * Written for a one-hour round that may start from either end. Many interviewers start small
 * (one site, one machine) and add requirements; others ask for the whole web at once. The
 * opening asks which, and everything after it grows the small design one requirement at a time.
 *
 * Figures agree with src/designs/web-crawler.ts, and with src/reading/walkthroughs/web-crawler.ts
 * where the two differ (20,000 link checks a second, hourly slot snapshots, a due table keyed by
 * hour and slot, about a minute of silence per failover, at most 72,000 repeated fetches).
 * Full size: 1 billion pages a month, about 400 a second, build for 1,000; 100 KB a page; 50
 * links a page; 10 billion known URLs (80 GB as 8-byte fingerprints); 20 nodes at 50 pages a
 * second; 1,024 slots, about 51 a node; a 30-second lease renewed every 10 seconds.
 *
 * Small size, worked on this page: 1 million pages at 1 request a second is 1,000,000 seconds,
 * 11.6 days; at 10 a second it is 100,000 seconds, about 28 hours. 1 million x 100 KB = 100 GB.
 * 10 pages a second x 50 links = 500 seen checks a second. One machine at 50 pages a second is
 * 4.32 million pages a day, about 130 million a month.
 *
 * This page's own choices, not on the design page: a 60-second URL lease as an example; the
 * news tier (1,000 sites, 10 hub pages each, every 5 minutes: 33 fetches a second); every SLO
 * target; the opt-in registry; the order of the migration. Product facts here came from the
 * writer's memory and are unverified: see the session report for the list.
 */
export const extras: Extras = {
  opening: [
    "One question decides the design, so I'll ask it before I size anything: is this one site or the whole web, and roughly how many pages? Thousands, millions or billions? After that: what's it for, does it run once or keep pages fresh, and is anything out of scope, such as images or pages that only appear after scripts run?",
    "If you'd like me to choose, I'll start small. One site or a known list of sites, about a million HTML pages, crawled once. I'll obey robots.txt, identify the crawler with a contact page, and send each host 1 request a second unless its owner agrees to more. No rendering, nothing behind a login. Tell me if any of that is wrong.",
    "If it's small, the design is one service. A queue of URLs to fetch, a pool of workers that fetch and parse, a seen table with a unique index so nothing is queued twice, and politeness per host: one request in flight and a gap before the next. A million pages at 1 a second is 11.6 days, or about 28 hours at 10 a second if the owner allows it, and 100 GB at 100 KB a page. One machine and one Postgres carry that. The limit is how fast the sites let me go, not my hardware.",
    "If it's the whole web, say a billion pages a month, that's about 400 fetches a second on about 20 machines. Then I split by host, so each host has one owner. Each node keeps the queues, the timers and the seen set for its own hosts. Links for other owners travel through a log, a coordinator hands out ownership with leases, and pages and metadata go to shared stores. The hard parts become the scheduler, duplicates and a node dying.",
    "Either way I'll draw the small one first, because the large design is the small one with each part forced to grow. As you add requirements I'll say what breaks and what I'd add. I'll think out loud, so stop me wherever you'd choose differently.",
  ],

  pushes: [
    // ---- starting small ----------------------------------------------------------------
    {
      q: 'One site, one machine. What are the parts?',
      a: [
        'A queue of URLs to fetch, a set of URLs already seen, a small pool of workers that fetch and parse, one rate limiter for the site, and a store for the results.',
        'Every link is put into one spelling, checked for scope (this host only, HTML only, allowed by robots.txt), then looked up in the seen set.',
        `A new URL is marked seen when it's queued, not when it's fetched. Two pages can link to the same URL before either link is fetched, and "seen means fetched" would queue it twice.`,
        `It's finished when the queue is empty and nothing is in flight. Checking the queue alone stops early, while a worker still holds a page full of new links.`,
        'A million pages at 100 KB is 100 GB of HTML, about 20 GB compressed. One disk holds it.',
      ],
    },
    {
      q: 'Why a queue and a seen set, and not recursion? Is that breadth-first or depth-first?',
      a: [
        'The queue separates finding a URL from fetching it. That gap is where the rate limit, retries, and stopping and restarting all live.',
        `Recursion is depth-first and keeps its place on the call stack. A long chain of links overflows it, a crash loses everything, and several workers can't share it.`,
        'The seen set is what ends the crawl. Pages link in cycles: every page links back to the home page.',
        `A queue gives breadth-first order, so pages near the home page come first. Those are usually the ones that matter, and a calendar with an endless "next month" link can't swallow the crawl before anything else is fetched.`,
        `Depth-first holds less in memory on a tree, but a site isn't a tree. With many sites I'd move from plain breadth-first to priority, with depth as one signal.`,
        `The seen set is small here: a million URLs at about 100 bytes is 100 MB in memory, or 8 MB as 8-byte fingerprints.`,
      ],
    },
    {
      q: 'Is Postgres enough? When does it stop being enough?',
      a: [
        'For a million pages, yes, for the queue as well as the results. One urls table: the URL as a unique key, a state, an attempt count and a leased-until time.',
        'The seen check is INSERT ... ON CONFLICT DO NOTHING. The rows that go in are the new URLs. Marking seen and queueing are one statement, so a crash cannot split them.',
        'Workers claim rows with SELECT ... FOR UPDATE SKIP LOCKED, so two never take the same URL.',
        'The load is small: 10 fetches a second find about 500 links a second, which is a few batched inserts.',
        `It stops being enough when the write rate and the table outgrow one node. At 400 pages a second that's 20,000 link checks a second and a table heading for 10 billion rows; locks and vacuum become the work. My rough line is tens of millions of URLs, and I'd measure before moving.`,
        `Raw HTML doesn't go in the table. It goes to files or an object store, with the location in the row.`,
      ],
    },

    // ---- going faster ------------------------------------------------------------------
    {
      q: 'How many workers? How do you size the pool?',
      a: [
        'Workers in flight equal fetch rate times time per fetch. At 10 a second and about 1 second a fetch, about 10 are busy. I would run 20 to cover slow pages.',
        'At 1 request a second, one worker is enough. A pool of 100 would sit idle behind the rate limiter.',
        `The usual rule for work that mostly waits is threads = cores x (1 + wait time / compute time). With a 1 second wait and 15 ms of parsing that allows about 68 threads a core, so the processor isn't the limit either.`,
        `Bound the queue between fetching and parsing, so a slow parser pushes back and memory doesn't fill.`,
        `Then measure. Raise the pool until pages a second stops rising, or until the site's response time starts to. The second one means stop.`,
      ],
    },
    {
      q: 'Threads or async IO?',
      a: [
        'Fetching is waiting on sockets. An event loop holds thousands of open connections in one process; a thread per request pays a stack and context switches for each one.',
        `At 10 to 20 connections, threads are fine and the code is easier to read and debug. I'd start there.`,
        `At about 50 in flight a machine, or 1,000 across a large crawl, I'd fetch on an event loop.`,
        'Parsing is processor work, 10 to 20 ms a page, so it runs on its own pool of processes. Parsing on the event loop stalls every open socket.',
        'Watch DNS: the standard library lookup blocks. On an event loop it needs an async resolver or a small thread pool of its own.',
      ],
    },
    {
      q: 'I give you ten times the machines. How much faster is it?',
      a: [
        'For one site, no faster. At 1 request a second a site gives at most 86,400 pages a day however many machines I own.',
        `The limit is the site's patience. Going faster means asking the owner, or being blocked.`,
        'Machines help only when the crawl is wide: many hosts, each at its own polite rate. 400 pages a second needs at least 400 hosts in rotation, and in practice far more, because the gap is often several seconds.',
        `So I'd ask back: how many sites? That decides whether the next step is more machines or a better scheduler.`,
        `It's why I call this a scheduling problem more than a compute problem.`,
      ],
    },

    // ---- many sites --------------------------------------------------------------------
    {
      q: 'Now it is 10,000 sites. What changes?',
      a: [
        'One queue and one limiter stop working. Links cluster by host, so the next thousand URLs are often one site: I either hammer it or leave every worker waiting for its turn.',
        'Give each host its own queue and a next-allowed time. A heap of those times says which host is due, and a worker is only handed a URL whose host is due.',
        'That makes one request in flight per host true by construction, with no locks.',
        'After a fetch the host waits the largest of 1 second, its Crawl-delay and ten times the last response time. A page that took 840 ms earns a gap of 8.4 seconds.',
        'On a 429 or 503, honour Retry-After or double the delay, then shorten it slowly after successes.',
        'Keep priority apart from politeness: queues by priority feed the per-host queues, so good pages do not wait behind link farms.',
      ],
    },
    {
      q: 'How do you handle robots.txt?',
      a: [
        'Fetch it once per host and cache the parsed rules for at most 24 hours, which is what RFC 9309 asks. Fetching it before every page would double the traffic.',
        'The longest matching rule wins, and Allow wins a tie.',
        'A 4xx means no restrictions. A 5xx or no answer means fetch nothing: an overloaded site is telling me something.',
        `Crawl-delay isn't in the standard. I'd honour it, with a cap on absurd values.`,
        'Rules are matched by the crawler\'s name, so the User-Agent stays stable and links to a page with a contact address and how to opt out.',
        'Log every fetch with the rule that allowed it. A fetch of a disallowed path is an incident, not a bug ticket.',
      ],
    },
    {
      q: 'What do people forget once there are many sites?',
      a: [
        'DNS first. An uncached lookup takes tens to hundreds of milliseconds and the standard call blocks a thread. A caching resolver beside the fetchers turns 400 lookups a second into tens.',
        'Then shared hosting. Thousands of hosts can sit on one address, so per-host limits miss the total. I add a token bucket per resolved address and per registrable domain.',
        'On one machine that bucket is a map in memory. Across machines it has to be shared, because those hosts have different owners. It is the one place this design needs a distributed limiter.',
        'Then security. A crawler fetches URLs chosen by strangers. Check each resolved address against private ranges, connect to exactly that address, and check again on every redirect.',
        'And the far end promises nothing: a deadline on every phase, a 10 MB cap on the body, at most five redirects.',
      ],
    },

    // ---- many machines -----------------------------------------------------------------
    {
      q: 'One machine is not enough. A shared queue, or one owner per host?',
      a: [
        `First I'd check that I need more machines. One machine at about 50 pages a second fetches 4.3 million pages a day, about 130 million a month. Millions fit on one.`,
        'A shared queue with stateless workers is the simple option: any worker takes any URL. But politeness then needs a shared lock or limiter per host, which is a network call on every fetch.',
        'One owner per host: hash the host to pick a machine. Its queue, its timer, its robots rules and its seen URLs all live there, so politeness and duplicate checks are local.',
        'The price is state on every node. It needs a map of who owns what, and a way to recover when a node dies.',
        `I'd take the shared queue for a one-off crawl where nothing is revisited, and one owner per host for a crawl that runs for ever.`,
        'Links to hosts another node owns travel through a log keyed by host. If one link in five points off-site, an assumption, that is about 4,000 messages a second.',
      ],
    },
    {
      q: 'Queues or distributed locks?',
      a: [
        'They solve different problems. A queue gives ownership of one message: once handed out it is hidden until acknowledged or until a timeout passes. That is a lease.',
        `A lock is for a rule that spans messages, such as one request in flight per host. A queue can't express that.`,
        'A distributed lock needs an expiry, or a dead holder blocks the host for ever. With an expiry, a paused worker can wake up believing it still holds the lock.',
        `The usual fix is a fencing token: a number that rises with each grant, checked by whatever the holder writes to. A stranger's web server can't check my token, so for fetches the new holder has to wait out the old lock before it starts.`,
        'The better answer is to need no lock on the fetch path. Partition by host so one node owns it. The only lease left is on a slot of hosts, renewed every 10 seconds.',
      ],
    },
    {
      q: 'Two workers find the same URL at the same moment. How do you stop it being fetched twice?',
      a: [
        'Canonicalise first: lower-case scheme and host, drop the default port and the fragment, resolve relative links, strip tracking parameters. Otherwise one page has a dozen spellings.',
        'Then one atomic add-if-absent on something shared: a unique index with ON CONFLICT DO NOTHING, or a Redis set, where SADD reports 1 only for the first caller.',
        `Check-then-insert as two steps is the bug. Both workers read "absent" and both insert.`,
        'Size it out loud: 10 million URLs at 100 bytes is 1 GB, or 80 MB as 8-byte fingerprints. It fits in memory.',
        `A Bloom filter only when the set outgrows memory, and even then its false positive is a page never crawled. At 10 billion URLs I'd keep 64-bit fingerprints on disk: 80 GB, about three collisions.`,
        'With one owner per host there is no race at all. Every link for a host arrives at the same node, which checks its own local set.',
      ],
    },
    {
      q: 'How would you build a distributed rate limiter?',
      a: [
        'Ask what is limited and who shares it. Here it is requests to one host or one address, shared by every worker that might fetch from it.',
        'Know four algorithms. Fixed window is simple and lets a double burst through at the boundary. A sliding log is exact and stores every timestamp. A sliding window counter estimates from two windows. A token bucket gives a steady rate with a bounded burst, and is the one I would use.',
        'Build: one Redis hash per key holding the tokens left and the time of the last take. A Lua script refills by the time elapsed, takes a token if there is one and writes back. Redis runs a script as one step, so two workers cannot both take the last token.',
        'Keys expire after a minute idle. An idle bucket would be full again by then, so nothing is lost.',
        'Decide what happens when Redis is down. For politeness, fail safe: drop to a slow fixed rate, never unlimited.',
        `Then offer the cheaper design. If one node owns each host, the limit is a local timer with no shared store. I'd keep the shared limiter only for addresses that serve many sites.`,
      ],
    },
    {
      q: 'Consistent hashing, or a slot map?',
      a: [
        'hash(host) mod N is one line and wrong: change N and almost every host moves to a new owner.',
        'A consistent hash ring moves about 1 host in N when a node joins, with no map to store. But nodes must agree on who is a member, and a paused node that wakes up is not fenced.',
        `I'd use 1,024 fixed slots: slot = hash(host) mod 1,024, with a small coordinator mapping slots to nodes. Across 20 nodes that is about 51 each, and losing a node moves only its 51.`,
        'Each move is an explicit step with an epoch number, so an old owner can be refused.',
        `The slot number is also the log partition, the key range on disk and the snapshot folder. A host's whole state moves in one step.`,
        'The cost is a consensus cluster such as etcd to run, and nodes that pause when they cannot reach it.',
      ],
    },

    // ---- failure -----------------------------------------------------------------------
    {
      q: 'A worker dies mid-fetch. What happens to its URL?',
      a: [
        'Every hand-out is a lease with a deadline. The URL stays in the durable queue until the worker reports it complete.',
        'If the worker dies, nothing completes it. The deadline passes and the URL is offered again. Nobody has to detect the death.',
        `A managed queue's visibility timeout is the same idea: the message is hidden, not deleted, until it's acknowledged.`,
        'Acknowledge only after the page is stored and its links are queued. Acknowledge first, and a crash loses the page.',
        `Set the deadline well above a normal fetch: say 60 seconds against a 1 second average. Too short and slow pages are fetched twice, so I'd watch the share of repeat fetches to tune it.`,
        'A late completion for an expired lease is ignored.',
      ],
    },
    {
      q: 'So a URL can be fetched twice. Why is that safe?',
      a: [
        `It's at-least-once: never zero fetches, rarely two. Exactly-once across a fetch, a store and an enqueue would need a transaction that includes someone else's web server.`,
        'Repeats are harmless because every write is keyed. The outcome is an upsert by URL, stamped with the fetch time, so a late write of an older result loses.',
        'Links from the second parse hit the seen check and are dropped. They were marked seen the first time.',
        'The raw page is written again in a new batch, and the row points at the newer copy.',
        `The real cost is the site's: one extra visit. So I measure repeat fetches and keep them rare.`,
        'Consumers may get the event twice, so they drop repeats by URL and content hash.',
      ],
    },
    {
      q: 'One URL crashes the worker every time. What then?',
      a: [
        'There are two kinds: a URL whose fetch always hangs or fails, and a page that crashes the parser.',
        'For the fetch, every phase has a deadline, the body is capped at 10 MB and redirects at five. Timeouts and 5xx are retried with exponential back-off and jitter. A 404 is not retried.',
        `Count attempts on the URL's row. After three failures mark it dead and retry it rarely. That is the dead-letter queue.`,
        `Run the parser as a separate sandboxed process, so a crash doesn't drop the fetcher's sockets. Retry from the stored page and quarantine it after three failures.`,
        'Without the count, the lease expires, the URL is handed out again, and it kills a worker a minute for ever.',
        'Keep the dead list visible. A sudden rise in it is usually my bug, not theirs.',
      ],
    },
    {
      q: 'A node pauses for a minute, loses its hosts, and wakes up. What stops two nodes fetching one site?',
      a: [
        `This is the dangerous case, because the node isn't dead. It wakes up believing it still owns its hosts.`,
        'Ownership is a lease on slots held with the coordinator: 30 seconds, renewed every 10. When it lapses, the slots move to another node with a higher epoch, say 7 to 8.',
        `On waking, the old node's renewal is refused. It stops handing out URLs at once and deletes the slot's keys.`,
        'Anything it still writes carries epoch 7, and the stores turn it away.',
        `A web server can't check an epoch, so the new owner waits out the full lease plus a margin for clock drift before its first fetch.`,
        `Fail closed. The hosts go unfetched for about a minute, which is cheap. Two fetchers on one host is the thing I've promised site owners won't happen.`,
      ],
    },

    // ---- content -----------------------------------------------------------------------
    {
      q: 'The same article at fifty URLs, and a calendar with no end. How do you cope?',
      a: [
        'Exact copies: a SHA-256 of the body. The same content at a second URL is stored as a pointer.',
        'Near copies, such as one article with different adverts: a 64-bit SimHash. Fingerprints 3 bits or fewer apart are treated as near-duplicates.',
        `A trap makes endless new URLs, so the seen check can't catch it: every one really is new.`,
        'So each host gets a page budget and a depth cap, URLs have a length limit, and pattern rules drop known shapes such as dates far in the future.',
        `And an alarm: keep each host's last 64 fingerprints, 512 bytes, and flag a host whose new pages are nearly identical. That catches a trap by its effect, whatever its shape.`,
        'Finding near-copies across the whole crawl is an offline job, off the fetch path.',
      ],
    },
    {
      q: 'What about pages built with JavaScript?',
      a: [
        `I'd leave rendering out of the first version and say so. This design assumes most text is in the HTML.`,
        `A headless browser costs ten to a hundred times a plain fetch, and it's the largest attack surface in the system.`,
        'When the product needs it, the parser spots pages with an almost empty body or a known script framework and publishes their URLs to a render topic.',
        'A small sandboxed pool renders them and writes the result to the object store like any fetched page. It has no route to anything internal.',
        `It sits behind a queue, so a slow pool builds lag and never slows the crawl. And it can be switched off.`,
        'A rendered page costs the site more requests, for scripts and data. Count those against its budget.',
      ],
    },
    {
      q: 'How do you keep pages fresh, and which pages go first?',
      a: [
        'Start with fixed tiers: news hourly, most pages monthly. That needs no history, and the load is easy to forecast.',
        `Move to an adaptive interval once there's data: halve it when the content hash changed, lengthen it when it didn't.`,
        'Make a wasted visit cheap. Send the saved ETag and date, and an unchanged page answers 304 with no body, against about 100 KB.',
        `Finding what's due mustn't scan every row. A second table is keyed by the hour a URL falls due; the scheduler reads the current hour and re-queues.`,
        'Priority is a separate question from timing. Seeds and pages with many links in go first; depth and change rate are further signals.',
        `Cap the share of each host's budget that recrawl may take, or new pages starve.`,
      ],
    },

    // ---- storage and technology --------------------------------------------------------
    {
      q: 'Where do the pages and the metadata go? Name the technology.',
      a: [
        `For each one I'd name the tool, one reason and one limit.`,
        'Raw pages go to object storage such as S3, because it is cheap per byte and durable once a write is acknowledged. Its limit is small objects: batch about 500 pages into one 10 MB WARC file, under one upload a second in place of 400, and keep each page\'s byte range.',
        'For a million pages the metadata is one Postgres table. Transactions and easy queries are the reason; one node\'s write rate and size is the limit.',
        'For 10 billion rows it is Cassandra or ScyllaDB. Small upserts by key and growth by adding nodes are the reason: 3 TB, 9 TB with three copies. The limit is a table per query and no joins.',
        `Between nodes it is Kafka, keyed by host, for ordered partitions, buffering and replay from a saved offset. Its limit is that it can't delay one message, so it can't hold a host back. It carries URLs; it doesn't schedule them.`,
        'Ownership sits in etcd or ZooKeeper, because it must be one agreed answer. The limit: when it is unreachable, nodes pause.',
      ],
    },

    // ---- operating it ------------------------------------------------------------------
    {
      q: 'What would you monitor? How would you know it is being rude to a site?',
      a: [
        'Four numbers first: politeness violations, pages fetched a second against the target, lag on each partition of the log, and the share of fetches that are repeats.',
        'Violations are three counts: overlapping requests to one host, gaps shorter than its delay, and fetches its robots rules disallow. The target is zero, and any one pages someone.',
        `Compute them from the fetch log, apart from the scheduler. A scheduler bug shouldn't be able to hide itself.`,
        `From the outside: the rate of 429 and 503 by host, hosts that start refusing connections, and mail to the contact address on the crawler's page.`,
        `Each host's current delay and error streak are visible, with a kill switch per domain beside them.`,
        'Then health: queue depth, DNS latency, dead URLs, parser quarantines, slots without an owner.',
      ],
    },
    {
      q: 'What does it cost?',
      a: [
        'At a million pages: one machine, one database, 100 GB. The cost is engineering time, not the bill.',
        `At a billion a month: 20 modest nodes and about 320 Mbit/s. Compute isn't the big line.`,
        'Storage is the line that never stops growing: 20 TB a month compressed, 240 TB after a year. So I ask how long raw pages must be kept.',
        'The metadata cluster holds 9 TB with three copies on fast disks, so it costs more per byte than the pages do.',
        'Rendering is the multiplier. One page in 20 at ten to a hundred times a fetch adds between half and five times the fetch fleet.',
        'People cost most. The frontier is custom stateful code: it needs owners, failover drills and an on-call rota.',
      ],
    },

    // ---- the requirement changes ---------------------------------------------------------
    {
      q: 'The requirement changes: news sites must be fresh within an hour.',
      a: [
        `First I'd pin it down. Does fresh mean a new article is stored within an hour of being published? For how many sites? I'll assume 1,000.`,
        `Nobody tells me when a page appears, so I poll where new links show up: home and section pages, sitemaps and feeds. Say 10 per site every 5 minutes: 10,000 fetches every 300 seconds, about 33 a second, mostly 304s.`,
        'For each site that is one request every 30 seconds, well inside its polite rate.',
        `New article links from those pages get top priority, so they leave the priority queues first. The wait is then the host's own gap: seconds.`,
        `The cost is budget: 33 of 400 fetches a second, about 8 per cent, reserved for one tier. I'd cap it and review the tier's list like the seed list.`,
        'What changes in the design: a news tier that the recrawl scheduler reads in 5-minute windows, and a target to hold it to, such as 95 per cent of new articles stored within 60 minutes. A failover takes about a minute, so it fits.',
      ],
    },
    {
      q: 'The requirement changes: it may only ever crawl sites that opt in.',
      a: [
        `That flips the default from "allowed unless robots.txt says no" to "forbidden unless the owner said yes". I'd say what it costs first: coverage shrinks to whoever signs up.`,
        'A registry of opted-in sites, each verified by the owner placing a token in a DNS record or a file on the site. Seeds come only from the registry.',
        `The URL filter drops every link whose registrable domain isn't in the registry. The fetcher checks again on each redirect, in the same place as the private-address check.`,
        `Fail closed: if the registry can't be read, fetch nothing.`,
        'Opting out takes effect within minutes. The kill switch empties the site\'s queue, and stored pages are deleted if the owner asks. robots.txt still applies on top.',
        'It may be a much smaller system. A few thousand sites could be one machine and Postgres again, and owners who opted in may agree a higher rate.',
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: '1. One site, one machine',
        ships: 'One process: a URL queue and seen set in one Postgres table, a small worker pool, one rate limiter, robots.txt, pages written to object storage, a public page that names the crawler and gives a contact. It can be stopped and restarted without losing its place.',
        why: 'It meets the first real need and tests the parser and the URL rules on real pages. Every later phase reuses this loop.',
      },
      {
        name: '2. Many sites, still one machine',
        ships: 'A queue and next-allowed time per host, back-off on 429 and 503, a DNS cache, the private-address check, a page budget per host, a kill switch per domain, and the three violation counters.',
        why: 'Politeness is the promise to site owners, and it is easier to get right before there are machines to coordinate. One machine carries about 130 million pages a month, so many crawls stop here.',
      },
      {
        name: '3. A crawl that keeps going',
        ships: 'One metadata row per URL, raw pages in WARC batches with byte ranges, fixed-tier recrawl with conditional requests, and an event per page as the contract for consumers.',
        why: 'Consumers can build against a contract, and a parser fix becomes reprocessing stored pages, not fetching again.',
      },
      {
        name: '4. Many machines',
        ships: '1,024 slots, the log between nodes, the coordinator with leases and epochs, hourly slot snapshots, the shared limiter for busy addresses, and a failover drill run on a real node.',
        why: 'Only when measured throughput on one machine is the limit. It is the costly phase: state on every node, and three new services to run.',
      },
      {
        name: '5. Quality, then rendering',
        ships: 'Priorities, adaptive recrawl, the near-duplicate alarm and trap rules. A rendering pool last, and only for pages that need it.',
        why: 'Each needs data the earlier phases produce: change history, link counts, fingerprints. Rendering costs ten to a hundred times a fetch, so it waits for a product need.',
      },
    ],
    migration: [
      'The usual starting point is phase 2: one machine and one Postgres. The move to many machines must not fetch again what is already stored, and must never put two fetchers on one host.',
      'Key by slot from the first day. Even on one machine, compute slot = hash(host) mod 1,024 and put it in every key. One node that owns all 1,024 slots is a cluster of one.',
      'Move the metadata first, while there is still one writer. Write each outcome to both stores; upserts by URL make that safe. Backfill by key range, compare counts and a sample of rows, then switch the recrawl scheduler to read from the new store.',
      'Bring up the log and the coordinator with the single node as the only owner. Nothing changes except that links for other owners now have a path.',
      'Move slots a few at a time. The old owner stops leasing a slot and snapshots it, the map changes with a higher epoch, the new owner restores and waits out the lease before fetching. A host is silent for about a minute and never doubled.',
      'Rolling back is the same step in reverse, so keep the old machine until the last slot has run cleanly on its new owner for a week.',
      'Kill a real node before calling it finished, and time how long its hosts take to come back.',
    ],
    slos: [
      { name: 'Politeness', target: '0 violations a week: no overlapping requests to a host, no gap shorter than its delay, no fetch its robots rules disallow', why: 'The crawl runs on site owners\' tolerance. One breach can get a whole address range blocked.' },
      { name: 'Throughput', target: 'at least 95% of the plan each week; the plan is 1 billion pages a month, about 400 a second', why: 'It is the number consumers plan around, and a weekly check shows a miss before the month is lost.' },
      { name: 'Freshness', target: '95% of due URLs fetched within twice their interval; for a news tier, 95% of new articles stored within 60 minutes', why: 'Staleness is what the users of the crawl feel. The target is by tier because one figure for every page hides the tier that matters.' },
      { name: 'Failover', target: 'a dead node\'s hosts are being fetched again within 5 minutes', why: 'The design gives about a minute: the 30-second lease, a margin for clock drift and the restore. Five minutes leaves room for a slow restore.' },
      { name: 'Nothing fetched is lost', target: '0 pages recorded as fetched whose raw copy cannot be read back', why: 'Each page cost a site a visit. A batch lost before upload, up to 500 pages, is fetched again and is not counted as stored.' },
      { name: 'Site owner requests', target: 'a blocked domain stops being fetched within 5 minutes; mail to the contact address answered within one working day', why: 'This is the only service level a site owner experiences.' },
    ],
    oncall: [
      'Page: any politeness violation. An overlapping request or a disallowed fetch is treated as an incident, with the host paused first and questions after.',
      'Page: a slot with no owner for more than 5 minutes, or the coordinator without a quorum. Every node pauses when it cannot renew.',
      'Page: fetch rate below half the target for 15 minutes.',
      'Page: writes to the object store or the metadata store failing and local buffers more than half full. When they fill, fetching stops.',
      'Morning: hosts paused by back-off, growth in dead URLs, parser quarantines, lag on one partition of the log, repeat fetches above 1%, the news tier behind its target.',
      'Morning, but the same day: every message to the contact address. A legal notice goes to the named legal contact at once.',
      'Runbooks: pause a domain; node failover (confirm the slots moved, watch the restore); coordinator outage (nodes pause on their own, so do not force them); object store outage (watch buffers, expect fetching to stop).',
      'A dead node should not need a person. The lease, the snapshot and the replay are there so that it does not.',
    ],
    teams: [
      { name: 'Crawl core', owns: 'The frontier, fetchers, politeness rules, the slot map and failover. This team carries the pager.' },
      { name: 'Content and quality', owns: 'The URL rules library, the parser, duplicate detection, trap rules, priorities, recrawl policy and review of the seed list.' },
      { name: 'Data platform (often an existing team)', owns: 'Kafka, the metadata store, the object store and the coordinator, run as services with their own on-call.' },
      { name: 'Consumers: indexing, analytics, training', owns: 'What they do with the events and files. The crawler does not know them and does not wait for them.' },
      { name: 'Policy and site-owner contact, with legal', owns: 'The crawler\'s public page, the opt-out and takedown process, the mailbox and who may use the kill switch.' },
      { name: 'Before phase 4', owns: 'One team of four to six owns all of it, with a named owner for politeness. Split when the pager or the roadmap asks for it, not before.' },
    ],
    buildBuy: [
      { part: 'The single-site crawler', call: 'Use an open-source framework such as Scrapy', why: 'One site at a polite rate is a solved problem. Write only what is specific: the scope rules and what gets stored.' },
      { part: 'The frontier at scale', call: 'Build, after reading the open-source crawlers (Heritrix, Nutch, StormCrawler)', why: 'It is a scheduler, and no queue product holds one host back while serving another. Borrow a design before inventing one.' },
      { part: 'The log between nodes', call: 'Buy managed Kafka', why: 'About 4,000 messages a second is small. Running brokers is not where the team\'s time should go.' },
      { part: 'Metadata store', call: 'Buy: managed Postgres first, a managed Cassandra-compatible store at scale', why: 'Upserts by key are a commodity. Repairs and upgrades of a database cluster are a job in themselves.' },
      { part: 'Object storage', call: 'Buy', why: 'Nobody builds this. It also holds the slot snapshots.' },
      { part: 'Coordinator', call: 'Use etcd or ZooKeeper', why: 'Never write consensus. The slot map is a few kilobytes.' },
      { part: 'robots.txt parser', call: 'Use a tested open-source library, then test it against RFC 9309 yourself', why: 'A parsing mistake fetches what a site forbade.' },
      { part: 'URL canonicalisation', call: 'Build one library', why: 'Every stage must agree on one spelling, and the rules are specific to the crawl.' },
      { part: 'Rendering', call: 'Buy a hosted headless-browser service first', why: 'Few pages need it, and browsers are costly to run, patch and sandbox. Its requests still count against each site\'s budget and still carry the crawler\'s name. Build a pool when the bill passes a team\'s time.' },
      { part: 'Rotating proxy networks', call: 'Do not buy', why: 'Changing address to get round a block is the opposite of polite. Crawl from a stable, published address range.' },
    ],
    cost: [
      'At the small size the bill is one machine, one database and 100 GB. The cost is the engineers.',
      'At a billion pages a month the fetch fleet is 20 modest nodes on about 320 Mbit/s. It is not the large line.',
      'Raw pages grow by about 20 TB a month compressed and never shrink: 240 TB after a year. A retention rule is the cheapest saving available, so ask what the pages are kept for.',
      'The metadata store is 9 TB with three copies on fast disks. Per byte it costs more than the pages do.',
      'Hourly slot snapshots upload about 5 MB a second a node, about as much as the crawl itself downloads. Incremental snapshots would cut that, at the price of more recovery code.',
      'Rendering multiplies: 1 page in 20 at ten to a hundred times a fetch adds between half and five times the fetch fleet.',
      'Headcount follows the custom code. The frontier needs owners who understand it, drills, and an on-call rota; the mailbox for site owners needs someone who answers it.',
    ],
    risks: [
      { risk: 'The crawler overloads a site or fetches what the site forbade.', answer: 'Three layers of politeness, the violation counters with a target of zero, a kill switch per domain, and a page to on-call for any breach. Limiters that fail make the crawl slower, never faster.' },
      { risk: 'Legal exposure: stored pages hold copyrighted text and personal data, and the law differs by country and by what the crawl is for.', answer: 'Take legal advice before the first fetch, not after the first letter. Record what each crawl is for, set a retention period, obey robots.txt and opt-outs, and keep an audit trail of every fetch and the rule that allowed it.' },
      { risk: 'A takedown request: an owner or a person wants a page gone.', answer: 'One process with a clock on it. Block the URL or domain at the kill switch, drop the row\'s pointer at once, rewrite the WARC batch that holds the page within a set number of days, and publish an event so consumers delete their copies.' },
      { risk: 'Reputation: the crawler\'s name ends up on blocklists.', answer: 'A stable User-Agent, a public page with a contact, a published address range, mail answered within a working day, and no proxy rotation. Being easy to reach is what stops a complaint becoming a block.' },
      { risk: 'The crawler is used to reach inside the network.', answer: 'Check every resolved address against private ranges, connect to exactly that address, check again on each redirect, and run the parser and any browser in a sandbox with no route inward.' },
      { risk: 'Traps and link farms eat the budget.', answer: 'A reviewed seed list, a page budget and depth cap per host, pattern rules, and the near-duplicate alarm.' },
      { risk: 'The frontier is custom stateful code that two people understand.', answer: 'Keep it small, test it against a model, write the runbooks, rotate the failover drill round the team.' },
      { risk: 'Building for billions when the need is millions.', answer: 'Phase gates. A phase starts only when the one before has hit a measured limit. Phase 2 on one machine carries about 130 million pages a month.' },
    ],
  },

  rehearsal: [
    {
      stage: 'Clarify and set defaults',
      minutes: 5,
      prompt: `You're asked to design a web crawler. Don't size anything yet. Your first question is: one site or the whole web, and roughly how many pages? Then say your defaults out loud, sketch both branches in a sentence each, and check them with the interviewer as you would with a colleague.`,
      cover: [
        'First question: one site or the whole web, and roughly how many pages?',
        'What it is for: search, an archive, monitoring, training data',
        'Run once, or kept fresh?',
        'What polite means: robots.txt, a rate per host, a contact page',
        'Out of scope: rendering, images, logins, indexing',
        'Defaults said aloud: about a million HTML pages, 1 request a second a host',
        'If small: one service, a queue, a worker pool, a seen table with a unique index, per-host politeness',
        'If large: split by host across about 20 nodes, a log between them, a coordinator with leases, shared stores',
        'You will draw the small one first and grow it as requirements arrive',
      ],
    },
    {
      stage: 'Numbers, in under two minutes',
      minutes: 3,
      prompt: 'Do the sums out loud in under two minutes of speaking, then stop. Round hard and say which figures are assumptions. Use the rest of the stage to ask whether the interviewer wants a different scale before you draw.',
      cover: [
        '1 million pages at 1 a second is 11.6 days; at 10 a second, about 28 hours',
        '100 KB a page: 100 GB raw',
        '500 seen checks a second at 10 pages a second: one database is enough',
        'One site at 1 a second gives 86,400 pages a day, whatever the hardware',
        'If asked for the web: 1 billion a month is about 400 a second and about 20 machines',
        'The conclusion, said aloud: the limit is politeness, so this is a scheduling problem',
      ],
    },
    {
      stage: 'The small design: one site, one machine',
      minutes: 8,
      prompt: 'Draw the loop and keep talking while you draw. Say what each part is for and what goes wrong without it. Pause once to ask whether this is the level of detail they want.',
      cover: [
        'Queue, workers, parser, seen set, rate limiter, store',
        'One spelling per URL before the seen check',
        'Marked seen when queued, not when fetched',
        'Breadth-first from a queue, and why not recursion',
        'One Postgres table: unique URL, state, attempts, leased-until',
        'Pool size is rate times time per fetch; threads are fine at this size',
        'Finished when the queue is empty and nothing is in flight',
        'A crash and restart loses nothing, because the table is the state',
      ],
    },
    {
      stage: 'Grow the design: many sites, then many machines',
      minutes: 14,
      prompt: `Let the interviewer set the next requirement, or offer one: more sites, then more machines. For each, say what breaks first, name two options, pick one and say what it costs. Don't go quiet while you think. Say what you're weighing, and ask which way they'd lean.`,
      cover: [
        'Many sites: a queue and a next-allowed time per host, and a heap of those times',
        'robots.txt cached for 24 hours; a 5xx means stop',
        'A DNS cache, and a limit per address for shared hosting',
        'One machine carries about 50 pages a second, 130 million a month: check before adding machines',
        'A shared queue with a lock per host, against one owner per host',
        'Partition by host: 1,024 slots, a coordinator, about 51 slots a node',
        'Kafka between nodes, keyed by host, for transport and replay only',
        'The seen check and the timer stay local; a shared limiter only for busy addresses',
        'Each named technology with one reason and one limit',
      ],
    },
    {
      stage: 'Deep dives: failure, duplicates and the rate limiter',
      minutes: 14,
      prompt: `Expect to be pulled into detail, and go willingly. The three most likely: a worker dies mid-fetch; two workers find the same URL; build a distributed rate limiter. If there's time, tell the paused-node story without being asked. Then point at your own weakest part and invite the interviewer to attack it.`,
      cover: [
        'Lease with a deadline; the URL stays queued until complete; acknowledge after storing',
        'At-least-once, safe because writes are upserts and the seen check drops repeats',
        'Three attempts, then dead; the parser in a sandbox',
        'Canonicalise, then an atomic add-if-absent; never check-then-insert',
        '10 million URLs is 1 GB, 80 MB as fingerprints; why not a Bloom filter',
        'Token bucket in Redis with an atomic script; what happens when Redis is down',
        'The cheaper answer: one owner per host makes the limit a local timer',
        'Slot lease of 30 seconds, epoch 7 to 8, the new owner waits before fetching',
        'Queues give a lease on one message; a lock is for a rule across messages',
      ],
    },
    {
      stage: 'Pushes: the brief changes twice',
      minutes: 5,
      prompt: `The interviewer changes the brief. First: news sites must be fresh within an hour. Then: it may only crawl sites that opt in. Ask one question back each time, change the drawing where they can see it, and say what the change costs.`,
      cover: [
        'What fresh means, and for how many sites',
        'Poll hub pages, sitemaps and feeds: 1,000 sites, 10 pages, every 5 minutes is about 33 fetches a second',
        'Top priority for new article links; a reserved share of the budget, about 8 per cent',
        'Opt-in: a verified registry, the filter drops everything else, redirects checked',
        'Fails closed when the registry cannot be read',
        'Said aloud: coverage shrinks, and the system may fit one machine again',
      ],
    },
    {
      stage: 'Operate it and lead it',
      minutes: 7,
      prompt: 'Now answer as the person accountable for it. What do you promise, what wakes someone up, what ships first, who owns it, what do you buy, and what could get the company a letter from a lawyer? Keep each answer to two or three sentences and offer to go further.',
      cover: [
        'Zero politeness violations, measured from the fetch log',
        'Four pages; a dead node is not one of them',
        'What ships in order: one site, many sites, a lasting record, many machines, quality',
        'Phase gates: no cluster until one machine has hit a measured limit',
        'Buy the log, the stores and rendering; build the frontier and the URL rules',
        'Storage is the line that grows; people cost most',
        'Legal and reputation: robots.txt, a contact page, takedowns with a clock, no proxy rotation',
        'One team first, with a named owner for politeness',
      ],
    },
    {
      stage: 'Your questions',
      minutes: 4,
      prompt: 'Ask what you most want to know, and listen to the answers. Two or three questions are enough.',
      cover: [
        'Where they would have taken the design differently',
        'What scale their own systems run at, and what broke first',
        'How the team decides between building and buying',
        'What on-call is like, and who carries it',
        'What an engineering leader is expected to bring to design decisions',
      ],
    },
  ],

  crib: {
    idea: 'Each site sets its own pace, whatever hardware you have. Speed comes from crawling many sites at once, so the hard part is scheduling: picking the next URL without sending a site more than it allows.',
    late: 'Behind? Start the sums by 7, grow it by 18, add machines by 25. Still deep at 47? Say how you\'d run it.',
    hour: [
      {
        when: '0 to 5',
        short: 'Ask',
        title: 'Ask before you draw',
        lines: [
          'Ask whether it is one site or the whole web, how many pages, and how fresh they must be.',
          "Ask what it's for, and whether it runs once or keeps going.",
          'Agree to obey robots.txt, wait 1 second between requests to a site, and publish a contact page.',
          'Leave out JavaScript, images, logins and indexing. Say so.',
          'Give both designs a sentence: one machine with Postgres, or 20 that split the sites. Start small.',
        ],
      },
      {
        when: '5 to 8',
        short: 'Sums',
        title: 'Do the sums out loud',
        lines: [
          '{smallPages} pages at {siteRate} a second takes {smallTime}. At {fastRate} a second, if the site allows, about {fastTime}.',
          "{smallSaid} at {pageKBText} KB is {smallBytes}. {smallChecks} seen checks a second: one Postgres copes. Ask if it's a billion.",
          "One site gives at most {perSiteDay} a day, so it's scheduling.",
        ],
      },
      {
        when: '8 to 16',
        short: 'Small',
        title: 'Draw the small design',
        lines: [
          'Draw six parts: a queue, workers, a parser, a seen set, a rate limiter, a store. Go breadth-first.',
          'Tidy every URL into one spelling before the seen check.',
          'Mark a URL seen when you queue it, not when you fetch it.',
          'One table: URL (unique), status, lease until, attempts.',
          'Pages go to object storage. Everything else is in Postgres, so a restart loses nothing.',
          'It ends when the queue is empty and no worker is busy.',
        ],
      },
      {
        when: '16 to 22',
        short: 'Sites',
        title: 'Grow it to many sites',
        lines: [
          'Give each site a queue and the time of its next allowed fetch. Keep those times in a heap.',
          'Cache DNS for its TTL and robots.txt for up to a day. A 5xx on robots.txt means fetch nothing.',
          'On a 429 or 503, honour Retry-After or double the gap.',
          'Limit per IP address too: many sites can share one.',
        ],
      },
      {
        when: '22 to 30',
        short: 'Machines',
        title: 'Grow it to many machines',
        lines: [
          'First say what one machine carries: an assumed {perMachineText} pages a second, about {perMachineMonth} a month.',
          'Give each site one owner, not a shared queue with a lock per site. etcd maps 1,024 slots to owners.',
          "Each machine keeps its sites' queues (about 15 GB) and seen fingerprints (4 GB) on local disk.",
          'The URL table moves to Cassandra or ScyllaDB.',
          "Links to another machine's sites go through Kafka, keyed by site. The owner decides when to fetch.",
        ],
      },
      {
        when: '30 to 44',
        short: 'Deep dives',
        title: 'Go deeper where they ask',
        lines: [
          "If they don't steer: a worker dying, a URL found twice, the limiter, a dead machine. 3 minutes each.",
          "A dead worker's lease ends and its URL is retried. Acknowledge after saving the page and links.",
          'Retries mean at least once. The data stays right: upserts by URL, and the newer fetch time wins.',
          'Two workers find the same URL? An atomic insert keeps the first. With one owner, there is no race.',
          'Limit each site with a local timer, and shared IP addresses with a Redis token bucket.',
          'If a machine dies or stalls, others take its slots and raise the epoch, so its late writes fail.',
          'The new owner waits out the old lease, plus clock drift.',
          "It loads each slot's snapshot and replays Kafka from there.",
          'If the old machine wakes, it finds its lease gone and stops.',
          'At 42, say the scheduler is weakest and ask them to test it.',
        ],
      },
      {
        when: '44 to 49',
        short: 'Changes',
        title: 'When they change the brief (or sooner)',
        lines: [
          'Ask one question back, redraw, then say what it costs.',
          'For news within an hour, poll feeds and sitemaps and give new links top priority.',
          'Polling 1,000 sites, 10 pages each, every 5 minutes is 33 a second, about 8 per cent of 400.',
          "If sites must opt in, keep to a verified list, after redirects too. Stop if the list can't be read.",
          'With far fewer sites, one machine may be enough again.',
        ],
      },
      {
        when: '49 to 56',
        short: 'Run it',
        title: "Say how you'd run it (short answers)",
        lines: [
          'Promise zero politeness violations, counted from the fetch log. One breach wakes someone.',
          'So does fetching under half the target for 15 minutes, a slot unowned for 5, or buffers filling.',
          'One dead machine wakes nobody: the others take its sites.',
          'Ship one site, then many, then a crawl that keeps going. Add machines when measurements say so.',
          'Buy Kafka, databases and rendering. Build the scheduler.',
          'At first one team of four to six owns it all. One named person answers for politeness.',
          'On the legal side: obey robots.txt, publish a contact page, answer takedowns, never rotate proxies.',
        ],
      },
      {
        when: '56 to 60',
        short: 'Yours',
        title: 'Your questions',
        lines: [
          '“Where would you have taken this design differently?”',
          '“What should leaders here bring to design decisions?”',
        ],
      },
    ],
    numbers: [
      { figure: '{rate} a second', what: '{pages} pages a month. Build for {build} a second.' },
      { figure: '{machines} machines', what: '{build} a second, at about {perMachine} a machine.' },
      { figure: '{perSiteDay} a day', what: 'The most one site gives at {siteRate} {requests} a second.' },
      { figure: '{pageKB} KB', what: 'A page. {pagesSaid} a month is {monthBytes}, about {mbit}.' },
      { figure: '{seenChecks} a second', what: 'Seen checks, from {rate} pages a second at {links} links each.' },
      { figure: '{fingerprints}', what: '{known} URLs as 8-byte fingerprints.' },
      { figure: '1,024 slots', what: 'Sites hash into them, about {slotsEach} to a machine.' },
      { figure: '30 seconds', what: "A machine's lease on its slots, renewed every 10." },
    ],
    remember: [
      'Think out loud. If you need a moment, say what you are weighing.',
      'Say which numbers are assumptions.',
      'For each choice, say the problem it fixes, the alternative and what yours costs.',
      'Check in now and then: “Is this the level of detail you want?”',
      'Say what happens when each part fails.',
      "When asked how you'd run it, give two or three sentences, then offer to go further.",
    ],
    asked: [
      {
        about: 'About the small design',
        when: '8 to 16',
        items: [
          { q: 'Why a queue and not recursion?', a: 'Recursion is depth-first: a long chain overflows the stack, and a crash loses its place. A queue on disk avoids both and goes breadth-first.' },
          { q: 'Is Postgres enough?', a: 'Yes for a million pages, and it can be the queue too, until writes outgrow one machine.' },
          { q: 'How many workers?', a: 'Fetch rate times seconds per fetch: 10 a second at 1 second each is 10 workers. Add more while the rate rises. Stop if the site slows.' },
          { q: 'Threads or async?', a: 'Threads are simplest for 10 to 20 fetches at once. An event loop holds thousands of connections in one process, with parsing in others.' },
        ],
      },
      {
        about: 'About many sites',
        when: '16 to 22',
        items: [
          { q: 'What gets crawled first?', a: 'Seeds first, then pages that many others link to. Priority queues feed the per-site queues, so priority and pacing stay separate.' },
          { q: 'How long between requests to one site?', a: 'The largest of 1 second, its Crawl-delay and 10 times the last response time. After a fetch of 0.84 seconds, wait 8.4.' },
          { q: 'A site with endless pages, such as a calendar?', a: "Every URL really is new, so the seen check can't help. Give each site a page budget and a depth cap." },
          { q: 'The same article at fifty URLs?', a: 'Hash the body to catch exact copies. For near copies use a 64-bit SimHash: fingerprints 3 bits or fewer apart count as copies.' },
          { q: 'How do you keep pages fresh?', a: "Start with fixed tiers: news hourly, the rest monthly. Later, halve a page's interval when it changes and lengthen it when it doesn't." },
          { q: 'Pages built with JavaScript?', a: 'The first version skips them. Later, buy a sandboxed rendering service and queue them for it.' },
          { q: 'Could it be turned against your own network?', a: 'Yes. Check every resolved address against private ranges, connect to that exact address, and check again on each redirect.' },
        ],
      },
      {
        about: 'About many machines',
        when: '22 to 30',
        items: [
          { q: 'A shared queue, or one owner per site?', a: 'For a one-off crawl, a shared queue and a shared per-site limiter. For one that never stops, one owner per site, so pacing needs no lock.' },
          { q: 'Consistent hashing or a slot map?', a: "A slot map. Both move few sites, but a slot move is one explicit step with its own epoch, so the old owner's late writes fail." },
          { q: 'Why Cassandra or ScyllaDB?', a: 'Both suit small upserts by key and grow by adding machines. The table is 3 TB, 9 TB in three copies. The cost: a table per query, no joins.' },
          { q: "What if etcd can't be reached?", a: 'Machines pause, and someone is woken. Better that than two machines fetching one site.' },
        ],
      },
      {
        about: 'About the deep dives',
        when: '30 to 44',
        items: [
          { q: 'How would you build a shared rate limiter?', a: 'A Redis token bucket per IP address and domain, run by a Lua script in one step. If Redis is down, use a slow fixed rate, never unlimited.' },
          { q: 'Queues or distributed locks?', a: "A queue's lease covers one message. A lock is for a rule across messages: one fetch per site. One owner per site needs only a slot lease." },
          { q: 'One URL crashes the worker every time?', a: "Mark it dead after three attempts. Parse in a sandbox so a crash can't take the fetcher down." },
          { q: 'Why not a Bloom filter?', a: "It's 12 GB, not 80. But 1 per cent false positives silently skip up to 100 million new pages. Fingerprints wrongly skip about three." },
        ],
      },
      {
        about: 'About running it',
        when: '49 to 56',
        items: [
          { q: 'How would you know it is being rude?', a: 'Count overlapping requests, gaps that were too short, and fetches that robots.txt disallows. The target is zero.' },
          { q: 'How do you know failover works?', a: 'Run a drill: kill a real machine, time its sites coming back, and check none saw two requests at once.' },
          { q: 'What does it cost?', a: 'Storage is the cost that keeps growing: 20 TB a month compressed. People cost most, because the scheduler is custom code.' },
        ],
      },
    ],
    // The numbers he can type over as the interviewer changes them, and the sums that follow. Rates and counts are
    // rounded as they would be said, and later sums start from the rounded figure, as they would out loud.
    live: {
      inputs: [
        { id: 'pages', value: 1_000_000_000, min: 1000, max: 1e13, whole: true, label: 'Pages a month' },
        { id: 'perMachine', value: 50, min: 1, max: 100_000, label: 'Pages a second one machine fetches' },
        { id: 'siteRate', value: 1, min: 0.1, max: 10_000, label: 'Requests a second one site allows' },
        { id: 'pageKB', value: 100, min: 0.1, max: 1e6, label: 'Size of a page in KB' },
        { id: 'links', value: 50, min: 1, max: 100_000, whole: true, label: 'Links on a page' },
        { id: 'smallPages', value: 1_000_000, min: 1, max: 1e12, whole: true, label: 'Pages in the one-site crawl' },
      ],
      derive: (v) => {
        const MONTH = 2_592_000;
        const DAY = 86_400;
        const R = saidValue(v.pages / MONTH);
        const B = saidValue(R * 2.5);
        const M = Math.max(1, Math.ceil(B / v.perMachine));
        return {
          rate: commas(R),
          pagesSaid: words(v.pages),
          build: commas(B),
          machines: commas(M),
          perSiteDay: commas(Math.round(DAY * v.siteRate)),
          requests: v.siteRate === 1 ? 'request' : 'requests',
          monthBytes: size(v.pages * v.pageKB * 1000),
          mbit: bitRate((R * v.pageKB * 8) / 1000),
          seenChecks: said(R * v.links),
          known: words(v.pages * 10),
          fingerprints: size(v.pages * 10 * 8),
          slotsEach: commas(Math.max(1, Math.floor(1024 / M))),
          smallSaid: words(v.smallPages),
          smallTime: duration(v.smallPages / v.siteRate),
          fastRate: trim(v.siteRate * 10),
          smallChecks: said(v.siteRate * 10 * v.links),
          fastTime: duration(v.smallPages / (v.siteRate * 10)),
          smallBytes: size(v.smallPages * v.pageKB * 1000),
          perMachineMonth: words(v.perMachine * MONTH, 2),
          pageKBText: shown(v.pageKB),
          siteRateText: shown(v.siteRate),
          perMachineText: shown(v.perMachine),
        };
      },
    },
  },
};
