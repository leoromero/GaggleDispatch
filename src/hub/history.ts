/**
 * Hub history — the dashboard's log stream and token roll-up.
 *
 * Previously a SQLite file of its own. Now migrations 200–299 in the shared
 * database, which means one connection string is the whole persistence story and
 * removes the second database from the deployment.
 *
 * Scope shrank in the move. `runs` and `gate_events` are not ported: those are
 * `ticket_targets` and `control_events` now, with authoritative statuses rather
 * than statuses inferred by diffing state snapshots — the hub used to admit in a
 * comment that it could not tell how a gate had resolved. Existing SQLite history
 * is left on disk for archaeology; these tables start empty.
 */

import {
  int,
  isoRequired,
  jsonObject,
  openSql,
  text,
  textRequired,
  type Row,
  type Sql,
} from '../store/sql.ts';
import { migrateAll } from '../store/schema.ts';
import { logger } from '../util/logger.ts';

export interface WorkspaceRow {
  id: number;
  name: string;
  path: string;
  color: string | null;
  registered_at: string;
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
  fields: Record<string, unknown> | null;
}

export interface TokenDailyRow {
  workspace_id: number;
  day: string;
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

export interface LogQueryFilter {
  workspace_id?: number;
  issue_id?: string;
  repo_alias?: string;
  level?: string;
  since?: string;
  limit?: number;
}

function mapWorkspace(r: Row): WorkspaceRow {
  return {
    id: int(r.id),
    name: textRequired(r.name),
    path: textRequired(r.path),
    color: text(r.color),
    registered_at: isoRequired(r.registered_at),
  };
}

function mapLog(r: Row): LogRow {
  return {
    id: int(r.id),
    workspace_id: int(r.workspace_id),
    ts: isoRequired(r.ts),
    level: textRequired(r.level),
    message: textRequired(r.message),
    session_id: text(r.session_id),
    issue_id: text(r.issue_id),
    repo_alias: text(r.repo_alias),
    fields: r.fields === null || r.fields === undefined ? null : jsonObject(r.fields),
  };
}

export class HistoryStore {
  private readonly sql: Sql;

  constructor(
    databaseUrl: string,
    private readonly retentionDays = 14,
  ) {
    this.sql = openSql(databaseUrl);
  }

  /**
   * Bring the database up to date — the whole schema, not just this module's.
   *
   * Authorship is per-owner (see `store/schema.ts`); application is not. A
   * process that opens this database needs every table in it: the engine store
   * reads `scaffold_jobs`, which the control plane creates, and the hub's
   * history tables were reachable only from `nest start`. Applying one slice
   * produced a database that looked migrated and could not be used.
   */
  async migrate(): Promise<void> {
    await migrateAll(this.sql as never);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  /** Register or refresh a workspace. Idempotent on name. */
  async upsertWorkspace(name: string, path: string, color: string | null): Promise<WorkspaceRow> {
    const rows = (await this.sql`
      INSERT INTO hub_workspaces (name, path, color) VALUES (${name}, ${path}, ${color})
      ON CONFLICT (name) DO UPDATE SET path = EXCLUDED.path, color = EXCLUDED.color
      RETURNING *`) as Row[];
    return mapWorkspace(rows[0]!);
  }

  async appendLog(input: AppendLogInput): Promise<void> {
    await this.sql`
      INSERT INTO hub_log_events (workspace_id, ts, level, message, session_id, issue_id, repo_alias, fields)
      VALUES (${input.workspace_id}, ${input.ts}, ${input.level}, ${input.message},
              ${input.session_id ?? null}, ${input.issue_id ?? null}, ${input.repo_alias ?? null},
              ${input.fields ?? null})`;
  }

  /**
   * Newest first, filtered.
   *
   * Each filter is `($n IS NULL OR col = $n)` rather than an assembled WHERE
   * clause: one query plan, no string building, and an absent filter is
   * unambiguously "no filter".
   */
  async queryLogs(filter: LogQueryFilter): Promise<LogRow[]> {
    const rows = (await this.sql`
      SELECT * FROM hub_log_events
       WHERE (${filter.workspace_id ?? null}::bigint IS NULL OR workspace_id = ${filter.workspace_id ?? null})
         AND (${filter.issue_id ?? null}::text IS NULL OR issue_id = ${filter.issue_id ?? null})
         AND (${filter.repo_alias ?? null}::text IS NULL OR repo_alias = ${filter.repo_alias ?? null})
         AND (${filter.level ?? null}::text IS NULL OR level = ${filter.level ?? null})
         AND (${filter.since ?? null}::timestamptz IS NULL OR ts > ${filter.since ?? null}::timestamptz)
       ORDER BY ts DESC
       LIMIT ${filter.limit ?? 500}`) as Row[];
    return rows.map(mapLog);
  }

  /** Drop log events past the retention window. Returns how many. */
  async pruneOldLogs(): Promise<number> {
    const rows = (await this.sql`
      DELETE FROM hub_log_events
       WHERE ts < now() - make_interval(days => ${this.retentionDays})
      RETURNING id`) as Row[];
    return rows.length;
  }

  /** Add to today's token totals for a workspace. */
  async addTokens(workspaceId: number, tokensIn: number, tokensOut: number): Promise<void> {
    await this.sql`
      INSERT INTO hub_token_daily (workspace_id, day, tokens_in, tokens_out)
      VALUES (${workspaceId}, current_date, ${tokensIn}, ${tokensOut})
      ON CONFLICT (workspace_id, day) DO UPDATE SET
        tokens_in  = hub_token_daily.tokens_in  + EXCLUDED.tokens_in,
        tokens_out = hub_token_daily.tokens_out + EXCLUDED.tokens_out`;
  }

  async tokenHistory(workspaceId: number | null, days: number): Promise<TokenDailyRow[]> {
    const rows = (await this.sql`
      SELECT workspace_id, day::text AS day, tokens_in, tokens_out
        FROM hub_token_daily
       WHERE (${workspaceId}::bigint IS NULL OR workspace_id = ${workspaceId})
         AND day >= current_date - make_interval(days => ${days})
       ORDER BY day DESC`) as Row[];
    return rows.map((r) => ({
      workspace_id: int(r.workspace_id),
      day: textRequired(r.day),
      tokens_in: int(r.tokens_in),
      tokens_out: int(r.tokens_out),
    }));
  }
}

/**
 * Open the history store, or null when it is unavailable.
 *
 * Null rather than throwing: the nest must still start and give an operator
 * process controls when the database is unreachable. Losing the log panel should
 * not cost you the tools you need to fix it.
 */
export async function openHistoryStore(
  databaseUrl: string,
  retentionDays?: number,
): Promise<HistoryStore | null> {
  if (!databaseUrl) return null;
  try {
    const store = new HistoryStore(databaseUrl, retentionDays);
    await store.migrate();
    return store;
  } catch (err) {
    logger.warn('Hub history unavailable', { error: (err as Error).message });
    return null;
  }
}
