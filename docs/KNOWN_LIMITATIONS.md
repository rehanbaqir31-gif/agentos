# Known Limitations

- Rust/Cargo and Docker are not installed, preventing Tauri and Docker sandbox builds/verification here.
- Agent adapters, execution engine, API, UI, and CLI are not implemented. No full coding-agent runs are supported yet.
- Provider integrations support Ollama, OpenAI-compatible chat completions, OpenAI Responses, Anthropic Messages, and Google Gemini text chat/generation. Capabilities such as tool calling, structured output, image input, and embeddings are not exposed by the common request contract.
- PostgreSQL is verified against PostgreSQL 16 in CI; other PostgreSQL major versions have not been server-tested.
- Secret values are resolved from environment variables or an injected keychain backend. Native OS keychain implementations are not included, and process memory/environment remain within the host trust boundary.
- Provider smoke tests use real services only when explicitly enabled and were not run as part of ordinary local verification.
- The first adapter and sandbox controls remain to be selected and documented.
