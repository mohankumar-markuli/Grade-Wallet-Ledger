const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const { topUpWallet } = require('../repositories/topup.repository');
const { transferBetweenWallets } = require('../repositories/transfer.repository');
const { withdrawFromWallet } = require('../repositories/withdrawal.repository');
const pool = require('../config/db');

const router = express.Router();
router.use(authenticateToken);

router.post('/topup', requireIdempotencyKey, async (req, res, next) => {
    try {
        const result = await topUpWallet({
            walletId: req.body?.walletId,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        res.status(result.status).json(result.body);
    } catch (error) { next(error); }
});

router.post('/', requireIdempotencyKey, async (req, res, next) => {
    try {
        const result = await transferBetweenWallets({
            fromWalletId: req.body?.fromWalletId,
            toWalletId: req.body?.toWalletId,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        res.status(result.status).json(result.body);
    } catch (error) { next(error); }
});

router.post('/withdraw', requireIdempotencyKey, async (req, res, next) => {
    try {
        const result = await withdrawFromWallet({
            walletId: req.body?.walletId,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) { return next(error); }
});

router.post('/:id/reverse', requireIdempotencyKey, async (req, res, next) => {
    try {
        const original = await pool.query(
            `SELECT transfer.* FROM transfers transfer
             WHERE transfer.id=$1 AND transfer.status='completed'
               AND transfer.transfer_type='peer_transfer'
               AND EXISTS (SELECT 1 FROM accounts wallet WHERE wallet.user_id=$2
                   AND wallet.id = transfer.to_account_id)`,
            [req.params.id, req.user.id]
        );
        if (!original.rowCount) return res.status(404).json({ error: { code: 'TRANSFER_NOT_FOUND', message: 'Completed transfer not found.' } });
        const source = original.rows[0];
        const result = await transferBetweenWallets({
            fromWalletId: source.to_account_id,
            toWalletId: source.from_account_id,
            userId: req.user.id,
            amountPaise: String(source.amount_paise),
            idempotencyKey: req.idempotencyKey,
            transferType: 'reversal',
            originalTransferId: source.id
        });
        return res.status(result.status).json(result.body);
    } catch (error) { return next(error); }
});

router.get('/:id', async (req, res, next) => {
    try {
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
             )`, [req.params.id, req.user.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: { code: 'TRANSFER_NOT_FOUND', message: 'Transfer not found.' } });
        return res.status(200).json({ data: result.rows[0] });
    } catch (error) { return next(error); }
});

module.exports = router;
