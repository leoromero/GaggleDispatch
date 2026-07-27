/**
 * GaggleDispatch orchestrator.
 *
 * What this used to be: a poll loop that fetched candidate issues, decided which
 * were eligible from their tracker labels, dispatched them, and reconstructed all
 * of that from labels again after a restart.
 *
 * What it is now: a host. It owns the control plane, the subprocesses, and the
 * timer, and it decides nothing about what to work on — an operator decides that
 * in the dashboard, and the control plane records it. Each tick does three things:
 *
 *   1. `sync` imports and refreshes tickets from the tracker. It never dispatches.
 *   2. `reconciler.tick()` drains work an operator marked ready, reflects run
 *      outcomes, and honours cancellations and gate answers.
 *   3. The PR-merge watcher closes tracker issues whose PRs have all landed.
 *
 * The remaining substance here is the {@link WorkerLauncher}: turning a target
 * into a subprocess, and keeping the live telemetry the dashboard's Workers panel
 * shows. That telemetry is the only state this class owns, and it is disposable —
 * everything a decision depends on is in Postgres.
 */

import type { IssueAnalysis, OrchestratorState, RepoTarget, ServiceConfig } from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { LinearClient } from '../tracker/linear.ts';
import { IssueAnalyzer } from '../analyzer/issue-analyzer.ts';
import { WorkspaceManager } from '../workspace/workspace-manager.ts';
import { ArchonClient } from '../executor/archon-client.ts';
import { spawnWorker, buildLiveSession, type WorkerStartArgs } from './worker.ts';
import { buildSessionId, createInitialState } from './state.ts';
import { PrMergeWatcher } from './pr-merge-watcher.ts';
import type { RegistryLoaderHandle } from '../registry/loader.ts';
import type { SyncerHandle } from '../registry/repo-syncer.ts';
import { openControlPlane, type ControlPlane } from '../control/index.ts';
import { ArchonExecutorAdapter, ArchonRunStatusAdapter } from '../control/adapters/archon.ts';
import { ControlAnalyzerAdapter, MaxConcurrentSlots } from '../control/adapters/analyzer.ts';
import type { ControlApi } from '../control/api.ts';
import type { ControlStore } from '../control/store/types.ts';
import type { SyncResult } from '../control/sync.ts';
import type { TickResult } from '../control/reconciler.ts';

export interface OrchestratorDeps {
  cfg: ServiceConfig;
  tracker: LinearClient;
  analyzer: IssueAnalyzer;
  workspace: WorkspaceManager;
  registry: RegistryLoaderHandle;
  syncer: SyncerHandle | null;
  /** Names this gaggle's tickets. Several gaggles may share one database. */
  workspaceName: string;
  /** Injected for testing; defaults to a real client built from cfg. */
  archonClient?: ArchonClient;
  /** Injected for testing; defaults to Postgres. */
  controlStore?: ControlStore;
  /**
   * Injected for testing; defaults to the real subprocess spawner.
   *
   * Without this seam an end-to-end test of the tick loop would launch actual
   * Archon processes, so the wiring — the part most likely to be wrong — could
   * only be verified by hand.
   */
  spawn?: typeof spawnWorker;
  /**
   * How long one tick phase may run before it is abandoned and the tick moves on.
   *
   * Deliberately generous: this is not a performance budget, it is the guarantee
   * that the loop survives. Every network call already carries its own deadline;
   * this catches the hang nobody predicted — a query with no statement timeout, a
   * subprocess that never exits — because the cost of being wrong is that the
   * daemon stops ticking entirely and reports nothing about why.
   */
  phaseTimeoutMs?: number;
}

/** See {@link OrchestratorDeps.phaseTimeoutMs}. */
export const DEFAULT_PHASE_TIMEOUT_MS = 600_000;

class PhaseTimeoutError extends Error {
  constructor(phase: string, ms: number) {
    super(`phase '${phase}' exceeded ${ms}ms and was abandoned`);
    this.name = 'PhaseTimeoutError';
  }
}

export class Orchestrator {
  private readonly cfg: ServiceConfig;
  private readonly deps: OrchestratorDeps;
  private readonly state: OrchestratorState;
  private readonly archon: ArchonClient;
  private readonly prWatcher: PrMergeWatcher;
  private readonly executor: ArchonExecutorAdapter;
  private control: ControlPlane | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.state = createInitialState(deps.cfg);
    this.archon = deps.archonClient ?? new ArchonClient(deps.cfg.executor.api_url);

