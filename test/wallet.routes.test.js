const request = require('supertest');
const app = require('../src/app');

const {
    createWallet,
    getWalletBalance,
} = require('../src/repositories/wallet.repository');


jest.mock('../src/repositories/wallet.repository', () => ({
    createWallet: jest.fn(),
    getWalletBalance: jest.fn(),
}));

describe('POST /wallets', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates a wallet and returns HTTP 201', async () => {
        createWallet.mockResolvedValue({
            id: '20',
            user_id: '10',
            account_type: 'wallet',
            currency: 'INR',
            balance_paise: '0',
            status: 'active',
            created_at: '2026-10-10T12:00:00.000Z',
        });

        const response = await request(app)
            .post('/wallets')
            .send({ userId: '10' });

        expect(response.status).toBe(201);
        expect(response.body.data.account_type).toBe('wallet');
        expect(response.body.data.currency).toBe('INR');
        expect(response.body.data.balance_paise).toBe('0');
        expect(createWallet).toHaveBeenCalledWith({ userId: '10' });
    });

    test('rejects a missing userId with HTTP 400', async () => {
        const response = await request(app)
            .post('/wallets')
            .send({});

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(createWallet).not.toHaveBeenCalled();
    });

    test('rejects a nonexistent user with HTTP 404', async () => {
        const foreignKeyError = new Error('Foreign key violation');
        foreignKeyError.code = '23503';
        createWallet.mockRejectedValue(foreignKeyError);

        const response = await request(app)
            .post('/wallets')
            .send({ userId: '999999' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });
});

describe('GET /wallets/:id/balance', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns the wallet balance with HTTP 200', async () => {
        getWalletBalance.mockResolvedValue({
            id: '1',
            user_id: '2',
            currency: 'INR',
            balance_paise: '0',
            status: 'active',
        });

        const response = await request(app).get('/wallets/1/balance');

        expect(response.status).toBe(200);
        expect(response.body.data.balance_paise).toBe('0');
        expect(getWalletBalance).toHaveBeenCalledWith({ walletId: '1' });
    });

    test('rejects an invalid wallet ID with HTTP 400', async () => {
        const response = await request(app).get('/wallets/abc/balance');

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(getWalletBalance).not.toHaveBeenCalled();
    });

    test('returns HTTP 404 when the wallet does not exist', async () => {
        getWalletBalance.mockResolvedValue(null);

        const response = await request(app).get('/wallets/999999/balance');

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    });
});