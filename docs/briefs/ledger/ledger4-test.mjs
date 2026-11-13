import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
await db.exec(fs.readFileSync('ledger4-schema.sql', 'utf8'));
const q = async (s) => (await db.query(s)).rows;
const t = async (name, fn, x) => { try { const r = await fn(); console.log(x ? 'UNEXPECTED OK ' : 'ok  ', name, r === undefined ? '' : JSON.stringify(r)); } catch (e) { try { await db.exec('ROLLBACK'); } catch {} console.log(x ? 'ok (refused)' : 'FAIL', name, '->', e.message, e.code ?? ''); } };
const W='5f0c2a9e-3d41-4b7e-8c12-000000081442', CC='5f0c2a9e-3d41-4b7e-8c12-000000081444', RW='5f0c2a9e-3d41-4b7e-8c12-000000081449';
const NOS='0a000000-0000-4000-8000-000000000001', FPS='1c9d4e2a-7b10-4c55-9a01-000000000007', FEE='c2e85b71-90aa-4d3f-a6e4-000000000007';
const MCD='d41e7c90-6a2b-4f17-8e05-000000000007', MCC='d41e7c90-6a2b-4f17-8e05-000000000207', FXFEE='c2e85b71-90aa-4d3f-a6e4-000000000107', INT='c2e85b71-90aa-4d3f-a6e4-000000000207', INTR='c2e85b71-90aa-4d3f-a6e4-000000000307';
await t('account inserted with a balance', () => db.exec(`INSERT INTO accounts (account_id, account_type, currency, posted_balance) VALUES (gen_random_uuid(),'USER_WALLET','GBP',999)`), true);
await db.exec(`INSERT INTO accounts (account_id, logical_account, shard_id, account_type, allow_negative, credit_limit, hard_limit, currency) VALUES
 ('${W}', NULL, 0, 'USER_WALLET', false, 0, 0, 'GBP'), ('${CC}', NULL, 0, 'CREDIT_CARD', false, 500000, 550000, 'GBP'),
 ('${NOS}', 'NOSTRO_BOE_GBP', 0, 'NOSTRO', true, 0, 0, 'GBP'), ('${FPS}', 'FPS_CLEARING_GBP', 7, 'CLEARING', true, 0, 0, 'GBP'),
 ('${FEE}', 'FEE_REVENUE_GBP', 7, 'REVENUE', true, 0, 0, 'GBP'), ('${MCD}', 'MASTERCARD_DEBIT_CLEARING_GBP', 7, 'CLEARING', true, 0, 0, 'GBP'),
 ('${MCC}', 'MASTERCARD_CREDIT_CLEARING_GBP', 7, 'CLEARING', true, 0, 0, 'GBP'), ('${FXFEE}', 'FX_FEE_REVENUE_GBP', 7, 'REVENUE', true, 0, 0, 'GBP'),
 ('${INT}', 'INTEREST_INCOME_GBP', 7, 'REVENUE', true, 0, 0, 'GBP'), ('${INTR}', 'INTEREST_RECEIVABLE_GBP', 7, 'CLEARING', true, 0, 0, 'GBP');`);
