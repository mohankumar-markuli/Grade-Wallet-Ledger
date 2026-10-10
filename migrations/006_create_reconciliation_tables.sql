CREATE TABLE reconciliation_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    accounts_checked BIGINT NOT NULL DEFAULT 0,
    problems_found BIGINT NOT NULL DEFAULT 0,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT reconciliation_status_valid
        CHECK (status IN ('running', 'completed', 'failed')),

    CONSTRAINT reconciliation_counts_nonnegative
        CHECK (accounts_checked >= 0 AND problems_found >= 0),

    CONSTRAINT reconciliation_completion_valid
        CHECK (
            (status = 'running' AND completed_at IS NULL)
            OR
            (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
        ),

    CONSTRAINT reconciliation_summary_object
        CHECK (jsonb_typeof(summary) = 'object')
);

CREATE INDEX reconciliation_runs_started_idx
    ON reconciliation_runs(started_at DESC);


CREATE TABLE reconciliation_problems (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id),
    account_id BIGINT REFERENCES accounts(id),
    transfer_id BIGINT REFERENCES transfers(id),
    problem_type VARCHAR(80) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'high',
    expected_value BIGINT,
    actual_value BIGINT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reconciliation_problem_subject_required
        CHECK (account_id IS NOT NULL OR transfer_id IS NOT NULL),

    CONSTRAINT reconciliation_problem_severity_valid
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),

    CONSTRAINT reconciliation_problem_type_not_blank
        CHECK (LENGTH(TRIM(problem_type)) > 0),

    CONSTRAINT reconciliation_problem_details_object
        CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX reconciliation_problems_run_idx
    ON reconciliation_problems(run_id);

CREATE INDEX reconciliation_problems_account_idx
    ON reconciliation_problems(account_id, created_at DESC);

CREATE INDEX reconciliation_problems_transfer_idx
    ON reconciliation_problems(transfer_id);