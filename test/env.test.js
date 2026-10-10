
const { validateEnv } = require('../src/config/env');

describe('validateEnv', () => {
    test('accepts a valid PostgreSQL URL and supplies defaults', () => {
        const config = validateEnv({
            DATABASE_URL: 'postgresql://wallet_user:example@localhost:5432/wallet_db',
        });

        expect(config).toEqual({
            port: 3000,
            databaseUrl:
                'postgresql://wallet_user:example@localhost:5432/wallet_db',
            nodeEnv: 'development',
        });
    });

    test('rejects a missing DATABASE_URL', () => {
        expect(() => validateEnv({})).toThrow(
            'Missing required environment variable(s): DATABASE_URL'
        );
    });

    test('rejects an invalid database URL', () => {
        expect(() =>
            validateEnv({ DATABASE_URL: 'not-a-valid-url' })
        ).toThrow('DATABASE_URL must be a valid PostgreSQL connection URL');
    });

    test('rejects a non-PostgreSQL URL', () => {
        expect(() =>
            validateEnv({ DATABASE_URL: 'https://example.com' })
        ).toThrow('DATABASE_URL must use the postgres or postgresql protocol');
    });
});
