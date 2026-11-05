# AgentOS

AgentOS is an open-source, local-first control plane for supervising AI coding agents. The project includes validated core domain/event contracts, durable SQLite and PostgreSQL persistence, and provider drivers for Ollama, OpenAI-compatible chat endpoints, OpenAI, Anthropic, and Google Gemini. Agent execution, adapters, APIs, and user interfaces are not implemented yet.

## Development

Requirements: Node.js 22 or newer and pnpm 11.25.0.

```bash
pnpm install
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

See [the project specification](docs/PROJECT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md), and [implementation status](docs/IMPLEMENTATION_STATUS.md). Security assumptions and current limitations are in [SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and [KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

SQLite is the default local database. PostgreSQL is an optional server database. Both use explicit versioned migrations and common repository contracts; destructive automatic schema synchronization is not used. PostgreSQL 16 integration tests are part of CI.

Provider drivers are in `@agentos/providers`. They use normalized chat, generate, streaming, model discovery, usage, and error contracts where supported. API keys are resolved from credential references at request time. See [provider integrations](docs/integrations/providers.md) and [credential security](docs/security/credentials.md). Optional live smoke tests are disabled unless explicitly enabled with `AGENTOS_PROVIDER_SMOKE=1`.

## License

Apache-2.0. See [LICENSE](LICENSE).
