-- Milestone 1 schema alignment.
-- This is a forward migration so databases that already recorded 001-009
-- receive the new model without rewriting their migration history. Legacy
-- rows are preserved; fields that need real historical/user data remain
-- nullable until that data can be supplied.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS kyc_status TEXT;

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS account_name TEXT;

-- Map the existing simulated-funding account to the brief's cash-in role.
UPDATE accounts
SET account_name = 'cash_in'
WHERE account_type = 'external_funding'
  AND account_name IS NULL;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_system_account_name_valid
    CHECK (
        account_name IS NULL
        OR LENGTH(TRIM(account_name)) > 0
    );

ALTER TABLE accounts
    ADD CONSTRAINT accounts_system_account_has_no_owner
    CHECK (
        account_type = 'wallet'
        OR user_id IS NULL
    );

-- User wallets cannot be negative; system accounts can be negative.
ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_balance_nonnegative;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_wallet_balance_nonnegative
    CHECK (account_type <> 'wallet' OR balance_paise >= 0);

CREATE UNIQUE INDEX accounts_system_name_unique
    ON accounts(account_name)
    WHERE account_type IN ('system', 'external_funding')
      AND account_name IN ('cash_in', 'cash_out', 'fee_revenue');

INSERT INTO accounts (account_type, account_name, currency)
SELECT 'system', 'cash_out', 'INR'
WHERE NOT EXISTS (
    SELECT 1 FROM accounts WHERE account_name = 'cash_out'
);

INSERT INTO accounts (account_type, account_name, currency)
SELECT 'system', 'fee_revenue', 'INR'
WHERE NOT EXISTS (
    SELECT 1 FROM accounts WHERE account_name = 'fee_revenue'
);

ALTER TABLE transfers
    ADD COLUMN IF NOT EXISTS transfer_type VARCHAR(30),
    ADD COLUMN IF NOT EXISTS original_transfer_id BIGINT
        REFERENCES transfers(id);

UPDATE transfers AS t
SET transfer_type = CASE
    WHEN source.account_type = 'external_funding' THEN 'top_up'
    WHEN destination.account_type = 'external_funding' THEN 'withdrawal'
    ELSE 'peer_transfer'
END
FROM accounts AS source, accounts AS destination
WHERE source.id = t.from_account_id
  AND destination.id = t.to_account_id
  AND t.transfer_type IS NULL;

ALTER TABLE transfers
    ALTER COLUMN transfer_type SET NOT NULL,
    ADD CONSTRAINT transfers_type_valid
        CHECK (transfer_type IN ('top_up', 'peer_transfer', 'withdrawal', 'fee', 'reversal'));

ALTER TABLE transfers
    DROP CONSTRAINT IF EXISTS transfers_status_valid;

ALTER TABLE transfers
    ADD CONSTRAINT transfers_status_valid
        CHECK (status IN ('pending', 'held', 'completed', 'failed', 'reversed'));

CREATE OR REPLACE FUNCTION infer_transfer_type_from_accounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_type TEXT;
    destination_type TEXT;
BEGIN
    IF NEW.transfer_type IS NULL THEN
        SELECT account_type INTO source_type
        FROM accounts WHERE id = NEW.from_account_id;
        SELECT account_type INTO destination_type
        FROM accounts WHERE id = NEW.to_account_id;

        NEW.transfer_type := CASE
            WHEN source_type = 'external_funding' THEN 'top_up'
            WHEN destination_type = 'external_funding' THEN 'withdrawal'
            ELSE 'peer_transfer'
        END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transfers_infer_type
BEFORE INSERT ON transfers
FOR EACH ROW
EXECUTE FUNCTION infer_transfer_type_from_accounts();

CREATE INDEX transfers_original_transfer_idx
    ON transfers(original_transfer_id)
    WHERE original_transfer_id IS NOT NULL;

ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'processing';

UPDATE idempotency_keys
SET status = CASE
    WHEN response_status IS NOT NULL AND response_body IS NOT NULL THEN 'completed'
    ELSE 'processing'
