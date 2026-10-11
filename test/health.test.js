
const request = require('supertest');
const app = require('../src/app');

describe('GET /api/health', () => {
    test('returns HTTP 200 and the service health status', async () => {
        const response = await request(app).get('/api/health');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            status: 'ok',
            service: 'grade-wallet-ledger',
            request_id: response.headers['x-request-id'],
        });
    });

    test('returns one request ID and the standard error shape for unknown routes', async () => {
        const response = await request(app)
            .get('/api/not-a-route')
            .set('X-Request-Id', 'delivery-check-001');

        expect(response.status).toBe(404);
        expect(response.headers['x-request-id']).toBe('delivery-check-001');
        expect(response.body).toEqual({
            code: 'NOT_FOUND',
            message: 'The requested resource was not found.',
            request_id: 'delivery-check-001',
        });
    });
});
