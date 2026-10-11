-- Give every wallet and system account a human-readable name. Existing rows
-- receive a neutral wallet label or their already-recorded system purpose.
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Wallet';

UPDATE accounts
SET name = account_name
WHERE account_name IN ('cash_in', 'cash_out', 'fee_revenue')
  AND name = 'Wallet';

ALTER TABLE accounts
    ADD CONSTRAINT accounts_name_not_blank
        CHECK (LENGTH(TRIM(name)) > 0);
