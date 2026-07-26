/**
 * Schema migrations.
 *
 * Migrations live here as versioned SQL strings rather than as `.sql` files on
 * disk so `bun build --target=bun` produces a single self-contained binary —
 * a compiled CLI that has to locate a migrations directory at runtime is a
 * deployment footgun. Ordering and one-time application are unchanged: the
 * runner applies pending versions in ascending order, each in its own
 * transaction, recording them in `schema_migrations`.
 *
 * Statuses are TEXT + CHECK rather than Postgres ENUMs. Enums would be
 * marginally tighter but `ALTER TYPE ... ADD VALUE` cannot run inside a
 * transaction block on older servers, which makes adding a status later a
 * migration hazard for no real benefit.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M001_INIT = `
CREATE TABLE workflow_runs (
  id                UUID PRIMARY KEY,
  workflow_name     TEXT NOT NULL,
  workflow_source   TEXT NOT NULL,
  workflow_hash     TEXT NOT NULL,
  user_message      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending','running','paused','completed','failed','cancelled','interrupted')),
  repo_slug         TEXT,
  working_path      TEXT,
  base_branch       TEXT,
  branch            TEXT,
  artifacts_dir     TEXT,
  env               JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run           BOOLEAN NOT NULL DEFAULT false,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ
);

CREATE INDEX idx_runs_status        ON workflow_runs (status);
CREATE INDEX idx_runs_working_path  ON workflow_runs (working_path);
CREATE INDEX idx_runs_repo_started  ON workflow_runs (repo_slug, started_at DESC);
-- Drives the startup sweep: only running rows can have a stale lease.
CREATE INDEX idx_runs_stale_lease   ON workflow_runs (lease_expires_at) WHERE status = 'running';

CREATE TABLE workflow_run_nodes (
  run_id            UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id           TEXT NOT NULL,
  node_type         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending','running','completed','failed','skipped','cancelled','interrupted')),
  attempt           INT  NOT NULL DEFAULT 0,
  output            TEXT,
  output_json       JSONB,
  error             TEXT,
  claude_session_id TEXT,
  side_effects      TEXT NOT NULL DEFAULT 'idempotent'
                      CHECK (side_effects IN ('idempotent','at_most_once')),
  input_tokens      INT NOT NULL DEFAULT 0,
  output_tokens     INT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE workflow_run_loop_iterations (
  run_id     UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  iteration  INT  NOT NULL,
  output     TEXT,
  user_input TEXT,
  completed  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id, iteration)
);

CREATE TABLE workflow_run_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id     UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  node_id    TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_run ON workflow_run_events (run_id, id);

CREATE TABLE workflow_approvals (
  id              UUID PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,
  message         TEXT NOT NULL,
  decision        TEXT CHECK (decision IN ('approved','rejected','timeout')),
  comment         TEXT,
  rework_attempts INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);

-- At most one undecided gate per run: the engine pauses on exactly one node.
CREATE UNIQUE INDEX idx_approvals_one_pending
  ON workflow_approvals (run_id) WHERE decision IS NULL;

CREATE TABLE worktrees (
  id               UUID PRIMARY KEY,
  repo_slug        TEXT NOT NULL,
  branch           TEXT NOT NULL,
  path             TEXT NOT NULL,
  base_branch      TEXT,
  run_id           UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_slug, branch)
);
`;

/**
 * Everything the daemon mutates that was still living in files.
 *
 * `external_key` on workflow_runs is what lets the run registry's lookup half
 * disappear: the orchestrator stamps the run with its worker key at launch, so
 * "which run belongs to this issue+repo" becomes a query instead of a JSON
 * sidecar that has to be kept in sync with reality.
 */
