
jest.mock('../src/config/db', () => ({
    connect: jest.fn()
}));

const pool = require('../src/config/db');
const {
    transferBetweenWallets
} = require('../src/repositories/transfer.repository');

describe('transferBetweenWallets validation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('rejects when source and destination wallets are the same', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '1',
                toWalletId: '1',
                userId: '10',
                amountPaise: '1000',
                idempotencyKey: 'transfer-test-1'
            })
        ).rejects.toMatchObject({
            status: 400,
            code: 'SAME_WALLET'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects a non-positive source wallet ID', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '0',
                toWalletId: '2',
                userId: '10',
                amountPaise: '1000',
                idempotencyKey: 'transfer-test-2'
            })
        ).rejects.toMatchObject({
            status: 400,
            code: 'VALIDATION_ERROR'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects a non-integer amount', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '1',
                toWalletId: '2',
                userId: '10',
                amountPaise: '10.5',
                idempotencyKey: 'transfer-test-3'
            })
        ).rejects.toMatchObject({
            status: 400,
            code: 'VALIDATION_ERROR'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects a zero amount', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '1',
                toWalletId: '2',
                userId: '10',
                amountPaise: '0',
                idempotencyKey: 'transfer-test-4'
            })
        ).rejects.toMatchObject({
            status: 400,
            code: 'VALIDATION_ERROR'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects a missing idempotency key', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '1',
                toWalletId: '2',
                userId: '10',
                amountPaise: '1000'
            })
        ).rejects.toMatchObject({
            status: 400,
            code: 'IDEMPOTENCY_KEY_REQUIRED'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects a missing authenticated user ID', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '1',
                toWalletId: '2',
                amountPaise: '1000',
                idempotencyKey: 'transfer-test-user'
            })
        ).rejects.toMatchObject({
            status: 401,
            code: 'UNAUTHORIZED'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects a non-positive authenticated user ID', async () => {
        await expect(
            transferBetweenWallets({
                fromWalletId: '1',
                toWalletId: '2',
                userId: '0',
                amountPaise: '1000',
                idempotencyKey: 'transfer-test-invalid-user'
            })
        ).rejects.toMatchObject({
            status: 401,
            code: 'UNAUTHORIZED'
        });

        expect(pool.connect).not.toHaveBeenCalled();
    });
});