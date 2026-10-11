const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const statementsController = require('../controllers/statements.controller');

const router = express.Router();

router.get('/wallets/:id/statement', authenticateToken, statementsController.getWalletStatement);
router.post('/users/:id/statement/ask', authenticateToken, requireIdempotencyKey, statementsController.askStatementQuestion);

module.exports = router;
