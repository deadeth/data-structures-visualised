import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A service often has to change its database and also tell other services by publishing an event. Those are two systems, and no single commit covers both, so a crash between the two steps leaves one done without the other. The transactional outbox makes them one step: the same database transaction that changes the business row also inserts the event into an outbox table. A separate relay later copies outbox rows to the log. Nothing is lost, but an event can be published twice, so consumers skip ids they have already handled.',
  watch: [
    'Magenta is the event. Follow it from the service, or the outbox row, to the log and into the consumer.',
    'Dual write first. Crash after commit adds 25 to account 42 in the database, then the service dies holding the event in memory. Events lost goes to 1, and from then on the consumer\'s total for 42 is 25 short. Nothing can repair it, because nothing recorded that an event was owed.',
    'Crash before commit in dual write publishes first, then the commit fails. The event is on the log, red, for a change the database never made: a phantom.',
    'Switch to outbox and write. The balance and the outbox row go blue together inside one transaction and turn green together at commit. Crash before commit there and both vanish; crash after commit and the row is safe on disk.',
    'Crash relay publishes the oldest unpublished row, then dies before marking it. On restart the outbox still says unpublished, so the relay sends it again. The log holds the same id twice.',
    'Consume looks each id up in the processed-ids table. A new id is applied and recorded in one transaction; a repeat is skipped. Duplicates applied stays at 0.',
    'Prune deletes published rows. The events are not lost by that: they live on the log.',
    'Simplified: one service, one database, one partition, one consumer, three accounts. A transaction is a copy that replaces the original at commit. The relay polls; change data capture is described below but not drawn. The page draws at most 4 outbox rows and 5 unread log records.',
  ],
  complexity: [
    { op: 'Write (outbox)', average: '1 transaction', worst: '1 transaction', note: 'Two row writes in one local commit. No call to the broker on the request path.' },
    { op: 'Write (dual write)', average: '1 commit + 1 publish', worst: '1 commit + 1 publish', note: 'Cheaper to build, but the two steps can be split by a crash, a timeout or a deploy.' },
    { op: 'Relay, per event', average: '1 read + 1 publish + 1 update', worst: 'same', note: 'A polling relay also pays for each poll that finds nothing. Change data capture reads the database log instead and pays no polling queries.' },
    { op: 'Consume, per event', average: '1 lookup + 1 transaction', worst: 'same', note: 'The processed-ids check is an indexed lookup. The id is written in the same transaction as the change.' },
    { op: 'Delay before publish', average: 'about one poll interval', worst: 'until the relay is back', note: 'The service never waits for the broker, so a broker outage delays events rather than failing writes.' },
    { op: 'Prune', average: 'O(published rows)', worst: 'O(published rows)', note: 'A batched delete, usually by age.' },
  ],
  space:
    'One outbox row per event until it is pruned, and one processed id per event the consumer has handled, kept for at least as long as a duplicate could still arrive.',
  usedIn: [
    {
      name: 'Debezium',
      how: 'An open-source change data capture platform. It reads the database\'s own log (the write-ahead log in PostgreSQL, the binlog in MySQL) and publishes row changes to Kafka. It ships an outbox event router that turns inserts into an outbox table into events on a topic chosen per aggregate type.',
    },
    {
      name: 'Kafka Connect JDBC source connector',
      how: 'A polling relay you configure rather than write: it queries a table on an interval and publishes new rows, tracking progress by an incrementing column or a timestamp.',
    },
    {
      name: 'microservices.io (Chris Richardson)',
      how: 'Where the names come from: Transactional outbox, with Polling publisher and Transaction log tailing as the two ways to relay, and Idempotent consumer for the receiving side.',
    },
    {
      name: 'Payment and order services generally',
      how: 'The usual home of the pattern: a payment is captured and a "payment captured" event must reach the ledger, notifications and analytics, with none of them allowed to miss it.',
    },
  ],
  reachFor: [
    'A service owns a database and must publish an event for every change, and losing one would leave another service wrong for good: a ledger, a balance, a fulfilment queue.',
    'The broker cannot join your database transaction, which is nearly always the case with Kafka, SQS or a webhook.',
    'You want writes to keep working while the broker is down. Events queue up in the outbox and go out when it is back.',
    'Several steps of a saga have to hand off reliably: each step commits its local change and its next command together.',
  ],
  costs: [
    'At-least-once, never exactly-once on its own. A relay crash between publish and mark sends the event again, so every consumer must be idempotent.',
    'Extra latency: an event waits for the next poll, or for change data capture to read the log. Typically milliseconds to a second, but not zero.',
    'Another moving part to run and watch: the relay or the CDC connector, and an alert on outbox rows that stay unpublished.',
    'The outbox table grows on every write until it is pruned, and a busy table that is inserted into and deleted from all day needs vacuuming or partitioning.',
    'Change data capture has its own cost. A PostgreSQL replication slot keeps write-ahead log on disk until the connector reads it, so a stopped connector can fill the disk.',
    'It cannot repair what was never written. The event lost under dual write on this page stays lost after switching to the outbox; existing data needs a one-off backfill.',
    'Skip it when the event is a best-effort hint (a cache invalidation that also expires on its own), or when the log is already your source of truth, as in event sourcing.',
  ],
  interview: [
    'Say why dual write fails in one sentence: "Two systems, no shared commit: whichever I do first, a crash before the second leaves them disagreeing. Commit first and I lose the event; publish first and I announce a change that may roll back."',
    'Why not two-phase commit across the database and the broker? Kafka does not take part in XA transactions, 2PC blocks while the coordinator is down, and it puts the broker\'s availability on every write path. The two-phase commit page on this site shows the blocking. The outbox swaps it for one local transaction plus asynchronous delivery.',
    'Name the two relays. A polling publisher runs a query such as "unpublished rows, oldest first" every few hundred milliseconds: simple, works on any database, adds query load and up to one interval of delay. Log tailing, such as Debezium on the PostgreSQL write-ahead log, reads commits as they happen: lower latency, no polling queries, but more to operate.',
    'Ordering: publish in outbox order and key each event by the aggregate id, such as the account, so all of one account\'s events share a partition and stay in order. Order across accounts is not promised and is not needed. A subtle catch with polling: ids are handed out at insert but rows become visible at commit, so a poller can see id 8 before id 7 commits. Log tailing reads in commit order and avoids it.',
    'Idempotent consumer, or inbox: store each processed event id in the consumer\'s own database, in the same transaction as the change it makes, and skip ids already there. Writing the id separately reopens the same dual-write gap on the receiving side. The idempotency keys page applies the same idea to client retries.',
    'Pruning: delete published rows on a schedule, or with log tailing delete each row straight after inserting it, because the insert is already in the database log for the connector to read.',
    '"Listen to yourself" is the alternative: publish the event first and have the service consume its own event to update its database. The log becomes the single place a change is decided. The cost is that the service cannot read its own write straight away, and every check that needs the current state must happen before publishing.',
    'Event sourcing is the cousin: the log of events is the source of truth and tables are built from it, so there is nothing to keep in step. The append-only log page shows that log. The outbox suits a team that wants to keep its ordinary tables.',
    'Sagas lean on it. Each local step of a saga commits its change and its next command together through an outbox, so the saga never stalls on a lost message. The saga page covers the compensation side.',
  ],
};
