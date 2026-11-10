import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A ring buffer is a fixed array used as a queue. Two indices chase each other round it: tail says where the next item is written, head says where the next one is read. When an index runs off the end it wraps back to slot 0, so nothing is ever shifted and nothing is allocated.',
  watch: [
    'Each operation makes one comparison: is the buffer full, or is it empty? After that it is one write or one read, and one index update.',
    'Watch tail go from the last slot back to slot 0. The sum on screen is the whole trick: tail = (tail + 1) mod capacity.',
    'Head and tail share a slot in two different situations, when the buffer is empty and when it is full. The size count is what tells them apart.',
    'When the buffer is full the enqueue is rejected and nothing is written. The key stays with the producer, which has to decide what to do with it.',
    'A dequeued slot is cleared here so you can see it is free. Real ring buffers usually leave the old value in place and only move head.',
  ],
  complexity: [
    { op: 'Enqueue', average: 'O(1)', worst: 'O(1)', note: 'One check, one write, one index update. No allocation and no resizing.' },
    { op: 'Dequeue', average: 'O(1)', worst: 'O(1)', note: 'One check, one read, one index update. Nothing shifts along.' },
    { op: 'Peek at the head', average: 'O(1)', worst: 'O(1)' },
    { op: 'Find a value', average: 'O(n)', worst: 'O(n)', note: 'A queue is not built for searching.' },
  ],
  space: 'O(capacity), allocated once. It never grows, and that is the point.',
  usedIn: [
    {
      name: 'LMAX Disruptor',
      how: 'A pre-allocated ring buffer that passes events between threads on the LMAX exchange. Producers and consumers each track a sequence number rather than share a locked queue, and the size must be a power of two.',
    },
    {
      name: 'Linux kfifo',
      how: 'The kernel’s general-purpose FIFO. Sizes are powers of two so an index wraps with a bit mask, and one reader with one writer needs no lock.',
    },
    {
      name: 'io_uring',
      how: 'The submission queue and the completion queue are ring buffers in memory shared between the application and the kernel, so many requests and results can cross with few system calls.',
    },
    {
      name: 'Network cards',
      how: 'Drivers exchange packets with the card through RX and TX descriptor rings. When the RX ring is full, arriving packets are dropped.',
    },
    {
      name: 'Go buffered channels',
      how: 'A buffered channel is a circular buffer guarded by a lock. A send to a full channel blocks the goroutine, which is backpressure built into the language.',
    },
    {
      name: 'Audio buffers',
      how: 'Sound APIs pass samples between the application and the device through a ring buffer. If the reader catches up with the writer you hear an underrun as a click or a gap.',
    },
    {
      name: 'Kernel log (dmesg)',
      how: 'The Linux kernel log is a fixed-size ring buffer that overwrites its oldest messages, which is why dmesg only goes back so far.',
    },
  ],
  reachFor: [
    'A buffer between a stage that produces work and a stage that consumes it, where each runs at its own pace.',
    'You need a hard upper bound on memory and a clear answer to what happens under overload.',
    'Hot paths where allocating per item or chasing pointers is too slow: packet handling, audio, logging, handing messages between threads.',
    'Keeping only the last N of something, such as recent log lines or a sliding window of samples, by overwriting the oldest.',
  ],
  costs: [
    'The capacity is fixed up front. Too small and normal bursts get rejected. Too large and you waste memory and hide latency in a long queue.',
    'You must choose what happens when it is full, and no choice is free. Blocking slows the producer, dropping loses data, failing pushes the error upstream.',
    'Only the two ends are cheap. Searching or removing from the middle means a scan, so use a heap for priorities or a hash table for lookups.',
    'Head equals tail both when empty and when full. An implementation has to keep a count, leave one slot unused, or let the indices run free and mask them on use.',
    'It lives in the memory of one process. If the process dies the contents are gone.',
  ],
  interview: [
    'Say the bound and the full policy in the same breath. When the consumer falls behind you can block the producer, drop the newest item, drop the oldest, or shed load with an error. The right one depends on whether the data can be lost and whether the caller can wait.',
    'An unbounded queue does not fix overload, it hides it. If producers outpace consumers the queue grows until memory runs out, and every item waits longer in the meantime. A bounded queue forces the decision at once.',
    'Queue depth is a health signal. Near empty means the consumers keep up. Near full means they do not, and latency is already climbing. Alert on depth and on how long items wait.',
    'Against a linked-list queue: the ring buffer allocates nothing per item and keeps items side by side in memory, which suits the CPU cache. The linked list can grow without limit, which is rarely what you want between two services.',
    'A power-of-two capacity turns the mod into a bit mask: index & (capacity - 1). kfifo and the Disruptor both size their rings this way.',
    'With exactly one producer and one consumer the ring can be lock-free, because only the producer moves tail and only the consumer moves head. Full and empty are then worked out from the two indices, not from a shared count like the one on this page. More writers on either side need compare-and-swap or a lock.',
    'Kafka is the contrast to draw. It is a durable append-only log: every consumer keeps its own offset and data stays until retention removes it. A ring buffer is in memory and bounded, and an item is gone once it is read.',
  ],
};
