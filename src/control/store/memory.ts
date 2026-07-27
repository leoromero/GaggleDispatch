/**
 * In-process ControlStore, for tests.
 *
 * Not a stub. It enforces the semantics callers actually depend on — upsert
 * identity, the "sync cannot write status" invariant, exclusive claiming,
 * dispatch ordering, transaction rollback — so the transition engine, sync, and
 * reconciler can be tested exhaustively without a database, and the shared
 * conformance suite holds both implementations to the same contract.
 *
 * Deliberate simplifications, none of which the callers can observe:
 *   - `tx` snapshots and restores on throw rather than using real MVCC. Single
 *     threaded, so that is equivalent for our purposes.
 *   - `lock*` is a plain read. Exclusivity in the claim methods comes from the
 *     status write, which is the same thing that makes it true in Postgres.
 */

import { randomUUID } from 'node:crypto';
import type { BlockerRef } from '../../domain/types.ts';
import {
  TARGET_LIVE_STATUSES,
  type ControlEventRow,
  type GateDecision,
  type GateView,
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
  OutboxLease,
  TargetPatch,
  TargetSpec,
  TicketPatch,
  TicketQuery,
  UpsertTicketInput,
} from './types.ts';

interface Tables {
  tickets: Map<string, TicketRow>;
  targets: Map<string, TargetRow>;
  events: ControlEventRow[];
  outbox: OutboxRow[];
  scaffoldJobs: Map<string, ScaffoldJobRow>;
  nextEventId: number;
  nextOutboxId: number;
}

function emptyTables(): Tables {
  return {
    tickets: new Map(),
    targets: new Map(),
    events: [],
    outbox: [],
    scaffoldJobs: new Map(),
    nextEventId: 1,
    nextOutboxId: 1,
  };
}

/**
 * The wall clock, and deliberately nothing cleverer.
 *
 * An earlier version added a growing offset so two writes in the same
 * millisecond would order strictly. That put every timestamp in the *future*, so
 * code asking "how long ago did this change?" got a negative answer and every age
 * guard silently inverted — the gate re-open window and the stranded-claim window
 * both stopped working, and the tests that should have caught it were the ones
 * being fooled.
 *
 * Ordering that genuinely needs to be strict is enforced by the tests that care,
 * which sleep between writes exactly as they do against Postgres.
 */
function now(): string {
  return new Date().toISOString();
}

export class MemoryControlStore implements ControlStore {
  private t: Tables;
  private readonly inTransaction: boolean;

  constructor(tables?: Tables, inTransaction = false) {
    this.t = tables ?? emptyTables();
    this.inTransaction = inTransaction;
  }

