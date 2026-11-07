# Security Model

## Assets and trust boundaries

Assets include source code, credentials, local files, execution history, provider usage, and approval decisions. Treat tasks/prompts, repository content, model output, adapters, MCP servers, and tool output as untrusted. Trust boundaries exist between clients and API, coordinator and worker, worker and host, adapter and provider, and each project/run workspace.

Worker ownership is represented by a durable run lease and monotonic fencing generation. Claim/renew/release operations require matching worker and generation; recovery acts only after claiming an expired/released lease and cleans resources labeled with the prior generation. Prompts are never automatically replayed and existing artifacts are retained. Lease timeout is not proof of process death, so writes must fail closed after fencing. PostgreSQL 16 CI is required to verify server row-lock behavior; PGlite is a local development aid only.

## Threats

Threats include prompt injection, path traversal, unauthorized shell/network access, secret exfiltration, malicious integrations, cross-project access, resource exhaustion, unsafe cleanup, and local service exposure.

## Required controls

- Bind local services to loopback by default; remote mode requires authentication and authorization.
- Scope all file access to a run workspace and reject traversal after canonical path resolution.
- Use least privilege, non-root sandbox execution where supported, bounded resources/timeouts, and no Docker socket inside agent containers.
- Network access is denied by default when practical; allowlists are explicit.
- Sensitive actions require a server-authorized permission grant bound to the authenticated principal, run, exact action and policy snapshot version. A policy-issued grant for its authenticated principal is not independent human approval; an agent cannot authorize itself. If no trusted principal source exists, deny.
- Keep secrets out of logs, ordinary database rows, command arguments where avoidable, and manifests. Mask captured output.
- Domain schemas reject secret-named configuration fields and provider URLs containing embedded credentials; event serialization masks common token patterns. These checks are defense in depth and do not replace an OS-backed credential store or adapter output review.
- Provider credentials are stored by reference. Environment references are resolved at request time and are read-only. OS credential operations require an injected keychain backend; no plaintext database or file fallback exists. The native platform backend is not yet implemented.
- Provider URLs reject embedded credentials and permit plaintext HTTP only on loopback; remote endpoints must use HTTPS. This does not provide a general egress allowlist, DNS-rebinding defense, or network sandbox.
- Provider errors are normalized without forwarding provider response bodies, request URLs, or credentials. Custom HTTP headers reject authentication/secret header names and secret-like values; authentication headers use a credential reference.
- Persist run/event state and validate transitions; cancellation and cleanup must be safe and idempotent.
- Validate adapter and provider configuration at boundaries; declare only verified capabilities.
- OpenCode's application permission prompts are not an OS security boundary. An AgentOS-managed isolated runtime must enforce filesystem, process, network, and resource boundaries before any task runs. Without that runtime, fail closed; a Git worktree alone is not isolation.

## Assumptions and limitations

Local single-user mode trusts the host account and operating system. Docker is defense in depth, not a complete isolation boundary; host kernel, daemon, image supply chain, and configuration remain in the trusted computing base. Sandbox guarantees must be documented per supported platform before autonomous execution is offered. The current environment has no Docker or Rust/Cargo, so container and Tauri verification are unavailable.

SQLite is the default local database and PostgreSQL is supported for servers. PostgreSQL 16 migrations and integration tests pass in CI. Provider connections are direct outbound HTTP requests from the host process; they do not yet enforce an egress allowlist or network sandbox. Configure trusted endpoints and restrict network access at the host/firewall layer.

The OpenCode SDK adapter supports installation/version probing, loopback health checks, session creation/resume, prompt submission, event streaming, abort, and local session-handle release. It requires an injected runtime and fails closed without one. A Docker runtime and durable coordinator exist, but their behavior has not been verified against a real Docker daemon or live OpenCode task. `ApprovalAuthorizationService` creates policy-authorized permission grants for the currently authenticated principal; it does not implement independent human approval. Grant consumption and its audit event commit in one database transaction. The policy decision supplies an immutable versioned snapshot; a policy change after snapshot evaluation does not retroactively cancel an in-flight decision. No implementation of `TrustedPrincipalSource`, API authentication, or request authorization exists, so its missing identity path denies and the coordinator continues to permit only read-only runs. OpenCode's `DELETE session` endpoint is intentionally not used because it destroys durable session history.

## Verification plan

Before enabling execution, add tests for traversal, permission bypass, secret leakage, cross-project access, cancellation, resource limits, and sandbox lifecycle. Security claims must match the actual tested platform and configuration.
