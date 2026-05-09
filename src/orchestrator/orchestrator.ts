/**
 * GaggleDispatch Orchestrator (Sections 8, 9, 17).
 *
 * Owns the poll loop, runtime state, dispatch decisions, multi-repo fan-out,
 * retry queue, supervised-gate polling, and reconciliation. Single authority
 * for all state mutation.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  archonApprove,
  archonReject,
} from '../executor/archon.ts';
import { spawnWorker, buildLiveSession } from './worker.ts';
import {
  availableSlots,
  buildSessionId,
  createInitialState,
  noRetryEntriesFor,
  noRunningWorkersFor,
  workerKey,
} from './state.ts';
import { blockersSatisfied, repoTargetReady } from './readiness.ts';
import { defaultGateResumeState } from '../config/service-config.ts';
import type { RegistryLoaderHandle } from '../registry/loader.ts';
import type { SyncerHandle } from '../registry/repo-syncer.ts';

const APPROVE_KEYWORDS = /^(approve|approved|yes|y|lgtm|ship it|go|continue)\b/i;
const REJECT_KEYWORDS = /^(reject|rejected|no|n|cancel|abort|stop)\b/i;

export interface OrchestratorDeps {
  cfg: ServiceConfig;
  tracker: LinearClient;
  analyzer: IssueAnalyzer;
  workspace: WorkspaceManager;
  registry: RegistryLoaderHandle;
  syncer: SyncerHandle | null;
}

export class Orchestrator {
  private state: OrchestratorState;
  private cfg: ServiceConfig;
  private tracker: LinearClient;
  private analyzer: IssueAnalyzer;
  private workspace: WorkspaceManager;
  private registry: RegistryLoaderHandle;
  private syncer: SyncerHandle | null;
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
    this.state = createInitialState(this.cfg);

    deps.registry.on(() => {
      this.invalidateAnalysisCache();
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

    await this.tracker.ensureSymphonyLabels();
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
      await this.processPendingTargets();

      const issues = await this.fetchCandidates();
      if (issues === null) {
        return; // schedule already done in catch path
      }
      const sorted = this.sortForDispatch(issues);
      for (const issue of sorted) {
        if (this.stopped) break;
        if (availableSlots(this.state) === 0) break;
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
    if (this.state.claimed.has(issue.id)) return false;
    if (issue.labels.includes(this.cfg.tracker.symphony_labels.claimed.toLowerCase())) {
      return false;
    }
    for (const key of this.state.running.keys()) {
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
      await this.tracker.applyLabel(issue.id, this.cfg.tracker.symphony_labels.claimed);
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

    for (const target of targets) {
      if (availableSlots(this.state) === 0) {
        remaining.push(target);
        continue;
      }
      if (!repoTargetReady(target, issue.id, this.state, this.cfg)) {
        remaining.push(target);
        continue;
      }

      const subIssueId = await this.maybeCreateSubIssue(issue, target, fanOutWidth);
      const targetId = subIssueId ?? issue.id;

      try {
        await this.tracker.applyLabel(targetId, this.cfg.tracker.symphony_labels.running);
      } catch (err) {
        logger.error('Failed to apply running label; skipping dispatch', {
          issue_id: issue.id,
          repo_alias: target.repo_alias,
          error: (err as Error).message,
        });
        remaining.push(target);
        continue;
      }

      const key = workerKey(issue.id, target.repo_alias);
      const log = logger.child({
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        repo_alias: target.repo_alias,
        session_id: buildSessionId(issue.identifier, target.repo_alias, null),
      });

      try {
        const repo = this.registry.getContext().repositories.find((r) => r.url === target.repo_url);
        const branch = this.cfg.repositories.find((r) => r.url === target.repo_url)?.default_branch ?? 'main';

        let placeholder = buildLiveSession({
          issue,
          repo_target: target,
          attempt: null,
          sub_issue_id: subIssueId,
          cancel: () => {},
        });
        this.state.running.set(key, placeholder);

        const handle = await spawnWorker(
          {
            cfg: this.cfg,
            workspace: this.workspace,
            issue,
            repo_target: target,
            analysis,
            attempt: null,
            source_branch: branch,
          },
          {
            onStarted: (pid) => {
              const s = this.state.running.get(key);
              if (s) {
                s.archon_pid = pid;
                s.last_archon_timestamp = new Date().toISOString();
              }
            },
            onOutput: (line) => {
              const s = this.state.running.get(key);
              if (s) {
                s.last_archon_message = line;
                s.last_archon_timestamp = new Date().toISOString();
                s.turn_count += 1;
              }
            },
            onGatePaused: (run_id, gate_message) => {
              void this.handleGatePaused(issue, target, subIssueId, run_id, gate_message, null);
            },
            onExit: (event) => {
              void this.handleWorkerExit(issue, target, event, null);
            },
          },
        );
        const sess = this.state.running.get(key);
        if (sess) sess.cancel = handle.cancel;
        log.info('Worker spawned', { workflow: target.archon_workflow, repo: repo?.name });
      } catch (err) {
        logger.error('spawnWorker failed', {
          issue_id: issue.id,
          repo_alias: target.repo_alias,
          error: (err as Error).message,
        });
        this.state.running.delete(key);
        try {
          await this.tracker.removeLabel(targetId, this.cfg.tracker.symphony_labels.running);
        } catch {
          /* ignore */
        }
        this.scheduleRetry(issue, target, 1, (err as Error).message);
      }
    }

    this.state.pending_targets.set(issue.id, remaining);
    if (remaining.length === 0) {
      this.state.pending_targets.delete(issue.id);
    } else {
      // Apply queued labels for any targets still waiting
      for (const t of remaining) {
        const subId = this.state.sibling_subissues.get(issue.id)?.get(t.repo_alias) ?? null;
        const targetId = subId ?? issue.id;
        try {
          await this.tracker.applyLabel(targetId, this.cfg.tracker.symphony_labels.queued);
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  private async maybeCreateSubIssue(
    issue: Issue,
    target: RepoTarget,
    fanOutWidth: number,
  ): Promise<string | null> {
    if (!this.cfg.tracker.create_sub_issues || fanOutWidth <= 1) return null;

    const existing = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias);
    if (existing) return existing;

    try {
      const viewerId = this.cfg.tracker.assigned_to_me ? await this.tracker.resolveViewerId() : null;
      const stateName = this.cfg.tracker.active_states[0] ?? 'In Progress';
      const sub = await this.tracker.createSubIssue({
        parent_id: issue.id,
        title: `[${target.repo_alias}] ${issue.title}`,
        assignee_id: viewerId,
        state_name: stateName,
      });

      let map = this.state.sibling_subissues.get(issue.id);
      if (!map) {
        map = new Map();
        this.state.sibling_subissues.set(issue.id, map);
      }
      map.set(target.repo_alias, sub.id);
      logger.info('Created sub-issue', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
        sub_issue_id: sub.id,
      });
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

  // ─── gate handling ───────────────────────────────────────────────────────
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

    try {
      await this.tracker.applyLabel(targetId, this.cfg.tracker.symphony_labels.waiting_human);
    } catch (err) {
      logger.warn('Failed to apply waiting-human label', { error: (err as Error).message });
    }

    let comment_id: string | null = null;
    try {
      const c = await this.tracker.postComment(
        targetId,
        `🤖 **GaggleDispatch — supervised gate**\n\n${gate_message}\n\n_Reply with **approve** or **reject**, optionally followed by your message._`,
      );
      comment_id = c.id;
    } catch (err) {
      logger.warn('Failed to post gate comment', { error: (err as Error).message });
    }

    const session = this.state.running.get(key);
    const gate: SupervisedGateEntry = {
      run_id,
      issue_id: issue.id,
      issue,
      repo_alias: target.repo_alias,
      repo_target: target,
      sub_issue_id: subIssueId,
      paused_at: Date.now(),
      gate_message,
      comment_id,
      gate_state_applied: false,
      attempt,
    };
    this.state.supervised_gates.set(key, gate);
    this.state.running.delete(key); // ← slot freed

    if (this.cfg.tracker.gate_waiting_state) {
      try {
        await this.tracker.updateIssueState(targetId, this.cfg.tracker.gate_waiting_state);
        gate.gate_state_applied = true;
      } catch (err) {
        logger.warn('Failed to apply gate_waiting_state', { error: (err as Error).message });
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

  private async pollSupervisedGates(): Promise<void> {
    for (const [key, gate] of this.state.supervised_gates) {
      const targetId = gate.sub_issue_id ?? gate.issue_id;
      // Timeout
      if (this.cfg.archon.gate_timeout_ms > 0 && Date.now() - gate.paused_at > this.cfg.archon.gate_timeout_ms) {
        await this.resolveGateStateTransition(targetId, gate);
        try {
          await this.tracker.removeLabel(targetId, this.cfg.tracker.symphony_labels.waiting_human);
        } catch {
          /* ignore */
        }
        if (gate.run_id) {
          await archonReject(this.cfg.archon.command, gate.run_id, 'Gate timeout — no human response');
        }
        this.state.supervised_gates.delete(key);
        this.scheduleRetry(gate.issue, gate.repo_target, 1, 'gate_timeout');
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

      const intent = classifyApprovalIntent(reply.body);
      if (intent === 'ambiguous') continue;

      try {
        await this.tracker.removeLabel(targetId, this.cfg.tracker.symphony_labels.waiting_human);
      } catch {
        /* ignore */
      }
      await this.resolveGateStateTransition(targetId, gate);

      if (intent === 'approve') {
        if (gate.run_id) {
          await archonApprove(this.cfg.archon.command, gate.run_id, reply.body);
        }
        // Re-establish running entry; the worker process is still alive and will resume.
        this.state.supervised_gates.delete(key);
        this.state.running.set(
          key,
          buildLiveSession({
            issue: gate.issue,
            repo_target: gate.repo_target,
            attempt: gate.attempt,
            sub_issue_id: gate.sub_issue_id,
            cancel: () => {},
          }),
        );
        try {
          await this.tracker.applyLabel(targetId, this.cfg.tracker.symphony_labels.running);
        } catch {
          /* ignore */
        }
        logger.info('Gate approved — worker resuming', { issue_id: gate.issue_id, repo_alias: gate.repo_alias });
      } else {
        // reject
        if (gate.run_id) {
          await archonReject(this.cfg.archon.command, gate.run_id, reply.body);
        }
        this.state.supervised_gates.delete(key);
        this.scheduleRetry(gate.issue, gate.repo_target, 1, 'gate_rejected');
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

    this.state.running.delete(key);

    if (event.type === 'archon_succeeded') {
      this.state.completed.add(key);
      try {
        await this.tracker.removeLabel(targetId, this.cfg.tracker.symphony_labels.running);
      } catch {
        /* ignore */
      }
      try {
        await this.tracker.updateIssueState(targetId, this.cfg.tracker.terminal_states[0] ?? 'Done');
      } catch {
        /* ignore */
      }
      // Continuation retry per Section 9.4 (1s, attempt 1) — represents the "verify" pass
      this.scheduleRetry(issue, target, 1, null, 1000);
      logger.info('Worker succeeded', {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        repo_alias: target.repo_alias,
      });
    } else {
      try {
        await this.tracker.removeLabel(targetId, this.cfg.tracker.symphony_labels.running);
      } catch {
        /* ignore */
      }
      const nextAttempt = (attempt ?? 0) + 1;
      this.scheduleRetry(issue, target, nextAttempt, event.type);
      logger.warn('Worker exited abnormally', {
        issue_id: issue.id,
        repo_alias: target.repo_alias,
        type: event.type,
        next_attempt: nextAttempt,
      });
    }

    await this.maybeReleaseClaim(issue.id);
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
        await this.tracker.removeLabel(issue_id, this.cfg.tracker.symphony_labels.claimed);
      } catch {
        /* ignore */
      }
      logger.info('Issue claim released', { issue_id });
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

    // Re-validate state from tracker; if no longer dispatchable, release.
    let refreshed: Issue | undefined;
    try {
      const fresh = await this.tracker.fetchIssueStatesByIds([issue.id]);
      refreshed = fresh[0];
    } catch {
      /* keep stale */
    }
    const current = refreshed ?? issue;

    if (this.cfg.tracker.terminal_states.includes(current.state)) {
      logger.info('Issue terminal at retry time; releasing', { issue_id: issue.id });
      await this.maybeReleaseClaim(issue.id);
      return;
    }

    if (availableSlots(this.state) === 0) {
      this.scheduleRetry(current, target, attempt, 'no slots'); // re-queue with same attempt
      return;
    }

    const analysis = this.state.analysis_cache.get(issue.id)?.analysis;
    if (!analysis) {
      logger.warn('No cached analysis at retry; will be re-analyzed on next tick', { issue_id: issue.id });
      return;
    }

    const subIssueId = this.state.sibling_subissues.get(issue.id)?.get(target.repo_alias) ?? null;
    const targetId = subIssueId ?? issue.id;

    try {
      await this.tracker.applyLabel(targetId, this.cfg.tracker.symphony_labels.running);
    } catch {
      /* ignore */
    }

    let placeholder = buildLiveSession({
      issue: current,
      repo_target: target,
      attempt,
      sub_issue_id: subIssueId,
      cancel: () => {},
    });
    this.state.running.set(key, placeholder);

    try {
      const branch = this.cfg.repositories.find((r) => r.url === target.repo_url)?.default_branch ?? 'main';
      const handle = await spawnWorker(
        {
          cfg: this.cfg,
          workspace: this.workspace,
          issue: current,
          repo_target: target,
          analysis,
          attempt,
          source_branch: branch,
        },
        {
          onStarted: (pid) => {
            const s = this.state.running.get(key);
            if (s) s.archon_pid = pid;
          },
          onOutput: (line) => {
            const s = this.state.running.get(key);
            if (s) {
              s.last_archon_message = line;
              s.last_archon_timestamp = new Date().toISOString();
            }
          },
          onGatePaused: (run_id, gate_message) => {
            void this.handleGatePaused(current, target, subIssueId, run_id, gate_message, attempt);
          },
          onExit: (event) => {
            void this.handleWorkerExit(current, target, event, attempt);
          },
        },
      );
      const sess = this.state.running.get(key);
      if (sess) sess.cancel = handle.cancel;
    } catch (err) {
      this.state.running.delete(key);
      this.scheduleRetry(current, target, attempt + 1, (err as Error).message);
    }
  }

  // ─── reconciliation ──────────────────────────────────────────────────────
  private async reconcileRunningIssues(): Promise<void> {
    // Stall detection
    const now = Date.now();
    for (const [key, session] of this.state.running) {
      const ts = session.last_archon_timestamp ? Date.parse(session.last_archon_timestamp) : Date.parse(session.started_at);
      if (this.cfg.archon.stall_timeout_ms > 0 && now - ts > this.cfg.archon.stall_timeout_ms) {
        logger.warn('Stall detected — terminating worker', {
          issue_id: session.issue.id,
          repo_alias: session.repo_alias,
        });
        try {
          session.cancel?.();
        } catch {
          /* ignore */
        }
        // The worker exit handler will fire on cancel and schedule retry.
      }
    }

    const ids = new Set<string>();
    for (const key of this.state.running.keys()) {
      const sep = key.indexOf('__');
      if (sep > 0) ids.add(key.slice(0, sep));
    }
    if (ids.size === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds([...ids]);
    } catch (err) {
      logger.debug('Reconciliation fetch failed; keep workers', { error: (err as Error).message });
      return;
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
      const claimed = await this.tracker.fetchIssuesByLabel(this.cfg.tracker.symphony_labels.claimed);
      for (const issue of claimed) {
        // Only mark as claimed if it's a parent (no parent_id)
        if (!issue.parent_id) this.state.claimed.add(issue.id);
      }

      const running = await this.tracker.fetchIssuesByLabel(this.cfg.tracker.symphony_labels.running);
      for (const issue of running) {
        // We don't have the actual Archon process; treat as crashed → retry.
        // We only have enough info if this is a sub-issue (parent_id + title prefix).
        const m = issue.title.match(/^\[([^\]]+)\]/);
        const aliasGuess = m ? m[1]! : null;
        const parentId = issue.parent_id ?? issue.id;
        if (aliasGuess) {
          let map = this.state.sibling_subissues.get(parentId);
          if (!map) {
            map = new Map();
            this.state.sibling_subissues.set(parentId, map);
          }
          map.set(aliasGuess, issue.id);
        }
        try {
          await this.tracker.removeLabel(issue.id, this.cfg.tracker.symphony_labels.running);
        } catch {
          /* ignore */
        }
        try {
          await this.tracker.applyLabel(issue.id, this.cfg.tracker.symphony_labels.queued);
        } catch {
          /* ignore */
        }
        logger.info('Recovered crashed worker — re-queued for next tick', {
          issue_identifier: issue.identifier,
          repo_alias: aliasGuess ?? '(unknown)',
        });
      }

      const waiting = await this.tracker.fetchIssuesByLabel(this.cfg.tracker.symphony_labels.waiting_human);
      for (const issue of waiting) {
        const m = issue.title.match(/^\[([^\]]+)\]/);
        const aliasGuess = m ? m[1]! : null;
        const parentId = issue.parent_id ?? issue.id;
        if (!aliasGuess) continue;
        // Reconstruct a partial supervised_gates entry; Archon process is gone but
        // when human replies we can at least clean up the labels + state.
        const key = workerKey(parentId, aliasGuess);
        this.state.supervised_gates.set(key, {
          run_id: null,
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
    } catch (err) {
      logger.warn('Label-driven recovery encountered an error', { error: (err as Error).message });
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
export function findHumanReplyAfter(
  comments: { id: string; body: string; author: { id: string | null; name: string | null }; created_at: string }[],
  pausedAt: number,
): { body: string } | null {
  const filtered = comments
    .filter((c) => Date.parse(c.created_at) > pausedAt)
    .filter((c) => c.author.name !== null && !/symphony|gaggle|bot/i.test(c.author.name ?? ''));
  if (filtered.length === 0) return null;
  return { body: filtered[filtered.length - 1]!.body };
}

export function classifyApprovalIntent(body: string): 'approve' | 'reject' | 'ambiguous' {
  const trimmed = body.trim();
  if (APPROVE_KEYWORDS.test(trimmed)) return 'approve';
  if (REJECT_KEYWORDS.test(trimmed)) return 'reject';
  return 'ambiguous';
}
