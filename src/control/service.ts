/**
 * ControlService — the only thing that changes control-plane state.
 *
 * Every event, whether it came from an operator clicking a button or a daemon
 * observing a run finish, goes through the same envelope:
 *
 *   BEGIN
 *     lock the ticket, then the target          -- always in that order
 *     run the pure transition                   -- throws if illegal
 *     write the status patch
 *     append a control_events row
 *     enqueue tracker effects to the outbox
 *     apply in-transaction effects              -- targets, readiness, cascades
 *     re-settle the ticket if a target went terminal
 *   COMMIT
 *   then apply out-of-band effects               -- spawn, kill, answer a gate
 *
 * Three properties fall out of that shape and are the reason for it:
 *
 *   - **Double-clicks are safe.** The row lock serializes them and the status
 *     precondition inside the transition rejects the second one with a conflict.
 *   - **Tracker writes cannot be lost.** They commit with the status change as
 *     outbox rows, instead of being fired and forgotten.
 *   - **A crash between commit and spawn is recoverable.** The target sits in
 *     `dispatching` with no process, which is precisely what that status means,
 *     and the startup sweep returns it to `ready`. The opposite order would risk
 *     a live agent with no record of it.
 */

import { logger } from '../util/logger.ts';
import type { BlockerReadinessConfig } from '../orchestrator/readiness.ts';
import { evaluateReadiness } from './readiness.ts';
import type {
  AnalyzerPort,
  DispatchContext,
  ExecutorPort,
  TrackerStructurePort,
} from './ports.ts';
import type { ControlStore, TargetPatch, TicketPatch } from './store/types.ts';
import {
  ControlConflictError,
  targetTransition,
  ticketTransition,
  type ControlEffect,
  type MirrorLabels,
  type TargetEvent,
  type TargetTransition,
  type TicketEvent,
  type TicketTransition,
} from './transitions.ts';
import {
  TARGET_LIVE_STATUSES,
  isSettled,
  type TargetRow,
  type TargetStatus,
  type TicketRow,
} from './types.ts';

// ─── config ─────────────────────────────────────────────────────────────────

export interface ControlServiceConfig {
  /** Which gaggle owns the tickets this service manages. */
  workspace: string;
  tracker_kind: string;
  mirror_labels: boolean;
  labels: MirrorLabels;
  completed_state: string;
  gate_waiting_state: string | null;
  gate_resume_state: string | null;
  max_gate_rework_attempts: number;
  /** Config slice the readiness predicate reads. */
  readiness: BlockerReadinessConfig;
}

export interface ControlServiceDeps {
  store: ControlStore;
  cfg: ControlServiceConfig;
  executor: ExecutorPort;
  tracker: TrackerStructurePort;
  analyzer: AnalyzerPort;
}

