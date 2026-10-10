
require('dotenv').config();

const { validateEnv } = require('./config/env');
const app = require('./app');
const pool = require('./config/db');
const {
    scheduleNightlyReconciliation
} = require('./jobs/reconciliation.scheduler');

const config = validateEnv();
let stopReconciliationScheduler;
const server = app.listen(config.port, async () => {
    if (process.env.ENABLE_RECONCILIATION_SCHEDULER === 'true') {
        const expectedDatabase =
            process.env.RECONCILIATION_EXPECTED_DATABASE;
        if (!expectedDatabase) {
            console.error(
                'Nightly reconciliation remains disabled: set RECONCILIATION_EXPECTED_DATABASE after verifying the database target.'
            );
        } else {
            try {
                const database = await pool.query(
                    'SELECT current_database() AS name'
                );
                if (database.rows[0].name !== expectedDatabase) {
                    console.error(
                        'Nightly reconciliation remains disabled: the configured database does not match RECONCILIATION_EXPECTED_DATABASE.'
                    );
                } else {
                    stopReconciliationScheduler = scheduleNightlyReconciliation();
                    console.log(
                        'Nightly reconciliation scheduler enabled (UTC) for ' +
                        expectedDatabase + '.'
                    );
                }
            } catch (error) {
                console.error(
                    'Nightly reconciliation remains disabled because the database target could not be verified:',
                    error.message
                );
            }
        }
    } else {
        console.log(
            'Nightly reconciliation scheduler is disabled. Verify the database target before enabling it.'
        );
    }
    console.log(`Grade Wallet Ledger API listening on port ${config.port}`);
});

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    if (stopReconciliationScheduler) {
        stopReconciliationScheduler();
    }
    server.close(async () => {
        await pool.end();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
