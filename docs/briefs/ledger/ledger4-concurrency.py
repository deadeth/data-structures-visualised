import psycopg2, threading, time
DSN = "host=/tmp/pg4 port=54400 user=postgres dbname=postgres"
def conn(auto=False):
    c = psycopg2.connect(DSN); c.autocommit = auto; return c
def q(sql):
    c = conn(True); cur = c.cursor(); cur.execute(sql)
    try: r = cur.fetchall()
    except psycopg2.ProgrammingError: r = None
    c.close(); return r
W='5f0c2a9e-3d41-4b7e-8c12-000000081442'; CC='5f0c2a9e-3d41-4b7e-8c12-000000081444'
NOS='0a000000-0000-4000-8000-000000000001'; FPS='1c9d4e2a-7b10-4c55-9a01-000000000007'
q(f"""INSERT INTO accounts (account_id, logical_account, shard_id, account_type, allow_negative, credit_limit, hard_limit, currency) VALUES
 ('{W}',NULL,0,'USER_WALLET',false,0,0,'GBP'),('{CC}',NULL,0,'CREDIT_CARD',false,500000,550000,'GBP'),
 ('{NOS}','NOSTRO_BOE_GBP',0,'NOSTRO',true,0,0,'GBP'),('{FPS}','FPS_CLEARING_GBP',7,'CLEARING',true,0,0,'GBP')""")
def post(c, tid, rows, kind='T'):
    cur = c.cursor()
    cur.execute(f"INSERT INTO ledger_transactions (transaction_id, kind, description, value_date, created_by) VALUES ('{tid}','{kind}','t',current_date,'t')")
    cur.execute("INSERT INTO ledger_entries (transaction_id, account_id, amount, currency) VALUES " + ",".join(f"('{tid}','{a}',{m},'GBP')" for a, m in rows))
c = conn(); post(c, 'aaaaaaaa-0000-4000-8000-000000000001', [(NOS,-842000),(W,842000)]); c.commit(); c.close()
def bal(): return q(f"SELECT posted_balance, held_balance FROM accounts WHERE account_id='{W}'")[0]

print("== T1 capture vs void, both account-first, 200 rounds")
errs = {}; both = 0
for i in range(200):
    H = f"b61c9a3e-0f47-4d2a-8c55-{i:012d}"
    q(f"INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) VALUES ('{H}','{W}',100,'GBP','ACTIVE',now()+interval '7 days')")
    out = {}
    def capture():
        c = conn(); cur = c.cursor()
        try:
            cur.execute("SET LOCAL lock_timeout='50ms'")
            cur.execute(f"SELECT 1 FROM accounts WHERE account_id IN ('{W}','{FPS}') ORDER BY account_id FOR NO KEY UPDATE")
            cur.execute(f"UPDATE pending_holds SET status='CAPTURED' WHERE hold_id='{H}' AND status='ACTIVE'")
            if cur.rowcount == 1:
                post(c, f"cccccccc-0000-4000-8000-{i:012d}", [(W,-100),(FPS,100)])
            c.commit(); out['cap'] = cur.rowcount if False else 'ok'
        except Exception as e:
            c.rollback(); out['cap'] = getattr(e, 'pgcode', str(e))
        c.close()
    def void():
        c = conn(); cur = c.cursor()
        try:
            cur.execute("SET LOCAL lock_timeout='50ms'")
            cur.execute(f"SELECT 1 FROM accounts WHERE account_id='{W}' FOR NO KEY UPDATE")
            cur.execute(f"UPDATE pending_holds SET status='VOIDED' WHERE hold_id='{H}' AND status='ACTIVE'")
            c.commit(); out['void'] = 'ok'
        except Exception as e:
            c.rollback(); out['void'] = getattr(e, 'pgcode', str(e))
        c.close()
    ts = [threading.Thread(target=capture), threading.Thread(target=void)]
    [t.start() for t in ts]; [t.join() for t in ts]
    for k, v in out.items():
        if v != 'ok': errs[v] = errs.get(v, 0) + 1
