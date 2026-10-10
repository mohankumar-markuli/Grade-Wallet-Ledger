const express = require('express');
const userRoutes = require('./routes/user.routes');
const walletRoutes = require('./routes/wallet.routes');

const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'grade-wallet-ledger',
    });
});

app.use('/users', userRoutes);
app.use('/wallets', walletRoutes);

module.exports = app;