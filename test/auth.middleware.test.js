const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const authenticateToken = require('../src/middleware/auth.middleware');
const requestId = require('../src/middleware/request-id.middleware');

const app = express();
app.use(requestId);

app.get('/protected', authenticateToken, (req, res) => {
    res.status(200).json({
        user: req.user,
    });
});

describe('Authentication middleware', () => {
    const testSecret = 'test-secret-for-middleware-tests';

    beforeAll(() => {
        process.env.JWT_SECRET = testSecret;
    });

    afterAll(() => {
        delete process.env.JWT_SECRET;
    });

    test('rejects a request without a token', async () => {
        const response = await request(app).get('/protected');

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('AUTHENTICATION_REQUIRED');
        expect(response.body.message).toBe(
            'Authentication token is required.'
        );
    });

    test('rejects an invalid token', async () => {
        const response = await request(app)
            .get('/protected')
            .set('Authorization', 'Bearer invalid-token');

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('INVALID_AUTHENTICATION');
        expect(response.body.message).toBe(
            'Invalid or expired authentication token.'
        );
    });

    test('rejects an expired token', async () => {
        const token = jwt.sign(
            { email: 'user@example.com' },
            testSecret,
            {
                subject: '1',
                expiresIn: -1,
                issuer: 'grade-wallet-ledger',
                audience: 'grade-wallet-ledger-api',
            }
        );

        const response = await request(app)
            .get('/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(401);
    });

    test('accepts a valid token and attaches the user to the request', async () => {
        const token = jwt.sign(
            { email: 'user@example.com' },
            testSecret,
            {
                subject: '123',
                expiresIn: '15m',
                issuer: 'grade-wallet-ledger',
                audience: 'grade-wallet-ledger-api',
            }
        );

        const response = await request(app)
            .get('/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(response.body.user).toEqual({
            id: '123',
            email: 'user@example.com',
        });
    });

    test('rejects a token with the wrong audience', async () => {
        const token = jwt.sign(
            { email: 'user@example.com' },
            testSecret,
            {
                subject: '123',
                expiresIn: '15m',
                issuer: 'grade-wallet-ledger',
                audience: 'another-api',
            }
        );

        const response = await request(app)
            .get('/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(401);
    });
});
