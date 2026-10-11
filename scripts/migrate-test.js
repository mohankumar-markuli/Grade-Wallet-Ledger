require('dotenv').config();

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required. Configure the local connection without sharing its value.');
    process.exitCode = 1;
} else {
    try {
        const databaseUrl = new URL(process.env.DATABASE_URL);
        if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
            throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
        }
        databaseUrl.pathname = '/wallet_test_db';
        process.env.DATABASE_URL = databaseUrl.toString();
        process.env.MIGRATION_EXPECTED_DATABASE = 'wallet_test_db';
        require('./migrate');
    } catch (error) {
        console.error('Could not prepare the wallet_test_db migration target:', error.message);
        process.exitCode = 1;
    }
}
