const {
    runReconciliation
} = require('../repositories/reconciliation.repository');

function millisecondsUntilNextUtcMidnight(now) {
    const next = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0
    ));
    return Math.max(1, next.getTime() - now.getTime());
}

function scheduleNightlyReconciliation({
    run = runReconciliation,
    logger = console,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    let timer = null;
    let stopped = false;

    function scheduleNext() {
        if (stopped) {
            return;
        }
        timer = setTimer(execute, millisecondsUntilNextUtcMidnight(now()));
        if (timer && typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    async function execute() {
        if (stopped) {
            return;
        }
        try {
            const result = await run();
            if (result.status === 409) {
                logger.info('Nightly reconciliation skipped: another run is in progress.');
            } else {
                logger.info('Nightly reconciliation finished.', result.body);
            }
        } catch (error) {
            logger.error('Nightly reconciliation failed:', error.message);
        } finally {
            scheduleNext();
        }
    }

    scheduleNext();

    return function stop() {
        stopped = true;
        if (timer !== null) {
            clearTimer(timer);
        }
    };
}

module.exports = {
    millisecondsUntilNextUtcMidnight,
    scheduleNightlyReconciliation
};
