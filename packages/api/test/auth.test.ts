import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentOsServer } from "../src/server.js";
import { LocalAuthenticationService } from "../src/auth.js";
import { openDatabase, Repositories } from "@agentos/database";

const at = "2026-11-07T12:00:00.000Z";
const password = "correct horse battery staple 48!";
let directory: string;
let database: Awaited<ReturnType<typeof openDatabase>>;
let repositories: Repositories;
let app: Awaited<ReturnType<typeof createAgentOsServer>>;
let projectId: string;
let runId: string;
let current = at;

async function authenticatedCookie(username = "alice", secret = password) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: secret },
  });
  expect(response.statusCode).toBe(200);
  return response.headers["set-cookie"]!.split(";")[0]!;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentos-api-auth-"));
  current = at;
  database = await openDatabase({ filename: join(directory, "test.sqlite"), now: () => current });
  repositories = new Repositories(database);
  const project = await repositories.projects.create({
    name: "Owned project",
    description: null,
    repositoryPath: join(directory, "repository"),
    repositoryUrl: null,
    defaultBranch: "main",
    currentCommit: null,
    settings: { permissionMode: "read_only", networkAccess: "disabled" },
  });
  projectId = project.id;
  const agent = await repositories.agents.create({
    name: "Agent",
    adapterId: "test",
    version: "1",
    capabilities: [],
    configuration: {},
    enabled: true,
    healthStatus: "healthy",
  });
  const task = await repositories.tasks.create({
    projectId,
    title: "Task",
    description: "Task",
    priority: "normal",
    status: "open",
    assignedAgentId: agent.id,
    configuration: {},
  });
  const run = await repositories.runs.create({
    taskId: task.id,
    projectId,
    agentId: agent.id,
    adapterVersion: agent.version,
    providerId: null,
    modelId: null,
    status: "created",
    manifestId: null,
    workspaceId: null,
    startedAt: null,
    completedAt: null,
    error: null,
    usageMetrics: {},
  });
  runId = run.id;
  app = await createAgentOsServer({
    repositories,
    bootstrap: { username: "alice", password },
    now: () => current,
  });
});

afterEach(async () => {
  await app.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
});

describe("trusted local API authentication and authorization", () => {
  it("rejects anonymous requests and forged identity headers and body fields", async () => {
    expect((await app.inject({ method: "GET", url: "/projects" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/projects",
          headers: { "x-authenticated-user": "alice", "x-user-id": randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: "alice", password, principalId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("authenticates with a local password and returns a server-verified expiring cookie session", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice", password: "wrong password" },
    });
    expect(invalid.statusCode).toBe(401);
    const cookie = await authenticatedCookie();
    const setCookie = (
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "alice", password },
      })
    ).headers["set-cookie"]!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(password);
    expect(
      (await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } })).json(),
    ).toMatchObject({
      principal: { authSource: "local_password" },
    });
    const projectsResponse = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { cookie },
    });
    expect(projectsResponse.statusCode, projectsResponse.body).toBe(200);
    expect(projectsResponse.json().items).toHaveLength(1);
    const secretState = database.sqlite
      .prepare("SELECT password_hash FROM principals WHERE name = 'alice'")
      .get() as { password_hash: string };
    expect(secretState.password_hash).toMatch(/^scrypt\$/);
    expect(secretState.password_hash).not.toContain(password);
    expect(
      database.sqlite.prepare("SELECT token_hash FROM auth_sessions").all(),
    ).not.toContainEqual({ token_hash: cookie.split("=")[1] });
  });

  it("rejects expired and revoked server-side sessions", async () => {
    const cookie = await authenticatedCookie();
    current = new Date(Date.parse(at) + 8 * 60 * 60 * 1000 + 1).toISOString();
    expect(
      (await app.inject({ method: "GET", url: "/projects", headers: { cookie } })).statusCode,
    ).toBe(401);

    current = at;
    const liveCookie = await authenticatedCookie();
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: liveCookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/projects", headers: { cookie: liveCookie } }))
        .statusCode,
    ).toBe(401);

    const principal = await repositories.auth.findAnyPrincipal();
    const secondCookie = await authenticatedCookie();
    expect(await repositories.auth.revokePrincipal(principal!.id, current)).toBe(true);
    expect(
      (await app.inject({ method: "GET", url: "/projects", headers: { cookie: secondCookie } }))
        .statusCode,
    ).toBe(401);
  });

  it("forces new projects to read-only and rejects caller-supplied ownership", async () => {
    const cookie = await authenticatedCookie();
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: {
        name: "New project",
        description: null,
        repositoryPath: join(directory, "new-repository"),
        repositoryUrl: null,
        defaultBranch: "main",
        currentCommit: null,
        settings: { permissionMode: "autonomous", networkAccess: "allowlist" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().settings).toEqual({
      permissionMode: "read_only",
      networkAccess: "disabled",
    });
    const forged = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: {
        name: "Forged owner",
        description: null,
        repositoryPath: join(directory, "forged-repository"),
        repositoryUrl: null,
        defaultBranch: "main",
        currentCommit: null,
        settings: { permissionMode: "read_only", networkAccess: "disabled" },
        principalId: randomUUID(),
      },
    });
    expect(forged.statusCode).toBe(400);
  });

  it("does not expose another principal's projects, runs, approvals, or artifacts by guessed IDs", async () => {
    const token = randomBytes(32).toString("base64url");
    const strangerId = randomUUID();
    database.sqlite
      .prepare(
        "INSERT INTO principals(id, name, auth_source, password_hash, created_at) VALUES (?, 'stranger', 'local_password', 'test-only', ?)",
      )
      .run(strangerId, at);
    await repositories.auth.createSession({
      principalId: strangerId,
      tokenHash: LocalAuthenticationService.hashToken(token),
      expiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
    });
    const artifact = await repositories.artifacts.create({
      runId,
      projectId,
      type: "git_diff",
      logicalName: "diff",
      contentType: "text/plain",
      byteSize: 0,
      sha256: null,
      storageLocator: null,
      collectionStatus: "unavailable",
      collectionError: "Not collected",
    });
    const approval = await repositories.approvals.create({
      runId,
      actionType: "workspace.write",
      actionDescription: "Denied request",
      requestedPermissions: ["file.write"],
      status: "rejected",
      requestedAt: at,
      resolvedAt: at,
      resolvedBy: "owner",
    });
    const strangerCookie = `agentos_session=${token}`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/projects/${projectId}`,
          headers: { cookie: strangerCookie },
        })
      ).statusCode,
    ).toBe(404);
    const forgedAlice = {
      cookie: strangerCookie,
      "x-authenticated-user": "alice",
      "x-user-id": "alice",
    };
    expect(
      (await app.inject({ method: "GET", url: `/runs/${runId}`, headers: forgedAlice })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/runs/${runId}/approvals`, headers: forgedAlice }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/runs/${runId}/permission-grants/${approval.id}/revoke`,
          headers: forgedAlice,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/runs/${runId}/artifacts/${artifact.id}`,
          headers: forgedAlice,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("rejects cross-origin browser requests and binds the server explicitly to IPv4 loopback", async () => {
    const cookie = await authenticatedCookie();
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/health", headers: { host: "attacker.example" } }))
        .statusCode,
    ).toBe(403);
  });

  it("fails closed and does not disclose database errors during authentication", async () => {
    const cookie = await authenticatedCookie();
    database.close();
    const response = await app.inject({ method: "GET", url: "/projects", headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("database not open");
  });
});
