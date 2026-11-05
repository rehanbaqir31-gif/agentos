import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { resolveCredential, type CredentialStore } from "./credentials.js";
import { ProviderError, normalizeSdkError } from "./errors.js";
import { safeBaseUrl, requestSignal } from "./http.js";
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

export const anthropicConfigurationSchema = z
  .object({
    model: z.string().min(1).max(256),
    baseUrl: z.string().url().nullable().default(null),
    credentialRef: z.string().nullable().default("env:ANTHROPIC_API_KEY"),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
    defaultMaxOutputTokens: z.number().int().min(1).max(1_000_000).default(4096),
  })
  .strict();
export type AnthropicConfiguration = z.infer<typeof anthropicConfigurationSchema>;

function configuration(input: unknown): AnthropicConfiguration {
  const parsed = anthropicConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError("anthropic", "invalid_configuration");
  if (parsed.data.baseUrl) safeBaseUrl(parsed.data.baseUrl, "anthropic");
  return parsed.data;
}

function request(input: ChatRequest): ChatRequest {
  const parsed = chatRequestSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError("anthropic", "invalid_request");
  return parsed.data;
}

function normalizedUsage(
  providerId: string,
  modelId: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheReadTokens: number | undefined,
  durationMs: number,
): ProviderUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined)
    return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    ...(cacheReadTokens !== undefined ? { cachedInputTokens: cacheReadTokens } : {}),
    durationMs,
    providerId,
    modelId,
  };
}

