/**
 * Postgres-backed store, on Bun's native SQL driver.
 *
 * Bun ships a Postgres client in the runtime, so this costs no dependency and
 * gets parameterization for free from tagged templates. Every timestamp is
 * normalized to an ISO-8601 string on the way out — callers compare and
 * serialize these, and a mix of `Date` and `string` is a bug factory.
 */

import { SQL } from 'bun';
import { logger } from '../../util/logger.ts';
import { LATEST_VERSION, MIGRATIONS } from './migrations.ts';
import { applyMigrations } from '../../store/migrate.ts';
import type {
  ApprovalDecision,
  ApprovalRow,
  CreateRunInput,
  EventRow,
  LoopIterationRow,
  NodeRow,
  RunQuery,
  RunRow,
  ScaffoldJobRow,
  Store,
  SyncedRepoRow,
  UpsertNodeInput,
  WorktreeRow,
} from './types.ts';

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function isoRequired(v: unknown): string {
  return iso(v) ?? new Date(0).toISOString();
}

/**
 * Bun's driver hands JSONB back as raw text rather than a parsed value, so
 * every jsonb column has to go through here. Tolerates an already-parsed
 * object too, in case that changes in a future Bun release.
 */
function parseJson(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  // The driver decodes jsonb for us, so a string arriving here is normally
  // already the value — `output_json: "plain"` comes back as `plain`, not as
  // `"plain"`. Try a parse anyway for rows written as JSON text, but fall
  // back to the string itself: returning null threw away a model's answer.
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  const parsed = parseJson(v);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function mapRun(r: Row): RunRow {
  return {
    id: String(r.id),
    workflow_name: String(r.workflow_name),
    workflow_source: String(r.workflow_source),
    workflow_hash: String(r.workflow_hash),
    user_message: String(r.user_message),
    status: r.status as RunRow['status'],
    repo_slug: (r.repo_slug as string) ?? null,
    working_path: (r.working_path as string) ?? null,
    base_branch: (r.base_branch as string) ?? null,
    branch: (r.branch as string) ?? null,
    artifacts_dir: (r.artifacts_dir as string) ?? null,
    external_key: (r.external_key as string) ?? null,
    env: asRecord(r.env) as Record<string, string>,
    metadata: asRecord(r.metadata),
    started_at: isoRequired(r.started_at),
    completed_at: iso(r.completed_at),
    last_activity_at: iso(r.last_activity_at),
    lease_owner: (r.lease_owner as string) ?? null,
    lease_expires_at: iso(r.lease_expires_at),
    dry_run: Boolean(r.dry_run),
  };
}

function mapNode(r: Row): NodeRow {
  return {
    run_id: String(r.run_id),
    node_id: String(r.node_id),
    node_type: String(r.node_type),
    status: r.status as NodeRow['status'],
    attempt: Number(r.attempt ?? 0),
    output: (r.output as string) ?? null,
    output_json: parseJson(r.output_json),
    error: (r.error as string) ?? null,
    claude_session_id: (r.claude_session_id as string) ?? null,
    side_effects: (r.side_effects as NodeRow['side_effects']) ?? 'idempotent',
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    started_at: iso(r.started_at),
    completed_at: iso(r.completed_at),
  };
}

function mapApproval(r: Row): ApprovalRow {
  return {
    id: String(r.id),
    run_id: String(r.run_id),
    node_id: String(r.node_id),
    message: String(r.message),
    decision: (r.decision as ApprovalDecision) ?? null,
    comment: (r.comment as string) ?? null,
    rework_attempts: Number(r.rework_attempts ?? 0),
    created_at: isoRequired(r.created_at),
    decided_at: iso(r.decided_at),
  };
}

function mapWorktree(r: Row): WorktreeRow {
  return {
    id: String(r.id),
    repo_slug: String(r.repo_slug),
    branch: String(r.branch),
    path: String(r.path),
    base_branch: (r.base_branch as string) ?? null,
    run_id: (r.run_id as string) ?? null,
    created_at: isoRequired(r.created_at),
    last_activity_at: isoRequired(r.last_activity_at),
  };
}

function mapScaffold(r: Row): ScaffoldJobRow {
  return {
    slug: String(r.slug),
    url: String(r.url),
    checkout_path: String(r.checkout_path),
    run_id: (r.run_id as string) ?? null,
    workflow_name: String(r.workflow_name),
    branch: String(r.branch),
    started_at: isoRequired(r.started_at),
    last_polled_at: iso(r.last_polled_at),
    last_status: String(r.last_status),
    pr_url: (r.pr_url as string) ?? null,
    last_error: (r.last_error as string) ?? null,
  };
}

function mapSyncedRepo(r: Row): SyncedRepoRow {
  return {
    url: String(r.url),
    slug: String(r.slug),
    default_branch: String(r.default_branch),
    local_path: String(r.local_path),
    last_synced_at: iso(r.last_synced_at),
    last_commit_sha: (r.last_commit_sha as string) ?? null,
    sync_status: String(r.sync_status),
    sync_error: (r.sync_error as string) ?? null,
    frontmatter: parseJson(r.frontmatter),
    narrative: (r.narrative as string) ?? null,
  };
}

export class PostgresStore implements Store {
  private readonly sql: SQL;

  constructor(databaseUrl: string, opts: { maxConnections?: number } = {}) {
    if (!databaseUrl) {
      throw new Error(
        'No database URL. Set DATABASE_URL (see docker-compose.yml) or database.url in WORKFLOW.md.',
      );
    }
    // A modest pool on purpose. The engine's concurrency is bounded by
    // max_concurrent_agents, and each run holds a connection only for short
    // status writes — a large pool would just crowd out other clients.
    this.sql = new SQL({ url: databaseUrl, max: opts.maxConnections ?? 10 });
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  // ── migrations ────────────────────────────────────────────────────────────

  /**
   * Apply the engine's migrations.
   *
   * Delegates to the shared runner rather than looping here: the database is
   * shared with the control plane and hub history, `gaggle nest start` migrates
   * from several processes at once, and the runner holds a transaction-scoped
   * advisory lock across the whole run. The loop this replaced read the applied
   * set outside any lock and died inside `CREATE TABLE` when two processes
   * raced a virgin database.
   */
  async migrate(): Promise<void> {
    await applyMigrations(this.sql as never, MIGRATIONS);
    logger.debug('Engine schema up to date', { version: LATEST_VERSION });
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async createRun(input: CreateRunInput): Promise<RunRow> {
    const rows = (await this.sql`
      INSERT INTO workflow_runs (
        id, workflow_name, workflow_source, workflow_hash, user_message, status,
        repo_slug, working_path, base_branch, branch, artifacts_dir,
        external_key, env, metadata, dry_run, last_activity_at
      ) VALUES (
        ${input.id}, ${input.workflow_name}, ${input.workflow_source}, ${input.workflow_hash},
        ${input.user_message}, 'pending',
        ${input.repo_slug ?? null}, ${input.working_path ?? null}, ${input.base_branch ?? null},
        ${input.branch ?? null}, ${input.artifacts_dir ?? null},
        ${input.external_key ?? null},
        ${input.env ?? {}},
        ${input.metadata ?? {}},
        ${input.dry_run ?? false}, now()
      ) RETURNING *`) as Row[];
    return mapRun(rows[0]!);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const rows = (await this.sql`SELECT * FROM workflow_runs WHERE id = ${id}`) as Row[];
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async listRuns(query: RunQuery = {}): Promise<RunRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.status?.length) {
      // Expanded to individual placeholders rather than `= ANY($1)`: Bun's
      // driver serializes a JS array as a bare comma-joined string, which
      // Postgres rejects as a malformed array literal.
      const marks = query.status.map((s) => {
        params.push(s);
        return `$${params.length}`;
      });
      clauses.push(`status IN (${marks.join(', ')})`);
    }
    if (query.repo_slug) {
      params.push(query.repo_slug);
      clauses.push(`repo_slug = $${params.length}`);
    }
    if (query.working_path_contains) {
      params.push(`%${query.working_path_contains}%`);
      clauses.push(`working_path ILIKE $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = query.limit && query.limit > 0 ? ` LIMIT ${Math.trunc(query.limit)}` : '';
    const rows = (await this.sql.unsafe(
      `SELECT * FROM workflow_runs ${where} ORDER BY started_at DESC${limit}`,
      params,
    )) as Row[];
    return rows.map(mapRun);
  }

  async updateRun(
    id: string,
    patch: Parameters<Store['updateRun']>[1],
  ): Promise<RunRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (patch.status !== undefined) set('status', patch.status);
    if (patch.working_path !== undefined) set('working_path', patch.working_path);
    if (patch.branch !== undefined) set('branch', patch.branch);
    if (patch.base_branch !== undefined) set('base_branch', patch.base_branch);
    if (patch.artifacts_dir !== undefined) set('artifacts_dir', patch.artifacts_dir);
    if (patch.completed_at !== undefined) set('completed_at', patch.completed_at);
    if (patch.last_activity_at !== undefined) set('last_activity_at', patch.last_activity_at);

    if (sets.length === 0 && patch.metadata === undefined) return this.getRun(id);

    // The metadata merge is a separate tagged-template statement rather than
    // another `$n::jsonb` in the dynamic SET list: Bun's `unsafe()` mangles a
    // cast applied to a placeholder, silently yielding '{}' instead of the
    // merged object. Both statements run in one transaction so the patch stays
    // atomic.
    return this.sql.begin(async (tx: SQL) => {
      if (sets.length > 0) {
        await tx.unsafe(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = $1`, params);
      }
      if (patch.metadata !== undefined) {
        // Shallow merge, so a writer touching `approval` doesn't drop `cancel_reason`.
        await tx`
          UPDATE workflow_runs
             SET metadata = metadata || ${patch.metadata}
           WHERE id = ${id}`;
      }
      const rows = (await tx`SELECT * FROM workflow_runs WHERE id = ${id}`) as Row[];
      return rows[0] ? mapRun(rows[0]) : null;
    }) as Promise<RunRow | null>;
  }

  async touchRun(id: string): Promise<void> {
    await this.sql`UPDATE workflow_runs SET last_activity_at = now() WHERE id = ${id}`;
  }

  // ── leases ────────────────────────────────────────────────────────────────

  async acquireLease(id: string, owner: string, ttlMs: number): Promise<boolean> {
    const secs = Math.max(1, Math.ceil(ttlMs / 1000));
    // Claim only if unowned, already ours, or the previous holder's lease lapsed.
    const rows = (await this.sql`
      UPDATE workflow_runs
         SET lease_owner = ${owner},
             lease_expires_at = now() + make_interval(secs => ${secs})
       WHERE id = ${id}
         AND (lease_owner IS NULL OR lease_owner = ${owner}
              OR lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING id`) as Row[];
    return rows.length > 0;
  }

  async renewLease(id: string, owner: string, ttlMs: number): Promise<void> {
    const secs = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.sql`
      UPDATE workflow_runs
         SET lease_expires_at = now() + make_interval(secs => ${secs})
       WHERE id = ${id} AND lease_owner = ${owner}`;
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    await this.sql`
      UPDATE workflow_runs SET lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ${id} AND lease_owner = ${owner}`;
  }

  async findExpiredRuns(): Promise<RunRow[]> {
    const rows = (await this.sql`
      SELECT * FROM workflow_runs
       WHERE status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
       ORDER BY started_at ASC`) as Row[];
    return rows.map(mapRun);
  }

  // ── nodes ─────────────────────────────────────────────────────────────────

  /**
   * Bind a value for a jsonb column.
   *
   * The driver sends numbers and booleans with their native Postgres type,
   * and there is no implicit cast from those to jsonb — a node whose output
   * parsed to `42` failed the whole write. `${text}::jsonb` is not the fix:
   * the driver stores the text as a JSON *string* instead of parsing it.
   * `to_jsonb` over the native type is. Objects, arrays, strings and null
   * already bind correctly and are passed straight through.
   */
  private jsonb(value: unknown) {
    return typeof value === 'number' || typeof value === 'boolean'
      ? this.sql`to_jsonb(${value})`
      : this.sql`${value ?? null}`;
  }

  async upsertNode(input: UpsertNodeInput): Promise<NodeRow> {
    const rows = (await this.sql`
      INSERT INTO workflow_run_nodes (
        run_id, node_id, node_type, status, attempt, output, output_json, error,
        claude_session_id, side_effects, input_tokens, output_tokens, started_at, completed_at
      ) VALUES (
        ${input.run_id}, ${input.node_id}, ${input.node_type}, ${input.status},
        COALESCE(${input.attempt ?? null}::int, 0), ${input.output ?? null},
        ${this.jsonb(input.output_json ?? null)},
        ${input.error ?? null}, ${input.claude_session_id ?? null},
        COALESCE(${input.side_effects ?? null}::text, 'idempotent'),
        COALESCE(${input.input_tokens ?? null}::int, 0),
        COALESCE(${input.output_tokens ?? null}::int, 0),
        ${input.started_at ?? null}, ${input.completed_at ?? null}
      )
      ON CONFLICT (run_id, node_id) DO UPDATE SET
        node_type         = excluded.node_type,
        status            = excluded.status,
        -- Matching MemoryStore: a bare status write must not reset the
        -- attempt counter a retry already advanced. excluded.attempt cannot be
        -- used here because the INSERT already defaulted it to 0.
        attempt           = COALESCE(${input.attempt ?? null}::int, workflow_run_nodes.attempt),
        output            = COALESCE(excluded.output, workflow_run_nodes.output),
        output_json       = COALESCE(excluded.output_json, workflow_run_nodes.output_json),
        error             = excluded.error,
        claude_session_id = COALESCE(excluded.claude_session_id, workflow_run_nodes.claude_session_id),
        -- As with attempt: a bare status write carries no side_effects and no
        -- token counts, and excluded.* has already been defaulted, so these
        -- have to read the caller's value directly. Downgrading side_effects
        -- to 'idempotent' here would quietly remove an at_most_once marker.
        side_effects      = COALESCE(${input.side_effects ?? null}::text, workflow_run_nodes.side_effects),
        input_tokens      = COALESCE(${input.input_tokens ?? null}::int, workflow_run_nodes.input_tokens),
        output_tokens     = COALESCE(${input.output_tokens ?? null}::int, workflow_run_nodes.output_tokens),
        started_at        = COALESCE(workflow_run_nodes.started_at, excluded.started_at),
        completed_at      = excluded.completed_at
      RETURNING *`) as Row[];
    return mapNode(rows[0]!);
  }

  async getNodes(runId: string): Promise<NodeRow[]> {
    const rows = (await this.sql`
      SELECT * FROM workflow_run_nodes WHERE run_id = ${runId} ORDER BY node_id`) as Row[];
    return rows.map(mapNode);
  }

  async getNode(runId: string, nodeId: string): Promise<NodeRow | null> {
    const rows = (await this.sql`
      SELECT * FROM workflow_run_nodes WHERE run_id = ${runId} AND node_id = ${nodeId}`) as Row[];
    return rows[0] ? mapNode(rows[0]) : null;
  }

  async markRunningNodesInterrupted(runId: string): Promise<NodeRow[]> {
    const rows = (await this.sql`
      UPDATE workflow_run_nodes SET status = 'interrupted'
       WHERE run_id = ${runId} AND status = 'running'
      RETURNING *`) as Row[];
    return rows.map(mapNode);
  }

  // ── loop iterations ───────────────────────────────────────────────────────

  async appendLoopIteration(row: Omit<LoopIterationRow, 'created_at'>): Promise<void> {
    await this.sql`
      INSERT INTO workflow_run_loop_iterations (run_id, node_id, iteration, output, user_input, completed)
      VALUES (${row.run_id}, ${row.node_id}, ${row.iteration}, ${row.output},
              ${row.user_input}, ${row.completed})
      ON CONFLICT (run_id, node_id, iteration) DO UPDATE SET
        output = excluded.output, user_input = excluded.user_input, completed = excluded.completed`;
  }

  async getLoopIterations(runId: string, nodeId: string): Promise<LoopIterationRow[]> {
    const rows = (await this.sql`
      SELECT * FROM workflow_run_loop_iterations
       WHERE run_id = ${runId} AND node_id = ${nodeId} ORDER BY iteration`) as Row[];
    return rows.map((r) => ({
      run_id: String(r.run_id),
      node_id: String(r.node_id),
      iteration: Number(r.iteration),
      output: (r.output as string) ?? null,
      user_input: (r.user_input as string) ?? null,
      completed: Boolean(r.completed),
      created_at: isoRequired(r.created_at),
    }));
  }

  // ── events ────────────────────────────────────────────────────────────────

  async appendEvent(
    runId: string,
    eventType: string,
    nodeId: string | null,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.sql`
      INSERT INTO workflow_run_events (run_id, event_type, node_id, data)
      VALUES (${runId}, ${eventType}, ${nodeId}, ${data})`;
  }

  async listEvents(runId: string, sinceId = 0): Promise<EventRow[]> {
    const rows = (await this.sql`
      SELECT * FROM workflow_run_events
       WHERE run_id = ${runId} AND id > ${sinceId} ORDER BY id`) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      run_id: String(r.run_id),
      event_type: String(r.event_type),
      node_id: (r.node_id as string) ?? null,
      data: asRecord(r.data),
      created_at: isoRequired(r.created_at),
    }));
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  async createApproval(input: {
    id: string;
    run_id: string;
    node_id: string;
    message: string;
  }): Promise<ApprovalRow> {
    const rows = (await this.sql`
      INSERT INTO workflow_approvals (id, run_id, node_id, message)
      VALUES (${input.id}, ${input.run_id}, ${input.node_id}, ${input.message})
      RETURNING *`) as Row[];
    return mapApproval(rows[0]!);
  }

  async getPendingApproval(runId: string): Promise<ApprovalRow | null> {
    const rows = (await this.sql`
      SELECT * FROM workflow_approvals
       WHERE run_id = ${runId} AND decision IS NULL
       ORDER BY created_at DESC LIMIT 1`) as Row[];
    return rows[0] ? mapApproval(rows[0]) : null;
  }

  async updateApprovalMessage(id: string, message: string): Promise<void> {
    await this.sql`UPDATE workflow_approvals SET message = ${message} WHERE id = ${id}`;
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ApprovalRow | null> {
    const rows = (await this.sql`
      UPDATE workflow_approvals
         SET decision = ${decision}, comment = ${comment}, decided_at = now()
       WHERE id = ${id} AND decision IS NULL
      RETURNING *`) as Row[];
    return rows[0] ? mapApproval(rows[0]) : null;
  }

  async incrementReworkAttempts(id: string): Promise<number> {
    const rows = (await this.sql`
      UPDATE workflow_approvals SET rework_attempts = rework_attempts + 1
       WHERE id = ${id} RETURNING rework_attempts`) as Row[];
    return Number(rows[0]?.rework_attempts ?? 0);
  }

  // -- run lookup by caller identity ----------------------------------------

  async findRunByExternalKey(externalKey: string): Promise<RunRow | null> {
    const rows = (await this.sql`
      SELECT * FROM workflow_runs WHERE external_key = ${externalKey}
       ORDER BY started_at DESC LIMIT 1`) as Row[];
    return rows[0] ? mapRun(rows[0]) : null;
  }

  // -- retry schedule --------------------------------------------------------

  // -- analysis cache --------------------------------------------------------

  async saveAnalysis(issueId: string, analysis: unknown): Promise<void> {
    await this.sql`
      INSERT INTO issue_analyses (issue_id, analysis, saved_at)
      VALUES (${issueId}, ${analysis as never}, now())
      ON CONFLICT (issue_id) DO UPDATE SET
        analysis = excluded.analysis, saved_at = now()`;
  }

  async getAnalysis(issueId: string): Promise<unknown | null> {
    const rows = (await this.sql`
      SELECT analysis FROM issue_analyses WHERE issue_id = ${issueId}`) as Row[];
    return rows[0] ? parseJson(rows[0].analysis) : null;
  }

  async deleteAnalysis(issueId: string): Promise<void> {
    await this.sql`DELETE FROM issue_analyses WHERE issue_id = ${issueId}`;
  }

  // -- scaffold jobs ---------------------------------------------------------

  async upsertScaffoldJob(row: ScaffoldJobRow): Promise<void> {
    await this.sql`
      INSERT INTO scaffold_jobs
        (slug, url, checkout_path, run_id, workflow_name, branch, started_at,
         last_polled_at, last_status, pr_url, last_error)
      VALUES (${row.slug}, ${row.url}, ${row.checkout_path}, ${row.run_id},
              ${row.workflow_name}, ${row.branch}, ${row.started_at},
              ${row.last_polled_at}, ${row.last_status}, ${row.pr_url}, ${row.last_error})
      ON CONFLICT (slug) DO UPDATE SET
        url = excluded.url, checkout_path = excluded.checkout_path,
        run_id = excluded.run_id, workflow_name = excluded.workflow_name,
        branch = excluded.branch, started_at = excluded.started_at,
        last_polled_at = excluded.last_polled_at, last_status = excluded.last_status,
        pr_url = excluded.pr_url, last_error = excluded.last_error`;
  }

  async listScaffoldJobs(): Promise<ScaffoldJobRow[]> {
    const rows = (await this.sql`SELECT * FROM scaffold_jobs ORDER BY started_at`) as Row[];
    return rows.map(mapScaffold);
  }

  async deleteScaffoldJob(slug: string): Promise<void> {
    await this.sql`DELETE FROM scaffold_jobs WHERE slug = ${slug}`;
  }

  // -- synced registry -------------------------------------------------------

  async replaceSyncedRegistry(syncedAt: string, repos: SyncedRepoRow[]): Promise<void> {
    // One transaction: a reader must never observe a half-written registry.
    await this.sql.begin(async (tx: SQL) => {
      await tx`DELETE FROM synced_repos`;
      for (const r of repos) {
        await tx`
          INSERT INTO synced_repos
            (url, slug, default_branch, local_path, last_synced_at,
             last_commit_sha, sync_status, sync_error, frontmatter, narrative)
          VALUES (${r.url}, ${r.slug}, ${r.default_branch}, ${r.local_path},
                  ${r.last_synced_at}, ${r.last_commit_sha}, ${r.sync_status},
                  ${r.sync_error}, ${(r.frontmatter ?? null) as never}, ${r.narrative})`;
      }
      await tx`
        INSERT INTO registry_meta (only_row, synced_at) VALUES (true, ${syncedAt})
        ON CONFLICT (only_row) DO UPDATE SET synced_at = excluded.synced_at`;
    });
  }

  async loadSyncedRegistry(): Promise<{ synced_at: string; repositories: SyncedRepoRow[] } | null> {
    const meta = (await this.sql`SELECT synced_at FROM registry_meta`) as Row[];
    if (!meta[0]) return null;
    const rows = (await this.sql`SELECT * FROM synced_repos ORDER BY slug`) as Row[];
    return { synced_at: isoRequired(meta[0].synced_at), repositories: rows.map(mapSyncedRepo) };
  }

  async registrySyncedAt(): Promise<string | null> {
    const rows = (await this.sql`SELECT synced_at FROM registry_meta`) as Row[];
    return rows[0] ? isoRequired(rows[0].synced_at) : null;
  }

  // ── worktrees ─────────────────────────────────────────────────────────────

  async upsertWorktree(
    row: Omit<WorktreeRow, 'created_at' | 'last_activity_at'>,
  ): Promise<WorktreeRow> {
    const rows = (await this.sql`
      INSERT INTO worktrees (id, repo_slug, branch, path, base_branch, run_id)
      VALUES (${row.id}, ${row.repo_slug}, ${row.branch}, ${row.path},
              ${row.base_branch}, ${row.run_id})
      ON CONFLICT (repo_slug, branch) DO UPDATE SET
        path = excluded.path,
        base_branch = excluded.base_branch,
        run_id = excluded.run_id,
        last_activity_at = now()
      RETURNING *`) as Row[];
    return mapWorktree(rows[0]!);
  }

  async listWorktrees(repoSlug?: string): Promise<WorktreeRow[]> {
    const rows = repoSlug
      ? ((await this.sql`
          SELECT * FROM worktrees WHERE repo_slug = ${repoSlug}
           ORDER BY last_activity_at DESC`) as Row[])
      : ((await this.sql`SELECT * FROM worktrees ORDER BY last_activity_at DESC`) as Row[]);
    return rows.map(mapWorktree);
  }

  async getWorktree(repoSlug: string, branch: string): Promise<WorktreeRow | null> {
    const rows = (await this.sql`
      SELECT * FROM worktrees WHERE repo_slug = ${repoSlug} AND branch = ${branch}`) as Row[];
    return rows[0] ? mapWorktree(rows[0]) : null;
  }

  async touchWorktree(repoSlug: string, branch: string): Promise<void> {
    await this.sql`
      UPDATE worktrees SET last_activity_at = now()
       WHERE repo_slug = ${repoSlug} AND branch = ${branch}`;
  }

  async deleteWorktree(repoSlug: string, branch: string): Promise<void> {
    await this.sql`DELETE FROM worktrees WHERE repo_slug = ${repoSlug} AND branch = ${branch}`;
  }
}
