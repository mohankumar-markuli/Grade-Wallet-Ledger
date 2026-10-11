const { randomUUID } = require('node:crypto');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestId(req, res, next) {
    const supplied = req.get('X-Request-Id');
    req.requestId = supplied && REQUEST_ID_PATTERN.test(supplied)
        ? supplied
        : randomUUID();
    res.set('X-Request-Id', req.requestId);

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (body && typeof body === 'object' && body.error) {
            const error = typeof body.error === 'object'
                ? body.error
                : { message: String(body.error) };
            return originalJson({
                code: error.code || 'REQUEST_FAILED',
                message: error.message || 'The request could not be completed.',
                request_id: req.requestId
            });
        }
        return originalJson(body);
    };

    next();
}

module.exports = requestId;
