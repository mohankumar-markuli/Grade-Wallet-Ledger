
const request = require('supertest');
const app = require('../src/app');

const { topUpWallet } = require('../src/repositories/topup.repository');

jest.mock('../src/repositories/topup.repository', () => ({
    topUpWallet: jest.fn(),
}));

describe('POST /wallets/:id/top-up', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates a top-up and returns HTTP 201', async () => {
        topUpWallet.mockResolvedValue({
            status: 201,
            body: {
                data: {
                    transfer: { id: '100', amount_paise: '5000', status: 'completed' },
                    wallet: { id: '1', balance_paise: '5000', currency: 'INR' },
                },
            },
            replayed: false,
        });

        const response = await request(app)
            .post('/wallets/1/top-up')
            .set('Idempotency-Key', 'topup-test-001')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(201);
        expect(response.body.data.wallet.balance_paise).toBe('5000');
        expect(topUpWallet).toHaveBeenCalledWith({
            walletId: '1',
            amountPaise: '5000',
            idempotencyKey: 'topup-test-001',
        });
    });

    test('rejects an invalid wallet ID', async () => {
        const response = await request(app)
            .post('/wallets/abc/top-up')
            .set('Idempotency-Key', 'topup-test-002')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(topUpWallet).not.toHaveBeenCalled();
    });

    test('returns the repository validation error', async () => {
        const error = Object.assign(new Error('A valid positive amount is required.'), {
            status: 400,
            code: 'VALIDATION_ERROR',
        });

        topUpWallet.mockRejectedValue(error);

        const response = await request(app)
            .post('/wallets/1/top-up')
            .set('Idempotency-Key', 'topup-test-003')
            .send({ amountPaise: '0' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns HTTP 404 when the wallet is missing', async () => {
        const error = Object.assign(new Error('Wallet not found.'), {
            status: 404,
            code: 'WALLET_NOT_FOUND',
        });

        topUpWallet.mockRejectedValue(error);

        const response = await request(app)
            .post('/wallets/999999/top-up')
            .set('Idempotency-Key', 'topup-test-004')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    });
});
