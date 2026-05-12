/**
 * Orchestrator state machine — type surface only.
 *
 * Two parallel state machines coordinate the orchestrator's lifecycle:
 *
 *   - Parent state machine: one per parent issue. Tracks the lifecycle of the
 *     parent claim through analyze → dispatch → all-targets-terminal.
 *
 *   - Target state machine: one per (parent_issue_id, repo_alias) tuple.
 *     Tracks the lifecycle of a single repo's work through queued → running
 *     → succeeded/failed.
 *
 * Mono-repo case: when an issue fans out to a single repo, no sub-issue is
 * created. The target's issue IS the parent issue (target_issue_id ===
 * parent_issue_id). The parent issue then carries labels from BOTH state
 * machines simultaneously — they are independent dimensions stacked on the
 * same Linear issue. Multi-repo: parent carries only parent-level labels,
 * each sub-issue carries one target-level label.
 *
 * Linear labels are the PROJECTION of state machine state, not the source of
 * truth. The state machine is authoritative; the EffectApplier reconciles
 * labels eventually. Recovery on startup reads labels + Archon status +
 * persisted run/retry entries and classifies each parent and target into its
 * current state.
 *
 * Transitions are pure functions: (state, event, context) → { to, effects }.
 * Side effects are returned as data and interpreted by the EffectApplier.
 * Invalid transitions throw — the type system + tests enforce the matrix.
 */

import type { Issue, RepoTarget, ServiceConfig } from '../domain/types.ts';
import type { ArchonRunRecord } from '../executor/archon-client.ts';
import { completedState } from '../config/service-config.ts';

// ─── Identity ──────────────────────────────────────────────────────────────

/**
 * A target is a (parent issue, repo alias) tuple. The `target_issue_id` is the
 * Linear issue that carries target-level labels: a sub-issue id for multi-repo
 * tasks, or the parent issue id for mono-repo tasks. The orchestrator never
 * branches on multi- vs mono-repo elsewhere — it just operates on
 * target_issue_id.
 */
export interface TargetIdentity {
  parent_issue_id: string;
  repo_alias: string;
  target_issue_id: string;
}

/** Worker key as used by the orchestrator state map: `${parent_id}__${alias}`. */
export type WorkerKey = string;

// ─── Labels ────────────────────────────────────────────────────────────────

/**
 * Semantic label kinds emitted by the state machine. The EffectApplier
 * translates these to actual Linear label strings via
 * `cfg.tracker.gaggle_labels[kind]`, so users can customize label names
 * without the SM caring. The classifier also accepts kind-keyed sets — the
 * orchestrator translates Linear label strings to kinds before classification.
 */
export type ParentLabelKind = 'analyzing' | 'claimed';
export type TargetLabelKind = 'queued' | 'dispatching' | 'running' | 'waiting_human' | 'retrying';
export type LabelKind = ParentLabelKind | TargetLabelKind;

// ─── Parent state machine ──────────────────────────────────────────────────

/**
 * unclaimed   Entered: initial state for any issue not yet observed.
 *             Exited:  analysis_started → analyzing.
 *             Labels:  none.
 *
 * analyzing   Entered: orchestrator selected this issue for analysis.
 *             Exited:  analysis_succeeded → claimed; analysis_failed → unclaimed.
 *             Labels:  `gaggle:analyzing`.
 *
 * claimed     Entered: analysis returned ≥1 target; sub-issues created or
 *                      mono-repo target enqueued.
 *             Exited:  target_terminal (when all targets terminal) → done|cancelled;
 *                      parent_externally_terminal → cancelled.
 *             Labels:  `gaggle:claimed`.
 *
 * done        Terminal. All targets succeeded. Linear state moved to terminal.
 *             No labels.
 *
 * cancelled   Terminal. ≥1 target failed/cancelled, or parent moved to terminal
 *             externally. No labels.
 */
