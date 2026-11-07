import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  adapterConfigSchema,
  type AdapterConfig,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentResult,
  type AgentSession,
  type IsolatedRuntime,
  type NormalizedAgentEvent,
} from "./contracts.js";
import { redactEventSecrets } from "@agentos/core";

export interface ProcessProbe {
  version(executable: string): Promise<string | null>;
}
const execFileAsync = promisify(execFile);
export const systemProcessProbe: ProcessProbe = {
  async version(executable) {
    try {
      const result = await execFileAsync(executable, ["--version"], {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 16_384,
      });
      return parseOpenCodeVersion(`${result.stdout} ${result.stderr}`);
    } catch {
      return null;
    }
  },
};
const versionPattern = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/;
export function parseOpenCodeVersion(output: string): string | null {
  return output.match(versionPattern)?.slice(1).join(".") ?? null;
}
export function normalizeOpenCodeEvent(
  raw: unknown,
  at = new Date().toISOString(),
): NormalizedAgentEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as { id?: unknown; type?: unknown; properties?: Record<string, unknown> };
  const p = event.properties;
  if (typeof event.type !== "string" || !p) return null;
  const sourceEvent = typeof event.id === "string" ? { sourceEventId: event.id } : {};
  const sessionId = typeof p["sessionID"] === "string" ? p["sessionID"] : "";
  const callId = typeof p["callID"] === "string" ? p["callID"] : undefined;
  const tool = typeof p["tool"] === "string" ? p["tool"] : "unknown";
  const eventTypes: Record<string, NormalizedAgentEvent["type"]> = {
    "session.created": "session.created",
    "session.updated": "session.updated",
    "session.next.step.started": "message.started",
    "session.next.text.started": "message.started",
    "session.next.text.ended": "message.completed",
    "session.execution.succeeded": "run.completed",
    "session.execution.failed": "run.failed",
    "session.next.step.failed": "run.failed",
  };
  const basic = eventTypes[event.type];
  if (basic && sessionId)
    return {
      type: basic as
        | "session.created"
        | "session.updated"
        | "message.started"
        | "message.completed"
        | "run.completed"
        | "run.failed",
      sessionId,
      at,
      ...sourceEvent,
    };
  if (
    (event.type === "session.next.tool.called" || event.type === "session.tool.called") &&
    sessionId
  )
    return {
      type: "tool.started",
      sessionId,
      at,
      tool,
      ...(callId ? { callId } : {}),
      ...sourceEvent,
    };
  if (
    (event.type === "session.next.tool.success" || event.type === "session.tool.success") &&
    sessionId
  )
    return {
      type: "tool.completed",
      sessionId,
      at,
      tool,
      ...(callId ? { callId } : {}),
      ...sourceEvent,
    };
  if (event.type === "session.next.tool.failed" && sessionId)
    return {
      type: "tool.failed",
      sessionId,
      at,
      tool,
      ...(callId ? { callId } : {}),
      error: "OpenCode tool failed",
      ...sourceEvent,
    };
  if (event.type === "file.edited" && typeof p["file"] === "string")
    return { type: "file.changed", sessionId, at, path: p["file"], ...sourceEvent };
  if (
    (event.type === "permission.v2.asked" || event.type === "permission.asked") &&
    sessionId &&
    typeof p["id"] === "string"
  ) {
    const action =
      typeof p["action"] === "string"
        ? p["action"]
        : typeof p["permission"] === "string"
          ? p["permission"]
          : "permission";
    const resources = Array.isArray(p["resources"])
      ? p["resources"].filter((x): x is string => typeof x === "string")
      : Array.isArray(p["patterns"])
        ? p["patterns"].filter((x): x is string => typeof x === "string")
        : [];
    return {
      type: "permission.requested",
      sessionId,
      at,
      permissionId: p["id"],
      action,
      resources,
      ...sourceEvent,
    };
  }
  return null;
}
function supported(version: string | null): boolean {
  if (!version) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 1 && ((minor ?? 0) > 1 || ((minor ?? 0) === 1 && (patch ?? 0) >= 1));
}

