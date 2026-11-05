# Database Schema and Persistence

## Supported database configurations

SQLite is the default for local use. `openDatabase()` uses `~/.agentos/agentos.sqlite` unless given a filename or data directory. It uses `better-sqlite3`, enables foreign keys, a bounded busy timeout, WAL for file databases, and explicit versioned migrations. SQLite users do not need PostgreSQL, Docker, or a server process.

PostgreSQL is an optional server backend selected explicitly with `AGENTOS_DATABASE_DRIVER=postgresql` and `AGENTOS_DATABASE_URL=postgresql://...`. `AGENTOS_DATABASE_POOL_MAX` defaults to 10 (allowed 1–100), and `AGENTOS_DATABASE_SSL` accepts `disable` or `require`. `openConfiguredDatabase()` returns the selected database and the common `RepositorySet`; callers must await its methods because SQLite is synchronous internally and PostgreSQL is asynchronous. Always call `close()` during graceful shutdown.

Local PostgreSQL example (when PostgreSQL is installed):

```powershell
$env:AGENTOS_DATABASE_DRIVER = "postgresql"
$env:AGENTOS_DATABASE_URL = "postgresql://agentos:local-password@127.0.0.1:5432/agentos"
$env:AGENTOS_DATABASE_SSL = "disable"
pnpm --filter @agentos/database test:postgres
```

For tests, `AGENTOS_POSTGRES_TEST_URL` selects a dedicated PostgreSQL test database. Tests create a random isolated schema and drop it afterwards; do not point it at a production database. When this variable is absent, the integration suite runs the PostgreSQL backend through PGlite's PostgreSQL engine and `pg` wire-protocol connector. This is useful on SQLite-only Windows machines, but it is not a substitute for testing against a PostgreSQL server release. CI pins PostgreSQL 16 and runs the same suite against that service.

## Tables and relationships

Both dialects persist projects, agents, providers, tasks, execution runs, run manifests, normalized agent events, approvals, evaluations, and per-run event counters. Repository contracts live in `@agentos/core`; repositories validate domain inputs and relationships before writes, while database constraints remain the final integrity boundary. Historical/audit relationships use `RESTRICT`. Manifests, events and evaluations are immutable through repositories; approvals have a one-way resolution method.

The PostgreSQL schema uses UUID identifiers, JSONB payloads, TIMESTAMPTZ timestamps, BOOLEAN flags, CHECK constraints, unique constraints and indexes. SQLite uses text UUIDs, validated JSON text, integer booleans, and ISO UTC timestamp text. Repository reads normalize PostgreSQL timestamps to the shared UTC `Z` string contract. The manifest/run composite foreign key is expressed in PostgreSQL migration SQL because the cyclic reference cannot be represented safely in the current Drizzle schema initializer; it is enforced by PostgreSQL and verified by integration tests.

Event append is atomic and assigns a strictly increasing run-local sequence. PostgreSQL uses an `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` counter operation inside a transaction. SQLite uses its own transaction and SQL. Pagination uses stable creation-time/identifier ordering and bounded `limit`/`offset` on both backends.

## Migrations and operational safety

SQLite migration `0001_initial_core_schema` is defined in `packages/database/src/migrations.ts`. PostgreSQL migration version 1 (`initial_core_schema`) is defined independently in `packages/database/src/postgres-migrations.ts`. Each runner records version, name, SHA-256 SQL checksum and application time; migrations execute in transactions, and checksum drift, unknown applied versions, or failed DDL stop initialization. PostgreSQL coordinates concurrent migrators with an advisory lock. There is no destructive automatic schema synchronization. Schema changes require a new forward migration in each dialect.

The SQL is intentionally dialect-specific: PostgreSQL JSONB, UUID, `TIMESTAMPTZ`, regex checks, advisory locks, `RETURNING`, and `ON CONFLICT` behavior are not treated as portable SQLite SQL. Both engines are covered independently. PostgreSQL compatibility is not considered verified until the PostgreSQL 16 GitHub Actions service job passes; local PGlite results alone do not establish server compatibility.

## Security

Provider URLs reject embedded credentials and secret query parameters. Credentials are represented only by an optional credential reference; API keys and passwords are not stored in provider records. Run manifests store the names of environment variables, never their values, and reject secret-like configuration fields. Event payloads are normalized and redacted before persistence. Database URLs and credentials must be supplied through deployment secrets and must never be logged. Limit PostgreSQL network exposure and use TLS for remote connections.
