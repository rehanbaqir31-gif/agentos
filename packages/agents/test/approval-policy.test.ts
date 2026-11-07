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
    async authorize() {
      options.onAuthorize?.();
      return { version, authorized: options.allowed ?? true };
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
  return approvalService.grantPermission({
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
      service(null).grantPermission(
        input as unknown as Parameters<ApprovalAuthorizationService["grantPermission"]>[0],
      ),
    ).rejects.toBeInstanceOf(ApprovalAuthorizationError);
    await expect(service(principalSource(null)).grantPermission(input)).rejects.toBeInstanceOf(
      ApprovalAuthorizationError,
    );
  });

  it("denies without policy or when the server policy refuses the action", async () => {
    await expect(
      service(principalSource(), null).grantPermission(await issueInput()),
    ).rejects.toThrow(/policy is unavailable/);
    await expect(
      service(principalSource(), policy({ allowed: false })).grantPermission(await issueInput()),
    ).rejects.toBeInstanceOf(ApprovalAuthorizationError);
  });

  it("does not treat request-shaped principal or identity-header values as authentication", async () => {
    const input = {
      ...(await issueInput()),
      principalId: "forged-body-user",
      headers: { "x-authenticated-user": "forged-header-user" },
    };
    await expect(
      service(null).grantPermission(
        input as unknown as Parameters<ApprovalAuthorizationService["grantPermission"]>[0],
      ),
    ).rejects.toThrow(/Trusted authentication is unavailable/);
    expect((await repositories.approvals.list(runId)).total).toBe(0);
  });

  it("issues a policy-authorized self-grant, not independent human approval", async () => {
    const grant = await issueGrant();
    expect(grant).toMatchObject({
      status: "approved",
      principalId: "user-1",
      runId,
      actionType: "workspace.write",
      policyVersion: "policy-v1",
      expiresAt: "2026-11-07T12:01:00.000Z",
    });
    expect(grant.resolvedBy).toBe(grant.principalId);
    const events = await repositories.events.list({ runId });
    expect(events.items.at(-1)).toMatchObject({ type: "approval.granted" });

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

  it("uses the versioned policy snapshot that produced the authorization decision", async () => {
    const grant = await issueGrant();
    let currentVersion = "policy-v1";
    const changingPolicy: ApprovalPolicy = {
      async authorize() {
        const snapshotVersion = currentVersion;
        currentVersion = "policy-v2";
        return { version: snapshotVersion, authorized: true };
      },
    };
    await expect(
      service(principalSource(), changingPolicy).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
      }),
    ).resolves.toMatchObject({ consumedAt: at, policyVersion: "policy-v1" });
    expect(currentVersion).toBe("policy-v2");
    const events = await repositories.events.list({ runId });
    expect(events.items.at(-1)).toMatchObject({
      type: "approval.consumed",
      data: expect.objectContaining({ policyVersion: "policy-v1" }),
    });
  });

  it("stops if cancellation arrives while the policy is evaluating", async () => {
    const grant = await issueGrant();
    const controller = new AbortController();
    const cancellingPolicy: ApprovalPolicy = {
      async authorize() {
        controller.abort();
        return { version: "policy-v1", authorized: true };
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

  it("does not evaluate policy when cancelled before evaluation", async () => {
    const grant = await issueGrant();
    const controller = new AbortController();
    controller.abort();
    let evaluated = false;
    const noPolicyEvaluation: ApprovalPolicy = {
      async authorize() {
        evaluated = true;
        return { version: "policy-v1", authorized: true };
      },
    };
    await expect(
      service(principalSource(), noPolicyEvaluation).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(evaluated).toBe(false);
  });

  it("does not begin consumption when cancellation arrives immediately before it", async () => {
    const grant = await issueGrant();
    const controller = new AbortController();
    const cancelAtConsumption = () => {
      controller.abort();
      return at;
    };
    await expect(
      service(principalSource(), policy(), cancelAtConsumption).consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect((await repositories.approvals.getById(grant.id)).consumedAt).toBeNull();
  });

  it("rolls back when cancellation is observed during the transaction", async () => {
    const grant = await issueGrant();
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 6;
      },
    } as AbortSignal;
    await expect(
      service().consume({
        approvalId: grant.id,
        runId,
        actionType: "workspace.write",
        signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect((await repositories.approvals.getById(grant.id)).consumedAt).toBeNull();
    expect(
      (await repositories.events.list({ runId })).items.filter(
        (event) => event.type === "approval.consumed",
      ),
    ).toHaveLength(0);
  });

  it("leaves the grant consumed if cancellation arrives immediately after commit", async () => {
    const grant = await issueGrant();
    const controller = new AbortController();
    const approvalRepository = repositories.approvals;
    const original = approvalRepository.consumeWithEvent.bind(approvalRepository);
    approvalRepository.consumeWithEvent = (...args) => {
      const result = original(...args);
      controller.abort();
      return result;
    };
    try {
      await expect(
        service().consume({
          approvalId: grant.id,
          runId,
          actionType: "workspace.write",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      approvalRepository.consumeWithEvent = original;
    }
    expect((await repositories.approvals.getById(grant.id)).consumedAt).toBe(at);
    expect(
      (await repositories.events.list({ runId })).items.filter(
        (event) => event.type === "approval.consumed",
      ),
    ).toHaveLength(1);
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
