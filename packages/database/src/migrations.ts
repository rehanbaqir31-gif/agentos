export interface Migration {
  version: number;
  name: string;
  sql: string;
  downSql?: string;
  rollbackCheckSql?: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_core_schema",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  repository_path TEXT NOT NULL UNIQUE,
  repository_url TEXT,
  default_branch TEXT,
  current_commit TEXT,
  settings TEXT NOT NULL CHECK (json_valid(settings)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_created_at_idx ON projects(created_at);

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  health_status TEXT NOT NULL CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agents_adapter_id_idx ON agents(adapter_id);

CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ollama', 'openai', 'anthropic', 'google', 'openai_compatible')),
  base_url TEXT,
  credential_ref TEXT,
  available_models TEXT NOT NULL CHECK (json_valid(available_models)),
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX providers_type_idx ON providers(provider_type);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  configuration TEXT NOT NULL CHECK (json_valid(configuration)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_project_created_idx ON tasks(project_id, created_at);

CREATE TABLE execution_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  adapter_version TEXT NOT NULL,
  provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
  model_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'validating', 'preparing_workspace', 'queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled')),
  manifest_id TEXT,
  workspace_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  usage_metrics TEXT NOT NULL CHECK (json_valid(usage_metrics)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (completed_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX execution_runs_project_created_idx ON execution_runs(project_id, created_at);
CREATE INDEX execution_runs_task_idx ON execution_runs(task_id);

CREATE TABLE run_manifests (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  run_id TEXT NOT NULL UNIQUE REFERENCES execution_runs(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  provider_id TEXT REFERENCES providers(id) ON DELETE RESTRICT,
  model_id TEXT,
  prompt_configuration_hash TEXT NOT NULL CHECK (length(prompt_configuration_hash) = 64),
  repository_commit_sha TEXT,
  tool_versions TEXT NOT NULL CHECK (json_valid(tool_versions)),
  skill_versions TEXT NOT NULL CHECK (json_valid(skill_versions)),
  runtime_configuration TEXT NOT NULL CHECK (json_valid(runtime_configuration)),
  permission_configuration TEXT NOT NULL CHECK (json_valid(permission_configuration)),
  environment_variable_names TEXT NOT NULL CHECK (json_valid(environment_variable_names)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER execution_run_manifest_insert
BEFORE INSERT ON execution_runs WHEN NEW.manifest_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'run manifest must exist') WHERE NOT EXISTS (SELECT 1 FROM run_manifests WHERE id = NEW.manifest_id AND run_id = NEW.id); END;
CREATE TRIGGER execution_run_manifest_update
BEFORE UPDATE OF manifest_id ON execution_runs WHEN NEW.manifest_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'run manifest must exist') WHERE NOT EXISTS (SELECT 1 FROM run_manifests WHERE id = NEW.manifest_id AND run_id = NEW.id); END;

CREATE TABLE agent_events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  UNIQUE (run_id, sequence)
);
CREATE INDEX agent_events_run_time_idx ON agent_events(run_id, occurred_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL,
  action_description TEXT NOT NULL,
  requested_permissions TEXT NOT NULL CHECK (json_valid(requested_permissions)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  CHECK ((status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) OR (status <> 'pending' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX approvals_run_status_idx ON approvals(run_id, status);

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  evaluator_version TEXT NOT NULL,
  criteria TEXT NOT NULL CHECK (json_valid(criteria)),
  scores TEXT NOT NULL CHECK (json_valid(scores)),
  test_results TEXT NOT NULL CHECK (json_valid(test_results)),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX evaluations_run_created_idx ON evaluations(run_id, created_at);
`,
  },
  {
    version: 2,
    name: "approval_identity_and_consumption",
    sql: `
ALTER TABLE approvals ADD COLUMN principal_id TEXT;
ALTER TABLE approvals ADD COLUMN policy_version TEXT;
ALTER TABLE approvals ADD COLUMN expires_at TEXT;
ALTER TABLE approvals ADD COLUMN consumed_at TEXT;
ALTER TABLE approvals ADD COLUMN revoked_at TEXT;
CREATE INDEX approvals_run_principal_status_idx ON approvals(run_id, principal_id, status);
`,
    downSql: `
DROP INDEX approvals_run_principal_status_idx;
ALTER TABLE approvals DROP COLUMN revoked_at;
ALTER TABLE approvals DROP COLUMN consumed_at;
ALTER TABLE approvals DROP COLUMN expires_at;
ALTER TABLE approvals DROP COLUMN policy_version;
ALTER TABLE approvals DROP COLUMN principal_id;
`,
    rollbackCheckSql: `SELECT COUNT(*) AS count FROM approvals WHERE principal_id IS NOT NULL OR policy_version IS NOT NULL OR expires_at IS NOT NULL OR consumed_at IS NOT NULL OR revoked_at IS NOT NULL`,
  },
  {
    version: 3,
    name: "run_artifact_metadata",
    sql: `
CREATE UNIQUE INDEX execution_runs_id_project_id_uq ON execution_runs(id, project_id);
CREATE TABLE run_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('git_diff', 'stdout', 'stderr', 'test_results', 'execution_manifest', 'result_metadata')),
  logical_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-fA-F0-9]*')),
  created_at TEXT NOT NULL,
  storage_locator TEXT,
  collection_status TEXT NOT NULL CHECK (collection_status IN ('complete', 'truncated', 'failed', 'unavailable')),
  collection_error TEXT,
  UNIQUE (run_id, artifact_type, logical_name),
  FOREIGN KEY (run_id, project_id) REFERENCES execution_runs(id, project_id) ON DELETE RESTRICT,
  CHECK ((collection_status IN ('complete', 'truncated') AND storage_locator IS NOT NULL AND sha256 IS NOT NULL AND collection_error IS NULL) OR (collection_status = 'failed' AND storage_locator IS NULL AND collection_error IS NOT NULL) OR (collection_status = 'unavailable' AND byte_size = 0 AND sha256 IS NULL AND storage_locator IS NULL AND collection_error IS NOT NULL))
);
CREATE INDEX run_artifacts_run_created_idx ON run_artifacts(run_id, created_at, id);
CREATE INDEX run_artifacts_project_created_idx ON run_artifacts(project_id, created_at, id);
`,
    downSql: `
DROP TABLE run_artifacts;
DROP INDEX execution_runs_id_project_id_uq;
`,
    rollbackCheckSql: "SELECT COUNT(*) AS count FROM run_artifacts",
  },
  {
    version: 4,
    name: "durable_worker_run_leases",
    sql: `
CREATE TABLE run_leases (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation > 0),
  claimed_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (heartbeat_at >= claimed_at),
  CHECK (expires_at > claimed_at)
);
CREATE INDEX run_leases_expiration_idx ON run_leases(released_at, expires_at, run_id);
`,
    downSql: `
DROP TABLE run_leases;
`,
    rollbackCheckSql: "SELECT COUNT(*) AS count FROM run_leases",
  },
  {
    version: 5,
    name: "trusted_principals_sessions_and_ownership",
    sql: `
CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  auth_source TEXT NOT NULL CHECK (auth_source = 'local_password'),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_principal_idx ON auth_sessions(principal_id, expires_at);
CREATE TABLE project_memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, principal_id)
);
CREATE INDEX project_memberships_principal_idx ON project_memberships(principal_id, project_id);
CREATE TABLE run_owners (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE INDEX run_owners_principal_idx ON run_owners(principal_id, run_id);
`,
    downSql: `
DROP TABLE run_owners;
DROP TABLE project_memberships;
DROP TABLE auth_sessions;
DROP TABLE principals;
`,
    rollbackCheckSql:
      "SELECT (SELECT count(*) FROM principals) + (SELECT count(*) FROM auth_sessions) + (SELECT count(*) FROM project_memberships) + (SELECT count(*) FROM run_owners) AS count",
  },
];
