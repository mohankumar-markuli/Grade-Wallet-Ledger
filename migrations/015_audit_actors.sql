-- Record whether a status change was made by an authenticated user,
-- an administrator, or a background/system process.
ALTER TABLE transfer_status_audit
    ADD COLUMN actor_type VARCHAR(20) NOT NULL DEFAULT 'system';

ALTER TABLE transfer_status_audit
    ADD CONSTRAINT transfer_status_audit_actor_type_valid
        CHECK (actor_type IN ('user', 'administrator', 'system'));

ALTER TABLE transfer_status_audit
    ADD CONSTRAINT transfer_status_audit_user_actor_required
        CHECK (actor_type <> 'user' OR actor_user_id IS NOT NULL);

UPDATE transfer_status_audit
SET actor_type = CASE
    WHEN actor_user_id IS NOT NULL THEN 'user'
    WHEN reason ILIKE 'administrator %' THEN 'administrator'
    ELSE 'system'
END;

-- Existing accounts without a recorded KYC value are explicitly pending;
-- new registrations also receive this server-controlled default.
UPDATE users SET kyc_status = 'pending' WHERE kyc_status IS NULL;
ALTER TABLE users
    ALTER COLUMN kyc_status SET DEFAULT 'pending',
    ALTER COLUMN kyc_status SET NOT NULL;
