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

Local single-user mode trusts the host account and operating system. Docker is defense in depth, not a complete isolation boundary; host kernel, daemon, image supply chain, and configuration remain in the trusted computing base. A container does not protect against a malicious host kernel or Docker daemon. The runtime uses a dedicated per-run Docker bridge with outbound masquerading and inter-container communication disabled, while publishing the authenticated API only on host loopback. It cannot use `--network=none` because Docker Engine does not publish the API port on that network; this was verified against Engine 29.4.2. The daemon suite passed against Docker Engine 29.4.2 (API 1.54) on Ubuntu 26.04.1 x64, including an external fetch probe that failed as expected. The bridge does not isolate the container from host-gateway services or nonstandard host routing. The current Windows environment has no Docker CLI/daemon, so local daemon verification is unavailable. Rust/Cargo is unavailable, so Tauri verification is unavailable.

SQLite is the default local database and PostgreSQL is supported for servers. PostgreSQL 16 migrations and integration tests pass in CI. Provider connections are direct outbound HTTP requests from the host process; they do not yet enforce an egress allowlist or network sandbox. Configure trusted endpoints and restrict network access at the host/firewall layer.

The OpenCode SDK adapter supports installation/version probing, loopback health checks, session creation/resume, prompt submission, event streaming, abort, and local session-handle release. It requires an injected runtime and fails closed without one. Docker container settings and lifecycle have been verified against a real GitHub-hosted daemon using a disposable protocol shim, but no production OpenCode image or live task has been verified. `ApprovalAuthorizationService` creates policy-authorized permission grants for the currently authenticated principal; it does not implement independent human approval. Grant consumption and its audit event commit in one database transaction. The policy decision supplies an immutable versioned snapshot; a policy change after snapshot evaluation does not retroactively cancel an in-flight decision. No implementation of `TrustedPrincipalSource`, API authentication, or request authorization exists, so its missing identity path denies and the coordinator continues to permit only read-only runs. OpenCode's `DELETE session` endpoint is intentionally not used because it destroys durable session history.

## Verification plan

The Docker profile uses a digest-pinned image, UID/GID `10001:10001`, read-only root and workspace mounts, no privileged mode, all capabilities dropped, `no-new-privileges`, a 128 PID limit, 2 GiB memory, 2 CPUs, and a 256 MiB `/tmp` tmpfs. It passes only `HOME` and a random in-memory OpenCode server password into the container. The Docker CLI child receives a filtered host environment containing Docker connection settings and OS-required variables; provider credentials and unrelated host environment values are not inherited. `DOCKER_HOST` and Docker credentials remain security-sensitive host inputs. The server password is present in container configuration for its lifetime and is visible to Docker administrators.

A per-run network and container both carry managed/run/generation labels. Recovery filters by run and prior generation before removing containers and networks, so a newer generation is not targeted by that cleanup query. Lease expiry is a failure detector, however, and cannot itself stop an isolated old worker if Docker is unreachable. The process must fail closed when lease ownership is lost; daemon cleanup remains best effort until the Docker API responds. The bridge can still reach host gateway services; restrict sensitive host listeners and enforce host firewall policy.

The dedicated integration suite uses a disposable protocol shim, not OpenCode. It checks actual Docker inspection values, a denied workspace write, denied reads of a host-only canary and another run's workspace, missing socket, external fetch failure, loopback health, real process stop, and stale-generation cleanup while preserving the newer generation. GitHub Actions run [42378655753](https://github.com/rehanbaqir31-gif/agentos/actions/runs/42378655753) passed on Docker Engine 29.4.2. The current Windows machine has no Docker executable, so no local daemon result exists. The suite verifies configured CPU, memory and PID limits but does not attempt exhaustion attacks. It does not establish resistance to kernel/daemon compromise, image supply-chain attacks, side channels, host resource contention, host-gateway access, arbitrary host-file reads beyond the canary, or every supported OS/filesystem combination. Do not describe Docker as a complete security boundary. Live OpenCode compatibility and a harmless agent task remain unverified; remote model access is unavailable under this network policy. `read_only` remains the only enabled mode.

## M4.6 OpenCode image and output boundary

The adapter lockfile resolves `@opencode-ai/sdk@1.19.5`. Upstream publishes a corresponding official `ghcr.io/anomalyco/opencode:1.19.5` package with manifest digest `sha256:f4cfe16d91efbbfca01a51c44094fba4cf82e15c7fa17de5f11f9059699b1e6e`; this is a candidate image reference, not an AgentOS-verified image. See the [upstream package](https://github.com/anomalyco/opencode/pkgs/container/opencode/versions?filters%5Bversion_type%5D=tagged) and [release](https://github.com/anomalyco/opencode/releases/tag/v1.19.5).

No live image execution has been performed. The current runtime does not pass provider credentials or mount OpenCode provider configuration, and its bridge denies ordinary outbound routing. Therefore, a real model task is not available through the current profile unless an explicitly reviewed credential and local-provider path is implemented. Do not bake credentials into the image, forward host environment variables, enable internet egress, or claim live compatibility based on the protocol shim.

The SDK prompt response exposes assistant text parts. AgentOS may persist the final text parts after secret redaction, while filtering reasoning, synthetic and ignored parts. OpenCode process stdout/stderr and structured test output are not provided by this adapter/runtime and remain unavailable. No reasoning text is captured. Cancellation, provider failure, event-stream interruption and cleanup against the real image remain unverified.
