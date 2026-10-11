# Architecture and operational design

## Application shape

This project is a modular monolith: one Express API, one PostgreSQL primary,
and one independently scheduled worker. Modules share a schema and process
deployment does not require a network hop between money operations.

The request path follows these responsibilities:

1. `src/routes/` declares HTTP methods, paths, and middleware.
2. `src/middleware/` handles request IDs, authentication, idempotency headers,
   and administrator access.
3. `src/controllers/` validates HTTP inputs, calls an application operation,
   and maps its result to the response contract.
4. `src/services/` contains risk decisions, reconciliation orchestration,
   statement intent validation, and other cross-repository workflows.
5. `src/repositories/` contains parameterized SQL and explicit transactions for
   wallet and transfer persistence. Money-path transaction boundaries remain
   visible in these files as required by the assignment.
6. `src/config/` owns database and runtime configuration; `src/providers/`
   contains interchangeable mock and OpenAI LLM providers.
7. `src/jobs/` schedules nightly reconciliation and risk explanations;
   `src/worker.js` runs them outside the API process.

The target architecture is intentionally a modular monolith rather than
microservices. The financial write path favors correctness over availability
when PostgreSQL is unavailable. Read replicas, sharding, and consistent hashing
are not part of this MVP.

## Transactions and isolation

Money writes use PostgreSQL `READ COMMITTED` with row locks. All accounts in a
transfer are locked in ascending ID order; balances and statuses are checked
while the locks are held; the transfer, ledger rows, stored balances, audit
event, and idempotent response commit in one transaction. Failures roll back.
Reconciliation uses `REPEATABLE READ` so all checks share one database
snapshot. `SELECT ... FOR UPDATE NOWAIT` on the `job_locks` row prevents
overlapping reconciliation runs.

An LLM call is never made while money rows are locked. Nightly explanation
calls happen after reconciliation commits. Statement Q&A calls only extract
intent; caller authorization and SQL execution stay in the application.

## Local containers

`docker-compose.yml` starts PostgreSQL, a one-shot migration service, the API,
and the scheduled worker. Health checks gate API startup on PostgreSQL
readiness, and service dependencies gate API/worker startup on successful
migrations. A named volume preserves local PostgreSQL data. The API does not
run a second scheduler in Compose.

## Environment and data protection

`.env.example` documents configuration; `.env` is local and ignored. The
migration command requires `MIGRATION_EXPECTED_DATABASE` and verifies it
against `current_database()` before applying any SQL. The dataset generator
requires a matching `SEED_EXPECTED_DATABASE` ending in `_seed_db`. Integration
tests use a separate `wallet_test_db`.

The administrator bearer token represents one administrator role because the
brief does not define admin users. Audit rows identify whether a transition
came from a user, administrator, or system actor; user actions additionally
store `actor_user_id`.
