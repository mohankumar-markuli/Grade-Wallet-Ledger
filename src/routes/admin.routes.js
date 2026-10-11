const express = require('express');
const reconciliationAdminToken = require('../middleware/reconciliation-admin.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const adminController = require('../controllers/admin.controller');

const router = express.Router();
router.use(reconciliationAdminToken);

router.post('/reconciliation/run', requireIdempotencyKey, adminController.runManualReconciliation);
router.get('/reconciliation/runs/:id', adminController.getReconciliationRun);
router.get('/risk/queue', adminController.getRiskQueue);
router.post('/risk/:transfer_id/decision', requireIdempotencyKey, adminController.decideRiskFlag);

module.exports = router;
