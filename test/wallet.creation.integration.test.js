const crypto = require('node:crypto');

jest.mock('../src/config/db', () => {
    const { Pool } = require('pg');
    const { validateEnv } = require('../src/config/env');
    return new Pool({ connectionString: validateEnv().databaseUrl });
});

const pool = require('../src/config/db');
const { createWallet } = require('../src/repositories/wallet.repository');

describe('wallet creation PostgreSQL integration', () => {
    let userId;
    let idempotencyKey;

    beforeAll(async () => {
        const database = await pool.query('SELECT current_database() AS name');
        if (database.rows[0].name !== 'wallet_test_db') {
            throw new Error('Wallet creation integration requires wallet_test_db.');
        }

        idempotencyKey = crypto.randomUUID();
        const user = await pool.query(
            `INSERT INTO users (email, full_name, phone, kyc_status)
             VALUES ($1, $2, $3, 'pending')
             RETURNING id`,
            [`wallet-create-${idempotencyKey}@example.test`, 'Wallet Test User', '+919876543210']
        );
        userId = String(user.rows[0].id);
    });

    afterAll(async () => {
        if (userId) {
            const database = await pool.query('SELECT current_database() AS name');
            if (database.rows[0].name !== 'wallet_test_db') {
                throw new Error('Wallet creation cleanup requires wallet_test_db.');
            }
            await pool.query('DELETE FROM idempotency_keys WHERE user_id = $1', [userId]);
            await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
            await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        await pool.end();
    });

    test('creates a named wallet once, replays it, and rejects a different name on key reuse', async () => {
        const first = await createWallet({ userId, name: 'Main', idempotencyKey });
        const replay = await createWallet({ userId, name: 'Main', idempotencyKey });

        expect(first.name).toBe('Main');
        expect(replay).toMatchObject(JSON.parse(JSON.stringify(first)));

        const stored = await pool.query(
            `SELECT id, name FROM accounts
             WHERE user_id = $1 AND account_type = 'wallet'`,
            [userId]
        );
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0].name).toBe('Main');

        await expect(createWallet({
            userId,
            name: 'Savings',
            idempotencyKey
        })).rejects.toMatchObject({
            status: 422,
            code: 'IDEMPOTENCY_KEY_REUSED'
        });
    });
});
