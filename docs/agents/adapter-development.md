# Agent adapter development

Implement `AgentAdapter` in `@agentos/agents`; do not add agent-specific code to core. Validate external configuration with Zod, report only verified capabilities, use supported SDK/API surfaces, and normalize only structured events that the adapter receives. Keep prompts and model reasoning out of logs and event storage. Never put secrets in command arguments, configuration, manifests, or ordinary events.

Execution must receive an `IsolatedRuntime` and fail closed if none is available. OpenCode's own permission setting and a Git worktree do not isolate host filesystem, processes, or network. Adapter tests should inject process probes and SDK clients. Live smoke checks must be opt-in.
