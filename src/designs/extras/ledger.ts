import type { Extras } from './types';

/**
 * Interview extras for the ledger service.
 *
 * The question: "Design a central multi-currency ledger for a business bank: bank payments,
 * payroll, debit and credit card authorisations and settlements, and accounts in several
 * currencies. Balances must be strictly consistent under high-frequency writes."
 *
 * The design (owner's third spec, unified debit/credit): append-only ledger_entries holding settled movements only,
 * summing to zero per currency; pending_holds for money promised but not moved (ACTIVE, then
 * CAPTURED, VOIDED or EXPIRED, once); accounts with posted_balance and held_balance as caches
 * kept by triggers and guarded; credit_limit, with available = posted - held + credit_limit and
 * the CHECK valid_available_funds refusing a customer account below minus its limit, so one
 * schema serves debit wallets, overdrafts and credit cards. Statements, grace periods, the
 * waterfall and nightly interest belong to a separate billing service. One currency per account. Locks in id order FOR NO KEY UPDATE, lock_timeout 50 ms,
 * statement_timeout 250 ms. Hot system accounts split 16 ways by rail and currency, swept at end
 * of day. Outbox and queues, no 2PC. Phases: one Postgres cluster, more clusters by business,
 * then TigerBeetle for the hot path.
 *
 * Figures, derived from 1,000 payments a second on average and 10,000 at peak, with a bank
 * payment as one hold insert, one hold update and one ledger transaction of three entries:
 * 86.4 million payments a day; about 260 million entries and 86 million holds a day; two write
 * transactions per payment ("TPS" means write transactions a second), 2,000 a second on average,
 * 20,000 at peak; one cluster covers the average, four at peak (against the owner's estimate of
 * 5,000 to 8,000 a second per primary); 2,500 / 16 = about 156 writes a second per split system
 * row; five trigger UPDATEs per payment; about 80 GB a day (65 GB entries at 250 bytes, 13 GB
 * holds at 150 bytes); 26 TB of entries (13 months) plus 1.2 TB of holds (3 months) hot, about
 * 7 TB a cluster; 3 events per payment, 3 MB a second on average, 30 at peak. Agrees with
 * src/designs/ledger.ts.
 * Machine costs are labelled as assumptions. Canonical examples A, B, C and D from the brief and
 * addendum: Bright Bakery, GBP wallet ...081442, posted 842000; credit card ...081444, limit 500000.
 */
