import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import {
  createProjectSchema,
  createTaskSchema,
  runIdSchema,
  projectIdSchema,
  taskIdSchema,
  type Principal,
  type RepositorySet,
} from "@agentos/core";
import type {
  ArtifactService,
  ExecutionCoordinator,
  ApprovalAuthorizationService,
} from "@agentos/agents";
import { ApprovalAuthorizationError } from "@agentos/agents";
import { AuthenticationError, LocalAuthenticationService, validatePassword } from "./auth.js";
import { withAuthenticatedPrincipal } from "./principal-context.js";
import { z } from "zod";

const sessionCookie = "agentos_session";
const maxBodyBytes = 64 * 1024;

declare module "fastify" {
  interface FastifyRequest {
    agentosPrincipal: Principal | null;
    agentosTokenHash: string | null;
  }
}

export interface AgentOsServerOptions {
  repositories: RepositorySet;
  bootstrap?: { username: string; password: string };
  coordinator?: ExecutionCoordinator;
  artifacts?: ArtifactService;
  approvals?: ApprovalAuthorizationService;
  now?: () => string;
  logger?: boolean;
}

export async function createAgentOsServer(options: AgentOsServerOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date().toISOString());
  const auth = new LocalAuthenticationService(options.repositories, now);
  if (options.bootstrap) {
    validatePassword(options.bootstrap.password);
    await auth.provisionInitialPrincipal(options.bootstrap.username, options.bootstrap.password);
  }

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: maxBodyBytes,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 10, timeWindow: 15 * 60 * 1000 });
  app.decorateRequest("agentosPrincipal", null);
  app.decorateRequest("agentosTokenHash", null);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    const host = request.headers.host ?? "";
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host))
      return reply.code(403).send({ error: "LOCAL_ORIGIN_REQUIRED" });
    const origin = request.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        return reply.code(403).send({ error: "LOCAL_ORIGIN_REQUIRED" });
      }
      if (originHost.toLowerCase() !== host.toLowerCase())
        return reply.code(403).send({ error: "LOCAL_ORIGIN_REQUIRED" });
    }
    const token = request.cookies[sessionCookie];
    const verified = await auth.authenticate(token);
    if (verified) {
      request.agentosPrincipal = verified.principal;
      request.agentosTokenHash = verified.tokenHash;
    }
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (error.statusCode === 400) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (error.statusCode === 413) return reply.code(413).send({ error: "REQUEST_TOO_LARGE" });
    if (error.statusCode === 429) return reply.code(429).send({ error: "TOO_MANY_REQUESTS" });
    if (error.name === "ZodError") return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (error instanceof ApprovalAuthorizationError)
      return reply.code(403).send({ error: "AUTHORIZATION_DENIED" });
    requestLogSafe(app, error);
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: { username: string; password: string } }>(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } } },
    async (request, reply) => {
      if (request.agentosPrincipal) return reply.code(409).send({ error: "ALREADY_AUTHENTICATED" });
      const body = loginBody(request.body);
      try {
        const login = await auth.login(body.username, body.password);
        reply.setCookie(sessionCookie, login.token, {
          httpOnly: true,
          sameSite: "strict",
          secure: false,
          path: "/",
          maxAge: 8 * 60 * 60,
        });
        return { principal: publicPrincipal(login.principal), expiresAt: login.session.expiresAt };
      } catch (error) {
        if (error instanceof AuthenticationError)
          return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
        throw error;
      }
    },
  );

  app.post("/auth/logout", { preHandler: requireAuthentication }, async (request, reply) => {
    if (request.agentosTokenHash) await auth.logout(request.agentosTokenHash);
    reply.clearCookie(sessionCookie, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    return reply.code(204).send();
  });

  app.get("/auth/session", { preHandler: requireAuthentication }, async (request) => ({
    principal: publicPrincipal(request.agentosPrincipal!),
  }));

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/projects",
    { preHandler: requireAuthentication },
    async (request) => {
      return options.repositories.auth.listOwnedProjects(
        request.agentosPrincipal!.id,
        parsePage(request.query),
      );
    },
  );

  app.post<{ Body: unknown }>(
    "/projects",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const input = createProjectSchema.parse(request.body);
      const project = await options.repositories.projects.create({
        ...input,
        settings: { permissionMode: "read_only", networkAccess: "disabled" },
      });
      try {
        await options.repositories.auth.addProjectMember(
          project.id,
          request.agentosPrincipal!.id,
          "owner",
          now(),
        );
      } catch (error) {
        await Promise.resolve(options.repositories.projects.delete(project.id)).catch(() => false);
        throw error;
      }
      return reply.code(201).send(project);
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const id = projectIdSchema.parse(request.params.projectId);
      if (!(await hasProjectAccess(options.repositories, request.agentosPrincipal!, id)))
        return notFound(reply);
      return options.repositories.projects.getById(id);
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/tasks",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const id = projectIdSchema.parse(request.params.projectId);
      if (!(await hasProjectAccess(options.repositories, request.agentosPrincipal!, id)))
        return notFound(reply);
      return options.repositories.tasks.list({
        ...parsePage(request.query as Record<string, unknown>),
        projectId: id,
      });
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/projects/:projectId/tasks",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const projectId = projectIdSchema.parse(request.params.projectId);
      const membership = await options.repositories.auth.getProjectMembership(
        projectId,
        request.agentosPrincipal!.id,
      );
      if (!membership || membership.role === "viewer") return notFound(reply);
      const input = createTaskSchema.parse({ ...(request.body as object), projectId });
      return reply.code(201).send(await options.repositories.tasks.create(input));
    },
  );

  app.get<{ Querystring: { limit?: string; offset?: string; projectId?: string } }>(
    "/runs",
    { preHandler: requireAuthentication },
    async (request) => {
      const filter = parsePage(request.query);
      return options.repositories.auth.listOwnedRuns(request.agentosPrincipal!.id, {
        ...filter,
        ...(request.query.projectId
          ? { projectId: projectIdSchema.parse(request.query.projectId) }
          : {}),
      });
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/runs/:runId",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const id = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(id, request.agentosPrincipal!.id)))
        return notFound(reply);
      return options.repositories.runs.getById(id);
    },
  );

  app.get<{ Params: { runId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/runs/:runId/events",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const id = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(id, request.agentosPrincipal!.id)))
        return notFound(reply);
      return options.repositories.events.list({ runId: id, ...parsePage(request.query) });
    },
  );

  app.get<{ Params: { runId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/runs/:runId/approvals",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const id = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(id, request.agentosPrincipal!.id)))
        return notFound(reply);
      return options.repositories.approvals.list(id, parsePage(request.query));
    },
  );

  app.post<{ Params: { taskId: string }; Body: unknown }>(
    "/tasks/:taskId/runs",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      if (!options.coordinator) return reply.code(503).send({ error: "EXECUTION_UNAVAILABLE" });
      const taskId = taskIdSchema.parse(request.params.taskId);
      const task = await options.repositories.tasks.getById(taskId);
      const membership = await options.repositories.auth.getProjectMembership(
        task.projectId,
        request.agentosPrincipal!.id,
      );
      if (!membership || membership.role === "viewer") return notFound(reply);
      const body = startRunBody(request.body);
      const tokenHash = request.agentosTokenHash!;
      const outcome = await withAuthenticatedPrincipal(
        { id: request.agentosPrincipal!.id },
        () => options.coordinator!.startTask({ ...body, taskId }),
        async () => (await auth.authenticateHash(tokenHash)) !== null,
      );
      await options.repositories.auth.setRunOwner(
        outcome.run.id,
        request.agentosPrincipal!.id,
        now(),
      );
      return reply
        .code(202)
        .send({ run: outcome.run, result: outcome.result, error: outcome.error });
    },
  );

  app.get<{ Params: { runId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/runs/:runId/artifacts",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const id = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(id, request.agentosPrincipal!.id)))
        return notFound(reply);
      const run = await options.repositories.runs.getById(id);
      return options.repositories.artifacts.listForProject(
        id,
        run.projectId,
        parsePage(request.query),
      );
    },
  );

  app.get<{ Params: { runId: string; artifactId: string } }>(
    "/runs/:runId/artifacts/:artifactId",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const runId = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(runId, request.agentosPrincipal!.id)))
        return notFound(reply);
      if (!options.artifacts)
        return reply.code(503).send({ error: "ARTIFACT_STORAGE_UNAVAILABLE" });
      const run = await options.repositories.runs.getById(runId);
      const content = await options.artifacts.readForProject(
        runId,
        run.projectId,
        request.params.artifactId,
      );
      reply.type("application/octet-stream").header("cache-control", "no-store");
      return reply.send(content);
    },
  );

  app.post<{ Params: { runId: string }; Body: unknown }>(
    "/runs/:runId/permission-grants",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const runId = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(runId, request.agentosPrincipal!.id)))
        return notFound(reply);
      if (!options.approvals) return reply.code(503).send({ error: "APPROVAL_POLICY_UNAVAILABLE" });
      const body = grantBody(request.body);
      const tokenHash = request.agentosTokenHash!;
      const grant = await withAuthenticatedPrincipal(
        { id: request.agentosPrincipal!.id },
        () => options.approvals!.grantPermission({ ...body, runId }),
        async () => (await auth.authenticateHash(tokenHash)) !== null,
      );
      return reply.code(201).send(grant);
    },
  );

  app.post<{ Params: { runId: string; approvalId: string } }>(
    "/runs/:runId/permission-grants/:approvalId/revoke",
    { preHandler: requireAuthentication },
    async (request, reply) => {
      const runId = runIdSchema.parse(request.params.runId);
      if (!(await options.repositories.auth.canAccessRun(runId, request.agentosPrincipal!.id)))
        return notFound(reply);
      if (!options.approvals) return reply.code(503).send({ error: "APPROVAL_POLICY_UNAVAILABLE" });
      const current = await options.repositories.approvals.getById(request.params.approvalId);
      if (current.runId !== runId) return notFound(reply);
      const tokenHash = request.agentosTokenHash!;
      return withAuthenticatedPrincipal(
        { id: request.agentosPrincipal!.id },
        () => options.approvals!.revoke(current.id),
        async () => (await auth.authenticateHash(tokenHash)) !== null,
      );
    },
  );

  return app;
}

