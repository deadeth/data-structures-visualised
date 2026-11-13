# Ledger design: briefs and tested schemas

The ledger design page was rewritten five times on 12 November 2026. Each pass has a brief (what the writers were told) and the schema that was run before the brief went out. Pass 5 is what the live page shows.

| Pass | Brief | Schema | Test |
|---|---|---|---|
| 1. Append-only journal with a trigger-kept balance | `ledger-spec.md` | `ledger-schema.sql` | `ledger-test.mjs` |
| 2. Multi-currency, `pending_holds`, posted and held balances | `ledger2-spec.md` | `ledger2-schema.sql` | `ledger2-test.mjs` |
| 3. `credit_limit`, debit and credit accounts in one table | `ledger3-addendum.md` | `ledger3-schema.sql` | `ledger3-test.mjs` |
| 4. Fixes from the three-reviewer fintech pass | `ledger4-fixes.md` | `ledger4-schema.sql` | `ledger4-test.mjs`, `ledger4-concurrency.py` |
| 5. Three services: Core Ledger, Card, Billing | `ledger5-brief.md` | `ledger5-schema.sql` | `ledger5-test.mjs` |

## Running them

The `.mjs` tests use PGlite (PostgreSQL 18 compiled to WebAssembly), which is not a dependency of this repo. In an empty folder outside the repo:

```
npm init -y && npm i @electric-sql/pglite
cp <repo>/docs/briefs/ledger/ledger5-* .
node ledger5-test.mjs
```

Each test reads its schema from the file beside it, so run it from the folder holding both.

`ledger4-concurrency.py` needs a real server, because PGlite has one session. It was run against PostgreSQL 16 on a socket at `/tmp/pg4`, port 54400, with a `ledger_writer` role, using `psycopg2`. It races void against expiry 200 times to show the account-first lock order does not deadlock. Change the two connection strings to your own server.

Paths in the briefs (`/home/claude/...`, `/tmp/alts/...`) are those of the session machine.
