import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNotNull, isNull, like, lt, max, sql } from "drizzle-orm";
import type {
  Agent,
  Approval,
  CreateAgent,
  CreateAgentEvent,
  CreateApproval,
  CreateEvaluation,
  CreateExecutionRun,
  CreateProject,
  CreateProvider,
  CreateRunManifest,
  CreateTask,
  Evaluation,
  ExecutionRun,
  Project,
  Provider,
  RunManifest,
  RunArtifact,
  WorkerLease,
  RunLeaseIdentity,
  LeaseClaim,
  CreateRunArtifact,
  RepositorySet,
  Task,
} from "@agentos/core";
import {
  agentEventSchema,
  agentSchema,
  approvalSchema,
  createAgentEventSchema,
  createAgentSchema,
  createApprovalSchema,
  createEvaluationSchema,
  createExecutionRunSchema,
  createProjectSchema,
  createProviderSchema,
  createRunManifestSchema,
  createTaskSchema,
  evaluationSchema,
  executionRunSchema,
  projectSchema,
  providerSchema,
  runManifestSchema,
  runArtifactSchema,
  createRunArtifactSchema,
  taskSchema,
  transitionRun,
  workerLeaseSchema,
  type AgentEvent,
  redactEventSecrets,
} from "@agentos/core";
import type {
  EventFilter,
  Page,
  PageRequest,
  ProjectFilter,
  RunFilter,
  TaskFilter,
} from "@agentos/core";
import type { AgentOsDatabase } from "./database.js";
import {
  assertId,
  pageRequest,
  RelationshipValidationError,
  RepositoryConflictError,
  RepositoryNotFoundError,
  translateError,
} from "./repository-common.js";
import { SqliteAuthenticationRepository } from "./auth-repositories.js";
import {
  agentEvents,
  agents,
  approvals,
  evaluations,
  executionRuns,
  projects,
  providers,
  runManifests,
  runArtifacts,
  tasks,
} from "./schema.js";

export {
  RelationshipValidationError,
  RepositoryConflictError,
  RepositoryNotFoundError,
} from "./repository-common.js";
export type {
  EventFilter,
  Page,
  PageRequest,
  ProjectFilter,
  RunFilter,
  TaskFilter,
} from "@agentos/core";

function assertSqliteLease(
  database: AgentOsDatabase,
  runId: string,
  identity: RunLeaseIdentity,
  now: string,
): void {
  const row = database.sqlite
    .prepare("SELECT worker_id,generation,expires_at,released_at FROM run_leases WHERE run_id=?")
    .get(runId) as
    | { worker_id: string; generation: number; expires_at: string; released_at: string | null }
    | undefined;
  if (
    !row ||
    row.worker_id !== identity.workerId ||
    row.generation !== identity.generation ||
    row.released_at !== null ||
    row.expires_at <= now
  )
    throw new RepositoryConflictError("Worker lease is stale or no longer owns this run");
}

export class ProjectRepository {
  constructor(private readonly database: AgentOsDatabase) {}

