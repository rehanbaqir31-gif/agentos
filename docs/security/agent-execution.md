# Agent execution security

Agent prompts, repository content, tool output, and model output are untrusted. Run adapters only inside an AgentOS-managed isolated runtime with a run-scoped workspace, explicit resource and network policy, no host credentials, and no Docker socket. A separate Git worktree protects developer edits from direct mutation but is not a security boundary. Never silently execute on the host if a sandbox is missing.

OpenCode permissions are an additional application-level control, not an OS sandbox. AgentOS approval decisions must be external and persisted. Network access is disabled by default where the runtime supports it. Current status: no sandbox runtime has been verified in this environment; autonomous execution is unavailable. Never claim a sandboxed run until a platform-specific isolation integration has passed tests.