export type ParentState =
  | 'unclaimed'
  | 'analyzing'
  | 'claimed'
  | 'done'
  | 'cancelled';

export type ParentEvent =
  | { kind: 'analysis_started' }
  | { kind: 'analysis_succeeded'; targets: RepoTarget[] }
  | { kind: 'analysis_failed'; error: string }
  | { kind: 'target_terminal'; alias: string; outcome: 'succeeded' | 'failed' }
  | { kind: 'parent_externally_terminal' };

// ─── Target state machine ──────────────────────────────────────────────────

/**
 * queued        Entered: target enqueued by parent (analysis_succeeded fan-out)
 *                        with unsatisfied upstream blocker or no available slot.
 *               Exited:  upstream_unblocked OR slot freed → dispatching.
 *               Labels:  `gaggle:queued`.
 *
 * dispatching   Entered: orchestrator picked this target for dispatch; about to
 *                        spawn the worker subprocess.
 *               Exited:  worker_started → running; worker_failed → retrying.
 *               Labels:  `gaggle:dispatching`. Sub-second window; the label
 *               exists so a crash here is recoverable.
 *
 * running       Entered: Archon subprocess spawned (or detached run discovered
 *                        at startup). Archon DB run id may not be captured yet.
 *               Exited:  worker_succeeded → succeeded; worker_failed → retrying;
 *                        gate_paused → gate_waiting.
 *               Labels:  `gaggle:running`.
 *
 * gate_waiting  Entered: Archon paused at a supervised approval gate.
 *               Exited:  gate_approved → running; gate_rejected/timed_out →
 *                        retrying; gate_create_blocker → queued (with a Linear
 *                        blocker relation created against a new blocker issue).
 *               Labels:  `gaggle:waiting-human`. Linear state may also move to
 *               `cfg.tracker.gate_waiting_state` if configured.
 *
 * retrying      Entered: worker failed or gate rejected, attempt < max.
 *                        Retry timer scheduled, attempt count persisted.
 *               Exited:  retry_due → dispatching; (on retries_exhausted from the
 *                        transition fn itself, transition resolves to `failed`).
 *               Labels:  `gaggle:retrying`.
 *
 * succeeded     Terminal. Archon completed; target_issue_id moved to Linear
 *               terminal state. No labels. Emits `target_terminal` to parent.
 *
 * failed        Terminal. Retries exhausted, or parent went terminal externally.
 *               target_issue_id moved to Linear Cancelled. No labels. Emits
 *               `target_terminal` to parent.
 */
export type TargetState =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'gate_waiting'
  | 'retrying'
  | 'succeeded'
  | 'failed';

export interface BlockerSpec {
  title: string;
  description: string;
}

export type TargetEvent =
  | { kind: 'dispatch_attempted' }
  | { kind: 'worker_started'; pid: number }
  | { kind: 'worker_emitted_run_id'; run_id: string }
  | { kind: 'worker_succeeded' }
  | { kind: 'worker_failed'; reason: string }
  | { kind: 'gate_paused'; run_id: string; message: string }
  | { kind: 'gate_approved'; message: string | null }
  | { kind: 'gate_rejected'; message: string }
  | { kind: 'gate_create_blocker'; blocker: BlockerSpec }
  | { kind: 'gate_timed_out' }
  | { kind: 'retry_due' }
  | { kind: 'upstream_unblocked' }
  | { kind: 'parent_terminal' };

// ─── Effects ───────────────────────────────────────────────────────────────

/** Metadata persisted alongside an Archon run id (extends current RunEntry). */
export interface RunMeta {
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
}

/** Metadata persisted alongside a retry timer; survives orchestrator crashes
 *  so attempt counts and last error are preserved. New file/registry. */
export interface RetryMeta {
  attempt: number;
  due_at_ms: number;
  reason: string | null;
}

