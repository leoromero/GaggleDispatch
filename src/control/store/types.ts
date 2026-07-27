/**
 * Persistence contract for the control plane.
 *
 * Split into narrow role interfaces so each consumer depends only on what it
 * uses: `TicketSync` needs `TicketRepo`, the outbox drainer needs `OutboxRepo`,
 * the board needs the read side. `ControlStore` composes them for the wiring
 * layer that owns the connection.
 *
 * Two implementations, held to one conformance suite:
 *   - `PostgresControlStore` — production.
 *   - `MemoryControlStore` — an in-process double so the transition engine,
 *     sync, and reconciler can be unit-tested without a database. It is not a
 *     stub: it enforces the same uniqueness, locking, and claim semantics the
 *     callers rely on.
 */

import type {
  Complexity,
  ControlEventRow,
  EventActor,
  GateDecision,
  GateView,
  OutboxOp,
  OutboxRow,
  ScaffoldJobRow,
  TargetRow,
  TargetStatus,
  TicketRow,
  TicketStatus,
  TicketWithTargets,
} from '../types.ts';
import type { BlockerRef } from '../../domain/types.ts';

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** The tracker-owned half of a ticket. Sync writes exactly these columns. */
export interface UpsertTicketInput {
  workspace: string;
  tracker_kind?: string;
  external_id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  url?: string | null;
  branch_name?: string | null;
  parent_external_id?: string | null;
  external_state: string;
  external_labels?: string[];
  blocked_by?: BlockerRef[];
  external_created_at?: string | null;
  external_updated_at?: string | null;
}

