import type { Design } from './types';

/**
 * Ledger service, as a high-level design.
 *
 * The question: "Design a ledger service that must ensure strict consistency
 * for account balances while supporting high-frequency transaction writes."
 *
 * The baseline is the ledger of a UK business banking app: about a million
 * business accounts, 1,000 transactions a second on average and 10,000 at peak.
 * Double-entry in Postgres, sharded by business: an append-only ledger_entries
 * journal (a trigger refuses UPDATE and DELETE), and an accounts table whose
 * balance is a cache kept by an AFTER INSERT trigger in the same transaction,
 * guarded against direct edits and held at or above zero by a CHECK constraint.
 * Transfers lock their accounts in id order with FOR NO KEY UPDATE and insert
 * the entries in one conditional statement. Pending payments are balanced
 * transactions through a pending clearing account. Synchronous replication for
 * durability, an outbox read by change data capture for everything downstream,
 * and reconciliation against the bank and the schemes to prove it is right.
 * The alternatives include the previous design (a balance row updated by a
 * conditional statement) and the purpose-built route (TigerBeetle).
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
      built: [
        { name: "Mobile and web apps", what: "The bank's own apps, where a business owner pays suppliers and checks balances. They are the client in this design: they send each request and decide when to send it again.", why: "They are the only party that knows two requests are the same attempt, so they make the idempotency key when the payment is drafted, store it with the draft and reuse it on every retry." },
        { name: "Public API", what: "An HTTPS interface that accounting software and partners call to make payments for a business, instead of a person tapping in the app.", why: "Partners' servers retry too, so the API follows the same rule as the apps: a key per payment in the Idempotency-Key header. A partner whose code makes a new key per retry can still pay twice, which the server cannot detect." },
        { name: "Idempotency key (version 4 UUID)", what: "A random identifier, 122 random bits, made once per payment and sent with every attempt. The ledger stores it with a unique constraint, so a second request with the same key gets the first result.", why: "A UUID needs no coordination with the server and will not collide by chance. Stripe accepts keys of up to 255 characters and suggests UUIDs; the design keeps keys 72 hours, about 80 GB across all shards (two keys a payment: the reserve's and the settle's)." },
      ],
      numbers: [
        { text: 'A version 4 UUID per payment. Stripe accepts keys of up to 255 characters and suggests UUIDs.', from: "Not a sum. The 255-character limit and the advice to use UUIDs are from Stripe's idempotent requests docs, cited on the page. A version 4 UUID has 122 random bits, so two clients picking the same key by chance is not a practical worry." },
      ],
      fails: 'A client that makes a new key on each retry defeats the whole scheme. Generate the key when the payment is drafted, store it with the draft, and reuse it.',
      alternatives: [
        {
          name: 'Client-chosen idempotency key per payment', chosen: true, good: 'The only party that knows two requests are the same attempt is the one that sent them.', cost: 'Every client must get it right, so the SDKs do it for them.',
          what: 'The app makes a UUID when the payment is drafted, stores it with the draft, and sends it as the Idempotency-Key header on every attempt. The ledger stores it with a unique constraint in the same transaction as the entries, for 72 hours.',
          pros: ['Only the sender knows two requests are one attempt, so the sender names it.', 'A retry after a lost reply, like k7 on the tour, returns the saved result and moves no money.', 'The same scheme works for the app, the web app and API partners.'],
          cons: ['Every client must make the key once, before the first attempt, so the SDKs do it for them.', 'A partner whose code makes a new key per retry can still pay twice, and the server cannot tell.', 'Keys must be kept: about 80 GB across all shards for 72 hours.'],
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
      what: 'The edge of the bank. It authenticates the user (strong customer authentication for a payment), checks the payee with Confirmation of Payee, asks fraud and limit services, then runs the payment as a small state machine: reserve in the ledger, send to the scheme, then settle or reverse. The payment record holds the state (PENDING, SETTLED or FAILED); the ledger only shows where the money is. It serves balance and statement reads by calling the ledger.',
      why: 'The ledger should know about money, not about Faster Payments, cards or fraud. Keeping the orchestration and the payment state here lets the ledger stay a small, strict service with one job, and lets its entries stay append-only: a status that changes cannot live on a row that never changes.',
      built: [
        { name: "Strong customer authentication", what: "A legal requirement to confirm the user with two independent proofs when they start an electronic payment, such as the phone and a fingerprint.", why: "Required by the Payment Services Regulations 2017. It runs before the ledger is called, so a failure leaves nothing to undo." },
        { name: "Confirmation of Payee", what: "A UK service that checks the name the user typed against the name on the payee's account, through the payee's bank, and warns on a mismatch.", why: "A payment sent to the wrong or a scammer's account is hard to recover, and the bank may owe up to £85,000 a claim under APP scam reimbursement. Checking first is far cheaper." },
        { name: "Payment workflow (a recorded state machine)", what: "Each payment is a row with a state: PENDING (with the step reached, reserved then sent), SETTLED or FAILED. The API records each step before starting the next.", why: "A crash leaves a named state that a recovery worker can finish, repeating calls with the same idempotency key. With this few states, it needs less machinery than a workflow engine such as Temporal, which would add another system to the money path. It is also where the state belongs: ledger entries are never updated, so they cannot carry a status." },
      ],
      numbers: [
        { text: 'Faster Payments allows up to £1 million a payment; each bank sets its own lower limits.', from: "Not a sum. The scheme limit is from Pay.UK, cited on the page. Each bank sets its own lower limit, so the Banking API checks the bank's limit, not the scheme's." },
        { text: 'APP scam reimbursement covers Faster Payments and CHAPS, up to £85,000 a claim, since 7 October 2024, for consumers, micro-enterprises and charities.', from: "Not a sum. The date, the rails and who is covered are from the PSR page, cited. The words 'per claim' are from the Norton Rose Fulbright summary of PS24/7, also cited, because the PSR page does not say per claim." },
      ],
      fails: 'It crashes between steps. Each step is recorded before the next starts, so a recovery worker resumes the payment from its last state, using the same idempotency key for every call it repeats.',
      alternatives: [
        {
          name: 'Payment state machine, recorded step by step', chosen: true, good: 'Every payment is in a named state (PENDING, SETTLED, FAILED, with the step reached), so a crash leaves something a worker can finish.', cost: 'More code than a straight-line handler, and the states need tests.',
          what: 'Each payment is a row with a state: PENDING while it is reserved and sent, then SETTLED or FAILED. The API records each step before starting the next, so a recovery worker can pick up any payment that stopped, repeating calls with the same idempotency key.',
          pros: ['A crash leaves a named state that a worker can finish.', 'Every ledger call is keyed, so repeating a step is harmless.', 'The states answer what support and audit ask: where is this payment?', 'No extra system on the money path.'],
          cons: ['More code than a straight-line handler.', 'Every state and transition needs tests, above all the timeout after sending.', 'A recovery worker to build and watch.'],
        },
        {
          name: 'A workflow engine (Temporal and similar)', good: 'Retries, timers and resumption come built in.', cost: 'Another system on the money path, and its SDK in every service.',
          what: 'The payment is written as a workflow in a durable execution engine. The engine records each step and resumes the workflow after a crash, so reserve, send and settle or reverse need no hand-written state table.',
          pros: ['Retries, timers and resumption come built in.', 'A wait, such as asking the scheme for status after a timeout, is a timer, not a polling job.', "The engine's history shows every step a payment took."],
          cons: ['Another system on the money path, with its own failover.', 'Its SDK in every service that takes part.', 'Workflow code has rules of its own (it is replayed), which the team must learn.', 'For four states, more machinery than the problem needs.'],
        },
        {
          name: 'Let the ledger call the scheme', good: 'One service fewer.', cost: 'The ledger now waits on an outside network while it holds state, and learns about every rail.',
          what: 'The ledger reserves, sends to Faster Payments, and settles or reverses by itself. The Banking API only authenticates and hands over.',
          pros: ['One service fewer and one hop fewer.', 'Reserve and send live in one place.'],
          cons: ['The ledger waits on an outside network while it holds payment state.', 'It learns every rail: Faster Payments, Bacs, CHAPS and cards.', 'A slow scheme now slows the service that every balance read depends on.'],
        },
      ],
      say: 'The ledger records money. It does not talk to Faster Payments. The payment service owns the conversation with the scheme and the payment\'s state, and drives the ledger through reserve, then settle or reverse.',
    },
    {
      id: 'fps',
      name: 'Faster Payments',
      tech: 'scheme, 24/7',
      x: 310, y: 34, w: 160, h: 56, kind: 'outside',
      what: 'The UK\'s real-time payment scheme, open all day every day. The payment leaves the business\'s account and reaches the payee\'s bank in real time. Bacs (three working days) and CHAPS (high value, same day) are the other bank rails, and cards have their own.',
      why: 'The scheme is outside your control. It can accept, reject or go quiet. The ledger has to represent "we have promised this money but do not yet know the outcome". Here that is money sitting in a pending clearing account.',
      built: [
        { name: "Faster Payments", what: "The UK's real-time payment scheme: the shared system UK banks use to send each other payments in seconds, all day, every day. Up to £1 million a payment at scheme level, raised from £250,000 in 2022; each bank sets its own lower limit.", why: "A business paying a supplier today wants the money there in seconds, any day. Bacs takes three working days and CHAPS is for high values in working hours." },
        { name: "A pending clearing account for the scheme's answer", what: "FPS_PENDING, split into 16 parts per shard. A reserve moves the payment from the wallet into it; a settle moves it on to the scheme settlement account and fee income; a reverse moves it back to the wallet. Each is an ordinary balanced transaction.", why: "Entries are never updated, so \"pending\" cannot be a status on an entry. Moving the money to a clearing account keeps it from being spent twice while the scheme decides, and the clearing account should return to zero: a balance that stays there means a payment is stuck." },
      ],
      numbers: [
        { text: 'Up to £1 million per payment at scheme level, raised from £250,000 in 2022.', from: "Not a sum. From Pay.UK's 2022 press release, cited on the page: up to £1 million from 10 February 2022, up from £250,000." },
      ],
      fails: 'A timeout after sending is the dangerous case: the payment may or may not have gone. Leave the money in FPS_PENDING, ask the scheme for the status using the same payment identifier, and only reverse once you know it failed.',
      alternatives: [
        {
          name: 'Reserve into a pending clearing account, then settle or reverse', chosen: true, good: 'The customer cannot spend the money twice while the scheme decides, every step is an ordinary balanced transaction, and no entry is ever changed.', cost: 'Two ledger transactions per payment, and a reversal shows on the statement when the scheme rejects.',
          what: "A reserve moves 120020p from Bright Bakery's wallet to FPS_PENDING_07. Then the payment goes to Faster Payments. On acceptance a settle moves it from FPS_PENDING_07 to FPS_SETTLEMENT_07 (120000p) and FEE_INCOME_07 (20p); on a confirmed failure a reverse moves it back to the wallet. On a timeout it stays in FPS_PENDING_07 until the status is known.",
          pros: ['The customer cannot spend the money twice while the scheme decides: the wallet balance drops at once.', 'Entries stay append-only: nothing is posted or voided in place.', 'A timeout is safe: the money waits in FPS_PENDING until the scheme answers either way.', 'One query finds stuck payments: any FPS_PENDING part that has not returned to zero for long.'],
          cons: ['Two ledger transactions per payment, reserve and settle, so five entries instead of three.', "There is one balance figure, what can be spent. A 'ledger balance' that ignores pending payments is not stored; the app lists pending payments from the payment records.", 'A rejection shows on the statement as a reserve and a reverse.'],
        },
        {
          name: 'A hold on the account row (pending total and available balance)', good: 'The statement shows no movement until the payment is final, and there are two balances: ledger and available.', cost: 'The hold is a changing total on the row, and entries need a status that changes from pending to posted, so they are no longer append-only.',
          what: "The previous version of this design. The balance row holds posted and pending totals, and available is posted minus pending. A reserve adds 120020 to pending; a post moves it to posted; a void takes it off. The entries carry a status.",
          pros: ['Two balances, ledger and available, as banks usually show.', 'A rejection leaves no reversal on the statement, only a released hold.', 'One fewer account per shard.'],
          cons: ['Entries carry a status that changes, or are written again on post, so the journal is not purely append-only.', 'The balance row carries three totals, each a rule to keep in step.', 'Stuck holds are found by scanning pending entries, not by one clearing balance.'],
        },
        {
          name: 'Post first, reverse on rejection', good: 'One fewer step.', cost: 'The settlement account then holds payments the scheme has not accepted, and nothing in the ledger shows which are undecided.',
          what: 'The payment is moved straight to FPS_SETTLEMENT and fee income before it is sent. If Faster Payments rejects it, a reversing transaction puts the money back.',
          pros: ['One ledger transaction in the usual case, where the scheme accepts.', 'No pending clearing account to watch.', 'The settlement account shows money out at once.'],
          cons: ['The settlement account then holds payments the scheme has not accepted, so reconciliation against the bank sees differences that are only timing.', 'Nothing in the ledger shows which payments are still undecided.', 'A timeout still needs a status check, so the hard case is no simpler.'],
        },
        {
          name: 'Send first, record afterwards', good: 'Fast to build.', cost: 'A crash after sending loses the record of money that has left. Never do this.',
          what: 'The API sends to Faster Payments and writes to the ledger only once the scheme accepts. Nothing is held while the scheme decides.',
          pros: ['Fastest to build.', 'No pending clearing account in the ledger.', 'One ledger write per payment, and only for payments that succeeded.'],
          cons: ['A crash after sending loses the record of money that has left.', 'Nothing stops two payments spending the same balance while both are in flight.', 'Never do this on a ledger.'],
        },
      ],
      say: 'Anything the ledger cannot know yet sits in a pending clearing account. Funds move there before we send, and on to settlement or back to the customer when the scheme answers. The payment record says which state it is in.',
    },
    {
      id: 'ledger',
      name: 'Ledger API',
      tech: 'rules, routing',
      x: 550, y: 200, w: 130, h: 56, kind: 'shared',
      what: "A stateless service in front of the shards. It checks that every transaction balances (signed amounts sum to zero, one currency per transaction), that amounts are whole pence, and that accounts exist and are open. It finds the shard from the business that owns the accounts, makes the transaction's id (a UUID), picks the house sub-account by hashing that id, then sends the whole transaction to the shard as one call to a database function, ledger_transfer.",
      why: 'Rules about money belong in one place. Sending the transaction as a single call means row locks are held only for the time the database itself needs, about 1 to 2 ms with the commit, never across a network round trip.',
      built: [
        { name: "Ledger rules", what: "Checks applied to every transaction: signed amounts (plus for a credit, minus for a debit) sum to zero, every account has the transaction's currency, amounts are whole numbers of pence, and every account exists and is open.", why: "Rules about money belong in one service. If every team linked its own copy, one bad deploy anywhere could unbalance the books. The database checks again: the CHECK on each balance and, optionally, a sum-to-zero trigger at commit." },
        { name: "Routing to 16 shards", what: "A small directory table, one row per business (about a million, tens of megabytes), cached in memory, says which of 16 shards holds that business's accounts.", why: "16 is 10,000 payments a second at peak ÷ an assumed 1,000 a shard = 10, raised for headroom and uneven tenants. Each shard has its own copy of the house accounts, so a payment never leaves its shard and stays one local transaction." },
        { name: "Sub-account picked by hash", what: "House accounts are split 16 ways on each shard: FPS_PENDING_01 to _16, FPS_SETTLEMENT_01 to _16, FEE_INCOME_01 to _16. The Ledger API hashes the transaction id it has just made and takes the remainder after dividing by 16.", why: "Different payments land on different rows, so they rarely wait for each other's locks. The tour's reserve hashed to 07, so it uses FPS_PENDING_07, and its settle uses FPS_SETTLEMENT_07 and FEE_INCOME_07." },
        { name: "One call per transaction (ledger_transfer)", what: "A small PL/pgSQL function on each shard. It inserts the idempotency key, locks the accounts in account_id order with FOR NO KEY UPDATE, inserts the entries in one conditional statement, writes the outbox row and saves the result. The Ledger API calls it once and the transaction commits.", why: "Its two early exits, key already seen and not enough money, happen inside the database, so no lock waits on the network. Ten round trips of 0.5 ms would hold a hot row for 5 ms, about 200 writes a second on it at most." },
      ],
      numbers: [
        { text: 'Routing: business id to one of 16 shards, through a small directory table cached in memory.', from: "16 is from the 'Numbers to have ready' table: 10,000 payments a second at peak ÷ an assumed 1,000 a shard = 10 shards, raised to 16 for headroom and uneven tenants. The directory has one row per business, about a million; at a few tens of bytes a row (assumption) that is tens of megabytes, cheap to cache." },
        { text: 'House accounts (pending clearing, scheme settlement, fee income) exist on every shard, 16 parts each, so a payment never leaves its shard.', from: "A design choice, not a sum. A payment touches one business's wallet plus house accounts; with a copy of each house account on every shard, each transaction stays in one database. Finance sums them across shards and parts." },
        { text: 'Locks held about 1 to 2 ms per transaction: in-database work plus a commit that waits for a standby.', from: "An estimate. From the lock to the commit the function does a few small inserts and updates on rows already in memory (assume well under a millisecond), then the commit waits for one synchronous standby in another zone (assume about a millisecond). Not measured." },
        { text: "TigerBeetle's sum: a lock held across two round trips of 0.5 ms blocks that row for at least 1 ms, so about 1,000 writes a second on one row at most.", from: "From TigerBeetle's 'Rediscovering transaction processing', cited on the page: 2 round trips × 0.5 ms = 1 ms with the row locked; 1 second ÷ 1 ms = 1,000 writes a second on that row, at most. Real locks are held longer, so real figures are lower." },
      ],
      fails: 'It is stateless, so losing an instance loses nothing. A bug here is the real risk: a rule that lets through an unbalanced transaction or a wrong account. The database catches some of it on its own: the CHECK refuses an overdraft and the optional deferred trigger refuses a transaction that does not sum to zero.',
      alternatives: [
        {
          name: 'One database call per transaction (a small function)', chosen: true, good: 'Locks are held for in-database work plus the commit, not for network round trips.', cost: 'Some logic in PL/pgSQL, which needs the same review and tests as application code.',
          what: 'The Ledger API calls ledger_transfer once with the key, the transaction id and the signed entries. The function runs the key insert, the locks in account_id order, the conditional insert and the outbox row, and the transaction commits. No row lock waits on the network.',
          pros: ['Locks last for in-database work plus the commit, about 1 to 2 ms, not for network round trips.', 'One round trip per transaction, so a hot row is limited by the commit, not by the network.', 'The early exits (key seen, not enough money) happen inside the database.', 'The balance arithmetic itself is not in the function: the trigger does it, whoever inserts.'],
          cons: ['Logic in SQL needs the same review and tests as application code.', 'Changing the function is a database deploy: a new version beside the old, then switch callers.', 'Harder to debug and profile than service code.'],
        },
        {
          name: 'Interactive transaction from the service', good: 'All logic in one language, easy to read.', cost: "Each statement is a round trip while locks are held. TigerBeetle's authors saw this cap a central bank switch however much hardware was added.",
          what: 'The service opens a transaction and sends each statement in turn: insert the key, lock the accounts, insert the entries, insert the outbox row, save the result, commit. The trigger still keeps the balances; only the round trips change.',
          pros: ['All logic in one language, easy to read and test.', 'Ordinary driver and ORM tooling.', 'Fine at low load, where locks are rarely contended.'],
          cons: ['Four or five round trips while locks are held.', 'Ten round trips of 0.5 ms hold a row for 5 ms: about 200 writes a second on it, at most.', "TigerBeetle's authors saw this cap a central bank switch however much hardware was added."],
        },
        {
          name: 'A ledger library inside each service', good: 'No extra hop.', cost: 'Every team re-implements the rules, and one bad deploy anywhere can unbalance the books.',
          what: 'Each service that moves money links a shared ledger library and writes to the ledger database itself. There is no Ledger API in between.',
          pros: ['No extra network hop.', 'One fewer service to run and scale.', 'The triggers and the CHECK still protect the balances, whoever writes.'],
          cons: ['Every team runs its own copy of the rules, at its own version.', 'One bad deploy anywhere can post to the wrong account, which no trigger can tell.', 'Every such service needs write access to every shard, and the shard directory.'],
        },
      ],
      say: 'The ledger API refuses anything that does not balance, picks the shard and the sub-account, and sends each transaction to the database as one call so that locks never wait on the network.',
      see: [{ id: 'partitioning', label: 'Partitioning' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'db',
      name: 'Ledger DB',
      tech: 'Postgres primary',
      x: 795, y: 200, w: 190, h: 118, kind: 'node',
      lines: ['entries: append-only', 'accounts: balances', 'idempotency, outbox'],
      what: "The source of truth. ledger_entries holds one row per debit or credit, a signed amount in pence, and is only ever inserted: a trigger refuses UPDATE and DELETE. Each transaction is two or more entries that sum to zero. accounts holds one row per account with its current balance, kept by a trigger that fires on every inserted entry, in the same transaction. A second trigger refuses any other change to balance, and a CHECK constraint keeps customer wallets at or above zero. The idempotency key and an outbox row are written in the same transaction too.",
      why: "Writing the entries, the balance, the key and the event in one local transaction is what makes the balance strictly consistent: a reader never sees entries without their balance change, and a retry never posts twice. Keeping the balance with a trigger means no code path can forget it, and nobody can edit a balance by hand. The CHECK refuses an overdraft whatever code path writes.",
      built: [
        { name: "Postgres", what: "An open-source relational database: tables, SQL, transactions that commit all or nothing, row locks, triggers and constraints.", why: "The team knows it, and at 10,000 payments a second sharded Postgres copes. A purpose-built ledger database such as TigerBeetle is kept for when hot accounts dominate." },
        { name: "Primary", what: "The one copy of each shard's database that accepts writes. Balance checks and balance reads also go to it.", why: "Only the primary is always current, and a balance is used to decide whether money can be spent. Its two synchronous standbys make sure losing it loses nothing." },
        { name: "ledger_entries, append-only", what: "One row per entry: entry_id, transaction_id, account_id, amount (BIGINT pence, plus for a credit, minus for a debit, never zero) and created_at. A BEFORE UPDATE OR DELETE trigger raises an error, so no statement can change or remove an entry. UNIQUE (transaction_id, account_id) stops a transaction posting twice to one account.", why: "Corrections become new transactions, so the history shows both the mistake and the fix. The trigger does not stop TRUNCATE or DROP TABLE, so the ledger's role is also granted INSERT and SELECT only, and archiving runs as a separate role." },
        { name: "accounts, a balance cache", what: "One row per account: account_id (UUID), account_type, allow_negative, balance (BIGINT pence), currency and updated_at. Created WITH (fillfactor = 80): each page is filled only to 80 per cent, leaving room for new versions of its rows.", why: "A balance check reads one row, and the row is the sum of the account's entries, kept exact by the trigger. In PostgreSQL an UPDATE writes a new version of the row. If that version fits on the same page and no indexed column changed, it is a HOT (heap-only tuple) update: no index is touched. balance and updated_at are not indexed, and the free fifth of each page makes room likely." },
        { name: "The two triggers on balance", what: "ledger_entries_apply, AFTER INSERT on each entry: UPDATE accounts SET balance = balance + NEW.amount. accounts_guard, BEFORE UPDATE on accounts: if balance changed and pg_trigger_depth() <= 1, raise an error.", why: "pg_trigger_depth() says how many triggers deep the current statement runs. A direct UPDATE fires the guard at depth 1 and is refused; the entry trigger's own UPDATE fires it at depth 2 and passes. Other columns can still be edited directly. The test has to be inside the guard's function: in a trigger's WHEN clause a direct statement is at depth 0, so <= 1 there would also block the entry trigger." },
        { name: "CHECK (allow_negative OR balance >= 0)", what: "A rule PostgreSQL checks on every row written to accounts. The constraint is named valid_balance. Customer wallets, pending clearing and revenue have allow_negative false; settlement and funding accounts have true.", why: "However a balance is written, it cannot go below zero on a wallet: the statement fails with SQLSTATE 23514 and the transaction rolls back. The conditional insert is the clean 'insufficient funds' path; the CHECK is the backstop." },
        { name: "Sum-to-zero at commit (optional)", what: "ledger_entries_balanced: a constraint trigger, DEFERRABLE INITIALLY DEFERRED, that runs at COMMIT for each inserted entry and raises an error if that entry's transaction does not sum to zero.", why: "This design's addition, a backstop to inserting the whole transaction in one statement. It costs one small query per inserted entry at commit, using the unique index on (transaction_id, account_id). It can be left out if the function is trusted." },
        { name: "Idempotency keys table", what: "One row per idempotency key, with a unique constraint, the transaction id and the saved result, written first in the same transaction as the entries.", why: "Because it commits with the money, a key exists if and only if the money moved, and a retry returns the saved result. Kept 72 hours: about 80 GB across all shards. It is also the guard that holds across date partitions, where the UNIQUE on entries cannot." },
        { name: "Outbox table", what: "A table where the function writes, in the same transaction, the event other services should hear about.", why: "The event then exists if and only if the transaction committed. The CDC relay reads it from the log, so the ledger never writes to Kafka itself." },
      ],
      numbers: [
        { text: 'Assume about 250 bytes an entry with indexes: about 110 GB a day across all shards at 1,000 payments a second.', from: "1,000 payments a second × 5 entries each (2 for the reserve, 3 for the settle) = 5,000 entries a second. × 86,400 seconds = about 430 million entries a day. × 250 bytes = about 110 GB a day. 250 bytes is an assumption: a row of about 80 bytes (two UUIDs, three 8-byte columns and the row header) plus its three indexes." },
        { text: 'Assume 13 months kept hot: about 43 TB in all, about 2.7 TB a shard.', from: "110 GB a day × about 395 days (13 months) = about 43 TB. ÷ 16 shards = about 2.7 TB a shard. 13 months is the page's own assumption, from the 'Numbers to have ready' table (statements, claims windows)." },
        { text: 'The accounts table: under 200 MB across all shards, about 10 MB a shard, always in memory.', from: "About 1 million accounts plus 816 house parts (16 shards × 3 accounts × 17 rows) × about 100 bytes a row (assumption) = about 100 MB. Fillfactor 80 leaves a fifth of each page empty: about 125 MB. Plus about 40 MB for the primary key index (assumption)." },
        { text: 'Each entry costs one extra UPDATE: 5 a payment, about 50,000 a second at peak across all shards.', from: "5 entries a payment × 10,000 payments a second at peak = 50,000 trigger UPDATEs a second, about 3,100 on each of 16 shards. Each is on a row the transaction already holds locked, and is HOT when the page has room, so it touches no index." },
      ],
      fails: 'The primary dies. A synchronous standby already holds every committed transaction, so it is promoted with nothing lost. Writes to that shard pause for the failover, and clients retry with the same keys.',
      alternatives: [
        {
          name: 'Trigger-kept balance, locks in id order, conditional insert', chosen: true, good: 'The database itself refuses a wrong balance whatever code path writes: nobody can forget the update or edit a balance by hand, and the CHECK refuses an overdraft.', cost: 'One extra UPDATE per entry, and logic in the database where application developers may not look.',
          what: "Lock the transaction's accounts with SELECT ... FOR NO KEY UPDATE in account_id order. Then one statement, a CTE, inserts all the entries only if the payer's balance covers the amount. Each inserted entry fires a trigger that adds its amount to the account's balance; the CHECK on accounts is the backstop.",
          pros: ['No code path can forget to move the balance, or move it by hand: the guard refuses a direct edit.', 'The CHECK refuses an overdraft even from a path that skips the pre-check.', 'Locks taken in one order everywhere, so two opposite transfers cannot deadlock.', 'Readers never wait: a plain SELECT reads its own snapshot.'],
          cons: ['One extra UPDATE per entry, inside the same transaction.', 'Logic in triggers, where application developers may not look.', 'A bulk load fires the trigger row by row; a statement-level trigger with a transition table is the alternative for bulk work.', 'A superuser can still bypass triggers (session_replication_role = replica), so that role stays out of reach.'],
        },
        {
          name: 'Conditional update of the balance row in the same transaction', good: 'UPDATE ... SET balance = balance - x WHERE id = a AND balance >= x. One statement checks and writes; under Read Committed a second writer waits, then re-checks the condition.', cost: 'Every code path that inserts entries must remember the matching UPDATE, and a balance can be edited by hand.',
          what: "The previous version of this design. A function updates the balance row with the check in the WHERE clause, then inserts the entries, in the same transaction. If no row matches, the money is not there.",
          pros: ['Check and write are one statement, so no writer can slip between them.', 'Under Read Committed, Postgres waits for a concurrent writer, then re-checks the condition, so two payments cannot both pass.', 'No triggers: everything the write does is in one place.', 'Plain Postgres that the team already knows.'],
          cons: ['The balance is right only if every code path does the UPDATE as well as the insert.', 'Nothing stops someone editing a balance directly.', 'Overdraft is refused by a WHERE clause, not by the database: a path that leaves it out can overdraw.'],
        },
        {
          name: 'Lock with FOR UPDATE instead of FOR NO KEY UPDATE', good: 'The same exclusion between writers of one account. The difference here is small.', cost: 'A stronger lock than needed: it also blocks foreign key checks (FOR KEY SHARE) from tables that only reference accounts.',
          what: 'Read the account rows with SELECT ... FOR UPDATE, check, then insert. A foreign key check takes FOR KEY SHARE on the referenced accounts row; FOR UPDATE conflicts with that, FOR NO KEY UPDATE does not. FOR NO KEY UPDATE is simply the weakest lock that does the job.',
          pros: ['The lock most people know.', 'Correct: writers to one account still go one at a time.'],
          cons: ['Blocks foreign key checks from tables that only reference accounts, such as a payee or limits table.', "Another transaction inserting an entry for the same account waits either way, because the balance trigger's UPDATE needs the row lock, so the gain from the weaker lock is small."],
        },
        {
          name: 'Optimistic: a version column on the account row', good: 'Readers never block. A write says "only if the version is still 41" and fails if it moved. Modern Treasury exposes this as lock_version.', cost: 'Under contention most attempts fail and retry, so it is worst exactly where load is highest.',
          what: 'Read the account row and its version, say 41, without locking. Write only if the version is still 41; if it moved, read again and retry. Modern Treasury exposes this as lock_version.',
          pros: ['No lock held between the read and the write.', 'Lets an API client say "only if nothing changed since I looked".', 'Readers never block (true of the chosen design too).'],
          cons: ['Under contention most attempts fail and retry.', 'Worst exactly where load is highest: the hot accounts at peak.', 'Retry loops eat into the 50 ms target.'],
        },
        {
          name: 'Serializable isolation', good: 'The database finds every anomaly for you.', cost: 'Transactions abort with serialization failures (40001) and must be retried. Retry storms on busy accounts.',
          what: 'Run every ledger transaction at Serializable isolation and let Postgres abort any that could not have happened in some one-at-a-time order. The read, check and write can then be written plainly.',
          pros: ['The database finds every anomaly for you.', 'Simple code: read, check, write.', 'Also guards rules nobody thought to write a condition for.'],
          cons: ['Transactions abort with serialization failures (40001) and must be retried.', 'Retry storms on busy accounts.', 'Postgres must track what each transaction read, which costs memory and CPU.'],
        },
        {
          name: 'No cache: sum the entries on every read', good: 'Nothing to keep in step: the balance is always the sum.', cost: 'A balance check gets slower as history grows, and there is no row to lock, so concurrent payments need another way to queue.',
          what: 'Store only ledger_entries. A balance is SELECT sum(amount) for the account, and a payment locks something else (an account row with no balance) before checking.',
          pros: ['No trigger, no second copy of the truth.', 'Nothing to reconcile between balance and entries.'],
          cons: ['A busy account has hundreds of thousands of entries a year to add up on every check.', 'Archiving old months changes the sum unless a snapshot is kept, which is a cache again.', 'Still needs a lock to stop two payments spending the same money.'],
        },
        {
          name: 'Single writer per account (actor or queue partition)', good: 'No locks at all: one thread owns each account and applies its writes in order.', cost: 'A transfer touches two accounts with two owners, so it becomes a two-step protocol.',
          what: 'Every write for an account goes to the one thread or queue partition that owns it, which applies them in order. No two writers ever meet on a row.',
          pros: ['No locks at all.', "An account is limited by one thread's speed, not by lock waits.", 'The order of writes per account is explicit.'],
          cons: ['A transfer touches two accounts with two owners, so it becomes a two-step protocol.', "The reserve's two entries no longer commit in one transaction.", 'A slow or failed owner stalls every write to its accounts until it is replaced.'],
        },
        {
          name: 'TigerBeetle', good: 'Double-entry and balance limits are built in. Batches of up to 8,190 transfers run on one thread in one round trip, replicated by consensus.', cost: 'A specialised database with its own operations. Account metadata still lives in a general database beside it.',
          what: 'A database built for double-entry: it stores accounts and transfers, with balance limits and pending transfers built in. Batches of up to 8,190 transfers run on one thread in one round trip, replicated by consensus.',
          pros: ['Double-entry, balance limits and two-phase transfers built in.', 'No row locks, so hot accounts stop being a special case.', 'Consensus replication is paid once per batch, not per transfer.'],
          cons: ['A specialised database with its own operations to learn.', 'Account metadata still lives in a general database beside it.', 'At 10,000 a second sharded Postgres copes, so this design keeps it for when hot accounts dominate.'],
        },
      ],
      say: "The journal is append-only and the balance is a cache of it, kept by a trigger in the same transaction. I lock the accounts in id order, insert the entries only if the money is there, and let a CHECK constraint refuse any overdraft that gets past that.",
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
      built: [
        { name: "Two synchronous standbys", what: "Full copies of the shard's database on other machines that receive its write-ahead log; the primary waits for at least one of them to confirm before a commit returns. Postgres: synchronous_standby_names = 'ANY 1 (s1, s2)'.", why: "A ledger cannot lose a payment it has acknowledged: recovery point zero. Waiting for one of two, not both, means losing one standby does not stop writes. The price is assumed to be about a millisecond more per commit." },
        { name: "Write-ahead log (WAL) streaming", what: "Postgres writes every change first to an append-only log and then to its tables. Standbys stay in step by receiving that log as it is written.", why: "It is how stock Postgres replicates, so there is no new database to run. Consensus replication (Raft and similar) would make failover part of the protocol, but needs a database built around it." },
        { name: "Availability zones", what: "Separate data centres in the same cloud region, each with its own power and network.", why: "Standbys in other zones survive the loss of the primary's zone. They do not cover the loss of a whole region, which the design names as a trade-off." },
        { name: "Asynchronous read replicas", what: "Further read-only copies that receive the log without the primary waiting for them. They trail by milliseconds, or seconds under heavy load.", why: "Statements, history and exports read from them, so that load stays off the primary. Balance checks never do, because a copy that trails could show money already spent." },
      ],
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
      what: "Looks after the house accounts that almost every payment touches on a shard: FPS_PENDING (pending clearing), FPS_SETTLEMENT and FEE_INCOME. Each is split into 16 sub-accounts, _01 to _16, picked by hashing the transaction id. Every minute the sweeper moves each FPS_SETTLEMENT and FEE_INCOME sub-account's total into its main account with an ordinary balanced transaction. FPS_PENDING parts are not swept: each holds exactly the money in flight, and a settle or reverse must find it there.",
      why: "Every entry fires the trigger's UPDATE on its account row, and that row stays locked until a synchronously replicated commit, so one row takes one writer at a time: roughly 500 to 1,000 writes a second (an estimate). One shard peaks at about 1,000 payments a second, so a single house row per shard would sit at or past its limit. Revenue accounts are never checked for overdraft, but the trigger still locks them, which is why they are split too.",
      built: [
        { name: "Hot accounts", what: "Accounts that nearly every payment touches: the pending clearing account, the Faster Payments settlement account and fee income, one set on each shard.", why: "One row takes one writer at a time. Locked until a synchronously replicated commit, it manages roughly 500 to 1,000 writes a second (an estimate). One shard at its peak of about 1,000 payments a second writes each of these at least 1,000 times a second, and FPS_PENDING 2,000 (reserve and settle)." },
        { name: "Sub-accounts picked by hash", what: "Each hot account is split into 16 sub-accounts on each shard. The Ledger API picks one by hashing the transaction id, so different payments land on different rows. The settle uses the same number as its reserve.", why: "At 1,000 payments a second a shard, that is about 60 writes a second on each FEE_INCOME and FPS_SETTLEMENT part and about 125 on each FPS_PENDING part, well under one row's estimated limit. If lock waits climb, 16 can go to 32 with nothing else changing." },
        { name: "Periodic sweep", what: "Every minute, one ordinary balanced transaction per swept account locks the main account and its 16 parts in account_id order, debits each part by its balance and credits the main account with the total. Its key is the account and the minute.", why: "Every entry stays synchronous and every balance exact as a sum. The main account alone lags by up to a minute, so reports add the main account and its parts. A rerun of the same minute does nothing." },
      ],
      numbers: [
        { text: 'One shard at peak: about 60 writes a second on each FEE_INCOME and FPS_SETTLEMENT part, about 125 on each FPS_PENDING part.', from: "About 1,000 payments a second a shard at peak (the 'Numbers to have ready' table's assumption) ÷ 16 parts = about 62 writes a second, rounded to 60, for an account written once a payment (fee income in the settle, settlement in the settle). FPS_PENDING is written twice a payment, credited by the reserve and debited by the settle: 2,000 ÷ 16 = 125. Both are well under the 500 to 1,000 a second estimated for one row." },
        { text: "The main account's balance is at most one sweep interval behind; the sum of main plus parts is always exact.", from: 'The sweep runs every minute, so the main account misses at most about a minute of credits. The sum is exact because every entry is written synchronously, in its own transaction, to one of the 16 parts.' },
      ],
      fails: 'If the sweeper stops, nothing is wrong, only untidy: balances sit in sub-accounts. Reports read the main account plus its sub-accounts, so they stay right.',
      alternatives: [
        {
          name: 'Sub-accounts with periodic sweeps', chosen: true, good: 'Spreads the writes, keeps every entry synchronous and every balance exact.', cost: 'Reports must sum sub-accounts, and the split count is a tuning knob.',
          what: "On every shard, FPS_PENDING, FPS_SETTLEMENT and FEE_INCOME are each split into 16 parts. A write picks one by hashing the transaction id: the tour's payment hashed to 07. Every minute a balanced transaction moves each settlement and fee part's total into its main account.",
          pros: ['Spreads about 1,000 writes a second a shard to about 60 a second per row (125 for pending).', 'Every entry stays synchronous and every balance exact as a sum.', 'Ordinary ledger transactions: no new system.', 'Going from 16 to 32 sub-accounts changes nothing else.'],
          cons: ['Reports must sum the main account and its parts, across 16 shards.', 'The split count is a tuning knob to watch.', 'A limit on a split account applies to the sum, which no single row can check.'],
        },
        {
          name: 'No balance kept on revenue accounts, computed later', good: 'Fee income only ever receives credits, so it cannot breach a limit. Append the entry and let a job roll up the balance. Modern Treasury routes hot accounts down an asynchronous path this way.', cost: 'Its balance lags (Modern Treasury applies such entries within 60 seconds), and the trigger must make an exception.',
          what: 'The balance trigger skips accounts marked as rolled up, so a fee entry takes no row lock. A job adds their entries into the balance later. Modern Treasury routes hot accounts down an asynchronous path like this.',
          pros: ['No hot row at all: appends never wait on each other.', 'Simpler than sub-accounts for credit-only accounts.', 'Used in production by Modern Treasury.'],
          cons: ['Its balance lags; Modern Treasury applies such entries within 60 seconds.', "'balance equals the sum of entries' now holds only after the roll-up, so checks must allow for it.", 'FPS_PENDING is debited, so it still needs another answer.'],
        },
        {
          name: 'Batch postings: one aggregated entry per second', good: 'One write per batch on the hot row.', cost: 'The per-payment entries live elsewhere until the batch posts, so the ledger is briefly incomplete.',
          what: "Each payment's share for a hot account is collected for a second, then one aggregated entry per hot account is posted for the batch. The hot row takes one write a second instead of a thousand.",
          pros: ['One write per batch on the hot row.', 'Fewer, larger entries on the house account.', 'Uses the same ledger and tables.'],
          cons: ['The per-payment entries live elsewhere until the batch posts, so the ledger is briefly incomplete.', "A payment's fee is no longer in the same transaction as the payment.", 'A failed batch must be found and posted again as a whole.'],
        },
        {
          name: 'A database built for it (TigerBeetle)', good: 'Applies thousands of transfers to one account per batch on a single thread with no row locks.', cost: 'A new database to adopt and run.',
          what: 'Move the posting engine to a database that applies thousands of transfers to one account in one batch on a single thread. There are no row locks, so a hot account is just an account.',
          pros: ['Thousands of transfers to one account per batch, with no row locks.', 'Balance limits are still enforced on the hot account.', 'No sub-accounts or sweeps for reports to know about.'],
          cons: ['A new database to adopt and run.', 'Account metadata stays in Postgres beside it.', 'A big move to fix three hot accounts; this design waits until hot accounts dominate.'],
        },
      ],
      say: 'Hot accounts are the classic trap. Every entry locks its account row through the trigger, so I split each house account 16 ways per shard and sweep the ones that only collect money.',
      see: [{ id: 'consistent-hashing', label: 'Consistent hash ring' }, { id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'relay',
      name: 'CDC relay',
      tech: 'Debezium',
      x: 1042, y: 350, w: 124, h: 56, kind: 'node',
      what: 'Reads committed outbox rows from the database\'s write-ahead log through a replication slot, and publishes each as an event on the ledger-events topic, keyed by account.',
      why: 'Writing to the database and then to Kafka is two writes with no transaction around them: a crash between them loses an event or announces a payment that rolled back. The outbox row commits with the entries, and the relay publishes only what committed, in commit order.',
      built: [
        { name: "Change data capture (CDC)", what: "Reading committed changes from a database's own log, in commit order, and turning each into an event.", why: "Writing to the database and then to Kafka is two writes with nothing joining them: a crash between them loses an event or announces a payment that rolled back. Polling the outbox table instead can miss or reorder rows from concurrent commits, and adds queries to the primary." },
        { name: "Debezium", what: "An open-source change data capture tool. It connects to a database's change log and emits every committed row change as an event, with the row before and after and its log position. It is commonly run alongside Kafka.", why: "It already does the hard parts: reading Postgres's log through logical decoding, keeping its place in a replication slot, and resuming after a restart. The relay only publishes outbox rows to ledger-events; writing and running a log reader of our own would gain nothing. The cost is a connector to run and upgrade." },
        { name: "Logical decoding and a replication slot", what: "Logical decoding is Postgres turning its write-ahead log back into row changes for an outside reader. A replication slot is the bookmark for one reader: it records how far it has read and keeps the log until then.", why: "Only committed rows arrive, in commit order, and a restarted relay resumes where it left off, repeating at most a little. The catch: a stuck relay makes the slot hold log on the primary's disk, so the slot is watched." },
      ],
      numbers: [
        { text: 'About 2,000 events a second on average; assume about 1 KB each: about 2 MB a second.', from: "One event per committed ledger transaction, and a payment is two (reserve and settle): 1,000 payments a second on average (the 'Numbers to have ready' table) × 2 = 2,000 events a second. × an assumed 1 KB an event (ids, accounts, signed amounts and log position, as JSON) = about 2 MB a second. At the 10,000 payments a second peak, about 20 MB a second." },
      ],
      fails: 'If the relay or Kafka is down, the ledger carries on and events wait in the log. Watch the replication slot: it holds write-ahead log on the primary\'s disk until the relay catches up.',
      alternatives: [
        {
          name: 'Outbox table read by log-based CDC', chosen: true, good: 'Atomic with the entries, in commit order, no polling load.', cost: 'A connector to run, and a replication slot to watch.',
          what: 'The ledger function writes an outbox row in the same transaction as the entries. Debezium reads committed rows from the write-ahead log through a replication slot and publishes them to ledger-events in commit order.',
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
          what: 'The ledger function calls pg_logical_emit_message inside the transaction instead of inserting a row. The message is written only to the log, and the relay reads it through the same slot.',
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
      what: 'One event per committed ledger transaction (a reserve, a settle, a reverse): ids, accounts, signed amounts, the payment reference and the database log position. Keyed by account so each account\'s events stay in order.',
      why: 'Notifications, fraud, analytics, statements search and reconciliation all need to know what happened. A log lets each read at its own pace and replay, without querying the ledger.',
      built: [
        { name: "Kafka", what: "A distributed log service. Producers append messages to a topic, split into partitions; each reader keeps its own position and can re-read from any point the topic still keeps.", why: "Notifications, fraud, analytics, statements search and reconciliation each read at their own pace and can replay after a bug. A queue such as SQS deletes each message once read, so no replay. About 2 MB a second on average is a light load for it." },
        { name: "ledger-events", what: "The one topic the ledger publishes to: one event per committed ledger transaction, with ids, accounts, signed amounts and the database log position.", why: "One topic, not one per event type, so a reverse can never be read before the reserve it undoes." },
        { name: "Keyed by account", what: "Each event's key is the account id. Kafka sends every message with the same key to the same partition and keeps a partition in order.", why: "All of one account's events arrive in commit order, which is all consumers need; there is no order across accounts, and none is needed. A partition holding a busy account can lag behind the others." },
      ],
      fails: 'Delivery is at least once. A relay restart can publish an event twice, so consumers drop anything at or below the last log position they processed for that account.',
      alternatives: [
        {
          name: 'Kafka topic keyed by account', chosen: true, good: 'Ordered per account, replayable, many readers.', cost: 'Partitions and consumer lag to watch.',
          what: "One topic, ledger-events, keyed by account, so each account's events land in one partition and keep their order. Notifications, fraud, the warehouse and reconciliation each read it as their own consumer group.",
          pros: ['Ordered per account.', 'Replayable: a consumer that falls a day behind catches up from the log.', 'Many readers, each at its own pace.', 'About 2 MB a second on average is a light load for Kafka.'],
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
      built: [
        { name: "Notifications", what: "The service that sends the owner a push such as \"£1,200.00 paid, reference INV 3318. Fee 20p.\" within seconds.", why: "It reads ledger-events instead of being called by the ledger, so a slow notification service builds lag, not payment latency. It skips any event at or below the last log position it applied for that account." },
        { name: "Fraud models", what: "Services that score money movements for signs of fraud after the fact, alongside the checks the Banking API makes before a payment.", why: "They need every movement, in order per account, without querying the ledger, so they read the topic." },
        { name: "BI (business intelligence)", what: "The data warehouse and accounting exports that finance and analysts use, loaded in batches.", why: "Batch loads from the topic put no load on the ledger's databases, and a loading bug can be fixed and replayed from the log." },
        { name: "Consumer groups", what: "A Kafka feature: each service reads the topic as its own group and keeps its own position.", why: "Each service goes at its own pace and replays on its own, and adding a new consumer needs no change to the ledger." },
      ],
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
      what: 'Proves the ledger is right in two ways. Inside: every transaction sums to zero, all entries in each currency sum to zero, and each account\'s cached balance equals the sum of its entries (archived period totals plus the entries still in the database). Outside: the ledger\'s view of each settlement and safeguarding account matches the bank statement and the scheme\'s settlement report, every day.',
      why: 'Locks stop races. They do not stop a bug that posts the wrong amount, a missing scheme message, or a bank error. Only comparing against independent truth catches those. For payment and e-money firms, the FCA\'s CASS 15 rules ask for this every business day.',
      built: [
        { name: "Invariant checks", what: "Queries run every few minutes on a replica that must always hold: each transaction and each currency sums to zero, every FPS_PENDING part returns to zero within an age limit, and each accounts.balance equals its archived total plus SUM(amount) of its entries still in the database.", why: "They catch a bug within minutes. One MVCC snapshot on the replica sees a balance and its entries together, because the trigger wrote them in one transaction. With about 2.7 TB a shard, a check works through accounts in batches and leans on idx_ledger_account_created." },
        { name: "account_period_totals", what: "This design's choice for checking after archive: before a month's partition is detached, each account's total for that month is written to a small table, account_period_totals (account_id, period, total).", why: "Once old partitions are gone, SUM(amount) over the hot table is no longer the balance. Archived totals plus the sum of hot entries is. The totals are themselves checked against the archive file's manifest when written." },
        { name: "Rebuilding a balance", what: "If a balance is ever found wrong, the guard trigger refuses any direct fix. Rebuilding it is a reviewed break-glass change: in one transaction, disable accounts_guard, recompute balance from account_period_totals and the entries, re-enable the guard, and record who ran it and why.", why: "The guard is there to stop exactly this kind of hand edit, so the bypass must be deliberate, rare and audited. The entries are the truth; only the cache is rewritten." },
        { name: "External reconciliation", what: "Every business day, the ledger's totals for each settlement and safeguarding account are matched against the bank's statement and the schemes' settlement reports.", why: "Locks stop races, not a wrong amount, a lost scheme message or a bank error; only an independent record catches those. For payment and e-money firms, the FCA's CASS 15 rules ask for this every business day." },
        { name: "Breaks", what: "A difference nothing explains, raised with an owner, an amount and evidence, and closed by a correcting transaction through the Ledger API after a second person approves.", why: "The fix uses the same rules as every payment and is idempotent on the break id, so approving twice posts once. The history keeps both the mistake and the fix." },
      ],
      numbers: [
        { text: 'Monzo\'s example: two £5 payments in the ledger, £15 arrived in settlement, a £5 break.', from: "Monzo's worked example from 'Processing payments safely at scale', cited on the page: £5 + £5 = £10 in the ledger; £15 in settlement less £10 = £5 that nothing explains." },
        { text: 'Stripe reports more than 99.9999 per cent of money movement explained, with clearing accounts expected to sit at zero.', from: "Not a sum. Stripe's own figure, from its ledger post cited on the page; it has not been checked here." },
      ],
      fails: 'A break is found. It is raised with an owner, an amount and evidence. The fix is a new correcting transaction through the ledger API, reviewed by a second person, never an edit to an entry.',
      alternatives: [
        {
          name: 'Continuous invariant checks plus daily external reconciliation', chosen: true, good: 'Internal checks catch bugs in minutes; external ones catch what the ledger never saw.', cost: 'A team that owns breaks and works them down.',
          what: "Every few minutes, queries check that each transaction and each currency sums to zero and each accounts.balance equals its archived totals plus its entries. Every business day, the ledger's totals for each settlement and safeguarding account are matched against the bank and scheme files.",
          pros: ['Internal checks catch bugs in minutes.', 'External checks catch what the ledger never saw: a missing scheme message, a bank error.', "Meets CASS 15's daily reconciliation for payment and e-money firms.", 'Breaks are fixed by correcting entries, so the history shows both mistake and fix.'],
          cons: ['A team that owns breaks and works them down.', 'With about 2.7 TB a shard, the checks must work from archived period totals and recent entries, not re-sum everything.', 'A day of delay before an outside error is seen.'],
        },
        {
          name: 'Clearing accounts that should net to zero', good: 'One query finds anything stuck: money that left one system and never arrived in the next. Stripe\'s Ledger is built around this.', cost: 'Needs fund flows modelled carefully up front.',
          what: "Every hop money makes between systems passes through a clearing account that should return to zero once the hop completes. Anything stuck shows as a balance left behind. Stripe's Ledger is built around this.",
          pros: ['One query finds anything stuck: money that left one system and never arrived in the next.', 'Works across many systems, not only the ledger and the bank.', "Already in this design: FPS_PENDING is one, and cross-shard sagas go through another."],
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
      built: [
        { name: "Bank statements", what: "Daily statements from the bank that holds the settlement and safeguarding accounts, where the real money sits. Safeguarding accounts hold customers' money apart from the firm's own.", why: "They come from someone else's systems, so they disagree with the ledger exactly when the ledger is wrong. Each file is checksummed and loaded once; a missing file raises an alert." },
        { name: "Scheme settlement reports", what: "Daily reports from Faster Payments, Bacs and the card schemes of what each says was settled.", why: "They show what the schemes think moved, which catches a lost accept or reject message. Each scheme has its own format, so each needs its own parser." },
      ],
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
      what: 'Monthly partitions of ledger_entries older than 13 months, exported from a replica as Parquet files, with a checksum per file. The accounts table and each account\'s total for every archived month (account_period_totals) stay in the database.',
      why: 'Entries are never deleted, so the journal only grows. Partitioning ledger_entries by date lets an old month be exported and detached in one step, without a slow delete. Because the balances live in accounts, not in the journal, archiving never slows a balance check. Partitioning by date keeps one shard\'s journal small; sharding by business is what reaches 10,000 a second. They are separate things.',
      built: [
        { name: "Object store", what: "A storage service that keeps files (objects) by name and serves them over HTTP; cloud providers offer these as managed services. It is not a database: it stores and returns whole files.", why: "Entries are never deleted, about 40 TB a year across all shards. Moving months older than 13 into files keeps each shard near 2.7 TB and is cheap to keep for years. Old statements are then read from files, more slowly." },
        { name: "Parquet", what: "An open file format that stores a table by column, compressed, so a reader can fetch only the columns it needs.", why: "The archive is read rarely and in bulk, for an old statement or an audit, which suits a compact column file that warehouse tools can read. A manifest beside the files records the row count, sums and a checksum per file." },
        { name: "Monthly partitions", what: "A partition is one piece of a table that PostgreSQL stores separately, chosen by a column: here ledger_entries is split by created_at into one partition per month. A partition can be detached from the table, without deleting rows one by one.", why: "Once a month's export is checked against its counts and sums, detaching it is quick; with CONCURRENTLY it takes only a SHARE UPDATE EXCLUSIVE lock on the parent, so inserts carry on. The price: PostgreSQL requires every unique key on a partitioned table to include created_at, so UNIQUE (transaction_id, account_id) becomes UNIQUE (transaction_id, account_id, created_at) and only guards within a partition. idempotency_keys is the guard across partitions." },
        { name: "account_period_totals", what: "One row per account per archived month: account_id, period, total. Written from the partition before it is detached.", why: "This design's choice. It lets reconciliation check a balance as archived totals plus hot entries once old rows have left the database." },
      ],
      fails: 'An export is incomplete. The partition is detached only after the file\'s row count and sums match the partition\'s, which are recorded with the export.',
      alternatives: [
        {
          name: 'Partition by month, export and detach', chosen: true, good: 'Cheap storage, and dropping a partition is instant.', cost: 'Old statements are read from files, more slowly.',
          what: 'ledger_entries is partitioned by month on created_at. Each month the partition that passes 13 months old is exported from a replica to Parquet with its row count and sums, its per-account totals are written to account_period_totals, and it is detached on the primary. The accounts table is untouched.',
          pros: ['Detaching a partition is a metadata change, not a slow delete.', 'Keeps each shard near 2.7 TB instead of growing for ever.', 'Parquet in an object store is cheap to keep for years.', 'Recorded counts and sums prove each file is complete.'],
          cons: ['Old statements are read from files, more slowly.', 'Unique keys must include created_at, so UNIQUE (transaction_id, account_id) no longer stops a replay that carries a different created_at; idempotency_keys must catch it.', 'Partitioning must be there from day one; adding it later means moving a big table.'],
        },
        {
          name: 'Keep everything in the database', good: 'One place to query.', cost: 'Indexes and backups grow for ever, and restores get slower each year.',
          what: 'Entries stay in the shard databases for ever. A statement of any age is the same query.',
          pros: ['One place to query.', 'No export job to build.', 'Old statements are as fast as new ones.'],
          cons: ['Indexes and backups grow for ever: about 40 TB a year across all shards.', 'Restores get slower each year, which stretches recovery after a disaster.', 'Every schema change and backfill touches more data.'],
        },
        {
          name: 'A separate history database', good: 'Old months stay queryable with SQL, off the payment shards.', cost: 'Another cluster to run and back up, and it still grows for ever.',
          what: 'Partitions older than 13 months move to a cheaper Postgres cluster kept only for history. Old statements query it with the same SQL.',
          pros: ['The same SQL and tooling for old and new statements.', 'The payment shards stay small.', 'Faster to query than files.'],
          cons: ['Another cluster to run, back up and patch.', 'It still grows by about 40 TB a year.', 'Moving rows between databases needs the same count and sum checks as an export.'],
        },
      ],
      say: 'Partition the journal by date from day one, so archiving is a detach, not a delete. The balances live in accounts, so archiving never touches a balance check. The catch is the unique keys, and I say so.',
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
        how: 'The payment\'s id and state: pending while the scheme decides, then settled or failed. The state lives on the Banking API\'s payment record, not in the ledger.',
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
{ "id": "pay_3fK9", "status": "settled" }`,
          note: 'The amount is in pence: 120000 is £1,200. The fee of 20p is why the ledger reserves 120020. from_account is the wallet\'s account_id, a UUID.',
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
        { name: 'Bacs', what: 'Payments go in a file through Bacs and arrive over three working days. Payroll and bulk supplier runs are its usual use.', pros: ['Built for bulk: one file, thousands of payments.', 'Suits payroll, where the date is known in advance.'], cons: ['Three working days: no good for paying a supplier today.', 'Funds stay in the pending clearing account for days.'] },
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
  -> recorded on the payment, then Settle (state: SETTLED)
     FPS_PENDING_07 -> FPS_SETTLEMENT_07 and FEE_INCOME_07

rejected   pay_3fK9, with a reason
  -> recorded on the payment, then Reverse (state: FAILED)
     FPS_PENDING_07 -> back to Bright Bakery's wallet

no answer before the timeout
  -> state stays PENDING (sent); 120020p stays in FPS_PENDING_07
  -> ask the scheme for the status of pay_3fK9,
     then settle or reverse`,
          note: 'A timeout is not a rejection: the money stays in the pending clearing account until the scheme answers for the same payment id.',
        },
      ],
    },
    {
      id: 'post', from: 'api', to: 'ledger', d: 'M390,200 H485', label: 'reserve, settle',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: 'Reserve with the idempotency key, the payer\'s account and the amount; later Settle or Reverse naming that reserve, each with its own key. Corrections use CreateTransaction with signed entries. Reads use GetBalance and ListEntries.',
      delivery: 'Safe to repeat: the key is unique in the ledger, so a repeated call returns the first result.',
      alts: ['REST with an Idempotency-Key header.', 'A command topic, which turns a synchronous "is there enough money?" into an asynchronous one.'],
      ways: [
        { name: 'gRPC', chosen: true, what: 'The Banking API calls Reserve, then Settle or Reverse, on the Ledger API, each with its own idempotency key. Reads use GetBalance and ListEntries.', pros: ['A typed contract, with client and server code generated from it.', 'Synchronous: the API learns at once whether the funds were reserved.', 'A deadline on each call, so a slow ledger fails fast.'], cons: ['Harder to call by hand while debugging than REST.', 'Needs load balancers and proxies that handle long-lived HTTP/2 connections.'] },
        { name: 'REST with an Idempotency-Key header', what: 'The same calls as JSON over HTTPS, such as POST /reserves with an Idempotency-Key header. The same key rules apply.', pros: ['Easy to call by hand and read in logs.', 'The same idempotency scheme as the public API.'], cons: ['No generated, typed contract unless one is added.', 'JSON costs a little more to send and parse; unlikely to matter here.'] },
        { name: 'A command topic', what: 'The API writes a command to a topic and the ledger applies it, replying on another topic. Reserve becomes a message, not a call.', pros: ['Bursts queue instead of failing.', 'One consumer per partition gives a single writer per account.'], cons: ['"Is there enough money?" turns asynchronous, but the API must still wait for the answer.', 'Matching replies to requests, and timing them out, is extra code.', 'Kafka joins the money path.'] },
      ],
      reply: {
        id: 'result', label: 'result',
        how: 'The transaction id and the payer\'s balance afterwards; or "insufficient funds".',
        delivery: 'The same answer for every repeat of the same key.',
      },
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `service Ledger {
  rpc Reserve(ReserveRequest) returns (Result); // wallet -> pending
  rpc Settle(ClearRequest) returns (Result);    // pending -> out, fee
  rpc Reverse(ClearRequest) returns (Result);   // pending -> wallet
  rpc CreateTransaction(TxnRequest) returns (Result); // corrections
}
message ReserveRequest {
  string idempotency_key = 1;
  string account_id = 2;  // the payer's wallet, a UUID
  int64 amount = 3;       // pence: payment plus fee
  string reference = 4;
}
message ClearRequest {
  string idempotency_key = 1;
  string reserve_txn_id = 2;  // the reserve to settle or reverse
  int64 fee = 3;              // Settle only: pence to fee income
}
message Entry { string account_id = 1; int64 amount = 2; }
message TxnRequest {  // amounts + credit, - debit; sum to zero
  string idempotency_key = 1; repeated Entry entries = 2;
}
message Result {
  string txn_id = 1; string status = 2; // COMMITTED, INSUFFICIENT_FUNDS
  int64 balance = 3;  // the payer's balance afterwards
}`,
          note: 'GetBalance and ListEntries are left out to keep it short. Payment state (PENDING, SETTLED, FAILED) is not here: it lives on the Banking API\'s payment record.',
        },
        {
          title: 'Example call: reserve, then the retry',
          lang: 'text',
          code: `Reserve
{ "idempotency_key": "k7", "reference": "pay_3fK9",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "amount": 120020 }
-> { "txn_id": "7d1f0a52-6c3e-4f8b-9e21-000000900417",
     "status": "COMMITTED", "balance": 721980 }

The app's retry reaches here as the same call with key k7
-> the same reply, read from the saved result`,
          note: 'The Ledger API made the transaction id, hashed it to sub-account 07 of 16, and so credits FPS_PENDING_07.',
        },
        {
          title: 'Example call: settle, and a refusal',
          lang: 'text',
          code: `Settle
{ "idempotency_key": "k7:settle", "fee": 20,
  "reserve_txn_id": "7d1f0a52-6c3e-4f8b-9e21-000000900417" }
-> { "txn_id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
     "status": "COMMITTED", "balance": 721980 }

Had the wallet held less than 120020, the reserve would reply
-> { "status": "INSUFFICIENT_FUNDS", "balance": 61500 }
   and nothing would have been written.

GetBalance { "account_id": "5f0c2a9e-...081442" }
-> { "balance": 721980, "currency": "GBP" }`,
          note: 'The settle is a new transaction with its own key; it names the reserve instead of editing it. The wallet\'s balance does not move again: the money left it at the reserve.',
        },
      ],
    },
    {
      id: 'txn', from: 'ledger', to: 'db', d: 'M615,200 H700', label: 'one call',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'One call to a small function, ledger_transfer: insert the idempotency key, lock the accounts in account_id order with FOR NO KEY UPDATE, insert the entries in one conditional statement (the trigger moves the balances), insert the outbox row, commit. Balance reads are a plain SELECT on accounts.',
      delivery: 'All or nothing. If the key already exists, the call returns the stored result and writes nothing. If the money is not there, no entry is inserted.',
      alts: ['An interactive transaction of separate statements, holding locks across each round trip.', 'A batch of many transfers per call, as TigerBeetle does, for throughput.'],
      ways: [
        { name: 'SQL: one function call', chosen: true, what: 'The Ledger API calls ledger_transfer once on the shard. It inserts the key, locks the accounts in account_id order, inserts the entries only if the funds are there, inserts the outbox row and saves the result; the transaction commits.', pros: ['Locks are never held across the network: about 1 to 2 ms each.', 'All or nothing, and a repeated key returns the stored result.', 'One round trip per transaction.'], cons: ['Logic in SQL needs its own review and tests.', 'Changing it is a database deploy.'] },
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
          title: 'Reserve, part 1: the key, then the locks',
          lang: 'sql',
          code: `-- Bright Bakery  5f0c2a9e-3d41-4b7e-8c12-000000081442
--   USER_WALLET, allow_negative false, balance 842000
-- FPS_PENDING_07 1c9d4e2a-7b10-4c55-9a01-0000000000a7
--   CLEARING, allow_negative false
BEGIN;
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7', '7d1f0a52-6c3e-4f8b-9e21-000000900417')
ON CONFLICT (key) DO NOTHING;
-- 0 rows: k7 was seen; return its saved result and stop

-- account_id order: 1c9d... (pending) before 5f0c... (bakery)
SELECT account_id, balance FROM accounts
 WHERE account_id IN ('5f0c2a9e-...081442', '1c9d4e2a-...0000a7')
 ORDER BY account_id
   FOR NO KEY UPDATE;`,
          note: 'Every transfer locks its accounts in the same order, so two transfers between the same accounts cannot each hold the lock the other wants.',
        },
        {
          title: 'Reserve, part 2: insert only if funded, then commit',
          lang: 'sql',
          code: `WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND balance >= 120020
)
INSERT INTO ledger_entries (transaction_id, account_id, amount)
SELECT '7d1f0a52-...900417', v.account_id::uuid, v.amount
  FROM (VALUES ('5f0c2a9e-...081442', -120020::bigint),
               ('1c9d4e2a-...0000a7',  120020::bigint))
         AS v(account_id, amount),
       funded;
-- 0 rows inserted: not enough money;
--   ROLLBACK and answer "insufficient funds"
-- 2 rows: the AFTER INSERT trigger has moved both balances

INSERT INTO outbox (transaction_id, account_id, payload)
VALUES ('7d1f0a52-...900417', '5f0c2a9e-...081442', '{...}');
UPDATE idempotency_keys SET result = '{...}' WHERE key = 'k7';
COMMIT;  -- returns once a synchronous standby has the log record
-- after: bakery 721980, FPS_PENDING_07 120020`,
          note: 'The CTE (a named sub-query, WITH funded AS ...) returns one row only if the money is there, so the insert writes both entries or neither. The CHECK on accounts is the backstop if a path skips it.',
        },
        {
          title: 'Settle, once the scheme has accepted',
          lang: 'sql',
          code: `-- FPS_SETTLEMENT_07  9a4b6d10-22f3-4e08-b7c9-0000000000b7
-- FEE_INCOME_07      c2e85b71-90aa-4d3f-a6e4-0000000000c7
BEGIN;
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7:settle', '7d1f0a52-6c3e-4f8b-9e21-000000900418')
ON CONFLICT (key) DO NOTHING;

-- account_id order: 1c9d... (pending), 9a4b..., c2e8...
SELECT 1 FROM accounts
 WHERE account_id IN ('1c9d4e2a-...0000a7', '9a4b6d10-...0000b7',
                      'c2e85b71-...0000c7')
 ORDER BY account_id
   FOR NO KEY UPDATE;

INSERT INTO ledger_entries (transaction_id, account_id, amount)
VALUES ('7d1f0a52-...900418', '1c9d4e2a-...0000a7', -120020),
       ('7d1f0a52-...900418', '9a4b6d10-...0000b7',  120000),
       ('7d1f0a52-...900418', 'c2e85b71-...0000c7',      20);
-- no funds check: FPS_PENDING_07 holds exactly the reserve
INSERT INTO outbox (transaction_id, account_id, payload)
VALUES ('7d1f0a52-...900418', '5f0c2a9e-...081442', '{...}');
COMMIT;
-- FPS_PENDING_07 back to 0; FPS_SETTLEMENT_07 +120000;
-- FEE_INCOME_07 +20; the bakery stays at 721980`,
          note: 'Three entries that sum to zero. The money that sat in the pending clearing account moves on; nothing is edited.',
        },
        {
          title: 'Reverse, if the scheme rejected the payment',
          lang: 'sql',
          code: `-- Only if the scheme rejected pay_3fK9, or a status check
-- confirmed it failed. The payment record allows one of
-- settle or reverse, never both.
BEGIN;
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7:reverse', '7d1f0a52-6c3e-4f8b-9e21-000000900419')
ON CONFLICT (key) DO NOTHING;
SELECT 1 FROM accounts
 WHERE account_id IN ('1c9d4e2a-...0000a7', '5f0c2a9e-...081442')
 ORDER BY account_id
   FOR NO KEY UPDATE;
INSERT INTO ledger_entries (transaction_id, account_id, amount)
VALUES ('7d1f0a52-...900419', '1c9d4e2a-...0000a7', -120020),
       ('7d1f0a52-...900419', '5f0c2a9e-...081442',  120020);
INSERT INTO outbox (transaction_id, account_id, payload)
VALUES ('7d1f0a52-...900419', '5f0c2a9e-...081442', '{...}');
COMMIT;
-- the bakery back to 842000; FPS_PENDING_07 back to 0`,
          note: 'The statement then shows the reserve and the reverse. Nothing is voided in place.',
        },
        {
          title: 'A balance read',
          lang: 'sql',
          code: `-- GetBalance, always on the primary: one row, no lock
SELECT balance, currency, updated_at
  FROM accounts
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442';
--  before:        842000
--  after reserve: 721980  (120020 sits in FPS_PENDING_07)
--  after settle:  721980  (paid out of FPS_PENDING_07)`,
          note: 'A plain SELECT never waits for a writer\'s row lock: it reads the last committed version of the row from its MVCC snapshot.',
        },
        {
          title: 'The two tables (the owner\'s DDL)',
          lang: 'sql',
          code: `CREATE TABLE accounts (
    account_id UUID PRIMARY KEY,
    account_type VARCHAR(20) NOT NULL,
    allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
    balance BIGINT NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_balance CHECK (allow_negative OR balance >= 0)
) WITH (fillfactor = 80);

CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id)
);
CREATE INDEX idx_ledger_account_created
    ON ledger_entries (account_id, created_at DESC);`,
          note: 'Amounts are pence, plus for a credit and minus for a debit; an account\'s balance is the sum of its entries. The index statement is wrapped onto two lines to fit; nothing else is changed.',
        },
        {
          title: 'Beside them on each shard: keys and outbox',
          lang: 'sql',
          code: `CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    transaction_id UUID NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE outbox (
    seq BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL,
    payload JSONB NOT NULL
);`,
          note: 'Keys are kept 72 hours, then deleted by a job.',
        },
        {
          title: 'Triggers 1: append-only entries; each entry moves a balance',
          lang: 'sql',
          code: `CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

CREATE FUNCTION apply_entry_to_balance() RETURNS trigger AS $$
BEGIN
  UPDATE accounts
     SET balance = balance + NEW.amount, updated_at = now()
   WHERE account_id = NEW.account_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_balance();`,
          note: 'A trigger is a function the database runs by itself when a row is written. These run inside the same transaction as the insert, so entry and balance commit together or not at all.',
        },
        {
          title: 'Triggers 2: the guard, and the optional sum-to-zero check',
          lang: 'sql',
          code: `CREATE FUNCTION accounts_guard_balance() RETURNS trigger AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'balance changes only through ledger_entries';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balance();

CREATE FUNCTION entries_must_balance() RETURNS trigger AS $$
BEGIN
  IF (SELECT sum(amount) FROM ledger_entries
       WHERE transaction_id = NEW.transaction_id) <> 0 THEN
    RAISE EXCEPTION 'transaction % does not sum to zero',
      NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION entries_must_balance();`,
          note: 'A direct UPDATE of balance runs the guard at trigger depth 1 and is refused; the entry trigger\'s UPDATE runs it at depth 2 and passes. The test must sit inside the function: in a WHEN clause a direct statement is at depth 0, so <= 1 there would block the entry trigger too.',
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entry_id, created_at),
    UNIQUE (transaction_id, account_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE ledger_entries_2026_11 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

-- Lost: a replay with a different created_at is a new row
-- under this UNIQUE. idempotency_keys, inserted first in the
-- same transaction, is the guard across partitions.`,
          note: 'The index and triggers are declared on the parent as before. Partitioning by date keeps one shard\'s journal small; sharding by business is what spreads the load.',
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
          code: `primary  writes the commit record for ...900417 to its WAL
primary  flushes it to its own disk
primary  streams it to s1 and s2
s2       flushes it and confirms first
primary  returns from the call: ...900417 is committed
s1       confirms a moment later; nothing waited for it

If the primary died after the commit returned, s2 already
holds ...900417 and is promoted with nothing lost.

...900417 is transaction 7d1f0a52-6c3e-4f8b-9e21-000000900417.`,
          note: 'The call returns only after a second machine has the record: that is recovery point zero.',
        },
      ],
    },
    {
      id: 'sweep', from: 'sweeper', to: 'db', d: 'M980,190 H890', label: 'sweep',
      mode: 'write', via: 'SQL', chip: 0.5,
      how: 'Every minute, for FEE_INCOME and FPS_SETTLEMENT on each shard, one balanced transaction moves each of the 16 sub-accounts\' totals into the main account. FPS_PENDING is not swept.',
      delivery: 'Idempotent: each sweep carries a key made of the account and the interval, so a rerun does nothing.',
      alts: ['Rolling up a credit-only account\'s entries into its balance asynchronously.', 'No sweep: reports always sum the sub-accounts.'],
      ways: [
        { name: 'SQL', chosen: true, what: 'Every minute, for each swept account, one balanced transaction locks the main account and its 16 parts in account_id order, debits each part by its balance and credits the main account with the total. It carries a key made of the account and the minute.', pros: ['An ordinary ledger transaction: same triggers, same CHECK.', 'Idempotent: a rerun for the same interval does nothing.', 'Touches the main row once a minute, not once a payment.'], cons: ['One more writer on each part\'s row while it runs.', 'The main account lags by up to a minute.'] },
        { name: 'Rolling up a credit-only account asynchronously', what: 'For an account that only receives credits, the balance trigger skips it, and a job adds its entries into the balance later.', pros: ['No sub-accounts at all.', 'Appends never wait on each other.'], cons: ['Only for accounts with no limit to enforce.', 'The balance lags; Modern Treasury applies such entries within 60 seconds.'] },
        { name: 'No sweep', what: 'Totals stay in the 16 parts for good, and every report sums them with the main account.', pros: ['Nothing to run.', 'Nothing lags: the sum is always exact.'], cons: ['Every reader must know to sum 17 rows a shard.', 'One report that forgets shows a near-empty main account.'] },
      ],
      examples: [
        {
          title: 'One sweep of fee income on one shard, as one transaction',
          lang: 'sql',
          code: `-- FEE_INCOME (main) and FEE_INCOME_01 to _16 on this shard
BEGIN;
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('sweep:FEE_INCOME:2026-11-12T10:41',
        '7d1f0a52-6c3e-4f8b-9e21-000000900452')
ON CONFLICT (key) DO NOTHING;
-- 0 rows: this minute is swept already; stop

-- lock the main account and its 16 parts in account_id order
SELECT account_id, balance FROM accounts
 WHERE account_id IN (<FEE_INCOME and its 16 parts>)
 ORDER BY account_id
   FOR NO KEY UPDATE;
-- FEE_INCOME_07 (c2e85b71-90aa-4d3f-a6e4-0000000000c7) reads
-- 3740, and so on for each part

INSERT INTO ledger_entries (transaction_id, account_id, amount)
VALUES ('7d1f0a52-...900452', 'c2e85b71-...0000c7',  -3740),
       -- ... one row per part with a balance above zero ...
       ('7d1f0a52-...900452', '<FEE_INCOME main>',   60060);
COMMIT;
-- each part back to 0; the main account up by their sum`,
          note: 'The parts are locked, so their balances cannot change between the read and the insert: each debit is exact and no part goes below zero. Amounts are illustrative.',
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
          note: 'op "c" is an insert; lsn is the position in the write-ahead log, which the relay copies into the event. This row is the settle\'s; the reserve wrote one too.',
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
        { name: 'Kafka, keyed by account', chosen: true, what: 'The relay turns each outbox row into one event on ledger-events, keyed by account. Kafka keeps order within a partition, so each account\'s events stay in order.', pros: ['Ordered per account.', 'Replayable for every reader.', 'Light: about 2 MB a second on average, about 20 MB at peak.'], cons: ['At least once: events carry the log position so readers can drop repeats.', 'A partition holding a busy account can lag behind the others.'] },
        { name: 'One topic per event type', what: 'Separate topics for, say, reserves, settles and reverses. Each consumer subscribes only to what it needs.', pros: ['Consumers skip what they do not need.', 'Each topic can have its own retention and schema.'], cons: ['No order across topics: a reverse can be read before its reserve.', 'More topics to run and keep in step.'] },
        { name: 'A managed stream (Kinesis, Pub/Sub)', what: 'A cloud provider\'s stream in place of a Kafka cluster, with the account as the key that keeps order.', pros: ['Nothing to run.', 'Replay within the service\'s retention.'], cons: ['Ties the ledger\'s events to one cloud.', 'Ordering and retention rules differ by product; check them before relying on replay.'] },
      ],
      examples: [
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic       ledger-events
key         "5f0c2a9e-3d41-4b7e-8c12-000000081442"
            Bright Bakery's account_id
partition   chosen by hashing the key, so every event for
            the bakery lands in one partition, in commit order`,
          note: 'The key keeps one account\'s events in order; there is no order across accounts, and none is needed.',
        },
        {
          title: 'Message value',
          lang: 'json',
          code: `{
  "type": "transaction.committed",
  "kind": "settle",
  "transaction_id": "7d1f0a52-6c3e-4f8b-9e21-000000900418",
  "reserve_id": "7d1f0a52-6c3e-4f8b-9e21-000000900417",
  "reference": "pay_3fK9",
  "account_id": "5f0c2a9e-3d41-4b7e-8c12-000000081442",
  "currency": "GBP",
  "entries": [
    { "account": "FPS_PENDING_07", "amount": -120020 },
    { "account": "FPS_SETTLEMENT_07", "amount": 120000 },
    { "account": "FEE_INCOME_07", "amount": 20 }
  ],
  "balance": 721980,
  "lsn": 249113864,
  "committed_at": "2026-11-12T10:41:03.118Z"
}`,
          note: 'Amounts are signed pence: plus a credit, minus a debit. Each entry also carries the account\'s UUID, left out here to fit. lsn lets a reader drop a repeat: anything at or below the last lsn it applied for this account.',
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
reads         ledger-events, the partition holding the bakery's key
              "5f0c2a9e-3d41-4b7e-8c12-000000081442"

last applied  lsn 249071520 for the bakery (the reserve, ...900417)
this event    lsn 249113864, the settle, ...900418
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
-- for the settle event ...900418 (+120000 to FPS_SETTLEMENT_07):
BEGIN;
INSERT INTO seen_txns (transaction_id)
VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900418')
ON CONFLICT (transaction_id) DO NOTHING;
-- 0 rows: a repeat; roll back and skip it

-- FPS_SETTLEMENT_07 is one of 16 parts of FPS_SETTLEMENT
UPDATE settlement_totals
   SET total = total + 120000, txns = txns + 1
 WHERE account = 'FPS_SETTLEMENT' AND day = '2026-11-12';
COMMIT;`,
          note: 'The transaction id is the dedupe key here, and the totals are kept per house account, summing its 16 parts on every shard.',
        },
        {
          title: 'Beside this line: the internal balance check, on a replica',
          lang: 'sql',
          code: `-- Every few minutes, one batch of accounts at a time.
-- Any row returned is a broken balance; expect none.
SELECT a.account_id, a.balance,
       coalesce(t.total, 0) + coalesce(h.total, 0) AS from_entries
  FROM accounts a
  LEFT JOIN (SELECT account_id, sum(total) AS total
               FROM account_period_totals
              GROUP BY account_id) t USING (account_id)
  LEFT JOIN (SELECT account_id, sum(amount) AS total
               FROM ledger_entries
              GROUP BY account_id) h USING (account_id)
 WHERE a.account_id = ANY (<this batch of account ids>)
   AND a.balance <> coalesce(t.total, 0) + coalesce(h.total, 0);`,
          note: 'Not on this line: reconciliation queries a shard\'s replica directly. One MVCC snapshot sees a balance and its entries together, because the trigger wrote both in one transaction. account_period_totals holds the totals of months already archived.',
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
          code: `FPS_SETTLEMENT (main and 16 parts, every shard), 2026-11-12
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
      how: 'Statements and history are read from an asynchronous replica: ledger_entries for one account, newest first, 50 at a time through idx_ledger_account_created, continuing from the last row seen.',
      delivery: 'Read-only and repeatable. A page may lag the primary by a second, which a statement can tolerate.',
      alts: ['A search index fed from the topic, for filtering by payee or amount.', 'The primary, when a page must include a payment made a moment ago.'],
      ways: [
        { name: 'SQL read from a replica', chosen: true, what: 'The Ledger API reads one account\'s entries from an asynchronous replica, newest first, 50 at a time, continuing from the created_at and entry_id of the last row seen.', pros: ['Takes statement load off the primary.', 'Cursor pages stay stable as new entries arrive.'], cons: ['A page may lag the primary by a second.', 'A payment made a moment ago may be missing.'] },
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
          code: `-- On an asynchronous replica: newest 50 entries for the bakery
SELECT entry_id, transaction_id, amount, created_at
  FROM ledger_entries
 WHERE account_id = '5f0c2a9e-3d41-4b7e-8c12-000000081442'
 ORDER BY created_at DESC, entry_id DESC
 LIMIT 50;

-- Next page: older than the last row seen
SELECT entry_id, transaction_id, amount, created_at
  FROM ledger_entries
 WHERE account_id = '5f0c2a9e-...081442'
   AND (created_at, entry_id)
     < ('2026-11-12 10:41:03.118+00', 7730512)
 ORDER BY created_at DESC, entry_id DESC
 LIMIT 50;`,
          note: 'idx_ledger_account_created (account_id, created_at DESC) finds the account\'s newest rows first. The page continues from a position, not an offset, so new entries do not shift or repeat a page; entry_id breaks a tie between two entries at the same time.',
        },
        {
          title: 'Reply',
          lang: 'text',
          code: `up to 50 rows, newest first
cursor for the next page: created_at and entry_id
of the last row returned`,
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
        { name: 'Direct SQL on the database', what: 'An engineer changes the wrong rows in the database by hand.', pros: ['Fastest to do, if it were allowed.', 'No tooling needed.'], cons: ['The triggers refuse it: entries cannot be updated or deleted, and a balance cannot be edited directly.', 'Getting round them needs a superuser, which leaves no record of the mistake or of who fixed it.', 'The cached balance and the entries could then disagree.'] },
      ],
      examples: [
        {
          title: 'Example call, after a second person approves',
          lang: 'text',
          code: `CreateTransaction
{ "idempotency_key": "brk_1127",
  "entries": [
    { "account_id": "<FPS_SETTLEMENT main>", "amount": 500 },
    { "account_id": "<SUSPENSE>", "amount": -500 }
  ] }
-> { "txn_id": "7d1f0a52-6c3e-4f8b-9e21-000000901733",
     "status": "COMMITTED" }

Approved twice: the same call with key brk_1127
-> the same reply; posted once`,
          note: 'The bank shows 500p more paid out than the ledger, so the settlement account is credited 500p. The other leg depends on the cause; here SUSPENSE (allow_negative true) holds -500p until it is traced.',
        },
      ],
    },
    {
      id: 'export', from: 'replicas', to: 'archive', d: 'M760,400 V465 Q760,475 750,475 H615', label: 'old months',
      mode: 'write', via: 'export', chip: 0.75, cold: true,
      how: 'Off the hot path. Monthly, the oldest partition of ledger_entries is exported from a replica to Parquet with its row count and sums, its per-account totals are saved, then it is detached on the primary.',
      delivery: 'Write once per month; the partition is detached only after the counts match.',
      alts: ['Logical backups kept for the retention period.'],
      ways: [
        { name: 'Export', chosen: true, what: 'Monthly, the oldest partition of ledger_entries is exported from a replica to Parquet with its row count and sums, then detached on the primary once they match and the per-account totals are saved.', pros: ['No export load on the primary.', 'Counts and sums prove the file is complete.'], cons: ['A monthly job to watch.', 'Old statements are read from files.'] },
        { name: 'Logical backups kept for the retention period', what: 'Keep logical dumps of the database for as long as records must be kept, instead of monthly exports.', pros: ['Uses backup tooling the team already runs.', 'Restores the data exactly as it was.'], cons: ['Not queryable: an old statement means restoring a dump.', 'The live tables still grow unless partitions are dropped.'] },
        { name: 'Export from the primary', what: 'Run the monthly export on the shard\'s primary instead of a replica.', pros: ['No replica needed for exports.', 'One fewer machine in the path.'], cons: ['Reading a month, about 110 GB a day × 30 ÷ 16 shards = about 200 GB a shard, competes with payments.', 'A slow export on the primary can hold back cleanup of old row versions.'] },
      ],
      examples: [
        {
          title: 'Count and sum, save totals, then detach',
          lang: 'sql',
          code: `-- In November 2026, September 2025 passes 13 months old.
-- On a replica: what the exported files must match
SELECT count(*) AS entries, sum(amount) AS net,
       sum(amount) FILTER (WHERE amount > 0) AS credits
  FROM ledger_entries_2025_09;
--  entries 806154213, net 0

-- On the primary: each account's total for the month
INSERT INTO account_period_totals (account_id, period, total)
SELECT account_id, '2025-09', sum(amount)
  FROM ledger_entries_2025_09 GROUP BY account_id;

-- Then, only after the files' counts and sums match
ALTER TABLE ledger_entries
  DETACH PARTITION ledger_entries_2025_09 CONCURRENTLY;
-- later, run by the archive role, not the ledger's:
DROP TABLE ledger_entries_2025_09;`,
          note: 'net is 0 because every entry of one transaction gets the same created_at (now() is the transaction\'s start), so a transaction never spans two partitions. CONCURRENTLY takes only a SHARE UPDATE EXCLUSIVE lock on the parent, so inserts carry on.',
        },
        {
          title: 'Objects written',
          lang: 'http',
          code: `PUT /ledger-archive/shard-07/entries/2025-09/part-0000.parquet
PUT /ledger-archive/shard-07/entries/2025-09/part-0001.parquet
  (and so on: the month's entries for shard 7, as Parquet)

PUT /ledger-archive/shard-07/entries/2025-09/manifest.json
{
  "partition": "ledger_entries_2025_09",
  "entries": 806154213,
  "net": 0,
  "credits": 15696978413005,
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
      text: "Bright Bakery Ltd pays its flour supplier £1,200 by Faster Payments, the UK's instant bank transfer. When the owner pressed Pay, the app made a one-off label for this payment, k7 (an idempotency key). It sends the amount as 120000 pence with k7 to the Banking API, so that if it has to send again, the bank can tell a resend from a new payment.",
      focus: ['client', 'api'],
      path: ['pay'],
      labels: ['£1,200, key k7'],
      story: {
        context: "The owner of Bright Bakery Ltd has just pressed Pay in the bank's app to settle invoice INV 3318 from Mill Lane Flour Ltd. The request is on its way to the Banking API over HTTPS. Nothing has reached the bank yet.",
        problem: "Phones lose signal mid-request. If the request reaches the bank but the reply is lost, the app cannot tell whether £1,200 moved, and the natural thing is to send it again. To the bank, a resend looks exactly like a second payment.",
        consequence: "Without a way to tell a resend from a new payment, the bank would pay the supplier £2,400. The bakery would have to ask for £1,200 back, and the bank would carry the blame.",
        fix: "The app makes the key k7 (a random UUID) once, before the first attempt, stores it with the draft payment and sends it in the Idempotency-Key header on every attempt. The ledger stores the key with a unique constraint for 72 hours, so a repeat returns the first result (step 7). The cost: every client must make the key once and reuse it, so the SDKs do it for them.",
      },
      explain: [
        { q: "What is an idempotency key?", a: "A label the app makes once for one payment and sends with every attempt at it. \"Idempotent\" means doing something twice has the same effect as doing it once. Here k7 stands for a version 4 UUID, a value with 122 random bits, so two payments will not pick the same one by chance." },
        { q: "Why does the app make the key, not the bank?", a: "Only the sender knows that two requests are the same attempt. If the bank made a fresh id for each request it received, a resend would get a fresh id too and look like a new payment." },
        { q: "Why 120000 and not 1200.00?", a: "Amounts are stored as whole numbers of the smallest unit, pence, with the currency beside them (minor units). Whole numbers add up exactly; decimal fractions in floating point do not. 120000 pence is £1,200.00." },
        { q: "What is Faster Payments?", a: "The UK's real-time payment scheme: the shared system UK banks use to send each other payments in seconds, any hour of any day. It allows up to £1 million a payment at scheme level, and each bank sets its own lower limit." },
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
        context: "The Banking API holds the request: £1,200 from Bright Bakery's wallet to Mill Lane Flour Ltd, sort code 12-34-56, account 12345678, key k7. The ledger has not been called.",
        problem: "The request might not come from the owner. The account number might be mistyped, or belong to a scammer posing as the supplier. The amount might be over the bank's own limit, which is lower than the scheme's £1 million.",
        consequence: "Money sent to the wrong account is hard to get back. Since 7 October 2024 the bank must reimburse consumers, micro-enterprises and charities who are tricked into paying a scammer by Faster Payments or CHAPS, up to £85,000 a claim.",
        fix: "Every check runs in the Banking API before the ledger is called: authentication, the name check, a fraud score and the bank's limit. A failure is simply a refusal to the app: no ledger record, nothing to reverse. The cost is a few calls to other services before every payment.",
      },
      explain: [
        { q: "What is strong customer authentication?", a: "A legal requirement, from the Payment Services Regulations 2017, to confirm the user properly when they start an electronic payment. The user proves two independent things, from something they know, something they have and something they are." },
        { q: "What is Confirmation of Payee?", a: "A UK name-checking service. Before paying, the bank asks the payee's bank whether the name typed matches the name on that account, and warns the user if it does not. It catches typos and some scams." },
        { q: "Why do all the checks come before the ledger?", a: "Nothing has been held or recorded yet, so a refused payment leaves nothing to undo. If the checks came after the reserve, every refusal would need a reverse." },
        { q: "Whose limit is checked?", a: "The bank's. Faster Payments allows up to £1 million a payment, but each bank sets its own lower limit, and the Banking API checks that one." },
      ],
    },
    {
      title: 'Reserve the funds',
      text: "The Banking API asks the Ledger API to hold the money, so two payments cannot spend the same pounds. A hold here is an ordinary transaction whose parts sum to zero: minus 120020p from Bright Bakery's wallet, plus 120020p to a pending clearing account, FPS_PENDING_07. In one call the Ledger DB stores key k7, locks both account rows, inserts the two entries only if the bakery has 120020p, and adds an outbox row. A trigger moves both balances.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn'],
      labels: ['reserve £1,200', '1 transaction'],
      story: {
        context: "The checks passed. Bright Bakery's wallet holds 842000p (£8,420). The payment is £1,200 plus a 20p fee, so 120020p in all. Faster Payments has not been asked yet.",
        problem: "Other payments from the same account may be in flight. If two payments each read \"£8,420\" and then each spend it, the wallet goes below zero. And the payment cannot be final yet, because the scheme may still reject it.",
        consequence: "Without a hold, the bakery could spend the same money twice and the bank would be lending money it never agreed to lend. If any code path could insert entries without moving the balance, or move a balance by hand, the cached balance would drift from the entries and every check built on it would be wrong.",
        fix: "The Ledger API hashes the new transaction id to sub-account 07 and calls the shard once. In one database transaction: insert key k7; lock FPS_PENDING_07 then the bakery's row with FOR NO KEY UPDATE, in account_id order; insert the two entries in one statement that writes them only if the bakery's balance is at least 120020; add the outbox row; commit. Each inserted entry fires a trigger that adds its amount to its account's balance, so the bakery ends at 721980p and FPS_PENDING_07 holds 120020p. If a path skipped the check, the CHECK constraint would refuse the negative balance. The cost: one extra UPDATE per entry, and the two rows stay locked until the commit, about 1 to 2 ms.",
      },
      explain: [
        { q: "What is a clearing account?", a: "An account money passes through on its way somewhere else, which should return to zero once the move completes. FPS_PENDING holds payments the scheme has not yet answered. A balance that stays there for long means a payment is stuck." },
        { q: "Why two entries, and why signed amounts?", a: "Double-entry: every movement is recorded where it came from and where it went, so the entries sum to zero and no money is created or lost. Here a debit is a negative amount and a credit a positive one, in pence: -120020 from the wallet, +120020 to FPS_PENDING_07. An account's balance is the sum of its entries." },
        { q: "What is a trigger?", a: "A function the database runs by itself when a row is written. Here an AFTER INSERT trigger on ledger_entries adds each entry's amount to its account's balance, inside the same transaction. No code path can insert an entry and forget the balance." },
        { q: "What does FOR NO KEY UPDATE do?", a: "SELECT ... FOR NO KEY UPDATE locks the rows it reads until the transaction ends, so a second payment on the same account waits its turn. It is the weakest lock that does this. Unlike FOR UPDATE, it does not block foreign key checks from tables that only reference accounts; the gain here is small." },
        { q: "What is the CTE?", a: "A common table expression: a named sub-query written WITH funded AS (...). funded returns one row only if the bakery's balance is at least 120020, and the INSERT joins to it, so it writes both entries or none. None means \"insufficient funds\"." },
        { q: "What is the CHECK constraint?", a: "A rule the database checks on every row it writes: CHECK (allow_negative OR balance >= 0). A wallet has allow_negative false, so any write that would take it below zero fails and the transaction rolls back. It is the backstop if a code path forgot the funds check." },
        { q: "Why one call and not several statements?", a: "A locked row stays locked while the service talks to the database. Ten round trips of 0.5 ms would hold a row for 5 ms, about 200 writes a second on it at most. One call to a small function holds locks only for the database's own work and the commit." },
      ],
    },
    {
      title: 'Commit on two machines',
      text: "The Ledger DB (the shard's main copy, the primary) writes the reservation to its log. It then waits until one of two standby copies, each in another data centre (zone), says it has saved that record too. Only then does it reply \"committed\" to the Ledger API, which tells the Banking API the money is reserved. If the primary died now, that standby would already hold it: nothing anyone was told is lost.",
      focus: ['db', 'replicas', 'ledger', 'api'],
      path: ['wal', '<wal', 'committed', 'result'],
      labels: ['log record', 'confirmed', 'committed', 'reserved'],
      story: {
        context: "The ledger function has done its work on the primary of the bakery's shard: key k7, two entries, the two balances the trigger moved and the outbox row for transaction 7d1f0a52-6c3e-4f8b-9e21-000000900417 (...900417 from here on). All that is left is the commit, the moment the database promises the change is permanent.",
        problem: "The primary is one machine. As soon as it says \"committed\", the Banking API acts on it: it sends £1,200 to Faster Payments. If the reservation existed only on that machine's disk and the machine were lost, the record would go with it.",
        consequence: "The bank would have sent £1,200 with no record that it left and the money still in the bakery's balance. The bakery could spend the same money again, and the books would no longer match the money at the bank.",
        fix: "Each primary streams its write-ahead log to two standbys, s1 and s2, in other zones, with synchronous_standby_names = 'ANY 1 (s1, s2)'. The commit returns once the record is flushed to the primary's own disk and either standby confirms it has flushed it too; in the example s2 answers first and nothing waits for s1. The cost: assume about a millisecond more per commit, which also lengthens every hot row's lock. If both standbys are lost, commits wait, and this design stops writes on that shard rather than drop to asynchronous replication.",
      },
      explain: [
        { q: "What is the primary?", a: "The one copy of a shard's database that accepts writes. The ledger is split into 16 shards, each its own Postgres cluster: a primary, two synchronous standbys and further read-only replicas." },
        { q: "What is a synchronous standby?", a: "A full second copy of the shard's database, on another machine, that receives the primary's log as it is written. \"Synchronous\" means the primary waits for its \"saved\" before finishing a commit. If the primary dies, a standby is promoted to take over (step 13)." },
        { q: "What is another zone?", a: "An availability zone: a separate data centre in the same cloud region, with its own power and network. A fire or power cut in one zone should not reach another, so the copies are kept apart. A whole region can still be lost, which is a separate trade-off." },
        { q: "What is the log record?", a: "Postgres writes every change first to its write-ahead log (WAL), an append-only file, and only then to the tables. The commit record for ...900417 in that log is what makes the transaction permanent, and streaming the log is how the standbys keep in step." },
        { q: "Where is the reservation confirmed?", a: "In the Ledger DB, when transaction ...900417 commits. The database replies \"committed\" to the Ledger API, which replies to the Banking API with status COMMITTED and balance 721980. The Banking API records the payment as PENDING, reserved. The app is not told yet." },
        { q: "What does \"acknowledged\" mean, and to whom?", a: "A reply saying \"done\". Here the database acknowledges to the Ledger API, and the Ledger API to the Banking API, which then sends money out on the strength of it. Since others act on that reply, it must survive a crash: the design calls this a recovery point of zero." },
      ],
    },
    {
      title: 'Send it to the scheme',
      text: "With the money held, the Banking API records the payment as \"sent\" and passes it to Faster Payments, which moves it to the supplier's bank. Here Faster Payments accepts it. Had no answer come back in time, that would mean \"unknown\", not \"failed\": the payment may have gone. So the funds would stay reserved until the scheme confirms either way.",
      focus: ['api', 'fps'],
      path: ['send', 'ack'],
      labels: ['payment', 'accepted'],
      story: {
        context: "Transaction ...900417 is committed: 120020p sits in FPS_PENDING_07, and the bakery's balance is now 721980p. The Banking API records payment pay_3fK9 as \"sent\" before the message leaves.",
        problem: "Faster Payments is someone else's system. It can accept, reject or say nothing. A timeout after sending is the dangerous case: the payment may or may not have reached the supplier's bank.",
        consequence: "If the bank treated a timeout as a failure and reversed the reserve, and the payment had in fact gone, the bakery could spend the £1,200 again. If it resent under a new id, the supplier could be paid twice.",
        fix: "The message carries payment id pay_3fK9, the same on every resend. On \"accepted\" the Banking API records SETTLED and calls Settle; on \"rejected\" it records FAILED and calls Reverse. With no answer the state stays PENDING (sent), the 120020p stays in FPS_PENDING_07, and the API asks the scheme for the status of pay_3fK9 before it settles or reverses. The cost: pending payments to track, and FPS_PENDING to watch for money that does not leave.",
      },
      explain: [
        { q: "What is a scheme?", a: "The shared system and rulebook banks use to move money between each other. Faster Payments is the UK's real-time scheme. Bacs (three working days) and CHAPS (high value, same day) are the other bank rails, and cards have their own." },
        { q: "Does the bank talk to Faster Payments directly?", a: "Directly, or through a sponsor bank: a member of the scheme that passes payments in for a firm that is not a direct member. Either way the payment id stays the same on every resend." },
        { q: "Why record \"sent\" before sending?", a: "If the Banking API crashed straight after sending, the recorded state tells a recovery worker that the money may have gone. The worker then asks the scheme instead of guessing." },
        { q: "Why does the Banking API talk to the scheme, not the ledger?", a: "The ledger only records money. If it called the scheme itself it would wait on an outside network while holding payment state, and a slow scheme would slow every balance read." },
        { q: "How quickly does the scheme answer?", a: "Usually within seconds. The reply is recorded on the payment before the ledger is told, so a crash cannot lose it." },
      ],
    },
    {
      title: 'Settle: move the money on',
      text: "Faster Payments accepted, so the Banking API asks the Ledger API to settle. The Ledger DB writes a new transaction, ...900418, of three entries: minus 120020p from FPS_PENDING_07, plus 120000p to the scheme settlement account and plus 20p to fee income. The reserve is never edited; an entry cannot be. Had the scheme rejected the payment, a reverse would have moved the money back to the wallet instead.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['settle k7', '3 entries', 'committed', 'settled'],
      story: {
        context: "The scheme has accepted pay_3fK9, and the Banking API has recorded it as SETTLED on the payment. In the ledger the 120020p still sits in FPS_PENDING_07; the bakery's wallet already reads 721980p.",
        problem: "The money must move on once and only once, and the record of what happened must stay readable for audit. The settle itself can be repeated: by a retry, or by a recovery worker finishing the payment after a crash.",
        consequence: "A repeated settle that counted twice would pay the scheme account twice. If entries could be changed in place, nobody could see later when money was held and when it moved, and a bug could rewrite history unseen.",
        fix: "The Banking API calls Settle with key k7:settle, naming the reserve ...900417 and a 20p fee. The function locks FPS_PENDING_07, FPS_SETTLEMENT_07 and FEE_INCOME_07 in account_id order and inserts three entries that sum to zero. It needs no funds check: the pending account holds exactly the reserve. FPS_PENDING_07 returns to zero. The key makes a repeat return the first result, and a trigger on ledger_entries refuses any UPDATE or DELETE. The cost: two ledger transactions and five entries per payment instead of one and three.",
      },
      explain: [
        { q: "What does settle mean here?", a: "Moving the money out of the pending clearing account to where it finally goes: 120000p to FPS_SETTLEMENT_07, which mirrors what the bank pays out through the scheme, and 20p to FEE_INCOME_07, the bank's revenue." },
        { q: "What is a reverse?", a: "The other outcome: minus 120020p from FPS_PENDING_07 and plus 120020p back to the wallet, as a new transaction. The statement then shows the reserve and the reverse. The payment record allows one of settle or reverse, never both." },
        { q: "Why a different key, k7:settle?", a: "The settle is a transaction of its own, so it needs its own key. Making it from k7 means a repeated settle is recognised just as a repeated payment was." },
        { q: "How is an entry kept from being changed?", a: "A BEFORE UPDATE OR DELETE trigger on ledger_entries raises an error, so the statement fails whoever runs it. That trigger does not stop TRUNCATE or DROP TABLE, so the ledger's role is also granted only INSERT and SELECT." },
        { q: "Where does the payment's state live?", a: "On the Banking API's payment record: PENDING, SETTLED or FAILED. The ledger shows where the money is, not what state the payment is in, because its rows never change." },
        { q: "Is this commit also on two machines?", a: "Yes. Like every ledger commit, it returns only once one of the two synchronous standbys in another zone has the log record." },
      ],
    },
    {
      title: 'The app retries',
      text: "The phone lost signal before the Banking API's answer arrived, so the app sends the same request again with the same key, k7. The Banking API passes it on, and the Ledger DB finds k7 already stored, returns the saved result and writes nothing. The app gets back the same payment, pay_3fK9. No second reservation, no second payment.",
      focus: ['client', 'api', 'ledger', 'db'],
      path: ['pay', 'post', 'txn', 'committed', 'result', 'accepted'],
      labels: ['retry, key k7', 'key k7', 'k7 exists', 'saved result', 'same result', 'same payment'],
      story: {
        context: "From the owner's side, they pressed Pay and the request timed out. Meanwhile the bank reserved, sent and settled pay_3fK9. The app knows none of that.",
        problem: "The resend looks exactly like a new request to pay Mill Lane Flour Ltd £1,200. Two retries could even arrive at the same moment.",
        consequence: "Treated as new, it would pay the supplier a second £1,200 and take a second 20p fee, and the bank would have to chase the money back.",
        fix: "The ledger function starts with INSERT INTO idempotency_keys ... ON CONFLICT (key) DO NOTHING. k7 is already there, so nothing is inserted; the function returns the result saved with k7 and stops. The app gets the same status line and body as the first time. If two retries arrive at once, the unique key lets one insert win and the other waits, then returns the stored result or gets a conflict and retries. Keys are kept 72 hours: about 80 GB across all shards.",
      },
      explain: [
        { q: "Why did the app send again at all?", a: "A network call needs a time limit, and after it runs out the app cannot know whether the request arrived. Sending again with the same key is safe, so the app does." },
        { q: "Where is k7 stored?", a: "In the idempotency_keys table on the bakery's shard, with a unique constraint, written in the same transaction as the entries. So the key exists if and only if the money moved." },
        { q: "What does the app see?", a: "The same reply as the first time: 201 Created for payment pay_3fK9, status pending, read from the saved result. To learn that it has settled, it asks GET /payments/pay_3fK9." },
        { q: "What if the app had made a new key for the resend?", a: "Then nothing could tell it apart from a new payment, and the supplier would be paid twice. That is why the key is made once, with the draft, and the SDKs handle it." },
        { q: "How long is a key kept?", a: "72 hours, at about 150 bytes each. Stripe says it may prune keys once they are 24 hours old; Brandur Leach suggests about 72." },
      ],
    },
    {
      title: 'Tell everyone else, safely',
      text: "Other services must hear about the payment, such as the one that notifies the owner. The outbox row was committed with the entries, so it exists only if money moved. The CDC relay reads it from the database's log and publishes an event on ledger-events (a Kafka topic), keyed by account, and the owner gets a notification. There was never a separate write to Kafka that could be lost.",
      focus: ['db', 'relay', 'kafka', 'consumers'],
      path: ['cdc', 'publish', 'notify'],
      labels: ['outbox row', 'event', 'event'],
      story: {
        context: "Transaction ...900418, the settle, has committed, and with it an outbox row describing it. The payment is final in the ledger, but nothing else knows yet: not notifications, fraud models, the data warehouse or reconciliation.",
        problem: "The obvious way is to commit to the database and then publish to Kafka. Those are two writes with nothing joining them: a crash between them loses the event, and publishing first could announce a payment that then rolled back.",
        consequence: "The owner would not hear that the payment went, and fraud checks and reconciliation would miss it; or they would act on a payment that never happened. Calling each service directly instead would make every payment wait on all of them.",
        fix: "The relay runs Debezium, which reads the Ledger DB's write-ahead log through a replication slot and receives only committed outbox rows, in commit order. Each becomes one event on ledger-events, keyed by the bakery's account_id and carrying the log position, lsn 249113864. Delivery is at least once: after a relay restart an event can repeat, so the notifications consumer skips anything at or below the last lsn it applied for that account. The cost: a connector to run, and a slot that holds log on the primary's disk until the relay catches up.",
      },
      explain: [
        { q: "What is CDC?", a: "Change data capture: reading committed changes from the database's own log, in the order they committed, and turning them into events. Nothing polls the tables, and a change that rolled back never appears." },
        { q: "What is Debezium?", a: "An open-source change data capture tool. It connects to a database's change log, here through Postgres logical decoding, and emits each committed row change as an event with the row before and after and its log position. It is commonly run alongside Kafka." },
        { q: "What is a replication slot?", a: "Postgres's bookmark for one log reader. It records how far the relay has read and keeps the log from being deleted until then. If the relay stops, log piles up on the primary's disk, so the slot is watched." },
        { q: "What is Kafka, and why key by account?", a: "Kafka is a log service: messages are appended to a topic split into partitions, and each reader keeps its own position and can re-read. Messages with the same key go to the same partition, in order, so all of the bakery's events arrive in commit order." },
        { q: "What if Kafka is down?", a: "The ledger carries on. Outbox rows wait in the database's log, and the relay catches up when Kafka returns." },
        { q: "How does the owner not get two notifications?", a: "Each event carries its log position. The notifications service keeps the last position it applied for each account and skips any event at or below it." },
      ],
    },
    {
      title: 'Read the balance',
      text: "The owner opens the app to check the account. The Ledger API reads the balance from the primary, not a copy, so it is never out of date. It is one row in accounts, kept by the trigger in the same transaction as the entries, so it already shows the payment: 721980p. It is the money the bakery can spend; the £1,200 left it at the reserve.",
      focus: ['api', 'ledger', 'db'],
      path: ['post', 'txn', 'committed', 'result'],
      labels: ['balance?', 'read row', 'accounts row', '721980p'],
      story: {
        context: "pay_3fK9 is settled. On the primary, the bakery's accounts row reads balance 721980, the sum of all its entries.",
        problem: "The balance decides whether the next payment can go, and the owner relies on it. Adding up every entry on each read would be slow and get slower as the account's history grows. Reading a copy that trails behind could show money already spent. And a balance anyone could edit would be worth nothing.",
        consequence: "A stale balance lets money be spent twice or hides a payment the owner just made, and the owner calls support. A slow one makes every payment check slow. A hand-edited one breaks the books silently.",
        fix: "GetBalance reads one accounts row on the primary with a plain SELECT, which never waits for a writer's lock. A guard trigger refuses any UPDATE of balance that does not come from the entry trigger, so the cache cannot be edited by hand. Reconciliation checks every few minutes that each balance equals its archived totals plus its entries. The table is created with fillfactor 80, so the trigger's updates usually stay on the same page. The cost is read load on the primary; the whole table is under 200 MB, so it stays in memory.",
      },
      explain: [
        { q: "Is this the available balance or the ledger balance?", a: "There is one figure, and it is what can be spent. The reserve took 120020p out of the wallet at once, so the balance went from 842000 to 721980 then and did not move at the settle. Payments still pending are listed from the Banking API's payment records." },
        { q: "Why does the read not wait for a payment in progress?", a: "PostgreSQL keeps old versions of rows (MVCC, multi-version concurrency control). A plain SELECT reads from its MVCC snapshot: the rows as last committed when it started. Row locks only make other writers wait, never readers." },
        { q: "How is a direct edit of balance refused?", a: "A BEFORE UPDATE trigger on accounts raises an error if balance changed and pg_trigger_depth() is 1 or less. Trigger depth counts how many triggers deep a statement runs: a direct UPDATE is at depth 1 inside the guard, the entry trigger's UPDATE at depth 2, so only the latter passes." },
        { q: "What are fillfactor and a HOT update?", a: "Fillfactor 80 fills each table page only to 80 per cent. An UPDATE in PostgreSQL writes a new row version; if it fits on the same page and no indexed column changed, it is a HOT (heap-only tuple) update and no index is touched. balance is not indexed, so the trigger's updates are cheap." },
        { q: "Why read the primary and not a replica?", a: "Replicas trail by milliseconds to seconds. That is fine for a statement, but a balance is used to decide whether money can be spent, so it is always read from the primary." },
        { q: "What if a balance were wrong?", a: "The invariant check would raise an alarm. The account is frozen and the cache rebuilt from the entries, which are the truth. The guard refuses that too, so the rebuild is a reviewed break-glass change: disable the guard inside one transaction, recompute, re-enable it, and record who did it." },
      ],
    },
    {
      title: 'Statements from a replica',
      text: "The owner scrolls down to the statement. The Ledger API reads it from a read-only copy that trails slightly behind (an asynchronous replica), 50 entries at a time, each page continuing from the last entry id seen. A second of lag is fine for history, and it keeps these heavy reads off the primary, which is busy taking payments.",
      focus: ['ledger', 'replicas'],
      path: ['history', 'page'],
      labels: ['next 50', '50 entries'],
      story: {
        context: "The owner has seen the balance and now opens the list of payments. History, unlike the balance, does not decide whether money can be spent.",
        problem: "Statements, history and exports read many rows. On the primary they would compete with payments for the same machine. Paging by offset (\"skip the first 50\") also shifts as new entries arrive, so a page can repeat or miss lines.",
        consequence: "Heavy statement reads would slow every payment on that shard, against a target of 50 ms at the 99th percentile for a reserve or settle. Offset pages would show the owner a payment twice or not at all.",
        fix: "Further asynchronous replicas, beyond the two synchronous standbys, serve statements, history and exports. The first page is the newest 50 ledger_entries rows for the bakery, found through idx_ledger_account_created (account_id, created_at DESC); the next asks for rows older than the last one seen, by created_at and then entry_id 7730512. On the partitioned table each month's partition has its own copy of that index. The cost: a page may lag the primary by about a second, so a payment made a moment ago can be missing; the first page right after a payment could be read from the primary instead.",
      },
      explain: [
        { q: "What is an asynchronous replica?", a: "A read-only copy that receives the primary's log, but the primary does not wait for it. It usually trails by milliseconds and can fall seconds behind under heavy load. The two standbys of step 4 are different: every commit waits for one of them." },
        { q: "Why is lag acceptable here but not for the balance?", a: "A statement only shows history. Nothing is decided from it, so being a second behind does no harm." },
        { q: "What does \"continuing from the last entry id seen\" mean?", a: "Keyset (cursor) pagination. The next page is \"entries older than the last row seen\", by created_at and then entry_id 7730512, found through the index, not \"skip 50\". New entries arriving at the top do not shift or repeat a page." },
        { q: "Who reads the replica?", a: "The Ledger API, for the Banking API. It gets back up to 50 rows and a cursor, the created_at and entry_id of the last row, for the next page." },
        { q: "What is a partition?", a: "One piece of a table that PostgreSQL stores separately, chosen by a column. ledger_entries is split by created_at into one partition per month, so an old month can be detached and archived without a slow delete. A query for recent entries reads recent partitions." },
      ],
    },
    {
      title: 'The hot account',
      text: "Every payment also touches the bank's own accounts: pending clearing, scheme settlement and fee income. Each entry's trigger locks its account row until the commit, so with one row each, every payment on the shard would queue behind it. So on each shard each is split into 16 sub-accounts: this payment hashed to 07. Each minute the Sweeper moves the settlement and fee parts' totals into their main accounts.",
      focus: ['ledger', 'db', 'sweeper'],
      path: ['txn', 'sweep'],
      labels: ['20p to fee part 07', 'sweep 16 into 1'],
      story: {
        context: "In steps 3 and 6 the payment touched FPS_PENDING_07, FPS_SETTLEMENT_07 and FEE_INCOME_07. The bakery's own row is touched only by its own payments, but these house accounts are touched by nearly every payment on the shard.",
        problem: "The trigger's UPDATE locks the account row until the commit, and the commit waits for a standby in another zone. Assuming 1 to 2 ms a lock, one row takes roughly 500 to 1,000 writes a second (an estimate). One shard peaks at about 1,000 payments a second, and FPS_PENDING is written twice a payment. Fee income is never checked for overdraft, but the trigger still locks it.",
        consequence: "Payments would queue behind a single row: they would blow through the 50 ms target, time out and be retried, which adds more load. The shard's whole payment rate would be capped by one row.",
        fix: "Each house account is split into 16 parts per shard, and the Ledger API picks one by hashing the transaction id: 07 here. That is about 60 writes a second on each fee and settlement part, about 125 on each pending part. Every minute the Sweeper posts one balanced transaction per settlement and fee account, moving each part's total into the main account, keyed by account and minute so a rerun does nothing. FPS_PENDING parts are not swept: each holds exactly the money in flight. The cost: main accounts lag by up to a minute, and reports add the main account and its parts.",
      },
      explain: [
        { q: "What is a hot account?", a: "An account in most transactions, such as fee income or the Faster Payments settlement account. Its row becomes a queue, because only one writer can hold its lock at a time." },
        { q: "Why is fee income locked at all, if it is never checked?", a: "Every entry fires the trigger, and the trigger's UPDATE locks the account row until the commit, whatever the account. That is the price of a balance that is always exact." },
        { q: "What does \"hashing the transaction id\" mean?", a: "A hash function turns the id into a number spread evenly, which is then reduced to one of 16, for example by taking the remainder after dividing by 16. Different payments land on different parts, so writers rarely meet." },
        { q: "What does the Sweeper do?", a: "Every minute, for each settlement and fee account on each shard, it locks the main account and its 16 parts, debits each part by its balance and credits the main account with the sum. Its key is the account and the minute, so a rerun does nothing." },
        { q: "Why is FPS_PENDING not swept?", a: "Each part holds the reserves of payments still waiting on the scheme, and each settle or reverse debits the same part its reserve credited. Moving the money away would leave the part short, and the CHECK would refuse the settle." },
        { q: "What if 16 is not enough?", a: "Lock waits on the parts would climb. Raise the split from 16 to 32; nothing else changes." },
      ],
    },
    {
      title: 'Reconciliation finds a break',
      text: "Overnight, Reconciliation compares the ledger's totals for the settlement account with the bank's own statement for it. Today they differ by £5. Locks cannot catch a wrong amount or a lost message, but this can. A break is raised with an owner, and once understood it is fixed by a correcting transaction through the Ledger API. No entry is edited.",
      focus: ['files', 'recon', 'kafka'],
      path: ['files'],
      labels: ['statement'],
      story: {
        context: "All day, Reconciliation has read ledger-events and kept its own running totals per settlement account per day. For 2026-11-12 the ledger says FPS_SETTLEMENT, its 16 parts summed over every shard, totals 41380250p. Overnight the bank's statement file arrives over SFTP: 41380750p.",
        problem: "Locks and keys stop two writers racing. They do not stop a bug posting a wrong amount, a scheme message that never arrived, or a bank error, and the ledger agrees with itself even when it is wrong. Here 500p, £5, is unexplained.",
        consequence: "Unchecked, errors pile up: a customer spends money a bug wrongly gave them, and the books drift away from the real money at the bank. For payment and e-money firms, the FCA's CASS 15 rules expect safeguarded funds to be reconciled every business day.",
        fix: "Break brk_1127 is raised with an owner, the amount and the lines on each side that do not match. Once the cause is found and a second person approves, a correcting transaction goes through the Ledger API like any other, with key brk_1127, so approving twice posts once; in the example it credits FPS_SETTLEMENT 500p and debits a SUSPENSE account 500p until traced. The mistake and the fix both stay in the history. The cost: a team that owns breaks, and a day before an outside error is seen.",
      },
      explain: [
        { q: "What is reconciliation?", a: "Comparing your own record of money with an independent record of the same money. Here the ledger is checked against bank statements and scheme settlement reports every business day, and against its own rules every few minutes: every transaction sums to zero, and each account's balance equals its archived totals plus its entries in the database." },
        { q: "What is the settlement account?", a: "The account money passes through on its way out by Faster Payments. The ledger keeps its own view of it (FPS_SETTLEMENT and its 16 parts on each shard); the real money sits at a bank, which sends a statement for it every day." },
        { q: "What is a break?", a: "A difference between the ledger and an outside record that nothing explains. It gets an owner, an amount and evidence, and is closed by a correcting entry or by a fix outside the ledger." },
        { q: "Where do the ledger's totals come from?", a: "Reconciliation builds them in its own database from ledger-events, skipping any transaction id it has already counted, and sums each main account with its 16 parts on every shard. So it puts no load on the ledger's databases." },
        { q: "Why not just fix the wrong entry?", a: "A trigger refuses any update or delete of an entry. A correction is a new transaction, approved by a second person, so the history shows both the mistake and the fix and who approved it." },
      ],
    },
    {
      title: 'When a shard\'s primary dies',
      text: "Later, the machine running one shard's primary dies. A failover tool promotes a synchronous standby from step 4 to be the new primary; it already holds every transaction anyone was told about. Writes to that shard pause, with a target of under a minute. Requests that timed out are retried with the same keys, so none is applied twice.",
      focus: ['db', 'replicas'],
      path: ['wal'],
      labels: ['promote'],
      story: {
        context: "Some time later, one shard's primary fails: a hardware fault, or its zone going dark. Every business on that shard has payments in flight, and some clients are waiting for replies that will never come.",
        problem: "Nobody can write to that shard until a new primary takes over. Some requests committed but their replies were lost; others never committed. The clients cannot tell which is which.",
        consequence: "If the new primary lacked recent commits, acknowledged payments would vanish: money sent with no record of it. If retries were treated as new requests, payments would be applied twice. A long pause stops every business on that shard paying anyone.",
        fix: "Because every commit waited for a standby (step 4), a standby holds every acknowledged transaction: recovery point zero. The failover tool promotes it, aiming for under a minute. Clients retry with the same keys: a payment that committed finds its key and returns the saved result, and one that did not is applied once. The cost: writes to that shard pause during the failover, and promotion needs a failover tool beside Postgres.",
      },
      explain: [
        { q: "What is a failover tool?", a: "A program run beside Postgres that watches each primary. When one fails, it promotes a standby and moves connections to it. Postgres does not make this decision on its own." },
        { q: "What does \"promote\" mean?", a: "Turning a standby, which until now only replays the primary's log, into the primary that accepts writes." },
        { q: "Which standby is promoted?", a: "One that has every acknowledged commit. The commit waited for either s1 or s2, so only the one that confirmed is sure to have the very last record; the tool must pick the standby furthest along the log." },
        { q: "What happens to a payment caught mid-flight?", a: "Its client retries with the same key. If the payment committed, the key is on the new primary and the saved result comes back. If it did not, it is applied now, once." },
        { q: "What if both standbys are lost?", a: "Commits on that shard wait. The design then stops writes on that shard and says so, rather than drop to asynchronous replication and risk losing payments. Other shards carry on." },
        { q: "What about losing a whole region?", a: "The standbys are in other zones of the same region. Losing the region risks the last seconds of data sent asynchronously to another region; the design names that trade-off." },
      ],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        'Whose money? Customer balances for a bank or e-money firm, a marketplace\'s internal ledger, or the company\'s own books? This page assumes a business bank\'s customer ledger.',
        'What does "strict consistency" mean here? I take it as: no balance ever goes below its limit, no money is created or lost, and a read after a write sees it.',
        'How many writes, and how skewed? Average and peak, and whether some accounts appear in most transactions.',
        'Which rails? Faster Payments, Bacs, CHAPS and cards each settle differently, which drives how long money sits in pending clearing.',
        'One currency or many? Who reads it: the app, finance, regulators, auditors?',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Record transactions of two or more entries that always sum to zero, as signed integer minor units with a currency.',
        'Reserve funds into a pending clearing account, then settle or reverse; refuse anything that would take a customer balance below zero.',
        'Never apply the same request twice, whatever the client retries.',
        'Return the current balance (what can be spent) and statements of entries.',
        'Correct mistakes only by adding entries; keep an audit trail of who did what.',
        'Publish every change for other services.',
      ],
    },
    {
      heading: 'How well',
      points: [
        'Assume 1,000 payments a second on average, 10,000 at peak. Each payment is two ledger transactions (reserve and settle), so 2,000 and 20,000 ledger transactions a second.',
        'Target: a reserve or settle in under 50 ms at the 99th percentile inside the ledger.',
        'No acknowledged transaction lost (recovery point zero); a shard back within a minute.',
        'Balance reads always current; statements may lag by a second.',
        'Reconciled internally every few minutes and against the bank every business day.',
      ],
    },
  ],

  numbers: [
    { what: 'Payments', assumption: '1,000 payments a second on average, ten times at peak (payroll, month end, batch files)', result: '86 million a day; build for 10,000 a second' },
    { what: 'Ledger transactions', assumption: 'two per payment: reserve, then settle (or reverse)', result: '2,000 a second on average, 20,000 at peak' },
    { what: 'Entries', assumption: 'five per payment: 2 in the reserve, 3 in the settle', result: '5,000 a second on average, 50,000 at peak; about 430 million a day' },
    { what: 'Storage', assumption: 'about 250 bytes an entry with indexes', result: 'about 110 GB a day, 40 TB a year' },
    { what: 'Hot data', assumption: '13 months in the database (statements, claims windows)', result: 'about 43 TB: 2.7 TB on each of 16 shards' },
    { what: 'Shards', assumption: 'assume 1,000 payments (2,000 ledger transactions) a shard at peak (Modern Treasury load-tested a target of 1,200 transactions a second, not a ceiling)', result: '10 needed, 16 for headroom and uneven tenants' },
    { what: 'One hot row', assumption: 'locked by the trigger until a synchronously replicated commit, assume 1 to 2 ms', result: 'estimate: 500 to 1,000 writes a second' },
    { what: 'House accounts', assumption: 'one shard at its peak of about 1,000 payments a second, each house account split 16 ways', result: 'about 60 writes a second per fee or settlement part; 125 per pending part (written twice a payment)' },
    { what: 'Trigger cost', assumption: 'one extra UPDATE per entry', result: '50,000 a second at peak across all shards, about 3,100 a shard' },
    { what: 'Idempotency keys', assumption: 'two per payment, kept 72 hours, about 150 bytes each', result: 'about 80 GB across all shards' },
    { what: 'accounts table', assumption: '1 million accounts plus 816 house parts, about 100 bytes a row, fillfactor 80, plus the key index', result: 'under 200 MB: always in memory' },
    { what: 'Events', assumption: 'one per ledger transaction, about 1 KB', result: 'about 2 MB a second on average, 20 MB at peak' },
  ],

  framings: [
    {
      name: 'Business bank ledger (this diagram)',
      scale: '1,000 payments a second on average, 10,000 at peak, a million accounts',
      shape: 'Postgres sharded by business. An append-only journal and a trigger-kept balance cache with a CHECK against overdraft, one call per transaction, pending clearing accounts, synchronous standbys, 16-way house accounts, an outbox for events, the journal partitioned by month, daily reconciliation.',
    },
    {
      name: 'First version',
      scale: 'up to about 1,000 a second',
      shape: 'One Postgres primary with a synchronous standby and no sharding. The same tables, triggers, function and outbox, so sharding later is routing, not a rewrite. Most companies never need more.',
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
    { choice: 'Concurrency control', a: 'Pessimistic: lock the accounts in account_id order with FOR NO KEY UPDATE, then insert the entries in one conditional statement, in one database call.', b: 'Optimistic: version check and retry on conflict.', call: 'Pessimistic. Optimistic retries collapse exactly when an account is busy, and the lock lasts only 1 to 2 ms because it never waits on the network.' },
    { choice: 'Balance', a: 'A cached balance on accounts, updated in the same transaction as the entries.', b: 'Summed from entries on every read.', call: 'Cached, so checks are one row and reads are exact. Reconciliation proves balance equals archived totals plus entries.' },
    { choice: 'Who keeps the balance', a: 'A trigger on ledger_entries, with a guard against direct edits.', b: 'The application (or its function) runs the UPDATE beside each insert.', call: 'The trigger. The database refuses a wrong balance whatever code path writes: nobody can forget the update or edit a balance by hand. The price is logic in the database that application developers must know about, and a break-glass step to rebuild a balance.' },
    { choice: 'The per-entry trigger', a: 'A row-level AFTER INSERT trigger: one extra UPDATE per entry.', b: 'A statement-level trigger with a transition table, one UPDATE per account per statement.', call: 'Row-level for payments, where a statement has two or three entries anyway. Bulk loads and migrations fire it row by row, so they use a statement-level path or run in small batches.' },
    { choice: 'Overdraft', a: 'CHECK (allow_negative OR balance >= 0) on accounts, with the conditional insert as the clean path.', b: 'Only the application\'s funds check.', call: 'Both. The CTE returns "insufficient funds" cleanly; the CHECK refuses any path that skipped it.' },
    { choice: 'Entry amounts', a: 'One signed amount: plus a credit, minus a debit.', b: 'Separate debit and credit columns, or a direction column with a positive amount.', call: 'Signed. A balance is SUM(amount) and a transaction balances when SUM(amount) = 0, both one expression. The cost: readers must know the sign convention, and accountants\' debit-normal and credit-normal views are worked out in reports.' },
    { choice: 'Pending payments', a: 'Balanced transactions through a pending clearing account; payment state on the Banking API\'s record.', b: 'A status column on entries and pending totals on the balance row.', call: 'Clearing account. Entries never change, so they cannot carry a status. The ledger shows where the money is; the payment record says PENDING, SETTLED or FAILED. One balance figure, what can be spent.' },
    { choice: 'Partitioning the journal', a: 'By month on created_at, so old months detach and archive.', b: 'One unpartitioned table, keys as written.', call: 'Partition. The price: every unique key must include created_at, so UNIQUE (transaction_id, account_id) guards only within a partition, and idempotency_keys is the guard that holds across them.' },
    { choice: 'Hot accounts', a: 'Sub-accounts with periodic sweeps.', b: 'Credit-only accounts skip the trigger, with an asynchronous balance.', call: 'Sub-accounts, 16 per shard. Skipping the trigger breaks "balance equals sum of entries" for those accounts.' },
    { choice: 'Transfers across shards', a: 'Saga through a clearing account: debit on one shard, credit on the other, each its own transaction.', b: 'Two-phase commit across shards.', call: 'Keep a business on one shard; for the rare cross-shard transfer, a saga. The clearing account shows anything in flight.' },
    { choice: 'Durability', a: 'Synchronous standby, quorum of one in two.', b: 'Asynchronous replication.', call: 'Synchronous. Roughly a millisecond per commit (an estimate) is the price of losing nothing.' },
    { choice: 'Events', a: 'Outbox row in the same transaction, read by CDC.', b: 'Publish after commit.', call: 'Outbox. A dual write loses or invents events on every crash.' },
    { choice: 'Database', a: 'Postgres, which the team knows.', b: 'A purpose-built ledger database (TigerBeetle).', call: 'Postgres at this scale; move the posting engine when hot-account contention dominates.' },
  ],

  drills: [
    { name: 'A shard\'s primary dies', what: 'Promote the synchronous standby: it has every acknowledged commit. Writes to that shard pause; we target under a minute. Clients retry with the same keys.' },
    { name: 'Both synchronous standbys are lost', what: 'Commits on that shard block. Stop accepting writes there and say so, rather than drop to asynchronous replication and risk losing payments. Other shards carry on.' },
    { name: 'The scheme times out after we sent', what: 'The payment is unknown, not failed. The money stays in FPS_PENDING; ask the scheme for its status with the same payment id, then settle or reverse.' },
    { name: 'FPS_PENDING does not return to zero', what: 'Some payment is stuck between reserve and settle. List the reserves on that part with no settle or reverse, match them to payment records, and finish each one with its own key.' },
    { name: 'Two retries arrive at once', what: 'The unique key lets one insert win; the other waits on the row and then returns the stored result, or gets a conflict and retries.' },
    { name: 'Someone runs UPDATE accounts SET balance = ...', what: 'The guard trigger refuses it: the statement runs at trigger depth 1. Editing another column of the row is allowed.' },
    { name: 'A code path skips the funds check', what: 'The CHECK valid_balance refuses the negative balance (SQLSTATE 23514) and the transaction rolls back. Find the path; the books were never wrong.' },
    { name: 'A replay arrives in a new month', what: 'On the partitioned table, UNIQUE (transaction_id, account_id, created_at) would let it through with a new created_at. idempotency_keys, inserted first, catches it. Keep keys long enough to cover the retry window.' },
    { name: 'Kafka is down', what: 'The ledger is unaffected. Outbox rows wait in the log; the relay catches up. Watch the primary\'s disk, because the replication slot holds log until it is read.' },
    { name: 'The relay publishes an event twice', what: 'Consumers keep the last log position applied per account and skip anything at or below it.' },
    { name: 'A house account becomes the bottleneck', what: 'Lock waits on its parts climb. Raise its sub-accounts from 16 to 32; nothing else changes.' },
    { name: 'A balance disagrees with its entries', what: 'The invariant check alarms. The guard should make this impossible, so suspect a trigger disabled or bypassed (session_replication_role = replica skips triggers). Freeze the account and rebuild the balance from account_period_totals and the entries in a reviewed break-glass change: disable the guard inside one transaction, recompute, re-enable it, and audit who ran it.' },
    { name: 'The bank statement is £5 off', what: 'A break is raised with owner, amount and evidence. When the cause is found, a correcting transaction is posted and approved by a second person.' },
    { name: 'A bad deploy posts wrong fees', what: 'Turn off the code path. Write reversing transactions through a reviewed bulk job that shows its effect first. The original entries stay as the record.' },
    { name: 'A schema change on a 2.7 TB journal', what: 'Expand, then contract: add nullable columns, deploy a new version of the ledger function beside the old, switch callers, and only later drop what is unused. Never rewrite existing entries: the append-only trigger refuses it anyway.' },
    { name: 'A whole region is lost', what: 'Synchronous standbys are in other zones of the same region, so a region loss risks the last seconds sent asynchronously to the other region. Name this trade-off out loud.' },
  ],

  interview: [
    'Open with the model before any boxes: accounts, transactions of two or more entries that sum to zero, entries never changed. Signed integers in pence with a currency. Then say the two invariants: every transaction balances, and no customer balance goes below zero under concurrency.',
    'Do the sums early. 1,000 payments a second average and 10,000 at peak, two ledger transactions and five entries each, is within reach of sharded Postgres; the real limit is one hot row, which I estimate at 500 to 1,000 writes a second.',
    'Show the two tables: ledger_entries append-only behind a trigger, accounts as a balance cache kept by a trigger, with a guard against direct edits and a CHECK against overdraft.',
    'Draw the write path: API, ledger API, one database call that inserts the key, locks the accounts in id order with FOR NO KEY UPDATE, inserts the entries only if funded, adds an outbox row, and commits to a synchronous standby.',
    'Spend your depth on concurrency. Compare this with a conditional balance update, optimistic versions, serializable, single writer per account and TigerBeetle, then say why the database should refuse a wrong balance itself.',
    'Then hot accounts: every entry locks its account through the trigger, so house accounts are split 16 ways per shard and swept.',
    'Cover idempotency end to end: the key from the client, the unique row in the same transaction, the stored result on retry, expiry after 72 hours. Be ready for the partitioning push: the UNIQUE on entries then holds only within a month.',
    'Finish with proof: invariant checks (balance equals archived totals plus entries), daily reconciliation against bank statements, breaks fixed by correcting entries. Mention safeguarding if it is an e-money firm.',
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
    { label: 'PostgreSQL docs: Client settings (session_replication_role)', href: 'https://www.postgresql.org/docs/current/runtime-config-client.html', note: 'Set to replica, ordinary triggers do not fire; only superusers and users granted the right may change it.' },
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
    { term: 'Double-entry', also: ['double-entry bookkeeping'], where: 'ledger', text: 'Every movement of money is recorded at least twice: where it came from and where it went. With signed amounts, the entries of one transaction sum to zero, so money is never created or lost by a write.' },
    { term: 'Entry', also: ['posting', 'ledger entry', 'leg', 'ledger_entries'], where: 'db', see: { id: 'append-log', label: 'Append-only log' }, text: 'One debit or credit to one account: a row in ledger_entries with transaction_id, account_id, a signed amount in pence (plus a credit, minus a debit) and created_at. Entries are only ever inserted; a trigger refuses UPDATE and DELETE.' },
    { term: 'Transaction', also: ['journal entry', 'transfer'], where: 'ledger', text: 'A group of two or more entries that commit together and sum to zero per currency. A payment is two: the reserve (two entries) and the settle (three entries, the fee among them).' },
    { term: 'Normal balance', also: ['debit normal', 'credit normal'], where: 'ledger', text: 'Which direction increases an account. A customer\'s account is money the bank owes, a liability, so it is credit normal: a credit raises it. The bank\'s cash at its own bank is an asset, debit normal. This design stores one signed amount (plus a credit) and leaves the normal-balance view to reports.' },
    { term: 'Minor units', also: ['pence', 'integer amounts', 'asset scale'], where: 'ledger', text: 'Amounts stored as whole numbers of the smallest unit, such as pence, with the currency beside them. Never floating point. The scale is hard to change later, so choose it once.' },
    { term: 'Pending', also: ['hold', 'reserve', 'reservation'], where: 'fps', text: 'Money promised but not yet final. Here a reserve moves it from the wallet into a pending clearing account, FPS_PENDING, and a settle or reverse moves it on. The payment\'s state, PENDING, SETTLED or FAILED, lives on the Banking API\'s payment record.' },
    { term: 'Clearing account', also: ['FPS_PENDING', 'pending clearing account'], where: 'fps', text: 'An account money passes through on its way somewhere else, which should return to zero once the move completes. A balance left behind for long shows something stuck.' },
    { term: 'Settle and reverse', also: ['settled', 'post', 'void'], where: 'fps', text: 'The two ways a reserve ends. Settle: minus from FPS_PENDING, plus to the scheme settlement account and fee income. Reverse: minus from FPS_PENDING, plus back to the wallet. Each is a new transaction with its own key; nothing is edited.' },
    { term: 'Two-phase transfer', also: ['post pending'], where: 'fps', text: 'Reserve with a pending transfer, then post it (in full or in part) or void it. TigerBeetle has this built in and lets a pending transfer expire after a timeout. This design gets the same effect with ordinary transactions through a clearing account.' },
    { term: 'Balance', also: ['available balance', 'ledger balance', 'balance cache'], where: 'db', text: 'accounts.balance: the sum of the account\'s entries, kept by a trigger. Because a reserve takes the money out of the wallet at once, it is also what can be spent; there is no separate available figure. Monzo keeps tens of named balances, each defined by accounts and a time axis.' },
    { term: 'Reversal', also: ['correcting entry', 'compensating entry'], where: 'recon', text: 'A new transaction that undoes the effect of an earlier one. The original stays, so the history shows both the mistake and the fix.' },
    { term: 'Idempotency key', also: ['Idempotency-Key'], where: 'client', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, text: 'A unique value the client sends with a request so a retry is recognised. Stored in the ledger\'s own transaction with a unique constraint; a repeat returns the first result. Stripe may prune keys once they are 24 hours old; Brandur Leach suggests about 72.' },
    { term: 'Conditional update', also: ['guarded update', 'compare and set'], where: 'db', text: 'An UPDATE whose WHERE clause carries the rule, such as "balance >= amount". If no row matches, nothing changes and the caller knows the check failed. The previous version of this design; it is now an alternative.' },
    { term: 'Trigger', also: ['AFTER INSERT', 'BEFORE UPDATE'], where: 'db', text: 'A function the database runs by itself when a row is written, inside the same transaction. Here one refuses changes to entries, one adds each entry to its balance, and one guards balance against direct edits.' },
    { term: 'Trigger depth', also: ['pg_trigger_depth'], where: 'db', text: 'How many triggers deep the current statement runs. Inside the guard, a direct UPDATE is at depth 1 and the entry trigger\'s UPDATE at depth 2, so the guard refuses only the first. In a WHEN clause the direct statement counts as depth 0.' },
    { term: 'CHECK constraint', also: ['valid_balance'], where: 'db', text: 'A rule the database checks on every row it writes. CHECK (allow_negative OR balance >= 0) keeps wallets, pending clearing and revenue at or above zero; a breach fails with SQLSTATE 23514.' },
    { term: 'Fillfactor', where: 'db', text: 'How full PostgreSQL fills each table page on insert. accounts uses 80, leaving a fifth free for new row versions.' },
    { term: 'HOT update', also: ['heap-only tuple'], where: 'db', text: 'An UPDATE whose new row version fits on the same page and changes no indexed column, so no index is touched. The trigger\'s balance updates qualify when the page has room.' },
    { term: 'MVCC snapshot', also: ['MVCC', 'multi-version concurrency control'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'PostgreSQL keeps old versions of rows. A plain SELECT sees the rows as committed when its snapshot was taken, so it never waits for a writer, and sees a balance and its entries together or not at all.' },
    { term: 'CTE', also: ['common table expression', 'WITH'], where: 'db', text: 'A named sub-query, WITH name AS (...). The reserve\'s CTE returns a row only if the money is there, and the INSERT joins to it, so both entries are written or neither.' },
    { term: 'FOR NO KEY UPDATE', also: ['SELECT FOR UPDATE', 'row lock', 'pessimistic locking'], where: 'db', see: { id: 'two-phase-locking', label: 'Two-phase locking' }, text: 'Reads rows and locks them until the transaction ends, so other writers wait. The weakest lock that does the job: unlike FOR UPDATE it does not block foreign key checks (FOR KEY SHARE) from tables that only reference the row.' },
    { term: 'Lock ordering', also: ['deadlock'], where: 'db', text: 'Taking locks on several rows in the same order everywhere, such as ascending account id. Two transfers between the same accounts in opposite directions then cannot each hold the lock the other wants.' },
    { term: 'Optimistic concurrency', also: ['version column', 'lock_version'], where: 'db', see: { id: 'mvcc', label: 'MVCC' }, text: 'Write only if the row\'s version is still the one you read; otherwise fail and retry. Retries pile up on busy rows.' },
    { term: 'Serializable isolation', also: ['SSI', 'serialization failure', '40001'], where: 'db', text: 'The database guarantees the result is as if transactions ran one at a time, aborting any that would break that. The application must retry those aborts.' },
    { term: 'Single writer per account', also: ['actor per account'], where: 'db', text: 'Route every write for an account to one thread or partition that applies them in order, so no locks are needed. A transfer between two owners becomes a two-step exchange.' },
    { term: 'Hot account', also: ['hot row', 'hot key'], where: 'sweeper', text: 'An account in most transactions: fee income, a settlement or clearing account. Every entry\'s trigger locks its row, so it becomes a queue: only one writer can hold it at a time.' },
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
    { term: 'Invariant check', also: ['trial balance'], where: 'recon', text: 'A query that must always hold: all entries per currency sum to zero, each transaction sums to zero, each account\'s balance equals its archived period totals plus its entries in the database.' },
    { term: 'account_period_totals', also: ['period totals'], where: 'archive', text: 'This design\'s table of each account\'s total per archived month, written before the partition is detached, so a balance can still be checked against its entries after archive.' },
    { term: 'Break-glass rebuild', also: ['rebuild a balance'], where: 'recon', text: 'The only way to rewrite a balance: a reviewed change that disables the guard trigger inside one transaction, recomputes the balance from the entries, re-enables the guard and is audited.' },
    { term: 'Reconciliation break', also: ['break', 'reconciliation difference'], where: 'recon', text: 'A difference between the ledger and an outside record, such as the bank statement. It gets an owner, an amount and evidence, and is closed with a correcting entry or a fix outside.' },
    { term: 'Safeguarding', also: ['CASS 15'], where: 'recon', text: 'For an e-money or payment firm, keeping customers\' money apart from the firm\'s own. Under the FCA\'s CASS 15 rules, in force from 7 May 2026, safeguarded funds are reconciled every business day.' },
    { term: 'Faster Payments', also: ['FPS'], where: 'fps', text: 'The UK\'s 24/7 real-time payment scheme, up to £1 million a payment at scheme level; each bank sets its own limit. Bacs takes three working days; CHAPS is for high-value same-day payments.' },
    { term: 'APP fraud reimbursement', also: ['authorised push payment'], where: 'api', text: 'Since 7 October 2024, payment firms must reimburse consumers, micro-enterprises and charities who fall for authorised push payment scams on Faster Payments and CHAPS, up to £85,000 a claim.' },
    { term: 'Effective date', also: ['effective_at', 'posted time', 'value date'], where: 'db', text: 'When an entry counts for accounting, which may be earlier than when it was written. Keep both: Monzo calls them reporting and committed time. Balances "as at" a date use the effective date.' },
    { term: 'Keyset pagination', also: ['cursor pagination'], where: 'replicas', see: { id: 'b-plus-tree', label: 'B+ tree' }, text: 'Fetching the next page as "entries older than the last row I saw", by created_at and entry_id through idx_ledger_account_created, not an offset. Pages stay stable as new entries arrive.' },
    { term: 'Partition', also: ['partitioning', 'DETACH PARTITION'], where: 'archive', see: { id: 'partitioning', label: 'Partitioning' }, text: 'One piece of a table stored separately, chosen by a column. ledger_entries is partitioned by month on created_at; an old month is detached and archived. Every unique key must then include created_at.' },
    { term: 'Hash chain', also: ['tamper evidence'], where: 'db', text: 'Each entry stores a hash of its contents and the previous entry\'s hash, so changing any old entry breaks every hash after it. An option for tamper evidence; TigerBeetle hash-chains its data.' },
    { term: 'FX transfer', also: ['currency exchange', 'liquidity account'], where: 'ledger', text: 'Never mix currencies in one transaction. Exchanging pounds for euros is two linked transactions: pounds from the customer to an FX account, euros from the FX account to the customer, both or neither.' },
  ],
};
