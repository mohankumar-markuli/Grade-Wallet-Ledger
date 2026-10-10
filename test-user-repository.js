require('dotenv').config();

const pool = require('./src/config/db');
const { createUser } = require('./src/repositories/user.repository');

async function main() {
    try {
        const user = await createUser({
            email: 'repository.test@example.com',
            fullName: 'Repository Test User',
        });

        console.log('User created successfully.');
        console.log(user);
    } catch (error) {
        console.error('User creation failed:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();