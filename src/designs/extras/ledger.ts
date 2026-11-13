import type { Extras } from './types';

/**
 * Interview extras for the ledger service.
 *
 * The question: "Design a central multi-currency ledger for a business bank: bank payments,
 * payroll, debit and credit card authorisations and settlements, and accounts in several
 * currencies. Balances must be strictly consistent under high-frequency writes."
 *
 * The design (owner's fifth spec, brief /tmp/alts/ledger5-brief.md, with the expert review's
 * fixes in /tmp/alts/ledger4-fixes.md still standing): we are an authorised bank. Three services,
 * each with its own database, no two-phase commit. Core Ledger owns accounts, pending_holds,
 * transactions (headers), ledger_entries and outbox_events. Card service owns
 * card_authorisations and the ISO 8583 lifecycle. Billing owns credit_balance_buckets,
 * credit_statements, nightly micro-interest and the waterfall; the ledger sees one
 * INTEREST_CHARGE at statement time. The Banking API keeps bank payments and payroll and calls
 * the ledger like the Card service does. Guards: UNIQUE (source_type, source_id) on holds and
 * UNIQUE (idempotency_key) on transactions; no idempotency_keys table; saved replies and declines
 * live on the caller's own record. The header's one allowed change: POSTED to REVERSED, made by
 * the trigger on inserting a REVERSAL. Authorisation: PlaceHold(idempotency_key = auth_id),
 * synchronous, 50 to 100 ms (the owner's target). Settlement and expiry: outbox and Kafka
 * (SettleCardTransaction, TransactionPosted, HoldExpired). Nightly parity job.
 * Unchanged from the review: append-only entries summing to zero per currency at commit; caches
 * by trigger; credit_limit soft, hard_limit the CHECK's floor, then the customer's receivable;
 * status OPEN, NO_NEW_SPEND or CLOSED; account-first locks in id order; role timeouts 50 ms and
 * 250 ms plus a client deadline; system accounts split 16 ways; holds unpartitioned and
 * archived after 90 days; only ledger_entries is month-partitioned.
 *
 * Figures at the stress load (1,000 payments a second average, 10,000 peak): 86.4 million
 * payments a day; about 260 million entries, 86 million holds and 86 million header rows a day.
 * Storage (agrees with src/designs/ledger.ts): 65 GB entries (250 bytes) + 17 GB headers (about
 * 200 bytes) + 13 GB holds (150 bytes) = about 95 GB a day. Headers 6.3 TB a year at the stress
 * load, 0.6 to 1.6 TB at the baseline. Hot data about 34 TB in year 1, 8.4 TB a cluster across
 * four, then about 1.6 TB more a cluster each year. No idempotency key storage any more. Events:
 * 2 per bank payment (HoldPlaced, TransactionPosted): 2,000 a second (2 MB/s) average, 20,000
 * (20 MB/s) peak. Two write transactions per payment: 2,000 a second average, 20,000 peak;
 * 2,500 / 16 = about 156 writes a second per split system row. Baseline 100 to 250 a second.
 * Keys as on the page: fps:out:pay_3fK9, settle:<auth_id>, interest:<card>:2026-12-31, repay:k9,
 * sweep:<account>:<date>, break:brk_1127. Bank payment id e1f0c3a2-...3318 (public pay_3fK9).
 * Interest: illustrative 18% APR, 32,005,479 micros a day; statement charge 812p, -34900 to
 * -35712.
 * Canonical examples: Bright Bakery, GBP wallet ...081442, posted 842000; credit card ...081444,
 * credit_limit 500000, hard_limit 550000. Credit card story: auth a17c0de5-...0610, hold
 * b61c9a3e-...0610 of 64900, settlement 7d1f0a52-...900611: card -64900,
 * MASTERCARD_CREDIT_CLEARING_GBP shard 7 +64900; repayment 30000 leaves -34900, available 465100.
 */
