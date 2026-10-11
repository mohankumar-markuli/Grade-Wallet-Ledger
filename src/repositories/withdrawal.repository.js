const crypto = require('node:crypto');
const pool = require('../config/db');
const { evaluateTransferRisk, insertRiskFlags } = require('../services/risk.service');

const MAX_BIGINT = 9223372036854775807n;

function fail(message, status, code) {
    return Object.assign(new Error(message), { status, code });
}

function normalizeAmount(value) {
    const amount = typeof value === 'string'
        ? value
        : Number.isSafeInteger(value) ? String(value) : '';
    if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > MAX_BIGINT) {
        throw fail('amountPaise must be a positive integer.', 400, 'VALIDATION_ERROR');
    }
    return amount;
}

async function withdrawFromWallet({ walletId, userId, amountPaise, idempotencyKey }) {
    const amount = normalizeAmount(amountPaise);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 255) {
        throw fail('A valid Idempotency-Key is required.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const walletResult = await client.query(
            `SELECT id FROM accounts
             WHERE id = $1 AND user_id = $2 AND account_type = 'wallet'`,
            [walletId, userId]
        );
        if (!walletResult.rowCount) throw fail('Wallet not found.', 404, 'WALLET_NOT_FOUND');

        const cashResult = await client.query(
            `SELECT id FROM accounts
             WHERE account_type = 'system' AND account_name = 'cash_out'
               AND status = 'active' ORDER BY id LIMIT 1`
        );
        if (!cashResult.rowCount) throw new Error('Active cash_out account is not configured.');

        const walletIdText = String(walletResult.rows[0].id);
        const cashId = String(cashResult.rows[0].id);
        const locked = await client.query(
            `SELECT id, user_id, account_type, account_name, currency,
                    balance_paise, status
             FROM accounts WHERE id = ANY($1::bigint[])
             ORDER BY id FOR UPDATE`,
            [[walletIdText, cashId]]
        );
        const wallet = locked.rows.find((row) => String(row.id) === walletIdText);
        const cashOut = locked.rows.find((row) => String(row.id) === cashId);
        if (!wallet || wallet.user_id === null || !cashOut || cashOut.account_type !== 'system') {
            throw new Error('Wallet or cash-out account is not configured correctly.');
        }
        if (wallet.status !== 'active' || cashOut.status !== 'active') {
            throw fail('Wallet or cash-out account is not active.', 409, 'ACCOUNT_NOT_ACTIVE');
        }
        if (wallet.currency !== 'INR' || cashOut.currency !== 'INR') {
            throw fail('Unsupported account currency.', 400, 'UNSUPPORTED_CURRENCY');
        }

        const requestHash = crypto.createHash('sha256')
            .update(JSON.stringify({ operation: 'withdrawal', walletId: walletIdText, amountPaise: amount }))
            .digest('hex');
        const inserted = await client.query(
            `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
            [userId, idempotencyKey, requestHash]
        );

        if (!inserted.rowCount) {
            const saved = (await client.query(
                `SELECT request_hash, response_status, response_body
                 FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2
                 FOR UPDATE`,
                [userId, idempotencyKey]
            )).rows[0];
            if (!saved || saved.request_hash !== requestHash) {
                throw fail('This Idempotency-Key was already used for a different request.', 422, 'IDEMPOTENCY_KEY_REUSED');
            }
            if (saved.response_status === null || saved.response_body === null) {
                throw fail('The original request is incomplete.', 409, 'IDEMPOTENCY_REQUEST_INCOMPLETE');
            }
            await client.query('COMMIT');
            return { status: saved.response_status, body: saved.response_body, replayed: true };
        }

        if (BigInt(wallet.balance_paise) < BigInt(amount)) {
            throw fail('Insufficient wallet balance.', 409, 'INSUFFICIENT_FUNDS');
        }

        const riskStartedAt = process.hrtime.bigint();
        const findings = await evaluateTransferRisk(client, {
            sourceAccountId: wallet.id,
            amountPaise: amount
        });
        const riskEvaluationMs = Number(process.hrtime.bigint() - riskStartedAt) / 1e6;
        const held = findings.some(({ rule }) => rule.configuration?.action === 'hold');
        const transfer = (await client.query(
            `INSERT INTO transfers
                (from_account_id, to_account_id, amount_paise, currency, status,
                 description, transfer_type, completed_at)
             VALUES ($1, $2, $3, 'INR', $4, 'Wallet withdrawal', 'withdrawal', $5)
             RETURNING id, from_account_id, to_account_id, amount_paise,
                       currency, status, created_at, completed_at`,
            [wallet.id, cashOut.id, amount, held ? 'held' : 'completed', held ? null : new Date()]
        )).rows[0];

        if (findings.length) {
            await insertRiskFlags(client, {
                userId: wallet.user_id,
                accountId: wallet.id,
                transferId: transfer.id,
                findings,
                held
            });
        }

        if (held) {
            const body = { data: {
                transfer,
                held: true,
                message: 'Withdrawal held for administrator review.',
                riskEvaluationMs
            } };
            await client.query(
                `INSERT INTO transfer_status_audit
                    (transfer_id, old_status, new_status, reason, actor_user_id, actor_type)
                 VALUES ($1, NULL, 'held', 'Configured fraud rule matched', $2, 'user')`,
                [transfer.id, wallet.user_id]
            );
            await client.query(
                `UPDATE idempotency_keys
                 SET response_status = 202, response_body = $1::jsonb, transfer_id = $2
                 WHERE user_id = $3 AND idempotency_key = $4`,
                [JSON.stringify(body), transfer.id, userId, idempotencyKey]
            );
            await client.query('COMMIT');
            return { status: 202, body, replayed: false };
        }

        await client.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, entry_type, amount_paise)
             VALUES ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
            [transfer.id, wallet.id, amount, cashOut.id]
        );
        const updatedWallet = (await client.query(
            `UPDATE accounts SET balance_paise = balance_paise - $1::bigint
             WHERE id = $2 RETURNING id, balance_paise`,
            [amount, wallet.id]
        )).rows[0];
        await client.query(
            `UPDATE accounts SET balance_paise = balance_paise + $1::bigint
             WHERE id = $2`,
            [amount, cashOut.id]
        );
        const body = { data: {
            transfer,
            wallet: updatedWallet,
            riskEvaluationMs,
            flagged: findings.length > 0
        } };
        await client.query(
            `INSERT INTO transfer_status_audit
                (transfer_id, old_status, new_status, reason, actor_user_id, actor_type)
             VALUES ($1, NULL, 'completed', 'Wallet withdrawal', $2, 'user')`,
            [transfer.id, wallet.user_id]
        );
        await client.query(
            `UPDATE idempotency_keys
             SET response_status = 201, response_body = $1::jsonb, transfer_id = $2
             WHERE user_id = $3 AND idempotency_key = $4`,
            [JSON.stringify(body), transfer.id, userId, idempotencyKey]
        );
        await client.query('COMMIT');
        return { status: 201, body, replayed: false };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { withdrawFromWallet };
