import { createHash, randomUUID } from "node:crypto";
import {
  redactEventSecrets,
  type Agent,
  type AgentEvent,
  type CreateAgentEvent,
  type ExecutionRun,
  type ExecutionRunId,
  type Project,
  type Task,
  type RepositorySet,
} from "@agentos/core";
import { RepositoryConflictError } from "@agentos/database";
import { AdapterRegistry } from "./registry.js";
import type {
  AgentAdapter,
  AdapterConfig,
  AgentResult,
  AgentSession,
  NormalizedAgentEvent,
} from "./contracts.js";

export interface StartTaskInput {
  taskId: string;
  agentId: string;
  runId?: string;
  providerId?: string | null;
  /** AgentOS provider ID/model never configure OpenCode; this must match the agent config independently. */
  modelId?: string | null;
  signal?: AbortSignal;
}

export interface ExecutionOutcome {
  run: ExecutionRun;
  result: AgentResult | null;
  error: string | null;
}

export class ExecutionCoordinator {
  constructor(
    private readonly repositories: RepositorySet,
    private readonly adapters: AdapterRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Call once during single-worker startup, before accepting new tasks. Active runs are failed
   * rather than replayed because the adapter prompt may have performed non-idempotent work.
   */
  async recoverInterruptedRuns(): Promise<ExecutionRun[]> {
    const activeStatuses: ExecutionRun["status"][] = [
      "created",
      "validating",
      "preparing_workspace",
      "queued",
      "running",
      "waiting_for_approval",
    ];
    const recovered: ExecutionRun[] = [];
    for (const status of activeStatuses) {
      const attempted = new Set<string>();
      while (true) {
        const page = await this.repositories.runs.list({ status, limit: 200, offset: 0 });
        const candidates = page.items.filter((candidate) => !attempted.has(candidate.id));
        if (candidates.length === 0) break;
        for (const candidate of candidates) {
          attempted.add(candidate.id);
          try {
            let recoveryError: string | null = null;
            if (candidate.workspaceId) {
              try {
                const project = await this.repositories.projects.getById(candidate.projectId);
                const agent = await this.repositories.agents.getById(candidate.agentId);
                const adapter = this.adapters.get(agent.adapterId);
                const config = adapter.validate({
                  ...agent.configuration,
                  projectDirectory: project.repositoryPath,
                  permissionMode: project.settings.permissionMode,
                });
                if (!adapter.recoverInterruptedRun)
                  throw new Error("Adapter has no interrupted-run cleanup implementation");
                await adapter.recoverInterruptedRun(config, candidate.id, candidate.workspaceId);
              } catch (error) {
                recoveryError = safeMessage(error);
              }
            }
            const message = recoveryError
              ? `Execution interrupted by process restart; automatic replay is disabled. Runtime cleanup failed: ${recoveryError}`
              : "Execution interrupted by process restart; automatic replay is disabled";
            const run = await this.repositories.runs.update(candidate.id, {
              status: "failed",
              completedAt: candidate.startedAt ? this.now() : null,
              error: message,
            });
            await this.append({
              runId: run.id,
              type: "run.failed",
              occurredAt: this.now(),
              data: {
                code: "PROCESS_INTERRUPTED",
                message: run.error!,
              },
            });
            recovered.push(run);
          } catch (error) {
            if (!(error instanceof RepositoryConflictError)) {
              const current = await this.repositories.runs.getById(candidate.id);
              if (!isTerminal(current.status)) throw error;
            }
            // Another recovery/worker changed this run after our snapshot; keep the winning state.
          }
        }
      }
    }
    return recovered;
  }

  async startTask(input: StartTaskInput): Promise<ExecutionOutcome> {
    const task = await this.repositories.tasks.getById(input.taskId);
    const project = await this.repositories.projects.getById(task.projectId);
    const agent = await this.repositories.agents.getById(input.agentId);
    if (!agent.enabled) throw new Error("Selected agent is disabled");
    if (task.assignedAgentId && task.assignedAgentId !== agent.id)
      throw new Error("Selected agent differs from task assignment");
    if (task.status === "completed" || task.status === "cancelled")
      throw new Error("Cannot execute a terminal task");
    if (input.providerId) {
      const provider = await this.repositories.providers.getById(input.providerId);
      if (!provider.enabled) throw new Error("Selected provider is disabled");
      if (input.modelId && !provider.availableModels.includes(input.modelId))
        throw new Error("Selected model is not registered for this provider");
    }
    const adapter = this.adapters.get(agent.adapterId);
    const config = adapter.validate({
      ...agent.configuration,
      projectDirectory: project.repositoryPath,
      permissionMode: project.settings.permissionMode,
    });
    const id = input.runId ?? randomUUID();
    const run = await this.repositories.runs.create(
      {
        taskId: task.id,
        projectId: project.id,
        agentId: agent.id,
        adapterVersion: agent.version,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? config.model?.modelID ?? null,
        status: "created",
        manifestId: null,
        workspaceId: null,
        startedAt: null,
        completedAt: null,
        error: null,
        usageMetrics: {},
      },
      id,
    );
    await this.append({
      runId: run.id,
      type: "run.created",
      occurredAt: this.now(),
      data: { taskId: task.id },
    });
    return this.executeCreated(run, task, project, agent, adapter, config, input.signal);
  }

  private async executeCreated(
    created: ExecutionRun,
    task: Task,
    project: Project,
    agent: Agent,
    adapter: AgentAdapter,
    config: AdapterConfig,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    let run = created;
    let session: AgentSession | undefined;
    let result: AgentResult | null = null;
    let streamAbort: AbortController | undefined;
    let streamTask: Promise<void> | undefined;
    let sessionClosed = false;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      run = await this.transition(run, "validating");
      if (project.settings.permissionMode !== "read_only")
        throw new Error(
          "Supervised/autonomous execution is unavailable until AgentOS approval enforcement exists",
        );
      const detected = await adapter.detect(config);
      if (!detected.installed || !detected.version)
        throw new Error(detected.reason ?? "OpenCode installation or runtime image is unavailable");
      run = await this.repositories.runs.update(run.id, { adapterVersion: detected.version });

      run = await this.transition(run, "preparing_workspace");
      run = await this.transition(run, "queued");
      session = await adapter.initializeSession(config, run.id);
      run = await this.repositories.runs.update(run.id, {
        adapterVersion: session.adapterVersion,
        workspaceId: session.workspacePath,
      });
      await this.persistManifest(run, task, project, agent, config, session);
      await this.append({
        runId: run.id,
        type: "session.attached",
        occurredAt: this.now(),
        data: { sessionId: session.id },
      });

      run = await this.transition(run, "running", { startedAt: this.now() });
      await this.append({ runId: run.id, type: "run.started", occurredAt: this.now(), data: {} });
      streamAbort = new AbortController();
      let streamError: unknown;
      let markStreamReady!: () => void;
      const streamReady = new Promise<void>((resolve) => {
        markStreamReady = resolve;
      });
      streamTask = this.ingestEvents(
        adapter,
        config,
        session,
        run.id,
        streamAbort.signal,
        markStreamReady,
      ).catch((error: unknown) => {
        if (!streamAbort?.signal.aborted) streamError = error;
        markStreamReady();
      });
      await streamReady;
      if (streamError) throw streamError;
      result = await adapter.execute(
        config,
        session,
        `${task.title}\n\n${task.description}`,
        controller.signal,
      );
      streamAbort.abort();
      await streamTask;
      if (streamError) throw streamError;
      const completedResult = await adapter.collectResults(config, session);
      result = completedResult;
      await adapter.closeSession(config, session);
      sessionClosed = true;
      const diffSha256 =
        completedResult.diff === null
          ? null
          : createHash("sha256").update(completedResult.diff).digest("hex");
      await this.append({
        runId: run.id,
        type: "run.result",
        occurredAt: this.now(),
        data: {
          summary: completedResult.summary,
          diffSha256,
          files: completedResult.changedFiles.map((path) => ({
            path,
            sha256: completedResult.fileHashes[path] ?? null,
          })),
        },
      });
      run = await this.transition(run, "succeeded", { completedAt: this.now() });
      await this.append({
        runId: run.id,
        type: "run.completed",
        occurredAt: this.now(),
        data: { summary: completedResult.summary },
      });
      return { run, result, error: null };
    } catch (error) {
      streamAbort?.abort();
      await streamTask?.catch(() => undefined);
      if (session && !sessionClosed) {
        if (controller.signal.aborted) await adapter.cancel(config, session).catch(() => undefined);
        await adapter.closeSession(config, session).catch(() => undefined);
        sessionClosed = true;
      }
      const message = safeMessage(error);
      const current = await this.repositories.runs.getById(run.id);
      if (!isTerminal(current.status)) {
        const status = controller.signal.aborted ? "cancelled" : "failed";
        run = await this.repositories.runs.update(run.id, {
          status,
          completedAt: current.startedAt ? this.now() : null,
          error: message,
        });
        if (status === "cancelled")
          await this.append({
            runId: run.id,
            type: "run.cancelled",
            occurredAt: this.now(),
            data: { reason: message },
          });
        else
          await this.append({
            runId: run.id,
            type: "run.failed",
            occurredAt: this.now(),
            data: { code: "EXECUTION_FAILED", message },
          });
      }
      return { run, result, error: message };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async persistManifest(
    run: ExecutionRun,
    task: Task,
    project: Project,
    agent: Agent,
    config: AdapterConfig,
    session: AgentSession,
  ): Promise<void> {
    const promptConfigurationHash = createHash("sha256")
      .update(
        JSON.stringify({
          task: {
            title: task.title,
            description: task.description,
            configuration: task.configuration,
          },
          model: config.model,
          timeoutSeconds: config.timeoutSeconds,
        }),
      )
      .digest("hex");
    await this.repositories.manifests.create({
      version: 1,
      runId: run.id,
      agentId: agent.id,
      agentName: agent.name,
      adapterId: agent.adapterId,
      adapterVersion: session.adapterVersion,
      providerId: run.providerId,
      modelId: run.modelId,
      promptConfigurationHash,
      repositoryCommitSha: session.baseCommit,
      toolVersions: { opencode: session.adapterVersion },
      skillVersions: {},
      runtimeConfiguration: session.runtimeConfiguration,
      permissionConfiguration: project.settings,
      environmentVariableNames: Object.keys(config.environment),
    });
  }

  private async transition(
    current: ExecutionRun,
    status: ExecutionRun["status"],
    extra: Partial<Pick<ExecutionRun, "startedAt" | "completedAt">> = {},
  ): Promise<ExecutionRun> {
    const run = await this.repositories.runs.update(current.id, { status, ...extra });
    await this.append({
      runId: run.id,
      type: "agent.status",
      occurredAt: this.now(),
      data: { status, message: null },
    });
    return run;
  }

  private async append(
    input: CreateAgentEvent,
    deterministicId?: string,
  ): Promise<AgentEvent | null> {
    try {
      return await this.repositories.events.append(input, deterministicId);
    } catch (error) {
      if (deterministicId && error instanceof RepositoryConflictError) return null;
      throw error;
    }
  }

  private async ingestEvents(
    adapter: AgentAdapter,
    config: AdapterConfig,
    session: AgentSession,
    runId: ExecutionRunId,
    signal: AbortSignal,
    onReady: () => void,
  ): Promise<void> {
    for await (const event of adapter.stream(config, session, signal, onReady)) {
      if (signal.aborted) break;
      if (event.sessionId !== session.id) continue;
      const id = event.sourceEventId ? stableEventId(runId, event.sourceEventId) : undefined;
      if (event.type === "tool.started" && event.callId)
        await this.append(
          {
            runId,
            type: "tool.started",
            occurredAt: event.at,
            data: { toolName: event.tool, callId: event.callId },
          },
          id,
        );
      else if (event.type === "tool.completed" && event.callId)
        await this.append(
          {
            runId,
            type: "tool.completed",
            occurredAt: event.at,
            data: { toolName: event.tool, callId: event.callId, exitCode: null },
          },
          id,
        );
      else if (event.type === "tool.failed" && event.callId)
        await this.append(
          {
            runId,
            type: "tool.failed",
            occurredAt: event.at,
            data: { toolName: event.tool, callId: event.callId, error: event.error },
          },
          id,
        );
      else if (event.type === "file.changed")
        await this.append(
          { runId, type: "file.changed", occurredAt: event.at, data: { path: event.path } },
          id,
        );
      else if (event.type === "permission.requested")
        await this.rejectPermission(adapter, config, session, runId, event);
    }
  }

  private async rejectPermission(
    adapter: AgentAdapter,
    config: AdapterConfig,
    session: AgentSession,
    runId: ExecutionRunId,
    event: Extract<NormalizedAgentEvent, { type: "permission.requested" }>,
  ): Promise<void> {
    const requestedAt = event.at;
    const description = redactEventSecrets(`${event.action}: ${event.resources.join(", ")}`).slice(
      0,
      20_000,
    );
    const resources = redactEventSecrets(event.resources.slice(0, 256));
    const approvalId = event.sourceEventId
      ? stableEventId(runId, `approval:${event.sourceEventId}`)
      : undefined;
    let approval;
    try {
      approval = await this.repositories.approvals.create(
        {
          runId,
          actionType: event.action.slice(0, 128),
          actionDescription: description || "OpenCode requested a permission",
          requestedPermissions: resources,
          status: "pending",
          requestedAt,
          resolvedAt: null,
          resolvedBy: null,
        },
        approvalId,
      );
    } catch (error) {
      if (!(approvalId && error instanceof RepositoryConflictError)) throw error;
      approval = await this.repositories.approvals.getById(approvalId);
    }
    if (approval.status === "pending")
      approval = await this.repositories.approvals.resolve(
        approval.id,
        "rejected",
        "agentos-policy:read_only",
      );
    const eventKey = event.sourceEventId ? `permission:${event.sourceEventId}` : undefined;
    await this.append(
      {
        runId,
        type: "approval.requested",
        occurredAt: requestedAt,
        data: { approvalId: approval.id, actionType: approval.actionType },
      },
      eventKey ? stableEventId(runId, `${eventKey}:requested`) : undefined,
    );
    await this.append(
      {
        runId,
        type: "approval.rejected",
        occurredAt: approval.resolvedAt!,
        data: { approvalId: approval.id, resolvedBy: approval.resolvedBy! },
      },
      eventKey ? stableEventId(runId, `${eventKey}:rejected`) : undefined,
    );
    await adapter.respondPermission(config, session, event.permissionId, false);
  }
}

function stableEventId(runId: string, source: string): string {
  const bytes = createHash("sha256").update(`${runId}:${source}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeMessage(error: unknown): string {
  return redactEventSecrets(error instanceof Error ? error.message : String(error)).slice(
    0,
    20_000,
  );
}

function isTerminal(status: ExecutionRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
