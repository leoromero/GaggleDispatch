/**
 * The daemon loop.
 *
 * What this replaces is worth stating: today's tick fetches candidate issues,
 * decides which are eligible, and dispatches them. This one decides nothing about
 * *what* to work on. It reconciles — it drains work an operator has already
 * marked `ready`, reflects run outcomes back into the tables, and honours
 * cancellations. Every "should this run?" question was answered by a human
 * pressing a button.
 *
 * Each step is independently callable and idempotent, so a step that throws
 * cannot stop the others and a tick that dies halfway leaves nothing corrupt.
 */

import { logger } from '../util/logger.ts';
import { OutboxDrainer, type OutboxDrainerConfig } from './outbox.ts';
import type {
  RunStatusPort,
  SlotPort,
  TrackerStructurePort,
  TrackerWritePort,
} from './ports.ts';
import type { ControlService } from './service.ts';
import type { ControlStore } from './store/types.ts';
import { TARGET_LIVE_STATUSES, isSettled, type TargetRow } from './types.ts';

export interface ReconcilerConfig {
  workspace: string;
  /**
   * How long an open gate may sit before the target fails. Zero disables the
   * timeout, which is the default and almost certainly right under operator
   * control: a gate that waits is a gate doing its job.
   */
  gate_timeout_ms: number;
  outbox: OutboxDrainerConfig;
}

export interface ReconcilerDeps {
  store: ControlStore;
  service: ControlService;
  /** Used only by ensureSubIssues. */
  tracker: TrackerStructurePort;
  slots: SlotPort;
  runs: RunStatusPort;
  trackerWrites: TrackerWritePort;
  cfg: ReconcilerConfig;
}

export interface TickResult {
  analyzed: number;
  sub_issues: number;
  dispatched: number;
  promoted: number;
  reconciled: number;
  cancelled: number;
  gates_answered: number;
  gates_timed_out: number;
  outbox_sent: number;
}

const ZERO: TickResult = {
  analyzed: 0,
  sub_issues: 0,
  dispatched: 0,
  promoted: 0,
  reconciled: 0,
  cancelled: 0,
  gates_answered: 0,
  gates_timed_out: 0,
  outbox_sent: 0,
};

export class Reconciler {
  private readonly outboxDrainer: OutboxDrainer;

  constructor(private readonly deps: ReconcilerDeps) {
    this.outboxDrainer = new OutboxDrainer(deps.store, deps.trackerWrites, deps.cfg.outbox);
  }

  /**
   * One pass.
   *
   * Ordering is deliberate: reconcile before dispatching so a slot freed by a
   * finished run is usable in the same tick, and promote before draining so a
   * target unblocked by that run can be picked up immediately.
   */
  async tick(): Promise<TickResult> {
    const result: TickResult = { ...ZERO };

    result.analyzed = await this.step('drainAnalysisRequests', () => this.drainAnalysisRequests());
    result.sub_issues = await this.step('ensureSubIssues', () => this.ensureSubIssues());
    result.gates_answered = await this.step('applyGateDecisions', () => this.applyGateDecisions());
    result.reconciled = await this.step('reconcileRuns', () => this.reconcileRuns());
    result.cancelled = await this.step('applyCancelRequests', () => this.applyCancelRequests());
    result.gates_timed_out = await this.step('sweepGateTimeouts', () => this.sweepGateTimeouts());
    result.promoted = await this.step('promoteBlockedTargets', () => this.promoteBlockedTargets());
    result.dispatched = await this.step('drainReadyTargets', () => this.drainReadyTargets());
    result.outbox_sent = await this.step('drainOutbox', () => this.drainOutbox());

    return result;
  }

  /**
   * Run one step, logging and swallowing its failure.
   *
   * A step that throws must not take the rest of the tick with it: a tracker
   * outage should not stop runs from being reconciled, and an executor hiccup
   * should not stop the outbox from draining.
   */
  private async step(name: string, fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch (err) {
      logger.error('Reconciler step failed', { step: name, error: (err as Error).message });
      return 0;
    }
  }

