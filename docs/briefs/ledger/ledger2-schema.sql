-- 1. The owner's three tables, as given
CREATE TABLE accounts (
    account_id UUID PRIMARY KEY,
    logical_account VARCHAR(50),          -- Chart-of-accounts group (NULL for customer wallets)
    shard_id INT NOT NULL DEFAULT 0,      -- 0 for unsharded wallets; 0..N-1 for sharded clearing/revenue accounts
    account_type VARCHAR(20) NOT NULL,    -- 'USER_WALLET', 'CLEARING', 'FX_POOL', 'REVENUE'
    allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
    posted_balance BIGINT NOT NULL DEFAULT 0,
    held_balance   BIGINT NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_available_balance CHECK (allow_negative OR (posted_balance - held_balance) >= 0),
    CONSTRAINT valid_held_balance CHECK (held_balance >= 0),
    CONSTRAINT uq_logical_shard UNIQUE (logical_account, shard_id)
) WITH (fillfactor = 80);

CREATE TABLE pending_holds (
    hold_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,          -- 'ACTIVE', 'CAPTURED', 'VOIDED', 'EXPIRED'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0), -- Positive = Credit, Negative = Debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id) -- Idempotency guard
);

CREATE INDEX idx_ledger_account_created ON ledger_entries (account_id, created_at DESC);

-- 2. Beside them (this design's additions)
CREATE INDEX idx_holds_active_expiry ON pending_holds (expires_at) WHERE status = 'ACTIVE';
CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, transaction_id UUID NOT NULL, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE outbox (seq BIGSERIAL PRIMARY KEY, transaction_id UUID NOT NULL, account_id UUID NOT NULL, payload JSONB NOT NULL);

-- 3. The journal is append-only
CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

-- 4. Each entry moves posted_balance, and must be in the account's currency
CREATE FUNCTION apply_entry_to_posted() RETURNS trigger AS $$
BEGIN
  UPDATE accounts
     SET posted_balance = posted_balance + NEW.amount, updated_at = now()
   WHERE account_id = NEW.account_id AND currency = NEW.currency AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry for % is in % but the account is not, or is closed', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_posted();

-- 5. Holds move held_balance: up when a hold is placed, down when it ends
CREATE FUNCTION hold_placed() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a hold starts ACTIVE';
  END IF;
  UPDATE accounts
     SET held_balance = held_balance + NEW.amount, updated_at = now()
   WHERE account_id = NEW.account_id AND currency = NEW.currency AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold for % is in % but the account is not, or is closed', NEW.account_id, NEW.currency;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pending_holds_placed AFTER INSERT ON pending_holds
  FOR EACH ROW EXECUTE FUNCTION hold_placed();

CREATE FUNCTION hold_ended() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds are ended, never deleted';
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

-- 6. Nobody edits a balance by hand
CREATE FUNCTION accounts_guard_balances() RETURNS trigger AS $$
BEGIN
  IF (NEW.posted_balance IS DISTINCT FROM OLD.posted_balance
      OR NEW.held_balance IS DISTINCT FROM OLD.held_balance)
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'balances change only through ledger_entries and pending_holds';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balances();

-- 7. Optional backstop: at COMMIT, each currency of a transaction sums to zero
CREATE FUNCTION entries_must_balance() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_entries
              WHERE transaction_id = NEW.transaction_id
              GROUP BY currency HAVING sum(amount) <> 0) THEN
    RAISE EXCEPTION 'transaction % does not sum to zero in every currency', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION entries_must_balance();
