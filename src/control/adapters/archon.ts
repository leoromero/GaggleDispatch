/**
 * Archon → control-plane executor ports.
 *
 * The control plane knows a target has an opaque `run_id` and that four
 * operations exist. This file is where that meets the current reality: an
 * out-of-process CLI whose run id arrives asynchronously on a log line, whose
 * gate pauses look like a successful exit, and whose approve path is a
 * subprocess rather than an HTTP call.
 *
 * All of that ugliness lives here, behind `ExecutorPort` and `RunStatusPort`.
 * When the in-house engine lands it replaces this file and nothing above it
 * changes — which is the entire reason the ports exist.
 *
 * **The circular dependency, and how it is resolved.** A run's outcome has to
 * reach `ControlService`, but `ControlService` needs an `ExecutorPort` to be
 * constructed. So the adapter takes a *lazy* sink — `() => RunEventSink` — which
 * the composition root points at the service once both exist. Late binding, one
 * arrow, no framework.
 */

import type { ServiceConfig, Issue, IssueAnalysis, RepoTarget } from '../../domain/types.ts';
import { logger } from '../../util/logger.ts';
import { approveAndResumeArchon } from '../../executor/archon.ts';
import type { ArchonClient } from '../../executor/archon-client.ts';
import type {
  DispatchContext,
  ExecutorPort,
  ObservedRunStatus,
  RunObservation,
  RunStatusPort,
  SpawnResult,
} from '../ports.ts';
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

/** Spawns the worker subprocess. Injected so tests never launch a real Archon. */
export interface WorkerLauncher {
  (args: {
    ticket: TicketRow;
    target: TargetRow;
    issue: Issue;
    repo_target: RepoTarget;
    analysis: IssueAnalysis;
    callbacks: {
      onStarted: (pid: number) => void;
      onOutput: (line: string) => void;
      onRunId: (runId: string) => void;
      onGatePaused: (runId: string, message: string) => void;
      onExit: (event: { type: string; exit_code?: number }) => void;
    };
  }): Promise<{ cancel: (reason?: string) => void }>;
}

export interface ArchonExecutorDeps {
  cfg: ServiceConfig;
  client: ArchonClient;
  launch: WorkerLauncher;
  /** Resolved lazily — see the note at the top of this file. */
  sink: () => RunEventSink;
}

export class ArchonExecutorAdapter implements ExecutorPort {
  /** Live subprocess handles, keyed by target id, so cancellation can reach them. */
  private readonly live = new Map<string, { cancel: (reason?: string) => void }>();

  constructor(private readonly deps: ArchonExecutorDeps) {}

  async spawnRun(ctx: DispatchContext): Promise<SpawnResult> {
    const { ticket, target } = ctx;
    const issue = issueFromTicket(ticket);
    const repoTarget = repoTargetFrom(ticket, target);
    const analysis = analysisFrom(ticket, target, repoTarget);

    // Archon reports its run id on a log line some seconds after launch, so this
    // resolves with null and the id arrives through `recordRunId`. The target is
    // `running` either way: a live process with no id yet is not a different state.
    let reportedRunId: string | null = null;

    const handle = await this.deps.launch({
      ticket,
      target,
      issue,
      repo_target: repoTarget,
      analysis,
      callbacks: {
        onStarted: (pid) => {
          logger.info('Worker started', { repo_alias: target.repo_alias, pid });
        },
        onOutput: () => {
          /* Telemetry is the orchestrator's concern, not the control plane's. */
        },
        onRunId: (runId) => {
          reportedRunId = runId;
          void this.deps.sink().recordRunId(target.id, runId).catch((err) => {
            logger.warn('Could not record the run id', { error: (err as Error).message });
          });
        },
        onGatePaused: (runId, message) => {
          void this.onGatePaused(target.id, runId, message);
        },
        onExit: (event) => {
          this.live.delete(target.id);
          void this.onExit(target.id, event, () => reportedRunId);
        },
      },
    });

    this.live.set(target.id, handle);
    return { run_id: null };
  }

