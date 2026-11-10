import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A graph is a set of nodes joined by edges. Nearly every graph algorithm is a traversal: start somewhere and keep a frontier of nodes you have found but not yet explored. The container that holds the frontier decides the algorithm. A queue gives breadth-first search, a stack gives depth-first search, and a priority queue ordered by distance gives Dijkstra.',
  watch: [
    'The frontier row under the graph. BFS adds at one end and takes from the other. DFS adds and takes at the same end. Dijkstra always takes the smallest distance, wherever it was added.',
    'Run BFS and DFS from the same start and compare the visit orders. BFS spreads out in rings: one hop away, then two, then three. DFS follows one route to its end before it comes back for the alternatives.',
    'In Dijkstra the number under each node is the best distance found so far. From A, watch D drop from 9 to 7 when a cheaper route through C turns up. The old queue entry for D is thrown away when it surfaces.',
    'The cheapest route from A to H uses five edges. A route with four edges exists and costs more. BFS finds the four-edge one, because it counts hops and ignores weights.',
    'A full traversal expands every node once and looks at every edge twice, once from each end. That is where O(V + E) comes from.',
  ],
  complexity: [
    { op: 'Breadth-first search', average: 'O(V + E)', worst: 'O(V + E)', note: 'Each node is queued once and each edge is checked from both ends.' },
    { op: 'Depth-first search', average: 'O(V + E)', worst: 'O(V + E)', note: 'The same work as BFS in a different order.' },
    {
      op: 'Dijkstra, binary heap',
      average: 'O((V + E) log V)',
      worst: 'O((V + E) log V)',
      note: 'Each edge can add one heap entry, and every push or pop costs O(log V).',
    },
    { op: 'List the neighbours of a node', average: 'O(degree)', worst: 'O(V)', note: 'With an adjacency list. A matrix always scans a whole row of V cells.' },
    { op: 'Is there an edge from u to v?', average: 'O(degree)', worst: 'O(V)', note: 'With an adjacency list. A matrix answers in O(1), which is what you pay the space for.' },
    { op: 'Add an edge', average: 'O(1)', worst: 'O(1)', note: 'Append to a list, or set a matrix cell.' },
  ],
  space:
    'An adjacency list takes O(V + E). An adjacency matrix takes O(V²) whether the edges exist or not, so it only suits small or dense graphs. A traversal needs O(V) more for the seen set and the frontier.',
  usedIn: [
    {
      name: 'OSPF and IS-IS',
      how: 'Link-state routing protocols. Every router holds a map of the network and runs Dijkstra over it to work out the shortest path to each destination.',
    },
    {
      name: 'make, Bazel, npm',
      how: 'Build tools and package managers treat targets or packages as a dependency graph and sort it topologically, so each thing is handled after the things it depends on.',
    },
    {
      name: 'Garbage collectors',
      how: 'Tracing collectors, such as those in the JVM, Go and V8, start from the roots (stacks and globals) and traverse the object graph. Whatever they cannot reach is garbage.',
    },
    {
      name: 'Social networks',
      how: '"How many steps from me to this person" is a fewest-hops question, so it is answered with BFS, often run from both ends at once.',
    },
    {
      name: 'Jaeger, Zipkin',
      how: 'Distributed tracing tools build a service dependency graph from recorded calls. Walking it shows what a failing service can take down with it.',
    },
    {
      name: 'Road routing (OSRM, GraphHopper)',
      how: 'Dijkstra with help. A* steers the search towards the destination, and contraction hierarchies precompute shortcut edges so long routes are answered in milliseconds.',
    },
  ],
  reachFor: [
    'The data is about relationships: who follows whom, which service calls which, which task has to finish first.',
    'BFS when you want the fewest hops, or everything within a few hops of a start.',
    'DFS when you need to explore whole branches: topological order, cycle detection, connected components.',
    'Dijkstra when edges have different costs, none of them negative, and you want the cheapest route.',
  ],
  costs: [
    'Dijkstra gives wrong answers with negative weights, because it treats a settled distance as final. Bellman-Ford copes with them, at O(V × E).',
    'A traversal touches everything it can reach. On a big graph a few hops fan out fast, because some nodes have a huge number of neighbours.',
    'An adjacency list cannot say whether two nodes are joined without scanning a neighbour list. Keep the neighbours in a hash set if you ask that often.',
    'Recursive DFS can overflow the call stack on a deep graph. An explicit stack, as on this page, avoids that.',
    'Graphs do not partition cleanly. However you shard the nodes, many edges will cross shards.',
  ],
  interview: [
    'BFS in one line: a queue, nearest first, finds the fewest hops on an unweighted graph, and its memory grows with the width of the graph.',
    'DFS in one line: a stack, one branch to its end, the basis of topological sort, cycle detection and strongly connected components, and its memory grows with the depth.',
    'Dijkstra is BFS with a priority queue in place of the queue. Say that it needs non-negative weights and costs O((V + E) log V) with a binary heap. A* is the same algorithm with an estimate of the remaining distance added to the priority.',
    'Adjacency list against matrix: the list takes O(V + E) space and lists neighbours in O(degree). The matrix takes O(V²) and answers "is there an edge?" in O(1). Real graphs are sparse, so the list is the default.',
    'Storing a large graph: adjacency lists in a key-value store (node id to neighbour ids) for fast one-hop reads, an edge table in SQL with an index on each end when you already run a relational database, or a graph database when multi-hop queries are the main workload.',
    'Why multi-hop queries hurt on a sharded graph: each hop fans out to whichever shards hold the neighbours. Two hops from a user with 500 friends is 500 more lookups spread across the cluster, and the third hop multiplies that again.',
    'Precompute when the question is fixed and reads far outnumber writes: friend-of-friend counts, the transitive closure of a small dependency graph, shortcut edges for a road map. The price is keeping the answer fresh as edges change.',
    'For "how far apart are these two users", search from both ends and stop when the frontiers meet. Each side only has to go half the distance, so far fewer nodes are touched.',
  ],
};
