
require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');

async function migrate() {
    const client = await pool.connect();

    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

        const migrationsDirectory = path.join(__dirname, '..', 'migrations');

        const filenames = (await fs.readdir(migrationsDirectory))
            .filter((filename) => filename.endsWith('.sql'))
            .sort();

        for (const filename of filenames) {
            const alreadyApplied = await client.query(
                'SELECT 1 FROM schema_migrations WHERE filename = $1',
                [filename]
            );

            if (alreadyApplied.rowCount > 0) {
                console.log(`Already applied: ${filename}`);
                continue;
            }

            const sql = await fs.readFile(
                path.join(migrationsDirectory, filename),
                'utf8'
            );

            console.log(`Applying: ${filename}`);

            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (filename) VALUES ($1)',
                    [filename]
                );
                await client.query('COMMIT');

                console.log(`Applied successfully: ${filename}`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }

        console.log('Migration process completed.');
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
});