  async migrate(): Promise<void> {
    /* schema is implicit */
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  async tx<T>(fn: (t: ControlStore) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const snapshot = this.snapshot();
    try {
      return await fn(new MemoryControlStore(this.t, true));
    } catch (err) {
      this.t = snapshot;
      throw err;
    }
  }

  private snapshot(): Tables {
    return {
      tickets: new Map([...this.t.tickets].map(([k, v]) => [k, { ...v }])),
      targets: new Map([...this.t.targets].map(([k, v]) => [k, { ...v }])),
      events: this.t.events.map((e) => ({ ...e })),
      outbox: this.t.outbox.map((o) => ({ ...o })),
      scaffoldJobs: new Map([...this.t.scaffoldJobs].map(([k, v]) => [k, { ...v }])),
      nextEventId: this.t.nextEventId,
      nextOutboxId: this.t.nextOutboxId,
    };
  }

  // ── tickets ─────────────────────────────────────────────────────────────

  async upsertTicket(input: UpsertTicketInput): Promise<TicketRow> {
    const trackerKind = input.tracker_kind ?? 'linear';
    const existing = [...this.t.tickets.values()].find(
      (t) =>
        t.workspace === input.workspace &&
        t.tracker_kind === trackerKind &&
        t.external_id === input.external_id,
    );

    const trackerOwned = {
      identifier: input.identifier,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? null,
      url: input.url ?? null,
      branch_name: input.branch_name ?? null,
      parent_external_id: input.parent_external_id ?? null,
      external_state: input.external_state,
      external_labels: [...(input.external_labels ?? [])],
      blocked_by: (input.blocked_by ?? []).map((b) => ({ ...b })),
      external_created_at: input.external_created_at ?? null,
      external_updated_at: input.external_updated_at ?? null,
    };

    if (existing) {
      // Note what is absent: `status` and every control-plane column. A sync
      // pass must never be able to move work backwards.
      const stamp = now();
      const updated: TicketRow = {
        ...existing,
        ...trackerOwned,
        last_synced_at: stamp,
        last_seen_at: stamp,
      };
      this.t.tickets.set(updated.id, updated);
      return { ...updated };
    }

    const stamp = now();
    const row: TicketRow = {
      id: randomUUID(),
      workspace: input.workspace,
      tracker_kind: trackerKind,
      external_id: input.external_id,
      ...trackerOwned,
      status: 'imported',
      analysis_summary: null,
      complexity: null,
      analysis_error: null,
      first_imported_at: stamp,
      last_synced_at: stamp,
      last_seen_at: stamp,
      external_terminal_at: null,
      status_changed_at: stamp,
      analyzed_at: null,
      started_at: null,
      completed_at: null,
    };
    this.t.tickets.set(row.id, row);
    return { ...row };
  }

  async getTicket(id: string): Promise<TicketRow | null> {
    const row = this.t.tickets.get(id);
    return row ? { ...row } : null;
  }

  async getTicketByExternalId(
    workspace: string,
    trackerKind: string,
    externalId: string,
  ): Promise<TicketRow | null> {
    const row = [...this.t.tickets.values()].find(
      (t) =>
        t.workspace === workspace && t.tracker_kind === trackerKind && t.external_id === externalId,
    );
    return row ? { ...row } : null;
  }

  async listTickets(query: TicketQuery = {}): Promise<TicketRow[]> {
    const term = query.search?.toLowerCase();
    const rows = [...this.t.tickets.values()]
      .filter((t) => (query.workspace ? t.workspace === query.workspace : true))
      .filter((t) => (query.status && query.status.length > 0 ? query.status.includes(t.status) : true))
      .filter((t) =>
        term
          ? t.identifier.toLowerCase().includes(term) || t.title.toLowerCase().includes(term)
          : true,
      )
      .sort(compareTicketsForDispatch);
    const offset = query.offset ?? 0;
    return rows.slice(offset, offset + (query.limit ?? 500)).map((t) => ({ ...t }));
  }

  async countTicketsByStatus(workspace?: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of this.t.tickets.values()) {
      if (workspace && t.workspace !== workspace) continue;
      out[t.status] = (out[t.status] ?? 0) + 1;
    }
    return out;
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<TicketRow | null> {
    const row = this.t.tickets.get(id);
    if (!row) return null;
    const statusChanged = patch.status !== undefined && patch.status !== row.status;
    const updated: TicketRow = {
      ...row,
      ...pick(patch, [
        'status',
        'analysis_summary',
        'complexity',
        'analysis_error',
        'external_terminal_at',
        'analyzed_at',
        'started_at',
        'completed_at',
      ]),
      status_changed_at: statusChanged ? now() : row.status_changed_at,
    };
    this.t.tickets.set(id, updated);
    return { ...updated };
  }

  async addTicketBlocker(id: string, blocker: BlockerRef): Promise<TicketRow | null> {
    const row = this.t.tickets.get(id);
    if (!row) return null;
    if (row.blocked_by.some((b) => b.id === blocker.id)) return { ...row };
    const updated: TicketRow = { ...row, blocked_by: [...row.blocked_by, { ...blocker }] };
    this.t.tickets.set(id, updated);
    return { ...updated };
  }

  async lockTicket(id: string): Promise<TicketRow | null> {
    return this.getTicket(id);
  }

  async claimTicketsForAnalysis(workspace: string, limit: number): Promise<TicketRow[]> {
    if (limit <= 0) return [];
    const candidates = [...this.t.tickets.values()]
      .filter((t) => t.workspace === workspace && t.status === 'analysis_requested')
      .sort(compareTicketsForDispatch)
      .slice(0, limit);
    const claimed: TicketRow[] = [];
    for (const c of candidates) {
      const updated: TicketRow = { ...c, status: 'analyzing', status_changed_at: now() };
      this.t.tickets.set(c.id, updated);
      claimed.push({ ...updated });
    }
    return claimed;
  }

  // ── targets ─────────────────────────────────────────────────────────────

  async replaceTargets(ticketId: string, specs: readonly TargetSpec[]): Promise<TargetRow[]> {
    for (const [id, target] of [...this.t.targets]) {
      if (target.ticket_id !== ticketId) continue;
      this.t.targets.delete(id);
      // Mirrors `ON DELETE SET NULL` on control_events.target_id: the audit trail
      // outlives the fan-out it describes.
      for (const event of this.t.events) {
        if (event.target_id === id) event.target_id = null;
      }
    }
    const out: TargetRow[] = [];
    for (const s of specs) {
      const stamp = now();
      const row: TargetRow = {
        id: randomUUID(),
        ticket_id: ticketId,
        repo_alias: s.repo_alias,
        repo_url: s.repo_url,
        local_path: s.local_path,
        workflow: s.workflow,
        rationale: s.rationale ?? null,
        components: [...(s.components ?? [])],
        depends_on: [...(s.depends_on ?? [])],
        ready_when: s.ready_when ?? null,
        status: 'blocked',
        external_target_id: null,
        external_target_url: null,
        external_target_state: null,
        external_target_labels: [],
        run_id: null,
        attempt: 0,
        failure_reason: null,
        cancel_requested: false,
        gate_approval_id: null,
        gate_message: null,
        gate_opened_at: null,
        gate_rework_attempts: 0,
        gate_decision: null,
        gate_decision_comment: null,
        gate_decision_at: null,
        status_changed_at: stamp,
        dispatched_at: null,
        completed_at: null,
      };
      this.t.targets.set(row.id, row);
      out.push({ ...row });
    }
    return out;
  }

  async getTarget(id: string): Promise<TargetRow | null> {
    const row = this.t.targets.get(id);
    return row ? { ...row } : null;
  }

  async listTargets(ticketId: string): Promise<TargetRow[]> {
    return [...this.t.targets.values()]
      .filter((t) => t.ticket_id === ticketId)
      .sort((a, b) => a.repo_alias.localeCompare(b.repo_alias))
      .map((t) => ({ ...t }));
  }

  async listTargetsByStatus(
    statuses: readonly TargetStatus[],
    workspace?: string,
  ): Promise<TargetRow[]> {
    if (statuses.length === 0) return [];
    return [...this.t.targets.values()]
      .filter((t) => statuses.includes(t.status))
      .filter((t) => (workspace ? this.t.tickets.get(t.ticket_id)?.workspace === workspace : true))
      .sort((a, b) => this.compareTargetsForDispatch(a, b))
      .map((t) => ({ ...t }));
  }

  async updateTarget(id: string, patch: TargetPatch): Promise<TargetRow | null> {
    const row = this.t.targets.get(id);
    if (!row) return null;
    const statusChanged = patch.status !== undefined && patch.status !== row.status;
    const updated: TargetRow = {
      ...row,
      ...pick(patch, [
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
      ]),
      status_changed_at: statusChanged ? now() : row.status_changed_at,
    };
    this.t.targets.set(id, updated);
    return { ...updated };
  }

  async lockTarget(id: string): Promise<TargetRow | null> {
    return this.getTarget(id);
  }

  async claimReadyTargets(workspace: string, limit: number): Promise<TargetRow[]> {
    if (limit <= 0) return [];
    const candidates = [...this.t.targets.values()]
      .filter((t) => t.status === 'ready')
      .filter((t) => this.t.tickets.get(t.ticket_id)?.workspace === workspace)
      .sort((a, b) => this.compareTargetsForDispatch(a, b))
      .slice(0, limit);
    const claimed: TargetRow[] = [];
    for (const c of candidates) {
      const stamp = now();
      const updated: TargetRow = {
        ...c,
        status: 'dispatching',
        status_changed_at: stamp,
        dispatched_at: stamp,
      };
      this.t.targets.set(c.id, updated);
      claimed.push({ ...updated });
    }
    return claimed;
  }

  async listPendingGates(workspace?: string): Promise<GateView[]> {
    return [...this.t.targets.values()]
      .filter((t) => t.status === 'gate_waiting')
      .map((target) => ({ target, ticket: this.t.tickets.get(target.ticket_id) }))
      .filter((x): x is { target: TargetRow; ticket: TicketRow } => x.ticket !== undefined)
      .filter((x) => (workspace ? x.ticket.workspace === workspace : true))
      .map(({ target, ticket }) => ({
        target_id: target.id,
        ticket_id: ticket.id,
        workspace: ticket.workspace,
        identifier: ticket.identifier,
        title: ticket.title,
        url: ticket.url,
        repo_alias: target.repo_alias,
        run_id: target.run_id,
        approval_id: target.gate_approval_id,
        gate_message: target.gate_message ?? '',
        gate_opened_at: target.gate_opened_at ?? target.status_changed_at,
        rework_attempts: target.gate_rework_attempts,
        pending_decision: target.gate_decision,
      }))
      .sort((a, b) => Date.parse(a.gate_opened_at) - Date.parse(b.gate_opened_at));
  }

  async requestGateDecision(
    targetId: string,
    decision: GateDecision,
    comment: string | null,
  ): Promise<TargetRow | null> {
    const row = this.t.targets.get(targetId);
    // Same preconditions as the SQL: still at a gate, not already answered.
    if (!row || row.status !== 'gate_waiting' || row.gate_decision !== null) return null;
    const updated: TargetRow = {
      ...row,
      gate_decision: decision,
      gate_decision_comment: comment,
      gate_decision_at: now(),
    };
    this.t.targets.set(targetId, updated);
    return { ...updated };
  }

  async listGateDecisions(workspace?: string): Promise<TargetRow[]> {
    return [...this.t.targets.values()]
      .filter((t) => t.gate_decision !== null && t.status === 'gate_waiting')
      .filter((t) => (workspace ? this.t.tickets.get(t.ticket_id)?.workspace === workspace : true))
      .sort((a, b) => Date.parse(a.gate_decision_at ?? '') - Date.parse(b.gate_decision_at ?? ''))
      .map((t) => ({ ...t }));
  }

  async listCancelRequested(workspace?: string): Promise<TargetRow[]> {
    return [...this.t.targets.values()]
      .filter((t) => t.cancel_requested && TARGET_LIVE_STATUSES.includes(t.status))
      .filter((t) => (workspace ? this.t.tickets.get(t.ticket_id)?.workspace === workspace : true))
      .sort((a, b) => a.repo_alias.localeCompare(b.repo_alias))
      .map((t) => ({ ...t }));
  }

  // ── events ──────────────────────────────────────────────────────────────

  async appendEvent(input: AppendEventInput): Promise<void> {
    this.t.events.push({
      id: this.t.nextEventId++,
      ticket_id: input.ticket_id,
      target_id: input.target_id ?? null,
      event_kind: input.event_kind,
      from_status: input.from_status ?? null,
      to_status: input.to_status,
      actor: input.actor,
      detail: input.detail ?? {},
      created_at: now(),
    });
  }

  async listEvents(ticketId: string, limit = 200): Promise<ControlEventRow[]> {
    return this.t.events
      .filter((e) => e.ticket_id === ticketId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async latestEventId(workspace?: string): Promise<number> {
    let max = 0;
    for (const e of this.t.events) {
      if (workspace && this.t.tickets.get(e.ticket_id)?.workspace !== workspace) continue;
      if (e.id > max) max = e.id;
    }
    return max;
  }

  // ── outbox ──────────────────────────────────────────────────────────────

  async enqueueOutbox(input: EnqueueOutboxInput): Promise<void> {
    this.t.outbox.push({
      id: this.t.nextOutboxId++,
      workspace: input.workspace,
      external_id: input.external_id,
      op: input.op,
      payload: input.payload ?? {},
      attempts: 0,
      last_error: null,
      created_at: now(),
      sent_at: null,
      claimed_at: null,
      claimed_by: null,
    });
  }

  async claimOutbox(workspace: string, limit: number, lease?: OutboxLease): Promise<OutboxRow[]> {
    if (limit <= 0) return [];
    const cutoff = lease ? Date.parse(now()) - lease.lease_ms : 0;
    const picked = this.t.outbox
      .filter((o) => o.sent_at === null && o.workspace === workspace)
      // A held lease hides the row from other claimers. Without a lease this is a
      // plain read and claims nothing, matching Postgres.
      .filter((o) => !lease || o.claimed_at === null || Date.parse(o.claimed_at) <= cutoff)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    if (lease) {
      const at = now();
      for (const o of picked) {
        o.claimed_at = at;
        o.claimed_by = lease.claimed_by;
      }
    }
    return picked.map((o) => ({ ...o }));
  }

  async markOutboxSent(id: number): Promise<void> {
    const row = this.t.outbox.find((o) => o.id === id);
    if (row) row.sent_at = now();
  }

  async markOutboxFailed(id: number, error: string): Promise<void> {
    const row = this.t.outbox.find((o) => o.id === id);
    if (row) {
      row.attempts += 1;
      row.last_error = error;
      // See the note in postgres.ts: the lease means "in flight", and a recorded
      // failure ends that. Holding it would delay the retry by a whole window.
      row.claimed_at = null;
      row.claimed_by = null;
    }
  }

  async discardExhaustedOutbox(workspace: string, maxAttempts: number): Promise<number> {
    const before = this.t.outbox.length;
    this.t.outbox = this.t.outbox.filter(
      (o) => o.sent_at !== null || o.workspace !== workspace || o.attempts < maxAttempts,
    );
    return before - this.t.outbox.length;
  }

  // ── scaffold jobs ───────────────────────────────────────────────────────

  async upsertScaffoldJob(job: ScaffoldJobRow): Promise<ScaffoldJobRow> {
    const existing = this.t.scaffoldJobs.get(job.slug);
    const row: ScaffoldJobRow = { ...job, started_at: existing?.started_at ?? job.started_at };
    this.t.scaffoldJobs.set(row.slug, row);
    return { ...row };
  }

  async listScaffoldJobs(workspace?: string): Promise<ScaffoldJobRow[]> {
    return [...this.t.scaffoldJobs.values()]
      .filter((j) => (workspace ? j.workspace === workspace : true))
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((j) => ({ ...j }));
  }

  async getScaffoldJob(slug: string): Promise<ScaffoldJobRow | null> {
    const row = this.t.scaffoldJobs.get(slug);
    return row ? { ...row } : null;
  }

  async deleteScaffoldJob(slug: string): Promise<void> {
    this.t.scaffoldJobs.delete(slug);
  }

  // ── board ───────────────────────────────────────────────────────────────

  async board(query: TicketQuery = {}): Promise<TicketWithTargets[]> {
    const tickets = await this.listTickets(query);
    return Promise.all(
      tickets.map(async (ticket) => ({ ticket, targets: await this.listTargets(ticket.id) })),
    );
  }

  // ── internals ───────────────────────────────────────────────────────────

  private compareTargetsForDispatch(a: TargetRow, b: TargetRow): number {
    const ta = this.t.tickets.get(a.ticket_id);
    const tb = this.t.tickets.get(b.ticket_id);
    if (ta && tb) {
      const byTicket = compareTicketsForDispatch(ta, tb);
      if (byTicket !== 0) return byTicket;
    }
    return a.repo_alias.localeCompare(b.repo_alias);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Priority, then age, then identifier — the dispatch ordering, shared by the
 *  board listing and both claim methods so what an operator sees is the order
 *  work actually runs in. */
function compareTicketsForDispatch(a: TicketRow, b: TicketRow): number {
  const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
  const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  const ca = a.external_created_at ? Date.parse(a.external_created_at) : Number.MAX_SAFE_INTEGER;
  const cb = b.external_created_at ? Date.parse(b.external_created_at) : Number.MAX_SAFE_INTEGER;
  if (ca !== cb) return ca - cb;
  return a.identifier.localeCompare(b.identifier);
}

/** Copy only the keys actually present, so `undefined` means "leave alone" and
 *  an explicit `null` means "clear" — matching the SQL patch semantics. */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k];
  }
  return out;
}
