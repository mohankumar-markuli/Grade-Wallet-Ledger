const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const { answerStatementQuestion } = require('../services/statement-qa.service');
const pool = require('../config/db');
const router = express.Router();

router.get('/wallets/:id/statement', authenticateToken, async (req, res, next) => {
    try {
        if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A valid wallet ID is required.' } });
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
        const wallet = await pool.query("SELECT id FROM accounts WHERE id=$1 AND user_id=$2 AND account_type='wallet'", [req.params.id, req.user.id]);
        if (!wallet.rowCount) return res.status(404).json({ error: { code: 'WALLET_NOT_FOUND', message: 'Wallet not found.' } });
        const result = await pool.query(
            `SELECT entry.id AS ledger_entry_id, entry.transfer_id, entry.entry_type,
                    entry.amount_paise, entry.created_at, transfer.status,
                    transfer.description, transfer.from_account_id, transfer.to_account_id
             FROM ledger_entries entry JOIN transfers transfer ON transfer.id=entry.transfer_id
             WHERE entry.account_id=$1 ORDER BY entry.created_at DESC, entry.id DESC
             LIMIT $2 OFFSET $3`, [req.params.id, limit, offset]
        );
        return res.status(200).json({ data: result.rows, pagination: { limit, offset } });
    } catch (error) { return next(error); }
});

router.post('/users/:id/statement/ask', authenticateToken, requireIdempotencyKey, async (req, res, next) => {
    try {
        if (String(req.user.id) !== String(req.params.id)) return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
        if (typeof req.body?.question !== 'string' || req.body.question.trim().length < 1 || req.body.question.length > 2000) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A question is required.' } });
        const result = await answerStatementQuestion({ userId: req.user.id, question: req.body.question, idempotencyKey: req.idempotencyKey });
        return res.status(result.status).json(result.body);
    } catch (error) { return next(error); }
});
module.exports = router;
