CREATE TABLE accounts (
    account_id UUID PRIMARY KEY,
    account_type VARCHAR(20) NOT NULL,
    allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
    balance BIGINT NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_balance CHECK (allow_negative OR balance >= 0)
) WITH (fillfactor = 80);

CREATE TABLE ledger_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(account_id),
    amount BIGINT NOT NULL CHECK (amount <> 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_id, account_id)
);
CREATE INDEX idx_ledger_account_created ON ledger_entries (account_id, created_at DESC);

CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    transaction_id UUID NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE outbox (
    seq BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL,
    payload JSONB NOT NULL
);

CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

CREATE FUNCTION apply_entry_to_balance() RETURNS trigger AS $$
BEGIN
  UPDATE accounts SET balance = balance + NEW.amount, updated_at = now()
   WHERE account_id = NEW.account_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_balance();

CREATE FUNCTION accounts_guard_balance() RETURNS trigger AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'balance changes only through ledger_entries';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balance();

CREATE FUNCTION entries_must_balance() RETURNS trigger AS $$
BEGIN
  IF (SELECT sum(amount) FROM ledger_entries WHERE transaction_id = NEW.transaction_id) <> 0 THEN
    RAISE EXCEPTION 'transaction % does not sum to zero', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION entries_must_balance();
