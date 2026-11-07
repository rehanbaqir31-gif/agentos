import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentOsDatabase } from "../src/database.js";
import { applyMigrations, openDatabase, rollbackLastMigration } from "../src/database.js";
import {
  Repositories,
  RelationshipValidationError,
  RepositoryConflictError,
  RepositoryNotFoundError,
} from "../src/repositories.js";
import { migrations } from "../src/migrations.js";
import BetterSqlite3 from "better-sqlite3";
import { projects } from "../src/schema.js";

const fixedTime = "2026-11-05T12:00:00.000Z";
let database: AgentOsDatabase;
let repositories: Repositories;
let tempDir: string;

async function createFixture() {
  const project = await repositories.projects.create({
    name: "Fixture",
    description: null,
    repositoryPath: `/fixtures/${randomUUID()}`,
    repositoryUrl: null,
    defaultBranch: "main",
    currentCommit: null,
    settings: { permissionMode: "supervised", networkAccess: "disabled" },
  });
  const agent = await repositories.agents.create({
    name: "Local agent",
    adapterId: "test-adapter",
    version: "1.0.0",
    capabilities: ["streaming", "code-editing"],
    configuration: {},
    enabled: true,
    healthStatus: "healthy",
  });
  const provider = await repositories.providers.create({
    name: "Local models",
    providerType: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    credentialRef: null,
    availableModels: ["qwen"],
    configuration: {},
    enabled: true,
  });
  const task = await repositories.tasks.create({
    projectId: project.id,
    title: "Fixture task",
    description: "Test persistence",
    priority: "normal",
    status: "open",
    assignedAgentId: agent.id,
    configuration: {},
  });
  const run = await repositories.runs.create({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    adapterVersion: "1.0.0",
    providerId: provider.id,
    modelId: "qwen",
    status: "created",
    manifestId: null,
    workspaceId: "workspace-test",
    startedAt: null,
    completedAt: null,
    error: null,
    usageMetrics: {},
  });
  return { project, agent, provider, task, run };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agentos-db-test-"));
  database = await openDatabase({
    filename: join(tempDir, "agentos.sqlite"),
    now: () => fixedTime,
  });
  repositories = new Repositories(database);
});

