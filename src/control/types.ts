/**
 * Control-plane domain types.
 *
 * These describe the authoritative record of work: a ticket imported from the
 * issue tracker, the repo targets it fans out to, and the audit trail of how
 * each moved. Postgres holds them; the tracker is an import source and a
 * write-only sink.
 *
 * Nothing here imports from `src/executor/` or `src/orchestrator/`. A run is
 * referenced only by opaque `run_id`, so the control plane is independent of
 * which workflow engine is executing — see {@link ExecutorPort} in `ports.ts`.
 */

import type { BlockerRef } from '../domain/types.ts';

// ─── Statuses ───────────────────────────────────────────────────────────────

/**
 * imported            Synced from the tracker. Nothing has been done to it.
 * analysis_requested  An operator pressed Analyze; no daemon has claimed it yet.
 * analyzing           The IssueAnalyzer is running.
 * analyzed            Fan-out exists in ticket_targets, awaiting Start.
 *                     This is the manual gate that replaces auto-dispatch.
 * analysis_failed     The analyzer errored, or matched zero repos.
 * running             At least one target dispatched; not every target settled.
 * done                Every participating target succeeded.
 * cancelled           An operator cancelled the ticket.
 * archived            Dismissed without running, or went terminal in the tracker
 *                     before it ever started.
 */
export type TicketStatus =
  | 'imported'
  | 'analysis_requested'
  | 'analyzing'
  | 'analyzed'
  | 'analysis_failed'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'archived';

/**
 * excluded      Operator removed this repo from the fan-out. Not participating.
 * blocked       An upstream sibling target or a tracker blocker is unsatisfied.
 * ready         Dispatchable. Waiting only on a concurrency slot.
 * dispatching   The daemon is spawning the run. A crash here is recoverable:
 *               no process exists yet, so the startup sweep returns it to ready.
 * running       A workflow run is executing.
 * gate_waiting  The run paused at an approval gate. Answered in the dashboard.
 * succeeded     Terminal.
 * failed        Parked for human review. No automatic retry — project policy is
 *               that runs are expensive, so failures need eyes.
 * cancelled     Operator cancelled. Re-dispatchable.
 */
export type TargetStatus =
  | 'excluded'
  | 'blocked'
  | 'ready'
  | 'dispatching'
  | 'running'
  | 'gate_waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'imported',
  'analysis_requested',
  'analyzing',
  'analyzed',
  'analysis_failed',
  'running',
  'done',
  'cancelled',
  'archived',
];

export const TARGET_STATUSES: readonly TargetStatus[] = [
  'excluded',
  'blocked',
  'ready',
  'dispatching',
  'running',
  'gate_waiting',
  'succeeded',
  'failed',
  'cancelled',
];

/** Ticket statuses from which no operator action can start work. */
export const TICKET_PRE_RUN_STATUSES: readonly TicketStatus[] = [
  'imported',
  'analyzed',
  'analysis_failed',
];

export const TICKET_TERMINAL_STATUSES: readonly TicketStatus[] = ['done', 'cancelled', 'archived'];

/** A target has settled when it will not move again without operator action. */
export const TARGET_SETTLED_STATUSES: readonly TargetStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/** Statuses in which a live process may exist, so cancellation is asynchronous. */
export const TARGET_LIVE_STATUSES: readonly TargetStatus[] = [
  'dispatching',
  'running',
  'gate_waiting',
];

/** Statuses from which a target can be excluded or cancelled synchronously. */
export const TARGET_PRE_DISPATCH_STATUSES: readonly TargetStatus[] = [
  'excluded',
  'blocked',
  'ready',
];

export type Complexity = 'simple' | 'complex';

/** An operator's answer to an open approval gate. */
export type GateDecision = 'approved' | 'rejected' | 'blocker';

export const GATE_DECISIONS: readonly GateDecision[] = ['approved', 'rejected', 'blocker'];

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface TicketRow {
  id: string;
  /** Owning gaggle workspace. Several gaggles share one database. */
  workspace: string;
  tracker_kind: string;
  /** Tracker-side issue id. */
  external_id: string;
  /** Human-facing key, e.g. `GAG-123`. */
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  url: string | null;
  branch_name: string | null;
  /** Set when the tracker issue is itself a sub-issue. Such rows are not imported. */
  parent_external_id: string | null;
  external_state: string;
  external_labels: string[];
  blocked_by: BlockerRef[];
  status: TicketStatus;
  analysis_summary: string | null;
  complexity: Complexity | null;
  analysis_error: string | null;
  external_created_at: string | null;
  external_updated_at: string | null;
  first_imported_at: string;
  last_synced_at: string;
  /** Last time this appeared in the tracker's candidate query. Going stale means
   *  the issue left the tracker's active set; the row is kept regardless. */
  last_seen_at: string;
  /** Set when the tracker issue went terminal while we were running it. Surfaced
   *  as a warning; deliberately does NOT cancel the work. */
  external_terminal_at: string | null;
  status_changed_at: string;
  /** When the current fan-out was produced. Compared against the registry's
   *  last sync to flag an analysis that predates a gaggle.md change. */
  analyzed_at: string | null;
  /** When an operator pressed Start. */
  started_at: string | null;
  completed_at: string | null;
}

