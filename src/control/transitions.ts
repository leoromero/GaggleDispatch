/**
 * The control-plane state machine — pure functions, effects as data.
 *
 * `(status, event, context) → { to, patch, effects, actor }`. Nothing here
 * touches a database, a tracker, or a subprocess: a transition decides, and
 * `ControlService` is the only thing that acts. That split is what makes the
 * whole matrix unit-testable, and it is why both the daemon and the dashboard can
 * call these functions — an illegal operator action throws here, before anything
 * has been written.
 *
 * Two invariants worth stating because the rest of the design leans on them:
 *
 *   1. **The tracker is a sink.** Every tracker-facing effect is enqueued to the
 *      outbox by the service, inside the same transaction as the status write.
 *      No transition ever reads tracker state to make a decision.
 *   2. **Nothing dispatches itself.** `ready` is reachable only from an operator
 *      action (`start_requested`, `redispatch_requested`) or from blockers
 *      clearing on a ticket an operator already started.
 */

import {
  TARGET_PRE_DISPATCH_STATUSES,
  TICKET_PRE_RUN_STATUSES,
  participating,
  settleTicketStatus,
  type Complexity,
  type EventActor,
  type TargetRow,
  type TargetStatus,
  type TicketRow,
  type TicketStatus,
} from './types.ts';
import type { TargetSpec, TargetPatch, TicketPatch } from './store/types.ts';

// ─── Events ─────────────────────────────────────────────────────────────────

export interface BlockerSpec {
  title: string;
  description: string;
}

export type TicketEvent =
  | { kind: 'analyze_requested' }
  | { kind: 'analysis_claimed' }
  | { kind: 'analysis_succeeded'; summary: string; complexity: Complexity | null; targets: TargetSpec[] }
  | { kind: 'analysis_failed'; error: string }
  | { kind: 'start_requested' }
  | { kind: 'cancel_requested' }
  | { kind: 'archive_requested' }
  | { kind: 'restore_requested' }
  | { kind: 'external_terminal' }
  /** Re-evaluated whenever a target reaches a terminal status. */
  | { kind: 'targets_settled' };

export type TargetEvent =
  | { kind: 'blockers_satisfied' }
  | { kind: 'blockers_unsatisfied' }
  | { kind: 'dispatch_claimed' }
  /** `run_id` may be null when the executor learns it asynchronously. */
  | { kind: 'run_started'; run_id: string | null }
  | { kind: 'run_succeeded' }
  | { kind: 'run_failed'; reason: string }
  | { kind: 'gate_opened'; approval_id: string; message: string }
  | { kind: 'gate_approved'; comment: string | null }
  | { kind: 'gate_rejected'; reason: string }
  | { kind: 'gate_blocker_created'; blocker: BlockerSpec }
  | { kind: 'gate_timed_out' }
  | { kind: 'cancel_requested' }
  | { kind: 'cancel_confirmed' }
  | { kind: 'redispatch_requested' }
  | { kind: 'exclude_requested' }
  | { kind: 'include_requested' };

/** Every event kind, for exhaustive matrix tests. */
export const TICKET_EVENT_KINDS = [
  'analyze_requested',
  'analysis_claimed',
  'analysis_succeeded',
  'analysis_failed',
  'start_requested',
  'cancel_requested',
  'archive_requested',
  'restore_requested',
  'external_terminal',
  'targets_settled',
] as const;

export const TARGET_EVENT_KINDS = [
  'blockers_satisfied',
  'blockers_unsatisfied',
  'dispatch_claimed',
  'run_started',
  'run_succeeded',
  'run_failed',
  'gate_opened',
  'gate_approved',
  'gate_rejected',
  'gate_blocker_created',
  'gate_timed_out',
  'cancel_requested',
  'cancel_confirmed',
  'redispatch_requested',
  'exclude_requested',
  'include_requested',
] as const;

// ─── Effects ────────────────────────────────────────────────────────────────

/**
 * Side effects, as data.
 *
 * `tracker_*` effects become outbox rows — durable, retried, and committed with
 * the status change. Everything else is out-of-band work the service delegates
 * to an injected port: spawning a run, killing one, answering a gate.
 */
