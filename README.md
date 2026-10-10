# Grade Wallet Ledger

Backend of a digital wallet, built with Node.js, Express and PostgreSQL. The authoritative requirements are in `Brief.pdf`; the schema decisions for Milestone 1 are recorded in [`docs/schema.md`](docs/schema.md).

## Milestone 1 design answers

### How are balances represented?

The schema stores `accounts.balance_paise` for quick balance reads and retains `ledger_entries` as the accounting record. Storing both makes reads faster but duplicates state, so every money movement must write ledger entries and update balances in one transaction. Nightly reconciliation checks the stored balance against ledger-derived balance. Computing balances only from the ledger would avoid duplicated state but make each balance read more expensive.

Amounts are whole paise in `BIGINT`. A debit or credit direction is stored separately from a positive entry amount. Floating-point types are not used for money.

### Why are wallets and system accounts in one table?

Both are accounts that have a balance and receive ledger entries. One `accounts` table means every ledger entry refers to the same kind of record and the same reconciliation queries cover wallets and system accounts. Wallets have a user owner; cash-in, cash-out and fee revenue accounts do not. A wallet's balance must stay nonnegative; system account balances may be negative.

### Which values come from outside the system, and why are they not primary keys?

Email and phone are supplied externally and can change or be reused. They are stored as user attributes, not primary keys. Each user gets a generated `BIGINT` identifier. A name is also user data and may change.

## Repository status

The repository contains a partial implementation. Its existing migrations and application code are compared with the brief in `docs/schema.md`; do not treat later-milestone behavior as complete unless it has been implemented and verified. Migrations are versioned SQL files applied by `npm run migrate`. Before applying them, confirm the configured database is the intended target. Do not use the development database for tests; use `wallet_test_db`.