/**
 * Side effects emitted by transition functions. The EffectApplier interprets
 * these into Linear API calls, Archon API calls, subprocess management, and
 * in-memory state mutations. Describing effects as data keeps transitions
 * pure, makes them trivially unit-testable, and allows the applier to retry
 * idempotent ops without rewinding state.
 */
export type Effect =
  // Linear label & state
  | { kind: 'apply_label'; issue_id: string; label: LabelKind }
  | { kind: 'remove_label'; issue_id: string; label: LabelKind }
  | { kind: 'set_linear_state'; issue_id: string; state: string }
  | { kind: 'post_comment'; issue_id: string; body: string }
  | { kind: 'create_sub_issue'; parent_id: string; target: RepoTarget }
  | { kind: 'create_blocker_issue'; spec: BlockerSpec; blocks_issue_id: string }
  | { kind: 'create_blocker_relation'; blocker_id: string; blocked_id: string }

  // Worker lifecycle
  | { kind: 'spawn_worker'; identity: TargetIdentity; target: RepoTarget; attempt: number; message_override?: string }
  | { kind: 'cancel_worker'; key: WorkerKey }
  | { kind: 'cleanup_workspace'; issue_identifier: string }

  // Archon control plane. The applier resolves the run_id from the live
  // supervised_gates entry keyed by identity, and removes that gate entry as
  // an atomic part of the operation. This couples the Archon call with the
  // in-memory gate cleanup, matching the current orchestrator's semantics.
  | { kind: 'archon_approve'; identity: TargetIdentity; message: string | null }
  | { kind: 'archon_reject'; identity: TargetIdentity; reason: string }
  // archon_approve_and_resume is distinct from archon_approve: rather than
  // just storing the approval via the HTTP API, it spawns the
  // `archon workflow approve <run_id> <comment>` subprocess which records
  // the comment as the gate's output AND resumes the workflow. The applier
  // delegates to the approveAndResume hook (orchestrator-owned), which sets
  // up callbacks that thread back into handleWorkerExit / handleGatePaused.
  | { kind: 'archon_approve_and_resume'; identity: TargetIdentity; message: string | null; attempt: number | null }

  // Persistence (run-registry, extended to hold retry meta as well)
  | { kind: 'persist_run'; key: WorkerKey; run_id: string; meta: RunMeta }
  | { kind: 'delete_run'; key: WorkerKey }
  | { kind: 'persist_retry'; key: WorkerKey; meta: RetryMeta }
  | { kind: 'delete_retry'; key: WorkerKey }

  // Timer. `attempt` is included so the orchestrator's scheduleRetry hook can
  // reconstruct the call without consulting in-memory state.
  | { kind: 'schedule_retry_timer'; key: WorkerKey; delay_ms: number; attempt: number }

  // In-memory state (live sessions, detached runs, gates, completed set)
  | { kind: 'register_detached_run'; identity: TargetIdentity; target: RepoTarget; run_id: string }
  | { kind: 'register_supervised_gate'; identity: TargetIdentity; target: RepoTarget; run_id: string; message: string; attempt: number | null }
  | { kind: 'release_parent_claim'; parent_id: string }
  | { kind: 'invalidate_analysis_cache'; issue_id: string }

  // Diagnostics
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; fields: Record<string, unknown> };

// ─── Transitions ───────────────────────────────────────────────────────────

export interface ParentTransition {
  from: ParentState;
  to: ParentState;
  effects: Effect[];
}

export interface TargetTransition {
  from: TargetState;
  to: TargetState;
  effects: Effect[];
}

/**
 * Read-only context the parent transition function may consult. Transitions
 * never mutate ctx; the EffectApplier owns all state mutation via effects.
 */
export interface ParentTransitionContext {
  cfg: ServiceConfig;
  parent_issue: Issue;
  /** Every target for this parent and its current state. The parent uses this
   *  to detect when all targets are terminal. */
  targets: ReadonlyMap<string /* alias */, TargetState>;
}

