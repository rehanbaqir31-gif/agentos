import OpenAI from "openai";
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

export const openAiConfigurationSchema = z
  .object({
    model: z.string().min(1).max(256),
    baseUrl: z.string().url().nullable().default(null),
    credentialRef: z.string().nullable().default("env:OPENAI_API_KEY"),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  })
  .strict();
export type OpenAiConfiguration = z.infer<typeof openAiConfigurationSchema>;

function configuration(input: unknown): OpenAiConfiguration {
  const parsed = openAiConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError("openai", "invalid_configuration");
  if (parsed.data.baseUrl) safeBaseUrl(parsed.data.baseUrl, "openai");
  return parsed.data;
}

function request(input: ChatRequest): ChatRequest {
  const parsed = chatRequestSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError("openai", "invalid_request");
  if (parsed.data.stop?.length)
    throw new ProviderError(
      "openai",
      "unsupported_operation",
      "The OpenAI Responses API does not support stop sequences.",
    );
  return parsed.data;
}

function usage(
  providerId: string,
  modelId: string,
  value: OpenAI.Responses.ResponseUsage | undefined,
  durationMs: number,
): ProviderUsage | undefined {
  if (!value) return undefined;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
    ...(value.input_tokens_details?.cached_tokens !== undefined
      ? { cachedInputTokens: value.input_tokens_details.cached_tokens }
      : {}),
    durationMs,
    providerId,
    modelId,
  };
}

function getText(response: OpenAI.Responses.Response): string {
  return response.output_text;
}

export class OpenAiProvider implements ProviderDriver {
  readonly id = "openai";
  readonly displayName = "OpenAI";

  constructor(private readonly credentials: CredentialStore) {}

  validateConfiguration(input: unknown): OpenAiConfiguration {
    return configuration(input);
  }

  capabilities(): ProviderCapability[] {
    return ["chat", "text-generation", "streaming", "model-discovery", "usage-reporting"];
  }

  private async client(config: OpenAiConfiguration): Promise<OpenAI> {
    const apiKey = await resolveCredential(this.credentials, config.credentialRef, this.id);
    if (!apiKey) throw new ProviderError(this.id, "missing_credential");
    return new OpenAI({
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
      const page = await client.models.list({
        signal: abortSignal,
        timeout: config.timeoutMs,
        maxRetries: 0,
      });
      const models: ProviderModel[] = [];
      for await (const model of page) {
        const parsed = z
          .object({
            id: z.string().min(1).max(256),
            created: z.number().optional(),
            owned_by: z.string().optional(),
          })
          .safeParse(model);
        if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
        models.push(
          providerModelSchema.parse({
            id: parsed.data.id,
            displayName: parsed.data.id,
            capabilities: this.capabilities(),
            metadata: {
              ...(parsed.data.created !== undefined ? { createdAtEpoch: parsed.data.created } : {}),
              ...(parsed.data.owned_by ? { ownedBy: parsed.data.owned_by } : {}),
            },
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
    const config = configuration(input);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    try {
      const model = await client.models.retrieve(modelId, {
        signal: abortSignal,
        timeout: config.timeoutMs,
        maxRetries: 0,
      });
      return providerModelSchema.parse({
        id: model.id,
        displayName: model.id,
        capabilities: this.capabilities(),
        metadata: {
          ...(model.created !== undefined ? { createdAtEpoch: model.created } : {}),
          ...(model.owned_by ? { ownedBy: model.owned_by } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeSdkError(this.id, error, abortSignal);
    }
  }

  async testConnection(
    input: unknown,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const config = configuration(input);
    const model = modelId
      ? await this.getModel(config, modelId, signal)
      : (await this.listModels(config, signal))[0];
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      ...(model ? { model } : {}),
    };
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
    const instructions = parsed.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = parsed.messages.filter((message) => message.role !== "system");
    if (!messages.length) throw new ProviderError(this.id, "invalid_request");
    try {
      const response = await client.responses.create(
        {
          model: parsed.model,
          input: messages.map((message) => ({ role: message.role, content: message.content })),
          ...(instructions ? { instructions } : {}),
          ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
          ...(parsed.maxOutputTokens !== undefined
            ? { max_output_tokens: parsed.maxOutputTokens }
            : {}),
        },
        { signal: abortSignal, timeout: config.timeoutMs, maxRetries: 0 },
      );
      const normalizedUsage = usage(
        this.id,
        response.model,
        response.usage,
        performance.now() - started,
      );
      return {
        providerId: this.id,
        modelId: response.model,
        text: getText(response),
        ...(response.status ? { finishReason: response.status } : {}),
        ...(normalizedUsage ? { usage: normalizedUsage } : {}),
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
    const instructions = parsed.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = parsed.messages.filter((message) => message.role !== "system");
    if (!messages.length) throw new ProviderError(this.id, "invalid_request");
    let text = "";
    let finalResponse: OpenAI.Responses.Response | undefined;
    try {
      const stream = await client.responses.create(
        {
          model: parsed.model,
          input: messages.map((message) => ({ role: message.role, content: message.content })),
          ...(instructions ? { instructions } : {}),
          ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
          ...(parsed.maxOutputTokens !== undefined
            ? { max_output_tokens: parsed.maxOutputTokens }
            : {}),
          stream: true,
        },
        { signal: abortSignal, timeout: config.timeoutMs, maxRetries: 0 },
      );
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          yield { type: "text_delta", text: event.delta };
        } else if (event.type === "response.completed") {
          finalResponse = event.response;
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new ProviderError(this.id, "request_failed", undefined, true);
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeSdkError(this.id, error, abortSignal);
    }
    if (!finalResponse)
      throw new ProviderError(
        this.id,
        "invalid_response",
        "OpenAI stream ended before a completed response.",
      );
    const normalizedUsage = usage(
      this.id,
      finalResponse.model,
      finalResponse.usage,
      performance.now() - started,
    );
    yield {
      type: "completed",
      response: {
        providerId: this.id,
        modelId: finalResponse.model,
        text: getText(finalResponse) || text,
        ...(finalResponse.status ? { finishReason: finalResponse.status } : {}),
        ...(normalizedUsage ? { usage: normalizedUsage } : {}),
        requestId: finalResponse.id,
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
      },
      signal,
    );
  }
}
