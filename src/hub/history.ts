/**
 * Hub-level history store backed by SQLite (bun:sqlite).
 *
 * Persists multi-gaggle history: workspaces, runs, log events, gate events,
 * and per-day token aggregates. Lives at ~/.config/gaggle/history.db by
 * default. The hub is the single writer; gaggles ship events to the hub
 * over IPC and the hub writes here.
 *
 * Live orchestrator state (running map, supervised gates) is NOT stored
 * here — that stays in-memory in each gaggle process. This DB is only
 * for queryable history surfaced by the dashboard.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WorkspaceRow {
  id: number;
  name: string;
  path: string;
  color: string | null;
  registered_at: string;
}

export interface RunRow {
  id: number;
  workspace_id: number;
  issue_id: string;
  issue_identifier: string;
  repo_alias: string;
  session_id: string | null;
  run_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  turn_count: number;
}

export interface LogRow {
  id: number;
  workspace_id: number;
  ts: string;
  level: string;
  message: string;
  session_id: string | null;
  issue_id: string | null;
  repo_alias: string | null;
  fields_json: string | null;
}

export interface GateEventRow {
  id: number;
  workspace_id: number;
  issue_id: string;
  repo_alias: string;
  run_id: string | null;
  action: 'paused' | 'approved' | 'rejected' | 'timed_out';
  gate_message: string | null;
  paused_at: string;
  resolved_at: string | null;
}

export interface TokenDailyRow {
  workspace_id: number;
  date: string;
  tokens_in: number;
  tokens_out: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL,
  color         TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id        TEXT NOT NULL,
  issue_identifier TEXT NOT NULL,
  repo_alias      TEXT NOT NULL,
  session_id      TEXT,
  run_id   TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT NOT NULL,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, issue_id, repo_alias, started_at)
);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_started ON runs (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);

CREATE TABLE IF NOT EXISTS log_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ts           TEXT NOT NULL,
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  session_id   TEXT,
  issue_id     TEXT,
  repo_alias   TEXT,
  fields_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_workspace_ts ON log_events (workspace_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_log_ts ON log_events (ts DESC);

CREATE TABLE IF NOT EXISTS gate_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL,
  repo_alias    TEXT NOT NULL,
  run_id TEXT,
  action        TEXT NOT NULL,
  gate_message  TEXT,
  paused_at     TEXT NOT NULL,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_gate_workspace_paused ON gate_events (workspace_id, paused_at DESC);

CREATE TABLE IF NOT EXISTS token_daily (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, date)
);
`;

export interface AppendLogInput {
  workspace_id: number;
  ts: string;
  level: string;
  message: string;
  session_id?: string | null;
  issue_id?: string | null;
  repo_alias?: string | null;
  fields?: Record<string, unknown> | null;
}

export interface RecordRunStartInput {
  workspace_id: number;
  issue_id: string;
  issue_identifier: string;
  repo_alias: string;
  session_id?: string | null;
  run_id?: string | null;
  started_at: string;
  status?: string;
}

export interface RecordRunEndInput {
  workspace_id: number;
  issue_id: string;
  repo_alias: string;
  started_at: string;
  ended_at: string;
  status: string;
  tokens_in?: number;
  tokens_out?: number;
  turn_count?: number;
}

export interface RecordGateInput {
  workspace_id: number;
  issue_id: string;
  repo_alias: string;
  run_id?: string | null;
  action: 'paused' | 'approved' | 'rejected' | 'timed_out';
  gate_message?: string | null;
  paused_at: string;
  resolved_at?: string | null;
}

export interface LogQueryFilter {
  workspace_id?: number;
  issue_id?: string;
  repo_alias?: string;
  level?: string;
  since?: string;
  limit?: number;
}

export class HistoryDb {
  private db: Database;
  private retentionDays: number;

  constructor(path: string, retentionDays = 14) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.retentionDays = retentionDays;
  }

  close(): void {
    this.db.close();
  }

  // ── workspaces ─────────────────────────────────────────────────────────────
  upsertWorkspace(name: string, path: string, color: string | null): WorkspaceRow {
    this.db
      .query(
        `INSERT INTO workspaces (name, path, color) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET path = excluded.path, color = excluded.color`,
      )
      .run(name, path, color);
    return this.db
      .query<WorkspaceRow, [string]>(`SELECT * FROM workspaces WHERE name = ?1`)
      .get(name) as WorkspaceRow;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db.query<WorkspaceRow, []>(`SELECT * FROM workspaces ORDER BY name`).all();
  }

  getWorkspaceByName(name: string): WorkspaceRow | null {
    return (
      this.db.query<WorkspaceRow, [string]>(`SELECT * FROM workspaces WHERE name = ?1`).get(name) ??
      null
    );
  }

  removeWorkspace(name: string): void {
    this.db.query(`DELETE FROM workspaces WHERE name = ?1`).run(name);
  }

  // ── runs ───────────────────────────────────────────────────────────────────
  recordRunStart(input: RecordRunStartInput): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO runs
           (workspace_id, issue_id, issue_identifier, repo_alias, session_id, run_id, started_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        input.workspace_id,
        input.issue_id,
        input.issue_identifier,
        input.repo_alias,
        input.session_id ?? null,
        input.run_id ?? null,
        input.started_at,
        input.status ?? 'running',
      );
  }

  recordRunEnd(input: RecordRunEndInput): void {
    this.db
      .query(
        `UPDATE runs
            SET ended_at = ?1,
                status = ?2,
                tokens_in = COALESCE(?3, tokens_in),
                tokens_out = COALESCE(?4, tokens_out),
                turn_count = COALESCE(?5, turn_count)
          WHERE workspace_id = ?6 AND issue_id = ?7 AND repo_alias = ?8 AND started_at = ?9`,
      )
      .run(
        input.ended_at,
        input.status,
        input.tokens_in ?? null,
        input.tokens_out ?? null,
        input.turn_count ?? null,
        input.workspace_id,
        input.issue_id,
        input.repo_alias,
        input.started_at,
      );
  }

  recentRuns(workspace_id: number | null, limit = 50): RunRow[] {
    if (workspace_id === null) {
      return this.db
        .query<RunRow, [number]>(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?1`)
        .all(limit);
    }
    return this.db
      .query<RunRow, [number, number]>(
        `SELECT * FROM runs WHERE workspace_id = ?1 ORDER BY started_at DESC LIMIT ?2`,
      )
      .all(workspace_id, limit);
  }

  // ── log events ─────────────────────────────────────────────────────────────
  appendLog(input: AppendLogInput): void {
    this.db
      .query(
        `INSERT INTO log_events
           (workspace_id, ts, level, message, session_id, issue_id, repo_alias, fields_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        input.workspace_id,
        input.ts,
        input.level,
        input.message,
        input.session_id ?? null,
        input.issue_id ?? null,
        input.repo_alias ?? null,
        input.fields ? JSON.stringify(input.fields) : null,
      );
  }

  queryLogs(filter: LogQueryFilter): LogRow[] {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (filter.workspace_id !== undefined) {
      where.push(`workspace_id = ?${params.length + 1}`);
      params.push(filter.workspace_id);
    }
    if (filter.issue_id) {
      where.push(`issue_id = ?${params.length + 1}`);
      params.push(filter.issue_id);
    }
    if (filter.repo_alias) {
      where.push(`repo_alias = ?${params.length + 1}`);
      params.push(filter.repo_alias);
    }
    if (filter.level) {
      where.push(`level = ?${params.length + 1}`);
      params.push(filter.level);
    }
    if (filter.since) {
      where.push(`ts > ?${params.length + 1}`);
      params.push(filter.since);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ?? 500;
    params.push(limit);
    return this.db
      .query<LogRow, (string | number | null)[]>(
        `SELECT * FROM log_events ${whereClause} ORDER BY ts DESC LIMIT ?${params.length}`,
      )
      .all(...params);
  }

  pruneOldLogs(): number {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    const result = this.db.query(`DELETE FROM log_events WHERE ts < ?1`).run(cutoff);
    return Number(result.changes);
  }

  // ── gate events ────────────────────────────────────────────────────────────
  recordGate(input: RecordGateInput): void {
    this.db
      .query(
        `INSERT INTO gate_events
           (workspace_id, issue_id, repo_alias, run_id, action, gate_message, paused_at, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        input.workspace_id,
        input.issue_id,
        input.repo_alias,
        input.run_id ?? null,
        input.action,
        input.gate_message ?? null,
        input.paused_at,
        input.resolved_at ?? null,
      );
  }

  recentGateEvents(workspace_id: number | null, limit = 50): GateEventRow[] {
    if (workspace_id === null) {
      return this.db
        .query<GateEventRow, [number]>(`SELECT * FROM gate_events ORDER BY paused_at DESC LIMIT ?1`)
        .all(limit);
    }
    return this.db
      .query<GateEventRow, [number, number]>(
        `SELECT * FROM gate_events WHERE workspace_id = ?1 ORDER BY paused_at DESC LIMIT ?2`,
      )
      .all(workspace_id, limit);
  }

  // ── token aggregates ───────────────────────────────────────────────────────
  addTokens(workspace_id: number, date: string, tokens_in: number, tokens_out: number): void {
    this.db
      .query(
        `INSERT INTO token_daily (workspace_id, date, tokens_in, tokens_out)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (workspace_id, date) DO UPDATE
           SET tokens_in = tokens_in + excluded.tokens_in,
               tokens_out = tokens_out + excluded.tokens_out`,
      )
      .run(workspace_id, date, tokens_in, tokens_out);
  }

  tokenHistory(workspace_id: number | null, days = 30): TokenDailyRow[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    if (workspace_id === null) {
      return this.db
        .query<TokenDailyRow, [string]>(
          `SELECT * FROM token_daily WHERE date >= ?1 ORDER BY date ASC`,
        )
        .all(cutoff);
    }
    return this.db
      .query<TokenDailyRow, [number, string]>(
        `SELECT * FROM token_daily WHERE workspace_id = ?1 AND date >= ?2 ORDER BY date ASC`,
      )
      .all(workspace_id, cutoff);
  }
}

export function defaultHistoryDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return `${home}/.config/gaggle/history.db`;
}