/** Read-only context the target transition function may consult. */
export interface TargetTransitionContext {
  cfg: ServiceConfig;
  identity: TargetIdentity;
  parent_issue: Issue;
  /** The repo target this state machine operates on. */
  target: RepoTarget;
  /** Sibling target states for this parent. Used for upstream blocker checks. */
  siblings: ReadonlyMap<string /* alias */, TargetState>;
  /** Current attempt count: 0 = first run, ≥1 = retry attempt. */
  attempt: number;
}

/** Pure function. Throws {@link InvalidTransitionError} for disallowed pairs. */
export type ParentTransitionFn = (
  state: ParentState,
  event: ParentEvent,
  ctx: ParentTransitionContext,
) => ParentTransition;

export type TargetTransitionFn = (
  state: TargetState,
  event: TargetEvent,
  ctx: TargetTransitionContext,
) => TargetTransition;

// ─── Recovery classifier ───────────────────────────────────────────────────

/**
 * Inputs the parent classifier reads to determine ParentState at startup.
 * The classifier does NOT inspect target labels — those go through the target
 * classifier independently. Parent and target classification compose at the
 * coordinator level.
 */
export interface ParentRecoveryInputs {
  parent_id: string;
  parent_labels: Set<ParentLabelKind>;
  linear_state: string;
}

export interface ParentClassification {
  parent_id: string;
  state: ParentState;
}

/**
 * Inputs the target classifier reads to determine TargetState at startup.
 *
 *  - archon_run: matched via persisted run-registry entry first, falling back
 *    to a heuristic search of recent Archon runs by repo basename.
 *  - persisted_retry: pulled from the retry-registry (new), null if absent.
 */
export interface TargetRecoveryInputs {
  identity: TargetIdentity;
  target_labels: Set<TargetLabelKind>;
  linear_state: string;
  archon_run: ArchonRunRecord | null;
  persisted_retry: RetryMeta | null;
}

export interface TargetClassification {
  identity: TargetIdentity;
  state: TargetState;
  /** Archon run id to thread into subsequent state (gate entries, detached runs). */
  run_id: string | null;
  /** Recovered attempt count: 0 = first run, ≥1 = retry attempt. */
  attempt: number;
}

export type ParentClassifierFn = (inp: ParentRecoveryInputs) => ParentClassification;

/**
 * Target classifier returns null when no target-level labels are present on
 * the issue. That signals "this issue is not currently a target of any state
 * machine" — the coordinator should not create a target SM for it. Every
 * non-null path is keyed by exactly one observed target label.
 */
export type TargetClassifierFn = (inp: TargetRecoveryInputs) => TargetClassification | null;

// ─── Errors ────────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ParentState | TargetState,
    public readonly event_kind: string,
    public readonly machine: 'parent' | 'target',
  ) {
    super(`Invalid ${machine} transition: '${event_kind}' from state '${from}'`);
    this.name = 'InvalidTransitionError';
  }
}

// ─── Parent transition function ────────────────────────────────────────────

/**
 * Pure transition function for the parent state machine. All side effects are
 * returned as data; the EffectApplier interprets them.
 */