/** Raised when an id does not resolve. Maps to HTTP 404. */
export class ControlNotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`);
    this.name = 'ControlNotFoundError';
  }
}

export class ControlService {
  constructor(private readonly deps: ControlServiceDeps) {}

  // ── operator actions ────────────────────────────────────────────────────
  //
  // Thin named wrappers over the two envelopes. They exist so the HTTP layer
  // and the CLI express intent rather than assembling event objects, and so the
  // set of things an operator can do is enumerable in one place.

  requestAnalysis(ticketId: string): Promise<TicketTransition> {
    return this.applyTicketEvent(ticketId, { kind: 'analyze_requested' });
  }

  start(ticketId: string): Promise<TicketTransition> {
    return this.applyTicketEvent(ticketId, { kind: 'start_requested' });
  }

  cancelTicket(ticketId: string): Promise<TicketTransition> {
    return this.applyTicketEvent(ticketId, { kind: 'cancel_requested' });
  }

  archive(ticketId: string): Promise<TicketTransition> {
    return this.applyTicketEvent(ticketId, { kind: 'archive_requested' });
  }

  restore(ticketId: string): Promise<TicketTransition> {
    return this.applyTicketEvent(ticketId, { kind: 'restore_requested' });
  }

  /** Put a failed or cancelled target back in the queue. The only retry there is. */
  redispatchTarget(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'redispatch_requested' });
  }

  cancelTarget(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'cancel_requested' });
  }

  excludeTarget(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'exclude_requested' });
  }

  includeTarget(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'include_requested' });
  }

  approveGate(targetId: string, comment: string | null): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'gate_approved', comment });
  }

  rejectGate(targetId: string, reason: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'gate_rejected', reason });
  }

  createGateBlocker(
    targetId: string,
    blocker: { title: string; description: string },
  ): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'gate_blocker_created', blocker });
  }

  /**
   * Change which workflow a target will run. Not a transition — the fan-out is
   * data an operator may correct — but still guarded: rewriting the workflow of
   * a target that is already executing would be a lie about what ran.
   */
  async setTargetWorkflow(targetId: string, workflow: string): Promise<TargetRow> {
    return this.deps.store.tx(async (tr) => {
      const target = await tr.lockTarget(targetId);
      if (!target) throw new ControlNotFoundError('target', targetId);
      if (!TARGET_PRE_DISPATCH_OR_SETTLED.includes(target.status)) {
        throw new ControlConflictError(
          `Cannot change the workflow of ${target.repo_alias}: it is ${target.status}.`,
        );
      }
      const updated = await tr.updateTarget(targetId, { workflow });
      await tr.appendEvent({
        ticket_id: target.ticket_id,
        target_id: targetId,
        event_kind: 'workflow_changed',
        from_status: target.status,
        to_status: target.status,
        actor: 'operator',
        detail: { from: target.workflow, to: workflow },
      });
      return updated!;
    });
  }

  // ── daemon-facing events ────────────────────────────────────────────────

  /**
   * Claim tickets awaiting analysis.
   *
   * Like {@link claimAndDispatch}, the status write is one atomic statement
   * rather than a pass through the envelope, because that is the only way to make
   * the claim exclusive. The event row follows.
   */
  async claimAnalysisWork(limit: number): Promise<TicketRow[]> {
    // One transaction so the claim and its audit row commit together — a crash
    // between them would leave a status change with no record of who made it.
    return this.deps.store.tx(async (tr) => {
      const claimed = await tr.claimTicketsForAnalysis(this.deps.cfg.workspace, limit);
      for (const ticket of claimed) {
        await tr.appendEvent({
          ticket_id: ticket.id,
          event_kind: 'analysis_claimed',
          from_status: 'analysis_requested',
          to_status: 'analyzing',
          actor: 'daemon',
        });
      }
      return claimed;
    });
  }

  /**
   * Run the analyzer for a claimed ticket and record the outcome.
   *
   * The claim already moved it to `analyzing`, so a thrown analyzer is still
   * recorded as `analysis_failed` rather than leaving the ticket stuck.
   */
  async runAnalysis(ticket: TicketRow): Promise<TicketTransition> {
    try {
      const result = await this.deps.analyzer.analyze(ticket);
      return await this.applyTicketEvent(ticket.id, {
        kind: 'analysis_succeeded',
        summary: result.summary,
        complexity: result.complexity,
        targets: result.targets.map((t) => ({
          repo_alias: t.repo_alias,
          repo_url: t.repo_url,
          local_path: t.local_path,
          workflow: t.workflow,
          rationale: t.rationale ?? null,
          components: t.components ?? [],
          depends_on: t.depends_on ?? [],
          ready_when: t.ready_when ?? null,
        })),
      });
    } catch (err) {
      return this.applyTicketEvent(ticket.id, {
        kind: 'analysis_failed',
        error: (err as Error).message,
      });
    }
  }

  /**
   * Claim up to `limit` dispatchable targets and start a run for each.
   *
   * The claim is a single `UPDATE … FOR UPDATE SKIP LOCKED` statement rather
   * than a pass through `applyTargetEvent`, because only one statement can make
   * "pick a ready row and mark it dispatching" atomic — which is what stops two
   * daemons, or two ticks, from dispatching the same target. The corresponding
   * `control_events` row is written straight after.
   */
  async claimAndDispatch(limit: number): Promise<TargetRow[]> {
    // Claim and audit together, then spawn outside the transaction. Spawning
    // inside would hold row locks across a subprocess launch.
    const claimed = await this.deps.store.tx(async (tr) => {
      const rows = await tr.claimReadyTargets(this.deps.cfg.workspace, limit);
      for (const target of rows) {
        await tr.appendEvent({
          ticket_id: target.ticket_id,
          target_id: target.id,
          event_kind: 'dispatch_claimed',
          from_status: 'ready',
          to_status: 'dispatching',
          actor: 'daemon',
          detail: { attempt: target.attempt, workflow: target.workflow },
        });
      }
      return rows;
    });

    for (const target of claimed) {
      // Per-target isolation: one target whose spawn or transition is refused must
      // not leave its siblings claimed-but-never-spawned. Those would be invisible
      // to `reconcileRuns` (it only looks at running/gate_waiting), swept only at
      // startup, and counted against the concurrency ceiling in the meantime.
      try {
        await this.dispatch(target);
      } catch (err) {
        logger.error('Dispatch failed irrecoverably; the startup sweep will requeue it', {
          target_id: target.id,
          repo_alias: target.repo_alias,
          error: (err as Error).message,
        });
      }
    }
    return claimed;
  }

  /** Spawn the run for an already-claimed target and report the outcome. */
  private async dispatch(target: TargetRow): Promise<void> {
    const ticket = await this.deps.store.getTicket(target.ticket_id);
    if (!ticket) {
      logger.error('dispatch: ticket vanished under a claimed target', { target_id: target.id });
      return;
    }
    try {
      const { run_id } = await this.deps.executor.spawnRun({ ticket, target });
      await this.applyTargetEvent(target.id, { kind: 'run_started', run_id });
    } catch (err) {
      const reason = (err as Error).message;
      logger.warn('dispatch failed', { target_id: target.id, repo_alias: target.repo_alias, reason });
      await this.applyTargetEvent(target.id, { kind: 'run_failed', reason });
    }
  }

  /** Attach a run id learned after the run was already reported as started. */
  async recordRunId(targetId: string, runId: string): Promise<void> {
    await this.deps.store.updateTarget(targetId, { run_id: runId });
  }

  runStarted(targetId: string, runId: string | null): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'run_started', run_id: runId });
  }

  runSucceeded(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'run_succeeded' });
  }

  runFailed(targetId: string, reason: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'run_failed', reason });
  }

  gateOpened(targetId: string, approvalId: string, message: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'gate_opened', approval_id: approvalId, message });
  }

  gateTimedOut(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'gate_timed_out' });
  }

  confirmCancel(targetId: string): Promise<TargetTransition> {
    return this.applyTargetEvent(targetId, { kind: 'cancel_confirmed' });
  }

  externalTerminal(ticketId: string): Promise<TicketTransition> {
    return this.applyTicketEvent(ticketId, { kind: 'external_terminal' });
  }

  /**
   * Recompute blocked/ready for every target of a started ticket.
   *
   * Idempotent and safe to run on every tick: it only ever moves targets between
   * `blocked` and `ready`, never into or out of a live status.
   */
  async evaluateReadiness(ticketId: string): Promise<void> {
    const ticket = await this.deps.store.getTicket(ticketId);
    if (!ticket || ticket.status !== 'running') return;
    const targets = await this.deps.store.listTargets(ticketId);
    for (const target of targets) {
      if (target.status !== 'blocked' && target.status !== 'ready') continue;
      const { ready } = evaluateReadiness(ticket, target, targets, this.deps.cfg.readiness);
      if (ready && target.status === 'blocked') {
        await this.applyTargetEvent(target.id, { kind: 'blockers_satisfied' });
      } else if (!ready && target.status === 'ready') {
        await this.applyTargetEvent(target.id, { kind: 'blockers_unsatisfied' });
      }
    }
  }

  // ── the envelopes ───────────────────────────────────────────────────────

  async applyTicketEvent(ticketId: string, event: TicketEvent): Promise<TicketTransition> {
    const { transition, deferred } = await this.deps.store.tx(async (tr) => {
      const ticket = await tr.lockTicket(ticketId);
      if (!ticket) throw new ControlNotFoundError('ticket', ticketId);
      const targets = await tr.listTargets(ticketId);

      const t = ticketTransition(ticket.status, event, {
        ticket,
        targets,
        mirror_labels: this.deps.cfg.mirror_labels,
        completed_state: this.deps.cfg.completed_state,
        labels: this.deps.cfg.labels,
      });

      const patch: TicketPatch = { ...t.patch };
      if (t.to !== ticket.status) patch.status = t.to;
      await tr.updateTicket(ticketId, patch);
      await tr.appendEvent({
        ticket_id: ticketId,
        event_kind: event.kind,
        from_status: t.from,
        to_status: t.to,
        actor: t.actor,
        detail: eventDetail(event),
      });

      const out = await this.applyEffects(tr, t.effects, { ticket, target: null });
      return { transition: t, deferred: out };
    });

    await this.runDeferred(deferred);
    logger.debug('ticket transition', {
      ticket_id: ticketId,
      event: event.kind,
      from: transition.from,
      to: transition.to,
    });
    return transition;
  }

  async applyTargetEvent(targetId: string, event: TargetEvent): Promise<TargetTransition> {
    const { transition, deferred } = await this.deps.store.tx(async (tr) => {
      // Two reads to lock in a fixed order. Locking the ticket first, always,
      // is what keeps two concurrent target events on one ticket from
      // deadlocking against each other.
      const preview = await tr.getTarget(targetId);
      if (!preview) throw new ControlNotFoundError('target', targetId);
      const ticket = await tr.lockTicket(preview.ticket_id);
      if (!ticket) throw new ControlNotFoundError('ticket', preview.ticket_id);
      const target = await tr.lockTarget(targetId);
      if (!target) throw new ControlNotFoundError('target', targetId);
      const siblings = await tr.listTargets(target.ticket_id);

      const t = targetTransition(target.status, event, {
        ticket,
        target,
        siblings,
        mirror_labels: this.deps.cfg.mirror_labels,
        gate_waiting_state: this.deps.cfg.gate_waiting_state,
        gate_resume_state: this.deps.cfg.gate_resume_state,
        completed_state: this.deps.cfg.completed_state,
        max_gate_rework_attempts: this.deps.cfg.max_gate_rework_attempts,
        labels: this.deps.cfg.labels,
      });

      const patch: TargetPatch = { ...t.patch };
      if (t.to !== target.status) patch.status = t.to;
      await tr.updateTarget(targetId, patch);
      await tr.appendEvent({
        ticket_id: target.ticket_id,
        target_id: targetId,
        event_kind: event.kind,
        from_status: t.from,
        to_status: t.to,
        actor: t.actor,
        detail: eventDetail(event),
      });

      const out = await this.applyEffects(tr, t.effects, { ticket, target });

      // The ticket's status is derived from its target set, so *any* target status
      // change can change it — not only one that enters a settled status. Excluding
      // a `failed` target is the case that made the narrower rule wrong: the target
      // leaves the participating set, which can complete the ticket, but it is a
      // move out of a settled status rather than into one. `done` is re-evaluated
      // for the same reason in reverse — Include can put work back on a ticket that
      // had settled. Doing this in the same transaction is what removes the
      // deferred "release the claim a second later" dance the old orchestrator
      // needed.
      if (t.to !== t.from && (ticket.status === 'running' || ticket.status === 'done')) {
        const after = await tr.listTargets(target.ticket_id);
        const settle = ticketTransition(ticket.status, { kind: 'targets_settled' }, {
          ticket,
          targets: after,
          mirror_labels: this.deps.cfg.mirror_labels,
          completed_state: this.deps.cfg.completed_state,
          labels: this.deps.cfg.labels,
        });
        if (settle.to !== ticket.status) {
          await tr.updateTicket(ticket.id, { ...settle.patch, status: settle.to });
          await tr.appendEvent({
            ticket_id: ticket.id,
            event_kind: 'targets_settled',
            from_status: settle.from,
            to_status: settle.to,
            actor: 'daemon',
          });
          out.push(...(await this.applyEffects(tr, settle.effects, { ticket, target: null })));
        }
      }

      return { transition: t, deferred: out };
    });

    await this.runDeferred(deferred);
    logger.debug('target transition', {
      target_id: targetId,
      event: event.kind,
      from: transition.from,
      to: transition.to,
    });
    return transition;
  }

  // ── effects ─────────────────────────────────────────────────────────────

  /**
   * Apply the effects a transition emitted.
   *
   * Tracker writes become outbox rows and control-plane bookkeeping is applied
   * here, both inside the caller's transaction. Effects that reach outside the
   * database are returned to be run after the commit.
   */
  private async applyEffects(
    tr: ControlStore,
    effects: readonly ControlEffect[],
    scope: { ticket: TicketRow; target: TargetRow | null },
  ): Promise<ControlEffect[]> {
    const deferred: ControlEffect[] = [];
    // From the ticket, not from config. The hub runs a service with no workspace of
    // its own — every action it takes addresses a ticket by id — so stamping rows
    // from config would file them under '' and no drainer would ever claim them.
    const workspace = scope.ticket.workspace;

    for (const effect of effects) {
      switch (effect.kind) {
        case 'tracker_set_state':
          await tr.enqueueOutbox({
            workspace,
            external_id: effect.external_id,
            op: 'set_state',
            payload: { state: effect.state },
          });
          break;
        case 'tracker_post_comment':
          await tr.enqueueOutbox({
            workspace,
            external_id: effect.external_id,
            op: 'post_comment',
            payload: { body: effect.body },
          });
          break;
        case 'tracker_apply_label':
          await tr.enqueueOutbox({
            workspace,
            external_id: effect.external_id,
            op: 'apply_label',
            payload: { label: effect.label },
          });
          break;
        case 'tracker_remove_label':
          await tr.enqueueOutbox({
            workspace,
            external_id: effect.external_id,
            op: 'remove_label',
            payload: { label: effect.label },
          });
          break;

        case 'replace_targets':
          await tr.replaceTargets(scope.ticket.id, effect.specs);
          break;

        case 'evaluate_target_readiness': {
          // Inline rather than deferred: an operator pressing Start expects the
          // unblocked targets to be `ready` by the time the response returns.
          const targets = await tr.listTargets(scope.ticket.id);
          for (const target of targets) {
            if (target.status !== 'blocked') continue;
            const { ready } = evaluateReadiness(
              scope.ticket,
              target,
              targets,
              this.deps.cfg.readiness,
            );
            if (!ready) continue;
            await tr.updateTarget(target.id, { status: 'ready' });
            await tr.appendEvent({
              ticket_id: scope.ticket.id,
              target_id: target.id,
              event_kind: 'blockers_satisfied',
              from_status: 'blocked',
              to_status: 'ready',
              actor: 'daemon',
            });
          }
          break;
        }

        case 'cancel_targets': {
          const targets = await tr.listTargets(scope.ticket.id);
          for (const target of targets) {
            if (isSettled(target.status) || target.status === 'excluded') continue;
            if (TARGET_LIVE_STATUSES.includes(target.status)) {
              // A live target's process may belong to another daemon, so raise
              // the flag and let its owner confirm.
              await tr.updateTarget(target.id, { cancel_requested: true });
              await tr.appendEvent({
                ticket_id: scope.ticket.id,
                target_id: target.id,
                event_kind: 'cancel_requested',
                from_status: target.status,
                to_status: target.status,
                actor: 'operator',
              });
            } else {
              await tr.updateTarget(target.id, {
                status: 'cancelled',
                completed_at: new Date().toISOString(),
              });
              await tr.appendEvent({
                ticket_id: scope.ticket.id,
                target_id: target.id,
                event_kind: 'cancel_requested',
                from_status: target.status,
                to_status: 'cancelled',
                actor: 'operator',
              });
            }
          }
          break;
        }

        // Everything below leaves the database. Deferred until after commit.
        case 'spawn_run':
        case 'kill_run':
        case 'approve_gate':
        case 'reject_gate':
        case 'create_blocker_issue':
          deferred.push(withScope(effect, scope));
          break;

        default: {
          const exhaustive: never = effect;
          logger.warn('Unhandled control effect', { effect: exhaustive });
        }
      }
    }
    return deferred;
  }

  /**
   * Run post-commit effects.
   *
   * Failures are logged, not thrown: the state change is already durable and
   * correct, and an executor that refuses to kill an already-dead run must not
   * turn a successful cancellation into a 500. Anything that genuinely needs
   * repair is visible in the target's status.
   */
  private async runDeferred(effects: readonly ControlEffect[]): Promise<void> {
    for (const effect of effects) {
      try {
        await this.runOne(effect);
      } catch (err) {
        logger.warn('Deferred control effect failed', {
          effect_kind: effect.kind,
          error: (err as Error).message,
        });
      }
    }
  }

  private async runOne(effect: ControlEffect): Promise<void> {
    switch (effect.kind) {
      case 'kill_run': {
        const ctx = scopeOf(effect);
        if (ctx) await this.deps.executor.killRun(effect.run_id, ctx);
        return;
      }
      case 'approve_gate': {
        const ctx = scopeOf(effect);
        if (ctx) {
          await this.deps.executor.approveGate({
            approval_id: effect.approval_id,
            run_id: effect.run_id,
            comment: effect.comment,
            ctx,
          });
        }
        return;
      }
      case 'reject_gate': {
        const ctx = scopeOf(effect);
        if (ctx) {
          await this.deps.executor.rejectGate({
            approval_id: effect.approval_id,
            run_id: effect.run_id,
            reason: effect.reason,
            ctx,
          });
        }
        return;
      }
      case 'create_blocker_issue': {
        const created = await this.deps.tracker.createBlockerIssue(
          effect.spec,
          effect.blocks_external_id,
        );
        const ctx = scopeOf(effect);
        if (created && ctx) {
          // Record it now rather than waiting for sync. The readiness sweep runs
          // later in the same tick; without this it sees no blockers and promotes
          // the target the operator just declared blocked, starting a second run on
          // the same worktree. Sync re-derives the list from the tracker after.
          await this.deps.store.addTicketBlocker(ctx.ticket.id, {
            id: created.external_id,
            identifier: created.identifier,
            state: null,
            labels: [],
          });
        }
        return;
      }
      case 'spawn_run':
        // Dispatch is driven by `claimAndDispatch`, which owns the atomic claim.
        // A transition emitting `spawn_run` is describing intent for the record;
        // acting on it here would dispatch without a claim.
        return;
      default:
        return;
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

const TARGET_PRE_DISPATCH_OR_SETTLED: readonly TargetStatus[] = [
  'excluded',
  'blocked',
  'ready',
  'failed',
  'cancelled',
];

/**
 * Carry the dispatch context on a deferred effect.
 *
 * A symbol key, so it cannot collide with a field of the effect and never
 * survives `JSON.stringify` — that part holds whatever the descriptor says.
 * Non-enumerable is for object copies and equality: a spread of an effect would
 * otherwise carry a whole ticket and target along with it, and `toEqual` in tests
 * would compare them.
 */
const SCOPE = Symbol('dispatch-scope');

function withScope(
  effect: ControlEffect,
  scope: { ticket: TicketRow; target: TargetRow | null },
): ControlEffect {
  if (!scope.target) return effect;
  const ctx: DispatchContext = { ticket: scope.ticket, target: scope.target };
  Object.defineProperty(effect, SCOPE, { value: ctx, enumerable: false, configurable: true });
  return effect;
}

function scopeOf(effect: ControlEffect): DispatchContext | null {
  return ((effect as unknown as Record<symbol, DispatchContext>)[SCOPE]) ?? null;
}

/** The event's payload, minus its discriminant, for the audit trail. */
function eventDetail(event: { kind: string } & Record<string, unknown>): Record<string, unknown> {
  const { kind, ...rest } = event;
  return rest;
}
