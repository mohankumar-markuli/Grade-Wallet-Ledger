const crypto = require('node:crypto');

jest.mock('../src/config/db', () => {
    const { Pool } = require('pg');
    const { validateEnv } = require('../src/config/env');
    const config = validateEnv();
    return new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 12
    });
});

const pool = require('../src/config/db');
const {
    runReconciliation
} = require('../src/repositories/reconciliation.repository');

jest.setTimeout(120000);

const INSERT_TRANSFER_SQL = [
    'INSERT INTO transfers',
    '    (from_account_id, to_account_id, amount_paise, currency,',
    '     status, description, completed_at, transfer_type)',
    "VALUES ($1, $2, 100, 'INR', 'completed', $3, NOW(), 'top_up')",
    'RETURNING id'
].join('\n');

const INSERT_ENTRIES_SQL = [
    'INSERT INTO ledger_entries',
    '    (transfer_id, account_id, entry_type, amount_paise)',
    'VALUES',
    "    ($1, $2, 'debit', 100),",
    "    ($1, $3, 'credit', 100)"
].join('\n');

describe('reconciliation PostgreSQL acceptance test', () => {
    let fundingAccountId;
    let fundingBalanceBefore;
    let completedTransfersBefore;
    let ledgerEntriesBefore;
    let userId;
    let walletIds = [];
    let transferIds = [];
    let runId;
    let setupComplete = false;

    async function createTransfer(client, destinationWalletId, description) {
        const transferResult = await client.query(
            INSERT_TRANSFER_SQL,
            [fundingAccountId, destinationWalletId, description]
        );
        const id = String(transferResult.rows[0].id);
        await client.query(
            INSERT_ENTRIES_SQL,
            [id, fundingAccountId, destinationWalletId]
        );
        return id;
    }

    beforeAll(async () => {
        const dbResult = await pool.query(
            'SELECT current_database() AS name'
        );
        if (dbResult.rows[0].name !== 'wallet_test_db') {
            throw new Error(
                'Safety check failed: reconciliation tests must use wallet_test_db.'
            );
        }

        const baselineResult = await pool.query(
            [
                'SELECT',
                '    (SELECT COUNT(*)::text FROM transfers',
                "     WHERE status IN ('completed', 'reversed')) AS completed_transfers,",
                '    (SELECT COUNT(*)::text FROM ledger_entries) AS ledger_entries'
            ].join('\n')
        );
        completedTransfersBefore = baselineResult.rows[0].completed_transfers;
        ledgerEntriesBefore = baselineResult.rows[0].ledger_entries;

        const lockResult = await pool.query(
            [
                'SELECT 1 FROM job_locks',
                "WHERE job_name = 'nightly_reconciliation'"
            ].join('\n')
        );
        if (lockResult.rowCount !== 1) {
            throw new Error(
                'Migration 012 is required before reconciliation tests can run.'
            );
        }

        const fundingResult = await pool.query(
            [
                'SELECT id, balance_paise',
                'FROM accounts',
                "WHERE account_type = 'external_funding' AND status = 'active'",
                'ORDER BY id',
                'LIMIT 1'
            ].join('\n')
        );
        if (fundingResult.rowCount !== 1) {
            throw new Error('wallet_test_db needs an active cash-in account.');
        }
        fundingAccountId = String(fundingResult.rows[0].id);
        fundingBalanceBefore = String(fundingResult.rows[0].balance_paise);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userResult = await client.query(
                [
                    'INSERT INTO users (email, full_name, phone, kyc_status)',
                    "VALUES ($1, 'Reconciliation Acceptance', $2, 'pending')",
                    'RETURNING id'
                ].join('\n'),
                [
                    'reconciliation-' + crypto.randomUUID() + '@example.test',
                    '+91' + Date.now() + '31'
                ]
            );
            userId = String(userResult.rows[0].id);

            for (let index = 0; index < 3; index += 1) {
                const walletResult = await client.query(
                    [
                        'INSERT INTO accounts',
                        '    (user_id, account_type, account_name, currency, balance_paise)',
                        "VALUES ($1, 'wallet', $2, 'INR', 0)",
                        'RETURNING id'
                    ].join('\n'),
                    [userId, 'reconciliation-' + index]
                );
                walletIds.push(String(walletResult.rows[0].id));
            }

            const baseTransferResult = await client.query(
                [
                    'INSERT INTO transfers',
                    '    (from_account_id, to_account_id, amount_paise, currency,',
                    '     status, description, completed_at, transfer_type)',
                    "SELECT $1, $2, 100, 'INR', 'completed',",
                    "       'reconciliation acceptance base', NOW(), 'top_up'",
                    'FROM generate_series(1, 9998)',
                    'RETURNING id'
                ].join('\n'),
                [fundingAccountId, walletIds[0]]
            );
            const baseIds = baseTransferResult.rows.map((row) => String(row.id));

            await client.query(
                [
                    'INSERT INTO ledger_entries',
                    '    (transfer_id, account_id, entry_type, amount_paise)',
                    'SELECT transfer.transfer_id, item.account_id, item.entry_type, 100',
                    'FROM unnest($1::bigint[]) AS transfer(transfer_id)',
                    'CROSS JOIN LATERAL (',
                    "    VALUES ($2::bigint, 'debit'::varchar),",
                    "           ($3::bigint, 'credit'::varchar)",
                    ') AS item(account_id, entry_type)'
                ].join('\n'),
                [baseIds, fundingAccountId, walletIds[0]]
            );
            transferIds.push(...baseIds);

            const amountTransferId = await createTransfer(
                client,
                walletIds[1],
                'reconciliation amount corruption'
            );
            const deletedCreditTransferId = await createTransfer(
                client,
                walletIds[2],
                'reconciliation deleted credit'
            );
            transferIds.push(amountTransferId, deletedCreditTransferId);

            await client.query(
                [
                    'UPDATE accounts',
                    'SET balance_paise = balance_paise - 1000000',
                    'WHERE id = $1'
                ].join('\n'),
                [fundingAccountId]
            );
            await client.query(
                [
                    'UPDATE accounts',
                    'SET balance_paise = balance_paise + 999800',
                    'WHERE id = $1'
                ].join('\n'),
                [walletIds[0]]
            );
            await client.query(
                [
                    'UPDATE accounts',
                    'SET balance_paise = balance_paise + 100',
                    'WHERE id = ANY($1::bigint[])'
                ].join('\n'),
                [[walletIds[1], walletIds[2]]]
            );
            await client.query('COMMIT');
            setupComplete = true;

            await client.query('BEGIN');
            await client.query(
                'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'
            );
            await client.query(
                'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_balance_transfer'
            );
            await client.query(
                [
                    'UPDATE ledger_entries SET amount_paise = 200',
                    "WHERE transfer_id = $1 AND entry_type = 'debit'"
                ].join('\n'),
                [amountTransferId]
            );
            await client.query(
                [
                    'DELETE FROM ledger_entries',
                    "WHERE transfer_id = $1 AND entry_type = 'credit'"
                ].join('\n'),
                [deletedCreditTransferId]
            );
            await client.query(
                'UPDATE accounts SET balance_paise = balance_paise + 1 WHERE id = $1',
                [walletIds[0]]
            );
            await client.query(
                'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_balance_transfer'
            );
            await client.query(
                'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only'
            );
            await client.query('COMMIT');
        } finally {
            try {
                await client.query('ROLLBACK');
            } catch (error) {
                // A rollback after a successful commit is harmless.
            }
            client.release();
        }
    });

    afterAll(async () => {
        const client = await pool.connect();
        try {
            const dbResult = await client.query(
                'SELECT current_database() AS name'
            );
            if (dbResult.rows[0].name !== 'wallet_test_db') {
                throw new Error(
                    'Safety check failed: reconciliation cleanup must use wallet_test_db.'
                );
            }

            if (setupComplete) {
                await client.query('BEGIN');
                if (runId) {
                    await client.query(
                        'DELETE FROM reconciliation_problems WHERE run_id = $1',
                        [runId]
                    );
                    await client.query(
                        'DELETE FROM reconciliation_runs WHERE id = $1',
                        [runId]
                    );
                }
                await client.query(
                    'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'
                );
                await client.query(
                    'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_balance_transfer'
                );
                if (transferIds.length > 0) {
                    await client.query(
                        'DELETE FROM ledger_entries WHERE transfer_id = ANY($1::bigint[])',
                        [transferIds]
                    );
                    await client.query(
                        'DELETE FROM transfer_status_audit WHERE transfer_id = ANY($1::bigint[])',
                        [transferIds]
                    );
                    await client.query(
                        'DELETE FROM transfers WHERE id = ANY($1::bigint[])',
                        [transferIds]
                    );
                }
                if (walletIds.length > 0) {
                    await client.query(
                        'DELETE FROM accounts WHERE id = ANY($1::bigint[])',
                        [walletIds]
                    );
                }
                if (userId) {
                    await client.query('DELETE FROM users WHERE id = $1', [userId]);
                }
                await client.query(
                    'UPDATE accounts SET balance_paise = $1 WHERE id = $2',
                    [fundingBalanceBefore, fundingAccountId]
                );
                await client.query(
                    'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_balance_transfer'
                );
                await client.query(
                    'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only'
                );
                await client.query('COMMIT');
            }
        } finally {
            try {
                await client.query('ROLLBACK');
            } catch (error) {
                // A rollback after a successful commit is harmless.
            }
            client.release();
            await pool.end();
        }
    });

    test('reports the three intentional corruptions and no unrelated problems', async () => {
        const adminKey = crypto.randomUUID();
        const result = await runReconciliation({
            idempotencyKey: adminKey,
            requestBody: {}
        });
        runId = result.body.data.runId;

        expect(result.status).toBe(200);
        expect(result.body.data.checks.globalDebitsEqualCredits).toBe(false);
        expect(result.body.data.checks.transfersBalanced).toBe(false);
        expect(result.body.data.checks.storedBalancesMatchLedger).toBe(false);
        expect(result.body.data.checks.walletLedgerBalancesNonnegative).toBe(true);
        expect(result.body.data.checks.noOrphanedRecords).toBe(true);
        expect(BigInt(result.body.data.counts.transfersChecked)).toBe(
            BigInt(completedTransfersBefore) + 10000n
        );
        expect(BigInt(result.body.data.counts.ledgerEntriesChecked)).toBe(
            BigInt(ledgerEntriesBefore) + 19999n
        );
        expect(result.body.data.problems).toHaveLength(3);
        expect(
            result.body.data.problems.filter((problem) => (
                problem.problemType === 'unbalanced_transfer'
            ))
        ).toHaveLength(2);
        expect(
            result.body.data.problems.filter((problem) => (
                problem.problemType === 'stored_balance_mismatch'
            ))
        ).toHaveLength(1);

        const replay = await runReconciliation({
            idempotencyKey: adminKey,
            requestBody: {}
        });
        expect(replay.replayed).toBe(true);
        expect(replay.body).toEqual(result.body);

        await expect(runReconciliation({
            idempotencyKey: adminKey,
            requestBody: { changed: true }
        })).rejects.toMatchObject({
            status: 422,
            code: 'IDEMPOTENCY_KEY_REUSED'
        });
    });
});
