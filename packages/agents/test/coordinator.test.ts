import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentSession, NormalizedAgentEvent } from "../src/contracts.js";
import { adapterConfigSchema } from "../src/contracts.js";
import { ExecutionCoordinator } from "../src/coordinator.js";
import { AdapterRegistry } from "../src/registry.js";
import { openDatabase } from "@agentos/database";
import { Repositories } from "@agentos/database";

const at = "2026-11-07T12:00:00.000Z";
const baseSha = "a".repeat(40);

function makeAdapter(options: { fail?: boolean; events?: NormalizedAgentEvent[] } = {}) {
  const calls = { execute: 0, cancel: 0, closed: 0, permissions: [] as string[] };
  const adapter: AgentAdapter = {
    id: "test-opencode",
    validate(value) {
      return adapterConfigSchema.parse(value);
    },
    async detect() {
      return { installed: true, version: "1.2.3" };
    },
    async health() {
      return { healthy: true, version: "1.2.3" };
    },
    capabilities() {
      return {
        sessionCreate: true,
        sessionResume: true,
        streamingEvents: true,
        cancellation: true,
        isolatedExecution: true,
      };
    },
    async initializeSession(_config, runId): Promise<AgentSession> {
      return {
        id: `session-${runId}`,
        runId,
        createdAt: at,
        adapterVersion: "1.2.3",
        baseCommit: baseSha,
        workspacePath: `C:\\isolated\\${runId}`,
        runtimeConfiguration: {
          isolationMode: "docker",
          networkAccess: "disabled",
          timeoutSeconds: 60,
          memoryLimitMb: 512,
          cpuLimit: 1,
          networkAllowlist: [],
        },
      };
    },
    async resumeSession(config, sessionId, runId) {
      const created = await this.initializeSession(config, runId);
      return { ...created, id: sessionId };
    },
    async closeSession() {
      calls.closed++;
    },
    async execute(_config, _session, _instruction, signal) {
      calls.execute++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal.aborted) throw new Error("cancelled");
      if (options.fail) throw new Error("execution failed");
      return { status: "succeeded", summary: "done", changedFiles: [], diff: null, fileHashes: {} };
    },
    async *stream(_config, _session, _signal, onReady) {
      onReady();
      for (const event of options.events ?? []) yield event;
    },
    async cancel() {
      calls.cancel++;
    },
    async status() {
      return { status: "idle" };
    },
    async collectResults() {
      return {
        status: "succeeded",
        summary: "one file changed",
        changedFiles: ["new.txt"],
        diff: "diff --git a/new.txt",
        fileHashes: { "new.txt": "b".repeat(64) },
      };
    },
    async respondPermission(_config, _session, id) {
      calls.permissions.push(id);
    },
    async dispose() {},
  };
  return { adapter, calls };
}

async function fixture(permissionMode: "read_only" | "supervised" = "read_only") {
  const directory = await mkdtemp(join(tmpdir(), "agentos-coordinator-"));
  const database = await openDatabase({ filename: join(directory, "test.sqlite"), now: () => at });
  const repositories = new Repositories(database);
  const project = await repositories.projects.create({
    name: "Project",
    description: null,
    repositoryPath: join(directory, "repository"),
    repositoryUrl: null,
    defaultBranch: "main",
    currentCommit: baseSha,
    settings: { permissionMode, networkAccess: "disabled" },
  });
  const agent = await repositories.agents.create({
    name: "OpenCode",
    adapterId: "test-opencode",
    version: "1.0.0",
    capabilities: [],
    configuration: { timeoutSeconds: 60 },
    enabled: true,
    healthStatus: "healthy",
  });
  const task = await repositories.tasks.create({
    projectId: project.id,
    title: "Task",
    description: "Change one file",
    priority: "normal",
    status: "open",
    assignedAgentId: agent.id,
    configuration: {},
  });
  return { directory, database, repositories, project, agent, task };
}

function coordinatorFor(repositories: Repositories, adapter: AgentAdapter) {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new ExecutionCoordinator(repositories, registry, () => at);
}