  async killRun(runId: string | null, ctx: DispatchContext): Promise<void> {
    const handle = this.live.get(ctx.target.id);
    if (handle) {
      handle.cancel('cancelled by operator');
      this.live.delete(ctx.target.id);
    }
    // Also cancel in Archon: the subprocess may be gone (a restart, or a gate
    // pause that already exited) while the run itself is still alive there.
    if (runId) {
      try {
        await this.deps.client.cancelRun(runId);
      } catch (err) {
        // Already gone is the common case and is not a failure.
        logger.debug('Archon cancelRun did not apply', {
          run_id: runId,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Approve and resume.
   *
   * Archon's HTTP `approveRun` stores the decision without resuming, so the
   * comment would never reach the workflow as `$<gate-id>.output`. The CLI path
   * does both, which is why this shells out rather than calling the API.
   */
  async approveGate(args: {
    approval_id: string | null;
    run_id: string | null;
    comment: string | null;
    ctx: DispatchContext;
  }): Promise<void> {
    const runId = args.run_id;
    if (!runId) {
      logger.warn('Cannot approve a gate with no run id', { repo_alias: args.ctx.target.repo_alias });
      return;
    }
    const targetId = args.ctx.target.id;

    const handle = approveAndResumeArchon(
      this.deps.cfg.archon.command,
      runId,
      args.comment ?? undefined,
      this.deps.cfg.archon.turn_timeout_ms,
      (e) => {
        if (e.type === 'archon_gate_paused') {
          void this.onGatePaused(targetId, e.run_id, e.gate_message);
        } else if (
          e.type === 'archon_succeeded' ||
          e.type === 'archon_failed' ||
          e.type === 'archon_timed_out' ||
          e.type === 'archon_stalled' ||
          e.type === 'archon_cancelled'
        ) {
          this.live.delete(targetId);
          void this.onExit(targetId, { type: e.type }, () => runId);
        }
      },
    );
    this.live.set(targetId, { cancel: handle.cancel });
  }

  async rejectGate(args: {
    approval_id: string | null;
    run_id: string | null;
    reason: string;
    ctx: DispatchContext;
  }): Promise<void> {
    if (!args.run_id) return;
    await this.deps.client.rejectRun(args.run_id, args.reason);
  }

  // ── event handling ──────────────────────────────────────────────────────

  private async onGatePaused(targetId: string, runId: string, message: string): Promise<void> {
    try {
      // Archon has no approval id of its own, so the run id doubles as one. The
      // control plane only ever hands it back, so any stable string works.
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
   * Translate a worker exit into a control-plane event.
   *
   * The subtlety that has to survive: **Archon exits 0 when a workflow pauses at
   * an approval gate.** Reporting that as success would mark a target succeeded
   * halfway through its workflow, so a clean exit is confirmed against the run's
   * actual status before it is believed.
   */
  private async onExit(
    targetId: string,
    event: { type: string; exit_code?: number },
    runId: () => string | null,
  ): Promise<void> {
    const sink = this.deps.sink();
    const id = runId();

    if (event.type === 'archon_succeeded') {
      if (!id) {
        // Exited 0 without ever logging a run id: the workflow never started.
        await sink.runFailed(targetId, 'archon exited 0 without starting a workflow');
        return;
      }
      try {
        const detail = await this.deps.client.getRunDetail(id);
        const status = detail?.run?.status;
        if (status === 'paused') {
          const message = detail?.run?.metadata?.approval?.message ?? 'Awaiting approval';
          await this.onGatePaused(targetId, id, message);
          return;
        }
        if (status === 'failed' || status === 'cancelled') {
          await sink.runFailed(targetId, `archon run ${status}`);
          return;
        }
      } catch (err) {
        // Cannot verify. Trusting the exit code is the lesser risk: the
        // reconciler will correct it on the next tick if the run is really paused.
        logger.warn('Could not verify a clean exit against the run status', {
          run_id: id,
          error: (err as Error).message,
        });
      }
      await sink.runSucceeded(targetId);
      return;
    }

    await sink.runFailed(targetId, event.type);
  }

  /** Whether this process holds a live subprocess for a target. */
  hasLiveRun(targetId: string): boolean {
    return this.live.has(targetId);
  }
}

/**
 * Read side: what Archon currently believes about a run.
 *
 * Maps Archon's vocabulary onto the control plane's, and — importantly — maps
 * "never heard of it" to `unknown` rather than `failed`. After a restart, a run
 * the executor cannot find is not evidence that the work failed.
 */
export class ArchonRunStatusAdapter implements RunStatusPort {
  constructor(private readonly client: ArchonClient) {}

  async observeRun(runId: string): Promise<RunObservation> {
    const detail = await this.client.getRunDetail(runId);
    const run = detail?.run;
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
    default:
      return 'unknown';
  }
}

// ─── shape translation ──────────────────────────────────────────────────────
//
// The worker layer predates the control plane and speaks `Issue` / `RepoTarget` /
// `IssueAnalysis`. Rather than rewrite it, these build those shapes from control
// rows. Keeping the translation in one place — and out of the worker — means the
// worker can be retired wholesale with the rest of the old path.

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
    archon_workflow: target.workflow,
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
