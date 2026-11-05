# AgentOS Project Specification

## Purpose

AgentOS is an open-source, local-first control plane for supervising existing AI coding agents. It will provide a shared execution history, explicit permissions, reproducible run configuration, and web, desktop, and CLI clients over common contracts.

## Initial scope

The first useful alpha should register a local project, detect and execute one supported coding agent, stream and persist run events, support cancellation and human approvals, and present a real Git diff. Ollama and OpenAI-compatible model endpoints are the initial provider targets. The first agent integration must be validated against its documented interface before a second is started.

## Product constraints

- AgentOS supervises agents; it does not replace them.
- Local execution is the initial deployment model. Remote multi-user operation is out of scope until authentication and authorization are designed.
- No dashboard metric or integration is represented as functional until backed by real data and a working implementation.
- Secrets are referenced through protected credential storage and excluded from logs and run manifests.
- Autonomous execution is confined to an explicitly configured sandbox; it never implies unrestricted host access.

## Initial acceptance milestone

One documented adapter completes a task in an isolated test repository. The run has validated state transitions, persisted normalized events, safe cancellation, approval enforcement, and a collected Git diff. The same run is observable through a minimal CLI or API before dashboard work begins.

## Unresolved decisions

- Select the first adapter after verifying its current documented CLI/API and licensing.
- Define a PostgreSQL schema/connector and verify it against PostgreSQL before claiming server compatibility.
- Define whether the first local service is embedded in the CLI or runs as a separate API process.
- Select a secret-storage abstraction and platform-specific backends.
- Confirm the exact network and filesystem controls feasible for the first sandbox implementation.
- Confirm the public project name and repository URL before any public release.

These choices should be recorded in `docs/DECISIONS/` when resolved.
