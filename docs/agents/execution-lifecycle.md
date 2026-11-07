# Execution lifecycle

The core run lifecycle is the source of truth: `created → validating → preparing_workspace → queued → running`, with terminal `succeeded`, `failed`, or `cancelled` outcomes and `waiting_for_approval` for external decisions. Persist status transitions and normalized events using `@agentos/core` contracts and database repositories. Session identity is associated with the run; results come from the run workspace's Git state. Cancellation must be safe to repeat. A process restart should reconcile active runs against persisted adapter session state before resuming or marking them failed.

The current adapter does not yet provide durable crash reconciliation or an AgentOS-owned workspace manager. Do not report the lifecycle as end-to-end complete until those components and an isolated runtime are verified.
