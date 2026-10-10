const {
    millisecondsUntilNextUtcMidnight,
    scheduleNightlyReconciliation
} = require('../src/jobs/reconciliation.scheduler');

describe('nightly reconciliation scheduler', () => {
    test('calculates the next UTC midnight', () => {
        const now = new Date('2026-10-10T18:30:00.000Z');
        expect(millisecondsUntilNextUtcMidnight(now)).toBe(
            5.5 * 60 * 60 * 1000
        );
    });

    test('schedules one run and can be stopped', () => {
        const clearTimer = jest.fn();
        const timer = { unref: jest.fn() };
        const setTimer = jest.fn(() => timer);
        const stop = scheduleNightlyReconciliation({
            run: jest.fn(),
            logger: { info: jest.fn(), error: jest.fn() },
            now: () => new Date('2026-10-10T18:30:00.000Z'),
            setTimer,
            clearTimer
        });

        expect(setTimer).toHaveBeenCalledTimes(1);
        expect(setTimer.mock.calls[0][1]).toBe(5.5 * 60 * 60 * 1000);
        expect(timer.unref).toHaveBeenCalledTimes(1);
        stop();
        expect(clearTimer).toHaveBeenCalledWith(timer);
    });
});
