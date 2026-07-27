/**
 * Persistence contract for the workflow engine.
 *
 * `PostgresStore` is the only production implementation — see the design doc
 * §12.2 for why there is no SQLite driver. `MemoryStore` exists solely as a
 * test double so engine semantics can be unit-tested without a database; it is
 * held to the same contract by a shared conformance suite.
 */

import type {
  NodeStatus,
  RunMetadata,
  RunStatus,
  SideEffects,
} from '../types.ts';

// ─── Rows ───────────────────────────────────────────────────────────────────

/**
 * A run as stored. Wider than the public `RunRecord`: carries the fields the
 * engine needs to resume (workflow hash, artifacts dir, lease) but that the
 * orchestrator has no business reading.
 */
export interface RunRow {
  id: string;
  workflow_name: string;
  /** Absolute path the YAML was loaded from. */
  workflow_source: string;
  /** sha256 of the normalized workflow. A mismatch blocks a silent resume. */
  workflow_hash: string;
  user_message: string;
  status: RunStatus;
  repo_slug: string | null;
  working_path: string | null;
  base_branch: string | null;
  branch: string | null;
  artifacts_dir: string | null;
  /**
   * Caller-supplied identity for this run — the orchestrator stamps its
   * worker key here. Turns "which run belongs to this issue+repo" into a
   * query, which is what let the run-registry sidecar go away.
   */
  external_key: string | null;
  env: Record<string, string>;
  metadata: RunMetadata;
  started_at: string;
  completed_at: string | null;
  last_activity_at: string | null;
  /** `<host>:<pid>` of the process currently executing this run. */
  lease_owner: string | null;
  lease_expires_at: string | null;
  dry_run: boolean;
}

export interface NodeRow {
  run_id: string;
  node_id: string;
  node_type: string;
  status: NodeStatus;
  attempt: number;
  output: string | null;
  output_json: unknown | null;
  error: string | null;
  claude_session_id: string | null;
  side_effects: SideEffects;
  input_tokens: number;
  output_tokens: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface LoopIterationRow {
  run_id: string;
  node_id: string;
  iteration: number;
  output: string | null;
  /** `$LOOP_USER_INPUT` supplied for this iteration, if it followed a gate. */
  user_input: string | null;
  completed: boolean;
  created_at: string;
}

export interface EventRow {
  id: number;
  run_id: string;
  event_type: string;
  node_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

export interface ApprovalRow {
  id: string;
  run_id: string;
  node_id: string;
  message: string;
  decision: ApprovalDecision | null;
  comment: string | null;
  /** How many times `on_reject.prompt` has run for this gate. */
  rework_attempts: number;
  created_at: string;
  decided_at: string | null;
}

export interface WorktreeRow {
  id: string;
  repo_slug: string;
  branch: string;
  path: string;
  base_branch: string | null;
  run_id: string | null;
  created_at: string;
  last_activity_at: string;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface CreateRunInput {
  id: string;
  workflow_name: string;
  workflow_source: string;
  workflow_hash: string;
  user_message: string;
  repo_slug?: string | null;
  working_path?: string | null;
  base_branch?: string | null;
  branch?: string | null;
  artifacts_dir?: string | null;
  external_key?: string | null;
  env?: Record<string, string>;
  metadata?: RunMetadata;
  dry_run?: boolean;
}

// ─── Registry rows ──────────────────────────────────────────────────────────

export interface ScaffoldJobRow {
  slug: string;
  url: string;
  checkout_path: string;
  run_id: string | null;
  workflow_name: string;
  branch: string;
  started_at: string;
  last_polled_at: string | null;
  last_status: string;
  pr_url: string | null;
  last_error: string | null;
}

export interface SyncedRepoRow {
  url: string;
  slug: string;
  default_branch: string;
  local_path: string;
  last_synced_at: string | null;
  last_commit_sha: string | null;
  sync_status: string;
  sync_error: string | null;
  frontmatter: unknown | null;
  narrative: string | null;
}

export interface RunQuery {
  status?: RunStatus[];
  repo_slug?: string;
  working_path_contains?: string;
  limit?: number;
}

export interface UpsertNodeInput {
  run_id: string;
  node_id: string;
  node_type: string;
  status: NodeStatus;
  attempt?: number;
  output?: string | null;
  output_json?: unknown | null;
  error?: string | null;
  claude_session_id?: string | null;
  side_effects?: SideEffects;
  input_tokens?: number;
  output_tokens?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface Store {
  /** Apply any pending migrations. Safe to call repeatedly. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  // runs
  createRun(input: CreateRunInput): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | null>;
  listRuns(query?: RunQuery): Promise<RunRow[]>;
  /**
   * Patch a run. `metadata` is shallow-merged rather than replaced so
   * concurrent writers touching different keys don't clobber each other.
   */
  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRow,
        | 'status'
        | 'working_path'
        | 'branch'
        | 'base_branch'
        | 'artifacts_dir'
        | 'completed_at'
        | 'last_activity_at'
      >
    > & { metadata?: RunMetadata },
  ): Promise<RunRow | null>;
  /** Bump `last_activity_at` to now. Called on every node transition. */
  touchRun(id: string): Promise<void>;

