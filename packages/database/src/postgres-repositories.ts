import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, ilike, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type {
  Agent,
  AgentEvent,
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
  Task,
  RepositorySet,
  EventFilter,
  Page,
  PageRequest,
  ProjectFilter,
  RunFilter,
  TaskFilter,
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
  createRunArtifactSchema,
  createTaskSchema,
  evaluationSchema,
  executionRunSchema,
  projectSchema,
  providerSchema,
  redactEventSecrets,
  runManifestSchema,
  runArtifactSchema,
  taskSchema,
  transitionRun,
  workerLeaseSchema,
} from "@agentos/core";
import type { AgentOsPostgresDatabase } from "./postgres-database.js";
import {
  pgAgentEvents,
  pgAgents,
  pgApprovals,
  pgEvaluations,
  pgExecutionRuns,
  pgProjects,
  pgProviders,
  pgRunEventCounters,
  pgRunManifests,
  pgRunArtifacts,
  pgRunLeases,
  pgTasks,
} from "./postgres-schema.js";
import {
  assertId,
  pageRequest,
  RelationshipValidationError,
  RepositoryConflictError,
  RepositoryNotFoundError,
  translateError,
} from "./repository-common.js";

async function withPostgresLease<T>(
  database: AgentOsPostgresDatabase,
  runId: string,
  identity: RunLeaseIdentity,
  now: string,
  operation: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    const result = await client.query<{
      worker_id: string;
      generation: string;
      expires_at: Date | string;
      released_at: Date | null;
    }>(
      "SELECT worker_id,generation,expires_at,released_at FROM run_leases WHERE run_id=$1 FOR UPDATE",
      [runId],
    );
    const lease = result.rows[0];
    const expiry =
      lease?.expires_at instanceof Date
        ? lease.expires_at.getTime()
        : new Date(String(lease?.expires_at)).getTime();
    if (
      !lease ||
      lease.worker_id !== identity.workerId ||
      Number(lease.generation) !== identity.generation ||
      lease.released_at !== null ||
      expiry <= new Date(now).getTime()
    )
      throw new RepositoryConflictError("Worker lease is stale or no longer owns this run");
    return operation(client);
  });
}

function assertNotCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new RepositoryConflictError("Authorization was cancelled");
}

function one<T>(rows: T[], entity: string, id: string): T {
  const row = rows[0];
  if (!row) throw new RepositoryNotFoundError(entity, id);
  return normalizeTimestamps(row);
}

/** PostgreSQL drivers may return timestamptz strings with offsets other than Z. */
function normalizeTimestamps<T>(value: T): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...(value as Record<string, unknown>) };
  for (const [key, field] of Object.entries(normalized)) {
    if (key.endsWith("At") && (typeof field === "string" || field instanceof Date)) {
      const date = field instanceof Date ? field : new Date(field);
      if (!Number.isNaN(date.valueOf())) normalized[key] = date.toISOString();
    }
  }
  return normalized as T;
}

function pgExecutionRun(row: Record<string, unknown>): ExecutionRun {
  const iso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  return executionRunSchema.parse({
    id: row["id"],
    taskId: row["task_id"],
    projectId: row["project_id"],
    agentId: row["agent_id"],
    adapterVersion: row["adapter_version"],
    providerId: row["provider_id"],
    modelId: row["model_id"],
    status: row["status"],
    manifestId: row["manifest_id"],
    workspaceId: row["workspace_id"],
    startedAt: row["started_at"] === null ? null : iso(row["started_at"]),
    completedAt: row["completed_at"] === null ? null : iso(row["completed_at"]),
    error: row["error"],
    usageMetrics: row["usage_metrics"],
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  });
}

function page<T>(items: T[], total: number, input: PageRequest): Page<T> {
  const { limit, offset } = pageRequest(input);
  return { items, total, limit, offset };
}

