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

async function createWallet({ userId, name = 'Wallet', idempotencyKey }) {
    const requestHash = hashRequest({
        operation: 'wallet-create',
        userId: String(userId),
        name
    });
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const keyResult = await client.query(
            `INSERT INTO idempotency_keys
                (user_id, idempotency_key, request_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING
             RETURNING id`,
            [userId, idempotencyKey, requestHash]
        );

        if (keyResult.rowCount === 0) {
            const existingResult = await client.query(
                `SELECT request_hash, response_status, response_body
                 FROM idempotency_keys
                 WHERE user_id = $1 AND idempotency_key = $2
                 FOR UPDATE`,
                [userId, idempotencyKey]
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

        const walletResult = await client.query(
            `INSERT INTO accounts (user_id, account_type, name)
             VALUES ($1, 'wallet', $2)
             RETURNING id, user_id, account_type, currency,
                       balance_paise, status, name, created_at`,
            [userId, name]
        );
        const wallet = walletResult.rows[0];

        await client.query(
            `UPDATE idempotency_keys
             SET response_status = 201,
                 response_body = $1::jsonb
             WHERE user_id = $2 AND idempotency_key = $3`,
            [JSON.stringify({ data: wallet }), userId, idempotencyKey]
        );

        await client.query('COMMIT');
        return wallet;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getWalletBalance({ walletId, userId }) {
    const result = await pool.query(
        `SELECT id, user_id, currency, balance_paise, status
         FROM accounts
         WHERE id = $1
           AND user_id = $2
           AND account_type = 'wallet'`,
        [walletId, userId]
    );

    return result.rows[0] || null;
}

module.exports = { createWallet, getWalletBalance };
