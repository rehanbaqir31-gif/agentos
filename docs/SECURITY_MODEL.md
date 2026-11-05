# Security Model

## Assets and trust boundaries

Assets include source code, credentials, local files, execution history, provider usage, and approval decisions. Treat tasks/prompts, repository content, model output, adapters, MCP servers, and tool output as untrusted. Trust boundaries exist between clients and API, coordinator and worker, worker and host, adapter and provider, and each project/run workspace.

## Threats

Threats include prompt injection, path traversal, unauthorized shell/network access, secret exfiltration, malicious integrations, cross-project access, resource exhaustion, unsafe cleanup, and local service exposure.

## Required controls

- Bind local services to loopback by default; remote mode requires authentication and authorization.
- Scope all file access to a run workspace and reject traversal after canonical path resolution.
- Use least privilege, non-root sandbox execution where supported, bounded resources/timeouts, and no Docker socket inside agent containers.
- Network access is denied by default when practical; allowlists are explicit.
- Sensitive actions require an external approval decision recorded against the run; an agent cannot approve itself.
- Keep secrets out of logs, ordinary database rows, command arguments where avoidable, and manifests. Mask captured output.
- Domain schemas reject secret-named configuration fields and provider URLs containing embedded credentials; event serialization masks common token patterns. These checks are defense in depth and do not replace an OS-backed credential store or adapter output review.
- Persist run/event state and validate transitions; cancellation and cleanup must be safe and idempotent.
- Validate adapter and provider configuration at boundaries; declare only verified capabilities.

## Assumptions and limitations

Local single-user mode trusts the host account and operating system. Docker is defense in depth, not a complete isolation boundary; host kernel, daemon, image supply chain, and configuration remain in the trusted computing base. Sandbox guarantees must be documented per supported platform before autonomous execution is offered. The current environment has no Docker or Rust/Cargo, so container and Tauri verification are unavailable.

SQLite is the only implemented database. PostgreSQL schema, transport and authorization behavior remain unimplemented and unverified.

## Verification plan

Before enabling execution, add tests for traversal, permission bypass, secret leakage, cross-project access, cancellation, resource limits, and sandbox lifecycle. Security claims must match the actual tested platform and configuration.
