-- Milestone 4: persist manual-run retry responses and seed the row lock used
-- by both the nightly scheduler and the manual endpoint.

ALTER TABLE reconciliation_runs
    ADD COLUMN idempotency_key VARCHAR(255),
    ADD COLUMN request_hash CHAR(64),
    ADD COLUMN response_body JSONB;

ALTER TABLE reconciliation_runs
    ADD CONSTRAINT reconciliation_idempotency_request_valid
        CHECK (
            (idempotency_key IS NULL AND request_hash IS NULL AND response_body IS NULL)
            OR
            (
                idempotency_key IS NOT NULL
                AND request_hash IS NOT NULL
                AND request_hash ~ '^[0-9a-f]{64}$'
                AND response_body IS NOT NULL
                AND jsonb_typeof(response_body) = 'object'
            )
        );

CREATE UNIQUE INDEX reconciliation_runs_idempotency_key_unique
    ON reconciliation_runs(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Global totals and orphaned ledger rows may not have a valid foreign-key
-- subject, so allow those two report types to have both subject columns null.
ALTER TABLE reconciliation_problems
    DROP CONSTRAINT reconciliation_problem_subject_required;

ALTER TABLE reconciliation_problems
    ADD CONSTRAINT reconciliation_problem_subject_required
        CHECK (
            account_id IS NOT NULL
            OR transfer_id IS NOT NULL
            OR problem_type IN ('ledger_totals_mismatch', 'orphan_ledger_entry')
        );

INSERT INTO job_locks (job_name, locked_by, locked_at, expires_at)
VALUES (
    'nightly_reconciliation',
    'transaction-row-lock',
    NOW(),
    NOW() + INTERVAL '100 years'
)
ON CONFLICT (job_name) DO NOTHING;
