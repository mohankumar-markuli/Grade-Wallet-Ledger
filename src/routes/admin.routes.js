const express = require('express');
const reconciliationAdminToken = require('../middleware/reconciliation-admin.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const { runReconciliation } = require('../repositories/reconciliation.repository');
const { listRiskQueue } = require('../services/risk.service');
const { decideHeldTransfer } = require('../services/risk-review.service');
const pool = require('../config/db');
const router = express.Router();
router.use(reconciliationAdminToken);

router.post('/reconciliation/run', requireIdempotencyKey, async (req,res,next) => {
    try { const result=await runReconciliation({ idempotencyKey:req.idempotencyKey, requestBody:req.body||{} }); return res.status(result.status).json(result.body); }
    catch(error) { return next(error); }
});
router.get('/reconciliation/runs/:id', async (req,res,next) => {
    try {
        const result=await pool.query('SELECT * FROM reconciliation_runs WHERE id=$1',[req.params.id]);
        if(!result.rowCount) return res.status(404).json({ error:{ code:'RECONCILIATION_RUN_NOT_FOUND',message:'Reconciliation run not found.' } });
        const problems=await pool.query('SELECT * FROM reconciliation_problems WHERE run_id=$1 ORDER BY id',[req.params.id]);
        return res.status(200).json({ data:{ ...result.rows[0], problems:problems.rows } });
    } catch(error) { return next(error); }
});
router.get('/risk/queue', async (req,res,next) => {
    try { return res.status(200).json({ data:await listRiskQueue({ limit:req.query.limit }) }); }
    catch(error) { return next(error); }
});
router.post('/risk/:transfer_id/decision', requireIdempotencyKey, async (req,res,next) => {
    try {
        const result=await decideHeldTransfer({ transferId:req.params.transfer_id, decision:req.body?.decision, idempotencyKey:req.idempotencyKey });
        return res.status(result.status).json(result.body);
    } catch(error) { return next(error); }
});
module.exports=router;
