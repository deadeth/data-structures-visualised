import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A priority queue hands back the most urgent item first, whenever it arrived. Here a smaller number is more urgent, as in Python\'s heapq and in shortest-path search. This page shows the simple way to build one: keep an array sorted, largest key first, so the most urgent key is always the last one and leaves without anything else moving. It is the simple version, not the one real libraries use: they use a binary heap.',
  watch: [
    'Insert has two halves. Binary search finds the slot in a handful of comparisons. Then every smaller key shifts one slot to the right to open a gap.',
    'During the search, lo and hi mark the window that could still hold the slot. Each comparison rules out half of it, and the ruled-out half goes grey.',
    'Compare the two counters after an insert. Comparisons grow with log n. Slot writes grow with n, and they are the real cost.',
    'Insert a key smaller than everything and nothing shifts. Insert one larger than everything and every key shifts.',
    'Taking the most urgent item is one write at the end of the array. That is why the array is sorted largest first: at the front, removal would shift everything.',
    'A key that is already queued is left alone. This page keeps one copy of each key so every comparison has a clear answer.',
  ],
  complexity: [
    { op: 'Peek at the most urgent', average: 'O(1)', worst: 'O(1)', note: 'Always the last slot in use.' },
    { op: 'Insert', average: 'O(n)', worst: 'O(n)', note: 'About log2 n comparisons to find the slot, then one shift for every smaller key: n/2 on average for random keys, n in the worst case.' },
    { op: 'Take the most urgent', average: 'O(1)', worst: 'O(1)', note: 'Clear the last slot and lower size. Nothing else moves.' },
    { op: 'Binary heap: insert', average: 'O(1)', worst: 'O(log n)', note: 'For contrast. A new key climbs at most one level per comparison and usually stops early. See the Binary heap page.' },
    { op: 'Binary heap: take the most urgent', average: 'O(log n)', worst: 'O(log n)', note: 'For contrast. The heap never pays O(n) for either operation.' },
    { op: 'Unsorted list: insert', average: 'O(1)', worst: 'O(1)', note: 'For contrast. Append at the end and do no other work.' },
    { op: 'Unsorted list: take the most urgent', average: 'O(n)', worst: 'O(n)', note: 'For contrast. Every item must be checked to find the smallest.' },
  ],
  space: 'O(capacity): one array with no pointers. This version has a fixed capacity. A growable one would double the array when it fills, as the Stack page shows.',
  usedIn: [
    {
      name: 'Java PriorityQueue, Python heapq, Go container/heap',
      how: 'The standard priority queues in all three languages are binary heaps, not sorted arrays. The Binary heap page animates that version.',
    },
    {
      name: 'Python bisect.insort',
      how: 'This page\'s insert as a library call: binary search for the slot, then shift the rest of the list along. The documentation warns that the O(log n) search is dominated by the O(n) insertion.',
    },
    {
      name: 'Dijkstra and A*',
      how: 'The frontier is a priority queue keyed by distance or estimated cost, smallest first. Each step takes the cheapest node and inserts its neighbours.',
    },
    {
      name: 'Timers',
      how: 'Java\'s ScheduledThreadPoolExecutor, Python\'s asyncio and the Go runtime all keep pending timers in a heap keyed by due time, so the next one to fire is always on top.',
    },
    {
      name: 'Linux plist',
      how: 'The kernel\'s priority-sorted list is the same idea as this page on a linked list: sorted insert, cheap removal of the first. It orders the tasks waiting on a futex, where the list is usually short.',
    },
    {
      name: 'Linux fair scheduler',
      how: 'Runnable tasks sit in a red-black tree ordered by virtual runtime, and the scheduler picks the leftmost. A balanced tree gives O(log n) insert plus removal of any task, which a heap does not.',
    },
    {
      name: 'Kubernetes scheduler',
      how: 'Pods waiting to be placed sit in a heap ordered by priority and then by arrival time, so the most important pod is scheduled next.',
    },
  ],
  reachFor: [
    'You always want the most urgent item next, not the oldest: job schedulers, timers, retry queues, shortest-path search.',
    'The sorted-array version suits a small queue, a few dozen items at most. One contiguous array is fast to shift and easy to get right.',
    'It also suits a queue that is read far more often than it is written, or one where you need the items in order, since the array is always sorted.',
    'For anything larger or write-heavy, use a binary heap. That is what your language\'s standard library gives you.',
  ],
  costs: [
    'Insert is O(n). Binary search trims the comparisons to about log n, but the shifting stays linear, so the search is not where the time goes.',
    'Keys that arrive in increasing order are the worst case here: each one is the largest so far and shifts the whole array.',
    'Strict priority can starve. A steady flow of urgent items means a low-priority item may never leave. Real schedulers raise the priority of items that have waited a long time.',
    'Equal priorities need a tie-break rule. The usual one is a sequence number, so that equal items leave in order of arrival.',
    'It lives in the memory of one process. A priority queue shared by many workers is usually a database index or a Redis sorted set.',
  ],
  interview: [
    'Give the three-way trade. "A sorted array inserts in O(n) and removes the minimum in O(1). An unsorted list inserts in O(1) and removes in O(n). A binary heap does both in O(log n), which is why Java\'s PriorityQueue, Python\'s heapq and Go\'s container/heap are all heaps."',
    'Explain why binary search does not rescue the sorted array. "Finding the slot takes log n comparisons, but opening the slot shifts up to n items. The total is still O(n)."',
    'Say when the simple version is good enough: a small, bounded queue, or one that is mostly read. Shifting a few dozen integers that sit side by side in memory is very fast, and the code has no tricky cases.',
    'Say what a heap cannot do. It gives no sorted iteration, no rank and no cheap search. If you need "the 10 most urgent" or "everything due before noon", a sorted structure such as a balanced tree or a skip list is the better fit.',
    'Make ties stable with a sequence number. Python\'s heapq documentation suggests storing (priority, count, task), so that equal priorities leave first come, first served.',
    'Mention starvation and the usual cure. Ageing raises an item\'s priority the longer it waits, so low-priority work still gets through.',
    'For a priority queue across machines, say what replaces the in-memory structure: a Redis sorted set scored by priority or due time, or simply one queue per priority level with workers draining the highest first.',
  ],
};
