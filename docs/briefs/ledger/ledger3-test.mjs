import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
await db.exec(fs.readFileSync('ledger3-schema.sql', 'utf8'));
const q = async (s) => (await db.query(s)).rows;
const t = async (name, fn, expectFail) => { try { const r = await fn(); console.log(expectFail ? 'UNEXPECTED OK ' : 'ok  ', name, r === undefined ? '' : JSON.stringify(r)); } catch (e) { try { await db.exec('ROLLBACK'); } catch {} console.log(expectFail ? 'ok (refused)' : 'FAIL', name, '->', e.message, e.code ?? ''); } };
const W='5f0c2a9e-3d41-4b7e-8c12-000000081442', CC='5f0c2a9e-3d41-4b7e-8c12-000000081444', FUND='0a000000-0000-4000-8000-000000000001';
const MCC='d41e7c90-6a2b-4f17-8e05-000000000207', INT='c2e85b71-90aa-4d3f-a6e4-000000000207', RCV='e7000000-0000-4000-8000-000000000007';
await db.exec(`INSERT INTO accounts (account_id, logical_account, shard_id, account_type, allow_negative, credit_limit, currency) VALUES
 ('${W}', NULL, 0, 'USER_WALLET', false, 0, 'GBP'), ('${CC}', NULL, 0, 'CREDIT_CARD', false, 500000, 'GBP'),
 ('${FUND}', 'SAFEGUARDING_GBP', 0, 'CLEARING', true, 0, 'GBP'),
 ('${MCC}', 'MASTERCARD_CREDIT_CLEARING_GBP', 7, 'CLEARING', true, 0, 'GBP'), ('${INT}', 'INTEREST_INCOME_GBP', 7, 'REVENUE', true, 0, 'GBP'),
 ('${RCV}', 'CUSTOMER_RECEIVABLE_GBP', 7, 'CLEARING', true, 0, 'GBP');`);
const bal = async () => (await q(`SELECT coalesce(logical_account, account_type) a, posted_balance p, held_balance h, posted_balance - held_balance + credit_limit av FROM accounts WHERE posted_balance<>0 OR held_balance<>0 OR credit_limit<>0 ORDER BY 1`)).map(r=>`${r.a}:${r.p}/${r.h} avail ${r.av}`).join('  ');
const tx = (id, rows) => `BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ${rows.map(r=>`('7d1f0a52-6c3e-4f8b-9e21-${id}','${r[0]}',${r[1]},'GBP')`).join(',')}; COMMIT;`;
const hold = (id, acct, amt) => `WITH funded AS (SELECT 1 FROM accounts WHERE account_id='${acct}' AND posted_balance - held_balance - ${amt} >= -credit_limit)
 INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) SELECT 'b61c9a3e-0f47-4d2a-8c55-${id}','${acct}',${amt},'GBP','ACTIVE', now() + interval '7 days' FROM funded`;
await t('fund wallet', () => db.exec(tx('000000900001', [[FUND,-842000],[W,842000]])).then(bal));
await t('negative credit_limit refused', () => db.exec(`UPDATE accounts SET credit_limit=-1 WHERE account_id='${CC}'`), true);
await t('credit card: hold 64900 with zero posted', async () => [(await db.query(hold('000000000610', CC, 64900))).affectedRows, await bal()]);
await t('credit card: hold beyond remaining credit inserts 0', async () => (await db.query(hold('000000000611', CC, 435101))).affectedRows);
await t('credit card: hold exactly remaining credit inserts 1 then void', async () => { const n=(await db.query(hold('000000000612', CC, 435100))).affectedRows; await db.exec(`UPDATE pending_holds SET status='VOIDED' WHERE hold_id='b61c9a3e-0f47-4d2a-8c55-000000000612'`); return n; });
await t('credit card: capture', async () => { await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${CC}','${MCC}') ORDER BY account_id FOR NO KEY UPDATE;
 WITH done AS (UPDATE pending_holds SET status='CAPTURED' WHERE hold_id='b61c9a3e-0f47-4d2a-8c55-000000000610' AND status='ACTIVE' RETURNING 1)
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) SELECT '7d1f0a52-6c3e-4f8b-9e21-000000900611', v.a::uuid, v.amt, 'GBP' FROM (VALUES ('${CC}',-64900::bigint),('${MCC}',64900::bigint)) v(a,amt), done; COMMIT;`); return bal(); });
await t('nightly interest 32p', () => db.exec(tx('000000900612', [[CC,-32],[INT,32]])).then(bal));
await t('repayment 30000 from wallet restores credit', () => db.exec(tx('000000900613', [[W,-30000],[CC,30000]])).then(bal));
await t('wallet (limit 0) still cannot go negative', () => db.exec(tx('000000900614', [[W,-900000],[CC,900000]])), true);
await t('force-post past the credit limit: plain debit refused', () => db.exec(tx('000000900615', [[CC,-470000],[MCC,470000]])), true);
await t('direct edit of credit_limit by owner role allowed (guard covers balances only)', () => db.exec(`UPDATE accounts SET credit_limit=600000 WHERE account_id='${CC}'`).then(bal));
await t('lower limit below what is used is refused by CHECK', () => db.exec(`UPDATE accounts SET credit_limit=100 WHERE account_id='${CC}'`), true);
await t('overpayment leaves card in credit', () => db.exec(tx('000000900616', [[W,-50000],[CC,50000]])).then(bal));