export type ControlEffect =
  // tracker (durable, via the outbox)
  | { kind: 'tracker_set_state'; external_id: string; state: string }
  | { kind: 'tracker_post_comment'; external_id: string; body: string }
  | { kind: 'tracker_apply_label'; external_id: string; label: string }
  | { kind: 'tracker_remove_label'; external_id: string; label: string }

  // control-plane bookkeeping
  | { kind: 'replace_targets'; specs: TargetSpec[] }
  /** Recompute blocked/ready across this ticket's targets. */
  | { kind: 'evaluate_target_readiness' }
  /** Cancel every live target of this ticket. */
  | { kind: 'cancel_targets' }

  // executor
  | { kind: 'spawn_run' }
  | { kind: 'kill_run'; run_id: string | null }
  | { kind: 'approve_gate'; approval_id: string | null; run_id: string | null; comment: string | null }
  | { kind: 'reject_gate'; approval_id: string | null; run_id: string | null; reason: string }

  // tracker structure
  | { kind: 'create_blocker_issue'; spec: BlockerSpec; blocks_external_id: string };

// ─── Context ────────────────────────────────────────────────────────────────

/**
 * Tracker label names, keyed by semantic kind.
 *
 * Required rather than optional even though mirroring is off by default: an
 * optional map lets `mirror_labels: true` silently emit nothing, which is a
 * configuration bug that looks like a working feature.
 */
export type MirrorLabels = Record<'analyzing' | 'claimed' | 'waiting_human' | 'failed', string>;

export const DEFAULT_MIRROR_LABELS: MirrorLabels = {
  analyzing: 'gaggle:analyzing',
  claimed: 'gaggle:claimed',
  waiting_human: 'gaggle:waiting-human',
  failed: 'gaggle:failed',
};

/** Read-only. A transition never mutates its context. */
export interface TicketTransitionContext {
  ticket: TicketRow;
  /** Current fan-out. Consulted for completion accounting and the live-target guard. */
  targets: readonly TargetRow[];
  /** When false, no label effects are emitted at all. */
  mirror_labels: boolean;
  /** Tracker state a completed ticket moves to. */
  completed_state: string;
  labels: MirrorLabels;
}

export interface TargetTransitionContext {
  ticket: TicketRow;
  target: TargetRow;
  /** Sibling targets of the same ticket, for dependency checks. */
  siblings: readonly TargetRow[];
  mirror_labels: boolean;
  /** Tracker state while a gate is open. Null disables the write. */
  gate_waiting_state: string | null;
  /** Tracker state to restore once a gate closes. Null disables the write. */
  gate_resume_state: string | null;
  completed_state: string;
  /**
   * How many times a rejected gate may be sent back through the workflow's
   * `on_reject` loop before the target fails. Zero means a rejection fails
   * immediately.
   */
  max_gate_rework_attempts: number;
  labels: MirrorLabels;
}

// ─── Results ────────────────────────────────────────────────────────────────

export interface TicketTransition {
  from: TicketStatus;
  to: TicketStatus;
  patch: TicketPatch;
  effects: ControlEffect[];
  actor: EventActor;
}

export interface TargetTransition {
  from: TargetStatus;
  to: TargetStatus;
  patch: TargetPatch;
  effects: ControlEffect[];
  actor: EventActor;
}

export class InvalidControlTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly event_kind: string,
    public readonly machine: 'ticket' | 'target',
  ) {
    super(`Invalid ${machine} transition: '${event_kind}' from status '${from}'`);
    this.name = 'InvalidControlTransitionError';
  }
}

/** Refusing an operator action because the world moved on. Maps to HTTP 409. */
export class ControlConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlConflictError';
  }
}

// ─── Ticket machine ─────────────────────────────────────────────────────────

const TICKET_ACTOR: Record<(typeof TICKET_EVENT_KINDS)[number], EventActor> = {
  analyze_requested: 'operator',
  analysis_claimed: 'daemon',
  analysis_succeeded: 'daemon',
  analysis_failed: 'daemon',
  start_requested: 'operator',
  cancel_requested: 'operator',
  archive_requested: 'operator',
  restore_requested: 'operator',
  external_terminal: 'sync',
  targets_settled: 'daemon',
};

