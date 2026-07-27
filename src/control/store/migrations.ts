/**
 * Control-plane schema, versions 100–199.
 *
 * The workflow engine owns 1–99 and cross-cutting migrations own 300+, so this
 * module can be applied to a database the engine has already migrated (or not
 * yet migrated) in either order. See `src/store/migrate.ts`.
 *
 * Two deliberate schema choices:
 *
 *   - Statuses are TEXT + CHECK rather than Postgres ENUMs. `ALTER TYPE … ADD
 *     VALUE` cannot run inside a transaction block on older servers, which makes
 *     adding a status later a migration hazard for no real benefit. This also
 *     matches the engine's tables.
 *   - `ticket_targets.run_id` is TEXT with no foreign key — see the comment on the
 *     column for why TEXT. If a constraint against `workflow_runs(id)` is ever
 *     wanted it belongs in a 300-range migration that runs once both halves of the
 *     schema exist, which is what keeps merge order between the two branches
 *     irrelevant.
 */

import { assertInRange, type Migration } from '../../store/migrate.ts';

const M100_CONTROL_PLANE = `
CREATE TABLE tickets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace            TEXT NOT NULL,
  tracker_kind         TEXT NOT NULL DEFAULT 'linear',
  external_id          TEXT NOT NULL,
  identifier           TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT,
  priority             INT,
  url                  TEXT,
  branch_name          TEXT,
  parent_external_id   TEXT,
  external_state       TEXT NOT NULL,
  external_labels      JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_by           JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'imported' CHECK (status IN
                         ('imported','analysis_requested','analyzing','analyzed',
                          'analysis_failed','running','done','cancelled','archived')),
  analysis_summary     TEXT,
  complexity           TEXT CHECK (complexity IN ('simple','complex')),
  analysis_error       TEXT,
  external_created_at  TIMESTAMPTZ,
  external_updated_at  TIMESTAMPTZ,
  first_imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_terminal_at TIMESTAMPTZ,
  status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  analyzed_at          TIMESTAMPTZ,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  UNIQUE (workspace, tracker_kind, external_id)
);

CREATE INDEX idx_tickets_workspace_status  ON tickets (workspace, status);
CREATE INDEX idx_tickets_workspace_updated ON tickets (workspace, external_updated_at DESC);

CREATE TABLE ticket_targets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id            UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo_alias           TEXT NOT NULL,
  repo_url             TEXT NOT NULL,
  local_path           TEXT NOT NULL,
  workflow             TEXT NOT NULL,
  rationale            TEXT,
  components           JSONB NOT NULL DEFAULT '[]'::jsonb,
  depends_on           JSONB NOT NULL DEFAULT '[]'::jsonb,
  ready_when           TEXT,
  status               TEXT NOT NULL DEFAULT 'blocked' CHECK (status IN
                         ('excluded','blocked','ready','dispatching','running',
                          'gate_waiting','succeeded','failed','cancelled')),
  external_target_id   TEXT,
  external_target_url  TEXT,
  -- Refreshed by sync for targets that have a tracker sub-issue. Env-gated
  -- readiness (ready_when: deployed:staging) reads the upstream sibling's
  -- tracker state and labels, so those have to be here rather than inferred.
  external_target_state  TEXT,
  external_target_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- TEXT, not UUID, and deliberately so. The control plane never interprets a
  -- run id; it hands the string back to whichever executor produced it. Archon's
  -- ids are 32 hex characters with no dashes, which a UUID column would silently
  -- normalize into dashed form — and Archon does not recognize that form back.
  -- An opaque identifier from an unknown producer gets an opaque column type.
  run_id               TEXT,
  attempt              INT NOT NULL DEFAULT 0,
  failure_reason       TEXT,
  cancel_requested     BOOLEAN NOT NULL DEFAULT false,
  gate_approval_id     TEXT,
  gate_message         TEXT,
  gate_opened_at       TIMESTAMPTZ,
  gate_rework_attempts INT NOT NULL DEFAULT 0,
  -- An operator's answer to an open gate, recorded as intent. Answering requires
  -- resuming the run, which only the daemon that owns the executor can do, so the
  -- dashboard writes here and the daemon converts it into a transition. Same
  -- shape as cancel_requested, and crash-tolerant for the same reason.
  gate_decision         TEXT CHECK (gate_decision IN ('approved','rejected','blocker')),
  gate_decision_comment TEXT,
  gate_decision_at      TIMESTAMPTZ,
  status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at        TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  UNIQUE (ticket_id, repo_alias)
);

CREATE INDEX idx_targets_ticket ON ticket_targets (ticket_id);
-- Backs the daemon's hot queries: the ready drain and the live-target sweep.
CREATE INDEX idx_targets_active ON ticket_targets (status)
  WHERE status IN ('ready','dispatching','running','gate_waiting');

CREATE TABLE control_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE. Re-analysing a ticket replaces its whole fan-out, and
  -- cascading here would delete the audit trail of everything those targets did —
  -- the record this design calls authoritative. The event keeps its ticket and its
  -- text; only the now-dangling target reference is dropped.
  target_id   UUID REFERENCES ticket_targets(id) ON DELETE SET NULL,
  event_kind  TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('operator','daemon','sync')),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_control_events_ticket ON control_events (ticket_id, id DESC);

CREATE TABLE tracker_outbox (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace   TEXT NOT NULL,
  external_id TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('set_state','post_comment','apply_label','remove_label')),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);

CREATE INDEX idx_outbox_unsent ON tracker_outbox (id) WHERE sent_at IS NULL;

CREATE TABLE scaffold_jobs (
  slug           TEXT PRIMARY KEY,
  -- Defaulted, not just NOT NULL: the workflow-engine branch writes this table
  -- from code that predates the nest and knows nothing about workspaces. A
  -- default lets those inserts keep working unchanged instead of failing on a
  -- column they have never heard of. '' is the same "no workspace of its own"
  -- value the hub's ControlService already uses.
  workspace      TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL,
  checkout_path  TEXT NOT NULL,
  run_id         TEXT,
  workflow_name  TEXT NOT NULL,
  branch         TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at TIMESTAMPTZ,
  last_status    TEXT NOT NULL DEFAULT 'pending',
  pr_url         TEXT,
  last_error     TEXT
);
`;

export const CONTROL_MIGRATIONS: Migration[] = [
  { version: 100, name: 'control_plane', sql: M100_CONTROL_PLANE },
];

assertInRange('control', CONTROL_MIGRATIONS);

export const CONTROL_LATEST_VERSION = CONTROL_MIGRATIONS.reduce(
  (m, x) => Math.max(m, x.version),
  0,
);
