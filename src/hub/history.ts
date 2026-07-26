/**
 * Hub-level history: workspaces, runs, log events, gate events, and per-day
 * token aggregates, surfaced by the dashboard.
 *
 * Was a SQLite file at ~/.config/gaggle/history.db. It moved into the same
 * Postgres the engine uses — running two databases for one product was the one
 * outcome strictly worse than either alternative.
 *
 * Live orchestrator state (the running map, supervised gates) is deliberately
 * NOT here. That stays in memory in each gaggle process; this is queryable
 * history only.
 *
 * Every method is async now. The SQLite original was synchronous, which is why
 * the hub server's handlers had to grow `await`s along with this change.
 */

import type { SQL } from 'bun';
import type { PostgresStore } from '../executor/store/postgres.ts';

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

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);
const isoReq = (v: unknown): string => iso(v) ?? new Date(0).toISOString();

/** Postgres DATE comes back as a Date; the API has always exposed YYYY-MM-DD. */
const day = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export class HistoryDb {
  private readonly sql: SQL;
  private readonly retentionDays: number;

  /**
   * Takes the store rather than a connection string so the hub shares the
   * engine's pool instead of opening a second one.
   */
  constructor(store: PostgresStore, retentionDays = 14) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sql = (store as any).sql as SQL;
    this.retentionDays = retentionDays;
  }

  // ── workspaces ─────────────────────────────────────────────────────────────

  async upsertWorkspace(name: string, path: string, color: string | null): Promise<WorkspaceRow> {
    const rows = (await this.sql`
      INSERT INTO hub_workspaces (name, path, color) VALUES (${name}, ${path}, ${color})
      ON CONFLICT (name) DO UPDATE SET path = excluded.path, color = excluded.color
      RETURNING *`) as Row[];
    return this.mapWorkspace(rows[0]!);
  }

  async listWorkspaces(): Promise<WorkspaceRow[]> {
    const rows = (await this.sql`SELECT * FROM hub_workspaces ORDER BY name`) as Row[];
    return rows.map((r) => this.mapWorkspace(r));
  }

  async getWorkspaceByName(name: string): Promise<WorkspaceRow | null> {
    const rows = (await this.sql`SELECT * FROM hub_workspaces WHERE name = ${name}`) as Row[];
    return rows[0] ? this.mapWorkspace(rows[0]) : null;
  }

  async removeWorkspace(name: string): Promise<void> {
    await this.sql`DELETE FROM hub_workspaces WHERE name = ${name}`;
  }

  private mapWorkspace(r: Row): WorkspaceRow {
    return {
      id: Number(r.id),
      name: String(r.name),
      path: String(r.path),
      color: (r.color as string) ?? null,
      registered_at: isoReq(r.registered_at),
    };
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  async recordRunStart(input: RecordRunStartInput): Promise<void> {
    // DO NOTHING on the natural key, matching the original INSERT OR IGNORE:
    // a repeated start event must not create a second row.
    await this.sql`
      INSERT INTO hub_runs
        (workspace_id, issue_id, issue_identifier, repo_alias, session_id, run_id, started_at, status)
      VALUES (${input.workspace_id}, ${input.issue_id}, ${input.issue_identifier},
              ${input.repo_alias}, ${input.session_id ?? null}, ${input.run_id ?? null},
              ${input.started_at}, ${input.status ?? 'running'})
      ON CONFLICT (workspace_id, issue_id, repo_alias, started_at) DO NOTHING`;
  }

  async recordRunEnd(input: RecordRunEndInput): Promise<void> {
    await this.sql`
      UPDATE hub_runs
         SET ended_at   = ${input.ended_at},
             status     = ${input.status},
             tokens_in  = COALESCE(${input.tokens_in ?? null}, tokens_in),
             tokens_out = COALESCE(${input.tokens_out ?? null}, tokens_out),
             turn_count = COALESCE(${input.turn_count ?? null}, turn_count)
       WHERE workspace_id = ${input.workspace_id}
         AND issue_id     = ${input.issue_id}
         AND repo_alias   = ${input.repo_alias}
         AND started_at   = ${input.started_at}`;
  }

  async recentRuns(workspaceId: number | null, limit = 50): Promise<RunRow[]> {
    const rows = (
      workspaceId === null
        ? await this.sql`SELECT * FROM hub_runs ORDER BY started_at DESC LIMIT ${limit}`
        : await this.sql`
            SELECT * FROM hub_runs WHERE workspace_id = ${workspaceId}
             ORDER BY started_at DESC LIMIT ${limit}`
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      workspace_id: Number(r.workspace_id),
      issue_id: String(r.issue_id),
      issue_identifier: String(r.issue_identifier),
      repo_alias: String(r.repo_alias),
      session_id: (r.session_id as string) ?? null,
      run_id: (r.run_id as string) ?? null,
      started_at: isoReq(r.started_at),
      ended_at: iso(r.ended_at),
      status: String(r.status),
      tokens_in: Number(r.tokens_in ?? 0),
      tokens_out: Number(r.tokens_out ?? 0),
      turn_count: Number(r.turn_count ?? 0),
    }));
  }

  // ── log events ─────────────────────────────────────────────────────────────

  async appendLog(input: AppendLogInput): Promise<void> {
    await this.sql`
      INSERT INTO hub_logs (workspace_id, ts, level, message, session_id, issue_id, repo_alias, fields)
      VALUES (${input.workspace_id}, ${input.ts}, ${input.level}, ${input.message},
              ${input.session_id ?? null}, ${input.issue_id ?? null},
              ${input.repo_alias ?? null}, ${(input.fields ?? null) as never})`;
  }

  async queryLogs(filter: LogQueryFilter): Promise<LogRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.workspace_id !== undefined) add('workspace_id = ?', filter.workspace_id);
    if (filter.issue_id) add('issue_id = ?', filter.issue_id);
    if (filter.repo_alias) add('repo_alias = ?', filter.repo_alias);
    if (filter.level) add('level = ?', filter.level);
    if (filter.since) add('ts > ?', filter.since);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 500);
    const rows = (await this.sql.unsafe(
      `SELECT * FROM hub_logs ${where} ORDER BY ts DESC LIMIT $${params.length}`,
      params,
    )) as Row[];

    return rows.map((r) => ({
      id: Number(r.id),
      workspace_id: Number(r.workspace_id),
      ts: isoReq(r.ts),
      level: String(r.level),
      message: String(r.message),
      session_id: (r.session_id as string) ?? null,
      issue_id: (r.issue_id as string) ?? null,
      repo_alias: (r.repo_alias as string) ?? null,
      // The column is jsonb now; the API has always exposed a JSON string.
      fields_json:
        r.fields === null || r.fields === undefined
          ? null
          : typeof r.fields === 'string'
            ? r.fields
            : JSON.stringify(r.fields),
    }));
  }

  async pruneOldLogs(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    const rows = (await this.sql`
      DELETE FROM hub_logs WHERE ts < ${cutoff} RETURNING id`) as Row[];
    return rows.length;
  }

  // ── gate events ────────────────────────────────────────────────────────────

  async recordGate(input: RecordGateInput): Promise<void> {
    await this.sql`
      INSERT INTO hub_gate_events
        (workspace_id, issue_id, repo_alias, run_id, action, gate_message, paused_at, resolved_at)
      VALUES (${input.workspace_id}, ${input.issue_id}, ${input.repo_alias},
              ${input.run_id ?? null}, ${input.action}, ${input.gate_message ?? null},
              ${input.paused_at}, ${input.resolved_at ?? null})`;
  }

  async recentGateEvents(workspaceId: number | null, limit = 50): Promise<GateEventRow[]> {
    const rows = (
      workspaceId === null
        ? await this.sql`SELECT * FROM hub_gate_events ORDER BY paused_at DESC LIMIT ${limit}`
        : await this.sql`
            SELECT * FROM hub_gate_events WHERE workspace_id = ${workspaceId}
             ORDER BY paused_at DESC LIMIT ${limit}`
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      workspace_id: Number(r.workspace_id),
      issue_id: String(r.issue_id),
      repo_alias: String(r.repo_alias),
      run_id: (r.run_id as string) ?? null,
      action: r.action as GateEventRow['action'],
      gate_message: (r.gate_message as string) ?? null,
      paused_at: isoReq(r.paused_at),
      resolved_at: iso(r.resolved_at),
    }));
  }

  // ── token aggregates ───────────────────────────────────────────────────────

  async addTokens(
    workspaceId: number,
    date: string,
    tokensIn: number,
    tokensOut: number,
  ): Promise<void> {
    await this.sql`
      INSERT INTO hub_token_daily (workspace_id, date, tokens_in, tokens_out)
      VALUES (${workspaceId}, ${date}, ${tokensIn}, ${tokensOut})
      ON CONFLICT (workspace_id, date) DO UPDATE
        SET tokens_in  = hub_token_daily.tokens_in  + excluded.tokens_in,
            tokens_out = hub_token_daily.tokens_out + excluded.tokens_out`;
  }

  async tokenHistory(workspaceId: number | null, days = 30): Promise<TokenDailyRow[]> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = (
      workspaceId === null
        ? await this.sql`SELECT * FROM hub_token_daily WHERE date >= ${cutoff} ORDER BY date ASC`
        : await this.sql`
            SELECT * FROM hub_token_daily
             WHERE workspace_id = ${workspaceId} AND date >= ${cutoff} ORDER BY date ASC`
    ) as Row[];
    return rows.map((r) => ({
      workspace_id: Number(r.workspace_id),
      date: day(r.date),
      tokens_in: Number(r.tokens_in ?? 0),
      tokens_out: Number(r.tokens_out ?? 0),
    }));
  }

  /**
   * No-op. The pool belongs to the store, which closes it — closing here would
   * pull it out from under the engine.
   */
  close(): void {}
}
