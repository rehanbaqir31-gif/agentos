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
];
