# API Specification Plan

The API will be versioned and use Zod-validated request/response schemas, consistent structured errors, bounded pagination, filters, and authorization checks at every project/run boundary. Execution events must be persisted before being emitted and support replay after reconnect (SSE is the initial candidate).

Planned resources: health, projects, agents, providers, tasks, runs, run events, approvals, workflows, evaluations, and integrations. The local service must bind to loopback by default and must not become publicly reachable through an implicit configuration. OpenAPI output will be generated from implemented schemas; this document is a plan, not an implemented API.
