import type { Design } from './types';

/**
 * Ledger service, as a high-level design.
 *
 * The question: "Design a ledger service that must ensure strict consistency
 * for account balances while supporting high-frequency transaction writes."
 *
 * The baseline is the central ledger of a UK business bank (an authorised
 * bank: balances are deposits): bank payments, payroll, debit and credit card
 * authorisations and settlements, and accounts in several currencies. About
 * a million businesses, 1,000 payments a second on average and 10,000 at
 * peak, a deliberate stress case. One PostgreSQL schema for debit and credit,
 * the owner's tables with the changes an expert review forced: an
 * append-only ledger_entries journal of settled movements under a
 * ledger_transactions header table whose caller-made primary key is the
 * lasting duplicate guard, a pending_holds table for money promised but not
 * yet settled, and an accounts table whose posted_balance and held_balance
 * are caches kept by triggers in the same transaction, guarded against
 * direct edits. A soft limit (credit_limit) is tested when a customer starts
 * a debit; a hard floor (hard_limit) is the CHECK. Writes lock account rows
 * first, in id order, with FOR NO KEY UPDATE under role-level timeouts. Busy
 * system accounts are named by rail and currency and split 16 ways by
 * shard_id, swept at the end of the day. Synchronous standbys, an outbox read
 * by change data capture, reconciliation against the bank's own accounts
 * (nostros) and the schemes, and a phased path that ends with the hot debit
 * and credit path in TigerBeetle.
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
        { name: "Idempotency key (version 4 UUID)", what: "A random identifier, 122 random bits, made once per payment and sent with every attempt. The ledger stores it under (client_id, key) with a hash of the request body, so a second request with the same key and body gets the first result, and the same key with a different body is refused, as Stripe does.", why: "A UUID needs no coordination with the server and will not collide by chance. Stripe accepts keys of up to 255 characters and suggests UUIDs. The ledger keeps keys 72 hours, about 100 GB across all clusters (two keys a payment: the hold's and the capture's). The lasting guard behind them is the transaction id, made from the key." },
      ],
      numbers: [
        { text: 'A version 4 UUID per payment. Stripe accepts keys of up to 255 characters and suggests UUIDs.', from: "Not a sum. The 255-character limit and the advice to use UUIDs are from Stripe's idempotent requests docs, cited on the page. A version 4 UUID has 122 random bits, so two clients picking the same key by chance is not a practical worry." },
      ],
      fails: 'A client that makes a new key on each retry defeats the whole scheme. Generate the key when the payment is drafted, store it with the draft, and reuse it.',
      alternatives: [
        {
          name: 'Client-chosen idempotency key per payment', chosen: true, good: 'The only party that knows two requests are the same attempt is the one that sent them.', cost: 'Every client must get it right, so the SDKs do it for them.',
          what: 'The app makes a UUID when the payment is drafted, stores it with the draft, and sends it as the Idempotency-Key header on every attempt. The ledger stores it, and keys made from it (k7:capture), under (client_id, key) in the same transaction as each write, for 72 hours. The transaction id is made from the same key, so the header table refuses a replay after the key is gone.',
          pros: ['Only the sender knows two requests are one attempt, so the sender names it.', 'A retry after a lost reply, like k7 on the tour, returns the saved result and moves no money, even when that result was a decline.', 'The same scheme works for the app, the web app and API partners.'],
          cons: ['Every client must make the key once, before the first attempt, so the SDKs do it for them.', 'A partner whose code makes a new key per retry can still pay twice, and the server cannot tell.', 'Keys must be kept: about 100 GB across all clusters for 72 hours.'],
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
      what: "The edge of the bank for payments. It authenticates the user (strong customer authentication for a payment), checks the payee with Confirmation of Payee, asks fraud and limit services, then runs the payment as a small state machine: place a hold in the ledger, send to the scheme, then capture the hold or void it. The payment record holds the state (PENDING, SETTLED or FAILED); the ledger shows only where the money is and what is held. Card authorisations reach the same kind of workflow from the card processor, payroll runs from the payroll API, and a separate billing service posts credit card interest accruals and charges straight to the Ledger API. Dual approval and the business's own payment limits live here too. It serves balance and statement reads by calling the ledger.",
      why: "The ledger should know about money, not about Faster Payments, Mastercard, statements or fraud. Keeping the orchestration and the payment state here lets the ledger stay a small, strict service with one job, and lets its entries stay append-only: a status that changes cannot live on a row that never changes. The hold's own status is the one exception, and it lives in pending_holds, not in the journal.",
      built: [
        { name: "Strong customer authentication", what: "A legal requirement to confirm the user with two independent proofs when they start an electronic payment, such as the phone and a fingerprint.", why: "Required by the Payment Services Regulations 2017. It runs before the ledger is called, so a failure leaves nothing to undo." },
        { name: "Confirmation of Payee", what: "A UK service that checks the name the user typed against the name on the payee's account, through the payee's bank, and warns on a mismatch.", why: "A payment sent to the wrong or a scammer's account is hard to recover, and the bank may owe up to £85,000 a claim under APP scam reimbursement. Checking first is far cheaper." },
        { name: "Payment workflow (a recorded state machine)", what: "Each payment is a row with a state: PENDING (with the step reached: held, then sent), SETTLED or FAILED. The API records each step before starting the next.", why: "A crash leaves a named state that a recovery worker can finish, repeating calls with the same idempotency key. With this few states, it needs less machinery than a workflow engine such as Temporal, which would add another system to the money path." },
        { name: "Dual approval and payment limits", what: "A business can require a second person to approve a payment or a payroll run over a set amount, and sets its own daily limits. Both are checked here, before the ledger is called.", why: "They are rules about people and permissions, not about money balancing. A payroll run places its hold only once it is approved, with an expiry past the pay date; it is debited on the Bacs processing day, and any returned line posts later as its own transaction linked by reverses." },
        { name: "Transaction ids made by the caller", what: "The API makes each ledger transaction id from the request: a UUIDv5 of its client id and the idempotency key (k7:capture), or, for money arriving from a scheme, of the rail and the scheme's own reference.", why: "The same request always gives the same id, so the header table's primary key refuses a replay for good, long after the 72-hour key is gone: headers are never deleted. A random id per attempt would make every replay look new." },
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
      what: "The UK's real-time payment scheme, open all day every day. The payment leaves the business's account and reaches the payee's bank in seconds. Card networks (Mastercard) and Bacs arrive the same way: someone outside answers later. A card authorisation is a hold; its settlement a day or two later is a capture, sometimes for a different amount or with no hold at all (a force-post). A Bacs payroll file is a balanced transaction to BACS_CLEARING_GBP. CHAPS is the high-value same-day rail. Each scheme settles with the bank later, which moves the bank's own account at the Bank of England (NOSTRO_BOE_GBP in the ledger).",
      why: "The scheme is outside your control. It can accept, reject or go quiet. The ledger has to represent \"we have promised this money but do not yet know the outcome\". Here that is an ACTIVE row in pending_holds, which raises the account's held_balance so the money cannot be spent twice, while the journal records only what settled.",
      built: [
        { name: "Faster Payments", what: "The UK's real-time payment scheme: the shared system UK banks use to send each other payments in seconds, all day, every day. Up to £1 million a payment at scheme level, raised from £250,000 in 2022; each bank sets its own lower limit.", why: "A business paying a supplier today wants the money there in seconds, any day. Bacs takes three working days and CHAPS is for high values in working hours." },
        { name: "A hold in pending_holds", what: "One row per hold: the account, the amount, the currency, a status (ACTIVE, then CAPTURED, VOIDED or EXPIRED) and expires_at. A trigger adds the amount to the account's held_balance when the hold is placed and takes it off when the hold ends. A new hold needs an OPEN account.", why: "Entries are never updated, so \"pending\" cannot be a status on an entry. A separate table of holds keeps the journal to settled money only, and the hold's status can change exactly once, which a trigger enforces. A void posts nothing: the journal never saw the payment." },
        { name: "Card networks and Bacs, the same shape", what: "A card authorisation is a hold of the network's billing amount in pounds plus a buffer; the settlement captures it and posts entries. Bacs payroll is a hold on approval, captured on the processing day. Incoming payments post directly, with no hold.", why: "One mechanism for every rail that answers later: hold, then capture, void or expire. Only the rail's own clearing account and timings differ." },
        { name: "Card FX on a sterling card", what: "For a purchase in dollars on a sterling card, the network converts and sends the cardholder billing amount in GBP. The bank holds that plus a buffer, captures what clears, and earns its non-sterling transaction fee as FX income. It does not quote a rate or buy dollars per purchase.", why: "A reviewer's reasoning plus a personal blog; not checked against scheme rules. A multi-currency card that settles with the network in USD would instead post through the FX pools, the owner's five-entry bridge." },
        { name: "Card lifecycle beyond one hold", what: "The card service keeps an authorisation record (authorised and cleared amounts, the network reference) and the holds are its children. An incremental authorisation is a further hold. A partial clearing captures the hold and places a new hold for the remainder in the same transaction. A refund is a credit posting with no hold. A chargeback is a provisional credit, then the scheme's outcome posts or reverses it.", why: "The ledger stays with one mechanism. A reversal the customer has already spent is a posting the bank must accept, so it uses the hard floor and the receivable. Interchange is income booked from the settlement report, not per purchase." },
        { name: "Direct Debits and returns", what: "A Direct Debit settles but can be reclaimed under the Direct Debit Guarantee, so a returned debit, like a returned Faster Payment, is a posting the bank must accept.", why: "Such postings use the hard floor, not the soft limit. A repayment restores credit at once only when the money that pays it is already final, as a transfer from the bakery's own wallet is." },
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
      what: "A stateless service in front of the ledger clusters. Its callers are the Banking API (bank payments, payroll), the card processor (authorisations and settlements) and the billing service (credit card interest). It checks that every transaction sums to zero in each currency, that each entry's currency is its account's, that amounts are whole minor units, and that accounts exist and are not closed. It finds the cluster from the business that owns the accounts, checks the transaction id the caller made from its request, turns each logical system account such as FPS_CLEARING_GBP into one of its 16 rows by shard_id = hash(transaction_id) % 16, splits any credit to an account that has a receivable so the receivable is paid first, then sends the write to the cluster as one call to a database function: ledger_hold, ledger_capture, ledger_void or ledger_post.",
      why: 'Rules about money belong in one place. Sending each write as a single call means row locks are held only for the time the database itself needs, about 1 to 2 ms with the commit, never across a network round trip.',
      built: [
        { name: "Ledger rules", what: "Checks applied to every write: signed amounts (plus a credit, minus a debit) sum to zero per currency, no account appears twice in one transaction, every entry's currency matches its account, amounts are whole minor units, every account exists and is not CLOSED.", why: "If every team linked its own copy of the rules, one bad deploy anywhere could unbalance the books. The database checks again: the hard floor on each account, the currency and status tests in the triggers, and the per-currency sum-to-zero trigger at commit." },
        { name: "Routing to ledger clusters", what: "A small directory table, one row per business (about a million, tens of megabytes), cached in memory, says which ledger cluster holds that business's accounts. In phase 1 there is one cluster and every row says so.", why: "Phase 2 splits businesses across clusters when one primary is no longer enough: 4 at this page's stress peak. Each cluster has its own set of system accounts. A payment between two businesses on different clusters becomes two local transactions joined by INTERCLUSTER_OUT on the payer's cluster and INTERCLUSTER_IN on the payee's: the second is driven by the outbox and keyed by the same transaction id, the pair must net to zero, and reconciliation watches the age of anything in flight. Clusters are never called shards here: shard_id means something else." },
        { name: "shard_id picked by hash", what: "Each busy system account, named by rail and currency, is 16 rows with shard_id 0 to 15. The Ledger API hashes the caller's transaction id and takes the remainder after dividing by 16. Customer wallets and credit cards are one row each, shard_id 0.", why: "Different payments land on different rows, so they rarely wait for each other's locks. The tour's capture hashed to 7, so it credits FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7. The same id always hashes to the same row, so a replay lands where the original did." },
        { name: "One call per write", what: "Small PL/pgSQL functions on each cluster. Each inserts the idempotency key, locks the account rows first, in account_id order, with FOR NO KEY UPDATE, then inserts the header and does its one conditional statement, writes the outbox rows and saves the result. Timeouts come from the role.", why: "The early exits (key already seen, not enough money, hold no longer ACTIVE) happen inside the database, so no lock waits on the network. Ten round trips of 0.5 ms would hold a hot row for 5 ms, about 200 writes a second on it at most." },
        { name: "Logical account and chart of accounts", what: "A chart-of-accounts name such as FPS_CLEARING_GBP, stored in accounts.logical_account. One logical system account is 16 rows; a customer account has none (NULL). A logical_accounts registry holds each name's class, currency and general ledger code.", why: "Callers name the logical account; the Ledger API picks the row. Reports and sweeps group by it. A daily summarised feed goes to the general ledger, where FX revaluation and profit and loss live. Currency exponents differ (JPY has 0 decimal places, BHD 3), so the registry, not the code, says what a minor unit is." },
      ],
      numbers: [
        { text: 'Ledger clusters: one in phase 1, 4 at this page\'s stress peak in phase 2.', from: "10,000 payments a second at peak × 2 database write transactions each (the hold and the capture) = 20,000 a second. The owner's estimate for one tuned PostgreSQL cluster is about 5,000 to 8,000 a second (an estimate, not measured here). 20,000 ÷ 5,000 = 4, taking the low end. The stress average, 2,000 a second, fits one cluster; a reasoned baseline of 100 to 250 payments a second fits it with room for years." },
        { text: 'Locks held about 1 to 2 ms per write: in-database work plus a commit that waits for a standby.', from: "An estimate. From the lock to the commit the function does a few small inserts and updates on rows already in memory (assume well under a millisecond), then the commit waits for one synchronous standby in another zone (assume about a millisecond). Not measured." },
        { text: "TigerBeetle's sum: a lock held across two round trips of 0.5 ms blocks that row for at least 1 ms, so about 1,000 writes a second on one row at most.", from: "From TigerBeetle's 'Rediscovering transaction processing', cited on the page: 2 round trips × 0.5 ms = 1 ms with the row locked; 1 second ÷ 1 ms = 1,000 writes a second on that row, at most. Real locks are held longer, so real figures are lower." },
      ],
      fails: 'It is stateless, so losing an instance loses nothing. A bug here is the real risk: a rule that lets through an unbalanced transaction or a wrong account. The database catches some of it on its own: the CHECK refuses a debit past the hard floor, the triggers refuse an entry in the wrong currency or to a closed account, and the deferred trigger refuses a transaction with fewer than two entries or one that does not sum to zero in every currency. It does not catch a path that skips the soft-limit test: that path could overspend by up to hard_limit - credit_limit.',
      alternatives: [
        {
          name: 'One database call per write (small functions)', chosen: true, good: 'Locks are held for in-database work plus the commit, not for network round trips.', cost: 'Some logic in PL/pgSQL, which needs the same review and tests as application code.',
          what: 'The Ledger API calls ledger_hold, ledger_capture, ledger_void or ledger_post once with the key, the ids and the signed entries. The function inserts the key, locks the account rows in account_id order, inserts the header, runs one conditional statement and writes the outbox rows, and the transaction commits. The role carries the timeouts.',
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
          pros: ['No extra network hop.', 'One fewer service to run and scale.', 'The triggers and the hard floor still protect the balances, whoever writes.'],
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
      what: "The source of truth, one per ledger cluster. ledger_transactions holds one header row per transaction: its caller-made id, kind, external reference, description and value date. ledger_entries holds settled movements only: one row per debit or credit, a signed amount in minor units with its currency, and is only ever inserted. Each transaction is two or more entries that sum to zero in each currency. pending_holds holds money promised but not settled: one row per hold, ACTIVE until it is CAPTURED, VOIDED or EXPIRED. accounts holds one row per account and currency with two caches, posted_balance (the sum of its entries) and held_balance (the sum of its ACTIVE holds), a soft credit_limit, a hard_limit and a status. Triggers keep both caches in the same transaction, a guard refuses any other change to them, and a CHECK keeps posted minus held at or above minus hard_limit. Idempotency keys and outbox rows are written in the same transaction too.",
      why: "Writing the hold or the entries, both balances, the key and the event in one local transaction is what makes the balance strictly consistent: a reader never sees entries without their balance change, and a retry never posts twice. Keeping the caches with triggers means no code path can forget them and no application role can edit them. Two limits, because some debits are the customer's choice (refuse them at credit_limit) and some are not (interest, fees, settlements, reversals: the bank must post them, as far as hard_limit).",
      built: [
        { name: "PostgreSQL", what: "An open-source relational database: tables, SQL, transactions that commit all or nothing, row locks, triggers and constraints.", why: "The team knows it, and the owner's phases keep it as the ledger until hot accounts dominate. In phase 3 it stays for account metadata, KYC, billing statements, search and reporting." },
        { name: "Primary", what: "The one copy of each cluster's database that accepts writes. Funds checks and balance reads also go to it.", why: "Only the primary is always current, and a balance is used to decide whether money can be spent. Its two synchronous standbys make sure losing it loses nothing." },
        { name: "ledger_transactions, the header", what: "New after the review, never partitioned. One row per transaction: transaction_id (primary key, made by the caller from the request), kind, external_ref, description, value_date, reverses, hold_id, created_by, created_at, and UNIQUE (kind, external_ref). Append-only by trigger. Every entry references it.", why: "It is the lasting duplicate guard: a replayed transaction id is refused by the primary key, and the same scheme reference under a new id by the unique key (both checked). It also gives statements a description, corrections a reverses link and postings a value date. Never deleted: when old entries are archived, the header stays on the cluster as the index of everything ever posted. About 100 bytes a row (an estimate), so it grows by about 3.1 TB a year at the stress load and does not shrink." },
        { name: "ledger_entries, append-only", what: "One row per entry: entry_id, transaction_id (a foreign key to the header, the only change to the owner's table), account_id, amount (BIGINT minor units, plus a credit, minus a debit, never zero), currency and created_at. A row trigger refuses UPDATE and DELETE; a statement trigger refuses TRUNCATE. UNIQUE (transaction_id, account_id) stops a transaction posting twice to one account.", why: "Corrections become new transactions, so the history shows both the mistake and the fix. Triggers do not stop DROP TABLE, so the ledger's role is granted INSERT and SELECT only, and archiving runs as a separate role." },
        { name: "pending_holds", what: "The owner's table, unchanged and unpartitioned: hold_id (primary key, made once per request, so a retry has the same id), account_id, amount (above zero), currency, status and expires_at. A trigger allows one change only: from ACTIVE to CAPTURED, VOIDED or EXPIRED, with nothing else altered. Only a hold that is no longer ACTIVE may be deleted, and only the archive role has DELETE.", why: "The owner's choice for money in flight. Unpartitioned, the hold_id primary key stays a real guard and ON CONFLICT (hold_id) works. A partial index on (account_id, expires_at) WHERE status = 'ACTIVE' (this design's addition) serves the expiry job and the pending list." },
        { name: "accounts, the balance cache", what: "One row per account and currency: logical_account, shard_id, account_type (USER_WALLET, CREDIT_CARD, RECEIVABLE, CLEARING, NOSTRO, FX_POOL, REVENUE), owner_account_id (a receivable's customer), allow_negative, posted_balance, held_balance, credit_limit, hard_limit, currency, status (OPEN, NO_NEW_SPEND, CLOSED). Created WITH (fillfactor = 80).", why: "A funds check reads one row. In PostgreSQL an UPDATE writes a new version of the row; if it fits on the same page and no indexed column changed, it is a HOT (heap-only tuple) update and no index is touched. The balances are not indexed. HOT and fillfactor help only while old versions can be pruned: no long transactions on the primary, idle_in_transaction_session_timeout set, and an alert on the oldest xmin. A reviewer saw one old open transaction grow a table of such rows from 8 pages to 469." },
        { name: "The triggers", what: "ledger_entries_apply (AFTER INSERT on entries) adds the amount to posted_balance, unless the account is CLOSED. pending_holds_placed (AFTER INSERT on holds) adds to held_balance, only on an OPEN account; pending_holds_ended (BEFORE UPDATE OR DELETE) takes it off, and refuses deleting an ACTIVE hold. Each refuses a row whose currency is not the account's. accounts_guard (BEFORE INSERT OR UPDATE) refuses an account opened with a balance, and a change to either balance at pg_trigger_depth() <= 1.", why: "A direct UPDATE fires the guard at depth 1 and is refused; a trigger's own UPDATE fires it at depth 2 and passes. Other columns, credit_limit, hard_limit and status among them, can still be changed, under column grants. The test sits inside the guard's function: in a WHEN clause a direct statement is at depth 0." },
        { name: "Soft limit and hard floor", what: "credit_limit is the soft limit: tested only when the customer starts a debit, in the hold's or payment's conditional insert, posted - held - amount >= -credit_limit AND status = 'OPEN', under the account lock. hard_limit is the floor the database enforces: CHECK (allow_negative OR (posted_balance - held_balance) >= -hard_limit), with CHECK (hard_limit >= credit_limit). Example values: a card 500000 and 550000; a debit wallet 0 and 0.", why: "Interest, fees, settlements larger than a hold, stand-in approvals and reversals are debits the bank cannot refuse; the owner's single CHECK at -credit_limit refused them. Now they post past credit_limit as far as hard_limit, and past that the rest goes to the customer's own receivable. The cost: the database backstop is the hard floor, not the exact limit, so a code path that skipped the soft test could overspend by up to hard_limit - credit_limit." },
        { name: "Sum to zero at commit, once per transaction", what: "ledger_transactions_balanced: a constraint trigger on the header row, DEFERRABLE INITIALLY DEFERRED, that runs once at COMMIT and raises an error unless the transaction has at least two entries and each currency sums to zero. Its query carries created_at = NEW.created_at, so a partitioned journal is probed in one partition.", why: "On, not optional. A transaction of -100 GBP and +100 USD nets to zero as numbers and is refused; so is a header with one entry or none (both checked). The owner had no such check; the first version here ran once per entry, which is quadratic: a reviewer measured 8.2 s for a 5,001-entry payroll. Once per transaction, that payroll committed in about 0.7 s on the WASM build of PostgreSQL." },
        { name: "Idempotency keys and outbox", what: "idempotency_keys: one row per (client_id, key) with a request_hash, inserted first in the same transaction, with the saved result. A decline is saved and committed too. outbox: one row per customer account the transaction touches, written in the same transaction.", why: "A key exists if and only if the call committed, so a retry returns the saved result, even a decline; the same key with a different body is refused. Kept 72 hours, about 100 GB across all clusters. A transfer between two customers needs a row for each, so each account's partition of the topic hears of it." },
        { name: "Column grants on accounts", what: "The ledger's role may INSERT accounts (at zero) and UPDATE only through the triggers; only the credit service's role may UPDATE credit_limit, hard_limit, allow_negative and status. DELETE and TRUNCATE on accounts are revoked.", why: "The guard covers posted_balance and held_balance only. Anyone with UPDATE on accounts could otherwise raise a card's limit or switch off its floor. Cutting credit_limit below what is already used is allowed, and new holds then place nothing (checked); hard_limit below credit_limit is refused (checked). The table owner or a superuser can still disable triggers, so DDL goes through review and is logged." },
        { name: "Timeouts and PgBouncer", what: "ALTER ROLE ledger_writer SET statement_timeout = '250ms' and SET lock_timeout = '50ms', applied when each server connection logs in, plus a deadline on every client call. Batch roles (sweep, payroll, archive) get longer values. Connections reach PostgreSQL through PgBouncer in transaction pooling mode.", why: "A writer that cannot get a lock in 50 ms gives up and frees its connection. SET LOCAL statement_timeout inside the ledger function does nothing for that call, because the timer starts when the client's statement arrives; the role setting does work (checked: a function sleeping 1 s was cancelled at 251 ms). statement_timeout does not bound the COMMIT's wait for a synchronous standby: only the client deadline does." },
      ],
      numbers: [
        { text: 'About 87 GB a day across all clusters at the stress load of 1,000 payments a second: about 65 GB of entries, 9 GB of headers and 13 GB of holds.', from: "Entries: 1,000 payments a second × 3 entries each (wallet, scheme clearing, fee) = 3,000 a second × 86,400 seconds = about 260 million a day × 250 bytes = about 65 GB. Headers: one per settled payment, 86 million a day × about 100 bytes (an estimate) = about 8.6 GB. Holds: 86 million a day × 150 bytes = about 13 GB. 250 and 150 bytes are assumptions: rows of about 90 bytes with their indexes. A card payment abroad is 3 entries like a bank payment; an FX conversion between wallets is 4." },
        { text: 'Assume 13 months of entries and 90 days of ended holds kept hot, and every header kept for good: about 30 TB in the first year, about 8 TB a cluster with 4 clusters, then about 3.1 TB more a year.', from: "Entries: 65 GB a day × about 395 days (13 months) = about 26 TB. Holds: 13 GB a day × about 92 days = about 1.2 TB. Headers: 8.6 GB a day × 365 = about 3.1 TB a year, never deleted. First year about 30 TB ÷ 4 clusters = about 7.6 TB each, and headers add about 0.8 TB a cluster each year after. At the reasoned baseline of 100 to 250 payments a second, headers grow about 0.3 to 0.8 TB a year in all. 13 months and 90 days are this design's assumptions. The archive job deletes about 86 million ended holds a day, each a dead row for vacuum." },
        { text: 'The accounts table: under 300 MB across all clusters, always in memory.', from: "1 million businesses with a GBP wallet, plus an assumed 20 per cent with a second currency and 10 per cent with a credit card = 1.3 million rows, plus a few hundred system rows (about 30 logical accounts × 16). × about 130 bytes a row (assumption) = about 170 MB; fillfactor 80 makes it about 210 MB; plus about 60 MB for the primary key and the (logical_account, shard_id) index. Receivables are rare and add little." },
        { text: 'Five trigger UPDATEs per bank payment: about 5,000 a second on average, 50,000 at peak, 12,500 a cluster.', from: "Per payment: 1 when the hold is placed (held_balance up), 1 when it is captured (held_balance down), 3 for the three entries (posted_balance). 5 × 1,000 = 5,000 a second; 5 × 10,000 = 50,000 at peak; ÷ 4 clusters = 12,500. Each is on a row the transaction already holds locked, and is HOT when the page has room. The balance check adds one query per transaction at commit, not per entry." },
        { text: 'The partial index on ACTIVE holds stays small: about 2 GB, against a table that gains 86 million rows a day.', from: "Bank payment holds last seconds. Assume 300 card authorisations a second held about 2 days before capture: 300 × 172,800 = about 52 million ACTIVE holds. × about 40 bytes an index entry for (account_id, expires_at) (assumption) = about 2.1 GB." },
      ],
      fails: 'The primary dies. A synchronous standby already holds every committed transaction, so it is promoted with nothing lost, provided the old primary is fenced first. Writes to that cluster pause for the failover, and clients retry with the same keys.',
      alternatives: [
        {
          name: 'Trigger-kept posted and held, account rows locked first, conditional insert', chosen: true, good: 'The database itself refuses a wrong balance whatever code path writes: nobody can forget the update, no application role can edit a balance, and the CHECK refuses a debit past the hard floor.', cost: 'Up to five extra UPDATEs per payment, and logic in the database where application developers may not look.',
          what: "Lock the account rows first, with SELECT ... FOR NO KEY UPDATE in account_id order, then touch holds. One statement inserts the hold only if posted - held - amount >= -credit_limit and the account is OPEN, or captures the hold and inserts the entries together. Each inserted entry or hold, and each ended hold, fires a trigger that moves its account's cache; the hard floor on accounts is the backstop.",
          pros: ['No code path can forget to move a balance, and no application role can move one by hand: the guard refuses a direct edit.', 'The hard floor refuses a debit past it even from a path that skips the soft test.', 'Every path locks account rows first, in id order, then holds, so a capture and a void cannot deadlock (checked with real concurrent sessions).', 'Readers never wait: a plain SELECT reads its own snapshot.'],
          cons: ['One extra UPDATE per entry and per hold change, inside the same transaction.', 'Logic in triggers, where application developers may not look.', 'A bulk load fires the triggers row by row.', 'The table owner or a superuser can still disable triggers (session_replication_role = replica), so those roles stay out of reach and DDL is reviewed.', 'A path that skips the soft test can overspend by up to hard_limit - credit_limit.'],
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
          pros: ['Batches of up to 8,189 transfers in one request.', 'No row locks, so hot accounts stop being a special case.', 'Consensus replication paid once per batch.'],
          cons: ['A specialised database with its own operations.', 'No transaction spans it and PostgreSQL, so the application orders its writes.', 'A transfer has one debit and one credit, so a three-entry capture becomes linked transfers, and each currency is its own ledger (reviewers\' knowledge, unverified).', 'No credit_limit column: limits are modelled with balance flags and funding transfers, and the triggers, guard and CHECK disappear, so those rules move into the Ledger API.', 'At this page\'s load, PostgreSQL with split system accounts copes.'],
        },
      ],
      say: "The journal holds settled money and never changes, under a header whose caller-made id refuses a replay. Holds live in their own table. posted_balance and held_balance are caches kept by triggers in the same transaction. The customer's own debits stop at credit_limit; debits the bank must accept may go on to hard_limit, which the CHECK enforces; past that, the customer's receivable. One schema serves debit wallets, overdrafts and credit cards.",
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
      why: 'A ledger cannot lose an acknowledged payment or an acknowledged hold. Synchronous replication means a commit is on two machines before anyone is told, so losing the primary loses nothing (a recovery point of zero). That holds for one failure at a time: lose the primary and the confirming standby together and it does not.',
      built: [
        { name: "Two synchronous standbys", what: "Full copies of the cluster's database on other machines that receive its write-ahead log; the primary waits for at least one of them to confirm before a commit returns. Postgres: synchronous_standby_names = 'ANY 1 (s1, s2)'.", why: "Recovery point zero. Waiting for one of two, not both, means losing one standby does not stop writes. The price is assumed to be about a millisecond more per commit." },
        { name: "Write-ahead log (WAL) streaming", what: "Postgres writes every change first to an append-only log and then to its tables. Standbys stay in step by receiving that log as it is written.", why: "It is how stock Postgres replicates, so there is no new database to run." },
        { name: "Availability zones", what: "Separate data centres in the same cloud region, each with its own power and network.", why: "Standbys in other zones survive the loss of the primary's zone. They do not cover the loss of a whole region, which the design names as a trade-off." },
        { name: "Asynchronous read replicas", what: "Further read-only copies that receive the log without the primary waiting for them. They trail by milliseconds, or seconds under heavy load.", why: "Statements, history, billing and exports read from them, so that load stays off the primary. Funds checks never do, because a copy that trails could show money already spent." },
        { name: "Failover tool, fencing first", what: "A tool beside PostgreSQL that watches the primary and promotes a standby. It fences the old primary (cuts it off so it can take no more writes) before it promotes.", why: "Two primaries taking writes would split the books. A commit waiting for a standby also holds its row locks, so the runbook never cancels such backends: a cancelled one returns success with a warning that it may not be replicated." },
        { name: "Keeping events in step with failover", what: "synchronized_standby_slots (PostgreSQL 17 and later) makes logical decoding wait until the standbys have a commit, and the Debezium slot is created as a failover slot, so it exists on the promoted standby.", why: "Without them the relay could publish an outbox row whose commit no standby has, which a failover would then lose. A reviewer checked part of this on PostgreSQL 16 and read Gunnar Morling's write-up on PostgreSQL 17 failover slots; these settings were not run here." },
      ],
      numbers: [
        { text: 'Postgres: synchronous_standby_names = ANY 1 (s1, s2), a quorum of one in two.', from: 'Not a sum. The setting is from the PostgreSQL replication docs, cited on the page: ANY 1 (s1, s2) waits for at least one of the two listed standbys.' },
        { text: 'Read replicas lag by milliseconds to seconds: fine for a statement, never for a funds check.', from: 'An assumption, not a measurement: asynchronous replicas usually trail by milliseconds and fall seconds behind under heavy writes or long queries. The rule that funds checks read the primary does not depend on the exact figure.' },
      ],
      fails: 'If both synchronous standbys are lost, commits wait, and each waiting commit keeps its row locks, so every touched row queues behind it. Decide in advance: stop writes on that cluster (our choice) rather than quietly fall back to asynchronous replication. Never cancel the waiting backends, because a cancelled commit reports success with only a warning; fence the primary and restore a standby.',
      alternatives: [
        {
          name: 'Synchronous quorum standbys plus async read replicas', chosen: true, good: 'No loss on failover, and reads that tolerate lag are taken off the primary.', cost: 'Every commit waits for a round trip to another zone: assume about a millisecond more.',
          what: "Each cluster's primary streams its log to two standbys in other zones and waits for either one to confirm before the commit returns. Further asynchronous replicas serve statements, history and exports.",
          pros: ['No acknowledged payment lost on failover: recovery point zero, for one failure at a time.', 'A quorum of one in two, so losing one standby does not stop writes.', 'Statements and exports are read off the primary.', 'Stock Postgres, no new database.'],
          cons: ['Every commit waits for a round trip to another zone: assume about a millisecond more.', "That millisecond is also added to every hot row's lock time.", 'If both standbys are lost, commits wait with their locks held; this design fences and stops writes on that cluster.', 'Promotion needs a failover tool that fences first, and the CDC slot must survive it.'],
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
      say: 'Recovery point zero, for one failure at a time: a hold or a payment is acknowledged only once it is on two machines in two zones. The failover tool fences before it promotes. Reads that can be a little stale go to replicas; funds checks never do.',
      see: [{ id: 'leader-replication', label: 'Leader replication' }, { id: 'quorum', label: 'Quorum' }, { id: 'raft', label: 'Raft' }],
    },
    {
      id: 'sweeper',
      name: 'Sweeper',
      tech: 'sweeps, expiry',
      x: 1042, y: 190, w: 124, h: 56, kind: 'node',
      what: "Looks after the system accounts that most payments touch, the holds nobody ended, and the end of each business day. System accounts are named by rail and currency (FPS_CLEARING_GBP, MASTERCARD_DEBIT_CLEARING_GBP, MASTERCARD_CREDIT_CLEARING_GBP, NOSTRO_BOE_GBP, FX_POOL_GBP, FEE_REVENUE_GBP, INTEREST_INCOME_GBP and so on; the owner's STRIPE_CLEARING_GBP would be the clearing account for an acquirer or processor we pay out through), and each busy one is 16 rows, shard_id 0 to 15, with allow_negative TRUE. At the end of each business day the Sweeper moves each logical account's 16 rows into its master account with one balanced transaction and writes the day's balances. Every minute it also marks as EXPIRED any ACTIVE hold whose expires_at has passed, one account at a time, which gives the money back to the customer.",
      why: "Every entry fires the trigger's UPDATE on its account row, and that row stays locked until a synchronously replicated commit, so one row takes one writer at a time: roughly 500 to 1,000 writes a second (an estimate). One cluster at the peak takes about 2,500 payments a second, so a single FPS_CLEARING_GBP row would be past its limit. Holds are the other loose end: a card authorisation the merchant never settles would otherwise keep the customer's money held for ever.",
      built: [
        { name: "Hot accounts", what: "System accounts that nearly every payment of one rail and currency touches: the scheme clearing accounts, the card network clearing accounts, the nostro that incoming payments credit from, the FX pools, fee and interest revenue.", why: "One row takes one writer at a time, about 500 to 1,000 writes a second (an estimate). Customer wallets and cards are touched only by their own payments, so they stay one row each." },
        { name: "16 rows by shard_id", what: "Each logical system account is 16 rows with shard_id 0 to 15; uq_logical_shard makes the pair (logical_account, shard_id) unique. The Ledger API writes to shard_id = hash(transaction_id) % 16.", why: "At 2,500 payments a second on one cluster, about 156 writes a second land on each row, well under one row's estimated limit. If lock waits climb, 16 can go to 32 with nothing else changing." },
        { name: "End-of-day sweep", what: "Once a day, per logical account, one balanced transaction locks the master (its own logical account, such as FEE_REVENUE_GBP_MASTER) and the 16 rows in account_id order, debits each row by its posted balance and credits the master with the total. Its header has kind SWEEP and external_ref the account and the business date.", why: "The owner's choice. Every entry stays synchronous and every balance exact as a sum, so the sweep is bookkeeping, not a safety need: the rows may go negative anyway. Reports sum the master and its rows. A rerun of the same date finds the header already there and does nothing." },
        { name: "Hold expiry job", what: "Every minute, one account per transaction: lock the account row, then mark up to 50 of its due ACTIVE holds EXPIRED, through the partial index on (account_id, expires_at) WHERE status = 'ACTIVE'. The hold trigger takes each amount off held_balance.", why: "Account first, as every other path does, so it cannot deadlock with a capture or a repayment (checked: racing repayments for 3 seconds, it expired 4,000 holds with no deadlock and no lock timeout). An expired hold cannot then be captured: a late settlement must post as a force-post." },
        { name: "Business date and end of day", what: "Each transaction carries a value_date. A cut-off calendar in Europe/London says when one business date ends. After the cut-off a job writes account_balances_daily (account, business date, posted, held).", why: "Statements, interest, the Single Customer View and reconciliation all read that table, not the live rows. End of day is a date, not a stop: payments carry on, dated the next business day." },
      ],
      numbers: [
        { text: 'One cluster at peak: about 156 writes a second on each row of a split system account.', from: "10,000 payments a second at peak ÷ 4 clusters = 2,500 a cluster. A bank payment writes FPS_CLEARING_GBP once and FEE_REVENUE_GBP once, at the capture; the hold touches no system account. Worst case, every payment uses the same rail: 2,500 ÷ 16 rows = about 156 writes a second on a row, against 500 to 1,000 estimated for one row. Unsplit, the row would take 2,500." },
        { text: "A master account is up to a day behind; the sum of master plus its 16 rows is always exact.", from: 'The sweep runs once a day, so the master misses up to a day of entries. The sum is exact because every entry is written synchronously, in its own transaction, to one of the 16 rows.' },
        { text: 'The sweep is small: a few dozen transactions a day per cluster, each of 17 entries at most.', from: "About 30 logical system accounts (assumption) × 1 sweep a day = 30 transactions. Each debits up to 16 rows and credits the master once: 17 entries." },
      ],
      fails: 'If the sweep stops, nothing is wrong, only untidy: balances sit in the 16 rows, and reports read the master plus its rows. If the expiry job stops, held money is not released, and customers see less available than they should: an alert on the oldest overdue ACTIVE hold catches it. If the end-of-day job stops, statements and interest wait for it; payments do not.',
      alternatives: [
        {
          name: '16 rows by shard_id, swept at end of day', chosen: true, good: 'Spreads the writes, keeps every entry synchronous and every balance exact, and sweeps once a day.', cost: 'Reports must sum 17 rows per logical account, and masters lag by up to a day.',
          what: "Each system account, named by rail and currency, is 16 rows with allow_negative TRUE. A write picks one by hash(transaction_id) % 16: the tour's capture hashed to 7. At the end of the day one balanced transaction per logical account moves each row's total into its master.",
          pros: ['Spreads about 2,500 writes a second a cluster to about 156 a row.', 'Every entry stays synchronous and every balance exact as a sum.', 'Ordinary ledger transactions: no new system.', 'Going from 16 to 32 rows changes nothing else.'],
          cons: ['Reports must sum the master and its rows, in every cluster.', 'The split count is a tuning knob to watch.', 'allow_negative TRUE means no row can enforce a limit; reconciliation watches them.'],
        },
        {
          name: 'Continuous sweeps (every minute)', good: 'Masters are never more than a minute behind.', cost: '1,440 sweeps a day per account, each one more writer on the hot rows.',
          what: "An earlier version of this design: a sweep per account every minute, keyed by account and minute.",
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
      what: "Reads committed outbox rows from the database's write-ahead log through a replication slot, and publishes each as an event on the ledger-events topic, keyed by account. There is one outbox row per customer account a transaction touches.",
      why: 'Writing to the database and then to Kafka is two writes with no transaction around them: a crash between them loses an event or announces a payment that rolled back. The outbox row commits with the hold or the entries, and the relay publishes only what committed, in commit order. This is the owner\'s rule: outbox, not two-phase commit.',
      built: [
        { name: "Change data capture (CDC)", what: "Reading committed changes from a database's own log, in commit order, and turning each into an event.", why: "Polling the outbox table instead can miss or reorder rows from concurrent commits, and adds queries to the primary." },
        { name: "Debezium", what: "An open-source change data capture tool. It connects to a database's change log and emits every committed row change as an event, with the row before and after and its log position. It is commonly run alongside Kafka.", why: "It already does the hard parts: reading Postgres's log through logical decoding, keeping its place in a replication slot, and resuming after a restart. The cost is a connector to run and upgrade." },
        { name: "Logical decoding and a replication slot", what: "Logical decoding is Postgres turning its write-ahead log back into row changes for an outside reader. A replication slot is the bookmark for one reader: it records how far it has read and keeps the log until then.", why: "Only committed rows arrive, in commit order, and a restarted relay resumes where it left off, repeating at most a little. The catch: a stuck relay makes the slot hold log on the primary's disk, so the slot is watched. The slot is a failover slot, and synchronized_standby_slots holds decoding back until the standbys have the commit (PostgreSQL 17 and later; not run here)." },
      ],
      numbers: [
        { text: 'About 3,000 events a second on average; assume about 1 KB each: about 3 MB a second, 30 MB at peak.', from: "Three events per bank payment: hold.placed (from the hold), hold.ended and transaction.posted (both from the capture); the payment touches one customer account. 1,000 payments a second × 3 = 3,000 events a second × an assumed 1 KB = about 3 MB a second. At the 10,000 a second peak, 30,000 events and about 30 MB a second. A void emits only hold.ended, so a rejected payment makes two; a transfer between two customers makes a posted event for each." },
      ],
      fails: "If the relay or Kafka is down, the ledger carries on and events wait in the log. Watch the replication slot: it holds write-ahead log on the primary's disk until the relay catches up. After a failover the relay resumes from the failover slot on the new primary.",
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
      what: "One event per outbox row: hold.placed, hold.ended (captured, voided or expired) and transaction.posted, with ids, accounts, signed amounts per currency, the payment reference, any FX rate used and the outbox seq. Keyed by account so each account's events stay in order.",
      why: 'Notifications, fraud, billing, analytics and reconciliation all need to know what happened. A log lets each read at its own pace and replay, without querying the ledger. The same Kafka (or SQS in front of the Ledger API) also absorbs spikes: payroll runs and payouts are queued and fed to the ledger at the rate it can take.',
      built: [
        { name: "Kafka", what: "A distributed log service. Producers append messages to a topic, split into partitions; each reader keeps its own position and can re-read from any point the topic still keeps.", why: "Each consumer reads at its own pace and can replay after a bug. A queue such as SQS deletes each message once read, so no replay. About 3 MB a second on average is a light load for it." },
        { name: "ledger-events", what: "The one topic the ledger publishes to, with hold and transaction events together.", why: "One topic, not one per event type, so a capture is never read before the hold it ends." },
        { name: "Keyed by account", what: "Each event's key is the account id. Kafka sends every message with the same key to the same partition and keeps a partition in order.", why: "All of one account's events arrive in commit order, which is all consumers need. A partition holding a busy account can lag behind the others." },
        { name: "Queues as shock absorbers", what: "Work that can wait (payroll runs, payouts, billing's daily interest accruals) goes onto a queue, and a worker feeds it to the Ledger API at a steady rate.", why: "The owner's rule for a spike: the database takes what it can within its timeouts and the queue holds the rest, instead of thousands of writers timing out together. Card authorisations cannot queue; they need an answer in seconds." },
      ],
      fails: "Delivery is at least once. A relay restart can publish an event twice, so consumers drop anything at or below the last outbox seq they processed for that account. Per account, seq is taken under the account lock, so it rises in the order that account's transactions committed; it is a value the ledger owns, not a property of one server's log.",
      alternatives: [
        {
          name: 'Kafka topic keyed by account', chosen: true, good: 'Ordered per account, replayable, many readers.', cost: 'Partitions and consumer lag to watch.',
          what: "One topic, ledger-events, keyed by account, so each account's events land in one partition and keep their order. Notifications, fraud, billing, the warehouse and reconciliation each read it as their own consumer group.",
          pros: ['Ordered per account.', 'Replayable: a consumer that falls a day behind catches up from the log.', 'Many readers, each at its own pace.', 'About 3 MB a second on average is a light load for Kafka.'],
          cons: ['Partitions and consumer lag to watch.', 'At least once: consumers must drop repeats by outbox seq.', 'A Kafka cluster to run, or to pay someone to run.'],
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
        { name: "Notifications", what: "The service that sends the owner a push such as \"£1,200.00 paid, reference INV 3318. Fee 20p.\" within seconds, or \"Card payment of $100.00 pending\" on a hold.", why: "It reads ledger-events instead of being called by the ledger, so a slow notification service builds lag, not payment latency. It skips any event at or below the last outbox seq it applied for that account." },
        { name: "Fraud models", what: "Services that score money movements for signs of fraud after the fact, alongside the checks made before a payment.", why: "They need every movement, in order per account, without querying the ledger, so they read the topic." },
        { name: "Billing service", what: "Owns credit card statements: cut-off dates, grace periods, balance segments by rate (purchases, cash, promotional), how repayments are allocated, and interest. It accrues interest daily between two system accounts and charges the card once, on statement day, through the Ledger API.", why: "The ledger only knows a card account's posted balance. Billing reads each card's entries from the topic to keep its own breakdown per statement, and reconciles its totals to the card's posted_balance. For regulated credit, CONC 6.7.4R sends repayments to the highest-interest balance first (a reviewer's reading of Osborne Clarke's note on the 2021 amendment). A limited company's card is mostly outside the Consumer Credit Act; a sole trader's or small partnership's is inside." },
        { name: "BI (business intelligence)", what: "The data warehouse and accounting exports that finance and analysts use, loaded in batches.", why: "Batch loads from the topic put no load on the ledger's databases, and a loading bug can be fixed and replayed from the log." },
      ],
      fails: 'A consumer falls a day behind: it catches up from the log. A consumer processes an event twice: it checks the outbox seq it last applied for that account.',
      alternatives: [
        {
          name: 'Read events from the topic', chosen: true, good: 'Decoupled and replayable.', cost: 'Eventually consistent: a notification can arrive a moment after the balance changes.',
          what: 'Each service reads ledger-events as its own consumer group: notifications within seconds, billing and the warehouse in batches. Each keeps the last outbox seq it applied per account and skips anything older.',
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
      what: "Proves the ledger is right in two ways. Inside: all posted balances in each currency sum to zero, each posted_balance equals the sum of its entries (daily snapshot plus later entries), and each held_balance equals the sum of its ACTIVE holds. It also watches the accounts the CHECK does not protect: system rows with allow_negative TRUE, the FX pools, the customers' receivables and the inter-cluster accounts. Outside, at each business day's cut-off: each nostro, the ledger's mirror of a real account the bank holds, must equal the closing balance on that account's statement, and each clearing account must be back to zero after its scheme's settlement cycle, or be aged.",
      why: "Locks stop races. They do not stop a bug that posts the wrong amount, a missing scheme message, or a bank error. Only comparing against independent truth catches those. We are a bank, so customer balances are deposits on our balance sheet; the ledger must also produce the Single Customer View file for FSCS on demand.",
      built: [
        { name: "Invariant checks", what: "Queries on a replica, incremental: the accounts touched since the last watermark are checked against the daily snapshot (account_balances_daily) plus their later entries; held_balance against ACTIVE holds; no ACTIVE hold past its expiry by more than a few minutes. A full re-sum of every account runs weekly on a replica.", why: "They catch a bug within minutes without re-reading 8 TB a cluster. One MVCC snapshot on the replica sees a balance, its entries and its holds together, because the triggers wrote them in one transaction. The commit-time trigger already refuses any transaction that does not sum to zero in each currency." },
        { name: "Nostros: the real money in the ledger", what: "Asset accounts that mirror the bank's own accounts: NOSTRO_BOE_GBP (the settlement account behind Faster Payments and Bacs), NOSTRO_MASTERCARD_GBP, and nostros for USD and EUR. account_type NOSTRO, allow_negative TRUE: with credit positive, an asset carries a negative balance.", why: "When the scheme settles, the posting is clearing -X, nostro +X; an incoming payment is nostro -X, wallet +X. So the ledger's nostro balance at the cut-off must equal the statement's closing balance, and every clearing account must drain to zero." },
        { name: "FX pool position", what: "When a customer converts pounds to dollars between its own wallets, FX_POOL_GBP takes pounds and FX_POOL_USD pays out dollars, so the pools drift apart: long GBP, short USD. Treasury rebalances with a real FX trade, booked as one balanced transaction per currency.", why: "The pools are allow_negative TRUE, so nothing in the database stops the drift. Reconciliation reports the position per currency every day, and a limit on it is treasury's to set. FX revaluation and profit and loss live in the general ledger." },
        { name: "Single Customer View", what: "A file listing each depositor's total eligible balance, which a UK bank must be able to produce for FSCS on demand. Built from account_balances_daily per customer.", why: "Reviewers' knowledge, not checked against the rules here; no limit or deadline figure is given on this page. If we were an e-money firm instead, the same wallets would be safeguarded funds reconciled every business day under CASS 15." },
        { name: "account_period_totals", what: "This design's choice for checking after archive: before a month's partition is detached, each account's total for that month is written to account_period_totals (account_id, period, total).", why: "Once old partitions are gone, SUM(amount) over the hot table is no longer the posted balance. Archived totals plus the sum of hot entries is." },
        { name: "Rebuilding a balance", what: "If a cache is ever found wrong, the guard refuses any direct fix. Rebuilding is a reviewed break-glass change: in one transaction, SET LOCAL session_replication_role = replica so the guard does not fire, recompute posted_balance from period totals and entries and held_balance from ACTIVE holds, commit, and record who ran it and why.", why: "The guard is there to stop exactly this kind of hand edit, so the bypass must be deliberate, rare and audited. The same setting also switches off the append-only triggers and foreign key checks for that transaction, so the change touches accounts only and is reviewed line by line." },
        { name: "External reconciliation", what: "At each business day's cut-off, each nostro's balance is matched against the closing balance on the bank's statement for that account, and each clearing account is checked back to zero after its settlement cycle, using the schemes' and card networks' settlement reports.", why: "Only an independent record catches a wrong amount, a lost scheme message or a bank error. A clearing account left with a balance after its cycle is money that left one system and never arrived in the next." },
        { name: "Breaks", what: "A difference nothing explains, raised with an owner, an amount and evidence, and closed by a correcting transaction through the Ledger API after a second person approves. Its header's reverses or external_ref names what it corrects.", why: "The fix uses the same rules as every payment, and its transaction id is made from the break id, so approving twice posts once." },
      ],
      numbers: [
        { text: "Monzo's example: two £5 payments in the ledger, £15 arrived in settlement, a £5 break.", from: "Monzo's worked example from 'Processing payments safely at scale', cited on the page: £5 + £5 = £10 in the ledger; £15 in settlement less £10 = £5 that nothing explains." },
        { text: 'Stripe reports more than 99.9999 per cent of money movement explained, with clearing accounts expected to sit at zero.', from: "Not a sum. Stripe's own figure, from its ledger post cited on the page; it has not been checked here." },
      ],
      fails: 'A break is found. It is raised with an owner, an amount and evidence. The fix is a new correcting transaction through the ledger API, reviewed by a second person, never an edit to an entry.',
      alternatives: [
        {
          name: 'Continuous invariant checks plus daily external reconciliation', chosen: true, good: 'Internal checks catch bugs in minutes; external ones catch what the ledger never saw.', cost: 'A team that owns breaks and works them down.',
          what: "Every few minutes, queries check each currency sums to zero and, for the accounts touched since the last watermark, that posted_balance equals the daily snapshot plus later entries and held_balance equals the ACTIVE holds. At each business day's cut-off, the nostros are matched against the bank's statements and the clearing accounts are checked back to zero.",
          pros: ['Internal checks catch bugs in minutes.', 'External checks catch a missing scheme message or a bank error.', 'The same daily balances feed statements, interest and the Single Customer View.', 'Breaks are fixed by correcting entries, so the history shows both mistake and fix.'],
          cons: ['A team that owns breaks and works them down.', 'With about 8 TB a cluster, the frequent checks are incremental; the full re-sum runs weekly on a replica.', 'A day of delay before an outside error is seen.'],
        },
        {
          name: 'Clearing accounts that should net to zero', good: "One query finds anything stuck. Stripe's Ledger is built around this.", cost: 'Needs fund flows modelled carefully up front.',
          what: "Every hop money makes between systems passes through a clearing account that should return to zero once the hop completes. Here FPS_CLEARING_GBP is credited by captures and debited when the scheme settles with the bank.",
          pros: ['One query finds money that left one system and never arrived in the next.', 'Works across many systems, not only the ledger and the bank.'],
          cons: ['Needs fund flows modelled carefully up front.', 'Finds stuck money, not a wrong amount posted the same way on both sides.', 'A clearing account is not zero while money is in flight, so it needs an age threshold.'],
        },
        {
          name: 'Month-end reconciliation only', good: 'Cheap.', cost: 'A month of errors to unpick, and a nostro difference found weeks late.',
          what: 'Finance matches the ledger to the bank statements once a month, as part of closing the books.',
          pros: ['Cheap: one exercise a month.', 'Fits the monthly close that finance already runs.'],
          cons: ['A month of errors to unpick.', 'A nostro that disagrees with the statement goes unseen for weeks; an e-money firm could not do this at all (CASS 15 asks for every business day).', 'A customer can spend money a bug wrongly gave them before anyone sees it.'],
        },
      ],
      say: 'Correctness is proved, not assumed. The caches must equal the journal and the holds every few minutes, each currency must sum to zero, every nostro must equal its statement at the cut-off, and every clearing account must drain to zero.',
    },
    {
      id: 'files',
      name: 'Bank and scheme files',
      short: 'Statements',
      tech: 'bank, schemes',
      x: 1200, y: 34, w: 150, h: 56, kind: 'outside',
      what: "The independent truth: statements for the bank's own accounts (its settlement account at the Bank of England, its account with Mastercard's settlement bank, its correspondent accounts in USD and EUR), and settlement reports from Faster Payments, Bacs and the card networks.",
      why: "They are produced by someone else's systems, so they disagree with yours exactly when yours are wrong.",
      built: [
        { name: "Statements of the bank's own accounts", what: "Daily statements for each real account the bank holds, where the money actually sits. Each has a nostro in the ledger (NOSTRO_BOE_GBP and so on), and the statement's closing balance at the cut-off is what that nostro must equal.", why: "Each file is checksummed and loaded once; a missing file raises an alert." },
        { name: "Scheme and card network settlement reports", what: "Daily reports from Faster Payments, Bacs and the card networks of what each says was settled, in each currency.", why: "They show what the schemes think moved, which catches a lost accept or reject message, or a card settlement the ledger never posted. Each has its own format, so each needs its own parser." },
      ],
      fails: 'A file arrives late or not at all. Reconciliation for that account waits and alerts; it never assumes a missing file means nothing happened.',
      alternatives: [
        {
          name: 'Daily statements and settlement files', chosen: true, good: 'Standard, complete, and what auditors expect.', cost: 'A day of delay before an outside error is seen.',
          what: "Every day, the statement for each of the bank's own accounts, and the settlement reports from Faster Payments, Bacs and the card networks, arrive as files. Each is checksummed and loaded once.",
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
          cons: ['A lost scheme message or a bank error is never seen.', 'Your own systems agree with each other even when they are all wrong.', 'No closing balance to prove each nostro against.'],
        },
      ],
      say: 'Reconcile against something you did not write.',
    },
    {
      id: 'archive',
      name: 'Archive',
      tech: 'object store',
      x: 550, y: 475, w: 130, h: 70, kind: 'store',
      what: "Old monthly partitions of ledger_entries, exported from a replica as Parquet files with a checksum per file; 13 months stay hot. Holds are not partitioned: an archive job copies ended holds placed more than 90 days ago to pending_holds_history, a table partitioned by month, and deletes them. The accounts table and each account's total for every archived month of entries (account_period_totals) stay in the database.",
      why: "Entries are never deleted, so the journal only grows; partitioning it by date lets an old month be exported and detached in one step. pending_holds gains about 86 million rows a day, but it must keep the owner's PRIMARY KEY (hold_id), which a partitioned table cannot, so it is trimmed by deletes instead. Because the balances live in accounts, archiving never slows a funds check. Partitioning by date keeps one cluster's tables small; splitting businesses across clusters spreads the writes. They are separate things.",
      built: [
        { name: "Object store", what: "A storage service that keeps files (objects) by name and serves them over HTTP. It is not a database: it stores and returns whole files.", why: "About 24 TB of entries a year across all clusters, plus headers and hold history. Moving old months into files keeps each cluster near 8 TB in the first year, plus the headers' growth, and is cheap to keep for years." },
        { name: "Parquet", what: "An open file format that stores a table by column, compressed, so a reader can fetch only the columns it needs.", why: "The archive is read rarely and in bulk, which suits a compact column file. A manifest beside the files records the row count, the sums per currency and a checksum per file." },
        { name: "Monthly partitions of the journal", what: "ledger_entries split by created_at into one partition per month. A partition can be detached from the table, without deleting rows one by one.", why: "With CONCURRENTLY a detach takes only a SHARE UPDATE EXCLUSIVE lock on the parent, so inserts carry on; it cannot run inside a transaction block. The price: every unique key must include created_at. created_at defaults to now(), so a replay always carries a different created_at, and UNIQUE (transaction_id, account_id, created_at) never fires, not even within one month (a reviewer inserted the same pair twice in one month). The guards are the header's primary key and idempotency_keys." },
        { name: "Hold archive job", what: "Daily, in batches: copy holds that are no longer ACTIVE and were placed more than 90 days ago (the table has no ended_at, and no hold lives that long) into pending_holds_history (month-partitioned, no uniqueness needed), then delete them. The hold trigger allows DELETE only for a hold that is not ACTIVE (checked), and only the archive role has the DELETE grant.", why: "pending_holds keeps PRIMARY KEY (hold_id), so the hold id stays a real guard. The cost: each delete leaves a dead row for vacuum, about 86 million a day at the stress load." },
        { name: "Headers", what: "ledger_transactions is never deleted and never partitioned. When a month of entries is detached, its headers stay on the cluster as the index of what was ever posted and the lasting duplicate guard.", why: "The header is append-only, and entries and reverses point at it, so deleting it would fight its own guards. The cost: about 100 bytes a row (an estimate), 86 million rows a day at the stress load, about 8.6 GB a day or 3.1 TB a year that never shrinks; at the reasoned baseline, about 0.3 to 0.8 TB a year." },
        { name: "account_period_totals", what: "One row per account per archived month of entries: account_id, period, total. Written from the partition before it is detached.", why: "This design's choice. It lets reconciliation check a posted balance as archived totals plus hot entries once old rows have left the database." },
      ],
      fails: "An export is incomplete. The partition is detached only after the file's row count and sums match the partition's. The hold archive job copies before it deletes in the same transaction, and the trigger refuses to delete an ACTIVE hold.",
      alternatives: [
        {
          name: 'Journal partitioned by month and detached; holds trimmed by an archive job', chosen: true, good: 'Cheap storage for the journal, and the hold id stays a real primary key.', cost: 'Old statements are read from files; deleted holds leave dead rows for vacuum.',
          what: 'ledger_entries is partitioned by month on created_at; each month the oldest partition past 13 months is exported from a replica to Parquet with counts and sums, then detached on the primary. pending_holds stays the owner\'s table; ended holds older than 90 days move to pending_holds_history.',
          pros: ['Detaching a journal partition is a metadata change, not a slow delete.', 'PRIMARY KEY (hold_id) stays, so ON CONFLICT (hold_id) works and a hold id cannot be used twice.', 'Keeps 13 months of journal hot instead of all of it; only the headers keep growing, about 3.1 TB a year.', 'Recorded counts and sums prove each file is complete.'],
          cons: ['Old statements are read from files, more slowly.', 'About 86 million hold deletes a day, each a dead row for vacuum.', 'The journal\'s unique key guards nothing on its own once partitioned; the header table does that job.', 'Partitioning the journal must be there from day one.'],
        },
        {
          name: 'Partition holds by month too, and drop old months', good: 'No deletes and no vacuum: an old month of holds is detached and dropped.', cost: 'The hold\'s key must become (hold_id, created_at), which guards nothing, and ON CONFLICT (hold_id) stops working.',
          what: 'An earlier version of this page. pending_holds is partitioned by created_at like the journal, and a month with no ACTIVE hold left is exported, detached and dropped.',
          pros: ['Dropping a month is a metadata change.', 'No dead rows from 86 million deletes a day.'],
          cons: ['A partitioned table needs created_at in its primary key, and created_at differs on every insert, so the same hold_id inserts twice.', 'ON CONFLICT (hold_id) DO NOTHING errors on such a table (42P10, checked by two reviewers).', 'It lost on the key: the hold id is the hold\'s own guard.'],
        },
        {
          name: 'Delete each hold as it ends, into a history table', good: 'The live holds table stays tiny: only ACTIVE rows.', cost: 'A delete and an insert per hold on the hot path, and steady vacuum work.',
          what: 'When a hold is captured, voided or expired, the same transaction copies it to pending_holds_history and deletes it from pending_holds.',
          pros: ['pending_holds holds a few million ACTIVE rows, not billions.', 'The hold_id guard holds as long as the hold is live.'],
          cons: ['Two more writes per payment on the hot path.', 'A retry after the hold is gone would find no row to conflict with.', 'The same vacuum load as the chosen job, but on the hot path.'],
        },
        {
          name: 'Keep everything in the database', good: 'One place to query.', cost: 'Indexes and backups grow for ever, and restores get slower each year.',
          what: 'Entries and holds stay in the cluster databases for ever. A statement of any age is the same query.',
          pros: ['One place to query.', 'No export job to build.'],
          cons: ['Entries grow by about 24 TB a year and holds by about 4.7 TB.', 'Restores get slower each year, which stretches recovery after a disaster.', 'Every schema change and backfill touches more data.'],
        },
      ],
      say: 'Partition the journal by date from day one, so archiving it is a detach, not a delete, and say plainly that its unique key then guards nothing: the header table does. Keep holds unpartitioned so the hold id stays a key, and trim them with an archive job.',
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
-> 201 { "status": "posted", "available_credit": 465100 }

POST /payroll-runs
Idempotency-Key: k12
{ "from_account": "5f0c...081442", "lines": 14,
  "total": 310000, "currency": "GBP", "pay_date": "2026-11-27" }
-> 202 { "status": "awaiting_approval" }`,
          note: 'The repayment comes from the bakery\'s own wallet, money that is already final, so it posts and restores credit at once: the card goes from -64900 to -34900. A payroll run waits for a second approver, then holds 310000 until the Bacs processing day; it does not need an answer in seconds. 2026-11-27 is a Friday.',
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
  -> later, the scheme settles with the bank:
     FPS_CLEARING_GBP -120000, NOSTRO_BOE_GBP +120000

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
          code: `day 1  authorisation, USD 100.00, online shop, debit card
       the network sends the billing amount: GBP 80.00
       card processor -> Ledger API: Hold
       8000p + 3% buffer = 8240p
       -> hold ...0520 ACTIVE on the GBP wallet; approve

day 3  clearing: USD 100.00 billed at GBP 79.00 = 7900p
       non-sterling transaction fee 1% = 79p
       card processor -> Ledger API: Capture hold ...0520
       -> 3 entries, all GBP; hold CAPTURED; 261p free again

or     no clearing by expires_at -> hold EXPIRED
or     clearing with no live hold -> force-post`,
          note: 'Amounts, the buffer and the fee are illustrative. The bank never quotes a rate here: the network converts, and the fee is the bank\'s FX income (a reviewer\'s reasoning, not checked against scheme rules).',
        },
      ],
    },
    {
      id: 'post', from: 'api', to: 'ledger', d: 'M390,200 H485', label: 'hold, capture',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: "Hold with the idempotency key, the account, the amount and currency and an expiry; later Capture naming that hold with the transaction id, a description, a value date and the signed entries, or Void. Incoming payments, payroll, repayments, interest and corrections use Post with the same header fields. Reads use GetBalance and ListEntries.",
      delivery: 'Safe to repeat: the key is unique per client in the ledger, the hold id is the hold\'s primary key, and the caller-made transaction id is the header\'s primary key, so a repeated call returns the first result, and a replay after the key has gone is refused.',
      alts: ['REST with an Idempotency-Key header.', 'A command topic, which turns a synchronous "is there enough money?" into an asynchronous one.'],
      ways: [
        { name: 'gRPC', chosen: true, what: 'The Banking API calls Hold, then Capture or Void, on the Ledger API, each with its own idempotency key and a deadline. Reads use GetBalance and ListEntries.', pros: ['A typed contract, with client and server code generated from it.', 'Synchronous: the API learns at once whether the funds were held.', 'A deadline on each call, so a slow ledger fails fast.'], cons: ['Harder to call by hand while debugging than REST.', 'Needs load balancers and proxies that handle long-lived HTTP/2 connections.'] },
        { name: 'REST with an Idempotency-Key header', what: 'The same calls as JSON over HTTPS, such as POST /holds with an Idempotency-Key header. The same key rules apply.', pros: ['Easy to call by hand and read in logs.', 'The same idempotency scheme as the public API.'], cons: ['No generated, typed contract unless one is added.', 'JSON costs a little more to send and parse; unlikely to matter here.'] },
        { name: 'A command topic', what: 'The caller writes a command to a topic and the ledger applies it, replying on another topic. This design does use a queue in front for payroll and payouts, which can wait; not for holds.', pros: ['Bursts queue instead of failing.', 'One consumer per partition gives a single writer per account.'], cons: ['"Is there enough money?" turns asynchronous, but a card authorisation needs an answer in seconds.', 'Matching replies to requests, and timing them out, is extra code.'] },
      ],
      reply: {
        id: 'result', label: 'result',
        how: 'The hold or transaction id and the account\'s posted, held and available figures afterwards; or INSUFFICIENT_FUNDS, HOLD_NOT_ACTIVE, KEY_REUSED or TIMEOUT.',
        delivery: 'The same answer for every repeat of the same key, a decline included.',
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
message Header {  // made by the caller, from the request
  string transaction_id = 1; string kind = 2;
  string external_ref = 3; string description = 4;
  string value_date = 5; string reverses = 6;
}
message CaptureRequest { string idempotency_key = 1;
  string hold_id = 2; Header header = 3;
  repeated Entry entries = 4; }  // sum to zero per currency
message VoidRequest { string idempotency_key = 1; string hold_id = 2; }
message PostRequest { string idempotency_key = 1;
  Header header = 2; repeated Entry entries = 3; }
message Result { string id = 1; string status = 2;
  int64 posted = 3; int64 held = 4; int64 available = 5; }`,
          note: 'GetBalance, ListEntries and the client id (from the caller\'s credentials) are left out to keep it short. status is COMMITTED, INSUFFICIENT_FUNDS, HOLD_NOT_ACTIVE, KEY_REUSED or TIMEOUT. Payment state (PENDING, SETTLED, FAILED) lives on the Banking API\'s payment record.',
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
  "header": { "transaction_id": "7d1f0a52-...000000900418",
    "kind": "FPS_OUT", "external_ref": "pay_3fK9",
    "description": "INV 3318", "value_date": "2026-11-12" },
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
                           and a retry of that key gets the same
Had the hold expired:      Capture -> { "status": "HOLD_NOT_ACTIVE" }`,
          note: 'The Banking API made the transaction id as a UUIDv5 of its client id and k7:capture; ...900418 stands for it. The Ledger API turned FPS_CLEARING_GBP and FEE_REVENUE_GBP into their shard 7 rows, from hash(transaction_id) % 16. A capture of a hold that is no longer ACTIVE posts nothing; the caller then decides on a force-post.',
        },
        {
          title: 'Example call: credit card interest accrual from billing',
          lang: 'text',
          code: `Post   (from the billing service, daily)
{ "idempotency_key": "accrual:5f0c...081444:2026-11-12",
  "header": { "transaction_id": "7d1f0a52-...000000900612",
    "kind": "INTEREST_ACCRUAL",
    "external_ref": "5f0c...081444:2026-11-12",
    "description": "Interest accrued", "value_date": "2026-11-12" },
  "entries": [
    { "account": "INTEREST_RECEIVABLE_GBP", "amount": -32,
      "currency": "GBP" },
    { "account": "INTEREST_INCOME_GBP", "amount": 32,
      "currency": "GBP" } ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000900612",
     "status": "COMMITTED" }

The card is not touched: posted -34900, available 465100.
On statement day billing charges the card once:
  card -X, INTEREST_RECEIVABLE_GBP +X.`,
          note: 'Billing decides the 32p (illustrative; no rate is implied). The ledger only posts it. The transaction id is made from the card and the date, and so is external_ref, so a rerun of the day is refused by the header: by its primary key, or by UNIQUE (kind, external_ref) if a bug made a new id. Paid in full within the grace period, the accrual is reversed and the card never sees it.',
        },
      ],
    },
    {
      id: 'txn', from: 'ledger', to: 'db', d: 'M615,200 H700', label: 'one call',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'One call to a small function per write, as the ledger_writer role, whose timeouts are set on the role. ledger_hold: insert the idempotency key, lock the account with FOR NO KEY UPDATE, insert the hold only if the account is OPEN and posted - held - amount >= -credit_limit, write the outbox row, save the result (a decline too), commit. ledger_capture: lock the account rows in account_id order, insert the header, then one statement that marks the hold CAPTURED and inserts the entries, or does neither. Balance reads are a plain SELECT on accounts.',
      delivery: 'All or nothing. If the key already exists with the same request, the call returns the stored result and writes nothing; with a different request it is refused. If the money is not there, no hold is inserted and the decline is saved. If the hold is not ACTIVE, no entry is inserted. If a lock is not free within 50 ms, the call fails and is retried with the same key. A replayed transaction id is refused by the header.',
      alts: ['An interactive transaction of separate statements, holding locks across each round trip.', 'A batch of many transfers per call, as TigerBeetle does, for throughput.'],
      ways: [
        { name: 'SQL: one function call', chosen: true, what: 'The Ledger API calls ledger_hold, ledger_capture, ledger_void or ledger_post once on the cluster. Each does its key, its account locks, its header, its one conditional statement and its outbox rows; the transaction commits, and the balance check runs once at COMMIT.', pros: ['Locks are never held across the network: about 1 to 2 ms each.', 'All or nothing, and a repeated key returns the stored result.', 'One round trip per write.'], cons: ['Logic in SQL needs its own review and tests.', 'Changing it is a database deploy.'] },
        { name: 'An interactive transaction of separate statements', what: 'The service sends each statement on its own inside one transaction. Each is a round trip while the locks are held.', pros: ['All logic in application code.', 'Easy to read and step through.'], cons: ['Four or five round trips with locks held.', 'Ten round trips of 0.5 ms hold a hot row for 5 ms: about 200 writes a second on it.'] },
        { name: 'A batch of many transfers per call', what: 'The Ledger API gathers many transfers and sends them in one call, applied in one transaction. TigerBeetle does this with up to 8,189 transfers a request.', pros: ['One commit and one standby round trip shared by many transfers.', 'Far more writes a second on a hot row.'], cons: ['One bad transfer must not fail the rest, so each needs its own result.', 'Each transfer waits for its batch to fill or a timer to fire.'] },
      ],
      reply: {
        id: 'committed', label: 'committed',
        how: 'The commit returns once the write-ahead log is flushed locally and one synchronous standby confirms it has flushed it too.',
        delivery: 'Durable on two machines when acknowledged.',
      },
      examples: [
        {
          title: "What an expert review changed in the owner's tables, and why",
          lang: 'text',
          code: `accounts
  + hard_limit; the CHECK is now at -hard_limit, and credit_limit
    is the soft limit tested when a customer starts a debit.
    Why: interest, fees and late settlements must post; the
    owner's CHECK at -credit_limit refused them.
  + status (OPEN, NO_NEW_SPEND, CLOSED) in place of is_active.
    Why: a blocked card must still take repayments and refunds.
  + owner_account_id, and RECEIVABLE and NOSTRO account types.
    Why: a debt past the hard floor belongs to one customer, and
    the bank's real money must be in the ledger to reconcile.
  + accounts open at zero (the guard also fires on INSERT).
pending_holds
  unchanged.
ledger_entries
  + a foreign key from transaction_id to the new header.
new: ledger_transactions, one header row per transaction.
  Why: the lasting duplicate guard, and a home for the
  description, value date and the link from a correction.`,
          note: 'Everything else in the three tables is the owner\'s DDL, with long comments wrapped to fit. The schema and the statements on this line were run on PostgreSQL 18 (PGlite); the races on PostgreSQL 16 with real concurrent sessions.',
        },
        {
          title: "The owner's tables, with the changes, 1 of 3: accounts",
          lang: 'sql',
          code: `CREATE TABLE accounts (
    account_id UUID PRIMARY KEY,
    logical_account VARCHAR(50),       -- NULL for customer accounts
    shard_id INT NOT NULL DEFAULT 0,
    account_type VARCHAR(20) NOT NULL, -- USER_WALLET, CREDIT_CARD,
      -- RECEIVABLE, CLEARING, NOSTRO, FX_POOL, REVENUE
    owner_account_id UUID REFERENCES accounts(account_id),
    allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
    posted_balance BIGINT NOT NULL DEFAULT 0,
    held_balance   BIGINT NOT NULL DEFAULT 0,
    credit_limit   BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    hard_limit     BIGINT NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'NO_NEW_SPEND', 'CLOSED')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_available_funds CHECK (allow_negative
        OR (posted_balance - held_balance) >= -hard_limit),
    CONSTRAINT hard_limit_covers_credit_limit
        CHECK (hard_limit >= credit_limit),
    CONSTRAINT valid_held_balance CHECK (held_balance >= 0),
    CONSTRAINT closed_means_empty CHECK (status <> 'CLOSED'
        OR (posted_balance = 0 AND held_balance = 0)),
    CONSTRAINT uq_logical_shard UNIQUE (logical_account, shard_id)
) WITH (fillfactor = 80);`,
          note: 'Example values: a credit card credit_limit 500000 and hard_limit 550000; a debit wallet 0 and 0 (a small unarranged-overdraft allowance would be a policy choice). A NULL logical_account never collides in uq_logical_shard, so a million wallets can all have shard_id 0.',
        },
        {
          title: '2 of 3: the new header table',
          lang: 'sql',
          code: `-- One row per transaction, never partitioned, never deleted.
-- Its primary key is the lasting duplicate guard.
CREATE TABLE ledger_transactions (
    transaction_id UUID PRIMARY KEY,  -- made by the caller
    kind VARCHAR(30) NOT NULL,        -- FPS_OUT, CARD_SETTLEMENT, ...
    external_ref TEXT,                -- the scheme's own id
    description TEXT NOT NULL,
    value_date DATE NOT NULL,
    reverses UUID REFERENCES ledger_transactions(transaction_id),
    hold_id UUID,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, external_ref)
);`,
          note: 'The caller makes transaction_id as a UUIDv5 of its client id and the idempotency key, or of the rail and the scheme\'s own reference, so the same request always gives the same id. Checked: a replayed id is refused by the primary key, and the same scheme reference under a new id by the unique key.',
        },
        {
          title: '3 of 3: holds, unchanged, and entries',
          lang: 'sql',
          code: `CREATE TABLE pending_holds (
    hold_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,  -- ACTIVE, CAPTURED, VOIDED, EXPIRED
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL           -- the one change:
        REFERENCES ledger_transactions(transaction_id),
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    -- Positive = Credit, Negative = Debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id) -- Idempotency guard
);
CREATE INDEX idx_ledger_account_created
    ON ledger_entries (account_id, created_at DESC);`,
          note: 'Amounts are minor units; a posted_balance is the sum of the account\'s entries. Unpartitioned, as here, UNIQUE (transaction_id, account_id) also refuses a second posting of one transaction to one account.',
        },
        {
          title: "This design's additions beside them",
          lang: 'sql',
          code: `CREATE UNIQUE INDEX uq_receivable_owner ON accounts
    (owner_account_id) WHERE account_type = 'RECEIVABLE';
CREATE INDEX idx_holds_active_account ON pending_holds
    (account_id, expires_at) WHERE status = 'ACTIVE';
CREATE INDEX idx_ledger_account_entry
    ON ledger_entries (account_id, entry_id DESC);  -- statements

CREATE TABLE idempotency_keys (
    client_id TEXT NOT NULL, key TEXT NOT NULL,
    request_hash TEXT NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (client_id, key));       -- kept 72 hours
CREATE TABLE outbox (seq BIGSERIAL PRIMARY KEY,
    transaction_id UUID, hold_id UUID,
    account_id UUID NOT NULL, payload JSONB NOT NULL);

ALTER ROLE ledger_writer SET statement_timeout = '250ms';
ALTER ROLE ledger_writer SET lock_timeout = '50ms';
ALTER ROLE payroll_writer SET statement_timeout = '5s';
REVOKE DELETE, TRUNCATE ON accounts FROM ledger_writer;
GRANT UPDATE (credit_limit, hard_limit, allow_negative, status)
    ON accounts TO credit_service;`,
          note: 'Not in the owner\'s spec; added to make his rules work. Role settings apply when a server connection logs in, so they hold behind PgBouncer in transaction mode; SET LOCAL statement_timeout inside a function would not time that call. idx_ledger_account_entry is for statement pages; it was run here but is not in the reviewed schema. The 5 s payroll value is an example.',
        },
        {
          title: 'Triggers 1: the journal and the headers are append-only',
          lang: 'sql',
          code: `CREATE FUNCTION append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();
CREATE TRIGGER ledger_transactions_no_change
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION append_only();`,
          note: 'A trigger is a function the database runs by itself when a row is written, inside the same transaction. TRUNCATE skips row triggers, so it has its own statement trigger (checked). DROP TABLE is stopped by grants, not triggers.',
        },
        {
          title: 'Triggers 2: entries move posted; only CLOSED refuses them',
          lang: 'sql',
          code: `CREATE FUNCTION apply_entry_to_posted() RETURNS trigger AS $$
BEGIN
  UPDATE accounts
     SET posted_balance = posted_balance + NEW.amount,
         updated_at = now()
   WHERE account_id = NEW.account_id
     AND currency = NEW.currency AND status <> 'CLOSED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry for % is in % but the account is not,'
      ' or is closed', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_posted();`,
          note: 'Matching on currency means an entry in USD for a GBP account finds no row and is refused. A NO_NEW_SPEND account still takes entries: repayments, refunds, interest and settlements already approved (checked).',
        },
        {
          title: 'Triggers 3: a hold raises held_balance, on an OPEN account',
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
     AND currency = NEW.currency AND status = 'OPEN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold for % is in % but the account is not,'
      ' or takes no new spend', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_placed AFTER INSERT ON pending_holds
  FOR EACH ROW EXECUTE FUNCTION hold_placed();`,
          note: 'Raising held_balance runs the CHECK on the account row, so a hold that skipped the soft test still cannot take the account past its hard floor.',
        },
        {
          title: 'Triggers 4: a hold ends once; only an ended hold is deleted',
          lang: 'sql',
          code: `CREATE FUNCTION hold_ended() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'an ACTIVE hold is ended, never deleted';
    END IF;
    RETURN OLD;                 -- the archive job removes ended holds
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
CREATE TRIGGER pending_holds_ended BEFORE UPDATE OR DELETE
  ON pending_holds FOR EACH ROW EXECUTE FUNCTION hold_ended();`,
          note: 'This is what stops a hold being both captured and voided: whichever ends it first wins, and the second finds it no longer ACTIVE. Its UPDATE of accounts is why every path must lock the account row before it touches a hold.',
        },
        {
          title: 'Triggers 5: the guard; accounts open at zero',
          lang: 'sql',
          code: `CREATE FUNCTION accounts_guard_balances() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.posted_balance <> 0 OR NEW.held_balance <> 0 THEN
      RAISE EXCEPTION 'accounts open at zero';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.posted_balance IS DISTINCT FROM OLD.posted_balance
      OR NEW.held_balance IS DISTINCT FROM OLD.held_balance)
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION
      'balances change only through ledger_entries and pending_holds';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balances();`,
          note: 'A direct UPDATE of either balance runs the guard at depth 1 and is refused; a trigger\'s UPDATE runs it at depth 2. No application role can edit a balance; the table owner or a superuser could disable the trigger, so DDL is reviewed and logged.',
        },
        {
          title: 'Triggers 6: at COMMIT, once per transaction, the books balance',
          lang: 'sql',
          code: `CREATE FUNCTION transaction_must_balance() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM ledger_entries
       WHERE transaction_id = NEW.transaction_id
         AND created_at = NEW.created_at) < 2
     OR EXISTS (SELECT 1 FROM ledger_entries
                 WHERE transaction_id = NEW.transaction_id
                   AND created_at = NEW.created_at
                 GROUP BY currency HAVING sum(amount) <> 0) THEN
    RAISE EXCEPTION 'transaction % does not sum to zero'
      ' in every currency', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transaction_must_balance();`,
          note: 'On, not optional. It fires once, on the header, not once per entry: the per-entry version took 8.2 s for a 5,001-entry payroll (a reviewer\'s measurement); this one about 0.7 s. created_at = NEW.created_at holds because header and entries share now(), the transaction\'s start, and lets a partitioned journal be probed in one partition.',
        },
        {
          title: 'Hold, part 1: the key, the lock',
          lang: 'sql',
          code: `-- Bright Bakery GBP wallet 5f0c2a9e-3d41-4b7e-8c12-000000081442
--   USER_WALLET, credit_limit 0, hard_limit 0, posted 842000
-- as ledger_writer: lock_timeout 50ms, statement_timeout 250ms
BEGIN;
INSERT INTO idempotency_keys (client_id, key, request_hash)
VALUES ('banking-api', 'k7', 'sha256:4be1...')
ON CONFLICT (client_id, key) DO NOTHING;
-- 0 rows: k7 was seen. Same request_hash: return its saved
-- result. Another hash: refuse with KEY_REUSED. Either way, stop.

SELECT posted_balance, held_balance, credit_limit, status
  FROM accounts
 WHERE account_id = '5f0c2a9e-...081442'
   FOR NO KEY UPDATE;
-- waits at most 50 ms for another writer; then SQLSTATE 55P03,
-- the transaction rolls back and the caller retries with k7`,
          note: 'The timeouts come from the role, set when the connection logged in, so they hold behind PgBouncer and apply to the whole call. A hold has no header: the journal is not touched until the capture.',
        },
        {
          title: 'Hold, part 2: insert only if funded; a decline is saved too',
          lang: 'sql',
          code: `WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND status = 'OPEN'
     AND posted_balance - held_balance - 120020 >= -credit_limit
)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-0f47-4d2a-8c55-000000000417',
       '5f0c2a9e-...081442', 120020, 'GBP', 'ACTIVE',
       now() + interval '7 days'
  FROM funded
ON CONFLICT (hold_id) DO NOTHING;
-- 1 row: the trigger raised held_balance by 120020; then
INSERT INTO outbox (hold_id, account_id, payload)
VALUES ('b61c9a3e-...000000000417', '5f0c2a9e-...081442', '{...}');
-- 0 rows: not enough money. No hold and no outbox row, but the
-- decline is saved and committed, so a retry gets the same answer.
UPDATE idempotency_keys SET result = '{...}'
 WHERE client_id = 'banking-api' AND key = 'k7';
COMMIT;  -- returns once a synchronous standby has the log record
-- after: posted 842000, held 120020, available 721980`,
          note: 'The CTE returns a row only if the money is there and the account is OPEN, so the insert writes the hold or nothing. This is the soft limit. A path that skipped it would still be stopped by the hard floor, but only there: hard_limit - credit_limit past the limit.',
        },
        {
          title: 'Capture, part 1: key, account locks, header',
          lang: 'sql',
          code: `-- FPS_CLEARING_GBP shard 7  1c9d4e2a-7b10-4c55-9a01-000000000007
-- FEE_REVENUE_GBP shard 7   c2e85b71-90aa-4d3f-a6e4-000000000007
BEGIN;
INSERT INTO idempotency_keys (client_id, key, request_hash)
VALUES ('banking-api', 'k7:capture', 'sha256:91c0...')
ON CONFLICT (client_id, key) DO NOTHING;  -- 0 rows: as for the hold
SELECT 1 FROM accounts               -- 1c9d..., 5f0c..., c2e8...
 WHERE account_id IN ('5f0c2a9e-...081442', '1c9d4e2a-...000007',
                      'c2e85b71-...000007')
 ORDER BY account_id FOR NO KEY UPDATE;
INSERT INTO ledger_transactions (transaction_id, kind,
  external_ref, description, value_date, hold_id, created_by)
VALUES ('7d1f0a52-...900418', 'FPS_OUT', 'pay_3fK9', 'INV 3318',
        '2026-11-12', 'b61c9a3e-...000000000417', 'banking-api');`,
          note: 'Account rows first, in account_id order, then the hold: the same order as the void and the expiry job, so they cannot deadlock. The transaction id stands for a UUIDv5 of banking-api and k7:capture.',
        },
        {
          title: 'Capture, part 2: end the hold and post, in one statement',
          lang: 'sql',
          code: `WITH done AS (
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
-- 3 rows, or 0 if the hold was not ACTIVE: then ROLLBACK and
-- answer HOLD_NOT_ACTIVE. (A header with no entries would fail at
-- COMMIT anyway: the balance check wants two or more.)
INSERT INTO outbox (transaction_id, hold_id, account_id, payload)
VALUES ('7d1f0a52-...900418', 'b61c9a3e-...000000000417',
        '5f0c2a9e-...081442', '{...}');
UPDATE idempotency_keys SET result = '{...}'
 WHERE client_id = 'banking-api' AND key = 'k7:capture';
COMMIT;  -- the balance check runs here, once`,
          note: 'The hold ends and the entries post together, or neither. A second capture finds the hold CAPTURED, updates 0 rows and inserts 0 entries. After: posted 721980, held 0. One outbox row, because one customer account is touched.',
        },
        {
          title: 'Void: the scheme rejected the payment',
          lang: 'sql',
          code: `BEGIN;
INSERT INTO idempotency_keys (client_id, key, request_hash)
VALUES ('banking-api', 'k7:void', 'sha256:0d2f...')
ON CONFLICT (client_id, key) DO NOTHING;
-- the account first, as every path does
SELECT 1 FROM accounts
 WHERE account_id = '5f0c2a9e-...081442' FOR NO KEY UPDATE;
UPDATE pending_holds SET status = 'VOIDED'
 WHERE hold_id = 'b61c9a3e-0f47-4d2a-8c55-000000000417'
   AND status = 'ACTIVE';
-- 1 row: the trigger lowered held_balance by 120020
-- 0 rows: already captured, voided or expired; report it
INSERT INTO outbox (hold_id, account_id, payload)
VALUES ('b61c9a3e-...000000000417', '5f0c2a9e-...081442', '{...}');
UPDATE idempotency_keys SET result = '{...}'
 WHERE client_id = 'banking-api' AND key = 'k7:void';
COMMIT;
-- after: posted 842000, held 0, available 842000
-- no header and no entries: the journal never saw the payment`,
          note: 'An earlier version updated the hold first and reached the wallet row through the trigger, while capture locked the wallet first; a reviewer raced the two into a deadlock (40P01). Locking the account first, 200 rounds of capture racing void gave no errors: 128 captured, 72 voided, balances exact.',
        },
        {
          title: 'A balance read: posted, held, available',
          lang: 'sql',
          code: `-- GetBalance, always on the primary: one row, no lock
SELECT posted_balance, held_balance, credit_limit, status,
       posted_balance - held_balance + credit_limit AS available
  FROM accounts
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442';
--                 posted   held     available
--  before:        842000        0   842000
--  after hold:    842000   120020   721980
--  after capture: 721980        0   721980
--  had it voided: 842000        0   842000

-- the credit card, after example D's capture and repayment
--  5f0c...081444: -34900        0   465100  (limit 500000)`,
          note: "A plain SELECT never waits for a writer's row lock: it reads the last committed version of the row. Available uses credit_limit, the soft limit, never hard_limit: the gap between them is not the customer's to spend.",
        },
        {
          title: 'Card authorisation and credit card purchase: the same hold',
          lang: 'sql',
          code: `-- B. Debit card on the GBP wallet: the network's billing amount
--    is 8000p; + 3% buffer = 8240p
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND status = 'OPEN'
     AND posted_balance - held_balance - 8240 >= -credit_limit)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-...000000000520', '5f0c2a9e-...081442', 8240,
       'GBP', 'ACTIVE', now() + interval '7 days' FROM funded;

-- D. Credit card 5f0c...081444, credit_limit 500000,
--    hard_limit 550000, posted 0: £649.00
--    0 - 0 - 64900 = -64900 >= -500000, so 1 row
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081444' AND status = 'OPEN'
     AND posted_balance - held_balance - 64900 >= -credit_limit)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-...000000000610', '5f0c2a9e-...081444', 64900,
       'GBP', 'ACTIVE', now() + interval '7 days' FROM funded;
-- card: posted 0, held 64900, available credit 435100`,
          note: 'Each runs inside the same frame as the bank hold: key, FOR NO KEY UPDATE on the one account, outbox. The 7-day expiry and the 3% buffer are illustrative. The hold is in GBP because the wallet is and the network sent pounds; no account ever holds two currencies.',
        },
        {
          title: 'B clears: a purchase in dollars, three entries in pounds',
          lang: 'sql',
          code: `-- billed 7900p; non-sterling transaction fee 1% = 79p
-- MASTERCARD_DEBIT_CLEARING_GBP s7  d41e7c90-...000000000007
-- FX_FEE_REVENUE_GBP s7             c2e85b71-...000000000107
-- (accounts locked in id order, header CARD_SETTLEMENT first)
WITH done AS (
  UPDATE pending_holds SET status = 'CAPTURED'
   WHERE hold_id = 'b61c9a3e-...000000000520' AND status = 'ACTIVE'
  RETURNING hold_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900521', v.acct::uuid, v.amt, 'GBP'
  FROM (VALUES ('5f0c2a9e-...081442', -7979::bigint),
               ('d41e7c90-...000007',  7900::bigint),
               ('c2e85b71-...000107',    79::bigint))
       AS v(acct, amt), done;
-- -7979 + 7900 + 79 = 0, all in GBP
-- hold of 8240 released: 8240 - 7979 = 261p is free again`,
          note: 'The network converted the dollars and sends pounds, so a card settlement credits the card clearing account, never an FX pool. The fee is the bank\'s FX income. The owner\'s five-entry bridge through the FX pools is what a multi-currency card that settles with the network in USD would post.',
        },
        {
          title: 'E. Converting between wallets: four entries, two currencies',
          lang: 'sql',
          code: `-- The bakery converts £8,000.00 from its GBP wallet to its USD
-- wallet at 1 USD = 0.80 GBP: 800000p buys 1000000 cents.
-- USD wallet         5f0c2a9e-3d41-4b7e-8c12-000000081443
-- FX_POOL_GBP s7     3b7a1f64-58c2-4d0e-9f31-000000000007
-- FX_POOL_USD s7     3b7a1f64-58c2-4d0e-9f31-000000000107
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900530', '5f0c2a9e-...081442',  -800000, 'GBP'),
 ('7d1f0a52-...900530', '3b7a1f64-...000007',   800000, 'GBP'),
 ('7d1f0a52-...900530', '3b7a1f64-...000107', -1000000, 'USD'),
 ('7d1f0a52-...900530', '5f0c2a9e-...081443',  1000000, 'USD');
-- GBP: -800000 + 800000 = 0    USD: -1000000 + 1000000 = 0`,
          note: 'Separate from the tour: the wallet needs 800000 available. Header kind FX_CONVERSION first, with the rate on the payment record and the event, not in ledger_entries. Pounds go into the GBP pool and dollars out of the USD pool; the pools drift until treasury trades. Spend from the USD wallet clears through MASTERCARD_DEBIT_CLEARING_USD, with no conversion.',
        },
        {
          title: 'D. Credit card: capture, repayment, daily accrual',
          lang: 'sql',
          code: `-- capture ...900611 (hold ...0610 CAPTURED in the same statement,
-- as above): card -64900, MASTERCARD_CREDIT_CLEARING_GBP s7
-- (d41e7c90-...000207) +64900; card posted -64900, credit 435100

-- repayment of 30000 from the bakery's GBP wallet
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900613', '5f0c2a9e-...081442', -30000, 'GBP'),
 ('7d1f0a52-...900613', '5f0c2a9e-...081444',  30000, 'GBP');
-- card posted -34900, available credit 465100 at once

-- today's accrual: system accounts only; the card is not touched
-- INTEREST_RECEIVABLE_GBP s7  c2e85b71-90aa-4d3f-a6e4-000000000307
-- INTEREST_INCOME_GBP s7      c2e85b71-90aa-4d3f-a6e4-000000000207
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900612', 'c2e85b71-...000307',   -32, 'GBP'),
 ('7d1f0a52-...900612', 'c2e85b71-...000207',    32, 'GBP');

-- statement day, if not paid in full: the month's accrued total X
-- is charged once: card -X, INTEREST_RECEIVABLE_GBP +X`,
          note: 'Each is its own transaction with its header, key and account locks in id order. A negative card balance is what the customer owes: -34900 is £349.00. Paid in full within the grace period, billing reverses the accrual and the card never sees it. The 32p is illustrative.',
        },
        {
          title: 'Force-post 1: a settlement larger than its live hold',
          lang: 'sql',
          code: `-- Had B cleared at 9000p (8911p + an 89p fee) against hold 8240p
BEGIN;
SELECT 1 FROM accounts WHERE account_id IN ('5f0c2a9e-...081442',
  'd41e7c90-...000007', 'c2e85b71-...000107')
 ORDER BY account_id FOR NO KEY UPDATE;
INSERT INTO ledger_transactions (transaction_id, kind,
  external_ref, description, value_date, hold_id, created_by)
VALUES ('7d1f0a52-...900521', 'CARD_SETTLEMENT', 'MC-ARN-3',
  'USD 100.00 ACME', '2026-11-12', 'b61c9a3e-...000000000520',
  'cards');
-- end any live hold for this authorisation, in this transaction
UPDATE pending_holds SET status = 'CAPTURED'
 WHERE hold_id = 'b61c9a3e-...000000000520' AND status = 'ACTIVE';
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900521', '5f0c2a9e-...081442', -9000, 'GBP'),
 ('7d1f0a52-...900521', 'd41e7c90-...000007',  8911, 'GBP'),
 ('7d1f0a52-...900521', 'c2e85b71-...000107',    89, 'GBP');
COMMIT;
-- hold CAPTURED; wallet -9000; no receivable: the wallet could pay`,
          note: 'A settlement is a debit the bank cannot refuse, so it skips the soft test and posts as far as the hard floor. If the hold had already EXPIRED it has left ACTIVE, the UPDATE finds nothing, and the settlement posts the same way, as if there had been no hold.',
        },
        {
          title: 'Force-post 2: past the hard floor, the rest to a receivable',
          lang: 'sql',
          code: `-- The card spent to its limit, then statement interest 250p and
-- a 1200p late fee posted past it: posted -501450. A 60000p
-- settlement arrives with no hold. Card receivable 5f0c...081449:
-- RECEIVABLE, owner_account_id the card, allow_negative TRUE,
-- opened on first use. (Header CARD_FORCE_POST first; card,
-- receivable and MASTERCARD_CREDIT_CLEARING_GBP s7 locked.)
WITH c AS (
  SELECT least(60000,
               posted_balance - held_balance + hard_limit) AS take
    FROM accounts WHERE account_id = '5f0c2a9e-...081444')
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900701', v.a, v.amt, 'GBP'
  FROM c, LATERAL (VALUES
        ('5f0c2a9e-...081444'::uuid, -c.take),
        ('5f0c2a9e-...081449'::uuid, -(60000 - c.take)),
        ('d41e7c90-...000207'::uuid, 60000::bigint)) AS v(a, amt)
 WHERE v.amt <> 0;
-- take = least(60000, -501450 + 550000) = 48550
-- card -48550, down to its floor of -550000; receivable -11450`,
          note: 'A plain debit of 60000 is refused by the hard floor (23514, checked). The shortfall is this customer\'s own receivable, never a pooled account; uq_receivable_owner allows one per owner (a second is refused, checked).',
        },
        {
          title: 'Money in: blocked card, repayment clears the receivable first',
          lang: 'sql',
          code: `-- the credit service blocks the card: no new spend
UPDATE accounts SET status = 'NO_NEW_SPEND'
 WHERE account_id = '5f0c2a9e-...081444';
-- a new hold now fails in hold_placed; money in still posts

-- a 30000p repayment from the wallet; the Ledger API splits it
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900702', '5f0c2a9e-...081442', -30000, 'GBP'),
 ('7d1f0a52-...900702', '5f0c2a9e-...081449',  11450, 'GBP'),
 ('7d1f0a52-...900702', '5f0c2a9e-...081444',  18550, 'GBP');
-- receivable 0; card -550000 + 18550 = -531450

-- closing an account that still owes is refused:
-- closed_means_empty needs posted 0 and held 0`,
          note: 'Checked: the hold on a NO_NEW_SPEND card is refused, the repayment posts, and closing the card while it owes fails. Cutting credit_limit below what is used is allowed; new holds then place nothing.',
        },
        {
          title: 'Payroll: a hold on approval, a capture on the processing day',
          lang: 'sql',
          code: `-- approved: hold the run, expiring after the pay date
WITH funded AS (SELECT 1 FROM accounts
  WHERE account_id = '5f0c2a9e-...081442' AND status = 'OPEN'
    AND posted_balance - held_balance - 310000 >= -credit_limit)
INSERT INTO pending_holds
  (hold_id, account_id, amount, currency, status, expires_at)
SELECT 'b61c9a3e-...000000000800', '5f0c2a9e-...081442', 310000,
       'GBP', 'ACTIVE', '2026-11-30 18:00+00' FROM funded;

-- Bacs processing day: 13 staff bank elsewhere, one here
-- BACS_CLEARING_GBP s3    1c9d4e2a-7b10-4c55-9a01-000000000303
-- employee's wallet here  5f0c2a9e-3d41-4b7e-8c12-000000090001
WITH done AS (UPDATE pending_holds SET status = 'CAPTURED'
  WHERE hold_id = 'b61c9a3e-...000000000800' AND status = 'ACTIVE'
  RETURNING hold_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900800', v.a::uuid, v.amt, 'GBP'
  FROM (VALUES ('5f0c2a9e-...081442', -310000::bigint),
               ('1c9d4e2a-...000303',  285000::bigint),
               ('5f0c2a9e-...090001',   25000::bigint)) AS v(a, amt),
       done;
-- header PAYROLL, value_date 2026-11-27, a Friday`,
          note: 'Both inside the usual frame (key, account locks in id order, header, outbox). The 13 Bacs lines go out in the Bacs file; inside the ledger they are one credit to BACS_CLEARING_GBP. A returned line posts later as its own transaction whose header reverses this one. UNIQUE (transaction_id, account_id): two lines to one account must be netted. A run for 5,000 staff who bank here is 5,001 entries: about 0.7 s on the WASM build, over the writer\'s 250 ms, so it runs as payroll_writer (5 s); chunks through PAYROLL_CLEARING_GBP remain the fallback for larger runs.',
        },
        {
          title: 'Money in from a scheme, and the scheme settling',
          lang: 'sql',
          code: `-- an incoming Faster Payment: one transaction, no hold
-- NOSTRO_BOE_GBP row 0   0a000000-0000-4000-8000-000000000001
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900810', '0a000000-...000001', -45000, 'GBP'),
 ('7d1f0a52-...900810', '5f0c2a9e-...081442',  45000, 'GBP');
-- header FPS_IN; its id is made from the rail and the scheme's
-- own reference, so a resent message is refused by the header

-- the scheme settles with the bank at the Bank of England:
-- this payment's part of the cycle
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900820', '1c9d4e2a-...000007', -120000, 'GBP'),
 ('7d1f0a52-...900820', '0a000000-...000001',  120000, 'GBP');
-- FPS_CLEARING_GBP back towards 0; the nostro, an asset, is
-- negative when money sits at the bank (credit is positive)`,
          note: 'Simplified as the review asked: Faster Payments settles between banks in cycles, so a fuller model would credit the wallet from FPS_CLEARING_GBP and move the nostro only at settlement (the writer\'s knowledge, not checked). NOSTRO_BOE_GBP is NOSTRO with allow_negative TRUE, split like other busy system accounts.',
        },
        {
          title: 'Partitioned by month: the keys must change, and guard nothing',
          lang: 'sql',
          code: `-- PostgreSQL refuses the owner's keys on a table partitioned by
-- created_at: a unique key must include the partition column.
CREATE TABLE ledger_entries (
    entry_id BIGSERIAL,
    transaction_id UUID NOT NULL
        REFERENCES ledger_transactions(transaction_id),
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entry_id, created_at),
    UNIQUE (transaction_id, account_id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE ledger_entries_2026_11 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

-- created_at defaults to now(), so a replay always carries a new
-- created_at: this UNIQUE never fires, not even within a month.
-- The guards are the header's primary key (kept for good) and
-- idempotency_keys (72 hours, with the saved reply).`,
          note: 'The indexes, triggers and the foreign key to the unpartitioned header are declared on the parent as before. Run here: the same (transaction_id, account_id) inserted twice in one month went in twice; the header refused the replayed id.',
        },
        {
          title: 'Holds stay unpartitioned: the archive job',
          lang: 'sql',
          code: `CREATE TABLE pending_holds_history (LIKE pending_holds)
  PARTITION BY RANGE (created_at);     -- no uniqueness needed
CREATE TABLE pending_holds_history_2026_08
  PARTITION OF pending_holds_history
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- daily, as the archive role, in batches
WITH moved AS (
  DELETE FROM pending_holds
   WHERE hold_id IN (SELECT hold_id FROM pending_holds
                      WHERE status <> 'ACTIVE'
                        AND created_at < now() - interval '90 days'
                      LIMIT 10000)
  RETURNING *)
INSERT INTO pending_holds_history SELECT * FROM moved;
-- hold_ended lets a DELETE through only for a hold that is no
-- longer ACTIVE; only the archive role has the DELETE grant`,
          note: 'Copy and delete are one statement, so a hold is never lost between them. Each delete leaves a dead row for vacuum, about 86 million a day at the stress load. Partitioning pending_holds itself lost: its key would have to be (hold_id, created_at), and ON CONFLICT (hold_id) then errors (42P10).',
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
      how: "At the end of each business day, for each logical system account, one balanced transaction moves the 16 rows' posted balances into the master account, and a job writes each account's balances for the day. Every minute, overdue ACTIVE holds are marked EXPIRED, one account per transaction, the account row locked first.",
      delivery: "Idempotent: each sweep's header has kind SWEEP and external_ref the account and the business date, so a rerun finds it and does nothing. Expiring a hold twice is impossible: the second update finds it no longer ACTIVE.",
      alts: ['Sweeping every minute.', 'No sweep: reports always sum the 16 rows.'],
      ways: [
        { name: 'SQL', chosen: true, what: 'Once a day per logical account: lock the master and its 16 rows in account_id order, insert the header, debit each row by its posted balance and credit the master with the total. Every minute: for each account with due holds, lock it, then expire up to 50 of its holds. These run as batch roles with longer timeouts than payments.', pros: ['An ordinary ledger transaction: same triggers, same checks.', 'Idempotent: a rerun for the same date does nothing.', 'Touches each hot row once a day.'], cons: ["One more writer on each row's lock while it runs.", 'The master lags by up to a day.'] },
        { name: 'Sweeping every minute', what: "An earlier version: the same transaction, keyed by account and minute.", pros: ['Masters are never far behind.'], cons: ['1,440 sweeps a day per account, each locking 16 hot rows.', 'Buys nothing a report summing 17 rows does not give.'] },
        { name: 'No sweep', what: 'Totals stay in the 16 rows for good, and every report sums them with the master.', pros: ['Nothing to run.', 'Nothing lags.'], cons: ['Every reader must know to sum 17 rows.', 'One report that forgets shows a near-empty master.'] },
      ],
      examples: [
        {
          title: 'The end-of-day sweep of fee revenue, as one transaction',
          lang: 'sql',
          code: `BEGIN;
SELECT account_id FROM accounts
 WHERE logical_account IN ('FEE_REVENUE_GBP',
                           'FEE_REVENUE_GBP_MASTER')
 ORDER BY account_id FOR NO KEY UPDATE;
INSERT INTO ledger_transactions (transaction_id, kind,
  external_ref, description, value_date, created_by)
VALUES ('7d1f0a52-...900452', 'SWEEP', 'FEE_REVENUE_GBP:2026-11-12',
  'End-of-day sweep', '2026-11-12', 'sweeper')
ON CONFLICT DO NOTHING;   -- 0 rows: swept already; ROLLBACK
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
          note: 'The master is its own logical account, because uq_logical_shard gives FEE_REVENUE_GBP exactly rows 0 to 15. The rows are locked, so their balances cannot change between the read and the insert. If nothing is to be swept, the job rolls back: a header with no entries fails at COMMIT. Runs as the sweeper role, with a longer statement_timeout than payments.',
        },
        {
          title: 'The hold expiry job, every minute',
          lang: 'sql',
          code: `-- which accounts have due holds (the partial index)
SELECT DISTINCT account_id FROM pending_holds
 WHERE status = 'ACTIVE' AND expires_at < now();

-- then one account per transaction, the account row first
BEGIN;
SELECT 1 FROM accounts
 WHERE account_id = '5f0c2a9e-...081442' FOR NO KEY UPDATE;
UPDATE pending_holds SET status = 'EXPIRED'
 WHERE hold_id IN (SELECT hold_id FROM pending_holds
                    WHERE account_id = '5f0c2a9e-...081442'
                      AND status = 'ACTIVE' AND expires_at < now()
                    LIMIT 50);
-- each row: the trigger lowers held_balance; one outbox row each
COMMIT;  -- again while 50 came back, then the next account`,
          note: 'Both queries match idx_holds_active_account (account_id, expires_at) WHERE status = \'ACTIVE\'. Account first, as capture, void and repayments do: run against wallet-to-card repayments for 3 seconds on PostgreSQL 16, it expired 4,000 holds with no deadlock and no lock timeout, and the caches equalled the journal. An expired hold then captures 0 rows.',
        },
        {
          title: 'End of day: the business date, and the balances for it',
          lang: 'sql',
          code: `-- after the cut-off for business date 2026-11-12, by a calendar
-- in Europe/London; payments carry on, dated 2026-11-13
CREATE TABLE account_balances_daily (
    account_id UUID NOT NULL, business_date DATE NOT NULL,
    posted BIGINT NOT NULL, held BIGINT NOT NULL,
    last_entry_id BIGINT NOT NULL,
    PRIMARY KEY (account_id, business_date));
INSERT INTO account_balances_daily
SELECT a.account_id, '2026-11-12', a.posted_balance,
       a.held_balance,
       coalesce((SELECT max(e.entry_id) FROM ledger_entries e
                  WHERE e.account_id = a.account_id), 0)
  FROM accounts a;          -- in batches of accounts in practice`,
          note: 'End of day is a date, not a stop. Statements, interest, the Single Customer View and reconciliation read this table. last_entry_id is this design\'s addition: each row records the balance with the last entry it includes, so a later check can add only newer entries. That works because, for one account, entry_id rises in the order of the account lock.',
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
    "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000417",
    "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
    "payload": "<the event as JSON text: see ledger-events>"
  },
  "source": {
    "connector": "postgresql",
    "table": "outbox",
    "lsn": 249113864
  }
}`,
          note: 'op "c" is an insert; lsn is the position in the write-ahead log. The relay copies seq, not lsn, into the event as the number readers dedupe on. This row is the capture\'s; the hold wrote one too. A transfer between two customers writes one row for each account.',
        },
      ],
    },
    {
      id: 'publish', from: 'relay', to: 'kafka', d: 'M1104,350 H1140 Q1150,350 1150,360 V443', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.7,
      how: "Each outbox row becomes one event on ledger-events, keyed by account so an account's events keep their order.",
      delivery: 'At least once, in order per account. Events carry the outbox seq so readers can drop repeats.',
      alts: ['One topic per event type.', 'A managed stream (Kinesis, Pub/Sub).'],
      ways: [
        { name: 'Kafka, keyed by account', chosen: true, what: "The relay turns each outbox row into one event on ledger-events, keyed by account. Kafka keeps order within a partition, so each account's events stay in order.", pros: ['Ordered per account.', 'Replayable for every reader.', 'Light: about 3 MB a second on average, about 30 MB at peak.'], cons: ['At least once: events carry the outbox seq so readers can drop repeats.', 'A partition holding a busy account can lag behind the others.'] },
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
  "seq": 5512930,
  "committed_at": "2026-11-12T10:41:03.118Z"
}`,
          note: 'Signed minor units: plus a credit, minus a debit, each with its currency. The capture also emits hold.ended for ...0417; the hold emitted hold.placed. seq lets a reader drop a repeat: per account it rises in commit order.',
        },
        {
          title: 'Message value: the card settlement of a dollar purchase',
          lang: 'json',
          code: `{
  "type": "transaction.posted",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900521",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000520",
  "card": { "transaction_amount": 10000,
            "transaction_currency": "USD",
            "billing_amount": 7900, "fx_fee": 79 },
  "entries": [
    { "account": "5f0c...081442", "amount": -7979, "currency": "GBP" },
    { "account": "MASTERCARD_DEBIT_CLEARING_GBP/7", "amount": 7900,
      "currency": "GBP" },
    { "account": "FX_FEE_REVENUE_GBP/7", "amount": 79,
      "currency": "GBP" }
  ],
  "seq": 5530417
}`,
          note: 'The dollar amount travels on the event and the card record, never in ledger_entries: the ledger saw only the pounds the network billed. Figures illustrative.',
        },
      ],
    },
    {
      id: 'notify', from: 'kafka', to: 'consumers', d: 'M1120,475 H975', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.5,
      how: 'Each consumer group reads at its own pace: notifications in seconds, billing and the warehouse in batches.',
      delivery: 'At least once. Consumers keep the last applied outbox seq per account and skip anything older.',
      alts: ['Webhooks pushed to partners from a dedicated consumer.'],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Each consumer group reads ledger-events at its own pace: notifications within seconds, billing and the warehouse in batches. Each keeps its own position.', pros: ['A slow consumer builds lag, not payment latency.', 'Each can replay from its own position.'], cons: ['At least once: each keeps the last outbox seq per account and skips anything older.', 'Lag to watch per group.'] },
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

last applied  seq 5512871 for the wallet (hold.placed, ...0417)
this event    seq 5512930, transaction.posted, ...900418
              -> newer: send the push, store 5512930

same event again after a relay restart
              seq 5512930, not newer -> skip`,
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
          code: `-- Every few minutes, for the accounts touched since the last
-- watermark. Any row returned is a broken cache; expect none.
SELECT a.account_id, a.posted_balance, a.held_balance
  FROM accounts a
  LEFT JOIN account_balances_daily d
    ON d.account_id = a.account_id
   AND d.business_date = '2026-11-12'
 WHERE a.account_id IN (SELECT account_id FROM ledger_entries
                         WHERE entry_id > 7730000)  -- watermark
   AND (a.posted_balance <> coalesce(d.posted, 0) +
        (SELECT coalesce(sum(e.amount), 0) FROM ledger_entries e
          WHERE e.account_id = a.account_id
            AND e.entry_id > coalesce(d.last_entry_id, 0))
     OR a.held_balance <> (SELECT coalesce(sum(h.amount), 0)
          FROM pending_holds h
         WHERE h.account_id = a.account_id
           AND h.status = 'ACTIVE'));

-- and all posted balances sum to zero in each currency
SELECT currency, sum(posted_balance) FROM accounts
 GROUP BY currency HAVING sum(posted_balance) <> 0;`,
          note: 'Not on this line: reconciliation queries a replica directly. One MVCC snapshot sees a balance, its entries and its holds together, because the triggers wrote them in one transaction. An account opened since the snapshot has no daily row and is summed from zero. A full re-sum of every account, from period totals and entries, runs weekly on a replica.',
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
FPS-SETTLE,2026-11-12,TOTAL,41380750,

also: boe-settlement-account-2026-11-12.csv, the statement of
the bank's account at the Bank of England, with its closing
balance at the cut-off`,
          note: 'The column layout is illustrative; each bank and scheme has its own, and each needs its own parser.',
        },
        {
          title: 'The comparison, and the break',
          lang: 'text',
          code: `business date 2026-11-12, at the cut-off (Europe/London)

NOSTRO_BOE_GBP      ledger = statement closing balance     ok

FPS_CLEARING_GBP (master and 16 rows, every cluster)
  credited by the day's captures         41380250p
  debited by the scheme's settlement     41380750p
  left on the account                        -500p   should be 0

-> break brk_1127 raised with an owner, the amount
   and the lines on each side that do not match`,
          note: 'The settlement posting follows the scheme\'s file, so the nostro matches the bank and the clearing account shows the gap: £5 settled that the ledger never captured.',
        },
      ],
    },
    {
      id: 'history', from: 'ledger', to: 'replicas', d: 'M550,228 V345 Q550,355 560,355 H700', label: 'statement page',
      mode: 'call', via: 'SQL read', chip: 0.73,
      how: 'Statements and history are read from an asynchronous replica: ledger_entries for one account with each header\'s description and value date, newest first by entry_id, 50 at a time, continuing from the last entry_id seen. Pending items are the account\'s ACTIVE holds, listed above them.',
      delivery: 'Read-only and repeatable. A page may lag the primary by a second, which a statement can tolerate.',
      alts: ['A search index fed from the topic, for filtering by payee or amount.', 'The primary, when a page must include a payment made a moment ago.'],
      ways: [
        { name: 'SQL read from a replica', chosen: true, what: "The Ledger API reads one account's entries from an asynchronous replica, newest first by entry_id, 50 at a time, continuing from the entry_id of the last row seen.", pros: ['Takes statement load off the primary.', 'Cursor pages stay stable as new entries arrive.'], cons: ['A page may lag the primary by a second.', 'A payment made a moment ago may be missing.'] },
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
SELECT e.entry_id, e.amount, e.currency, t.description,
       t.value_date
  FROM ledger_entries e
  JOIN ledger_transactions t USING (transaction_id)
 WHERE e.account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
 ORDER BY e.entry_id DESC
 LIMIT 50;

-- Next page: older than the last row seen
SELECT e.entry_id, e.amount, e.currency, t.description,
       t.value_date
  FROM ledger_entries e
  JOIN ledger_transactions t USING (transaction_id)
 WHERE e.account_id = '5f0c2a9e-...081442'
   AND e.entry_id < 7730512
 ORDER BY e.entry_id DESC
 LIMIT 50;`,
          note: "Paged by entry_id, not created_at. created_at is the transaction's start, so two commits can land in the other order; for one account, entry_id follows the account lock (a reviewer's reasoning, not tested). idx_ledger_account_entry serves it; the owner's created_at index serves date ranges.",
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
          note: 'idx_holds_active_account (account_id, expires_at) WHERE status = \'ACTIVE\', this design\'s addition, finds them; the expiry job uses the same index.',
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
        { name: 'Direct SQL on the database', what: 'An engineer changes the wrong rows in the database by hand.', pros: ['Fastest to do, if it were allowed.'], cons: ['The triggers refuse it: entries and headers cannot be updated or deleted, ACTIVE holds cannot be deleted, and balances cannot be edited directly.', 'Getting round them needs the table owner or a superuser, which leaves no record of the mistake or of who fixed it.'] },
      ],
      examples: [
        {
          title: 'Example call, after a second person approves',
          lang: 'text',
          code: `Post
{ "idempotency_key": "brk_1127",
  "header": { "transaction_id": "7d1f0a52-...000000901733",
    "kind": "CORRECTION", "external_ref": "brk_1127",
    "description": "FPS settlement 2026-11-12 unmatched £5",
    "value_date": "2026-11-12" },
  "entries": [
    { "account": "FPS_CLEARING_GBP_MASTER", "amount": 500,
      "currency": "GBP" },
    { "account": "SUSPENSE_GBP", "amount": -500, "currency": "GBP" }
  ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000901733",
     "status": "COMMITTED" }

Approved twice: the same call with key brk_1127
-> the same reply; posted once`,
          note: 'The scheme settled 500p more than the ledger captured, leaving FPS_CLEARING_GBP at -500. This brings it back to zero; SUSPENSE_GBP (allow_negative TRUE) holds -500p until it is traced. A correction of one known transaction would name it in reverses.',
        },
      ],
    },
    {
      id: 'export', from: 'replicas', to: 'archive', d: 'M760,400 V465 Q760,475 750,475 H615', label: 'old months',
      mode: 'write', via: 'export', chip: 0.75, cold: true,
      how: 'Off the hot path. Monthly, the oldest partition of ledger_entries (past 13 months) is exported from a replica to Parquet with its row count and sums, per-account totals are saved, then it is detached on the primary. Ended holds move to pending_holds_history by their own job, and headers stay.',
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
          note: "net is 0 per currency because every entry of one transaction gets the same created_at (now() is the transaction's start), so a transaction never spans two partitions. CONCURRENTLY takes only a SHARE UPDATE EXCLUSIVE lock on the parent. The month's headers stay: they reference nothing in the partition. Counts illustrative.",
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
        fix: "The app makes the key k7 (a random UUID) once, before the first attempt, stores it with the draft payment and sends it in the Idempotency-Key header on every attempt. The ledger stores the key with a hash of the request for 72 hours, so a repeat returns the first result (step 7), and makes the capture's transaction id from it, so the header refuses a replay for good. The cost: every client must make the key once and reuse it, so the SDKs do it for them.",
      },
      explain: [
        { q: "What is an idempotency key?", a: "A label the app makes once for one payment and sends with every attempt at it. \"Idempotent\" means doing something twice has the same effect as doing it once. Here k7 stands for a version 4 UUID, a value with 122 random bits, so two payments will not pick the same one by chance." },
        { q: "Why does the app make the key, not the bank?", a: "Only the sender knows that two requests are the same attempt. If the bank made a fresh id for each request it received, a resend would get a fresh id too and look like a new payment." },
        { q: "Why 120000 and not 1200.00?", a: "Amounts are stored as whole numbers of the smallest unit, pence for pounds and cents for dollars, with the currency beside them (minor units). Whole numbers add up exactly; decimal fractions in floating point do not." },
        { q: "What does the ledger serve besides this payment?", a: "It is the bank's central ledger: bank payments like this one, payroll, debit and credit card authorisations and settlements, and accounts in several currencies. The tour follows one bank payment; the card, FX and credit flows are in the connection details and the drills." },
        { q: "What kind of firm is this?", a: "An authorised bank. The bakery's balance is a deposit on the bank's balance sheet, protected by FSCS up to the limit, and the ledger must be able to produce the Single Customer View file on demand. An e-money firm would instead safeguard the same balances under CASS 15 and reconcile them every business day." },
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
        { q: "Whose limit is checked?", a: "The bank's. Faster Payments allows up to £1 million a payment, but each bank sets its own lower limit, and the Banking API checks that one. The ledger checks only money: the account's limit and status." },
      ],
    },
    {
      title: 'Place a hold',
      text: "The Banking API asks the Ledger API to hold the money, so two payments cannot spend the same pounds. A hold is a row in pending_holds, not a ledger entry: 120020p, the £1,200 plus a 20p fee, on Bright Bakery's GBP wallet. In one call the Ledger DB stores key k7, locks the wallet row, inserts the hold only if the wallet is open and the money is there, and adds an outbox row. A trigger raises the wallet's held balance.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn'],
      labels: ['hold £1,200.20', '1 hold row'],
      story: {
        context: "The checks passed. The bakery's GBP wallet has a posted balance of 842000p (£8,420) and nothing held, so 842000p is available. The payment is 120020p in all. Faster Payments has not been asked yet.",
        problem: "Other payments and card authorisations on the same wallet may be in flight. If two of them each read \"£8,420 available\" and then each spend it, the wallet goes below zero. And the payment cannot be posted yet, because the scheme may still reject it.",
        consequence: "Without a hold, the bakery could spend the same money twice and the bank would be lending money it never agreed to lend. If any code path could place a hold without moving held_balance, or move a balance by hand, the caches would drift from the truth and every check built on them would be wrong.",
        fix: "One database transaction, as the ledger_writer role, whose settings give lock_timeout 50 ms and statement_timeout 250 ms: insert key k7 with a hash of the request; lock the wallet with FOR NO KEY UPDATE; insert hold ...0417 only if the wallet is OPEN and posted - held - 120020 >= -credit_limit (the wallet's limit is 0); add the outbox row; save the result; commit. The insert fires a trigger that adds 120020 to held_balance, so posted stays 842000 and available drops to 721980. Had the money not been there, the decline would be saved and committed, so a retry gets the same decline. If a path skipped the test, the CHECK valid_available_funds would refuse the row at the hard floor, which for a wallet is also 0. The cost: one extra UPDATE, the wallet row locked about 1 to 2 ms, and a writer that waits 50 ms for the lock gives up and is retried.",
      },
      explain: [
        { q: "What is a hold?", a: "Money set aside for a payment that is not final: a row in pending_holds with an amount, a currency, an expiry and a status, ACTIVE until it is captured, voided or expires. While it is ACTIVE the money cannot be spent, but nothing is in the journal yet." },
        { q: "What are posted, held and available?", a: "posted_balance is the sum of the account's settled entries. held_balance is the sum of its ACTIVE holds. Available is posted minus held, plus the credit limit if it has one. Here: 842000 posted, 120020 held, 721980 available." },
        { q: "What is a trigger?", a: "A function the database runs by itself when a row is written, inside the same transaction. Here an AFTER INSERT trigger on pending_holds adds the hold's amount to held_balance. No code path can place a hold and forget the balance." },
        { q: "What does FOR NO KEY UPDATE do?", a: "SELECT ... FOR NO KEY UPDATE locks the rows it reads until the transaction ends, so a second payment on the same wallet waits its turn. It is the weakest lock that does this; unlike FOR UPDATE, it does not block the foreign key check that inserting a hold makes on the account." },
        { q: "What are lock_timeout and statement_timeout?", a: "lock_timeout = '50ms' makes a statement give up if it waits more than 50 ms for a lock; statement_timeout = '250ms' stops any statement running longer than 250 ms. Either rolls the transaction back, and the caller retries with the same key. A burst then fails fast instead of piling up." },
        { q: "Why set them on the role, not inside the function?", a: "The statement timer starts when the client's statement arrives, so SET LOCAL statement_timeout inside the ledger function does nothing for that call. ALTER ROLE ledger_writer SET ... applies when PgBouncer's server connection logs in, so it holds in transaction pooling (checked: a 1 s function was cancelled at 251 ms). Neither bounds the COMMIT's wait for a standby; the client's deadline does." },
        { q: "What is the CHECK constraint?", a: "A rule the database checks on every row it writes: CHECK (allow_negative OR (posted_balance - held_balance) >= -hard_limit). credit_limit is the soft limit the hold tests; hard_limit is the floor the database enforces, for debits the bank cannot refuse, such as interest. A debit wallet has 0 for both, so it cannot go below zero." },
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
        { q: "How does a card payment fit this?", a: "The other way round: the card network asks the bank. An authorisation becomes a hold: for USD 100.00 the network sends the billing amount in pounds, 8000p, and the bank holds 8240p with a buffer. The settlement a day or two later captures it. If none comes by expires_at, the expiry job ends the hold." },
        { q: "Why does the Banking API talk to the scheme, not the ledger?", a: "The ledger only records money. If it called the scheme itself it would wait on an outside network while holding payment state, and a slow scheme would slow every balance read." },
      ],
    },
    {
      title: 'Capture: post the entries',
      text: "Faster Payments accepted, so the Banking API asks the Ledger API to capture the hold. The Ledger DB writes the header of transaction ...900418, then in one statement marks hold ...0417 CAPTURED and writes three entries that sum to zero: minus 120020p from the wallet, plus 120000p to Faster Payments clearing, plus 20p to fee revenue. Had the scheme rejected the payment, a void would have ended the hold and posted nothing.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['capture k7', '3 entries', 'committed', 'settled'],
      story: {
        context: "The scheme has accepted pay_3fK9, and the Banking API has recorded it as SETTLED on the payment. In the ledger, hold ...0417 is ACTIVE: posted 842000p, held 120020p. The journal has nothing for this payment yet.",
        problem: "The money must be posted once and only once, the hold must end at the same moment, and the record must stay readable for audit. The capture itself can be repeated, by a retry or by a recovery worker, and a void or the expiry job could race it.",
        consequence: "A capture that posted but left the hold ACTIVE would count the payment twice against the wallet. A repeated capture would pay the clearing account twice. A capture and a void both succeeding would post a payment the bank had already given back.",
        fix: "Capture with key k7:capture. The function locks the wallet, FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7 in account_id order, inserts the header (kind FPS_OUT, external_ref pay_3fK9, description INV 3318, value date 2026-11-12), then runs one statement: a CTE updates the hold to CAPTURED only if it is ACTIVE, and the INSERT of the three entries joins to it. Either both happen or neither. The hold trigger lowers held_balance by 120020 and the entry trigger lowers posted_balance by 120020: posted 721980, held 0, available unchanged at 721980. A second capture, a late void or the expiry job finds the hold no longer ACTIVE and changes nothing; at COMMIT a trigger checks once that the transaction has two or more entries summing to zero. The cost: a status that changes, in pending_holds; the journal itself never changes.",
      },
      explain: [
        { q: "What does capture mean?", a: "Turning a hold into settled money: the hold is marked CAPTURED and the entries are posted, in one statement. The amount posted may differ from the hold: a card settlement at a better rate captures a hold of 8240p with entries of 7979p, and the rest is free again." },
        { q: "What is a void?", a: "The other outcome: the hold is marked VOIDED and held_balance falls back. Nothing is posted, so the statement shows no payment and no reversal. A hold leaves ACTIVE exactly once, so a void after a capture changes nothing." },
        { q: "What is a force-post?", a: "A card settlement that arrives with no live hold, or for more than was held. The bank must accept it, so it skips the soft limit and posts as far as the hard floor, ending any live hold in the same transaction. Past the floor, the rest goes to that customer's own receivable account, money the customer now owes." },
        { q: "Why do posted and held both move, and available not?", a: "The money was already counted against the wallet by the hold. At capture it moves from held to posted: held falls by 120020, posted falls by 120020, available stays at 721980." },
        { q: "How is an entry kept from being changed?", a: "A BEFORE UPDATE OR DELETE trigger on ledger_entries raises an error, so the statement fails whoever runs it, and a statement trigger refuses TRUNCATE. Triggers do not stop DROP TABLE, so the ledger's role is also granted only INSERT and SELECT." },
        { q: "What is the header row?", a: "One row in ledger_transactions per transaction: its id, kind, the scheme's reference, a description and a value date. The Banking API made the id from its client id and k7:capture, so a replay of the capture, even years later, hits the same primary key." },
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
        fix: "The hold function starts with INSERT INTO idempotency_keys ... ON CONFLICT (client_id, key) DO NOTHING. k7 is already there with the same request hash, so nothing is inserted; the function returns the result saved with k7 and stops. Had the body differed, the call would be refused. The hold id is made from the request too, so even without the key the hold's primary key would refuse a second hold ...0417, and the capture's transaction id would hit the header's primary key. If two retries arrive at once, the key lets one insert win and the other waits, then returns the stored result. Keys are kept 72 hours: about 100 GB across all clusters.",
      },
      explain: [
        { q: "Why did the app send again at all?", a: "A network call needs a time limit, and after it runs out the app cannot know whether the request arrived. Sending again with the same key is safe, so the app does." },
        { q: "Where is k7 stored?", a: "In the idempotency_keys table on the bakery's ledger cluster, with a unique constraint, written in the same transaction as the hold. So the key exists if and only if the hold committed." },
        { q: "What does the app see?", a: "The same reply as the first time: 201 Created for payment pay_3fK9, status pending, read from the saved result. To learn that it has settled, it asks GET /payments/pay_3fK9." },
        { q: "Are there other guards behind the key?", a: "Two. The hold_id primary key refuses a second hold with the same id, and the header's primary key refuses a transaction id already used; the header is kept for good, so that guard never expires. The key comes first so a retry gets the saved answer instead of an error." },
        { q: "How long is a key kept?", a: "72 hours, at about 200 bytes each with its request hash. Stripe says it may prune keys once they are 24 hours old; Brandur Leach suggests about 72." },
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
        fix: "The relay runs Debezium, which reads the Ledger DB's write-ahead log through a replication slot and receives only committed outbox rows, in commit order. Each becomes one event on ledger-events, keyed by the wallet's account_id and carrying the outbox seq, 5512930. A bank payment makes three events: hold.placed, hold.ended and transaction.posted; a transfer between two customers writes an outbox row for each. Delivery is at least once, so the notifications consumer skips anything at or below the last seq it applied for that account. The cost: a connector to run, and a slot that holds log on the primary's disk until the relay catches up.",
      },
      explain: [
        { q: "What is CDC?", a: "Change data capture: reading committed changes from the database's own log, in the order they committed, and turning them into events. A change that rolled back never appears." },
        { q: "What is Debezium?", a: "An open-source change data capture tool. It connects to a database's change log, here through Postgres logical decoding, and emits each committed row change as an event with its log position." },
        { q: "What is a replication slot?", a: "Postgres's bookmark for one log reader. It records how far the relay has read and keeps the log from being deleted until then. If the relay stops, log piles up on the primary's disk, so the slot is watched. It is a failover slot, so it survives promotion of a standby (PostgreSQL 17 and later; not run here)." },
        { q: "What is Kafka, and why key by account?", a: "Kafka is a log service: messages are appended to a topic split into partitions, and each reader keeps its own position and can re-read. Messages with the same key go to the same partition, in order, so a hold's events never arrive after its capture's." },
        { q: "What if Kafka is down?", a: "The ledger carries on. Outbox rows wait in the database's log, and the relay catches up when Kafka returns." },
        { q: "Where do queues come in?", a: "In front of the ledger, for work that can wait: payroll runs, payouts, billing's daily interest accruals. A queue (Kafka or SQS) absorbs a spike and a worker feeds the Ledger API at a steady rate. Card authorisations cannot wait, so they never queue." },
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
        fix: "GetBalance reads one accounts row on the primary with a plain SELECT, which never waits for a writer's lock, and returns posted, held and available = posted - held + credit_limit. A guard trigger refuses any UPDATE of either balance that does not come from a trigger, and any account opened with a balance. Reconciliation checks every few minutes that posted equals the entries and held equals the ACTIVE holds. The table uses fillfactor 80, so the triggers' updates usually stay on the same page. The cost is read load on the primary; the whole table is under 300 MB, so it stays in memory.",
      },
      explain: [
        { q: "Which figure does the owner see?", a: "Both, as banks usually show them: the posted balance, what has settled, and the available balance, what can be spent. Between the hold and the capture they differed: posted 842000, available 721980." },
        { q: "And for a credit card?", a: "The same row shape. The bakery's card has credit_limit 500000 and hard_limit 550000. After a £649.00 purchase and a £300.00 repayment its posted balance is -34900, meaning the bakery owes £349.00, and its available credit is 500000 - 34900 = 465100. Daily interest accrues between the bank's own accounts and reaches the card only on statement day." },
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
        fix: "Asynchronous replicas serve statements. The first page is the newest 50 ledger_entries rows for the wallet by entry_id, each with its header's description, found through an index on (account_id, entry_id); the next asks for entry_ids below the last one seen. Not created_at: that is each transaction's start, so two commits can land in the other order. Pending items are the wallet's ACTIVE holds, shown above the entries; a voided payment never appears at all. The cost: a page may lag the primary by about a second.",
      },
      explain: [
        { q: "What is an asynchronous replica?", a: "A read-only copy that receives the primary's log, but the primary does not wait for it. It usually trails by milliseconds and can fall seconds behind under heavy load." },
        { q: "Why is lag acceptable here but not for the balance?", a: "A statement only shows history. Nothing is decided from it, so being a second behind does no harm." },
        { q: "What does \"continuing from the last entry seen\" mean?", a: "Keyset (cursor) pagination. The next page is \"entries with an entry_id below the last one seen\", found through the index, not \"skip 50\". For one account, entry_id follows the account lock, so it is the order the money moved." },
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
        context: "In step 6 the capture credited FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7. The wallet's row is touched only by its own payments, but these system accounts are touched by nearly every payment of their rail and currency. Card settlements hit MASTERCARD_DEBIT_CLEARING_GBP and FX_FEE_REVENUE_GBP the same way; credit card spending and interest hit MASTERCARD_CREDIT_CLEARING_GBP, INTEREST_RECEIVABLE_GBP and INTEREST_INCOME_GBP; incoming payments hit NOSTRO_BOE_GBP.",
        problem: "The trigger's UPDATE locks the account row until the commit, and the commit waits for a standby in another zone. Assuming 1 to 2 ms a lock, one row takes roughly 500 to 1,000 writes a second (an estimate). One cluster at peak takes about 2,500 payments a second. Fee revenue is never checked for a floor, but the trigger still locks it.",
        consequence: "Payments would queue behind a single row: their 50 ms lock_timeout would fire, they would be retried, and the retries would add load. The cluster's whole payment rate would be capped by one row.",
        fix: "Each system account is a logical account of 16 rows with allow_negative TRUE, and the Ledger API writes to shard_id = hash(transaction_id) % 16: about 156 writes a second on each row at the peak. At the end of the day the Sweeper posts one balanced transaction per logical account, locking the master and its 16 rows in account_id order and moving each row's total into the master, keyed by account and date. The cost: masters lag by up to a day, reports sum 17 rows, and with allow_negative TRUE no row can enforce a limit; reconciliation watches them.",
      },
      explain: [
        { q: "What is a hot account?", a: "An account in most transactions, such as fee revenue or a scheme clearing account. Its row becomes a queue, because only one writer can hold its lock at a time." },
        { q: "What are a logical account and shard_id?", a: "A logical account is a chart-of-accounts name, such as FPS_CLEARING_GBP. shard_id numbers its rows, 0 to 15; UNIQUE (logical_account, shard_id) keeps one row per number. Customer wallets and cards have no logical account and shard_id 0." },
        { q: "Why are system accounts named by currency too?", a: "No account ever holds two currencies, so each currency has its own pool, clearing account and revenue account. A transaction must sum to zero in each currency on its own." },
        { q: "What is an FX pool?", a: "The bank's own account per currency for exchanges. When the bakery converts pounds to dollars between its own wallets at 1 USD = 0.80 GBP, FX_POOL_GBP is credited and FX_POOL_USD debited. The pools drift apart, long pounds and short dollars, until treasury does a real FX trade. A card purchase in dollars does not touch them: the network bills the card in pounds." },
        { q: "Why does allow_negative TRUE matter here?", a: "A clearing account is credited by some payments and debited by others, and a split row can dip below zero even when the total is fine. With allow_negative TRUE the CHECK lets it, so limits on system accounts are reconciliation's job." },
        { q: "Why only once a day?", a: "The owner's choice. Every entry is already exact, so the master plus its 16 rows is always right. The sweep is tidiness, not safety, and once a day is one lock on each row instead of 1,440." },
      ],
    },
    {
      title: 'Reconciliation finds a break',
      text: "After the day's cut-off, Reconciliation checks the ledger against the outside world. The bank's account at the Bank of England (NOSTRO_BOE_GBP in the ledger) matches its statement, but Faster Payments clearing should be back to zero after the scheme's settlement and is £5 short. Locks cannot catch a wrong amount or a lost message, but this can. A break is raised with an owner and fixed by a correcting transaction. No entry is edited.",
      focus: ['files', 'recon', 'kafka'],
      path: ['files'],
      labels: ['statement'],
      story: {
        context: "Business date 2026-11-12 has passed its cut-off. All day, captures credited FPS_CLEARING_GBP, its master and 16 rows over every cluster: 41380250p. The scheme's settlement file says 41380750p settled, and the settlement posting moved that from FPS_CLEARING_GBP to NOSTRO_BOE_GBP, the ledger's mirror of the bank's real account at the Bank of England. The bank's statement for that account arrives over SFTP.",
        problem: "Locks and keys stop two writers racing. They do not stop a bug posting a wrong amount, a scheme message that never arrived, or a bank error, and the ledger agrees with itself even when it is wrong. Here the nostro equals the statement's closing balance, but FPS_CLEARING_GBP is left at -500p instead of zero: £5 settled that the ledger never captured.",
        consequence: "Unchecked, errors pile up: a customer keeps money a bug wrongly gave them, and the books drift away from the real money at the bank. A bank must also be able to produce its Single Customer View for FSCS from these balances, so they have to be right.",
        fix: "Two checks at the cut-off: each nostro must equal its statement's closing balance, and each clearing account must be back to zero after its settlement cycle, or be aged. Break brk_1127 is raised with an owner, the amount and the lines on each side that do not match. Once the cause is found and a second person approves, a correcting transaction goes through the Ledger API like any other, its id made from brk_1127, so approving twice posts once. The same checks watch what the CHECK does not: the FX pools' drift, the customers' receivables, and holds past their expiry. The cost: a team that owns breaks, and a day before an outside error is seen.",
      },
      explain: [
        { q: "What is reconciliation?", a: "Comparing your own record of money with an independent record of the same money. Here the ledger is checked against bank statements and settlement reports at each business day's cut-off, and against its own rules every few minutes: each currency sums to zero, posted equals the entries, held equals the ACTIVE holds." },
        { q: "What is FPS_CLEARING_GBP?", a: "The ledger's account for money owed out through Faster Payments: captures credit it, and the scheme's settlement with the bank debits it, so it should return to zero after each cycle." },
        { q: "What is a nostro?", a: "The ledger's copy of a real account the bank holds somewhere else, here at the Bank of England. It is an asset, so with credit positive its balance is negative. When the scheme settles, the posting is clearing -X, nostro +X; the nostro must then equal the bank's statement." },
        { q: "What is a break?", a: "A difference between the ledger and an outside record that nothing explains. It gets an owner, an amount and evidence, and is closed by a correcting entry or by a fix outside the ledger." },
        { q: "Does reconciliation check credit cards too?", a: "Inside the ledger, the same way as any account. Billing also keeps its own breakdown of each card balance into fees, interest and principal, and reconciles its total to the card's posted_balance every night." },
        { q: "Why not just fix the wrong entry?", a: "A trigger refuses any update or delete of an entry. A correction is a new transaction, approved by a second person, so the history shows both the mistake and the fix." },
      ],
    },
    {
      title: "When a cluster's primary dies",
      text: "Later, the machine running one cluster's primary dies. A failover tool fences it, so it can take no more writes, and promotes a synchronous standby from step 4 to be the new primary; that standby already holds every hold and transaction anyone was told about. Writes to that cluster pause, with a target of under a minute. Requests that timed out are retried with the same keys, so none is applied twice.",
      focus: ['db', 'replicas'],
      path: ['wal'],
      labels: ['promote'],
      story: {
        context: "Some time later, one cluster's primary fails: a hardware fault, or its zone going dark. Every business on that cluster has payments in flight, holds waiting for capture and card authorisations arriving, and some clients are waiting for replies that will never come.",
        problem: "Nobody can write to that cluster until a new primary takes over. Some requests committed but their replies were lost; others never committed. The clients cannot tell which is which. Card authorisations cannot wait for the failover.",
        consequence: "If the new primary lacked recent commits, acknowledged holds and payments would vanish. If retries were treated as new requests, payments would be applied twice. A long pause stops every business on that cluster paying anyone.",
        fix: "Because every commit waited for a standby (step 4), a standby holds every acknowledged hold and transaction: recovery point zero, for this one failure. The failover tool fences the old primary, then promotes the standby, aiming for under a minute. The CDC relay resumes from its failover slot on the new primary. Clients retry with the same keys: a write that committed finds its key and returns the saved result, and one that did not is applied once. Payroll and payouts wait in their queues. Card authorisations get a fast decline or the card processor's stand-in rules. The cost: writes to that cluster pause, and promotion needs a failover tool beside Postgres.",
      },
      explain: [
        { q: "What is a failover tool?", a: "A program run beside Postgres that watches each primary. When one fails, it promotes a standby and moves connections to it. Postgres does not make this decision on its own." },
        { q: "What does \"promote\" mean?", a: "Turning a standby, which until now only replays the primary's log, into the primary that accepts writes." },
        { q: "Which standby is promoted?", a: "One that has every acknowledged commit. The commit waited for either s1 or s2, so the tool must pick the standby furthest along the log." },
        { q: "What happens to a hold caught mid-flight?", a: "If it committed, it is on the new primary, still ACTIVE, and the payment carries on: capture or void as normal. If it did not, the retry places it now, once." },
        { q: "What if both standbys are lost?", a: "Commits on that cluster wait, and each waiting commit keeps its row locks, so everything touching those rows queues. Cancelling such a backend is not safe: it reports success with only a warning that the commit may not be replicated. So the runbook fences the primary and stops writes on that cluster rather than drop to asynchronous replication. Other clusters carry on." },
        { q: "Is recovery point zero always true?", a: "For one failure at a time. If the primary and the standby that confirmed a commit were lost together, that commit could be lost." },
        { q: "What about losing a whole region?", a: "The standbys are in other zones of the same region. Losing the region risks the last seconds of data sent asynchronously to another region; the design names that trade-off." },
      ],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        "Whose money? This page assumes an authorised UK bank: customer balances are deposits on our balance sheet, protected by FSCS up to the limit, and the ledger must produce the Single Customer View file (each depositor's eligible total) on demand. If we were an e-money institution instead, the same wallets would be safeguarded funds under CASS 15, reconciled every business day against the safeguarding accounts, and credit would be funded from the firm's own money, not customers'.",
        'Which products? This page takes bank payments, payroll, debit and credit card authorisations and settlements, and accounts in several currencies, all in one ledger.',
        'What does "strict consistency" mean here? I take it as: no customer starts a debit past their limit, no posting at all takes an account past its hard floor, no money is created or lost in any currency, and a read after a write sees it.',
        'How many writes, and how skewed? Average and peak, and whether some accounts appear in most transactions.',
        'Who owns credit card statements, interest and how repayments are allocated? This page says a separate billing service; the ledger only posts what it is sent.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Record transactions of two or more entries that sum to zero in each currency, as signed integer minor units, each under a header with a caller-made id, a description and a value date. No account holds two currencies.',
        'Hold funds for money in flight, then capture the hold into entries, void it, or let it expire; refuse any hold or payment a customer starts past their credit limit, or on an account that takes no new spend.',
        'Accept postings the bank cannot refuse (interest, fees, settlements larger than a hold, reversals) as far as a hard floor, and book anything past it to that customer\'s own receivable.',
        'Never apply the same request twice, whatever the client retries, and give a retried decline the same decline.',
        'Return posted, held and available (posted - held + credit limit) for every account, statements of entries, and balances per business date.',
        'Correct mistakes only by adding entries; publish every change for other services.',
      ],
    },
    {
      heading: 'How well',
      points: [
        'Assume 1,000 payments a second on average, 10,000 at peak: a deliberate stress case, 86 payments per business per day for a million businesses. The whole UK made about 5.5 billion Faster Payments in 2025 (Pay.UK\'s annual report), about 15 million a day. A reasoned baseline is 10 to 20 payments per business per day, roughly 100 to 250 a second, on which phase 1\'s one cluster lasts a long time; the stress figures size the phases.',
        'A bank payment is 2 write transactions (place the hold, capture it) and 3 entries: 2,000 and 20,000 write transactions a second at the stress load. "TPS" on this page means write transactions a second.',
        'Target: a hold or capture in under 50 ms at the 99th percentile inside the ledger; no lock waited on for more than 50 ms.',
        'No acknowledged hold or transaction lost (recovery point zero, for one failure at a time); a cluster back within a minute.',
        'Balance reads always current; statements may lag by a second.',
        'Reconciled internally every few minutes and against the bank at every business day\'s cut-off.',
        'Simplified on this page: one bank, sterling rails plus one card network, illustrative FX rates and fees, chargebacks and disputes stated but not built, and no statement or interest logic (that is billing).',
      ],
    },
  ],

  numbers: [
    { what: 'Payments', assumption: 'stress case: 1,000 payments a second on average, ten times at peak (payroll, month end, batch files); baseline 100 to 250 a second', result: '86 million a day at the stress load; build for 10,000 a second' },
    { what: 'Write transactions', assumption: 'two per bank payment: place the hold, then capture (or void) it', result: '2,000 a second on average, 20,000 at peak' },
    { what: 'Ledger transactions', assumption: 'one per settled payment (the capture), each with one header row; a void posts none', result: '1,000 a second on average, 10,000 at peak; 86 million headers a day' },
    { what: 'Entries', assumption: 'three per bank payment: wallet, scheme clearing, fee. A card payment abroad is also three (wallet, card clearing, FX fee); a conversion between wallets is four', result: '3,000 a second on average, 30,000 at peak; about 260 million a day' },
    { what: 'Hold writes', assumption: 'two per payment: the insert and the one status change; ended holds deleted by the archive job after 90 days', result: '2,000 a second on average, 20,000 at peak; about 86 million hold rows a day in, and about as many deleted' },
    { what: 'Storage', assumption: 'about 250 bytes an entry, 100 a header and 150 a hold, with indexes (estimates)', result: 'about 65 GB of entries, 8.6 GB of headers and 13 GB of holds a day: about 87 GB' },
    { what: 'Hot data', assumption: '13 months of entries, 90 days of ended holds, headers kept for good', result: 'about 26 TB of entries and 1.2 TB of holds, plus headers growing 3.1 TB a year: about 30 TB, 8 TB a cluster, in the first year' },
    { what: 'Clusters', assumption: "the owner's estimate of 5,000 to 8,000 write transactions a second on one tuned primary; take the low end", result: 'one in phase 1 (the stress average fits, the baseline easily); 20,000 ÷ 5,000 = 4 at the stress peak' },
    { what: 'One hot row', assumption: 'locked by a trigger until a synchronously replicated commit, assume 1 to 2 ms', result: 'estimate: 500 to 1,000 writes a second' },
    { what: 'System accounts', assumption: 'one cluster at peak, 10,000 ÷ 4 = 2,500 payments a second, all on one rail at worst, 16 rows each', result: 'about 156 writes a second on each row (unsplit: 2,500)' },
    { what: 'Wallet row', assumption: 'hold placed (held up), hold ended (held down), one entry (posted down)', result: '3 writes per bank payment on the customer\'s row' },
    { what: 'Trigger cost', assumption: 'one UPDATE per hold change and per entry: 2 + 3 per bank payment; one balance check per transaction at commit', result: '5,000 a second on average, 50,000 at peak; 12,500 a cluster' },
    { what: 'Idempotency keys', assumption: 'two per payment (the hold and the capture), kept 72 hours, about 200 bytes each with client id and request hash', result: '2 × 86 million × 3 days × 200 bytes = about 100 GB across all clusters' },
    { what: 'accounts table', assumption: '1.3 million customer rows (wallets per currency, cards), a few hundred system rows, about 130 bytes a row, fillfactor 80, two indexes', result: 'under 300 MB: always in memory' },
    { what: 'Events', assumption: 'hold placed, hold ended, transaction posted: three per bank payment, about 1 KB each', result: '3,000 a second on average (3 MB a second), 30,000 at peak (30 MB a second)' },
  ],

  framings: [
    {
      name: 'Phase 1: one ledger cluster',
      scale: 'from day one to the cluster\'s limit; the reasoned baseline, 100 to 250 payments a second, fits for a long time, and so does the stress average of 2,000 write transactions a second',
      shape: "One PostgreSQL primary with two synchronous standbys and read replicas, PgBouncer in transaction mode, ledger_entries partitioned by month, pending_holds trimmed by an archive job, the header table kept for good, system accounts split 16 ways by shard_id, role-level timeouts, queues and the outbox. The same tables and functions as every later phase.",
    },
    {
      name: 'Phase 2: the same design, more clusters (this diagram)',
      scale: "up to the owner's estimate of about 5,000 to 8,000 write transactions a second a cluster (an estimate); 20,000 at this page's stress peak",
      shape: 'The phase 1 design pushed to its limit, then businesses split across ledger clusters, 4 at this peak, each with its own set of system accounts. A routing directory picks the cluster. A payment within one cluster is one local transaction. A payment between clusters is two local transactions joined by INTERCLUSTER_OUT and INTERCLUSTER_IN, the second driven by the outbox under the same transaction id; the pair must net to zero, and reconciliation watches anything in flight by age.',
    },
    {
      name: 'Phase 3: TigerBeetle for the hot path',
      scale: 'extreme hot-account contention, or far beyond 20,000 write transactions a second',
      shape: "The hot debit and credit path moves to TigerBeetle: accounts and transfers, with pending (two-phase) transfers in place of pending_holds. A transfer has one debit and one credit, so a three-entry capture becomes linked transfers and each currency is its own ledger; there is no credit_limit column, so limits are balance flags and funding transfers; the triggers, guard and CHECK disappear, so those rules move into the Ledger API (reviewers' knowledge, unverified). PostgreSQL stays for user metadata, KYC, billing statements, search and reporting, with no shared transaction between them.",
    },
    {
      name: 'Ledger of record for finance',
      scale: 'billions of events a day from many systems (Stripe reports five billion)',
      shape: 'Not on the payment path at all. Producers emit events; the ledger is an immutable log replayed into balances, and correctness is shown by clearing accounts returning to zero, not by locks.',
    },
  ],

  decisions: [
    { choice: 'Money in flight', a: 'A hold row in pending_holds, captured into entries or voided; ledger_entries holds settled money only.', b: "Pending entries through a clearing account (an earlier design), or a status column on entries.", call: 'Holds in their own table. Three entries and one journal transaction per payment instead of five and two, a rejection leaves no line, and card holds that settle for a different amount or expire need nothing extra. The price is a second table whose status changes once, enforced by a trigger, and held money that is in no journal account, so reconciliation checks holds separately. A status column was rejected because it makes the journal mutable.' },
    { choice: 'Balances', a: 'Two caches: posted_balance (entries) and held_balance (ACTIVE holds); available = posted - held + credit_limit.', b: 'One balance that already has pending money taken out.', call: 'Two. Customers and card rules need both figures, and each cache equals one simple sum that reconciliation can check. The price is two triggers and three writes on the wallet row per payment.' },
    { choice: 'Who keeps the balances', a: 'Triggers on ledger_entries and pending_holds, with a guard against direct edits and non-zero openings.', b: 'The application runs the UPDATE beside each insert.', call: 'Triggers. The database refuses a wrong balance whatever application code writes. The price is logic in the database, and a break-glass step to rebuild a cache; the table owner or a superuser can still disable triggers, so DDL is reviewed.' },
    { choice: 'Soft limit and hard floor', a: 'credit_limit tested in the customer\'s own debits (hold or payment, under the account lock); hard_limit enforced by the CHECK, at or below it.', b: "The owner's single CHECK at -credit_limit.", call: 'Two limits. Interest, fees, settlements larger than a hold, stand-in approvals and reversals must post even at the limit; the single CHECK refused them (a card at its limit could not be charged 250p of interest). The cost, said plainly: the database backstop is now the hard floor, so a code path that skipped the soft test could overspend by up to hard_limit - credit_limit, 50000p on the example card.' },
    { choice: 'Past the hard floor', a: "That customer's own receivable account (RECEIVABLE, owner_account_id the customer account, allow_negative TRUE, one per owner, opened on first use); incoming credits clear it first.", b: 'A pooled receivable such as one CUSTOMER_RECEIVABLE_GBP for everyone.', call: 'Per customer. The debt is visible on the customer it belongs to, collections and statements can read it, and a repayment can be split to clear it first. A pooled account mixes every customer\'s shortfall into one figure that nobody can repay against, and makes one more hot row. The price: an account row per customer who ever goes past the floor, rare by design.' },
    { choice: 'Blocking an account', a: "status: OPEN, NO_NEW_SPEND, CLOSED. A hold needs OPEN; entries are refused only on CLOSED; a CLOSED account must be at zero.", b: "The owner's is_active flag, which refused holds and entries alike.", call: 'status. Blocking a card must stop new spend, but repayments, refunds, interest and settlements already approved must still post; is_active FALSE refused them all (checked on the new schema: a blocked card takes a repayment and refuses a hold).' },
    { choice: 'A header table', a: 'ledger_transactions: one row per transaction, primary key made by the caller from the request, UNIQUE (kind, external_ref), never partitioned, never deleted.', b: 'No header: a transaction id generated by the Ledger API and carried only on entries.', call: 'The header. It is the lasting duplicate guard (a replayed id or a re-sent scheme reference is refused, both checked), and it gives statements a description, corrections a reverses link and postings a value date. The balance check runs once per transaction on it. The price: about 8.6 GB a day at the stress load, 3.1 TB a year that never shrinks. Partitioning it by month was rejected: the guard would then cover only the months kept.' },
    { choice: 'Holds and growth', a: 'pending_holds unpartitioned, PRIMARY KEY (hold_id); an archive job moves ended holds older than 90 days to a month-partitioned history table.', b: 'pending_holds partitioned by month, old months detached and dropped.', call: 'Unpartitioned. A partitioned table needs created_at in its key, so the same hold id inserts twice, and ON CONFLICT (hold_id) errors (42P10). The cost: about 86 million deletes a day for vacuum to clean up.' },
    { choice: 'Lock order', a: 'Every path locks the account rows first, in account_id order, then touches holds.', b: 'Lock in whatever order each path reaches its rows.', call: 'Account first. Void and expiry used to update the hold first and reach the account through the trigger, while capture locked the account first, and a reviewer got a deadlock. With the rule, 200 rounds of capture racing void and 3 seconds of expiry racing repayments gave no deadlock and exact balances. The expiry job works one account per transaction to keep to it.' },
    { choice: 'Bank or e-money firm', a: 'An authorised bank: balances are deposits, FSCS protected, with a Single Customer View on demand.', b: 'An e-money institution: balances are safeguarded funds under CASS 15.', call: 'A bank, stated up front, because it changes words and checks, not the schema. As an e-money firm, reconciliation would add a daily safeguarding check against the safeguarding accounts, and credit cards would be funded from the firm\'s own money.' },
    { choice: 'Credit card interest', a: 'Billing accrues daily between INTEREST_RECEIVABLE_GBP and INTEREST_INCOME_GBP, and charges the card once on statement day; paid in full within the grace period, the accrual is reversed.', b: "The owner's nightly debit of the card itself.", call: 'Daily accrual between system accounts. A nightly debit of the card contradicts the grace period, compounds daily, eats available credit, and failed at the limit under the single CHECK. Accrual keeps the income right each day and the card statement clean.' },
    { choice: 'Repayment allocation', a: 'In the billing service: balance segments by rate (purchases, cash, promotional); for regulated credit, CONC 6.7.4R sends repayments to the highest-interest balance first.', b: 'Sub-accounts per card for each segment, so the ledger itself can say which is which.', call: 'Billing. One card account keeps rows and locks at one per card. The price: the ledger cannot tell interest from principal, so billing keeps that breakdown and reconciles its total to the card\'s posted balance. A limited company\'s card is mostly outside the Consumer Credit Act; sole traders and small partnerships are inside.' },
    { choice: 'allow_negative on system accounts', a: 'TRUE for every split system row, the nostros and receivables, as the owner says for system rows.', b: 'FALSE, with limits per row.', call: 'TRUE. A split row is credited and debited by different payments and can dip below zero while the total is fine, and an asset such as a nostro is negative by the sign rule. The consequence: the CHECK protects nothing on those rows, so their limits are reconciliation\'s job.' },
    { choice: 'Currencies', a: 'One account per currency; a transaction sums to zero per currency; conversions between a customer\'s wallets go through a pool account per currency.', b: 'A single cross-currency entry carrying a rate.', call: 'Per currency. Every sum stays exact in its own unit. A sterling card\'s foreign purchase never reaches the pools: the network bills in pounds. The pools drift and treasury rebalances with real trades; the rate lives on the payment record and the event.' },
    { choice: 'Hot accounts', a: '16 rows by shard_id, swept at end of day.', b: 'Continuous sweeps every minute, or an asynchronous balance for credit-only accounts.', call: 'End-of-day sweeps of split rows. The sum is always exact, so sweeping is tidiness; once a day is one lock per row instead of 1,440.' },
    { choice: 'Timeouts', a: "ALTER ROLE ledger_writer SET lock_timeout = '50ms' and statement_timeout = '250ms', plus a client deadline; batch roles get longer values.", b: "SET LOCAL inside the ledger function, or no timeouts.", call: 'On the role. SET LOCAL statement_timeout inside the function does not time that call, because the timer starts when the client\'s statement arrives; the role setting does (checked: cancelled at 251 ms). A timeout rolls back and returns TIMEOUT; the caller retries with the same key. Only the client deadline bounds a COMMIT waiting for a standby.' },
    { choice: 'Concurrency control', a: 'Pessimistic: lock the account rows in account_id order with FOR NO KEY UPDATE, then one conditional statement, in one database call.', b: 'Optimistic: version check and retry on conflict.', call: 'Pessimistic. Optimistic retries collapse exactly when an account is busy, and the lock lasts only 1 to 2 ms because it never waits on the network.' },
    { choice: 'Partitioning the journal', a: 'ledger_entries by month on created_at.', b: 'Unpartitioned, keys as written.', call: 'Partition it, and say what it costs: its unique key must include created_at, which differs on every insert, so UNIQUE (transaction_id, account_id, created_at) guards nothing. The guards are the header\'s primary key and idempotency_keys.' },
    { choice: 'Events', a: 'Outbox rows in the same transaction, one per customer account touched, read by CDC; consumers dedupe on the outbox seq.', b: 'Two-phase commit, or publish after commit.', call: 'Outbox. 2PC holds locks across the network; a dual write loses or invents events on every crash.' },
    { choice: 'Database', a: 'PostgreSQL in phases 1 and 2, TigerBeetle for the hot path in phase 3.', b: 'TigerBeetle from day one.', call: 'PostgreSQL first: the team knows it and one database gives one transaction. Moving later shifts accounts, transfers and holds to TigerBeetle and leaves metadata, KYC, billing and reporting in PostgreSQL. What you give up: no transaction spans both, the triggers and CHECK become Ledger API rules, and multi-leg postings become linked transfers.' },
  ],

  drills: [
    { name: "A cluster's primary dies", what: 'The failover tool fences it, then promotes a synchronous standby: it has every acknowledged commit. Writes to that cluster pause; we target under a minute. Clients retry with the same keys; card authorisations decline fast or use stand-in rules. The CDC relay resumes from its failover slot.' },
    { name: 'Both synchronous standbys are lost', what: 'Commits on that cluster block, each holding its row locks, so every touched row queues. Do not cancel the waiting backends: a cancelled commit reports success with a warning that it may not be replicated. Fence the primary, stop writes there and say so, rather than drop to asynchronous replication. Other clusters carry on.' },
    { name: 'The scheme times out after we sent', what: 'The payment is unknown, not failed. The hold stays ACTIVE; ask the scheme for its status with the same payment id, then capture or void.' },
    { name: 'A hold is never captured', what: 'The merchant never settles, or a payment worker died. The expiry job, one account at a time with the account locked first, marks it EXPIRED once expires_at passes, and held_balance falls. An alert on the oldest overdue ACTIVE hold catches a stopped job.' },
    { name: 'A capture arrives after the hold expired', what: 'An EXPIRED hold has left ACTIVE, so the capture updates 0 rows and posts nothing (HOLD_NOT_ACTIVE). The settlement is still owed to the network, so it posts as if there had been no hold: a force-post, which the bank must accept, as far as the hard floor and the rest to the customer\'s receivable.' },
    { name: 'A force-post exceeds the money, or the credit limit', what: 'It skips the soft limit and posts down to the hard floor, ending any live hold in the same transaction. A plain debit past the floor is refused (23514), so take what is left down to -hard_limit and book the rest to that customer\'s receivable in the same balanced transaction. Collections chases it; the next repayment clears it first.' },
    { name: 'Interest on a card at its limit', what: 'The card is at -500000 with credit_limit 500000. Statement interest of 250p and a 1200p late fee still post: they are debits the bank cannot refuse, so only the hard floor at -550000 applies (checked). A new purchase hold places nothing, because the soft test fails.' },
    { name: 'A blocked card gets a repayment and a late settlement', what: 'Status NO_NEW_SPEND: a new hold is refused, but the repayment posts (clearing any receivable first) and a settlement already approved posts too, both checked. Only CLOSED refuses entries, and closing needs a zero balance.' },
    { name: 'A clearing file is re-sent after 10 days', what: "The idempotency keys are long gone (72 hours). The settlement's transaction id is made from the rail and the network's reference, so the header's primary key refuses it, and UNIQUE (kind, external_ref) refuses it even under a new id. Headers are never deleted, so this holds at any age." },
    { name: 'A payment between two clusters crashes between its halves', what: "INTERCLUSTER_OUT committed on the payer's cluster with its outbox row; the payee's half did not. The relay delivers the outbox row again (at least once), and the payee's cluster posts INTERCLUSTER_IN under the same transaction id, which its header refuses if it already posted. Reconciliation checks the pair nets to zero and alerts on anything in flight past an age." },
    { name: 'The same hold is captured twice', what: 'The second capture finds the hold CAPTURED, updates 0 rows and inserts 0 entries. Its key, if repeated, returns the first result; a capture and a void racing end the hold once, whichever commits first, with no deadlock because both lock the account first.' },
    { name: 'A declined payment is retried', what: 'The decline was saved with its key and committed, so the retry gets the same INSUFFICIENT_FUNDS (checked); by design that holds even if money has arrived since. The user starts a new payment, with a new key, to try again.' },
    { name: 'Lock timeouts storm on one wallet', what: "A business fires hundreds of payments at once at one wallet row. Each waits at most 50 ms for the lock and then fails with TIMEOUT; callers retry with the same key and back off. Move bulk work (payroll, payouts) onto the queue so it reaches the wallet one at a time; if it is a system row, raise its split from 16 to 32." },
    { name: 'The FX pools drift', what: 'Customers convert pounds to dollars, so FX_POOL_GBP grows and FX_POOL_USD goes negative. Nothing in the database stops it (allow_negative TRUE). Reconciliation reports the position per currency daily; treasury buys dollars and books it as one balanced transaction per currency.' },
    { name: 'A replay arrives in a new month', what: 'On the partitioned journal the unique key includes created_at, which is new on every insert, so it never fires. The header refuses the replayed transaction id, whatever the month; within 72 hours idempotency_keys answers first with the saved reply.' },
    { name: 'A cache disagrees with the journal', what: 'The check finds posted_balance not equal to its snapshot plus later entries, or held_balance not equal to its ACTIVE holds. Suspect a trigger bypassed (session_replication_role = replica). Freeze the account (NO_NEW_SPEND) and rebuild both columns in a reviewed break-glass change, knowing that setting also switches off the append-only triggers and foreign key checks for that transaction; audit who ran it.' },
    { name: 'Interest is accrued twice', what: 'Billing reruns a day. Its transaction id and external_ref are made from the card and the date, so the header refuses the second one, and within 72 hours the key returns the first result.' },
    { name: 'A credit limit is cut below what is used', what: 'Allowed: the CHECK is at hard_limit, not credit_limit. New holds then place nothing until the card is back under the new limit (checked). hard_limit cannot go below credit_limit (refused, checked); to stop spending at once, set NO_NEW_SPEND.' },
    { name: 'Payroll for 5,000 staff who bank here', what: 'One transaction of 5,001 entries, with the balance check once at commit: about 0.7 s on the WASM build of PostgreSQL, over the writer role\'s 250 ms, so it runs as payroll_writer with a longer statement_timeout (5 s, say). Chunks of a few hundred lines through PAYROLL_CLEARING_GBP, each its own balanced transaction, remain the fallback for larger runs.' },
    { name: 'Kafka is down', what: "The ledger is unaffected. Outbox rows wait in the log; the relay catches up. Watch the primary's disk, because the replication slot holds log until it is read." },
    { name: 'FPS clearing is £5 off after settlement', what: 'NOSTRO_BOE_GBP equals the statement, but FPS_CLEARING_GBP is -500 instead of zero. A break is raised with owner, amount and evidence. When the cause is found, a correcting transaction is posted and approved by a second person.' },
    { name: 'A whole region is lost', what: 'Synchronous standbys are in other zones of the same region, so a region loss risks the last seconds sent asynchronously to the other region. Name this trade-off out loud.' },
  ],

  interview: [
    'Open with the model before any boxes: accounts in one currency each, transactions of entries that sum to zero per currency under a header, entries never changed, holds for money in flight. Signed integers in minor units. Say the assumption: we are a bank, balances are deposits. Then the invariants: every currency balances, a customer cannot start a debit past their limit, and nothing goes past the hard floor.',
    'Do the sums early, and say the load is a stress case. 1,000 payments a second average and 10,000 at peak; a bank payment is two write transactions and three entries, so 20,000 write transactions a second at peak, about four clusters against the owner\'s estimate. A reasoned baseline, 100 to 250 a second, fits one. The real limit is one hot row, 500 to 1,000 writes a second.',
    'Show the tables: the header with a caller-made id, ledger_entries append-only, pending_holds with a status that changes once, accounts with posted and held kept by triggers, a guard, a soft credit_limit and a hard floor in the CHECK.',
    'Draw the write path: hold (key, lock the account, conditional insert, outbox; a decline is saved), send, capture as header plus one statement, or void. Say what a void posts: nothing.',
    'Spend your depth on concurrency and hot accounts: account rows first in id order with FOR NO KEY UPDATE, then holds; 50 ms lock_timeout set on the role; system accounts by rail and currency split 16 ways, swept at end of day.',
    'Cards and FX: authorisation is a hold of the network\'s billing amount plus a buffer, settlement is three entries in pounds with the FX fee, force-posts go to the hard floor and then the customer\'s receivable. Conversions between wallets use the FX pools. Credit: same schema, interest accrued between system accounts and charged on statement day.',
    'Be ready for the pushes: partitioning makes the journal\'s unique key useless, so the header guards; the soft limit can be bypassed by up to hard_limit - credit_limit; a blocked card still takes repayments; SET LOCAL statement_timeout does nothing inside a function.',
    'Finish with proof and the path ahead: caches equal journal and holds, nostros equal statements, clearing accounts drain to zero, then the phases to TigerBeetle and what you give up: no shared transaction.',
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
    { label: 'TigerBeetle: Performance, OLTP, Safety, Two-phase transfers, Data modelling, Currency exchange', href: 'https://docs.tigerbeetle.com/concepts/performance/', note: 'Batches of up to 8,189 transfers per request, single core, consensus replication paid once per batch.' },
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
    { label: 'PostgreSQL docs: Client settings (session_replication_role)', href: 'https://www.postgresql.org/docs/current/runtime-config-client.html', note: 'Set to replica, ordinary triggers do not fire; only superusers and users granted the right may change it. The same page documents lock_timeout and statement_timeout. That SET LOCAL statement_timeout inside a function does not time the call is from two reviewers (one citing Tom Lane on pgsql-general); the role setting was run here.' },
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
    { label: 'RSM: FCA safeguarding rules, preparing for 7 May 2026', href: 'https://www.rsmuk.com/insights/advisory/fca-safeguarding-rules-how-to-prepare-for-7-may-2026', note: 'CASS 15, for payment and e-money firms: safeguarded funds reconciled every business day, monthly returns, annual audit. Relevant here only to the e-money alternative; this page assumes a bank. An accountancy summary; the FCA page was not reachable.' },
    { label: 'Regulation Tomorrow (Norton Rose Fulbright): PS25/12 safeguarding changes', href: 'https://www.regulationtomorrow.com/2025/08/ps25-12-changes-to-the-safeguarding-regime-for-payments-and-e-money-firms/', note: 'In force 7 May 2026; reconciliations each business day; monthly return; annual audit. For the e-money alternative only.' },
    { label: 'TigerBeetle: Safety', href: 'https://docs.tigerbeetle.com/concepts/safety/', note: 'Viewstamped Replication; all data immutable, checksummed and hash-chained.' },
    { label: 'TigerBeetle: Two-phase transfers', href: 'https://docs.tigerbeetle.com/coding/two-phase-transfers/', note: 'Pending transfers are posted, in full or in part, voided, or time out.' },
    { label: 'TigerBeetle: system architecture and data modelling', note: 'Read by the coordinator today: TigerBeetle sits beside a general-purpose database, with no shared transaction; the application orders its writes; transfer ids act as idempotency keys; change data capture to AMQP. The exact page for each point was not recorded.' },
    { label: 'PgBouncer: pooling modes', note: 'Transaction pooling returns the server connection at the end of each transaction, so session state must not be relied on; role settings apply at login. From memory; not read for this page.' },
    { label: 'Expert review of this page (three fintech reviewers, 12 November 2026)', note: 'Source of the two-limit model, status, the header table, account-first locking, role-level timeouts, nostros, card FX and interest accrual. Their tests ran on PostgreSQL 18 (PGlite) and PostgreSQL 16; their own sources are listed below where they gave them.' },
    { label: 'Osborne Clarke: note on the 2021 amendment to CONC 6.7.4R', note: 'Repayments on regulated credit go to the highest-interest balance first. Read by a reviewer, not here; no link recorded.' },
    { label: 'Pay.UK annual report (2025 figures)', note: 'About 5.5 billion Faster Payments in 2025, as quoted in the review brief; not read here.' },
    { label: 'Gunnar Morling: failover slots in PostgreSQL 17', note: 'Logical replication slots that survive failover, and synchronized_standby_slots. Read by a reviewer, not here; no link recorded. The settings were not run on this page.' },
  ],

  glossary: [
    { term: 'Double-entry', also: ['double-entry bookkeeping'], where: 'ledger', text: 'Every movement of money is recorded at least twice: where it came from and where it went. With signed amounts, the entries of one transaction sum to zero in each currency, so money is never created or lost by a write.' },
    { term: 'Entry', also: ['posting', 'ledger entry', 'leg', 'ledger_entries'], where: 'db', see: { id: 'append-log', label: 'Append-only log' }, text: 'One debit or credit to one account: a row in ledger_entries with transaction_id, account_id, a signed amount in minor units (plus a credit, minus a debit), currency and created_at. Settled money only. Entries are only ever inserted.' },
    { term: 'Transaction', also: ['journal entry', 'transfer'], where: 'ledger', text: 'A group of two or more entries that commit together and sum to zero in each currency, under one header row. A bank payment is one (the capture, three entries); a card payment abroad is also three, all in pounds; a conversion between wallets is four in two currencies.' },
    { term: 'Header', also: ['ledger_transactions', 'transaction header'], where: 'db', text: 'One row per transaction in ledger_transactions: a caller-made id (UUIDv5 of the request), kind, external_ref, description, value_date, reverses. Its primary key and UNIQUE (kind, external_ref) are the lasting duplicate guard. Never partitioned, never deleted.' },
    { term: 'Value date', also: ['value_date', 'business date', 'cut-off', 'end of day'], where: 'sweeper', text: 'The business date a transaction counts for, on its header. A cut-off calendar in Europe/London ends each business date; then a job writes account_balances_daily. End of day is a date, not a stop.' },
    { term: 'Hold', also: ['pending_holds', 'authorisation hold', 'reservation', 'pending'], where: 'fps', text: 'Money set aside but not settled: a row in pending_holds, ACTIVE until CAPTURED, VOIDED or EXPIRED. It raises the account\'s held_balance, so the money cannot be spent twice, and posts nothing to the journal.' },
    { term: 'Capture', also: ['settle', 'post a hold'], where: 'fps', text: 'Ending a hold as CAPTURED and posting its entries in one statement: both happen or neither. The posted amount may differ from the hold, as when a card settles at a better rate.' },
    { term: 'Void', where: 'fps', text: 'Ending a hold as VOIDED: held_balance falls back and nothing is posted. A rejected bank payment leaves no line on the statement.' },
    { term: 'Hold expiry', also: ['EXPIRED', 'expires_at'], where: 'sweeper', text: 'A job that marks ACTIVE holds past their expires_at as EXPIRED, through a partial index on ACTIVE rows, giving the money back. An expired hold cannot be captured.' },
    { term: 'Force-post', also: ['forced settlement'], where: 'fps', text: 'A card settlement that arrives with no live hold (none, or one already EXPIRED), or for more than was held. The bank must accept it: it skips the soft limit, ends any live hold in the same transaction, posts down to the hard floor, and books any rest to that customer\'s receivable.' },
    { term: 'Receivable', also: ['RECEIVABLE', 'owner_account_id'], where: 'db', text: 'A customer\'s own account for what they owe past the hard floor: account_type RECEIVABLE, owner_account_id the customer account, allow_negative TRUE, at most one per owner, opened on first use. Incoming credits clear it first. Never pooled.' },
    { term: 'Posted, held and available', also: ['posted_balance', 'held_balance', 'available balance', 'ledger balance'], where: 'db', text: 'posted_balance is the sum of the account\'s entries; held_balance is the sum of its ACTIVE holds. Available is posted - held + credit_limit: what can still be spent or borrowed.' },
    { term: 'Credit limit', also: ['credit_limit', 'soft limit', 'arranged overdraft'], where: 'db', text: 'The soft limit: how far below zero a customer may take their own account, tested in the hold\'s or payment\'s conditional insert. 0 for a debit wallet, the agreed amount for an overdraft or a credit card. Set by the credit service under column grants.' },
    { term: 'Hard limit', also: ['hard_limit', 'hard floor'], where: 'db', text: 'The floor the database enforces: CHECK (allow_negative OR posted - held >= -hard_limit), with hard_limit >= credit_limit. Postings the bank must accept (interest, fees, settlements, reversals) may go past credit_limit as far as this. Example card: 500000 and 550000.' },
    { term: 'Account status', also: ['status', 'NO_NEW_SPEND', 'CLOSED', 'is_active'], where: 'db', text: 'OPEN, NO_NEW_SPEND or CLOSED, in place of the owner\'s is_active. A hold needs OPEN; only CLOSED refuses entries, and a CLOSED account must be at zero. So a blocked card still takes repayments.' },
    { term: 'Available credit', where: 'db', text: 'For a credit card, posted - held + credit_limit. The bakery\'s card with limit 500000 and posted -34900 has 465100 available.' },
    { term: 'Statement (credit card)', also: ['statement cut-off', 'billing cycle'], where: 'consumers', text: 'The monthly summary billing produces for a card: what was spent, what is owed and the minimum to pay by a date. The ledger knows nothing of cut-offs; billing works them out from entries.' },
    { term: 'Grace period', where: 'consumers', text: 'The time after a statement in which paying in full avoids interest. Billing\'s rule, not the ledger\'s.' },
    { term: 'Allocation waterfall', also: ['payment allocation', 'CONC 6.7.4R'], where: 'consumers', text: 'The order a repayment pays off a card\'s balance segments. For regulated credit, CONC 6.7.4R sends it to the highest-interest balance first (a reviewer\'s reading of Osborne Clarke\'s note on the 2021 amendment). Kept by billing; in the ledger a repayment is one credit to the card, after any receivable.' },
    { term: 'Accrued interest', also: ['INTEREST_RECEIVABLE_GBP', 'accrual'], where: 'consumers', text: 'Interest built up day by day on what a card owes. Billing posts it daily between system accounts (INTEREST_RECEIVABLE_GBP -32, INTEREST_INCOME_GBP +32) and charges the card once on statement day; paid in full within the grace period, the accrual is reversed.' },
    { term: 'Normal balance', also: ['debit normal', 'credit normal'], where: 'ledger', text: 'Which direction increases an account. A customer\'s wallet is money the bank owes, credit normal. This design stores one signed amount (plus a credit) and leaves the normal-balance view to reports.' },
    { term: 'Minor units', also: ['pence', 'cents', 'integer amounts'], where: 'ledger', text: 'Amounts stored as whole numbers of the smallest unit, such as pence or cents, with the currency beside them. Never floating point.' },
    { term: 'Logical account', also: ['logical_account', 'chart of accounts', 'logical_accounts', 'general ledger'], where: 'ledger', text: 'A chart-of-accounts name, such as FPS_CLEARING_GBP, stored on each of its rows. A logical_accounts registry holds its class, currency and general ledger code, and a daily summary feeds the general ledger. NULL for customer wallets and cards.' },
    { term: 'shard_id', also: ['split system account', 'sub-account', 'sharded counter'], where: 'sweeper', see: { id: 'hash-table', label: 'Hash table' }, text: 'The row number, 0 to 15, of a logical system account split 16 ways. Writes pick hash(transaction_id) % 16. Not to be confused with a ledger cluster.' },
    { term: 'Ledger cluster', also: ['cluster', 'shard by tenant', 'INTERCLUSTER_OUT', 'INTERCLUSTER_IN'], where: 'ledger', see: { id: 'partitioning', label: 'Partitioning' }, text: 'One PostgreSQL primary with its standbys and replicas, holding a set of businesses and its own system accounts. One in phase 1, 4 at this page\'s stress peak in phase 2. A payment between clusters is two local transactions joined by INTERCLUSTER_OUT and INTERCLUSTER_IN.' },
    { term: 'System account', also: ['house account', 'clearing account', 'FX pool', 'revenue account'], where: 'sweeper', text: 'The bank\'s own accounts, named by rail and currency: FPS_CLEARING_GBP, MASTERCARD_DEBIT_CLEARING_GBP, MASTERCARD_CREDIT_CLEARING_GBP, NOSTRO_BOE_GBP, FX_POOL_GBP, FEE_REVENUE_GBP, INTEREST_INCOME_GBP and so on, busy ones split by shard_id, all with allow_negative TRUE. The owner\'s STRIPE_CLEARING_GBP would be the clearing account for an acquirer or processor we pay out through.' },
    { term: 'Nostro', also: ['NOSTRO', 'NOSTRO_BOE_GBP', 'settlement account'], where: 'recon', text: 'An asset account in the ledger that mirrors a real account the bank holds: NOSTRO_BOE_GBP for its settlement account at the Bank of England, NOSTRO_MASTERCARD_GBP, and one per currency for USD and EUR. With credit positive its balance is negative. At the cut-off it must equal the statement\'s closing balance.' },
    { term: 'FX pool', also: ['FX_POOL', 'currency exchange', 'liquidity account'], where: 'recon', text: 'The bank\'s account per currency for exchanges between a customer\'s wallets. At 1 USD = 0.80 GBP, £8,000.00 goes into FX_POOL_GBP and $10,000.00 out of FX_POOL_USD, so each currency sums to zero on its own. The pools drift until treasury trades. A sterling card\'s foreign purchase does not touch them.' },
    { term: 'Non-sterling transaction fee', also: ['card FX', 'billing amount', 'FX_FEE_REVENUE_GBP'], where: 'fps', text: 'For a purchase in another currency on a sterling card, the network converts and sends the billing amount in pounds; the bank\'s FX income is this fee, here 1% (illustrative). A reviewer\'s reasoning, not checked against scheme rules.' },
    { term: 'Hot account', also: ['hot row', 'hot key'], where: 'sweeper', text: 'An account in most transactions. Every entry\'s trigger locks its row, so it becomes a queue: only one writer can hold it at a time.' },
    { term: 'Sweep', also: ['end-of-day sweep', 'master account'], where: 'sweeper', text: 'An end-of-day balanced transaction moving each of a logical account\'s 16 rows into its master account. Bookkeeping, not safety: the sum is always exact.' },
    { term: 'Idempotency key', also: ['Idempotency-Key', 'request_hash'], where: 'client', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'A unique value the client sends with a request so a retry is recognised. Stored under (client_id, key) with a hash of the request, in the same transaction as the write; a repeat returns the first result, a decline included, and the same key with another body is refused. Kept 72 hours.' },
    { term: 'Trigger', also: ['AFTER INSERT', 'BEFORE UPDATE'], where: 'db', text: 'A function the database runs by itself when a row is written, inside the same transaction. Here they keep entries and headers append-only, move posted and held, let a hold change once, guard the balances, and check once at COMMIT that each transaction balances.' },
    { term: 'Trigger depth', also: ['pg_trigger_depth'], where: 'db', text: 'How many triggers deep the current statement runs. Inside the guard, a direct UPDATE is at depth 1 and a trigger\'s UPDATE at depth 2, so the guard refuses only the first.' },
    { term: 'CHECK constraint', also: ['valid_available_funds', 'valid_held_balance'], where: 'db', text: 'A rule the database checks on every row it writes. valid_available_funds keeps posted - held at or above minus hard_limit unless allow_negative; valid_held_balance keeps held at or above zero; closed_means_empty keeps a CLOSED account at zero. A breach fails with SQLSTATE 23514.' },
    { term: 'allow_negative', where: 'db', text: 'A flag that switches off the floor for an account. FALSE for customer wallets and cards, TRUE for split system accounts, nostros, the FX pools and receivables, whose limits are reconciliation\'s job.' },
    { term: 'Fillfactor', where: 'db', text: 'How full PostgreSQL fills each table page on insert. accounts uses 80, leaving a fifth free for new row versions.' },
    { term: 'HOT update', also: ['heap-only tuple'], where: 'db', text: 'An UPDATE whose new row version fits on the same page and changes no indexed column, so no index is touched. The triggers\' balance updates qualify when the page has room, and only while old versions can be pruned: one long transaction stops that.' },
    { term: 'MVCC snapshot', also: ['MVCC', 'multi-version concurrency control'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'PostgreSQL keeps old versions of rows. A plain SELECT sees the rows as committed when its snapshot was taken, so it never waits for a writer.' },
    { term: 'CTE', also: ['common table expression', 'WITH'], where: 'db', text: 'A named sub-query, WITH name AS (...). The hold\'s CTE returns a row only if the money is there; the capture\'s CTE ends the hold, and the INSERT of entries joins to it.' },
    { term: 'FOR NO KEY UPDATE', also: ['SELECT FOR UPDATE', 'row lock', 'pessimistic locking'], where: 'db', see: { id: 'two-phase-locking', label: 'Two-phase locking' }, text: 'Reads rows and locks them until the transaction ends, so other writers wait. The weakest lock that does the job: it does not block foreign key checks from tables that reference the row.' },
    { term: 'Lock ordering', also: ['deadlock', '40P01'], where: 'db', text: 'Taking locks in the same order everywhere: account rows first, ascending account_id, then holds. Two transfers in opposite directions, or a capture and a void, then cannot each hold the lock the other wants.' },
    { term: 'lock_timeout and statement_timeout', also: ['ALTER ROLE', 'timeout'], where: 'db', text: 'lock_timeout gives up a lock wait after 50 ms; statement_timeout stops a statement after 250 ms. Set on the ledger_writer role, so they apply from login; a SET LOCAL inside the function would not time that call. A timeout rolls back; the caller retries with the same key.' },
    { term: 'PgBouncer transaction pooling', also: ['PgBouncer', 'connection pooling'], where: 'db', text: 'A pooler in front of PostgreSQL that lends a server connection to a client for one transaction at a time. Session settings would leak between clients, so the timeouts are role settings, applied when the server connection logs in.' },
    { term: 'Optimistic concurrency', also: ['version column', 'lock_version'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'Write only if the row\'s version is still the one you read; otherwise fail and retry. Retries pile up on busy rows.' },
    { term: 'Serializable isolation', also: ['SSI', 'serialization failure', '40001'], where: 'db', text: 'The database guarantees the result is as if transactions ran one at a time, aborting any that would break that. The application must retry those aborts.' },
    { term: 'Synchronous replication', also: ['quorum commit', 'synchronous_standby_names'], where: 'replicas', see: { id: 'leader-replication', label: 'Leader replication' }, text: 'The primary waits for a standby to confirm it has the log record before telling the client the commit succeeded. ANY 1 (s1, s2) waits for either of two. A waiting commit keeps its row locks.' },
    { term: 'Fencing', also: ['failover', 'failover slot', 'synchronized_standby_slots'], where: 'replicas', text: 'Cutting the old primary off so it can take no more writes, before a standby is promoted. Paired with a failover slot for the CDC relay and synchronized_standby_slots (PostgreSQL 17 and later), so events never run ahead of what a standby has.' },
    { term: 'RPO and RTO', also: ['recovery point objective', 'recovery time objective'], where: 'replicas', text: 'How much data a failure may lose, and how long recovery may take. A ledger wants a recovery point of zero; this design targets recovery in under a minute per cluster.' },
    { term: 'Consensus', also: ['Raft', 'Viewstamped Replication'], where: 'replicas', see: { id: 'raft', label: 'Raft' }, text: 'A protocol for a group of replicas to agree on the order of writes and on a new leader, so failover needs no operator. TigerBeetle uses Viewstamped Replication.' },
    { term: 'Two-phase commit', also: ['2PC', 'XA'], where: 'relay', see: { id: 'two-phase-commit', label: 'Two-phase commit' }, text: 'A coordinator asks every participant to prepare, then to commit. The owner rules it out: locks are held across the network and a lost coordinator leaves participants waiting.' },
    { term: 'Transactional outbox', also: ['outbox'], where: 'relay', see: { id: 'outbox', label: 'Transactional outbox' }, text: 'Writing the event to publish as a row in the same transaction as the change, and publishing it afterwards from that row. The event exists if and only if the change committed.' },
    { term: 'Change data capture', also: ['CDC', 'logical decoding', 'Debezium'], where: 'relay', text: 'Reading committed changes from the database\'s own log, in commit order, and turning them into events.' },
    { term: 'Shock-absorber queue', also: ['queue', 'SQS', 'backpressure'], where: 'kafka', see: { id: 'queue', label: 'Queue' }, text: 'A queue in front of the ledger for work that can wait (payroll, payouts, interest), fed to it at a steady rate. Card authorisations never queue.' },
    { term: 'Invariant check', also: ['trial balance'], where: 'recon', text: 'A query that must always hold: each currency sums to zero, posted equals the daily snapshot plus later entries, held equals ACTIVE holds. Run incrementally every few minutes, fully weekly on a replica.' },
    { term: 'account_period_totals', also: ['period totals'], where: 'archive', text: 'This design\'s table of each account\'s total per archived month, written before the partition is detached, so a posted balance can still be checked after archive.' },
    { term: 'Break-glass rebuild', also: ['rebuild a balance'], where: 'recon', text: 'The only way to rewrite a cache: a reviewed change that sets session_replication_role = replica inside one transaction, recomputes posted and held from the journal and the holds, and is audited. That setting also switches off the append-only triggers and foreign key checks for the transaction.' },
    { term: 'Reconciliation break', also: ['break', 'reconciliation difference'], where: 'recon', text: 'A difference between the ledger and an outside record, such as the bank statement. It gets an owner, an amount and evidence, and is closed with a correcting entry or a fix outside.' },
    { term: 'Single Customer View', also: ['SCV', 'FSCS', 'deposit protection'], where: 'recon', text: 'The file a UK bank must be able to produce for the deposit guarantee scheme (FSCS), listing each depositor\'s eligible total. Built here from account_balances_daily. Reviewers\' knowledge; no limits or deadlines given.' },
    { term: 'Safeguarding (the e-money alternative)', also: ['CASS 15'], where: 'recon', text: 'Not this design, which assumes a bank. For an e-money or payment firm, keeping customers\' money apart from the firm\'s own; under the FCA\'s CASS 15 rules, in force from 7 May 2026, safeguarded funds are reconciled every business day.' },
    { term: 'Faster Payments', also: ['FPS'], where: 'fps', text: 'The UK\'s 24/7 real-time payment scheme, up to £1 million a payment at scheme level; each bank sets its own limit. Bacs takes three working days; CHAPS is for high-value same-day payments.' },
    { term: 'APP fraud reimbursement', also: ['authorised push payment'], where: 'api', text: 'Since 7 October 2024, payment firms must reimburse consumers, micro-enterprises and charities who fall for authorised push payment scams on Faster Payments and CHAPS, up to £85,000 a claim.' },
    { term: 'Keyset pagination', also: ['cursor pagination'], where: 'replicas', see: { id: 'b-plus-tree', label: 'B+ tree' }, text: 'Fetching the next page as "entries with an entry_id below the last one I saw", through an index on (account_id, entry_id), not an offset.' },
    { term: 'Partition', also: ['partitioning', 'DETACH PARTITION'], where: 'archive', see: { id: 'partitioning', label: 'Partitioning' }, text: 'One piece of a table stored separately, chosen by a column. ledger_entries is partitioned by month on created_at; an old month is detached and archived. Every unique key must then include created_at, so the journal\'s own key guards nothing. pending_holds and the header stay unpartitioned.' },
    { term: 'Two-phase transfer', also: ['pending transfer', 'post pending'], where: 'fps', text: 'TigerBeetle\'s built-in equivalent of a hold: a pending transfer, later posted (in full or in part) or voided, or timed out. The owner\'s phase 3 uses it in place of pending_holds.' },
    { term: 'Hash chain', also: ['tamper evidence'], where: 'db', text: 'Each entry stores a hash of its contents and the previous entry\'s hash, so changing any old entry breaks every hash after it. An option for tamper evidence; TigerBeetle hash-chains its data.' },
  ],
};
