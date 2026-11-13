import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
await db.exec(fs.readFileSync('ledger5-schema.sql', 'utf8'));
const q = async (s) => (await db.query(s)).rows;
const t = async (name, fn, x) => { try { const r = await fn(); console.log(x ? 'UNEXPECTED OK ' : 'ok  ', name, r === undefined ? '' : JSON.stringify(r)); } catch (e) { try { await db.exec('ROLLBACK'); } catch {} console.log(x ? 'ok (refused)' : 'FAIL', name, '->', e.message, e.code ?? ''); } };
const CC='5f0c2a9e-3d41-4b7e-8c12-000000081444', W='5f0c2a9e-3d41-4b7e-8c12-000000081442', MCC='d41e7c90-6a2b-4f17-8e05-000000000207', NOS='0a000000-0000-4000-8000-000000000001', FEE='c2e85b71-90aa-4d3f-a6e4-000000000007', INTR='c2e85b71-90aa-4d3f-a6e4-000000000307';
const AUTH='a17c0de5-2b6f-4e19-9d03-000000000610', H='b61c9a3e-0f47-4d2a-8c55-000000000610', T='7d1f0a52-6c3e-4f8b-9e21-000000900611';
await db.exec(`INSERT INTO accounts (account_id, logical_account, shard_id, account_type, allow_negative, credit_limit, hard_limit, currency) VALUES
 ('${W}',NULL,0,'USER_WALLET',false,0,0,'GBP'),('${CC}',NULL,0,'CREDIT_CARD',false,500000,550000,'GBP'),('${NOS}','NOSTRO_BOE_GBP',0,'NOSTRO',true,0,0,'GBP'),
 ('${MCC}','MASTERCARD_CREDIT_CLEARING_GBP',7,'CLEARING',true,0,0,'GBP'),('${FEE}','FEE_REVENUE_GBP',7,'REVENUE',true,0,0,'GBP'),('${INTR}','INTEREST_RECEIVABLE_GBP',7,'CLEARING',true,0,0,'GBP')`);
const bal = async () => (await q(`SELECT coalesce(logical_account, account_type) a, posted_balance p, held_balance h FROM accounts WHERE posted_balance<>0 OR held_balance<>0 ORDER BY 1`)).map(r=>`${r.a}:${r.p}/${r.h}`).join('  ');
const placeHold = `BEGIN; SELECT 1 FROM accounts WHERE account_id='${CC}' FOR NO KEY UPDATE;
 WITH funded AS (SELECT 1 FROM accounts WHERE account_id='${CC}' AND status='OPEN' AND posted_balance - held_balance - 64900 >= -credit_limit),
 placed AS (INSERT INTO pending_holds (hold_id, account_id, source_type, source_id, amount, currency, expires_at)
   SELECT '${H}','${CC}','CARD_AUTH','${AUTH}',64900,'GBP', now() + interval '7 days' FROM funded
   ON CONFLICT (source_type, source_id) DO NOTHING RETURNING hold_id)
 INSERT INTO outbox_events (event_type, aggregate_id, account_id, payload) SELECT 'HoldPlaced', hold_id, '${CC}', '{}' FROM placed; COMMIT;`;
await t('PlaceHold(idempotency_key = auth_id)', () => db.exec(placeHold).then(bal));
await t('PlaceHold retried with the same auth_id: nothing new', async () => { await db.exec(placeHold.replace(H, 'b61c9a3e-0f47-4d2a-8c55-000000000999')); return [await bal(), (await q(`SELECT count(*)::int c FROM pending_holds`))[0].c, (await q(`SELECT count(*)::int c FROM outbox_events`))[0].c]; });
const settle = (t, key, amt) => `BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${CC}','${MCC}') ORDER BY account_id FOR NO KEY UPDATE;
 UPDATE pending_holds SET status='CAPTURED' WHERE source_type='CARD_AUTH' AND source_id='${AUTH}' AND status='ACTIVE';
 WITH hdr AS (INSERT INTO transactions (transaction_id, idempotency_key, transaction_type, merchant_name, merchant_category_code, reference_id)
   VALUES ('${t}','${key}','CARD_PURCHASE','NORTHERN OVENS LTD','5046','${H}') ON CONFLICT (idempotency_key) DO NOTHING RETURNING transaction_id)
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) SELECT hdr.transaction_id, v.a::uuid, v.amt, 'GBP' FROM hdr, (VALUES ('${CC}',-${amt}::bigint),('${MCC}',${amt}::bigint)) v(a,amt);
 INSERT INTO outbox_events (event_type, aggregate_id, account_id, payload) SELECT 'TransactionPosted','${t}','${CC}','{}' WHERE EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id='${t}' AND created_at = now()); COMMIT;`;
