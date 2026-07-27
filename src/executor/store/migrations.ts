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
 * The engine owns versions 1–99 of one `schema_migrations` table shared with
 * the control plane (100–199) and hub history (200–299). A range is a claim on
 * *tables*, not only on numbers: this set deliberately does not create
 * `scaffold_jobs`, `hub_workspaces` or `hub_token_daily`, which the other two
 * own. `assertInRange` catches a stray version at import; the table half is
 * covered by a test that applies all three sets to one database.
 *
 * Statuses are TEXT + CHECK rather than Postgres ENUMs. Enums would be
 * marginally tighter but `ALTER TYPE ... ADD VALUE` cannot run inside a
 * transaction block on older servers, which makes adding a status later a
 * migration hazard for no real benefit.
 */

import { assertInRange, type Migration } from '../../store/migrate.ts';

export type { Migration };

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


-- Analysis is an expensive Claude call, so it is cached until the parent issue
-- reaches a terminal state.
CREATE TABLE issue_analyses (
  issue_id TEXT PRIMARY KEY,
  analysis JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

const M004_RUNS_STARTED_INDEX = `
CREATE INDEX IF NOT EXISTS idx_runs_started ON workflow_runs (started_at DESC);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: M001_INIT },
  { version: 2, name: 'registries', sql: M002_REGISTRIES },
  { version: 4, name: 'runs_started_index', sql: M004_RUNS_STARTED_INDEX },
];

assertInRange('engine', MIGRATIONS);

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
