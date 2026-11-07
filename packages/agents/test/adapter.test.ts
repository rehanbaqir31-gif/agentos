import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { adapterConfigSchema } from "../src/contracts.js";
import {
  extractOpenCodeFinalText,
  normalizeOpenCodeEvent,
  OpenCodeAdapter,
  parseOpenCodeVersion,
} from "../src/opencode.js";
import { AdapterRegistry } from "../src/registry.js";

const config = adapterConfigSchema.parse({
  projectDirectory: "C:\\work\\repo",
  permissionMode: "supervised",
});
const runtime = {
  allocate: vi.fn(async () => ({
    workspacePath: "C:\\runs\\1",
    baseCommit: "a".repeat(40),
    adapterVersion: "1.2.0",
    runtimeConfiguration: {
      isolationMode: "docker" as const,
      networkAccess: "disabled" as const,
      timeoutSeconds: 3600,
      memoryLimitMb: 2048,
      cpuLimit: 2,
      networkAllowlist: [],
    },
    serverUrl: "http://127.0.0.1:4096",
    authorizationHeader: "Basic dGVzdA==",
    cancel: vi.fn(async () => undefined),
    collectResults: vi.fn(async () => ({
      status: "succeeded" as const,
      summary: null,
      changedFiles: [],
      diff: null,
      fileHashes: {},
    })),
    dispose: vi.fn(async () => undefined),
  })),
};

async function createPromptFixture(
  prompt: (options: { signal?: AbortSignal }) => Promise<unknown>,
) {
  const sdk = {
    session: {
      create: vi.fn(async () => ({ data: { id: "prompt-session" } })),
      prompt: vi.fn(prompt),
    },
  } as unknown as OpencodeClient;
  const adapter = new OpenCodeAdapter(runtime, { version: async () => "1.2.0" }, () => sdk);
  const session = await adapter.initializeSession(config, "prompt-run");
  return { adapter, session, sdk };
}

