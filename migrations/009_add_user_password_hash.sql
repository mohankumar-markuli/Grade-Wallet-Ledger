
ALTER TABLE users
ADD COLUMN password_hash VARCHAR(255);

ALTER TABLE users
ADD CONSTRAINT users_password_hash_length
CHECK (
    password_hash IS NULL
    OR length(password_hash) >= 60
);
