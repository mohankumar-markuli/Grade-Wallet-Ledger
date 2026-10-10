
const crypto = require('node:crypto');
const pool = require('../config/db');

const MAX_BIGINT = 9223372036854775807n;

function createError(message, status, code) {
    return Object.assign(new Error(message), { status, code });
}

function normalizeAmount(amountPaise) {
    let amount;

    if (typeof amountPaise === 'string') {
        amount = amountPaise;
    } else if (
        typeof amountPaise === 'number' &&
        Number.isSafeInteger(amountPaise)
    ) {
        amount = String(amountPaise);
    } else {
        throw createError(
            'amountPaise must be a positive integer.',
            400,
            'VALIDATION_ERROR'
        );
    }

    if (
        !/^[1-9]\d*$/.test(amount) ||
        BigInt(amount) > MAX_BIGINT
    ) {
        throw createError(
            'amountPaise must be a valid positive amount.',
            400,
            'VALIDATION_ERROR'
        );
    }

    return amount;
}

function normalizeIdempotencyKey(key) {
    if (
        typeof key !== 'string' ||
        key.trim().length === 0 ||
        key.length > 255
    ) {
        throw createError(
            'A valid Idempotency-Key header is required.',
            400,
            'IDEMPOTENCY_KEY_REQUIRED'
        );
    }

    return key;
}

