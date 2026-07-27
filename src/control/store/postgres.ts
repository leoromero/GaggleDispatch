/**
 * Postgres-backed control store, on Bun's native SQL driver.
 *
 * Two things carry real weight here and are worth reading before editing:
 *
 *   - **`upsertTicket` cannot write `status`.** That is not an oversight, it is
 *     the invariant that makes the tracker safe as an import source: a sync pass
 *     can refresh a title all it likes and can never move work backwards. Status
 *     changes go through `updateTicket`, which is only reachable from a
 *     transition.
 *   - **`claim*` methods are `FOR UPDATE SKIP LOCKED` in one statement.** That is
 *     what makes two daemons pointed at one database safe, and what makes a
 *     double-clicked dashboard button dispatch once.
 *
 * Every method takes its `Sql` handle from `this.sql`, which is either the pool
 * or a transaction handle — so a repository method is written once and works in
 * both contexts. See {@link PostgresControlStore.tx}.
 */

import { randomUUID } from 'node:crypto';
import {
  bool,
  csvParam,
  int,
  iso,
  isoRequired,
  jsonArray,
  jsonObject,
  nullableInt,
  oneOf,
  oneOfOrNull,
  openSql,
  patchObject,
  text,
  textRequired,
  type Row,
  type Sql,
} from '../../store/sql.ts';
import { applyMigrations } from '../../store/migrate.ts';
import { CONTROL_MIGRATIONS } from './migrations.ts';
import {
  TARGET_LIVE_STATUSES,
  TARGET_STATUSES,
  TICKET_STATUSES,
  GATE_DECISIONS,
  type Complexity,
  type GateDecision,
  type ControlEventRow,
  type EventActor,
  type GateView,
  type OutboxOp,
  type OutboxRow,
  type ScaffoldJobRow,
  type TargetRow,
  type TargetStatus,
  type TicketRow,
  type TicketWithTargets,
} from '../types.ts';
import type {
  AppendEventInput,
  ControlStore,
  EnqueueOutboxInput,
  TargetPatch,
  TargetSpec,
  TicketPatch,
  TicketQuery,
  UpsertTicketInput,
} from './types.ts';
import type { BlockerRef } from '../../domain/types.ts';

const OUTBOX_OPS: readonly OutboxOp[] = ['set_state', 'post_comment', 'apply_label', 'remove_label'];
const ACTORS: readonly EventActor[] = ['operator', 'daemon', 'sync'];
const COMPLEXITIES: readonly Complexity[] = ['simple', 'complex'];

// ─── row mapping ────────────────────────────────────────────────────────────

function mapTicket(r: Row): TicketRow {
  return {
    id: String(r.id),
    workspace: textRequired(r.workspace),
    tracker_kind: textRequired(r.tracker_kind, 'linear'),
    external_id: textRequired(r.external_id),
    identifier: textRequired(r.identifier),
    title: textRequired(r.title),
    description: text(r.description),
    priority: nullableInt(r.priority),
    url: text(r.url),
    branch_name: text(r.branch_name),
    parent_external_id: text(r.parent_external_id),
    external_state: textRequired(r.external_state),
    external_labels: jsonArray<string>(r.external_labels),
    blocked_by: jsonArray<BlockerRef>(r.blocked_by),
    status: oneOf(r.status, TICKET_STATUSES, 'imported'),
    analysis_summary: text(r.analysis_summary),
    complexity: oneOfOrNull(r.complexity, COMPLEXITIES),
    analysis_error: text(r.analysis_error),
    external_created_at: iso(r.external_created_at),
    external_updated_at: iso(r.external_updated_at),
    first_imported_at: isoRequired(r.first_imported_at),
    last_synced_at: isoRequired(r.last_synced_at),
    last_seen_at: isoRequired(r.last_seen_at),
    external_terminal_at: iso(r.external_terminal_at),
    status_changed_at: isoRequired(r.status_changed_at),
    analyzed_at: iso(r.analyzed_at),
    started_at: iso(r.started_at),
    completed_at: iso(r.completed_at),
  };
}

