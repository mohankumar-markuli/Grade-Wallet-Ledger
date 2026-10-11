# Grade Wallet Ledger

A modular monolith for wallet accounts, transfers, double-entry accounting,
idempotent writes, risk review, reconciliation, and statement questions. The
authoritative assignment is `Brief.pdf`; the architecture and implementation
guidance is in `docs/wallet_backend_project_blueprint.md`.

## Start locally

1. Install Docker Desktop and start it.
2. Copy `.env.example` to `.env` and replace the JWT and administrator token
   placeholders with random values. Keep `.env` private; it is ignored by Git.
3. From the repository root, run `docker compose up --build`.
4. Check `http://localhost:3000/api/health`.

Compose starts PostgreSQL, verifies database readiness, applies migrations to
the explicitly named Compose database, then starts the API and background
worker. PostgreSQL maps to host port `5433` by default so a separately running
local PostgreSQL container on port `5432` can stay in place. PostgreSQL data is
stored in a named volume. `docker compose down`
stops services; `docker compose down -v` also deletes the local database volume.

To stop services, press Ctrl+C. For local development without Docker, install
Node.js 22+, configure `DATABASE_URL`, then set
`MIGRATION_EXPECTED_DATABASE` to the exact database name after checking the
target. `npm run migrate` refuses to run unless those names match. Never point
tests or seed data at a development database.

## API

See [`docs/api.md`](docs/api.md) for the complete minimum API contract. All
amounts are whole paise. State-changing POST requests require a client supplied
UUID `Idempotency-Key`. Errors include a request ID and follow one JSON shape.
Bearer authentication scopes wallet data to the caller; administrator routes
use the separately configured administrator token.

## Architecture

The application is one deployable Express service with a PostgreSQL primary.
Routes map paths and middleware, controllers handle HTTP inputs and responses,
services hold cross-repository workflows, and repositories contain explicit
parameterized SQL and transaction boundaries. Scheduled work runs in a separate
worker process. See [`docs/architecture.md`](docs/architecture.md).
The transfer path uses Read Committed with ordered row locks. It rechecks
balances under lock and commits transfer, immutable ledger entries, stored
balances, audit events, and the idempotent response atomically.

Ledger entries use positive amounts and a separate debit/credit direction.
Account balance is computed as credits minus debits for wallets and system
accounts. Wallet stored balances are updated with their ledger entries in the
same transaction. This makes balance reads efficient at the cost of duplicated
state; reconciliation independently checks for drift and never repairs it.

### Why wallets and system accounts share one table

Both are accounts that hold balances and receive ledger entries. A shared
`accounts` table gives every ledger line one consistent foreign key and lets
the same reconciliation query cover wallets and cash-in, cash-out, and fee
revenue accounts. `user_id` distinguishes user wallets from ownerless system
accounts.
Wallet creation accepts an optional display name, so one user can keep separate
wallets such as Main and Savings. Existing unnamed wallets are given the neutral
name `Wallet` by migration 016.

### Which user values come from outside the platform

Email and phone are supplied by users and can change; neither is a stable
system identity. They are attributes on `users`, while every user receives a
generated `BIGINT` primary key. User registration requires phone; KYC begins at
`pending` and is not accepted from the registration request.

### Isolation and consistency trade-offs

Read Committed plus ordered row locks protects transfers because each spend
locks and rechecks the source wallet before changing it. Serializable isolation
would cause more transaction aborts and retries without improving this
particular invariant when every affected account is locked consistently.
Reconciliation uses Repeatable Read to evaluate all checks against one
consistent snapshot. One PostgreSQL primary favors correct financial writes;
if the database is unavailable, the API cannot safely complete money movement.

Atomicity comes from writing transfer, ledger, balance, audit, and saved
response in a single transaction. Database constraints protect row-level rules
and foreign-key relationships. Locks provide isolation for competing spends;
commits provide durability. The normalized schema keeps user, account, transfer,
and ledger-entry facts in their own tables rather than copying mutable user
details into every accounting row.

Indexes support account statements, transfer lookup, idempotency, fraud
velocity checks, risk queues, and nightly reconciliation. Every index adds
write and storage cost; the main ledger indexes are retained because they
serve required statement, transfer, or audit queries.

## Database safety

Migrations are ordered SQL files applied transactionally and recorded in
`schema_migrations`. The migration runner verifies the current database name
against `MIGRATION_EXPECTED_DATABASE` before changing anything. The seed script
has a separate guard and only runs against a name ending in `_seed_db` that
also exactly matches `SEED_EXPECTED_DATABASE`.

Use a separate PostgreSQL database named `wallet_test_db` for integration
tests. A new Compose database creates it on first initialization. If you use an
existing PostgreSQL instance, create it there once. `npm run migrate:test`
rewrites only the database name in the configured connection URL, verifies the
target, and applies migrations there. `npm test` performs the same database-name
guard before Jest starts. This repository does not include `.env` or credentials.

## Seed dataset

Create a fresh isolated database ending in `_seed_db`, apply migrations with
the expected database guard, and configure `SEED_EXPECTED_DATABASE` to that
same exact name. Then run `npm run seed`. The script creates 1,000 users,
2,000 wallets, and exactly 100,000 completed, balanced transfers inside one
transaction. It refuses to run when its seed markers already exist; use a
fresh seed database for another run.

## Checks and test coverage

The Jest/Supertest suite uses PostgreSQL for database behavior. Configure its
environment for `wallet_test_db`; do not use the normal `wallet_db`. After
starting the database, run `npm run migrate:test`, then `npm test`. Coverage
includes routes, transaction and ledger invariants, idempotent retries,
concurrent spending, reconciliation, scheduled jobs, and statement-question
scoping. The stampede acceptance scenario must be run 20 times for the brief's
full acceptance requirement. A single passing test run is not evidence of 20
successful repetitions.

The two-session isolation observations are in [`docs/isolation.md`](docs/isolation.md).
Schema decisions and the ER diagram are in [`docs/schema.md`](docs/schema.md).
Fraud rules and Q&A behavior are in [`docs/milestone5.md`](docs/milestone5.md).
The 10 sample statement questions and expected fixture answers are in
[`docs/milestone5.md`](docs/milestone5.md). Reconciliation findings and
benchmark notes are in [`docs/reconciliation.md`](docs/reconciliation.md).
The 5-minute video presentation steps and cURL script are in [`docs/video-demo-guide.md`](docs/video-demo-guide.md).

## Assumptions and limits

- Registration is public; all wallet operations require login.
- The configured administrator bearer token is a local project-level admin
  mechanism because the brief does not define administrator accounts or roles.
- Fraud decisions come only from configured database rules. LLM explanations
  and extracted statement intent are advisory inputs; they cannot authorize
  access, choose SQL, or move funds.
- The mock LLM is the default for local runs and tests. OpenAI mode requires an
  explicit `LLM_PROVIDER=openai` and `OPENAI_API_KEY`.
- Sharding and consistent hashing remain stretch topics, not part of this
  single-primary MVP.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests. It starts a fresh
PostgreSQL 16 service named `wallet_test_db`, applies every migration from an
empty database, and runs the complete Jest suite. The stampede test itself
repeats its 100-request concurrency scenario 20 times. CI uses the deterministic
mock LLM and an ephemeral database password; it needs no project secrets.
