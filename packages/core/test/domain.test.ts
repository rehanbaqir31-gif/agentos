import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  createProviderSchema,
  parseAgentEvent,
  projectSchema,
  runManifestSchema,
  serializeAgentEvent,
} from "../src/index.js";

const timestamp = "2026-11-05T12:00:00.000Z";
const id = "8caa09c9-6dc8-4313-8915-df9adefbfb95";

describe("domain schemas", () => {
  it("applies documented local-safe project defaults", () => {
    const project = projectSchema.parse({
      id,
      name: "AgentOS",
      description: null,
      repositoryPath: "C:/work/repo",
      repositoryUrl: null,
      defaultBranch: null,
      currentCommit: null,
      settings: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(project.settings).toEqual({ permissionMode: "supervised", networkAccess: "disabled" });
  });

  it("does not accept plaintext provider credentials", () => {
    expect(() =>
      createProviderSchema.parse({
        name: "Local",
        providerType: "ollama",
        baseUrl: "http://localhost:11434",
        credentialRef: null,
        availableModels: [],
        configuration: {},
        enabled: true,
        apiKey: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(() =>
      createProviderSchema.parse({
        name: "Remote",
        providerType: "openai_compatible",
        baseUrl: "https://user:password@api.example.test/v1",
        credentialRef: null,
        availableModels: [],
        configuration: {},
        enabled: true,
      }),
    ).toThrow();
  });

  it("rejects manifest configuration with secret-like keys or environment values", () => {
    const base = {
      version: 1,
      runId: id,
      agentId: id,
      agentName: "Aider",
      adapterId: "aider",
      adapterVersion: "1.2.3",
      providerId: null,
      modelId: null,
      promptConfigurationHash: "a".repeat(64),
      repositoryCommitSha: null,
      toolVersions: {},
      skillVersions: {},
      permissionConfiguration: { permissionMode: "supervised", networkAccess: "disabled" },
      environmentVariableNames: ["OPENAI_API_KEY"],
      createdAt: timestamp,
      id,
    };
    expect(() =>
      runManifestSchema.parse({ ...base, runtimeConfiguration: { apiKey: "secret" } }),
    ).toThrow();
    expect(
      runManifestSchema.parse({ ...base, runtimeConfiguration: {} }).environmentVariableNames,
    ).toEqual(["OPENAI_API_KEY"]);
  });

  it("normalizes only safe event payloads and rejects model reasoning fields", () => {
    const valid = {
      id,
      runId: id,
      sequence: 1,
      occurredAt: timestamp,
      type: "agent.status",
      data: { status: "working", message: "Inspecting project files" },
    } as const;
    expect(agentEventSchema.parse(valid)).toMatchObject({ type: "agent.status" });
    expect(() =>
      agentEventSchema.parse({
        ...valid,
        type: "agent.status",
        data: { status: "working", message: null, chainOfThought: "private" },
      }),
    ).toThrow();
    expect(() =>
      agentEventSchema.parse({ ...valid, occurredAt: "2026-11-05T12:00:00+03:00" }),
    ).toThrow();
    const sanitized = parseAgentEvent(
      serializeAgentEvent({
        id,
        runId: id,
        sequence: 1,
        occurredAt: timestamp,
        type: "run.failed",
        data: {
          code: "provider_error",
          message: "Request failed API_KEY=sk-test-secret-value-123",
        },
      }),
    );
    expect(sanitized.data).toEqual({
      code: "provider_error",
      message: "Request failed API_KEY=[REDACTED]",
    });
  });
});
