# Agent Adapter Contract

An adapter has a stable ID, name, version, validated configuration schema, installation detection, health check, and an explicit capability set. Its execution interface accepts a task and a scoped execution context and emits normalized events asynchronously. It must support cancellation where the underlying integration allows it and report unsupported behavior honestly.

The context exposes only the run workspace, approved capabilities, run ID, and cancellation signal. Adapters must not receive unrestricted host services. Errors are normalized without leaking credentials. Output parsing must use documented interfaces; undocumented formats are not a compatibility contract.

Capability vocabulary starts with code editing, terminal, Git, streaming, tool calling, session resume, model selection, structured output, and workspace isolation. Capability claims require adapter-specific contract tests. Select the first adapter only after reviewing its current documented runtime interface and licensing.
