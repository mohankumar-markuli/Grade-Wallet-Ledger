# Milestone 4: nightly reconciliation

## What is checked

The ledger defines an account balance as credits minus debits. All amounts and aggregates stay integer-valued in PostgreSQL; the application compares them with JavaScript BigInt.

1. Global debits equal global credits.
2. Each completed or reversed transfer has equal debit and credit totals.
3. Each stored account balance equals its ledger-derived balance.
4. No user wallet has a negative ledger-derived balance.
5. Every completed transfer has ledger rows, and every ledger row has a valid transfer and account.

Pending, held, and failed transfers are excluded from money-movement checks because they have not completed. The implementation includes those states in its transfer lifecycle and does not treat an empty ledger for them as an accounting error.

## Consistent snapshot and overlap control

The scheduler is opt-in and stays disabled unless ENABLE_RECONCILIATION_SCHEDULER=true and RECONCILIATION_EXPECTED_DATABASE are set. On startup it compares current_database() with that exact expected name before enabling the scheduler. When enabled, it schedules a run at 00:00 UTC. Every run starts a REPEATABLE READ transaction, then locks the pre-seeded nightly_reconciliation row in job_locks using SELECT FOR UPDATE NOWAIT. The row lock remains held until all checks, report rows, and completion metadata commit. If another run holds it, the caller gets HTTP 409 and no second run begins.

The checks, reconciliation_runs row, and reconciliation_problems rows commit together. On an unexpected failure the work rolls back and the runner attempts to record a failed run separately. It never updates account balances or ledger entries.

## Findings and the three-corruption acceptance case

The brief's acceptance test changes one entry amount, deletes one credit, and changes one stored balance, and expects three findings. A single altered ledger entry can also make its transfer, global totals, and one or more stored balances disagree. To meet the expected count without hiding those checks, the report groups secondary symptoms under the root transfer finding. It associates affected accounts from the transfer's source and destination IDs, so a deleted ledger side does not hide the affected account. The report still exposes each affected check and account in the finding's details. A stored-balance-only corruption on an unrelated wallet remains its own finding.

The integration test uses 10,000 otherwise balanced transfers, places the two ledger corruptions on separate transfers, and changes the balance of a third wallet. It verifies the three root findings and that no other check reports an unrelated problem. Direct ledger changes are confined to this test's fixture in wallet_test_db; the append-only and deferred balancing triggers are restored before the test continues.

The manual endpoint requires a Bearer token stored in RECONCILIATION_ADMIN_TOKEN. This is a local administrator-access assumption because the current user schema and JWTs do not define administrator roles. The endpoint also requires a UUID Idempotency-Key; a completed manual run saves its response so a retry returns the first report.

## Query-plan review

The helper refuses to proceed unless DATABASE_URL selects wallet_test_db. Seed its isolated benchmark fixture, run the query plans, and remove the fixture with these commands. Seed and cleanup change only this test database; do not interrupt the seed operation. EXPLAIN ANALYZE itself runs SELECT queries and may use significant CPU and I/O.

Expected access patterns to verify:

- Global debit/credit totals necessarily inspect every ledger entry. This is a nightly full-table scan; a separate entry_type index would add write cost and generally still require reading most of the ledger.
- Transfer totals group ledger rows by transfer_id. The ledger_entries_transfer_idx index supports grouping and joining, though PostgreSQL may choose a sequential scan for a large fraction of the table.
- Account balance recomputation groups by account_id. The existing account-leading statement index can support the join; the planner may still prefer a sequential scan when most entries are needed.
- Completed transfers with no entries use the transfer primary key and ledger_entries_transfer_idx.
- Parent/orphan checks use the ledger-entry primary key and the parent primary keys. Foreign keys already prevent ordinary orphan creation, but the check remains useful for imported or manually repaired data.

Benchmark measured on 2026-10-11 in wallet_test_db after ANALYZE. All five plans scanned the ledger_entries table because each check inspects nearly the full ledger. The executor plans reported shared-buffer hits, so these timings reflect a warm database cache and should not be treated as cold-storage latency.

    node -r dotenv/config scripts/reconciliation-benchmark.js seed
    node -r dotenv/config scripts/reconciliation-benchmark.js explain
    node -r dotenv/config scripts/reconciliation-benchmark.js cleanup

Observed benchmark database: wallet_test_db

Ledger-entry row count: 1,000,004 (1,000,000 benchmark rows plus 4 pre-existing rows)

Plan and timing notes:

- Global debit/credit totals: Parallel Seq Scan on ledger_entries; 56.331 ms; 9,346 shared buffer hits.
- Per-transfer totals: Seq Scan on ledger_entries, followed by a hash join/aggregate; 257.991 ms; 9,347 shared buffer hits.
- Account balances from ledger: Seq Scan on ledger_entries, followed by a hash join/aggregate; 255.102 ms; 9,347 shared buffer hits.
- Completed transfers without entries: Seq Scan on ledger_entries, followed by a hash join/aggregate; 224.004 ms; 9,347 shared buffer hits.
- Ledger rows with missing parents: Parallel Seq Scan on ledger_entries with hash joins; 95.699 ms; 9,506 shared buffer hits.

The cleanup command completed and removed the benchmark fixture from wallet_test_db.

## Local commands

Run the guarded test-database migration command:

    npm.cmd run migrate:test

Run the focused acceptance and route/scheduler tests:

    npm.cmd test -- --runInBand test/reconciliation.integration.test.js test/admin.reconciliation.routes.test.js test/reconciliation.scheduler.test.js

Run the full suite after the focused tests pass:

    npm.cmd test -- --runInBand

The admin secret belongs only in the local .env or process environment. Do not commit it or paste it into chat.

## Manual endpoint and scheduler configuration

Set RECONCILIATION_ADMIN_TOKEN in the local .env file to a random secret with at least 32 characters. Do not commit .env. For a manual request, set that same value in the PowerShell session that sends the request:

    $env:RECONCILIATION_ADMIN_TOKEN = '<same local token>'
    $headers = @{
        Authorization = "Bearer $env:RECONCILIATION_ADMIN_TOKEN"
        'Idempotency-Key' = [guid]::NewGuid().ToString()
    }
    Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/admin/reconciliation/run' -Headers $headers -ContentType 'application/json' -Body '{}'

The endpoint is protected by this separate admin token because the current JWT and user model do not represent administrator roles. The token value is never needed in chat.

The scheduler is disabled by default. To enable it, set ENABLE_RECONCILIATION_SCHEDULER=true and set RECONCILIATION_EXPECTED_DATABASE to the exact database name you checked. On startup the API compares that expected name with SELECT current_database(); it refuses to schedule the job if the names differ or the expected name is missing. With the scheduler enabled, the next run is at 00:00 UTC.
