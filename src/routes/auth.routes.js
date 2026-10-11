const express = require('express');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const authController = require('../controllers/auth.controller');

const router = express.Router();
router.post('/login', requireIdempotencyKey, authController.login);

module.exports = router;
