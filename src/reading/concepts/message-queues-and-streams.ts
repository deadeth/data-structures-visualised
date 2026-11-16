import type { Concept } from '../types';

const page: Concept = {
  id: 'message-queues-and-streams',
  title: 'Message queues and streams',
  group: 'Messaging',
  summary:
    "A queue or a log between two services lets them fail, deploy and scale separately. The price is duplicates, reordering and lag, and most of the design work is deciding what to do about those three.",
  minutes: 15,
  sections: [
    {
      id: 'why',
      title: 'Why put a queue between two services',
      blocks: [
        {
          p: "A direct HTTP call ties two services together in time. If Notifications is down for ten minutes, Payments has three bad choices: fail the payment, drop the notification, or build its own retry loop and store. A broker in the middle takes that problem off the caller. Payments writes one message, gets an acknowledgement from the broker, and moves on.",
        },
        {
          table: {
            head: ['What you get', 'How', 'What it costs'],
            rows: [
              [
                'Decoupling in time',
                "The producer needs only the broker to be up. A consumer that's down catches up when it's back.",
                "The broker is now on the critical path, and the producer never learns whether the work succeeded.",
              ],
              [
                'Buffering and smoother load',
                'A spike sits in the queue while consumers drain it at their steady rate.',
                'The work is late. You have swapped errors for delay.',
              ],
              [
                'Fan-out',
                'One event, several independent readers. A new reader needs no change in the producer.',
                'Nobody owns the end-to-end flow unless you make someone own it.',
              ],
              [
                'Independent scaling',
                'Add consumers when the backlog grows, without touching the producer.',
                'More consumers means more reordering and more rebalances.',
              ],
            ],
          },
          caption: 'The four reasons, each with its bill.',
        },
        {
          diagram: {
            w: 640,
            h: 330,
            nodes: [
              { id: 'pay', label: 'Payments', sub: 'writes one event', x: 250, y: 20 },
              { id: 'topic', label: 'payment-events', sub: 'broker', x: 250, y: 140, kind: 'queue' },
              { id: 'ledger', label: 'Ledger', sub: 'up to date', x: 30, y: 260, tone: 'ok' },
              { id: 'notif', label: 'Notifications', sub: 'down 10 minutes', x: 250, y: 260, tone: 'bad' },
              { id: 'ana', label: 'Analytics', sub: 'added last week', x: 470, y: 260 },
            ],
            edges: [
              { from: 'pay', to: 'topic', label: 'publish' },
              { from: 'topic', to: 'ledger' },
              { from: 'topic', to: 'notif', dashed: true, label: 'waits' },
              { from: 'topic', to: 'ana' },
            ],
          },
          caption:
            "Payments knows one address. Notifications being down doesn't fail a payment: its events wait in the broker. Analytics was added without a change to Payments.",
        },
        {
          p: "Put numbers on the buffering. Consumers handle 1,000 messages a second. A spike of 5,000 a second lasts one minute: 300,000 arrive, 60,000 are handled, 240,000 are left. Draining those takes another 4 minutes if normal traffic pauses, and far longer if it doesn't. A queue smooths a spike; it doesn't fix a consumer that's too slow on average.",
        },
        {
          callout:
            "\"I'd put a queue here because the caller doesn't need the result to answer its own request, and I want a ten-minute outage downstream to cost delay, not errors. That commits me to at-least-once delivery, so the consumer must be idempotent.\"",
          kind: 'interview',
          title: 'Justify the queue in one breath',
        },
      ],
    },
    {
      id: 'queue-vs-log',
      title: 'A queue or a log',
      blocks: [
        {
          p: "Two different things get called a message queue. A **queue** (RabbitMQ, Amazon SQS) tracks each message: it hands a message to one worker and deletes it once that worker acknowledges. A **log** (Kafka, Amazon Kinesis) is an append-only file. The broker deletes nothing on read; each consumer remembers how far it has got, as an offset.",
        },
        {
          diagram: {
            w: 640,
            h: 420,
            groups: [
              { label: 'Queue: RabbitMQ, SQS', x: 10, y: 10, w: 620, h: 190 },
              { label: 'Log: Kafka, Kinesis', x: 10, y: 215, w: 620, h: 195 },
            ],
            nodes: [
              { id: 'qp', label: 'Producer', x: 30, y: 82 },
              { id: 'q', label: 'Queue', sub: 'm3, m4 waiting', x: 250, y: 82, kind: 'queue' },
              { id: 'wa', label: 'Worker A', sub: 'has m1', x: 470, y: 34 },
              { id: 'wb', label: 'Worker B', sub: 'has m2', x: 470, y: 130 },
              { id: 'lp', label: 'Producer', x: 30, y: 290 },
              { id: 'l', label: 'Log', sub: 'offsets 0 to 9 kept', x: 250, y: 290, kind: 'queue' },
              { id: 'g1', label: 'Ledger group', sub: 'at offset 9', x: 470, y: 242 },
              { id: 'g2', label: 'Analytics group', sub: 'at offset 4', x: 470, y: 338 },
            ],
            edges: [
              { from: 'qp', to: 'q' },
              { from: 'q', to: 'wa', label: 'm1' },
              { from: 'q', to: 'wb', label: 'm2' },
              { from: 'lp', to: 'l' },
              { from: 'l', to: 'g1', label: 'read' },
              { from: 'l', to: 'g2', label: 'read' },
            ],
          },
          caption:
            'In the queue each message goes to one worker and is gone after its ack. In the log both groups read every record at their own pace, and the records stay until retention removes them.',
        },
        {
          table: {
            head: ['', 'Queue', 'Log'],
            rows: [
              ['The broker keeps', 'The state of each message: ready, in flight, acknowledged.', 'An ordered file per partition. Consumers keep their own offset.'],
              ['Who gets a message', 'One worker among those competing.', 'Every consumer group; one consumer within each group.'],
              ['Order', 'Roughly arrival order. Redelivery and parallel workers shuffle it.', 'Exact within a partition.'],
              ['A slow or failed message', 'Only that message waits. Others carry on.', 'Everything behind it in the partition waits.'],
              ['Replay', "No. An acknowledged message is deleted.", 'Yes, back as far as retention goes.'],
              ['Good at', 'Jobs: send this email, resize this image, call this webhook.', 'Events: facts several teams consume, in order per key.'],
            ],
          },
          caption: 'A job is something one worker should do once. An event is something that happened, for anyone to read.',
        },
        {
          p: "The line blurs at the edges. SQS has FIFO queues, RabbitMQ has a log-shaped stream type, and Kafka can be made to behave like a job queue with effort. Start from the shape of the work, then pick the product.",
        },
        {
          see: [
            { href: '#/s/append-log', label: 'Append-only log', why: 'Offsets, several readers at different positions, and replay, one record at a time.' },
          ],
        },
      ],
    },
    {
      id: 'delivery',
      title: 'Delivery semantics and where duplicates come from',
      blocks: [
        {
          p: "The broker and the consumer are two machines. One of them has to move first: either the broker forgets the message before the work is done, or the consumer does the work before the broker hears about it. That choice is the delivery guarantee.",
        },
        {
          table: {
            head: ['Guarantee', 'How', 'What a crash does', 'Use it for'],
            rows: [
              ['At most once', 'Acknowledge first, then do the work.', 'The message is lost.', 'Metrics, logs, hints you can afford to drop.'],
              ['At least once', 'Do the work, then acknowledge.', 'The message is delivered again.', 'Nearly everything. It is the default worth assuming.'],
              ['Effectively once', 'At least once, plus a consumer that detects repeats.', 'A repeat arrives and is skipped.', 'Money, stock, anything a customer would notice twice.'],
            ],
          },
          caption: "There's no fourth row. Exactly-once delivery over a network that can lose an acknowledgement doesn't exist; what exists is a repeat that has no second effect.",
        },
        {
          sequence: {
            actors: ['Queue', 'Worker 1', 'Worker 2', 'Database'],
            messages: [
              { from: 'Queue', to: 'Worker 1', label: 'deliver m7: pay £40', tone: 'follow' },
              { from: 'Worker 1', to: 'Database', label: 'insert payment, commit', tone: 'ok' },
              { from: 'Worker 1', to: 'Queue', label: 'ack m7', tone: 'bad', dashed: true, note: 'Worker 1 dies before the ack is sent' },
              { from: 'Queue', to: 'Worker 2', label: 'deliver m7 again', tone: 'follow', note: 'No ack within the timeout, so m7 is visible again' },
              { from: 'Worker 2', to: 'Database', label: 'insert payment, commit', tone: 'bad' },
              { from: 'Worker 2', to: 'Queue', label: 'ack m7' },
            ],
          },
          caption:
            'Nothing misbehaved. The queue did what at-least-once promises, and the customer paid £80. The gap is between the commit and the ack, and no ordering of those two steps closes it.',
        },
        {
          p: "Duplicates have more sources than that one crash. A producer times out waiting for the broker's acknowledgement and sends again. A slow worker overruns its visibility timeout and a second worker gets the same message while the first is still working. A rebalance moves a partition before its offsets were committed. An outbox relay publishes, then dies before marking the row. An operator replays a topic to fix a bug. Design for all of them with one mechanism in the consumer, not one patch per source.",
        },
        {
          callout:
            "Saying \"Kafka gives us exactly-once, so duplicates aren't a concern\". Kafka's transactions cover reading from Kafka and writing to Kafka. The moment your consumer writes to Postgres, sends an email or calls a bank, you're back to at-least-once and need your own duplicate check.",
          kind: 'pitfall',
        },
      ],
    },
    {
      id: 'ordering',
      title: 'Ordering and partitions',
      blocks: [
        {
          p: "A log scales by splitting a topic into partitions. Each partition is its own ordered log on its own broker. The producer picks the partition from the message key, usually `hash(key) mod partitions`, so every message with the same key lands in the same partition and keeps its order.",
        },
        {
          diagram: {
            w: 640,
            h: 240,
            nodes: [
              { id: 'p', label: 'Producer', sub: 'hash(account) mod 3', w: 170, x: 235, y: 20 },
              { id: 'p0', label: 'Partition 0', sub: 'acct 12: e1 e2', x: 30, y: 160, kind: 'queue' },
              { id: 'p1', label: 'Partition 1', sub: 'acct 7: e1 e2 e3', x: 250, y: 160, kind: 'queue', tone: 'follow' },
              { id: 'p2', label: 'Partition 2', sub: 'acct 3, acct 9', x: 470, y: 160, kind: 'queue' },
            ],
            edges: [
              { from: 'p', to: 'p0', label: 'acct 12' },
              { from: 'p', to: 'p1', label: 'acct 7', tone: 'follow' },
              { from: 'p', to: 'p2', label: 'acct 3, 9' },
            ],
          },
          caption:
            "Account 7's events always go to partition 1, so they stay in order. There's no order between account 7 and account 12: they're in different logs.",
        },
        {
          p: "Global order is expensive because it means one partition, and one partition means one consumer at a time. If handling a message takes 5 ms, that consumer does 200 a second and no amount of hardware elsewhere helps. Twelve partitions give 2,400 a second, with order kept per key. So ask what really needs ordering. It's almost never \"everything\". It's one account's entries, one transfer's state changes, one card's authorisations. Make that the key.",
        },
        {
          list: [
            "A hot key (one merchant with 30% of the traffic) makes a hot partition. Adding partitions doesn't help, because the key still hashes to one of them.",
            "Changing the partition count changes `hash mod n`, so a key's new events go to a different partition while its old ones are still unread in the first. Order for that key breaks across the change. Pick a count with headroom at the start.",
            "Retries break order too. If event 5 fails and you park it to try later, event 6 for the same key runs first. Either block the partition on event 5, or park every later event for that key behind it.",
          ],
        },
        {
          see: [
            { href: '#/s/partitioning', label: 'Partitioning', why: 'Hash against range partitioning, and what each does to queries that span keys.' },
          ],
        },
      ],
    },
    {
      id: 'consumer-groups',
      title: 'Consumer groups and rebalancing',
      blocks: [
        {
          p: "A consumer group is a set of processes sharing one job and one set of offsets. Within a group each partition is owned by exactly one consumer, so the partition count caps the group's parallelism: a thirteenth consumer on a 12-partition topic sits idle. Two groups are independent. Each sees every record.",
        },
        {
          diagram: {
            w: 640,
            h: 400,
            groups: [
              { label: 'Group: ledger', x: 120, y: 5, w: 510, h: 95 },
              { label: 'Topic: transfers', x: 10, y: 150, w: 620, h: 95 },
              { label: 'Group: analytics', x: 230, y: 300, w: 180, h: 95 },
            ],
            nodes: [
              { id: 'l1', label: 'Ledger 1', sub: 'owns P0, P1', x: 140, y: 30 },
              { id: 'l2', label: 'Ledger 2', sub: 'owns P2', x: 470, y: 30 },
              { id: 'p0', label: 'P0', x: 30, y: 175, kind: 'queue' },
              { id: 'p1', label: 'P1', x: 250, y: 175, kind: 'queue' },
              { id: 'p2', label: 'P2', x: 470, y: 175, kind: 'queue' },
              { id: 'a1', label: 'Analytics 1', sub: 'owns all three', x: 250, y: 325 },
            ],
            edges: [
              { from: 'p0', to: 'l1' },
              { from: 'p1', to: 'l1' },
              { from: 'p2', to: 'l2' },
              { from: 'p0', to: 'a1' },
              { from: 'p1', to: 'a1' },
              { from: 'p2', to: 'a1' },
            ],
          },
          caption:
            'Within the ledger group every partition has one owner. The analytics group reads the same three partitions separately, with its own offsets. Adding a third ledger consumer would move one partition to it: a rebalance.',
        },
        {
          p: "A rebalance happens when a consumer joins, leaves, or stops looking alive. The group coordinator reassigns partitions, and each new owner starts from the last **committed** offset. Anything the old owner processed but hadn't committed is processed again.",
        },
        {
          sequence: {
            actors: ['Partition 2', 'Consumer A', 'Coordinator', 'Consumer B'],
            messages: [
              { from: 'Partition 2', to: 'Consumer A', label: 'records 40 to 49' },
              { from: 'Consumer A', to: 'Coordinator', label: 'no poll for 6 minutes', tone: 'bad', dashed: true, note: 'A has handled 40 to 44 and is stuck on a slow call. Committed offset is still 40.' },
              { from: 'Coordinator', to: 'Consumer B', label: 'you own partition 2' },
              { from: 'Consumer B', to: 'Partition 2', label: 'fetch from offset 40', tone: 'compare' },
              { from: 'Partition 2', to: 'Consumer B', label: 'records 40 to 49', note: '40 to 44 are now handled a second time' },
              { from: 'Consumer A', to: 'Coordinator', label: 'commit offset 45', tone: 'bad', note: "Refused: A's membership is out of date" },
            ],
          },
          caption:
            "The coordinator fences A's late commit, but it can't fence what A already wrote to your database. Records 40 to 44 have two sets of effects unless the consumer is idempotent.",
        },
        {
          p: "Two habits keep rebalances cheap. Commit offsets after the work, never before, and keep batches small enough that a poll always comes back inside the timeout. Where it matters most, store the offset in the same database transaction as the results, so a stale owner's write fails with its offset. The [money moved dashboard](#/d/money-moved-dashboard) design does exactly that.",
        },
      ],
    },
    {
      id: 'failures',
      title: 'Acknowledgements, retries and dead letters',
      blocks: [
        {
          p: "An acknowledgement tells the broker the work is done. Until it arrives the broker must assume the worker may be dead. SQS expresses that as a **visibility timeout**: a received message is hidden from other workers for a period, and if it hasn't been deleted by then, it reappears. Set the timeout above your worst-case processing time, or have the worker extend it while it's still working. Too short and you make your own duplicates; too long and a crashed worker's message waits that long before anyone retries it.",
        },
        {
          p: "A **poison message** fails every time: a payload the code can't parse, a reference to a row that doesn't exist. With no limit it cycles for ever in a queue, and in a log it blocks its partition while lag climbs behind it. The answer is a retry count and a dead-letter queue (DLQ).",
        },
        {
          diagram: {
            w: 640,
            h: 380,
            nodes: [
              { id: 'main', label: 'Main queue', x: 30, y: 30, kind: 'queue' },
              { id: 'c', label: 'Consumer', sub: 'counts attempts', x: 250, y: 30 },
              { id: 'db', label: 'Database', x: 470, y: 30, kind: 'store', tone: 'ok' },
              { id: 'retry', label: 'Retry queue', sub: 'delay 1s, 10s, 60s', x: 30, y: 170, kind: 'queue', tone: 'compare' },
              { id: 'dlq', label: 'Dead-letter queue', sub: 'after 5 attempts', x: 470, y: 170, kind: 'queue', tone: 'bad' },
              { id: 'ops', label: 'Alert and owner', sub: 'fix, then redrive', x: 470, y: 300, kind: 'client' },
            ],
            edges: [
              { from: 'main', to: 'c', label: 'deliver' },
              { from: 'c', to: 'db', label: 'ok: ack' },
              { from: 'c', to: 'retry', label: 'failed', dashed: true },
              { from: 'retry', to: 'main', label: 'after delay', dashed: true },
              { from: 'c', to: 'dlq', label: '5th failure', tone: 'bad' },
              { from: 'dlq', to: 'ops' },
            ],
          },
          caption:
            'A failure goes round the retry loop with growing delays. The fifth failure leaves the main flow, so one bad message stops blocking good ones. The DLQ only helps if somebody is paged and has a tool to put messages back.',
        },
        {
          callout:
            "Tell transient failures from permanent ones. If the database is down, every message will fail: stop consuming and back off, or you'll dead-letter 10,000 good messages in a minute. If one payload is malformed, retrying won't help: dead-letter it at once.",
          kind: 'rule',
        },
        {
          see: [
            { href: '#/s/retries-breaker', label: 'Retries, backoff and circuit breakers', why: 'Why retries need jitter and a budget, and how a breaker stops a consumer hammering a dead dependency.' },
          ],
        },
      ],
    },
    {
      id: 'lag',
      title: 'Backpressure, lag, retention and replay',
      blocks: [
        {
          p: "A queue has no natural backpressure. The producer gets a fast acknowledgement whether or not anyone is keeping up, so overload shows as a growing backlog and nothing else. In a log that backlog is **lag**: the newest offset minus the group's committed offset.",
        },
        {
          diagram: {
            w: 640,
            h: 210,
            nodes: [
              { id: 'p', label: 'Producers', sub: '1,000 a second', x: 30, y: 30 },
              { id: 't', label: 'Topic', sub: 'lag +200 a second', x: 250, y: 30, kind: 'queue', tone: 'compare' },
              { id: 'c', label: 'Consumers', sub: '800 a second', x: 470, y: 30 },
              { id: 'n', label: 'After 1 hour: 720,000 behind, 15 minutes late', x: 150, y: 140, w: 340, h: 44, kind: 'note' },
            ],
            edges: [
              { from: 'p', to: 't' },
              { from: 't', to: 'c' },
            ],
          },
          caption:
            'A 20% shortfall looks harmless for a minute. After an hour it is 200 × 3,600 = 720,000 messages, which is 720,000 / 800 = 15 minutes of consumer time. Alert on lag as time, because that is what the customer feels.',
        },
        {
          p: "The fixes, in the order to try them: batch the consumer's writes, make each message cheaper, add consumers up to the partition count, then add partitions. If none is enough, push back for real: have the producer's API reject or slow requests when lag passes a threshold. Shedding load at the door beats delivering everything an hour late.",
        },
        {
          p: "**Retention** is how long a log keeps records, by age or by size, whether or not they've been read. It turns lag into a deadline: a group that falls further behind than retention loses data silently. A compacted topic keeps the latest record per key instead, which suits \"current state of each account\" topics.",
        },
        {
          p: "Retention is also what makes **replay** possible. Reset a group's offset, or start a new group from the beginning, and it reads history again. That's how you rebuild a search index, fix a consumer bug or feed a new service. Two conditions: the consumer must be idempotent, and anything with an outside effect (emails, payouts) must be switched off for the replay. A plain queue can't do this. Once a message is acknowledged it's gone.",
        },
      ],
    },
    {
      id: 'consumers',
      title: 'Idempotent consumers and schema evolution',
      blocks: [
        {
          p: "Every section so far ends in the same place: the consumer will see some messages twice. Make that harmless. Give each message an id at the producer, and have the consumer record the id in the same database transaction as the effect.",
        },
        {
          code: `BEGIN;
INSERT INTO processed_events (event_id) VALUES ('E9')
  ON CONFLICT DO NOTHING;
-- 0 rows inserted: seen before. Commit and skip the update.
UPDATE balances SET pence = pence + 4000 WHERE account_id = 7;
COMMIT;`,
          lang: 'sql',
          title: 'The id and the effect commit together or not at all',
        },
        {
          p: "The id must live with the effect. A \"seen\" set in Redis and a balance in Postgres can disagree after a crash, in either direction. Better still, make the operation idempotent by shape: \"set status to PAID\" or an upsert keyed by transfer id needs no id table at all.",
        },
        {
          see: [
            { href: '#/s/idempotency-keys', label: 'Idempotency keys', why: 'The lost response, the retry, and the unique index that turns it into a replay.' },
            { href: '#/s/outbox', label: 'Transactional outbox', why: 'The producer side: how an event is published at least once, and the consumer that skips repeats.' },
          ],
        },
        {
          h: 'Schemas change while messages are in flight',
        },
        {
          p: "Producers and consumers deploy at different times, and a log holds days of old messages. So at any moment new code reads old messages and old code reads new ones. Every schema change has to be safe in both directions.",
        },
        {
          list: [
            'Add fields as optional with a default. Old readers skip them; new readers fill the default on old data.',
            "Never reuse a field number or name for a different meaning, and never change a field's type.",
            'Remove a field only once no reader needs it, and keep its number reserved.',
            'To change meaning, add a new field or a new event type and run both for a while.',
          ],
        },
        {
          p: "A schema registry enforces this at publish time: it rejects a new version that would break existing readers. Without one, the check is a code review and a hope.",
        },
        {
          see: [
            { href: '#/s/serialization', label: 'Serialisation', why: 'Protobuf field numbers and Avro schema resolution, and what a reused field number does to an old reader.' },
          ],
        },
      ],
    },
    {
      id: 'choosing',
      title: 'Kafka, RabbitMQ or SQS',
      blocks: [
        {
          table: {
            head: ['', 'Kafka', 'RabbitMQ', 'SQS'],
            rows: [
              ['Model', 'Partitioned log. Consumers track offsets.', 'Broker routes messages through exchanges into queues.', 'Managed queue. Standard or FIFO.'],
              ['Order', 'Exact per partition.', 'Per queue with one consumer; lost with competing consumers or redelivery.', 'Standard: best effort. FIFO: per message group.'],
              ['Delivery', 'At least once. Transactions for Kafka-to-Kafka work.', 'At least once with consumer acks.', 'At least once. FIFO drops repeats sent within a short window.'],
              ['Replay', 'Yes, within retention.', 'Not from a classic queue.', 'No.'],
              ['Fan-out', 'Free: add a consumer group.', 'One queue per subscriber, bound to an exchange.', 'Put SNS in front, one queue per subscriber.'],
              ['A slow message', 'Blocks its partition.', 'Blocks nothing.', 'Blocks nothing in standard; blocks its group in FIFO.'],
              ['You run', 'A cluster, or pay for a managed one. Partitions and lag to watch.', 'A cluster. Memory and queue depth to watch.', 'Nothing.'],
              ['Pick it when', 'Several teams consume the same events, order per key matters, or you need replay.', 'You need per-message routing, priorities or request-reply between services.', "You're on AWS and need a job queue with no servers."],
            ],
          },
          caption: 'The first question is log or queue. The product follows from that and from what your company already runs.',
        },
        {
          callout:
            "\"Payment events go on Kafka, keyed by account id: the ledger, notifications and analytics all need them, in order per account, and I want replay. The email-sending jobs go on SQS with a dead-letter queue: each is independent, and a slow one shouldn't hold up the rest.\"",
          kind: 'interview',
          title: 'Use both, and say why',
        },
      ],
    },
    {
      id: 'when-not',
      title: 'When not to use a queue',
      blocks: [
        {
          list: [
            "The caller needs the answer to respond. A card authorisation has to say yes or no in about 100 ms; a balance check has to return the balance. That's a synchronous call with a timeout.",
            "The user must read their own write on the next screen. An asynchronous hop makes it eventually visible, and you'll end up faking it in the client.",
            'Two changes must commit together. If they can live in one database, one transaction is simpler and stronger than any messaging pattern.',
            "The volume is small and you already have Postgres. A jobs table read with `SELECT ... FOR UPDATE SKIP LOCKED` handles thousands of jobs an hour, and the job commits with the business row for free.",
            "Nobody will own the lag alert and the dead-letter queue. An unwatched queue fails silently, which is worse than a call that fails loudly.",
          ],
        },
        {
          p: "A queue also makes a flow harder to follow. A request that crosses three topics has no single stack trace. Budget for a correlation id on every message and tracing that follows it. When the flow must change two systems and neither may be lost, read [distributed transactions](#/c/distributed-transactions) next.",
        },
      ],
    },
  ],
  unverified: [
    'SQS: visibility timeout semantics as described (default and maximum values deliberately left off the page); FIFO queues deduplicate within a short window (I believe 5 minutes) and order per message group; standard queues are best-effort ordered.',
    'SQS fan-out through SNS with one queue per subscriber is the usual AWS pattern; not checked against current AWS documentation.',
    'RabbitMQ has a log-shaped "stream" queue type alongside classic and quorum queues; ordering is lost with competing consumers or redelivery.',
    "Kafka refuses an offset commit from a consumer whose group membership (generation) is stale, and treats a consumer that does not poll within max.poll.interval.ms (I believe 5 minutes by default) as gone. The 6-minute figure in the rebalance sequence is chosen to exceed that default.",
    "Kafka's default partitioner hashes the key modulo the partition count (murmur2 in the Java client); the page says \"usually\".",
    'Kafka transactions cover consume-process-produce within Kafka only; the wording here is from memory of the design, not checked against the current documentation.',
    'Kinesis is described only as a log like Kafka (shards as partitions); no Kinesis specifics were checked.',
    'A Postgres jobs table with SKIP LOCKED "handles thousands of jobs an hour" is a conservative figure from experience, not a benchmark.',
    'Card authorisation "about 100 ms" is an order-of-magnitude budget, not a scheme rule.',
  ],
};

export default page;
