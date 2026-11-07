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
  const event = raw as { type?: unknown; properties?: Record<string, unknown> };
  const p = event.properties;
  if (typeof event.type !== "string" || !p) return null;
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
    };
  if (
    (event.type === "session.next.tool.called" || event.type === "session.tool.called") &&
    sessionId
  )
    return { type: "tool.started", sessionId, at, tool, ...(callId ? { callId } : {}) };
  if (
    (event.type === "session.next.tool.success" || event.type === "session.tool.success") &&
    sessionId
  )
    return { type: "tool.completed", sessionId, at, tool, ...(callId ? { callId } : {}) };
  if (event.type === "session.next.tool.failed" && sessionId)
    return {
      type: "tool.failed",
      sessionId,
      at,
      tool,
      ...(callId ? { callId } : {}),
      error: "OpenCode tool failed",
    };
  if (event.type === "file.edited" && typeof p["file"] === "string")
    return { type: "file.changed", sessionId, at, path: p["file"] };
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
    };
  }
  return null;
}
function supported(version: string | null): boolean {
  if (!version) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 1 && ((minor ?? 0) > 1 || ((minor ?? 0) === 1 && (patch ?? 0) >= 1));
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  private client: OpencodeClient | undefined;
  private workspacePath: string | undefined;
  private sessions = new Map<string, string>();
  constructor(
    private readonly runtime: IsolatedRuntime | undefined,
    private readonly probe: ProcessProbe,
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
    const version = await this.probe.version(config.executablePath ?? "opencode");
    return {
      installed: version !== null && supported(version),
      version,
      ...(version && !supported(version)
        ? { reason: "Unsupported OpenCode version; supported versions are >=1.1.1 and <2.0.0" }
        : {}),
    };
  }
  async health(config: AdapterConfig): Promise<{ healthy: boolean; version?: string }> {
    if (!config.serverUrl) return { healthy: false };
    try {
      const r = await fetch(new URL("/global/health", config.serverUrl));
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
  private async connect(config: AdapterConfig): Promise<OpencodeClient> {
    const isolated = await this.runtime?.assertIsolated(config);
    if (!isolated)
      throw new Error("OpenCode execution unavailable: no verified isolated runtime configured");
    const endpoint = new URL(isolated.serverUrl);
    if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname))
      throw new Error("Isolated OpenCode server must bind to loopback");
    if (isolated.workspacePath.toLocaleLowerCase() === config.projectDirectory.toLocaleLowerCase())
      throw new Error("Isolated workspace cannot be the source repository");
    this.client = this.makeClient({
      baseUrl: isolated.serverUrl,
      directory: isolated.workspacePath,
    });
    this.workspacePath = isolated.workspacePath;
    return this.client;
  }
  async initializeSession(config: AdapterConfig, runId: string): Promise<AgentSession> {
    const c = await this.connect(config);
    const created = await c.session.create({
      body: { title: `AgentOS run ${runId}` },
      query: { directory: this.workspacePath! },
      throwOnError: true,
    });
    const id = created.data?.id;
    if (!id) throw new Error("OpenCode returned no session identifier");
    this.sessions.set(runId, id);
    return { id, runId, createdAt: new Date().toISOString() };
  }
  async resumeSession(
    config: AdapterConfig,
    sessionId: string,
    runId: string,
  ): Promise<AgentSession> {
    if (!this.client) await this.connect(config);
    const existing = await this.client!.session.get({
      path: { id: sessionId },
      query: { directory: this.workspacePath! },
      throwOnError: true,
    });
    if (!existing.data?.id) throw new Error("OpenCode session was not found");
    this.sessions.set(runId, sessionId);
    return { id: sessionId, runId, createdAt: new Date().toISOString() };
  }
  async closeSession(config: AdapterConfig, session: AgentSession): Promise<void> {
    // OpenCode sessions are durable; DELETE removes their history. Closing an AgentOS handle
    // must not destroy that history, so only release this adapter's local association.
    void config;
    this.sessions.delete(session.runId);
  }
  async execute(
    config: AdapterConfig,
    session: AgentSession,
    instruction: string,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (!this.client) await this.connect(config);
    const c = this.client!;
    const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await c.session.prompt({
      path: { id: session.id },
      query: { directory: this.workspacePath! },
      body: {
        ...(config.model ? { model: config.model } : {}),
        parts: [{ type: "text", text: instruction }],
      },
      throwOnError: true,
      signal: combined,
    });
    const info = response.data?.info as { time?: { completed?: number } } | undefined;
    return {
      status: "succeeded",
      summary: info?.time?.completed ? "OpenCode session completed" : null,
      changedFiles: [],
      diff: null,
    };
  }
  async *stream(config: AdapterConfig, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    if (!this.client) await this.connect(config);
    const result = await this.client!.event.subscribe({ signal });
    for await (const raw of result.stream) {
      if (signal.aborted) break;
      const normalized = normalizeOpenCodeEvent(raw);
      if (normalized) yield normalized;
      // Reasoning and text deltas are deliberately discarded to keep private chain-of-thought out of AgentOS events.
    }
  }
  async cancel(config: AdapterConfig, session: AgentSession): Promise<void> {
    if (!this.client) await this.connect(config);
    await this.client!.session.abort({ path: { id: session.id }, throwOnError: true });
  }
  async status(config: AdapterConfig, session: AgentSession): Promise<unknown> {
    if (!this.client) await this.connect(config);
    const result = await this.client!.session.get({
      path: { id: session.id },
      query: { directory: this.workspacePath! },
      throwOnError: true,
    });
    return result.data;
  }
  async collectResults(): Promise<AgentResult> {
    throw new Error("Git results must be collected by the AgentOS workspace manager");
  }
  async dispose(): Promise<void> {
    this.client = undefined;
    this.workspacePath = undefined;
    this.sessions.clear();
  }
}
