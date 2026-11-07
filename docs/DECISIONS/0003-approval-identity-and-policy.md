# Decision 0003: trusted approval identity and policy boundary

## Context

The repository has no implemented API server, login/session middleware, authenticated request context, or trusted principal provider. `docs/API_SPEC.md` describes a future API. The existing approval `resolvedBy` was an arbitrary string and could not establish identity. A request-body user ID or arbitrary header is not an authentication source.

## Decision

- Keep `read_only` as the only executable mode. Supervised and autonomous execution remain disabled.
- Add `ApprovalAuthorizationService` as a server-side port. It accepts an injected `TrustedPrincipalSource`; callers cannot pass a principal ID to issue, consume, or revoke methods. Missing identity or policy denies.
- Require a versioned policy to authorize exact run/action operations. Grants bind principal, run, action, policy version, expiry and resolver.
- Consume grants with one conditional database update that checks principal, resolver, run, action, current policy version, expiry, revocation and unused state. A grant can be consumed once. Policy version is rechecked after consumption; if it changed, authorization fails and the grant remains consumed.
- Persist approval issue/consume/revoke audit events without request credentials or secrets. If issue-event persistence fails, revoke the newly created grant before returning failure.
- Do not install a fake/local principal source or trust user IDs from request data. A future API must provide an authenticated principal from its own verified session boundary before this service can permit execution.

## Database change

Migration v2 adds nullable `principal_id`, `policy_version`, `expires_at`, `consumed_at`, and `revoked_at`, plus an index. Nullable fields preserve historical deny-only records. New approved grants must include a resolver matching their principal, policy version and expiry. The down migration is guarded: it refuses rollback once any approval audit field has data, so operational rollback cannot erase authorization history.

SQLite and PostgreSQL implement matching repository predicates. Concurrency is tested against SQLite and PGlite locally; the PostgreSQL 16 CI service validates the server dialect.

## Consequences

The approval lifecycle storage and default-deny service are implemented, but no trusted principal source exists in this repository. The service is not wired into `ExecutionCoordinator`; the coordinator and Docker runtime continue to reject non-read-only modes. This decision does not authorize supervised execution or claim authentication is implemented.
