import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Migration } from "./migrations.js";
import { migrations } from "./migrations.js";
import * as schema from "./schema.js";

export type AgentOsDrizzle = BetterSQLite3Database<typeof schema>;

export interface DatabaseOptions {
  filename?: string;
  dataDirectory?: string;
  migrations?: readonly Migration[];
  now?: () => string;
}

export class DatabaseInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseInitializationError";
  }
}

export interface AgentOsDatabase {
  readonly filename: string;
  readonly orm: AgentOsDrizzle;
  readonly sqlite: BetterSqlite3.Database;
  readonly now: () => string;
  close(): void;
}

export function applyMigrations(
  sqlite: BetterSqlite3.Database,
  migrationList: readonly Migration[],
): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = sqlite
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as {
    version: number;
    name: string;
    checksum: string;
  }[];
  const checksum = (migration: Migration) =>
    createHash("sha256").update(migration.sql).digest("hex");
  const known = new Map(migrationList.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration || migration.name !== row.name || checksum(migration) !== row.checksum) {
      throw new DatabaseInitializationError(
        `Database migration ${row.version}:${row.name} is missing or has changed`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const ordered = [...migrationList].sort((left, right) => left.version - right.version);
  for (let index = 0; index < ordered.length; index += 1) {
    const migration = ordered[index];
    if (!migration) continue;
    if (index > 0 && migration.version <= (ordered[index - 1]?.version ?? 0)) {
      throw new DatabaseInitializationError("Migration versions must be unique and increasing");
    }
    if (appliedVersions.has(migration.version)) continue;

    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(migration.sql);
      sqlite
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum(migration), new Date().toISOString());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw new DatabaseInitializationError(
        `Failed to apply migration ${migration.version}:${migration.name}`,
        {
          cause: error,
        },
      );
    }
  }
}

export async function openDatabase(options: DatabaseOptions): Promise<AgentOsDatabase> {
  if (options.filename && options.dataDirectory) {
    throw new DatabaseInitializationError("Set either filename or dataDirectory, not both");
  }
  const suppliedFilename =
    options.filename ??
    join(options.dataDirectory ?? join(homedir(), ".agentos"), "agentos.sqlite");
  const filename = suppliedFilename === ":memory:" ? suppliedFilename : resolve(suppliedFilename);
  if (filename !== ":memory:") await mkdir(dirname(filename), { recursive: true });

  let sqlite: BetterSqlite3.Database | undefined;
  try {
    sqlite = new BetterSqlite3(filename);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") sqlite.pragma("journal_mode = WAL");
    applyMigrations(sqlite, options.migrations ?? migrations);
    const orm = drizzle(sqlite, { schema });
    let closed = false;
    return {
      filename,
      orm,
      sqlite,
      now: options.now ?? (() => new Date().toISOString()),
      close() {
        if (!closed) {
          sqlite?.close();
          closed = true;
        }
      },
    };
  } catch (error) {
    if (sqlite?.open) sqlite.close();
    if (error instanceof DatabaseInitializationError) throw error;
    throw new DatabaseInitializationError(`Could not initialize database at ${filename}`, {
      cause: error,
    });
  }
}