afterEach(async () => {
  database.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("SQLite database and repositories", () => {
  it("initializes versioned schema and applies migrations only once", () => {
    expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: 2,
    });
    applyMigrations(database.sqlite, migrations);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: 2,
    });
    expect(() =>
      applyMigrations(database.sqlite, [
        { ...migrations[0]!, sql: `${migrations[0]!.sql}\n-- changed` },
      ]),
    ).toThrow("has changed");
  });

  it("rolls back the additive approval migration only when no approval audit fields are populated", async () => {
    expect(rollbackLastMigration(database.sqlite)).toBe(2);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: 1,
    });
    applyMigrations(database.sqlite, migrations);
    const fixture = await createFixture();
    repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "workspace.write",
      actionDescription: "Permit writes",
      requestedPermissions: ["file.write"],
      status: "approved",
      requestedAt: fixedTime,
      resolvedAt: fixedTime,
      resolvedBy: "local-user",
      principalId: "local-user",
      policyVersion: "policy-v1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    expect(() => rollbackLastMigration(database.sqlite)).toThrow(/discard approval audit state/);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: 2,
    });
  });

  it("uses an isolated data directory when no filename is provided", async () => {
    const local = await openDatabase({ dataDirectory: tempDir, now: () => fixedTime });
    expect(local.filename).toBe(join(tempDir, "agentos.sqlite"));
    local.close();
    await expect(openDatabase({ filename: ":memory:", dataDirectory: tempDir })).rejects.toThrow(
      "either filename or dataDirectory",
    );
  });

  it("rolls a failed migration back without leaving partial DDL", () => {
    const raw = new BetterSqlite3(":memory:");
    raw.pragma("foreign_keys = ON");
    expect(() =>
      applyMigrations(raw, [
        { version: 1, name: "broken", sql: "CREATE TABLE partial_table(id TEXT); INVALID SQL;" },
      ]),
    ).toThrow();
    expect(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_table'")
        .get(),
    ).toBeUndefined();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 0 });
    raw.close();
  });

  it("creates and retrieves all primary entities with persisted relationships", async () => {
    const fixture = await createFixture();
    const manifest = repositories.manifests.create({
      version: 1,
      runId: fixture.run.id,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      adapterId: fixture.agent.adapterId,
      adapterVersion: fixture.agent.version,
      providerId: fixture.provider.id,
      modelId: fixture.run.modelId,
      promptConfigurationHash: "b".repeat(64),
      repositoryCommitSha: null,
      toolVersions: { node: "24" },
      skillVersions: {},
      runtimeConfiguration: { timeoutSeconds: 60 },
      permissionConfiguration: fixture.project.settings,
      environmentVariableNames: ["OPENAI_API_KEY"],
    });
    const event = repositories.events.append({
      runId: fixture.run.id,
      type: "run.created",
      occurredAt: fixedTime,
      data: { taskId: fixture.task.id },
    });
    const approval = repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "network_access",
      actionDescription: "Request a configured endpoint",
      requestedPermissions: ["network:api.example.test"],
      status: "pending",
      requestedAt: fixedTime,
      resolvedAt: null,
      resolvedBy: null,
    });
    const evaluation = repositories.evaluations.create({
      runId: fixture.run.id,
      evaluatorVersion: "1.0.0",
      criteria: { correctness: "unit tests" },
      scores: { correctness: 0.9 },
      testResults: { passed: true },
      summary: "Checks passed",
    });

    expect(repositories.projects.getById(fixture.project.id)).toEqual(fixture.project);
    expect(repositories.agents.getById(fixture.agent.id)).toEqual(fixture.agent);
    expect(repositories.providers.getById(fixture.provider.id)).toEqual(fixture.provider);
    expect(repositories.tasks.getById(fixture.task.id)).toEqual(fixture.task);
    expect(repositories.runs.getById(fixture.run.id).manifestId).toBe(manifest.id);
    expect(repositories.manifests.getByRunId(fixture.run.id).id).toBe(manifest.id);
    expect(() => repositories.runs.update(fixture.run.id, { modelId: "different-model" })).toThrow(
      RelationshipValidationError,
    );
    expect(repositories.events.list({ runId: fixture.run.id }).items).toEqual([event]);
    expect(repositories.approvals.getById(approval.id)).toEqual(approval);
    expect(repositories.evaluations.getById(evaluation.id)).toEqual(evaluation);
  });

  it("validates project/run relationships, duplicate IDs, and restricts referenced deletes", async () => {
    const fixture = await createFixture();
    await expect(
      repositories.tasks.create({
        projectId: randomUUID(),
        title: "Bad",
        description: "Bad relation",
        priority: "low",
        status: "open",
        assignedAgentId: null,
        configuration: {},
      }),
    ).rejects.toBeInstanceOf(RelationshipValidationError);
    await expect(
      repositories.projects.create({
        name: "Duplicate",
        description: null,
        repositoryPath: fixture.project.repositoryPath,
        repositoryUrl: null,
        defaultBranch: null,
        currentCommit: null,
        settings: fixture.project.settings,
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(
      repositories.agents.create(
        {
          name: "Duplicate ID",
          adapterId: "other",
          version: "1.0.0",
          capabilities: [],
          configuration: {},
          enabled: true,
          healthStatus: "unknown",
        },
        fixture.agent.id,
      ),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(
      repositories.runs.create({
        taskId: fixture.task.id,
        projectId: randomUUID(),
        agentId: fixture.agent.id,
        adapterVersion: "1.0.0",
        providerId: null,
        modelId: null,
        status: "created",
        manifestId: null,
        workspaceId: null,
        startedAt: null,
        completedAt: null,
        error: null,
        usageMetrics: {},
      }),
    ).rejects.toBeInstanceOf(RelationshipValidationError);
    expect(() => repositories.projects.delete(fixture.project.id)).toThrow(RepositoryConflictError);
    expect(() => repositories.projects.getById(randomUUID())).toThrow(RepositoryNotFoundError);
  });

  it("enforces run transitions and approval resolution invariants", async () => {
    const fixture = await createFixture();
    expect(() => repositories.runs.update(fixture.run.id, { status: "succeeded" })).toThrow(
      "Cannot transition",
    );
    const approval = repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "install",
      actionDescription: "Install package",
      requestedPermissions: ["install"],
      status: "pending",
      requestedAt: fixedTime,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(() => repositories.approvals.resolve(approval.id, "approved", "human:operator")).toThrow(
      /trusted server-side policy service/,
    );
    expect(repositories.approvals.resolve(approval.id, "rejected", "human:operator").status).toBe(
      "rejected",
    );
    expect(() => repositories.approvals.resolve(approval.id, "rejected", "human:operator")).toThrow(
      RepositoryConflictError,
    );
  });

  it("binds approval consumption to principal, run, action, policy, expiry and one-time use", async () => {
    const fixture = await createFixture();
    const principalId = "local-user-1";
    const approval = repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "workspace.write",
      actionDescription: "Permit writes to this run workspace",
      requestedPermissions: ["file.write"],
      status: "approved",
      requestedAt: fixedTime,
      resolvedAt: fixedTime,
      resolvedBy: principalId,
      principalId,
      policyVersion: "policy-v1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    const consumeInput = {
      id: approval.id,
      runId: fixture.run.id,
      principalId,
      actionType: "workspace.write",
      policyVersion: "policy-v1",
      at: fixedTime,
    };
    const consume = (input: typeof consumeInput) =>
      repositories.approvals.consumeWithEvent(input, {
        runId: fixture.run.id,
        type: "approval.consumed",
        occurredAt: fixedTime,
        data: {
          approvalId: approval.id,
          principalId: input.principalId,
          policyVersion: input.policyVersion,
          actionType: input.actionType,
        },
      });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => consume(consumeInput)),
      Promise.resolve().then(() => consume(consumeInput)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(repositories.approvals.getById(approval.id).consumedAt).toBe(fixedTime);
    expect(() => consume({ ...consumeInput, principalId: "another-user" })).toThrow(
      RepositoryConflictError,
    );
    expect(() => consume({ ...consumeInput, actionType: "network.access" })).toThrow(
      RepositoryConflictError,
    );
  });

  it("rolls approval consumption back if inserting its audit event fails", async () => {
    const fixture = await createFixture();
    const approval = repositories.approvals.create(
      {
        runId: fixture.run.id,
        actionType: "workspace.write",
        actionDescription: "Permit writes",
        requestedPermissions: ["file.write"],
        status: "approved",
        requestedAt: fixedTime,
        resolvedAt: fixedTime,
        resolvedBy: "local-user-1",
        principalId: "local-user-1",
        policyVersion: "policy-v1",
        expiresAt: "2026-11-05T13:00:00.000Z",
      },
      randomUUID(),
    );
    database.sqlite.exec(`
      CREATE TRIGGER reject_consumption_audit
      BEFORE INSERT ON agent_events
      WHEN NEW.type = 'approval.consumed'
      BEGIN SELECT RAISE(ABORT, 'audit storage unavailable'); END;
    `);
    expect(() =>
      repositories.approvals.consumeWithEvent(
        {
          id: approval.id,
          runId: fixture.run.id,
          principalId: "local-user-1",
          actionType: "workspace.write",
          policyVersion: "policy-v1",
          at: fixedTime,
        },
        {
          runId: fixture.run.id,
          type: "approval.consumed",
          occurredAt: fixedTime,
          data: {
            approvalId: approval.id,
            principalId: "local-user-1",
            policyVersion: "policy-v1",
            actionType: "workspace.write",
          },
        },
      ),
    ).toThrow();
    expect(repositories.approvals.getById(approval.id).consumedAt).toBeNull();
    expect(
      repositories.events
        .list({ runId: fixture.run.id })
        .items.filter((event) => event.type === "approval.consumed"),
    ).toHaveLength(0);
  });

  it("rejects expired and revoked approval consumption", async () => {
    const fixture = await createFixture();
    const createGrant = (expiresAt: string) =>
      repositories.approvals.create({
        runId: fixture.run.id,
        actionType: "workspace.write",
        actionDescription: "Permit writes",
        requestedPermissions: ["file.write"],
        status: "approved",
        requestedAt: fixedTime,
        resolvedAt: fixedTime,
        resolvedBy: "local-user-1",
        principalId: "local-user-1",
        policyVersion: "policy-v1",
        expiresAt,
      });
    const expired = createGrant("2026-11-05T11:59:59.000Z");
    const revoked = createGrant("2026-11-05T13:00:00.000Z");
    repositories.approvals.revoke(revoked.id, "local-user-1", fixedTime);
    const consume = (id: string) =>
      repositories.approvals.consumeWithEvent(
        {
          id,
          runId: fixture.run.id,
          principalId: "local-user-1",
          actionType: "workspace.write",
          policyVersion: "policy-v1",
          at: fixedTime,
        },
        {
          runId: fixture.run.id,
          type: "approval.consumed",
          occurredAt: fixedTime,
          data: {
            approvalId: id,
            principalId: "local-user-1",
            policyVersion: "policy-v1",
            actionType: "workspace.write",
          },
        },
      );
    expect(() => consume(expired.id)).toThrow(RepositoryConflictError);
    expect(() => consume(revoked.id)).toThrow(RepositoryConflictError);
  });

  it("rolls back a transaction and paginates deterministically", async () => {
    const initial = await createFixture();
    const rollbackId = randomUUID();
    expect(() =>
      database.orm.transaction((tx) => {
        tx.insert(projects)
          .values({ ...initial.project, id: rollbackId, repositoryPath: "/rolled-back" })
          .run();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(() => repositories.projects.getById(rollbackId)).toThrow(RepositoryNotFoundError);
    await repositories.projects.create({
      name: "Alpha",
      description: null,
      repositoryPath: "/pagination/alpha",
      repositoryUrl: null,
      defaultBranch: null,
      currentCommit: null,
      settings: initial.project.settings,
    });
    await repositories.projects.create({
      name: "Beta",
      description: null,
      repositoryPath: "/pagination/beta",
      repositoryUrl: null,
      defaultBranch: null,
      currentCommit: null,
      settings: initial.project.settings,
    });
    const page = repositories.projects.list({ nameContains: "a", limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
  });

  it("assigns ordered run-scoped event sequences and supports replay cursors", async () => {
    const fixture = await createFixture();
    const first = repositories.events.append({
      runId: fixture.run.id,
      type: "run.created",
      occurredAt: fixedTime,
      data: { taskId: fixture.task.id },
    });
    const second = repositories.events.append({
      runId: fixture.run.id,
      type: "run.started",
      occurredAt: fixedTime,
      data: {},
    });
    const failed = repositories.events.append({
      runId: fixture.run.id,
      type: "run.failed",
      occurredAt: fixedTime,
      data: { code: "provider_error", message: "Request failed API_KEY=sk-test-secret-value-123" },
    });
    expect(second.sequence).toBe(first.sequence + 1);
    expect(failed.sequence).toBe(second.sequence + 1);
    expect(failed.data.message).toBe("Request failed API_KEY=[REDACTED]");
    expect(
      repositories.events.list({ runId: fixture.run.id, afterSequence: first.sequence }).items,
    ).toEqual([second, failed]);
  });

  it("persists run, manifest, approval and event history across reopening", async () => {
    const fixture = await createFixture();
    const manifest = repositories.manifests.create({
      version: 1,
      runId: fixture.run.id,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      adapterId: fixture.agent.adapterId,
      adapterVersion: fixture.agent.version,
      providerId: fixture.provider.id,
      modelId: fixture.run.modelId,
      promptConfigurationHash: "c".repeat(64),
      repositoryCommitSha: null,
      toolVersions: {},
      skillVersions: {},
      runtimeConfiguration: { timeoutSeconds: 120 },
      permissionConfiguration: fixture.project.settings,
      environmentVariableNames: ["MODEL_API_KEY"],
    });
    const approval = repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "install",
      actionDescription: "Install a dependency",
      requestedPermissions: ["package_install"],
      status: "pending",
      requestedAt: fixedTime,
      resolvedAt: null,
      resolvedBy: null,
    });
    repositories.evaluations.create({
      runId: fixture.run.id,
      evaluatorVersion: "1.0.0",
      criteria: {},
      scores: { quality: 0.8 },
      testResults: { passed: true },
      summary: "Persisted evaluation",
    });
    repositories.events.append({
      runId: fixture.run.id,
      type: "run.created",
      occurredAt: fixedTime,
      data: { taskId: fixture.task.id },
    });
    const filename = database.filename;
    database.close();
    database = await openDatabase({ filename, now: () => fixedTime });
    repositories = new Repositories(database);
    expect(repositories.runs.getById(fixture.run.id).status).toBe("created");
    expect(repositories.manifests.getByRunId(fixture.run.id).id).toBe(manifest.id);
    expect(repositories.approvals.getById(approval.id).status).toBe("pending");
    expect(repositories.evaluations.list(fixture.run.id).total).toBe(1);
    expect(repositories.events.list({ runId: fixture.run.id }).total).toBe(1);
    database.close();
    database.close();
  });

  it("serializes writes from two database connections and keeps pagination counts accurate", async () => {
    const other = await openDatabase({ filename: database.filename, now: () => fixedTime });
    const otherRepositories = new Repositories(other);
    const entries = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const repository = index % 2 ? repositories.projects : otherRepositories.projects;
        return repository.create({
          name: `Concurrent ${index}`,
          description: null,
          repositoryPath: `/concurrent/${index}`,
          repositoryUrl: null,
          defaultBranch: null,
          currentCommit: null,
          settings: { permissionMode: "supervised", networkAccess: "disabled" },
        });
      }),
    );
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(12);
    expect(repositories.projects.list({ limit: 20 }).total).toBe(12);
    other.close();
  });
});
