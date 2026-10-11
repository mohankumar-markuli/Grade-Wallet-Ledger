const crypto = require('node:crypto');

jest.mock('../src/config/db', () => {
    const { Pool } = require('pg');
    const { validateEnv } = require('../src/config/env');
    const config = validateEnv();

    return new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 20
    });
});

const pool = require('../src/config/db');
const {
    transferBetweenWallets
} = require('../src/repositories/transfer.repository');

jest.setTimeout(120000);

async function removeAbandonedStampedeFixtures() {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
        const database = await client.query('SELECT current_database() AS name');
        if (database.rows[0].name !== 'wallet_test_db') {
            throw new Error('Safety check failed: stampede fixtures may only be removed from wallet_test_db.');
        }
        await client.query('BEGIN');
        transactionStarted = true;
        const users = await client.query(
            `SELECT id FROM users
             WHERE email LIKE 'stampede-a-%@example.test'
                OR email LIKE 'stampede-b-%@example.test'`
        );
        const userIds = users.rows.map(row => String(row.id));
        if (userIds.length) {
            const accounts = await client.query(
                `SELECT id FROM accounts
                 WHERE user_id=ANY($1::bigint[]) AND account_type='wallet'`,
                [userIds]
            );
            const accountIds = accounts.rows.map(row => String(row.id));
            await client.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only');
            await client.query('DELETE FROM idempotency_keys WHERE user_id=ANY($1::bigint[])', [userIds]);
            if (accountIds.length) {
                const transferIds = `SELECT id FROM transfers WHERE from_account_id=ANY($1::bigint[]) OR to_account_id=ANY($1::bigint[])`;
                await client.query(`DELETE FROM ledger_entries WHERE transfer_id IN (${transferIds})`, [accountIds]);
                await client.query(`DELETE FROM transfer_status_audit WHERE transfer_id IN (${transferIds})`, [accountIds]);
                await client.query(`DELETE FROM risk_flags WHERE transfer_id IN (${transferIds})`, [accountIds]);
                await client.query(`DELETE FROM transfers WHERE id IN (${transferIds})`, [accountIds]);
                await client.query('DELETE FROM accounts WHERE id=ANY($1::bigint[])', [accountIds]);
            }
            await client.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [userIds]);
            await client.query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only');
        }
        await client.query('COMMIT');
        transactionStarted = false;
    } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

