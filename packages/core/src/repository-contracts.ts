import type {
  Agent,
  Approval,
  CreateRunArtifact,
  CreateAgent,
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
  Task,
} from "./domain.js";
import type { AgentEvent, CreateAgentEvent } from "./events.js";
import type { RunStatus } from "./run-lifecycle.js";

export type Awaitable<T> = T | Promise<T>;

export interface PageRequest {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProjectFilter extends PageRequest {
  nameContains?: string;
}

export interface TaskFilter extends PageRequest {
  projectId?: string;
  status?: Task["status"];
}

export interface RunFilter extends PageRequest {
  projectId?: string;
  taskId?: string;
  status?: RunStatus;
}

export interface EventFilter extends PageRequest {
  runId: string;
  afterSequence?: number;
}

export interface EntityRepository<TEntity, TCreate, TUpdate, TFilter extends PageRequest> {
  create(input: TCreate, id?: string): Promise<TEntity>;
  getById(id: string): Awaitable<TEntity>;
  list(filter?: TFilter): Awaitable<Page<TEntity>>;
  update(id: string, patch: TUpdate): Awaitable<TEntity>;
  delete(id: string): Awaitable<boolean>;
}

export type ProjectRepositoryContract = EntityRepository<
  Project,
  CreateProject,
  Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>,
  ProjectFilter
>;
export type AgentRepositoryContract = EntityRepository<
  Agent,
  CreateAgent,
  Partial<Omit<Agent, "id" | "createdAt" | "updatedAt">>,
  PageRequest
>;
export type ProviderRepositoryContract = EntityRepository<
  Provider,
  CreateProvider,
  Partial<Omit<Provider, "id" | "createdAt" | "updatedAt">>,
  PageRequest
>;
export type TaskRepositoryContract = EntityRepository<
  Task,
  CreateTask,
  Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>,
  TaskFilter
>;
export type ExecutionRunRepositoryContract = EntityRepository<
  ExecutionRun,
  CreateExecutionRun,
  Partial<Omit<ExecutionRun, "id" | "createdAt" | "updatedAt">>,
  RunFilter
>;

export interface RunManifestRepositoryContract {
  create(input: CreateRunManifest, id?: string): Awaitable<RunManifest>;
  getByRunId(runId: string): Awaitable<RunManifest>;
  list(filter?: PageRequest): Awaitable<Page<RunManifest>>;
}

export interface RunArtifactRepositoryContract {
  create(input: CreateRunArtifact, id?: string): Awaitable<RunArtifact>;
  getForProject(runId: string, projectId: string, artifactId: string): Awaitable<RunArtifact>;
  listForProject(
    runId: string,
    projectId: string,
    filter?: PageRequest,
  ): Awaitable<Page<RunArtifact>>;
  totalBytes(runId: string, projectId: string): Awaitable<number>;
  listStorageLocators(): Awaitable<string[]>;
  listExpired(before: string, filter?: PageRequest): Awaitable<Page<RunArtifact>>;
  delete(id: string): Awaitable<RunArtifact | null>;
}

export interface AgentEventRepositoryContract {
  append(input: CreateAgentEvent, id?: string): Awaitable<AgentEvent>;
  list(filter: EventFilter): Awaitable<Page<AgentEvent>>;
}

export interface ApprovalRepositoryContract {
  create(input: CreateApproval, id?: string): Awaitable<Approval>;
  getById(id: string): Awaitable<Approval>;
  list(runId: string, filter?: PageRequest): Awaitable<Page<Approval>>;
  resolve(id: string, status: "approved" | "rejected", resolvedBy: string): Awaitable<Approval>;
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
  ): Awaitable<Approval>;
  revoke(id: string, principalId: string, at: string): Awaitable<Approval>;
}

export interface EvaluationRepositoryContract {
  create(input: CreateEvaluation, id?: string): Awaitable<Evaluation>;
  getById(id: string): Awaitable<Evaluation>;
  list(runId: string, filter?: PageRequest): Awaitable<Page<Evaluation>>;
}

export interface RepositorySet {
  projects: ProjectRepositoryContract;
  agents: AgentRepositoryContract;
  providers: ProviderRepositoryContract;
  tasks: TaskRepositoryContract;
  runs: ExecutionRunRepositoryContract;
  manifests: RunManifestRepositoryContract;
  artifacts: RunArtifactRepositoryContract;
  events: AgentEventRepositoryContract;
  approvals: ApprovalRepositoryContract;
  evaluations: EvaluationRepositoryContract;
}
