import { z } from "zod";
import { resolveCredential, type CredentialStore } from "./credentials.js";
import { ProviderError } from "./errors.js";
import { endpointUrl, fetchProvider, readSse, requestSignal, responseJson } from "./http.js";
import type {
  ChatRequest,
  ChatResponse,
  ConnectionTestResult,
  ProviderCapability,
  ProviderDriver,
  ProviderHealth,
  ProviderModel,
  ProviderStreamEvent,
  ProviderUsage,
} from "./types.js";
import { chatRequestSchema, providerModelSchema } from "./types.js";

const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const headersSchema = z
  .record(z.string(), z.string().max(1024))
  .default({})
  .superRefine((headers, context) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!headerNameSchema.safeParse(name).success) {
        context.addIssue({ code: "custom", path: [name], message: "Invalid HTTP header name" });
      }
      if (
        /^(?:authorization|proxy-authorization|api[-_]?key|x[-_]api[-_]key|.*token.*|.*secret.*)$/i.test(
          name,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Use the credential store for sensitive headers",
        });
      }
      if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Header names and values cannot contain line breaks",
        });
      }
      if (/\bBearer\s+\S{8,}|\bsk-[A-Za-z0-9_-]{12,}/i.test(value)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Secret-like header values must use the credential store",
        });
      }
    }
  });

export const openAiCompatibleConfigurationSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1).max(256),
    credentialRef: z.string().nullable().default(null),
    credentialHeaderName: headerNameSchema.default("Authorization"),
    credentialPrefix: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9._ -]{0,31}$/)
      .default("Bearer "),
    headers: headersSchema,
    chatCompletionsPath: z.string().min(1).default("chat/completions"),
    modelDiscoveryPath: z.string().nullable().default(null),
    healthCheckPath: z.string().nullable().default(null),
    supportsStreaming: z.boolean().default(true),
    supportsUsageReporting: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      const url = new URL(config.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        context.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "Base URL must not contain credentials, query parameters, or a fragment",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Base URL must be a valid HTTP or HTTPS URL",
      });
    }
  });
export type OpenAiCompatibleConfiguration = z.infer<typeof openAiCompatibleConfigurationSchema>;

const chatResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .optional(),
    })
    .optional(),
});
const streamChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .optional(),
    })
    .optional(),
});
const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(256), object: z.string().optional() })),
});

function parseConfiguration(input: unknown): OpenAiCompatibleConfiguration {
  const result = openAiCompatibleConfigurationSchema.safeParse(input);
  if (!result.success) throw new ProviderError("openai_compatible", "invalid_configuration");
  return result.data;
}

function parseChatRequest(input: ChatRequest): ChatRequest {
  const result = chatRequestSchema.safeParse(input);
  if (!result.success) throw new ProviderError("openai_compatible", "invalid_request");
  return result.data;
}

function usageFrom(
  providerId: string,
  modelId: string,
  usage: z.infer<typeof chatResponseSchema>["usage"],
  durationMs: number,
): ProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined
      ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
    durationMs,
    providerId,
    modelId,
  };
}

export class OpenAiCompatibleProvider implements ProviderDriver {
  readonly id = "openai_compatible";
  readonly displayName = "OpenAI-compatible API";

  constructor(private readonly credentials: CredentialStore) {}

  validateConfiguration(input: unknown): OpenAiCompatibleConfiguration {
    return parseConfiguration(input);
  }

  capabilities(input: unknown): ProviderCapability[] {
    const configuration = parseConfiguration(input);
    return [
      "chat",
      ...(configuration.supportsStreaming ? ["streaming" as const] : []),
      ...(configuration.modelDiscoveryPath ? ["model-discovery" as const] : []),
      ...(configuration.supportsUsageReporting ? ["usage-reporting" as const] : []),
    ];
  }

  private url(configuration: OpenAiCompatibleConfiguration, path: string): URL {
    const base = configuration.baseUrl.endsWith("/")
      ? configuration.baseUrl
      : `${configuration.baseUrl}/`;
    return endpointUrl(base, path, this.id);
  }