export const parentTransition: ParentTransitionFn = (state, event, ctx) => {
  const parentId = ctx.parent_issue.id;

  if (state === 'unclaimed') {
    if (event.kind === 'analysis_started') {
      return {
        from: 'unclaimed', to: 'analyzing',
        effects: [{ kind: 'apply_label', issue_id: parentId, label: 'analyzing' }],
      };
    }
    // Cached-analysis dispatches skip 'analyzing' entirely and go straight to
    // claimed when the orchestrator picks up the issue. Allow analysis_succeeded
    // from unclaimed; effects differ from the analyzing→claimed path (no
    // gaggle:analyzing label to remove).
    if (event.kind === 'analysis_succeeded') {
      return {
        from: 'unclaimed', to: 'claimed',
        effects: [{ kind: 'apply_label', issue_id: parentId, label: 'claimed' }],
      };
    }
    throw new InvalidTransitionError(state, event.kind, 'parent');
  }

  if (state === 'analyzing') {
    if (event.kind === 'analysis_succeeded') {
      return {
        from: 'analyzing', to: 'claimed',
        effects: [
          { kind: 'remove_label', issue_id: parentId, label: 'analyzing' },
          { kind: 'apply_label', issue_id: parentId, label: 'claimed' },
        ],
      };
    }
    if (event.kind === 'analysis_failed') {
      return {
        from: 'analyzing', to: 'unclaimed',
        effects: [
          { kind: 'remove_label', issue_id: parentId, label: 'analyzing' },
          { kind: 'log', level: 'warn', message: 'Analysis failed', fields: { issue_id: parentId, error: event.error } },
        ],
      };
    }
    if (event.kind === 'parent_externally_terminal') {
      return {
        from: 'analyzing', to: 'cancelled',
        effects: [
          { kind: 'remove_label', issue_id: parentId, label: 'analyzing' },
          { kind: 'invalidate_analysis_cache', issue_id: parentId },
        ],
      };
    }
    throw new InvalidTransitionError(state, event.kind, 'parent');
  }

  if (state === 'claimed') {
    if (event.kind === 'target_terminal') {
      const allTerminal = [...ctx.targets.values()].every((s) => s === 'succeeded' || s === 'failed');
      if (!allTerminal) {
        return { from: 'claimed', to: 'claimed', effects: [] };
      }
      const anyFailed = [...ctx.targets.values()].some((s) => s === 'failed');
      const to: ParentState = anyFailed ? 'cancelled' : 'done';
      const linearState = anyFailed
        ? (ctx.cfg.tracker.terminal_states.find((s) => s.toLowerCase() === 'cancelled') ?? completedState(ctx.cfg))
        : completedState(ctx.cfg);
      return {
        from: 'claimed', to,
        effects: [
          { kind: 'remove_label', issue_id: parentId, label: 'claimed' },
          { kind: 'set_linear_state', issue_id: parentId, state: linearState },
          { kind: 'release_parent_claim', parent_id: parentId },
          { kind: 'invalidate_analysis_cache', issue_id: parentId },
        ],
      };
    }
    if (event.kind === 'parent_externally_terminal') {
      return {
        from: 'claimed', to: 'cancelled',
        effects: [
          { kind: 'remove_label', issue_id: parentId, label: 'claimed' },
          { kind: 'cleanup_workspace', issue_identifier: ctx.parent_issue.identifier },
          { kind: 'invalidate_analysis_cache', issue_id: parentId },
        ],
      };
    }
    throw new InvalidTransitionError(state, event.kind, 'parent');
  }

  // done | cancelled — terminal, no transitions out.
  throw new InvalidTransitionError(state, event.kind, 'parent');
};

// ─── Target transition function ────────────────────────────────────────────

/** Max retry attempts before giving up. Matches the existing orchestrator constant. */
const MAX_RETRY_ATTEMPTS = 10;

function workerKeyOf(id: TargetIdentity): WorkerKey {
  return `${id.parent_issue_id}__${id.repo_alias}`;
}

/**
 * Pure transition function for the target state machine.
 *
 * Notes:
 *   - The dispatch-readiness check (slot available, blockers satisfied) is the
 *     coordinator's responsibility; the SM trusts dispatch_attempted /
 *     upstream_unblocked to mean "ready to go."
 *   - `worker_failed` chooses between retrying and failed based on ctx.attempt.
 *   - `parent_terminal` is accepted from any non-terminal state.
 */
