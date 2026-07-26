/**
 * EffectApplier — interprets {@link Effect}s emitted by state machine
 * transitions and performs the side effects.
 *
 * The applier is the single owner of side effects: it makes Linear API calls,
 * executor control-plane calls, run-registry writes, in-memory state mutations,
 * worker spawn/cancel via injected hooks, and retry timer scheduling. Anything
 * that mutates the world goes through here.
 *
 * Behaviour:
 *   - `applyAll` processes effects sequentially. Each effect's failure is
 *     logged and swallowed so subsequent effects still run — matching the
 *     current orchestrator's try/catch-per-op posture. The state machine
 *     accepts that labels are eventually consistent.
 *   - Effects that need machinery the applier does not own (worker spawn,
 *     timer scheduling, blocker creation) are dispatched through injected
 *     hooks so the orchestrator retains responsibility for that wiring.
 *   - `executor_approve` / `executor_reject` resolve their run_id from the live
 *     `supervised_gates` entry keyed by identity, then delete that entry —
 *     coupling the executor call with the in-memory cleanup so callers don't
 *     have to chase both.
 */

import type { Issue, OrchestratorState, RepoTarget, ServiceConfig } from '../domain/types.ts';
import type { LinearClient } from '../tracker/linear.ts';
import type { ExecutorClient } from '../executor/client.ts';
import type { WorkspaceManager } from '../workspace/workspace-manager.ts';
import { writeRunEntry, deleteRunEntry, writeRetryEntry, deleteRetryEntry } from '../registry/run-registry.ts';
import { workerKey as makeWorkerKey } from './state.ts';
import { logger } from '../util/logger.ts';
import type { BlockerSpec, Effect, TargetIdentity, WorkerKey } from './state-machine.ts';

// ─── hooks the orchestrator owns ───────────────────────────────────────────

export interface SpawnWorkerHook {
  (args: {
    identity: TargetIdentity;
    target: RepoTarget;
    attempt: number;
    messageOverride?: string;
  }): Promise<void>;
}

export interface CancelWorkerHook {
  (key: WorkerKey): void;
}

export interface ScheduleRetryHook {
  (key: WorkerKey, delayMs: number, attempt: number): void;
}

export interface CreateBlockerHook {
  (spec: BlockerSpec, blocksIssueId: string): Promise<void>;
}

export interface CreateSubIssueHook {
  (parentId: string, target: RepoTarget): Promise<void>;
}

export interface ApproveAndResumeHook {
  (args: {
    identity: TargetIdentity;
    runId: string;
    message: string | null;
    attempt: number | null;
  }): Promise<void>;
}

// ─── applier deps ──────────────────────────────────────────────────────────

export interface EffectApplierDeps {
  cfg: ServiceConfig;
  tracker: LinearClient;
  executorClient: ExecutorClient;
  workspace: WorkspaceManager;
  state: OrchestratorState;
  /** Used by persist_run / delete_run; gaggle-runs.json lives here. */
  registryBaseFolder: string;

  spawnWorker: SpawnWorkerHook;
  cancelWorker: CancelWorkerHook;
  scheduleRetry: ScheduleRetryHook;
  createBlocker: CreateBlockerHook;
  createSubIssue: CreateSubIssueHook;
  approveAndResume: ApproveAndResumeHook;
}

export class EffectApplier {
  constructor(private readonly deps: EffectApplierDeps) {}

  async applyAll(effects: readonly Effect[]): Promise<void> {
    for (const effect of effects) {
      await this.apply(effect);
    }
  }

  async apply(effect: Effect): Promise<void> {
    try {
      await this.dispatch(effect);
    } catch (err) {
      logger.warn('Effect failed', {
        effect_kind: effect.kind,
        error: (err as Error).message,
      });
    }
  }

