import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  openPostgresDatabase,
  applyPostgresMigrations,
  rollbackLastPostgresMigration,
} from "../src/postgres-database.js";
import type { AgentOsPostgresDatabase } from "../src/postgres-database.js";
import { PostgresRepositories } from "../src/postgres-repositories.js";
import { postgresMigrations } from "../src/postgres-migrations.js";
import { RepositoryConflictError } from "../src/repository-common.js";

const fixedTime = "2026-11-05T12:00:00.000Z";
const testConnectionString = process.env.AGENTOS_POSTGRES_TEST_URL;
const testMode = testConnectionString
  ? "PostgreSQL service"
  : "PGlite PostgreSQL engine over the pg protocol";
const testSchema = `agentos_test_${randomUUID().replaceAll("-", "")}`;
let pglite: PGlite | undefined;
let pgliteServer: PGLiteSocketServer | undefined;
let adminPool: Pool;
let database: AgentOsPostgresDatabase;
let repositories: PostgresRepositories;

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
    name: "Postgres test agent",
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
    description: "PostgreSQL integration data",
    priority: "normal",
    status: "open",
    assignedAgentId: agent.id,
    configuration: {},
  });
  const run = await repositories.runs.create({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    adapterVersion: agent.version,
    providerId: provider.id,
    modelId: "qwen",
    status: "created",
    manifestId: null,
    workspaceId: "pg-test-workspace",
    startedAt: null,
    completedAt: null,
    error: null,
    usageMetrics: {},
  });
  return { project, agent, provider, task, run };
}

beforeAll(async () => {
  let connectionString = testConnectionString;
  if (!connectionString) {
    pglite = await PGlite.create();
    pgliteServer = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 12,
    });
    await pgliteServer.start();
    connectionString = `postgresql://postgres:postgres@${pgliteServer.getServerConn()}/postgres`;
  }

  adminPool = new Pool({ connectionString, max: 2, ssl: false });
  await adminPool.query(`CREATE SCHEMA "${testSchema}"`);
  database = await openPostgresDatabase({
    connectionString,
    schema: testSchema,
    maxPoolSize: 8,
    ssl: false,
    now: () => fixedTime,
  });
  repositories = new PostgresRepositories(database);
}, 60_000);

beforeEach(async () => {
  await database.pool.query(`TRUNCATE TABLE
    agent_events, run_event_counters, approvals, evaluations, execution_runs,
    run_manifests, tasks, agents, providers, projects CASCADE`);
});

afterAll(async () => {
  if (database) await database.close();
  if (adminPool) {
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    } finally {
      await adminPool.end();
    }
  }
  if (pgliteServer) await pgliteServer.stop();
  if (pglite) await pglite.close();
}, 60_000);