export function ticketTransition(
  from: TicketStatus,
  event: TicketEvent,
  ctx: TicketTransitionContext,
): TicketTransition {
  const actor = TICKET_ACTOR[event.kind];
  const done = (to: TicketStatus, patch: TicketPatch = {}, effects: ControlEffect[] = []): TicketTransition => ({
    from,
    to,
    patch,
    effects,
    actor,
  });
  const reject = (): never => {
    throw new InvalidControlTransitionError(from, event.kind, 'ticket');
  };

  // ── events accepted from several statuses ──────────────────────────────
  switch (event.kind) {
    case 'external_terminal': {
      // Terminal in the tracker is informational, never destructive. A pre-run
      // ticket is archived; a running one only gets a marker so the operator can
      // decide. Silently killing an in-flight run because someone closed a
      // tracker issue is the wrong default under manual control.
      if (TICKET_PRE_RUN_STATUSES.includes(from)) {
        return done('archived', { external_terminal_at: nowIso() }, labelsCleared(ctx));
      }
      if (from === 'running') {
        return done('running', { external_terminal_at: nowIso() });
      }
      return done(from);
    }

    case 'archive_requested': {
      if (!TICKET_PRE_RUN_STATUSES.includes(from)) return reject();
      return done('archived', {}, labelsCleared(ctx));
    }

    case 'analyze_requested': {
      // Only pre-run statuses accept this, which is also what protects a live run
      // from having its fan-out replaced underneath it: a live target implies the
      // ticket is `running`, and `running` is not in the accepted set.
      if (!TICKET_PRE_RUN_STATUSES.includes(from)) return reject();
      return done('analysis_requested', { analysis_error: null }, applyLabel(ctx, 'analyzing'));
    }

    case 'cancel_requested': {
      if (from === 'running' || from === 'analyzed' || from === 'analyzing') {
        return done('cancelled', { completed_at: nowIso() }, [
          { kind: 'cancel_targets' },
          ...labelsCleared(ctx),
        ]);
      }
      return reject();
    }
  }

  // ── status-specific ────────────────────────────────────────────────────
  if (from === 'analysis_requested') {
    if (event.kind === 'analysis_claimed') return done('analyzing');
    return reject();
  }

  if (from === 'analyzing') {
    if (event.kind === 'analysis_succeeded') {
      if (event.targets.length === 0) {
        return done(
          'analysis_failed',
          {
            analysis_summary: event.summary,
            complexity: event.complexity,
            analysis_error: 'Analysis matched no repositories in the registry',
          },
          labelsCleared(ctx),
        );
      }
      return done(
        'analyzed',
        {
          analysis_summary: event.summary,
          complexity: event.complexity,
          analysis_error: null,
          analyzed_at: nowIso(),
        },
        [{ kind: 'replace_targets', specs: event.targets }, ...labelsCleared(ctx)],
      );
    }
    if (event.kind === 'analysis_failed') {
      return done('analysis_failed', { analysis_error: event.error }, labelsCleared(ctx));
    }
    return reject();
  }

  if (from === 'analyzed') {
    if (event.kind === 'start_requested') {
      // Starting with nothing to run would park the ticket in `running` forever:
      // `targets_settled` cannot complete a ticket with no participating targets,
      // and `running` accepts no operator action except Cancel.
      if (participating(ctx.targets).length === 0) {
        throw new ControlConflictError(
          `Cannot start ${ctx.ticket.identifier}: every target is excluded, so there is nothing to run.`,
        );
      }
      return done('running', { started_at: nowIso() }, [
        { kind: 'evaluate_target_readiness' },
        ...applyLabel(ctx, 'claimed'),
      ]);
    }
    return reject();
  }

  if (from === 'running') {
    if (event.kind === 'targets_settled') {
      const settled = settleTicketStatus(ctx.targets);
      if (settled !== 'done') return done('running');
      return done(
        'done',
        { completed_at: nowIso() },
        [
          { kind: 'tracker_set_state', external_id: ctx.ticket.external_id, state: ctx.completed_state },
          ...labelsCleared(ctx),
        ],
      );
    }
    return reject();
  }

  if (from === 'archived') {
    if (event.kind === 'restore_requested') {
      return done('imported', { external_terminal_at: null });
    }
    return reject();
  }

  // imported handled by the shared block above; done / cancelled are terminal.
  return reject();
}

// ─── Target machine ─────────────────────────────────────────────────────────

