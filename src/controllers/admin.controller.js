const pool = require('../config/db');
const { runReconciliation } = require('../repositories/reconciliation.repository');
const { listRiskQueue } = require('../services/risk.service');
const { decideHeldTransfer } = require('../services/risk-review.service');

async function runManualReconciliation(req, res, next) {
    try {
        const result = await runReconciliation({
            idempotencyKey: req.idempotencyKey,
            requestBody: req.body || {}
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return next(error);
    }
}

async function getReconciliationRun(req, res, next) {
    try {
        const result = await pool.query(
            'SELECT * FROM reconciliation_runs WHERE id = $1',
            [req.params.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({ error: {
                code: 'RECONCILIATION_RUN_NOT_FOUND',
                message: 'Reconciliation run not found.'
            } });
        }
        const problems = await pool.query(
            'SELECT * FROM reconciliation_problems WHERE run_id = $1 ORDER BY id',
            [req.params.id]
        );
        return res.status(200).json({ data: {
            ...result.rows[0],
            problems: problems.rows
        } });
    } catch (error) {
        return next(error);
    }
}

async function getRiskQueue(req, res, next) {
    try {
        const data = await listRiskQueue({ limit: req.query.limit });
        return res.status(200).json({ data });
    } catch (error) {
        return next(error);
    }
}

async function decideRiskFlag(req, res, next) {
    try {
        const result = await decideHeldTransfer({
            transferId: req.params.transfer_id,
            decision: req.body?.decision,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    runManualReconciliation,
    getReconciliationRun,
    getRiskQueue,
    decideRiskFlag
};
