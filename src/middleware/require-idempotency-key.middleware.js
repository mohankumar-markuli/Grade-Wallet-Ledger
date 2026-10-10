const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireIdempotencyKey(req, res, next) {
    const key = req.get('Idempotency-Key');

    if (typeof key !== 'string' || !UUID_PATTERN.test(key)) {
        return res.status(400).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid UUID Idempotency-Key header is required.'
            }
        });
    }

    req.idempotencyKey = key;
    return next();
}

module.exports = { requireIdempotencyKey };
