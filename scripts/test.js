require('dotenv').config();

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required. Configure the local connection without sharing its value.');
    }
    const databaseUrl = new URL(process.env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
        throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
    }
    databaseUrl.pathname = '/wallet_test_db';
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.LLM_PROVIDER = 'mock';

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    try {
        const result = await pool.query('SELECT current_database() AS name');
        if (result.rows[0].name !== 'wallet_test_db') {
            throw new Error('Test safety check failed: tests must use wallet_test_db.');
        }
    } catch (error) {
        throw new Error(`Could not verify wallet_test_db. Confirm that the isolated test database is available. ${error.message}`);
    } finally {
        await pool.end();
    }

    const jestPath = path.join(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js');
    const args = [jestPath, '--runInBand', ...process.argv.slice(2)];
    const result = spawnSync(process.execPath, args, {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
