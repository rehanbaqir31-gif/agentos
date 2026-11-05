# 0002: SQLite local persistence with explicit versioned migrations

- **Status:** Accepted for local persistence
- **Date:** 2026-11-05

## Context

AgentOS begins as a local-first single-user tool. Runs and events need durable persistence, while destructive automatic schema synchronization is prohibited.

## Decision

Use Drizzle ORM with `better-sqlite3` for the default local store. Define typed SQLite tables, apply ordered SQL migration modules inside `BEGIN IMMEDIATE` transactions, and record migration version, name, SHA-256 checksum, and application time. Enable foreign keys, a bounded busy timeout, and WAL for file databases. Expose database-specific behavior through repository classes. Optional PostgreSQL server mode uses a separate schema, `pg.Pool`, PostgreSQL-specific migrations, and the same repository contracts.

## Consequences

SQLite constraints and JSON validity are verified against a real SQLite engine. Migrations are explicit and fail on checksum drift. SQLite SQL, triggers, JSON behavior, timestamps, and concurrency behavior are not treated as portable. PostgreSQL has separate SQL migrations and integration tests; PostgreSQL 16 compatibility is verified in GitHub Actions. Compatibility with other server releases is not claimed until tested.

## Security

Provider secrets are represented only by a credential reference, not stored in provider rows. Schema validation rejects sensitive key names and event serialization redacts common token patterns. A real OS credential backend and comprehensive adapter output filtering remain future work.
