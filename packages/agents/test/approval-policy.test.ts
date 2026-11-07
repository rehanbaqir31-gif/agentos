import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalPolicy } from "../src/approval-policy.js";
import {
  ApprovalAuthorizationError,
  ApprovalAuthorizationService,
  type TrustedPrincipalSource,
} from "../src/approval-policy.js";
import { openDatabase } from "@agentos/database";
import { Repositories } from "@agentos/database";

const at = "2026-11-07T12:00:00.000Z";
let directory: string;
let database: Awaited<ReturnType<typeof openDatabase>>;
let repositories: Repositories;
let runId: string;

async function fixture() {
  const project = await repositories.projects.create({
    name: "Approval project",
    description: null,
    repositoryPath: join(directory, "repository"),
    repositoryUrl: null,
    defaultBranch: "main",
    currentCommit: null,
    settings: { permissionMode: "read_only", networkAccess: "disabled" },
  });
  const agent = await repositories.agents.create({
    name: "Test agent",
    adapterId: "test",
    version: "1.0.0",
    capabilities: [],
    configuration: {},
    enabled: true,
    healthStatus: "healthy",
  });
  const task = await repositories.tasks.create({
    projectId: project.id,
    title: "Task",
    description: "Approval test",
    priority: "normal",
    status: "open",
    assignedAgentId: agent.id,
    configuration: {},
  });
  const run = await repositories.runs.create(
    {
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      adapterVersion: agent.version,
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
    randomUUID(),
  );
  runId = run.id;
}

function principalSource(id: string | null = "user-1"): TrustedPrincipalSource {
  return {
    async currentPrincipal() {
      return id ? { id } : null;
    },
  };
}

function policy(
  options: {
    allowed?: boolean;
    version?: string;
    onAuthorize?: () => void;
  } = {},
): ApprovalPolicy {
  let version = options.version ?? "policy-v1";
  return {
    async currentVersion() {
      return version;
    },
    async authorize() {
      options.onAuthorize?.();
      return options.allowed ?? true;
    },
    setVersion(value: string) {
      version = value;
    },
  } as ApprovalPolicy;
}

function service(
  identity: TrustedPrincipalSource | null = principalSource(),
  activePolicy: ApprovalPolicy | null = policy(),
  clock: () => string = () => at,
) {
  return new ApprovalAuthorizationService(
    repositories,
    identity ?? undefined,
    activePolicy ?? undefined,
    clock,
  );
}

async function issueGrant(approvalService = service()) {
  return approvalService.issue({
    runId,
    actionType: "workspace.write",
    actionDescription: "Allow writing to the isolated workspace",
    requestedPermissions: ["file.write"],
    expiresInSeconds: 60,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentos-approval-test-"));
  database = await openDatabase({ filename: join(directory, "test.sqlite"), now: () => at });
  repositories = new Repositories(database);
  await fixture();
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

describe("trusted approval policy", () => {
  it("denies when authenticated identity is missing and ignores forged input identity", async () => {
    const input = {
      runId,
      actionType: "workspace.write",
      actionDescription: "Permit writes",
      requestedPermissions: ["file.write"],
      expiresInSeconds: 60,
      principalId: "forged-user",
    };
    await expect(
      service(null).issue(input as unknown as Parameters<ApprovalAuthorizationService["issue"]>[0]),
    ).rejects.toBeInstanceOf(ApprovalAuthorizationError);
    await expect(service(principalSource(null)).issue(input)).rejects.toBeInstanceOf(
      ApprovalAuthorizationError,
    );
  });

  it("denies without policy or when the server policy refuses the action", async () => {
    await expect(service(principalSource(), null).issue(await issueInput())).rejects.toThrow(
      /policy is unavailable/,
    );
    await expect(
      service(principalSource(), policy({ allowed: false })).issue(await issueInput()),
    ).rejects.toBeInstanceOf(ApprovalAuthorizationError);
  });

  it("does not treat request-shaped principal or identity-header values as authentication", async () => {
    const input = {
      ...(await issueInput()),
      principalId: "forged-body-user",
      headers: { "x-authenticated-user": "forged-header-user" },
    };
    await expect(
      service(null).issue(input as unknown as Parameters<ApprovalAuthorizationService["issue"]>[0]),
    ).rejects.toThrow(/Trusted authentication is unavailable/);
    expect((await repositories.approvals.list(runId)).total).toBe(0);
  });

  it("binds the persisted grant to the authenticated principal, exact run/action and policy", async () => {
    const grant = await issueGrant();
    expect(grant).toMatchObject({
      status: "approved",
      principalId: "user-1",
      runId,
      actionType: "workspace.write",
      policyVersion: "policy-v1",
      expiresAt: "2026-11-07T12:01:00.000Z",
    });
    const events = await repositories.events.list({ runId });
    expect(events.items.at(-1)).toMatchObject({ type: "approval.approved" });

    await expect(
      service(principalSource("another-user")).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
      }),
    ).rejects.toThrow();
    await expect(
      service().consume({
        approvalId: grant.id,
        runId: randomUUID(),
        actionType: "workspace.write",
      }),
    ).rejects.toThrow();
    await expect(
      service().consume({ approvalId: grant.id, runId, actionType: "network.access" }),
    ).rejects.toThrow();
    await expect(
      service(principalSource(), policy({ version: "policy-v2" })).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
      }),
    ).rejects.toThrow();
  });

  it("consumes exactly once under concurrent attempts and writes an audit event", async () => {
    const grant = await issueGrant();
    const auth = service();
    const input = { approvalId: grant.id, runId, actionType: "workspace.write" };
    const attempts = await Promise.allSettled([auth.consume(input), auth.consume(input)]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await repositories.approvals.getById(grant.id)).consumedAt).toBe(at);
    const events = await repositories.events.list({ runId });
    expect(events.items.filter((event) => event.type === "approval.consumed")).toHaveLength(1);
  });

  it("rejects expired, revoked and cancelled authorization", async () => {
    let now = at;
    const expired = await issueGrant(service(principalSource(), policy(), () => at));
    now = "2026-11-07T12:02:00.000Z";
    await expect(
      service(principalSource(), policy(), () => now).consume({
        approvalId: expired.id,
        runId,
        actionType: "workspace.write",
      }),
    ).rejects.toThrow();

    const revoked = await issueGrant();
    await service().revoke(revoked.id);
    await expect(
      service().consume({ approvalId: revoked.id, runId, actionType: "workspace.write" }),
    ).rejects.toThrow();

    const grant = await issueGrant();
    const controller = new AbortController();
    controller.abort();
    await expect(
      service().consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it("fails closed if policy changes during consumption", async () => {
    const grant = await issueGrant();
    let currentVersion = "policy-v1";
    const changingPolicy: ApprovalPolicy = {
      async currentVersion() {
        return currentVersion;
      },
      async authorize() {
        currentVersion = "policy-v2";
        return true;
      },
    };
    await expect(
      service(principalSource(), changingPolicy).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
      }),
    ).rejects.toThrow(/policy changed/);
    expect((await repositories.approvals.getById(grant.id)).consumedAt).toBe(at);
  });

  it("stops if cancellation arrives while the policy is evaluating", async () => {
    const grant = await issueGrant();
    const controller = new AbortController();
    const cancellingPolicy: ApprovalPolicy = {
      async currentVersion() {
        return "policy-v1";
      },
      async authorize() {
        controller.abort();
        return true;
      },
    };
    await expect(
      service(principalSource(), cancellingPolicy).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect((await repositories.approvals.getById(grant.id)).consumedAt).toBeNull();
  });

  it("fails closed when the database fails during atomic consumption", async () => {
    const grant = await issueGrant();
    database.close();
    await expect(
      service().consume({ approvalId: grant.id, runId, actionType: "workspace.write" }),
    ).rejects.toThrow();
  });
});

async function issueInput() {
  return {
    runId,
    actionType: "workspace.write",
    actionDescription: "Permit writes",
    requestedPermissions: ["file.write"],
    expiresInSeconds: 60,
  };
}
