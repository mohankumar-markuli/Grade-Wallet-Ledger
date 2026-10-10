CREATE TABLE job_locks (
    job_name VARCHAR(120) PRIMARY KEY,
    locked_by VARCHAR(120) NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT job_locks_name_not_blank
        CHECK (LENGTH(TRIM(job_name)) > 0),

    CONSTRAINT job_locks_owner_not_blank
        CHECK (LENGTH(TRIM(locked_by)) > 0),

    CONSTRAINT job_locks_expiry_after_lock
        CHECK (expires_at > locked_at)
);

CREATE INDEX job_locks_expiry_idx
    ON job_locks(expires_at);