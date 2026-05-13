/**
 * Core domain types for GaggleDispatch (Symphony spec, Section 4).
 * All types here are runtime-shaped; YAML/JSON parsing should produce these.
 */

// ─── 4.1.1 Issue ────────────────────────────────────────────────────────────
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
  labels?: string[];
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
  parent_id?: string | null;
}

// ─── 4.1.2 Workflow Definition ──────────────────────────────────────────────
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
  source_path: string;
}

// ─── 4.1.3 Service Config (typed) ───────────────────────────────────────────
export interface GaggleLabels {
  claimed: string;
  queued: string;
  running: string;
  waiting_human: string;
  /** Applied to the parent issue while the IssueAnalyzer is running. */
  analyzing: string;
  /** Applied to a target between SM dispatch_attempted and worker_started. */
  dispatching: string;
  /** Applied to a target between failed attempts (worker_failed → retry_due).
   *  Deprecated under the no-auto-retry policy — kept for backwards compat. */
  retrying: string;
  /** Applied to a target that the worker failed on. The target parks here
   *  awaiting human review; no automatic retry. Operator removes the label
   *  (or fixes the underlying issue first) to trigger a retry. */
  failed: string;
}

export interface TrackerConfig {
  kind: 'linear';
  endpoint: string;
  api_key: string;
  project_slug: string;
  active_states: string[];
  terminal_states: string[];
  assigned_to_me: boolean;
  create_sub_issues: boolean;
  default_ready_env: string;
  deploy_env_labels: Record<string, string>;
  blocker_satisfied_states: string[];
  blocker_default_readiness: 'merged' | 'deployed' | string;
  gate_waiting_state: string | null;
  gate_resume_state: string | null;
  pr_ready_state: string | null;
  gaggle_labels: GaggleLabels;
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  before_run: string | null;
  after_run: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export interface ArchonConfig {
  command: string;
  /** Base URL of the Archon HTTP API. Default: http://localhost:3090. */
  api_url: string;
  /** How often (ms) to poll Archon's API for run status. Default: 5 000. */
  poll_interval_ms: number;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
  default_workflow: string;
  gate_timeout_ms: number;
}

export interface ClaudeConfig {
  api_key: string;
  analyzer_model: string;
  analyzer_max_tokens: number;
  gate_classifier_model: string;
}

export interface WorkflowTemplatesConfig {
  path: string;
  target_subdir: string;
  sync_on_dispatch: boolean;
  reload_on_change: boolean;
}

export interface RegistryConfig {
  base_folder: string;
  /**
   * Optional: absolute path to the directory where repo checkouts live.
   * Defaults to `<base_folder>/repos`. Use this to point GaggleDispatch at an
   * existing set of developer checkouts so it does not create duplicate clones.
   */
  repos_path?: string;
  sync_interval_ms: number;
  sync_on_startup: boolean;
  analysis_cache_ttl_ms: number;
  /** Automatically launch an async scaffold job for repos missing gaggle.md after each sync pass. Default: true. */
  auto_scaffold: boolean;
}

export interface SourceRegistryEntry {
  url: string;
  default_branch: string;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  archon: ArchonConfig;
  claude: ClaudeConfig;
  workflow_templates: WorkflowTemplatesConfig;
  registry: RegistryConfig;
  repositories: SourceRegistryEntry[];
  prompt_template: string;
  workflow_md_path: string;
  project_dir: string;
}

// ─── 4.1.4 Registry Context ─────────────────────────────────────────────────
export interface CommunicatesWith {
  component: string;
  method: string;
  direction: 'produces' | 'consumes' | 'reads' | 'writes' | 'depends_on' | 'bidirectional' | string;
}

export interface ComponentRecord {
  name: string;
  description: string;
  component_type?: string;
  communicates_with?: CommunicatesWith[];
  default_workflow?: string;
  [key: string]: unknown;
}

export interface RepoFrontmatter {
  name: string;
  description: string;
  default_workflow: string;
  available_workflows?: string[];
  components: ComponentRecord[];
  [key: string]: unknown;
}

export type SyncStatus = 'ok' | 'error' | 'missing_gaggle_md' | 'pending';

export interface SyncedRegistryRepoEntry {
  url: string;
  default_branch: string;
  slug: string;
  local_path: string;
  last_synced_at: string | null;
  last_commit_sha: string | null;
  sync_status: SyncStatus;
  sync_error: string | null;
  frontmatter: RepoFrontmatter | null;
  narrative: string | null;
}

export interface SyncedRegistry {
  synced_at: string;
  repositories: SyncedRegistryRepoEntry[];
}

export interface RegistryRepo {
  name: string;
  url: string;
  local_path: string;
  description: string;
  default_workflow: string;
  available_workflows: string[];
  components: ComponentRecord[];
  narrative: string;
}

export interface RegistryComponent extends ComponentRecord {
  repo_name: string;
  repo_url: string;
  repo_local_path: string;
}

export interface RegistryContext {
  repositories: RegistryRepo[];
  components: RegistryComponent[];
  last_synced_at: string;
  warnings: string[];
  /** Absolute path to the directory containing all local repo checkouts. */
  repos_dir: string;
}

// ─── 4.1.5 Issue Analysis ───────────────────────────────────────────────────
export interface RepoTarget {
  repo_url: string;
  repo_alias: string;
  local_path: string;
  archon_workflow: string;
  rationale: string;
  components: string[];
  depends_on?: string[];
  ready_when?: string;
}

export interface IssueAnalysis {
  issue_id: string;
  analysis_summary: string;
  repo_targets: RepoTarget[];
}

export interface CachedAnalysis {
  analysis: IssueAnalysis;
  cached_at: number;
}

// ─── 4.1.7 Run Attempt ──────────────────────────────────────────────────────
export type RunStatus =
  | 'PreparingWorkspace'
  | 'CloningRepository'
  | 'BuildingPrompt'
  | 'LaunchingArchon'
  | 'StreamingWorkflow'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  repo_alias: string;
  archon_workflow: string;
  attempt: number | null;
  checkout_path: string;
  started_at: string;
  status: RunStatus;
  error?: string;
}

