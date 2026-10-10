
jest.mock('../src/repositories/transfer.repository', () => ({
    transferBetweenWallets: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const {
    transferBetweenWallets
} = require('../src/repositories/transfer.repository');

describe('POST /wallets/:id/transfer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates a transfer and returns HTTP 201', async () => {
        transferBetweenWallets.mockResolvedValue({
            status: 201,
            replayed: false,
            body: {
                data: {
                    transfer: { id: '10', amount_paise: '1000' }
                }
            }
        });

        const response = await request(app)
            .post('/wallets/1/transfer')
            .set('Idempotency-Key', 'route-transfer-001')
            .send({
                toWalletId: '2',
                amountPaise: '1000'
            });

        expect(response.status).toBe(201);
        expect(response.body.data.transfer.id).toBe('10');
        expect(transferBetweenWallets).toHaveBeenCalledWith({
            fromWalletId: '1',
            toWalletId: '2',
            amountPaise: '1000',
            idempotencyKey: 'route-transfer-001'
        });
    });

    test('rejects an invalid source wallet ID', async () => {
        const response = await request(app)
            .post('/wallets/abc/transfer')
            .send({
                toWalletId: '2',
                amountPaise: '1000'
            });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(transferBetweenWallets).not.toHaveBeenCalled();
    });

    test('rejects a missing destination wallet ID', async () => {
        const response = await request(app)
            .post('/wallets/1/transfer')
            .send({ amountPaise: '1000' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(transferBetweenWallets).not.toHaveBeenCalled();
    });

    test('returns the repository validation error', async () => {
        transferBetweenWallets.mockRejectedValue(
            Object.assign(new Error('Insufficient wallet balance.'), {
                status: 409,
                code: 'INSUFFICIENT_FUNDS'
            })
        );

        const response = await request(app)
            .post('/wallets/1/transfer')
            .set('Idempotency-Key', 'route-transfer-002')
            .send({
                toWalletId: '2',
                amountPaise: '1000'
            });

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    });
});
