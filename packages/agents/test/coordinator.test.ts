import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentResult,
  AgentSession,
  NormalizedAgentEvent,
} from "../src/contracts.js";
import { adapterConfigSchema } from "../src/contracts.js";
import { ExecutionCoordinator } from "../src/coordinator.js";
import { AdapterRegistry } from "../src/registry.js";
import { openDatabase } from "@agentos/database";
import { Repositories } from "@agentos/database";
import {
  ArtifactService,
  FileSystemArtifactStorage,
  type ArtifactServiceOptions,
  type ArtifactStorageOptions,
} from "../src/index.js";

const at = "2026-11-07T12:00:00.000Z";
const baseSha = "a".repeat(40);

function makeAdapter(
  options: {
    fail?: boolean;
    events?: NormalizedAgentEvent[];
    testResults?: Record<string, unknown>;
    resultStatus?: AgentResult["status"];
  } = {},
) {
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
      return {
        status: options.resultStatus ?? "succeeded",
        summary: "done",
        changedFiles: [],
        diff: null,
        fileHashes: {},
        stdout: "stdout token=sk-abcdefghijklmnopqrstuvwxyz123456",
        stderr: "stderr warning",
        ...(options.resultStatus && options.resultStatus !== "succeeded"
          ? { terminationReason: `OpenCode ${options.resultStatus}` }
          : {}),
        ...(options.testResults ? { testResults: options.testResults } : {}),
      };
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

async function fixture(
  permissionMode: "read_only" | "supervised" = "read_only",
  artifactOptions: ArtifactServiceOptions = {},
  storageOptions: ArtifactStorageOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "agentos-coordinator-"));
  const database = await openDatabase({ filename: join(directory, "test.sqlite"), now: () => at });
  const repositories = new Repositories(database);
  const artifactStorage = await FileSystemArtifactStorage.open({
    rootDirectory: join(directory, "artifacts"),
    ...storageOptions,
  });
  const artifacts = new ArtifactService(repositories, artifactStorage, {
    now: () => at,
    ...artifactOptions,
  });
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
  return { directory, database, repositories, artifacts, project, agent, task };
}

