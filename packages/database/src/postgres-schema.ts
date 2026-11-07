import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  bigint,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Agent,
  Approval,
  Evaluation,
  ExecutionRun,
  Project,
  Provider,
  RunManifest,
  RunArtifact,
  WorkerLease,
  Task,
} from "@agentos/core";

const utcTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const pgProjects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    repositoryPath: text("repository_path").notNull(),
    repositoryUrl: text("repository_url"),
    defaultBranch: text("default_branch"),
    currentCommit: text("current_commit"),
    settings: jsonb("settings").$type<Project["settings"]>().notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_repository_path_uq").on(table.repositoryPath),
    index("projects_created_at_idx").on(table.createdAt),
  ],
);

export const pgPrincipals = pgTable("principals", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  authSource: text("auth_source", { enum: ["local_password"] }).notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  disabledAt: utcTimestamp("disabled_at"),
});

export const pgAuthSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => pgPrincipals.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: utcTimestamp("created_at").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    revokedAt: utcTimestamp("revoked_at"),
  },
  (table) => [index("auth_sessions_principal_idx").on(table.principalId, table.expiresAt)],
);

export const pgProjectMemberships = pgTable(
  "project_memberships",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => pgPrincipals.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "maintainer", "viewer"] }).notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.principalId] }),
    index("project_memberships_principal_idx").on(table.principalId, table.projectId),
  ],
);

export const pgAgents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    adapterId: text("adapter_id").notNull(),
    version: text("version").notNull(),
    capabilities: jsonb("capabilities").$type<Agent["capabilities"]>().notNull(),
    configuration: jsonb("configuration").$type<Agent["configuration"]>().notNull(),
    enabled: boolean("enabled").notNull(),
    healthStatus: text("health_status", { enum: ["unknown", "healthy", "unhealthy"] }).notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "agents_health_status_check",
      sql`${table.healthStatus} in ('unknown', 'healthy', 'unhealthy')`,
    ),
    index("agents_adapter_id_idx").on(table.adapterId),
  ],
);

export const pgProviders = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    providerType: text("provider_type", {
      enum: ["ollama", "openai", "anthropic", "google", "openai_compatible"],
    }).notNull(),
    baseUrl: text("base_url"),
    credentialRef: text("credential_ref"),
    availableModels: jsonb("available_models").$type<Provider["availableModels"]>().notNull(),
    configuration: jsonb("configuration").$type<Provider["configuration"]>().notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "providers_type_check",
      sql`${table.providerType} in ('ollama', 'openai', 'anthropic', 'google', 'openai_compatible')`,
    ),
    index("providers_type_idx").on(table.providerType),
  ],
);

