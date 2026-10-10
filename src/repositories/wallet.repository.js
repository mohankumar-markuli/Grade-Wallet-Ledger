
const pool = require('../config/db');

async function createWallet({ userId }) {
    const query = `
        INSERT INTO accounts (user_id, account_type)
        VALUES ($1, 'wallet')
        RETURNING id, user_id, account_type, currency,
                  balance_paise, status, created_at;
    `;

    const result = await pool.query(query, [userId]);

    return result.rows[0];
}

async function getWalletBalance({ walletId, userId }) {
    const query = `
        SELECT id, user_id, currency, balance_paise, status
        FROM accounts
        WHERE id = $1
          AND user_id = $2
          AND account_type = 'wallet';
    `;

    const result = await pool.query(query, [walletId, userId]);

    return result.rows[0] || null;
}

module.exports = {
    createWallet,
    getWalletBalance,
};