
const express = require('express');
const request = require('supertest');

jest.mock('../src/repositories/user.repository', () => ({
    findUserByEmail: jest.fn(),
}));

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
    sign: jest.fn(),
}));

const { findUserByEmail } = require('../src/repositories/user.repository');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authRoutes = require('../src/routes/auth.routes');

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

// Pass unexpected errors to a test-friendly error handler.
app.use((error, req, res, next) => {
    res.status(500).json({ error: error.message });
});

describe('POST /auth/login', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.JWT_SECRET = 'test-secret-for-auth-route-tests';
    });

    afterAll(() => {
        delete process.env.JWT_SECRET;
    });

    test('logs in an active user and returns a token', async () => {
        findUserByEmail.mockResolvedValue({
            id: '1',
            email: 'user@example.com',
            full_name: 'Test User',
            password_hash: '$2b$12$test-hash',
            status: 'active',
        });

        bcrypt.compare.mockResolvedValue(true);
        jwt.sign.mockReturnValue('test-jwt-token');

        const response = await request(app)
            .post('/auth/login')
            .send({
                email: ' USER@EXAMPLE.COM ',
                password: 'correct-password',
            });

        expect(response.status).toBe(200);
        expect(response.body.token).toBe('test-jwt-token');
        expect(response.body.user.email).toBe('user@example.com');
        expect(response.body.user.fullName).toBe('Test User');
        expect(response.body.user.password_hash).toBeUndefined();

        expect(findUserByEmail).toHaveBeenCalledWith('user@example.com');
        expect(bcrypt.compare).toHaveBeenCalledWith(
            'correct-password',
            '$2b$12$test-hash'
        );

        expect(jwt.sign).toHaveBeenCalledWith(
            { email: 'user@example.com' },
            'test-secret-for-auth-route-tests',
            expect.objectContaining({
                subject: '1',
                expiresIn: '15m',
            })
        );
    });

    test('rejects an unknown email', async () => {
        findUserByEmail.mockResolvedValue(null);

        const response = await request(app)
            .post('/auth/login')
            .send({
                email: 'unknown@example.com',
                password: 'some-password',
            });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Invalid email or password');
        expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    test('rejects an incorrect password', async () => {
        findUserByEmail.mockResolvedValue({
            id: '1',
            email: 'user@example.com',
            full_name: 'Test User',
            password_hash: '$2b$12$test-hash',
            status: 'active',
        });

        bcrypt.compare.mockResolvedValue(false);

        const response = await request(app)
            .post('/auth/login')
            .send({
                email: 'user@example.com',
                password: 'wrong-password',
            });

        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Invalid email or password');
        expect(jwt.sign).not.toHaveBeenCalled();
    });

    test('rejects a user without a password hash', async () => {
        findUserByEmail.mockResolvedValue({
            id: '1',
            email: 'user@example.com',
            full_name: 'Test User',
            password_hash: null,
            status: 'active',
        });

        const response = await request(app)
            .post('/auth/login')
            .send({
                email: 'user@example.com',
                password: 'some-password',
            });

        expect(response.status).toBe(401);
        expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    test('rejects an inactive user', async () => {
        findUserByEmail.mockResolvedValue({
            id: '1',
            email: 'user@example.com',
            full_name: 'Test User',
            password_hash: '$2b$12$test-hash',
            status: 'suspended',
        });

        bcrypt.compare.mockResolvedValue(true);

        const response = await request(app)
            .post('/auth/login')
            .send({
                email: 'user@example.com',
                password: 'correct-password',
            });

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Account is not active');
        expect(jwt.sign).not.toHaveBeenCalled();
    });

    test('rejects a request with missing credentials', async () => {
        const response = await request(app)
            .post('/auth/login')
            .send({ email: 'user@example.com' });

        expect(response.status).toBe(400);
        expect(findUserByEmail).not.toHaveBeenCalled();
    });
});