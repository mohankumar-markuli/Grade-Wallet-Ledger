const crypto = require('node:crypto');
const pool = require('../config/db');

const JOB_NAME = 'nightly_reconciliation';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOTALS_SQL = [
    'SELECT',
    "  COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'debit'), 0)::text AS debit_total,",
    "  COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'credit'), 0)::text AS credit_total,",
    '  COUNT(*)::text AS ledger_entries_checked',
    'FROM ledger_entries'
].join('\n');

const TRANSFER_BALANCE_SQL = [
    'SELECT transfer.id AS transfer_id, COUNT(entry.id)::text AS entry_count,',
    "       COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'debit'), 0)::text AS debit_total,",
    "       COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'credit'), 0)::text AS credit_total",
    'FROM transfers AS transfer',
    'LEFT JOIN ledger_entries AS entry ON entry.transfer_id = transfer.id',
    "WHERE transfer.status IN ('completed', 'reversed')",
    'GROUP BY transfer.id',
    'HAVING COUNT(entry.id) > 0',
    "   AND COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'debit'), 0)",
    "       <> COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'credit'), 0)",
    'ORDER BY transfer.id'
].join('\n');

const MISSING_TRANSFER_ENTRIES_SQL = [
    'SELECT transfer.id AS transfer_id',
    'FROM transfers AS transfer',
    'LEFT JOIN ledger_entries AS entry ON entry.transfer_id = transfer.id',
    "WHERE transfer.status IN ('completed', 'reversed')",
    'GROUP BY transfer.id',
    'HAVING COUNT(entry.id) = 0',
    'ORDER BY transfer.id'
].join('\n');

const ORPHAN_ENTRIES_SQL = [
    'SELECT entry.id AS entry_id, entry.transfer_id, entry.account_id',
    'FROM ledger_entries AS entry',
    'LEFT JOIN transfers AS transfer ON transfer.id = entry.transfer_id',
    'LEFT JOIN accounts AS account ON account.id = entry.account_id',
    'WHERE transfer.id IS NULL OR account.id IS NULL',
    'ORDER BY entry.id'
].join('\n');

const ACCOUNT_BALANCES_SQL = [
    'SELECT account.id AS account_id, account.account_type,',
    '       account.balance_paise::text AS stored_balance,',
    '       COALESCE(SUM(CASE',
    "           WHEN entry.entry_type = 'credit' THEN entry.amount_paise",
    "           WHEN entry.entry_type = 'debit' THEN -entry.amount_paise",
    '           ELSE 0',
    '       END), 0)::text AS ledger_balance',
    'FROM accounts AS account',
    'LEFT JOIN ledger_entries AS entry ON entry.account_id = account.id',
    'GROUP BY account.id',
    'ORDER BY account.id'
].join('\n');

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    return value;
}

function hashRequestBody(body) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(body || {})))
        .digest('hex');
}

function differentInteger(left, right) {
    return BigInt(left) !== BigInt(right);
}

