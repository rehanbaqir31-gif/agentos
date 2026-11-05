import { z } from "zod";
import { ProviderError } from "./errors.js";
import {
  endpointUrl,
  fetchProvider,
  readNdjson,
  requestSignal,
  responseJson,
  safeBaseUrl,
} from "./http.js";
import type {
  ChatRequest,
  ChatResponse,
  ConnectionTestResult,
  GenerateRequest,
  ProviderCapability,
  ProviderDriver,
  ProviderHealth,
  ProviderModel,
  ProviderStreamEvent,
  ProviderUsage,
} from "./types.js";
import { chatRequestSchema, generateRequestSchema, providerModelSchema } from "./types.js";
import { resolveCredential, type CredentialStore } from "./credentials.js";

export const ollamaConfigurationSchema = z
  .object({
    baseUrl: z.string().url().default("http://127.0.0.1:11434"),
    credentialRef: z.string().nullable().default(null),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
    keepAlive: z.string().max(32).optional(),
  })
  .strict();
export type OllamaConfiguration = z.infer<typeof ollamaConfigurationSchema>;

const ollamaVersionSchema = z.object({ version: z.string().min(1).max(128) });
const ollamaTagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1).max(256),
      model: z.string().max(256).optional(),
      modified_at: z.string().optional(),
      size: z.number().nonnegative().optional(),
      digest: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
const ollamaShowSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  modified_at: z.string().optional(),
  template: z.string().optional(),
  parameters: z.string().optional(),
});
const ollamaChunkSchema = z.object({
  model: z.string().optional(),
  response: z.string().optional(),
  message: z.object({ content: z.string().optional() }).optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  prompt_eval_cached_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});

function parseConfiguration(input: unknown): OllamaConfiguration {
  const result = ollamaConfigurationSchema.safeParse(input);
  if (!result.success) throw new ProviderError("ollama", "invalid_configuration");
  safeBaseUrl(result.data.baseUrl, "ollama");
  return result.data;
}

function parseChatRequest(input: ChatRequest): ChatRequest {
  const result = chatRequestSchema.safeParse(input);
  if (!result.success) throw new ProviderError("ollama", "invalid_request");
  return result.data;
}

function parseGenerateRequest(input: GenerateRequest): GenerateRequest {
  const result = generateRequestSchema.safeParse(input);
  if (!result.success) throw new ProviderError("ollama", "invalid_request");
  return result.data;
}

function usageFromChunk(
  providerId: string,
  modelId: string,
  chunk: z.infer<typeof ollamaChunkSchema>,
  durationMs: number,
): ProviderUsage | undefined {
  const inputTokens = chunk.prompt_eval_count;
  const outputTokens = chunk.eval_count;
  const cachedInputTokens = chunk.prompt_eval_cached_count;
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined)
    return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    durationMs,
    providerId,
    modelId,
  };
}

function ollamaModelCapabilities(capabilities: string[] = []): ProviderCapability[] {
  const mapped: Record<string, ProviderCapability> = {
    tools: "tool-calling",
    vision: "vision",
    embedding: "embeddings",
  };
  return [
    ...new Set(
      capabilities.flatMap((capability) => (mapped[capability] ? [mapped[capability]!] : [])),
    ),
  ];
}

export class OllamaProvider implements ProviderDriver {
  readonly id = "ollama";
  readonly displayName = "Ollama";

  constructor(private readonly credentials: CredentialStore) {}

  validateConfiguration(input: unknown): OllamaConfiguration {
    return parseConfiguration(input);
  }

  capabilities(): ProviderCapability[] {
    return ["chat", "text-generation", "streaming", "model-discovery"];
  }

  private async headers(configuration: OllamaConfiguration): Promise<HeadersInit> {
    const credential = await resolveCredential(
      this.credentials,
      configuration.credentialRef,
      this.id,
    );
    return credential ? { Authorization: `Bearer ${credential}` } : {};
  }

  private url(configuration: OllamaConfiguration, path: string): URL {
    return endpointUrl(configuration.baseUrl, path, this.id);
  }

