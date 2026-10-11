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
const { createUser } = require('../src/repositories/user.repository');
const { createWallet } = require('../src/repositories/wallet.repository');
const { topUpWallet } = require('../src/repositories/topup.repository');
const {
    transferBetweenWallets
} = require('../src/repositories/transfer.repository');

jest.setTimeout(60000);

describe('Idempotency PostgreSQL acceptance tests', () => {
    let userA;
    let userB;
    let walletA;
    let walletB;
    let fundingAccountId;
    let fundingBalanceBefore;
    let signupKey;
    let walletKey;
    const testKeys = new Set();

    function newKey() {
        const key = crypto.randomUUID();
        testKeys.add(key);
        return key;
    }

    beforeAll(async () => {
        const databaseResult = await pool.query(
            'SELECT current_database() AS name'
        );

        if (databaseResult.rows[0].name !== 'wallet_test_db') {
            throw new Error(
                'Safety check failed: idempotency tests must use wallet_test_db.'
            );
        }

        signupKey = newKey();
        const signupRequest = {
            email: `idempotency-a-${crypto.randomUUID()}@example.test`,
            fullName: 'Idempotency Test A',
            phone: `+91${Date.now()}11`,
            password: 'correct-horse-battery-staple',
            idempotencyKey: signupKey
        };
        const userAResult = await createUser(signupRequest);
        const replayedUser = await createUser(signupRequest);
        userA = userAResult.id;
        expect(String(replayedUser.id)).toBe(String(userA));

        const userBResult = await pool.query(
            `INSERT INTO users (email, full_name, phone, kyc_status)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [
                `idempotency-b-${crypto.randomUUID()}@example.test`,
                'Idempotency Test B',
                `+91${Date.now()}77`,
                'pending'
            ]
        );
        userB = userBResult.rows[0].id;

        walletKey = newKey();
        const firstWallet = await createWallet({
            userId: String(userA),
            idempotencyKey: walletKey
        });
        const replayedWallet = await createWallet({
            userId: String(userA),
            idempotencyKey: walletKey
        });
        walletA = firstWallet.id;
        expect(String(replayedWallet.id)).toBe(String(walletA));

        const walletBResult = await pool.query(
            `INSERT INTO accounts (user_id, account_type, currency, balance_paise)
             VALUES ($1, 'wallet', 'INR', 0)
             RETURNING id`,
            [userB]
        );
        walletB = walletBResult.rows[0].id;

        const fundingResult = await pool.query(
            `SELECT id
             FROM accounts
             WHERE account_type = 'external_funding'
               AND status = 'active'
             ORDER BY id
             LIMIT 1`
        );
        if (fundingResult.rowCount !== 1) {
            throw new Error('Test database needs an active external-funding account.');
        }
        fundingAccountId = fundingResult.rows[0].id;
        const fundingBalanceResult = await pool.query(
            'SELECT balance_paise FROM accounts WHERE id = $1',
            [fundingAccountId]
        );
        fundingBalanceBefore = fundingBalanceResult.rows[0].balance_paise;
    });

    afterAll(async () => {
        const client = await pool.connect();
        let transactionStarted = false;

        try {
            const databaseResult = await client.query(
                'SELECT current_database() AS name'
            );
            if (databaseResult.rows[0].name !== 'wallet_test_db') {
                throw new Error(
                    'Safety check failed: idempotency cleanup must use wallet_test_db.'
                );
            }

            if (userA || userB) {
                await client.query('BEGIN');
                transactionStarted = true;
                await client.query(
                    'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'
                );

                const accountIds = [walletA, walletB]
                    .filter(Boolean)
                    .map(String);

                const userIds = [userA, userB].filter(Boolean).map(String);
                await client.query(
                    'DELETE FROM idempotency_keys WHERE user_id = ANY($1::bigint[])',
                    [userIds]
                );
                if (testKeys.size > 0) {
                    await client.query(
                        `DELETE FROM idempotency_keys
                         WHERE idempotency_key = ANY($1::text[])`,
                        [[...testKeys]]
                    );
                }

                if (accountIds.length > 0) {
                    await client.query(
                        `DELETE FROM ledger_entries
                         WHERE transfer_id IN (
                             SELECT id FROM transfers
                             WHERE from_account_id = ANY($1::bigint[])
                                OR to_account_id = ANY($1::bigint[])
                         )`,
                        [accountIds]
                    );
                    await client.query(
                        `DELETE FROM transfer_status_audit
                         WHERE transfer_id IN (
                             SELECT id FROM transfers
                             WHERE from_account_id = ANY($1::bigint[])
                                OR to_account_id = ANY($1::bigint[])
                         )`,
                        [accountIds]
                    );
                    await client.query(
                        `DELETE FROM transfers
                         WHERE from_account_id = ANY($1::bigint[])
                            OR to_account_id = ANY($1::bigint[])`,
                        [accountIds]
                    );
                    await client.query(
                        'DELETE FROM accounts WHERE id = ANY($1::bigint[])',
                        [accountIds]
                    );
                }

                if (fundingAccountId && fundingBalanceBefore !== undefined) {
                    await client.query(
                        'UPDATE accounts SET balance_paise = $1 WHERE id = $2',
                        [fundingBalanceBefore, fundingAccountId]
                    );
                }

                await client.query(
                    'DELETE FROM users WHERE id = ANY($1::bigint[])',
                    [userIds]
                );
                await client.query(
                    'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only'
                );
                await client.query('COMMIT');
                transactionStarted = false;
            }
        } finally {
            try {
                if (transactionStarted) {
                    await client.query('ROLLBACK');
                }
            } finally {
                client.release();
                await pool.end();
            }
        }
    });

    test('a top-up repeated five times returns one identical response', async () => {
        const key = newKey();
        const request = {
            walletId: String(walletA),
            userId: String(userA),
            amountPaise: '5000',
            idempotencyKey: key
        };

        const results = [];
        for (let index = 0; index < 5; index += 1) {
            results.push(await topUpWallet(request));
        }

        expect(results.map(result => result.status)).toEqual([201, 201, 201, 201, 201]);
        expect(results.map(result => result.body)).toEqual(Array(results.length).fill(results[0].body));
        expect(results.slice(1).every(result => result.replayed)).toBe(true);

        const count = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM transfers
             WHERE from_account_id = $1
               AND to_account_id = $2
               AND amount_paise = 5000`,
            [fundingAccountId, walletA]
        );
        expect(count.rows[0].count).toBe(1);
    });

    test('ten parallel matching transfers create exactly one transfer and replay its response', async () => {
        const key = newKey();
        const request = {
            fromWalletId: String(walletA),
            toWalletId: String(walletB),
            userId: String(userA),
            amountPaise: '1000',
            idempotencyKey: key
        };

        const results = await Promise.all(
            Array.from({ length: 10 }, () => transferBetweenWallets(request))
        );

        expect(results.map(result => result.status)).toEqual(
            Array(10).fill(201)
        );
        expect(results.map(result => result.body)).toEqual(Array(results.length).fill(results[0].body));
        expect(results.filter(result => !result.replayed)).toHaveLength(1);
        expect(results.filter(result => result.replayed)).toHaveLength(9);

        const beforeMismatch = await pool.query(
            `SELECT balance_paise FROM accounts
             WHERE id = ANY($1::bigint[]) ORDER BY id`,
            [[String(walletA), String(walletB)]]
        );

        await expect(
            transferBetweenWallets({ ...request, amountPaise: '2000' })
        ).rejects.toMatchObject({
            status: 422,
            code: 'IDEMPOTENCY_KEY_REUSED'
        });

        const afterMismatch = await pool.query(
            `SELECT balance_paise FROM accounts
             WHERE id = ANY($1::bigint[]) ORDER BY id`,
            [[String(walletA), String(walletB)]]
        );
        expect(afterMismatch.rows).toEqual(beforeMismatch.rows);

        const count = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM transfers
             WHERE from_account_id = $1
               AND to_account_id = $2
               AND amount_paise IN (1000, 2000)`,
            [walletA, walletB]
        );
        expect(count.rows[0].count).toBe(1);
    });
});
