const express = require('express');
const { createWallet, getWalletBalance } = require('../repositories/wallet.repository');
const { topUpWallet } = require('../repositories/topup.repository');
const { transferBetweenWallets } = require('../repositories/transfer.repository');

const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const userId = req.body?.userId;

        if (
            userId === undefined ||
            userId === null ||
            !/^[1-9]\d*$/.test(String(userId))
        ) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'A valid userId is required.',
                },
            });
        }

        const wallet = await createWallet({ userId: String(userId) });

        return res.status(201).json({ data: wallet });
    } catch (error) {
        if (error.code === '23503') {
            return res.status(404).json({
                error: {
                    code: 'USER_NOT_FOUND',
                    message: 'The specified user does not exist.',
                },
            });
        }

        return next(error);
    }
});

router.get('/:id/balance', async (req, res, next) => {
    try {
        const walletId = req.params.id;

        if (!/^[1-9]\d*$/.test(walletId)) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'A valid wallet ID is required.',
                },
            });
        }

        const wallet = await getWalletBalance({ walletId });

        if (!wallet) {
            return res.status(404).json({
                error: {
                    code: 'WALLET_NOT_FOUND',
                    message: 'Wallet not found.',
                },
            });
        }

        return res.status(200).json({
            data: wallet,
        });
    } catch (error) {
        return next(error);
    }
});

router.post('/:id/top-up', async (req, res, next) => {
    try {
        const walletId = req.params.id;

        if (!/^[1-9]\d*$/.test(walletId)) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'A valid wallet ID is required.',
                },
            });
        }

        const idempotencyKey = req.get('Idempotency-Key');

        const result = await topUpWallet({
            walletId,
            amountPaise: req.body?.amountPaise,
            idempotencyKey,
        });

        return res.status(result.status).json(result.body);
    } catch (error) {
        if (error.status && error.code) {
            return res.status(error.status).json({
                error: {
                    code: error.code,
                    message: error.message,
                },
            });
        }

        return next(error);
    }
});


router.post('/:id/transfer', async (req, res, next) => {
    try {
        const fromWalletId = req.params.id;

        if (!/^[1-9]\d*$/.test(fromWalletId)) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'A valid source wallet ID is required.',
                },
            });
        }

        const toWalletId = req.body?.toWalletId;

        if (
            toWalletId === undefined ||
            toWalletId === null ||
            !/^[1-9]\d*$/.test(String(toWalletId))
        ) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'A valid destination wallet ID is required.',
                },
            });
        }

        const result = await transferBetweenWallets({
            fromWalletId,
            toWalletId: String(toWalletId),
            amountPaise: req.body?.amountPaise,
            idempotencyKey: req.get('Idempotency-Key'),
        });

        return res.status(result.status).json(result.body);
    } catch (error) {
        if (error.status && error.code) {
            return res.status(error.status).json({
                error: {
                    code: error.code,
                    message: error.message,
                },
            });
        }

        return next(error);
    }
});


module.exports = router;