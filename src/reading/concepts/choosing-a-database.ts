import type { Concept } from "../types";

const page: Concept = {
  id: "choosing-a-database",
  title: "Choosing a database",
  group: "Data",
  summary:
    "The database families, what each is built for and bad at, how B-tree and LSM storage engines shape reads and writes, and how to justify a choice in an interview. Usually the answer is Postgres plus one derived store.",
  minutes: 12,
  sections: [
    {
      id: "questions-first",
      title: "Ask the questions before naming a product",
      blocks: [
        {
          p: "A database choice follows from the queries, not from the size of the company. Write down the three or four reads and writes the system does most, then ask five questions.",
        },
        {
          table: {
            head: ["Question", "What you're listening for", "What it rules in or out"],
            rows: [
              [
                "Access patterns",
                "By key, by range, by many filters, by text, or scans and sums?",
                "Key lookups suit anything. Ad hoc filters and joins need relational. Sums over millions of rows need columns.",
              ],
              [
                "Consistency",
                "Must several rows change together? Can a read be seconds stale?",
                "Money and stock need transactions. A feed or a counter may not.",
              ],
              [
                "Scale",
                "Writes per second at peak, data per year, largest single query",
                "Under a few thousand writes a second and a few terabytes, one primary copes.",
              ],
              [
                "Team familiarity",
                "What does the team already run in production?",
                "A store nobody has been paged for costs a year of learning.",
              ],
              [
                "Operations",
                "Backups, failover, upgrades, schema change, cost. Managed or self-run?",
                "A managed Postgres is hours a month. A self-run Cassandra ring is part of someone's job.",
              ],
            ],
          },
          caption: "The first three are about the workload. The last two are about the people, and decide more real choices than candidates admit.",
        },
        {
          diagram: {
            w: 580,
            h: 410,
            nodes: [
              { id: "q1", label: "Scans and sums?", sub: "millions of rows a query", x: 20, y: 10, w: 200 },
              { id: "q2", label: "Text search?", sub: "relevance, typos, facets", x: 20, y: 120, w: 200 },
              { id: "q3", label: "Writes beyond one box?", sub: "and reads by a known key", x: 20, y: 230, w: 200 },
              { id: "q4", label: "Everything else", sub: "most systems land here", x: 20, y: 340, w: 200 },
              { id: "a1", label: "Columnar warehouse", sub: "ClickHouse, BigQuery", x: 380, y: 10, w: 180 },
              { id: "a2", label: "Search index", sub: "fed from the source", x: 380, y: 120, w: 180 },
              { id: "a3", label: "Key-value, wide-column", sub: "DynamoDB, Cassandra", x: 380, y: 230, w: 180 },
              { id: "a4", label: "PostgreSQL", sub: "the default", x: 380, y: 340, w: 180, tone: "ok" },
            ],
            edges: [
              { from: "q1", to: "a1", label: "yes" },
              { from: "q1", to: "q2", label: "no" },
              { from: "q2", to: "a2", label: "yes" },
              { from: "q2", to: "q3", label: "no" },
              { from: "q3", to: "a3", label: "yes" },
              { from: "q3", to: "q4", label: "no" },
              { from: "q4", to: "a4" },
            ],
          },
          caption:
            "Ask per workload, not per system. One product often takes two exits: Postgres for the transactions and a warehouse or search index fed from it. Each exit above the last needs a reason you can state as a number or a query.",
        },
      ],
    },
    {
      id: "families",
      title: "The families",
      blocks: [
        {
          p: "Nine families cover almost every interview. For each, know one example, the query it was built for, and the query it does badly.",
        },
        {
          table: {
            head: ["Family", "Example", "Good at", "Bad at"],
            rows: [
              [
                "Relational",
                "PostgreSQL, MySQL",
                "Transactions across rows, joins, constraints, queries you didn't plan for",
                "Writes beyond one primary; scans over billions of rows",
              ],
              [
                "Key-value",
                "Redis, DynamoDB",
                "Get and put by key at very high rates with flat latency",
                "Any query that isn't by key; Redis is bounded by memory",
              ],
              [
                "Document",
                "MongoDB",
                "A whole aggregate (an order with its lines) read and written as one JSON document; fields that vary",
                "Joins and changes that span documents; data duplicated across documents drifts",
              ],
              [
                "Wide-column",
                "Cassandra, HBase",
                "Huge write volume spread over many nodes; reads by partition key and a range within it",
                "Queries the tables weren't designed for; joins; transactions across partitions",
              ],
              [
                "Search",
                "Elasticsearch, OpenSearch",
                "Full-text relevance, filters on many fields, facets",
                "Being the source of truth: refresh is near real time, not immediate, and there are no multi-document transactions",
              ],
              [
                "Time-series",
                "TimescaleDB, InfluxDB, Prometheus",
                "Append-heavy points keyed by time; compression, downsampling, dropping old data",
                "Updates to old points; many distinct label combinations",
              ],
              [
                "Graph",
                "Neo4j",
                "Traversals of unknown depth: friends of friends, rings of linked accounts",
                "Bulk aggregates; spreading one graph over many machines",
              ],
              [
                "Object storage",
                "Amazon S3",
                "Files of any size, cheaply and durably: images, statements, backups, data lake files",
                "Small updates in place; queries; latency is tens of milliseconds",
              ],
              [
                "Columnar warehouse",
                "ClickHouse, BigQuery, Snowflake",
                "Sums and group-bys over billions of rows and a few columns",
                "Single-row lookups and updates; many small transactions",
              ],
            ],
          },
          caption: "Wide-column and columnar sound alike and are opposites: Cassandra finds rows by key; ClickHouse scans columns.",
        },
        {
          p: "The families blur. Postgres has JSONB columns, full-text search and time partitioning. DynamoDB has transactions. So \"can it do this?\" is rarely the question. Ask what it's built to do cheaply at your size.",
        },
        {
          see: [
            { href: "#/s/column-store", label: "Column store", why: "Why a query over 2 of 50 columns reads 2 columns, and how min and max per block skip the rest." },
            { href: "#/s/inverted-index", label: "Inverted index", why: "The structure inside a search engine: a term maps to the list of documents that contain it." },
            { href: "#/s/partitioning", label: "Partitioning", why: "How key-value and wide-column stores spread keys over nodes, and what a hot key does." },
          ],
        },
      ],
    },
    {
      id: "storage-engines",
      title: "B-tree or LSM: what the engine does with a write",
      blocks: [
        {
          p: "Under the query language, nearly every database stores data in one of two ways, and that choice explains most of its behaviour.",
        },
        {
          p: "A **B-tree** engine (Postgres, MySQL's InnoDB) keeps each key in one place on disk. A write appends to a log for durability, then changes a page in place. A read walks 3 or 4 pages from the root to a leaf and it's done. Reads are fast and predictable. Each write eventually costs a random page write, and a page that fills must split.",
        },
        {
          p: "An **LSM** engine (RocksDB, Cassandra, HBase) never changes data in place. A write appends to a log and goes into a sorted buffer in memory. Full buffers are written out as sorted files, and a background job merges files later. Writes are sequential and cheap. A read may have to check the buffer and several files, newest first, with a Bloom filter per file to skip the ones that can't hold the key.",
        },
        {
          diagram: {
            w: 600,
            h: 420,
            groups: [
              { label: "B-tree: Postgres, InnoDB", x: 10, y: 10, w: 280, h: 400 },
              { label: "LSM: RocksDB, Cassandra", x: 310, y: 10, w: 280, h: 400 },
            ],
            nodes: [
              { id: "bw", label: "Write", x: 80, y: 50, kind: "client" },
              { id: "bl", label: "Log", sub: "sequential append", x: 80, y: 146, kind: "queue" },
              { id: "bp", label: "Page, in place", sub: "random 8 KB write", x: 80, y: 242, kind: "store", tone: "compare" },
              { id: "br", label: "Read: 3 or 4 pages", sub: "one place per key", x: 80, y: 338, tone: "ok" },
              { id: "lw", label: "Write", x: 380, y: 50, kind: "client" },
              { id: "lm", label: "Log + memtable", sub: "in memory", x: 380, y: 146, kind: "queue", tone: "ok" },
              { id: "ls", label: "Sorted files", sub: "flushed, never edited", x: 380, y: 242, kind: "store" },
              { id: "lr", label: "Read: many files", sub: "plus compaction", x: 380, y: 338, tone: "compare" },
            ],
            edges: [
              { from: "bw", to: "bl" },
              { from: "bl", to: "bp", dashed: true },
              { from: "bp", to: "br", both: true },
              { from: "lw", to: "lm" },
              { from: "lm", to: "ls", dashed: true },
              { from: "ls", to: "lr", both: true },
            ],
          },
          caption:
            "Green marks where each engine is cheap, amber where it pays. The B-tree pays on the write (a random page per update) and is repaid on the read. The LSM tree takes writes cheaply and pays on reads and in background merging.",
        },
        {
          table: {
            head: ["", "B-tree", "LSM tree"],
            rows: [
              ["Point read", "A few page reads, steady", "Memtable, then files newest first; Bloom filters help"],
              ["Range scan", "Walk the linked leaves", "Merge several sorted files as you go"],
              ["Write", "Log append, then a page in place", "Log append and a memory insert"],
              ["Space", "Pages part empty after splits", "Compresses well; old versions linger until compaction"],
              ["What goes wrong", "Random writes on a table bigger than memory", "Write stalls when compaction falls behind; tombstones slow scans"],
              ["Choose for", "Mixed reads and writes, transactions", "Write-heavy ingest, time-ordered data, large key spaces"],
            ],
          },
        },
        {
          see: [
            { href: "#/s/b-plus-tree", label: "B+ tree", why: "Follow one key down the levels, and watch a full leaf split." },
            { href: "#/s/lsm-tree", label: "LSM tree", why: "Follow a write from memtable to SSTable, then a read across files and a compaction." },
            { href: "#/s/bloom-filter", label: "Bloom filter", why: "How an LSM read skips files that can't contain the key." },
          ],
        },
      ],
    },
    {
      id: "indexes",
      title: "Indexes and what they cost",
      blocks: [
        {
          p: "An index is a second sorted copy of some columns, pointing back at the rows. It turns a scan of 100 million rows into 4 page reads. It is also something every write must keep up to date.",
        },
        {
          diagram: {
            w: 620,
            h: 260,
            nodes: [
              { id: "ins", label: "INSERT one payment", x: 230, y: 10, w: 160, kind: "client" },
              { id: "heap", label: "Table", sub: "the row", x: 10, y: 180, w: 120, kind: "store", tone: "ok" },
              { id: "i1", label: "Index: id", x: 170, y: 180, w: 120, kind: "store", tone: "ok" },
              { id: "i2", label: "Index: account", sub: "+ created_at", x: 330, y: 180, w: 120, kind: "store", tone: "ok" },
              { id: "i3", label: "Index: status", x: 490, y: 180, w: 120, kind: "store", tone: "ok" },
            ],
            edges: [
              { from: "ins", to: "heap" },
              { from: "ins", to: "i1" },
              { from: "ins", to: "i2" },
              { from: "ins", to: "i3" },
            ],
          },
          caption:
            "One insert, four writes, plus the log. Each index you add makes every insert slower and the table larger on disk. Indexes together are often as big as the table.",
        },
        {
          p: "Three habits cover most cases. Build the index for the query: for \"this account's payments, newest first\", index `(account_id, created_at DESC)`, with equality columns first and the range column last. Don't index a column with few values on its own; `status` with five values narrows nothing. Use a partial index for the small interesting slice, such as `WHERE status = 'PENDING'`.",
        },
        {
          p: "In DynamoDB and Cassandra the cost is sharper. The primary key is the only free index. A secondary index is a second table kept by the database, sometimes eventually consistent, and you pay for its writes. That's why those stores make you design tables from the queries backwards.",
        },
        {
          callout:
            "Say the index with the query: \"The hot read is the last 50 payments for an account, so the index is account_id then created_at descending. That's the only secondary index on the write path; reporting queries go to the warehouse.\"",
          kind: "interview",
        },
      ],
    },
    {
      id: "oltp-olap",
      title: "OLTP and OLAP are different jobs",
      blocks: [
        {
          p: "**OLTP** is many small transactions that touch a few rows each: take a payment, read a balance. It wants rows kept together, indexes and millisecond commits. **OLAP** is a few large queries over millions of rows and a handful of columns: money moved per currency per day. It wants columns kept together, compression and scans in parallel.",
        },
        {
          p: "One engine does both badly at size. A monthly report run on the payments primary reads cold pages, pushes hot ones out of memory and slows every payment. So you keep one source of truth for writes and copy changes to stores built for the other reads.",
        },
        {
          diagram: {
            w: 480,
            h: 410,
            nodes: [
              { id: "svc", label: "Payments service", x: 170, y: 10 },
              { id: "pg", label: "PostgreSQL", sub: "rows: source of truth", x: 170, y: 120, kind: "store", tone: "ok" },
              { id: "k", label: "Kafka", sub: "change stream", x: 170, y: 230, kind: "queue" },
              { id: "wh", label: "Warehouse", sub: "columns: reports", x: 30, y: 340, kind: "store" },
              { id: "es", label: "Elasticsearch", sub: "text: support search", x: 310, y: 340, kind: "store" },
            ],
            edges: [
              { from: "svc", to: "pg", label: "commit" },
              { from: "pg", to: "k", label: "CDC", dashed: true },
              { from: "k", to: "wh", dashed: true },
              { from: "k", to: "es", dashed: true },
            ],
          },
          caption:
            "Only Postgres is written by the service. The warehouse and the search index are derived: seconds behind, and rebuildable from the source if they're lost or wrong. Dashed lines are asynchronous.",
        },
        {
          p: "Don't have the service write to both stores itself. If the second write fails, the two disagree and nothing notices.",
        },
        {
          sequence: {
            actors: ["Service", "PostgreSQL", "Elasticsearch"],
            messages: [
              { from: "Service", to: "PostgreSQL", label: "UPDATE payment: REFUNDED" },
              { from: "PostgreSQL", to: "Service", label: "committed", tone: "ok" },
              { from: "Service", to: "Elasticsearch", label: "index: REFUNDED", tone: "bad", dashed: true, note: "times out, or the service crashes first" },
              { from: "Service", to: "Elasticsearch", label: "search status:PAID", note: "later, from the support tool" },
              { from: "Elasticsearch", to: "Service", label: "returns the refunded payment", tone: "bad" },
            ],
          },
          caption:
            "A dual write. The database committed and the index never heard. Support sees a refunded payment as paid, for ever. Change data capture or an outbox makes the second write follow from the first.",
        },
        {
          see: [
            { href: "#/s/outbox", label: "Transactional outbox", why: "The event is written in the same transaction as the row, then relayed, so the two can't disagree." },
            { href: "#/d/money-moved-dashboard", label: "Money moved dashboard", why: "A worked design that keeps OLTP writes away from an aggregate read by the public." },
          ],
        },
      ],
    },
    {
      id: "start-with-postgres",
      title: "Start with Postgres, and know when you've outgrown it",
      blocks: [
        {
          p: "For a new system the default is one relational database, and Postgres is the usual pick. It gives transactions, constraints, joins, JSON columns and decent full-text search. Every engineer can query it and every cloud will run it for you. Most of all, it lets you change your mind: a new query needs a new index, not a new table design.",
        },
        {
          p: "A single primary on good hardware goes further than candidates assume: thousands of simple write transactions a second and a few terabytes are ordinary. Work out your numbers before claiming you're past that. 10 million payments a day is about 116 a second on average and perhaps 600 at peak.",
        },
        {
          p: "When it does strain, the fixes come in an order. Each is cheaper than the next, so take them in turn and say which symptom moves you on.",
        },
        {
          table: {
            head: ["Symptom", "Fix", "What it costs"],
            rows: [
              ["Reads saturate the primary", "Read replicas; a cache for the hottest keys", "Replica lag: read your own write from the primary"],
              ["Reports slow down payments", "Move analytics to a warehouse through CDC", "A pipeline to run; data seconds behind"],
              ["Search needs relevance or many filters", "Add a search index, derived", "A second store that can drift"],
              ["Tables in the hundreds of gigabytes; slow vacuum and index builds", "Partition by time; archive old partitions to object storage", "Every query must carry the partition key"],
              ["One table takes most of the writes", "Move that workload to its own database or a key-value store", "No joins or transactions across the boundary"],
              ["Writes exceed one primary, or one region isn't enough", "Shard by tenant or account, or adopt a distributed SQL database", "Cross-shard queries, resharding, a much harder on-call"],
            ],
          },
          caption: "Sharding is last because it's the only step you can't easily undo.",
        },
        {
          callout:
            "\"I'll start with Postgres because the writes need transactions and we're at about 600 writes a second at peak, which one primary handles. The first thing to break will be storage: 3.65 TB a year, so I'd partition the payments table by month from day one and archive after 13 months. I'd only shard if we passed several thousand writes a second.\"",
          kind: "interview",
          title: "Default, number, first thing to break",
        },
        {
          see: [
            { href: "#/s/leader-replication", label: "Leader replication", why: "Shows replica lag and what a failover can lose." },
            { href: "#/s/mvcc", label: "MVCC", why: "How Postgres lets readers and writers run together, and why old row versions need vacuuming." },
            { href: "#/d/ledger", label: "Ledger design", why: "A design that stays on Postgres and partitions only its largest table." },
          ],
        },
      ],
    },
    {
      id: "decision-table",
      title: "A decision table",
      blocks: [
        {
          table: {
            head: ["If the workload is", "Reach for", "Because", "Not"],
            rows: [
              ["Payments, balances, orders, stock", "PostgreSQL or MySQL", "Several rows must change together; constraints catch bugs", "A store without multi-row transactions"],
              ["Sessions, rate limits, cached results", "Redis", "Sub-millisecond by key; expiry built in; losing it is survivable", "The only copy of anything you can't rebuild"],
              ["Known key lookups at tens of thousands of writes a second", "DynamoDB or Cassandra", "Spreads writes over nodes by partition key", "Anything needing ad hoc queries"],
              ["Catalogue or profile with varying fields", "Postgres JSONB, or MongoDB", "One aggregate, read whole", "Data with many relationships"],
              ["Search box, filters, facets", "Elasticsearch, fed from the source", "Inverted index and relevance scoring", "The source of truth"],
              ["Metrics, prices, sensor readings", "TimescaleDB or Prometheus", "Time partitions, compression, cheap expiry", "Rows you update later"],
              ["Dashboards, reports, data science", "ClickHouse, BigQuery or Snowflake", "Column scans over billions of rows", "Serving single-row requests to users"],
              ["Fraud rings, permissions, recommendations by path", "Neo4j, or recursive SQL at small size", "Traversals of unknown depth", "Your main transactional store"],
              ["Files, statements, images, backups", "S3 with a row of metadata in Postgres", "Cheap, durable, any size", "Rows in a database table"],
            ],
          },
          caption: "The last column is where interviewers push.",
        },
      ],
    },
    {
      id: "interview-mistakes",
      title: "Common interview mistakes",
      blocks: [
        {
          callout:
            "\"I'll use Cassandra because it scales\" with no number behind it. The interviewer will ask how many writes a second, and 200 is not a reason. Then they'll ask how you find a payment by merchant and date, and you'll be designing a second table and a consistency story to answer a query Postgres does with an index.",
          kind: "pitfall",
          title: "NoSQL for \"scale\" without a reason",
        },
        {
          p: "The other mistakes are close relatives.",
        },
        {
          list: [
            "Naming a product before the access patterns. Say the queries first; the product should sound like a consequence.",
            "Using a search index or a cache as the source of truth. Both lose or delay writes by design.",
            "A store per service on day one. Five databases means five backup, failover and upgrade stories for a team of six.",
            "Forgetting what you gave up. If you pick DynamoDB, say how you'll do the report, the back-office search and the schema change.",
            "Treating \"eventually consistent\" as a property of a product. Postgres with an async replica is eventually consistent on that replica; Cassandra at quorum reads and writes isn't, for a single key.",
            "Sharding in the first ten minutes. Shard when one primary can't take the writes, and say what that number is.",
            "Ignoring operations. Who restores it at 3 a.m., how long does a restore of 2 TB take, and has anyone tried?",
          ],
        },
        {
          callout:
            "Pick the most boring store that fits the hardest query, then name what you'd add and the number that would make you add it.",
          kind: "rule",
        },
        {
          see: [
            { href: "#/s/quorum", label: "Quorum reads and writes", why: "What consistency a leaderless store gives for one key, and when a read can still be stale." },
            { href: "#/s/consistent-hashing", label: "Consistent hashing", why: "How a ring of nodes shares keys, and what moves when a node joins." },
          ],
        },
      ],
    },
  ],
  unverified: [
    "'Thousands of simple write transactions a second and a few terabytes are ordinary' for one Postgres primary: a rough figure from experience and memory, dependent on hardware and row size; no benchmark checked.",
    "'Under a few thousand writes a second and a few terabytes, one primary copes' and 'only shard past several thousand writes a second': rules of thumb, not measured.",
    "Object storage latency of 'tens of milliseconds': approximate, from memory.",
    "Elasticsearch refresh being near real time (about a second by default): from memory.",
    "DynamoDB global secondary indexes being eventually consistent and billed for their writes; DynamoDB supporting transactions: from memory of AWS documentation.",
    "Cassandra at quorum reads and writes being consistent for a single key: holds when R + W > N and ignores failed writes that were partly applied and clock-based conflict resolution.",
    "Time-series stores handling many distinct label combinations badly (cardinality): well known for Prometheus and InfluxDB from memory; TimescaleDB is less affected.",
    "Graph databases being hard to spread over many machines: a general statement; some products do shard graphs.",
    "'Indexes together are often as big as the table': common in practice, not a measured figure.",
    "Postgres page size of 8 KB is the default; InnoDB's default is 16 KB (the diagram's '8 KB' applies to Postgres).",
    "'Tables in the hundreds of gigabytes' as the point where vacuum and index builds hurt: a rough threshold from memory.",
    "Archiving 'after 13 months' and the 3.65 TB a year figure are this page's example (10 million payments a day at 1 KB), not any company's.",
  ],
};

export default page;