const TARGET_ACTOR: Record<(typeof TARGET_EVENT_KINDS)[number], EventActor> = {
  blockers_satisfied: 'daemon',
  blockers_unsatisfied: 'daemon',
  dispatch_claimed: 'daemon',
  run_started: 'daemon',
  run_succeeded: 'daemon',
  run_failed: 'daemon',
  gate_opened: 'daemon',
  gate_approved: 'operator',
  gate_rejected: 'operator',
  gate_blocker_created: 'operator',
  gate_timed_out: 'daemon',
  cancel_requested: 'operator',
  cancel_confirmed: 'daemon',
  redispatch_requested: 'operator',
  exclude_requested: 'operator',
  include_requested: 'operator',
};

export function targetTransition(
  from: TargetStatus,
  event: TargetEvent,
  ctx: TargetTransitionContext,
): TargetTransition {
  const actor = TARGET_ACTOR[event.kind];
  const trackerId = ctx.target.external_target_id ?? ctx.ticket.external_id;
  const done = (to: TargetStatus, patch: TargetPatch = {}, effects: ControlEffect[] = []): TargetTransition => ({
    from,
    to,
    patch,
    effects,
    actor,
  });
  const reject = (): never => {
    throw new InvalidControlTransitionError(from, event.kind, 'target');
  };

  if (from === 'succeeded') return reject();

  // ── events accepted from several statuses ──────────────────────────────
  switch (event.kind) {
    case 'cancel_requested': {
      // A live target owns a subprocess this process may not own, so the
      // dashboard raises a flag and the owning daemon confirms. Everything else
      // cancels in the same transaction.
      if (isLive(from)) return done(from, { cancel_requested: true });
      if (TARGET_PRE_DISPATCH_STATUSES.includes(from)) {
        return done('cancelled', { cancel_requested: false, completed_at: nowIso() });
      }
      return reject();
    }

    case 'cancel_confirmed': {
      if (!isLive(from)) return reject();
      return done(
        'cancelled',
        { cancel_requested: false, completed_at: nowIso() },
        [{ kind: 'kill_run', run_id: ctx.target.run_id }, ...clearTargetLabels(ctx, trackerId)],
      );
    }

    case 'exclude_requested': {
      if (!TARGET_PRE_DISPATCH_STATUSES.includes(from)) return reject();
      return done('excluded');
    }

    case 'include_requested': {
      if (from !== 'excluded') return reject();
      return done('blocked');
    }

    case 'redispatch_requested': {
      if (from !== 'failed' && from !== 'cancelled') return reject();
      // A terminal ticket must not be able to start work. Without this,
      // re-dispatching a target of a cancelled ticket spawns a run the operator
      // explicitly cancelled, and the ticket can never settle again because
      // `cancelled` accepts no events.
      if (ctx.ticket.status !== 'running') {
        throw new ControlConflictError(
          `Cannot re-dispatch ${ctx.target.repo_alias}: ${ctx.ticket.identifier} is ${ctx.ticket.status}, not running.`,
        );
      }
      // To `blocked`, not straight to `ready`: `ready` would bypass the ticket's
      // tracker blockers and this target's `depends_on`. The readiness effect then
      // promotes it in the same operation when they are satisfied, so an operator
      // still sees `ready` immediately — exactly as Start behaves.
      return done(
        'blocked',
        {
          attempt: ctx.target.attempt + 1,
          failure_reason: null,
          run_id: null,
          cancel_requested: false,
          completed_at: null,
          gate_approval_id: null,
          gate_message: null,
          gate_opened_at: null,
          // A fresh attempt gets a fresh rework budget; carrying the old count
          // would fail the first rejected gate of the new run.
          gate_rework_attempts: 0,
        },
        [{ kind: 'evaluate_target_readiness' }],
      );
    }
  }

  // ── status-specific ────────────────────────────────────────────────────
  if (from === 'blocked') {
    if (event.kind === 'blockers_satisfied') return done('ready');
    return reject();
  }

  if (from === 'ready') {
    if (event.kind === 'blockers_unsatisfied') return done('blocked');
    if (event.kind === 'dispatch_claimed') {
      return done('dispatching', { dispatched_at: nowIso() }, [{ kind: 'spawn_run' }]);
    }
    return reject();
  }

  if (from === 'dispatching') {
    if (event.kind === 'run_started') {
      return done('running', { run_id: event.run_id }, applyTargetLabel(ctx, trackerId, 'claimed'));
    }
    if (event.kind === 'run_failed') return failTarget(from, ctx, trackerId, event.reason, actor);
    return reject();
  }

  if (from === 'running') {
    if (event.kind === 'run_succeeded') {
      return done(
        'succeeded',
        { completed_at: nowIso(), failure_reason: null },
        clearTargetLabels(ctx, trackerId),
      );
    }
    if (event.kind === 'run_failed') return failTarget(from, ctx, trackerId, event.reason, actor);
    if (event.kind === 'gate_opened') {
      const effects: ControlEffect[] = [
        {
          kind: 'tracker_post_comment',
          external_id: trackerId,
          body: gateComment(event.message),
        },
        ...applyTargetLabel(ctx, trackerId, 'waiting_human'),
      ];
      if (ctx.gate_waiting_state) {
        effects.push({ kind: 'tracker_set_state', external_id: trackerId, state: ctx.gate_waiting_state });
      }
      return done(
        'gate_waiting',
        {
          gate_approval_id: event.approval_id,
          gate_message: event.message,
          gate_opened_at: nowIso(),
        },
        effects,
      );
    }
    return reject();
  }

  if (from === 'gate_waiting') {
    const clearGate: TargetPatch = {
      gate_approval_id: null,
      gate_message: null,
      gate_opened_at: null,
    };

    // A run can end while its gate is still open: the executor crashed, timed
    // out on its own, or was cancelled outside the control plane. Without these
    // the reconciler throws every tick and stops reconciling the whole
    // workspace, so the outcome has to be accepted from here too.
    if (event.kind === 'run_succeeded') {
      return done(
        'succeeded',
        { ...clearGate, completed_at: nowIso(), failure_reason: null },
        [...resumeState(ctx, trackerId), ...clearTargetLabels(ctx, trackerId)],
      );
    }
    if (event.kind === 'run_failed') {
      const failed = failTarget(from, ctx, trackerId, event.reason, actor);
      return {
        ...failed,
        patch: { ...failed.patch, ...clearGate },
        effects: [...resumeState(ctx, trackerId), ...failed.effects],
      };
    }
    const resume = resumeState(ctx, trackerId);

    if (event.kind === 'gate_approved') {
      return done('running', clearGate, [
        {
          kind: 'approve_gate',
          approval_id: ctx.target.gate_approval_id,
          run_id: ctx.target.run_id,
          comment: event.comment,
        },
        ...resume,
        ...applyTargetLabel(ctx, trackerId, 'claimed'),
      ]);
    }

    if (event.kind === 'gate_rejected') {
      const rejectEffect: ControlEffect = {
        kind: 'reject_gate',
        approval_id: ctx.target.gate_approval_id,
        run_id: ctx.target.run_id,
        reason: event.reason,
      };
      // A rejection feeds the workflow's own `on_reject` rework loop rather than
      // parking the target, because that is what the gate message promises the
      // operator ("reject: <feedback> triggers a revised plan"). Only once the
      // rework budget is spent does it become a failure.
      if (ctx.target.gate_rework_attempts >= ctx.max_gate_rework_attempts) {
        const failed = failTarget(from, ctx, trackerId, `gate rejected, rework attempts exhausted: ${event.reason}`, actor);
        return {
          ...failed,
          patch: { ...failed.patch, ...clearGate },
          effects: [rejectEffect, ...resume, ...failed.effects],
        };
      }
      return done(
        'running',
        { ...clearGate, gate_rework_attempts: ctx.target.gate_rework_attempts + 1 },
        [rejectEffect, ...resume, ...applyTargetLabel(ctx, trackerId, 'claimed')],
      );
    }

    if (event.kind === 'gate_timed_out') {
      const failed = failTarget(from, ctx, trackerId, 'gate timed out with no operator response', actor);
      return {
        ...failed,
        patch: { ...failed.patch, ...clearGate },
        effects: [
          {
            kind: 'reject_gate',
            approval_id: ctx.target.gate_approval_id,
            run_id: ctx.target.run_id,
            reason: 'Gate timeout — no operator response',
          },
          ...resume,
          ...failed.effects,
        ],
      };
    }

    if (event.kind === 'gate_blocker_created') {
      return done('blocked', clearGate, [
        { kind: 'create_blocker_issue', spec: event.blocker, blocks_external_id: trackerId },
        {
          kind: 'reject_gate',
          approval_id: ctx.target.gate_approval_id,
          run_id: ctx.target.run_id,
          reason: `Blocker created: ${event.blocker.title}`,
        },
        {
          kind: 'tracker_post_comment',
          external_id: ctx.ticket.external_id,
          body:
            `🔗 **Blocker created**: ${event.blocker.title}\n\n` +
            `Work on \`${ctx.target.repo_alias}\` is paused until this is resolved.`,
        },
        ...resume,
        ...clearTargetLabels(ctx, trackerId),
      ]);
    }

    return reject();
  }

  // excluded / failed / cancelled: only the shared events above apply.
  return reject();
}

