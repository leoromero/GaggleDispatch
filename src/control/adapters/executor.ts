/**
 * The workflow engine → control-plane executor ports.
 *
 * This replaced an adapter over Archon, and most of that file did not port — it
 * deleted. Everything it worked around was a consequence of the executor being
 * a separate process:
 *
 *   - the run id arrived asynchronously on a log line, so `spawnRun` returned
 *     null and the id was reported later. The engine creates the run row before
 *     it returns, so the id is known synchronously.
 *   - a gate pause looked like a successful exit (`archon` exits 0), so a clean
 *     exit had to be confirmed against the run's real status before it could be
 *     believed. The engine emits `run_gate_paused` as its own event.
 *   - approve stored the decision without resuming, so the human's comment
 *     never reached the workflow, which needed a second subprocess to fix.
 *     `decideAndWatch` does both in one call.
 *
 * What remains is the part that was always genuinely this file's job: turning
 * control rows into the shapes the worker speaks, and run events into
 * control-plane transitions.
 *
 * **The circular dependency, and how it is resolved.** A run's outcome has to
 * reach `ControlService`, but `ControlService` needs an `ExecutorPort` to be
 * constructed. So the adapter takes a *lazy* sink — `() => RunEventSink` — which
 * the composition root points at the service once both exist. Late binding, one
 * arrow, no framework.
 */

import type { Issue, IssueAnalysis, RepoTarget } from '../../domain/types.ts';
import { logger } from '../../util/logger.ts';
import type { GaggleExecutor } from '../../executor/engine/index.ts';
import type { RunEvent } from '../../executor/types.ts';
import type {
  DispatchContext,
  ExecutorPort,
  ObservedRunStatus,
  RunObservation,
  RunStatusPort,
  SpawnResult,
} from '../ports.ts';
import { InvalidControlTransitionError } from '../transitions.ts';
import type { TargetRow, TicketRow } from '../types.ts';

/**
 * What the adapter needs to report back. `ControlService` satisfies this
 * structurally; a test double can satisfy it in four lines.
 */
export interface RunEventSink {
  runStarted(targetId: string, runId: string | null): Promise<unknown>;
  runSucceeded(targetId: string): Promise<unknown>;
  runFailed(targetId: string, reason: string): Promise<unknown>;
  gateOpened(targetId: string, approvalId: string, message: string): Promise<unknown>;
  recordRunId(targetId: string, runId: string): Promise<unknown>;
}

/** Starts the worker. Injected so tests never launch a real run. */
export interface WorkerLauncher {
  (args: {
    ticket: TicketRow;
    target: TargetRow;
    issue: Issue;
    repo_target: RepoTarget;
    analysis: IssueAnalysis;
    callbacks: {
      onOutput: (line: string) => void;
      onRunId: (runId: string) => void;
      onGatePaused: (runId: string, message: string) => void;
      onExit: (event: { type: string; exit_code?: number }) => void;
    };
  }): Promise<{ cancel: (reason?: string) => void; run_id: string | null }>;
}

export interface EngineExecutorDeps {
  executor: GaggleExecutor;
  launch: WorkerLauncher;
  /** Resolved lazily — see the note at the top of this file. */
  sink: () => RunEventSink;
}

export class EngineExecutorAdapter implements ExecutorPort {
  /** Live run handles, keyed by target id, so cancellation can reach them. */
  private readonly live = new Map<string, { cancel: (reason?: string) => void }>();

  constructor(private readonly deps: EngineExecutorDeps) {}

  /** Whether this process still holds a handle for the target. For assertions. */
  hasLiveRun(targetId: string): boolean {
    return this.live.has(targetId);
  }