function mapTarget(r: Row): TargetRow {
  return {
    id: String(r.id),
    ticket_id: String(r.ticket_id),
    repo_alias: textRequired(r.repo_alias),
    repo_url: textRequired(r.repo_url),
    local_path: textRequired(r.local_path),
    workflow: textRequired(r.workflow),
    rationale: text(r.rationale),
    components: jsonArray<string>(r.components),
    depends_on: jsonArray<string>(r.depends_on),
    ready_when: text(r.ready_when),
    status: oneOf(r.status, TARGET_STATUSES, 'blocked'),
    external_target_id: text(r.external_target_id),
    external_target_url: text(r.external_target_url),
    external_target_state: text(r.external_target_state),
    external_target_labels: jsonArray<string>(r.external_target_labels),
    run_id: text(r.run_id),
    attempt: int(r.attempt),
    failure_reason: text(r.failure_reason),
    cancel_requested: bool(r.cancel_requested),
    gate_approval_id: text(r.gate_approval_id),
    gate_message: text(r.gate_message),
    gate_opened_at: iso(r.gate_opened_at),
    gate_rework_attempts: int(r.gate_rework_attempts),
    gate_decision: oneOfOrNull(r.gate_decision, GATE_DECISIONS),
    gate_decision_comment: text(r.gate_decision_comment),
    gate_decision_at: iso(r.gate_decision_at),
    status_changed_at: isoRequired(r.status_changed_at),
    dispatched_at: iso(r.dispatched_at),
    completed_at: iso(r.completed_at),
  };
}

function mapEvent(r: Row): ControlEventRow {
  return {
    id: int(r.id),
    ticket_id: String(r.ticket_id),
    target_id: text(r.target_id),
    event_kind: textRequired(r.event_kind),
    from_status: text(r.from_status),
    to_status: textRequired(r.to_status),
    actor: oneOf(r.actor, ACTORS, 'daemon'),
    detail: jsonObject(r.detail),
    created_at: isoRequired(r.created_at),
  };
}

function mapOutbox(r: Row): OutboxRow {
  return {
    id: int(r.id),
    workspace: textRequired(r.workspace),
    external_id: textRequired(r.external_id),
    op: oneOf(r.op, OUTBOX_OPS, 'post_comment'),
    payload: jsonObject(r.payload),
    attempts: int(r.attempts),
    last_error: text(r.last_error),
    created_at: isoRequired(r.created_at),
    sent_at: iso(r.sent_at),
  };
}

function mapScaffoldJob(r: Row): ScaffoldJobRow {
  return {
    slug: textRequired(r.slug),
    workspace: textRequired(r.workspace),
    url: textRequired(r.url),
    checkout_path: textRequired(r.checkout_path),
    run_id: text(r.run_id),
    workflow_name: textRequired(r.workflow_name),
    branch: textRequired(r.branch),
    started_at: isoRequired(r.started_at),
    last_polled_at: iso(r.last_polled_at),
    last_status: textRequired(r.last_status, 'pending'),
    pr_url: text(r.pr_url),
    last_error: text(r.last_error),
  };
}

function mapGate(r: Row): GateView {
  return {
    target_id: String(r.target_id),
    ticket_id: String(r.ticket_id),
    workspace: textRequired(r.workspace),
    identifier: textRequired(r.identifier),
    title: textRequired(r.title),
    url: text(r.url),
    repo_alias: textRequired(r.repo_alias),
    run_id: text(r.run_id),
    approval_id: text(r.gate_approval_id),
    gate_message: textRequired(r.gate_message),
    gate_opened_at: isoRequired(r.gate_opened_at),
    rework_attempts: int(r.gate_rework_attempts),
    pending_decision: oneOfOrNull(r.gate_decision, GATE_DECISIONS),
  };
}

// ─── store ──────────────────────────────────────────────────────────────────

export class PostgresControlStore implements ControlStore {
  private readonly sql: Sql;
  /** True when this instance wraps a transaction handle rather than the pool. */
  private readonly inTransaction: boolean;

  constructor(urlOrSql: string | Sql, opts: { maxConnections?: number } = {}) {
    if (typeof urlOrSql === 'string') {
      this.sql = openSql(urlOrSql, opts);
      this.inTransaction = false;
    } else {
      this.sql = urlOrSql;
      this.inTransaction = true;
    }
  }

  async migrate(): Promise<void> {
    await applyMigrations(this.sql, CONTROL_MIGRATIONS);
  }

  async close(): Promise<void> {
    if (this.inTransaction) return;
    await this.sql.close();
  }

