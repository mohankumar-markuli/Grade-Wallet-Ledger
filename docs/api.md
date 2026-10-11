# HTTP API contract

All amounts are integer paise. Every `POST`, including login, requires an
RFC 4122 UUID in the `Idempotency-Key` header. Money-changing endpoints store
the key and request hash. Matching retries replay the first status and body;
reusing a key with a different request body returns `422`.

All error responses use `{ "code", "message", "request_id" }`. The request ID
is also returned in the `X-Request-Id` response header. Wallet and statement
access is scoped to the authenticated user's accounts. Administrator routes
require the configured reconciliation administrator bearer token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Service health |
| `POST` | `/auth/login` | Authenticate and return a bearer token |
| `POST` | `/users` | Create a user with name, email, phone, and password; KYC starts as pending |
| `POST` | `/wallets` | Open a named wallet for the authenticated user |
| `POST` | `/users/{id}/wallets` | Open a named wallet for the authenticated user |
| `GET` | `/wallets/{id}/balance` | Read wallet balance |
| `GET` | `/wallets/{id}/statement` | Read newest-first paginated ledger entries |
| `POST` | `/wallets/{id}/top-up` | Top up the identified wallet (blueprint route) |
| `POST` | `/wallets/{id}/transfer` | Transfer from the identified wallet to `toWalletId` |
| `POST` | `/transfers/topup` | Top up a wallet from cash-in account |
| `POST` | `/transfers` | Transfer between wallets |
| `POST` | `/transfers/withdraw` | Withdraw to cash-out account |
| `POST` | `/transfers/{id}/reverse` | Create a reversal transfer |
| `GET` | `/transfers/{id}` | Read transfer, ledger entries, and status history |
| `POST` | `/admin/reconciliation/run` | Run reconciliation (`202` when a report completes) |
| `GET` | `/admin/reconciliation/runs/{id}` | Read reconciliation report |
| `GET` | `/admin/risk/queue` | List held and flagged transfers |
| `POST` | `/admin/risk/{transfer_id}/decision` | Release or reject a held transfer |
| `POST` | `/users/{id}/statement/ask` | Ask a supported question about own statement |

For `POST /transfers`, the body contains `fromWalletId`, `toWalletId`,
`amountPaise`, and an optional `description`. For `POST /wallets/{id}/transfer`,
the source wallet comes from the path and the body contains `toWalletId` and
`amountPaise`. `POST /transfers/topup` and `POST /wallets/{id}/top-up` perform
the same top-up operation; the former is the Brief route and the latter keeps
the blueprint route. Top-up and withdrawal requests contain `walletId` and
`amountPaise` when it is not supplied in the path. The authenticated user
identity comes from the bearer token, never from a caller-supplied user ID.
Wallet creation accepts an optional `name` (1 to 120 characters); it defaults
to `Wallet` when omitted.

Statements use stable ordering: `created_at DESC, id DESC`, with `limit` and
`offset` parameters. The supported statement questions are total sent to a
person, total received from a person, largest transfer, and transfer count in a
date range. The application builds parameterized SQL; the LLM only extracts
structured intent and cannot authorize or query data.