export const extras: Extras = {
  opening: [
    "This is the central ledger for a business bank: bank payments, payroll, debit and credit cards, and accounts in several currencies. Its job: say what each customer has, prove where every penny came from, and never let a customer start a spend past their limit.",
    "My main assumption: we are an authorised bank, so balances are deposits protected by FSCS, and the ledger must produce the Single Customer View file on demand. Load: about a million businesses, 1,000 payments a second as a stress case, 10,000 at peak. Amounts are whole pence and cents, in BIGINT.",
    "I'd build three services, each with its own database. The Core Ledger owns accounts, holds, transactions, entries and outbox events. It reserves funds, enforces balances and keeps the books at zero, and knows nothing about cards. The Card service owns card authorisations and the network's message lifecycle. Billing owns the credit card buckets, statements, interest and the repayment waterfall. The payments service calls the ledger the same way the Card service does.",
    "Inside the ledger, the journal is the truth. ledger_entries holds settled movements only, append-only, and each transaction sums to zero in each currency, checked at commit. Each has one header in transactions, whose unique idempotency key stops a double post. Money promised but not yet moved is a hold: ACTIVE, then CAPTURED, VOIDED or EXPIRED, once.",
    "accounts keeps two caches, posted and held, each moved only by a trigger. A soft credit limit is tested when the customer starts a spend. A hard floor, enforced by a CHECK, lets the bank's own postings, like interest and late settlements, still land. Every write locks the account rows first, in id order, then touches holds.",
    "The services stay in step without two-phase commit. A card authorisation calls PlaceHold synchronously, keyed by the auth id: lock, check, hold and a HoldPlaced event in one local transaction, inside a 50 to 100 ms budget. Settlement and expiry are asynchronous, through outboxes and Kafka. A nightly parity job checks the services still agree.",
    "It grows in three phases: one Postgres cluster; clusters split by business; then TigerBeetle for the hot path. I'll do the services and data model, one card purchase end to end, then concurrency, failure and delivery.",
  ],

  pushes: [
    // Licence and scope
    {
      q: "Are you a bank or an e-money firm, and what changes?",
      a: [
        "I've assumed a bank. Balances are deposits on our balance sheet, protected by FSCS, and the ledger must produce the Single Customer View file, each depositor's eligible total, on demand.",
        "As an e-money firm, the same wallets would be safeguarded funds under CASS 15, reconciled every business day against the safeguarding accounts. Credit would be funded from the firm's own money, never customers'.",
      ],
    },
    {
      q: "Is 1,000 payments a second realistic?",
      a: [
        "Not as an average: it is 86 payments per business per day. Pay.UK reports about 5.5 billion Faster Payments for the whole UK in 2025, about 15 million a day.",
        "A reasoned baseline is 10 to 20 payments per business a day: roughly 100 to 250 a second. One cluster carries that for a long time. The stress figures size the later phases.",
      ],
    },
    // Service boundaries
    {
      q: "Why three services and not one?",
      a: [
        "They change at different speeds and fail differently. The ledger is small, critical and rarely changes. Cards churn with network rules and must answer in milliseconds. Billing is nightly batch and regulation.",
        "Each owns its data, so a billing bug or a slow card change cannot lock a balance. The ledger knows accounts and currencies, not products.",
        "The cost is no shared transaction: outboxes, idempotent consumers and a parity job. With a small team I'd ship one deployable first, but keep the three schemas apart from day one.",
      ],
    },
    {
      q: "Why does Billing consume events and not share the ledger's database?",
      a: [
        "Nightly runs touch every card; on the ledger's primary they would compete with authorisations.",
        "Billing builds its buckets from TransactionPosted, deduping on the event id, and can replay from Kafka to rebuild them. It writes back only through the ledger API: one INTEREST_CHARGE per statement.",
        "The cost is seconds of lag, so billing cuts a statement only after consuming past the cut-off, and checks its buckets against the card's posted balance.",
      ],
    },
    {
      q: "The authorisation is synchronous. What if the ledger is slow or down?",
      a: [
        "Timeouts sit on the database role, 50 ms for a lock and 250 ms for a statement, so they hold behind PgBouncer. The Card service keeps its own deadline inside the network's budget.",
        "Past the deadline, it answers the network with a decline or its stand-in rules, never a hang. If the hold was in fact placed, a VoidHold keyed by the auth id ends it.",
        "A stand-in approval settles later as a posting the bank must accept. So the ledger's availability is the card's availability, and that is why it gets synchronous standbys and the tightest SLO.",
      ],
    },
    {
      q: "The Card service crashes after PlaceHold succeeds but before it records APPROVED. What now?",
      a: [
        "The row is stuck at INITIATED and the network has had no answer, so it has declined or stood in.",
        "A sweeper picks up INITIATED rows older than a few seconds and calls PlaceHold again with the same auth id. The unique key on (source_type, source_id) places nothing new and returns the existing hold.",
        "The network never heard our approval, so void the hold and record DECLINED. A stand-in approval clears later as a force-post. Anything missed, expiry frees and parity reports.",
      ],
    },
    {
      q: "How do you know the Card service and the ledger agree?",
      a: [
        "A nightly parity job on the two replicas. They are separate databases, so it exports keys from each and compares: every APPROVED authorisation has one ACTIVE hold, and every CLEARED authorisation has one POSTED transaction, where hold_id = reference_id.",
        "Both directions matter. An ACTIVE hold with no APPROVED authorisation holds the customer's money for nothing. An APPROVED or CLEARED authorisation with nothing in the ledger means we may have promised money we never reserved or moved.",
        "Breaks are aged before they are raised: a hold expired an hour ago whose HoldExpired is still in flight is normal. Cards fixes each break by replaying the event or voiding the hold, never by editing a row.",
      ],
    },
    // Money model
    {
      q: "One table for debit wallets, overdrafts and credit cards. How?",
      a: [
        "Two limits. credit_limit is the soft limit: a customer's hold goes in only if the account is OPEN and posted minus held minus the amount stays at or above minus credit_limit. hard_limit is the floor a CHECK enforces, never above credit_limit.",
        "A debit wallet is 0 and 0. The bakery's card is 500,000 and 550,000. Signs never change: a £649.00 purchase is a hold of 64,900, leaving 435,100 available; the settlement posts card -64,900, MASTERCARD_CREDIT_CLEARING_GBP +64,900.",
        "The honest cost: the backstop is the hard floor, not the exact limit. A code path that skipped the soft check could overspend that card by up to £500.00.",
      ],
    },
    {
      q: "Why a separate holds table and two cached balances? Why not entries, or one balance?",
      a: [
        "A hold changes and the journal must not. As entries, every voided authorisation would leave two entries for money that never moved.",
        "Posted is money that has moved. Available is posted minus held plus credit_limit. One balance mixes promises with facts, and the cache lets the funds check lock one row, not sum years of entries.",
      ],
    },
    {
      q: "Why triggers? And can nobody really edit a balance?",
      a: [
        "Triggers because nobody can forget them. Any path that writes an entry or a hold moves the balance in the same transaction, with one UPDATE on a row already locked.",
        "No INSERT, UPDATE or application role can set a balance. Accounts open at zero, a guard refuses direct edits, and DELETE and TRUNCATE are revoked or refused.",
        "But the owner or a superuser can disable triggers, so DDL is reviewed and logged, and break-glass needs a second person.",
      ],
    },
    {
      q: "Your header has a status column but is immutable. How do you reverse an entry, even one the customer has spent?",
      a: [
        "With a new transaction, never an edit: type REVERSAL, opposite amounts, reference_id pointing at the original. Inserting it fires a trigger that flips the original from POSTED to REVERSED. That is the header's one allowed change.",
        "A direct status change is refused, and so is reversing twice. Then post the right one. Corrections need a second approver.",
        "If the customer has spent the money, the reversal is a posting the bank must accept: it can go past the soft limit to the hard floor, and the rest to that customer's own receivable.",
      ],
    },
    {
      q: "Walk me through your end of day.",
      a: [
        "End of day is a date, not a stop. The cut-off calendar is Europe/London, and payments keep flowing across it. The header has no value date: that lives with the service that owns the payment.",
        "After the cut-off a job writes account_balances_daily: account, business date, posted, held. Statements, the Single Customer View and reconciliation read that one snapshot.",
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
        "FX pools are for converting between the bakery's own wallets: four entries, two currencies, each summing to zero on its own.",
      ],
    },
    {
      q: "The settlement is larger than the hold, or a card at its limit must take interest or a returned Direct Debit. What do you write?",
      a: [
        "These are postings the bank must accept, so the soft limit is not tested. The posting ends any live hold for that authorisation in the same transaction, and may take the account past credit_limit, down to hard_limit.",
        "Past the hard floor, the account goes to its floor and the rest is debited to that customer's own receivable, never a pooled account. One balanced transaction; the CHECK never gives way.",
        "A card at -501,450 that must take 60,000 goes to -550,000 and its receivable to -11,450. A late settlement on an EXPIRED hold releases nothing, and the authorisation moves EXPIRED to CLEARED.",
      ],
    },
    {
      q: "The hold's unique key is (source_type, source_id). How do you do an incremental authorisation, say a hotel that pre-authorises £300, adds £150, then clears £420 in two presentments?",
      a: [
        "One hold per source row. So the £150 increment is a new card_authorisations row with the same network_lifecycle_id and its own hold: 30,000 and 15,000.",
        "A partial capture ends the hold and places a new one for the remainder, under a new source row. The first presentment, £200, captures the 30,000 hold, posts -20,000 and holds 10,000. 25,000 is still held.",
        "The second, £220, captures both remaining holds and posts -22,000. 3,000 is freed. The Card service sums the rows by lifecycle id to show £420 cleared.",
      ],
    },
    {
      q: "Mastercard re-sends last week's clearing file. What stops the double post?",
      a: [
        "First the Card service: those authorisations are already CLEARED, so it emits nothing. If a SettleCardTransaction still arrives twice, the header's key is settle: plus the auth id, and UNIQUE (idempotency_key) refuses it. Tested: same key, new transaction id, nothing posted.",
        "Headers are never deleted, so that guard lasts for good.",
      ],
    },
    {
      q: "A customer disputes a £2,000 card payment.",
      a: [
        "The original payment stays. A provisional credit is a new transaction: wallet +200,000 from a chargeback suspense account, its reference_id pointing at the original.",
        "The scheme's outcome then posts or reverses it. If we lose and the customer has spent the money, the reversal goes down to the hard floor and the rest to their receivable. A merchant refund is simpler: a credit posting, no hold.",
      ],
    },
    {
      q: "You cut a card's limit below what it has already used. What happens?",
      a: [
        "The update is allowed, because the CHECK tests the hard floor, not credit_limit. New holds then place nothing.",
        "To stop spend outright, set status to NO_NEW_SPEND. A hold needs OPEN, but repayments, refunds, interest and already-approved settlements still post. Only CLOSED refuses entries, and only an empty account can close.",
        "Only the credit team's role may change credit_limit, hard_limit, allow_negative and status.",
      ],
    },
    {
      q: "Where do interest and the repayment waterfall live, and how does a repayment restore credit?",
      a: [
        "In Billing. It accrues micro-interest nightly on each bucket in its own tables. The ledger sees nothing until statement day, then one INTEREST_CHARGE keyed interest:<card>:<date>. At an illustrative 18%, 812p: card -34,900 to -35,712, INTEREST_INCOME_GBP +812. Paid in full in the grace period, no charge.",
        "A repayment is one ledger posting. The bakery's card is at -64,900; 30,000 from the wallet leaves -34,900, and available credit is 465,100 the moment it commits. If there is a receivable, the ledger API clears that first.",
        "Billing then allocates it: fees, then interest, then the highest-APR principal. As I understand it, CONC 6.7.4R is why principal goes highest rate first on regulated cards; sole traders and small partnerships are in scope, a limited company's card mostly not.",
        "Credit returns at once only when the money is final; a collected Direct Debit can come back.",
      ],
    },
    // Concurrency
    {
      q: "Two payments from the same account arrive in the same millisecond, and together they exceed what is available. Prove only one succeeds. Why lock, if a CHECK guards the balance?",
      a: [
        "Each locks the account row first. The second waits, then its conditional insert sees the first hold and places nothing. The ledger answers declined and keeps no record of it; the caller saves the decline on its own row.",
        "If the caller retries, the ledger evaluates it again. That is safe: it only retries when it never got the first answer, and it records whichever answer it does get.",
        "The CHECK guards the hard floor, not the soft limit, so only the lock and the conditional insert stop this overspend, with a clean decline. I'd prove it with thousands of concurrent holds on one account, then assert none past the limit.",
      ],
    },
    {
      q: "How do you know one hold can never be both captured and voided?",
      a: [
        "The hold's trigger allows one change, ACTIVE to CAPTURED, VOIDED or EXPIRED, and nothing after. Capture and void each update the hold only where it is ACTIVE, so the second finds nothing to do.",
        "Both find it the same way, by source_type and source_id, and both lock the account rows first, in id order, then touch the hold. A void that locked the hold first deadlocked against a capture in review.",
        "Tested on PostgreSQL 16 with real sessions: 200 rounds of capture racing void, no errors, 128 captured, 72 voided, balances exact.",
      ],
    },
    {
      q: "Every bank payment credits FPS clearing and fee revenue. At peak, what happens to those rows, and what protects them?",
      a: [
        "One row holds its lock 1 to 2 ms, so it takes roughly 500 to 1,000 writes a second. So each hot system account is 16 rows, picked by hash of the transaction id: at 2,500 payments a second per cluster, about 156 writes a second each.",
        "Fillfactor 80 keeps updates on their page as HOT updates, but only while old versions can be pruned. So no long transactions on the primary, and an alert on the oldest xmin.",
        "System accounts may go negative, so the CHECK skips them. They are protected by the fixed shape of each posting, the zero sum per currency, and reconciliation.",
      ],
    },
    {
      q: "Payroll for 5,000 employees, paid on Friday 27 November.",
      a: [
        "Dual approval, limits and the pay date live in the payments service. On approval it places one hold for the run's total, source_type PAYROLL_BATCH, expiring 30 November. If the employer is short, no hold is placed and the run waits.",
        "On the Bacs processing day one transaction captures the hold and debits the employer once. If all 5,000 bank with us, it is 5,001 entries, about 0.7 seconds in a test, under a 5 s batch timeout.",
        "Returns post later as their own transactions, linked by reference_id.",
      ],
    },
    // Failure
    {
      q: "Both synchronous standbys are gone. What is locked, and what does a card authorisation see?",
      a: [
        "With ANY 1 (s1, s2), a commit waits for one standby and keeps its row locks. With both gone, every commit waits, and everything touching those rows queues behind it.",
        "PlaceHold hits its lock timeout or the Card service's deadline, so the network gets a decline or stand-in. The sweeper settles the outcome later by auth id.",
        "The runbook never cancels a waiting backend: Postgres would report success with a warning that it may not be replicated. We fence the old primary, then promote. Recovery point zero holds for one failure at a time.",
      ],
    },
    {
      q: "Why not two-phase commit between the services, or with the network? And how do events get out safely?",
      a: [
        "Locks would be held across a network call, and a dead coordinator leaves customer rows locked. The card network is not a participant anyway. Instead each service commits its change with an outbox row, and a timeout is unknown, not failed.",
        "The ledger writes one outbox_events row per customer account touched, keyed by account, and consumers dedupe on event_id. The relay's slot is a failover slot, and synchronized_standby_slots makes it wait for the standbys, so it never publishes a commit a promotion would lose. I have not run those PostgreSQL 17 settings.",
      ],
    },
    {
      q: "The bakery pays a supplier on another cluster. Walk me through it and the crash in between.",
      a: [
        "Two local transactions. On the payer's cluster: wallet -X, INTERCLUSTER_OUT +X, and an outbox row. The outbox drives the second on the payee's cluster with the same idempotency key: INTERCLUSTER_IN -X, supplier +X.",
        "If we crash in between, the first has committed with its outbox row, so the relay delivers it after restart. A repeat of the second is refused by its header.",
        "The OUT and IN accounts must net to zero across clusters, and reconciliation watches the age of anything in flight.",
      ],
    },
    // Scale
    {
      q: "Your spec says date-partitioned transactions. What happens to your unique keys?",
      a: [
        "On a partitioned table every unique key must include the partition column. So I partition ledger_entries only. Its created_at defaults to now(), so a replay always differs, and its keys guard nothing on their own.",
        "The header, transactions, stays unpartitioned and is never deleted, so PRIMARY KEY (transaction_id) and UNIQUE (idempotency_key) stay real, lasting guards. Partitioning it loses the guard. It costs about 6.3 TB a year at the stress load.",
        "pending_holds stays unpartitioned for the same reason. An archive job moves holds ended over 90 days ago to a month-partitioned history: about 86 million deletes a day for vacuum.",
      ],
    },
    {
      q: "When do you move to TigerBeetle, how, and what do you give up?",
      a: [
        "When hot-row lock waits dominate after splitting and adding clusters.",
        "As I understand it, a transfer has one debit and one credit, so a three-entry payment becomes linked transfers, and each currency is its own ledger. There is no credit_limit column; limits become balance flags and funding transfers. A request takes up to 8,189 transfers.",
        "The triggers, guard and CHECK disappear, so those rules move into the Ledger API. The Card and Billing services do not notice: they call the same API.",
      ],
    },
    {
      q: "There is a ledger today. How do you move to this one without losing a penny?",
      a: [
        "Shadow first: every old transaction is also posted to the new ledger, with idempotency keys derived from the old ids, and balances compared per account and currency.",
        "Accounts open at zero, then take one opening transaction; ACTIVE holds come across with their original source ids. Cut over by cohort through a flag, system accounts last, after weeks of zero unexplained breaks across a month end. Keep the old ledger as reverse shadow, so rollback is a flag.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Core Ledger service, in shadow (one quarter)",
        ships: "One Postgres cluster: a primary, two synchronous standbys in other zones, a read replica, PgBouncer in transaction mode, timeouts on the database roles. The headers, the journal, pending_holds and accounts with their triggers, guard, CHECK, status and column grants; the zero-sum check at commit; account-first locking everywhere; PlaceHold, capture and void keyed by source; outbox_events with CDC on a failover slot; the hold expiry and archive jobs; month partitions on the journal; system accounts split 16 ways. The payments service is the first client: GBP bank payments and payroll, fed by shadow-posting from the existing ledger.",
        why: "Retires the risk that matters most, that the model or the concurrency is wrong, while being wrong costs nothing. One cluster carries the realistic 100 to 250 payments a second many times over, and the stress average of 2,000 write transactions a second.",
      },
      {
        name: "2. Reconciliation, end of day, then cards and billing",
        ships: "Nostro accounts and daily matching against bank statements and scheme settlement reports; clearing accounts back to zero; account_balances_daily and the Single Customer View file; a break queue and reversals with second-person approval. Then the Card service on its own database: synchronous PlaceHold, SettleCardTransaction through its outbox, the INITIATED sweeper and the nightly parity job, which ship together. Then the Billing service: buckets by APR tier, statements, nightly micro-interest, the waterfall and INTEREST_CHARGE. USD and EUR wallets and FX pools.",
        why: "Nothing cuts over until we can prove it is right. Cards come after because they add the synchronous path and the first cross-service failure modes, so the parity job is part of the release, not an afterthought. Billing comes last: it only reads events, so it cannot break the money.",
      },
      {
        name: "3. Cut over, account by account",
        ships: "A ledger-of-record flag per business. Cohorts: staff, quiet accounts, then the rest, system accounts last. The old ledger runs as reverse shadow, then is retired after a month end closes cleanly, with its history exported to the archive.",
        why: "Each cohort limits a mistake to a few accounts, and each step is reversible by a flag. Retiring the old ledger is a deliverable: two ledgers are a standing source of breaks.",
      },
      {
        name: "4. Phase 2: more ledger clusters, when measured",
        ships: "Tune the one cluster towards the estimated 5,000 to 8,000 write transactions a second, proved by a load test. Then ledger clusters split by business, each with its own 16-way system accounts, behind a routing directory inside the Core Ledger service. Payments between clusters are two local transactions joined by INTERCLUSTER_OUT and INTERCLUSTER_IN, driven by the outbox. At the stress peak of 20,000 write transactions a second, about four clusters.",
        why: "Each cluster adds operational cost forever, so it waits for evidence. The Card and Billing services do not change: routing hides behind the ledger API.",
      },
      {
        name: "5. Phase 3: TigerBeetle for the hot path, if needed",
        ships: "Balances and holds move to TigerBeetle behind the same ledger API: multi-leg postings as linked transfers, holds as pending transfers, limits as balance flags. The rules the triggers and CHECK enforced move into the Ledger API. Postgres keeps metadata, billing statements and search, fed by change data capture.",
        why: "Only when hot-row lock waits dominate after phase 2. It gives up the shared transaction with Postgres and the database-enforced rules, so it is a planned migration with shadow-posting, not a tuning step.",
      },
    ],

    migration: [
      "Map first. Write down how every account and transaction type in the old ledger maps to the new chart of accounts, per currency, with GL codes, and get finance to sign it off. Most migration breaks are mapping errors, not code.",
      "Opening balances, not full history. Accounts open at zero; for each account and currency, post one opening transaction at a cut-off against a migration account. History before the cut-off stays readable from the old system and then the archive.",
      "Shadow-post. Every committed transaction in the old ledger is replayed into the new one, with idempotency keys derived from the old ids, so a replay is refused by the header. Old authorisations become holds whose source ids are the originals. A rejection in the new ledger is a break, never silent.",
      "Compare continuously. Per account: posted and held, every few minutes. Per day: totals per system account and per currency. Exit criterion: zero unexplained breaks for several weeks spanning a month end and a payroll peak.",
      "Cut over by cohort with a flag. Carry ACTIVE holds across with their original source ids, so the capture, void or expiry lands in the new ledger. The freeze per account is seconds, not a maintenance window.",
      "Reverse the shadow. Once an account is on the new ledger, its transactions are replayed into the old one, so rollback is flipping the flag. Keep this until a month end has closed cleanly.",
      "Card authorisation records and billing buckets move with their accounts' cohort, and the parity job runs against whichever ledger is of record for each account.",
      "Avoid month end, quarter end and large payroll dates for any cohort move. Brief finance, risk and the auditors first; ask compliance whether the regulator needs telling, as a material change to a critical system.",
    ],

    slos: [
      {
        name: "Unexplained breaks",
        target: "Target: zero open breaks older than one business day, including parity breaks between the Card service and the ledger; zero internal invariant violations.",
        why: "This is what 'correct' means. One business day matches the daily reconciliation and the nightly parity job, so a break is understood before the next one is due.",
      },
      {
        name: "Time to detect a break",
        target: "Target: internal violations detected within 5 minutes; external and parity breaks within one business day.",
        why: "The incremental check runs every few minutes over accounts touched since its watermark; a weekly full re-sum catches what it misses. Statements and the parity job run daily, so that is the floor there.",
      },
      {
        name: "Card authorisation latency",
        target: "Target: 50 to 100 ms from the Card service receiving the request to its answer, at the 99th percentile (the owner's target); PlaceHold under 50 ms of that, measured inside the ledger.",
        why: "The network's whole budget is shared with fraud checks and the network itself. 50 ms in the ledger still allows a cross-zone synchronous commit.",
      },
      {
        name: "Durability",
        target: "Target: zero acknowledged transactions lost through any single failure; a cluster writing again within 1 minute of losing its primary.",
        why: "Recovery point zero is the reason for synchronous standbys, and it holds for one failure at a time. A minute is a scripted fence and promote; clients retry safely with the same keys meanwhile.",
      },
      {
        name: "Write availability",
        target: "Target: 99.95 per cent of minutes per cluster accepting writes, about 22 minutes a month.",
        why: "Card authorisations depend on it synchronously, and Faster Payments run all day. Not higher, because with both standbys gone commits wait, and we fence and promote rather than risk losing payments.",
      },
      {
        name: "Holds and authorisations end on time",
        target: "Target: no ACTIVE hold more than 5 minutes past its expires_at; no authorisation at INITIATED for more than 1 minute.",
        why: "A hold that outlives its expiry keeps the customer's money unavailable for nothing. A stuck INITIATED row means the Card service does not know an outcome the ledger does.",
      },
      {
        name: "Event freshness",
        target: "Target: outbox to topic within 5 seconds at the 99th percentile, for both the ledger's and the Card service's outboxes.",
        why: "Settlement, the Card service's CLEARED status and Billing's buckets all wait on it. The ledger's relay waits for the standbys, so a rise is also an early warning of replication trouble.",
      },
    ],

    oncall: [
      "Pages at 3am: any invariant violation (a currency not summing to zero, posted not equal to the entries, held not equal to the ACTIVE holds, a nostro not matching its statement). Money correctness outranks everything.",
      "Pages at 3am: a cluster not accepting writes or down to no synchronous standby; PlaceHold errors or authorisation latency burning the SLO fast; replication slot or WAL disk heading for full; the oldest xmin ageing.",
      "Pages at 3am: authorisations stuck at INITIATED, bank payments in 'unknown' ageing, settlement events not consumed, or the hold expiry job stopped, because customers' money is held with no outcome.",
      "Waits for the morning: a handful of parity breaks; a single small external break; the end-of-day sweep failing; a new customer receivable; the hold archive job behind; Billing's nightly accrual failing (it reruns from its own tables, and the key interest:<card>:<date> stops a double INTEREST_CHARGE).",
      "Runbook, parity breaks: the job ages breaks first, since an expired hold whose HoldExpired is still in flight is normal. APPROVED with no ACTIVE hold: was it captured or expired and the event missed? Replay it. ACTIVE hold with no APPROVED authorisation: void it by auth id. CLEARED with no POSTED transaction: replay SettleCardTransaction; the header's key makes that safe. Never edit a row in either database.",
      "Runbook, a stuck INITIATED authorisation: is the sweeper running? Call PlaceHold again with the same auth id to learn the hold, then void it and record DECLINED: the network never heard our approval, and a stand-in approval clears later as a force-post. If many are stuck, the ledger path is the incident.",
      "Runbook, losing both synchronous standbys: never cancel a backend waiting for a standby; it would report success for a commit no standby has. Fence the old primary, then promote; check the failover slot exists on the new primary.",
      "Runbook, invariant violation: freeze the accounts, turn off the code path, rebuild posted and held from the daily snapshot, later entries and ACTIVE holds in a reviewed, two-person break-glass change, then post reversals for wrong entries.",
    ],

    teams: [
      { name: "Core Ledger", owns: "The Core Ledger service: API, schema and triggers, holds and their expiry and archive, the duplicate guards, outbox_events and the CDC relay, clusters and routing, invariant checks, end of day. The only team with write access to ledger databases." },
      { name: "Cards", owns: "The Card service and its database: ISO 8583 lifecycle, card_authorisations, incremental and partial clearing, stand-in rules, chargebacks, the INITIATED sweeper, and the card side of the parity job and its breaks. Calls the ledger as a client." },
      { name: "Credit and billing", owns: "The Billing service and its database: credit limits and status changes, buckets by APR tier and grace eligibility, statements, nightly micro-interest, the waterfall, the INTEREST_CHARGE posting, and checking its bucket totals against each card's posted balance." },
      { name: "Payments", owns: "The Banking API: Faster Payments and Bacs connections, payment state machines, payroll runs with dual approval, value dates. Holds and posts through the ledger API like Cards." },
      { name: "Reconciliation and financial control", owns: "Nostro and settlement matching, clearing accounts back to zero, the break queue and corrections, the Single Customer View file, the daily feed to the general ledger, FX pool positions with treasury." },
      { name: "Platform (shared)", owns: "Postgres operations, backups and failover tooling with fencing, Kafka, object storage. The boundary that matters most: money moves only through the ledger API, and no service reads another's database." },
    ],

    buildBuy: [
      { part: "Posting engine and ledger API", call: "Build on Postgres", why: "Small, critical, and the rules are ours. Hosted ledgers such as Modern Treasury Ledgers put an outside API on every payment; Formance is an open-source alternative worth a look; core banking platforms such as Thought Machine Vault make sense only as part of a wider core replacement." },
      { part: "Card processing", call: "Build the Card service over an issuer processor's network connection, or buy more of it", why: "Issuer processors such as Thredd or Marqeta can run the network link and stand-in. What we keep is the authorisation record and the PlaceHold contract, so the ledger stays ours either way." },
      { part: "Database operations", call: "Buy managed Postgres if it meets recovery point zero, else run Patroni", why: "The team should spend its time on the ledger, not failover scripts. The test: can the managed failover lose an acknowledged commit, does it fence the old primary, and do we keep the settings we need, including failover slots." },
      { part: "Change data capture and events", call: "Buy (open source): Debezium on Kafka Connect, managed Kafka", why: "Log-based CDC with ordering is hard to get right. We own its configuration, the failover slot and slot monitoring. Two events per bank payment is a light load." },
      { part: "Reconciliation and parity", call: "Build the ledger-side matching and the parity job; consider a vendor for finance-ops matching", why: "Invariant checks, nostro matching and parity depend on our model. Wider matching across finance may already have an owner and a product." },
      { part: "Hot-path engine", call: "Do not build. TigerBeetle in phase 3, if measured need", why: "16-way system accounts and about four clusters carry the stress peak. TigerBeetle is the named exit if hot-row contention dominates; the ledger API keeps that door open." },
    ],

    cost: [
      "Machines: a ledger cluster is a primary, two synchronous standbys and a read replica, four nodes. Assumption: £2,000 to £4,000 a month per node with fast storage. Phase 1 is one cluster, £8,000 to £16,000 a month; four clusters at the stress peak, £32,000 to £64,000. The Card and Billing databases are smaller: a primary, a standby and a replica each.",
      "Storage at the stress load: 260 million entries a day at an assumed 250 bytes is 65 GB; 86 million headers at about 200 bytes is 17 GB; 86 million holds at 150 bytes is 13 GB; about 95 GB a day. Headers are never deleted: 6.3 TB a year at the stress load, 0.6 to 1.6 TB at the baseline. Hot data about 34 TB in year 1, 8.4 TB a cluster across four, times four copies, then about 1.6 TB more a cluster each year. There is no idempotency key table any more.",
      "Vacuum: the archive job deletes about 86 million ended holds a day at the stress load. That is the price of keeping the hold's keys real.",
      "Events: HoldPlaced, HoldVoided, HoldExpired and TransactionPosted on ledger-events, SettleCardTransaction on card-settlements. A bank payment is two: 2,000 a second (2 MB a second) on average, 20,000 (20 MB a second) at peak. Small.",
      "Three services cost three on-call rotations, three databases and a parity job. Worth it for the isolation; not worth it for a team of five, which is why the schemas split before the deployables.",
      "Headcount is the bigger cost. Core Ledger: five or six engineers. Cards and Billing: a team each, and Cards may exist already. Reconciliation: three or four alongside finance operations. A share of a platform team.",
      "The cost of being wrong dominates both: a nostro shortfall nobody can explain, a wrong Single Customer View file or a double-posted payroll run costs more in remediation and regulatory attention than a year of machines.",
    ],

    risks: [
      { risk: "A mapping or model error found after cut-over: right in aggregate, wrong per account.", answer: "Shadow-post for weeks with per-account, per-currency comparison; cut over by cohort; keep reverse shadow. Finance signs off the chart of accounts before code is written." },
      { risk: "The synchronous PlaceHold makes the ledger part of every card authorisation's latency and availability.", answer: "Role timeouts and a Card service deadline inside the network's budget; decline or stand-in on timeout, then void by auth id; synchronous standbys; the tightest SLO on the ledger. Load-test the authorisation path at the stress peak." },
      { risk: "The services drift apart: an APPROVED authorisation with no hold, or a hold nobody will capture.", answer: "The INITIATED sweeper within a minute, hold expiry as the backstop, and the nightly parity job in both directions. Parity breaks are an SLO, owned by Cards." },
      { risk: "Billing lags the ledger, so a statement misses a late event.", answer: "Billing cuts a statement only after consuming past the cut-off, and checks bucket totals against each card's posted balance first." },
      { risk: "A code path skips the soft check and overspends up to the hard floor.", answer: "One path for customer debits, in the ledger API, with the conditional insert. A test for each product. An alert on any account between credit_limit and hard_limit that no bank-initiated posting explains." },
      { risk: "One very busy customer whose wallet takes more writes than one row can.", answer: "Lock wait per account on a dashboard, with an alert. A wallet cannot be split, so: its own cluster, batching its outgoing payments, and in the end the TigerBeetle phase." },
      { risk: "pending_holds gains about 86 million rows a day and is not partitioned.", answer: "The archive job moves holds ended over 90 days ago to a month-partitioned history; only the archive role may delete, and the trigger refuses an ACTIVE hold. Partition-and-drop lost because its keys would have to include created_at and stop guarding." },
      { risk: "A long transaction on the primary stops pruning, so HOT updates stop and hot rows bloat.", answer: "No long transactions on the primary, idle_in_transaction_session_timeout, and an alert on the oldest xmin. Reports, billing and parity read replicas." },
      { risk: "Both standbys lost, and someone cancels the waiting commits to clear the queue.", answer: "The runbook forbids it: a cancel reports success for an unreplicated commit. Fence, then promote. Drill it each quarter." },
      { risk: "Rules in triggers are hidden from application developers.", answer: "Treat SQL as code: in the repository, reviewed, a test for each refusal. Property tests that assert the invariants under concurrency." },
      { risk: "Regulatory: a wrong Single Customer View file, or daily reconciliation missed during the migration.", answer: "Reconciliation and the snapshot ship before any cut-over and run across both ledgers. Finance, risk and the auditors are briefed before the first cohort." },
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
        "Load: 1,000 payments a second is a stress case; a realistic baseline is 100 to 250. The card answer has 50 to 100 ms.",
        "Names the hard problem: one hot row, not total throughput.",
      ],
    },
    {
      stage: "High-level design and service boundaries",
      minutes: 5,
      prompt: "Draw the three service boundaries first, each with its own database, then the arrows between them. Say what each owns and why the lines sit there.",
      cover: [
        "Core Ledger: accounts, pending_holds, transactions, ledger_entries, outbox_events. Funds, balances, zero sum; no product knowledge.",
        "Card service: card_authorisations, ISO 8583, merchants, declines, incremental and partial captures. Billing: buckets by APR tier, statements, micro-interest, the waterfall.",
        "Card network to Card service; Card service to Ledger API, synchronous PlaceHold; Card service outbox to card-settlements to the Ledger workers (settle, expire, sweep); ledger-events to Card service and Billing; Billing to Ledger API for INTEREST_CHARGE.",
        "Payments service calls the ledger like Cards. No shared databases, no two-phase commit, a nightly parity job.",
      ],
    },
    {
      stage: "Data model and invariants",
      minutes: 6,
      prompt: "Inside the Core Ledger, describe the tables, the triggers and the rules that must always hold. Say what is the truth and what is a cache.",
      cover: [
        "transactions: one header per transaction; UNIQUE (idempotency_key) is the lasting duplicate guard; one allowed change, POSTED to REVERSED, made by inserting a REVERSAL.",
        "ledger_entries: settled only, append-only, signed minor units (credit positive), sums to zero per currency, checked once at commit.",
        "pending_holds: UNIQUE (source_type, source_id), so PlaceHold by auth id is idempotent; ACTIVE, then CAPTURED, VOIDED or EXPIRED, once.",
        "accounts: posted and held kept by triggers; guard trigger; open at zero; status OPEN, NO_NEW_SPEND or CLOSED.",
        "Soft credit_limit tested when a customer starts a spend; CHECK posted - held >= -hard_limit unless allow_negative; past it, the customer's receivable.",
        "No idempotency key table: declines and saved replies live on the caller's record.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 3,
      prompt: "Do the sums that decide the architecture. Say which number matters most and why.",
      cover: [
        "Stress: 86.4 million payments a day; two write transactions each: 2,000 a second average, 20,000 peak. Baseline 100 to 250 payments a second.",
        "About 95 GB a day (65 GB entries, 17 GB headers, 13 GB holds); about 34 TB in year 1, 8.4 TB a cluster.",
        "One hot row: 500 to 1,000 writes a second. This is the number that matters.",
        "One cluster covers the average, four at peak; 2,500 ÷ 16 = about 156 writes a second per system row.",
      ],
    },
    {
      stage: "Write path",
      minutes: 7,
      prompt: "Walk Bright Bakery's £649.00 credit card purchase at NORTHERN OVENS LTD through all three services, then its £1,200.00 Faster Payment. Say what each step writes and the balances after.",
      cover: [
        "Card service writes auth a17c0de5-...0610 as INITIATED and calls PlaceHold with that id.",
        "Ledger, one transaction: lock the card account, test 0 - 0 - 64900 >= -500000, insert hold b61c9a3e-...0610 of 64900 (CARD_AUTH, source the auth id), HoldPlaced. Available 435100. Card service records APPROVED.",
        "Two days later the clearing file: CLEARING_SUBMITTED, SettleCardTransaction through the Card service's outbox and card-settlements.",
        "Settlement worker, one transaction: hold CAPTURED, transaction ...900611, key settle:<auth_id>: card -64900, MASTERCARD_CREDIT_CLEARING_GBP shard 7 +64900; TransactionPosted. Card service CLEARED; Billing buckets it by APR tier.",
        "Nightly micro-interest in Billing only: 32,005,479 micros a day at an illustrative 18%. Repayment 30000 (repay:k9): card -34900, available 465100. Statement: INTEREST_CHARGE 812, card -35712.",
        "Faster Payment e1f0c3a2-...3318 (pay_3fK9): hold of 120020, OUTBOUND_PAYMENT; capture ...900418 keyed fps:out:pay_3fK9: wallet -120020, FPS_CLEARING_GBP +120000, FEE_REVENUE_GBP +20; the scheme settles to NOSTRO_BOE_GBP.",
      ],
    },
    {
      stage: "Concurrency and hot accounts",
      minutes: 6,
      prompt: "Go deep on two payments racing for one wallet, and on the account every payment touches. Compare the options before you pick.",
      cover: [
        "Every path locks account rows first, in id order, FOR NO KEY UPDATE, then touches holds; the second waits, then places nothing.",
        "The CHECK guards the hard floor, not the soft limit; the caller records the decline, a retry is evaluated again.",
        "A hold leaves ACTIVE once; capture racing void tested 200 rounds, no deadlock.",
        "Timeouts on the role, not SET LOCAL statement_timeout; the commit wait needs the client deadline.",
        "System accounts 16 rows, hash of transaction id; HOT needs pruning, so watch the oldest xmin.",
      ],
    },
    {
      stage: "Failure, partitions and scale",
      minutes: 5,
      prompt: "Break it. Walk through the failures an interviewer will pick, across the service boundaries too, and what the customer sees. Then the scale path.",
      cover: [
        "PlaceHold times out: decline or stand-in, then VoidHold by auth id. Card service crashes after PlaceHold: the sweeper retries the same auth id and gets the same hold.",
        "SettleCardTransaction twice: UNIQUE (idempotency_key) posts nothing. A hold expires, then clears late: posts without a release, authorisation EXPIRED to CLEARED.",
        "Primary dies: fence, promote, nothing lost for one failure. Both standbys gone: never cancel the waiting commits.",
        "Partitioned journal: its keys guard nothing; the unpartitioned header does. Holds stay unpartitioned.",
        "Phases: one cluster; clusters by business; TigerBeetle, rules move to the API.",
      ],
    },
    {
      stage: "Proving it is right",
      minutes: 3,
      prompt: "Explain how you would know, every day, that the ledger is correct and the services agree, and what happens when they do not.",
      cover: [
        "Incremental check every few minutes; full re-sum weekly on a replica.",
        "Nostro against the statement; each clearing account back to zero after its cycle.",
        "Nightly parity: APPROVED to ACTIVE hold, CLEARED to POSTED transaction (hold_id = reference_id), both directions, breaks aged before raising; for example an APPROVED authorisation with no ACTIVE hold, fixed by replaying the missed event.",
        "A mismatch is a break with an owner; nothing is fixed by editing a row.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 5,
      prompt: "Step back from the diagram. Tell them how you would deliver it from where the company is today, and how you would run it.",
      cover: [
        "Phase 1: the Core Ledger in shadow in a quarter, payments as its first client; then reconciliation, then Cards with the parity job, then Billing, before cut-over.",
        "Three services map to three teams: Core Ledger, Cards, Credit and billing. No team reads another's database.",
        "Opening balances as transactions; cohort cut-over with reverse shadow. Phase 2 clusters and phase 3 TigerBeetle only when measured.",
        "What pages at 3am, the runbooks (parity breaks, a stuck INITIATED authorisation, never cancel a waiting commit), the main risks.",
      ],
    },
  ],
};
