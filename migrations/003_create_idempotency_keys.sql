
CREATE TABLE idempotency_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    transfer_id BIGINT REFERENCES transfers(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,

    CONSTRAINT idempotency_key_not_blank
        CHECK (LENGTH(TRIM(idempotency_key)) > 0),
    CONSTRAINT idempotency_request_hash_valid
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT idempotency_response_status_valid
        CHECK (
            response_status IS NULL
            OR response_status BETWEEN 100 AND 599
        ),
    CONSTRAINT idempotency_response_pair_valid
        CHECK (
            (response_status IS NULL AND response_body IS NULL)
            OR
            (response_status IS NOT NULL AND response_body IS NOT NULL)
        ),
    CONSTRAINT idempotency_key_user_unique
        UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idempotency_keys_transfer_idx
    ON idempotency_keys(transfer_id);
