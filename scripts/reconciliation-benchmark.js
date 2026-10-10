require('dotenv').config();

const pool = require('../src/config/db');

const BENCHMARK_EMAIL = 'm4-reconciliation-benchmark@example.test';
const BENCHMARK_DESCRIPTION = 'm4 reconciliation performance benchmark';
const BENCHMARK_AMOUNT = 500000;

const EXPLAIN_QUERIES = [
    {
        name: 'global debit and credit totals',
        sql: [
            'SELECT',
            "  COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'debit'), 0) AS debit_total,",
            "  COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'credit'), 0) AS credit_total",
            'FROM ledger_entries'
        ].join('\n')
    },
    {
        name: 'per-transfer totals',
        sql: [
            'SELECT transfer.id,',
            "       COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'debit'), 0) AS debit_total,",
            "       COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'credit'), 0) AS credit_total",
            'FROM transfers AS transfer',
            'LEFT JOIN ledger_entries AS entry ON entry.transfer_id = transfer.id',
            "WHERE transfer.status IN ('completed', 'reversed')",
            'GROUP BY transfer.id',
            "HAVING COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'debit'), 0)",
            "    <> COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'credit'), 0)"
        ].join('\n')
    },
    {
        name: 'account balances from ledger',
        sql: [
            'SELECT account.id, account.balance_paise,',
            '       COALESCE(SUM(CASE',
            "           WHEN entry.entry_type = 'credit' THEN entry.amount_paise",
            "           WHEN entry.entry_type = 'debit' THEN -entry.amount_paise",
            '           ELSE 0',
            '       END), 0) AS ledger_balance',
            'FROM accounts AS account',
            'LEFT JOIN ledger_entries AS entry ON entry.account_id = account.id',
            'GROUP BY account.id'
        ].join('\n')
    },
    {
        name: 'completed transfers without entries',
        sql: [
            'SELECT transfer.id',
            'FROM transfers AS transfer',
            'LEFT JOIN ledger_entries AS entry ON entry.transfer_id = transfer.id',
            "WHERE transfer.status IN ('completed', 'reversed')",
            'GROUP BY transfer.id',
            'HAVING COUNT(entry.id) = 0'
        ].join('\n')
    },
    {
        name: 'ledger rows with missing parents',
        sql: [
            'SELECT entry.id',
            'FROM ledger_entries AS entry',
            'LEFT JOIN transfers AS transfer ON transfer.id = entry.transfer_id',
            'LEFT JOIN accounts AS account ON account.id = entry.account_id',
            'WHERE transfer.id IS NULL OR account.id IS NULL'
        ].join('\n')
    }
];

async function assertTestDatabase(client) {
    const result = await client.query('SELECT current_database() AS name');
    if (result.rows[0].name !== 'wallet_test_db') {
        throw new Error(
            'Safety check failed: this script may only use wallet_test_db.'
        );
    }
}

async function seedBenchmark() {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
        await assertTestDatabase(client);
        const existing = await client.query(
            'SELECT id FROM users WHERE email = $1',
            [BENCHMARK_EMAIL]
        );
        if (existing.rowCount > 0) {
            throw new Error(
                'The benchmark fixture already exists. Run the cleanup command before seeding again.'
            );
        }

        const funding = await client.query(
            [
                'SELECT id',
                'FROM accounts',
                "WHERE account_type = 'external_funding'",
                "  AND account_name = 'cash_in'",
                "  AND status = 'active'",
                'ORDER BY id',
                'LIMIT 1'
            ].join('\n')
        );
        if (funding.rowCount !== 1) {
            throw new Error('An active cash-in account was not found.');
        }

        await client.query('BEGIN');
        transactionStarted = true;
        await client.query(
            'ALTER TABLE transfers DISABLE TRIGGER transfers_require_balanced_ledger'
        );
        await client.query(
            'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_balance_transfer'
        );

        const user = await client.query(
            [
                'INSERT INTO users (email, full_name, phone, kyc_status)',
                "VALUES ($1, 'Reconciliation benchmark', $2, 'pending')",
                'RETURNING id'
            ].join('\n'),
            [BENCHMARK_EMAIL, '+910000000000']
        );
        const account = await client.query(
            [
                'INSERT INTO accounts',
                '    (user_id, account_type, account_name, currency, balance_paise)',
                "VALUES ($1, 'wallet', 'm4-benchmark', 'INR', 0)",
                'RETURNING id'
            ].join('\n'),
            [user.rows[0].id]
        );
        const transfer = await client.query(
            [
                'INSERT INTO transfers',
                '    (from_account_id, to_account_id, amount_paise, currency,',
                '     status, description, completed_at, transfer_type)',
                "VALUES ($1, $2, $3, 'INR', 'completed', $4, NOW(), 'top_up')",
                'RETURNING id'
            ].join('\n'),
            [
                funding.rows[0].id,
                account.rows[0].id,
                BENCHMARK_AMOUNT,
                BENCHMARK_DESCRIPTION
            ]
        );

        await client.query(
            [
                'INSERT INTO ledger_entries',
                '    (transfer_id, account_id, entry_type, amount_paise)',
                "SELECT $1::bigint, $2::bigint, 'debit', 1 FROM generate_series(1, 500000)",
                'UNION ALL',
                "SELECT $1::bigint, $3::bigint, 'credit', 1 FROM generate_series(1, 500000)"
            ].join('\n'),
            [transfer.rows[0].id, funding.rows[0].id, account.rows[0].id]
        );
        await client.query(
            'UPDATE accounts SET balance_paise = balance_paise - $1 WHERE id = $2',
            [BENCHMARK_AMOUNT, funding.rows[0].id]
        );
        await client.query(
            'UPDATE accounts SET balance_paise = balance_paise + $1 WHERE id = $2',
            [BENCHMARK_AMOUNT, account.rows[0].id]
        );
        await client.query(
            'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_balance_transfer'
        );
        await client.query(
            'ALTER TABLE transfers ENABLE TRIGGER transfers_require_balanced_ledger'
        );
        await client.query('COMMIT');
        transactionStarted = false;
        await client.query('ANALYZE ledger_entries');
        await client.query('ANALYZE transfers');

        console.log('Seeded one balanced transfer with 1,000,000 ledger entries in wallet_test_db.');
        console.log('Run the explain command, then run the cleanup command.');
    } catch (error) {
        if (transactionStarted) {
            await client.query('ROLLBACK');
        }
        throw error;
    } finally {
        client.release();
    }
}