  async tx<T>(fn: (t: ControlStore) => Promise<T>): Promise<T> {
    // Already inside one: reuse it rather than opening a nested transaction, so
    // a service method is composable whether or not its caller opened one.
    if (this.inTransaction) return fn(this);
    return (await this.sql.begin(async (handle: Sql) =>
      fn(new PostgresControlStore(handle)),
    )) as T;
  }

  // ── tickets ─────────────────────────────────────────────────────────────

  async upsertTicket(input: UpsertTicketInput): Promise<TicketRow> {
    const rows = (await this.sql`
      INSERT INTO tickets (
        workspace, tracker_kind, external_id, identifier, title, description,
        priority, url, branch_name, parent_external_id, external_state,
        external_labels, blocked_by, external_created_at, external_updated_at
      ) VALUES (
        ${input.workspace}, ${input.tracker_kind ?? 'linear'}, ${input.external_id},
        ${input.identifier}, ${input.title}, ${input.description ?? null},
        ${input.priority ?? null}, ${input.url ?? null}, ${input.branch_name ?? null},
        ${input.parent_external_id ?? null}, ${input.external_state},
        ${input.external_labels ?? []}, ${input.blocked_by ?? []},
        ${input.external_created_at ?? null}, ${input.external_updated_at ?? null}
      )
      ON CONFLICT (workspace, tracker_kind, external_id) DO UPDATE SET
        identifier          = EXCLUDED.identifier,
        title               = EXCLUDED.title,
        description         = EXCLUDED.description,
        priority            = EXCLUDED.priority,
        url                 = EXCLUDED.url,
        branch_name         = EXCLUDED.branch_name,
        parent_external_id  = EXCLUDED.parent_external_id,
        external_state      = EXCLUDED.external_state,
        external_labels     = EXCLUDED.external_labels,
        blocked_by          = EXCLUDED.blocked_by,
        external_created_at = EXCLUDED.external_created_at,
        external_updated_at = EXCLUDED.external_updated_at,
        last_synced_at      = now(),
        last_seen_at        = now()
      RETURNING *`) as Row[];
    return mapTicket(rows[0]!);
  }

  async getTicket(id: string): Promise<TicketRow | null> {
    if (!isUuid(id)) return null;
    const rows = (await this.sql`SELECT * FROM tickets WHERE id = ${id}`) as Row[];
    return rows[0] ? mapTicket(rows[0]) : null;
  }

  async getTicketByExternalId(
    workspace: string,
    trackerKind: string,
    externalId: string,
  ): Promise<TicketRow | null> {
    const rows = (await this.sql`
      SELECT * FROM tickets
       WHERE workspace = ${workspace}
         AND tracker_kind = ${trackerKind}
         AND external_id = ${externalId}`) as Row[];
    return rows[0] ? mapTicket(rows[0]) : null;
  }

  async listTickets(query: TicketQuery = {}): Promise<TicketRow[]> {
    const rows = (await this.sql`
      SELECT * FROM tickets
       WHERE (${query.workspace ?? null}::text IS NULL OR workspace = ${query.workspace ?? null})
         AND (${csvParam(query.status)}::text IS NULL
              OR status = ANY(string_to_array(${csvParam(query.status)}, ',')))
         AND (${query.search ?? null}::text IS NULL
              OR identifier ILIKE ${likeTerm(query.search)}
              OR title ILIKE ${likeTerm(query.search)})
       ORDER BY priority NULLS LAST, external_created_at NULLS LAST, identifier
       LIMIT ${query.limit ?? 500} OFFSET ${query.offset ?? 0}`) as Row[];
    return rows.map(mapTicket);
  }