  private async json(
    configuration: OllamaConfiguration,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestAbort = requestSignal(signal, configuration.timeoutMs);
    const response = await fetchProvider(
      this.id,
      this.url(configuration, path),
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(await this.headers(configuration)),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: requestAbort,
      },
      requestAbort,
    );
    return responseJson(this.id, response);
  }

  async listModels(input: unknown, signal?: AbortSignal): Promise<ProviderModel[]> {
    const configuration = parseConfiguration(input);
    const raw = await this.json(configuration, "api/tags", undefined, signal);
    const parsed = ollamaTagsSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    return parsed.data.models.map((model) =>
      providerModelSchema.parse({
        id: model.name,
        displayName: model.name,
        capabilities: [],
        metadata: {
          ...(model.model ? { model: model.model } : {}),
          ...(model.modified_at ? { modifiedAt: model.modified_at } : {}),
          ...(model.size !== undefined ? { sizeBytes: model.size } : {}),
          ...(model.digest ? { digest: model.digest } : {}),
          ...(model.details ? { details: model.details } : {}),
        },
      }),
    );
  }

  async getModel(input: unknown, modelId: string, signal?: AbortSignal): Promise<ProviderModel> {
    const configuration = parseConfiguration(input);
    const models = await this.listModels(configuration, signal);
    const model = models.find((entry) => entry.id === modelId);
    if (!model) throw new ProviderError(this.id, "model_not_found");
    const raw = await this.json(configuration, "api/show", { model: modelId }, signal);
    const parsed = ollamaShowSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    return providerModelSchema.parse({
      ...model,
      capabilities: ollamaModelCapabilities(parsed.data.capabilities),
      metadata: {
        ...model.metadata,
        ...(parsed.data.details ? { modelDetails: parsed.data.details } : {}),
        ...(parsed.data.model_info ? { modelInfo: parsed.data.model_info } : {}),
        ...(parsed.data.modified_at ? { modifiedAt: parsed.data.modified_at } : {}),
      },
    });
  }

  async testConnection(
    input: unknown,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const configuration = parseConfiguration(input);
    const raw = await this.json(configuration, "api/version", undefined, signal);
    const parsed = ollamaVersionSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    const model = modelId ? await this.getModel(configuration, modelId, signal) : undefined;
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      version: parsed.data.version,
      ...(model ? { model } : {}),
    };
  }

  async healthCheck(input: unknown, signal?: AbortSignal): Promise<ProviderHealth> {
    const configuration = parseConfiguration(input);
    try {
      const raw = await this.json(configuration, "api/version", undefined, signal);
      const parsed = ollamaVersionSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
      return {
        providerId: this.id,
        status: "healthy",
        checkedAt: new Date().toISOString(),
        version: parsed.data.version,
      };
    } catch {
      return { providerId: this.id, status: "unavailable", checkedAt: new Date().toISOString() };
    }
  }

  async chat(input: unknown, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const configuration = parseConfiguration(input);
    const parsedRequest = parseChatRequest(request);
    const started = performance.now();
    const raw = await this.json(
      configuration,
      "api/chat",
      {
        model: parsedRequest.model,
        messages: parsedRequest.messages,
        stream: false,
        ...(parsedRequest.temperature !== undefined ||
        parsedRequest.maxOutputTokens !== undefined ||
        parsedRequest.stop !== undefined
          ? {
              options: {
                ...(parsedRequest.temperature !== undefined
                  ? { temperature: parsedRequest.temperature }
                  : {}),
                ...(parsedRequest.maxOutputTokens !== undefined
                  ? { num_predict: parsedRequest.maxOutputTokens }
                  : {}),
                ...(parsedRequest.stop ? { stop: parsedRequest.stop } : {}),
              },
            }
          : {}),
        ...(configuration.keepAlive ? { keep_alive: configuration.keepAlive } : {}),
      },
      signal,
    );
    const parsed = ollamaChunkSchema
      .extend({
        message: z.object({ role: z.string().optional(), content: z.string() }),
      })
      .safeParse(raw);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    const durationMs = performance.now() - started;
    const usage = usageFromChunk(
      this.id,
      parsed.data.model ?? parsedRequest.model,
      parsed.data,
      durationMs,
    );
    return {
      providerId: this.id,
      modelId: parsed.data.model ?? parsedRequest.model,
      text: parsed.data.message.content,
      ...(parsed.data.done_reason ? { finishReason: parsed.data.done_reason } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  async *streamChat(
    input: unknown,
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    const configuration = parseConfiguration(input);
    const parsedRequest = parseChatRequest(request);
    const requestAbort = requestSignal(signal, configuration.timeoutMs);
    const started = performance.now();
    const response = await fetchProvider(
      this.id,
      this.url(configuration, "api/chat"),
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(await this.headers(configuration)) },
        body: JSON.stringify({
          model: parsedRequest.model,
          messages: parsedRequest.messages,
          stream: true,
          ...(configuration.keepAlive ? { keep_alive: configuration.keepAlive } : {}),
        }),
        signal: requestAbort,
      },
      requestAbort,
    );
    let text = "";
    let finalChunk: z.infer<typeof ollamaChunkSchema> | undefined;
    for await (const raw of readNdjson(this.id, response, requestAbort)) {
      const parsed = ollamaChunkSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
      const chunkText = parsed.data.message?.content ?? parsed.data.response ?? "";
      // Ollama may also emit `thinking`; it is deliberately excluded from provider output.
      if (chunkText) {
        text += chunkText;
        yield { type: "text_delta", text: chunkText };
      }
      if (parsed.data.done) finalChunk = parsed.data;
    }
    if (!finalChunk)
      throw new ProviderError(
        this.id,
        "invalid_response",
        "Ollama stream ended before its completion marker.",
      );
    const modelId = finalChunk.model ?? parsedRequest.model;
    const usage = usageFromChunk(this.id, modelId, finalChunk, performance.now() - started);
    yield {
      type: "completed",
      response: {
        providerId: this.id,
        modelId,
        text,
        ...(finalChunk.done_reason ? { finishReason: finalChunk.done_reason } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  }

  async generate(
    input: unknown,
    request: GenerateRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const configuration = parseConfiguration(input);
    const parsedRequest = parseGenerateRequest(request);
    const started = performance.now();
    const raw = await this.json(
      configuration,
      "api/generate",
      {
        model: parsedRequest.model,
        prompt: parsedRequest.prompt,
        ...(parsedRequest.system ? { system: parsedRequest.system } : {}),
        stream: false,
        ...(configuration.keepAlive ? { keep_alive: configuration.keepAlive } : {}),
        options: {
          ...(parsedRequest.temperature !== undefined
            ? { temperature: parsedRequest.temperature }
            : {}),
          ...(parsedRequest.maxOutputTokens !== undefined
            ? { num_predict: parsedRequest.maxOutputTokens }
            : {}),
          ...(parsedRequest.stop ? { stop: parsedRequest.stop } : {}),
        },
      },
      signal,
    );
    const parsed = ollamaChunkSchema.extend({ response: z.string() }).safeParse(raw);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    const modelId = parsed.data.model ?? parsedRequest.model;
    const usage = usageFromChunk(this.id, modelId, parsed.data, performance.now() - started);
    return {
      providerId: this.id,
      modelId,
      text: parsed.data.response,
      ...(parsed.data.done_reason ? { finishReason: parsed.data.done_reason } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  async *streamGenerate(
    input: unknown,
    request: GenerateRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    const configuration = parseConfiguration(input);
    const parsedRequest = parseGenerateRequest(request);
    const requestAbort = requestSignal(signal, configuration.timeoutMs);
    const started = performance.now();
    const response = await fetchProvider(
      this.id,
      this.url(configuration, "api/generate"),
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(await this.headers(configuration)) },
        body: JSON.stringify({
          model: parsedRequest.model,
          prompt: parsedRequest.prompt,
          ...(parsedRequest.system ? { system: parsedRequest.system } : {}),
          stream: true,
          ...(configuration.keepAlive ? { keep_alive: configuration.keepAlive } : {}),
        }),
        signal: requestAbort,
      },
      requestAbort,
    );
    let text = "";
    let finalChunk: z.infer<typeof ollamaChunkSchema> | undefined;
    for await (const raw of readNdjson(this.id, response, requestAbort)) {
      const parsed = ollamaChunkSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
      if (parsed.data.response) {
        text += parsed.data.response;
        yield { type: "text_delta", text: parsed.data.response };
      }
      if (parsed.data.done) finalChunk = parsed.data;
    }
    if (!finalChunk)
      throw new ProviderError(
        this.id,
        "invalid_response",
        "Ollama stream ended before its completion marker.",
      );
    const modelId = finalChunk.model ?? parsedRequest.model;
    const usage = usageFromChunk(this.id, modelId, finalChunk, performance.now() - started);
    yield {
      type: "completed",
      response: {
        providerId: this.id,
        modelId,
        text,
        ...(finalChunk.done_reason ? { finishReason: finalChunk.done_reason } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  }
}
