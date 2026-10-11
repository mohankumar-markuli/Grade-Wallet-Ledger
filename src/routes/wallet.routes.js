const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const walletsController = require('../controllers/wallets.controller');

const router = express.Router();
router.use(authenticateToken);

router.post('/', requireIdempotencyKey, walletsController.create);
router.get('/:id/balance', walletsController.getBalance);
router.post('/:id/top-up', requireIdempotencyKey, walletsController.topUp);
router.post('/:id/transfer', requireIdempotencyKey, walletsController.transferFromWallet);

module.exports = router;
