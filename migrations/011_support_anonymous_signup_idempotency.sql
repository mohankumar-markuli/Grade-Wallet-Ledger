-- User registration is a state-changing POST but has no authenticated user
-- ID yet. Store registration keys in a null-user scope, unique by UUID.
-- Authenticated writes continue to use the existing (user_id, key) constraint.
ALTER TABLE idempotency_keys
    ALTER COLUMN user_id DROP NOT NULL;

CREATE UNIQUE INDEX idempotency_keys_anonymous_key_unique
    ON idempotency_keys(idempotency_key)
    WHERE user_id IS NULL;
