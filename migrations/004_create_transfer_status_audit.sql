
CREATE TABLE transfer_status_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers(id),
    old_status VARCHAR(20),
    new_status VARCHAR(20) NOT NULL,
    reason VARCHAR(280),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT transfer_audit_old_status_valid
        CHECK (
            old_status IS NULL
            OR old_status IN ('pending', 'completed', 'failed', 'reversed')
        ),
    CONSTRAINT transfer_audit_new_status_valid
        CHECK (
            new_status IN ('pending', 'completed', 'failed', 'reversed')
        ),
    CONSTRAINT transfer_audit_status_changed
        CHECK (old_status IS NULL OR old_status <> new_status)
);

CREATE INDEX transfer_status_audit_transfer_idx
    ON transfer_status_audit(transfer_id, changed_at, id);
