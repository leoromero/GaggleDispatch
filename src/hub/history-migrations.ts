/**
 * Hub history schema, versions 200–299.
 *
 * This is observability data — the log stream the dashboard renders, and a daily
 * token roll-up. Moving it off its own SQLite file removes the second database,
 * so a single connection string is the whole persistence story.
 *
 * Two tables from the SQLite schema are deliberately *not* ported:
 *
 *   - `runs` — a per-(issue, repo) attempt record, which is what `ticket_targets`
 *     plus `control_events` now are, with statuses that are authoritative rather
 *     than inferred.
 *   - `gate_events` — the hub used to reconstruct these by diffing gates in and
 *     out of state snapshots, and admitted in a comment that it could not tell
 *     how one had resolved. `control_events` records the resolution, the actor,
 *     and the comment, so re-deriving a worse version of it is pointless.
 *
 * Existing SQLite history is not migrated. It is observability data; the file is
 * left on disk for archaeology and the new tables start empty.
 */

import type { Migration } from '../store/migrate.ts';

const M200_HUB_HISTORY = `
CREATE TABLE hub_workspaces (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL,
  color         TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hub_log_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES hub_workspaces(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ NOT NULL,
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  session_id   TEXT,
  issue_id     TEXT,
  repo_alias   TEXT,
  fields       JSONB
);

-- The dashboard's log panel filters by workspace and orders by time; retention
-- sweeps by time alone.
CREATE INDEX idx_hub_logs_workspace_ts ON hub_log_events (workspace_id, ts DESC);
CREATE INDEX idx_hub_logs_ts           ON hub_log_events (ts DESC);

CREATE TABLE hub_token_daily (
  workspace_id BIGINT NOT NULL REFERENCES hub_workspaces(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  tokens_in    BIGINT NOT NULL DEFAULT 0,
  tokens_out   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
`;

export const HUB_MIGRATIONS: Migration[] = [
  { version: 200, name: 'hub_history', sql: M200_HUB_HISTORY },
];
