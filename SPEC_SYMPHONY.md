# Symphony — Service Specification

Status: Draft v2 (language-agnostic, Archon+Claude variant, federated registry model)

Purpose: Define a service that orchestrates AI coding agents — via Archon workflows powered by
Claude — to get project work done across a distributed multi-service AWS architecture. Symphony
reads work from Linear, analyzes it against a federated registry of repository self-descriptions
(`symphony.md` documents, one per registered repository), routes it to the correct repositories,
and runs Archon workflow sessions in per-issue isolated workspaces.

This specification consolidates and supersedes the prior `SPEC_SONNET.md` (Sonnet variant) and
`SPEC_REGISTRY.md` (federated registry extension). All references to a centralized
Architecture Knowledge Base (`ARCH.md`) in earlier drafts are replaced by the federated registry
model described below.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## Recommended Implementation Language

The RECOMMENDED implementation language for this specification is **TypeScript running on Bun**.

Rationale:
- Archon is natively built on Bun and exposes a CLI and YAML workflow model; a TypeScript host
  integrates without language impedance.
- The Anthropic SDK for TypeScript is first-class and actively maintained.
- Bun's async primitives (async/await, subprocess API) cover the orchestration, subprocess
  management, and file-watch needs of this specification without heavyweight frameworks.
- Strong typing prevents a class of orchestration bugs that are otherwise hard to catch at
  runtime in a long-lived daemon.

Alternative conforming languages include Go (excellent for long-lived daemons), Python
(Anthropic SDK is also first-class), and Elixir (the reference Symphony implementation language).
Each is a valid choice; the rationale above is the primary recommendation, not a mandate.

---

## 1. Problem Statement

Symphony is a long-running automation service that:

1. Continuously reads work from a Linear issue tracker.
2. Analyzes each issue against a **federated repository registry** — a set of repository
   self-descriptions (`symphony.md` documents) that collectively describe the full distributed
   system: ECS services, Lambda functions, SQS queues, EventBridge buses, Redshift clusters,
   HealthLake stores, RDS databases, shared libraries — and the git repositories that own each
   component.
3. Determines which repositories and Archon workflow types are relevant to the issue.
4. Creates isolated workspaces per issue per repository.
5. Runs Archon workflow sessions (backed by Claude) in those workspaces.

The service solves five operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It routes work to the correct repositories based on semantic understanding of the issue,
  eliminating the guesswork of which service owns which change.
- It isolates agent execution in per-issue workspaces so agent commands run only inside
  per-issue workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and
  runtime settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs across
  many repositories.

Important boundaries:

- Symphony is a scheduler, analyzer, and runner — and a tracker reader.
- Ticket writes (state transitions, comments, PR links) are performed by the coding agent using
  Archon workflow steps.
- A successful run can end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.
- The federated registry — assembled from all registered repositories' `symphony.md` documents
  — is the single source of truth for system topology. All issue routing decisions derive from it.

### 1.1 Why a Federated Registry

Earlier drafts of this specification used a centralized **Architecture Knowledge Base** document
(`ARCH.md`) maintained by the Symphony operator. That model has the following limitations:

- **Single ownership bottleneck.** All teams routed architectural changes through one document
  owned and maintained by the Symphony operator. Teams could not describe their own service
  without external coordination.
- **Drift-prone.** The centralized document was not co-located with the code it described. When
  a service evolved, its `ARCH.md` entry drifted silently.
- **Scaling wall.** As the number of registered services grew, the centralized document became
  harder to maintain accurately.

This specification replaces the centralized `ARCH.md` with a **federated registry model**:

- The operator maintains a **Source Registry** — a minimal list of repository URLs and default
  branches in `WORKFLOW.md`. This is the only centrally owned artifact.
- Each registered repository provides a **`symphony.md`** document at its root — the
  repository's authoritative self-description for the Symphony system.
- Symphony operates a **Repo Syncer** that clones all registered repositories into a configured
  **Base Folder**, detects changes via commit SHA, and materializes a **Synced Registry** from
  the fetched `symphony.md` documents.
- The **Repo Registry Loader** reads the Synced Registry and produces a `RegistryContext` —
  the runtime data structure consumed by the Issue Analyzer and prompt renderer in place of
  the legacy `ArchitectureContext`.

---

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Analyze each issue using Claude against the Architecture Knowledge Base before dispatch.
- Route issues to one or more repositories based on Claude analysis of the federated registry.
- Create deterministic per-issue, per-repository workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker-label-driven restart recovery without requiring a persistent database.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane (OPTIONAL extension allowed; see Section 13.7).
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That logic lives in
  Archon workflow YAML files.)
- Mandating strong sandbox controls beyond what Archon and the host OS provide.
- Replacing Archon's own internal workflow orchestration. Symphony orchestrates *which* Archon
  workflows run for *which* issue on *which* repo; Archon owns the internal step execution.

---

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Repo Registry Loader`
   - Reads `registry.synced.yaml` from the configured **Base Folder**.
   - Deserializes it into a `SyncedRegistry` data structure.
   - Returns a `RegistryContext` (the federated equivalent of the legacy `ArchitectureContext`;
     see Section 4.1.4) to the Issue Analyzer and prompt renderer.
   - Watches `registry.synced.yaml` for file changes and hot-reloads when the Repo Syncer
     writes an updated version.
   - On hot-reload, invalidates `analysis_cache` (all cached analyses reference the old context).
   - MUST NOT crash the service on a malformed `registry.synced.yaml`; keep operating with
     the last known good `RegistryContext` and emit an operator-visible error.

4. `Repo Syncer`
   - Long-running component that runs on a configurable cadence alongside the orchestrator's
     poll loop.
   - Clones repositories listed in the Source Registry but not yet present in the Base Folder.
   - Detects changes by comparing the remote default-branch commit SHA against the stored SHA
     in the Synced Registry.
   - Pulls and re-parses each repository's `symphony.md` when a change is detected.
   - Writes the updated Synced Registry to disk atomically.
   - Reports per-repository sync errors (parse failures, missing files, name collisions, network
     errors) without crashing the service.
   - See Section 6.6 for the full protocol.

5. `Issue Analyzer`
   - Accepts a normalized issue and the current `RegistryContext`.
   - Calls Claude (using the Anthropic SDK) with the registry context and the issue description.
   - Returns an `IssueAnalysis`: a list of `RepoTarget` records, each containing the target
     repo URL/local path and the recommended Archon workflow name.
   - Analysis failures are surfaced as configuration errors; they do not silently fall back.

6. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.

7. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.
   - Coordinates multi-repo dispatch: one issue can produce N simultaneous repo workers.

8. `Workspace Manager`
   - Maps issue identifiers + repo slugs to workspace paths.
   - Ensures per-issue, per-repo workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

9. `Archon Workflow Executor` (replaces Codex app-server client)
   - Syncs the base checkout for this repo to the latest main branch.
   - Builds the issue message string and selects the Archon workflow name.
   - Launches `archon workflow run <workflow> --cwd <checkout> "<message>"`.
   - Detects gate-pause events from Archon stderr and bridges them to Linear.
   - Streams Archon execution events back to the orchestrator.

10. `Status Surface` (OPTIONAL)
    - Presents human-readable runtime status (terminal output, dashboard, or other
      operator-facing view).

11. `Logging`
    - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port and reason about when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body and front matter (Symphony project repo).
   - `symphony.md` per-repo self-description (each registered repository).
   - Archon workflow YAML files (live inside each target repository, plus
     Symphony-managed templates synced into every repo).

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Sync Layer` (Source Registry → Synced Registry)
   - Repo Syncer clones registered repositories, watches commit SHAs,
     parses each repo's `symphony.md`, and writes the merged Synced Registry.

4. `Analysis Layer` (issue → registry → repo targets)
   - Claude-powered semantic analysis of issue against the federated `RegistryContext`.
   - Produces routing decisions: which repos, which Archon workflows.

5. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.
   - Multi-repo fan-out for a single issue.

6. `Execution Layer` (workspace + Archon subprocess)
   - Filesystem lifecycle, repo sync, Archon workflow invocation.

7. `Integration Layer` (Linear adapter)
   - API calls and normalization for tracker data.

8. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (Linear for `tracker.kind: linear` in this specification version).
- Anthropic API for issue analysis (Claude model — see Section 4.1.9).
- Local filesystem for workspaces, the Base Folder (Synced Registry + repo checkouts), and logs.
- Git CLI (required; workspace population clones/syncs repositories; Repo Syncer also relies on
  it for `git clone` and `git pull --ff-only`).
- `gh` CLI in the PATH (required; the Repo Syncer uses
  `gh api repos/{owner}/{repo}/commits/{branch} --jq '.sha'` to detect remote changes
  cheaply, and shares its credential helper for git operations. The CLI commands also
  use `gh repo view ... --json defaultBranchRef` for `symphony repo add` default-branch
  probing, and `gh pr list --head <branch> --repo <owner>/<repo> --state all --json url`
  for `symphony repo scaffold` PR URL resolution — see Section 21).
- Archon CLI (`archon`) available in the PATH of each workspace host.
- Host environment authentication: issue tracker, Anthropic API, GitHub (`gh auth login` or
  `GH_TOKEN`).
- The Base Folder configured via `registry.base_folder` (see Sections 5.3 and 11). The Source
  Registry is read from `WORKFLOW.md` front matter; the Synced Registry is materialized at
  `<base_folder>/registry.synced.yaml`.

### 3.4 Adapter Architecture and Extension Points (Recommended)

Symphony's reference configuration uses Linear as the issue tracker and Archon as the
workflow executor. The specification is written against those concrete backends so that
the contracts (Section 12 for the tracker, Section 11 for the executor) are unambiguous.

For long-term maintainability and to allow alternate backends (for example, replacing
Linear with GitHub Issues or Jira, or replacing Archon with a direct Claude SDK loop),
implementations SHOULD organize the codebase around the adapter boundaries below.

These are **non-functional structural recommendations**: they do NOT change what
Symphony does, only how implementations are layered. None of them are REQUIRED for
conformance. A conformant Symphony MAY hard-code Linear and Archon as the only supported
backends. Implementations that DO support alternate backends MUST still satisfy the
operational contracts in Sections 11, 12, and 17 — adapter swapping is not a license to
drift from observable behavior.

#### 3.4.1 General Principles

- Keep tracker I/O behind the operations defined in Section 12. The orchestrator,
  worker, and reconciler SHOULD NOT issue Linear GraphQL calls directly outside the
  adapter module.
- Keep workflow execution behind a single Workflow Executor module whose surface mirrors
  Section 11. Spawning a subprocess, parsing stderr for the `approval_pending` signal,
  and calling `archon workflow approve|reject` SHOULD be confined to that module so that
  swapping in a non-Archon backend means replacing one module rather than threading new
  branches through the orchestrator.
- Keep issue analysis behind an Analyzer module whose input is a `RegistryContext` plus
  an `Issue` and whose output is a structured `IssueAnalysis` (Section 4.1.5). The
  prompt template, model selection, and HTTP transport are internal to the analyzer.
- Keep persistence (if any) behind a Storage module. Symphony's reference
  implementation persists to flat files (`WORKFLOW.md`, `registry.synced.yaml`,
  `scaffold_jobs.yaml`); implementations that add a database (for example SQLite for
  analysis cache, retry queues, and supervised-gate bookkeeping — see Section 19.2)
  SHOULD route all reads and writes through the same module so the storage choice can
  evolve without disturbing the orchestrator.
- Cross-adapter behavior (for example, multi-repo fan-out, gate state transitions,
  retry/backoff) MUST live in the orchestrator, not in adapters. Adapters SHOULD be
  thin: protocol translation and authentication, not orchestration logic.

#### 3.4.2 Adapter Contracts (Reference)

Each adapter SHOULD expose a stable in-process interface in the implementation language
of choice. The operation lists below are conceptual; signatures are
implementation-defined.

**Issue Tracker Adapter** — see Section 12.1 for the canonical operation list. New
`tracker.kind` values (for example `github`, `jira`) SHOULD implement the same ten
operations. Where the underlying tracker has no native equivalent (for example, GitHub
Issues lacks first-class sub-issues), the adapter SHOULD document the chosen mapping
(linked issue, task list checkbox, child issue via projects) in its module-level
comments and in operator-facing documentation. Symphony's orchestrator SHOULD consume
only the abstract operations and remain ignorant of the concrete tracker.

**Workflow Executor Adapter** — Archon is the reference. A non-Archon executor SHOULD
expose at least:

- `start_run(workflow_name, cwd, user_message, options) → handle` — launches the
  agent run; returns an opaque handle (Archon's run id; analogous identifier elsewhere)
  and any process metadata needed for cancellation.
- `stream_events(handle) → AsyncIterator<ExecutorEvent>` — yields the events Symphony
  consumes today: node started/completed/failed, gate paused (with message and
  optional run id), workflow completed/failed/cancelled. The shape MUST match Section
  11.4 closely enough that the orchestrator's event handler (Section 17.6) is reusable.
- `approve(handle, comment)` / `reject(handle, reason)` — resume or terminate a paused
  gate. Backends without a native gate primitive SHOULD synthesize one (for example,
  by suspending an in-process Claude SDK loop on a promise that the adapter resolves
  on approval).
- `abandon(handle)` — terminate a running execution.
- `status(handle) → ExecutorStatus` — for snapshot endpoints and CLI status surfaces.

The orchestrator never calls `archon workflow run` directly outside the executor
module; analogously a Claude-SDK-based executor never bleeds prompt-engineering
details into the orchestrator.

**Analyzer Adapter** — Claude via Anthropic is the reference. A non-Claude analyzer
SHOULD accept `(issue, registry_context) → IssueAnalysis` (Section 4.1.5) with the
same structured output (`repo_targets`, `summary`, `confidence`, `notes`). Backends
that need a different prompt strategy SHOULD remain swappable without forcing changes
to Section 7.2 (Issue Analysis Protocol).

**Storage Adapter** — file-based is the reference. The CLI commands in Section 21
write `WORKFLOW.md`, `registry.synced.yaml`, and `scaffold_jobs.yaml` through this
module. Implementations adding SQLite (or another store) for transient orchestration
state SHOULD keep the source-of-truth files (`WORKFLOW.md`, `registry.synced.yaml`)
file-based regardless, because operators inspect and edit them out of band.

#### 3.4.3 Conformance Scope

Conformance to this specification (Section 19.1) is defined against:

- `tracker.kind: linear`
- Archon as the workflow executor (`archon workflow run`, with the gate semantics in
  Section 11.3.1)
- Claude via the Anthropic API as the analyzer

Implementations MAY ship additional adapters as **extensions** (Section 19.2). Such
extensions are conformant only when the implementation also retains a working
Linear+Archon path — the test matrix in Section 18 is defined against the reference
backends.

---

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `SYM-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current tracker state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:
- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- Archon executable path and default workflow
- workspace hooks
- Registry Base Folder path

#### 4.1.4 Registry Context

The `RegistryContext` is the runtime data structure assembled by the Repo Registry Loader
from the Synced Registry (see Sections 6.5 and 6.6). It is passed to the Issue Analyzer and
prompt renderer in place of the legacy `ArchitectureContext` from earlier drafts.

Top-level fields:

- `repositories` (list of `RegistryRepo`)
  - Only repositories with `sync_status: ok` are included.
  - Repositories with `sync_status: error` or `sync_status: missing_symphony_md` are excluded
    from the context but remain visible in operator logs and the OPTIONAL status snapshot.

- `components` (flattened list of all components across all `ok` repositories)
  - Each entry includes its parent repository's `name`, `url`, and `local_path` so the
    analyzer prompt and the Workspace Manager can resolve it cross-repository.

- `last_synced_at` (timestamp)
  - The `synced_at` value from `registry.synced.yaml`.

- `warnings` (list of strings)
  - Operator-visible warnings carried in the context: missing `symphony.md` repositories,
    unresolvable `communicates_with` references, name collisions, etc.

`RegistryRepo` fields:

- `name` (string) — repository alias from `symphony.md` front matter.
- `url` (string) — git remote URL from the Source Registry entry.
- `local_path` (string) — absolute path to the base checkout under `<base_folder>/repos/`.
- `description` (string) — repository's one-to-three-sentence summary.
- `default_workflow` (string) — Archon workflow name to invoke when this repository is
  selected as a `RepoTarget`. Format: `symphony/<workflow-name>`.
- `available_workflows` (list of strings) — all Archon workflows the repository advertises.
- `components` (list of component records) — see component schema in Section 5.4.2.
- `narrative` (string) — full Markdown body of the repository's `symphony.md` (after the
  closing `---` of the front matter), passed verbatim to the Issue Analyzer for richer
  semantic understanding.

Each component record MUST include at minimum:
- `name` (string): globally unique component name across all registered repositories.
- `description` (string): free-text description used by the Issue Analyzer.

Component records MAY include `communicates_with` edges, `default_workflow` overrides, and
implementation-defined extension fields (`component_type`, `cluster`, `engine`, etc.).
Unknown fields are preserved verbatim so the Issue Analyzer prompt can include them. The
canonical taxonomy of `component_type` values is provided as guidance in Appendix A.

#### 4.1.5 Issue Analysis

Result produced by the Issue Analyzer for one issue.

Fields:

- `issue_id` (string)
- `analysis_summary` (string)
  - Claude's reasoning about which services/repos are affected and why.
- `repo_targets` (list of `RepoTarget`)

`RepoTarget` fields:
- `repo_url` (string)
  - Git remote URL or registered repo alias for the target repository.
- `repo_alias` (string)
  - Short human-readable name for logs and workspace naming. Sourced from the
    matched `RegistryRepo.name` (the `symphony.md` front matter `name` field).
- `local_path` (string)
  - Absolute path to the base checkout for this repository.
  - Sourced from `RegistryRepo.local_path` in the `RegistryContext`.
  - The Archon Workflow Executor uses this path as the base checkout directory
    (`--cwd <local_path>`) instead of deriving it from the workspace root.
- `archon_workflow` (string)
  - Name of the Archon workflow to invoke for this repo (maps to a `.archon/workflows/`
    file inside the target repository, or a registered global workflow name).
- `rationale` (string)
  - Sentence from Claude explaining why this repo is included.
- `components` (list of strings)
  - Registry component names relevant to this repo target.
- `depends_on` (list of strings, OPTIONAL)
  - Sibling `repo_alias` values whose work MUST be ready before this target is
    dispatched. Used to model real-world build/deploy ordering between
    fan-out workers (e.g., a frontend that consumes new backend endpoints, or
    a service that consumes a freshly published shared library).
  - Default: empty list (no sibling dependencies).
  - Only meaningful within a single issue's fan-out — cross-issue dependencies
    are expressed via the tracker's native blocker relations (Section 9.2).
- `ready_when` (string, OPTIONAL)
  - When this target has `depends_on`, the readiness semantic to apply to
    each upstream sibling sub-issue.
  - Allowed values:
    - `"merged"` — upstream sub-issue is in `tracker.terminal_states`.
    - `"deployed"` — upstream sub-issue carries the deploy label for
      `tracker.default_ready_env` (resolved via `tracker.deploy_env_labels`).
    - `"deployed:<env>"` — upstream sub-issue carries the deploy label for
      the named environment (e.g., `deployed:staging`, `deployed:prod`).
  - Default: `"merged"`.

#### 4.1.6 Workspace

Filesystem workspace assigned to one issue identifier + repo alias pair.

Fields (logical):

- `checkout_path` (absolute path to `<workspace_root>/<repo_alias>/`)
- `repo_url` (string)
- `repo_alias` (string)
- `synced_at` (timestamp of last `git fetch origin && git reset --hard origin/main`)

#### 4.1.7 Run Attempt

One execution attempt for one issue + one repo target.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `repo_alias`
- `archon_workflow`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `checkout_path` (base checkout path used as `--cwd`)
- `started_at`
- `status`
- `error` (OPTIONAL)

#### 4.1.8 Live Session (Agent Session Metadata)

State tracked while an Archon subprocess is running for one issue+repo pair.

Fields:

- `session_id` (string, `<issue_identifier>__<repo_alias>__<attempt>`)
- `archon_pid` (string or null)
- `archon_workflow` (string)
- `last_archon_event` (string/enum or null)
- `last_archon_timestamp` (timestamp or null)
- `last_archon_message` (summarized payload)
- `claude_input_tokens` (integer)
- `claude_output_tokens` (integer)
- `claude_total_tokens` (integer)
- `turn_count` (integer)
  - Number of Archon workflow steps completed within the current run.

#### 4.1.9 Claude Model Configuration

The Anthropic Claude model is used in two distinct roles within Symphony:

1. **Issue Analyzer role**: Claude is called by the Issue Analyzer (the Symphony service itself,
   not Archon) to route issues to repos. This is a short, structured call.
2. **Archon agent role**: Claude is used internally by Archon during workflow step execution.
   Symphony does not directly control this; it is configured via Archon's own config.

For the Issue Analyzer role, Symphony MUST configure:
- `claude.analyzer_model` (string): Anthropic model ID (example: `claude-sonnet-4-5`).
- `claude.api_key` (string or `$VAR`): Anthropic API key.
- `claude.analyzer_max_tokens` (integer): max output tokens for analysis calls. Default: `1024`.
- `claude.analyzer_timeout_ms` (integer): timeout for each analysis API call. Default: `30000`.

#### 4.1.10 Retry Entry

Scheduled retry state for one issue + repo alias pair.

Fields:

- `issue_id`
- `repo_alias`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.11 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator. **Linear labels are the durable
source of truth for orchestration state** (see Section 12.4). In-memory state is a cache
rebuilt from Linear on every startup. Within a running process, the in-memory state is
authoritative for dispatch decisions; Linear labels serve as the durable record that survives
restarts.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `<issue_id>__<repo_alias> -> running entry`)
  - Each entry includes `sub_issue_id` (Linear issue ID or null) — set when Symphony created
    a sub-issue for this worker at dispatch time; null for single-repo issues.
  - Rebuilt from Linear on startup by reading issues/sub-issues carrying `symphony:running`.
- `claimed` (set of issue IDs that have at least one dispatched or pending repo target)
  - Rebuilt from Linear on startup by reading parent issues carrying `symphony:claimed`.
- `pending_targets` (map `issue_id -> list of RepoTarget`; un-dispatched targets from
  partially fan-out issues; populated on first analysis, drained as slots become available)
  - Rebuilt from Linear on startup by reading sub-issues carrying `symphony:queued` and
    re-running analysis for their parent issue to recover full `RepoTarget` records.
- `supervised_gates` (map `<issue_id>__<repo_alias> -> gate entry`)
  - Bookkeeping for workflows paused at a `loop.interactive` or `approval` gate.
  - Each entry: `{run_id, paused_at, gate_message, comment_id, sub_issue_id, gate_state_applied}`.
    - `run_id`: Archon workflow run UUID, captured from stderr.
    - `comment_id`: Linear comment ID of Symphony's posted gate message.
    - `sub_issue_id`: copied from the worker's running entry; gate comment is posted here
      when non-null, otherwise on the parent issue.
    - `gate_state_applied` (boolean): `true` when Symphony successfully transitioned the
      issue to `tracker.gate_waiting_state` on pause; consulted on resolve so the
      restoration to `tracker.gate_resume_state` is only attempted when the original
      transition succeeded (Sections 11.3.1, 17.2).
  - Symphony polls `fetch_issue_comments` to detect human responses and calls
    `archon workflow approve <run_id> --comment "<text>"` or `archon workflow reject <run_id>`.
  - Entry removed when Archon resumes and exits (success or failure).
  - Workers in this map do NOT consume a concurrency slot (see Section 9.3).
- `retry_attempts` (map `<issue_id>__<repo_alias> -> RetryEntry`)
- `completed` (set of `<issue_id>__<repo_alias>` keys; bookkeeping only — also used as
  the "merged" readiness fallback when `tracker.create_sub_issues: false`)
- `analysis_cache` (map `issue_id -> IssueAnalysis`; cached per issue until issue state changes)
- `sibling_subissues` (map `issue_id -> map<repo_alias, sub_issue_id>`; populated when
  Section 12.2 sub-issues are created; consulted by the readiness predicate, Section 17.4.1)
- `subissue_snapshot` (map `sub_issue_id -> {state, labels, refreshed_at}`; refreshed in
  Section 9.5 Part C)
- `claude_totals` (aggregate tokens + runtime seconds)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use for human-readable logs and workspace naming.
- `Repo Alias`
  - Short slug derived from the repository name; normalized with `[A-Za-z0-9._-]` characters
    only; used for workspace naming and session IDs.
- `Workspace Key`
  - Derive from `<issue.identifier>__<repo_alias>` by replacing any character not in
    `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Session ID`
  - Compose as `<issue_identifier>__<repo_alias>__<attempt>`.
- `Normalized Issue State`
  - Compare states after `lowercase`.

---

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Two policy artifacts are owned by the Symphony operator and live in the Symphony project
directory; the per-repository policy artifact lives at the root of each registered repository.

**`WORKFLOW.md`** — the Symphony service's runtime contract. Path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

**Source Registry** — the operator-maintained list of repositories Symphony tracks. It is
defined inline in `WORKFLOW.md` front matter under the top-level `repositories` key (see
Section 5.3.10). Symphony does NOT read `ARCH.md` — earlier drafts of this specification used
`ARCH.md` as a centralized Architecture Knowledge Base, but the federated registry model
replaces it.

**`symphony.md`** — each registered repository provides one of these at its root. It is
fetched by the Repo Syncer (Section 6.6), parsed, and merged into the Synced Registry. See
Section 5.4 for the schema.

**Synced Registry** — `<base_folder>/registry.synced.yaml`, owned and written exclusively by
the Repo Syncer. The Repo Registry Loader reads this file. It MUST be treated as read-only
by all other components and by operators (do NOT hand-edit it). See Section 6.5.

Loader behavior:

- If `WORKFLOW.md` cannot be read, return `missing_workflow_file`.
- If the Synced Registry cannot be read AND no usable cached version exists, abort startup
  with a clear operator-visible error.
- A repository's `symphony.md` parse failures are recorded as per-repo `sync_status: error`
  entries in the Synced Registry; they do NOT block startup or the rest of the system.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter. The front matter carries
all runtime configuration including the Source Registry. The Markdown body is the prompt
template used by the Issue Analyzer.

Returned workflow object:
- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

`symphony.md` (per registered repository) is a Markdown file with REQUIRED YAML front matter.
The front matter is consumed by the Repo Syncer; the Markdown body is preserved verbatim as
the repository's `narrative` and is fed to the Issue Analyzer as semantic context. See
Section 5.4 for the full schema.

### 5.3 Front Matter Schema (`WORKFLOW.md`)

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `archon`         ← replaces `codex`
- `claude`
- `workflow_templates`
- `registry`       ← Base Folder + sync configuration (Section 5.3.9)
- `repositories`   ← Source Registry (Section 5.3.10)

Unknown keys SHOULD be ignored for forward compatibility.

**Removed keys (compared with the legacy `SPEC_SONNET.md` draft):** `architecture.*` is no
longer supported. `architecture.path` and `architecture.reload_on_change` are obsolete because
the registry is no longer assembled from a single file. `architecture.analysis_cache_ttl_ms`
has been moved to the equivalent `registry.analysis_cache_ttl_ms` field for symmetry; cache
invalidation now triggers on Synced Registry change rather than `ARCH.md` change.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - Current supported value: `linear`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - MAY be a literal token or `$VAR_NAME`.
  - Canonical environment variable for `tracker.kind == "linear"`: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - REQUIRED for dispatch when `tracker.kind == "linear"`.
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`
- `assigned_to_me` (boolean, OPTIONAL)
  - Default: `true`
  - When `true`, Symphony fetches only issues assigned to the authenticated API key owner.
    On startup, Symphony resolves the viewer's identity via `{ viewer { id } }` and caches
    the result. `fetch_candidate_issues()` then filters to that user ID automatically.
  - When `false`, Symphony processes all issues in the project matching `active_states`,
    regardless of assignee. Use this for a shared/team-wide Symphony instance.
- `create_sub_issues` (boolean, OPTIONAL)
  - Default: `true`
  - When `true` and an issue fans out to **more than one** repo, Symphony creates one Linear
    sub-issue per repo worker at dispatch time. Each sub-issue title is
    `[<repo_alias>] <parent title>`. Single-repo issues are never given sub-issues.
  - Sub-issues are assigned to the same user as the parent and start in `In Progress`.
  - Gate pause comments and PR links are posted on the sub-issue, not the parent, when a
    sub-issue exists for that worker.
  - When `false`, Symphony only interacts with the parent issue regardless of fan-out width.
  - **Required for `RepoTarget.ready_when: deployed*`**: dependency readiness checks
    rely on observing sub-issue labels. With sub-issues disabled, only `ready_when:
    merged` is observable (via the orchestrator's in-memory `completed` set).
- `default_ready_env` (string, OPTIONAL)
  - Default: `"dev"`
  - The environment a `RepoTarget.ready_when: "deployed"` resolves to when the
    target does not specify an explicit env via `"deployed:<env>"` syntax.
  - This is the most-common case — most fan-out work can be validated against
    a `dev` deploy of upstream changes.
- `deploy_env_labels` (map `env_name -> label_name`, OPTIONAL)
  - Maps environment names to the Linear label that signals "this issue's
    change is deployed to that environment".
  - Default:
    ```yaml
    dev:     "deployed:dev"
    staging: "deployed:staging"
    prod:    "deployed:prod"
    ```
  - These labels are applied to the sub-issue (or to the parent issue when no
    sub-issue exists) by your CI/CD pipeline. See Section 7.5 for the
    recommended GitHub Action pattern.
  - Symphony only READS these labels; it never writes them. (Symphony's own
    label writes are limited to status labels like `symphony:waiting-human`.)
- `blocker_satisfied_states` (list of strings, OPTIONAL)
  - Default: empty list.
  - Workflow state names (in addition to `terminal_states` and the deploy
    labels) that count as "blocker satisfied" for the purposes of dispatch
    eligibility. Use this when your team has explicit `Deployed` or
    `Released` workflow states rather than (or alongside) deploy labels.
- `blocker_default_readiness` (string, OPTIONAL)
  - Default: `"deployed"`
  - The readiness semantic to apply to **cross-issue** Linear blockers
    (`blocked_by` relations) at dispatch time. Allowed values are the same
    as `RepoTarget.ready_when`:
    - `"merged"` — blocker reaches `terminal_states` (legacy behavior).
    - `"deployed"` — blocker carries the `default_ready_env` label.
    - `"deployed:<env>"` — blocker carries the named env label.
  - Rationale: a human-declared blocker almost always means "I need that
    change to be live, not just merged." The default reflects that.
  - To preserve the legacy "merged is enough" behavior, set `"merged"`.

- `gate_waiting_state` (string, OPTIONAL)
  - Default: `null` (disabled — behavior unchanged from the label-only flow).
  - The Linear workflow state name to move the issue into when an Archon supervised gate
    pauses. Example: `"Waiting for Review"`. The transition makes the gate visible on the
    Linear board instead of leaving the issue in `In Progress` with only a label.
  - Targeting follows the same sub-issue rule used for labels and comments
    (Section 12.2): the call is made on the sub-issue when one exists, otherwise on the
    parent issue.
  - **Constraint**: this state MUST NOT appear in `tracker.active_states`. If it did, the
    issue would re-surface in `fetch_candidate_issues()` and could be re-analyzed on the
    next tick. The `symphony:claimed` label guard already prevents re-dispatch in that
    scenario, but operators SHOULD configure a state that lives outside `active_states` —
    a true "parked" lane on the board. Startup validation MUST emit a warning if
    `gate_waiting_state` is found in `active_states` (Section 6.3).
  - When `null`, no state transition occurs; gate behavior is the legacy
    "label + comment only" flow.

- `gate_resume_state` (string, OPTIONAL)
  - Default: the first value of `tracker.active_states` (typically `"In Progress"`).
  - The Linear workflow state to restore when a gate is resolved (human approves, human
    rejects, or `archon.gate_timeout_ms` elapses). Only consulted when
    `gate_waiting_state` is set.
  - The transition runs BEFORE Archon resumes (on approve) or BEFORE the retry is
    scheduled (on reject/timeout), so the issue is back in an active lane by the time
    the worker re-enters `state.running`.

- `symphony_labels` (object, OPTIONAL)
  - Configures the Linear label names Symphony uses as its durable state machine.
    Override only if these names conflict with existing labels in your Linear workspace.
  - Fields (all OPTIONAL; defaults shown):
    - `claimed` (string) — applied to the parent issue when Symphony claims it.
      Default: `"symphony:claimed"`.
    - `queued` (string) — applied to a sub-issue (or parent for single-repo) when its
      repo target is analyzed but waiting for a concurrency slot or sibling readiness.
      Default: `"symphony:queued"`.
    - `running` (string) — applied to a sub-issue (or parent for single-repo) immediately
      before Archon is launched. Removed when the worker exits.
      Default: `"symphony:running"`.
    - `waiting_human` (string) — applied when an Archon gate pause requires human input.
      Removed when the gate is resolved. Default: `"symphony:waiting-human"`.
  - All four labels MUST exist in the Linear workspace before Symphony starts, or Symphony
    MUST create them on startup (implementations SHOULD create them automatically).
  - Symphony is the sole writer of these labels. Operators MUST NOT manually apply or
    remove symphony state labels; doing so will corrupt the orchestrator's recovered state.

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `~/symphony_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.3.4 `hooks` (object)

Fields:

- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each Archon attempt, in the base checkout directory.
  - Use for syncing, environment setup, or pre-flight checks.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each Archon attempt (success, failure, timeout, or cancellation).
  - Use for cleanup, e.g., `archon isolation cleanup --merged`.
  - Failure is logged but ignored.
- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all hooks.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Note: each repo target for a single issue counts as one agent slot.
  - Changes SHOULD be re-applied at runtime.
- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of Archon workflow execution loops (for loop-based workflows).
- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.

#### 5.3.6 `archon` (object)

Archon-specific configuration. Replaces the `codex` section of the base Symphony specification.

Fields:

- `command` (string shell command)
  - Default: `archon workflow run`
  - Full Archon CLI subcommand. Change only if your Archon installation uses a different path.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Maximum time to wait for one complete Archon workflow run.
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If no stderr output is produced by Archon for this duration, the run is considered stalled
    and will be killed and retried.
  - If `<= 0`, stall detection is disabled.
- `default_workflow` (string, OPTIONAL)
  - Fallback Archon workflow name when the Issue Analyzer does not recommend a specific
    workflow for a given repo target.
  - Default: `symphony/symphony-fix-issue`
  - The `symphony/` prefix is resolved to `.archon/workflows/symphony/` in the base checkout.
    Omit the prefix to reference a repo-owned workflow in `.archon/workflows/` directly.
- `gate_timeout_ms` (integer)
  - How long a supervised gate may stay in `state.supervised_gates` before Symphony auto-rejects.
  - After timeout: Symphony calls `archon workflow reject <run_id> --reason "timeout"` and
    schedules a normal retry.
  - Default: `0` (disabled — gates wait indefinitely).
  - Recommended: `86400000` (24 hours) for async teams.

#### 5.3.7 `claude` (object)

Claude configuration for Symphony's own Issue Analyzer calls.

Fields:

- `api_key` (string or `$VAR`)
  - Canonical environment variable: `ANTHROPIC_API_KEY`.
- `analyzer_model` (string)
  - Anthropic model ID used for issue analysis.
  - Default: `claude-sonnet-4-5`
- `analyzer_max_tokens` (integer)
  - Default: `1024`
- `analyzer_timeout_ms` (integer)
  - Default: `30000`

#### 5.3.8 `workflow_templates` (object)

Symphony is the single source of truth for the Archon workflow YAML files that its agents
run. These are stored in Symphony's own directory and synced into each registered repo's
`.archon/workflows/symphony/` before each Archon invocation.

This allows all repos to stay in sync — workflow changes are made once in Symphony's
`workflow_templates.path` folder and propagate automatically on the next dispatch.

Fields:

- `path` (path string or `$VAR`)
  - Directory containing Symphony-managed workflow YAML files.
  - Required. Relative paths are resolved relative to `WORKFLOW.md`.
  - Example: `workflow_templates/` (a folder next to `WORKFLOW.md`).
- `target_subdir` (string)
  - Subdirectory inside the repo's `.archon/workflows/` where Symphony writes its templates.
  - Default: `symphony`
  - Resulting path: `<checkout>/.archon/workflows/symphony/<template>.yaml`
  - Uses a subdirectory to avoid overwriting repo-owned workflows in `.archon/workflows/`.
- `sync_on_dispatch` (boolean)
  - When `true`, Symphony syncs the templates into the base checkout before every Archon run.
  - Default: `true`
  - Set to `false` only if you manually manage workflow deployment.
- `reload_on_change` (boolean)
  - When `true`, Symphony watches `path` for file changes and marks all base checkouts as
    needing re-sync on the next dispatch.
  - Default: `true`

**Workflow naming convention**: files in `workflow_templates.path` are named
`symphony-<purpose>.yaml` (e.g., `symphony-fix-issue.yaml`, `symphony-supervised.yaml`).
A repository's `default_workflow` (or per-component override in `symphony.md`) references
these names as `symphony/<name>`, which Archon resolves to
`.archon/workflows/symphony/<name>.yaml`.

**Sync semantics**: Symphony copies all `.yaml` files from `workflow_templates.path` into
`<checkout>/.archon/workflows/<target_subdir>/`. Existing files in the target directory are
overwritten. Files in the target directory that are NOT in `workflow_templates.path` are
left untouched (no deletions). The target directory is created if it does not exist.

#### 5.3.9 `registry` (object)

Federated registry configuration. Replaces the legacy `architecture` block from earlier
drafts.

Fields:

- `base_folder` (path string or `$VAR`, REQUIRED)
  - Absolute path to the Base Folder where Symphony stores cloned repositories and the
    Synced Registry (`registry.synced.yaml`).
  - `~` and `$VAR` expansion apply.
  - MUST NOT be inside the Symphony project directory (the directory containing
    `WORKFLOW.md`). Implementations MUST error at startup if the resolved path falls inside
    the Symphony project directory.
  - The Repo Syncer creates `<base_folder>/` and `<base_folder>/repos/` if they do not exist.

- `sync_interval_ms` (integer, OPTIONAL)
  - How often the Repo Syncer runs a sync pass, in milliseconds.
  - Default: `900000` (15 minutes).
  - Set to `0` to disable scheduled sync (sync only on startup).

- `sync_on_startup` (boolean, OPTIONAL)
  - When `true`, the Repo Syncer runs a full sync pass before the orchestrator begins
    dispatching. Blocks dispatch until the first pass completes.
  - Default: `true`.
  - Setting to `false` is NOT RECOMMENDED for production; the Synced Registry may be stale
    or absent.

- `analysis_cache_ttl_ms` (integer, OPTIONAL)
  - How long to cache an `IssueAnalysis` result for a given issue without re-analyzing.
  - Default: `300000` (5 minutes).
  - Set to `0` to disable caching (re-analyze on every tick).
  - Cache invalidation also triggers automatically when the Synced Registry is rebuilt
    (`RegistryContext` change).

#### 5.3.10 `repositories` (list — Source Registry)

The operator-maintained declaration of which repositories Symphony tracks. Defined as a
top-level list in `WORKFLOW.md` front matter; loaded by the Config Layer as part of the
standard configuration resolution pipeline (Section 6.1).

The Source Registry contains only the minimal facts needed to locate and clone a repository;
all rich architectural description lives in each repository's own `symphony.md`.

```yaml
repositories:
  - url: https://github.com/org/patient-ingestion-service   # REQUIRED
    default_branch: main                                     # REQUIRED

  - url: https://github.com/org/infra-terraform
    default_branch: main

  - url: https://github.com/org/shared-auth-lib
    default_branch: main
```

Fields per entry:

- `url` (string, REQUIRED)
  - The HTTPS git remote URL for the repository.
  - MUST be a valid GitHub HTTPS URL. SSH URLs are not supported (the `gh` CLI API check
    requires HTTPS URL parsing to derive owner and repository name).
  - The repo slug used for the local clone directory is derived deterministically from this
    URL's last path segment, with any `.git` suffix stripped (example:
    `https://github.com/org/patient-ingestion-service` → `patient-ingestion-service`).
    Implementations MUST error at sync time if two registered repositories produce the same
    slug.

- `default_branch` (string, REQUIRED)
  - The branch to clone, track, and check for SHA changes.
  - The Repo Syncer always syncs this branch. Archon workflow execution may use worktrees
    on other branches; those are managed by Archon, not by the Repo Syncer.

### 5.4 `symphony.md` Schema (Per-Repository Self-Description)

Each registered repository provides one `symphony.md` file at its root. It is the
repository's authoritative self-description for the Symphony system. The Repo Syncer
parses it on every sync pass when the remote SHA changes; the result is merged into the
Synced Registry and into the runtime `RegistryContext`.

The file consists of:

- **Front matter** — structured, machine-parseable metadata in YAML. Consumed by the Repo
  Syncer and the Repo Registry Loader.
- **Body** — free Markdown prose describing the repository's role in the broader system,
  consumed verbatim by the Issue Analyzer as semantic context.

#### 5.4.1 Front Matter — Required Fields

The front matter is a YAML document delimited by `---` markers at the top of `symphony.md`.
All fields are at the top level of the YAML map unless otherwise noted.

- `name` (string, REQUIRED)
  - Globally unique alias for this repository within the Symphony system.
  - Used in workspace naming, logs, `communicates_with` resolution, and name-collision
    detection.
  - MUST match the pattern `[a-z0-9][a-z0-9-]*[a-z0-9]` (lowercase alphanumeric and
    hyphens, not starting or ending with a hyphen).
  - MUST be unique across all repositories in the Source Registry. The Repo Syncer MUST
    error at sync time if two repositories declare the same `name` (see Section 6.7).

- `description` (string, REQUIRED)
  - One to three sentence summary of what this repository does and its role in the system.
  - Consumed by the Issue Analyzer and operator logs. Keep it dense and informative.

- `default_workflow` (string, REQUIRED)
  - The Archon workflow name to invoke when this repository is selected as a `RepoTarget`.
  - Format: `symphony/<workflow-name>` (example: `symphony/symphony-fix-issue`).

- `components` (list of component records, REQUIRED)
  - One or more components owned by this repository.
  - A repository MUST declare at least one component.
  - See Section 5.4.2 for the component record schema.

#### 5.4.1.1 Front Matter — Optional Fields

- `available_workflows` (list of strings, OPTIONAL)
  - All Archon workflow names available for this repository.
  - The Issue Analyzer MAY use this list to select a non-default workflow when the issue
    warrants it (for example, choosing `symphony/symphony-supervised` for complex changes).
  - If absent, Symphony treats `default_workflow` as the only available workflow.

#### 5.4.2 Component Record Schema

Each entry in the `components` list has:

- `name` (string, REQUIRED)
  - Globally unique component name across all registered repositories.
  - Used to resolve `communicates_with` references cross-repository.
  - MUST match `[a-z0-9][a-z0-9-]*[a-z0-9]`.
  - MUST be unique across all components in all registered repositories. The Repo Syncer
    MUST error at sync time on collision (see Section 6.7).

- `description` (string, REQUIRED)
  - What this component is and what it does within the system.
  - Include enough context for the Issue Analyzer to understand which issues affect it.

- `component_type` (string, OPTIONAL but RECOMMENDED)
  - Canonical taxonomy: `ecs_service`, `lambda`, `sqs_queue`, `eventbridge_bus`, `redshift`,
    `healthlake`, `rds`, `shared_lib`, `api_gateway`, `other`. See Appendix A.
  - Implementations MAY accept additional values; unknown values MUST be preserved verbatim
    so the Issue Analyzer prompt can include them.

- `communicates_with` (list of communication records, OPTIONAL, RECOMMENDED)
  - Describes how this component communicates with other components in the system.
  - Each communication record has:
    - `component` (string, REQUIRED) — name of the target component as declared in another
      (or the same) repository's `symphony.md`.
    - `method` (string, REQUIRED) — communication mechanism. Free-form string; examples:
      `sqs`, `http`, `grpc`, `eventbridge`, `kinesis`, `library`, `database`, `s3`.
    - `direction` (string, REQUIRED) — one of `produces`, `consumes`, `reads`, `writes`,
      `depends_on`, `bidirectional`.
  - The Repo Syncer validates that all referenced `component` names exist in the merged
    component set after all repositories are synced. Unresolvable references are recorded
    as sync warnings (not errors), since the referenced repository may not yet be
    registered.

- `default_workflow` (string, OPTIONAL)
  - Per-component workflow override. When present, the Issue Analyzer SHOULD prefer this
    workflow over the repository-level `default_workflow` when this specific component is
    the primary target of an issue.

Implementations MAY extend the component record with additional fields (e.g. `cluster`,
`engine`, `runtime`). Unknown fields MUST be preserved through the Synced Registry into
the `RegistryContext` so the analyzer prompt can include them.

#### 5.4.3 Example `symphony.md` Front Matter

```yaml
---
name: patient-ingestion-service
description: >
  Receives HL7 FHIR messages over HTTPS, validates them against schema rules,
  and publishes inbound events to downstream queues for further processing.
  Entry point for all patient data entering the system.
default_workflow: symphony/symphony-fix-issue
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/symphony-supervised
components:
  - name: patient-ingestion-api
    component_type: ecs_service
    description: >
      REST API surface that accepts FHIR payloads from external senders.
      Handles authentication, rate limiting, and initial schema validation
      before forwarding to the ingestion queue.
    communicates_with:
      - component: ingestion-queue
        method: sqs
        direction: produces
      - component: shared-auth-lib
        method: library
        direction: depends_on

  - name: ingestion-worker
    component_type: ecs_service
    description: >
      Background consumer that reads from the ingestion queue, performs
      deep FHIR R4 validation, and routes valid records to HealthLake.
    communicates_with:
      - component: ingestion-queue
        method: sqs
        direction: consumes
      - component: clinical-data-healthlake
        method: http
        direction: writes
---

# patient-ingestion-service

ECS service that ingests HL7 FHIR messages, validates them against HealthLake schemas,
and emits events to the ingestion SQS queue.

(Markdown narrative continues; used by Claude for richer semantic understanding.)
```

#### 5.4.4 Body (Markdown Prose)

The Markdown body following the closing `---` of the front matter is free-form prose. It is
passed verbatim to the Issue Analyzer as the `narrative` field of the `RegistryRepo` for
this repository.

The body SHOULD include:

- How the repository is assembled and deployed (topology, runtime environment).
- Which other repositories or external systems it depends on and why.
- What classes of issues or changes are likely to require work in this repository.
- Known constraints, cross-cutting concerns, or ripple-effect risks (for example: "changes
  to the authentication middleware in this repository affect all downstream service
  consumers").
- Anything the Issue Analyzer needs to route work to this repository correctly.

The body MAY be empty if the front matter alone provides sufficient context. However, a
rich body significantly improves Issue Analyzer accuracy for ambiguous issues.

### 5.5 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue, per-repo-target prompt template that
Symphony passes to Archon as issue context variables.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt. Integer on retry or continuation.
- `repo_target` (object)
  - The `RepoTarget` for this specific workspace/Archon run.
  - Includes `repo_url`, `repo_alias`, `archon_workflow`, `rationale`, `components`.
- `analysis` (object)
  - The full `IssueAnalysis` for this issue (includes `analysis_summary` and all `repo_targets`).

### 5.6 Workflow Validation and Error Surface

Error classes (extends base Symphony):

- `missing_workflow_file`
- `missing_synced_registry`
- `workflow_parse_error`
- `synced_registry_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error`
- `template_render_error`
- `issue_analysis_error` (Claude API call failed)
- `issue_analysis_no_targets` (analysis returned zero repo targets; treated as config error)
- `repo_sync_error` (per-repository — recorded inside the Synced Registry; not a service-wide
  error)

Dispatch gating behavior:

- `WORKFLOW.md` read/YAML errors block new dispatches until fixed.
- A missing or unparseable `registry.synced.yaml` AND no last-known-good context blocks all
  dispatches and aborts startup; a transient sync failure with last-known-good context in
  memory keeps dispatch running.
- A Synced Registry that has zero `sync_status: ok` repositories blocks dispatch (Section 6.3).
- Issue analysis failures block dispatch for the specific issue; other issues continue.
- A `RepoTarget` whose repository has `sync_status: error` or `missing_symphony_md` is
  skipped at dispatch time with a logged warning; sibling targets in the same `IssueAnalysis`
  continue.
- Template errors fail only the affected run attempt.

---

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection only for config values that explicitly contain `$VAR_NAME`.
5. Coerce and validate typed values.
6. Resolve `registry.base_folder` and verify it is not inside the Symphony project directory.
7. Create `<base_folder>/` and `<base_folder>/repos/` if they do not exist.
8. If `registry.sync_on_startup` is `true` (default), run a full Repo Syncer pass (blocking).
   - If `registry.synced.yaml` does not exist and no repositories can be synced, MUST error
     and abort startup with an operator-visible message.
   - If `registry.synced.yaml` does not exist but at least one repository syncs successfully,
     proceed.
   - If `registry.synced.yaml` exists from a previous run and the sync pass fails entirely
     (for example, no network), log a warning and continue with the last-known-good Synced
     Registry.
9. Load `registry.synced.yaml` via the Repo Registry Loader.
10. Validate that at least one repository has `sync_status: ok` and at least one component is
    present in the assembled `RegistryContext`. If not, MUST error and abort startup.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED for `WORKFLOW.md` and the Synced Registry:

- On `WORKFLOW.md` change, re-read and re-apply workflow config and the prompt template
  without restart.
- The Repo Registry Loader watches `registry.synced.yaml` for file changes. When the Repo
  Syncer writes an updated Synced Registry, the loader rebuilds the `RegistryContext`.
- On `RegistryContext` rebuild, the `analysis_cache` MUST be invalidated (all cached
  `IssueAnalysis` entries reference the old context).
- Per-repository `symphony.md` changes are observed indirectly: the Repo Syncer detects the
  remote SHA change on its next pass (Section 6.6) and rewrites the Synced Registry, which
  triggers the loader's hot reload.
- Invalid reloads MUST NOT crash the service; keep operating with the last-known-good
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

Validation checks performed before each tick's dispatch step:

- `WORKFLOW.md` can be loaded and parsed.
- `registry.base_folder` is configured, exists, and is not inside the Symphony project
  directory.
- `registry.synced.yaml` exists and is parseable.
- At least one repository in the Synced Registry has `sync_status: ok`.
- At least one component exists in the assembled `RegistryContext`.
- `gh` CLI is available in `PATH` (`gh --version` exits 0).
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution.
- `tracker.project_slug` is present when REQUIRED by the selected tracker kind.
- `archon.command` is present and non-empty.
- `claude.api_key` is present after `$` resolution.

Startup warnings (non-fatal, logged for operator awareness):

- If `tracker.gate_waiting_state` is set AND its value is also present in
  `tracker.active_states`, emit a warning: `gate_waiting_state "<name>" is also listed in
  active_states; gated issues will re-surface as dispatch candidates and rely solely on the
  symphony:claimed label to avoid re-dispatch — configure a state outside active_states for
  a true parked lane.`
- If `tracker.gate_resume_state` is set AND its value is NOT in `tracker.active_states`,
  emit a warning: `gate_resume_state "<name>" is not listed in active_states; resumed
  issues will not be picked up by dispatch until they leave that state.`

Dispatch gating:

- If the `RegistryContext` has zero components, all dispatches are blocked until the Repo
  Syncer resolves at least one repository.
- If a specific `RepoTarget` references a repository that has `sync_status: error` or
  `missing_symphony_md` at dispatch time, that specific target is skipped and a warning is
  logged. Other targets in the same `IssueAnalysis` continue.

### 6.4 Core Config Fields Summary (Cheat Sheet)

- `tracker.kind`: string, REQUIRED, currently `linear`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql` when `tracker.kind=linear`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY`
- `tracker.project_slug`: string, REQUIRED when `tracker.kind=linear`
- `tracker.active_states`: list of strings, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list of strings, default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `tracker.assigned_to_me`: boolean, default `true`; filter to authenticated user's issues only; `false` = all project issues
- `tracker.create_sub_issues`: boolean, default `true`; create one sub-issue per repo worker when fan-out > 1
- `tracker.default_ready_env`: string, default `"dev"`; env that `ready_when: "deployed"` resolves to
- `tracker.deploy_env_labels`: map of env→label, default `{dev: "deployed:dev", staging: "deployed:staging", prod: "deployed:prod"}`
- `tracker.blocker_satisfied_states`: list of strings, default `[]`; extra states that satisfy blocker/dependency checks alongside `terminal_states` and deploy labels
- `tracker.blocker_default_readiness`: string, default `"deployed"`; readiness semantic for cross-issue Linear blockers
- `tracker.gate_waiting_state`: string, default `null`; Linear state to move the issue into when an Archon supervised gate pauses (set to a parked lane outside `active_states`)
- `tracker.gate_resume_state`: string, default `tracker.active_states[0]` (typically `"In Progress"`); Linear state to restore when a gate is resolved; only used when `gate_waiting_state` is set
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path resolved to absolute, default `~/symphony_workspaces`
- `hooks.before_run`: shell script or null (runs in base checkout before Archon)
- `hooks.after_run`: shell script or null (runs in base checkout after Archon)
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `archon.command`: shell command string, default `archon workflow run`
- `archon.turn_timeout_ms`: integer, default `3600000`
- `archon.stall_timeout_ms`: integer, default `300000`
- `archon.default_workflow`: string, default `symphony/symphony-fix-issue`
- `archon.gate_timeout_ms`: integer, default `0` (disabled); auto-reject open gates after this many ms with no human reply
- `claude.api_key`: string or `$VAR`, canonical env `ANTHROPIC_API_KEY`
- `claude.analyzer_model`: string, default `claude-sonnet-4-5`
- `claude.analyzer_max_tokens`: integer, default `1024`
- `claude.analyzer_timeout_ms`: integer, default `30000`
- `workflow_templates.path`: path, REQUIRED; directory of Symphony-managed workflow YAML files
- `workflow_templates.target_subdir`: string, default `symphony`; subdirectory under `.archon/workflows/` in each repo
- `workflow_templates.sync_on_dispatch`: boolean, default `true`; sync before every Archon run
- `workflow_templates.reload_on_change`: boolean, default `true`; watch for changes and re-sync
- `registry.base_folder`: path or `$VAR`, REQUIRED; absolute path to the Base Folder (clones + Synced Registry); MUST be outside the Symphony project directory
- `registry.sync_interval_ms`: integer, default `900000` (15m); Repo Syncer cadence; `0` disables scheduled sync
- `registry.sync_on_startup`: boolean, default `true`; block dispatch until first sync completes
- `registry.analysis_cache_ttl_ms`: integer, default `300000` (5m); also invalidated automatically on Synced Registry change
- `repositories[].url`: string, REQUIRED per entry; HTTPS GitHub remote URL
- `repositories[].default_branch`: string, REQUIRED per entry; branch to clone, track, and SHA-check
- `tracker.symphony_labels.claimed`: string, default `"symphony:claimed"`
- `tracker.symphony_labels.queued`: string, default `"symphony:queued"`
- `tracker.symphony_labels.running`: string, default `"symphony:running"`
- `tracker.symphony_labels.waiting_human`: string, default `"symphony:waiting-human"`

### 6.5 Synced Registry Schema

The Synced Registry is a YAML file owned and written exclusively by the Repo Syncer.
Operators MUST NOT hand-edit it.

**File location**: `<base_folder>/registry.synced.yaml`

**Base Folder layout**:

```
<base_folder>/
  repos/
    <repo-slug>/        ← git clone of the registered repository
    <repo-slug>/
    ...
  registry.synced.yaml  ← Synced Registry; materialized by the Repo Syncer
```

`<repo-slug>` is derived deterministically from the repository URL: the last path segment
of the URL without the `.git` suffix (example:
`https://github.com/org/patient-ingestion-service` → `patient-ingestion-service`).

**Structure**:

```yaml
synced_at: "2026-05-09T12:00:00Z"    # timestamp of last full sync pass
repositories:
  - url: https://github.com/org/patient-ingestion-service
    default_branch: main
    slug: patient-ingestion-service
    local_path: /home/user/.symphony/repos/patient-ingestion-service
    last_synced_at: "2026-05-09T12:00:00Z"
    last_commit_sha: abc123def456
    sync_status: ok                    # "ok" | "error" | "missing_symphony_md"
    sync_error: null                   # error message string or null
    frontmatter:
      name: patient-ingestion-service
      description: >
        Receives HL7 FHIR messages...
      default_workflow: symphony/symphony-fix-issue
      available_workflows:
        - symphony/symphony-fix-issue
        - symphony/symphony-supervised
      components:
        - name: patient-ingestion-api
          component_type: ecs_service
          description: >
            REST API surface...
          communicates_with:
            - component: ingestion-queue
              method: sqs
              direction: produces
    narrative: |
      (full Markdown body of symphony.md, after front matter)

  - url: https://github.com/org/shared-auth-lib
    default_branch: main
    slug: shared-auth-lib
    local_path: /home/user/.symphony/repos/shared-auth-lib
    last_synced_at: "2026-05-09T11:45:00Z"
    last_commit_sha: 789xyz
    sync_status: missing_symphony_md
    sync_error: "No symphony.md found at repository root."
    frontmatter: null
    narrative: null
```

The Synced Registry is owned by the Repo Syncer. The Repo Registry Loader MUST treat it
as read-only.

### 6.6 Repo Syncer Protocol

The Repo Syncer runs on a configurable cadence (`registry.sync_interval_ms`) alongside the
orchestrator's poll loop. On startup it executes a blocking sync pass before the
orchestrator begins dispatching, unless `registry.sync_on_startup` is `false`.

**On each sync pass:**

1. For each entry in the Source Registry (`repositories[]` in `WORKFLOW.md`):
   a. If the repository is not yet cloned, clone it.
   b. Check the remote default-branch commit SHA via `gh` CLI.
   c. If the SHA matches the stored SHA in the Synced Registry, skip re-parse.
   d. If the SHA differs (or no stored SHA exists), run `git pull --ff-only` on the base
      checkout and re-read `symphony.md`.
   e. Parse the `symphony.md` front matter.
   f. Update the Synced Registry entry for this repository.
2. Validate global uniqueness of all `name` values (repository names) and all component
   `name` values across the merged set (see Section 6.7).
3. Write `registry.synced.yaml` atomically to disk.
4. The Repo Registry Loader's file watcher detects the write and triggers a hot reload
   of `RegistryContext`, which invalidates `analysis_cache`.

**`gh` and `git` commands used:**

Check remote SHA (read-only, no clone required):
```
gh api repos/{owner}/{repo}/commits/{branch} --jq '.sha'
```

Clone a repository (first time):
```
git clone --branch <default_branch> <url> <base_folder>/repos/<repo-slug>
```

Pull latest changes after SHA change detected:
```
git -C <base_folder>/repos/<repo-slug> pull --ff-only origin <default_branch>
```

Implementations MUST use `--ff-only` so non-fast-forward situations surface as sync errors
rather than silently force-resetting.

**Authentication:** The Repo Syncer relies on the ambient `gh` CLI authentication
(`gh auth login` or `GH_TOKEN` environment variable). No additional credential surface is
introduced. The same authentication is used for both the SHA check API call and git
operations (via `gh`'s credential helper).

**Sync pass failure modes:**

| Failure | Behavior |
|---|---|
| Repository unreachable (network error) | `sync_status: error`; last-known-good frontmatter retained; warn |
| `git pull --ff-only` fails (non-fast-forward) | `sync_status: error`; operator must resolve manually; warn |
| `symphony.md` present but YAML parse error | `sync_status: error`; last-known-good frontmatter retained; warn |
| `symphony.md` missing | `sync_status: missing_symphony_md`; repository excluded from context |
| Name collision (repo or component) | Losing repository `sync_status: error`; detailed error with fix suggestion (Section 6.7) |
| `gh` CLI not available | Abort startup with a clear error message |
| Two repositories produce the same slug | Abort sync pass; operator must rename one repository's URL or maintain the slug derivation manually |

### 6.7 Name Collision Handling

After each sync pass, the Repo Syncer MUST validate uniqueness across the merged set of
all successfully synced repositories:

1. **Repository name collision** — two `frontmatter.name` values are identical.
2. **Component name collision** — two component `name` values are identical across any
   repositories.

On collision, the Repo Syncer MUST:

- Set `sync_status: error` for the loser. The "winner" is the repository encountered first
  in Source Registry order; the "loser" is any subsequent repository that re-declares the
  same name.
- Set `sync_error` to a message that includes:
  - The collision type (`repository name` or `component name`).
  - The conflicting name.
  - The URL of the repository that is already using that name (the winner).
  - A suggested resolution: either rename the `name` field in the loser's `symphony.md`,
    or add an alias prefix.
- Emit an operator-visible log error with the same information.
- Exclude the loser's components from the `RegistryContext` passed to the Issue Analyzer.
  The winner's components are unaffected.

Example `sync_error` for a component name collision:

```
Component name collision: "ingestion-queue" is declared by both
"patient-ingestion-service" (https://github.com/org/patient-ingestion-service, winner)
and "legacy-ingestion" (https://github.com/org/legacy-ingestion, this repository).
Resolution: rename the component in legacy-ingestion/symphony.md to a unique name
(for example "legacy-ingestion-queue"), then commit and push to main.
```

### 6.8 Missing `symphony.md` Handling

When the Repo Syncer successfully clones or pulls a repository but finds no `symphony.md`
at the repository root:

1. Set `sync_status: missing_symphony_md` in the Synced Registry entry for that repository.
2. Emit an operator-visible warning:

   ```
   WARNING: Repository "patient-ingestion-service" has no symphony.md at its root.
   This repository will be excluded from issue analysis until a symphony.md is added.

   To create one manually: add symphony.md to the root of
   https://github.com/org/patient-ingestion-service and push to main.

   To generate one using Symphony: run
     symphony repo scaffold https://github.com/org/patient-ingestion-service
   This command launches an Archon workflow that inspects the repository and
   proposes a symphony.md draft for human review before committing.
   ```

3. Exclude the repository from the `RegistryContext` (and therefore from issue analysis
   and dispatch) until a `symphony.md` is added and synced.
4. On subsequent sync passes, re-attempt to find `symphony.md`. When found, parse it and
   update the Synced Registry entry to `sync_status: ok`.

#### 6.8.1 `symphony repo scaffold` Command (REQUIRED)

Conforming implementations MUST provide a `symphony repo scaffold <url>` CLI command that
generates a draft `symphony.md` for a registered repository by launching an Archon
workflow (`symphony/symphony-scaffold`) in the local checkout, opening a pull request
with the proposed `symphony.md` for human review.

The full command surface — blocking vs. async modes, scaffold job persistence
(`<base_folder>/scaffold_jobs.yaml`), the Archon run-ID resolution algorithm, PR URL
discovery, and auto-cleanup on successful sync — is specified in **Section 21.6**
(`symphony repo scaffold`) and **Section 21.7** (`symphony scaffold status`).

### 6.9 Migration from a Centralized `ARCH.md`

Operators migrating from an earlier `ARCH.md`-based deployment:

1. For each component entry in `ARCH.md`, identify the owning repository.
2. In each owning repository, create a `symphony.md` at the repository root. Populate:
   - `name`: the repository's primary component name or a short alias.
   - `description`: synthesized from the `ARCH.md` component descriptions.
   - `default_workflow`: from the `ARCH.md` `archon_workflow` field (or component-level
     override).
   - `components`: one entry per `ARCH.md` component that lists this repository as
     `repository`.
3. Add all repository URLs and default branches to the `WORKFLOW.md` `repositories` list.
4. Set `registry.base_folder` in `WORKFLOW.md`.
5. Run `symphony sync` (or restart Symphony with `sync_on_startup: true`) to populate the
   Synced Registry.
6. Verify the `RegistryContext` via `symphony status` or operator logs. Confirm all
   components appear and no name collisions exist.
7. Remove `architecture.path` and other `architecture.*` keys from `WORKFLOW.md` front
   matter and archive `ARCH.md`.

---

## 7. Issue Analysis and Repository Routing

### 7.1 Analysis Trigger

The Issue Analyzer is called when:

- An issue becomes dispatch-eligible for the first time (no cached analysis exists).
- The cached `IssueAnalysis` for the issue has expired (TTL exceeded).
- The `RegistryContext` has been rebuilt since the last analysis (cache invalidated when the
  Synced Registry is rewritten — see Section 6.2).

The analysis result is cached in orchestrator state under `analysis_cache[issue_id]` until
invalidation.

### 7.2 Issue Analysis Protocol

The Issue Analyzer calls the Anthropic API synchronously (within the dispatch cycle) before
routing the issue.

Input to Claude:
- The full `RegistryContext`: every `RegistryRepo` record (front matter + components) plus
  the verbatim Markdown narrative from each repository's `symphony.md` body.
- The normalized `issue` object: identifier, title, description, labels, blockers.
- A structured system prompt that instructs Claude to return a JSON `IssueAnalysis` object.

Required system prompt contract:
- Instruct Claude to identify which registry components are affected by the issue.
- Instruct Claude to map each affected component to its owning repository.
- Instruct Claude to select the most appropriate Archon workflow per repo (from the list of
  available workflows or using `archon.default_workflow` as fallback).
- Instruct Claude to return a JSON object strictly matching the `IssueAnalysis` schema.
- Unknown or ambiguous issues SHOULD result in a narrow set of targets rather than an overly
  broad one. Claude MUST be instructed to err on the side of fewer, higher-confidence targets.
- Instruct Claude to declare build/deploy ordering between fan-out targets using
  `depends_on` and `ready_when`. Concrete rules to include in the prompt:
  - A target whose change consumes new endpoints, schemas, or data emitted by another
    target SHOULD declare `depends_on: [<upstream_alias>]` with `ready_when: "deployed"`
    (e.g., a frontend that consumes a new BE endpoint, or a service that consumes a
    newly published shared library).
  - Use `ready_when: "merged"` only when the dependent change literally only needs the
    upstream PR closed (rare — e.g., a docs PR that references an API doc PR).
  - Use `ready_when: "deployed:prod"` only for hotfix follow-ups that are unsafe against
    an unreleased upstream. Otherwise prefer `"deployed"` (which uses `default_ready_env`).
  - When unsure, omit `depends_on` and let workers run in parallel. Symphony will not
    fail closed for missing dependencies; PR review and CI/CD remain the safety net.

Output from Claude:
- A JSON `IssueAnalysis` object (see Section 4.1.5).

Analysis failures:
- API timeout → `issue_analysis_error`, issue is held in retry queue.
- Claude returns malformed JSON → `issue_analysis_error`, logged, issue is held.
- Claude returns zero repo targets → `issue_analysis_no_targets`; log warning and skip dispatch
  for this issue for this tick; re-analyze on next tick (do not use cached empty result).

### 7.3 Multi-Repo Fan-Out

When an `IssueAnalysis` returns N `RepoTarget` records, the orchestrator dispatches repo-target
workers incrementally — as many as available slots allow — across one or more ticks. Each worker
is independent: it targets one repo, produces one PR or set of changes, and has its own retry
lifecycle. There is no atomicity requirement across repo workers for the same issue.

Fan-out rules:
- On each tick, dispatch as many pending repo targets as available slots allow AND that
  pass the **sibling readiness check** (see below).
- Remaining (un-dispatched) repo targets are tracked in `pending_targets[issue_id]` in
  orchestrator state and are picked up on subsequent ticks as slots become available
  and as upstream siblings reach the requested ready state.
- Each worker has its own workspace (`<issue_identifier>__<repo_alias>`), its own retry queue
  entry, and its own session metadata.
- The issue is considered `Claimed` once ANY of its repo-target workers has been dispatched.
- The issue is released from `claimed` only when ALL repo-target workers have completed or been
  released AND `pending_targets[issue_id]` is empty.
- Partially-dispatched issues remain `Claimed` between ticks. Their cached `IssueAnalysis` is
  reused for the remaining pending targets; they are not re-analyzed mid-fan-out.
- A partially-dispatched issue's `pending_targets` are prioritized on the next tick over new
  unclaimed issues, so partially-started work is not starved.

**Sibling readiness check** (for `RepoTarget.depends_on`):

A repo target is "ready" only when EVERY upstream sibling alias listed in its
`depends_on` has reached the state requested by `ready_when`. Resolution:

| `ready_when` value | Upstream sibling sub-issue passes when … |
|---|---|
| `"merged"` | sub-issue's state ∈ `tracker.terminal_states`, OR the worker is in `state.completed` (when `create_sub_issues: false`). |
| `"deployed"` | sub-issue carries the label at `tracker.deploy_env_labels[tracker.default_ready_env]`, OR sub-issue's state ∈ `tracker.blocker_satisfied_states`. |
| `"deployed:<env>"` | sub-issue carries the label at `tracker.deploy_env_labels[<env>]`, OR sub-issue's state ∈ `tracker.blocker_satisfied_states`. |

If an upstream sibling has not yet been dispatched (no sub-issue exists yet), the
dependent target stays in `pending_targets`. The orchestrator MUST refresh
upstream sub-issues' state and labels each tick so freshly-deployed siblings
unblock their dependents within one poll interval.

The issue itself is NOT released from `claimed` while any of its targets are
parked on sibling readiness; the parked targets are re-evaluated on every tick.

### 7.4 Available Workflow Selection

The Issue Analyzer selects an Archon workflow per repo target. The selection logic is:

1. The target repository's `symphony.md` front matter declares `default_workflow` (REQUIRED)
   and OPTIONALLY a list of `available_workflows`. The Issue Analyzer prompt is given both.
2. Claude selects the most appropriate workflow from `available_workflows` based on the issue
   type (bug fix, feature, refactor, infra change, etc.).
3. If `available_workflows` is absent or Claude cannot pick confidently, the repository's
   `default_workflow` is used. As a final fallback, `archon.default_workflow` from
   `WORKFLOW.md` applies.

A repository's `symphony.md` declares its workflow surface as:
```yaml
default_workflow: symphony/symphony-fix-issue
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/symphony-supervised
  - symphony/symphony-large-refactor
```

All entries in `available_workflows` that use the `symphony/` prefix are guaranteed to be
present in every base checkout because Symphony syncs them before each dispatch (Section 10.5).
Repo-owned workflows (no prefix) reference files the repo controls independently.

### 7.5 Recommended CI/CD Integration for Deploy Labels

Symphony reads — but never writes — the deploy labels defined in
`tracker.deploy_env_labels`. To unblock dependent fan-out workers and
cross-issue blockers automatically, your CI/CD pipeline SHOULD apply the
appropriate label to the sub-issue (or the parent issue when no sub-issue
exists for that worker) on each successful environment deploy.

**Manual phase (acceptable for early adoption)**: an operator flips the
`deployed:dev` label in Linear when they verify the upstream change is live
in dev. Symphony picks up the label on the next poll tick (default 30s) and
proceeds to dispatch dependent targets.

**Recommended automation — GitHub Action sketch**:

```yaml
# .github/workflows/deploy-notify-linear.yml
name: Notify Linear on deploy
on:
  workflow_run:
    workflows: ["Deploy to dev"]
    types: [completed]
jobs:
  label:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Add deployed:dev label to linked Linear issue
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
          PR_BRANCH: ${{ github.event.workflow_run.head_branch }}
        run: |
          # Branches generated by Linear typically include the issue identifier.
          # Adjust the regex if your team uses a different convention.
          IDENT=$(echo "$PR_BRANCH" | grep -oE '[A-Z]+-[0-9]+' | head -n1)
          [ -z "$IDENT" ] && exit 0
          # Resolve issue ID from identifier, then call issueAddLabel.
          # See Section 12 for the GraphQL field shapes.
```

The label name on the Linear side MUST match `tracker.deploy_env_labels[<env>]`.
Symphony's failure mode if the label never arrives is benign: the dependent
target stays parked in `pending_targets` indefinitely (the wait is visible in
the optional status snapshot, Section 14.3).

---

## 8. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 8.1 Issue Orchestration States

1. `Unclaimed`
   - Issue has no active workers and no retry scheduled.

2. `Analyzing`
   - Issue is dispatch-eligible and Claude analysis is being fetched during the current tick.
   - Analysis is synchronous within the dispatch tick (not an async background task), so this
     is a transient phase, not a durable in-memory state. No slot is consumed.
   - If analysis fails, the issue remains `Unclaimed` and will be retried on the next tick.

3. `Claimed`
   - Orchestrator has reserved the issue (one or more repo-target workers are Running or
     RetryQueued).

4. `Running`
   - One or more worker tasks exist for this issue.

5. `RetryQueued`
   - No workers are running, but at least one retry timer exists.

6. `Released`
   - All claims removed (all repo targets completed, issue is terminal, or non-active).

### 8.2 Run Attempt Lifecycle

A run attempt (per issue + repo target) transitions through:

1. `PreparingWorkspace`
2. `CloningRepository`    ← new step (git clone/sync)
3. `BuildingPrompt`
4. `LaunchingArchon`
5. `StreamingWorkflow`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

### 8.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Analyze eligible issues (cache miss).
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry for that issue+repo pair.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after 1 second.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Archon Event`
  - Update live session fields and token counters.

- `Retry Timer Fired`
  - Re-fetch active candidates; attempt re-dispatch or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill Archon worker and schedule retry.

- `Synced Registry Reload`
  - Triggered when the Repo Syncer writes a new `registry.synced.yaml` and the Repo Registry
    Loader rebuilds the `RegistryContext`.
  - Invalidate `analysis_cache` (all entries).
  - Future ticks will re-analyze affected issues against the fresh context.

### 8.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority.
- `claimed` and `running` checks are REQUIRED before launching any worker.
- Reconciliation runs before dispatch on every tick.
- **Restart recovery is Linear-label-driven** (see Section 12.4). Linear labels are written
  before Archon is launched; on startup Symphony reads those labels to reconstruct in-memory
  state without requiring a persistent database or filesystem scanning.
- Startup terminal cleanup removes stale workspaces and labels for issues already in terminal
  states.

---

## 9. Polling, Scheduling, and Reconciliation

### 9.1 Poll Loop

At startup: validate config, run the initial Repo Syncer pass (if `registry.sync_on_startup`
is `true`), load `registry.synced.yaml` into the `RegistryContext`, resolve viewer identity
(if `tracker.assigned_to_me` is `true`, call `{ viewer { id } }` once and cache the result —
fatal if it fails), perform startup cleanup, schedule an immediate tick, then repeat every
`polling.interval_ms`. The Repo Syncer cadence loop also begins after the initial pass.

Tick sequence:

1. Reconcile running issues (stall detection, timeout, active-run state refresh).
2. Poll supervised gates — for each entry in `state.supervised_gates`, check for human
   responses via `tracker.fetch_issue_comments(issue_id)` and call
   `archon workflow approve/reject <run_id>` if a response is found (see Section 11.3.2).
3. Run dispatch preflight validation.
4. Fetch candidate issues from tracker using active states.
5. Sort issues by dispatch priority.
6. For each eligible issue: analyze (if cache miss), fan-out dispatch per repo target.
   Also drain `state.pending_targets` for already-claimed issues.
7. Notify observability/status consumers of state changes.

If preflight validation fails, dispatch is skipped for that tick but steps 1–2 continue.

### 9.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is not already in `running` (for any repo target).
- It is not already in `claimed`.
- It does not carry the `symphony:claimed` label (durable guard; catches cases where
  in-memory `claimed` set was not yet populated from a just-rebuilt startup state).
- Global concurrency slots >= 1 (at least one repo target can be dispatched on
  this tick; remaining targets queue in `pending_targets` per Section 7.3).
- Per-state concurrency slots are available.
- **Blocker rule** (applies in ALL active states, not only `Todo`):
  - For each entry in `issue.blocked_by`, the blocker MUST be "satisfied"
    according to `tracker.blocker_default_readiness`:
    - `"merged"` — blocker state ∈ `tracker.terminal_states`.
    - `"deployed"` — blocker carries `tracker.deploy_env_labels[default_ready_env]`,
      OR blocker state ∈ `tracker.blocker_satisfied_states`,
      OR blocker state ∈ `tracker.terminal_states` AND no env-tracking is
      configured (graceful fallback for early-adoption teams).
    - `"deployed:<env>"` — blocker carries `tracker.deploy_env_labels[<env>]`,
      OR blocker state ∈ `tracker.blocker_satisfied_states`.
  - If ANY blocker is unsatisfied, the issue is NOT dispatch-eligible —
    regardless of its own state. This generalizes the legacy
    `Todo`-only check to all states (which closes a re-dispatch loophole on
    retries that resume in `In Progress`).
  - The same predicate is reused for sibling readiness in Section 7.3 — a
    blocker and an upstream sibling differ only in whether the relation comes
    from Linear's native blocker graph or from `RepoTarget.depends_on`.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 9.3 Concurrency Control

**Two worker buckets:**

| Bucket | Counts against limit? | Description |
|--------|----------------------|-------------|
| `state.running` | **Yes** | Actively executing — Claude API calls in flight, git ops, code generation |
| `state.supervised_gates` | **No** | Alive but idle — Archon process paused at an interactive gate waiting for human input |

A paused Archon process has no active Claude calls, no CPU load, and negligible memory. Counting it against the limit would starve real work while humans are slow to respond.

Global limit:

- `available_slots = max(max_concurrent_agents - count(state.running), 0)`
- `state.supervised_gates` is NOT subtracted from available slots.

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized).
- Applied only to `state.running` entries, not `state.supervised_gates`.

**Slot lifecycle for supervised gates:**

1. Worker starts → enters `state.running` (slot consumed).
2. Archon pauses at interactive gate → worker moves `state.running → state.supervised_gates` (slot freed).
3. Human responds → Symphony calls `archon workflow approve/reject` → worker moves `state.supervised_gates → state.running` (slot re-consumed until Archon exits).
4. Archon exits → worker removed from `state.running` (slot freed).

**Gate timeout:** If a gate remains in `state.supervised_gates` for longer than
`archon.gate_timeout_ms`, Symphony calls `archon workflow reject <run_id> --reason "Gate
timeout — no human response within allowed window"` and schedules a normal retry. This
prevents paused processes from accumulating indefinitely. Default: `0` (disabled).

### 9.4 Retry and Backoff

Same formula as base Symphony:

- Normal continuation retries: fixed delay `1000` ms.
- Failure-driven retries: `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Retry entries are keyed by `<issue_id>__<repo_alias>`.

### 9.5 Active Run Reconciliation

Part A: Stall detection
- For each running issue+repo entry, compute `elapsed_ms` since `last_archon_timestamp` (or
  `started_at` if no event seen yet).
- If `elapsed_ms > archon.stall_timeout_ms`, terminate and queue retry.

Part B: Tracker state refresh
- Fetch current states for all running issue IDs.
- Terminal state → terminate all repo workers for that issue, clean workspaces.
- Still active → update in-memory issue snapshot.
- Neither active nor terminal → terminate workers without cleanup.
- If state refresh fails, keep workers running and try on next tick.

Part C: Dependent sub-issue refresh (for parked targets)
- For each issue with non-empty `pending_targets[issue_id]` whose targets
  declare `depends_on`, collect the sub-issue IDs of the upstream siblings
  (looked up from the orchestrator's `sibling_subissues[issue_id]` map,
  populated when sub-issues were created in Section 12.2).
- Bulk-fetch state and labels for those sub-issue IDs in the same call as
  Part B (single GraphQL round-trip).
- Update in-memory snapshots so the next dispatch cycle's readiness check
  (Section 7.3) reflects the freshest state.
- If the fetch fails, leave parked targets parked; retry on next tick.

### 9.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue identifier, remove all corresponding workspace directories
   (all `<issue_identifier>__<repo_alias>` directories under workspace root).
3. If the terminal-issues fetch fails, log a warning and continue startup.

---

## 10. Workspace Management

Symphony uses one **base checkout** per registered repository — not one per issue. The
checkout is created and maintained by the **Repo Syncer** (Section 6.6) inside the Base
Folder; the Workspace Manager does NOT clone repositories itself.

Per-issue git isolation is handled by Archon's built-in worktree mechanism, rooted at the
base checkout path.

### 10.1 Base Checkout Layout

```
<registry.base_folder>/
  repos/
    <repo_slug>/         ← one git clone per registered repository (owned by Repo Syncer)
      .git/
      symphony.md        ← parsed by Repo Syncer
      .archon/
        workflows/
          symphony/      ← Symphony-managed workflow YAML files written here on dispatch
      src/  ...
  registry.synced.yaml   ← Synced Registry (owned by Repo Syncer)
```

Per-repo base checkout path: `<registry.base_folder>/repos/<repo_slug>/`. This path is
materialized for runtime consumers as `RegistryRepo.local_path` and propagated to
`RepoTarget.local_path`.

`<repo_slug>` is the slug derived from the repository URL by the Repo Syncer (Section 6.5).

`repo_alias` is always the `name` declared by the repository's `symphony.md` front matter,
sanitized to `[A-Za-z0-9._-]` for filesystem use. This is the normative source of truth for
log fields, session IDs, and sub-issue titles.

After the Issue Analyzer returns `RepoTarget` records, Symphony MUST reconcile each
`RepoTarget.repo_url` against the `RegistryContext` to find the matching `RegistryRepo`
(exact URL match). The `repo_alias` used for all downstream operations is derived from that
matched `RegistryRepo.name`, not from `RepoTarget.repo_alias` as returned by Claude. If
Claude's alias and the registry-derived alias differ, the registry-derived value wins. If no
registry repository matches `repo_url`, Symphony MUST log a warning and skip the target.

### 10.2 Base Checkout Lifecycle

The Repo Syncer is the sole writer of git state inside `<registry.base_folder>/repos/`.
Symphony's pre-Archon hook MUST NOT call `git clone`, `git fetch`, or `git reset` against
this directory — those operations belong to the Repo Syncer (Section 6.6).

Before each Archon run, the Workspace Manager:

1. Resolves the base checkout path from `RepoTarget.local_path` (sourced from
   `RegistryRepo.local_path`).
2. Validates that the path exists and is a git checkout. If absent (the Repo Syncer has not
   yet cloned this repository, or the clone was deleted), the attempt MUST fail with
   `repo_clone_error` and a normal retry is scheduled — the Repo Syncer's next pass is
   expected to recover.
3. Syncs Symphony workflow templates into the checkout (see Section 10.5).

After issue completion (optional): call `archon isolation cleanup --merged --cwd
<local_path>/` in the `after_run` hook to prune stale worktrees.

### 10.3 Workspace Hooks

`before_run` and `after_run` hooks run with `cwd = RepoTarget.local_path` (the base
checkout in the Base Folder). Defined in `WORKFLOW.md` front matter; executed by Symphony.

### 10.4 Safety Invariants

Invariant 1: `RepoTarget.local_path` MUST be inside `registry.base_folder/repos/`.
Invariant 2: `repo_alias` is sanitized — only `[A-Za-z0-9._-]`.
Invariant 3: `--cwd` passed to `archon workflow run` MUST equal `RepoTarget.local_path`.
Invariant 4: `registry.base_folder` MUST NOT be inside the Symphony project directory.

The legacy `workspace.root` setting (Section 5.3.3) remains valid for implementation-defined
auxiliary use (artifact caches, test scratch space). It is NOT used as the base checkout
parent in the federated model; that role belongs to `registry.base_folder/repos/`.

### 10.5 Workflow Template Sync

Symphony is the single source of truth for Archon workflow YAML files. Repository-specific
Archon workflows that teams manage themselves live directly in `.archon/workflows/` and are
never touched by Symphony. Symphony-owned templates are kept in `workflow_templates.path`
(configured in Section 5.3.8) and synced into a dedicated subdirectory of each checkout.

**Directory layout after sync:**

```
<workspace_root>/<repo_alias>/
  .archon/
    workflows/
      symphony/                   ← Symphony-managed; overwritten on sync
        symphony-fix-issue.yaml
        symphony-supervised.yaml
        symphony-large-refactor.yaml
      custom-repo-workflow.yaml   ← repo-owned; Symphony never touches this
```

**Sync algorithm (deterministic copy):**

```
function sync_workflow_templates(checkout_path):
  source_dir  = config.workflow_templates.path
  target_dir  = checkout_path + "/.archon/workflows/" + config.workflow_templates.target_subdir
  create_dir_if_absent(target_dir)
  for each file in list_yaml_files(source_dir):
    dest = target_dir + "/" + basename(file)
    copy_file(file → dest)          # overwrite; idempotent
  # files in target_dir absent from source_dir are left unchanged (no deletes)
```

**Trigger conditions:**

| Trigger | Action |
|---|---|
| Startup — checkout already exists | Sync immediately for every registered repo |
| Startup — checkout freshly cloned | Sync after clone completes |
| Before every Archon run | Sync the relevant checkout (fast; files are small) |
| Any file change inside `workflow_templates.path` | Mark all checkouts `needs_template_sync = true`; sync before next dispatch |

The "before every run" sync ensures correctness with near-zero cost (workflow YAMLs are
small). The `reload_on_change` watcher provides prompt propagation to idle repos without
waiting for their next dispatch.

**Workflow reference in `symphony.md`:**

To reference a Symphony-managed template from a registered repository, use the prefixed name
in the repository's `symphony.md` front matter:

```yaml
---
name: claims-service
description: Claims processing ECS service.
default_workflow: symphony/symphony-fix-issue   # resolves to .archon/workflows/symphony/symphony-fix-issue.yaml
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/symphony-supervised
components:
  - name: claims-api
    component_type: ecs_service
    description: REST surface for claims submission and lookup.
---
```

A specific component MAY override the repository-level workflow by setting its own
`default_workflow` (Section 5.4.2). When neither the component nor the repository declares a
workflow, Symphony falls back to `archon.default_workflow` from `WORKFLOW.md`, which itself
SHOULD be a prefixed Symphony template name (e.g., `symphony/symphony-fix-issue`).

**Recommended `workflow_templates/` structure:**

```
workflow_templates/
  symphony-fix-issue.yaml         # standard autonomous fix (default)
  symphony-supervised.yaml        # supervised with loop.interactive for uncertain tasks
  symphony-large-refactor.yaml    # supervised; includes plan approval before coding
  symphony-hotfix.yaml            # minimal, fast path for critical production issues
```

The set of templates can grow over time. Adding a new YAML file to `workflow_templates/` is
sufficient to make it available to all repos — no per-repo action required.

---

## 11. Archon Workflow Executor

Symphony uses Archon's existing CLI without any modifications.

### 11.1 Archon CLI Contract — What Symphony Calls

**Command format:**

```bash
archon workflow run <workflow_name> \
  --cwd <workspace_root>/<repo_alias>/ \
  "<issue_message>"
```

| Flag | Value | Why |
|------|-------|-----|
| `--cwd` | `<workspace_root>/<repo_alias>/` | Symphony's base checkout (where `.archon/workflows/` lives) |
| `<issue_message>` | structured issue context string | Becomes `$USER_MESSAGE` / `$ARGUMENTS` inside the workflow |

**Issue message format** (Symphony constructs and passes as the positional string argument):

```
Issue: <identifier> — <title>
URL: <url>
Labels: <label1>, <label2>
Repo: <repo_alias> — <rationale>
Components: <component1>, <component2>
Analysis: <analysis_summary>
Attempt: <number or "first">

<full issue description>
```

Everything in the workflow is read from `$USER_MESSAGE`. Symphony MAY also set `SYMPHONY_*`
env vars in the subprocess for direct access in bash nodes, but this is supplemental — not
the primary channel.

**Note on Archon's env var handling:** Archon strips CWD `.env` file keys from `process.env`
at startup, but env vars set in the subprocess environment (not from `.env` files) are
preserved and passed through to Claude Code subprocesses. Symphony sets env vars as subprocess
environment variables (not via `.env` files), so they survive Archon's stripping step.

### 11.2 Communication Channels

| Direction | Channel | Notes |
|-----------|---------|-------|
| Symphony → Archon | `[message]` positional arg | Issue context; becomes `$USER_MESSAGE`. Primary channel. |
| Symphony → Archon | env vars (optional) | `SYMPHONY_*` set in subprocess env for `bash` node access. |
| Symphony → Archon | `archon workflow approve/reject` | Resumes or rejects a paused gate; injects human reply text. |
| Archon → Symphony | **exit code** | `0` = workflow completed; non-zero = failure. |
| Archon → Symphony | **stderr** | Gate pause events (containing `run-id`) and stall detection. |

**Stderr is the gate-detection channel.** Symphony's `on_stderr` callback serves two purposes:
stall detection (no output for `stall_timeout_ms`) and gate-pause detection (pattern match to
extract `run-id`). All other orchestration decisions are made from exit codes only.
Symphony MUST NOT parse stderr content for any purpose other than these two.

### 11.3 Archon Workflow YAML Conventions

**Symphony-managed workflows** (the primary set) live in Symphony's own `workflow_templates/`
directory and are synced into every repo's `.archon/workflows/symphony/` before each dispatch
(see Section 10.5). This makes Symphony the single source of truth — editing one YAML in
`workflow_templates/` immediately propagates to all repos on the next tick.

**Repo-owned workflows** remain in `.archon/workflows/` (no subdirectory) and are not touched
by Symphony. These are maintained by individual teams for repo-specific automation.

Workflows used by Symphony SHOULD:

- Use `$USER_MESSAGE` as the primary issue context source.
- Use `output_format:` on decision nodes to get structured JSON for reliable `when:` routing.
- Use `$ARTIFACTS_DIR` for passing data between nodes.
- Include a `create-pr` or equivalent node as the terminal success step.

**DAG auto-resume**: Archon automatically skips completed nodes on re-invocation at the same
`--cwd` path if a prior run failed partway. Symphony just re-runs the same command and Archon
picks up where it left off — no Symphony-level node tracking needed for partial failures.

#### 11.3.1 Human Interaction via Interactive Gates

When a workflow needs human input, Claude pauses mid-run at a gate node. The Archon subprocess
stays alive, paused at the gate. Symphony detects the pause from stderr, frees the concurrency
slot (moves the worker from `state.running` to `state.supervised_gates`), posts the gate
message to Linear as a comment, and polls for a human reply. When the human replies, Symphony
calls `archon workflow approve <run-id> --comment "<text>"` to inject the reply and resume the
workflow. The human's text flows natively into the workflow via Archon variables — no
re-dispatch or `$USER_MESSAGE` re-injection needed.

**Boundary rule: Archon/Claude handles code and git. Symphony handles Linear.** Archon
workflows are never given Linear credentials. Symphony is the sole writer to Linear.

**Two gate primitives** (both handled identically by Symphony):

| Primitive | YAML key | Human text variable | Best for |
|-----------|----------|-------------------|----------|
| Interactive loop | `loop.interactive: true` | `$LOOP_USER_INPUT` | Multi-turn clarification — Claude asks questions, gets answers, asks follow-ups |
| Approval gate | `approval:` with `capture_response: true` | `$<node-id>.output` | Single sign-off — human approves or rejects a plan before work begins |

**`loop.interactive` is the recommended primitive for clarification.** It allows genuine
back-and-forth: Claude asks one question per iteration, Symphony posts it to Linear, the
human replies, Symphony injects it as `$LOOP_USER_INPUT`, Claude asks a follow-up or emits
the completion signal — all within a single Archon run.

**Full supervised lifecycle (same for both primitives):**

```
1. Archon runs → hits interactive gate → workflow pauses
   Archon writes pause event to stderr including run-id
                    ↓
2. Symphony on_stderr callback detects pause, captures run-id
   → moves worker: state.running → state.supervised_gates  [SLOT FREED]
   → applies symphony:waiting-human label to (sub-)issue
   → posts gate message as Linear comment
   → if tracker.gate_waiting_state is configured:
       update_issue_state(target, gate_waiting_state)
       (target = sub_issue_id ?? parent_id — same rule used for labels and comments)
   → records {run_id, paused_at, gate_message, comment_id, prior_state} in supervised_gates
                    ↓
3. Human replies in Linear comment thread
                    ↓
4. Symphony tick loop polls tracker.fetch_issue_comments(issue_id)
   Finds human comment posted after paused_at
                    ↓
5a. Approve intent detected:
      remove symphony:waiting-human label from (sub-)issue
      if tracker.gate_waiting_state was used:
        update_issue_state(target, gate_resume_state)
        (default gate_resume_state = tracker.active_states[0], typically "In Progress")
      archon workflow approve <run-id> --comment "<human reply text>"
    → moves worker: supervised_gates → state.running  [SLOT CONSUMED AGAIN]
    → $LOOP_USER_INPUT or $<node-id>.output = human reply text
    → Archon resumes; loop runs next iteration or workflow continues

5b. Reject intent detected (or gate_timeout_ms exceeded):
      remove symphony:waiting-human label from (sub-)issue
      if tracker.gate_waiting_state was used:
        update_issue_state(target, gate_resume_state)
      archon workflow reject <run-id> --reason "<human reply or timeout>"
    → $REJECTION_REASON = human reply or "timeout"
    → workflow's on_reject prompt runs (if defined), or workflow terminates
    → Symphony schedules normal retry
                    ↓
6. Archon exits → Symphony detects via exit code → worker removed from state.running
```

**Gate state-transition contract** (when `tracker.gate_waiting_state` is non-null):

| Step | Linear state | Linear labels | Worker bucket |
|------|--------------|---------------|---------------|
| Before pause | active (e.g., `In Progress`) | `symphony:running` | `state.running` |
| On pause | `gate_waiting_state` (e.g., `Waiting for Review`) | + `symphony:waiting-human` | `state.supervised_gates` |
| On resolve (approve or reject) | `gate_resume_state` (e.g., `In Progress`) | − `symphony:waiting-human` | `state.running` (approve) or retry queue (reject/timeout) |

The state transition is the visible signal on the Linear board. The
`symphony:waiting-human` label remains the durable signal Symphony reads on startup
recovery (Section 12.4) — recovery does NOT depend on the issue's current state. Operators
who run with `tracker.create_sub_issues: true` will see the parked lane populated by
sub-issues; operators who run with `create_sub_issues: false` will see the parent issue
itself transition.

When `tracker.gate_waiting_state` is `null` (the default), no state transition is performed
on either pause or resolution — the gate is signalled purely via the
`symphony:waiting-human` label and the Linear comment.

**`loop.interactive` workflow pattern** (`workflow_templates/symphony-fix-issue.yaml` —
synced to `<checkout>/.archon/workflows/symphony/` before dispatch):

```yaml
nodes:
  - id: clarify
    loop:
      prompt: |
        You are helping implement this issue:
        $USER_MESSAGE

        Prior answer from human (if any): $LOOP_USER_INPUT

        Do you have enough information to create an implementation plan?
        - If YES: output exactly READY
        - If NO: ask ONE specific clarifying question. Be concrete and brief.
      until: READY
      interactive: true
      gate_message: "Claude has a clarifying question — reply to continue."
      max_iterations: 5

  - id: plan
    depends_on: [clarify]
    prompt: |
      Issue context: $USER_MESSAGE
      Clarification answers: $clarify.output
      Create a detailed implementation plan.

  - id: implement
    depends_on: [plan]
    loop:
      prompt: |
        Issue: $USER_MESSAGE
        Plan: $plan.output
        Implement. Run tests. Iterate until done.
      until: COMPLETE
      max_iterations: 15
      fresh_context: true

  - id: create-pr
    depends_on: [implement]
    context: fresh
    prompt: "Create a pull request referencing the issue URL from: $USER_MESSAGE"
```

**`approval` gate pattern** (for plan sign-off before writing code):

```yaml
- id: plan
  prompt: |
    Issue: $USER_MESSAGE
    Create a detailed implementation plan.

- id: review-gate
  approval:
    message: "Implementation plan ready for review."
    capture_response: true
    on_reject:
      prompt: |
        Plan rejected. Human feedback: $REJECTION_REASON
        Revise the plan and re-present.
      max_attempts: 3
  depends_on: [plan]

- id: implement
  depends_on: [review-gate]
  prompt: |
    Issue: $USER_MESSAGE
    Approved plan: $plan.output
    Human approval note: $review-gate.output
    Implement the plan.
  loop:
    until: COMPLETE
    max_iterations: 15
    fresh_context: true

- id: create-pr
  depends_on: [implement]
  context: fresh
  prompt: "Create a pull request. Issue URL is in: $USER_MESSAGE"
```

**Pause detection from stderr:** Symphony's existing `on_stderr` callback (used for stall
detection) is extended to detect pause events. Pattern to match:

```
/paused|approval.?gate|run[- ]?id[:\s]+([a-f0-9-]{36})/i
```

Capture the UUID. If the run-id cannot be extracted from stderr, fall back to
`archon workflow status --json --cwd <checkout>` to find the paused run. Implementations
SHOULD cache the first successful stderr extraction to avoid the fallback.

**Gate timeout:** If `archon.gate_timeout_ms > 0` and a gate has been in `supervised_gates`
for longer than that value, Symphony automatically rejects:

```bash
archon workflow reject <run_id> --reason "Gate timeout — no response within allowed window"
```

The `symphony:waiting-human` label is removed and — if `tracker.gate_waiting_state` was
applied on pause — `update_issue_state(target, gate_resume_state)` is called BEFORE the
reject so the parked-lane state does not persist on a retry-bound issue. The worker is
then removed from `supervised_gates` and a normal retry is scheduled. Default: `0`
(disabled — gates wait indefinitely). Recommended: `86400000` (24 hours) for async teams.

### 11.4 Emitted Runtime Events (Upstream to Orchestrator)

- `archon_started` — `archon workflow run` subprocess launched.
- `archon_output` — stderr line received (updates stall detection timestamp).
- `archon_gate_paused` — Archon paused at an `approval` node (supervised mode only).
  Payload includes `run_id`. Symphony posts Linear comment and records in `supervised_gates`.
- `archon_gate_approved` — Symphony called `archon workflow approve <run_id>` with human text.
- `archon_gate_rejected` — Symphony called `archon workflow reject <run_id>` with human reason.
- `archon_succeeded` — exit code 0; workflow ran to completion.
- `archon_failed` — exit code non-zero.
- `archon_timed_out` — `archon.turn_timeout_ms` exceeded.
- `archon_stalled` — no stderr for `archon.stall_timeout_ms`.
- `archon_cancelled` — worker killed by reconciliation.

### 11.5 Timeouts and Error Mapping

- `archon.turn_timeout_ms`: total workflow run timeout.
- `archon.stall_timeout_ms`: maximum silence before stall detection triggers.

RECOMMENDED error categories:

- `archon_not_found` — Archon CLI not in PATH.
- `archon_workflow_not_found` — Named workflow not found (check with `archon workflow list`).
- `archon_exit_nonzero` — Archon process exited with non-zero code.
- `archon_turn_timeout` — Total run timeout exceeded.
- `archon_stalled` — No stderr output within stall timeout.
- `repo_clone_error` — Git clone/sync failed.
- `invalid_workspace_cwd` — Workspace path validation failed.

---

## 12. Issue Tracker Integration Contract (Linear-Compatible)

Extends the base Symphony specification (Section 11 of SPEC.md) with additional REQUIRED
write operations needed for interactive gate bridging.

### 12.1 REQUIRED Operations

An implementation MUST support these tracker adapter operations (read operations are
unchanged from base Symphony):

1. `fetch_candidate_issues()` — issues in active states for the configured project.
   When `tracker.assigned_to_me` is `true` (the default), filters to issues assigned to
   the authenticated user. The viewer's Linear user ID is resolved once at startup via
   `{ viewer { id } }` and cached for the lifetime of the process. Linear GraphQL filter:
   `{ assignee: { id: { eq: "<viewer_id>" } } }` is added to the query predicate.
2. `fetch_issues_by_states(state_names)` — startup terminal cleanup.
3. `fetch_issue_states_by_ids(issue_ids)` — active-run reconciliation.
4. `create_sub_issue(parent_id, title, assignee_id, state_name)` — **NEW**: create a
   Linear sub-issue under a parent issue.
   - Called at dispatch time when fan-out width > 1 and `tracker.create_sub_issues` is `true`.
   - `title` format: `[<repo_alias>] <parent issue title>`.
   - `assignee_id`: same as parent issue's assignee (from `viewer.id` when `assigned_to_me`).
   - `state_name`: `"In Progress"` (or first active state if not present).
   - Returns `{id, identifier}` of the created sub-issue. Stored in `state.running[key].sub_issue_id`.
   - On failure: log warning, set `sub_issue_id = null`, continue dispatch (non-fatal).
5. `update_issue_state(issue_id, state_name)` — **NEW**: transition any issue (parent or sub)
   to a named state.
   - Called on worker success (`"Done"`), max-retry exhaustion (`"Cancelled"`), and gate
     rejection that terminates the workflow (`"Cancelled"`).
   - When `sub_issue_id` is non-null, called on the sub-issue. Parent issue state is managed
     by the human (Symphony never auto-closes the parent — only the sub-issues).
   - Failure is non-fatal; log warning.
6. `post_comment(issue_id, body)` — **NEW**: post a comment to a Linear issue.
   - When `sub_issue_id` is non-null for the worker, posts to the sub-issue; else to the parent.
   - Called by Symphony when an Archon gate pauses, to surface Claude's question to the human.
   - Returns the created comment's `id` (stored in `state.supervised_gates` for correlation).
   - Failure is non-fatal; gate is still recorded in state.
7. `apply_label(issue_id, label_name)` — **NEW**: apply a named label to a Linear issue.
   - Used for both orchestration state labels (`symphony:claimed`, `symphony:queued`,
     `symphony:running`, `symphony:waiting-human`) and gate-pause signalling.
   - Applied to the sub-issue when one exists; otherwise to the parent.
   - If the label does not exist in Linear, MUST create it before applying (see Section 12.4).
   - **MUST be called before launching Archon** for state labels (write-before-launch
     ordering ensures the label exists if Symphony crashes between write and launch).
   - Failure is non-fatal for gate labels; MUST be treated as fatal for state machine labels
     (retry until successful or abort the dispatch attempt).
8. `remove_label(issue_id, label_name)` — **NEW**: remove a named label from a Linear issue.
   - Called when a worker exits (removes `symphony:running`), when a gate is resolved
     (removes `symphony:waiting-human`), and when all workers for an issue complete
     (removes `symphony:claimed` from the parent).
   - Failure is non-fatal; log warning. Missing label is not an error.
9. `fetch_issues_by_label(label_name)` — **NEW**: fetch all issues carrying a given label.
   - Used exclusively during startup recovery (Section 12.4) to rebuild in-memory state
     from Linear without filesystem scanning.
   - Returns a list of `{id, identifier, title, state, labels, parent_id}`.
10. `fetch_issue_comments(issue_id)` — **NEW**: fetch all comments on a Linear issue.
   - Returns a list of `{id, body, author, created_at}` in chronological order.
   - Used by Symphony to poll for the human's approval/rejection reply after a gate pause.
   - Called on the sub-issue when one exists; otherwise on the parent.
   - Finds the most recent human comment posted after `paused_at`.
   - If the request fails, Symphony retries on next tick (logs warning).

### 12.2 Sub-Issue Lifecycle (Multi-Repo Fan-Out)

Sub-issues are created and managed only when `tracker.create_sub_issues: true` (default) and
an issue fans out to more than one repo.

**Creation — at first dispatch for each repo target:**

```
if len(issue.repo_targets) > 1 and config.tracker.create_sub_issues:
  sub = tracker.create_sub_issue(
    parent_id:   issue.id,
    title:       "[" + repo_alias + "] " + issue.title,
    assignee_id: viewer.id,           # same person as parent
    state_name:  "In Progress"
  )
  state.running[key].sub_issue_id = sub.id   # null on failure
```

**Label write-before-launch ordering (REQUIRED):**

Symphony MUST apply state machine labels to Linear BEFORE launching Archon. This ensures
that if Symphony crashes between the label write and the process launch, the label survives
and startup recovery can detect the orphaned state. The sequence for dispatching a target:

```
1. Create sub-issue (if multi-repo fan-out)
2. apply_label(parent_id, "symphony:claimed")          # parent marked as in-flight
3. apply_label(sub_issue_id ?? parent_id, "symphony:running")  # target marked as running
4. Launch Archon subprocess                            # only after labels are written
```

For queued (pending) targets that are waiting for a slot or sibling readiness:

```
1. Create sub-issue
2. apply_label(parent_id, "symphony:claimed")
3. apply_label(sub_issue_id ?? parent_id, "symphony:queued")
   # symphony:running is applied later, when the target is actually dispatched
```

**State transitions and label lifecycle:**

| Event | Label change on sub-issue (or parent) | Label change on parent issue |
|---|---|---|
| Target queued (slot unavailable or deps unmet) | apply `symphony:queued` | apply `symphony:claimed` |
| Target dispatched from queue | remove `symphony:queued`, apply `symphony:running` | already `symphony:claimed` |
| Target dispatched directly (slot available) | apply `symphony:running` | apply `symphony:claimed` |
| Gate pauses | apply `symphony:waiting-human`, post comment, and (when `tracker.gate_waiting_state` is set) transition issue state to `gate_waiting_state` | no change |
| Gate resolved (approved or rejected) | remove `symphony:waiting-human`, and (when `tracker.gate_waiting_state` was applied) transition issue state back to `gate_resume_state` | no change |
| Worker succeeds | remove `symphony:running`, issue state → `Done` | — |
| Max retries exhausted | remove `symphony:running`, issue state → `Cancelled` | — |
| Gate rejected + workflow terminates | remove `symphony:running`, issue state → `Cancelled` | — |
| All workers for issue complete | — | remove `symphony:claimed` |

Symphony **never auto-closes the parent issue**. The parent remains visible in the human's
queue. When all sub-issues reach terminal states, the human reviews, sees the linked PRs, and
closes the parent manually. This keeps the human in the loop for final sign-off on multi-repo
changes.

**Sub-issue targeting:** all `post_comment`, `apply_label`, `remove_label`,
`fetch_issue_comments` calls use `sub_issue_id` when it is non-null; fall back to parent
`issue_id` when null.

**Pending targets:** when a repo target is in `state.pending_targets` (slot not yet
available), the sub-issue is created at actual dispatch time — not when the issue is first
analyzed.

### 12.4 Label-Driven Startup Recovery

On startup, Symphony MUST rebuild in-memory orchestrator state from Linear before the first
tick fires. This replaces filesystem-based state scanning. No persistent database is required.

**Recovery sequence:**

```
1. fetch_issues_by_label("symphony:claimed")
   → for each result: add issue.id to state.claimed

2. fetch_issues_by_label("symphony:running")
   → for each result:
       if result.parent_id is non-null (it is a sub-issue):
         repo_alias = extract_alias_from_title(result.title)  # "[alias] parent title"
         key = result.parent_id + "__" + repo_alias
         state.running[key] = { sub_issue_id: result.id, ... }
       else (single-repo — label is on parent):
         # repo_alias must be inferred from workspace directory or re-analysis
         mark as needing workspace check (step 4)

3. fetch_issues_by_label("symphony:queued")
   → for each result:
       parent_id = result.parent_id
       repo_alias = extract_alias_from_title(result.title)
       add RepoTarget stub to state.pending_targets[parent_id]
       # Full RepoTarget fields will be recovered via re-analysis on next tick if needed

4. For each key in state.running:
     check whether the workspace directory exists at
       <workspace_root>/<issue_identifier>/<repo_alias>/
     if workspace absent: treat as crashed worker → schedule immediate retry,
       remove symphony:running label, apply symphony:queued label
     if workspace present but no live Archon PID: same as absent (crashed)
     if workspace present and Archon is running: attach to process for monitoring

5. fetch_issues_by_label("symphony:waiting-human")
   → for each result: add to state.supervised_gates with run_id = null
     (Archon is gone; gate will be resolved by the human; Symphony polls for comment reply)
```

**Label creation on startup:**

Before recovery, Symphony MUST ensure all four symphony state labels exist in the Linear
workspace. For each label name configured in `tracker.symphony_labels`:

```
if label does not exist in Linear workspace:
  create it (color: configurable, RECOMMENDED gray for state labels)
```

Failure to create a required label MUST abort startup with a clear error.

**Crash safety guarantees provided by write-before-launch:**

| Symphony crashed… | Durable state in Linear | Recovery action |
|---|---|---|
| Before writing `symphony:running` | No label; issue has `symphony:claimed` | Issue is re-analyzed and re-dispatched on next tick |
| After writing `symphony:running`, before launching Archon | `symphony:running` present; no live process | Detected in step 4; treated as crashed worker; retry scheduled |
| While Archon was running | `symphony:running` present; no live process | Detected in step 4; retry scheduled |
| After Archon succeeded but before removing label | `symphony:running` present; Archon exit = 0 in logs | Re-attach finds Archon gone; retry runs; Archon exits immediately if work is already done (idempotent workflows) |

### 12.5 Boundary Enforcement

**Archon workflow steps MUST NOT be given Linear API credentials.**

The only interaction between Archon and Linear is indirect:
- Symphony passes issue context to Archon as the `$USER_MESSAGE` positional argument (read-only
  data flowing into the workflow).
- When a workflow gate pauses, Symphony reads the gate message from Archon's stderr and posts
  it to Linear. Archon itself never touches Linear.

This boundary ensures Linear credentials stay in Symphony's environment only, and that the
full history of tracker writes (comments, labels, state transitions) is owned by Symphony or
by the coding agent's git/PR actions — not by ad-hoc Archon workflow API calls.

---

## 13. Issue Message Construction

### 13.1 Purpose

The `[message]` positional argument to `archon workflow run` is the primary context channel.
Symphony constructs a plain-text issue message string that becomes `$USER_MESSAGE` inside
every Archon workflow node.

### 13.2 Message Format

```
Issue: <identifier> — <title>
URL: <url>
Labels: <label1>, <label2>
Repo: <repo_alias> — <rationale>
Components: <component1>, <component2>
Analysis: <analysis_summary>
Attempt: <number or "first">

<full issue description (markdown preserved)>
```

The header block is machine-parseable for `bash` nodes. The description follows a blank line.

`Attempt` is `"first"` on the initial dispatch and increments on retries. Human clarification
responses flow through `$LOOP_USER_INPUT` (for `loop.interactive` gates) or `$<node>.output`
(for `approval` gates) — they are never re-injected into `$USER_MESSAGE`.

Total message length SHOULD be kept under 16,000 characters. If the issue description is
longer, Symphony MAY truncate it with a note: `[description truncated — <N> chars omitted]`.

**Example:**

```
Issue: SYM-123 — Fix null pointer in patient ingestion
URL: https://linear.app/thirdopinion/issue/SYM-123
Labels: bug, patient-data
Repo: patient-ingestion — Core ETL pipeline affected by schema change
Components: patient-ingestion-ecs, healthlake-integration
Analysis: ECS task fails when HL7 message missing PID segment
Attempt: first

When a HL7 v2 ADT message is received without a PID.3 field...
```

### 13.3 Accessing the Message in Workflows

- `$USER_MESSAGE` — available in `prompt` nodes and `bash` nodes.
- `$ARGUMENTS` — alias for `$USER_MESSAGE`.
- `bash` nodes can parse the header with standard tools (`grep`, `awk`, `jq`).
- Example: extract issue URL: `ISSUE_URL=$(echo "$USER_MESSAGE" | grep '^URL:' | cut -d' ' -f2)`

---

## 14. Logging, Status, and Observability

### 14.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`
- `repo_alias`

REQUIRED context for agent session lifecycle logs:

- `session_id`

Message formatting requirements: same as base Symphony (stable `key=value` phrasing).

### 14.2 Logging Outputs and Sinks

Same as base Symphony specification. Operators MUST be able to see startup/validation/dispatch
failures without attaching a debugger.

### 14.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot, it SHOULD return:

- `running` (list of running session rows, one per issue+repo pair)
  - Each row SHOULD include `issue_identifier`, `repo_alias`, `archon_workflow`, `turn_count`.
- `retrying` (list of retry queue rows)
- `blocked` (list of repo targets parked on sibling readiness, one row per parked target)
  - Each row SHOULD include `issue_identifier`, `repo_alias` (the parked target),
    `depends_on` (upstream aliases), `ready_when`, and a list of unmet upstream
    sub-issues with their current `state` and observed labels.
- `claude_totals`
  - `input_tokens`, `output_tokens`, `total_tokens`
  - `seconds_running`
- `analysis_cache_size` (number of cached `IssueAnalysis` entries)

### 14.4 OPTIONAL HTTP Server Extension

Same as base Symphony specification (Section 13.7), with the following endpoint additions:

- `GET /api/v1/analysis/<issue_identifier>`
  - Returns the cached `IssueAnalysis` for the identified issue, or `404` if not cached.
  - Useful for debugging routing decisions.
- `POST /api/v1/invalidate-analysis`
  - Clears the `analysis_cache` for one or all issues.
  - Body: `{"issue_id": "abc123"}` to clear one issue, or `{}` to clear all.
  - Response (`200 OK`): `{"cleared": 1}`.

---

## 15. Failure Model and Recovery Strategy

### 15.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Missing or unparseable `registry.synced.yaml` with no last-known-good context
   - Invalid YAML front matter in `WORKFLOW.md`
   - `registry.base_folder` resolves inside the Symphony project directory
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing Archon CLI executable
   - Missing `gh` CLI executable
   - Missing Anthropic API key

2. `Issue Analysis Failures`
   - Anthropic API timeout or error
   - Claude response not parseable as `IssueAnalysis`
   - Zero repo targets returned

3. `Workspace Failures`
   - Directory creation failure
   - Git clone/sync failure
   - Hook timeout/failure

4. `Agent Session Failures`
   - Archon workflow not found
   - Archon process exit with non-zero code
   - Turn timeout
   - Stalled session

5. `Tracker Failures`
   - API transport errors, non-200 status, GraphQL errors, malformed payloads

6. `Dispatch-Blocked-on-Sibling` (non-fatal)
   - A repo target's `depends_on` is unsatisfied at dispatch time. Treated as a
     queueing event, not an error: the target stays in `pending_targets` and is
     re-evaluated on every tick. No retry timer is scheduled — the wait is
     observed via the `blocked` snapshot row and resolves naturally when the
     upstream sub-issue reaches the requested ready state.
   - Implementations MAY surface this as a single Linear comment on the parent
     issue ("⏸️ <repo_alias> waiting on <upstream> to reach <ready_when>") and
     SHOULD avoid re-posting the same comment on every tick.

7. `Observability Failures`
   - Snapshot timeout, dashboard render errors, log sink failure

### 15.2 Recovery Behavior

- Issue analysis failures: hold the issue in the retry queue for one tick; re-analyze on next
  tick (do not retry indefinitely without tracker state refresh first).
- Repo clone/sync failures: fail the current attempt; exponential backoff retry.
- Archon exit failures: exponential backoff retry.
- Tracker candidate-fetch failures: skip this tick; try again on next tick.
- Reconciliation state-refresh failures: keep workers; retry on next tick.
- Synced Registry reload failures: keep last-known-good `RegistryContext`; emit
  operator-visible error.
- Per-repository sync failures (parse errors, missing `symphony.md`, network errors): the
  affected repository is excluded from `RegistryContext` with a warning; the rest of the
  system continues. Symphony retries on the next sync pass.

### 15.3 Partial State Recovery (Restart)

Same as base Symphony: in-memory scheduler state is not persisted. After restart:

- No retry timers or running sessions are restored.
- `analysis_cache` is empty; all issues will be re-analyzed on next tick.
- Service recovers by startup terminal cleanup, fresh polling, and re-dispatching eligible work.

### 15.4 Operator Intervention Points

- Editing `WORKFLOW.md` (hot-reloaded automatically).
- Editing a registered repository's `symphony.md` and pushing to its default branch
  (picked up by the Repo Syncer on its next pass; triggers `RegistryContext` rebuild).
- Adding/removing entries in `WORKFLOW.md` `repositories` (hot-reloaded; the Repo Syncer
  picks up new entries on its next pass).
- Changing issue states in the tracker (stops running sessions on reconciliation).
- Restarting the service for process recovery or deployment.
- Calling `POST /api/v1/invalidate-analysis` to force re-routing (if HTTP extension is
  implemented).

---

## 16. Security and Operational Safety

### 16.1 Trust Boundary Assumption

Implementations MUST state their trust posture explicitly. Symphony is designed for
trusted internal AWS environments where the operator controls both the Linear workspace and
the AWS infrastructure repositories.

### 16.2 Filesystem Safety Requirements

Mandatory:

- The Base Folder (`registry.base_folder`) MUST be outside the Symphony project directory.
- Archon `--cwd` MUST equal `RepoTarget.local_path` — the Repo Syncer's base checkout for
  that repository, located at `<base_folder>/repos/<slug>/` (one checkout per registered
  repository, shared across issues). Per-issue git isolation is Archon's responsibility;
  Symphony provides the base checkout via the Repo Syncer and does not dictate Archon's
  internal worktree strategy.
- Repo slugs and `repo_alias` values MUST use sanitized identifiers (Repo Syncer enforces
  slug uniqueness; `symphony.md` `name` field enforces alias uniqueness — Section 6.7).

RECOMMENDED additional hardening:

- Run under a dedicated OS user.
- Restrict Base Folder permissions to the Symphony service user.
- Mount the Base Folder on a dedicated EBS volume if deployed on EC2/ECS.
- The legacy `workspace.root` (if used for auxiliary scratch space) SHOULD also be
  permission-restricted.

### 16.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens (Linear, Anthropic, GitHub).
- Validate presence of secrets without printing them.
- `SYMPHONY_*` environment variables passed to Archon MUST NOT include secret values.
  Archon workflow steps should read secrets from their own environment (AWS Secrets Manager,
  SSM Parameter Store, or host environment) rather than receiving them from Symphony.

### 16.4 Hook Script Safety

Same as base Symphony. Hooks are fully trusted configuration; hook output SHOULD be truncated
in logs; hook timeouts are REQUIRED.

### 16.5 Registry Safety

The federated registry (`symphony.md` documents and the assembled `RegistryContext`)
describes sensitive internal infrastructure topology. Implementations SHOULD:

- Treat each `symphony.md` as a sensitive document inside its own repository. Repository-level
  access controls already protect it; do not also commit credentials or operational secrets
  into `symphony.md`.
- Ensure that the registry content sent to Claude does not include credentials, IP addresses,
  internal hostnames, or other operational secrets. Describe components by name, type, and
  function only — not by deployment specifics.
- Treat `<base_folder>/registry.synced.yaml` as a derived artifact that may aggregate the
  full system topology in one place; protect the Base Folder with appropriate filesystem
  permissions.
- If issue titles or descriptions contain sensitive data that should not leave the
  environment, implement a local Claude deployment (Amazon Bedrock with Claude) rather than
  calling the Anthropic public API.

### 16.6 Archon Workflow Safety

Because Archon workflows run arbitrary Claude Code sessions with access to the workspace
filesystem and git remotes, implementations SHOULD:

- The default `autonomous` approval mode is RECOMMENDED for most deployments because Claude
  decides when to escalate rather than blindly proceeding or blocking on every approval gate.
  Use `auto` (fully non-interactive) only when all workflows are known to never require
  escalation. Use `human` only when operator-in-the-loop latency is acceptable.
- The autonomous escalation comment written to Linear (Section 11.3.1) is visible to the
  whole team; ensure Linear issue descriptions and titles do not contain data you would not
  want surfaced in a comment (e.g., internal credential names, PII).
- Restrict which Linear issues, projects, and labels are eligible for dispatch (use label
  filters in the tracker client or orchestrator candidate selection logic).
- Use repository-scoped GitHub tokens with only the permissions Archon needs (contents: write,
  pull_requests: write) rather than broad personal access tokens.

---

## 17. Reference Algorithms (Language-Agnostic)

### 17.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)
  start_synced_registry_watch(on_change=rebuild_registry_context_and_invalidate_analysis_cache)
  start_repo_syncer(interval_ms=config.registry.sync_interval_ms)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    analysis_cache: {},
    claude_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0}
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 17.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  # Poll supervised gates — check for human replies and approve/reject waiting runs
  state = poll_supervised_gates(state)

  # Drain pending targets for already-claimed issues (incremental fan-out continuation)
  state = process_pending_targets(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break  # no slots at all; stop scanning new issues

    if should_dispatch(issue, state):
      analysis = get_or_analyze(issue, state)
      if analysis failed:
        log_analysis_error(issue)
        continue  # skip this issue; try the next one

      state = dispatch_issue(issue, analysis, state)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state

# available_slots counts only state.running — supervised_gates are idle and don't consume slots
function available_slots(state):
  return max(config.agent.max_concurrent_agents - count(state.running), 0)

function no_available_slots(state):
  return available_slots(state) == 0

function poll_supervised_gates(state):
  for key, gate in state.supervised_gates:
    target_id = gate.sub_issue_id if gate.sub_issue_id is not null else gate.issue_id

    # Gate timeout check
    if config.archon.gate_timeout_ms > 0:
      if elapsed_ms(gate.paused_at) > config.archon.gate_timeout_ms:
        resolve_gate_state_transition(target_id, gate)   # restore active state if needed
        tracker.remove_label(target_id, config.tracker.symphony_labels.waiting_human)
        run_command("archon workflow reject " + gate.run_id + " --reason 'Gate timeout'")
        state = schedule_retry(state, gate.issue_id, gate.repo_alias, attempt=1, {error: "gate_timeout"})
        state.supervised_gates.remove(key)
        continue

    # Check for human reply — use sub-issue when one exists (matches Section 12.1 targeting rule)
    comments = tracker.fetch_issue_comments(target_id)  # non-fatal if fails
    if comments failed: continue

    reply = find_comment_after(gate.paused_at, comments, exclude_author=SYMPHONY_BOT_USER)
    if reply is null: continue  # no human response yet

    intent = classify_approval_intent(reply.body)  # keyword match: approve/reject

    if intent == approve:
      tracker.remove_label(target_id, config.tracker.symphony_labels.waiting_human)
      resolve_gate_state_transition(target_id, gate)   # move back to active before Archon resumes
      run_command("archon workflow approve " + gate.run_id + " --comment " + quote(reply.body))
      send(orchestrator_channel, {archon_gate_approved, gate.issue_id, gate.repo_alias})
      # Move back to running — slot consumed again until Archon exits
      state.running[key] = rebuild_running_entry(gate)
      state.supervised_gates.remove(key)
    else if intent == reject:
      tracker.remove_label(target_id, config.tracker.symphony_labels.waiting_human)
      resolve_gate_state_transition(target_id, gate)
      run_command("archon workflow reject " + gate.run_id + " --reason " + quote(reply.body))
      send(orchestrator_channel, {archon_gate_rejected, gate.issue_id, gate.repo_alias})
      state = schedule_retry(state, gate.issue_id, gate.repo_alias, attempt=1, {error: "gate_rejected"})
      state.supervised_gates.remove(key)
    # else: ambiguous — wait for next tick

  return state

# Helper used by gate pause and resolve paths (Sections 11.3.1, 17.6).
function apply_gate_state_transition(target_id, gate_entry):
  if config.tracker.gate_waiting_state is null: return
  tracker.update_issue_state(target_id, config.tracker.gate_waiting_state)   # non-fatal
  gate_entry.gate_state_applied = true                                       # remembered for resolve

function resolve_gate_state_transition(target_id, gate_entry):
  if not gate_entry.gate_state_applied: return
  resume_state = config.tracker.gate_resume_state or config.tracker.active_states[0]
  tracker.update_issue_state(target_id, resume_state)                        # non-fatal
  gate_entry.gate_state_applied = false
```

### 17.3 Issue Analysis (get or cached)

```text
function get_or_analyze(issue, state):
  cached = state.analysis_cache[issue.id]
  if cached exists and not expired:
    return cached

  registry_context = load_registry_context()
  analysis = claude.analyze_issue(issue, registry_context)

  if analysis failed or analysis.repo_targets is empty:
    return error

  state.analysis_cache[issue.id] = {analysis, cached_at: now()}
  return analysis
```

### 17.4 Dispatch One Issue (Incremental Multi-Repo Fan-Out)

```text
# First dispatch for a newly-eligible issue: load all targets into pending_targets,
# then drain as many as slots allow. Called from the tick loop.
function dispatch_issue(issue, analysis, state):
  state.claimed.add(issue.id)
  state.retry_attempts.remove_all_for(issue.id)

  # Load all repo targets into pending queue (idempotent if already partially loaded)
  if state.pending_targets[issue.id] is empty:
    state.pending_targets[issue.id] = copy(analysis.repo_targets)

  state = drain_pending_targets(issue, state)
  return state

# Drain as many pending repo targets as slots allow AND that pass the sibling
# readiness check. Also called each tick for partially-dispatched issues (via
# process_pending_targets step in tick loop).
function drain_pending_targets(issue, state):
  remaining = []
  for repo_target in state.pending_targets[issue.id]:
    if available_slots(state) == 0:
      remaining.append(repo_target)
      continue  # no more slots; keep this target pending

    if not repo_target_ready(repo_target, issue, state, config):
      remaining.append(repo_target)
      continue  # upstream sibling not yet at requested ready state

    worker_key = issue.id + "__" + repo_target.repo_alias
    worker = spawn_worker(
      fn -> run_agent_attempt(issue, repo_target, attempt=null, orchestrator_channel) end
    )

    if worker spawn failed:
      state = schedule_retry(state, issue.id, repo_target.repo_alias, attempt=1, {
        error: "failed to spawn agent"
      })
      continue

    state.running[worker_key] = {
      worker_handle,
      monitor_handle,
      identifier: issue.identifier,
      repo_alias: repo_target.repo_alias,
      archon_workflow: repo_target.archon_workflow,
      issue,
      session_id: build_session_id(issue.identifier, repo_target.repo_alias, null),
      archon_pid: null,
      last_archon_event: null,
      last_archon_timestamp: null,
      last_archon_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      turn_count: 0,
      started_at: now_utc()
    }

  state.pending_targets[issue.id] = remaining
  return state
```

The tick loop MUST also drain pending targets for already-claimed issues at the start of each
dispatch cycle, before evaluating new unclaimed issues:

```text
# In on_tick, before the unclaimed-issue loop:
for issue_id in keys(state.pending_targets):
  if state.pending_targets[issue_id] is not empty:
    issue = state.running entries for issue_id or tracker cache
    state = drain_pending_targets(issue, state)
```

### 17.4.1 Readiness Predicate (Sections 7.3 / 9.2)

A single predicate evaluates both Linear cross-issue blockers and sibling
fan-out dependencies:

```text
function is_blocker_satisfied(blocker, ready_when, config):
  # blocker = {state, labels} of either a Linear blocker issue or a sibling sub-issue.
  if ready_when == "merged":
    return blocker.state in config.tracker.terminal_states

  # "deployed" or "deployed:<env>"
  env = (ready_when == "deployed")
        ? config.tracker.default_ready_env
        : env_after_colon(ready_when)
  required_label = config.tracker.deploy_env_labels[env]

  if required_label and required_label in blocker.labels:
    return true
  if blocker.state in config.tracker.blocker_satisfied_states:
    return true

  # Graceful fallback: if no env tracking is configured at all, fall back to
  # terminal state. Lets early-adoption teams use the spec without setting up
  # deploy labels yet.
  if env tracking is empty for this team:
    return blocker.state in config.tracker.terminal_states

  return false

function repo_target_ready(target, parent_issue, state, config):
  if target.depends_on is empty: return true

  for upstream_alias in target.depends_on:
    sub_issue_id = state.sibling_subissues[parent_issue.id][upstream_alias] or null
    if sub_issue_id is null:
      # Upstream not dispatched yet — when create_sub_issues is true this
      # means it hasn't even started; block. When create_sub_issues is false,
      # check state.completed for "merged" semantics only.
      if target.ready_when == "merged" and
         is_completed_in_state(state, parent_issue.id, upstream_alias):
        continue
      return false

    upstream = state.subissue_snapshot[sub_issue_id]   # refreshed in §9.5 Part C
    if upstream is null: return false   # we asked but haven't seen it yet

    if not is_blocker_satisfied(upstream, target.ready_when, config):
      return false

  return true
```

Implementations MUST keep `state.sibling_subissues` populated as Section 12.2
sub-issues are created, and MUST refresh `state.subissue_snapshot` from the
tracker's bulk fetch in Section 9.5 Part C.

### 17.5 Worker Attempt (Workspace + Archon)

```text
function run_agent_attempt(issue, repo_target, attempt, orchestrator_channel):
  # Workspace is the base checkout for this repo (one per repo, shared across issues)
  workspace_cwd = config.workspace_root + "/" + repo_target.repo_alias + "/"

  # Sync base checkout to latest main branch before starting
  sync_result = run_git_fetch_reset(workspace_cwd)
  if sync_result failed:
    fail_worker("repo_clone_error")

  # Sync Symphony-managed workflow templates into this checkout (Section 10.5)
  if config.workflow_templates.sync_on_dispatch:
    sync_workflow_templates(workspace_cwd)
    # Non-fatal: log a warning if sync fails but continue — stale templates are better than no run

  if run_hook("before_run", workspace_cwd) failed:
    fail_worker("before_run hook error")

  # Build the issue message string (primary context channel)
  issue_message = build_issue_message(issue, repo_target, attempt)

  # Build the archon CLI command
  archon_cmd = [
    "archon", "workflow", "run",
    repo_target.archon_workflow,
    "--cwd", workspace_cwd,
    issue_message
  ]

  # Optional: also set SYMPHONY_* env vars for bash node direct access
  env_vars = build_symphony_env(issue, repo_target, attempt)

  captured_run_id = null  # extracted from stderr when a gate pause is detected

  archon_proc = launch_subprocess(
    command: archon_cmd,
    cwd: workspace_cwd,
    env: env_vars,
    on_stderr: (line) ->
      send(orchestrator_channel, {archon_output, issue.id, repo_target.repo_alias, line})

      # Gate-pause detection: extract run-id when Archon pauses at a loop.interactive or approval gate
      if captured_run_id is null:
        run_id = extract_run_id_from_stderr(line)  # regex: /([a-f0-9-]{36})/
        if run_id is not null:
          captured_run_id = run_id
          send(orchestrator_channel, {archon_gate_paused, issue.id, repo_target.repo_alias, run_id, line})
          # Orchestrator handles: post Linear comment, move to supervised_gates (freeing slot)
  )
  send(orchestrator_channel, {archon_started, issue.id, repo_target.repo_alias, archon_proc.pid})

  result = wait_for_exit(
    archon_proc,
    timeout_ms: config.archon.turn_timeout_ms
  )

  run_hook_best_effort("after_run", workspace_cwd)

  if result == timeout:
    fail_worker("archon turn timeout")

  if result.exit_code != 0:
    fail_worker("archon exited nonzero: " + result.exit_code)

  exit_normal()
```

### 17.6 Orchestrator Event Handler (Worker → Orchestrator)

The orchestrator receives events from worker goroutines via `orchestrator_channel`. The
`archon_gate_paused` event triggers the slot-free transition:

```text
function handle_worker_event(event, state):
  match event:
    {archon_started, issue_id, repo_alias, pid}:
      key = issue_id + "__" + repo_alias
      state.running[key].archon_pid = pid
      return state

    {archon_output, issue_id, repo_alias, line}:
      key = issue_id + "__" + repo_alias
      state.running[key].last_archon_timestamp = now_utc()
      state.running[key].last_archon_message = line
      return state

    {archon_gate_paused, issue_id, repo_alias, run_id, gate_message}:
      key = issue_id + "__" + repo_alias
      # Use sub-issue when one exists — matches Section 12.1 targeting rule
      target_id = state.running[key].sub_issue_id or issue_id

      # 1. Apply waiting-human label (non-fatal)
      tracker.apply_label(target_id, config.tracker.symphony_labels.waiting_human)

      # 2. Post gate message to Linear (non-fatal if fails)
      comment_result = tracker.post_comment(target_id, gate_message)
      comment_id = comment_result.id or null

      # 3. Move worker out of running → supervised_gates  ← SLOT IS NOW FREE
      gate_entry = {
        run_id,
        issue_id,
        repo_alias,
        sub_issue_id: state.running[key].sub_issue_id or null,  # carry forward for comment targeting
        paused_at: now_utc(),
        gate_message,
        comment_id,
        gate_state_applied: false,                              # set by apply_gate_state_transition
        worker_handle: state.running[key].worker_handle
      }
      state.supervised_gates[key] = gate_entry
      state.running.remove(key)   # ← concurrency slot freed here

      # 4. Move issue to gate_waiting_state if configured (Section 11.3.1)
      apply_gate_state_transition(target_id, gate_entry)

      log_info("Gate paused — slot freed", {issue_id, repo_alias, run_id})
      return state

    {archon_gate_approved, issue_id, repo_alias}:
      # Worker moved back to running by poll_supervised_gates; no state change here
      log_info("Gate approved", {issue_id, repo_alias})
      return state

    {archon_gate_rejected, issue_id, repo_alias}:
      log_info("Gate rejected", {issue_id, repo_alias})
      return state

    {archon_succeeded, issue_id, repo_alias}:
      key = issue_id + "__" + repo_alias
      state.running.remove(key)
      state.completed.add(key)
      # Release the claim only when ALL repo workers for this issue are finished:
      # no entries remain in running, no pending_targets, and no retry_attempts.
      # A multi-repo issue must NOT be released while sibling workers are still active.
      if no_running_workers_for(state, issue_id) and
         (state.pending_targets[issue_id] is null or state.pending_targets[issue_id] is empty) and
         no_retry_entries_for(state, issue_id):
        state.claimed.remove(issue_id)
      return state

    {archon_failed, issue_id, repo_alias, exit_code}:
      key = issue_id + "__" + repo_alias
      state.running.remove(key)
      state = schedule_retry(state, issue_id, repo_alias, next_attempt, {error: exit_code})
      return state
```

### 17.7 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_issue_ids = unique(map(keys(state.running), fn k -> k.split("__")[0] end))
  if running_issue_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_issue_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      for worker_key in running_keys_for_issue(state, issue.id):
        state = terminate_running_worker(state, worker_key, cleanup_workspace=true)
      state.analysis_cache.remove(issue.id)
    else if issue.state in active_states:
      for worker_key in running_keys_for_issue(state, issue.id):
        state.running[worker_key].issue = issue
    else:
      for worker_key in running_keys_for_issue(state, issue.id):
        state = terminate_running_worker(state, worker_key, cleanup_workspace=false)

  return state
```

---

## 18. Test and Validation Matrix

### 18.1 Core Conformance (REQUIRED)

- Workflow file path precedence: explicit runtime path > cwd default.
- `WORKFLOW.md` changes trigger hot-reload without restart.
- Repo Syncer rewriting `registry.synced.yaml` triggers `RegistryContext` rebuild and
  `analysis_cache` invalidation.
- Invalid reload keeps last-known-good config and emits operator-visible error.
- Missing `WORKFLOW.md` returns typed error.
- Missing or unparseable `registry.synced.yaml` with no last-known-good context aborts
  startup with a clear error.
- Invalid YAML front matter returns typed error.
- Config defaults apply when OPTIONAL values are missing.
- `$VAR` resolution works for all `$VAR`-capable config fields.
- Prompt template renders `issue`, `attempt`, `repo_target`, `analysis` variables.
- Prompt rendering fails on unknown variables (strict mode).
- `RegistryContext` rebuild invalidates `analysis_cache`.
- Issue analysis calls Claude with `RegistryContext` (per-repo front matter + narrative)
  and structured issue input.
- Issue analysis result is cached and reused within TTL.
- Multi-repo fan-out dispatches one worker per repo target.
- Incremental fan-out: undispatched repo targets queued in `pending_targets`, drained each tick.
- One base checkout per registered repository at `<base_folder>/repos/<slug>/`, owned and
  maintained by the Repo Syncer.
- Repo Syncer detects remote SHA changes via `gh api` and pulls with `git pull --ff-only`.
- Repo name and component name collisions are detected and surfaced as per-repo
  `sync_status: error` with actionable messages.
- Missing `symphony.md` is recorded as `sync_status: missing_symphony_md` and the repository
  is excluded from `RegistryContext` until added.
- `registry.base_folder` inside the Symphony project directory aborts startup with a clear
  error.
- Archon launched with `--cwd RepoTarget.local_path`; per-issue worktree creation is
  Archon's responsibility.
- Issue context passed as `[message]` positional arg → `$USER_MESSAGE` in workflow.
- Archon exit code 0 = workflow ran to completion; non-zero = failure requiring retry.
- Stall detection kills Archon and schedules retry.
- Turn timeout kills Archon and schedules retry.
- Normal worker exit schedules short continuation retry (attempt 1, delay 1s).
- Abnormal worker exit schedules exponential-backoff retry.
- Retry backoff cap uses `agent.max_retry_backoff_ms`.
- Concurrency slots count all per-repo workers (not per-issue).
- Issue (in ANY active state) with an unsatisfied blocker is not dispatch-eligible.
  - "Satisfied" obeys `tracker.blocker_default_readiness` (`merged` | `deployed` | `deployed:<env>`).
- Sibling readiness gates fan-out drain: a target with `depends_on` is parked in
  `pending_targets` until upstream sibling sub-issues meet `ready_when`.
- `ready_when: "deployed:<env>"` matches the label at `tracker.deploy_env_labels[<env>]`.
- A label transition on an upstream sub-issue (e.g., `deployed:dev` applied) unblocks
  dependent targets within one poll interval.
- Terminal tracker state stops all workers for that issue.
- Non-active tracker state stops workers without sync reset.
- Gate pause with `tracker.gate_waiting_state` configured transitions the (sub-)issue to
  the configured parked state; gate resolution (approve, reject, or timeout) transitions
  the (sub-)issue back to `tracker.gate_resume_state` (default = `tracker.active_states[0]`)
  BEFORE Archon is resumed or the retry is scheduled.
- Gate pause with `tracker.gate_waiting_state` left at default (`null`) does NOT call
  `update_issue_state`; only the label and comment are applied (legacy behavior).
- Startup emits a warning when `tracker.gate_waiting_state` is listed in `tracker.active_states`.
- Workspace path invariant: `--cwd` MUST be inside `workspace_root`.
- Structured logs include `issue_id`, `issue_identifier`, `repo_alias`, `session_id`.
- Validation failures are operator-visible and do not crash the service.

### 18.2 Extension Conformance (REQUIRED only if feature is implemented)

- HTTP server: baseline endpoints match Section 14.4 response shapes.
- `/api/v1/analysis/<issue_identifier>` returns cached analysis or 404.
- `POST /api/v1/invalidate-analysis` clears one or all cache entries.
- `linear_graphql` tool extension: valid queries execute, errors return structured failure,
  missing auth returns structured failure.

### 18.3 Real Integration Profile (RECOMMENDED before production)

- Real Linear smoke test with valid `LINEAR_API_KEY` and `project_slug`.
- Real Anthropic API call with valid `ANTHROPIC_API_KEY`; analysis returns >0 repo targets.
- `gh` CLI is reachable in PATH and `gh auth status` reports authenticated.
- Repo Syncer pass completes for at least one registered repository: SHA fetch succeeds,
  `symphony.md` is parsed, entry is written to `registry.synced.yaml`.
- Archon CLI is reachable in PATH; `archon workflow run <workflow>` exits with code 0 on a
  trivial fixture workflow.
- Hook execution verified on the target OS/shell.
- Multi-repo fan-out verified: issue affecting components in two registered repositories
  produces two `RepoTarget` records and two running entries pointing at distinct
  `local_path` checkouts.

---

## 19. Implementation Checklist (Definition of Done)

### 19.1 REQUIRED for Conformance

- `symphony setup` wizard: masked input, user-env persistence, API validation, no key logging.
- Sub-issue creation on multi-repo fan-out (`create_sub_issues`): created at dispatch, state
  transitioned on completion/cancellation, gate comments and PR links target sub-issue.
- Workflow path selection: explicit > cwd default.
- `WORKFLOW.md` loader with YAML front matter + prompt body split.
- Repo Registry Loader: reads `registry.synced.yaml`, builds `RegistryContext`, watches the
  file for hot reload.
- Repo Syncer: clones repositories on first encounter, polls remote SHA via `gh api`, pulls
  with `git pull --ff-only`, parses each repository's `symphony.md`, writes
  `registry.synced.yaml` atomically, validates name uniqueness, reports per-repo sync
  status.
- Typed config layer with defaults and `$` resolution (all fields in Section 6.4).
- Dynamic `WORKFLOW.md` and Synced Registry watch/reload/re-apply.
- Analysis cache with TTL and invalidation on `RegistryContext` rebuild.
- Issue Analyzer: calls Claude Anthropic API with `RegistryContext`, returns structured
  `IssueAnalysis`. `RepoTarget.local_path` populated from the matched `RegistryRepo`.
- Multi-repo incremental fan-out: `pending_targets` queue drained across ticks as slots free.
- Gate-pause detection: `run-id` extraction from Archon stderr → `archon_gate_paused` event,
  slot freed immediately, gate bridged to Linear, `supervised_gates` tracking in state.
- Gate-state-transition support (`tracker.gate_waiting_state` / `tracker.gate_resume_state`):
  on pause, after applying `symphony:waiting-human` and posting the comment, transition the
  (sub-)issue to `gate_waiting_state` when configured; on approve / reject / timeout, restore
  `gate_resume_state` (default = `tracker.active_states[0]`) before resuming or scheduling
  the retry. Persist the `gate_state_applied` flag on the supervised-gate entry so the
  restore only fires when the original transition succeeded.
- Startup warning when `tracker.gate_waiting_state` is listed in `tracker.active_states` (or
  when `tracker.gate_resume_state` is NOT listed in `tracker.active_states`).
- Polling orchestrator with single-authority mutable state.
- Issue tracker client: candidate fetch + state refresh + terminal fetch + `post_comment` +
  `apply_label` (Linear). Archon has no Linear credentials; all tracker writes go through
  Symphony's tracker client.
- Base Folder layout: `<base_folder>/repos/<slug>/` per registered repository, owned by the
  Repo Syncer; pre-Archon hook does NOT call git operations against this directory.
- Workspace lifecycle hooks (`before_run`, `after_run`).
- Hook timeout config (`hooks.timeout_ms`, default `60000`).
- Archon subprocess launcher: `archon workflow run <workflow> --cwd <checkout> "<message>"`.
- Issue message construction per Section 13.2 (passed as `$USER_MESSAGE` to workflow).
- Stall detection and turn timeout enforcement.
- Strict prompt rendering with `issue`, `attempt`, `repo_target`, `analysis` variables.
- Exponential retry queue with continuation retries after normal exit.
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m).
- Reconciliation that stops all repo workers on terminal/non-active tracker state.
- Workspace cleanup for terminal issues (startup sweep + active transition).
- Structured logs with `issue_id`, `issue_identifier`, `repo_alias`, and `session_id`.
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface).
- CLI command surface (Section 21):
  - `symphony init` — wizard that creates `WORKFLOW.md` and calls `symphony repo add` per
    repository. MUST NOT write to repository `.archon/` directories.
  - `symphony repo add <url>` — only sanctioned mutator of `WORKFLOW.md`'s `repositories`
    list. Validates URL, derives slug, probes default branch via `gh repo view`, appends
    entry under file lock.
  - `symphony repo remove <url|slug>` — removes entry from `WORKFLOW.md`; preserves local
    checkout.
  - `symphony repo list` — prints registry + sync status table.
  - `symphony repo scaffold <url>` — supports both blocking (default) and `--async` modes;
    persists async jobs to `<base_folder>/scaffold_jobs.yaml` with `archon_run_id`
    initially `null` (Archon does not emit run ID at launch — verified in Archon's
    `packages/cli/src/commands/workflow.ts`).
  - `symphony scaffold status` — implements the run-ID resolution algorithm (Section 21.7)
    matching `working_path` against `archon workflow status --json`, then resolves the PR
    URL via `gh pr list --head <branch> --repo <owner>/<repo> --state all --json url`.
  - `symphony sync` — manual single-pass Repo Syncer; on success removes
    `scaffold_jobs.yaml` entries whose corresponding repo now has `sync_status: ok`
    (Section 21.7.1).
  - `symphony status` — composes Source Registry + Synced Registry + scaffold jobs +
    orchestrator runtime snapshot.
- Advisory file locking at `<base_folder>/.symphony.lock` for all writes to
  `WORKFLOW.md`, `registry.synced.yaml`, and `scaffold_jobs.yaml` — held by both the
  CLI commands and the running orchestrator's Repo Syncer. 10-second acquisition timeout
  with informative error message naming the holder (Section 21.10).

### 19.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension with analysis cache endpoints (Section 14.4).
- `linear_graphql` client-side tool accessible to Archon workflow steps.
- Amazon Bedrock backend for Claude (instead of Anthropic public API) for air-gapped or
  data-residency-sensitive environments.
- Persist analysis cache and retry queue across process restarts (SQLite or DynamoDB).
- Slack or PagerDuty integration for operator alerts on repeated failures.
- Per-repo `symphony.md` validation linter: CI tool that checks each repository's
  `symphony.md` for missing required fields, malformed `communicates_with` references,
  and invalid component types — runnable as a pre-commit/CI check inside each registered
  repository.
- Per-issue, per-repo workspace sharing via EFS (for ECS-hosted deployments) to support
  horizontal scaling of the Symphony daemon.
- Adapter architecture (Section 3.4): isolate tracker I/O behind the Section 12 operations,
  isolate workflow execution behind a single Workflow Executor module mirroring Section 11,
  isolate issue analysis behind an Analyzer module, and isolate persistence behind a
  Storage module. Recommended even for Linear+Archon-only deployments to keep the
  orchestrator backend-agnostic and to enable future swaps without orchestrator rewrites.
- Alternate tracker adapters (e.g. GitHub Issues, Jira): implement the ten operations in
  Section 12.1 against the new backend, document the mapping for tracker-specific
  primitives that lack native equivalents (sub-issues, labels, comments), and select via
  `tracker.kind`.
- Alternate workflow executor adapters (e.g. direct Claude SDK loop, OpenAI Codex,
  another agent runtime): expose `start_run` / `stream_events` / `approve` / `reject` /
  `abandon` / `status` (Section 3.4.2) and emit the Section 11.4 event shapes so the
  orchestrator's event handler (Section 17.6) is reused unchanged.

### 19.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 18.3 with valid credentials and network.
- Verify that a representative Linear issue routes to the expected repository/repositories.
- Verify that the chosen Archon workflow completes successfully for a trivial issue.
- Verify workspace cleanup works for terminal issues across all repo aliases.
- If deployed on ECS: verify IAM task role has necessary permissions (Anthropic API outbound,
  git remote access, Secrets Manager read for API keys).

---

## Appendix A. `symphony.md` Component Types Reference

This taxonomy is OPTIONAL — `component_type` is not a REQUIRED field on a component record
(Section 5.4.2). Implementations and operators MAY use any value, but the canonical set
below is RECOMMENDED for analyzer prompt clarity and cross-repository consistency:

| `component_type`   | AWS Service           | Notes                                      |
|--------------------|-----------------------|--------------------------------------------|
| `ecs_service`      | AWS ECS               | Include cluster name, service name.        |
| `lambda`           | AWS Lambda            | Include function name, runtime.            |
| `sqs_queue`        | Amazon SQS            | Use `communicates_with` to express producers/consumers. |
| `eventbridge_bus`  | Amazon EventBridge    | Include bus name and rules.                |
| `redshift`         | Amazon Redshift       | Include cluster and schema.                |
| `healthlake`       | AWS HealthLake        | Include datastore ID and FHIR version.     |
| `rds`              | Amazon RDS            | Include instance ID, engine, schema.       |
| `shared_lib`       | (any)                 | Shared library affecting many consumers.   |
| `api_gateway`      | Amazon API Gateway    | Include stage; consumers via `communicates_with`. |
| `other`            | (any)                 | Catch-all for unlisted component types.    |

The owning repository for each component is implicit — every component lives in the
repository whose `symphony.md` declares it. Cross-repository edges are expressed via the
`communicates_with` field (Section 5.4.2), not via a `repository:` field on the component.

---

## Appendix B. Example `WORKFLOW.md` Front Matter

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: thirdopinion-symphony
  assigned_to_me: true                 # default; false = process all project issues regardless of assignee
  create_sub_issues: true             # default; creates one sub-issue per repo worker on multi-repo fan-outs
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Closed
  gate_waiting_state: "Waiting for Review"   # parked lane; MUST NOT appear in active_states
  gate_resume_state:  "In Progress"          # default = active_states[0]; restored on approve/reject/timeout

polling:
  interval_ms: 60000

workspace:
  root: ~/symphony_workspaces

hooks:
  before_run: |
    # git sync and workflow template sync already done by Symphony before this hook runs
    echo "Starting agent run for $SYMPHONY_REPO_ALIAS on issue $SYMPHONY_ISSUE_ID"
  after_run: |
    archon isolation cleanup --merged --cwd . || true

agent:
  max_concurrent_agents: 8
  max_turns: 30
  max_retry_backoff_ms: 600000

archon:
  command: archon workflow run
  turn_timeout_ms: 7200000
  stall_timeout_ms: 600000
  default_workflow: symphony/symphony-fix-issue   # prefixed → .archon/workflows/symphony/symphony-fix-issue.yaml
  gate_timeout_ms: 86400000                       # 24 hours — auto-reject open gates with no human reply

workflow_templates:
  path: workflow_templates/         # folder next to WORKFLOW.md — Symphony's source of truth
  target_subdir: symphony           # written to .archon/workflows/symphony/ in each repo
  sync_on_dispatch: true
  reload_on_change: true

claude:
  api_key: $ANTHROPIC_API_KEY
  analyzer_model: claude-sonnet-4-5
  analyzer_max_tokens: 2048
  analyzer_timeout_ms: 45000

registry:
  base_folder: $SYMPHONY_BASE_FOLDER     # e.g., ~/.symphony — must NOT be inside this project
  sync_interval_ms: 900000               # 15 minutes
  sync_on_startup: true
  analysis_cache_ttl_ms: 600000

repositories:
  - url: https://github.com/org/patient-ingestion-service
    default_branch: main
  - url: https://github.com/org/fhir-validator-lambdas
    default_branch: main
  - url: https://github.com/org/infra-terraform
    default_branch: main
  - url: https://github.com/org/shared-auth-lib
    default_branch: main
---

The issue message is passed as the CLI argument to `archon workflow run` and becomes
`$USER_MESSAGE` inside every workflow node. See Section 13.2 for the format.

This `WORKFLOW.md` body section is used by Symphony's Issue Analyzer prompt only — not
passed to Archon directly. The `$USER_MESSAGE` argument is the Archon context channel.

Example `$USER_MESSAGE` that Archon receives at runtime:
```
Issue: SYM-123 — Fix null pointer in patient ingestion
URL: https://linear.app/thirdopinion/issue/SYM-123
Labels: bug, patient-data
Repo: patient-ingestion — Core ETL pipeline affected by schema change
Components: patient-ingestion-ecs, healthlake-integration
Analysis: ECS task fails when HL7 message missing PID segment
Attempt: first

When a HL7 v2 ADT message is received without a PID.3 field,
the ingestion pipeline throws a NullPointerException at...
```

---

## 20. Setup Wizard

### 20.1 Purpose

Symphony requires two API keys before it can run. The setup wizard is a one-time interactive
CLI command (`symphony setup`) that collects each key via masked input, validates it against
its API, and persists it as a user-level environment variable. Keys are NEVER written to log
files, standard output, error output, or any diagnostic/observability channel. On macOS/Linux
they are intentionally appended to the user's shell profile file (Section 20.4) — that is the
persistence mechanism, not a security violation — but the profile file MUST be protected by
standard Unix `600` permissions and MUST NOT be readable by other users.

### 20.2 Keys Collected

| Env var | Source | Validated by |
|---|---|---|
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API keys | `{ viewer { id email name } }` — prints name/email as confirmation |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | `POST /v1/messages` with `max_tokens: 1` — prints model name as confirmation |

### 20.3 Interaction Contract

```
$ symphony setup

Symphony Setup — API Key Configuration
Keys are stored as user environment variables. They are never logged or displayed.

[1/2] Linear API key
  Enter key (input hidden): ••••••••••••••••••••••
  Validating... ✓  Authenticated as Jane Smith (jane@example.com)

[2/2] Anthropic API key
  Enter key (input hidden): ••••••••••••••••••••••
  Validating... ✓  API key accepted (model: claude-sonnet-4-5)

Saving to user environment variables... ✓

Setup complete. Restart your terminal (or current shell session) for the variables to take
effect, then run: symphony start
```

**Security rules — all MUST be enforced:**
- Input is collected with echo disabled (raw terminal mode / password prompt). Characters
  MUST NOT appear on screen as they are typed.
- The key value MUST NOT appear in any log entry, error message, exception stack trace, or
  diagnostic output at any log level — including `DEBUG`.
- If validation fails, report only that authentication failed (not the key or any fragment of it).
- If the user presses Ctrl-C mid-entry, discard the partial value immediately.
- If a key is already set, prompt: `LINEAR_API_KEY is already set. Overwrite? [y/N]`. Default
  is No — pressing Enter without typing `y` skips that key.

### 20.4 Platform-Specific Storage

Keys are stored as **user-level** (not machine-level) environment variables so they are
scoped to the current OS user and do not require administrator/root privileges.

**Windows:**
```powershell
# PowerShell — does not echo the value; writes to HKCU\Environment
[Environment]::SetEnvironmentVariable("LINEAR_API_KEY", $value, "User")
```
`setx` MUST NOT be used — it echoes the value to stdout.

**macOS / Linux:**

Append to the user's shell profile (`~/.zshrc`, `~/.bashrc`, or `~/.profile` — detected
from `$SHELL` and presence of existing profile files):
```sh
export LINEAR_API_KEY="<value>"
```
The file write uses `O_APPEND` mode. The key value ends up in the profile file, which is
protected by standard Unix file permissions (`600` RECOMMENDED). Symphony SHOULD `chmod 600`
the file after writing if it created it.

### 20.5 Re-running Setup

Running `symphony setup` again:
- Detects existing values and skips them by default (unless user confirms overwrite).
- Does not clear or overwrite keys that are skipped.
- SHOULD offer a `symphony setup --reset` flag to clear all Symphony-managed variables and
  re-enter from scratch.

### 20.6 Validation Failure Handling

If validation of a key fails after entry:
1. Report: `✗ Validation failed — check the key and try again.` (no key value shown)
2. Re-prompt for the same key (up to 3 attempts).
3. After 3 failures, print: `Skipping <VAR_NAME> — you can re-run 'symphony setup' later.`
   and continue to the next key.
4. Symphony will fail at startup with a clear error if a required key is missing.

---

## 21. Command-Line Interface

Symphony exposes a single `symphony` CLI binary for setup, registry management, and runtime
operations. The CLI is the **only** supported way to mutate the `repositories` list in
`WORKFLOW.md`; operators MUST NOT hand-edit that list (Section 21.3).

### 21.1 Command Surface

| Command | Purpose | Section |
|---|---|---|
| `symphony setup` | Interactive API key wizard | Section 20 |
| `symphony init` | Bootstrap a new Symphony deployment (calls `symphony repo add` internally) | 21.2 |
| `symphony repo add <url>` | Register a repository in the Source Registry | 21.3 |
| `symphony repo remove <url\|slug>` | Deregister a repository | 21.4 |
| `symphony repo list` | List registered repositories with sync status | 21.5 |
| `symphony repo scaffold <url>` | Generate a `symphony.md` PR (blocking or async) | 21.6 |
| `symphony scaffold status` | Refresh and list in-flight scaffold jobs | 21.7 |
| `symphony sync` | Run a single Repo Syncer pass on demand | 21.8 |
| `symphony status` | Print runtime snapshot (registry + scaffold jobs + orchestrator) | 21.9 |
| `symphony start` | Start the orchestrator service | (orchestrator entry point) |

All commands accept the global flags `--cwd <path>` (default: current directory; the
directory containing `WORKFLOW.md`) and `--json` (where applicable, produces
machine-readable output).

### 21.2 `symphony init`

Interactive bootstrap wizard. Creates a `WORKFLOW.md` in the current directory and
populates the Source Registry by calling `symphony repo add` for each repository the
operator wants to track.

Behavior:

1. Verify `WORKFLOW.md` does NOT already exist in the working directory. If it exists,
   error and exit — operators MUST edit the file manually rather than risk an accidental
   overwrite.
2. Prompt for tracker configuration: `tracker.kind` (default `linear`),
   `tracker.project_slug`, `tracker.active_states`, `tracker.terminal_states`, and the
   gate state names (`tracker.gate_waiting_state`, `tracker.gate_resume_state`).
3. Prompt for `registry.base_folder` (default: `~/symphony` on macOS/Linux,
   `%USERPROFILE%\symphony` on Windows). Validate that the path is outside the
   current Symphony project directory (Section 5.3.9).
4. Prompt for `archon.default_workflow` (default `symphony/symphony-fix-issue`) and
   `claude.analyzer_model` (default `claude-sonnet-4-5`).
5. Repeatedly prompt: `Add a repository? Enter URL or press Enter to finish:`. For each
   URL entered, invoke `symphony repo add <url>` internally. The wizard MUST NOT bypass
   `symphony repo add`'s validation logic (Section 21.3).
6. Write `WORKFLOW.md` with the collected front matter and `repositories` list.
7. Print next steps:
   ```
   ✓ Created WORKFLOW.md with N repositories.

   Next:
     1. symphony setup     # configure LINEAR_API_KEY and ANTHROPIC_API_KEY
     2. symphony sync      # clone repos and parse symphony.md files
     3. symphony start     # start the orchestrator
   ```

`symphony init` MUST NOT:
- Add workflow templates or write to any repository's `.archon/` directory. Workflows
  live within each repository and are author-managed.
- Overwrite an existing `WORKFLOW.md`.
- Mutate `repositories` directly without going through `symphony repo add`.

### 21.3 `symphony repo add <url>`

The single canonical mechanism for registering a repository in the Source Registry.
Operators MUST NOT hand-edit the `repositories` list in `WORKFLOW.md`; this command runs
all validation consistently and is the only entry point conformant tooling SHOULD
recognize.

Behavior:

1. Validate `<url>` is a valid HTTPS GitHub URL (Section 5.3.10). Reject SSH URLs.
2. Derive the repo slug (last path segment, `.git` suffix stripped). Error if a
   repository with the same slug is already registered or if the same URL appears.
3. Auto-detect the default branch by calling `gh repo view <owner>/<repo>
   --json defaultBranchRef --jq .defaultBranchRef.name`. If the probe fails (network,
   auth, or missing repository), fall back to prompting the operator with `main` as the
   default. The `--no-probe` flag skips this step.
4. Append a new entry `{url, default_branch}` to `WORKFLOW.md`'s `repositories` list,
   preserving formatting and surrounding YAML keys. The write MUST hold the file lock
   defined in Section 21.10.
5. Print confirmation:
   ```
   ✓ Added https://github.com/org/foo (default branch: main) to Source Registry.

   Next:
     symphony sync                                     # clone and parse symphony.md
     symphony repo scaffold https://github.com/org/foo # if no symphony.md exists yet
   ```

Flags:

- `--default-branch <name>` — override automatic detection.
- `--no-probe` — skip the `gh repo view` probe; default branch falls back to `main`
  (or the value of `--default-branch`).

### 21.4 `symphony repo remove <url|slug>`

Removes the matching entry from `WORKFLOW.md`'s `repositories` list. Accepts either a
full URL or a bare slug.

Behavior:

1. Locate the entry by URL or slug. Error if not found.
2. Remove the entry from `WORKFLOW.md` while preserving formatting (file lock, Section
   21.10).
3. Print confirmation. Suggest `symphony sync` to refresh `registry.synced.yaml`.
4. If a scaffold job for the same slug exists in `<base_folder>/scaffold_jobs.yaml`,
   warn the operator and leave the job untouched — operators clear scaffold jobs
   explicitly (Section 21.7.1).

The local checkout under `<base_folder>/repos/<slug>/` is NOT deleted. Preserving it
allows safe re-adding without re-cloning. Operators clean up checkouts manually if
desired.

### 21.5 `symphony repo list`

Prints registered repositories alongside their last known sync status from
`registry.synced.yaml`:

```
URL                                                 DEFAULT  STATUS               LAST SYNCED
https://github.com/org/patient-ingestion-service    main     ok                   2026-05-09T12:00:00Z
https://github.com/org/infra-terraform              main     missing_symphony_md  2026-05-09T12:00:00Z
https://github.com/org/shared-auth-lib              main     ok                   2026-05-09T11:45:00Z
```

If `registry.synced.yaml` does not yet exist, the `STATUS` and `LAST SYNCED` columns
read `(not synced)` and the command prints a hint to run `symphony sync`.

`--json` produces machine-readable output suitable for piping.

### 21.6 `symphony repo scaffold <url>`

Generates a draft `symphony.md` for a registered repository by launching an Archon
workflow (`symphony/symphony-scaffold`) inside the local checkout. The workflow inspects
the repository, drafts a `symphony.md`, and opens a pull request for human review rather
than committing to the default branch.

Preconditions:

- The repository MUST already be registered (run `symphony repo add <url>` first).
- The local checkout MUST exist under `<base_folder>/repos/<slug>/`. If it does not,
  `symphony repo scaffold` performs a single-repo sync to materialize it before invoking
  Archon.

#### 21.6.1 Modes

**Blocking** (default). Symphony invokes `archon workflow run symphony/symphony-scaffold
--cwd <checkout> "<scaffold-prompt>"` synchronously and streams Archon's stdout/stderr to
the operator's terminal. When the Archon process exits with code `0`, Symphony resolves
the PR URL via `gh pr list --head <branch> --repo <owner>/<repo> --state all
--json url,state` (Section 21.6.3) and prints it. If Archon reaches a supervised gate
(`approval_pending` event on stderr — Section 11.3.1), Symphony reports the gate inline
and the operator interacts with the gate directly via `archon workflow approve <run-id>`
or `archon workflow reject <run-id>` (the run ID is also looked up via the algorithm in
Section 21.7).

**Async** (`--async`). Symphony forks `archon workflow run symphony/symphony-scaffold
--cwd <checkout>` as a detached subprocess (`spawn` with `detached: true`,
`stdio: 'ignore'`), records a scaffold job entry (Section 21.6.2), and returns
immediately. Status is queried via `symphony scaffold status` (Section 21.7) or
`symphony status` (Section 21.9).

Flags:

- `--async` — return immediately after launching the Archon subprocess.
- `--branch <name>` — override the branch Archon uses for the scaffold worktree
  (default: `symphony/scaffold-<unix-timestamp>`).
- `--message <text>` — override the user message passed to Archon (default: a built-in
  prompt asking the agent to inspect the repository and produce a `symphony.md` draft
  PR).
- `--from-branch <name>` — passed through to Archon as `--from`. Default: the
  repository's `default_branch`.

Re-running `symphony repo scaffold <url> --async` while a job is already in flight for
the same slug MUST error:

```
Error: A scaffold job is already running for <slug> (started 5m ago, status: running).
       Run 'symphony scaffold status' to inspect, or 'archon workflow abandon <run-id>'
       to cancel before starting a new scaffold.
```

#### 21.6.2 Scaffold Job Persistence

Async scaffold jobs are tracked in a sidecar file owned by Symphony:

**File location**: `<base_folder>/scaffold_jobs.yaml`

**Structure**:

```yaml
jobs:
  - slug: patient-ingestion-service                    # repository slug; primary key
    url: https://github.com/org/patient-ingestion-service
    checkout_path: /home/user/.symphony/repos/patient-ingestion-service
    archon_run_id: null                                # resolved on first status poll
    workflow_name: symphony/symphony-scaffold
    branch: symphony/scaffold-1715284800
    started_at: "2026-05-09T12:00:00Z"
    last_polled_at: null
    last_status: pending                               # pending | running | paused | completed | failed | cancelled | unknown
    pr_url: null                                       # resolved after workflow reaches a terminal state
    last_error: null
```

Why `archon_run_id` is initially `null`: the Archon CLI does NOT print the workflow run
ID to stdout or stderr at launch. Verified against the Archon CLI source at
`packages/cli/src/commands/workflow.ts` in the Archon repository — `workflowRunCommand`
emits only `Running workflow:` / `Working directory:` to stdout and per-node progress
lines (`[<node>] Started`, `[<node>] Completed`, `[<nodeId>] Waiting for approval:`) to
stderr. The run ID is only persisted in Archon's internal SQLite database. Symphony
therefore resolves the run ID lazily by matching `working_path` (Section 21.7).

The file is keyed by repository slug — at most one in-flight scaffold job per
repository. The file MUST be created if missing on first write and MUST be written under
the file lock defined in Section 21.10.

#### 21.6.3 PR URL Resolution

Once the Archon workflow reaches a terminal state, Symphony resolves the PR URL by
calling:

```
gh pr list --head <branch> --repo <owner>/<repo> --state all --json url,state,createdAt
```

Behavior:

- If exactly one PR is returned, store its URL in `pr_url`.
- If multiple PRs match (rare; happens when scaffold is re-run with the same branch
  name), store the most recently created one and emit a warning.
- If none match, leave `pr_url: null` and warn that the workflow may have completed
  without opening a PR. Operators inspect the Archon run artifacts at
  `<checkout>/.archon/artifacts/runs/<run-id>/` for diagnostics.

Symphony does NOT parse Archon's stdout looking for a PR URL — Archon does not surface
artifact URLs on its own output streams.

### 21.7 `symphony scaffold status`

Lists every entry in `<base_folder>/scaffold_jobs.yaml` and refreshes each one. For each
job, Symphony executes the following resolution algorithm:

1. **Resolve `archon_run_id` if null**:
   - Call `archon workflow status --json` once at the start of the command (single
     global call, not per-job; the command returns all active runs).
   - Match the run whose `working_path` equals the job's `checkout_path` AND whose
     `workflow_name` equals the job's `workflow_name` AND whose `started_at` is greater
     than or equal to the job's `started_at`.
   - If exactly one run matches, persist its `id` as `archon_run_id` in the sidecar
     file. If multiple runs match, prefer the one with the latest `started_at` and log
     a warning.
   - If no run matches AND the job's `started_at` is more than 30 seconds in the past,
     mark `last_status: unknown` (the Archon process likely crashed before creating its
     DB row, or the run already terminated and the CLI no longer lists it — see step 2).

2. **Refresh status**:
   - If `archon_run_id` is now known, look up the run in the cached
     `archon workflow status --json` result.
   - If the run still appears, copy its `status` to `last_status` and continue.
   - If the run no longer appears AND `archon_run_id` is known, the run has reached a
     terminal state (`completed`, `failed`, or `cancelled`). Archon's
     `workflow status --json` filters to `running | paused` only (verified in
     `packages/core/src/operations/workflow-operations.ts`, function `getWorkflowStatus`,
     which calls `listWorkflowRuns({ status: ['running', 'paused'], limit: 50 })`).
     Mark `last_status: completed` pending PR resolution; PR URL absence is the signal
     for actual failure if combined with `last_error`.
   - Update `last_polled_at` to the current time.

3. **Resolve PR URL** (Section 21.6.3) when `last_status` transitions to `completed`
   for the first time, or when the operator passes `--refresh-pr`.

4. **Persist** the updated entry back to `scaffold_jobs.yaml` (file lock, Section 21.10).

Output (default):

```
SLUG                          STATUS     RUN ID        AGE     PR URL
patient-ingestion-service     completed  9b1b4a10      5m      https://github.com/org/patient-ingestion-service/pull/42
billing-service               running    7d2c8f31      1m      —
infra-terraform               unknown    —             35s     —
```

Truncated run IDs are display-only; the sidecar file stores full UUIDs.

`--json` produces machine-readable output. `--refresh-pr` forces re-resolution of every
job's PR URL (useful when a PR was opened, closed, and reopened).

#### 21.7.1 Auto-cleanup on Successful Sync

A scaffold job entry is automatically removed from `scaffold_jobs.yaml` when:

- The next `symphony sync` (Section 21.8) — whether triggered manually or by the
  periodic Repo Syncer — successfully parses a `symphony.md` for the same repository
  slug AND the resulting Synced Registry entry has `sync_status: ok`.

Rationale: once the scaffold PR is merged and the new `symphony.md` lands on the default
branch, the next sync pass observes it, registers the repository normally, and clears
the sidecar entry. No operator action required.

The auto-cleanup MUST NOT remove a scaffold job whose `last_status` is `failed`,
`cancelled`, or `unknown` — those terminal failures are kept until an operator
acknowledges them. Operators clear stale entries explicitly:

- Manually edit `scaffold_jobs.yaml` (file lock, Section 21.10), OR
- Run `symphony scaffold cancel <slug>`, which:
  1. If `archon_run_id` is known and the run is still active, calls
     `archon workflow abandon <archon_run_id>`.
  2. Removes the job entry from `scaffold_jobs.yaml`.

### 21.8 `symphony sync`

Triggers a single Repo Syncer pass (Section 6.6) on demand. Useful after `symphony repo
add` or after merging a `symphony.md` PR. Equivalent to the periodic sync that runs at
`registry.sync_interval_ms` cadence, but executed against the local `WORKFLOW.md`
without requiring the orchestrator service to be running.

Flags:

- `--repo <slug>` — sync only the given repository (skips others; useful when iterating
  on a single repo).
- `--quiet` — suppress per-repo progress lines; print only summary.

Exit codes:
- `0` — all repositories synced successfully.
- `1` — at least one repository failed. The Synced Registry is still updated with
  partial results (per-repo `sync_status: error` entries are written for failures).
- `2` — could not acquire the file lock within 10 seconds (Section 21.10).

After a successful pass, `symphony sync` evaluates `scaffold_jobs.yaml` and removes
entries whose corresponding repository now has `sync_status: ok` (Section 21.7.1).

When the orchestrator service is running, `symphony sync` MUST coordinate with the
running Repo Syncer via the file lock to avoid concurrent writes to
`registry.synced.yaml`. The CLI command waits for the in-progress sync to release the
lock, then runs its own pass.

### 21.9 `symphony status`

Prints a runtime snapshot of the Symphony deployment. Composes information from:
- `WORKFLOW.md` (Source Registry)
- `<base_folder>/registry.synced.yaml` (Synced Registry)
- `<base_folder>/scaffold_jobs.yaml` (in-flight scaffold jobs)
- The orchestrator's runtime snapshot endpoint, if the service is running (Section 14.3)

Example output:

```
Symphony Runtime Snapshot
=========================

Source Registry (WORKFLOW.md):
  3 repositories registered.

Synced Registry (registry.synced.yaml):
  Last synced: 2026-05-09T12:00:00Z (3m ago)
  ✓ patient-ingestion-service    (commit abc123de)
  ✓ shared-auth-lib              (commit 789xyz01)
  ⚠ infra-terraform              (missing_symphony_md)

Scaffold Jobs (scaffold_jobs.yaml):
  1 job in flight:
    infra-terraform: running (run-id 9b1b4a10, 5m ago)

Orchestrator:
  Service status:    running (pid 12345)
  Active workers:    2/10
  Supervised gates:  1
  Issue queue:       4 candidates
```

When the orchestrator service is not running, the `Orchestrator` block reports
`Service status: not running` and the worker/gate/queue lines are omitted. The Source
Registry, Synced Registry, and Scaffold Jobs blocks are always populated from disk and
do NOT require the service to be running.

`symphony status` MUST refresh scaffold job statuses inline (running the resolution
algorithm from Section 21.7) before rendering output, so the snapshot reflects the
current Archon state.

`--json` produces machine-readable output.

### 21.10 Concurrency and File Locking

All commands that mutate `WORKFLOW.md`, `<base_folder>/registry.synced.yaml`, or
`<base_folder>/scaffold_jobs.yaml` MUST acquire an advisory file lock before writing.

**Lock file location**: `<base_folder>/.symphony.lock`

**Acquisition contract**:
- Use OS-native advisory locking (`flock(LOCK_EX)` on POSIX,
  `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK)` on Windows). The lock MUST be released on
  process exit, including crashes.
- Symphony writes the holding command's metadata into the lock file body:
  `{pid: 12345, command: "symphony repo add", started_at: "2026-05-09T12:00:00Z"}`.
- Acquisition timeout is 10 seconds. On timeout, the command MUST exit with code `2`
  and print:
  ```
  Error: Could not acquire Symphony file lock at <base_folder>/.symphony.lock.
         Held by 'symphony repo add' (pid 12345) since 2026-05-09T12:00:00Z.
         Wait for it to finish, or remove the lock file if the process is dead.
  ```

The orchestrator service holds this lock briefly during each Repo Syncer write, NOT
continuously. CLI commands and the running orchestrator coexist by serializing on the
same lock.

The `<base_folder>` MUST exist before any locking command runs. `symphony init`,
`symphony repo add`, and `symphony repo scaffold` create it (and `<base_folder>/repos/`)
on demand if missing.

---

## Appendix C. Differences from Base Symphony SPEC.md

| Area                     | Base Symphony (SPEC.md)          | Symphony (this spec)                                     |
|--------------------------|----------------------------------|----------------------------------------------------------|
| Agent runtime            | Codex app-server (subprocess)    | Archon CLI (`archon workflow run`) subprocess            |
| Agent AI model           | OpenAI Codex                     | Anthropic Claude (via Archon)                            |
| Issue routing            | Single workspace per issue       | Claude analyzes issue → routes to 1..N repos             |
| Architecture awareness   | None                             | Federated registry: per-repo `symphony.md` documents     |
| Topology source          | None                             | Source Registry in `WORKFLOW.md` + `symphony.md` files;  |
|                          |                                  | materialized into `<base_folder>/registry.synced.yaml`    |
| Multi-repo               | Not supported                    | Incremental fan-out: 1..N workers, drained across ticks  |
| Workspace model          | Per-issue clone                  | Repo Syncer maintains one clone per repo in Base Folder; |
|                          |                                  | Archon handles per-issue git isolation                   |
| Context injection        | Implementation-defined           | `$USER_MESSAGE` positional arg to `archon workflow run`  |
| Agent launch cwd         | Workspace root                   | `RepoTarget.local_path` (Base Folder clone)              |
| Session ID               | `<thread_id>-<turn_id>`          | `<issue_identifier>__<repo_alias>__<attempt>`            |
| Token tracking           | Codex token counts               | Claude token counts (from Archon if available)           |
| Config: agent section    | `codex:` in front matter         | `archon:` in front matter                                |
| Human interaction        | Implementation-defined           | `loop.interactive` / `approval` gates; Archon pauses,    |
|                          |                                  | Symphony bridges gate to Linear, injects human reply     |
| Gate concurrency         | —                                | Paused gates free their concurrency slot (`supervised_gates`) |
| DAG resume on failure    | —                                | Archon handles automatically on re-invocation            |
| New components           | —                                | Issue Analyzer, Repo Registry Loader, Repo Syncer,       |
|                          |                                  | Archon Workflow Executor                                 |
| New config sections      | —                                | `claude:`, `registry:`, `repositories:`, `workflow_templates:` |
| Workflow management      | —                                | Symphony is single source of truth; `workflow_templates/`|
|                          |                                  | synced into every repo's `.archon/workflows/symphony/`   |
| Multi-repo visibility    | —                                | Sub-issues created per repo worker on fan-out > 1;       |
|                          |                                  | gate comments + PR links posted on sub-issues            |
| External CLI dependencies| Git CLI                          | Git CLI + `gh` CLI (Repo Syncer SHA polling)             |
| Recommended language     | Not specified                    | TypeScript on Bun (see Introduction)                     |