const bal = async () => (await q(`SELECT coalesce(logical_account, account_type) a, posted_balance p, held_balance h FROM accounts WHERE posted_balance<>0 OR held_balance<>0 ORDER BY 1`)).map(r=>`${r.a}:${r.p}/${r.h}`).join('  ');
const T = (n) => `7d1f0a52-6c3e-4f8b-9e21-${String(n).padStart(12,'0')}`;
const post = (n, kind, rows, extra='') => `BEGIN; INSERT INTO ledger_transactions (transaction_id, kind, external_ref, description, value_date, created_by) VALUES ('${T(n)}','${kind}',${extra || 'NULL'},'test','2026-11-12','test');
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ${rows.map(r=>`('${T(n)}','${r[0]}',${r[1]},'GBP')`).join(',')}; COMMIT;`;
await t('incoming payment funds the wallet from the nostro', () => db.exec(post(900001,'FPS_IN',[[NOS,-842000],[W,842000]])).then(bal));
await t('replay of a transaction id: header refuses', () => db.exec(post(900001,'FPS_IN',[[NOS,-842000],[W,842000]])), true);
await t('same scheme reference under a new id: header refuses', async () => { await db.exec(post(900002,'CARD_SETTLEMENT',[[W,-100],[MCD,100]],`'MC-ARN-1'`)); await db.exec(post(900003,'CARD_SETTLEMENT',[[W,-100],[MCD,100]],`'MC-ARN-1'`)); }, true);
await t('entries without a header', () => db.exec(`INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('${T(1)}','${W}',-1,'GBP')`), true);
await t('unbalanced transaction fails at commit', () => db.exec(post(900004,'TEST',[[W,-5],[FEE,4]])), true);
await t('header with one entry fails at commit', async () => { await db.exec(`BEGIN; INSERT INTO ledger_transactions (transaction_id, kind, description, value_date, created_by) VALUES ('${T(900005)}','TEST','x','2026-11-12','t'); COMMIT;`); }, true);
await t('header update refused', () => db.exec(`UPDATE ledger_transactions SET description='y'`), true);
await t('truncate journal refused', () => db.exec(`TRUNCATE ledger_entries`), true);
// decline is remembered
await t('decline saved with its key and committed', async () => { await db.exec(`BEGIN; INSERT INTO idempotency_keys (client_id, key, request_hash) VALUES ('app','k9','h1') ON CONFLICT DO NOTHING;
 SELECT 1 FROM accounts WHERE account_id='${W}' FOR NO KEY UPDATE;
 WITH funded AS (SELECT 1 FROM accounts WHERE account_id='${W}' AND status='OPEN' AND posted_balance - held_balance - 99999999 >= -credit_limit)
 INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) SELECT gen_random_uuid(),'${W}',99999999,'GBP','ACTIVE',now() FROM funded;
 UPDATE idempotency_keys SET result='{"status":"INSUFFICIENT_FUNDS"}' WHERE client_id='app' AND key='k9'; COMMIT;`); return q(`SELECT result FROM idempotency_keys`); });
await t('same key from another client is a different key', () => db.exec(`INSERT INTO idempotency_keys (client_id, key, request_hash) VALUES ('partner','k9','h2')`).then(()=>undefined));
// credit card at its limit
await t('card spends to its limit', () => db.exec(post(900010,'CARD_SETTLEMENT',[[CC,-500000],[MCC,500000]])).then(bal));
await t('customer hold at the limit: conditional insert places nothing', async () => (await db.query(`WITH funded AS (SELECT 1 FROM accounts WHERE account_id='${CC}' AND status='OPEN' AND posted_balance - held_balance - 100 >= -credit_limit)
 INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) SELECT gen_random_uuid(),'${CC}',100,'GBP','ACTIVE',now() FROM funded`)).affectedRows);
