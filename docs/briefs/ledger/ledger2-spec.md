# Ledger redesign, second pass: multi-currency, posted and held balances, pending_holds

The owner has sent a fuller specification, in /tmp/alts/ledger2-owner-spec.txt. Read it first; it is binding and it replaces the earlier one where they differ. He has a systems design interview at a UK business bank tomorrow. The ledger design page (src/designs/ledger.ts) and its interview extras (src/designs/extras/ledger.ts) were rewritten this afternoon to his FIRST spec (single `balance`, pending as money parked in an `FPS_PENDING_nn` clearing account, per-minute sweeper, single currency). Both must now move to the new spec.

## What changes from this afternoon's version
- The page is now a central multi-currency ledger serving bank payments, payroll, card authorisations and settlements, and multi-currency accounts.
- `accounts` has `posted_balance` and `held_balance`, plus `logical_account`, `shard_id`, `is_active`. Available = posted - held.
- Pending money is a row in `pending_holds` (ACTIVE, then CAPTURED, VOIDED or EXPIRED), not entries through a pending clearing account. `ledger_entries` holds settled movements only. The `FPS_PENDING_nn` accounts and the reserve/settle/reverse-as-entries model go.
- Every entry and hold carries `currency`; a transaction sums to zero per currency.
- System accounts are named by rail and currency and split by `shard_id` 0..15 with `allow_negative = TRUE` (his words). Sweeps are end-of-day batch jobs, not every minute.
- Timeouts: `lock_timeout = '50ms'`, `statement_timeout = '250ms'`. Queues (Kafka/SQS) absorb spikes. Outbox, not 2PC.
- Scale path in phases ending in TigerBeetle.

