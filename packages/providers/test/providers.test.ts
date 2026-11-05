import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "@agentos/database";
import { Repositories } from "@agentos/database";
import {
  EnvironmentCredentialStore,
  MemoryCredentialStore,
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAiProvider,
  OpenAiCompatibleProvider,
  OsKeychainCredentialStore,
  ProviderError,
  ProviderRegistry,
} from "../src/index.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
const servers: Server[] = [];
let tempDirectory: string | undefined;

async function mockServer(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock HTTP server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("credential references", () => {
  it("reads environment references explicitly and never writes them", async () => {
    const store = new EnvironmentCredentialStore({ AGENTOS_TEST_KEY: "test-value" });
    await expect(store.get("env:AGENTOS_TEST_KEY")).resolves.toBe("test-value");
    await expect(store.get("AGENTOS_TEST_KEY")).resolves.toBeUndefined();
    await expect(store.set("env:AGENTOS_TEST_KEY", "new-value")).rejects.toThrow("read-only");
  });

  it("supports credential rotation and removal in memory and delegates keychain operations", async () => {
    const memory = new MemoryCredentialStore();
    await memory.set("test:account", "old");
    await memory.set("test:account", "rotated");
    await expect(memory.get("test:account")).resolves.toBe("rotated");
    await memory.delete("test:account");
    await expect(memory.get("test:account")).resolves.toBeUndefined();

    const data = new Map<string, string>();
    const keychain = new OsKeychainCredentialStore({
      async read(service, account) {
        return data.get(`${service}:${account}`);
      },
      async write(service, account, value) {
        data.set(`${service}:${account}`, value);
      },
      async remove(service, account) {
        data.delete(`${service}:${account}`);
      },
    });
    await keychain.set("keychain:openai/main", "secret");
    await expect(keychain.get("keychain:openai/main")).resolves.toBe("secret");
    await keychain.delete("keychain:openai/main");
    await expect(keychain.get("keychain:openai/main")).resolves.toBeUndefined();
  });
});

describe("Ollama provider", () => {
  it("validates safe endpoints and reports a local server version and model metadata", async () => {
    const baseUrl = await mockServer((request, response) => {
      if (request.url === "/api/version") return json(response, 200, { version: "0.15.0" });
      if (request.url === "/api/tags")
        return json(response, 200, {
          models: [{ name: "qwen:latest", size: 100, digest: "abc", details: { family: "qwen" } }],
        });
      if (request.url === "/api/show")
        return json(response, 200, {
          capabilities: ["completion", "tools", "vision"],
          details: { family: "qwen" },
        });
      json(response, 404, {});
    });
    const provider = new OllamaProvider(new MemoryCredentialStore());
    expect(provider.validateConfiguration({}).baseUrl).toBe("http://127.0.0.1:11434");
    expect(() =>
      provider.validateConfiguration({ baseUrl: "http://user:pass@example.test" }),
    ).toThrow(ProviderError);
    expect(() =>
      provider.validateConfiguration({ baseUrl: "http://provider.example.test" }),
    ).toThrow(ProviderError);
    const config = { baseUrl };
    const result = await provider.testConnection(config, "qwen:latest");
    expect(result).toMatchObject({ ok: true, version: "0.15.0", model: { id: "qwen:latest" } });
    expect(result.model?.capabilities).toEqual(["tool-calling", "vision"]);
    expect(await provider.healthCheck(config)).toMatchObject({
      status: "healthy",
      version: "0.15.0",
    });
    expect(provider.capabilities()).not.toContain("tool-calling");
  });

  it("uses the documented generate and chat endpoints and maps reported usage only", async () => {
    const received: Array<{ path: string; data: Record<string, unknown> }> = [];
    const baseUrl = await mockServer(async (request, response) => {
      received.push({ path: request.url ?? "", data: await body(request) });
      if (request.url === "/api/chat") {
        json(response, 200, {
          model: "qwen:latest",
          message: { role: "assistant", content: "hello" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 5,
          eval_count: 2,
        });
      } else {
        json(response, 200, {
          model: "qwen:latest",
          response: "generated",
          thinking: "private reasoning must not surface",
          done: true,
          prompt_eval_count: 3,
          eval_count: 1,
        });
      }
    });
    const provider = new OllamaProvider(new MemoryCredentialStore());
    const config = { baseUrl };
    const request = { model: "qwen:latest", messages: [{ role: "user" as const, content: "hi" }] };
    const chat = await provider.chat(config, request);
    const generated = await provider.generate(config, { model: "qwen:latest", prompt: "hi" });
    expect(chat).toMatchObject({
      text: "hello",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    expect(generated.text).toBe("generated");
    expect(JSON.stringify(generated)).not.toContain("private reasoning");
    expect(generated.usage?.totalTokens).toBe(4);
    expect(received.map((request) => request.path)).toEqual(["/api/chat", "/api/generate"]);
    expect(received.every((request) => request.data["stream"] === false)).toBe(true);
  });

  it("parses NDJSON chat/generate streams, reports usage, and never returns thinking data", async () => {
    const baseUrl = await mockServer(async (request, response) => {
      await body(request);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      if (request.url === "/api/chat") {
        response.write('{"message":{"content":"Hi "},"done":false}\n');
        response.write(
          '{"message":{"content":"there"},"thinking":"hidden","done":true,"model":"qwen","prompt_eval_count":4,"eval_count":2}\n',
        );
      } else {
        response.write('{"response":"safe","thinking":"hidden","done":false}\n');
        response.write('{"response":" text","done":true,"model":"qwen","eval_count":2}\n');
      }
      response.end();
    });
    const provider = new OllamaProvider(new MemoryCredentialStore());
    const config = { baseUrl };
    const chatEvents = [];
    for await (const event of provider.streamChat(config, {
      model: "qwen",
      messages: [{ role: "user", content: "hi" }],
    }))
      chatEvents.push(event);
    const generateEvents = [];
    for await (const event of provider.streamGenerate(config, { model: "qwen", prompt: "hi" }))
      generateEvents.push(event);
    expect(chatEvents.at(-1)).toMatchObject({
      type: "completed",
      response: { text: "Hi there", usage: { totalTokens: 6 } },
    });
    expect(generateEvents.at(-1)).toMatchObject({
      type: "completed",
      response: { text: "safe text" },
    });
    expect(JSON.stringify([...chatEvents, ...generateEvents])).not.toContain("hidden");
  });

  it("normalizes missing server, model errors, cancellation, and request timeouts", async () => {
    const baseUrl = await mockServer((request, response) => {
      if (request.url === "/api/version") return json(response, 200, { version: "0.15.0" });
      if (request.url === "/api/tags") return json(response, 200, { models: [] });
      if (request.url === "/api/chat") return;
      if (request.url === "/hang") return;
      json(response, 404, { error: "private server details" });
    });
    const provider = new OllamaProvider(new MemoryCredentialStore());
    await expect(provider.getModel({ baseUrl }, "missing")).rejects.toMatchObject({
      code: "model_not_found",
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    await expect(
      provider.chat(
        { baseUrl, timeoutMs: 10_000 },
        { model: "m", messages: [{ role: "user", content: "x" }] },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      provider.chat(
        { baseUrl, timeoutMs: 100 },
        { model: "m", messages: [{ role: "user", content: "x" }] },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(
      await provider.healthCheck({ baseUrl: "http://127.0.0.1:1", timeoutMs: 100 }),
    ).toMatchObject({ status: "unavailable" });
  });
});

describe("OpenAI-compatible provider", () => {
  it("supports custom endpoints, credential refs, custom headers and normalized chat usage", async () => {
    const baseUrl = await mockServer(async (request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers["x-tenant"]).toBe("local-dev");
      expect(request.headers.authorization).toBe("Bearer test-api-key");
      const requestBody = await body(request);
      expect(requestBody["model"]).toBe("test-model");
      json(response, 200, {
        id: "req-safe-id",
        model: "test-model-v2",
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      });
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set("keychain:test/model", "test-api-key");
    const provider = new OpenAiCompatibleProvider(credentials);
    const config = {
      baseUrl: `${baseUrl}/v1`,
      model: "test-model",
      credentialRef: "keychain:test/model",
      headers: { "x-tenant": "local-dev" },
    };
    const response = await provider.chat(config, {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response).toMatchObject({
      providerId: "openai_compatible",
      modelId: "test-model-v2",
      text: "hello",
      requestId: "req-safe-id",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, cachedInputTokens: 2 },
    });
    expect(JSON.stringify(response)).not.toContain("test-api-key");
  });

  it("parses SSE deltas, completion, request metadata and optional usage", async () => {
    const baseUrl = await mockServer(async (request, response) => {
      await body(request);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"req-1","model":"m","choices":[{"delta":{"content":"A"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n\n');
      response.write(
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const provider = new OpenAiCompatibleProvider(new MemoryCredentialStore());
    const events = [];
    for await (const event of provider.streamChat(
      { baseUrl: `${baseUrl}/v1`, model: "m", supportsUsageReporting: true },
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      },
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: { text: "AB", finishReason: "stop", requestId: "req-1", usage: { totalTokens: 4 } },
    });
  });

  it("cancels an active SSE request", async () => {
    const baseUrl = await mockServer(async (request, response) => {
      await body(request);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    });
    const provider = new OpenAiCompatibleProvider(new MemoryCredentialStore());
    const controller = new AbortController();
    const iterable = provider.streamChat(
      { baseUrl, model: "m", timeoutMs: 10_000 },
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      },
      controller.signal,
    );
    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text_delta", text: "partial" },
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("makes capability, model discovery, connection-test, timeout and error behavior configurable", async () => {
    let chatCalls = 0;
    let healthy = true;
    const baseUrl = await mockServer(async (request, response) => {
      if (request.url === "/v1/models") return json(response, 200, { data: [{ id: "model-a" }] });
      if (request.url === "/health") return json(response, healthy ? 200 : 503, { ok: true });
      if (request.url === "/v1/chat/completions") {
        chatCalls += 1;
        await body(request);
        return json(response, 200, { model: "model-a", choices: [{ message: { content: "ok" } }] });
      }
      if (request.url === "/unauthorized")
        return json(response, 401, { error: "token=should-not-leak" });
      if (request.url === "/hang") return;
      json(response, 404, {});
    });
    const provider = new OpenAiCompatibleProvider(new MemoryCredentialStore());
    const config = {
      baseUrl: `${baseUrl}/v1`,
      model: "model-a",
      modelDiscoveryPath: "models",
      healthCheckPath: "../health",
    };
    expect(provider.capabilities(config)).toContain("model-discovery");
    await expect(provider.listModels(config)).resolves.toMatchObject([{ id: "model-a" }]);
    await expect(provider.getModel(config, "absent")).rejects.toMatchObject({
      code: "model_not_found",
    });
    await expect(provider.testConnection(config)).resolves.toMatchObject({ ok: true });
    expect(chatCalls).toBe(0);
    await expect(provider.healthCheck(config)).resolves.toMatchObject({ status: "healthy" });
    healthy = false;
    await expect(provider.healthCheck(config)).resolves.toMatchObject({ status: "unavailable" });
    await expect(provider.listModels({ baseUrl, model: "m" })).rejects.toMatchObject({
      code: "unsupported_operation",
    });
    await expect(
      provider.chat(
        { baseUrl, model: "m", chatCompletionsPath: "unauthorized" },
        { model: "m", messages: [{ role: "user", content: "x" }] },
      ),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      provider.chat(
        { baseUrl, model: "m", credentialRef: "keychain:missing" },
        { model: "m", messages: [{ role: "user", content: "x" }] },
      ),
    ).rejects.toMatchObject({ code: "missing_credential" });
    expect(() =>
      provider.validateConfiguration({
        baseUrl: "https://user:password@example.test/v1",
        model: "m",
      }),
    ).toThrow(ProviderError);
    expect(() =>
      provider.validateConfiguration({
        baseUrl,
        model: "m",
        headers: { Authorization: "plaintext-secret" },
      }),
    ).toThrow(ProviderError);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    await expect(
      provider.chat(
        { baseUrl, model: "m", chatCompletionsPath: "hang", timeoutMs: 10_000 },
        { model: "m", messages: [{ role: "user", content: "x" }] },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      provider.chat(
        { baseUrl, model: "m", chatCompletionsPath: "hang", timeoutMs: 100 },
        { model: "m", messages: [{ role: "user", content: "x" }] },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("official provider SDK drivers", () => {
  it("uses the OpenAI Responses API for chat and streaming, with normalized usage", async () => {
    const routes: string[] = [];
    const baseUrl = await mockServer(async (request, response) => {
      routes.push(request.url ?? "");
      if (request.url === "/models")
        return json(response, 200, {
          object: "list",
          data: [{ id: "gpt-test", object: "model", created: 1, owned_by: "mock" }],
          has_more: false,
        });
      const input = await body(request);
      if (input["stream"] === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "streamed" })}\n\n`,
        );
        response.write(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-1", object: "response", status: "completed", model: "gpt-test", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "streamed", annotations: [] }] }], output_text: "streamed", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        return response.end();
      }
      json(response, 200, {
        id: "resp-2",
        object: "response",
        status: "completed",
        model: "gpt-test",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        ],
        output_text: "hello",
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set("env:OPENAI_API_KEY", "mock-key");
    const provider = new OpenAiProvider(credentials);
    const config = { model: "gpt-test", baseUrl };
    const listed = await provider.listModels(config);
    expect(routes).toEqual(["/models"]);
    expect(listed).toMatchObject([{ id: "gpt-test" }]);
    const request = { model: "gpt-test", messages: [{ role: "user" as const, content: "hello" }] };
    await expect(provider.chat(config, request)).resolves.toMatchObject({
      text: "hello",
      usage: { totalTokens: 6, cachedInputTokens: 1 },
    });
    const events = [];
    for await (const event of provider.streamChat(config, request)) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: { text: "streamed", usage: { totalTokens: 6 } },
    });
    expect(routes).toEqual(["/models", "/responses", "/responses"]);
  });

  it("uses the Anthropic Messages API for model discovery, chat and streaming", async () => {
    const routes: string[] = [];
    const baseUrl = await mockServer(async (request, response) => {
      routes.push(request.url ?? "");
      if (request.url?.startsWith("/v1/models"))
        return json(response, 200, {
          data: [
            {
              id: "claude-test",
              type: "model",
              display_name: "Claude Test",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          has_more: false,
          first_id: "claude-test",
          last_id: "claude-test",
        });
      const input = await body(request);
      if (input["stream"] === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        );
        response.write(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        );
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
        );
        response.write(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
        );
        response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return response.end();
      }
      json(response, 200, {
        id: "msg-2",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set("env:ANTHROPIC_API_KEY", "mock-key");
    const provider = new AnthropicProvider(credentials);
    const config = { model: "claude-test", baseUrl };
    await expect(provider.listModels(config)).resolves.toMatchObject([{ id: "claude-test" }]);
    const request = {
      model: "claude-test",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    await expect(provider.chat(config, request)).resolves.toMatchObject({
      text: "hello",
      usage: { totalTokens: 5 },
    });
    const events = [];
    for await (const event of provider.streamChat(config, request)) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: { text: "hello", usage: { totalTokens: 5 } },
    });
    expect(routes).toEqual(["/v1/models", "/v1/messages", "/v1/messages"]);
  });

  it("uses Gemini generateContent for chat and stream with API usage reporting", async () => {
    const routes: string[] = [];
    const baseUrl = await mockServer(async (request, response) => {
      routes.push(request.url ?? "");
      if (request.method === "GET" && request.url?.startsWith("/v1beta/models"))
        return json(response, 200, {
          models: [
            {
              name: "models/gemini-test",
              displayName: "Gemini Test",
              supportedActions: ["generateContent"],
            },
          ],
        });
      await body(request);
      const answer = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "private reasoning", thought: true }, { text: "hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        modelVersion: "gemini-test",
      };
      if (request.url?.includes("alt=sse")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(answer)}\n\n`);
        response.end();
      } else json(response, 200, answer);
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set("env:GOOGLE_API_KEY", "mock-key");
    const provider = new GeminiProvider(credentials);
    const config = { model: "gemini-test", baseUrl };
    await expect(provider.listModels(config)).resolves.toMatchObject([{ id: "gemini-test" }]);
    const request = {
      model: "gemini-test",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    const reply = await provider.chat(config, request);
    expect(reply).toMatchObject({ text: "hello", usage: { totalTokens: 6 } });
    expect(JSON.stringify(reply)).not.toContain("private reasoning");
    const events = [];
    for await (const event of provider.streamChat(config, request)) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: { text: "hello", usage: { totalTokens: 6 } },
    });
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(routes).toEqual([
      "/v1beta/models",
      "/v1beta/models/gemini-test:generateContent",
      "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    ]);
    expect(JSON.stringify(routes)).not.toContain("mock-key");
  });

  it("normalizes official SDK authentication errors without returning provider response details", async () => {
    const baseUrl = await mockServer((_request, response) =>
      json(response, 401, { error: "apiKey=do-not-leak" }),
    );
    const credentials = new MemoryCredentialStore();
    await credentials.set("env:OPENAI_API_KEY", "mock-key");
    await credentials.set("env:ANTHROPIC_API_KEY", "mock-key");
    await credentials.set("env:GOOGLE_API_KEY", "mock-key");
    const chat = { model: "model", messages: [{ role: "user" as const, content: "hi" }] };
    const cases = [
      [new OpenAiProvider(credentials), { model: "model", baseUrl }, "openai"],
      [new AnthropicProvider(credentials), { model: "model", baseUrl }, "anthropic"],
      [new GeminiProvider(credentials), { model: "model", baseUrl }, "google"],
    ] as const;
    for (const [provider, config, providerId] of cases) {
      await expect(provider.chat(config, chat)).rejects.toMatchObject({
        providerId,
        code: "authentication_failed",
        message: expect.not.stringContaining("do-not-leak"),
      });
    }
  });
});

describe("provider registry and database integration", () => {
  it("persists safe provider configuration, resolves model selections and manages enabled state", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "agentos-provider-test-"));
    const database = await openDatabase({ filename: join(tempDirectory, "providers.sqlite") });
    try {
      const repository = new Repositories(database).providers;
      const credentials = new MemoryCredentialStore();
      const ollama = new OllamaProvider(credentials);
      const compatible = new OpenAiCompatibleProvider(credentials);
      const registry = new ProviderRegistry(repository);
      registry.register(ollama);
      registry.register(compatible);
      registry.register(new OpenAiProvider(credentials));
      registry.register(new AnthropicProvider(credentials));
      registry.register(new GeminiProvider(credentials));
      expect(() => registry.register(ollama)).toThrow(ProviderError);
      expect(registry.listDrivers().map((driver) => driver.id)).toEqual([
        "anthropic",
        "google",
        "ollama",
        "openai",
        "openai_compatible",
      ]);
      const officialProvider = await registry.add({
        driverId: "openai",
        name: "OpenAI",
        configuration: { model: "gpt-test" },
      });
      expect(officialProvider).toMatchObject({
        providerType: "openai",
        credentialRef: "env:OPENAI_API_KEY",
        configuration: { model: "gpt-test" },
      });
      const provider = await registry.add({
        driverId: "openai_compatible",
        name: "Mock endpoint",
        configuration: {
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "configured-model",
          credentialRef: "env:TEST_PROVIDER_KEY",
          headers: { "x-tenant": "test" },
        },
      });
      expect(provider.credentialRef).toBe("env:TEST_PROVIDER_KEY");
      expect(JSON.stringify(provider.configuration)).not.toContain("TEST_PROVIDER_KEY");
      expect(JSON.stringify(provider.configuration)).not.toContain("test-api-key");
      const updated = await registry.updateConfiguration(provider.id, {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "configured-model",
        credentialRef: "keychain:agentos/provider",
        headers: { "x-tenant": "rotated" },
      });
      expect(updated.credentialRef).toBe("keychain:agentos/provider");
      expect(updated.availableModels).toEqual([]);
      await expect(registry.resolveModel("configured-model")).resolves.toMatchObject({
        provider: { id: provider.id },
        model: { metadata: { discovery: "configured" } },
      });
      await registry.setEnabled(provider.id, false);
      await expect(registry.resolveModel("configured-model")).rejects.toMatchObject({
        code: "model_not_found",
      });
      expect((await registry.list())[0]?.capabilities).toEqual([]);
      await registry.setEnabled(provider.id, true);
      await expect(registry.remove(provider.id)).resolves.toBe(true);
      await expect(registry.remove(officialProvider.id)).resolves.toBe(true);
      await expect(registry.remove(randomUUID())).resolves.toBe(false);
    } finally {
      database.close();
    }
  });
});
