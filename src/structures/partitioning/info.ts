import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Partitioning (sharding) splits one table across several nodes so that no single machine has to hold all the data or take all the writes. Each row belongs to exactly one partition, chosen from its key either by key range or by a hash of the key. The choice decides which queries stay on one node and which have to ask them all, and a secondary index adds the same choice again: index each partition locally, or partition the index by its own term.',
  watch: [
    'Put and get ask one partition. Under range partitioning the key is compared with the sorted boundaries; under hash it is hashed and taken mod the fixed number of partitions. Either way the other partitions never hear of it.',
    'The range scan from 300 to 420 asks 2 adjacent partitions under range partitioning. The same scan at the end of the tour, under hash, asks all 6, because hashing scatters neighbouring keys.',
    'Hot keys: four timestamps in a row all land in the partition that owns the newest keys, and the other nodes do nothing. Leading the key with a sensor number spreads the same writes over three nodes.',
    'Rebalance under range: node D joins, the over-full partition splits at its median, and only the upper half moves. Every other partition stays where it was.',
    'Find by city with local indexes asks every partition, including ones with no match. With the global index it asks the one index partition that owns the city.',
    'Rebuild with "Hash of key" and press Rebalance: whole partitions move to node D, no key changes partition, and the last frame counts how many rows hash mod number of nodes would have moved.',
  ],
  complexity: [
    { op: 'Get or put by key', average: '1 partition', worst: '1 partition', note: 'Routing is a comparison with P boundaries (binary search in practice) or one hash. Put with a global index also writes one index partition.' },
    { op: 'Range scan, range partitioning', average: 'the partitions it overlaps', worst: 'all P', note: 'Adjacent partitions, read in key order. A short scan is usually 1 or 2.' },
    { op: 'Range scan, hash partitioning', average: 'all P', worst: 'all P', note: 'Scatter to every partition, gather and sort. Latency is the slowest of P answers.' },
    { op: 'Find by a secondary attribute, local index', average: 'all P', worst: 'all P', note: 'Each partition indexes only its own rows. Writes stay on one partition.' },
    { op: 'Find by a secondary attribute, global index', average: '1 index partition', worst: '1 plus a get per match', note: 'Plus a read by key for each row if the index holds only keys. Each write also updates the index, usually asynchronously.' },
    { op: 'Rebalance', average: 'about K/N rows move', worst: 'one partition per move', note: 'K rows, N nodes. Fixed partitions or a split move whole partitions. Hash mod N moves about K × N/(N+1).' },
  ],
  space:
    'No extra copies of the rows: each lives in one partition (replication is separate and multiplies everything). Routing needs a small table of P boundaries or P partition owners. A local index adds one entry per row in the row\'s own partition; a global index adds one entry per row somewhere else, so a write touches two partitions.',
  usedIn: [
    {
      name: 'HBase and Bigtable',
      how: 'Partition by key range into regions (tablets). A region that grows too big splits in two, and the halves can be served by different servers. Row keys are kept sorted, so scans are cheap and timestamp-led keys make one region hot.',
    },
    {
      name: 'Apache Cassandra',
      how: 'A compound primary key: the partition key is hashed to place the row, and the clustering columns sort rows inside that partition. So (sensor, time) spreads sensors over nodes and still reads one sensor\'s time range in order.',
    },
    {
      name: 'Amazon DynamoDB',
      how: 'Hashes the partition key. A local secondary index keeps the table\'s partition key with a different sort key, must be defined when the table is made, and supports strongly consistent reads. A global secondary index has its own partition key, is partitioned on its own, and is updated asynchronously, so its reads are eventually consistent.',
    },
    {
      name: 'Elasticsearch',
      how: 'Routes each document to a shard by hashing its id, and every shard keeps its own index of the documents it holds. A search goes to every shard and the results are merged: scatter and gather. The number of primary shards is set when the index is made; changing it means splitting, shrinking or reindexing.',
    },
    {
      name: 'Redis Cluster',
      how: 'Fixed partitions: 16,384 hash slots, slot = CRC16(key) mod 16384, and each node owns some slots. Resharding moves slots between nodes. A hash tag such as {user42} makes several keys hash alike, so they share a slot.',
    },
    {
      name: 'MongoDB',
      how: 'Shards a collection by range or by a hashed shard key. Data is kept in chunks, each a range of shard key values, a balancer moves chunks between shards to even them out, and mongos routers send each query to the shards that can hold the answer.',
    },
    {
      name: 'Apache Kafka',
      how: 'Picks a topic partition from a hash of the record key, mod the number of partitions. Adding partitions later changes where a key goes, which breaks per-key ordering across the change.',
    },
  ],
  reachFor: [
    'Data or write traffic too big for one node. Partitioning is how a store scales writes, not just reads.',
    'Range partitioning when queries scan by key order: time series per device, rows by user then date, anything with "between".',
    'Hash partitioning when keys arrive in order (timestamps, auto-increment ids) or are skewed, and queries are mostly by exact key.',
    'A compound key, hash the first part and sort by the rest, when you need both: spread by user or device, scan in time order within one.',
    'A global secondary index when reads by that attribute are frequent and must be cheap, and a slightly stale answer is acceptable.',
  ],
  costs: [
    'Anything that is not by partition key fans out. A query by another attribute asks every partition unless a global index exists, and the slowest partition sets the response time.',
    'Range partitioning is open to skew. Sequential keys send every write to one partition, and choosing boundaries well needs knowledge of the data or automatic splitting.',
    'Hash partitioning gives up key order: a range scan asks every partition. Hashing spreads keys, not load; one very hot key still lands on one partition.',
    'A global index makes every write touch two partitions, and keeping them in step needs a distributed transaction, which most stores avoid by updating the index asynchronously. Reads by index can then miss recent writes.',
    'Rebalancing costs network and disk while it runs and competes with live traffic. Many teams keep a human in the loop rather than let a store move data on its own.',
    'A transaction across partitions needs coordination, usually two-phase commit, which costs extra round trips and blocks if the coordinator fails. Design keys so that what changes together lives together.',
  ],
  interview: [
    'Say why first: one node cannot hold the data or take the write rate. Then say the key question: which partition does a row belong to, and what does that do to the queries we need?',
    'Range versus hash in one line each. Range keeps order, so scans are cheap, but sequential keys make a hot spot. Hash spreads the load, but every range scan becomes scatter and gather.',
    'Never place by hash mod N nodes. Going from 10 nodes to 11 moves about 10 rows in 11. Instead create many more partitions than nodes up front, say 1,000 for 10 nodes, and move whole partitions when nodes come and go. Or split ranges dynamically, as HBase does, or use consistent hashing.',
    'Hot spots: for timestamps, lead the key with something that varies, such as a device id. For one celebrity key, add a small random suffix to spread its writes, and accept that reads must then ask every suffix.',
    'Secondary indexes: a local index keeps writes on one partition but makes reads ask all of them. A global index makes reads hit one partition but makes writes touch two and lag. Name DynamoDB\'s LSI and GSI, and Elasticsearch\'s scatter and gather.',
    'Request routing has three shapes: the client knows the partition map, a routing tier knows it (MongoDB\'s mongos), or any node accepts the request and forwards it (Cassandra, which spreads membership by gossip). The map itself usually lives in a coordination service such as ZooKeeper or etcd, or is gossiped.',
    'Cross-partition writes: if one request must change rows on two partitions atomically, that is a distributed transaction and needs two-phase commit (see that page). Better to choose a partition key that keeps an entity\'s rows together.',
    'Be ready with numbers: how many partitions per node, how big each is, and how long moving one takes. A 10 GB partition over a 1 Gbit/s link is about 80 seconds of copying before catch-up.',
  ],
};
