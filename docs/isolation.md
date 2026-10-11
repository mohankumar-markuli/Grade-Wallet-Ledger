# Milestone 2: PostgreSQL isolation lab

Run this lab only against `wallet_test_db`. Do not use the development database. It creates a small schema named `milestone2_lab` and drops that schema after the experiment. The observations below were collected on 2026-10-11 using two independent PostgreSQL connections to `wallet_test_db` (PostgreSQL 16.15). The SQL procedure is included so the results can be reproduced in two `psql` sessions.

## Connect two sessions

Open two PowerShell windows. In each, connect to the PostgreSQL container with the same database user, but explicitly select `wallet_test_db`:

```powershell
docker ps --format "table {{.Names}}`t{{.Ports}}"
docker exec -it <postgres-container-name> psql -U <database-user> -d wallet_test_db
```

Replace the two placeholders with the PostgreSQL container name and database user from your local Docker setup. Do not paste or commit passwords. If you use a local `psql` installation instead, use your existing local connection settings and verify the selected database with `SELECT current_database();`.

Use **Session B** once to set up the isolated lab data:

```sql
SELECT current_database();
CREATE SCHEMA milestone2_lab;
CREATE TABLE milestone2_lab.wallets (
    wallet_id INTEGER PRIMARY KEY,
    balance_paise BIGINT NOT NULL CHECK (balance_paise >= 0)
);
CREATE TABLE milestone2_lab.wallet_labels (
    wallet_id INTEGER PRIMARY KEY
        REFERENCES milestone2_lab.wallets(wallet_id),
    label TEXT NOT NULL
);
CREATE TABLE milestone2_lab.unsafe_wallets (
    wallet_id INTEGER PRIMARY KEY,
    balance_paise BIGINT NOT NULL
);
CREATE TABLE milestone2_lab.serializable_slots (
    slot INTEGER PRIMARY KEY,
    available BOOLEAN NOT NULL
);
INSERT INTO milestone2_lab.wallets (wallet_id, balance_paise)
VALUES (1, 100000);
INSERT INTO milestone2_lab.wallet_labels (wallet_id, label)
VALUES (1, 'isolation lab wallet');
INSERT INTO milestone2_lab.unsafe_wallets (wallet_id, balance_paise)
VALUES (1, 50000);
INSERT INTO milestone2_lab.serializable_slots (slot, available)
VALUES (1, true), (2, true);
```

`SELECT current_database()` must return `wallet_test_db`. If it does not, stop and reconnect to the test database before creating anything.

## 1. Read Committed

In **Session A**:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT balance_paise FROM milestone2_lab.wallets WHERE wallet_id = 1;
```

In **Session B**:

```sql
UPDATE milestone2_lab.wallets
SET balance_paise = balance_paise + 5000
WHERE wallet_id = 1;
COMMIT;
```

Back in **Session A**, run the same read and then finish the transaction:

```sql
SELECT balance_paise FROM milestone2_lab.wallets WHERE wallet_id = 1;
COMMIT;
```

**Expected result:** Session A sees `100000` on the first read and `105000` on the second. Under Read Committed, each statement sees a snapshot taken when that statement starts.

**Observed result (2026-10-11):** first read `100000`; second read `105000`.

Reset in Session B before the next experiment:

```sql
UPDATE milestone2_lab.wallets
SET balance_paise = 100000
WHERE wallet_id = 1;
```

## 2. Repeatable Read

In **Session A**:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance_paise FROM milestone2_lab.wallets WHERE wallet_id = 1;
```

In **Session B**:

```sql
UPDATE milestone2_lab.wallets
SET balance_paise = balance_paise + 5000
WHERE wallet_id = 1;
COMMIT;
```

Back in **Session A**:

```sql
SELECT balance_paise FROM milestone2_lab.wallets WHERE wallet_id = 1;
COMMIT;
```

**Expected result:** both Session A reads should show `100000`. Repeatable Read keeps the same transaction snapshot for the transaction.

**Observed result (2026-10-11):** first read `100000`; second read `100000` while Session B's committed value was `105000`.

Reset in Session B:

```sql
UPDATE milestone2_lab.wallets
SET balance_paise = 100000
WHERE wallet_id = 1;
```

## 3. Serializable

In **Session A**:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM milestone2_lab.serializable_slots WHERE available;
```

