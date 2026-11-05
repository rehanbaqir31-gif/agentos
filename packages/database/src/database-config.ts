import { join } from "node:path";
import { homedir } from "node:os";
import type { PoolConfig } from "pg";
import type { RepositorySet } from "@agentos/core";
import { openDatabase, type AgentOsDatabase } from "./database.js";
import { PostgresRepositories } from "./postgres-repositories.js";
import { openPostgresDatabase, type AgentOsPostgresDatabase } from "./postgres-database.js";
import { Repositories } from "./repositories.js";

export type AgentOsDatabaseConfig =
  | { driver: "sqlite"; filename?: string; dataDirectory?: string }
  | {
      driver: "postgresql";
      connectionString: string;
      maxPoolSize: number;
      ssl: PoolConfig["ssl"];
    };

export interface DatabaseEnvironment {
  AGENTOS_DATABASE_DRIVER?: string;
  AGENTOS_DATABASE_URL?: string;
  AGENTOS_SQLITE_PATH?: string;
  AGENTOS_SQLITE_DATA_DIR?: string;
  AGENTOS_DATABASE_POOL_MAX?: string;
  AGENTOS_DATABASE_SSL?: string;
}

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export function loadDatabaseConfig(
  environment: DatabaseEnvironment = process.env,
): AgentOsDatabaseConfig {
  const driver = (environment.AGENTOS_DATABASE_DRIVER ?? "sqlite").toLowerCase();
  if (driver === "sqlite") {
    if (environment.AGENTOS_SQLITE_PATH && environment.AGENTOS_SQLITE_DATA_DIR) {
      throw new DatabaseConfigurationError(
        "Set AGENTOS_SQLITE_PATH or AGENTOS_SQLITE_DATA_DIR, not both",
      );
    }
    return {
      driver: "sqlite",
      ...(environment.AGENTOS_SQLITE_PATH ? { filename: environment.AGENTOS_SQLITE_PATH } : {}),
      ...(environment.AGENTOS_SQLITE_DATA_DIR
        ? { dataDirectory: environment.AGENTOS_SQLITE_DATA_DIR }
        : {}),
    };
  }

  if (driver === "postgres" || driver === "postgresql") {
    const connectionString = environment.AGENTOS_DATABASE_URL;
    if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new DatabaseConfigurationError(
        "PostgreSQL requires AGENTOS_DATABASE_URL with a postgres:// or postgresql:// URL",
      );
    }
    const maxPoolSize = Number(environment.AGENTOS_DATABASE_POOL_MAX ?? 10);
    if (!Number.isSafeInteger(maxPoolSize) || maxPoolSize < 1 || maxPoolSize > 100) {
      throw new DatabaseConfigurationError(
        "AGENTOS_DATABASE_POOL_MAX must be an integer from 1 to 100",
      );
    }
    const sslMode = (environment.AGENTOS_DATABASE_SSL ?? "disable").toLowerCase();
    let ssl: PoolConfig["ssl"];
    if (sslMode === "disable") ssl = false;
    else if (sslMode === "require") ssl = { rejectUnauthorized: true };
    else throw new DatabaseConfigurationError("AGENTOS_DATABASE_SSL must be disable or require");
    return { driver: "postgresql", connectionString, maxPoolSize, ssl };
  }

  throw new DatabaseConfigurationError("AGENTOS_DATABASE_DRIVER must be sqlite or postgresql");
}

export type ConfiguredAgentOsDatabase =
  | {
      dialect: "sqlite";
      database: AgentOsDatabase;
      repositories: RepositorySet;
      close(): Promise<void>;
    }
  | {
      dialect: "postgresql";
      database: AgentOsPostgresDatabase;
      repositories: RepositorySet;
      close(): Promise<void>;
    };

export async function openConfiguredDatabase(
  environment: DatabaseEnvironment = process.env,
): Promise<ConfiguredAgentOsDatabase> {
  const config = loadDatabaseConfig(environment);
  if (config.driver === "sqlite") {
    const dataDirectory = config.dataDirectory ?? join(homedir(), ".agentos");
    const database = await openDatabase(
      config.filename ? { filename: config.filename } : { dataDirectory },
    );
    return {
      dialect: "sqlite",
      database,
      repositories: new Repositories(database),
      async close() {
        database.close();
      },
    };
  }

  const database = await openPostgresDatabase(config);
  return {
    dialect: "postgresql",
    database,
    repositories: new PostgresRepositories(database),
    close: () => database.close(),
  };
}