  private async dispatch(effect: Effect): Promise<void> {
    switch (effect.kind) {
      // ─── Linear ────────────────────────────────────────────────────────
      case 'apply_label':
        await this.deps.tracker.applyLabel(
          effect.issue_id,
          this.deps.cfg.tracker.gaggle_labels[effect.label],
        );
        return;
      case 'remove_label':
        await this.deps.tracker.removeLabel(
          effect.issue_id,
          this.deps.cfg.tracker.gaggle_labels[effect.label],
        );
        return;
      case 'set_linear_state':
        await this.deps.tracker.updateIssueState(effect.issue_id, effect.state);
        return;
      case 'post_comment':
        await this.deps.tracker.postComment(effect.issue_id, effect.body);
        return;
      case 'create_sub_issue':
        await this.deps.createSubIssue(effect.parent_id, effect.target);
        return;
      case 'create_blocker_issue':
        await this.deps.createBlocker(effect.spec, effect.blocks_issue_id);
        return;
      case 'create_blocker_relation':
        await this.deps.tracker.createBlockerRelation(effect.blocker_id, effect.blocked_id);
        return;

      // ─── Worker lifecycle ──────────────────────────────────────────────
      case 'spawn_worker':
        await this.deps.spawnWorker({
          identity: effect.identity,
          target: effect.target,
          attempt: effect.attempt,
          messageOverride: effect.message_override,
        });
        return;
      case 'cancel_worker':
        this.deps.cancelWorker(effect.key);
        return;
      case 'cleanup_workspace':
        this.deps.workspace.cleanAuxiliaryWorkspace(effect.issue_identifier);
        return;

      // ─── executor control plane (resolves run_id from gate, cleans up) ───
      case 'executor_approve': {
        const key = makeWorkerKey(effect.identity.parent_issue_id, effect.identity.repo_alias);
        const gate = this.deps.state.supervised_gates.get(key);
        if (gate?.run_id) {
          await this.deps.executorClient.approveRun(gate.run_id, effect.message ?? undefined);
        }
        this.deps.state.supervised_gates.delete(key);
        return;
      }
      case 'executor_reject': {
        const key = makeWorkerKey(effect.identity.parent_issue_id, effect.identity.repo_alias);
        const gate = this.deps.state.supervised_gates.get(key);
        if (gate?.run_id) {
          await this.deps.executorClient.rejectRun(gate.run_id, effect.reason);
        }
        this.deps.state.supervised_gates.delete(key);
        return;
      }
      case 'executor_approve_and_resume': {
        const key = makeWorkerKey(effect.identity.parent_issue_id, effect.identity.repo_alias);
        const gate = this.deps.state.supervised_gates.get(key);
        if (gate?.run_id) {
          await this.deps.approveAndResume({
            identity: effect.identity,
            runId: gate.run_id,
            message: effect.message,
            attempt: effect.attempt,
          });
        }
        this.deps.state.supervised_gates.delete(key);
        return;
      }

      // ─── Persistence ───────────────────────────────────────────────────
      case 'persist_run':
        writeRunEntry(this.deps.registryBaseFolder, effect.key, {
          run_id: effect.run_id,
          parent_issue_id: effect.meta.parent_issue_id,
          sub_issue_id: effect.meta.sub_issue_id,
          repo_alias: effect.meta.repo_alias,
        });
        return;
      case 'delete_run':
        deleteRunEntry(this.deps.registryBaseFolder, effect.key);
        return;
      case 'persist_retry': {
        // Resolve sub_issue_id / repo_alias from the WorkerKey + in-memory
        // sibling map so the retry entry is self-describing and recovery can
        // schedule the next retry without consulting other state.
        const sep = effect.key.indexOf('__');
        if (sep < 0) {
          logger.warn('persist_retry: malformed WorkerKey', { key: effect.key });
          return;
        }
        const parent_issue_id = effect.key.slice(0, sep);
        const repo_alias = effect.key.slice(sep + 2);
        const sub_issue_id =
          this.deps.state.sibling_subissues.get(parent_issue_id)?.get(repo_alias) ?? null;
        writeRetryEntry(this.deps.registryBaseFolder, effect.key, {
          parent_issue_id,
          sub_issue_id,
          repo_alias,
          attempt: effect.meta.attempt,
          due_at_ms: effect.meta.due_at_ms,
          reason: effect.meta.reason,
        });
        return;
      }
      case 'delete_retry':
        deleteRetryEntry(this.deps.registryBaseFolder, effect.key);
        return;

      // ─── Timers ────────────────────────────────────────────────────────
      case 'schedule_retry_timer':
        this.deps.scheduleRetry(effect.key, effect.delay_ms, effect.attempt);
        return;

      // ─── In-memory state ───────────────────────────────────────────────
      case 'register_detached_run':
        // Caller populates detached_runs directly during recovery
        // classification; this effect is informational. Logging only.
        logger.info('register_detached_run', {
          parent_issue_id: effect.identity.parent_issue_id,
          repo_alias: effect.identity.repo_alias,
          run_id: effect.run_id,
        });
        return;
      case 'register_supervised_gate': {
        const key = makeWorkerKey(effect.identity.parent_issue_id, effect.identity.repo_alias);
        // The parent Issue snapshot is populated lazily; the orchestrator
        // refreshes it via the state.pending_issues map when present.
        const parentIssue = this.deps.state.pending_issues.get(effect.identity.parent_issue_id) ?? ({} as Issue);
        this.deps.state.supervised_gates.set(key, {
          run_id: effect.run_id,
          issue_id: effect.identity.parent_issue_id,
          issue: parentIssue,
          repo_alias: effect.identity.repo_alias,
          repo_target: effect.target,
          sub_issue_id:
            effect.identity.target_issue_id === effect.identity.parent_issue_id
              ? null
              : effect.identity.target_issue_id,
          paused_at: Date.now(),
          gate_message: effect.message,
          comment_id: null,
          gate_state_applied: false,
          attempt: effect.attempt,
        });
        return;
      }
      case 'release_parent_claim':
        // Note: this effect is emitted by the parent SM AFTER it has already
        // transitioned to done/cancelled (so parent_machine_states already
        // reflects the new state). It still clears pending_issues, which is
        // orchestrator-owned bookkeeping not modeled by the SM.
        this.deps.state.pending_issues.delete(effect.parent_id);
        return;
      case 'invalidate_analysis_cache':
        this.deps.state.analysis_cache.delete(effect.issue_id);
        return;

      // ─── Diagnostics ───────────────────────────────────────────────────
      case 'log':
        logger[effect.level](effect.message, effect.fields);
        return;

      default: {
        // Exhaustiveness check — TypeScript will error if a new Effect kind
        // is added without a case above.
        const _exhaustive: never = effect;
        logger.warn('Unhandled effect kind', { effect: _exhaustive });
        return;
      }
    }
  }
}