  async countTicketsByStatus(workspace?: string): Promise<Record<string, number>> {
    const rows = (await this.sql`
      SELECT status, count(*)::int AS n FROM tickets
       WHERE (${workspace ?? null}::text IS NULL OR workspace = ${workspace ?? null})
       GROUP BY status`) as Row[];
    const out: Record<string, number> = {};
    for (const r of rows) out[textRequired(r.status)] = int(r.n);
    return out;
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<TicketRow | null> {
    if (!isUuid(id)) return null;
    const set = patchObject(withStatusStamp(patch), TICKET_PATCH_COLUMNS);
    if (!set) return this.getTicket(id);
    const rows = (await this.sql`
      UPDATE tickets SET ${this.sql(set)} WHERE id = ${id} RETURNING *`) as Row[];
    return rows[0] ? mapTicket(rows[0]) : null;
  }

  async addTicketBlocker(id: string, blocker: BlockerRef): Promise<TicketRow | null> {
    if (!isUuid(id)) return null;
    const rows = (await this.sql`
      UPDATE tickets
         SET blocked_by = blocked_by || ${[blocker]}
       WHERE id = ${id}
         AND NOT (blocked_by @> ${[{ id: blocker.id }]})
      RETURNING *`) as Row[];
    // No row means it was already there — return the current state, not null.
    return rows[0] ? mapTicket(rows[0]) : this.getTicket(id);
  }

  async lockTicket(id: string): Promise<TicketRow | null> {
    if (!isUuid(id)) return null;
    const rows = (await this.sql`SELECT * FROM tickets WHERE id = ${id} FOR UPDATE`) as Row[];
    return rows[0] ? mapTicket(rows[0]) : null;
  }

  async claimTicketsForAnalysis(workspace: string, limit: number): Promise<TicketRow[]> {
    if (limit <= 0) return [];
    const rows = (await this.sql`
      WITH claimed AS (
        SELECT id FROM tickets
         WHERE workspace = ${workspace} AND status = 'analysis_requested'
         ORDER BY priority NULLS LAST, external_created_at NULLS LAST, identifier
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE tickets t SET status = 'analyzing', status_changed_at = now()
        FROM claimed c WHERE t.id = c.id
      RETURNING t.*`) as Row[];
    return rows.map(mapTicket);
  }

  // ── targets ─────────────────────────────────────────────────────────────

  async replaceTargets(ticketId: string, specs: readonly TargetSpec[]): Promise<TargetRow[]> {
    return this.tx(async (tr) => {
      const t = tr as PostgresControlStore;
      await t.sql`DELETE FROM ticket_targets WHERE ticket_id = ${ticketId}`;
      const out: TargetRow[] = [];
      for (const s of specs) {
        const rows = (await t.sql`
          INSERT INTO ticket_targets (
            ticket_id, repo_alias, repo_url, local_path, workflow, rationale,
            components, depends_on, ready_when
          ) VALUES (
            ${ticketId}, ${s.repo_alias}, ${s.repo_url}, ${s.local_path}, ${s.workflow},
            ${s.rationale ?? null}, ${s.components ?? []}, ${s.depends_on ?? []},
            ${s.ready_when ?? null}
          ) RETURNING *`) as Row[];
        out.push(mapTarget(rows[0]!));
      }
      return out;
    });
  }

  async getTarget(id: string): Promise<TargetRow | null> {
    if (!isUuid(id)) return null;
    const rows = (await this.sql`SELECT * FROM ticket_targets WHERE id = ${id}`) as Row[];
    return rows[0] ? mapTarget(rows[0]) : null;
  }

  async listTargets(ticketId: string): Promise<TargetRow[]> {
    if (!isUuid(ticketId)) return [];
    const rows = (await this.sql`
      SELECT * FROM ticket_targets WHERE ticket_id = ${ticketId} ORDER BY repo_alias`) as Row[];
    return rows.map(mapTarget);
  }

  async listTargetsByStatus(
    statuses: readonly TargetStatus[],
    workspace?: string,
  ): Promise<TargetRow[]> {
    if (statuses.length === 0) return [];
    const rows = (await this.sql`
      SELECT tt.* FROM ticket_targets tt
        JOIN tickets k ON k.id = tt.ticket_id
       WHERE tt.status = ANY(string_to_array(${csvParam(statuses)}, ','))
         AND (${workspace ?? null}::text IS NULL OR k.workspace = ${workspace ?? null})
       ORDER BY k.priority NULLS LAST, k.external_created_at NULLS LAST, tt.repo_alias`) as Row[];
    return rows.map(mapTarget);
  }

  async updateTarget(id: string, patch: TargetPatch): Promise<TargetRow | null> {
    if (!isUuid(id)) return null;
    const set = patchObject(withStatusStamp(patch), TARGET_PATCH_COLUMNS);
    if (!set) return this.getTarget(id);
    const rows = (await this.sql`
      UPDATE ticket_targets SET ${this.sql(set)} WHERE id = ${id} RETURNING *`) as Row[];
    return rows[0] ? mapTarget(rows[0]) : null;
  }

  async lockTarget(id: string): Promise<TargetRow | null> {
    if (!isUuid(id)) return null;
    const rows = (await this.sql`SELECT * FROM ticket_targets WHERE id = ${id} FOR UPDATE`) as Row[];
    return rows[0] ? mapTarget(rows[0]) : null;
  }

  async claimReadyTargets(workspace: string, limit: number): Promise<TargetRow[]> {
    if (limit <= 0) return [];
    const rows = (await this.sql`
      WITH claimed AS (
        SELECT tt.id FROM ticket_targets tt
          JOIN tickets k ON k.id = tt.ticket_id
         WHERE k.workspace = ${workspace} AND tt.status = 'ready'
         ORDER BY k.priority NULLS LAST, k.external_created_at NULLS LAST, k.identifier, tt.repo_alias
         FOR UPDATE OF tt SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE ticket_targets tt
         SET status = 'dispatching', status_changed_at = now(), dispatched_at = now()
        FROM claimed c WHERE tt.id = c.id
      RETURNING tt.*`) as Row[];
    // The UPDATE ... FROM loses the CTE's ordering, so restore it by the same key.
    return (await this.orderByDispatchKey(rows.map(mapTarget)));
  }

  async listPendingGates(workspace?: string): Promise<GateView[]> {
    const rows = (await this.sql`
      SELECT tt.id AS target_id, tt.ticket_id, k.workspace, k.identifier, k.title, k.url,
             tt.repo_alias, tt.run_id, tt.gate_approval_id,
             COALESCE(tt.gate_message, '') AS gate_message,
             COALESCE(tt.gate_opened_at, tt.status_changed_at) AS gate_opened_at,
             tt.gate_rework_attempts, tt.gate_decision
        FROM ticket_targets tt
        JOIN tickets k ON k.id = tt.ticket_id
       WHERE tt.status = 'gate_waiting'
         AND (${workspace ?? null}::text IS NULL OR k.workspace = ${workspace ?? null})
       ORDER BY gate_opened_at`) as Row[];
    return rows.map(mapGate);
  }

  async requestGateDecision(
    targetId: string,
    decision: GateDecision,
    comment: string | null,
  ): Promise<TargetRow | null> {
    if (!isUuid(targetId)) return null;
    // The status and null-decision predicates are the race guard: two operators
    // answering the same gate resolve to whichever commits first.
    const rows = (await this.sql`
      UPDATE ticket_targets
         SET gate_decision = ${decision},
             gate_decision_comment = ${comment},
             gate_decision_at = now()
       WHERE id = ${targetId} AND status = 'gate_waiting' AND gate_decision IS NULL
      RETURNING *`) as Row[];
    return rows[0] ? mapTarget(rows[0]) : null;
  }

  async listGateDecisions(workspace?: string): Promise<TargetRow[]> {
    const rows = (await this.sql`
      SELECT tt.* FROM ticket_targets tt
        JOIN tickets k ON k.id = tt.ticket_id
       WHERE tt.gate_decision IS NOT NULL AND tt.status = 'gate_waiting'
         AND (${workspace ?? null}::text IS NULL OR k.workspace = ${workspace ?? null})
       ORDER BY tt.gate_decision_at`) as Row[];
    return rows.map(mapTarget);
  }

  async listCancelRequested(workspace?: string): Promise<TargetRow[]> {
    const rows = (await this.sql`
      SELECT tt.* FROM ticket_targets tt
        JOIN tickets k ON k.id = tt.ticket_id
       WHERE tt.cancel_requested = true
         AND tt.status = ANY(string_to_array(${csvParam(TARGET_LIVE_STATUSES)}, ','))
         AND (${workspace ?? null}::text IS NULL OR k.workspace = ${workspace ?? null})
       ORDER BY tt.repo_alias`) as Row[];
    return rows.map(mapTarget);
  }

  // ── events ──────────────────────────────────────────────────────────────

  async appendEvent(input: AppendEventInput): Promise<void> {
    await this.sql`
      INSERT INTO control_events (ticket_id, target_id, event_kind, from_status, to_status, actor, detail)
      VALUES (${input.ticket_id}, ${input.target_id ?? null}, ${input.event_kind},
              ${input.from_status ?? null}, ${input.to_status}, ${input.actor},
              ${input.detail ?? {}})`;
  }

  async listEvents(ticketId: string, limit = 200): Promise<ControlEventRow[]> {
    if (!isUuid(ticketId)) return [];
    const rows = (await this.sql`
      SELECT * FROM control_events WHERE ticket_id = ${ticketId}
       ORDER BY id DESC LIMIT ${limit}`) as Row[];
    return rows.map(mapEvent);
  }

  async latestEventId(workspace?: string): Promise<number> {
    const rows = (await this.sql`
      SELECT COALESCE(MAX(e.id), 0)::int AS v FROM control_events e
        JOIN tickets k ON k.id = e.ticket_id
       WHERE (${workspace ?? null}::text IS NULL OR k.workspace = ${workspace ?? null})`) as Row[];
    return int(rows[0]?.v);
  }

  // ── outbox ──────────────────────────────────────────────────────────────

  async enqueueOutbox(input: EnqueueOutboxInput): Promise<void> {
    await this.sql`
      INSERT INTO tracker_outbox (workspace, external_id, op, payload)
      VALUES (${input.workspace}, ${input.external_id}, ${input.op}, ${input.payload ?? {}})`;
  }

  async claimOutbox(workspace: string, limit: number): Promise<OutboxRow[]> {
    if (limit <= 0) return [];
    // SKIP LOCKED so two drainers never take the same row. The lock lives for the
    // caller's transaction; `OutboxDrainer` opens one per batch.
    const rows = (await this.sql`
      SELECT * FROM tracker_outbox
       WHERE sent_at IS NULL AND workspace = ${workspace}
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}`) as Row[];
    return rows.map(mapOutbox);
  }

  async markOutboxSent(id: number): Promise<void> {
    await this.sql`UPDATE tracker_outbox SET sent_at = now() WHERE id = ${id}`;
  }

  async markOutboxFailed(id: number, error: string): Promise<void> {
    await this.sql`
      UPDATE tracker_outbox SET attempts = attempts + 1, last_error = ${error} WHERE id = ${id}`;
  }

  async discardExhaustedOutbox(workspace: string, maxAttempts: number): Promise<number> {
    const rows = (await this.sql`
      DELETE FROM tracker_outbox
       WHERE sent_at IS NULL AND workspace = ${workspace} AND attempts >= ${maxAttempts}
      RETURNING id`) as Row[];
    return rows.length;
  }

  // ── scaffold jobs ───────────────────────────────────────────────────────

  async upsertScaffoldJob(job: ScaffoldJobRow): Promise<ScaffoldJobRow> {
    const rows = (await this.sql`
      INSERT INTO scaffold_jobs (
        slug, workspace, url, checkout_path, run_id, workflow_name, branch,
        started_at, last_polled_at, last_status, pr_url, last_error
      ) VALUES (
        ${job.slug}, ${job.workspace}, ${job.url}, ${job.checkout_path},
        ${job.run_id}, ${job.workflow_name}, ${job.branch},
        ${job.started_at}, ${job.last_polled_at}, ${job.last_status},
        ${job.pr_url}, ${job.last_error}
      )
      ON CONFLICT (slug) DO UPDATE SET
        workspace = EXCLUDED.workspace, url = EXCLUDED.url,
        checkout_path = EXCLUDED.checkout_path, run_id = EXCLUDED.run_id,
        workflow_name = EXCLUDED.workflow_name, branch = EXCLUDED.branch,
        last_polled_at = EXCLUDED.last_polled_at, last_status = EXCLUDED.last_status,
        pr_url = EXCLUDED.pr_url, last_error = EXCLUDED.last_error
      RETURNING *`) as Row[];
    return mapScaffoldJob(rows[0]!);
  }

  async listScaffoldJobs(workspace?: string): Promise<ScaffoldJobRow[]> {
    const rows = (await this.sql`
      SELECT * FROM scaffold_jobs
       WHERE (${workspace ?? null}::text IS NULL OR workspace = ${workspace ?? null})
       ORDER BY slug`) as Row[];
    return rows.map(mapScaffoldJob);
  }

  async getScaffoldJob(slug: string): Promise<ScaffoldJobRow | null> {
    const rows = (await this.sql`SELECT * FROM scaffold_jobs WHERE slug = ${slug}`) as Row[];
    return rows[0] ? mapScaffoldJob(rows[0]) : null;
  }

  async deleteScaffoldJob(slug: string): Promise<void> {
    await this.sql`DELETE FROM scaffold_jobs WHERE slug = ${slug}`;
  }

  // ── board ───────────────────────────────────────────────────────────────

  async board(query: TicketQuery = {}): Promise<TicketWithTargets[]> {
    const tickets = await this.listTickets(query);
    if (tickets.length === 0) return [];
    const ids = tickets.map((t) => t.id);
    const rows = (await this.sql`
      SELECT * FROM ticket_targets
       WHERE ticket_id = ANY(string_to_array(${csvParam(ids)}, ',')::uuid[])
       ORDER BY repo_alias`) as Row[];
    const byTicket = new Map<string, TargetRow[]>();
    for (const r of rows) {
      const target = mapTarget(r);
      const list = byTicket.get(target.ticket_id);
      if (list) list.push(target);
      else byTicket.set(target.ticket_id, [target]);
    }
    return tickets.map((ticket) => ({ ticket, targets: byTicket.get(ticket.id) ?? [] }));
  }

  // ── test support ────────────────────────────────────────────────────────

  /**
   * Empty every control-plane table. Test-only: the engine's tables are left
   * alone so the two conformance suites can share one database.
   */
  async truncateAllForTests(): Promise<void> {
    await this.sql.unsafe(
      'TRUNCATE tickets, ticket_targets, control_events, tracker_outbox, scaffold_jobs RESTART IDENTITY CASCADE',
    );
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Re-apply the dispatch ordering that `UPDATE … FROM` discards. */
  private async orderByDispatchKey(targets: TargetRow[]): Promise<TargetRow[]> {
    if (targets.length < 2) return targets;
    const ids = [...new Set(targets.map((t) => t.ticket_id))];
    const rows = (await this.sql`
      SELECT id, priority, external_created_at, identifier FROM tickets
       WHERE id = ANY(string_to_array(${csvParam(ids)}, ',')::uuid[])`) as Row[];
    const key = new Map<string, { p: number; c: number; i: string }>();
    for (const r of rows) {
      key.set(String(r.id), {
        p: nullableInt(r.priority) ?? Number.MAX_SAFE_INTEGER,
        c: Date.parse(iso(r.external_created_at) ?? '') || Number.MAX_SAFE_INTEGER,
        i: textRequired(r.identifier),
      });
    }
    const fallback = { p: Number.MAX_SAFE_INTEGER, c: Number.MAX_SAFE_INTEGER, i: '' };
    return [...targets].sort((a, b) => {
      const ka = key.get(a.ticket_id) ?? fallback;
      const kb = key.get(b.ticket_id) ?? fallback;
      return (
        ka.p - kb.p ||
        ka.c - kb.c ||
        ka.i.localeCompare(kb.i) ||
        a.repo_alias.localeCompare(b.repo_alias)
      );
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

const TICKET_PATCH_COLUMNS = [
  'status',
  'analysis_summary',
  'complexity',
  'analysis_error',
  'external_terminal_at',
  'analyzed_at',
  'started_at',
  'completed_at',
  'status_changed_at',
] as const;

const TARGET_PATCH_COLUMNS = [
  'status',
  'workflow',
  'external_target_id',
  'external_target_url',
  'external_target_state',
  'external_target_labels',
  'run_id',
  'attempt',
  'failure_reason',
  'cancel_requested',
  'gate_approval_id',
  'gate_message',
  'gate_opened_at',
  'gate_rework_attempts',
  'gate_decision',
  'gate_decision_comment',
  'gate_decision_at',
  'dispatched_at',
  'completed_at',
  'status_changed_at',
] as const;

/**
 * Add `status_changed_at` whenever the patch writes a status.
 *
 * Stamping is keyed on "the patch names a status", not "the status differs from
 * the stored one" — comparing against the stored value would need either a read
 * first (a race outside a transaction) or a raw SQL expression in the SET list
 * (which the `sql(obj)` helper cannot express). A self-transition therefore
 * re-stamps, which is the behaviour we want anyway: it records that something
 * happened.
 */
function withStatusStamp<T extends { status?: string }>(
  patch: T,
): T & { status_changed_at?: string } {
  if (patch.status === undefined) return patch;
  return { ...patch, status_changed_at: new Date().toISOString() };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres errors on a malformed uuid literal rather than returning no rows.
 *  Callers pass ids from HTTP, so guard rather than let a 500 escape. */
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function likeTerm(search?: string): string | null {
  return search ? `%${search}%` : null;
}

/** Exported so callers that need a target id before insert can mint one. */
export function newId(): string {
  return randomUUID();
}