/** Columns the control plane owns. Sync never touches these. */
export interface TicketPatch {
  status?: TicketStatus;
  analysis_summary?: string | null;
  complexity?: Complexity | null;
  analysis_error?: string | null;
  external_terminal_at?: string | null;
  analyzed_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface TicketQuery {
  workspace?: string;
  status?: TicketStatus[];
  /** Case-insensitive substring match over identifier and title. */
  search?: string;
  limit?: number;
  offset?: number;
}

/** A repo target as the analyzer produced it. */
export interface TargetSpec {
  repo_alias: string;
  repo_url: string;
  local_path: string;
  workflow: string;
  rationale?: string | null;
  components?: string[];
  depends_on?: string[];
  ready_when?: string | null;
}

export interface TargetPatch {
  status?: TargetStatus;
  workflow?: string;
  external_target_id?: string | null;
  external_target_url?: string | null;
  external_target_state?: string | null;
  external_target_labels?: string[];
  run_id?: string | null;
  attempt?: number;
  failure_reason?: string | null;
  cancel_requested?: boolean;
  gate_approval_id?: string | null;
  gate_message?: string | null;
  gate_opened_at?: string | null;
  gate_rework_attempts?: number;
  gate_decision?: GateDecision | null;
  gate_decision_comment?: string | null;
  gate_decision_at?: string | null;
  dispatched_at?: string | null;
  completed_at?: string | null;
}

export interface AppendEventInput {
  ticket_id: string;
  target_id?: string | null;
  event_kind: string;
  from_status?: string | null;
  to_status: string;
  actor: EventActor;
  detail?: Record<string, unknown>;
}

export interface EnqueueOutboxInput {
  workspace: string;
  external_id: string;
  op: OutboxOp;
  payload?: Record<string, unknown>;
}

/** How a drainer marks a batch as its own. See {@link OutboxRepo.claimOutbox}. */
export interface OutboxLease {
  /** Identifies the drainer, for diagnosis. Not used for exclusion. */
  claimed_by: string;
  /**
   * How long the claim holds before another drainer may take the rows.
   *
   * Long enough that a healthy batch finishes inside it, short enough that a
   * crashed drainer's rows do not sit unsendable for long. It has to exceed the
   * worst-case batch — `batch_size` × the HTTP deadline — or a slow batch's rows
   * get taken and sent twice while the first drainer is still working.
   */
  lease_ms: number;
}

/**
 * Default lease window: 50 rows × a 30s HTTP deadline, plus room.
 *
 * Derived from those two numbers rather than picked, because the relationship is
 * the part that matters — see {@link OutboxLease.lease_ms}.
 */
export const DEFAULT_OUTBOX_LEASE_MS = 30 * 60 * 1000;

// ─── Role interfaces ────────────────────────────────────────────────────────

export interface TicketRepo {
  /**
   * Insert or refresh the tracker-owned columns. Deliberately cannot write
   * `status` — a sync pass must never be able to move work backwards. Status
   * changes go through {@link TicketRepo.updateTicket}, which is only reachable
   * from a transition.
   */
  upsertTicket(input: UpsertTicketInput): Promise<TicketRow>;
  getTicket(id: string): Promise<TicketRow | null>;
  getTicketByExternalId(
    workspace: string,
    trackerKind: string,
    externalId: string,
  ): Promise<TicketRow | null>;
  listTickets(query?: TicketQuery): Promise<TicketRow[]>;
  countTicketsByStatus(workspace?: string): Promise<Record<string, number>>;
  updateTicket(id: string, patch: TicketPatch): Promise<TicketRow | null>;
  /**
   * Add a blocker to `blocked_by` without waiting for a sync pass.
   *
   * Used when we create a blocker issue ourselves: the readiness sweep runs later
   * in the same tick, so a target the operator just declared blocked would
   * otherwise be promoted straight back to `ready`. Sync re-derives the same list
   * from the tracker afterwards, so this is an optimistic write that self-heals.
   * Idempotent on the blocker's id.
   */
  addTicketBlocker(id: string, blocker: BlockerRef): Promise<TicketRow | null>;
  /** `SELECT … FOR UPDATE`. Only meaningful inside a transaction. */
  lockTicket(id: string): Promise<TicketRow | null>;
  /**
   * Claim tickets awaiting analysis for this process, moving them to
   * `analyzing` atomically. `FOR UPDATE SKIP LOCKED`, so two daemons pointed at
   * one database never analyze the same ticket twice.
   */
  claimTicketsForAnalysis(workspace: string, limit: number): Promise<TicketRow[]>;
}

export interface TargetRepo {
  /**
   * Replace a ticket's entire fan-out. Used by analysis and re-analysis; the
   * caller is responsible for refusing when a target is live.
   */
  replaceTargets(ticketId: string, specs: readonly TargetSpec[]): Promise<TargetRow[]>;
  getTarget(id: string): Promise<TargetRow | null>;
  listTargets(ticketId: string): Promise<TargetRow[]>;
  listTargetsByStatus(statuses: readonly TargetStatus[], workspace?: string): Promise<TargetRow[]>;
  updateTarget(id: string, patch: TargetPatch): Promise<TargetRow | null>;
  lockTarget(id: string): Promise<TargetRow | null>;
  /**
   * Claim up to `limit` dispatchable targets, moving them to `dispatching`
   * atomically. Ordered by ticket priority then age, reproducing the current
   * dispatch ordering as a SQL clause. `FOR UPDATE SKIP LOCKED`.
   */
  claimReadyTargets(workspace: string, limit: number): Promise<TargetRow[]>;
  /** Open gates, denormalized for the dashboard. */
  listPendingGates(workspace?: string): Promise<GateView[]>;
  /** Targets whose cancellation an operator requested but a daemon has not confirmed. */
  listCancelRequested(workspace?: string): Promise<TargetRow[]>;
  /**
   * Record an operator's answer to an open gate.
   *
   * Conditional on the target still being `gate_waiting` with no decision
   * already recorded, so two operators racing on one gate resolve to the first
   * answer rather than the last. Returns null when that precondition fails —
   * the caller turns that into a 409.
   */
  requestGateDecision(
    targetId: string,
    decision: GateDecision,
    comment: string | null,
  ): Promise<TargetRow | null>;
  /** Gates an operator has answered but the daemon has not yet acted on. */
  listGateDecisions(workspace?: string): Promise<TargetRow[]>;
}

export interface EventRepo {
  appendEvent(input: AppendEventInput): Promise<void>;
  listEvents(ticketId: string, limit?: number): Promise<ControlEventRow[]>;
  /** Highest event id in the table. The dashboard polls this to detect change
   *  without re-fetching the board. */
  latestEventId(workspace?: string): Promise<number>;
}

export interface OutboxRepo {
  enqueueOutbox(input: EnqueueOutboxInput): Promise<void>;
  /**
   * Claim unsent rows for sending, oldest first.
   *
   * `workspace` is required, not optional: a drainer sends through *its own*
   * tracker client with its own state names, so draining another workspace's rows
   * would write the wrong thing to the wrong tracker.
   *
   * Exclusion is a **lease**, not a row lock. Both work, but a lock only holds for
   * the claiming transaction, which forced the drainer to keep that transaction
   * open across every network call in the batch — a pooled connection and N rows
   * locked for as long as a degraded tracker took to answer. A lease is written and
   * committed immediately, so sending happens outside any transaction, and a
   * drainer that crashes mid-batch releases its rows when the lease expires
   * instead of holding them until someone notices.
   */
  claimOutbox(workspace: string, limit: number, lease?: OutboxLease): Promise<OutboxRow[]>;
  markOutboxSent(id: number): Promise<void>;
  /** Records the failure and bumps `attempts`. */
  markOutboxFailed(id: number, error: string): Promise<void>;
  /** Drops this workspace's rows that exceeded the attempt ceiling. Returns how many. */
  discardExhaustedOutbox(workspace: string, maxAttempts: number): Promise<number>;
}

export interface ScaffoldJobRepo {
  upsertScaffoldJob(job: ScaffoldJobRow): Promise<ScaffoldJobRow>;
  listScaffoldJobs(workspace?: string): Promise<ScaffoldJobRow[]>;
  getScaffoldJob(slug: string): Promise<ScaffoldJobRow | null>;
  deleteScaffoldJob(slug: string): Promise<void>;
}

export interface BoardRepo {
  /** Tickets with their fan-out, in one round trip. */
  board(query?: TicketQuery): Promise<TicketWithTargets[]>;
}

// ─── Composed store ─────────────────────────────────────────────────────────

export interface ControlStore
  extends TicketRepo,
    TargetRepo,
    EventRepo,
    OutboxRepo,
    ScaffoldJobRepo,
    BoardRepo {
  /** Apply pending control-plane migrations. Safe to call repeatedly. */
  migrate(): Promise<void>;
  close(): Promise<void>;
  /**
   * Run `fn` inside a transaction. The store handed to `fn` is bound to it, so
   * `lockTicket` / `lockTarget` actually hold their locks for the duration.
   * Rolls back if `fn` throws.
   */
  tx<T>(fn: (t: ControlStore) => Promise<T>): Promise<T>;
}
