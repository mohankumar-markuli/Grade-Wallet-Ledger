function errorBody(req, code, message) {
    return { code, message, request_id: req.requestId };
}

function notFound(req, res) {
    return res.status(404).json(errorBody(
        req,
        'NOT_FOUND',
        'The requested resource was not found.'
    ));
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
        ? err.status
        : 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message = status === 500
        ? 'The request could not be completed.'
        : err.message;
    return res.status(status).json(errorBody(req, code, message));
}

module.exports = { errorBody, notFound, errorHandler };
