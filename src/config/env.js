
const REQUIRED_ENV_VARS = ['DATABASE_URL'];

function validateEnv(env = process.env) {
    const missing = REQUIRED_ENV_VARS.filter((name) => {
        return !env[name] || env[name].trim() === '';
    });

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variable(s): ${missing.join(', ')}`
        );
    }

    let databaseUrl;

    try {
        databaseUrl = new URL(env.DATABASE_URL);
    } catch {
        throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
    }

    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
        throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
    }

    return {
        port: Number(env.PORT || 3000),
        databaseUrl: env.DATABASE_URL,
        nodeEnv: env.NODE_ENV || 'development',
    };
}

module.exports = { validateEnv };
