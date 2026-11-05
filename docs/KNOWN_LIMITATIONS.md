# Known Limitations

- No source repository or Git metadata existed at initial inspection; this workspace is being bootstrapped from an empty project directory.
- Rust/Cargo and Docker are not installed, preventing Tauri and Docker sandbox builds/verification here.
- No agent/provider integration, API, UI, CLI, or execution engine exists yet.
- Database persistence is SQLite-only. PostgreSQL has no connector, schema, or integration test.
- Secret references are validated identifiers only; an OS credential-store integration has not been implemented.
- The first adapter and sandbox controls remain to be selected and documented.
