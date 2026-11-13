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
 * peak, a deliberate stress case. Three services with their own databases:
 * the Core Ledger (accounts, pending_holds, transactions, ledger_entries,
 * outbox_events), the Card service (card_authorisations) and Billing
 * (statements and interest), joined by a synchronous PlaceHold and by
 * outboxes and Kafka, never by two-phase commit. One PostgreSQL schema for
 * debit and credit, the owner's tables with the changes an expert review
 * forced: an append-only ledger_entries journal of settled movements under a
 * transactions header whose UNIQUE idempotency_key is the lasting duplicate
 * guard, a pending_holds table (UNIQUE source) for money promised but not
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
  blurb: 'A central multi-currency ledger for debit and credit, with card and billing services around it. Follow a bank payment or a credit card purchase through it, then open any part to see what it does and what you could use instead.',
  tourName: 'Bank payment',
  rest: 'Press Play to follow a payment, or open any box or chip. In the diagram, arrows move and Enter opens.',
  restTouch: 'Press Play to follow one payment, or tap any box or chip to open it.',
  size: { w: 1280, h: 600 },
  frame: { x: 690, y: 96, w: 430, h: 318, label: 'Core Ledger × 4', note: 'Phase 1: one; Phase 2: 4' },

  components: [
    {
      id: 'client',
      name: 'Customer apps',
      short: 'Apps',
      tech: 'app, API',
      x: 64, y: 200, w: 116, h: 64, kind: 'input',
      what: "The mobile app, the web app and the public API that accounting and payroll software call. Each one creates an idempotency key when the user presses Pay or submits a payroll run, and sends the same key on every retry. Card authorisations do not come from here: they come from the card network through the Card service, keyed by the auth_id.",
      why: 'Phones lose signal mid-request. Without a key chosen once, before the first attempt, a retry cannot be told apart from a second payment.',
      built: [
        { name: "Mobile and web apps", what: "The bank's own apps, where a business owner pays suppliers, runs payroll, repays a credit card and checks balances in each currency. They are the client in this design: they send each request and decide when to send it again.", why: "They are the only party that knows two requests are the same attempt, so they make the idempotency key when the payment is drafted, store it with the draft and reuse it on every retry." },
        { name: "Public API", what: "An HTTPS interface that accounting and payroll software call to make payments for a business, instead of a person tapping in the app.", why: "Partners' servers retry too, so the API follows the same rule as the apps: a key per payment in the Idempotency-Key header. A partner whose code makes a new key per retry can still pay twice, which the server cannot detect." },
        { name: "Idempotency key (version 4 UUID)", what: "A random identifier, 122 random bits, made once per payment and sent with every attempt. The Banking API stores it on the payment record, unique per client, with a hash of the request body, so a second request with the same key and body gets the same payment, and the same key with a different body is refused, as Stripe does.", why: "A UUID needs no coordination with the server and will not collide by chance. Stripe accepts keys of up to 255 characters and suggests UUIDs. The key lives as long as the payment record. Behind it, the ledger has its own guards keyed by the payment: UNIQUE (source_type, source_id) on the hold and UNIQUE (idempotency_key) on the header." },
      ],
      numbers: [
        { text: 'A version 4 UUID per payment. Stripe accepts keys of up to 255 characters and suggests UUIDs.', from: "Not a sum. The 255-character limit and the advice to use UUIDs are from Stripe's idempotent requests docs, cited on the page. A version 4 UUID has 122 random bits, so two clients picking the same key by chance is not a practical worry." },
      ],
      fails: 'A client that makes a new key on each retry defeats the whole scheme. Generate the key when the payment is drafted, store it with the draft, and reuse it.',
      alternatives: [
        {
          name: 'Client-chosen idempotency key per payment', chosen: true, good: 'The only party that knows two requests are the same attempt is the one that sent them.', cost: 'Every client must get it right, so the SDKs do it for them.',
          what: 'The app makes a UUID when the payment is drafted, stores it with the draft, and sends it as the Idempotency-Key header on every attempt. The Banking API stores it on the payment record with the request hash and the reply. Every ledger call for that payment is keyed by the payment, so the ledger\'s own unique keys refuse a repeat.',
          pros: ['Only the sender knows two requests are one attempt, so the sender names it.', 'A retry after a lost reply, like k7 on the tour, returns the same payment and moves no money, even when that payment FAILED.', 'The same scheme works for the app, the web app and API partners.'],
          cons: ['Every client must make the key once, before the first attempt, so the SDKs do it for them.', 'A partner whose code makes a new key per retry can still pay twice, and the server cannot tell.', 'One more unique key on the payment table.'],
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
      what: "The edge of the bank for payments. It authenticates the user (strong customer authentication for a payment), checks the payee with Confirmation of Payee, asks fraud and limit services, then runs the payment as a small state machine: place a hold in the ledger, send to the scheme, then capture the hold or void it. The payment record holds the state (PENDING, SETTLED or FAILED); the ledger shows only where the money is and what is held. Card authorisations come from the separate Card service and credit card interest from Billing, each calling the Ledger API the same way: PlaceHold with source_type OUTBOUND_PAYMENT or PAYROLL_BATCH here, CARD_AUTH there. Dual approval and the business's own payment limits live here too. It serves balance and statement reads by calling the ledger.",
      why: "The ledger should know about money, not about Faster Payments, Mastercard, statements or fraud. This is the owner's service boundary: the Banking API owns bank payments and payroll, the Card service owns cards, Billing owns credit statements, and each has its own database. Keeping the orchestration and the payment state here lets the ledger stay a small, strict service with one job, and lets its entries stay append-only: a status that changes cannot live on a row that never changes. The hold's own status is the one exception, and it lives in pending_holds, not in the journal.",
      built: [
        { name: "Strong customer authentication", what: "A legal requirement to confirm the user with two independent proofs when they start an electronic payment, such as the phone and a fingerprint.", why: "Required by the Payment Services Regulations 2017. It runs before the ledger is called, so a failure leaves nothing to undo." },
        { name: "Confirmation of Payee", what: "A UK service that checks the name the user typed against the name on the payee's account, through the payee's bank, and warns on a mismatch.", why: "A payment sent to the wrong or a scammer's account is hard to recover, and the bank may owe up to £85,000 a claim under APP scam reimbursement. Checking first is far cheaper." },
        { name: "Payment workflow (a recorded state machine)", what: "Each payment is a row with a state: PENDING (with the step reached: held, then sent), SETTLED or FAILED. The API records each step before starting the next.", why: "A crash leaves a named state that a recovery worker can finish, repeating calls with the same idempotency key. With this few states, it needs less machinery than a workflow engine such as Temporal, which would add another system to the money path." },
        { name: "Dual approval and payment limits", what: "A business can require a second person to approve a payment or a payroll run over a set amount, and sets its own daily limits. Both are checked here, before the ledger is called.", why: "They are rules about people and permissions, not about money balancing. A payroll run places its hold only once it is approved, with an expiry past the pay date; it is debited on the Bacs processing day, and any returned line posts later as its own transaction linked by reverses." },
        { name: "The payment record, and the keys made from it", what: "Each payment is a row with its id (e1f0c3a2-...3318, public name pay_3fK9), the client's key k7 and request hash, the state, the reference INV 3318 and the value date. PlaceHold uses the payment id as its idempotency key; the capture's header key is fps:out:pay_3fK9, and its transaction id a UUIDv5 of the same.", why: "The same payment always gives the same keys, so the hold's UNIQUE (source_type, source_id) and the header's UNIQUE (idempotency_key) refuse a replay for good: headers are never deleted. A decline is recorded here as FAILED, not in the ledger." },
      ],
      numbers: [
        { text: 'Faster Payments allows up to £1 million a payment; each bank sets its own lower limits.', from: "Not a sum. The scheme limit is from Pay.UK, cited on the page. Each bank sets its own lower limit, so the Banking API checks the bank's limit, not the scheme's." },
        { text: 'APP scam reimbursement covers Faster Payments and CHAPS, up to £85,000 a claim, since 7 October 2024, for consumers, micro-enterprises and charities.', from: "Not a sum. The date, the rails and who is covered are from the PSR page, cited. The words 'per claim' are from the Norton Rose Fulbright summary of PS24/7, also cited, because the PSR page does not say per claim." },
      ],
      fails: 'It crashes between steps. Each step is recorded before the next starts, so a recovery worker resumes the payment from its last state, repeating each ledger call with the same payment id and keys. A hold left ACTIVE by a payment nobody finishes is ended by the expiry job when its expires_at passes.',
      alternatives: [
        {
          name: 'Payment state machine, recorded step by step', chosen: true, good: 'Every payment is in a named state (PENDING, SETTLED, FAILED, with the step reached), so a crash leaves something a worker can finish.', cost: 'More code than a straight-line handler, and the states need tests.',
          what: 'Each payment is a row with a state: PENDING while it is held and sent, then SETTLED or FAILED. The API records each step before starting the next, so a recovery worker can pick up any payment that stopped, repeating calls with the same idempotency key.',
          pros: ['A crash leaves a named state that a worker can finish.', 'Every ledger call is keyed by the payment, so repeating a step is harmless.', 'The states answer what support and audit ask: where is this payment?', 'No extra system on the money path.'],
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
      what: "The UK's real-time payment scheme, open all day every day. The payment leaves the business's account and reaches the payee's bank in seconds. The card networks (their own box) and Bacs have the same shape: someone outside answers later. A card authorisation is a hold; its settlement a day or two later is a capture, sometimes for a different amount or with no hold at all (a force-post). A Bacs payroll file is a balanced transaction to BACS_CLEARING_GBP. CHAPS is the high-value same-day rail. Each scheme settles with the bank later, which moves the bank's own account at the Bank of England (NOSTRO_BOE_GBP in the ledger).",
      why: "The scheme is outside your control. It can accept, reject or go quiet. The ledger has to represent \"we have promised this money but do not yet know the outcome\". Here that is an ACTIVE row in pending_holds, which raises the account's held_balance so the money cannot be spent twice, while the journal records only what settled.",
      built: [
        { name: "Faster Payments", what: "The UK's real-time payment scheme: the shared system UK banks use to send each other payments in seconds, all day, every day. Up to £1 million a payment at scheme level, raised from £250,000 in 2022; each bank sets its own lower limit.", why: "A business paying a supplier today wants the money there in seconds, any day. Bacs takes three working days and CHAPS is for high values in working hours." },
        { name: "A hold in pending_holds", what: "One row per hold: the account, source_type and source_id (what asked for it: a payment, a payroll run, a card authorisation), the amount, the currency, a status (ACTIVE, then CAPTURED, VOIDED or EXPIRED) and expires_at. UNIQUE (source_type, source_id) allows one hold per source. A trigger adds the amount to the account's held_balance when the hold is placed and takes it off when the hold ends. A new hold needs an OPEN account.", why: "Entries are never updated, so \"pending\" cannot be a status on an entry. A separate table of holds keeps the journal to settled money only, and the hold's status can change exactly once, which a trigger enforces. A void posts nothing: the journal never saw the payment." },
        { name: "Card networks and Bacs, the same shape", what: "A card authorisation is a hold of the network's billing amount in pounds plus a buffer; the settlement captures it and posts entries. Bacs payroll is a hold on approval, captured on the processing day. Incoming payments post directly, with no hold.", why: "One mechanism for every rail that answers later: hold, then capture, void or expire. Only the rail's own clearing account and timings differ." },
        { name: "Card FX on a sterling card", what: "For a purchase in dollars on a sterling card, the network converts and sends the cardholder billing amount in GBP. The bank holds that plus a buffer, captures what clears, and earns its non-sterling transaction fee as FX income. It does not quote a rate or buy dollars per purchase.", why: "A reviewer's reasoning plus a personal blog; not checked against scheme rules. A multi-currency card that settles with the network in USD would instead post through the FX pools, the owner's five-entry bridge." },
        { name: "Card lifecycle beyond one hold", what: "The Card service keeps one card_authorisations row per hold. An incremental authorisation is a new row with the same network_lifecycle_id and its own hold. A partial capture ends the hold and places a new hold for the remainder under a new source row, in the same transaction. A refund is a credit posting with no hold. A chargeback is a provisional credit, then the scheme's outcome posts or reverses it.", why: "The ledger stays with one mechanism. A reversal the customer has already spent is a posting the bank must accept, so it uses the hard floor and the receivable. Interchange is income booked from the settlement report, not per purchase." },
        { name: "Direct Debits and returns", what: "A Direct Debit settles but can be reclaimed under the Direct Debit Guarantee, so a returned debit, like a returned Faster Payment, is a posting the bank must accept.", why: "Such postings use the hard floor, not the soft limit. A repayment restores credit at once only when the money that pays it is already final, as a transfer from the bakery's own wallet is." },
      ],
      numbers: [
        { text: 'Up to £1 million per payment at scheme level, raised from £250,000 in 2022.', from: "Not a sum. From Pay.UK's 2022 press release, cited on the page: up to £1 million from 10 February 2022, up from £250,000." },
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
      id: 'cardnet',
      name: 'Card network',
      short: 'Network',
      tech: 'card schemes',
      x: 70, y: 340, w: 130, h: 56, kind: 'outside',
      what: "Mastercard and Visa: the networks between the shop's bank (the acquirer) and the bank that issued the card (us). A purchase reaches us as an ISO 8583 authorisation request that wants an answer in seconds. The money moves a day or two later, when the network sends its clearing file and settles with the bank.",
      why: "The network is outside our control. It asks now and settles later, for the same amount, a different one, or never, and if we do not answer in time it may answer for us. That is why a card purchase is a hold first and a posting later.",
      built: [
        { name: "ISO 8583", what: "The message standard card networks use: numbered message types, such as an authorisation request and its response, with numbered fields for the amount, the currencies, the merchant and its category code (MCC), and the network's own reference for the purchase.", why: "It is what the network speaks, so the Card service translates it. The ledger never sees an ISO 8583 message: it sees PlaceHold and SettleCardTransaction." },
        { name: "Clearing file", what: "The network's batch, a day or two after the purchase, of the purchases it is settling: each with the network's reference, the cleared amount and the billing amount in pounds.", why: "Clearing is when the purchase becomes a debt between banks. The Card service matches each line to its authorisation by the network's reference and asks the Core Ledger to post it." },
        { name: "Stand-in", what: "If the issuer does not answer in time, the network can approve or decline on its behalf under rules the issuer agreed.", why: "A stand-in approval has no hold behind it, so its clearing arrives as a force-post: a debit the bank must accept, as far as the hard floor." },
      ],
      numbers: [
        { text: 'A network expects an answer to an authorisation within a couple of seconds, so card holds cannot wait in a queue.', from: "Not a sum, and not checked against a network rulebook: the coordinator's working figure from general knowledge. The design depends only on it being seconds, not minutes." },
      ],
      fails: "It goes quiet, or our answer is late. The network declines or stands in. If our hold had committed but the answer was lost, the Card service voids the hold with VoidHold keyed by the auth_id; the nightly parity job catches any it missed.",
      alternatives: [
        {
          name: 'Our own Card service on the network', chosen: true, good: 'We own the authorisation decision, the data and the timings.', cost: 'Network certification and a 24/7 service on the hot path.',
          what: 'The bank connects to the networks, directly or through a processor that only passes messages on, and its own Card service decides each authorisation by asking the Core Ledger for a hold.',
          pros: ['Every decision uses our own balances, live.', 'Merchant data and the full message lifecycle stay with us.', 'One hold mechanism for cards, bank payments and payroll.'],
          cons: ['A service that must answer in seconds, all day, every day.', 'Certification with each network.', 'Stand-in rules to agree and to reconcile.'],
        },
        {
          name: 'An outsourced issuer processor', good: 'Fast to launch: the processor runs authorisation and clearing.', cost: "The processor keeps its own balances, so ours lag or must be synchronised.",
          what: "A third party connects to the networks and decides authorisations, either from balances it holds for us or by calling us back for each one.",
          pros: ['No network certification of our own.', 'Clearing files arrive already matched.'],
          cons: ['Two sets of balances to keep in step.', 'Another party in every decision.', 'Less control over declines and timings.'],
        },
      ],
      say: "The card network asks now and settles later. Its request becomes a hold; its clearing becomes a posting.",
    },
    {
      id: 'cardsvc',
      name: 'Card service',
      tech: 'ISO 8583, auths',
      x: 315, y: 340, w: 150, h: 56, kind: 'shared',
      what: "The Card Processor Service. It owns card_authorisations, in its own database: the ISO 8583 lifecycle, merchant name and MCC, the original and billing amounts, declines, incremental authorisations and partial captures. For an authorisation it writes the row as INITIATED, calls the Core Ledger's PlaceHold synchronously with idempotency_key = auth_id, then marks the row APPROVED with the hold_id, or DECLINED. When the clearing file arrives it marks the row CLEARING_SUBMITTED and emits SettleCardTransaction through its own outbox. It reads TransactionPosted and HoldExpired from ledger-events and marks the row CLEARED or EXPIRED.",
      why: "A service boundary. The Core Ledger knows accounts, holds and entries; it should not know ISO 8583, merchants or what an incremental authorisation is. Each service has its own database, so there is no transaction across them: a synchronous call where an answer is needed now, an outbox and Kafka where it is not, and a nightly parity job to prove the two sides agree.",
      built: [
        { name: "card_authorisations", what: "The owner's table: auth_id, hold_id (filled once the hold is placed), card_id, account_id, network_lifecycle_id, merchant_name, merchant_category_code, original and billing amounts and currencies, quoted_fx_rate, status (INITIATED, APPROVED, DECLINED, CLEARING_SUBMITTED, CLEARED, EXPIRED) and created_at.", why: "The Card service's own record of every authorisation, approved or not. A decline is remembered here, not in the ledger. One row per hold: an incremental authorisation is a new row with the same network_lifecycle_id and its own hold." },
        { name: "PlaceHold, synchronous", what: "A gRPC call to the Ledger API with idempotency_key = auth_id, the account, the amount and an expiry, under a deadline. The answer is the hold, or a decline.", why: "The network wants an answer in seconds, so the hold cannot wait in a queue. The owner's target for the whole path is about 50 to 100 ms. A retry reuses the auth_id, and UNIQUE (source_type, source_id) on pending_holds means it places nothing new." },
        { name: "Its own outbox", what: "An outbox table in the Card service's database, written in the same local transaction as CLEARING_SUBMITTED, and published to the card-settlements topic by its own relay.", why: "The same rule as the ledger: no dual write. The settlement command exists if and only if the row says CLEARING_SUBMITTED." },
        { name: "Stuck INITIATED rows", what: "A sweep in the Card service finds rows still INITIATED a few seconds after they were written: the service crashed, or PlaceHold timed out.", why: "It calls PlaceHold again with the same auth_id, which returns the hold if one exists, then voids it if the network has already been answered with a decline. The parity job catches anything left." },
      ],
      numbers: [
        { text: "About 50 to 100 ms for an authorisation inside the bank, the owner's target.", from: "Not a sum: the owner's figure for the synchronous path (write INITIATED, PlaceHold, write APPROVED). Not measured here." },
        { text: 'Assume 300 card authorisations a second, each held about 2 days before clearing: about 52 million ACTIVE card holds.', from: "An assumption, not from a source: 300 × 172,800 seconds = about 52 million. Used for the size of the partial index on ACTIVE holds." },
      ],
      tables: [
        {
          title: "card_authorisations: the owner's table",
          lang: 'sql',
          code: `CREATE TABLE card_authorisations (
    auth_id UUID PRIMARY KEY,
    hold_id UUID,               -- once the Core Ledger confirms
    card_id UUID NOT NULL,
    account_id UUID NOT NULL,
    network_lifecycle_id VARCHAR(64) NOT NULL,
    merchant_name VARCHAR(255),
    merchant_category_code CHAR(4),
    original_amount BIGINT NOT NULL,
    original_currency CHAR(3) NOT NULL,
    billing_amount BIGINT NOT NULL,
    billing_currency CHAR(3) NOT NULL,
    quoted_fx_rate NUMERIC(18, 8),
    status VARCHAR(20) NOT NULL,  -- INITIATED, APPROVED, DECLINED,
      -- CLEARING_SUBMITTED, CLEARED, EXPIRED
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
          note: "In the Card service's own database. account_id has no foreign key: accounts lives in the Core Ledger's database. auth_id is also the ledger's idempotency key for the hold.",
        },
        {
          title: 'Its indexes and its outbox',
          lang: 'sql',
          code: `CREATE UNIQUE INDEX uq_auth_hold ON card_authorisations
    (hold_id) WHERE hold_id IS NOT NULL;      -- CLEARED by hold
CREATE INDEX idx_auth_lifecycle ON card_authorisations
    (network_lifecycle_id);                   -- clearing match
CREATE INDEX idx_auth_initiated ON card_authorisations
    (created_at) WHERE status = 'INITIATED';  -- stuck rows

CREATE TABLE card_outbox (
    event_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(40) NOT NULL,  -- SettleCardTransaction
    account_id UUID NOT NULL,         -- the Kafka key
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`,
          note: "This panel's additions: the owner gave no indexes, and these are the ones the queries below need. card_outbox is named on the page; its columns copy outbox_events.",
        },
      ],
      queries: [
        {
          title: 'Authorise: record, PlaceHold, then the answer',
          lang: 'sql',
          code: `INSERT INTO card_authorisations (auth_id, card_id, account_id,
  network_lifecycle_id, merchant_name, merchant_category_code,
  original_amount, original_currency, billing_amount,
  billing_currency, status)
VALUES ('a17c0de5-...0610', 'c4d0e8f1-...0144',
  '5f0c2a9e-...081444', 'MCC8K2QX1114', 'NORTHERN OVENS LTD',
  '5046', 64900, 'GBP', 64900, 'GBP', 'INITIATED');

-- PlaceHold(idempotency_key = a17c0de5-...0610), synchronous

UPDATE card_authorisations
   SET status = 'APPROVED', hold_id = 'b61c9a3e-...0610'
 WHERE auth_id = 'a17c0de5-...0610' AND status = 'INITIATED';
-- or SET status = 'DECLINED' when PlaceHold declines`,
          note: 'Per authorisation, about 300 a second assumed, inside the 50 to 100 ms target. Each statement is its own local transaction. The UPDATE names the status it expects, so a repeat changes nothing.',
        },
        {
          title: 'Clearing: match the line, submit through the outbox',
          lang: 'sql',
          code: `SELECT auth_id, hold_id, account_id FROM card_authorisations
 WHERE network_lifecycle_id = 'MCC8K2QX1114'
   AND status = 'APPROVED';

BEGIN;
UPDATE card_authorisations SET status = 'CLEARING_SUBMITTED'
 WHERE auth_id = 'a17c0de5-...0610' AND status = 'APPROVED';
INSERT INTO card_outbox (event_type, account_id, payload)
VALUES ('SettleCardTransaction', '5f0c2a9e-...081444',
        '{"auth_id": "a17c0de5-...0610", ...}');
COMMIT;`,
          note: 'Once per clearing line, using idx_auth_lifecycle. Simplified: an incremental authorisation shares the network_lifecycle_id, so a real match also compares amounts. A line with no APPROVED row (a stand-in approval) settles with no hold.',
        },
        {
          title: 'TransactionPosted or HoldExpired comes back',
          lang: 'sql',
          code: `UPDATE card_authorisations SET status = 'CLEARED'
 WHERE hold_id = 'b61c9a3e-...0610'
   AND status = 'CLEARING_SUBMITTED';

-- on HoldExpired for a hold still APPROVED
UPDATE card_authorisations SET status = 'EXPIRED'
 WHERE hold_id = 'b61c9a3e-...0610' AND status = 'APPROVED';`,
          note: 'Read from ledger-events; uq_auth_hold finds the row. A redelivered event finds the status already moved on and changes nothing.',
        },
        {
          title: 'Stuck INITIATED rows',
          lang: 'sql',
          code: `SELECT auth_id, account_id, billing_amount, billing_currency
  FROM card_authorisations
 WHERE status = 'INITIATED'
   AND created_at < now() - interval '5 seconds'
 ORDER BY created_at
 LIMIT 100;
-- each: PlaceHold again with the same auth_id, which returns the
-- hold if one exists; then APPROVED, or VoidHold if the network
-- was already told no`,
          note: 'A sweep every few seconds, on idx_auth_initiated, which stays tiny. 5 seconds is illustrative; the page says "a few seconds".',
        },
        {
          title: 'Nightly parity export: the Card service side',
          lang: 'sql',
          code: `SELECT auth_id, hold_id, status FROM card_authorisations
 WHERE status IN ('APPROVED', 'CLEARED')
   AND created_at < '2026-11-14 00:00+00';`,
          note: "On the Card service's replica, after the cut-off. Reconciliation compares it with the Core Ledger's holds and headers.",
        },
      ],
      fails: "It crashes after PlaceHold committed but before APPROVED was written. On restart the INITIATED row is retried with the same auth_id: PlaceHold places nothing new, and the service reads back the same hold. If the network was meanwhile told no, the service voids the hold with VoidHold keyed by the auth_id. The nightly parity job finds anything still out of step.",
      alternatives: [
        {
          name: 'A separate service with its own database', chosen: true, good: 'The ledger stays small and strict; card rules change without touching it.', cost: 'Two databases to keep in step, with no transaction across them.',
          what: "The Card service owns card_authorisations and the network conversation. It reaches the Core Ledger by a synchronous PlaceHold and by SettleCardTransaction through its outbox and Kafka, and listens to ledger-events.",
          pros: ['The Core Ledger knows nothing about ISO 8583, merchants or MCCs.', 'Each side scales and deploys on its own.', 'A decline is the Card service\'s record, not the ledger\'s.'],
          cons: ['No transaction spans both: a crash between the hold and APPROVED leaves them apart until a retry or the parity job.', 'Two outboxes, two relays, a topic each way.', 'A parity job to build and to watch.'],
        },
        {
          name: 'Card logic inside the Core Ledger', good: 'One transaction for the authorisation row and the hold.', cost: 'The ledger learns every card rule and every network quirk.',
          what: "The ledger's database also holds card_authorisations, and one local transaction writes the authorisation and the hold together.",
          pros: ['No parity job: the two rows commit together.', 'One fewer service.'],
          cons: ['Every card change is a change to the money service.', 'The ledger database carries merchant data and ISO 8583 detail.', 'Billing and payments would want the same, and the ledger becomes everything.'],
        },
        {
          name: 'Distributed two-phase commit across the two databases', good: 'The authorisation row and the hold commit together across services.', cost: 'Locks held across the network, and a lost coordinator leaves both waiting. The owner rules it out.',
          what: 'A coordinator prepares both databases, then commits both.',
          pros: ['No window where one side has committed and the other has not.'],
          cons: ['Row locks on the account held while the coordinator talks to another service.', 'A lost coordinator leaves prepared transactions holding locks.', 'Too slow for a seconds budget at peak.'],
        },
      ],
      say: "The Card service owns the card's story; the ledger owns the money. They meet at PlaceHold, which is synchronous and keyed by the auth_id, and at SettleCardTransaction, which goes through an outbox and Kafka.",
      see: [{ id: 'outbox', label: 'Transactional outbox' }, { id: 'idempotency-keys', label: 'Idempotency keys' }],
    },
    {
      id: 'billing',
      name: 'Billing',
      tech: 'statements',
      x: 585, y: 340, w: 130, h: 56, kind: 'shared',
      what: "The Credit Billing Service. It reads TransactionPosted from ledger-events and keeps, in its own database, credit_balance_buckets (each card's balance split by APR tier and by whether it is still in its grace period), credit_statements, a nightly accrual of interest in millionths of a penny (accrued_unbilled_interest_micros), and the order in which a repayment pays the buckets off. On statement day, if interest is due, it posts one INTEREST_CHARGE through the Ledger API: the card account debited, a row of INTEREST_INCOME_GBP credited.",
      why: "Statements, rates and grace periods are rules about a credit product, not about money balancing. Kept here, the nightly accrual never touches the ledger: no entry, no lock on the card, no cost to available credit. The ledger sees interest once, when it is charged.",
      built: [
        { name: "credit_balance_buckets", what: "One row per card, bucket type (purchases, cash, promotional), APR tier and grace-period eligibility, with its balance in pence. A purchase's TransactionPosted adds to the purchases bucket at the card's purchase APR, grace-eligible.", why: "Interest and repayment allocation work per bucket, so billing needs the breakdown the ledger does not keep: the ledger has one posted_balance per card. Billing reconciles the sum of a card's buckets to that posted_balance every night." },
        { name: "Nightly micro-interest accrual", what: "Each night, for each bucket: balance × APR ÷ 365, in micros (millionths of a penny), added to accrued_unbilled_interest_micros. At an illustrative 18% on 64900p that is 32,005,479 micros, about 32p, a day.", why: "Whole pence each day would round away money; micros keep the sum exact until it is charged in whole pence on statement day, with the remainder carried. None of it is in the ledger." },
        { name: "Statement day", what: "Billing closes the cycle, writes credit_statements, and if interest is due posts INTEREST_CHARGE through the Ledger API: card -X, INTEREST_INCOME_GBP +X. If the statement balance is paid in full within the grace period, the accrued interest on grace-eligible buckets is dropped and nothing is posted.", why: "The owner's pair, posted once a month. The header's idempotency_key is made from the card and the statement date, so a rerun posts nothing." },
        { name: "Allocation waterfall", what: "The owner's order for a repayment: fees, then interest, then principal from the highest-APR bucket down. A repayment is one credit to the card in the ledger; billing splits it across buckets.", why: "For regulated credit, CONC 6.7.4R sends repayments to the highest-interest balance first (a reviewer's reading of Osborne Clarke's note on the 2021 amendment). A limited company's card is mostly outside the Consumer Credit Act; a sole trader's or small partnership's is inside, and for those the order must be checked against that rule." },
      ],
      numbers: [
        { text: '32,005,479 micros a day on 64900p at an illustrative 18% APR.', from: "64900 × 0.18 ÷ 365 = 32.005479 pence = 32,005,479 micros. The rate is illustrative, not the bank's." },
      ],
      tables: [
        {
          title: 'credit_balance_buckets, and where billing has read to',
          lang: 'sql',
          code: `CREATE TABLE credit_balance_buckets (
    card_account_id UUID NOT NULL,  -- the Core Ledger's card account
    bucket VARCHAR(20) NOT NULL,    -- PURCHASE, CASH, PROMO
    apr_bps INT NOT NULL,           -- 1800 = 18%
    grace_eligible BOOLEAN NOT NULL,
    balance BIGINT NOT NULL DEFAULT 0,          -- pence owed
    accrued_unbilled_interest_micros BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (card_account_id, bucket, apr_bps, grace_eligible)
);

CREATE TABLE billing_applied (
    account_id UUID PRIMARY KEY,    -- the card account
    last_event_id BIGINT NOT NULL   -- from ledger-events
);`,
          note: "A sketch, not the owner's DDL. The bucket's columns and key are the ones the page's sketch uses. billing_applied is this panel's addition: the page says billing drops any event_id it has already applied for that account, and this is where it remembers.",
        },
        {
          title: 'credit_statements',
          lang: 'sql',
          code: `CREATE TABLE credit_statements (
    statement_id UUID PRIMARY KEY,
    card_account_id UUID NOT NULL,
    period_end DATE NOT NULL,
    statement_balance BIGINT NOT NULL,  -- pence owed at the close
    due_date DATE NOT NULL,             -- end of the grace period
    interest_charged BIGINT NOT NULL,   -- whole pence, 0 if none
    interest_carried_micros BIGINT NOT NULL,  -- the remainder
    interest_txn_id UUID,  -- the INTEREST_CHARGE header, if posted
    UNIQUE (card_account_id, period_end)
);`,
          note: "This panel's sketch: the page names the table but not its columns. UNIQUE (card_account_id, period_end) means a rerun of statement day writes nothing new, as the ledger key interest:<card>:<date> posts nothing new.",
        },
      ],
      queries: [
        {
          title: 'Apply a TransactionPosted once',
          lang: 'sql',
          code: `BEGIN;
INSERT INTO billing_applied AS a (account_id, last_event_id)
VALUES ('5f0c2a9e-...081444', 5530611)
ON CONFLICT (account_id) DO UPDATE
   SET last_event_id = EXCLUDED.last_event_id
 WHERE a.last_event_id < EXCLUDED.last_event_id;
-- 0 rows: already applied; ROLLBACK and skip

INSERT INTO credit_balance_buckets AS b (card_account_id,
  bucket, apr_bps, grace_eligible, balance)
VALUES ('5f0c2a9e-...081444', 'PURCHASE', 1800, true, 64900)
ON CONFLICT (card_account_id, bucket, apr_bps, grace_eligible)
DO UPDATE SET balance = b.balance + EXCLUDED.balance;
COMMIT;`,
          note: 'Per card event read from ledger-events. event_id rises per account in commit order, so one number per account is enough to drop repeats.',
        },
        {
          title: "Tonight's accrual, in millionths of a penny",
          lang: 'sql',
          code: `UPDATE credit_balance_buckets
   SET accrued_unbilled_interest_micros =
       accrued_unbilled_interest_micros
       + balance * apr_bps * 1000000 / 10000 / 365
 WHERE balance > 0;
-- 64900 x 1800 x 1000000 / 10000 / 365 = 32005479 (about 32p)`,
          note: 'Nightly, over every bucket with a balance, in batches of cards in practice. Nothing here touches the ledger.',
        },
        {
          title: 'Statement day: sum, record, then post once',
          lang: 'sql',
          code: `SELECT sum(accrued_unbilled_interest_micros) AS micros
  FROM credit_balance_buckets
 WHERE card_account_id = '5f0c2a9e-...081444';
-- 812219160 micros: charge 812p, carry 219160

BEGIN;
INSERT INTO credit_statements (statement_id, card_account_id,
  period_end, statement_balance, due_date, interest_charged,
  interest_carried_micros, interest_txn_id)
VALUES ('5a7e0c11-...1231', '5f0c2a9e-...081444', '2026-12-31',
  35712, '2027-01-25', 812, 219160, '7d1f0a52-...900612')
ON CONFLICT (card_account_id, period_end) DO NOTHING;
UPDATE credit_balance_buckets
   SET accrued_unbilled_interest_micros = 0
 WHERE card_account_id = '5f0c2a9e-...081444';
COMMIT;
-- then Post INTEREST_CHARGE through the Ledger API, key
-- interest:5f0c2a9e-...081444:2026-12-31, id ...900612`,
          note: 'Once a cycle per card. The transaction id and key are fixed before the call, so a retry after a crash posts once. Paid in full in the grace period: interest_charged 0 and no Post. 35712 is 34900 owed plus 812; the due date is illustrative. Simplified: the carried micros are added back next cycle, and billed interest would get its own bucket.',
        },
        {
          title: 'A repayment: highest APR first',
          lang: 'sql',
          code: `WITH r AS (
  SELECT bucket, apr_bps, grace_eligible, balance,
         sum(balance) OVER (ORDER BY apr_bps DESC, bucket,
                            grace_eligible) AS upto
    FROM credit_balance_buckets
   WHERE card_account_id = '5f0c2a9e-...081444' AND balance > 0)
SELECT bucket, apr_bps,
       least(balance, greatest(0, 30000 - (upto - balance))) AS pay
  FROM r ORDER BY apr_bps DESC;
-- PURCHASE 1800: 30000; each bucket is then reduced by its pay`,
          note: 'Once per repayment. The ledger saw one credit of 30000 to the card; billing splits it. Simplified: fees and billed interest, which come first in the owner\'s order, are left out.',
        },
        {
          title: 'Nightly: buckets against the ledger',
          lang: 'sql',
          code: `-- billing's replica: what billing says each card owes
SELECT card_account_id, sum(balance) AS owed
  FROM credit_balance_buckets GROUP BY card_account_id;
-- the Core Ledger replica: the same, from the card rows
SELECT account_id, -posted_balance AS owed
  FROM accounts WHERE account_type = 'CREDIT_CARD';
-- e.g. 5f0c...081444: 34900 both sides; any difference is a break`,
          note: 'Two databases, so the rows are compared outside both, as the parity job does. A card is a debit balance in the ledger, so its posted_balance is negative.',
        },
      ],
      fails: "It falls behind or stops. Nothing in the ledger is affected; statements and interest wait. It replays ledger-events from its position, dropping any event_id it has applied for that account. A bug that charges interest twice is refused by the header's UNIQUE (idempotency_key).",
      alternatives: [
        {
          name: 'Accrue in billing, charge once on statement day', chosen: true, good: 'The ledger sees interest once a month; the grace period costs nothing to honour.', cost: 'Interest income is recognised in the ledger monthly, not daily.',
          what: "Billing accrues nightly in micros in its own tables. On statement day it posts one INTEREST_CHARGE, or nothing if the grace period applies.",
          pros: ['No nightly write to every card account.', 'Available credit is not eaten by interest that may be waived.', 'Paid in full in the grace period means no posting and no reversal.'],
          cons: ['Daily revenue recognition needs another feed: billing\'s accruals, not the ledger.', 'Billing\'s buckets must be reconciled to the ledger nightly.'],
        },
        {
          name: 'Accrue inside the ledger every day', good: 'Interest income is on the books daily, between two system accounts.', cost: 'Millions of small postings a night, and reversals when the grace period applies.',
          what: "This evening's earlier design: billing posts INTEREST_RECEIVABLE_GBP -32, INTEREST_INCOME_GBP +32 each night, and on statement day charges the card against the receivable; paid in full, the accrual is reversed.",
          pros: ['Daily revenue recognition straight from the ledger.', 'The card itself is untouched until statement day.'],
          cons: ['One posting per card per night, and a reversal for every card paid in full.', 'More hot-row traffic on the system accounts.', 'Whole pence per day lose the fractions.'],
        },
        {
          name: "Debit the card every night", good: 'Simple to explain.', cost: 'Contradicts the grace period, compounds daily, eats available credit and fails at the limit.',
          what: "The owner's earlier idea: the nightly job posts each day's interest straight to the card.",
          pros: ['The card balance always includes interest to date.'],
          cons: ['Interest shows before the customer can avoid it.', 'Compounds daily.', 'A card at its limit could not be charged under the old single CHECK.'],
        },
      ],
      say: "Billing decides interest; the ledger only posts it. Accrual lives in billing in micros, and the ledger sees one INTEREST_CHARGE on statement day, or none.",
    },
    {
      id: 'ledger',
      name: 'Ledger API',
      tech: 'rules, routing',
      x: 550, y: 200, w: 130, h: 56, kind: 'shared',
      what: "The front of the Core Ledger Service: a stateless service in front of the ledger clusters. Its callers are the Banking API (bank payments, payroll), the Card service (PlaceHold and VoidHold for authorisations) and Billing (INTEREST_CHARGE); card settlements reach the Core Ledger through Kafka and its settlement worker instead. It checks that every transaction sums to zero in each currency, that each entry's currency is its account's, that amounts are whole minor units, and that accounts exist and are not closed. It finds the cluster from the business that owns the accounts, checks the idempotency key and transaction id the caller made, turns each logical system account such as FPS_CLEARING_GBP into one of its 16 rows by shard_id = hash(transaction_id) % 16, splits any credit to an account that has a receivable so the receivable is paid first, then sends the write to the cluster as one call to a database function: ledger_place_hold, ledger_capture, ledger_void_hold or ledger_post.",
      why: 'Rules about money belong in one place. Sending each write as a single call means row locks are held only for the time the database itself needs, about 1 to 2 ms with the commit, never across a network round trip.',
      built: [
        { name: "Core Ledger Service", what: "The owner's first service: the Ledger API, the workers, and the ledger clusters (the dashed frame). It owns accounts, pending_holds, transactions, ledger_entries and outbox_events, and nothing else.", why: "Its job is strictly fund reservations, balance enforcement and zero-sum accounting. It knows nothing about cards, merchants' lifecycles, statements or interest rates: those are the Card service's and Billing's. Each service has its own database, and there is no distributed two-phase commit between them." },
        { name: "Ledger rules", what: "Checks applied to every write: signed amounts (plus a credit, minus a debit) sum to zero per currency, no account appears twice in one transaction, every entry's currency matches its account, amounts are whole minor units, every account exists and is not CLOSED.", why: "If every team linked its own copy of the rules, one bad deploy anywhere could unbalance the books. The database checks again: the hard floor on each account, the currency and status tests in the triggers, and the per-currency sum-to-zero trigger at commit." },
        { name: "Routing to ledger clusters", what: "A small directory table, one row per business (about a million, tens of megabytes), cached in memory, says which ledger cluster holds that business's accounts. In phase 1 there is one cluster and every row says so.", why: "Phase 2 splits businesses across clusters when one primary is no longer enough: 4 at this page's stress peak. Each cluster has its own set of system accounts. A payment between two businesses on different clusters becomes two local transactions joined by INTERCLUSTER_OUT on the payer's cluster and INTERCLUSTER_IN on the payee's: the second is driven by the outbox and keyed by the same transaction id, the pair must net to zero, and reconciliation watches the age of anything in flight. Clusters are never called shards here: shard_id means something else." },
        { name: "shard_id picked by hash", what: "Each busy system account, named by rail and currency, is 16 rows with shard_id 0 to 15. The Ledger API hashes the caller's transaction id and takes the remainder after dividing by 16. Customer wallets and credit cards are one row each, shard_id 0.", why: "Different payments land on different rows, so they rarely wait for each other's locks. The tour's capture hashed to 7, so it credits FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7. The same id always hashes to the same row, so a replay lands where the original did." },
        { name: "One call per write", what: "Small PL/pgSQL functions on each cluster. Each locks the account rows first, in account_id order, with FOR NO KEY UPDATE, then does its one conditional statement with the guard in ON CONFLICT, and writes its outbox_events rows. Timeouts come from the role.", why: "The early exits (already posted, not enough money, hold no longer ACTIVE) happen inside the database, so no lock waits on the network. Ten round trips of 0.5 ms would hold a hot row for 5 ms, about 200 writes a second on it at most." },
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
          what: 'The Ledger API calls ledger_place_hold, ledger_capture, ledger_void_hold or ledger_post once with the keys, the ids and the signed entries. The function locks the account rows in account_id order, runs one conditional statement (the header and entries, or the hold) with its guard in ON CONFLICT, writes the outbox_events rows, and the transaction commits. The role carries the timeouts.',
          pros: ['Locks last for in-database work plus the commit, about 1 to 2 ms, not for network round trips.', 'One round trip per write, so a hot row is limited by the commit, not by the network.', 'The early exits happen inside the database.', 'The balance arithmetic is not in the functions: the triggers do it, whoever writes.'],
          cons: ['Logic in SQL needs the same review and tests as application code.', 'Changing a function is a database deploy: a new version beside the old, then switch callers.', 'Harder to debug and profile than service code.'],
        },
        {
          name: 'Interactive transaction from the service', good: 'All logic in one language, easy to read.', cost: "Each statement is a round trip while locks are held. TigerBeetle's authors saw this cap a central bank switch however much hardware was added.",
          what: 'The service opens a transaction and sends each statement in turn: lock the accounts, insert the hold or the header and entries, insert the outbox row, commit. The triggers still keep the balances; only the round trips change.',
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
      say: 'The Ledger API is the front of the Core Ledger Service. It refuses anything that does not balance in each currency, picks the cluster and the system account row, and sends each write to the database as one call so that locks never wait on the network.',
      see: [{ id: 'partitioning', label: 'Partitioning' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'db',
      name: 'Ledger DB',
      tech: 'Postgres primary',
      x: 795, y: 200, w: 190, h: 118, kind: 'node',
      lines: ['entries: append-only', 'holds: pending_holds', 'posted, held balances'],
      what: "The source of truth, one per ledger cluster, holding the Core Ledger's five tables. transactions holds one header row per transaction: its caller-made id, a unique idempotency_key, the transaction_type, a status (POSTED or REVERSED), merchant and currency fields, and reference_id (the hold it captured, or the transaction it reverses). ledger_entries holds settled movements only: one row per debit or credit, a signed amount in minor units with its currency, and is only ever inserted. Each transaction is two or more entries that sum to zero in each currency. pending_holds holds money promised but not settled: one row per hold, ACTIVE until it is CAPTURED, VOIDED or EXPIRED. accounts holds one row per account and currency with two caches, posted_balance (the sum of its entries) and held_balance (the sum of its ACTIVE holds), a soft credit_limit, a hard_limit and a status. Triggers keep both caches in the same transaction, a guard refuses any other change to them, and a CHECK keeps posted minus held at or above minus hard_limit. outbox_events rows are written in the same transaction too.",
      why: "Writing the hold or the entries, both balances, the header and the event in one local transaction is what makes the balance strictly consistent: a reader never sees entries without their balance change, and a retry never posts twice. Keeping the caches with triggers means no code path can forget them and no application role can edit them. Two limits, because some debits are the customer's choice (refuse them at credit_limit) and some are not (interest, fees, settlements, reversals: the bank must post them, as far as hard_limit).",
      built: [
        { name: "PostgreSQL", what: "An open-source relational database: tables, SQL, transactions that commit all or nothing, row locks, triggers and constraints.", why: "The team knows it, and the owner's phases keep it as the ledger until hot accounts dominate. In phase 3 it stays for account metadata, KYC, billing statements, search and reporting." },
        { name: "Primary", what: "The one copy of each cluster's database that accepts writes. Funds checks and balance reads also go to it.", why: "Only the primary is always current, and a balance is used to decide whether money can be spent. Its two synchronous standbys make sure losing it loses nothing." },
        { name: "transactions, the header", what: "The owner's table, never partitioned. One row per transaction: transaction_id (primary key, made by the caller), idempotency_key (UNIQUE, up to 100 characters), transaction_type, status (POSTED or REVERSED), merchant_name, merchant_category_code, source_currency, target_currency, fx_rate, reference_id and created_at. Every entry references it.", why: "UNIQUE (idempotency_key) is the lasting duplicate guard: a redelivered clearing with the same key and a new transaction id posts nothing (checked). It is immutable except for one change: POSTED to REVERSED, made only by the trigger that fires when a REVERSAL naming it is inserted. Never deleted. About 200 bytes a row with its unique indexes (an estimate), so about 6 TB a year at the stress load." },
        { name: "ledger_entries, append-only", what: "The owner's table: entry_id, transaction_id (a foreign key to transactions), account_id, amount (BIGINT minor units, plus a credit, minus a debit, never zero), currency and created_at. A row trigger refuses UPDATE and DELETE; a statement trigger refuses TRUNCATE. UNIQUE (transaction_id, account_id) stops a transaction posting twice to one account.", why: "Corrections become new transactions, so the history shows both the mistake and the fix. Triggers do not stop DROP TABLE, so the ledger's role is granted INSERT and SELECT only, and archiving runs as a separate role." },
        { name: "pending_holds", what: "The owner's new table, unpartitioned: hold_id (primary key), account_id, source_type (CARD_AUTH, OUTBOUND_PAYMENT, PAYROLL_BATCH, FX_SPOT), source_id (the auth_id or payment id), amount (above zero), currency, status (default ACTIVE), expires_at, created_at, updated_at, and UNIQUE (source_type, source_id). A trigger allows one change only: from ACTIVE to CAPTURED, VOIDED or EXPIRED, with nothing else altered, and sets updated_at. Only a hold that is no longer ACTIVE may be deleted, and only the archive role has DELETE.", why: "UNIQUE (source_type, source_id) is the hold's idempotency guard: PlaceHold inserts ON CONFLICT (source_type, source_id) DO NOTHING, so a retry with the same auth_id places nothing new and emits no second event (checked). One hold per source row follows. Unpartitioned, so the unique key stays a real guard. A partial index on (account_id, expires_at) WHERE status = 'ACTIVE' (this design's addition) serves the expiry job and the pending list." },
        { name: "accounts, the balance cache", what: "One row per account and currency: logical_account, shard_id, account_type (USER_WALLET, CREDIT_CARD, RECEIVABLE, CLEARING, NOSTRO, FX_POOL, REVENUE), owner_account_id (a receivable's customer), allow_negative, posted_balance, held_balance, credit_limit, hard_limit, currency, status (OPEN, NO_NEW_SPEND, CLOSED). Created WITH (fillfactor = 80).", why: "A funds check reads one row. In PostgreSQL an UPDATE writes a new version of the row; if it fits on the same page and no indexed column changed, it is a HOT (heap-only tuple) update and no index is touched. The balances are not indexed. HOT and fillfactor help only while old versions can be pruned: no long transactions on the primary, idle_in_transaction_session_timeout set, and an alert on the oldest xmin. A reviewer saw one old open transaction grow a table of such rows from 8 pages to 469." },
        { name: "The triggers", what: "ledger_entries_apply (AFTER INSERT on entries) adds the amount to posted_balance, unless the account is CLOSED. pending_holds_placed (AFTER INSERT on holds) adds to held_balance, only on an OPEN account; pending_holds_ended (BEFORE UPDATE OR DELETE) takes it off, and refuses deleting an ACTIVE hold. Each refuses a row whose currency is not the account's. accounts_guard (BEFORE INSERT OR UPDATE) refuses an account opened with a balance, and a change to either balance at pg_trigger_depth() <= 1.", why: "A direct UPDATE fires the guard at depth 1 and is refused; a trigger's own UPDATE fires it at depth 2 and passes. Other columns, credit_limit, hard_limit and status among them, can still be changed, under column grants. The test sits inside the guard's function: in a WHEN clause a direct statement is at depth 0." },
        { name: "Soft limit and hard floor", what: "credit_limit is the soft limit: tested only when the customer starts a debit, in the hold's or payment's conditional insert, posted - held - amount >= -credit_limit AND status = 'OPEN', under the account lock. hard_limit is the floor the database enforces: CHECK (allow_negative OR (posted_balance - held_balance) >= -hard_limit), with CHECK (hard_limit >= credit_limit). Example values: a card 500000 and 550000; a debit wallet 0 and 0.", why: "Interest, fees, settlements larger than a hold, stand-in approvals and reversals are debits the bank cannot refuse; the owner's single CHECK at -credit_limit refused them. Now they post past credit_limit as far as hard_limit, and past that the rest goes to the customer's own receivable. The cost: the database backstop is the hard floor, not the exact limit, so a code path that skipped the soft test could overspend by up to hard_limit - credit_limit." },
        { name: "Sum to zero at commit, once per transaction", what: "transactions_balanced: a constraint trigger on the header row, DEFERRABLE INITIALLY DEFERRED, that runs once at COMMIT and raises an error unless the transaction has at least two entries and each currency sums to zero. Its query carries created_at = NEW.created_at, so a partitioned journal is probed in one partition.", why: "On, not optional. A transaction of -100 GBP and +100 USD nets to zero as numbers and is refused; so is a header with one entry or none (both checked). The owner had no such check; the first version here ran once per entry, which is quadratic: a reviewer measured 8.2 s for a 5,001-entry payroll. Once per transaction, that payroll committed in about 0.7 s on the WASM build of PostgreSQL." },
        { name: "Guards on the tables, and outbox_events", what: "No separate key table: the guards are UNIQUE (source_type, source_id) on pending_holds and UNIQUE (idempotency_key) on transactions. outbox_events (the owner's name; event_type, aggregate_id, account_id, payload) gets one row per customer account the transaction touches, written in the same transaction.", why: "A guard exists if and only if the write committed, so a retry finds it and changes nothing; the ledger returns the hold or transaction already there. Saved replies and remembered declines belong to the caller's own record. A transfer between two customers needs an outbox row for each, so each account's partition of the topic hears of it." },
        { name: "Column grants on accounts", what: "The ledger's role may INSERT accounts (at zero) and UPDATE only through the triggers; only the credit service's role may UPDATE credit_limit, hard_limit, allow_negative and status. DELETE and TRUNCATE on accounts are revoked.", why: "The guard covers posted_balance and held_balance only. Anyone with UPDATE on accounts could otherwise raise a card's limit or switch off its floor. Cutting credit_limit below what is already used is allowed, and new holds then place nothing (checked); hard_limit below credit_limit is refused (checked). The table owner or a superuser can still disable triggers, so DDL goes through review and is logged." },
        { name: "Timeouts and PgBouncer", what: "ALTER ROLE ledger_writer SET statement_timeout = '250ms' and SET lock_timeout = '50ms', applied when each server connection logs in, plus a deadline on every client call. Batch roles (sweep, payroll, archive) get longer values. Connections reach PostgreSQL through PgBouncer in transaction pooling mode.", why: "A writer that cannot get a lock in 50 ms gives up and frees its connection. SET LOCAL statement_timeout inside the ledger function does nothing for that call, because the timer starts when the client's statement arrives; the role setting does work (checked: a function sleeping 1 s was cancelled at 251 ms). statement_timeout does not bound the COMMIT's wait for a synchronous standby: only the client deadline does." },
      ],
      numbers: [
        { text: 'About 95 GB a day across all clusters at the stress load of 1,000 payments a second: about 65 GB of entries, 17 GB of headers and 13 GB of holds.', from: "Entries: 1,000 payments a second × 3 entries each (wallet, scheme clearing, fee) = 3,000 a second × 86,400 seconds = about 260 million a day × 250 bytes = about 65 GB. Headers: one per settled payment, 86 million a day × about 200 bytes = about 17 GB; the owner's header carries merchant name, MCC, currencies, fx_rate and a key of up to 100 characters, with two unique indexes. Holds: 86 million a day × 150 bytes = about 13 GB. 250, 200 and 150 bytes are estimates with indexes. A card payment abroad is 3 entries like a bank payment; an FX conversion between wallets is 4." },
        { text: 'Assume 13 months of entries and 90 days of ended holds kept hot, and every header kept for good: about 34 TB in the first year, about 8.4 TB a cluster with 4 clusters, then about 6 TB more a year.', from: "Entries: 65 GB a day × about 395 days (13 months) = about 26 TB. Holds: 13 GB a day × about 92 days = about 1.2 TB. Headers: 17 GB a day × 365 = about 6.3 TB a year, never deleted. First year 26 + 1.2 + 6.3 = about 34 TB ÷ 4 clusters = about 8.4 TB each, and headers add about 1.6 TB a cluster each year after. At the reasoned baseline of 100 to 250 payments a second, 8.6 to 21.6 million headers a day × 200 bytes = 1.7 to 4.3 GB a day, about 0.6 to 1.6 TB a year in all. 13 months and 90 days are this design's assumptions. The archive job deletes about 86 million ended holds a day, each a dead row for vacuum." },
        { text: 'outbox_events: about 170 GB a day passes through at the stress load, kept about a day.', from: "Two rows per bank payment (HoldPlaced and TransactionPosted) × 86 million = about 172 million rows a day × about 1 KB (the event's size, an assumption) = about 170 GB a day. A cleanup job deletes rows the relay has passed once they are a day old (this design's choice), so the table holds about a day's worth, and vacuum cleans up after it." },
        { text: 'The accounts table: under 300 MB across all clusters, always in memory.', from: "1 million businesses with a GBP wallet, plus an assumed 20 per cent with a second currency and 10 per cent with a credit card = 1.3 million rows, plus a few hundred system rows (about 30 logical accounts × 16). × about 130 bytes a row (assumption) = about 170 MB; fillfactor 80 makes it about 210 MB; plus about 60 MB for the primary key and the (logical_account, shard_id) index. Receivables are rare and add little." },
        { text: 'Five trigger UPDATEs per bank payment: about 5,000 a second on average, 50,000 at peak, 12,500 a cluster.', from: "Per payment: 1 when the hold is placed (held_balance up), 1 when it is captured (held_balance down), 3 for the three entries (posted_balance). 5 × 1,000 = 5,000 a second; 5 × 10,000 = 50,000 at peak; ÷ 4 clusters = 12,500. Each is on a row the transaction already holds locked, and is HOT when the page has room. The balance check adds one query per transaction at commit, not per entry." },
        { text: 'The partial index on ACTIVE holds stays small: about 2 GB, against a table that gains 86 million rows a day.', from: "Bank payment holds last seconds. Assume 300 card authorisations a second held about 2 days before capture: 300 × 172,800 = about 52 million ACTIVE holds. × about 40 bytes an index entry for (account_id, expires_at) (assumption) = about 2.1 GB." },
      ],
      tables: [
        {
          title: 'accounts: the balance cache',
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
          note: 'One row per account and currency; a funds check reads one row by its primary key. posted_balance and held_balance change only through the triggers (on the "one call" line). The hard floor is the CHECK; credit_limit is tested by the hold\'s conditional insert.',
        },
        {
          title: 'pending_holds: money promised, not yet settled',
          lang: 'sql',
          code: `CREATE TABLE pending_holds (
    hold_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    source_type VARCHAR(25) NOT NULL, -- CARD_AUTH, OUTBOUND_PAYMENT,
                                      -- PAYROLL_BATCH, FX_SPOT
    source_id UUID NOT NULL,  -- card_authorisations.auth_id,
                              -- or the payment's id
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      -- ACTIVE, CAPTURED, VOIDED, EXPIRED
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_type, source_id)
);
CREATE INDEX idx_holds_active_account ON pending_holds
    (account_id, expires_at) WHERE status = 'ACTIVE';`,
          note: 'Unpartitioned, so UNIQUE (source_type, source_id) stays a real guard: a retried PlaceHold finds its row. The partial index holds only ACTIVE holds, about 2 GB; the expiry job and the pending list use it.',
        },
        {
          title: 'transactions: the header, never partitioned',
          lang: 'sql',
          code: `CREATE TABLE transactions (
    transaction_id UUID PRIMARY KEY,
    idempotency_key VARCHAR(100) NOT NULL UNIQUE,
    transaction_type VARCHAR(30) NOT NULL, -- CARD_PURCHASE,
      -- CASH_ADVANCE, CARD_REPAYMENT, FX_CONVERSION,
      -- INTEREST_CHARGE, PAYROLL (and FPS_OUT, REVERSAL, ...)
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
      -- POSTED, REVERSED
    merchant_name VARCHAR(255),
    merchant_category_code CHAR(4),
    source_currency CHAR(3),
    target_currency CHAR(3),
    fx_rate NUMERIC(18, 8),
    reference_id UUID,  -- the hold_id, or the original transaction
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
          note: 'UNIQUE (idempotency_key) is the lasting duplicate guard, which is why this table is never partitioned or deleted. Its one allowed change, POSTED to REVERSED, is made by a trigger when a REVERSAL posts.',
        },
        {
          title: 'ledger_entries: append-only, one partition a month',
          lang: 'sql',
          code: `CREATE TABLE ledger_entries (
    entry_id BIGSERIAL,
    transaction_id UUID NOT NULL
        REFERENCES transactions(transaction_id),
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0), -- + credit, - debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entry_id, created_at),
    UNIQUE (transaction_id, account_id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE ledger_entries_2026_11 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE INDEX idx_ledger_account_entry
    ON ledger_entries (account_id, entry_id DESC);  -- statements
CREATE INDEX idx_ledger_account_created
    ON ledger_entries (account_id, created_at DESC); -- date ranges`,
          note: "The owner's table, partitioned as this page does it: the keys must carry created_at, so the UNIQUE here guards nothing and the header's key does the work. Row triggers refuse UPDATE and DELETE; a statement trigger refuses TRUNCATE. An old month is detached, not deleted.",
        },
        {
          title: 'outbox_events: the event, in the same transaction',
          lang: 'sql',
          code: `CREATE TABLE outbox_events (
    event_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(40) NOT NULL,  -- HoldPlaced, HoldVoided,
      -- HoldExpired, TransactionPosted
    aggregate_id UUID NOT NULL,       -- hold_id or transaction_id
    account_id UUID NOT NULL,  -- the Kafka key; one row per
                               -- customer account touched
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`,
          note: 'Read by Debezium from the log, not polled. A cleanup job deletes rows once they are a day old, so it holds about a day: some 170 GB at the stress load.',
        },
        {
          title: 'Beside them: daily balances, period totals, old holds',
          lang: 'sql',
          code: `CREATE UNIQUE INDEX uq_receivable_owner ON accounts
    (owner_account_id) WHERE account_type = 'RECEIVABLE';

CREATE TABLE account_balances_daily (       -- end of day
    account_id UUID NOT NULL, business_date DATE NOT NULL,
    posted BIGINT NOT NULL, held BIGINT NOT NULL,
    last_entry_id BIGINT NOT NULL,
    PRIMARY KEY (account_id, business_date));

CREATE TABLE account_period_totals (        -- before a detach
    account_id UUID NOT NULL,
    period CHAR(7) NOT NULL,                -- '2025-09'
    total BIGINT NOT NULL,
    PRIMARY KEY (account_id, period));

CREATE TABLE pending_holds_history (LIKE pending_holds)
  PARTITION BY RANGE (created_at);     -- no uniqueness needed`,
          note: "account_balances_daily is as on the sweep line. account_period_totals has the page's three columns; its types and key are this panel's choice. Not shown: the logical_accounts registry and the business-to-cluster directory, whose columns the page does not give.",
        },
      ],
      queries: [
        {
          title: 'PlaceHold: lock, test the money, insert the hold',
          lang: 'sql',
          code: `-- PlaceHold(OUTBOUND_PAYMENT, key = payment e1f0c3a2-...3318)
BEGIN;
SELECT 1 FROM accounts
 WHERE account_id = '5f0c2a9e-...081442' FOR NO KEY UPDATE;
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND status = 'OPEN'
     AND posted_balance - held_balance - 120020 >= -credit_limit),
placed AS (
  INSERT INTO pending_holds (hold_id, account_id, source_type,
    source_id, amount, currency, expires_at)
  SELECT 'b61c9a3e-...0417', '5f0c2a9e-...081442',
    'OUTBOUND_PAYMENT', 'e1f0c3a2-...3318', 120020, 'GBP',
    now() + interval '7 days' FROM funded
  ON CONFLICT (source_type, source_id) DO NOTHING
  RETURNING hold_id)
INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
SELECT 'HoldPlaced', hold_id, '5f0c2a9e-...081442', '{...}'
  FROM placed;
COMMIT;  -- once a synchronous standby has the log record
-- posted 842000, held 120020, available 721980`,
          note: 'On the primary, once per payment and per card authorisation. Primary key of accounts for the lock, UNIQUE (source_type, source_id) for the retry. Locks held about 1 to 2 ms. If nothing was placed, look the source up: a row means a retry, no row means a decline.',
        },
        {
          title: 'Capture and post: end the hold, header, entries',
          lang: 'sql',
          code: `BEGIN;   -- account rows first, in account_id order
SELECT 1 FROM accounts
 WHERE account_id IN ('5f0c2a9e-...081442', '1c9d4e2a-...000007',
                      'c2e85b71-...000007')
 ORDER BY account_id FOR NO KEY UPDATE;
WITH done AS (
  UPDATE pending_holds SET status = 'CAPTURED'
   WHERE hold_id = 'b61c9a3e-...0417' AND status = 'ACTIVE'
  RETURNING hold_id),
hdr AS (
  INSERT INTO transactions (transaction_id, idempotency_key,
    transaction_type, reference_id)
  SELECT '7d1f0a52-...900418', 'fps:out:pay_3fK9', 'FPS_OUT',
         hold_id FROM done
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING transaction_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT hdr.transaction_id, v.acct::uuid, v.amt, 'GBP'
  FROM hdr, (VALUES ('5f0c2a9e-...081442', -120020::bigint),
                    ('1c9d4e2a-...000007',  120000::bigint),
                    ('c2e85b71-...000007',      20::bigint))
       AS v(acct, amt);
-- then TransactionPosted into outbox_events, and COMMIT`,
          note: 'Wallet, FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7. 3 rows, or 0 if the hold was not ACTIVE or the key was taken. The sum-to-zero check runs once at COMMIT. After: posted 721980, held 0.',
        },
        {
          title: 'Balance read: posted, held, available',
          lang: 'sql',
          code: `-- GetBalance, always on the primary: one row, no lock
SELECT posted_balance, held_balance, credit_limit, status,
       posted_balance - held_balance + credit_limit AS available
  FROM accounts
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442';
--  before:        842000        0   842000
--  after hold:    842000   120020   721980
--  after capture: 721980        0   721980`,
          note: 'Primary key lookup on a table of under 300 MB, always in memory. A plain SELECT never waits for a row lock. Never on a replica: one that trails could show money already spent.',
        },
        {
          title: 'Hold expiry: due holds, one account at a time',
          lang: 'sql',
          code: `SELECT DISTINCT account_id FROM pending_holds
 WHERE status = 'ACTIVE' AND expires_at < now();

BEGIN;
SELECT 1 FROM accounts
 WHERE account_id = '5f0c2a9e-...081442' FOR NO KEY UPDATE;
WITH ended AS (
  UPDATE pending_holds SET status = 'EXPIRED'
   WHERE hold_id IN (SELECT hold_id FROM pending_holds
                      WHERE account_id = '5f0c2a9e-...081442'
                        AND status = 'ACTIVE' AND expires_at < now()
                      LIMIT 50)
  RETURNING hold_id, account_id)
INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
SELECT 'HoldExpired', hold_id, account_id, '{...}' FROM ended;
COMMIT;`,
          note: 'Every minute, by the workers. Both statements use idx_holds_active_account. The hold trigger takes each amount off held_balance. Statement pages and the cache check run on the replicas: see that panel.',
        },
      ],
      fails: 'The primary dies. A synchronous standby already holds every committed transaction, so it is promoted with nothing lost, provided the old primary is fenced first. Writes to that cluster pause for the failover, and callers retry with the same keys: the table guards make the retries harmless.',
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
      say: "The journal holds settled money and never changes, under a header whose unique idempotency_key refuses a replay. Holds live in their own table. posted_balance and held_balance are caches kept by triggers in the same transaction. The customer's own debits stop at credit_limit; debits the bank must accept may go on to hard_limit, which the CHECK enforces; past that, the customer's receivable. One schema serves debit wallets, overdrafts and credit cards.",
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
      tables: [
        {
          title: 'The same tables, by reference',
          lang: 'text',
          code: `Every copy holds the Ledger DB's tables, row for row, from its
write-ahead log: accounts, pending_holds, transactions,
ledger_entries (by month), outbox_events, account_balances_daily,
account_period_totals, pending_holds_history.
The DDL is on the Ledger DB panel; nothing is defined here.

s1, s2          synchronous standbys in other zones.
                ANY 1 (s1, s2): each commit waits for one.
                Kept for failover, not for reads.
read replicas   asynchronous, milliseconds to seconds behind.
                Read-only. Statements, pending items,
                reconciliation, the parity export and the
                monthly archive export run here.

Never here: a funds check or a balance used to approve money.`,
          note: 'A replica cannot have its own indexes: any index a replica query needs, such as idx_ledger_account_entry, is created on the primary.',
        },
      ],
      queries: [
        {
          title: 'Statement page: newest 50 entries, then the next 50',
          lang: 'sql',
          code: `SELECT e.entry_id, e.amount, e.currency, t.transaction_type,
       t.merchant_name, t.reference_id, e.created_at
  FROM ledger_entries e
  JOIN transactions t USING (transaction_id)
 WHERE e.account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
 ORDER BY e.entry_id DESC
 LIMIT 50;

-- next page: the same, plus
--   AND e.entry_id < 7730512   (the last entry_id seen)`,
          note: 'idx_ledger_account_entry (account_id, entry_id DESC) serves it, one index range per monthly partition. The cursor is entry_id, not created_at, so pages stay stable as new entries arrive.',
        },
        {
          title: 'Pending items, shown above the first page',
          lang: 'sql',
          code: `SELECT hold_id, source_type, source_id, amount, currency,
       created_at, expires_at
  FROM pending_holds
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
   AND status = 'ACTIVE'
 ORDER BY created_at DESC;
-- e.g. b61c...0520  CARD_AUTH  8240 GBP`,
          note: 'The partial index idx_holds_active_account finds them. The app asks the Card service for the merchant name.',
        },
        {
          title: 'Cache check: balances equal journal and holds',
          lang: 'sql',
          code: `SELECT a.account_id, a.posted_balance, a.held_balance
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
-- any row is a broken cache; expect none`,
          note: 'Every few minutes, by reconciliation, for accounts touched since the last watermark. One MVCC snapshot sees a balance, its entries and its holds together. A full re-sum runs weekly.',
        },
        {
          title: 'Nightly parity export: the Core Ledger side',
          lang: 'sql',
          code: `SELECT hold_id, source_id, status FROM pending_holds
 WHERE source_type = 'CARD_AUTH'
   AND created_at < '2026-11-14 00:00+00';
SELECT transaction_id, reference_id, status FROM transactions
 WHERE transaction_type = 'CARD_PURCHASE'
   AND created_at < '2026-11-14 00:00+00';`,
          note: "On a replica of each cluster after the cut-off; reconciliation loads the rows beside the Card service's export. Neither table has an index on these filters: it is a nightly scan, kept off the primary.",
        },
        {
          title: 'Before an export: what the month must add up to',
          lang: 'sql',
          code: `SELECT currency, count(*) AS entries, sum(amount) AS net
  FROM ledger_entries_2025_09 GROUP BY currency;
-- net is 0 in each currency; the files' manifest must match`,
          note: 'Monthly, on a replica, for the month passing 13 months old. Reads one whole partition, about 490 GB a cluster, which is why it is kept off the primary.',
        },
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
      name: 'Ledger workers',
      short: 'Workers',
      tech: 'settle, expire, sweep',
      x: 1052, y: 190, w: 126, h: 56, kind: 'node',
      what: "The Core Ledger's background jobs, run per cluster. The settlement worker reads SettleCardTransaction from Kafka and posts each card settlement. The others look after the system accounts that most payments touch, the holds nobody ended, and the end of each business day. System accounts are named by rail and currency (FPS_CLEARING_GBP, MASTERCARD_DEBIT_CLEARING_GBP, MASTERCARD_CREDIT_CLEARING_GBP, NOSTRO_BOE_GBP, FX_POOL_GBP, FEE_REVENUE_GBP, INTEREST_INCOME_GBP and so on; the owner's STRIPE_CLEARING_GBP would be the clearing account for an acquirer or processor we pay out through), and each busy one is 16 rows, shard_id 0 to 15, with allow_negative TRUE. At the end of each business day the sweep job moves each logical account's 16 rows into its master account with one balanced transaction and writes the day's balances. Every minute the expiry job marks as EXPIRED any ACTIVE hold whose expires_at has passed, one account at a time, which gives the money back to the customer, and emits HoldExpired.",
      why: "Every entry fires the trigger's UPDATE on its account row, and that row stays locked until a synchronously replicated commit, so one row takes one writer at a time: roughly 500 to 1,000 writes a second (an estimate). One cluster at the peak takes about 2,500 payments a second, so a single FPS_CLEARING_GBP row would be past its limit. Holds are the other loose end: a card authorisation the merchant never settles would otherwise keep the customer's money held for ever.",
      built: [
        { name: "Settlement worker", what: "A consumer group on card-settlements, partitioned by account. For each SettleCardTransaction it runs one local transaction: lock the accounts in id order, mark the hold CAPTURED if still ACTIVE (and release nothing if it already EXPIRED), insert the header and its entries, insert TransactionPosted.", why: "The owner's asynchronous settlement path: a clearing file of a million lines becomes a queue the cluster drains at its own rate. A redelivered command finds its idempotency_key taken and posts nothing (checked). It runs the same rules code and database functions as the Ledger API." },
        { name: "Hot accounts", what: "System accounts that nearly every payment of one rail and currency touches: the scheme clearing accounts, the card network clearing accounts, the nostro that incoming payments credit from, the FX pools, fee and interest revenue.", why: "One row takes one writer at a time, about 500 to 1,000 writes a second (an estimate). Customer wallets and cards are touched only by their own payments, so they stay one row each." },
        { name: "16 rows by shard_id", what: "Each logical system account is 16 rows with shard_id 0 to 15; uq_logical_shard makes the pair (logical_account, shard_id) unique. The Ledger API writes to shard_id = hash(transaction_id) % 16.", why: "At 2,500 payments a second on one cluster, about 156 writes a second land on each row, well under one row's estimated limit. If lock waits climb, 16 can go to 32 with nothing else changing." },
        { name: "End-of-day sweep", what: "Once a day, per logical account, one balanced transaction locks the master (its own logical account, such as FEE_REVENUE_GBP_MASTER) and the 16 rows in account_id order, debits each row by its posted balance and credits the master with the total. Its header has transaction_type SWEEP and the idempotency_key sweep:<account>:<business date>.", why: "The owner's choice. Every entry stays synchronous and every balance exact as a sum, so the sweep is bookkeeping, not a safety need: the rows may go negative anyway. Reports sum the master and its rows. A rerun of the same date finds the header already there and does nothing." },
        { name: "Hold expiry job", what: "Every minute, one account per transaction: lock the account row, then mark up to 50 of its due ACTIVE holds EXPIRED, through the partial index on (account_id, expires_at) WHERE status = 'ACTIVE', with one HoldExpired row in outbox_events for each. The hold trigger takes each amount off held_balance.", why: "Account first, as every other path does, so it cannot deadlock with a capture or a repayment (checked: racing repayments for 3 seconds, it expired 4,000 holds with no deadlock and no lock timeout). An expired hold cannot then be captured: a late settlement posts as a force-post, with no second release. The Card service reads HoldExpired and marks the authorisation EXPIRED." },
        { name: "Business date and end of day", what: "The owner's header has no value date: value dates live with the service that owns the payment, and business dates in account_balances_daily. A cut-off calendar in Europe/London says when one business date ends. After the cut-off a job writes account_balances_daily (account, business date, posted, held).", why: "Statements, interest, the Single Customer View and reconciliation all read that table, not the live rows. End of day is a date, not a stop: payments carry on, dated the next business day." },
      ],
      numbers: [
        { text: 'One cluster at peak: about 156 writes a second on each row of a split system account.', from: "10,000 payments a second at peak ÷ 4 clusters = 2,500 a cluster. A bank payment writes FPS_CLEARING_GBP once and FEE_REVENUE_GBP once, at the capture; the hold touches no system account. Worst case, every payment uses the same rail: 2,500 ÷ 16 rows = about 156 writes a second on a row, against 500 to 1,000 estimated for one row. Unsplit, the row would take 2,500." },
        { text: "A master account is up to a day behind; the sum of master plus its 16 rows is always exact.", from: 'The sweep runs once a day, so the master misses up to a day of entries. The sum is exact because every entry is written synchronously, in its own transaction, to one of the 16 rows.' },
        { text: 'The sweep is small: a few dozen transactions a day per cluster, each of 17 entries at most.', from: "About 30 logical system accounts (assumption) × 1 sweep a day = 30 transactions. Each debits up to 16 rows and credits the master once: 17 entries." },
      ],
      fails: 'If the settlement worker stops, card settlements wait in Kafka and holds stay ACTIVE: lag on card-settlements is watched, and a hold that expires first is settled later as a force-post. If the sweep stops, nothing is wrong, only untidy: balances sit in the 16 rows, and reports read the master plus its rows. If the expiry job stops, held money is not released, and customers see less available than they should: an alert on the oldest overdue ACTIVE hold catches it. If the end-of-day job stops, statements and interest wait for it; payments do not.',
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
      say: 'The workers are the Core Ledger\'s asynchronous side: card settlements from Kafka, hold expiry, and the sweeps. Hot accounts are the classic trap: every entry locks its account row through the trigger, so I name system accounts by rail and currency, split each into 16 rows by shard_id with allow_negative TRUE, and sweep them into masters at the end of the day.',
      see: [{ id: 'consistent-hashing', label: 'Consistent hash ring' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'relay',
      name: 'CDC relay',
      tech: 'Debezium',
      x: 1030, y: 350, w: 100, h: 56, kind: 'node',
      what: "Reads committed outbox_events rows from the database's write-ahead log through a replication slot, and publishes each as an event on the ledger-events topic, keyed by account. There is one outbox row per customer account a transaction touches. The Card service runs its own relay the same way for its own outbox.",
      why: 'Writing to the database and then to Kafka is two writes with no transaction around them: a crash between them loses an event or announces a payment that rolled back. The outbox row commits with the hold or the entries, and the relay publishes only what committed, in commit order. This is the owner\'s rule: outbox, not two-phase commit.',
      built: [
        { name: "Change data capture (CDC)", what: "Reading committed changes from a database's own log, in commit order, and turning each into an event.", why: "Polling the outbox table instead can miss or reorder rows from concurrent commits, and adds queries to the primary." },
        { name: "Debezium", what: "An open-source change data capture tool. It connects to a database's change log and emits every committed row change as an event, with the row before and after and its log position. It is commonly run alongside Kafka.", why: "It already does the hard parts: reading Postgres's log through logical decoding, keeping its place in a replication slot, and resuming after a restart. The cost is a connector to run and upgrade." },
        { name: "Logical decoding and a replication slot", what: "Logical decoding is Postgres turning its write-ahead log back into row changes for an outside reader. A replication slot is the bookmark for one reader: it records how far it has read and keeps the log until then.", why: "Only committed rows arrive, in commit order, and a restarted relay resumes where it left off, repeating at most a little. The catch: a stuck relay makes the slot hold log on the primary's disk, so the slot is watched. The slot is a failover slot, and synchronized_standby_slots holds decoding back until the standbys have the commit (PostgreSQL 17 and later; not run here)." },
      ],
      numbers: [
        { text: 'About 2,000 events a second on average; assume about 1 KB each: about 2 MB a second, 20 MB at peak.', from: "Two events per bank payment: HoldPlaced (from the hold) and TransactionPosted (from the capture, carrying the hold it ended); the payment touches one customer account. 1,000 payments a second × 2 = 2,000 events a second × an assumed 1 KB = about 2 MB a second. At the 10,000 a second peak, 20,000 events and about 20 MB a second. A rejected payment makes HoldPlaced and HoldVoided; a transfer between two customers makes a TransactionPosted for each." },
      ],
      fails: "If the relay or Kafka is down, the ledger carries on and events wait in the log. Watch the replication slot: it holds write-ahead log on the primary's disk until the relay catches up. After a failover the relay resumes from the failover slot on the new primary.",
      alternatives: [
        {
          name: 'Outbox table read by log-based CDC', chosen: true, good: 'Atomic with the money, in commit order, no polling load.', cost: 'A connector to run, and a replication slot to watch.',
          what: 'Each ledger function writes an outbox_events row in the same transaction as the hold or the entries. Debezium reads committed rows from the write-ahead log through a replication slot and publishes them to ledger-events in commit order.',
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
      name: 'Kafka',
      tech: 'two topics',
      x: 750, y: 566, w: 1040, h: 48, kind: 'queue',
      what: "Two topics between the services. ledger-events: one event per outbox_events row (HoldPlaced, HoldVoided, HoldExpired, TransactionPosted) with ids, accounts, signed amounts per currency, the header's type and reference, and the event_id; read by the Card service, Billing, notifications, fraud, the warehouse and reconciliation. card-settlements: SettleCardTransaction from the Card service's outbox, read by the Core Ledger's settlement worker. Both keyed by account, so each account's messages stay in order.",
      why: 'This is how the services stay in step without a distributed transaction: each writes its own database and its own outbox, and the others read at their own pace. A log lets each read at its own pace and replay, without querying the ledger. The same Kafka (or SQS in front of the Ledger API) also absorbs spikes: payroll runs and payouts are queued and fed to the ledger at the rate it can take.',
      built: [
        { name: "Kafka", what: "A distributed log service. Producers append messages to a topic, split into partitions; each reader keeps its own position and can re-read from any point the topic still keeps.", why: "Each consumer reads at its own pace and can replay after a bug. A queue such as SQS deletes each message once read, so no replay. About 3 MB a second on average is a light load for it." },
        { name: "ledger-events", what: "The one topic the Core Ledger publishes to, with hold and transaction events together.", why: "One topic, not one per event type, so a capture is never read before the hold it ends." },
        { name: "card-settlements", what: "The Card service's topic: one SettleCardTransaction per clearing line, published from its own outbox.", why: "A clearing file arrives in bulk; the topic lets the settlement worker take it at the rate the cluster can bear, and replay it after a bug." },
        { name: "Keyed by account", what: "Each event's key is the account id. Kafka sends every message with the same key to the same partition and keeps a partition in order.", why: "All of one account's events arrive in commit order, which is all consumers need. A partition holding a busy account can lag behind the others." },
        { name: "Queues as shock absorbers", what: "Work that can wait (payroll runs, payouts, billing's daily interest accruals) goes onto a queue, and a worker feeds it to the Ledger API at a steady rate.", why: "The owner's rule for a spike: the database takes what it can within its timeouts and the queue holds the rest, instead of thousands of writers timing out together. Card authorisations cannot queue; they need an answer in seconds." },
      ],
      fails: "Delivery is at least once. A relay restart can publish an event twice, so consumers drop anything at or below the last event_id they processed for that account. Per account, event_id is taken under the account lock, so it rises in the order that account's transactions committed; it is a value the ledger owns, not a property of one server's log. A repeated SettleCardTransaction is harmless for another reason: its idempotency_key.",
      alternatives: [
        {
          name: 'Kafka topic keyed by account', chosen: true, good: 'Ordered per account, replayable, many readers.', cost: 'Partitions and consumer lag to watch.',
          what: "One topic, ledger-events, keyed by account, so each account's events land in one partition and keep their order. Notifications, fraud, billing, the warehouse and reconciliation each read it as their own consumer group.",
          pros: ['Ordered per account.', 'Replayable: a consumer that falls a day behind catches up from the log.', 'Many readers, each at its own pace.', 'About 3 MB a second on average is a light load for Kafka.'],
          cons: ['Partitions and consumer lag to watch.', 'At least once: consumers must drop repeats by event_id.', 'A Kafka cluster to run, or to pay someone to run.'],
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
      say: 'Kafka is how the services talk without a distributed transaction: ledger-events tells the rest of the bank what moved, and card-settlements carries the Card service\'s commands in. Neither moves money by itself; each side applies a message in its own local transaction.',
      see: [{ id: 'append-log', label: 'Append-only log' }, { id: 'queue', label: 'Queue' }],
    },
    {
      id: 'consumers',
      name: 'Consumers',
      tech: 'notify, fraud, BI',
      x: 900, y: 458, w: 140, h: 52, kind: 'shared',
      what: 'The other services that react to money moving: push notifications, fraud models, accounting exports and the data warehouse. The Card service and Billing read the same topic too, each as its own consumer group, drawn on their own lines.',
      why: 'They must never slow a payment down. They read events at their own pace, and a slow one builds lag, not latency.',
      built: [
        { name: "Notifications", what: "The service that sends the owner a push such as \"£1,200.00 paid, reference INV 3318. Fee 20p.\" within seconds, or \"Card payment of $100.00 pending\" on a hold.", why: "It reads ledger-events instead of being called by the ledger, so a slow notification service builds lag, not payment latency. It skips any event at or below the last event_id it applied for that account." },
        { name: "Fraud models", what: "Services that score money movements for signs of fraud after the fact, alongside the checks made before a payment.", why: "They need every movement, in order per account, without querying the ledger, so they read the topic." },
        { name: "BI (business intelligence)", what: "The data warehouse and accounting exports that finance and analysts use, loaded in batches.", why: "Batch loads from the topic put no load on the ledger's databases, and a loading bug can be fixed and replayed from the log." },
      ],
      fails: 'A consumer falls a day behind: it catches up from the log. A consumer processes an event twice: it checks the event_id it last applied for that account.',
      alternatives: [
        {
          name: 'Read events from the topic', chosen: true, good: 'Decoupled and replayable.', cost: 'Eventually consistent: a notification can arrive a moment after the balance changes.',
          what: 'Each service reads ledger-events as its own consumer group: notifications within seconds, the warehouse in batches. Each keeps the last event_id it applied per account and skips anything older.',
          pros: ['Decoupled: a slow consumer builds lag, not payment latency.', 'Replayable after a bug or an outage.', 'A new consumer needs no change to the ledger.'],
          cons: ['Eventually consistent.', 'Every consumer must handle repeats.', 'Lag per consumer group to watch and alert on.'],
        },
        {
          name: 'Call each one from the ledger', good: 'Immediate.', cost: 'The ledger waits on every downstream service and fails when any of them does.',
          what: 'After each commit, the ledger calls the notification service, fraud, the Card service, Billing and the rest directly.',
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
      say: 'Downstream is eventually consistent by design. Only the ledger itself is strict.',
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
        { name: "Nightly parity job across services", what: "On replicas, after a cut-off: the Card service's APPROVED authorisations must match the Core Ledger's ACTIVE CARD_AUTH holds one to one, and its CLEARED authorisations must match POSTED transactions, joined through the hold (card_authorisations.hold_id = transactions.reference_id). The tables are in two databases, so the job exports keys from each replica and compares them in its own database. Each mismatch is a break.", why: "The owner's self-healing reconciliation. With no transaction across services, a crash between PlaceHold and APPROVED, or a lost event, can leave the two sides apart. Retries heal most of it within seconds; this finds what they missed. Breaks are aged first, so a hold that expired an hour ago and whose HoldExpired is still in flight is not raised." },
        { name: "account_period_totals", what: "This design's choice for checking after archive: before a month's partition is detached, each account's total for that month is written to account_period_totals (account_id, period, total).", why: "Once old partitions are gone, SUM(amount) over the hot table is no longer the posted balance. Archived totals plus the sum of hot entries is." },
        { name: "Rebuilding a balance", what: "If a cache is ever found wrong, the guard refuses any direct fix. Rebuilding is a reviewed break-glass change: in one transaction, SET LOCAL session_replication_role = replica so the guard does not fire, recompute posted_balance from period totals and entries and held_balance from ACTIVE holds, commit, and record who ran it and why.", why: "The guard is there to stop exactly this kind of hand edit, so the bypass must be deliberate, rare and audited. The same setting also switches off the append-only triggers and foreign key checks for that transaction, so the change touches accounts only and is reviewed line by line." },
        { name: "External reconciliation", what: "At each business day's cut-off, each nostro's balance is matched against the closing balance on the bank's statement for that account, and each clearing account is checked back to zero after its settlement cycle, using the schemes' and card networks' settlement reports.", why: "Only an independent record catches a wrong amount, a lost scheme message or a bank error. A clearing account left with a balance after its cycle is money that left one system and never arrived in the next." },
        { name: "Breaks", what: "A difference nothing explains, raised with an owner, an amount and evidence, and closed by a correcting transaction through the Ledger API after a second person approves. Its idempotency_key is made from the break id; its reference_id, or a REVERSAL, names a transaction it corrects.", why: "The fix uses the same rules as every payment, and approving twice posts once." },
      ],
      numbers: [
        { text: "Monzo's example: two £5 payments in the ledger, £15 arrived in settlement, a £5 break.", from: "Monzo's worked example from 'Processing payments safely at scale', cited on the page: £5 + £5 = £10 in the ledger; £15 in settlement less £10 = £5 that nothing explains." },
        { text: 'Stripe reports more than 99.9999 per cent of money movement explained, with clearing accounts expected to sit at zero.', from: "Not a sum. Stripe's own figure, from its ledger post cited on the page; it has not been checked here." },
      ],
      tables: [
        {
          title: 'Running totals, files and breaks',
          lang: 'sql',
          code: `CREATE TABLE seen_txns (                  -- dedupe for events
    transaction_id UUID PRIMARY KEY,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE clearing_totals (
    account VARCHAR(50) NOT NULL,   -- logical: FPS_CLEARING_GBP
    currency CHAR(3) NOT NULL,
    day DATE NOT NULL,
    total BIGINT NOT NULL DEFAULT 0,
    txns BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account, currency, day));
CREATE TABLE loaded_files (
    sha256 CHAR(64) PRIMARY KEY,    -- a file is loaded once
    path TEXT NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE breaks (
    break_id VARCHAR(20) PRIMARY KEY,  -- brk_1127
    business_date DATE NOT NULL,
    account VARCHAR(50) NOT NULL,
    currency CHAR(3) NOT NULL,
    amount BIGINT NOT NULL,            -- -500
    owner VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    correction_txn_id UUID);  -- posted with key break:<break_id>`,
          note: "Reconciliation's own database, not the ledger's. seen_txns and clearing_totals are the tables on the ledger totals line; the other two are this panel's sketch of what the page describes. seen_txns would be trimmed after some days (not shown).",
        },
        {
          title: 'The parity job: both sides, loaded nightly',
          lang: 'sql',
          code: `CREATE TABLE card_auths (           -- from the Card service
    auth_id UUID PRIMARY KEY,
    hold_id UUID,
    status VARCHAR(20) NOT NULL);
CREATE TABLE ledger_holds (         -- from every ledger cluster
    hold_id UUID PRIMARY KEY,
    source_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL);
CREATE TABLE ledger_txns (
    transaction_id UUID PRIMARY KEY,
    reference_id UUID,              -- the hold, for a card
    status VARCHAR(20) NOT NULL);
CREATE INDEX ON ledger_txns (reference_id);`,
          note: 'Emptied and reloaded each night from the replicas\' exports up to one cut-off. The names are the page\'s; the columns are what the exports select.',
        },
      ],
      queries: [
        {
          title: 'An event: count it once, add it to the day',
          lang: 'sql',
          code: `BEGIN;
INSERT INTO seen_txns (transaction_id)
VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900418')
ON CONFLICT (transaction_id) DO NOTHING;
-- 0 rows: a repeat; ROLLBACK and skip
INSERT INTO clearing_totals AS c
  (account, currency, day, total, txns)
VALUES ('FPS_CLEARING_GBP', 'GBP', '2026-11-12', 120000, 1)
ON CONFLICT (account, currency, day) DO UPDATE
   SET total = c.total + EXCLUDED.total, txns = c.txns + 1;
COMMIT;`,
          note: "Per TransactionPosted that touches a clearing account, about 1,000 a second at the stress load. The same as the line's UPDATE, written as an upsert so the day's first event makes the row.",
        },
        {
          title: 'A file: load it once',
          lang: 'sql',
          code: `INSERT INTO loaded_files (sha256, path)
VALUES ('3b7d...91fe',
        '/outbound/2026-11-12/fps-settlement.csv')
ON CONFLICT (sha256) DO NOTHING;
-- 0 rows: already loaded; skip the file`,
          note: 'Daily, per file. The hash shown is shortened.',
        },
        {
          title: 'At the cut-off: compare, and raise a break',
          lang: 'sql',
          code: `-- the scheme says it settled 41380750p for 2026-11-12
INSERT INTO breaks (break_id, business_date, account,
  currency, amount)
SELECT 'brk_1127', day, account, currency, total - 41380750
  FROM clearing_totals
 WHERE account = 'FPS_CLEARING_GBP' AND currency = 'GBP'
   AND day = '2026-11-12' AND total <> 41380750;
-- ledger 41380250 - scheme 41380750 = -500: one break`,
          note: "Once per account per business date, by primary key. clearing_totals here counts the day's captures only. The break is closed by a correcting transaction posted with the key break:brk_1127.",
        },
        {
          title: 'Parity: approved with no hold, cleared with no post',
          lang: 'sql',
          code: `SELECT a.auth_id FROM card_auths a
  LEFT JOIN ledger_holds h ON h.hold_id = a.hold_id
                          AND h.status = 'ACTIVE'
 WHERE a.status = 'APPROVED' AND h.hold_id IS NULL;
SELECT a.auth_id FROM card_auths a
  LEFT JOIN ledger_txns t ON t.reference_id = a.hold_id
                         AND t.status = 'POSTED'
 WHERE a.status = 'CLEARED' AND t.transaction_id IS NULL;
-- and both ways round; each row is a break, aged before raising`,
          note: 'Nightly. Primary key of ledger_holds and the reference_id index. A hold expired an hour ago whose HoldExpired is still in flight heals by itself, so breaks are aged first.',
        },
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
      say: 'Correctness is proved, not assumed. The caches must equal the journal and the holds every few minutes, each currency must sum to zero, every nostro must equal its statement at the cut-off, every clearing account must drain to zero, and every night the Card service and the Core Ledger must agree one to one.',
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
      x: 700, y: 470, w: 130, h: 64, kind: 'store',
      what: "Old monthly partitions of ledger_entries, exported from a replica as Parquet files with a checksum per file; 13 months stay hot. Holds are not partitioned: an archive job copies ended holds placed more than 90 days ago to pending_holds_history, a table partitioned by month, and deletes them. The accounts table and each account's total for every archived month of entries (account_period_totals) stay in the database.",
      why: "Entries are never deleted, so the journal only grows; partitioning it by date lets an old month be exported and detached in one step. pending_holds gains about 86 million rows a day, but it must keep UNIQUE (source_type, source_id), which a partitioned table cannot, so it is trimmed by deletes instead. Because the balances live in accounts, archiving never slows a funds check. Partitioning by date keeps one cluster's tables small; splitting businesses across clusters spreads the writes. They are separate things.",
      built: [
        { name: "Object store", what: "A storage service that keeps files (objects) by name and serves them over HTTP. It is not a database: it stores and returns whole files.", why: "About 24 TB of entries a year across all clusters, plus headers and hold history. Moving old months into files keeps each cluster near 8.4 TB in the first year, plus the headers' growth of about 1.6 TB a cluster a year, and is cheap to keep for years." },
        { name: "Parquet", what: "An open file format that stores a table by column, compressed, so a reader can fetch only the columns it needs.", why: "The archive is read rarely and in bulk, which suits a compact column file. A manifest beside the files records the row count, the sums per currency and a checksum per file." },
        { name: "Monthly partitions of the journal", what: "ledger_entries split by created_at into one partition per month. A partition can be detached from the table, without deleting rows one by one.", why: "With CONCURRENTLY a detach takes only a SHARE UPDATE EXCLUSIVE lock on the parent, so inserts carry on; it cannot run inside a transaction block. The price: every unique key must include created_at. created_at defaults to now(), so a replay always carries a different created_at, and UNIQUE (transaction_id, account_id, created_at) never fires, not even within one month (a reviewer inserted the same pair twice in one month). The guard is the header's UNIQUE (idempotency_key). The owner's spec says date-partitioned transactions and ledger_entries; this page partitions ledger_entries only, because a partitioned header could keep neither its primary key nor its unique key." },
        { name: "Hold archive job", what: "Daily, in batches: copy holds that are no longer ACTIVE and were placed more than 90 days ago (no hold lives that long) into pending_holds_history (month-partitioned, no uniqueness needed), then delete them. The hold trigger allows DELETE only for a hold that is not ACTIVE (checked), and only the archive role has the DELETE grant.", why: "pending_holds keeps its PRIMARY KEY and UNIQUE (source_type, source_id), so both stay real guards. The cost: each delete leaves a dead row for vacuum, about 86 million a day at the stress load." },
        { name: "Headers", what: "transactions is never deleted and never partitioned. When a month of entries is detached, its headers stay on the cluster as the index of what was ever posted and the lasting duplicate guard.", why: "The header is immutable, and entries and reversals point at it, so deleting it would fight its own guards. The cost: about 200 bytes a row with its unique indexes (an estimate), 86 million rows a day at the stress load, about 17 GB a day or 6.3 TB a year that never shrinks; at the reasoned baseline, about 0.6 to 1.6 TB a year." },
        { name: "account_period_totals", what: "One row per account per archived month of entries: account_id, period, total. Written from the partition before it is detached.", why: "This design's choice. It lets reconciliation check a posted balance as archived totals plus hot entries once old rows have left the database." },
      ],
      tables: [
        {
          title: 'Bucket and object layout',
          lang: 'text',
          code: `bucket    ledger-archive
path      cluster-<n>/entries/<yyyy-mm>/
            part-0000.parquet
            part-0001.parquet ...   one month of one cluster
            manifest.json           written last
columns   entry_id, transaction_id, account_id, amount,
          currency, created_at: the partition's own columns
sort      by account_id, then entry_id, inside each file, so a
          reader skips row groups by their min and max account_id

not here  headers: transactions stays on the cluster for good
          ended holds: pending_holds_history, in the database
          per-account month totals: account_period_totals, too`,
          note: "The path and the manifest are the page's. The sort order is this panel's assumption; without it, reading one account means reading the whole month.",
        },
        {
          title: 'manifest.json for one month',
          lang: 'json',
          code: `{
  "partition": "ledger_entries_2025_09",
  "entries": 2015331050,
  "net": { "GBP": 0, "EUR": 0, "USD": 0 },
  "files": [
    { "name": "part-0000.parquet", "sha256": "9c1e...e04a" }
  ]
}`,
          note: 'The row count, the net per currency and a checksum per file: enough to check the archive later without the database.',
        },
      ],
      queries: [
        {
          title: 'Write a month, manifest last',
          lang: 'text',
          code: `aws s3 cp part-0000.parquet \\
  s3://ledger-archive/cluster-2/entries/2025-09/part-0000.parquet
  ... one per file ...
aws s3 cp manifest.json \\
  s3://ledger-archive/cluster-2/entries/2025-09/manifest.json

then, only if the files' count and net match the partition:
  ALTER TABLE ledger_entries
    DETACH PARTITION ledger_entries_2025_09 CONCURRENTLY;`,
          note: 'Monthly, per cluster. A month with no manifest is unfinished: a reader treats it as missing. The detach is on the old months line.',
        },
        {
          title: "Read one account's month back",
          lang: 'sql',
          code: `-- DuckDB, reading the files where they lie
SELECT entry_id, transaction_id, amount, currency, created_at
  FROM read_parquet(
    's3://ledger-archive/cluster-2/entries/2025-09/*.parquet')
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
 ORDER BY entry_id DESC;

-- then the headers, still on the cluster (a replica)
SELECT transaction_id, transaction_type, merchant_name,
       reference_id
  FROM transactions
 WHERE transaction_id = ANY ($1);   -- the ids from above`,
          note: 'Rare: an old statement, an audit or a dispute. The account filter skips row groups whose account_id range cannot match. DuckDB is one choice of reader; any Parquet engine works.',
        },
        {
          title: 'Prove a month without the database',
          lang: 'sql',
          code: `-- DuckDB: the month against its manifest
SELECT currency, count(*) AS entries, sum(amount) AS net
  FROM read_parquet(
    's3://ledger-archive/cluster-2/entries/2025-09/*.parquet')
 GROUP BY currency;            -- net 0; counts add to 2015331050

-- and per account against account_period_totals for '2025-09'
SELECT account_id, sum(amount) AS total
  FROM read_parquet(
    's3://ledger-archive/cluster-2/entries/2025-09/*.parquet')
 GROUP BY account_id;`,
          note: 'Run before the detach and again on audit. A balance rebuilt from the start is the archived period totals plus the hot entries.',
        },
      ],
      fails: "An export is incomplete. The partition is detached only after the file's row count and sums match the partition's. The hold archive job copies before it deletes in the same transaction, and the trigger refuses to delete an ACTIVE hold.",
      alternatives: [
        {
          name: 'Journal partitioned by month and detached; holds trimmed by an archive job', chosen: true, good: 'Cheap storage for the journal, and the hold id stays a real primary key.', cost: 'Old statements are read from files; deleted holds leave dead rows for vacuum.',
          what: 'ledger_entries is partitioned by month on created_at; each month the oldest partition past 13 months is exported from a replica to Parquet with counts and sums, then detached on the primary. pending_holds stays the owner\'s table; ended holds older than 90 days move to pending_holds_history.',
          pros: ['Detaching a journal partition is a metadata change, not a slow delete.', 'UNIQUE (source_type, source_id) stays a real key, so ON CONFLICT works and a source cannot hold twice.', 'Keeps 13 months of journal hot instead of all of it; only the headers keep growing, about 6 TB a year.', 'Recorded counts and sums prove each file is complete.'],
          cons: ['Old statements are read from files, more slowly.', 'About 86 million hold deletes a day, each a dead row for vacuum.', 'The journal\'s unique key guards nothing on its own once partitioned; the header table does that job.', 'Partitioning the journal must be there from day one.'],
        },
        {
          name: 'Partition the header by date too (the owner\'s spec)', good: 'Old headers leave with their entries: no table that grows for ever.', cost: 'The header could keep neither PRIMARY KEY (transaction_id) nor UNIQUE (idempotency_key), so the lasting guard is gone.',
          what: 'transactions is partitioned by created_at like ledger_entries, and old months are detached and archived together.',
          pros: ['Headers stop growing without bound, about 6 TB a year at the stress load.', 'Entries and headers archive as one unit.'],
          cons: ['Every unique key must include created_at, which differs on every insert, so a replayed key inserts again.', 'The guard would hold only by luck of timing; a redelivered clearing could post twice.', 'It lost on the guard.'],
        },
        {
          name: 'Partition holds by month too, and drop old months', good: 'No deletes and no vacuum: an old month of holds is detached and dropped.', cost: 'Its keys must include created_at, which guards nothing, and ON CONFLICT (source_type, source_id) stops working.',
          what: 'An earlier version of this page. pending_holds is partitioned by created_at like the journal, and a month with no ACTIVE hold left is exported, detached and dropped.',
          pros: ['Dropping a month is a metadata change.', 'No dead rows from 86 million deletes a day.'],
          cons: ['A partitioned table needs created_at in its unique keys, and created_at differs on every insert, so the same source inserts twice.', 'ON CONFLICT on the old key errors on such a table (42P10, checked by two reviewers for hold_id).', 'It lost on the key: UNIQUE (source_type, source_id) is the hold\'s own guard.'],
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
      say: 'Partition the journal by date from day one, so archiving it is a detach, not a delete, and say plainly that its unique key then guards nothing: the header does. Keep the header and the holds unpartitioned so their unique keys stay guards, and trim holds with an archive job.',
      see: [{ id: 'column-store', label: 'Column store (Parquet)' }, { id: 'partitioning', label: 'Partitioning' }],
    },
  ],

  flows: [
    {
      id: 'pay', from: 'client', to: 'api', d: 'M122,200 H230', label: 'pay £1,200',
      mode: 'external', via: 'HTTPS', chip: 0.5,
      how: 'POST /payments with an Idempotency-Key header, the payee, the amount in minor units and the currency. Balance, statement, repayment and payroll requests use the same connection.',
      delivery: 'The client retries on a timeout with the same key. The Banking API finds k7 on its payment record and returns that payment, never a second one.',
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
and body, read from the payment record. No second payment.

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
      how: 'The payment message goes to Faster Payments, directly or through a sponsor bank, with a payment identifier that stays the same on every resend. Card networks talk to the Card service the same way, in the other direction: they ask, and the bank answers.',
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
       Card service -> Ledger API: PlaceHold
       8000p + 3% buffer = 8240p
       -> hold ...0520 ACTIVE on the GBP wallet; approve

day 3  clearing: USD 100.00 billed at GBP 79.00 = 7900p
       non-sterling transaction fee 1% = 79p
       Card service -> SettleCardTransaction -> Kafka
       -> settlement worker: 3 entries, all GBP; hold CAPTURED;
          261p free again

or     no clearing by expires_at -> hold EXPIRED
or     clearing with no live hold -> force-post`,
          note: 'Amounts, the buffer and the fee are illustrative. The bank never quotes a rate here: the network converts, and the fee is the bank\'s FX income (a reviewer\'s reasoning, not checked against scheme rules).',
        },
      ],
    },
    {
      id: 'post', from: 'api', to: 'ledger', d: 'M390,200 H485', label: 'hold, capture',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: "PlaceHold with source_type OUTBOUND_PAYMENT (or PAYROLL_BATCH) and idempotency_key = the payment's id, the account, the amount and currency and an expiry; later Capture naming that hold with the transaction id, an idempotency key and the signed entries, or VoidHold. Incoming payments, repayments and corrections use Post. Reads use GetBalance and ListEntries. The Card service and Billing call the same service the same way.",
      delivery: "Safe to repeat: a hold is unique per (source_type, source_id), and a header per idempotency_key, so a repeated call places or posts nothing new and the ledger returns what is already there. A decline is not stored by the ledger; the Banking API records it on the payment.",
      alts: ['REST with an Idempotency-Key header.', 'A command topic, which turns a synchronous "is there enough money?" into an asynchronous one.'],
      ways: [
        { name: 'gRPC', chosen: true, what: 'The Banking API calls PlaceHold, then Capture or VoidHold, on the Ledger API, each keyed by the payment and under a deadline. Reads use GetBalance and ListEntries.', pros: ['A typed contract, with client and server code generated from it.', 'Synchronous: the API learns at once whether the funds were held.', 'A deadline on each call, so a slow ledger fails fast.'], cons: ['Harder to call by hand while debugging than REST.', 'Needs load balancers and proxies that handle long-lived HTTP/2 connections.'] },
        { name: 'REST with an Idempotency-Key header', what: 'The same calls as JSON over HTTPS, such as POST /holds with the payment id as the key. The same guards apply.', pros: ['Easy to call by hand and read in logs.', 'The same idempotency scheme as the public API.'], cons: ['No generated, typed contract unless one is added.', 'JSON costs a little more to send and parse; unlikely to matter here.'] },
        { name: 'A command topic', what: 'The caller writes a command to a topic and the ledger applies it, replying on another topic. This design does use one for card settlements, which can wait; not for holds.', pros: ['Bursts queue instead of failing.', 'One consumer per partition gives a single writer per account.'], cons: ['"Is there enough money?" turns asynchronous, but a card authorisation needs an answer in seconds.', 'Matching replies to requests, and timing them out, is extra code.'] },
      ],
      reply: {
        id: 'result', label: 'result',
        how: "The hold or transaction id and the account's posted, held and available figures afterwards; or INSUFFICIENT_FUNDS, ACCOUNT_NOT_OPEN, HOLD_NOT_ACTIVE or TIMEOUT.",
        delivery: 'The same hold or transaction for every repeat of the same key. A decline is evaluated afresh on a retry; the caller only retries when it never got the first answer.',
      },
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `service Ledger {
  rpc PlaceHold(HoldRequest) returns (Result);    // pending_holds
  rpc Capture(CaptureRequest) returns (Result);   // hold -> entries
  rpc VoidHold(VoidRequest) returns (Result);     // hold ends
  rpc Post(PostRequest) returns (Result);         // entries, no hold
}
message HoldRequest {
  string source_type = 1;  // OUTBOUND_PAYMENT, CARD_AUTH, ...
  string idempotency_key = 2;  // the source's id: source_id
  string hold_id = 3; string account_id = 4;
  int64 amount = 5; string currency = 6; int64 expires_in_s = 7; }
message Entry {  // account_id, or a logical account to split
  string account = 1; int64 amount = 2; string currency = 3; }
message Header {  // the owner's columns; made by the caller
  string transaction_id = 1; string idempotency_key = 2;
  string transaction_type = 3; string reference_id = 4;
  string merchant_name = 5; string merchant_category_code = 6; }
message CaptureRequest { string hold_id = 1; Header header = 2;
  repeated Entry entries = 3; }  // sum to zero per currency
message VoidRequest { string source_type = 1;
  string idempotency_key = 2; }
message PostRequest { Header header = 1; repeated Entry entries = 2; }
message Result { string id = 1; string status = 2;
  int64 posted = 3; int64 held = 4; int64 available = 5; }`,
          note: 'GetBalance, ListEntries, the FX fields and the caller\'s identity are left out to keep it short. status is HELD, POSTED, VOIDED, INSUFFICIENT_FUNDS, ACCOUNT_NOT_OPEN, HOLD_NOT_ACTIVE or TIMEOUT. Payment state (PENDING, SETTLED, FAILED) lives on the Banking API\'s payment record.',
        },
        {
          title: 'Example call: PlaceHold, then the retry',
          lang: 'text',
          code: `PlaceHold
{ "source_type": "OUTBOUND_PAYMENT",
  "idempotency_key": "e1f0c3a2-7d55-4c18-b2a9-000000003318",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000417",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "amount": 120020, "currency": "GBP", "expires_in_s": 604800 }
-> { "id": "b61c9a3e-...0417", "status": "HELD",
     "posted": 842000, "held": 120020, "available": 721980 }

A recovery worker repeats the call with the same payment id
-> the same reply: the hold already there; nothing new placed`,
          note: "604800 seconds is 7 days. The idempotency key is the payment's own id (pay_3fK9 is its public name), so a repeat finds UNIQUE (source_type, source_id) taken.",
        },
        {
          title: 'Example call: Capture, and two refusals',
          lang: 'text',
          code: `Capture
{ "hold_id": "b61c9a3e-...0417",
  "header": { "transaction_id": "7d1f0a52-...900418",
    "idempotency_key": "fps:out:pay_3fK9",
    "transaction_type": "FPS_OUT",
    "reference_id": "b61c9a3e-...0417" },
  "entries": [
    { "account": "5f0c2a9e-...081442", "amount": -120020,
      "currency": "GBP" },
    { "account": "FPS_CLEARING_GBP", "amount": 120000,
      "currency": "GBP" },
    { "account": "FEE_REVENUE_GBP", "amount": 20,
      "currency": "GBP" } ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
     "status": "POSTED", "posted": 721980, "held": 0,
     "available": 721980 }

Had the wallet held less:  PlaceHold -> INSUFFICIENT_FUNDS
Had the hold expired:      Capture -> HOLD_NOT_ACTIVE`,
          note: "The Banking API made the transaction id as a UUIDv5 of its client id and the key; ...900418 stands for it. The Ledger API turned FPS_CLEARING_GBP and FEE_REVENUE_GBP into their shard 7 rows, from hash(transaction_id) % 16. \"INV 3318\" and the value date stay on the payment record.",
        },
      ],
    },
    {
      id: 'txn', from: 'ledger', to: 'db', d: 'M615,200 H700', label: 'one call',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'One call to a small function per write, as the ledger_writer role, whose timeouts are set on the role. PlaceHold: lock the account with FOR NO KEY UPDATE, insert the hold only if the account is OPEN and posted - held - amount >= -credit_limit, ON CONFLICT (source_type, source_id) DO NOTHING, and insert HoldPlaced into outbox_events, in one local transaction. Capture and Post: lock the account rows in account_id order, then one statement that ends the hold (for a capture), inserts the header ON CONFLICT (idempotency_key) DO NOTHING and inserts the entries, then TransactionPosted. Balance reads are a plain SELECT on accounts.',
      delivery: 'All or nothing. A retried PlaceHold for the same source places nothing and the existing hold is returned. A replayed posting finds its idempotency_key taken and posts nothing. If the money is not there, no hold is inserted; the caller records the decline. If the hold is not ACTIVE, no entry is inserted. If a lock is not free within 50 ms, the call fails and the caller retries with the same key.',
      alts: ['An interactive transaction of separate statements, holding locks across each round trip.', 'A batch of many transfers per call, as TigerBeetle does, for throughput.'],
      ways: [
        { name: 'SQL: one function call', chosen: true, what: 'The Ledger API (or the settlement worker) calls ledger_place_hold, ledger_capture, ledger_void_hold or ledger_post once on the cluster. Each locks its accounts, runs its one conditional statement with the guard in ON CONFLICT, and writes its outbox_events rows; the transaction commits, and the balance check runs once at COMMIT.', pros: ['Locks are never held across the network: about 1 to 2 ms each.', 'All or nothing; a repeat finds the guard and changes nothing.', 'One round trip per write.'], cons: ['Logic in SQL needs its own review and tests.', 'Changing it is a database deploy.'] },
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
          title: "The owner's five Core Ledger tables, and what the review changed",
          lang: 'text',
          code: `Core Ledger Service owns: accounts, pending_holds,
transactions (headers), ledger_entries, outbox_events.

accounts: his DDL, plus the review's changes, which he approved
  + hard_limit; the CHECK is at -hard_limit, and credit_limit is
    the soft limit tested when a customer starts a debit.
    Why: interest, fees and late settlements must post.
  + status (OPEN, NO_NEW_SPEND, CLOSED) in place of is_active.
    Why: a blocked card must still take repayments and refunds.
  + owner_account_id, and RECEIVABLE and NOSTRO account types.
    Why: a debt past the floor is one customer's; the bank's real
    money must be in the ledger to reconcile.
  + accounts open at zero (the guard also fires on INSERT).
pending_holds, transactions, ledger_entries: his DDL exactly.
outbox_events: his name; the columns are this design's.
Gone: the separate idempotency_keys table.`,
          note: "The guards now live on the tables: UNIQUE (source_type, source_id) on holds and UNIQUE (idempotency_key) on headers. Saved replies and remembered declines belong to the calling service's own record. Everything on this line was run on PostgreSQL 18 (PGlite).",
        },
        {
          title: "1 of 5: accounts, the owner's table with the review's changes",
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
          note: "His new DDL repeats is_active and one CHECK at -credit_limit; he had approved the review's version two hours earlier, so this page keeps it. Example values: a credit card credit_limit 500000 and hard_limit 550000; a debit wallet 0 and 0.",
        },
        {
          title: "2 of 5: pending_holds, the owner's DDL",
          lang: 'sql',
          code: `CREATE TABLE pending_holds (
    hold_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    source_type VARCHAR(25) NOT NULL, -- CARD_AUTH, OUTBOUND_PAYMENT,
                                      -- PAYROLL_BATCH, FX_SPOT
    source_id UUID NOT NULL,  -- card_authorisations.auth_id,
                              -- or the payment's id
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      -- ACTIVE, CAPTURED, VOIDED, EXPIRED
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_type, source_id)
);`,
          note: "UNIQUE (source_type, source_id) is the hold's idempotency guard: PlaceHold(idempotency_key = auth_id) inserts with ON CONFLICT (source_type, source_id) DO NOTHING. The consequence: one hold per source row, so an incremental authorisation is a new card_authorisations row with its own hold.",
        },
        {
          title: "3 of 5: transactions, the owner's journal header",
          lang: 'sql',
          code: `CREATE TABLE transactions (
    transaction_id UUID PRIMARY KEY,
    idempotency_key VARCHAR(100) NOT NULL UNIQUE,
    transaction_type VARCHAR(30) NOT NULL, -- CARD_PURCHASE,
      -- CASH_ADVANCE, CARD_REPAYMENT, FX_CONVERSION,
      -- INTEREST_CHARGE, PAYROLL (and FPS_OUT, REVERSAL, ...)
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED',
      -- POSTED, REVERSED
    merchant_name VARCHAR(255),
    merchant_category_code CHAR(4),
    source_currency CHAR(3),
    target_currency CHAR(3),
    fx_rate NUMERIC(18, 8),
    reference_id UUID,  -- the hold_id, or the original transaction
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
          note: "Never partitioned and never deleted: a partitioned table could keep neither PRIMARY KEY (transaction_id) nor UNIQUE (idempotency_key) without adding the partition column, and then neither would guard anything. Checked: a redelivered clearing with the same key and a new transaction id posts nothing.",
        },
        {
          title: '4 and 5 of 5: ledger_entries and outbox_events',
          lang: 'sql',
          code: `CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL
        REFERENCES transactions(transaction_id),
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    -- Positive = Credit, Negative = Debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id)
);
CREATE INDEX idx_ledger_account_created
    ON ledger_entries (account_id, created_at DESC);

CREATE TABLE outbox_events (
    event_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(40) NOT NULL,  -- HoldPlaced, HoldVoided,
      -- HoldExpired, TransactionPosted
    aggregate_id UUID NOT NULL,       -- hold_id or transaction_id
    account_id UUID NOT NULL,  -- the Kafka key; one row per
                               -- customer account touched
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`,
          note: "ledger_entries is his DDL. This page partitions it by month (below), which turns its unique key into one that guards nothing; the header guards instead. Consumers dedupe on event_id: per account it rises in the order of the account lock.",
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

ALTER ROLE ledger_writer SET statement_timeout = '250ms';
ALTER ROLE ledger_writer SET lock_timeout = '50ms';
ALTER ROLE payroll_writer SET statement_timeout = '5s';
REVOKE DELETE, TRUNCATE ON accounts FROM ledger_writer;
GRANT UPDATE (credit_limit, hard_limit, allow_negative, status)
    ON accounts TO credit_service;`,
          note: "Role settings apply when a server connection logs in, so they hold behind PgBouncer in transaction mode; SET LOCAL statement_timeout inside a function would not time that call. The 5 s payroll value is an example.",
        },
        {
          title: 'Triggers 1: the journal is append-only',
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
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();`,
          note: 'A trigger is a function the database runs by itself when a row is written, inside the same transaction. TRUNCATE skips row triggers, so it has its own statement trigger. DROP TABLE is stopped by grants, not triggers.',
        },
        {
          title: 'Triggers 2: the header changes once, POSTED to REVERSED',
          lang: 'sql',
          code: `CREATE FUNCTION transactions_immutable() RETURNS trigger AS $$
BEGIN
  -- allowed only from mark_reversed (depth 2), only the status
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 2
     AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'transactions is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_no_change
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_immutable();`,
          note: "His header is immutable and has a status, POSTED or REVERSED. The resolution: every UPDATE and DELETE is refused except one, made by the next trigger. Checked: a direct status change and a merchant edit are both refused.",
        },
        {
          title: 'Triggers 3: a REVERSAL marks its original',
          lang: 'sql',
          code: `CREATE FUNCTION mark_reversed() RETURNS trigger AS $$
BEGIN
  IF NEW.transaction_type = 'REVERSAL' THEN
    UPDATE transactions SET status = 'REVERSED'
     WHERE transaction_id = NEW.reference_id
       AND status = 'POSTED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'nothing to reverse: % is missing or'
        ' already reversed', NEW.reference_id;
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_mark_reversed
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION mark_reversed();`,
          note: 'Checked: a REVERSAL posts and flips its original to REVERSED; a second REVERSAL of the same original is refused. The money moves by the reversal\'s own entries; the status is only a label for readers.',
        },
        {
          title: 'Triggers 4: entries move posted; only CLOSED refuses them',
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
          note: 'Matching on currency means an entry in USD for a GBP account finds no row and is refused. A NO_NEW_SPEND account still takes entries: repayments, refunds, interest and settlements already approved.',
        },
        {
          title: 'Triggers 5: a hold raises held_balance, on an OPEN account',
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
          title: 'Triggers 6: a hold ends once; only an ended hold is deleted',
          lang: 'sql',
          code: `CREATE FUNCTION hold_ended() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'an ACTIVE hold is ended, never deleted';
    END IF;
    RETURN OLD;              -- the archive job removes ended holds
  END IF;
  IF OLD.status <> 'ACTIVE'
     OR NEW.status NOT IN ('CAPTURED', 'VOIDED', 'EXPIRED')
     OR (NEW.hold_id, NEW.account_id, NEW.source_type,
         NEW.source_id, NEW.amount, NEW.currency)
        IS DISTINCT FROM (OLD.hold_id, OLD.account_id,
         OLD.source_type, OLD.source_id, OLD.amount, OLD.currency)
  THEN RAISE EXCEPTION
      'a hold changes once: ACTIVE to CAPTURED, VOIDED or EXPIRED';
  END IF;
  UPDATE accounts SET held_balance = held_balance - OLD.amount,
         updated_at = now() WHERE account_id = OLD.account_id;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_ended BEFORE UPDATE OR DELETE
  ON pending_holds FOR EACH ROW EXECUTE FUNCTION hold_ended();`,
          note: "Whichever ends a hold first wins; the second finds it no longer ACTIVE. It also pins source_type and source_id and sets updated_at. Its UPDATE of accounts is why every path locks the account row before it touches a hold.",
        },
        {
          title: 'Triggers 7: the guard; accounts open at zero',
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
          note: "The owner's pg_trigger_depth() <= 1 rule. A direct UPDATE of either balance runs the guard at depth 1 and is refused; a trigger's UPDATE runs it at depth 2. The table owner or a superuser could disable the trigger, so DDL is reviewed and logged.",
        },
        {
          title: 'Triggers 8: at COMMIT, once per transaction, the books balance',
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
CREATE CONSTRAINT TRIGGER transactions_balanced
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transaction_must_balance();`,
          note: "On, not optional. It fires once, on the header, not once per entry: the per-entry version took 8.2 s for a 5,001-entry payroll (a reviewer's measurement); this one about 0.7 s. created_at = NEW.created_at holds because header and entries share now(), the transaction's start.",
        },
        {
          title: 'PlaceHold for the bank payment: one local transaction',
          lang: 'sql',
          code: `-- PlaceHold(OUTBOUND_PAYMENT, key = payment e1f0c3a2-...3318)
-- wallet 5f0c...081442: credit_limit 0, posted 842000
BEGIN;
SELECT 1 FROM accounts
 WHERE account_id = '5f0c2a9e-...081442' FOR NO KEY UPDATE;
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND status = 'OPEN'
     AND posted_balance - held_balance - 120020 >= -credit_limit),
placed AS (
  INSERT INTO pending_holds (hold_id, account_id, source_type,
    source_id, amount, currency, expires_at)
  SELECT 'b61c9a3e-...0417', '5f0c2a9e-...081442',
    'OUTBOUND_PAYMENT', 'e1f0c3a2-...3318', 120020, 'GBP',
    now() + interval '7 days' FROM funded
  ON CONFLICT (source_type, source_id) DO NOTHING
  RETURNING hold_id)
INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
SELECT 'HoldPlaced', hold_id, '5f0c2a9e-...081442', '{...}'
  FROM placed;
COMMIT;  -- once a synchronous standby has the log record
-- placed: posted 842000, held 120020, available 721980`,
          note: "The lock, the funds test, the hold (its trigger raises held_balance) and HoldPlaced, all in one local transaction, as the owner's step 2 says (checked as one statement chain). The card's PlaceHold is the same with source_type CARD_AUTH and the auth_id.",
        },
        {
          title: 'PlaceHold: nothing placed, so which answer?',
          lang: 'sql',
          code: `-- the insert placed 0 rows: a retry, or no money
SELECT hold_id, status, amount FROM pending_holds
 WHERE source_type = 'OUTBOUND_PAYMENT'
   AND source_id = 'e1f0c3a2-...3318';
-- a row: this is a retry. Answer with that hold, as the first
--   time. No second hold and no second HoldPlaced (checked).
-- no row: INSUFFICIENT_FUNDS (or ACCOUNT_NOT_OPEN). The ledger
--   stores nothing; the caller records the decline on its own
--   row (the payment FAILED, the authorisation DECLINED).`,
          note: "A PlaceHold retried after a decline is evaluated again, and could now succeed. That is safe: the caller only retries when it never received the first answer, and it records the answer it does receive.",
        },
        {
          title: 'Capture, part 1: already posted? Then the account locks',
          lang: 'sql',
          code: `-- FPS_CLEARING_GBP s7  1c9d4e2a-7b10-4c55-9a01-000000000007
-- FEE_REVENUE_GBP s7   c2e85b71-90aa-4d3f-a6e4-000000000007
BEGIN;
SELECT transaction_id FROM transactions
 WHERE idempotency_key = 'fps:out:pay_3fK9';
-- a row: captured already; return it and stop
SELECT 1 FROM accounts
 WHERE account_id IN ('5f0c2a9e-...081442', '1c9d4e2a-...000007',
                      'c2e85b71-...000007')
 ORDER BY account_id FOR NO KEY UPDATE;`,
          note: "Account rows first, in account_id order, then the hold: the same order as the void and the expiry job, so they cannot deadlock. The Banking API made the transaction id and the key from the payment.",
        },
        {
          title: 'Capture, part 2: end the hold and post, in one statement',
          lang: 'sql',
          code: `WITH done AS (
  UPDATE pending_holds SET status = 'CAPTURED'
   WHERE hold_id = 'b61c9a3e-...0417' AND status = 'ACTIVE'
  RETURNING hold_id),
hdr AS (
  INSERT INTO transactions (transaction_id, idempotency_key,
    transaction_type, reference_id)
  SELECT '7d1f0a52-...900418', 'fps:out:pay_3fK9', 'FPS_OUT',
         hold_id FROM done
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING transaction_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT hdr.transaction_id, v.acct::uuid, v.amt, 'GBP'
  FROM hdr, (VALUES ('5f0c2a9e-...081442', -120020::bigint),
                    ('1c9d4e2a-...000007',  120000::bigint),
                    ('c2e85b71-...000007',      20::bigint))
       AS v(acct, amt);
-- 3 rows, or 0 if the hold was not ACTIVE: ROLLBACK and answer
-- HOLD_NOT_ACTIVE
INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
VALUES ('TransactionPosted', '7d1f0a52-...900418',
        '5f0c2a9e-...081442', '{...}');
COMMIT;  -- the balance check runs here, once`,
          note: 'The hold ends, the header goes in and the entries post together, or none of them. After: posted 721980, held 0. One outbox row, because one customer account is touched; TransactionPosted carries the hold_id, so it also tells readers the hold ended.',
        },
        {
          title: 'VoidHold: the scheme rejected the payment',
          lang: 'sql',
          code: `BEGIN;
SELECT 1 FROM accounts               -- the account first, always
 WHERE account_id = '5f0c2a9e-...081442' FOR NO KEY UPDATE;
WITH ended AS (
  UPDATE pending_holds SET status = 'VOIDED'
   WHERE source_type = 'OUTBOUND_PAYMENT'
     AND source_id = 'e1f0c3a2-...3318' AND status = 'ACTIVE'
  RETURNING hold_id, account_id)
INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
SELECT 'HoldVoided', hold_id, account_id, '{...}' FROM ended;
COMMIT;
-- 1 row: held_balance falls by 120020; posted stays 842000
-- 0 rows: already captured, voided or expired, or never placed
-- no header and no entries: the journal never saw the payment`,
          note: "Keyed by the source, like PlaceHold, so the Card service can void by auth_id without knowing whether the hold was ever placed. Locking the account first, 200 rounds of capture racing void gave no errors (PostgreSQL 16, real sessions).",
        },
        {
          title: 'A reversal: the one change the header allows',
          lang: 'sql',
          code: `-- reverse the card purchase ...900611 in full
BEGIN;   -- card and clearing row locked in id order first
INSERT INTO transactions (transaction_id, idempotency_key,
  transaction_type, reference_id)
VALUES ('7d1f0a52-...900650', 'reverse:7d1f0a52-...900611',
        'REVERSAL', '7d1f0a52-...900611');
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900650', '5f0c2a9e-...081444',  64900, 'GBP'),
 ('7d1f0a52-...900650', 'd41e7c90-...000207', -64900, 'GBP');
COMMIT;  -- ...900611 now reads REVERSED, set by mark_reversed

UPDATE transactions SET status = 'REVERSED'
 WHERE transaction_id = '7d1f0a52-...900611';
-- refused: transactions is append-only`,
          note: "Separate from the tour. The old reverses column is now reference_id, kind is transaction_type, and external_ref became the idempotency_key built from the scheme's reference. A second REVERSAL of the same original is refused.",
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

-- the credit card, after its purchase cleared and a repayment
--  5f0c...081444: -34900        0   465100  (limit 500000)`,
          note: "A plain SELECT never waits for a writer's row lock: it reads the last committed version of the row. Available uses credit_limit, the soft limit, never hard_limit: the gap between them is not the customer's to spend.",
        },
        {
          title: 'B. A debit card purchase in dollars: the hold',
          lang: 'sql',
          code: `-- the network's billing amount is 8000p; + 3% buffer = 8240p
-- (inside the PlaceHold frame: account lock, then HoldPlaced)
WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND status = 'OPEN'
     AND posted_balance - held_balance - 8240 >= -credit_limit)
INSERT INTO pending_holds (hold_id, account_id, source_type,
  source_id, amount, currency, expires_at)
SELECT 'b61c9a3e-...0520', '5f0c2a9e-...081442', 'CARD_AUTH',
       'a17c0de5-...0520', 8240, 'GBP', now() + interval '7 days'
  FROM funded
ON CONFLICT (source_type, source_id) DO NOTHING;`,
          note: "The hold is in GBP because the wallet is and the network sent pounds; no account ever holds two currencies. The 7-day expiry and the 3% buffer are illustrative. The credit card purchase in the second story is the same statement on the card account.",
        },
        {
          title: 'B clears: a purchase in dollars, three entries in pounds',
          lang: 'sql',
          code: `-- billed 7900p; non-sterling transaction fee 1% = 79p
-- MASTERCARD_DEBIT_CLEARING_GBP s7  d41e7c90-...000000000007
-- FX_FEE_REVENUE_GBP s7             c2e85b71-...000000000107
-- (settlement worker: accounts locked in id order first)
WITH done AS (
  UPDATE pending_holds SET status = 'CAPTURED'
   WHERE hold_id = 'b61c9a3e-...0520' AND status = 'ACTIVE'
  RETURNING hold_id),
hdr AS (
  INSERT INTO transactions (transaction_id, idempotency_key,
    transaction_type, merchant_name, source_currency,
    target_currency, reference_id)
  VALUES ('7d1f0a52-...900521', 'settle:a17c0de5-...0520',
    'CARD_PURCHASE', 'ACME TOOLS INC', 'USD', 'GBP',
    'b61c9a3e-...0520')
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING transaction_id)
INSERT INTO ledger_entries (transaction_id, account_id, amount,
  currency)
SELECT hdr.transaction_id, v.a::uuid, v.amt, 'GBP'
  FROM hdr, (VALUES ('5f0c2a9e-...081442', -7979::bigint),
                    ('d41e7c90-...000007',  7900::bigint),
                    ('c2e85b71-...000107',    79::bigint)) v(a, amt);
-- 8240 released, 7979 posted: 261p free again`,
          note: "The network converted the dollars and sends pounds, so the bank quotes no fx_rate; source and target currency record what happened. A card settlement credits the card clearing account, never an FX pool. If the hold had EXPIRED, done is empty, the header and entries still post: a force-post with no release.",
        },
        {
          title: 'E. Converting between wallets: four entries, two currencies',
          lang: 'sql',
          code: `-- £8,000.00 from the GBP wallet to the USD wallet at
-- 1 USD = 0.80 GBP: 800000p buys 1000000 cents.
-- USD wallet 5f0c...081443; FX_POOL_GBP s7 3b7a...000007;
-- FX_POOL_USD s7 3b7a...000107
INSERT INTO transactions (transaction_id, idempotency_key,
  transaction_type, source_currency, target_currency, fx_rate)
VALUES ('7d1f0a52-...900530', 'fx:5f0c2a9e-...081442:k31',
  'FX_CONVERSION', 'GBP', 'USD', 1.25000000);
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900530', '5f0c2a9e-...081442',  -800000, 'GBP'),
 ('7d1f0a52-...900530', '3b7a1f64-...000007',   800000, 'GBP'),
 ('7d1f0a52-...900530', '3b7a1f64-...000107', -1000000, 'USD'),
 ('7d1f0a52-...900530', '5f0c2a9e-...081443',  1000000, 'USD');
-- GBP: -800000 + 800000 = 0    USD: -1000000 + 1000000 = 0`,
          note: 'Separate from the tour: the wallet needs 800000 available. The rate now lives on the owner\'s header: fx_rate is target per source, 1.25 USD a pound, the same as 1 USD = 0.80 GBP. The pools drift until treasury trades.',
        },
        {
          title: 'D. Credit card repayment from the wallet',
          lang: 'sql',
          code: `-- after the £649.00 purchase cleared, the card is at -64900
-- (wallet and card locked in id order first)
INSERT INTO transactions (transaction_id, idempotency_key,
  transaction_type)
VALUES ('7d1f0a52-...900613', 'repay:k9', 'CARD_REPAYMENT');
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900613', '5f0c2a9e-...081442', -30000, 'GBP'),
 ('7d1f0a52-...900613', '5f0c2a9e-...081444',  30000, 'GBP');
-- card posted -34900, available credit 465100 at once`,
          note: 'The money is the bakery\'s own and already final, so the credit is restored at once. In the ledger a repayment is one credit to the card; billing decides which bucket it pays off. A negative card balance is what the customer owes: -34900 is £349.00.',
        },
        {
          title: 'Force-post 1: a settlement larger than its live hold',
          lang: 'sql',
          code: `-- Had B cleared at 9000p (8911p + an 89p fee) against 8240p
BEGIN;
SELECT 1 FROM accounts WHERE account_id IN ('5f0c2a9e-...081442',
  'd41e7c90-...000007', 'c2e85b71-...000107')
 ORDER BY account_id FOR NO KEY UPDATE;
UPDATE pending_holds SET status = 'CAPTURED'
 WHERE source_type = 'CARD_AUTH'
   AND source_id = 'a17c0de5-...0520' AND status = 'ACTIVE';
INSERT INTO transactions (transaction_id, idempotency_key,
  transaction_type, merchant_name, reference_id)
VALUES ('7d1f0a52-...900521', 'settle:a17c0de5-...0520',
  'CARD_PURCHASE', 'ACME TOOLS INC', 'b61c9a3e-...0520');
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900521', '5f0c2a9e-...081442', -9000, 'GBP'),
 ('7d1f0a52-...900521', 'd41e7c90-...000007',  8911, 'GBP'),
 ('7d1f0a52-...900521', 'c2e85b71-...000107',    89, 'GBP');
COMMIT;
-- hold CAPTURED; wallet -9000; no receivable: the wallet could pay`,
          note: 'A settlement is a debit the bank cannot refuse, so it skips the soft test and posts as far as the hard floor. If the hold had already EXPIRED, the UPDATE finds nothing and the settlement posts the same way, with no second release (checked).',
        },
        {
          title: 'Force-post 2: past the hard floor, the rest to a receivable',
          lang: 'sql',
          code: `-- The card spent to its limit, then statement interest 250p and
-- a 1200p late fee posted past it: posted -501450. A 60000p
-- settlement arrives with no hold. Card receivable 5f0c...081449:
-- RECEIVABLE, owner_account_id the card, allow_negative TRUE,
-- opened on first use. (Header CARD_PURCHASE first; card,
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
          note: 'A plain debit of 60000 is refused by the hard floor (23514, checked). The shortfall is this customer\'s own receivable, never a pooled account; uq_receivable_owner allows one per owner.',
        },
        {
          title: 'Money in: blocked card, repayment clears the receivable first',
          lang: 'sql',
          code: `-- the credit service blocks the card: no new spend
UPDATE accounts SET status = 'NO_NEW_SPEND'
 WHERE account_id = '5f0c2a9e-...081444';
-- a new hold now fails in hold_placed; money in still posts

-- a 30000p repayment from the wallet; the Ledger API splits it
-- (header CARD_REPAYMENT first)
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
INSERT INTO pending_holds (hold_id, account_id, source_type,
  source_id, amount, currency, expires_at)
SELECT 'b61c9a3e-...0800', '5f0c2a9e-...081442', 'PAYROLL_BATCH',
       'e1f0c3a2-...0800', 310000, 'GBP', '2026-11-30 18:00+00'
  FROM funded ON CONFLICT (source_type, source_id) DO NOTHING;

-- Bacs processing day: 13 staff bank elsewhere, one here
-- BACS_CLEARING_GBP s3 1c9d...000303; employee 5f0c...090001
-- (header PAYROLL, key payroll:e1f0c3a2-...0800, inserted first)
WITH done AS (UPDATE pending_holds SET status = 'CAPTURED'
  WHERE hold_id = 'b61c9a3e-...0800' AND status = 'ACTIVE'
  RETURNING hold_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT '7d1f0a52-...900800', v.a::uuid, v.amt, 'GBP'
  FROM (VALUES ('5f0c2a9e-...081442', -310000::bigint),
               ('1c9d4e2a-...000303',  285000::bigint),
               ('5f0c2a9e-...090001',   25000::bigint)) AS v(a, amt),
       done;`,
          note: "The pay date, Friday 2026-11-27, lives on the payroll run in the Banking API. A returned line posts later as its own PAYROLL_RETURN transaction whose reference_id names this one; not a REVERSAL, which would mark the whole run REVERSED. A run for 5,000 staff who bank here is 5,001 entries: about 0.7 s on the WASM build, so it runs as payroll_writer (5 s).",
        },
        {
          title: 'Money in from a scheme, and the scheme settling',
          lang: 'sql',
          code: `-- an incoming Faster Payment: one transaction, no hold
-- NOSTRO_BOE_GBP row 0   0a000000-0000-4000-8000-000000000001
-- (header FPS_IN, key fps:in:<the scheme's reference>, first)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900810', '0a000000-...000001', -45000, 'GBP'),
 ('7d1f0a52-...900810', '5f0c2a9e-...081442',  45000, 'GBP');

-- the scheme settles with the bank at the Bank of England:
-- this payment's part of the cycle (header FPS_SETTLEMENT)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900820', '1c9d4e2a-...000007', -120000, 'GBP'),
 ('7d1f0a52-...900820', '0a000000-...000001',  120000, 'GBP');
-- FPS_CLEARING_GBP back towards 0; the nostro, an asset, is
-- negative when money sits at the bank (credit is positive)`,
          note: "A resent incoming message carries the same scheme reference, so its idempotency_key is taken and it posts nothing. Simplified: Faster Payments settles between banks in cycles, so a fuller model would credit the wallet from FPS_CLEARING_GBP (the writer's knowledge, not checked).",
        },
        {
          title: 'Partitioned by month: the keys must change, and guard nothing',
          lang: 'sql',
          code: `-- PostgreSQL refuses the owner's keys on a table partitioned by
-- created_at: a unique key must include the partition column.
CREATE TABLE ledger_entries (
    entry_id BIGSERIAL,
    transaction_id UUID NOT NULL
        REFERENCES transactions(transaction_id),
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
-- The guard is the header's UNIQUE (idempotency_key), kept for
-- good because transactions is never partitioned.`,
          note: "The owner's spec says date-partitioned transactions and ledger_entries. This page partitions ledger_entries only: partitioned the same way, the header could keep neither its primary key nor UNIQUE (idempotency_key), so the lasting guard would be gone.",
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
          note: "Copy and delete are one statement, so a hold is never lost between them. Once archived, a source's UNIQUE (source_type, source_id) no longer guards it; no card or payment is retried 90 days later. Each delete leaves a dead row for vacuum, about 86 million a day at the stress load.",
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
      id: 'sweep', from: 'sweeper', to: 'db', d: 'M989,190 H890', label: 'sweep',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: "The Core Ledger's workers write here. The settlement worker posts each SettleCardTransaction it reads from Kafka (its SQL is on that line). Every minute, overdue ACTIVE holds are marked EXPIRED, one account per transaction, the account row locked first, each with a HoldExpired event. At the end of each business day, for each logical system account, one balanced transaction moves the 16 rows' posted balances into the master account, and a job writes each account's balances for the day.",
      delivery: "Idempotent: each sweep's header has transaction_type SWEEP and the idempotency_key sweep:<account>:<business date>, so a rerun finds it and does nothing. Expiring a hold twice is impossible: the second update finds it no longer ACTIVE. The settlement worker's writes are guarded by their idempotency_key the same way.",
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
INSERT INTO transactions (transaction_id, idempotency_key,
  transaction_type)
VALUES ('7d1f0a52-...900452', 'sweep:FEE_REVENUE_GBP:2026-11-12',
  'SWEEP')
ON CONFLICT (idempotency_key) DO NOTHING;  -- 0 rows: ROLLBACK
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
WITH ended AS (
  UPDATE pending_holds SET status = 'EXPIRED'
   WHERE hold_id IN (SELECT hold_id FROM pending_holds
                      WHERE account_id = '5f0c2a9e-...081442'
                        AND status = 'ACTIVE' AND expires_at < now()
                      LIMIT 50)
  RETURNING hold_id, account_id)
INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
SELECT 'HoldExpired', hold_id, account_id, '{...}' FROM ended;
COMMIT;  -- again while 50 came back, then the next account`,
          note: 'Both queries match idx_holds_active_account (account_id, expires_at) WHERE status = \'ACTIVE\'. Account first, as capture, void and repayments do: run against wallet-to-card repayments for 3 seconds on PostgreSQL 16, it expired 4,000 holds with no deadlock and no lock timeout, and the caches equalled the journal. An expired hold then captures 0 rows. HoldExpired tells the Card service, which marks the authorisation EXPIRED.',
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
          note: 'End of day is a date, not a stop. The ledger keeps no value date: the header has only created_at, and value dates live with the service that owns the payment and here, in account_balances_daily. Statements, interest, the Single Customer View and reconciliation read this table. last_entry_id is this design\'s addition: each row records the balance with the last entry it includes, so a later check can add only newer entries. That works because, for one account, entry_id rises in the order of the account lock.',
        },
      ],
    },
    {
      id: 'cdc', from: 'db', to: 'relay', d: 'M890,240 H925 Q935,240 935,250 V340 Q935,350 945,350 H980', label: 'outbox rows',
      mode: 'async', via: 'CDC', chip: 0.5,
      how: 'Logical decoding through a replication slot: the relay receives committed outbox_events rows in commit order. The Card service runs its own relay for its own outbox.',
      delivery: 'At least once. The slot remembers how far the relay has read, so a restart resumes and may repeat a little.',
      alts: ['Polling the outbox table.', 'Logical decoding messages with no table.'],
      ways: [
        { name: 'CDC', chosen: true, what: 'The relay reads the write-ahead log through a logical replication slot and receives committed outbox rows in commit order. The slot remembers how far it has read.', pros: ['Only committed rows, in commit order.', 'No polling queries on the primary.', 'Resumes where it left off after a restart.'], cons: ['At least once: a restart may repeat a little.', 'The slot holds log on the primary until read, so watch the disk.'] },
        { name: 'Polling the outbox table', what: 'A worker queries outbox_events for unsent rows every so often, publishes them and marks them sent.', pros: ['Simple, with no slot to manage.', 'Works on any database.'], cons: ['Can miss or reorder rows from concurrent commits.', 'Adds queries and writes to the primary.'] },
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
    "event_id": 5512930,
    "event_type": "TransactionPosted",
    "aggregate_id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
    "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
    "payload": "<the event as JSON text: see ledger-events>"
  },
  "source": {
    "connector": "postgresql",
    "table": "outbox_events",
    "lsn": 249113864
  }
}`,
          note: 'op "c" is an insert; lsn is the position in the write-ahead log. The relay copies event_id, not lsn, into the event as the number readers dedupe on. This row is the capture\'s; the hold wrote HoldPlaced. A transfer between two customers writes one row for each account.',
        },
      ],
    },
    {
      id: 'publish', from: 'relay', to: 'kafka', d: 'M1030,378 V542', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.5, chipY: 470,
      how: "Each outbox_events row becomes one event on ledger-events, keyed by account so an account's events keep their order.",
      delivery: 'At least once, in order per account. Events carry the event_id so readers can drop repeats.',
      alts: ['One topic per event type.', 'A managed stream (Kinesis, Pub/Sub).'],
      ways: [
        { name: 'Kafka, keyed by account', chosen: true, what: "The relay turns each outbox row into one event on ledger-events, keyed by account. Kafka keeps order within a partition, so each account's events stay in order.", pros: ['Ordered per account.', 'Replayable for every reader.', 'Light: about 2 MB a second on average, about 20 MB at peak.'], cons: ['At least once: events carry the event_id so readers can drop repeats.', 'A partition holding a busy account can lag behind the others.'] },
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
  "type": "TransactionPosted",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
  "transaction_type": "FPS_OUT",
  "reference_id": "b61c9a3e-0f47-4d2a-8c55-000000000417",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "entries": [
    { "account": "5f0c...081442", "amount": -120020,
      "currency": "GBP" },
    { "account": "FPS_CLEARING_GBP/7", "amount": 120000,
      "currency": "GBP" },
    { "account": "FEE_REVENUE_GBP/7", "amount": 20, "currency": "GBP" }
  ],
  "posted": 721980, "held": 0, "available": 721980,
  "event_id": 5512930,
  "committed_at": "2026-11-12T10:41:03.118Z"
}`,
          note: 'Signed minor units: plus a credit, minus a debit, each with its currency. reference_id is the hold the capture ended; the hold itself emitted HoldPlaced. event_id lets a reader drop a repeat: per account it rises in commit order.',
        },
        {
          title: 'Message value: the card settlement of a dollar purchase',
          lang: 'json',
          code: `{
  "type": "TransactionPosted",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900521",
  "reference_id": "b61c9a3e-0f47-4d2a-8c55-000000000520",
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
  "event_id": 5530417
}`,
          note: 'The dollar amount travels on the event and on card_authorisations, never in ledger_entries: the ledger saw only the pounds the network billed. Figures illustrative.',
        },
      ],
    },
    {
      id: 'notify', from: 'kafka', to: 'consumers', d: 'M900,542 V484', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.5, chipY: 518,
      how: 'Each consumer group reads at its own pace: notifications in seconds, fraud models as events arrive, the warehouse in batches. The Card service and Billing read the same topic as consumer groups of their own, on their own lines.',
      delivery: 'At least once. Consumers keep the last applied event_id per account and skip anything older.',
      alts: ['Webhooks pushed to partners from a dedicated consumer.'],
      ways: [
        { name: 'Kafka', chosen: true, what: 'Each consumer group reads ledger-events at its own pace: notifications within seconds, the warehouse in batches. Each keeps its own position.', pros: ['A slow consumer builds lag, not payment latency.', 'Each can replay from its own position.'], cons: ['At least once: each keeps the last event_id per account and skips anything older.', 'Lag to watch per group.'] },
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

last applied  event_id 5512871 for the wallet (HoldPlaced)
this event    event_id 5512930, TransactionPosted, ...900418
              -> newer: send the push, store 5512930

same event again after a relay restart
              event_id 5512930, not newer -> skip`,
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
      id: 'events', from: 'kafka', to: 'recon', d: 'M1200,542 V232', label: 'ledger totals',
      mode: 'async', via: 'Kafka', chip: 0.5, chipY: 390, cold: true,
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
        {
          title: 'Beside this line: the nightly parity job across two services',
          lang: 'sql',
          code: `-- 1. Exported from the Card service's replica (its database):
SELECT auth_id, hold_id, status FROM card_authorisations
 WHERE status IN ('APPROVED', 'CLEARED')
   AND created_at < '2026-11-14 00:00+00';
-- 2. Exported from the Core Ledger replica of each cluster:
SELECT hold_id, source_id, status FROM pending_holds
 WHERE source_type = 'CARD_AUTH'
   AND created_at < '2026-11-14 00:00+00';
SELECT transaction_id, reference_id, status FROM transactions
 WHERE transaction_type = 'CARD_PURCHASE'
   AND created_at < '2026-11-14 00:00+00';
-- 3. Loaded side by side in reconciliation's own database:
SELECT a.auth_id FROM card_auths a
  LEFT JOIN ledger_holds h ON h.hold_id = a.hold_id
                          AND h.status = 'ACTIVE'
 WHERE a.status = 'APPROVED' AND h.hold_id IS NULL;
SELECT a.auth_id FROM card_auths a
  LEFT JOIN ledger_txns t ON t.reference_id = a.hold_id
                         AND t.status = 'POSTED'
 WHERE a.status = 'CLEARED' AND t.transaction_id IS NULL;
-- and the same both ways round; each row returned is a break`,
          note: "The two tables live in two databases, so no single query can join them: the job exports keys from each replica up to one cut-off and compares them. For a card settlement the header's reference_id is the hold_id. A hold expired today while its row still says APPROVED is a break that heals when HoldExpired is read; the job ages breaks before raising them.",
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
      id: 'history', from: 'ledger', to: 'replicas', d: 'M615,215 H655 Q665,215 665,225 V345 Q665,355 675,355 H700', label: 'statement page',
      mode: 'call', via: 'SQL read', chip: 0.5, chipY: 280,
      how: 'Statements and history are read from an asynchronous replica: ledger_entries for one account with each header\'s type and merchant, newest first by entry_id, 50 at a time, continuing from the last entry_id seen. Pending items are the account\'s ACTIVE holds, listed above them. The Banking API adds each payment\'s own reference, such as INV 3318, from its payment record.',
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
SELECT e.entry_id, e.amount, e.currency, t.transaction_type,
       t.merchant_name, t.reference_id, e.created_at
  FROM ledger_entries e
  JOIN transactions t USING (transaction_id)
 WHERE e.account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
 ORDER BY e.entry_id DESC
 LIMIT 50;

-- Next page: older than the last row seen
SELECT e.entry_id, e.amount, e.currency, t.transaction_type,
       t.merchant_name, t.reference_id, e.created_at
  FROM ledger_entries e
  JOIN transactions t USING (transaction_id)
 WHERE e.account_id = '5f0c2a9e-...081442'
   AND e.entry_id < 7730512
 ORDER BY e.entry_id DESC
 LIMIT 50;`,
          note: "Paged by entry_id, not created_at. created_at is the transaction's start, so two commits can land in the other order; for one account, entry_id follows the account lock (a reviewer's reasoning, not tested). idx_ledger_account_entry serves it; the owner's created_at index serves date ranges.",
        },
        {
          title: 'Pending items, shown above the first page',
          lang: 'sql',
          code: `SELECT hold_id, source_type, source_id, amount, currency,
       created_at, expires_at
  FROM pending_holds
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
   AND status = 'ACTIVE'
 ORDER BY created_at DESC;
-- e.g. b61c...0520  CARD_AUTH  8240 GBP; the app asks the Card
-- service for the merchant: "ACME TOOLS INC, USD 100.00, pending"`,
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
        { name: 'Ledger API', chosen: true, what: 'Once a break is understood and a second person approves, a correcting transaction is posted through the Ledger API like any other, its idempotency_key made from the break id.', pros: ['The same rules as every payment: it must balance in each currency.', 'Approving twice posts once.', 'The history keeps both the mistake and the fix.'], cons: ['One break at a time: slow for a large incident.', 'Needs a review tool for the second person.'] },
        { name: 'A reviewed bulk migration', what: 'For a large incident, a job builds all the correcting transactions, shows their effect, and runs once approved. Stripe corrects this way.', pros: ['Thousands of fixes in one reviewed step.', 'The effect is seen before anything posts.'], cons: ['A powerful tool that must itself be tested.', 'A mistake in it is a mistake at scale.'] },
        { name: 'Direct SQL on the database', what: 'An engineer changes the wrong rows in the database by hand.', pros: ['Fastest to do, if it were allowed.'], cons: ['The triggers refuse it: entries and headers cannot be updated or deleted, ACTIVE holds cannot be deleted, and balances cannot be edited directly.', 'Getting round them needs the table owner or a superuser, which leaves no record of the mistake or of who fixed it.'] },
      ],
      examples: [
        {
          title: 'Example call, after a second person approves',
          lang: 'text',
          code: `Post
{ "header": { "transaction_id": "7d1f0a52-...000000901733",
    "idempotency_key": "break:brk_1127",
    "transaction_type": "CORRECTION" },
  "entries": [
    { "account": "FPS_CLEARING_GBP_MASTER", "amount": 500,
      "currency": "GBP" },
    { "account": "SUSPENSE_GBP", "amount": -500, "currency": "GBP" }
  ] }
-> { "id": "7d1f0a52-6c3e-4f8b-9e21-000000901733",
     "status": "POSTED" }

Approved twice: the same call with key break:brk_1127
-> the same reply; posted once`,
          note: 'The scheme settled 500p more than the ledger captured, leaving FPS_CLEARING_GBP at -500. This brings it back to zero; SUSPENSE_GBP (allow_negative TRUE) holds -500p until it is traced. The break\'s own record holds the description. A correction of one known transaction would name it in reference_id, or reverse it with a REVERSAL.',
        },
      ],
    },
    {
      id: 'export', from: 'replicas', to: 'archive', d: 'M720,400 V438', label: 'old months',
      mode: 'write', via: 'export', chip: 0.5, cold: true,
      how: 'Off the hot path. Monthly, the oldest partition of ledger_entries (past 13 months) is exported from a replica to Parquet with its row count and sums, per-account totals are saved, then it is detached on the primary. Ended holds move to pending_holds_history by their own job, and the transactions headers stay.',
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
    {
      id: 'iso', from: 'cardnet', to: 'cardsvc', d: 'M135,340 H240', label: 'authorise',
      travels: 'An ISO 8583 authorisation request, and later the clearing file',
      mode: 'external', via: 'ISO 8583', chip: 0.5,
      how: "The network sends an authorisation request in real time and expects an answer in seconds. A day or two later its clearing file lists what it is settling. Both arrive at the Card service, never at the ledger.",
      delivery: "No promise from the network. A late answer may be overtaken by stand-in, so the Card service answers inside its budget or not at all, and voids any hold the network never heard about.",
      alts: ['An outsourced issuer processor between the network and us.'],
      ways: [
        { name: 'ISO 8583 to the Card service', chosen: true, what: "The network's messages reach our Card service, directly or through a processor that only passes them on. The Card service answers each authorisation from a hold in the Core Ledger.", pros: ['Every answer uses live balances.', 'The network reference and merchant data stay with the authorisation.'], cons: ['A 24/7 service that must answer in seconds.', 'Certification with each network.'] },
        { name: 'An outsourced issuer processor', what: 'A third party talks to the network and decides, from balances it keeps for us or by calling us.', pros: ['Faster to launch.', 'No certification of our own.'], cons: ['Two sets of balances to keep in step.', 'Another party in every decision.'] },
      ],
      reply: {
        id: 'approve', label: 'approved',
        how: "Approved or declined, with a reason, inside the network's time limit.",
        delivery: "Sent only after the authorisation row says APPROVED or DECLINED, so a crash cannot leave the network told yes with no record.",
      },
      examples: [
        {
          title: 'Authorisation request (the fields that matter here)',
          lang: 'text',
          code: `From Mastercard, as the Card service reads it. The ISO 8583
field numbers and the wire format are not shown.

network ref    MCC8K2QX1114     the same on clearing
card           Bright Bakery's credit card
merchant       NORTHERN OVENS LTD
MCC            5046             commercial equipment
amount         64900 GBP        the purchase
billing        64900 GBP        what the card is charged

Reply inside the time limit: approved (or declined, reason)`,
          note: "The purchase is in pounds, so the billing amount is the same. For a dollar purchase the network converts and sends the billing amount in pounds. MCC 5046 is used here as an illustration; its exact title is not checked.",
        },
        {
          title: 'Two days later: one line of the clearing file',
          lang: 'text',
          code: `file      mc-clearing-2026-11-14.dat, loaded once by checksum
line      network ref MCC8K2QX1114, cleared 64900 GBP,
          billing 64900 GBP, NORTHERN OVENS LTD, MCC 5046

Card service: match by network_lifecycle_id
  -> auth a17c0de5-...0610, APPROVED, hold b61c9a3e-...0610
  -> mark CLEARING_SUBMITTED and emit SettleCardTransaction`,
          note: 'The file layout is illustrative. A line with no matching APPROVED authorisation (a stand-in approval) is settled the same way, with no hold to capture.',
        },
      ],
    },
    {
      id: 'placehold', from: 'cardsvc', to: 'ledger', d: 'M390,340 H490 Q500,340 500,330 V228', label: 'PlaceHold',
      mode: 'call', via: 'gRPC', chip: 0.35,
      how: "PlaceHold with idempotency_key = auth_id, the card account, the billing amount in pounds and an expiry, under a deadline. Later, if needed, VoidHold keyed by the same auth_id.",
      delivery: "Synchronous and safe to repeat: pending_holds has UNIQUE (source_type, source_id), so a retry with the same auth_id places nothing new and emits no second event; the ledger returns the hold already there.",
      alts: ['An asynchronous hold through a topic.', 'REST with an Idempotency-Key header.'],
      ways: [
        { name: 'gRPC, synchronous', chosen: true, what: 'The Card service calls PlaceHold and waits, with a deadline inside its seconds budget. The Ledger API runs one local transaction and answers with the hold or a decline.', pros: ['The answer is known before the network is answered.', 'A typed contract.', 'Retries are harmless: the key is the auth_id.'], cons: ['The ledger is on the authorisation hot path, so its latency is the card\'s.', 'A timeout leaves the outcome unknown until a retry.'] },
        { name: 'Asynchronous hold through a topic', what: 'The Card service writes a hold command to Kafka and waits for HoldPlaced to come back on ledger-events.', pros: ['Bursts queue instead of failing.', 'No synchronous dependency.'], cons: ['The network needs an answer in seconds; a queue cannot promise that.', 'Matching replies to requests is extra code.', 'The owner chose synchronous for this path.'] },
        { name: 'REST with an Idempotency-Key header', what: 'The same call as JSON over HTTPS: POST /holds with the auth_id as the key.', pros: ['Easy to call by hand.'], cons: ['No generated contract.', 'A little more to parse on the hottest path.'] },
      ],
      reply: {
        id: 'held', label: 'hold placed',
        how: "The hold id and the account's posted, held and available figures; or INSUFFICIENT_FUNDS, ACCOUNT_NOT_OPEN or TIMEOUT.",
        delivery: 'The same hold for every retry with the same auth_id. A decline is not stored by the ledger: the Card service records it on its own row.',
      },
      examples: [
        {
          title: "The owner's card_authorisations, in the Card service's database",
          lang: 'sql',
          code: `CREATE TABLE card_authorisations (
    auth_id UUID PRIMARY KEY,
    hold_id UUID,               -- once the Core Ledger confirms
    card_id UUID NOT NULL,
    account_id UUID NOT NULL,
    network_lifecycle_id VARCHAR(64) NOT NULL,
    merchant_name VARCHAR(255),
    merchant_category_code CHAR(4),
    original_amount BIGINT NOT NULL,
    original_currency CHAR(3) NOT NULL,
    billing_amount BIGINT NOT NULL,
    billing_currency CHAR(3) NOT NULL,
    quoted_fx_rate NUMERIC(18, 8),
    status VARCHAR(20) NOT NULL,  -- INITIATED, APPROVED, DECLINED,
      -- CLEARING_SUBMITTED, CLEARED, EXPIRED
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
          note: "The owner's DDL, unchanged, with long comments wrapped. account_id has no foreign key: accounts lives in another service's database.",
        },
        {
          title: 'Steps 1 and 3, in the Card service',
          lang: 'sql',
          code: `-- 1. record the request before asking the ledger
INSERT INTO card_authorisations (auth_id, card_id, account_id,
  network_lifecycle_id, merchant_name, merchant_category_code,
  original_amount, original_currency, billing_amount,
  billing_currency, status)
VALUES ('a17c0de5-...0610', 'c4d0e8f1-...0144',
  '5f0c2a9e-...081444', 'MCC8K2QX1114', 'NORTHERN OVENS LTD',
  '5046', 64900, 'GBP', 64900, 'GBP', 'INITIATED');

-- 2. PlaceHold(idempotency_key = a17c0de5-...0610)

-- 3. the answer, then the reply to the network
UPDATE card_authorisations
   SET status = 'APPROVED', hold_id = 'b61c9a3e-...0610'
 WHERE auth_id = 'a17c0de5-...0610' AND status = 'INITIATED';
-- or SET status = 'DECLINED' when PlaceHold declines`,
          note: 'Each is its own local transaction in the Card service. A crash between 2 and 3 leaves the row INITIATED with a hold in the ledger: the retry of PlaceHold with the same auth_id returns that hold.',
        },
        {
          title: 'The call, a retry, and a timeout',
          lang: 'text',
          code: `PlaceHold
{ "idempotency_key": "a17c0de5-2b6f-4e19-9d03-000000000610",
  "source_type": "CARD_AUTH",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000610",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081444",
  "amount": 64900, "currency": "GBP",
  "expires_in_seconds": 604800 }
-> { "hold_id": "b61c9a3e-...0610", "status": "HELD",
     "posted": 0, "held": 64900, "available": 435100 }

retry with the same auth_id, any hold_id
-> the same reply: the hold already there; no new event

no reply before the deadline
-> answer the network "declined" (or let it stand in), then
   VoidHold { "source_type": "CARD_AUTH",
              "idempotency_key": "a17c0de5-...0610" }`,
          note: "The hold_id the caller offers is used only the first time; a retry finds the existing hold by (source_type, source_id). VoidHold on a hold that was never placed changes nothing.",
        },
      ],
    },
    {
      id: 'cardbus', from: 'cardsvc', to: 'kafka', d: 'M315,368 V542', label: 'SettleCardTransaction',
      travels: "SettleCardTransaction from the Card service's outbox to the card-settlements topic",
      mode: 'async', via: 'Kafka', chip: 0.5, chipY: 455,
      how: "The Card service writes SettleCardTransaction into its own outbox in the same transaction that marks the authorisation CLEARING_SUBMITTED; its relay publishes it to card-settlements, keyed by account. Back the other way, the Card service reads TransactionPosted and HoldExpired from ledger-events.",
      delivery: "At least once each way. The ledger's settlement worker is safe to repeat because transactions.idempotency_key is unique; the Card service drops any ledger event_id it has already applied for that account.",
      alts: ['A synchronous Settle call to the Ledger API.'],
      ways: [
        { name: 'Outbox and Kafka', chosen: true, what: "The settlement command is a row in the Card service's outbox, committed with CLEARING_SUBMITTED, and published to card-settlements. The Core Ledger's settlement worker consumes it at its own pace.", pros: ['A clearing file of a million lines queues instead of hammering the ledger.', 'No dual write: the command exists if and only if the row changed.', 'The ledger can be down and nothing is lost.'], cons: ['Settlement is not instant: the ledger posts when the worker gets there.', 'A second outbox and relay to run.'] },
        { name: 'A synchronous Settle call', what: 'The Card service calls the Ledger API for each clearing line and waits.', pros: ['Simpler: no topic, no worker.', 'The result is known at once.'], cons: ['A big clearing file becomes a burst of synchronous calls.', 'A crash between the call and the status update needs its own recovery.'] },
      ],
      reply: {
        id: 'cardnews', label: 'TransactionPosted',
        how: "TransactionPosted (with the hold_id it captured) or HoldExpired, read from ledger-events by the Card service's consumer group. It marks the authorisation CLEARED or EXPIRED.",
        delivery: 'At least once; the Card service skips an event_id at or below the last it applied for that account.',
      },
      examples: [
        {
          title: 'Clearing arrives: one local transaction in the Card service',
          lang: 'sql',
          code: `BEGIN;
UPDATE card_authorisations SET status = 'CLEARING_SUBMITTED'
 WHERE auth_id = 'a17c0de5-...0610' AND status = 'APPROVED';
INSERT INTO card_outbox (event_type, account_id, payload)
VALUES ('SettleCardTransaction', '5f0c2a9e-...081444',
        '{"auth_id": "a17c0de5-...0610", ...}');
COMMIT;`,
          note: "card_outbox is the Card service's own outbox, in its own database; its relay publishes to card-settlements. A stand-in approval has no APPROVED row; it is matched as a clearing with no hold.",
        },
        {
          title: 'Message value: SettleCardTransaction',
          lang: 'json',
          code: `{
  "type": "SettleCardTransaction",
  "auth_id": "a17c0de5-2b6f-4e19-9d03-000000000610",
  "hold_id": "b61c9a3e-0f47-4d2a-8c55-000000000610",
  "idempotency_key": "settle:a17c0de5-...0610",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900611",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081444",
  "amount": 64900, "currency": "GBP",
  "clearing_account": "MASTERCARD_CREDIT_CLEARING_GBP",
  "merchant_name": "NORTHERN OVENS LTD",
  "merchant_category_code": "5046",
  "network_lifecycle_id": "MCC8K2QX1114"
}`,
          note: 'The Card service makes the transaction id and the key from the auth_id, so a re-sent command carries the same key.',
        },
        {
          title: 'TransactionPosted comes back: the Card service marks CLEARED',
          lang: 'sql',
          code: `-- in the Card service, on TransactionPosted for hold ...0610
UPDATE card_authorisations SET status = 'CLEARED'
 WHERE hold_id = 'b61c9a3e-...0610'
   AND status = 'CLEARING_SUBMITTED';
-- on HoldExpired for a hold still APPROVED:
--   SET status = 'EXPIRED' ... AND status = 'APPROVED'`,
          note: 'Each update names the status it expects, so a repeat changes nothing. A clearing that arrives after HoldExpired still settles: the row moves on from EXPIRED when its TransactionPosted arrives.',
        },
      ],
    },
    {
      id: 'settle', from: 'kafka', to: 'sweeper', d: 'M1100,542 V218', label: 'settle',
      travels: 'SettleCardTransaction, read from card-settlements by the Core Ledger settlement worker',
      mode: 'async', via: 'Kafka', chip: 0.5, chipY: 270,
      how: "The Core Ledger's settlement worker reads card-settlements and, for each command, runs one local transaction: lock the accounts in id order, end the hold as CAPTURED if it is still ACTIVE, insert the header and its entries, and insert TransactionPosted into outbox_events.",
      delivery: "At least once. A redelivered command carries the same idempotency_key, so the header insert does nothing and nothing posts (checked). A hold that already EXPIRED is not released twice: the settlement posts as a force-post (checked).",
      alts: ['Ledger API instances consume the topic themselves.'],
      ways: [
        { name: 'Kafka, read by the settlement worker', chosen: true, what: 'A consumer group inside the Core Ledger Service, partitioned by account, applies each command with one database call, at the rate the cluster can take.', pros: ['A clearing file is a queue, not a spike.', 'Same rules and functions as the Ledger API.', 'Safe to repeat.'], cons: ['Settlement waits for the worker.', 'Lag to watch.'] },
        { name: 'Ledger API instances consume it', what: 'The stateless Ledger API also runs the consumer.', pros: ['One fewer deployment.'], cons: ['Batch work competes with live PlaceHold calls on the same instances.'] },
      ],
      examples: [
        {
          title: 'Settlement worker: one local transaction',
          lang: 'sql',
          code: `-- card 5f0c...081444; MASTERCARD_CREDIT_CLEARING_GBP s7 d41e...0207
BEGIN;
SELECT 1 FROM accounts
 WHERE account_id IN ('5f0c2a9e-...081444', 'd41e7c90-...000207')
 ORDER BY account_id FOR NO KEY UPDATE;
UPDATE pending_holds SET status = 'CAPTURED'
 WHERE source_type = 'CARD_AUTH'
   AND source_id = 'a17c0de5-...0610' AND status = 'ACTIVE';
-- 0 rows if it EXPIRED: then nothing is released; post anyway
WITH hdr AS (
  INSERT INTO transactions (transaction_id, idempotency_key,
    transaction_type, merchant_name, merchant_category_code,
    reference_id)
  VALUES ('7d1f0a52-...900611', 'settle:a17c0de5-...0610',
    'CARD_PURCHASE', 'NORTHERN OVENS LTD', '5046',
    'b61c9a3e-...0610')
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING transaction_id)
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency)
SELECT hdr.transaction_id, v.a::uuid, v.amt, 'GBP'
  FROM hdr, (VALUES ('5f0c2a9e-...081444', -64900::bigint),
                    ('d41e7c90-...000207', 64900::bigint)) v(a, amt);`,
          note: "Continued below. A redelivery inserts no header, so it inserts no entries. But the hold UPDATE comes first: on a redelivery the hold is already CAPTURED, so it finds nothing too.",
        },
        {
          title: 'Settlement worker, continued: the event, then COMMIT',
          lang: 'sql',
          code: `INSERT INTO outbox_events
  (event_type, aggregate_id, account_id, payload)
SELECT 'TransactionPosted', '7d1f0a52-...900611',
       '5f0c2a9e-...081444', '{"hold_id": "b61c9a3e-...0610", ...}'
 WHERE EXISTS (SELECT 1 FROM ledger_entries
                WHERE transaction_id = '7d1f0a52-...900611'
                  AND created_at = now());
COMMIT;   -- the balance check runs here, once
-- card: posted -64900, held 0, available credit 435100
-- redelivered: no header, no entries, no event (checked)`,
          note: "created_at = now() means \"posted by this transaction\", so a redelivery emits no second TransactionPosted. Checked on PostgreSQL 18 (PGlite), with the late case: a hold of 5000 that EXPIRED first, then cleared, posted 5000 with no second release.",
        },
      ],
    },
    {
      id: 'billfeed', from: 'kafka', to: 'billing', d: 'M585,542 V368', label: 'TransactionPosted',
      mode: 'async', via: 'Kafka', chip: 0.5, chipY: 455,
      how: "Billing's consumer group reads ledger-events and keeps only what touches a credit card account: purchases, cash, repayments, fees and its own interest charges.",
      delivery: 'At least once; billing keeps the last event_id it applied per card and skips anything at or below it.',
      alts: ['Billing reads a replica each night.'],
      ways: [
        { name: 'Kafka, ledger-events', chosen: true, what: "Billing reads every TransactionPosted for card accounts and updates its buckets as they arrive.", pros: ['Buckets are current within seconds.', 'No load on the ledger.', 'Replayable after a bug.'], cons: ['A copy that must be reconciled to posted_balance nightly.', 'At least once: dedupe by event_id.'] },
        { name: 'A nightly read of a replica', what: "Each night billing queries a Core Ledger replica for the day's card entries.", pros: ['Reads the record itself.'], cons: ['Heavy queries every night.', 'Tied to the ledger\'s tables.'] },
      ],
      examples: [
        {
          title: "Message value: TransactionPosted for the card purchase",
          lang: 'json',
          code: `{
  "type": "TransactionPosted",
  "event_id": 5530611,
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900611",
  "transaction_type": "CARD_PURCHASE",
  "reference_id": "b61c9a3e-0f47-4d2a-8c55-000000000610",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081444",
  "merchant_name": "NORTHERN OVENS LTD",
  "merchant_category_code": "5046",
  "entries": [
    { "account": "5f0c...081444", "amount": -64900, "currency": "GBP" },
    { "account": "MASTERCARD_CREDIT_CLEARING_GBP/7", "amount": 64900,
      "currency": "GBP" } ],
  "posted": -64900, "held": 0
}`,
          note: 'The same event reaches the Card service (CLEARED) and notifications. event_id is the outbox row id: per account it rises in commit order.',
        },
        {
          title: "In billing's own database: the bucket, and tonight's accrual",
          lang: 'sql',
          code: `INSERT INTO credit_balance_buckets AS b (card_account_id,
  bucket, apr_bps, grace_eligible, balance)
VALUES ('5f0c2a9e-...081444', 'PURCHASE', 1800, true, 64900)
ON CONFLICT (card_account_id, bucket, apr_bps, grace_eligible)
DO UPDATE SET balance = b.balance + EXCLUDED.balance;

-- nightly: balance x APR / 365, in millionths of a penny
UPDATE credit_balance_buckets
   SET accrued_unbilled_interest_micros =
       accrued_unbilled_interest_micros
       + balance * apr_bps * 1000000 / 10000 / 365
 WHERE balance > 0;
-- 64900 x 1800 x 1000000 / 10000 / 365 = 32005479 (about 32p)`,
          note: "A sketch of billing's tables, not the owner's DDL: apr_bps is the APR in basis points, 1800 = 18%, illustrative. Integer arithmetic drops less than a micro a night. Nothing here touches the ledger.",
        },
      ],
    },
    {
      id: 'billpost', from: 'billing', to: 'ledger', d: 'M585,312 V228', label: 'INTEREST_CHARGE',
      mode: 'call', via: 'gRPC', chip: 0.5, cold: true,
      how: "On statement day, if interest is due, billing calls Post on the Ledger API: one INTEREST_CHARGE, card account debited, a row of INTEREST_INCOME_GBP credited. Fees post the same way.",
      delivery: "Safe to repeat: the idempotency_key is made from the card and the statement date, and transactions.idempotency_key is unique.",
      alts: ['A command topic, like the Card service\'s settlements.'],
      ways: [
        { name: 'gRPC Post', chosen: true, what: 'Billing calls Post once per card that owes interest, with a deterministic key, at the statement run.', pros: ['Billing knows at once that the charge posted, before it sends the statement.', 'Same rules as every posting.'], cons: ['A burst at the statement run; billing spreads cards over the day.'] },
        { name: 'A command topic', what: 'Billing writes InterestCharge commands to its outbox and a ledger worker applies them.', pros: ['The statement run never waits on the ledger.'], cons: ['Billing must wait for TransactionPosted before it can send the statement.'] },
      ],
      examples: [
        {
          title: 'Statement day: the charge, as the Core Ledger posts it',
          lang: 'sql',
          code: `-- INTEREST_INCOME_GBP s7  c2e85b71-90aa-4d3f-a6e4-000000000207
-- (card and income row locked in account_id order first)
INSERT INTO transactions (transaction_id, idempotency_key,
  transaction_type)
VALUES ('7d1f0a52-...900612',
  'interest:5f0c2a9e-...081444:2026-12-31', 'INTEREST_CHARGE')
ON CONFLICT (idempotency_key) DO NOTHING;
INSERT INTO ledger_entries
  (transaction_id, account_id, amount, currency) VALUES
 ('7d1f0a52-...900612', '5f0c2a9e-...081444', -812, 'GBP'),
 ('7d1f0a52-...900612', 'c2e85b71-...000207',  812, 'GBP');
-- card -34900 - 812 = -35712; a debit the bank cannot refuse,
-- so no soft test: only the hard floor applies`,
          note: "812p is illustrative: 20 days at 32,005,479 micros and 10 days at 17,210,958 = 812,219,160 micros; billing charges 812p and carries 219,160. Had the statement been paid in full in the grace period, nothing would post. If the header insert finds the key, the call stops and returns the first result.",
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
        fix: "The app makes the key k7 (a random UUID) once, before the first attempt, stores it with the draft payment and sends it in the Idempotency-Key header on every attempt. The Banking API stores k7 with a hash of the request on its payment record, so a repeat returns the same payment (step 7). Every call it then makes to the ledger is keyed by that payment, so the ledger's own unique keys refuse a replay for good. The cost: every client must make the key once and reuse it, so the SDKs do it for them.",
      },
      explain: [
        { q: "What is an idempotency key?", a: "A label the app makes once for one payment and sends with every attempt at it. \"Idempotent\" means doing something twice has the same effect as doing it once. Here k7 stands for a version 4 UUID, a value with 122 random bits, so two payments will not pick the same one by chance." },
        { q: "Why does the app make the key, not the bank?", a: "Only the sender knows that two requests are the same attempt. If the bank made a fresh id for each request it received, a resend would get a fresh id too and look like a new payment." },
        { q: "Why 120000 and not 1200.00?", a: "Amounts are stored as whole numbers of the smallest unit, pence for pounds and cents for dollars, with the currency beside them (minor units). Whole numbers add up exactly; decimal fractions in floating point do not." },
        { q: "What does the ledger serve besides this payment?", a: "It is the bank's central ledger: bank payments like this one, payroll, debit and credit card authorisations and settlements, and accounts in several currencies. This tour follows one bank payment. Pick \"Credit card spend\" above the diagram to follow a card purchase through the Card service and Billing." },
        { q: "Which services are there?", a: "Three own money's data, each with its own database. The Core Ledger Service (the Ledger API, its workers and the dashed clusters) owns accounts, holds, headers, entries and outbox_events. The Card service owns card authorisations. Billing owns credit card statements and interest. The Banking API owns bank payments and payroll. They talk by synchronous calls and through Kafka, never by a distributed transaction." },
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
      text: "The Banking API asks the Ledger API to hold the money, so two payments cannot spend the same pounds: PlaceHold, keyed by the payment's id. A hold is a row in pending_holds, not a ledger entry: 120020p, the £1,200 plus a 20p fee, on Bright Bakery's GBP wallet. In one local transaction the Ledger DB locks the wallet row, inserts the hold only if the wallet is open and the money is there, and adds a HoldPlaced row to outbox_events. A trigger raises the wallet's held balance.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn'],
      labels: ['hold £1,200.20', '1 hold row'],
      story: {
        context: "The checks passed. The bakery's GBP wallet has a posted balance of 842000p (£8,420) and nothing held, so 842000p is available. The payment is 120020p in all. Faster Payments has not been asked yet.",
        problem: "Other payments and card authorisations on the same wallet may be in flight. If two of them each read \"£8,420 available\" and then each spend it, the wallet goes below zero. And the payment cannot be posted yet, because the scheme may still reject it.",
        consequence: "Without a hold, the bakery could spend the same money twice and the bank would be lending money it never agreed to lend. If any code path could place a hold without moving held_balance, or move a balance by hand, the caches would drift from the truth and every check built on them would be wrong.",
        fix: "One database transaction, as the ledger_writer role, whose settings give lock_timeout 50 ms and statement_timeout 250 ms: lock the wallet with FOR NO KEY UPDATE; insert hold ...0417 with source_type OUTBOUND_PAYMENT and source_id the payment's id, only if the wallet is OPEN and posted - held - 120020 >= -credit_limit (the wallet's limit is 0), ON CONFLICT (source_type, source_id) DO NOTHING; insert HoldPlaced into outbox_events; commit. The insert fires a trigger that adds 120020 to held_balance, so posted stays 842000 and available drops to 721980. Had the money not been there, nothing would be inserted and the Banking API would record the payment FAILED; the ledger stores no decline. If a path skipped the test, the CHECK valid_available_funds would refuse the row at the hard floor, which for a wallet is also 0. The cost: one extra UPDATE, the wallet row locked about 1 to 2 ms, and a writer that waits 50 ms for the lock gives up and is retried.",
      },
      explain: [
        { q: "What is a hold?", a: "Money set aside for a payment that is not final: a row in pending_holds with an amount, a currency, an expiry, what asked for it (source_type and source_id) and a status, ACTIVE until it is captured, voided or expires. While it is ACTIVE the money cannot be spent, but nothing is in the journal yet." },
        { q: "What stops a second hold for the same payment?", a: "UNIQUE (source_type, source_id). The source is this payment, so a repeated PlaceHold finds the key taken, inserts nothing and emits no second HoldPlaced; the ledger answers with the hold already there. There is no separate table of keys." },
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
        context: "The ledger function has done its work on the primary of the bakery's ledger cluster: hold b61c9a3e-0f47-4d2a-8c55-000000000417 (hold ...0417 from here on), the held_balance the trigger moved and the HoldPlaced row. All that is left is the commit.",
        problem: "The primary is one machine. As soon as it says \"committed\", the Banking API acts on it: it sends £1,200 to Faster Payments. If the hold existed only on that machine's disk and the machine were lost, the hold would go with it.",
        consequence: "The bank would have sent £1,200 with nothing held, and the bakery could spend the same money again before the capture. The books would no longer match the money at the bank.",
        fix: "Each primary streams its write-ahead log to two standbys, s1 and s2, in other zones, with synchronous_standby_names = 'ANY 1 (s1, s2)'. The commit returns once the record is flushed to the primary's own disk and either standby confirms it has flushed it too. The cost: assume about a millisecond more per commit, which also lengthens every hot row's lock. If both standbys are lost, commits wait, and this design stops writes on that cluster rather than drop to asynchronous replication.",
      },
      explain: [
        { q: "What is the primary, and what is a ledger cluster?", a: "The primary is the one copy of a cluster's database that accepts writes. A ledger cluster is one PostgreSQL primary with two synchronous standbys and read replicas, with its workers: the dashed frame, Core Ledger × 4. Phase 1 is one cluster; phase 2 splits businesses across more, 4 at this page's peak." },
        { q: "What is a synchronous standby?", a: "A full second copy of the database, on another machine, that receives the primary's log as it is written. The primary waits for its \"saved\" before finishing a commit. If the primary dies, a standby is promoted (step 13)." },
        { q: "What is another zone?", a: "An availability zone: a separate data centre in the same cloud region, with its own power and network. A whole region can still be lost, which is a separate trade-off." },
        { q: "What is the log record?", a: "Postgres writes every change first to its write-ahead log (WAL), an append-only file, and only then to the tables. The commit record in that log is what makes the hold permanent." },
        { q: "Where is the hold confirmed?", a: "In the Ledger DB, when the transaction commits. The Ledger API replies to the Banking API with HELD and the wallet's figures: posted 842000, held 120020, available 721980. The Banking API records the payment as PENDING, held." },
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
        { q: "How does a card payment fit this?", a: "The other way round: the card network asks the bank, through the Card service, which calls the same PlaceHold. For USD 100.00 the network sends the billing amount in pounds, 8000p, and the bank holds 8240p with a buffer. The clearing a day or two later comes back through Kafka and the settlement worker captures it. If none comes by expires_at, the expiry job ends the hold. The \"Credit card spend\" story follows one." },
        { q: "Why does the Banking API talk to the scheme, not the ledger?", a: "The ledger only records money. If it called the scheme itself it would wait on an outside network while holding payment state, and a slow scheme would slow every balance read." },
      ],
    },
    {
      title: 'Capture: post the entries',
      text: "Faster Payments accepted, so the Banking API asks the Ledger API to capture the hold. In one statement the Ledger DB marks hold ...0417 CAPTURED, writes the header of transaction ...900418 and three entries that sum to zero: minus 120020p from the wallet, plus 120000p to Faster Payments clearing, plus 20p to fee revenue. Had the scheme rejected the payment, a void would have ended the hold and posted nothing.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['capture k7', '3 entries', 'committed', 'settled'],
      story: {
        context: "The scheme has accepted pay_3fK9, and the Banking API has recorded it as SETTLED on the payment. In the ledger, hold ...0417 is ACTIVE: posted 842000p, held 120020p. The journal has nothing for this payment yet.",
        problem: "The money must be posted once and only once, the hold must end at the same moment, and the record must stay readable for audit. The capture itself can be repeated, by a retry or by a recovery worker, and a void or the expiry job could race it.",
        consequence: "A capture that posted but left the hold ACTIVE would count the payment twice against the wallet. A repeated capture would pay the clearing account twice. A capture and a void both succeeding would post a payment the bank had already given back.",
        fix: "Capture, with the header's idempotency_key fps:out:pay_3fK9. The function first looks for that key (found: return the transaction already posted), locks the wallet, FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7 in account_id order, then runs one statement: a CTE updates the hold to CAPTURED only if it is ACTIVE, the header (transaction_type FPS_OUT, reference_id the hold) is inserted only from that row, ON CONFLICT (idempotency_key) DO NOTHING, and the INSERT of the three entries joins to the header. All happen or none. The hold trigger lowers held_balance by 120020 and the entry trigger lowers posted_balance by 120020: posted 721980, held 0, available unchanged at 721980. A second capture, a late void or the expiry job finds the hold no longer ACTIVE and changes nothing; at COMMIT a trigger checks once that the transaction has two or more entries summing to zero. TransactionPosted goes into outbox_events in the same transaction. The cost: a status that changes, in pending_holds; the journal itself never changes.",
      },
      explain: [
        { q: "What does capture mean?", a: "Turning a hold into settled money: the hold is marked CAPTURED and the entries are posted, in one statement. The amount posted may differ from the hold: a card settlement at a better rate captures a hold of 8240p with entries of 7979p, and the rest is free again." },
        { q: "What is a void?", a: "The other outcome: the hold is marked VOIDED and held_balance falls back. Nothing is posted, so the statement shows no payment and no reversal. A hold leaves ACTIVE exactly once, so a void after a capture changes nothing." },
        { q: "What is a force-post?", a: "A card settlement that arrives with no live hold, or for more than was held. The bank must accept it, so it skips the soft limit and posts as far as the hard floor, ending any live hold in the same transaction. Past the floor, the rest goes to that customer's own receivable account, money the customer now owes." },
        { q: "Why do posted and held both move, and available not?", a: "The money was already counted against the wallet by the hold. At capture it moves from held to posted: held falls by 120020, posted falls by 120020, available stays at 721980." },
        { q: "How is an entry kept from being changed?", a: "A BEFORE UPDATE OR DELETE trigger on ledger_entries raises an error, so the statement fails whoever runs it, and a statement trigger refuses TRUNCATE. Triggers do not stop DROP TABLE, so the ledger's role is also granted only INSERT and SELECT." },
        { q: "What is the header row?", a: "One row in transactions per transaction, the owner's table: its id, a unique idempotency_key, transaction_type, status (POSTED, or REVERSED once a reversal names it), merchant and currency fields, and reference_id, here the hold. The Banking API made the key from the payment, so a replay of the capture, even years later, finds it taken. INV 3318 and the value date stay on the payment record." },
        { q: "Why shard 7?", a: "FPS_CLEARING_GBP and FEE_REVENUE_GBP are busy system accounts, each 16 rows. The Ledger API picks the row by hash(transaction_id) % 16, which came to 7 for ...900418 (step 11)." },
      ],
    },
    {
      title: 'The app retries',
      text: "The phone lost signal before the Banking API's answer arrived, so the app sends the same request again with the same key, k7. The Banking API finds k7 on its payment record and returns that payment, pay_3fK9, without calling the ledger. Had a recovery worker repeated a ledger call instead, the ledger's own unique keys would have placed and posted nothing new. No second hold, no second payment.",
      focus: ['client', 'api'],
      path: ['pay', 'accepted'],
      labels: ['retry, key k7', 'same payment'],
      story: {
        context: "From the owner's side, they pressed Pay and the request timed out. Meanwhile the bank held, sent and captured pay_3fK9. The app knows none of that.",
        problem: "The resend looks exactly like a new request to pay Mill Lane Flour Ltd £1,200. Two retries could even arrive at the same moment.",
        consequence: "Treated as new, it would hold and pay a second £1,200 and take a second 20p fee, and the bank would have to chase the money back.",
        fix: "Two layers, each in the service that owns the record. The Banking API's payment table has a unique key on (client, k7) with the request hash: the retry finds pay_3fK9 and returns it; a different body under k7 is refused. Behind it the ledger has its own guards, keyed by the payment, not by k7: a repeated PlaceHold finds UNIQUE (source_type, source_id) taken and places nothing, and a repeated capture finds the header's idempotency_key taken and posts nothing. If two retries arrive at once, the unique key lets one insert win and the other waits, then finds it. There is no key table in the ledger and nothing to expire.",
      },
      explain: [
        { q: "Why did the app send again at all?", a: "A network call needs a time limit, and after it runs out the app cannot know whether the request arrived. Sending again with the same key is safe, so the app does." },
        { q: "Where is k7 stored?", a: "On the Banking API's payment record, in its own database, with a unique key per client. The saved reply is the payment itself. The ledger never sees k7." },
        { q: "What does the app see?", a: "The same reply as the first time: 201 Created for payment pay_3fK9, status pending. To learn that it has settled, it asks GET /payments/pay_3fK9." },
        { q: "What guards are inside the ledger?", a: "Two, on the tables themselves. UNIQUE (source_type, source_id) on pending_holds refuses a second hold for the same payment or authorisation, and UNIQUE (idempotency_key) on transactions refuses a second posting. Headers are never deleted, so that guard never expires." },
        { q: "And a retried decline?", a: "The ledger stores no decline. A PlaceHold retried after a decline is evaluated again and could succeed if money arrived meanwhile. That is safe: a caller only retries when it never got the first answer, and it records the answer it does get." },
      ],
    },
    {
      title: 'Tell everyone else, safely',
      text: "Other services must hear about the payment, such as the one that notifies the owner. The capture's outbox rows were committed with the entries, so they exist only if money moved. The CDC relay reads them from the database's log and publishes events on ledger-events (a Kafka topic), keyed by account, and the owner gets a notification. There was never a separate write to Kafka that could be lost.",
      focus: ['db', 'relay', 'kafka', 'consumers'],
      path: ['cdc', 'publish', 'notify'],
      labels: ['outbox row', 'event', 'event'],
      pill: [undefined, undefined, 'right'],
      story: {
        context: "Transaction ...900418 has committed, and with it a TransactionPosted row in outbox_events. Nothing else knows yet: not notifications, fraud models, the data warehouse or reconciliation.",
        problem: "The obvious way is to commit to the database and then publish to Kafka. Those are two writes with nothing joining them: a crash between them loses the event, and publishing first could announce a payment that then rolled back. Two-phase commit across both would hold locks across the network.",
        consequence: "The owner would not hear that the payment went, and fraud checks and reconciliation would miss it; or they would act on a payment that never happened.",
        fix: "The relay runs Debezium, which reads the Ledger DB's write-ahead log through a replication slot and receives only committed outbox_events rows, in commit order. Each becomes one event on ledger-events, keyed by the wallet's account_id and carrying the event_id, 5512930. A bank payment makes two events: HoldPlaced and TransactionPosted; a transfer between two customers writes an outbox row for each. Delivery is at least once, so the notifications consumer skips anything at or below the last event_id it applied for that account. The cost: a connector to run, and a slot that holds log on the primary's disk until the relay catches up.",
      },
      explain: [
        { q: "What is CDC?", a: "Change data capture: reading committed changes from the database's own log, in the order they committed, and turning them into events. A change that rolled back never appears." },
        { q: "What is Debezium?", a: "An open-source change data capture tool. It connects to a database's change log, here through Postgres logical decoding, and emits each committed row change as an event with its log position." },
        { q: "What is a replication slot?", a: "Postgres's bookmark for one log reader. It records how far the relay has read and keeps the log from being deleted until then. If the relay stops, log piles up on the primary's disk, so the slot is watched. It is a failover slot, so it survives promotion of a standby (PostgreSQL 17 and later; not run here)." },
        { q: "What is Kafka, and why key by account?", a: "Kafka is a log service: messages are appended to a topic split into partitions, and each reader keeps its own position and can re-read. Messages with the same key go to the same partition, in order, so a hold's events never arrive after its capture's." },
        { q: "What if Kafka is down?", a: "The ledger carries on. Outbox rows wait in the database's log, and the relay catches up when Kafka returns." },
        { q: "Where do queues come in?", a: "In front of the ledger, for work that can wait: payroll runs, payouts, card settlements (the card-settlements topic). A queue absorbs a spike and a worker feeds the ledger at a steady rate. Card authorisations cannot wait, so they never queue." },
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
        { q: "And for a credit card?", a: "The same row shape. The bakery's card has credit_limit 500000 and hard_limit 550000. After a £649.00 purchase and a £300.00 repayment its posted balance is -34900, meaning the bakery owes £349.00, and its available credit is 500000 - 34900 = 465100. Interest accrues nightly in Billing's own tables and reaches the card only on statement day, if at all." },
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
        fix: "Asynchronous replicas serve statements. The first page is the newest 50 ledger_entries rows for the wallet by entry_id, each with its header's type and merchant, found through an index on (account_id, entry_id); the next asks for entry_ids below the last one seen. Not created_at: that is each transaction's start, so two commits can land in the other order. Pending items are the wallet's ACTIVE holds, shown above the entries; a voided payment never appears at all. The cost: a page may lag the primary by about a second.",
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
      text: "Every payment also touches the bank's own accounts, named by rail and currency, such as FPS_CLEARING_GBP and FEE_REVENUE_GBP. Each entry's trigger locks its account row until the commit, so with one row each, every payment would queue behind it. So each is 16 rows, shard_id 0 to 15: this capture hashed to 7. At the end of the day the sweep job moves each set of 16 into a master account.",
      focus: ['ledger', 'db', 'sweeper'],
      path: ['txn', 'sweep'],
      labels: ['20p to fee row 7', '16 into 1'],
      pill: [undefined, 'above'],
      story: {
        context: "In step 6 the capture credited FPS_CLEARING_GBP shard 7 and FEE_REVENUE_GBP shard 7. The wallet's row is touched only by its own payments, but these system accounts are touched by nearly every payment of their rail and currency. Card settlements hit MASTERCARD_DEBIT_CLEARING_GBP and FX_FEE_REVENUE_GBP the same way; credit card spending and interest hit MASTERCARD_CREDIT_CLEARING_GBP and INTEREST_INCOME_GBP; incoming payments hit NOSTRO_BOE_GBP.",
        problem: "The trigger's UPDATE locks the account row until the commit, and the commit waits for a standby in another zone. Assuming 1 to 2 ms a lock, one row takes roughly 500 to 1,000 writes a second (an estimate). One cluster at peak takes about 2,500 payments a second. Fee revenue is never checked for a floor, but the trigger still locks it.",
        consequence: "Payments would queue behind a single row: their 50 ms lock_timeout would fire, they would be retried, and the retries would add load. The cluster's whole payment rate would be capped by one row.",
        fix: "Each system account is a logical account of 16 rows with allow_negative TRUE, and the Ledger API writes to shard_id = hash(transaction_id) % 16: about 156 writes a second on each row at the peak. At the end of the day the sweep job posts one balanced transaction per logical account, locking the master and its 16 rows in account_id order and moving each row's total into the master, keyed by account and date. The cost: masters lag by up to a day, reports sum 17 rows, and with allow_negative TRUE no row can enforce a limit; reconciliation watches them.",
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
        { q: "Does reconciliation check credit cards too?", a: "Inside the ledger, the same way as any account. Billing also keeps its own breakdown of each card balance into buckets, and reconciles their total to the card's posted_balance every night. And a nightly parity job checks that the Card service's authorisations and the Core Ledger's holds and transactions agree one to one." },
        { q: "Why not just fix the wrong entry?", a: "A trigger refuses any update or delete of an entry. A correction is a new transaction, approved by a second person, so the history shows both the mistake and the fix." },
      ],
    },
    {
      title: "When a cluster's primary dies",
      text: "Later, the machine running one cluster's primary dies. A failover tool fences it, so it can take no more writes, and promotes a synchronous standby from step 4 to be the new primary; that standby already holds every hold and transaction anyone was told about. Writes to that cluster pause, with a target of under a minute. Requests that timed out are retried with the same keys, and the table guards make sure none is applied twice.",
      focus: ['db', 'replicas'],
      path: ['wal'],
      labels: ['promote'],
      story: {
        context: "Some time later, one cluster's primary fails: a hardware fault, or its zone going dark. Every business on that cluster has payments in flight, holds waiting for capture and card authorisations arriving, and some clients are waiting for replies that will never come.",
        problem: "Nobody can write to that cluster until a new primary takes over. Some requests committed but their replies were lost; others never committed. The clients cannot tell which is which. Card authorisations cannot wait for the failover.",
        consequence: "If the new primary lacked recent commits, acknowledged holds and payments would vanish. If retries were treated as new requests, payments would be applied twice. A long pause stops every business on that cluster paying anyone.",
        fix: "Because every commit waited for a standby (step 4), a standby holds every acknowledged hold and transaction: recovery point zero, for this one failure. The failover tool fences the old primary, then promotes the standby, aiming for under a minute. The CDC relay resumes from its failover slot on the new primary. Callers retry with the same keys: a write that committed finds its guard (the hold's source, the header's idempotency_key) and returns what is there, and one that did not is applied once. Payroll and payouts wait in their queues. Card authorisations get a fast decline from the Card service, or the network's stand-in rules. The cost: writes to that cluster pause, and promotion needs a failover tool beside Postgres.",
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

  stories: [
    {
      id: 'credit-card',
      name: 'Credit card spend',
      tour: [
        {
          title: 'A tap, and the Card service writes it down',
          text: "Bright Bakery's owner buys an oven part for £649.00 from NORTHERN OVENS LTD with the bakery's credit card. Mastercard sends the bank an authorisation request (an ISO 8583 message) and wants an answer in seconds. The Card service receives it and, before anything else, writes a card_authorisations row with status INITIATED, auth_id a17c0de5-...0610.",
          focus: ['cardnet', 'cardsvc'],
          path: ['iso'],
          labels: ['£649.00, MCC 5046'],
          story: {
            context: "The bakery has a GBP credit card account with the bank, 5f0c2a9e-3d41-4b7e-8c12-000000081444: credit_limit 500000, hard_limit 550000, posted 0, nothing held. The purchase is in pounds, so the billing amount is 64900 too. The network's reference for it is MCC8K2QX1114.",
            problem: "Three things must happen in different places: the network needs an answer, the money must be reserved in the Core Ledger, and the authorisation must be recorded with its merchant details. They live in different services with different databases, and any of them can fail half way.",
            consequence: "If the Card service asked the ledger first and crashed before writing anything, there would be a hold in the ledger and no record anywhere of why. Nobody would know to answer the network or to release the money.",
            fix: "Write first, then ask. The INITIATED row records the request with its auth_id, merchant, MCC 5046 and amounts, in the Card service's own database. From here every step is keyed by that auth_id, so any later step can be repeated safely. The cost: one extra local write on a path measured in milliseconds.",
          },
          explain: [
            { q: "What is the Card service?", a: "The Card Processor Service: it owns card_authorisations and speaks ISO 8583 with the networks. It decides an authorisation by asking the Core Ledger for a hold. It knows merchants and MCCs; the ledger does not." },
            { q: "What is ISO 8583?", a: "The message standard card networks use. A message has a numbered type (an authorisation request, its response, and so on) and numbered fields for the amount, the currencies, the merchant and the network's reference." },
            { q: "What is MCC 5046?", a: "A merchant category code: four digits that say what kind of business the merchant is. It goes on the authorisation and on the ledger header, so statements and fraud models can use it. The code's exact title is not checked here." },
            { q: "Why is the card balance 0 and not 500000?", a: "posted_balance is what has settled: nothing yet. The 500000 is credit_limit, how far below zero the bakery may take the card itself. Available credit is posted - held + credit_limit = 500000." },
          ],
        },
        {
          title: 'PlaceHold, keyed by the auth_id',
          text: "The Card service calls the Core Ledger's PlaceHold synchronously over gRPC: hold 64900 on the card account, source_type CARD_AUTH, idempotency_key = the auth_id. It waits, under a deadline that leaves time to answer the network. The owner's target for the whole path inside the bank is about 50 to 100 ms.",
          focus: ['cardsvc', 'ledger'],
          path: ['placehold'],
          labels: ['PlaceHold 64900'],
          story: {
            context: "The INITIATED row is committed in the Card service. The network is waiting. The Core Ledger is another service, and its data is in the Ledger DB, a different database from the one the Card service just wrote to.",
            problem: "The answer is needed now, so this cannot go through a queue. But a synchronous call can time out, and the Card service may then call again without knowing whether the first call placed a hold.",
            consequence: "Without a key, a retried call would place a second hold of 64900 and take 129800 off the bakery's available credit for one purchase.",
            fix: "PlaceHold carries the auth_id as its idempotency key, and the ledger stores it in the hold itself as source_id. pending_holds has UNIQUE (source_type, source_id), so the same auth_id can never hold twice. The cost: the Core Ledger is on the authorisation hot path, so its latency is the card's.",
          },
          explain: [
            { q: "Why synchronous here, when settlement is not?", a: "The network needs yes or no in seconds, so the Card service must know the hold is placed before it answers. Settlement can wait minutes, so it goes through Kafka (step 5)." },
            { q: "Why not one transaction across both databases?", a: "That would be distributed two-phase commit: the account row would stay locked while a coordinator talked to another service, and a lost coordinator would leave both waiting. The owner rules it out. Keys and retries do the job instead." },
            { q: "What is gRPC?", a: "A way for one service to call another over the network with a typed contract and a deadline on each call. The Banking API calls the Ledger API the same way." },
          ],
        },
        {
          title: 'One local transaction in the Core Ledger',
          text: "In one local transaction on the ledger cluster: lock the card account row FOR NO KEY UPDATE; check 0 - 0 - 64900 >= -500000, so there is credit; insert hold b61c9a3e-...0610 (a trigger raises held_balance to 64900); insert HoldPlaced into outbox_events. It commits once a standby in another zone has the record.",
          focus: ['ledger', 'db', 'replicas'],
          path: ['txn', 'wal', '<wal', 'committed'],
          labels: ['lock, check, hold', 'log record', 'confirmed', 'committed'],
          story: {
            context: "The Ledger API has the call and has turned it into one call to ledger_place_hold on the bakery's cluster, as the ledger_writer role (lock_timeout 50 ms, statement_timeout 250 ms).",
            problem: "Another authorisation on the same card could arrive at the same moment, and both could see 500000 available. The hold, the balance and the event must also agree: a hold without its event, or an event without its hold, would leave other services wrong.",
            consequence: "Two purchases could together pass the limit, and the bank would be lending more than it agreed. An event lost after the commit would leave the app and the fraud models blind.",
            fix: "The row lock makes writers to this card go one at a time; the conditional insert tests the soft limit (credit_limit) under that lock; ON CONFLICT (source_type, source_id) DO NOTHING makes a repeat harmless; and HoldPlaced is a row in the same transaction, so it exists only if the hold does. Checked as one statement chain on PostgreSQL 18. After: posted 0, held 64900, available credit 435100. The cost: the card row locked for 1 to 2 ms.",
          },
          explain: [
            { q: "Which limit is tested here?", a: "credit_limit, the soft limit: posted - held - 64900 >= -500000. The database's own CHECK is at hard_limit, 550000, for debits the bank cannot refuse, such as interest. The customer's own spending stops at 500000." },
            { q: "What is outbox_events?", a: "The Core Ledger's outbox table. Each event to publish is a row written in the same transaction as the change; a relay reads committed rows from the log and publishes them to Kafka. The bakery's app will show the purchase as pending from this HoldPlaced." },
            { q: "Why wait for a standby?", a: "So that nothing the network is told about can be lost: if the primary died now, the standby already holds the hold. Recovery point zero, for one failure at a time." },
          ],
        },
        {
          title: 'Approved, inside the time budget',
          text: "The Ledger API answers HELD with hold ...0610. The Card service updates its row to APPROVED with that hold_id, then answers the network: approved. The bakery's app shows \"£649.00, NORTHERN OVENS LTD, pending\", from the HoldPlaced event.",
          focus: ['ledger', 'cardsvc', 'cardnet'],
          path: ['held', 'approve'],
          labels: ['hold ...0610', 'approved'],
          story: {
            context: "The hold is committed in the Core Ledger. The Card service's row still says INITIATED. The network is still waiting.",
            problem: "The Card service must record the outcome and answer the network, in that order, before the network's time runs out.",
            consequence: "Answer first and crash before recording, and the network has a yes the bank has no record of. Record nothing at all, and tomorrow's clearing has no authorisation to match.",
            fix: "UPDATE card_authorisations SET status = 'APPROVED', hold_id = ...0610 WHERE status = 'INITIATED', commit, then reply. Had PlaceHold declined, the row would say DECLINED instead: the decline is the Card service's record, not the ledger's. The cost: one more local write before the reply.",
          },
          explain: [
            { q: "Why does the Card service store hold_id?", a: "It links the two services' records. The parity job and the settlement both use it: for a card settlement the ledger header's reference_id is this hold_id." },
            { q: "What does pending mean in the app?", a: "An ACTIVE hold. The card's posted balance is still 0; its held balance is 64900, so available credit is 435100. The statement will list it only once it posts." },
            { q: "What if the network had already given up?", a: "It may have declined, or approved under stand-in. The Card service then voids the hold with VoidHold keyed by the auth_id, or lets the clearing arrive as a force-post. Step 11 shows a timeout." },
          ],
        },
        {
          title: 'Two days later, the clearing file',
          text: "Mastercard's clearing file lists MCC8K2QX1114: cleared 64900 GBP. The Card service matches it to the APPROVED row and, in one local transaction, marks it CLEARING_SUBMITTED and writes SettleCardTransaction to its own outbox. Its relay publishes that to the card-settlements topic in Kafka, where the Core Ledger's settlement worker reads it.",
          focus: ['cardnet', 'cardsvc', 'kafka', 'sweeper'],
          path: ['iso', 'cardbus', 'settle'],
          labels: ['clearing line', 'SettleCardTransaction', 'to the worker'],
          story: {
            context: "It is 2026-11-14. The hold has sat ACTIVE for two days, expiring after seven. The clearing file has thousands of lines from every card the bank issues.",
            problem: "Each line must become a posting in the Core Ledger exactly once, and the Card service's status must change with it. A whole file at once would be a burst the ledger does not need to take synchronously.",
            consequence: "A dual write (update the row, then call the ledger) could crash in between: a row marked submitted with nothing posted, or a posting with the row still APPROVED.",
            fix: "The status change and the command are one local transaction in the Card service, through its outbox. The command carries idempotency_key settle:a17c0de5-...0610 and transaction id ...900611, both made from the auth_id, so any repeat is the same command. Kafka holds the file's commands until the ledger takes them. The cost: settlement is minutes, not milliseconds, which clearing allows.",
          },
          explain: [
            { q: "What is a clearing file?", a: "The network's daily batch of the purchases it is settling, each with its own reference, the cleared amount and the billing amount. Clearing is when an authorisation becomes money owed between banks." },
            { q: "Why can the cleared amount differ?", a: "A tip, a hotel bill, or a dollar purchase whose rate moved. Here it is the same. A bigger amount posts anyway (a force-post); a smaller one releases the rest of the hold." },
            { q: "What is card-settlements?", a: "The Card service's own Kafka topic. The Core Ledger reads it; ledger-events goes the other way." },
          ],
        },
        {
          title: 'The settlement worker captures and posts',
          text: "The Core Ledger's settlement worker reads the command and runs one local transaction: lock the card and MASTERCARD_CREDIT_CLEARING_GBP shard 7 in id order; mark hold ...0610 CAPTURED (held back to 0); insert header ...900611 (CARD_PURCHASE, NORTHERN OVENS LTD, MCC 5046, reference_id the hold) and two entries, card -64900 and clearing +64900; insert TransactionPosted.",
          focus: ['sweeper', 'db'],
          path: ['sweep'],
          labels: ['capture, post'],
          pill: ['above'],
          story: {
            context: "The command is on card-settlements, partitioned by the card's account. The hold is still ACTIVE.",
            problem: "Kafka delivers at least once, so the same command may arrive twice. The hold might also have expired, or a void might race the capture.",
            consequence: "A second delivery that posted again would charge the bakery £1,298.00. A capture that posted but left the hold ACTIVE would count the purchase twice against the limit.",
            fix: "The header insert has ON CONFLICT (idempotency_key) DO NOTHING and the entries join to it, so a redelivery posts nothing and writes no second TransactionPosted (checked). The hold ends in the same transaction as the posting. Account rows are locked first, as every path does, so a racing void cannot deadlock. After: card posted -64900, held 0, available credit 435100. The cost: a worker and its lag to watch.",
          },
          explain: [
            { q: "Why shard 7?", a: "MASTERCARD_CREDIT_CLEARING_GBP is a busy system account split into 16 rows. The row is hash(transaction_id) % 16, which came to 7 here, so busy accounts do not queue on one row lock." },
            { q: "Is the purchase now money the bakery owes?", a: "Yes: -64900 on the card account is £649.00 owed to the bank. The clearing account is the bank's debt to Mastercard until Mastercard settles with the bank's nostro." },
            { q: "Why did available credit not change?", a: "It was already counted by the hold. Held fell by 64900 and posted fell by 64900, so posted - held + credit_limit stayed 435100." },
          ],
        },
        {
          title: 'TransactionPosted reaches the Card service',
          text: "The CDC relay reads the committed TransactionPosted row from the ledger's log and publishes it on ledger-events, keyed by the card account. The Card service's consumer reads it and marks the authorisation CLEARED. The Card service's own database (the card_authorisations table, kept inside the Card service box and not drawn separately) now says CLEARED, and the Core Ledger's Ledger DB says POSTED. The two agree, and no transaction ever spanned them.",
          focus: ['db', 'relay', 'kafka', 'cardsvc'],
          path: ['cdc', 'publish', 'cardnews'],
          labels: ['outbox row', 'TransactionPosted', 'mark CLEARED'],
          story: {
            context: "The posting committed in the Core Ledger. The Card service still says CLEARING_SUBMITTED.",
            problem: "The Card service needs to know the posting happened, but the ledger must not call it: a slow Card service would slow the ledger.",
            consequence: "Without the event the authorisation would stay CLEARING_SUBMITTED for ever, and support would see an unfinished purchase that has in fact posted.",
            fix: "The event was a row in the posting's own transaction; change data capture carries it out in commit order. The Card service updates WHERE hold_id = ...0610 AND status = 'CLEARING_SUBMITTED', so a repeated event changes nothing, and it skips any event_id at or below the last it applied for the account. The cost: the Card service is behind by however long the relay and its consumer take.",
          },
          explain: [
            { q: "What is CDC?", a: "Change data capture: reading committed changes from the database's own log, in commit order. Debezium reads outbox_events through a replication slot." },
            { q: "What is event_id?", a: "The outbox row's id. For one account it rises in the order that account's transactions committed, so a reader can drop a repeat by comparing it with the last one it applied." },
            { q: "Who else reads this event?", a: "Billing (next step), notifications and fraud. Each is its own consumer group with its own position in the topic." },
          ],
        },
        {
          title: 'Billing files it, and accrues at night',
          text: "Billing reads the same TransactionPosted and adds 64900 to the card's PURCHASE bucket at its APR tier (18% here, illustrative), grace-eligible. Each night it accrues balance × APR ÷ 365 in millionths of a penny: 32,005,479 micros, about 32p, into accrued_unbilled_interest_micros. Nothing of this touches the ledger.",
          focus: ['kafka', 'billing'],
          path: ['billfeed'],
          labels: ['TransactionPosted'],
          story: {
            context: "The card owes 64900 in the ledger. Interest depends on the kind of balance, its rate and whether the grace period still applies: none of which the ledger knows.",
            problem: "Interest must be worked out every day to be exact, but most of it may never be charged: a statement paid in full in the grace period owes none on purchases.",
            consequence: "Posting interest to the card every night would show charges the customer can still avoid, compound them, eat available credit, and need reversals for everyone who pays in full.",
            fix: "Billing keeps credit_balance_buckets by APR tier and grace eligibility, and accrues nightly in micros in its own tables. The ledger sees interest once, on statement day, as one INTEREST_CHARGE, or not at all. The cost: billing's buckets are a copy, reconciled every night to the card's posted_balance.",
          },
          explain: [
            { q: "What is a micro?", a: "A millionth of a penny. 64900 × 0.18 ÷ 365 = 32.005479 pence, or 32,005,479 micros. Whole pence each night would round away money; micros keep the sum exact until it is charged." },
            { q: "What is an APR tier?", a: "The annual rate a bucket is charged at: purchases at one rate, cash withdrawals at another, a promotion at a third. A card can carry balances in several tiers at once." },
            { q: "What does grace-eligible mean?", a: "The bucket qualifies for the interest-free period: if the statement is paid in full by its due date, its accrued interest is dropped." },
          ],
        },
        {
          title: 'Statement day, then a part repayment',
          text: "On 30 November billing closes the cycle: the statement shows £649.00 due, and no interest, because the purchase is still in its grace period. On 10 December the owner repays £300.00 from the bakery's GBP wallet. The Ledger API posts one CARD_REPAYMENT: wallet -30000, card +30000. The card is at -34900 and available credit is 465100 at once.",
          focus: ['client', 'api', 'ledger', 'db', 'billing'],
          path: ['pay', 'post', 'txn'],
          labels: ['repay £300, key k9', 'Post', '2 entries'],
          story: {
            context: "The statement balance is 64900. The bakery's wallet has money of its own, so the repayment is final the moment it posts.",
            problem: "The ledger must restore credit at once, but which part of the balance the £300 pays off is a regulated question the ledger cannot answer.",
            consequence: "If the ledger split repayments itself it would need billing's rates and rules; if billing did the posting it would need the ledger's locks.",
            fix: "The ledger posts one credit to the card and nothing else. Billing reads the TransactionPosted and runs the waterfall: the owner's order is fees, then interest, then the highest-APR principal; here there is only the purchase bucket, so all 30000 goes there. Paying less than the statement in full means the grace period is lost. The cost: the ledger cannot tell interest from principal; billing keeps that breakdown.",
          },
          explain: [
            { q: "Why is credit restored at once?", a: "The money comes from the bakery's own wallet at this bank, already final. A repayment by Direct Debit or from another bank restores credit only once the money is final." },
            { q: "Does the regulator set the waterfall?", a: "For regulated credit, CONC 6.7.4R sends repayments to the highest-interest balance first (a reviewer's reading). A limited company's card is mostly outside the Consumer Credit Act; a sole trader's is inside, and for those the owner's order must be checked against that rule." },
            { q: "Why is the key k9?", a: "The app made it when the owner drafted the repayment, as it made k7 for the bank payment. The header's idempotency_key is built from it, so a retried repayment posts once." },
          ],
        },
        {
          title: 'Next statement: one INTEREST_CHARGE',
          text: "On 31 December billing charges what it accrued, rounded down to whole pence: 812p. It calls Post on the Ledger API once: INTEREST_CHARGE, card -812, INTEREST_INCOME_GBP shard 7 +812, with the key interest:<card>:2026-12-31. The card goes to -35712. The 219,160 micros left over carry into January.",
          focus: ['billing', 'ledger', 'db'],
          path: ['billpost', 'txn'],
          labels: ['INTEREST_CHARGE 812p', 'card -812, income +812'],
          story: {
            context: "The grace period was lost when the statement was paid in part. Billing has accrued every night in micros.",
            problem: "Interest is a debit the bank must be able to post even if the card is near its limit, and a rerun of the statement job must not charge twice.",
            consequence: "Tested against the soft limit, interest on a full card would be refused. Without a key, a rerun would double the charge.",
            fix: "INTEREST_CHARGE skips the soft test: only the hard floor applies, so it posts even at the limit, up to 550000 (checked earlier with a card at its limit). Its idempotency_key is made from the card and the statement date, so a rerun posts nothing. Illustrative working: 20 days at 32,005,479 micros and 10 days at 17,210,958 = 812,219,160 micros. The cost: interest income reaches the ledger monthly, not daily.",
          },
          explain: [
            { q: "Why is this line shown dashed?", a: "It is off the hot path: billing posts once a month per card. Show it at any time with \"Show recovery and reprocessing paths\"." },
            { q: "Why INTEREST_INCOME_GBP?", a: "The owner's pair: the card owes more, and the bank has earned income. It is a busy system account, so it is split 16 ways like the clearing accounts." },
            { q: "What if the statement had been paid in full?", a: "Billing would drop the accrued micros on the grace-eligible bucket and post nothing. The ledger would never have seen interest at all." },
          ],
        },
        {
          title: 'Failure: the PlaceHold reply is lost',
          text: "Rewind to steps 2 and 3. The hold committed, but the reply never reached the Card service before its deadline. With time left, it calls PlaceHold again with the same auth_id. The ledger's insert finds (CARD_AUTH, a17c0de5-...0610) taken, places nothing, emits no second HoldPlaced, and returns hold ...0610. The Card service marks APPROVED as before.",
          focus: ['cardsvc', 'ledger', 'db'],
          path: ['placehold', 'txn', 'committed', 'held'],
          labels: ['PlaceHold, retry', 'ON CONFLICT: 0 rows', 'existing hold', 'hold ...0610'],
          story: {
            context: "A network blip, or a slow commit, made the first reply arrive after the Card service stopped waiting. The row says INITIATED; the ledger has an ACTIVE hold.",
            problem: "The Card service cannot tell whether the hold was placed. Guessing either way is wrong: no hold means no money reserved; two holds means 129800 taken.",
            consequence: "A new key on retry would hold twice. Giving up without a void would leave 64900 held for seven days for a purchase the network was told no.",
            fix: "Retry with the same key; UNIQUE (source_type, source_id) makes it place nothing new (checked), and the ledger then reads back the hold that is there. If time has run out instead, the Card service answers the network with a decline, records DECLINED and calls VoidHold keyed by the auth_id: it ends the hold if there is one and changes nothing if not. A sweep retries rows left INITIATED by a crash. The cost: VoidHold calls for holds that may not exist.",
          },
          explain: [
            { q: "Is a retried decline remembered?", a: "No: the ledger stores no decline. A PlaceHold retried after a lost decline is evaluated again. That is safe, because the caller retries only when it never got the first answer, and records the one it gets." },
            { q: "What if the Card service crashed instead?", a: "Same answer on restart: its sweep finds the INITIATED row a few seconds old and retries with the same auth_id, then approves or voids depending on what the network was told. The parity job catches anything left." },
          ],
        },
        {
          title: 'Failure: a decline at the limit',
          text: "Later the card is at -480000, nothing held, and another £649.00 purchase arrives. The test is -480000 - 0 - 64900 = -544900, below -500000, so the conditional insert places no hold and no HoldPlaced. The ledger answers INSUFFICIENT_FUNDS; the Card service records DECLINED and the network gets a decline.",
          focus: ['cardsvc', 'ledger', 'db', 'cardnet'],
          path: ['placehold', 'txn', 'committed', 'held', 'approve'],
          labels: ['PlaceHold 64900', '0 rows', 'nothing placed', 'INSUFFICIENT_FUNDS', 'declined'],
          story: {
            context: "The card has 20000 of credit left. The purchase needs 64900.",
            problem: "The hard floor is 550000, so the database's CHECK alone would let this purchase through: -544900 is above -550000.",
            consequence: "Without the soft test, the bakery could spend up to 50000 past the limit it agreed, money meant only for interest, fees and settlements the bank must accept.",
            fix: "The customer's own debit is tested against credit_limit in the conditional insert, under the account lock: 0 rows. The ledger stores nothing; the Card service's DECLINED row is the record. The cost, said plainly: a code path that skipped the soft test would be stopped only at the hard floor, up to hard_limit - credit_limit = 50000 later.",
          },
          explain: [
            { q: "Why two limits?", a: "Some debits are the customer's choice and stop at credit_limit. Others the bank must accept, such as interest, fees and late settlements; they may go as far as hard_limit, which the CHECK enforces." },
            { q: "What if the card were blocked?", a: "With status NO_NEW_SPEND the hold trigger refuses any new hold, whatever the balance, but repayments and settlements of earlier purchases still post." },
          ],
        },
        {
          title: 'Failure: the hold expires, then the clearing arrives',
          text: "Another purchase, auth ...0620, held 5000. No clearing comes within seven days, so the expiry job locks the card, marks the hold EXPIRED (held falls by 5000) and writes HoldExpired; the Card service marks it EXPIRED. Then the clearing arrives late. The settlement worker finds no ACTIVE hold, releases nothing, and posts 5000 anyway.",
          focus: ['sweeper', 'db', 'cardsvc', 'kafka'],
          path: ['sweep', 'cardbus', 'settle', 'sweep'],
          labels: ['expire ...0620', 'late SettleCardTransaction', 'settle', 'post 5000'],
          pill: ['above', undefined, undefined, 'above'],
          story: {
            context: "The merchant settled late, as networks allow. The customer had the 5000 back as available credit for a while.",
            problem: "The settlement is still owed to Mastercard. The hold that would have covered it is gone, and its held_balance already released.",
            consequence: "Releasing the hold a second time would push held_balance below the truth (the CHECK would refuse it below zero). Refusing the posting would leave the bank owing Mastercard with nothing on the card.",
            fix: "The worker's UPDATE ... WHERE status = 'ACTIVE' finds nothing, so no second release; the header and entries still post, as a force-post that only the hard floor limits (checked: the late case posted 5000 with no second release). TransactionPosted then moves the Card service's row on from EXPIRED. The cost: a customer can briefly see credit that a late clearing takes back.",
          },
          explain: [
            { q: "Why does expiry lock the account first?", a: "Every path locks the account row before it touches a hold, so expiry cannot deadlock with a capture or a repayment on the same card (checked under real concurrency)." },
            { q: "Could this go past the hard floor?", a: "If the card were already at its floor, the rest would go to the bakery's own receivable account, never a pooled one." },
          ],
        },
        {
          title: 'Failure: the parity job finds a break',
          text: "At night, reconciliation exports keys from the Card service's replica and the Core Ledger's replica and compares them. One authorisation says APPROVED, but its hold is EXPIRED, not ACTIVE: the Card service's consumer had skipped that HoldExpired after a bad deploy. The job raises a break with an owner; the Card service replays the event and the row becomes EXPIRED.",
          focus: ['recon', 'replicas', 'cardsvc', 'kafka'],
          path: ['cardnews'],
          labels: ['replayed HoldExpired'],
          story: {
            context: "The Card service keeps card_authorisations in its own database (inside the Card service box). The Core Ledger keeps holds and transactions in the Ledger DB. No transaction spans the two. Retries and events keep them in step almost always.",
            problem: "Almost is not enough for money. A lost event, a consumer bug or a crash at the wrong moment leaves them apart, and nothing in either database looks wrong on its own.",
            consequence: "An authorisation stuck at APPROVED would make support think money is still held, and a later clearing would be matched against the wrong state. The other way round, an ACTIVE hold with no APPROVED row would keep the customer's credit held for days.",
            fix: "The owner's self-healing reconciliation: APPROVED authorisations against ACTIVE holds, CLEARED authorisations against POSTED transactions through card_authorisations.hold_id = transactions.reference_id, one to one, both ways. card_authorisations is in the Card service's database and pending_holds and transactions are in the Ledger DB, so no single query can join them: the job exports keys from a replica of each up to a cut-off and compares them in Reconciliation's own database. Breaks are aged first, so events still in flight are not raised. The cost: a job across two services, and a team that owns its breaks.",
          },
          explain: [
            { q: "Why on replicas?", a: "The job reads millions of rows; the primaries are busy taking payments. A replica a second behind is fine, because the job compares up to a cut-off an hour back." },
            { q: "How is it fixed?", a: "In the service that is wrong, by its own normal path: here the Card service re-reads ledger-events from before the deploy. Had the ledger been wrong, a correcting transaction would go through the Ledger API." },
          ],
        },
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
        'Who owns what? This page has the owner\'s three services, each with its own database: the Core Ledger (accounts, holds, headers, entries, outbox_events), the Card service (card_authorisations, the ISO 8583 lifecycle) and Billing (balance buckets, statements, interest, repayment allocation). The Banking API owns bank payments and payroll. No distributed two-phase commit.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Record transactions of two or more entries that sum to zero in each currency, as signed integer minor units, each under a header with a caller-made id and a unique idempotency key. No account holds two currencies.',
        'Hold funds for money in flight, then capture the hold into entries, void it, or let it expire; refuse any hold or payment a customer starts past their credit limit, or on an account that takes no new spend.',
        'Accept postings the bank cannot refuse (interest, fees, settlements larger than a hold, reversals) as far as a hard floor, and book anything past it to that customer\'s own receivable.',
        'Never apply the same request twice, whatever the caller retries: one hold per source, one posting per idempotency key.',
        'Answer a card authorisation inside the network\'s seconds (the owner\'s target is about 50 to 100 ms inside the bank), and settle card clearings asynchronously; prove nightly that the Card service and the ledger agree.',
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
        'Simplified on this page: one bank, sterling rails plus one card network, illustrative FX rates, APRs and fees, chargebacks and disputes stated but not built, and billing\'s tables sketched, not specified.',
      ],
    },
  ],

  numbers: [
    { what: 'Payments', assumption: 'stress case: 1,000 payments a second on average, ten times at peak (payroll, month end, batch files); baseline 100 to 250 a second', result: '86 million a day at the stress load; build for 10,000 a second' },
    { what: 'Write transactions', assumption: 'two per bank payment: place the hold, then capture (or void) it', result: '2,000 a second on average, 20,000 at peak' },
    { what: 'Ledger transactions', assumption: 'one per settled payment (the capture), each with one header row; a void posts none', result: '1,000 a second on average, 10,000 at peak; 86 million headers a day' },
    { what: 'Entries', assumption: 'three per bank payment: wallet, scheme clearing, fee. A card payment abroad is also three (wallet, card clearing, FX fee); a conversion between wallets is four', result: '3,000 a second on average, 30,000 at peak; about 260 million a day' },
    { what: 'Hold writes', assumption: 'two per payment: the insert and the one status change; ended holds deleted by the archive job after 90 days', result: '2,000 a second on average, 20,000 at peak; about 86 million hold rows a day in, and about as many deleted' },
    { what: 'Storage', assumption: 'about 250 bytes an entry, 200 a header and 150 a hold, with indexes (estimates)', result: 'about 65 GB of entries, 17 GB of headers and 13 GB of holds a day: about 95 GB' },
    { what: 'Hot data', assumption: '13 months of entries, 90 days of ended holds, headers kept for good', result: 'about 26 TB of entries and 1.2 TB of holds, plus headers growing 6.3 TB a year: about 34 TB, 8.4 TB a cluster, in the first year' },
    { what: 'Clusters', assumption: "the owner's estimate of 5,000 to 8,000 write transactions a second on one tuned primary; take the low end", result: 'one in phase 1 (the stress average fits, the baseline easily); 20,000 ÷ 5,000 = 4 at the stress peak' },
    { what: 'One hot row', assumption: 'locked by a trigger until a synchronously replicated commit, assume 1 to 2 ms', result: 'estimate: 500 to 1,000 writes a second' },
    { what: 'System accounts', assumption: 'one cluster at peak, 10,000 ÷ 4 = 2,500 payments a second, all on one rail at worst, 16 rows each', result: 'about 156 writes a second on each row (unsplit: 2,500)' },
    { what: 'Wallet row', assumption: 'hold placed (held up), hold ended (held down), one entry (posted down)', result: '3 writes per bank payment on the customer\'s row' },
    { what: 'Trigger cost', assumption: 'one UPDATE per hold change and per entry: 2 + 3 per bank payment; one balance check per transaction at commit', result: '5,000 a second on average, 50,000 at peak; 12,500 a cluster' },
    { what: 'outbox_events', assumption: 'two rows per bank payment (HoldPlaced, TransactionPosted), about 1 KB each, deleted after about a day', result: '2 × 86 million × 1 KB = about 170 GB a day passing through' },
    { what: 'Card authorisations', assumption: '300 a second (assumption), each held about 2 days before clearing; one synchronous PlaceHold each', result: 'about 52 million ACTIVE card holds; an answer in the owner\'s 50 to 100 ms' },
    { what: 'accounts table', assumption: '1.3 million customer rows (wallets per currency, cards), a few hundred system rows, about 130 bytes a row, fillfactor 80, two indexes', result: 'under 300 MB: always in memory' },
    { what: 'Events', assumption: 'HoldPlaced and TransactionPosted: two per bank payment, about 1 KB each', result: '2,000 a second on average (2 MB a second), 20,000 at peak (20 MB a second)' },
  ],

  framings: [
    {
      name: 'Phase 1: one ledger cluster',
      scale: 'from day one to the cluster\'s limit; the reasoned baseline, 100 to 250 payments a second, fits for a long time, and so does the stress average of 2,000 write transactions a second',
      shape: "The three services from day one, each with its own database. For the Core Ledger: one PostgreSQL primary with two synchronous standbys and read replicas, PgBouncer in transaction mode, ledger_entries partitioned by month, pending_holds trimmed by an archive job, the transactions header kept for good, system accounts split 16 ways by shard_id, role-level timeouts, queues and the outbox. The same tables and functions as every later phase.",
    },
    {
      name: 'Phase 2: the same design, more clusters (this diagram)',
      scale: "up to the owner's estimate of about 5,000 to 8,000 write transactions a second a cluster (an estimate); 20,000 at this page's stress peak",
      shape: 'The phase 1 design pushed to its limit, then businesses split across ledger clusters, 4 at this peak, each with its own set of system accounts. A routing directory picks the cluster. A payment within one cluster is one local transaction. A payment between clusters is two local transactions joined by INTERCLUSTER_OUT and INTERCLUSTER_IN, the second driven by the outbox under the same transaction id; the pair must net to zero, and reconciliation watches anything in flight by age.',
    },
    {
      name: 'Phase 3: TigerBeetle for the hot path',
      scale: 'extreme hot-account contention, or far beyond 20,000 write transactions a second',
      shape: "The hot debit and credit path moves to TigerBeetle: accounts and transfers, with pending (two-phase) transfers in place of pending_holds. A transfer has one debit and one credit, so a three-entry capture becomes linked transfers and each currency is its own ledger; there is no credit_limit column, so limits are balance flags and funding transfers; the triggers, guard and CHECK disappear, so those rules move into the Ledger API (reviewers' knowledge, unverified). PostgreSQL stays for user metadata, KYC, billing statements, search and reporting, with no shared transaction between them. The Card service and Billing see no change: PlaceHold and SettleCardTransaction keep their shape.",
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
    { choice: 'Three services or one', a: "The owner's boundaries: Core Ledger, Card service, Billing, each with its own database; the Banking API owns bank payments.", b: 'One ledger service that also holds card authorisations, statements and interest, in one database.', call: 'Three. The ledger stays small and strict: fund reservations, balance enforcement, zero-sum accounting. Card and billing rules change without touching the money service. The price: no transaction across services, so two outboxes, a synchronous call with its retries, and a nightly parity job to prove the sides agree.' },
    { choice: 'Synchronous hold, asynchronous settlement', a: 'PlaceHold is a synchronous gRPC call keyed by the auth_id; SettleCardTransaction goes through the Card service\'s outbox and Kafka to a settlement worker.', b: 'Both synchronous, or both through Kafka.', call: 'Split, as the owner says. An authorisation needs an answer in seconds, so it cannot queue; a clearing file can wait minutes, and a queue turns a million-line file into a steady rate. Distributed two-phase commit is ruled out: locks across the network, and a lost coordinator.' },
    { choice: 'Where the duplicate guards live', a: 'On the tables: UNIQUE (source_type, source_id) on pending_holds, UNIQUE (idempotency_key) on transactions. Saved replies and declines belong to the caller\'s record.', b: 'A separate idempotency_keys table in the ledger, with saved results, kept 72 hours (this evening\'s design).', call: 'On the tables. The guard is the row itself, so it cannot drift from what it guards, and the header\'s never expires. Nothing to expire or store beside them. What is given up: the ledger no longer returns a saved decline; a retried PlaceHold is evaluated again, which is safe because callers retry only when they never got the first answer, and record the one they get.' },
    { choice: 'Nightly parity job', a: 'On replicas, export keys from the Card service and the Core Ledger and compare: APPROVED authorisations to ACTIVE holds, CLEARED authorisations to POSTED transactions (through hold_id = reference_id), one to one.', b: 'Trust retries and events alone.', call: 'The job. Retries and events heal almost everything within seconds, but a lost event, a bug or a crash at the wrong moment leaves the sides apart silently. Finding it the next morning, with an owner, is the owner\'s self-healing step. The price: a job across two databases, and breaks aged so in-flight events are not raised.' },
    { choice: 'A header table', a: "The owner's transactions: one row per transaction, transaction_id made by the caller, UNIQUE (idempotency_key), immutable except POSTED to REVERSED by a reversal, never partitioned, never deleted.", b: 'No header, or a header partitioned by date as the owner\'s scale path says.', call: 'The header, unpartitioned. It is the lasting duplicate guard (a redelivered clearing with the same key posts nothing, checked), and the balance check runs once per transaction on it. Partitioning it would force created_at into both unique keys and the guard would be gone. The price: about 17 GB a day at the stress load, 6.3 TB a year that never shrinks.' },
    { choice: 'Holds and growth', a: 'pending_holds unpartitioned, with UNIQUE (source_type, source_id); an archive job moves ended holds older than 90 days to a month-partitioned history table.', b: 'pending_holds partitioned by month, old months detached and dropped.', call: 'Unpartitioned. A partitioned table needs created_at in its keys, so the same source inserts twice, and ON CONFLICT on the old key errors (42P10). The cost: about 86 million deletes a day for vacuum to clean up.' },
    { choice: 'Lock order', a: 'Every path locks the account rows first, in account_id order, then touches holds.', b: 'Lock in whatever order each path reaches its rows.', call: 'Account first. Void and expiry used to update the hold first and reach the account through the trigger, while capture locked the account first, and a reviewer got a deadlock. With the rule, 200 rounds of capture racing void and 3 seconds of expiry racing repayments gave no deadlock and exact balances. The expiry job works one account per transaction to keep to it.' },
    { choice: 'Bank or e-money firm', a: 'An authorised bank: balances are deposits, FSCS protected, with a Single Customer View on demand.', b: 'An e-money institution: balances are safeguarded funds under CASS 15.', call: 'A bank, stated up front, because it changes words and checks, not the schema. As an e-money firm, reconciliation would add a daily safeguarding check against the safeguarding accounts, and credit cards would be funded from the firm\'s own money.' },
    { choice: 'Credit card interest', a: "Billing accrues nightly in its own tables (accrued_unbilled_interest_micros) and, on statement day, posts one INTEREST_CHARGE: card debit, INTEREST_INCOME_GBP credit; nothing if paid in full in the grace period.", b: 'Daily accrual inside the ledger between INTEREST_RECEIVABLE_GBP and INTEREST_INCOME_GBP (this evening\'s design), or a nightly debit of the card.', call: 'Accrual in billing, as the owner now specifies. The ledger sees interest once a month and never has to reverse an accrual. What is given up: daily interest income in the ledger; finance takes it from billing\'s accruals. A nightly debit of the card lost earlier: it contradicts the grace period, compounds daily and eats available credit.' },
    { choice: 'Repayment allocation', a: "In Billing: credit_balance_buckets by APR tier and grace eligibility; the owner's waterfall is fees, then interest, then highest-APR principal.", b: 'Sub-accounts per card for each bucket, so the ledger itself can say which is which.', call: 'Billing. One card account keeps rows and locks at one per card. The price: the ledger cannot tell interest from principal, so billing keeps that breakdown and reconciles its total to the card\'s posted balance. For regulated credit, CONC 6.7.4R sends repayments to the highest-interest balance first (a reviewer\'s reading); a limited company\'s card is mostly outside the Consumer Credit Act, sole traders and small partnerships inside, so for those the order must be checked against that rule.' },
    { choice: 'allow_negative on system accounts', a: 'TRUE for every split system row, the nostros and receivables, as the owner says for system rows.', b: 'FALSE, with limits per row.', call: 'TRUE. A split row is credited and debited by different payments and can dip below zero while the total is fine, and an asset such as a nostro is negative by the sign rule. The consequence: the CHECK protects nothing on those rows, so their limits are reconciliation\'s job.' },
    { choice: 'Currencies', a: 'One account per currency; a transaction sums to zero per currency; conversions between a customer\'s wallets go through a pool account per currency.', b: 'A single cross-currency entry carrying a rate.', call: 'Per currency. Every sum stays exact in its own unit. A sterling card\'s foreign purchase never reaches the pools: the network bills in pounds. The pools drift and treasury rebalances with real trades; the rate lives on the payment record and the event.' },
    { choice: 'Hot accounts', a: '16 rows by shard_id, swept at end of day.', b: 'Continuous sweeps every minute, or an asynchronous balance for credit-only accounts.', call: 'End-of-day sweeps of split rows. The sum is always exact, so sweeping is tidiness; once a day is one lock per row instead of 1,440.' },
    { choice: 'Timeouts', a: "ALTER ROLE ledger_writer SET lock_timeout = '50ms' and statement_timeout = '250ms', plus a client deadline; batch roles get longer values.", b: "SET LOCAL inside the ledger function, or no timeouts.", call: 'On the role. SET LOCAL statement_timeout inside the function does not time that call, because the timer starts when the client\'s statement arrives; the role setting does (checked: cancelled at 251 ms). A timeout rolls back and returns TIMEOUT; the caller retries with the same key. Only the client deadline bounds a COMMIT waiting for a standby.' },
    { choice: 'Concurrency control', a: 'Pessimistic: lock the account rows in account_id order with FOR NO KEY UPDATE, then one conditional statement, in one database call.', b: 'Optimistic: version check and retry on conflict.', call: 'Pessimistic. Optimistic retries collapse exactly when an account is busy, and the lock lasts only 1 to 2 ms because it never waits on the network.' },
    { choice: 'Partitioning the journal', a: 'ledger_entries by month on created_at.', b: 'Unpartitioned, keys as written.', call: 'Partition it, and say what it costs: its unique key must include created_at, which differs on every insert, so UNIQUE (transaction_id, account_id, created_at) guards nothing. The guard is the unpartitioned header\'s UNIQUE (idempotency_key).' },
    { choice: 'Events', a: 'outbox_events rows in the same transaction, one per customer account touched, read by CDC; consumers dedupe on event_id. The Card service has its own outbox the same way.', b: 'Two-phase commit, or publish after commit.', call: 'Outbox. 2PC holds locks across the network; a dual write loses or invents events on every crash.' },
    { choice: 'Database', a: 'PostgreSQL in phases 1 and 2, TigerBeetle for the hot path in phase 3.', b: 'TigerBeetle from day one.', call: 'PostgreSQL first, up to the owner\'s estimate of about 5,000 to 8,000 write transactions a second a cluster: the team knows it and one database gives one transaction. Moving later shifts accounts, transfers and holds to TigerBeetle and leaves metadata, KYC, billing and reporting in PostgreSQL. What you give up: no transaction spans both, the triggers and CHECK become Ledger API rules, and multi-leg postings become linked transfers.' },
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
    { name: 'A clearing file is re-sent after 10 days', what: "The Card service finds the authorisations already CLEARING_SUBMITTED or CLEARED and sends nothing. If a bug sends SettleCardTransaction again anyway, its idempotency_key (settle:<auth_id>) is taken, so the header insert does nothing and nothing posts (checked). Headers are never deleted, so this holds at any age." },
    { name: 'The Card service crashes after PlaceHold, before APPROVED', what: "The hold committed; the row still says INITIATED; the network may have been told nothing. On restart a sweep finds INITIATED rows older than a few seconds and calls PlaceHold again with the same auth_id: UNIQUE (source_type, source_id) places nothing new and the same hold comes back. If the network has already had a decline or a stand-in answer, the service calls VoidHold by auth_id. The parity job catches anything left: an ACTIVE hold with no APPROVED authorisation." },
    { name: 'PlaceHold times out', what: "The Card service answers the network inside its budget with a decline (or the network stands in), records DECLINED, then calls VoidHold keyed by the auth_id. If the hold was placed, it is voided; if not, VoidHold changes nothing. A stand-in approval later clears as a force-post." },
    { name: 'SettleCardTransaction is delivered twice', what: "The settlement worker's second run finds the hold already CAPTURED, its header insert finds settle:<auth_id> taken, so no entries and no second TransactionPosted (checked)." },
    { name: 'TransactionPosted reaches the Card service late', what: "The authorisation sits at CLEARING_SUBMITTED for longer; money is already right in the ledger. The Card service catches up from its position in ledger-events. If it is still behind at the parity cut-off, the job ages the mismatch before raising it." },
    { name: 'A hold expires, then the clearing arrives', what: "The expiry job marked it EXPIRED and emitted HoldExpired; the Card service marked the row EXPIRED and the customer had the money back. The clearing still settles: the settlement worker's UPDATE finds no ACTIVE hold, so nothing is released twice, and the header and entries post as a force-post, as far as the hard floor (checked)." },
    { name: 'A payment between two clusters crashes between its halves', what: "INTERCLUSTER_OUT committed on the payer's cluster with its outbox row; the payee's half did not. The relay delivers the outbox row again (at least once), and the payee's cluster posts INTERCLUSTER_IN under the same transaction id, which its header refuses if it already posted. Reconciliation checks the pair nets to zero and alerts on anything in flight past an age." },
    { name: 'The same hold is captured twice', what: 'The second capture finds the hold CAPTURED, updates 0 rows and inserts 0 entries. Its key, if repeated, returns the first result; a capture and a void racing end the hold once, whichever commits first, with no deadlock because both lock the account first.' },
    { name: 'A declined payment is retried', what: 'The Banking API recorded the payment FAILED, so the app\'s retry with k7 gets that FAILED payment back; the ledger stores no decline. To try again the user starts a new payment, with a new key. A PlaceHold repeated by a worker that never saw the decline is evaluated afresh, which is safe.' },
    { name: 'Lock timeouts storm on one wallet', what: "A business fires hundreds of payments at once at one wallet row. Each waits at most 50 ms for the lock and then fails with TIMEOUT; callers retry with the same key and back off. Move bulk work (payroll, payouts) onto the queue so it reaches the wallet one at a time; if it is a system row, raise its split from 16 to 32." },
    { name: 'The FX pools drift', what: 'Customers convert pounds to dollars, so FX_POOL_GBP grows and FX_POOL_USD goes negative. Nothing in the database stops it (allow_negative TRUE). Reconciliation reports the position per currency daily; treasury buys dollars and books it as one balanced transaction per currency.' },
    { name: 'A replay arrives in a new month', what: 'On the partitioned journal the unique key includes created_at, which is new on every insert, so it never fires. The unpartitioned header refuses the replayed idempotency_key, whatever the month.' },
    { name: 'A cache disagrees with the journal', what: 'The check finds posted_balance not equal to its snapshot plus later entries, or held_balance not equal to its ACTIVE holds. Suspect a trigger bypassed (session_replication_role = replica). Freeze the account (NO_NEW_SPEND) and rebuild both columns in a reviewed break-glass change, knowing that setting also switches off the append-only triggers and foreign key checks for that transaction; audit who ran it.' },
    { name: 'Interest is charged twice', what: 'Billing reruns a statement day. The INTEREST_CHARGE key is made from the card and the statement date, so the header refuses the second one and nothing posts. A rerun of the nightly accrual is billing\'s own problem: it keeps the last accrual date per bucket.' },
    { name: 'A credit limit is cut below what is used', what: 'Allowed: the CHECK is at hard_limit, not credit_limit. New holds then place nothing until the card is back under the new limit (checked). hard_limit cannot go below credit_limit (refused, checked); to stop spending at once, set NO_NEW_SPEND.' },
    { name: 'Payroll for 5,000 staff who bank here', what: 'One transaction of 5,001 entries, with the balance check once at commit: about 0.7 s on the WASM build of PostgreSQL, over the writer role\'s 250 ms, so it runs as payroll_writer with a longer statement_timeout (5 s, say). Chunks of a few hundred lines through PAYROLL_CLEARING_GBP, each its own balanced transaction, remain the fallback for larger runs.' },
    { name: 'Kafka is down', what: "The ledger is unaffected. Outbox rows wait in the log; the relay catches up. Watch the primary's disk, because the replication slot holds log until it is read." },
    { name: 'FPS clearing is £5 off after settlement', what: 'NOSTRO_BOE_GBP equals the statement, but FPS_CLEARING_GBP is -500 instead of zero. A break is raised with owner, amount and evidence. When the cause is found, a correcting transaction is posted and approved by a second person.' },
    { name: 'A whole region is lost', what: 'Synchronous standbys are in other zones of the same region, so a region loss risks the last seconds sent asynchronously to the other region. Name this trade-off out loud.' },
  ],

  interview: [
    'Open with the model before any boxes: accounts in one currency each, transactions of entries that sum to zero per currency under a header, entries never changed, holds for money in flight. Signed integers in minor units. Say the assumption: we are a bank, balances are deposits. Then the invariants: every currency balances, a customer cannot start a debit past their limit, and nothing goes past the hard floor.',
    'Do the sums early, and say the load is a stress case. 1,000 payments a second average and 10,000 at peak; a bank payment is two write transactions and three entries, so 20,000 write transactions a second at peak, about four clusters against the owner\'s estimate. A reasoned baseline, 100 to 250 a second, fits one. The real limit is one hot row, 500 to 1,000 writes a second.',
    'Draw the three services before the tables: Core Ledger (accounts, holds, headers, entries, outbox_events), Card service (card_authorisations), Billing (buckets, statements, interest), each with its own database. Synchronous PlaceHold for authorisations; outbox and Kafka for settlement; a nightly parity job. No two-phase commit.',
    'Show the tables: the header with a unique idempotency_key, ledger_entries append-only, pending_holds unique per source with a status that changes once, accounts with posted and held kept by triggers, a guard, a soft credit_limit and a hard floor in the CHECK.',
    'Draw the write path: PlaceHold (lock the account, conditional insert ON CONFLICT on the source, HoldPlaced), send, capture as one statement (hold, header, entries) plus TransactionPosted, or void. Say what a void posts: nothing.',
    'Spend your depth on concurrency and hot accounts: account rows first in id order with FOR NO KEY UPDATE, then holds; 50 ms lock_timeout set on the role; system accounts by rail and currency split 16 ways, swept at end of day.',
    'Cards and FX: authorisation is a hold of the network\'s billing amount plus a buffer, settlement comes back through Kafka as entries in pounds, force-posts go to the hard floor and then the customer\'s receivable. Conversions between wallets use the FX pools. Credit: same schema; interest accrues in billing in micros and reaches the ledger once, as INTEREST_CHARGE.',
    'Be ready for the pushes: partitioning makes the journal\'s unique key useless, so the unpartitioned header guards; the soft limit can be bypassed by up to hard_limit - credit_limit; a blocked card still takes repayments; SET LOCAL statement_timeout does nothing inside a function; the Card service crashing between PlaceHold and APPROVED.',
    'Finish with proof and the path ahead: caches equal journal and holds, nostros equal statements, clearing accounts drain to zero, the services agree nightly, then the phases to TigerBeetle and what you give up: no shared transaction.',
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
    { label: 'Brandur Leach: Implementing Stripe-like idempotency keys in Postgres', href: 'https://brandur.org/idempotency-keys', note: 'Keys in the same database, locked while running, 409 on a concurrent retry, 72 hour reaper. The pattern the Banking API uses for k7; the ledger itself now guards with unique keys on its tables.' },
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
    { label: "The owner's specification, fifth pass (12 November 2026)", note: 'Source of the three service boundaries, the new pending_holds, transactions and card_authorisations DDL, PlaceHold, SettleCardTransaction, TransactionPosted, HoldExpired, the nightly parity job, micro-interest accrual and the 50 to 100 ms and 5,000 to 8,000 TPS figures. His accounts DDL repeats the pre-review columns; this page keeps the review\'s version, which he had approved.' },
    { label: 'Expert review of this page (three fintech reviewers, 12 November 2026)', note: 'Source of the two-limit model, status, the header table, account-first locking, role-level timeouts, nostros, card FX and interest accrual. Their tests ran on PostgreSQL 18 (PGlite) and PostgreSQL 16; their own sources are listed below where they gave them.' },
    { label: 'Osborne Clarke: note on the 2021 amendment to CONC 6.7.4R', note: 'Repayments on regulated credit go to the highest-interest balance first. Read by a reviewer, not here; no link recorded.' },
    { label: 'Pay.UK annual report (2025 figures)', note: 'About 5.5 billion Faster Payments in 2025, as quoted in the review brief; not read here.' },
    { label: 'Gunnar Morling: failover slots in PostgreSQL 17', note: 'Logical replication slots that survive failover, and synchronized_standby_slots. Read by a reviewer, not here; no link recorded. The settings were not run on this page.' },
  ],

  glossary: [
    { term: 'Double-entry', also: ['double-entry bookkeeping'], where: 'ledger', text: 'Every movement of money is recorded at least twice: where it came from and where it went. With signed amounts, the entries of one transaction sum to zero in each currency, so money is never created or lost by a write.' },
    { term: 'Entry', also: ['posting', 'ledger entry', 'leg', 'ledger_entries'], where: 'db', see: { id: 'append-log', label: 'Append-only log' }, text: 'One debit or credit to one account: a row in ledger_entries with transaction_id, account_id, a signed amount in minor units (plus a credit, minus a debit), currency and created_at. Settled money only. Entries are only ever inserted.' },
    { term: 'Transaction', also: ['journal entry', 'transfer'], where: 'ledger', text: 'A group of two or more entries that commit together and sum to zero in each currency, under one header row. A bank payment is one (the capture, three entries); a card payment abroad is also three, all in pounds; a conversion between wallets is four in two currencies.' },
    { term: 'Header', also: ['transactions', 'transaction header', 'idempotency_key', 'reference_id'], where: 'db', text: "One row per transaction in the owner's transactions table: a caller-made transaction_id, a UNIQUE idempotency_key, transaction_type, status (POSTED or REVERSED), merchant and currency fields, and reference_id (the hold captured, or the transaction reversed). UNIQUE (idempotency_key) is the lasting duplicate guard. Never partitioned, never deleted." },
    { term: 'Reversal', also: ['REVERSAL', 'REVERSED'], where: 'db', text: "A new transaction of type REVERSAL whose reference_id is the original, with opposite entries. Its insert fires a trigger that sets the original's status to REVERSED: the one change the header allows. A direct status change, or a second reversal, is refused." },
    { term: 'Value date', also: ['value_date', 'business date', 'cut-off', 'end of day'], where: 'sweeper', text: 'The business date a transaction counts for. Not on the owner\'s header: it lives with the service that owns the payment, and per account in account_balances_daily. A cut-off calendar in Europe/London ends each business date. End of day is a date, not a stop.' },
    { term: 'Hold', also: ['pending_holds', 'authorisation hold', 'reservation', 'pending', 'source_type', 'source_id'], where: 'fps', text: 'Money set aside but not settled: a row in pending_holds, ACTIVE until CAPTURED, VOIDED or EXPIRED, naming what asked for it (source_type and source_id). UNIQUE (source_type, source_id) allows one hold per source. It raises the account\'s held_balance, so the money cannot be spent twice, and posts nothing to the journal.' },
    { term: 'Capture', also: ['settle', 'post a hold'], where: 'fps', text: 'Ending a hold as CAPTURED and posting its entries in one statement: both happen or neither. The posted amount may differ from the hold, as when a card settles at a better rate.' },
    { term: 'Void', where: 'fps', text: 'Ending a hold as VOIDED: held_balance falls back and nothing is posted. A rejected bank payment leaves no line on the statement.' },
    { term: 'Hold expiry', also: ['EXPIRED', 'expires_at'], where: 'sweeper', text: 'A job that marks ACTIVE holds past their expires_at as EXPIRED, through a partial index on ACTIVE rows, giving the money back. An expired hold cannot be captured.' },
    { term: 'Force-post', also: ['forced settlement'], where: 'fps', text: 'A card settlement that arrives with no live hold (a stand-in approval, or a hold already EXPIRED), or for more than was held. The bank must accept it: it skips the soft limit, ends any live hold in the same transaction, posts down to the hard floor, and books any rest to that customer\'s receivable.' },
    { term: 'Receivable', also: ['RECEIVABLE', 'owner_account_id'], where: 'db', text: 'A customer\'s own account for what they owe past the hard floor: account_type RECEIVABLE, owner_account_id the customer account, allow_negative TRUE, at most one per owner, opened on first use. Incoming credits clear it first. Never pooled.' },
    { term: 'Posted, held and available', also: ['posted_balance', 'held_balance', 'available balance', 'ledger balance'], where: 'db', text: 'posted_balance is the sum of the account\'s entries; held_balance is the sum of its ACTIVE holds. Available is posted - held + credit_limit: what can still be spent or borrowed.' },
    { term: 'Credit limit', also: ['credit_limit', 'soft limit', 'arranged overdraft'], where: 'db', text: 'The soft limit: how far below zero a customer may take their own account, tested in the hold\'s or payment\'s conditional insert. 0 for a debit wallet, the agreed amount for an overdraft or a credit card. Set by the credit service under column grants.' },
    { term: 'Hard limit', also: ['hard_limit', 'hard floor'], where: 'db', text: 'The floor the database enforces: CHECK (allow_negative OR posted - held >= -hard_limit), with hard_limit >= credit_limit. Postings the bank must accept (interest, fees, settlements, reversals) may go past credit_limit as far as this. Example card: 500000 and 550000.' },
    { term: 'Account status', also: ['status', 'NO_NEW_SPEND', 'CLOSED', 'is_active'], where: 'db', text: 'OPEN, NO_NEW_SPEND or CLOSED, in place of the owner\'s is_active. A hold needs OPEN; only CLOSED refuses entries, and a CLOSED account must be at zero. So a blocked card still takes repayments.' },
    { term: 'Available credit', where: 'db', text: 'For a credit card, posted - held + credit_limit. The bakery\'s card with limit 500000 and posted -34900 has 465100 available.' },
    { term: 'Statement (credit card)', also: ['statement cut-off', 'billing cycle', 'credit_statements'], where: 'billing', text: 'The monthly summary billing produces for a card: what was spent, what is owed and the minimum to pay by a date. The ledger knows nothing of cut-offs; billing works them out from entries.' },
    { term: 'Grace period', also: ['grace-eligible'], where: 'billing', text: 'The time after a statement in which paying the statement in full avoids interest on purchases. Billing\'s rule, not the ledger\'s: a grace-eligible bucket accrues in billing, and the accrual is dropped if the rule is met.' },
    { term: 'Allocation waterfall', also: ['payment allocation', 'CONC 6.7.4R'], where: 'billing', text: 'The order a repayment pays off a card\'s buckets. The owner\'s order: fees, then interest, then highest-APR principal. For regulated credit, CONC 6.7.4R sends it to the highest-interest balance first (a reviewer\'s reading of Osborne Clarke\'s note on the 2021 amendment). Kept by billing; in the ledger a repayment is one credit to the card, after any receivable.' },
    { term: 'Micro-interest', also: ['accrued_unbilled_interest_micros', 'micros', 'accrued interest', 'accrual'], where: 'billing', text: 'Interest accrued nightly by billing in millionths of a penny: balance × APR ÷ 365. At an illustrative 18% on 64900p, 32,005,479 micros, about 32p, a day. Kept in billing\'s tables, never in the ledger, until statement day.' },
    { term: 'APR tier', also: ['apr_bps'], where: 'billing', text: 'The annual rate a bucket is charged at, such as purchases at one rate and cash at a higher one. Billing keeps balances per tier so interest and repayment allocation can work per rate.' },
    { term: 'Bucket', also: ['credit_balance_buckets', 'balance segment'], where: 'billing', text: 'A part of a card\'s balance in billing\'s credit_balance_buckets: by type, APR tier and grace eligibility. The buckets of a card must sum to its posted_balance in the ledger, checked nightly.' },
    { term: 'INTEREST_CHARGE', where: 'billing', text: 'The one posting interest makes in the ledger, on statement day: card account debit, a row of INTEREST_INCOME_GBP credit. Its idempotency_key is made from the card and the statement date. None if the statement was paid in full in the grace period.' },
    { term: 'Service boundary', also: ['Core Ledger Service', 'Card Processor Service', 'Credit Billing Service', 'microservice'], where: 'ledger', text: 'Which service owns which data. Core Ledger: accounts, pending_holds, transactions, ledger_entries, outbox_events. Card service: card_authorisations. Billing: buckets, statements, accruals. Each has its own database; they meet by synchronous calls and through Kafka, never by two-phase commit.' },
    { term: 'card_authorisations', also: ['auth_id', 'network_lifecycle_id', 'INITIATED', 'APPROVED', 'CLEARING_SUBMITTED', 'CLEARED'], where: 'cardsvc', text: 'The Card service\'s table, one row per authorisation and per hold: INITIATED, then APPROVED with its hold_id or DECLINED, then CLEARING_SUBMITTED, CLEARED or EXPIRED. An incremental authorisation is a new row with the same network_lifecycle_id.' },
    { term: 'PlaceHold', also: ['VoidHold'], where: 'cardsvc', text: 'The synchronous call that reserves money: idempotency_key is the source\'s id (auth_id or payment id). One local transaction locks the account, tests funds, inserts the hold ON CONFLICT (source_type, source_id) DO NOTHING and writes HoldPlaced. VoidHold ends it, keyed the same way.' },
    { term: 'SettleCardTransaction', also: ['card-settlements', 'settlement worker'], where: 'cardsvc', text: 'The Card service\'s command, sent through its outbox and the card-settlements topic, to post a cleared purchase. The Core Ledger\'s settlement worker captures the hold (if still ACTIVE), posts the header and entries and writes TransactionPosted, all in one local transaction.' },
    { term: 'HoldPlaced', also: ['HoldVoided'], where: 'kafka', text: 'The event a committed hold writes to outbox_events; HoldVoided when a hold is voided. Both go out on ledger-events.' },
    { term: 'TransactionPosted', where: 'kafka', text: 'The event a posted transaction writes to outbox_events, one per customer account touched, carrying the header and entries. The Card service marks CLEARED on it; Billing updates its buckets; notifications tell the owner.' },
    { term: 'HoldExpired', where: 'sweeper', text: 'The event the expiry job writes for each hold it ends. The Card service marks the authorisation EXPIRED; a clearing that arrives later still posts, as a force-post with nothing released twice.' },
    { term: 'Parity job', also: ['self-healing reconciliation', 'cross-service reconciliation'], where: 'recon', text: 'A nightly job on replicas that checks APPROVED authorisations against ACTIVE holds, and CLEARED authorisations against POSTED transactions (card_authorisations.hold_id = transactions.reference_id), one to one. The two sides are in two databases, so it exports keys from each and compares. Each mismatch is a break.' },
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
    { term: 'Idempotency key', also: ['Idempotency-Key', 'request_hash'], where: 'client', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'A unique value a caller sends with a request so a retry is recognised. The app\'s k7 is stored on the Banking API\'s payment record with a hash of the request. Inside the ledger the keys are columns with unique constraints: pending_holds (source_type, source_id) and transactions.idempotency_key. No separate key table.' },
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
    { term: 'Transactional outbox', also: ['outbox', 'outbox_events', 'event_id'], where: 'relay', see: { id: 'outbox', label: 'Transactional outbox' }, text: 'Writing the event to publish as a row in the same transaction as the change, and publishing it afterwards from that row. The event exists if and only if the change committed. The Core Ledger\'s table is outbox_events; the Card service has its own.' },
    { term: 'Change data capture', also: ['CDC', 'logical decoding', 'Debezium'], where: 'relay', text: 'Reading committed changes from the database\'s own log, in commit order, and turning them into events.' },
    { term: 'Shock-absorber queue', also: ['queue', 'SQS', 'backpressure'], where: 'kafka', see: { id: 'queue', label: 'Queue' }, text: 'A queue in front of the ledger for work that can wait (payroll, payouts, card settlements), fed to it at a steady rate. Card authorisations never queue.' },
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
