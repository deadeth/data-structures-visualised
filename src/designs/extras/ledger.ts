import type { Extras } from './types';

/**
 * Interview extras for the ledger service.
 *
 * The question: "Design a ledger service that must ensure strict consistency
 * for account balances while supporting high-frequency transaction writes."
 *
 * The design: append-only ledger_entries; accounts as a balance cache kept by an AFTER INSERT
 * trigger, guarded against direct edits, with a CHECK that refuses customer overdrafts; rows
 * locked in id order FOR NO KEY UPDATE, then a conditional insert. Numbers agree with
 * src/designs/ledger.ts: 1,000 payments a second on average, 10,000 at peak; two ledger
 * transactions and five entries per payment; 16 Postgres shards by business, 2.7 TB hot each,
 * 110 GB a day, house accounts split 16 ways, keys kept 72 hours. Canonical example: Bright Bakery pays £1,200.00 with a 20p fee, sub-account 07.
 * Cost figures for machines are labelled as assumptions.
 */
export const extras: Extras = {
  opening: [
    "So the job is a ledger: how much money each customer has, and proof that every penny came from somewhere and went somewhere. Strict consistency means three things to me. No customer balance goes below zero, however many payments race. No write creates or loses money. And a read after a payment sees it.",
    "My assumptions, which I'd check with you: customer balances at a UK business bank, so safeguarding and daily reconciliation apply. About a million businesses, 1,000 payments a second on average, 10,000 at peak around payroll and month end. Each payment is two ledger transactions, so 20,000 a second at peak. Faster Payments first, pounds only. And there is a ledger today, so this replaces one.",
    "The design in one line: the journal is the truth, and the balance is a cache the database keeps for me. ledger_entries is append-only: a trigger refuses every UPDATE and DELETE. Amounts are signed pence, and each transaction's entries sum to zero. accounts holds one balance per account. An AFTER INSERT trigger on the entries adds each amount to its balance in the same transaction, so both commit or neither does. A guard trigger refuses any direct edit to a balance.",
    "Overdrafts are refused twice. The Ledger API sends each transaction as one call to a function, ledger_transfer. It locks the accounts it touches in id order, FOR NO KEY UPDATE, then inserts the entries in one statement only if the balance covers the amount. Zero rows inserted means insufficient funds. Behind that, a CHECK on accounts refuses a customer balance below zero, whatever code wrote it. Locks last 1 to 2 ms and are never held across a network call.",
    "Scale has three levers. Shard by business, 16 shards, so a payment stays on one shard. Partition each shard's journal by date and archive old months; that never slows a balance check, because the check reads accounts, not the journal. And split hot house accounts, such as fee income, 16 ways, because one row takes only 500 to 1,000 writes a second.",
    "The payment scheme sits outside every transaction. A payment is two balanced transactions. Reserve moves the money from the wallet to a pending clearing account. Settle moves it on to settlement and fee income, or a reversal sends it back. The outbox row commits with the reserve, so the event goes out exactly when the money moved. No two-phase commit.",
    "I'll do the data model, the numbers, one payment end to end, then concurrency, hot accounts and failure, and finish with how I'd deliver it.",
  ],

  pushes: [
    {
      q: "Two payments from the same wallet arrive in the same millisecond, and together they exceed the balance. Prove only one succeeds.",
      a: [
        "Each one locks its rows first: SELECT ... ORDER BY account_id FOR NO KEY UPDATE. The second waits on the wallet row until the first commits.",
        "Then it runs the CTE: insert the entries only if balance >= amount. The balance it now reads includes the first payment. If it no longer covers the amount, zero rows go in. I roll back and answer insufficient funds.",
        "Locking in id order means two opposite transfers take locks in the same order, so they cannot deadlock.",
        "I'd prove it with a test, not an argument: thousands of concurrent debits at one wallet, then assert no balance below zero and every transaction summing to zero.",
      ],
    },
    {
      q: "Why lock at all, if the CHECK refuses an overdraft?",
      a: [
        "The CHECK is the backstop, not the path. Without the lock, the losing payment would fail with a constraint error, 23514, half way through. I want a clean 'insufficient funds', decided before anything is written.",
        "The lock also fixes the order. The trigger updates balances in whatever order the entries go in. Two transfers between the same accounts could take those row locks in opposite orders and deadlock. Locking in id order first removes that.",
        "And it makes the funds check read a balance nobody else can change before I commit.",
      ],
    },
    {
      q: "Why FOR NO KEY UPDATE and not FOR UPDATE?",
      a: [
        "FOR UPDATE is stronger than I need. Nothing here changes a key, and the balance update itself takes FOR NO KEY UPDATE. So I lock what I'm about to do, no more.",
        "The difference: inserting a row that references an account checks the foreign key with a FOR KEY SHARE lock. FOR UPDATE blocks that; FOR NO KEY UPDATE does not. Two balance writers still exclude each other.",
        "In this design the gain is small, because another writer to the same account waits on its balance update anyway. It matters for tables that only reference accounts, and it is the right habit.",
      ],
    },
    {
      q: "Why a trigger and not application code?",
      a: [
        "Because nobody can forget it. Every code path that inserts an entry moves the balance, in the same transaction: the API, a correction script, a migration, a backfill.",
        "Together with the guard and the CHECK, the database refuses a wrong balance whatever wrote it. Application code can only promise that.",
        "The alternative is to update the balance inside ledger_transfer itself. It works, but only if every writer goes through that function. A trigger puts the rule on the table.",
        "Grants do the rest: the ledger's role can insert entries, nobody can update or delete them, and no other service has credentials.",
      ],
    },
    {
      q: "Triggers are hidden logic and slow. Defend it.",
      a: [
        "Hidden: fair. So it is not hidden from us. The triggers live in the repository with the schema, are reviewed like code, and have tests for each refusal: edit a balance, update an entry, overdraw. A superuser can skip triggers, so that role stays out of reach.",
        "Slow: it costs one extra UPDATE per entry, inside a transaction that already holds that row's lock. The update was always needed; the trigger only moves where it runs. The commit to the standby, 1 to 2 ms, dominates.",
        "Where it really costs is bulk loads, which fire it row by row. For those I'd use a statement-level trigger with a transition table, or load into a staging table and post summary transactions.",
        "The balanced-transaction check at commit is optional. It runs one small query per inserted row. I keep it because the CTE should already guarantee it, and a backstop is cheap.",
      ],
    },
    {
      q: "Why keep a balance at all, if the journal is the truth?",
      a: [
        "Because the funds check must be fast and must lock something. Summing a wallet's entries on every payment grows with history. Reading one row does not.",
        "A row is also something to lock. You cannot lock 'the sum of entries' without locking every entry for the account.",
        "And it is what lets the journal be partitioned and archived. Old months leave the database, and no balance check ever notices.",
      ],
    },
    {
      q: "How do you know the cache equals the journal?",
      a: [
        "A reconciliation query, every few minutes: join accounts to the sum of their entries, grouped by account, and return any row where balance differs. It should return nothing.",
        "Before a month is archived, each account's total for it goes into account_period_totals. The check is those totals plus the hot entries, not a re-sum of everything.",
        "Alongside it: every transaction sums to zero, all balances together sum to zero, and every FPS_PENDING part returns to zero within an age limit.",
        "A difference means a bug, most likely a trigger disabled or bypassed. It pages. Freeze the account, find the cause, then rebuild in a reviewed break-glass change: in one transaction, disable the guard, recompute from account_period_totals and the entries, re-enable it, and record who ran it.",
        "Outside, every business day: settlement and safeguarding accounts against the bank statement and the scheme's settlement report.",
      ],
    },
    {
      q: "You said partition by date. What happens to your unique constraint?",
      a: [
        "It has to change, and it gets weaker. Postgres won't partition by created_at unless every unique key includes created_at.",
        "So the keys become (entry_id, created_at) and (transaction_id, account_id, created_at). A replay carrying a different created_at is no longer caught by that constraint.",
        "The guard that holds across partitions is idempotency_keys: one row per key, inserted first in the same transaction, ON CONFLICT DO NOTHING. A replay finds k7 already there and returns the saved result.",
        "The unique constraint becomes a second guard within one partition. That is a real trade, and I'd rather say it than hide it.",
      ],
    },
    {
      q: "Where is 'pending', if entries are never updated?",
      a: [
        "Not on an entry. Pending is where the money is. Bright Bakery's reserve debits the wallet £1,200.20 and credits FPS_PENDING_07.",
        "So the wallet's balance drops at once, from £8,420.00 to £7,219.80. Balance is the available balance; there is no second figure.",
        "Settle debits pending £1,200.20 and credits settlement £1,200.00 and fee income 20p. If the scheme rejects, a reversal, transaction ...900419, debits pending and credits the wallet.",
        "The state, PENDING, SETTLED or FAILED, lives on the payment record in the payments service, which owns the workflow. A pending account that stays above zero is the signal that something is stuck. Nothing in the ledger stops both a settle and a reverse for one reserve, because their keys differ, k7:settle and k7:reverse; the payment's state machine allows only one, and a shared clearing key would let the ledger enforce it too.",
        "On a timeout: unknown is not failed. The money stays in pending, we ask the scheme, then settle or reverse. Reversing on a timeout could pay the supplier and refund the bakery.",
      ],
    },
    {
      q: "Why not two-phase commit with the scheme?",
      a: [
        "Faster Payments is not a participant in my database transaction, and I'd never want it to be. Locks would be held across a network call, seconds instead of 1 to 2 ms.",
        "If the coordinator dies between prepare and commit, customer balances stay locked until someone resolves it, on the money path.",
        "Instead: reserve commits with an outbox row; the payments service reads the event and calls the scheme; the answer comes back as a settle or reverse transaction, each idempotent on its own key, such as k7:settle.",
        "The same idea covers a payment between two of our customers on different shards: a local debit into clearing on one, a local credit out of clearing on the other. Anything stuck shows as clearing not at zero.",
      ],
    },
    {
      q: "A system account goes negative. Is that a bug?",
      a: [
        "It depends on the account, and the schema says which. Every transaction sums to zero, so all balances together sum to zero. Customers hold money, so something must be negative.",
        "Settlement and funding accounts are allowed to go negative: they mirror our position with the scheme and the bank. That is bookkeeping, not a bug.",
        "Wallets, pending clearing and fee income have allow_negative false. The CHECK refuses them below zero, so that bug cannot commit.",
      ],
    },
    {
      q: "How do you correct a wrong entry?",
      a: [
        "With a new transaction, never an edit. The trigger refuses UPDATE and DELETE on entries anyway.",
        "Post a reversing transaction: the same accounts, opposite amounts, referencing the original. Then post the right one. The balances follow through the trigger.",
        "It needs a second person to approve, and the history shows the mistake, the reversal and the fix. That is what auditors want to see.",
      ],
    },
    {
      q: "What does fillfactor 80 buy you?",
      a: [
        "Postgres writes a new row version on every update. Fillfactor 80 leaves a fifth of each page free, so the new version of a balance row usually fits on the same page.",
        "Then it can be a HOT update: balance is not indexed, so no index needs a new entry. Fewer writes per payment, less bloat, less work for vacuum.",
        "The cost is about a quarter more pages for accounts. For a million rows that is nothing.",
      ],
    },
    {
      q: "Every payment credits our fee account. At peak, what happens to that row?",
      a: [
        "It becomes a queue. One row takes about 500 to 1,000 writes a second, and a shard peaks at about 1,000 payments a second. One fee row per shard would sit at its limit.",
        "So each shard's house accounts are split 16 ways: FPS_PENDING, FPS_SETTLEMENT and FEE_INCOME, 01 to 16, picked by hashing the transaction id. About 60 writes a second on each fee or settlement part, and 125 on each pending part, which the reserve and the settle both write.",
        "Fee income is never checked for overdraft, but the trigger's update still locks it, which is why it is split too.",
        "Every minute a sweeper moves each FEE_INCOME and FPS_SETTLEMENT part's total into its main account, with an ordinary balanced transaction. FPS_PENDING is never swept: the settle or reverse must find the money there. I graph lock wait per account, so a new hot account shows up on a dashboard, not in an incident.",
      ],
    },
    {
      q: "What breaks first at ten times the load?",
      a: [
        "Not total throughput: 100,000 payments a second is more shards, and a business still lives on one. What breaks is one very busy business. Its wallet is one row, it cannot be split, and every debit must lock it.",
        "For that tenant: its own shard, then sub-wallets with a reserve topped up by sweeps, or batching its outgoing payments.",
        "Next, house accounts per shard: raise 16 to 64. Then the journal: about 1.1 TB a day, so partitions get smaller and archive sooner.",
        "If hot accounts still dominate, the exit is a ledger database such as TigerBeetle, which applies batches of up to 8,190 transfers in one round trip. The ledger API is the only way in, so that is a migration behind a stable interface.",
      ],
    },
    {
      q: "There is a ledger today. How do you move to this one without losing a penny?",
      a: [
        "Shadow first. Every transaction in the old ledger is also posted to the new one, idempotent on the old id, and balances are compared per account continuously.",
        "Open each account with one opening transaction against a funding account, not by setting a balance. The guard would refuse that anyway.",
        "Cut over account by account through a flag in the routing directory, house accounts last, after weeks of zero unexplained breaks including a month end.",
        "Keep the old ledger as reverse shadow, so rollback is flipping the flag back.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Correct core, in shadow (one quarter)",
        ships: "One Postgres primary with a synchronous standby in another zone. The append-only journal and its triggers, the accounts cache with its guard and CHECK, the locked conditional insert, idempotency keys, the outbox with CDC, and invariant checks every few minutes. Fed by shadow-posting from the existing ledger; nothing customer-facing reads it yet.",
        why: "Retires the risk that matters most, that the model or the concurrency is wrong, while it costs nothing to be wrong. A small team of four or five can ship it in a quarter because there is no sharding, no hot-account work and no cut-over.",
      },
      {
        name: "2. Reconciliation and break handling",
        ships: "Daily matching against bank statements and scheme settlement reports, a break queue with owners and evidence, and a correcting-transaction workflow with second-person approval. Per-account comparison between old and new ledgers on the same tooling.",
        why: "Nothing cuts over until we can prove it is right, and the same machinery is what safeguarding needs every business day afterwards. Building it second means the migration has a safety net from day one.",
      },
      {
        name: "3. Cut over, account by account",
        ships: "A ledger-of-record flag per business in the routing directory. Cohorts: staff, then quiet accounts, then the rest, house accounts last. Balance reads move to the new ledger with each cohort. The old ledger runs as reverse shadow for rollback.",
        why: "Each cohort limits the blast radius of a mistake to a few accounts, and each step is reversible by a flag. Moving house accounts last avoids splitting the hottest rows between two systems.",
      },
      {
        name: "4. Scale when measured",
        ships: "House accounts split 16 ways, with the sweeper, once lock-wait graphs show them. Sharding by business, starting at a few shards, when a single primary passes about half its tested write capacity at peak. Date partitions on the journal, with old months detached and archived to Parquet.",
        why: "Sharding adds operational cost for every shard forever, so it waits for evidence. The first version uses the same tables and triggers, so this phase is routing and operations, not a rewrite.",
      },
      {
        name: "5. Retire the old ledger",
        ships: "Turn off reverse shadow after a rollback window that includes a month end. Export the old ledger's history to the archive with checksums, and decommission it.",
        why: "Two ledgers are a standing source of breaks and double the audit surface. Ending the dual run is a deliverable, not an afterthought.",
      },
    ],

    migration: [
      "Map first. Write down how every account and transaction type in the old ledger maps to the new chart of accounts, and get finance to sign it off. Most migration breaks are mapping errors, not code.",
      "Opening balances, not full history. For each account, post one opening transaction in the new ledger at a cut-off, referencing the old system's balance. History before the cut-off stays readable from the old system and then the archive.",
      "Shadow-post. Every committed transaction in the old ledger is replayed into the new one from its events, idempotent on the old transaction id, including reserves, settlements and reversals. The new ledger rejects nothing silently: a rejection is a break.",
      "Compare continuously. Per account: the balance, every few minutes. Per day: totals per house account, including what sits in pending clearing, and per currency. A difference is a break with an owner. Exit criterion for cut-over: zero unexplained breaks for several weeks spanning a month end and a payroll peak.",
      "Cut over by cohort with a flag in the routing directory. Move an account when it has no payment waiting on the scheme, or carry the reserve across with its original ids so the settle or reversal lands in the new ledger. The freeze per account is seconds, not a maintenance window.",
      "Reverse the shadow. Once an account is on the new ledger, its transactions are replayed into the old one, so rollback is flipping the flag back with the old books still current. Keep this until a month end has closed cleanly on the new ledger.",
      "Keep external reconciliation running across both ledgers the whole time. During the mixed period house accounts exist in both, so finance sums both for the bank match and the daily safeguarding reconciliation.",
      "Avoid month end, quarter end and large payroll dates for any cohort move. Brief the safeguarding officer and auditors before the first cohort; I would ask compliance whether the change needs telling the regulator about, as a material change to a critical system.",
    ],

    slos: [
      {
        name: "Unexplained breaks",
        target: "Target: zero open breaks older than one business day; zero internal invariant violations.",
        why: "This is what 'correct' means. One business day matches the daily safeguarding reconciliation cycle, so a break is understood before the next one is due.",
      },
      {
        name: "Time to detect a break",
        target: "Target: internal invariant violations detected within 5 minutes; external breaks within one business day of the statement arriving.",
        why: "The internal checks run every few minutes, so a bug in a posting path is caught before it has touched many accounts. External truth only arrives daily, so that is the floor there.",
      },
      {
        name: "Durability",
        target: "Target: zero acknowledged transactions lost; a shard writing again within 1 minute of losing its primary.",
        why: "Recovery point zero is the reason for synchronous standbys. A minute is what a scripted promotion of an up-to-date standby takes, and clients retry safely with their keys meanwhile.",
      },
      {
        name: "Write latency",
        target: "Target: reserve or post under 50 ms at the 99th percentile, measured inside the ledger.",
        why: "The payment journey also waits on authentication, fraud and the scheme. 50 ms leaves the ledger a small share and still allows a cross-zone synchronous commit and some lock waiting.",
      },
      {
        name: "Write availability",
        target: "Target: 99.95 per cent of minutes per shard accepting writes, about 22 minutes a month.",
        why: "Faster Payments runs all day every day, so there is no quiet window. It is not higher because we deliberately stop writes on a shard that has lost both standbys rather than risk losing payments.",
      },
      {
        name: "Event freshness",
        target: "Target: outbox to topic within 5 seconds at the 99th percentile.",
        why: "Notifications and fraud read the topic, and customers notice a notification that lags the balance. It is also the early warning for a replication slot filling the primary's disk.",
      },
    ],

    oncall: [
      "Pages at 3am: any internal invariant violation (a transaction or a currency not summing to zero, a balance not equal to the sum of its entries). Money correctness outranks everything.",
      "Pages at 3am: a shard not accepting writes, or down to no synchronous standby; replication slot lag or WAL disk growth heading for full; write latency SLO burning fast.",
      "Pages at 3am: payments in 'unknown' with the scheme ageing past a threshold, because customers' money is held with no outcome.",
      "Waits for the morning: a single external break under a set amount, consumer lag for the warehouse, an archive export that failed its count check, the sweeper stopping (balances are untidy, not wrong).",
      "First runbook: shard failover, including the case where both synchronous standbys are lost and we stop writes on purpose, and how to tell customers and the payments team.",
      "Second runbook: invariant violation. Freeze the affected accounts, find the code path and turn it off, rebuild the balances from account_period_totals and the entries in a reviewed break-glass change (disable the guard inside one transaction, recompute, re-enable, audit), and post reversing transactions for wrong entries. Who to call in finance and compliance.",
      "Third runbook: CDC relay or Kafka down. The ledger carries on; watch the slot, how to drop and recreate it safely if disk is at risk, and how consumers replay without double-applying.",
    ],

    teams: [
      { name: "Ledger core", owns: "The ledger API, schema and triggers, sharding and routing, idempotency, the outbox and CDC relay, invariant checks. The only team with write access to ledger databases." },
      { name: "Payments", owns: "Payment orchestration and its state machine, scheme connections (Faster Payments, Bacs, cards), status enquiries for unknown outcomes. Posts to the ledger through its API as a client." },
      { name: "Reconciliation and financial control", owns: "Statement and settlement file ingestion, matching, the break queue and correction workflow, safeguarding reconciliation, migration comparisons. Engineers working day to day with finance operations." },
      { name: "Platform (shared)", owns: "Postgres operations, backups and failover tooling, Kafka, object storage. The boundary that matters most is between ledger core and every product team: money moves only through the ledger API, and the ledger stays ignorant of rails and products." },
    ],

    buildBuy: [
      { part: "Posting engine and ledger API", call: "Build on Postgres", why: "Small, critical, and the rules are ours. Hosted ledgers such as Modern Treasury Ledgers put an outside API on every payment and add a supplier to oversee; Formance is an open-source alternative worth a look; core banking platforms such as Thought Machine Vault make sense only as part of a wider core replacement." },
      { part: "Database operations", call: "Buy managed Postgres if it meets recovery point zero, else run Patroni", why: "The team should spend its time on the ledger, not on failover scripts. The test is whether the managed service's failover can lose an acknowledged commit and whether we keep the settings we need." },
      { part: "Change data capture", call: "Buy (open source): Debezium on Kafka Connect", why: "Log-based CDC with ordering is hard to get right and Debezium is the standard. We own its configuration and the replication slot monitoring." },
      { part: "Event log", call: "Buy: managed Kafka (Amazon MSK or Confluent Cloud)", why: "About 2 MB a second on average is small. Nothing about it is ours to differentiate on." },
      { part: "Reconciliation", call: "Build the ledger-side matching; consider a vendor for finance-ops matching", why: "Invariant checks and ledger-to-bank matching depend on our model. Products such as Duco exist for wider matching across finance, which finance may already own." },
      { part: "Payment workflow", call: "Build a small state machine first", why: "A workflow engine such as Temporal is another system on the money path. Adopt it if the number of rails and states outgrows hand-written recovery workers." },
      { part: "Hot-account engine", call: "Do not build or buy yet", why: "16 sub-accounts per house account carry us at 10,000 payments a second. TigerBeetle is the named exit if contention dominates; the ledger API keeps that option open." },
    ],

    cost: [
      "Machines: 16 shards, each a primary, two synchronous standbys and one read replica: 64 database nodes. Assumption: £2,000 to £4,000 a month each with fast storage, so roughly £130,000 to £250,000 a month at full scale. The first version is three nodes, well under £15,000 a month.",
      "Storage: five entries a payment, about 110 GB a day; 13 months hot is about 43 TB, 2.7 TB a shard. Four copies of each shard means about 170 TB provisioned, plus backups and write-ahead log. The archive grows about 40 TB a year before Parquet compression, cheap in object storage.",
      "Synchronous replication is the line item that buys recovery point zero: two standbys per shard rather than one doubles the standby bill, and is the right trade.",
      "Kafka is small: about 2 MB a second on average, 20 MB at peak. CDC and the relay are a few small machines.",
      "Headcount is the bigger cost and the bigger risk. Ledger core: five or six engineers. Reconciliation: three or four engineers alongside finance operations. Payments exists already. A share of a platform team for Postgres. Most of that is the same whether we run one shard or 16, which is why sharding waits for evidence.",
      "The cost of being wrong dominates both: an unreconciled safeguarding shortfall or a double-posted payroll run costs more in remediation and regulatory attention than a year of machines.",
    ],

    risks: [
      { risk: "A mapping or model error found after cut-over: balances right in aggregate, wrong per account.", answer: "Shadow-post for weeks with per-account comparison, cut over by cohort, keep reverse shadow for rollback. Finance signs off the chart of accounts before code is written." },
      { risk: "An unexpected hot account, such as a large customer receiving thousands of payments a second.", answer: "Lock wait per account on a dashboard with an alert. Sub-accounts work for any credit-heavy account, and a very large tenant can get its own shard." },
      { risk: "Regulatory: daily safeguarding reconciliation is missed or wrong during the migration.", answer: "Reconciliation is phase 2, before any cut-over, and runs across both ledgers. The safeguarding officer and auditors are briefed before the first cohort and see the break reports." },
      { risk: "Rules in triggers are hidden from application developers and hard to review and test.", answer: "Treat SQL as code: triggers in the repository with the schema, reviewed, with a test for each refusal (edit a balance, update an entry, overdraw). Property tests that assert the invariants under concurrency, and a load test at 10,000 payments a second with hot accounts." },
      { risk: "Schema changes on 2.7 TB entries tables stall a shard.", answer: "Expand and contract only; monthly partitions from day one, with idempotency_keys as the replay guard because the unique key must then include the date; rehearse each change on a restored copy of a full shard." },
      { risk: "Key-person risk: one or two people understand Postgres locking and the ledger model.", answer: "Pairing on the posting path, written design records, failover and invariant drills run by different people each quarter, and an on-call rota that includes the reconciliation team." },
      { risk: "Scope creep: multi-currency, interest, FX and new rails all land on the ledger team.", answer: "The model supports currencies from the start but we ship pounds only. New rails are new accounts and new clients of the API, owned by the teams that want them." },
    ],
  },

  rehearsal: [
    {
      stage: "Clarify and scope",
      minutes: 5,
      prompt: "Restate the problem in your own words. Ask the questions that change the design, then state your assumptions and the one hard problem out loud.",
      cover: [
        "Whose money: customer balances at a regulated firm, so safeguarding and daily reconciliation apply.",
        "What strict consistency means: no customer balance below zero, money conserved, a read sees the write.",
        "Load and skew: 1,000 payments a second average, 10,000 peak, and whether some accounts are in most transactions.",
        "Rails and currencies; whether a ledger already exists.",
        "Names the hard problem: one hot balance row, not total throughput.",
      ],
    },
    {
      stage: "Data model and invariants",
      minutes: 6,
      prompt: "Before any boxes, describe the two tables, the triggers and the rules that must always hold. Say what is the truth and what is a cache.",
      cover: [
        "ledger_entries: append-only, signed pence (credit positive), a BEFORE UPDATE OR DELETE trigger refuses changes.",
        "accounts: balance BIGINT as a cache, kept by an AFTER INSERT trigger in the same transaction; fillfactor 80 for HOT updates.",
        "Guard trigger refuses direct balance edits: pg_trigger_depth() <= 1 inside the function, not in a WHEN clause.",
        "CHECK (allow_negative OR balance >= 0): wallets, pending and fee income never below zero; settlement may be.",
        "Each transaction sums to zero (deferred check at commit, optional); corrections only by reversing transactions.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 4,
      prompt: "Do the sums that decide the architecture. Say which number matters most and why.",
      cover: [
        "86 million payments a day; two ledger transactions and five entries each: 50,000 entries a second at peak.",
        "About 110 GB a day; 13 months hot is about 43 TB, 2.7 TB on each of 16 shards.",
        "Per shard at peak: 1,000 payments, 2,000 ledger transactions a second.",
        "One hot row: 500 to 1,000 writes a second. This is the number that matters.",
        "House accounts split 16 ways: about 60 writes a second per fee or settlement part, 125 per pending part.",
      ],
    },
    {
      stage: "Write path",
      minutes: 8,
      prompt: "Walk Bright Bakery's £1,200.00 payment with a 20p fee from the app to the scheme and back. Say what is in each transaction and the balances after each.",
      cover: [
        "One call to ledger_transfer per transaction. Key k7 inserted first, ON CONFLICT DO NOTHING; zero rows means a replay, return the saved result.",
        "Reserve: lock FPS_PENDING_07 then the wallet, id order, FOR NO KEY UPDATE; CTE inserts -120020 and +120020 only if balance >= 120020.",
        "Wallet £8,420.00 to £7,219.80; pending £1,200.20. Outbox row in the same commit; commit waits for a synchronous standby.",
        "Settle under k7:settle: pending -120020, settlement +120000, fee income +20. Pending back to zero.",
        "Rejected: a reversal (k7:reverse, ...900419) from pending to the wallet; the payment record allows only one of settle or reverse. Timeout: unknown, so enquire, then settle or reverse.",
      ],
    },
    {
      stage: "Concurrency and hot accounts",
      minutes: 8,
      prompt: "Go deep on two payments racing for one wallet, and on the account every payment touches. Compare the options before you pick.",
      cover: [
        "The second payment waits on the row lock, then the CTE sees the new balance and inserts nothing.",
        "Why lock when the CHECK exists: clean refusal, not error 23514; fixed lock order, no deadlocks.",
        "FOR NO KEY UPDATE over FOR UPDATE; compared with conditional update in a function, serializable, optimistic, TigerBeetle.",
        "Sub-account 07 of 16, picked by hashing the transaction id; fee and settlement parts swept every minute, pending never.",
        "No two-phase commit: outbox plus reserve and settle; cross-shard by clearing accounts.",
      ],
    },
    {
      stage: "Failure, partitions and reads",
      minutes: 6,
      prompt: "Break it. Walk through the failures an interviewer will pick and show what the customer sees in each. Then say what partitioning by date costs.",
      cover: [
        "Primary dies: promote the synchronous standby, nothing lost, clients retry with keys.",
        "Outbox and CDC, never dual write; Kafka down does not stop payments; watch the slot.",
        "Partitioned, the unique key must include created_at; idempotency_keys is the guard across partitions.",
        "Old partitions detached and archived; balance checks never read them.",
        "Balance from the primary; statements from replicas with cursor pagination.",
      ],
    },
    {
      stage: "Proving it is right",
      minutes: 3,
      prompt: "Explain how you would know, every day, that the ledger is correct, and what happens when it is not.",
      cover: [
        "Reconciliation query: each balance equals account_period_totals plus hot entries; all balances sum to zero.",
        "Daily reconciliation against bank statements and scheme reports; CASS 15 for safeguarded funds.",
        "A mismatch pages; rebuild from account_period_totals and entries only in a reviewed break-glass change.",
        "Correctness as an SLO: zero unexplained breaks, time to detect.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 5,
      prompt: "Step back from the diagram. Tell them how you would deliver it from where the company is today, and how you would run it.",
      cover: [
        "First version: one primary and a synchronous standby, tables and triggers, in shadow, in a quarter.",
        "Reconciliation before cut-over; opening balances as transactions; account-by-account cut-over with reverse shadow.",
        "Shard, split house accounts and partition when measured, with written triggers; what not to build.",
        "One team owns the ledger; product teams post through the API only.",
        "What pages at 3am and the first runbooks; the main risks and answers.",
      ],
    },
  ],
};
