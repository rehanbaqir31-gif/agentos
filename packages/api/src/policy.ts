import type { ApprovalPolicy, AuthenticatedPrincipal } from "@agentos/agents";
import {
  ApprovalAuthorizationError,
  ApprovalAuthorizationService,
  ExecutionAuthorizationService,
  type ApprovalOperation,
} from "@agentos/agents";
import type { RepositorySet } from "@agentos/core";
import { requestPrincipalSource } from "./principal-context.js";

const localPolicyVersion = "agentos-local-policy-v1";

/** Explicit single-operator local policy. It never authorizes write-capable execution. */
export class LocalAuthorizationPolicy implements ApprovalPolicy {
  constructor(private readonly repositories: RepositorySet) {}

  async authorize(input: {
    principal: AuthenticatedPrincipal;
    runId: string;
    actionType: string;
    operation: ApprovalOperation;
  }) {
    const principal = await this.repositories.auth.getPrincipal(input.principal.id);
    if (!principal || principal.disabledAt)
      return { authorized: false, version: localPolicyVersion };

    const run = await Promise.resolve(this.repositories.runs.getById(input.runId)).catch(
      () => null,
    );
    const task = run
      ? await Promise.resolve(this.repositories.tasks.getById(run.taskId)).catch(() => null)
      : await Promise.resolve(this.repositories.tasks.getById(input.runId)).catch(() => null);
    const projectId = run?.projectId ?? task?.projectId;
    if (!projectId) return { authorized: false, version: localPolicyVersion };
    const membership = await this.repositories.auth.getProjectMembership(projectId, principal.id);
    if (!membership) return { authorized: false, version: localPolicyVersion };

    if (input.operation === "execute") {
      const project = await this.repositories.projects.getById(projectId);
      return {
        authorized:
          input.actionType === "agent.execute.read_only" &&
          project.settings.permissionMode === "read_only" &&
          membership.role !== "viewer" &&
          !!task &&
          task.status !== "completed" &&
          task.status !== "cancelled",
        version: localPolicyVersion,
      };
    }

    if (!run || membership.role === "viewer")
      return { authorized: false, version: localPolicyVersion };
    if (input.operation === "consume") {
      // Grants remain storage-only while write-capable execution is disabled.
      return { authorized: false, version: localPolicyVersion };
    }
    if (input.operation === "grant" && !input.actionType.trim())
      return { authorized: false, version: localPolicyVersion };
    if (input.operation === "revoke") {
      const grants = await this.repositories.approvals.list(run.id, { limit: 200, offset: 0 });
      const grant = grants.items.find(
        (item) => item.principalId === principal.id && item.actionType === input.actionType,
      );
      if (!grant) return { authorized: false, version: localPolicyVersion };
    }
    return { authorized: true, version: localPolicyVersion };
  }
}

export function createLocalAuthorizationServices(repositories: RepositorySet, now?: () => string) {
  const policy = new LocalAuthorizationPolicy(repositories);
  return {
    policy,
    approvals: new ApprovalAuthorizationService(repositories, requestPrincipalSource, policy, now),
    execution: new ExecutionAuthorizationService(repositories, requestPrincipalSource, policy, now),
  };
}

export function assertProjectCapability(
  role: "owner" | "maintainer" | "viewer" | undefined,
  capability: "project.read" | "project.write" | "run.execute" | "approval.manage",
): void {
  const allowed =
    role === "owner" ||
    role === "maintainer" ||
    (role === "viewer" && capability === "project.read");
  if (!allowed) throw new ApprovalAuthorizationError("Project capability denied");
}
