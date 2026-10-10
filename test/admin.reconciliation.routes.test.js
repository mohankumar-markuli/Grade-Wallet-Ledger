jest.mock('../src/repositories/reconciliation.repository', () => ({
    runReconciliation: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const adminRoutes = require('../src/routes/admin.routes');
const {
    runReconciliation
} = require('../src/repositories/reconciliation.repository');

const TOKEN = 'test-only-reconciliation-token-with-32-bytes';
const KEY = '90000000-0000-4000-8000-000000000001';

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin', adminRoutes);
    return app;
}

describe('manual reconciliation endpoint', () => {
    const originalToken = process.env.RECONCILIATION_ADMIN_TOKEN;

    beforeEach(() => {
        process.env.RECONCILIATION_ADMIN_TOKEN = TOKEN;
        runReconciliation.mockReset();
    });

    afterAll(() => {
        if (originalToken === undefined) {
            delete process.env.RECONCILIATION_ADMIN_TOKEN;
        } else {
            process.env.RECONCILIATION_ADMIN_TOKEN = originalToken;
        }
    });

    test('rejects a missing administrator token', async () => {
        const response = await request(createTestApp())
            .post('/admin/reconciliation/run')
            .set('Idempotency-Key', KEY)
            .send({});

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('ADMIN_AUTH_REQUIRED');
        expect(runReconciliation).not.toHaveBeenCalled();
    });

    test('requires an idempotency key before running', async () => {
        const response = await request(createTestApp())
            .post('/admin/reconciliation/run')
            .set('Authorization', 'Bearer ' + TOKEN)
            .send({});

        expect(response.status).toBe(400);
        expect(runReconciliation).not.toHaveBeenCalled();
    });

    test('returns the reconciliation report to an authorized caller', async () => {
        const body = { data: { runId: '41', status: 'completed' } };
        runReconciliation.mockResolvedValue({
            status: 200,
            body,
            replayed: false
        });

        const response = await request(createTestApp())
            .post('/admin/reconciliation/run')
            .set('Authorization', 'Bearer ' + TOKEN)
            .set('Idempotency-Key', KEY)
            .send({});

        expect(response.status).toBe(200);
        expect(response.body).toEqual(body);
        expect(runReconciliation).toHaveBeenCalledWith({
            idempotencyKey: KEY,
            requestBody: {}
        });
    });
});
