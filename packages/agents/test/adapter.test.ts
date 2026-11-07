import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { adapterConfigSchema } from "../src/contracts.js";
import { normalizeOpenCodeEvent, OpenCodeAdapter, parseOpenCodeVersion } from "../src/opencode.js";
import { AdapterRegistry } from "../src/registry.js";

const config = adapterConfigSchema.parse({
  projectDirectory: "C:\\work\\repo",
  permissionMode: "supervised",
});
const runtime = {
  allocate: vi.fn(async () => ({
    workspacePath: "C:\\runs\\1",
    serverUrl: "http://127.0.0.1:4096",
    authorizationHeader: "Basic dGVzdA==",
    cancel: vi.fn(async () => undefined),
    collectResults: vi.fn(async () => ({
      status: "succeeded" as const,
      summary: null,
      changedFiles: [],
      diff: null,
    })),
    dispose: vi.fn(async () => undefined),
  })),
};

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
        prompt: vi.fn(async () => ({ data: { info: { time: { completed: 1 } } } })),
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
    expect(sdk.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ query: { directory: "C:\\runs\\1" } }),
    );
  });

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
        response.end(JSON.stringify({ info: { time: { completed: 2 } }, parts: [] }));
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
          serverUrl: `http://127.0.0.1:${address.port}`,
          authorizationHeader: "Basic dGVzdA==",
          cancel: async () => undefined,
          collectResults: async () => ({
            status: "succeeded",
            summary: null,
            changedFiles: [],
            diff: null,
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
