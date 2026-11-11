import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Serializable means the result is the same as running the transactions one at a time, in some order. Two-phase locking gets there pessimistically: a transaction locks what it reads and writes, and holds every lock until it ends, so conflicting work waits. Serializable snapshot isolation gets there optimistically: nothing waits, the database notes reads that a concurrent write makes stale, and it aborts a transaction at commit if one of those writers committed first.',
  watch: [
    'The scenario is write skew. The rule is "at least one doctor on call". T1 (Alice) and T2 (Bob) each read both rows, see 2 on call, and each switch off only their own row. Each is correct alone. Run together under plain snapshot isolation, both commit and nobody is on call.',
    'Under 2PL both reads take shared locks (S) on both rows, and shared locks do not conflict. A write needs the exclusive lock (X). The trouble starts at the writes: T1 wants the exclusive lock on Alice, but T2 holds a shared lock there, so T1 waits.',
    'Then T2 wants the exclusive lock on Bob, where T1 holds a shared lock. Watch the cycle check follow the waits-for graph one edge at a time: T2 waits for T1, T1 waits for T2, back at the start. One must die. Here it is T2; T1 then gets its lock, writes and commits. Bob stays on call.',
    'Retry T2 after that and it reads Alice off call, sees only 1 doctor on call, and writes nothing. Retrying means running the whole transaction again, reads included.',
    'Under SSI the same schedule never waits. Each write marks the other transaction as having read a row that is changing. The graph shows those marks as stale reads, reader to writer.',
    'Commit T1 and its check passes: T2 has not committed. Commit T2 and the check compares the writer of Alice, T1, with "committed": equal, so T2 is aborted with a serialization failure. Same outcome as 2PL, reached with an abort instead of a wait.',
    'Try T3 under 2PL: let T1 hold the exclusive lock on Alice and ask T3 to read Alice. T3 waits, but there is no cycle, so it simply waits until T1 ends. Under SSI the same read goes straight to T3\'s snapshot.',
    'Simplified here: two rows and three transactions; locks on rows only, with no predicate or range locks; a request is granted when it fits the current holders, even if others are queued before it; writes are kept private until commit under both methods, which is what an exclusive lock makes equivalent; the victim is always the transaction whose wait closed the cycle; and the SSI check is stricter than PostgreSQL\'s, so it aborts some transactions PostgreSQL would let through. Old versions are never cleaned up.',
  ],
  complexity: [
    { op: 'Read (2PL)', average: 'O(1) lock check', worst: 'Blocks', note: 'One check against the exclusive holder. It can then wait for as long as the writer runs.' },
    { op: 'Write (2PL)', average: 'O(holders)', worst: 'O(V + E) deadlock search', note: 'Every wait searches the waits-for graph of V waiting transactions and E edges.' },
    { op: 'Commit or abort (2PL)', average: 'O(locks held)', worst: 'O(locks held + queued)', note: 'Release everything, then grant whatever was waiting on it.' },
    { op: 'Read (SSI)', average: 'O(1) + record', worst: 'O(newer versions)', note: 'Skip versions committed after the snapshot. Never waits.' },
    { op: 'Write (SSI)', average: 'O(readers of the row)', worst: 'O(open transactions)', note: 'Mark each open reader of the row. Never waits.' },
    { op: 'Commit (SSI)', average: 'O(stale marks)', worst: 'O(rows read)', note: 'One comparison per noted stale read. Failure means redoing the whole transaction.' },
  ],
  space:
    '2PL keeps a lock entry for every row a transaction has touched, held until it ends: a transaction that reads 1 million rows holds 1 million shared locks, or a coarser lock on the table. SSI keeps a read record for every row read and every row version that a running snapshot can still see. PostgreSQL coarsens read records from rows to pages to whole tables when there are too many, which keeps memory bounded at the cost of more false aborts.',
  usedIn: [
    {
      name: 'PostgreSQL',
      how: 'SERIALIZABLE is serializable snapshot isolation, since version 9.1. Reads take SIREAD locks that block nothing. A transaction caught in a dangerous pattern fails with SQLSTATE 40001, "could not serialize access", and the application retries. REPEATABLE READ is plain snapshot isolation and allows write skew.',
    },
    {
      name: 'MySQL InnoDB',
      how: 'SERIALIZABLE is lock based. With autocommit off, plain SELECTs become SELECT ... FOR SHARE, and next-key locks (a row plus the gap before it) stop phantoms. Deadlocks are detected straight away and InnoDB rolls back the smaller transaction, measured in rows changed.',
    },
    {
      name: 'SQL Server',
      how: 'SERIALIZABLE uses key-range locks on an index, so another transaction cannot insert a row into a range that has been read. Its SNAPSHOT isolation level is snapshot isolation, not serializable.',
    },
    {
      name: 'Google Spanner',
      how: 'Read-write transactions use two-phase locking and avoid deadlock with wound-wait: an older transaction that wants a lock held by a younger one aborts the younger one. Read-only transactions read a snapshot and take no locks.',
    },
    {
      name: 'CockroachDB',
      how: 'Runs SERIALIZABLE by default and is optimistic too. When a conflict would break serializability it returns a retry error (SQLSTATE 40001) and the client runs the transaction again.',
    },
    {
      name: 'VoltDB and Redis',
      how: 'Actual serial execution. VoltDB runs each partition\'s stored procedures one at a time on one thread. Redis runs every command, and every Lua script, one at a time, so a script is atomic and isolated without any locks.',
    },
  ],
  reachFor: [
    'Any invariant that spans rows: at least one doctor on call, no double-booked room, a username taken once, a balance that may not go below zero across several accounts.',
    '2PL when conflicts are frequent and a transaction is expensive to redo: waiting costs less than throwing work away.',
    'SSI when most transactions do not conflict, and especially when most are reads: reads never block writes and writes never block reads.',
    'Serial execution when transactions are short, the data fits in memory and each transaction touches one partition: no locks and no aborts at all.',
    'Under snapshot isolation without SSI, lock the rows a decision depends on with SELECT ... FOR UPDATE. For the doctors, locking both rows makes the second transaction wait, and the skew cannot happen.',
  ],
  costs: [
    '2PL: readers block writers and writers block readers. One long report holding shared locks on a table stalls every write to it, so tail latency suffers even when the average looks fine.',
    '2PL: deadlocks are normal, not a bug. The database must find them and abort a victim, so the application must be ready to retry anyway.',
    '2PL: rows that do not exist yet cannot be locked. Stopping phantoms needs predicate locks (lock every row matching a condition, present or future) or the cheaper index-range locks, which lock a whole range of an index and so lock more than needed.',
    'SSI: under heavy contention most of the work is wasted. If ten transactions all update the same counter, nine abort and retry, and the retries collide again.',
    'SSI: aborts include false positives, because the check is coarse. Every retried transaction must be safe to run twice, including anything it does outside the database, such as sending an email.',
    'Serial execution: throughput is one core\'s worth per partition, and one slow transaction stalls everything behind it. A transaction that spans partitions needs coordination across all of them, which is far slower.',
    'Not needed at all when every transaction touches one row, or when a weaker level is correct for the job: READ COMMITTED is the default in PostgreSQL and is far cheaper.',
  ],
  interview: [
    'Say what serializable means: every result could also have come from running the committed transactions one at a time, in some order. Then say what weaker levels miss. Snapshot isolation stops dirty reads and non-repeatable reads but allows write skew: two transactions read the same rows, each writes a different one, and together they break a rule each kept alone.',
    'Give the doctors example in two sentences. Both read "2 on call", both switch themselves off, nobody is on call. No row was written twice, so first-committer-wins on writes cannot catch it.',
    'Name the three ways to get serializable: run transactions one at a time (VoltDB, Redis), pessimistic two-phase locking (MySQL SERIALIZABLE, SQL Server, Spanner), and optimistic serializable snapshot isolation (PostgreSQL SERIALIZABLE).',
    '2PL in one breath: a shared lock to read, an exclusive lock to write, and no lock is released until commit or abort. Growing phase, then shrinking phase. Databases hold the locks until commit (strict 2PL), which also stops anyone reading data that is later rolled back.',
    'Deadlocks: keep a waits-for graph and search it for a cycle on every wait, or periodically (PostgreSQL waits deadlock_timeout, 1 second by default, before checking). Or avoid them by ordering: wound-wait and wait-die use transaction age to decide who aborts. Or give up after a timeout.',
    'Phantoms: if the decision is "count bookings for room 4 at 2pm, insert one if zero", there is no row to lock. 2PL needs a predicate lock on the condition, usually approximated by an index-range lock on room 4. Without either, materialise the conflict: make a row per room and time slot, and lock that.',
    'SSI in one breath: read from a snapshot, write privately, and track read-write conflicts between concurrent transactions. At commit, abort a transaction whose reads were made stale by a writer that committed first. The Cahill, Röhm and Fekete paper (SIGMOD 2008) showed a cycle needs two such conflicts in a row, which is what PostgreSQL checks for.',
    'The retry loop matters as much as the method. Catch the serialization or deadlock error, roll back, and rerun the whole transaction from the first read, with backoff and a limit. Never retry only the failed statement.',
    'Pick by contention. Low contention, read heavy: SSI. High contention on a few hot rows: locking, or redesign so the hot row is not shared (one counter per shard, summed on read). Tiny transactions on in-memory, partitionable data: serial execution.',
    'A trap to mention: the word SERIALIZABLE does not always mean it. Oracle\'s SERIALIZABLE level is snapshot isolation and allows write skew. Check what the database actually implements.',
  ],
};
