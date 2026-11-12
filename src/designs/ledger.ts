import type { Design } from './types';

/**
 * Ledger service, as a high-level design.
 *
 * The question: "Design a ledger service that must ensure strict consistency
 * for account balances while supporting high-frequency transaction writes."
 *
 * The baseline is the ledger of a UK business banking app: about a million
 * business accounts, 1,000 transactions a second on average and 10,000 at peak.
 * Double-entry, append-only entries in Postgres, sharded by business, with the
 * balance row updated by a conditional statement in the same transaction as the
 * entries, synchronous replication for durability, an outbox read by change data
 * capture for everything downstream, and reconciliation against the bank and the
 * schemes to prove it is right. The alternatives on each component include the
 * purpose-built route (TigerBeetle) for when hot accounts dominate.
 */
export const ledger: Design = {
  id: 'ledger',
  name: 'Ledger service',
  blurb: 'Follow one payment through the ledger, then open any part to see what it does and what you could use instead.',
  rest: 'Press Play to follow a payment, or open any box or chip. In the diagram, arrows move and Enter opens.',
  restTouch: 'Press Play to follow one payment, or tap any box or chip to open it.',
  size: { w: 1280, h: 520 },
  frame: { x: 690, y: 96, w: 430, h: 318, label: 'Ledger shard × 16', note: 'One Postgres cluster each' },

  components: [
    {
      id: 'client',
      name: 'Customer apps',
      short: 'Apps',
      tech: 'app, API',
      x: 64, y: 200, w: 116, h: 64, kind: 'input',
      what: 'The mobile app, the web app and the public API that accounting software and partners call. Each one creates an idempotency key when the user presses Pay, and sends the same key on every retry of that payment.',
      why: 'Phones lose signal mid-request. Without a key chosen once, before the first attempt, a retry cannot be told apart from a second payment.',
      numbers: [
        { text: 'A version 4 UUID per payment. Stripe accepts keys of up to 255 characters and suggests UUIDs.', from: "Not a sum. The 255-character limit and the advice to use UUIDs are from Stripe's idempotent requests docs, cited on the page. A version 4 UUID has 122 random bits, so two clients picking the same key by chance is not a practical worry." },
      ],
      fails: 'A client that makes a new key on each retry defeats the whole scheme. Generate the key when the payment is drafted, store it with the draft, and reuse it.',
      alternatives: [
        {
          name: 'Client-chosen idempotency key per payment', chosen: true, good: 'The only party that knows two requests are the same attempt is the one that sent them.', cost: 'Every client must get it right, so the SDKs do it for them.',
          what: 'The app makes a UUID when the payment is drafted, stores it with the draft, and sends it as the Idempotency-Key header on every attempt. The ledger stores it with a unique constraint in the same transaction as the entries, for 72 hours.',
          pros: ['Only the sender knows two requests are one attempt, so the sender names it.', 'A retry after a lost reply, like k7 on the tour, returns the saved result and moves no money.', 'The same scheme works for the app, the web app and API partners.'],
          cons: ['Every client must make the key once, before the first attempt, so the SDKs do it for them.', 'A partner whose code makes a new key per retry can still pay twice, and the server cannot tell.', 'Keys must be kept: about 40 GB across all shards for 72 hours.'],
        },
        {
          name: 'Server-side duplicate detection by payee, amount and time', good: 'Catches a user who pays the same invoice twice by hand.', cost: 'A heuristic: it blocks real repeat payments and misses retries outside its window. Use it as a warning, not as idempotency.',
          what: 'The Banking API looks for an earlier payment from the same account to the same payee for the same amount within a short window, and warns or blocks. It needs nothing from the client.',
          pros: ['Catches a user who pays the same invoice twice by hand, which no key can.', 'Works for clients that send no key at all.', 'Useful as a warning screen beside keys.'],
          cons: ['A heuristic: a business that really pays the same supplier the same amount twice is blocked.', 'Misses retries that arrive after the window.', 'It can only guess, so this design keeps it as a warning, not as idempotency.'],
        },
        {
          name: 'No key: tell clients not to retry', good: 'Nothing to build.', cost: 'Clients retry anyway. A timeout leaves the user unsure whether money moved.',
          what: 'Clients are told never to retry a payment and to ask the user instead. The server treats every request as a new payment.',
          pros: ['Nothing to build or store.', 'No key table on each shard.'],
          cons: ['Clients, proxies and libraries retry anyway, and each retry is a second payment.', 'After a timeout the user cannot tell whether £1,200 moved.', 'Fails the requirement never to apply the same request twice.'],
        },
        {
          name: 'Server-issued payment id: create a draft, then confirm', good: 'The server makes the id, so a badly written client cannot get it wrong.', cost: 'Two round trips per payment, and a retried create makes a second draft.',
          what: 'The app first creates a draft payment and gets back its id, then confirms that id to pay. A draft can move to paid only once, so confirming twice pays once.',
          pros: ['The id comes from the server, so a client cannot invent a fresh one per retry.', 'Confirm is safe to retry with no key logic in the client.', 'The draft is a natural place for the user to review before paying.'],
          cons: ['Two round trips before money moves.', 'A retried create makes a second, unused draft that needs tidying.', 'The ledger still wants a key per call, so the API derives one from the payment id.'],
        },
      ],
      say: 'The client owns the idempotency key because only the client knows that two requests are the same attempt. The ledger enforces it.',
    },
    {
      id: 'api',
      name: 'Banking API',
      tech: 'auth, workflow',
      x: 310, y: 200, w: 160, h: 56, kind: 'shared',
      what: 'The edge of the bank. It authenticates the user (strong customer authentication for a payment), checks the payee with Confirmation of Payee, asks fraud and limit services, then runs the payment as a small state machine: reserve in the ledger, send to the scheme, post or void. It serves balance and statement reads by calling the ledger.',
      why: 'The ledger should know about money, not about Faster Payments, cards or fraud. Keeping the orchestration here lets the ledger stay a small, strict service with one job.',
      numbers: [
        { text: 'Faster Payments allows up to £1 million a payment; each bank sets its own lower limits.', from: "Not a sum. The scheme limit is from Pay.UK, cited on the page. Each bank sets its own lower limit, so the Banking API checks the bank's limit, not the scheme's." },
        { text: 'APP scam reimbursement covers Faster Payments and CHAPS, up to £85,000 a claim, since 7 October 2024, for consumers, micro-enterprises and charities.', from: "Not a sum. The date, the rails and who is covered are from the PSR page, cited. The words 'per claim' are from the Norton Rose Fulbright summary of PS24/7, also cited, because the PSR page does not say per claim." },
      ],
      fails: 'It crashes between steps. Each step is recorded before the next starts, so a recovery worker resumes the payment from its last state, using the same idempotency key for every call it repeats.',
      alternatives: [
        {
          name: 'Payment state machine, recorded step by step', chosen: true, good: 'Every payment is in a named state (reserved, sent, posted, voided), so a crash leaves something a worker can finish.', cost: 'More code than a straight-line handler, and the states need tests.',
          what: 'Each payment is a row with a state: reserved, sent, posted or voided. The API records each step before starting the next, so a recovery worker can pick up any payment that stopped, repeating calls with the same idempotency key.',
          pros: ['A crash leaves a named state that a worker can finish.', 'Every ledger call is keyed, so repeating a step is harmless.', 'The states answer what support and audit ask: where is this payment?', 'No extra system on the money path.'],
          cons: ['More code than a straight-line handler.', 'Every state and transition needs tests, above all the timeout after sending.', 'A recovery worker to build and watch.'],
        },
        {
          name: 'A workflow engine (Temporal and similar)', good: 'Retries, timers and resumption come built in.', cost: 'Another system on the money path, and its SDK in every service.',
          what: 'The payment is written as a workflow in a durable execution engine. The engine records each step and resumes the workflow after a crash, so reserve, send and post or void need no hand-written state table.',
          pros: ['Retries, timers and resumption come built in.', 'A wait, such as asking the scheme for status after a timeout, is a timer, not a polling job.', "The engine's history shows every step a payment took."],
          cons: ['Another system on the money path, with its own failover.', 'Its SDK in every service that takes part.', 'Workflow code has rules of its own (it is replayed), which the team must learn.', 'For four states, more machinery than the problem needs.'],
        },
        {
          name: 'Let the ledger call the scheme', good: 'One service fewer.', cost: 'The ledger now waits on an outside network while it holds state, and learns about every rail.',
          what: 'The ledger reserves, sends to Faster Payments, and posts or voids by itself. The Banking API only authenticates and hands over.',
          pros: ['One service fewer and one hop fewer.', 'Reserve and send live in one place.'],
          cons: ['The ledger waits on an outside network while it holds payment state.', 'It learns every rail: Faster Payments, Bacs, CHAPS and cards.', 'A slow scheme now slows the service that every balance read depends on.'],
        },
      ],
      say: 'The ledger records money. It does not talk to Faster Payments. The payment service owns the conversation with the scheme and drives the ledger through reserve, post and void.',
    },
    {
      id: 'fps',
      name: 'Faster Payments',
      tech: 'scheme, 24/7',
      x: 310, y: 34, w: 160, h: 56, kind: 'outside',
      what: 'The UK\'s real-time payment scheme, open all day every day. The payment leaves the business\'s account and reaches the payee\'s bank in real time. Bacs (three working days) and CHAPS (high value, same day) are the other bank rails, and cards have their own.',
      why: 'The scheme is outside your control. It can accept, reject or go quiet. The ledger has to represent "we have promised this money but do not yet know the outcome", which is what a pending entry is for.',
      numbers: [
        { text: 'Up to £1 million per payment at scheme level, raised from £250,000 in 2022.', from: "Not a sum. From Pay.UK's 2022 press release, cited on the page: up to £1 million from 10 February 2022, up from £250,000." },
      ],
      fails: 'A timeout after sending is the dangerous case: the payment may or may not have gone. Keep the funds reserved, ask the scheme for the status using the same payment identifier, and only void once you know it failed.',
      alternatives: [
        {
          name: 'Reserve, send, then post or void', chosen: true, good: 'The customer cannot spend the money twice while the scheme decides, and a rejection simply releases it.', cost: 'Pending entries to track and expire.',
          what: "A pending transaction first holds 120020p against Bright Bakery's available balance. Then the payment goes to Faster Payments. On acceptance the pending is posted, on rejection it is voided, and on a timeout it stays held until the status is known.",
          pros: ['The customer cannot spend the money twice while the scheme decides.', 'A rejection simply releases the hold: no reversal on the statement.', 'A timeout is safe: the money stays held until the scheme answers either way.'],
          cons: ['Pending entries to track, and to expire if a payment never resolves.', 'Two ledger calls per payment, reserve and post, instead of one.', 'Available and ledger balances differ while a payment is pending, which the app must explain.'],
        },
        {
          name: 'Post first, reverse on rejection', good: 'One fewer state.', cost: 'Statements show a payment and a reversal for every rejection, and a reversal can race a new payment.',
          what: 'The payment is posted as final before it is sent. If Faster Payments rejects it, a reversing transaction puts the money back.',
          pros: ['One fewer state: no pending to track or expire.', 'One ledger call in the usual case, where the scheme accepts.', 'The ledger balance is final at once.'],
          cons: ['Every rejection shows as a payment and a reversal on the statement.', 'The reversal can race a new payment on the same account.', 'A timeout still needs a status check, so the hard case is no simpler.'],
        },
        {
          name: 'Send first, record afterwards', good: 'Fast to build.', cost: 'A crash after sending loses the record of money that has left. Never do this.',
          what: 'The API sends to Faster Payments and writes to the ledger only once the scheme accepts. Nothing is held while the scheme decides.',
          pros: ['Fastest to build.', 'No pending state in the ledger.', 'One ledger write per payment, and only for payments that succeeded.'],
          cons: ['A crash after sending loses the record of money that has left.', 'Nothing stops two payments spending the same balance while both are in flight.', 'Never do this on a ledger.'],
        },
      ],
      say: 'Anything the ledger cannot know yet is pending. Funds are reserved before we send, and posted or released when the scheme answers.',
    },
    {
      id: 'ledger',
      name: 'Ledger API',
      tech: 'rules, routing',
      x: 550, y: 200, w: 130, h: 56, kind: 'shared',
      what: 'A stateless service in front of the shards. It checks that every transaction balances (entries sum to zero per currency), that amounts are integers in minor units, and that accounts exist and are open. It finds the shard from the business that owns the accounts, then sends the whole transaction to that shard as one database call.',
      why: 'Rules about money belong in one place. Sending the transaction as a single call, a stored function, means row locks are held only for the time the database itself needs, never across a network round trip.',
      numbers: [
        { text: 'Routing: business id to one of 16 shards, through a small directory table cached in memory.', from: "16 is from the 'Numbers to have ready' table: 10,000 a second at peak ÷ an assumed 1,000 a shard = 10 shards, raised to 16 for headroom and uneven tenants. The directory has one row per business, about a million; at a few tens of bytes a row (assumption) that is tens of megabytes, cheap to cache." },
        { text: 'House accounts (fee income, scheme settlement) exist once per shard, so a payment never leaves its shard; finance sums them across shards.', from: "A design choice, not a sum. A payment touches one business's accounts plus house accounts; with a copy of each house account on every shard, the whole transaction stays in one database." },
        { text: 'TigerBeetle\'s sum: a lock held across two round trips of 0.5 ms blocks that row for at least 1 ms, so about 1,000 writes a second on one row at most.', from: "From TigerBeetle's 'Rediscovering transaction processing', cited on the page: 2 round trips × 0.5 ms = 1 ms with the row locked; 1 second ÷ 1 ms = 1,000 writes a second on that row, at most. Real locks are held longer, so real figures are lower." },
      ],
      fails: 'It is stateless, so losing an instance loses nothing. A bug here is the real risk: a rule that lets through an unbalanced transaction. The database checks the sum again in the same function, as a second line of defence.',
      alternatives: [
        {
          name: 'One database call per transaction (stored function)', chosen: true, good: 'Locks are held for microseconds of in-database work plus the commit, not for network round trips.', cost: 'Business rules in SQL need the same review and tests as application code.',
          what: 'The Ledger API sends the whole transaction (key, balance updates, entries, outbox row) to the shard as one call to a stored function. The database does all the work in one go, so no row lock waits on the network.',
          pros: ['Locks last for in-database work plus the commit, not for network round trips.', 'One round trip per transaction, so a hot row is limited by the commit, not by the network.', 'The function checks again that the entries sum to zero: a second line of defence.', 'A repeated key returns the stored result from the same call.'],
          cons: ['Business rules in SQL need the same review and tests as application code.', 'Changing the function is a database deploy: a new version beside the old, then switch callers.', 'Harder to debug and profile than service code.'],
        },
        {
          name: 'Interactive transaction from the service', good: 'All logic in one language, easy to read.', cost: 'Ten to twenty statements, each a round trip while locks are held. TigerBeetle\'s authors saw this cap a central bank switch however much hardware was added.',
          what: 'The service opens a transaction and sends each statement in turn: insert the key, update each balance, insert each entry and the outbox row, commit. Each statement is its own round trip.',
          pros: ['All logic in one language, easy to read and test.', 'Ordinary driver and ORM tooling.', 'Fine at low load, where locks are rarely contended.'],
          cons: ['Ten to twenty round trips while locks are held.', 'Ten round trips of 0.5 ms hold a row for 5 ms: about 200 writes a second on it, at most.', "TigerBeetle's authors saw this cap a central bank switch however much hardware was added."],
        },
        {
          name: 'A ledger library inside each service', good: 'No extra hop.', cost: 'Every team re-implements the rules, and one bad deploy anywhere can unbalance the books.',
          what: 'Each service that moves money links a shared ledger library and writes to the ledger database itself. There is no Ledger API in between.',
          pros: ['No extra network hop.', 'One fewer service to run and scale.'],
          cons: ['Every team runs its own copy of the rules, at its own version.', 'One bad deploy anywhere can unbalance the books.', 'Every such service needs write access to every shard, and the shard directory.'],
        },
      ],
      say: 'The ledger API refuses anything that does not balance, and sends each transaction to the database as one call so that locks never wait on the network.',
      see: [{ id: 'partitioning', label: 'Partitioning' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'db',
      name: 'Ledger DB',
      tech: 'Postgres primary',
      x: 795, y: 200, w: 190, h: 118, kind: 'node',
      lines: ['entries: append-only', 'balances: 1 row each', 'idempotency, outbox'],
      what: 'The source of truth. Entries are only ever inserted. Each transaction is two or more entries that sum to zero. Each account has one balance row holding posted and pending totals and a version number, updated in the same transaction as the entries. The idempotency key and an outbox row are written in that transaction too.',
      why: 'Writing the entries, the balance, the key and the event in one local transaction is what makes the balance strictly consistent: a reader never sees entries without their balance change, and a retry never posts twice.',
      numbers: [
        { text: 'Assume about 250 bytes an entry with indexes: 65 GB a day across all shards at 1,000 transactions a second.', from: "1,000 transactions a second × about 3 entries each (two legs and a fee, from the 'Numbers to have ready' table) = 3,000 entries a second. × 86,400 seconds = about 260 million entries a day. × 250 bytes = about 65 GB a day. 250 bytes is an assumption for a narrow row (ids, amount, currency, status, times) plus its indexes." },
        { text: 'Assume 13 months kept hot: about 26 TB in all, about 1.6 TB a shard.', from: '65 GB a day × about 395 days (13 months) = about 26 TB. ÷ 16 shards = about 1.6 TB a shard. 13 months is the page\'s own assumption, from the \'Numbers to have ready\' table (statements, claims windows).' },
        { text: 'No database role may UPDATE or DELETE entries: the ledger\'s role is granted INSERT only, and every correction records who approved it.', from: 'A design rule, not a measurement. Corrections are new transactions through the Ledger API, so the role that posts never needs UPDATE or DELETE on the entries table.' },
      ],
      fails: 'The primary dies. A synchronous standby already holds every committed transaction, so it is promoted with nothing lost. Writes to that shard pause for the failover, and clients retry with the same keys.',
      alternatives: [
        {
          name: 'Conditional update of the balance row in the same transaction', chosen: true, good: 'UPDATE ... SET pending = pending + x WHERE id = a AND available >= x. One statement both checks and reserves. Under Read Committed, Postgres waits for a concurrent writer, then re-checks the condition against the new row, so two payments cannot both pass.', cost: 'The row is locked until commit. Fine for a customer account, a bottleneck for an account every transaction touches.',
          what: "One statement checks and reserves: add 120020 to pending on Bright Bakery's balance row WHERE available >= 120020. If no row matches, the money is not there. It runs inside the stored function, in ascending account order, with the entries.",
          pros: ['Check and reserve are one statement, so no writer can slip between them.', 'Under Read Committed, Postgres waits for a concurrent writer, then re-checks the condition, so two payments cannot both pass.', 'A waiting writer goes next; it does not fail and retry.', 'Plain Postgres that the team already knows.'],
          cons: ["The row stays locked until commit, including the synchronous standby's confirmation.", 'Fine for a customer account; a queue for an account every transaction touches, estimated at 500 to 1,000 writes a second.', 'Hot accounts need the sweeper and its sub-accounts.'],
        },
        {
          name: 'SELECT ... FOR UPDATE, then check, then write', good: 'Explicit and easy to reason about. Lock accounts in ascending id order to avoid deadlocks.', cost: 'Same lock as the conditional update, held for longer, and more round trips if driven from the application.',
          what: 'Read the balance rows with SELECT ... FOR UPDATE, check the amounts, then write. Accounts are locked in ascending id order so two opposite transfers cannot deadlock.',
          pros: ['Explicit and easy to reason about.', 'The check can be any logic, not only what fits in a WHERE clause.', 'Same correctness as the conditional update.'],
          cons: ['Same lock as the conditional update, held for longer.', 'More round trips if driven from the application, each one while holding the lock.', 'One code path that forgets the lock order brings deadlocks back.'],
        },
        {
          name: 'Optimistic: a version column on the balance row', good: 'Readers never block. A write says "only if the version is still 41" and fails if it moved. Modern Treasury exposes this as lock_version.', cost: 'Under contention most attempts fail and retry, so it is worst exactly where load is highest.',
          what: 'Read the balance row and its version, say 41, without locking. Write only if the version is still 41; if it moved, read again and retry. Modern Treasury exposes this as lock_version.',
          pros: ['Readers never block.', 'No lock held between the read and the write.', 'Lets an API client say "only if nothing changed since I looked", which this design offers on top.'],
          cons: ['Under contention most attempts fail and retry.', 'Worst exactly where load is highest: the hot accounts at peak.', 'Retry loops eat into the 50 ms target.'],
        },
        {
          name: 'Serializable isolation', good: 'The database finds every anomaly for you.', cost: 'Transactions abort with serialization failures (40001) and must be retried. Retry storms on busy accounts.',
          what: 'Run every ledger transaction at Serializable isolation and let Postgres abort any that could not have happened in some one-at-a-time order. The read, check and write can then be written plainly.',
          pros: ['The database finds every anomaly for you.', 'Simple code: read, check, write.', 'Also guards rules nobody thought to write a condition for.'],
          cons: ['Transactions abort with serialization failures (40001) and must be retried.', 'Retry storms on busy accounts.', 'Postgres must track what each transaction read, which costs memory and CPU.'],
        },
        {
          name: 'Single writer per account (actor or queue partition)', good: 'No locks at all: one thread owns each account and applies its writes in order.', cost: 'A transfer touches two accounts with two owners, so it becomes a two-step protocol.',
          what: 'Every write for an account goes to the one thread or queue partition that owns it, which applies them in order. No two writers ever meet on a row.',
          pros: ['No locks at all.', 'An account is limited by one thread\'s speed, not by lock waits.', 'The order of writes per account is explicit.'],
          cons: ['A transfer touches two accounts with two owners, so it becomes a two-step protocol.', "The payment's three entries no longer commit in one transaction.", 'A slow or failed owner stalls every write to its accounts until it is replaced.'],
        },
        {
          name: 'TigerBeetle', good: 'Double-entry and balance limits are built in. Batches of up to 8,190 transfers run on one thread in one round trip, replicated by consensus.', cost: 'A specialised database with its own operations. Account metadata still lives in a general database beside it.',
          what: 'A database built for double-entry: it stores accounts and transfers, with balance limits and pending transfers built in. Batches of up to 8,190 transfers run on one thread in one round trip, replicated by consensus.',
          pros: ['Double-entry, balance limits and two-phase transfers built in.', 'No row locks, so hot accounts stop being a special case.', 'Consensus replication is paid once per batch, not per transfer.'],
          cons: ['A specialised database with its own operations to learn.', 'Account metadata still lives in a general database beside it.', 'At 10,000 a second sharded Postgres copes, so this design keeps it for when hot accounts dominate.'],
        },
      ],
      say: 'The balance row is a cache of the entries, updated in the same transaction. The check and the reserve are one conditional UPDATE, so there is no gap between reading the balance and spending it.',
      see: [
        { id: 'two-phase-locking', label: 'Two-phase locking' },
        { id: 'mvcc', label: 'MVCC' },
        { id: 'b-plus-tree', label: 'B+ tree' },
        { id: 'append-log', label: 'Append-only log' },
      ],
    },
    {
      id: 'replicas',
      name: 'Replicas',
      tech: '2 sync, plus read',
      x: 795, y: 365, w: 190, h: 70, kind: 'store',
      what: 'Two standbys in other availability zones receive the write-ahead log as each transaction commits; the primary waits for at least one of them to confirm. Further asynchronous replicas serve statements, history and exports.',
      why: 'A ledger cannot lose an acknowledged payment. Synchronous replication means a commit is on two machines before the customer is told, so losing the primary loses nothing (a recovery point of zero).',
      numbers: [
        { text: 'Postgres: synchronous_standby_names = ANY 1 (s1, s2), a quorum of one in two.', from: 'Not a sum. The setting is from the PostgreSQL replication docs, cited on the page: ANY 1 (s1, s2) waits for at least one of the two listed standbys.' },
        { text: 'Read replicas lag by milliseconds to seconds: fine for a statement, never for a balance check.', from: 'An assumption, not a measurement: asynchronous replicas usually trail by milliseconds and fall seconds behind under heavy writes or long queries. The rule that balance checks read the primary does not depend on the exact figure.' },
      ],
      fails: 'If both synchronous standbys are lost, commits wait. Decide in advance: stop writes on that shard (our choice) rather than quietly fall back to asynchronous replication and risk losing payments.',
      alternatives: [
        {
          name: 'Synchronous quorum standbys plus async read replicas', chosen: true, good: 'No loss on failover, and reads that tolerate lag are taken off the primary.', cost: 'Every commit waits for a round trip to another zone: assume about a millisecond more.',
          what: "Each shard's primary streams its log to two standbys in other zones and waits for either one to confirm before the commit returns. Further asynchronous replicas serve statements, history and exports.",
          pros: ['No acknowledged payment lost on failover: recovery point zero.', 'A quorum of one in two, so losing one standby does not stop writes.', 'Statements and exports are read off the primary.', 'Stock Postgres, no new database.'],
          cons: ['Every commit waits for a round trip to another zone: assume about a millisecond more.', "That millisecond is also added to every hot row's lock time.", 'If both standbys are lost, commits wait; this design stops writes on that shard.', 'Promotion needs a failover tool beside Postgres.'],
        },
        {
          name: 'Consensus replication (Raft, Viewstamped Replication)', good: 'Failover is part of the protocol, not an operator\'s job. TigerBeetle and distributed SQL databases work this way.', cost: 'Three or more voters, and a database built around it.',
          what: 'Three or more replicas agree on each log record, and elect a new leader themselves when one dies. TigerBeetle uses Viewstamped Replication; distributed SQL databases use protocols of this kind.',
          pros: ["Failover is part of the protocol, not an operator's or a tool's job.", 'A wrong promotion cannot leave two primaries taking writes.', 'The same recovery point of zero.'],
          cons: ['Three or more voters per shard.', 'A database built around it, so not stock Postgres.', 'A commit still waits for a majority, so the cross-zone round trip stays.'],
        },
        {
          name: 'Asynchronous replication only', good: 'Lowest latency.', cost: 'A failover can lose the last few seconds of payments. Not acceptable for a ledger.',
          what: "The primary commits on its own disk and streams the log afterwards. Standbys trail a little, and a failover promotes whichever is furthest ahead.",
          pros: ['Lowest commit latency: no cross-zone wait.', 'A slow standby never slows payments.', 'Simplest to run.'],
          cons: ['A failover can lose the last few seconds of payments.', 'Those payments were acknowledged to customers, which is the one thing a ledger must not lose.', 'Not acceptable here.'],
        },
      ],
      say: 'Recovery point zero: a payment is acknowledged only once it is on two machines in two zones. Reads that can be a little stale go to replicas; balance checks never do.',
      see: [{ id: 'leader-replication', label: 'Leader replication' }, { id: 'quorum', label: 'Quorum' }, { id: 'raft', label: 'Raft' }],
    },
    {
      id: 'sweeper',
      name: 'Sweeper',
      tech: 'hot accounts',
      x: 1042, y: 190, w: 124, h: 56, kind: 'node',
      what: 'Looks after accounts that almost every transaction touches, such as fee income or the Faster Payments settlement account. Each is split into 32 sub-accounts. A write picks one by hashing the transaction id. Every minute the sweeper moves each sub-account\'s total into the main account with an ordinary balanced transaction.',
      why: 'A single balance row can take only one writer at a time. With the lock held until a synchronously replicated commit, my estimate is roughly 500 to 1,000 writes a second. At a peak of 10,000 transactions a second the fee account alone would queue every payment behind it.',
      numbers: [
        { text: '32 sub-accounts at 10,000 a second is about 300 writes a second each.', from: "10,000 transactions a second at peak (the 'Numbers to have ready' table) ÷ 32 sub-accounts = about 310 writes a second each, rounded to 300. That is well under the 500 to 1,000 a second estimated for one row. 32 is a chosen power of two; the drill raises it to 64." },
        { text: 'The main account\'s balance is at most one sweep interval behind; the sum of main plus sub-accounts is always exact.', from: 'The sweep runs every minute, so the main account misses at most about a minute of credits. The sum is exact because every entry is written synchronously, in its own transaction, to one of the 32 sub-accounts.' },
      ],
      fails: 'If the sweeper stops, nothing is wrong, only untidy: balances sit in sub-accounts. Reports read the main account plus its sub-accounts, so they stay right.',
      alternatives: [
        {
          name: 'Sub-accounts with periodic sweeps', chosen: true, good: 'Spreads the writes, keeps every entry synchronous and every balance exact.', cost: 'Reports must sum sub-accounts, and the split count is a tuning knob.',
          what: "Fee income and the settlement account are each split into 32 sub-accounts. A write picks one by hashing the transaction id, as the tour's 20p went to sub 17. Every minute a balanced transaction moves each sub-account's total into the main account.",
          pros: ['Spreads 10,000 writes a second to about 300 a second per row.', 'Every entry stays synchronous and every balance exact as a sum.', 'Ordinary ledger transactions: no new system.', 'Going from 32 to 64 sub-accounts changes nothing else.'],
          cons: ['Reports must sum the main account and its sub-accounts.', 'The split count is a tuning knob to watch.', 'A limit on a split account applies to the sum, which no single row can check.'],
        },
        {
          name: 'No balance check on house accounts, balance computed later', good: 'Fee income only ever receives credits, so it cannot breach a limit. Append the entry and let a job roll up the balance. Modern Treasury routes hot accounts down an asynchronous path this way.', cost: 'Its balance lags (Modern Treasury applies such entries within 60 seconds). Only safe for accounts with no limit to enforce.',
          what: 'Fee income only ever receives credits, so it cannot go below a limit. Its entries are appended with no balance row update, and a job rolls the balance up later. Modern Treasury routes hot accounts down an asynchronous path like this.',
          pros: ['No hot row at all: appends never wait on each other.', 'Simpler than sub-accounts for credit-only accounts.', 'Used in production by Modern Treasury.'],
          cons: ['Its balance lags; Modern Treasury applies such entries within 60 seconds.', 'Only safe for accounts with no limit to enforce.', 'Any hot account that can be debited still needs another answer.'],
        },
        {
          name: 'Batch postings: one aggregated entry per second', good: 'One write per batch on the hot row.', cost: 'The per-payment entries live elsewhere until the batch posts, so the ledger is briefly incomplete.',
          what: 'Each payment\'s share for a hot account is collected for a second, then one aggregated entry per hot account is posted for the batch. The hot row takes one write a second instead of thousands.',
          pros: ['One write per batch on the hot row.', 'Fewer, larger entries on the house account.', 'Uses the same ledger and tables.'],
          cons: ['The per-payment entries live elsewhere until the batch posts, so the ledger is briefly incomplete.', "A payment's fee is no longer in the same transaction as the payment.", 'A failed batch must be found and posted again as a whole.'],
        },
        {
          name: 'A database built for it (TigerBeetle)', good: 'Applies thousands of transfers to one account per batch on a single thread with no row locks.', cost: 'A new database to adopt and run.',
          what: 'Move the posting engine to a database that applies thousands of transfers to one account in one batch on a single thread. There are no row locks, so a hot account is just an account.',
          pros: ['Thousands of transfers to one account per batch, with no row locks.', 'Balance limits are still enforced on the hot account.', 'No sub-accounts or sweeps for reports to know about.'],
          cons: ['A new database to adopt and run.', 'Account metadata stays in Postgres beside it.', 'A big move to fix two hot accounts; this design waits until hot accounts dominate.'],
        },
      ],
      say: 'Hot accounts are the classic trap. A balance row is a lock, so I split the account into sub-accounts and sweep, or skip the check entirely on accounts that only receive credits.',
      see: [{ id: 'consistent-hashing', label: 'Consistent hash ring' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'relay',
      name: 'CDC relay',
      tech: 'Debezium',
      x: 1042, y: 350, w: 124, h: 56, kind: 'node',
      what: 'Reads committed outbox rows from the database\'s write-ahead log through a replication slot, and publishes each as an event on the ledger-events topic, keyed by account.',
      why: 'Writing to the database and then to Kafka is two writes with no transaction around them: a crash between them loses an event or announces a payment that rolled back. The outbox row commits with the entries, and the relay publishes only what committed, in commit order.',
      numbers: [
        { text: 'About 1,000 events a second on average; assume about 1 KB each: about 1 MB a second.', from: "One event per committed transaction: 1,000 a second on average (the 'Numbers to have ready' table) × an assumed 1 KB an event (ids, accounts, amounts, status and log position, as JSON) = about 1 MB a second. At the 10,000 a second peak, about 10 MB a second." },
      ],
      fails: 'If the relay or Kafka is down, the ledger carries on and events wait in the log. Watch the replication slot: it holds write-ahead log on the primary\'s disk until the relay catches up.',
      alternatives: [
        {
          name: 'Outbox table read by log-based CDC', chosen: true, good: 'Atomic with the entries, in commit order, no polling load.', cost: 'A connector to run, and a replication slot to watch.',
          what: 'The stored function writes an outbox row in the same transaction as the entries. Debezium reads committed rows from the write-ahead log through a replication slot and publishes them to ledger-events in commit order.',
          pros: ['The event exists if and only if the payment committed.', 'In commit order, straight from the log.', 'No polling queries on the primary.', 'If Kafka is down, the ledger carries on and events wait.'],
          cons: ['A connector to run and upgrade.', "The slot holds log on the primary's disk until read, so a stuck relay can fill the disk.", 'At least once: a restart can repeat events, so consumers drop repeats.', 'Published outbox rows need clearing out.'],
        },
        {
          name: 'Polling the outbox table', good: 'Simple: a worker selects new rows and marks them sent.', cost: 'Concurrent commits can be missed or reordered, and polling adds load.',
          what: 'A worker selects outbox rows not yet sent, publishes them, and marks them sent. No connector and no replication slot.',
          pros: ['Simple: a query and an update.', 'Works on any database, with no access to its log.', 'What is waiting is easy to see: it is a column.'],
          cons: ['Concurrent commits can be missed or reordered: a row given an earlier id can commit later.', 'Polling adds load to the primary that also takes payments.', 'Marking rows sent is another write per event.'],
        },
        {
          name: 'Logical decoding messages, no table (pg_logical_emit_message)', good: 'Nothing to clean up: the message lives only in the log.', cost: 'Postgres-specific.',
          what: 'The stored function calls pg_logical_emit_message inside the transaction instead of inserting a row. The message is written only to the log, and the relay reads it through the same slot.',
          pros: ['Nothing to clean up: the message lives only in the log.', 'The same atomicity and commit order as the outbox row.', 'No table growing on the primary.'],
          cons: ['Postgres-specific.', 'No table to query when you need to check what was emitted.', 'Less familiar than an outbox table, so it needs explaining to every new reader.'],
        },
        {
          name: 'Publish to Kafka after commit (dual write)', good: 'No extra parts.', cost: 'Lost or phantom events on every crash. Never on a money path.',
          what: 'The service commits to Postgres and then publishes to Kafka itself. No outbox and no connector.',
          pros: ['No extra parts.', 'The shortest delay from commit to event.', 'Easy to understand.'],
          cons: ['A crash between the two writes loses the event.', 'Publishing before the commit announces payments that rolled back.', 'Never on a money path.'],
        },
      ],
      say: 'Never dual-write. The event is a row in the same transaction as the money, and change data capture carries it out.',
      see: [{ id: 'append-log', label: 'Append-only log' }],
    },
    {
      id: 'kafka',
      name: 'ledger-events',
      tech: 'Kafka, by account',
      x: 1195, y: 475, w: 150, h: 64, kind: 'queue',
      what: 'One event per committed ledger transaction: ids, accounts, amounts, status and the database log position. Keyed by account so each account\'s events stay in order.',
      why: 'Notifications, fraud, analytics, statements search and reconciliation all need to know what happened. A log lets each read at its own pace and replay, without querying the ledger.',
      fails: 'Delivery is at least once. A relay restart can publish an event twice, so consumers drop anything at or below the last log position they processed for that account.',
      alternatives: [
        {
          name: 'Kafka topic keyed by account', chosen: true, good: 'Ordered per account, replayable, many readers.', cost: 'Partitions and consumer lag to watch.',
          what: "One topic, ledger-events, keyed by account, so each account's events land in one partition and keep their order. Notifications, fraud, the warehouse and reconciliation each read it as their own consumer group.",
          pros: ['Ordered per account.', 'Replayable: a consumer that falls a day behind catches up from the log.', 'Many readers, each at its own pace.', 'About 1 MB a second on average is a light load for Kafka.'],
          cons: ['Partitions and consumer lag to watch.', 'At least once: consumers must drop repeats by log position.', 'A Kafka cluster to run, or to pay someone to run.'],
        },
        {
          name: 'A managed queue (SQS)', good: 'Nothing to run.', cost: 'Each message is read once and gone. No replay, and ordering only with FIFO queues.',
          what: 'Each event goes to a managed queue. A consumer takes a message, handles it and deletes it.',
          pros: ['Nothing to run.', 'No partitions to plan.', 'With FIFO queues, order can be kept per account.'],
          cons: ['Each message is read once and gone: no replay after a consumer bug.', 'Several readers need a queue each, fed by a fan-out.', 'Ordering only with FIFO queues.'],
        },
        {
          name: 'Consumers read the replicas', good: 'No log at all.', cost: 'The ledger\'s schema becomes everyone\'s interface, and their queries compete with statements.',
          what: 'No log at all. Each downstream service queries an asynchronous replica for what changed since it last looked.',
          pros: ['No log to run.', 'Consumers see the full record, not only what an event carries.', 'Nothing to keep in step: the data is the record itself.'],
          cons: ["The ledger's schema becomes everyone's interface, so it can no longer change freely.", 'Their queries compete with statements on the replicas.', 'Every consumer polls, so a notification waits for the next poll.'],
        },
      ],
      say: 'The topic is how the ledger tells the rest of the bank. It is never how money moves.',
      see: [{ id: 'append-log', label: 'Append-only log' }, { id: 'queue', label: 'Queue' }],
    },
    {
      id: 'consumers',
      name: 'Consumers',
      tech: 'notify, fraud, BI',
      x: 900, y: 475, w: 150, h: 64, kind: 'shared',
      what: 'The services that react to money moving: push notifications, fraud models, accounting exports, the data warehouse.',
      why: 'They must never slow a payment down. They read events at their own pace, and a slow one builds lag, not latency.',
      fails: 'A consumer falls a day behind: it catches up from the log. A consumer processes an event twice: it checks the log position it last applied.',
      alternatives: [
        {
          name: 'Read events from the topic', chosen: true, good: 'Decoupled and replayable.', cost: 'Eventually consistent: a notification can arrive a moment after the balance changes.',
          what: 'Each service reads ledger-events as its own consumer group: notifications within seconds, the warehouse in batches. Each keeps the last log position it applied per account and skips anything older.',
          pros: ['Decoupled: a slow consumer builds lag, not payment latency.', 'Replayable after a bug or an outage.', 'A new consumer needs no change to the ledger.'],
          cons: ['Eventually consistent: a notification can arrive a moment after the balance changes.', 'Every consumer must handle repeats.', 'Lag per consumer group to watch and alert on.'],
        },
        {
          name: 'Call each one from the ledger', good: 'Immediate.', cost: 'The ledger waits on every downstream service and fails when any of them does.',
          what: 'After each commit, the ledger calls the notification service, fraud and the rest directly.',
          pros: ['Immediate.', 'No log to run.', 'The ledger knows at once whether each one got it.'],
          cons: ['The ledger waits on every downstream service.', 'It fails, or must queue, when any of them does.', 'A call after the commit is a dual write: a crash in between drops it.'],
        },
        {
          name: 'Each consumer reads the change stream itself', good: 'No Kafka: each service gets committed changes straight from the log.', cost: 'A replication slot per consumer, each holding log on the primary until read.',
          what: 'Each downstream service runs its own change data capture on the ledger database, through its own replication slot. There is no shared topic.',
          pros: ['No Kafka cluster.', 'Each consumer sees changes in commit order.', 'Nothing sits between the database and the reader.'],
          cons: ["A replication slot per consumer, each holding log on the primary's disk until read.", "One stuck consumer can fill a shard's disk and stop payments.", "Every consumer is tied to the ledger's tables."],
        },
      ],
      say: 'Downstream is eventually consistent by design. Only the ledger itself is strict.',
    },
    {
      id: 'recon',
      name: 'Reconciliation',
      tech: 'checks, breaks',
      x: 1200, y: 200, w: 150, h: 64, kind: 'shared',
      what: 'Proves the ledger is right in two ways. Inside: every transaction sums to zero, all entries in each currency sum to zero, and each balance row equals the sum of its entries. Outside: the ledger\'s view of each settlement and safeguarding account matches the bank statement and the scheme\'s settlement report, every day.',
      why: 'Locks stop races. They do not stop a bug that posts the wrong amount, a missing scheme message, or a bank error. Only comparing against independent truth catches those. For payment and e-money firms, the FCA\'s CASS 15 rules ask for this every business day.',
      numbers: [
        { text: 'Monzo\'s example: two £5 payments in the ledger, £15 arrived in settlement, a £5 break.', from: "Monzo's worked example from 'Processing payments safely at scale', cited on the page: £5 + £5 = £10 in the ledger; £15 in settlement less £10 = £5 that nothing explains." },
        { text: 'Stripe reports more than 99.9999 per cent of money movement explained, with clearing accounts expected to sit at zero.', from: "Not a sum. Stripe's own figure, from its ledger post cited on the page; it has not been checked here." },
      ],
      fails: 'A break is found. It is raised with an owner, an amount and evidence. The fix is a new correcting transaction through the ledger API, reviewed by a second person, never an edit to an entry.',
      alternatives: [
        {
          name: 'Continuous invariant checks plus daily external reconciliation', chosen: true, good: 'Internal checks catch bugs in minutes; external ones catch what the ledger never saw.', cost: 'A team that owns breaks and works them down.',
          what: "Every few minutes, queries check that each transaction and each currency sums to zero and each balance row equals its entries. Every business day, the ledger's totals for each settlement and safeguarding account are matched against the bank and scheme files.",
          pros: ['Internal checks catch bugs in minutes.', 'External checks catch what the ledger never saw: a missing scheme message, a bank error.', "Meets CASS 15's daily reconciliation for payment and e-money firms.", 'Breaks are fixed by correcting entries, so the history shows both mistake and fix.'],
          cons: ['A team that owns breaks and works them down.', 'With about 1.6 TB a shard, the checks must work from snapshots and recent entries, not re-sum everything.', 'A day of delay before an outside error is seen.'],
        },
        {
          name: 'Clearing accounts that should net to zero', good: 'One query finds anything stuck: money that left one system and never arrived in the next. Stripe\'s Ledger is built around this.', cost: 'Needs fund flows modelled carefully up front.',
          what: "Every hop money makes between systems passes through a clearing account that should return to zero once the hop completes. Anything stuck shows as a balance left behind. Stripe's Ledger is built around this.",
          pros: ['One query finds anything stuck: money that left one system and never arrived in the next.', 'Works across many systems, not only the ledger and the bank.', "Already in this design: cross-shard sagas go through a clearing account."],
          cons: ['Needs fund flows modelled carefully up front.', 'Finds stuck money, not a wrong amount posted the same way on both sides.', 'A clearing account is not zero while money is in flight, so it needs an age threshold.'],
        },
        {
          name: 'Month-end reconciliation only', good: 'Cheap.', cost: 'A month of errors to unpick, and below what safeguarding rules expect.',
          what: 'Finance matches the ledger to the bank statements once a month, as part of closing the books.',
          pros: ['Cheap: one exercise a month.', 'Fits the monthly close that finance already runs.'],
          cons: ['A month of errors to unpick.', 'Below what safeguarding rules expect: CASS 15 asks for every business day.', 'A customer can spend money a bug wrongly gave them before anyone sees it.'],
        },
      ],
      say: 'Correctness is proved, not assumed. Internally the books must balance every minute; externally they must match the bank every day, and a break is worked with evidence and a correcting entry.',
    },
    {
      id: 'files',
      name: 'Bank and scheme files',
      short: 'Statements',
      tech: 'bank, schemes',
      x: 1200, y: 34, w: 150, h: 56, kind: 'outside',
      what: 'The independent truth: statements from the bank that holds the settlement and safeguarding accounts, and settlement reports from Faster Payments, Bacs and the card schemes.',
      why: 'They are produced by someone else\'s systems, so they disagree with yours exactly when yours are wrong.',
      fails: 'A file arrives late or not at all. Reconciliation for that account waits and alerts; it never assumes a missing file means nothing happened.',
      alternatives: [
        {
          name: 'Daily statements and settlement files', chosen: true, good: 'Standard, complete, and what auditors expect.', cost: 'A day of delay before an outside error is seen.',
          what: 'Every day, the bank statement for each settlement and safeguarding account, and the settlement reports from Faster Payments, Bacs and the card schemes, arrive as files. Each is checksummed and loaded once.',
          pros: ['Standard and complete.', 'What auditors expect.', 'Every bank and scheme can provide them.'],
          cons: ['A day of delay before an outside error is seen.', 'Formats differ by bank and scheme, so each needs its own parser.', "A late file holds up that account's reconciliation."],
        },
        {
          name: 'Intraday statement feeds by API', good: 'Breaks found within the hour.', cost: 'Not every bank or scheme offers them.',
          what: 'The bank serves statement lines through an API during the day, and reconciliation matches them as they arrive.',
          pros: ['Breaks found within the hour.', 'Problems fixed the same day, often before a customer notices.', 'Less work piled up for the next morning.'],
          cons: ['Not every bank or scheme offers them.', 'Another integration to build per bank.', 'The daily file is still worth keeping as the final word for the day.'],
        },
        {
          name: 'No outside files: trust the ledger and the scheme replies', good: 'Nothing to load or parse.', cost: 'Misses exactly the errors outside records catch, and safeguarding rules expect daily reconciliation.',
          what: "Treat the scheme's accept and reject messages, already recorded by the Banking API, as proof, and check only inside the ledger.",
          pros: ['Nothing to load, parse or chase.', 'The internal invariant checks still catch unbalanced books.'],
          cons: ['A lost scheme message or a bank error is never seen.', 'Your own systems agree with each other even when they are all wrong.', 'Below what CASS 15 expects for safeguarded funds.'],
        },
      ],
      say: 'Reconcile against something you did not write.',
    },
    {
      id: 'archive',
      name: 'Archive',
      tech: 'object store',
      x: 550, y: 475, w: 130, h: 70, kind: 'store',
      what: 'Monthly partitions of entries older than 13 months, exported from a replica as Parquet files, with a checksum per file. The balance rows and a balance snapshot at each month end stay in the database.',
      why: 'Entries are never deleted, so the table only grows. Partitioning entries by month lets an old month be exported and detached in one step, without a slow delete.',
      fails: 'An export is incomplete. The partition is detached only after the file\'s row count and sums match the partition\'s, which are recorded with the export.',
      alternatives: [
        {
          name: 'Partition by month, export and detach', chosen: true, good: 'Cheap storage, and dropping a partition is instant.', cost: 'Old statements are read from files, more slowly.',
          what: 'Entries are partitioned by month. Each month the partition that passes 13 months old is exported from a replica to Parquet with its row count and sums, checked, then detached on the primary. Balance rows and month-end snapshots stay.',
          pros: ['Detaching a partition is a metadata change, not a slow delete.', 'Keeps each shard near 1.6 TB instead of growing for ever.', 'Parquet in an object store is cheap to keep for years.', 'Recorded counts and sums prove each file is complete.'],
          cons: ['Old statements are read from files, more slowly.', 'A second read path to build and test for statements older than 13 months.', 'Partitioning must be there from day one; adding it later means moving a big table.'],
        },
        {
          name: 'Keep everything in the database', good: 'One place to query.', cost: 'Indexes and backups grow for ever, and restores get slower each year.',
          what: 'Entries stay in the shard databases for ever. A statement of any age is the same query.',
          pros: ['One place to query.', 'No export job to build.', 'Old statements are as fast as new ones.'],
          cons: ['Indexes and backups grow for ever: about 24 TB a year across all shards.', 'Restores get slower each year, which stretches recovery after a disaster.', 'Every schema change and backfill touches more data.'],
        },
        {
          name: 'A separate history database', good: 'Old months stay queryable with SQL, off the payment shards.', cost: 'Another cluster to run and back up, and it still grows for ever.',
          what: 'Partitions older than 13 months move to a cheaper Postgres cluster kept only for history. Old statements query it with the same SQL.',
          pros: ['The same SQL and tooling for old and new statements.', 'The payment shards stay small.', 'Faster to query than files.'],
          cons: ['Another cluster to run, back up and patch.', 'It still grows by about 24 TB a year.', 'Moving rows between databases needs the same count and sum checks as an export.'],
        },
      ],
      say: 'Partition entries by time from day one. It makes statements fast and archiving a metadata operation.',
      see: [{ id: 'column-store', label: 'Column store (Parquet)' }, { id: 'partitioning', label: 'Partitioning' }],
    },
  ],

  flows: [
    {
      id: 'pay', from: 'client', to: 'api', d: 'M122,200 H230', label: 'pay £1,200',
      mode: 'external', via: 'HTTPS', chip: 0.5,
      how: 'POST /payments with an Idempotency-Key header, the payee, the amount in pence and the currency. Balance and statement reads use the same connection.',
      delivery: 'The client retries on a timeout with the same key. The server returns the saved result for that key, never a second payment.',
      alts: ['A mobile push channel for the result, so the app need not poll.', 'Webhooks to API clients when the payment settles.'],
      ways: [
        { name: 'HTTPS', chosen: true, what: 'The app sends POST /payments with an Idempotency-Key header, the payee, the amount in pence and the currency. The reply is the payment\'s id and state; on a timeout the app sends the same request with the same key.', pros: ['Works from phones, browsers and partners\' servers alike.', 'A retry with the same key returns the same payment.', 'Easy to log, rate-limit and authenticate at the edge.'], cons: ['The app must ask again to learn when a pending payment completes.', 'A timeout leaves the result unknown until the retry.'] },
        { name: 'A mobile push channel for the result', what: 'The payment is still sent over HTTPS, but the final result arrives as a push notification instead of the app asking again.', pros: ['No polling while the scheme decides.', 'The user hears the result even with the app closed.'], cons: ['Push delivery is not guaranteed, so the app still asks when it opens.', 'Another channel to build and secure, and it does not replace the request.'] },
        { name: 'Webhooks to API clients', what: 'A partner\'s server registers a URL, and the bank calls it when a payment settles or fails. The payment itself still starts with an HTTPS request.', pros: ['Partners need not poll for thousands of payments.', 'A common pattern for payment APIs.'], cons: ['The partner\'s endpoint can be down, so webhooks need retries and signatures.', 'At least once: partners must handle repeats.'] },
      ],
      reply: {
        id: 'accepted', label: 'payment status',
        how: 'The payment\'s id and state: pending while the scheme decides, then completed or failed.',
        delivery: 'Safe to ask again: the same key always returns the same payment.',
      },
      examples: [
        {
          title: 'Request',
          lang: 'http',
          code: `POST /payments HTTP/1.1
Host: api.bank.example
Authorization: Bearer <access token, after SCA>
Idempotency-Key: k7
Content-Type: application/json

{
  "from_account": "81442",
  "payee": {
    "name": "Mill Lane Flour Ltd",
    "sort_code": "12-34-56",
    "account_number": "12345678"
  },
  "amount": 120000,
  "currency": "GBP",
  "reference": "INV 3318"
}`,
          note: 'k7 stands for a version 4 UUID made once, when the payment was drafted; every retry sends the same one.',
        },
        {
          title: 'Response',
          lang: 'http',
          code: `HTTP/1.1 201 Created
Content-Type: application/json

{
  "id": "pay_3fK9",
  "status": "pending",
  "amount": 120000,
  "fee": 20,
  "currency": "GBP"
}

The retry with Idempotency-Key: k7 gets this same status line
and body, read from the saved result. No second payment.

GET /payments/pay_3fK9   ->   200 OK
{ "id": "pay_3fK9", "status": "completed" }`,
          note: 'The amount is in pence: 120000 is £1,200. The fee of 20p is why the ledger holds 120020.',
        },
      ],
    },
    {
      id: 'send', from: 'api', to: 'fps', d: 'M310,172 V62', label: 'payment',
      mode: 'external', via: 'scheme', chip: 0.5,
      how: 'The payment message goes to Faster Payments, directly or through a sponsor bank, with a payment identifier that stays the same on every resend.',
      delivery: 'No promise from the other side. A timeout means unknown, not failed: ask for the status before giving the money back.',
      alts: ['Bacs for bulk payroll files, three working days.', 'CHAPS for high-value same-day payments.'],
      ways: [
        { name: 'Faster Payments (scheme)', chosen: true, what: 'The payment message goes to Faster Payments, directly or through a sponsor bank, with a payment identifier that stays the same on every resend. It reaches the payee\'s bank in real time, any hour of any day.', pros: ['Real time, 24/7: the supplier has the money in seconds.', 'Up to £1 million at scheme level, far above £1,200.', 'A fixed payment id lets the API ask for status after a timeout.'], cons: ['No promise from the other side: a timeout means unknown, not failed.', 'Each bank sets its own lower limit.', 'Covered by APP scam reimbursement, so fraud checks must come first.'] },
        { name: 'Bacs', what: 'Payments go in a file through Bacs and arrive over three working days. Payroll and bulk supplier runs are its usual use.', pros: ['Built for bulk: one file, thousands of payments.', 'Suits payroll, where the date is known in advance.'], cons: ['Three working days: no good for paying a supplier today.', 'Funds stay reserved for days, so pending entries live longer.'] },
        { name: 'CHAPS', what: 'A sterling same-day payment for high values, settled gross by the Bank of England. Usually open 6am to 6pm on working days.', pros: ['Settled gross in RTGS: final once done.', 'Same day, for amounts where certainty matters most.'], cons: ['Working hours only, so a Sunday payment waits.', 'Meant for high values; more than a £1,200 supplier payment needs.'] },
      ],
      reply: {
        id: 'ack', label: 'accepted',
        how: 'The scheme accepts or rejects the payment, usually within seconds.',
        delivery: 'Recorded in the payment state before the ledger is told, so a crash cannot lose it.',
      },
      examples: [
        {
          title: 'Payment message (the fields that matter here)',
          lang: 'text',
          code: `To Faster Payments, directly or through a sponsor bank.
The scheme's own message format is not shown.

payment id   pay_3fK9        the same on every resend
amount       120000 pence    £1,200.00
currency     GBP
payer        Bright Bakery Ltd, account 81442
payee        Mill Lane Flour Ltd, 12-34-56 12345678
reference    INV 3318

Banking API: payment pay_3fK9 recorded as "sent"
before the message leaves.`,
        },
        {
          title: 'Reply, and what the API does with it',
          lang: 'text',
          code: `accepted   pay_3fK9
  -> recorded on the payment, then PostPending (state: posted)

rejected   pay_3fK9, with a reason
  -> recorded on the payment, then VoidPending (state: voided)

no answer before the timeout
  -> state stays "sent"; the 120020p stays reserved
  -> ask the scheme for the status of pay_3fK9,
     then post or void`,
          note: 'A timeout is not a rejection: the hold stays until the scheme answers for the same payment id.',
        },
      ],
    },
    {
      id: 'post', from: 'api', to: 'ledger', d: 'M390,200 H485', label: 'reserve, post, void',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: 'CreateTransaction with the idempotency key, the entries and their status (pending or posted), or PostPending and VoidPending naming an earlier pending transaction. Reads use GetBalance and ListEntries.',
      delivery: 'Safe to repeat: the key is unique in the ledger, so a repeated call returns the first result.',
      alts: ['REST with an Idempotency-Key header.', 'A command topic, which turns a synchronous "is there enough money?" into an asynchronous one.'],
      ways: [
        { name: 'gRPC', chosen: true, what: 'The Banking API calls CreateTransaction, PostPending or VoidPending on the Ledger API, each with the idempotency key. Reads use GetBalance and ListEntries.', pros: ['A typed contract, with client and server code generated from it.', 'Synchronous: the API learns at once whether the funds were reserved.', 'A deadline on each call, so a slow ledger fails fast.'], cons: ['Harder to call by hand while debugging than REST.', 'Needs load balancers and proxies that handle long-lived HTTP/2 connections.'] },
        { name: 'REST with an Idempotency-Key header', what: 'The same calls as JSON over HTTPS, such as POST /transactions with an Idempotency-Key header. The same key rules apply.', pros: ['Easy to call by hand and read in logs.', 'The same idempotency scheme as the public API.'], cons: ['No generated, typed contract unless one is added.', 'JSON costs a little more to send and parse; unlikely to matter here.'] },
        { name: 'A command topic', what: 'The API writes a command to a topic and the ledger applies it, replying on another topic. Reserve becomes a message, not a call.', pros: ['Bursts queue instead of failing.', 'One consumer per partition gives a single writer per account.'], cons: ['"Is there enough money?" turns asynchronous, but the API must still wait for the answer.', 'Matching replies to requests, and timing them out, is extra code.', 'Kafka joins the money path.'] },
      ],
      reply: {
        id: 'result', label: 'result',
        how: 'The transaction id, its status and the account\'s resulting balances; or "insufficient funds".',
        delivery: 'The same answer for every repeat of the same key.',
      },
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `service Ledger {
  rpc CreateTransaction(CreateTransactionRequest) returns (Result);
  rpc PostPending(PendingRequest) returns (Result);
  rpc VoidPending(PendingRequest) returns (Result);
}
message Entry {
  string account = 1;    // account id, or a house account name
  string direction = 2;  // "debit" or "credit"
  int64 amount = 3;      // pence, always positive
}
message CreateTransactionRequest {
  string idempotency_key = 1;
  string status = 2;           // "PENDING" or "POSTED"
  string currency = 3;         // one currency per transaction
  repeated Entry entries = 4;  // debits must equal credits
  string reference = 5;
}
message PendingRequest {
  string idempotency_key = 1;
  int64 pending_txn_id = 2;    // the reservation to post or void
}
message Result {
  int64 txn_id = 1;
  string status = 2;  // PENDING, POSTED, VOIDED, INSUFFICIENT_FUNDS
  int64 posted = 3; int64 available = 4;  // the payer's, afterwards
}`,
          note: 'GetBalance and ListEntries are left out to keep it short.',
        },
        {
          title: 'Example call: reserve, then the retry',
          lang: 'text',
          code: `CreateTransaction
{ "idempotency_key": "k7", "status": "PENDING",
  "currency": "GBP", "reference": "pay_3fK9",
  "entries": [
    { "account": "81442", "direction": "debit", "amount": 120020 },
    { "account": "fps_settlement", "direction": "credit",
      "amount": 120000 },
    { "account": "fee_income", "direction": "credit", "amount": 20 }
  ] }
-> { "txn_id": 900417, "status": "PENDING",
     "posted": 842000, "available": 721980 }

The app's retry reaches here as the same call with key k7
-> the same reply, read from the saved result`,
          note: 'The Ledger API turns fps_settlement and fee_income into sub-account 17 of each, by hashing transaction id 900417.',
        },
        {
          title: 'Example call: post, and a refusal',
          lang: 'text',
          code: `PostPending
{ "idempotency_key": "k7:post", "pending_txn_id": 900417 }
-> { "txn_id": 900418, "status": "POSTED",
     "posted": 721980, "available": 721980 }

Had available been under 120020, the reserve would reply
-> { "status": "INSUFFICIENT_FUNDS", "available": 61500 }
   and nothing would have been written.

GetBalance { "account": "81442" }
-> { "posted": 721980, "available": 721980 }`,
          note: 'Posting is a new transaction with its own key; it names the reservation instead of editing it.',
        },
      ],
    },
    {
      id: 'txn', from: 'ledger', to: 'db', d: 'M615,200 H700', label: 'one call',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'One call to a stored function: insert the idempotency key, update each balance row with a conditional UPDATE in ascending account order, insert the entries and the outbox row, commit.',
      delivery: 'All or nothing. If the key already exists, the function returns the stored result and writes nothing.',
      alts: ['An interactive transaction of separate statements, holding locks across each round trip.', 'A batch of many transfers per call, as TigerBeetle does, for throughput.'],
      ways: [
        { name: 'SQL: one stored-function call', chosen: true, what: 'The Ledger API calls one stored function on the shard. It inserts the key, updates each balance row conditionally in ascending account order, inserts the entries and the outbox row, and commits.', pros: ['Locks are never held across the network.', 'All or nothing, and a repeated key returns the stored result.', 'One round trip per transaction.'], cons: ['Logic in SQL needs its own review and tests.', 'Changing it is a database deploy.'] },
        { name: 'An interactive transaction of separate statements', what: 'The service sends each statement on its own inside one transaction. Each is a round trip while the locks are held.', pros: ['All logic in application code.', 'Easy to read and step through.'], cons: ['Ten to twenty round trips with locks held.', 'Ten round trips of 0.5 ms hold a hot row for 5 ms: about 200 writes a second on it.'] },
        { name: 'A batch of many transfers per call', what: 'The Ledger API gathers many transfers and sends them in one call, applied in one transaction. TigerBeetle does this with up to 8,190 transfers a batch.', pros: ['One commit and one standby round trip shared by many transfers.', 'Far more writes a second on a hot row.'], cons: ['One bad transfer must not fail the rest, so each needs its own result.', 'Each transfer waits for its batch to fill or a timer to fire.'] },
      ],
      reply: {
        id: 'committed', label: 'committed',
        how: 'The commit returns once the write-ahead log is flushed locally and one synchronous standby confirms it has flushed it too.',
        delivery: 'Durable on two machines when acknowledged.',
      },
      examples: [
        {
          title: 'The one call (reserve, then post)',
          lang: 'sql',
          code: `-- Reserve: the Ledger API's single call for key k7
SELECT * FROM apply_transaction(
  p_key       => 'k7',
  p_txn_id    => 900417,
  p_status    => 'pending',
  p_currency  => 'GBP',
  p_reference => 'pay_3fK9',
  p_entries   => '[
    {"account": 81442, "direction": "debit",  "amount": 120020},
    {"account": 2017,  "direction": "credit", "amount": 120000},
    {"account": 3017,  "direction": "credit", "amount": 20}
  ]'::jsonb);
-- 2017, 3017: sub-account 17 of FPS settlement and of fee
-- income, picked by hashing transaction id 900417

-- Post, once the scheme has accepted
SELECT * FROM post_pending(
  p_key => 'k7:post', p_pending => 900417, p_txn_id => 900418);`,
        },
        {
          title: 'What the function runs, as one transaction',
          lang: 'sql',
          code: `BEGIN;
INSERT INTO idempotency_keys (key, txn_id, created_at)
VALUES ('k7', 900417, now()) ON CONFLICT (key) DO NOTHING;
-- no row inserted: k7 exists; return its saved result, stop

-- balance rows in ascending account id: 2017, 3017, 81442
UPDATE balances SET pending_in = pending_in + 120000,
  version = version + 1 WHERE id = 2017;
UPDATE balances SET pending_in = pending_in + 20,
  version = version + 1 WHERE id = 3017;
UPDATE balances SET pending = pending + 120020,
  version = version + 1
WHERE id = 81442 AND available >= 120020;
-- 0 rows: raise insufficient funds; nothing above is kept

INSERT INTO entries
  (txn_id, account_id, direction, amount, currency, status)
VALUES (900417, 81442, 'debit',  120020, 'GBP', 'pending'),
       (900417,  2017, 'credit', 120000, 'GBP', 'pending'),
       (900417,  3017, 'credit',     20, 'GBP', 'pending');
-- debits must equal credits, or raise
INSERT INTO outbox (txn_id, account_id, payload)
VALUES (900417, 81442, v_event);
UPDATE idempotency_keys SET result = v_result WHERE key = 'k7';
COMMIT;  -- returns once one synchronous standby has it`,
          note: 'The WHERE clause is the check and the UPDATE is the reserve, so no other payment can spend the money in between.',
        },
        {
          title: 'The balance row, and a balance read',
          lang: 'sql',
          code: `CREATE TABLE balances (
  id         bigint PRIMARY KEY,           -- account id
  posted     bigint NOT NULL,              -- pence: ledger balance
  pending    bigint NOT NULL DEFAULT 0,    -- debits held
  pending_in bigint NOT NULL DEFAULT 0,    -- credits on the way
  available  bigint GENERATED ALWAYS AS (posted - pending) STORED,
  version    bigint NOT NULL DEFAULT 0
);

-- GetBalance, always on the primary
SELECT posted, available, version FROM balances WHERE id = 81442;
--  before:        posted 842000, available 842000, version 6
--  after reserve: posted 842000, available 721980, version 7
--  after post:    posted 721980, available 721980, version 8`,
          note: 'Available is posted minus pending holds, so a hold lowers it at once while the ledger balance waits for the post.',
        },
      ],
    },
    {
      id: 'wal', from: 'db', to: 'replicas', d: 'M795,259 V330', label: 'commit log',
      mode: 'write', via: 'sync WAL', chip: 0.5,
      how: 'The write-ahead log streams to every standby. The commit waits for any one of the two synchronous standbys to confirm it has the record.',
      delivery: 'Recovery point zero: an acknowledged commit is on at least two machines.',
      alts: ['Consensus replication with three voters.', 'Asynchronous streaming, which can lose the last seconds on failover.'],
      ways: [
        { name: 'Sync WAL', chosen: true, what: 'The primary streams its write-ahead log to both standbys, and the commit returns once either one confirms it has flushed the record: ANY 1 (s1, s2).', pros: ['Recovery point zero.', 'One standby can be lost with no pause in writes.'], cons: ['About a millisecond more per commit (an estimate).', 'If both standbys are lost, commits wait.'] },
        { name: 'Consensus replication with three voters', what: 'Three or more voters agree on each log record and elect a new leader themselves. A write commits once a majority has it.', pros: ['Failover needs no operator or separate tool.', 'The same recovery point of zero.'], cons: ['A database built around it, not stock Postgres.', 'At least three voters per shard.'] },
        { name: 'Asynchronous streaming', what: 'The primary streams the log without waiting. The commit returns once the record is on the primary\'s own disk.', pros: ['Lowest commit latency.', 'Standbys never slow payments.'], cons: ['Can lose the last seconds of payments on failover.', 'Not acceptable for a ledger.'] },
      ],
      examples: [
        {
          title: 'The setting on each primary',
          lang: 'text',
          code: `# postgresql.conf
synchronous_standby_names = 'ANY 1 (s1, s2)'
synchronous_commit = on

# s1 and s2 are standbys in two other zones.
# Further replicas stream asynchronously and serve statements.`,
        },
        {
          title: 'One commit, in order',
          lang: 'text',
          code: `primary  writes the commit record for txn 900417 to its WAL
primary  flushes it to its own disk
primary  streams it to s1 and s2
s2       flushes it and confirms first
primary  returns from the call: 900417 is committed
s1       confirms a moment later; nothing waited for it

If the primary died after the commit returned, s2 already
holds 900417 and is promoted with nothing lost.`,
          note: 'The call returns only after a second machine has the record: that is recovery point zero.',
        },
      ],
    },
    {
      id: 'sweep', from: 'sweeper', to: 'db', d: 'M980,190 H890', label: 'sweep',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'Every minute, for each hot account, one balanced transaction moves each sub-account\'s total into the main account.',
      delivery: 'Idempotent: each sweep carries a key made of the account and the interval, so a rerun does nothing.',
      alts: ['Rolling up an append-only account\'s entries into its balance asynchronously.', 'No sweep: reports always sum the sub-accounts.'],
      ways: [
        { name: 'SQL', chosen: true, what: 'Every minute, for each hot account, one balanced transaction moves each sub-account\'s total into the main account. It carries a key made of the account and the interval.', pros: ['An ordinary ledger transaction: same rules, same checks.', 'Idempotent: a rerun for the same interval does nothing.', 'Touches the main row once a minute, not once a payment.'], cons: ['One more writer on each sub-account row while it runs.', 'The main account lags by up to a minute.'] },
        { name: 'Rolling up an append-only account asynchronously', what: 'For an account that only receives credits, entries are appended with no balance update, and a job adds them into the balance later.', pros: ['No sub-accounts at all.', 'Appends never wait on each other.'], cons: ['Only for accounts with no limit to enforce.', 'The balance lags; Modern Treasury applies such entries within 60 seconds.'] },
        { name: 'No sweep', what: 'Totals stay in the 32 sub-accounts for good, and every report sums them with the main account.', pros: ['Nothing to run.', 'Nothing lags: the sum is always exact.'], cons: ['Every reader must know to sum 33 rows.', 'One report that forgets shows a near-empty main account.'] },
      ],
      examples: [
        {
          title: 'One sweep of fee income, as one transaction',
          lang: 'sql',
          code: `-- Fee income: main account 3000, sub-accounts 3001 to 3032
BEGIN;
INSERT INTO idempotency_keys (key, txn_id, created_at)
VALUES ('sweep:3000:2026-11-12T10:41', 900452, now())
ON CONFLICT (key) DO NOTHING;
-- no row inserted: this minute is swept already, stop

-- ascending account id: main 3000 first, then 3001 to 3032
SELECT posted FROM balances WHERE id = 3000 FOR UPDATE;
-- then for each sub-account in turn (sub 17 shown):
SELECT posted FROM balances WHERE id = 3017 FOR UPDATE;
--   posted = 37500
UPDATE balances SET posted = posted - 37500,
  version = version + 1 WHERE id = 3017;
INSERT INTO entries
  (txn_id, account_id, direction, amount, currency, status)
VALUES (900452, 3017, 'debit', 37500, 'GBP', 'posted');
-- last, the main account takes the sum of all 32
UPDATE balances SET posted = posted + 1201340,
  version = version + 1 WHERE id = 3000;
INSERT INTO entries
  (txn_id, account_id, direction, amount, currency, status)
VALUES (900452, 3000, 'credit', 1201340, 'GBP', 'posted');
COMMIT;`,
          note: 'The key is the account and the minute, so a rerun of the same sweep finds it and does nothing. Amounts are illustrative.',
        },
      ],
    },
    {
      id: 'cdc', from: 'db', to: 'relay', d: 'M890,240 H925 Q935,240 935,250 V340 Q935,350 945,350 H980', label: 'outbox rows',
      mode: 'async', via: 'CDC', chip: 0.5,
      how: 'Logical decoding through a replication slot: the relay receives committed outbox rows in commit order.',
      delivery: 'At least once. The slot remembers how far the relay has read, so a restart resumes and may repeat a little.',
      alts: ['Polling the outbox table.', 'Logical decoding messages with no table.'],
      ways: [
        { name: 'CDC', chosen: true, what: 'The relay reads the write-ahead log through a logical replication slot and receives committed outbox rows in commit order. The slot remembers how far it has read.', pros: ['Only committed rows, in commit order.', 'No polling queries on the primary.', 'Resumes where it left off after a restart.'], cons: ['At least once: a restart may repeat a little.', 'The slot holds log on the primary until read, so watch the disk.'] },
        { name: 'Polling the outbox table', what: 'A worker queries the outbox for unsent rows every so often, publishes them and marks them sent.', pros: ['Simple, with no slot to manage.', 'Works on any database.'], cons: ['Can miss or reorder rows from concurrent commits.', 'Adds queries and writes to the primary.'] },
        { name: 'Logical decoding messages with no table', what: 'The stored function emits a logical decoding message instead of inserting a row. The relay reads it through the same slot.', pros: ['No outbox table to clear out.', 'The same atomicity and commit order.'], cons: ['Postgres-specific.', 'No table to query when checking what was sent.'] },
      ],
      examples: [
        {
          title: 'The outbox row as the relay receives it',
          lang: 'json',
          code: `{
  "op": "c",
  "before": null,
  "after": {
    "id": 5512930,
    "txn_id": 900418,
    "account_id": 81442,
    "payload": "<the event as JSON text: see ledger-events>"
  },
  "source": {
    "connector": "postgresql",
    "table": "outbox",
    "lsn": 249113864
  }
}`,
          note: 'op "c" is an insert; lsn is the position in the write-ahead log, which the relay copies into the event.',
        },
      ],
    },
    {
      id: 'publish', from: 'relay', to: 'kafka', d: 'M1104,350 H1140 Q1150,350 1150,360 V443', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.7,
      how: 'Each outbox row becomes one event on ledger-events, keyed by account so an account\'s events keep their order.',
      delivery: 'At least once, in order per account. Events carry the database log position so readers can drop repeats.',
      alts: ['One topic per event type.', 'A managed stream (Kinesis, Pub/Sub).'],
      ways: [
        { name: 'Kafka, keyed by account', chosen: true, what: 'The relay turns each outbox row into one event on ledger-events, keyed by account. Kafka keeps order within a partition, so each account\'s events stay in order.', pros: ['Ordered per account.', 'Replayable for every reader.', 'Light: about 1 MB a second on average, about 10 MB at peak.'], cons: ['At least once: events carry the log position so readers can drop repeats.', 'A partition holding a busy account can lag behind the others.'] },
        { name: 'One topic per event type', what: 'Separate topics for, say, holds placed, payments posted and holds voided. Each consumer subscribes only to what it needs.', pros: ['Consumers skip what they do not need.', 'Each topic can have its own retention and schema.'], cons: ['No order across topics: a void can be read before its hold.', 'More topics to run and keep in step.'] },
        { name: 'A managed stream (Kinesis, Pub/Sub)', what: 'A cloud provider\'s stream in place of a Kafka cluster, with the account as the key that keeps order.', pros: ['Nothing to run.', 'Replay within the service\'s retention.'], cons: ['Ties the ledger\'s events to one cloud.', 'Ordering and retention rules differ by product; check them before relying on replay.'] },
      ],
      examples: [
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic       ledger-events
key         "81442"   Bright Bakery's account
partition   chosen by hashing the key, so every event for
            81442 lands in one partition, in commit order`,
          note: 'The key keeps one account\'s events in order; there is no order across accounts, and none is needed.',
        },
        {
          title: 'Message value',
          lang: 'json',
          code: `{
  "type": "transaction.posted",
  "txn_id": 900418,
  "pending_txn_id": 900417,
  "reference": "pay_3fK9",
  "account_id": 81442,
  "currency": "GBP",
  "entries": [
    { "account_id": 81442, "direction": "debit", "amount": 120020 },
    { "account_id": 2017, "direction": "credit", "amount": 120000 },
    { "account_id": 3017, "direction": "credit", "amount": 20 }
  ],
  "posted": 721980,
  "available": 721980,
  "lsn": 249113864,
  "committed_at": "2026-11-12T10:41:03.118Z"
}`,
          note: 'lsn is what lets a reader drop a repeat: anything at or below the last lsn it applied for 81442.',
        },
      ],
    },
    {
      id: 'notify', from: 'kafka', to: 'consumers', d: 'M1120,475 H975', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.5,
      how: 'Each consumer group reads at its own pace: notifications in seconds, the warehouse in batches.',
      delivery: 'At least once. Consumers keep the last applied position per account and skip anything older.',
      alts: ['Webhooks pushed to partners from a dedicated consumer.'],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Each consumer group reads ledger-events at its own pace: notifications within seconds, the warehouse in batches. Each keeps its own position.', pros: ['A slow consumer builds lag, not payment latency.', 'Each can replay from its own position.'], cons: ['At least once: each keeps the last position per account and skips anything older.', 'Lag to watch per group.'] },
        { name: 'Webhooks pushed to partners from a dedicated consumer', what: 'One consumer reads the topic and pushes events to partners\' URLs, retrying until they accept.', pros: ['Partners get events without access to Kafka.', 'A failing partner only slows that one consumer.'], cons: ['Partners\' endpoints fail, so retries and backoff are needed.', 'Events must be signed so partners can trust them.'] },
        { name: 'The ledger calls each service', what: 'After each commit, the ledger calls every downstream service directly.', pros: ['Immediate.', 'No log to run.'], cons: ['The ledger waits on, and fails with, every downstream service.', 'A crash between commit and call drops the notice.'] },
      ],
      examples: [
        {
          title: 'What the notifications consumer does',
          lang: 'text',
          code: `group         notifications
reads         ledger-events, the partition holding key "81442"

last applied  lsn 249071520 for 81442 (the reserve, 900417)
this event    lsn 249113864, txn 900418, transaction.posted
              -> newer: send the push, store 249113864

same event again after a relay restart
              lsn 249113864, not newer -> skip`,
          note: 'The check is per account, so a repeat is skipped without a lookup of every event ever seen.',
        },
        {
          title: 'Push sent to the owner',
          lang: 'json',
          code: `{
  "to": "<the owner's device token>",
  "title": "Payment sent",
  "body": "£1,200.00 paid, reference INV 3318. Fee 20p."
}`,
        },
      ],
    },
    {
      id: 'events', from: 'kafka', to: 'recon', d: 'M1240,443 V232', label: 'ledger totals',
      mode: 'async', via: 'Kafka', chip: 0.5,
      how: 'Reconciliation builds its own running totals per settlement account and per day from the events.',
      delivery: 'At least once, deduplicated by transaction id.',
      alts: ['Reading the replicas directly at the end of each day.'],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Reconciliation reads ledger-events and keeps its own running totals per settlement account and per day, deduplicated by transaction id.', pros: ['Totals are ready the moment the bank file arrives.', 'No load on the ledger\'s databases.'], cons: ['Its totals are a copy: a bug in the consumer looks like a break.', 'At least once, so deduplication must be right.'] },
        { name: 'Reading the replicas at the end of each day', what: 'At the end of each day, reconciliation queries a replica of each shard for the day\'s totals per settlement account.', pros: ['Reads the record itself, not a copy.', 'No consumer to keep running.'], cons: ['Heavy queries across 16 shards every night.', 'Must allow for replica lag at the day\'s cut-off.'] },
        { name: 'From the data warehouse', what: 'Reconciliation queries the data warehouse, which is fed from the same topic.', pros: ['SQL over all history, which finance already uses.', 'No load on the ledger at all.'], cons: ['Another hop, with its own lag.', 'A loading bug in the warehouse looks like a ledger break.'] },
      ],
      examples: [
        {
          title: 'Reconciliation\'s own running total',
          lang: 'sql',
          code: `-- In reconciliation's own database, not the ledger's,
-- for event txn 900418 (credit 120000 to 2017):
BEGIN;
INSERT INTO seen_txns (txn_id) VALUES (900418)
ON CONFLICT (txn_id) DO NOTHING;
-- 0 rows: a repeat; roll back and skip it

-- 2017 is sub-account 17 of FPS settlement, main 2000
UPDATE settlement_totals
SET total = total + 120000, txns = txns + 1
WHERE account_id = 2000 AND day = '2026-11-12';
COMMIT;`,
          note: 'The transaction id is the dedupe key here, and the totals are kept per main account, summing its 32 sub-accounts.',
        },
      ],
    },
    {
      id: 'files', from: 'files', to: 'recon', d: 'M1200,62 V168', label: 'statements',
      mode: 'external', via: 'SFTP', chip: 0.5,
      how: 'Daily bank statements and scheme settlement reports arrive as files, or through the bank\'s API where it has one.',
      delivery: 'Each file is checksummed and loaded once; a missing file raises an alert, not a silent skip.',
      alts: ['Intraday statement feeds by API.'],
      ways: [
        { name: 'SFTP', chosen: true, what: 'Daily bank statements and scheme settlement reports arrive as files over SFTP. Each is checksummed and loaded once, and a missing file raises an alert.', pros: ['Every bank and scheme can send files.', 'Complete and final for the day.'], cons: ['A day\'s delay before an outside error shows.', 'A parser per file format.'] },
        { name: 'Intraday statement feeds by API', what: 'The bank\'s API serves statement lines during the day, and reconciliation matches them as they arrive.', pros: ['Breaks found within the hour.', 'Fixes the same day.'], cons: ['Not every bank or scheme offers it.', 'Another integration per bank.'] },
        { name: 'Manual upload by finance', what: 'Someone in finance downloads each statement from the bank\'s portal and uploads it.', pros: ['No integration to build.', 'Works with any bank.'], cons: ['A human step every business day, which will be missed.', 'Harder to show the file was not altered on the way.'] },
      ],
      examples: [
        {
          title: 'The file',
          lang: 'text',
          code: `host     sftp.bank.example
path     /outbound/2026-11-12/fps-settlement.csv
on load  SHA-256 recorded; a file already loaded is skipped
missing  no file by the agreed time raises an alert

account,date,direction,amount_pence,reference
FPS-SETTLE,2026-11-12,DR,120000,pay_3fK9
FPS-SETTLE,2026-11-12,TOTAL,41380750,`,
          note: 'The column layout is illustrative; each bank and scheme has its own, and each needs its own parser.',
        },
        {
          title: 'The comparison, and the break',
          lang: 'text',
          code: `account 2000 (FPS settlement), 2026-11-12
ledger total        41380250p   from ledger-events
statement total     41380750p   from the bank file
difference               500p   a £5 break

-> break brk_1127 raised with an owner, the amount
   and the lines on each side that do not match`,
        },
      ],
    },
    {
      id: 'history', from: 'ledger', to: 'replicas', d: 'M550,228 V345 Q550,355 560,355 H700', label: 'statement page',
      mode: 'call', via: 'SQL read', chip: 0.73,
      how: 'Statements and history are read from an asynchronous replica: entries for one account, newest first, 50 at a time, continuing from the last entry id seen.',
      delivery: 'Read-only and repeatable. A page may lag the primary by a second, which a statement can tolerate.',
      alts: ['A search index fed from the topic, for filtering by payee or amount.', 'The primary, when a page must include a payment made a moment ago.'],
      ways: [
        { name: 'SQL read from a replica', chosen: true, what: 'The Ledger API reads one account\'s entries from an asynchronous replica, newest first, 50 at a time, continuing from the last entry id seen.', pros: ['Takes statement load off the primary.', 'Cursor pages stay stable as new entries arrive.'], cons: ['A page may lag the primary by a second.', 'A payment made a moment ago may be missing.'] },
        { name: 'A search index fed from the topic', what: 'A search index built from ledger-events serves statements filtered by payee, amount or text.', pros: ['Filtering and text search that the database does poorly.', 'No statement load on any shard.'], cons: ['A copy, behind by the topic\'s lag.', 'Another system to run and rebuild.'] },
        { name: 'The primary', what: 'Read the page from the shard\'s primary.', pros: ['Always current, including a payment made a moment ago.', 'No replica to depend on.'], cons: ['Statement reads compete with payments for the primary.', 'Worth it only for the first page right after a payment.'] },
      ],
      reply: {
        id: 'page', label: 'entries',
        how: 'Up to 50 entries and a cursor for the next page.',
        delivery: 'Cursor pagination: new entries arriving do not shift or repeat a page.',
      },
      examples: [
        {
          title: 'First page and next page',
          lang: 'sql',
          code: `-- On an asynchronous replica: newest 50 entries for 81442
SELECT id, txn_id, direction, amount, status, created_at
FROM entries
WHERE account_id = 81442
ORDER BY id DESC
LIMIT 50;

-- Next page: older than the last id seen, 7730512
SELECT id, txn_id, direction, amount, status, created_at
FROM entries
WHERE account_id = 81442 AND id < 7730512
ORDER BY id DESC
LIMIT 50;`,
          note: 'The page continues from an id, not an offset, so new entries arriving do not shift or repeat a page.',
        },
        {
          title: 'Reply',
          lang: 'text',
          code: `up to 50 rows, newest first
cursor for the next page: the id of the last row returned`,
        },
      ],
    },
    {
      id: 'correct', from: 'recon', to: 'ledger', d: 'M1150,168 V90 Q1150,80 1140,80 H560 Q550,80 550,90 V172', label: 'correcting entry',
      mode: 'call', via: 'ledger API', chip: 0.85, cold: true,
      how: 'Off the hot path. Once a break is understood and approved by a second person, a correcting transaction is posted through the ledger API like any other, with a reference to the break.',
      delivery: 'Idempotent on the break id, so approving twice posts once.',
      alts: ['A reviewed bulk migration for a large incident, shown with its effect before it runs, as Stripe does.'],
      ways: [
        { name: 'Ledger API', chosen: true, what: 'Once a break is understood and a second person approves, a correcting transaction is posted through the Ledger API like any other. It is idempotent on the break id.', pros: ['The same rules as every payment: it must balance.', 'Approving twice posts once.', 'The history keeps both the mistake and the fix.'], cons: ['One break at a time: slow for a large incident.', 'Needs a review tool for the second person.'] },
        { name: 'A reviewed bulk migration', what: 'For a large incident, a job builds all the correcting transactions, shows their effect, and runs once approved. Stripe corrects this way.', pros: ['Thousands of fixes in one reviewed step.', 'The effect is seen before anything posts.'], cons: ['A powerful tool that must itself be tested.', 'A mistake in it is a mistake at scale.'] },
        { name: 'Direct SQL on the database', what: 'An engineer changes the wrong rows in the database by hand.', pros: ['Fastest to do.', 'No tooling needed.'], cons: ['Breaks the rule that no role may UPDATE or DELETE entries.', 'No record of the mistake, or of who fixed it.', 'Balance rows and entries can disagree afterwards.'] },
      ],
      examples: [
        {
          title: 'Example call, after a second person approves',
          lang: 'text',
          code: `CreateTransaction
{ "idempotency_key": "brk_1127", "status": "POSTED",
  "currency": "GBP", "reference": "break brk_1127",
  "entries": [
    { "account": "2000", "direction": "debit", "amount": 500 },
    { "account": "4000", "direction": "credit", "amount": 500 }
  ] }
-> { "txn_id": 901733, "status": "POSTED" }

Approved twice: the same call with key brk_1127
-> the same reply; posted once`,
          note: 'The other leg depends on the cause; 4000 here is a suspense account holding the £5 until it is traced.',
        },
      ],
    },
    {
      id: 'export', from: 'replicas', to: 'archive', d: 'M760,400 V465 Q760,475 750,475 H615', label: 'old months',
      mode: 'write', via: 'export', chip: 0.75, cold: true,
      how: 'Off the hot path. Monthly, the oldest partition of entries is exported from a replica to Parquet with its row count and sums, then detached on the primary.',
      delivery: 'Write once per month; the partition is detached only after the counts match.',
      alts: ['Logical backups kept for the retention period.'],
      ways: [
        { name: 'Export', chosen: true, what: 'Monthly, the oldest partition of entries is exported from a replica to Parquet with its row count and sums, then detached on the primary once they match.', pros: ['No export load on the primary.', 'Counts and sums prove the file is complete.'], cons: ['A monthly job to watch.', 'Old statements are read from files.'] },
        { name: 'Logical backups kept for the retention period', what: 'Keep logical dumps of the database for as long as records must be kept, instead of monthly exports.', pros: ['Uses backup tooling the team already runs.', 'Restores the data exactly as it was.'], cons: ['Not queryable: an old statement means restoring a dump.', 'The live tables still grow unless partitions are dropped.'] },
        { name: 'Export from the primary', what: 'Run the monthly export on the shard\'s primary instead of a replica.', pros: ['No replica needed for exports.', 'One fewer machine in the path.'], cons: ['Reading a month, about 65 GB a day × 30 ÷ 16 shards = about 120 GB a shard, competes with payments.', 'A slow export on the primary can hold back cleanup of old row versions.'] },
      ],
      examples: [
        {
          title: 'Count and sum, then detach',
          lang: 'sql',
          code: `-- In November 2026, September 2025 passes 13 months old.
-- On a replica: what the exported files must match
SELECT count(*) AS entries,
  sum(amount) FILTER (WHERE direction = 'debit')  AS debits,
  sum(amount) FILTER (WHERE direction = 'credit') AS credits
FROM entries_2025_09;
--  entries 487512904, debits = credits

-- On the primary, only after the files' counts match
ALTER TABLE entries DETACH PARTITION entries_2025_09;`,
          note: 'Debits must equal credits in the export as in the database; a mismatch stops the detach.',
        },
        {
          title: 'Objects written',
          lang: 'http',
          code: `PUT /ledger-archive/shard-07/entries/2025-09/part-0000.parquet
PUT /ledger-archive/shard-07/entries/2025-09/part-0001.parquet
  (and so on: the month's entries for shard 7, as Parquet)

PUT /ledger-archive/shard-07/entries/2025-09/manifest.json
{
  "partition": "entries_2025_09",
  "entries": 487512904,
  "debits": 9418265530112,
  "credits": 9418265530112,
  "files": [
    { "name": "part-0000.parquet", "sha256": "9c1e...e04a" }
  ]
}`,
          note: 'The manifest carries the counts, the sums and a checksum per file, so the archive can be checked later without the database.',
        },
      ],
    },
  ],

  tour: [
    {
      title: 'A payment request arrives',
      text: 'Bright Bakery Ltd pays its flour supplier £1,200 by Faster Payments. When the owner pressed Pay, the app created an idempotency key, k7, once. It sends the amount as 120000 pence with the key.',
      focus: ['client', 'api'],
      path: ['pay'],
      labels: ['£1,200, key k7'],
    },
    {
      title: 'Authenticate and check',
      text: 'The Banking API asks for strong customer authentication, checks the payee\'s name with Confirmation of Payee, scores the payment for fraud and checks limits. Nothing has touched money yet, so a failure here needs no undo.',
      focus: ['api'],
      path: [],
      labels: ['£1,200'],
    },
    {
      title: 'Reserve the funds',
      text: 'One pending transaction that sums to zero: debit Bright Bakery 120020p, credit scheme settlement 120000p, credit fee income 20p. One database call stores key k7, reserves WHERE available >= 120020, and adds the entries and an outbox row.',
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn'],
      labels: ['reserve £1,200', '1 transaction'],
    },
    {
      title: 'Commit on two machines',
      text: 'The commit waits until one of two synchronous standbys in another zone has the log record. Only then is the reservation confirmed. If the primary died now, the standby would already hold it: nothing acknowledged is lost.',
      focus: ['db', 'replicas', 'ledger', 'api'],
      path: ['wal', '<wal', 'committed', 'result'],
      labels: ['log record', 'confirmed', 'committed', 'reserved'],
    },
    {
      title: 'Send it to the scheme',
      text: 'With the money held, the payment goes to Faster Payments. A timeout here would mean "unknown", not "failed": the funds stay reserved until the scheme confirms either way.',
      focus: ['api', 'fps'],
      path: ['send', 'ack'],
      labels: ['payment', 'accepted'],
    },
    {
      title: 'Settle: post the pending',
      text: 'The scheme accepted, so the API asks the ledger to post the pending transaction. A new posting moves the amounts from pending to posted; nothing is edited. Had the scheme rejected it, a void would have released the hold instead.',
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['post k7', 'pending to posted', 'committed', 'posted'],
    },
    {
      title: 'The app retries',
      text: 'The phone lost signal before the answer arrived, so it sends the same request again with key k7. The ledger finds k7 already stored and returns the saved result. No second reservation, no second payment.',
      focus: ['client', 'api', 'ledger', 'db'],
      path: ['pay', 'post', 'txn', 'committed', 'result', 'accepted'],
      labels: ['retry, key k7', 'key k7', 'k7 exists', 'saved result', 'same result', 'same payment'],
    },
    {
      title: 'Tell everyone else, safely',
      text: 'The outbox row committed with the entries. The relay reads it from the write-ahead log and publishes an event keyed by account, and the owner gets a notification. There was never a separate write to Kafka that could be lost.',
      focus: ['db', 'relay', 'kafka', 'consumers'],
      path: ['cdc', 'publish', 'notify'],
      labels: ['outbox row', 'event', 'event'],
    },
    {
      title: 'Read the balance',
      text: 'The owner opens the app. The balance comes from the primary\'s balance row, updated in the same transaction as the entries, so it already shows the payment. Available is posted minus pending holds; the ledger balance is posted alone.',
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['balance?', 'read row', 'balance row', 'available'],
    },
    {
      title: 'Statements from a replica',
      text: 'The statement page is read from an asynchronous replica, 50 entries at a time, continuing from the last entry id seen. A second of lag is fine for history and takes the load off the primary.',
      focus: ['ledger', 'replicas'],
      path: ['history', 'page'],
      labels: ['next 50', '50 entries'],
    },
    {
      title: 'The hot account',
      text: 'Every payment credits fee income, so one balance row would make every payment queue behind it. The 20p went to sub-account 17 of 32, picked by hashing the transaction id. Each minute the sweeper moves them into the main account.',
      focus: ['ledger', 'db', 'sweeper'],
      path: ['txn', 'sweep'],
      labels: ['20p to sub 17', 'sweep 32 into 1'],
    },
    {
      title: 'Reconciliation finds a break',
      text: 'Overnight the bank\'s statement for the settlement account is matched against the ledger\'s totals. Today they differ by £5. A break is raised with an owner, and once understood it is fixed by a correcting transaction through the ledger API. No entry is edited.',
      focus: ['files', 'recon', 'kafka'],
      path: ['files'],
      labels: ['statement'],
    },
    {
      title: 'When a shard\'s primary dies',
      text: 'The failover tool promotes the synchronous standby, which already holds every acknowledged transaction. Writes to that shard pause; the target is under a minute. Requests that timed out are retried with the same keys, so none is posted twice.',
      focus: ['db', 'replicas'],
      path: ['wal'],
      labels: ['promote'],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        'Whose money? Customer balances for a bank or e-money firm, a marketplace\'s internal ledger, or the company\'s own books? This page assumes a business bank\'s customer ledger.',
        'What does "strict consistency" mean here? I take it as: no balance ever goes below its limit, no money is created or lost, and a read after a write sees it.',
        'How many writes, and how skewed? Average and peak, and whether some accounts appear in most transactions.',
        'Which rails? Faster Payments, Bacs, CHAPS and cards each settle differently, which drives the pending states.',
        'One currency or many? Who reads it: the app, finance, regulators, auditors?',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Record transactions of two or more entries that always sum to zero, in integer minor units with a currency.',
        'Hold funds (pending), then post or release them; reject anything that would take a balance below its limit.',
        'Never apply the same request twice, whatever the client retries.',
        'Return the current balance (available and ledger) and statements of entries.',
        'Correct mistakes only by adding entries; keep an audit trail of who did what.',
        'Publish every change for other services.',
      ],
    },
    {
      heading: 'How well',
      points: [
        'Assume 1,000 transactions a second on average, 10,000 at peak.',
        'Target: reserve or post in under 50 ms at the 99th percentile inside the ledger.',
        'No acknowledged transaction lost (recovery point zero); a shard back within a minute.',
        'Balance reads always current; statements may lag by a second.',
        'Reconciled internally every few minutes and against the bank every business day.',
      ],
    },
  ],

  numbers: [
    { what: 'Writes', assumption: '1,000 transactions a second on average, ten times at peak (payroll, month end, batch files)', result: '86 million a day; build for 10,000 a second' },
    { what: 'Entries', assumption: 'about 3 per transaction: two legs and a fee', result: '3,000 a second on average, 30,000 at peak' },
    { what: 'Storage', assumption: 'about 250 bytes an entry with indexes', result: 'about 65 GB a day, 24 TB a year' },
    { what: 'Hot data', assumption: '13 months in the database (statements, claims windows)', result: 'about 26 TB: 1.6 TB on each of 16 shards' },
    { what: 'Shards', assumption: 'assume 1,000 a shard at peak (Modern Treasury load-tested a target of 1,200 a second, not a ceiling)', result: '10 needed, 16 for headroom and uneven tenants' },
    { what: 'One hot row', assumption: 'locked until a synchronously replicated commit, assume 1 to 2 ms', result: 'estimate: 500 to 1,000 writes a second' },
    { what: 'Fee account', assumption: 'touched by every payment at 10,000 a second', result: '32 sub-accounts: about 300 writes a second each' },
    { what: 'Idempotency keys', assumption: 'kept 72 hours, about 150 bytes each', result: 'about 40 GB across all shards' },
    { what: 'Balance rows', assumption: '1 million accounts plus sub-accounts, about 100 bytes each', result: 'about 100 MB: always in memory' },
    { what: 'Events', assumption: 'one per transaction, about 1 KB', result: 'about 1 MB a second on average' },
  ],

  framings: [
    {
      name: 'Business bank ledger (this diagram)',
      scale: '1,000 a second on average, 10,000 at peak, a million accounts',
      shape: 'Postgres sharded by business. Conditional balance updates in one call per transaction, synchronous standbys, sub-accounts for hot accounts, an outbox for events, daily reconciliation.',
    },
    {
      name: 'First version',
      scale: 'up to about 1,000 a second',
      shape: 'One Postgres primary with a synchronous standby and no sharding. The same tables, functions and outbox, so sharding later is routing, not a rewrite. Most companies never need more.',
    },
    {
      name: 'Hot accounts everywhere',
      scale: 'tens of thousands a second through a few shared accounts (a card processor, a central switch)',
      shape: 'A purpose-built ledger: TigerBeetle applies batches of up to 8,190 transfers on one thread in one round trip, with balance limits enforced inside and consensus replication. Account details stay in Postgres beside it.',
    },
    {
      name: 'Ledger of record for finance',
      scale: 'billions of events a day from many systems (Stripe reports five billion)',
      shape: 'Not on the payment path at all. Producers emit events; the ledger is an immutable log replayed into balances, and correctness is shown by clearing accounts returning to zero, not by locks.',
    },
  ],

  decisions: [
    { choice: 'Concurrency control', a: 'Pessimistic: a conditional UPDATE in one database call, locks in account order.', b: 'Optimistic: version check and retry on conflict.', call: 'Conditional update. Optimistic retries collapse exactly when an account is busy; offer a version check in the API for clients that want "only if nothing changed".' },
    { choice: 'Balance', a: 'Materialised row updated in the same transaction as the entries.', b: 'Summed from entries on every read.', call: 'Materialised, so checks are one row and reads are exact. A job proves row equals sum of entries.' },
    { choice: 'Hot accounts', a: 'Sub-accounts with periodic sweeps.', b: 'Append-only with an asynchronous balance.', call: 'Sub-accounts by default; no balance check at all for accounts that only receive credits.' },
    { choice: 'Transfers across shards', a: 'Saga through a clearing account: debit on one shard, credit on the other, each its own transaction.', b: 'Two-phase commit across shards.', call: 'Keep a business on one shard; for the rare cross-shard transfer, a saga. The clearing account shows anything in flight.' },
    { choice: 'Durability', a: 'Synchronous standby, quorum of one in two.', b: 'Asynchronous replication.', call: 'Synchronous. Roughly a millisecond per commit (an estimate) is the price of losing nothing.' },
    { choice: 'Events', a: 'Outbox row in the same transaction, read by CDC.', b: 'Publish after commit.', call: 'Outbox. A dual write loses or invents events on every crash.' },
    { choice: 'Database', a: 'Postgres, which the team knows.', b: 'A purpose-built ledger database (TigerBeetle).', call: 'Postgres at this scale; move the posting engine when hot-account contention dominates.' },
  ],

  drills: [
    { name: 'A shard\'s primary dies', what: 'Promote the synchronous standby: it has every acknowledged commit. Writes to that shard pause; we target under a minute. Clients retry with the same keys.' },
    { name: 'Both synchronous standbys are lost', what: 'Commits on that shard block. Stop accepting writes there and say so, rather than drop to asynchronous replication and risk losing payments. Other shards carry on.' },
    { name: 'The scheme times out after we sent', what: 'The payment is unknown, not failed. Keep the funds reserved, ask the scheme for its status with the same payment id, then post or void.' },
    { name: 'Two retries arrive at once', what: 'The unique key lets one insert win; the other waits on the row and then returns the stored result, or gets a conflict and retries.' },
    { name: 'Kafka is down', what: 'The ledger is unaffected. Outbox rows wait in the log; the relay catches up. Watch the primary\'s disk, because the replication slot holds log until it is read.' },
    { name: 'The relay publishes an event twice', what: 'Consumers keep the last log position applied per account and skip anything at or below it.' },
    { name: 'The fee account becomes the bottleneck', what: 'Lock waits on one row climb. Raise its sub-accounts from 32 to 64; nothing else changes.' },
    { name: 'A balance row disagrees with its entries', what: 'The invariant check alarms. Freeze the account, rebuild the row from the entries, which are the truth, and find the code path that wrote it.' },
    { name: 'The bank statement is £5 off', what: 'A break is raised with owner, amount and evidence. When the cause is found, a correcting transaction is posted and approved by a second person.' },
    { name: 'A bad deploy posts wrong fees', what: 'Turn off the code path. Write reversing transactions through a reviewed bulk job that shows its effect first. The original entries stay as the record.' },
    { name: 'A schema change on a 1.6 TB entries table', what: 'Expand, then contract: add nullable columns, deploy a new version of the posting function beside the old, backfill in small batches, switch callers, and only later drop what is unused. Never rewrite existing entries.' },
    { name: 'A whole region is lost', what: 'Synchronous standbys are in other zones of the same region, so a region loss risks the last seconds sent asynchronously to the other region. Name this trade-off out loud.' },
  ],

  interview: [
    'Open with the model before any boxes: accounts, transactions of two or more entries that sum to zero, entries never changed. Integers in pence with a currency. Then say the two invariants: every transaction balances, and no balance goes below its limit under concurrency.',
    'Do the sums early. 1,000 a second average and 10,000 at peak is within reach of sharded Postgres; the real limit is one hot row, which I estimate at about 1,000 writes a second.',
    'Draw the write path: API, ledger API, one database call that inserts the key, updates balance rows conditionally, inserts entries and an outbox row, and commits to a synchronous standby.',
    'Spend your depth on concurrency. Compare locking with ordering, optimistic versions, serializable, single writer per account and TigerBeetle, then pick one and say why.',
    'Then hot accounts: why a balance row is a lock, and sub-accounts with sweeps, or no check on credit-only accounts.',
    'Cover idempotency end to end: the key from the client, the unique row in the same transaction, the stored result on retry, expiry after 72 hours.',
    'Finish with proof: invariant checks, daily reconciliation against bank statements, breaks fixed by correcting entries. Mention safeguarding if it is an e-money firm.',
  ],

  sources: [
    { label: 'Hello Interview: Design an internal ledger system (community question)', href: 'https://www.hellointerview.com/community/questions/internal-ledger-system/cm8lxn4te00033x68eynjv94p', note: 'The prompt as reported from Stripe interviews. The page has the question only, no answer.' },
    { label: 'Hello Interview: Payment System breakdown', href: 'https://www.hellointerview.com/learn/system-design/problem-breakdowns/payment-system', note: 'Requirements and the 10,000 transactions a second peak. The deep dives are behind a paywall and were not read.' },
    { label: 'Modern Treasury: How we built Ledgers for high throughput', href: 'https://moderntreasury.com/journal/behind-the-scenes-how-we-built-ledgers-for-high-throughput', note: 'Postgres balance caches, row locks for balance-locked entries, an asynchronous path for hot accounts, and a load-test goal of 1,200 transactions a second, which they say is not a ceiling.' },
    { label: 'Modern Treasury: Designing ledgers with optimistic locking', href: 'https://moderntreasury.com/journal/designing-ledgers-with-optimistic-locking', note: 'lock_version on a separate account version row; reads never blocked.' },
    { label: 'Modern Treasury: How to handle concurrent transactions', href: 'https://www.moderntreasury.com/journal/how-to-handle-concurrent-transactions', note: 'Balance locks on the resulting balance against version locks.' },
    { label: 'Modern Treasury docs: Design a ledger for concurrency', href: 'https://docs.moderntreasury.com/ledgers/docs/handle-concurrency', note: 'Hot accounts take only asynchronous entries, applied within 60 seconds.' },
    { label: 'Modern Treasury: How to scale a ledger, parts I and V', href: 'https://moderntreasury.com/journal/how-to-scale-a-ledger-part-i', note: 'The four guarantees, and effective time for backdated entries (part V).' },
    { label: 'Modern Treasury: Accounting for developers, part II', href: 'https://www.moderntreasury.com/journal/accounting-for-developers-part-ii', note: 'Debit-normal and credit-normal accounts, with a wallet example.' },
    { label: 'TigerBeetle: Performance, OLTP, Safety, Two-phase transfers, Data modelling, Currency exchange', href: 'https://docs.tigerbeetle.com/concepts/performance/', note: 'Batches of up to 8,190 transfers, single core, consensus replication paid once per batch.' },
    { label: 'TigerBeetle: Rediscovering transaction processing (2024)', href: 'https://tigerbeetle.com/blog/2024-07-23-rediscovering-transaction-processing-from-history-and-first-principles', note: 'Row locks held across 10 to 20 queries, the 0.5 ms round trip arithmetic, and a central bank switch no hardware could speed up.' },
    { label: 'Ximedes: Solving the hot key problem', href: 'https://ximedes.com/blog/solving-the-hot-key-problem', note: 'About 100 transactions a second per account on general databases; Mojaloop from 78 to over 2,000 a second.' },
    { label: 'Stripe: Ledger, tracking and validating money movement', href: 'https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement', note: 'Immutable log, clearing accounts that should net to zero, five billion events a day, corrections by reviewed migration.' },
    { label: 'Square: Books, an immutable double-entry accounting database', href: 'https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/', note: 'Insert-only journal and book entries, a version per book, corrections by new entries, on Spanner.' },
    { label: 'Uber: How LedgerStore supports trillions of indexes', href: 'https://www.uber.com/us/en/blog/how-ledgerstore-supports-trillions-of-indexes/', note: 'Strongly consistent indexes for holds, eventually consistent ones for history, time-range sealing and cold storage.' },
    { label: 'Monzo: How we calculate balances', href: 'https://monzo.com/blog/2022/02/18/how-we-calculate-balances', note: 'A balance is the sum of entries over a set of ledger addresses; committed and reporting timestamps; tens of named balances.' },
    { label: 'Monzo: Processing payments safely at scale', href: 'https://monzo.com/blog/2022/02/08/processing-payments-safely-at-scale', note: 'Daily reconciliation against the settlement account, the two £5 payments and £15 example, breaks closed with evidence.' },
    { label: 'Stripe API: Idempotent requests', href: 'https://docs.stripe.com/api/idempotent_requests', note: 'Keys up to 255 characters, V4 UUIDs suggested, saved status and body returned on retry, keys may be pruned once 24 hours old, parameter mismatch rejected.' },
    { label: 'Brandur Leach: Implementing Stripe-like idempotency keys in Postgres', href: 'https://brandur.org/idempotency-keys', note: 'Keys in the same database, locked while running, 409 on a concurrent retry, 72 hour reaper.' },
    { label: 'Gunnar Morling: Revisiting the outbox pattern', href: 'https://www.morling.dev/blog/revisiting-the-outbox-pattern/', note: 'Why dual writes fail, log-based CDC in commit order, consumers deduplicating by log position.' },
    { label: 'PostgreSQL docs: Transaction isolation', href: 'https://www.postgresql.org/docs/current/transaction-iso.html', note: 'Read Committed waits for a concurrent updater, then re-evaluates the WHERE clause against the updated row; serialization failures (40001) must be retried.' },
    { label: 'PostgreSQL docs: Explicit locking (deadlocks)', href: 'https://www.postgresql.org/docs/current/explicit-locking.html', note: 'Acquiring locks in a consistent order is the best defence against deadlocks.' },
    { label: 'PostgreSQL docs: Index uniqueness checks', href: 'https://www.postgresql.org/docs/current/index-unique-checks.html', note: 'An insert that conflicts with an uncommitted insert waits; if that one commits, it is a uniqueness violation.' },
    { label: 'PostgreSQL docs: Replication settings (synchronous_standby_names)', href: 'https://www.postgresql.org/docs/current/runtime-config-replication.html', note: 'ANY n (s1, s2, ...) waits for at least n listed standbys.' },
    { label: 'PostgreSQL docs: WAL settings (synchronous_commit, commit_delay)', href: 'https://www.postgresql.org/docs/current/runtime-config-wal.html', note: 'With synchronous_commit on, standbys flush the commit record to durable storage; commit_delay (default zero) enables group commit.' },
    { label: 'PostgreSQL docs: Synchronous replication', href: 'https://www.postgresql.org/docs/current/warm-standby.html', note: 'Data is lost only if primary and standby crash together; commits may never complete if required standbys are gone.' },
    { label: 'Pay.UK: £1 million Faster Payments now possible (2022)', href: 'https://newseventsinsights.wearepay.uk/media-centre/press-releases/1-million-faster-payments-now-possible/', note: 'Up to £1 million from 10 February 2022, up from £250,000; each bank sets its own limit; 24/7.' },
    { label: 'Pay.UK: Faster Payment System', href: 'https://www.wearepay.uk/what-we-do/payment-systems/faster-payment-system/', note: 'Real-time payments of up to £1 million, day and night, 365 days a year.' },
    { label: 'Griffin: Bacs overview', href: 'https://docs.griffin.com/docs/guides/bacs-overview', note: 'Bacs processes payments over three consecutive working days. A UK bank\'s guide; the Bacs site itself was not read.' },
    { label: 'Bank of England: CHAPS', href: 'https://www.bankofengland.co.uk/payment-and-settlement/chaps', note: 'A sterling same-day system for high-value payments, settled gross in RTGS; usually open 6am to 6pm on working days.' },
    { label: 'Payment Services Regulations 2017, regulation 100', href: 'https://www.legislation.gov.uk/uksi/2017/752/regulation/100/made', note: 'Strong customer authentication when a user initiates an electronic payment.' },
    { label: 'PSR: PS22/3, extending Confirmation of Payee coverage', href: 'https://www.psr.org.uk/media/migeob4s/ps22-3-extending-cop-coverage-oct-2022.pdf', note: 'Confirmation of Payee, the name-checking service. Title only; the document was not read in full.' },
    { label: 'PSR: APP fraud reimbursement protections', href: 'https://www.psr.org.uk/information-for-consumers/app-fraud-reimbursement-protections', note: 'From 7 October 2024, Faster Payments and CHAPS, up to £85,000, consumers, microenterprises and charities.' },
    { label: 'Regulation Tomorrow (Norton Rose Fulbright): PSR confirms £85,000 per claim', href: 'https://www.regulationtomorrow.com/2024/10/psr-issues-policy-statement-confirming-maximum-level-of-reimbursement-for-faster-payments-app-scams/', note: 'PS24/7 sets the maximum at £85,000 per claim. A law firm summary; the PSR pages do not say per claim.' },
    { label: 'RSM: FCA safeguarding rules, preparing for 7 May 2026', href: 'https://www.rsmuk.com/insights/advisory/fca-safeguarding-rules-how-to-prepare-for-7-may-2026', note: 'CASS 15, for payment and e-money firms: safeguarded funds reconciled every business day, monthly returns, annual audit. An accountancy summary; the FCA page was not reachable.' },
    { label: 'Regulation Tomorrow (Norton Rose Fulbright): PS25/12 safeguarding changes', href: 'https://www.regulationtomorrow.com/2025/08/ps25-12-changes-to-the-safeguarding-regime-for-payments-and-e-money-firms/', note: 'In force 7 May 2026; reconciliations each business day; monthly return; annual audit.' },
    { label: 'TigerBeetle: Safety', href: 'https://docs.tigerbeetle.com/concepts/safety/', note: 'Viewstamped Replication; all data immutable, checksummed and hash-chained.' },
    { label: 'TigerBeetle: Two-phase transfers', href: 'https://docs.tigerbeetle.com/coding/two-phase-transfers/', note: 'Pending transfers are posted, in full or in part, voided, or time out.' },
  ],

  glossary: [
    { term: 'Double-entry', also: ['double-entry bookkeeping'], where: 'ledger', text: 'Every movement of money is recorded at least twice: where it came from and where it went. The entries of one transaction sum to zero, so money is never created or lost by a write.' },
    { term: 'Entry', also: ['posting', 'ledger entry', 'leg'], where: 'db', see: { id: 'append-log', label: 'Append-only log' }, text: 'One debit or credit to one account: account, amount in minor units, currency, direction, status and time. Entries are only ever inserted.' },
    { term: 'Transaction', also: ['journal entry', 'transfer'], where: 'ledger', text: 'A group of two or more entries that commit together and sum to zero per currency. A payment with a fee is three entries in one transaction.' },
    { term: 'Normal balance', also: ['debit normal', 'credit normal'], where: 'ledger', text: 'Which direction increases an account. A customer\'s account is money the bank owes, a liability, so it is credit normal: a credit raises it. The bank\'s cash at its own bank is an asset, debit normal.' },
    { term: 'Minor units', also: ['pence', 'integer amounts', 'asset scale'], where: 'ledger', text: 'Amounts stored as whole numbers of the smallest unit, such as pence, with the currency beside them. Never floating point. The scale is hard to change later, so choose it once.' },
    { term: 'Pending', also: ['hold', 'authorisation', 'reservation'], where: 'db', text: 'Money promised but not yet final: a card authorisation, or a payment sent but not yet accepted. It reduces the available balance at once and is later posted or voided.' },
    { term: 'Posted', also: ['settled', 'cleared'], where: 'db', text: 'Final. A posted entry is part of the ledger balance and can only be undone by a new, reversing transaction.' },
    { term: 'Two-phase transfer', also: ['post pending', 'void'], where: 'db', text: 'Reserve with a pending transfer, then post it (in full or in part) or void it. Each step is a new record pointing to the first; TigerBeetle lets a pending transfer expire after a timeout.' },
    { term: 'Available balance', also: ['ledger balance', 'current balance'], where: 'db', text: 'Available is what the customer can spend: posted balance minus pending debits. The ledger balance is posted entries only. Monzo keeps tens of named balances, each defined by accounts and a time axis.' },
    { term: 'Reversal', also: ['correcting entry', 'compensating entry'], where: 'recon', text: 'A new transaction that undoes the effect of an earlier one. The original stays, so the history shows both the mistake and the fix.' },
    { term: 'Idempotency key', also: ['Idempotency-Key'], where: 'client', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'A unique value the client sends with a request so a retry is recognised. Stored in the ledger\'s own transaction with a unique constraint; a repeat returns the first result. Stripe may prune keys once they are 24 hours old; Brandur Leach suggests about 72.' },
    { term: 'Conditional update', also: ['guarded update', 'compare and set'], where: 'db', text: 'An UPDATE whose WHERE clause carries the rule, such as "available >= amount". If no row matches, nothing changes and the caller knows the check failed. Check and write are one statement, so no other writer can slip between them.' },
    { term: 'SELECT FOR UPDATE', also: ['row lock', 'pessimistic locking'], where: 'db', see: { id: 'two-phase-locking', label: 'Two-phase locking' }, text: 'Reads rows and locks them until the transaction ends, so no one else can change them meanwhile.' },
    { term: 'Lock ordering', also: ['deadlock'], where: 'db', text: 'Taking locks on several rows in the same order everywhere, such as ascending account id. Two transfers between the same accounts in opposite directions then cannot each hold the lock the other wants.' },
    { term: 'Optimistic concurrency', also: ['version column', 'lock_version'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'Write only if the row\'s version is still the one you read; otherwise fail and retry. Readers never block, but retries pile up on busy rows.' },
    { term: 'Serializable isolation', also: ['SSI', 'serialization failure', '40001'], where: 'db', text: 'The database guarantees the result is as if transactions ran one at a time, aborting any that would break that. The application must retry those aborts.' },
    { term: 'Single writer per account', also: ['actor per account'], where: 'db', text: 'Route every write for an account to one thread or partition that applies them in order, so no locks are needed. A transfer between two owners becomes a two-step exchange.' },
    { term: 'Hot account', also: ['hot row', 'hot key'], where: 'sweeper', text: 'An account in most transactions: fee income, a settlement account, an omnibus account. Its balance row becomes a queue because only one writer can hold it at a time.' },
    { term: 'Sub-account', also: ['sharded counter', 'split account'], where: 'sweeper', see: { id: 'hash-table', label: 'Hash table' }, text: 'One of several accounts that together stand for one hot account. A write picks one by hash, so writers rarely meet; the total is the sum of them all.' },
    { term: 'Sweep', where: 'sweeper', text: 'A periodic balanced transaction moving each sub-account\'s total into the main account, so the main account\'s balance is close to the total between sums.' },
    { term: 'Group commit', also: ['batching', 'commit_delay'], where: 'db', text: 'Flushing the log once for many transactions that are ready to commit together. Postgres\'s commit_delay (zero by default) makes it wait briefly to gather more; TigerBeetle batches up to 8,190 transfers per request.' },
    { term: 'Synchronous replication', also: ['quorum commit', 'synchronous_standby_names'], where: 'replicas', see: { id: 'leader-replication', label: 'Leader replication' }, text: 'The primary waits for a standby to confirm it has the log record before telling the client the commit succeeded. ANY 1 (s1, s2) waits for either of two.' },
    { term: 'RPO and RTO', also: ['recovery point objective', 'recovery time objective'], where: 'replicas', text: 'How much data a failure may lose, and how long recovery may take. A ledger wants a recovery point of zero; this design targets recovery in under a minute per shard.' },
    { term: 'Consensus', also: ['Raft', 'Viewstamped Replication'], where: 'replicas', see: { id: 'raft', label: 'Raft' }, text: 'A protocol for a group of replicas to agree on the order of writes and on a new leader, so failover needs no operator. TigerBeetle uses Viewstamped Replication.' },
    { term: 'Shard by tenant', also: ['partition by business'], where: 'ledger', see: { id: 'partitioning', label: 'Partitioning' }, text: 'Placing all accounts of one business on one shard, so its transfers between its own accounts, and its fees, stay inside one database transaction.' },
    { term: 'Saga', also: ['clearing account', 'suspense account'], where: 'ledger', text: 'A transfer across shards done as two local transactions: debit the payer into a clearing account on one shard, then credit the payee from the clearing account on the other. A balance left in the clearing account shows anything stuck.' },
    { term: 'Two-phase commit', also: ['2PC', 'XA'], where: 'ledger', see: { id: 'two-phase-commit', label: 'Two-phase commit' }, text: 'A coordinator asks every shard to prepare, then to commit. Atomic across shards, but locks are held across the network and a lost coordinator leaves shards waiting.' },
    { term: 'Transactional outbox', also: ['outbox'], where: 'relay', see: { id: 'outbox', label: 'Transactional outbox' }, text: 'Writing the event to publish as a row in the same transaction as the change, and publishing it afterwards from that row. The event exists if and only if the change committed.' },
    { term: 'Change data capture', also: ['CDC', 'logical decoding', 'Debezium'], where: 'relay', text: 'Reading committed changes from the database\'s own log, in commit order, and turning them into events.' },
    { term: 'Dual write', where: 'relay', text: 'Writing to two systems, such as the database and Kafka, with nothing to make them agree. A crash between the writes leaves them different.' },
    { term: 'Invariant check', also: ['trial balance'], where: 'recon', text: 'A query that must always hold: all entries per currency sum to zero, each transaction sums to zero, each balance row equals the sum of its entries.' },
    { term: 'Reconciliation break', also: ['break', 'reconciliation difference'], where: 'recon', text: 'A difference between the ledger and an outside record, such as the bank statement. It gets an owner, an amount and evidence, and is closed with a correcting entry or a fix outside.' },
    { term: 'Safeguarding', also: ['CASS 15'], where: 'recon', text: 'For an e-money or payment firm, keeping customers\' money apart from the firm\'s own. Under the FCA\'s CASS 15 rules, in force from 7 May 2026, safeguarded funds are reconciled every business day.' },
    { term: 'Faster Payments', also: ['FPS'], where: 'fps', text: 'The UK\'s 24/7 real-time payment scheme, up to £1 million a payment at scheme level; each bank sets its own limit. Bacs takes three working days; CHAPS is for high-value same-day payments.' },
    { term: 'APP fraud reimbursement', also: ['authorised push payment'], where: 'api', text: 'Since 7 October 2024, payment firms must reimburse consumers, micro-enterprises and charities who fall for authorised push payment scams on Faster Payments and CHAPS, up to £85,000 a claim.' },
    { term: 'Effective date', also: ['effective_at', 'posted time', 'value date'], where: 'db', text: 'When an entry counts for accounting, which may be earlier than when it was written. Keep both: Monzo calls them reporting and committed time. Balances "as at" a date use the effective date.' },
    { term: 'Keyset pagination', also: ['cursor pagination'], where: 'replicas', see: { id: 'b-plus-tree', label: 'B+ tree' }, text: 'Fetching the next page as "entries older than the last id I saw", using the index, not an offset. Pages stay stable as new entries arrive.' },
    { term: 'Balance snapshot', also: ['checkpoint'], where: 'archive', text: 'A stored balance per account at a point in time, such as month end. A balance at any date is the nearest snapshot plus the entries since.' },
    { term: 'Hash chain', also: ['tamper evidence'], where: 'db', text: 'Each entry stores a hash of its contents and the previous entry\'s hash, so changing any old entry breaks every hash after it. An option for tamper evidence; TigerBeetle hash-chains its data.' },
    { term: 'FX transfer', also: ['currency exchange', 'liquidity account'], where: 'ledger', text: 'Never mix currencies in one transaction. Exchanging pounds for euros is two linked transactions: pounds from the customer to an FX account, euros from the FX account to the customer, both or neither.' },
  ],
};
