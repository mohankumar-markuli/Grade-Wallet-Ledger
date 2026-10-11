const express = require('express');
const adminRoutes = require('./admin.routes');
const authRoutes = require('./auth.routes');
const healthRoutes = require('./health.routes');
const statementRoutes = require('./statement.routes');
const transferRoutes = require('./transfer.routes');
const userRoutes = require('./user.routes');
const userWalletRoutes = require('./user-wallet.routes');
const walletRoutes = require('./wallet.routes');

const router = express.Router();
router.use('/api', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/users', userWalletRoutes);
router.use('/wallets', walletRoutes);
router.use('/', statementRoutes);
router.use('/transfers', transferRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
