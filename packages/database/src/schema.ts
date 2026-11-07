import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  Agent,
  Approval,
  Evaluation,
  ExecutionRun,
  Project,
  Provider,
  RunManifest,
  WorkerLease,
  Task,
} from "@agentos/core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    repositoryPath: text("repository_path").notNull(),
    repositoryUrl: text("repository_url"),
    defaultBranch: text("default_branch"),
    currentCommit: text("current_commit"),
    settings: text("settings", { mode: "json" }).$type<Project["settings"]>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_repository_path_uq").on(table.repositoryPath),
    index("projects_created_at_idx").on(table.createdAt),
  ],
);

export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  authSource: text("auth_source", { enum: ["local_password"] }).notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  disabledAt: text("disabled_at"),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("auth_sessions_principal_idx").on(table.principalId, table.expiresAt)],
);

export const projectMemberships = sqliteTable(
  "project_memberships",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "maintainer", "viewer"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.principalId] }),
    index("project_memberships_principal_idx").on(table.principalId, table.projectId),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    adapterId: text("adapter_id").notNull(),
    version: text("version").notNull(),
    capabilities: text("capabilities", { mode: "json" }).$type<Agent["capabilities"]>().notNull(),
    configuration: text("configuration", { mode: "json" })
      .$type<Agent["configuration"]>()
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    healthStatus: text("health_status", { enum: ["unknown", "healthy", "unhealthy"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("agents_adapter_id_idx").on(table.adapterId)],
);

export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    providerType: text("provider_type", {
      enum: ["ollama", "openai", "anthropic", "google", "openai_compatible"],
    }).notNull(),
    baseUrl: text("base_url"),
    credentialRef: text("credential_ref"),
    availableModels: text("available_models", { mode: "json" })
      .$type<Provider["availableModels"]>()
      .notNull(),
    configuration: text("configuration", { mode: "json" })
      .$type<Provider["configuration"]>()
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("providers_type_idx").on(table.providerType)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull(),
    status: text("status", { enum: ["open", "in_progress", "completed", "cancelled"] }).notNull(),
    assignedAgentId: text("assigned_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    configuration: text("configuration", { mode: "json" }).$type<Task["configuration"]>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("tasks_project_created_idx").on(table.projectId, table.createdAt)],
);

export const executionRuns = sqliteTable(
  "execution_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    adapterVersion: text("adapter_version").notNull(),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "restrict" }),
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
    manifestId: text("manifest_id"),
    workspaceId: text("workspace_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    error: text("error"),
    usageMetrics: text("usage_metrics", { mode: "json" })
      .$type<ExecutionRun["usageMetrics"]>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "execution_runs_completion_check",
      sql`${table.completedAt} is null or ${table.startedAt} is not null`,
    ),
    index("execution_runs_project_created_idx").on(table.projectId, table.createdAt),
    index("execution_runs_task_idx").on(table.taskId),
    uniqueIndex("execution_runs_id_project_id_uq").on(table.id, table.projectId),
  ],
);

export const runLeases = sqliteTable(
  "run_leases",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => executionRuns.id, { onDelete: "restrict" }),
    workerId: text("worker_id").notNull(),
    generation: integer("generation").$type<WorkerLease["generation"]>().notNull(),
    claimedAt: text("claimed_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    releasedAt: text("released_at"),
  },
  (table) => [
    check("run_leases_generation_check", sql`${table.generation} > 0`),
    check("run_leases_heartbeat_check", sql`${table.heartbeatAt} >= ${table.claimedAt}`),
    check("run_leases_expiry_check", sql`${table.expiresAt} > ${table.claimedAt}`),
    index("run_leases_expiration_idx").on(table.releasedAt, table.expiresAt, table.runId),
  ],
);

export const runManifests = sqliteTable(
  "run_manifests",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "restrict" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    agentName: text("agent_name").notNull(),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "restrict" }),
    modelId: text("model_id"),
    promptConfigurationHash: text("prompt_configuration_hash").notNull(),
    repositoryCommitSha: text("repository_commit_sha"),
    toolVersions: text("tool_versions", { mode: "json" })
      .$type<RunManifest["toolVersions"]>()
      .notNull(),
    skillVersions: text("skill_versions", { mode: "json" })
      .$type<RunManifest["skillVersions"]>()
      .notNull(),
    runtimeConfiguration: text("runtime_configuration", { mode: "json" })
      .$type<RunManifest["runtimeConfiguration"]>()
      .notNull(),
    permissionConfiguration: text("permission_configuration", { mode: "json" })
      .$type<RunManifest["permissionConfiguration"]>()
      .notNull(),
    environmentVariableNames: text("environment_variable_names", { mode: "json" })
      .$type<RunManifest["environmentVariableNames"]>()
      .notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("run_manifests_run_id_uq").on(table.runId)],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    occurredAt: text("occurred_at").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("agent_events_run_sequence_uq").on(table.runId, table.sequence),
    index("agent_events_run_time_idx").on(table.runId, table.occurredAt),
  ],
);

