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

export interface AuthConfig {
  /** `api_key` (legacy, uses cfg.tracker.api_key) or `oauth` (recommended). */
  mode: 'api_key' | 'oauth';
  // OAuth-only fields. Empty strings when mode === 'api_key'.
  client_id: string;
  client_secret: string;
  /** Must match the URI registered in the Linear OAuth app, character for
   *  character (including path). */
  redirect_uri: string;
  scopes: string[];
}

export interface TrackerConfig {
  kind: 'linear';
  endpoint: string;
  api_key: string;
  project_slug: string;
  active_states: string[];
  terminal_states: string[];
  assigned_to_me: boolean;
  /**
   * When set, candidate issues are filtered by `assignee.email == this`.
   * Takes precedence over `assigned_to_me`. Required under OAuth `actor=app`
   * because the OAuth viewer is the app itself, not a human user with
   * assigned issues.
   */
  assigned_to_user_email: string | null;
  create_sub_issues: boolean;
  default_ready_env: string;
  deploy_env_labels: Record<string, string>;
  blocker_satisfied_states: string[];
  blocker_default_readiness: 'merged' | 'deployed' | string;
  gate_waiting_state: string | null;
  gate_resume_state: string | null;
  pr_ready_state: string | null;
  gaggle_labels: GaggleLabels;
  auth: AuthConfig;
  /**
   * Mirror `gaggle_labels` onto tracker issues as work progresses.
   *
   * One-way and off by default. The control plane in Postgres is the state
   * machine; when this is on the labels exist purely so the team can see activity
   * in the tracker. Nothing in the codebase reads a gaggle label to make a
   * decision — turning this off changes what the team sees, never what runs.
   */
  mirror_labels: boolean;
  /**
   * Attempts before a queued tracker write is dropped with an error log. A
   * permanently-failing write must not block work.
   */
  outbox_max_attempts: number;
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

/**
 * Whatever is executing workflows for us.
 *
 * Named for the role, not the implementation. The transport half of this used
 * to describe how to reach Archon; the engine runs in-process, so the fields
 * that remain are policy — decisions about how long we let a node sit idle, a
 * graph run, or a human think — plus the lease timings that let one process
 * tell a live run from an abandoned one.
 */
export interface ExecutorConfig {
  /** Workflow dispatched when a repo's gaggle.md declares none. */
  default_workflow: string;
  /** Hard ceiling on a single run's wall-clock time. Default: 1 h. */
  max_run_duration_ms: number;
  /** Per-node idle timeout for AI streaming. Default: 5 min. Overridable per node. */
  node_idle_timeout_ms: number;
  /** Default total execution limit for `bash:` / `script:` nodes. Default: 2 min. */
  bash_timeout_ms: number;
  /** Informational stall threshold — no node activity for this long. 0 disables. */
  stall_timeout_ms: number;
  /** Auto-reject a supervised gate after this long with no human reply. 0 disables. */
  gate_timeout_ms: number;
  /**
   * If > 0, sweep worktrees idle for more than N days once at orchestrator
   * startup, per registered repo — catching abandoned, cancelled, and orphaned
   * ones in one pass. Worktrees backing an open PR are always preserved, and
   * the per-run `after_run` hook handles merged branches continuously; this
   * complements it for the long tail.
   * Set to 0 to disable. Default: 7.
   */
  startup_cleanup_age_days: number;
  /** How often a live run refreshes its lease. Must be well under `lease_ttl_ms`. */
  lease_heartbeat_ms: number;
  /** A run whose lease is older than this is considered crashed and reclaimable. */
  lease_ttl_ms: number;
}

/**
 * The shared PostgreSQL database.
 *
 * One database serves both the control plane (tickets, targets, audit trail,
 * tracker outbox — migrations 100–199) and the workflow engine (runs, nodes,
 * approvals — migrations 1–99). Disjoint migration ranges over one
 * `schema_migrations` table let each apply its own schema without knowing about
 * the other; see `src/store/migrate.ts`.
 */
export interface DatabaseConfig {
  /** Connection string. Defaults to `$DATABASE_URL`. */
  url: string;
  /** Pool ceiling. Zero leaves the driver's default in place. */
  max_connections: number;
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
  executor: ExecutorConfig;
  database: DatabaseConfig;
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
  workflow: string;
  rationale: string;
  components: string[];
  depends_on?: string[];
  ready_when?: string;
}

export interface IssueAnalysis {
  issue_id: string;
  analysis_summary: string;
  repo_targets: RepoTarget[];
  complexity?: 'simple' | 'complex';
}

// Types that modelled in-memory authority over durable facts are gone with the
// maps that held them: CachedAnalysis, FailedTargetInfo, FailedTargetSummary,
// RunStatus, RunAttempt, RetryEntry, SupervisedGateEntry, DetachedArchonRun.
// Each is now a column or a row in the control plane — a failed target is a
// ticket_targets row with status 'failed', an open gate is one with
// status 'gate_waiting', and there is no retry entry because there is no
// retry timer.

// ─── 4.1.8 Live Session Metadata ────────────────────────────────────────────
export interface LiveSession {
  session_id: string;
  issue: Issue;
  identifier: string;
  repo_alias: string;
  repo_target: RepoTarget;
  sub_issue_id: string | null;
  run_pid: number | null;
  /** Engine run id, known as soon as the run row is created. */
  run_id: string | null;
  workflow: string;
  last_event: string | null;
  last_event_at: string | null;
  last_message: string | null;
  /**
   * Ring buffer of the most recent node output lines (capped). Surfaced in
   * the worker-exit log when a worker fails, so the operator sees why without
   * querying the run's event trail.
   */
  recent_output: string[];
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_total_tokens: number;
  turn_count: number;
  started_at: string;
  attempt: number | null;
  cancel?: () => void;
}

// ─── 4.1.11 Orchestrator Runtime State ──────────────────────────────────────

/**
 * What the orchestrator keeps in memory: live-worker telemetry, and nothing else.
 *
 * Every map that used to live here — pending targets, supervised gates, retry
 * timers, the analysis cache, sibling sub-issue lookups, the two state-machine
 * status maps — was in-memory authority over durable facts, which is exactly why
 * a restart had to reconstruct it by reading `gaggle:*` labels back off the
 * tracker. Those facts now live in Postgres and are read from there.
 *
 * What genuinely belongs in memory is what dies with the process anyway: the
 * subprocess handle, its pid, its recent output, its token counters. That is a
 * feed for the dashboard's Workers panel, not state anything decides on.
 */
export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  /** Live workers this process owns, keyed by target id. */
  running: Map<string, LiveSession>;
  claude_totals: { input_tokens: number; output_tokens: number; total_tokens: number; seconds_running: number };
}

// ─── Scaffold job (Section 21.6.2) ──────────────────────────────────────────
export interface ScaffoldJob {
  slug: string;
  url: string;
  checkout_path: string;
  run_id: string | null;
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
