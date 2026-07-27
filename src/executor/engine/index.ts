/**
 * GaggleExecutor — the `WorkflowExecutor` implementation.
 *
 * Owns run lifecycle: creating rows, building a runner per attempt, and
 * translating approve/reject into a resumed run. The runner owns execution;
 * this owns everything around it.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '../../util/logger.ts';
import type {
  NodeRecord,
  ResumeOptions,
  RunEventHandler,
  RunFilter,
  RunHandle,
  RunRecord,
  StartRunRequest,
  WorkflowExecutor,
} from '../types.ts';
import type { RunRow, Store } from '../store/types.ts';
import { CommandResolver } from './commands.ts';
import { claudeRunner, type AiRunner } from './provider/claude.ts';
import { resolveWorkflow, workflowSearchPaths } from './registry.ts';
import type { WorkflowDef } from './schema.ts';
import {
  DEFAULT_RUNNER_CONFIG,
  LEASE_OWNER,
  WorkflowRunner,
  type PendingDecision,
  type RunnerConfig,
} from './runner.ts';
import { detectDefaultBranch } from './isolation.ts';

export interface GaggleExecutorOptions {
  store: Store;
  /** Root under which per-run artifact directories are created. */
  artifactsRoot: string;
  config?: Partial<RunnerConfig>;
  /** Injectable for tests; defaults to the Claude Agent SDK. */
  ai?: AiRunner;
  /** Extra workflow search roots, after the checkout's `.gaggle/workflows`. */
  extraWorkflowDirs?: string[];
  bashPath?: string;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run '${runId}' not found`);
    this.name = 'RunNotFoundError';
  }
}

export class WorkflowChangedError extends Error {
  constructor(runId: string) {
    super(
      `the workflow changed since run '${runId}' started. Resuming would mix outputs from two ` +
        `versions — pass force to discard cached node outputs and start the graph over.`,
    );
    this.name = 'WorkflowChangedError';
  }
}

export class GatePendingError extends Error {
  readonly node_id: string;
  constructor(runId: string, nodeId: string) {
    super(
      `run '${runId}' is waiting on the gate at '${nodeId}'. Approve or reject it — resuming ` +
        `would step past the question unanswered.`,
    );
    this.name = 'GatePendingError';
    this.node_id = nodeId;
  }
}

export class GaggleExecutor implements WorkflowExecutor {
  private readonly store: Store;
  private readonly artifactsRoot: string;
  private readonly config: RunnerConfig;
  private readonly ai: AiRunner;
  private readonly extraWorkflowDirs: string[];
  private readonly bashPath?: string;
  /** Live runners, so cancel can reach an in-flight run. */
  private readonly active = new Map<string, { runner: WorkflowRunner; done: Promise<void> }>();

  constructor(opts: GaggleExecutorOptions) {
    this.store = opts.store;
    this.artifactsRoot = opts.artifactsRoot;
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...opts.config };
    this.ai = opts.ai ?? claudeRunner;
    this.extraWorkflowDirs = opts.extraWorkflowDirs ?? [];
    this.bashPath = opts.bashPath;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  private toRecord(row: RunRow): RunRecord {
    return {
      id: row.id,
      workflow_name: row.workflow_name,
      user_message: row.user_message,
      status: row.status,
      working_path: row.working_path,
      repo_slug: row.repo_slug,
      branch: row.branch,
      started_at: row.started_at,
      completed_at: row.completed_at,
      last_activity_at: row.last_activity_at,
      metadata: row.metadata,
    };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await this.store.getRun(runId);
    return row ? this.toRecord(row) : null;
  }

  async listRuns(filter: RunFilter = {}): Promise<RunRecord[]> {
    const rows = await this.store.listRuns(filter);
    return rows.map((r) => this.toRecord(r));
  }

  async getNodes(runId: string): Promise<NodeRecord[]> {
    const rows = await this.store.getNodes(runId);
    return rows.map((r) => ({
      run_id: r.run_id,
      node_id: r.node_id,
      node_type: r.node_type,
      status: r.status,
      attempt: r.attempt,
      output: r.output,
      output_json: r.output_json,
      error: r.error,
      side_effects: r.side_effects,
      started_at: r.started_at,
      completed_at: r.completed_at,
    }));
  }

  // ── start ─────────────────────────────────────────────────────────────────

  async startRun(req: StartRunRequest, onEvent: RunEventHandler): Promise<RunHandle> {
    const entry = resolveWorkflow(
      req.workflow,
      workflowSearchPaths(req.cwd, this.extraWorkflowDirs),
    );

    const runId = randomUUID();
    const artifactsDir = join(this.artifactsRoot, runId);
    const baseBranch = req.base_branch ?? detectDefaultBranch(req.cwd);

    await this.store.createRun({
      id: runId,
      workflow_name: entry.workflow.name,
      workflow_source: entry.path,
      workflow_hash: entry.workflow.hash,
      user_message: req.message,
      repo_slug: req.repo_slug ?? null,
      working_path: req.cwd,
      base_branch: baseBranch,
      artifacts_dir: artifactsDir,
      external_key: req.external_key ?? null,
      env: req.env ?? {},
      metadata: req.metadata ?? {},
      dry_run: req.dry_run ?? false,
    });

    logger.info('Workflow run created', {
      run_id: runId,
      workflow: entry.workflow.name,
      cwd: req.cwd,
      dry_run: req.dry_run ?? false,
    });

    const runner = this.buildRunner(runId, entry.workflow, {
      cwd: req.cwd,
      artifactsDir,
      baseBranch,
      userMessage: req.message,
      env: req.env ?? {},
      dryRun: req.dry_run ?? false,
    }, onEvent);

    return this.launch(runId, runner);
  }

  // ── resume ────────────────────────────────────────────────────────────────

  async resumeRun(
    runId: string,
    onEvent: RunEventHandler,
    opts: ResumeOptions = {},
  ): Promise<RunHandle> {
    // Resuming past an unanswered gate would walk straight through the
    // question — including the synthetic gate recovery raises for an
    // interrupted `at_most_once` node, whose whole purpose is to stop exactly
    // this. Answer it with approve/reject; the run resumes from there.
    const pending = await this.store.getPendingApproval(runId);
    if (pending) throw new GatePendingError(runId, pending.node_id);

    const { runner } = await this.prepareResume(runId, onEvent, opts);
    return this.launch(runId, runner);
  }

  private async prepareResume(
    runId: string,
    onEvent: RunEventHandler,
    opts: ResumeOptions,
    decision?: PendingDecision,
  ): Promise<{ runner: WorkflowRunner; row: RunRow }> {
    const row = await this.store.getRun(runId);
    if (!row) throw new RunNotFoundError(runId);

    const entry = resolveWorkflow(
      row.workflow_name,
      workflowSearchPaths(row.working_path ?? process.cwd(), this.extraWorkflowDirs),
    );

    if (entry.workflow.hash !== row.workflow_hash && !opts.force) {
      throw new WorkflowChangedError(runId);
    }

    const runner = this.buildRunner(runId, entry.workflow, {
      cwd: row.working_path ?? process.cwd(),
      artifactsDir: row.artifacts_dir ?? join(this.artifactsRoot, runId),
      baseBranch: row.base_branch,
      userMessage: row.user_message,
      env: row.env,
      dryRun: row.dry_run,
    }, onEvent);

    if (entry.workflow.hash === row.workflow_hash) {
      // Only reuse cached node outputs when the document is unchanged;
      // otherwise the graph starts over, which is what --force means.
      await runner.hydrate();
    } else {
      logger.warn('Resuming a changed workflow with force — discarding cached node outputs', {
        run_id: runId,
      });
      await this.store.updateRun(runId, { });
    }

    if (decision) {
      runner.primeDecision({
        ...decision,
        covers: await this.interruptedUnsafeNodes(runId, decision.node_id),
      });
    }
    return { runner, row };
  }

  /**
   * Interrupted `at_most_once` nodes the gate's answer has to govern.
   *
   * Derived from the node rows rather than the gate row: recovery can only
   * raise one gate, and when a gate was already pending it keeps its own node
   * id, so the gate alone does not say which nodes are waiting on the answer.
   */
  private async interruptedUnsafeNodes(runId: string, gateNodeId: string): Promise<string[]> {
    const nodes = await this.store.getNodes(runId);
    return nodes
      .filter((n) => n.status === 'interrupted' && n.side_effects === 'at_most_once')
      .map((n) => n.node_id)
      .filter((id) => id !== gateNodeId);
  }

  private buildRunner(
    runId: string,
    workflow: WorkflowDef,
    ctx: {
      cwd: string;
      artifactsDir: string;
      baseBranch: string | null;
      userMessage: string;
      env: Record<string, string>;
      dryRun: boolean;
    },
    onEvent: RunEventHandler,
  ): WorkflowRunner {
    return new WorkflowRunner(
      {
        store: this.store,
        ai: this.ai,
        commands: new CommandResolver({ searchDirs: CommandResolver.searchDirsFor(ctx.cwd) }),
        config: this.config,
        scriptDirs: [join(ctx.cwd, '.gaggle', 'scripts')],
        bashPath: this.bashPath,
      },
      { runId, workflow, ...ctx },
      onEvent,
    );
  }

  private launch(runId: string, runner: WorkflowRunner): RunHandle {
    const done = runner
      .run()
      .then(() => undefined)
      .catch((err) => {
        logger.error('Run loop threw', { run_id: runId, error: (err as Error).message });
      })
      .finally(() => {
        this.active.delete(runId);
      });
    this.active.set(runId, { runner, done });

    return {
      run_id: runId,
      cancel: (reason?: string) => runner.cancel(reason ?? 'cancelled'),
      done,
    };
  }

  // ── gate decisions ────────────────────────────────────────────────────────

  async approve(runId: string, comment?: string): Promise<void> {
    await this.decide(runId, 'approved', comment ?? null);
  }

  async reject(runId: string, reason?: string): Promise<void> {
    await this.decide(runId, 'rejected', reason ?? null);
  }

  /**
   * Record the decision and resume in one step.
   *
   * Deliberately not two operations: storing an approval without resuming is
   * how the old integration lost the human's comment, and left runs parked
   * that everyone believed had been approved.
   */
  private async decide(
    runId: string,
    decision: 'approved' | 'rejected',
    comment: string | null,
  ): Promise<void> {
    const pending = await this.store.getPendingApproval(runId);
    if (!pending) {
      logger.warn('Decision for a run with no pending gate — ignoring', { run_id: runId, decision });
      return;
    }

    // Build the resumed runner *before* recording the decision. Preparing can
    // fail — most reachably with WorkflowChangedError, since template sync
    // rewrites the same checkout the workflow is read from — and consuming the
    // gate first would leave the run paused forever with nothing left to
    // approve.
    const prepared = await this.prepareResume(runId, () => {}, {}, {
      node_id: pending.node_id,
      decision,
      comment,
      rework_attempts: pending.rework_attempts,
    });

    // The store refuses a second decision on the same gate, and says so by
    // returning null. Launching anyway would put two runners on one run.
    const decided = await this.store.decideApproval(pending.id, decision, comment);
    if (!decided) {
      logger.warn('Gate was already decided elsewhere — not resuming again', {
        run_id: runId,
        node_id: pending.node_id,
      });
      return;
    }
    await this.store.appendEvent(runId, `gate_${decision}`, pending.node_id, { comment });

    const handle = this.launch(runId, prepared.runner);
    // Resumption runs in the background; the caller is a webhook or a poll
    // tick and should not block for the rest of the workflow. Failures are
    // logged inside launch().
    void handle.done;
  }

  private async resumeWithDecision(runId: string, decision: PendingDecision): Promise<RunHandle> {
    const { runner } = await this.prepareResume(runId, () => {}, {}, decision);
    return this.launch(runId, runner);
  }

  /**
   * Answer a gate and resume, streaming the resumed run's events to a listener.
   *
   * Rejection needs this as much as approval does. A rejected gate is not the
   * end of the run: `on_reject` runs its rework prompt and parks at the same
   * gate again, so a caller that only watched approvals would never hear about
   * the second question and the target would sit in `running` forever.
   */
  async decideAndWatch(
    runId: string,
    decision: 'approved' | 'rejected',
    comment: string | null,
    onEvent: RunEventHandler,
  ): Promise<RunHandle | null> {
    const pending = await this.store.getPendingApproval(runId);
    if (!pending) return null;
    // Prepare first, decide second — see `decide()` for why.
    const { runner } = await this.prepareResume(runId, onEvent, {}, {
      node_id: pending.node_id,
      decision,
      comment,
      rework_attempts: pending.rework_attempts,
    });
    const decided = await this.store.decideApproval(pending.id, decision, comment);
    if (!decided) {
      // Another surface answered first; that resume owns the run.
      logger.warn('Gate was already decided elsewhere — not resuming again', {
        run_id: runId,
        node_id: pending.node_id,
      });
      return null;
    }
    await this.store.appendEvent(runId, `gate_${decision}`, pending.node_id, { comment });
    return this.launch(runId, runner);
  }

  /** {@link decideAndWatch} for the approval case. */
  approveAndWatch(
    runId: string,
    comment: string | undefined,
    onEvent: RunEventHandler,
  ): Promise<RunHandle | null> {
    return this.decideAndWatch(runId, 'approved', comment ?? null, onEvent);
  }

  // ── termination ───────────────────────────────────────────────────────────

  /**
   * Stop every run this process is driving, and make sure the database says so.
   *
   * Exiting without this leaves rows `running` under a lease that stays live
   * for its full TTL. Startup recovery only looks for runs whose lease has
   * *lapsed*, and only at startup — so a restart inside that window walks
   * straight past them and nothing picks them up afterwards either.
   *
   * The runs are suspended rather than cancelled: a restart should not throw
   * away work, and leaving the row `running` with no lease is exactly what
   * recovery is looking for.
   */
  async shutdown(timeoutMs = 15_000): Promise<void> {
    const entries = [...this.active.entries()];
    if (entries.length === 0) return;

    logger.info('Suspending in-flight runs', { count: entries.length });
    for (const [, e] of entries) e.runner.suspend();
    await Promise.race([
      Promise.allSettled(entries.map(([, e]) => e.done)),
      Bun.sleep(timeoutMs),
    ]);

    // A run that would not unwind in time must still lose its lease, or it
    // stays invisible to recovery for the rest of the TTL.
    for (const [id] of entries) {
      if (!this.active.has(id)) continue;
      logger.warn('Run did not unwind in time; releasing its lease anyway', { run_id: id });
      await this.store.releaseLease(id, LEASE_OWNER).catch(() => {});
    }
  }

  async cancel(runId: string, reason = 'cancelled'): Promise<void> {
    const entry = this.active.get(runId);
    if (entry) {
      entry.runner.cancel(reason);
      return;
    }
    // Not running here — record the intent so the row stops looking alive.
    await this.abandonWith(runId, reason);
  }

  async abandon(runId: string): Promise<void> {
    await this.abandonWith(runId, 'abandoned');
  }

  private async abandonWith(runId: string, reason: string): Promise<void> {
    const row = await this.store.getRun(runId);
    if (!row) throw new RunNotFoundError(runId);
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return;
    await this.store.updateRun(runId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      metadata: { cancel_reason: reason },
    });
    await this.store.appendEvent(runId, 'run_cancelled', null, { reason });
  }
}
