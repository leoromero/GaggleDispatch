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
  ArchonClient,
  findArchonRunForRepo,
  type ArchonRunRecord,
} from '../executor/archon-client.ts';
import { ArchonRunPoller } from '../executor/archon-poller.ts';
import { spawnWorker, buildLiveSession, type WorkerStartArgs } from './worker.ts';
import { approveAndResumeArchon } from '../executor/archon.ts';
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
import { writeRunEntry, deleteRunEntry, allRunEntries } from '../registry/run-registry.ts';
import { classifyGateReply, type GateClassification } from './gate-classifier.ts';
import {
  classifyTargetState,
  targetTransition,
  type TargetEvent,
  type TargetIdentity,
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
  archonRuns: ArchonRunRecord[];
  archonRunsById: Map<string, ArchonRunRecord>;
  persistedRunIds: ReturnType<typeof allRunEntries>;
}

export interface OrchestratorDeps {
  cfg: ServiceConfig;
  tracker: LinearClient;
  analyzer: IssueAnalyzer;
  workspace: WorkspaceManager;
  registry: RegistryLoaderHandle;
  syncer: SyncerHandle | null;
  /** Injected for testing; defaults to a real ArchonClient built from cfg. */
  archonClient?: ArchonClient;
}

export class Orchestrator {
  private state: OrchestratorState;
  private cfg: ServiceConfig;
  private tracker: LinearClient;
  private analyzer: IssueAnalyzer;
  private workspace: WorkspaceManager;
  private registry: RegistryLoaderHandle;
  private syncer: SyncerHandle | null;
  private archon: ArchonClient;
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
    this.archon = deps.archonClient ?? new ArchonClient(deps.cfg.archon.api_url);
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
      archon: this.archon,
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
          await this.dispatchSubIssueFromPoll(issue);
        } else {
          // Parent issue path: analyze then fan out.
          if (!this.shouldDispatch(issue)) continue;
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
    if (this.state.claimed.has(issue.id)) return false;
    for (const key of this.state.running.keys()) {
      if (key.startsWith(issue.id + '__')) return false;
    }
    // If any target for this issue was already completed this session, skip re-dispatch.
    for (const key of this.state.completed) {
      if (key.startsWith(issue.id + '__')) return false;
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
    if (this.state.completed.has(key)) return false;
    // Native Linear blockers must be satisfied (set via createBlockerRelation).
    if (!blockersSatisfied(issue.blocked_by, this.cfg)) return false;
    return true;
  }

  private parseAliasFromTitle(title: string): string | null {
    const m = title.match(/^\[([^\]]+)\]/);
    return m ? m[1]! : null;
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
      archon_workflow: repo.default_workflow ?? this.cfg.archon.default_workflow,
      rationale: subIssue.description ?? subIssue.title,
      components: [],
    };
  }

  /** Launch Archon for a (parentIssue, repoTarget, subIssueId) triple. Shared by drainPendingTargets, dispatchSubIssueFromPoll, and promoteQueuedSiblings.
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
    try { await this.tracker.removeLabel(targetId, 'gaggle:dispatching'); } catch { /* ignore */ }
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
    const workerArgs: WorkerStartArgs = {
      cfg: this.cfg,
      workspace: this.workspace,
      issue: parentIssue,
      repo_target: target,
      analysis: analysisOverride ?? { issue_id: parentIssue.id, analysis_summary: '', repo_targets: [target] },
      attempt,
      source_branch: branch,
      message_override: messageOverride,
    };

    try {
      const handle = await spawnWorker(workerArgs, {
        onStarted: (pid) => { const s = this.state.running.get(key); if (s) { s.archon_pid = pid; s.last_archon_timestamp = new Date().toISOString(); } },
        onOutput: (line) => { const s = this.state.running.get(key); if (s) { s.last_archon_message = line; s.last_archon_timestamp = new Date().toISOString(); s.turn_count += 1; } },
        onRunId: (db_run_id) => {
          const s = this.state.running.get(key);
          if (s) {
            s.archon_db_run_id = db_run_id;
            this.attachPoller(key, db_run_id, parentIssue, target, subIssueId, attempt);
          }
          writeRunEntry(this.cfg.registry.base_folder, key, {
            archon_run_id: db_run_id,
            parent_issue_id: parentIssue.id,
            sub_issue_id: subIssueId,
            repo_alias: target.repo_alias,
          });
          log.info('Captured Archon run id', { archon_run_id: db_run_id });
        },
        onGatePaused: (run_id, gate_message) => { void this.handleGatePaused(parentIssue, target, subIssueId, run_id, gate_message, attempt); },
        onExit: (event) => {
          deleteRunEntry(this.cfg.registry.base_folder, key);
          void this.handleWorkerExit(parentIssue, target, event, attempt);
        },
      });
      const sess = this.state.running.get(key);
      if (sess) sess.cancel = handle.cancel;
      log.info('Worker spawned', { workflow: target.archon_workflow });
    } catch (err) {
      this.state.running.delete(key);
      try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
      this.scheduleRetry(parentIssue, target, (attempt ?? 0) + 1, (err as Error).message);
    }
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

    // Claim parent if not already done.
    if (!this.state.claimed.has(parentId)) {
      this.state.claimed.add(parentId);
      this.state.pending_issues.set(parentId, parentIssue);
      try { await this.tracker.applyLabel(parentId, this.cfg.tracker.gaggle_labels.claimed); } catch { /* ignore */ }
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
    this.state.claimed.add(issue.id);
    this.state.pending_issues.set(issue.id, issue);

    if (!this.state.pending_targets.has(issue.id)) {
      this.state.pending_targets.set(issue.id, [...analysis.repo_targets]);
    }

    try {
      await this.tracker.applyLabel(issue.id, this.cfg.tracker.gaggle_labels.claimed);
    } catch (err) {
      logger.error('Failed to apply claimed label', {
        issue_id: issue.id,
        error: (err as Error).message,
      });
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
    // Targets with unsatisfied upstream dependencies or no available slot stay
    // queued (gaggle:queued label applied; remaining list keeps them for the
    // next drain). Ready targets transition queued → dispatching via the SM
    // (apply gaggle:dispatching, spawn_worker hook → launchWorker which
    // applies gaggle:running and wires the callbacks back into handleWorkerExit
    // / handleGatePaused which are themselves SM-driven).
    for (const target of targets) {
      const subIssueId = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias) ?? null;
      const targetId = subIssueId ?? issue.id;

      if (target.depends_on?.length && !repoTargetReady(target, issue.id, this.state, this.cfg)) {
        try {
          await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.queued);
        } catch { /* non-fatal */ }
        remaining.push(target);
        continue;
      }

      if (availableSlots(this.state) === 0) {
        try {
          await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.queued);
        } catch { /* non-fatal */ }
        remaining.push(target);
        continue;
      }

      const transition = targetTransition('queued', { kind: 'dispatch_attempted' }, {
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
      await this.effectApplier.applyAll(transition.effects);
      logger.info('Worker dispatched via state machine', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        repo_alias: target.repo_alias,
        workflow: target.archon_workflow,
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
      const viewerId = this.cfg.tracker.assigned_to_me ? await this.tracker.resolveViewerId() : null;
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
      if (!map) {
        map = new Map();
        this.state.sibling_subissues.set(issue.id, map);
      }
      map.set(target.repo_alias, sub.id);
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
   * Attach an ArchonRunPoller to a live session once the DB run-id is known.
   * The poller provides authoritative status updates independent of subprocess output.
   */
  private attachPoller(
    key: string,
    runId: string,
    issue: import('../domain/types.ts').Issue,
    target: import('../domain/types.ts').RepoTarget,
    subIssueId: string | null,
    attempt: number | null,
  ): void {
    const poller = new ArchonRunPoller(
      this.archon,
      runId,
      (event) => {
        const session = this.state.running.get(key);

        switch (event.type) {
          case 'poller_heartbeat':
            if (session) session.last_archon_timestamp = event.record.last_activity_at ?? new Date().toISOString();
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
            if (session) {
              logger.warn('Poller: stall detected — cancelling worker', {
                issue_id: issue.id, repo_alias: target.repo_alias, run_id: runId,
              });
              session.cancel?.();
            }
            break;

          case 'poller_run_not_found':
            logger.warn('Poller: run not found in Archon API', {
              issue_id: issue.id, repo_alias: target.repo_alias, run_id: runId,
            });
            break;
        }
      },
      {
        pollIntervalMs: this.cfg.archon.poll_interval_ms,
        stallTimeoutMs: this.cfg.archon.stall_timeout_ms,
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

    // 1. Fetch the plan from the Archon artifacts directory (file system read,
    //    not modeled by the SM). Falls back to the gate_message on any failure.
    let planContent: string | null = null;
    try {
      const runDetail = await this.archon.getRunDetail(run_id);
      const workingPath = runDetail?.run?.working_path;
      if (workingPath) {
        const parts = workingPath.replace(/\\/g, '/').split('/');
        const wtIdx = parts.indexOf('worktrees');
        if (wtIdx !== -1) {
          const workspaceBase = parts.slice(0, wtIdx).join(sep);
          const planPath = join(workspaceBase, 'artifacts', 'runs', run_id, 'investigation.md');
          if (existsSync(planPath)) {
            planContent = await Bun.file(planPath).text();
          }
        }
      }
    } catch {
      // Non-fatal — fall back to gate_message below
    }

    const commentBody = planContent
      ? `🤖 **GaggleDispatch — plan gate**\n\n${planContent}\n\n---\n\n_Reply with **approve** (optionally with notes) to start implementation, or **reject: \\<feedback\\>** to request a revised plan._`
      : `🤖 **GaggleDispatch — supervised gate**\n\n${gate_message}\n\n_Reply with **approve** or **reject**, optionally followed by your message._`;

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
    const transition = targetTransition('running', { kind: 'gate_paused', run_id, message: gate_message }, ctx);
    await this.effectApplier.applyAll(transition.effects);

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
      // Timeout → gate_timed_out (SM emits archon_reject, label swap, schedule_retry).
      if (this.cfg.archon.gate_timeout_ms > 0 && Date.now() - gate.paused_at > this.cfg.archon.gate_timeout_ms) {
        await this.resolveGateStateTransition(targetId, gate);
        const transition = targetTransition('gate_waiting', { kind: 'gate_timed_out' }, this.buildGateTransitionCtx(gate));
        await this.effectApplier.applyAll(transition.effects);
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
        const transition = targetTransition('gate_waiting',
          { kind: 'gate_create_blocker', blocker: classification.blocker! },
          this.buildGateTransitionCtx(gate));
        await this.effectApplier.applyAll(transition.effects);
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
        // Use `archon workflow approve <run_id> <comment>` which (1) stores the
        // approval with the comment as $<gate-id>.output and (2) auto-resumes the
        // workflow. The raw HTTP approveRun API only stores the approval without
        // resuming, losing the human comment for downstream nodes.
        this.state.supervised_gates.delete(key);
        const session = buildLiveSession({
          issue: gate.issue,
          repo_target: gate.repo_target,
          attempt: gate.attempt,
          sub_issue_id: gate.sub_issue_id,
          cancel: () => {},
        });
        this.state.running.set(key, session);
        try {
          await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.running);
        } catch { /* ignore */ }

        if (gate.run_id) {
          const resumeHandle = approveAndResumeArchon(
            this.cfg.archon.command,
            gate.run_id,
            classifiedMessage || undefined,
            this.cfg.archon.turn_timeout_ms,
            (e) => {
              const s = this.state.running.get(key);
              switch (e.type) {
                case 'archon_started':
                  if (s) { s.archon_pid = e.pid; s.last_archon_timestamp = new Date().toISOString(); }
                  break;
                case 'archon_output':
                  if (s) { s.last_archon_message = e.line; s.last_archon_timestamp = new Date().toISOString(); s.turn_count += 1; }
                  break;
                case 'archon_run_id':
                  if (s) {
                    s.archon_db_run_id = e.db_run_id;
                    this.attachPoller(key, e.db_run_id, gate.issue, gate.repo_target, gate.sub_issue_id, gate.attempt);
                  }
                  writeRunEntry(this.cfg.registry.base_folder, key, {
                    archon_run_id: e.db_run_id,
                    parent_issue_id: gate.issue_id,
                    sub_issue_id: gate.sub_issue_id,
                    repo_alias: gate.repo_alias,
                  });
                  break;
                case 'archon_gate_paused':
                  void this.handleGatePaused(gate.issue, gate.repo_target, gate.sub_issue_id, e.run_id, e.gate_message, gate.attempt);
                  break;
                case 'archon_succeeded':
                case 'archon_failed':
                case 'archon_timed_out':
                case 'archon_stalled':
                case 'archon_cancelled':
                  deleteRunEntry(this.cfg.registry.base_folder, key);
                  void this.handleWorkerExit(gate.issue, gate.repo_target, { type: e.type, exit_code: 'exit_code' in e ? e.exit_code : undefined }, gate.attempt);
                  break;
              }
            },
          );
          session.cancel = resumeHandle.cancel;
        }
        logger.info('Gate approved — approve+resume worker spawned', { issue_id: gate.issue_id, repo_alias: gate.repo_alias, run_id: gate.run_id });
      } else {
        // reject → gate_rejected (SM emits archon_reject, label → retrying, schedule retry).
        // resolveGateStateTransition already ran above before the approve/reject branch.
        const transition = targetTransition('gate_waiting',
          { kind: 'gate_rejected', message: classifiedMessage },
          this.buildGateTransitionCtx(gate));
        await this.effectApplier.applyAll(transition.effects);
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
   * targetTransition + EffectApplier. The supervised-gate special case (Archon
   * exited 0 but is actually paused) is handled inline before the SM call,
   * because handleGatePaused does plan-fetch + commenting work the SM doesn't
   * yet model.
   *
   * Legacy bookkeeping kept outside the SM:
   *   - session.stopPoller() and state.running.delete() — session lifecycle
   *   - state.completed.add() — used by shouldDispatch and executeRetry
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
    const dbRunId = session?.archon_db_run_id ?? null;

    // Pre-SM: detect the gate-pause-disguised-as-success case and defer to the
    // gate handler. The Archon CLI exits 0 when the workflow pauses at an
    // approval gate; we must distinguish that from a true completion.
    if (event.type === 'archon_succeeded' && dbRunId) {
      try {
        const runDetail = await this.archon.getRunDetail(dbRunId);
        const run = runDetail?.run;
        if (run?.status === 'paused') {
          logger.info('Worker exit was gate pause — treating as supervised gate', {
            issue_id: issue.id, repo_alias: target.repo_alias, archon_run_id: dbRunId,
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

    // Choose the SM event. `archon_succeeded` without a run id means the
    // process never emitted workflow_starting → treat as a failure so we retry.
    let smEvent: TargetEvent;
    if (event.type === 'archon_succeeded' && dbRunId) {
      smEvent = { kind: 'worker_succeeded' };
    } else if (event.type === 'archon_succeeded') {
      smEvent = { kind: 'worker_failed', reason: 'archon_succeeded_without_run_id' };
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
    const transition = targetTransition('running', smEvent, ctx);
    await this.effectApplier.applyAll(transition.effects);

    if (transition.to === 'succeeded') {
      this.state.completed.add(key);
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
      logger.warn('Worker exited abnormally', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
        type: event.type,
        next_attempt: (attempt ?? 0) + 1,
      });
    }

    await this.maybeReleaseClaim(issue.id);
  }

  /** Promote sibling sub-issues from gaggle:queued → gaggle:running and launch Archon. */
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
      if (this.state.running.has(key) || this.state.completed.has(key)) continue;

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
    const pending = this.state.pending_targets.get(issue_id) ?? [];
    if (
      noRunningWorkersFor(this.state, issue_id) &&
      pending.length === 0 &&
      noRetryEntriesFor(this.state, issue_id)
    ) {
      this.state.claimed.delete(issue_id);
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

    // If Archon already succeeded for this (issue, repo) pair, the sub-issue was marked Done.
    // Do not re-dispatch — release the claim and stop.
    if (this.state.completed.has(key)) {
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
    const transition = targetTransition('retrying', { kind: 'retry_due' }, {
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
    await this.effectApplier.applyAll(transition.effects);
  }

  // ─── reconciliation ──────────────────────────────────────────────────────
  private async reconcileRunningIssues(): Promise<void> {
    // Stall detection is handled per-session by ArchonRunPoller.
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
        if (this.cfg.tracker.terminal_states.includes(issue.state)) {
          for (const [key, session] of this.state.running) {
            if (session.issue.id !== issue.id) continue;
            try {
              session.cancel?.();
            } catch {
              /* ignore */
            }
            this.state.running.delete(key);
          }
          this.workspace.cleanAuxiliaryWorkspace(issue.identifier);
          this.state.analysis_cache.delete(issue.id);
          await this.maybeReleaseClaim(issue.id);
        } else if (this.cfg.tracker.active_states.includes(issue.state)) {
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

    // Poll detached Archon runs (processes found still running at startup that we
    // cannot re-attach to). Check if they have since completed, failed, or paused.
    // NOTE: this block must run even when state.running is empty (the typical post-crash case).
    if (this.state.detached_archon_runs.size > 0) {
      const freshRuns = await this.archon.listRuns();
      const freshById = new Map<string, ArchonRunRecord>(freshRuns.map((r) => [r.id, r]));

      for (const [key, det] of [...this.state.detached_archon_runs]) {
        const run = freshById.get(det.archon_run_id);
        const status = run?.status ?? 'not_found';

        if (status === 'running') continue; // still going

        this.state.detached_archon_runs.delete(key);
        this.state.running.delete(key); // free the slot

        const targetId = det.sub_issue_id ?? det.parent_issue.id;

        if (status === 'completed') {
          try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.updateIssueState(targetId, completedState(this.cfg)); } catch { /* ignore */ }
          this.state.completed.add(key);
          logger.info('Detached Archon run completed — marked Done', {
            archon_run_id: det.archon_run_id,
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
          logger.info('Detached Archon run moved to gate — restored supervised gate', {
            archon_run_id: det.archon_run_id,
            repo_alias: det.repo_alias,
          });
        } else {
          // failed or not_found — re-queue
          try { await this.tracker.removeLabel(targetId, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(targetId, this.cfg.tracker.gaggle_labels.queued); } catch { /* ignore */ }
          this.scheduleRetry(det.parent_issue, det.repo_target, 1, `detached_archon_${status}`);
          logger.warn('Detached Archon run failed or not found — re-queued', {
            archon_run_id: det.archon_run_id,
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
      await this.releaseOrphanedClaims(ctx);
      this.recoverWaitingIssues(ctx);
    } catch (err) {
      logger.warn('Label-driven recovery encountered an error', { error: (err as Error).message });
    }
  }

  private async loadRecoveryContext(): Promise<RecoveryContext> {
    const [claimedIssues, runningIssues, queuedIssues, waitingIssues, archonRuns] = await Promise.all([
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.claimed),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.running),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.queued),
      this.tracker.fetchIssuesByLabel(this.cfg.tracker.gaggle_labels.waiting_human),
      this.archon.listRuns(),
    ]);
    const persistedRunIds = allRunEntries(this.cfg.registry.base_folder);
    const archonRunsById = new Map<string, ArchonRunRecord>(archonRuns.map((r) => [r.id, r]));
    logger.info('Archon status snapshot at startup', {
      total_runs: archonRuns.length,
      persisted_run_ids: Object.keys(persistedRunIds).length,
    });
    return { claimedIssues, runningIssues, queuedIssues, waitingIssues, archonRuns, archonRunsById, persistedRunIds };
  }

  private recoverClaimedParents(ctx: RecoveryContext): void {
    for (const issue of ctx.claimedIssues) {
      // Only mark as claimed if it's a parent (no parent_id)
      if (!issue.parent_id) this.state.claimed.add(issue.id);
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

      const archonRun = this.resolveArchonRun(parentId, aliasGuess, ctx);
      const identity: TargetIdentity = {
        parent_issue_id: parentId,
        repo_alias: aliasGuess ?? '',
        target_issue_id: issue.id,
      };

      // Classify the target's state from labels + Archon status. The classifier
      // collapses the four-way (running / paused / completed / failed-or-missing)
      // Archon-status switch into a single TargetState we can dispatch on.
      const classification = classifyTargetState({
        identity,
        target_labels: new Set(['gaggle:running']),
        linear_state: issue.state ?? '',
        archon_run: archonRun,
        persisted_retry: null, // retry-registry extension pending
      });

      // Without an alias the classifier still works, but the recovery handlers
      // for `running` and `gate_waiting` need it to build the RepoTarget. Treat
      // missing-alias cases as retrying so they fall through to re-queue.
      const effectiveState = aliasGuess ? classification?.state : 'retrying';

      switch (effectiveState) {
        case 'running': {
          // Archon still alive — track as detached; reconciler will poll.
          const key = workerKey(parentId, aliasGuess!);
          const target = this.buildRepoTargetForAlias(aliasGuess!, issue);
          const parentIssue = this.state.pending_issues.get(parentId) ?? issue;
          this.state.detached_archon_runs.set(key, {
            archon_run_id: archonRun!.id,
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
          logger.info('Recovered: Archon still running — tracking as detached', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess!,
            archon_run_id: archonRun!.id,
          });
          break;
        }

        case 'gate_waiting': {
          // Archon paused at a gate — restore the supervised gate entry and
          // swap running → waiting-human so labels reflect reality.
          const key = workerKey(parentId, aliasGuess!);
          const target = this.buildRepoTargetForAlias(aliasGuess!, issue);
          const parentIssue = this.state.pending_issues.get(parentId) ?? issue;
          this.state.supervised_gates.set(key, {
            run_id: archonRun!.id,
            issue_id: parentId,
            issue: parentIssue as Issue,
            repo_alias: aliasGuess!,
            repo_target: target,
            sub_issue_id: issue.parent_id ? issue.id : null,
            paused_at: Date.now(),
            gate_message: archonRun!.metadata?.approval?.message ?? '(recovered gate)',
            comment_id: null,
            gate_state_applied: false,
            attempt: null,
          });
          try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(issue.id, this.cfg.tracker.gaggle_labels.waiting_human); } catch { /* ignore */ }
          logger.info('Recovered: Archon paused at gate — restored supervised gate', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess!,
            archon_run_id: archonRun!.id,
          });
          break;
        }

        case 'succeeded': {
          // Archon finished while we were down — mark target Done.
          try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.updateIssueState(issue.id, completedState(this.cfg)); } catch { /* ignore */ }
          this.state.completed.add(workerKey(parentId, aliasGuess!));
          logger.info('Recovered: Archon completed while down — marked Done', {
            issue_identifier: issue.identifier,
            repo_alias: aliasGuess!,
            archon_run_id: archonRun!.id,
          });
          break;
        }

        case 'retrying':
        default: {
          // Archon crashed, run not found, or alias unresolvable — re-queue.
          try { await this.tracker.removeLabel(issue.id, this.cfg.tracker.gaggle_labels.running); } catch { /* ignore */ }
          try { await this.tracker.applyLabel(issue.id, this.cfg.tracker.gaggle_labels.queued); } catch { /* ignore */ }
          logger.info('Recovered: Archon not found or crashed — re-queued', {
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

  private async releaseOrphanedClaims(ctx: RecoveryContext): Promise<void> {
    // Orphaned claimed parents: check whether all recovered siblings (if any) have already
    // completed.  Three cases:
    //   (a) Running sub whose Archon run completed → sibling_subissues IS populated but every
    //       entry is in state.completed.  Work is done → release to terminal.
    //   (b) No running/queued siblings at all but a persisted run entry shows Archon completed
    //       (crash after handleWorkerExit removed the running label but before
    //       maybeReleaseClaim) → release to terminal.
    //   (c) No siblings and no completed run → crash before the first worker was ever launched
    //       → un-claim only so the poll loop re-dispatches on the next tick.
    for (const parentId of [...this.state.claimed]) {
      const sibMap = this.state.sibling_subissues.get(parentId);
      // Skip parents that still have active siblings (running, queued, or awaiting gate).
      const allSibsCompleted =
        !sibMap || sibMap.size === 0 ||
        [...sibMap.keys()].every((alias) => this.state.completed.has(workerKey(parentId, alias)));
      if (!allSibsCompleted) continue;

      // Determine whether actual work ran for this parent.
      const workDone =
        (sibMap && sibMap.size > 0) || // at least one sibling completed during recovery
        Object.values(ctx.persistedRunIds).some(
          (e) => e.parent_issue_id === parentId && ctx.archonRunsById.get(e.archon_run_id)?.status === 'completed',
        );

      if (workDone) {
        logger.info('Orphaned claimed parent detected on startup (work completed) — releasing', { parent_id: parentId });
        await this.maybeReleaseClaim(parentId);
      } else {
        logger.info('Orphaned claimed parent detected on startup (no work started) — un-claiming for re-dispatch', { parent_id: parentId });
        this.state.claimed.delete(parentId);
        this.state.pending_issues.delete(parentId);
        try { await this.tracker.removeLabel(parentId, this.cfg.tracker.gaggle_labels.claimed); } catch { /* ignore */ }
      }
    }
  }

  private recoverWaitingIssues(ctx: RecoveryContext): void {
    // Build lookups from issue_id → repo_alias and issue_id → archon_run_id using persisted
    // run entries, so parent issues (no [alias] title prefix) can have their gates fully
    // recovered after a restart — including the run_id needed to approve/reject in Archon.
    const runAliasById = new Map<string, string>();
    const runIdById = new Map<string, string>();
    for (const entry of Object.values(ctx.persistedRunIds)) {
      runAliasById.set(entry.parent_issue_id, entry.repo_alias);
      runIdById.set(entry.parent_issue_id, entry.archon_run_id);
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
          archon_workflow: '',
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
      logger.info('Recovered supervised gate (Archon process gone)', {
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

  private resolveArchonRun(
    parentId: string,
    alias: string | null,
    ctx: RecoveryContext,
  ): ArchonRunRecord | null {
    const key = workerKey(parentId, alias ?? '');
    const persistedEntry = ctx.persistedRunIds[key];
    let run: ArchonRunRecord | null = persistedEntry
      ? (ctx.archonRunsById.get(persistedEntry.archon_run_id) ?? null)
      : null;
    if (!run && alias) {
      const repoBasename =
        this.registry.getContext().repositories.find((r) => r.name === alias)?.local_path
          .split(/[\\/]/).pop() ?? alias;
      run = findArchonRunForRepo(ctx.archonRuns, repoBasename, ['running', 'paused', 'completed']);
    }
    return run;
  }

  private buildRepoTargetForAlias(alias: string, issue: Issue): RepoTarget {
    const repoMeta = this.registry.getContext().repositories.find((r) => r.name === alias);
    return {
      repo_url: repoMeta?.url ?? '',
      repo_alias: alias,
      local_path: repoMeta?.local_path ?? '',
      archon_workflow: repoMeta?.default_workflow ?? this.cfg.archon.default_workflow,
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
