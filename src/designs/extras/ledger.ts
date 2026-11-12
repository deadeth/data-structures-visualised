import type { Extras } from './types';

/**
 * Interview extras for the ledger service.
 *
 * The question: "Design a central multi-currency ledger for a business bank: bank payments,
 * payroll, debit and credit card authorisations and settlements, and accounts in several
 * currencies. Balances must be strictly consistent under high-frequency writes."
 *
 * The design (owner's third spec, with the changes the expert review forced; brief
 * /tmp/alts/ledger4-fixes.md): we are an authorised bank. One header row per transaction in
 * ledger_transactions (id made by the caller from the request; primary key and UNIQUE (kind,
 * external_ref) are the lasting duplicate guard); append-only ledger_entries holding settled
 * movements only, summing to zero per currency, checked once per transaction at commit;
 * pending_holds for money promised but not moved (ACTIVE, then CAPTURED, VOIDED or EXPIRED,
 * once), not partitioned, ended holds archived after 90 days; accounts with posted_balance and
 * held_balance as caches kept by triggers and guarded; credit_limit is the soft limit, tested
 * only when a customer starts a debit; hard_limit is the floor the CHECK enforces; past it, the
 * customer's own receivable. status OPEN, NO_NEW_SPEND or CLOSED. Every path locks the account
 * rows first, in account_id order, then touches holds. Timeouts on the role: lock 50 ms,
 * statement 250 ms, plus a client deadline. Hot system accounts split 16 ways. Outbox, no 2PC.
 * Phases: one Postgres cluster, more clusters by business, then TigerBeetle.
 *
 * Figures at the stress load (1,000 payments a second average, 10,000 peak): 86.4 million
 * payments a day; a bank payment is one hold insert, one hold update and one ledger transaction
 * of three entries; a dollar card payment on a sterling card is also three entries (the network
 * sends the billing amount in GBP), a credit card capture two. About 260 million entries, 86
 * million holds and 86 million header rows a day. Storage: 65 GB entries (250 bytes) + 13 GB
 * holds (150 bytes) + about 8.6 GB headers (about 100 bytes, an estimate) = about 87 GB a day.
 * Hot in year 1: entries 65 GB x 395 days = 26 TB; holds about 92 days x 13 GB = 1.2 TB;
 * headers, never deleted or partitioned, 8.6 GB x 365 = 3.1 TB a year (0.3 to 0.8 TB a year at
 * the baseline); about 30 TB, about 8 TB a cluster across four, then about 0.8 TB more a cluster
 * each year. Idempotency keys: 2 x 86M x 3 days x 200 bytes = about 100 GB. Payroll runs as
 * payroll_writer (5 s). Agrees with src/designs/ledger.ts. Two write transactions per
 * payment: 2,000 a second average, 20,000 peak; 2,500 / 16 = about 156 writes a second per
 * split system row. Baseline: 10 to 20 payments per business per day for a million businesses
 * is 10 to 20 million a day, 116 to 231 a second, "roughly 100 to 250".
 * Canonical examples A to D from the brief: Bright Bakery, GBP wallet ...081442, posted 842000;
 * credit card ...081444, credit_limit 500000, hard_limit 550000.
 */
