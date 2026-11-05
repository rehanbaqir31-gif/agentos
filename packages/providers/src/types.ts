import { z } from "zod";

export const providerCapabilitySchema = z.enum([
  "chat",
  "text-generation",
  "streaming",
  "tool-calling",
  "structured-output",
  "vision",
  "embeddings",
  "model-discovery",
  "usage-reporting",
]);
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerModelSchema = z.object({
  id: z.string().min(1).max(256),
  displayName: z.string().max(256).optional(),
  capabilities: z.array(providerCapabilitySchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;

export const providerUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    estimatedCost: z.number().nonnegative().optional(),
  })
  .strict();
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const chatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(1_000_000),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(chatMessageSchema).min(1).max(1000),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    stop: z.array(z.string().min(1).max(256)).max(16).optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const generateRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    prompt: z.string().min(1).max(1_000_000),
    system: z.string().max(100_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    stop: z.array(z.string().min(1).max(256)).max(16).optional(),
  })
  .strict();
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export interface ChatResponse {
  providerId: string;
  modelId: string;
  text: string;
  finishReason?: string;
  usage?: ProviderUsage;
  requestId?: string;
}

export type ProviderStreamEvent =
  { type: "text_delta"; text: string } | { type: "completed"; response: ChatResponse };

export interface ProviderHealth {
  providerId: string;
  status: "healthy" | "unavailable" | "degraded";
  checkedAt: string;
  version?: string;
}

export interface ConnectionTestResult {
  providerId: string;
  ok: boolean;
  checkedAt: string;
  version?: string;
  model?: ProviderModel;
}

export interface ProviderDriver {
  readonly id: string;
  readonly displayName: string;
  validateConfiguration(input: unknown): unknown;
  capabilities(configuration: unknown, model?: ProviderModel): ProviderCapability[];
  listModels(configuration: unknown, signal?: AbortSignal): Promise<ProviderModel[]>;
  getModel(configuration: unknown, modelId: string, signal?: AbortSignal): Promise<ProviderModel>;
  testConnection(
    configuration: unknown,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult>;
  healthCheck(configuration: unknown, signal?: AbortSignal): Promise<ProviderHealth>;
  chat(configuration: unknown, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  streamChat(
    configuration: unknown,
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
  generate?(
    configuration: unknown,
    request: GenerateRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
  streamGenerate?(
    configuration: unknown,
    request: GenerateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
}
