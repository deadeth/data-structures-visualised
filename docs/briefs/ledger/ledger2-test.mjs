import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
await db.exec(fs.readFileSync('ledger2-schema.sql', 'utf8'));
const q = async (s) => (await db.query(s)).rows;
const t = async (name, fn, expectFail) => { try { const r = await fn(); console.log(expectFail ? 'UNEXPECTED OK ' : 'ok  ', name, r === undefined ? '' : JSON.stringify(r)); } catch (e) { try { await db.exec('ROLLBACK'); } catch {} console.log(expectFail ? 'ok (refused)' : 'FAIL', name, '->', e.message, e.code ?? ''); } };
const W='5f0c2a9e-3d41-4b7e-8c12-000000081442', WU='5f0c2a9e-3d41-4b7e-8c12-000000081443';
const FPS='1c9d4e2a-7b10-4c55-9a01-000000000007', FEE='c2e85b71-90aa-4d3f-a6e4-000000000007', FUND='0a000000-0000-4000-8000-000000000001';
const FXG='3b7a1f64-58c2-4d0e-9f31-000000000007', FXU='3b7a1f64-58c2-4d0e-9f31-000000000107', FXFEE='c2e85b71-90aa-4d3f-a6e4-000000000107', MC='d41e7c90-6a2b-4f17-8e05-000000000107', RCV='e7000000-0000-4000-8000-000000000007';
await db.exec(`INSERT INTO accounts (account_id, logical_account, shard_id, account_type, allow_negative, currency) VALUES
 ('${W}', NULL, 0, 'USER_WALLET', false, 'GBP'), ('${WU}', NULL, 0, 'USER_WALLET', false, 'USD'),
 ('${FUND}', 'SAFEGUARDING_GBP', 0, 'CLEARING', true, 'GBP'),
 ('${FPS}', 'FPS_CLEARING_GBP', 7, 'CLEARING', true, 'GBP'), ('${FEE}', 'FEE_REVENUE_GBP', 7, 'REVENUE', true, 'GBP'),
 ('${FXG}', 'FX_POOL_GBP', 7, 'FX_POOL', true, 'GBP'), ('${FXU}', 'FX_POOL_USD', 7, 'FX_POOL', true, 'USD'),
 ('${FXFEE}', 'FX_FEE_REVENUE_GBP', 7, 'REVENUE', true, 'GBP'), ('${MC}', 'MASTERCARD_CLEARING_USD', 7, 'CLEARING', true, 'USD'),
 ('${RCV}', 'CUSTOMER_RECEIVABLE_GBP', 7, 'CLEARING', true, 'GBP');`);
