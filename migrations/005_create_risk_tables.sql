CREATE TABLE risk_rules (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_code VARCHAR(80) NOT NULL,
    description VARCHAR(280) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT risk_rules_code_not_blank
        CHECK (LENGTH(TRIM(rule_code)) > 0),
    CONSTRAINT risk_rules_description_not_blank
        CHECK (LENGTH(TRIM(description)) > 0),
    CONSTRAINT risk_rules_configuration_object
        CHECK (jsonb_typeof(configuration) = 'object'),
    CONSTRAINT risk_rules_code_unique
        UNIQUE (rule_code)
);

CREATE TABLE risk_flags (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT REFERENCES users(id),
    account_id BIGINT REFERENCES accounts(id),
    transfer_id BIGINT REFERENCES transfers(id),
    rule_code VARCHAR(80) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,

    CONSTRAINT risk_flags_subject_required
        CHECK (
            user_id IS NOT NULL
            OR account_id IS NOT NULL
            OR transfer_id IS NOT NULL
        ),
    CONSTRAINT risk_flags_severity_valid
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT risk_flags_status_valid
        CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
    CONSTRAINT risk_flags_resolution_timestamp_valid
        CHECK (
            (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL)
            OR
            (status IN ('open', 'reviewing') AND resolved_at IS NULL)
        ),
    CONSTRAINT risk_flags_details_object
        CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX risk_flags_user_created_idx
    ON risk_flags(user_id, created_at DESC);

CREATE INDEX risk_flags_account_created_idx
    ON risk_flags(account_id, created_at DESC);

CREATE INDEX risk_flags_transfer_idx
    ON risk_flags(transfer_id);