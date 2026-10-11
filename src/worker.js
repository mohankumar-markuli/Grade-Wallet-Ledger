require('dotenv').config();

const pool = require('./config/db');
const { scheduleNightlyReconciliation } = require('./jobs/reconciliation.scheduler');

async function start() {
    const expectedDatabase = process.env.RECONCILIATION_EXPECTED_DATABASE;
    if (!expectedDatabase) {
        throw new Error('RECONCILIATION_EXPECTED_DATABASE must name the verified worker database.');
    }

    const result = await pool.query('SELECT current_database() AS name');
    const actualDatabase = result.rows[0].name;
    if (actualDatabase !== expectedDatabase) {
        throw new Error(`Worker database mismatch: expected ${expectedDatabase}, received ${actualDatabase}.`);
    }

    console.log(`Background worker started for verified database ${actualDatabase}.`);
    return scheduleNightlyReconciliation();
}

let stop;
let stopping = false;

async function shutdown() {
    if (stopping) return;
    stopping = true;
    if (stop) stop();
    await pool.end();
}

process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));

start()
    .then((stopScheduler) => { stop = stopScheduler; })
    .catch(async (error) => {
        console.error('Background worker failed to start:', error.message);
        await shutdown();
        process.exitCode = 1;
    });