const M002_REGISTRIES = `
ALTER TABLE workflow_runs ADD COLUMN external_key TEXT;
CREATE INDEX idx_runs_external_key ON workflow_runs (external_key, started_at DESC);

-- Retry back-off survives a restart so attempt counts do not reset to zero.
CREATE TABLE retry_schedule (
  worker_key      TEXT PRIMARY KEY,
  parent_issue_id TEXT NOT NULL,
  sub_issue_id    TEXT,
  repo_alias      TEXT NOT NULL,
  attempt         INT  NOT NULL,
  due_at          TIMESTAMPTZ NOT NULL,
  reason          TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_retry_due ON retry_schedule (due_at);

-- Analysis is an expensive Claude call, so it is cached until the parent issue
-- reaches a terminal state.
CREATE TABLE issue_analyses (
  issue_id TEXT PRIMARY KEY,
  analysis JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scaffold_jobs (
  slug           TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  checkout_path  TEXT NOT NULL,
  run_id         UUID,
  workflow_name  TEXT NOT NULL,
  branch         TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  last_polled_at TIMESTAMPTZ,
  last_status    TEXT NOT NULL,
  pr_url         TEXT,
  last_error     TEXT
);

-- The repo syncer's materialized view of every registered repository.
-- frontmatter stays JSONB rather than being shredded into columns: the loader
-- rebuilds a whole RegistryContext from it, and jsonb operators still allow
-- querying components without a second table to keep consistent.
CREATE TABLE synced_repos (
  url             TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  default_branch  TEXT NOT NULL,
  local_path      TEXT NOT NULL,
  last_synced_at  TIMESTAMPTZ,
  last_commit_sha TEXT,
  sync_status     TEXT NOT NULL,
  sync_error      TEXT,
  frontmatter     JSONB,
  narrative       TEXT
);

-- Single row. Bumped on every sync pass; the loader polls it to notice a sync
-- that happened in another process (an operator running \`gaggle sync\`).
CREATE TABLE registry_meta (
  only_row  BOOLEAN PRIMARY KEY DEFAULT true CHECK (only_row),
  synced_at TIMESTAMPTZ NOT NULL
);
`;

/** Hub history, moved off its own SQLite file so there is one database. */
const M003_HUB_HISTORY = `
CREATE TABLE hub_workspaces (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL,
  color         TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hub_runs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      BIGINT NOT NULL REFERENCES hub_workspaces(id) ON DELETE CASCADE,
  issue_id          TEXT NOT NULL,
  issue_identifier  TEXT NOT NULL,
  repo_alias        TEXT NOT NULL,
  session_id        TEXT,
  run_id            TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  status            TEXT NOT NULL,
  tokens_in         INT NOT NULL DEFAULT 0,
  tokens_out        INT NOT NULL DEFAULT 0,
  turn_count        INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_hub_runs_ws ON hub_runs (workspace_id, started_at DESC);

CREATE TABLE hub_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES hub_workspaces(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  session_id   TEXT,
  issue_id     TEXT,
  repo_alias   TEXT,
  fields       JSONB
);
CREATE INDEX idx_hub_logs_ws_ts ON hub_logs (workspace_id, ts DESC);
CREATE INDEX idx_hub_logs_ts ON hub_logs (ts);

CREATE TABLE hub_gate_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES hub_workspaces(id) ON DELETE CASCADE,
  issue_id     TEXT NOT NULL,
  repo_alias   TEXT NOT NULL,
  run_id       TEXT,
  action       TEXT NOT NULL CHECK (action IN ('paused','approved','rejected','timed_out')),
  message      TEXT,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hub_gates_ws ON hub_gate_events (workspace_id, ts DESC);

CREATE TABLE hub_token_daily (
  workspace_id BIGINT NOT NULL REFERENCES hub_workspaces(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  tokens_in    BIGINT NOT NULL DEFAULT 0,
  tokens_out   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: M001_INIT },
  { version: 2, name: 'registries', sql: M002_REGISTRIES },
  { version: 3, name: 'hub_history', sql: M003_HUB_HISTORY },
];

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
