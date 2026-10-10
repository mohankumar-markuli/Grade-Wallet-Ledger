const express = require('express');
const request = require('supertest');
const {
    requireIdempotencyKey
} = require('../src/middleware/require-idempotency-key.middleware');

const app = express();
app.post('/write', requireIdempotencyKey, (req, res) => {
    res.status(200).json({ key: req.idempotencyKey });
});

describe('requireIdempotencyKey middleware', () => {
    test('rejects a missing key with HTTP 400', async () => {
        const response = await request(app).post('/write');

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('rejects a non-UUID key with HTTP 400', async () => {
        const response = await request(app)
            .post('/write')
            .set('Idempotency-Key', 'not-a-uuid');

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('accepts a UUID key and makes it available to the route', async () => {
        const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const response = await request(app)
            .post('/write')
            .set('Idempotency-Key', key);

        expect(response.status).toBe(200);
        expect(response.body.key).toBe(key);
    });
});