    // The adapter needs to report outcomes to a service that does not exist yet,
    // so the sink is resolved lazily. See the note in adapters/archon.ts.
    this.executor = new ArchonExecutorAdapter({
      cfg: this.cfg,
      client: this.archon,
      launch: (args) => this.launchWorker(args),
      sink: () => {
        if (!this.control) throw new Error('control plane not open');
        return this.control.service;
      },
    });

    this.prWatcher = new PrMergeWatcher({
      tracker: deps.tracker,
      cfg: {
        pr_ready_state: this.cfg.tracker.pr_ready_state,
        done_state: this.cfg.tracker.terminal_states[0] ?? 'Done',
      },
    });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info('Orchestrator starting', {
      workspace: this.deps.workspaceName,
      poll_interval_ms: this.cfg.polling.interval_ms,
      max_concurrent_agents: this.cfg.agent.max_concurrent_agents,
    });

    // Under OAuth `actor=app` the viewer is the app, so resolving it up front
    // fails fast on bad credentials rather than at the first sub-issue.
    if (this.cfg.tracker.assigned_to_me) {
      await this.deps.tracker.resolveViewerId();
    }
    if (this.cfg.tracker.mirror_labels) {
      // Only meaningful when mirroring is on; the labels are outputs, and
      // nothing reads them.
      await this.deps.tracker.ensureGaggleLabels();
    }

    this.control = await openControlPlane({
      cfg: this.cfg,
      workspace: this.deps.workspaceName,
      tracker: this.deps.tracker,
      executor: this.executor,
      runs: new ArchonRunStatusAdapter(this.archon),
      analyzer: new ControlAnalyzerAdapter({
        cfg: this.cfg,
        analyzer: this.deps.analyzer,
        registry: () => this.deps.registry.getContext(),
      }),
      slots: new MaxConcurrentSlots(this.cfg.agent.max_concurrent_agents),
      store: this.deps.controlStore,
    });

