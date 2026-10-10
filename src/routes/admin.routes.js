const express = require('express');
const reconciliationAdminToken = require('../middleware/reconciliation-admin.middleware');
const {
    requireIdempotencyKey
} = require('../middleware/require-idempotency-key.middleware');
const {
    runReconciliation
} = require('../repositories/reconciliation.repository');

const router = express.Router();

router.post(
    '/reconciliation/run',
    reconciliationAdminToken,
    requireIdempotencyKey,
    async (req, res) => {
        try {
            const result = await runReconciliation({
                idempotencyKey: req.idempotencyKey,
                requestBody: req.body || {}
            });
            return res.status(result.status).json(result.body);
        } catch (error) {
            return res.status(error.status || 500).json({
                error: {
                    code: error.code || 'RECONCILIATION_FAILED',
                    message: error.status
                        ? error.message
                        : 'The reconciliation run could not be completed.'
                }
            });
        }
    }
);

module.exports = router;
