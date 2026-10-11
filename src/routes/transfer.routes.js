const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const transfersController = require('../controllers/transfers.controller');

const router = express.Router();
router.use(authenticateToken);

router.post('/topup', requireIdempotencyKey, transfersController.topUp);
router.post('/', requireIdempotencyKey, transfersController.createPeerTransfer);
router.post('/withdraw', requireIdempotencyKey, transfersController.withdraw);
router.post('/:id/reverse', requireIdempotencyKey, transfersController.reverse);
router.get('/:id', transfersController.getTransfer);

module.exports = router;
