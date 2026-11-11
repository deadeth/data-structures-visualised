import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A stream processor such as Apache Flink keeps state, like a count per key, in the memory of its tasks. To survive a crash it takes checkpoints: a marker called a barrier flows through the job with the records, and each task saves its state when the barrier reaches it. Every saved piece then describes the same cut through the stream. After a crash, Flink restores the last completed checkpoint, rewinds the Kafka sources to the offsets saved in it, and replays. Each record then counts exactly once in the state, though some are processed twice.',
  watch: [
    'Process follows one record: read at an offset, one hop to Count, the count goes from old to new, then the result goes to three sinks.',
    'Checkpoint follows the barrier, the magenta B. Each source saves its offset and sends the barrier behind the records it has already sent. The chk tag under the log moves to the saved offset.',
    'Barrier alignment: the barrier from S0 reaches Count first. Count holds channel 0 (the red dashed edge) and buffers the next record from S0, because it belongs after the checkpoint. When the barrier from S1 arrives, Count saves its counts and then takes the buffered record.',
    'A checkpoint counts only when every task has acked: 2 sources, Count and 3 sinks make 6. Storage at the bottom shows the last completed checkpoint, and the one being written beside it.',
    'Crash, then Recover. The counts go back to the checkpoint, the sources rewind to the chk tag, and the records after it are replayed. The final comparison shows the counts match what they were before the crash.',
    'Watch the three sinks during the replay. The append-only log sink gets the same results again, in red. The upsert table gets the same values, and may briefly go back to an older one. The two-phase sink had kept those results in an open transaction, which is aborted, so its readers never see them twice.',
    'The two-phase sink commits only when a checkpoint completes, so its results become visible one checkpoint late. That delay is the price of exactly-once output.',
    'Simplified: each operation runs to the end before the next starts, so a crash never lands in the middle of a checkpoint. If it did, the half-written checkpoint would simply be ignored and the previous one used. The barrier from S1 always arrives second here, and the logs repeat a short list of keys for ever.',
  ],
  complexity: [
    { op: 'Process a record', average: 'O(1)', worst: 'O(1)', note: 'One read, one state update in memory, one write per sink. Checkpointing adds nothing per record.' },
    { op: 'Checkpoint', average: 'O(state)', worst: 'O(state)', note: 'Each task copies its state to durable storage. With incremental checkpoints in RocksDB, only the files changed since the last one are uploaded.' },
    { op: 'Barrier alignment', average: 'Short pause', worst: 'Grows with back-pressure', note: 'An operator waits on its fast inputs until the barrier arrives on the slowest. Unaligned checkpoints remove the wait.' },
    { op: 'Recovery', average: 'O(state) + replay', worst: 'O(state) + replay', note: 'Load the checkpoint, then replay everything since it: on average half a checkpoint interval of input.' },
    { op: 'Two-phase sink output', average: 'One interval late', worst: 'One interval late', note: 'Results become visible only when the checkpoint that covers them completes.' },
  ],
  space:
    'One copy of every task\'s state per retained checkpoint, in durable storage such as S3 or HDFS (Flink keeps the latest one by default). The source must keep at least the records since the last completed checkpoint, so Kafka retention must cover the checkpoint interval plus the longest outage.',
  usedIn: [
    {
      name: 'Apache Flink',
      how: 'Checkpoints use barriers, as on this page. Kafka sources store their offsets in the checkpoint itself. The Kafka sink can write in exactly-once mode, using Kafka transactions that commit when a checkpoint completes.',
    },
    {
      name: 'Kafka Streams',
      how: 'No barriers. Each state store is backed by a compacted changelog topic. With exactly-once processing, a task writes its output, its changelog updates and its input offsets in one Kafka transaction, so they commit together or not at all.',
    },
    {
      name: 'Spark Structured Streaming',
      how: 'Runs the stream as small batches. Before a batch it writes the offset range to a write-ahead log in the checkpoint folder. After a failure it re-runs that same batch. With a replayable source and an idempotent sink, output is end-to-end exactly-once.',
    },
    {
      name: 'Amazon Managed Service for Apache Flink',
      how: 'Formerly Kinesis Data Analytics. It runs Flink jobs with checkpoints turned on by default and restores from them on failure.',
    },
    {
      name: 'Chandy-Lamport (1985)',
      how: 'The barrier idea comes from the Chandy-Lamport snapshot algorithm, in which markers sent along every channel let each process record a consistent global state without stopping the system.',
    },
  ],
  reachFor: [
    'Stateful streaming where a wrong number matters: counts, sums, windows, fraud features, billing.',
    'You can replay the input. Kafka, Kinesis and files can be re-read from an offset. A plain socket or a queue that deletes on ack cannot.',
    'You need correct state after a crash without making every state update its own write to a database.',
    'Output must not repeat: pair checkpoints with a transactional sink, such as Kafka transactions, or an idempotent one, such as an upsert by key.',
  ],
  costs: [
    'Exactly-once is about the state inside the job. Side effects outside it, such as an email, an HTTP call or a plain append, still happen again on replay unless the sink is idempotent or transactional.',
    'A two-phase sink delays output by up to one checkpoint interval, and readers must ask for committed data only. In Kafka that means isolation.level=read_committed on the consumer.',
    'The transaction must outlive a checkpoint and a restart. If the Kafka transaction timeout is shorter than that, the broker aborts it and data is lost.',
    'Checkpoint interval is a trade. Short intervals mean less replay after a crash and quicker output from a two-phase sink, but more uploads. Long intervals mean the reverse.',
    'Under back-pressure, barriers queue behind the backed-up records, so alignment and checkpoints get slow. Unaligned checkpoints let barriers overtake those records and save the in-flight records as part of the checkpoint, at the cost of bigger checkpoints.',
    'In-memory state is fast but limited by the heap and copied in full each time. RocksDB keeps state on local disk, holds far more and supports incremental checkpoints, but every access pays for serialisation.',
    'If you only need at-least-once, Flink can skip alignment entirely. It is faster, and a recovery can then count some records twice.',
  ],
  interview: [
    'Name the three levels. At-most-once: no replay, so a crash loses records. At-least-once: replay from a saved position, so nothing is lost but some records are processed twice. Exactly-once: the result is as if each record was processed once.',
    'Say "effectively once". Flink processes some records twice after a crash. What it guarantees is that the state reflects each record once. Output is exactly-once only with an idempotent or transactional sink.',
    'Explain the cut: "A barrier splits the stream into before and after. Each task saves its state when the barrier passes, so all the saved pieces agree on which records they include. Restore all of them, rewind the source to the saved offsets, and replay."',
    'Why the source must be replayable: the checkpoint stores offsets, not records. Kafka keeps the records, so rewinding an offset gets them back.',
    'Barrier alignment: an operator with two inputs holds the input whose barrier came first, so records after the barrier do not leak into the snapshot. Under back-pressure this wait grows. Unaligned checkpoints fix that by saving in-flight records too.',
    'The two-phase sink is two-phase commit with the checkpoint as the decision: pre-commit when the barrier arrives, commit when the coordinator says every task has acked. See the two-phase commit page on this site for the protocol itself.',
    'Checkpoints and savepoints: checkpoints are taken by Flink for recovery and managed by it. A savepoint is the same kind of snapshot, triggered by you, kept until you delete it, and used to upgrade code, change parallelism or move a job.',
    'Compare the designs. Flink: barriers and asynchronous snapshots. Spark Structured Streaming: micro-batches, each with its offsets logged before it runs, so a failed batch is simply re-run. Kafka Streams: state in changelog topics, and output, state changes and offsets committed in one Kafka transaction.',
    'Pick the interval out loud: "Every 30 seconds to a few minutes. Shorter costs more uploads, longer means more replay and later output from the transactional sink."',
  ],
};
