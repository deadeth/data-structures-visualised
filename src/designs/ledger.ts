import type { Design } from './types';

/**
 * Ledger service, as a high-level design.
 *
 * The question: "Design a ledger service that must ensure strict consistency
 * for account balances while supporting high-frequency transaction writes."
 *
 * The baseline is the central ledger of a UK business bank: bank payments,
 * payroll, debit and credit card authorisations and settlements, and accounts
 * in several currencies. About a million businesses, 1,000 payments a second
 * on average and 10,000 at peak. One PostgreSQL schema for debit and credit:
 * an append-only ledger_entries journal of settled movements (a trigger
 * refuses UPDATE and DELETE), a pending_holds table for money promised but
 * not yet settled, and an accounts table whose posted_balance and
 * held_balance are caches kept by triggers in the same transaction, guarded
 * against direct edits and held at or above minus the credit limit by a
 * CHECK. Writes lock their accounts in id order with FOR NO KEY UPDATE under
 * short timeouts. Busy system accounts are named by rail and currency and
 * split 16 ways by shard_id, swept at the end of the day. Synchronous
 * standbys, an outbox read by change data capture, reconciliation against
 * the bank and the schemes, and a phased path that ends with the hot
 * debit and credit path in TigerBeetle.
 */
export const ledger: Design = {
  id: 'ledger',
  name: 'Ledger service',
  blurb: 'A central multi-currency ledger for debit and credit. Follow one payment through it, then open any part to see what it does and what you could use instead.',
  rest: 'Press Play to follow a payment, or open any box or chip. In the diagram, arrows move and Enter opens.',
  restTouch: 'Press Play to follow one payment, or tap any box or chip to open it.',
  size: { w: 1280, h: 520 },
  frame: { x: 690, y: 96, w: 430, h: 318, label: 'Ledger cluster × 4', note: 'Phase 1: one; Phase 2: 4' },

  components: [
    {
      id: 'client',
      name: 'Customer apps',
      short: 'Apps',
      tech: 'app, API',
      x: 64, y: 200, w: 116, h: 64, kind: 'input',
      what: "The mobile app, the web app and the public API that accounting and payroll software call. Each one creates an idempotency key when the user presses Pay or submits a payroll run, and sends the same key on every retry. Card authorisations do not come from here: they come from the card network through the card processor, with the network's own ids.",
      why: 'Phones lose signal mid-request. Without a key chosen once, before the first attempt, a retry cannot be told apart from a second payment.',
      built: [
        { name: "Mobile and web apps", what: "The bank's own apps, where a business owner pays suppliers, runs payroll, repays a credit card and checks balances in each currency. They are the client in this design: they send each request and decide when to send it again.", why: "They are the only party that knows two requests are the same attempt, so they make the idempotency key when the payment is drafted, store it with the draft and reuse it on every retry." },
        { name: "Public API", what: "An HTTPS interface that accounting and payroll software call to make payments for a business, instead of a person tapping in the app.", why: "Partners' servers retry too, so the API follows the same rule as the apps: a key per payment in the Idempotency-Key header. A partner whose code makes a new key per retry can still pay twice, which the server cannot detect." },
        { name: "Idempotency key (version 4 UUID)", what: "A random identifier, 122 random bits, made once per payment and sent with every attempt. The ledger stores it with a unique constraint, so a second request with the same key gets the first result.", why: "A UUID needs no coordination with the server and will not collide by chance. Stripe accepts keys of up to 255 characters and suggests UUIDs. The ledger keeps keys 72 hours, about 80 GB across all clusters (two keys a payment: the hold's and the capture's)." },
      ],
      numbers: [
        { text: 'A version 4 UUID per payment. Stripe accepts keys of up to 255 characters and suggests UUIDs.', from: "Not a sum. The 255-character limit and the advice to use UUIDs are from Stripe's idempotent requests docs, cited on the page. A version 4 UUID has 122 random bits, so two clients picking the same key by chance is not a practical worry." },
      ],
      fails: 'A client that makes a new key on each retry defeats the whole scheme. Generate the key when the payment is drafted, store it with the draft, and reuse it.',
      alternatives: [
        {
          name: 'Client-chosen idempotency key per payment', chosen: true, good: 'The only party that knows two requests are the same attempt is the one that sent them.', cost: 'Every client must get it right, so the SDKs do it for them.',
          what: 'The app makes a UUID when the payment is drafted, stores it with the draft, and sends it as the Idempotency-Key header on every attempt. The ledger stores it, and keys made from it (k7:capture), with a unique constraint in the same transaction as each write, for 72 hours.',
          pros: ['Only the sender knows two requests are one attempt, so the sender names it.', 'A retry after a lost reply, like k7 on the tour, returns the saved result and moves no money.', 'The same scheme works for the app, the web app and API partners.'],
          cons: ['Every client must make the key once, before the first attempt, so the SDKs do it for them.', 'A partner whose code makes a new key per retry can still pay twice, and the server cannot tell.', 'Keys must be kept: about 80 GB across all clusters for 72 hours.'],
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
          pros: ['Nothing to build or store.', 'No key table in each cluster.'],
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
      what: "The edge of the bank for payments. It authenticates the user (strong customer authentication for a payment), checks the payee with Confirmation of Payee, asks fraud and limit services, then runs the payment as a small state machine: place a hold in the ledger, send to the scheme, then capture the hold or void it. The payment record holds the state (PENDING, SETTLED or FAILED); the ledger shows only where the money is and what is held. Card authorisations reach the same kind of workflow from the card processor, payroll runs from the payroll API, and a separate billing service posts credit card interest straight to the Ledger API. It serves balance and statement reads by calling the ledger.",
      why: "The ledger should know about money, not about Faster Payments, Mastercard, statements or fraud. Keeping the orchestration and the payment state here lets the ledger stay a small, strict service with one job, and lets its entries stay append-only: a status that changes cannot live on a row that never changes. The hold's own status is the one exception, and it lives in pending_holds, not in the journal.",
      built: [
        { name: "Strong customer authentication", what: "A legal requirement to confirm the user with two independent proofs when they start an electronic payment, such as the phone and a fingerprint.", why: "Required by the Payment Services Regulations 2017. It runs before the ledger is called, so a failure leaves nothing to undo." },
        { name: "Confirmation of Payee", what: "A UK service that checks the name the user typed against the name on the payee's account, through the payee's bank, and warns on a mismatch.", why: "A payment sent to the wrong or a scammer's account is hard to recover, and the bank may owe up to £85,000 a claim under APP scam reimbursement. Checking first is far cheaper." },
        { name: "Payment workflow (a recorded state machine)", what: "Each payment is a row with a state: PENDING (with the step reached: held, then sent), SETTLED or FAILED. The API records each step before starting the next.", why: "A crash leaves a named state that a recovery worker can finish, repeating calls with the same idempotency key. With this few states, it needs less machinery than a workflow engine such as Temporal, which would add another system to the money path." },
      ],
      numbers: [
        { text: 'Faster Payments allows up to £1 million a payment; each bank sets its own lower limits.', from: "Not a sum. The scheme limit is from Pay.UK, cited on the page. Each bank sets its own lower limit, so the Banking API checks the bank's limit, not the scheme's." },
        { text: 'APP scam reimbursement covers Faster Payments and CHAPS, up to £85,000 a claim, since 7 October 2024, for consumers, micro-enterprises and charities.', from: "Not a sum. The date, the rails and who is covered are from the PSR page, cited. The words 'per claim' are from the Norton Rose Fulbright summary of PS24/7, also cited, because the PSR page does not say per claim." },
      ],
      fails: 'It crashes between steps. Each step is recorded before the next starts, so a recovery worker resumes the payment from its last state, using the same idempotency key for every call it repeats. A hold left ACTIVE by a payment nobody finishes is ended by the expiry job when its expires_at passes.',
      alternatives: [
        {
          name: 'Payment state machine, recorded step by step', chosen: true, good: 'Every payment is in a named state (PENDING, SETTLED, FAILED, with the step reached), so a crash leaves something a worker can finish.', cost: 'More code than a straight-line handler, and the states need tests.',
          what: 'Each payment is a row with a state: PENDING while it is held and sent, then SETTLED or FAILED. The API records each step before starting the next, so a recovery worker can pick up any payment that stopped, repeating calls with the same idempotency key.',
          pros: ['A crash leaves a named state that a worker can finish.', 'Every ledger call is keyed, so repeating a step is harmless.', 'The states answer what support and audit ask: where is this payment?', 'No extra system on the money path.'],
          cons: ['More code than a straight-line handler.', 'Every state and transition needs tests, above all the timeout after sending.', 'A recovery worker to build and watch.'],
        },
        {
          name: 'A workflow engine (Temporal and similar)', good: 'Retries, timers and resumption come built in.', cost: 'Another system on the money path, and its SDK in every service.',
          what: 'The payment is written as a workflow in a durable execution engine. The engine records each step and resumes the workflow after a crash, so hold, send and capture or void need no hand-written state table.',
          pros: ['Retries, timers and resumption come built in.', 'A wait, such as asking the scheme for status after a timeout, is a timer, not a polling job.', "The engine's history shows every step a payment took."],
          cons: ['Another system on the money path, with its own failover.', 'Its SDK in every service that takes part.', 'Workflow code has rules of its own (it is replayed), which the team must learn.', 'For four states, more machinery than the problem needs.'],
        },
        {
          name: 'Let the ledger call the scheme', good: 'One service fewer.', cost: 'The ledger now waits on an outside network while it holds state, and learns about every rail.',
          what: 'The ledger places the hold, sends to Faster Payments, and captures or voids by itself. The Banking API only authenticates and hands over.',
          pros: ['One service fewer and one hop fewer.', 'Hold and send live in one place.'],
          cons: ['The ledger waits on an outside network while it holds payment state.', 'It learns every rail: Faster Payments, Bacs, CHAPS and the card networks.', 'A slow scheme now slows the service that every balance read depends on.'],
        },
      ],
      say: "The ledger records money. It does not talk to Faster Payments or Mastercard. The payment service owns the conversation with the scheme and the payment's state, and drives the ledger through hold, then capture or void.",
    },
    {
      id: 'fps',
      name: 'Faster Payments',
      tech: 'scheme, 24/7',
      x: 310, y: 34, w: 160, h: 56, kind: 'outside',
      what: "The UK's real-time payment scheme, open all day every day. The payment leaves the business's account and reaches the payee's bank in seconds. Card networks (Mastercard) and Bacs arrive the same way: someone outside answers later. A card authorisation is a hold; its settlement a day or two later is a capture, sometimes for a different amount or with no hold at all (a force-post). A Bacs payroll file is a balanced transaction to BACS_CLEARING_GBP. CHAPS is the high-value same-day rail.",
      why: "The scheme is outside your control. It can accept, reject or go quiet. The ledger has to represent \"we have promised this money but do not yet know the outcome\". Here that is an ACTIVE row in pending_holds, which raises the account's held_balance so the money cannot be spent twice, while the journal records only what settled.",
      built: [
        { name: "Faster Payments", what: "The UK's real-time payment scheme: the shared system UK banks use to send each other payments in seconds, all day, every day. Up to £1 million a payment at scheme level, raised from £250,000 in 2022; each bank sets its own lower limit.", why: "A business paying a supplier today wants the money there in seconds, any day. Bacs takes three working days and CHAPS is for high values in working hours." },
        { name: "A hold in pending_holds", what: "One row per hold: the account, the amount, the currency, a status (ACTIVE, then CAPTURED, VOIDED or EXPIRED) and expires_at. A trigger adds the amount to the account's held_balance when the hold is placed and takes it off when the hold ends.", why: "Entries are never updated, so \"pending\" cannot be a status on an entry. A separate table of holds keeps the journal to settled money only, and the hold's status can change exactly once, which a trigger enforces. A void posts nothing: the journal never saw the payment." },
        { name: "Card networks and Bacs, the same shape", what: "A card authorisation is a hold of the quoted amount plus an FX buffer; the settlement captures it and posts entries per currency. Bacs payroll and incoming payments post directly, with no hold.", why: "One mechanism for every rail that answers later: hold, then capture, void or expire. Only the rail's own clearing account and timings differ." },
      ],
      numbers: [
        { text: 'Up to £1 million per payment at scheme level, raised from £250,000 in 2022.', from: "Not a sum. From Pay.UK's 2022 press release, cited on the page: up to £1 million from 10 February 2022, up from £250,000." },
        { text: 'A card network expects an answer to an authorisation within a couple of seconds, so card holds cannot wait in a queue.', from: "Not a sum, and not checked against a network rulebook: the coordinator's working figure from general knowledge. The design does not depend on the exact figure, only on it being seconds, not minutes." },
      ],
      fails: 'A timeout after sending is the dangerous case: the payment may or may not have gone. Leave the hold ACTIVE, ask the scheme for the status using the same payment identifier, and only void once you know it failed. The hold of 7 days outlives any status check.',
      alternatives: [
        {
          name: 'A hold in its own table, then capture or void', chosen: true, good: 'The customer cannot spend the money twice while the scheme decides, the journal holds only settled money, and a rejection leaves nothing on the statement.', cost: 'A second table with a status that changes, and two balances on every account.',
          what: "A hold row of 120020p goes into pending_holds for Bright Bakery's wallet, and a trigger raises held_balance by 120020. Then the payment goes to Faster Payments. On acceptance one statement marks the hold CAPTURED and posts three entries; on a confirmed failure the hold is VOIDED and nothing is posted. On a timeout the hold stays ACTIVE until the status is known.",
          pros: ['Available money (posted minus held, plus any credit limit) drops at once, so nothing is spent twice.', 'ledger_entries holds settled money only: one transaction of three entries per bank payment.', 'A rejection is a void: no reversal on the statement.', 'The same mechanism serves card authorisations, which often never settle at the held amount.'],
          cons: ['pending_holds has a status that changes, so it is not append-only; a trigger allows exactly one change, from ACTIVE.', 'Two caches per account, posted and held, each kept by its own trigger.', 'Held money is in no account of the journal, so reconciliation checks holds separately.'],
        },
        {
          name: 'Pending entries through a clearing account', good: 'Every step is an ordinary balanced transaction in one append-only journal, and one balance column is enough.', cost: 'Two ledger transactions and five entries per payment, and a rejection shows as a reserve and a reverse.',
          what: "This afternoon's version of this design. A reserve moves 120020p from the wallet to a pending clearing account; a settle moves it on to the scheme and fee income; a reverse moves it back. The wallet's single balance is what can be spent.",
          pros: ['One table of record: the journal shows every step.', 'One balance column, no held total.', 'Stuck payments show as a clearing balance that does not return to zero.'],
          cons: ['Five entries and two ledger transactions per payment instead of three and one.', 'A rejection leaves a reserve and a reverse on the statement.', 'Nothing in the journal stops both a settle and a reverse for one reserve; only the payment record does.', 'A card hold that settles at a different amount, or expires, needs more entries still.'],
        },
        {
          name: 'A status column on entries', good: 'One table, and banks\' usual two figures, ledger and available.', cost: 'Entries change from pending to posted, so the journal is no longer append-only.',
          what: 'Entries are written as PENDING and later updated to POSTED or VOIDED. The balance row keeps posted and pending totals.',
          pros: ['One table for pending and settled money.', 'A rejection leaves no reversal on the statement.'],
          cons: ['Entries change after they are written, so the append-only trigger must make exceptions.', 'History can be rewritten by the same UPDATE that posts it.', 'Every reader of the journal must filter by status.'],
        },
        {
          name: 'Send first, record afterwards', good: 'Fast to build.', cost: 'A crash after sending loses the record of money that has left. Never do this.',
          what: 'The API sends to Faster Payments and writes to the ledger only once the scheme accepts. Nothing is held while the scheme decides.',
          pros: ['Fastest to build.', 'No holds at all.', 'One ledger write per payment, and only for payments that succeeded.'],
          cons: ['A crash after sending loses the record of money that has left.', 'Nothing stops two payments spending the same balance while both are in flight.', 'Never do this on a ledger.'],
        },
      ],
      say: 'Anything the ledger cannot know yet is a hold, not an entry. The hold raises held_balance before we send, and when the scheme answers it is captured into entries or voided. The journal only ever records settled money.',
    },
    {
      id: 'ledger',
      name: 'Ledger API',
      tech: 'rules, routing',
      x: 550, y: 200, w: 130, h: 56, kind: 'shared',
      what: "A stateless service in front of the ledger clusters. Its callers are the Banking API (bank payments, payroll), the card processor (authorisations and settlements) and the billing service (credit card interest). It checks that every transaction sums to zero in each currency, that each entry's currency is its account's, that amounts are whole minor units, and that accounts exist and are active. It finds the cluster from the business that owns the accounts, makes the transaction's id (a UUID), turns each logical system account such as FPS_CLEARING_GBP into one of its 16 rows by shard_id = hash(transaction_id) % 16, then sends the write to the cluster as one call to a database function: ledger_hold, ledger_capture, ledger_void or ledger_post.",
      why: 'Rules about money belong in one place. Sending each write as a single call means row locks are held only for the time the database itself needs, about 1 to 2 ms with the commit, never across a network round trip.',
      built: [
        { name: "Ledger rules", what: "Checks applied to every write: signed amounts (plus a credit, minus a debit) sum to zero per currency, no account appears twice in one transaction, every entry's currency matches its account, amounts are whole minor units, and every account exists and is active.", why: "If every team linked its own copy of the rules, one bad deploy anywhere could unbalance the books. The database checks again: the CHECK on each account, the currency test in the triggers and, optionally, a per-currency sum-to-zero trigger at commit." },
        { name: "Routing to ledger clusters", what: "A small directory table, one row per business (about a million, tens of megabytes), cached in memory, says which ledger cluster holds that business's accounts. In phase 1 there is one cluster and every row says so.", why: "Phase 2 splits businesses across clusters when one primary is no longer enough: 4 at this page's peak. Each cluster has its own set of system accounts, so a payment never leaves its cluster and stays one local transaction. Clusters are never called shards here: shard_id means something else." },
        { name: "shard_id picked by hash", what: "Each busy system account, named by rail and currency, is 16 rows with shard_id 0 to 15. The Ledger API hashes the transaction id it has just made and takes the remainder after dividing by 16. Customer wallets and credit cards are one row each, shard_id 0.", why: "Different payments land on different rows, so they rarely wait for each other's locks. The tour's capture hashed to 7, so it credits FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7." },
        { name: "One call per write", what: "Small PL/pgSQL functions on each cluster. Each sets the timeouts, inserts the idempotency key, locks the accounts in account_id order with FOR NO KEY UPDATE, does its one conditional statement, writes the outbox row and saves the result.", why: "The early exits (key already seen, not enough money, hold no longer ACTIVE) happen inside the database, so no lock waits on the network. Ten round trips of 0.5 ms would hold a hot row for 5 ms, about 200 writes a second on it at most." },
        { name: "Logical account", what: "A chart-of-accounts name such as FPS_CLEARING_GBP, stored in accounts.logical_account. One logical system account is 16 rows; a customer account has none (NULL).", why: "Callers name the logical account; the Ledger API picks the row. Reports and sweeps group by it." },
      ],
      numbers: [
        { text: 'Ledger clusters: one in phase 1, 4 at this page\'s peak in phase 2.', from: "10,000 payments a second at peak × 2 database write transactions each (the hold and the capture) = 20,000 a second. The owner's estimate for one tuned PostgreSQL cluster is about 5,000 to 8,000 a second (an estimate, not measured here). 20,000 ÷ 5,000 = 4, taking the low end. The average, 2,000 a second, fits one cluster." },
        { text: 'Locks held about 1 to 2 ms per write: in-database work plus a commit that waits for a standby.', from: "An estimate. From the lock to the commit the function does a few small inserts and updates on rows already in memory (assume well under a millisecond), then the commit waits for one synchronous standby in another zone (assume about a millisecond). Not measured." },
        { text: "TigerBeetle's sum: a lock held across two round trips of 0.5 ms blocks that row for at least 1 ms, so about 1,000 writes a second on one row at most.", from: "From TigerBeetle's 'Rediscovering transaction processing', cited on the page: 2 round trips × 0.5 ms = 1 ms with the row locked; 1 second ÷ 1 ms = 1,000 writes a second on that row, at most. Real locks are held longer, so real figures are lower." },
      ],
      fails: 'It is stateless, so losing an instance loses nothing. A bug here is the real risk: a rule that lets through an unbalanced transaction or a wrong account. The database catches some of it on its own: the CHECK refuses spending past the floor, the triggers refuse an entry in the wrong currency, and the optional deferred trigger refuses a transaction that does not sum to zero in every currency.',
      alternatives: [
        {
          name: 'One database call per write (small functions)', chosen: true, good: 'Locks are held for in-database work plus the commit, not for network round trips.', cost: 'Some logic in PL/pgSQL, which needs the same review and tests as application code.',
          what: 'The Ledger API calls ledger_hold, ledger_capture, ledger_void or ledger_post once with the key, the ids and the signed entries. The function sets the timeouts, inserts the key, locks in account_id order, runs one conditional statement and writes the outbox row, and the transaction commits.',
          pros: ['Locks last for in-database work plus the commit, about 1 to 2 ms, not for network round trips.', 'One round trip per write, so a hot row is limited by the commit, not by the network.', 'The early exits happen inside the database.', 'The balance arithmetic is not in the functions: the triggers do it, whoever writes.'],
          cons: ['Logic in SQL needs the same review and tests as application code.', 'Changing a function is a database deploy: a new version beside the old, then switch callers.', 'Harder to debug and profile than service code.'],
        },
        {
          name: 'Interactive transaction from the service', good: 'All logic in one language, easy to read.', cost: "Each statement is a round trip while locks are held. TigerBeetle's authors saw this cap a central bank switch however much hardware was added.",
          what: 'The service opens a transaction and sends each statement in turn: insert the key, lock the accounts, insert the hold or the entries, insert the outbox row, save the result, commit. The triggers still keep the balances; only the round trips change.',
          pros: ['All logic in one language, easy to read and test.', 'Ordinary driver and ORM tooling.', 'Fine at low load, where locks are rarely contended.'],
          cons: ['Four or five round trips while locks are held.', 'Ten round trips of 0.5 ms hold a row for 5 ms: about 200 writes a second on it, at most.', 'A 50 ms lock_timeout is used up faster by every waiter.'],
        },
        {
          name: 'A ledger library inside each service', good: 'No extra hop.', cost: 'Every team re-implements the rules, and one bad deploy anywhere can unbalance the books.',
          what: 'Each service that moves money links a shared ledger library and writes to the ledger database itself. There is no Ledger API in between.',
          pros: ['No extra network hop.', 'One fewer service to run and scale.', 'The triggers and the CHECK still protect the balances, whoever writes.'],
          cons: ['Every team runs its own copy of the rules, at its own version.', 'One bad deploy anywhere can post to the wrong account, which no trigger can tell.', 'Every such service needs write access to every cluster, and the directory.'],
        },
      ],
      say: 'The ledger API refuses anything that does not balance in each currency, picks the cluster and the system account row, and sends each write to the database as one call so that locks never wait on the network.',
      see: [{ id: 'partitioning', label: 'Partitioning' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'db',
      name: 'Ledger DB',
      tech: 'Postgres primary',
      x: 795, y: 200, w: 190, h: 118, kind: 'node',
      lines: ['entries: append-only', 'holds: pending_holds', 'posted, held balances'],
      what: "The source of truth, one per ledger cluster. ledger_entries holds settled movements only: one row per debit or credit, a signed amount in minor units with its currency, and is only ever inserted. Each transaction is two or more entries that sum to zero in each currency. pending_holds holds money promised but not settled: one row per hold, ACTIVE until it is CAPTURED, VOIDED or EXPIRED. accounts holds one row per account and currency with two caches, posted_balance (the sum of its entries) and held_balance (the sum of its ACTIVE holds), plus credit_limit. Triggers keep both caches in the same transaction, a guard refuses any other change to them, and a CHECK keeps available money, posted minus held, at or above minus the credit limit. Idempotency keys and an outbox row are written in the same transaction too.",
      why: "Writing the hold or the entries, both balances, the key and the event in one local transaction is what makes the balance strictly consistent: a reader never sees entries without their balance change, and a retry never posts twice. Keeping the caches with triggers means no code path can forget them and nobody can edit them by hand. The CHECK refuses an overdraft, or spending past a card's limit, whatever code path writes.",
      built: [
        { name: "PostgreSQL", what: "An open-source relational database: tables, SQL, transactions that commit all or nothing, row locks, triggers and constraints.", why: "The team knows it, and the owner's phases keep it as the ledger until hot accounts dominate. In phase 3 it stays for account metadata, KYC, billing statements, search and reporting." },
        { name: "Primary", what: "The one copy of each cluster's database that accepts writes. Funds checks and balance reads also go to it.", why: "Only the primary is always current, and a balance is used to decide whether money can be spent. Its two synchronous standbys make sure losing it loses nothing." },
        { name: "ledger_entries, append-only", what: "One row per entry: entry_id, transaction_id, account_id, amount (BIGINT minor units, plus a credit, minus a debit, never zero), currency and created_at. A BEFORE UPDATE OR DELETE trigger raises an error. UNIQUE (transaction_id, account_id) stops a transaction posting twice to one account.", why: "Corrections become new transactions, so the history shows both the mistake and the fix. The trigger does not stop TRUNCATE or DROP TABLE, so the ledger's role is granted INSERT and SELECT only, and archiving runs as a separate role." },
        { name: "pending_holds", what: "One row per hold: hold_id (made once per request, so a retry has the same id), account_id, amount (above zero), currency, status and expires_at. A trigger allows one change only: from ACTIVE to CAPTURED, VOIDED or EXPIRED, with nothing else altered. A hold cannot be deleted. In this design it is partitioned by month like the journal, and old months are dropped.", why: "The owner's choice for money in flight. The hold_id primary key is the hold's own idempotency guard. A partial index on expires_at WHERE status = 'ACTIVE' (this design's addition) lets the expiry job find due holds without reading ended ones." },
        { name: "accounts, the balance cache", what: "One row per account and currency: logical_account, shard_id, account_type (USER_WALLET, CREDIT_CARD, CLEARING, FX_POOL, REVENUE), allow_negative, posted_balance, held_balance, credit_limit, currency, is_active. Created WITH (fillfactor = 80).", why: "A funds check reads one row. In PostgreSQL an UPDATE writes a new version of the row; if it fits on the same page and no indexed column changed, it is a HOT (heap-only tuple) update and no index is touched. The balances are not indexed, and the free fifth of each page makes room likely." },
        { name: "The triggers", what: "ledger_entries_apply (AFTER INSERT on entries) adds the amount to posted_balance. pending_holds_placed (AFTER INSERT on holds) adds to held_balance; pending_holds_ended (BEFORE UPDATE OR DELETE) takes it off. Both refuse a row whose currency is not the account's, or a closed account. accounts_guard (BEFORE UPDATE) refuses a change to either balance at pg_trigger_depth() <= 1.", why: "A direct UPDATE fires the guard at depth 1 and is refused; a trigger's own UPDATE fires it at depth 2 and passes. Other columns, credit_limit and is_active among them, can still be changed. The test sits inside the guard's function: in a WHEN clause a direct statement is at depth 0." },
        { name: "CHECK valid_available_funds", what: "CHECK (allow_negative OR (posted_balance - held_balance) >= -credit_limit), and CHECK (held_balance >= 0). A debit wallet has credit_limit 0, so its floor is zero; an arranged overdraft or a credit card has a limit, so its floor is minus the limit.", why: "However a balance is written, a customer account cannot pass its floor: the statement fails with SQLSTATE 23514 and the transaction rolls back. The conditional insert is the clean 'insufficient funds' path; the CHECK is the backstop. System accounts have allow_negative TRUE, so for them the CHECK protects nothing and limits are reconciliation's job." },
        { name: "Per-currency sum to zero at commit (optional)", what: "ledger_entries_balanced: a constraint trigger, DEFERRABLE INITIALLY DEFERRED, that runs at COMMIT for each inserted entry and raises an error if any currency in that entry's transaction does not sum to zero.", why: "This design's addition, a backstop to the Ledger API's rule. A transaction of -100 GBP and +100 USD nets to zero as numbers and is refused. It costs one small query per entry at commit, using the unique index on (transaction_id, account_id)." },
        { name: "Idempotency keys and outbox", what: "idempotency_keys: one row per key, inserted first in the same transaction, with the saved result. outbox: the event for other services, written in the same transaction.", why: "A key exists if and only if the write committed, so a retry returns the saved result; kept 72 hours, about 80 GB across all clusters. It is also the guard that holds across date partitions. The outbox row means the event exists if and only if the money moved." },
        { name: "Column grants on accounts", what: "The ledger's role may INSERT accounts and UPDATE only through the triggers; only the credit service's role may UPDATE credit_limit, allow_negative and is_active.", why: "The guard covers posted_balance and held_balance only. Anyone with UPDATE on accounts could otherwise raise a card's limit or switch off its floor, so PostgreSQL column-level grants are the control. Lowering a limit below what is already used is refused by the CHECK (checked)." },
        { name: "Timeouts and PgBouncer", what: "Every write transaction starts with SET LOCAL lock_timeout = '50ms' and SET LOCAL statement_timeout = '250ms'. Connections reach PostgreSQL through PgBouncer in transaction pooling mode.", why: "A writer that cannot get a lock in 50 ms gives up and frees its connection, instead of joining a queue that grows without end. SET LOCAL lasts only to the end of the transaction, which is what transaction pooling needs: the server connection goes back to the pool at COMMIT and the next client must not inherit the setting." },
      ],
      numbers: [
        { text: 'About 80 GB a day across all clusters at 1,000 payments a second: about 65 GB of entries and 13 GB of holds.', from: "Entries: 1,000 payments a second × 3 entries each (wallet, scheme clearing, fee) = 3,000 a second × 86,400 seconds = about 260 million a day × 250 bytes = about 65 GB. Holds: 1,000 a second × 86,400 = 86 million a day × 150 bytes = about 13 GB. 250 and 150 bytes are assumptions: rows of about 90 bytes with their indexes. A card payment with FX has 5 entries, so a card-heavy mix is more." },
        { text: 'Assume 13 months of entries and 3 months of holds kept hot: about 27 TB in all, about 7 TB a cluster with 4 clusters.', from: "Entries: 65 GB a day × about 395 days (13 months) = about 26 TB. Holds: 13 GB a day × about 92 days (3 months) = about 1.2 TB. Together about 27 TB ÷ 4 clusters = about 6.8 TB each. 13 months (statements, claims windows) and 3 months (disputes, support) are this design's assumptions. Holds are partitioned by month and dropped after export; at this load that is about 86 million rows a day, 2.6 billion a month." },
        { text: 'The accounts table: under 300 MB across all clusters, always in memory.', from: "1 million businesses with a GBP wallet, plus an assumed 20 per cent with a second currency and 10 per cent with a credit card = 1.3 million rows, plus a few hundred system rows (about 30 logical accounts × 16). × about 130 bytes a row (assumption) = about 170 MB; fillfactor 80 makes it about 210 MB; plus about 60 MB for the primary key and the (logical_account, shard_id) index." },
        { text: 'Five trigger UPDATEs per bank payment: about 5,000 a second on average, 50,000 at peak, 12,500 a cluster.', from: "Per payment: 1 when the hold is placed (held_balance up), 1 when it is captured (held_balance down), 3 for the three entries (posted_balance). 5 × 1,000 = 5,000 a second; 5 × 10,000 = 50,000 at peak; ÷ 4 clusters = 12,500. Each is on a row the transaction already holds locked, and is HOT when the page has room." },
        { text: 'The partial index on ACTIVE holds stays small: about 2 GB, against a table that gains 86 million rows a day.', from: "Bank payment holds last seconds. Assume 300 card authorisations a second held about 2 days before capture: 300 × 172,800 = about 52 million ACTIVE holds. × about 30 bytes an index entry (assumption) = about 1.6 GB." },
      ],
      fails: 'The primary dies. A synchronous standby already holds every committed transaction, so it is promoted with nothing lost. Writes to that cluster pause for the failover, and clients retry with the same keys.',
      alternatives: [
        {
          name: 'Trigger-kept posted and held, locks in id order, conditional insert', chosen: true, good: 'The database itself refuses a wrong balance whatever code path writes: nobody can forget the update or edit a balance by hand, and the CHECK refuses spending past the floor.', cost: 'Up to five extra UPDATEs per payment, and logic in the database where application developers may not look.',
          what: "Lock the accounts with SELECT ... FOR NO KEY UPDATE in account_id order. Then one statement inserts the hold only if posted - held - amount >= -credit_limit, or captures the hold and inserts the entries together. Each inserted entry or hold, and each ended hold, fires a trigger that moves its account's cache; the CHECK on accounts is the backstop.",
          pros: ['No code path can forget to move a balance, or move one by hand: the guard refuses a direct edit.', 'The CHECK refuses spending past the floor even from a path that skips the pre-check.', 'Locks taken in one order everywhere, so two opposite transfers cannot deadlock.', 'Readers never wait: a plain SELECT reads its own snapshot.'],
          cons: ['One extra UPDATE per entry and per hold change, inside the same transaction.', 'Logic in triggers, where application developers may not look.', 'A bulk load fires the triggers row by row.', 'A superuser can still bypass triggers (session_replication_role = replica), so that role stays out of reach.'],
        },
        {
          name: 'One balance, pending money through a clearing account', good: 'One cache column and one trigger.', cost: 'Two ledger transactions per payment, and no separate held figure.',
          what: "This afternoon's version. accounts has a single balance kept by the entry trigger. A payment is reserved into a pending clearing account and later settled or reversed, each a balanced transaction.",
          pros: ['One cache to keep and check.', 'Everything is in the journal.'],
          cons: ['Five entries per payment instead of three.', 'No posted and available pair, which card and credit products need.', 'A card hold that settles for less, or expires, needs extra transactions.'],
        },
        {
          name: 'Conditional update of the balance row in the same transaction', good: 'UPDATE ... SET balance = balance - x WHERE id = a AND balance >= x. One statement checks and writes; under Read Committed a second writer waits, then re-checks the condition.', cost: 'Every code path that inserts entries must remember the matching UPDATE, and a balance can be edited by hand.',
          what: "The original version of this design. A function updates the balance row with the check in the WHERE clause, then inserts the entries, in the same transaction. If no row matches, the money is not there.",
          pros: ['Check and write are one statement, so no writer can slip between them.', 'Under Read Committed, Postgres waits for a concurrent writer, then re-checks the condition.', 'No triggers: everything the write does is in one place.'],
          cons: ['The balance is right only if every code path does the UPDATE as well as the insert.', 'Nothing stops someone editing a balance directly.', 'Overdraft is refused by a WHERE clause, not by the database.'],
        },
        {
          name: 'Lock with FOR UPDATE instead of FOR NO KEY UPDATE', good: 'The same exclusion between writers of one account. The difference here is small.', cost: 'A stronger lock than needed: it also blocks foreign key checks (FOR KEY SHARE) from tables that only reference accounts.',
          what: 'Read the account rows with SELECT ... FOR UPDATE, check, then write. A foreign key check, such as inserting a hold that references the account, takes FOR KEY SHARE on the account row; FOR UPDATE conflicts with that, FOR NO KEY UPDATE does not.',
          pros: ['The lock most people know.', 'Correct: writers to one account still go one at a time.'],
          cons: ['Blocks foreign key checks from tables that only reference accounts.', "Another writer to the same account waits either way, because the trigger's UPDATE needs the row lock, so the gain from the weaker lock is small."],
        },
        {
          name: 'Optimistic: a version column on the account row', good: 'Readers never block. A write says "only if the version is still 41" and fails if it moved. Modern Treasury exposes this as lock_version.', cost: 'Under contention most attempts fail and retry, so it is worst exactly where load is highest.',
          what: 'Read the account row and its version, say 41, without locking. Write only if the version is still 41; if it moved, read again and retry.',
          pros: ['No lock held between the read and the write.', 'Lets an API client say "only if nothing changed since I looked".', 'Readers never block (true of the chosen design too).'],
          cons: ['Under contention most attempts fail and retry.', 'Worst exactly where load is highest: the hot accounts at peak.', 'Retry loops eat into the 50 ms target.'],
        },
        {
          name: 'Serializable isolation', good: 'The database finds every anomaly for you.', cost: 'Transactions abort with serialization failures (40001) and must be retried. Retry storms on busy accounts.',
          what: 'Run every ledger transaction at Serializable isolation and let Postgres abort any that could not have happened in some one-at-a-time order.',
          pros: ['The database finds every anomaly for you.', 'Simple code: read, check, write.', 'Also guards rules nobody thought to write a condition for.'],
          cons: ['Transactions abort with serialization failures (40001) and must be retried.', 'Retry storms on busy accounts.', 'Postgres must track what each transaction read, which costs memory and CPU.'],
        },
        {
          name: 'No cache: sum the entries and holds on every read', good: 'Nothing to keep in step.', cost: 'A funds check gets slower as history grows, and there is still a row to lock.',
          what: 'Store only ledger_entries and pending_holds. Posted is SUM(amount) of entries, held is SUM(amount) of ACTIVE holds, worked out on each check.',
          pros: ['No triggers, no second copy of the truth.', 'Nothing to reconcile between cache and journal.'],
          cons: ['A busy account has hundreds of thousands of entries a year to add up on every check.', 'Archiving old months changes the sum unless a snapshot is kept, which is a cache again.', 'Still needs a lock to stop two payments spending the same money.'],
        },
        {
          name: 'TigerBeetle', good: 'Double-entry, balance limits and pending transfers are built in, applied in large batches on one thread.', cost: 'A specialised database with no shared transaction with PostgreSQL.',
          what: 'A database built for double-entry: accounts and transfers, with balance limits and two-phase (pending, then post or void) transfers. The owner\'s phase 3 moves the hot debit and credit path here and keeps PostgreSQL beside it.',
          pros: ['Batches of up to 8,190 transfers in one round trip.', 'No row locks, so hot accounts stop being a special case.', 'Consensus replication paid once per batch.'],
          cons: ['A specialised database with its own operations.', 'No transaction spans it and PostgreSQL, so the application orders its writes.', 'At this page\'s load, PostgreSQL with split system accounts copes.'],
        },
      ],
      say: "The journal holds settled money and never changes. Holds live in their own table. posted_balance and held_balance are caches kept by triggers in the same transaction, and a CHECK keeps posted minus held at or above minus the credit limit, so one schema serves debit wallets, overdrafts and credit cards.",
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
      what: 'Two standbys in other availability zones receive the write-ahead log as each transaction commits; the primary waits for at least one of them to confirm. Further asynchronous replicas serve statements, history, billing statement runs and exports.',
      why: 'A ledger cannot lose an acknowledged payment or an acknowledged hold. Synchronous replication means a commit is on two machines before anyone is told, so losing the primary loses nothing (a recovery point of zero).',
      built: [
        { name: "Two synchronous standbys", what: "Full copies of the cluster's database on other machines that receive its write-ahead log; the primary waits for at least one of them to confirm before a commit returns. Postgres: synchronous_standby_names = 'ANY 1 (s1, s2)'.", why: "Recovery point zero. Waiting for one of two, not both, means losing one standby does not stop writes. The price is assumed to be about a millisecond more per commit." },
        { name: "Write-ahead log (WAL) streaming", what: "Postgres writes every change first to an append-only log and then to its tables. Standbys stay in step by receiving that log as it is written.", why: "It is how stock Postgres replicates, so there is no new database to run." },
        { name: "Availability zones", what: "Separate data centres in the same cloud region, each with its own power and network.", why: "Standbys in other zones survive the loss of the primary's zone. They do not cover the loss of a whole region, which the design names as a trade-off." },
        { name: "Asynchronous read replicas", what: "Further read-only copies that receive the log without the primary waiting for them. They trail by milliseconds, or seconds under heavy load.", why: "Statements, history, billing and exports read from them, so that load stays off the primary. Funds checks never do, because a copy that trails could show money already spent." },
      ],
      numbers: [
        { text: 'Postgres: synchronous_standby_names = ANY 1 (s1, s2), a quorum of one in two.', from: 'Not a sum. The setting is from the PostgreSQL replication docs, cited on the page: ANY 1 (s1, s2) waits for at least one of the two listed standbys.' },
        { text: 'Read replicas lag by milliseconds to seconds: fine for a statement, never for a funds check.', from: 'An assumption, not a measurement: asynchronous replicas usually trail by milliseconds and fall seconds behind under heavy writes or long queries. The rule that funds checks read the primary does not depend on the exact figure.' },
      ],
      fails: 'If both synchronous standbys are lost, commits wait. Decide in advance: stop writes on that cluster (our choice) rather than quietly fall back to asynchronous replication and risk losing payments.',
      alternatives: [
        {
          name: 'Synchronous quorum standbys plus async read replicas', chosen: true, good: 'No loss on failover, and reads that tolerate lag are taken off the primary.', cost: 'Every commit waits for a round trip to another zone: assume about a millisecond more.',
          what: "Each cluster's primary streams its log to two standbys in other zones and waits for either one to confirm before the commit returns. Further asynchronous replicas serve statements, history and exports.",
          pros: ['No acknowledged payment lost on failover: recovery point zero.', 'A quorum of one in two, so losing one standby does not stop writes.', 'Statements and exports are read off the primary.', 'Stock Postgres, no new database.'],
          cons: ['Every commit waits for a round trip to another zone: assume about a millisecond more.', "That millisecond is also added to every hot row's lock time.", 'If both standbys are lost, commits wait; this design stops writes on that cluster.', 'Promotion needs a failover tool beside Postgres.'],
        },
        {
          name: 'Consensus replication (Raft, Viewstamped Replication)', good: "Failover is part of the protocol, not an operator's job. TigerBeetle and distributed SQL databases work this way.", cost: 'Three or more voters, and a database built around it.',
          what: 'Three or more replicas agree on each log record, and elect a new leader themselves when one dies. TigerBeetle uses Viewstamped Replication.',
          pros: ["Failover is part of the protocol, not an operator's or a tool's job.", 'A wrong promotion cannot leave two primaries taking writes.', 'The same recovery point of zero.'],
          cons: ['Three or more voters per cluster.', 'A database built around it, so not stock Postgres.', 'A commit still waits for a majority, so the cross-zone round trip stays.'],
        },
        {
          name: 'Asynchronous replication only', good: 'Lowest latency.', cost: 'A failover can lose the last few seconds of payments. Not acceptable for a ledger.',
          what: "The primary commits on its own disk and streams the log afterwards. A failover promotes whichever standby is furthest ahead.",
          pros: ['Lowest commit latency: no cross-zone wait.', 'A slow standby never slows payments.', 'Simplest to run.'],
          cons: ['A failover can lose the last few seconds of payments and holds.', 'Those were acknowledged to customers, which is the one thing a ledger must not lose.', 'Not acceptable here.'],
        },
      ],
      say: 'Recovery point zero: a hold or a payment is acknowledged only once it is on two machines in two zones. Reads that can be a little stale go to replicas; funds checks never do.',
      see: [{ id: 'leader-replication', label: 'Leader replication' }, { id: 'quorum', label: 'Quorum' }, { id: 'raft', label: 'Raft' }],
    },
    {
      id: 'sweeper',
      name: 'Sweeper',
      tech: 'sweeps, expiry',
      x: 1042, y: 190, w: 124, h: 56, kind: 'node',
      what: "Looks after the system accounts that most payments touch, and the holds nobody ended. System accounts are named by rail and currency (FPS_CLEARING_GBP, STRIPE_CLEARING_GBP, MASTERCARD_DEBIT_CLEARING_GBP, MASTERCARD_CREDIT_CLEARING_GBP, FX_POOL_GBP, FEE_REVENUE_GBP, INTEREST_INCOME_GBP and so on), and each is 16 rows, shard_id 0 to 15, with allow_negative TRUE. At the end of each day the Sweeper moves each logical account's 16 rows into its master account with one balanced transaction. Every minute it also marks as EXPIRED any ACTIVE hold whose expires_at has passed, which gives the money back to the customer.",
      why: "Every entry fires the trigger's UPDATE on its account row, and that row stays locked until a synchronously replicated commit, so one row takes one writer at a time: roughly 500 to 1,000 writes a second (an estimate). One cluster at the peak takes about 2,500 payments a second, so a single FPS_CLEARING_GBP row would be past its limit. Holds are the other loose end: a card authorisation the merchant never settles would otherwise keep the customer's money held for ever.",
      built: [
        { name: "Hot accounts", what: "System accounts that nearly every payment of one rail and currency touches: the scheme clearing account, the card network clearing accounts, the FX pools, fee and interest revenue.", why: "One row takes one writer at a time, about 500 to 1,000 writes a second (an estimate). Customer wallets and cards are touched only by their own payments, so they stay one row each." },
        { name: "16 rows by shard_id", what: "Each logical system account is 16 rows with shard_id 0 to 15; uq_logical_shard makes the pair (logical_account, shard_id) unique. The Ledger API writes to shard_id = hash(transaction_id) % 16.", why: "At 2,500 payments a second on one cluster, about 156 writes a second land on each row, well under one row's estimated limit. If lock waits climb, 16 can go to 32 with nothing else changing." },
        { name: "End-of-day sweep", what: "Once a day, per logical account, one balanced transaction locks the master (its own logical account, such as FEE_REVENUE_GBP_MASTER) and the 16 rows in account_id order, debits each row by its posted balance and credits the master with the total. Its key is the account and the date.", why: "The owner's choice. Every entry stays synchronous and every balance exact as a sum, so the sweep is bookkeeping, not a safety need: the rows may go negative anyway. Reports sum the master and its rows. A rerun of the same date does nothing." },
        { name: "Hold expiry job", what: "Every minute: UPDATE pending_holds SET status = 'EXPIRED' for ACTIVE holds whose expires_at has passed, in batches, through the partial index. The hold trigger takes each amount off held_balance.", why: "A card hold the merchant never settles gives the money back after its expiry. An expired hold cannot then be captured: a late settlement must post as a force-post." },
      ],
      numbers: [
        { text: 'One cluster at peak: about 156 writes a second on each row of a split system account.', from: "10,000 payments a second at peak ÷ 4 clusters = 2,500 a cluster. A bank payment writes FPS_CLEARING_GBP once and FEE_REVENUE_GBP once, at the capture; the hold touches no system account. Worst case, every payment uses the same rail: 2,500 ÷ 16 rows = about 156 writes a second on a row, against 500 to 1,000 estimated for one row. Unsplit, the row would take 2,500." },
        { text: "A master account is up to a day behind; the sum of master plus its 16 rows is always exact.", from: 'The sweep runs once a day, so the master misses up to a day of entries. The sum is exact because every entry is written synchronously, in its own transaction, to one of the 16 rows.' },
        { text: 'The sweep is small: a few dozen transactions a day per cluster, each of 17 entries at most.', from: "About 30 logical system accounts (assumption) × 1 sweep a day = 30 transactions. Each debits up to 16 rows and credits the master once: 17 entries." },
      ],
      fails: 'If the sweep stops, nothing is wrong, only untidy: balances sit in the 16 rows, and reports read the master plus its rows. If the expiry job stops, held money is not released, and customers see less available than they should: an alert on the oldest overdue ACTIVE hold catches it.',
      alternatives: [
        {
          name: '16 rows by shard_id, swept at end of day', chosen: true, good: 'Spreads the writes, keeps every entry synchronous and every balance exact, and sweeps once a day.', cost: 'Reports must sum 17 rows per logical account, and masters lag by up to a day.',
          what: "Each system account, named by rail and currency, is 16 rows with allow_negative TRUE. A write picks one by hash(transaction_id) % 16: the tour's capture hashed to 7. At the end of the day one balanced transaction per logical account moves each row's total into its master.",
          pros: ['Spreads about 2,500 writes a second a cluster to about 156 a row.', 'Every entry stays synchronous and every balance exact as a sum.', 'Ordinary ledger transactions: no new system.', 'Going from 16 to 32 rows changes nothing else.'],
          cons: ['Reports must sum the master and its rows, in every cluster.', 'The split count is a tuning knob to watch.', 'allow_negative TRUE means no row can enforce a limit; reconciliation watches them.'],
        },
        {
          name: 'Continuous sweeps (every minute)', good: 'Masters are never more than a minute behind.', cost: '1,440 sweeps a day per account, each one more writer on the hot rows.',
          what: "This afternoon's version of this design: a sweep per account every minute, keyed by account and minute.",
          pros: ['Masters close to the total at any moment.', 'Smaller amounts per sweep.'],
          cons: ['1,440 transactions a day per account instead of one.', 'Each sweep locks all 16 rows, briefly blocking payments on them.', 'Buys nothing a report summing 17 rows does not already give.'],
        },
        {
          name: 'No balance kept on revenue accounts, computed later', good: 'Credit-only accounts take no lock at all. Modern Treasury routes hot accounts down an asynchronous path this way.', cost: 'Its balance lags (Modern Treasury applies such entries within 60 seconds), and the trigger must make an exception.',
          what: 'The posted trigger skips accounts marked as rolled up, so a fee entry takes no row lock. A job adds their entries into the balance later.',
          pros: ['No hot row at all: appends never wait on each other.', 'Simpler than split rows for credit-only accounts.', 'Used in production by Modern Treasury.'],
          cons: ['Its balance lags.', "'posted_balance equals the sum of entries' now holds only after the roll-up.", 'Clearing accounts and FX pools are debited too, so they still need another answer.'],
        },
        {
          name: 'A database built for it (TigerBeetle)', good: 'Applies thousands of transfers to one account per batch on a single thread with no row locks.', cost: 'A new database to adopt and run, with no shared transaction with PostgreSQL.',
          what: "The owner's phase 3: move the hot debit and credit path to TigerBeetle, where a hot account is just an account.",
          pros: ['Thousands of transfers to one account per batch, with no row locks.', 'No split rows or sweeps for reports to know about.'],
          cons: ['A new database to adopt and run.', 'Account metadata, KYC and billing stay in PostgreSQL beside it.', 'A big move; this design waits until hot accounts dominate.'],
        },
      ],
      say: 'Hot accounts are the classic trap. Every entry locks its account row through the trigger, so I name system accounts by rail and currency, split each into 16 rows by shard_id with allow_negative TRUE, and sweep them into masters at the end of the day.',
      see: [{ id: 'consistent-hashing', label: 'Consistent hash ring' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'relay',
      name: 'CDC relay',
      tech: 'Debezium',
      x: 1042, y: 350, w: 124, h: 56, kind: 'node',
      what: "Reads committed outbox rows from the database's write-ahead log through a replication slot, and publishes each as an event on the ledger-events topic, keyed by account.",
      why: 'Writing to the database and then to Kafka is two writes with no transaction around them: a crash between them loses an event or announces a payment that rolled back. The outbox row commits with the hold or the entries, and the relay publishes only what committed, in commit order. This is the owner\'s rule: outbox, not two-phase commit.',
      built: [
        { name: "Change data capture (CDC)", what: "Reading committed changes from a database's own log, in commit order, and turning each into an event.", why: "Polling the outbox table instead can miss or reorder rows from concurrent commits, and adds queries to the primary." },
        { name: "Debezium", what: "An open-source change data capture tool. It connects to a database's change log and emits every committed row change as an event, with the row before and after and its log position. It is commonly run alongside Kafka.", why: "It already does the hard parts: reading Postgres's log through logical decoding, keeping its place in a replication slot, and resuming after a restart. The cost is a connector to run and upgrade." },
        { name: "Logical decoding and a replication slot", what: "Logical decoding is Postgres turning its write-ahead log back into row changes for an outside reader. A replication slot is the bookmark for one reader: it records how far it has read and keeps the log until then.", why: "Only committed rows arrive, in commit order, and a restarted relay resumes where it left off, repeating at most a little. The catch: a stuck relay makes the slot hold log on the primary's disk, so the slot is watched." },
      ],
      numbers: [
        { text: 'About 3,000 events a second on average; assume about 1 KB each: about 3 MB a second, 30 MB at peak.', from: "Three events per bank payment: hold.placed (from the hold), hold.ended and transaction.posted (both from the capture). 1,000 payments a second × 3 = 3,000 events a second × an assumed 1 KB = about 3 MB a second. At the 10,000 a second peak, 30,000 events and about 30 MB a second. A void emits only hold.ended, so a rejected payment makes two." },
      ],
      fails: "If the relay or Kafka is down, the ledger carries on and events wait in the log. Watch the replication slot: it holds write-ahead log on the primary's disk until the relay catches up.",
      alternatives: [
        {
          name: 'Outbox table read by log-based CDC', chosen: true, good: 'Atomic with the money, in commit order, no polling load.', cost: 'A connector to run, and a replication slot to watch.',
          what: 'Each ledger function writes an outbox row in the same transaction as the hold or the entries. Debezium reads committed rows from the write-ahead log through a replication slot and publishes them to ledger-events in commit order.',
          pros: ['The event exists if and only if the write committed.', 'In commit order, straight from the log.', 'No polling queries on the primary.', 'If Kafka is down, the ledger carries on and events wait.'],
          cons: ['A connector to run and upgrade.', "The slot holds log on the primary's disk until read.", 'At least once: a restart can repeat events, so consumers drop repeats.', 'Published outbox rows need clearing out.'],
        },
        {
          name: 'Polling the outbox table', good: 'Simple: a worker selects new rows and marks them sent.', cost: 'Concurrent commits can be missed or reordered, and polling adds load.',
          what: 'A worker selects outbox rows not yet sent, publishes them, and marks them sent. No connector and no replication slot.',
          pros: ['Simple: a query and an update.', 'Works on any database, with no access to its log.'],
          cons: ['Concurrent commits can be missed or reordered: a row given an earlier id can commit later.', 'Polling adds load to the primary that also takes payments.', 'Marking rows sent is another write per event.'],
        },
        {
          name: 'Two-phase commit between the database and Kafka', good: 'One atomic commit across both.', cost: 'Locks held across the network, and a lost coordinator leaves both sides waiting.',
          what: 'A coordinator asks PostgreSQL and the broker to prepare, then to commit. The owner rules it out in favour of the outbox.',
          pros: ['The event and the money commit together by protocol.'],
          cons: ['Row locks are held while the coordinator waits on the network.', 'A lost coordinator leaves prepared transactions holding locks.', 'Few brokers take part in it at all.'],
        },
        {
          name: 'Publish to Kafka after commit (dual write)', good: 'No extra parts.', cost: 'Lost or phantom events on every crash. Never on a money path.',
          what: 'The service commits to Postgres and then publishes to Kafka itself. No outbox and no connector.',
          pros: ['No extra parts.', 'The shortest delay from commit to event.'],
          cons: ['A crash between the two writes loses the event.', 'Publishing before the commit announces payments that rolled back.', 'Never on a money path.'],
        },
      ],
      say: 'Never dual-write, and no two-phase commit. The event is a row in the same transaction as the money, and change data capture carries it out.',
      see: [{ id: 'append-log', label: 'Append-only log' }, { id: 'outbox', label: 'Transactional outbox' }],
    },
    {
      id: 'kafka',
      name: 'ledger-events',
      tech: 'Kafka, by account',
      x: 1195, y: 475, w: 150, h: 64, kind: 'queue',
      what: "One event per committed ledger write: hold.placed, hold.ended (captured, voided or expired) and transaction.posted, with ids, accounts, signed amounts per currency, the payment reference, any FX rate used and the database log position. Keyed by account so each account's events stay in order.",
      why: 'Notifications, fraud, billing, analytics and reconciliation all need to know what happened. A log lets each read at its own pace and replay, without querying the ledger. The same Kafka (or SQS in front of the Ledger API) also absorbs spikes: payroll runs and payouts are queued and fed to the ledger at the rate it can take.',
      built: [
        { name: "Kafka", what: "A distributed log service. Producers append messages to a topic, split into partitions; each reader keeps its own position and can re-read from any point the topic still keeps.", why: "Each consumer reads at its own pace and can replay after a bug. A queue such as SQS deletes each message once read, so no replay. About 3 MB a second on average is a light load for it." },
        { name: "ledger-events", what: "The one topic the ledger publishes to, with hold and transaction events together.", why: "One topic, not one per event type, so a capture is never read before the hold it ends." },
        { name: "Keyed by account", what: "Each event's key is the account id. Kafka sends every message with the same key to the same partition and keeps a partition in order.", why: "All of one account's events arrive in commit order, which is all consumers need. A partition holding a busy account can lag behind the others." },
        { name: "Queues as shock absorbers", what: "Work that can wait (payroll lines, payouts, billing's nightly interest) goes onto a queue, and a worker feeds it to the Ledger API at a steady rate.", why: "The owner's rule for a spike: the database takes what it can within its timeouts and the queue holds the rest, instead of thousands of writers timing out together. Card authorisations cannot queue; they need an answer in seconds." },
      ],
      fails: 'Delivery is at least once. A relay restart can publish an event twice, so consumers drop anything at or below the last log position they processed for that account.',
      alternatives: [
        {
          name: 'Kafka topic keyed by account', chosen: true, good: 'Ordered per account, replayable, many readers.', cost: 'Partitions and consumer lag to watch.',
          what: "One topic, ledger-events, keyed by account, so each account's events land in one partition and keep their order. Notifications, fraud, billing, the warehouse and reconciliation each read it as their own consumer group.",
          pros: ['Ordered per account.', 'Replayable: a consumer that falls a day behind catches up from the log.', 'Many readers, each at its own pace.', 'About 3 MB a second on average is a light load for Kafka.'],
          cons: ['Partitions and consumer lag to watch.', 'At least once: consumers must drop repeats by log position.', 'A Kafka cluster to run, or to pay someone to run.'],
        },
        {
          name: 'A managed queue (SQS)', good: 'Nothing to run, and good as the shock absorber in front of the ledger.', cost: 'Each message is read once and gone. No replay, and ordering only with FIFO queues.',
          what: 'Each event goes to a managed queue. A consumer takes a message, handles it and deletes it. The owner names SQS as an option for absorbing spikes.',
          pros: ['Nothing to run.', 'No partitions to plan.', 'With FIFO queues, order can be kept per account.'],
          cons: ['Each message is read once and gone: no replay after a consumer bug.', 'Several readers need a queue each, fed by a fan-out.', 'Ordering only with FIFO queues.'],
        },
        {
          name: 'Consumers read the replicas', good: 'No log at all.', cost: "The ledger's schema becomes everyone's interface, and their queries compete with statements.",
          what: 'No log at all. Each downstream service queries an asynchronous replica for what changed since it last looked.',
          pros: ['No log to run.', 'Consumers see the full record, not only what an event carries.'],
          cons: ["The ledger's schema becomes everyone's interface, so it can no longer change freely.", 'Their queries compete with statements on the replicas.', 'Every consumer polls, so a notification waits for the next poll.'],
        },
      ],
      say: 'The topic is how the ledger tells the rest of the bank, and queues are how bursts wait their turn. Neither is how money moves.',
      see: [{ id: 'append-log', label: 'Append-only log' }, { id: 'queue', label: 'Queue' }],
    },
    {
      id: 'consumers',
      name: 'Consumers',
      tech: 'notify, fraud, BI',
      x: 900, y: 475, w: 150, h: 64, kind: 'shared',
      what: 'The services that react to money moving: push notifications, fraud models, the credit card billing service, accounting exports and the data warehouse.',
      why: 'They must never slow a payment down. They read events at their own pace, and a slow one builds lag, not latency.',
      built: [
        { name: "Notifications", what: "The service that sends the owner a push such as \"£1,200.00 paid, reference INV 3318. Fee 20p.\" within seconds, or \"Card payment of $100.00 pending\" on a hold.", why: "It reads ledger-events instead of being called by the ledger, so a slow notification service builds lag, not payment latency. It skips any event at or below the last log position it applied for that account." },
        { name: "Fraud models", what: "Services that score money movements for signs of fraud after the fact, alongside the checks made before a payment.", why: "They need every movement, in order per account, without querying the ledger, so they read the topic." },
        { name: "Billing service", what: "Owns credit card statements: cut-off dates, grace periods, the allocation waterfall (fees, then interest, then principal) and the nightly interest it posts back through the Ledger API.", why: "The ledger only knows a card account's posted balance. Billing reads each card's entries from the topic to keep its own breakdown per statement, and reconciles its totals to the card's posted_balance." },
        { name: "BI (business intelligence)", what: "The data warehouse and accounting exports that finance and analysts use, loaded in batches.", why: "Batch loads from the topic put no load on the ledger's databases, and a loading bug can be fixed and replayed from the log." },
      ],
      fails: 'A consumer falls a day behind: it catches up from the log. A consumer processes an event twice: it checks the log position it last applied.',
      alternatives: [
        {
          name: 'Read events from the topic', chosen: true, good: 'Decoupled and replayable.', cost: 'Eventually consistent: a notification can arrive a moment after the balance changes.',
          what: 'Each service reads ledger-events as its own consumer group: notifications within seconds, billing and the warehouse in batches. Each keeps the last log position it applied per account and skips anything older.',
          pros: ['Decoupled: a slow consumer builds lag, not payment latency.', 'Replayable after a bug or an outage.', 'A new consumer needs no change to the ledger.'],
          cons: ['Eventually consistent.', 'Every consumer must handle repeats.', 'Lag per consumer group to watch and alert on.'],
        },
        {
          name: 'Call each one from the ledger', good: 'Immediate.', cost: 'The ledger waits on every downstream service and fails when any of them does.',
          what: 'After each commit, the ledger calls the notification service, fraud, billing and the rest directly.',
          pros: ['Immediate.', 'No log to run.'],
          cons: ['The ledger waits on every downstream service.', 'It fails, or must queue, when any of them does.', 'A call after the commit is a dual write: a crash in between drops it.'],
        },
        {
          name: 'Each consumer reads the change stream itself', good: 'No Kafka: each service gets committed changes straight from the log.', cost: 'A replication slot per consumer, each holding log on the primary until read.',
          what: 'Each downstream service runs its own change data capture on the ledger database, through its own replication slot.',
          pros: ['No Kafka cluster.', 'Each consumer sees changes in commit order.'],
          cons: ["A replication slot per consumer, each holding log on the primary's disk until read.", "One stuck consumer can fill a cluster's disk and stop payments.", "Every consumer is tied to the ledger's tables."],
        },
      ],
      say: 'Downstream is eventually consistent by design. Only the ledger itself is strict. Billing is downstream too: it decides interest, the ledger only posts it.',
    },
    {
      id: 'recon',
      name: 'Reconciliation',
      tech: 'checks, breaks',
      x: 1200, y: 200, w: 150, h: 64, kind: 'shared',
      what: "Proves the ledger is right in two ways. Inside: every transaction sums to zero in each currency, all posted balances in each currency sum to zero, each posted_balance equals the sum of its entries (archived period totals plus entries still in the database), and each held_balance equals the sum of its ACTIVE holds. It also watches the accounts the CHECK does not protect: system rows with allow_negative TRUE, the FX pools and CUSTOMER_RECEIVABLE_GBP. Outside: the ledger's view of each clearing and safeguarding account matches the bank statement and the scheme and card network settlement reports, every day.",
      why: "Locks stop races. They do not stop a bug that posts the wrong amount, a missing scheme message, or a bank error. Only comparing against independent truth catches those. For payment and e-money firms, the FCA's CASS 15 rules ask for this every business day.",
      built: [
        { name: "Invariant checks", what: "Queries run every few minutes on a replica: each transaction and each currency sums to zero; each posted_balance equals its archived total plus SUM(amount) of its entries; each held_balance equals SUM(amount) of its ACTIVE holds; no ACTIVE hold is past its expiry by more than a few minutes.", why: "They catch a bug within minutes. One MVCC snapshot on the replica sees a balance, its entries and its holds together, because the triggers wrote them in one transaction." },
        { name: "FX pool position", what: "FX_POOL_GBP collects pounds and FX_POOL_USD pays out dollars, so they drift apart: long GBP, short USD. Treasury rebalances with a real FX trade, booked as one balanced transaction per currency.", why: "The pools are allow_negative TRUE, so nothing in the database stops the drift. Reconciliation reports the position per currency every day, and a limit on it is treasury's to set." },
        { name: "account_period_totals", what: "This design's choice for checking after archive: before a month's partition is detached, each account's total for that month is written to account_period_totals (account_id, period, total).", why: "Once old partitions are gone, SUM(amount) over the hot table is no longer the posted balance. Archived totals plus the sum of hot entries is." },
        { name: "Rebuilding a balance", what: "If a cache is ever found wrong, the guard refuses any direct fix. Rebuilding is a reviewed break-glass change: in one transaction, SET LOCAL session_replication_role = replica so the guard does not fire, recompute posted_balance from period totals and entries and held_balance from ACTIVE holds, commit, and record who ran it and why.", why: "The guard is there to stop exactly this kind of hand edit, so the bypass must be deliberate, rare and audited. The entries and holds are the truth; only the cache is rewritten." },
        { name: "External reconciliation", what: "Every business day, the ledger's totals for each clearing and safeguarding account are matched against the bank's statement and the schemes' and card networks' settlement reports.", why: "Only an independent record catches a wrong amount, a lost scheme message or a bank error." },
        { name: "Breaks", what: "A difference nothing explains, raised with an owner, an amount and evidence, and closed by a correcting transaction through the Ledger API after a second person approves.", why: "The fix uses the same rules as every payment and is idempotent on the break id, so approving twice posts once." },
      ],
      numbers: [
        { text: "Monzo's example: two £5 payments in the ledger, £15 arrived in settlement, a £5 break.", from: "Monzo's worked example from 'Processing payments safely at scale', cited on the page: £5 + £5 = £10 in the ledger; £15 in settlement less £10 = £5 that nothing explains." },
        { text: 'Stripe reports more than 99.9999 per cent of money movement explained, with clearing accounts expected to sit at zero.', from: "Not a sum. Stripe's own figure, from its ledger post cited on the page; it has not been checked here." },
      ],
      fails: 'A break is found. It is raised with an owner, an amount and evidence. The fix is a new correcting transaction through the ledger API, reviewed by a second person, never an edit to an entry.',
      alternatives: [
        {
          name: 'Continuous invariant checks plus daily external reconciliation', chosen: true, good: 'Internal checks catch bugs in minutes; external ones catch what the ledger never saw.', cost: 'A team that owns breaks and works them down.',
          what: "Every few minutes, queries check each currency sums to zero, each posted_balance equals its archived totals plus its entries, and each held_balance equals its ACTIVE holds. Every business day, the clearing and safeguarding accounts are matched against the bank and scheme files.",
          pros: ['Internal checks catch bugs in minutes.', 'External checks catch a missing scheme message or a bank error.', "Meets CASS 15's daily reconciliation for payment and e-money firms.", 'Breaks are fixed by correcting entries, so the history shows both mistake and fix.'],
          cons: ['A team that owns breaks and works them down.', 'With about 7 TB a cluster, the checks work from period totals and recent entries, not re-summing everything.', 'A day of delay before an outside error is seen.'],
        },
        {
          name: 'Clearing accounts that should net to zero', good: "One query finds anything stuck. Stripe's Ledger is built around this.", cost: 'Needs fund flows modelled carefully up front.',
          what: "Every hop money makes between systems passes through a clearing account that should return to zero once the hop completes. Here FPS_CLEARING_GBP is credited by captures and debited when the scheme settles with the bank.",
          pros: ['One query finds money that left one system and never arrived in the next.', 'Works across many systems, not only the ledger and the bank.'],
          cons: ['Needs fund flows modelled carefully up front.', 'Finds stuck money, not a wrong amount posted the same way on both sides.', 'A clearing account is not zero while money is in flight, so it needs an age threshold.'],
        },
        {
          name: 'Month-end reconciliation only', good: 'Cheap.', cost: 'A month of errors to unpick, and below what safeguarding rules expect.',
          what: 'Finance matches the ledger to the bank statements once a month, as part of closing the books.',
          pros: ['Cheap: one exercise a month.', 'Fits the monthly close that finance already runs.'],
          cons: ['A month of errors to unpick.', 'Below what safeguarding rules expect: CASS 15 asks for every business day.', 'A customer can spend money a bug wrongly gave them before anyone sees it.'],
        },
      ],
      say: 'Correctness is proved, not assumed. The caches must equal the journal and the holds every few minutes, each currency must sum to zero, and the books must match the bank every day.',
    },
    {
      id: 'files',
      name: 'Bank and scheme files',
      short: 'Statements',
      tech: 'bank, schemes',
      x: 1200, y: 34, w: 150, h: 56, kind: 'outside',
      what: 'The independent truth: statements from the bank that holds the settlement and safeguarding accounts, and settlement reports from Faster Payments, Bacs and the card networks.',
      why: "They are produced by someone else's systems, so they disagree with yours exactly when yours are wrong.",
      built: [
        { name: "Bank statements", what: "Daily statements from the bank that holds the settlement and safeguarding accounts, where the real money sits. Safeguarding accounts hold customers' money apart from the firm's own.", why: "Each file is checksummed and loaded once; a missing file raises an alert." },
        { name: "Scheme and card network settlement reports", what: "Daily reports from Faster Payments, Bacs and the card networks of what each says was settled, in each currency.", why: "They show what the schemes think moved, which catches a lost accept or reject message, or a card settlement the ledger never posted. Each has its own format, so each needs its own parser." },
      ],
      fails: 'A file arrives late or not at all. Reconciliation for that account waits and alerts; it never assumes a missing file means nothing happened.',
      alternatives: [
        {
          name: 'Daily statements and settlement files', chosen: true, good: 'Standard, complete, and what auditors expect.', cost: 'A day of delay before an outside error is seen.',
          what: 'Every day, the bank statement for each settlement and safeguarding account, and the settlement reports from Faster Payments, Bacs and the card networks, arrive as files. Each is checksummed and loaded once.',
          pros: ['Standard and complete.', 'What auditors expect.', 'Every bank and scheme can provide them.'],
          cons: ['A day of delay before an outside error is seen.', 'Formats differ by bank and scheme, so each needs its own parser.', "A late file holds up that account's reconciliation."],
        },
        {
          name: 'Intraday statement feeds by API', good: 'Breaks found within the hour.', cost: 'Not every bank or scheme offers them.',
          what: 'The bank serves statement lines through an API during the day, and reconciliation matches them as they arrive.',
          pros: ['Breaks found within the hour.', 'Problems fixed the same day.'],
          cons: ['Not every bank or scheme offers them.', 'Another integration to build per bank.', 'The daily file is still worth keeping as the final word.'],
        },
        {
          name: 'No outside files: trust the ledger and the scheme replies', good: 'Nothing to load or parse.', cost: 'Misses exactly the errors outside records catch.',
          what: "Treat the scheme's accept and reject messages, already recorded by the Banking API, as proof, and check only inside the ledger.",
          pros: ['Nothing to load, parse or chase.', 'The internal checks still catch unbalanced books.'],
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
      what: "Old monthly partitions, exported from a replica as Parquet files with a checksum per file. ledger_entries keeps 13 months hot; pending_holds keeps about 3 months, for disputes and support. The accounts table and each account's total for every archived month of entries (account_period_totals) stay in the database.",
      why: "Entries are never deleted, so the journal only grows, and pending_holds gains about 86 million rows a day, 2.6 billion a month, while its trigger refuses DELETE. Partitioning both by date lets an old month be exported and detached in one step, with no slow delete and no dead rows to vacuum. Because the balances live in accounts, archiving never slows a funds check. Partitioning by date keeps one cluster's tables small; splitting businesses across clusters spreads the writes. They are separate things.",
      built: [
        { name: "Object store", what: "A storage service that keeps files (objects) by name and serves them over HTTP. It is not a database: it stores and returns whole files.", why: "About 24 TB of entries a year across all clusters, plus holds. Moving old months into files keeps each cluster near 7 TB and is cheap to keep for years." },
        { name: "Parquet", what: "An open file format that stores a table by column, compressed, so a reader can fetch only the columns it needs.", why: "The archive is read rarely and in bulk, which suits a compact column file. A manifest beside the files records the row count, the sums per currency and a checksum per file." },
        { name: "Monthly partitions", what: "ledger_entries and pending_holds each split by created_at into one partition per month. A partition can be detached from the table, without deleting rows one by one.", why: "With CONCURRENTLY a detach takes only a SHARE UPDATE EXCLUSIVE lock on the parent, so inserts carry on; it cannot run inside a transaction block. The price: every unique key must include created_at, so UNIQUE (transaction_id, account_id) and the hold's key (hold_id, created_at) guard only within a month; idempotency_keys is the guard across months." },
        { name: "Dropping a month of holds", what: "A hold cannot outlive its expires_at, and the longest hold the products allow is about 31 days (hotel and car-hire authorisations, an unverified figure). So a month's holds are exported, the job checks count(*) WHERE status = 'ACTIVE' is 0, and only then detaches and drops.", why: "Dropping a month with no ACTIVE rows does not touch held_balance, because every hold in it had already ended (checked on PostgreSQL 18). This design's choice; the alternative is below." },
        { name: "account_period_totals", what: "One row per account per archived month of entries: account_id, period, total. Written from the partition before it is detached.", why: "This design's choice. It lets reconciliation check a posted balance as archived totals plus hot entries once old rows have left the database." },
      ],
      fails: "An export is incomplete, or a month still has an ACTIVE hold. The partition is detached only after the file's row count and sums match the partition's, and, for holds, after no ACTIVE row is left.",
      alternatives: [
        {
          name: 'Partition by month, export and detach', chosen: true, good: 'Cheap storage, and dropping a partition is a metadata change with no dead rows to vacuum.', cost: 'Old statements are read from files, more slowly, and the unique keys change.',
          what: 'ledger_entries and pending_holds are partitioned by month on created_at. Each month the oldest entries partition past 13 months, and the oldest holds partition past 3 months with no ACTIVE row left, are exported from a replica to Parquet with counts and sums, then detached on the primary.',
          pros: ['Detaching a partition is a metadata change, not a slow delete.', 'No dead rows to vacuum, unlike deleting 2.6 billion holds a month.', 'Keeps each cluster near 7 TB instead of growing for ever.', 'Recorded counts and sums prove each file is complete.'],
          cons: ['Old statements are read from files, more slowly.', 'Unique keys must include created_at, so a replay with a different created_at is not stopped by them; idempotency_keys must catch it.', 'Partitioning must be there from day one.'],
        },
        {
          name: 'Delete each hold as it ends, into a history table', good: 'The live holds table stays tiny: only ACTIVE rows.', cost: 'A delete and an insert per hold, and steady vacuum work on the live table.',
          what: 'When a hold is captured, voided or expired, the same transaction copies it to a pending_holds_history table and deletes it from pending_holds. The trigger would allow that delete only in that path.',
          pros: ['pending_holds holds a few million ACTIVE rows, not billions.', 'No partition key in hold_id\'s primary key, so the hold_id guard holds for ever.', 'The history table can itself be partitioned and dropped.'],
          cons: ['Two more writes per payment on the hot path.', 'Every delete leaves a dead row for vacuum, about 86 million a day.', 'The delete-refusing trigger needs an exception, which weakens it.'],
        },
        {
          name: 'Keep everything in the database', good: 'One place to query.', cost: 'Indexes and backups grow for ever, and restores get slower each year.',
          what: 'Entries and holds stay in the cluster databases for ever. A statement of any age is the same query.',
          pros: ['One place to query.', 'No export job to build.'],
          cons: ['Entries grow by about 24 TB a year and holds by about 4.7 TB.', 'Restores get slower each year, which stretches recovery after a disaster.', 'Every schema change and backfill touches more data.'],
        },
      ],
      say: 'Partition the journal and the holds by date from day one, so archiving is a detach, not a delete. A month of holds is dropped only when none is ACTIVE. The catch is the unique keys, and I say so.',
      see: [{ id: 'column-store', label: 'Column store (Parquet)' }, { id: 'partitioning', label: 'Partitioning' }],
    },
  ],

  flows: [
    {
      id: 'pay', from: 'client', to: 'api', d: 'M122,200 H230', label: 'pay £1,200',
      mode: 'external', via: 'HTTPS', chip: 0.5,
      how: 'POST /payments with an Idempotency-Key header, the payee, the amount in minor units and the currency. Balance, statement, repayment and payroll requests use the same connection.',
      delivery: 'The client retries on a timeout with the same key. The server returns the saved result for that key, never a second payment.',
      alts: ['A mobile push channel for the result, so the app need not poll.', 'Webhooks to API clients when the payment settles.'],
      ways: [
        { name: 'HTTPS', chosen: true, what: "The app sends POST /payments with an Idempotency-Key header, the payee, the amount in pence and the currency. The reply is the payment's id and state; on a timeout the app sends the same request with the same key.", pros: ["Works from phones, browsers and partners' servers alike.", 'A retry with the same key returns the same payment.', 'Easy to log, rate-limit and authenticate at the edge.'], cons: ['The app must ask again to learn when a pending payment completes.', 'A timeout leaves the result unknown until the retry.'] },
        { name: 'A mobile push channel for the result', what: 'The payment is still sent over HTTPS, but the final result arrives as a push notification instead of the app asking again.', pros: ['No polling while the scheme decides.', 'The user hears the result even with the app closed.'], cons: ['Push delivery is not guaranteed, so the app still asks when it opens.', 'Another channel to build and secure.'] },
        { name: 'Webhooks to API clients', what: "A partner's server registers a URL, and the bank calls it when a payment settles or fails. The payment itself still starts with an HTTPS request.", pros: ['Partners need not poll for thousands of payments.', 'A common pattern for payment APIs.'], cons: ["The partner's endpoint can be down, so webhooks need retries and signatures.", 'At least once: partners must handle repeats.'] },
      ],
      reply: {
        id: 'accepted', label: 'payment status',
        how: "The payment's id and state: pending while the scheme decides, then settled or failed. The state lives on the Banking API's payment record, not in the ledger.",
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
  "from_account": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "payee": {
    "name": "Mill Lane Flour Ltd",
    "sort_code": "12-34-56",
    "account_number": "12345678"
  },
  "amount": 120000,
  "currency": "GBP",
  "reference": "INV 3318"
}`,
          note: 'k7 stands for a version 4 UUID made once, when the payment was drafted; every retry sends the same one. from_account is the GBP wallet; the bakery\'s USD wallet is a separate account.',
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
{ "id": "pay_3fK9", "status": "settled" }`,
          note: 'The amount is in pence: 120000 is £1,200. The fee of 20p is why the ledger holds 120020.',
        },
        {
          title: 'Other requests on the same line',
          lang: 'http',
          code: `POST /cards/5f0c...081444/repayments
Idempotency-Key: k9
{ "from_account": "5f0c...081442", "amount": 30000,
  "currency": "GBP" }
-> 201 { "status": "posted", "available_credit": 465068 }

POST /payroll-runs
Idempotency-Key: k12
{ "from_account": "5f0c...081442", "lines": 14,
  "total": 310000, "currency": "GBP", "pay_date": "2026-11-28" }
-> 202 { "status": "queued" }`,
          note: 'A repayment posts at once and restores credit at once. A payroll run is accepted onto a queue and posted when a worker reaches it; it does not need an answer in seconds.',
        },
      ],
    },
    {
      id: 'send', from: 'api', to: 'fps', d: 'M310,172 V62', label: 'payment',
      mode: 'external', via: 'scheme', chip: 0.5,
      how: 'The payment message goes to Faster Payments, directly or through a sponsor bank, with a payment identifier that stays the same on every resend. Card networks talk to the card processor the same way, in the other direction: they ask, and the bank answers.',
      delivery: 'No promise from the other side. A timeout means unknown, not failed: ask for the status before voiding the hold.',
      alts: ['Bacs for bulk payroll files, three working days.', 'CHAPS for high-value same-day payments.'],
      ways: [
        { name: 'Faster Payments (scheme)', chosen: true, what: "The payment message goes to Faster Payments, directly or through a sponsor bank, with a payment identifier that stays the same on every resend. It reaches the payee's bank in seconds, any hour of any day.", pros: ['Real time, 24/7: the supplier has the money in seconds.', 'Up to £1 million at scheme level, far above £1,200.', 'A fixed payment id lets the API ask for status after a timeout.'], cons: ['No promise from the other side: a timeout means unknown, not failed.', 'Each bank sets its own lower limit.', 'Covered by APP scam reimbursement, so fraud checks must come first.'] },
        { name: 'Bacs', what: 'Payments go in a file through Bacs and arrive over three working days. Payroll and bulk supplier runs are its usual use.', pros: ['Built for bulk: one file, thousands of payments.', 'Suits payroll, where the date is known in advance.'], cons: ['Three working days: no good for paying a supplier today.', 'Money sits in BACS_CLEARING_GBP until the file settles.'] },
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
payer        Bright Bakery Ltd, its sort code and account number
payee        Mill Lane Flour Ltd, 12-34-56 12345678
reference    INV 3318

Banking API: payment pay_3fK9 recorded as "sent"
before the message leaves.`,
        },
        {
          title: 'Reply, and what the API does with it',
          lang: 'text',
          code: `accepted   pay_3fK9
  -> recorded on the payment, then Capture (state: SETTLED)
     hold ...0417 CAPTURED; wallet -120020,
     FPS_CLEARING_GBP shard 7 +120000, FEE_REVENUE_GBP shard 7 +20

rejected   pay_3fK9, with a reason
  -> recorded on the payment, then Void (state: FAILED)
     hold ...0417 VOIDED; nothing posted

no answer before the timeout
  -> state stays PENDING (sent); the hold stays ACTIVE
  -> ask the scheme for the status of pay_3fK9,
     then capture or void`,
          note: 'A timeout is not a rejection: the hold stays ACTIVE until the scheme answers for the same payment id. The hold expires after 7 days, far longer than any status check.',
        },
        {
          title: 'The card network, the same shape the other way round',
          lang: 'text',
          code: `day 1  authorisation request, USD 100.00, online shop
       card processor -> Ledger API: Hold
       quote 0.80 GBP/USD = 8000p, + 3% FX buffer = 8240p
       -> hold ...0520 ACTIVE on the GBP wallet; approve

day 3  settlement file: USD 100.00 at 0.79 = 7900p, fee 79p
       card processor -> Ledger API: Capture hold ...0520
       -> 5 entries in two currencies; hold CAPTURED

or     no settlement by expires_at -> hold EXPIRED
or     settlement with no live hold -> force-post`,
          note: 'Rates and percentages are illustrative. The buffer covers the rate moving between authorisation and settlement; the unused 261p is simply free again at capture.',
        },
      ],
    },
    {
      id: 'post', from: 'api', to: 'ledger', d: 'M390,200 H485', label: 'hold, capture',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: "Hold with the idempotency key, the account, the amount and currency and an expiry; later Capture naming that hold with the signed entries, or Void. Incoming payments, payroll, repayments, interest and corrections use Post with signed entries. Reads use GetBalance and ListEntries.",
      delivery: 'Safe to repeat: the key is unique in the ledger, and the hold id is the hold\'s primary key, so a repeated call returns the first result.',
      alts: ['REST with an Idempotency-Key header.', 'A command topic, which turns a synchronous "is there enough money?" into an asynchronous one.'],
      ways: [
        { name: 'gRPC', chosen: true, what: 'The Banking API calls Hold, then Capture or Void, on the Ledger API, each with its own idempotency key and a deadline. Reads use GetBalance and ListEntries.', pros: ['A typed contract, with client and server code generated from it.', 'Synchronous: the API learns at once whether the funds were held.', 'A deadline on each call, so a slow ledger fails fast.'], cons: ['Harder to call by hand while debugging than REST.', 'Needs load balancers and proxies that handle long-lived HTTP/2 connections.'] },
        { name: 'REST with an Idempotency-Key header', what: 'The same calls as JSON over HTTPS, such as POST /holds with an Idempotency-Key header. The same key rules apply.', pros: ['Easy to call by hand and read in logs.', 'The same idempotency scheme as the public API.'], cons: ['No generated, typed contract unless one is added.', 'JSON costs a little more to send and parse; unlikely to matter here.'] },
        { name: 'A command topic', what: 'The caller writes a command to a topic and the ledger applies it, replying on another topic. This design does use a queue in front for payroll and payouts, which can wait; not for holds.', pros: ['Bursts queue instead of failing.', 'One consumer per partition gives a single writer per account.'], cons: ['"Is there enough money?" turns asynchronous, but a card authorisation needs an answer in seconds.', 'Matching replies to requests, and timing them out, is extra code.'] },
      ],
      reply: {
        id: 'result', label: 'result',
        how: 'The hold or transaction id and the account\'s posted, held and available figures afterwards; or INSUFFICIENT_FUNDS, HOLD_NOT_ACTIVE or TIMEOUT.',
        delivery: 'The same answer for every repeat of the same key.',
      },
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `service Ledger {
  rpc Hold(HoldRequest) returns (Result);       // pending_holds
  rpc Capture(CaptureRequest) returns (Result); // hold -> entries
  rpc Void(VoidRequest) returns (Result);       // hold ends, no entry
  rpc Post(PostRequest) returns (Result);       // entries, no hold
}
message HoldRequest {
  string idempotency_key = 1; string hold_id = 2;
  string account_id = 3;  int64 amount = 4;  string currency = 5;
  int64 expires_in_seconds = 6;
}
message Entry {  // account_id, or a logical account to split
  string account = 1; int64 amount = 2; string currency = 3;
}
message CaptureRequest {
  string idempotency_key = 1; string hold_id = 2;
  repeated Entry entries = 3;  // sum to zero per currency
}
message VoidRequest { string idempotency_key = 1; string hold_id = 2; }
message PostRequest { string idempotency_key = 1;
  repeated Entry entries = 2; }
message Result { string id = 1; string status = 2;
  int64 posted = 3; int64 held = 4; int64 available = 5; }`,
          note: 'GetBalance and ListEntries are left out to keep it short. status is COMMITTED, INSUFFICIENT_FUNDS, HOLD_NOT_ACTIVE or TIMEOUT. Payment state (PENDING, SETTLED, FAILED) lives on the Banking API\'s payment record.',
        },
        {
          title: 'Example call: hold, then the retry',
          lang: 'text',
          code: `Hold
{ "idempotency_key": "k7",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000417",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "amount": 120020, "currency": "GBP",
  "expires_in_seconds": 604800 }
-> { "id": "b61c9a3e-...000000000417", "status": "COMMITTED",
     "posted": 842000, "held": 120020, "available": 721980 }

The app's retry reaches here as the same call with key k7
-> the same reply, read from the saved result`,
          note: '604800 seconds is 7 days. The hold id is made from the request, so even a retry that lost its key would hit the same primary key.',
        },
        {
          title: 'Example call: capture, and two refusals',
          lang: 'text',
          code: `Capture
{ "idempotency_key": "k7:capture",
  "hold_id": "b61c9a3e-...000000000417",
  "entries": [
    { "account": "5f0c2a9e-...081442", "amount": -120020,
      "currency": "GBP" },
    { "account": "FPS_CLEARING_GBP", "amount": 120000,
      "currency": "GBP" },
    { "account": "FEE_REVENUE_GBP", "amount": 20,
      "currency": "GBP" } ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
     "status": "COMMITTED", "posted": 721980, "held": 0,
     "available": 721980 }

Had the wallet held less:  Hold -> { "status": "INSUFFICIENT_FUNDS" }
Had the hold expired:      Capture -> { "status": "HOLD_NOT_ACTIVE" }`,
          note: 'The Ledger API turned FPS_CLEARING_GBP and FEE_REVENUE_GBP into their shard 7 rows, from hash(transaction_id) % 16. A capture of a hold that is no longer ACTIVE posts nothing; the caller then decides on a force-post.',
        },
        {
          title: 'Example call: credit card interest from billing',
          lang: 'text',
          code: `Post   (from the billing service, nightly)
{ "idempotency_key": "interest:5f0c...081444:2026-11-12",
  "entries": [
    { "account": "5f0c2a9e-...081444", "amount": -32,
      "currency": "GBP" },
    { "account": "INTEREST_INCOME_GBP", "amount": 32,
      "currency": "GBP" } ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000900612",
     "status": "COMMITTED", "posted": -64932, "held": 0,
     "available": 435068 }`,
          note: 'Billing decides the 32p (illustrative; no rate is implied). The ledger only posts it. The key names the card and the date, so a rerun of the night posts once.',
        },
      ],
    },
    {
      id: 'txn', from: 'ledger', to: 'db', d: 'M615,200 H700', label: 'one call',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'One call to a small function per write. ledger_hold: set the timeouts, insert the idempotency key, lock the account with FOR NO KEY UPDATE, insert the hold only if posted - held - amount >= -credit_limit, write the outbox row, commit. ledger_capture: lock the accounts in account_id order, then one statement that marks the hold CAPTURED and inserts the entries, or does neither. Balance reads are a plain SELECT on accounts.',
      delivery: 'All or nothing. If the key already exists, the call returns the stored result and writes nothing. If the money is not there, no hold is inserted. If the hold is not ACTIVE, no entry is inserted. If a lock is not free within 50 ms, the call fails and is retried with the same key.',
      alts: ['An interactive transaction of separate statements, holding locks across each round trip.', 'A batch of many transfers per call, as TigerBeetle does, for throughput.'],
      ways: [
        { name: 'SQL: one function call', chosen: true, what: 'The Ledger API calls ledger_hold, ledger_capture, ledger_void or ledger_post once on the cluster. Each does its key, its locks, its one conditional statement and its outbox row; the transaction commits.', pros: ['Locks are never held across the network: about 1 to 2 ms each.', 'All or nothing, and a repeated key returns the stored result.', 'One round trip per write.'], cons: ['Logic in SQL needs its own review and tests.', 'Changing it is a database deploy.'] },
        { name: 'An interactive transaction of separate statements', what: 'The service sends each statement on its own inside one transaction. Each is a round trip while the locks are held.', pros: ['All logic in application code.', 'Easy to read and step through.'], cons: ['Four or five round trips with locks held.', 'Ten round trips of 0.5 ms hold a hot row for 5 ms: about 200 writes a second on it.'] },
        { name: 'A batch of many transfers per call', what: 'The Ledger API gathers many transfers and sends them in one call, applied in one transaction. TigerBeetle does this with up to 8,190 transfers a batch.', pros: ['One commit and one standby round trip shared by many transfers.', 'Far more writes a second on a hot row.'], cons: ['One bad transfer must not fail the rest, so each needs its own result.', 'Each transfer waits for its batch to fill or a timer to fire.'] },
      ],
      reply: {
        id: 'committed', label: 'committed',
        how: 'The commit returns once the write-ahead log is flushed locally and one synchronous standby confirms it has flushed it too.',
        delivery: 'Durable on two machines when acknowledged.',
      },
      examples: [
        {
          title: "The owner's tables, 1 of 2: accounts",
          lang: 'sql',
          code: `CREATE TABLE accounts (
    account_id UUID PRIMARY KEY,
    logical_account VARCHAR(50),          -- Chart-of-accounts group
    --   (NULL for customer wallets/cards)
    shard_id INT NOT NULL DEFAULT 0,      -- 0 for unsharded customer
    --   accounts; 0..N-1 for sharded clearing/revenue accounts
    account_type VARCHAR(20) NOT NULL,    -- 'USER_WALLET',
    --   'CREDIT_CARD', 'CLEARING', 'FX_POOL', 'REVENUE'
    allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
    posted_balance BIGINT NOT NULL DEFAULT 0,
    held_balance   BIGINT NOT NULL DEFAULT 0,
    credit_limit   BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    currency CHAR(3) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unified overdraft & credit-limit enforcement
    CONSTRAINT valid_available_funds
        CHECK (allow_negative
               OR (posted_balance - held_balance) >= -credit_limit),
    CONSTRAINT valid_held_balance
        CHECK (held_balance >= 0),
    CONSTRAINT uq_logical_shard UNIQUE (logical_account, shard_id)
) WITH (fillfactor = 80);`,
          note: "The owner's DDL. To fit 72 characters, three long comments continue on a second comment line and one CHECK is broken over two lines; nothing else is changed. A NULL logical_account never collides in uq_logical_shard, so a million wallets can all have shard_id 0 (checked on PostgreSQL 18).",
        },
        {
          title: "The owner's tables, 2 of 2: holds and entries",
          lang: 'sql',
          code: `CREATE TABLE pending_holds (
    hold_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,          -- 'ACTIVE', 'CAPTURED',
    --   'VOIDED', 'EXPIRED'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    -- Positive = Credit, Negative = Debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id) -- Idempotency guard
);

CREATE INDEX idx_ledger_account_created
    ON ledger_entries (account_id, created_at DESC);`,
          note: "The owner's DDL, with the status comment and the amount comment moved to their own lines and the index wrapped, to fit. Amounts are minor units; a posted_balance is the sum of the account's entries.",
        },
        {
          title: "This design's additions beside them",
          lang: 'sql',
          code: `-- the expiry job reads only ACTIVE holds
CREATE INDEX idx_holds_active_expiry
    ON pending_holds (expires_at) WHERE status = 'ACTIVE';

CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    transaction_id UUID NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);  -- kept 72 hours, then deleted by a job

CREATE TABLE outbox (
    seq BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL,
    payload JSONB NOT NULL
);`,
          note: 'Not in the owner\'s spec; added to make his rules work. The partial index holds only ACTIVE rows, a few million, while the table gains about 86 million rows a day.',
        },
        {
          title: 'Triggers 1: the journal is append-only; entries move posted',
          lang: 'sql',
          code: `CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

CREATE FUNCTION apply_entry_to_posted() RETURNS trigger AS $$
BEGIN
  UPDATE accounts
     SET posted_balance = posted_balance + NEW.amount,
         updated_at = now()
   WHERE account_id = NEW.account_id
     AND currency = NEW.currency AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry for % is in % but the account is not,'
      ' or is closed', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_posted();`,
          note: 'A trigger is a function the database runs by itself when a row is written, inside the same transaction. Matching on currency means an entry in USD for a GBP account finds no row and is refused.',
        },
        {
          title: 'Triggers 2: a hold raises held_balance',
          lang: 'sql',
          code: `CREATE FUNCTION hold_placed() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a hold starts ACTIVE';
  END IF;
  UPDATE accounts
     SET held_balance = held_balance + NEW.amount,
         updated_at = now()
   WHERE account_id = NEW.account_id
     AND currency = NEW.currency AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold for % is in % but the account is not,'
      ' or is closed', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_placed AFTER INSERT ON pending_holds
  FOR EACH ROW EXECUTE FUNCTION hold_placed();`,
          note: 'Raising held_balance runs the CHECK on the account row, so a hold that skipped the funds test still cannot take available money past the floor.',
        },
        {
          title: 'Triggers 3: a hold ends once, and lowers held_balance',
          lang: 'sql',
          code: `CREATE FUNCTION hold_ended() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds are ended, never deleted';
  END IF;
  IF OLD.status <> 'ACTIVE'
     OR NEW.status NOT IN ('CAPTURED', 'VOIDED', 'EXPIRED')
     OR (NEW.hold_id, NEW.account_id, NEW.amount, NEW.currency)
        IS DISTINCT FROM
        (OLD.hold_id, OLD.account_id, OLD.amount, OLD.currency) THEN
    RAISE EXCEPTION
      'a hold changes once: ACTIVE to CAPTURED, VOIDED or EXPIRED';
  END IF;
  UPDATE accounts
     SET held_balance = held_balance - OLD.amount,
         updated_at = now()
   WHERE account_id = OLD.account_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_ended
  BEFORE UPDATE OR DELETE ON pending_holds
  FOR EACH ROW EXECUTE FUNCTION hold_ended();`,
          note: 'This is what stops a hold being both captured and voided: whichever ends it first wins, and the second finds it no longer ACTIVE. It also refuses changing the amount, the account or the currency.',
        },
        {
          title: 'Triggers 4: the guard, and the per-currency check at commit',
          lang: 'sql',
          code: `CREATE FUNCTION accounts_guard_balances() RETURNS trigger AS $$
BEGIN
  IF (NEW.posted_balance IS DISTINCT FROM OLD.posted_balance
      OR NEW.held_balance IS DISTINCT FROM OLD.held_balance)
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION
      'balances change only through ledger_entries and pending_holds';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balances();

CREATE FUNCTION entries_must_balance() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_entries
              WHERE transaction_id = NEW.transaction_id
              GROUP BY currency HAVING sum(amount) <> 0) THEN
    RAISE EXCEPTION 'transaction % does not sum to zero'
      ' in every currency', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION entries_must_balance();`,
          note: 'A direct UPDATE of either balance runs the guard at depth 1 and is refused; a trigger\'s UPDATE runs it at depth 2. credit_limit and is_active are not guarded: the account service changes them with ordinary UPDATEs. The second trigger is this design\'s optional backstop.',
        },
        {
          title: 'Hold, part 1: timeouts, the key, the lock',
          lang: 'sql',
          code: `-- Bright Bakery GBP wallet 5f0c2a9e-3d41-4b7e-8c12-000000081442
--   USER_WALLET, credit_limit 0, posted 842000, held 0
BEGIN;
SET LOCAL lock_timeout = '50ms';
SET LOCAL statement_timeout = '250ms';

INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7', '7d1f0a52-6c3e-4f8b-9e21-000000900417')
ON CONFLICT (key) DO NOTHING;
-- 0 rows: k7 was seen; return its saved result and stop

SELECT posted_balance, held_balance, credit_limit
  FROM accounts
 WHERE account_id = '5f0c2a9e-...081442'
   FOR NO KEY UPDATE;
-- waits at most 50 ms for another writer; then SQLSTATE 55P03,
-- the transaction rolls back and the caller retries with k7`,
          note: 'SET LOCAL lasts until COMMIT or ROLLBACK, so with PgBouncer in transaction mode the setting never leaks to the next client on the same server connection. The transaction_id stored with k7 is just the record of this request; the hold has no journal transaction.',
        },
        {
          title: 'Hold, part 2: insert only if funded, then commit',
          lang: 'sql',
          code: `WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442'
     AND posted_balance - held_balance - 120020 >= -credit_limit
)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-0f47-4d2a-8c55-000000000417',
       '5f0c2a9e-...081442', 120020, 'GBP', 'ACTIVE',
       now() + interval '7 days'
  FROM funded
ON CONFLICT (hold_id) DO NOTHING;
-- 1 row: the trigger raised held_balance by 120020
-- 0 rows: not enough money (or this hold exists already);
--   ROLLBACK and answer INSUFFICIENT_FUNDS or the saved result

INSERT INTO outbox (transaction_id, account_id, payload)
VALUES ('7d1f0a52-...900417', '5f0c2a9e-...081442', '{...}');
UPDATE idempotency_keys SET result = '{...}' WHERE key = 'k7';
COMMIT;  -- returns once a synchronous standby has the log record
-- after: posted 842000, held 120020, available 721980`,
          note: 'The CTE returns a row only if the money is there, so the insert writes the hold or nothing. For a credit card the same test lets the balance go down to minus its limit. Without the pre-check, the CHECK refuses the row (23514).',
        },
        {
          title: 'Capture: end the hold and post the entries in one statement',
          lang: 'sql',
          code: `-- FPS_CLEARING_GBP shard 7  1c9d4e2a-7b10-4c55-9a01-000000000007
-- FEE_REVENUE_GBP shard 7   c2e85b71-90aa-4d3f-a6e4-000000000007
BEGIN;
SET LOCAL lock_timeout = '50ms'; SET LOCAL statement_timeout = '250ms';
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7:capture', '7d1f0a52-6c3e-4f8b-9e21-000000900418')
ON CONFLICT (key) DO NOTHING;
SELECT 1 FROM accounts               -- 1c9d..., 5f0c..., c2e8...
 WHERE account_id IN ('5f0c2a9e-...081442', '1c9d4e2a-...000007',
                      'c2e85b71-...000007')
 ORDER BY account_id FOR NO KEY UPDATE;
WITH done AS (
  UPDATE pending_holds SET status = 'CAPTURED'
   WHERE hold_id = 'b61c9a3e-...000000000417' AND status = 'ACTIVE'
  RETURNING hold_id
)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900418', v.acct::uuid, v.amt, 'GBP'
  FROM (VALUES ('5f0c2a9e-...081442', -120020::bigint),
               ('1c9d4e2a-...000007',  120000::bigint),
               ('c2e85b71-...000007',      20::bigint)) AS v(acct, amt),
       done;
-- 3 rows, or 0 if the hold was not ACTIVE (then ROLLBACK)
COMMIT;  -- (outbox row and saved result as in the hold)`,
          note: 'The hold ends and the entries post together, or neither. A second capture finds the hold CAPTURED, updates 0 rows and inserts 0 entries. After: posted 721980, held 0. It works even when the wallet holds exactly the held amount (checked).',
        },
        {
          title: 'Void: the scheme rejected the payment',
          lang: 'sql',
          code: `BEGIN;
SET LOCAL lock_timeout = '50ms'; SET LOCAL statement_timeout = '250ms';
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7:void', '7d1f0a52-6c3e-4f8b-9e21-000000900419')
ON CONFLICT (key) DO NOTHING;

UPDATE pending_holds SET status = 'VOIDED'
 WHERE hold_id = 'b61c9a3e-0f47-4d2a-8c55-000000000417'
   AND status = 'ACTIVE';
-- 1 row: the trigger lowered held_balance by 120020
-- 0 rows: already captured, voided or expired; report it

INSERT INTO outbox (transaction_id, account_id, payload)
VALUES ('7d1f0a52-...900419', '5f0c2a9e-...081442', '{...}');
COMMIT;
-- after: posted 842000, held 0, available 842000
-- no row in ledger_entries: the journal never saw the payment`,
          note: 'The void takes no lock on system accounts: only the hold row and, through the trigger, the wallet row are written. The id stored with k7:void is a record id, not a journal transaction.',
        },
        {
          title: 'A balance read: posted, held, available',
          lang: 'sql',
          code: `-- GetBalance, always on the primary: one row, no lock
SELECT posted_balance, held_balance, credit_limit,
       posted_balance - held_balance + credit_limit AS available
  FROM accounts
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442';
--                 posted   held     available
--  before:        842000        0   842000
--  after hold:    842000   120020   721980
--  after capture: 721980        0   721980
--  had it voided: 842000        0   842000

-- the credit card, after example D's capture and interest
--  5f0c...081444: -64932        0   435068  (limit 500000)`,
          note: "A plain SELECT never waits for a writer's row lock: it reads the last committed version of the row. For a card, available is the credit left: 500000 - 64932.",
        },
        {
          title: 'Card authorisation and credit card purchase: the same hold',
          lang: 'sql',
          code: `-- B. Debit card, USD 100.00 quoted at 0.80 + 3% buffer = 8240p
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442'
     AND posted_balance - held_balance - 8240 >= -credit_limit)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-...000000000520', '5f0c2a9e-...081442', 8240,
       'GBP', 'ACTIVE', now() + interval '7 days' FROM funded;

-- D. Credit card 5f0c...081444, limit 500000, posted 0: £649.00
--   0 - 0 - 64900 = -64900 >= -500000, so 1 row
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081444'
     AND posted_balance - held_balance - 64900 >= -credit_limit)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-...000000000610', '5f0c2a9e-...081444', 64900,
       'GBP', 'ACTIVE', now() + interval '7 days' FROM funded;
-- card: posted 0, held 64900, available credit 435100`,
          note: 'Each runs inside the same frame as the bank hold: timeouts, key, FOR NO KEY UPDATE on the one account, outbox. The 7-day expiry for card holds is illustrative. The hold is in GBP because the wallet is; no account ever holds two currencies.',
        },
        {
          title: 'Card settlement with FX: five entries, two currencies',
          lang: 'sql',
          code: `-- settled at 0.79: 7900p, FX fee 1% = 79p (illustrative)
-- FX_POOL_GBP s7       3b7a1f64-58c2-4d0e-9f31-000000000007
-- FX_FEE_REVENUE_GBP   c2e85b71-90aa-4d3f-a6e4-000000000107
-- FX_POOL_USD s7       3b7a1f64-58c2-4d0e-9f31-000000000107
-- MASTERCARD_DEBIT_CLEARING_USD
--                      d41e7c90-6a2b-4f17-8e05-000000000107
-- (lock all five accounts in account_id order first)
WITH done AS (
  UPDATE pending_holds SET status = 'CAPTURED'
   WHERE hold_id = 'b61c9a3e-...000000000520' AND status = 'ACTIVE'
  RETURNING hold_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900521', v.acct::uuid, v.amt, v.cur
  FROM (VALUES ('5f0c2a9e-...081442',  -7979::bigint, 'GBP'),
               ('3b7a1f64-...000007',   7900::bigint, 'GBP'),
               ('c2e85b71-...000107',     79::bigint, 'GBP'),
               ('3b7a1f64-...000107', -10000::bigint, 'USD'),
               ('d41e7c90-...000107',  10000::bigint, 'USD'))
       AS v(acct, amt, cur), done;
-- GBP: -7979 + 7900 + 79 = 0    USD: -10000 + 10000 = 0
-- hold of 8240 released; the 261p difference is free again`,
          note: 'Pounds go into the GBP pool and dollars come out of the USD pool, each currency summing to zero. The rate lives on the payment record and the outbox event, not in ledger_entries. The pools drift (long GBP, short USD) until treasury trades.',
        },
        {
          title: 'Credit card capture, interest and repayment',
          lang: 'sql',
          code: `-- D. capture ...900611 (hold ...0610 CAPTURED in the same
--    statement, as above): card -64900,
--    MASTERCARD_CREDIT_CLEARING_GBP s7 (d41e7c90-...000207) +64900
-- card: posted -64900, held 0, available credit 435100

-- nightly interest from billing, key interest:<card>:2026-11-12
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900612', '5f0c2a9e-...081444',   -32, 'GBP'),
 ('7d1f0a52-...900612', 'c2e85b71-...000207',    32, 'GBP');
-- INTEREST_INCOME_GBP shard 7; card posted -64932

-- repayment from the bakery's GBP wallet
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900613', '5f0c2a9e-...081442', -30000, 'GBP'),
 ('7d1f0a52-...900613', '5f0c2a9e-...081444',  30000, 'GBP');
-- card posted -34932, available credit 465068 at once`,
          note: 'Each is its own transaction with its key and its locks in account_id order. A negative card balance is what the customer owes: -34932 is £349.32. Which part is interest and which is principal is billing\'s record, not the ledger\'s.',
        },
        {
          title: 'Force-post: a settlement with no live hold, past the floor',
          lang: 'sql',
          code: `-- 800000p arrives for the wallet; it cannot pay it all.
-- CUSTOMER_RECEIVABLE_GBP s7  e7000000-0000-4000-8000-000000000007
-- (lock wallet, FX_POOL_GBP s7 and the receivable, id order)
WITH w AS (
  SELECT least(800000,
               posted_balance - held_balance + credit_limit) AS take
    FROM accounts WHERE account_id = '5f0c2a9e-...081442')
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900701', v.acct, v.amt, 'GBP'
  FROM w, LATERAL (VALUES
        ('5f0c2a9e-...081442'::uuid, -w.take),
        ('e7000000-...000007'::uuid, -(800000 - w.take)),
        ('3b7a1f64-...000007'::uuid, 800000::bigint)) AS v(acct, amt)
 WHERE v.amt <> 0;
-- wallet down to its floor; the rest is money the customer owes`,
          note: 'This design\'s choice: a plain debit of 800000 is refused by the CHECK, because wallets and cards have allow_negative FALSE. Taking what is available down to minus credit_limit and booking the rest to the receivable (allow_negative TRUE) keeps one balanced transaction. Checked for a wallet and for a card.',
        },
        {
          title: 'Payroll and an incoming payment',
          lang: 'sql',
          code: `-- payroll: the employer once; Bacs for 13 staff, one banks here
-- BACS_CLEARING_GBP s3      1c9d4e2a-7b10-4c55-9a01-000000000303
-- employee's wallet here    5f0c2a9e-3d41-4b7e-8c12-000000090001
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900800', '5f0c2a9e-...081442', -310000, 'GBP'),
 ('7d1f0a52-...900800', '1c9d4e2a-...000303',  285000, 'GBP'),
 ('7d1f0a52-...900800', '5f0c2a9e-...090001',   25000, 'GBP');
-- UNIQUE (transaction_id, account_id): an account appears once.
-- Two lines to one account must be netted, or go in two
-- transactions; a repeat in one statement fails with 23505.

-- incoming Faster Payment: one balanced transaction, no hold
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900810', '<FASTER_PAYMENTS_IN_GBP s4>', -45000, 'GBP'),
 ('7d1f0a52-...900810', '5f0c2a9e-...081442',           45000, 'GBP');`,
          note: 'Both inside the usual frame (timeouts, key, locks in id order, outbox). The 13 Bacs lines go out in the Bacs file; inside the ledger they are one credit to BACS_CLEARING_GBP. Payroll is fed from a queue, so a spike waits there, not on the wallet lock. For 5,000 staff who bank here, one transaction would be 5,001 entries and locks; whether that fits in 250 ms is not measured, so the fallback is chunks of a few hundred through PAYROLL_CLEARING_GBP, each its own balanced transaction. Figures illustrative.',
        },
        {
          title: 'Partitioned by month: the keys must change',
          lang: 'sql',
          code: `-- PostgreSQL refuses the keys above on a table partitioned
-- by created_at: "unique constraint on partitioned table must
-- include all partitioning columns". So both gain created_at.
CREATE TABLE ledger_entries (
    entry_id BIGSERIAL,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entry_id, created_at),
    UNIQUE (transaction_id, account_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE ledger_entries_2026_11 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

-- Lost: a replay with a different created_at is a new row
-- under this UNIQUE. idempotency_keys, inserted first in the
-- same transaction, is the guard across partitions.`,
          note: 'The index and triggers are declared on the parent as before, and work there (checked).',
        },
        {
          title: 'pending_holds partitioned by month, and dropping a month',
          lang: 'sql',
          code: `CREATE TABLE pending_holds (
    hold_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (hold_id, created_at)
) PARTITION BY RANGE (created_at);
-- triggers, FK and the partial index on the parent, as before;
-- a capture WHERE hold_id = $1 AND status = 'ACTIVE' needs no month

-- archive job, after the month's export is checked:
SELECT count(*) FROM pending_holds_2026_08
 WHERE status = 'ACTIVE';            -- must be 0
ALTER TABLE pending_holds
  DETACH PARTITION pending_holds_2026_08 CONCURRENTLY;
DROP TABLE pending_holds_2026_08;    -- run by the archive role`,
          note: "This design's choice, checked on PostgreSQL 18. Lost: the same hold_id with another created_at inserts as a second hold, so the idempotency key inserted first, and hold ids made once per authorisation, are the guards. DETACH ... CONCURRENTLY cannot run inside a transaction block.",
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
        { name: 'Consensus replication with three voters', what: 'Three or more voters agree on each log record and elect a new leader themselves. A write commits once a majority has it.', pros: ['Failover needs no operator or separate tool.', 'The same recovery point of zero.'], cons: ['A database built around it, not stock Postgres.', 'At least three voters per cluster.'] },
        { name: 'Asynchronous streaming', what: "The primary streams the log without waiting. The commit returns once the record is on the primary's own disk.", pros: ['Lowest commit latency.', 'Standbys never slow payments.'], cons: ['Can lose the last seconds of payments on failover.', 'Not acceptable for a ledger.'] },
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
          code: `primary  writes the commit record for hold ...0417 to its WAL
primary  flushes it to its own disk
primary  streams it to s1 and s2
s2       flushes it and confirms first
primary  returns from the call: the hold is committed
s1       confirms a moment later; nothing waited for it

If the primary died after the commit returned, s2 already
holds the hold and is promoted with nothing lost.

...0417 is hold b61c9a3e-0f47-4d2a-8c55-000000000417.`,
          note: 'The call returns only after a second machine has the record: that is recovery point zero. The capture, transaction ...900418, commits the same way.',
        },
      ],
    },
    {
      id: 'sweep', from: 'sweeper', to: 'db', d: 'M980,190 H890', label: 'sweep',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: "At the end of each day, for each logical system account, one balanced transaction moves the 16 rows' posted balances into the master account. Every minute, a batch update marks overdue ACTIVE holds EXPIRED.",
      delivery: 'Idempotent: each sweep carries a key made of the account and the date, so a rerun does nothing. Expiring a hold twice is impossible: the second update finds it no longer ACTIVE.',
      alts: ['Sweeping every minute.', 'No sweep: reports always sum the 16 rows.'],
      ways: [
        { name: 'SQL', chosen: true, what: 'Once a day per logical account: lock the master and its 16 rows in account_id order, debit each row by its posted balance and credit the master with the total, keyed by account and date. Every minute: expire due holds in batches through the partial index.', pros: ['An ordinary ledger transaction: same triggers, same checks.', 'Idempotent: a rerun for the same date does nothing.', 'Touches each hot row once a day.'], cons: ["One more writer on each row's lock while it runs.", 'The master lags by up to a day.'] },
        { name: 'Sweeping every minute', what: "This afternoon's version: the same transaction, keyed by account and minute.", pros: ['Masters are never far behind.'], cons: ['1,440 sweeps a day per account, each locking 16 hot rows.', 'Buys nothing a report summing 17 rows does not give.'] },
        { name: 'No sweep', what: 'Totals stay in the 16 rows for good, and every report sums them with the master.', pros: ['Nothing to run.', 'Nothing lags.'], cons: ['Every reader must know to sum 17 rows.', 'One report that forgets shows a near-empty master.'] },
      ],
      examples: [
        {
          title: 'The end-of-day sweep of fee revenue, as one transaction',
          lang: 'sql',
          code: `BEGIN;
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('sweep:FEE_REVENUE_GBP:2026-11-12',
        '7d1f0a52-6c3e-4f8b-9e21-000000900452')
ON CONFLICT (key) DO NOTHING;   -- 0 rows: swept already; stop
SELECT account_id FROM accounts
 WHERE logical_account IN ('FEE_REVENUE_GBP',
                           'FEE_REVENUE_GBP_MASTER')
 ORDER BY account_id FOR NO KEY UPDATE;
WITH parts AS (
  SELECT account_id, posted_balance AS amt FROM accounts
   WHERE logical_account = 'FEE_REVENUE_GBP' AND posted_balance <> 0)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900452'::uuid, account_id, -amt, 'GBP'
  FROM parts
UNION ALL
SELECT '7d1f0a52-...900452'::uuid, m.account_id, sum(p.amt), 'GBP'
  FROM parts p, accounts m
 WHERE m.logical_account = 'FEE_REVENUE_GBP_MASTER'
 GROUP BY m.account_id HAVING sum(p.amt) <> 0;
COMMIT;  -- each row back to 0; the master up by their sum`,
          note: 'The master is its own logical account, because uq_logical_shard gives FEE_REVENUE_GBP exactly rows 0 to 15. The rows are locked, so their balances cannot change between the read and the insert. Checked on PostgreSQL 18; run with a longer statement_timeout than payments use.',
        },
        {
          title: 'The hold expiry job, every minute',
          lang: 'sql',
          code: `WITH due AS (
  SELECT hold_id FROM pending_holds
   WHERE status = 'ACTIVE' AND expires_at < now()
   ORDER BY expires_at
   LIMIT 1000
   FOR UPDATE SKIP LOCKED
)
UPDATE pending_holds h SET status = 'EXPIRED'
  FROM due
 WHERE h.hold_id = due.hold_id AND h.status = 'ACTIVE';
-- each row: the trigger lowers that account's held_balance
-- repeat until 0 rows; one outbox row per expired hold`,
          note: 'The WHERE matches idx_holds_active_expiry, so only due ACTIVE holds are read. SKIP LOCKED passes over a hold that a capture is ending at this moment; whichever commits first wins, and the other finds it no longer ACTIVE. Checked: an expired hold then captures 0 rows.',
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
        { name: 'Logical decoding messages with no table', what: 'The ledger function emits a logical decoding message instead of inserting a row. The relay reads it through the same slot.', pros: ['No outbox table to clear out.', 'The same atomicity and commit order.'], cons: ['Postgres-specific.', 'No table to query when checking what was sent.'] },
      ],
      examples: [
        {
          title: 'The outbox row as the relay receives it',
          lang: 'json',
          code: `{
  "op": "c",
  "before": null,
  "after": {
    "seq": 5512930,
    "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
    "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
    "payload": "<the event as JSON text: see ledger-events>"
  },
  "source": {
    "connector": "postgresql",
    "table": "outbox",
    "lsn": 249113864
  }
}`,
          note: 'op "c" is an insert; lsn is the position in the write-ahead log, which the relay copies into the event. This row is the capture\'s; the hold wrote one too.',
        },
      ],
    },
    {
      id: 'publish', from: 'relay', to: 'kafka', d: 'M1104,350 H1140 Q1150,350 1150,360 V443', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.7,
      how: "Each outbox row becomes one event on ledger-events, keyed by account so an account's events keep their order.",
      delivery: 'At least once, in order per account. Events carry the database log position so readers can drop repeats.',
      alts: ['One topic per event type.', 'A managed stream (Kinesis, Pub/Sub).'],
      ways: [
        { name: 'Kafka, keyed by account', chosen: true, what: "The relay turns each outbox row into one event on ledger-events, keyed by account. Kafka keeps order within a partition, so each account's events stay in order.", pros: ['Ordered per account.', 'Replayable for every reader.', 'Light: about 3 MB a second on average, about 30 MB at peak.'], cons: ['At least once: events carry the log position so readers can drop repeats.', 'A partition holding a busy account can lag behind the others.'] },
        { name: 'One topic per event type', what: 'Separate topics for holds and for posted transactions. Each consumer subscribes only to what it needs.', pros: ['Consumers skip what they do not need.', 'Each topic can have its own retention and schema.'], cons: ['No order across topics: a capture can be read before its hold.', 'More topics to run and keep in step.'] },
        { name: 'A managed stream (Kinesis, Pub/Sub)', what: "A cloud provider's stream in place of a Kafka cluster, with the account as the key that keeps order.", pros: ['Nothing to run.', "Replay within the service's retention."], cons: ["Ties the ledger's events to one cloud.", 'Ordering and retention rules differ by product; check them before relying on replay.'] },
      ],
      examples: [
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic       ledger-events
key         "5f0c2a9e-3d41-4b7e-8c12-000000081442"
            Bright Bakery's GBP wallet account_id
partition   chosen by hashing the key, so every event for
            the wallet lands in one partition, in commit order`,
          note: "The key keeps one account's events in order; there is no order across accounts, and none is needed.",
        },
        {
          title: 'Message value: the capture',
          lang: 'json',
          code: `{
  "type": "transaction.posted",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000417",
  "reference": "pay_3fK9",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "entries": [
    { "account": "5f0c...081442", "amount": -120020,
      "currency": "GBP" },
    { "account": "FPS_CLEARING_GBP/7", "amount": 120000,
      "currency": "GBP" },
    { "account": "FEE_REVENUE_GBP/7", "amount": 20, "currency": "GBP" }
  ],
  "posted": 721980, "held": 0, "available": 721980,
  "lsn": 249113864,
  "committed_at": "2026-11-12T10:41:03.118Z"
}`,
          note: 'Signed minor units: plus a credit, minus a debit, each with its currency. The capture also emits hold.ended for ...0417; the hold emitted hold.placed. lsn lets a reader drop a repeat.',
        },
        {
          title: 'Message value: the card settlement with FX',
          lang: 'json',
          code: `{
  "type": "transaction.posted",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900521",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000520",
  "fx": { "sell": "GBP", "buy": "USD", "rate": "0.79",
          "fee_bps": 100 },
  "entries": [
    { "account": "5f0c...081442", "amount": -7979, "currency": "GBP" },
    { "account": "FX_POOL_GBP/7", "amount": 7900, "currency": "GBP" },
    { "account": "FX_FEE_REVENUE_GBP/7", "amount": 79,
      "currency": "GBP" },
    { "account": "FX_POOL_USD/7", "amount": -10000, "currency": "USD" },
    { "account": "MASTERCARD_DEBIT_CLEARING_USD/7", "amount": 10000,
      "currency": "USD" }
  ],
  "lsn": 249180022
}`,
          note: 'The rate travels on the event and the payment record, never in ledger_entries. Figures illustrative.',
        },
      ],
    },
    {
      id: 'notify', from: 'kafka', to: 'consumers', d: 'M1120,475 H975', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.5,
      how: 'Each consumer group reads at its own pace: notifications in seconds, billing and the warehouse in batches.',
      delivery: 'At least once. Consumers keep the last applied position per account and skip anything older.',
      alts: ['Webhooks pushed to partners from a dedicated consumer.'],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Each consumer group reads ledger-events at its own pace: notifications within seconds, billing and the warehouse in batches. Each keeps its own position.', pros: ['A slow consumer builds lag, not payment latency.', 'Each can replay from its own position.'], cons: ['At least once: each keeps the last position per account and skips anything older.', 'Lag to watch per group.'] },
        { name: 'Webhooks pushed to partners from a dedicated consumer', what: "One consumer reads the topic and pushes events to partners' URLs, retrying until they accept.", pros: ['Partners get events without access to Kafka.', 'A failing partner only slows that one consumer.'], cons: ["Partners' endpoints fail, so retries and backoff are needed.", 'Events must be signed so partners can trust them.'] },
        { name: 'The ledger calls each service', what: 'After each commit, the ledger calls every downstream service directly.', pros: ['Immediate.', 'No log to run.'], cons: ['The ledger waits on, and fails with, every downstream service.', 'A crash between commit and call drops the notice.'] },
      ],
      examples: [
        {
          title: 'What the notifications consumer does',
          lang: 'text',
          code: `group         notifications
reads         ledger-events, the partition holding the wallet's key
              "5f0c2a9e-3d41-4b7e-8c12-000000081442"

last applied  lsn 249071520 for the wallet (hold.placed, ...0417)
this event    lsn 249113864, transaction.posted, ...900418
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
      how: 'Reconciliation builds its own running totals per clearing account, per currency and per day from the events.',
      delivery: 'At least once, deduplicated by transaction id.',
      alts: ['Reading the replicas directly at the end of each day.'],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Reconciliation reads ledger-events and keeps its own running totals per logical clearing account, currency and day, deduplicated by transaction id.', pros: ['Totals are ready the moment the bank file arrives.', "No load on the ledger's databases."], cons: ['Its totals are a copy: a bug in the consumer looks like a break.', 'At least once, so deduplication must be right.'] },
        { name: 'Reading the replicas at the end of each day', what: "At the end of each day, reconciliation queries a replica of each cluster for the day's totals per clearing account.", pros: ['Reads the record itself, not a copy.', 'No consumer to keep running.'], cons: ['Heavy queries on every cluster every night.', "Must allow for replica lag at the day's cut-off."] },
        { name: 'From the data warehouse', what: 'Reconciliation queries the data warehouse, which is fed from the same topic.', pros: ['SQL over all history, which finance already uses.', 'No load on the ledger at all.'], cons: ['Another hop, with its own lag.', 'A loading bug in the warehouse looks like a ledger break.'] },
      ],
      examples: [
        {
          title: "Reconciliation's own running total",
          lang: 'sql',
          code: `-- In reconciliation's own database, not the ledger's,
-- for the capture ...900418 (+120000 to FPS_CLEARING_GBP/7):
BEGIN;
INSERT INTO seen_txns (transaction_id)
VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900418')
ON CONFLICT (transaction_id) DO NOTHING;
-- 0 rows: a repeat; roll back and skip it

-- totals per logical account: all 16 rows, every cluster
UPDATE clearing_totals
   SET total = total + 120000, txns = txns + 1
 WHERE account = 'FPS_CLEARING_GBP' AND currency = 'GBP'
   AND day = '2026-11-12';
COMMIT;`,
          note: 'The transaction id is the dedupe key here, and the totals are kept per logical account, summing its 16 rows and its master in every cluster.',
        },
        {
          title: 'Beside this line: caches equal journal and holds, on a replica',
          lang: 'sql',
          code: `-- Every few minutes, one batch of accounts at a time.
-- Any row returned is a broken cache; expect none.
SELECT a.account_id, a.posted_balance, a.held_balance
  FROM accounts a
  LEFT JOIN (SELECT account_id, sum(total) AS s
               FROM account_period_totals
              GROUP BY account_id) t USING (account_id)
  LEFT JOIN (SELECT account_id, sum(amount) AS s
               FROM ledger_entries
              GROUP BY account_id) e USING (account_id)
  LEFT JOIN (SELECT account_id, sum(amount) AS s
               FROM pending_holds WHERE status = 'ACTIVE'
              GROUP BY account_id) h USING (account_id)
 WHERE a.account_id = ANY (<this batch of account ids>)
   AND (a.posted_balance <> coalesce(t.s, 0) + coalesce(e.s, 0)
     OR a.held_balance <> coalesce(h.s, 0));

-- and all posted balances sum to zero in each currency
SELECT currency, sum(posted_balance) FROM accounts
 GROUP BY currency HAVING sum(posted_balance) <> 0;`,
          note: 'Not on this line: reconciliation queries a replica directly. One MVCC snapshot sees a balance, its entries and its holds together, because the triggers wrote them in one transaction. Checked on PostgreSQL 18 without the period totals.',
        },
      ],
    },
    {
      id: 'files', from: 'files', to: 'recon', d: 'M1200,62 V168', label: 'statements',
      mode: 'external', via: 'SFTP', chip: 0.5,
      how: "Daily bank statements and scheme and card network settlement reports arrive as files, or through the bank's API where it has one.",
      delivery: 'Each file is checksummed and loaded once; a missing file raises an alert, not a silent skip.',
      alts: ['Intraday statement feeds by API.'],
      ways: [
        { name: 'SFTP', chosen: true, what: 'Daily bank statements and settlement reports arrive as files over SFTP. Each is checksummed and loaded once, and a missing file raises an alert.', pros: ['Every bank and scheme can send files.', 'Complete and final for the day.'], cons: ["A day's delay before an outside error shows.", 'A parser per file format.'] },
        { name: 'Intraday statement feeds by API', what: "The bank's API serves statement lines during the day, and reconciliation matches them as they arrive.", pros: ['Breaks found within the hour.', 'Fixes the same day.'], cons: ['Not every bank or scheme offers it.', 'Another integration per bank.'] },
        { name: 'Manual upload by finance', what: "Someone in finance downloads each statement from the bank's portal and uploads it.", pros: ['No integration to build.', 'Works with any bank.'], cons: ['A human step every business day, which will be missed.', 'Harder to show the file was not altered on the way.'] },
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
          code: `FPS_CLEARING_GBP (master and 16 rows, every cluster), 2026-11-12
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
      how: 'Statements and history are read from an asynchronous replica: ledger_entries for one account, newest first, 50 at a time through idx_ledger_account_created, continuing from the last row seen. Pending items are the account\'s ACTIVE holds, listed above them.',
      delivery: 'Read-only and repeatable. A page may lag the primary by a second, which a statement can tolerate.',
      alts: ['A search index fed from the topic, for filtering by payee or amount.', 'The primary, when a page must include a payment made a moment ago.'],
      ways: [
        { name: 'SQL read from a replica', chosen: true, what: "The Ledger API reads one account's entries from an asynchronous replica, newest first, 50 at a time, continuing from the created_at and entry_id of the last row seen.", pros: ['Takes statement load off the primary.', 'Cursor pages stay stable as new entries arrive.'], cons: ['A page may lag the primary by a second.', 'A payment made a moment ago may be missing.'] },
        { name: 'A search index fed from the topic', what: 'A search index built from ledger-events serves statements filtered by payee, amount or text.', pros: ['Filtering and text search that the database does poorly.', 'No statement load on any cluster.'], cons: ["A copy, behind by the topic's lag.", 'Another system to run and rebuild.'] },
        { name: 'The primary', what: "Read the page from the cluster's primary.", pros: ['Always current, including a payment made a moment ago.'], cons: ['Statement reads compete with payments for the primary.', 'Worth it only for the first page right after a payment.'] },
      ],
      reply: {
        id: 'page', label: 'entries',
        how: 'Up to 50 entries and a cursor for the next page, with the pending holds on the first page.',
        delivery: 'Cursor pagination: new entries arriving do not shift or repeat a page.',
      },
      examples: [
        {
          title: 'Statement history: first page and next page',
          lang: 'sql',
          code: `-- On an asynchronous replica: newest 50 entries for the wallet
SELECT entry_id, transaction_id, amount, currency, created_at
  FROM ledger_entries
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
 ORDER BY created_at DESC, entry_id DESC
 LIMIT 50;

-- Next page: older than the last row seen
SELECT entry_id, transaction_id, amount, currency, created_at
  FROM ledger_entries
 WHERE account_id = '5f0c2a9e-...081442'
   AND (created_at, entry_id)
     < ('2026-11-12 10:41:03.118+00', 7730512)
 ORDER BY created_at DESC, entry_id DESC
 LIMIT 50;`,
          note: "idx_ledger_account_created (account_id, created_at DESC) finds the account's newest rows first. The page continues from a position, not an offset; entry_id breaks a tie between two entries at the same time.",
        },
        {
          title: 'Pending items, shown above the first page',
          lang: 'sql',
          code: `SELECT hold_id, amount, currency, created_at, expires_at
  FROM pending_holds
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
   AND status = 'ACTIVE'
 ORDER BY created_at DESC;
-- e.g. b61c...0520  8240 GBP  "Card payment, USD 100.00, pending"`,
          note: 'There is no index on pending_holds by account in the owner\'s DDL; an account has few ACTIVE holds, but finding them needs one. Adding (account_id) WHERE status = \'ACTIVE\' is a small partial index; not tested.',
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
        { name: 'Ledger API', chosen: true, what: 'Once a break is understood and a second person approves, a correcting transaction is posted through the Ledger API like any other. It is idempotent on the break id.', pros: ['The same rules as every payment: it must balance in each currency.', 'Approving twice posts once.', 'The history keeps both the mistake and the fix.'], cons: ['One break at a time: slow for a large incident.', 'Needs a review tool for the second person.'] },
        { name: 'A reviewed bulk migration', what: 'For a large incident, a job builds all the correcting transactions, shows their effect, and runs once approved. Stripe corrects this way.', pros: ['Thousands of fixes in one reviewed step.', 'The effect is seen before anything posts.'], cons: ['A powerful tool that must itself be tested.', 'A mistake in it is a mistake at scale.'] },
        { name: 'Direct SQL on the database', what: 'An engineer changes the wrong rows in the database by hand.', pros: ['Fastest to do, if it were allowed.'], cons: ['The triggers refuse it: entries cannot be updated or deleted, holds cannot be deleted, and balances cannot be edited directly.', 'Getting round them needs a superuser, which leaves no record of the mistake or of who fixed it.'] },
      ],
      examples: [
        {
          title: 'Example call, after a second person approves',
          lang: 'text',
          code: `Post
{ "idempotency_key": "brk_1127",
  "entries": [
    { "account": "FPS_CLEARING_GBP_MASTER", "amount": 500,
      "currency": "GBP" },
    { "account": "SUSPENSE_GBP", "amount": -500, "currency": "GBP" }
  ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000901733",
     "status": "COMMITTED" }

Approved twice: the same call with key brk_1127
-> the same reply; posted once`,
          note: 'The bank shows 500p more paid out than the ledger. The other leg depends on the cause; here SUSPENSE_GBP (allow_negative TRUE) holds -500p until it is traced.',
        },
      ],
    },
    {
      id: 'export', from: 'replicas', to: 'archive', d: 'M760,400 V465 Q760,475 750,475 H615', label: 'old months',
      mode: 'write', via: 'export', chip: 0.75, cold: true,
      how: 'Off the hot path. Monthly, the oldest partition of ledger_entries (past 13 months) and of pending_holds (past 3 months, none ACTIVE) is exported from a replica to Parquet with its row count and sums, per-account totals are saved, then it is detached on the primary.',
      delivery: 'Write once per month; the partition is detached only after the counts match.',
      alts: ['Logical backups kept for the retention period.'],
      ways: [
        { name: 'Export', chosen: true, what: 'Monthly, the oldest partition is exported from a replica to Parquet with its row count and sums per currency, then detached on the primary once they match and the per-account totals are saved.', pros: ['No export load on the primary.', 'Counts and sums prove the file is complete.'], cons: ['A monthly job to watch.', 'Old statements are read from files.'] },
        { name: 'Logical backups kept for the retention period', what: 'Keep logical dumps of the database for as long as records must be kept, instead of monthly exports.', pros: ['Uses backup tooling the team already runs.'], cons: ['Not queryable: an old statement means restoring a dump.', 'The live tables still grow unless partitions are dropped.'] },
        { name: 'Export from the primary', what: "Run the monthly export on the cluster's primary instead of a replica.", pros: ['No replica needed for exports.'], cons: ['Reading a month, about 65 GB a day × 30 ÷ 4 clusters = about 490 GB a cluster, competes with payments.', 'A slow export on the primary can hold back cleanup of old row versions.'] },
      ],
      examples: [
        {
          title: 'Count and sum, save totals, then detach',
          lang: 'sql',
          code: `-- In November 2026, September 2025 passes 13 months old.
-- On a replica: what the exported files must match
SELECT currency, count(*) AS entries, sum(amount) AS net
  FROM ledger_entries_2025_09 GROUP BY currency;
--  GBP 2010118455 0;  EUR ...;  USD ...  (net 0 in each)

-- On the primary: each account's total for the month
INSERT INTO account_period_totals (account_id, period, total)
SELECT account_id, '2025-09', sum(amount)
  FROM ledger_entries_2025_09 GROUP BY account_id;

-- Then, only after the files' counts and sums match
ALTER TABLE ledger_entries
  DETACH PARTITION ledger_entries_2025_09 CONCURRENTLY;
-- later, run by the archive role, not the ledger's:
DROP TABLE ledger_entries_2025_09;`,
          note: "net is 0 per currency because every entry of one transaction gets the same created_at (now() is the transaction's start), so a transaction never spans two partitions. CONCURRENTLY takes only a SHARE UPDATE EXCLUSIVE lock on the parent. Counts illustrative.",
        },
        {
          title: 'Objects written',
          lang: 'http',
          code: `PUT /ledger-archive/cluster-2/entries/2025-09/part-0000.parquet
PUT /ledger-archive/cluster-2/entries/2025-09/part-0001.parquet
  (and so on: the month's entries for cluster 2, as Parquet)

PUT /ledger-archive/cluster-2/entries/2025-09/manifest.json
{
  "partition": "ledger_entries_2025_09",
  "entries": 2015331050,
  "net": { "GBP": 0, "EUR": 0, "USD": 0 },
  "files": [
    { "name": "part-0000.parquet", "sha256": "9c1e...e04a" }
  ]
}`,
          note: 'The manifest carries the counts, the sums per currency and a checksum per file, so the archive can be checked later without the database. 2 billion is about 260 million a day × 30 ÷ 4 clusters.',
        },
      ],
    },
  ],

  tour: [
    {
      title: 'A payment request arrives',
      text: "Bright Bakery Ltd pays its flour supplier £1,200 by Faster Payments, the UK's instant bank transfer. When the owner pressed Pay, the app made a one-off label for this payment, k7 (an idempotency key). It sends the amount as 120000 pence with k7 to the Banking API, so that if it has to send again, the bank can tell a resend from a new payment.",
      focus: ['client', 'api'],
      path: ['pay'],
      labels: ['£1,200, key k7'],
      story: {
        context: "The owner of Bright Bakery Ltd has just pressed Pay in the bank's app to settle invoice INV 3318 from Mill Lane Flour Ltd, from the bakery's GBP wallet. The bakery also has a USD wallet and a credit card with the bank, each its own account. The request is on its way to the Banking API over HTTPS.",
        problem: "Phones lose signal mid-request. If the request reaches the bank but the reply is lost, the app cannot tell whether £1,200 moved, and the natural thing is to send it again. To the bank, a resend looks exactly like a second payment.",
        consequence: "Without a way to tell a resend from a new payment, the bank would pay the supplier £2,400. The bakery would have to ask for £1,200 back, and the bank would carry the blame.",
        fix: "The app makes the key k7 (a random UUID) once, before the first attempt, stores it with the draft payment and sends it in the Idempotency-Key header on every attempt. The ledger stores the key with a unique constraint for 72 hours, so a repeat returns the first result (step 7). The cost: every client must make the key once and reuse it, so the SDKs do it for them.",
      },
      explain: [
        { q: "What is an idempotency key?", a: "A label the app makes once for one payment and sends with every attempt at it. \"Idempotent\" means doing something twice has the same effect as doing it once. Here k7 stands for a version 4 UUID, a value with 122 random bits, so two payments will not pick the same one by chance." },
        { q: "Why does the app make the key, not the bank?", a: "Only the sender knows that two requests are the same attempt. If the bank made a fresh id for each request it received, a resend would get a fresh id too and look like a new payment." },
        { q: "Why 120000 and not 1200.00?", a: "Amounts are stored as whole numbers of the smallest unit, pence for pounds and cents for dollars, with the currency beside them (minor units). Whole numbers add up exactly; decimal fractions in floating point do not." },
        { q: "What does the ledger serve besides this payment?", a: "It is the bank's central ledger: bank payments like this one, payroll, debit and credit card authorisations and settlements, and accounts in several currencies. The tour follows one bank payment; the card, FX and credit flows are in the connection details and the drills." },
        { q: "What is the Banking API?", a: "The bank's front door for this payment. It checks who is asking, then drives the payment through the ledger and Faster Payments. The app reaches it with POST /payments over HTTPS." },
      ],
    },
    {
      title: 'Authenticate and check',
      text: "Before any money moves, the Banking API runs its checks. It asks the owner to confirm with two separate proofs, such as the phone and a fingerprint (strong customer authentication). It checks the payee's name matches the account (Confirmation of Payee), scores the payment for fraud and checks limits. Nothing has touched money yet, so a failure here needs no undo.",
      focus: ['api'],
      path: [],
      labels: ['£1,200'],
      story: {
        context: "The Banking API holds the request: £1,200 from Bright Bakery's GBP wallet to Mill Lane Flour Ltd, sort code 12-34-56, account 12345678, key k7. The ledger has not been called.",
        problem: "The request might not come from the owner. The account number might be mistyped, or belong to a scammer posing as the supplier. The amount might be over the bank's own limit, which is lower than the scheme's £1 million.",
        consequence: "Money sent to the wrong account is hard to get back. Since 7 October 2024 the bank must reimburse consumers, micro-enterprises and charities who are tricked into paying a scammer by Faster Payments or CHAPS, up to £85,000 a claim.",
        fix: "Every check runs in the Banking API before the ledger is called: authentication, the name check, a fraud score and the bank's limit. A failure is simply a refusal to the app: no hold, nothing to void. The cost is a few calls to other services before every payment.",
      },
      explain: [
        { q: "What is strong customer authentication?", a: "A legal requirement, from the Payment Services Regulations 2017, to confirm the user properly when they start an electronic payment. The user proves two independent things, from something they know, something they have and something they are." },
        { q: "What is Confirmation of Payee?", a: "A UK name-checking service. Before paying, the bank asks the payee's bank whether the name typed matches the name on that account, and warns the user if it does not." },
        { q: "Why do all the checks come before the ledger?", a: "Nothing has been held yet, so a refused payment leaves nothing to undo. If the checks came after the hold, every refusal would need a void." },
        { q: "Whose limit is checked?", a: "The bank's. Faster Payments allows up to £1 million a payment, but each bank sets its own lower limit, and the Banking API checks that one. The ledger checks only money: the account's floor." },
      ],
    },
    {
      title: 'Place a hold',
      text: "The Banking API asks the Ledger API to hold the money, so two payments cannot spend the same pounds. A hold is a row in pending_holds, not a ledger entry: 120020p, the £1,200 plus a 20p fee, on Bright Bakery's GBP wallet. In one call the Ledger DB stores key k7, locks the wallet row, inserts the hold only if the money is there, and adds an outbox row. A trigger raises the wallet's held balance.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn'],
      labels: ['hold £1,200.20', '1 hold row'],
      story: {
        context: "The checks passed. The bakery's GBP wallet has a posted balance of 842000p (£8,420) and nothing held, so 842000p is available. The payment is 120020p in all. Faster Payments has not been asked yet.",
        problem: "Other payments and card authorisations on the same wallet may be in flight. If two of them each read \"£8,420 available\" and then each spend it, the wallet goes below zero. And the payment cannot be posted yet, because the scheme may still reject it.",
        consequence: "Without a hold, the bakery could spend the same money twice and the bank would be lending money it never agreed to lend. If any code path could place a hold without moving held_balance, or move a balance by hand, the caches would drift from the truth and every check built on them would be wrong.",
        fix: "One database transaction: SET LOCAL lock_timeout = '50ms' and statement_timeout = '250ms'; insert key k7; lock the wallet with FOR NO KEY UPDATE; insert hold ...0417 only if posted - held - 120020 >= -credit_limit (the wallet's limit is 0); add the outbox row; commit. The insert fires a trigger that adds 120020 to held_balance, so posted stays 842000 and available drops to 721980. If a path skipped the test, the CHECK valid_available_funds would refuse the row. The cost: one extra UPDATE, the wallet row locked about 1 to 2 ms, and a writer that waits 50 ms for the lock gives up and is retried.",
      },
      explain: [
        { q: "What is a hold?", a: "Money set aside for a payment that is not final: a row in pending_holds with an amount, a currency, an expiry and a status, ACTIVE until it is captured, voided or expires. While it is ACTIVE the money cannot be spent, but nothing is in the journal yet." },
        { q: "What are posted, held and available?", a: "posted_balance is the sum of the account's settled entries. held_balance is the sum of its ACTIVE holds. Available is posted minus held, plus the credit limit if it has one. Here: 842000 posted, 120020 held, 721980 available." },
        { q: "What is a trigger?", a: "A function the database runs by itself when a row is written, inside the same transaction. Here an AFTER INSERT trigger on pending_holds adds the hold's amount to held_balance. No code path can place a hold and forget the balance." },
        { q: "What does FOR NO KEY UPDATE do?", a: "SELECT ... FOR NO KEY UPDATE locks the rows it reads until the transaction ends, so a second payment on the same wallet waits its turn. It is the weakest lock that does this; unlike FOR UPDATE, it does not block the foreign key check that inserting a hold makes on the account." },
        { q: "What are lock_timeout and statement_timeout?", a: "lock_timeout = '50ms' makes a statement give up if it waits more than 50 ms for a lock; statement_timeout = '250ms' stops any statement running longer than 250 ms. Either rolls the transaction back, and the caller retries with the same key. A burst then fails fast instead of piling up." },
        { q: "What is PgBouncer transaction pooling, and why SET LOCAL?", a: "PgBouncer sits in front of PostgreSQL and lends each client a server connection for one transaction at a time, so thousands of clients share a few hundred connections. SET LOCAL lasts only to the end of the transaction, so the next client to get that connection does not inherit the timeouts." },
        { q: "What is the CHECK constraint?", a: "A rule the database checks on every row it writes: CHECK (allow_negative OR (posted_balance - held_balance) >= -credit_limit). A debit wallet has credit_limit 0, so available cannot go below zero; a credit card's can go down to minus its limit. It is the backstop if a code path forgot the funds test." },
      ],
    },
    {
      title: 'Commit on two machines',
      text: "The Ledger DB (the cluster's main copy, the primary) writes the hold to its log. It then waits until one of two standby copies, each in another data centre (zone), says it has saved that record too. Only then does it reply \"committed\" to the Ledger API, which tells the Banking API the money is held. If the primary died now, that standby would already hold it: nothing anyone was told is lost.",
      focus: ['db', 'replicas', 'ledger', 'api'],
      path: ['wal', '<wal', 'committed', 'result'],
      labels: ['log record', 'confirmed', 'committed', 'held'],
      story: {
        context: "The ledger function has done its work on the primary of the bakery's ledger cluster: key k7, hold b61c9a3e-0f47-4d2a-8c55-000000000417 (hold ...0417 from here on), the held_balance the trigger moved and the outbox row. All that is left is the commit.",
        problem: "The primary is one machine. As soon as it says \"committed\", the Banking API acts on it: it sends £1,200 to Faster Payments. If the hold existed only on that machine's disk and the machine were lost, the hold would go with it.",
        consequence: "The bank would have sent £1,200 with nothing held, and the bakery could spend the same money again before the capture. The books would no longer match the money at the bank.",
        fix: "Each primary streams its write-ahead log to two standbys, s1 and s2, in other zones, with synchronous_standby_names = 'ANY 1 (s1, s2)'. The commit returns once the record is flushed to the primary's own disk and either standby confirms it has flushed it too. The cost: assume about a millisecond more per commit, which also lengthens every hot row's lock. If both standbys are lost, commits wait, and this design stops writes on that cluster rather than drop to asynchronous replication.",
      },
      explain: [
        { q: "What is the primary, and what is a ledger cluster?", a: "The primary is the one copy of a cluster's database that accepts writes. A ledger cluster is one PostgreSQL primary with two synchronous standbys and read replicas. Phase 1 is one cluster; phase 2 splits businesses across more, 4 at this page's peak." },
        { q: "What is a synchronous standby?", a: "A full second copy of the database, on another machine, that receives the primary's log as it is written. The primary waits for its \"saved\" before finishing a commit. If the primary dies, a standby is promoted (step 13)." },
        { q: "What is another zone?", a: "An availability zone: a separate data centre in the same cloud region, with its own power and network. A whole region can still be lost, which is a separate trade-off." },
        { q: "What is the log record?", a: "Postgres writes every change first to its write-ahead log (WAL), an append-only file, and only then to the tables. The commit record in that log is what makes the hold permanent." },
        { q: "Where is the hold confirmed?", a: "In the Ledger DB, when the transaction commits. The Ledger API replies to the Banking API with COMMITTED and the wallet's figures: posted 842000, held 120020, available 721980. The Banking API records the payment as PENDING, held." },
      ],
    },
    {
      title: 'Send it to the scheme',
      text: "With the money held, the Banking API records the payment as \"sent\" and passes it to Faster Payments, which moves it to the supplier's bank. Here Faster Payments accepts it. Had no answer come back in time, that would mean \"unknown\", not \"failed\": the payment may have gone. So the hold would stay ACTIVE until the scheme confirms either way.",
      focus: ['api', 'fps'],
      path: ['send', 'ack'],
      labels: ['payment', 'accepted'],
      story: {
        context: "Hold ...0417 is committed: posted 842000p, held 120020p. The Banking API records payment pay_3fK9 as \"sent\" before the message leaves.",
        problem: "Faster Payments is someone else's system. It can accept, reject or say nothing. A timeout after sending is the dangerous case: the payment may or may not have reached the supplier's bank. Card networks are the same: an authorisation may settle days later, for a different amount, or never.",
        consequence: "If the bank treated a timeout as a failure and voided the hold, and the payment had in fact gone, the bakery could spend the £1,200 again. If it resent under a new id, the supplier could be paid twice.",
        fix: "The message carries payment id pay_3fK9, the same on every resend. On \"accepted\" the Banking API records SETTLED and calls Capture; on \"rejected\" it records FAILED and calls Void. With no answer the state stays PENDING (sent), the hold stays ACTIVE, and the API asks the scheme for the status of pay_3fK9. The hold's 7-day expiry is far longer than any status check. The cost: pending payments to track, and holds to watch for any that are never ended.",
      },
      explain: [
        { q: "What is a scheme?", a: "The shared system and rulebook banks use to move money between each other. Faster Payments is the UK's real-time scheme. Bacs (three working days) and CHAPS (high value, same day) are the other bank rails, and the card networks have their own." },
        { q: "Does the bank talk to Faster Payments directly?", a: "Directly, or through a sponsor bank: a member of the scheme that passes payments in for a firm that is not a direct member. Either way the payment id stays the same on every resend." },
        { q: "Why record \"sent\" before sending?", a: "If the Banking API crashed straight after sending, the recorded state tells a recovery worker that the money may have gone. The worker then asks the scheme instead of guessing." },
        { q: "How does a card payment fit this?", a: "The other way round: the card network asks the bank. An authorisation becomes a hold, say 8240p for USD 100.00 at a quoted rate plus a buffer. The settlement a day or two later captures it. If none comes by expires_at, the expiry job ends the hold." },
        { q: "Why does the Banking API talk to the scheme, not the ledger?", a: "The ledger only records money. If it called the scheme itself it would wait on an outside network while holding payment state, and a slow scheme would slow every balance read." },
      ],
    },
    {
      title: 'Capture: post the entries',
      text: "Faster Payments accepted, so the Banking API asks the Ledger API to capture the hold. In one statement the Ledger DB marks hold ...0417 CAPTURED and writes transaction ...900418, three entries that sum to zero: minus 120020p from the wallet, plus 120000p to Faster Payments clearing, plus 20p to fee revenue. Had the scheme rejected the payment, a void would have ended the hold and posted nothing.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['capture k7', '3 entries', 'committed', 'settled'],
      story: {
        context: "The scheme has accepted pay_3fK9, and the Banking API has recorded it as SETTLED on the payment. In the ledger, hold ...0417 is ACTIVE: posted 842000p, held 120020p. The journal has nothing for this payment yet.",
        problem: "The money must be posted once and only once, the hold must end at the same moment, and the record must stay readable for audit. The capture itself can be repeated, by a retry or by a recovery worker, and a void or the expiry job could race it.",
        consequence: "A capture that posted but left the hold ACTIVE would count the payment twice against the wallet. A repeated capture would pay the clearing account twice. A capture and a void both succeeding would post a payment the bank had already given back.",
        fix: "Capture with key k7:capture. The function locks the wallet, FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7 in account_id order, then runs one statement: a CTE updates the hold to CAPTURED only if it is ACTIVE, and the INSERT of the three entries joins to it. Either both happen or neither. The hold trigger lowers held_balance by 120020 and the entry trigger lowers posted_balance by 120020: posted 721980, held 0, available unchanged at 721980. A second capture, a late void or the expiry job finds the hold no longer ACTIVE and changes nothing. The cost: a status that changes, in pending_holds; the journal itself never changes.",
      },
      explain: [
        { q: "What does capture mean?", a: "Turning a hold into settled money: the hold is marked CAPTURED and the entries are posted, in one statement. The amount posted may differ from the hold: a card settlement at a better rate captures a hold of 8240p with entries of 7979p, and the rest is free again." },
        { q: "What is a void?", a: "The other outcome: the hold is marked VOIDED and held_balance falls back. Nothing is posted, so the statement shows no payment and no reversal. A hold leaves ACTIVE exactly once, so a void after a capture changes nothing." },
        { q: "What is a force-post?", a: "A card settlement that arrives with no live hold, or for more than was held. It posts as an ordinary transaction. If the account cannot pay all of it, this design takes it down to its floor and books the rest to CUSTOMER_RECEIVABLE_GBP, money the customer now owes." },
        { q: "Why do posted and held both move, and available not?", a: "The money was already counted against the wallet by the hold. At capture it moves from held to posted: held falls by 120020, posted falls by 120020, available stays at 721980." },
        { q: "How is an entry kept from being changed?", a: "A BEFORE UPDATE OR DELETE trigger on ledger_entries raises an error, so the statement fails whoever runs it. It does not stop TRUNCATE or DROP TABLE, so the ledger's role is also granted only INSERT and SELECT." },
        { q: "Why shard 7?", a: "FPS_CLEARING_GBP and FEE_REVENUE_GBP are busy system accounts, each 16 rows. The Ledger API picks the row by hash(transaction_id) % 16, which came to 7 for ...900418 (step 11)." },
      ],
    },
    {
      title: 'The app retries',
      text: "The phone lost signal before the Banking API's answer arrived, so the app sends the same request again with the same key, k7. The Banking API passes it on, and the Ledger DB finds k7 already stored, returns the saved result and writes nothing. The app gets back the same payment, pay_3fK9. No second hold, no second payment.",
      focus: ['client', 'api', 'ledger', 'db'],
      path: ['pay', 'post', 'txn', 'committed', 'result', 'accepted'],
      labels: ['retry, key k7', 'key k7', 'k7 exists', 'saved result', 'same result', 'same payment'],
      story: {
        context: "From the owner's side, they pressed Pay and the request timed out. Meanwhile the bank held, sent and captured pay_3fK9. The app knows none of that.",
        problem: "The resend looks exactly like a new request to pay Mill Lane Flour Ltd £1,200. Two retries could even arrive at the same moment.",
        consequence: "Treated as new, it would hold and pay a second £1,200 and take a second 20p fee, and the bank would have to chase the money back.",
        fix: "The hold function starts with INSERT INTO idempotency_keys ... ON CONFLICT (key) DO NOTHING. k7 is already there, so nothing is inserted; the function returns the result saved with k7 and stops. The hold id is made from the request too, so even without the key the hold's primary key would refuse a second hold ...0417. If two retries arrive at once, the unique key lets one insert win and the other waits, then returns the stored result. Keys are kept 72 hours: about 80 GB across all clusters.",
      },
      explain: [
        { q: "Why did the app send again at all?", a: "A network call needs a time limit, and after it runs out the app cannot know whether the request arrived. Sending again with the same key is safe, so the app does." },
        { q: "Where is k7 stored?", a: "In the idempotency_keys table on the bakery's ledger cluster, with a unique constraint, written in the same transaction as the hold. So the key exists if and only if the hold committed." },
        { q: "What does the app see?", a: "The same reply as the first time: 201 Created for payment pay_3fK9, status pending, read from the saved result. To learn that it has settled, it asks GET /payments/pay_3fK9." },
        { q: "Are there other guards behind the key?", a: "Two. The hold_id primary key refuses a second hold with the same id, and UNIQUE (transaction_id, account_id) on entries refuses posting a transaction twice to one account. The key comes first so a retry gets the saved answer instead of an error." },
        { q: "How long is a key kept?", a: "72 hours, at about 150 bytes each. Stripe says it may prune keys once they are 24 hours old; Brandur Leach suggests about 72." },
      ],
    },
    {
      title: 'Tell everyone else, safely',
      text: "Other services must hear about the payment, such as the one that notifies the owner. The capture's outbox rows were committed with the entries, so they exist only if money moved. The CDC relay reads them from the database's log and publishes events on ledger-events (a Kafka topic), keyed by account, and the owner gets a notification. There was never a separate write to Kafka that could be lost.",
      focus: ['db', 'relay', 'kafka', 'consumers'],
      path: ['cdc', 'publish', 'notify'],
      labels: ['outbox row', 'event', 'event'],
      story: {
        context: "Transaction ...900418 has committed, and with it outbox rows for hold.ended and transaction.posted. Nothing else knows yet: not notifications, fraud models, billing, the data warehouse or reconciliation.",
        problem: "The obvious way is to commit to the database and then publish to Kafka. Those are two writes with nothing joining them: a crash between them loses the event, and publishing first could announce a payment that then rolled back. Two-phase commit across both would hold locks across the network.",
        consequence: "The owner would not hear that the payment went, and fraud checks and reconciliation would miss it; or they would act on a payment that never happened.",
        fix: "The relay runs Debezium, which reads the Ledger DB's write-ahead log through a replication slot and receives only committed outbox rows, in commit order. Each becomes one event on ledger-events, keyed by the wallet's account_id and carrying the log position, lsn 249113864. A bank payment makes three events: hold.placed, hold.ended and transaction.posted. Delivery is at least once, so the notifications consumer skips anything at or below the last lsn it applied for that account. The cost: a connector to run, and a slot that holds log on the primary's disk until the relay catches up.",
      },
      explain: [
        { q: "What is CDC?", a: "Change data capture: reading committed changes from the database's own log, in the order they committed, and turning them into events. A change that rolled back never appears." },
        { q: "What is Debezium?", a: "An open-source change data capture tool. It connects to a database's change log, here through Postgres logical decoding, and emits each committed row change as an event with its log position." },
        { q: "What is a replication slot?", a: "Postgres's bookmark for one log reader. It records how far the relay has read and keeps the log from being deleted until then. If the relay stops, log piles up on the primary's disk, so the slot is watched." },
        { q: "What is Kafka, and why key by account?", a: "Kafka is a log service: messages are appended to a topic split into partitions, and each reader keeps its own position and can re-read. Messages with the same key go to the same partition, in order, so a hold's events never arrive after its capture's." },
        { q: "What if Kafka is down?", a: "The ledger carries on. Outbox rows wait in the database's log, and the relay catches up when Kafka returns." },
        { q: "Where do queues come in?", a: "In front of the ledger, for work that can wait: payroll lines, payouts, billing's nightly interest. A queue (Kafka or SQS) absorbs a spike and a worker feeds the Ledger API at a steady rate. Card authorisations cannot wait, so they never queue." },
      ],
    },
    {
      title: 'Read the balance',
      text: "The owner opens the app. The Ledger API reads the wallet's row from the primary, not a copy, so it is never out of date. The triggers kept it in the same transaction as the hold and the capture, so it already shows the payment: posted 721980p, held 0, available 721980p. Had a card payment been pending, it would show as held, and available would be lower.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['balance?', 'read row', 'accounts row', '721980p'],
      story: {
        context: "pay_3fK9 is captured. On the primary, the wallet's accounts row reads posted_balance 721980 and held_balance 0, with credit_limit 0.",
        problem: "The balance decides whether the next payment or card authorisation can go, and the owner relies on it. Adding up every entry and hold on each read would be slow and get slower as history grows. Reading a copy that trails could show money already spent. A balance anyone could edit would be worth nothing.",
        consequence: "A stale balance lets money be spent twice or hides a payment the owner just made. A slow one makes every authorisation slow. A hand-edited one breaks the books silently.",
        fix: "GetBalance reads one accounts row on the primary with a plain SELECT, which never waits for a writer's lock, and returns posted, held and available = posted - held + credit_limit. A guard trigger refuses any UPDATE of either balance that does not come from a trigger. Reconciliation checks every few minutes that posted equals the entries and held equals the ACTIVE holds. The table uses fillfactor 80, so the triggers' updates usually stay on the same page. The cost is read load on the primary; the whole table is under 300 MB, so it stays in memory.",
      },
      explain: [
        { q: "Which figure does the owner see?", a: "Both, as banks usually show them: the posted balance, what has settled, and the available balance, what can be spent. Between the hold and the capture they differed: posted 842000, available 721980." },
        { q: "And for a credit card?", a: "The same row shape. The bakery's card has credit_limit 500000. After a £649.00 purchase and 32p of interest its posted balance is -64932, meaning the bakery owes £649.32, and its available credit is 500000 - 64932 = 435068." },
        { q: "Why does the read not wait for a payment in progress?", a: "PostgreSQL keeps old versions of rows (MVCC, multi-version concurrency control). A plain SELECT reads the rows as last committed when it started. Row locks only make other writers wait, never readers." },
        { q: "How is a direct edit of a balance refused?", a: "A BEFORE UPDATE trigger on accounts raises an error if posted_balance or held_balance changed and pg_trigger_depth() is 1 or less. A direct UPDATE is at depth 1 inside the guard, a trigger's UPDATE at depth 2, so only the latter passes." },
        { q: "What are fillfactor and a HOT update?", a: "Fillfactor 80 fills each table page only to 80 per cent. An UPDATE writes a new row version; if it fits on the same page and no indexed column changed, it is a HOT (heap-only tuple) update and no index is touched. The balances are not indexed." },
        { q: "Why read the primary and not a replica?", a: "Replicas trail by milliseconds to seconds. That is fine for a statement, but a balance decides whether money can be spent, so it is always read from the primary." },
      ],
    },
    {
      title: 'Statements from a replica',
      text: "The owner scrolls down to the statement. The Ledger API reads it from a read-only copy that trails slightly behind (an asynchronous replica), 50 entries at a time, each page continuing from the last entry seen. Pending items come from the wallet's ACTIVE holds. A second of lag is fine for history, and it keeps these heavy reads off the primary.",
      focus: ['ledger', 'replicas'],
      path: ['history', 'page'],
      labels: ['next 50', '50 entries'],
      story: {
        context: "The owner has seen the balance and now opens the list of payments. History, unlike the balance, does not decide whether money can be spent.",
        problem: "Statements, history, billing runs and exports read many rows. On the primary they would compete with payments. Paging by offset (\"skip the first 50\") also shifts as new entries arrive, so a page can repeat or miss lines.",
        consequence: "Heavy statement reads would slow every payment on that cluster, against a target of 50 ms at the 99th percentile for a hold or capture. Offset pages would show the owner a payment twice or not at all.",
        fix: "Asynchronous replicas serve statements. The first page is the newest 50 ledger_entries rows for the wallet, found through idx_ledger_account_created (account_id, created_at DESC); the next asks for rows older than the last one seen, by created_at and then entry_id. Pending items are the wallet's ACTIVE holds, shown above the entries; a voided payment never appears at all. The cost: a page may lag the primary by about a second.",
      },
      explain: [
        { q: "What is an asynchronous replica?", a: "A read-only copy that receives the primary's log, but the primary does not wait for it. It usually trails by milliseconds and can fall seconds behind under heavy load." },
        { q: "Why is lag acceptable here but not for the balance?", a: "A statement only shows history. Nothing is decided from it, so being a second behind does no harm." },
        { q: "What does \"continuing from the last entry seen\" mean?", a: "Keyset (cursor) pagination. The next page is \"entries older than the last row seen\", by created_at and then entry_id, found through the index, not \"skip 50\"." },
        { q: "Why does a voided payment not show?", a: "A void ends the hold and posts nothing. The statement lists entries, which are settled money only, so a rejected payment leaves no line." },
        { q: "What is a partition?", a: "One piece of a table that PostgreSQL stores separately, chosen by a column. ledger_entries is split by created_at into one partition per month, so an old month can be detached and archived without a slow delete." },
      ],
    },
    {
      title: 'The hot account',
      text: "Every payment also touches the bank's own accounts, named by rail and currency, such as FPS_CLEARING_GBP and FEE_REVENUE_GBP. Each entry's trigger locks its account row until the commit, so with one row each, every payment would queue behind it. So each is 16 rows, shard_id 0 to 15: this capture hashed to 7. At the end of the day the Sweeper moves each set of 16 into a master account.",
      focus: ['ledger', 'db', 'sweeper'],
      path: ['txn', 'sweep'],
      labels: ['20p to fee row 7', 'sweep 16 into 1'],
      story: {
        context: "In step 6 the capture credited FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7. The wallet's row is touched only by its own payments, but these system accounts are touched by nearly every payment of their rail and currency. Card settlements hit MASTERCARD_DEBIT_CLEARING_USD, the FX pools and FX_FEE_REVENUE_GBP the same way; credit card spending and interest hit MASTERCARD_CREDIT_CLEARING_GBP and INTEREST_INCOME_GBP.",
        problem: "The trigger's UPDATE locks the account row until the commit, and the commit waits for a standby in another zone. Assuming 1 to 2 ms a lock, one row takes roughly 500 to 1,000 writes a second (an estimate). One cluster at peak takes about 2,500 payments a second. Fee revenue is never checked for a floor, but the trigger still locks it.",
        consequence: "Payments would queue behind a single row: their 50 ms lock_timeout would fire, they would be retried, and the retries would add load. The cluster's whole payment rate would be capped by one row.",
        fix: "Each system account is a logical account of 16 rows with allow_negative TRUE, and the Ledger API writes to shard_id = hash(transaction_id) % 16: about 156 writes a second on each row at the peak. At the end of the day the Sweeper posts one balanced transaction per logical account, locking the master and its 16 rows in account_id order and moving each row's total into the master, keyed by account and date. The cost: masters lag by up to a day, reports sum 17 rows, and with allow_negative TRUE no row can enforce a limit; reconciliation watches them.",
      },
      explain: [
        { q: "What is a hot account?", a: "An account in most transactions, such as fee revenue or a scheme clearing account. Its row becomes a queue, because only one writer can hold its lock at a time." },
        { q: "What are a logical account and shard_id?", a: "A logical account is a chart-of-accounts name, such as FPS_CLEARING_GBP. shard_id numbers its rows, 0 to 15; UNIQUE (logical_account, shard_id) keeps one row per number. Customer wallets and cards have no logical account and shard_id 0." },
        { q: "Why are system accounts named by currency too?", a: "No account ever holds two currencies, so each currency has its own pool, clearing account and revenue account. A transaction must sum to zero in each currency on its own." },
        { q: "What is an FX pool?", a: "The bank's own account per currency for exchanges. A card purchase in dollars paid from pounds credits FX_POOL_GBP and debits FX_POOL_USD. The pools drift apart, long pounds and short dollars, until treasury does a real FX trade, booked as a balanced transaction per currency." },
        { q: "Why does allow_negative TRUE matter here?", a: "A clearing account is credited by some payments and debited by others, and a split row can dip below zero even when the total is fine. With allow_negative TRUE the CHECK lets it, so limits on system accounts are reconciliation's job." },
        { q: "Why only once a day?", a: "The owner's choice. Every entry is already exact, so the master plus its 16 rows is always right. The sweep is tidiness, not safety, and once a day is one lock on each row instead of 1,440." },
      ],
    },
    {
      title: 'Reconciliation finds a break',
      text: "Overnight, Reconciliation compares the ledger's totals for Faster Payments clearing with the bank's own statement for it. Today they differ by £5. Locks cannot catch a wrong amount or a lost message, but this can. A break is raised with an owner, and once understood it is fixed by a correcting transaction through the Ledger API. No entry is edited.",
      focus: ['files', 'recon', 'kafka'],
      path: ['files'],
      labels: ['statement'],
      story: {
        context: "All day, Reconciliation has read ledger-events and kept its own running totals per logical clearing account, currency and day. For 2026-11-12 the ledger says FPS_CLEARING_GBP, its master and 16 rows summed over every cluster, totals 41380250p. Overnight the bank's statement file arrives over SFTP: 41380750p.",
        problem: "Locks and keys stop two writers racing. They do not stop a bug posting a wrong amount, a scheme message that never arrived, or a bank error, and the ledger agrees with itself even when it is wrong. Here 500p, £5, is unexplained.",
        consequence: "Unchecked, errors pile up: a customer spends money a bug wrongly gave them, and the books drift away from the real money at the bank. For payment and e-money firms, the FCA's CASS 15 rules expect safeguarded funds to be reconciled every business day.",
        fix: "Break brk_1127 is raised with an owner, the amount and the lines on each side that do not match. Once the cause is found and a second person approves, a correcting transaction goes through the Ledger API like any other, with key brk_1127, so approving twice posts once. The same checks also watch what the CHECK does not: the FX pools' drift, CUSTOMER_RECEIVABLE_GBP, and holds past their expiry. The cost: a team that owns breaks, and a day before an outside error is seen.",
      },
      explain: [
        { q: "What is reconciliation?", a: "Comparing your own record of money with an independent record of the same money. Here the ledger is checked against bank statements and settlement reports every business day, and against its own rules every few minutes: each currency sums to zero, posted equals the entries, held equals the ACTIVE holds." },
        { q: "What is FPS_CLEARING_GBP?", a: "The ledger's account for money owed out through Faster Payments: captures credit it, and the scheme's settlement with the bank debits it. The real money sits at a bank, which sends a statement every day." },
        { q: "What is a break?", a: "A difference between the ledger and an outside record that nothing explains. It gets an owner, an amount and evidence, and is closed by a correcting entry or by a fix outside the ledger." },
        { q: "Does reconciliation check credit cards too?", a: "Inside the ledger, the same way as any account. Billing also keeps its own breakdown of each card balance into fees, interest and principal, and reconciles its total to the card's posted_balance every night." },
        { q: "Why not just fix the wrong entry?", a: "A trigger refuses any update or delete of an entry. A correction is a new transaction, approved by a second person, so the history shows both the mistake and the fix." },
      ],
    },
    {
      title: "When a cluster's primary dies",
      text: "Later, the machine running one cluster's primary dies. A failover tool promotes a synchronous standby from step 4 to be the new primary; it already holds every hold and transaction anyone was told about. Writes to that cluster pause, with a target of under a minute. Requests that timed out are retried with the same keys, so none is applied twice.",
      focus: ['db', 'replicas'],
      path: ['wal'],
      labels: ['promote'],
      story: {
        context: "Some time later, one cluster's primary fails: a hardware fault, or its zone going dark. Every business on that cluster has payments in flight, holds waiting for capture and card authorisations arriving, and some clients are waiting for replies that will never come.",
        problem: "Nobody can write to that cluster until a new primary takes over. Some requests committed but their replies were lost; others never committed. The clients cannot tell which is which. Card authorisations cannot wait for the failover.",
        consequence: "If the new primary lacked recent commits, acknowledged holds and payments would vanish. If retries were treated as new requests, payments would be applied twice. A long pause stops every business on that cluster paying anyone.",
        fix: "Because every commit waited for a standby (step 4), a standby holds every acknowledged hold and transaction: recovery point zero. The failover tool promotes it, aiming for under a minute. Clients retry with the same keys: a write that committed finds its key and returns the saved result, and one that did not is applied once. Payroll and payouts wait in their queues. Card authorisations get a fast decline or the card processor's stand-in rules. The cost: writes to that cluster pause, and promotion needs a failover tool beside Postgres.",
      },
      explain: [
        { q: "What is a failover tool?", a: "A program run beside Postgres that watches each primary. When one fails, it promotes a standby and moves connections to it. Postgres does not make this decision on its own." },
        { q: "What does \"promote\" mean?", a: "Turning a standby, which until now only replays the primary's log, into the primary that accepts writes." },
        { q: "Which standby is promoted?", a: "One that has every acknowledged commit. The commit waited for either s1 or s2, so the tool must pick the standby furthest along the log." },
        { q: "What happens to a hold caught mid-flight?", a: "If it committed, it is on the new primary, still ACTIVE, and the payment carries on: capture or void as normal. If it did not, the retry places it now, once." },
        { q: "What if both standbys are lost?", a: "Commits on that cluster wait. The design then stops writes on that cluster and says so, rather than drop to asynchronous replication. Other clusters carry on." },
        { q: "What about losing a whole region?", a: "The standbys are in other zones of the same region. Losing the region risks the last seconds of data sent asynchronously to another region; the design names that trade-off." },
      ],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        "Whose money? Customer balances for a bank or e-money firm, a marketplace's internal ledger, or the company's own books? This page assumes a business bank's central customer ledger.",
        'Which products? This page takes bank payments, payroll, debit and credit card authorisations and settlements, and accounts in several currencies, all in one ledger.',
        'What does "strict consistency" mean here? I take it as: no customer account ever goes past its floor (zero, or minus its credit limit), no money is created or lost in any currency, and a read after a write sees it.',
        'How many writes, and how skewed? Average and peak, and whether some accounts appear in most transactions.',
        'Who owns credit card statements, interest and the order repayments pay things off? This page says a separate billing service; the ledger only posts what it is sent.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Record transactions of two or more entries that sum to zero in each currency, as signed integer minor units. No account holds two currencies.',
        'Hold funds for money in flight, then capture the hold into entries, void it, or let it expire; refuse any hold or debit that would take a customer account past its floor.',
        'Accept card force-posts that exceed the hold or the available money, without breaking the floor.',
        'Never apply the same request twice, whatever the client retries.',
        'Return posted, held and available (posted - held + credit limit) for every account, and statements of entries.',
        'Correct mistakes only by adding entries; publish every change for other services.',
      ],
    },
    {
      heading: 'How well',
      points: [
        'Assume 1,000 payments a second on average, 10,000 at peak. A bank payment is 2 write transactions (place the hold, capture it) and 3 entries: 2,000 and 20,000 write transactions a second. "TPS" on this page means write transactions a second.',
        'Target: a hold or capture in under 50 ms at the 99th percentile inside the ledger; no lock waited on for more than 50 ms.',
        'No acknowledged hold or transaction lost (recovery point zero); a cluster back within a minute.',
        'Balance reads always current; statements may lag by a second.',
        'Reconciled internally every few minutes and against the bank every business day.',
        'Simplified on this page: one bank, sterling rails plus one card network, illustrative FX rates and fees, no chargebacks or disputes, and no statement or interest logic (that is billing).',
      ],
    },
  ],

  numbers: [
    { what: 'Payments', assumption: '1,000 payments a second on average, ten times at peak (payroll, month end, batch files)', result: '86 million a day; build for 10,000 a second' },
    { what: 'Write transactions', assumption: 'two per bank payment: place the hold, then capture (or void) it', result: '2,000 a second on average, 20,000 at peak' },
    { what: 'Ledger transactions', assumption: 'one per settled payment (the capture); a void posts none', result: '1,000 a second on average, 10,000 at peak' },
    { what: 'Entries', assumption: 'three per bank payment: wallet, scheme clearing, fee (a card payment with FX has five)', result: '3,000 a second on average, 30,000 at peak; about 260 million a day' },
    { what: 'Hold writes', assumption: 'two per payment: the insert and the one status change', result: '2,000 a second on average, 20,000 at peak; about 86 million hold rows a day, 2.6 billion a month' },
    { what: 'Storage', assumption: 'about 250 bytes an entry and 150 bytes a hold, with indexes', result: 'about 65 GB of entries and 13 GB of holds a day' },
    { what: 'Hot data', assumption: '13 months of entries (statements, claims windows), 3 months of holds (disputes, support)', result: 'about 26 TB of entries and 1.2 TB of holds; about 7 TB on each of 4 clusters' },
    { what: 'Clusters', assumption: "the owner's estimate of 5,000 to 8,000 write transactions a second on one tuned primary; take the low end", result: 'one in phase 1 (the average fits); 20,000 ÷ 5,000 = 4 at the peak' },
    { what: 'One hot row', assumption: 'locked by a trigger until a synchronously replicated commit, assume 1 to 2 ms', result: 'estimate: 500 to 1,000 writes a second' },
    { what: 'System accounts', assumption: 'one cluster at peak, 10,000 ÷ 4 = 2,500 payments a second, all on one rail at worst, 16 rows each', result: 'about 156 writes a second on each row (unsplit: 2,500)' },
    { what: 'Wallet row', assumption: 'hold placed (held up), hold ended (held down), one entry (posted down)', result: '3 writes per bank payment on the customer\'s row' },
    { what: 'Trigger cost', assumption: 'one UPDATE per hold change and per entry: 2 + 3 per bank payment', result: '5,000 a second on average, 50,000 at peak; 12,500 a cluster' },
    { what: 'Idempotency keys', assumption: 'two per payment (the hold and the capture), kept 72 hours, about 150 bytes each', result: 'about 80 GB across all clusters' },
    { what: 'accounts table', assumption: '1.3 million customer rows (wallets per currency, cards), a few hundred system rows, about 130 bytes a row, fillfactor 80, two indexes', result: 'under 300 MB: always in memory' },
    { what: 'Events', assumption: 'hold placed, hold ended, transaction posted: three per bank payment, about 1 KB each', result: '3,000 a second on average (3 MB a second), 30,000 at peak (30 MB a second)' },
  ],

  framings: [
    {
      name: 'Phase 1: one ledger cluster',
      scale: 'from day one to the cluster\'s limit; the average here, 2,000 write transactions a second, fits',
      shape: "One PostgreSQL primary with two synchronous standbys and read replicas, PgBouncer in transaction mode, ledger_entries and pending_holds partitioned by month, system accounts split 16 ways by shard_id, timeouts, queues and the outbox. The same tables and functions as every later phase.",
    },
    {
      name: 'Phase 2: the same design, more clusters (this diagram)',
      scale: "up to the owner's estimate of about 5,000 to 8,000 write transactions a second a cluster (an estimate); 20,000 at this page's peak",
      shape: 'The phase 1 design pushed to its limit, then businesses split across ledger clusters, 4 at this peak, each with its own set of system accounts. A routing directory picks the cluster. A business stays on one cluster, so every payment is one local transaction.',
    },
    {
      name: 'Phase 3: TigerBeetle for the hot path',
      scale: 'extreme hot-account contention, or far beyond 20,000 write transactions a second',
      shape: "The hot debit and credit path moves to TigerBeetle: accounts and transfers, with pending (two-phase) transfers in place of pending_holds. PostgreSQL stays for user metadata, KYC, billing statements, search and reporting. There is no shared transaction between them, so the application orders its writes and reconciles one against the other.",
    },
    {
      name: 'Ledger of record for finance',
      scale: 'billions of events a day from many systems (Stripe reports five billion)',
      shape: 'Not on the payment path at all. Producers emit events; the ledger is an immutable log replayed into balances, and correctness is shown by clearing accounts returning to zero, not by locks.',
    },
  ],

  decisions: [
    { choice: 'Money in flight', a: 'A hold row in pending_holds, captured into entries or voided; ledger_entries holds settled money only.', b: "Pending entries through a clearing account (this afternoon's design), or a status column on entries.", call: 'Holds in their own table. Three entries and one journal transaction per payment instead of five and two, a rejection leaves no line, and card holds that settle for a different amount or expire need nothing extra. The price is a second table whose status changes once, enforced by a trigger, and held money that is in no journal account, so reconciliation checks holds separately. A status column was rejected because it makes the journal mutable.' },
    { choice: 'Balances', a: 'Two caches: posted_balance (entries) and held_balance (ACTIVE holds); available = posted - held + credit_limit.', b: 'One balance that already has pending money taken out.', call: 'Two. Customers and card rules need both figures, and each cache equals one simple sum that reconciliation can check. The price is two triggers and three writes on the wallet row per payment.' },
    { choice: 'Who keeps the balances', a: 'Triggers on ledger_entries and pending_holds, with a guard against direct edits.', b: 'The application runs the UPDATE beside each insert.', call: 'Triggers. The database refuses a wrong balance whatever code path writes. The price is logic in the database, and a break-glass step to rebuild a cache.' },
    { choice: 'Debit and credit', a: 'One schema: credit_limit on accounts and one CHECK, posted - held >= -credit_limit.', b: 'A separate credit ledger for cards and overdrafts.', call: 'One schema, as the owner asks. A wallet is a card with limit 0; repayments are ordinary transfers. The price: credit_limit is not guarded by the balance trigger, so column grants (only the credit service may update credit_limit, allow_negative and is_active) are the control, and lowering a limit below what is used is refused by the CHECK.' },
    { choice: 'Where the repayment waterfall lives', a: 'In the billing service: statements, grace periods, fees then interest then principal, and nightly interest posted as entries.', b: 'Sub-accounts per card for principal, interest and fees, so the ledger itself can say which is which.', call: 'Billing. One card account keeps rows and locks at one per card. The price: the ledger cannot tell interest from principal, so billing keeps that breakdown and reconciles its total to the card\'s posted balance nightly.' },
    { choice: 'Force-post past the floor', a: "Take what is available down to the floor and book the rest to CUSTOMER_RECEIVABLE_GBP (this design's choice).", b: 'A second, larger hard limit (an over-limit allowance) that force-posts may use.', call: 'The receivable. The CHECK stays one rule and the shortfall is visible as money owed, which collections chases. An allowance column would keep it on the card but needs a second CHECK and a rule for who may use it.' },
    { choice: 'allow_negative on system accounts', a: 'TRUE for every split system row, as the owner says.', b: 'FALSE, with limits per row.', call: 'TRUE. A split row is credited and debited by different payments and can dip below zero while the total is fine. The consequence: the CHECK protects nothing on those rows, so their limits are reconciliation\'s job.' },
    { choice: 'Currencies', a: 'One account per currency; a transaction sums to zero per currency; FX through a pool account per currency.', b: 'A single cross-currency entry carrying a rate.', call: 'Per currency. Every sum stays exact in its own unit. The pools drift and treasury rebalances with real trades; the rate lives on the payment record and the event.' },
    { choice: 'Hot accounts', a: '16 rows by shard_id, swept at end of day.', b: 'Continuous sweeps every minute, or an asynchronous balance for credit-only accounts.', call: 'End-of-day sweeps of split rows. The sum is always exact, so sweeping is tidiness; once a day is one lock per row instead of 1,440.' },
    { choice: 'Timeouts', a: "SET LOCAL lock_timeout = '50ms' and statement_timeout = '250ms' on every write transaction.", b: 'Default (no) timeouts.', call: 'Short timeouts. A timeout rolls back and returns TIMEOUT; the caller retries with the same key, so nothing is lost or doubled. Card authorisations then decline fast or use stand-in rules; payroll and payouts wait on their queue. Without timeouts one hot row can hold every connection.' },
    { choice: 'Concurrency control', a: 'Pessimistic: lock the accounts in account_id order with FOR NO KEY UPDATE, then one conditional statement, in one database call.', b: 'Optimistic: version check and retry on conflict.', call: 'Pessimistic. Optimistic retries collapse exactly when an account is busy, and the lock lasts only 1 to 2 ms because it never waits on the network.' },
    { choice: 'Partitioning', a: 'ledger_entries and pending_holds by month on created_at.', b: 'Unpartitioned tables, keys as written.', call: 'Partition both. The price: unique keys must include created_at, so UNIQUE (transaction_id, account_id) and the hold_id key guard only within a month, and idempotency_keys is the guard that holds across them.' },
    { choice: 'Events', a: 'Outbox row in the same transaction, read by CDC.', b: 'Two-phase commit, or publish after commit.', call: 'Outbox. 2PC holds locks across the network; a dual write loses or invents events on every crash.' },
    { choice: 'Database', a: 'PostgreSQL in phases 1 and 2, TigerBeetle for the hot path in phase 3.', b: 'TigerBeetle from day one.', call: 'PostgreSQL first: the team knows it and one database gives one transaction. Moving later shifts accounts, transfers and holds to TigerBeetle and leaves metadata, KYC, billing and reporting in PostgreSQL. What you give up: no transaction spans both, so a write to one and a record in the other can disagree after a crash, and the application must order its writes and reconcile them.' },
  ],

  drills: [
    { name: "A cluster's primary dies", what: 'Promote the synchronous standby: it has every acknowledged commit. Writes to that cluster pause; we target under a minute. Clients retry with the same keys; card authorisations decline fast or use stand-in rules.' },
    { name: 'Both synchronous standbys are lost', what: 'Commits on that cluster block. Stop accepting writes there and say so, rather than drop to asynchronous replication. Other clusters carry on.' },
    { name: 'The scheme times out after we sent', what: 'The payment is unknown, not failed. The hold stays ACTIVE; ask the scheme for its status with the same payment id, then capture or void.' },
    { name: 'A hold is never captured', what: 'The merchant never settles, or a payment worker died. The expiry job marks it EXPIRED once expires_at passes, and held_balance falls. An alert on the oldest overdue ACTIVE hold catches a stopped job.' },
    { name: 'A capture arrives after the hold expired', what: 'The hold is EXPIRED, so the capture updates 0 rows and posts nothing (HOLD_NOT_ACTIVE). The settlement is still owed to the network, so it posts as a force-post: an ordinary transaction, with any shortfall to CUSTOMER_RECEIVABLE_GBP.' },
    { name: 'A force-post exceeds the money, or the credit limit', what: 'A plain debit is refused by valid_available_funds (23514). Post what is available down to the floor, minus credit_limit, and book the rest to CUSTOMER_RECEIVABLE_GBP in the same balanced transaction. Collections chases it.' },
    { name: 'The same hold is captured twice', what: 'The second capture finds the hold CAPTURED, updates 0 rows and inserts 0 entries. Its key, if repeated, returns the first result; a capture and a void racing end the hold once, whichever commits first.' },
    { name: 'Lock timeouts storm on one wallet', what: "A business fires hundreds of payments at once at one wallet row. Each waits at most 50 ms for the lock and then fails with TIMEOUT; callers retry with the same key and back off. Move bulk work (payroll, payouts) onto the queue so it reaches the wallet one at a time; if it is a system row, raise its split from 16 to 32." },
    { name: 'The FX pools drift', what: 'FX_POOL_GBP grows and FX_POOL_USD goes negative as customers spend dollars. Nothing in the database stops it (allow_negative TRUE). Reconciliation reports the position per currency daily; treasury buys dollars and books it as one balanced transaction per currency.' },
    { name: 'A replay arrives in a new month', what: 'On the partitioned tables, the keys include created_at, so a replay with a new created_at would insert a second entry set or a second hold. idempotency_keys, inserted first, catches it. Keep keys long enough to cover the retry window, and make hold ids once per authorisation.' },
    { name: 'A cache disagrees with the journal', what: 'The check finds posted_balance not equal to its entries, or held_balance not equal to its ACTIVE holds. Suspect a trigger bypassed (session_replication_role = replica). Freeze the account and rebuild both columns in a reviewed break-glass change: SET LOCAL session_replication_role = replica, recompute posted from period totals and entries and held from ACTIVE holds, and audit who ran it.' },
    { name: 'Interest is posted twice', what: 'Billing reruns a night. The key interest:<card>:<date> is already in idempotency_keys, so the second call returns the first result. Billing also makes the transaction id from the same inputs, so UNIQUE (transaction_id, account_id) would refuse it too.' },
    { name: 'A credit limit is cut below what is used', what: 'The CHECK refuses the UPDATE: the card would already be past its new floor. Lower the limit only to the amount used, or leave it and stop new holds with is_active FALSE or a card control outside the ledger.' },
    { name: 'Payroll for 5,000 staff who bank here', what: 'One transaction of 5,001 entries locks 5,001 rows in id order. Whether it fits in the 250 ms statement_timeout is not measured. The fallback: chunks of a few hundred lines through PAYROLL_CLEARING_GBP, each chunk its own balanced transaction with its own key; the clearing account returns to zero when the run completes.' },
    { name: 'Kafka is down', what: "The ledger is unaffected. Outbox rows wait in the log; the relay catches up. Watch the primary's disk, because the replication slot holds log until it is read." },
    { name: 'The bank statement is £5 off', what: 'A break is raised with owner, amount and evidence. When the cause is found, a correcting transaction is posted and approved by a second person.' },
    { name: 'A whole region is lost', what: 'Synchronous standbys are in other zones of the same region, so a region loss risks the last seconds sent asynchronously to the other region. Name this trade-off out loud.' },
  ],

  interview: [
    'Open with the model before any boxes: accounts in one currency each, transactions of entries that sum to zero per currency, entries never changed, holds for money in flight. Signed integers in minor units. Then the invariants: every currency balances, and no customer account goes past its floor, zero or minus its credit limit.',
    'Do the sums early. 1,000 payments a second average and 10,000 at peak; a bank payment is two write transactions and three entries, so 20,000 write transactions a second at peak, about four clusters against the owner\'s estimate. The real limit is one hot row, 500 to 1,000 writes a second.',
    'Show the three tables: ledger_entries append-only, pending_holds with a status that changes once, accounts with posted and held kept by triggers, a guard, and the CHECK against the floor.',
    'Draw the write path: hold (timeouts, key, lock the account, conditional insert, outbox), send, capture as one statement, or void. Say what a void posts: nothing.',
    'Spend your depth on concurrency and hot accounts: locks in id order with FOR NO KEY UPDATE, 50 ms lock_timeout, system accounts by rail and currency split 16 ways, swept at end of day.',
    'Cards and FX: authorisation is a hold with an FX buffer, settlement captures it with five entries across two currencies, force-posts go to a receivable past the floor. Credit: same schema, credit_limit, billing posts interest.',
    'Be ready for the pushes: partitioning weakens the unique keys, so idempotency_keys guards across months; system rows with allow_negative TRUE are reconciliation\'s job; credit_limit needs column grants.',
    'Finish with proof and the path ahead: caches equal journal and holds, daily reconciliation, then the phases to TigerBeetle and what you give up: no shared transaction.',
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
    { label: 'PostgreSQL docs: Explicit locking (deadlocks)', href: 'https://www.postgresql.org/docs/current/explicit-locking.html', note: 'Acquiring locks in a consistent order is the best defence against deadlocks. FOR NO KEY UPDATE is taken by any UPDATE that does not take FOR UPDATE and does not block FOR KEY SHARE; row locks do not affect plain reads.' },
    { label: 'PostgreSQL docs: Heap-only tuples (HOT)', href: 'https://postgresql.org/docs/current/storage-hot.html', note: 'A HOT update needs no change to indexed columns and room on the same page; a lower fillfactor makes room more likely.' },
    { label: 'PostgreSQL docs: Table partitioning', href: 'https://www.postgresql.org/docs/current/ddl-partitioning.html', note: 'A unique or primary key on a partitioned table must include every partition key column; detaching or dropping a partition avoids a bulk DELETE.' },
    { label: 'PostgreSQL docs: ALTER TABLE (DETACH PARTITION CONCURRENTLY)', href: 'https://www.postgresql.org/docs/current/sql-altertable.html', note: 'CONCURRENTLY takes SHARE UPDATE EXCLUSIVE on the parent, cannot run in a transaction block, and is not allowed with a default partition.' },
    { label: 'PostgreSQL docs: Client settings (session_replication_role)', href: 'https://www.postgresql.org/docs/current/runtime-config-client.html', note: 'Set to replica, ordinary triggers do not fire; only superusers and users granted the right may change it. The same page documents lock_timeout and statement_timeout; their use here (SET LOCAL per transaction) was not re-read against it.' },
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
    { label: 'TigerBeetle: system architecture and data modelling', note: 'Read by the coordinator today: TigerBeetle sits beside a general-purpose database, with no shared transaction; the application orders its writes; transfer ids act as idempotency keys; change data capture to AMQP. The exact page for each point was not recorded.' },
    { label: 'PgBouncer: pooling modes', note: 'Transaction pooling returns the server connection at the end of each transaction, so session state must not be relied on. From memory; not read for this page.' },
  ],

  glossary: [
    { term: 'Double-entry', also: ['double-entry bookkeeping'], where: 'ledger', text: 'Every movement of money is recorded at least twice: where it came from and where it went. With signed amounts, the entries of one transaction sum to zero in each currency, so money is never created or lost by a write.' },
    { term: 'Entry', also: ['posting', 'ledger entry', 'leg', 'ledger_entries'], where: 'db', see: { id: 'append-log', label: 'Append-only log' }, text: 'One debit or credit to one account: a row in ledger_entries with transaction_id, account_id, a signed amount in minor units (plus a credit, minus a debit), currency and created_at. Settled money only. Entries are only ever inserted.' },
    { term: 'Transaction', also: ['journal entry', 'transfer'], where: 'ledger', text: 'A group of two or more entries that commit together and sum to zero in each currency. A bank payment is one (the capture, three entries); a card payment with FX is one of five entries in two currencies.' },
    { term: 'Hold', also: ['pending_holds', 'authorisation hold', 'reservation', 'pending'], where: 'fps', text: 'Money set aside but not settled: a row in pending_holds, ACTIVE until CAPTURED, VOIDED or EXPIRED. It raises the account\'s held_balance, so the money cannot be spent twice, and posts nothing to the journal.' },
    { term: 'Capture', also: ['settle', 'post a hold'], where: 'fps', text: 'Ending a hold as CAPTURED and posting its entries in one statement: both happen or neither. The posted amount may differ from the hold, as when a card settles at a better rate.' },
    { term: 'Void', where: 'fps', text: 'Ending a hold as VOIDED: held_balance falls back and nothing is posted. A rejected bank payment leaves no line on the statement.' },
    { term: 'Hold expiry', also: ['EXPIRED', 'expires_at'], where: 'sweeper', text: 'A job that marks ACTIVE holds past their expires_at as EXPIRED, through a partial index on ACTIVE rows, giving the money back. An expired hold cannot be captured.' },
    { term: 'Force-post', also: ['forced settlement'], where: 'fps', text: 'A card settlement that arrives with no live hold, or for more than was held or than the account has. It posts as an ordinary transaction; any shortfall past the floor goes to CUSTOMER_RECEIVABLE_GBP in this design.' },
    { term: 'Posted, held and available', also: ['posted_balance', 'held_balance', 'available balance', 'ledger balance'], where: 'db', text: 'posted_balance is the sum of the account\'s entries; held_balance is the sum of its ACTIVE holds. Available is posted - held + credit_limit: what can still be spent or borrowed.' },
    { term: 'Credit limit', also: ['credit_limit', 'arranged overdraft'], where: 'db', text: 'How far below zero a customer account may go: 0 for a debit wallet, the agreed amount for an overdraft or a credit card. The CHECK keeps posted - held at or above minus the limit. Set by the credit service; not covered by the balance guard, so column grants protect it.' },
    { term: 'Available credit', where: 'db', text: 'For a credit card, posted - held + credit_limit. The bakery\'s card with limit 500000 and posted -34932 has 465068 available.' },
    { term: 'Statement (credit card)', also: ['statement cut-off', 'billing cycle'], where: 'consumers', text: 'The monthly summary billing produces for a card: what was spent, what is owed and the minimum to pay by a date. The ledger knows nothing of cut-offs; billing works them out from entries.' },
    { term: 'Grace period', where: 'consumers', text: 'The time after a statement in which paying in full avoids interest. Billing\'s rule, not the ledger\'s.' },
    { term: 'Allocation waterfall', also: ['payment allocation'], where: 'consumers', text: 'The order a repayment pays things off: fees, then interest, then principal. Kept by billing, which records the split per statement; in the ledger a repayment is one credit to the card account.' },
    { term: 'Accrued interest', where: 'consumers', text: 'Interest built up day by day on what a card owes. Billing works it out and posts it nightly as a pair: debit the card, credit INTEREST_INCOME_GBP, with key interest:<card>:<date>.' },
    { term: 'Normal balance', also: ['debit normal', 'credit normal'], where: 'ledger', text: 'Which direction increases an account. A customer\'s wallet is money the bank owes, credit normal. This design stores one signed amount (plus a credit) and leaves the normal-balance view to reports.' },
    { term: 'Minor units', also: ['pence', 'cents', 'integer amounts'], where: 'ledger', text: 'Amounts stored as whole numbers of the smallest unit, such as pence or cents, with the currency beside them. Never floating point.' },
    { term: 'Logical account', also: ['logical_account', 'chart of accounts'], where: 'ledger', text: 'A chart-of-accounts name, such as FPS_CLEARING_GBP, stored on each of its rows. Callers name the logical account; the Ledger API picks the row. NULL for customer wallets and cards.' },
    { term: 'shard_id', also: ['split system account', 'sub-account', 'sharded counter'], where: 'sweeper', see: { id: 'hash-table', label: 'Hash table' }, text: 'The row number, 0 to 15, of a logical system account split 16 ways. Writes pick hash(transaction_id) % 16. Not to be confused with a ledger cluster.' },
    { term: 'Ledger cluster', also: ['cluster', 'shard by tenant'], where: 'ledger', see: { id: 'partitioning', label: 'Partitioning' }, text: 'One PostgreSQL primary with its standbys and replicas, holding a set of businesses and its own system accounts. One in phase 1, 4 at this page\'s peak in phase 2.' },
    { term: 'System account', also: ['house account', 'clearing account', 'FX pool', 'revenue account'], where: 'sweeper', text: 'The bank\'s own accounts, named by rail and currency: FPS_CLEARING_GBP, STRIPE_CLEARING_GBP, MASTERCARD_DEBIT_CLEARING_GBP, MASTERCARD_CREDIT_CLEARING_GBP, FX_POOL_GBP, FEE_REVENUE_GBP, INTEREST_INCOME_GBP and so on, each split by shard_id with allow_negative TRUE.' },
    { term: 'FX pool', also: ['FX_POOL', 'currency exchange', 'liquidity account'], where: 'recon', text: 'The bank\'s account per currency for exchanges. Pounds go into FX_POOL_GBP and dollars out of FX_POOL_USD, so each currency sums to zero on its own. The pools drift until treasury trades.' },
    { term: 'Hot account', also: ['hot row', 'hot key'], where: 'sweeper', text: 'An account in most transactions. Every entry\'s trigger locks its row, so it becomes a queue: only one writer can hold it at a time.' },
    { term: 'Sweep', also: ['end-of-day sweep', 'master account'], where: 'sweeper', text: 'An end-of-day balanced transaction moving each of a logical account\'s 16 rows into its master account. Bookkeeping, not safety: the sum is always exact.' },
    { term: 'Idempotency key', also: ['Idempotency-Key'], where: 'client', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'A unique value the client sends with a request so a retry is recognised. Stored in the same transaction as the write, with a unique constraint; a repeat returns the first result. Kept 72 hours.' },
    { term: 'Trigger', also: ['AFTER INSERT', 'BEFORE UPDATE'], where: 'db', text: 'A function the database runs by itself when a row is written, inside the same transaction. Here they keep entries append-only, move posted and held, let a hold change once, and guard the balances.' },
    { term: 'Trigger depth', also: ['pg_trigger_depth'], where: 'db', text: 'How many triggers deep the current statement runs. Inside the guard, a direct UPDATE is at depth 1 and a trigger\'s UPDATE at depth 2, so the guard refuses only the first.' },
    { term: 'CHECK constraint', also: ['valid_available_funds', 'valid_held_balance'], where: 'db', text: 'A rule the database checks on every row it writes. valid_available_funds keeps posted - held at or above minus credit_limit unless allow_negative; valid_held_balance keeps held at or above zero. A breach fails with SQLSTATE 23514.' },
    { term: 'allow_negative', where: 'db', text: 'A flag that switches off the floor for an account. FALSE for customer wallets and cards, TRUE for split system accounts, the FX pools and the receivable, whose limits are reconciliation\'s job.' },
    { term: 'Fillfactor', where: 'db', text: 'How full PostgreSQL fills each table page on insert. accounts uses 80, leaving a fifth free for new row versions.' },
    { term: 'HOT update', also: ['heap-only tuple'], where: 'db', text: 'An UPDATE whose new row version fits on the same page and changes no indexed column, so no index is touched. The triggers\' balance updates qualify when the page has room.' },
    { term: 'MVCC snapshot', also: ['MVCC', 'multi-version concurrency control'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'PostgreSQL keeps old versions of rows. A plain SELECT sees the rows as committed when its snapshot was taken, so it never waits for a writer.' },
    { term: 'CTE', also: ['common table expression', 'WITH'], where: 'db', text: 'A named sub-query, WITH name AS (...). The hold\'s CTE returns a row only if the money is there; the capture\'s CTE ends the hold, and the INSERT of entries joins to it.' },
    { term: 'FOR NO KEY UPDATE', also: ['SELECT FOR UPDATE', 'row lock', 'pessimistic locking'], where: 'db', see: { id: 'two-phase-locking', label: 'Two-phase locking' }, text: 'Reads rows and locks them until the transaction ends, so other writers wait. The weakest lock that does the job: it does not block foreign key checks from tables that reference the row.' },
    { term: 'Lock ordering', also: ['deadlock'], where: 'db', text: 'Taking locks on several rows in the same order everywhere, here ascending account_id. Two transfers in opposite directions then cannot each hold the lock the other wants.' },
    { term: 'lock_timeout and statement_timeout', also: ['SET LOCAL', 'timeout'], where: 'db', text: 'lock_timeout gives up a lock wait after 50 ms; statement_timeout stops a statement after 250 ms. Set with SET LOCAL at the start of each write transaction. A timeout rolls back; the caller retries with the same key.' },
    { term: 'PgBouncer transaction pooling', also: ['PgBouncer', 'connection pooling'], where: 'db', text: 'A pooler in front of PostgreSQL that lends a server connection to a client for one transaction at a time. Settings must be SET LOCAL so they end with the transaction.' },
    { term: 'Optimistic concurrency', also: ['version column', 'lock_version'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'Write only if the row\'s version is still the one you read; otherwise fail and retry. Retries pile up on busy rows.' },
    { term: 'Serializable isolation', also: ['SSI', 'serialization failure', '40001'], where: 'db', text: 'The database guarantees the result is as if transactions ran one at a time, aborting any that would break that. The application must retry those aborts.' },
    { term: 'Synchronous replication', also: ['quorum commit', 'synchronous_standby_names'], where: 'replicas', see: { id: 'leader-replication', label: 'Leader replication' }, text: 'The primary waits for a standby to confirm it has the log record before telling the client the commit succeeded. ANY 1 (s1, s2) waits for either of two.' },
    { term: 'RPO and RTO', also: ['recovery point objective', 'recovery time objective'], where: 'replicas', text: 'How much data a failure may lose, and how long recovery may take. A ledger wants a recovery point of zero; this design targets recovery in under a minute per cluster.' },
    { term: 'Consensus', also: ['Raft', 'Viewstamped Replication'], where: 'replicas', see: { id: 'raft', label: 'Raft' }, text: 'A protocol for a group of replicas to agree on the order of writes and on a new leader, so failover needs no operator. TigerBeetle uses Viewstamped Replication.' },
    { term: 'Two-phase commit', also: ['2PC', 'XA'], where: 'relay', see: { id: 'two-phase-commit', label: 'Two-phase commit' }, text: 'A coordinator asks every participant to prepare, then to commit. The owner rules it out: locks are held across the network and a lost coordinator leaves participants waiting.' },
    { term: 'Transactional outbox', also: ['outbox'], where: 'relay', see: { id: 'outbox', label: 'Transactional outbox' }, text: 'Writing the event to publish as a row in the same transaction as the change, and publishing it afterwards from that row. The event exists if and only if the change committed.' },
    { term: 'Change data capture', also: ['CDC', 'logical decoding', 'Debezium'], where: 'relay', text: 'Reading committed changes from the database\'s own log, in commit order, and turning them into events.' },
    { term: 'Shock-absorber queue', also: ['queue', 'SQS', 'backpressure'], where: 'kafka', see: { id: 'queue', label: 'Queue' }, text: 'A queue in front of the ledger for work that can wait (payroll, payouts, interest), fed to it at a steady rate. Card authorisations never queue.' },
    { term: 'Invariant check', also: ['trial balance'], where: 'recon', text: 'A query that must always hold: each currency sums to zero, posted equals period totals plus entries, held equals ACTIVE holds.' },
    { term: 'account_period_totals', also: ['period totals'], where: 'archive', text: 'This design\'s table of each account\'s total per archived month, written before the partition is detached, so a posted balance can still be checked after archive.' },
    { term: 'Break-glass rebuild', also: ['rebuild a balance'], where: 'recon', text: 'The only way to rewrite a cache: a reviewed change that sets session_replication_role = replica inside one transaction, recomputes posted and held from the journal and the holds, and is audited.' },
    { term: 'Reconciliation break', also: ['break', 'reconciliation difference'], where: 'recon', text: 'A difference between the ledger and an outside record, such as the bank statement. It gets an owner, an amount and evidence, and is closed with a correcting entry or a fix outside.' },
    { term: 'Safeguarding', also: ['CASS 15'], where: 'recon', text: 'For an e-money or payment firm, keeping customers\' money apart from the firm\'s own. Under the FCA\'s CASS 15 rules, in force from 7 May 2026, safeguarded funds are reconciled every business day.' },
    { term: 'Faster Payments', also: ['FPS'], where: 'fps', text: 'The UK\'s 24/7 real-time payment scheme, up to £1 million a payment at scheme level; each bank sets its own limit. Bacs takes three working days; CHAPS is for high-value same-day payments.' },
    { term: 'APP fraud reimbursement', also: ['authorised push payment'], where: 'api', text: 'Since 7 October 2024, payment firms must reimburse consumers, micro-enterprises and charities who fall for authorised push payment scams on Faster Payments and CHAPS, up to £85,000 a claim.' },
    { term: 'Keyset pagination', also: ['cursor pagination'], where: 'replicas', see: { id: 'b-plus-tree', label: 'B+ tree' }, text: 'Fetching the next page as "entries older than the last row I saw", by created_at and entry_id through idx_ledger_account_created, not an offset.' },
    { term: 'Partition', also: ['partitioning', 'DETACH PARTITION'], where: 'archive', see: { id: 'partitioning', label: 'Partitioning' }, text: 'One piece of a table stored separately, chosen by a column. ledger_entries and pending_holds are partitioned by month on created_at; an old month is detached and archived. Every unique key must then include created_at.' },
    { term: 'Two-phase transfer', also: ['pending transfer', 'post pending'], where: 'fps', text: 'TigerBeetle\'s built-in equivalent of a hold: a pending transfer, later posted (in full or in part) or voided, or timed out. The owner\'s phase 3 uses it in place of pending_holds.' },
    { term: 'Hash chain', also: ['tamper evidence'], where: 'db', text: 'Each entry stores a hash of its contents and the previous entry\'s hash, so changing any old entry breaks every hash after it. An option for tamper evidence; TigerBeetle hash-chains its data.' },
  ],
};
