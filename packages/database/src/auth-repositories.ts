import { randomUUID } from "node:crypto";
import {
  projectSchema,
  projectMembershipSchema,
  principalSchema,
  sessionSchema,
  executionRunSchema,
} from "@agentos/core";
import type {
  AuthSession,
  Principal,
  ProjectMembership,
  ProjectRole,
  Project,
  ExecutionRun,
} from "@agentos/core";
import type { AgentOsDatabase } from "./database.js";
import type { AgentOsPostgresDatabase } from "./postgres-database.js";
import type {
  AuthenticationRepositoryContract,
  Page,
  ProjectFilter,
  RunFilter,
} from "@agentos/core";

type PrincipalRow = {
  id: string;
  name: string;
  auth_source: "local_password";
  created_at: string;
  disabled_at: string | null;
};
type SessionRow = {
  id: string;
  principal_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
type MembershipRow = {
  project_id: string;
  principal_id: string;
  role: ProjectRole;
  created_at: string;
};

function principal(row: PrincipalRow): Principal {
  return principalSchema.parse({
    id: row.id,
    authSource: row.auth_source,
    createdAt: normalizeTime(row.created_at),
    disabledAt: row.disabled_at ? normalizeTime(row.disabled_at) : null,
  });
}
function session(row: SessionRow): AuthSession {
  return sessionSchema.parse({
    id: row.id,
    principalId: row.principal_id,
    createdAt: normalizeTime(row.created_at),
    expiresAt: normalizeTime(row.expires_at),
    revokedAt: row.revoked_at ? normalizeTime(row.revoked_at) : null,
  });
}
function membership(row: MembershipRow): ProjectMembership {
  return projectMembershipSchema.parse({
    projectId: row.project_id,
    principalId: row.principal_id,
    role: row.role,
    createdAt: normalizeTime(row.created_at),
  });
}
function normalizeTime(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
function paging(filter: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50)));
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  return { limit, offset };
}
function page<T>(items: T[], total: number, filter: { limit?: number; offset?: number }): Page<T> {
  const { limit, offset } = paging(filter);
  return { items, total, limit, offset };
}
function camelRecord(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}
function mapProject(row: Record<string, unknown>): Project {
  const value = camelRecord(row);
  if (typeof value["settings"] === "string")
    value["settings"] = JSON.parse(value["settings"] as string);
  for (const key of ["createdAt", "updatedAt"])
    if (value[key] instanceof Date) value[key] = (value[key] as Date).toISOString();
  return projectSchema.parse(value);
}

export class SqliteAuthenticationRepository implements AuthenticationRepositoryContract {
  constructor(private readonly database: AgentOsDatabase) {}

