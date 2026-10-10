const pool = require('../config/db');

async function createUser({ email, fullName }) {
    const query = `
        INSERT INTO users (email, full_name)
        VALUES ($1, $2)
        RETURNING id, email, full_name, status, created_at;
    `;

    const values = [email, fullName];

    const result = await pool.query(query, values);

    return result.rows[0];
}

module.exports = {
    createUser,
};