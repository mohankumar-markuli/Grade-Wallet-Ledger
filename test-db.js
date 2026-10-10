
require('dotenv').config();

const pool = require('./src/config/db');

async function checkDatabase() {
    try {
        const result = await pool.query(
            'SELECT current_database() AS database, current_user AS username, NOW() AS server_time'
        );

        console.log('Database connection successful.');
        console.log('Database:', result.rows[0].database);
        console.log('User:', result.rows[0].username);
        console.log('Server time:', result.rows[0].server_time);
    } catch (error) {
        console.error('Database connection failed:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

checkDatabase();
