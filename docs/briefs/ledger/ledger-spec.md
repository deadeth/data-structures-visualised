# Ledger redesign: append-only entries with a trigger-maintained balance cache

The owner has asked for the ledger design page to move from "a balance row updated by a conditional statement in a stored function" to the design below. He has an interview on this tomorrow. Everything on the page and in its interview extras must be revised to match: the diagram's box text, the components, connections, their examples (DDL, SQL, events), alternatives and ways, numbers and their working, the tour (text, story, explain), decisions, failure drills, glossary, framings and sources where they are affected.

## The owner's design (his words, binding)

1. Core architecture and rationale
- Immutability: `ledger_entries` is strictly append-only (a `BEFORE UPDATE OR DELETE` trigger blocks all mutations).
- Materialised balance cache: `accounts` stores the current `balance` in minor units (`BIGINT`, pence) with `fillfactor = 80` to help PostgreSQL HOT updates.
- Trigger synchronisation: an `AFTER INSERT` trigger on `ledger_entries` atomically updates `accounts.balance` inside the same ACID transaction, while a `BEFORE UPDATE` guard trigger (`pg_trigger_depth() <= 1`) on `accounts` blocks direct manual edits to `balance`.
- Overdraft enforcement: at the database level via `CHECK (allow_negative OR balance >= 0)` on `accounts`, so customer wallets stay at or above zero while system and settlement accounts can go negative.
- Scalability: separating the mutable balance cache from the append-only journal lets `ledger_entries` be partitioned by date and archived to cold storage without slowing balance checks.

2. Target tables: exactly as in /tmp/alts/ledger-schema.sql (the `accounts` and `ledger_entries` definitions there are his, character for character; show them that way).

3. Concurrency, locking and distributed pattern
- Reads: standard `SELECT`, non-blocking MVCC snapshots.
- Writes: conditional transfers lock the involved `accounts` rows in deterministic `account_id ASC` order using `FOR NO KEY UPDATE` (no deadlocks, no races), check `balance >= amount`, and conditionally insert the paired double-entry rows (`SUM(amount) = 0`) in one CTE.
- Hot-account scaling: shard high-throughput system and clearing accounts (for example `CARD_CLEARING_01..16`) to avoid row-lock contention.
- External rails and distributed consistency: the transactional outbox pattern and pending/settled state transitions, not database-level two-phase commit, so row locks are held for about 1 to 2 ms and never across a network call.

## What the coordinator has verified (PostgreSQL 18 via PGlite; script /tmp/alts/ledger-test.mjs)
Everything in /tmp/alts/ledger-schema.sql runs, and these behave as stated:
- A direct `UPDATE accounts SET balance = ...` is refused by the guard; a direct update of another column is allowed; the trigger's own update passes. The guard works because the check is INSIDE the trigger function, where a direct update is at depth 1 and the entry trigger's update is at depth 2. In a trigger's WHEN clause a direct statement is at depth 0, so the same `<= 1` test there would also block the entry trigger. Say this on the page.
- `UPDATE` and `DELETE` on `ledger_entries` are refused.
- The reserve and settle statements below leave every `accounts.balance` equal to the sum of its entries.
- Inserting the same `transaction_id` again fails on the UNIQUE constraint (SQLSTATE 23505).
- An overdraft that skips the pre-check fails on `valid_balance` (23514). The CTE's pre-check inserts zero rows instead, which is the clean "insufficient funds" path; the CHECK is the backstop.
- A transaction whose entries do not sum to zero fails at COMMIT (the deferred constraint trigger).
- IMPORTANT, a real limit: PostgreSQL refuses to partition `ledger_entries` by `created_at` with the keys as written: "unique constraint on partitioned table must include all partitioning columns". Partitioned, the keys become `PRIMARY KEY (entry_id, created_at)` and `UNIQUE (transaction_id, account_id, created_at)`, and that UNIQUE no longer stops a replay that carries a different `created_at`. So in the partitioned form the idempotency guard that holds across partitions is the `idempotency_keys` table; the UNIQUE is a second guard within a partition. Present this honestly as a trade-off and a likely interview push. Show his DDL first, then the partitioned variant.