async function collectFindings(client) {
    const totals = (await client.query(TOTALS_SQL)).rows[0];
    const debitTotal = String(totals.debit_total);
    const creditTotal = String(totals.credit_total);
    const totalsMismatch = differentInteger(debitTotal, creditTotal);

    const transferRows = (await client.query(TRANSFER_BALANCE_SQL)).rows;
    const transferFindings = transferRows.map((row) => ({
        problemType: 'unbalanced_transfer',
        accountId: null,
        transferId: String(row.transfer_id),
        expectedValue: String(row.debit_total),
        actualValue: String(row.credit_total),
        details: {
            checks: ['transfer_debits_equal_credits'],
            entryCount: String(row.entry_count)
        }
    }));

    const missingRows = (await client.query(MISSING_TRANSFER_ENTRIES_SQL)).rows;
    const missingFindings = missingRows.map((row) => ({
        problemType: 'transfer_without_ledger_entries',
        accountId: null,
        transferId: String(row.transfer_id),
        expectedValue: '2',
        actualValue: '0',
        details: { checks: ['completed_transfer_has_ledger_entries'] }
    }));

    const orphanRows = (await client.query(ORPHAN_ENTRIES_SQL)).rows;
    const orphanFindings = orphanRows.map((row) => ({
        problemType: 'orphan_ledger_entry',
        accountId: row.account_id === null ? null : String(row.account_id),
        transferId: null,
        expectedValue: '1',
        actualValue: '0',
        details: {
            checks: ['ledger_entry_has_valid_parents'],
            ledgerEntryId: String(row.entry_id),
            missingTransfer: row.transfer_id === null
        }
    }));

    const transferIds = [
        ...transferFindings.map((item) => item.transferId),
        ...missingFindings.map((item) => item.transferId)
    ];
    const accountsByTransfer = new Map();
    const transfersByAccount = new Map();

    if (transferIds.length > 0) {
        const rows = (await client.query(
            [
                'SELECT DISTINCT transfer.id AS transfer_id, related.account_id',
                'FROM transfers AS transfer',
                'CROSS JOIN LATERAL (',
                '    VALUES (transfer.from_account_id), (transfer.to_account_id)',
                ') AS related(account_id)',
                'WHERE transfer.id = ANY($1::bigint[])',
                'ORDER BY transfer.id, related.account_id'
            ].join('\n'),
            [transferIds]
        )).rows;

        for (const row of rows) {
            const transferId = String(row.transfer_id);
            const accountId = String(row.account_id);
            if (!accountsByTransfer.has(transferId)) {
                accountsByTransfer.set(transferId, []);
            }
            accountsByTransfer.get(transferId).push(accountId);
            if (!transfersByAccount.has(accountId)) {
                transfersByAccount.set(accountId, []);
            }
            transfersByAccount.get(accountId).push(transferId);
        }
    }

    const accountRows = (await client.query(ACCOUNT_BALANCES_SQL)).rows;
    const independentAccountFindings = [];
    const accountFindingsByTransfer = new Map();

    for (const row of accountRows) {
        const accountId = String(row.account_id);
        const ledgerBalance = String(row.ledger_balance);
        const storedBalance = String(row.stored_balance);
        const balanceMismatch = differentInteger(ledgerBalance, storedBalance);
        const overdraft = row.account_type === 'wallet'
            && BigInt(ledgerBalance) < 0n;

        if (!balanceMismatch && !overdraft) {
            continue;
        }

        const finding = {
            accountId,
            expectedValue: ledgerBalance,
            actualValue: storedBalance,
            details: {
                checks: [
                    ...(balanceMismatch ? ['stored_balance_matches_ledger'] : []),
                    ...(overdraft ? ['wallet_ledger_balance_nonnegative'] : [])
                ],
                accountType: row.account_type,
                ledgerBalance,
                storedBalance
            }
        };
        const relatedTransfers = transfersByAccount.get(accountId) || [];

        if (relatedTransfers.length === 0) {
            independentAccountFindings.push({
                ...finding,
                problemType: overdraft
                    ? 'wallet_ledger_overdraft'
                    : 'stored_balance_mismatch'
            });
        } else {
            for (const transferId of relatedTransfers) {
                if (!accountFindingsByTransfer.has(transferId)) {
                    accountFindingsByTransfer.set(transferId, []);
                }
                accountFindingsByTransfer.get(transferId).push(finding);
            }
        }
    }

    const transferFindingsById = new Map(
        transferFindings.map((finding) => [finding.transferId, finding])
    );
    const missingFindingsById = new Map(
        missingFindings.map((finding) => [finding.transferId, finding])
    );
    const rootFindings = [
        ...transferFindings,
        ...missingFindings,
        ...orphanFindings,
        ...independentAccountFindings
    ];

    for (const [transferId, findings] of accountFindingsByTransfer.entries()) {
        const root = transferFindingsById.get(transferId)
            || missingFindingsById.get(transferId);
        if (root) {
            root.details.accountBalanceFindings = findings.map((finding) => ({
                accountId: finding.accountId,
                ...finding.details
            }));
        }
    }

    if (totalsMismatch) {
        const root = transferFindings[0]
            || missingFindings[0]
            || orphanFindings[0];
        const globalTotals = { debitTotal, creditTotal };
        if (root) {
            root.details.checks = [
                ...new Set([...root.details.checks, 'global_debits_equal_credits'])
            ];
            root.details.globalLedgerTotals = globalTotals;
        } else {
            rootFindings.push({
                problemType: 'ledger_totals_mismatch',
                accountId: null,
                transferId: null,
                expectedValue: debitTotal,
                actualValue: creditTotal,
                details: {
                    checks: ['global_debits_equal_credits'],
                    ...globalTotals
                }
            });
        }
    }

    const completedTransferCount = (await client.query(
        [
            'SELECT COUNT(*)::text AS count',
            'FROM transfers',
            "WHERE status IN ('completed', 'reversed')"
        ].join('\n')
    )).rows[0].count;

    return {
        findings: rootFindings,
        totals: {
            debitTotal,
            creditTotal,
            ledgerEntriesChecked: String(totals.ledger_entries_checked)
        },
        counts: {
            transfersChecked: String(completedTransferCount),
            accountsChecked: String(accountRows.length),
            ledgerEntriesChecked: String(totals.ledger_entries_checked)
        },
        checks: {
            globalDebitsEqualCredits: !totalsMismatch,
            transfersBalanced: transferFindings.length === 0
                && missingFindings.length === 0,
            storedBalancesMatchLedger: accountRows.every((row) => (
                !differentInteger(row.ledger_balance, row.stored_balance)
            )),
            walletLedgerBalancesNonnegative: accountRows.every((row) => (
                row.account_type !== 'wallet'
                || BigInt(row.ledger_balance) >= 0n
            )),
            noOrphanedRecords: missingFindings.length === 0
                && orphanFindings.length === 0
        }
    };
}

