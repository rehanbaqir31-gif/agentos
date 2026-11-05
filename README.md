# AgentOS

AgentOS is an open-source, local-first control plane for supervising AI coding agents. The project includes validated core domain/event contracts and durable SQLite persistence; execution, agent/provider integrations, and user interfaces are not implemented yet.

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

The SQLite schema is versioned and migrated explicitly by `@agentos/database`; no automatic destructive schema synchronization is used. PostgreSQL support is not implemented or claimed.

## License

Apache-2.0. See [LICENSE](LICENSE).
