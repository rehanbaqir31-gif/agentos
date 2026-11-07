# Decision 0003: trusted approval identity and policy boundary

## Context

The repository has no implemented API server, login/session middleware, authenticated request context, or trusted principal provider. `docs/API_SPEC.md` describes a future API. The existing approval `resolvedBy` was an arbitrary string and could not establish identity. A request-body user ID or arbitrary header is not an authentication source.

## Decision

- Keep `read_only` as the only executable mode. Supervised and autonomous execution remain disabled.
- Define this as **permission grant issuance**, not human approval. `grantPermission()` authorizes a grant for the currently authenticated principal's own run/action when server policy allows it. There is no separate approver identity or multi-user workflow; `approval.granted` records this policy decision. An agent cannot grant permission.
- Add `ApprovalAuthorizationService` as a server-side port. It accepts an injected `TrustedPrincipalSource`; callers cannot pass a principal ID to grant, consume, or revoke methods. Missing identity or policy denies.
- Require a versioned policy evaluation to authorize exact run/action operations. It returns authorization and version from the same immutable policy snapshot. Grants bind principal, run, action, snapshot version, expiry and resolver.
- Consume grants with one conditional database update that checks principal, resolver, run, action, evaluated policy snapshot version, expiry, revocation and unused state. Consumption and the corresponding ordered audit event are one SQLite/PostgreSQL transaction; audit failure rolls both back.
- Cancellation before policy evaluation or before transaction start prevents consumption. Cancellation observed at an in-transaction checkpoint before the transaction callback returns rolls back consumption and audit. A signal arriving after the last checkpoint may race with the database commit; if commit succeeds before cancellation is observed, the grant remains consumed and audited. Post-commit cancellation never attempts unsafe reuse.
- A policy deployment after the immutable decision snapshot is evaluated does not retroactively invalidate that in-flight decision. Later operations evaluate the new version, which cannot consume grants bound to the previous version. No second version read is claimed to eliminate a policy-change race.
- Persist grant/consume/revoke audit events without request credentials or secrets. Grant creation currently records a separate audit event and compensates with revocation if event persistence fails; atomicity in this decision applies to consumption and its audit event.
- Do not install a fake/local principal source or trust user IDs from request data. A future API must provide an authenticated principal from its own verified session boundary before this service can permit execution.

## Database change

Migration v2 adds nullable `principal_id`, `policy_version`, `expires_at`, `consumed_at`, and `revoked_at`, plus an index. Nullable fields preserve historical deny-only records. New approved grants must include a resolver matching their principal, policy version and expiry. The down migration is guarded: it refuses rollback once any approval audit field has data, so operational rollback cannot erase authorization history.

SQLite and PostgreSQL implement matching repository predicates and transactional consume-plus-event methods. No further SQL migration is needed: the new `approval.granted` event is stored in the existing JSON event payload. Concurrency and audit rollback are tested against SQLite and PGlite locally; the PostgreSQL 16 CI service validates the server dialect.

## Consequences

Permission-grant storage and the default-deny service are implemented, but no trusted principal source exists in this repository. The service is not wired into `ExecutionCoordinator`; the coordinator and Docker runtime continue to reject non-read-only modes. This decision does not implement independent human approval, authorize supervised execution, or claim authentication is implemented.