END;

ALTER TABLE idempotency_keys
    ADD CONSTRAINT idempotency_status_valid
        CHECK (status IN ('processing', 'completed', 'failed'));

CREATE OR REPLACE FUNCTION mark_idempotency_response_completed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.response_status IS NOT NULL AND NEW.response_body IS NOT NULL THEN
        NEW.status := 'completed';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_keys_response_status
BEFORE INSERT OR UPDATE ON idempotency_keys
FOR EACH ROW
EXECUTE FUNCTION mark_idempotency_response_completed();

ALTER TABLE transfer_status_audit
    ADD COLUMN IF NOT EXISTS actor_user_id BIGINT REFERENCES users(id);

ALTER TABLE risk_flags
    ADD COLUMN IF NOT EXISTS rule_id BIGINT REFERENCES risk_rules(id),
    ADD COLUMN IF NOT EXISTS decision VARCHAR(30);

UPDATE risk_flags AS flag
SET rule_id = rule.id
FROM risk_rules AS rule
WHERE flag.rule_id IS NULL
  AND flag.rule_code = rule.rule_code;

ALTER TABLE risk_flags
    ADD CONSTRAINT risk_flags_decision_valid
    CHECK (
        decision IS NULL
        OR decision IN ('held', 'allowed_with_flag')
    );

-- A row trigger makes normal UPDATE/DELETE statements fail. Application and
-- database roles should not own this table or have permission to disable the
-- trigger in production.
CREATE OR REPLACE FUNCTION reject_ledger_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries are append-only';
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;

CREATE TRIGGER ledger_entries_append_only
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION reject_ledger_entry_mutation();

CREATE OR REPLACE FUNCTION enforce_transfer_balanced_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    transfer_key BIGINT;
    transfer_status TEXT;
    entry_count BIGINT;
    debit_total NUMERIC;
    credit_total NUMERIC;
BEGIN
    IF TG_TABLE_NAME = 'transfers' THEN
        transfer_key := NEW.id;
        transfer_status := NEW.status;
    ELSE
        transfer_key := NEW.transfer_id;
        SELECT status INTO transfer_status
        FROM transfers WHERE id = transfer_key;
    END IF;

    -- Held, pending, and failed transfer records do not move funds. Their
    -- entries are required only when they complete.
    IF transfer_status NOT IN ('completed', 'reversed') THEN
        RETURN NULL;
    END IF;

    SELECT COUNT(*),
           COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'debit'), 0),
           COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'credit'), 0)
    INTO entry_count, debit_total, credit_total
    FROM ledger_entries
    WHERE transfer_id = transfer_key;

    IF entry_count < 2 OR debit_total <> credit_total THEN
        RAISE EXCEPTION
            'transfer % must have at least two balanced ledger entries',
            transfer_key;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transfers_require_balanced_ledger
AFTER INSERT OR UPDATE ON transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_transfer_balanced_ledger();

CREATE CONSTRAINT TRIGGER ledger_entries_balance_transfer
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_transfer_balanced_ledger();

CREATE INDEX IF NOT EXISTS ledger_entries_account_statement_idx
    ON ledger_entries(account_id, created_at DESC, id DESC);

-- Keep this idempotent fallback for installations that applied migration 010
-- before the pending job-lock draft was promoted to migration 007.
CREATE TABLE IF NOT EXISTS job_locks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_name VARCHAR(120) NOT NULL UNIQUE,
    locked_by VARCHAR(120) NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT job_locks_name_not_blank
        CHECK (LENGTH(TRIM(job_name)) > 0),
    CONSTRAINT job_locks_owner_not_blank
        CHECK (LENGTH(TRIM(locked_by)) > 0),
    CONSTRAINT job_locks_expiry_after_lock
        CHECK (expires_at > locked_at)
);

CREATE INDEX IF NOT EXISTS job_locks_expiry_idx
    ON job_locks(expires_at);
