const pool = require('../config/db');
const { topUpWallet } = require('../repositories/topup.repository');
const { transferBetweenWallets } = require('../repositories/transfer.repository');
const { withdrawFromWallet } = require('../repositories/withdrawal.repository');

async function topUp(req, res, next) {
    try {
        const result = await topUpWallet({
            walletId: req.body?.walletId,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return next(error);
    }
}

async function createPeerTransfer(req, res, next) {
    try {
        const result = await transferBetweenWallets({
            fromWalletId: req.body?.fromWalletId,
            toWalletId: req.body?.toWalletId,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return next(error);
    }
}

async function withdraw(req, res, next) {
    try {
        const result = await withdrawFromWallet({
            walletId: req.body?.walletId,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return next(error);
    }
}

async function reverse(req, res, next) {
    try {
        if (!/^[1-9]\d*$/.test(req.params.id)) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid transfer ID is required.'
            } });
        }
        const originalResult = await pool.query(
            `SELECT transfer.* FROM transfers transfer
             WHERE transfer.id = $1 AND transfer.status = 'completed'
               AND transfer.transfer_type = 'peer_transfer'
               AND EXISTS (
                   SELECT 1 FROM accounts wallet
                   WHERE wallet.user_id = $2 AND wallet.id = transfer.to_account_id
               )`,
            [req.params.id, req.user.id]
        );
        if (!originalResult.rowCount) {
            return res.status(404).json({ error: {
                code: 'TRANSFER_NOT_FOUND',
                message: 'Completed transfer not found.'
            } });
        }
        const original = originalResult.rows[0];
        const result = await transferBetweenWallets({
            fromWalletId: original.to_account_id,
            toWalletId: original.from_account_id,
            userId: req.user.id,
            amountPaise: String(original.amount_paise),
            idempotencyKey: req.idempotencyKey,
            transferType: 'reversal',
            originalTransferId: original.id
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return next(error);
    }
}

async function getTransfer(req, res, next) {
    try {
        if (!/^[1-9]\d*$/.test(req.params.id)) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid transfer ID is required.'
            } });
        }
        const result = await pool.query(
            `SELECT transfer.id, transfer.transfer_type, transfer.from_account_id,
                    transfer.to_account_id, transfer.amount_paise, transfer.currency,
                    transfer.status, transfer.description, transfer.original_transfer_id,
                    transfer.created_at, transfer.completed_at,
                    COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.id)
                              FROM ledger_entries entry WHERE entry.transfer_id = transfer.id), '[]'::jsonb) AS entries,
                    COALESCE((SELECT jsonb_agg(to_jsonb(audit) ORDER BY audit.changed_at, audit.id)
                              FROM transfer_status_audit audit WHERE audit.transfer_id = transfer.id), '[]'::jsonb) AS status_history
             FROM transfers transfer
             WHERE transfer.id = $1 AND EXISTS (
                 SELECT 1 FROM accounts wallet
                 WHERE wallet.user_id = $2 AND wallet.account_type = 'wallet'
                   AND wallet.id IN (transfer.from_account_id, transfer.to_account_id)
             )`,
            [req.params.id, req.user.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: {
                code: 'TRANSFER_NOT_FOUND',
                message: 'Transfer not found.'
            } });
        }
        return res.status(200).json({ data: result.rows[0] });
    } catch (error) {
        return next(error);
    }
}

module.exports = { topUp, createPeerTransfer, withdraw, reverse, getTransfer };