  private async headers(configuration: OpenAiCompatibleConfiguration): Promise<Headers> {
    const headers = new Headers(configuration.headers);
    headers.set("content-type", "application/json");
    const credential = await resolveCredential(
      this.credentials,
      configuration.credentialRef,
      this.id,
    );
    if (credential)
      headers.set(
        configuration.credentialHeaderName,
        `${configuration.credentialPrefix}${credential}`,
      );
    return headers;
  }

  private async request(
    configuration: OpenAiCompatibleConfiguration,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ response: Response; signal: AbortSignal; started: number }> {
    const abortSignal = requestSignal(signal, configuration.timeoutMs);
    const started = performance.now();
    const response = await fetchProvider(
      this.id,
      this.url(configuration, path),
      {
        method: "POST",
        headers: await this.headers(configuration),
        body: JSON.stringify(body),
        signal: abortSignal,
      },
      abortSignal,
    );
    return { response, signal: abortSignal, started };
  }

  async listModels(input: unknown, signal?: AbortSignal): Promise<ProviderModel[]> {
    const configuration = parseConfiguration(input);
    if (!configuration.modelDiscoveryPath)
      throw new ProviderError(
        this.id,
        "unsupported_operation",
        "Model discovery is disabled for this endpoint.",
      );
    const abortSignal = requestSignal(signal, configuration.timeoutMs);
    const headers = new Headers(configuration.headers);
    const credential = await resolveCredential(
      this.credentials,
      configuration.credentialRef,
      this.id,
    );
    if (credential)
      headers.set(
        configuration.credentialHeaderName,
        `${configuration.credentialPrefix}${credential}`,
      );
    const response = await fetchProvider(
      this.id,
      this.url(configuration, configuration.modelDiscoveryPath),
      { method: "GET", headers, signal: abortSignal },
      abortSignal,
    );
    const parsed = modelsResponseSchema.safeParse(await responseJson(this.id, response));
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    return parsed.data.data.map((model) =>
      providerModelSchema.parse({
        id: model.id,
        displayName: model.id,
        capabilities: this.capabilities(configuration),
        metadata: model.object ? { object: model.object } : {},
      }),
    );
  }

  async getModel(input: unknown, modelId: string, signal?: AbortSignal): Promise<ProviderModel> {
    const configuration = parseConfiguration(input);
    if (!configuration.modelDiscoveryPath)
      throw new ProviderError(
        this.id,
        "unsupported_operation",
        "Model availability cannot be discovered for this endpoint.",
      );
    const model = (await this.listModels(configuration, signal)).find(
      (entry) => entry.id === modelId,
    );
    if (!model) throw new ProviderError(this.id, "model_not_found");
    return model;
  }