// ─── shared pieces ──────────────────────────────────────────────────────────

/**
 * Park a target for human review. There is no automatic retry: runs are
 * expensive, and a silent retry loop burns credits without surfacing the cause.
 * The comment tells the operator where the button is.
 */
function failTarget(
  from: TargetStatus,
  ctx: TargetTransitionContext,
  trackerId: string,
  reason: string,
  actor: EventActor,
): TargetTransition {
  const body =
    `❌ **GaggleDispatch — \`${ctx.target.repo_alias}\` failed**\n\n` +
    `Reason: \`${reason}\`\n\n` +
    `No automatic retry: runs are expensive, so failures are parked for review. ` +
    `Re-dispatch from the GaggleDispatch dashboard once the cause is addressed.`;
  return {
    from,
    to: 'failed',
    patch: { failure_reason: reason, completed_at: nowIso(), cancel_requested: false },
    effects: [
      { kind: 'tracker_post_comment', external_id: trackerId, body },
      ...applyTargetLabel(ctx, trackerId, 'failed'),
    ],
    actor,
  };
}

/**
 * The tracker comment for an open gate.
 *
 * It says outright that replying does nothing. Gate answers come from the
 * dashboard only — there is no comment poller and no intent classifier — so a
 * comment that merely quoted the question would invite an operator to reply into
 * the void.
 */