  findAnyPrincipal(): Principal | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT id, name, auth_source, created_at, disabled_at FROM principals ORDER BY created_at, id LIMIT 1",
      )
      .get() as PrincipalRow | undefined;
    return row ? principal(row) : null;
  }
  getPrincipalByName(name: string): Principal | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT id, name, auth_source, created_at, disabled_at FROM principals WHERE name = ? AND disabled_at IS NULL",
      )
      .get(name) as PrincipalRow | undefined;
    return row ? principal(row) : null;
  }
  getPrincipal(id: string): Principal | null {
    const row = this.database.sqlite
      .prepare("SELECT id, name, auth_source, created_at, disabled_at FROM principals WHERE id = ?")
      .get(id) as PrincipalRow | undefined;
    return row ? principal(row) : null;
  }
  createPrincipal(input: { name: string; passwordHash: string }, id = randomUUID()): Principal {
    const now = this.database.now();
    const create = this.database.sqlite.transaction(() => {
      const exists = this.database.sqlite.prepare("SELECT 1 FROM principals LIMIT 1").get();
      if (exists) throw new Error("The initial local principal has already been created");
      this.database.sqlite
        .prepare(
          "INSERT INTO principals(id, name, auth_source, password_hash, created_at) VALUES (?, ?, 'local_password', ?, ?)",
        )
        .run(id, input.name, input.passwordHash, now);
      this.database.sqlite
        .prepare(
          "INSERT INTO project_memberships(project_id, principal_id, role, created_at) SELECT id, ?, 'owner', ? FROM projects",
        )
        .run(id, now);
      this.database.sqlite
        .prepare(
          "INSERT INTO run_owners(run_id, principal_id, created_at) SELECT id, ?, ? FROM execution_runs",
        )
        .run(id, now);
      const row = this.database.sqlite
        .prepare(
          "SELECT id, name, auth_source, created_at, disabled_at FROM principals WHERE id = ?",
        )
        .get(id) as PrincipalRow;
      return principal(row);
    });
    return create.immediate();
  }
  verifyPasswordHash(name: string): { principal: Principal; passwordHash: string } | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT id, name, auth_source, password_hash, created_at, disabled_at FROM principals WHERE name = ? AND disabled_at IS NULL",
      )
      .get(name) as (PrincipalRow & { password_hash: string }) | undefined;
    return row ? { principal: principal(row), passwordHash: row.password_hash } : null;
  }
  revokePrincipal(id: string, at: string): boolean {
    const disable = this.database.sqlite.transaction(() => {
      const result = this.database.sqlite
        .prepare("UPDATE principals SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL")
        .run(at, id);
      this.database.sqlite
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
        )
        .run(at, id);
      return result.changes === 1;
    });
    return disable.immediate();
  }
  createSession(
    input: { principalId: string; expiresAt: string; tokenHash: string },
    id = randomUUID(),
  ): AuthSession {
    const createdAt = this.database.now();
    this.database.sqlite
      .prepare(
        "INSERT INTO auth_sessions(id, principal_id, token_hash, created_at, expires_at) SELECT ?, id, ?, ?, ? FROM principals WHERE id = ? AND disabled_at IS NULL",
      )
      .run(id, input.tokenHash, createdAt, input.expiresAt, input.principalId);
    const row = this.database.sqlite
      .prepare(
        "SELECT id, principal_id, created_at, expires_at, revoked_at FROM auth_sessions WHERE id = ?",
      )
      .get(id) as SessionRow | undefined;
    if (!row) throw new Error("Cannot create a session for an unavailable principal");
    return session(row);
  }
  findSession(tokenHash: string): AuthSession | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT s.id, s.principal_id, s.created_at, s.expires_at, s.revoked_at FROM auth_sessions s JOIN principals p ON p.id = s.principal_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND p.disabled_at IS NULL",
      )
      .get(tokenHash, this.database.now()) as SessionRow | undefined;
    return row ? session(row) : null;
  }
  revokeSession(tokenHash: string, at: string): boolean {
    return (
      this.database.sqlite
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .run(at, tokenHash).changes === 1
    );
  }
  revokePrincipalSessions(principalId: string, at: string): number {
    return this.database.sqlite
      .prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
      )
      .run(at, principalId).changes;
  }
  addProjectMember(
    projectId: string,
    principalId: string,
    role: ProjectRole,
    at: string,
  ): ProjectMembership {
    this.database.sqlite
      .prepare(
        "INSERT INTO project_memberships(project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role",
      )
      .run(projectId, principalId, role, at);
    const row = this.database.sqlite
      .prepare(
        "SELECT project_id, principal_id, role, created_at FROM project_memberships WHERE project_id = ? AND principal_id = ?",
      )
      .get(projectId, principalId) as MembershipRow;
    return membership(row);
  }
  getProjectMembership(projectId: string, principalId: string): ProjectMembership | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT project_id, principal_id, role, created_at FROM project_memberships WHERE project_id = ? AND principal_id = ?",
      )
      .get(projectId, principalId) as MembershipRow | undefined;
    return row ? membership(row) : null;
  }
  listProjectMemberships(projectId: string): ProjectMembership[] {
    return (
      this.database.sqlite
        .prepare(
          "SELECT project_id, principal_id, role, created_at FROM project_memberships WHERE project_id = ? ORDER BY created_at, principal_id",
        )
        .all(projectId) as MembershipRow[]
    ).map(membership);
  }
  listOwnedProjects(principalId: string, filter: ProjectFilter = {}): Page<Project> {
    const { limit, offset } = paging(filter);
    const nameFilter = filter.nameContains
      ? `%${filter.nameContains.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      : null;
    const rows = this.database.sqlite
      .prepare(
        `SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id WHERE m.principal_id = ? AND (? IS NULL OR p.name LIKE ? ESCAPE '\\') ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`,
      )
      .all(
        ...(nameFilter
          ? [principalId, nameFilter, nameFilter, limit, offset]
          : [principalId, null, null, limit, offset]),
      ) as Record<string, unknown>[];
    const totalRow = this.database.sqlite
      .prepare(
        "SELECT count(*) AS count FROM projects p JOIN project_memberships m ON m.project_id = p.id WHERE m.principal_id = ? AND (? IS NULL OR p.name LIKE ? ESCAPE '\\')",
      )
      .get(...(nameFilter ? [principalId, nameFilter, nameFilter] : [principalId, null, null])) as {
      count: number;
    };
    return page(rows.map(mapProject), totalRow.count, filter);
  }
  listOwnedRuns(principalId: string, filter: RunFilter = {}): Page<ExecutionRun> {
    const { limit, offset } = paging(filter);
    const where = [
      "(ro.principal_id = ? OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = r.project_id AND pm.principal_id = ?))",
    ];
    const args: (string | number | null)[] = [principalId, principalId];
    if (filter.projectId) {
      where.push("r.project_id = ?");
      args.push(filter.projectId);
    }
    if (filter.taskId) {
      where.push("r.task_id = ?");
      args.push(filter.taskId);
    }
    if (filter.status) {
      where.push("r.status = ?");
      args.push(filter.status);
    }
    const condition = where.join(" AND ");
    const rows = this.database.sqlite
      .prepare(
        `SELECT r.* FROM execution_runs r LEFT JOIN run_owners ro ON ro.run_id = r.id WHERE ${condition} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Record<string, unknown>[];
    const totalRow = this.database.sqlite
      .prepare(
        `SELECT count(*) AS count FROM execution_runs r LEFT JOIN run_owners ro ON ro.run_id = r.id WHERE ${condition}`,
      )
      .get(...args) as { count: number };
    return page(
      rows.map((row) => mapRun(row)),
      totalRow.count,
      filter,
    );
  }
  setRunOwner(runId: string, principalId: string, at: string): void {
    this.database.sqlite
      .prepare(
        "INSERT INTO run_owners(run_id, principal_id, created_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING",
      )
      .run(runId, principalId, at);
  }
  canAccessRun(runId: string, principalId: string): boolean {
    return !!this.database.sqlite
      .prepare(
        "SELECT 1 FROM execution_runs r WHERE r.id = ? AND (EXISTS (SELECT 1 FROM run_owners ro WHERE ro.run_id = r.id AND ro.principal_id = ?) OR EXISTS (SELECT 1 FROM project_memberships m WHERE m.project_id = r.project_id AND m.principal_id = ?))",
      )
      .get(runId, principalId, principalId);
  }
}