export const extras: Extras = {
  opening: [
    "This is the central ledger for a business bank: bank payments, payroll, debit and credit cards, and accounts in several currencies. Its job: say what each customer has, prove where every penny came from, and never let a customer start a spend past their limit.",
    "My main assumption: we are an authorised bank, so balances are deposits protected by FSCS, and the ledger must produce the Single Customer View file on demand. Load: about a million businesses, 1,000 payments a second as a stress case, 10,000 at peak. Amounts are whole pence and cents, in BIGINT.",
    "The journal is the truth. ledger_entries holds settled movements only. It is append-only, and each transaction sums to zero in each currency, checked at commit.",
    "Every transaction has one header row in ledger_transactions. The caller makes its id from the request, so a retry makes the same id. Its primary key, and a unique key on the scheme's own reference, are the lasting guard against a double post.",
    "Money promised but not yet moved is a hold, in pending_holds. It starts ACTIVE and ends once: CAPTURED, VOIDED or EXPIRED.",
    "accounts keeps two caches, posted and held, each moved only by a trigger. Each account has a soft credit limit, tested when the customer starts a spend, and a hard floor that a CHECK enforces, so the bank's own postings, like interest and late settlements, still land. A debit wallet is zero and zero.",
    "Every write locks the account rows first, in id order, then touches holds. Timeouts are set on the database role: 50 ms to wait for a lock, 250 ms for a statement, and the client keeps its own deadline. Hot system accounts are split 16 ways.",
    "The payment scheme is never inside a database transaction. An outbox row commits with the money, and there is no two-phase commit.",
    "It grows in three phases: one Postgres cluster; clusters split by business; then TigerBeetle for the hot path. I'll do the data model, one payment end to end, then concurrency, failure and delivery.",
  ],

  pushes: [
    // Licence and scope
    {
      q: "Are you a bank or an e-money firm, and what changes?",
      a: [
        "I've assumed a bank. Balances are deposits on our balance sheet, protected by FSCS, and the ledger must produce the Single Customer View file, each depositor's eligible total, on demand.",
        "As an e-money firm, the same wallets would be safeguarded funds under CASS 15, reconciled every business day against the safeguarding accounts. Credit would be funded from the firm's own money, never customers'.",
        "The ledger barely changes; reconciliation and reports do.",
      ],
    },
    {
      q: "Is 1,000 payments a second realistic?",
      a: [
        "Not as an average. It is a stress case: 86 payments per business per day. Pay.UK reports about 5.5 billion Faster Payments for the whole UK in 2025, about 15 million a day. My stress case is 86 million.",
        "A reasoned baseline is 10 to 20 payments per business a day: roughly 100 to 250 a second. One cluster carries that for a long time. The stress figures size the later phases.",
      ],
    },
    // Money model
    {
      q: "One table for debit wallets, overdrafts and credit cards. How?",
      a: [
        "Two limits. credit_limit is the soft limit: a customer's hold goes in only if the account is OPEN and posted minus held minus the amount stays at or above minus credit_limit. hard_limit is the floor a CHECK enforces, never above credit_limit.",
        "A debit wallet is 0 and 0. The bakery's card is 500,000 and 550,000. Signs never change: a £649.00 purchase is a hold of 64,900, leaving 435,100 available; the capture posts card -64,900, MASTERCARD_CREDIT_CLEARING_GBP +64,900.",
        "The honest cost: the backstop is the hard floor, not the exact limit. A code path that skipped the soft check could overspend that card by up to £500.00.",
      ],
    },
    {
      q: "Why a separate holds table and two cached balances? Why not entries, or one balance?",
      a: [
        "A hold changes and the journal must not. As entries, every voided authorisation would leave two entries for money that never moved.",
        "Posted is money that has moved: statements, interest and the Single Customer View use it. Available is posted minus held plus credit_limit: what the customer can spend. One balance mixes promises with facts.",
        "Cached, because the funds check must lock one row, not sum years of entries.",
      ],
    },
    {
      q: "Why triggers? And can nobody really edit a balance?",
      a: [
        "Triggers because nobody can forget them. Any path that writes an entry or a hold moves the balance in the same transaction, with one UPDATE on a row already locked.",
        "No INSERT, UPDATE or application role can set a balance. Accounts open at zero, a guard refuses direct edits, and DELETE and TRUNCATE are revoked or refused.",
        "But the table owner or a superuser can disable triggers, so DDL is reviewed and logged. Break-glass, session_replication_role replica, also switches off the append-only triggers and foreign keys, so it needs a second person.",
      ],
    },
    {
      q: "How do you correct a wrong entry, even one the customer has already spent?",
      a: [
        "With a new transaction, never an edit. A reversing transaction with opposite amounts, its header's reverses column pointing at the original, then the right one. Corrections need a second approver.",
        "If the customer has spent the money, the reversal is a posting the bank must accept. It can take the account past the soft limit to the hard floor, and anything beyond goes to that customer's own receivable, for collections.",
      ],
    },
    {
      q: "Walk me through your end of day.",
      a: [
        "End of day is a date, not a stop. Each header carries a value_date from a cut-off calendar in Europe/London, and payments keep flowing across the cut-off.",
        "After the cut-off a job writes account_balances_daily: account, business date, posted, held. Statements, interest, the Single Customer View and reconciliation all read that one snapshot.",
        "Then the sweep folds the 16 rows of each system account into its master, and reconciliation starts.",
      ],
    },
    {
      q: "How do you prove the caches and the books are right?",
      a: [
        "Inside: every few minutes, an incremental check of accounts touched since the watermark: account_balances_daily plus entries after its last_entry_id, and ACTIVE holds. Weekly, a full re-sum on a replica. Each currency sums to zero.",
        "Outside: real money is in the ledger as nostro accounts. NOSTRO_BOE_GBP must match the closing balance on our settlement account's statement at the cut-off, and each clearing account goes back to zero, or is aged, after its settlement cycle.",
        "A difference pages. Freeze the account and find the cause; a cache is rebuilt only in a reviewed break-glass change.",
      ],
    },
    // Cards and credit
    {
      q: "Walk me through a debit card payment in dollars, from authorisation to settlement.",
      a: [
        "On a sterling card we don't quote a rate. As I understand it, the network converts and sends the billing amount in pounds: USD 100.00 arrives as 8,000. I hold 8,240, a 3 per cent buffer for rate movement. Nothing goes in the journal.",
        "It clears at 7,900. One transaction ends the hold and posts three entries, all GBP: wallet -7,979, MASTERCARD_DEBIT_CLEARING_GBP +7,900, FX_FEE_REVENUE_GBP +79, our 1 per cent non-sterling fee. 261 is freed.",
        "FX pools are for moving money between the bakery's own wallets: £8,000.00 to dollars at 1 USD = 0.80 GBP: GBP wallet -800,000, FX_POOL_GBP +800,000; FX_POOL_USD -1,000,000, USD wallet +1,000,000. Each currency sums to zero on its own.",
        "A card settling with the network in dollars would post a five-entry bridge through the pools.",
      ],
    },
    {
      q: "The settlement is larger than the hold, or a card at its limit must take interest or a returned Direct Debit. What do you write?",
      a: [
        "These are postings the bank must accept, so the soft limit is not tested. The posting ends any live hold for that authorisation in the same transaction, and may take the account past credit_limit, down to hard_limit.",
        "Past the hard floor, the account goes to its floor and the rest is debited to that customer's own receivable, never a pooled account. One balanced transaction; the CHECK never gives way.",
        "A card at -501,450 that must take 60,000 goes to -550,000 and its receivable to -11,450. An EXPIRED hold has left ACTIVE, so a late settlement posts as if there were no hold.",
      ],
    },
    {
      q: "A hotel pre-authorises £300, adds £150, then clears £420 in two presentments.",
      a: [
        "The card service keeps one authorisation record: network reference, authorised and cleared amounts. Holds are its children. £300 is a hold of 30,000; the £150 increment is a second hold of 15,000.",
        "Say the first presentment is £200. One transaction captures the 30,000 hold, posts -20,000 and places a new hold of 10,000 for the rest. 25,000 is still held.",
        "The second, £220, captures both remaining holds and posts -22,000. 3,000 is freed, and the record shows £420 cleared.",
      ],
    },
    {
      q: "Mastercard re-sends last week's clearing file. What stops the double post?",
      a: [
        "The header table. Each settlement's transaction id is a UUIDv5 of the rail and the network's own reference, so the replay makes the same id and the primary key refuses it.",
        "If some path made a new id, UNIQUE (kind, external_ref) still refuses the same reference twice. The loader counts refusals as already posted and reports them.",
        "Headers are never deleted, so that guard lasts for good.",
      ],
    },
    {
      q: "A customer disputes a £2,000 card payment.",
      a: [
        "The original payment stays. If we give a provisional credit, it is a new transaction: wallet +200,000 from a chargeback suspense account, its header linked to the original.",
        "The scheme's outcome then posts or reverses it. If we lose and the customer has spent the money, the reversal goes down to the hard floor and the rest to their receivable.",
        "A merchant refund is simpler: a credit posting, no hold. Interchange is income, booked from the settlement report.",
      ],
    },
    {
      q: "You cut a card's limit below what it has already used. What happens?",
      a: [
        "The update is allowed, because the CHECK tests the hard floor, not credit_limit. New holds then place nothing.",
        "To stop spend outright, set status to NO_NEW_SPEND. A hold needs OPEN, but repayments, refunds, interest and already-approved settlements still post. Only CLOSED refuses entries, and only an empty account can close.",
        "Only the credit service's role may change credit_limit, hard_limit, allow_negative and status. The debt never changes by an edit.",
      ],
    },
    {
      q: "How does a repayment restore credit?",
      a: [
        "After the £649.00 capture the card is at -64,900. A repayment of 30,000 from the bakery's wallet leaves -34,900, so available credit is 465,100 the moment it commits.",
        "If the customer has a receivable, the Ledger API splits the credit and clears that first: wallet -30,000, receivable +11,450, card +18,550.",
        "Credit is restored at once only when the incoming money is final. A Direct Debit we collect can still come back, so that credit waits.",
      ],
    },
    {
      q: "Where do interest, statements and the repayment waterfall live?",
      a: [
        "In a billing service. Interest accrues daily between two system accounts: INTEREST_RECEIVABLE_GBP -32, INTEREST_INCOME_GBP +32. No customer account is touched.",
        "On statement day billing charges the card once: card -X, INTEREST_RECEIVABLE_GBP +X. Paid in full within the grace period, the accrual is reversed and the card never sees it.",
        "For regulated credit cards, CONC 6.7.4R sends repayments to the highest-rate balance first; Osborne Clarke's note on the 2021 amendment covers it. A limited company's card is mostly outside the Consumer Credit Act; sole traders and small partnerships are inside. So billing keeps balance segments by rate.",
        "Debiting the card every night lost: it breaks the grace period, compounds daily, eats available credit and fails at the limit.",
      ],
    },
    // Concurrency
    {
      q: "Two payments from the same account arrive in the same millisecond, and together they exceed what is available. Prove only one succeeds.",
      a: [
        "Each locks the account row first, FOR NO KEY UPDATE. The second waits until the first commits.",
        "Its conditional insert then sees the first hold and places nothing. It saves the decline on its idempotency key and commits, so a retry gets the same answer.",
        "I'd prove it with a test: thousands of concurrent holds on one account, then assert none past the soft limit.",
      ],
    },
    {
      q: "Why lock at all, if a CHECK guards the balance? And why FOR NO KEY UPDATE?",
      a: [
        "The CHECK guards the hard floor, not the soft limit, so it cannot stop an overspend between the two. The conditional insert under the lock does, and gives a clean decline, not error 23514 half way through.",
        "The lock also fixes the order, which stops deadlocks.",
        "FOR NO KEY UPDATE is the weakest lock that still stops two balance writers; it does not block inserts that only reference the account. The gain is small, but lock no more than you need.",
      ],
    },
    {
      q: "How do you know one hold can never be both captured and voided?",
      a: [
        "The hold's trigger allows one change, ACTIVE to CAPTURED, VOIDED or EXPIRED, and nothing after. Capture and void each update the hold only where it is ACTIVE, so the second finds nothing to do.",
        "Lock order matters too. A reviewer got a deadlock racing a void against a capture, because void locked the hold first. Now every path locks the account rows first, in account_id order, then touches holds. The expiry job does one account per transaction.",
        "Tested on PostgreSQL 16 with real sessions: 200 rounds of capture racing void, no errors, 128 captured, 72 voided, balances exact.",
      ],
    },
    {
      q: "Your timeouts are 50 ms for locks and 250 ms for statements. Where are they set, and what does the caller see?",
      a: [
        "On the database role, so they apply at connection start and hold behind PgBouncer. statement_timeout set inside the ledger function does nothing for that call; the timer has already started. Batch roles get longer values.",
        "statement_timeout does not cover the commit's wait for a synchronous standby. Only the client's own deadline does.",
        "On a timeout the transaction rolls back and the caller retries with the same key. A card authorisation retries briefly, then declines or uses stand-in rules. Payroll waits in a queue.",
      ],
    },
    {
      q: "Every bank payment credits FPS clearing and fee revenue. At peak, what happens to those rows, and what protects them?",
      a: [
        "One row holds its lock 1 to 2 ms, so it takes roughly 500 to 1,000 writes a second. So each hot system account is 16 rows, picked by hash of the transaction id: at 2,500 payments a second per cluster, about 156 writes a second each.",
        "Fillfactor 80 lets each update stay on its page as a HOT update, but only while old versions can be pruned. So no long transactions on the primary, idle_in_transaction_session_timeout, and an alert on the oldest xmin.",
        "System accounts may go negative, so the CHECK skips them. They are protected by the fixed shape of each posting, the zero sum per currency, limits on each logical total, and reconciliation.",
      ],
    },
    {
      q: "Payroll for 5,000 employees, paid on Friday 27 November.",
      a: [
        "Dual approval and limits live in the Banking API. On approval the ledger places one hold for the run's total on the employer, expiring 30 November. If the employer is short, no hold is placed and the run waits for funds.",
        "On the Bacs processing day one transaction captures the hold and debits the employer once; the 5,000 lines go in the Bacs file. The header's value date is the 27th. If they all bank with us, it is 5,001 entries: about 0.7 seconds in a test, so it runs as payroll_writer with a 5 s timeout. Chunks through PAYROLL_CLEARING_GBP are the fallback.",
        "Returns post later as their own transactions, linked by reverses.",
      ],
    },
    // Failure
    {
      q: "Both synchronous standbys are gone. What is locked, and what does a card authorisation see?",
      a: [
        "With ANY 1 (s1, s2), a commit waits for one standby and keeps its row locks. With both gone, every commit waits, and everything touching those rows queues behind it.",
        "A card authorisation hits its lock timeout or its client deadline, and is declined or goes to stand-in. Its outcome is unknown, so the retry with the same key settles it later.",
        "The runbook never cancels a waiting backend: Postgres would report success with a warning that it may not be replicated. We fence the old primary, then promote. Recovery point zero holds for one failure at a time.",
      ],
    },
    {
      q: "Why not two-phase commit with the scheme or the card network? And how do events get out safely?",
      a: [
        "They are not participants in my database transaction. Locks would be held across a network call, and a dead coordinator leaves customer rows locked. Instead the hold commits with an outbox row, and the scheme's answer comes back as a capture or a void. A timeout is unknown, not failed.",
        "There is one outbox row per customer account a transaction touches, and consumers dedupe on its seq. The relay's slot is a failover slot, and synchronized_standby_slots makes it wait for the standbys, so it never publishes a commit a promotion would lose. I have not run those PostgreSQL 17 settings.",
      ],
    },
    {
      q: "The bakery pays a supplier on another cluster. Walk me through it and the crash in between.",
      a: [
        "Two local transactions with the same transaction id. On the payer's cluster: wallet -X, INTERCLUSTER_OUT +X, and an outbox row. The outbox drives the second on the payee's cluster: INTERCLUSTER_IN -X, supplier +X.",
        "If we crash in between, the first has committed with its outbox row, so the relay delivers it after restart. A repeat of the second is refused by its header.",
        "The OUT and IN accounts must net to zero across clusters, and reconciliation watches the age of anything in flight.",
      ],
    },
    // Scale
    {
      q: "You partition the journal by month. What happens to your unique keys?",
      a: [
        "Every unique key must include created_at. That defaults to now(), so a replay always has a new one, and (transaction_id, account_id, created_at) guards nothing on its own, not even within a month.",
        "The guards are the header table, never partitioned or deleted; and idempotency_keys, 72 hours, which also returns the saved reply.",
        "pending_holds stays unpartitioned for the same reason: its key on hold_id is a real guard. An archive job moves holds ended over 90 days ago to a month-partitioned history. The cost is about 86 million deletes a day for vacuum at the stress load.",
      ],
    },
    {
      q: "When do you move to TigerBeetle, how, and what do you give up?",
      a: [
        "When hot-row lock waits dominate after splitting and adding clusters, or one customer is busier than one row can take.",
        "As I understand it, a transfer has one debit and one credit, so a three-entry payment becomes linked transfers, and each currency is its own ledger. There is no credit_limit column; limits become balance flags and funding transfers. A request takes up to 8,189 transfers.",
        "The triggers, guard and CHECK disappear, so those rules move into the Ledger API. And I lose the shared transaction with Postgres: metadata first, the transfer last, shadow-post, then cut over by cohort.",
      ],
    },
    {
      q: "There is a ledger today. How do you move to this one without losing a penny?",
      a: [
        "Shadow first: every old transaction is also posted to the new ledger, with ids derived from the old ones, and balances compared per account and currency.",
        "Accounts open at zero, then take one opening transaction; ACTIVE holds come across with their original ids. Cut over by cohort through a flag, system accounts last, after weeks of zero unexplained breaks across a month end. Keep the old ledger as reverse shadow, so rollback is a flag.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Phase 1 core, in shadow (one quarter)",
        ships: "One Postgres cluster: a primary, two synchronous standbys in other zones, a read replica, PgBouncer in transaction mode, timeouts on the database roles. The header table, the journal, pending_holds and accounts with their triggers, guard, CHECK, status and column grants; the zero-sum check at commit; account-first locking everywhere; idempotency keys with a request hash; the outbox with CDC on a failover slot; the hold expiry and archive jobs; month partitions on the journal; system accounts split 16 ways. GBP bank payments and payroll first, fed by shadow-posting from the existing ledger.",
        why: "Retires the risk that matters most, that the model or the concurrency is wrong, while being wrong costs nothing. One cluster carries the realistic 100 to 250 payments a second many times over, and the stress average of 2,000 write transactions a second, so there is no routing work yet.",
      },
      {
        name: "2. Reconciliation, end of day, cards and currencies",
        ships: "Nostro accounts and daily matching against bank statements and scheme settlement reports; clearing accounts back to zero; account_balances_daily and the Single Customer View file; a break queue and correcting transactions with second-person approval. Then card authorisation records with incremental holds, partial clearing, force-posts to the hard floor and customer receivables, and chargebacks. USD and EUR wallets and FX pools for conversions. Then overdrafts and credit cards, with billing accruing interest daily and charging at statement.",
        why: "Nothing cuts over until we can prove it is right, and a bank needs the same machinery every business day afterwards. Cards, FX and credit come after because they add the hard cases: postings the bank must accept, two currencies, and limits that move.",
      },
      {
        name: "3. Cut over, account by account",
        ships: "A ledger-of-record flag per business. Cohorts: staff, quiet accounts, then the rest, system accounts last. The old ledger runs as reverse shadow, then is retired after a month end closes cleanly, with its history exported to the archive.",
        why: "Each cohort limits a mistake to a few accounts, and each step is reversible by a flag. Retiring the old ledger is a deliverable: two ledgers are a standing source of breaks.",
      },
      {
        name: "4. Phase 2: more clusters, when measured",
        ships: "Tune the one cluster towards the estimated 5,000 to 8,000 write transactions a second, proved by a load test. Then ledger clusters split by business, each with its own 16-way system accounts, behind a routing directory. Payments between clusters are two local transactions joined by INTERCLUSTER_OUT and INTERCLUSTER_IN, driven by the outbox. At the stress peak of 20,000 write transactions a second, about four clusters.",
        why: "Each cluster adds operational cost forever, so it waits for evidence. It reuses the same tables and triggers; the new work is routing, the cross-cluster pair and its reconciliation.",
      },
      {
        name: "5. Phase 3: TigerBeetle for the hot path, if needed",
        ships: "Balances and holds move to TigerBeetle behind the same ledger API: multi-leg postings as linked transfers, holds as pending transfers, limits as balance flags. The rules the triggers and CHECK enforced move into the Ledger API. Postgres keeps metadata, KYC, billing, search and reporting, fed by change data capture.",
        why: "Only when hot-row lock waits dominate after phase 2. It gives up the shared transaction with Postgres and the database-enforced rules, so it is a planned migration with shadow-posting, not a tuning step.",
      },
    ],

    migration: [
      "Map first. Write down how every account and transaction type in the old ledger maps to the new chart of accounts, per currency, with GL codes, and get finance to sign it off. Most migration breaks are mapping errors, not code.",
      "Opening balances, not full history. Accounts open at zero; for each account and currency, post one opening transaction at a cut-off against a migration account. History before the cut-off stays readable from the old system and then the archive.",
      "Shadow-post. Every committed transaction in the old ledger is replayed into the new one, with transaction ids derived from the old ids, so a replay is refused by the header. Old authorisations become holds with ids derived from the originals. A rejection in the new ledger is a break, never silent.",
      "Compare continuously. Per account: posted and held, every few minutes. Per day: totals per system account and per currency. Exit criterion: zero unexplained breaks for several weeks spanning a month end and a payroll peak.",
      "Cut over by cohort with a flag. Carry ACTIVE holds across with their original ids, so the capture, void or expiry lands in the new ledger. The freeze per account is seconds, not a maintenance window.",
      "Reverse the shadow. Once an account is on the new ledger, its transactions are replayed into the old one, so rollback is flipping the flag. Keep this until a month end has closed cleanly.",
      "Keep external reconciliation running across both ledgers. During the mixed period system accounts exist in both, so finance sums both for the nostro match, and the Single Customer View file is built from both.",
      "Avoid month end, quarter end and large payroll dates for any cohort move. Brief finance, risk and the auditors first; ask compliance whether the regulator needs telling, as a material change to a critical system.",
    ],

    slos: [
      {
        name: "Unexplained breaks",
        target: "Target: zero open breaks older than one business day; zero internal invariant violations.",
        why: "This is what 'correct' means. One business day matches the daily reconciliation, so a break is understood before the next one is due.",
      },
      {
        name: "Time to detect a break",
        target: "Target: internal violations detected within 5 minutes; external breaks within one business day of the statement arriving.",
        why: "The incremental check runs every few minutes over accounts touched since its watermark; a weekly full re-sum catches what it misses. External truth arrives daily, so that is the floor there.",
      },
      {
        name: "Durability",
        target: "Target: zero acknowledged transactions lost through any single failure; a cluster writing again within 1 minute of losing its primary.",
        why: "Recovery point zero is the reason for synchronous standbys, and it holds for one failure at a time. A minute is a scripted fence and promote; clients retry safely with their keys meanwhile.",
      },
      {
        name: "Write latency",
        target: "Target: a hold or a capture under 50 ms at the 99th percentile, measured inside the ledger.",
        why: "A card authorisation has about 2 seconds end to end, shared with the network, fraud and the processor. 50 ms leaves room and still allows a cross-zone synchronous commit.",
      },
      {
        name: "Write availability",
        target: "Target: 99.95 per cent of minutes per cluster accepting writes, about 22 minutes a month.",
        why: "Faster Payments and cards run all day every day. Not higher, because with both standbys gone commits wait, and we fence and promote rather than risk losing payments.",
      },
      {
        name: "Holds end on time",
        target: "Target: no ACTIVE hold more than 5 minutes past its expires_at.",
        why: "A hold that outlives its expiry keeps the customer's money unavailable for nothing. The expiry job takes one account per transaction, account first, through a partial index of ACTIVE holds, and an alert watches the oldest overdue hold.",
      },
      {
        name: "Event freshness",
        target: "Target: outbox to topic within 5 seconds at the 99th percentile.",
        why: "Notifications and fraud read the topic. The relay waits for the standbys, so a rise here is also an early warning of replication trouble or a slot filling the primary's disk.",
      },
    ],

    oncall: [
      "Pages at 3am: any invariant violation (a currency not summing to zero, posted not equal to the entries, held not equal to the ACTIVE holds, a nostro not matching its statement). Money correctness outranks everything.",
      "Pages at 3am: a cluster not accepting writes or down to no synchronous standby; replication slot or WAL disk heading for full; the oldest xmin ageing; lock timeouts rising on one row; card authorisation latency SLO burning fast.",
      "Pages at 3am: bank payments in 'unknown' ageing past a threshold, cross-cluster transfers in flight too long, or the hold expiry job stopped, because customers' money is held with no outcome.",
      "Waits for the morning: a single small external break; the end-of-day sweep failing (system rows untidy, not wrong); a new customer receivable (collections' queue); the hold archive job behind; an FX pool near but inside its limit; the daily interest accrual failing (billing reruns it, and the header's id stops a double post).",
      "First runbook: losing both synchronous standbys. Never cancel a backend waiting for a standby: it would report success for a commit no standby has. Fence the old primary, then promote; check the failover slot exists on the new primary; tell the payments team.",
      "Second runbook: invariant violation. Freeze the accounts, turn off the code path, rebuild posted and held from the daily snapshot, later entries and ACTIVE holds in a reviewed, audited break-glass change, then post reversing transactions for wrong entries. Break-glass also disables the append-only triggers, so two people.",
      "Third runbook: CDC relay, Kafka or SQS down. The ledger carries on; watch the slot, know how to recreate it safely, and how consumers replay, deduping on the outbox seq.",
    ],

    teams: [
      { name: "Ledger core", owns: "The ledger API, schema and triggers, holds and their expiry and archive, clusters and routing, the cross-cluster pair, idempotency, the outbox and CDC relay, invariant checks, end of day. The only team with write access to ledger databases." },
      { name: "Payments and cards", owns: "Payment orchestration and state machines, scheme connections (Faster Payments, Bacs, card networks), card authorisation records, incremental and partial clearing, chargebacks, stand-in rules, status enquiries for unknown outcomes. Posts to the ledger through its API as a client." },
      { name: "Credit and billing", owns: "Credit limits, status and their changes, statement cut-offs, grace periods, balance segments by rate and the repayment order for regulated cards, daily interest accrual and the statement charge. Posts as ordinary transactions with ids derived from the account and date, and reconciles its totals to each card's posted balance." },
      { name: "Reconciliation and financial control", owns: "Nostro and settlement matching, clearing accounts back to zero, the break queue and corrections, the Single Customer View file, the daily feed to the general ledger, FX pool positions with treasury, migration comparisons." },
      { name: "Platform (shared)", owns: "Postgres operations, backups and failover tooling with fencing, Kafka and SQS, object storage. The boundary that matters most: money moves only through the ledger API, and the ledger knows accounts and currencies, not products." },
    ],

    buildBuy: [
      { part: "Posting engine and ledger API", call: "Build on Postgres", why: "Small, critical, and the rules are ours. Hosted ledgers such as Modern Treasury Ledgers put an outside API on every payment; Formance is an open-source alternative worth a look; core banking platforms such as Thought Machine Vault make sense only as part of a wider core replacement." },
      { part: "Database operations", call: "Buy managed Postgres if it meets recovery point zero, else run Patroni", why: "The team should spend its time on the ledger, not failover scripts. The test: can the managed failover lose an acknowledged commit, does it fence the old primary, and do we keep the settings we need, including failover slots." },
      { part: "Change data capture", call: "Buy (open source): Debezium on Kafka Connect", why: "Log-based CDC with ordering is hard to get right. We own its configuration, the failover slot and the slot monitoring." },
      { part: "Queues and event log", call: "Buy: managed Kafka, or SQS for work queues", why: "Three events per payment: about 3,000 a second and 3 MB a second at the stress average, 30 MB at peak. That is a light load. Nothing about it is ours to differentiate on." },
      { part: "Reconciliation", call: "Build the ledger-side matching; consider a vendor for finance-ops matching", why: "Invariant checks and nostro matching depend on our model. Wider matching across finance may already have an owner and a product." },
      { part: "Payment workflow", call: "Build a small state machine first", why: "A workflow engine such as Temporal is another system on the money path. Adopt it if rails and states outgrow hand-written recovery workers." },
      { part: "Hot-path engine", call: "Do not build. TigerBeetle in phase 3, if measured need", why: "16-way system accounts and about four clusters carry the stress peak. TigerBeetle is the named exit if hot-row contention dominates; the ledger API keeps that door open, and our rules move into it." },
    ],

    cost: [
      "Machines: a cluster is a primary, two synchronous standbys and a read replica, four nodes. Assumption: £2,000 to £4,000 a month per node with fast storage. Phase 1 is one cluster, £8,000 to £16,000 a month. Four clusters at the stress peak, 16 nodes, is £32,000 to £64,000 a month.",
      "Storage at the stress load: 260 million entries a day at an assumed 250 bytes is 65 GB; 86 million holds at 150 bytes is 13 GB; 86 million headers at about 100 bytes is about 9 GB; about 87 GB a day. Hot in year 1: 26 TB of entries for 13 months, 1.2 TB of holds for 90 days, 3.1 TB of headers; about 30 TB, about 8 TB a cluster across four, times four copies. Headers are never deleted, so each cluster grows about 0.8 TB a year (0.3 to 0.8 TB a year in all at the baseline). Idempotency keys, 72 hours: about 100 GB. The accounts table is under 300 MB.",
      "Vacuum: the archive job deletes about 86 million ended holds a day at the stress load. That is the price of keeping hold_id a real key.",
      "Events: hold placed, hold ended and transaction posted, three per payment: about 3,000 a second. At an assumed 1 KB each, 3 MB a second on average, 30 MB at peak: small.",
      "Synchronous replication is the line item that buys recovery point zero. Two standbys rather than one doubles the standby bill, and is the right trade.",
      "Headcount is the bigger cost. Ledger core: five or six engineers. Reconciliation: three or four alongside finance operations. Payments and cards exist already. A share of a platform team for Postgres.",
      "The cost of being wrong dominates both: a nostro shortfall nobody can explain, a wrong Single Customer View file or a double-posted payroll run costs more in remediation and regulatory attention than a year of machines.",
    ],

    risks: [
      { risk: "A mapping or model error found after cut-over: right in aggregate, wrong per account.", answer: "Shadow-post for weeks with per-account, per-currency comparison; cut over by cohort; keep reverse shadow. Finance signs off the chart of accounts before code is written." },
      { risk: "A code path skips the soft check and overspends up to the hard floor.", answer: "One path for customer debits, in the Ledger API, with the conditional insert. A test for each product. An alert on any account between credit_limit and hard_limit that no bank-initiated posting explains." },
      { risk: "One very busy customer whose wallet takes more writes than one row can.", answer: "Lock wait per account on a dashboard, with an alert. A wallet cannot be split, so: its own cluster, batching its outgoing payments, and in the end the TigerBeetle phase." },
      { risk: "Holds leak: authorisations never captured or voided keep customers' money unavailable.", answer: "Every hold has expires_at; the expiry job sets EXPIRED, account first; an SLO on holds past expiry; a late settlement still posts, as a no-hold settlement." },
      { risk: "pending_holds gains about 86 million rows a day and is not partitioned.", answer: "The archive job moves holds ended over 90 days ago to a month-partitioned history and deletes them; only the archive role may delete, and the trigger refuses an ACTIVE hold. Partition-and-drop lost because its key would include created_at, and ON CONFLICT (hold_id) stops working." },
      { risk: "A long transaction on the primary stops pruning, so HOT updates stop and hot rows bloat.", answer: "No long transactions on the primary, idle_in_transaction_session_timeout, and an alert on the oldest xmin. Reports run on the replica." },
      { risk: "Both standbys lost, and someone cancels the waiting commits to clear the queue.", answer: "The runbook forbids it: a cancel reports success for an unreplicated commit. Fence, then promote. Drill it each quarter." },
      { risk: "Rules in triggers are hidden from application developers.", answer: "Treat SQL as code: in the repository, reviewed, a test for each refusal. Property tests that assert the invariants under concurrency, and a load test at the stress peak." },
      { risk: "Regulatory: a wrong Single Customer View file, or daily reconciliation missed during the migration.", answer: "Reconciliation and the snapshot ship before any cut-over and run across both ledgers. Finance, risk and the auditors are briefed before the first cohort." },
      { risk: "Key-person risk: few people understand Postgres locking and the ledger model.", answer: "Pairing on the posting path, written design records, failover and invariant drills run by different people each quarter." },
    ],
  },

  rehearsal: [
    {
      stage: "Clarify and scope",
      minutes: 5,
      prompt: "Restate the problem in your own words. Ask the questions that change the design, then state your assumptions and the hard problem out loud.",
      cover: [
        "Whose money: an authorised bank, so deposits, FSCS and the Single Customer View file. An e-money firm would safeguard under CASS 15.",
        "Products: bank payments, payroll, debit and credit cards, overdrafts, accounts in several currencies.",
        "Strict consistency: no customer spend past its limit, money conserved per currency, a read sees the write.",
        "Load: 1,000 payments a second is a stress case; a realistic baseline is 100 to 250. Which accounts are in most transactions.",
        "Names the hard problem: one hot row, not total throughput.",
      ],
    },
    {
      stage: "Data model and invariants",
      minutes: 7,
      prompt: "Before any boxes, describe the four tables, the triggers and the rules that must always hold. Say what is the truth and what is a cache.",
      cover: [
        "ledger_transactions: one header per transaction, id made by the caller; primary key and UNIQUE (kind, external_ref) are the lasting duplicate guard.",
        "ledger_entries: settled only, append-only, signed minor units (credit positive), sums to zero per currency, checked once at commit.",
        "pending_holds: ACTIVE, then CAPTURED, VOIDED or EXPIRED, once; deleted only by the archive job, once ended.",
        "accounts: posted and held kept by triggers; guard trigger; open at zero; status OPEN, NO_NEW_SPEND or CLOSED.",
        "Soft credit_limit tested when a customer starts a spend; CHECK posted - held >= -hard_limit unless allow_negative; past it, the customer's receivable.",
        "Statements, interest and the repayment order live in billing. One currency per account.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 4,
      prompt: "Do the sums that decide the architecture. Say which number matters most and why.",
      cover: [
        "Stress: 86.4 million payments a day. A bank payment: one hold insert, one hold update, one ledger transaction of three entries; a dollar card payment is three too.",
        "Two write transactions per payment: 2,000 a second average, 20,000 peak. Baseline 100 to 250 payments a second.",
        "About 87 GB a day (65 GB entries, 13 GB holds, about 9 GB headers); about 30 TB in year 1, 8 TB a cluster, headers adding 0.8 TB a cluster a year.",
        "One hot row: 500 to 1,000 writes a second. This is the number that matters.",
        "One cluster covers the average, four at peak; 2,500 ÷ 16 = about 156 writes a second per system row.",
      ],
    },
    {
      stage: "Write path",
      minutes: 8,
      prompt: "Walk Bright Bakery's £1,200.00 Faster Payment with a 20p fee, then its USD 100.00 debit card payment and a £649.00 credit card purchase. Say what each transaction writes and the balances after.",
      cover: [
        "Hold ...0417 of 120020 under key k7: posted 842000, held 120020, available 721980. Outbox row in the same commit.",
        "Capture, transaction ...900418, FPS_OUT, 'INV 3318', value date 2026-11-12: wallet -120020, FPS_CLEARING_GBP +120000, FEE_REVENUE_GBP +20.",
        "Scheme settles: FPS_CLEARING_GBP -120000, NOSTRO_BOE_GBP +120000. Rejected: void, no entries. Timeout: unknown, enquire.",
        "Card: billing amount 8000 in GBP, hold 8240; clears at 7900: wallet -7979, MASTERCARD_DEBIT_CLEARING_GBP +7900, FX_FEE_REVENUE_GBP +79; 261 freed. Conversion E: four entries through the FX pools.",
        "Credit card 500000 / 550000: capture 64900 leaves -64900; repayment 30000 leaves -34900, available 465100; interest 32 accrues between system accounts.",
        "Force-post ...900521: 9000 against a live hold of 8240, hold CAPTURED, wallet -9000. Force-post ...900701: card -501450 takes 48550 to -550000, receivable -11450; repayment ...900702 clears it.",
      ],
    },
    {
      stage: "Concurrency and hot accounts",
      minutes: 7,
      prompt: "Go deep on two payments racing for one wallet, and on the account every payment touches. Compare the options before you pick.",
      cover: [
        "Every path locks account rows first, in id order, FOR NO KEY UPDATE, then touches holds; the second waits, then places nothing.",
        "Why lock when the CHECK exists: the CHECK guards the hard floor, not the soft limit; clean decline, saved on the key.",
        "A hold leaves ACTIVE once; capture racing void tested 200 rounds, no deadlock.",
        "Timeouts on the role, not SET LOCAL statement_timeout; the commit wait needs the client deadline.",
        "System accounts 16 rows, hash of transaction id; HOT needs pruning, so watch the oldest xmin.",
      ],
    },
    {
      stage: "Failure, partitions and scale",
      minutes: 6,
      prompt: "Break it. Walk through the failures an interviewer will pick and what the customer sees. Then the scale path.",
      cover: [
        "Primary dies: fence, promote the synchronous standby, nothing lost for one failure; clients retry with keys.",
        "Both standbys gone: commits wait holding locks; never cancel them; fence, then promote.",
        "Outbox on a failover slot, waiting for standbys; no two-phase commit. Cross-cluster: OUT and IN, same id.",
        "Partitioned journal: its unique key guards nothing; the header table and idempotency_keys do. Holds stay unpartitioned.",
        "Phases: one cluster; clusters by business; TigerBeetle, rules move to the API.",
      ],
    },
    {
      stage: "Proving it is right",
      minutes: 3,
      prompt: "Explain how you would know, every day, that the ledger is correct, and what happens when it is not.",
      cover: [
        "Incremental check every few minutes: account_balances_daily plus entries after last_entry_id; full re-sum weekly on a replica.",
        "Nostro against the statement; each clearing account back to zero after its cycle (the break: FPS_CLEARING_GBP left at -500 while the nostro matches); FX pools against treasury.",
        "End of day is a date: value_date, account_balances_daily, the Single Customer View file.",
        "A mismatch pages; rebuild only in a reviewed break-glass change. Correctness as an SLO.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 5,
      prompt: "Step back from the diagram. Tell them how you would deliver it from where the company is today, and how you would run it.",
      cover: [
        "Phase 1 in shadow in a quarter; reconciliation and end of day, then cards, currencies and credit, before cut-over.",
        "Opening balances as transactions; cohort cut-over with reverse shadow.",
        "Phase 2 clusters and phase 3 TigerBeetle only when measured.",
        "One team owns the ledger; product teams post through the API only.",
        "What pages at 3am, the first runbooks (never cancel a waiting commit), the main risks.",
      ],
    },
  ],
};
