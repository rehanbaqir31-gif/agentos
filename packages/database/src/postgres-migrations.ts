export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
  downSql?: string;
  rollbackCheckSql?: string;
}

export const postgresMigrations: readonly PostgresMigration[] = [
  {
    version: 1,
    name: "initial_core_schema",
    sql: `
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  repository_path TEXT NOT NULL UNIQUE,
  repository_url TEXT,
  default_branch TEXT,
  current_commit TEXT,
  settings JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX projects_created_at_idx ON projects(created_at);

CREATE TABLE agents (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  configuration JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  health_status TEXT NOT NULL CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX agents_adapter_id_idx ON agents(adapter_id);

CREATE TABLE providers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ollama', 'openai', 'anthropic', 'google', 'openai_compatible')),
  base_url TEXT,
  credential_ref TEXT,
  available_models JSONB NOT NULL,
  configuration JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX providers_type_idx ON providers(provider_type);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  assigned_agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  configuration JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX tasks_project_created_idx ON tasks(project_id, created_at);

CREATE TABLE execution_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  adapter_version TEXT NOT NULL,
  provider_id UUID REFERENCES providers(id) ON DELETE RESTRICT,
  model_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'validating', 'preparing_workspace', 'queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled')),
  manifest_id UUID,
  workspace_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  usage_metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (completed_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX execution_runs_project_created_idx ON execution_runs(project_id, created_at);
CREATE INDEX execution_runs_task_idx ON execution_runs(task_id);

CREATE TABLE run_manifests (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version = 1),
  run_id UUID NOT NULL UNIQUE REFERENCES execution_runs(id) ON DELETE RESTRICT,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  provider_id UUID REFERENCES providers(id) ON DELETE RESTRICT,
  model_id TEXT,
  prompt_configuration_hash TEXT NOT NULL CHECK (prompt_configuration_hash ~ '^[a-fA-F0-9]{64}$'),
  repository_commit_sha TEXT,
  tool_versions JSONB NOT NULL,
  skill_versions JSONB NOT NULL,
  runtime_configuration JSONB NOT NULL,
  permission_configuration JSONB NOT NULL,
  environment_variable_names JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, run_id)
);
ALTER TABLE execution_runs
  ADD CONSTRAINT execution_runs_manifest_fk
  FOREIGN KEY (manifest_id, id) REFERENCES run_manifests(id, run_id) ON DELETE RESTRICT;

CREATE TABLE agent_events (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX agent_events_run_time_idx ON agent_events(run_id, occurred_at);

CREATE TABLE run_event_counters (
  run_id UUID PRIMARY KEY REFERENCES execution_runs(id) ON DELETE RESTRICT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence > 0)
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL,
  action_description TEXT NOT NULL,
  requested_permissions JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CHECK ((status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) OR (status <> 'pending' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX approvals_run_status_idx ON approvals(run_id, status);

CREATE TABLE evaluations (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES execution_runs(id) ON DELETE RESTRICT,
  evaluator_version TEXT NOT NULL,
  criteria JSONB NOT NULL,
  scores JSONB NOT NULL,
  test_results JSONB NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
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
ALTER TABLE approvals ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN consumed_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN revoked_at TIMESTAMPTZ;
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
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  project_id UUID NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('git_diff', 'stdout', 'stderr', 'test_results', 'execution_manifest', 'result_metadata')),
  logical_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-fA-F0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
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
  run_id UUID PRIMARY KEY REFERENCES execution_runs(id) ON DELETE RESTRICT,
  worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 256),
  generation BIGINT NOT NULL CHECK (generation > 0),
  claimed_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
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
];