export const extras: Extras = {
  opening: [
    "This is the central ledger for a business bank. It serves bank payments, payroll, debit and credit card authorisations and settlements, and accounts in several currencies. Its job: say what each customer has, prove where every penny came from, and never let anyone spend beyond their limit.",
    "My assumptions, to check with you: about a million businesses, 1,000 payments a second on average, 10,000 at peak around payroll and month end. Amounts are whole pence and cents, in BIGINT.",
    "The journal is the truth. ledger_entries holds settled movements only. It is append-only: a trigger refuses every UPDATE and DELETE. Each transaction sums to zero in each currency.",
    "Money promised but not yet moved, like a card authorisation, is a hold. Holds live in their own table, pending_holds. A hold starts ACTIVE and ends once: CAPTURED, VOIDED or EXPIRED.",
    "accounts keeps two caches. posted_balance moves only through a trigger on the journal, held_balance only through a trigger on the holds. A guard trigger refuses any direct edit. Available is posted minus held plus credit_limit, and a CHECK refuses going below minus the limit, whatever code wrote it. So one schema serves debit, overdraft and credit: a limit of zero is a debit wallet.",
    "One currency per account. The bakery has a GBP row and a USD row. A dollar card payment is two zero-sum groups, one per currency, joined through FX pool accounts.",
    "Writes lock the accounts they touch in id order, FOR NO KEY UPDATE, with a 50 ms lock timeout and a 250 ms statement timeout. Hot system accounts, like FPS clearing in pounds, are split 16 ways by rail and currency, and swept at end of day.",
    "The payment scheme is never inside a database transaction. An outbox row commits with the money, queues absorb spikes, and there is no two-phase commit.",
    "It grows in three phases: one tuned Postgres cluster; more clusters split by business; then the hot debit and credit path moves to TigerBeetle, with Postgres kept for metadata, KYC, billing statements and reporting. I'll do the data model, one payment end to end, then concurrency, failure and delivery.",
  ],

  pushes: [
    {
      q: "Two payments from the same account arrive in the same millisecond, and together they exceed what is available. Prove only one succeeds.",
      a: [
        "Each locks the account first, in id order, FOR NO KEY UPDATE. The second waits until the first commits.",
        "Then it inserts its hold only if posted minus held minus the amount stays at or above minus the credit limit. It now sees the first hold, so it inserts nothing, and I answer insufficient funds.",
        "I'd prove it with a test: thousands of concurrent holds on one account, then assert none below its floor.",
      ],
    },
    {
      q: "Why lock at all, if the CHECK refuses an overdraft?",
      a: [
        "The CHECK is the backstop, not the path. Without the lock, the loser fails with error 23514 part way through. I want a clean refusal, decided before anything is written.",
        "The lock also fixes the order. The triggers update account rows in whatever order rows go in, so two transactions could lock in opposite orders and deadlock. Id order first removes that.",
      ],
    },
    {
      q: "Why FOR NO KEY UPDATE and not FOR UPDATE?",
      a: [
        "It is the weakest lock that still stops two balance writers. FOR UPDATE would also block inserts that only reference the account, because a foreign key check takes FOR KEY SHARE.",
        "Honestly, the gain here is small. Another hold or entry for the same account still waits, on the trigger's own update of that row. It is the right habit: lock no more than you need.",
      ],
    },
    {
      q: "lock_timeout 50 ms and statement_timeout 250 ms. What does the caller see?",
      a: [
        "Each write transaction starts with SET LOCAL for both, so they end with the transaction and are safe behind PgBouncer in transaction mode.",
        "A normal lock is held 1 to 2 ms. Waiting 50 ms means a queue on a hot row, and I'd rather fail than pile up connections. The transaction rolls back, and the caller retries with the same idempotency key.",
        "A card authorisation cannot queue: the network wants an answer in about 2 seconds. So it retries briefly, then declines or falls to stand-in rules. Payroll and payouts wait in Kafka or SQS and retry with backoff.",
      ],
    },
    {
      q: "One table for debit wallets, overdrafts and credit cards. How?",
      a: [
        "One column, credit_limit. The floor is minus the limit: zero for a debit wallet, minus the arranged amount for an overdraft, minus the card limit for a credit card. Available is always posted minus held plus credit_limit.",
        "Signs never change. Spending is a debit. The bakery's credit card has a £5,000 limit; a £649.00 purchase is a hold of 64,900, leaving 435,100 available. The capture posts card -64,900, MASTERCARD_CREDIT_CLEARING_GBP shard 7 +64,900.",
        "The alternative is a separate credit ledger. It duplicates every trigger, lock and check for no gain in safety.",
      ],
    },
    {
      q: "How does a repayment restore credit?",
      a: [
        "It is a plain two-leg transfer: the bakery's GBP wallet -30,000, the card +30,000. Or from FASTER_PAYMENTS_IN_GBP when it pays from another bank.",
        "Posted on the card goes from -64,932 to -34,932, so available credit is 465,068 the moment it commits. An overpayment leaves the card positive, which is fine.",
        "Which part of the debt it paid off is not the ledger's question.",
      ],
    },
    {
      q: "Where do statements, grace periods and the fees, interest, principal waterfall live? Why not in the ledger?",
      a: [
        "In a separate billing service. Inside one card balance the ledger cannot tell principal from interest; they are all just entries. Billing keeps the per-statement breakdown and reconciles its totals to the card's posted balance.",
        "Billing posts what it decides. Nightly interest is a pair: card -32, INTEREST_INCOME_GBP shard 7 +32, under the key interest:<account>:<date>, so a rerun posts nothing twice.",
        "The alternative is sub-accounts per card for principal, interest and fees. The ledger could then answer it, but at three times the rows and the locks.",
      ],
    },
    {
      q: "What happens when a credit limit is cut below what is already used?",
      a: [
        "The balance guard does not cover credit_limit; column grants do. Only the credit service's role may update credit_limit, allow_negative and is_active. The CHECK still runs on that update, so a cut below what is used is refused.",
        "So it needs a decision: lower it to the amount used, or leave it and block new holds through is_active or a card control outside the ledger. Either way the customer's debt never changes by an edit.",
      ],
    },
    {
      q: "Why do holds get their own table? Why not entries?",
      a: [
        "Because a hold changes and the journal must not. A hold starts ACTIVE and ends once, which is an update, and entries are never updated.",
        "As entries, every voided or expired authorisation would leave two entries in the permanent books for money that never moved. The cost is two places to reconcile, and the check covers both.",
      ],
    },
    {
      q: "Why posted and held? Why not one balance, or no cache at all?",
      a: [
        "They answer different questions. Posted is money that has moved: statements, interest and safeguarding use it. Available is what the customer can spend.",
        "One balance means a hold must move money, through a pending clearing account. That was my earlier design. It mixes promises with facts, and a void adds entries.",
        "A cache at all, because the funds check must read and lock one row, not sum years of entries. That also lets old months of the journal be archived.",
      ],
    },
    {
      q: "Walk me through a debit card payment in dollars, from authorisation to settlement.",
      a: [
        "The bakery buys USD 100.00. At authorisation I lock its GBP wallet, quote 0.80, so 8,000 pence, plus a 3 per cent FX buffer: a hold of 8,240, if available covers it. Nothing goes in the journal.",
        "It settles at 0.79. One statement captures the hold and posts five entries. Pounds: wallet -7,979, FX_POOL_GBP +7,900, FX_FEE_REVENUE_GBP +79. Dollars: FX_POOL_USD -10,000, MASTERCARD_DEBIT_CLEARING_USD +10,000.",
        "Each currency sums to zero. The 8,240 is released, so the 261 difference is free again. The rate lives on the payment record, not the entries. Rates are illustrative.",
      ],
    },
    {
      q: "What if the settlement differs from the hold: smaller, larger, no hold, after expiry? Or past the funds or the credit limit?",
      a: [
        "Smaller: the capture releases the whole hold and posts the real amount. Larger, no hold, or after expiry: the network settles with us regardless, so we post it. An expired hold has left ACTIVE, so it posts as if there were no hold.",
        "If the account can take it, it is an ordinary posting. If not, the account pays down to its floor, zero or minus the limit, and the rest is debited to CUSTOMER_RECEIVABLE_GBP, which collections chase. One balanced transaction; the CHECK never gives way.",
        "That is my choice. The alternative is a second, larger over-limit column. Simpler postings, but every account then has two limits to manage.",
      ],
    },
    {
      q: "How do you know one hold can never be both captured and voided?",
      a: [
        "The hold's trigger allows one change: ACTIVE to CAPTURED, VOIDED or EXPIRED, and nothing after. It also refuses deletes and changes of amount, account or currency.",
        "Capture is one statement: update the hold where status is ACTIVE, and insert the entries only from the row that update returned. Both happen or neither.",
        "If a capture and a void race, the second waits on the hold's row lock, then finds it no longer ACTIVE. It updates nothing and posts nothing.",
      ],
    },
    {
      q: "Why zero sum per currency, and what happens to the FX pools over a day?",
      a: [
        "A pound and a dollar are different units, so a transaction that sums to zero overall can still hide an error. Each currency balances alone, enforced at commit, and reconciles against our bank accounts in that currency.",
        "Over a day the GBP pool fills with pounds and the USD pool goes short of dollars. Treasury buys dollars with a real FX trade, booked as its own balanced transaction per currency. The gap between the rates is our FX profit or loss.",
      ],
    },
    {
      q: "Why triggers and not application code? Triggers are hidden and slow.",
      a: [
        "Because nobody can forget them. Every path that writes an entry or a hold moves the balance in the same transaction: the API, a script, a backfill. With the guard and the CHECK, the database refuses a wrong balance whatever wrote it.",
        "Hidden: they live in the repository, are reviewed like code, and each refusal has a test. Slow: one UPDATE per row, on a row I have already locked, an update that was always needed. Bulk loads post summary transactions.",
      ],
    },
    {
      q: "How do you prove the caches equal the journal and the holds?",
      a: [
        "A check query, every few minutes. Every posted_balance equals the sum of its entries, every held_balance the sum of its ACTIVE holds, and posted balances sum to zero per currency.",
        "Archived months are summed into account_period_totals first, so the check is those totals plus the hot entries.",
        "A difference pages: freeze the account, find the cause, rebuild in a reviewed break-glass change. Every business day, clearing and safeguarding accounts are matched to bank statements and scheme reports.",
      ],
    },
    {
      q: "Every bank payment credits FPS clearing and fee revenue. At peak, what happens to those rows?",
      a: [
        "One row holds its lock 1 to 2 ms per transaction, so it takes roughly 500 to 1,000 writes a second. Without a split, every payment on a cluster queues on it.",
        "So each hot system account is 16 rows, shard_id 0 to 15, picked by hash of the transaction id. At peak a cluster takes about 2,500 payments a second; divided by 16, about 156 writes a second on each row.",
        "At end of day a batch job sweeps the 16 rows into a master account, in id order, as one balanced transaction. Customer wallets and cards are never split.",
      ],
    },
    {
      q: "System accounts may go negative. What protects them, then?",
      a: [
        "Customers hold money and every currency sums to zero, so something must be negative. And one of 16 rows can be negative while the account as a whole is not.",
        "So the CHECK protects customer accounts only. System accounts are protected by the fixed shape of each transaction, the zero sum per currency, limits and alerts on each logical account's total, and daily reconciliation against the scheme. That is reconciliation's job, and I'd say so.",
      ],
    },
    {
      q: "You partition the journal by date. What happens to your unique constraint?",
      a: [
        "It gets weaker. Postgres won't partition by created_at unless every unique key includes it. So the key becomes (transaction_id, account_id, created_at), and a replay with a different created_at is no longer caught.",
        "idempotency_keys is the guard across partitions: one row per key, kept 72 hours, inserted first in the same transaction. The unique key stays as a second guard within a partition.",
        "Holds are partitioned by month too, about 3 months hot, and a month is dropped only when none of its holds is ACTIVE. Their key becomes (hold_id, created_at), so idempotency_keys guards holds as well.",
      ],
    },
    {
      q: "How do you correct a wrong entry?",
      a: [
        "With a new transaction, never an edit. Post a reversing transaction, same accounts, opposite amounts, referencing the original, then the right one. A wrong hold is voided and placed again.",
        "Corrections need a second approver. The history shows mistake, reversal and fix, which is what auditors want.",
      ],
    },
    {
      q: "What does fillfactor 80 buy you?",
      a: [
        "A bank payment updates the wallet row three times: hold placed, hold ended, entry posted. Each update writes a new row version.",
        "Fillfactor 80 leaves a fifth of each page free, so the new version usually fits on the same page. The balance columns are not indexed, so it can be a HOT update with no new index entries. The cost is about a quarter more pages for accounts: nothing.",
      ],
    },
    {
      q: "Payroll for 5,000 employees, all at once.",
      a: [
        "One transaction debits the employer once, for the total. If the employees bank elsewhere, it credits BACS_CLEARING_GBP once, and the 5,000 lines go in the Bacs file, not the journal.",
        "If they bank with us, it credits each wallet: 5,001 entries and locks. Whether that fits in 250 ms is not measured. The fallback is chunks of a few hundred through PAYROLL_CLEARING_GBP, each its own balanced transaction, and the clearing account returns to zero when the run completes.",
        "An account appears once per transaction, so a double payment is netted or goes in a second transaction. Payroll can queue; cards cannot.",
      ],
    },
    {
      q: "Why not two-phase commit with the scheme or the card network?",
      a: [
        "They are not participants in my database transaction, and I'd never want them to be. Locks would be held across a network call, seconds instead of 1 to 2 ms, and a dead coordinator leaves customer rows locked.",
        "Instead: the hold commits with an outbox row; the payments service calls the scheme; the answer comes back as a capture or a void, keyed k7:capture or k7:void. A timeout is unknown, not failed: the hold stays, we ask, then capture or void.",
      ],
    },
    {
      q: "When do you move to TigerBeetle, how, and what consistency do you give up?",
      a: [
        "When lock waits on hot rows dominate after splitting and adding clusters, or one customer's account is busier than one row can take. A customer account cannot be split.",
        "Behind the ledger API I shadow-post to TigerBeetle, compare balances, and cut over by cohort. Holds become pending transfers. Transfer ids are the idempotency keys.",
        "I give up the shared transaction with Postgres. So I order the writes: metadata to Postgres first, the transfer last, and read TigerBeetle first. TigerBeetle is the system of record for balances; billing and reporting catch up through change data capture.",
      ],
    },
    {
      q: "There is a ledger today. How do you move to this one without losing a penny?",
      a: [
        "Shadow first: every old transaction is also posted to the new ledger, idempotent on the old id, and balances compared per account and currency.",
        "Open each account with one opening transaction, never by setting a balance; carry ACTIVE holds across with their original ids. Cut over by cohort through a flag, system accounts last, after weeks of zero unexplained breaks across a month end. Keep the old ledger as reverse shadow, so rollback is a flag.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Phase 1 core, in shadow (one quarter)",
        ships: "One Postgres cluster: a primary, two synchronous standbys in other zones, a read replica, PgBouncer in transaction mode. The journal, pending_holds and accounts with their triggers, guard, CHECK and column grants; the hold expiry job every minute; locked conditional holds and captures; idempotency keys; the outbox with CDC; invariant checks every few minutes; month partitions; system accounts split 16 ways. GBP bank payments and payroll first, fed by shadow-posting from the existing ledger.",
        why: "Retires the risk that matters most, that the model or the concurrency is wrong, while being wrong costs nothing. One cluster carries the average load of about 2,000 write transactions a second with room to spare, so there is no routing work yet.",
      },
      {
        name: "2. Reconciliation, cards and currencies",
        ships: "Daily matching against bank statements and scheme settlement reports, a break queue with owners, and a correcting-transaction workflow with second-person approval. Then debit card holds with expiry, force-post handling with CUSTOMER_RECEIVABLE_GBP, USD and EUR accounts, FX pools and treasury's rebalancing trades. Then overdrafts and credit cards through credit_limit, with the billing service posting interest and repayments as ordinary transactions.",
        why: "Nothing cuts over until we can prove it is right, and safeguarding needs the same machinery every business day afterwards. Cards, FX and credit come after because they add the hard cases: buffers, force-posts, two currencies in one transaction, and limits that move.",
      },
      {
        name: "3. Cut over, account by account",
        ships: "A ledger-of-record flag per business. Cohorts: staff, quiet accounts, then the rest, system accounts last. The old ledger runs as reverse shadow, then is retired after a month end closes cleanly, with its history exported to the archive.",
        why: "Each cohort limits a mistake to a few accounts, and each step is reversible by a flag. Retiring the old ledger is a deliverable: two ledgers are a standing source of breaks.",
      },
      {
        name: "4. Phase 2: more clusters, when measured",
        ships: "Tune the one cluster towards the estimated 5,000 to 8,000 write transactions a second, proved by a load test. Then ledger clusters split by business, each with its own 16-way system accounts, behind a routing directory. At our 10,000 payments a second peak, which is 20,000 write transactions, that is about four clusters.",
        why: "Each cluster adds operational cost forever, so it waits for evidence. It reuses the same tables and triggers, so this phase is routing and operations, not a rewrite.",
      },
      {
        name: "5. Phase 3: TigerBeetle for the hot path, if needed",
        ships: "The debit and credit state machine moves to TigerBeetle behind the same ledger API, with holds as pending transfers. Postgres keeps customer metadata, KYC, billing statements, search and reporting, fed by change data capture.",
        why: "Only when hot-row lock waits dominate after phase 2. It gives up the shared transaction with Postgres, so it is a planned migration with shadow-posting, not a tuning step.",
      },
    ],

    migration: [
      "Map first. Write down how every account and transaction type in the old ledger maps to the new chart of accounts, per currency, and get finance to sign it off. Most migration breaks are mapping errors, not code.",
      "Opening balances, not full history. For each account and currency, post one opening transaction at a cut-off against a migration account. History before the cut-off stays readable from the old system and then the archive.",
      "Shadow-post. Every committed transaction in the old ledger is replayed into the new one, idempotent on the old id. Old authorisations become holds with ids derived from the originals. A rejection in the new ledger is a break, never silent.",
      "Compare continuously. Per account: posted and held, every few minutes. Per day: totals per system account and per currency. Exit criterion: zero unexplained breaks for several weeks spanning a month end and a payroll peak.",
      "Cut over by cohort with a flag. Carry ACTIVE holds across with their original ids, so the capture, void or expiry lands in the new ledger. The freeze per account is seconds, not a maintenance window.",
      "Reverse the shadow. Once an account is on the new ledger, its transactions are replayed into the old one, so rollback is flipping the flag. Keep this until a month end has closed cleanly.",
      "Keep external reconciliation running across both ledgers. During the mixed period system accounts exist in both, so finance sums both for the bank match and the daily safeguarding reconciliation.",
      "Avoid month end, quarter end and large payroll dates for any cohort move. Brief the safeguarding officer and auditors first; ask compliance whether the regulator needs telling, as a material change to a critical system.",
    ],

    slos: [
      {
        name: "Unexplained breaks",
        target: "Target: zero open breaks older than one business day; zero internal invariant violations.",
        why: "This is what 'correct' means. One business day matches the daily safeguarding cycle, so a break is understood before the next one is due.",
      },
      {
        name: "Time to detect a break",
        target: "Target: internal invariant violations detected within 5 minutes; external breaks within one business day of the statement arriving.",
        why: "The check query runs every few minutes, so a bad posting path is caught before it touches many accounts. External truth arrives daily, so that is the floor there.",
      },
      {
        name: "Durability",
        target: "Target: zero acknowledged transactions lost; a cluster writing again within 1 minute of losing its primary.",
        why: "Recovery point zero is the reason for synchronous standbys. A minute is a scripted promotion, and clients retry safely with their keys meanwhile.",
      },
      {
        name: "Write latency",
        target: "Target: a hold or a capture under 50 ms at the 99th percentile, measured inside the ledger.",
        why: "A card authorisation has about 2 seconds end to end, shared with the network, fraud and the processor. 50 ms leaves room and still allows a cross-zone synchronous commit.",
      },
      {
        name: "Write availability",
        target: "Target: 99.95 per cent of minutes per cluster accepting writes, about 22 minutes a month.",
        why: "Faster Payments and cards run all day every day. Not higher, because we stop writes on purpose on a cluster that has lost both standbys rather than risk losing payments.",
      },
      {
        name: "Holds end on time",
        target: "Target: no ACTIVE hold more than 5 minutes past its expires_at.",
        why: "A hold that outlives its expiry keeps the customer's money unavailable for nothing. The expiry job runs every minute through a partial index of ACTIVE holds, and an alert watches the oldest overdue hold.",
      },
      {
        name: "Event freshness",
        target: "Target: outbox to topic within 5 seconds at the 99th percentile.",
        why: "Notifications and fraud read the topic. It is also the early warning for a replication slot filling the primary's disk.",
      },
    ],

    oncall: [
      "Pages at 3am: any invariant violation (a currency not summing to zero, posted not equal to the entries, held not equal to the ACTIVE holds). Money correctness outranks everything.",
      "Pages at 3am: a cluster not accepting writes or down to no synchronous standby; replication slot or WAL disk heading for full; lock timeouts rising on one row; card authorisation latency SLO burning fast.",
      "Pages at 3am: bank payments in 'unknown' with the scheme ageing past a threshold, or the hold expiry job stopped, because customers' money is held with no outcome.",
      "Waits for the morning: a single small external break, the end-of-day sweep failing (system rows are untidy, not wrong), warehouse consumer lag, an archive export failing its count check, an FX pool near but inside its limit, the nightly interest run failing (billing reruns it; the key stops a double post).",
      "First runbook: cluster failover, including losing both synchronous standbys and stopping writes on purpose, and how to tell customers and the payments team.",
      "Second runbook: invariant violation. Freeze the accounts, turn off the code path, rebuild posted and held from account_period_totals, entries and ACTIVE holds in a reviewed, audited break-glass change, then post reversing transactions for wrong entries.",
      "Third runbook: CDC relay, Kafka or SQS down. The ledger carries on; watch the slot, know how to drop and recreate it safely, and how consumers replay without double-applying.",
    ],

    teams: [
      { name: "Ledger core", owns: "The ledger API, schema and triggers, holds and their expiry, clusters and routing, idempotency, the outbox and CDC relay, invariant checks. The only team with write access to ledger databases." },
      { name: "Payments and cards", owns: "Payment orchestration and state machines, scheme connections (Faster Payments, Bacs, card networks), authorisation decisions and stand-in rules, status enquiries for unknown outcomes. Posts to the ledger through its API as a client." },
      { name: "Credit and billing", owns: "Credit limits and their changes, statement cut-offs, grace periods, the fees, interest and principal waterfall, nightly interest. Posts interest and fees to the ledger as ordinary transactions, keyed interest:<account>:<date>, and reconciles its statement totals to each card's posted balance." },
      { name: "Reconciliation and financial control", owns: "Statement and settlement file matching, the break queue and corrections, safeguarding reconciliation, FX pool positions with treasury, migration comparisons." },
      { name: "Platform (shared)", owns: "Postgres operations, backups and failover tooling, Kafka and SQS, object storage. The boundary that matters most: money moves only through the ledger API, and the ledger knows accounts and currencies, not products." },
    ],

    buildBuy: [
      { part: "Posting engine and ledger API", call: "Build on Postgres", why: "Small, critical, and the rules are ours. Hosted ledgers such as Modern Treasury Ledgers put an outside API on every payment; Formance is an open-source alternative worth a look; core banking platforms such as Thought Machine Vault make sense only as part of a wider core replacement." },
      { part: "Database operations", call: "Buy managed Postgres if it meets recovery point zero, else run Patroni", why: "The team should spend its time on the ledger, not failover scripts. The test is whether the managed failover can lose an acknowledged commit, and whether we keep the settings we need." },
      { part: "Change data capture", call: "Buy (open source): Debezium on Kafka Connect", why: "Log-based CDC with ordering is hard to get right. We own its configuration and the replication slot monitoring." },
      { part: "Queues and event log", call: "Buy: managed Kafka, or SQS for work queues", why: "Three events per payment: about 3,000 a second and 3 MB a second on average, 30 MB at peak. That is a light load. Nothing about it is ours to differentiate on." },
      { part: "Reconciliation", call: "Build the ledger-side matching; consider a vendor for finance-ops matching", why: "Invariant checks and ledger-to-bank matching depend on our model. Wider matching across finance may already have an owner and a product." },
      { part: "Payment workflow", call: "Build a small state machine first", why: "A workflow engine such as Temporal is another system on the money path. Adopt it if rails and states outgrow hand-written recovery workers." },
      { part: "Hot-path engine", call: "Do not build. TigerBeetle in phase 3, if measured need", why: "16-way system accounts and about four clusters carry 10,000 payments a second. TigerBeetle is the named exit if hot-row contention dominates; the ledger API keeps that door open." },
    ],

    cost: [
      "Machines: a cluster is a primary, two synchronous standbys and a read replica, four nodes. Assumption: £2,000 to £4,000 a month per node with fast storage. Phase 1 is one cluster, £8,000 to £16,000 a month. Four clusters at peak, 16 nodes, is £32,000 to £64,000 a month.",
      "Storage: about 260 million entries a day at an assumed 250 bytes is 65 GB; 86 million holds at an assumed 150 bytes is 13 GB; about 80 GB a day. Hot: 26 TB of entries for 13 months plus 1.2 TB of holds for 3 months, about 7 TB a cluster, times four copies. The accounts table is under 300 MB.",
      "Events: hold placed, hold ended and transaction posted, three per payment: about 3,000 a second. At an assumed 1 KB each, 3 MB a second on average, 30 MB at peak: small.",
      "Synchronous replication is the line item that buys recovery point zero. Two standbys rather than one doubles the standby bill, and is the right trade.",
      "Headcount is the bigger cost. Ledger core: five or six engineers. Reconciliation: three or four alongside finance operations. Payments and cards exist already. A share of a platform team for Postgres.",
      "The cost of being wrong dominates both: an unreconciled safeguarding shortfall or a double-posted payroll run costs more in remediation and regulatory attention than a year of machines.",
    ],

    risks: [
      { risk: "A mapping or model error found after cut-over: right in aggregate, wrong per account.", answer: "Shadow-post for weeks with per-account, per-currency comparison; cut over by cohort; keep reverse shadow. Finance signs off the chart of accounts before code is written." },
      { risk: "One very busy customer whose wallet takes more writes than one row can.", answer: "Lock wait per account on a dashboard, with an alert. A wallet cannot be split, so: its own cluster, batching its outgoing payments, and in the end the TigerBeetle phase." },
      { risk: "Holds leak: authorisations never captured or voided keep customers' money unavailable.", answer: "Every hold has expires_at; an expiry job sets EXPIRED using the partial index; an SLO on holds past expiry; a late settlement still posts, as a no-hold settlement." },
      { risk: "pending_holds gains about 86 million rows a day, and its trigger refuses deletes.", answer: "It is partitioned by month like the journal: about 3 months hot, and a month is dropped after export only when none of its holds is ACTIVE. The key then includes created_at, so idempotency_keys is the guard across partitions." },
      { risk: "An FX pool's position runs beyond treasury's limit on a busy day.", answer: "The pool total is a monitored figure with a limit and an alert, and treasury trades during the day, not only at close. System rows may go negative, so this is a limit, not a CHECK." },
      { risk: "A credit limit is cut below what a card has already used, and the CHECK refuses the update.", answer: "A written rule in the credit service: lower the limit to the amount used, or keep it and block new holds through is_active or a card control. Never edit a balance to make a limit fit." },
      { risk: "Rules in triggers are hidden from application developers.", answer: "Treat SQL as code: in the repository, reviewed, a test for each refusal. Property tests that assert the invariants under concurrency, and a load test at 10,000 payments a second." },
      { risk: "Regulatory: daily safeguarding reconciliation missed or wrong during the migration.", answer: "Reconciliation ships before any cut-over and runs across both ledgers. The safeguarding officer and auditors are briefed before the first cohort." },
      { risk: "Key-person risk: few people understand Postgres locking and the ledger model.", answer: "Pairing on the posting path, written design records, failover and invariant drills run by different people each quarter." },
    ],
  },

  rehearsal: [
    {
      stage: "Clarify and scope",
      minutes: 5,
      prompt: "Restate the problem in your own words. Ask the questions that change the design, then state your assumptions and the hard problem out loud.",
      cover: [
        "Whose money: customer balances at a regulated bank, so safeguarding and daily reconciliation apply.",
        "Products: bank payments, payroll, debit and credit cards, overdrafts, accounts in several currencies.",
        "Strict consistency: no customer below its floor, money conserved per currency, a read sees the write.",
        "Load and skew: 1,000 payments a second average, 10,000 peak; which accounts are in most transactions.",
        "Names the hard problem: one hot row, not total throughput.",
      ],
    },
    {
      stage: "Data model and invariants",
      minutes: 7,
      prompt: "Before any boxes, describe the three tables, the triggers and the rules that must always hold. Say what is the truth and what is a cache.",
      cover: [
        "ledger_entries: settled only, append-only, signed minor units (credit positive), sums to zero per currency.",
        "pending_holds: ACTIVE, then CAPTURED, VOIDED or EXPIRED, once; never deleted or changed in amount.",
        "accounts: posted_balance and held_balance, each kept by its own trigger; guard trigger; fillfactor 80.",
        "valid_available_funds: posted - held >= -credit_limit unless allow_negative. Limit 0 is debit; above 0 is overdraft or credit card.",
        "Statements, grace periods, the waterfall and interest live in billing, not the ledger.",
        "One currency per account; the trigger refuses an entry or hold in another currency.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 4,
      prompt: "Do the sums that decide the architecture. Say which number matters most and why.",
      cover: [
        "86.4 million payments a day. A bank payment: one hold insert, one hold update, one ledger transaction of three entries (five for a card with FX).",
        "Two write transactions per payment: 2,000 a second average, 20,000 peak. TPS means write transactions.",
        "About 80 GB a day (65 GB entries, 13 GB holds); 26 TB of entries and 1.2 TB of holds hot, about 7 TB a cluster.",
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
        "Capture under k7:capture, transaction ...900418: wallet -120020, FPS_CLEARING_GBP shard 7 +120000, FEE_REVENUE_GBP shard 7 +20. Posted 721980, held 0.",
        "Scheme rejects: void under k7:void; held back to 0, posted still 842000, no entries. Timeout: unknown, enquire.",
        "Card: hold of 8240 (8000 plus a 3 per cent buffer); settles at 0.79 as five entries in two currencies; 261 freed.",
        "Credit card, limit 500000: hold 64900 leaves 435100; capture to MASTERCARD_CREDIT_CLEARING_GBP; interest 32; repayment 30000 leaves posted -34932, available 465068.",
        "Force-post past funds or limit: account to its floor, the rest to CUSTOMER_RECEIVABLE_GBP.",
      ],
    },
    {
      stage: "Concurrency and hot accounts",
      minutes: 7,
      prompt: "Go deep on two payments racing for one wallet, and on the account every payment touches. Compare the options before you pick.",
      cover: [
        "Lock in id order FOR NO KEY UPDATE; the second waits, then its conditional insert (floor minus credit_limit) places nothing.",
        "Why lock when the CHECK exists: clean refusal, not 23514; fixed lock order, no deadlocks.",
        "Capture as one statement; a hold leaves ACTIVE once, so never captured and voided.",
        "lock_timeout 50 ms, statement_timeout 250 ms with SET LOCAL; cards fail fast, payroll queues.",
        "System accounts 16 rows by rail and currency, hash of transaction id; end-of-day sweep.",
      ],
    },
    {
      stage: "Failure, partitions and scale",
      minutes: 6,
      prompt: "Break it. Walk through the failures an interviewer will pick and what the customer sees. Then the scale path.",
      cover: [
        "Primary dies: promote the synchronous standby, nothing lost, clients retry with keys.",
        "Outbox and CDC, never dual write; queues absorb spikes; no two-phase commit.",
        "Partitioned, the unique key must include created_at; idempotency_keys is the guard across partitions.",
        "Phases: one cluster; clusters by business; TigerBeetle for the hot path, no shared transaction, order the writes.",
      ],
    },
    {
      stage: "Proving it is right",
      minutes: 3,
      prompt: "Explain how you would know, every day, that the ledger is correct, and what happens when it is not.",
      cover: [
        "Check query: posted equals entries, held equals ACTIVE holds, each currency sums to zero.",
        "Daily reconciliation against bank statements and scheme reports; FX pools against treasury.",
        "A mismatch pages; rebuild only in a reviewed break-glass change.",
        "Correctness as an SLO: zero unexplained breaks, time to detect.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 5,
      prompt: "Step back from the diagram. Tell them how you would deliver it from where the company is today, and how you would run it.",
      cover: [
        "Phase 1 in shadow in a quarter; reconciliation, then cards, currencies and credit, before cut-over.",
        "Opening balances as transactions; cohort cut-over with reverse shadow.",
        "Phase 2 clusters and phase 3 TigerBeetle only when measured.",
        "One team owns the ledger; product teams post through the API only.",
        "What pages at 3am, the first runbooks, the main risks.",
      ],
    },
  ],
};
