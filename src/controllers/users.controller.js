const { createUser } = require('../repositories/user.repository');

async function create(req, res, next) {
    try {
        const email = typeof req.body?.email === 'string'
            ? req.body.email.trim().toLowerCase()
            : '';
        const fullName = typeof req.body?.fullName === 'string'
            ? req.body.fullName.trim()
            : '';
        const phone = typeof req.body?.phone === 'string'
            ? req.body.phone.trim()
            : '';
        const password = typeof req.body?.password === 'string'
            ? req.body.password
            : '';

        if (!email || !fullName || !phone || !password) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'Email, fullName, phone, and password are required.'
            } });
        }
        if (email.length > 254 || fullName.length > 120) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'Email or fullName exceeds the allowed length.'
            } });
        }
        if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'Password must be at least 12 characters and no more than 72 UTF-8 bytes.'
            } });
        }

        const user = await createUser({
            email,
            fullName,
            phone,
            password,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(201).json({ data: user });
    } catch (error) {
        if (error.status && error.code) {
            return res.status(error.status).json({ error: {
                code: error.code,
                message: error.message
            } });
        }
        if (error.code === '23505') {
            return res.status(409).json({ error: {
                code: 'EMAIL_ALREADY_EXISTS',
                message: 'A user with this email already exists.'
            } });
        }
        return next(error);
    }
}

module.exports = { create };
