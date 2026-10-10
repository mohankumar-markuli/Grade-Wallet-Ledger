const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const pool = require('../config/db');

function hashRequest(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex');
}

function idempotencyError(message, status, code) {
    return Object.assign(new Error(message), { status, code });
}

async function createUser({ email, fullName, password, idempotencyKey }) {
    const requestHash = hashRequest({
        operation: 'user-create',
        email,
        fullName,
        password
    });
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const keyResult = await client.query(
            `INSERT INTO idempotency_keys
                (user_id, idempotency_key, request_hash)
             VALUES (NULL, $1, $2)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [idempotencyKey, requestHash]
        );

        if (keyResult.rowCount === 0) {
            const existingResult = await client.query(
                `SELECT request_hash, response_status, response_body
                 FROM idempotency_keys
                 WHERE user_id IS NULL AND idempotency_key = $1
                 FOR UPDATE`,
                [idempotencyKey]
            );
            const existing = existingResult.rows[0];

            if (!existing || existing.request_hash !== requestHash) {
                throw idempotencyError(
                    'This Idempotency-Key was already used for a different request.',
                    422,
                    'IDEMPOTENCY_KEY_REUSED'
                );
            }

            if (existing.response_status === null || existing.response_body === null) {
                throw idempotencyError(
                    'The original request has no saved response. Retry shortly.',
                    409,
                    'IDEMPOTENCY_REQUEST_INCOMPLETE'
                );
            }

            await client.query('COMMIT');
            return existing.response_body.data;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const userResult = await client.query(
            `INSERT INTO users (email, full_name, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, email, full_name, status, created_at`,
            [email, fullName, passwordHash]
        );
        const user = userResult.rows[0];
        const responseBody = { data: user };

        await client.query(
            `UPDATE idempotency_keys
             SET response_status = 201,
                 response_body = $1::jsonb
             WHERE user_id IS NULL AND idempotency_key = $2`,
            [JSON.stringify(responseBody), idempotencyKey]
        );

        await client.query('COMMIT');
        return user;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function findUserByEmail(email) {
    const result = await pool.query(
        `SELECT id, email, full_name, password_hash, status
         FROM users
         WHERE email = $1`,
        [email]
    );

    return result.rows[0] || null;
}

module.exports = { createUser, findUserByEmail };
