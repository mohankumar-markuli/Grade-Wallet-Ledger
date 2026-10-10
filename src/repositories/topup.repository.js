
const crypto = require('node:crypto');
const pool = require('../config/db');


const MAX_BIGINT = 9223372036854775807n;

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
        throw Object.assign(new Error('amountPaise must be a positive integer.'), {
            status: 400,
            code: 'VALIDATION_ERROR',
        });
    }

    if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > MAX_BIGINT) {
        throw Object.assign(new Error('amountPaise must be a valid positive amount.'), {
            status: 400,
            code: 'VALIDATION_ERROR',
        });
    }

    return amount;
}

function normalizeIdempotencyKey(key) {
    if (
        typeof key !== 'string' ||
        key.trim().length === 0 ||
        key.length > 255
    ) {
        throw Object.assign(new Error('A valid Idempotency-Key header is required.'), {
            status: 400,
            code: 'IDEMPOTENCY_KEY_REQUIRED',
        });
    }

    return key;
}

async function topUpWallet({ walletId, amountPaise, idempotencyKey }) {
    const amount = normalizeAmount(amountPaise);
    const key = normalizeIdempotencyKey(idempotencyKey);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Find the wallet owner. Lock both accounts in ID order below.
        const walletResult = await client.query(
            `SELECT id, user_id, currency, balance_paise, status
             FROM accounts
             WHERE id = $1 AND account_type = 'wallet'`,
            [walletId]
        );

        const wallet = walletResult.rows[0];

        if (!wallet) {
            throw Object.assign(new Error('Wallet not found.'), {
                status: 404,
                code: 'WALLET_NOT_FOUND',
            });
        }

        const requestHash = crypto
            .createHash('sha256')
            .update(JSON.stringify({
                operation: 'wallet-top-up',
                walletId: String(wallet.id),
                amountPaise: amount,
            }))
            .digest('hex');

        // Insert the idempotency record first. A concurrent duplicate
        // waits for the first transaction and then sees its saved response.
        const keyResult = await client.query(
            `INSERT INTO idempotency_keys
                (user_id, idempotency_key, request_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING
             RETURNING id`,
            [wallet.user_id, key, requestHash]
        );

        if (keyResult.rowCount === 0) {
            const existingResult = await client.query(
                `SELECT request_hash, response_status, response_body
                 FROM idempotency_keys
                 WHERE user_id = $1 AND idempotency_key = $2
                 FOR UPDATE`,
                [wallet.user_id, key]
            );

            const existing = existingResult.rows[0];

            if (!existing || existing.request_hash !== requestHash) {
                throw Object.assign(
                    new Error('This Idempotency-Key was already used for a different request.'),
                    { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }
                );
            }

            if (
                existing.response_status === null ||
                existing.response_body === null
            ) {
                throw Object.assign(
                    new Error('The original request has no saved response. Retry shortly.'),
                    { status: 409, code: 'IDEMPOTENCY_REQUEST_INCOMPLETE' }
                );
            }

            await client.query('COMMIT');

            return {
                status: existing.response_status,
                body: existing.response_body,
                replayed: true,
            };
        }

        // Lock wallet and funding account in a consistent order.

        // Find the active external-funding account dynamically.
        const fundingResult = await client.query(
            `SELECT id
             FROM accounts
             WHERE account_type = 'external_funding'
               AND status = 'active'
             ORDER BY id
             LIMIT 1`
        );

        if (fundingResult.rowCount !== 1) {
            throw new Error('Active external-funding account is not configured.');
        }

        const fundingAccountId = String(fundingResult.rows[0].id);

        // Lock both accounts in a consistent order.
        const accountIds = [String(wallet.id), fundingAccountId].sort(
            (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
        );

        const lockedResult = await client.query(
            `SELECT id, account_type, currency, balance_paise, status
             FROM accounts
             WHERE id = ANY($1::bigint[])
             ORDER BY id
             FOR UPDATE`,
            [accountIds]
        );

        const lockedWallet = lockedResult.rows.find(
            (account) => String(account.id) === String(wallet.id)
        );

        const funding = lockedResult.rows.find(
            (account) => String(account.id) === fundingAccountId
        );

        if (
            !lockedWallet ||
            !funding ||
            funding.account_type !== 'external_funding'
        ) {
            throw new Error('Wallet or external-funding account is not configured correctly.');
        }

        if (lockedWallet.status !== 'active' || funding.status !== 'active') {
            throw Object.assign(new Error('Wallet or funding account is not active.'), {
                status: 409,
                code: 'ACCOUNT_NOT_ACTIVE',
            });
        }

        if (lockedWallet.currency !== 'INR' || funding.currency !== 'INR') {
            throw new Error('Unsupported account currency.');
        }

        const transferResult = await client.query(
            `INSERT INTO transfers
                (from_account_id, to_account_id, amount_paise,
                 currency, status, description, completed_at)
             VALUES ($1, $2, $3, 'INR', 'completed', $4, NOW())
             RETURNING id, from_account_id, to_account_id,
                       amount_paise, currency, status, created_at, completed_at`,
            [
                fundingAccountId,
                lockedWallet.id,
                amount,
                'Simulated external wallet top-up',
            ]
        );

        const transfer = transferResult.rows[0];

        await client.query(
            `INSERT INTO ledger_entries
                (transfer_id, account_id, entry_type, amount_paise)
             VALUES
                ($1, $2, 'debit', $3),
                ($1, $4, 'credit', $3)`,
            [transfer.id, fundingAccountId, amount, lockedWallet.id]
        );

        await client.query(
            `UPDATE accounts
             SET balance_paise = balance_paise - $1::bigint
             WHERE id = $2`,
            [amount, fundingAccountId]
        );

        const updatedWalletResult = await client.query(
            `UPDATE accounts
             SET balance_paise = balance_paise + $1::bigint
             WHERE id = $2
             RETURNING id, user_id, currency, balance_paise, status`,
            [amount, lockedWallet.id]
        );

        const responseBody = {
            data: {
                transfer,
                wallet: updatedWalletResult.rows[0],
            },
        };

        await client.query(
            `INSERT INTO transfer_status_audit
                (transfer_id, old_status, new_status, reason)
             VALUES ($1, NULL, 'completed', $2)`,
            [transfer.id, 'Simulated external wallet top-up']
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
                wallet.user_id,
                key,
            ]
        );

        await client.query('COMMIT');

        return { status: 201, body: responseBody, replayed: false };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { topUpWallet };
