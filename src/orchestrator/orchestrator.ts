/**
 * GaggleDispatch Orchestrator (Sections 8, 9, 17).
 *
 * Owns the poll loop, runtime state, dispatch decisions, multi-repo fan-out,
 * retry queue, supervised-gate polling, and reconciliation. Single authority
 * for all state mutation.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import type {
  Issue,
  IssueAnalysis,
  OrchestratorState,
  RepoTarget,
  RetryEntry,
  ServiceConfig,
  SupervisedGateEntry,
} from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { sanitizeId } from '../util/paths.ts';
import { LinearClient } from '../tracker/linear.ts';
import { IssueAnalyzer } from '../analyzer/issue-analyzer.ts';
import { WorkspaceManager } from '../workspace/workspace-manager.ts';
import {
  ExecutorClient,
  findRunForRepo,
  type RunRecord,
} from '../executor/client.ts';
import { RunPoller } from '../executor/poller.ts';
import { spawnWorker, buildLiveSession, toWorkerCallbacks, type WorkerStartArgs } from './worker.ts';
import type { GaggleExecutor } from '../executor/engine/index.ts';
import type { Store } from '../executor/store/types.ts';
import { buildIssueMessage } from '../workspace/message.ts';
import {
  availableSlots,
  buildSessionId,
  createInitialState,
  noRetryEntriesFor,
  noRunningWorkersFor,
  workerKey,
} from './state.ts';
import { blockersSatisfied, repoTargetReady } from './readiness.ts';
import { defaultGateResumeState, completedState } from '../config/service-config.ts';
import type { RegistryLoaderHandle } from '../registry/loader.ts';
import type { SyncerHandle } from '../registry/repo-syncer.ts';
import { writeRunEntry, deleteRunEntry, allRunEntries, allRetryEntries, deleteRetryEntry } from '../registry/run-registry.ts';
import { saveAnalysis, getAnalysis, deleteAnalysis } from '../registry/analysis-registry.ts';
import { classifyGateReply, type GateClassification } from './gate-classifier.ts';
import {
  classifyTargetState,
  parentTransition,
  targetTransition,
  type ParentEvent,
  type ParentTransition,
  type ParentTransitionContext,
  type TargetEvent,
  type TargetIdentity,
  type TargetState,
  type TargetTransition,
  type TargetTransitionContext,
} from './state-machine.ts';
import { EffectApplier } from './effect-applier.ts';

const APPROVE_KEYWORDS = /^(approve[d]?|yes|y|lgtm|ship\s+it|go|continue|implement|do\s+it|looks?\s+good|lg|ok(ay)?|sure|proceed|start|build|make\s+it|let'?s\s+go|confirm(ed)?|✅|👍)\b/i;
const REJECT_KEYWORDS = /^(reject(ed)?|no|n|cancel(led)?|abort|stop|don'?t|nope|👎)\b/i;

interface RecoveryContext {
  claimedIssues: Issue[];
  runningIssues: Issue[];
  queuedIssues: Issue[];
  waitingIssues: Issue[];
  retryingIssues: Issue[];
  executorRuns: RunRecord[];
  runsById: Map<string, RunRecord>;
  persistedRunIds: ReturnType<typeof allRunEntries>;
  persistedRetries: ReturnType<typeof allRetryEntries>;
}

export interface OrchestratorDeps {
  cfg: ServiceConfig;
  tracker: LinearClient;
  analyzer: IssueAnalyzer;
  workspace: WorkspaceManager;
  registry: RegistryLoaderHandle;
  syncer: SyncerHandle | null;
  /** The workflow engine. */
  executor: GaggleExecutor;
  /** Backing store, for the client adapter and recovery. */
  store: Store;
  /** Injected for testing; defaults to one built over `executor` + `store`. */
  executorClient?: ExecutorClient;
}

/** Cadence for following a run this process did not start. */
const POLL_INTERVAL_MS = 5_000;

export class Orchestrator {
  private state: OrchestratorState;
  private cfg: ServiceConfig;
  private tracker: LinearClient;
  private analyzer: IssueAnalyzer;
  private workspace: WorkspaceManager;
  private registry: RegistryLoaderHandle;
  private syncer: SyncerHandle | null;
  private executor: GaggleExecutor;
  private executorClient: ExecutorClient;
  private effectApplier: EffectApplier;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private analyzing = new Set<string>();

  constructor(deps: OrchestratorDeps) {
    this.cfg = deps.cfg;
    this.tracker = deps.tracker;
    this.analyzer = deps.analyzer;
    this.workspace = deps.workspace;
    this.registry = deps.registry;
    this.syncer = deps.syncer;
    this.executor = deps.executor;
    this.executorClient = deps.executorClient ?? new ExecutorClient(deps.executor, deps.store);
    this.state = createInitialState(this.cfg);

    deps.registry.on(() => {
      this.invalidateAnalysisCache();
    });

    // Wire the EffectApplier with hooks back into orchestrator-owned machinery.
    // Hot paths that haven't been converted yet throw from their hooks — those
    // effects won't fire until the corresponding transition is wired up.
    this.effectApplier = new EffectApplier({
      cfg: this.cfg,
      tracker: this.tracker,
      executorClient: this.executorClient,
      workspace: this.workspace,
      state: this.state,
      registryBaseFolder: this.cfg.registry.base_folder,
      spawnWorker: async (args) => {
        const parentIssue = this.state.pending_issues.get(args.identity.parent_issue_id);
        if (!parentIssue) {
          throw new Error(`spawnWorker hook: parent issue ${args.identity.parent_issue_id} not in pending_issues`);
        }
        const subIssueId =
          args.identity.target_issue_id === args.identity.parent_issue_id
            ? null
            : args.identity.target_issue_id;
        const cachedAnalysis = this.state.analysis_cache.get(parentIssue.id)?.analysis;
        await this.launchWorker(
          parentIssue,
          args.target,
          subIssueId,
          args.attempt,
          args.messageOverride,
          cachedAnalysis,
        );
      },
      cancelWorker: (key) => {
        const sess = this.state.running.get(key);
        try { sess?.cancel?.(); } catch { /* ignore */ }
      },
      scheduleRetry: (key, delayMs, attempt) => {
        const sep = key.indexOf('__');
        if (sep < 0) return;
        const parentId = key.slice(0, sep);
        const alias = key.slice(sep + 2);
        const issue = this.state.pending_issues.get(parentId);
        if (!issue) {
          logger.warn('scheduleRetry hook: parent issue not in pending_issues', { key });
          return;
        }
        const target = this.buildRepoTargetForAlias(alias, issue);
        this.scheduleRetry(issue, target, attempt, null, delayMs);
      },
      createBlocker: async (spec, blocksIssueId) => {
        let assigneeId: string | null = null;
        try { assigneeId = await this.tracker.resolveViewerId(); } catch { /* ignore */ }
        let newIssue: { id: string; identifier: string; url: string | null };
        try {
          newIssue = await this.tracker.createIssue({
            title: spec.title,
            description: spec.description || undefined,
            assignee_id: assigneeId,
            state_name: this.cfg.tracker.active_states[0] ?? 'Todo',
          });
        } catch (err) {
          logger.error('createBlocker hook: failed to create blocker issue', { error: (err as Error).message });
          return;
        }
        try {
          await this.tracker.createBlockerRelation(newIssue.id, blocksIssueId);
        } catch (err) {
          logger.warn('createBlocker hook: failed to create blocker relation', { error: (err as Error).message });
        }
        logger.info('createBlocker: created blocker', {
          blocker_id: newIssue.id, blocker_identifier: newIssue.identifier, blocks_issue_id: blocksIssueId,
        });
      },
      createSubIssue: async () => {
        throw new Error('createSubIssue hook not yet wired (dispatch path still uses inline logic)');
      },
      approveAndResume: async (args) => {
        const parentIssue = this.state.pending_issues.get(args.identity.parent_issue_id);
        if (!parentIssue) {
          throw new Error(`approveAndResume hook: parent issue ${args.identity.parent_issue_id} not in pending_issues`);
        }
        const subIssueId =
          args.identity.target_issue_id === args.identity.parent_issue_id
            ? null
            : args.identity.target_issue_id;
        const target = this.buildRepoTargetForAlias(args.identity.repo_alias, parentIssue);
        this.launchApproveAndResume(parentIssue, target, subIssueId, args.runId, args.message, args.attempt);
      },
    });
  }

  invalidateAnalysisCache(): void {
    if (this.state.analysis_cache.size > 0) {
      logger.info('Invalidating analysis cache (registry context changed)', {
        cleared: this.state.analysis_cache.size,
      });
    }
    this.state.analysis_cache.clear();
  }

  getState(): OrchestratorState {
    return this.state;
  }

  /**
   * Re-dispatch a failed target without re-analyzing. Called by the gaggle API
   * when the operator clicks Re-dispatch in the dashboard. Fires retry_requested
   * directly into the state machine — the SM handles label removal and worker spawn.
   */
  async redispatch(issue_id: string, repo_alias: string): Promise<void> {
    const key = workerKey(issue_id, repo_alias);
    if (this.state.target_machine_states.get(key) !== 'failed') {
      throw new Error(`Target ${key} is not in failed state`);
    }

    let parentIssue = this.state.pending_issues.get(issue_id);
    if (!parentIssue) {
      try {
        const fetched = await this.tracker.fetchIssueStatesByIds([issue_id]);
        parentIssue = fetched[0];
      } catch {
        /* ignore */
      }
    }
    if (!parentIssue) throw new Error(`Cannot resolve issue ${issue_id}`);

    this.state.pending_issues.set(issue_id, parentIssue);
    const target = this.buildRepoTargetForAlias(repo_alias, parentIssue);
    const targetIssueId = this.state.sibling_subissues.get(issue_id)?.get(repo_alias) ?? issue_id;

    const identity: TargetIdentity = {
      parent_issue_id: issue_id,
      repo_alias,
      target_issue_id: targetIssueId,
    };

    await this.emitTargetEvent('failed', { kind: 'retry_requested', message: null }, {
      cfg: this.cfg,
      identity,
      parent_issue: parentIssue,
      target,
      siblings: new Map(),
      attempt: 0,
    });

    logger.info('Failed target — dashboard re-dispatch', { issue_id, repo_alias });
  }

  async start(): Promise<void> {
    logger.info('Orchestrator starting', {
      poll_interval_ms: this.cfg.polling.interval_ms,
      max_concurrent_agents: this.cfg.agent.max_concurrent_agents,
    });

    await this.tracker.ensureGaggleLabels();
    if (this.cfg.tracker.assigned_to_me) {
      await this.tracker.resolveViewerId();
    }

    await this.startupTerminalCleanup();
    await this.recoverFromLinearLabels();

    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const [, session] of this.state.running) {
      try {
        session.stopPoller?.();
        session.cancel?.();
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.reconcileRunningIssues();
      await this.pollSupervisedGates();
      await this.pollFailedTargets();
      await this.pollMergedPRs();
      await this.processPendingTargets();

      const issues = await this.fetchCandidates();
      if (issues === null) {
        return; // schedule already done in catch path
      }
      const sorted = this.sortForDispatch(issues);
      for (const issue of sorted) {
        if (this.stopped) break;
        if (availableSlots(this.state) === 0) break;

        if (issue.parent_id) {
          // Sub-issue path: dispatched without analysis (description IS the task).
          if (!this.shouldDispatchSubIssue(issue)) continue;
          if (await this.hasLinkedGitHubPR(issue)) continue;
          await this.dispatchSubIssueFromPoll(issue);
        } else {
          // Parent issue path: analyze then fan out.
          if (!this.shouldDispatch(issue)) continue;
          if (await this.hasLinkedGitHubPR(issue)) continue;
          let analysis: IssueAnalysis | null;
          try {
            analysis = await this.getOrAnalyze(issue);
          } catch (err) {
            logger.error('Issue analysis failed', {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              error: (err as Error).message,
            });
            continue;
          }
          if (!analysis) continue;
          await this.dispatchIssue(issue, analysis);
        }
      }
    } catch (err) {
      logger.error('Tick error', { error: (err as Error).message });
    } finally {
      this.scheduleTick(this.state.poll_interval_ms);
    }
  }

