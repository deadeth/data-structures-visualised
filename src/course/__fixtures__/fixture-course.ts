import type { Course } from '../types';

/**
 * A small course used while `src/course/course.ts` is being written, and by the tests. It names only
 * pages that exist, so it passes the same validation as the real course. Shown in development at
 * `#/course` when the real file is missing (see `src/course/index.ts`).
 */
const course: Course = {
  title: 'System design interview course (fixture)',
  summary:
    'A short sample of the course, used while the real one is written. Work through the modules in order, tick each item when done, and answer the checkpoint questions **out loud** before moving on.',
  howTo: [
    'Study in short blocks of 25 to 50 minutes. Stop at a checkpoint rather than in the middle of a module.',
    'Say answers out loud. An answer you can only recognise on the page is not one you can give in an interview.',
    'Time the practice designs. A real round gives you 45 to 60 minutes, and the first 5 go on questions about scope.',
  ],
  modules: [
    {
      id: 'foundations',
      title: 'Foundations: how data is stored and found',
      why: 'Every design ends at a store. Knowing what a B+ tree and an LSM tree cost lets you say why a database is fast at one thing and slow at another.',
      minutes: 70,
      items: [
        { id: 'b-plus-tree', kind: 'watch', title: 'B+ tree', href: '#/s/b-plus-tree', minutes: 15, note: 'Step through an insert that splits a leaf. Count the page reads for one lookup.' },
        { id: 'lsm', kind: 'watch', title: 'LSM tree', href: '#/s/lsm-tree', minutes: 15, note: 'Watch a write reach the memtable, then a flush and a compaction. Note why reads may check several files.' },
        { id: 'caching', kind: 'read', title: 'Caching', href: '#/c/caching', minutes: 13, note: 'Read where caches sit and the three ways a cache serves the wrong answer.' },
        { id: 'numbers', kind: 'drill', title: 'Latency numbers from memory', minutes: 10, note: 'Write down a memory read, an SSD read, a same-region round trip and a cross-ocean round trip, then check them.' },
        { id: 'crawler', kind: 'practise', title: 'Design a web crawler', href: '#/d/web-crawler', minutes: 45, note: 'Answer against a 45-minute clock, then compare with the tour.', covers: ['A frontier with one queue per host', 'Politeness: robots.txt and a delay per host', 'Seen-URL checks that fit in memory', 'What happens when a crawler node dies'] },
      ],
      checkpoint: [
        'Why does a B+ tree lookup take about three or four page reads for a billion keys?',
        'When would you pick an LSM tree over a B+ tree, and what does it cost on reads?',
        'Name three places a cache can sit between a phone and the database.',
      ],
    },
    {
      id: 'consistency',
      title: 'Consistency and money',
      why: 'Payment questions turn on what happens when two writes race or a message arrives twice. The answers are idempotency keys, one transaction per balance change, and a ledger that never edits a row.',
      minutes: 95,
      items: [
        { id: 'idempotency', kind: 'watch', title: 'Idempotency keys', href: '#/s/idempotency-keys', minutes: 12, note: 'Follow one retried payment and see the second request return the first answer.' },
        { id: 'outbox', kind: 'watch', title: 'Transactional outbox', href: '#/s/outbox', minutes: 12, note: 'See why writing the event in the same transaction as the row closes the gap.' },
        { id: 'ledger-read', kind: 'read', title: 'The ledger design, rehearsal mode', href: '#/d/ledger/rehearse', minutes: 20, note: 'Read the opening and the likely pushes.' },
        { id: 'ledger', kind: 'practise', title: 'Design a ledger service', href: '#/d/ledger/t/3', minutes: 45, note: 'Answer against the clock, then step through the tour from step 3.', covers: ['Double entry: every transaction sums to zero', 'Holds placed with an idempotency key', 'Balances checked inside one transaction', 'Events leave through an outbox'] },
        { id: 'explain', kind: 'drill', title: 'Explain exactly-once in two minutes', minutes: 6, note: 'Record yourself. Say why delivery is at least once and processing is made idempotent.' },
      ],
      checkpoint: [
        'What stops a retried card authorisation from placing two holds?',
        'Why must the event and the balance change commit in one transaction?',
      ],
    },
  ],
};

export default course;
