
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    const authorizationHeader = req.headers.authorization;

    if (
        !authorizationHeader ||
        !authorizationHeader.startsWith('Bearer ')
    ) {
        return res.status(401).json({
            error: 'Authentication token is required',
        });
    }

    const token = authorizationHeader.slice(7).trim();

    if (!token) {
        return res.status(401).json({
            error: 'Authentication token is required',
        });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
        return res.status(500).json({
            error: 'Authentication configuration error',
        });
    }

    try {
        const decoded = jwt.verify(token, secret, {
            issuer: 'grade-wallet-ledger',
            audience: 'grade-wallet-ledger-api',
        });

        if (!decoded.sub) {
            return res.status(401).json({
                error: 'Invalid or expired authentication token',
            });
        }

        req.user = {
            id: decoded.sub,
            email: decoded.email,
        };

        return next();
    } catch (error) {
        return res.status(401).json({
            error: 'Invalid or expired authentication token',
        });
    }
}

module.exports = authenticateToken;