import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'MapReduce runs one computation over a large, unchanging input on many machines. Map turns each record into key and value pairs, the shuffle sends every pair with the same key to the same reducer, sorted, and reduce handles one key at a time. Joins work the same way: bring matching records to the same key, or ship the small side to every mapper so nothing has to move.',
  watch: [
    'The partition step is the only routing decision: h(key) mod reducers. Every pair with key u4, from every map task, gets the same answer, which is the whole reason a reducer can total u4 on its own.',
    'Each map task sorts its output before the shuffle. Then a reducer only ever compares the heads of a few sorted runs, and equal keys arrive next to each other, so the reduce is one pass that remembers one key.',
    'Watch "Sent over the network". The count sends all 9 pairs and the sort-merge join sends all 12 records. The broadcast join sends 0, though it reads the users table 3 times.',
    'In the sort-merge join, the user row is tagged 0 and a click 1, so u4 IT reaches the reducer just before u4\'s clicks. The reducer holds one country at a time, not a table.',
    'Follow u5 or u6 in a join. Their clicks have no user row, so an inner join drops them.',
    'Hot key: one user makes 7 of 9 clicks and all 7 go to one reducer, whatever the number of reducers. Rebuild with 3 reducers and try it: the hot reducer still gets the same 7.',
    'Comparisons counts the routing decisions, the merge comparisons and the per-record checks in the reduce. The in-memory sort inside each map task is not counted.',
  ],
  complexity: [
    { op: 'Map', average: 'O(n / M) per task', worst: 'O(n / M)', note: 'n records over M map tasks, each reading its own block, usually on the machine that stores it.' },
    { op: 'Shuffle', average: 'O(n) records moved', worst: 'O(n)', note: 'Every pair is sorted, written to the mapper\'s local disk, sent over the network and merged. Usually the most expensive phase.' },
    { op: 'Merge at a reducer', average: 'O(k log r)', worst: 'O(k log r)', note: 'k records from r sorted runs, with the run heads in a heap. The page scans the heads instead, which is O(k × r).' },
    { op: 'Reduce', average: 'O(k) per reducer', worst: 'O(n) under skew', note: 'One pass over sorted input. A hot key sends nearly everything to one reducer.' },
    { op: 'Broadcast hash join', average: 'O(n) plus S per mapper', worst: 'O(n + M × S)', note: 'S is the small table, loaded by each of M map tasks. No shuffle at all.' },
  ],
  space:
    'The input stays in the distributed file system, three copies of each block by default in HDFS. Map output is written to each mapper\'s local disk, roughly the size of what the job emits. A reducer needs memory for its merge buffers and one key at a time, not for its whole input. A broadcast join needs the whole small table in every mapper\'s memory.',
  usedIn: [
    {
      name: 'Google',
      how: 'Dean and Ghemawat described MapReduce in 2004, for jobs such as building the web search index over thousands of machines. Their paper introduced the combiner, re-running failed tasks, and backup copies of slow tasks near the end of a job.',
    },
    {
      name: 'Apache Hadoop',
      how: 'The open-source version: HDFS for storage, MapReduce for computation, YARN for scheduling since Hadoop 2. HDFS splits files into blocks (128 MB by default), keeps three copies of each by default, and a NameNode holds the file system metadata: which blocks make up each file and where they are.',
    },
    {
      name: 'Apache Hive',
      how: 'Compiles SQL into batch jobs, at first MapReduce and later Tez or Spark. It can turn a join with a small table into a map join, which is the broadcast hash join on this page, and bucketed tables allow joins without a full shuffle.',
    },
    {
      name: 'Apache Spark',
      how: 'Largely replaced MapReduce for new work. A job is a graph of stages; operations that need no shuffle, such as map and filter, run together in memory within a stage. Lost partitions are rebuilt from their lineage. Spark SQL broadcasts a join side under 10 MB by default (spark.sql.autoBroadcastJoinThreshold), and adaptive execution can split skewed join partitions.',
    },
    {
      name: 'Cloud data warehouses',
      how: 'BigQuery, Redshift and Databricks SQL run the same ideas behind SQL: scan in parallel, repartition by key (a shuffle), and choose between broadcast and partitioned joins in the query planner.',
    },
  ],
  reachFor: [
    'Large, bounded input that does not change while you read it: yesterday\'s logs, a database snapshot, a crawl.',
    'Throughput over latency. A nightly job that takes 40 minutes is fine if it handles terabytes and can be run again.',
    'Rebuilding derived data from scratch: search indexes, recommendations, aggregates and machine learning features. If the code had a bug, fix it and run the job again over the same input.',
    'Backfills: a new metric over two years of history that a streaming system never saw.',
    'Joins too large for one machine. A sort-merge join needs neither side to fit in memory.',
  ],
  costs: [
    'Latency. A job starts tasks, reads everything, shuffles and writes. Minutes at best. For answers in seconds use a stream processor or an indexed database.',
    'The shuffle. Every record is sorted, written to local disk, sent across the network and merged. A combiner, which reduces on the map side, cuts this when the operation allows it (sums, counts, max).',
    'Chains of jobs. Classic MapReduce writes each job\'s output to HDFS, replicated three times, before the next job can read it. A pipeline of ten steps pays that ten times. This is the main reason Spark and Flink replaced it.',
    'Skew. A hot key goes to one reducer, and the job finishes when that reducer does. More reducers do not help; a combiner, salting the key or a broadcast join does.',
    'Small files and small jobs. Each task has a fixed start-up cost, and the NameNode keeps every file and block in memory, so millions of tiny files hurt.',
    'Only map, then reduce. Iterative work, such as a graph algorithm that runs 20 rounds, becomes 20 jobs that each re-read their input from disk.',
  ],
  interview: [
    'Say why batch: the input is bounded and immutable, so a job can be run again and give the same answer. That makes failures cheap (re-run a task) and bugs fixable (re-run the job). Optimise for throughput, not latency.',
    'HDFS in three sentences. Files are split into large blocks, 128 MB by default. Each block is stored on three machines by default, so losing a disk loses nothing. A NameNode keeps the metadata in memory: the file names, which blocks make up each file and which machines hold them.',
    'Data locality: the scheduler runs each map task on, or near, a machine that already holds its block, so the code moves to the data instead of the data to the code.',
    'Fault tolerance is re-execution. A map or reduce task is a pure function of its input, so when a machine dies its tasks simply run again elsewhere. Map output lives on the mapper\'s local disk, so finished map tasks on a dead machine are re-run too. Slow tasks near the end get a backup copy, and whichever finishes first wins.',
    'The shuffle is the expensive part: partition by hash(key) mod reducers, sort, write to local disk, copy over the network, merge. Everything you do to speed up a job is about shuffling less: a combiner, filtering early, a broadcast join, or data already partitioned by the join key.',
    'Combiners: a reduce that runs on each mapper\'s output before the shuffle. It is only correct when the operation is associative and commutative, like sum, count or max. An average needs a combiner that emits (sum, count), not the average itself.',
    'Three joins. Sort-merge (reduce-side): map both sides to (key, tagged record), shuffle and sort, join in one pass. It works for any sizes but shuffles everything. Broadcast hash join (map-side): copy the small side into every mapper\'s memory, no shuffle; pick it when one side fits in memory. Partitioned hash join: when both sides are already partitioned the same way on the join key, with the same number of partitions, each mapper joins one partition of each side with no shuffle.',
    'Skew: one hot key overloads one reducer. Name the fixes: a combiner, salting the key with a random suffix and adding the parts in a second step, broadcasting the small side, or for a skewed join, splitting the hot key\'s records and copying its matching row to each split. Spark\'s adaptive execution splits skewed join partitions automatically.',
    'Why Spark replaced MapReduce: a job is a whole graph of steps, not one map and one reduce. Steps with narrow dependencies, where each output partition needs one input partition (map, filter), are pipelined in memory within a stage. Wide dependencies, which need a shuffle (groupByKey, a join), start a new stage. Intermediate results are not written to HDFS between steps. A lost partition is recomputed from its lineage, the recorded chain of transformations, rather than restored from a replica. Spark still writes shuffle files to local disk.',
    'Where batch sits today: nightly ETL into a warehouse, backfills, training data and features for machine learning, index builds, and the batch half of a pipeline that also streams. The engines changed (Spark, Flink, warehouse SQL); the model of partition, shuffle and aggregate did not.',
  ],
};
