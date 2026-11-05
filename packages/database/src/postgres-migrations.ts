export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
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
];
