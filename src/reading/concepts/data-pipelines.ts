import type { Concept } from '../types';

const page: Concept = {
  id: 'data-pipelines',
  title: 'Data pipelines',
  group: 'Messaging',
  summary:
    "The database that takes payments is the wrong place to answer questions about them. A pipeline copies its changes into stores built for analytics and derived views. The choices are how the data leaves, how late it may be, and how you prove the copy is right.",
  minutes: 13,
  sections: [
    {
      id: 'why',
      title: 'Why data has to leave the OLTP database',
      blocks: [
        {
          p: "A transactional (OLTP) database is built for many small operations by key: read this account, insert that payment, each in a few milliseconds. An analytical question is the opposite shape: \"total volume by currency for the last 90 days\" reads hundreds of millions of rows and two columns of each.",
        },
        {
          p: "Run that on the primary and it competes with payments for memory and disk. Run it on a read replica and the load moves, but the storage is still row by row, and every analyst is now coupled to the service's private tables. So the data is copied out, into stores shaped for the questions.",
        },
        {
          diagram: {
            w: 640,
            h: 330,
            nodes: [
              { id: 'oltp', label: 'Postgres', sub: 'source of truth', x: 250, y: 20, kind: 'store', tone: 'ok' },
              { id: 'log', label: 'Kafka', sub: 'changes, in order', x: 250, y: 140, kind: 'queue' },
              { id: 'wh', label: 'Warehouse', sub: 'reports, finance', x: 30, y: 260, kind: 'store' },
              { id: 'idx', label: 'Search index', sub: 'find a payment', x: 250, y: 260, kind: 'store' },
              { id: 'agg', label: 'Dashboard totals', sub: 'per minute', x: 470, y: 260, kind: 'store' },
            ],
            edges: [
              { from: 'oltp', to: 'log', label: 'CDC or events' },
              { from: 'log', to: 'wh' },
              { from: 'log', to: 'idx' },
              { from: 'log', to: 'agg' },
            ],
          },
          caption:
            'One store is the truth. The three at the bottom are derived from it and could each be deleted and rebuilt from the log. That property is what makes a derived view safe to get wrong.',
        },
        {
          callout:
            "For every store in a design, say whether it's a source of truth or derived. A derived store can lag, can be rebuilt, and must never be written to directly. If two stores both claim the truth, you have a reconciliation problem with no referee.",
          kind: 'rule',
        },
      ],
    },
    {
      id: 'batch-vs-streaming',
      title: 'Batch ETL or streaming',
      blocks: [
        {
          p: "A batch job wakes on a schedule, extracts a slice, transforms it and loads it. A streaming job never stops: it handles each change as it arrives. The difference that matters is how stale the answer may be, and what you pay to shrink that.",
        },
        {
          diagram: {
            w: 640,
            h: 330,
            groups: [
              { label: 'Batch: hours behind', x: 10, y: 10, w: 620, h: 110 },
              { label: 'Streaming: seconds behind', x: 10, y: 135, w: 620, h: 185 },
            ],
            nodes: [
              { id: 'br', label: 'Read replica', x: 30, y: 40, kind: 'store' },
              { id: 'bj', label: 'Nightly job', sub: "02:00, yesterday", w: 160, x: 240, y: 40 },
              { id: 'bw', label: 'Warehouse', sub: 'partition per day', x: 470, y: 40, kind: 'store' },
              { id: 'sp', label: 'Postgres', x: 30, y: 165, kind: 'store' },
              { id: 'sk', label: 'Kafka', x: 250, y: 165, kind: 'queue' },
              { id: 'sj', label: 'Stream job', sub: 'keeps state', x: 470, y: 165 },
              { id: 'ss', label: 'Serving store', sub: 'totals so far', x: 470, y: 261, h: 50, kind: 'store' },
            ],
            edges: [
              { from: 'br', to: 'bj' },
              { from: 'bj', to: 'bw', label: 'replace' },
              { from: 'sp', to: 'sk', label: 'changes' },
              { from: 'sk', to: 'sj' },
              { from: 'sj', to: 'ss' },
            ],
          },
          caption:
            "The batch path has no state between runs: a failed night is fixed by running it again. The streaming path is never finished, so it has to carry state, survive restarts and decide what to do with late events.",
        },
        {
          table: {
            head: ['', 'Batch', 'Streaming'],
            rows: [
              ['Freshness', 'Hours. As fresh as the schedule.', 'Seconds.'],
              ['Failure handling', 'Re-run the job. Overwriting a whole day is idempotent by construction.', 'Checkpoints, offsets, idempotent sinks.'],
              ['Late data', "Mostly absent: by 02:00 yesterday's data has arrived.", 'A design question in every window.'],
              ['Cost to run', 'A scheduler and a job. Easy to reason about.', 'An always-on service with lag to watch and state to manage.'],
              ['What breaks', 'Extracting by `updated_at` misses deletes and every state a row passed through between runs.', 'Out-of-order events, duplicates, poison records.'],
              ['Choose it for', 'Month-end, regulatory reports, model training.', 'Fraud signals, live dashboards, search indexes, alerts.'],
            ],
          },
          caption: 'Pick by the freshness the decision needs, not by fashion.',
        },
        {
          callout:
            "\"Finance closes the books daily, so that feed is a nightly batch: simple and re-runnable. The public dashboard has a ten-second freshness target, so that one is a stream. I wouldn't build the stream for finance or the batch for the dashboard.\"",
          kind: 'interview',
        },
      ],
    },
    {
      id: 'cdc-vs-events',
      title: 'Change data capture or domain events',
      blocks: [
        {
          p: "There are two ways to get changes out continuously. **Change data capture** (CDC) tails the database's own log: a connector such as Debezium reads the Postgres write-ahead log and publishes every committed row change. **Domain events** are messages the service chooses to publish: `TransferSent`, version 4, with the fields its consumers need.",
        },
        {
          diagram: {
            w: 640,
            h: 290,
            groups: [
              { label: 'CDC: what the table looks like', x: 10, y: 10, w: 620, h: 125 },
              { label: 'Domain events: what happened', x: 10, y: 150, w: 620, h: 130 },
            ],
            nodes: [
              { id: 'cp', label: 'Postgres', sub: 'transfers table', x: 30, y: 50, kind: 'store' },
              { id: 'cd', label: 'Debezium', sub: 'reads the WAL', x: 250, y: 50 },
              { id: 'ct', label: 'db.transfers', sub: 'row before, after', x: 470, y: 50, kind: 'queue' },
              { id: 'es', label: 'Transfer service', sub: 'writes outbox row', x: 30, y: 195 },
              { id: 'er', label: 'Relay', x: 250, y: 195 },
              { id: 'et', label: 'transfer-events', sub: 'TransferSent v4', x: 470, y: 195, kind: 'queue' },
            ],
            edges: [
              { from: 'cp', to: 'cd' },
              { from: 'cd', to: 'ct' },
              { from: 'es', to: 'er' },
              { from: 'er', to: 'et' },
            ],
          },
          caption:
            'The top topic carries columns, so a renamed column breaks its consumers. The bottom topic carries a contract the owning team has agreed to keep.',
        },
        {
          table: {
            head: ['', 'CDC', 'Domain events'],
            rows: [
              ['Completeness', 'Every committed change, deletes included, in commit order.', 'Only what the team remembered to publish.'],
              ['Work for the source team', 'None in the application.', 'Design, publish and version each event.'],
              ['Meaning', '`status` went from 3 to 4. The consumer must know what 4 means.', '"The payout was sent." Intent is in the name.'],
              ['Coupling', "To the private schema. A refactor of the table breaks consumers the team may not know about.", 'To a published contract with compatibility rules.'],
              ['Operational risk', 'A stopped connector holds a replication slot and the database keeps WAL until the disk fills.', 'A dual write loses events unless an outbox is used.'],
              ['Choose it for', 'Replicating a table into a warehouse, feeding a cache or search index, legacy systems you cannot change.', 'Anything another team builds product logic on.'],
            ],
          },
          caption: 'They combine well: write domain events to an outbox table and let CDC be the relay.',
        },
        {
          see: [
            { href: '#/s/outbox', label: 'Transactional outbox', why: 'How an event is written with the row it describes, and why consumers still see repeats.' },
            { href: '#/c/message-queues-and-streams', label: 'Message queues and streams', why: 'Partitions, ordering per key, lag and replay for the log in the middle.' },
          ],
        },
      ],
    },
    {
      id: 'oltp-vs-olap',
      title: 'OLTP and OLAP stores',
      blocks: [
        {
          p: "The destination is laid out differently because the queries are. A row store keeps each row's columns together, so fetching one payment is one page read. A column store keeps each column together, so summing `amount` over a year reads that column and skips the other 48.",
        },
        {
          table: {
            head: ['', 'OLTP (Postgres, MySQL)', 'OLAP (ClickHouse, BigQuery, Snowflake)'],
            rows: [
              ['Typical query', 'One row or a few, by key.', 'Aggregates over millions of rows, a few columns.'],
              ['Layout', 'Rows, with B-tree indexes.', 'Columns, compressed, with min and max per block.'],
              ['Writes', 'Many small transactions.', 'Large appends in batches.'],
              ['Updates and deletes', 'Cheap, in place.', 'Awkward: usually rewrite a block or mark and merge later.'],
              ['Concurrency', 'Thousands of short queries.', 'Tens of heavy ones.'],
            ],
          },
          caption: 'Neither is a slower version of the other. Each is bad at what the other is for.',
        },
        {
          p: "The arithmetic is simple. A 50-column table queried on 2 columns reads 4% of the data before compression, and a column of similar values compresses several times over. Block summaries then skip whole blocks whose range can't match the filter.",
        },
        {
          see: [
            { href: '#/s/column-store', label: 'Column store', why: 'Row groups, column chunks, encodings and skipping blocks by their min and max.' },
            { href: '#/s/b-plus-tree', label: 'B+ tree', why: 'The index a row store uses to find one key.' },
          ],
        },
      ],
    },
    {
      id: 'warehouses-and-lakes',
      title: 'Warehouses and lakes, briefly',
      blocks: [
        {
          p: "A **warehouse** (Snowflake, BigQuery) is a managed column store with a SQL engine: you load tables and query them, and the vendor owns the files. A **lake** is cheaper and looser: files, usually Parquet, in object storage such as S3, readable by any engine. Loose is the problem. A directory of files has no transactions, so a reader can see half of a write.",
        },
        {
          p: "A table format such as Apache Iceberg puts that back. It keeps metadata beside the data files: each commit creates a **snapshot** that lists exactly which files make up the table. Readers pick a snapshot and see a consistent table; writers add files and swap the pointer in one atomic step.",
        },
        {
          diagram: {
            w: 640,
            h: 360,
            nodes: [
              { id: 'eng', label: 'Query engines', sub: 'Spark, Trino, Flink', w: 160, x: 240, y: 20 },
              { id: 'ice', label: 'Iceberg table', sub: 'snapshot: file list', w: 160, x: 240, y: 150, tone: 'compare' },
              { id: 'files', label: 'Parquet files', sub: 'object storage', w: 160, x: 240, y: 280, kind: 'store' },
              { id: 'ing', label: 'Ingest job', sub: 'adds files', x: 30, y: 150 },
            ],
            edges: [
              { from: 'eng', to: 'ice', label: 'which files?' },
              { from: 'ice', to: 'files', label: 'points at' },
              { from: 'ing', to: 'ice', label: 'commit' },
            ],
          },
          caption:
            'Files are never edited. A commit writes new files and publishes a new snapshot, so a reader mid-query keeps the old list and an old snapshot can be read later for audit.',
        },
        {
          p: "In an interview one sentence is enough: raw events land in the lake as Parquet for cheap, replayable history, and the modelled tables that finance queries live in the warehouse. Go further only if asked.",
        },
      ],
    },
    {
      id: 'time',
      title: 'Windows, event time and late data',
      blocks: [
        {
          p: "A stream has no end, so an aggregate needs a **window**: per minute, per hour, per session. And every event has two times. **Event time** is when it happened, set by the producer. **Processing time** is when your job saw it. They differ by milliseconds normally and by hours when a phone was offline or a consumer was lagging.",
        },
        {
          table: {
            head: ['Window', 'Shape', 'Example'],
            rows: [
              ['Tumbling', 'Fixed, back to back. Each event is in one window.', 'Volume per minute.'],
              ['Hopping (sliding)', 'Fixed length, starting every step. Windows overlap.', 'Last 24 hours, refreshed every minute.'],
              ['Session', 'Closes after a gap with no events for that key.', "One customer's app visit, ended by 30 idle minutes."],
            ],
          },
          caption: 'A 24-hour figure refreshed every minute is cheapest as 1,440 tumbling minutes added up, not as one giant sliding window.',
        },
        {
          p: "Bucket by processing time and the numbers move when the pipeline hiccups: an hour of lag piles an hour of payments into the wrong minute. Bucket by event time and the numbers are right, but you no longer know when a window is complete. A **watermark** is the job's estimate: \"I believe I've now seen everything up to 12:00:05.\" A common rule is the highest event time seen, minus an allowance for lateness.",
        },
        {
          sequence: {
            actors: ['Phone', 'Kafka', 'Stream job', 'Results'],
            messages: [
              { from: 'Kafka', to: 'Stream job', label: 'A: £480, event time 11:59:10', tone: 'visited' },
              { from: 'Kafka', to: 'Stream job', label: 'B: event time 12:00:35', tone: 'visited', note: 'Watermark = 12:00:35 minus 30 s = 12:00:05. The 11:59 window closes.' },
              { from: 'Stream job', to: 'Results', label: '11:59 total: £480', tone: 'ok' },
              { from: 'Phone', to: 'Kafka', label: 'C: £20, event time 11:59:50', tone: 'follow', note: 'The phone was offline and sent it 60 s late' },
              { from: 'Kafka', to: 'Stream job', label: 'C arrives behind the watermark', tone: 'follow' },
              { from: 'Stream job', to: 'Results', label: 'correct 11:59 to £500, or drop C', tone: 'compare' },
            ],
          },
          caption:
            'The 30-second allowance was a bet, and C lost it. The job must now either reopen a result it already published or leave £20 out. Which one is a product decision.',
        },
        {
          p: "There are three things to do with a late event, and you should name which you've picked. Drop it and count the drops, when the figure is approximate anyway. Update the published result, when the sink can take a correction. Or send it to a side output and fix the totals in a later batch. A bigger allowance makes late events rarer and every result later by the same amount.",
        },
        {
          p: "Window state has to survive a crash. A stream processor checkpoints its state together with its input offsets, so after a restart each event counts once in the state even though some are processed twice.",
        },
        {
          see: [
            { href: '#/s/stream-joins', label: 'Stream joins and windows', why: 'Keyed state, a windowed count, and the watermark deciding when state can be dropped.' },
            { href: '#/s/stream-checkpoints', label: 'Stream checkpoints', why: 'Barriers, a consistent cut, and the replay after a crash.' },
          ],
        },
      ],
    },
    {
      id: 'lambda-vs-kappa',
      title: 'Lambda and kappa',
      blocks: [
        {
          p: "Early stream processors were fast and not trustworthy, so the **lambda architecture** ran two paths. A batch layer recomputes the exact answer from all history every few hours. A speed layer keeps an approximate answer for the time since the last batch. The serving layer merges them.",
        },
        {
          diagram: {
            w: 640,
            h: 360,
            groups: [
              { label: 'Lambda: two paths, merged on read', x: 10, y: 10, w: 620, h: 205 },
              { label: 'Kappa: one path, replay to recompute', x: 10, y: 230, w: 620, h: 120 },
            ],
            nodes: [
              { id: 'le', label: 'Event log', x: 30, y: 88, kind: 'queue' },
              { id: 'lb', label: 'Batch layer', sub: 'exact, hours old', x: 250, y: 40 },
              { id: 'ls', label: 'Speed layer', sub: 'recent, approximate', w: 150, x: 245, y: 136 },
              { id: 'lv', label: 'Serving', sub: 'batch + recent', x: 470, y: 88, kind: 'store' },
              { id: 'ke', label: 'Event log', sub: 'long retention', x: 30, y: 270, kind: 'queue' },
              { id: 'kj', label: 'Stream job', sub: 'the only logic', x: 250, y: 270 },
              { id: 'kv', label: 'Serving', x: 470, y: 270, kind: 'store' },
            ],
            edges: [
              { from: 'le', to: 'lb' },
              { from: 'le', to: 'ls' },
              { from: 'lb', to: 'lv' },
              { from: 'ls', to: 'lv' },
              { from: 'ke', to: 'kj' },
              { from: 'kj', to: 'kv' },
            ],
          },
          caption:
            'Lambda writes the same business rule twice, in two systems, and the two must agree to the penny. Kappa writes it once and gets the exact answer by replaying the log through the same code.',
        },
        {
          p: "Lambda's cost is that double implementation: every change to \"what counts as volume\" is made twice and tested for agreement. **Kappa** drops the batch layer. One stream job is the only logic, and recomputing means starting a new copy of the job at offset zero. Its cost is retention and replay speed: the log, or an archive of it in the lake, must hold all the history you'd ever recompute.",
        },
        {
          p: "Most new designs are kappa-shaped with a batch escape hatch: a stream for the live view, and backfills that read history from the lake through the same transformation code.",
        },
      ],
    },
    {
      id: 'backfills',
      title: 'Backfills and replays',
      blocks: [
        {
          p: "You'll reprocess history more often than you expect: a bug in the counting rule, a new column, a new view over old events. Design for it on day one.",
        },
        {
          diagram: {
            w: 640,
            h: 260,
            nodes: [
              { id: 'log', label: 'Event log', sub: 'offset 0 onwards', x: 30, y: 100, kind: 'queue' },
              { id: 'j1', label: 'Job v1', sub: 'live, has the bug', x: 250, y: 30 },
              { id: 'j2', label: 'Job v2', sub: 'replaying from 0', x: 250, y: 170, tone: 'follow' },
              { id: 't1', label: 'totals_v1', sub: 'readers are here', x: 470, y: 30, kind: 'store' },
              { id: 't2', label: 'totals_v2', sub: 'catching up', x: 470, y: 170, kind: 'store', tone: 'compare' },
            ],
            edges: [
              { from: 'log', to: 'j1' },
              { from: 'log', to: 'j2' },
              { from: 'j1', to: 't1' },
              { from: 'j2', to: 't2' },
            ],
          },
          caption:
            'The fixed job builds a second table beside the first. Readers stay on v1 until v2 has caught up and been compared with it; then they switch, and v1 is dropped. Nothing is repaired in place.',
        },
        {
          list: [
            "Sinks must be idempotent: upsert by key, or overwrite a whole partition. A replay that appends doubles everything.",
            "Logic must be deterministic. No `now()`, and no \"current FX rate\": a replay needs the rate as it was at the event's time, so rates must be history too.",
            "Outside effects must be off. A replayed job shouldn't email a year of customers.",
            'It must be fast enough. Replaying a year at 10 times real time takes 365 / 10 = 36.5 days. You need about 100 times real time to finish in 4 days, which usually means more partitions and consumers than the live path needs.',
          ],
        },
        {
          callout:
            "Promising \"we can always replay from Kafka\" with seven days of retention and a year of data to fix. Say where the full history lives: a long-retention topic, or the lake.",
          kind: 'pitfall',
        },
      ],
    },
    {
      id: 'quality',
      title: 'Data quality checks and reconciliation',
      blocks: [
        {
          p: "A pipeline fails quietly. The job is green, the dashboard loads, and the number is wrong because an upstream team changed an enum. Checks turn silent wrongness into an alert.",
        },
        {
          table: {
            head: ['Check', 'Question it asks', 'Example threshold'],
            rows: [
              ['Freshness', 'How old is the newest row?', 'Page if the watermark is over 2 minutes behind.'],
              ['Volume', 'Did roughly the expected number arrive?', "Alert if today's count is under 50% of the same weekday last week."],
              ['Schema', 'Did a column appear, vanish or change type?', 'Block the load.'],
              ['Validity', 'Nulls, negative amounts, unknown currencies.', 'Quarantine the row; alert above 0.1%.'],
              ['Uniqueness', 'Is any key present twice?', 'Zero duplicates on transfer id.'],
              ['Reconciliation', 'Do totals match the source of truth?', "Daily count and sum per currency equal the ledger's."],
            ],
          },
          caption: 'The first five catch a broken pipeline. Only the last catches a pipeline that runs perfectly and counts wrongly.',
        },
        {
          p: "Reconciliation compares the derived store with the source by an independent path: count and sum per day and currency from the ledger, the same from the pipeline's tables, and a list of every bucket that differs. It needs a tolerance for timing (yesterday is still settling at 00:05) and an owner for the differences.",
        },
        {
          p: "Put a gate before anything public. If a check fails, don't publish the new figure: keep serving the last good one, with its timestamp. A stale number with an honest time beats a wrong number.",
        },
      ],
    },
    {
      id: 'derived-views',
      title: 'A derived view end to end: money moved',
      blocks: [
        {
          p: "The [money moved dashboard](#/d/money-moved-dashboard) design on this site is this whole page in one pipeline: a public figure for money moved in the last 24 hours, by currency, refreshed every 10 seconds.",
        },
        {
          diagram: {
            w: 640,
            h: 370,
            nodes: [
              { id: 'ts', label: 'Transfer service', sub: 'outbox', x: 30, y: 20 },
              { id: 'k', label: 'transfer-events', sub: 'key: transfer id', x: 250, y: 20, kind: 'queue' },
              { id: 'agg', label: 'Aggregator', sub: 'plain consumers', x: 470, y: 20 },
              { id: 'db', label: 'Aggregates DB', sub: 'deltas + offset, 1 tx', w: 160, x: 460, y: 150, kind: 'store', tone: 'ok' },
              { id: 'snap', label: 'Snapshot builder', sub: 'every 10 s', x: 250, y: 150 },
              { id: 'cdn', label: 'Snapshot and CDN', sub: 'one file, many readers', w: 160, x: 20, y: 150 },
              { id: 'rec', label: 'Ledger day totals', sub: 'reconciliation', w: 160, x: 240, y: 290, tone: 'compare' },
            ],
            edges: [
              { from: 'ts', to: 'k' },
              { from: 'k', to: 'agg' },
              { from: 'agg', to: 'db' },
              { from: 'db', to: 'snap' },
              { from: 'snap', to: 'cdn' },
              { from: 'rec', to: 'db', label: 'compare', dashed: true, both: true },
            ],
          },
          caption:
            'Domain events in, per-minute totals in the middle, one precomputed file out. The green store is where correctness is won: totals and the consumer offset commit in one transaction. The amber check is how anyone knows.',
        },
        {
          p: "Each choice maps to a section above. It consumes the transfer team's domain events, not CDC on their table, because the counting rule is product logic. It streams, because of the freshness target. It buckets by event time into tumbling minutes and sums the last 1,440 up to a watermark. It handles a bounce weeks later by applying a negative delta to the bucket where the transfer was first counted, so late data is an update and not a drop. Its offsets live in the same Postgres transaction as the totals, which makes replays and rebalances harmless. And its day totals are compared with the ledger's.",
        },
        {
          callout:
            "\"The dashboard reads a snapshot, never the database. Events arrive at least once, so the aggregator stores what each transfer currently counts for and applies the difference; a repeat has a difference of zero. I bucket by event time, publish up to a watermark, and reconcile day totals against the ledger so we'd know if the pipeline drifted.\"",
          kind: 'interview',
          title: 'The pipeline in four sentences',
        },
        {
          see: [
            { href: '#/d/money-moved-dashboard', label: 'Money moved dashboard', why: 'The full design: counting rule, watermark, rebalance fencing and the FX-rate story.' },
            { href: '#/c/distributed-transactions', label: 'Distributed transactions', why: 'Why the offset and the totals must commit together, and reconciliation as the backstop.' },
          ],
        },
      ],
    },
  ],
  unverified: [
    'Debezium reads the Postgres write-ahead log through a replication slot, and Postgres retains WAL while a slot is not being consumed; consistent with the outbox page on this site, not re-checked against documentation.',
    'Snowflake and BigQuery are described only as managed column stores with SQL engines; nothing about their internals or pricing was checked.',
    'ClickHouse is listed as an OLAP store, and "updates and deletes are awkward" is a general statement about column stores, not checked per product.',
    'Apache Iceberg: snapshots listing data files, atomic pointer swap on commit, reading older snapshots. Described from memory of the specification; manifest lists and catalog details are left out.',
    'Spark, Trino and Flink can all read Iceberg tables: from memory.',
    '"A column of similar values compresses several times over" is a typical range, not a measured figure.',
    'The watermark rule "highest event time seen minus an allowance" is the bounded-out-of-orderness strategy as I remember it from Flink; the 30-second allowance is illustrative.',
    'Kafka\'s default retention of seven days is from memory.',
    'The lambda and kappa descriptions follow Nathan Marz\'s and Jay Kreps\'s write-ups as I remember them; neither was re-read.',
    'All thresholds in the data quality table (2 minutes, 50%, 0.1%) are illustrative.',
    'The money moved section summarises this site\'s own design page (domain events, tumbling minutes, 1,440-minute sum, deltas and offset in one transaction, ledger comparison). It is that design, not any company\'s real pipeline.',
  ],
};

export default page;
