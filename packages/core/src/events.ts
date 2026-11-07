import { z } from "zod";
import { agentEventIdSchema, approvalIdSchema, runIdSchema, taskIdSchema } from "./domain.js";

const timestamp = z.iso.datetime();
const base = {
  id: agentEventIdSchema,
  runId: runIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: timestamp,
};

export const agentEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("run.created"),
      data: z.object({ taskId: taskIdSchema }).strict(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("run.started"), data: z.object({}).strict() }).strict(),
  z
    .object({
      ...base,
      type: z.literal("run.completed"),
      data: z.object({ summary: z.string().max(20_000).nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("session.attached"),
      data: z.object({ sessionId: z.string().min(1).max(256) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("file.changed"),
      data: z.object({ path: z.string().min(1).max(4096) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("run.result"),
      data: z
        .object({
          summary: z.string().max(20_000).nullable(),
          diffSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/i)
            .nullable(),
          files: z
            .array(
              z
                .object({
                  path: z.string().min(1).max(4096),
                  sha256: z
                    .string()
                    .regex(/^[a-f0-9]{64}$/i)
                    .nullable(),
                })
                .strict(),
            )
            .max(10_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("run.failed"),
      data: z
        .object({ code: z.string().max(128).nullable(), message: z.string().max(20_000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("run.cancelled"),
      data: z.object({ reason: z.string().max(2_000).nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("agent.status"),
      data: z
        .object({ status: z.string().min(1).max(128), message: z.string().max(2_000).nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("tool.started"),
      data: z
        .object({ toolName: z.string().min(1).max(128), callId: z.string().max(256) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("tool.completed"),
      data: z
        .object({
          toolName: z.string().min(1).max(128),
          callId: z.string().max(256),
          exitCode: z.number().int().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("tool.failed"),
      data: z
        .object({
          toolName: z.string().min(1).max(128),
          callId: z.string().max(256),
          error: z.string().max(20_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("file.created"),
      data: z.object({ path: z.string().min(1).max(4096) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("file.modified"),
      data: z.object({ path: z.string().min(1).max(4096) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("file.deleted"),
      data: z.object({ path: z.string().min(1).max(4096) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.requested"),
      data: z
        .object({ approvalId: approvalIdSchema, actionType: z.string().min(1).max(128) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.approved"),
      data: z
        .object({ approvalId: approvalIdSchema, resolvedBy: z.string().min(1).max(256) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.rejected"),
      data: z
        .object({ approvalId: approvalIdSchema, resolvedBy: z.string().min(1).max(256) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.consumed"),
      data: z
        .object({
          approvalId: approvalIdSchema,
          principalId: z.string().min(1).max(256),
          policyVersion: z.string().min(1).max(128),
          actionType: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.revoked"),
      data: z
        .object({
          approvalId: approvalIdSchema,
          principalId: z.string().min(1).max(256),
          policyVersion: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("test.started"),
      data: z.object({ command: z.string().min(1).max(2_000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("test.completed"),
      data: z
        .object({
          command: z.string().min(1).max(2_000),
          passed: z.boolean(),
          exitCode: z.number().int(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("usage.updated"),
      data: z
        .object({
          inputTokens: z.number().int().nonnegative().nullable(),
          outputTokens: z.number().int().nonnegative().nullable(),
          costUsd: z.number().nonnegative().nullable(),
        })
        .strict(),
    })
    .strict(),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
type WithoutEventMetadata<T> = T extends unknown ? Omit<T, "id" | "sequence"> : never;
export type CreateAgentEvent = WithoutEventMetadata<AgentEvent>;
export const createAgentEventSchema: z.ZodType<CreateAgentEvent> = z.custom<CreateAgentEvent>(
  (value) => {
    const candidate = {
      ...(value as object),
      id: "00000000-0000-4000-8000-000000000000",
      sequence: 1,
    };
    return agentEventSchema.safeParse(candidate).success;
  },
  "Invalid normalized agent event",
);

export function redactEventSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
      .replace(
        /\b((?:api[_-]?key|password|secret|token|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/gi, "[REDACTED]") as T;
  }
  if (Array.isArray(value)) return value.map((entry) => redactEventSecrets(entry)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactEventSecrets(entry)]),
    ) as T;
  }
  return value;
}

export function serializeAgentEvent(event: AgentEvent): string {
  return JSON.stringify(agentEventSchema.parse(redactEventSecrets(event)));
}

export function parseAgentEvent(serialized: string): AgentEvent {
  return agentEventSchema.parse(redactEventSecrets(JSON.parse(serialized) as unknown));
}