  // ── steps ───────────────────────────────────────────────────────────────

  /**
   * How many more runs may start.
   *
   * Counted from the store, not from this process's memory, so the ceiling
   * survives a restart. `gate_waiting` counts as live: a paused run still holds
   * its worktree, and treating it as free would push concurrency past the limit
   * every time a supervised workflow stops for a human.
   */
  private async availableSlots(): Promise<number> {
    const live = await this.deps.store.listTargetsByStatus(
      TARGET_LIVE_STATUSES,
      this.deps.cfg.workspace,
    );
    return this.deps.slots.availableSlots(live.length);
  }

  /** Claim tickets an operator asked to analyze, and analyze them. */
  async drainAnalysisRequests(): Promise<number> {
    const slots = await this.availableSlots();
    if (slots <= 0) return 0;
    const claimed = await this.deps.service.claimAnalysisWork(slots);
    for (const ticket of claimed) {
      await this.deps.service.runAnalysis(ticket);
    }
    return claimed.length;
  }

  /**
   * Reflect executor state onto targets this process may not have started.
   *
   * Only consulted for targets whose run the control plane believes is live. An
   * `unknown` observation is left alone rather than treated as a failure: after a
   * restart, "the executor has not heard of this run" is not evidence that the
   * work failed, and inventing a failure would post a false comment on the
   * tracker. The startup sweep handles genuinely orphaned runs.
   */
  async reconcileRuns(): Promise<number> {
    const live = await this.deps.store.listTargetsByStatus(
      ['running', 'gate_waiting'],
      this.deps.cfg.workspace,
    );
    let changed = 0;

    for (const target of live) {
      if (!target.run_id) continue;
      let observed;
      try {
        observed = await this.deps.runs.observeRun(target.run_id);
      } catch (err) {
        logger.warn('Could not observe run', {
          run_id: target.run_id,
          repo_alias: target.repo_alias,
          error: (err as Error).message,
        });
        continue;
      }

      switch (observed.status) {
        case 'completed':
          if (target.status !== 'succeeded') {
            await this.deps.service.runSucceeded(target.id);
            changed++;
          }
          break;
        case 'failed':
          await this.deps.service.runFailed(target.id, observed.error ?? 'run failed');
          changed++;
          break;
        case 'cancelled':
          await this.deps.service.confirmCancel(target.id);
          changed++;
          break;
        case 'paused':
          if (target.status === 'running' && observed.approval) {
            await this.deps.service.gateOpened(
              target.id,
              observed.approval.id,
              observed.approval.message,
            );
            changed++;
          }
          break;
        case 'running':
          // A gate the executor has resumed without telling us: the control plane
          // thinks a gate is open but the run is moving again. Trust the executor.
          if (target.status === 'gate_waiting') {
            await this.deps.service.approveGate(target.id, null);
            changed++;
          }
          break;
        case 'pending':
        case 'unknown':
          break;
      }
    }
    return changed;
  }

