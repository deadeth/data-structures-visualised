-- 1. accounts: the owner's table with the changes the expert review forced
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
    source_type VARCHAR(25) NOT NULL,     -- 'CARD_AUTH', 'OUTBOUND_PAYMENT', 'PAYROLL_BATCH', 'FX_SPOT'
    source_id UUID NOT NULL,              -- Points to card_authorisations.auth_id or payment_id
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'CAPTURED', 'VOIDED', 'EXPIRED'
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_type, source_id)
);


-- 3. The owner's journal header. Never partitioned: its two unique keys
--    are the lasting duplicate guards.
CREATE TABLE transactions (
    transaction_id UUID PRIMARY KEY,
    idempotency_key VARCHAR(100) NOT NULL UNIQUE,
    transaction_type VARCHAR(30) NOT NULL,        -- 'CARD_PURCHASE', 'CASH_ADVANCE', 'CARD_REPAYMENT', 'FX_CONVERSION', 'INTEREST_CHARGE', 'PAYROLL'
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED', -- 'POSTED', 'REVERSED'
    merchant_name VARCHAR(255),
    merchant_category_code CHAR(4),
    source_currency CHAR(3),
    target_currency CHAR(3),
    fx_rate NUMERIC(18, 8),
    reference_id UUID,                            -- Links to hold_id or original transaction_id
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES transactions(transaction_id),
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0), -- Positive = Credit, Negative = Debit
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id) -- Idempotency guard
);
CREATE INDEX idx_ledger_account_created ON ledger_entries (account_id, created_at DESC);

CREATE INDEX idx_holds_active_account ON pending_holds (account_id, expires_at) WHERE status = 'ACTIVE';
CREATE TABLE outbox_events (
    event_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(40) NOT NULL,      -- 'HoldPlaced', 'HoldExpired', 'TransactionPosted', ...
    aggregate_id UUID NOT NULL,           -- hold_id or transaction_id
    account_id UUID NOT NULL,             -- the Kafka key: one row per customer account touched
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- 4. Append-only journal and headers
CREATE FUNCTION append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();
CREATE FUNCTION transactions_immutable() RETURNS trigger AS $$
BEGIN
  -- The one change allowed: POSTED to REVERSED, made by the posting of
  -- the reversing transaction, with every other column as it was
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 2
     AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'transactions is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_no_change BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_immutable();

CREATE FUNCTION mark_reversed() RETURNS trigger AS $$
BEGIN
  IF NEW.transaction_type = 'REVERSAL' THEN
    UPDATE transactions SET status = 'REVERSED'
     WHERE transaction_id = NEW.reference_id AND status = 'POSTED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'nothing to reverse: % is missing or already reversed', NEW.reference_id;
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_mark_reversed AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION mark_reversed();

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
     OR (NEW.hold_id, NEW.account_id, NEW.source_type, NEW.source_id,
         NEW.amount, NEW.currency)
        IS DISTINCT FROM
        (OLD.hold_id, OLD.account_id, OLD.source_type, OLD.source_id,
         OLD.amount, OLD.currency) THEN
    RAISE EXCEPTION 'a hold changes once: ACTIVE to CAPTURED, VOIDED or EXPIRED';
  END IF;
  UPDATE accounts
     SET held_balance = held_balance - OLD.amount, updated_at = now()
   WHERE account_id = OLD.account_id;
  NEW.updated_at := now();
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
CREATE CONSTRAINT TRIGGER transactions_balanced AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transaction_must_balance();
