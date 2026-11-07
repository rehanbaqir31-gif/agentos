# Decision 0004: durable run leases and crash recovery

## Context

Startup recovery previously treated every nonterminal run as abandoned. With multiple AgentOS processes, that could terminate live work, and a stale worker could keep writing after another worker took over. Docker resource cleanup used only run identity and could remove resources created by a newer attempt.

## Decision

- Persist one lease row per execution run, with worker ID, run ID, monotonically increasing generation, claim/heartbeat/expiry times and release time.
- Create generation 1 in the same database transaction as its run. SQLite uses an immediate transaction; PostgreSQL locks the existing parent run row before claiming so concurrent claimants serialize.
- A claim succeeds only when no lease exists, it is released, or it has expired. Takeover increments generation. Renewal requires matching worker and generation and a live lease; release requires matching worker and generation.
- Carry the lease identity through coordinator lifecycle, event, manifest, artifact and approval writes. Heartbeat failure aborts the local execution signal. Recovery claims a lease before cleanup/state change and emits `run.recovered` plus `PROCESS_INTERRUPTED` without prompt replay.
- Label Docker resources with run ID and lease generation. Recovery filters to the previous generation, preserving resources from a newer owner.
- Artifact object keys are deterministic from a hash of run ID, artifact type and logical name. Promotion never overwrites content; an existing object is accepted only when byte count and digest match. A promoted object without metadata is reconciled as an orphan after a grace period. Expired metadata deletion defers physical object removal through that grace period to reduce races with reads.
- A lease is a concurrency/fencing mechanism, not proof of worker death. A process that loses ownership must stop side effects when its renewal or next guarded write fails. Prompts are never automatically replayed; recovered nonterminal work becomes failed.

## Verification boundary

SQLite and local PGlite tests exercise repository behavior. Only the PostgreSQL 16 GitHub Actions service can verify PostgreSQL row-lock serialization. Real multi-process recovery and Docker daemon cleanup remain separate verification requirements; command doubles do not establish either behavior. `read_only` remains the only enabled execution mode. No Phase 5 work is authorized by this decision.
