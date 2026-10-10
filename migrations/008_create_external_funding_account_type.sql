
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM accounts WHERE id = 3
    ) AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE id = 3
          AND account_type = 'system'
          AND user_id IS NULL
          AND balance_paise = 0
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION
            'Account id 3 exists but is not the expected empty system account.';
    END IF;
END $$;

ALTER TABLE accounts
    DROP CONSTRAINT accounts_type_valid;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_type_valid
    CHECK (
        account_type IN ('wallet', 'system', 'external_funding')
    );

ALTER TABLE accounts
    DROP CONSTRAINT accounts_owner_type_valid;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_owner_type_valid
    CHECK (
        (account_type = 'wallet' AND user_id IS NOT NULL)
        OR (account_type = 'system' AND user_id IS NULL)
        OR (account_type = 'external_funding' AND user_id IS NULL)
    );

ALTER TABLE accounts
    DROP CONSTRAINT accounts_balance_nonnegative;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_balance_nonnegative
    CHECK (
        (
            account_type IN ('wallet', 'system')
            AND balance_paise >= 0
        )
        OR account_type = 'external_funding'
    );

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM accounts
        WHERE id = 3
          AND account_type = 'system'
          AND user_id IS NULL
          AND balance_paise = 0
          AND status = 'active'
    ) THEN
        UPDATE accounts
        SET account_type = 'external_funding'
        WHERE id = 3;
    ELSIF NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE account_type = 'external_funding'
    ) THEN
        INSERT INTO accounts (
            account_type, currency, balance_paise, status
        )
        VALUES ('external_funding', 'INR', 0, 'active');
    END IF;
END $$;
