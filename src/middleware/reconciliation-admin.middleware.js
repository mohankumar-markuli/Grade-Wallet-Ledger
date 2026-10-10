const crypto = require('node:crypto');

function reconciliationAdminToken(req, res, next) {
    const configuredToken = process.env.RECONCILIATION_ADMIN_TOKEN;

    if (typeof configuredToken !== 'string' || configuredToken.length < 32) {
        return res.status(503).json({
            error: {
                code: 'ADMIN_AUTH_NOT_CONFIGURED',
                message: 'Manual reconciliation is unavailable until its admin token is configured.'
            }
        });
    }

    const authorization = req.get('Authorization') || '';
    const suppliedToken = authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
    const supplied = Buffer.from(suppliedToken);
    const expected = Buffer.from(configuredToken);
    const matches = supplied.length === expected.length
        && crypto.timingSafeEqual(supplied, expected);

    if (!matches) {
        return res.status(401).json({
            error: {
                code: 'ADMIN_AUTH_REQUIRED',
                message: 'A valid reconciliation administrator token is required.'
            }
        });
    }

    return next();
}

module.exports = reconciliationAdminToken;
