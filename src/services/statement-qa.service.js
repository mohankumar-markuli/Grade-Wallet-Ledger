const crypto = require('node:crypto');
const pool = require('../config/db');
const { createLlmProvider } = require('../providers/llm-provider');

const ALLOWED_TYPES = new Set(['total_sent', 'total_received', 'largest_transfer', 'transfer_count']);
const provider = createLlmProvider();

function validDate(value) {
    if (value === null) return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateIntent(intent) {
    if (!intent || !ALLOWED_TYPES.has(intent.type) ||
        !validDate(intent.from) || !validDate(intent.to) ||
        (intent.counterparty !== null && typeof intent.counterparty !== 'string') ||
        (intent.counterparty && intent.counterparty.length > 120) ||
        (intent.from && intent.to && intent.from > intent.to)) return null;
    return intent;
}

async function answerStatementQuestion({ userId, question, idempotencyKey }) {
    // The provider receives only the question. It never receives ledger data or SQL.
    const intent = validateIntent(await provider.parseStatementQuestion({ question }));
    if (!intent) return persistResponse({ userId, question, idempotencyKey, result: { status: 422, body: { error: {
        code: 'UNSUPPORTED_QUESTION',
        message: 'Ask about total sent, total received, largest transfer, or transfer count for a date range.'
    } } } });

    const params = [userId];
    const filters = ["transfer.status = 'completed'"];
    if (intent.type === 'total_sent') filters.push('transfer.from_account_id = wallet.id');
    if (intent.type === 'total_received') filters.push('transfer.to_account_id = wallet.id');
    if (intent.type === 'largest_transfer' || intent.type === 'transfer_count') {
        filters.push('(transfer.from_account_id = wallet.id OR transfer.to_account_id = wallet.id)');
    }
    if (intent.from) {
        params.push(intent.from);
        filters.push(`transfer.created_at >= ($${params.length}::date AT TIME ZONE 'UTC')`);
    }
    if (intent.to) {
        params.push(intent.to);
        filters.push(`transfer.created_at < (($${params.length}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`);
    }
    if (intent.counterparty) {
        params.push(`%${intent.counterparty}%`);
        const counterpartyAccount = intent.type === 'total_received'
            ? 'transfer.from_account_id' : 'transfer.to_account_id';
        filters.push(`EXISTS (
            SELECT 1 FROM accounts AS other_wallet
            JOIN users AS other_user ON other_user.id = other_wallet.user_id
            WHERE other_wallet.id = ${counterpartyAccount}
              AND other_user.full_name ILIKE $${params.length}
        )`);
    }
    const sort = intent.type === 'largest_transfer'
        ? 'transfer.amount_paise DESC, transfer.id DESC'
        : 'transfer.created_at DESC, transfer.id DESC';
    const limit = intent.type === 'largest_transfer' ? 'LIMIT 1' : '';
    const sql = `SELECT DISTINCT transfer.id::text AS transfer_id,
                        transfer.amount_paise::text AS amount_paise
                 FROM accounts AS wallet
                 JOIN transfers AS transfer ON
                    (transfer.from_account_id = wallet.id OR transfer.to_account_id = wallet.id)
                 WHERE wallet.user_id = $1 AND wallet.account_type = 'wallet'
                   AND ${filters.join(' AND ')}
                 ORDER BY ${sort} ${limit}`;
    const rows = (await pool.query(sql, params)).rows;
    const total = rows.reduce((value, row) => value + BigInt(row.amount_paise), 0n).toString();
    let data;
    if (intent.type === 'transfer_count') data = { type: intent.type, count: rows.length };
    else if (intent.type === 'largest_transfer') data = {
        type: intent.type, amountPaise: rows[0]?.amount_paise || '0', count: rows.length
    };
    else data = { type: intent.type, amountPaise: total, count: rows.length };
    return persistResponse({ userId, question, idempotencyKey, result: { status: 200, body: { data: {
        ...data, transferIds: rows.map(row => row.transfer_id)
    } } } });
}

async function persistResponse({ userId, question, idempotencyKey, result }) {
    const hash = crypto.createHash('sha256').update(JSON.stringify({ operation: 'statement-question', question })).digest('hex');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO idempotency_keys (user_id,idempotency_key,request_hash)
             VALUES ($1,$2,$3) ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING id`,
            [userId,idempotencyKey,hash]
        );
        if (!inserted.rowCount) {
            const saved = (await client.query(
                'SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE',
                [userId,idempotencyKey]
            )).rows[0];
            if (!saved || saved.request_hash !== hash) {
                const err = Object.assign(new Error('This Idempotency-Key was already used for a different request.'), { status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
                throw err;
            }
            if (!saved.response_body) {
                const err = Object.assign(new Error('The original request is incomplete.'), { status: 409, code: 'IDEMPOTENCY_REQUEST_INCOMPLETE' });
                throw err;
            }
            await client.query('COMMIT');
            return { status: saved.response_status, body: saved.response_body, replayed: true };
        }
        await client.query(
            'UPDATE idempotency_keys SET response_status=$1,response_body=$2::jsonb WHERE user_id=$3 AND idempotency_key=$4',
            [result.status,JSON.stringify(result.body),userId,idempotencyKey]
        );
        await client.query('COMMIT');
        return { ...result, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

module.exports = { answerStatementQuestion, validateIntent };