const bal = async () => (await q(`SELECT coalesce(logical_account, 'wallet '||currency) a, posted_balance p, held_balance h FROM accounts WHERE posted_balance<>0 OR held_balance<>0 ORDER BY 1`)).map(r=>`${r.a}:${r.p}/${r.h}`).join('  ');
await t('two wallets, NULL logical_account, same shard_id 0 allowed', async () => (await q(`SELECT count(*)::int c FROM accounts WHERE logical_account IS NULL`))[0].c);
await t('fund wallet 842000', () => db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900001','${FUND}',-842000,'GBP'),('7d1f0a52-6c3e-4f8b-9e21-000000900001','${W}',842000,'GBP'); COMMIT;`).then(bal));
// bank payment: hold
const hold = (id, amt, cur='GBP', acct=W) => `WITH funded AS (SELECT 1 FROM accounts WHERE account_id='${acct}' AND posted_balance - held_balance >= ${amt})
 INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) SELECT '${id}','${acct}',${amt},'${cur}','ACTIVE', now() + interval '7 days' FROM funded`;
const H1='b61c9a3e-0f47-4d2a-8c55-000000000417';
await t('hold 120020 (lock, conditional insert)', async () => { await db.exec(`BEGIN; SET LOCAL lock_timeout='50ms'; SET LOCAL statement_timeout='250ms'; SELECT 1 FROM accounts WHERE account_id='${W}' FOR NO KEY UPDATE;`); const r = await db.query(hold(H1,120020)); await db.exec('COMMIT'); return [r.affectedRows, await bal()]; });
await t('hold more than available inserts 0 rows', async () => (await db.query(hold('b61c9a3e-0f47-4d2a-8c55-000000000999', 721981))).affectedRows);
await t('hold without the pre-check hits CHECK', () => db.exec(`INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) VALUES ('b61c9a3e-0f47-4d2a-8c55-000000000998','${W}',721981,'GBP','ACTIVE',now())`), true);
await t('hold in wrong currency', () => db.exec(`INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) VALUES ('b61c9a3e-0f47-4d2a-8c55-000000000997','${W}',5,'USD','ACTIVE',now())`), true);
await t('direct UPDATE held_balance', () => db.exec(`UPDATE accounts SET held_balance = 0 WHERE account_id='${W}'`), true);
await t('direct UPDATE posted_balance', () => db.exec(`UPDATE accounts SET posted_balance = 1 WHERE account_id='${W}'`), true);
await t('direct UPDATE is_active allowed', () => db.exec(`UPDATE accounts SET is_active = true WHERE account_id='${W}'`).then(()=>undefined));
// capture
const cap = (h, txn, rows) => `BEGIN; SELECT 1 FROM accounts WHERE account_id IN (${rows.map(r=>`'${r[0]}'`).join(',')}) ORDER BY account_id FOR NO KEY UPDATE;
 WITH done AS (UPDATE pending_holds SET status='CAPTURED' WHERE hold_id='${h}' AND status='ACTIVE' RETURNING 1)
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) SELECT '${txn}', v.a::uuid, v.amt, v.cur FROM (VALUES ${rows.map(r=>`('${r[0]}',${r[1]}::bigint,'${r[2]}')`).join(',')}) AS v(a,amt,cur), done; COMMIT;`;
await t('capture hold and post 3 entries', () => db.exec(cap(H1,'7d1f0a52-6c3e-4f8b-9e21-000000900418',[[W,-120020,'GBP'],[FPS,120000,'GBP'],[FEE,20,'GBP']])).then(bal));
await t('capture again: 0 entries', async () => { await db.exec(cap(H1,'7d1f0a52-6c3e-4f8b-9e21-000000900499',[[W,-120020,'GBP'],[FPS,120000,'GBP'],[FEE,20,'GBP']])); return [(await q(`SELECT count(*)::int c FROM ledger_entries WHERE transaction_id='7d1f0a52-6c3e-4f8b-9e21-000000900499'`))[0].c, await bal()]; });
await t('void a captured hold directly', () => db.exec(`UPDATE pending_holds SET status='VOIDED' WHERE hold_id='${H1}'`), true);
await t('delete a hold', () => db.exec(`DELETE FROM pending_holds WHERE hold_id='${H1}'`), true);
await t('change a hold amount', async () => { await db.query(hold('b61c9a3e-0f47-4d2a-8c55-000000000500', 100)); await db.exec(`UPDATE pending_holds SET amount=1, status='VOIDED' WHERE hold_id='b61c9a3e-0f47-4d2a-8c55-000000000500'`); }, true);
await t('void an active hold', () => db.exec(`UPDATE pending_holds SET status='VOIDED' WHERE hold_id='b61c9a3e-0f47-4d2a-8c55-000000000500' AND status='ACTIVE'`).then(bal));
// card: USD 100.00 at auth rate 0.80 + 3% buffer = 8240 hold
const H2='b61c9a3e-0f47-4d2a-8c55-000000000520';
await t('card auth hold 8240', async () => { const r = await db.query(hold(H2, 8240)); return [r.affectedRows, await bal()]; });
await t('card settle with FX: 5 entries, two currencies', () => db.exec(cap(H2,'7d1f0a52-6c3e-4f8b-9e21-000000900521',[[W,-7979,'GBP'],[FXG,7900,'GBP'],[FXFEE,79,'GBP'],[FXU,-10000,'USD'],[MC,10000,'USD']])).then(bal));
await t('mixed currency that nets to zero overall but not per currency', () => db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900600','${FXG}',-100,'GBP'),('7d1f0a52-6c3e-4f8b-9e21-000000900600','${FXU}',100,'USD'); COMMIT;`), true);
await t('entry in the wrong currency for its account', () => db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900601','${W}',-100,'USD'),('7d1f0a52-6c3e-4f8b-9e21-000000900601','${FXU}',100,'USD'); COMMIT;`), true);
await t('update an entry', () => db.exec(`UPDATE ledger_entries SET amount = 1`), true);
await t('replay a transaction id', () => db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900418','${W}',-1,'GBP'),('7d1f0a52-6c3e-4f8b-9e21-000000900418','${FPS}',1,'GBP'); COMMIT;`), true);
// force-post beyond funds: wallet has ~714001; force post 800000
await t('force-post more than the wallet holds: plain debit refused by CHECK', () => db.exec(`BEGIN; INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900700','${W}',-800000,'GBP'),('7d1f0a52-6c3e-4f8b-9e21-000000900700','${FXG}',800000,'GBP'); COMMIT;`), true);
await t('force-post split: wallet to zero, rest to receivable', async () => { await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${W}','${FXG}','${RCV}') ORDER BY account_id FOR NO KEY UPDATE;
 WITH w AS (SELECT least(800000, posted_balance - held_balance) AS take FROM accounts WHERE account_id='${W}')
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency)
 SELECT '7d1f0a52-6c3e-4f8b-9e21-000000900701', v.a, v.amt, 'GBP' FROM w, LATERAL (VALUES ('${W}'::uuid, -w.take), ('${RCV}'::uuid, -(800000 - w.take)), ('${FXG}'::uuid, 800000::bigint)) AS v(a, amt) WHERE v.amt <> 0; COMMIT;`); return bal(); });
await t('all posted balances sum to zero per currency', () => q(`SELECT currency, sum(posted_balance)::bigint s FROM accounts GROUP BY currency`));
await t('cache equals journal and holds: mismatches', async () => (await q(`SELECT a.account_id FROM accounts a
 LEFT JOIN (SELECT account_id, sum(amount) s FROM ledger_entries GROUP BY 1) e USING (account_id)
 LEFT JOIN (SELECT account_id, sum(amount) s FROM pending_holds WHERE status='ACTIVE' GROUP BY 1) h USING (account_id)
 WHERE a.posted_balance <> coalesce(e.s,0) OR a.held_balance <> coalesce(h.s,0)`)).length);
await t('expiry sweep', async () => { await db.query(hold('b61c9a3e-0f47-4d2a-8c55-000000000800', 1)); await db.exec(`UPDATE pending_holds SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at < now() + interval '8 days'`); return bal(); });