export const targetTransition: TargetTransitionFn = (state, event, ctx) => {
  const tid = ctx.identity.target_issue_id;
  const key = workerKeyOf(ctx.identity);

  // ─── parent_terminal is accepted from every non-terminal state ──────────
  if (event.kind === 'parent_terminal') {
    if (state === 'succeeded' || state === 'failed') {
      throw new InvalidTransitionError(state, event.kind, 'target');
    }
    const effects: Effect[] = [];
    // Remove whatever target-level label this state owns.
    const labelForState: Partial<Record<TargetState, TargetLabelKind>> = {
      queued: 'queued',
      dispatching: 'dispatching',
      running: 'running',
      gate_waiting: 'waiting_human',
      retrying: 'retrying',
    };
    const label = labelForState[state];
    if (label) effects.push({ kind: 'remove_label', issue_id: tid, label });
    if (state === 'running' || state === 'dispatching') {
      effects.push({ kind: 'cancel_worker', key });
    }
    effects.push({ kind: 'delete_run', key });
    effects.push({ kind: 'delete_retry', key });
    return { from: state, to: 'failed', effects };
  }

  if (state === 'queued') {
    if (event.kind === 'dispatch_attempted' || event.kind === 'upstream_unblocked') {
      return {
        from: 'queued', to: 'dispatching',
        effects: [
          { kind: 'remove_label', issue_id: tid, label: 'queued' },
          { kind: 'apply_label', issue_id: tid, label: 'dispatching' },
          { kind: 'spawn_worker', identity: ctx.identity, target: ctx.target, attempt: ctx.attempt },
        ],
      };
    }
    throw new InvalidTransitionError(state, event.kind, 'target');
  }

  if (state === 'dispatching') {
    if (event.kind === 'worker_started') {
      return {
        from: 'dispatching', to: 'running',
        effects: [
          { kind: 'remove_label', issue_id: tid, label: 'dispatching' },
          { kind: 'apply_label', issue_id: tid, label: 'running' },
        ],
      };
    }
    if (event.kind === 'worker_failed') {
      return retryOrFail(state, ctx, key, tid, 'dispatching', event.reason);
    }
    throw new InvalidTransitionError(state, event.kind, 'target');
  }

  if (state === 'running') {
    if (event.kind === 'worker_emitted_run_id') {
      return {
        from: 'running', to: 'running',
        effects: [{
          kind: 'persist_run', key, run_id: event.run_id,
          meta: {
            parent_issue_id: ctx.identity.parent_issue_id,
            sub_issue_id: ctx.identity.target_issue_id === ctx.identity.parent_issue_id ? null : ctx.identity.target_issue_id,
            repo_alias: ctx.identity.repo_alias,
          },
        }],
      };
    }
    if (event.kind === 'worker_succeeded') {
      return {
        from: 'running', to: 'succeeded',
        effects: [
          { kind: 'remove_label', issue_id: tid, label: 'running' },
          { kind: 'set_linear_state', issue_id: tid, state: completedState(ctx.cfg) },
          { kind: 'delete_run', key },
          { kind: 'delete_retry', key },
        ],
      };
    }
    if (event.kind === 'worker_failed') {
      return retryOrFail(state, ctx, key, tid, 'running', event.reason);
    }
    if (event.kind === 'gate_paused') {
      const effects: Effect[] = [
        { kind: 'remove_label', issue_id: tid, label: 'running' },
        { kind: 'apply_label', issue_id: tid, label: 'waiting_human' },
        { kind: 'register_supervised_gate', identity: ctx.identity, target: ctx.target, run_id: event.run_id, message: event.message, attempt: ctx.attempt },
      ];
      if (ctx.cfg.tracker.gate_waiting_state) {
        effects.push({ kind: 'set_linear_state', issue_id: tid, state: ctx.cfg.tracker.gate_waiting_state });
      }
      return { from: 'running', to: 'gate_waiting', effects };
    }
    throw new InvalidTransitionError(state, event.kind, 'target');
  }

  if (state === 'gate_waiting') {
    if (event.kind === 'gate_approved') {
      return {
        from: 'gate_waiting', to: 'running',
        effects: [
          { kind: 'remove_label', issue_id: tid, label: 'waiting_human' },
          { kind: 'apply_label', issue_id: tid, label: 'running' },
          // approve_and_resume spawns the subprocess that approves + resumes
          // the workflow; the HTTP-only `archon_approve` would store the
          // approval but not restart the workflow.
          { kind: 'archon_approve_and_resume', identity: ctx.identity, message: event.message, attempt: ctx.attempt },
        ],
      };
    }
    if (event.kind === 'gate_rejected') {
      return retryOrFail('gate_waiting', ctx, key, tid, 'waiting_human', `gate_rejected: ${event.message}`, [
        { kind: 'archon_reject', identity: ctx.identity, reason: event.message },
      ]);
    }
    if (event.kind === 'gate_timed_out') {
      return retryOrFail('gate_waiting', ctx, key, tid, 'waiting_human', 'gate_timeout', [
        { kind: 'archon_reject', identity: ctx.identity, reason: 'Gate timeout — no human response' },
      ]);
    }
    if (event.kind === 'gate_create_blocker') {
      // Blocker created in Linear; this target parks in queued until the
      // blocker resolves. Linear's blocker relation gates re-dispatch.
      return {
        from: 'gate_waiting', to: 'queued',
        effects: [
          { kind: 'remove_label', issue_id: tid, label: 'waiting_human' },
          { kind: 'apply_label', issue_id: tid, label: 'queued' },
          { kind: 'create_blocker_issue', spec: event.blocker, blocks_issue_id: tid },
          { kind: 'archon_reject', identity: ctx.identity, reason: `Blocker created: ${event.blocker.title}` },
          { kind: 'post_comment', issue_id: ctx.identity.parent_issue_id,
            body: `🔗 **Blocker created**: ${event.blocker.title}\n\nImplementation is paused until this issue is resolved. GaggleDispatch will restart automatically once the blocker reaches a satisfied state.` },
          { kind: 'delete_run', key },
        ],
      };
    }
    throw new InvalidTransitionError(state, event.kind, 'target');
  }

  if (state === 'retrying') {
    if (event.kind === 'retry_due') {
      return {
        from: 'retrying', to: 'dispatching',
        effects: [
          { kind: 'remove_label', issue_id: tid, label: 'retrying' },
          { kind: 'apply_label', issue_id: tid, label: 'dispatching' },
          { kind: 'delete_retry', key },
          { kind: 'spawn_worker', identity: ctx.identity, target: ctx.target, attempt: ctx.attempt },
        ],
      };
    }
    throw new InvalidTransitionError(state, event.kind, 'target');
  }

  // succeeded | failed — terminal.
  throw new InvalidTransitionError(state, event.kind, 'target');
};

