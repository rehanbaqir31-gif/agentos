# Roadmap

| Phase | Scope                                                                                    | Status                                                                      |
| ----- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0     | Repository investigation, specifications, architecture and security decisions            | Implemented                                                                 |
| 1     | pnpm monorepo, TypeScript, lint/format/test/build conventions and CI                     | Verified locally and in GitHub Actions                                      |
| 2     | Core domain, SQLite/PostgreSQL databases, migrations, repositories and durable event log | Verified; PostgreSQL 16 integration job passed                              |
| 3     | Provider abstraction; Ollama, OpenAI-compatible, OpenAI, Anthropic and Gemini            | Verified locally and in CI (PostgreSQL 16); live provider tests unavailable |
| 4     | Adapter SDK and first verified agent integration                                         | Not started                                                                 |
| 5     | Local execution lifecycle, policies, approvals, cancellation and recovery                | Not started                                                                 |
| 6     | Web dashboard backed by real APIs                                                        | Not started                                                                 |
| 7     | CLI                                                                                      | Not started                                                                 |
| 8     | Tauri desktop companion                                                                  | Blocked on Rust/Cargo availability                                          |
| 9     | MCP and skills                                                                           | Not started                                                                 |
| 10    | Workflows and evaluations                                                                | Not started                                                                 |
| 11    | Quality and security hardening                                                           | Not started                                                                 |
| 12    | Public release preparation                                                               | Not started                                                                 |

Milestones 2 and 3 are verified. Provider implementation covers Ollama and OpenAI-compatible endpoints plus official OpenAI, Anthropic, and Gemini drivers. Local HTTP mocks and all local quality checks pass; GitHub Actions run 42045728444 passed with PostgreSQL 16. Live provider accounts and a real Ollama server were unavailable. The first agent adapter framework is next, but must remain gated on any future provider changes passing CI.

## First MVP milestone

Complete one real agent task in an isolated test repository and verify streamed, persisted events, permission checks, cancellation, and Git diff collection. Do not start dashboard breadth or additional adapters before this vertical slice works.