async function transferBetweenWallets({
    fromWalletId,
    toWalletId,
    userId,
    amountPaise,
    idempotencyKey
}) {
    if (
        !/^[1-9]\d*$/.test(String(fromWalletId)) ||
        !/^[1-9]\d*$/.test(String(toWalletId))
    ) {
        throw createError(
            'Both wallet IDs must be positive integers.',
            400,
            'VALIDATION_ERROR'
        );
    }

    if (!/^[1-9]\d*$/.test(String(userId))) {
        throw createError(
            'A valid authenticated user ID is required.',
            401,
            'UNAUTHORIZED'
        );
    }

    if (String(fromWalletId) === String(toWalletId)) {
        throw createError(
            'Source and destination wallets must be different.',
            400,
            'SAME_WALLET'
        );
    }

    const amount = normalizeAmount(amountPaise);
    const key = normalizeIdempotencyKey(idempotencyKey);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Lock both wallets in ID order to reduce deadlock risk.
        const walletIds = [
            String(fromWalletId),
            String(toWalletId)
        ].sort((a, b) => {
            const left = BigInt(a);
            const right = BigInt(b);

            return left < right ? -1 : left > right ? 1 : 0;
        });

        const walletResult = await client.query(
            `SELECT id, user_id, account_type, currency,
                    balance_paise, status
             FROM accounts
             WHERE id = ANY($1::bigint[])
             ORDER BY id
             FOR UPDATE`,
            [walletIds]
        );

        const wallets = walletResult.rows;

        const source = wallets.find(
            wallet => String(wallet.id) === String(fromWalletId)
        );

        const destination = wallets.find(
            wallet => String(wallet.id) === String(toWalletId)
        );

        if (
            !source ||
            !destination ||
            source.account_type !== 'wallet' ||
            destination.account_type !== 'wallet'
        ) {
            throw createError(
                'Source or destination wallet was not found.',
                404,
                'WALLET_NOT_FOUND'
            );
        }

        // Enforce ownership inside the transaction.
        if (String(source.user_id) !== String(userId)) {
            throw createError(
                'Source wallet was not found.',
                404,
                'WALLET_NOT_FOUND'
            );
        }

        if (
            source.status !== 'active' ||
            destination.status !== 'active'
        ) {
            throw createError(
                'Both wallets must be active.',
                409,
                'ACCOUNT_NOT_ACTIVE'
            );
        }

        if (
            source.currency !== 'INR' ||
            destination.currency !== 'INR'
        ) {
            throw createError(
                'Unsupported wallet currency.',
                400,
                'UNSUPPORTED_CURRENCY'
            );
        }

        const requestHash = crypto
            .createHash('sha256')
            .update(JSON.stringify({
                operation: 'wallet-transfer',
                fromWalletId: String(source.id),
                toWalletId: String(destination.id),
                amountPaise: amount
            }))
            .digest('hex');

        const keyInsert = await client.query(
            `INSERT INTO idempotency_keys
                (user_id, idempotency_key, request_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING
             RETURNING id`,
            [source.user_id, key, requestHash]
        );

        if (keyInsert.rowCount === 0) {
            const existingResult = await client.query(
                `SELECT request_hash, response_status, response_body
                 FROM idempotency_keys
                 WHERE user_id = $1 AND idempotency_key = $2
                 FOR UPDATE`,
                [source.user_id, key]
            );

            const existing = existingResult.rows[0];

            if (!existing || existing.request_hash !== requestHash) {
                throw createError(
                    'This Idempotency-Key was already used for a different request.',
                    409,
                    'IDEMPOTENCY_KEY_REUSED'
                );
            }

            if (
                existing.response_status === null ||
                existing.response_body === null
            ) {
                throw createError(
                    'The original request has no saved response. Retry shortly.',
                    409,
                    'IDEMPOTENCY_REQUEST_INCOMPLETE'
                );
            }

            await client.query('COMMIT');

            return {
                status: existing.response_status,
                body: existing.response_body,
                replayed: true
            };
        }

        if (BigInt(source.balance_paise) < BigInt(amount)) {
            throw createError(
                'Insufficient wallet balance.',
                409,
                'INSUFFICIENT_FUNDS'
            );
        }

        const transferResult = await client.query(
            `INSERT INTO transfers
                (from_account_id, to_account_id, amount_paise,
                 currency, status, description, completed_at)
             VALUES ($1, $2, $3, 'INR', 'completed',
                     'Wallet-to-wallet transfer', NOW())
             RETURNING id, from_account_id, to_account_id,
                       amount_paise, currency, status,
                       created_at, completed_at`,
            [source.id, destination.id, amount]
        );

        const transfer = transferResult.rows[0];

        await client.query(
            `INSERT INTO ledger_entries
                (transfer_id, account_id, entry_type, amount_paise)
             VALUES
                ($1, $2, 'debit', $3),
                ($1, $4, 'credit', $3)`,
            [transfer.id, source.id, amount, destination.id]
        );

        const updatedSource = await client.query(
            `UPDATE accounts
             SET balance_paise = balance_paise - $1::bigint
             WHERE id = $2
               AND user_id = $3
               AND account_type = 'wallet'
             RETURNING id, user_id, currency, balance_paise, status`,
            [amount, source.id, userId]
        );

        if (updatedSource.rowCount !== 1) {
            throw createError(
                'Source wallet was not found.',
                404,
                'WALLET_NOT_FOUND'
            );
        }

        const updatedDestination = await client.query(
            `UPDATE accounts
             SET balance_paise = balance_paise + $1::bigint
             WHERE id = $2
               AND account_type = 'wallet'
             RETURNING id, user_id, currency, balance_paise, status`,
            [amount, destination.id]
        );

        if (updatedDestination.rowCount !== 1) {
            throw createError(
                'Destination wallet was not found.',
                404,
                'WALLET_NOT_FOUND'
            );
        }

        const responseBody = {
            data: {
                transfer,
                sourceWallet: updatedSource.rows[0],
                destinationWallet: updatedDestination.rows[0]
            }
        };

        await client.query(
            `INSERT INTO transfer_status_audit
                (transfer_id, old_status, new_status, reason)
             VALUES ($1, NULL, 'completed', $2)`,
            [transfer.id, 'Wallet-to-wallet transfer']
        );

        await client.query(
            `UPDATE idempotency_keys
             SET response_status = 201,
                 response_body = $1::jsonb,
                 transfer_id = $2
             WHERE user_id = $3 AND idempotency_key = $4`,
            [
                JSON.stringify(responseBody),
                transfer.id,
                source.user_id,
                key
            ]
        );

        await client.query('COMMIT');

        return {
            status: 201,
            body: responseBody,
            replayed: false
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { transferBetweenWallets };