  /**
   * Create tracker sub-issues for multi-repo fan-outs.
   *
   * The fan-out lives in `ticket_targets` and nothing reads a sub-issue back, so
   * these exist purely so the team can see per-repo progress in the tracker. Only
   * created for genuine fan-outs: with one participating target the ticket *is*
   * the target's tracker issue, and a sub-issue would be noise.
   *
   * Idempotent — a target that already has an `external_target_id` is skipped —
   * so a crash between creating the issue and recording its id costs one orphaned
   * sub-issue, not a duplicate on every tick.
   */
  async ensureSubIssues(): Promise<number> {
    const running = await this.deps.store.listTickets({
      workspace: this.deps.cfg.workspace,
      status: ['running'],
    });
    let created = 0;

    for (const ticket of running) {
      const targets = (await this.deps.store.listTargets(ticket.id)).filter(
        (t) => t.status !== 'excluded',
      );
      if (targets.length < 2) continue;

      for (const target of targets) {
        if (target.external_target_id) continue;
        if (isSettled(target.status)) continue;
        try {
          const sub = await this.deps.tracker.createSubIssue({ ticket, target });
          await this.deps.store.updateTarget(target.id, {
            external_target_id: sub.external_id,
            external_target_url: sub.url,
          });
          await this.deps.store.appendEvent({
            ticket_id: ticket.id,
            target_id: target.id,
            event_kind: 'sub_issue_created',
            from_status: target.status,
            to_status: target.status,
            actor: 'daemon',
            detail: { external_id: sub.external_id, url: sub.url },
          });
          created++;
        } catch (err) {
          // Visibility is a nicety; work proceeds without it.
          logger.warn('Could not create a sub-issue', {
            identifier: ticket.identifier,
            repo_alias: target.repo_alias,
            error: (err as Error).message,
          });
        }
      }
    }
    return created;
  }

  /**
   * Carry out gate answers an operator recorded in the dashboard.
   *
   * The dashboard cannot do this itself: answering a gate means resuming a run,
   * and only the process holding the executor can. So the decision is written as
   * intent and converted here, which also means an answer given while the daemon
   * was down is honoured when it comes back.
   */
  async applyGateDecisions(): Promise<number> {
    const pending = await this.deps.store.listGateDecisions(this.deps.cfg.workspace);
    let answered = 0;

    for (const target of pending) {
      const comment = target.gate_decision_comment;
      try {
        switch (target.gate_decision) {
          case 'approved':
            await this.deps.service.approveGate(target.id, comment);
            break;
          case 'rejected':
            await this.deps.service.rejectGate(target.id, comment ?? 'rejected without a reason');
            break;
          case 'blocker': {
            const blocker = parseBlocker(comment);
            if (!blocker) {
              logger.warn('Gate blocker decision had an unreadable payload; treating as a rejection', {
                target_id: target.id,
              });
              await this.deps.service.rejectGate(target.id, 'blocker requested, but its details were unreadable');
              break;
            }
            await this.deps.service.createGateBlocker(target.id, blocker);
            break;
          }
          default:
            continue;
        }
        answered++;
      } catch (err) {
        logger.warn('Could not apply a gate decision', {
          target_id: target.id,
          decision: target.gate_decision,
          error: (err as Error).message,
        });
      } finally {
        // Clear the intent either way. A decision that cannot be applied must not
        // be retried on every tick — the target's status shows what happened.
        await this.deps.store.updateTarget(target.id, {
          gate_decision: null,
          gate_decision_comment: null,
          gate_decision_at: null,
        });
      }
    }
    return answered;
  }

  /** Kill the processes behind targets an operator asked to cancel. */
  async applyCancelRequests(): Promise<number> {
    const pending = await this.deps.store.listCancelRequested(this.deps.cfg.workspace);
    let cancelled = 0;
    for (const target of pending) {
      try {
        await this.deps.service.confirmCancel(target.id);
        cancelled++;
      } catch (err) {
        logger.warn('Could not confirm cancellation', {
          target_id: target.id,
          error: (err as Error).message,
        });
      }
    }
    return cancelled;
  }

  /** Fail gates that have been open too long, when a timeout is configured. */
  async sweepGateTimeouts(): Promise<number> {
    if (this.deps.cfg.gate_timeout_ms <= 0) return 0;
    const gates = await this.deps.store.listPendingGates(this.deps.cfg.workspace);
    const cutoff = Date.now() - this.deps.cfg.gate_timeout_ms;
    let timedOut = 0;
    for (const gate of gates) {
      if (Date.parse(gate.gate_opened_at) > cutoff) continue;
      await this.deps.service.gateTimedOut(gate.target_id);
      timedOut++;
      logger.warn('Gate timed out', {
        identifier: gate.identifier,
        repo_alias: gate.repo_alias,
        opened_at: gate.gate_opened_at,
      });
    }
    return timedOut;
  }

