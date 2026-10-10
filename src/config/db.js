
const { Pool } = require('pg');
const { validateEnv } = require('./env');

const config = validateEnv();

const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 10,
});

pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error:', error.message);
});

module.exports = pool;