  // leases
  /**
   * Claim a run for this process. Succeeds only when the run is unleased or
   * its lease has expired. Returns false when another live process holds it.
   */
  acquireLease(id: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease(id: string, owner: string, ttlMs: number): Promise<void>;
  releaseLease(id: string, owner: string): Promise<void>;
  /**
   * Find runs still marked `running` whose lease has lapsed — their executor
   * died. Used by the startup sweep.
   */
  findExpiredRuns(): Promise<RunRow[]>;

  // nodes
  upsertNode(input: UpsertNodeInput): Promise<NodeRow>;
  getNodes(runId: string): Promise<NodeRow[]>;
  getNode(runId: string, nodeId: string): Promise<NodeRow | null>;
  /** Reset nodes left `running` by a dead executor. Returns the affected rows. */
  markRunningNodesInterrupted(runId: string): Promise<NodeRow[]>;

  // loop iterations
  appendLoopIteration(row: Omit<LoopIterationRow, 'created_at'>): Promise<void>;
  getLoopIterations(runId: string, nodeId: string): Promise<LoopIterationRow[]>;

  // events
  appendEvent(
    runId: string,
    eventType: string,
    nodeId: string | null,
    data?: Record<string, unknown>,
  ): Promise<void>;
  listEvents(runId: string, sinceId?: number): Promise<EventRow[]>;

  // approvals
  createApproval(input: {
    id: string;
    run_id: string;
    node_id: string;
    message: string;
  }): Promise<ApprovalRow>;
  /** The gate currently holding the run, if any. */
  getPendingApproval(runId: string): Promise<ApprovalRow | null>;
  /**
   * Rewrite a pending gate's question.
   *
   * Startup recovery needs this: a run can crash while already parked, and
   * only one gate may be pending at a time, so the `at_most_once` warning is
   * appended to the question the human is already being asked rather than
   * silently dropped.
   */
  updateApprovalMessage(id: string, message: string): Promise<void>;
  decideApproval(
    id: string,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ApprovalRow | null>;
  incrementReworkAttempts(id: string): Promise<number>;

  // run lookup by caller identity
  /** Most recent run stamped with this external key, whatever its status. */
  findRunByExternalKey(externalKey: string): Promise<RunRow | null>;

  // analysis cache
  saveAnalysis(issueId: string, analysis: unknown): Promise<void>;
  getAnalysis(issueId: string): Promise<unknown | null>;
  deleteAnalysis(issueId: string): Promise<void>;

  // scaffold jobs
  upsertScaffoldJob(row: ScaffoldJobRow): Promise<void>;
  listScaffoldJobs(): Promise<ScaffoldJobRow[]>;
  deleteScaffoldJob(slug: string): Promise<void>;

  // synced registry
  /** Replace the whole registry atomically and bump the sync marker. */
  replaceSyncedRegistry(syncedAt: string, repos: SyncedRepoRow[]): Promise<void>;
  loadSyncedRegistry(): Promise<{ synced_at: string; repositories: SyncedRepoRow[] } | null>;
  /** The sync marker alone. Polled to notice a sync from another process. */
  registrySyncedAt(): Promise<string | null>;

  // worktrees
  upsertWorktree(row: Omit<WorktreeRow, 'created_at' | 'last_activity_at'>): Promise<WorktreeRow>;
  listWorktrees(repoSlug?: string): Promise<WorktreeRow[]>;
  getWorktree(repoSlug: string, branch: string): Promise<WorktreeRow | null>;
  touchWorktree(repoSlug: string, branch: string): Promise<void>;
  deleteWorktree(repoSlug: string, branch: string): Promise<void>;
}
