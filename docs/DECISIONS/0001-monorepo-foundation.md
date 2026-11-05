# 0001: TypeScript pnpm monorepo foundation

- **Status:** Accepted for the initial implementation
- **Date:** 2026-11-05

## Context

The requested product needs shared contracts across a future API, CLI, web client, and desktop client. No repository or source implementation existed at project start.

## Decision

Use pnpm workspaces with Turborepo task orchestration and TypeScript packages. Keep shared lifecycle/domain behavior in `packages/core`. Adopt strict TypeScript, ESLint, Prettier, and Vitest at the foundation. Allow only esbuild's install build script through pnpm's explicit dependency build approval setting.

## Consequences

Workspace dependencies and scripts are reproducible from the committed lockfile. New packages inherit central TypeScript and formatting conventions. The initial package stays framework-free. CI is configured but cannot be considered remotely verified until it runs in a GitHub repository.

## Deferred decisions

Database/migrations, API framework, credential storage, first agent adapter, and sandbox implementation remain open; see `PROJECT_SPEC.md`.
