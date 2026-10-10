
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const {
    createWallet,
    getWalletBalance,
} = require('../src/repositories/wallet.repository');

jest.mock('../src/repositories/wallet.repository', () => ({
    createWallet: jest.fn(),
    getWalletBalance: jest.fn(),
}));

const TEST_SECRET = 'test-secret-for-wallet-route-tests';

function createToken(userId = '10') {
    return jwt.sign(
        { email: `user${userId}@example.com` },
        TEST_SECRET,
        {
            subject: userId,
            expiresIn: '15m',
            issuer: 'grade-wallet-ledger',
            audience: 'grade-wallet-ledger-api',
        }
    );
}

describe('Wallet routes', () => {
    beforeAll(() => {
        process.env.JWT_SECRET = TEST_SECRET;
    });

    afterAll(() => {
        delete process.env.JWT_SECRET;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('POST /wallets', () => {
        test('creates a wallet for the authenticated user', async () => {
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
                .set('Authorization', `Bearer ${createToken('10')}`)
                .set('Idempotency-Key', '01010101-0101-4101-8101-010101010101')
                .send({ userId: '999' });

            expect(response.status).toBe(201);
            expect(response.body.data.account_type).toBe('wallet');
            expect(response.body.data.currency).toBe('INR');
            expect(response.body.data.balance_paise).toBe('0');

            // The request body cannot choose the wallet owner.
            expect(createWallet).toHaveBeenCalledWith({
                userId: '10',
                idempotencyKey: '01010101-0101-4101-8101-010101010101'
            });
        });

        test('rejects a request without authentication', async () => {
            const response = await request(app)
                .post('/wallets')
                .send({});

            expect(response.status).toBe(401);
            expect(createWallet).not.toHaveBeenCalled();
        });

        test('returns HTTP 404 when the authenticated user does not exist', async () => {
            const foreignKeyError = new Error('Foreign key violation');
            foreignKeyError.code = '23503';
            createWallet.mockRejectedValue(foreignKeyError);

            const response = await request(app)
                .post('/wallets')
                .set('Authorization', `Bearer ${createToken('999999')}`)
                .set('Idempotency-Key', '02020202-0202-4202-8202-020202020202')
                .send({});

            expect(response.status).toBe(404);
            expect(response.body.error.code).toBe('USER_NOT_FOUND');
        });
    });

    describe('GET /wallets/:id/balance', () => {
        test('returns the authenticated user wallet balance', async () => {
            getWalletBalance.mockResolvedValue({
                id: '1',
                user_id: '10',
                currency: 'INR',
                balance_paise: '0',
                status: 'active',
            });

            const response = await request(app)
                .get('/wallets/1/balance')
                .set('Authorization', `Bearer ${createToken('10')}`);

            expect(response.status).toBe(200);
            expect(response.body.data.balance_paise).toBe('0');
            expect(getWalletBalance).toHaveBeenCalledWith({
                walletId: '1',
                userId: '10',
            });
        });

        test('rejects an invalid wallet ID', async () => {
            const response = await request(app)
                .get('/wallets/abc/balance')
                .set('Authorization', `Bearer ${createToken('10')}`);

            expect(response.status).toBe(400);
            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(getWalletBalance).not.toHaveBeenCalled();
        });

        test('returns HTTP 404 when the wallet is not owned by the user', async () => {
            // Ownership-filtered repository queries return null for another user's wallet.
            getWalletBalance.mockResolvedValue(null);

            const response = await request(app)
                .get('/wallets/1/balance')
                .set('Authorization', `Bearer ${createToken('10')}`);

            expect(response.status).toBe(404);
            expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
            expect(getWalletBalance).toHaveBeenCalledWith({
                walletId: '1',
                userId: '10',
            });
        });
    });
});
