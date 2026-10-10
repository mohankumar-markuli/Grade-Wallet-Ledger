
const crypto = require('node:crypto');

jest.mock('../src/config/db', () => {
    const { Pool } = require('pg');
    const { validateEnv } = require('../src/config/env');
    const config = validateEnv();

    return new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 5000,
        max: 5,
    });
});

const pool = require('../src/config/db');
const { topUpWallet } = require('../src/repositories/topup.repository');

describe('Top-up PostgreSQL integration', () => {
    let userId;
    let walletId;
    let fundingAccountId;
    let originalFundingBalance;
    let transferId;
    let idempotencyKey;

    beforeAll(async () => {
        // Never run these integration tests against the development database.
        const databaseResult = await pool.query(
            'SELECT current_database() AS name'
        );

        if (databaseResult.rows[0].name !== 'wallet_test_db') {
            throw new Error(
                `Integration tests require wallet_test_db, not ${databaseResult.rows[0].name}.`
            );
        }

        const funding = await pool.query(
            `SELECT id, balance_paise
             FROM accounts
             WHERE account_type = 'external_funding'
               AND status = 'active'
             ORDER BY id
             LIMIT 1`
        );

        if (funding.rowCount !== 1) {
            throw new Error(
                'Expected an active external-funding account in the test database.'
            );
        }

        fundingAccountId = String(funding.rows[0].id);
        originalFundingBalance = BigInt(funding.rows[0].balance_paise);

        const user = await pool.query(
            `INSERT INTO users (email, full_name)
             VALUES ($1, $2)
             RETURNING id`,
            [
                `topup-integration-${crypto.randomUUID()}@example.test`,
                'Top-up Integration Test',
            ]
        );

        userId = String(user.rows[0].id);

        const wallet = await pool.query(
            `INSERT INTO accounts (user_id, account_type)
             VALUES ($1, 'wallet')
             RETURNING id`,
            [userId]
        );

        walletId = String(wallet.rows[0].id);
        idempotencyKey = `integration-${crypto.randomUUID()}`;

        // Start this test fixture from a known state.
        await pool.query(
            'UPDATE accounts SET balance_paise = 0 WHERE id = $1',
            [walletId]
        );

        await pool.query(
            'UPDATE accounts SET balance_paise = 0 WHERE id = $1',
            [fundingAccountId]
        );
    });

    afterAll(async () => {
        const cleanupClient = await pool.connect();
        let transactionStarted = false;

        try {
            const databaseResult = await cleanupClient.query(
                'SELECT current_database() AS name'
            );

            if (databaseResult.rows[0].name !== 'wallet_test_db') {
                throw new Error(
                    'Safety check failed: integration cleanup must use wallet_test_db.'
                );
            }

            await cleanupClient.query('BEGIN');
            transactionStarted = true;

            // Remove any test-only trigger left behind by a previous run.
            await cleanupClient.query(
                'DROP TRIGGER IF EXISTS test_force_wallet_update_failure ON accounts'
            );

            await cleanupClient.query(
                'DROP FUNCTION IF EXISTS test_fail_wallet_update()'
            );

            // Test fixture deletion is the only place that bypasses the
            // production append-only rule. The transaction ensures a failure
            // rolls back and restores the trigger state.
            await cleanupClient.query(
                'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'
            );

            if (userId) {
                await cleanupClient.query(
                    'DELETE FROM idempotency_keys WHERE user_id = $1',
                    [userId]
                );
            }

            if (walletId) {
                await cleanupClient.query(
                    'DELETE FROM ledger_entries WHERE account_id = $1',
                    [walletId]
                );

                await cleanupClient.query(
                    `DELETE FROM transfer_status_audit
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = $1 OR to_account_id = $1
                     )`,
                    [walletId]
                );

                await cleanupClient.query(
                    `DELETE FROM ledger_entries
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = $1 OR to_account_id = $1
                     )`,
                    [walletId]
                );

                await cleanupClient.query(
                    `DELETE FROM idempotency_keys
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = $1 OR to_account_id = $1
                     )`,
                    [walletId]
                );

                await cleanupClient.query(
                    `DELETE FROM transfers
                     WHERE from_account_id = $1 OR to_account_id = $1`,
                    [walletId]
                );

                await cleanupClient.query(
                    'DELETE FROM accounts WHERE id = $1',
                    [walletId]
                );
            }

            if (userId) {
                await cleanupClient.query(
                    'DELETE FROM users WHERE id = $1',
                    [userId]
                );
            }

            // Restore the funding account's original balance.
            if (
                fundingAccountId !== undefined &&
                originalFundingBalance !== undefined
            ) {
                await cleanupClient.query(
                    `UPDATE accounts
                     SET balance_paise = $1::bigint
                     WHERE id = $2`,
                    [originalFundingBalance.toString(), fundingAccountId]
                );
            }

            await cleanupClient.query(
                'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only'
            );
            await cleanupClient.query('COMMIT');
            transactionStarted = false;
        } finally {
            try {
                if (transactionStarted) {
                    await cleanupClient.query('ROLLBACK');
                }
            } finally {
                cleanupClient.release();
                await pool.end();
            }
        }
    });

    test('creates a balanced top-up and replays it idempotently', async () => {
        const first = await topUpWallet({
            walletId,
            userId,
            amountPaise: '5000',
            idempotencyKey,
        });

        expect(first.status).toBe(201);
        expect(first.replayed).toBe(false);

        transferId = String(first.body.data.transfer.id);

        const accounts = await pool.query(
            `SELECT id, balance_paise
             FROM accounts
             WHERE id = ANY($1::bigint[])
             ORDER BY id`,
            [[walletId, fundingAccountId]]
        );

        const balances = Object.fromEntries(
            accounts.rows.map((row) => [
                String(row.id),
                BigInt(row.balance_paise),
            ])
        );

        expect(balances[walletId]).toBe(5000n);
        expect(balances[fundingAccountId]).toBe(-5000n);

        const ledger = await pool.query(
            `SELECT account_id, entry_type, amount_paise
             FROM ledger_entries
             WHERE transfer_id = $1
             ORDER BY id`,
            [transferId]
        );

        expect(ledger.rows).toHaveLength(2);

        expect(
            ledger.rows.map((row) => row.entry_type).sort()
        ).toEqual(['credit', 'debit']);

        expect(
            ledger.rows.every(
                (row) => BigInt(row.amount_paise) === 5000n
            )
        ).toBe(true);

        // Repeating the same request must return the original result.
        const replay = await topUpWallet({
            walletId,
            userId,
            amountPaise: '5000',
            idempotencyKey,
        });

        expect(replay.status).toBe(201);
        expect(replay.replayed).toBe(true);
        expect(String(replay.body.data.transfer.id)).toBe(transferId);

        // Reusing the key for a different amount must be rejected.
        await expect(
            topUpWallet({
                walletId,
                userId,
                amountPaise: '6000',
                idempotencyKey,
            })
        ).rejects.toMatchObject({
            status: 409,
            code: 'IDEMPOTENCY_KEY_REUSED',
        });

        const counts = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM transfers WHERE id = $1) AS transfers,
                (SELECT COUNT(*) FROM ledger_entries WHERE transfer_id = $1) AS entries`,
            [transferId]
        );

        expect(counts.rows[0].transfers).toBe('1');
        expect(counts.rows[0].entries).toBe('2');
    });

    test('rolls back the entire top-up when a database operation fails', async () => {
        const key = `rollback-${crypto.randomUUID()}`;

        const before = await pool.query(
            'SELECT balance_paise FROM accounts WHERE id = $1',
            [walletId]
        );

        const balanceBefore = BigInt(before.rows[0].balance_paise);

        await pool.query(`
            CREATE FUNCTION test_fail_wallet_update()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NEW.account_type = 'wallet' THEN
                    RAISE EXCEPTION 'Forced wallet update failure for integration test';
                END IF;

                RETURN NEW;
            END;
            $$
        `);

        await pool.query(`
            CREATE TRIGGER test_force_wallet_update_failure
            BEFORE UPDATE ON accounts
            FOR EACH ROW
            EXECUTE FUNCTION test_fail_wallet_update()
        `);

        try {
            await expect(
                topUpWallet({
                    walletId,
                    userId,
                    amountPaise: '7000',
                    idempotencyKey: key,
                })
            ).rejects.toThrow('Forced wallet update failure');
        } finally {
            await pool.query(
                'DROP TRIGGER IF EXISTS test_force_wallet_update_failure ON accounts'
            );

            await pool.query(
                'DROP FUNCTION IF EXISTS test_fail_wallet_update()'
            );
        }

        const wallet = await pool.query(
            'SELECT balance_paise FROM accounts WHERE id = $1',
            [walletId]
        );

        expect(BigInt(wallet.rows[0].balance_paise)).toBe(balanceBefore);

        const idempotency = await pool.query(
            `SELECT id
             FROM idempotency_keys
             WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, key]
        );

        expect(idempotency.rowCount).toBe(0);

        const transfers = await pool.query(
            `SELECT id
             FROM transfers
             WHERE from_account_id = $1
               AND to_account_id = $2
               AND amount_paise = 7000`,
            [fundingAccountId, walletId]
        );

        expect(transfers.rowCount).toBe(0);

        const funding = await pool.query(
            'SELECT balance_paise FROM accounts WHERE id = $1',
            [fundingAccountId]
        );

        expect(BigInt(funding.rows[0].balance_paise)).toBe(-5000n);
    });
});
