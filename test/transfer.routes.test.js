
jest.mock('../src/repositories/transfer.repository', () => ({
    transferBetweenWallets: jest.fn(),
}));

jest.mock('../src/repositories/wallet.repository', () => ({
    createWallet: jest.fn(),
    getWalletBalance: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

const {
    transferBetweenWallets,
} = require('../src/repositories/transfer.repository');

const {
    getWalletBalance,
} = require('../src/repositories/wallet.repository');

const TEST_SECRET = 'test-secret-for-transfer-route-tests';

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

describe('POST /wallets/:id/transfer', () => {
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
            balance_paise: '5000',
            status: 'active',
        });
    });

    test('creates a transfer and returns HTTP 201', async () => {
        transferBetweenWallets.mockResolvedValue({
            status: 201,
            replayed: false,
            body: {
                data: {
                    transfer: {
                        id: '10',
                        amount_paise: '1000',
                    },
                },
            },
        });

        const response = await request(app)
            .post('/wallets/1/transfer')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', '20000000-0000-4000-8000-000000000001')
            .send({
                toWalletId: '2',
                amountPaise: '1000',
            });

        expect(response.status).toBe(201);
        expect(response.body.data.transfer.id).toBe('10');

        expect(getWalletBalance).toHaveBeenCalledWith({
            walletId: '1',
            userId: '10',
        });

        expect(transferBetweenWallets).toHaveBeenCalledWith({
            fromWalletId: '1',
            toWalletId: '2',
            userId: '10',
            amountPaise: '1000',
            idempotencyKey: '20000000-0000-4000-8000-000000000001',
        });
    });

    test('rejects an invalid source wallet ID', async () => {
        const response = await request(app)
            .post('/wallets/abc/transfer')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .send({
                toWalletId: '2',
                amountPaise: '1000',
            });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(getWalletBalance).not.toHaveBeenCalled();
        expect(transferBetweenWallets).not.toHaveBeenCalled();
    });

    test('rejects a missing destination wallet ID', async () => {
        const response = await request(app)
            .post('/wallets/1/transfer')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .send({
                amountPaise: '1000',
            });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(transferBetweenWallets).not.toHaveBeenCalled();
    });

    test('returns the repository validation error', async () => {
        transferBetweenWallets.mockRejectedValue(
            Object.assign(
                new Error('Insufficient wallet balance.'),
                {
                    status: 409,
                    code: 'INSUFFICIENT_FUNDS',
                }
            )
        );

        const response = await request(app)
            .post('/wallets/1/transfer')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', '20000000-0000-4000-8000-000000000002')
            .send({
                toWalletId: '2',
                amountPaise: '1000',
            });

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    });

    test('rejects a source wallet that does not belong to the user', async () => {
        getWalletBalance.mockResolvedValue(null);

        const response = await request(app)
            .post('/wallets/1/transfer')
            .set('Authorization', `Bearer ${createToken('10')}`)
            .set('Idempotency-Key', '20000000-0000-4000-8000-000000000003')
            .send({
                toWalletId: '2',
                amountPaise: '1000',
            });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
        expect(transferBetweenWallets).not.toHaveBeenCalled();
    });

    test('rejects a request without a token', async () => {
        const response = await request(app)
            .post('/wallets/1/transfer')
            .send({
                toWalletId: '2',
                amountPaise: '1000',
            });

        expect(response.status).toBe(401);
        expect(transferBetweenWallets).not.toHaveBeenCalled();
    });
});
