import { z } from "zod";
import { runStatuses } from "./run-lifecycle.js";

const id = z.string().uuid();
export const projectIdSchema = id.brand<"ProjectId">();
export const agentIdSchema = id.brand<"AgentId">();
export const providerIdSchema = id.brand<"ProviderId">();
export const taskIdSchema = id.brand<"TaskId">();
export const runIdSchema = id.brand<"ExecutionRunId">();
export const runManifestIdSchema = id.brand<"RunManifestId">();
export const approvalIdSchema = id.brand<"ApprovalId">();
export const evaluationIdSchema = id.brand<"EvaluationId">();
export const agentEventIdSchema = id.brand<"AgentEventId">();
export const artifactIdSchema = id.brand<"RunArtifactId">();
export type ProjectId = z.infer<typeof projectIdSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;
export type ProviderId = z.infer<typeof providerIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type ExecutionRunId = z.infer<typeof runIdSchema>;
export type RunManifestId = z.infer<typeof runManifestIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type EvaluationId = z.infer<typeof evaluationIdSchema>;
export type AgentEventId = z.infer<typeof agentEventIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const principalIdSchema = z.string().uuid().brand<"PrincipalId">();
export const sessionIdSchema = z.string().uuid().brand<"AuthSessionId">();
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type AuthSessionId = z.infer<typeof sessionIdSchema>;

export const principalSchema = z
  .object({
    id: principalIdSchema,
    authSource: z.literal("local_password"),
    createdAt: z.iso.datetime(),
    disabledAt: z.iso.datetime().nullable(),
  })
  .strict();
export type Principal = z.infer<typeof principalSchema>;

export const sessionSchema = z
  .object({
    id: sessionIdSchema,
    principalId: principalIdSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type AuthSession = z.infer<typeof sessionSchema>;

export const projectRoleSchema = z.enum(["owner", "maintainer", "viewer"]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const projectMembershipSchema = z
  .object({
    projectId: projectIdSchema,
    principalId: principalIdSchema,
    role: projectRoleSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ProjectMembership = z.infer<typeof projectMembershipSchema>;
const timestamp = z.iso.datetime();
const name = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const safeJsonRecord = z.record(z.string(), jsonValue).superRefine((record, context) => {
  const secretKey =
    /(?:api[_-]?key|password|secret|token|credential|authorization|environment|^env$)/i;
  const secretValue = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}/i;
  const visit = (value: unknown, path: (string | number)[] = []): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        const nestedPath = [...path, key];
        if (secretKey.test(key)) {
          context.addIssue({
            code: "custom",
            path: nestedPath,
            message: "Sensitive fields are not allowed",
          });
        }
        visit(nested, nestedPath);
      }
    } else if (typeof value === "string" && secretValue.test(value)) {
      context.addIssue({ code: "custom", path, message: "Secret-like values are not allowed" });
    }
  };
  visit(record);
});

const providerBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1] ?? "";
    const query = value.split("?", 2)[1]?.split("#", 1)[0] ?? "";
    return (
      !authority.includes("@") &&
      !/(?:^|&)(?:api[_-]?key|access[_-]?token|token|secret|password)=/i.test(query)
    );
  }, "Provider URLs cannot contain credentials or secret query parameters");

export const projectSettingsSchema = z
  .object({
    permissionMode: z.enum(["read_only", "supervised", "autonomous"]).default("supervised"),
    networkAccess: z.enum(["disabled", "allowlist"]).default("disabled"),
  })
  .strict();

