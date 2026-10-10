const express = require('express');
const { createUser } = require('../repositories/user.repository');

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const email =
            typeof req.body?.email === 'string'
                ? req.body.email.trim().toLowerCase()
                : '';

        const fullName =
            typeof req.body?.fullName === 'string'
                ? req.body.fullName.trim()
                : '';

        if (!email || !fullName) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Email and fullName are required.',
                },
            });
        }

        if (email.length > 254 || fullName.length > 120) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Email or fullName exceeds the allowed length.',
                },
            });
        }

        const user = await createUser({ email, fullName });

        return res.status(201).json({ data: user });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({
                error: {
                    code: 'EMAIL_ALREADY_EXISTS',
                    message: 'A user with this email already exists.',
                },
            });
        }

        return next(error);
    }
});

module.exports = router;