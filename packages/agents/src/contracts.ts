import { z } from "zod";

export const agentCapabilitiesSchema = z
  .object({
    sessionCreate: z.boolean(),
    sessionResume: z.boolean(),
    streamingEvents: z.boolean(),
    cancellation: z.boolean(),
    isolatedExecution: z.boolean(),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const adapterConfigSchema = z
  .object({
    executablePath: z.string().min(1).optional(),
    serverUrl: z.string().url().optional(),
    projectDirectory: z.string().min(1),
    model: z
      .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
      .strict()
      .optional(),
    permissionMode: z.enum(["read_only", "supervised", "autonomous"]),
    timeoutSeconds: z.number().int().positive().max(86400).default(3600),
    environment: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const key of Object.keys(v.environment)) {
      if (/key|token|secret|password|credential|auth/i.test(key))
        ctx.addIssue({
          code: "custom",
          path: ["environment", key],
          message: "Secret environment variables must be passed through a credential broker",
        });
    }
  });
export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export interface AgentSession {
  id: string;
  runId: string;
  createdAt: string;
}
export interface AgentResult {
  status: "succeeded" | "failed" | "cancelled";
  summary: string | null;
  changedFiles: string[];
  diff: string | null;
}
export type NormalizedAgentEvent =
  | {
      type:
        | "session.created"
        | "session.updated"
        | "message.started"
        | "message.completed"
        | "run.completed"
        | "run.failed";
      sessionId: string;
      at: string;
    }
  | {
      type: "tool.started" | "tool.completed";
      sessionId: string;
      at: string;
      tool: string;
      callId?: string;
    }
  | {
      type: "tool.failed";
      sessionId: string;
      at: string;
      tool: string;
      callId?: string;
      error: string;
    }
  | { type: "file.changed"; sessionId: string; at: string; path: string }
  | {
      type: "permission.requested";
      sessionId: string;
      at: string;
      permissionId: string;
      action: string;
      resources: string[];
    };

export interface AgentAdapter {
  readonly id: string;
  detect(
    config: AdapterConfig,
  ): Promise<{ installed: boolean; version: string | null; reason?: string }>;
  health(config: AdapterConfig): Promise<{ healthy: boolean; version?: string }>;
  capabilities(): AgentCapabilities;
  validate(config: unknown): AdapterConfig;
  initializeSession(config: AdapterConfig, runId: string): Promise<AgentSession>;
  resumeSession(config: AdapterConfig, sessionId: string, runId: string): Promise<AgentSession>;
  closeSession(config: AdapterConfig, session: AgentSession): Promise<void>;
  execute(
    config: AdapterConfig,
    session: AgentSession,
    instruction: string,
    signal: AbortSignal,
  ): Promise<AgentResult>;
  stream(config: AdapterConfig, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent>;
  cancel(config: AdapterConfig, session: AgentSession): Promise<void>;
  status(config: AdapterConfig, session: AgentSession): Promise<unknown>;
  collectResults(config: AdapterConfig, session: AgentSession): Promise<AgentResult>;
  dispose(): Promise<void>;
}

export interface IsolatedRuntime {
  /** Must create a run-scoped OS sandbox; this is never optional during execution. */
  assertIsolated(config: AdapterConfig): Promise<{ workspacePath: string; serverUrl: string }>;
}
