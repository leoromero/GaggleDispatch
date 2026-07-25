/**
 * The executor seam.
 *
 * Everything the orchestrator knows about workflow execution goes through
 * `WorkflowExecutor`. The engine that implements it lives in `engine/`; the
 * orchestrator never imports from there directly.
 *
 * `RunRecord` is deliberately flat and boring — the state machine, the effect
 * applier, and the startup recovery classifier all pattern-match on it, so it
 * carries exactly the fields those consumers need and nothing else.
 */

// ─── Run status ─────────────────────────────────────────────────────────────

/**
 * Lifecycle of a single workflow run.
 *
 * `interrupted` has no analogue in the old Archon model: it marks a run whose
 * owning process died mid-node. The startup sweep produces it, and resume
 * consumes it. Treat it as recoverable — unlike `failed`, nothing decided the
 * work was wrong, we just lost the executor.
 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

export function isTerminalRunStatus(s: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

/** Per-node lifecycle. `skipped` is a `when:` miss, not a failure. */
export type NodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'interrupted';

/**
 * Whether a node may be re-run after an interruption.
 *
 * `at_most_once` nodes (open a PR, post a comment) are never blindly retried —
 * on resume they park at a synthetic approval gate so a human can say whether
 * the effect actually landed.
 */
export type SideEffects = 'idempotent' | 'at_most_once';

// ─── Records ────────────────────────────────────────────────────────────────

export interface ApprovalMetadata {
  /** Node id of the gate currently holding the run. */
  nodeId?: string;
  /** Message shown to the human. Variable references are already resolved. */
  message?: string;
}

export interface RunMetadata {
  approval?: ApprovalMetadata;
  /** Reason recorded by a `cancel:` node or an explicit cancel call. */
  cancel_reason?: string;
  /** Set when the run was reclaimed by the startup sweep. */
  interrupted_reason?: string;
  [key: string]: unknown;
}

export interface RunRecord {
  id: string;
  workflow_name: string;
  user_message: string;
  status: RunStatus;
  /** Absolute path the workflow executed in — worktree or live checkout. */
  working_path: string | null;
  /** Informational: which registered repo and branch this run belongs to. */
  repo_slug?: string | null;
  branch?: string | null;
  started_at: string;
  completed_at: string | null;
  /** Bumped on every node transition. Drives stall detection. */
  last_activity_at: string | null;
  metadata: RunMetadata;
}

export interface NodeRecord {
  run_id: string;
  node_id: string;
  node_type: string;
  status: NodeStatus;
  attempt: number;
  /** Resolves `$nodeId.output`. Null until the node completes. */
  output: string | null;
  /** Parsed output when the node declared `output_format`. */
  output_json: unknown | null;
  error: string | null;
  side_effects: SideEffects;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Events ─────────────────────────────────────────────────────────────────

/**
 * Emitted as a run progresses. The orchestrator maps these onto its own
 * state-machine events.
 *
 * Unlike the Archon integration these are direct in-process callbacks, so
 * `run_gate_paused` is exact rather than inferred from a log line.
 */
export type RunEvent =
  | { type: 'run_started'; run_id: string }
  | { type: 'node_started'; run_id: string; node_id: string; node_type: string }
  /** A line of stdout/stderr, or a chunk of assistant text, from a node. */
  | { type: 'node_output'; run_id: string; node_id: string; line: string }
  | { type: 'node_completed'; run_id: string; node_id: string; output: string }
  | { type: 'node_failed'; run_id: string; node_id: string; error: string }
  | { type: 'node_skipped'; run_id: string; node_id: string; reason: string }
  | { type: 'run_gate_paused'; run_id: string; node_id: string; gate_message: string }
  | { type: 'run_succeeded'; run_id: string }
  | { type: 'run_failed'; run_id: string; error: string }
  | { type: 'run_cancelled'; run_id: string; reason: string }
  /** Emitted when the engine gives up on a node after `idle_timeout`. */
  | { type: 'run_timed_out'; run_id: string; node_id: string | null };

export type RunEventHandler = (event: RunEvent) => void;

// ─── Requests ───────────────────────────────────────────────────────────────

export interface StartRunRequest {
  /** Workflow name as written in the YAML `name:` field. */
  workflow: string;
  /** Repo checkout the workflow runs against. Worktrees branch from here. */
  cwd: string;
  /** Becomes `$ARGUMENTS` / `$USER_MESSAGE`. */
  message: string;
  /** Slug of the registered repo, for run attribution. */
  repo_slug?: string;
  /** Extra env injected into every bash/script/AI subprocess. */
  env?: Record<string, string>;
  /** Branch new worktrees are cut from. Defaults to the repo's current HEAD branch. */
  base_branch?: string;
  /**
   * Skip worktree creation and run in the live checkout. Refused when the
   * workflow pins `worktree.enabled: true`.
   */
  no_worktree?: boolean;
  /**
   * Execute the DAG with AI nodes stripped of write tools and PR-creating
   * nodes skipped. Used to exercise graph semantics without side effects.
   */
  dry_run?: boolean;
}

export interface RunFilter {
  status?: RunStatus[];
  repo_slug?: string;
  /** Substring match against `working_path`. */
  working_path_contains?: string;
  limit?: number;
}

export interface RunHandle {
  run_id: string;
  /** Terminate the run and its in-flight node subprocesses. */
  cancel: (reason?: string) => void;
  /**
   * Settles when the run reaches a terminal status **or pauses at a gate** —
   * a paused run has no executor attached, so awaiting it forever would leak.
   */
  done: Promise<void>;
}

// ─── The interface ──────────────────────────────────────────────────────────

export interface WorkflowExecutor {
  /** Create a run row, plan the DAG, and begin executing. */
  startRun(req: StartRunRequest, onEvent: RunEventHandler): Promise<RunHandle>;

  /**
   * Continue a `paused`, `failed`, or `interrupted` run. Nodes already
   * `completed` under the same workflow hash are skipped and their stored
   * output reused.
   */
  resumeRun(runId: string, onEvent: RunEventHandler, opts?: ResumeOptions): Promise<RunHandle>;

  /** Record approval for the pending gate and resume. Comment is preserved for downstream nodes. */
  approve(runId: string, comment?: string): Promise<void>;

  /** Record rejection. Runs `on_reject` rework if the gate declares it, else cancels the run. */
  reject(runId: string, reason?: string): Promise<void>;

  /** Terminate a live run, killing in-flight subprocesses. */
  cancel(runId: string, reason?: string): Promise<void>;

  /** Mark a non-terminal run cancelled without touching any subprocess. Orphan cleanup. */
  abandon(runId: string): Promise<void>;

  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(filter?: RunFilter): Promise<RunRecord[]>;
  getNodes(runId: string): Promise<NodeRecord[]>;
}

export interface ResumeOptions {
  /**
   * Resume even though the workflow YAML changed since the run started.
   * Discards cached node outputs rather than mixing two workflow versions.
   */
  force?: boolean;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Most recent run whose `working_path` contains `repoBasename` and whose status
 * is in `statuses`. Used by startup recovery to rebind a target to its run when
 * the run-registry entry is missing.
 */
export function findRunForRepo(
  runs: RunRecord[],
  repoBasename: string,
  statuses: RunStatus[],
): RunRecord | null {
  const needle = repoBasename.toLowerCase();
  const matches = runs.filter(
    (r) =>
      statuses.includes(r.status) &&
      r.working_path != null &&
      r.working_path.toLowerCase().includes(needle),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.started_at || '') - Date.parse(a.started_at || ''));
  return matches[0] ?? null;
}
