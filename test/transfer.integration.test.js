
const crypto = require('node:crypto');

jest.mock('../src/config/db', () => {
    const { Pool } = require('pg');
    const { validateEnv } = require('../src/config/env');
    const config = validateEnv();

    return new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 5000,
        max: 5
    });
});

const pool = require('../src/config/db');
const {
    transferBetweenWallets
} = require('../src/repositories/transfer.repository');

describe('Wallet transfer PostgreSQL integration', () => {
    let userA;
    let userB;
    let walletA;
    let walletB;

    beforeAll(async () => {
        const databaseResult = await pool.query(
            'SELECT current_database() AS name'
        );

        if (databaseResult.rows[0].name !== 'wallet_test_db') {
            throw new Error(
                'Safety check failed: integration tests must use wallet_test_db.'
            );
        }

        const userAResult = await pool.query(
            `INSERT INTO users (email, full_name)
             VALUES ($1, $2)
             RETURNING id`,
            [
                `transfer-a-${crypto.randomUUID()}@example.test`,
                'Transfer Integration A'
            ]
        );
        userA = userAResult.rows[0].id;

        const userBResult = await pool.query(
            `INSERT INTO users (email, full_name)
             VALUES ($1, $2)
             RETURNING id`,
            [
                `transfer-b-${crypto.randomUUID()}@example.test`,
                'Transfer Integration B'
            ]
        );
        userB = userBResult.rows[0].id;

        const walletAResult = await pool.query(
            `INSERT INTO accounts (user_id, account_type, balance_paise)
             VALUES ($1, 'wallet', 0)
             RETURNING id`,
            [userA]
        );
        walletA = walletAResult.rows[0].id;

        const walletBResult = await pool.query(
            `INSERT INTO accounts (user_id, account_type, balance_paise)
             VALUES ($1, 'wallet', 0)
             RETURNING id`,
            [userB]
        );
        walletB = walletBResult.rows[0].id;
    });

    async function resetWalletBalances() {
        await pool.query(
            `UPDATE accounts
             SET balance_paise = CASE
                 WHEN id = $1 THEN 10000
                 WHEN id = $2 THEN 2000
             END
             WHERE id = ANY($3::bigint[])`,
            [
                walletA,
                walletB,
                [String(walletA), String(walletB)]
            ]
        );
    }

    beforeEach(async () => {
        await resetWalletBalances();
    });

    afterAll(async () => {
        try {
            if (walletA && walletB) {
                await pool.query(
                    `DELETE FROM idempotency_keys
                     WHERE user_id = ANY($1::bigint[])`,
                    [[String(userA), String(userB)]]
                );

                await pool.query(
                    `DELETE FROM ledger_entries
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = ANY($1::bigint[])
                            OR to_account_id = ANY($1::bigint[])
                     )`,
                    [[String(walletA), String(walletB)]]
                );

                await pool.query(
                    `DELETE FROM transfer_status_audit
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = ANY($1::bigint[])
                            OR to_account_id = ANY($1::bigint[])
                     )`,
                    [[String(walletA), String(walletB)]]
                );

                await pool.query(
                    `DELETE FROM transfers
                     WHERE from_account_id = ANY($1::bigint[])
                        OR to_account_id = ANY($1::bigint[])`,
                    [[String(walletA), String(walletB)]]
                );

                await pool.query(
                    'DELETE FROM accounts WHERE id = ANY($1::bigint[])',
                    [[String(walletA), String(walletB)]]
                );
            }

            if (userA && userB) {
                await pool.query(
                    'DELETE FROM users WHERE id = ANY($1::bigint[])',
                    [[String(userA), String(userB)]]
                );
            }
        } finally {
            await pool.end();
        }
    });

    test('transfers funds and creates balanced ledger entries', async () => {
        const key = `transfer-${crypto.randomUUID()}`;

        const result = await transferBetweenWallets({
            fromWalletId: String(walletA),
            toWalletId: String(walletB),
            amountPaise: '3000',
            idempotencyKey: key
        });

        expect(result.status).toBe(201);
        expect(result.replayed).toBe(false);

        const balances = await pool.query(
            `SELECT id, balance_paise
             FROM accounts
             WHERE id = ANY($1::bigint[])
             ORDER BY id`,
            [[String(walletA), String(walletB)]]
        );

        const balanceById = new Map(
            balances.rows.map(row => [
                String(row.id),
                String(row.balance_paise)
            ])
        );

        expect(balanceById.get(String(walletA))).toBe('7000');
        expect(balanceById.get(String(walletB))).toBe('5000');

        const ledger = await pool.query(
            `SELECT account_id, entry_type, amount_paise
             FROM ledger_entries
             WHERE transfer_id = $1
             ORDER BY entry_type`,
            [result.body.data.transfer.id]
        );

        expect(ledger.rowCount).toBe(2);

        const debit = ledger.rows.find(
            row => row.entry_type === 'debit'
        );
        const credit = ledger.rows.find(
            row => row.entry_type === 'credit'
        );

        expect(String(debit.account_id)).toBe(String(walletA));
        expect(String(credit.account_id)).toBe(String(walletB));
        expect(String(debit.amount_paise)).toBe('3000');
        expect(String(credit.amount_paise)).toBe('3000');
    });

    test('replays the same request without moving funds twice', async () => {
        const key = `transfer-replay-${crypto.randomUUID()}`;

        const request = {
            fromWalletId: String(walletA),
            toWalletId: String(walletB),
            amountPaise: '500',
            idempotencyKey: key
        };

        const first = await transferBetweenWallets(request);
        const second = await transferBetweenWallets(request);

        expect(first.status).toBe(201);
        expect(first.replayed).toBe(false);
        expect(second.status).toBe(201);
        expect(second.replayed).toBe(true);

        expect(String(second.body.data.transfer.id)).toBe(
            String(first.body.data.transfer.id)
        );

        const count = await pool.query(
            `SELECT COUNT(*) AS count
             FROM transfers
             WHERE id = $1`,
            [first.body.data.transfer.id]
        );

        expect(count.rows[0].count).toBe('1');
    });

    test('rejects insufficient funds without changing balances', async () => {
        const key = `transfer-insufficient-${crypto.randomUUID()}`;

        await expect(
            transferBetweenWallets({
                fromWalletId: String(walletA),
                toWalletId: String(walletB),
                amountPaise: '999999',
                idempotencyKey: key
            })
        ).rejects.toMatchObject({
            status: 409,
            code: 'INSUFFICIENT_FUNDS'
        });

        const balances = await pool.query(
            `SELECT id, balance_paise
             FROM accounts
             WHERE id = ANY($1::bigint[])`,
            [[String(walletA), String(walletB)]]
        );

        const balanceById = new Map(
            balances.rows.map(row => [
                String(row.id),
                String(row.balance_paise)
            ])
        );

        expect(balanceById.get(String(walletA))).toBe('10000');
        expect(balanceById.get(String(walletB))).toBe('2000');
    });

    test('rejects reuse of an idempotency key with a different amount', async () => {
        const key = `transfer-key-conflict-${crypto.randomUUID()}`;

        const request = {
            fromWalletId: String(walletA),
            toWalletId: String(walletB),
            amountPaise: '100',
            idempotencyKey: key
        };

        await transferBetweenWallets(request);

        await expect(
            transferBetweenWallets({
                ...request,
                amountPaise: '200'
            })
        ).rejects.toMatchObject({
            status: 409,
            code: 'IDEMPOTENCY_KEY_REUSED'
        });
    });

    test('prevents concurrent transfers from overspending the source wallet', async () => {
        const keyA = `transfer-concurrent-a-${crypto.randomUUID()}`;
        const keyB = `transfer-concurrent-b-${crypto.randomUUID()}`;

        const results = await Promise.allSettled([
            transferBetweenWallets({
                fromWalletId: String(walletA),
                toWalletId: String(walletB),
                amountPaise: '7000',
                idempotencyKey: keyA
            }),
            transferBetweenWallets({
                fromWalletId: String(walletA),
                toWalletId: String(walletB),
                amountPaise: '7000',
                idempotencyKey: keyB
            })
        ]);

        const successful = results.filter(
            result => result.status === 'fulfilled'
        );
        const failed = results.filter(
            result => result.status === 'rejected'
        );

        expect(successful).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toMatchObject({
            status: 409,
            code: 'INSUFFICIENT_FUNDS'
        });

        const balances = await pool.query(
            `SELECT id, balance_paise
             FROM accounts
             WHERE id = ANY($1::bigint[])`,
            [[String(walletA), String(walletB)]]
        );

        const balanceById = new Map(
            balances.rows.map(row => [
                String(row.id),
                String(row.balance_paise)
            ])
        );

        expect(balanceById.get(String(walletA))).toBe('3000');
        expect(balanceById.get(String(walletB))).toBe('9000');

        const transferCount = await pool.query(
            `SELECT COUNT(*) AS count
             FROM transfers
             WHERE from_account_id = $1
               AND to_account_id = $2
               AND amount_paise = 7000`,
            [walletA, walletB]
        );

        expect(transferCount.rows[0].count).toBe('1');
    });


    test('rolls back the entire transfer when a database operation fails', async () => {
        const key = `transfer-rollback-${crypto.randomUUID()}`;

        // Remove leftovers if a previous interrupted test run left them behind.
        await pool.query(
            `DROP TRIGGER IF EXISTS test_fail_transfer_wallet_update
             ON accounts`
        );
        await pool.query(
            `DROP FUNCTION IF EXISTS test_fail_transfer_wallet_update_fn()`
        );

        await pool.query(`
            CREATE FUNCTION test_fail_transfer_wallet_update_fn()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NEW.id = ${Number(walletB)} THEN
                    RAISE EXCEPTION 'Forced transfer integration test failure';
                END IF;
                RETURN NEW;
            END;
            $$
        `);

        await pool.query(`
            CREATE TRIGGER test_fail_transfer_wallet_update
            BEFORE UPDATE ON accounts
            FOR EACH ROW
            EXECUTE FUNCTION test_fail_transfer_wallet_update_fn()
        `);

        try {
            await expect(
                transferBetweenWallets({
                    fromWalletId: String(walletA),
                    toWalletId: String(walletB),
                    amountPaise: '1000',
                    idempotencyKey: key
                })
            ).rejects.toThrow('Forced transfer integration test failure');
        } finally {
            await pool.query(
                `DROP TRIGGER IF EXISTS test_fail_transfer_wallet_update
                 ON accounts`
            );
            await pool.query(
                `DROP FUNCTION IF EXISTS test_fail_transfer_wallet_update_fn()`
            );
        }

        const balances = await pool.query(
            `SELECT id, balance_paise
             FROM accounts
             WHERE id = ANY($1::bigint[])`,
            [[String(walletA), String(walletB)]]
        );

        const balanceById = new Map(
            balances.rows.map(row => [
                String(row.id),
                String(row.balance_paise)
            ])
        );

        expect(balanceById.get(String(walletA))).toBe('10000');
        expect(balanceById.get(String(walletB))).toBe('2000');

        const idempotencyResult = await pool.query(
            `SELECT id
             FROM idempotency_keys
             WHERE user_id = $1 AND idempotency_key = $2`,
            [userA, key]
        );
        expect(idempotencyResult.rowCount).toBe(0);

        const transferResult = await pool.query(
            `SELECT id
             FROM transfers
             WHERE from_account_id = $1
               AND to_account_id = $2
               AND amount_paise = 1000`,
            [walletA, walletB]
        );
        expect(transferResult.rowCount).toBe(0);
    });


});
