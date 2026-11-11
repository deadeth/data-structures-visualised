import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A geospatial index answers "what is near here?" with an index that can only sort one thing. A geohash halves the map again and again, writes down which half the point is in, and interleaves the x and y bits into one code; nearby points then share a prefix and sit together in a sorted list. A quadtree splits the map into four only where points crowd together, and searches by skipping every square that is too far away.',
  watch: [
    'Insert builds the code one halving at a time: x, then y, then x again. Watch the map dim to the half the point is not in, until one cell of 64 is left after 6 bits.',
    'In the sorted list, codes that share a prefix sit together. A shared first 4 bits means the same 2×2 block.',
    'The tour\'s first search is the boundary problem. Q at (3, 4) has A in its own block, but B at (4, 4) is 1 away, across the widest edge on the map, and its code starts with 1 where Q\'s block starts with 0. Only the scan of the neighbouring blocks finds it.',
    'Each block is its own range of the list, so a search costs up to 9 seeks. The square blocks also hold points that are outside the circle: the distance filter drops them, drawn in red.',
    'The box query reads one range from the code of the lower-left corner to the code of the upper-right. Points on the Z curve\'s detour out of the box are read and thrown away.',
    'After Switch index the same points sit in a quadtree. The grey squares are its leaves: one big square where the map is empty, small ones where it is crowded.',
    'Inserting L into the south-east quadrant gives it 3 points with room for 2. It splits into four and hands each point down.',
    'The last search starts at the root and prunes three of its four quadrants with one comparison each, without reading a single point inside them.',
  ],
  complexity: [
    { op: 'Geohash: encode a point', average: 'O(bits)', worst: 'O(bits)', note: 'One comparison per bit. Real geohashes use up to 60 bits; Redis uses 52.' },
    { op: 'Geohash: insert or delete', average: 'O(log n)', worst: 'O(log n)', note: 'One write to a sorted structure: a B-tree, a skip list, an ordered key-value store.' },
    { op: 'Geohash: near', average: 'O(9 log n + k)', worst: 'O(n)', note: 'Up to 9 range scans, then a distance filter over the k points read. Worst case: everything sits in the 9 blocks.' },
    { op: 'Quadtree: insert', average: 'O(depth)', worst: 'O(depth + capacity × splits)', note: 'Two comparisons per level, plus a split when a leaf overflows.' },
    { op: 'Quadtree: near or box', average: 'O(log n + k)', worst: 'O(n)', note: 'For points spread evenly. Pruning decides the cost: a big radius prunes little.' },
    { op: 'Move', average: 'O(log n)', worst: 'O(log n)', note: 'Delete and insert again, when the point changes cell. Moves inside one cell need no index write.' },
  ],
  space:
    'Geohash: one entry per point, its code (8 bytes) plus an id, in a structure the database already has. Quadtree: the points plus about 4 child pointers for each split node; with capacity c there are at most about n ÷ c split nodes. Neither needs space for empty map, which a plain grid of buckets would.',
  usedIn: [
    {
      name: 'Redis',
      how: 'GEOADD stores each member in a sorted set, with a 52-bit interleaved geohash as its score. GEOSEARCH works out the geohash boxes that cover the radius, the centre box and its 8 neighbours, reads each as a score range, then filters by real distance.',
    },
    {
      name: 'PostGIS',
      how: 'Spatial indexes are R-trees built on PostgreSQL\'s GiST framework. The index holds bounding boxes; a query such as ST_DWithin first uses the boxes to find candidates, then runs the exact geometry test on each.',
    },
    {
      name: 'Elasticsearch',
      how: 'Offers geo_distance and geo_bounding_box queries on geo_point fields, and a geohash_grid aggregation that buckets points by geohash cell. Underneath, Lucene indexes points in a BKD tree, a k-d tree variant built for disk.',
    },
    {
      name: 'Uber H3',
      how: 'An open-source grid of hexagons with 16 resolutions, each cell named by a 64-bit id. A hexagon\'s 6 neighbours are all the same distance from its centre, which suits "everything within k rings of this cell" and smoothing demand across a city.',
    },
    {
      name: 'Google S2',
      how: 'Projects the sphere onto the 6 faces of a cube, builds a quadtree on each face and orders the cells along a Hilbert curve, giving 64-bit cell ids with 31 levels (0 to 30). A region is covered by a handful of cells, each one range of ids.',
    },
  ],
  reachFor: [
    'Points that move or arrive constantly, such as drivers or couriers, in a store that already sorts keys: a geohash adds geo search to Redis, Cassandra, DynamoDB or a plain B-tree with no new index type.',
    'Sharding by area: the first few characters of a geohash, or a coarse S2 or H3 cell, make a partition key that keeps a neighbourhood on one shard.',
    'Very uneven density, such as restaurants in a city centre and empty sea around it: a quadtree (or S2 cells at mixed levels) spends its depth where the points are.',
    'Shapes rather than points, such as delivery zones and roads: an R-tree, which indexes bounding boxes that may overlap.',
    'Counting or heat maps by area: group by geohash prefix or H3 cell, with no distance arithmetic at all.',
  ],
  costs: [
    'The boundary problem. Two points a metre apart can sit either side of a cell edge and share no prefix at all. Every geohash search must scan the neighbouring cells as well as its own, or it misses them.',
    'Cells are squares and searches are circles. Some of what the 9 blocks hold is too far, so a distance filter is always the last step.',
    'A fixed grid ignores density. A cell sized for Manhattan holds one point in the countryside; a cell sized for the countryside holds thousands in Manhattan. Pick the prefix length from the radius, not once for all queries.',
    'Geohash cells are not square away from the equator: a degree of longitude shrinks towards the poles, and cells are rectangles for an even number of characters anyway.',
    'A quadtree is a structure in memory, not a sort order a database already has. Sharing it across machines, or persisting it, is work you do yourself.',
    'Fast-moving objects cost an index write per cell change. Store the exact position separately, and only rewrite the index entry when the cell changes.',
  ],
  interview: [
    'Start with why a normal index fails. A B-tree on (latitude, longitude) sorts by latitude first, so "near here" becomes a thin stripe of every longitude at that latitude, then a filter. Two separate indexes give two huge stripes to intersect. You need one key that keeps both dimensions close.',
    'Explain the geohash in one breath: halve the longitude range, write 0 or 1, halve the latitude range, write 0 or 1, and repeat. Interleaving the bits draws a Z-shaped path through the map, so a shared prefix means a shared cell. Every 5 bits become one base-32 character.',
    'Precision, at the equator: 5 characters is about 4.9 km by 4.9 km, 6 is about 1.2 km by 0.6 km, 7 is about 153 m by 153 m, 8 is about 38 m by 19 m. For "drivers within 1 km", search 6-character cells: the cell and its 8 neighbours.',
    'Name the boundary problem before the interviewer does, and the fix: scan the query cell and its 8 neighbours, then filter by real distance with the haversine formula.',
    'Space-filling curves in plain words: a line that visits every cell once, so a 2D position becomes one number. The Z-order curve (geohash) is simple but jumps a long way at each half-boundary. The Hilbert curve (S2) never jumps, so a region needs fewer, longer ranges.',
    'Fixed grid against adaptive tree: a geohash is the same everywhere and lives in any sorted store; a quadtree adapts to density but lives in memory. For a city-scale ride-hailing service, a geohash or H3 cell per driver in Redis is the usual answer.',
    'For moving drivers: each sends a position every few seconds. Keep the latest position in a key-value store, and update the cell index only when the cell changes. Expire drivers who go quiet.',
    'Sharding: partition by a coarse cell, so one city or region lives on one shard. Watch for hot cells (an airport, a stadium) and split them further, which is exactly what a quadtree does.',
    'Shapes need an R-tree: it groups nearby bounding boxes into larger boxes, which may overlap, and a search descends into every box that touches the query. That is what PostGIS uses.',
  ],
};
