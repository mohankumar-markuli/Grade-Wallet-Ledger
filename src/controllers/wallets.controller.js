const {
    createWallet,
    getWalletBalance
} = require('../repositories/wallet.repository');
const { topUpWallet } = require('../repositories/topup.repository');
const { transferBetweenWallets } = require('../repositories/transfer.repository');

async function create(req, res, next) {
    try {
        const suppliedName = req.body?.name;
        const name = suppliedName === undefined ? 'Wallet' : suppliedName;
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'Wallet name must contain 1 to 120 characters.'
            } });
        }
        const wallet = await createWallet({
            userId: req.user.id,
            name: name.trim(),
            idempotencyKey: req.idempotencyKey
        });
        return res.status(201).json({ data: wallet });
    } catch (error) {
        if (error.status && error.code) {
            return res.status(error.status).json({ error: {
                code: error.code,
                message: error.message
            } });
        }
        if (error.code === '23503') {
            return res.status(404).json({ error: {
                code: 'USER_NOT_FOUND',
                message: 'The authenticated user does not exist.'
            } });
        }
        return next(error);
    }
}

async function createForUser(req, res, next) {
    if (String(req.user.id) !== String(req.params.id)) {
        return res.status(404).json({ error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found.'
        } });
    }
    return create(req, res, next);
}

async function getBalance(req, res, next) {
    try {
        const { id } = req.params;
        if (!/^[1-9]\d*$/.test(id)) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid wallet ID is required.'
            } });
        }
        const wallet = await getWalletBalance({ walletId: id, userId: req.user.id });
        if (!wallet) {
            return res.status(404).json({ error: {
                code: 'WALLET_NOT_FOUND',
                message: 'Wallet not found.'
            } });
        }
        return res.status(200).json({ data: wallet });
    } catch (error) {
        return next(error);
    }
}

async function topUp(req, res, next) {
    try {
        const { id } = req.params;
        if (!/^[1-9]\d*$/.test(id)) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid wallet ID is required.'
            } });
        }
        const wallet = await getWalletBalance({ walletId: id, userId: req.user.id });
        if (!wallet) {
            return res.status(404).json({ error: {
                code: 'WALLET_NOT_FOUND',
                message: 'Wallet not found.'
            } });
        }
        const result = await topUpWallet({
            walletId: id,
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        if (error.status && error.code) {
            return res.status(error.status).json({ error: {
                code: error.code,
                message: error.message
            } });
        }
        return next(error);
    }
}

async function transferFromWallet(req, res, next) {
    try {
        const fromWalletId = req.params.id;
        if (!/^[1-9]\d*$/.test(fromWalletId)) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid source wallet ID is required.'
            } });
        }
        const sourceWallet = await getWalletBalance({
            walletId: fromWalletId,
            userId: req.user.id
        });
        if (!sourceWallet) {
            return res.status(404).json({ error: {
                code: 'WALLET_NOT_FOUND',
                message: 'Wallet not found.'
            } });
        }

        const toWalletId = req.body?.toWalletId;
        if (toWalletId === undefined || toWalletId === null
            || !/^[1-9]\d*$/.test(String(toWalletId))) {
            return res.status(400).json({ error: {
                code: 'VALIDATION_ERROR',
                message: 'A valid destination wallet ID is required.'
            } });
        }
        const result = await transferBetweenWallets({
            fromWalletId,
            toWalletId: String(toWalletId),
            userId: req.user.id,
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.idempotencyKey
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        if (error.status && error.code) {
            return res.status(error.status).json({ error: {
                code: error.code,
                message: error.message
            } });
        }
        return next(error);
    }
}

module.exports = { create, createForUser, getBalance, topUp, transferFromWallet };