export const runArtifacts = sqliteTable(
  "run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    projectId: text("project_id").notNull(),
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
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256"),
    createdAt: text("created_at").notNull(),
    storageLocator: text("storage_locator"),
    collectionStatus: text("collection_status", {
      enum: ["complete", "truncated", "failed", "unavailable"],
    }).notNull(),
    collectionError: text("collection_error"),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [executionRuns.id, executionRuns.projectId],
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

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "restrict" }),
    actionType: text("action_type").notNull(),
    actionDescription: text("action_description").notNull(),
    requestedPermissions: text("requested_permissions", { mode: "json" })
      .$type<Approval["requestedPermissions"]>()
      .notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    requestedAt: text("requested_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolvedBy: text("resolved_by"),
    principalId: text("principal_id"),
    policyVersion: text("policy_version"),
    expiresAt: text("expires_at"),
    consumedAt: text("consumed_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("approvals_run_status_idx").on(table.runId, table.status)],
);

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "restrict" }),
    evaluatorVersion: text("evaluator_version").notNull(),
    criteria: text("criteria", { mode: "json" }).$type<Evaluation["criteria"]>().notNull(),
    scores: text("scores", { mode: "json" }).$type<Evaluation["scores"]>().notNull(),
    testResults: text("test_results", { mode: "json" })
      .$type<Evaluation["testResults"]>()
      .notNull(),
    summary: text("summary").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("evaluations_run_created_idx").on(table.runId, table.createdAt)],
);

export const runOwners = sqliteTable(
  "run_owners",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => executionRuns.id, { onDelete: "restrict" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("run_owners_principal_idx").on(table.principalId, table.runId)],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
  runs: many(executionRuns),
}));
export const agentsRelations = relations(agents, ({ many }) => ({
  tasks: many(tasks),
  runs: many(executionRuns),
}));
export const providersRelations = relations(providers, ({ many }) => ({
  runs: many(executionRuns),
}));
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  agent: one(agents, { fields: [tasks.assignedAgentId], references: [agents.id] }),
  runs: many(executionRuns),
}));
export const executionRunsRelations = relations(executionRuns, ({ one, many }) => ({
  project: one(projects, { fields: [executionRuns.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [executionRuns.taskId], references: [tasks.id] }),
  agent: one(agents, { fields: [executionRuns.agentId], references: [agents.id] }),
  provider: one(providers, { fields: [executionRuns.providerId], references: [providers.id] }),
  manifest: one(runManifests, {
    fields: [executionRuns.manifestId],
    references: [runManifests.id],
  }),
  events: many(agentEvents),
  approvals: many(approvals),
  artifacts: many(runArtifacts),
  lease: one(runLeases),
  evaluations: many(evaluations),
}));
export const runManifestsRelations = relations(runManifests, ({ one }) => ({
  run: one(executionRuns, { fields: [runManifests.runId], references: [executionRuns.id] }),
}));
export const runLeasesRelations = relations(runLeases, ({ one }) => ({
  run: one(executionRuns, { fields: [runLeases.runId], references: [executionRuns.id] }),
}));
export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  run: one(executionRuns, { fields: [agentEvents.runId], references: [executionRuns.id] }),
}));
export const runArtifactsRelations = relations(runArtifacts, ({ one }) => ({
  run: one(executionRuns, {
    fields: [runArtifacts.runId],
    references: [executionRuns.id],
  }),
}));
export const approvalsRelations = relations(approvals, ({ one }) => ({
  run: one(executionRuns, { fields: [approvals.runId], references: [executionRuns.id] }),
}));
export const evaluationsRelations = relations(evaluations, ({ one }) => ({
  run: one(executionRuns, { fields: [evaluations.runId], references: [executionRuns.id] }),
}));