  async create(input: CreateProject, id = randomUUID()): Promise<Project> {
    const now = this.database.now();
    const value = projectSchema.parse({
      ...createProjectSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    try {
      this.database.orm.insert(projects).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }

  getById(id: string): Project {
    const row = this.database.orm
      .select()
      .from(projects)
      .where(eq(projects.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Project", id);
    return projectSchema.parse(row);
  }

  list(filter: ProjectFilter = {}): Page<Project> {
    const { limit, offset } = pageRequest(filter);
    const condition = filter.nameContains
      ? like(projects.name, `%${filter.nameContains}%`)
      : undefined;
    const rows = this.database.orm
      .select()
      .from(projects)
      .where(condition)
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(projects).where(condition).get()?.value ??
      0;
    return { items: rows.map((row) => projectSchema.parse(row)), total, limit, offset };
  }

  update(id: string, patch: Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>): Project {
    const current = this.getById(id);
    const value = projectSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    try {
      this.database.orm.update(projects).set(value).where(eq(projects.id, current.id)).run();
      return this.getById(id);
    } catch (error) {
      return translateError(error);
    }
  }

  delete(id: string): boolean {
    try {
      return (
        this.database.orm
          .delete(projects)
          .where(eq(projects.id, assertId(id)))
          .run().changes > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class AgentRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  async create(input: CreateAgent, id = randomUUID()): Promise<Agent> {
    const now = this.database.now();
    const value = agentSchema.parse({
      ...createAgentSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    try {
      this.database.orm.insert(agents).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }
  getById(id: string): Agent {
    const row = this.database.orm
      .select()
      .from(agents)
      .where(eq(agents.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Agent", id);
    return agentSchema.parse(row);
  }
  list(input: PageRequest = {}): Page<Agent> {
    const { limit, offset } = pageRequest(input);
    const rows = this.database.orm
      .select()
      .from(agents)
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total = this.database.orm.select({ value: count() }).from(agents).get()?.value ?? 0;
    return { items: rows.map((row) => agentSchema.parse(row)), total, limit, offset };
  }
  update(id: string, patch: Partial<Omit<Agent, "id" | "createdAt" | "updatedAt">>): Agent {
    const current = this.getById(id);
    const value = agentSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    this.database.orm.update(agents).set(value).where(eq(agents.id, current.id)).run();
    return this.getById(id);
  }
  delete(id: string): boolean {
    try {
      return (
        this.database.orm
          .delete(agents)
          .where(eq(agents.id, assertId(id)))
          .run().changes > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class ProviderRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  async create(input: CreateProvider, id = randomUUID()): Promise<Provider> {
    const now = this.database.now();
    const value = providerSchema.parse({
      ...createProviderSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    try {
      this.database.orm.insert(providers).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }
  getById(id: string): Provider {
    const row = this.database.orm
      .select()
      .from(providers)
      .where(eq(providers.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Provider", id);
    return providerSchema.parse(row);
  }
  list(input: PageRequest = {}): Page<Provider> {
    const { limit, offset } = pageRequest(input);
    const rows = this.database.orm
      .select()
      .from(providers)
      .orderBy(desc(providers.createdAt), desc(providers.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total = this.database.orm.select({ value: count() }).from(providers).get()?.value ?? 0;
    return { items: rows.map((row) => providerSchema.parse(row)), total, limit, offset };
  }
  update(id: string, patch: Partial<Omit<Provider, "id" | "createdAt" | "updatedAt">>): Provider {
    const current = this.getById(id);
    const value = providerSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    this.database.orm.update(providers).set(value).where(eq(providers.id, current.id)).run();
    return this.getById(id);
  }
  delete(id: string): boolean {
    try {
      return (
        this.database.orm
          .delete(providers)
          .where(eq(providers.id, assertId(id)))
          .run().changes > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class TaskRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  async create(input: CreateTask, id = randomUUID()): Promise<Task> {
    const value = taskSchema.parse({
      ...createTaskSchema.parse(input),
      id,
      createdAt: this.database.now(),
      updatedAt: this.database.now(),
    });
    if (
      !this.database.orm
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, value.projectId))
        .get()
    )
      throw new RelationshipValidationError("Task project does not exist");
    if (
      value.assignedAgentId &&
      !this.database.orm
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, value.assignedAgentId))
        .get()
    )
      throw new RelationshipValidationError("Assigned agent does not exist");
    try {
      this.database.orm.insert(tasks).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }
  getById(id: string): Task {
    const row = this.database.orm
      .select()
      .from(tasks)
      .where(eq(tasks.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Task", id);
    return taskSchema.parse(row);
  }
  list(filter: TaskFilter = {}): Page<Task> {
    const { limit, offset } = pageRequest(filter);
    const conditions = [];
    if (filter.projectId) conditions.push(eq(tasks.projectId, assertId(filter.projectId)));
    if (filter.status) conditions.push(eq(tasks.status, filter.status));
    const condition = conditions.length ? and(...conditions) : undefined;
    const rows = this.database.orm
      .select()
      .from(tasks)
      .where(condition)
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(tasks).where(condition).get()?.value ?? 0;
    return { items: rows.map((row) => taskSchema.parse(row)), total, limit, offset };
  }
  update(id: string, patch: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>): Task {
    const current = this.getById(id);
    const value = taskSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    if (
      !this.database.orm
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, value.projectId))
        .get()
    )
      throw new RelationshipValidationError("Task project does not exist");
    if (
      value.assignedAgentId &&
      !this.database.orm
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, value.assignedAgentId))
        .get()
    )
      throw new RelationshipValidationError("Assigned agent does not exist");
    this.database.orm.update(tasks).set(value).where(eq(tasks.id, current.id)).run();
    return this.getById(id);
  }
  delete(id: string): boolean {
    try {
      return (
        this.database.orm
          .delete(tasks)
          .where(eq(tasks.id, assertId(id)))
          .run().changes > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class ExecutionRunRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  async createWithLease(
    input: CreateExecutionRun,
    workerId: string,
    claimedAt: string,
    expiresAt: string,
    id = randomUUID(),
  ) {
    const value = executionRunSchema.parse({
      ...createExecutionRunSchema.parse(input),
      id,
      createdAt: claimedAt,
      updatedAt: claimedAt,
    });
    if (value.status !== "created" || value.manifestId !== null)
      throw new RelationshipValidationError("New runs must begin created without a manifest");
    const lease = this.database.sqlite
      .transaction(() => {
        const task = this.database.orm.select().from(tasks).where(eq(tasks.id, value.taskId)).get();
        if (!task || task.projectId !== value.projectId)
          throw new RelationshipValidationError("Run task must belong to its project");
        if (task.assignedAgentId && task.assignedAgentId !== value.agentId)
          throw new RelationshipValidationError("Run agent differs from the task assignment");
        this.database.orm.insert(executionRuns).values(value).run();
        const row = this.database.sqlite
          .prepare(
            "INSERT INTO run_leases(run_id,worker_id,generation,claimed_at,heartbeat_at,expires_at,released_at) VALUES(?,?,1,?,?,?,NULL) RETURNING *",
          )
          .get(id, workerId, claimedAt, claimedAt, expiresAt) as Record<string, unknown>;
        return workerLeaseSchema.parse({
          runId: row["run_id"],
          workerId: row["worker_id"],
          generation: row["generation"],
          claimedAt: row["claimed_at"],
          heartbeatAt: row["heartbeat_at"],
          expiresAt: row["expires_at"],
          releasedAt: row["released_at"],
        });
      })
      .immediate();
    return { run: this.getById(id), lease };
  }
  updateOwned(
    id: string,
    patch: Partial<Omit<ExecutionRun, "id" | "createdAt" | "updatedAt">>,
    identity: RunLeaseIdentity,
    now: string,
  ): ExecutionRun {
    return this.database.sqlite
      .transaction(() => {
        assertSqliteLease(this.database, id, identity, now);
        return this.update(id, patch);
      })
      .immediate();
  }
  async create(input: CreateExecutionRun, id = randomUUID()): Promise<ExecutionRun> {
    const now = this.database.now();
    const value = executionRunSchema.parse({
      ...createExecutionRunSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    if (value.status !== "created") {
      throw new RelationshipValidationError("New runs must begin in the created state");
    }
    const task = this.database.orm.select().from(tasks).where(eq(tasks.id, value.taskId)).get();
    if (!task || task.projectId !== value.projectId)
      throw new RelationshipValidationError("Run task must belong to its project");
    if (task.assignedAgentId && task.assignedAgentId !== value.agentId)
      throw new RelationshipValidationError("Run agent differs from the task assignment");
    if (value.manifestId !== null)
      throw new RelationshipValidationError(
        "Create a run without manifestId, then persist its manifest",
      );
    try {
      this.database.orm.insert(executionRuns).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }
  getById(id: string): ExecutionRun {
    const row = this.database.orm
      .select()
      .from(executionRuns)
      .where(eq(executionRuns.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Execution run", id);
    return executionRunSchema.parse(row);
  }
  list(filter: RunFilter = {}): Page<ExecutionRun> {
    const { limit, offset } = pageRequest(filter);
    const conditions = [];
    if (filter.projectId) conditions.push(eq(executionRuns.projectId, assertId(filter.projectId)));
    if (filter.taskId) conditions.push(eq(executionRuns.taskId, assertId(filter.taskId)));
    if (filter.status) conditions.push(eq(executionRuns.status, filter.status));
    const condition = conditions.length ? and(...conditions) : undefined;
    const rows = this.database.orm
      .select()
      .from(executionRuns)
      .where(condition)
      .orderBy(desc(executionRuns.createdAt), desc(executionRuns.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(executionRuns).where(condition).get()
        ?.value ?? 0;
    return { items: rows.map((row) => executionRunSchema.parse(row)), total, limit, offset };
  }
  update(
    id: string,
    patch: Partial<Omit<ExecutionRun, "id" | "createdAt" | "updatedAt">>,
  ): ExecutionRun {
    const current = this.getById(id);
    const value = executionRunSchema.parse({
      ...current,
      ...patch,
      updatedAt: this.database.now(),
    });
    if (value.status !== current.status) transitionRun(current.status, value.status);
    if (value.manifestId !== current.manifestId) {
      throw new RelationshipValidationError("Only the manifest repository can link a run manifest");
    }
    if (
      current.manifestId !== null &&
      (value.taskId !== current.taskId ||
        value.projectId !== current.projectId ||
        value.agentId !== current.agentId ||
        value.adapterVersion !== current.adapterVersion ||
        value.providerId !== current.providerId ||
        value.modelId !== current.modelId)
    ) {
      throw new RelationshipValidationError(
        "Run identity cannot change after its manifest is stored",
      );
    }
    const task = this.database.orm.select().from(tasks).where(eq(tasks.id, value.taskId)).get();
    if (!task || task.projectId !== value.projectId)
      throw new RelationshipValidationError("Run task must belong to its project");
    if (task.assignedAgentId && task.assignedAgentId !== value.agentId)
      throw new RelationshipValidationError("Run agent differs from the task assignment");
    const result = this.database.orm
      .update(executionRuns)
      .set(value)
      .where(and(eq(executionRuns.id, current.id), eq(executionRuns.status, current.status)))
      .run();
    if (result.changes === 0)
      throw new RepositoryConflictError("Run changed during update; reload and retry");
    return this.getById(id);
  }
  delete(id: string): boolean {
    try {
      return (
        this.database.orm
          .delete(executionRuns)
          .where(eq(executionRuns.id, assertId(id)))
          .run().changes > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class RunLeaseRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  claim(runId: string, workerId: string, now: string, expiresAt: string): LeaseClaim | null {
    assertId(runId);
    const claimed = this.database.sqlite
      .transaction(() => {
        const prior = this.database.sqlite
          .prepare("SELECT * FROM run_leases WHERE run_id = ?")
          .get(runId) as Record<string, unknown> | undefined;
        if (prior && prior["released_at"] === null && String(prior["expires_at"]) > now)
          return null;
        const previousGeneration = prior ? Number(prior["generation"]) : null;
        const generation = (previousGeneration ?? 0) + 1;
        this.database.sqlite
          .prepare(
            `INSERT INTO run_leases(run_id, worker_id, generation, claimed_at, heartbeat_at, expires_at, released_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(run_id) DO UPDATE SET worker_id=excluded.worker_id, generation=excluded.generation,
        claimed_at=excluded.claimed_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at, released_at=NULL`,
          )
          .run(runId, workerId, generation, now, now, expiresAt);
        const row = this.database.sqlite
          .prepare("SELECT * FROM run_leases WHERE run_id = ?")
          .get(runId) as Record<string, unknown>;
        return {
          lease: workerLeaseSchema.parse({
            runId: row["run_id"],
            workerId: row["worker_id"],
            generation: row["generation"],
            claimedAt: row["claimed_at"],
            heartbeatAt: row["heartbeat_at"],
            expiresAt: row["expires_at"],
            releasedAt: row["released_at"],
          }),
          previousGeneration,
        };
      })
      .immediate();
    return claimed;
  }
  renew(
    runId: string,
    identity: RunLeaseIdentity,
    now: string,
    expiresAt: string,
  ): WorkerLease | null {
    const result = this.database.sqlite
      .prepare(
        `UPDATE run_leases SET heartbeat_at=?, expires_at=? WHERE run_id=? AND worker_id=? AND generation=? AND released_at IS NULL AND expires_at>?`,
      )
      .run(now, expiresAt, runId, identity.workerId, identity.generation, now);
    return result.changes ? this.getByRunId(runId) : null;
  }
  release(runId: string, identity: RunLeaseIdentity, at: string): boolean {
    return (
      this.database.sqlite
        .prepare(
          `UPDATE run_leases SET released_at=? WHERE run_id=? AND worker_id=? AND generation=? AND released_at IS NULL`,
        )
        .run(at, runId, identity.workerId, identity.generation).changes > 0
    );
  }
  getByRunId(runId: string): WorkerLease | null {
    const row = this.database.sqlite
      .prepare("SELECT * FROM run_leases WHERE run_id=?")
      .get(runId) as Record<string, unknown> | undefined;
    return row
      ? workerLeaseSchema.parse({
          runId: row["run_id"],
          workerId: row["worker_id"],
          generation: row["generation"],
          claimedAt: row["claimed_at"],
          heartbeatAt: row["heartbeat_at"],
          expiresAt: row["expires_at"],
          releasedAt: row["released_at"],
        })
      : null;
  }
  listExpired(now: string, input: PageRequest = {}): Page<WorkerLease> {
    const { limit, offset } = pageRequest(input);
    const rows = this.database.sqlite
      .prepare(
        "SELECT * FROM run_leases WHERE released_at IS NOT NULL OR expires_at <= ? ORDER BY expires_at, run_id LIMIT ? OFFSET ?",
      )
      .all(now, limit, offset) as Record<string, unknown>[];
    const total = (
      this.database.sqlite
        .prepare(
          "SELECT count(*) AS value FROM run_leases WHERE released_at IS NOT NULL OR expires_at <= ?",
        )
        .get(now) as { value: number }
    ).value;
    return {
      items: rows.map((row) =>
        workerLeaseSchema.parse({
          runId: row["run_id"],
          workerId: row["worker_id"],
          generation: row["generation"],
          claimedAt: row["claimed_at"],
          heartbeatAt: row["heartbeat_at"],
          expiresAt: row["expires_at"],
          releasedAt: row["released_at"],
        }),
      ),
      total,
      limit,
      offset,
    };
  }
}

export class RunManifestRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  createOwned(
    input: CreateRunManifest,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): RunManifest {
    const value = runManifestSchema.parse({
      ...createRunManifestSchema.parse(input),
      id,
      createdAt: now,
    });
    return this.database.sqlite
      .transaction(() => {
        assertSqliteLease(this.database, input.runId, identity, now);
        const run = this.database.sqlite
          .prepare("SELECT agent_id,provider_id,manifest_id FROM execution_runs WHERE id=?")
          .get(input.runId) as Record<string, unknown> | undefined;
        if (
          !run ||
          run["agent_id"] !== input.agentId ||
          run["provider_id"] !== input.providerId ||
          run["manifest_id"] !== null
        )
          throw new RelationshipValidationError(
            "Manifest identities must match an unmanifested run",
          );
        this.database.sqlite
          .prepare(
            "INSERT INTO run_manifests(id,version,run_id,agent_id,agent_name,adapter_id,adapter_version,provider_id,model_id,prompt_configuration_hash,repository_commit_sha,tool_versions,skill_versions,runtime_configuration,permission_configuration,environment_variable_names,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            value.id,
            value.version,
            value.runId,
            value.agentId,
            value.agentName,
            value.adapterId,
            value.adapterVersion,
            value.providerId,
            value.modelId,
            value.promptConfigurationHash,
            value.repositoryCommitSha,
            JSON.stringify(value.toolVersions),
            JSON.stringify(value.skillVersions),
            JSON.stringify(value.runtimeConfiguration),
            JSON.stringify(value.permissionConfiguration),
            JSON.stringify(value.environmentVariableNames),
            value.createdAt,
          );
        this.database.sqlite
          .prepare(
            "UPDATE execution_runs SET manifest_id=?,updated_at=? WHERE id=? AND manifest_id IS NULL",
          )
          .run(value.id, now, value.runId);
        return this.getByRunId(value.runId);
      })
      .immediate();
  }
  create(input: CreateRunManifest, id = randomUUID()): RunManifest {
    const value = runManifestSchema.parse({
      ...createRunManifestSchema.parse(input),
      id,
      createdAt: this.database.now(),
    });
    const run = this.database.orm
      .select()
      .from(executionRuns)
      .where(eq(executionRuns.id, value.runId))
      .get();
    if (!run) throw new RelationshipValidationError("Manifest run does not exist");
    if (run.agentId !== value.agentId || run.providerId !== value.providerId)
      throw new RelationshipValidationError("Manifest identities must match the run");
    try {
      this.database.orm.transaction((tx) => {
        tx.insert(runManifests).values(value).run();
        tx.update(executionRuns)
          .set({ manifestId: value.id, updatedAt: this.database.now() })
          .where(eq(executionRuns.id, value.runId))
          .run();
      });
      return this.getByRunId(value.runId);
    } catch (error) {
      return translateError(error);
    }
  }
  getByRunId(runId: string): RunManifest {
    const row = this.database.orm
      .select()
      .from(runManifests)
      .where(eq(runManifests.runId, assertId(runId)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Run manifest", runId);
    return runManifestSchema.parse(row);
  }
  list(filter: PageRequest = {}): Page<RunManifest> {
    const { limit, offset } = pageRequest(filter);
    const rows = this.database.orm
      .select()
      .from(runManifests)
      .orderBy(desc(runManifests.createdAt), desc(runManifests.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total = this.database.orm.select({ value: count() }).from(runManifests).get()?.value ?? 0;
    return { items: rows.map((row) => runManifestSchema.parse(row)), total, limit, offset };
  }
}

export class AgentEventRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  appendOwned(
    input: CreateAgentEvent,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): AgentEvent {
    const base = createAgentEventSchema.parse(redactEventSecrets(input));
    try {
      return this.database.sqlite
        .transaction(() => {
          assertSqliteLease(this.database, input.runId, identity, now);
          const prior = this.database.sqlite
            .prepare("SELECT id,run_id,sequence,type,occurred_at,data FROM agent_events WHERE id=?")
            .get(id) as Record<string, unknown> | undefined;
          if (prior) {
            if (prior["run_id"] !== input.runId)
              throw new RepositoryConflictError("Event identifier is already bound to another run");
            return agentEventSchema.parse({
              id: prior["id"],
              runId: prior["run_id"],
              sequence: prior["sequence"],
              type: prior["type"],
              occurredAt: prior["occurred_at"],
              data:
                typeof prior["data"] === "string"
                  ? JSON.parse(prior["data"] as string)
                  : prior["data"],
            });
          }
          const last = (
            this.database.sqlite
              .prepare(
                "SELECT coalesce(max(sequence),0) AS sequence FROM agent_events WHERE run_id=?",
              )
              .get(base.runId) as { sequence: number }
          ).sequence;
          const event = agentEventSchema.parse({ ...base, id, sequence: last + 1 });
          const inserted = this.database.sqlite
            .prepare(
              "INSERT OR IGNORE INTO agent_events(id,run_id,sequence,type,occurred_at,data) VALUES(?,?,?,?,?,?)",
            )
            .run(
              event.id,
              event.runId,
              event.sequence,
              event.type,
              event.occurredAt,
              JSON.stringify(event.data),
            );
          if (inserted.changes === 0) {
            const existing = this.database.sqlite
              .prepare(
                "SELECT id,run_id,sequence,type,occurred_at,data FROM agent_events WHERE id=?",
              )
              .get(id) as Record<string, unknown> | undefined;
            if (existing && existing["run_id"] === input.runId)
              return agentEventSchema.parse({
                id: existing["id"],
                runId: existing["run_id"],
                sequence: existing["sequence"],
                type: existing["type"],
                occurredAt: existing["occurred_at"],
                data:
                  typeof existing["data"] === "string"
                    ? JSON.parse(existing["data"] as string)
                    : existing["data"],
              });
            throw new RepositoryConflictError("Event identifier is already bound to another run");
          }
          return event;
        })
        .immediate();
    } catch (error) {
      return translateError(error);
    }
  }
  append(input: CreateAgentEvent, id = randomUUID()): AgentEvent {
    const base = createAgentEventSchema.parse(redactEventSecrets(input));
    assertId(base.runId);
    try {
      return this.database.orm.transaction((tx) => {
        const exists = tx
          .select({ id: executionRuns.id })
          .from(executionRuns)
          .where(eq(executionRuns.id, base.runId))
          .get();
        if (!exists) throw new RelationshipValidationError("Event run does not exist");
        const last =
          tx
            .select({ sequence: max(agentEvents.sequence) })
            .from(agentEvents)
            .where(eq(agentEvents.runId, base.runId))
            .get()?.sequence ?? 0;
        const event = agentEventSchema.parse({ ...base, id, sequence: last + 1 });
        tx.insert(agentEvents)
          .values({ ...event, data: event.data })
          .run();
        return event;
      });
    } catch (error) {
      return translateError(error);
    }
  }
  list(filter: EventFilter): Page<AgentEvent> {
    const { limit, offset } = pageRequest(filter);
    const runId = assertId(filter.runId);
    const condition =
      filter.afterSequence === undefined
        ? eq(agentEvents.runId, runId)
        : and(eq(agentEvents.runId, runId), gt(agentEvents.sequence, filter.afterSequence));
    const rows = this.database.orm
      .select()
      .from(agentEvents)
      .where(condition)
      .orderBy(agentEvents.sequence)
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(agentEvents).where(condition).get()
        ?.value ?? 0;
    return {
      items: rows.map((row) =>
        agentEventSchema.parse({
          id: row.id,
          runId: row.runId,
          sequence: row.sequence,
          type: row.type,
          occurredAt: row.occurredAt,
          data: row.data,
        }),
      ),
      total,
      limit,
      offset,
    };
  }
}

export class RunArtifactRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  createOwned(
    input: CreateRunArtifact,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): RunArtifact {
    const value = runArtifactSchema.parse({
      ...createRunArtifactSchema.parse(input),
      id,
      createdAt: now,
    });
    try {
      return this.database.sqlite
        .transaction(() => {
          assertSqliteLease(this.database, input.runId, identity, now);
          this.database.sqlite
            .prepare(
              "INSERT INTO run_artifacts(id,run_id,project_id,artifact_type,logical_name,content_type,byte_size,sha256,created_at,storage_locator,collection_status,collection_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              value.id,
              value.runId,
              value.projectId,
              value.type,
              value.logicalName,
              value.contentType,
              value.byteSize,
              value.sha256,
              value.createdAt,
              value.storageLocator,
              value.collectionStatus,
              value.collectionError,
            );
          return this.getForProject(value.runId, value.projectId, value.id);
        })
        .immediate();
    } catch (error) {
      return translateError(error);
    }
  }

  create(input: CreateRunArtifact, id = randomUUID()): RunArtifact {
    const value = runArtifactSchema.parse({
      ...createRunArtifactSchema.parse(input),
      id,
      createdAt: this.database.now(),
    });
    const run = this.database.orm
      .select({ id: executionRuns.id, projectId: executionRuns.projectId })
      .from(executionRuns)
      .where(eq(executionRuns.id, assertId(value.runId)))
      .get();
    if (!run || run.projectId !== value.projectId)
      throw new RelationshipValidationError("Artifact run must belong to its project");
    try {
      this.database.orm.insert(runArtifacts).values(value).run();
      return this.getForProject(value.runId, value.projectId, value.id);
    } catch (error) {
      return translateError(error);
    }
  }

  getForProject(runId: string, projectId: string, artifactId: string): RunArtifact {
    const row = this.database.orm
      .select()
      .from(runArtifacts)
      .where(
        and(
          eq(runArtifacts.runId, assertId(runId)),
          eq(runArtifacts.projectId, assertId(projectId)),
          eq(runArtifacts.id, assertId(artifactId)),
        ),
      )
      .get();
    if (!row) throw new RepositoryNotFoundError("Run artifact", artifactId);
    return runArtifactSchema.parse(row);
  }

  listForProject(runId: string, projectId: string, input: PageRequest = {}): Page<RunArtifact> {
    const { limit, offset } = pageRequest(input);
    const condition = and(
      eq(runArtifacts.runId, assertId(runId)),
      eq(runArtifacts.projectId, assertId(projectId)),
    );
    const rows = this.database.orm
      .select()
      .from(runArtifacts)
      .where(condition)
      .orderBy(desc(runArtifacts.createdAt), desc(runArtifacts.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(runArtifacts).where(condition).get()
        ?.value ?? 0;
    return { items: rows.map((row) => runArtifactSchema.parse(row)), total, limit, offset };
  }

  totalBytes(runId: string, projectId: string): number {
    const result = this.database.orm
      .select({ value: sql<number>`coalesce(sum(${runArtifacts.byteSize}), 0)` })
      .from(runArtifacts)
      .where(
        and(
          eq(runArtifacts.runId, assertId(runId)),
          eq(runArtifacts.projectId, assertId(projectId)),
          isNotNull(runArtifacts.storageLocator),
        ),
      )
      .get();
    return Number(result?.value ?? 0);
  }

  listStorageLocators(): string[] {
    return this.database.orm
      .select({ locator: runArtifacts.storageLocator })
      .from(runArtifacts)
      .where(isNotNull(runArtifacts.storageLocator))
      .all()
      .flatMap((row) => (row.locator ? [row.locator] : []));
  }

  listExpired(before: string, input: PageRequest = {}): Page<RunArtifact> {
    const { limit, offset } = pageRequest(input);
    const condition = lt(runArtifacts.createdAt, before);
    const rows = this.database.orm
      .select()
      .from(runArtifacts)
      .where(condition)
      .orderBy(runArtifacts.createdAt, runArtifacts.id)
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(runArtifacts).where(condition).get()
        ?.value ?? 0;
    return { items: rows.map((row) => runArtifactSchema.parse(row)), total, limit, offset };
  }

  delete(id: string): RunArtifact | null {
    const row = this.database.orm
      .delete(runArtifacts)
      .where(eq(runArtifacts.id, assertId(id)))
      .returning()
      .get();
    return row ? runArtifactSchema.parse(row) : null;
  }
}

export class ApprovalRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  createOwned(
    input: CreateApproval,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): Approval {
    const value = approvalSchema.parse({ ...createApprovalSchema.parse(input), id });
    try {
      return this.database.sqlite
        .transaction(() => {
          assertSqliteLease(this.database, input.runId, identity, now);
          this.database.sqlite
            .prepare(
              "INSERT INTO approvals(id,run_id,action_type,action_description,requested_permissions,status,requested_at,resolved_at,resolved_by,principal_id,policy_version,expires_at,consumed_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              value.id,
              value.runId,
              value.actionType,
              value.actionDescription,
              JSON.stringify(value.requestedPermissions),
              value.status,
              value.requestedAt,
              value.resolvedAt,
              value.resolvedBy,
              value.principalId,
              value.policyVersion,
              value.expiresAt,
              value.consumedAt,
              value.revokedAt,
            );
          return this.getById(value.id);
        })
        .immediate();
    } catch (error) {
      return translateError(error);
    }
  }
  resolveOwned(
    id: string,
    status: "approved" | "rejected",
    resolvedBy: string,
    identity: RunLeaseIdentity,
    now: string,
  ): Approval {
    return this.database.sqlite
      .transaction(() => {
        const approval = this.getById(id);
        assertSqliteLease(this.database, approval.runId, identity, now);
        if (status === "approved")
          throw new RepositoryConflictError(
            "Approvals require the trusted server-side policy service",
          );
        const updated = this.database.sqlite
          .prepare(
            "UPDATE approvals SET status=?,resolved_at=?,resolved_by=? WHERE id=? AND status='pending'",
          )
          .run(status, this.database.now(), resolvedBy, id);
        if (updated.changes === 0)
          throw new RepositoryConflictError("Approval is already resolved");
        return this.getById(id);
      })
      .immediate();
  }
  create(input: CreateApproval, id = randomUUID()): Approval {
    const value = approvalSchema.parse({ ...createApprovalSchema.parse(input), id });
    if (
      value.status === "approved" &&
      (value.principalId === null ||
        value.policyVersion === null ||
        value.expiresAt === null ||
        value.resolvedBy !== value.principalId)
    )
      throw new RelationshipValidationError(
        "Approved grants must be bound to a principal and policy",
      );
    try {
      this.database.orm.insert(approvals).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }
  getById(id: string): Approval {
    const row = this.database.orm
      .select()
      .from(approvals)
      .where(eq(approvals.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Approval", id);
    return approvalSchema.parse(row);
  }
  list(runId: string, input: PageRequest = {}): Page<Approval> {
    const { limit, offset } = pageRequest(input);
    const condition = eq(approvals.runId, assertId(runId));
    const rows = this.database.orm
      .select()
      .from(approvals)
      .where(condition)
      .orderBy(desc(approvals.requestedAt), desc(approvals.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(approvals).where(condition).get()?.value ??
      0;
    return { items: rows.map((row) => approvalSchema.parse(row)), total, limit, offset };
  }
  resolve(id: string, status: "approved" | "rejected", resolvedBy: string): Approval {
    if (status === "approved")
      throw new RepositoryConflictError("Approvals require the trusted server-side policy service");
    const current = this.getById(id);
    if (current.status !== "pending")
      throw new RepositoryConflictError("Approval has already been resolved");
    const value = approvalSchema.parse({
      ...current,
      status,
      resolvedBy,
      resolvedAt: this.database.now(),
    });
    const result = this.database.orm
      .update(approvals)
      .set({ status, resolvedBy: value.resolvedBy, resolvedAt: value.resolvedAt })
      .where(and(eq(approvals.id, current.id), eq(approvals.status, "pending")))
      .run();
    if (result.changes === 0)
      throw new RepositoryConflictError("Approval has already been resolved");
    return this.getById(id);
  }
  consumeWithEvent(
    input: {
      id: string;
      runId: string;
      principalId: string;
      actionType: string;
      policyVersion: string;
      at: string;
    },
    event: Extract<CreateAgentEvent, { type: "approval.consumed" }>,
    isCancelled?: () => boolean,
  ): Approval {
    const base = createAgentEventSchema.parse(redactEventSecrets(event));
    if (
      base.type !== "approval.consumed" ||
      base.runId !== input.runId ||
      base.data.approvalId !== input.id ||
      base.data.principalId !== input.principalId ||
      base.data.actionType !== input.actionType ||
      base.data.policyVersion !== input.policyVersion
    )
      throw new RelationshipValidationError("Consumption audit event must match its run");
    try {
      return this.database.orm.transaction((tx) => {
        assertNotCancelled(isCancelled);
        const updated = tx
          .update(approvals)
          .set({ consumedAt: input.at })
          .where(
            and(
              eq(approvals.id, assertId(input.id)),
              eq(approvals.runId, assertId(input.runId)),
              eq(approvals.principalId, input.principalId),
              eq(approvals.resolvedBy, input.principalId),
              eq(approvals.actionType, input.actionType),
              eq(approvals.policyVersion, input.policyVersion),
              eq(approvals.status, "approved"),
              gt(approvals.expiresAt, input.at),
              isNull(approvals.consumedAt),
              isNull(approvals.revokedAt),
            ),
          )
          .returning()
          .get();
        if (!updated)
          throw new RepositoryConflictError(
            "Approval is invalid, expired, revoked, or already consumed",
          );
        assertNotCancelled(isCancelled);
        const sequence =
          tx
            .select({ value: max(agentEvents.sequence) })
            .from(agentEvents)
            .where(eq(agentEvents.runId, input.runId))
            .get()?.value ?? 0;
        const normalized = agentEventSchema.parse({
          ...base,
          id: randomUUID(),
          sequence: sequence + 1,
        });
        tx.insert(agentEvents).values(normalized).run();
        assertNotCancelled(isCancelled);
        return approvalSchema.parse(updated);
      });
    } catch (error) {
      return translateError(error);
    }
  }
  revoke(id: string, principalId: string, at: string): Approval {
    const result = this.database.orm
      .update(approvals)
      .set({ revokedAt: at })
      .where(
        and(
          eq(approvals.id, assertId(id)),
          eq(approvals.principalId, principalId),
          eq(approvals.status, "approved"),
          isNull(approvals.consumedAt),
          isNull(approvals.revokedAt),
        ),
      )
      .run();
    if (result.changes === 0)
      throw new RepositoryConflictError("Approval cannot be revoked by this principal");
    return this.getById(id);
  }
}

function assertNotCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new RepositoryConflictError("Authorization was cancelled");
}

export class EvaluationRepository {
  constructor(private readonly database: AgentOsDatabase) {}
  create(input: CreateEvaluation, id = randomUUID()): Evaluation {
    const value = evaluationSchema.parse({
      ...createEvaluationSchema.parse(input),
      id,
      createdAt: this.database.now(),
    });
    try {
      this.database.orm.insert(evaluations).values(value).run();
      return this.getById(value.id);
    } catch (error) {
      return translateError(error);
    }
  }
  getById(id: string): Evaluation {
    const row = this.database.orm
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, assertId(id)))
      .get();
    if (!row) throw new RepositoryNotFoundError("Evaluation", id);
    return evaluationSchema.parse(row);
  }
  list(runId: string, input: PageRequest = {}): Page<Evaluation> {
    const { limit, offset } = pageRequest(input);
    const condition = eq(evaluations.runId, assertId(runId));
    const rows = this.database.orm
      .select()
      .from(evaluations)
      .where(condition)
      .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total =
      this.database.orm.select({ value: count() }).from(evaluations).where(condition).get()
        ?.value ?? 0;
    return { items: rows.map((row) => evaluationSchema.parse(row)), total, limit, offset };
  }
}

export class Repositories implements RepositorySet {
  readonly auth: SqliteAuthenticationRepository;
  readonly projects: ProjectRepository;
  readonly agents: AgentRepository;
  readonly providers: ProviderRepository;
  readonly tasks: TaskRepository;
  readonly runs: ExecutionRunRepository;
  readonly leases: RunLeaseRepository;
  readonly manifests: RunManifestRepository;
  readonly artifacts: RunArtifactRepository;
  readonly events: AgentEventRepository;
  readonly approvals: ApprovalRepository;
  readonly evaluations: EvaluationRepository;

  constructor(database: AgentOsDatabase) {
    this.auth = new SqliteAuthenticationRepository(database);
    this.projects = new ProjectRepository(database);
    this.agents = new AgentRepository(database);
    this.providers = new ProviderRepository(database);
    this.tasks = new TaskRepository(database);
    this.runs = new ExecutionRunRepository(database);
    this.leases = new RunLeaseRepository(database);
    this.manifests = new RunManifestRepository(database);
    this.artifacts = new RunArtifactRepository(database);
    this.events = new AgentEventRepository(database);
    this.approvals = new ApprovalRepository(database);
    this.evaluations = new EvaluationRepository(database);
  }
}
