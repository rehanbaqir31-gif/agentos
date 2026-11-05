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

The workspace foundation now includes `@agentos/core` (Zod domain/event contracts, run lifecycle and common repository contracts) and `@agentos/database` (Drizzle schemas, SQLite and PostgreSQL connectors/migrations, and matching repositories). Runtime packages should be introduced when their contracts and behavior are implemented; do not create empty placeholder integrations.

## Runtime boundaries

- **Core:** identifiers, validated domain types, run lifecycle rules, event contracts, and capability vocabulary.
- **API:** input validation, authorization boundary, pagination, structured errors, and replayable event transport.
- **Database:** migrations, repositories, constraints, and durable event storage.
- **Runtime:** local worker, workspace lifecycle, policy enforcement, timeouts, cancellation, and recovery.
- **Adapters/providers:** explicit capability declarations and documented integration contracts.
- **Clients:** consume API contracts; no direct host shell or unrestricted filesystem access from UI code.

## Execution and trust

Each run receives a unique ID, a dedicated workspace, a versioned manifest without secrets, and a durable event stream. State changes are validated and persisted. Treat prompts, adapters, MCP servers, model output, and repository contents as untrusted. A container is defense in depth, not a complete host/kernel security boundary. Network access is disabled by default where practical; resource limits and cleanup are mandatory.

## Deployment progression

1. Local single-user process and durable local database; no network listener unless explicitly configured.
2. Local API and clients with authenticated local transport.
3. Optional remote deployment only after authentication, tenant isolation, and authorization are verified.
4. Distributed workers/queues only after local recovery and event persistence are reliable.

SQLite remains the default local backend at `~/.agentos/agentos.sqlite`; it requires no server. PostgreSQL is an optional server backend selected explicitly through environment configuration. Both implement the asynchronous-compatible `RepositorySet` contracts, while each uses its own Drizzle schema, connection lifecycle, SQL migration runner and dialect-specific statements. The PostgreSQL connector uses a bounded `pg.Pool`, explicit transactions, advisory-lock migration coordination and graceful pool shutdown. SQLite's synchronous repository methods are `Awaitable`, so application code can consistently `await` both backends. No SQLite SQL is assumed to be PostgreSQL-compatible.

PostgreSQL uses UUID, JSONB, TIMESTAMPTZ, native booleans and server constraints; the shared domain uses UUID strings, JSON values and ISO UTC timestamps. PostgreSQL reads normalize timestamps to the same UTC `Z` representation. A cyclic run/manifest composite foreign key is migration-enforced and tested. The PostgreSQL integration suite can run locally on PGlite through the `pg` protocol or against an explicitly supplied PostgreSQL test URL. CI is configured with PostgreSQL 16. Local PGlite is not considered proof of compatibility with a server release; the server job must pass before PostgreSQL is marked verified.

## Technology decisions

The requested stack is the default: TypeScript, pnpm workspaces, Fastify, Zod, Drizzle, SQLite, React/Vite, and eventually Tauri 2. Phase 1 avoids premature framework choices beyond workspace tooling. Rust and Docker are currently unavailable in the environment.
