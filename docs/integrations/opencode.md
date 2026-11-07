# OpenCode adapter

AgentOS integrates with OpenCode through the official `@opencode-ai/sdk` and its documented server API. The adapter checks the CLI version using an injected process probe and checks `/global/health` for a configured server. Supported versions are OpenCode `>=1.1.1 <2.0.0`; test each SDK upgrade against the supported server before widening this range.

OpenCode owns its model-provider setup. Selecting a provider registered in AgentOS does not configure OpenCode. The adapter may select a model by OpenCode's `providerID` and `modelID` only after that provider is configured in OpenCode. Do not put credentials in adapter configuration; OpenCode's own credential store remains separate.

Execution requires an injected `IsolatedRuntime`. `DockerIsolatedRuntime` is implemented and unit-tested with a command double. It requires an operator-supplied digest-pinned image containing `opencode`, provisions a detached Git worktree, allows only `read_only`, mounts only that worktree read-only, disables network, exposes the authenticated server on host loopback, applies fixed process/memory/CPU limits, and implements cancellation/disposal. An example construction is `new DockerIsolatedRuntime({ image: process.env.AGENTOS_OPENCODE_IMAGE! })`, where the value must end with `@sha256:<64 hex characters>`.

Actual Docker isolation is unverified because Docker and OpenCode are unavailable on this machine. No real OpenCode task has been run. The networkless runtime cannot use remote model APIs; supervised/autonomous modes fail closed until AgentOS approval enforcement exists. OpenCode permission prompts are not treated as AgentOS host-level authorization. A Git worktree by itself is not a security sandbox.

The SDK event stream is normalized for session, execution, tool, and structured filesystem events. Reasoning and text-delta events are discarded. Result diff collection belongs to the AgentOS workspace manager, not OpenCode response text. Cancellation uses the documented session abort operation. Smoke tests require an OpenCode installation and credentials and are intentionally opt-in; ordinary CI uses controlled doubles.

References: [OpenCode SDK](https://opencode.ai/docs/sdk/), [OpenCode server](https://opencode.ai/docs/server/), [OpenCode permissions](https://opencode.ai/docs/permissions/).
