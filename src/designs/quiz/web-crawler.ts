import type { Quiz } from './types';

/**
 * The web crawler's test: 30 single-answer questions in the order the hour runs.
 *
 * Every fact comes from src/designs/web-crawler.ts or src/designs/extras/web-crawler.ts.
 * Wrong options are the page's own rejected alternatives, the answer for the other scale,
 * or a sum with one named slip in it. Points where the two sources disagree are not asked:
 * how often a slot is snapshotted (hourly, or every few minutes) and the link rate behind
 * the store's write figures. The text says "machine" for a crawler node and "site" for a
 * host, as the cheat sheet does. Ids are stored against: never rename one.
 */
export const quiz: Quiz = {
  design: 'web-crawler',
  intro:
    'Thirty questions in the order the hour runs: what to ask, the sums, the small design, then how it grows, fails and is run. Allow about 25 minutes, and say your answer out loud before you pick.',
  questions: [
    // ---- Ask first ---------------------------------------------------------------------
    {
      id: 'ask-first-question',
      stage: 'Ask first',
      kind: 'one',
      q: 'The interviewer says only: "Design a web crawler." Which question do you ask first, because it decides the shape of the design?',
      options: [
        {
          text: 'What is the crawl for: search, an archive, monitoring or training?',
          why: 'Ask it second. It changes priority and freshness, not whether this is one machine or twenty.',
        },
        {
          text: 'Does it run once, or does it keep its pages fresh from then on?',
          why: 'Ask it soon after. It adds a recrawl scheduler, but size picks the design first.',
        },
        {
          text: 'What counts as polite: robots.txt, and what rate for each site?',
          why: "You state this as a default and check it. It holds at every size, so it doesn't pick the design.",
        },
        { text: 'Is it one site or the whole web, and roughly how many pages?', right: true },
      ],
      why: 'That one question decides the design. A million pages from one site is one machine with Postgres. A billion a month is about 20 machines that split the sites between them. The other three are asked straight after it.',
      say: "One question decides the design, so I'll ask it first: is this one site or the whole web, and roughly how many pages?",
      from: '#/d/web-crawler/rehearse',
    },
    {
      id: 'ask-default-scale-and-rate',
      stage: 'Ask first',
      kind: 'one',
      q: 'The interviewer says: "You choose." Which default do you say out loud, and offer to change?',
      options: [
        { text: 'A million HTML pages from a known list of sites, at 1 request a second a site', right: true },
        {
          text: 'A billion HTML pages a month from the whole web, at 1 request a second a site',
          why: "That's the large branch. The notes start small and grow it, one requirement at a time.",
        },
        {
          text: 'A million HTML pages from a known list of sites, at 10 requests a second a site',
          why: '10 a second is what an owner may agree to. The default is 1 unless they do.',
        },
        {
          text: "A million HTML pages from a known list of sites, at each site's own Crawl-delay",
          why: "Crawl-delay isn't in the standard, so a site may give none. The default is 1 request a second.",
        },
      ],
      why: 'Start small: one site or a known list, about a million HTML pages, crawled once, at 1 request a second a site unless its owner agrees to more. The large design is the small one with each part forced to grow, so you draw the small one first.',
      say: "If you'd like me to choose, I'll start small: about a million HTML pages, and 1 request a second to each site unless its owner agrees to more.",
      from: '#/d/web-crawler/rehearse',
    },
    {
      id: 'ask-leave-out',
      stage: 'Ask first',
      kind: 'one',
      q: 'Which of these do you leave out of the first version, and say so in the first five minutes?',
      options: [
        {
          text: 'Restart after a crash, since a one-off crawl can simply be run again',
          why: 'The first version already restarts without losing its place. At 1 request a second, running again costs days.',
        },
        {
          text: 'The public contact page, since a small crawl draws few complaints',
          why: "The page that names the crawler and gives a contact ships in the first version. It's part of being polite.",
        },
        { text: 'Rendering of JavaScript, since most text is already in the HTML', right: true },
        {
          text: "The rate limiter, since one worker can't overload a site alone",
          why: 'One rate limiter is among the six parts of the small design. One worker still needs the gap.',
        },
      ],
      why: 'Leave out JavaScript, images, logins and indexing, and say so. A headless browser costs ten to a hundred times a plain fetch, and the design assumes most text is in the HTML. Politeness and restart are both in the first version.',
      say: "First version: HTML only. No rendering, no images, nothing behind a login, no indexing. Tell me if that's wrong.",
      from: '#/d/web-crawler/rehearse',
    },

    // ---- The sums ----------------------------------------------------------------------
    {
      id: 'sums-million-pages-days',
      stage: 'The sums',
      kind: 'one',
      q: 'One site, a million pages, 1 polite request a second. How long does the crawl take?',
      options: [
        {
          text: 'About 28 hours',
          why: 'That is the figure at 10 requests a second: 100,000 seconds.',
        },
        { text: 'About 11.6 days', right: true },
        {
          text: 'About 116 days',
          why: 'A factor of ten out. 1,000,000 ÷ 86,400 is 11.6.',
        },
        {
          text: 'About 278 days',
          why: 'That is hours, not days: 1,000,000 ÷ 3,600 = 278 hours.',
        },
      ],
      why: "1,000,000 pages at 1 a second is 1,000,000 seconds. A day is 86,400 seconds, and 1,000,000 ÷ 86,400 = 11.6 days. If the owner agrees to 10 a second it's 100,000 seconds, about 28 hours.",
      say: 'A million pages at 1 a second is 11.6 days, or about 28 hours at 10 a second if the owner allows it.',
      from: '#/d/web-crawler/rehearse',
    },
    {
      id: 'sums-one-site-ten-machines',
      stage: 'The sums',
      kind: 'one',
      q: "One site allows 1 request a second. You're given ten machines in place of one. What is the most pages a day you can fetch from that site?",
      options: [
        {
          text: '1,440 pages a day',
          why: 'That counts minutes: 60 × 24 = 1,440. A day has 86,400 seconds.',
        },
        {
          text: '3,600 pages a day',
          why: 'That is one hour of seconds, 60 × 60. A day is 24 of those: 86,400.',
        },
        { text: '86,400 pages a day', right: true },
        {
          text: '864,000 pages a day',
          why: 'That multiplies by the ten machines. The site still allows 1 request a second in total.',
        },
      ],
      why: "60 × 60 × 24 = 86,400 seconds in a day, so 1 request a second gives 86,400 pages. Ten machines change nothing, because the limit is the site's patience. Machines help when the crawl is wide: many sites, each at its own polite rate.",
      say: "For one site it's no faster: 86,400 pages a day whatever I own. That's why I call this a scheduling problem.",
      from: '#/d/web-crawler/q/6',
    },
    {
      id: 'sums-billion-a-month-rate',
      stage: 'The sums',
      kind: 'one',
      q: 'The brief grows to 1 billion pages a month. Take a month as 2.6 million seconds. About how many fetches a second is that, on average?',
      options: [
        { text: 'About 400 a second', right: true },
        {
          text: 'About 1,000 a second',
          why: "That's the rate the design builds for, to leave room. The average is 385, said as 400.",
        },
        {
          text: 'About 11,600 a second',
          why: 'That divides by the seconds in a day, 86,400, not the 2.6 million in a month.',
        },
        {
          text: 'About 23,000 a second',
          why: 'That divides by the minutes in a month, about 43,000, not the seconds.',
        },
      ],
      why: '1,000,000,000 ÷ 2,600,000 = 385, said as about 400 a second. The design then builds for 1,000 a second, and at about 50 pages a second a machine that is 20 machines.',
      say: "A billion pages a month is about 400 a second. I'd build for 1,000, which is 20 machines at 50 each.",
      from: '#/d/web-crawler',
    },
    {
      id: 'sums-million-pages-storage',
      stage: 'The sums',
      kind: 'one',
      q: 'A million pages at about 100 KB each. How much raw HTML is that, before compression?',
      options: [
        {
          text: 'About 100 MB',
          why: "That's the seen set: a million URLs at about 100 bytes each. A page is 100 KB.",
        },
        {
          text: 'About 10 GB',
          why: 'A factor of ten out. 1,000,000 × 100 KB is 100,000,000 KB, which is 100 GB.',
        },
        {
          text: 'About 20 GB',
          why: 'That is after compression at about 5 to 1. Raw, it is 100 GB.',
        },
        { text: 'About 100 GB', right: true },
      ],
      why: '1,000,000 × 100 KB = 100,000,000 KB = 100 GB. Compressed at about 5 to 1 it is about 20 GB. One disk holds it, which is why one machine and one Postgres carry the small crawl.',
      say: "A million pages at 100 KB is 100 GB, so one machine and one Postgres carry it. The limit is the site's patience, not my hardware.",
      from: '#/d/web-crawler/q/1',
    },

    // ---- The small design --------------------------------------------------------------
    {
      id: 'small-mark-seen-when',
      stage: 'The small design',
      kind: 'one',
      q: 'One site, one machine. At what moment do you mark a URL as seen?',
      options: [
        { text: "When it's queued, so a second link to it finds it already there", right: true },
        {
          text: "When it's fetched, so a URL whose fetch failed can be found again",
          why: "Two pages can link to it before either fetch ends, so it's queued twice. Retries come from the lease.",
        },
        {
          text: "When it's leased, so a URL still waiting isn't counted too early",
          why: 'It can be found again while it waits in the queue, and be queued a second time.',
        },
        {
          text: "When it's stored, so the seen set matches the pages really held",
          why: "Every link to it found before the save looks new. The row's status says what is stored.",
        },
      ],
      why: 'Mark it when it\'s queued. Two pages can link to the same URL before either link is fetched, and "seen means fetched" would queue it twice. In Postgres, marking seen and queueing are one statement, so a crash can\'t split them.',
      say: 'I mark a URL seen when I queue it, not when I fetch it, or two pages linking to it would queue it twice.',
      from: '#/d/web-crawler/q/1',
    },
    {
      id: 'small-postgres-seen-check',
      stage: 'The small design',
      kind: 'one',
      q: 'The queue and the seen set are one Postgres table. Two workers parse pages that link to the same new URL at the same moment. How is it queued once?',
      options: [
        {
          text: 'SELECT the URL in a transaction, then INSERT if no row came back',
          why: 'Check-then-insert as two steps is the bug. Both workers read "absent" and both insert.',
        },
        {
          text: 'SELECT ... FOR UPDATE SKIP LOCKED on the URL, then INSERT if absent',
          why: "That's how workers claim rows to fetch. For a new URL it is still check-then-insert.",
        },
        {
          text: 'SADD the URL to a Redis set, then INSERT if it reports 1 for new',
          why: 'SADD is atomic, but seen and queued are now two writes. A crash between them loses the URL.',
        },
        { text: 'INSERT ... ON CONFLICT DO NOTHING against a unique index on the URL', right: true },
      ],
      why: "It has to be one atomic add-if-absent. The unique index refuses the second insert, and the rows that go in are the new URLs. Marking seen and queueing are one statement. At 10 pages a second and 50 links a page that's 500 checks a second: a few batched inserts.",
      say: 'The seen check is one INSERT with ON CONFLICT DO NOTHING on a unique URL. A check followed by an insert is the bug.',
      from: '#/d/web-crawler/q/3',
    },
    {
      id: 'small-when-finished',
      stage: 'The small design',
      kind: 'one',
      q: 'How does the one-machine crawler decide that the crawl is finished?',
      options: [
        {
          text: 'The queue is empty on two checks made a minute apart',
          why: 'A slow fetch can outlast a fixed wait. The test is nothing queued and nothing in flight.',
        },
        { text: 'The queue is empty and no worker still holds a URL', right: true },
        {
          text: 'The queue is empty and the seen count has stopped rising',
          why: 'A worker may hold a page full of new links, so the count is about to rise again.',
        },
        {
          text: "The seen count has reached the total in the site's sitemap",
          why: 'A sitemap is a hint. It can be stale or wrong.',
        },
      ],
      why: "It's finished when the queue is empty and nothing is in flight. Checking the queue alone stops early, while a worker still holds a page full of new links.",
      say: "It's done when the queue is empty and no worker is busy. The queue alone would stop early.",
      from: '#/d/web-crawler/q/1',
    },
    {
      id: 'small-restart-loses-nothing',
      stage: 'The small design',
      kind: 'one',
      q: 'The one-machine crawler is killed halfway through and started again, and it loses nothing. What makes that true?',
      options: [
        {
          text: 'The queue is saved to object storage as a snapshot at intervals',
          why: "That's the many-machines answer, where queues live on each machine's disk. Here the table already is the state.",
        },
        {
          text: 'The queue is rebuilt at start-up by parsing the stored pages again',
          why: "Nothing needs rebuilding. Stored pages are kept so that a parser fix doesn't mean fetching again.",
        },
        { text: 'The queue, the seen marks and the leases are rows in one table', right: true },
        {
          text: 'The crawl restarts at the home page, and the seen set skips the rest',
          why: 'The home page is already marked seen, so nothing would be queued. The queue rows carry on.',
        },
      ],
      why: 'One table is the state: URL (unique), status, lease until, attempts. Pages go to object storage, with the location in the row. A URL that was out with a worker has a lease, and when that runs out it is offered again.',
      say: 'Everything except the pages is in one Postgres table, so I can stop and restart without losing my place.',
      from: '#/d/web-crawler/rehearse',
    },
    {
      id: 'small-queue-not-recursion',
      stage: 'The small design',
      kind: 'one',
      q: 'Why a queue, and not a function that fetches a page and calls itself on each link?',
      options: [
        { text: 'The gap between finding and fetching is where limits and retries live', right: true },
        {
          text: 'Breadth-first order holds fewer URLs in memory than depth-first does',
          why: "The notes say the opposite for a tree: depth-first holds less. But a site isn't a tree.",
        },
        {
          text: 'A queue ends the crawl on a site with cycles, where recursion cannot',
          why: 'The seen set is what ends the crawl, whichever order you fetch in.',
        },
        {
          text: 'A queue lets the fetch rate rise with each worker you add to the pool',
          why: 'The site sets the rate. Workers beyond rate times fetch time sit idle behind the limiter.',
        },
      ],
      why: 'The queue separates finding a URL from fetching it. That gap is where the rate limit, retries, and stopping and restarting all live. Recursion keeps its place on the call stack: a long chain overflows it, a crash loses everything, and several workers can\'t share it.',
      say: 'A queue separates finding from fetching, which gives me somewhere to limit, retry and restart. Recursion loses its place in a crash.',
      from: '#/d/web-crawler/q/2',
    },

    // ---- Many sites --------------------------------------------------------------------
    {
      id: 'sites-one-queue-breaks',
      stage: 'Many sites',
      kind: 'one',
      q: 'The brief becomes 10,000 sites, still on one machine. What do you do with the single queue and its one rate limiter?',
      options: [
        {
          text: 'Keep one queue, and take a lock for the site before each fetch',
          why: "That's a lock on every fetch and a re-queue on every miss. A queue per site needs no locks.",
        },
        { text: 'Give each site a queue and a next-allowed time, in a heap by time', right: true },
        {
          text: "Keep one queue, and have workers put back URLs whose site isn't due",
          why: 'Links cluster by site, so the next thousand URLs are often one site. Workers idle and re-queue.',
        },
        {
          text: 'Split it into queues by priority, so that good pages are served first',
          why: "Priority says what matters, not when. Those queues feed the per-site queues; they don't pace a site.",
        },
      ],
      why: 'Links cluster by site, so one queue either hammers a site or leaves every worker waiting for its turn. Give each site its own queue and next-allowed time. A heap of those times says which site is due, so one request in flight per site holds with no locks.',
      say: 'Each site gets its own queue and a next-allowed time, and a heap of those times tells me which site is due.',
      from: '#/d/web-crawler/q/7',
    },
    {
      id: 'sites-gap-after-fetch',
      stage: 'Many sites',
      kind: 'one',
      q: "A site's robots.txt asks for a Crawl-delay of 2 seconds. Its last page took 0.84 seconds to answer. How long do you wait before the next request to it?",
      options: [
        {
          text: '1 second',
          why: "That's the floor. The rule takes the largest of three figures, and two are bigger here.",
        },
        {
          text: '2 seconds',
          why: 'That honours the Crawl-delay but leaves out ten times the last response time: 8.4 seconds.',
        },
        { text: '8.4 seconds', right: true },
        {
          text: '11.4 seconds',
          why: 'That adds the three figures. The rule takes the largest, not the sum.',
        },
      ],
      why: 'The gap is the largest of 1 second, the Crawl-delay and ten times the last response time. 10 × 0.84 = 8.4 seconds, which beats 1 and 2. A slow site is treated as a busy one.',
      say: 'After each fetch I wait the largest of 1 second, the Crawl-delay and ten times the last response time.',
      from: '#/d/web-crawler/t/6',
    },
    {
      id: 'sites-robots-5xx',
      stage: 'Many sites',
      kind: 'one',
      q: "A site's cached robots.txt rules are 24 hours old, so you request the file again. It answers 503. What do you do?",
      options: [
        {
          text: 'Keep using the old rules until the file can be read again',
          why: 'Rules are cached for at most 24 hours. After that a server error means disallow everything.',
        },
        {
          text: 'Treat the site as having no rules until the file can be read',
          why: "That's the answer for a 4xx. A 5xx is a struggling site, so fetch nothing.",
        },
        {
          text: "Double the site's delay and carry on until the file can be read",
          why: 'Doubling the delay is for a page that answers 429 or 503. For robots.txt a 5xx means stop.',
        },
        { text: 'Fetch nothing from the site until the file can be read again', right: true },
      ],
      why: 'A 4xx on robots.txt means no restrictions. A 5xx or no answer means fetch nothing: an overloaded site is telling you something. The rules are cached for at most 24 hours, which is what RFC 9309 asks.',
      say: 'A 404 on robots.txt means no rules, but a 5xx means I fetch nothing from that site.',
      from: '#/d/web-crawler/q/8',
    },
    {
      id: 'sites-shared-ip-address',
      stage: 'Many sites',
      kind: 'one',
      q: 'Each site has its own queue and gap. One hosting server answers for thousands of small sites on one IP address. What does the design add?',
      options: [
        {
          text: 'Nothing, because ten times the response time already slows a busy server',
          why: 'Limits per site miss the total. Thousands of sites, each at a polite rate, still arrive together.',
        },
        { text: 'A token bucket per IP address, asked for addresses known to be busy', right: true },
        {
          text: 'A central limiter keyed by site and address, asked before each fetch',
          why: "That's a network call on every fetch and one dependency for the whole crawl. Most fetches need none.",
        },
        {
          text: 'A gap per registrable domain in place of per site, in the same heap',
          why: "A domain bucket groups one owner's names. These are different owners' domains on one address.",
        },
      ],
      why: "Thousands of sites can sit on one address, so limits per site miss the total. The design adds a token bucket per resolved address and per registrable domain. On one machine it's a map in memory; across machines it is shared, because those sites have different owners.",
      say: 'Many sites can share one IP address, so I limit per address as well as per site.',
      from: '#/d/web-crawler/q/9',
    },
    {
      id: 'sites-trap-any-shape',
      stage: 'Many sites',
      kind: 'one',
      q: 'A calendar has a "next month" link that never ends, and next week it will be some other trap. Which defence catches a trap whatever its shape?',
      options: [
        {
          text: 'The seen check on a fingerprint of each canonical URL',
          why: 'Every trap URL really is new, so the seen check passes them all.',
        },
        {
          text: 'A depth limit of 15 to 20 hops from the nearest seed',
          why: "It's one number, but it cuts off deep real content and misses wide, shallow traps.",
        },
        { text: 'A page budget per site, with a near-duplicate alarm', right: true },
        {
          text: 'A pattern rule for each URL shape known to be a trap',
          why: "It stops known offenders at once, and the design keeps it. But it's always one trap behind.",
        },
      ],
      why: "A trap makes endless new URLs, so the seen check can't catch it. A page budget stops any site taking more than its share, and keeping each site's last 64 fingerprints flags one whose new pages are nearly identical. That catches a trap by its effect, whatever its shape.",
      say: "The seen check can't help, because every URL really is new. Each site gets a page budget, and an alarm when its new pages look alike.",
      from: '#/d/web-crawler/q/19',
    },

    // ---- Many machines -----------------------------------------------------------------
    {
      id: 'machines-check-first',
      stage: 'Many machines',
      kind: 'one',
      q: 'The interviewer says: "Now run it on many machines." What do you say first?',
      options: [
        { text: 'That one machine carries about 50 pages a second, 130 million a month', right: true },
        {
          text: 'That sites will hash into 1,024 slots, about 51 slots to a machine',
          why: "That's the design once you need it. First show that one machine really isn't enough.",
        },
        {
          text: 'That a log keyed by site will carry about 4,000 messages a second',
          why: "True at full size, but you'd be building the cluster before checking that you need one.",
        },
        {
          text: 'That 10 billion rows go to Cassandra, at 9 TB with three copies',
          why: 'The table moves when it outgrows one machine. Say what one machine carries before sizing that.',
        },
      ],
      why: 'First check that you need more. One machine at an assumed 50 pages a second fetches 4.3 million pages a day, about 130 million a month, so millions fit on one. Many machines is the costly phase: state on every machine, and three new services to run.',
      say: "Before I add machines: one carries about 50 pages a second, 130 million a month, so I'd check we've really outgrown it.",
      from: '#/d/web-crawler/q/10',
    },
    {
      id: 'machines-where-politeness-lives',
      stage: 'Many machines',
      kind: 'one',
      q: 'Twenty machines, and a crawl that runs for ever. Where is "one request in flight per site" enforced?',
      options: [
        {
          text: "In a shared limiter, where each worker takes the site's lock before a fetch",
          why: "It works, and suits a one-off crawl. But it's a network call on every fetch.",
        },
        {
          text: 'In the log, where Kafka keys by site and one consumer reads each in order',
          why: "Order per site isn't a gap between requests. A log can't delay one site while serving another.",
        },
        {
          text: 'In a central scheduler, where one service hands every worker its next URL',
          why: 'Politeness is decided in one place, but it has to shard anyway, and every fetcher depends on it.',
        },
        { text: "In the owner, where one machine holds each site's queue and its timer", right: true },
      ],
      why: 'Give each site one owner. Its queue, timer, robots rules and seen URLs live on that machine, so pacing and duplicate checks are local and need no lock. The price is state on every machine, a map of who owns what, and recovery when a machine dies.',
      say: 'For a crawl that runs for ever I give each site one owner, so pacing needs no lock. For a one-off crawl a shared queue would do.',
      from: '#/d/web-crawler/q/10',
    },
    {
      id: 'machines-slot-map-not-ring',
      stage: 'Many machines',
      kind: 'one',
      q: 'Why does the design map sites to machines with 1,024 fixed slots and a coordinator, and not a consistent hash ring?',
      options: [
        {
          text: 'A ring moves most sites when a machine joins, and slots move about 51',
          why: "That's hash mod N. A ring also moves only about 1 site in N when a machine joins.",
        },
        { text: 'A slot move is one explicit step with an epoch, which fences a paused owner', right: true },
        {
          text: 'A ring needs a coordinator to hold its map, and a slot map needs none',
          why: "It's the other way round. A ring has no map to store, and the slot map needs etcd.",
        },
        {
          text: 'A slot is a Kafka partition, so consumer groups can assign the owners',
          why: 'The design turns that down: in a rebalance two consumers can briefly hold one partition.',
        },
      ],
      why: "Both move few sites. The difference is that each slot move is an explicit step with an epoch number, so an old owner's late writes are refused. On a ring a paused machine that wakes is not fenced. The cost is a consensus cluster such as etcd to run.",
      say: "I'd use 1,024 fixed slots mapped by etcd, not a ring, because each slot move carries an epoch that fences the old owner.",
      from: '#/d/web-crawler/q/14',
    },
    {
      id: 'machines-what-is-still-shared',
      stage: 'Many machines',
      kind: 'one',
      q: 'With one owner per site, which of these checks still crosses the network to a store that all the machines share?',
      options: [
        {
          text: 'The seen-URL check for a link to one of its own sites',
          why: 'The owner keeps about 500 million fingerprints, 4 GB, on its own disk.',
        },
        {
          text: 'The parsed robots.txt rules for one of its own sites',
          why: "Parsed rules sit in the owner's memory for at most 24 hours.",
        },
        { text: 'The token bucket for an IP address that many sites share', right: true },
        {
          text: 'The next-allowed time on the heap for one of its own sites',
          why: "It's a value in the owner's own heap. That is the point of one owner per site.",
        },
      ],
      why: "The seen check and the timer stay local to the owner. An address that serves many sites is different: those sites have different owners, so its bucket has to be shared, in Redis. It's the one place this design needs a distributed limiter.",
      say: 'The seen check and the timer stay local to the owner. I keep a shared limiter only for IP addresses that serve many sites.',
      from: '#/d/web-crawler/t/5',
    },
    {
      id: 'machines-link-to-another-owner',
      stage: 'Many machines',
      kind: 'one',
      q: 'A machine parses a page and finds a link to a site that another machine owns. How does the link reach its owner?',
      options: [
        { text: 'Through Kafka keyed by site, which the owner reads at its own pace', right: true },
        {
          text: "Through a direct call to the owner, which answers once it's queued",
          why: 'No broker to run, but retries, buffering and back-pressure become your problem.',
        },
        {
          text: "Through the URL table, which each owner polls for its sites' new rows",
          why: 'That turns traffic between machines into a polling load on the busiest store.',
        },
        {
          text: 'Through a managed queue service, which each owner polls for links',
          why: "With no keyed partitions it can't keep a site on one owner without a queue per site.",
        },
      ],
      why: "Links for other owners travel through a log keyed by site, so all links for one site reach its one owner, in order. Kafka gives buffering and replay from a saved offset. It can't delay one message, so it carries URLs and the owner decides when to fetch.",
      say: "Links to another machine's sites go through Kafka, keyed by site. Kafka carries them; the owner decides when to fetch.",
      from: '#/d/web-crawler/t/9',
    },

    // ---- Deep dives --------------------------------------------------------------------
    {
      id: 'deep-worker-dies-mid-fetch',
      stage: 'Deep dives',
      kind: 'one',
      q: 'A worker fetches a page and dies before saving it. What brings that URL back?',
      options: [
        {
          text: 'A heartbeat from the worker stops, and a monitor queues the URL again',
          why: 'Nobody has to detect the death. A dead worker and a slow one look the same; the deadline settles it.',
        },
        { text: "The lease's deadline passes, and the URL, still queued, is offered again", right: true },
        {
          text: 'The recrawl scheduler finds the URL overdue, and sends it round again',
          why: 'Recrawl brings back pages due a revisit. A hand-out that was not completed is recovered by its lease.',
        },
        {
          text: 'The dead-letter list takes the failed URL, and it is retried from there',
          why: 'A URL is marked dead after three failures and then retried rarely. One lost fetch is offered again.',
        },
      ],
      why: "Every hand-out is a lease with a deadline, and the URL stays in the durable queue until the worker reports it complete. If the worker dies, nothing completes it, the deadline passes and it's offered again. Acknowledge after the page is stored and its links are queued, not before.",
      say: "The URL was lent with a deadline, so when the lease runs out it's handed out again. I acknowledge after saving, not before.",
      from: '#/d/web-crawler/t/3',
    },
    {
      id: 'deep-fetched-twice-safe',
      stage: 'Deep dives',
      kind: 'one',
      q: "A lease ran out on a slow worker, so the page was fetched and parsed twice, and the slow worker's result is written last. What keeps the URL's row right?",
      options: [
        {
          text: 'A transaction across fetch, store and enqueue, so the second one aborts',
          why: "Exactly-once would need a transaction that includes someone else's web server.",
        },
        {
          text: "A lock on the URL's row with an expiry, so the slower write is held off",
          why: 'A lock with an expiry has the same hole: the slow worker wakes believing it still holds it.',
        },
        {
          text: "The slot's epoch on every write, so the stores turn the slower one away",
          why: 'The epoch rises when a slot changes owner. Both workers are on one machine, so both carry the same one.',
        },
        { text: 'An upsert by URL stamped with the fetch time, so the older result loses', right: true },
      ],
      why: "It's at-least-once: a fetch can happen twice but is not lost. Repeats are harmless because every write is keyed. The outcome is an upsert by URL stamped with the fetch time, so a late write of an older result loses, and links from the second parse are dropped by the seen check.",
      say: "It's at-least-once. A repeat is harmless because writes are upserts by URL stamped with the fetch time, and the seen check drops the links.",
      from: '#/d/web-crawler/q/16',
    },
    {
      id: 'deep-new-owner-first-fetch',
      stage: 'Deep dives',
      kind: 'one',
      q: 'A machine stalls and its 30-second lease on its slots lapses. Another machine is given them at a higher epoch. What must the new owner wait for before its first fetch?',
      options: [
        { text: 'The old lease to be over in full, plus a margin for clock drift', right: true },
        {
          text: 'The stores to see the new epoch, so that old writes are refused',
          why: "That fences writes to your own stores. A stranger's web server can't check an epoch.",
        },
        {
          text: 'The snapshot to load, and Kafka to replay from the saved offset',
          why: "That tells it what to fetch. It doesn't prove the old owner has stopped fetching.",
        },
        {
          text: 'The coordinator to confirm that the old machine has stopped',
          why: "A stalled machine can't answer, and looks the same as a dead one. Hence a lease with a deadline.",
        },
      ],
      why: "The epoch protects your own stores: anything stamped with the old one is turned away. A web server can't check an epoch, and the two clocks may disagree about when the lease ended. So the new owner waits out the full lease plus a margin for clock drift before it fetches.",
      say: "A web server can't check my epoch, so the new owner waits out the old lease plus clock drift before it fetches.",
      from: '#/d/web-crawler/t/14',
    },
    {
      id: 'deep-bloom-one-per-cent',
      stage: 'Deep dives',
      kind: 'one',
      q: '10 billion known URLs. A Bloom filter at 1 per cent false positives takes 12 GB; 8-byte fingerprints take 80 GB. What does that 1 per cent cost the crawl?',
      options: [
        {
          text: 'Up to 100 million pages fetched twice, at one extra visit to a site each',
          why: 'A false positive says "seen" for a new URL. That page is skipped, not fetched twice.',
        },
        {
          text: 'Up to 100 million extra disk reads, each to confirm a "probably seen"',
          why: "That's a Bloom filter in front of an exact set. As the seen set itself, nothing confirms its answer.",
        },
        { text: 'Up to 100 million new pages skipped for good, with nothing to report it', right: true },
        {
          text: 'About three new pages skipped for good, until the filter is next rebuilt',
          why: "Three is the fingerprints' collision count. 1 per cent of 10 billion is up to 100 million.",
        },
      ],
      why: '1 per cent of 10 billion is 100 million. Each false positive is a new URL called "seen", so the page is not crawled, and the same URL gives the same wrong answer every time. Fingerprints cost 80 GB of disk, about 4 GB a machine, with about three collisions.',
      say: "A Bloom filter's false positive isn't a retry, it's a page I don't crawl at all, so I keep 64-bit fingerprints: 80 GB, about three collisions.",
      from: '#/d/web-crawler/t/10',
    },
    {
      id: 'deep-limiter-redis-down',
      stage: 'Deep dives',
      kind: 'one',
      q: "The shared limiter is a token bucket per IP address in Redis. Redis can't be reached. What do the fetchers do for those addresses?",
      options: [
        {
          text: "Rely on each site's own gap, which its owner still enforces locally",
          why: "Gaps per site can't see the total on a shared address. That's what the bucket was for.",
        },
        {
          text: 'Stop fetching from those addresses altogether until Redis is back',
          why: 'Failing closed is the rule for ownership and the opt-in list. This limiter slows to a fixed rate.',
        },
        {
          text: "Run the same bucket from a local copy on each machine until it's back",
          why: "Those sites have different owners, so twenty local copies add up past the address's limit.",
        },
        { text: 'Drop to a slow fixed rate for those addresses until Redis is back', right: true },
      ],
      why: "For politeness, fail safe: fetchers use a slow fixed rate for those addresses, so a failed limiter makes the crawl slower, not faster. Most fetches don't call Redis at all, because each site's own limit is a local timer on its owner.",
      say: 'If Redis is down the fetchers drop to a slow fixed rate for those addresses. A failed limiter slows the crawl; it must not speed it up.',
      from: '#/d/web-crawler/q/13',
    },

    // ---- Change of brief and running it --------------------------------------------------
    {
      id: 'change-news-polling-rate',
      stage: 'Change of brief and running it',
      kind: 'one',
      q: 'The brief changes: news must be stored within the hour. You poll 10 hub pages on each of 1,000 news sites every 5 minutes. How many fetches a second is that?',
      options: [
        {
          text: 'About 3 a second',
          why: 'That divides by the hour in the brief, 3,600 seconds. A round is 5 minutes: 300 seconds.',
        },
        { text: 'About 33 a second', right: true },
        {
          text: 'About 167 a second',
          why: 'That divides by 60, as if a round were one minute. Five minutes is 300 seconds.',
        },
        {
          text: 'About 2,000 a second',
          why: 'That divides by 5 and leaves the minutes as they are. Five minutes is 300 seconds.',
        },
      ],
      why: "1,000 sites × 10 pages = 10,000 fetches a round, and a round is 300 seconds: 10,000 ÷ 300 = 33 a second. That's about 8 per cent of 400, mostly 304s. Each site sees one request every 30 seconds, well inside its polite rate.",
      say: 'Polling 1,000 sites, 10 pages each, every 5 minutes is 33 fetches a second, about 8 per cent of my budget.',
      from: '#/d/web-crawler/q/25',
    },
    {
      id: 'change-opt-in-registry-unreadable',
      stage: 'Change of brief and running it',
      kind: 'one',
      q: "The brief changes: crawl only sites that have opted in. One night the registry of opted-in sites can't be read. What does the crawler do?",
      options: [
        {
          text: 'Carry on from its last copy of the registry until it can be read',
          why: "The last copy can't show an opt-out, which must take effect within minutes. The notes fail closed.",
        },
        {
          text: 'Carry on with sites already in its queues, and admit no new ones',
          why: 'A queued site may have opted out since. With no list there is no permission.',
        },
        { text: 'Fetch nothing from any site until the registry can be read again', right: true },
        {
          text: "Fall back to each site's robots.txt until the registry can be read",
          why: "That's the old default: allowed unless robots.txt says no. Opt-in means forbidden unless the owner said yes.",
        },
      ],
      why: 'Opt-in flips the default from "allowed unless robots.txt says no" to "forbidden unless the owner said yes". So it fails closed: if the registry can\'t be read, fetch nothing. Opting out takes effect within minutes, and robots.txt still applies on top.',
      say: "Opt-in flips the default to forbidden unless the owner said yes: a verified list, checked after redirects, and I stop if I can't read it.",
      from: '#/d/web-crawler/q/26',
    },
    {
      id: 'run-what-wakes-someone',
      stage: 'Change of brief and running it',
      kind: 'one',
      q: "It's 3 in the morning. Which of these wakes the person on call?",
      options: [
        {
          text: 'A crawler machine dies, and its slots move to the others',
          why: 'A dead machine should not need a person. The lease, the snapshot and the replay cover it.',
        },
        { text: 'Two requests to one site overlap, the first time this week', right: true },
        {
          text: 'Repeat fetches rise above 1 per cent of all fetches',
          why: "That's on the morning list, with paused sites, dead URLs and parser quarantines.",
        },
        {
          text: 'Lag builds on one partition of the log between machines',
          why: "That's on the morning list. The log buffers, so lag is a backlog to look at, not a breach.",
        },
      ],
      why: 'Any politeness violation is a page: the site is paused first, with questions after. The other pages are a slot with no owner for over 5 minutes or etcd without a quorum, fetching under half the target for 15 minutes, and store writes failing with buffers over half full.',
      say: 'I promise zero politeness violations, so one breach wakes someone. One dead machine wakes nobody, because the others take its sites.',
      from: '#/d/web-crawler/rehearse',
    },
  ],
};