  async spawnRun(ctx: DispatchContext): Promise<SpawnResult> {
    const { ticket, target } = ctx;
    const repoTarget = repoTargetFrom(ticket, target);

    const handle = await this.deps.launch({
      ticket,
      target,
      issue: issueFromTicket(ticket),
      repo_target: repoTarget,
      analysis: analysisFrom(ticket, target, repoTarget),
      callbacks: {
        onOutput: () => {
          /* Telemetry is the orchestrator's concern, not the control plane's. */
        },
        onRunId: (id) => {
          void this.deps.sink().recordRunId(target.id, id).catch((err) => {
            logger.warn('Could not record the run id', { error: (err as Error).message });
          });
        },
        onGatePaused: (id, message) => {
          void this.onGatePaused(target.id, id, message);
        },
        onExit: (event) => {
          this.live.delete(target.id);
          void this.onExit(target.id, event);
        },
      },
    });

    this.live.set(target.id, handle);
    // From the launcher's return value, not from the `onRunId` callback. The
    // engine writes the run row inside `startRun`, but it emits `run_started`
    // from inside the run loop, which `startRun` does not await — so the
    // callback lands *after* this returns, and reading it here always yielded
    // null. A null run id makes the target invisible to `reconcileRuns` and
    // hands it to the orphan sweep, which requeues and re-dispatches it a
    // couple of minutes into a perfectly healthy run.
    return { run_id: handle.run_id };
  }

  async killRun(runId: string | null, ctx: DispatchContext): Promise<void> {
    const handle = this.live.get(ctx.target.id);
    if (handle) {
      handle.cancel('cancelled by operator');
      this.live.delete(ctx.target.id);
    }
    // Cancel by id as well. The in-memory handle only exists in the process that
    // started the run, so a target cancelled after a restart — or one parked at
    // a gate, whose runner has already returned — has no handle to reach.
    if (runId) {
      try {
        await this.deps.executor.cancel(runId, 'cancelled by operator');
      } catch (err) {
        // Already gone is the common case and is not a failure.
        logger.debug('cancel did not apply', { run_id: runId, error: (err as Error).message });
      }
    }
  }

  approveGate(args: {
    approval_id: string | null;
    run_id: string | null;
    comment: string | null;
    ctx: DispatchContext;
  }): Promise<void> {
    return this.decide('approved', args.run_id, args.comment, args.ctx);
  }

  rejectGate(args: {
    approval_id: string | null;
    run_id: string | null;
    reason: string;
    ctx: DispatchContext;
  }): Promise<void> {
    return this.decide('rejected', args.run_id, args.reason, args.ctx);
  }

  /**
   * Answer the gate and follow the resumed run.
   *
   * Rejection is watched exactly like approval, because it is not the end of the
   * run: the workflow's `on_reject` prompt reworks and parks at the same gate
   * again. A caller that only watched approvals would never hear the second
   * question, and the target would sit `running` with nobody waiting on it.
   */
  private async decide(
    decision: 'approved' | 'rejected',
    runId: string | null,
    comment: string | null,
    ctx: DispatchContext,
  ): Promise<void> {
    if (!runId) {
      logger.warn('Cannot answer a gate with no run id', {
        repo_alias: ctx.target.repo_alias,
        decision,
      });
      return;
    }
    const targetId = ctx.target.id;

    const handle = await this.deps.executor.decideAndWatch(runId, decision, comment, (e) =>
      this.onRunEvent(targetId, e),
    );
    if (!handle) {
      // No pending gate: another surface answered first, or the run moved on.
      logger.warn('No gate to answer', { run_id: runId, target_id: targetId, decision });
      return;
    }
    this.live.set(targetId, { cancel: handle.cancel });
    void handle.done.then(() => this.live.delete(targetId));
  }

  // ── event handling ──────────────────────────────────────────────────────

  /** Engine events from a resumed run, routed the same way a fresh run's are. */
  private onRunEvent(targetId: string, e: RunEvent): void {
    switch (e.type) {
      case 'run_gate_paused':
        void this.onGatePaused(targetId, e.run_id, e.gate_message);
        break;
      case 'run_succeeded':
        void this.onExit(targetId, { type: 'run_succeeded' });
        break;
      case 'run_failed':
        void this.onExit(targetId, { type: e.type, error: e.error });
        break;
      case 'run_timed_out':
      case 'run_cancelled':
        void this.onExit(targetId, { type: e.type });
        break;
      default:
        break;
    }
  }