export class PostgresProjectRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async create(input: CreateProject, id = randomUUID()): Promise<Project> {
    const now = this.database.now();
    const value = projectSchema.parse({
      ...createProjectSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    try {
      return projectSchema.parse(
        one(await this.database.orm.insert(pgProjects).values(value).returning(), "Project", id),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<Project> {
    const rows = await this.database.orm
      .select()
      .from(pgProjects)
      .where(eq(pgProjects.id, assertId(id)))
      .limit(1);
    return projectSchema.parse(one(rows, "Project", id));
  }
  async list(filter: ProjectFilter = {}): Promise<Page<Project>> {
    const { limit, offset } = pageRequest(filter);
    const condition = filter.nameContains
      ? ilike(pgProjects.name, `%${filter.nameContains}%`)
      : undefined;
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgProjects)
        .where(condition)
        .orderBy(desc(pgProjects.createdAt), desc(pgProjects.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgProjects).where(condition),
    ]);
    return page(
      rows.map((row) => projectSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      filter,
    );
  }
  async update(
    id: string,
    patch: Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Project> {
    const current = await this.getById(id);
    const value = projectSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    try {
      const rows = await this.database.orm
        .update(pgProjects)
        .set(value)
        .where(eq(pgProjects.id, current.id))
        .returning();
      return projectSchema.parse(one(rows, "Project", id));
    } catch (error) {
      return translateError(error);
    }
  }
  async delete(id: string): Promise<boolean> {
    try {
      return (
        (
          await this.database.orm
            .delete(pgProjects)
            .where(eq(pgProjects.id, assertId(id)))
            .returning({ id: pgProjects.id })
        ).length > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class PostgresAgentRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async create(input: CreateAgent, id = randomUUID()): Promise<Agent> {
    const now = this.database.now();
    const value = agentSchema.parse({
      ...createAgentSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    try {
      return agentSchema.parse(
        one(await this.database.orm.insert(pgAgents).values(value).returning(), "Agent", id),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<Agent> {
    const rows = await this.database.orm
      .select()
      .from(pgAgents)
      .where(eq(pgAgents.id, assertId(id)))
      .limit(1);
    return agentSchema.parse(one(rows, "Agent", id));
  }
  async list(input: PageRequest = {}): Promise<Page<Agent>> {
    const { limit, offset } = pageRequest(input);
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgAgents)
        .orderBy(desc(pgAgents.createdAt), desc(pgAgents.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgAgents),
    ]);
    return page(
      rows.map((row) => agentSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }
  async update(
    id: string,
    patch: Partial<Omit<Agent, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Agent> {
    const current = await this.getById(id);
    const value = agentSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    try {
      const rows = await this.database.orm
        .update(pgAgents)
        .set(value)
        .where(eq(pgAgents.id, current.id))
        .returning();
      return agentSchema.parse(one(rows, "Agent", id));
    } catch (error) {
      return translateError(error);
    }
  }
  async delete(id: string): Promise<boolean> {
    try {
      return (
        (
          await this.database.orm
            .delete(pgAgents)
            .where(eq(pgAgents.id, assertId(id)))
            .returning({ id: pgAgents.id })
        ).length > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class PostgresProviderRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async create(input: CreateProvider, id = randomUUID()): Promise<Provider> {
    const now = this.database.now();
    const value = providerSchema.parse({
      ...createProviderSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    try {
      return providerSchema.parse(
        one(await this.database.orm.insert(pgProviders).values(value).returning(), "Provider", id),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<Provider> {
    const rows = await this.database.orm
      .select()
      .from(pgProviders)
      .where(eq(pgProviders.id, assertId(id)))
      .limit(1);
    return providerSchema.parse(one(rows, "Provider", id));
  }
  async list(input: PageRequest = {}): Promise<Page<Provider>> {
    const { limit, offset } = pageRequest(input);
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgProviders)
        .orderBy(desc(pgProviders.createdAt), desc(pgProviders.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgProviders),
    ]);
    return page(
      rows.map((row) => providerSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }
  async update(
    id: string,
    patch: Partial<Omit<Provider, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Provider> {
    const current = await this.getById(id);
    const value = providerSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    try {
      const rows = await this.database.orm
        .update(pgProviders)
        .set(value)
        .where(eq(pgProviders.id, current.id))
        .returning();
      return providerSchema.parse(one(rows, "Provider", id));
    } catch (error) {
      return translateError(error);
    }
  }
  async delete(id: string): Promise<boolean> {
    try {
      return (
        (
          await this.database.orm
            .delete(pgProviders)
            .where(eq(pgProviders.id, assertId(id)))
            .returning({ id: pgProviders.id })
        ).length > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class PostgresTaskRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async create(input: CreateTask, id = randomUUID()): Promise<Task> {
    const value = taskSchema.parse({
      ...createTaskSchema.parse(input),
      id,
      createdAt: this.database.now(),
      updatedAt: this.database.now(),
    });
    if (
      !(
        await this.database.orm
          .select({ id: pgProjects.id })
          .from(pgProjects)
          .where(eq(pgProjects.id, value.projectId))
          .limit(1)
      ).length
    )
      throw new RelationshipValidationError("Task project does not exist");
    if (
      value.assignedAgentId &&
      !(
        await this.database.orm
          .select({ id: pgAgents.id })
          .from(pgAgents)
          .where(eq(pgAgents.id, value.assignedAgentId))
          .limit(1)
      ).length
    )
      throw new RelationshipValidationError("Assigned agent does not exist");
    try {
      return taskSchema.parse(
        one(await this.database.orm.insert(pgTasks).values(value).returning(), "Task", id),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<Task> {
    const rows = await this.database.orm
      .select()
      .from(pgTasks)
      .where(eq(pgTasks.id, assertId(id)))
      .limit(1);
    return taskSchema.parse(one(rows, "Task", id));
  }
  async list(filter: TaskFilter = {}): Promise<Page<Task>> {
    const { limit, offset } = pageRequest(filter);
    const conditions = [];
    if (filter.projectId) conditions.push(eq(pgTasks.projectId, assertId(filter.projectId)));
    if (filter.status) conditions.push(eq(pgTasks.status, filter.status));
    const condition = conditions.length ? and(...conditions) : undefined;
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgTasks)
        .where(condition)
        .orderBy(desc(pgTasks.createdAt), desc(pgTasks.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgTasks).where(condition),
    ]);
    return page(
      rows.map((row) => taskSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      filter,
    );
  }
  async update(
    id: string,
    patch: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Task> {
    const current = await this.getById(id);
    const value = taskSchema.parse({ ...current, ...patch, updatedAt: this.database.now() });
    if (
      !(
        await this.database.orm
          .select({ id: pgProjects.id })
          .from(pgProjects)
          .where(eq(pgProjects.id, value.projectId))
          .limit(1)
      ).length
    )
      throw new RelationshipValidationError("Task project does not exist");
    if (
      value.assignedAgentId &&
      !(
        await this.database.orm
          .select({ id: pgAgents.id })
          .from(pgAgents)
          .where(eq(pgAgents.id, value.assignedAgentId))
          .limit(1)
      ).length
    )
      throw new RelationshipValidationError("Assigned agent does not exist");
    try {
      const rows = await this.database.orm
        .update(pgTasks)
        .set(value)
        .where(eq(pgTasks.id, current.id))
        .returning();
      return taskSchema.parse(one(rows, "Task", id));
    } catch (error) {
      return translateError(error);
    }
  }
  async delete(id: string): Promise<boolean> {
    try {
      return (
        (
          await this.database.orm
            .delete(pgTasks)
            .where(eq(pgTasks.id, assertId(id)))
            .returning({ id: pgTasks.id })
        ).length > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class PostgresExecutionRunRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
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
    return this.database.orm.transaction(async (tx) => {
      const task = (
        await tx.select().from(pgTasks).where(eq(pgTasks.id, value.taskId)).limit(1)
      )[0];
      if (!task || task.projectId !== value.projectId)
        throw new RelationshipValidationError("Run task must belong to its project");
      if (task.assignedAgentId && task.assignedAgentId !== value.agentId)
        throw new RelationshipValidationError("Run agent differs from the task assignment");
      await tx.insert(pgExecutionRuns).values(value);
      await tx.insert(pgRunLeases).values({
        runId: id,
        workerId,
        generation: 1,
        claimedAt,
        heartbeatAt: claimedAt,
        expiresAt,
        releasedAt: null,
      });
      return {
        run: value,
        lease: workerLeaseSchema.parse({
          runId: id,
          workerId,
          generation: 1,
          claimedAt,
          heartbeatAt: claimedAt,
          expiresAt,
          releasedAt: null,
        }),
      };
    });
  }
  async updateOwned(
    id: string,
    patch: Partial<Omit<ExecutionRun, "id" | "createdAt" | "updatedAt">>,
    identity: RunLeaseIdentity,
    now: string,
  ): Promise<ExecutionRun> {
    await withPostgresLease(this.database, id, identity, now, async (client) => {
      const selected = await client.query<Record<string, unknown>>(
        "SELECT * FROM execution_runs WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!selected.rows[0]) throw new RepositoryNotFoundError("Execution run", id);
      const current = pgExecutionRun(selected.rows[0]);
      const value = executionRunSchema.parse({ ...current, ...patch, updatedAt: now });
      if (value.status !== current.status) transitionRun(current.status, value.status);
      if (value.manifestId !== current.manifestId)
        throw new RelationshipValidationError(
          "Only the manifest repository can link a run manifest",
        );
      if (
        current.manifestId !== null &&
        (value.taskId !== current.taskId ||
          value.projectId !== current.projectId ||
          value.agentId !== current.agentId ||
          value.adapterVersion !== current.adapterVersion ||
          value.providerId !== current.providerId ||
          value.modelId !== current.modelId)
      )
        throw new RelationshipValidationError(
          "Run identity cannot change after its manifest is stored",
        );
      await client.query(
        `UPDATE execution_runs SET task_id=$1,project_id=$2,agent_id=$3,adapter_version=$4,provider_id=$5,model_id=$6,status=$7,manifest_id=$8,workspace_id=$9,started_at=$10,completed_at=$11,error=$12,usage_metrics=$13,updated_at=$14 WHERE id=$15 AND status=$16`,
        [
          value.taskId,
          value.projectId,
          value.agentId,
          value.adapterVersion,
          value.providerId,
          value.modelId,
          value.status,
          value.manifestId,
          value.workspaceId,
          value.startedAt,
          value.completedAt,
          value.error,
          JSON.stringify(value.usageMetrics),
          value.updatedAt,
          id,
          current.status,
        ],
      );
    });
    return this.getById(id);
  }
  async create(input: CreateExecutionRun, id = randomUUID()): Promise<ExecutionRun> {
    const now = this.database.now();
    const value = executionRunSchema.parse({
      ...createExecutionRunSchema.parse(input),
      id,
      createdAt: now,
      updatedAt: now,
    });
    if (value.status !== "created")
      throw new RelationshipValidationError("New runs must begin in the created state");
    const task = (
      await this.database.orm.select().from(pgTasks).where(eq(pgTasks.id, value.taskId)).limit(1)
    )[0];
    if (!task || task.projectId !== value.projectId)
      throw new RelationshipValidationError("Run task must belong to its project");
    if (task.assignedAgentId && task.assignedAgentId !== value.agentId)
      throw new RelationshipValidationError("Run agent differs from the task assignment");
    if (value.manifestId !== null)
      throw new RelationshipValidationError(
        "Create a run without manifestId, then persist its manifest",
      );
    try {
      return executionRunSchema.parse(
        one(
          await this.database.orm.insert(pgExecutionRuns).values(value).returning(),
          "Execution run",
          id,
        ),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<ExecutionRun> {
    const rows = await this.database.orm
      .select()
      .from(pgExecutionRuns)
      .where(eq(pgExecutionRuns.id, assertId(id)))
      .limit(1);
    return executionRunSchema.parse(one(rows, "Execution run", id));
  }
  async list(filter: RunFilter = {}): Promise<Page<ExecutionRun>> {
    const { limit, offset } = pageRequest(filter);
    const conditions = [];
    if (filter.projectId)
      conditions.push(eq(pgExecutionRuns.projectId, assertId(filter.projectId)));
    if (filter.taskId) conditions.push(eq(pgExecutionRuns.taskId, assertId(filter.taskId)));
    if (filter.status) conditions.push(eq(pgExecutionRuns.status, filter.status));
    const condition = conditions.length ? and(...conditions) : undefined;
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgExecutionRuns)
        .where(condition)
        .orderBy(desc(pgExecutionRuns.createdAt), desc(pgExecutionRuns.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgExecutionRuns).where(condition),
    ]);
    return page(
      rows.map((row) => executionRunSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      filter,
    );
  }
  async update(
    id: string,
    patch: Partial<Omit<ExecutionRun, "id" | "createdAt" | "updatedAt">>,
  ): Promise<ExecutionRun> {
    const current = await this.getById(id);
    const value = executionRunSchema.parse({
      ...current,
      ...patch,
      updatedAt: this.database.now(),
    });
    if (value.status !== current.status) transitionRun(current.status, value.status);
    if (value.manifestId !== current.manifestId)
      throw new RelationshipValidationError("Only the manifest repository can link a run manifest");
    if (
      current.manifestId !== null &&
      (value.taskId !== current.taskId ||
        value.projectId !== current.projectId ||
        value.agentId !== current.agentId ||
        value.adapterVersion !== current.adapterVersion ||
        value.providerId !== current.providerId ||
        value.modelId !== current.modelId)
    )
      throw new RelationshipValidationError(
        "Run identity cannot change after its manifest is stored",
      );
    const task = (
      await this.database.orm.select().from(pgTasks).where(eq(pgTasks.id, value.taskId)).limit(1)
    )[0];
    if (!task || task.projectId !== value.projectId)
      throw new RelationshipValidationError("Run task must belong to its project");
    if (task.assignedAgentId && task.assignedAgentId !== value.agentId)
      throw new RelationshipValidationError("Run agent differs from the task assignment");
    try {
      const rows = await this.database.orm
        .update(pgExecutionRuns)
        .set(value)
        .where(and(eq(pgExecutionRuns.id, current.id), eq(pgExecutionRuns.status, current.status)))
        .returning();
      if (!rows.length)
        throw new RepositoryConflictError("Run changed during update; reload and retry");
      return executionRunSchema.parse(normalizeTimestamps(rows[0]));
    } catch (error) {
      return translateError(error);
    }
  }
  async delete(id: string): Promise<boolean> {
    try {
      return (
        (
          await this.database.orm
            .delete(pgExecutionRuns)
            .where(eq(pgExecutionRuns.id, assertId(id)))
            .returning({ id: pgExecutionRuns.id })
        ).length > 0
      );
    } catch (error) {
      return translateError(error);
    }
  }
}

export class PostgresRunLeaseRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async claim(
    runId: string,
    workerId: string,
    now: string,
    expiresAt: string,
  ): Promise<LeaseClaim | null> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT id FROM execution_runs WHERE id=$1 FOR UPDATE", [runId]);
      const selected = await client.query<Record<string, unknown>>(
        "SELECT * FROM run_leases WHERE run_id=$1 FOR UPDATE",
        [runId],
      );
      const prior = selected.rows[0];
      if (
        prior &&
        prior["released_at"] === null &&
        new Date(prior["expires_at"] as string).getTime() > new Date(now).getTime()
      )
        return null;
      const previousGeneration = prior ? Number(prior["generation"]) : null;
      const generation = (previousGeneration ?? 0) + 1;
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO run_leases(run_id,worker_id,generation,claimed_at,heartbeat_at,expires_at,released_at)
        VALUES($1,$2,$3,$4,$4,$5,NULL) ON CONFLICT(run_id) DO UPDATE SET worker_id=excluded.worker_id,
        generation=excluded.generation,claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,
        expires_at=excluded.expires_at,released_at=NULL RETURNING *`,
        [runId, workerId, generation, now, expiresAt],
      );
      return { lease: pgLease(result.rows[0]!), previousGeneration };
    });
  }
  async renew(
    runId: string,
    identity: RunLeaseIdentity,
    now: string,
    expiresAt: string,
  ): Promise<WorkerLease | null> {
    const result = await this.database.pool.query<Record<string, unknown>>(
      `UPDATE run_leases SET heartbeat_at=$1,expires_at=$2 WHERE run_id=$3 AND worker_id=$4 AND generation=$5 AND released_at IS NULL AND expires_at>$1 RETURNING *`,
      [now, expiresAt, runId, identity.workerId, identity.generation],
    );
    return result.rows[0] ? pgLease(result.rows[0]) : null;
  }
  async release(runId: string, identity: RunLeaseIdentity, at: string): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE run_leases SET released_at=$1 WHERE run_id=$2 AND worker_id=$3 AND generation=$4 AND released_at IS NULL`,
      [at, runId, identity.workerId, identity.generation],
    );
    return (result.rowCount ?? 0) > 0;
  }
  async getByRunId(runId: string): Promise<WorkerLease | null> {
    const result = await this.database.pool.query<Record<string, unknown>>(
      "SELECT * FROM run_leases WHERE run_id=$1",
      [runId],
    );
    return result.rows[0] ? pgLease(result.rows[0]) : null;
  }
  async listExpired(now: string, input: PageRequest = {}): Promise<Page<WorkerLease>> {
    const { limit, offset } = pageRequest(input);
    const [rows, total] = await Promise.all([
      this.database.pool.query<Record<string, unknown>>(
        "SELECT * FROM run_leases WHERE released_at IS NOT NULL OR expires_at <= $1 ORDER BY expires_at,run_id LIMIT $2 OFFSET $3",
        [now, limit, offset],
      ),
      this.database.pool.query<{ count: string }>(
        "SELECT count(*) FROM run_leases WHERE released_at IS NOT NULL OR expires_at <= $1",
        [now],
      ),
    ]);
    return {
      items: rows.rows.map(pgLease),
      total: Number(total.rows[0]?.count ?? 0),
      limit,
      offset,
    };
  }
}

function pgLease(row: Record<string, unknown>): WorkerLease {
  const asIso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  return workerLeaseSchema.parse({
    runId: row["run_id"],
    workerId: row["worker_id"],
    generation: Number(row["generation"]),
    claimedAt: asIso(row["claimed_at"]),
    heartbeatAt: asIso(row["heartbeat_at"]),
    expiresAt: asIso(row["expires_at"]),
    releasedAt: row["released_at"] === null ? null : asIso(row["released_at"]),
  });
}

export class PostgresRunManifestRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async createOwned(
    input: CreateRunManifest,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): Promise<RunManifest> {
    const value = runManifestSchema.parse({
      ...createRunManifestSchema.parse(input),
      id,
      createdAt: now,
    });
    await withPostgresLease(this.database, input.runId, identity, now, async (client) => {
      const run = await client.query<{
        agent_id: string;
        provider_id: string | null;
        manifest_id: string | null;
      }>("SELECT agent_id,provider_id,manifest_id FROM execution_runs WHERE id=$1 FOR UPDATE", [
        input.runId,
      ]);
      const row = run.rows[0];
      if (
        !row ||
        row.agent_id !== input.agentId ||
        row.provider_id !== input.providerId ||
        row.manifest_id !== null
      )
        throw new RelationshipValidationError("Manifest identities must match an unmanifested run");
      await client.query(
        `INSERT INTO run_manifests(id,version,run_id,agent_id,agent_name,adapter_id,adapter_version,provider_id,model_id,prompt_configuration_hash,repository_commit_sha,tool_versions,skill_versions,runtime_configuration,permission_configuration,environment_variable_names,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17)`,
        [
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
        ],
      );
      await client.query(
        "UPDATE execution_runs SET manifest_id=$1,updated_at=$2 WHERE id=$3 AND manifest_id IS NULL",
        [value.id, now, value.runId],
      );
    });
    return this.getByRunId(input.runId);
  }
  async create(input: CreateRunManifest, id = randomUUID()): Promise<RunManifest> {
    const value = runManifestSchema.parse({
      ...createRunManifestSchema.parse(input),
      id,
      createdAt: this.database.now(),
    });
    const run = (
      await this.database.orm
        .select()
        .from(pgExecutionRuns)
        .where(eq(pgExecutionRuns.id, value.runId))
        .limit(1)
    )[0];
    if (!run) throw new RelationshipValidationError("Manifest run does not exist");
    if (run.agentId !== value.agentId || run.providerId !== value.providerId)
      throw new RelationshipValidationError("Manifest identities must match the run");
    try {
      await this.database.orm.transaction(async (tx) => {
        await tx.insert(pgRunManifests).values(value);
        const updated = await tx
          .update(pgExecutionRuns)
          .set({ manifestId: value.id, updatedAt: this.database.now() })
          .where(eq(pgExecutionRuns.id, value.runId))
          .returning({ id: pgExecutionRuns.id });
        if (!updated.length) throw new RepositoryNotFoundError("Execution run", value.runId);
      });
      return this.getByRunId(value.runId);
    } catch (error) {
      return translateError(error);
    }
  }
  async getByRunId(runId: string): Promise<RunManifest> {
    const rows = await this.database.orm
      .select()
      .from(pgRunManifests)
      .where(eq(pgRunManifests.runId, assertId(runId)))
      .limit(1);
    return runManifestSchema.parse(one(rows, "Run manifest", runId));
  }
  async list(input: PageRequest = {}): Promise<Page<RunManifest>> {
    const { limit, offset } = pageRequest(input);
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgRunManifests)
        .orderBy(desc(pgRunManifests.createdAt), desc(pgRunManifests.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgRunManifests),
    ]);
    return page(
      rows.map((row) => runManifestSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }
}

export class PostgresRunArtifactRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async createOwned(
    input: CreateRunArtifact,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): Promise<RunArtifact> {
    const value = runArtifactSchema.parse({
      ...createRunArtifactSchema.parse(input),
      id,
      createdAt: now,
    });
    try {
      return await withPostgresLease(this.database, input.runId, identity, now, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          "INSERT INTO run_artifacts(id,run_id,project_id,artifact_type,logical_name,content_type,byte_size,sha256,created_at,storage_locator,collection_status,collection_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
          [
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
          ],
        );
        return runArtifactSchema.parse(normalizeTimestamps(result.rows[0]));
      });
    } catch (error) {
      return translateError(error);
    }
  }

  async create(input: CreateRunArtifact, id = randomUUID()): Promise<RunArtifact> {
    const value = runArtifactSchema.parse({
      ...createRunArtifactSchema.parse(input),
      id,
      createdAt: this.database.now(),
    });
    const run = await this.database.orm
      .select({ id: pgExecutionRuns.id, projectId: pgExecutionRuns.projectId })
      .from(pgExecutionRuns)
      .where(eq(pgExecutionRuns.id, assertId(value.runId)))
      .limit(1);
    if (!run[0] || run[0].projectId !== value.projectId)
      throw new RelationshipValidationError("Artifact run must belong to its project");
    try {
      await this.database.orm.insert(pgRunArtifacts).values(value);
      return this.getForProject(value.runId, value.projectId, value.id);
    } catch (error) {
      return translateError(error);
    }
  }

  async getForProject(runId: string, projectId: string, artifactId: string): Promise<RunArtifact> {
    const rows = await this.database.orm
      .select()
      .from(pgRunArtifacts)
      .where(
        and(
          eq(pgRunArtifacts.runId, assertId(runId)),
          eq(pgRunArtifacts.projectId, assertId(projectId)),
          eq(pgRunArtifacts.id, assertId(artifactId)),
        ),
      )
      .limit(1);
    return runArtifactSchema.parse(one(rows, "Run artifact", artifactId));
  }

  async listForProject(
    runId: string,
    projectId: string,
    input: PageRequest = {},
  ): Promise<Page<RunArtifact>> {
    const { limit, offset } = pageRequest(input);
    const condition = and(
      eq(pgRunArtifacts.runId, assertId(runId)),
      eq(pgRunArtifacts.projectId, assertId(projectId)),
    );
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgRunArtifacts)
        .where(condition)
        .orderBy(desc(pgRunArtifacts.createdAt), desc(pgRunArtifacts.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgRunArtifacts).where(condition),
    ]);
    return page(
      rows.map((row) => runArtifactSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }

  async totalBytes(runId: string, projectId: string): Promise<number> {
    const rows = await this.database.orm
      .select({ value: sql<number>`coalesce(sum(${pgRunArtifacts.byteSize}), 0)::float8` })
      .from(pgRunArtifacts)
      .where(
        and(
          eq(pgRunArtifacts.runId, assertId(runId)),
          eq(pgRunArtifacts.projectId, assertId(projectId)),
          isNotNull(pgRunArtifacts.storageLocator),
        ),
      );
    return Number(rows[0]?.value ?? 0);
  }

  async listStorageLocators(): Promise<string[]> {
    const rows = await this.database.orm
      .select({ locator: pgRunArtifacts.storageLocator })
      .from(pgRunArtifacts)
      .where(isNotNull(pgRunArtifacts.storageLocator));
    return rows.flatMap((row) => (row.locator ? [row.locator] : []));
  }

  async listExpired(before: string, input: PageRequest = {}): Promise<Page<RunArtifact>> {
    const { limit, offset } = pageRequest(input);
    const condition = lt(pgRunArtifacts.createdAt, before);
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgRunArtifacts)
        .where(condition)
        .orderBy(pgRunArtifacts.createdAt, pgRunArtifacts.id)
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgRunArtifacts).where(condition),
    ]);
    return page(
      rows.map((row) => runArtifactSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }

  async delete(id: string): Promise<RunArtifact | null> {
    const rows = await this.database.orm
      .delete(pgRunArtifacts)
      .where(eq(pgRunArtifacts.id, assertId(id)))
      .returning();
    return rows[0] ? runArtifactSchema.parse(normalizeTimestamps(rows[0])) : null;
  }
}

export class PostgresAgentEventRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async appendOwned(
    input: CreateAgentEvent,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): Promise<AgentEvent> {
    const base = createAgentEventSchema.parse(redactEventSecrets(input));
    try {
      return await withPostgresLease(this.database, input.runId, identity, now, async (client) => {
        const prior = await client.query<Record<string, unknown>>(
          "SELECT id,run_id,sequence,type,occurred_at,data FROM agent_events WHERE id=$1",
          [id],
        );
        if (prior.rows[0]) {
          const row = prior.rows[0];
          if (row["run_id"] !== input.runId)
            throw new RepositoryConflictError("Event identifier is already bound to another run");
          return agentEventSchema.parse({
            ...normalizeTimestamps(row),
            runId: row["run_id"],
            occurredAt: normalizeTimestamps(row)["occurred_at"],
            data: row["data"],
          });
        }
        const [counter] = (
          await client.query<{ last_sequence: number }>(
            `INSERT INTO run_event_counters(run_id,last_sequence) VALUES($1,1) ON CONFLICT(run_id) DO UPDATE SET last_sequence=run_event_counters.last_sequence+1 RETURNING last_sequence`,
            [base.runId],
          )
        ).rows;
        if (!counter) throw new Error("Could not allocate event sequence");
        const event = agentEventSchema.parse({ ...base, id, sequence: counter.last_sequence });
        const inserted = await client.query(
          "INSERT INTO agent_events(id,run_id,sequence,type,occurred_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id",
          [
            event.id,
            event.runId,
            event.sequence,
            event.type,
            event.occurredAt,
            JSON.stringify(event.data),
          ],
        );
        if (!inserted.rows.length) {
          const existing = await client.query<Record<string, unknown>>(
            "SELECT id,run_id,sequence,type,occurred_at,data FROM agent_events WHERE id=$1",
            [id],
          );
          const row = existing.rows[0];
          if (!row || row["run_id"] !== input.runId)
            throw new RepositoryConflictError("Event identifier is already bound to another run");
          return agentEventSchema.parse({
            ...normalizeTimestamps(row),
            runId: row["run_id"],
            occurredAt: normalizeTimestamps(row)["occurred_at"],
            data: row["data"],
          });
        }
        return event;
      });
    } catch (error) {
      return translateError(error);
    }
  }
  async append(input: CreateAgentEvent, id = randomUUID()): Promise<AgentEvent> {
    const base = createAgentEventSchema.parse(redactEventSecrets(input));
    try {
      return await this.database.orm.transaction(async (tx) => {
        const existing = await tx
          .select({ id: pgExecutionRuns.id })
          .from(pgExecutionRuns)
          .where(eq(pgExecutionRuns.id, base.runId))
          .limit(1);
        if (!existing.length) throw new RelationshipValidationError("Event run does not exist");
        const [counter] = await tx
          .insert(pgRunEventCounters)
          .values({ runId: base.runId, lastSequence: 1 })
          .onConflictDoUpdate({
            target: pgRunEventCounters.runId,
            set: { lastSequence: sql`${pgRunEventCounters.lastSequence} + 1` },
          })
          .returning({ sequence: pgRunEventCounters.lastSequence });
        if (!counter) throw new Error("Could not allocate event sequence");
        const event = agentEventSchema.parse({ ...base, id, sequence: counter.sequence });
        await tx.insert(pgAgentEvents).values({ ...event, data: event.data });
        return event;
      });
    } catch (error) {
      return translateError(error);
    }
  }
  async list(filter: EventFilter): Promise<Page<AgentEvent>> {
    const { limit, offset } = pageRequest(filter);
    const conditions = [eq(pgAgentEvents.runId, assertId(filter.runId))];
    if (filter.afterSequence !== undefined)
      conditions.push(gt(pgAgentEvents.sequence, filter.afterSequence));
    const condition = and(...conditions);
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgAgentEvents)
        .where(condition)
        .orderBy(pgAgentEvents.sequence)
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgAgentEvents).where(condition),
    ]);
    return page(
      rows.map((row) => agentEventSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      filter,
    );
  }
}

export class PostgresApprovalRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async createOwned(
    input: CreateApproval,
    identity: RunLeaseIdentity,
    now: string,
    id = randomUUID(),
  ): Promise<Approval> {
    const value = approvalSchema.parse({ ...createApprovalSchema.parse(input), id });
    try {
      const row = await withPostgresLease(
        this.database,
        input.runId,
        identity,
        now,
        async (client) => {
          const result = await client.query<Record<string, unknown>>(
            "INSERT INTO approvals(id,run_id,action_type,action_description,requested_permissions,status,requested_at,resolved_at,resolved_by,principal_id,policy_version,expires_at,consumed_at,revoked_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
            [
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
            ],
          );
          return result.rows[0];
        },
      );
      return approvalSchema.parse(normalizeTimestamps(row));
    } catch (error) {
      return translateError(error);
    }
  }
  async resolveOwned(
    id: string,
    status: "approved" | "rejected",
    resolvedBy: string,
    identity: RunLeaseIdentity,
    now: string,
  ): Promise<Approval> {
    if (status === "approved")
      throw new RepositoryConflictError("Approvals require the trusted server-side policy service");
    const approval = await this.getById(id);
    return withPostgresLease(this.database, approval.runId, identity, now, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "UPDATE approvals SET status=$1,resolved_at=$2,resolved_by=$3 WHERE id=$4 AND status='pending' RETURNING *",
        [status, now, resolvedBy, id],
      );
      if (!result.rows[0]) throw new RepositoryConflictError("Approval is already resolved");
      return approvalSchema.parse(normalizeTimestamps(result.rows[0]));
    });
  }
  async create(input: CreateApproval, id = randomUUID()): Promise<Approval> {
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
      return approvalSchema.parse(
        one(await this.database.orm.insert(pgApprovals).values(value).returning(), "Approval", id),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<Approval> {
    const rows = await this.database.orm
      .select()
      .from(pgApprovals)
      .where(eq(pgApprovals.id, assertId(id)))
      .limit(1);
    return approvalSchema.parse(one(rows, "Approval", id));
  }
  async list(runId: string, input: PageRequest = {}): Promise<Page<Approval>> {
    const { limit, offset } = pageRequest(input);
    const condition = eq(pgApprovals.runId, assertId(runId));
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgApprovals)
        .where(condition)
        .orderBy(desc(pgApprovals.requestedAt), desc(pgApprovals.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgApprovals).where(condition),
    ]);
    return page(
      rows.map((row) => approvalSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }
  async resolve(
    id: string,
    status: "approved" | "rejected",
    resolvedBy: string,
  ): Promise<Approval> {
    if (status === "approved")
      throw new RepositoryConflictError("Approvals require the trusted server-side policy service");
    const current = await this.getById(id);
    if (current.status !== "pending")
      throw new RepositoryConflictError("Approval has already been resolved");
    const value = approvalSchema.parse({
      ...current,
      status,
      resolvedBy,
      resolvedAt: this.database.now(),
    });
    const rows = await this.database.orm
      .update(pgApprovals)
      .set({ status, resolvedBy: value.resolvedBy, resolvedAt: value.resolvedAt })
      .where(and(eq(pgApprovals.id, current.id), eq(pgApprovals.status, "pending")))
      .returning();
    if (!rows.length) throw new RepositoryConflictError("Approval has already been resolved");
    return approvalSchema.parse(normalizeTimestamps(rows[0]));
  }
  async consumeWithEvent(
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
  ): Promise<Approval> {
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
      return await this.database.orm.transaction(async (tx) => {
        assertNotCancelled(isCancelled);
        const rows = await tx
          .update(pgApprovals)
          .set({ consumedAt: input.at })
          .where(
            and(
              eq(pgApprovals.id, assertId(input.id)),
              eq(pgApprovals.runId, assertId(input.runId)),
              eq(pgApprovals.principalId, input.principalId),
              eq(pgApprovals.resolvedBy, input.principalId),
              eq(pgApprovals.actionType, input.actionType),
              eq(pgApprovals.policyVersion, input.policyVersion),
              eq(pgApprovals.status, "approved"),
              gt(pgApprovals.expiresAt, input.at),
              isNull(pgApprovals.consumedAt),
              isNull(pgApprovals.revokedAt),
            ),
          )
          .returning();
        if (!rows.length)
          throw new RepositoryConflictError(
            "Approval is invalid, expired, revoked, or already consumed",
          );
        assertNotCancelled(isCancelled);
        const [counter] = await tx
          .insert(pgRunEventCounters)
          .values({ runId: input.runId, lastSequence: 1 })
          .onConflictDoUpdate({
            target: pgRunEventCounters.runId,
            set: { lastSequence: sql`${pgRunEventCounters.lastSequence} + 1` },
          })
          .returning({ sequence: pgRunEventCounters.lastSequence });
        if (!counter) throw new Error("Could not allocate approval event sequence");
        const value = agentEventSchema.parse({
          ...base,
          id: randomUUID(),
          sequence: counter.sequence,
        });
        await tx.insert(pgAgentEvents).values({ ...value, data: value.data });
        assertNotCancelled(isCancelled);
        return approvalSchema.parse(normalizeTimestamps(rows[0]));
      });
    } catch (error) {
      return translateError(error);
    }
  }
  async revoke(id: string, principalId: string, at: string): Promise<Approval> {
    const rows = await this.database.orm
      .update(pgApprovals)
      .set({ revokedAt: at })
      .where(
        and(
          eq(pgApprovals.id, assertId(id)),
          eq(pgApprovals.principalId, principalId),
          eq(pgApprovals.status, "approved"),
          isNull(pgApprovals.consumedAt),
          isNull(pgApprovals.revokedAt),
        ),
      )
      .returning();
    if (!rows.length)
      throw new RepositoryConflictError("Approval cannot be revoked by this principal");
    return approvalSchema.parse(normalizeTimestamps(rows[0]));
  }
}

export class PostgresEvaluationRepository {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async create(input: CreateEvaluation, id = randomUUID()): Promise<Evaluation> {
    const value = evaluationSchema.parse({
      ...createEvaluationSchema.parse(input),
      id,
      createdAt: this.database.now(),
    });
    try {
      return evaluationSchema.parse(
        one(
          await this.database.orm.insert(pgEvaluations).values(value).returning(),
          "Evaluation",
          id,
        ),
      );
    } catch (error) {
      return translateError(error);
    }
  }
  async getById(id: string): Promise<Evaluation> {
    const rows = await this.database.orm
      .select()
      .from(pgEvaluations)
      .where(eq(pgEvaluations.id, assertId(id)))
      .limit(1);
    return evaluationSchema.parse(one(rows, "Evaluation", id));
  }
  async list(runId: string, input: PageRequest = {}): Promise<Page<Evaluation>> {
    const { limit, offset } = pageRequest(input);
    const condition = eq(pgEvaluations.runId, assertId(runId));
    const [rows, totalRow] = await Promise.all([
      this.database.orm
        .select()
        .from(pgEvaluations)
        .where(condition)
        .orderBy(desc(pgEvaluations.createdAt), desc(pgEvaluations.id))
        .limit(limit)
        .offset(offset),
      this.database.orm.select({ value: count() }).from(pgEvaluations).where(condition),
    ]);
    return page(
      rows.map((row) => evaluationSchema.parse(normalizeTimestamps(row))),
      totalRow[0]?.value ?? 0,
      input,
    );
  }
}

export class PostgresRepositories implements RepositorySet {
  readonly projects: PostgresProjectRepository;
  readonly agents: PostgresAgentRepository;
  readonly providers: PostgresProviderRepository;
  readonly tasks: PostgresTaskRepository;
  readonly runs: PostgresExecutionRunRepository;
  readonly leases: PostgresRunLeaseRepository;
  readonly manifests: PostgresRunManifestRepository;
  readonly artifacts: PostgresRunArtifactRepository;
  readonly events: PostgresAgentEventRepository;
  readonly approvals: PostgresApprovalRepository;
  readonly evaluations: PostgresEvaluationRepository;

  constructor(database: AgentOsPostgresDatabase) {
    this.projects = new PostgresProjectRepository(database);
    this.agents = new PostgresAgentRepository(database);
    this.providers = new PostgresProviderRepository(database);
    this.tasks = new PostgresTaskRepository(database);
    this.runs = new PostgresExecutionRunRepository(database);
    this.leases = new PostgresRunLeaseRepository(database);
    this.manifests = new PostgresRunManifestRepository(database);
    this.artifacts = new PostgresRunArtifactRepository(database);
    this.events = new PostgresAgentEventRepository(database);
    this.approvals = new PostgresApprovalRepository(database);
    this.evaluations = new PostgresEvaluationRepository(database);
  }
}
