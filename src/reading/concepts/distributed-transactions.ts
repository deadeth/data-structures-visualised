import type { Concept } from '../types';

const page: Concept = {
  id: 'distributed-transactions',
  title: 'Distributed transactions',
  group: 'Messaging',
  summary:
    "One business action often has to change two systems: two services, or a database and a queue. No single commit covers both. This page shows the bug that causes and the tools that contain it: the outbox, sagas, idempotency keys and reconciliation.",
  minutes: 14,
  sections: [
    {
      id: 'the-problem',
      title: 'The problem: one action, two systems',
      blocks: [
        {
          p: "Inside one database a transaction is all or nothing. A transfer service that updates a row, publishes an event and calls a payout partner is making three separate commitments to three systems. It can crash between any two of them.",
        },
        {
          diagram: {
            w: 640,
            h: 240,
            nodes: [
              { id: 'svc', label: 'Transfer service', x: 250, y: 20 },
              { id: 'db', label: 'Postgres', sub: 'transfer row', x: 30, y: 160, kind: 'store' },
              { id: 'k', label: 'Kafka', sub: 'TransferCreated', x: 250, y: 160, kind: 'queue' },
              { id: 'bank', label: 'Payout partner', sub: 'HTTP API', x: 470, y: 160 },
            ],
            edges: [
              { from: 'svc', to: 'db', label: '1 commit' },
              { from: 'svc', to: 'k', label: '2 publish' },
              { from: 'svc', to: 'bank', label: '3 pay out' },
            ],
          },
          caption:
            'Three systems, three separate commits. Nothing ties them together, so a crash after step 1 leaves a transfer nobody was told about, and a crash after step 3 leaves money sent with no record that it went.',
        },
        {
          p: "It's worse than crashes. Every network call has three outcomes: it worked, it failed, or you don't know. A timeout tells you nothing about whether the other side acted. Most of this page is about that third outcome.",
        },
        {
          callout:
            "\"This action spans the ledger and the payout partner, so there's no transaction that covers both. I'll make each step a local transaction, make every step safe to repeat, and decide for each one whether it can be undone.\"",
          kind: 'interview',
          title: 'Name the problem before you solve it',
        },
      ],
    },
    {
      id: 'dual-write',
      title: 'The dual-write bug',
      blocks: [
        {
          p: "The smallest case is a database and a queue. The service commits the row, then publishes the event. This is called a dual write, and it loses events.",
        },
        {
          sequence: {
            actors: ['Transfer service', 'Postgres', 'Kafka', 'Ledger'],
            messages: [
              { from: 'Transfer service', to: 'Postgres', label: 'insert transfer T1, commit', tone: 'ok' },
              { from: 'Transfer service', to: 'Kafka', label: 'publish TransferCreated T1', tone: 'bad', dashed: true, note: 'The service is killed by a deploy before this is sent' },
              { from: 'Kafka', to: 'Ledger', label: 'nothing arrives', tone: 'muted', dashed: true, note: 'T1 exists in Postgres. The ledger never hears of it.' },
            ],
          },
          caption:
            'The event lived only in the memory of a process that is gone. Nothing on disk says an event is owed, so no retry will ever send it.',
        },
        {
          table: {
            head: ['Order', 'Crash between the two', 'Result'],
            rows: [
              ['Commit, then publish', 'Row saved, event never sent.', 'A lost event. Downstream is wrong for good.'],
              ['Publish, then commit', 'Event sent, commit fails or rolls back.', 'A phantom event: consumers act on a change that never happened.'],
            ],
          },
          caption: 'Neither order is safe. Swapping them only swaps the bug.',
        },
        {
          callout:
            "\"I'll publish inside the database transaction, so if the publish fails I roll back.\" The publish can succeed and the commit still fail, which is the phantom event again. And you're now holding a database connection and row locks open across a network call.",
          kind: 'pitfall',
        },
        {
          p: "At 100 transfers a second, a deploy that kills ten in-flight requests loses up to ten events. That's rare enough to pass every test and common enough to show up in every month-end.",
        },
      ],
    },
    {
      id: 'two-phase-commit',
      title: 'Two-phase commit, and why services rarely use it',
      blocks: [
        {
          p: "The textbook answer is two-phase commit (2PC). A coordinator asks every participant to **prepare**: write the change durably, keep the locks, and vote yes or no. If all vote yes, the coordinator logs \"commit\" and tells everyone. A participant that voted yes has given up its right to decide alone.",
        },
        {
          sequence: {
            actors: ['Coordinator', 'Ledger DB', 'FX DB'],
            messages: [
              { from: 'Coordinator', to: 'Ledger DB', label: 'prepare' },
              { from: 'Coordinator', to: 'FX DB', label: 'prepare' },
              { from: 'Ledger DB', to: 'Coordinator', label: 'yes (locks held)', tone: 'compare' },
              { from: 'FX DB', to: 'Coordinator', label: 'yes (locks held)', tone: 'compare' },
              { from: 'Coordinator', to: 'Ledger DB', label: 'commit', tone: 'bad', dashed: true, note: 'Coordinator logs commit, then crashes before sending it' },
              { from: 'Ledger DB', to: 'Coordinator', label: 'what was decided?', tone: 'bad', dashed: true, note: "No answer. Both databases wait, rows locked, until the coordinator is back." },
            ],
          },
          caption:
            "After voting yes, neither database may commit or abort on its own. A dead coordinator leaves the customer's account row locked for as long as it stays dead.",
        },
        {
          p: "2PC is correct, and it works well inside one distributed database, where a single team runs every participant. Across services it's rarely chosen, for four reasons.",
        },
        {
          list: [
            "Every participant must support prepare. Postgres does. Kafka, SQS and a partner bank's HTTP API don't offer it to you.",
            'Availability multiplies. Three participants at 99.9% each can all be reached 0.999 × 0.999 × 0.999 = 99.7% of the time, and the transaction needs all three.',
            "Locks are held across network round trips, so one slow participant slows every other transaction touching those rows.",
            "It couples services that were split so they could fail and deploy separately. One team's outage now holds another team's locks.",
          ],
        },
        {
          see: [
            { href: '#/s/two-phase-commit', label: 'Two-phase commit', why: 'Crash the coordinator at each point and watch who can decide and who must wait.' },
          ],
        },
      ],
    },
    {
      id: 'sagas',
      title: 'Sagas: local transactions and compensations',
      blocks: [
        {
          p: "A saga gives up on one big commit. It runs the action as a chain of local transactions, each committed on its own. If a later step fails, the earlier ones are undone by **compensating actions**: release the hold, refund the fee. No lock is held between services, so nothing blocks. The cost is that other requests can see the half-done state.",
        },
        {
          diagram: {
            w: 640,
            h: 400,
            groups: [
              { label: 'Orchestrated: one service drives', x: 10, y: 10, w: 620, h: 225 },
              { label: 'Choreographed: each reacts to events', x: 10, y: 255, w: 620, h: 135 },
            ],
            nodes: [
              { id: 'o', label: 'Orchestrator', sub: 'saga log', x: 250, y: 40, tone: 'follow' },
              { id: 'ol', label: 'Ledger', x: 30, y: 160 },
              { id: 'of', label: 'FX', x: 250, y: 160 },
              { id: 'op', label: 'Payout', x: 470, y: 160 },
              { id: 'cl', label: 'Ledger', x: 30, y: 305, w: 110 },
              { id: 'cf', label: 'FX', x: 265, y: 305, w: 110 },
              { id: 'cp', label: 'Payout', x: 500, y: 305, w: 110 },
            ],
            edges: [
              { from: 'o', to: 'ol', label: '1 hold', both: true },
              { from: 'o', to: 'of', label: '2 convert', both: true },
              { from: 'o', to: 'op', label: '3 pay out', both: true },
              { from: 'cl', to: 'cf', label: 'FundsHeld', dashed: true },
              { from: 'cf', to: 'cp', label: 'Converted', dashed: true },
            ],
          },
          caption:
            "Above, the orchestrator's log says where every transfer is. Below, the same flow has no centre: to find a stuck transfer you join three services' logs.",
        },
        {
          table: {
            head: ['', 'Orchestrated', 'Choreographed'],
            rows: [
              ['Who knows the flow', 'One orchestrator, with a row per saga.', 'Nobody. It is implied by who subscribes to what.'],
              ['Adding a step', 'Change the orchestrator.', 'Change the services on either side of the new step.'],
              ['Finding a stuck saga', 'Query the saga log.', "Trace events across every service."],
              ['Coupling', 'The orchestrator knows every service.', 'Services know only event types.'],
              ['Choose it when', 'Money moves, there are more than three steps, or someone must answer "where is it?".', 'Two or three steps, loosely related, and no step needs undoing.'],
            ],
          },
          caption: 'For payments, orchestrate. The question "where is transfer T1 right now?" will be asked daily.',
        },
        {
          h: 'What compensations cannot do',
        },
        {
          p: "A compensation is a new action, not a rollback. The original stays in the history and other readers may have acted on it. Three limits follow.",
        },
        {
          list: [
            "Some steps can't be undone: money sent on an instant payment rail, an email, a card shipped. The last such step is the **pivot**. Put every step that can fail for a business reason before it, and only steps that can be retried until they succeed after it.",
            "A compensation must not fail for a business reason. \"Release the hold\" always can. \"Take the money back from the recipient\" might not, so it's no compensation.",
            "There's no isolation. Between step 1 and step 3 another request sees the hold. Make that state explicit (pending, held) so readers know not to treat it as final.",
          ],
        },
        {
          see: [
            { href: '#/s/saga', label: 'Sagas', why: 'Fail a step before and after the pivot, lose a reply, and crash the orchestrator mid-saga.' },
          ],
        },
      ],
    },
    {
      id: 'outbox',
      title: 'The transactional outbox and CDC',
      blocks: [
        {
          p: "A saga step often has to change its database and send the next message. That's the dual write again. The outbox fixes it by turning two writes into one: the event is inserted into an `outbox` table in the same local transaction as the business row. A separate relay publishes outbox rows afterwards.",
        },
        {
          diagram: {
            w: 640,
            h: 270,
            nodes: [
              { id: 'svc', label: 'Transfer service', x: 30, y: 30 },
              { id: 'db', label: 'Postgres', sub: 'transfer + outbox row', w: 160, x: 240, y: 30, kind: 'store', tone: 'ok' },
              { id: 'relay', label: 'Relay or CDC', sub: 'reads the outbox', x: 470, y: 30 },
              { id: 'k', label: 'Kafka', sub: 'may hold E9 twice', x: 470, y: 180, kind: 'queue' },
              { id: 'cons', label: 'Ledger consumer', sub: 'skips ids it has seen', w: 160, x: 240, y: 180 },
              { id: 'ldb', label: 'Ledger DB', sub: 'entry + event id', x: 30, y: 180, kind: 'store', tone: 'ok' },
            ],
            edges: [
              { from: 'svc', to: 'db', label: '1 tx' },
              { from: 'db', to: 'relay' },
              { from: 'relay', to: 'k', label: 'publish, retry' },
              { from: 'k', to: 'cons' },
              { from: 'cons', to: 'ldb', label: '1 tx' },
            ],
          },
          caption:
            'There are two local transactions, one at each end, and a path between them that only promises at least once. The business row and its event can no longer disagree, and a repeated event is caught by the id stored with the ledger entry.',
        },
        {
          p: "The relay comes in two forms. A **polling relay** queries for unpublished rows every 100 ms or so: simple, with a little latency and query load. **Change data capture** (CDC) reads the database's own log, as Debezium does with the Postgres write-ahead log, and publishes each outbox insert: no polling, but a connector to run and a replication slot that fills the disk if the connector stops.",
        },
        {
          p: "What it costs: events are delayed by the relay, and they arrive at least once, because the relay can publish and then die before recording that it did. The outbox moves the problem from \"lost\" to \"repeated\", which is the one you can solve.",
        },
        {
          see: [
            { href: '#/s/outbox', label: 'Transactional outbox', why: 'Dual write losing an event, then the outbox with a relay crash that publishes the same id twice.' },
          ],
        },
      ],
    },
    {
      id: 'idempotency',
      title: 'Idempotency keys, end to end',
      blocks: [
        {
          p: "Everything above produces retries: the client's, the orchestrator's, the relay's, the broker's. A retry is only safe if the receiver can tell it from a new request. So every hop carries an id, and every receiver stores that id in the same transaction as its effect.",
        },
        {
          diagram: {
            w: 640,
            h: 380,
            nodes: [
              { id: 'app', label: 'Mobile app', sub: 'makes K1 once', x: 30, y: 30, kind: 'client' },
              { id: 'api', label: 'Transfer API', sub: 'stores K1 + transfer', w: 160, x: 240, y: 30 },
              { id: 'bank', label: 'Payout partner', sub: 'stores T1-payout', x: 470, y: 30 },
              { id: 'k', label: 'Kafka', x: 250, y: 170, kind: 'queue' },
              { id: 'led', label: 'Ledger consumer', sub: 'stores E9 + entry', w: 160, x: 240, y: 300 },
            ],
            edges: [
              { from: 'app', to: 'api', label: 'K1' },
              { from: 'api', to: 'bank', label: 'key' },
              { from: 'api', to: 'k', label: 'event id E9', dashed: true },
              { from: 'k', to: 'led', label: 'E9, maybe twice', dashed: true },
            ],
          },
          caption:
            "Three hops, three keys. Each is created once by the sender, before the first attempt, and checked by the receiver. Break the chain at one hop and a retry there pays out twice, however careful the others are.",
        },
        {
          list: [
            "The client makes the key, once per user action, and reuses it on every retry. A key made per attempt protects nothing.",
            "Derive downstream keys from your own ids (`T1-payout`, `T1-fx`). A random key made at call time is lost in a crash, and the retry sends a new one.",
            'Store the key with the effect in one transaction. A key in Redis and a payment in Postgres can disagree after a crash.',
            "When a partner offers no idempotency key, send a unique reference and query by it before retrying.",
          ],
        },
        {
          see: [
            { href: '#/s/idempotency-keys', label: 'Idempotency keys', why: 'The lost response and the double charge, then the same retry with a key and a unique index.' },
          ],
        },
      ],
    },
    {
      id: 'exactly-once',
      title: 'The exactly-once myth',
      blocks: [
        {
          p: "A sender that gets no reply can't tell a lost request from a lost reply. If it gives up, the message may be lost: at most once. If it retries, the message may arrive twice: at least once. No protocol removes that choice. What you can build is **effectively once**: deliver at least once, and make the second delivery do nothing.",
        },
        {
          table: {
            head: ['The claim', 'What you actually get'],
            rows: [
              ['"Kafka exactly-once"', 'A consumer that reads from Kafka and writes to Kafka can commit its output and its offsets together. A write to Postgres or a call to a bank is outside that.'],
              ['"SQS FIFO exactly-once processing"', 'The queue drops a repeated send inside a short window. A consumer that crashes after its work and before deleting the message still sees it again.'],
              ['"Flink exactly-once"', "Each record counts once in the job's own state after a restore. Records are still processed twice, and any outside call is repeated."],
              ['"Our outbox guarantees delivery"', 'At least once. The consumer has to do the other half.'],
            ],
          },
          caption: 'Every "exactly-once" has a boundary. Ask where it ends, because the bug is on the other side of it.',
        },
        {
          callout:
            "\"I don't rely on exactly-once delivery. I get at-least-once from the outbox and the broker, and I make each consumer idempotent by storing the event id with its effect. The outcome is once; the delivery isn't.\"",
          kind: 'interview',
        },
        {
          see: [
            { href: '#/s/stream-checkpoints', label: 'Stream checkpoints', why: 'Where exactly-once in state comes from, and why some records are still processed twice.' },
            { href: '#/c/message-queues-and-streams', label: 'Message queues and streams', why: 'Where duplicates come from: redelivery, rebalances and replays.' },
          ],
        },
      ],
    },
    {
      id: 'reconciliation',
      title: 'Reconciliation as the backstop',
      blocks: [
        {
          p: "All of the above assumes the code is right. It won't always be. A compensation gets stuck, an engineer fixes a row by hand, the partner pays out twice on their side. Reconciliation is an independent check that compares two records of the same facts and lists where they differ. It's the control that finds what the patterns missed, and in a regulated firm you'll be asked to show it.",
        },
        {
          diagram: {
            w: 640,
            h: 350,
            nodes: [
              { id: 'ours', label: 'Our ledger', sub: 'what we believe', x: 30, y: 20, kind: 'store' },
              { id: 'theirs', label: 'Partner statement', sub: 'what happened', w: 150, x: 460, y: 20, kind: 'store' },
              { id: 'job', label: 'Reconciliation job', sub: 'match by reference', w: 160, x: 240, y: 140, tone: 'compare' },
              { id: 'ok', label: 'Matched', sub: '99.9% of items', x: 30, y: 270, tone: 'ok' },
              { id: 'breaks', label: 'Breaks queue', sub: 'owned, aged, alerted', w: 150, x: 460, y: 270, tone: 'bad' },
            ],
            edges: [
              { from: 'ours', to: 'job' },
              { from: 'theirs', to: 'job' },
              { from: 'job', to: 'ok' },
              { from: 'job', to: 'breaks', label: 'differs' },
            ],
          },
          caption:
            'The job trusts neither side. Every item ends up matched or in a queue with an owner and an age. A break that is a day old is usually timing; one that is three days old is a bug or a loss.',
        },
        {
          p: "Breaks come in four kinds: in our ledger and not on the statement, on the statement and not in our ledger, on both with different amounts, and timing differences that clear the next day. Run it at least daily against every external party, and run an internal one too: every saga that isn't finished after an hour, and every hold with no matching transfer. The [ledger design](#/d/ledger) on this site runs a nightly parity job of that kind between card authorisations and holds.",
        },
        {
          callout:
            "Idempotency and sagas prevent the errors you thought of. Reconciliation detects the ones you didn't. A design that moves money needs both, and needs someone who owns the breaks queue.",
          kind: 'rule',
        },
      ],
    },
    {
      id: 'worked-example',
      title: 'Worked example: a £1,000 transfer to euros',
      blocks: [
        {
          p: "A customer sends £1,000 to a euro account at a rate of 1.15. Four steps, in three services and one partner. The order is chosen by one rule: compensable steps first, then the pivot, then steps that can only be retried.",
        },
        {
          table: {
            head: ['Step', 'Local transaction', 'If a later step fails', 'Kind'],
            rows: [
              ['1. Ledger', 'Place a £1,000 hold on the customer.', 'Release the hold.', 'Compensable'],
              ['2. FX', 'Book £1,000 into €1,150 at 1.15.', 'Unwind at the current rate; the firm takes any loss.', 'Compensable, at a cost'],
              ['3. Payout partner', 'Send €1,150 on an instant rail.', "Can't be recalled.", 'Pivot'],
              ['4. Ledger', 'Turn the hold into a posted debit.', 'Retry until it succeeds.', 'Retriable'],
            ],
          },
          caption: 'The irreversible step is as late as it can be, and nothing after it is allowed to fail for a business reason.',
        },
        {
          p: "Now the failure in the middle. Steps 1 and 2 are done. The orchestrator calls the partner with key `T1-payout` and the call times out after 5 seconds.",
        },
        {
          sequence: {
            actors: ['Orchestrator', 'Ledger', 'FX', 'Payout partner'],
            messages: [
              { from: 'Orchestrator', to: 'Ledger', label: 'hold £1,000 (key T1-hold)', tone: 'ok' },
              { from: 'Orchestrator', to: 'FX', label: 'convert at 1.15 (key T1-fx)', tone: 'ok' },
              { from: 'Orchestrator', to: 'Payout partner', label: 'send €1,150 (key T1-payout)', tone: 'follow' },
              { from: 'Payout partner', to: 'Orchestrator', label: 'reply lost', tone: 'bad', dashed: true, note: 'Timeout after 5 s. Sent, or not? The saga log says "payout: unknown".' },
              { from: 'Orchestrator', to: 'Payout partner', label: 'status of T1-payout?', tone: 'compare' },
              { from: 'Payout partner', to: 'Orchestrator', label: 'accepted', tone: 'ok', note: 'Past the pivot: only forwards from here' },
              { from: 'Orchestrator', to: 'Ledger', label: 'post debit (key T1-post)', tone: 'ok' },
            ],
          },
          caption:
            'The timeout is not treated as a failure. The orchestrator records "unknown", asks, and only then picks a direction. Compensating on the timeout would have released the hold while €1,150 left the building.',
        },
        {
          p: "The status query has three answers, and each one decides the direction.",
        },
        {
          list: [
            "**Accepted.** The money has gone. Go forwards: post the debit, and retry that for as long as it takes.",
            "**Rejected** (a closed account, say). A clean business failure before the pivot. Compensate in reverse: unwind the FX, then release the hold.",
            "**Never heard of it.** The request was lost. Send it again with the same key. If the partner's status endpoint is down too, the saga stays \"unknown\", the hold stays in place, and an alert fires after a set time. Money held too long is a complaint. Money sent twice is a loss.",
          ],
        },
        {
          callout:
            "Unwinding the FX is a new trade at today's rate. If the rate has moved from 1.15 to 1.16, selling €1,150 returns 1,150 / 1.16 = £991.38. The customer's hold is released in full, so the firm is down £8.62. That is a real cost of compensating, and a reason to validate the recipient before booking FX.",
          kind: 'example',
          title: 'A compensation with a price',
        },
        {
          p: "Each step that sends a message does it through an outbox, each receiver stores its key with its effect, and the next morning's reconciliation matches the partner's statement line for `T1-payout` against the posted debit. If the orchestrator had a bug and never posted it, that's where it shows.",
        },
      ],
    },
    {
      id: 'choosing',
      title: 'Which tool for which gap',
      blocks: [
        {
          table: {
            head: ['Tool', 'Closes', 'Leaves open'],
            rows: [
              ['One database transaction', 'Everything, when both changes fit in one database.', 'Nothing. Use it whenever you can.'],
              ['Two-phase commit', 'Atomic commit across databases that support prepare.', 'Blocking on coordinator failure; partners and brokers that cannot take part.'],
              ['Transactional outbox', 'The lost event between a database and a broker.', 'Duplicates downstream.'],
              ['Idempotency keys', 'Duplicates from any retry.', 'Steps that never ran at all.'],
              ['Saga', 'A multi-step action that must finish or be undone.', 'Isolation, and steps that cannot be undone.'],
              ['Reconciliation', 'Detection of whatever the rest missed.', 'Prevention: it finds the error a day late.'],
            ],
          },
          caption: 'The tools stack. A payment flow uses the last four together.',
        },
        {
          callout:
            "Say them in this order: can it be one local transaction? If not, which step is the pivot? Then outbox for every handoff, a key on every hop, a saga log to know where each transfer is, and reconciliation against the partner's statement. Then pick one failure, a timeout at the pivot, and walk it through.",
          kind: 'interview',
          title: 'The order to say it in',
        },
      ],
    },
  ],
  unverified: [
    'That distributed databases such as Spanner and CockroachDB use two-phase commit internally across shards is only alluded to ("works well inside one distributed database"); not checked against their documentation.',
    'Kafka, SQS and typical partner HTTP APIs do not expose a prepare phase to application transactions (Kafka has its own transaction protocol, which is not XA).',
    'Debezium reads the Postgres write-ahead log through a replication slot, and a stopped connector lets WAL build up; consistent with the outbox page on this site, not re-checked against Debezium documentation.',
    'SQS FIFO deduplication window and the "exactly-once processing" wording are from memory of AWS documentation.',
    'The Flink row summarises the stream-checkpoints page on this site rather than Flink documentation.',
    'A polling relay interval of "100 ms or so" is a typical figure, not a recommendation from a source.',
    'Whether a given payout partner offers idempotency keys or a status-by-reference endpoint varies; the worked example assumes one that offers both.',
    'Instant payment rails (SEPA Instant, Faster Payments) are treated as irrevocable once accepted; scheme recall procedures exist and were not checked.',
    'The 1.15 and 1.16 rates, the 5-second timeout, "99.9% of items matched" and the one-day and three-day break ages are illustrative.',
    'That regulators or auditors ask to see reconciliation controls is general industry practice; no specific rule was checked.',
  ],
};

export default page;
