
const request = require('supertest');
const app = require('../src/app');
const { createUser } = require('../src/repositories/user.repository');

jest.mock('../src/repositories/user.repository', () => ({
    createUser: jest.fn(),
}));

describe('POST /users', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates a user and returns HTTP 201', async () => {
        createUser.mockResolvedValue({
            id: '10',
            email: 'test@example.com',
            full_name: 'Test User',
            status: 'active',
            created_at: '2026-10-10T12:00:00.000Z',
        });

        const response = await request(app)
            .post('/users')
            .set('Idempotency-Key', '03030303-0303-4303-8303-030303030303')
            .send({
                email: ' TEST@EXAMPLE.COM ',
                fullName: ' Test User ',
                phone: ' +91 9876543210 ',
                password: 'correct-horse-battery-staple',
            });

        expect(response.status).toBe(201);
        expect(response.body.data.email).toBe('test@example.com');
        expect(response.body.data.password_hash).toBeUndefined();

        expect(createUser).toHaveBeenCalledWith({
            email: 'test@example.com',
            fullName: 'Test User',
            phone: '+91 9876543210',
            password: 'correct-horse-battery-staple',
            idempotencyKey: '03030303-0303-4303-8303-030303030303'
        });
    });

    test('rejects missing required fields with HTTP 400', async () => {
        const response = await request(app)
            .post('/users')
            .set('Idempotency-Key', '05050505-0505-4505-8505-050505050505')
            .send({ email: 'test@example.com' });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(createUser).not.toHaveBeenCalled();
    });

    test('rejects a password that is too short', async () => {
        const response = await request(app)
            .post('/users')
            .set('Idempotency-Key', '04040404-0404-4404-8404-040404040404')
            .send({
                email: 'test@example.com',
                fullName: 'Test User',
                phone: '+91 9876543210',
                password: 'short',
            });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(createUser).not.toHaveBeenCalled();
    });

    test('returns HTTP 409 when the email already exists', async () => {
        const duplicateError = new Error('Duplicate email');
        duplicateError.code = '23505';
        createUser.mockRejectedValue(duplicateError);

        const response = await request(app)
            .post('/users')
            .set('Idempotency-Key', '06060606-0606-4606-8606-060606060606')
            .send({
                email: 'test@example.com',
                fullName: 'Test User',
                phone: '+91 9876543210',
                password: 'correct-horse-battery-staple',
            });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('EMAIL_ALREADY_EXISTS');
    });
});
