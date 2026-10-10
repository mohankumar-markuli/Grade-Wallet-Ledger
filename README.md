# Grade Wallet Ledger

Backend of a digital wallet, built with Node.js, Express and PostgreSQL. The authoritative requirements are in `Brief.pdf`; schema decisions are recorded in [`docs/schema.md`](docs/schema.md), and the Milestone 2 isolation exercise is in [`docs/isolation.md`](docs/isolation.md).

## Milestone 1 design answers

### How are balances represented?

The schema stores `accounts.balance_paise` for quick balance reads and retains `ledger_entries` as the accounting record. Storing both makes reads faster but duplicates state, so every money movement must write ledger entries and update balances in one transaction. Nightly reconciliation checks the stored balance against ledger-derived balance. Computing balances only from the ledger would avoid duplicated state but make each balance read more expensive.

Amounts are whole paise in `BIGINT`. A debit or credit direction is stored separately from a positive entry amount. Floating-point types are not used for money.

### Why are wallets and system accounts in one table?

Both are accounts that have a balance and receive ledger entries. One `accounts` table means every ledger entry refers to the same kind of record and the same reconciliation queries cover wallets and system accounts. Wallets have a user owner; cash-in, cash-out and fee revenue accounts do not. A wallet's balance must stay nonnegative; system account balances may be negative.

### Which values come from outside the system, and why are they not primary keys?

Email and phone are supplied externally and can change or be reused. They are stored as user attributes, not primary keys. Each user gets a generated `BIGINT` identifier. A name is also user data and may change.

## Milestone 2: transfer safety

The transfer repository uses PostgreSQL's default **Read Committed** isolation and explicit `SELECT ... FOR UPDATE` locks. It locks the source and destination accounts in ascending account ID order, checks the source balance after obtaining the locks, then writes the transfer, ledger entries and updated balances in the same transaction. A failure rolls the transaction back. This protects the transfer invariant because every competing spend must acquire the same source wallet row lock and then check the latest committed balance. Serializable isolation would add serialization failures and retries without adding value to this operation when all affected account rows are explicitly locked.

The two-session isolation lab and its observed results belong in [`docs/isolation.md`](docs/isolation.md). The 100-request, 20-run stampede acceptance test is `test/transfer.stampede.integration.test.js`; do not claim it passes until it has been run against `wallet_test_db`.

## Repository status

The repository contains a partial implementation. Its existing migrations and application code are compared with the brief in `docs/schema.md`; do not treat later-milestone behavior as complete unless it has been implemented and verified. Migrations are versioned SQL files applied by `npm run migrate`. Before applying them, confirm the configured database is the intended target. Do not use the development database for tests; use `wallet_test_db`.

## Milestone 3: safe retries

State-changing POST routes require an RFC 4122 UUID in `Idempotency-Key`. Authenticated wallet creation, top-ups and transfers use `(user_id, idempotency_key)` as their database scope. Public user registration has no authenticated user ID before it creates the user; migration 011 allows a null user scope and enforces unique registration keys with a partial unique index. `POST /auth/login` does not persist a state change and is not idempotency-keyed.

The handler stores a SHA-256 request hash and the first response in the same transaction as the write. A matching key and request replays the saved response; a matching key with a different request returns HTTP 422. The PostgreSQL acceptance tests are in `test/idempotency.integration.test.js` and require the `wallet_test_db` migration to include migration 011.
## Milestone 4: nightly reconciliation

The reconciliation runner checks the ledger in one PostgreSQL REPEATABLE READ transaction. It verifies global debit/credit totals, completed-transfer balance, stored account balances against ledger-derived balances, nonnegative wallet ledger balances, and missing transfer or ledger parents. The ledger sign convention is credits minus debits for every account.

Each run and its findings are saved in reconciliation_runs and reconciliation_problems. The runner reports inconsistencies and does not repair balances or ledger entries. When multiple checks identify the same underlying transfer corruption, the report stores one root finding and includes related account and global-total checks in its details; this avoids counting one damaged transfer several times.

The nightly scheduler can run at 00:00 UTC in the API process when ENABLE_RECONCILIATION_SCHEDULER=true and RECONCILIATION_EXPECTED_DATABASE set to the exact checked database name. The scheduler stays disabled by default and refuses to start if that name does not match current_database(). The manual endpoint is POST /admin/reconciliation/run. Configure RECONCILIATION_ADMIN_TOKEN in the local environment with a random value of at least 32 characters and send it as a Bearer token. This local admin-token mechanism is an implementation assumption because the project does not yet have administrator accounts or roles. Manual runs also require the UUID Idempotency-Key header.

Apply migration 012 only after confirming the configured database is wallet_test_db. The PostgreSQL acceptance test seeds 10,000 transfers, introduces three isolated corruptions, checks that they are reported without unrelated findings, verifies replay, and removes its fixture data. Run it with:

    npm.cmd test -- --runInBand test/reconciliation.integration.test.js test/admin.reconciliation.routes.test.js test/reconciliation.scheduler.test.js

The reconciliation benchmark helper in scripts/reconciliation-benchmark.js seeds one balanced transfer with one million ledger entries, runs EXPLAIN ANALYZE for all checks, and removes its fixture. Each action refuses to run unless DATABASE_URL selects wallet_test_db. Record the observed plan summaries in docs/reconciliation.md; do not describe the benchmark as complete until it has been run. Do not describe the benchmark as complete until it has been run against a large test dataset.