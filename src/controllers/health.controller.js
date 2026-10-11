function getHealth(req, res) {
    return res.status(200).json({
        status: 'ok',
        service: 'grade-wallet-ledger',
        request_id: req.requestId
    });
}

module.exports = { getHealth };