  async testConnection(
    input: unknown,
    modelId?: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const configuration = parseConfiguration(input);
    const selectedModel = modelId ?? configuration.model;
    let model: ProviderModel | undefined;
    if (configuration.healthCheckPath) {
      const abortSignal = requestSignal(signal, configuration.timeoutMs);
      const headers = new Headers(configuration.headers);
      const credential = await resolveCredential(
        this.credentials,
        configuration.credentialRef,
        this.id,
      );
      if (credential)
        headers.set(
          configuration.credentialHeaderName,
          `${configuration.credentialPrefix}${credential}`,
        );
      await fetchProvider(
        this.id,
        this.url(configuration, configuration.healthCheckPath),
        { headers, signal: abortSignal },
        abortSignal,
      );
    } else {
      const response = await this.chat(
        configuration,
        {
          model: selectedModel,
          messages: [{ role: "user", content: "Reply with OK." }],
          maxOutputTokens: 1,
        },
        signal,
      );
      model = {
        id: response.modelId,
        displayName: response.modelId,
        capabilities: this.capabilities(configuration),
        metadata: {},
      };
    }
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      ...(model ? { model } : {}),
    };
  }

  async healthCheck(input: unknown, signal?: AbortSignal): Promise<ProviderHealth> {
    const configuration = parseConfiguration(input);
    try {
      await this.testConnection(configuration, undefined, signal);
      return { providerId: this.id, status: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { providerId: this.id, status: "unavailable", checkedAt: new Date().toISOString() };
    }
  }

  async chat(input: unknown, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const configuration = parseConfiguration(input);
    const parsedRequest = parseChatRequest(request);
    const { response, started } = await this.request(
      configuration,
      configuration.chatCompletionsPath,
      {
        model: parsedRequest.model,
        messages: parsedRequest.messages,
        stream: false,
        ...(parsedRequest.temperature !== undefined
          ? { temperature: parsedRequest.temperature }
          : {}),
        ...(parsedRequest.maxOutputTokens !== undefined
          ? { max_tokens: parsedRequest.maxOutputTokens }
          : {}),
        ...(parsedRequest.stop ? { stop: parsedRequest.stop } : {}),
      },
      signal,
    );
    const parsed = chatResponseSchema.safeParse(await responseJson(this.id, response));
    if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
    const choice = parsed.data.choices[0]!;
    const model = parsed.data.model ?? parsedRequest.model;
    const usage = usageFrom(this.id, model, parsed.data.usage, performance.now() - started);
    return {
      providerId: this.id,
      modelId: model,
      text: choice.message?.content ?? "",
      ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(usage ? { usage } : {}),
      ...(parsed.data.id ? { requestId: parsed.data.id } : {}),
    };
  }

  async *streamChat(
    input: unknown,
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    const configuration = parseConfiguration(input);
    if (!configuration.supportsStreaming)
      throw new ProviderError(
        this.id,
        "unsupported_operation",
        "Streaming is disabled for this endpoint.",
      );
    const parsedRequest = parseChatRequest(request);
    const abortSignal = requestSignal(signal, configuration.timeoutMs);
    const started = performance.now();
    const body = {
      model: parsedRequest.model,
      messages: parsedRequest.messages,
      stream: true,
      ...(configuration.supportsUsageReporting ? { stream_options: { include_usage: true } } : {}),
      ...(parsedRequest.temperature !== undefined
        ? { temperature: parsedRequest.temperature }
        : {}),
      ...(parsedRequest.maxOutputTokens !== undefined
        ? { max_tokens: parsedRequest.maxOutputTokens }
        : {}),
      ...(parsedRequest.stop ? { stop: parsedRequest.stop } : {}),
    };
    const response = await fetchProvider(
      this.id,
      this.url(configuration, configuration.chatCompletionsPath),
      {
        method: "POST",
        headers: await this.headers(configuration),
        body: JSON.stringify(body),
        signal: abortSignal,
      },
      abortSignal,
    );
    let text = "";
    let modelId = parsedRequest.model;
    let requestId: string | undefined;
    let finishReason: string | undefined;
    let usage: ProviderUsage | undefined;
    let done = false;
    for await (const event of readSse(this.id, response, abortSignal)) {
      if (event === "[DONE]") {
        done = true;
        break;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(event) as unknown;
      } catch {
        throw new ProviderError(this.id, "invalid_response");
      }
      const parsed = streamChunkSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
      modelId = parsed.data.model ?? modelId;
      requestId = parsed.data.id ?? requestId;
      const choice = parsed.data.choices[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        yield { type: "text_delta", text: choice.delta.content };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const normalizedUsage = usageFrom(
        this.id,
        modelId,
        parsed.data.usage,
        performance.now() - started,
      );
      if (normalizedUsage) usage = normalizedUsage;
    }
    if (!done)
      throw new ProviderError(
        this.id,
        "invalid_response",
        "OpenAI-compatible stream ended before its completion marker.",
      );
    yield {
      type: "completed",
      response: {
        providerId: this.id,
        modelId,
        text,
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}
