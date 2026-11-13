-- 1. accounts: the owner's table with three changes from the expert review
--    (hard_limit and the hard floor; status instead of
--    is_active; owner_account_id for a customer's receivable)
CREATE TABLE accounts (
    account_id UUID PRIMARY KEY,
    logical_account VARCHAR(50),          -- Chart-of-accounts group (NULL for customer accounts)
    shard_id INT NOT NULL DEFAULT 0,      -- 0 for unsharded customer accounts; 0..N-1 for sharded clearing/revenue accounts
    account_type VARCHAR(20) NOT NULL,    -- 'USER_WALLET', 'CREDIT_CARD', 'RECEIVABLE', 'CLEARING', 'NOSTRO', 'FX_POOL', 'REVENUE'
    owner_account_id UUID REFERENCES accounts(account_id), -- RECEIVABLE only: whose debt this is
    allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
    posted_balance BIGINT NOT NULL DEFAULT 0,
    held_balance   BIGINT NOT NULL DEFAULT 0,
    credit_limit   BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    hard_limit     BIGINT NOT NULL DEFAULT 0,  -- how far below zero postings the bank must accept may take it
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'NO_NEW_SPEND', 'CLOSED')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Hard floor: the soft limit (credit_limit) is tested when a customer
    -- starts a debit; postings the bank must accept may go this far past it
    CONSTRAINT valid_available_funds
        CHECK (allow_negative OR (posted_balance - held_balance) >= -hard_limit),
    CONSTRAINT hard_limit_covers_credit_limit
        CHECK (hard_limit >= credit_limit),
    CONSTRAINT valid_held_balance
        CHECK (held_balance >= 0),
    CONSTRAINT closed_means_empty
        CHECK (status <> 'CLOSED' OR (posted_balance = 0 AND held_balance = 0)),
    CONSTRAINT uq_logical_shard UNIQUE (logical_account, shard_id)
) WITH (fillfactor = 80);
CREATE UNIQUE INDEX uq_receivable_owner ON accounts (owner_account_id) WHERE account_type = 'RECEIVABLE';

-- 2. The owner's pending_holds and ledger_entries, unchanged
CREATE TABLE pending_holds (
    hold_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,          -- 'ACTIVE', 'CAPTURED', 'VOIDED', 'EXPIRED'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. New: one header row per transaction. Never partitioned, so its
--    primary key is the lasting duplicate guard.
CREATE TABLE ledger_transactions (
    transaction_id UUID PRIMARY KEY,      -- made by the caller from the request, not at random
    kind VARCHAR(30) NOT NULL,            -- 'FPS_OUT', 'CARD_SETTLEMENT', 'INTEREST', 'REVERSAL', ...
    external_ref TEXT,                    -- the scheme's or network's own id
    description TEXT NOT NULL,
    value_date DATE NOT NULL,
    reverses UUID REFERENCES ledger_transactions(transaction_id),
    hold_id UUID,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, external_ref)
);

CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(transaction_id),
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0), -- Positive = Credit, Negative = Debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id) -- Idempotency guard
);
CREATE INDEX idx_ledger_account_created ON ledger_entries (account_id, created_at DESC);

CREATE INDEX idx_holds_active_account ON pending_holds (account_id, expires_at) WHERE status = 'ACTIVE';
CREATE TABLE idempotency_keys (
    client_id TEXT NOT NULL, key TEXT NOT NULL,
    request_hash TEXT NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (client_id, key));
CREATE TABLE outbox (seq BIGSERIAL PRIMARY KEY, transaction_id UUID, hold_id UUID, account_id UUID NOT NULL, payload JSONB NOT NULL);

-- 4. Append-only journal and headers
CREATE FUNCTION append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();
CREATE TRIGGER ledger_transactions_no_change BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- 5. Entries move posted_balance. Only a CLOSED account refuses them.
CREATE FUNCTION apply_entry_to_posted() RETURNS trigger AS $$
BEGIN
  UPDATE accounts
     SET posted_balance = posted_balance + NEW.amount, updated_at = now()
   WHERE account_id = NEW.account_id AND currency = NEW.currency
     AND status <> 'CLOSED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry for % is in % but the account is not, or is closed', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_posted();

-- 6. Holds move held_balance. A new hold needs an OPEN account.
CREATE FUNCTION hold_placed() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a hold starts ACTIVE';
  END IF;
  UPDATE accounts
     SET held_balance = held_balance + NEW.amount, updated_at = now()
   WHERE account_id = NEW.account_id AND currency = NEW.currency
     AND status = 'OPEN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold for % is in % but the account is not, or takes no new spend', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_placed AFTER INSERT ON pending_holds
  FOR EACH ROW EXECUTE FUNCTION hold_placed();

CREATE FUNCTION hold_ended() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'an ACTIVE hold is ended, never deleted';
    END IF;
    RETURN OLD;                     -- the archive job removes ended holds
  END IF;
  IF OLD.status <> 'ACTIVE'
     OR NEW.status NOT IN ('CAPTURED', 'VOIDED', 'EXPIRED')
     OR (NEW.hold_id, NEW.account_id, NEW.amount, NEW.currency)
        IS DISTINCT FROM
        (OLD.hold_id, OLD.account_id, OLD.amount, OLD.currency) THEN
    RAISE EXCEPTION 'a hold changes once: ACTIVE to CAPTURED, VOIDED or EXPIRED';
  END IF;
  UPDATE accounts
     SET held_balance = held_balance - OLD.amount, updated_at = now()
   WHERE account_id = OLD.account_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_ended BEFORE UPDATE OR DELETE ON pending_holds
  FOR EACH ROW EXECUTE FUNCTION hold_ended();

-- 7. Balances change only through the triggers; accounts open at zero
CREATE FUNCTION accounts_guard_balances() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.posted_balance <> 0 OR NEW.held_balance <> 0 THEN
      RAISE EXCEPTION 'accounts open at zero';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.posted_balance IS DISTINCT FROM OLD.posted_balance
      OR NEW.held_balance IS DISTINCT FROM OLD.held_balance)
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'balances change only through ledger_entries and pending_holds';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balances();

-- 8. At COMMIT, once per transaction: at least two entries, and each
--    currency sums to zero
CREATE FUNCTION transaction_must_balance() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM ledger_entries
       WHERE transaction_id = NEW.transaction_id
         AND created_at = NEW.created_at) < 2
     OR EXISTS (SELECT 1 FROM ledger_entries
                 WHERE transaction_id = NEW.transaction_id
                   AND created_at = NEW.created_at
                 GROUP BY currency HAVING sum(amount) <> 0) THEN
    RAISE EXCEPTION 'transaction % does not sum to zero in every currency', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transaction_must_balance();