async function explainQueries() {
    const client = await pool.connect();
    try {
        await assertTestDatabase(client);
        const count = await client.query(
            'SELECT COUNT(*)::bigint AS count FROM ledger_entries'
        );
        if (BigInt(count.rows[0].count) < 1000000n) {
            throw new Error(
                'The test database needs at least 1,000,000 ledger entries before EXPLAIN ANALYZE.'
            );
        }

        for (const query of EXPLAIN_QUERIES) {
            console.log('\n' + query.name);
            const result = await client.query(
                'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ' + query.sql
            );
            for (const row of result.rows) {
                console.log(row['QUERY PLAN']);
            }
        }
    } finally {
        client.release();
    }
}

async function cleanupBenchmark() {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
        await assertTestDatabase(client);
        const fixture = await client.query(
            [
                'SELECT account.id AS account_id, transfer.id AS transfer_id,',
                '       transfer.from_account_id AS funding_id',
                'FROM users AS benchmark_user',
                'JOIN accounts AS account ON account.user_id = benchmark_user.id',
                'JOIN transfers AS transfer',
                '  ON transfer.to_account_id = account.id',
                ' AND transfer.description = $2',
                'WHERE benchmark_user.email = $1'
            ].join('\n'),
            [BENCHMARK_EMAIL, BENCHMARK_DESCRIPTION]
        );
        if (fixture.rowCount === 0) {
            console.log('No reconciliation benchmark fixture exists.');
            return;
        }
        if (fixture.rowCount !== 1) {
            throw new Error('Expected exactly one benchmark account and transfer.');
        }

        const reportReferences = await client.query(
            [
                'SELECT COUNT(*)::int AS count',
                'FROM reconciliation_problems',
                'WHERE account_id = $1 OR transfer_id = $2'
            ].join('\n'),
            [fixture.rows[0].account_id, fixture.rows[0].transfer_id]
        );
        if (reportReferences.rows[0].count > 0) {
            throw new Error(
                'A reconciliation report references the benchmark fixture. Review that report before cleanup.'
            );
        }

        await client.query('BEGIN');
        transactionStarted = true;
        await client.query(
            'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'
        );
        await client.query(
            'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_balance_transfer'
        );
        await client.query(
            'DELETE FROM ledger_entries WHERE transfer_id = $1',
            [fixture.rows[0].transfer_id]
        );
        await client.query(
            'DELETE FROM transfers WHERE id = $1',
            [fixture.rows[0].transfer_id]
        );
        await client.query(
            'UPDATE accounts SET balance_paise = balance_paise + $1 WHERE id = $2',
            [BENCHMARK_AMOUNT, fixture.rows[0].funding_id]
        );
        await client.query(
            'DELETE FROM accounts WHERE id = $1',
            [fixture.rows[0].account_id]
        );
        await client.query(
            'DELETE FROM users WHERE email = $1',
            [BENCHMARK_EMAIL]
        );
        await client.query(
            'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_balance_transfer'
        );
        await client.query(
            'ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only'
        );
        await client.query('COMMIT');
        transactionStarted = false;
        console.log('Removed the reconciliation benchmark fixture from wallet_test_db.');
    } catch (error) {
        if (transactionStarted) {
            await client.query('ROLLBACK');
        }
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    const action = process.argv[2];
    if (action === 'seed') {
        await seedBenchmark();
    } else if (action === 'explain') {
        await explainQueries();
    } else if (action === 'cleanup') {
        await cleanupBenchmark();
    } else {
        throw new Error(
            'Choose one action: seed, explain, or cleanup.'
        );
    }
}

main()
    .catch((error) => {
        console.error('Reconciliation benchmark failed:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