  private async onGatePaused(targetId: string, runId: string, message: string): Promise<void> {
    try {
      // The engine's approval row has an id of its own, but the control plane
      // only ever hands this value back to `decideAndWatch`, which looks the
      // gate up by run. The run id is the stable thing to use.
      await this.deps.sink().recordRunId(targetId, runId);
      await this.deps.sink().gateOpened(targetId, runId, message);
    } catch (err) {
      logger.error('Could not open the gate in the control plane', {
        target_id: targetId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Translate a run outcome into a control-plane event.
   *
   * No status confirmation here, unlike the adapter this replaced: the engine
   * distinguishes a pause from a completion with its own event, so a
   * `run_succeeded` really is one.
   */
  private async onExit(
    targetId: string,
    event: { type: string; error?: string },
  ): Promise<void> {
    // Reached from a fire-and-forget event callback, so an escaping rejection is
    // unhandled and Bun terminates the daemon. It *will* escape on the ordinary
    // Cancel path: `cancel_confirmed` commits `cancelled`, then kills the run,
    // which reports `run_cancelled` — and `run_failed` is not accepted from
    // `cancelled`. A refused transition means the outcome was already recorded,
    // which is not an error.
    //
    // Only that is benign, so only that is downgraded. Catching everything would
    // report a store outage, or a bug here, as a routine race — the log would
    // say the outcome was recorded when nothing recorded it, and the target
    // would sit `running` with no explanation anywhere.
    try {
      const sink = this.deps.sink();
      if (event.type === 'run_succeeded') {
        await sink.runSucceeded(targetId);
      } else {
        // The engine's error, when it gave one. Reporting the bare event name
        // put `Reason: \`run_failed\`` on every failed target's tracker
        // comment while the actual message sat unused in the event.
        await sink.runFailed(targetId, event.error ?? event.type);
      }
    } catch (err) {
      if (err instanceof InvalidControlTransitionError) {
        logger.warn('Ignoring a run outcome the control plane had already accounted for', {
          target_id: targetId,
          event: event.type,
          error: err.message,
        });
        return;
      }
      logger.error('Could not record a run outcome', {
        target_id: targetId,
        event: event.type,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Reads a run's current status straight from the store.
 *
 * The reconciler uses this to settle targets whose events it missed — a run
 * that finished while this process was down, most often. `unknown` is
 * deliberately distinct from `failed`: a run the store has no row for is not
 * evidence that the work failed.
 */
export class EngineRunStatusAdapter implements RunStatusPort {
  constructor(private readonly executor: GaggleExecutor) {}

  async observeRun(runId: string): Promise<RunObservation> {
    const run = await this.executor.getRun(runId);
    if (!run) return { status: 'unknown' };

    const status = mapStatus(run.status);
    if (status === 'paused') {
      const approval = run.metadata?.approval;
      return {
        status,
        approval: { id: runId, message: approval?.message ?? 'Awaiting approval' },
      };
    }
    return { status };
  }
}

function mapStatus(s: string): ObservedRunStatus {
  switch (s) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return s;
    // `interrupted` means an executor died mid-run and the startup sweep has not
    // adopted it yet. It is neither finished nor progressing, and reporting it
    // as failed would settle a target the sweep is about to resume.
    default:
      return 'unknown';
  }
}

// ─── shape translation ──────────────────────────────────────────────────────
//
// The worker layer predates the control plane and speaks `Issue` / `RepoTarget` /
// `IssueAnalysis`. Rather than rewrite it, these build those shapes from control
// rows. Keeping the translation in one place means the worker can be retired
// wholesale later without hunting for it.

export function issueFromTicket(ticket: TicketRow): Issue {
  return {
    id: ticket.external_id,
    identifier: ticket.identifier,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    state: ticket.external_state,
    branch_name: ticket.branch_name,
    url: ticket.url,
    labels: ticket.external_labels,
    blocked_by: ticket.blocked_by,
    created_at: ticket.external_created_at,
    updated_at: ticket.external_updated_at,
    parent_id: ticket.parent_external_id,
  };
}

export function repoTargetFrom(ticket: TicketRow, target: TargetRow): RepoTarget {
  return {
    repo_url: target.repo_url,
    repo_alias: target.repo_alias,
    local_path: target.local_path,
    workflow: target.workflow,
    rationale: target.rationale ?? ticket.title,
    components: target.components,
    depends_on: target.depends_on,
    ready_when: target.ready_when ?? undefined,
  };
}

function analysisFrom(ticket: TicketRow, target: TargetRow, repoTarget: RepoTarget): IssueAnalysis {
  return {
    issue_id: ticket.external_id,
    analysis_summary: ticket.analysis_summary ?? '',
    repo_targets: [repoTarget],
    complexity: ticket.complexity ?? undefined,
  };
}