## Decisions the coordinator has made where his spec is silent (state them on the page as this design's choices)
1. Keep what the page already has around the database: 16 Postgres shards keyed by business, a primary with synchronous standbys, the Ledger API, the outbox read by Debezium, Kafka `ledger-events`, reconciliation, the archive, the sweeper. Sharding by business is how the system reaches 10,000 a second; partitioning by date is how one shard's journal stays small. Both are true; do not confuse them.
2. Idempotency: keep the `idempotency_keys` table (key, transaction_id, result, kept 72 hours) inserted first in the same transaction with `ON CONFLICT DO NOTHING`. `UNIQUE (transaction_id, account_id)` is the database's own second guard, as he says.
3. Pending and settled, with an append-only journal: an entry is never updated, so "pending" cannot be a status column on an entry. A payment is two balanced transactions:
   - Reserve: debit the customer's wallet, credit a pending clearing account (`FPS_PENDING_nn`). The wallet's `balance` drops at once, so `balance` IS the available balance, and the money visibly sits in clearing while the scheme decides.
   - Settle (scheme accepted): debit `FPS_PENDING_nn`, credit `FPS_SETTLEMENT_nn` and `FEE_INCOME_nn`.
   - Reverse (scheme rejected or timed out and confirmed failed): debit `FPS_PENDING_nn`, credit the wallet back.
   The payment's state (PENDING, SETTLED, FAILED) lives on the Banking API's payment record, which already owns the workflow; the ledger shows it as where the money is. `FPS_PENDING` not being zero for long is the signal that something is stuck.
4. Signed amounts: positive is a credit, negative is a debit, in pence; an account's `balance` is the sum of its entries. `allow_negative` is true for settlement and funding accounts and false for customer wallets, pending clearing and revenue.
5. Hot accounts: each shard has its own house accounts, each split into 16 (not 32): `FPS_PENDING_01..16`, `FPS_SETTLEMENT_01..16`, `FEE_INCOME_01..16`, picked by hashing the transaction id. The sweeper still moves each sub-account's total into the main account every minute with an ordinary balanced transaction. Redo the numbers from the page's own inputs: one shard peaks at about 1,000 payments a second (the page's assumption), one row takes an estimated 500 to 1,000 writes a second, so one house row per shard would sit at its limit; 16 sub-accounts take about 60 a second each. (This also fixes an inconsistency a reviewer found: the old text divided the whole bank's 10,000 a second across one account.) Revenue accounts are never checked for overdraft but are still locked by the trigger's UPDATE, which is why they are split.
6. A deferred constraint trigger (`ledger_entries_balanced`) checks at COMMIT that a transaction's entries sum to zero. It is the coordinator's addition, a backstop to "insert the pair in one CTE". Say it is optional and what it costs (one small query per inserted row at commit).
7. The trigger costs something: one extra UPDATE per entry inside the same transaction, logic that lives in the database where application developers may not look, and bulk loads that fire it row by row. A statement-level trigger with a transition table is the alternative for bulk work. Put this in the trade-offs.
8. `FOR NO KEY UPDATE`, not `FOR UPDATE`: inserting an entry takes a `FOR KEY SHARE` lock on the referenced `accounts` row for the foreign key; `FOR UPDATE` conflicts with that and `FOR NO KEY UPDATE` does not, and the balance update itself is a no-key update. (General PostgreSQL behaviour; list it as worth checking.)
9. The previous chosen design ("conditional update of a balance row in the same transaction") becomes one of the alternatives, described fairly, with why the owner now prefers the trigger and CHECK (the database refuses a wrong balance whatever code path writes; nobody can forget the update; nobody can edit a balance by hand).

