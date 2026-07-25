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

export const MIGRATIONS: Migration[] = [{ version: 1, name: 'init', sql: M001_INIT }];

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
