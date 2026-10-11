require('dotenv').config();

const pool = require('../src/config/db');

const USER_COUNT = 1000;
const WALLET_COUNT = 2000;
const TRANSFER_COUNT = 100000;
const TOP_UP_COUNT = TRANSFER_COUNT / 2;
const PEER_TRANSFER_COUNT = TRANSFER_COUNT / 2;

async function seed() {
    const expectedDatabase = process.env.SEED_EXPECTED_DATABASE;
    if (!expectedDatabase) {
        throw new Error('Set SEED_EXPECTED_DATABASE to the exact verified seed database name.');
    }

    const client = await pool.connect();
    try {
        const database = await client.query('SELECT current_database() AS name');
        if (database.rows[0].name !== expectedDatabase) {
            throw new Error(`Seed database mismatch: expected ${expectedDatabase}, received ${database.rows[0].name}. No seed data was written.`);
        }
        if (!expectedDatabase.endsWith('_seed_db')) {
            throw new Error('For safety, SEED_EXPECTED_DATABASE must end with _seed_db.');
        }

        await client.query('BEGIN');
        await client.query(`
            INSERT INTO accounts (account_type, account_name, name, currency)
            VALUES ('external_funding', 'cash_in', 'cash_in', 'INR')
            ON CONFLICT (account_name) WHERE account_type IN ('system', 'external_funding')
                AND account_name IN ('cash_in', 'cash_out', 'fee_revenue') DO NOTHING
        `);
        await client.query(`
            INSERT INTO accounts (account_type, account_name, name, currency)
            VALUES ('system', 'cash_out', 'cash_out', 'INR'),
                   ('system', 'fee_revenue', 'fee_revenue', 'INR')
            ON CONFLICT (account_name) WHERE account_type IN ('system', 'external_funding')
                AND account_name IN ('cash_in', 'cash_out', 'fee_revenue') DO NOTHING
        `);

        const counts = await client.query(`
            SELECT
                (SELECT COUNT(*) FROM users WHERE email LIKE 'delivery-seed-%@example.test') AS existing_users,
                (SELECT COUNT(*) FROM transfers WHERE description LIKE 'delivery-seed:%') AS existing_transfers
        `);
        if (Number(counts.rows[0].existing_users) || Number(counts.rows[0].existing_transfers)) {
            throw new Error('Seed markers already exist in this database. Use a fresh empty *_seed_db database.');
        }

        await client.query(`
            INSERT INTO users (email, full_name, phone, kyc_status, status)
            SELECT 'delivery-seed-' || lpad(n::text, 4, '0') || '@example.test',
                   'Delivery Seed User ' || n,
                   '+910000' || lpad(n::text, 6, '0'),
                   'verified', 'active'
            FROM generate_series(1, $1) AS n
        `, [USER_COUNT]);
        await client.query(`
            INSERT INTO accounts (user_id, account_type, name, currency, balance_paise, status)
            SELECT u.id, 'wallet', 'Wallet ' || wallet_number, 'INR', 0, 'active'
            FROM users AS u
            CROSS JOIN generate_series(1, 2) AS wallet(wallet_number)
            WHERE u.email LIKE 'delivery-seed-%@example.test'
        `);
        await client.query(`
            CREATE TEMP TABLE seed_wallets ON COMMIT DROP AS
            SELECT id,
                   row_number() OVER (ORDER BY id)::integer AS wallet_number
            FROM accounts
            WHERE account_type = 'wallet'
              AND user_id IN (
                  SELECT id FROM users WHERE email LIKE 'delivery-seed-%@example.test'
              )
        `);
        await client.query(`
            UPDATE accounts wallet
            SET balance_paise = $1
            FROM seed_wallets seed
            WHERE wallet.id = seed.id
        `, [25 * 1000]);

        await client.query(`
            INSERT INTO transfers
                (from_account_id, to_account_id, amount_paise, currency, status,
                 description, transfer_type, completed_at)
            SELECT funding.id, target.id, 1000, 'INR', 'completed',
                   'delivery-seed: topup ' || n, 'top_up', NOW()
            FROM generate_series(1, $1) AS n
            JOIN accounts AS funding ON funding.account_type = 'external_funding'
                AND funding.account_name = 'cash_in'
            JOIN seed_wallets AS target
                ON target.wallet_number = ((n - 1) % $2) + 1
        `, [TOP_UP_COUNT, WALLET_COUNT]);
        await client.query(`
            INSERT INTO transfers
                (from_account_id, to_account_id, amount_paise, currency, status,
                 description, transfer_type, completed_at)
            SELECT source.id, destination.id, 100, 'INR', 'completed',
                   'delivery-seed: peer ' || n, 'peer_transfer', NOW()
            FROM generate_series(1, $1) AS n
            JOIN seed_wallets AS source
                ON source.wallet_number = ((n - 1) % $2) + 1
            JOIN seed_wallets AS destination
                ON destination.wallet_number = (n % $2) + 1
        `, [PEER_TRANSFER_COUNT, WALLET_COUNT]);

        await client.query(`
            INSERT INTO ledger_entries (transfer_id, account_id, entry_type, amount_paise)
            SELECT transfer.id, transfer.from_account_id, 'debit', transfer.amount_paise
            FROM transfers transfer
            WHERE transfer.description LIKE 'delivery-seed:%'
            UNION ALL
            SELECT transfer.id, transfer.to_account_id, 'credit', transfer.amount_paise
            FROM transfers transfer
            WHERE transfer.description LIKE 'delivery-seed:%'
        `);
        await client.query(`
            INSERT INTO transfer_status_audit (transfer_id, old_status, new_status, reason)
            SELECT id, NULL, 'completed', 'Delivery seed data'
            FROM transfers
            WHERE description LIKE 'delivery-seed:%'
        `);
        await client.query('COMMIT');
        console.log(`Seeded ${USER_COUNT} users, ${WALLET_COUNT} wallets, and ${TRANSFER_COUNT} balanced transfers.`);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

seed().catch((error) => {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
});
