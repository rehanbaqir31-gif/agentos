# Architecture

## Direction

Use a TypeScript pnpm monorepo. Keep domain contracts independent of provider and adapter implementations. The initial dependency direction is:

```text
clients (web / CLI / desktop) -> versioned API -> application services
                                              -> domain contracts
                                              -> persistence and event log
                                              -> execution coordinator -> adapter / provider ports
                                                                      -> workspace and policy ports
```

The workspace includes `@agentos/core` (Zod domain/event contracts, run lifecycle and common repository contracts), `@agentos/database` (Drizzle schemas and SQLite/PostgreSQL repositories), and `@agentos/providers` (validated provider drivers, normalized requests/responses, credential references and registry). Runtime packages should be introduced when their contracts and behavior are implemented; do not create empty placeholder integrations.

The `@agentos/agents` package defines the adapter contract and registry, a first OpenCode adapter using `@opencode-ai/sdk`, a detached Git worktree manager, a Docker runtime, and `ExecutionCoordinator`. The coordinator persists run lifecycle transitions, runtime/session metadata, an immutable manifest, normalized ordered events, and hashes for collected results through the existing `RepositorySet`. A stream-ready handshake prevents dispatch before event subscription. Duplicate source events are assigned deterministic IDs. Docker is code- and command-double-tested but has not run against a Docker daemon; execution only accepts read-only tasks and uses no networking. Keep provider setup distinct: an AgentOS provider record does not configure an OpenCode-owned model provider.

## Runtime boundaries

- **Core:** identifiers, validated domain types, run lifecycle rules, event contracts, and capability vocabulary.
- **API:** input validation, authorization boundary, pagination, structured errors, and replayable event transport.
- **Database:** migrations, repositories, constraints, and durable event storage.
- **Runtime:** local worker, workspace lifecycle, policy enforcement, timeouts, cancellation, and recovery.
- **Adapters/providers:** explicit capability declarations and documented integration contracts.
- **Provider package:** HTTP transports, endpoint-specific configuration and capability discovery. It does not store API key values in database records or implement agent execution.
- **Clients:** consume API contracts; no direct host shell or unrestricted filesystem access from UI code.

## Execution and trust

Each run receives a unique ID, a dedicated workspace, a versioned manifest without secrets, and a durable event stream. State changes are validated and persisted. Treat prompts, adapters, MCP servers, model output, and repository contents as untrusted. A container is defense in depth, not a complete host/kernel security boundary. Network access is disabled by default where practical; resource limits and cleanup are mandatory.

OpenCode execution is gated by an injected `IsolatedRuntime`; without it, adapter session initialization fails closed. The Docker implementation returns a per-run worktree and loopback server and applies container restrictions, but real OS isolation remains unverified until tests run against Docker. The runtime and coordinator refuse write-capable permission modes. OpenCode permission requests are stored as rejected before the adapter is told to reject them. This deny-only behavior is not generalized approval authorization: no trusted principal, expiry, revocation, or capability binding exists. Explicit single-worker startup recovery asks the runtime to remove exact run-labeled containers and validated temporary worktrees, marks active runs failed and avoids prompt replay. Real Docker cleanup is unverified; distributed leases/multi-worker recovery and resumable sessions are unsupported. Raw diffs/output artifacts are not persisted. Actual task execution is blocked by this machine's lack of Docker/OpenCode.

## Deployment progression

1. Local single-user process and durable local database; no network listener unless explicitly configured.
2. Local API and clients with authenticated local transport.
3. Optional remote deployment only after authentication, tenant isolation, and authorization are verified.
4. Distributed workers/queues only after local recovery and event persistence are reliable.

SQLite remains the default local backend at `~/.agentos/agentos.sqlite`; it requires no server. PostgreSQL is an optional server backend selected explicitly through environment configuration. Both implement the asynchronous-compatible `RepositorySet` contracts, while each uses its own Drizzle schema, connection lifecycle, SQL migration runner and dialect-specific statements. The PostgreSQL connector uses a bounded `pg.Pool`, explicit transactions, advisory-lock migration coordination and graceful pool shutdown. SQLite's synchronous repository methods are `Awaitable`, so application code can consistently `await` both backends. No SQLite SQL is assumed to be PostgreSQL-compatible.

PostgreSQL uses UUID, JSONB, TIMESTAMPTZ, native booleans and server constraints; the shared domain uses UUID strings, JSON values and ISO UTC timestamps. PostgreSQL reads normalize timestamps to the same UTC `Z` representation. A cyclic run/manifest composite foreign key is migration-enforced and tested. The PostgreSQL integration suite can run locally on PGlite through the `pg` protocol or against an explicitly supplied PostgreSQL test URL. CI is configured with PostgreSQL 16. Local PGlite is not considered proof of compatibility with a server release; the server job must pass before PostgreSQL is marked verified.

## Provider transport and credentials

`@agentos/providers` defines a shared driver contract and implements Ollama's documented REST API, configurable OpenAI-compatible chat completions, and official OpenAI Responses, Anthropic Messages, and Google Gemini SDK integrations. Drivers validate configuration and untrusted responses with Zod, apply timeouts and cancellation, normalize errors and usage, and emit text-only stream events. Capability reporting is conservative: Ollama model-specific features come from `/api/show`; OpenAI-compatible discovery/usage features are explicit configuration choices. Current adapters do not expose chain-of-thought or vendor tool-call structures.

Provider instances are persisted through the existing `ProviderRepository`. Only the credential reference and non-secret settings are stored; a reference can point to an environment variable or an OS credential backend. `EnvironmentCredentialStore` is read-only, `MemoryCredentialStore` is for tests/development, and `OsKeychainCredentialStore` delegates to a platform backend. No native Windows/macOS/Linux backend is shipped yet, so desktop code must supply one; there is no insecure plaintext fallback. The first implementation has no CLI package, so provider-management commands remain deferred until a CLI exists.

## Technology decisions

The requested stack is the default: TypeScript, pnpm workspaces, Fastify, Zod, Drizzle, SQLite, React/Vite, and eventually Tauri 2. Phase 1 avoids premature framework choices beyond workspace tooling. Rust and Docker are currently unavailable in the environment.