function coordinatorFor(f: Awaited<ReturnType<typeof fixture>>, adapter: AgentAdapter) {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new ExecutionCoordinator(f.repositories, registry, f.artifacts, () => at);
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
      const outcome = await coordinatorFor(f, adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
        runId,
      });
      expect(outcome.run.status, outcome.error ?? undefined).toBe("succeeded");
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
      expect(JSON.stringify(events.items)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      const artifacts = await f.repositories.artifacts.listForProject(runId, f.project.id);
      expect(artifacts.items.map((artifact) => artifact.type).sort()).toEqual(
        [
          "git_diff",
          "stdout",
          "stderr",
          "test_results",
          "execution_manifest",
          "result_metadata",
        ].sort(),
      );
      const diffArtifact = artifacts.items.find((artifact) => artifact.type === "git_diff")!;
      expect(diffArtifact).toMatchObject({ collectionStatus: "complete", byteSize: 20 });
      expect(await f.artifacts.readForProject(runId, f.project.id, diffArtifact.id)).toEqual(
        Buffer.from("diff --git a/new.txt"),
      );
      const stdoutArtifact = artifacts.items.find((artifact) => artifact.type === "stdout")!;
      const stderrArtifact = artifacts.items.find((artifact) => artifact.type === "stderr")!;
      expect(await f.artifacts.readForProject(runId, f.project.id, stdoutArtifact.id)).toEqual(
        Buffer.from("stdout token=[REDACTED]"),
      );
      expect(await f.artifacts.readForProject(runId, f.project.id, stderrArtifact.id)).toEqual(
        Buffer.from("stderr warning"),
      );
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
      const outcome = await coordinatorFor(f, adapter).startTask({
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

  it("bounds run output and retrieves artifact metadata after database reopening", async () => {
    const f = await fixture("read_only", { maxArtifactBytes: 5, maxRunBytes: 7 });
    let reopened: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      const outcome = await coordinatorFor(f, makeAdapter().adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
      });
      expect(outcome.run.status).toBe("succeeded");
      const first = await f.repositories.artifacts.listForProject(outcome.run.id, f.project.id);
      const stored = first.items.filter((item) => item.storageLocator !== null);
      expect(stored.reduce((total, item) => total + item.byteSize, 0)).toBe(7);
      expect(stored.every((item) => item.byteSize <= 5)).toBe(true);
      expect(stored.some((item) => item.collectionStatus === "truncated")).toBe(true);

      const storedArtifact = stored[0]!;
      await expect(
        f.artifacts.readForProject(outcome.run.id, randomUUID(), storedArtifact.id),
      ).rejects.toThrow();
      f.database.close();
      reopened = await openDatabase({ filename: join(f.directory, "test.sqlite"), now: () => at });
      const reopenedRepositories = new Repositories(reopened);
      const reopenedStorage = await FileSystemArtifactStorage.open({
        rootDirectory: join(f.directory, "artifacts"),
      });
      const reopenedArtifacts = new ArtifactService(reopenedRepositories, reopenedStorage, {
        now: () => at,
      });
      const metadata = await reopenedRepositories.artifacts.getForProject(
        outcome.run.id,
        f.project.id,
        storedArtifact.id,
      );
      const bytes = await reopenedArtifacts.readForProject(
        outcome.run.id,
        f.project.id,
        storedArtifact.id,
      );
      expect(bytes.byteLength).toBe(metadata.byteSize);
      expect(metadata.collectionStatus).toBe("truncated");

      await writeFile(
        join(f.directory, "artifacts", "objects", metadata.storageLocator!),
        "tampered",
      );
      await expect(
        reopenedArtifacts.readForProject(outcome.run.id, f.project.id, storedArtifact.id),
      ).rejects.toThrow("integrity verification failed");
    } finally {
      reopened?.close();
      if (!reopened) f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("fails the run when artifact promotion fails instead of reporting false success", async () => {
    const f = await fixture(
      "read_only",
      {},
      {
        promote: async () => {
          throw new Error("promotion unavailable");
        },
      },
    );
    try {
      const outcome = await coordinatorFor(f, makeAdapter().adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
      });
      expect(outcome.run.status).toBe("failed");
      expect(outcome.error).toContain("result artifact persistence failed");
      const artifacts = await f.repositories.artifacts.listForProject(outcome.run.id, f.project.id);
      expect(
        artifacts.items.filter((item) => item.collectionStatus === "failed").length,
      ).toBeGreaterThan(0);
      expect(artifacts.items.every((item) => item.storageLocator === null)).toBe(true);
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("withholds secret-bearing structured output and fails closed", async () => {
    const f = await fixture();
    try {
      const outcome = await coordinatorFor(
        f,
        makeAdapter({ testResults: { api_key: "never persist this" } }).adapter,
      ).startTask({ taskId: f.task.id, agentId: f.agent.id });
      expect(outcome.run.status).toBe("failed");
      const artifacts = await f.repositories.artifacts.listForProject(outcome.run.id, f.project.id);
      const testResults = artifacts.items.find((item) => item.type === "test_results");
      expect(testResults).toMatchObject({
        collectionStatus: "failed",
        storageLocator: null,
        collectionError: "Artifact content failed safe serialization and was withheld",
      });
      expect(JSON.stringify(artifacts.items)).not.toContain("never persist this");
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
      const outcome = await coordinatorFor(f, adapter).startTask({
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
      const coordinator = coordinatorFor(f, adapter);
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
      const outcome = await coordinatorFor(f, adapter).startTask({
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

  it.each([
    ["timed_out", "EXECUTION_TIMED_OUT"],
    ["incomplete", "EXECUTION_INCOMPLETE"],
  ] as const)("preserves the %s outcome while failing the run", async (resultStatus, code) => {
    const f = await fixture();
    const runId = randomUUID();
    try {
      const outcome = await coordinatorFor(f, makeAdapter({ resultStatus }).adapter).startTask({
        taskId: f.task.id,
        agentId: f.agent.id,
        runId,
      });
      expect(outcome.run.status).toBe("failed");
      expect(outcome.result?.status).toBe(resultStatus);
      const events = await f.repositories.events.list({ runId, limit: 100 });
      expect(events.items.find((event) => event.type === "run.failed")?.data).toMatchObject({
        code,
      });
      const artifacts = await f.repositories.artifacts.listForProject(runId, f.project.id);
      const metadata = artifacts.items.find((artifact) => artifact.type === "result_metadata");
      expect(metadata).toBeDefined();
    } finally {
      f.database.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  it("marks persisted active runs failed after reopening and never replays them", async () => {
    const f = await fixture();
    const runId = randomUUID();
    let reopenedDatabase: Awaited<ReturnType<typeof openDatabase>> | undefined;
    let firstDatabaseClosed = false;
    try {
      let run = await f.repositories.runs.create(
        {
          taskId: f.task.id,
          projectId: f.project.id,
          agentId: f.agent.id,
          adapterVersion: "1.2.3",
          providerId: null,
          modelId: null,
          status: "created",
          manifestId: null,
          workspaceId: null,
          startedAt: null,
          completedAt: null,
          error: null,
          usageMetrics: {},
        },
        runId,
      );
      for (const status of ["validating", "preparing_workspace", "queued", "running"] as const)
        run = await f.repositories.runs.update(run.id, {
          status,
          ...(status === "running" ? { startedAt: at } : {}),
        });
      f.database.close();
      firstDatabaseClosed = true;

      reopenedDatabase = await openDatabase({
        filename: join(f.directory, "test.sqlite"),
        now: () => at,
      });
      const reopenedRepositories = new Repositories(reopenedDatabase);
      const reopenedStorage = await FileSystemArtifactStorage.open({
        rootDirectory: join(f.directory, "artifacts"),
      });
      const reopenedArtifacts = new ArtifactService(reopenedRepositories, reopenedStorage, {
        now: () => at,
      });
      const registry = new AdapterRegistry();
      registry.register(makeAdapter().adapter);
      const coordinator = new ExecutionCoordinator(
        reopenedRepositories,
        registry,
        reopenedArtifacts,
        () => at,
      );
      const recovered = await coordinator.recoverInterruptedRuns();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        id: runId,
        status: "failed",
        error: expect.stringContaining("automatic replay is disabled"),
      });
      const events = await reopenedRepositories.events.list({ runId });
      expect(events.items.at(-1)).toMatchObject({
        type: "run.failed",
        data: { code: "PROCESS_INTERRUPTED" },
      });
      expect(await coordinator.recoverInterruptedRuns()).toEqual([]);
    } finally {
      if (!firstDatabaseClosed) f.database.close();
      reopenedDatabase?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
