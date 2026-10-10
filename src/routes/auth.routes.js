
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { findUserByEmail } = require('../repositories/user.repository');

const router = express.Router();

router.post('/login', async (req, res, next) => {
    try {
        const email =
            typeof req.body.email === 'string'
                ? req.body.email.trim().toLowerCase()
                : '';

        const password =
            typeof req.body.password === 'string'
                ? req.body.password
                : '';

        if (!email || !password) {
            return res.status(400).json({
                error: 'Email and password are required',
            });
        }

        const user = await findUserByEmail(email);

        // Use the same response for unknown users and incorrect passwords.
        if (!user || !user.password_hash) {
            return res.status(401).json({
                error: 'Invalid email or password',
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                error: 'Invalid email or password',
            });
        }

        if (user.status !== 'active') {
            return res.status(403).json({
                error: 'Account is not active',
            });
        }

        if (!process.env.JWT_SECRET) {
            throw new Error('JWT_SECRET is not configured');
        }

        const token = jwt.sign(
            {
                email: user.email,
            },
            process.env.JWT_SECRET,
            {
                subject: String(user.id),
                expiresIn: '15m',
                issuer: 'grade-wallet-ledger',
                audience: 'grade-wallet-ledger-api',
            }
        );

        return res.status(200).json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                status: user.status,
            },
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
