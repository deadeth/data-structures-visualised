import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'The frontier is the part of a web crawler that decides which URL is fetched next. It has to answer two questions at once: which URL matters most, and which host may be contacted right now. This design, from the Mercator crawler, splits them. Front queues order URLs by priority. Back queues hold one host each, and a min-heap of "next allowed time" picks the back queue to serve, so no host is ever asked twice inside its delay.',
  watch: [
    'Add reads only the priority. The URL waits in a front queue and nothing else is touched: one write, no comparisons.',
    'Next looks at one thing: the root of the heap. One comparison of its time with the clock says whether anything at all is due.',
    'When the root is not due, nothing is handed out, even if hundreds of URLs are waiting. That refusal is the politeness.',
    'After a lease the host gets a new time, clock + delay, and its queue goes back into the heap behind the hosts that are due sooner. That is why hosts take turns.',
    'A back queue that runs empty pulls from the front queues, highest priority first. Each pulled URL is looked up in the host table: a known host sends it to that host\'s queue, an unknown host takes over the empty queue.',
    'A host that gives up its queue keeps its time in the table. Watch the ready column: if the host comes back, it does not get a free early request.',
    'This page has 3 back queues, 4 slots in each queue and 5 hosts so that everything stays readable. It also uses one fixed delay for every host.',
  ],
  complexity: [
    { op: 'Add a URL', average: 'O(1)', worst: 'O(1)', note: 'One append to a front queue. The host is not looked at.' },
    { op: 'Is anything due?', average: 'O(1)', worst: 'O(1)', note: 'Compare the root of the heap with the clock.' },
    { op: 'Next (lease a URL)', average: 'O(log B)', worst: 'O(log B)', note: 'B is the number of back queues. One pop and one push on the heap, plus one dequeue. With 3 back queues that is at most 2 heap comparisons.' },
    { op: 'Refill an empty back queue', average: 'O(1) per URL moved', worst: 'O(front size)', note: 'Each URL crosses from front to back once in its life, with one table lookup. One refill can move many URLs if they all belong to hosts that already have a queue.' },
    { op: 'One FIFO queue plus a politeness check', average: 'O(n)', worst: 'O(n)', note: 'For contrast. The head is often not due, so you scan or re-queue until you find a URL that is.' },
  ],
  space:
    'O(n) for the URLs, plus one table row per host and one heap entry per back queue. At scale the URLs dominate: the crawler design on this site keeps about 2 billion of them, roughly 300 GB, so most of each queue lives on disk and only the two ends are held in memory.',
  usedIn: [
    {
      name: 'Mercator',
      how: 'The crawler from Compaq SRC, by Allan Heydon and Marc Najork. Their 1999 paper used one FIFO sub-queue per worker thread, chosen by host name. The front queue, back queue and heap design drawn here is the refinement described in their later work and in the textbook by Manning, Raghavan and Schütze. Its rule of thumb is about three back queues for every fetcher thread.',
    },
    {
      name: 'Heritrix',
      how: 'The Internet Archive\'s crawler. Its BdbFrontier keeps one queue per host in BerkeleyDB on disk. After each fetch the host waits a multiple of the time that fetch took, between a set minimum and maximum.',
    },
    {
      name: 'Apache Nutch',
      how: 'The fetcher keeps one queue per host (or per IP address) and waits fetcher.server.delay, 5 seconds by default, between two requests to the same one.',
    },
    {
      name: 'Scrapy',
      how: 'Requests wait in priority queues in the scheduler. The downloader then holds one slot per domain and enforces DOWNLOAD_DELAY on each, and AutoThrottle adjusts that delay from the response times it sees.',
    },
    {
      name: 'URL Frontier (crawler-commons)',
      how: 'A frontier as a separate service with a gRPC API, used with StormCrawler. Its default implementation stores a queue per host in RocksDB, so the frontier survives a restart.',
    },
    {
      name: 'The web crawler design on this site',
      how: 'Its central component. Each crawler node owns a share of the hosts and runs this structure for them, handing URLs to fetchers as leases with a deadline.',
    },
  ],
  reachFor: [
    'Many items compete for attention, but each belongs to a key that must be rate limited on its own: hosts for a crawler, tenants for a job scheduler, recipients for a notification sender.',
    'You need "at most one request in flight per key" to hold by construction, without a lock per key.',
    'Priority and fairness pull in different directions and you want one place that settles both.',
    'The question "what is due next?" has to be cheap however many keys are waiting. The heap answers it with one comparison.',
  ],
  costs: [
    'One FIFO queue is simpler and fails at once. Links cluster by host, so the next thousand URLs are often one site: you either hammer it or stall every fetcher behind it. A single queue also ignores priority.',
    'It is stateful, custom code. Queues, table and heap must be saved and restored together. In practice the queues live on disk (BerkeleyDB in Heritrix, RocksDB in URL Frontier) with a snapshot or a log to rebuild from.',
    'Priority only acts in the front queues. Once a URL is in a back queue it waits its turn behind its own host, and a new host waits until some back queue runs empty. Too few back queues and fetchers sit idle while the front queues are full.',
    'Always taking the highest front queue first, as this page does, can starve low priority for ever. Mercator picks a front queue at random with a bias towards high priority.',
    'This page puts a queue back in the heap at the moment of the lease, with clock + delay. Mercator puts it back when the fetch has finished, and waits about ten times as long as that fetch took, so a slow server is automatically asked less often.',
    'A managed queue is tempting and limited. With Amazon SQS you can send a URL back with a delay when its host is not due, but the delay is at most 15 minutes, FIFO queues do not allow a delay per message, there is no order by priority, and "when was this host last contacted" has to live in another store. Every miss costs a receive and a send. One queue per host does not scale to millions of hosts either, because each queue has to be polled.',
    'Leases are not modelled here. A real frontier gives each lease a deadline and puts the URL back if the fetcher dies.',
  ],
  interview: [
    'Start with why a plain queue fails: "URLs arrive in bursts from one site, so a FIFO queue either hammers that site or blocks on it. And it has no idea of priority. The frontier is a scheduler, not a queue."',
    'Then give the shape in one breath: "Front queues by priority, back queues with one host each, a table from host to back queue, and a min-heap keyed on the next time each host may be contacted. A fetcher pops the heap, waits if needed, takes the head of that queue, and pushes the queue back with a new time."',
    'Say what politeness means in numbers: one request in flight per host, and a gap between requests. A common rule is the largest of a floor such as 1 second, the Crawl-delay in robots.txt, and about ten times the last response time. At 1 request a second that is 86,400 pages a day from any one site, whatever the size of your fleet.',
    'Know the sizing rule: about three back queues per fetcher thread. Fewer and threads wait on hosts that are not due. The heap is tiny, so Next costs O(log B) for B back queues, not O(log n) for n URLs.',
    'Durability: "Billions of URLs do not fit in memory, so the queues are on disk with only their heads and tails cached. I would keep them in an embedded store such as RocksDB, snapshot it, and replay a log of discovered URLs after a crash."',
    'Distribution: "Hash the host to a node, so every URL for a host lands on one node and politeness stays a local decision with no network call." Then name the gap: many hosts can share one IP address and land on different nodes, so busy addresses need a shared rate limit as well.',
    'Hand-outs are leases with a deadline, so fetching is at-least-once. If a fetcher dies the URL returns to its queue. Say that this means a page can be fetched twice and the stages after it must cope.',
    'If asked "why not just use SQS or Kafka?": they are good pipes between stages, but neither can hold one host back while serving another, or reorder by priority. You end up rebuilding the frontier around them with a lock per host and constant re-queueing.',
    'A detail that shows you have thought it through: when a host gives up its back queue, keep its next allowed time. Otherwise it can come straight back through another queue and be contacted early.',
  ],
};