// ─── Recovery classifiers ──────────────────────────────────────────────────

/**
 * Pure classifier: parent label set → ParentState.
 *
 *   gaggle:analyzing  → analyzing (highest priority — analysis is in flight)
 *   gaggle:claimed    → claimed
 *   (no labels)       → unclaimed
 *
 * The classifier does NOT inspect Linear state. A parent issue in a terminal
 * Linear state but still carrying gaggle:claimed is in `claimed`; the
 * coordinator detects the externally-terminal condition via
 * reconcileRunningIssues and emits `parent_externally_terminal`.
 */
export const classifyParentState: ParentClassifierFn = (inp) => {
  if (inp.parent_labels.has('analyzing')) return { parent_id: inp.parent_id, state: 'analyzing' };
  if (inp.parent_labels.has('claimed')) return { parent_id: inp.parent_id, state: 'claimed' };
  return { parent_id: inp.parent_id, state: 'unclaimed' };
};

/**
 * Pure classifier: target label set + Archon status → TargetState.
 *
 * Resolution order (each branch returns; later branches don't run):
 *
 *   1. gaggle:waiting-human            → gate_waiting
 *      Gate is authoritative for this label; Archon status is informational.
 *
 *   2. gaggle:running, reconciled with Archon status:
 *        Archon paused                 → gate_waiting   (label drift; gate is truth)
 *        Archon completed              → succeeded      (label drift; run finished)
 *        Archon running                → running        (live, possibly detached)
 *        Archon failed / not-found     → retrying       (the orchestrator will re-queue)
 *
 *   3. gaggle:queued                   → queued
 *
 *   4. gaggle:retrying                 → retrying
 *
 *   5. gaggle:dispatching              → retrying
 *      A crash during dispatching means no worker ever started; treat as a
 *      retry candidate so the next tick re-enters the dispatch flow.
 *
 *   6. (no target-level labels)        → null
 */