    // Recovery is a query now, not a reconstruction from tracker labels.
    const recovery = await this.control.reconciler.recoverOnStartup();
    logger.info('Recovery complete', recovery);

    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const [, session] of this.state.running) {
      try {
        session.cancel?.();
      } catch {
        /* best effort */
      }
    }
    await this.control?.close();
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  /**
   * One pass.
   *
   * Each phase is independently failure-tolerant: a tracker outage must not stop
   * runs from being reconciled, and an executor hiccup must not stop the board
   * from staying current.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const sync = await this.safely('sync', () => this.control!.sync.sync());
      const work = await this.safely('reconcile', () => this.control!.reconciler.tick());
      await this.safely('pr-merge', () => this.prWatcher.poll());

      if (sync && interesting(sync)) logger.info('Ticket sync', { ...sync });
      if (work && busy(work)) logger.info('Reconciled', { ...work });
    } finally {
      this.scheduleTick(this.state.poll_interval_ms);
    }
  }

  /**
   * Run one phase, surviving both a throw and a hang.
   *
   * The hang half is the one that was missing, and it was not hypothetical: a
   * Linear that accepted connections and stalled left `tick()` awaiting forever,
   * so the `finally` that reschedules never ran and the daemon stopped ticking
   * for good — no dispatch, no reconciliation, no gates applied, and one log
   * line's worth of explanation. A throw was always handled; a hang is not a
   * throw.
   *
   * Abandoning a phase does not cancel it — nothing here can. It bounds the
   * *loop*, and the per-request deadlines bound the abandoned work itself.
   */
  private async safely<T>(phase: string, fn: () => Promise<T>): Promise<T | null> {
    const budget = this.deps.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PhaseTimeoutError(phase, budget)), budget);
        }),
      ]);
    } catch (err) {
      logger.error('Tick phase failed', { phase, error: (err as Error).message });
      return null;
    } finally {
      // Without this the pending timer keeps the process alive for the whole
      // budget after a fast, healthy tick.
      if (timer) clearTimeout(timer);
    }
  }

  // ── worker launching ────────────────────────────────────────────────────

  /**
   * Turn a claimed target into a running subprocess.
   *
   * This is the {@link WorkerLauncher} the executor adapter calls. It owns the
   * `LiveSession` bookkeeping, which exists purely so the dashboard can show what
   * a worker is doing right now — the control plane neither reads nor needs it.
   */
  private async launchWorker(args: {
    ticket: { id: string; identifier: string; title: string };
    target: { id: string; repo_alias: string; attempt: number; external_target_url: string | null };
    issue: WorkerStartArgs['issue'];
    repo_target: RepoTarget;
    analysis: IssueAnalysis;
    callbacks: {
      onStarted: (pid: number) => void;
      onOutput: (line: string) => void;
      onRunId: (runId: string) => void;
      onGatePaused: (runId: string, message: string) => void;
      onExit: (event: { type: string; exit_code?: number }) => void;
    };
  }): Promise<{ cancel: (reason?: string) => void }> {
    const { ticket, target, callbacks } = args;
    const key = target.id;
    const log = logger.child({
      identifier: ticket.identifier,
      repo_alias: target.repo_alias,
      target_id: target.id,
    });

    const session = buildLiveSession({
      issue: args.issue,
      repo_target: args.repo_target,
      attempt: target.attempt,
      sub_issue_id: null,
      cancel: () => {},
    });
    session.session_id = buildSessionId(ticket.identifier, target.repo_alias, target.attempt);
    this.state.running.set(key, session);

    const branch =
      this.cfg.repositories.find((r) => r.url === args.repo_target.repo_url)?.default_branch ?? 'main';

    const spawn = this.deps.spawn ?? spawnWorker;
    try {
      const handle = await spawn(
        {
          cfg: this.cfg,
          workspace: this.deps.workspace,
          issue: args.issue,
          repo_target: args.repo_target,
          analysis: args.analysis,
          attempt: target.attempt,
          source_branch: branch,
          sub_issue_url: target.external_target_url,
        },
        {
          onStarted: (pid) => {
            const s = this.state.running.get(key);
            if (s) {
              s.run_pid = pid;
              s.last_event_at = new Date().toISOString();
            }
            callbacks.onStarted(pid);
          },
          onOutput: (line) => {
            const s = this.state.running.get(key);
            if (s) {
              s.last_message = line;
              s.last_event_at = new Date().toISOString();
              s.turn_count += 1;
              s.recent_output.push(line);
              if (s.recent_output.length > 50) s.recent_output.shift();
            }
            callbacks.onOutput(line);
          },
          onRunId: (runId) => {
            const s = this.state.running.get(key);
            if (s) s.run_id = runId;
            log.info('Captured run id', { run_id: runId });
            callbacks.onRunId(runId);
          },
          onGatePaused: (runId, message) => {
            this.state.running.delete(key);
            callbacks.onGatePaused(runId, message);
          },
          onExit: (event) => {
            const s = this.state.running.get(key);
            const tail = s?.recent_output.slice(-15) ?? [];
            this.state.running.delete(key);
            if (event.type !== 'run_succeeded') {
              // The tail is the difference between a diagnosable failure and a
              // trip into Archon's own logs.
              log.warn('Worker exited abnormally', { event: event.type, recent_output: tail });
            }
            callbacks.onExit(event);
          },
        },
      );

      const s = this.state.running.get(key);
      if (s) s.cancel = handle.cancel;
      log.info('Worker spawned', { workflow: args.repo_target.workflow });
      return { cancel: handle.cancel };
    } catch (err) {
      this.state.running.delete(key);
      throw err;
    }
  }

  // ── external surface ────────────────────────────────────────────────────

  /** Live-worker telemetry for the dashboard. */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Exposed so the gaggle API can serve the board when the hub is not running. */
  controlApi(): ControlApi | null {
    return this.control?.api ?? null;
  }

  /** Run a sync pass now. Proxied from the dashboard's Sync button. */
  async syncNow(): Promise<SyncResult> {
    if (!this.control) throw new Error('control plane not open');
    return this.control.sync.sync();
  }

  /**
   * Re-dispatch a target by id.
   *
   * Kept for the dashboard's existing endpoint. The identity is now the target's
   * own id rather than an `(issue_id, repo_alias)` pair, because targets are rows.
   */
  async redispatch(targetId: string): Promise<void> {
    if (!this.control) throw new Error('control plane not open');
    await this.control.service.redispatchTarget(targetId);
  }
}

/** Worth a log line only when a sync pass actually changed something. */
function interesting(r: SyncResult): boolean {
  return r.imported > 0 || r.archived > 0 || r.flagged > 0 || r.targets_refreshed > 0;
}

function busy(r: TickResult): boolean {
  return Object.values(r).some((n) => n > 0);
}
