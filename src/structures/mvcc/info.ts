import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Multi-version concurrency control (MVCC) never changes a row in place. A write adds a new version stamped with the writer\'s transaction id, and a read walks the versions and takes the newest one its snapshot is allowed to see. So readers never wait for writers and writers never wait for readers. The isolation level decides when the snapshot is taken: once per statement for read committed, once per transaction for snapshot isolation.',
  watch: [
    'Each version shows three things: its value, xmin (the transaction that made it) and xmax (the one that replaced it). A write adds a version at the front and stamps xmax on the old one. The old one stays.',
    'A read asks three questions of each version, newest first. Is it mine? Did its maker commit before my snapshot? Has it been replaced in my view? The first version that passes is the answer.',
    'Read skew at read committed: T2 reads A = 50, T1 commits its transfer, T2 reads B = 20. It saw 70 of a 100 total. It never saw T1\'s uncommitted 80, though: there are no dirty reads at either level.',
    'The same story at snapshot isolation: T1 is in T2\'s list of transactions in progress, so T1\'s versions stay invisible to T2 even after T1 commits. T2 sees 50 and 50.',
    'Lost update: two deposits of 10 and 20 on 50. At read committed the second writer waits for the lock, then writes 70 over 60. At snapshot isolation it aborts instead, and the retry writes 80.',
    'Write skew: Alice and Bob each check that two doctors are on call, then each takes only themselves off. Different rows, no lock conflict, so snapshot isolation lets both commit and nobody is on call.',
    'Begin a transaction, leave it running, then update a row a few times from others and run Vacuum. The old versions stay, because the open snapshot might still read them.',
    'The page is simplified. Two rows, at most three transactions. Snapshot isolation takes its snapshot at Begin; PostgreSQL takes it at the first statement. No indexes, no inserts or deletes, so no phantoms. Chains are drawn newest first, as InnoDB walks them; PostgreSQL links old to new.',
  ],
  complexity: [
    { op: 'Read a row', average: 'O(1)', worst: 'O(v)', note: 'Walk the versions newest first. Usually the first or second one is visible; a long open transaction can make the walk long.' },
    { op: 'Visibility check', average: 'O(1)', worst: 'O(r)', note: 'A lookup of the creator\'s commit status, then a check against the snapshot\'s list of r transactions in progress.' },
    { op: 'Write a row', average: 'O(1)', worst: 'Waits', note: 'Append a version and stamp xmax on the old one. Waits if another running transaction holds the row\'s lock.' },
    { op: 'Commit', average: 'O(1)', worst: 'O(1)', note: 'Mark the transaction committed in the commit log and release its locks. No version is touched.' },
    { op: 'Abort', average: 'O(1)', worst: 'O(1)', note: 'Mark it aborted. Its versions stay as garbage and nobody reads them.' },
    { op: 'Vacuum', average: 'O(v)', worst: 'O(v)', note: 'Scan every version and drop the ones no open or future snapshot can see.' },
  ],
  space:
    'One extra version per update until vacuum removes it. A row updated 1,000 times while one report runs for an hour keeps up to 1,000 versions. In PostgreSQL every version also carries a tuple header of about 23 bytes holding xmin, xmax and more.',
  usedIn: [
    {
      name: 'PostgreSQL',
      how: 'Every row version carries xmin and xmax, as on this page. An UPDATE writes a new version; VACUUM, usually run by autovacuum, removes dead ones. Read committed is the default. Its "repeatable read" is snapshot isolation, and it aborts the later writer with "could not serialize access due to concurrent update". "Serializable" adds serializable snapshot isolation, which also catches write skew.',
    },
    {
      name: 'MySQL InnoDB',
      how: 'Keeps the newest version in the row and older ones in the undo log. Each row records the id of the transaction that last changed it and a pointer back to the undo record, so a reader rebuilds the version its read view needs. A purge thread drops undo records no read view needs. The default level is repeatable read.',
    },
    {
      name: 'Oracle',
      how: 'Rebuilds older versions from undo, like InnoDB. Its "serializable" level is snapshot isolation, so it allows write skew.',
    },
    {
      name: 'SQL Server',
      how: 'Locks by default. Turn on snapshot isolation, or the read committed snapshot option, and it keeps row versions in a version store in tempdb.',
    },
  ],
  reachFor: [
    'Mixed workloads: long reads such as reports and backups running beside short writes, with neither blocking the other.',
    'Snapshot isolation when a transaction must see one consistent moment: a report, a backup, a check that adds up several rows.',
    'Read committed when each statement stands alone and you want the fewest aborts. Make updates relative (SET balance = balance + 20) so the database works them out on the newest version.',
    'Serializable when the rule spans rows that different transactions write: on-call rotas, room bookings, unique usernames. Or lock the rows you check with SELECT … FOR UPDATE.',
  ],
  costs: [
    'Old versions pile up until vacuum or purge removes them. Tables and indexes grow, and reads walk further.',
    'One long transaction holds back clean-up for the whole database, not only the tables it touches. An idle session left "in transaction" does the same.',
    'Snapshot isolation aborts the second writer of a row. The application must catch the error and retry the whole transaction, not only the last statement.',
    'Neither read committed nor snapshot isolation stops write skew or phantoms. A check-then-write rule over several rows needs serializable or explicit locks.',
    'Writers still lock rows. Two transactions that update the same rows in opposite orders can deadlock, and one of them is aborted.',
    'Transaction ids are finite. PostgreSQL uses 32-bit ids and must "freeze" old rows before the counter wraps, which is one more job for vacuum.',
  ],
  interview: [
    'ACID in four sentences. Atomicity: all of a transaction\'s writes happen or none do. Consistency: the application\'s rules hold before and after. Isolation: transactions running at once do not see each other\'s half-done work. Durability: once committed, it survives a crash. Only isolation comes in levels, and the default is rarely the strongest.',
    'Define each anomaly by example. Dirty read: you see a write that has not committed and may roll back. Dirty write: you overwrite one. Read skew: you read A before a transfer and B after it, and money seems to vanish. Lost update: two read-modify-writes of one row, and the second overwrites the first. Write skew: two transactions check the same rows and each writes a different one, breaking a rule. Phantom: a new row appears that matches a query you already ran.',
    'Which level stops which. Read committed stops dirty reads and dirty writes, and allows read skew, lost updates, write skew and phantoms. Snapshot isolation also stops read skew and lost updates (PostgreSQL\'s does; see below) and plain phantoms in reads, but allows write skew, including write skew where the rows checked are phantoms. Serializable stops them all.',
    'Watch the names. "Repeatable read" in the SQL standard is defined by what it forbids, not by how. PostgreSQL\'s is snapshot isolation. MySQL InnoDB\'s gives a consistent snapshot for plain SELECTs, but an UPDATE works on the newest committed version, so it does not stop lost updates the way PostgreSQL does. Oracle\'s "serializable" is snapshot isolation. Always ask what the level actually prevents.',
    'Explain the visibility rule: a version is visible if its creator committed before my snapshot and its replacer, if any, had not. A snapshot is the list of transactions in progress plus the next id to be handed out.',
    'First committer wins: under snapshot isolation, if two transactions update the same row, the later one aborts. That is how it prevents lost updates without locking reads.',
    'Say what a long transaction costs: every version it might read is kept, so tables bloat and reads slow down. Set a statement timeout and an idle-in-transaction timeout, and keep reports on a replica.',
    'For write skew, name the fixes: serializable isolation (two-phase locking, or serializable snapshot isolation as in PostgreSQL), SELECT … FOR UPDATE on the rows you checked, or a constraint the database can enforce itself.',
  ],
};