## Verified by the coordinator on PostgreSQL 18 (PGlite)
Schema and triggers: /tmp/alts/ledger2-schema.sql. Test: /tmp/alts/ledger2-test.mjs. The three tables in section 1 of the schema file are the owner's, character for character; show them that way (a long line may be wrapped, say so in the note). Everything in sections 2 to 7 is this design's addition to make his rules true; say which is which. All of this ran and behaved as stated:
- NULL `logical_account` rows do not collide on `uq_logical_shard`, so many wallets with shard_id 0 are fine.
- Hold: lock the wallet FOR NO KEY UPDATE, then a conditional insert into pending_holds (a CTE that returns a row only if posted - held >= amount). 1 row placed: the trigger raises held_balance. 0 rows: insufficient funds. Skipping the pre-check: `valid_available_balance` refuses (23514).
- A hold or entry in a currency other than its account's is refused by the trigger (the UPDATE matches on account_id AND currency AND is_active, and raises if no row).
- Direct UPDATE of posted_balance or held_balance: refused by the guard. Direct UPDATE of another column: allowed. The guard test sits inside the function (direct statement is depth 1 there; a trigger's own update is depth 2). In a WHEN clause a direct statement is depth 0.
- Capture is one statement: `WITH done AS (UPDATE pending_holds SET status='CAPTURED' WHERE hold_id=$1 AND status='ACTIVE' RETURNING 1) INSERT INTO ledger_entries ... SELECT ... FROM (VALUES ...) v, done;` So the hold ends and the entries post together, or neither. A second capture of the same hold updates 0 rows and inserts 0 entries. This also closes a gap in this afternoon's version (nothing in the ledger stopped both a settle and a reverse): a hold leaves ACTIVE exactly once, enforced by the hold trigger.
- A hold cannot be deleted, cannot change amount/account/currency, and cannot leave a terminal state.
- Card settlement with FX in one transaction, five entries, two currencies, each summing to zero.
- A transaction that sums to zero overall but not per currency fails at COMMIT (deferred constraint trigger; optional backstop, coordinator's addition).
- Entries cannot be updated or deleted. Replaying a transaction id fails on the UNIQUE (23505).
- A force-post larger than the wallet's available money: a plain debit is refused by the CHECK (wallets have allow_negative FALSE). The design's answer (coordinator's choice, say so): take what is available from the wallet and book the shortfall to `CUSTOMER_RECEIVABLE_GBP` (allow_negative TRUE), money the customer now owes, with the wallet at zero; verified as one balanced transaction.
- Check query: every `posted_balance` equals the sum of the account's entries and every `held_balance` equals the sum of its ACTIVE holds; all posted balances sum to zero per currency.
- Still true from this afternoon (verified then): `ledger_entries` cannot be partitioned by `created_at` with his keys ("unique constraint on partitioned table must include all partitioning columns"); partitioned keys become `PRIMARY KEY (entry_id, created_at)` and `UNIQUE (transaction_id, account_id, created_at)`, which no longer stops a replay with another created_at, so `idempotency_keys` is the guard across partitions. Triggers, FK and the constraint trigger all work on the partitioned parent. `account_period_totals` plus hot entries reconcile after DETACH CONCURRENTLY and DROP. `SET LOCAL session_replication_role = replica` skips the guard (the break-glass route).

## Coordinator's decisions where his spec is silent (state them on the page as this design's choices)
1. Two meanings of "shard". His `shard_id` splits one hot system account into 16 rows. The page also had 16 Postgres clusters split by business. Keep both ideas but never call the second one a shard: call them "ledger clusters" (rename the diagram's "Ledger shard x 16" group to "Ledger cluster" wording of similar length). Fit them to his phases: Phase 1 is one cluster (primary, synchronous standbys, read replicas, PgBouncer in transaction mode, month partitions, split system accounts). Phase 2 is the same design pushed to his "~5,000 to 8,000 TPS" (his estimate; label it as an estimate) and, when one primary is no longer enough, more clusters split by business, each with its own set of system accounts. Phase 3 moves the hot debit/credit path to TigerBeetle with PostgreSQL kept for metadata, KYC, search and reporting. The page's stated load (1,000 payments a second average, 10,000 peak) stays as the requirement the phases are measured against; redo every figure from the new model and show the working. Keep the diagram's boxes and positions; change labels only where needed.
2. Money in flight, per product:
   - Bank payment out (Faster Payments; the tour's followed example): hold on the wallet, send to the scheme, then capture the hold and post entries (wallet -120020, `FPS_CLEARING_GBP` shard 7 +120000, `FEE_REVENUE_GBP` shard 7 +20), or void the hold if the scheme rejects. A void posts nothing: the journal never saw the payment.
   - Card: authorisation is a hold of the quoted amount plus an FX buffer; settlement captures it and posts per-currency entries; an unanswered hold expires (a job sets EXPIRED where expires_at has passed, using the partial index).
   - Payroll: one transaction that debits the employer's wallet once and credits `BACS_CLEARING_GBP` (or each employee wallet when they bank here); `UNIQUE (transaction_id, account_id)` means an account appears once per transaction, so a run paying one account twice must net it or use two transactions. Say this.
   - Incoming payment: one balanced transaction, no hold.
3. Sign convention: positive is a credit, negative is a debit; a wallet's positive balance is money the bank owes the customer. All posted balances in one currency sum to zero. System accounts have allow_negative TRUE as he says; note the consequence (the CHECK no longer protects them, so limits on them are reconciliation's job).
4. Idempotency: keep `idempotency_keys` (72 hours), inserted first in the same transaction; for holds, the `hold_id` primary key is itself the guard (derive it from the request); `UNIQUE (transaction_id, account_id)` is the journal's own second guard.
5. FX: the customer's GBP wallet pays `FX_POOL_GBP`; `FX_POOL_USD` pays `MASTERCARD_CLEARING_USD`. The two pool accounts drift apart (long GBP, short USD); treasury rebalances them with a real FX trade, booked as its own balanced transaction per currency. The rate used lives on the transaction's metadata (the payments service's record and the outbox event), not in `ledger_entries`. No account ever holds two currencies.
6. Timeouts: `SET LOCAL lock_timeout = '50ms'; SET LOCAL statement_timeout = '250ms'` at the start of each write transaction (SET LOCAL so it survives PgBouncer transaction pooling). A timeout is a retryable failure with the same idempotency key; the queue in front holds the backlog. Card authorisations cannot queue (the network wants an answer in about 2 seconds), so they fail fast or fall to stand-in rules; payroll and payouts can queue.
7. Sweeps: end of day, per logical account: lock the 16 rows and the master (shard_id... the master is its own logical account, e.g. `FEE_REVENUE_GBP_MASTER`, since `uq_logical_shard` gives each logical account exactly rows 0..15) in account_id order, one balanced transaction. Because system rows may go negative, the sweep is bookkeeping, not a safety need.
8. The balance-check, archive and break-glass material from this afternoon stays, extended to holds.
9. The first design (single balance, pending through a clearing account) and the original one (conditional update of a balance row) become alternatives, described fairly.

## Canonical example (use these values everywhere, in both files)
Bright Bakery, GBP wallet `5f0c2a9e-3d41-4b7e-8c12-000000081442` (allow_negative false), posted 842000, held 0. USD wallet `5f0c2a9e-3d41-4b7e-8c12-000000081443` exists to show one row per currency.
System rows used (all shard_id 7 = hash(transaction_id) % 16, allow_negative true):
```
FPS_CLEARING_GBP         1c9d4e2a-7b10-4c55-9a01-000000000007  CLEARING
FEE_REVENUE_GBP          c2e85b71-90aa-4d3f-a6e4-000000000007  REVENUE
FX_POOL_GBP              3b7a1f64-58c2-4d0e-9f31-000000000007  FX_POOL
FX_POOL_USD              3b7a1f64-58c2-4d0e-9f31-000000000107  FX_POOL
FX_FEE_REVENUE_GBP       c2e85b71-90aa-4d3f-a6e4-000000000107  REVENUE
MASTERCARD_CLEARING_USD  d41e7c90-6a2b-4f17-8e05-000000000107  CLEARING
CUSTOMER_RECEIVABLE_GBP  e7000000-0000-4000-8000-000000000007  CLEARING
```
A. Bank payment (the tour): £1,200.00 to a supplier by Faster Payments, 20p fee, idempotency key `k7`, payment `pay_3fK9`.
 - Hold `b61c9a3e-0f47-4d2a-8c55-000000000417`, 120020, expires in 7 days. After: posted 842000, held 120020, available 721980.
 - Capture, transaction `7d1f0a52-6c3e-4f8b-9e21-000000900418`, key `k7:capture`: wallet -120020, FPS_CLEARING_GBP +120000, FEE_REVENUE_GBP +20. After: posted 721980, held 0.
 - Or void (key `k7:void`): held back to 0, posted still 842000, no entries.
B. Card: the bakery buys USD 100.00 online. Authorisation quotes 0.80 GBP per USD = 8000, plus a 3% FX buffer = hold of 8240 (hold `b61c9a3e-0f47-4d2a-8c55-000000000520`). Two days later it settles at 0.79: 7900 plus a 1% FX fee of 79. Transaction `7d1f0a52-6c3e-4f8b-9e21-000000900521`: GBP wallet -7979, FX_POOL_GBP +7900, FX_FEE_REVENUE_GBP +79; FX_POOL_USD -10000, MASTERCARD_CLEARING_USD +10000. The hold of 8240 is released in the same statement; the 261 difference is simply free again. (Rates and percentages are illustrative; say so.)
C. Force-post: a settlement arrives larger than the hold, or with no hold. If the wallet can pay, it is an ordinary posting. If it cannot, the shortfall goes to CUSTOMER_RECEIVABLE_GBP.

## Rules for the rewrite
- Plain British English, short sentences, no em dashes, concrete numbers. Keep every kind of content the file has (alternatives with what/pros/cons, ways, examples, `{ text, from }` numbers, story and explain on steps, built on components). Code lines at most 72 characters, blocks at most about 25 lines; split long ones into parts.
- Everything about PostgreSQL, PgBouncer, TigerBeetle or card networks that is not in the verified list is from your own knowledge: keep to what you are sure of and list each claim in your report. Known from the coordinator's reading of TigerBeetle's own docs and blog today: it is meant to sit beside a general-purpose database (data plane beside control plane); there is no shared transaction, so the application orders its writes ("write last, read first", with TigerBeetle as system of record in their example); transfer ids act as idempotency keys; it has change data capture to AMQP. Two-phase (pending, then post or void) transfers are from memory, unverified.
- Search for and remove every leftover of this afternoon's model unless it is deliberately described as an alternative: `FPS_PENDING`, `FPS_SETTLEMENT`, `FEE_INCOME`, "reserve" as a ledger transaction, "settle" as moving money out of pending, `k7:settle`, `k7:reverse`, `...900417` as a reserve transaction, `...900419`, the per-minute sweeper, `balance` as the single column, "125 writes a second on each pending part", "five entries per payment / two ledger transactions per payment" (a bank payment is now one hold write, one hold update and three entries in one ledger transaction: redo volumes, storage, event rates and write rates per row from that and show the working).
- No git commands. Edit only the file named in your prompt.
