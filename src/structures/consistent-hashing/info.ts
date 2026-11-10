import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A consistent hash ring decides which server holds which key. Servers and keys are hashed onto the same circle, and a key belongs to the first server point clockwise from it. Because a key\'s owner depends only on its neighbours on the circle, adding or removing a server changes the owner of the keys in one arc and leaves every other key where it was.',
  watch: [
    'A lookup never asks a server where a key lives. The client hashes the key and binary-searches its own sorted list of points.',
    'Add a server and count the keys that change colour. Only the arc just behind the new point moves, and every key in it moves to the new server.',
    'Remove a server and its keys all go to the next point clockwise. That neighbour takes the whole extra load.',
    'With one point per server the arcs are very uneven: here A starts with more than half the ring. Switch to three points per server and the shares even out.',
    'The last frame of every join or leave says how many keys hash mod N would have moved. It is usually most of them.',
  ],
  complexity: [
    { op: 'Find the server for a key', average: 'O(log P)', worst: 'O(log P)', note: 'Binary search over P sorted points, where P is servers times points per server. No network call.' },
    { op: 'Add a server', average: 'about K/N keys move', worst: 'the largest arc', note: 'K keys, N servers. Inserting V points into the sorted list costs O(V log P).' },
    { op: 'Remove a server', average: 'about K/N keys move', worst: 'the largest arc', note: 'Only the keys the server held move, each to the next point clockwise.' },
    { op: 'Same change with hash mod N', average: 'about K × N/(N+1) keys move', worst: 'nearly all', note: 'Almost every key gets a different remainder when N changes.' },
  ],
  space:
    'O(P) on every client for the sorted list of points. With 100 servers and 200 points each that is 20,000 small entries, which is why some systems prefer jump hash or rendezvous hashing, which need no table.',
  usedIn: [
    {
      name: 'Amazon Dynamo',
      how: 'The 2007 Dynamo paper partitions its key space with a consistent hash ring and virtual nodes, and replicates each key to the next N distinct servers clockwise.',
    },
    {
      name: 'Apache Cassandra',
      how: 'Every node owns tokens on a ring and a row is placed by hashing its partition key. With virtual nodes each machine holds many small token ranges instead of one large one.',
    },
    {
      name: 'Riak',
      how: 'Splits the ring into a fixed number of equal partitions and hands them out to nodes, so a join moves whole partitions, not individual keys.',
    },
    {
      name: 'Memcached clients',
      how: 'Memcached servers know nothing about each other. Client libraries using the ketama scheme place around 100 to 200 points per server on a ring, so losing one cache server only empties its share of the cache.',
    },
    {
      name: 'Load balancers',
      how: 'Envoy has a ring hash policy, and NGINX and HAProxy offer consistent hashing for upstreams. It keeps a client or a cache key on the same backend while backends come and go.',
    },
    {
      name: 'Content delivery networks',
      how: 'The idea comes from a 1997 paper by Karger and others at MIT, written to spread web objects over a changing set of caches. It became the basis of Akamai.',
    },
  ],
  reachFor: [
    'Sharding keys over servers when the set of servers changes: scaling out, replacing hardware, losing a node.',
    'A cache tier, where every key that moves is a cache miss and a rehash of everything would stampede the database.',
    'Sticky routing in a load balancer, so the same user or object keeps landing on the same backend.',
    'Systems with no central directory, where every client must work out the owner on its own from a small shared view.',
  ],
  costs: [
    'Uneven load. A few random points give arcs of very different sizes. Virtual nodes fix that at the price of a bigger table and slower membership changes.',
    'It balances keys, not traffic. One very hot key still lands on one server, and no hashing scheme changes that.',
    'When a server fails, its clockwise neighbour inherits all of its load at once, unless virtual nodes have scattered its arcs among many neighbours.',
    'Every client needs the same view of the ring. Clients that disagree send the same key to different servers, so membership needs gossip or a coordination service.',
    'Keys are scattered by hash, so range scans across keys are not possible. Range partitioning keeps order but needs rebalancing by hand or by a controller.',
    'Alternatives are sometimes simpler: rendezvous hashing needs no ring, jump consistent hash needs no memory but only adds or removes the last bucket, and Redis Cluster uses 16,384 fixed hash slots assigned to nodes, which is not consistent hashing.',
  ],
  interview: [
    'Start with why mod N fails: change N and almost every key maps to a different server, so a cache goes cold or a store reshuffles everything. On a ring only about K/N keys move.',
    'Say "virtual nodes" early. Each server takes many points, which evens out the arcs, spreads a failed server\'s load over many neighbours, and lets a bigger machine take more points.',
    'Replication falls out of the ring: store each key on the next N distinct servers clockwise. With virtual nodes, skip points that belong to a server already chosen.',
    'Lookup is a binary search on the client, O(log P), with no directory service on the read path.',
    'Be clear about what it does not solve: hot keys, range queries and agreement on who is in the ring. Membership needs gossip or something like ZooKeeper or etcd.',
    'Know one alternative. Rendezvous hashing scores every server for each key and picks the highest, which is simple and even. Jump consistent hash is tiny and fast when shards are only ever added at the end.',
    'If asked about overload, mention consistent hashing with bounded loads: cap each server at a little above the average and let overflow walk on to the next point.',
  ],
};
