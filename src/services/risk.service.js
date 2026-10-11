const pool = require('../config/db');

// Called with the transfer's PostgreSQL transaction client after source and
// destination accounts have been locked. It performs no network requests.
async function evaluateTransferRisk(client, {
    sourceAccountId,
    amountPaise,
    checkVelocity = true
}) {
    const rules = await client.query(
        `SELECT id, rule_code, description, configuration
         FROM risk_rules WHERE enabled = TRUE ORDER BY id FOR SHARE`
    );
    const findings = [];

    for (const rule of rules.rows) {
        const config = rule.configuration || {};
        if (rule.rule_code === 'single_transfer_amount') {
            const threshold = config.threshold_paise;
            if (/^[1-9]\d*$/.test(String(threshold)) &&
                BigInt(amountPaise) >= BigInt(threshold)) {
                findings.push({ rule, details: {
                    amountPaise: String(amountPaise), thresholdPaise: String(threshold)
                } });
            }
        }
        if (rule.rule_code === 'source_transfer_velocity' && checkVelocity) {
            const maximum = Number(config.max_transfers);
            const seconds = Number(config.window_seconds);
            if (Number.isInteger(maximum) && maximum > 0 &&
                Number.isInteger(seconds) && seconds > 0) {
                const count = await client.query(
                    `SELECT COUNT(*)::integer AS count
                     FROM transfers
                     WHERE from_account_id = $1
                       AND status IN ('completed', 'held')
                       AND created_at >= NOW() - ($2::integer * INTERVAL '1 second')`,
                    [sourceAccountId, seconds]
                );
                const observed = Number(count.rows[0].count) + 1;
                if (observed >= maximum) {
                    findings.push({ rule, details: {
                        observedTransfers: observed, maximumTransfers: maximum,
                        windowSeconds: seconds
                    } });
                }
            }
        }
    }
    return findings;
}

async function insertRiskFlags(client, { userId, accountId, transferId, findings, held }) {
    for (const finding of findings) {
        await client.query(
            `INSERT INTO risk_flags
                (user_id, account_id, transfer_id, rule_id, rule_code,
                 severity, status, decision, details)
             VALUES ($1,$2,$3,$4,$5,'high',$6,$7,$8::jsonb)`,
            [userId, accountId, transferId, finding.rule.id,
                finding.rule.rule_code, held ? 'open' : 'open',
                held ? 'held' : 'allowed_with_flag',
                JSON.stringify(finding.details)]
        );
    }
}

async function listRiskQueue({ limit = 100 }) {
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 250);
    return (await pool.query(
        `SELECT flag.id AS flag_id, flag.rule_code, flag.severity,
                flag.status AS flag_status, flag.decision, flag.details,
                flag.created_at, transfer.id AS transfer_id,
                transfer.status AS transfer_status, transfer.amount_paise,
                transfer.from_account_id, transfer.to_account_id,
                flag.user_id AS user_id
         FROM risk_flags AS flag
         JOIN transfers AS transfer ON transfer.id = flag.transfer_id
         JOIN accounts AS source ON source.id = transfer.from_account_id
         WHERE flag.status IN ('open','reviewing')
         ORDER BY flag.created_at DESC, flag.id DESC LIMIT $1`, [bounded]
    )).rows;
}

module.exports = {
    evaluateTransferRisk,
    evaluatePeerTransferRisk: evaluateTransferRisk,
    insertRiskFlags,
    listRiskQueue
};
