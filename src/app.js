
const express = require('express');

const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'grade-wallet-ledger',
    });
});

module.exports = app;