Before Session A writes, in **Session B**:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT COUNT(*) FROM milestone2_lab.serializable_slots WHERE available;
```

Both sessions should read `2`. Each transaction now marks a different slot unavailable, based on the shared rule that at least one must remain available. This creates a write-skew conflict. In **Session A**:

```sql
UPDATE milestone2_lab.serializable_slots
SET available = false
WHERE slot = 1;
COMMIT;
```

In **Session B**:

```sql
UPDATE milestone2_lab.serializable_slots
SET available = false
WHERE slot = 2;
COMMIT;
```

PostgreSQL rejects one transaction with a serialization failure (SQLSTATE `40001`). If the transaction is left aborted, run `ROLLBACK;` in that session.

**Observed result (2026-10-11):** both sessions initially read `2`; Session A committed; Session B's `COMMIT` failed with SQLSTATE `40001`; one slot remained available. Serializable can prevent anomalies, but the application must retry transactions that fail serialization.

## 4. Repeatable Read with a join

Reset the wallet in Session B:

```sql
UPDATE milestone2_lab.wallets
SET balance_paise = 100000
WHERE wallet_id = 1;
```

In **Session A**:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT wallet.balance_paise, label.label
FROM milestone2_lab.wallets AS wallet
JOIN milestone2_lab.wallet_labels AS label
  ON label.wallet_id = wallet.wallet_id
WHERE wallet.wallet_id = 1;
```

In **Session B**:

```sql
UPDATE milestone2_lab.wallets
SET balance_paise = balance_paise + 5000
WHERE wallet_id = 1;
COMMIT;
```

Back in **Session A**, repeat the join and finish:

```sql
SELECT wallet.balance_paise, label.label
FROM milestone2_lab.wallets AS wallet
JOIN milestone2_lab.wallet_labels AS label
  ON label.wallet_id = wallet.wallet_id
WHERE wallet.wallet_id = 1;
COMMIT;
```

**Expected result:** the joined reads should both show the same wallet balance and label. Repeatable Read applies to the transaction snapshot across the joined tables too.

**Observed result (2026-10-11):** both reads returned `(100000, "isolation lab wallet")`, although Session B committed a balance of `105000` between them.

## 5. Break a transfer that checks before it locks

This experiment uses only the deliberately unprotected lab table. It does not change application code or project wallets. The row starts at `50000` paise. Each session reads the balance and independently checks in its application logic whether a `30000`-paise transfer is affordable.

In **Session A**:

```sql
BEGIN;
SELECT balance_paise FROM milestone2_lab.unsafe_wallets WHERE wallet_id = 1;
```

Before Session A updates, in **Session B**:

```sql
BEGIN;
SELECT balance_paise FROM milestone2_lab.unsafe_wallets WHERE wallet_id = 1;
```

Both reads show `50000`, so a naive application check would approve both transfers. In **Session A**, subtract 30000 and commit:

```sql
UPDATE milestone2_lab.unsafe_wallets
SET balance_paise = balance_paise - 30000
WHERE wallet_id = 1;
COMMIT;
```

Now in **Session B**, use the same update based on its earlier successful check:

```sql
UPDATE milestone2_lab.unsafe_wallets
SET balance_paise = balance_paise - 30000
WHERE wallet_id = 1;
COMMIT;
SELECT balance_paise FROM milestone2_lab.unsafe_wallets WHERE wallet_id = 1;
```

**Expected result:** the final balance is `-10000`, even though both requests had passed their earlier balance check. The lab table intentionally has no nonnegative constraint so it can show why checking before acquiring the wallet lock is unsafe. Record the output, then continue to the locked implementation discussion below.

**Observed result (2026-10-11):** both reads returned `50000`; the final balance was `-10000`.

## Cleanup

After all transactions have committed or rolled back, verify the database one more time in Session B and remove only the lab schema:

```sql
SELECT current_database();
DROP SCHEMA milestone2_lab CASCADE;
```

Only run the `DROP SCHEMA` command if the preceding query returns `wallet_test_db` and the schema is the one created by this lab.

## What the transfer implementation uses

`transferBetweenWallets` uses PostgreSQL's default **Read Committed** isolation with explicit `SELECT ... FOR UPDATE` row locks. It locks both wallet rows in ascending account ID order, then checks the locked source balance, writes the transfer and ledger entries, and updates both balances in the same transaction. This is suitable for this transfer operation because competing requests for the same wallet wait for its row lock and re-read the committed balance after the lock is granted. A failed operation rolls back its transfer, ledger, balance and idempotency-key writes together. Serializable would add serialization failures and require retry handling; it is useful where invariants span rows that are not all explicitly locked.

The stampede acceptance test is in `test/transfer.stampede.integration.test.js`. It sends 100 concurrent transfers of 1,000 paise from a 50,000-paise wallet, checks that exactly 50 complete and the balance never becomes negative, and repeats the scenario 20 times. Run it only with `DATABASE_URL` targeting `wallet_test_db`:

```powershell
if ($env:DATABASE_URL -match '/wallet_test_db$') {
    npm.cmd test -- --runInBand test/transfer.stampede.integration.test.js
} else {
    Write-Error 'Stop: DATABASE_URL must target wallet_test_db.'
}
```

**Stampede result (2026-10-11):** `test/transfer.stampede.integration.test.js` passed in the complete candidate test run. The test executes the 100-request scenario 20 times; every run had exactly 50 successes, a zero sender balance, a `50000`-paise receiver balance, nonnegative wallets, and matching debit/credit totals. The latest full run reported 19 suites passed and 71 tests passed.
