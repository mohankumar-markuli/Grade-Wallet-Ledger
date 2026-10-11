const crypto = require('node:crypto');
const pool = require('../config/db');
function error(message, status, code) { return Object.assign(new Error(message), { status, code }); }
async function decideHeldTransfer({ transferId, decision, idempotencyKey }) {
    if (!['release', 'reverse'].includes(decision)) throw error('Decision must be release or reverse.', 400, 'VALIDATION_ERROR');
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ transferId: String(transferId), decision })).digest('hex');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const key = await client.query(`INSERT INTO admin_risk_decisions (idempotency_key, request_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [idempotencyKey, requestHash]);
        if (!key.rowCount) {
            const saved = (await client.query('SELECT request_hash,response_status,response_body FROM admin_risk_decisions WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey])).rows[0];
            if (saved.request_hash !== requestHash) throw error('This Idempotency-Key was used for a different decision.', 422, 'IDEMPOTENCY_KEY_REUSED');
            if (!saved.response_body) throw error('The original decision is still processing.', 409, 'IDEMPOTENCY_REQUEST_INCOMPLETE');
            await client.query('COMMIT');
            return { status: saved.response_status, body: saved.response_body, replayed: true };
        }
        const found = await client.query('SELECT * FROM transfers WHERE id=$1 FOR UPDATE', [transferId]);
        const transfer = found.rows[0];
        if (!transfer) throw error('Transfer not found.', 404, 'TRANSFER_NOT_FOUND');
        if (transfer.status !== 'held') throw error('Only a held transfer can receive a decision.', 409, 'TRANSFER_NOT_HELD');
        let response;
        if (decision === 'reverse') {
            await client.query("UPDATE transfers SET status='failed' WHERE id=$1", [transfer.id]);
            await client.query("INSERT INTO transfer_status_audit (transfer_id,old_status,new_status,reason) VALUES ($1,'held','failed','Administrator rejected held transfer')", [transfer.id]);
            await client.query("UPDATE risk_flags SET status='resolved',review_decision='rejected',decided_at=NOW(),resolved_at=NOW() WHERE transfer_id=$1 AND status IN ('open','reviewing')", [transfer.id]);
            response = { data: { transferId: String(transfer.id), status: 'failed', decision: 'reverse' } };
        } else {
            const accountIds = [String(transfer.from_account_id), String(transfer.to_account_id)].sort((a,b) => BigInt(a)<BigInt(b) ? -1 : 1);
            const accounts = await client.query('SELECT id,account_type,balance_paise,status FROM accounts WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [accountIds]);
            const source = accounts.rows.find(a => String(a.id)===String(transfer.from_account_id));
            const destination = accounts.rows.find(a => String(a.id)===String(transfer.to_account_id));
            if (!source || !destination || source.status!=='active' || destination.status!=='active') throw error('Both accounts must be active.', 409, 'ACCOUNT_NOT_ACTIVE');
            if (source.account_type==='wallet' && BigInt(source.balance_paise)<BigInt(transfer.amount_paise)) throw error('Insufficient wallet balance to release held transfer.', 409, 'INSUFFICIENT_FUNDS');
            await client.query(`INSERT INTO ledger_entries (transfer_id,account_id,entry_type,amount_paise) VALUES ($1,$2,'debit',$3),($1,$4,'credit',$3)`, [transfer.id, source.id, transfer.amount_paise, destination.id]);
            await client.query('UPDATE accounts SET balance_paise=balance_paise-$1::bigint WHERE id=$2', [transfer.amount_paise,source.id]);
            await client.query('UPDATE accounts SET balance_paise=balance_paise+$1::bigint WHERE id=$2', [transfer.amount_paise,destination.id]);
            const updated = await client.query("UPDATE transfers SET status='completed',completed_at=NOW() WHERE id=$1 RETURNING id,status,amount_paise,from_account_id,to_account_id,completed_at", [transfer.id]);
            await client.query("INSERT INTO transfer_status_audit (transfer_id,old_status,new_status,reason) VALUES ($1,'held','completed','Administrator released held transfer')", [transfer.id]);
            await client.query("UPDATE risk_flags SET status='resolved',review_decision='released',decided_at=NOW(),resolved_at=NOW() WHERE transfer_id=$1 AND status IN ('open','reviewing')", [transfer.id]);
            response = { data: { transfer: updated.rows[0], decision: 'release' } };
        }
        await client.query('UPDATE admin_risk_decisions SET response_status=200,response_body=$1::jsonb WHERE idempotency_key=$2', [JSON.stringify(response),idempotencyKey]);
        await client.query('COMMIT');
        return { status: 200, body: response, replayed: false };
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
}
module.exports = { decideHeldTransfer };