function gateComment(message: string): string {
  return (
    `⏸️ **GaggleDispatch — waiting for approval**\n\n` +
    `${message}\n\n` +
    `---\n` +
    `Replies to this comment have no effect. Approve or reject in the ` +
    `GaggleDispatch dashboard.`
  );
}

function isLive(status: TargetStatus): boolean {
  return status === 'dispatching' || status === 'running' || status === 'gate_waiting';
}

/** Restore the tracker state a gate moved away from, when one is configured. */
function resumeState(ctx: TargetTransitionContext, trackerId: string): ControlEffect[] {
  return ctx.gate_resume_state
    ? [{ kind: 'tracker_set_state', external_id: trackerId, state: ctx.gate_resume_state }]
    : [];
}

// ─── label mirroring ────────────────────────────────────────────────────────
//
// One-way and off by default. Nothing in the codebase reads a gaggle label to
// make a decision; when enabled these exist purely so the team can see activity
// in the tracker.

function applyLabel(
  ctx: TicketTransitionContext,
  kind: 'analyzing' | 'claimed',
): ControlEffect[] {
  if (!ctx.mirror_labels) return [];
  return [{ kind: 'tracker_apply_label', external_id: ctx.ticket.external_id, label: ctx.labels[kind] }];
}

function labelsCleared(ctx: TicketTransitionContext): ControlEffect[] {
  if (!ctx.mirror_labels) return [];
  const out: ControlEffect[] = [];
  for (const kind of ['analyzing', 'claimed'] as const) {
    out.push({ kind: 'tracker_remove_label', external_id: ctx.ticket.external_id, label: ctx.labels[kind] });
  }
  return out;
}

function applyTargetLabel(
  ctx: TargetTransitionContext,
  trackerId: string,
  kind: 'claimed' | 'waiting_human' | 'failed',
): ControlEffect[] {
  if (!ctx.mirror_labels) return [];
  const out: ControlEffect[] = [];
  for (const other of ['claimed', 'waiting_human', 'failed'] as const) {
    if (other === kind) continue;
    out.push({ kind: 'tracker_remove_label', external_id: trackerId, label: ctx.labels[other] });
  }
  out.push({ kind: 'tracker_apply_label', external_id: trackerId, label: ctx.labels[kind] });
  return out;
}

function clearTargetLabels(ctx: TargetTransitionContext, trackerId: string): ControlEffect[] {
  if (!ctx.mirror_labels) return [];
  const out: ControlEffect[] = [];
  for (const kind of ['claimed', 'waiting_human', 'failed'] as const) {
    out.push({ kind: 'tracker_remove_label', external_id: trackerId, label: ctx.labels[kind] });
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}
