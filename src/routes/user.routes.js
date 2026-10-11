const express = require('express');
const { requireIdempotencyKey } = require('../middleware/require-idempotency-key.middleware');
const usersController = require('../controllers/users.controller');

const router = express.Router();
router.post('/', requireIdempotencyKey, usersController.create);

module.exports = router;