async function insertFindings(client, runId, findings) {
    for (const finding of findings) {
        await client.query(
            [
                'INSERT INTO reconciliation_problems',
                '    (run_id, account_id, transfer_id, problem_type,',
                '     expected_value, actual_value, details)',
                'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)'
            ].join('\n'),
            [
                runId,
                finding.accountId,
                finding.transferId,
                finding.problemType,
                finding.expectedValue,
                finding.actualValue,
                JSON.stringify(finding.details)
            ]
        );
    }
}

async function saveFailedRun(client, error) {
    try {
        await client.query(
            [
                'INSERT INTO reconciliation_runs (status, completed_at, summary)',
                "VALUES ('failed', clock_timestamp(), $1::jsonb)"
            ].join('\n'),
            [JSON.stringify({
                errorCode: error.code || 'RECONCILIATION_FAILED'
            })]
        );
    } catch (recordError) {
        // Keep the original failure if the database cannot record this run.
    }
}

async function runReconciliation({
    idempotencyKey = null,
    requestBody = {}
} = {}) {
    if (
        idempotencyKey !== null
        && (typeof idempotencyKey !== 'string' || !UUID_PATTERN.test(idempotencyKey))
    ) {
        throw Object.assign(
            new Error('A valid UUID Idempotency-Key header is required.'),
            { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }
        );
    }

    const requestHash = idempotencyKey === null
        ? null
        : hashRequestBody(requestBody);
    const client = await pool.connect();
    let transactionStarted = false;
    let runCreated = false;

    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        transactionStarted = true;

        const lockResult = await client.query(
            [
                'SELECT job_name',
                'FROM job_locks',
                'WHERE job_name = $1',
                'FOR UPDATE NOWAIT'
            ].join('\n'),
            [JOB_NAME]
        );

        if (lockResult.rowCount !== 1) {
            throw Object.assign(
                new Error('The reconciliation lock row is missing. Apply the latest migration.'),
                { status: 503, code: 'RECONCILIATION_LOCK_MISSING' }
            );
        }

        if (idempotencyKey !== null) {
            const previousResult = await client.query(
                [
                    'SELECT request_hash, response_body',
                    'FROM reconciliation_runs',
                    'WHERE idempotency_key = $1',
                    'FOR UPDATE'
                ].join('\n'),
                [idempotencyKey]
            );

            if (previousResult.rowCount > 0) {
                const previous = previousResult.rows[0];
                if (previous.request_hash !== requestHash) {
                    throw Object.assign(
                        new Error('This Idempotency-Key was already used with a different request body.'),
                        { status: 422, code: 'IDEMPOTENCY_KEY_REUSED' }
                    );
                }

                await client.query('COMMIT');
                transactionStarted = false;
                return {
                    status: 200,
                    body: previous.response_body,
                    replayed: true
                };
            }
        }

        const insertedRun = await client.query(
            [
                'INSERT INTO reconciliation_runs',
                '    (status, idempotency_key, request_hash)',
                "VALUES ('running', $1, $2)",
                'RETURNING id, started_at'
            ].join('\n'),
            [idempotencyKey, requestHash]
        );
        const runId = String(insertedRun.rows[0].id);
        const startedAt = insertedRun.rows[0].started_at.toISOString();
        runCreated = true;

        const result = await collectFindings(client);
        await insertFindings(client, runId, result.findings);

        const completedAt = new Date().toISOString();
        const responseBody = JSON.parse(JSON.stringify({
            data: {
                runId,
                status: 'completed',
                startedAt,
                completedAt,
                counts: result.counts,
                totals: result.totals,
                checks: result.checks,
                problems: result.findings
            }
        }));
        const summary = JSON.parse(JSON.stringify({
            counts: result.counts,
            totals: result.totals,
            checks: result.checks
        }));

        await client.query(
            [
                'UPDATE reconciliation_runs',
                "SET status = 'completed',",
                '    completed_at = $1,',
                '    accounts_checked = $2,',
                '    problems_found = $3,',
                '    summary = $4::jsonb,',
                '    response_body = $5::jsonb',
                'WHERE id = $6'
            ].join('\n'),
            [
                completedAt,
                result.counts.accountsChecked,
                result.findings.length,
                JSON.stringify(summary),
                JSON.stringify(responseBody),
                runId
            ]
        );
        await client.query('COMMIT');
        transactionStarted = false;

        return { status: 200, body: responseBody, replayed: false };
    } catch (error) {
        if (transactionStarted) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                // Preserve the original error for the caller.
            }
            transactionStarted = false;
        }

        if (error.code === '55P03') {
            return {
                status: 409,
                body: {
                    error: {
                        code: 'RECONCILIATION_IN_PROGRESS',
                        message: 'A reconciliation run is already in progress.'
                    }
                },
                replayed: false
            };
        }

        if (runCreated) {
            await saveFailedRun(client, error);
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    hashRequestBody,
    runReconciliation
};
