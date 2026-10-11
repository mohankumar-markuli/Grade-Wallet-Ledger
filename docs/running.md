# Project Running Guide

This guide provides the complete, step-by-step instructions to run, test, and seed the **Grade Wallet Ledger** project across different environments.

---

## Prerequisites

- **Node.js**: v22+
- **Docker Desktop**: Running locally
- **Git**

---

## Method 1: Run with Docker Compose (Single Command - Recommended)

This is the standard approach for local evaluation and submission reviewers. Docker Compose starts PostgreSQL 16, automatically runs all database migrations against `wallet_db`, and starts both the Express API and background worker services.

### 1. Prepare Environment Variables
Ensure you have a `.env` file in the root directory:
```bash
cp .env.example .env
```
*(On Windows PowerShell: `Copy-Item .env.example .env`)*

Configure standard values in `.env`:
```env
POSTGRES_USER=wallet_user
POSTGRES_PASSWORD=wallet_dev_password
POSTGRES_DB=wallet_db
POSTGRES_PORT=5433
PORT=3000
JWT_SECRET=super-secret-jwt-key-for-local-dev
RECONCILIATION_ADMIN_TOKEN=reconciliation-admin-secret-token
LLM_PROVIDER=mock
```

### 2. Start All Services
```bash
docker compose up --build
```

### 3. Verify System Health
Once services are running, verify the API health endpoint:
```bash
curl http://localhost:3000/api/health
```
**Expected Output:**
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-10-11T..."
}
```

### 4. Stopping the Services
- Press `Ctrl + C` in your terminal to stop.
- To take down containers while preserving the database volume:
  ```bash
  docker compose down
  ```
- To take down containers and wipe the database volume:
  ```bash
  docker compose down -v
  ```

---

## Method 2: Run Locally Without Docker (Node.js Direct)

If you are running PostgreSQL on your host or via a standalone database container:

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Local Database Connection
Set your `.env` connection strings:
```env
PORT=3000
DATABASE_URL=postgres://wallet_user:wallet_dev_password@localhost:5433/wallet_db
MIGRATION_EXPECTED_DATABASE=wallet_db
JWT_SECRET=super-secret-jwt-key-for-local-dev
RECONCILIATION_ADMIN_TOKEN=reconciliation-admin-secret-token
LLM_PROVIDER=mock
```

### 3. Run Database Migrations
Run the transactional migration runner:
```bash
npm run migrate
```
*(Guarded by `MIGRATION_EXPECTED_DATABASE` to prevent accidental execution on unintended databases).*

### 4. Start the Application
- **Production mode:**
  ```bash
  npm start
  ```
- **Development mode (with nodemon):**
  ```bash
  npm run dev
  ```
- **Background Worker (separate terminal):**
  ```bash
  npm run worker
  ```

---

## Method 3: Running Tests (Isolated Test Database)

All database integration tests must run against the dedicated test database: `wallet_test_db`.

### 1. Apply Migrations to the Test Database
```bash
npm run migrate:test
```
*(Or directly: `node scripts/migrate-test.js`)*

### 2. Run the Full Test Suite
The test runner ensures safety checks and executes Jest with `--runInBand`:
```bash
node scripts/test.js
```
*(Or `npm test` if PowerShell execution policy permits).*

### 3. Run Specific Test Files
To run targeted test suites:
```bash
node scripts/test.js test/transfer.integration.test.js test/topup.integration.test.js
```

---

## Method 4: Running the 100k Seed Script & Benchmarks

The project includes a seed script that populates 1,000 users, 2,000 wallets, and 100,000 completed balanced double-entry transfers in a single transaction.

> [!WARNING]
> The seed script strictly requires a database name ending with `_seed_db` and matching `SEED_EXPECTED_DATABASE`.

### 1. Create and Migrate a Dedicated Seed Database
In PostgreSQL:
```sql
CREATE DATABASE wallet_seed_db;
```

Run migrations targeting the seed database:
```bash
# In PowerShell:
$env:DATABASE_URL="postgres://wallet_user:wallet_dev_password@localhost:5433/wallet_seed_db"
$env:MIGRATION_EXPECTED_DATABASE="wallet_seed_db"
node scripts/migrate.js
```

### 2. Execute the Seed Script
```bash
$env:SEED_EXPECTED_DATABASE="wallet_seed_db"
node scripts/seed.js
```

---

## Quick API Sanity Check

Once the API is active at `http://localhost:3000`:

1. **Register a User:**
   ```bash
   curl -X POST http://localhost:3000/users \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: 11111111-1111-4111-8111-111111111111" \
     -d '{"fullName":"John Doe","email":"john@example.com","phone":"+919876543210","password":"securePass123!"}'
   ```

2. **Log In:**
   ```bash
   curl -X POST http://localhost:3000/auth/login \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: 22222222-2222-4222-8222-222222222222" \
     -d '{"email":"john@example.com","password":"securePass123!"}'
   ```

3. **Open a Wallet (Using returned token):**
   ```bash
   curl -X POST http://localhost:3000/wallets \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: 33333333-3333-4333-8333-333333333333" \
     -d '{"name":"Primary Wallet"}'
   ```

4. **Top Up Wallet (e.g., ₹500 = 50,000 paise):**
   ```bash
   curl -X POST http://localhost:3000/transfers/topup \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: 44444444-4444-4444-8444-444444444444" \
     -d '{"walletId":"<WALLET_ID>","amountPaise":50000}'
   ```

5. **Check Balance:**
   ```bash
   curl -X GET http://localhost:3000/wallets/<WALLET_ID>/balance \
     -H "Authorization: Bearer <TOKEN>"
   ```
