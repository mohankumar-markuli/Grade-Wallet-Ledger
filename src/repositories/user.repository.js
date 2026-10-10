
const bcrypt = require('bcrypt');
const pool = require('../config/db');

async function createUser({ email, fullName, password }) {
    const passwordHash = await bcrypt.hash(password, 12);

    const query = `
        INSERT INTO users (email, full_name, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, email, full_name, status, created_at;
    `;

    const values = [email, fullName, passwordHash];

    const result = await pool.query(query, values);

    return result.rows[0];
}

async function findUserByEmail(email) {
    const query = `
        SELECT id, email, full_name, password_hash, status
        FROM users
        WHERE email = $1;
    `;

    const result = await pool.query(query, [email]);

    return result.rows[0] || null;
}

module.exports = {
    createUser,
    findUserByEmail,
};