export const pgTasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull(),
    status: text("status", { enum: ["open", "in_progress", "completed", "cancelled"] }).notNull(),
    assignedAgentId: uuid("assigned_agent_id").references(() => pgAgents.id, {
      onDelete: "restrict",
    }),
    configuration: jsonb("configuration").$type<Task["configuration"]>().notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    check("tasks_priority_check", sql`${table.priority} in ('low', 'normal', 'high', 'urgent')`),
    check(
      "tasks_status_check",
      sql`${table.status} in ('open', 'in_progress', 'completed', 'cancelled')`,
    ),
    index("tasks_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const pgExecutionRuns = pgTable(
  "execution_runs",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => pgTasks.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pgProjects.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => pgAgents.id, { onDelete: "restrict" }),
    adapterVersion: text("adapter_version").notNull(),
    providerId: uuid("provider_id").references(() => pgProviders.id, { onDelete: "restrict" }),
    modelId: text("model_id"),
    status: text("status", {
      enum: [
        "created",
        "validating",
        "preparing_workspace",
        "queued",
        "running",
        "waiting_for_approval",
        "succeeded",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    manifestId: uuid("manifest_id"),
    workspaceId: text("workspace_id"),
    startedAt: utcTimestamp("started_at"),
    completedAt: utcTimestamp("completed_at"),
    error: text("error"),
    usageMetrics: jsonb("usage_metrics").$type<ExecutionRun["usageMetrics"]>().notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "execution_runs_status_check",
      sql`${table.status} in ('created', 'validating', 'preparing_workspace', 'queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "execution_runs_completion_check",
      sql`${table.completedAt} is null or ${table.startedAt} is not null`,
    ),
    index("execution_runs_project_created_idx").on(table.projectId, table.createdAt),
    index("execution_runs_task_idx").on(table.taskId),
    uniqueIndex("execution_runs_id_project_id_uq").on(table.id, table.projectId),
  ],
);

export const pgRunLeases = pgTable(
  "run_leases",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    workerId: text("worker_id").notNull(),
    generation: bigint("generation", { mode: "number" })
      .$type<WorkerLease["generation"]>()
      .notNull(),
    claimedAt: utcTimestamp("claimed_at").notNull(),
    heartbeatAt: utcTimestamp("heartbeat_at").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    releasedAt: utcTimestamp("released_at"),
  },
  (table) => [
    check("run_leases_generation_check", sql`${table.generation} > 0`),
    check("run_leases_heartbeat_check", sql`${table.heartbeatAt} >= ${table.claimedAt}`),
    check("run_leases_expiry_check", sql`${table.expiresAt} > ${table.claimedAt}`),
    index("run_leases_expiration_idx").on(table.releasedAt, table.expiresAt, table.runId),
  ],
);

export const pgRunManifests = pgTable(
  "run_manifests",
  {
    id: uuid("id").primaryKey(),
    version: integer("version").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => pgAgents.id, { onDelete: "restrict" }),
    agentName: text("agent_name").notNull(),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    providerId: uuid("provider_id").references(() => pgProviders.id, { onDelete: "restrict" }),
    modelId: text("model_id"),
    promptConfigurationHash: text("prompt_configuration_hash").notNull(),
    repositoryCommitSha: text("repository_commit_sha"),
    toolVersions: jsonb("tool_versions").$type<RunManifest["toolVersions"]>().notNull(),
    skillVersions: jsonb("skill_versions").$type<RunManifest["skillVersions"]>().notNull(),
    runtimeConfiguration: jsonb("runtime_configuration")
      .$type<RunManifest["runtimeConfiguration"]>()
      .notNull(),
    permissionConfiguration: jsonb("permission_configuration")
      .$type<RunManifest["permissionConfiguration"]>()
      .notNull(),
    environmentVariableNames: jsonb("environment_variable_names")
      .$type<RunManifest["environmentVariableNames"]>()
      .notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
  },
  (table) => [
    check("run_manifests_version_check", sql`${table.version} = 1`),
    check("run_manifests_hash_check", sql`${table.promptConfigurationHash} ~ '^[a-fA-F0-9]{64}$'`),
    uniqueIndex("run_manifests_run_id_uq").on(table.runId),
    uniqueIndex("run_manifests_id_run_uq").on(table.id, table.runId),
  ],
);

export const pgAgentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    occurredAt: utcTimestamp("occurred_at").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    check("agent_events_sequence_check", sql`${table.sequence} > 0`),
    uniqueIndex("agent_events_run_sequence_uq").on(table.runId, table.sequence),
    index("agent_events_run_time_idx").on(table.runId, table.occurredAt),
  ],
);

export const pgRunEventCounters = pgTable(
  "run_event_counters",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    lastSequence: integer("last_sequence").notNull(),
  },
  (table) => [check("run_event_counters_sequence_check", sql`${table.lastSequence} > 0`)],
);

export const pgRunArtifacts = pgTable(
  "run_artifacts",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id").notNull(),
    projectId: uuid("project_id").notNull(),
    type: text("artifact_type", {
      enum: [
        "git_diff",
        "stdout",
        "stderr",
        "test_results",
        "execution_manifest",
        "result_metadata",
      ],
    }).notNull(),
    logicalName: text("logical_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).$type<RunArtifact["byteSize"]>().notNull(),
    sha256: text("sha256"),
    createdAt: utcTimestamp("created_at").notNull(),
    storageLocator: text("storage_locator"),
    collectionStatus: text("collection_status", {
      enum: ["complete", "truncated", "failed", "unavailable"],
    }).notNull(),
    collectionError: text("collection_error"),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [pgExecutionRuns.id, pgExecutionRuns.projectId],
      name: "run_artifacts_run_project_fk",
    }).onDelete("restrict"),
    check("run_artifacts_byte_size_check", sql`${table.byteSize} >= 0`),
    check(
      "run_artifacts_integrity_check",
      sql`(${table.collectionStatus} IN ('complete', 'truncated') AND ${table.storageLocator} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.collectionError} IS NULL) OR (${table.collectionStatus} = 'failed' AND ${table.storageLocator} IS NULL AND ${table.collectionError} IS NOT NULL) OR (${table.collectionStatus} = 'unavailable' AND ${table.byteSize} = 0 AND ${table.sha256} IS NULL AND ${table.storageLocator} IS NULL AND ${table.collectionError} IS NOT NULL)`,
    ),
    uniqueIndex("run_artifacts_run_type_name_uq").on(table.runId, table.type, table.logicalName),
    index("run_artifacts_run_created_idx").on(table.runId, table.createdAt, table.id),
    index("run_artifacts_project_created_idx").on(table.projectId, table.createdAt, table.id),
  ],
);

export const pgApprovals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    actionType: text("action_type").notNull(),
    actionDescription: text("action_description").notNull(),
    requestedPermissions: jsonb("requested_permissions")
      .$type<Approval["requestedPermissions"]>()
      .notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    requestedAt: utcTimestamp("requested_at").notNull(),
    resolvedAt: utcTimestamp("resolved_at"),
    resolvedBy: text("resolved_by"),
    principalId: text("principal_id"),
    policyVersion: text("policy_version"),
    expiresAt: utcTimestamp("expires_at"),
    consumedAt: utcTimestamp("consumed_at"),
    revokedAt: utcTimestamp("revoked_at"),
  },
  (table) => [
    check("approvals_status_check", sql`${table.status} in ('pending', 'approved', 'rejected')`),
    check(
      "approvals_resolution_check",
      sql`(${table.status} = 'pending' and ${table.resolvedAt} is null and ${table.resolvedBy} is null) or (${table.status} <> 'pending' and ${table.resolvedAt} is not null and ${table.resolvedBy} is not null)`,
    ),
    index("approvals_run_status_idx").on(table.runId, table.status),
  ],
);

export const pgEvaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    evaluatorVersion: text("evaluator_version").notNull(),
    criteria: jsonb("criteria").$type<Evaluation["criteria"]>().notNull(),
    scores: jsonb("scores").$type<Evaluation["scores"]>().notNull(),
    testResults: jsonb("test_results").$type<Evaluation["testResults"]>().notNull(),
    summary: text("summary").notNull(),
    createdAt: utcTimestamp("created_at").notNull(),
  },
  (table) => [index("evaluations_run_created_idx").on(table.runId, table.createdAt)],
);

export const pgRunOwners = pgTable(
  "run_owners",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => pgExecutionRuns.id, { onDelete: "restrict" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => pgPrincipals.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").notNull(),
  },
  (table) => [index("run_owners_principal_idx").on(table.principalId, table.runId)],
);

export const pgExecutionRunsRelations = relations(pgExecutionRuns, ({ one, many }) => ({
  project: one(pgProjects, { fields: [pgExecutionRuns.projectId], references: [pgProjects.id] }),
  task: one(pgTasks, { fields: [pgExecutionRuns.taskId], references: [pgTasks.id] }),
  agent: one(pgAgents, { fields: [pgExecutionRuns.agentId], references: [pgAgents.id] }),
  provider: one(pgProviders, {
    fields: [pgExecutionRuns.providerId],
    references: [pgProviders.id],
  }),
  manifest: one(pgRunManifests, {
    fields: [pgExecutionRuns.manifestId],
    references: [pgRunManifests.id],
  }),
  events: many(pgAgentEvents),
  approvals: many(pgApprovals),
  artifacts: many(pgRunArtifacts),
  lease: one(pgRunLeases),
  evaluations: many(pgEvaluations),
}));
