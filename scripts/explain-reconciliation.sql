-- Run only against wallet_test_db with a large test ledger.
-- EXPLAIN ANALYZE runs these SELECT statements and may use substantial I/O.

EXPLAIN (ANALYZE, BUFFERS)
SELECT
    COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'debit'), 0) AS debit_total,
    COALESCE(SUM(amount_paise) FILTER (WHERE entry_type = 'credit'), 0) AS credit_total
FROM ledger_entries;

EXPLAIN (ANALYZE, BUFFERS)
SELECT
    transfer.id,
    COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'debit'), 0) AS debit_total,
    COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'credit'), 0) AS credit_total
FROM transfers AS transfer
LEFT JOIN ledger_entries AS entry ON entry.transfer_id = transfer.id
WHERE transfer.status IN ('completed', 'reversed')
GROUP BY transfer.id
HAVING COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'debit'), 0)
    <> COALESCE(SUM(entry.amount_paise) FILTER (WHERE entry.entry_type = 'credit'), 0);

EXPLAIN (ANALYZE, BUFFERS)
SELECT
    account.id,
    account.balance_paise,
    COALESCE(SUM(
        CASE
            WHEN entry.entry_type = 'credit' THEN entry.amount_paise
            WHEN entry.entry_type = 'debit' THEN -entry.amount_paise
            ELSE 0
        END
    ), 0) AS ledger_balance
FROM accounts AS account
LEFT JOIN ledger_entries AS entry ON entry.account_id = account.id
GROUP BY account.id;

EXPLAIN (ANALYZE, BUFFERS)
SELECT transfer.id
FROM transfers AS transfer
LEFT JOIN ledger_entries AS entry ON entry.transfer_id = transfer.id
WHERE transfer.status IN ('completed', 'reversed')
GROUP BY transfer.id
HAVING COUNT(entry.id) = 0;

EXPLAIN (ANALYZE, BUFFERS)
SELECT entry.id
FROM ledger_entries AS entry
LEFT JOIN transfers AS transfer ON transfer.id = entry.transfer_id
LEFT JOIN accounts AS account ON account.id = entry.account_id
WHERE transfer.id IS NULL OR account.id IS NULL;