describe("durable execution coordinator", () => {
  it("persists lifecycle, session, manifest, ordered tool/file events, and result hashes", async () => {
    const f = await fixture();
    const runId = randomUUID();
    const { adapter } = makeAdapter({
      events: [
        {
          type: "tool.started",
          sessionId: `session-${runId}`,
          at,
          tool: "read",
          callId: "call-1",
          sourceEventId: "event-1",
        },
        {
          type: "tool.started",
          sessionId: `session-${runId}`,
          at,
          tool: "read",
          callId: "call-1",
          sourceEventId: "event-1",
        },
        {
          type: "file.changed",
          sessionId: `session-${runId}`,
          at,
          path: "new.txt",
          sourceEventId: "event-2",
        },
      ],
    });
    try {
      const outcome = await coordinatorFor(f.repositories, adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
        runId,
      });
      expect(outcome.run.status).toBe("succeeded");
      expect(outcome.run.workspaceId).toBe(`C:\\isolated\\${runId}`);
      const manifest = await f.repositories.manifests.getByRunId(runId);
      expect(manifest).toMatchObject({
        repositoryCommitSha: baseSha,
        runtimeConfiguration: { isolationMode: "docker", networkAccess: "disabled" },
      });
      const events = await f.repositories.events.list({ runId, limit: 100 });
      expect(events.items.map((event) => event.type)).toContain("session.attached");
      expect(events.items.map((event) => event.type)).toContain("tool.started");
      expect(events.items.filter((event) => event.type === "tool.started")).toHaveLength(1);
      expect(events.items.map((event) => event.type)).toContain("file.changed");
      expect(events.items.map((event) => event.type)).toContain("run.result");
      expect(events.items.map((event) => event.sequence)).toEqual(
        events.items.map((event) => event.sequence).sort((a, b) => a - b),
      );
      const storedResult = events.items.find((event) => event.type === "run.result");
      expect(storedResult?.data).toMatchObject({
        files: [{ path: "new.txt", sha256: "b".repeat(64) }],
      });
      expect(JSON.stringify(events.items)).not.toContain("diff --git");
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("denies OpenCode permissions and persists the denial before replying", async () => {
    const f = await fixture();
    const runId = randomUUID();
    const { adapter, calls } = makeAdapter({
      events: [
        {
          type: "permission.requested",
          sessionId: `session-${runId}`,
          at,
          permissionId: "permission-1",
          action: "external_directory",
          resources: ["C:\\Users\\secret", "token=sk-abcdefghijklmnopqrstuvwxyz123456"],
          sourceEventId: "permission-event",
        },
      ],
    });
    try {
      const outcome = await coordinatorFor(f.repositories, adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
        runId,
      });
      expect(outcome.run.status).toBe("succeeded");
      expect(calls.permissions).toEqual(["permission-1"]);
      const approvals = await f.repositories.approvals.list(runId);
      expect(approvals.items).toHaveLength(1);
      expect(approvals.items[0]).toMatchObject({
        status: "rejected",
        resolvedBy: "agentos-policy:read_only",
      });
      expect(JSON.stringify(approvals.items)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      const events = await f.repositories.events.list({ runId });
      expect(events.items.filter((event) => event.type === "approval.requested")).toHaveLength(1);
      expect(events.items.filter((event) => event.type === "approval.rejected")).toHaveLength(1);
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("refuses supervised runs before allocating a session and records failure", async () => {
    const f = await fixture("supervised");
    const runId = randomUUID();
    const { adapter, calls } = makeAdapter();
    try {
      const outcome = await coordinatorFor(f.repositories, adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
        runId,
      });
      expect(outcome.run.status).toBe("failed");
      expect(calls.execute).toBe(0);
      expect(calls.closed).toBe(0);
      const failed = await f.repositories.events.list({ runId });
      expect(failed.items.at(-1)?.type).toBe("run.failed");
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("never reexecutes when a run ID is retried", async () => {
    const f = await fixture();
    const runId = randomUUID();
    const { adapter, calls } = makeAdapter();
    try {
      const coordinator = coordinatorFor(f.repositories, adapter);
      await coordinator.startTask({ taskId: f.task.id, agentId: f.agent.id, runId });
      await expect(
        coordinator.startTask({ taskId: f.task.id, agentId: f.agent.id, runId }),
      ).rejects.toThrow();
      expect(calls.execute).toBe(1);
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("records process failures as terminal failed runs", async () => {
    const f = await fixture();
    const { adapter } = makeAdapter({ fail: true });
    try {
      const outcome = await coordinatorFor(f.repositories, adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
      });
      expect(outcome.run.status).toBe("failed");
      expect(outcome.error).toBe("execution failed");
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
