/**
 * Outbound ports.
 *
 * The control plane owns state and decisions; everything it cannot do itself is
 * declared here as a narrow interface and injected. That is what keeps this
 * module independent of which workflow engine is executing: the control plane
 * knows a target has an opaque `run_id` and that these four operations exist,
 * and nothing more. Archon today, the in-house engine later, a fake in tests —
 * the control plane cannot tell the difference.
 *
 * The same applies to the tracker: `TrackerWritePort` is four write operations
 * with no read half, which is the type system stating that the tracker is a sink.
 */

import type { Issue } from '../domain/types.ts';
import type { BlockerSpec } from './transitions.ts';
import type { TargetRow, TicketRow } from './types.ts';

/** Everything an executor needs to act on one target. */
export interface DispatchContext {
  ticket: TicketRow;
  target: TargetRow;
}

export interface SpawnResult {
  /**
   * The run id, when the executor knows it synchronously. Null is legitimate:
   * an executor that only learns its run id asynchronously reports it later via
   * `ControlService.recordRunId`. The target is `running` either way — a live
   * process with no id yet is not a different state.
   */
  run_id: string | null;
}

export interface ExecutorPort {
  /** Start a workflow run. Throwing means the target failed to dispatch. */
  spawnRun(ctx: DispatchContext): Promise<SpawnResult>;
  /** Stop a run. Must tolerate a run that is already gone. */
  killRun(runId: string | null, ctx: DispatchContext): Promise<void>;
  /** Record the approval and resume the run. */
  approveGate(args: {
    approval_id: string | null;
    run_id: string | null;
    comment: string | null;
    ctx: DispatchContext;
  }): Promise<void>;
  /** Record the rejection; the workflow's `on_reject` path takes it from there. */
  rejectGate(args: {
    approval_id: string | null;
    run_id: string | null;
    reason: string;
    ctx: DispatchContext;
  }): Promise<void>;
}

/**
 * Read-only tracker access, used by sync.
 *
 * Deliberately separate from {@link TrackerWritePort}: sync is the only thing
 * allowed to read the tracker, and it may only write what it reads into the
 * `external_*` columns. Nothing that makes a decision gets to call these.
 */
export interface TrackerReadPort {
  /** Issues matching the import filter (active states, assignee, team). */
  fetchCandidateIssues(): Promise<TrackerIssue[]>;
  /**
   * Current state of specific issues, by tracker id. Needed because a ticket
   * that has gone terminal drops out of the candidate query, so the only way to
   * observe that is to ask about it directly.
   */
  fetchIssueStatesByIds(ids: string[]): Promise<TrackerIssue[]>;
}

/** The tracker's issue shape, as normalized by the tracker client. */
export type TrackerIssue = Issue;

/**
 * Write-only tracker access, used by the outbox drainer.
 *
 * There is deliberately no read method. Reads belong to sync, which has its own
 * client; giving the drainer a read method would make it possible to
 * reintroduce tracker state as an input to a decision.
 */
export interface TrackerWritePort {
  setState(externalId: string, state: string): Promise<void>;
  postComment(externalId: string, body: string): Promise<void>;
  applyLabel(externalId: string, label: string): Promise<void>;
  removeLabel(externalId: string, label: string): Promise<void>;
}

/** Tracker operations that create structure rather than annotate it. */
export interface TrackerStructurePort {
  /** Create an issue and mark it as blocking `blocksExternalId`. */
  createBlockerIssue(spec: BlockerSpec, blocksExternalId: string): Promise<void>;
  /** Create a sub-issue for a target. Returns its tracker identity. */
  createSubIssue(args: {
    ticket: TicketRow;
    target: TargetRow;
  }): Promise<{ external_id: string; url: string | null }>;
}

/** Produces a fan-out for a ticket. Wraps `IssueAnalyzer`. */
export interface AnalyzerPort {
  analyze(ticket: TicketRow): Promise<AnalysisResult>;
}

export interface AnalysisResult {
  summary: string;
  complexity: 'simple' | 'complex' | null;
  targets: Array<{
    repo_alias: string;
    repo_url: string;
    local_path: string;
    workflow: string;
    rationale?: string | null;
    components?: string[];
    depends_on?: string[];
    ready_when?: string | null;
  }>;
}

/**
 * How many more runs may start right now.
 *
 * The reconciler counts live targets from the store and passes the number in, so
 * the ceiling holds across a restart and across two daemons sharing a database —
 * a port that counted its own in-memory sessions would forget everything on
 * restart and let concurrency drift.
 */
export interface SlotPort {
  /** @param liveCount targets the store reports as dispatching, running, or gate_waiting */
  availableSlots(liveCount: number): number;
}

/**
 * What the executor currently believes about a run.
 *
 * `unknown` is distinct from `failed` on purpose: a run the executor has never
 * heard of after a restart is not evidence that it failed, and treating it as a
 * failure would post a spurious failure comment on the tracker.
 */
export type ObservedRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface RunObservation {
  status: ObservedRunStatus;
  /** Present when the run is paused at a gate. */
  approval?: { id: string; message: string } | null;
  /** Free-text detail for a failure, used as the failure reason. */
  error?: string | null;
}

/**
 * Read-side of the executor, for reconciling runs this process did not start —
 * runs adopted after a daemon restart, in particular.
 *
 * With an in-process executor that delivers lifecycle callbacks this is a
 * backstop. While the executor is out-of-process it is the primary mechanism,
 * which is what lets the control plane land independently of the engine rewrite.
 */
export interface RunStatusPort {
  observeRun(runId: string): Promise<RunObservation>;
}
