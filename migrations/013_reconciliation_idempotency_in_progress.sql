-- Allow a manual run to claim its idempotency key while status is running.
-- The run and its saved response are committed together as completed.

ALTER TABLE reconciliation_runs
    DROP CONSTRAINT reconciliation_idempotency_request_valid;

ALTER TABLE reconciliation_runs
    ADD CONSTRAINT reconciliation_idempotency_request_valid
        CHECK (
            (idempotency_key IS NULL AND request_hash IS NULL AND response_body IS NULL)
            OR
            (
                idempotency_key IS NOT NULL
                AND request_hash IS NOT NULL
                AND request_hash ~ '^[0-9a-f]{64}$'
                AND (
                    (status = 'running' AND response_body IS NULL)
                    OR
                    (
                        status = 'completed'
                        AND response_body IS NOT NULL
                        AND jsonb_typeof(response_body) = 'object'
                    )
                )
            )
        );