describe(`PostgreSQL persistence (${testMode})`, () => {
  it("initializes migrations idempotently and rejects checksum drift", async () => {
    await applyPostgresMigrations(database.pool, postgresMigrations);
    const rows = await database.pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.rows).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(
      applyPostgresMigrations(database.pool, [
        { ...postgresMigrations[0]!, sql: `${postgresMigrations[0]!.sql}\n-- changed` },
      ]),
    ).rejects.toThrow("has changed");
  });

  it("reverses the additive approval migration only before approval audit data is written", async () => {
    expect(await rollbackLastPostgresMigration(database.pool)).toBe(2);
    const remaining = await database.pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(remaining.rows).toEqual([{ version: 1 }]);
    await applyPostgresMigrations(database.pool, postgresMigrations);
    const fixture = await createFixture();
    await repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "workspace.write",
      actionDescription: "Permit writes",
      requestedPermissions: ["file.write"],
      status: "approved",
      requestedAt: fixedTime,
      resolvedAt: fixedTime,
      resolvedBy: "pg-user",
      principalId: "pg-user",
      policyVersion: "policy-v1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    await expect(rollbackLastPostgresMigration(database.pool)).rejects.toThrow(
      /discard approval audit state/,
    );
  });

  it("rolls back a failed migration without leaving partial DDL", async () => {
    await expect(
      applyPostgresMigrations(database.pool, [
        ...postgresMigrations,
        {
          version: 100,
          name: "broken_test_migration",
          sql: "CREATE TABLE partial_pg_migration(id UUID); INVALID SQL;",
        },
      ]),
    ).rejects.toThrow("Could not apply PostgreSQL migrations");
    const partial = await database.pool.query("SELECT to_regclass($1) AS name", [
      `${testSchema}.partial_pg_migration`,
    ]);
    expect(partial.rows[0]?.name).toBeNull();
    const migration = await database.pool.query(
      "SELECT version FROM schema_migrations WHERE version = 100",
    );
    expect(migration.rows).toHaveLength(0);
  });

  it("creates and retrieves projects, agents, providers, tasks, and runs", async () => {
    const fixture = await createFixture();
    expect(await repositories.projects.getById(fixture.project.id)).toEqual(fixture.project);
    expect(await repositories.agents.getById(fixture.agent.id)).toEqual(fixture.agent);
    expect(await repositories.providers.getById(fixture.provider.id)).toEqual(fixture.provider);
    expect(await repositories.tasks.getById(fixture.task.id)).toEqual(fixture.task);
    expect(await repositories.runs.getById(fixture.run.id)).toEqual(fixture.run);
  });

  it("persists an immutable manifest and enforces its run relationship", async () => {
    const fixture = await createFixture();
    const manifest = await repositories.manifests.create({
      version: 1,
      runId: fixture.run.id,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      adapterId: fixture.agent.adapterId,
      adapterVersion: fixture.agent.version,
      providerId: fixture.provider.id,
      modelId: fixture.run.modelId,
      promptConfigurationHash: "d".repeat(64),
      repositoryCommitSha: null,
      toolVersions: { node: "24" },
      skillVersions: {},
      runtimeConfiguration: { timeoutSeconds: 120 },
      permissionConfiguration: fixture.project.settings,
      environmentVariableNames: ["MODEL_API_KEY"],
    });
    expect(await repositories.manifests.getByRunId(fixture.run.id)).toEqual(manifest);
    expect((await repositories.runs.getById(fixture.run.id)).manifestId).toBe(manifest.id);
    await expect(
      database.pool.query("UPDATE execution_runs SET manifest_id = $1 WHERE id = $2", [
        randomUUID(),
        fixture.run.id,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(repositories.runs.update(fixture.run.id, { modelId: "other" })).rejects.toThrow();
  });

  it("stores normalized events in order, redacts secrets, and filters by sequence", async () => {
    const fixture = await createFixture();
    const created = await repositories.events.append({
      runId: fixture.run.id,
      type: "run.created",
      occurredAt: fixedTime,
      data: { taskId: fixture.task.id },
    });
    const started = await repositories.events.append({
      runId: fixture.run.id,
      type: "run.started",
      occurredAt: fixedTime,
      data: {},
    });
    const failed = await repositories.events.append({
      runId: fixture.run.id,
      type: "run.failed",
      occurredAt: fixedTime,
      data: { code: "provider_error", message: "API_KEY=sk-test-secret-value-123" },
    });
    expect([created.sequence, started.sequence, failed.sequence]).toEqual([1, 2, 3]);
    expect(failed.data.message).toBe("API_KEY=[REDACTED]");
    expect(
      (await repositories.events.list({ runId: fixture.run.id, afterSequence: 1 })).items,
    ).toEqual([started, failed]);
  });

  it("resolves approvals once and paginates evaluations and runs", async () => {
    const fixture = await createFixture();
    const approval = await repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "install",
      actionDescription: "Install dependency",
      requestedPermissions: ["package_install"],
      status: "pending",
      requestedAt: fixedTime,
      resolvedAt: null,
      resolvedBy: null,
    });
    await expect(
      repositories.approvals.resolve(approval.id, "approved", "human:operator"),
    ).rejects.toThrow(/trusted server-side policy service/);
    expect(
      (await repositories.approvals.resolve(approval.id, "rejected", "human:operator")).status,
    ).toBe("rejected");
    await expect(
      repositories.approvals.resolve(approval.id, "rejected", "human:operator"),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    await repositories.evaluations.create({
      runId: fixture.run.id,
      evaluatorVersion: "1.0.0",
      criteria: {},
      scores: { correctness: 0.9 },
      testResults: { passed: true },
      summary: "Verified",
    });
    expect((await repositories.evaluations.list(fixture.run.id, { limit: 1 })).total).toBe(1);
    expect(
      (await repositories.runs.list({ projectId: fixture.project.id, limit: 1 })).items,
    ).toHaveLength(1);
  });

  it("atomically consumes a principal/action/run-bound approval only once", async () => {
    const fixture = await createFixture();
    const principalId = "pg-user-1";
    const approval = await repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "workspace.write",
      actionDescription: "Write to this run workspace",
      requestedPermissions: ["file.write"],
      status: "approved",
      requestedAt: fixedTime,
      resolvedAt: fixedTime,
      resolvedBy: principalId,
      principalId,
      policyVersion: "policy-v1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    const input = {
      id: approval.id,
      runId: fixture.run.id,
      principalId,
      actionType: "workspace.write",
      policyVersion: "policy-v1",
      at: fixedTime,
    };
    const consume = (value: typeof input) =>
      repositories.approvals.consumeWithEvent(value, {
        runId: fixture.run.id,
        type: "approval.consumed",
        occurredAt: fixedTime,
        data: {
          approvalId: approval.id,
          principalId: value.principalId,
          policyVersion: value.policyVersion,
          actionType: value.actionType,
        },
      });
    const results = await Promise.allSettled([consume(input), consume(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await repositories.approvals.getById(approval.id)).consumedAt).toBe(fixedTime);
    await expect(consume({ ...input, principalId: "wrong-principal" })).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
  });

  it("rolls approval consumption back if PostgreSQL cannot persist its audit event", async () => {
    const fixture = await createFixture();
    const principalId = "pg-audit-failure-user";
    const approval = await repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "workspace.write",
      actionDescription: "Permit writes",
      requestedPermissions: ["file.write"],
      status: "approved",
      requestedAt: fixedTime,
      resolvedAt: fixedTime,
      resolvedBy: principalId,
      principalId,
      policyVersion: "policy-v1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    await database.pool.query(`
      CREATE FUNCTION reject_approval_consumption_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type = 'approval.consumed' THEN
          RAISE EXCEPTION 'audit storage unavailable';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_approval_consumption_audit
      BEFORE INSERT ON agent_events
      FOR EACH ROW EXECUTE FUNCTION reject_approval_consumption_audit();
    `);
    await expect(
      repositories.approvals.consumeWithEvent(
        {
          id: approval.id,
          runId: fixture.run.id,
          principalId,
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
            principalId,
            policyVersion: "policy-v1",
            actionType: "workspace.write",
          },
        },
      ),
    ).rejects.toThrow();
    expect((await repositories.approvals.getById(approval.id)).consumedAt).toBeNull();
    expect(
      (await repositories.events.list({ runId: fixture.run.id })).items.filter(
        (event) => event.type === "approval.consumed",
      ),
    ).toHaveLength(0);
  });

  it("serializes revocation racing with consumption so only one terminal action wins", async () => {
    const fixture = await createFixture();
    const principalId = "pg-race-user";
    const approval = await repositories.approvals.create({
      runId: fixture.run.id,
      actionType: "workspace.write",
      actionDescription: "Permit writes",
      requestedPermissions: ["file.write"],
      status: "approved",
      requestedAt: fixedTime,
      resolvedAt: fixedTime,
      resolvedBy: principalId,
      principalId,
      policyVersion: "policy-v1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    const input = {
      id: approval.id,
      runId: fixture.run.id,
      principalId,
      actionType: "workspace.write",
      policyVersion: "policy-v1",
      at: fixedTime,
    };
    const [consumed, revoked] = await Promise.allSettled([
      repositories.approvals.consumeWithEvent(input, {
        runId: fixture.run.id,
        type: "approval.consumed",
        occurredAt: fixedTime,
        data: {
          approvalId: approval.id,
          principalId,
          policyVersion: "policy-v1",
          actionType: "workspace.write",
        },
      }),
      repositories.approvals.revoke(approval.id, principalId, fixedTime),
    ]);
    expect(
      [consumed.status, revoked.status].filter((status) => status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await repositories.approvals.getById(approval.id);
    expect(Number(stored.consumedAt !== null) + Number(stored.revokedAt !== null)).toBe(1);
  });

  it("enforces foreign keys and maps unique violations to repository errors", async () => {
    const fixture = await createFixture();
    await expect(
      repositories.tasks.create({
        projectId: randomUUID(),
        title: "Missing project",
        description: "Invalid relationship",
        priority: "low",
        status: "open",
        assignedAgentId: null,
        configuration: {},
      }),
    ).rejects.toThrow("Task project does not exist");
    await expect(
      repositories.projects.create({
        name: "Duplicate path",
        description: null,
        repositoryPath: fixture.project.repositoryPath,
        repositoryUrl: null,
        defaultBranch: null,
        currentCommit: null,
        settings: fixture.project.settings,
      }),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(
      database.pool.query(
        "INSERT INTO tasks (id, project_id, title, description, priority, status, configuration, created_at, updated_at) VALUES ($1, $2, 'x', 'x', 'low', 'open', '{}'::jsonb, $3, $3)",
        [randomUUID(), randomUUID(), fixedTime],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rolls back user transactions and survives pool/database reopening", async () => {
    const fixture = await createFixture();
    await repositories.events.append({
      runId: fixture.run.id,
      type: "run.created",
      occurredAt: fixedTime,
      data: { taskId: fixture.task.id },
    });
    const rolledBackId = randomUUID();
    await expect(
      database.transaction(async (client) => {
        await client.query(
          "INSERT INTO projects (id, name, repository_path, settings, created_at, updated_at) VALUES ($1, 'rollback', '/rollback', '{}'::jsonb, $2, $2)",
          [rolledBackId, fixedTime],
        );
        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");
    await expect(repositories.projects.getById(rolledBackId)).rejects.toThrow();

    await database.close();
    database = await openPostgresDatabase({
      connectionString:
        testConnectionString ??
        `postgresql://postgres:postgres@${pgliteServer!.getServerConn()}/postgres`,
      schema: testSchema,
      maxPoolSize: 8,
      ssl: false,
      now: () => fixedTime,
    });
    repositories = new PostgresRepositories(database);
    expect((await repositories.runs.getById(fixture.run.id)).id).toBe(fixture.run.id);
    expect((await repositories.events.list({ runId: fixture.run.id })).total).toBe(1);
  });

  it("handles concurrent inserts through pooled connections", async () => {
    const projects = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repositories.projects.create({
          name: `Concurrent ${index}`,
          description: null,
          repositoryPath: `/pg-concurrent/${index}`,
          repositoryUrl: null,
          defaultBranch: null,
          currentCommit: null,
          settings: { permissionMode: "supervised", networkAccess: "disabled" },
        }),
      ),
    );
    expect(new Set(projects.map((project) => project.id)).size).toBe(20);
    expect((await repositories.projects.list({ limit: 20 })).total).toBe(20);
    // PGlite multiplexes PostgreSQL protocol connections over one embedded engine;
    // checking the production pg Pool is portable across it and server PostgreSQL.
    expect(database.pool.totalCount).toBeGreaterThan(1);
  });

  it("enforces explicit pool and schema configuration bounds", async () => {
    await expect(
      openPostgresDatabase({ connectionString: "postgresql://unused", maxPoolSize: 101 }),
    ).rejects.toThrow("maxPoolSize");
    await expect(
      openPostgresDatabase({ connectionString: "postgresql://unused", schema: "bad-name" }),
    ).rejects.toThrow("schema");
  });
});