describe("OpenCode adapter", () => {
  it("parses CLI version output and rejects unsupported majors", async () => {
    expect(parseOpenCodeVersion("1.2.3 (opencode)")).toBe("1.2.3");
    const adapter = new OpenCodeAdapter(runtime, { version: async () => "2.0.0" });
    expect(await adapter.detect(config)).toMatchObject({ installed: false, version: "2.0.0" });
  });

  it("validates environment and blocks secret-bearing values", () => {
    expect(() =>
      adapterConfigSchema.parse({ ...config, environment: { API_TOKEN: "abc" } }),
    ).toThrow();
    expect(() =>
      adapterConfigSchema.parse({ ...config, permissionMode: "unrestricted" }),
    ).toThrow();
  });

  it("normalizes structured v2 tool, file, permission events and discards reasoning", () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: "session.next.tool.called",
          properties: { sessionID: "s1", callID: "c1", tool: "bash", input: { command: "ls" } },
        },
        "now",
      ),
    ).toEqual({ type: "tool.started", sessionId: "s1", at: "now", tool: "bash", callId: "c1" });
    expect(
      normalizeOpenCodeEvent({ type: "file.edited", properties: { file: "src/index.ts" } }, "now"),
    ).toEqual({ type: "file.changed", sessionId: "", at: "now", path: "src/index.ts" });
    expect(
      normalizeOpenCodeEvent(
        {
          type: "permission.v2.asked",
          properties: {
            id: "p1",
            sessionID: "s1",
            action: "external_directory",
            resources: ["/tmp"],
          },
        },
        "now",
      ),
    ).toMatchObject({ type: "permission.requested", permissionId: "p1", resources: ["/tmp"] });
    expect(
      normalizeOpenCodeEvent({
        type: "session.next.reasoning.delta",
        properties: { sessionID: "s1", text: "private thought" },
      }),
    ).toBeNull();
  });

  it("captures only user-facing final text and redacts common secrets", () => {
    expect(
      extractOpenCodeFinalText([
        { type: "reasoning", text: "private thought" },
        { type: "text", text: "README describes the project. sk-abcdefghijklmnop1234" },
        { type: "text", text: "ignored", ignored: true },
        { type: "text", text: "synthetic", synthetic: true },
      ]),
    ).toBe("README describes the project. [REDACTED]");
    expect(extractOpenCodeFinalText(undefined)).toBeNull();
  });

  it("keeps execution unavailable when no isolation runtime is supplied", async () => {
    const adapter = new OpenCodeAdapter(undefined, { version: async () => "1.2.0" });
    expect(adapter.capabilities().isolatedExecution).toBe(false);
    await expect(adapter.initializeSession(config, "run")).rejects.toThrow(
      /no verified isolated runtime/,
    );
  });

  it("uses the isolated workspace to create and execute a session", async () => {
    const sdk = {
      session: {
        create: vi.fn(async () => ({ data: { id: "session-a" } })),
        prompt: vi.fn(async () => ({
          data: {
            info: { role: "assistant", sessionID: "session-a", time: { completed: 1 } },
            parts: [
              { type: "reasoning", text: "private reasoning" },
              { type: "text", text: "The README explains the repository." },
            ],
          },
        })),
      },
    } as unknown as OpencodeClient;
    const adapter = new OpenCodeAdapter(runtime, { version: async () => "1.2.0" }, () => sdk);
    const session = await adapter.initializeSession(config, "run-a");
    expect(session.id).toBe("session-a");
    expect(sdk.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ query: { directory: "C:\\runs\\1" } }),
    );
    const result = await adapter.execute(
      config,
      session,
      "Update the README",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("The README explains the repository.");
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
    expect(sdk.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ query: { directory: "C:\\runs\\1" } }),
    );
  });

  it("accepts an empty assistant text when completion is confirmed", async () => {
    const { adapter, session } = await createPromptFixture(async () => ({
      data: {
        info: { role: "assistant", sessionID: "prompt-session", time: { completed: 1 } },
        parts: [],
      },
    }));
    try {
      const result = await adapter.execute(
        config,
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "succeeded", summary: null });
    } finally {
      await adapter.dispose();
    }
  });

  it("returns incomplete when assistant completion metadata is missing", async () => {
    const { adapter, session } = await createPromptFixture(async () => ({
      data: {
        info: { role: "assistant", sessionID: "prompt-session", time: {} },
        parts: [{ type: "text", text: "partial answer" }],
      },
    }));
    try {
      const result = await adapter.execute(
        config,
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "incomplete", summary: null });
    } finally {
      await adapter.dispose();
    }
  });

  it("returns incomplete when the SDK response has no assistant metadata", async () => {
    const { adapter, session } = await createPromptFixture(async () => ({ data: undefined }));
    try {
      const result = await adapter.execute(
        config,
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result.status).toBe("incomplete");
    } finally {
      await adapter.dispose();
    }
  });

  it("does not accept completion metadata for a different session", async () => {
    const { adapter, session } = await createPromptFixture(async () => ({
      data: {
        info: { role: "assistant", sessionID: "unrelated-session", time: { completed: 1 } },
        parts: [{ type: "text", text: "unrelated response" }],
      },
    }));
    try {
      const result = await adapter.execute(
        config,
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "incomplete", summary: null });
    } finally {
      await adapter.dispose();
    }
  });

  it("classifies typed provider errors as failures and normalizes failed session events", async () => {
    const { adapter, session } = await createPromptFixture(async () => ({
      data: {
        info: {
          role: "assistant",
          sessionID: "prompt-session",
          time: { completed: 1 },
          error: { name: "ProviderAuthError", data: { message: "private provider details" } },
        },
        parts: [],
      },
    }));
    try {
      const result = await adapter.execute(
        config,
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "failed", summary: null });
      expect(result.terminationReason).toContain("ProviderAuthError");
      expect(result.terminationReason).not.toContain("private provider details");
    } finally {
      await adapter.dispose();
    }
    expect(
      normalizeOpenCodeEvent(
        { type: "session.error", properties: { sessionID: "s1", error: { name: "ApiError" } } },
        "now",
      ),
    ).toMatchObject({ type: "run.failed", sessionId: "s1" });
  });

  it("returns failed when the SDK prompt request is interrupted by a non-abort error", async () => {
    const { adapter, session } = await createPromptFixture(async () => {
      throw new Error("socket reset");
    });
    try {
      const result = await adapter.execute(
        config,
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "failed", summary: null });
      expect(result.terminationReason).toBe("OpenCode prompt request failed (Error)");
    } finally {
      await adapter.dispose();
    }
  });

  it("returns cancelled when the caller aborts the prompt", async () => {
    const { adapter, session } = await createPromptFixture(({ signal }) => {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    try {
      const result = await adapter.execute(config, session, "Inspect", controller.signal);
      expect(result).toMatchObject({ status: "cancelled", summary: null });
    } finally {
      await adapter.dispose();
    }
  });

  it("returns timed_out when the configured prompt timeout expires", async () => {
    const { adapter, session } = await createPromptFixture(({ signal }) => {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const allocation = await runtime.allocate.mock.results.at(-1)?.value;
    try {
      const result = await adapter.execute(
        { ...config, timeoutSeconds: 1 },
        session,
        "Inspect",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "timed_out", summary: null });
      expect(allocation?.cancel).toHaveBeenCalledOnce();
    } finally {
      await adapter.dispose();
    }
  }, 3_000);

  it("performs session and prompt requests through the official SDK against an API double", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url?.startsWith("/session?")) {
        response.end(
          JSON.stringify({
            id: "sdk-session",
            projectID: "project",
            directory: "C:\\runs\\1",
            title: "AgentOS run test",
            version: "1",
            time: { created: 1, updated: 1 },
          }),
        );
      } else if (
        request.method === "POST" &&
        request.url?.startsWith("/session/sdk-session/message?")
      ) {
        response.end(
          JSON.stringify({
            info: {
              role: "assistant",
              sessionID: "sdk-session",
              time: { completed: 2 },
            },
            parts: [],
          }),
        );
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Mock server did not bind a TCP port");
    const adapter = new OpenCodeAdapter(
      {
        allocate: async () => ({
          workspacePath: "C:\\runs\\1",
          baseCommit: "a".repeat(40),
          adapterVersion: "1.2.0",
          runtimeConfiguration: {
            isolationMode: "docker",
            networkAccess: "disabled",
            timeoutSeconds: 3600,
            memoryLimitMb: 2048,
            cpuLimit: 2,
            networkAllowlist: [],
          },
          serverUrl: `http://127.0.0.1:${address.port}`,
          authorizationHeader: "Basic dGVzdA==",
          cancel: async () => undefined,
          collectResults: async () => ({
            status: "succeeded",
            summary: null,
            changedFiles: [],
            diff: null,
            fileHashes: {},
          }),
          dispose: async () => undefined,
        }),
      },
      { version: async () => "1.2.0" },
    );
    try {
      const session = await adapter.initializeSession(config, "test-run");
      const result = await adapter.execute(
        config,
        session,
        "Do a safe task",
        new AbortController().signal,
      );
      expect(result.status).toBe("succeeded");
      expect(paths).toHaveLength(2);
      expect(paths[0]).toContain("/session?");
      expect(paths[1]).toContain("/session/sdk-session/message?");
    } finally {
      await adapter.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("prevents duplicate adapters and reports capabilities", () => {
    const adapter = new OpenCodeAdapter(runtime, { version: async () => "1.2.0" });
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(registry.list()[0]?.capabilities.isolatedExecution).toBe(true);
    expect(() => registry.register(adapter)).toThrow(/already registered/);
  });
});
