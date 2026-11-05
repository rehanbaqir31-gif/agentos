# Roadmap

| Phase | Scope                                                                                    | Status                                                                                 |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0     | Repository investigation, specifications, architecture and security decisions            | Implemented                                                                            |
| 1     | pnpm monorepo, TypeScript, lint/format/test/build conventions and CI                     | Tested locally; remote CI not run                                                      |
| 2     | Core domain, SQLite/PostgreSQL databases, migrations, repositories and durable event log | Implemented; SQLite and local PGlite tests pass; PostgreSQL 16 CI verification pending |
| 3     | Provider abstraction; Ollama and OpenAI-compatible endpoints                             | Not started                                                                            |
| 4     | Adapter SDK and first verified agent integration                                         | Not started                                                                            |
| 5     | Local execution lifecycle, policies, approvals, cancellation and recovery                | Not started                                                                            |
| 6     | Web dashboard backed by real APIs                                                        | Not started                                                                            |
| 7     | CLI                                                                                      | Not started                                                                            |
| 8     | Tauri desktop companion                                                                  | Blocked on Rust/Cargo availability                                                     |
| 9     | MCP and skills                                                                           | Not started                                                                            |
| 10    | Workflows and evaluations                                                                | Not started                                                                            |
| 11    | Quality and security hardening                                                           | Not started                                                                            |
| 12    | Public release preparation                                                               | Not started                                                                            |

Phase 3 remains not started. Do not begin it until the PostgreSQL 16 integration job has passed and Milestone 2 is marked verified.

## First MVP milestone

Complete one real agent task in an isolated test repository and verify streamed, persisted events, permission checks, cancellation, and Git diff collection. Do not start dashboard breadth or additional adapters before this vertical slice works.