export class PostgresAuthenticationRepository implements AuthenticationRepositoryContract {
  constructor(private readonly database: AgentOsPostgresDatabase) {}
  async findAnyPrincipal(): Promise<Principal | null> {
    const r = await this.database.pool.query<PrincipalRow>(
      "SELECT id, name, auth_source, created_at, disabled_at FROM principals ORDER BY created_at, id LIMIT 1",
    );
    return r.rows[0] ? principal(r.rows[0]) : null;
  }
  async getPrincipalByName(name: string): Promise<Principal | null> {
    const r = await this.database.pool.query<PrincipalRow>(
      "SELECT id, name, auth_source, created_at, disabled_at FROM principals WHERE name = $1 AND disabled_at IS NULL",
      [name],
    );
    return r.rows[0] ? principal(r.rows[0]) : null;
  }
  async getPrincipal(id: string): Promise<Principal | null> {
    const r = await this.database.pool.query<PrincipalRow>(
      "SELECT id, name, auth_source, created_at, disabled_at FROM principals WHERE id = $1",
      [id],
    );
    return r.rows[0] ? principal(r.rows[0]) : null;
  }
  async verifyPasswordHash(
    name: string,
  ): Promise<{ principal: Principal; passwordHash: string } | null> {
    const r = await this.database.pool.query<PrincipalRow & { password_hash: string }>(
      "SELECT id, name, auth_source, password_hash, created_at, disabled_at FROM principals WHERE name = $1 AND disabled_at IS NULL",
      [name],
    );
    return r.rows[0]
      ? { principal: principal(r.rows[0]), passwordHash: r.rows[0].password_hash }
      : null;
  }
  async createPrincipal(
    input: { name: string; passwordHash: string },
    id = randomUUID(),
  ): Promise<Principal> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agentos.initial_principal'))");
      const count = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM principals",
      );
      if (Number(count.rows[0]?.count) !== 0)
        throw new Error("The initial local principal has already been created");
      const now = this.database.now();
      const result = await client.query<PrincipalRow>(
        "INSERT INTO principals(id, name, auth_source, password_hash, created_at) VALUES ($1, $2, 'local_password', $3, $4) RETURNING id, name, auth_source, created_at, disabled_at",
        [id, input.name, input.passwordHash, now],
      );
      await client.query(
        "INSERT INTO project_memberships(project_id, principal_id, role, created_at) SELECT id, $1, 'owner', $2 FROM projects",
        [id, now],
      );
      await client.query(
        "INSERT INTO run_owners(run_id, principal_id, created_at) SELECT id, $1, $2 FROM execution_runs",
        [id, now],
      );
      return principal(result.rows[0]!);
    });
  }
  async revokePrincipal(id: string, at: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        "UPDATE principals SET disabled_at = $1 WHERE id = $2 AND disabled_at IS NULL",
        [at, id],
      );
      await client.query(
        "UPDATE auth_sessions SET revoked_at = $1 WHERE principal_id = $2 AND revoked_at IS NULL",
        [at, id],
      );
      return result.rowCount === 1;
    });
  }
  async createSession(
    input: { principalId: string; expiresAt: string; tokenHash: string },
    id = randomUUID(),
  ): Promise<AuthSession> {
    const r = await this.database.pool.query<SessionRow>(
      "INSERT INTO auth_sessions(id, principal_id, token_hash, created_at, expires_at) SELECT $1, id, $2, $3, $4 FROM principals WHERE id = $5 AND disabled_at IS NULL RETURNING id, principal_id, created_at, expires_at, revoked_at",
      [id, input.tokenHash, this.database.now(), input.expiresAt, input.principalId],
    );
    if (!r.rows[0]) throw new Error("Cannot create a session for an unavailable principal");
    return session(r.rows[0]);
  }
  async findSession(tokenHash: string): Promise<AuthSession | null> {
    const r = await this.database.pool.query<SessionRow>(
      "SELECT s.id, s.principal_id, s.created_at, s.expires_at, s.revoked_at FROM auth_sessions s JOIN principals p ON p.id = s.principal_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND p.disabled_at IS NULL",
      [tokenHash, this.database.now()],
    );
    return r.rows[0] ? session(r.rows[0]) : null;
  }
  async revokeSession(tokenHash: string, at: string): Promise<boolean> {
    const r = await this.database.pool.query(
      "UPDATE auth_sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL",
      [at, tokenHash],
    );
    return r.rowCount === 1;
  }
  async revokePrincipalSessions(principalId: string, at: string): Promise<number> {
    const r = await this.database.pool.query(
      "UPDATE auth_sessions SET revoked_at = $1 WHERE principal_id = $2 AND revoked_at IS NULL",
      [at, principalId],
    );
    return r.rowCount ?? 0;
  }
  async addProjectMember(
    projectId: string,
    principalId: string,
    role: ProjectRole,
    at: string,
  ): Promise<ProjectMembership> {
    const r = await this.database.pool.query<MembershipRow>(
      "INSERT INTO project_memberships(project_id, principal_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(project_id, principal_id) DO UPDATE SET role = EXCLUDED.role RETURNING project_id, principal_id, role, created_at",
      [projectId, principalId, role, at],
    );
    return membership(r.rows[0]!);
  }
  async getProjectMembership(
    projectId: string,
    principalId: string,
  ): Promise<ProjectMembership | null> {
    const r = await this.database.pool.query<MembershipRow>(
      "SELECT project_id, principal_id, role, created_at FROM project_memberships WHERE project_id = $1 AND principal_id = $2",
      [projectId, principalId],
    );
    return r.rows[0] ? membership(r.rows[0]) : null;
  }
  async listProjectMemberships(projectId: string): Promise<ProjectMembership[]> {
    const r = await this.database.pool.query<MembershipRow>(
      "SELECT project_id, principal_id, role, created_at FROM project_memberships WHERE project_id = $1 ORDER BY created_at, principal_id",
      [projectId],
    );
    return r.rows.map(membership);
  }
  async listOwnedProjects(principalId: string, filter: ProjectFilter = {}): Promise<Page<Project>> {
    const { limit, offset } = paging(filter);
    const q = filter.nameContains ? `%${filter.nameContains}%` : null;
    const args = [principalId, q];
    const [rows, total] = await Promise.all([
      this.database.pool.query(
        "SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id WHERE m.principal_id = $1 AND ($2::text IS NULL OR p.name ILIKE $2) ORDER BY p.created_at DESC, p.id LIMIT $3 OFFSET $4",
        [...args, limit, offset],
      ),
      this.database.pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM projects p JOIN project_memberships m ON m.project_id = p.id WHERE m.principal_id = $1 AND ($2::text IS NULL OR p.name ILIKE $2)",
        args,
      ),
    ]);
    return page(
      rows.rows.map((row) => mapProject(row as Record<string, unknown>)),
      Number(total.rows[0]?.count ?? 0),
      filter,
    );
  }
  async listOwnedRuns(principalId: string, filter: RunFilter = {}): Promise<Page<ExecutionRun>> {
    const { limit, offset } = paging(filter);
    const conditions = [
      "(ro.principal_id = $1 OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = r.project_id AND pm.principal_id = $1))",
    ];
    const args: unknown[] = [principalId];
    if (filter.projectId) {
      args.push(filter.projectId);
      conditions.push(`r.project_id = $${args.length}`);
    }
    if (filter.taskId) {
      args.push(filter.taskId);
      conditions.push(`r.task_id = $${args.length}`);
    }
    if (filter.status) {
      args.push(filter.status);
      conditions.push(`r.status = $${args.length}`);
    }
    const where = conditions.join(" AND ");
    const [rows, total] = await Promise.all([
      this.database.pool.query(
        `SELECT r.* FROM execution_runs r LEFT JOIN run_owners ro ON ro.run_id = r.id WHERE ${where} ORDER BY r.created_at DESC, r.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, limit, offset],
      ),
      this.database.pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM execution_runs r LEFT JOIN run_owners ro ON ro.run_id = r.id WHERE ${where}`,
        args,
      ),
    ]);
    return page(
      rows.rows.map((row) => mapRun(row as Record<string, unknown>)),
      Number(total.rows[0]?.count ?? 0),
      filter,
    );
  }
  async setRunOwner(runId: string, principalId: string, at: string): Promise<void> {
    await this.database.pool.query(
      "INSERT INTO run_owners(run_id, principal_id, created_at) VALUES ($1, $2, $3) ON CONFLICT(run_id) DO NOTHING",
      [runId, principalId, at],
    );
  }
  async canAccessRun(runId: string, principalId: string): Promise<boolean> {
    const r = await this.database.pool.query(
      "SELECT 1 FROM execution_runs r WHERE r.id = $1 AND (EXISTS (SELECT 1 FROM run_owners ro WHERE ro.run_id = r.id AND ro.principal_id = $2) OR EXISTS (SELECT 1 FROM project_memberships m WHERE m.project_id = r.project_id AND m.principal_id = $2))",
      [runId, principalId],
    );
    return r.rowCount === 1;
  }
}

function mapRun(row: Record<string, unknown>): ExecutionRun {
  const value = { ...row };
  for (const [key, item] of Object.entries(value))
    if (item instanceof Date) value[key] = item.toISOString();
  for (const key of ["usage_metrics"])
    if (typeof value[key] === "string") value[key] = JSON.parse(value[key] as string);
  const mapped = camelRecord(value);
  return executionRunSchema.parse(mapped);
}