// ─── 4.1.8 Live Session Metadata ────────────────────────────────────────────
export interface LiveSession {
  session_id: string;
  issue: Issue;
  identifier: string;
  repo_alias: string;
  repo_target: RepoTarget;
  sub_issue_id: string | null;
  archon_pid: number | null;
  /** Archon DB run id captured from the `workflowRunId` log line at startup. */
  archon_db_run_id: string | null;
  archon_workflow: string;
  last_archon_event: string | null;
  last_archon_timestamp: string | null;
  last_archon_message: string | null;
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_total_tokens: number;
  turn_count: number;
  started_at: string;
  attempt: number | null;
  cancel?: () => void;
  /** Stops the ArchonRunPoller when the session ends. */
  stopPoller?: () => void;
}

// ─── 4.1.10 Retry Entry ─────────────────────────────────────────────────────
export interface RetryEntry {
  issue_id: string;
  identifier: string;
  repo_alias: string;
  repo_target: RepoTarget;
  issue: Issue;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout> | null;
  error: string | null;
}

// ─── Supervised Gate Entry ──────────────────────────────────────────────────
export interface SupervisedGateEntry {
  run_id: string | null;
  issue_id: string;
  issue: Issue;
  repo_alias: string;
  repo_target: RepoTarget;
  sub_issue_id: string | null;
  paused_at: number;
  gate_message: string;
  comment_id: string | null;
  gate_state_applied: boolean;
  attempt: number | null;
}

/**
 * A sub-issue whose Archon process was found still running (or paused) at startup.
 * We cannot re-attach to its stdout/stderr, so we track it here and poll
 * `archon workflow status` periodically to detect completion.
 */
export interface DetachedArchonRun {
  /** Archon database run id (hex string from `archon workflow status --json`). */
  archon_run_id: string;
  parent_issue: Issue;
  sub_issue_id: string | null;
  repo_alias: string;
  repo_target: RepoTarget;
  recovered_at: number;
}

// ─── 4.1.11 Orchestrator Runtime State ──────────────────────────────────────
export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, LiveSession>;
  pending_targets: Map<string, RepoTarget[]>;
  pending_issues: Map<string, Issue>;
  supervised_gates: Map<string, SupervisedGateEntry>;
  retry_attempts: Map<string, RetryEntry>;
  analysis_cache: Map<string, CachedAnalysis>;
  sibling_subissues: Map<string, Map<string, string>>;
  subissue_snapshot: Map<string, { state: string; labels: string[]; refreshed_at: number }>;
  /**
   * Sub-issues whose Archon process was found still alive at startup recovery.
   * Keyed by workerKey (parentId__repoAlias). Polled each reconcile tick.
   */
  detached_archon_runs: Map<string, DetachedArchonRun>;
  /**
   * Per-target state machine state, keyed by workerKey. Updated after every
   * targetTransition call via Orchestrator.emitTargetEvent. Phase 5 will
   * migrate `claimed` / `completed` / parts of `running` consumers to read
   * from this map instead of the legacy sets.
   */
  target_machine_states: Map<string, 'queued' | 'dispatching' | 'running' | 'gate_waiting' | 'retrying' | 'succeeded' | 'failed'>;
  /**
   * Per-parent state machine state, keyed by parent issue id. Updated after
   * every parentTransition call.
   */
  parent_machine_states: Map<string, 'unclaimed' | 'analyzing' | 'claimed' | 'done' | 'cancelled'>;
  claude_totals: { input_tokens: number; output_tokens: number; total_tokens: number; seconds_running: number };
}

// ─── Scaffold job (Section 21.6.2) ──────────────────────────────────────────
export interface ScaffoldJob {
  slug: string;
  url: string;
  checkout_path: string;
  archon_run_id: string | null;
  workflow_name: string;
  branch: string;
  started_at: string;
  last_polled_at: string | null;
  last_status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  pr_url: string | null;
  last_error: string | null;
}

export interface ScaffoldJobsFile {
  jobs: ScaffoldJob[];
}
