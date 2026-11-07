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
  type RunLeaseIdentity,
} from "@agentos/core";
import { RepositoryConflictError } from "@agentos/database";
import { AdapterRegistry } from "./registry.js";
import { ArtifactService } from "./artifact-service.js";
import type { RunManifest } from "@agentos/core";
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
  private readonly workerId = `agentos-worker-${randomUUID()}`;
  constructor(
    private readonly repositories: RepositorySet,
    private readonly adapters: AdapterRegistry,
    private readonly artifacts: ArtifactService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Claims only runs whose prior lease is absent, released or expired. Prompts are never replayed. */
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
          const claimed = await this.repositories.leases.claim(
            candidate.id,
            this.workerId,
            this.now(),
            new Date(Date.now() + 300_000).toISOString(),
          );
          if (!claimed) continue;
          const identity: RunLeaseIdentity = {
            workerId: claimed.lease.workerId,
            generation: claimed.lease.generation,
          };
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
                await adapter.recoverInterruptedRun(
                  config,
                  candidate.id,
                  candidate.workspaceId,
                  claimed.previousGeneration ?? undefined,
                );
              } catch (error) {
                recoveryError = safeMessage(error);
              }
            }
            const message = recoveryError
              ? `Execution interrupted by process restart; automatic replay is disabled. Runtime cleanup failed: ${recoveryError}`
              : "Execution interrupted by process restart; automatic replay is disabled";
            const run = await this.repositories.runs.updateOwned(
              candidate.id,
              {
                status: "failed",
                completedAt: candidate.startedAt ? this.now() : null,
                error: message,
              },
              identity,
              this.now(),
            );
            await this.append(
              {
                runId: run.id,
                type: "run.recovered",
                occurredAt: this.now(),
                data: {
                  workerId: identity.workerId,
                  generation: identity.generation,
                  previousGeneration: claimed.previousGeneration,
                  cleanupErrors: recoveryError ? [recoveryError] : [],
                },
              },
              undefined,
              identity,
            );
            await this.append(
              {
                runId: run.id,
                type: "run.failed",
                occurredAt: this.now(),
                data: {
                  code: "PROCESS_INTERRUPTED",
                  message: run.error!,
                },
              },
              undefined,
              identity,
            );
            recovered.push(run);
          } catch (error) {
            if (!(error instanceof RepositoryConflictError)) {
              const current = await this.repositories.runs.getById(candidate.id);
              if (!isTerminal(current.status)) throw error;
            }
            // Another recovery/worker changed this run after our snapshot; keep the winning state.
          } finally {
            await Promise.resolve(
              this.repositories.leases.release(candidate.id, identity, this.now()),
            ).catch(() => false);
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
    const { run, lease } = await this.repositories.runs.createWithLease(
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
      this.workerId,
      this.now(),
      new Date(Date.now() + 30_000).toISOString(),
      id,
    );
    const identity: RunLeaseIdentity = { workerId: lease.workerId, generation: lease.generation };
    await this.append(
      {
        runId: run.id,
        type: "run.created",
        occurredAt: this.now(),
        data: { taskId: task.id },
      },
      undefined,
      identity,
    );
    return this.executeCreated(run, task, project, agent, adapter, config, identity, input.signal);
  }

  private async executeCreated(
    created: ExecutionRun,
    task: Task,
    project: Project,
    agent: Agent,
    adapter: AgentAdapter,
    config: AdapterConfig,
    identity: RunLeaseIdentity,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    let run = created;
    let session: AgentSession | undefined;
    let result: AgentResult | null = null;
    let streamAbort: AbortController | undefined;
    let streamTask: Promise<void> | undefined;
    let sessionClosed = false;
    let manifest: RunManifest | undefined;
    let artifactsCaptured = false;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void Promise.resolve(
        this.repositories.leases.renew(
          run.id,
          identity,
          this.now(),
          new Date(Date.now() + 30_000).toISOString(),
        ),
      )
        .then((lease) => {
          if (!lease) controller.abort(new Error("Worker lease lost; run ownership fenced"));
        })
        .catch(() =>
          controller.abort(new Error("Worker lease renewal failed; run ownership fenced")),
        );
    }, 10_000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      run = await this.transition(run, "validating", identity);
      if (project.settings.permissionMode !== "read_only")
        throw new Error(
          "Supervised/autonomous execution is unavailable until AgentOS approval enforcement exists",
        );
      const detected = await adapter.detect(config);
      if (!detected.installed || !detected.version)
        throw new Error(detected.reason ?? "OpenCode installation or runtime image is unavailable");
      run = await this.repositories.runs.updateOwned(
        run.id,
        { adapterVersion: detected.version },
        identity,
        this.now(),
      );

      run = await this.transition(run, "preparing_workspace", identity);
      run = await this.transition(run, "queued", identity);
      session = await adapter.initializeSession(config, run.id, identity.generation);
      run = await this.repositories.runs.updateOwned(
        run.id,
        {
          adapterVersion: session.adapterVersion,
          workspaceId: session.workspacePath,
        },
        identity,
        this.now(),
      );
      manifest = await this.persistManifest(run, task, project, agent, config, session, identity);
      await this.append(
        {
          runId: run.id,
          type: "session.attached",
          occurredAt: this.now(),
          data: { sessionId: session.id },
        },
        undefined,
        identity,
      );

      run = await this.transition(run, "running", identity, { startedAt: this.now() });
      await this.append(
        { runId: run.id, type: "run.started", occurredAt: this.now(), data: {} },
        undefined,
        identity,
      );
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
        identity,
        streamAbort.signal,
        markStreamReady,
      ).catch((error: unknown) => {
        if (!streamAbort?.signal.aborted) streamError = error;
        markStreamReady();
      });
      await streamReady;
      if (streamError) throw streamError;
      const executionResult = await adapter.execute(
        config,
        session,
        `${task.title}\n\n${task.description}`,
        controller.signal,
      );
      streamAbort.abort();
      await streamTask;
      if (streamError) throw streamError;
      const completedResult = await adapter.collectResults(config, session);
      const finalResult = mergeResults(
        executionResult,
        completedResult,
        controller.signal.aborted
          ? "cancelled"
          : executionResult.status === "succeeded"
            ? completedResult.status
            : executionResult.status,
      );
      result = finalResult;
      const captured = await this.artifacts.capture(
        run.id,
        project.id,
        manifest,
        finalResult,
        identity,
      );
      artifactsCaptured = true;
      const diffSha256 =
        finalResult.diff === null
          ? null
          : createHash("sha256").update(finalResult.diff).digest("hex");
      await this.append(
        {
          runId: run.id,
          type: "run.result",
          occurredAt: this.now(),
          data: {
            summary: finalResult.summary,
            diffSha256,
            files: finalResult.changedFiles.map((path) => ({
              path,
              sha256: finalResult.fileHashes[path] ?? null,
            })),
            artifacts: captured.artifacts.map(
              ({ id, type, collectionStatus, byteSize, sha256 }) => ({
                id,
                type,
                collectionStatus,
                byteSize,
                sha256,
              }),
            ),
          },
        },
        undefined,
        identity,
      );
      if (captured.failures.length)
        throw new Error(
          `Required result artifact persistence failed: ${captured.failures.join("; ")}`,
        );
      if (controller.signal.aborted)
        throw new Error(safeMessage(controller.signal.reason ?? "Execution cancelled"));
      if (finalResult.status !== "succeeded")
        throw new Error(
          finalResult.terminationReason ?? "Agent reported an unsuccessful execution result",
        );
      await adapter.closeSession(config, session);
      sessionClosed = true;
      run = await this.transition(run, "succeeded", identity, { completedAt: this.now() });
      await this.append(
        {
          runId: run.id,
          type: "run.completed",
          occurredAt: this.now(),
          data: { summary: finalResult.summary },
        },
        undefined,
        identity,
      );
      return { run, result, error: null };
    } catch (error) {
      streamAbort?.abort();
      await streamTask?.catch(() => undefined);
      if (session && !sessionClosed) {
        if (controller.signal.aborted) await adapter.cancel(config, session).catch(() => undefined);
        if (manifest && !artifactsCaptured) {
          try {
            const partial = await adapter.collectResults(config, session);
            result = result
              ? mergeResults(result, partial, controller.signal.aborted ? "cancelled" : "failed")
              : { ...partial, status: controller.signal.aborted ? "cancelled" : "failed" };
            const partialResult = result;
            const captured = await this.artifacts.capture(
              run.id,
              project.id,
              manifest,
              partialResult,
              identity,
            );
            artifactsCaptured = true;
            await this.append(
              {
                runId: run.id,
                type: "run.result",
                occurredAt: this.now(),
                data: {
                  summary: result.summary,
                  diffSha256:
                    partialResult.diff === null
                      ? null
                      : createHash("sha256").update(partialResult.diff).digest("hex"),
                  files: partialResult.changedFiles.map((path) => ({
                    path,
                    sha256: partialResult.fileHashes[path] ?? null,
                  })),
                  artifacts: captured.artifacts.map(
                    ({ id, type, collectionStatus, byteSize, sha256 }) => ({
                      id,
                      type,
                      collectionStatus,
                      byteSize,
                      sha256,
                    }),
                  ),
                },
              },
              undefined,
              identity,
            );
          } catch {
            // Preserve the original run failure; incomplete capture remains visible through absent artifacts.
          }
        }
        await adapter.closeSession(config, session).catch(() => undefined);
        sessionClosed = true;
      }
      const message = result?.terminationReason ?? safeMessage(error);
      const current = await this.repositories.runs.getById(run.id);
      if (!isTerminal(current.status)) {
        const status =
          controller.signal.aborted || result?.status === "cancelled" ? "cancelled" : "failed";
        run = await this.repositories.runs.updateOwned(
          run.id,
          {
            status,
            completedAt: current.startedAt ? this.now() : null,
            error: message,
          },
          identity,
          this.now(),
        );
        if (status === "cancelled")
          await this.append(
            {
              runId: run.id,
              type: "run.cancelled",
              occurredAt: this.now(),
              data: { reason: message },
            },
            undefined,
            identity,
          );
        else {
          const code =
            result?.status === "timed_out"
              ? "EXECUTION_TIMED_OUT"
              : result?.status === "incomplete"
                ? "EXECUTION_INCOMPLETE"
                : "EXECUTION_FAILED";
          await this.append(
            {
              runId: run.id,
              type: "run.failed",
              occurredAt: this.now(),
              data: { code, message },
            },
            undefined,
            identity,
          );
        }
      }
      return { run, result, error: message };
    } finally {
      clearInterval(heartbeat);
      await Promise.resolve(this.repositories.leases.release(run.id, identity, this.now())).catch(
        () => false,
      );
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
    identity: RunLeaseIdentity,
  ): Promise<RunManifest> {
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
    return await this.repositories.manifests.createOwned(
      {
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
      },
      identity,
      this.now(),
    );
  }

  private async transition(
    current: ExecutionRun,
    status: ExecutionRun["status"],
    identity: RunLeaseIdentity,
    extra: Partial<Pick<ExecutionRun, "startedAt" | "completedAt">> = {},
  ): Promise<ExecutionRun> {
    const run = await this.repositories.runs.updateOwned(
      current.id,
      { status, ...extra },
      identity,
      this.now(),
    );
    await this.append(
      {
        runId: run.id,
        type: "agent.status",
        occurredAt: this.now(),
        data: { status, message: null },
      },
      undefined,
      identity,
    );
    return run;
  }

  private async append(
    input: CreateAgentEvent,
    deterministicId?: string,
    identity?: RunLeaseIdentity,
  ): Promise<AgentEvent | null> {
    try {
      return identity
        ? await this.repositories.events.appendOwned(input, identity, this.now(), deterministicId)
        : await this.repositories.events.append(input, deterministicId);
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
    identity: RunLeaseIdentity,
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
          identity,
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
          identity,
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
          identity,
        );
      else if (event.type === "file.changed")
        await this.append(
          { runId, type: "file.changed", occurredAt: event.at, data: { path: event.path } },
          id,
          identity,
        );
      else if (event.type === "permission.requested")
        await this.rejectPermission(adapter, config, session, runId, identity, event);
    }
  }

  private async rejectPermission(
    adapter: AgentAdapter,
    config: AdapterConfig,
    session: AgentSession,
    runId: ExecutionRunId,
    identity: RunLeaseIdentity,
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
      approval = await this.repositories.approvals.createOwned(
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
        identity,
        this.now(),
        approvalId,
      );
    } catch (error) {
      if (!(approvalId && error instanceof RepositoryConflictError)) throw error;
      approval = await this.repositories.approvals.getById(approvalId);
    }
    if (approval.status === "pending")
      approval = await this.repositories.approvals.resolveOwned(
        approval.id,
        "rejected",
        "agentos-policy:read_only",
        identity,
        this.now(),
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
      identity,
    );
    await this.append(
      {
        runId,
        type: "approval.rejected",
        occurredAt: approval.resolvedAt!,
        data: { approvalId: approval.id, resolvedBy: approval.resolvedBy! },
      },
      eventKey ? stableEventId(runId, `${eventKey}:rejected`) : undefined,
      identity,
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

function mergeResults(
  execution: AgentResult,
  collected: AgentResult,
  status: AgentResult["status"] = execution.status,
): AgentResult {
  return {
    ...collected,
    status,
    summary: execution.summary ?? collected.summary,
    stdout: execution.stdout ?? collected.stdout ?? null,
    stderr: execution.stderr ?? collected.stderr ?? null,
    exitCode: execution.exitCode ?? collected.exitCode ?? null,
    terminationReason: execution.terminationReason ?? collected.terminationReason ?? null,
    testResults: execution.testResults ?? collected.testResults ?? null,
    collectionErrors: [
      ...(execution.collectionErrors ?? []),
      ...(collected.collectionErrors ?? []),
    ],
  };
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
