import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Approval, RepositorySet } from "@agentos/core";
import { approvalIdSchema, redactEventSecrets, runIdSchema } from "@agentos/core";

export interface AuthenticatedPrincipal {
  /** Populated only by a trusted server-side identity adapter. Never accept this from request data. */
  readonly id: string;
}

export interface TrustedPrincipalSource {
  currentPrincipal(): Promise<AuthenticatedPrincipal | null>;
}

export type ApprovalOperation = "issue" | "consume" | "revoke";
export interface ApprovalPolicy {
  currentVersion(): Promise<string>;
  authorize(input: {
    principal: AuthenticatedPrincipal;
    runId: string;
    actionType: string;
    operation: ApprovalOperation;
  }): Promise<boolean>;
}

export class ApprovalAuthorizationError extends Error {
  constructor(message = "Approval authorization denied") {
    super(message);
    this.name = "ApprovalAuthorizationError";
  }
}

const principalIdSchema = z.string().trim().min(1).max(256);
const policyVersionSchema = z.string().trim().min(1).max(128);
const approvalActionSchema = z.string().trim().min(1).max(128);

export interface IssueApprovalInput {
  runId: string;
  actionType: string;
  actionDescription: string;
  requestedPermissions: string[];
  expiresInSeconds: number;
}

export interface ConsumeApprovalInput {
  approvalId: string;
  runId: string;
  actionType: string;
  signal?: AbortSignal;
}

/**
 * Server-side approval lifecycle. No principal ID is accepted by its public methods;
 * identity must come from an injected trusted source. Missing dependencies deny by default.
 */
export class ApprovalAuthorizationService {
  constructor(
    private readonly repositories: RepositorySet,
    private readonly principals: TrustedPrincipalSource | undefined,
    private readonly policy: ApprovalPolicy | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async issue(input: IssueApprovalInput): Promise<Approval> {
    const principal = await this.requirePrincipal();
    const actionType = approvalActionSchema.parse(input.actionType);
    const runId = runIdSchema.parse(input.runId);
    const policyVersion = await this.requirePolicy(principal, runId, actionType, "issue");
    const requestedAt = this.now();
    const expiresInSeconds = z.number().int().min(1).max(86_400).parse(input.expiresInSeconds);
    const expiresAt = new Date(Date.parse(requestedAt) + expiresInSeconds * 1000).toISOString();
    const approval = await this.repositories.approvals.create(
      {
        runId,
        actionType,
        actionDescription: redactEventSecrets(input.actionDescription).slice(0, 20_000),
        requestedPermissions: redactEventSecrets(input.requestedPermissions.slice(0, 256)),
        status: "approved",
        requestedAt,
        resolvedAt: requestedAt,
        resolvedBy: principal.id,
        principalId: principal.id,
        policyVersion,
        expiresAt,
        consumedAt: null,
        revokedAt: null,
      },
      this.makeId(),
    );
    try {
      await this.repositories.events.append({
        runId,
        type: "approval.approved",
        occurredAt: requestedAt,
        data: { approvalId: approval.id, resolvedBy: principal.id },
      });
    } catch (error) {
      await this.repositories.approvals.revoke(approval.id, principal.id, this.now());
      throw error;
    }
    return approval;
  }

  async consume(input: ConsumeApprovalInput): Promise<Approval> {
    assertNotAborted(input.signal);
    const principal = await this.requirePrincipal();
    const approvalId = approvalIdSchema.parse(input.approvalId);
    const runId = runIdSchema.parse(input.runId);
    const actionType = approvalActionSchema.parse(input.actionType);
    const policyVersion = await this.requirePolicy(principal, runId, actionType, "consume");
    assertNotAborted(input.signal);
    const consumedAt = this.now();
    const approval = await this.repositories.approvals.consume({
      id: approvalId,
      runId,
      principalId: principal.id,
      actionType,
      policyVersion,
      at: consumedAt,
    });
    assertNotAborted(input.signal);
    // Re-check after atomic consumption so a concurrent policy deployment fails closed.
    const latestPolicyVersion = await this.policyVersion();
    if (latestPolicyVersion !== policyVersion)
      throw new ApprovalAuthorizationError("Approval policy changed during authorization");
    await this.repositories.events.append({
      runId,
      type: "approval.consumed",
      occurredAt: consumedAt,
      data: { approvalId, principalId: principal.id, policyVersion, actionType },
    });
    return approval;
  }

  async revoke(approvalId: string): Promise<Approval> {
    const principal = await this.requirePrincipal();
    const id = approvalIdSchema.parse(approvalId);
    const current = await this.repositories.approvals.getById(id);
    const policyVersion = await this.requirePolicy(
      principal,
      current.runId,
      current.actionType,
      "revoke",
    );
    const revokedAt = this.now();
    const approval = await this.repositories.approvals.revoke(id, principal.id, revokedAt);
    await this.repositories.events.append({
      runId: current.runId,
      type: "approval.revoked",
      occurredAt: revokedAt,
      data: { approvalId: id, principalId: principal.id, policyVersion },
    });
    return approval;
  }

  private async requirePrincipal(): Promise<AuthenticatedPrincipal> {
    if (!this.principals)
      throw new ApprovalAuthorizationError("Trusted authentication is unavailable");
    const principal = await this.principals.currentPrincipal();
    if (!principal) throw new ApprovalAuthorizationError("Authenticated principal is required");
    principalIdSchema.parse(principal.id);
    return principal;
  }

  private async requirePolicy(
    principal: AuthenticatedPrincipal,
    runId: string,
    actionType: string,
    operation: ApprovalOperation,
  ): Promise<string> {
    if (!this.policy) throw new ApprovalAuthorizationError("Approval policy is unavailable");
    const version = await this.policyVersion();
    const allowed = await this.policy.authorize({ principal, runId, actionType, operation });
    if (!allowed) throw new ApprovalAuthorizationError();
    return version;
  }

  private async policyVersion(): Promise<string> {
    if (!this.policy) throw new ApprovalAuthorizationError("Approval policy is unavailable");
    return policyVersionSchema.parse(await this.policy.currentVersion());
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApprovalAuthorizationError("Authorization was cancelled");
}
