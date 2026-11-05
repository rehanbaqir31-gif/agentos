import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { resolveCredential, type CredentialStore } from "./credentials.js";
import { ProviderError, normalizeSdkError } from "./errors.js";
import { requestSignal, safeBaseUrl } from "./http.js";
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

export const geminiConfigurationSchema = z
  .object({
    model: z.string().min(1).max(256),
    baseUrl: z.string().url().nullable().default(null),
    credentialRef: z.string().nullable().default("env:GOOGLE_API_KEY"),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  })
  .strict();
export type GeminiConfiguration = z.infer<typeof geminiConfigurationSchema>;

function configuration(input: unknown): GeminiConfiguration {
  const parsed = geminiConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError("google", "invalid_configuration");
  if (parsed.data.baseUrl) safeBaseUrl(parsed.data.baseUrl, "google");
  return parsed.data;
}

function toUsage(
  modelId: string,
  value: GenerateContentResponse["usageMetadata"],
  durationMs: number,
): ProviderUsage | undefined {
  if (!value) return undefined;
  const inputTokens = value.promptTokenCount;
  const outputTokens = value.candidatesTokenCount;
  const totalTokens = value.totalTokenCount;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
    return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(value.cachedContentTokenCount !== undefined
      ? { cachedInputTokens: value.cachedContentTokenCount }
      : {}),
    durationMs,
    providerId: "google",
    modelId,
  };
}

function textFrom(response: GenerateContentResponse): string {
  return (
    response.candidates
      ?.flatMap(
        (candidate) =>
          candidate.content?.parts?.flatMap((part) =>
            typeof part.text === "string" && part.thought !== true ? [part.text] : [],
          ) ?? [],
      )
      .join("") ?? ""
  );
}

export class GeminiProvider implements ProviderDriver {
  readonly id = "google";
  readonly displayName = "Google Gemini";

  constructor(private readonly credentials: CredentialStore) {}

  validateConfiguration(input: unknown): GeminiConfiguration {
    return configuration(input);
  }

  capabilities(): ProviderCapability[] {
    return ["chat", "text-generation", "streaming", "model-discovery", "usage-reporting"];
  }

  private async client(config: GeminiConfiguration): Promise<GoogleGenAI> {
    const apiKey = await resolveCredential(this.credentials, config.credentialRef, this.id);
    if (!apiKey) throw new ProviderError(this.id, "missing_credential");
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: config.timeoutMs,
        retryOptions: { attempts: 1 },
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      },
    });
  }

  async listModels(input: unknown, signal?: AbortSignal): Promise<ProviderModel[]> {
    const config = configuration(input);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    try {
      const page = await client.models.list({ config: { abortSignal } });
      const models: ProviderModel[] = [];
      for await (const model of page) {
        const parsed = z
          .object({
            name: z.string().min(1).max(512),
            displayName: z.string().optional(),
            supportedActions: z.array(z.string()).optional(),
          })
          .safeParse(model);
        if (!parsed.success) throw new ProviderError(this.id, "invalid_response");
        models.push(
          providerModelSchema.parse({
            id: parsed.data.name.replace(/^models\//, ""),
            ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
            capabilities: this.capabilities(),
            metadata: parsed.data.supportedActions
              ? { supportedActions: parsed.data.supportedActions }
              : {},
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
    const models = await this.listModels(input, signal);
    const model = modelId ? models.find((entry) => entry.id === modelId) : models[0];
    if (modelId && !model) throw new ProviderError(this.id, "model_not_found");
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
    const parsed = chatRequestSchema.safeParse(chatRequest);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_request");
    const config = configuration(input);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    const systemInstruction = parsed.data.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const contents = parsed.data.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
    if (!contents.length) throw new ProviderError(this.id, "invalid_request");
    const started = performance.now();
    try {
      const response = await client.models.generateContent({
        model: parsed.data.model,
        contents,
        config: {
          abortSignal,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(parsed.data.temperature !== undefined
            ? { temperature: parsed.data.temperature }
            : {}),
          ...(parsed.data.maxOutputTokens !== undefined
            ? { maxOutputTokens: parsed.data.maxOutputTokens }
            : {}),
          ...(parsed.data.stop ? { stopSequences: parsed.data.stop } : {}),
        },
      });
      const modelId = response.modelVersion ?? parsed.data.model;
      const usage = toUsage(modelId, response.usageMetadata, performance.now() - started);
      const finishReason = response.candidates?.[0]?.finishReason;
      const requestId = response.sdkHttpResponse?.headers?.["x-request-id"];
      return {
        providerId: this.id,
        modelId,
        text: textFrom(response),
        ...(finishReason ? { finishReason: String(finishReason) } : {}),
        ...(usage ? { usage } : {}),
        ...(requestId ? { requestId } : {}),
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
    const parsed = chatRequestSchema.safeParse(chatRequest);
    if (!parsed.success) throw new ProviderError(this.id, "invalid_request");
    const config = configuration(input);
    const client = await this.client(config);
    const abortSignal = requestSignal(signal, config.timeoutMs);
    const systemInstruction = parsed.data.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const contents = parsed.data.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
    if (!contents.length) throw new ProviderError(this.id, "invalid_request");
    const started = performance.now();
    let text = "";
    let latest: GenerateContentResponse | undefined;
    try {
      const stream = await client.models.generateContentStream({
        model: parsed.data.model,
        contents,
        config: {
          abortSignal,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(parsed.data.temperature !== undefined
            ? { temperature: parsed.data.temperature }
            : {}),
          ...(parsed.data.maxOutputTokens !== undefined
            ? { maxOutputTokens: parsed.data.maxOutputTokens }
            : {}),
          ...(parsed.data.stop ? { stopSequences: parsed.data.stop } : {}),
        },
      });
      for await (const chunk of stream) {
        latest = chunk;
        const delta = textFrom(chunk);
        if (delta) {
          text += delta;
          yield { type: "text_delta", text: delta };
        }
      }
    } catch (error) {
      throw normalizeSdkError(this.id, error, abortSignal);
    }
    if (!latest) throw new ProviderError(this.id, "invalid_response");
    const modelId = latest.modelVersion ?? parsed.data.model;
    const usage = toUsage(modelId, latest.usageMetadata, performance.now() - started);
    const finishReason = latest.candidates?.[0]?.finishReason;
    yield {
      type: "completed",
      response: {
        providerId: this.id,
        modelId,
        text,
        ...(finishReason ? { finishReason: String(finishReason) } : {}),
        ...(usage ? { usage } : {}),
        ...(latest.sdkHttpResponse?.headers?.["x-request-id"]
          ? { requestId: latest.sdkHttpResponse.headers["x-request-id"] }
          : {}),
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
