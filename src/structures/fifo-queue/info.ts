import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A queue hands items back in the order they arrived: first in, first out. This one is a singly linked list with two pointers. tail leads to the back, where new items join, and head leads to the front, where the oldest item leaves. Because each end has its own pointer, neither operation ever walks the list or moves another item.',
  watch: [
    'Enqueue never looks at the front. It makes a node, links it after the node tail points at, and moves tail: two pointer writes.',
    'Dequeue never looks at the back. It reads the node head points at and moves head to the next one: one read and one write.',
    'Nothing shifts. A node stays where it is from the moment it joins until it leaves, and only head and tail move.',
    'The cost does not depend on the length. Compare the counters for a queue of two items and a queue of eight.',
    'Dequeue the last item and watch the extra step: tail must be cleared as well as head. Leaving it behind is the classic bug in this structure.',
    'This page stops at eight nodes so they stay readable. The structure itself has no limit, which is its main risk.',
  ],
  complexity: [
    { op: 'Enqueue', average: 'O(1)', worst: 'O(1)', note: 'Two pointer writes at the back. No resize ever happens, so the worst case is the same as the average.' },
    { op: 'Dequeue', average: 'O(1)', worst: 'O(1)', note: 'One read and one pointer write at the front, or two writes when the queue becomes empty.' },
    { op: 'Peek at the front', average: 'O(1)', worst: 'O(1)', note: 'One read. Nothing is written.' },
    { op: 'Find a value', average: 'O(n)', worst: 'O(n)', note: 'Only the two ends are in reach. Anything else means walking from the front.' },
    { op: 'Remove from the front of a plain array', average: 'O(n)', worst: 'O(n)', note: 'For contrast. Python\'s list.pop(0) shifts every remaining item one slot forward.' },
  ],
  space: 'O(n), with one pointer per item on top of the key. Each node is its own allocation, and nothing caps how many there can be.',
  usedIn: [
    {
      name: 'Java ConcurrentLinkedQueue',
      how: 'An unbounded, thread-safe queue of singly linked nodes. It is based on the Michael and Scott algorithm, which moves head and tail with compare-and-swap in place of locks.',
    },
    {
      name: 'Java LinkedBlockingQueue',
      how: 'Linked nodes with one lock for the head and another for the tail, so a producer and a consumer rarely get in each other\'s way. Its default capacity is Integer.MAX_VALUE, and Executors.newFixedThreadPool queues waiting tasks in one.',
    },
    {
      name: 'Python collections.deque',
      how: 'A doubly linked list of fixed-size blocks, each holding 64 items, with O(1) appends and pops at both ends. queue.Queue and asyncio.Queue both keep their items in one.',
    },
    {
      name: 'Go scheduler',
      how: 'Each processor keeps runnable goroutines in a fixed ring of 256 slots. When the ring is full, half of it is moved to a global run queue, which is a linked list threaded through the goroutines themselves.',
    },
    {
      name: 'Linux socket buffers',
      how: 'Packets waiting on a socket sit in a linked list of sk_buff structures. The kernel adds at the tail as packets arrive and the reader takes from the head.',
    },
    {
      name: 'Breadth-first search',
      how: 'The frontier is a first-in, first-out queue: take a node from the front, add its unvisited neighbours at the back. That order is what visits nodes level by level.',
    },
    {
      name: 'Message queues',
      how: 'The same contract at system scale. Kafka keeps order within a partition and Amazon SQS FIFO queues keep it within a message group, because one strict order across a whole cluster does not scale.',
    },
  ],
  reachFor: [
    'Work must be handled in the order it arrived: requests, jobs, events, messages.',
    'Two parts of a system run at different speeds and need a buffer between them.',
    'Breadth-first traversal, or any algorithm that works through items level by level.',
    'Every operation must take the same short time. A linked queue never pauses to resize, unlike a growable array.',
    'Several threads share the queue. Producers touch only the tail and consumers only the head, which suits two locks or a lock-free design.',
  ],
  costs: [
    'It is unbounded. If producers outpace consumers it grows until memory runs out, and every item waits longer in the meantime. The Ring buffer queue page shows the bounded version, which pushes back when it is full.',
    'One allocation per item, and the nodes end up scattered across the heap. A ring buffer keeps items side by side in one array, which is much kinder to the CPU cache.',
    'A pointer per item. For small items the bookkeeping can take more room than the data.',
    'Only the two ends are cheap. There is no access by position, and finding or removing something in the middle is a walk.',
    'It lives in the memory of one process. If the process dies, everything waiting in the queue is lost.',
  ],
  interview: [
    'Say what makes both ends O(1): a pointer to each. With only a head pointer, enqueue would have to walk to the end. With a plain array, removing from the front shifts everything, which is why Python\'s list.pop(0) is O(n) and collections.deque exists.',
    'Ask whether the queue should be bounded before you design around it. "An unbounded queue does not fix overload, it hides it until memory runs out. I would bound it and decide what happens when it is full: block, drop or reject."',
    'Linked list or ring buffer? The ring buffer allocates nothing per item, is cache-friendly and gives backpressure. The linked queue never resizes and has no fixed limit. Between threads or services the bounded one is usually the safer default.',
    'Name the edge cases: an enqueue into an empty queue must set head as well as tail, and a dequeue of the last item must clear tail as well as head.',
    'For concurrency, point out that the two ends are separate. LinkedBlockingQueue uses one lock for each end. The Michael and Scott queue uses compare-and-swap and is the basis of ConcurrentLinkedQueue.',
    'First in, first out is fair, but one slow item at the front delays everything behind it. That is head-of-line blocking, and it is why systems add more consumers, partitions or separate queues by priority.',
    'In a distributed queue, strict order usually holds only within a partition or message group. If order matters, say which key defines the group. Delivery is often at least once, so plan for consumers that see a message twice.',
    'A queue can be built from two stacks: push onto one, pop from the other, and pour the first into the second only when the second is empty. Each item moves at most twice, so every operation is amortised O(1).',
  ],
};