export interface TargetRow {
  id: string;
  ticket_id: string;
  repo_alias: string;
  repo_url: string;
  local_path: string;
  /** Operator-editable before Start. */
  workflow: string;
  rationale: string | null;
  components: string[];
  /** Sibling `repo_alias` values that must succeed first. */
  depends_on: string[];
  ready_when: string | null;
  status: TargetStatus;
  /** Tracker sub-issue id. Null in the mono-repo case, where the target's
   *  tracker issue is the ticket itself. */
  external_target_id: string | null;
  external_target_url: string | null;
  /** Tracker state of the sub-issue, refreshed by sync. Null when there is no
   *  sub-issue, in which case the ticket's own state applies. */
  external_target_state: string | null;
  external_target_labels: string[];
  /** Opaque workflow-run id. The control plane never interprets it. */
  run_id: string | null;
  attempt: number;
  failure_reason: string | null;
  /** Set by the dashboard for a live target; the owning daemon observes it,
   *  kills the process, and confirms the transition. */
  cancel_requested: boolean;
  gate_approval_id: string | null;
  gate_message: string | null;
  gate_opened_at: string | null;
  /** How many times this target has been sent back through a rework loop. */
  gate_rework_attempts: number;
  /**
   * An operator's answer to an open gate, awaiting the daemon.
   *
   * Answering a gate means resuming a run, which only the process that owns the
   * executor can do. The dashboard records the decision here; the daemon turns it
   * into a transition on its next tick. `'blocker'` carries its title and
   * description in `gate_decision_comment` as JSON.
   */
  gate_decision: GateDecision | null;
  gate_decision_comment: string | null;
  gate_decision_at: string | null;
  status_changed_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

export type EventActor = 'operator' | 'daemon' | 'sync';

export interface ControlEventRow {
  id: number;
  ticket_id: string;
  /** Null for ticket-level events. */
  target_id: string | null;
  event_kind: string;
  from_status: string | null;
  to_status: string;
  actor: EventActor;
  detail: Record<string, unknown>;
  created_at: string;
}

export type OutboxOp = 'set_state' | 'post_comment' | 'apply_label' | 'remove_label';

/**
 * A pending tracker write. Enqueued inside the same transaction as the status
 * change that caused it, so a tracker outage delays the write instead of losing
 * it — which is what happens today, where every tracker call is fire-and-forget
 * with the failure logged and swallowed.
 */
export interface OutboxRow {
  id: number;
  workspace: string;
  external_id: string;
  op: OutboxOp;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface ScaffoldJobRow {
  slug: string;
  workspace: string;
  url: string;
  checkout_path: string;
  run_id: string | null;
  workflow_name: string;
  branch: string;
  started_at: string;
  last_polled_at: string | null;
  last_status: string;
  pr_url: string | null;
  last_error: string | null;
}

// ─── Composite reads ────────────────────────────────────────────────────────

/** A ticket with its fan-out. What the board renders. */
export interface TicketWithTargets {
  ticket: TicketRow;
  targets: TargetRow[];
}

/** An open approval gate, denormalized for the dashboard's Gates panel. */
export interface GateView {
  target_id: string;
  ticket_id: string;
  workspace: string;
  identifier: string;
  title: string;
  url: string | null;
  repo_alias: string;
  run_id: string | null;
  approval_id: string | null;
  gate_message: string;
  gate_opened_at: string;
  rework_attempts: number;
  /** Set when an operator has answered but the daemon has not acted yet. */
  pending_decision: GateDecision | null;
}

// ─── Derived predicates ─────────────────────────────────────────────────────

/** Targets that participate in completion accounting. */
export function participating(targets: readonly TargetRow[]): TargetRow[] {
  return targets.filter((t) => t.status !== 'excluded');
}

export function isSettled(status: TargetStatus): boolean {
  return TARGET_SETTLED_STATUSES.includes(status);
}

/**
 * Resolve the ticket status implied by its targets.
 *
 * `running` is sticky while any participating target failed or was cancelled:
 * the ticket stays on the operator's board until they resolve it. This preserves
 * the current parent state machine, which holds `claimed` while any target sits
 * in `failed`.
 *
 * Returns null when the targets imply no change.
 */
export function settleTicketStatus(targets: readonly TargetRow[]): 'done' | 'running' | null {
  const live = participating(targets);
  if (live.length === 0) return null;
  if (!live.every((t) => isSettled(t.status))) return 'running';
  return live.every((t) => t.status === 'succeeded') ? 'done' : 'running';
}

/** The tracker issue that carries this target's comments and state. */
export function trackerIdFor(ticket: TicketRow, target: TargetRow): string {
  return target.external_target_id ?? ticket.external_id;
}
