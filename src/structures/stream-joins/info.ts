import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Stream processing runs a query over events as they arrive, instead of over a finished data set. A join or a count then has to remember things, so the processor keeps keyed state: for each key, the events or totals it may still need. The watermark, a running promise about how far event time has got, decides when that state can be dropped and when a window\'s result is final. This page shows the three common joins (stream with stream, stream with table, table with table in the notes) and a windowed count, on one keyed processor.',
  watch: [
    'Each timeline places events by event time, when they happened. The order they arrive in is a separate thing: a view that turns up after a later one still lands at its own tick.',
    'A click finds its impression in one hash lookup by ad id, then compares times: click − impression must be between 0 and the window. The shaded band on the other timeline is where a match has to sit.',
    'Both sides are stored, because either can arrive first. That is the cost of a stream-stream join: state for both streams over the window.',
    'Advance watermark drops every entry older than watermark − window − lateness. The keep tag shows that line. Nothing behind it can match an event that is still accepted, so no correct match is lost.',
    'The second click of the tour finds nothing. Its impression was dropped when the watermark passed. A batch job over all history could still pair any two events; a stream join gives that up to keep state bounded.',
    'A profile change overwrites the local copy, and the next order reads it with no network call. The order that arrives after the change gets the new country; one that arrived before got the old one.',
    'A tumbling window\'s count goes out only when the watermark passes its end, and is kept for the allowed lateness after that. A view for it in that time sends a corrected count; after it, the view goes to the side output.',
    'Rebuild with allowed lateness set to none and play the tour again: late events go straight to the side output, and windows are dropped as soon as they are emitted.',
    'Simplified here: one processor and one partition, the watermark moved by hand, one window length of 4 ticks, at most one event per tick on each timeline and at most 6 entries per side in state. Every event in the tour was chosen to fit.',
  ],
  complexity: [
    { op: 'Stream-stream join, per event', average: 'O(1) + O(m)', worst: 'O(m)', note: 'One hash lookup by key, then a time comparison with each of the m events kept for that key. m is the key\'s rate times the window.' },
    { op: 'Stream-table join, per event', average: 'O(1)', worst: 'O(1)', note: 'One lookup in the local copy of the table. A table change is one write.' },
    { op: 'Table-table join, per change', average: 'O(1) per match', worst: 'O(matches)', note: 'A change on either side looks up the other table and emits an updated result.' },
    { op: 'Tumbling window count, per event', average: 'O(1)', worst: 'O(1)', note: 'Work out the window, add one. A hopping window of size s and advance a updates s / a windows per event.' },
    { op: 'Expiry and closing windows', average: 'O(dropped)', worst: 'O(dropped)', note: 'Real engines register a timer per key and time, so the cost is per entry dropped, not a scan of all state.' },
  ],
  space:
    'Stream-stream: every event of both streams for the window plus the lateness. At 10,000 impressions a second, a 10-minute window holds 6 million impressions; at about 100 bytes each that is 600 MB, spread over the partitions. Stream-table: the whole table, once per processor that needs it. Table-table: both tables. A windowed count: one number per key per open window, however many events.',
  usedIn: [
    {
      name: 'Apache Flink',
      how: 'Event time and watermarks are built in. DataStream jobs have tumbling, sliding and session windows, allowed lateness and a side output for late data, and an interval join (between a lower and an upper bound) that matches this page\'s stream-stream join. Flink SQL adds temporal joins that read a versioned table as of the event\'s time. State usually lives in RocksDB and is saved by checkpoints.',
    },
    {
      name: 'Kafka Streams',
      how: 'A library inside your own service, reading and writing Kafka topics. KStream-KStream joins are windowed, KStream-KTable joins look up the current table value, and KTable-KTable joins keep both tables. Join inputs must be co-partitioned, except a GlobalKTable, which is copied in full to every instance. State stores are local RocksDB backed by changelog topics.',
    },
    {
      name: 'Spark Structured Streaming',
      how: 'Runs a streaming query as a series of small batches by default. withWatermark sets how late data may be, which lets it drop old state for windowed aggregates and for stream-stream joins that have a time condition. It also joins a stream with a static table.',
    },
    {
      name: 'Debezium and other change data capture',
      how: 'Reads a database\'s own change log (the MySQL binlog, the PostgreSQL write-ahead log) and publishes each committed row change as an event, usually to Kafka. That is the changelog stream a stream-table join keeps its local copy from.',
    },
    {
      name: 'Kafka and the append-only log page on this site',
      how: 'The input and output streams are partitions of a log. Replay from an offset is what lets a processor rebuild its state, or a fixed job reprocess history.',
    },
  ],
  reachFor: [
    'Results needed within seconds of the events: fraud checks, live dashboards, alerts, ad attribution, recommendations that react to the last few clicks.',
    'Enriching events with reference data (user, product, merchant) without a database call per event: keep a local copy fed by change data capture.',
    'Aggregates over time, such as counts per minute per key, where events arrive out of order and the answer must follow when they happened.',
    'Keeping derived stores in step with a source: a search index, a cache or a materialised view updated from the change stream.',
    'Over batch: when waiting for the nightly run is too slow. Over request-response: when the work is triggered by events rather than by a caller waiting for an answer, and many consumers want the same events.',
  ],
  costs: [
    'State is the hard part. Every join and window keeps data per key, it has to survive crashes (checkpoints) and be moved when the job is rescaled.',
    'A watermark is a guess. Too eager and correct events count as late; too cautious and every result waits. Allowed lateness buys completeness with more state and corrected results that downstream must handle.',
    'Results can change. A late firing or a table update means a result already sent was not final, so consumers need upserts by key, not appends.',
    'A stream-table join answers with the table as it is when the event is processed. Reprocess history and you may get different answers, unless the table is versioned by time.',
    'Joins need both inputs partitioned by the join key, or a repartition step that writes everything through the broker again.',
    'Harder to test and run than a batch job: time, ordering and failure all matter. If an hourly answer is fine, a batch job over the log is simpler and can be rerun.',
    'Not a database: there are no ad hoc queries over the state. Write results to a store that serves reads.',
  ],
  interview: [
    'Message brokers, log-based: Kafka (and Kinesis, Pulsar) keep messages in an append-only partitioned log for a retention period. Consumers track their own offsets, so many groups read the same data, a consumer can rewind and replay, and order holds within a partition. Parallelism is capped by the partition count, and one slow message holds up its partition. Pick it for event streams, many readers, replay, and stream processing that rebuilds state from history.',
    'Message brokers, queue-based: RabbitMQ (and SQS, ActiveMQ) hand each message to one consumer, which acknowledges it, and then it is deleted. Exchanges route by key or pattern, a failed message can be redelivered or dead-lettered on its own, and consumers can be added freely to share the load. There is no replay and order is loose once several consumers share a queue. Pick it for task queues and commands, where each job is done once and retried on its own. Newer RabbitMQ versions also offer a log-like stream type.',
    'Event time is when it happened; processing time is when the processor sees it. Mobile clients going offline, retries and partitions read at different speeds make them differ by seconds to hours. Windows and joins by event time give the same answer on replay; by processing time they do not.',
    'A watermark at T says "no more events before T are expected". It is a heuristic, often the largest event time seen minus a fixed delay. It drives when windows close and when state can be dropped. Events behind it are late: allow some lateness, send the rest to a side output, and say what happens to them.',
    'Window types: tumbling (fixed, no overlap: hits per minute), hopping (fixed size, overlapping, such as 10 minutes every minute; Flink calls these sliding), sliding (a window that follows each event, such as the last 10 minutes before it) and session (closes after a gap of inactivity, so its length varies per user).',
    'The three joins and their state: stream-stream needs both sides kept for the window, so state is rate times window on both sides. Stream-table keeps the whole table and nothing from the stream, and the answer depends on which arrived first. Table-table keeps both tables in full and emits a new result whenever either side changes.',
    'Partitioning: a join only works if matching keys meet in the same processor. Both inputs must be partitioned by the join key, with the same number of partitions and the same partitioner. Otherwise repartition one side first, or broadcast a small table to every processor.',
    'Exactly-once in one breath: the engine takes consistent checkpoints of all operator state together with the input offsets, and on failure rewinds both to the last checkpoint. Effects inside the engine then count once; output to the outside world needs transactions or idempotent writes. The checkpoint page on this site shows how the barriers work.',
    'Size the state out loud: "10,000 clicks a second, a one-hour attribution window: 36 million impressions kept, a few GB, so RocksDB on local disk and partition by ad id." Then say what you give up: a click more than an hour late is not attributed.',
  ],
};
