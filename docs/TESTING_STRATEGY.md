# Testing Strategy

Add tests alongside implemented behavior. Unit tests cover domain invariants, schemas, state transitions, permissions, and event normalization. Integration tests cover database migrations/repositories, API authorization, adapters/providers with controlled fixtures, worker lifecycle, persistence, cancellation, approvals, and Git operations. Security tests cover traversal, bypasses, leakage, project isolation, malicious input, and resource limits. E2E tests cover the real first-run vertical slice.

The current milestone includes Zod schema tests and SQLite integration tests for migration initialization/idempotence/checksum drift/rollback, relationships, duplicate IDs, repository operations, run transitions, approval resolution, transaction rollback, pagination, event ordering/redaction, concurrent connections, graceful close, and persistence after reopening. PostgreSQL behavior has not been tested.

Do not claim external integration, sandbox, performance, or platform coverage based on mocks alone. Record actual environment and results. Keep test fixtures isolated and ensure tests never execute destructive operations on the host.
