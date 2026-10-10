CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    phone TEXT NOT NULL,
    kyc_status TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT users_email_lowercase
        CHECK (email = LOWER(email)),
    CONSTRAINT users_email_not_blank
        CHECK (LENGTH(TRIM(email)) > 0),
    CONSTRAINT users_full_name_not_blank
        CHECK (LENGTH(TRIM(full_name)) > 0),
    CONSTRAINT users_phone_not_blank
        CHECK (LENGTH(TRIM(phone)) > 0),
    CONSTRAINT users_kyc_status_not_blank
        CHECK (LENGTH(TRIM(kyc_status)) > 0),
    CONSTRAINT users_status_valid
        CHECK (status IN ('active', 'suspended', 'closed')),
    CONSTRAINT users_email_unique
        UNIQUE (email)
);

CREATE TABLE accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT REFERENCES users(id),
    account_type VARCHAR(20) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    balance_paise BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT accounts_type_valid
        CHECK (account_type IN ('wallet', 'system')),
    CONSTRAINT accounts_currency_supported
        CHECK (currency = 'INR'),
    CONSTRAINT accounts_balance_nonnegative
        CHECK (balance_paise >= 0),
    CONSTRAINT accounts_status_valid
        CHECK (status IN ('active', 'frozen', 'closed')),
    CONSTRAINT accounts_owner_type_valid
        CHECK (
            (account_type = 'wallet' AND user_id IS NOT NULL)
            OR
            (account_type = 'system' AND user_id IS NULL)
        )
);

CREATE INDEX accounts_user_id_idx ON accounts(user_id);
