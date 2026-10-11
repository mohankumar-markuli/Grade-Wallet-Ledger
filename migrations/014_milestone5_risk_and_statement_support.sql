-- Milestone 5: configurable fraud rules and persisted risk explanations.
-- The example thresholds are configuration defaults and can be changed in
-- risk_rules without changing application code.

ALTER TABLE transfer_status_audit
    DROP CONSTRAINT IF EXISTS transfer_audit_old_status_valid,
    DROP CONSTRAINT IF EXISTS transfer_audit_new_status_valid;

ALTER TABLE transfer_status_audit
    ADD CONSTRAINT transfer_audit_old_status_valid
        CHECK (old_status IS NULL OR old_status IN
            ('pending', 'held', 'completed', 'failed', 'reversed')),
    ADD CONSTRAINT transfer_audit_new_status_valid
        CHECK (new_status IN
            ('pending', 'held', 'completed', 'failed', 'reversed'));

ALTER TABLE risk_flags
    ADD COLUMN explanation TEXT,
    ADD COLUMN explanation_label VARCHAR(20),
    ADD COLUMN explained_at TIMESTAMPTZ,
    ADD COLUMN review_decision VARCHAR(20),
    ADD COLUMN decided_at TIMESTAMPTZ;

ALTER TABLE risk_flags
    ADD CONSTRAINT risk_flag_explanation_label_valid
        CHECK (explanation_label IS NULL OR explanation_label IN
            ('likely_ok', 'review', 'likely_fraud')),
    ADD CONSTRAINT risk_flag_explanation_fields_valid
        CHECK ((explanation IS NULL AND explanation_label IS NULL AND explained_at IS NULL)
            OR (explanation IS NOT NULL AND explanation_label IS NOT NULL AND explained_at IS NOT NULL)),
    ADD CONSTRAINT risk_flag_review_decision_valid
        CHECK (review_decision IS NULL OR review_decision IN ('released', 'rejected')),
    ADD CONSTRAINT risk_flag_decision_time_valid
        CHECK ((review_decision IS NULL AND decided_at IS NULL)
            OR (review_decision IS NOT NULL AND decided_at IS NOT NULL));

CREATE INDEX risk_flags_queue_idx
    ON risk_flags(status, created_at DESC, id DESC);
CREATE INDEX risk_flags_explanation_pending_idx
    ON risk_flags(created_at, id)
    WHERE explanation IS NULL;

CREATE TABLE admin_risk_decisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    request_hash CHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT admin_risk_decision_response_valid
        CHECK ((response_status IS NULL AND response_body IS NULL)
            OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE UNIQUE INDEX transfers_one_reversal_per_original_idx
    ON transfers(original_transfer_id)
    WHERE transfer_type = 'reversal' AND original_transfer_id IS NOT NULL;

INSERT INTO risk_rules (rule_code, description, enabled, configuration)
VALUES
    ('single_transfer_amount', 'Hold a peer transfer at or above the configured amount.', TRUE,
     '{"threshold_paise":1000000,"action":"hold"}'::jsonb),
    ('source_transfer_velocity', 'Hold a peer transfer when the source reaches the configured recent-transfer count.', TRUE,
     '{"max_transfers":5,"window_seconds":60,"action":"hold"}'::jsonb)
ON CONFLICT (rule_code) DO NOTHING;
