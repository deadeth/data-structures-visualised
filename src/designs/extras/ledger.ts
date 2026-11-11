import type { Extras } from './types';

/**
 * Interview extras for the ledger service.
 *
 * The question: "Design a ledger service that must ensure strict consistency
 * for account balances while supporting high-frequency transaction writes."
 *
 * Numbers agree with src/designs/ledger.ts: 1,000 transactions a second on average,
 * 10,000 at peak, 16 Postgres shards, 1.6 TB hot each, 65 GB a day, 32 sub-accounts per
 * hot account, keys kept 72 hours. Cost figures for machines are labelled as assumptions.
 */
export const extras: Extras = {
  opening: [
    "So the job is a ledger: the system that says how much money each customer has, and that every penny that moved came from somewhere and went somewhere. Strict consistency, as I read it, means three things. No balance goes below its limit, however many payments race. No money is created or lost by a write. And a balance read after a payment sees that payment.",
    "A few questions before I draw anything. Whose money is it: customer balances at a bank or e-money firm, or the company's own books? I'll assume customer balances for a UK business bank, so safeguarding and daily reconciliation apply. What is the load and how skewed is it? I'll assume about a million business accounts, 1,000 transactions a second on average and 10,000 at peak around payroll and month end. Which rails? I'll assume Faster Payments first, with cards and Bacs later, and pounds only to start.",
    "Is there a ledger today? At a firm of any age there is, so I'll treat this as replacing or wrapping one, not a greenfield build. That changes the plan more than it changes the diagram, and I'll come back to it at the end.",
    "The one hard problem is concurrency on a single balance. Throughput in total is easy: 10,000 a second spread over a million accounts is sharded Postgres. What is hard is one row that many transactions touch, such as our own fee income or the scheme settlement account. A balance row is a lock, and one lock with a synchronously replicated commit tops out around 500 to 1,000 writes a second.",
    "The shape of the answer: double-entry, append-only entries in integer pence. One database call per transaction that stores the idempotency key, does a conditional update on each balance row, inserts the entries and an outbox row, and commits to a synchronous standby. Shard by business so a payment stays on one shard. Split hot accounts into sub-accounts and sweep them. Publish events from the outbox, never by a dual write. And prove it is right with continuous invariant checks and daily reconciliation against the bank.",
    "I'll start with the data model and the two invariants, do the sums, draw the write path, then spend most of the time on concurrency, hot accounts and failure. I'll finish with how I'd phase it, migrate to it, and know it is working.",
  ],

  pushes: [
    {
      q: "Two payments for the same account arrive in the same millisecond, and together they exceed the balance. Prove only one succeeds.",
      a: [
        "Both run UPDATE balances SET pending = pending + x WHERE id = a AND available >= x. The second blocks on the row lock the first holds. Under Read Committed, when the first commits, Postgres re-evaluates the WHERE clause against the new row, finds it false, and updates zero rows.",
        "Zero rows updated means rejected: the function raises, the whole transaction rolls back, and no entries or outbox row exist for it. Check and reserve are one statement, so there is no gap to race in.",
        "Transfers lock both accounts in ascending account id, so two opposite transfers cannot deadlock.",
        "The lock is held only for in-database work plus the commit, because the transaction is a single stored-function call. No network round trip from the application while locks are held.",
        "I would show it with a test, not an argument: a property test that fires thousands of concurrent debits at one account and asserts it never goes below its limit and the books sum to zero.",
      ],
    },
    {
      q: "Every payment credits our fee account. At 10,000 a second, what happens to that row?",
      a: [
        "It becomes a queue. With the lock held until a synchronously replicated commit of 1 to 2 ms, one row takes 500 to 1,000 writes a second. Every payment would wait behind it.",
        "Split it into 32 sub-accounts, picked by a hash of the transaction id: about 300 writes a second each at peak. A sweep every minute moves the totals into the main account with an ordinary balanced transaction.",
        "Fee income only receives credits, so it has no limit to protect. I can skip the conditional check altogether and let a job roll up its balance, which is what Modern Treasury does for hot accounts.",
        "The settlement account is harder because its balance matters to treasury. Sub-accounts keep every balance exact: main plus subs is always right, only the main row alone lags.",
        "I watch lock wait time per account, so a new hot account, such as a large marketplace customer, is found by a graph, not an incident.",
      ],
    },
    {
      q: "We sent the payment to Faster Payments and the call timed out. What does the ledger show, and what do you do?",
      a: [
        "Unknown is not failed. The funds stay reserved as a pending transaction, so the customer cannot spend them twice while we find out.",
        "The payment service asks the scheme for the status using the same payment identifier, then posts or voids the pending transaction. Each is idempotent on its key.",
        "Payments that stay unknown are aged and alerted on. A growing count is a page, because it means customers' money is held without a reason they can see.",
        "The worst design is to void on timeout: the money may have left, and we would have given it back to the customer as well.",
      ],
    },
    {
      q: "A business pays another business that lives on a different shard. How do you keep it atomic?",
      a: [
        "I avoid most of these by design: a business and all its accounts live on one shard, and house accounts exist on every shard, so an outbound payment never leaves its shard.",
        "Business-to-business between our own customers is the real cross-shard case. I'd run it as a saga through a clearing account: debit the payer into clearing on shard A, then credit the payee from clearing on shard B, each a local transaction, idempotent on the transfer id.",
        "Atomicity becomes visibility. Anything stuck shows as a non-zero clearing account, which reconciliation already watches. Clearing accounts should net to zero.",
        "Not two-phase commit: a coordinator failure leaves locks held on two customer balances, on the money path.",
      ],
    },
    {
      q: "Why not serializable isolation, or optimistic locking with a version column?",
      a: [
        "Serializable finds every anomaly, but it does it by aborting transactions that must then be retried. On a busy account that is a retry storm exactly at peak.",
        "Optimistic locking is lovely when conflicts are rare: readers never block. Under contention most attempts fail and retry, so it is worst where load is highest.",
        "A conditional update makes the rule explicit and the database queues the writers instead of failing them. It is the same lock as SELECT FOR UPDATE, held for less time.",
        "I would still offer a version check in the API for a client that wants 'only if nothing changed since I looked', because that is a business rule, not a concurrency mechanism.",
      ],
    },
    {
      q: "There is a ledger today. How do you move to this one without losing a penny?",
      a: [
        "Shadow first. Every transaction posted to the old ledger is also posted to the new one, and balances are compared per account continuously. Reconciliation is the safety net, not a final check.",
        "I don't cut over until unexplained differences have been zero for several weeks, including a month end and a payroll peak.",
        "Then account by account, through a flag in the routing directory: staff accounts, then quiet accounts, then by shard, house accounts last. Each cohort moves when it has no pending holds in flight.",
        "After a cohort moves, the old ledger becomes the shadow for a rollback window, so flipping back is a flag change with the old books still current.",
        "External reconciliation against the bank runs across both ledgers throughout, because safeguarding does not pause for a migration.",
      ],
    },
    {
      q: "How would you phase it, and what would you not build?",
      a: [
        "First quarter: one Postgres primary with a synchronous standby, the posting function, idempotency, the outbox and the invariant checks. Running in shadow. That retires the correctness risk before any scale work.",
        "Then reconciliation and the break workflow, then migration cohorts, then sharding only when one primary's measured headroom says so. Hot-account sub-accounts come when a lock-wait graph shows a hot row.",
        "Not building: two-phase commit, multi-currency, a workflow engine on the money path, a search index for statements, or a purpose-built database. Each has a trigger that would make me build it, and I'd write the trigger down.",
        "The tables, functions and outbox are the same on one node as on 16, so sharding later is routing, not a rewrite.",
      ],
    },
    {
      q: "How do you know it is correct in production, not just fast?",
      a: [
        "Correct is an objective with a number: zero unexplained breaks older than one business day, and invariant violations found within minutes.",
        "Inside: every few minutes, check that each transaction sums to zero, that all entries per currency sum to zero, and that each balance row equals the sum of its entries.",
        "Outside: every business day, the ledger's view of settlement and safeguarding accounts against the bank statement and the scheme settlement reports.",
        "Every break gets an owner, an amount and evidence, and is closed by a reviewed correcting transaction. Never by editing an entry. The count of breaks and their age are on the same dashboard as latency.",
      ],
    },
    {
      q: "Who owns the ledger, and what stops a product team writing to it directly?",
      a: [
        "One team owns the ledger: the API, the posting functions, the shards and the invariants. Payments, cards and lending own their flows and post to the ledger through its API, never its database.",
        "The ledger knows about money, not about Faster Payments or fraud. A team that wants a new rail or product does not need a ledger change, only a new chart of accounts.",
        "Database grants enforce it: the ledger's role can INSERT entries and nothing can UPDATE or DELETE them. No other service gets credentials.",
        "Finance and the safeguarding officer are customers of the ledger with a say in the chart of accounts and correction approvals. That is a governance boundary as much as a technical one.",
      ],
    },
    {
      q: "When would you leave Postgres for something like TigerBeetle?",
      a: [
        "When hot-account contention dominates and sub-accounts stop being enough: tens of thousands of transfers a second through a few shared accounts, as at a card processor or a central switch.",
        "TigerBeetle applies batches of up to 8,190 transfers on one thread in one round trip, with balance limits enforced inside. That removes row locks as the ceiling.",
        "The price is a specialised database with its own operations, a team that must learn it, and account metadata still in Postgres beside it. For a regulated firm, also a new critical supplier to justify.",
        "Because the ledger API is the only way in, swapping the posting engine is a migration behind a stable interface, done with the same shadow-and-compare playbook.",
      ],
    },
  ],

  lead: {
    phases: [
      {
        name: "1. Correct core, in shadow (one quarter)",
        ships: "One Postgres primary with a synchronous standby in another zone. The double-entry schema, the posting function with conditional balance updates, idempotency keys, the outbox with CDC, and invariant checks every few minutes. Fed by shadow-posting from the existing ledger; nothing customer-facing reads it yet.",
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
        ships: "Sub-accounts and the sweeper for hot accounts once lock-wait graphs show them. Sharding by business, starting at a few shards, when a single primary passes about half its tested write capacity at peak. Archive of old months to Parquet.",
        why: "Sharding adds operational cost for every shard forever, so it waits for evidence. The first version uses the same tables and functions, so this phase is routing and operations, not a rewrite.",
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
      "Shadow-post. Every committed transaction in the old ledger is replayed into the new one from its events, idempotent on the old transaction id, including pending holds, posts and voids. The new ledger rejects nothing silently: a rejection is a break.",
      "Compare continuously. Per account: posted and available balances, every few minutes. Per day: totals per house account and per currency. A difference is a break with an owner. Exit criterion for cut-over: zero unexplained breaks for several weeks spanning a month end and a payroll peak.",
      "Cut over by cohort with a flag in the routing directory. Move an account when it has no pending holds in flight, or carry them across as pending with their original ids. The freeze per account is seconds, not a maintenance window.",
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
      "Pages at 3am: any internal invariant violation (a transaction or a currency not summing to zero, a balance row not equal to its entries). Money correctness outranks everything.",
      "Pages at 3am: a shard not accepting writes, or down to no synchronous standby; replication slot lag or WAL disk growth heading for full; write latency SLO burning fast.",
      "Pages at 3am: payments in 'unknown' with the scheme ageing past a threshold, because customers' money is held with no outcome.",
      "Waits for the morning: a single external break under a set amount, consumer lag for the warehouse, an archive export that failed its count check, the sweeper stopping (balances are untidy, not wrong).",
      "First runbook: shard failover, including the case where both synchronous standbys are lost and we stop writes on purpose, and how to tell customers and the payments team.",
      "Second runbook: invariant violation. Freeze the affected accounts, rebuild balance rows from entries, find the code path, turn it off, and post reviewed corrections. Who to call in finance and compliance.",
      "Third runbook: CDC relay or Kafka down. The ledger carries on; watch the slot, how to drop and recreate it safely if disk is at risk, and how consumers replay without double-applying.",
    ],

    teams: [
      { name: "Ledger core", owns: "The ledger API, posting functions, schema, sharding and routing, idempotency, the outbox and CDC relay, invariant checks. The only team with write access to ledger databases." },
      { name: "Payments", owns: "Payment orchestration and its state machine, scheme connections (Faster Payments, Bacs, cards), status enquiries for unknown outcomes. Posts to the ledger through its API as a client." },
      { name: "Reconciliation and financial control", owns: "Statement and settlement file ingestion, matching, the break queue and correction workflow, safeguarding reconciliation, migration comparisons. Engineers working day to day with finance operations." },
      { name: "Platform (shared)", owns: "Postgres operations, backups and failover tooling, Kafka, object storage. The boundary that matters most is between ledger core and every product team: money moves only through the ledger API, and the ledger stays ignorant of rails and products." },
    ],

    buildBuy: [
      { part: "Posting engine and ledger API", call: "Build on Postgres", why: "Small, critical, and the rules are ours. Hosted ledgers such as Modern Treasury Ledgers put an outside API on every payment and add a supplier to oversee; Formance is an open-source alternative worth a look; core banking platforms such as Thought Machine Vault make sense only as part of a wider core replacement." },
      { part: "Database operations", call: "Buy managed Postgres if it meets recovery point zero, else run Patroni", why: "The team should spend its time on the ledger, not on failover scripts. The test is whether the managed service's failover can lose an acknowledged commit and whether we keep the settings we need." },
      { part: "Change data capture", call: "Buy (open source): Debezium on Kafka Connect", why: "Log-based CDC with ordering is hard to get right and Debezium is the standard. We own its configuration and the replication slot monitoring." },
      { part: "Event log", call: "Buy: managed Kafka (Amazon MSK or Confluent Cloud)", why: "About 1 MB a second is small. Nothing about it is ours to differentiate on." },
      { part: "Reconciliation", call: "Build the ledger-side matching; consider a vendor for finance-ops matching", why: "Invariant checks and ledger-to-bank matching depend on our model. Products such as Duco exist for wider matching across finance, which finance may already own." },
      { part: "Payment workflow", call: "Build a small state machine first", why: "A workflow engine such as Temporal is another system on the money path. Adopt it if the number of rails and states outgrows hand-written recovery workers." },
      { part: "Hot-account engine", call: "Do not build or buy yet", why: "Sub-accounts carry us at 10,000 a second. TigerBeetle is the named exit if contention dominates; the ledger API keeps that option open." },
    ],

    cost: [
      "Machines: 16 shards, each a primary, two synchronous standbys and one read replica: 64 database nodes. Assumption: £2,000 to £4,000 a month each with fast storage, so roughly £130,000 to £250,000 a month at full scale. The first version is three nodes, well under £15,000 a month.",
      "Storage: 65 GB a day of entries, 13 months hot is about 26 TB, 1.6 TB a shard. Four copies of each shard means about 100 TB provisioned, plus backups and write-ahead log. The archive grows about 24 TB a year before Parquet compression, cheap in object storage.",
      "Synchronous replication is the line item that buys recovery point zero: two standbys per shard rather than one doubles the standby bill, and is the right trade.",
      "Kafka is small: about 1 MB a second, under 100 GB a day. CDC and the relay are a few small machines.",
      "Headcount is the bigger cost and the bigger risk. Ledger core: five or six engineers. Reconciliation: three or four engineers alongside finance operations. Payments exists already. A share of a platform team for Postgres. Most of that is the same whether we run one shard or 16, which is why sharding waits for evidence.",
      "The cost of being wrong dominates both: an unreconciled safeguarding shortfall or a double-posted payroll run costs more in remediation and regulatory attention than a year of machines.",
    ],

    risks: [
      { risk: "A mapping or model error found after cut-over: balances right in aggregate, wrong per account.", answer: "Shadow-post for weeks with per-account comparison, cut over by cohort, keep reverse shadow for rollback. Finance signs off the chart of accounts before code is written." },
      { risk: "An unexpected hot account, such as a large customer receiving thousands of payments a second.", answer: "Lock wait per account on a dashboard with an alert. Sub-accounts work for any credit-heavy account, and a very large tenant can get its own shard." },
      { risk: "Regulatory: daily safeguarding reconciliation is missed or wrong during the migration.", answer: "Reconciliation is phase 2, before any cut-over, and runs across both ledgers. The safeguarding officer and auditors are briefed before the first cohort and see the break reports." },
      { risk: "Business rules in stored functions are hard to review and test.", answer: "Treat SQL as code: in the repository, reviewed, versioned functions deployed beside the old ones. Property tests that assert the invariants under concurrency, and a load test at 10,000 a second with hot accounts." },
      { risk: "Schema changes on 1.6 TB entries tables stall a shard.", answer: "Expand and contract only; monthly partitions from day one; rehearse each change on a restored copy of a full shard." },
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
        "What strict consistency means: no balance below its limit, money conserved, read sees the write.",
        "Load and skew: 1,000 a second average, 10,000 peak, and whether some accounts are in most transactions.",
        "Rails and currencies; whether a ledger already exists.",
        "Names the hard problem: one hot balance row, not total throughput.",
      ],
    },
    {
      stage: "Data model and invariants",
      minutes: 5,
      prompt: "Before any boxes, describe what is stored and the rules that must always hold.",
      cover: [
        "Accounts, transactions, entries; entries append-only; integer minor units with a currency.",
        "Each transaction sums to zero per currency; no balance below its limit under concurrency.",
        "Pending then posted or voided; available balance against ledger balance.",
        "Balance row as a cache of entries, updated in the same transaction.",
        "Corrections only by new entries, with who approved them.",
      ],
    },
    {
      stage: "Numbers",
      minutes: 4,
      prompt: "Do the sums that decide the architecture. Say which number matters most and why.",
      cover: [
        "86 million transactions a day, about 3 entries each, about 65 GB a day.",
        "13 months hot is about 26 TB; 16 shards at about 1.6 TB each.",
        "About 1,000 a shard at peak; 10 needed, 16 for headroom.",
        "One hot row: 500 to 1,000 writes a second. This is the number that matters.",
      ],
    },
    {
      stage: "Write path",
      minutes: 8,
      prompt: "Draw one payment from the app to a committed reservation and back, then to the scheme and to posted. Say what is in each step's transaction.",
      cover: [
        "Client-made idempotency key, reused on every retry.",
        "Payment service orchestrates; the ledger never talks to the scheme.",
        "One stored-function call: insert key, conditional balance updates in account order, entries, outbox row.",
        "Commit waits for one of two synchronous standbys in other zones.",
        "Timeout from the scheme is unknown: keep the hold, enquire, then post or void.",
        "Routing by business to a shard; house accounts on every shard.",
      ],
    },
    {
      stage: "Concurrency and hot accounts",
      minutes: 8,
      prompt: "Go deep on two payments racing for one balance, and on the account every payment touches. Compare the options before you pick.",
      cover: [
        "Conditional update with Read Committed re-check; why no gap between check and spend.",
        "Compared with SELECT FOR UPDATE, optimistic versions, serializable, single writer, TigerBeetle.",
        "Locks held for in-database time only, never across network round trips.",
        "Sub-accounts with sweeps; skip checks on credit-only accounts.",
        "Cross-shard transfers by saga through a clearing account, not two-phase commit.",
      ],
    },
    {
      stage: "Failure, events and reads",
      minutes: 6,
      prompt: "Break it. Walk through the failures an interviewer will pick and show what the customer sees in each.",
      cover: [
        "Primary dies: promote the synchronous standby, nothing lost, clients retry with keys.",
        "Both standbys lost: stop writes on that shard on purpose.",
        "Outbox and CDC, never dual write; Kafka down does not stop payments; watch the slot.",
        "Consumers deduplicate by log position; downstream is eventually consistent by design.",
        "Balance from the primary; statements from replicas with cursor pagination.",
      ],
    },
    {
      stage: "Proving it is right",
      minutes: 4,
      prompt: "Explain how you would know, every day, that the ledger is correct, and what happens when it is not.",
      cover: [
        "Internal invariant checks every few minutes.",
        "Daily reconciliation against bank statements and scheme reports; CASS 15 for safeguarded funds.",
        "Breaks with owner, amount, evidence; fixed by reviewed correcting transactions.",
        "Correctness as an SLO: zero unexplained breaks, time to detect.",
      ],
    },
    {
      stage: "Leading it",
      minutes: 5,
      prompt: "Step back from the diagram. Tell them how you would deliver it from where the company is today, and how you would run it.",
      cover: [
        "First version: one primary and a synchronous standby, in shadow, in a quarter.",
        "Reconciliation before cut-over; account-by-account cut-over with reverse shadow for rollback.",
        "Shard and adopt hot-account handling when measured, with written triggers; what not to build.",
        "One team owns the ledger; product teams post through the API only.",
        "What pages at 3am and the first runbooks; the main risks and answers.",
      ],
    },
  ],
};
