
require('dotenv').config();

const { validateEnv } = require('./config/env');
const app = require('./app');

const config = validateEnv();
const server = app.listen(config.port, () => {
    console.log(`Grade Wallet Ledger API listening on port ${config.port}`);
});

function shutdown() {
    server.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