export const classifyTargetState: TargetClassifierFn = (inp) => {
  const runId = inp.archon_run?.id ?? null;
  const recoveredAttempt = inp.persisted_retry?.attempt ?? 0;

  if (inp.target_labels.has('waiting_human')) {
    return { identity: inp.identity, state: 'gate_waiting', run_id: runId, attempt: recoveredAttempt };
  }

  if (inp.target_labels.has('running')) {
    const archonStatus = inp.archon_run?.status ?? null;
    if (archonStatus === 'paused') {
      return { identity: inp.identity, state: 'gate_waiting', run_id: runId, attempt: recoveredAttempt };
    }
    if (archonStatus === 'completed') {
      return { identity: inp.identity, state: 'succeeded', run_id: runId, attempt: recoveredAttempt };
    }
    if (archonStatus === 'running') {
      return { identity: inp.identity, state: 'running', run_id: runId, attempt: recoveredAttempt };
    }
    return { identity: inp.identity, state: 'retrying', run_id: null, attempt: recoveredAttempt };
  }

  if (inp.target_labels.has('queued')) {
    return { identity: inp.identity, state: 'queued', run_id: null, attempt: recoveredAttempt };
  }

  if (inp.target_labels.has('retrying')) {
    return { identity: inp.identity, state: 'retrying', run_id: null, attempt: recoveredAttempt };
  }

  if (inp.target_labels.has('dispatching')) {
    return { identity: inp.identity, state: 'retrying', run_id: null, attempt: recoveredAttempt };
  }

  return null;
};

/** Shared helper for `worker_failed` and `gate_rejected`/`gate_timed_out`:
 *  pick `retrying` or `failed` based on attempt count and emit the right
 *  effects. `extraEffects` are prepended (used by gate-reject/timeout to
 *  reject the Archon run before scheduling the retry). */
function retryOrFail(
  from: TargetState,
  ctx: TargetTransitionContext,
  key: WorkerKey,
  tid: string,
  currentLabel: TargetLabelKind,
  reason: string,
  extraEffects: Effect[] = [],
): TargetTransition {
  const nextAttempt = ctx.attempt + 1;
  if (nextAttempt > MAX_RETRY_ATTEMPTS) {
    return {
      from, to: 'failed',
      effects: [
        ...extraEffects,
        { kind: 'remove_label', issue_id: tid, label: currentLabel },
        { kind: 'set_linear_state', issue_id: tid, state: 'Cancelled' },
        { kind: 'delete_run', key },
        { kind: 'delete_retry', key },
        { kind: 'log', level: 'error', message: 'Max retries exhausted', fields: { key, reason } },
      ],
    };
  }
  const delayMs = Math.min(10_000 * Math.pow(2, nextAttempt - 1), ctx.cfg.agent.max_retry_backoff_ms);
  return {
    from, to: 'retrying',
    effects: [
      ...extraEffects,
      { kind: 'remove_label', issue_id: tid, label: currentLabel },
      { kind: 'apply_label', issue_id: tid, label: 'retrying' },
      { kind: 'delete_run', key },
      { kind: 'persist_retry', key, meta: { attempt: nextAttempt, due_at_ms: Date.now() + delayMs, reason } },
      { kind: 'schedule_retry_timer', key, delay_ms: delayMs, attempt: nextAttempt },
    ],
  };
}