export const projectSchema = z
  .object({
    id: projectIdSchema,
    name,
    description: z.string().max(20_000).nullable(),
    repositoryPath: z.string().min(1).max(4096),
    repositoryUrl: z.string().url().nullable(),
    defaultBranch: z.string().max(255).nullable(),
    currentCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
      .nullable(),
    settings: projectSettingsSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export const createProjectSchema = projectSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateProject = z.input<typeof createProjectSchema>;

export const agentHealthStatusSchema = z.enum(["unknown", "healthy", "unhealthy"]);
export const agentSchema = z
  .object({
    id: agentIdSchema,
    name,
    adapterId: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    capabilities: z.array(z.string().min(1).max(128)),
    configuration: safeJsonRecord,
    enabled: z.boolean(),
    healthStatus: agentHealthStatusSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type Agent = z.infer<typeof agentSchema>;
export const createAgentSchema = agentSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CreateAgent = z.input<typeof createAgentSchema>;

export const providerTypeSchema = z.enum([
  "ollama",
  "openai",
  "anthropic",
  "google",
  "openai_compatible",
]);
export const providerSchema = z
  .object({
    id: providerIdSchema,
    name,
    providerType: providerTypeSchema,
    baseUrl: providerBaseUrlSchema.nullable(),
    credentialRef: z
      .string()
      .regex(
        /^(?:env:[A-Za-z_][A-Za-z0-9_]*|(?:os-credential|keychain|secret-store):[A-Za-z0-9._:/-]+)$/,
      )
      .nullable(),
    availableModels: z.array(z.string().min(1).max(256)),
    configuration: safeJsonRecord,
    enabled: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type Provider = z.infer<typeof providerSchema>;
export const createProviderSchema = providerSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateProvider = z.input<typeof createProviderSchema>;

export const taskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const taskStatusSchema = z.enum(["open", "in_progress", "completed", "cancelled"]);
export const taskSchema = z
  .object({
    id: taskIdSchema,
    projectId: projectIdSchema,
    title: name,
    description,
    priority: taskPrioritySchema,
    status: taskStatusSchema,
    assignedAgentId: agentIdSchema.nullable(),
    configuration: safeJsonRecord,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;
export const createTaskSchema = taskSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CreateTask = z.input<typeof createTaskSchema>;

const executionRunBaseSchema = z
  .object({
    id: runIdSchema,
    taskId: taskIdSchema,
    projectId: projectIdSchema,
    agentId: agentIdSchema,
    adapterVersion: z.string().min(1).max(128),
    providerId: providerIdSchema.nullable(),
    modelId: z.string().max(256).nullable(),
    status: z.enum(runStatuses),
    manifestId: runManifestIdSchema.nullable(),
    workspaceId: z.string().max(512).nullable(),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    error: z.string().max(20_000).nullable(),
    usageMetrics: safeJsonRecord,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const executionRunSchema = executionRunBaseSchema.superRefine((run, context) => {
  if (run.completedAt !== null && run.startedAt === null) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "Completed runs must have started",
    });
  }
});
export type ExecutionRun = z.infer<typeof executionRunSchema>;
export const createExecutionRunSchema = executionRunBaseSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateExecutionRun = z.input<typeof createExecutionRunSchema>;

export const workerIdSchema = z.string().trim().min(1).max(256);
export const leaseGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const runLeaseIdentitySchema = z
  .object({ workerId: workerIdSchema, generation: leaseGenerationSchema })
  .strict();
export type RunLeaseIdentity = z.infer<typeof runLeaseIdentitySchema>;
export const workerLeaseSchema = z
  .object({
    runId: runIdSchema,
    workerId: workerIdSchema,
    generation: leaseGenerationSchema,
    claimedAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: timestamp,
    releasedAt: timestamp.nullable(),
  })
  .strict()
  .superRefine((lease, context) => {
    if (Date.parse(lease.heartbeatAt) < Date.parse(lease.claimedAt))
      context.addIssue({
        code: "custom",
        path: ["heartbeatAt"],
        message: "Heartbeat precedes claim",
      });
    if (Date.parse(lease.expiresAt) <= Date.parse(lease.claimedAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Lease expiry must follow claim",
      });
  });
export type WorkerLease = z.infer<typeof workerLeaseSchema>;
export interface LeaseClaim {
  lease: WorkerLease;
  /** The expired/released generation whose resources may be reconciled by this claim. */
  previousGeneration: number | null;
}

export const runManifestSchema = z
  .object({
    id: runManifestIdSchema,
    version: z.literal(1),
    runId: runIdSchema,
    agentId: agentIdSchema,
    agentName: name,
    adapterId: z.string().min(1).max(128),
    adapterVersion: z.string().min(1).max(128),
    providerId: providerIdSchema.nullable(),
    modelId: z.string().max(256).nullable(),
    promptConfigurationHash: z.string().regex(/^[a-f0-9]{64}$/i),
    repositoryCommitSha: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
      .nullable(),
    toolVersions: z.record(z.string().min(1).max(128), z.string().max(128)),
    skillVersions: z.record(z.string().min(1).max(128), z.string().max(128)),
    runtimeConfiguration: z
      .object({
        isolationMode: z.enum(["host_process", "docker"]).default("host_process"),
        networkAccess: z.enum(["disabled", "allowlist"]).default("disabled"),
        timeoutSeconds: z.number().int().min(1).max(86_400).default(3_600),
        memoryLimitMb: z.number().int().positive().nullable().default(null),
        cpuLimit: z.number().positive().nullable().default(null),
        networkAllowlist: z.array(z.string().min(1).max(253)).default([]),
      })
      .strict(),
    permissionConfiguration: projectSettingsSchema,
    environmentVariableNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
    createdAt: timestamp,
  })
  .strict();
export type RunManifest = z.infer<typeof runManifestSchema>;
export const createRunManifestSchema = runManifestSchema.omit({ id: true, createdAt: true });
export type CreateRunManifest = z.input<typeof createRunManifestSchema>;

export const runArtifactTypeSchema = z.enum([
  "git_diff",
  "stdout",
  "stderr",
  "test_results",
  "execution_manifest",
  "result_metadata",
]);
export const artifactCollectionStatusSchema = z.enum([
  "complete",
  "truncated",
  "failed",
  "unavailable",
]);
const runArtifactBaseSchema = z
  .object({
    id: artifactIdSchema,
    runId: runIdSchema,
    projectId: projectIdSchema,
    type: runArtifactTypeSchema,
    logicalName: z.string().min(1).max(256),
    contentType: z.string().min(1).max(128),
    byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable(),
    createdAt: timestamp,
    storageLocator: z
      .string()
      .regex(/^[a-f0-9]{2}\/[a-f0-9-]{36}\.artifact$/i)
      .nullable(),
    collectionStatus: artifactCollectionStatusSchema,
    collectionError: z.string().max(4_000).nullable(),
  })
  .strict();
export const runArtifactSchema = runArtifactBaseSchema.superRefine((artifact, context) => {
  if (
    artifact.storageLocator !== null &&
    artifact.storageLocator !== `${artifact.id.slice(0, 2)}/${artifact.id}.artifact`
  ) {
    context.addIssue({
      code: "custom",
      path: ["storageLocator"],
      message: "Artifact locator must be derived from its ID",
    });
  }
  if (
    (artifact.collectionStatus === "complete" || artifact.collectionStatus === "truncated") &&
    (artifact.storageLocator === null || artifact.sha256 === null || artifact.collectionError)
  ) {
    context.addIssue({
      code: "custom",
      path: ["collectionStatus"],
      message: "Stored artifacts require a locator and digest without a collection error",
    });
  }
  if (
    artifact.collectionStatus === "unavailable" &&
    (artifact.byteSize !== 0 ||
      artifact.sha256 !== null ||
      artifact.storageLocator !== null ||
      !artifact.collectionError)
  ) {
    context.addIssue({
      code: "custom",
      path: ["collectionStatus"],
      message: "Unavailable artifacts cannot report captured bytes or a digest",
    });
  }
  if (
    artifact.collectionStatus === "failed" &&
    (!artifact.collectionError || artifact.storageLocator !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["collectionError"],
      message: "Failed collection requires an error description",
    });
  }
});
export type RunArtifact = z.infer<typeof runArtifactSchema>;
export const createRunArtifactSchema = runArtifactBaseSchema.omit({ id: true, createdAt: true });
export type CreateRunArtifact = z.input<typeof createRunArtifactSchema>;

export const approvalStatusSchema = z.enum(["pending", "approved", "rejected"]);
const approvalBaseSchema = z
  .object({
    id: approvalIdSchema,
    runId: runIdSchema,
    actionType: z.string().min(1).max(128),
    actionDescription: z.string().min(1).max(20_000),
    requestedPermissions: z.array(z.string().min(1).max(256)),
    status: approvalStatusSchema,
    requestedAt: timestamp,
    resolvedAt: timestamp.nullable(),
    resolvedBy: z.string().max(256).nullable(),
    principalId: z.string().min(1).max(256).nullable().default(null),
    policyVersion: z.string().min(1).max(128).nullable().default(null),
    expiresAt: timestamp.nullable().default(null),
    consumedAt: timestamp.nullable().default(null),
    revokedAt: timestamp.nullable().default(null),
  })
  .strict();
export const approvalSchema = approvalBaseSchema.superRefine((approval, context) => {
  if (
    approval.status === "pending" &&
    (approval.resolvedAt !== null || approval.resolvedBy !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Pending approvals cannot have a resolver",
    });
  }
  if (
    approval.status !== "pending" &&
    (approval.resolvedAt === null || approval.resolvedBy === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["resolvedAt"],
      message: "Resolved approvals require resolver and time",
    });
  }
  if (approval.consumedAt !== null && approval.status !== "approved") {
    context.addIssue({
      code: "custom",
      path: ["consumedAt"],
      message: "Only an approved authorization can be consumed",
    });
  }
  if (approval.revokedAt !== null && approval.status !== "approved") {
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Only an approved authorization can be revoked",
    });
  }
  if (
    approval.principalId !== null &&
    approval.status === "approved" &&
    (approval.resolvedBy !== approval.principalId ||
      approval.policyVersion === null ||
      approval.expiresAt === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["principalId"],
      message: "Bound approvals require matching resolver, policy version and expiry",
    });
  }
});
export type Approval = z.infer<typeof approvalSchema>;
export const createApprovalSchema = approvalBaseSchema.omit({ id: true });
export type CreateApproval = z.input<typeof createApprovalSchema>;

export const evaluationSchema = z
  .object({
    id: evaluationIdSchema,
    runId: runIdSchema,
    evaluatorVersion: z.string().min(1).max(128),
    criteria: safeJsonRecord,
    scores: z.record(z.string().min(1).max(128), z.number().finite().min(0).max(1)),
    testResults: safeJsonRecord,
    summary: z.string().max(20_000),
    createdAt: timestamp,
  })
  .strict();
export type Evaluation = z.infer<typeof evaluationSchema>;
export const createEvaluationSchema = evaluationSchema.omit({ id: true, createdAt: true });
export type CreateEvaluation = z.input<typeof createEvaluationSchema>;

export const entityIdSchema = id;