  /**
   * Move targets between `blocked` and `ready` as their dependencies change.
   *
   * Runs both directions: a target whose upstream regressed goes back to
   * `blocked`, which is why this is a reconciliation rather than a one-shot
   * promotion.
   */
  async promoteBlockedTargets(): Promise<number> {
    const candidates = await this.deps.store.listTargetsByStatus(
      ['blocked', 'ready'],
      this.deps.cfg.workspace,
    );
    const ticketIds = [...new Set(candidates.map((t) => t.ticket_id))];
    let moved = 0;
    for (const ticketId of ticketIds) {
      const before = await this.statusesOf(ticketId);
      await this.deps.service.evaluateReadiness(ticketId);
      const after = await this.statusesOf(ticketId);
      for (const [id, status] of after) {
        if (before.get(id) !== status) moved++;
      }
    }
    return moved;
  }

  /** Start runs for as many ready targets as there are free slots. */
  async drainReadyTargets(): Promise<number> {
    const slots = await this.availableSlots();
    if (slots <= 0) return 0;
    const dispatched = await this.deps.service.claimAndDispatch(slots);
    return dispatched.length;
  }

  async drainOutbox(): Promise<number> {
    const { sent } = await this.outboxDrainer.drain();
    return sent;
  }

  // ── startup ─────────────────────────────────────────────────────────────

  /**
   * Recover from a crash. This is what replaces reading `gaggle:*` labels back
   * off the tracker and classifying them.
   *
   * A target left in `dispatching` never had a process: the status is written and
   * committed before the spawn, precisely so this case is unambiguous. Return it
   * to `ready` and let the drain pick it up. Targets in `running` or
   * `gate_waiting` keep their run id and are handled by `reconcileRuns`, which
   * asks the executor what actually happened rather than guessing.
   */
  async recoverOnStartup(): Promise<{ requeued: number; adopted: number }> {
    const stranded = await this.deps.store.listTargetsByStatus(['dispatching'], this.deps.cfg.workspace);
    let requeued = 0;
    for (const target of stranded) {
      await this.deps.store.updateTarget(target.id, {
        status: 'ready',
        attempt: target.attempt + 1,
      });
      await this.deps.store.appendEvent({
        ticket_id: target.ticket_id,
        target_id: target.id,
        event_kind: 'requeued_after_restart',
        from_status: 'dispatching',
        to_status: 'ready',
        actor: 'daemon',
        detail: { reason: 'no process was ever spawned for this claim' },
      });
      requeued++;
    }

    const adopted = (
      await this.deps.store.listTargetsByStatus(['running', 'gate_waiting'], this.deps.cfg.workspace)
    ).filter((t) => t.run_id !== null);

    if (requeued > 0 || adopted.length > 0) {
      logger.info('Control-plane recovery complete', {
        requeued,
        adopted: adopted.length,
      });
    }
    return { requeued, adopted: adopted.length };
  }

  /** Live targets this process is responsible for. Used for slot accounting. */
  async liveTargets(): Promise<TargetRow[]> {
    return this.deps.store.listTargetsByStatus(TARGET_LIVE_STATUSES, this.deps.cfg.workspace);
  }

  private async statusesOf(ticketId: string): Promise<Map<string, string>> {
    const targets = await this.deps.store.listTargets(ticketId);
    return new Map(targets.map((t) => [t.id, t.status]));
  }
}

/** A blocker decision carries its title and description as JSON in the comment. */
function parseBlocker(comment: string | null): { title: string; description: string } | null {
  if (!comment) return null;
  try {
    const parsed = JSON.parse(comment) as { title?: unknown; description?: unknown };
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) return null;
    return {
      title: parsed.title,
      description: typeof parsed.description === 'string' ? parsed.description : '',
    };
  } catch {
    return null;
  }
}
