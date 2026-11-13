import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const db = new PGlite();
await db.exec(fs.readFileSync('ledger-schema.sql', 'utf8'));
const B = '5f0c2a9e-3d41-4b7e-8c12-000000081442', P = '1c9d4e2a-7b10-4c55-9a01-0000000000a7', S = '9a4b6d10-22f3-4e08-b7c9-0000000000b7', F = 'c2e85b71-90aa-4d3f-a6e4-0000000000c7', FUND = '00000000-0000-4000-8000-00000000f00d';
const T0 = '7d1f0a52-6c3e-4f8b-9e21-000000900400', T1 = '7d1f0a52-6c3e-4f8b-9e21-000000900417', T2 = '7d1f0a52-6c3e-4f8b-9e21-000000900418', T3 = '7d1f0a52-6c3e-4f8b-9e21-000000900419';
const ok = async (name, fn) => { try { const r = await fn(); console.log('OK  ', name, r ?? ''); } catch (e) { console.log('ERR ', name, '->', e.message, e.code ?? ''); } };
await db.exec(`INSERT INTO accounts (account_id, account_type, allow_negative, currency) VALUES
 ('${B}','USER_WALLET',false,'GBP'),('${P}','CLEARING',false,'GBP'),('${S}','SETTLEMENT',true,'GBP'),('${F}','REVENUE',false,'GBP'),('${FUND}','SETTLEMENT',true,'GBP')`);
await ok('fund bakery 842000', async () => { await db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ('${T0}','${FUND}',-842000),('${T0}','${B}',842000); COMMIT;`); return (await db.query(`SELECT balance FROM accounts WHERE account_id='${B}'`)).rows[0].balance; });
await ok('direct balance edit is blocked', () => db.exec(`UPDATE accounts SET balance = 1 WHERE account_id='${B}'`));
await ok('direct non-balance edit allowed', () => db.exec(`UPDATE accounts SET account_type = 'USER_WALLET' WHERE account_id='${B}'`));
await ok('update entry blocked', () => db.exec(`UPDATE ledger_entries SET amount = 1`));
await ok('delete entry blocked', () => db.exec(`DELETE FROM ledger_entries`));
const reserve = (txn, key, amount) => `
BEGIN;
INSERT INTO idempotency_keys (key, transaction_id) VALUES ('${key}', '${txn}') ON CONFLICT (key) DO NOTHING;
SELECT account_id, balance FROM accounts WHERE account_id IN ('${B}', '${P}') ORDER BY account_id FOR NO KEY UPDATE;
WITH funded AS (SELECT 1 FROM accounts WHERE account_id = '${B}' AND balance >= ${amount})
INSERT INTO ledger_entries (transaction_id, account_id, amount)
SELECT '${txn}', v.account_id::uuid, v.amount FROM (VALUES ('${B}', -${amount}::bigint), ('${P}', ${amount}::bigint)) AS v(account_id, amount), funded;
COMMIT;`;
await ok('reserve 120020', async () => { await db.exec(reserve(T1, 'k7', 120020)); return JSON.stringify((await db.query(`SELECT account_type, balance FROM accounts ORDER BY account_id`)).rows); });
await ok('settle', async () => { await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${P}','${S}','${F}') ORDER BY account_id FOR NO KEY UPDATE; INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ('${T2}','${P}',-120020),('${T2}','${S}',120000),('${T2}','${F}',20); COMMIT;`); return JSON.stringify((await db.query(`SELECT account_type, balance FROM accounts ORDER BY account_id`)).rows); });
await ok('same txn again hits UNIQUE', async () => { try { await db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ('${T2}','${P}',-120020),('${T2}','${S}',120020); COMMIT;`); } catch (e) { await db.exec('ROLLBACK'); throw e; } });
await ok('overdraft without pre-check hits CHECK', async () => { try { await db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ('${T3}','${B}',-9999999),('${T3}','${P}',9999999); COMMIT;`); } catch (e) { await db.exec('ROLLBACK'); throw e; } });
await ok('unbalanced txn fails at commit', async () => { try { await db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ('${T3}','${B}',-100),('${T3}','${P}',90); COMMIT;`); } catch (e) { await db.exec('ROLLBACK'); throw e; } });
await ok('conditional reserve with too little money inserts 0 rows', async () => { await db.exec(reserve(T3, 'k8', 99999999)); return (await db.query(`SELECT count(*) FROM ledger_entries WHERE transaction_id='${T3}'`)).rows[0].count; });
await ok('balance equals sum of entries', async () => JSON.stringify((await db.query(`SELECT a.account_type, a.balance, coalesce(sum(e.amount),0) AS entries FROM accounts a LEFT JOIN ledger_entries e USING (account_id) GROUP BY 1,2, a.account_id ORDER BY a.account_id`)).rows));
await ok('partition by date with the given PK', () => db.exec(`CREATE TABLE le_p (entry_id BIGSERIAL PRIMARY KEY, transaction_id UUID NOT NULL, account_id UUID NOT NULL, amount BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (transaction_id, account_id)) PARTITION BY RANGE (created_at)`));
await ok('partition by date with created_at in the keys', () => db.exec(`CREATE TABLE le_p2 (entry_id BIGSERIAL, transaction_id UUID NOT NULL, account_id UUID NOT NULL, amount BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (entry_id, created_at), UNIQUE (transaction_id, account_id, created_at)) PARTITION BY RANGE (created_at)`));
await ok('WHEN-clause depth for a direct update', async () => { await db.exec(`CREATE TABLE d (x int); CREATE TABLE dlog (depth int); CREATE FUNCTION dl() RETURNS trigger AS $$ BEGIN INSERT INTO dlog VALUES (pg_trigger_depth()); RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER d1 BEFORE INSERT ON d FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION dl(); INSERT INTO d VALUES (1);`); return JSON.stringify((await db.query('SELECT * FROM dlog')).rows); });
console.log((await db.query('SELECT version()')).rows[0].version);