await t('SettleCardTransaction: hold CAPTURED, header + 2 entries, TransactionPosted', () => db.exec(settle(T,'settle:'+AUTH,64900)).then(bal));
await t('clearing message redelivered (same idempotency_key, new id): posts nothing', async () => { await db.exec(settle('7d1f0a52-6c3e-4f8b-9e21-000000900999','settle:'+AUTH,64900)); return [await bal(), (await q(`SELECT count(*)::int c FROM transactions`))[0].c, (await q(`SELECT event_type, count(*)::int c FROM outbox_events GROUP BY 1 ORDER BY 1`))]; });
await t('header: direct status change refused', () => db.exec(`UPDATE transactions SET status='REVERSED'`), true);
await t('header: merchant edit refused', () => db.exec(`UPDATE transactions SET merchant_name='x'`), true);
await t('reversal posts and flips the original to REVERSED', async () => { await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${CC}','${MCC}') ORDER BY account_id FOR NO KEY UPDATE;
 INSERT INTO transactions (transaction_id, idempotency_key, transaction_type, reference_id) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900650','reverse:${T}','REVERSAL','${T}');
 INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900650','${CC}',64900,'GBP'),('7d1f0a52-6c3e-4f8b-9e21-000000900650','${MCC}',-64900,'GBP'); COMMIT;`); return [await bal(), await q(`SELECT transaction_type, status FROM transactions ORDER BY created_at`)]; });
await t('reversing it twice refused', () => db.exec(`BEGIN; INSERT INTO transactions (transaction_id, idempotency_key, transaction_type, reference_id) VALUES (gen_random_uuid(),'reverse2','REVERSAL','${T}'); COMMIT;`), true);
// late force-post after expiry
const A2='a17c0de5-2b6f-4e19-9d03-000000000620';
await t('hold expires, then the clearing arrives: posts with no release', async () => {
  await db.exec(`INSERT INTO pending_holds (hold_id, account_id, source_type, source_id, amount, currency, expires_at) VALUES (gen_random_uuid(),'${CC}','CARD_AUTH','${A2}',5000,'GBP', now() - interval '1 day')`);
  await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id='${CC}' FOR NO KEY UPDATE; UPDATE pending_holds SET status='EXPIRED' WHERE hold_id IN (SELECT hold_id FROM pending_holds WHERE account_id='${CC}' AND status='ACTIVE' AND expires_at < now() LIMIT 50); COMMIT;`);
  const before = await bal();
  await db.exec(`BEGIN; SELECT 1 FROM accounts WHERE account_id IN ('${CC}','${MCC}') ORDER BY account_id FOR NO KEY UPDATE;
   UPDATE pending_holds SET status='CAPTURED' WHERE source_type='CARD_AUTH' AND source_id='${A2}' AND status='ACTIVE';
   INSERT INTO transactions (transaction_id, idempotency_key, transaction_type) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900621','settle:${A2}','CARD_PURCHASE');
   INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES ('7d1f0a52-6c3e-4f8b-9e21-000000900621','${CC}',-5000,'GBP'),('7d1f0a52-6c3e-4f8b-9e21-000000900621','${MCC}',5000,'GBP'); COMMIT;`);
  return [before, await bal(), await q(`SELECT status FROM pending_holds WHERE source_id='${A2}'`)]; });
await t('parity: ACTIVE holds vs approved auths; posted txns by reference', async () => q(`SELECT (SELECT count(*)::int FROM pending_holds WHERE status='ACTIVE') active_holds, (SELECT count(*)::int FROM transactions WHERE status='POSTED' AND transaction_type='CARD_PURCHASE') posted`));
await t('caches equal journal and holds', async () => (await q(`SELECT a.account_id FROM accounts a LEFT JOIN (SELECT account_id, sum(amount) s FROM ledger_entries GROUP BY 1) e USING (account_id) LEFT JOIN (SELECT account_id, sum(amount) s FROM pending_holds WHERE status='ACTIVE' GROUP BY 1) h USING (account_id) WHERE a.posted_balance <> coalesce(e.s,0) OR a.held_balance <> coalesce(h.s,0)`)).length);