  // ─── candidate fetch ──────────────────────────────────────────────────────
  private async fetchCandidates(): Promise<Issue[] | null> {
    try {
      return await this.tracker.fetchCandidateIssues();
    } catch (err) {
      logger.error('Failed to fetch candidate issues', { error: (err as Error).message });
      return null;
    }
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      if (pa !== pb) return pa - pb;
      const da = a.created_at ? Date.parse(a.created_at) : Number.MAX_SAFE_INTEGER;
      const db = b.created_at ? Date.parse(b.created_at) : Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      return a.identifier.localeCompare(b.identifier);
    });
  }

  // ─── eligibility ──────────────────────────────────────────────────────────
  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.cfg.tracker.terminal_states.includes(issue.state)) return false;
    if (!this.cfg.tracker.active_states.includes(issue.state)) return false;
    // Parent issues only — sub-issues are handled by shouldDispatchSubIssue.
    if (issue.parent_id) return false;
    const gaggleLabels =Object.values(this.cfg.tracker.gaggle_labels).map((l) => l.toLowerCase());
    if (issue.labels.some((l) => gaggleLabels.includes(l))) return false;
    if (this.isParentActive(issue.id)) return false;
    for (const key of this.state.running.keys()) {
      if (key.startsWith(issue.id + '__')) return false;
    }
    // If any target for this issue was already completed this session, skip re-dispatch.
    for (const [key, smState] of this.state.target_machine_states) {
      if (smState === 'succeeded' && key.startsWith(issue.id + '__')) return false;
    }
    if (!blockersSatisfied(issue.blocked_by, this.cfg)) return false;

    const stateLimit = this.cfg.agent.max_concurrent_agents_by_state[issue.state.toLowerCase()];
    if (stateLimit !== undefined) {
      let inState = 0;
      for (const [, session] of this.state.running) {
        if (session.issue.state === issue.state) inState++;
      }
      if (inState >= stateLimit) return false;
    }
    return true;
  }

  /** Eligibility check for sub-issues picked up directly from the poll loop (recovery path). */
  private shouldDispatchSubIssue(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.cfg.tracker.terminal_states.includes(issue.state)) return false;
    if (!this.cfg.tracker.active_states.includes(issue.state)) return false;
    // Any gaggle label means the orchestrator is already managing it.
    const gaggleLabels =Object.values(this.cfg.tracker.gaggle_labels).map((l) => l.toLowerCase());
    if (issue.labels.some((l) => gaggleLabels.includes(l))) return false;
    const alias = this.parseAliasFromTitle(issue.title);
    if (!alias) return false;
    const parentId = issue.parent_id!;
    const key = workerKey(parentId, alias);
    if (this.state.running.has(key)) return false;
    if (this.state.target_machine_states.get(key) === 'succeeded') return false;
    // Native Linear blockers must be satisfied (set via createBlockerRelation).
    if (!blockersSatisfied(issue.blocked_by, this.cfg)) return false;
    return true;
  }

  private parseAliasFromTitle(title: string): string | null {
    const m = title.match(/^\[([^\]]+)\]/);
    return m ? m[1]! : null;
  }

  /**
   * PR-aware re-dispatch guard.
   *
   * Linear's GitHub integration can move issues backward from a terminal
   * state (e.g. `In Review`) into an active state (`In Progress`) when the
   * underlying PR's GitHub status changes — for instance when a PR is taken
   * out of draft. Without intervention this looks like a fresh candidate to
   * the gaggle and triggers a duplicate run.
   *
   * Guard: if the candidate (or its parent, when it's a sub-issue) has any
   * GitHub PR attached in Linear, skip re-dispatch. The retry-via-comment
   * path remains the explicit channel for "redo this issue".
   *
   * Best-effort: a failed lookup falls through to dispatch (we'd rather
   * occasionally re-run than indefinitely stall on a Linear hiccup).
   */
  private async hasLinkedGitHubPR(issue: Issue): Promise<boolean> {
    const lookupId = issue.parent_id ?? issue.id;
    try {
      const prLinks = await this.tracker.fetchIssuePRLinks(lookupId);
      if (prLinks.length === 0) return false;
      logger.info('Skipping candidate — Linear issue already has a linked GitHub PR (post-merge re-activation?)', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        pr_count: prLinks.length,
        first_pr: prLinks[0],
      });
      return true;
    } catch (err) {
      logger.warn('PR-link lookup failed; falling through to dispatch', {
        issue_id: issue.id,
        error: (err as Error).message,
      });
      return false;
    }
  }

  private buildRepoTargetFromSubIssue(subIssue: Issue): import('../domain/types.ts').RepoTarget | null {
    const alias = this.parseAliasFromTitle(subIssue.title);
    if (!alias) return null;
    const repo = this.registry.getContext().repositories.find((r) => r.name === alias);
    if (!repo) {
      logger.warn('Sub-issue has unknown repo alias; cannot dispatch', {
        alias,
        sub_issue_id: subIssue.id,
      });
      return null;
    }
    return {
      repo_url: repo.url,
      repo_alias: repo.name,
      local_path: repo.local_path,
      workflow: repo.default_workflow ?? this.cfg.executor.default_workflow,
      rationale: subIssue.description ?? subIssue.title,
      components: [],
    };
  }

  /** Launch a workflow run for a (parentIssue, repoTarget, subIssueId) triple. Shared by drainPendingTargets, dispatchSubIssueFromPoll, and promoteQueuedSiblings.
   *  If `analysisOverride` is provided it is passed to the worker — used by
   *  the SM-driven retry path so the cached parent analysis is preserved. */
  private async launchWorker(
    parentIssue: Issue,
    target: import('../domain/types.ts').RepoTarget,
    subIssueId: string | null,
    attempt: number | null,
    messageOverride?: string,
    analysisOverride?: IssueAnalysis,
  ): Promise<void> {
    const targetId = subIssueId ?? parentIssue.id;
    const key = workerKey(parentIssue.id, target.repo_alias);
    const log = logger.child({
      issue_id: parentIssue.id,
      issue_identifier: parentIssue.identifier,
      repo_alias: target.repo_alias,
      session_id: buildSessionId(parentIssue.identifier, target.repo_alias, attempt),
    });

    // SM transitions may apply gaggle:dispatching just before this hook fires;
    // remove it before we apply gaggle:running so the target carries one
    // target-level label at a time. Idempotent if absent.
    try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.dispatching); } catch { /* ignore */ }
    try {
      await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.running);
    } catch (err) {
      logger.error('Failed to apply running label; aborting dispatch', {
        issue_id: parentIssue.id, repo_alias: target.repo_alias, error: (err as Error).message,
      });
      return;
    }

    const placeholder = buildLiveSession({ issue: parentIssue, repo_target: target, attempt, sub_issue_id: subIssueId, cancel: () => {} });
    this.state.running.set(key, placeholder);

    const branch = this.cfg.repositories.find((r) => r.url === target.repo_url)?.default_branch ?? 'main';
    const subIssueUrl = subIssueId
      ? (this.state.sibling_subissue_urls.get(parentIssue.id)?.get(target.repo_alias) ?? null)
      : null;
    const workerArgs: WorkerStartArgs = {
      cfg: this.cfg,
      executor: this.executor,
      workspace: this.workspace,
      issue: parentIssue,
      repo_target: target,
      analysis: analysisOverride
        ?? this.state.analysis_cache.get(parentIssue.id)?.analysis
        ?? getAnalysis(this.cfg.registry.base_folder, parentIssue.id)
        ?? { issue_id: parentIssue.id, analysis_summary: '', repo_targets: [target] },
      attempt,
      source_branch: branch,
      sub_issue_url: subIssueUrl,
      message_override: messageOverride,
    };

    try {
      const handle = await spawnWorker(workerArgs, {
        onStarted: (pid) => { const s = this.state.running.get(key); if (s) { s.run_pid = pid; s.last_event_at = new Date().toISOString(); } },
        onOutput: (line) => {
          const s = this.state.running.get(key);
          if (s) {
            s.last_message = line;
            s.last_event_at = new Date().toISOString();
            s.turn_count += 1;
            s.recent_output.push(line);
            if (s.recent_output.length > 50) s.recent_output.shift();
          }
        },
        onRunId: (db_run_id) => {
          const s = this.state.running.get(key);
          if (s) {
            s.run_id = db_run_id;
            this.attachPoller(key, db_run_id, parentIssue, target, subIssueId, attempt);
          }
          writeRunEntry(this.cfg.registry.base_folder, key, {
            run_id: db_run_id,
            parent_issue_id: parentIssue.id,
            sub_issue_id: subIssueId,
            repo_alias: target.repo_alias,
          });
          log.info('Run created', { run_id: db_run_id });
        },
        onGatePaused: (run_id, gate_message) => { void this.handleGatePaused(parentIssue, target, subIssueId, run_id, gate_message, attempt); },
        onExit: (event) => {
          deleteRunEntry(this.cfg.registry.base_folder, key);
          void this.handleWorkerExit(parentIssue, target, event, attempt);
        },
      });
      const sess = this.state.running.get(key);
      if (sess) sess.cancel = handle.cancel;
      log.info('Worker spawned', { workflow: target.workflow });
    } catch (err) {
      this.state.running.delete(key);
      try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
      this.scheduleRetry(parentIssue, target, (attempt ?? 0) + 1, (err as Error).message);
    }
  }

  /** Record the approval and resume the run, rebinding the live session so that
   *  stores the comment as the gate's output AND resumes the workflow. The
   *  callbacks thread back into handleWorkerExit / handleGatePaused so the
   *  resumed workflow flows through the same SM transitions as a fresh worker. */
  private launchApproveAndResume(
    parentIssue: Issue,
    target: RepoTarget,
    subIssueId: string | null,
    runId: string,
    message: string | null,
    attempt: number | null,
  ): void {
    const key = workerKey(parentIssue.id, target.repo_alias);
    const session = buildLiveSession({
      issue: parentIssue,
      repo_target: target,
      attempt,
      sub_issue_id: subIssueId,
      cancel: () => {},
    });
    this.state.running.set(key, session);

    // One call stores the decision and resumes. Under the Archon integration
    // this needed a subprocess, because the HTTP approve stored the approval
    // without continuing the run and dropped the human's comment on the way.
    void (async () => {
      const handle = await this.executorClient.approveAndWatch(
        runId,
        message ?? undefined,
        toWorkerCallbacks({
          onStarted: () => {
            const s = this.state.running.get(key);
            if (s) s.last_event_at = new Date().toISOString();
          },
          onOutput: (line) => {
            const s = this.state.running.get(key);
            if (!s) return;
            s.last_message = line;
            s.last_event_at = new Date().toISOString();
            s.turn_count += 1;
            s.recent_output.push(line);
            if (s.recent_output.length > 50) s.recent_output.shift();
          },
          onRunId: (resumedRunId) => {
            const s = this.state.running.get(key);
            if (s) s.run_id = resumedRunId;
            writeRunEntry(this.cfg.registry.base_folder, key, {
              run_id: resumedRunId,
              parent_issue_id: parentIssue.id,
              sub_issue_id: subIssueId,
              repo_alias: target.repo_alias,
            });
          },
          onGatePaused: (gateRunId, gateMessage) => {
            void this.handleGatePaused(
              parentIssue, target, subIssueId, gateRunId, gateMessage, attempt,
            );
          },
          onExit: (event) => {
            deleteRunEntry(this.cfg.registry.base_folder, key);
            void this.handleWorkerExit(parentIssue, target, event, attempt);
          },
        }),
      );

      if (!handle) {
        // The gate vanished between the decision and the resume — most likely
        // another surface already answered it.
        logger.warn('Approve found no pending gate; nothing to resume', { run_id: runId });
        return;
      }
      session.cancel = () => void this.executorClient.cancelRun(handle.run_id, 'cancelled');
    })();
  }

  /** Poll-loop recovery path: dispatch a sub-issue that has no gaggle labels (e.g. crash before label was applied). */
  private async dispatchSubIssueFromPoll(subIssue: Issue): Promise<void> {
    const parentId = subIssue.parent_id!;
    const target = this.buildRepoTargetFromSubIssue(subIssue);
    if (!target) return;

    // Resolve parent issue (prefer in-memory cache, fall back to Linear fetch).
    let parentIssue = this.state.pending_issues.get(parentId);
    if (!parentIssue) {
      try {
        const fetched = await this.tracker.fetchIssueStatesByIds([parentId]);
        parentIssue = fetched[0];
      } catch { /* ignore */ }
    }
    if (!parentIssue) {
      logger.warn('Cannot resolve parent issue for sub-issue; skipping dispatch', {
        sub_issue_id: subIssue.id, parent_id: parentId,
      });
      return;
    }

    // Register in sibling map.
    let sibMap = this.state.sibling_subissues.get(parentId);
    if (!sibMap) { sibMap = new Map(); this.state.sibling_subissues.set(parentId, sibMap); }
    sibMap.set(target.repo_alias, subIssue.id);

    // Claim parent if not already active. Drive the parent SM unclaimed →
    // claimed (the SM emits the apply_label effect).
    if (!this.isParentActive(parentId)) {
      this.state.pending_issues.set(parentId, parentIssue);
      const fromState = this.state.parent_machine_states.get(parentId) ?? 'unclaimed';
      if (fromState === 'unclaimed' || fromState === 'analyzing') {
        await this.emitParentEvent(fromState, { kind: 'analysis_succeeded', targets: [target] }, {
          cfg: this.cfg,
          parent_issue: parentIssue,
          targets: new Map(),
        });
      } else {
        try { await this.tracker.applyLabel(parentId, this.cfg.tracker.gaggle_labels.claimed); } catch { /* ignore */ }
      }
    }

    await this.launchWorker(parentIssue, target, subIssue.id, null, subIssue.description ?? undefined);
  }

  // ─── analysis with cache ──────────────────────────────────────────────────
  private async getOrAnalyze(issue: Issue): Promise<IssueAnalysis | null> {
    const cached = this.state.analysis_cache.get(issue.id);
    if (cached) {
      const ttl = this.cfg.registry.analysis_cache_ttl_ms;
      if (ttl <= 0 || Date.now() - cached.cached_at < ttl) {
        return cached.analysis;
      }
    }

    if (this.analyzing.has(issue.id)) return null;
    this.analyzing.add(issue.id);
    try {
      const ctx = this.registry.getContext();
      if (ctx.repositories.length === 0) {
        logger.warn('No registry repositories with sync_status=ok; skipping analysis', {
          issue_id: issue.id,
        });
        return null;
      }
      const analysis = await this.analyzer.analyze(issue, ctx);
      this.state.analysis_cache.set(issue.id, { analysis, cached_at: Date.now() });
      saveAnalysis(this.cfg.registry.base_folder, issue.id, analysis);
      logger.info('Issue analyzed', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        repo_targets: analysis.repo_targets.length,
        targets: analysis.repo_targets.map((t) => t.repo_alias).join(','),
      });
      return analysis;
    } finally {
      this.analyzing.delete(issue.id);
    }
  }

  // ─── dispatch ────────────────────────────────────────────────────────────
  private async dispatchIssue(issue: Issue, analysis: IssueAnalysis): Promise<void> {
    this.state.pending_issues.set(issue.id, issue);

    if (!this.state.pending_targets.has(issue.id)) {
      this.state.pending_targets.set(issue.id, [...analysis.repo_targets]);
    }

    // Drive the parent SM unclaimed → claimed (the SM allows analysis_succeeded
    // from unclaimed, applying the gaggle:claimed label as an effect). If the
    // parent is already in 'claimed' (recovered or re-entered), this is a no-op
    // path that's not valid in the SM, so guard.
    const currentParent = this.state.parent_machine_states.get(issue.id) ?? 'unclaimed';
    if (currentParent === 'unclaimed' || currentParent === 'analyzing') {
      await this.emitParentEvent(currentParent, { kind: 'analysis_succeeded', targets: analysis.repo_targets }, {
        cfg: this.cfg,
        parent_issue: issue,
        targets: new Map(),
      });
    } else {
      // Parent already claimed (e.g. from recovery) — make sure the label is
      // present in Linear. Idempotent.
      try {
        await this.tracker.applyLabel(issue.id, this.cfg.tracker.gaggle_labels.claimed);
      } catch (err) {
        logger.error('Failed to apply claimed label', {
          issue_id: issue.id,
          error: (err as Error).message,
        });
      }
    }

    await this.drainPendingTargets(issue, analysis);
  }

  private async processPendingTargets(): Promise<void> {
    const pendingIds = [...this.state.pending_targets.keys()];
    for (const id of pendingIds) {
      const issue = this.state.pending_issues.get(id);
      if (!issue) continue;
      const analysis = this.state.analysis_cache.get(id)?.analysis;
      if (!analysis) continue;
      await this.drainPendingTargets(issue, analysis);
    }
  }

  private async drainPendingTargets(issue: Issue, analysis: IssueAnalysis): Promise<void> {
    const remaining: RepoTarget[] = [];
    const targets = this.state.pending_targets.get(issue.id) ?? [];
    const fanOutWidth = analysis.repo_targets.length;

    // Phase 1: Create all sub-issues upfront (Todo + description).
    for (const target of targets) {
      await this.maybeCreateSubIssue(issue, target, analysis, fanOutWidth);
    }

    // Phase 2: Set up Linear blocker relations for targets that declare depends_on.
    for (const target of targets) {
      if (!target.depends_on?.length) continue;
      const downstreamSubId = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias);
      if (!downstreamSubId) continue;
      for (const upstreamAlias of target.depends_on) {
        const upstreamSubId = this.state.sibling_subissues.get(issue.id)?.get(upstreamAlias);
        if (!upstreamSubId) continue;
        try {
          await this.tracker.createBlockerRelation(upstreamSubId, downstreamSubId);
        } catch (err) {
          logger.warn('Failed to create blocker relation', {
            upstream: upstreamAlias,
            downstream: target.repo_alias,
            error: (err as Error).message,
          });
        }
      }
    }

    // Phase 3: Dispatch or queue each target.
    //
    // Every target is FIRST placed in the queued state — gaggle:queued label
    // applied + target_machine_states['key'] = 'queued'. This makes the full
    // Linear label lifecycle visible (queued → dispatching → running) and
    // means the SM's `queued → dispatching` transition always has a label to
    // remove. It also makes a mid-dispatch crash safely recoverable: the
    // target is observable as queued on disk.
    //
    // Ready targets (no upstream blockers, slot available) then immediately
    // transition queued → dispatching via the SM and proceed to spawn. Targets
    // that aren't ready stay queued and remain in the `remaining` list for the
    // next drain.
    for (const target of targets) {
      const subIssueId = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias) ?? null;
      const targetId = subIssueId ?? issue.id;
      const key = workerKey(issue.id, target.repo_alias);

      // Place in queued state up front. Idempotent: if Linear already has the
      // label (re-drain), this is a no-op; if not, the label is applied.
      // Hydrating target_machine_states also keeps the parent SM's
      // target_terminal check accurate.
      if (this.state.target_machine_states.get(key) !== 'queued') {
        try {
          await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.queued);
        } catch { /* non-fatal */ }
        this.state.target_machine_states.set(key, 'queued');
      }

      if (target.depends_on?.length && !repoTargetReady(target, issue.id, this.state, this.cfg)) {
        remaining.push(target);
        continue;
      }

      if (availableSlots(this.state) === 0) {
        remaining.push(target);
        continue;
      }

      await this.emitTargetEvent('queued', { kind: 'dispatch_attempted' }, {
        cfg: this.cfg,
        identity: {
          parent_issue_id: issue.id,
          repo_alias: target.repo_alias,
          target_issue_id: targetId,
        },
        parent_issue: issue,
        target,
        siblings: new Map(),
        attempt: 0,
      });
      logger.info('Worker dispatched via state machine', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        repo_alias: target.repo_alias,
        workflow: target.workflow,
      });
    }

    this.state.pending_targets.set(issue.id, remaining);
    if (remaining.length === 0) this.state.pending_targets.delete(issue.id);
  }

  private async maybeCreateSubIssue(
    issue: Issue,
    target: RepoTarget,
    analysis: IssueAnalysis,
    fanOutWidth: number,
  ): Promise<string | null> {
    if (!this.cfg.tracker.create_sub_issues || fanOutWidth <= 1) return null;

    const existing = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias);
    if (existing) return existing;

    try {
      const viewerId = await this.tracker.resolveAssigneeFilterUserId().catch(() => null);
      // Sub-issues start in Todo so the orchestrator (or poll loop) controls when work begins.
      const description = buildIssueMessage({ issue, repo_target: target, analysis, attempt: null });
      const sub = await this.tracker.createSubIssue({
        parent_id: issue.id,
        title: `[${target.repo_alias}] ${issue.title}`,
        description,
        assignee_id: viewerId,
        state_name: 'Todo',
      });

      let map = this.state.sibling_subissues.get(issue.id);
      if (!map) { map = new Map(); this.state.sibling_subissues.set(issue.id, map); }
      map.set(target.repo_alias, sub.id);

      if (sub.url) {
        let urlMap = this.state.sibling_subissue_urls.get(issue.id);
        if (!urlMap) { urlMap = new Map(); this.state.sibling_subissue_urls.set(issue.id, urlMap); }
        urlMap.set(target.repo_alias, sub.url);
      }

      logger.info('Created sub-issue', { issue_id: issue.id, repo_alias: target.repo_alias, sub_issue_id: sub.id });
      return sub.id;
    } catch (err) {
      logger.warn('Failed to create sub-issue (continuing on parent)', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
        error: (err as Error).message,
      });
      return null;
    }
  }

  // ─── poller attachment ───────────────────────────────────────────────────
  /**
   * Attach an RunPoller to a live session once the DB run-id is known.
   * The poller provides authoritative status updates independent of subprocess output.
   */
  private attachPoller(
    key: string,
    runId: string,
    issue: import('../domain/types.ts').Issue,
    target: import('../domain/types.ts').RepoTarget,
    subIssueId: string | null,
    attempt: number | null,
    initialDelayMs?: number,
  ): void {
    const poller = new RunPoller(
      this.executorClient,
      runId,
      (event) => {
        const session = this.state.running.get(key);

        switch (event.type) {
          case 'poller_heartbeat':
            if (session) session.last_event_at = event.record.last_activity_at ?? new Date().toISOString();
            break;

          case 'poller_gate_paused':
            // Only fire if the orchestrator hasn't already registered this gate from subprocess output.
            if (!this.state.supervised_gates.has(key)) {
              void this.handleGatePaused(issue, target, subIssueId, runId, event.gate_message, attempt);
            }
            break;

          case 'poller_completed':
            // Only act if the subprocess exit handler hasn't already cleaned up.
            if (session) {
              logger.info('Poller: run completed (subprocess may have missed it)', {
                issue_id: issue.id, repo_alias: target.repo_alias, run_id: runId,
              });
              // The subprocess exit handler is authoritative for cleanup; poller is a safety net.
            }
            break;

          case 'poller_failed':
            logger.warn('Poller: run reached failed/cancelled status', {
              issue_id: issue.id, repo_alias: target.repo_alias,
              run_id: runId, status: event.status,
            });
            break;

          case 'poller_stalled':
            // Stall = `last_activity_at` frozen while status === 'running'.
            // Informational only: a long Claude tool call (an Opus implementer
            // step, say) can legitimately exceed any threshold worth setting,
            // and cancelling on suspicion would post a "worker failed" comment
            // over work that was fine. Keep polling and let the run's real
            // terminal status drive cleanup.
            //
            // Note this is now a genuine kill if we acted on it — the run is
            // in this process — which is a further reason not to.
            logger.warn('Poller: stall detected (informational; not cancelling)', {
              issue_id: issue.id, repo_alias: target.repo_alias, run_id: runId,
              last_activity_at: event.last_activity_at,
            });
            break;

          case 'poller_run_not_found':
            logger.warn('Poller: run no longer exists', {
              issue_id: issue.id, repo_alias: target.repo_alias, run_id: runId,
            });
            break;
        }
      },
      {
        // Only adopted runs are polled; live ones deliver events in-process,
        // so this cadence no longer gates how fast anything is noticed.
        pollIntervalMs: POLL_INTERVAL_MS,
        stallTimeoutMs: this.cfg.executor.stall_timeout_ms,
        ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
      },
    );

    const session = this.state.running.get(key);
    if (session) session.stopPoller = () => poller.stop();

    poller.start();
  }

  // ─── gate handling ───────────────────────────────────────────────────────
  /**
   * Worker paused at a supervised approval gate. The state machine handles
   * label swap (running → waiting-human), supervised_gates registration, and
   * the optional gate_waiting_state transition. The orchestrator handles the
   * plan-fetch + comment-post inline (file system reads + comment id capture
   * the SM doesn't model) and patches comment_id / gate_state_applied onto
   * the gate entry after the applier has registered it.
   */
  private async handleGatePaused(
    issue: Issue,
    target: RepoTarget,
    subIssueId: string | null,
    run_id: string,
    gate_message: string,
    attempt: number | null,
  ): Promise<void> {
    const key = workerKey(issue.id, target.repo_alias);
    const targetId = subIssueId ?? issue.id;

    // gate_message comes from the run's metadata.approval.message, with
    // $nodeId.output references already resolved before storing. For the
    // supervised workflow, $post-summary.output is embedded in the plan-gate message,
    // so gate_message already contains the full architectural summary.
    const commentBody = `🤖 **GaggleDispatch — plan gate**\n\n${gate_message}`;

    // 2. Post the comment. The SM emits post_comment effects in some
    //    transitions, but here we need the comment id back to store on the gate
    //    entry, which the applier doesn't currently return — so this stays
    //    inline for now.
    let comment_id: string | null = null;
    try {
      const c = await this.tracker.postComment(targetId, commentBody);
      comment_id = c.id;
    } catch (err) {
      logger.warn('Failed to post gate comment', { error: (err as Error).message });
    }

    // 3. Session lifecycle (not modeled by SM).
    const session = this.state.running.get(key);
    session?.stopPoller?.();
    this.state.running.delete(key);

    // 4. Drive the SM transition: applies waiting-human, removes running,
    //    registers the supervised_gate entry, and optionally moves Linear
    //    state to gate_waiting_state if configured.
    const identity: TargetIdentity = {
      parent_issue_id: issue.id,
      repo_alias: target.repo_alias,
      target_issue_id: targetId,
    };
    const ctx: TargetTransitionContext = {
      cfg: this.cfg,
      identity,
      parent_issue: issue,
      target,
      siblings: new Map(),
      attempt: attempt ?? 0,
    };
    // pending_issues must be populated for the applier's register_supervised_gate
    // to capture the full Issue snapshot; ensure it's there.
    if (!this.state.pending_issues.has(issue.id)) {
      this.state.pending_issues.set(issue.id, issue);
    }
    await this.emitTargetEvent('running', { kind: 'gate_paused', run_id, message: gate_message }, ctx);

    // 5. Patch up the gate entry with details the SM didn't carry:
    //    - comment_id: only known after posting (above)
    //    - gate_state_applied: optimistically true when gate_waiting_state is
    //      configured. If the set_linear_state effect failed inside the applier
    //      it was logged and swallowed; the resolve step that reads this flag
    //      will idempotently retry on resume.
    const gate = this.state.supervised_gates.get(key);
    if (gate) {
      gate.comment_id = comment_id;
      if (this.cfg.tracker.gate_waiting_state) {
        gate.gate_state_applied = true;
      }
    }

    logger.info('Gate paused — slot freed', {
      issue_id: issue.id,
      repo_alias: target.repo_alias,
      run_id,
    });

    // Note: session.cancel is preserved on the gate entry implicitly via key→running before delete
    // Worker process is still alive; it will exit on approve/reject or timeout.
    void session; // touch to silence lint
  }

  /**
   * Poll gaggle:failed-labelled issues for operator retry/cancel comments.
   * Mirrors `pollSupervisedGates` but for the no-auto-retry policy's
   * human-driven retry path.
   *
   * For each failed target:
   *   - Find the most recent "worker failed" bot comment (timestamp anchor)
   *   - Look for a human reply after that
   *   - Classify intent:
   *       retry    → fire `retry_requested` SM event → respawn worker
   *       cancel   → remove gaggle:failed + post acknowledgement (target SM
   *                  stays `failed`; operator can move issue to Cancelled if
   *                  they want to terminate the parent too)
   *       ambiguous → post a clarification, do nothing else
   */
  private async pollFailedTargets(): Promise<void> {
    let failedIssues: Issue[];
    try {
      failedIssues = await this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.failed);
    } catch (err) {
      logger.debug('pollFailedTargets: fetch failed', { error: (err as Error).message });
      return;
    }

    for (const issue of failedIssues) {
      const parentId = issue.parent_id ?? issue.id;
      // Resolve repo alias: title prefix [alias] for sub-issues, sibling map
      // for mono-repo parents that are themselves the target.
      let alias = this.parseAliasFromTitle(issue.title);
      if (!alias) {
        const sibMap = this.state.sibling_subissues.get(parentId);
        if (sibMap) {
          for (const [a, subId] of sibMap) {
            if (subId === issue.id) { alias = a; break; }
          }
        }
      }
      if (!alias) continue;

      let comments;
      try {
        comments = await this.tracker.fetchIssueComments(issue.id);
      } catch (err) {
        logger.debug('pollFailedTargets: comments fetch failed', { issue_id: issue.id, error: (err as Error).message });
        continue;
      }

      // Most recent failure marker comment anchors the timeline. If we don't
      // find one, the label was applied externally — skip until we can post
      // our own marker on the next failure.
      const failureMarker = comments
        .filter((c) => isBotComment(c) && /worker failed/i.test(c.body))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (!failureMarker) continue;
      const since = Date.parse(failureMarker.created_at);

      const reply = findHumanReplyAfter(comments, since);
      if (!reply) continue;

      const intent = classifyRetryIntent(reply.body);
      if (intent === 'ambiguous') {
        if (!hasBotCommentAfter(comments, Date.parse(reply.created_at))) {
          try {
            await this.tracker.postComment(
              issue.id,
              `🤖 I wasn't sure how to interpret that reply. Reply with **retry** to spawn a fresh worker, or **cancel** to abandon this target.`,
            );
          } catch (err) {
            logger.warn('Failed to post retry-clarification comment', { error: (err as Error).message });
          }
        }
        continue;
      }

      if (intent === 'cancel') {
        // Operator gave up. Remove gaggle:failed so we stop watching; post
        // an acknowledgement. Target SM stays at `failed` (terminal in this
        // direction). If the operator also wants to terminate the parent,
        // they move the parent's Linear state to Cancelled — that flows
        // through reconcileRunningIssues' parent_externally_terminal path.
        try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.failed); } catch { /* ignore */ }
        try {
          await this.tracker.postComment(
            issue.id,
            `🛑 **GaggleDispatch — cancellation acknowledged**\n\nThis target is now abandoned. Move the parent issue to a terminal state if you want the whole task closed.`,
          );
        } catch (err) {
          logger.warn('Failed to post cancellation acknowledgement', { error: (err as Error).message });
        }
        logger.info('Failed target — cancellation acknowledged', { issue_id: issue.id, repo_alias: alias });
        continue;
      }

      // intent === 'retry'
      let parentIssue = this.state.pending_issues.get(parentId);
      if (!parentIssue) {
        if (parentId === issue.id) {
          parentIssue = issue;
        } else {
          try {
            const fetched = await this.tracker.fetchIssueStatesByIds([parentId]);
            parentIssue = fetched[0];
          } catch { /* ignore */ }
        }
      }
      if (!parentIssue) {
        logger.warn('pollFailedTargets: cannot resolve parent for retry', { issue_id: issue.id, parent_id: parentId });
        continue;
      }
      this.state.pending_issues.set(parentId, parentIssue);

      const target = this.buildRepoTargetForAlias(alias, parentIssue);
      const identity: TargetIdentity = {
        parent_issue_id: parentId,
        repo_alias: alias,
        target_issue_id: issue.id,
      };
      await this.emitTargetEvent('failed', { kind: 'retry_requested', message: reply.body.trim() || null }, {
        cfg: this.cfg,
        identity,
        parent_issue: parentIssue,
        target,
        siblings: new Map(),
        attempt: 0,
      });
      logger.info('Failed target — retry triggered by operator', {
        issue_id: issue.id, repo_alias: alias, reply_excerpt: reply.body.slice(0, 80),
      });
    }
  }

  private async pollMergedPRs(): Promise<void> {
    const prReadyState = this.cfg.tracker.pr_ready_state;
    if (!prReadyState) return;

    let issues: Issue[];
    try {
      issues = await this.tracker.fetchIssuesByStates([prReadyState]);
    } catch (err) {
      logger.debug('pollMergedPRs: failed to fetch issues', { error: (err as Error).message });
      return;
    }

    const doneState = this.cfg.tracker.terminal_states[0] ?? 'Done';

    for (const issue of issues) {
      let prUrls: string[];
      try {
        prUrls = await this.tracker.fetchIssuePRLinks(issue.id);
      } catch (err) {
        logger.debug('pollMergedPRs: failed to fetch PR links', {
          issue_id: issue.id, error: (err as Error).message,
        });
        continue;
      }

      if (prUrls.length === 0) continue;

      let allMerged = true;
      for (const url of prUrls) {
        const merged = await checkGitHubPRMerged(url);
        if (!merged) { allMerged = false; break; }
      }

      if (!allMerged) continue;

      logger.info('All PRs merged — moving issue to Done', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        pr_count: prUrls.length,
        state: doneState,
      });
      try {
        await this.tracker.updateIssueState(issue.id, doneState);
      } catch (err) {
        logger.warn('pollMergedPRs: failed to update issue state', {
          issue_id: issue.id, error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Run a target state machine transition: compute it, apply effects through
   * the EffectApplier, and record the resulting state in
   * state.target_machine_states keyed by workerKey. This is the single
   * canonical way the orchestrator drives the target SM — every former
   * targetTransition + applier.applyAll pair now goes through here so the
   * SM state map stays in sync.
   */
  private async emitTargetEvent(
    fromState: TargetState,
    event: TargetEvent,
    ctx: TargetTransitionContext,
  ): Promise<TargetTransition> {
    const transition = targetTransition(fromState, event, ctx);
    await this.effectApplier.applyAll(transition.effects);
    const key = workerKey(ctx.identity.parent_issue_id, ctx.identity.repo_alias);
    this.state.target_machine_states.set(key, transition.to);

    if (transition.to === 'failed') {
      const reason =
        event.kind === 'worker_failed' ? event.reason
        : event.kind === 'gate_rejected' ? `gate rejected: ${event.message}`
        : event.kind === 'gate_timed_out' ? 'gate timed out'
        : null;
      this.state.failed_targets.set(key, {
        issue: ctx.parent_issue,
        repo_target: ctx.target,
        reason,
        failed_at: Date.now(),
      });
    } else if (fromState === 'failed') {
      this.state.failed_targets.delete(key);
    }

    return transition;
  }

  /** Parent SM analogue of emitTargetEvent. Records the resulting state in
   *  state.parent_machine_states keyed by parent issue id. */
  private async emitParentEvent(
    fromState: 'unclaimed' | 'analyzing' | 'claimed' | 'done' | 'cancelled',
    event: ParentEvent,
    ctx: ParentTransitionContext,
  ): Promise<ParentTransition> {
    const transition = parentTransition(fromState, event, ctx);
    await this.effectApplier.applyAll(transition.effects);
    this.state.parent_machine_states.set(ctx.parent_issue.id, transition.to);
    if (transition.to === 'done' || transition.to === 'cancelled') {
      deleteAnalysis(this.cfg.registry.base_folder, ctx.parent_issue.id);
      for (const key of this.state.failed_targets.keys()) {
        if (key.startsWith(ctx.parent_issue.id + '__')) {
          this.state.failed_targets.delete(key);
        }
      }
    }
    return transition;
  }

  /** Build a TargetTransitionContext from a live supervised gate entry. Used
   *  by the gate-reply state machine transitions. Ensures pending_issues is
   *  populated so downstream hooks (scheduleRetry) can resolve the Issue. */
  private buildGateTransitionCtx(gate: SupervisedGateEntry): TargetTransitionContext {
    const targetId = gate.sub_issue_id ?? gate.issue_id;
    if (!this.state.pending_issues.has(gate.issue_id)) {
      this.state.pending_issues.set(gate.issue_id, gate.issue);
    }
    return {
      cfg: this.cfg,
      identity: {
        parent_issue_id: gate.issue_id,
        repo_alias: gate.repo_alias,
        target_issue_id: targetId,
      },
      parent_issue: gate.issue,
      target: gate.repo_target,
      siblings: new Map(),
      attempt: gate.attempt ?? 0,
    };
  }

  private async pollSupervisedGates(): Promise<void> {
    for (const [key, gate] of this.state.supervised_gates) {
      const targetId = gate.sub_issue_id ?? gate.issue_id;
      // Timeout → gate_timed_out (SM emits executor_reject, label swap, schedule_retry).
      if (this.cfg.executor.gate_timeout_ms > 0 && Date.now() - gate.paused_at > this.cfg.executor.gate_timeout_ms) {
        await this.resolveGateStateTransition(targetId, gate);
        await this.emitTargetEvent('gate_waiting', { kind: 'gate_timed_out' }, this.buildGateTransitionCtx(gate));
        logger.info('Gate timed out — retry scheduled', { issue_id: gate.issue_id, repo_alias: gate.repo_alias });
        continue;
      }

      let comments;
      try {
        comments = await this.tracker.fetchIssueComments(targetId);
      } catch (err) {
        logger.warn('Failed to fetch issue comments for gate', { error: (err as Error).message });
        continue;
      }
      const reply = findHumanReplyAfter(comments, gate.paused_at);
      if (!reply) continue;

      const thread = comments
        .filter((c) => Date.parse(c.created_at) > gate.paused_at)
        .map((c) => ({ author_name: isBotComment(c) ? null : c.author.name, body: c.body }));

      const classification: GateClassification = await classifyGateReply(
        gate.gate_message,
        thread,
        this.cfg.claude.gate_classifier_model,
        this.cfg.claude.api_key,
      );
      const { intent, message: classifiedMessage } = classification;
      if (intent === 'create_blocker') {
        logger.info('CREATE_BLOCKER gate detected — creating blocker issue', {
          issue_id: gate.issue_id,
          blocker_title: classification.blocker!.title,
        });
        await this.resolveGateStateTransition(targetId, gate);
        await this.emitTargetEvent('gate_waiting',
          { kind: 'gate_create_blocker', blocker: classification.blocker! },
          this.buildGateTransitionCtx(gate));
        logger.info('Blocker created — target parked in queued', { issue_id: gate.issue_id, repo_alias: gate.repo_alias });
        continue;
      }

      if (intent === 'ambiguous') {
        if (!hasBotCommentAfter(comments, Date.parse(reply.created_at))) {
          try {
            await this.tracker.postComment(
              targetId,
              `🤖 I wasn't sure how to interpret that reply. Please respond with **approve** (or your answer/instructions) to continue, or **reject** to cancel.`,
            );
          } catch (err) {
            logger.warn('Failed to post ambiguous-reply clarification comment', { error: (err as Error).message });
          }
        }
        continue;
      }

      try {
        await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.waiting_human);
      } catch {
        /* ignore */
      }
      await this.resolveGateStateTransition(targetId, gate);

      if (intent === 'approve') {
        // gate_approved → running. SM emits label swap + executor_approve_and_resume
        // effect; the applier looks up the gate's run_id, calls the
        // approveAndResume hook (which spawns the subprocess that approves+
        // resumes the run), and deletes the supervised_gate entry.
        await this.emitTargetEvent('gate_waiting',
          { kind: 'gate_approved', message: classifiedMessage || null },
          this.buildGateTransitionCtx(gate));
        logger.info('Gate approved — approve+resume spawned via state machine', { issue_id: gate.issue_id, repo_alias: gate.repo_alias, run_id: gate.run_id ?? undefined });
      } else {
        // reject → gate_rejected (SM emits executor_reject, label → retrying, schedule retry).
        // resolveGateStateTransition already ran above before the approve/reject branch.
        await this.emitTargetEvent('gate_waiting',
          { kind: 'gate_rejected', message: classifiedMessage },
          this.buildGateTransitionCtx(gate));
        logger.info('Gate rejected — retry scheduled', { issue_id: gate.issue_id, repo_alias: gate.repo_alias });
      }
    }
  }


  private async resolveGateStateTransition(targetId: string, gate: SupervisedGateEntry): Promise<void> {
    if (!gate.gate_state_applied) return;
    const resume = defaultGateResumeState(this.cfg);
    try {
      await this.tracker.updateIssueState(targetId, resume);
      gate.gate_state_applied = false;
    } catch (err) {
      logger.warn('Failed to restore gate_resume_state', { error: (err as Error).message });
    }
  }

  // ─── worker exit ─────────────────────────────────────────────────────────
  /**
   * Worker exit handler. Determines the appropriate target state machine event
   * (worker_succeeded / worker_failed) and drives the transition through
   * targetTransition + EffectApplier. The supervised-gate special case (the
   * exited 0 but is actually paused) is handled inline before the SM call,
   * because handleGatePaused does plan-fetch + commenting work the SM doesn't
   * yet model.
   *
   * Legacy bookkeeping kept outside the SM:
   *   - session.stopPoller() and state.running.delete() — session lifecycle
   *   - target_machine_states['succeeded'] — populated by emitTargetEvent;
   *     queried by shouldDispatch / executeRetry / releaseOrphanedClaims
   *   - 1s "verify" continuation retry (Section 9.4) on success
   *   - promoteQueuedSiblings + maybeReleaseClaim — parent-state coordination
   */
  private async handleWorkerExit(
    issue: Issue,
    target: RepoTarget,
    event: { type: string; exit_code?: number },
    attempt: number | null,
  ): Promise<void> {
    const key = workerKey(issue.id, target.repo_alias);
    const session = this.state.running.get(key);
    const subIssueId = session?.sub_issue_id ?? this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias) ?? null;
    const targetId = subIssueId ?? issue.id;
    const dbRunId = session?.run_id ?? null;
    // Capture before the session is deleted below — used in the failure log
    // so the operator sees the last node output without querying the run.
    const recentOutput = session?.recent_output.slice() ?? [];

    // Defence in depth: confirm a reported success really is one before
    // treating it as terminal. The engine signals a pause with its own event
    // rather than a zero exit, so this should never fire — but a run that is
    // actually `paused` must never be recorded as complete.
    if (event.type === 'run_succeeded' && dbRunId) {
      try {
        const runDetail = await this.executorClient.getRunDetail(dbRunId);
        const run = runDetail?.run;
        if (run?.status === 'paused') {
          logger.info('Worker exit was gate pause — treating as supervised gate', {
            issue_id: issue.id, repo_alias: target.repo_alias, run_id: dbRunId,
          });
          session?.stopPoller?.();
          this.state.running.delete(key);
          const approval = run.metadata?.approval;
          const gateMessage = approval?.message ?? 'Plan gate — awaiting approval';
          void this.handleGatePaused(issue, target, subIssueId, dbRunId, gateMessage, attempt);
          return;
        }
      } catch {
        // Can't verify — fall through to the regular success/failure flow.
      }
    }

    // Choose the SM event. `run_succeeded` without a run id means the
    // process never emitted workflow_starting → treat as a failure so we retry.
    let smEvent: TargetEvent;
    if (event.type === 'run_succeeded' && dbRunId) {
      smEvent = { kind: 'worker_succeeded' };
    } else if (event.type === 'run_succeeded') {
      smEvent = { kind: 'worker_failed', reason: 'run_succeeded_without_run_id' };
    } else {
      smEvent = { kind: 'worker_failed', reason: event.type };
    }

    // Session lifecycle is not modeled by the SM.
    session?.stopPoller?.();
    this.state.running.delete(key);

    const ctx: TargetTransitionContext = {
      cfg: this.cfg,
      identity: {
        parent_issue_id: issue.id,
        repo_alias: target.repo_alias,
        target_issue_id: targetId,
      },
      parent_issue: issue,
      target,
      siblings: new Map(), // not consulted by running → succeeded/retrying transitions
      attempt: attempt ?? 0,
    };
    const transition = await this.emitTargetEvent('running', smEvent, ctx);

    if (transition.to === 'succeeded') {
      // target_machine_states is already populated by emitTargetEvent above.
      // Continuation retry per Section 9.4 (1s, attempt 1) — represents the
      // "verify" pass. Not yet modeled by the SM.
      this.scheduleRetry(issue, target, 1, null, 1000);
      logger.info('Worker succeeded', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        repo_alias: target.repo_alias,
      });
      await this.promoteQueuedSiblings(issue);
    } else {
      // Include the tail of node output so the failure cause is
      // visible without leaving the gaggle log (recent_output ring
      // buffer is fed by every node_output event).
      const lastLines = recentOutput.slice(-15);
      logger.warn('Worker exited abnormally', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
        type: event.type,
        exit_code: event.exit_code,
        run_id: dbRunId ?? undefined,
        next_attempt: (attempt ?? 0) + 1,
        last_output: lastLines.length > 0 ? lastLines.join('\n') : '(no output captured)',
      });
    }

    // Phase 5c.2: if the transition reached a target-terminal state, fan
    // the target_terminal event up to the parent SM so it can transition
    // claimed → done | cancelled when all targets finish. maybeReleaseClaim
    // remains as the legacy path for the parallel state.claimed bookkeeping.
    if (transition.to === 'succeeded' || transition.to === 'failed') {
      const currentParent = this.state.parent_machine_states.get(issue.id) ?? 'unclaimed';
      if (currentParent === 'claimed') {
        await this.emitParentEvent('claimed', {
          kind: 'target_terminal',
          alias: target.repo_alias,
          outcome: transition.to,
        }, {
          cfg: this.cfg,
          parent_issue: issue,
          targets: this.buildParentTargetsMap(issue.id),
        });
      }
    }

    await this.maybeReleaseClaim(issue.id);
  }

  /** A parent is "active" (currently being worked on) if its SM state is
   *  either analyzing or claimed. Used by shouldDispatch and
   *  dispatchSubIssueFromPoll to skip already-active parents. */
  private isParentActive(parentId: string): boolean {
    const s = this.state.parent_machine_states.get(parentId);
    return s === 'analyzing' || s === 'claimed';
  }

  /** Build a snapshot of `alias → TargetState` for every target known to the
   *  SM under the given parent, for use as the `targets` field of the parent
   *  TransitionContext. */
  private buildParentTargetsMap(parentId: string): ReadonlyMap<string, TargetState> {
    const out = new Map<string, TargetState>();
    const prefix = parentId + '__';
    for (const [key, smState] of this.state.target_machine_states) {
      if (key.startsWith(prefix)) {
        out.set(key.slice(prefix.length), smState);
      }
    }
    return out;
  }

  /** Promote sibling sub-issues from gaggle:queued → gaggle:running and launch their runs. */
  private async promoteQueuedSiblings(parentIssue: Issue): Promise<void> {
    const sibMap = this.state.sibling_subissues.get(parentIssue.id);
    if (!sibMap || sibMap.size === 0) return;

    const subIds = [...sibMap.values()];
    let freshSubs: import('../domain/types.ts').Issue[];
    try {
      freshSubs = await this.tracker.fetchIssueStatesByIds(subIds);
    } catch (err) {
      logger.warn('promoteQueuedSiblings: failed to fetch sibling states', { error: (err as Error).message });
      return;
    }

    const queuedLabel = this.cfg.tracker.gaggle_labels.queued.toLowerCase();
    for (const sub of freshSubs) {
      if (!sub.labels.some((l) => l === queuedLabel)) continue;
      if (!this.cfg.tracker.active_states.includes(sub.state)) continue;
      if (!blockersSatisfied(sub.blocked_by, this.cfg)) continue;

      const alias = this.parseAliasFromTitle(sub.title);
      if (!alias) continue;
      const key = workerKey(parentIssue.id, alias);
      if (this.state.running.has(key) || this.state.target_machine_states.get(key) === 'succeeded') continue;

      if (availableSlots(this.state) === 0) {
        logger.info('No slots to promote queued sibling; will retry next tick', {
          parent_id: parentIssue.id, repo_alias: alias,
        });
        continue;
      }

      const target = this.buildRepoTargetFromSubIssue(sub);
      if (!target) continue;

      // Remove queued label before launching.
      try { await this.tracker.removeLabel(sub.id, this.cfg.tracker.gaggle_labels.queued); } catch { /* non-fatal */ }

      // Remove from pending_targets so maybeReleaseClaim stays accurate.
      const pending = this.state.pending_targets.get(parentIssue.id) ?? [];
      const remaining = pending.filter((t) => t.repo_alias !== alias);
      if (remaining.length === 0) this.state.pending_targets.delete(parentIssue.id);
      else this.state.pending_targets.set(parentIssue.id, remaining);

      logger.info('Promoting queued sibling', { parent_id: parentIssue.id, repo_alias: alias, sub_issue_id: sub.id });
      await this.launchWorker(parentIssue, target, sub.id, null, sub.description ?? undefined);
    }
  }

  private async maybeReleaseClaim(issue_id: string): Promise<void> {
    // No-auto-retry policy: if any target for this parent is in `failed`
    // state, the operator must resolve before the parent can be released.
    // Do NOT force-release.
    for (const [key, state] of this.state.target_machine_states) {
      if (key.startsWith(issue_id + '__') && state === 'failed') {
        return;
      }
    }

    const pending = this.state.pending_targets.get(issue_id) ?? [];
    if (
      noRunningWorkersFor(this.state, issue_id) &&
      pending.length === 0 &&
      noRetryEntriesFor(this.state, issue_id)
    ) {
      // Legacy final cleanup: clear the parent from the SM map. Any preceding
      // SM transition (target_terminal / parent_externally_terminal) will have
      // already emitted its effects; this removes the now-stale entry so the
      // parent is no longer tracked at all.
      this.state.parent_machine_states.delete(issue_id);
      this.state.pending_issues.delete(issue_id);
      try {
        await this.tracker.removeLabel(issue_id, this.cfg.tracker.gaggle_labels.claimed);
      } catch {
        /* ignore */
      }
      // Transition the parent issue out of active_states so it is not re-dispatched.
      const terminalState = completedState(this.cfg);
      try {
        await this.tracker.updateIssueState(issue_id, terminalState);
        logger.info('Issue claim released — parent transitioned to terminal state', {
          issue_id,
          state: terminalState,
        });
      } catch (err) {
        logger.warn('Issue claim released but could not transition parent to terminal state', {
          issue_id,
          state: terminalState,
          error: (err as Error).message,
        });
      }
    }
  }

  // ─── retry queue ─────────────────────────────────────────────────────────
  private scheduleRetry(
    issue: Issue,
    target: RepoTarget,
    attempt: number,
    error: string | null,
    overrideDelayMs?: number,
  ): void {
    const key = workerKey(issue.id, target.repo_alias);
    const existing = this.state.retry_attempts.get(key);
    if (existing && existing.timer_handle) clearTimeout(existing.timer_handle);

    if (attempt > 10) {
      logger.error('Max retries exhausted; abandoning', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
        error,
      });
      this.state.retry_attempts.delete(key);
      void this.tracker
        .updateIssueState(
          this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias) ?? issue.id,
          'Cancelled',
        )
        .catch(() => {});
      void this.maybeReleaseClaim(issue.id);
      return;
    }

    const delay =
      overrideDelayMs !== undefined
        ? overrideDelayMs
        : Math.min(10_000 * Math.pow(2, attempt - 1), this.cfg.agent.max_retry_backoff_ms);
    const due_at_ms = Date.now() + delay;

    const timer = setTimeout(() => {
      void this.executeRetry(key, issue, target, attempt);
    }, delay);

    const entry: RetryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      repo_alias: target.repo_alias,
      repo_target: target,
      issue,
      attempt,
      due_at_ms,
      timer_handle: timer,
      error,
    };
    this.state.retry_attempts.set(key, entry);
    logger.info('Retry scheduled', {
      issue_id: issue.id,
      repo_alias: target.repo_alias,
      attempt,
      delay_ms: delay,
    });
  }

  private async executeRetry(key: string, issue: Issue, target: RepoTarget, attempt: number): Promise<void> {
    this.state.retry_attempts.delete(key);

    // If a run already succeeded for this (issue, repo) pair, the sub-issue was marked Done.
    // Do not re-dispatch — release the claim and stop.
    if (this.state.target_machine_states.get(key) === 'succeeded') {
      logger.info('Worker already completed successfully; skipping retry', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
      });
      await this.maybeReleaseClaim(issue.id);
      return;
    }

    // Re-validate state from tracker; if no longer dispatchable, release.
    // Check both the parent issue AND the sub-issue (if one was created).
    let refreshed: Issue | undefined;
    try {
      const subIssueId = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias);
      const idToCheck = subIssueId ?? issue.id;
      const fresh = await this.tracker.fetchIssueStatesByIds([idToCheck]);
      refreshed = fresh[0];
    } catch {
      /* keep stale */
    }
    const current = refreshed ?? issue;

    if (!this.cfg.tracker.active_states.includes(current.state)) {
      logger.info('Issue no longer active at retry time; releasing', { issue_id: issue.id, state: current.state });
      // If the issue moved to a terminal state externally, drive the parent SM
      // externally-terminal transition so parent_machine_states reflects it.
      if (this.cfg.tracker.terminal_states.includes(current.state)) {
        const parentSm = this.state.parent_machine_states.get(issue.id);
        if (parentSm === 'analyzing' || parentSm === 'claimed') {
          await this.emitParentEvent(parentSm, { kind: 'parent_externally_terminal' }, {
            cfg: this.cfg,
            parent_issue: current,
            targets: this.buildParentTargetsMap(issue.id),
          });
        }
      }
      await this.maybeReleaseClaim(issue.id);
      return;
    }

    if (availableSlots(this.state) === 0) {
      this.scheduleRetry(current, target, attempt, 'no slots'); // re-queue with same attempt
      return;
    }

    const analysis = this.state.analysis_cache.get(issue.id)?.analysis;
    if (!analysis) {
      logger.warn('No cached analysis at retry; rescheduling after re-analysis delay', { issue_id: issue.id });
      // Re-queue with the same attempt number so the retry fires after a short delay,
      // by which point the next tick will have had a chance to re-analyze the issue.
      this.scheduleRetry(current, target, attempt, 'no_cached_analysis', 5_000);
      return;
    }

    const subIssueId = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias) ?? null;
    const targetId = subIssueId ?? issue.id;

    // Ensure pending_issues is populated so the spawnWorker hook can resolve
    // the refreshed Issue. The hook also uses analysis_cache.
    this.state.pending_issues.set(current.id, current);

    // Drive retrying → dispatching via the SM. Effects:
    //   remove gaggle:retrying, apply gaggle:dispatching, delete_retry,
    //   spawn_worker (hook calls launchWorker with the cached analysis).
    await this.emitTargetEvent('retrying', { kind: 'retry_due' }, {
      cfg: this.cfg,
      identity: {
        parent_issue_id: current.id,
        repo_alias: target.repo_alias,
        target_issue_id: targetId,
      },
      parent_issue: current,
      target,
      siblings: new Map(),
      attempt,
    });
  }

  // ─── reconciliation ──────────────────────────────────────────────────────
  private async reconcileRunningIssues(): Promise<void> {
    // Stall detection is handled per-session by RunPoller.
    // reconcileRunningIssues only reconciles Linear state and detached runs.

    const ids = new Set<string>();
    for (const key of this.state.running.keys()) {
      const sep = key.indexOf('__');
      if (sep > 0) ids.add(key.slice(0, sep));
    }

    if (ids.size > 0) {
      let refreshed: Issue[];
      try {
        refreshed = await this.tracker.fetchIssueStatesByIds([...ids]);
      } catch (err) {
        logger.debug('Reconciliation fetch failed; keep workers', { error: (err as Error).message });
        refreshed = [];
      }

      for (const issue of refreshed) {
        // Skip `pr_ready_state` even when it appears in `terminal_states`.
        // The Linear↔GitHub integration moves issues to this state when a
        // PR is opened, but the workflow itself usually has post-PR phases
        // (multi-agent review, self-fix, validation) still to run. Cancelling
        // here would abandon that work part-way and post a misleading
        // "worker failed" comment.
        const prReady = this.cfg.tracker.pr_ready_state;
        const isTerminal =
          this.cfg.tracker.terminal_states.includes(issue.state) &&
          (prReady === null || issue.state !== prReady);
        if (isTerminal) {
          for (const [key, session] of this.state.running) {
            if (session.issue.id !== issue.id) continue;
            try {
              session.cancel?.();
            } catch {
              /* ignore */
            }
            this.state.running.delete(key);
          }
          // Drive the parent SM externally-terminal transition. The SM emits
          // remove_label(claimed), cleanup_workspace, invalidate_analysis_cache
          // — so the inline cleanup below is also covered. The legacy
          // maybeReleaseClaim remains as a backstop for state.pending_targets /
          // state.retry_attempts which the SM doesn't yet own.
          const parentSm = this.state.parent_machine_states.get(issue.id);
          if (parentSm === 'analyzing' || parentSm === 'claimed') {
            await this.emitParentEvent(parentSm, { kind: 'parent_externally_terminal' }, {
              cfg: this.cfg,
              parent_issue: issue,
              targets: this.buildParentTargetsMap(issue.id),
            });
          } else {
            // SM not tracking this parent — fall back to inline cleanup.
            this.workspace.cleanAuxiliaryWorkspace(issue.identifier);
            this.state.analysis_cache.delete(issue.id);
          }
          await this.maybeReleaseClaim(issue.id);
        } else if (
          this.cfg.tracker.active_states.includes(issue.state) ||
          (prReady !== null && issue.state === prReady)
        ) {
          // Active OR pr_ready_state: refresh the cached issue snapshot but
          // keep the worker alive. pr_ready_state is treated as "PR is open,
          // post-PR phases (review/self-fix) may still be running".
          for (const [, session] of this.state.running) {
            if (session.issue.id === issue.id) session.issue = issue;
          }
        } else {
          // Neither active nor terminal — stop without cleanup
          for (const [key, session] of this.state.running) {
            if (session.issue.id !== issue.id) continue;
            try {
              session.cancel?.();
            } catch {
              /* ignore */
            }
            this.state.running.delete(key);
          }
        }
      }
    }

    // Poll detached runs (runs found still alive at startup that we
    // cannot re-attach to). Check if they have since completed, failed, or paused.
    // NOTE: this block must run even when state.running is empty (the typical post-crash case).
    if (this.state.detached_runs.size > 0) {
      const freshRuns = await this.executorClient.listRuns();
      const freshById = new Map<string, RunRecord>(freshRuns.map((r) => [r.id, r]));

      for (const [key, det] of [...this.state.detached_runs]) {
        const run = freshById.get(det.run_id);
        const status = run?.status ?? 'not_found';

        if (status === 'running') continue; // still going

        this.state.detached_runs.delete(key);
        this.state.running.delete(key); // free the slot

        const targetId = det.sub_issue_id ?? det.parent_issue.id;

        if (status === 'completed') {
          try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.updateIssueState(targetId, completedState(this.cfg)); } catch { /* ignore */ }
          this.state.target_machine_states.set(key, 'succeeded');
          logger.info('Detached run completed — marked Done', {
            run_id: det.run_id,
            repo_alias: det.repo_alias,
          });
          await this.promoteQueuedSiblings(det.parent_issue);
          await this.maybeReleaseClaim(det.parent_issue.id);
        } else if (status === 'paused') {
          this.state.supervised_gates.set(key, {
            run_id: run?.id ?? null,
            issue_id: det.parent_issue.id,
            issue: det.parent_issue,
            repo_alias: det.repo_alias,
            repo_target: det.repo_target,
            sub_issue_id: det.sub_issue_id,
            paused_at: Date.now(),
            gate_message: run?.metadata?.approval?.message ?? '(detached gate)',
            comment_id: null,
            gate_state_applied: false,
            attempt: null,
          });
          try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.waiting_human); } catch { /* ignore */ }
          logger.info('Detached run moved to gate — restored supervised gate', {
            run_id: det.run_id,
            repo_alias: det.repo_alias,
          });
        } else {
          // failed or not_found — re-queue
          try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.queued); } catch { /* ignore */ }
          this.scheduleRetry(det.parent_issue, det.repo_target, 1, `detached_run_${status}`);
          logger.warn('Detached run failed or not found — re-queued', {
            run_id: det.run_id,
            repo_alias: det.repo_alias,
            status,
          });
        }
      }
    }

    // Refresh sibling sub-issues for parked targets (Section 9.5 Part C)
    const subIds = new Set<string>();
    for (const [issueId, pending] of this.state.pending_targets) {
      const subMap = this.state.sibling_subissues.get(issueId);
      if (!subMap) continue;
      for (const t of pending) {
        for (const upstream of t.depends_on ?? []) {
          const sid = subMap.get(upstream);
          if (sid) subIds.add(sid);
        }
      }
    }
    if (subIds.size > 0) {
      try {
        const refreshedSubs = await this.tracker.fetchIssueStatesByIds([...subIds]);
        const now = Date.now();
        for (const s of refreshedSubs) {
          this.state.subissue_snapshot.set(s.id, { state: s.state, labels: s.labels, refreshed_at: now });
        }
      } catch (err) {
        logger.debug('Sibling refresh failed', { error: (err as Error).message });
      }
    }
  }

  // ─── startup terminal cleanup ────────────────────────────────────────────
  private async startupTerminalCleanup(): Promise<void> {
    let issues: Issue[];
    try {
      issues = await this.tracker.fetchIssuesByStates(this.cfg.tracker.terminal_states);
    } catch (err) {
      logger.warn('Startup terminal cleanup fetch failed; continuing', { error: (err as Error).message });
      return;
    }
    if (!this.cfg.workspace.root || !existsSync(this.cfg.workspace.root)) return;
    const entries = readdirSync(this.cfg.workspace.root);
    for (const issue of issues) {
      const safe = sanitizeId(issue.identifier);
      for (const name of entries) {
        if (name.startsWith(safe + '__')) {
          const full = join(this.cfg.workspace.root, name);
          try {
            rmSync(full, { recursive: true, force: true });
            logger.info('Cleaned terminal workspace', { dir: full, issue_identifier: issue.identifier });
          } catch (err) {
            logger.warn('Cleanup failed', { dir: full, error: (err as Error).message });
          }
        }
      }
    }
  }

  // ─── label-driven recovery (Section 12.4) ────────────────────────────────
  private async recoverFromLinearLabels(): Promise<void> {
    try {
      const ctx = await this.loadRecoveryContext();
      this.recoverClaimedParents(ctx);
      await this.recoverRunningIssues(ctx);
      await this.recoverQueuedIssues(ctx);
      await this.recoverRetryingIssues(ctx);
      await this.releaseOrphanedClaims(ctx);
      this.recoverWaitingIssues(ctx);
    } catch (err) {
      logger.warn('Label-driven recovery encountered an error', { error: (err as Error).message });
    }
  }

  private async loadRecoveryContext(): Promise<RecoveryContext> {
    const [claimedIssues, runningIssues, queuedIssues, waitingIssues, retryingIssues, executorRuns] = await Promise.all([
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.claimed),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.running),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.queued),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.waiting_human),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.retrying),
      this.executorClient.listRuns(),
    ]);
    const persistedRunIds = allRunEntries(this.cfg.registry.base_folder);
    const persistedRetries = allRetryEntries(this.cfg.registry.base_folder);
    const runsById = new Map<string, RunRecord>(executorRuns.map((r) => [r.id, r]));
    logger.info('Run status snapshot at startup', {
      total_runs: executorRuns.length,
      persisted_run_ids: Object.keys(persistedRunIds).length,
      persisted_retries: Object.keys(persistedRetries).length,
    });
    return { claimedIssues, runningIssues, queuedIssues, waitingIssues, retryingIssues, executorRuns, runsById, persistedRunIds, persistedRetries };
  }

  private recoverClaimedParents(ctx: RecoveryContext): void {
    for (const issue of ctx.claimedIssues) {
      // Only mark as claimed if it's a parent (no parent_id). Stash the Issue
      // snapshot in pending_issues so later recovery passes — and the
      // EffectApplier's spawnWorker / scheduleRetry hooks — can resolve the
      // parent without a Linear round-trip. Hydrate parent_machine_states so
      // the SM reflects the parent's recovered state.
      if (!issue.parent_id) {
        this.state.pending_issues.set(issue.id, issue);
        this.state.parent_machine_states.set(issue.id, 'claimed');
      }
    }
  }

  private async recoverRunningIssues(ctx: RecoveryContext): Promise<void> {
    for (const issue of ctx.runningIssues) {
      // Issues no longer active (terminal or gray-zone) finished/paused while we were down — clean the stale label.
      if (!this.cfg.tracker.active_states.includes(issue.state ?? '')) {
        try {
          await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running);
        } catch { /* ignore */ }
        continue;
      }

      const parentId = issue.parent_id ?? issue.id;
      const aliasGuess = this.resolveAliasForRunningIssue(issue, parentId, ctx);

      // Register in sibling map so other recovery steps can reference this sub-issue.
      if (aliasGuess) {
        let map = this.state.sibling_subissues.get(parentId);
        if (!map) { map = new Map(); this.state.sibling_subissues.set(parentId, map); }
        map.set(aliasGuess, issue.id);
      }

      const runRecord = this.resolveRunForTarget(parentId, aliasGuess, ctx);
      const identity: TargetIdentity = {
        parent_issue_id: parentId,
        repo_alias: aliasGuess ?? '',
        target_issue_id: issue.id,
      };

      // Classify the target's state from labels + run status. The classifier
      // collapses the four-way (running / paused / completed / failed-or-missing)
      // run-status switch into a single TargetState we can dispatch on.
      const classification = classifyTargetState({
        identity,
        target_labels: new Set(['running']),
        linear_state: issue.state ?? '',
        executor_run: runRecord,
        persisted_retry: ctx.persistedRetries[workerKey(parentId, aliasGuess ?? '')] ?? null,
      });

      // Without an alias the classifier still works, but the recovery handlers
      // for `running` and `gate_waiting` need it to build the RepoTarget. Treat
      // missing-alias cases as retrying so they fall through to re-queue.
      const effectiveState = aliasGuess ? classification?.state : 'retrying';

      switch (effectiveState) {
        case 'running': {
          // Run still alive — track as detached; the reconciler will poll it.
          const key = workerKey(parentId, aliasGuess!);
          const target = this.buildRepoTargetForAlias(aliasGuess!, issue);
          const parentIssue = this.state.pending_issues.get(parentId) ?? issue;
          this.state.detached_runs.set(key, {
            run_id: runRecord!.id,
            parent_issue: parentIssue as Issue,
            sub_issue_id: issue.parent_id ? issue.id : null,
            repo_alias: aliasGuess!,
            repo_target: target,
            recovered_at: Date.now(),
          });
          this.state.running.set(key, buildLiveSession({
            issue: parentIssue as Issue,
            repo_target: target,
            attempt: null,
            sub_issue_id: issue.parent_id ? issue.id : null,
            cancel: () => {},
          }));
          logger.info('Recovered: run still going — tracking as detached', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess!,
            run_id: runRecord!.id,
          });
          break;
        }

        case 'gate_waiting': {
          // Run paused at a gate — restore the supervised gate entry and
          // swap running → waiting-human so labels reflect reality.
          const key = workerKey(parentId, aliasGuess!);
          const target = this.buildRepoTargetForAlias(aliasGuess!, issue);
          const parentIssue = this.state.pending_issues.get(parentId) ?? issue;
          this.state.supervised_gates.set(key, {
            run_id: runRecord!.id,
            issue_id: parentId,
            issue: parentIssue as Issue,
            repo_alias: aliasGuess!,
            repo_target: target,
            sub_issue_id: issue.parent_id ? issue.id : null,
            paused_at: Date.now(),
            gate_message: runRecord!.metadata?.approval?.message ?? '(recovered gate)',
            comment_id: null,
            gate_state_applied: false,
            attempt: null,
          });
          try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(issue.id, this.cfg.tracker.gaggle_labels.waiting_human); } catch { /* ignore */ }
          logger.info('Recovered: run paused at gate — restored supervised gate', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess!,
            run_id: runRecord!.id,
          });
          break;
        }

        case 'succeeded': {
          // Run finished while we were down — mark target Done.
          try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.updateIssueState(issue.id, completedState(this.cfg)); } catch { /* ignore */ }
          this.state.target_machine_states.set(workerKey(parentId, aliasGuess!), 'succeeded');
          logger.info('Recovered: run completed while down — marked Done', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess!,
            run_id: runRecord!.id,
          });
          break;
        }

        case 'retrying':
        default: {
          // Run crashed, missing, or alias unresolvable — re-queue.
          try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(issue.id, this.cfg.tracker.gaggle_labels.queued); } catch { /* ignore */ }
          logger.info('Recovered: run missing or crashed — re-queued', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess ?? '(unknown)',
          });
          break;
        }
      }
    }
  }

  private async recoverQueuedIssues(ctx: RecoveryContext): Promise<void> {
    // Recover sub-issues that were queued but not yet dispatched.
    const parentIdsToPromote = new Set<string>();
    for (const issue of ctx.queuedIssues) {
      if (!issue.parent_id) continue; // only sub-issues carry gaggle:queued
      if (!this.cfg.tracker.active_states.includes(issue.state ?? '')) continue;
      const aliasGuess = this.parseAliasFromTitle(issue.title);
      if (!aliasGuess) continue;
      const parentId = issue.parent_id;
      let map = this.state.sibling_subissues.get(parentId);
      if (!map) { map = new Map(); this.state.sibling_subissues.set(parentId, map); }
      map.set(aliasGuess, issue.id);
      this.state.target_machine_states.set(workerKey(parentId, aliasGuess), 'queued');
      parentIdsToPromote.add(parentId);
      logger.info('Recovered queued sub-issue', {
        issue_identifier: issue.identifier, parent_id: parentId, repo_alias: aliasGuess,
      });
    }

    // Promote any queued siblings whose blockers are already satisfied (e.g. BE merged while orchestrator was down).
    for (const parentId of parentIdsToPromote) {
      let parentIssue = this.state.pending_issues.get(parentId);
      if (!parentIssue) {
        try {
          const fetched = await this.tracker.fetchIssueStatesByIds([parentId]);
          parentIssue = fetched[0];
        } catch { /* ignore */ }
      }
      if (parentIssue) {
        this.state.pending_issues.set(parentId, parentIssue);
        await this.promoteQueuedSiblings(parentIssue);
      }
    }
  }

  /**
   * Restore retry timers for targets that were in `retrying` state when the
   * orchestrator crashed. Reads the persisted retry-registry and reschedules
   * each entry's timer at `max(0, due_at_ms - now)`, preserving the original
   * attempt count and back-off schedule.
   *
   * Entries whose corresponding issue no longer carries gaggle:retrying are
   * deleted from disk (orphaned, e.g. user manually cleared the label).
   */
  private async recoverRetryingIssues(ctx: RecoveryContext): Promise<void> {
    const retryIssueIds = new Set(ctx.retryingIssues.map((i) => i.id));

    for (const issue of ctx.retryingIssues) {
      if (!this.cfg.tracker.active_states.includes(issue.state ?? '')) {
        try {
          await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.retrying);
        } catch { /* ignore */ }
        continue;
      }

      const parentId = issue.parent_id ?? issue.id;
      const aliasFromTitle = this.parseAliasFromTitle(issue.title);
      // Fall back to looking up the alias via the persisted retry entry by
      // sub_issue_id (for cases where the issue title carries no [alias]
      // prefix because it IS the parent in a mono-repo setup).
      let alias: string | null = aliasFromTitle;
      if (!alias) {
        const entry = Object.values(ctx.persistedRetries).find(
          (e) => e.parent_issue_id === parentId && (e.sub_issue_id === null || e.sub_issue_id === issue.id),
        );
        alias = entry?.repo_alias ?? null;
      }
      if (!alias) {
        logger.warn('Recovered retrying issue with no resolvable alias; skipping', {
          issue_id: issue.id, issue_identifier: issue.identifier,
        });
        continue;
      }

      const key = workerKey(parentId, alias);
      const retry = ctx.persistedRetries[key];

      // Register in sibling map so downstream coordination sees this target.
      let sibMap = this.state.sibling_subissues.get(parentId);
      if (!sibMap) { sibMap = new Map(); this.state.sibling_subissues.set(parentId, sibMap); }
      sibMap.set(alias, issue.id);

      // Resolve the parent Issue snapshot (needed by the spawnWorker hook).
      let parentIssue = this.state.pending_issues.get(parentId);
      if (!parentIssue) {
        if (parentId === issue.id) {
          parentIssue = issue;
        } else {
          try {
            const fetched = await this.tracker.fetchIssueStatesByIds([parentId]);
            parentIssue = fetched[0];
          } catch { /* ignore */ }
        }
      }
      if (!parentIssue) {
        logger.warn('Cannot resolve parent issue for retrying target; skipping', {
          retrying_issue_id: issue.id, parent_id: parentId,
        });
        continue;
      }
      this.state.pending_issues.set(parentId, parentIssue);

      const target = this.buildRepoTargetForAlias(alias, parentIssue);
      const attempt = retry?.attempt ?? 1;
      const reason = retry?.reason ?? 'recovered_from_disk';
      const delay = retry ? Math.max(0, retry.due_at_ms - Date.now()) : 0;

      this.scheduleRetry(parentIssue, target, attempt, reason, delay);
      this.state.target_machine_states.set(key, 'retrying');
      logger.info('Recovered retrying target — retry timer rescheduled', {
        issue_identifier: issue.identifier,
        parent_id: parentId,
        repo_alias: alias,
        attempt,
        delay_ms: delay,
      });
    }

    // Clean up orphaned retry entries — persisted but no matching label.
    for (const [retryKey, entry] of Object.entries(ctx.persistedRetries)) {
      const targetIssueId = entry.sub_issue_id ?? entry.parent_issue_id;
      if (!retryIssueIds.has(targetIssueId)) {
        deleteRetryEntry(this.cfg.registry.base_folder, retryKey);
        logger.info('Pruned orphaned retry entry', { key: retryKey });
      }
    }
  }

  private async releaseOrphanedClaims(ctx: RecoveryContext): Promise<void> {
    // Orphaned claimed parents: check whether all recovered siblings (if any) have already
    // completed.  Three cases:
    //   (a) Running sub whose run completed → sibling_subissues IS populated but every
    //       entry has target_machine_states === 'succeeded'.  Work is done → release to terminal.
    //   (b) No running/queued siblings at all but a persisted run entry shows the run completed
    //       (crash after handleWorkerExit removed the running label but before
    //       maybeReleaseClaim) → release to terminal.
    //   (c) No siblings and no completed run → crash before the first worker was ever launched
    //       → un-claim only so the poll loop re-dispatches on the next tick.
    const claimedParentIds: string[] = [];
    for (const [pid, smState] of this.state.parent_machine_states) {
      if (smState === 'claimed') claimedParentIds.push(pid);
    }
    for (const parentId of claimedParentIds) {
      const sibMap = this.state.sibling_subissues.get(parentId);
      // Skip parents that still have active siblings (running, queued, or awaiting gate).
      const allSibsCompleted =
        !sibMap || sibMap.size === 0 ||
        [...sibMap.keys()].every((alias) => this.state.target_machine_states.get(workerKey(parentId, alias)) === 'succeeded');
      if (!allSibsCompleted) continue;

      // Determine whether actual work ran for this parent.
      const workDone =
        (sibMap && sibMap.size > 0) || // at least one sibling completed during recovery
        Object.values(ctx.persistedRunIds).some(
          (e) => e.parent_issue_id === parentId && ctx.runsById.get(e.run_id)?.status === 'completed',
        );

      if (workDone) {
        logger.info('Orphaned claimed parent detected on startup (work completed) — releasing', { parent_id: parentId });
        await this.maybeReleaseClaim(parentId);
      } else {
        logger.info('Orphaned claimed parent detected on startup (no work started) — un-claiming for re-dispatch', { parent_id: parentId });
        // Un-claim: parent goes back to unclaimed (i.e. removed from the SM
        // map) so the poll loop can re-pick it up next tick.
        this.state.parent_machine_states.delete(parentId);
        this.state.pending_issues.delete(parentId);
        try { await this.tracker.removeLabel(parentId, this.cfg.tracker.gaggle_labels.claimed); } catch { /* ignore */ }
      }
    }
  }

  private recoverWaitingIssues(ctx: RecoveryContext): void {
    // Build lookups from issue_id → repo_alias and issue_id → run_id using persisted
    // run entries, so parent issues (no [alias] title prefix) can have their gates fully
    // recovered after a restart — including the run_id needed to approve or reject.
    const runAliasById = new Map<string, string>();
    const runIdById = new Map<string, string>();
    for (const entry of Object.values(ctx.persistedRunIds)) {
      runAliasById.set(entry.parent_issue_id, entry.repo_alias);
      runIdById.set(entry.parent_issue_id, entry.run_id);
    }

    for (const issue of ctx.waitingIssues) {
      const m = issue.title.match(/^\[([^\]]+)\]/);
      const parentId = issue.parent_id ?? issue.id;
      // Prefer title-derived alias (sub-issues), fall back to persisted run entry (parent issues).
      const aliasGuess = m ? m[1]! : (runAliasById.get(parentId) ?? null);
      if (!aliasGuess) continue;
      // Reconstruct the supervised_gates entry, restoring the Archon run_id so that
      // approve/reject can be forwarded even after the hub was restarted.
      const recoveredRunId = runIdById.get(parentId) ?? null;
      const key = workerKey(parentId, aliasGuess);
      this.state.supervised_gates.set(key, {
        run_id: recoveredRunId,
        issue_id: parentId,
        issue: { ...issue, id: parentId },
        repo_alias: aliasGuess,
        repo_target: {
          repo_url: '',
          repo_alias: aliasGuess,
          local_path: '',
          workflow: '',
          rationale: '',
          components: [],
        },
        sub_issue_id: issue.parent_id ? issue.id : null,
        paused_at: Date.now(),
        gate_message: '(recovered after restart)',
        comment_id: null,
        gate_state_applied: false,
        attempt: null,
      });
      this.state.target_machine_states.set(key, 'gate_waiting');
      logger.info('Recovered supervised gate (executor process gone)', {
        issue_identifier: issue.identifier,
      });
    }
  }

  private resolveAliasForRunningIssue(
    issue: Issue,
    parentId: string,
    ctx: RecoveryContext,
  ): string | null {
    const fromTitle = this.parseAliasFromTitle(issue.title);
    if (fromTitle) return fromTitle;
    const fallback = Object.entries(ctx.persistedRunIds).find(
      ([, e]) => e.parent_issue_id === parentId && (e.sub_issue_id === null || e.sub_issue_id === issue.id),
    );
    return fallback?.[1].repo_alias ?? null;
  }

  private resolveRunForTarget(
    parentId: string,
    alias: string | null,
    ctx: RecoveryContext,
  ): RunRecord | null {
    const key = workerKey(parentId, alias ?? '');
    const persistedEntry = ctx.persistedRunIds[key];
    let run: RunRecord | null = persistedEntry
      ? (ctx.runsById.get(persistedEntry.run_id) ?? null)
      : null;
    if (!run && alias) {
      const repoBasename =
        this.registry.getContext().repositories.find((r) => r.name === alias)?.local_path
          .split(/[\\/]/).pop() ?? alias;
      run = findRunForRepo(ctx.executorRuns, repoBasename, ['running', 'paused', 'completed']);
    }
    return run;
  }

  private buildRepoTargetForAlias(alias: string, issue: Issue): RepoTarget {
    const repoMeta = this.registry.getContext().repositories.find((r) => r.name === alias);
    return {
      repo_url: repoMeta?.url ?? '',
      repo_alias: alias,
      local_path: repoMeta?.local_path ?? '',
      workflow: repoMeta?.default_workflow ?? this.cfg.executor.default_workflow,
      rationale: issue.description ?? issue.title,
      components: [],
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
/** Returns true if the GitHub PR at prUrl is in MERGED state, false on any error or non-merged state. */
export async function checkGitHubPRMerged(prUrl: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ['gh', 'pr', 'view', prUrl, '--json', 'state', '-q', '.state'],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const [, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return text.trim() === 'MERGED';
  } catch {
    return false;
  }
}

/**
 * Returns true if a comment was authored by the orchestrator.
 * Checks both author name (for dedicated bot accounts) and body prefix (for personal API keys
 * where all comments share the same author name regardless of origin).
 */
export function isBotComment(c: { body: string; author: { name: string | null } }): boolean {
  if (c.author.name !== null && /symphony|gaggle|bot/i.test(c.author.name)) return true;
  return c.body.trimStart().startsWith('🤖');
}

export function findHumanReplyAfter(
  comments: { id: string; body: string; author: { id: string | null; name: string | null }; created_at: string }[],
  pausedAt: number,
): { id: string; body: string; created_at: string } | null {
  const filtered = comments
    .filter((c) => Date.parse(c.created_at) > pausedAt)
    .filter((c) => c.author.name !== null && !isBotComment(c));
  if (filtered.length === 0) return null;
  const last = filtered[filtered.length - 1]!;
  return { id: last.id, body: last.body, created_at: last.created_at };
}

/** Returns true if there is a bot/orchestrator comment posted strictly after afterMs. */
export function hasBotCommentAfter(
  comments: { body: string; author: { name: string | null }; created_at: string }[],
  afterMs: number,
): boolean {
  return comments.some(
    (c) => Date.parse(c.created_at) > afterMs && isBotComment(c),
  );
}

export function classifyApprovalIntent(body: string): 'approve' | 'reject' | 'ambiguous' {
  const trimmed = body.trim();
  if (APPROVE_KEYWORDS.test(trimmed)) return 'approve';
  if (REJECT_KEYWORDS.test(trimmed)) return 'reject';
  return 'ambiguous';
}

/**
 * Classify a comment posted on a `gaggle:failed`-labelled issue.
 *
 *   retry    — operator wants a fresh worker spawn ("retry", "rerun",
 *              "restart", "try again", "go", "run")
 *   cancel   — operator gives up on this target ("cancel", "abandon",
 *              "skip", "stop", "drop", "nevermind")
 *   ambiguous — anything else; the orchestrator posts a clarification
 *
 * Keyword-only (no Claude call) — operator retry/cancel intent is
 * unambiguous and we don't need the latency / cost.
 */
const RETRY_KEYWORDS = /^(retry|rerun|restart|try\s+again|go|run)\b/i;
const CANCEL_KEYWORDS = /^(cancel(led)?|abandon|skip|stop|drop|nevermind|nvm|don'?t|no)\b/i;
export function classifyRetryIntent(body: string): 'retry' | 'cancel' | 'ambiguous' {
  const trimmed = body.trim();
  if (RETRY_KEYWORDS.test(trimmed)) return 'retry';
  if (CANCEL_KEYWORDS.test(trimmed)) return 'cancel';
  return 'ambiguous';
}
