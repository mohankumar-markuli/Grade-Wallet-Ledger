
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const { topUpWallet } = require('../src/repositories/topup.repository');
const { getWalletBalance } = require('../src/repositories/wallet.repository');

jest.mock('../src/repositories/topup.repository', () => ({
    topUpWallet: jest.fn(),
}));

jest.mock('../src/repositories/wallet.repository', () => ({
    createWallet: jest.fn(),
    getWalletBalance: jest.fn(),
}));

const TEST_SECRET = 'test-secret-for-topup-route-tests';

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

describe('POST /wallets/:id/top-up', () => {
    beforeAll(() => {
        process.env.JWT_SECRET = TEST_SECRET;
    });

    afterAll(() => {
        delete process.env.JWT_SECRET;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        getWalletBalance.mockResolvedValue({
            id: '1',
            user_id: '10',
            currency: 'INR',
            balance_paise: '0',
            status: 'active',
        });
    });

    test('creates a top-up and returns HTTP 201', async () => {
        topUpWallet.mockResolvedValue({
            status: 201,
            body: {
                data: {
                    transfer: {
                        id: '100',
                        amount_paise: '5000',
                        status: 'completed',
                    },
                    wallet: {
                        id: '1',
                        balance_paise: '5000',
                        currency: 'INR',
                    },
                },
            },
            replayed: false,
        });

        const response = await request(app)
            .post('/wallets/1/top-up')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', 'topup-test-001')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(201);
        expect(response.body.data.wallet.balance_paise).toBe('5000');

        expect(getWalletBalance).toHaveBeenCalledWith({
            walletId: '1',
            userId: '10',
        });

        expect(topUpWallet).toHaveBeenCalledWith({
            walletId: '1',
            userId: '10',
            amountPaise: '5000',
            idempotencyKey: 'topup-test-001',
        });

    });

    test('rejects an invalid wallet ID', async () => {
        const response = await request(app)
            .post('/wallets/abc/top-up')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', 'topup-test-002')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(topUpWallet).not.toHaveBeenCalled();
        expect(getWalletBalance).not.toHaveBeenCalled();
    });

    test('returns the repository validation error', async () => {
        const error = Object.assign(
            new Error('A valid positive amount is required.'),
            {
                status: 400,
                code: 'VALIDATION_ERROR',
            }
        );

        topUpWallet.mockRejectedValue(error);

        const response = await request(app)
            .post('/wallets/1/top-up')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', 'topup-test-003')
            .send({ amountPaise: '0' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns HTTP 404 when the wallet is missing or belongs to another user', async () => {
        getWalletBalance.mockResolvedValue(null);

        const response = await request(app)
            .post('/wallets/999999/top-up')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', 'topup-test-004')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
        expect(topUpWallet).not.toHaveBeenCalled();
    });

    test('rejects a request without a JWT', async () => {
        const response = await request(app)
            .post('/wallets/1/top-up')
            .set('Idempotency-Key', 'topup-test-005')
            .send({ amountPaise: '5000' });

        expect(response.status).toBe(401);
        expect(topUpWallet).not.toHaveBeenCalled();
    });
});