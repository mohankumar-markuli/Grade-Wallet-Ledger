const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const walletsController = require('../controllers/wallets.controller');

const router = express.Router();
router.post('/:id/wallets', authenticateToken, requireIdempotencyKey, walletsController.createForUser);

module.exports = router;