/** Extract only user-facing text parts from the SDK's completed assistant response. */
export function extractOpenCodeFinalText(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter(
      (part): part is { type: "text"; text: string; synthetic?: boolean; ignored?: boolean } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string" &&
        !("synthetic" in part && part.synthetic === true) &&
        !("ignored" in part && part.ignored === true),
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return text ? redactEventSecrets(text).slice(0, 20_000) : null;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  private sessions = new Map<string, string>();
  private runtimes = new Map<
    string,
    Awaited<ReturnType<NonNullable<IsolatedRuntime>["allocate"]>>
  >();
  private clients = new Map<string, OpencodeClient>();
  constructor(
    private readonly runtime: IsolatedRuntime | undefined,
    private readonly probe: ProcessProbe = systemProcessProbe,
    private readonly makeClient = createOpencodeClient,
  ) {}
  validate(input: unknown): AdapterConfig {
    return adapterConfigSchema.parse(input);
  }
  capabilities(): AgentCapabilities {
    return {
      sessionCreate: true,
      sessionResume: true,
      streamingEvents: true,
      cancellation: true,
      isolatedExecution: this.runtime !== undefined,
    };
  }
  async detect(
    config: AdapterConfig,
  ): Promise<{ installed: boolean; version: string | null; reason?: string }> {
    const detected = this.runtime?.detect
      ? await this.runtime.detect()
      : { installed: true, version: await this.probe.version(config.executablePath ?? "opencode") };
    const version = detected.version;
    return {
      installed: detected.installed && version !== null && supported(version),
      version,
      ...(version && !supported(version)
        ? { reason: "Unsupported OpenCode version; supported versions are >=1.1.1 and <2.0.0" }
        : {}),
    };
  }
  async health(config: AdapterConfig): Promise<{ healthy: boolean; version?: string }> {
    if (!config.serverUrl) return { healthy: false };
    try {
      const server = new URL(config.serverUrl);
      if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(server.hostname))
        return { healthy: false };
      const r = await fetch(new URL("/global/health", server));
      if (!r.ok) return { healthy: false };
      const body: unknown = await r.json();
      const v =
        typeof body === "object" && body !== null && "version" in body
          ? String(body.version)
          : undefined;
      return {
        healthy: v ? supported(parseOpenCodeVersion(v) ?? v) : true,
        ...(v ? { version: v } : {}),
      };
    } catch {
      return { healthy: false };
    }
  }
  private async connect(
    config: AdapterConfig,
    runId: string,
    leaseGeneration = 1,
  ): Promise<OpencodeClient> {
    const existing = this.clients.get(runId);
    if (existing) return existing;
    const isolated = await this.runtime?.allocate(config, runId, leaseGeneration);
    if (!isolated)
      throw new Error("OpenCode execution unavailable: no verified isolated runtime configured");
    try {
      const endpoint = new URL(isolated.serverUrl);
      if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname))
        throw new Error("Isolated OpenCode server must bind to loopback");
      if (
        isolated.workspacePath.toLocaleLowerCase() === config.projectDirectory.toLocaleLowerCase()
      )
        throw new Error("Isolated workspace cannot be the source repository");
      if (!supported(isolated.adapterVersion))
        throw new Error("Docker image contains an unsupported OpenCode version");
      const client = this.makeClient({
        baseUrl: isolated.serverUrl,
        directory: isolated.workspacePath,
        headers: { authorization: isolated.authorizationHeader },
      });
      this.runtimes.set(runId, isolated);
      this.clients.set(runId, client);
      return client;
    } catch (error) {
      await isolated.dispose();
      throw error;
    }
  }
  async initializeSession(
    config: AdapterConfig,
    runId: string,
    leaseGeneration = 1,
  ): Promise<AgentSession> {
    const c = await this.connect(config, runId, leaseGeneration);
    try {
      const created = await c.session.create({
        body: { title: `AgentOS run ${runId}` },
        query: { directory: this.runtimes.get(runId)!.workspacePath },
        throwOnError: true,
      });
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode returned no session identifier");
      this.sessions.set(runId, id);
      const allocation = this.runtimes.get(runId)!;
      return {
        id,
        runId,
        leaseGeneration,
        createdAt: new Date().toISOString(),
        adapterVersion: allocation.adapterVersion,
        baseCommit: allocation.baseCommit,
        workspacePath: allocation.workspacePath,
        runtimeConfiguration: allocation.runtimeConfiguration,
      };
    } catch (error) {
      const runtime = this.runtimes.get(runId);
      this.runtimes.delete(runId);
      this.clients.delete(runId);
      await runtime?.dispose();
      throw error;
    }
  }
  async resumeSession(
    config: AdapterConfig,
    sessionId: string,
    runId: string,
  ): Promise<AgentSession> {
    const c = await this.connect(config, runId);
    const existing = await c.session.get({
      path: { id: sessionId },
      query: { directory: this.runtimes.get(runId)!.workspacePath },
      throwOnError: true,
    });
    if (!existing.data?.id) throw new Error("OpenCode session was not found");
    this.sessions.set(runId, sessionId);
    const allocation = this.runtimes.get(runId)!;
    return {
      id: sessionId,
      runId,
      createdAt: new Date().toISOString(),
      adapterVersion: allocation.adapterVersion,
      baseCommit: allocation.baseCommit,
      workspacePath: allocation.workspacePath,
      runtimeConfiguration: allocation.runtimeConfiguration,
    };
  }
  async execute(
    config: AdapterConfig,
    session: AgentSession,
    instruction: string,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const c = await this.connect(config, session.runId);
    const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const combined = AbortSignal.any([signal, timeout]);
    let response;
    try {
      response = await c.session.prompt({
        path: { id: session.id },
        query: { directory: this.runtimes.get(session.runId)!.workspacePath },
        body: {
          ...(config.model ? { model: config.model } : {}),
          parts: [{ type: "text", text: instruction }],
        },
        throwOnError: true,
        signal: combined,
      });
    } catch (error) {
      if (combined.aborted) await this.runtimes.get(session.runId)?.cancel();
      throw error;
    }
    const info = response.data?.info as { time?: { completed?: number } } | undefined;
    return {
      status: "succeeded",
      summary: info?.time?.completed ? extractOpenCodeFinalText(response.data?.parts) : null,
      changedFiles: [],
      diff: null,
      fileHashes: {},
    };
  }
  async *stream(
    config: AdapterConfig,
    session: AgentSession,
    signal: AbortSignal,
    onReady: () => void,
  ): AsyncIterable<NormalizedAgentEvent> {
    const c = await this.connect(config, session.runId);
    const result = await c.event.subscribe({ signal });
    onReady();
    for await (const raw of result.stream) {
      if (signal.aborted) break;
      const normalized = normalizeOpenCodeEvent(raw);
      if (normalized)
        yield normalized.sessionId ? normalized : { ...normalized, sessionId: session.id };
      // Reasoning and text deltas are deliberately discarded to keep private chain-of-thought out of AgentOS events.
    }
  }
  async cancel(config: AdapterConfig, session: AgentSession): Promise<void> {
    const c = await this.connect(config, session.runId);
    await c.session.abort({ path: { id: session.id }, throwOnError: true });
    await this.runtimes.get(session.runId)?.cancel();
  }
  async respondPermission(
    config: AdapterConfig,
    session: AgentSession,
    permissionId: string,
    approved: false,
  ): Promise<void> {
    if (approved !== false)
      throw new Error("This adapter path only supports policy-denied permissions");
    const c = await this.connect(config, session.runId);
    await c.postSessionIdPermissionsPermissionId({
      path: { id: session.id, permissionID: permissionId },
      query: { directory: this.runtimes.get(session.runId)!.workspacePath },
      body: { response: "reject" },
      throwOnError: true,
    });
  }
  async status(config: AdapterConfig, session: AgentSession): Promise<unknown> {
    const c = await this.connect(config, session.runId);
    const result = await c.session.get({
      path: { id: session.id },
      query: { directory: this.runtimes.get(session.runId)!.workspacePath },
      throwOnError: true,
    });
    return result.data;
  }
  async collectResults(_config: AdapterConfig, session: AgentSession): Promise<AgentResult> {
    const runtime = this.runtimes.get(session.runId);
    if (!runtime) throw new Error("No isolated runtime is attached to this run");
    return runtime.collectResults();
  }
  async recoverInterruptedRun(
    config: AdapterConfig,
    runId: string,
    workspacePath: string,
    previousGeneration?: number,
  ): Promise<void> {
    if (!this.runtime?.recover)
      throw new Error("Configured isolated runtime cannot reconcile interrupted runs");
    await this.runtime.recover(runId, config.projectDirectory, workspacePath, previousGeneration);
  }
  async closeSession(_config: AdapterConfig, session: AgentSession): Promise<void> {
    this.sessions.delete(session.runId);
    this.clients.delete(session.runId);
    const runtime = this.runtimes.get(session.runId);
    this.runtimes.delete(session.runId);
    await runtime?.dispose();
  }
  async dispose(): Promise<void> {
    const allocated = [...this.runtimes.values()];
    this.runtimes.clear();
    this.clients.clear();
    await Promise.all(allocated.map((runtime) => runtime.dispose()));
    this.sessions.clear();
  }
}
