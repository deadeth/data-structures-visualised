import type { Concept } from '../types';

const page: Concept = {
  id: 'sharding-and-partitioning',
  title: 'Sharding and partitioning',
  group: 'Data',
  summary:
    "Splitting one database across many machines: when you need to, how to pick the key, and what it costs you in queries, transactions and operations. Most designs should shard later than candidates think.",
  minutes: 13,
  sections: [
    {
      id: 'when',
      title: "When you need to shard, and when you don't",
      blocks: [
        {
          p: "Sharding splits one logical table across several database servers, each holding a slice of the rows. It is the only way to scale **writes** past one machine. It is also the most expensive scaling step you can take: you lose cross-row transactions, joins and cheap secondary lookups, and you take on resharding as a permanent operational job. So do the sums before you reach for it.",
        },
        {
          callout:
            "A card ledger for 10 million customers, 200 transactions each a year. That's 2 billion rows a year. At about 500 bytes a row with indexes, about 1 TB a year. Writes: 2 billion / 31.5 million seconds is about 63 a second on average; allow 10 times that at peak, about 630 a second. One Postgres primary on a large machine takes that with room to spare. The honest answer is: partition the table by month inside one database, archive old months, and don't shard yet.",
          kind: 'example',
          title: 'Do the sums first',
        },
        {
          p: "As a rough guide, one Postgres primary on a big cloud machine (tens of cores, hundreds of GB of memory, NVMe disks) handles a few thousand to low tens of thousands of simple write transactions a second, and a few terabytes of data before backups, restores and schema changes become slow enough to hurt. Those figures are approximate and depend heavily on row size, indexes and durability settings. Say them as orders of magnitude.",
        },
        {
          p: "Before sharding, there is a ladder to climb. Each rung is cheaper than the next.",
        },
        {
          table: {
            head: ['Step', 'What it fixes', 'What it does not fix'],
            rows: [
              ['Fix queries and indexes', 'Slow reads, lock waits, wasted CPU', 'A true capacity limit'],
              ['Bigger machine (vertical scaling)', 'CPU, memory and disk limits, for both reads and writes', 'Has a ceiling; one machine is still one failure'],
              ['Read replicas', 'Read load. Postgres streaming replication copies the log to followers', 'Writes. Replica reads are a little behind'],
              ['Cache', 'Repeated reads of the same data', 'Writes; adds stale reads'],
              ['Partition tables inside one database', 'Huge tables: drop old months, smaller indexes', 'Total write rate on the machine'],
              ['Split by function', 'One service or table group moves to its own database', 'A single table that is too big'],
              ['Shard', 'Write rate and data size past one machine', 'Nothing left to try after this'],
            ],
          },
          caption: 'The scaling ladder. Sharding is the last rung because every earlier rung keeps transactions and joins intact.',
        },
        {
          diagram: {
            w: 560,
            h: 380,
            nodes: [
              { id: 'app', label: 'Service', x: 160, y: 10, kind: 'box' },
              { id: 'cache', label: 'Cache', sub: 'repeated reads', x: 10, y: 150, kind: 'store' },
              { id: 'primary', label: 'Primary', sub: 'all writes', x: 310, y: 150, kind: 'store', tone: 'ok' },
              { id: 'r1', label: 'Replica', sub: 'reads, slightly behind', x: 220, y: 310, w: 150, kind: 'store' },
              { id: 'r2', label: 'Replica', sub: 'reads, failover', x: 400, y: 310, w: 150, kind: 'store' },
            ],
            edges: [
              { from: 'app', to: 'cache', label: 'hot reads' },
              { from: 'app', to: 'primary', label: 'writes' },
              { from: 'app', to: 'r1', label: 'reads' },
              { from: 'primary', to: 'r1', label: 'log', dashed: true },
              { from: 'primary', to: 'r2', label: 'log', dashed: true },
            ],
          },
          caption:
            "What to build before sharding. Reads spread over a cache and replicas; only the primary takes writes. You need shards only when that one green box can't keep up with writes or can't hold the data.",
        },
        {
          callout:
            "'Before I shard, let me check I need to. At 630 writes a second and 1 TB a year, one primary with replicas is enough for years. I'd partition by month for housekeeping. If we were at 20,000 writes a second, or 50 TB, I'd shard, and here is the key I'd pick.' Showing the threshold earns more than drawing shards straight away.",
          kind: 'interview',
        },
        {
          see: [
            { href: '#/s/leader-replication', label: 'Leader replication', why: 'How replicas follow the primary, and why a replica read can be behind.' },
            { href: '#/s/partitioning', label: 'Partitioning', why: 'Range and hash partitioning, hot keys, rebalancing and both kinds of index, step by step.' },
          ],
        },
      ],
    },
    {
      id: 'shard-key',
      title: 'Choosing the shard key',
      blocks: [
        {
          p: "The shard key decides which shard a row lives on. It is the hardest decision to reverse, because changing it means moving every row. A good key does three things: it spreads load evenly, it keeps the rows that change together on one shard, and it appears in almost every query so the router knows where to send it.",
        },
        {
          table: {
            head: ['Key', 'Works when', 'What goes wrong'],
            rows: [
              ['Customer id', 'Most queries are for one customer: balance, transactions, cards', "A few customers are far bigger than the rest. Transfers between customers cross shards"],
              ['Tenant id (B2B)', "Each business's data is read and written together", 'One tenant can be 1,000 times the median. It outgrows its shard'],
              ['Time (day or month)', 'You only ever query recent windows and archive the rest', "All of today's writes land on today's shard. The other shards sit idle"],
              ['Random id or hash of row id', 'Pure key-value access by id', "Any query that isn't by id asks every shard"],
            ],
          },
          caption: 'Common shard keys. Customer or tenant id is the usual answer for a product database; time is a partition key inside a shard, rarely the shard key itself.',
        },
        {
          h: 'Hot keys and celebrity accounts',
        },
        {
          p: "Hashing spreads keys, not load. If one merchant takes 5% of all payments, 5% of your writes land on one shard whatever the hash does. The fixes, in the order I'd offer them: give that tenant a shard of its own through a directory override; split the key further (merchant id plus a bucket number, so one merchant spreads over 16 sub-keys, at the price of reading 16 places to total it); or take the hot work off the write path, for example by batching counters.",
        },
        {
          h: 'Time-based hotspots',
        },
        {
          p: "Keys that grow over time (timestamps, auto-increment ids, time-ordered UUIDs) all sort next to each other. Under range partitioning every new row lands on the last shard. The standard fix is a compound key: lead with something that spreads (customer id), then order by time within it. Each customer's history stays in order on one shard, and today's writes spread across all of them.",
        },
        {
          callout:
            "Picking the key from the data model instead of the queries. Write down the five most frequent queries and the transactions that must be atomic. The key is whatever all of them have in common. If nothing is common, sharding that table will hurt, and it's better to say so.",
          kind: 'pitfall',
        },
      ],
    },
    {
      id: 'schemes',
      title: 'Range, hash and directory',
      blocks: [
        {
          p: "Given a key, there are three ways to map it to a shard. They differ in which queries stay on one shard and in how hard it is to move data later.",
        },
        {
          diagram: {
            w: 600,
            h: 270,
            nodes: [
              { id: 'router', label: 'Router', sub: 'compares boundaries', x: 230, y: 20, w: 150 },
              { id: 's0', label: 'Shard 0', sub: 'A to H', x: 20, y: 190, kind: 'store' },
              { id: 's1', label: 'Shard 1', sub: 'I to P', x: 230, y: 190, kind: 'store', tone: 'follow' },
              { id: 's2', label: 'Shard 2', sub: 'Q to Z', x: 440, y: 190, kind: 'store' },
            ],
            edges: [
              { from: 'router', to: 's0' },
              { from: 'router', to: 's1', label: "'Kowalski'", tone: 'follow' },
              { from: 'router', to: 's2' },
            ],
          },
          caption:
            "Range partitioning. Each shard owns a contiguous run of keys, so 'Kowalski' goes to the shard holding I to P, and a scan from K to M reads only that shard. The cost: if keys arrive in order, the last shard takes every write.",
        },
        {
          diagram: {
            w: 600,
            h: 270,
            nodes: [
              { id: 'router', label: 'Router', sub: 'hash(key) mod 3', x: 230, y: 20, w: 150 },
              { id: 's0', label: 'Shard 0', sub: 'hash mod 3 = 0', x: 20, y: 190, kind: 'store', tone: 'follow' },
              { id: 's1', label: 'Shard 1', sub: 'hash mod 3 = 1', x: 230, y: 190, kind: 'store' },
              { id: 's2', label: 'Shard 2', sub: 'hash mod 3 = 2', x: 440, y: 190, kind: 'store' },
            ],
            edges: [
              { from: 'router', to: 's0', label: "'Kowalski'", tone: 'follow' },
              { from: 'router', to: 's1' },
              { from: 'router', to: 's2' },
            ],
          },
          caption:
            "Hash partitioning. The hash scatters neighbouring keys, so load spreads evenly even when keys arrive in order. The cost: 'Kowalski' and 'Kowalska' are on different shards, so any range scan asks all of them. And `mod 3` breaks the day you add a fourth shard.",
        },
        {
          diagram: {
            w: 600,
            h: 400,
            nodes: [
              { id: 'router', label: 'Router', x: 20, y: 20 },
              { id: 'dir', label: 'Directory', sub: 'tenant → shard', x: 440, y: 20, kind: 'store', tone: 'compare' },
              { id: 's0', label: 'Shard 0', sub: 'small tenants', x: 20, y: 320, kind: 'store' },
              { id: 's1', label: 'Shard 1', sub: 'small tenants', x: 230, y: 320, kind: 'store' },
              { id: 's2', label: 'Shard 2', sub: 'one big tenant', x: 440, y: 320, kind: 'store', tone: 'follow' },
            ],
            edges: [
              { from: 'router', to: 'dir', label: 'where is Acme?', tone: 'compare' },
              { from: 'router', to: 's0' },
              { from: 'router', to: 's1' },
              { from: 'router', to: 's2', label: 'Acme', tone: 'follow' },
            ],
          },
          caption:
            "Directory (lookup) partitioning. A small table says which shard each tenant lives on. Moving a tenant is a data copy plus one row changed. That's how the big tenant got a shard to itself. The cost: the directory is on every request path, so it must be cached and highly available.",
        },
        {
          table: {
            head: ['Scheme', 'Stays on one shard', 'Fans out', 'Moving data'],
            rows: [
              ['Range', 'Get by key; scans over a key range', 'Queries by anything else', 'Split a range at its midpoint and move half'],
              ['Hash', 'Get by key', 'Range scans; queries by anything else', 'Hard with mod N; easy with fixed partitions or a ring'],
              ['Directory', 'Everything for one tenant', 'Queries across tenants', 'Copy one tenant, flip one directory row'],
            ],
          },
          caption: 'The three schemes side by side. Many real systems combine them: hash to a fixed set of partitions, then a directory from partition to node.',
        },
        {
          h: 'Consistent hashing and virtual nodes',
        },
        {
          p: "`hash(key) mod N` has one fatal flaw: change N and almost every key maps to a different shard. Going from 3 to 4 shards moves about three quarters of the rows. Consistent hashing fixes that. Shards and keys hash onto the same circle, and a key belongs to the first shard point clockwise from it. Adding a shard takes over one arc, so only about 1/N of the keys move.",
        },
        {
          p: "With one point per shard the arcs are uneven and a failed shard dumps its whole load on one neighbour. **Virtual nodes** give each shard many points (often 100 or more), which evens the shares and spreads a failed shard's keys over many neighbours. A bigger machine can take more points. Consistent hashing still doesn't help with a hot key or a range scan.",
        },
        {
          see: [
            { href: '#/s/consistent-hashing', label: 'Consistent hashing', why: 'Add and remove a server and count the keys that move, with one point per server and with three.' },
          ],
        },
      ],
    },
    {
      id: 'secondary-indexes',
      title: 'Secondary indexes: local or global',
      blocks: [
        {
          p: "Sharding by customer id makes 'get this customer's payments' cheap. It does nothing for 'find the payment with this card-scheme reference'. That needs a secondary index, and on a sharded store you have to choose where the index lives.",
        },
        {
          diagram: {
            w: 600,
            h: 260,
            nodes: [
              { id: 'q', label: 'Query', sub: 'reference = R77?', x: 230, y: 20, kind: 'client' },
              { id: 'p0', label: 'Shard 0', sub: 'rows + own index', x: 20, y: 180, kind: 'store', tone: 'visited' },
              { id: 'p1', label: 'Shard 1', sub: 'rows + own index', x: 230, y: 180, kind: 'store', tone: 'ok' },
              { id: 'p2', label: 'Shard 2', sub: 'rows + own index', x: 440, y: 180, kind: 'store', tone: 'visited' },
            ],
            edges: [
              { from: 'q', to: 'p0', label: 'ask', tone: 'visited' },
              { from: 'q', to: 'p1', label: 'ask, found', tone: 'ok' },
              { from: 'q', to: 'p2', label: 'ask', tone: 'visited' },
            ],
          },
          caption:
            'A local index. Each shard indexes only its own rows, so a write touches one shard and stays transactional. A read by the indexed column must ask every shard, and is as slow as the slowest one.',
        },
        {
          diagram: {
            w: 600,
            h: 370,
            nodes: [
              { id: 'q', label: 'Query', sub: 'reference = R77?', x: 230, y: 20, kind: 'client' },
              { id: 'ia', label: 'Index part A', sub: 'refs A to M', x: 60, y: 150, kind: 'store' },
              { id: 'ib', label: 'Index part B', sub: 'refs N to Z', x: 400, y: 150, kind: 'store', tone: 'visited' },
              { id: 'p0', label: 'Shard 0', sub: 'rows', x: 20, y: 290, kind: 'store' },
              { id: 'p1', label: 'Shard 1', sub: 'rows', x: 230, y: 290, kind: 'store', tone: 'ok' },
              { id: 'p2', label: 'Shard 2', sub: 'rows', x: 440, y: 290, kind: 'store' },
            ],
            edges: [
              { from: 'q', to: 'ib', label: '1. look up R77', tone: 'visited' },
              { from: 'ib', to: 'p1', label: '2. get by key', tone: 'ok' },
              { from: 'p0', to: 'ia', label: 'async update', dashed: true },
            ],
          },
          caption:
            "A global index. The index is itself partitioned, by the indexed value, so a lookup asks one index partition and then one shard. The cost moves to writes: every write updates a second partition, usually asynchronously, so the index can miss a row written a moment ago.",
        },
        {
          p: "Choose local when the query is rare, can be slow, or always comes with the shard key anyway. Choose global when the lookup is frequent and on the request path, and the caller can live with a short delay or retry. For a lookup that must be exact, such as an idempotency check on a payment reference, don't rely on an asynchronous index: make the reference part of the shard key, or keep a small, strongly consistent mapping table of its own.",
        },
        {
          see: [
            { href: '#/s/partitioning', label: 'Partitioning', why: "'Find by city' with local indexes asks every partition; with the global index it asks one." },
          ],
        },
      ],
    },
    {
      id: 'cross-shard',
      title: 'Cross-shard queries and transactions',
      blocks: [
        {
          p: "Inside one shard you have everything Postgres gives you: joins, foreign keys, transactions. Across shards you have none of it by default. Two kinds of work cross shards, and each has its own answer.",
        },
        {
          p: "**Queries** that don't carry the shard key fan out: the router asks every shard, waits, merges and sorts. With 32 shards the response time is the slowest of 32 answers, and one slow shard makes every such query slow. That's fine for a back-office report. It is not fine on a request path. Move those questions elsewhere: a global index for point lookups, a search index for text, and a warehouse or stream-fed read model for aggregates.",
        },
        {
          p: "**Transactions** that touch two shards need coordination. Two-phase commit does it atomically, but costs extra round trips, holds locks across the network, and blocks if the coordinator dies between phases. A saga does it as a chain of local transactions with compensating steps, which never blocks but exposes intermediate states. Neither is free.",
        },
        {
          callout:
            "Design the key so that what must change together lives together. Then treat the remaining cross-shard work as messaging: commit locally with an outbox row, deliver it at least once, and make the receiver idempotent.",
          kind: 'rule',
        },
        {
          callout:
            "A transfer from customer A (shard 3) to customer B (shard 9). Don't run 2PC across the two. Debit A and write a 'transfer out' outbox row in one local transaction on shard 3. A relay delivers it. Shard 9 credits B, keyed on the transfer id so a redelivery does nothing. If the credit can't be applied (account closed), a compensating credit goes back to A. The money is never in two places and never in none: between the steps it sits in a transit account you can reconcile.",
          kind: 'example',
          title: 'A transfer across shards',
        },
        {
          see: [
            { href: '#/s/two-phase-commit', label: 'Two-phase commit', why: 'The prepare and commit rounds, and what blocks when the coordinator fails.' },
            { href: '#/s/saga', label: 'Sagas', why: 'Local transactions with compensations, and the states a reader can see in between.' },
            { href: '#/s/outbox', label: 'Transactional outbox', why: 'How a local commit and a message leave together.' },
            { href: '#/d/ledger', label: 'Ledger design', why: 'Account-first locking and an outbox on one Postgres database, before any sharding.' },
          ],
        },
      ],
    },
    {
      id: 'resharding',
      title: 'Resharding without downtime',
      blocks: [
        {
          p: "Sooner or later a shard fills up, or one tenant outgrows its neighbours, and data has to move while the service stays up. There are two approaches. One makes moves cheap from the start. The other is the migration you run when you didn't.",
        },
        {
          h: 'More partitions than nodes, from day one',
        },
        {
          p: "Hash keys into a fixed, generous number of logical partitions, say 1,024, and keep a small map from partition to node. With 4 nodes each holds 256 partitions. To add a fifth node, move about 205 whole partitions to it and update the map. No key ever changes partition, so there is no rehashing, and each move is a copy of one self-contained slice. This is the cheapest insurance in the whole topic: it costs one small lookup table.",
        },
        {
          diagram: {
            w: 620,
            h: 240,
            groups: [
              { label: 'Node A', x: 10, y: 10, w: 190, h: 210 },
              { label: 'Node B', x: 215, y: 10, w: 190, h: 210 },
              { label: 'Node C (new)', x: 420, y: 10, w: 190, h: 210, tone: 'ok' },
            ],
            nodes: [
              { id: 'p0', label: 'p0', x: 25, y: 60, w: 70, h: 40, kind: 'store' },
              { id: 'p1', label: 'p1', x: 115, y: 60, w: 70, h: 40, kind: 'store' },
              { id: 'p3', label: 'p3', x: 25, y: 140, w: 70, h: 40, kind: 'store' },
              { id: 'p4', label: 'p4', x: 230, y: 60, w: 70, h: 40, kind: 'store' },
              { id: 'p5', label: 'p5', x: 320, y: 60, w: 70, h: 40, kind: 'store' },
              { id: 'p7', label: 'p7', x: 230, y: 140, w: 70, h: 40, kind: 'store' },
              { id: 'p2', label: 'p2', x: 435, y: 60, w: 70, h: 40, kind: 'store', tone: 'ok' },
              { id: 'p6', label: 'p6', x: 525, y: 60, w: 70, h: 40, kind: 'store', tone: 'ok' },
            ],
            edges: [],
          },
          caption:
            'Eight fixed partitions on three nodes, after node C joined. Only p2 and p6 moved, as whole units. Every key still hashes to the same partition as before; only the partition-to-node map changed.',
        },
        {
          h: 'The online migration',
        },
        {
          p: "When you must change the key or split a shard the hard way, the pattern is always the same four phases: double write, backfill, verify, cut over. Each phase is reversible until the last.",
        },
        {
          sequence: {
            actors: ['Service', 'Old shard', 'New shard', 'Backfill job'],
            messages: [
              { from: 'Service', to: 'Old shard', label: 'write (source of truth)', tone: 'ok' },
              { from: 'Service', to: 'New shard', label: 'same write again', note: 'phase 1: double write' },
              { from: 'Backfill job', to: 'Old shard', label: 'read old rows in key order', tone: 'visited' },
              { from: 'Backfill job', to: 'New shard', label: 'insert unless a newer row exists', note: 'phase 2: backfill' },
              { from: 'Backfill job', to: 'Old shard', label: 'checksum each key range', tone: 'compare', note: 'phase 3: verify' },
              { from: 'Backfill job', to: 'New shard', label: 'same checksums, compare', tone: 'compare' },
              { from: 'Service', to: 'New shard', label: 'shadow reads, compare answers', tone: 'compare' },
              { from: 'Service', to: 'New shard', label: 'reads and writes: new is truth', tone: 'ok', note: 'phase 4: cut over, by flag' },
              { from: 'Service', to: 'Old shard', label: 'keep double writing a while', dashed: true, note: 'the way back' },
            ],
          },
          caption:
            "An online reshard. The service never stops. The backfill must not overwrite a newer double-written row, which is why it inserts only when nothing newer exists. The old shard keeps receiving writes after cut-over so you can flip back.",
        },
        {
          p: "Three things go wrong in practice. A double write can succeed on one side and fail on the other, so the verify phase has to run continuously, not once. The backfill competes with live traffic for disk and must be throttled. And the cut-over must be a flag per tenant or per key range, not a deploy, so you can move 1% first and reverse it in seconds. Capturing changes from the old shard's log is a common alternative to double writing in the application: it can't miss a write path someone forgot.",
        },
        {
          callout:
            "'I'd hash into 1,024 logical partitions from the start, mapped to nodes through a directory, so growing is moving partitions, not rehashing rows. If we ever had to change the key itself, it's double write, backfill, verify, cut over behind a flag, with the old side kept warm for rollback.'",
          kind: 'interview',
        },
      ],
    },
    {
      id: 'multi-tenant',
      title: 'Multi-tenant isolation',
      blocks: [
        {
          p: "A B2B product has a second question beside 'which shard': how separate is one customer's data from another's? There are three models, and they trade cost for isolation.",
        },
        {
          diagram: {
            w: 640,
            h: 250,
            groups: [
              { label: 'Shared tables', x: 10, y: 10, w: 190, h: 230 },
              { label: 'Schema per tenant', x: 225, y: 10, w: 190, h: 230 },
              { label: 'Database per tenant', x: 440, y: 10, w: 190, h: 230 },
            ],
            nodes: [
              { id: 'shared', label: 'orders', sub: 'tenant_id column', x: 30, y: 100, w: 150, kind: 'store' },
              { id: 'sa', label: 'acme.orders', sub: 'same server', x: 245, y: 60, w: 150, kind: 'store' },
              { id: 'sb', label: 'globex.orders', sub: 'same server', x: 245, y: 160, w: 150, kind: 'store' },
              { id: 'da', label: 'Acme database', sub: 'own server', x: 460, y: 60, w: 150, kind: 'store' },
              { id: 'db', label: 'Globex database', sub: 'own server', x: 460, y: 160, w: 150, kind: 'store' },
            ],
            edges: [],
          },
          caption:
            'Three isolation models. Moving right, a noisy or breached tenant affects fewer neighbours, and each tenant costs more to run. Most products mix them: shared tables for the long tail, a dedicated database for the few largest or most regulated customers.',
        },
        {
          table: {
            head: ['Model', 'Cost per tenant', 'Isolation', 'What breaks'],
            rows: [
              ['Shared tables with `tenant_id`', 'Near zero', 'Logical only. One missing `WHERE tenant_id =` leaks data', 'Noisy neighbours; one big tenant skews every index'],
              ['Schema per tenant', 'Low', "Separate tables; shared CPU, memory and disk", 'Schema changes run once per tenant. Tens of thousands of schemas strain catalogues and tooling'],
              ['Database per tenant', 'High', 'Strong: own resources, own backups, own keys, own region', 'Fleet management. Thousands of databases to patch, monitor and migrate'],
            ],
          },
          caption: 'What each model costs and where it fails.',
        },
        {
          p: "With shared tables, don't trust every query to remember the filter. Enforce it below the application: Postgres row-level security keyed on a session setting, or a data-access layer that can't build a query without a tenant. Put `tenant_id` first in every primary key and index, which also makes it the natural shard key later.",
        },
        {
          p: "A directory ties the models together. If every request resolves tenant to location first, a tenant can start in shared tables and move to its own database when it grows, signs an enterprise contract, or needs its data kept in one country. See [multi-region data](#/c/multi-region-data) for the residency side of that.",
        },
        {
          callout:
            "Offering database-per-tenant as the default because it sounds safest. At 50,000 small tenants it means 50,000 databases to migrate on every schema change. Start shared, enforce the tenant filter in the database, and promote tenants out by exception.",
          kind: 'pitfall',
        },
      ],
    },
  ],
  unverified: [
    'One Postgres primary handling "a few thousand to low tens of thousands" of simple write transactions a second and "a few terabytes" comfortably: orders of magnitude from experience, not a benchmark.',
    'The ledger sizing example (500 bytes a row with indexes, peak at 10 times the average) is an assumption made for the sum.',
    'Virtual node counts of "often 100 or more" per server: typical of ketama-style clients; individual systems differ.',
    'That tens of thousands of Postgres schemas strain catalogues and tooling: widely reported, no figure checked.',
    'Postgres row-level security keyed on a session setting as a tenant filter: a known pattern; its performance cost was not measured here.',
    'Moving "about three quarters" of rows going from 3 to 4 shards under mod N follows from K × N/(N+1) with N = 3; it is an expectation, not a measurement.',
  ],
};

export default page;