## The canonical example (use these values everywhere, in both files)
Bright Bakery pays a supplier £1,200.00 by Faster Payments with a 20p fee; idempotency key `k7`; payment `pay_3fK9`; sub-account 07 of 16 (picked by hashing the reserve's transaction id).
```
FPS_PENDING_07     1c9d4e2a-7b10-4c55-9a01-0000000000a7   CLEARING     allow_negative false
Bright Bakery      5f0c2a9e-3d41-4b7e-8c12-000000081442   USER_WALLET  allow_negative false   balance 842000
FPS_SETTLEMENT_07  9a4b6d10-22f3-4e08-b7c9-0000000000b7   SETTLEMENT   allow_negative true
FEE_INCOME_07      c2e85b71-90aa-4d3f-a6e4-0000000000c7   REVENUE      allow_negative false
reserve  transaction 7d1f0a52-6c3e-4f8b-9e21-000000900417   key k7
settle   transaction 7d1f0a52-6c3e-4f8b-9e21-000000900418   key k7:settle
```
Lock order is `account_id ASC`, so the reserve locks `1c9d...` (pending) then `5f0c...` (bakery).

Reserve (verified):
```sql
BEGIN;
INSERT INTO idempotency_keys (key, transaction_id)
VALUES ('k7', '7d1f0a52-6c3e-4f8b-9e21-000000900417')
ON CONFLICT (key) DO NOTHING;
-- 0 rows: k7 was seen; return its saved result and stop

SELECT account_id, balance FROM accounts
 WHERE account_id IN ('5f0c2a9e-...081442', '1c9d4e2a-...0000a7')
 ORDER BY account_id
   FOR NO KEY UPDATE;

WITH funded AS (
  SELECT 1 FROM accounts
   WHERE account_id = '5f0c2a9e-...081442' AND balance >= 120020
)
INSERT INTO ledger_entries (transaction_id, account_id, amount)
SELECT '7d1f0a52-...900417', v.account_id::uuid, v.amount
  FROM (VALUES ('5f0c2a9e-...081442', -120020::bigint),
               ('1c9d4e2a-...0000a7',  120020::bigint)) AS v(account_id, amount),
       funded;
-- 0 rows inserted: not enough money; ROLLBACK and answer "insufficient funds"
-- 2 rows: the AFTER INSERT trigger has moved both balances

INSERT INTO outbox (transaction_id, account_id, payload) VALUES (...);
UPDATE idempotency_keys SET result = ... WHERE key = 'k7';
COMMIT;   -- returns once a synchronous standby has the log record
```
After reserve: bakery 721980, FPS_PENDING_07 120020. After settle: FPS_PENDING_07 0, FPS_SETTLEMENT_07 +120000, FEE_INCOME_07 +20. Settle inserts three entries (-120020, +120000, +20) under transaction ...900418 after locking those three rows in id order; it needs no funds check because the pending account holds exactly the reserve.

On screen, UUIDs may be shortened with "..." inside a block only where a line would pass 72 characters; give each one in full at least once in the block.

## Rules for the rewrite
- Plain British English, short sentences, no em dashes, concrete numbers. Keep the page's existing structure and every kind of content it now has (do not drop a field type that exists: `what`/`pros`/`cons` on alternatives, `ways` and `examples` on flows, `{ text, from }` numbers, `story` and `explain` on steps, `built` on components).
- Every statement about PostgreSQL that is not in the verified list above is from your own knowledge: keep to what you are sure of, and list each such claim in your report (HOT updates and fillfactor, lock modes, MVCC wording, partition detach and archive, Debezium behaviour).
- Do not contradict the facts the page already had checked against sources (Faster Payments, CHAPS, Modern Treasury and Stripe figures, TigerBeetle). Where an old figure depended on the old design (32 sub-accounts, 300 writes a second each, "pending" on the balance row, `available` as a generated column, numeric account ids 81442, 2017, 3017, txn 900417 as an integer), replace it everywhere. Search the file for every one of those and leave none behind.
- No git commands. Edit only the file named in your prompt.
