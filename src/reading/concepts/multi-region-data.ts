import type { Concept } from '../types';

const page: Concept = {
  id: 'multi-region-data',
  title: 'Multi-region data',
  group: 'Data',
  summary:
    "Running data in more than one region: why you'd do it, what the speed of light charges you, and the five patterns from 'one region with backups' to a globally consistent database. Includes failover, conflicts and a decision table by product type.",
  minutes: 14,
  sections: [
    {
      id: 'why',
      title: 'Why go multi-region',
      blocks: [
        {
          p: "There are three reasons, and they pull the design in different directions. Say which one you're solving before you draw anything.",
        },
        {
          table: {
            head: ['Reason', 'What it asks for', 'What it does not need'],
            rows: [
              ['Latency', 'Data near the user who reads it', 'Every region holding every row'],
              ['Availability', 'A second region that can take over when the first is lost', 'Both regions taking writes at once'],
              ['Data residency', "A customer's data stored and processed in a named jurisdiction", 'Speed. This is a legal constraint, and it forbids some copies'],
            ],
          },
          caption: 'Three reasons, three different designs. Residency is the odd one out: it limits where copies may go, which works against the other two.',
        },
        {
          p: "Availability is the one to be careful with. Three availability zones inside one region already survive the loss of a data centre, with synchronous replication and round trips of a millisecond or two. A second region protects against the loss of a whole region, which is rare, and against region-wide control-plane faults, which are less rare. It costs roughly double, plus the engineering below. Many products should stop at three zones and good backups.",
        },
        {
          p: "Residency matters in UK and EU fintech. A regulator, a banking partner or a contract may require UK customers' data to stay in the UK and EU customers' data in the EU. The UK is not in the EU, so 'London plus Frankfurt' may be two jurisdictions, not one. What exactly is allowed is a question for legal and compliance; the design has to make the answer enforceable, which means knowing where every copy of every row lives, backups and logs included.",
        },
        {
          callout:
            "'Which are we solving: latency for users far away, surviving a region outage, or keeping data in a jurisdiction? If it's only availability, I'd start with three zones in one region and tested backups in a second, and I'd want a reason to go further.'",
          kind: 'interview',
        },
      ],
    },
    {
      id: 'physics',
      title: 'The physics',
      blocks: [
        {
          p: "Light in fibre covers about 200 km per millisecond, and cables don't run straight. So a round trip costs at least 1 ms per 100 km, and more in practice. No protocol gets under that. Every synchronous step between regions pays it in full.",
        },
        {
          diagram: {
            w: 600,
            h: 350,
            nodes: [
              { id: 'lon', label: 'London', x: 230, y: 150, tone: 'follow' },
              { id: 'fra', label: 'Frankfurt', sub: '~650 km', x: 440, y: 20 },
              { id: 'iad', label: 'N. Virginia', sub: '~5,900 km', x: 20, y: 20 },
              { id: 'sin', label: 'Singapore', sub: '~10,900 km', x: 230, y: 280 },
            ],
            edges: [
              { from: 'lon', to: 'fra', label: '~15 ms', both: true },
              { from: 'lon', to: 'iad', label: '~75 ms', both: true },
              { from: 'lon', to: 'sin', label: '~170 ms', both: true },
            ],
          },
          caption:
            'Approximate network round-trip times from London between cloud regions. Treat them as orders of magnitude: the real figures vary by provider, route and hour. Frankfurt is close enough to wait for on every write. Singapore is not.',
        },
        {
          p: "Now multiply. A request handler that makes five sequential database calls to a primary 75 ms away spends 375 ms on the network alone. A TLS handshake to a far region costs two or three round trips before the first byte. This is why 'put the application in every region and leave the database in one' disappoints: the chatty part of the path is the part you left behind.",
        },
        {
          callout:
            "Count round trips, not distance. One cross-region call per request is usually affordable. One per query is not. If a region can't answer from local data, send the whole request to the region that can.",
          kind: 'rule',
        },
      ],
    },
    {
      id: 'single-and-passive',
      title: 'One writer: backups, then a standby region',
      blocks: [
        {
          p: "Two terms first. **RPO** (recovery point objective) is how much data you may lose, measured in time. **RTO** (recovery time objective) is how long you may be down. Every pattern on this page is a different price for a pair of those numbers.",
        },
        { h: 'Single region with backups elsewhere' },
        {
          diagram: {
            w: 620,
            h: 220,
            groups: [{ label: 'London, three zones', x: 10, y: 10, w: 380, h: 200 }],
            nodes: [
              { id: 'pri', label: 'Primary', sub: 'zone a', x: 30, y: 80, kind: 'store', tone: 'ok' },
              { id: 'sby', label: 'Standby', sub: 'zone b, synchronous', x: 220, y: 80, w: 150, kind: 'store' },
              { id: 'bak', label: 'Object store', sub: 'another region', x: 470, y: 80, kind: 'store' },
            ],
            edges: [
              { from: 'pri', to: 'sby', label: 'sync' },
              { from: 'sby', to: 'bak', label: 'WAL', dashed: true },
            ],
          },
          caption:
            "The baseline. Losing a zone loses nothing: the standby has every commit. Losing the region means restoring from backups and shipped log elsewhere: RPO of minutes, RTO of hours. For many products that's an acceptable answer to a very rare event.",
        },
        {
          p: "The costs are low and so are the promises. The one thing that makes it real is restoring from the backup on a schedule. A backup nobody has restored is a hope, not a recovery plan.",
        },
        { h: 'Active-passive with an asynchronous replica' },
        {
          diagram: {
            w: 600,
            h: 340,
            groups: [
              { label: 'London (active)', x: 10, y: 10, w: 270, h: 320 },
              { label: 'Frankfurt (passive)', x: 320, y: 10, w: 270, h: 320 },
            ],
            nodes: [
              { id: 'appL', label: 'Services', sub: 'serving traffic', x: 75, y: 60 },
              { id: 'dbL', label: 'Primary', sub: 'all writes', x: 75, y: 230, kind: 'store', tone: 'ok' },
              { id: 'appF', label: 'Services', sub: 'idle or scaled down', x: 385, y: 60, tone: 'muted' },
              { id: 'dbF', label: 'Replica', sub: 'a little behind', x: 385, y: 230, kind: 'store' },
            ],
            edges: [
              { from: 'appL', to: 'dbL', label: 'writes' },
              { from: 'dbL', to: 'dbF', label: 'async log', dashed: true },
            ],
          },
          caption:
            'Active-passive. London commits without waiting for Frankfurt, so writes stay fast. Whatever is in the dashed line when London dies is lost: that gap is the RPO, and it is greater than zero.',
        },
        {
          p: "This is the most common multi-region setup because it changes the application least. Writes commit locally in a few milliseconds. The replica is normally under a second behind, but lag grows under heavy write load, and the worst moment for lag is the kind of overload that precedes a failure.",
        },
        {
          p: "What breaks is the failover itself. Promote the replica and you accept losing the unreplicated tail. Worse, if the old primary is still alive and still taking writes from some clients, you have two primaries and two diverging histories: split brain. So the steps have an order, and the first real action is fencing the old primary.",
        },
        {
          sequence: {
            actors: ['Monitor', 'On-call', 'Router', 'London primary', 'Frankfurt replica'],
            messages: [
              { from: 'Monitor', to: 'London primary', label: 'health check fails, 3 in a row', tone: 'bad' },
              { from: 'Monitor', to: 'On-call', label: 'page: London unreachable' },
              { from: 'On-call', to: 'Frankfurt replica', label: 'how far behind? last position', tone: 'compare', note: 'this is the data you will lose' },
              { from: 'On-call', to: 'Router', label: 'fence: no writes to London', note: 'before promoting, always' },
              { from: 'On-call', to: 'Frankfurt replica', label: 'promote to primary', tone: 'ok' },
              { from: 'On-call', to: 'Router', label: 'send traffic to Frankfurt' },
              { from: 'Router', to: 'Frankfurt replica', label: 'writes resume', tone: 'ok' },
              { from: 'On-call', to: 'London primary', label: 'later: rebuild as a replica', dashed: true, note: 'reconcile its unshipped tail by hand' },
            ],
          },
          caption:
            "A cross-region failover. Notice the order: measure the loss, fence the old primary, then promote. Promoting first risks two primaries. The old primary's unshipped writes don't vanish; someone has to reconcile them when London returns.",
        },
        {
          p: "Who decides? Inside a region, automate it: a consensus-backed manager promotes a synchronous standby in seconds and loses nothing. Across regions with asynchronous replication, most teams keep a human in the decision, because a false alarm costs real data and a monitor in one region can't tell 'London is down' from 'my link to London is down'. Automate every step after the decision so that it takes one command, not forty minutes of runbook.",
        },
        {
          see: [
            { href: '#/s/leader-replication', label: 'Leader replication', why: "Synchronous and asynchronous acknowledgement, and the write that's lost when the leader dies first." },
            { href: '#/s/raft', label: 'Raft', why: 'How a majority elects one leader, which is what makes automatic failover safe.' },
          ],
        },
      ],
    },
    {
      id: 'region-pinned',
      title: 'Active-active with region-pinned data',
      blocks: [
        {
          p: "Every region serves traffic and takes writes, but each customer has exactly one **home region**, and only that region writes their data. There are many writers in the system and one writer per row. That removes conflicts entirely, gives local latency to most users, and answers residency directly: a UK customer's rows exist only in the UK.",
        },
        {
          diagram: {
            w: 600,
            h: 400,
            groups: [
              { label: 'UK region', x: 10, y: 130, w: 270, h: 260 },
              { label: 'EU region', x: 320, y: 130, w: 270, h: 260 },
            ],
            nodes: [
              { id: 'router', label: 'Global router', sub: 'finds home region', x: 30, y: 10, w: 160 },
              { id: 'dir', label: 'Directory', sub: 'customer → region', x: 410, y: 10, w: 160, kind: 'store', tone: 'compare' },
              { id: 'svcUK', label: 'Services', x: 75, y: 170 },
              { id: 'dbUK', label: 'Database', sub: 'UK customers only', x: 75, y: 310, kind: 'store', tone: 'ok' },
              { id: 'svcEU', label: 'Services', x: 385, y: 170 },
              { id: 'dbEU', label: 'Database', sub: 'EU customers only', x: 385, y: 310, kind: 'store' },
            ],
            edges: [
              { from: 'router', to: 'dir', label: 'customer 42?', tone: 'compare' },
              { from: 'router', to: 'svcUK', label: 'customer 42', tone: 'follow' },
              { from: 'router', to: 'svcEU' },
              { from: 'svcUK', to: 'dbUK', label: 'reads, writes', tone: 'follow' },
              { from: 'svcEU', to: 'dbEU' },
            ],
          },
          caption:
            'Region-pinned data. The router looks up the home region of customer 42 and sends the whole request there. Nothing replicates between the two databases, so there is nothing to conflict. Each database is still replicated across zones inside its own region.',
        },
        {
          p: "Routing needs the customer before it can route. After login, put the home region in the token or the hostname so the edge can route without a lookup. Before login, a small global directory maps a login identifier to a region. That directory is the one piece of global data, so keep it tiny, mostly read, and free of anything residency forbids (a hashed identifier and a region code).",
        },
        {
          p: "The costs show up at the edges of the model. A payment from a UK customer to an EU customer touches two regions: treat it as two local transactions joined by messaging, exactly as you would [across shards](#/c/sharding-and-partitioning). Global tables such as currencies and product configuration get replicated everywhere, read-only. A report across all customers has to run on a separate analytics copy, if residency allows one. And a region outage takes its own customers down unless each region also has a standby, so this pattern is usually stacked on top of the previous one.",
        },
        {
          h: 'Moving a customer',
        },
        {
          p: "A customer relocates, or you open a new region. The move is a small online migration: mark the customer as moving so writes pause or queue for a few seconds, copy their rows, verify counts and checksums, flip the directory entry, then delete from the old region after a holding period. Keep it per-customer and reversible. This is the same double-write-or-pause, backfill, verify, cut-over shape as a reshard.",
        },
        {
          callout:
            "'For a UK and EU fintech I'd pin each customer to a home region. It gives one writer per row, so no conflicts, and residency is a property of the layout, not a promise in the code. Cross-region payments become two local transactions and a message. Each region gets its own standby for availability.'",
          kind: 'interview',
        },
      ],
    },
    {
      id: 'multi-writer',
      title: 'Active-active with multiple writers',
      blocks: [
        {
          p: "Here any region accepts a write to any row and replicates it to the others afterwards. Writes are local and fast everywhere, and a region can vanish without anyone failing over. The price is that two regions can change the same row at the same moment, and the system must pick an answer after both clients have been told 'saved'.",
        },
        {
          sequence: {
            actors: ['Client A', 'London', 'Singapore', 'Client B'],
            messages: [
              { from: 'Client A', to: 'London', label: 'set limit = 500', note: 'clock reads t = 100' },
              { from: 'Client B', to: 'Singapore', label: 'set limit = 200', note: 'clock reads t = 101' },
              { from: 'London', to: 'Client A', label: 'saved', tone: 'ok' },
              { from: 'Singapore', to: 'Client B', label: 'saved', tone: 'ok' },
              { from: 'London', to: 'Singapore', label: 'replicate 500 @ t=100', dashed: true, tone: 'bad', note: 'older: ignored' },
              { from: 'Singapore', to: 'London', label: 'replicate 200 @ t=101', dashed: true, note: 'newer: London overwrites 500' },
            ],
          },
          caption:
            "A conflicting write under last-writer-wins. Both clients were told 'saved'. Both regions end up agreeing on 200, and Client A's write is gone without an error anywhere. 'Last' was decided by two clocks that were never synchronised to the millisecond.",
        },
        {
          table: {
            head: ['Resolution', 'How it works', 'What it costs'],
            rows: [
              ['Last writer wins (LWW)', 'Keep the write with the highest timestamp', 'Silently drops the other write. Clock skew decides the winner'],
              ['Keep both (siblings)', 'Version vectors detect concurrency; the application merges', 'Every reader must handle several versions'],
              ['CRDTs', 'Data types whose merge is the same in any order: counters, sets, registers', 'Only fits data shaped that way. Can\'t enforce "never below zero"'],
              ['Avoid the conflict', 'One writer per row: region pinning', 'Not really multi-writer any more, which is the point'],
            ],
          },
          caption: 'Ways to resolve concurrent writes. Convergence means replicas agree; it does not mean the agreed answer is the one the business wanted.',
        },
        {
          p: "Multi-writer suits data where merging is natural and a lost or odd update is tolerable: shopping carts, presence, likes, device settings, collaborative documents. It is wrong for anything guarded by an invariant across writes. A balance must not go below zero; that rule needs to see every debit in one order. Two regions each approving a £80 payment against a £100 balance both pass their local check, and no merge function can un-spend the money. Uniqueness (one account per email) fails the same way.",
        },
        {
          callout:
            "Proposing active-active multi-writer for a ledger because it sounds the most available. Money needs a single order of writes per account. Offer region pinning or a consensus database, and say why.",
          kind: 'pitfall',
        },
        {
          see: [
            { href: '#/s/version-vectors', label: 'Version vectors', why: 'How replicas tell "happened after" from "concurrent" without trusting clocks.' },
            { href: '#/s/crdt', label: 'CRDTs', why: 'Counters and sets that merge to the same state in any order.' },
            { href: '#/s/quorum', label: 'Quorums', why: 'Leaderless reads and writes with R + W > N, and what a stale replica does to a read.' },
          ],
        },
      ],
    },
    {
      id: 'consensus',
      title: 'Globally consistent databases',
      blocks: [
        {
          p: "The last pattern keeps one consistent database across regions by running consensus on every write. A write commits when a majority of replicas, in different regions, have it. No acknowledged write is lost when a region dies, failover is automatic, and there are no conflicts: RPO is zero. You pay in latency on every write.",
        },
        {
          diagram: {
            w: 600,
            h: 320,
            nodes: [
              { id: 'client', label: 'Client', sub: 'in London', x: 20, y: 20, kind: 'client' },
              { id: 'lon', label: 'Leader', sub: 'London', x: 230, y: 20, kind: 'store', tone: 'ok' },
              { id: 'fra', label: 'Follower', sub: 'Frankfurt', x: 440, y: 230, kind: 'store', tone: 'ok' },
              { id: 'iad', label: 'Follower', sub: 'N. Virginia', x: 20, y: 230, kind: 'store', tone: 'muted' },
            ],
            edges: [
              { from: 'client', to: 'lon', label: 'write' },
              { from: 'lon', to: 'fra', label: 'ack ~15 ms', tone: 'ok', both: true },
              { from: 'lon', to: 'iad', label: 'ack ~75 ms, late', dashed: true, tone: 'muted', both: true },
            ],
          },
          caption:
            'A cross-region quorum. With three replicas a commit needs two, so the leader waits only for the nearest follower: about 15 ms here. Virginia catches up afterwards. The commit time is set by the second-closest replica, so where you put the replicas is the design.',
        },
        {
          p: "Work the numbers for your layout. London, Frankfurt, Virginia with the leader in London: writes cost about one London to Frankfurt round trip, 15 ms. Move the leader to Virginia and a London client pays 75 ms to reach it plus 75 ms for its nearest quorum partner, about 150 ms a write. A transaction that takes locks across several statements pays that per round. London, Virginia, Singapore has no cheap pair at all. This is why these databases let you pin the leader for a table or a row near its users, which brings you back towards region pinning with stronger guarantees.",
        },
        {
          table: {
            head: ['Product', 'What it gives', 'What to remember'],
            rows: [
              ['Google Spanner', 'Synchronous replication by consensus across regions, with strongly consistent transactions and reads', 'Uses tightly synchronised clocks (TrueTime) to order transactions. Write latency depends on replica placement'],
              ['CockroachDB', 'Consensus (Raft) per range of keys, serialisable transactions, Postgres wire protocol', 'Rows or tables can be homed in a region. Cross-region transactions pay cross-region round trips'],
              ['Amazon Aurora Global Database', 'One primary region takes writes; storage-level asynchronous replication to other regions for reads and failover', 'This is active-passive, well packaged. RPO is small but not zero'],
              ['DynamoDB global tables', 'Every region accepts writes; asynchronous replication between regions', 'Multi-writer. Concurrent writes to one item resolve by last writer wins'],
            ],
          },
          caption: "Four products often named together that sit in different patterns. Two run consensus across regions; two replicate asynchronously. The details are from memory: see 'unverified' at the foot of the page.",
        },
        {
          callout:
            "'Global database' on a product page doesn't tell you the pattern. Ask two questions: does a commit wait for another region, and can two regions write the same row? The answers place any product in one of the five patterns here.",
          kind: 'rule',
        },
        {
          see: [
            { href: '#/s/raft', label: 'Raft', why: 'A log entry commits when a majority has it; a follower that falls behind catches up later.' },
            { href: '#/s/two-phase-commit', label: 'Two-phase commit', why: 'What a transaction spanning several consensus groups adds on top.' },
          ],
        },
      ],
    },
    {
      id: 'failover',
      title: 'Routing, runbooks and testing failover',
      blocks: [
        {
          p: "A second region is only worth its cost if traffic can reach it and people have practised the move. Three mechanisms steer traffic, and they fail over at different speeds.",
        },
        {
          table: {
            head: ['Mechanism', 'How it steers', 'Failover speed', 'Catch'],
            rows: [
              ['DNS (latency or health-based records)', 'Returns a different address per region', 'The record TTL, often 30 to 60 s, plus clients that cache longer', 'Some resolvers and long-lived connections ignore the TTL'],
              ['Anycast', 'One IP address announced from many sites; the network delivers to the nearest', 'Seconds, as routes are withdrawn', 'You need a provider or network that does it; routes can shift mid-connection'],
              ['Global load balancer or edge proxy', 'Terminates at the edge, forwards to a healthy region', 'Seconds, on a health check', 'The edge is now a dependency for everything'],
            ],
          },
          caption: 'Ways to move traffic between regions. Most setups put anycast or a global load balancer in front and use DNS as the slower fallback.',
        },
        {
          p: "A failover runbook is short and ordered. Confirm the outage from outside the failing region. Check replication lag and record the last applied position. Fence the old primary. Promote. Repoint traffic. Verify with a synthetic write and read. Announce. Then the part people skip: when the old region returns, it must rejoin as a replica, and its unshipped writes must be found and reconciled. For payments, that means comparing against the card scheme or bank's record, not guessing.",
        },
        {
          p: "Capacity is the quiet failure. If each of two regions runs at 70% and one fails, the survivor needs 140%. Either run each at under 50%, or have autoscaling that you have actually seen absorb a doubling, including database connections and third-party rate limits.",
        },
        {
          callout:
            "Test failover on a schedule, in production, in working hours. A quarterly game day that really moves traffic finds the expired certificate, the hard-coded hostname and the firewall rule that a tabletop exercise never will. Some teams go further and run from the 'passive' region half the time, so neither region is ever cold.",
          kind: 'rule',
        },
      ],
    },
    {
      id: 'decide',
      title: 'Choosing by product type',
      blocks: [
        {
          p: "Different data in one company wants different patterns. The useful answer in an interview is a table, with the reason in each row.",
        },
        {
          table: {
            head: ['Data', 'Pattern', 'Why', 'What you accept'],
            rows: [
              ['Payments ledger', 'Region-pinned accounts, synchronous within the region; or a consensus database with leaders near users', 'One order of writes per account; RPO of zero; residency', 'Cross-region payments are two steps. Writes pay a quorum round trip'],
              ['User profiles and settings', 'Region-pinned, or active-passive with local read replicas', 'Read-heavy, rarely written, personal data with residency rules', 'A change may take a second to appear in another region'],
              ['Feeds, likes, presence', 'Multi-writer with LWW or CRDTs', 'Huge volume, merge is natural, a lost like is tolerable', 'Occasional odd ordering or a dropped update'],
              ['Analytics', 'Single region warehouse fed asynchronously', 'Nobody is waiting; batch latency is fine', 'Minutes to hours behind. Residency may force one warehouse per jurisdiction'],
              ['Sessions and rate limits', 'Local to each region, not replicated', 'Cheap to rebuild; a failover logs some users out', 'Limits are per region, so a global limit is approximate'],
            ],
          },
          caption: 'A decision table by product type. The ledger row is the one interviewers push on: be ready to say why multi-writer is out.',
        },
        {
          callout:
            "'I wouldn't pick one pattern for the company. The ledger gets one writer per account and zero data loss. Profiles get region pinning for residency. Feeds can be multi-writer because a merge is harmless. Analytics is asynchronous. The patterns differ because the cost of a lost or reordered write differs.'",
          kind: 'interview',
        },
        {
          see: [
            { href: '#/d/ledger', label: 'Ledger design', why: 'The single-region ledger this page would pin per region.' },
            { href: '#/d/money-moved-dashboard', label: 'Money moved dashboard', why: 'An asynchronous, read-only aggregate served from a CDN: the analytics row in practice.' },
            { href: '#/c/sharding-and-partitioning', label: 'Sharding and partitioning', why: 'Region pinning is directory partitioning with a region as the shard.' },
          ],
        },
      ],
    },
  ],
  unverified: [
    'Round-trip times London to Frankfurt (~15 ms), N. Virginia (~75 ms) and Singapore (~170 ms), and the distances shown: rough figures from memory; they vary by provider and route.',
    'Light in fibre at about 200 km per millisecond: the usual approximation (two thirds of c).',
    'UK and EU data residency: that a regulator, partner or contract may require in-region storage is common in practice; no specific rule (UK GDPR, adequacy decisions, FCA or PRA expectations) was checked.',
    'Async cross-region replica lag "normally under a second": typical, not guaranteed, and not measured.',
    'Google Spanner: consensus replication across regions and TrueTime ordering, described from the published paper as remembered.',
    'CockroachDB: Raft per range, serialisable isolation by default, region-homed rows and tables: from memory of its documentation.',
    'Amazon Aurora Global Database: a single write region with asynchronous storage-level replication. Not covered: its write-forwarding feature and managed switchover behaviour.',
    'DynamoDB global tables: multi-region writes resolved by last writer wins. AWS has announced a strongly consistent multi-region mode; its details were not checked and it is not described on the page.',
    'DNS TTLs of 30 to 60 seconds and anycast failover "in seconds": typical settings, not measured.',
    'Running at under 50% per region to absorb a failover assumes two regions with even traffic.',
  ],
};

export default page;
