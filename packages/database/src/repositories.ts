import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, like, max } from "drizzle-orm";
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
  taskSchema,
  transitionRun,
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
import {
  agentEvents,
  agents,
  approvals,
  evaluations,
  executionRuns,
  projects,
  providers,
  runManifests,
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

export class RunManifestRepository {
  constructor(private readonly database: AgentOsDatabase) {}
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

export class ApprovalRepository {
  constructor(private readonly database: AgentOsDatabase) {}
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
  consume(input: {
    id: string;
    runId: string;
    principalId: string;
    actionType: string;
    policyVersion: string;
    at: string;
  }): Approval {
    const result = this.database.orm
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
      .run();
    if (result.changes === 0)
      throw new RepositoryConflictError(
        "Approval is invalid, expired, revoked, or already consumed",
      );
    return this.getById(input.id);
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
  readonly projects: ProjectRepository;
  readonly agents: AgentRepository;
  readonly providers: ProviderRepository;
  readonly tasks: TaskRepository;
  readonly runs: ExecutionRunRepository;
  readonly manifests: RunManifestRepository;
  readonly events: AgentEventRepository;
  readonly approvals: ApprovalRepository;
  readonly evaluations: EvaluationRepository;

  constructor(database: AgentOsDatabase) {
    this.projects = new ProjectRepository(database);
    this.agents = new AgentRepository(database);
    this.providers = new ProviderRepository(database);
    this.tasks = new TaskRepository(database);
    this.runs = new ExecutionRunRepository(database);
    this.manifests = new RunManifestRepository(database);
    this.events = new AgentEventRepository(database);
    this.approvals = new ApprovalRepository(database);
    this.evaluations = new EvaluationRepository(database);
  }
}