export function bindLoopback(app: FastifyInstance, port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new RangeError("Invalid API port");
  return app.listen({ host: "127.0.0.1", port });
}

async function requireAuthentication(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.agentosPrincipal) reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
}

function loginBody(value: unknown): { username: string; password: string } {
  return z
    .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) })
    .strict()
    .parse(value);
}

function startRunBody(value: unknown): {
  agentId: string;
  providerId?: string | null;
  modelId?: string | null;
} {
  const body = z
    .object({
      agentId: z.string().uuid(),
      providerId: z.string().uuid().nullable().optional(),
      modelId: z.string().min(1).nullable().optional(),
    })
    .strict()
    .parse(value);
  return {
    agentId: body.agentId,
    ...(typeof body.providerId === "string" || body.providerId === null
      ? { providerId: body.providerId }
      : {}),
    ...(typeof body.modelId === "string" || body.modelId === null ? { modelId: body.modelId } : {}),
  };
}

function grantBody(value: unknown): {
  actionType: string;
  actionDescription: string;
  requestedPermissions: string[];
  expiresInSeconds: number;
} {
  return z
    .object({
      actionType: z.string().min(1).max(128),
      actionDescription: z.string().max(20_000),
      requestedPermissions: z.array(z.string().max(256)).max(256),
      expiresInSeconds: z.number().int().min(1).max(86_400),
    })
    .strict()
    .parse(value);
}

async function hasProjectAccess(
  repositories: RepositorySet,
  principal: Principal,
  projectId: string,
): Promise<boolean> {
  return !!(await repositories.auth.getProjectMembership(projectId, principal.id));
}

function parsePage(query: Record<string, unknown>): { limit: number; offset: number } {
  return z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(query);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "NOT_FOUND" });
}

function publicPrincipal(principal: Principal) {
  return { id: principal.id, authSource: principal.authSource, createdAt: principal.createdAt };
}

function requestLogSafe(app: FastifyInstance, error: Error) {
  app.log.error({ errorName: error.name }, "request failed");
}
