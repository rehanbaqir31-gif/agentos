import { createHash } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresMigration } from "./postgres-migrations.js";
import { postgresMigrations } from "./postgres-migrations.js";
import * as schema from "./postgres-schema.js";

export type AgentOsPostgresDrizzle = NodePgDatabase<typeof schema>;

export interface PostgresDatabaseOptions {
  connectionString: string;
  maxPoolSize?: number;
  ssl?: PoolConfig["ssl"];
  schema?: string;
  migrations?: readonly PostgresMigration[];
  now?: () => string;
  onIdleClientError?: (error: Error) => void;
}

export class PostgresInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresInitializationError";
  }
}

export interface AgentOsPostgresDatabase {
  readonly dialect: "postgresql";
  readonly orm: AgentOsPostgresDrizzle;
  readonly pool: Pool;
  readonly now: () => string;
  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function migrationChecksum(migration: PostgresMigration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

async function withPgTransaction<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the operation error. The client is released and the pool will retire it if needed.
    }
    throw error;
  }
}

export async function applyPostgresMigrations(
  pool: Pool,
  migrations: readonly PostgresMigration[] = postgresMigrations,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["agentos.schema_migrations"]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const row of rows) {
      const migration = byVersion.get(row.version);
      if (
        !migration ||
        migration.name !== row.name ||
        migrationChecksum(migration) !== row.checksum
      ) {
        throw new PostgresInitializationError(
          `PostgreSQL migration ${row.version}:${row.name} is missing or has changed`,
        );
      }
    }

    const ordered = [...migrations].sort((left, right) => left.version - right.version);
    for (let index = 0; index < ordered.length; index += 1) {
      const migration = ordered[index];
      if (!migration) continue;
      if (index > 0 && migration.version <= (ordered[index - 1]?.version ?? 0)) {
        throw new PostgresInitializationError(
          "PostgreSQL migration versions must be unique and increasing",
        );
      }
      if (rows.some((row) => row.version === migration.version)) continue;

      await withPgTransaction(client, async () => {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations(version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migrationChecksum(migration)],
        );
      });
    }
  } catch (error) {
    if (error instanceof PostgresInitializationError) throw error;
    throw new PostgresInitializationError("Could not apply PostgreSQL migrations", {
      cause: error,
    });
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["agentos.schema_migrations"]);
    } catch {
      // Releasing a broken connection is sufficient; preserve any migration failure.
    }
    client.release();
  }
}

export async function rollbackLastPostgresMigration(
  pool: Pool,
  migrations: readonly PostgresMigration[] = postgresMigrations,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["agentos.schema_migrations"]);
    const latestResult = await client.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    const latest = latestResult.rows[0];
    if (!latest) return null;
    const migration = migrations.find((item) => item.version === latest.version);
    if (!migration || migration.name !== latest.name || !migration.downSql)
      throw new PostgresInitializationError(
        `PostgreSQL migration ${latest.version}:${latest.name} cannot be rolled back`,
      );
    if (migration.rollbackCheckSql) {
      const check = await client.query<{ count: string }>(migration.rollbackCheckSql);
      if (Number(check.rows[0]?.count ?? 0) > 0)
        throw new PostgresInitializationError(
          "Migration rollback would discard approval audit state",
        );
    }
    await withPgTransaction(client, async () => {
      await client.query(migration.downSql!);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [latest.version]);
    });
    return latest.version;
  } catch (error) {
    if (error instanceof PostgresInitializationError) throw error;
    throw new PostgresInitializationError("Could not roll back PostgreSQL migration", {
      cause: error,
    });
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["agentos.schema_migrations"]);
    } catch {
      // The client is released below; a broken connection will be retired by pg.
    }
    client.release();
  }
}

export async function openPostgresDatabase(
  options: PostgresDatabaseOptions,
): Promise<AgentOsPostgresDatabase> {
  const max = options.maxPoolSize ?? 10;
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) {
    throw new PostgresInitializationError("maxPoolSize must be an integer between 1 and 100");
  }
  if (options.schema && !/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) {
    throw new PostgresInitializationError("schema must be a lowercase PostgreSQL identifier");
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: options.ssl,
    application_name: "agentos",
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  if (options.onIdleClientError) pool.on("error", options.onIdleClientError);
  else pool.on("error", () => undefined);
  try {
    await pool.query("SELECT 1");
    await applyPostgresMigrations(pool, options.migrations ?? postgresMigrations);
    const orm = drizzle({ client: pool, schema });
    let closed = false;
    return {
      dialect: "postgresql",
      orm,
      pool,
      now: options.now ?? (() => new Date().toISOString()),
      async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
        const client = await pool.connect();
        try {
          return await withPgTransaction(client, () => operation(client));
        } finally {
          client.release();
        }
      },
      async close() {
        if (!closed) {
          closed = true;
          await pool.end();
        }
      },
    };
  } catch (error) {
    await pool.end();
    if (error instanceof PostgresInitializationError) throw error;
    throw new PostgresInitializationError("Could not initialize PostgreSQL database", {
      cause: error,
    });
  }
}
