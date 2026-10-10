
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
            .send({
                email: ' TEST@EXAMPLE.COM ',
                fullName: ' Test User ',
                password: 'correct-horse-battery-staple',
            });

        expect(response.status).toBe(201);
        expect(response.body.data.email).toBe('test@example.com');
        expect(response.body.data.password_hash).toBeUndefined();

        expect(createUser).toHaveBeenCalledWith({
            email: 'test@example.com',
            fullName: 'Test User',
            password: 'correct-horse-battery-staple',
        });
    });

    test('rejects missing required fields with HTTP 400', async () => {
        const response = await request(app)
            .post('/users')
            .send({ email: 'test@example.com' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(createUser).not.toHaveBeenCalled();
    });

    test('rejects a password that is too short', async () => {
        const response = await request(app)
            .post('/users')
            .send({
                email: 'test@example.com',
                fullName: 'Test User',
                password: 'short',
            });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(createUser).not.toHaveBeenCalled();
    });

    test('returns HTTP 409 when the email already exists', async () => {
        const duplicateError = new Error('Duplicate email');
        duplicateError.code = '23505';
        createUser.mockRejectedValue(duplicateError);

        const response = await request(app)
            .post('/users')
            .send({
                email: 'test@example.com',
                fullName: 'Test User',
                password: 'correct-horse-battery-staple',
            });

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });
});