await t('statement interest 250 and a 1200 late fee post past the limit', async () => { await db.exec(post(900011,'INTEREST_CHARGE',[[CC,-250],[INTR,250]])); await db.exec(post(900012,'LATE_FEE',[[CC,-1200],[FEE,1200]])); return bal(); });
await t('a debit past the hard floor is still refused', () => db.exec(post(900013,'CARD_SETTLEMENT',[[CC,-60000],[MCC,60000]])), true);
await t('past the hard floor: card to its floor, rest to this customer receivable', async () => { await db.exec(`INSERT INTO accounts (account_id, account_type, owner_account_id, allow_negative, currency) VALUES ('${RW}','RECEIVABLE','${CC}',true,'GBP')`);
 await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${CC}','${RW}','${MCC}') ORDER BY account_id FOR NO KEY UPDATE;
 INSERT INTO ledger_transactions (transaction_id, kind, external_ref, description, value_date, created_by) VALUES ('${T(900014)}','CARD_FORCE_POST','MC-ARN-2','force-post','2026-11-12','cards');
 WITH c AS (SELECT least(60000, posted_balance - held_balance + hard_limit) AS take FROM accounts WHERE account_id='${CC}')
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) SELECT '${T(900014)}', v.a, v.amt, 'GBP' FROM c, LATERAL (VALUES ('${CC}'::uuid, -c.take), ('${RW}'::uuid, -(60000 - c.take)), ('${MCC}'::uuid, 60000::bigint)) v(a, amt) WHERE v.amt <> 0; COMMIT;`); return bal(); });
await t('second receivable for the same owner refused', () => db.exec(`INSERT INTO accounts (account_id, account_type, owner_account_id, allow_negative, currency) VALUES (gen_random_uuid(),'RECEIVABLE','${CC}',true,'GBP')`), true);
// status
await t('limit cut below what is used is allowed; new holds then place nothing', async () => { await db.exec(`UPDATE accounts SET credit_limit=100000 WHERE account_id='${CC}'`); return (await db.query(`WITH funded AS (SELECT 1 FROM accounts WHERE account_id='${CC}' AND status='OPEN' AND posted_balance - held_balance - 1 >= -credit_limit) INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) SELECT gen_random_uuid(),'${CC}',1,'GBP','ACTIVE',now() FROM funded`)).affectedRows; });
await t('hard_limit below credit_limit refused', () => db.exec(`UPDATE accounts SET hard_limit=50 WHERE account_id='${CC}'`), true);
await t('NO_NEW_SPEND: hold refused', async () => { await db.exec(`UPDATE accounts SET status='NO_NEW_SPEND' WHERE account_id='${CC}'`); await db.exec(`INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) VALUES (gen_random_uuid(),'${CC}',1,'GBP','ACTIVE',now())`); }, true);
await t('NO_NEW_SPEND: repayment still posts, clearing the receivable first', async () => { await db.exec(post(900015,'REPAYMENT',[[W,-30000],[RW,11450],[CC,18550]])); return bal(); });
await t('close an account that still owes', () => db.exec(`UPDATE accounts SET status='CLOSED' WHERE account_id='${CC}'`), true);
// force-post larger than a live hold on a wallet
const H='b61c9a3e-0f47-4d2a-8c55-000000000520';
await t('settlement 9000 against a live hold of 8240: hold ends and entries post together', async () => { await db.exec(`INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) VALUES ('${H}','${W}',8240,'GBP','ACTIVE',now()+interval '7 days')`);
 await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${W}','${MCD}','${FXFEE}') ORDER BY account_id FOR NO KEY UPDATE;
 INSERT INTO ledger_transactions (transaction_id, kind, external_ref, description, value_date, hold_id, created_by) VALUES ('${T(900521)}','CARD_SETTLEMENT','MC-ARN-3','USD 100.00 ACME','2026-11-12','${H}','cards');
 UPDATE pending_holds SET status='CAPTURED' WHERE hold_id='${H}' AND status='ACTIVE';
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('${T(900521)}','${W}',-9000,'GBP'),('${T(900521)}','${MCD}',8911,'GBP'),('${T(900521)}','${FXFEE}',89,'GBP'); COMMIT;`); return bal(); });
await t('ended hold can be deleted by the archive job, active cannot', async () => { await db.exec(`DELETE FROM pending_holds WHERE hold_id='${H}'`); await db.exec(`INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) VALUES ('${H}','${W}',5,'GBP','ACTIVE',now())`); try { await db.exec(`DELETE FROM pending_holds WHERE hold_id='${H}'`); return 'ACTIVE DELETED?!'; } catch (e) { return 'active refused: ' + e.message; } });
await t('void locks the account first', () => db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id='${W}' FOR NO KEY UPDATE; UPDATE pending_holds SET status='VOIDED' WHERE hold_id='${H}' AND status='ACTIVE'; COMMIT;`).then(bal));
await t('daily interest accrual touches no customer account', () => db.exec(post(900020,'INTEREST_ACCRUAL',[[INTR,-32],[INT,32]])).then(bal));
await t('settle the scheme: clearing to nostro', () => db.exec(post(900021,'FPS_SETTLEMENT',[[FPS,-0+1],[NOS,-1]])).then(()=>undefined));
await t('posted balances sum to zero', () => q(`SELECT sum(posted_balance)::bigint s FROM accounts`));
await t('cache equals journal', async () => (await q(`SELECT a.account_id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount) s FROM ledger_entries GROUP BY 1) e USING (account_id) LEFT JOIN (SELECT account_id, sum(amount) s FROM pending_holds WHERE status='ACTIVE' GROUP BY 1) h USING (account_id) WHERE a.posted_balance <> coalesce(e.s,0) OR a.held_balance <> coalesce(h.s,0)`)).length);
// payroll timing: 5001 entries, once-per-transaction check
await t('payroll 5,001 entries commit time (ms)', async () => { await db.exec(`INSERT INTO accounts (account_id, account_type, currency) SELECT gen_random_uuid(),'USER_WALLET','GBP' FROM generate_series(1,5000)`); const s=Date.now();
 await db.exec(`BEGIN; INSERT INTO ledger_transactions (transaction_id, kind, description, value_date, created_by) VALUES ('${T(900030)}','PAYROLL','run','2026-11-27','payroll');
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) SELECT '${T(900030)}', account_id, 100, 'GBP' FROM accounts WHERE account_type='USER_WALLET' AND account_id <> '${W}';
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('${T(900030)}','${W}',-500000,'GBP'); COMMIT;`); return Date.now()-s; });