describe('wallet transfer stampede acceptance test', () => {
    let userA;
    let userB;
    const walletPairs = [];
    const walletIds = [];
    let originalVelocityRuleEnabled;

    beforeAll(async () => {
        const databaseResult = await pool.query(
            'SELECT current_database() AS name'
        );

        if (databaseResult.rows[0].name !== 'wallet_test_db') {
            throw new Error(
                'Safety check failed: stampede tests must use wallet_test_db.'
            );
        }

        const velocityRule = await pool.query(
            "SELECT enabled FROM risk_rules WHERE rule_code='source_transfer_velocity'"
        );
        originalVelocityRuleEnabled = velocityRule.rows[0]?.enabled;
        if (originalVelocityRuleEnabled !== undefined) {
            await pool.query(
                "UPDATE risk_rules SET enabled=FALSE WHERE rule_code='source_transfer_velocity'"
            );
        }

        await removeAbandonedStampedeFixtures();

        const userAResult = await pool.query(
            `INSERT INTO users (email, full_name, phone, kyc_status)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [
                `stampede-a-${crypto.randomUUID()}@example.test`,
                'Stampede Test Sender',
                `+91${Date.now()}01`,
                'pending'
            ]
        );
        userA = userAResult.rows[0].id;

        const userBResult = await pool.query(
            `INSERT INTO users (email, full_name, phone, kyc_status)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [
                `stampede-b-${crypto.randomUUID()}@example.test`,
                'Stampede Test Receiver',
                `+91${Date.now()}02`,
                'pending'
            ]
        );
        userB = userBResult.rows[0].id;

        for (let run = 0; run < 20; run += 1) {
            const sourceResult = await pool.query(
                `INSERT INTO accounts
                    (user_id, account_type, currency, balance_paise)
                 VALUES ($1, 'wallet', 'INR', 50000)
                 RETURNING id`,
                [userA]
            );

            const destinationResult = await pool.query(
                `INSERT INTO accounts
                    (user_id, account_type, currency, balance_paise)
                 VALUES ($1, 'wallet', 'INR', 0)
                 RETURNING id`,
                [userB]
            );

            const sourceWalletId = sourceResult.rows[0].id;
            const destinationWalletId = destinationResult.rows[0].id;

            walletPairs.push({ sourceWalletId, destinationWalletId });
            walletIds.push(String(sourceWalletId), String(destinationWalletId));
        }
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
                    'Safety check failed: stampede cleanup must use wallet_test_db.'
                );
            }

            if (walletIds.length > 0) {
                await cleanupClient.query('BEGIN');
                transactionStarted = true;

                // This test-only cleanup bypass is confined to wallet_test_db.
                // The transaction restores the trigger if any cleanup step fails.
                await cleanupClient.query(
                    'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'
                );

                await cleanupClient.query(
                    `DELETE FROM idempotency_keys
                     WHERE user_id = ANY($1::bigint[])`,
                    [[String(userA), String(userB)]]
                );

                await cleanupClient.query(
                    `DELETE FROM ledger_entries
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = ANY($1::bigint[])
                            OR to_account_id = ANY($1::bigint[])
                     )`,
                    [walletIds]
                );

                await cleanupClient.query(
                    `DELETE FROM transfer_status_audit
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = ANY($1::bigint[])
                            OR to_account_id = ANY($1::bigint[])
                     )`,
                    [walletIds]
                );

                await cleanupClient.query(
                    `DELETE FROM risk_flags
                     WHERE transfer_id IN (
                         SELECT id FROM transfers
                         WHERE from_account_id = ANY($1::bigint[])
                            OR to_account_id = ANY($1::bigint[])
                     )`,
                    [walletIds]
                );

                await cleanupClient.query(
                    `DELETE FROM transfers
                     WHERE from_account_id = ANY($1::bigint[])
                        OR to_account_id = ANY($1::bigint[])`,
                    [walletIds]
                );

                await cleanupClient.query(
                    'DELETE FROM accounts WHERE id = ANY($1::bigint[])',
                    [walletIds]
                );

                await cleanupClient.query(
                    'DELETE FROM users WHERE id = ANY($1::bigint[])',
                    [[String(userA), String(userB)]]
                );

                await cleanupClient.query(
                    'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only'
                );
                await cleanupClient.query('COMMIT');
                transactionStarted = false;
            }
        } finally {
            try {
                if (transactionStarted) {
                    await cleanupClient.query('ROLLBACK');
                }
            } finally {
                try {
                    if (originalVelocityRuleEnabled !== undefined) {
                        await cleanupClient.query(
                            "UPDATE risk_rules SET enabled=$1 WHERE rule_code='source_transfer_velocity'",
                            [originalVelocityRuleEnabled]
                        );
                    }
                } finally {
                    cleanupClient.release();
                    await pool.end();
                }
            }
        }
    });

    test('100 concurrent ₹10 transfers spend exactly ₹500, in 20 runs', async () => {
        for (const [runIndex, pair] of walletPairs.entries()) {
            const requests = Array.from({ length: 100 }, (_, requestIndex) => ({
                fromWalletId: String(pair.sourceWalletId),
                toWalletId: String(pair.destinationWalletId),
                userId: String(userA),
                amountPaise: '1000',
                idempotencyKey:
                    `stampede-${runIndex}-${requestIndex}-${crypto.randomUUID()}`
            }));

            const results = await Promise.allSettled(
                requests.map(request => transferBetweenWallets(request))
            );

            const successful = results.filter(
                result => result.status === 'fulfilled'
            );
            const rejected = results.filter(
                result => result.status === 'rejected'
            );

            expect(successful).toHaveLength(50);
            expect(rejected).toHaveLength(50);
            expect(rejected.every(result => (
                result.reason.code === 'INSUFFICIENT_FUNDS'
            ))).toBe(true);

            const balances = await pool.query(
                `SELECT id, balance_paise
                 FROM accounts
                 WHERE id = ANY($1::bigint[])`,
                [[String(pair.sourceWalletId), String(pair.destinationWalletId)]]
            );
            const balanceById = new Map(
                balances.rows.map(row => [
                    String(row.id),
                    String(row.balance_paise)
                ])
            );

            expect(balanceById.get(String(pair.sourceWalletId))).toBe('0');
            expect(balanceById.get(String(pair.destinationWalletId))).toBe('50000');
            expect(balances.rows.every(row => BigInt(row.balance_paise) >= 0n))
                .toBe(true);

            const accounting = await pool.query(
                `SELECT COUNT(DISTINCT transfer.id)::int AS transfer_count,
                        COUNT(entry.id)::int AS entry_count,
                        COALESCE(SUM(entry.amount_paise)
                            FILTER (WHERE entry.entry_type = 'debit'), 0)::text
                            AS debit_total,
                        COALESCE(SUM(entry.amount_paise)
                            FILTER (WHERE entry.entry_type = 'credit'), 0)::text
                            AS credit_total
                 FROM transfers AS transfer
                 LEFT JOIN ledger_entries AS entry
                   ON entry.transfer_id = transfer.id
                 WHERE transfer.from_account_id = $1
                   AND transfer.to_account_id = $2
                   AND transfer.amount_paise = 1000`,
                [pair.sourceWalletId, pair.destinationWalletId]
            );

            expect(accounting.rows[0].transfer_count).toBe(50);
            expect(accounting.rows[0].entry_count).toBe(100);
            expect(accounting.rows[0].debit_total).toBe('50000');
            expect(accounting.rows[0].credit_total).toBe('50000');
        }
    });
});
