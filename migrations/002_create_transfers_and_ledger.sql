
CREATE TABLE transfers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_account_id BIGINT NOT NULL REFERENCES accounts(id),
    to_account_id BIGINT NOT NULL REFERENCES accounts(id),
    amount_paise BIGINT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    description VARCHAR(280),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT transfers_distinct_accounts
        CHECK (from_account_id <> to_account_id),
    CONSTRAINT transfers_amount_positive
        CHECK (amount_paise > 0),
    CONSTRAINT transfers_currency_supported
        CHECK (currency = 'INR'),
    CONSTRAINT transfers_status_valid
        CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
    CONSTRAINT transfers_completion_timestamp_valid
        CHECK (
            (status = 'completed' AND completed_at IS NOT NULL)
            OR
            (status <> 'completed' AND completed_at IS NULL)
        )
);

CREATE INDEX transfers_from_account_created_idx
    ON transfers(from_account_id, created_at DESC);

CREATE INDEX transfers_to_account_created_idx
    ON transfers(to_account_id, created_at DESC);

CREATE TABLE ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers(id),
    account_id BIGINT NOT NULL REFERENCES accounts(id),
    entry_type VARCHAR(10) NOT NULL,
    amount_paise BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ledger_entry_type_valid
        CHECK (entry_type IN ('debit', 'credit')),
    CONSTRAINT ledger_entry_amount_positive
        CHECK (amount_paise > 0)
);

CREATE INDEX ledger_entries_transfer_idx
    ON ledger_entries(transfer_id);

CREATE INDEX ledger_entries_account_created_idx
    ON ledger_entries(account_id, created_at, id);
