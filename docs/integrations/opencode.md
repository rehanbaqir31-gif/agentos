# OpenCode adapter

AgentOS integrates with OpenCode through the official `@opencode-ai/sdk` and its documented server API. The adapter checks the CLI version using an injected process probe and checks `/global/health` for a configured server. Supported versions are OpenCode `>=1.1.1 <2.0.0`; test each SDK upgrade against the supported server before widening this range.

OpenCode owns its model-provider setup. Selecting a provider registered in AgentOS does not configure OpenCode. The adapter may select a model by OpenCode's `providerID` and `modelID` only after that provider is configured in OpenCode. Do not put credentials in adapter configuration; OpenCode's own credential store remains separate.

Execution requires an injected `IsolatedRuntime` that provisions a run-scoped sandbox and returns its workspace path and loopback server URL. Without it, session creation fails closed. A Git worktree by itself is not a security sandbox. This repository has no verified runtime implementation for Docker or another OS sandbox yet, so sandboxed execution is currently unavailable and no real OpenCode task has been run. OpenCode permission prompts are not treated as AgentOS host-level authorization.

The SDK event stream is normalized for session, execution, tool, and structured filesystem events. Reasoning and text-delta events are discarded. Result diff collection belongs to the AgentOS workspace manager, not OpenCode response text. Cancellation uses the documented session abort operation. Smoke tests require an OpenCode installation and credentials and are intentionally opt-in; ordinary CI uses controlled doubles.

References: [OpenCode SDK](https://opencode.ai/docs/sdk/), [OpenCode server](https://opencode.ai/docs/server/), [OpenCode permissions](https://opencode.ai/docs/permissions/).