st = q("SELECT status, count(*) FROM pending_holds GROUP BY 1 ORDER BY 1")
print(" errors:", errs, " statuses:", st, " wallet:", bal())
cap_n = dict(st).get('CAPTURED', 0)
print(" posted should be", 842000 - 100*cap_n, " entries for captures:", q("SELECT count(*) FROM ledger_transactions WHERE transaction_id::text LIKE 'cccccccc%'")[0][0])

print("== T2 expiry (one account per transaction, account first) vs wallet<->card repayments in id order, 3 s")
q(f"INSERT INTO pending_holds (hold_id, account_id, amount, currency, status, expires_at) SELECT gen_random_uuid(), (ARRAY['{W}','{CC}'])[1 + g % 2]::uuid, 1, 'GBP', 'ACTIVE', now() - interval '1 minute' FROM generate_series(1, 4000) g")
stop = time.time() + 3; errs2 = {}; n = {'exp': 0, 'pay': 0}
def expiry():
    while time.time() < stop:
        for a in (CC, W):
            c = conn(); cur = c.cursor()
            try:
                cur.execute("SET LOCAL lock_timeout='50ms'")
                cur.execute(f"SELECT 1 FROM accounts WHERE account_id='{a}' FOR NO KEY UPDATE")
                cur.execute(f"UPDATE pending_holds SET status='EXPIRED' WHERE hold_id IN (SELECT hold_id FROM pending_holds WHERE account_id='{a}' AND status='ACTIVE' AND expires_at < now() LIMIT 50)")
                n['exp'] += cur.rowcount; c.commit()
            except Exception as e:
                c.rollback(); k = getattr(e, 'pgcode', str(e)); errs2[k] = errs2.get(k, 0) + 1
            c.close()
def pay(j):
    i = 0
    while time.time() < stop:
        i += 1; c = conn(); cur = c.cursor()
        try:
            cur.execute("SET LOCAL lock_timeout='50ms'")
            cur.execute(f"SELECT 1 FROM accounts WHERE account_id IN ('{W}','{CC}') ORDER BY account_id FOR NO KEY UPDATE")
            post(c, f"dddddddd-000{j}-4000-8000-{i:012d}", [(W,-1),(CC,1)]); c.commit(); n['pay'] += 1
        except Exception as e:
            c.rollback(); k = getattr(e, 'pgcode', str(e)); errs2[k] = errs2.get(k, 0) + 1
        c.close()
ts = [threading.Thread(target=expiry)] + [threading.Thread(target=pay, args=(j,)) for j in range(3)]
[t.start() for t in ts]; [t.join() for t in ts]
print(" expired:", n['exp'], " repayments:", n['pay'], " errors (40P01 would be a deadlock):", errs2)
print(" cache mismatches:", q("""SELECT count(*) FROM accounts a LEFT JOIN (SELECT account_id, sum(amount) s FROM ledger_entries GROUP BY 1) e USING (account_id) LEFT JOIN (SELECT account_id, sum(amount) s FROM pending_holds WHERE status='ACTIVE' GROUP BY 1) h USING (account_id) WHERE a.posted_balance <> coalesce(e.s,0) OR a.held_balance <> coalesce(h.s,0)""")[0][0])

print("== T3 role-level statement_timeout applies to a function call")
q("CREATE ROLE ledger_writer LOGIN; ALTER ROLE ledger_writer SET statement_timeout='250ms'; ALTER ROLE ledger_writer SET lock_timeout='50ms'")
q("CREATE FUNCTION slow() RETURNS int AS $$ BEGIN PERFORM pg_sleep(1); RETURN 1; END $$ LANGUAGE plpgsql")
c = psycopg2.connect("host=/tmp/pg4 port=54400 user=ledger_writer dbname=postgres"); cur = c.cursor(); s = time.time()
try: cur.execute("SELECT slow()"); print(" finished?!")
except Exception as e: print(" cancelled after", round((time.time()-s)*1000), "ms:", e.pgcode)
c.close()