function responseText(message: Anthropic.Messages.Message): string {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export class AnthropicProvider implements ProviderDriver {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";

  constructor(private readonly credentials: CredentialStore) {}

  validateConfiguration(input: unknown): AnthropicConfiguration {
    return configuration(input);
  }

  capabilities(): ProviderCapability[] {
    return ["chat", "text-generation", "streaming", "model-discovery", "usage-reporting"];
  }

  private async client(config: AnthropicConfiguration): Promise<Anthropic> {
    const apiKey = await resolveCredential(this.credentials, config.credentialRef, this.id);
    if (!apiKey) throw new ProviderError(this.id, "missing_credential");
    return new Anthropic({
      apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      timeout: config.timeoutMs,
      maxRetries: 0,
    });
  }

  async listModels(input: unknown, signal?: AbortSignal): Promise<ProviderModel[]> {
    const config = configuration(input);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    try {
      const page = await client.models.list(
        {},
        { signal: abortSignal, timeout: config.timeoutMs, maxRetries: 0 },
      );
      const models: ProviderModel[] = [];
      for await (const model of page) {
        const parsed = z
          .object({
            id: z.string().min(1).max(256),
            display_name: z.string().optional(),
            created_at: z.string().optional(),
          })
          .safeParse(model);
        if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
        models.push(
          providerModelSchema.parse({
            id: parsed.data.id,
            ...(parsed.data.display_name ? { displayName: parsed.data.display_name } : {}),
            capabilities: this.capabilities(),
            metadata: parsed.data.created_at ? { createdAt: parsed.data.created_at } : {},
          }),
        );
      }
      return models;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeSdkError(this.id, error, abortSignal);
    }
  }

  async getModel(input: unknown, modelId: string, signal?: AbortSignal): Promise<ProviderModel> {
    const model = (await this.listModels(input, signal)).find((entry) => entry.id === modelId);
    if (!model) throw new ProviderError(this.id, "model_not_found");
    return model;
  }

  async testConnection(
    input: unknown,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    try {
      const models = await this.listModels(input, signal);
      const model = modelId ? models.find((entry) => entry.id === modelId) : models[0];
      if (modelId && !model) throw new ProviderError(this.id, "model_not_found");
      return {
        providerId: this.id,
        ok: true,
        checkedAt: new Date().toISOString(),
        ...(model ? { model } : {}),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeSdkError(this.id, error, signal);
    }
  }

  async healthCheck(input: unknown, signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      await this.testConnection(input, undefined, signal);
      return { providerId: this.id, status: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        providerId: this.id,
        status:
          error instanceof ProviderError && error.code === "missing_credential"
            ? "degraded"
            : "unavailable",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async chat(
    input: unknown,
    chatRequest: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const config = configuration(input);
    const parsed = request(chatRequest);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    const started = performance.now();
    const system = parsed.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = parsed.messages.filter((message) => message.role !== "system");
    if (!messages.length) throw new ProviderError(this.id, "invalid_request");
    try {
      const response = await client.messages.create(
        {
          model: parsed.model,
          max_tokens: parsed.maxOutputTokens ?? config.defaultMaxOutputTokens,
          messages: messages.map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          })),
          ...(system ? { system } : {}),
          ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
          ...(parsed.stop ? { stop_sequences: parsed.stop } : {}),
          stream: false,
        },
        { signal: abortSignal, timeout: config.timeoutMs, maxRetries: 0 },
      );
      const usage = normalizedUsage(
        this.id,
        response.model,
        response.usage.input_tokens,
        response.usage.output_tokens ?? undefined,
        response.usage.cache_read_input_tokens ?? undefined,
        performance.now() - started,
      );
      return {
        providerId: this.id,
        modelId: response.model,
        text: responseText(response),
        ...(response.stop_reason ? { finishReason: response.stop_reason } : {}),
        ...(usage ? { usage } : {}),
        requestId: response.id,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeSdkError(this.id, error, abortSignal);
    }
  }

  async *streamChat(
    input: unknown,
    chatRequest: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    const config = configuration(input);
    const parsed = request(chatRequest);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    const started = performance.now();
    const system = parsed.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = parsed.messages.filter((message) => message.role !== "system");
    if (!messages.length) throw new ProviderError(this.id, "invalid_request");
    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let finishReason: string | undefined;
    let completed = false;
    let messageId: string | undefined;
    let resolvedModel = parsed.model;
    const stream = client.messages.stream(
      {
        model: parsed.model,
        max_tokens: parsed.maxOutputTokens ?? config.defaultMaxOutputTokens,
        messages: messages.map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content,
        })),
        ...(system ? { system } : {}),
        ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
        ...(parsed.stop ? { stop_sequences: parsed.stop } : {}),
      },
      { signal: abortSignal, timeout: config.timeoutMs, maxRetries: 0 },
    );
    try {
      for await (const event of stream) {
        if (event.type === "message_start") {
          messageId = event.message.id;
          resolvedModel = event.message.model;
          inputTokens = event.message.usage.input_tokens;
          cacheReadTokens = event.message.usage.cache_read_input_tokens ?? undefined;
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.type === "message_delta") {
          finishReason = event.delta.stop_reason ?? undefined;
          if (event.usage.output_tokens != null) outputTokens = event.usage.output_tokens;
          if (event.usage.cache_read_input_tokens != null)
            cacheReadTokens = event.usage.cache_read_input_tokens;
        }
      }
      completed = true;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeSdkError(this.id, error, abortSignal);
    } finally {
      if (!completed) stream.abort();
    }
    const usage = normalizedUsage(
      this.id,
      resolvedModel,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      performance.now() - started,
    );
    yield {
      type: "completed",
      response: {
        providerId: this.id,
        modelId: resolvedModel,
        text,
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
        ...(messageId ? { requestId: messageId } : {}),
      },
    };
  }

  generate(input: unknown, request: GenerateRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const parsed = generateRequestSchema.safeParse(request);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_request");
    return this.chat(
      input,
      {
        model: parsed.data.model,
        messages: [
          ...(parsed.data.system ? [{ role: "system" as const, content: parsed.data.system }] : []),
          { role: "user", content: parsed.data.prompt },
        ],
        ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
        ...(parsed.data.maxOutputTokens !== undefined
          ? { maxOutputTokens: parsed.data.maxOutputTokens }
          : {}),
        ...(parsed.data.stop ? { stop: parsed.data.stop } : {}),
      },
      signal,
    );
  }
}
