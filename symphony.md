---
name: gaggledispatch
description: >
  GaggleDispatch is the top-level orchestration daemon for a federated, multi-repo AI coding
  workflow. It polls Linear for active issues, uses Claude to route each issue to one or more
  registered repositories (via per-repo symphony.md self-descriptions), and dispatches Archon
  workflow runs in isolated per-issue checkouts. It is the single authority for Linear state
  transitions, concurrency management, retry/backoff, and supervised human-gate bridging — it
  never touches code or git history itself; those belong to Archon/Claude.
default_workflow: symphony/symphony-fix-issue
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/symphony-supervised
  - symphony/generate-symphony-md
components:
  - name: gaggledispatch-cli
    component_type: cli
    description: >
      Commander-based CLI (invoked as `gaggle` or `symphony`) that is the sole operator-facing
      surface. Provides setup (API key wizard), init (bootstrap WORKFLOW.md), repo add/remove/list,
      repo scaffold, sync, status, and start subcommands. All mutating commands acquire an advisory
      file lock on <base_folder>/.gaggle.lock before touching WORKFLOW.md or the synced registry.
    communicates_with:
      - component: gaggledispatch-orchestrator
        method: library
        direction: depends_on
      - component: gaggledispatch-repo-syncer
        method: library
        direction: depends_on
      - component: gaggledispatch-registry-loader
        method: library
        direction: depends_on
      - component: gaggledispatch-config-loader
        method: library
        direction: depends_on

  - name: gaggledispatch-orchestrator
    component_type: worker
    description: >
      The core long-running poll loop (started by `gaggle start`). Each tick: reconciles running
      workers (stall detection, state-change cancellation), polls supervised gates for human
      approve/reject replies, drains pending fan-out targets, fetches candidate Linear issues,
      analyzes each with Claude (with TTL cache), and dispatches per-repo workers. Owns all runtime
      state (running sessions, claimed issues, retry queue, supervised gates, sibling sub-issue
      map). On startup, recovers in-flight work from Linear labels (claimed/running/waiting-human)
      without any on-disk scheduler state.
    communicates_with:
      - component: gaggledispatch-linear-tracker
        method: library
        direction: bidirectional
      - component: gaggledispatch-issue-analyzer
        method: library
        direction: depends_on
      - component: gaggledispatch-archon-executor
        method: library
        direction: depends_on
      - component: gaggledispatch-workspace-manager
        method: library
        direction: depends_on
      - component: gaggledispatch-registry-loader
        method: library
        direction: depends_on

  - name: gaggledispatch-issue-analyzer
    component_type: other
    description: >
      Calls the Anthropic Claude API with a system prompt plus a user prompt containing the full
      RegistryContext (every successfully-synced repo's front matter + narrative) and the
      normalized Linear issue. Parses Claude's JSON response into a typed IssueAnalysis with
      repo_targets, depends_on, and ready_when fields. Reconciles Claude's returned aliases
      against the live registry; unmatched targets are dropped with a warning. Wraps the
      Anthropic SDK so tests can inject a fake AnalyzerClient.
    communicates_with:
      - component: anthropic-claude-api
        method: http
        direction: produces
      - component: gaggledispatch-registry-loader
        method: library
        direction: depends_on

  - name: gaggledispatch-archon-executor
    component_type: other
    description: >
      Thin subprocess wrapper that spawns `archon workflow run <workflow> --cwd <checkout>
      "<message>"` via Bun.spawn. Streams stderr line-by-line; resets a stall timer on each
      line; kills the process on stall or turn timeout. Detects gate-pause events by matching a
      UUID pattern + keyword regex on stderr (PAUSE_REGEX). Exposes approve/reject helpers that
      call `archon workflow approve <run-id>` and `archon workflow reject <run-id>`.
    communicates_with:
      - component: archon-cli
        method: subprocess
        direction: produces

  - name: gaggledispatch-linear-tracker
    component_type: other
    description: >
      GraphQL adapter for the Linear API implementing all 10 operations from Symphony spec
      Section 12.1: fetchCandidateIssues, fetchIssuesByStates, fetchIssueStatesByIds,
      createSubIssue, updateIssueState, postComment, applyLabel, removeLabel,
      fetchIssuesByLabel, fetchIssueComments. Caches team, label, and workflow-state IDs
      to avoid redundant lookups. Auto-creates the four symphony state-machine labels on
      startup (symphony:claimed, symphony:queued, symphony:running, symphony:waiting-human).
    communicates_with:
      - component: linear-graphql-api
        method: graphql
        direction: bidirectional

  - name: gaggledispatch-registry-loader
    component_type: other
    description: >
      Reads <base_folder>/registry.synced.yaml and projects it into a typed RegistryContext
      (repositories with sync_status=ok only; others surfaced as warnings). Installs a
      chokidar file watcher on the synced registry file for hot-reload; notifies subscribers
      (the orchestrator invalidates its analysis cache on each reload). Exposes getContext(),
      reload(), on(), and close().
    communicates_with:
      - component: gaggledispatch-synced-registry-file
        method: s3
        direction: reads

  - name: gaggledispatch-repo-syncer
    component_type: worker
    description: >
      Clones and incrementally updates all registered repositories under
      <base_folder>/repos/<slug>/. Uses `gh api repos/{owner}/{repo}/commits/{branch}` to
      poll the remote HEAD SHA; only pulls when the SHA has changed. Parses each repo's
      symphony.md front matter and narrative after every pull. Writes the merged result to
      <base_folder>/registry.synced.yaml atomically under the .gaggle.lock file lock.
      Validates uniqueness of repository names and component names across the federation;
      name collisions downgrade the offending entry to sync_status=error. Runs periodically
      (default 15 min) or on-demand via `gaggle sync`.
    communicates_with:
      - component: github-api
        method: http
        direction: reads
      - component: gaggledispatch-synced-registry-file
        method: s3
        direction: writes
      - component: registered-repos
        method: subprocess
        direction: reads

  - name: gaggledispatch-workspace-manager
    component_type: other
    description: >
      Validates that a RepoTarget's local_path exists, is a git repo, and is inside the
      registry base folder before each dispatch. Runs optional before_run / after_run shell
      hooks with env vars (SYMPHONY_REPO_ALIAS, SYMPHONY_ISSUE_IDENTIFIER, etc.) scoped to
      the repo checkout. Syncs Archon workflow templates from the local workflow_templates/
      directory into each checkout's .archon/workflows/<target_subdir>/ on dispatch.
      Cleans up per-issue auxiliary workspace directories on reconciliation.
    communicates_with:
      - component: gaggledispatch-archon-executor
        method: library
        direction: depends_on
      - component: registered-repos
        method: subprocess
        direction: produces

  - name: gaggledispatch-config-loader
    component_type: other
    description: >
      Parses WORKFLOW.md YAML front matter into a typed ServiceConfig with defaults,
      $VAR environment-variable substitution, and validation. Also installs a chokidar
      hot-reload watcher on WORKFLOW.md so a running orchestrator picks up config changes
      without restart. The WORKFLOW.md file is the single versioned policy document for
      tracker settings, agent concurrency, timeouts, retry limits, model selection, and the
      registered repository list.
    communicates_with:
      - component: gaggledispatch-orchestrator
        method: library
        direction: produces

  - name: gaggledispatch-synced-registry-file
    component_type: other
    description: >
      The <base_folder>/registry.synced.yaml file on disk. Serves as the durable handoff
      between the Repo Syncer (writer) and the Registry Loader (reader). Written atomically
      by the Repo Syncer under a file lock; read and hot-watched by the Registry Loader.
      Not a service — modeled as a component to represent the data dependency boundary.
    communicates_with: []
---

# GaggleDispatch

## Role in the Broader System

GaggleDispatch is the top-level orchestration layer for a distributed, AI-assisted engineering
workflow. It sits *above* all other service repositories — it orchestrates work into them but is
never itself a target of another orchestrator. Every other repository in the system is a potential
dispatch target whose topology is described in its own `symphony.md`.

The system's key property is decentralized topology knowledge: each team owns their repo's
`symphony.md`, and GaggleDispatch stays topology-agnostic. The Repo Syncer assembles the live
picture from git; the Issue Analyzer routes issues against that picture via Claude. Adding a new
service to the orchestrated system requires only registering its URL and ensuring its `symphony.md`
is present — no code changes in GaggleDispatch.

## Key Architectural Decisions

**Federated registry over a central architecture document.** Per-repo `symphony.md` files are the
single source of truth for topology. GaggleDispatch's Repo Syncer assembles a merged
`registry.synced.yaml`; the Registry Loader projects it into a typed `RegistryContext`. Stale
documentation is structurally impossible when the registry is derived from the repos themselves.

**Claude as the router, not routing rules.** The full `RegistryContext` (front matter + narrative
for every synced repo) plus the normalized issue is sent to Claude; Claude returns a JSON
`IssueAnalysis` with typed `RepoTarget` entries including `depends_on` and `ready_when` for
multi-repo dependency ordering. New components are automatically considered once their
`symphony.md` is registered and synced.

**Archon as the execution substrate.** GaggleDispatch does not implement its own agentic loop. It
shells out to `archon workflow run` and monitors stderr for gate-pause events (UUID + keyword
pattern match). This keeps GaggleDispatch thin: it manages concurrency, retry, and observability
while Archon manages the Claude turn loop and tool execution.

**Supervised gates for human checkpoints.** When Archon pauses at an approval gate, GaggleDispatch
frees the concurrency slot, posts a Linear comment, and polls for a human `approve`/`reject` reply.
Stale gates auto-reject after a configurable timeout. Gate state is partially reconstructed from
Linear labels on restart.

**Linear labels as durable crash-recovery state.** GaggleDispatch persists no scheduler state to
disk — Linear labels (`symphony:claimed`, `symphony:running`, `symphony:queued`,
`symphony:waiting-human`) are the authoritative record. On startup, these labels are read to
reconstruct in-flight state; `running` issues are re-queued as crashed workers on the next tick.

**Write-before-launch ordering.** Labels are applied to Linear *before* Archon is launched. If
GaggleDispatch crashes between label-write and process-launch, recovery sees the orphaned label and
re-queues correctly.

## How Components Interact

```
gaggle start
  └─> config-loader         reads WORKFLOW.md → ServiceConfig
  └─> registry-loader       reads registry.synced.yaml → RegistryContext (hot-watched)
  └─> repo-syncer           periodic: gh api SHA check → git pull → writes registry.synced.yaml
  └─> orchestrator
        poll tick:
          reconcile running workers (stall/state-change)
          poll supervised gates (Linear comments → archon approve/reject)
          drain pending fan-out targets
          linear-tracker.fetchCandidateIssues()
          for each issue:
            issue-analyzer.analyze(issue, RegistryContext) → IssueAnalysis
            for each RepoTarget:
              workspace-manager.validateRepoTarget()
              workspace-manager.syncTemplatesIfEnabled()
              workspace-manager.runHook('before_run')
              archon-executor.startArchon() → spawns `archon workflow run`
              linear-tracker.applyLabel(running)
          on gate pause:
            linear-tracker.postComment(gate message)
            archon-executor.archonApprove/archonReject()
          on worker exit:
            linear-tracker.updateIssueState(Done/Cancelled)
            schedule retry with exponential backoff (cap 10 attempts)
```

## Working in This Repo

### Build & Run

```bash
bun install
bun run typecheck          # tsc --noEmit — run this before every commit
bun test                   # 124 tests across 9 suites
bun run src/cli/index.ts --help
```

The runtime is **Bun ≥ 1.1.0**. Do not use Node.js directly — the codebase uses `Bun.spawn`,
`Bun.file`, and Bun's native TypeScript execution.

### Project Layout

```
src/
  analyzer/      issue-analyzer.ts         — Claude routing call
  cli/           index.ts + subcommands     — all CLI entry points
  config/        loader.ts, service-config.ts, watcher.ts
  domain/        types.ts, errors.ts       — all shared types; no logic
  executor/      archon.ts                 — subprocess wrapper
  orchestrator/  orchestrator.ts, worker.ts, state.ts, readiness.ts
  registry/      loader.ts, repo-syncer.ts, symphony-md.ts, synced-registry.ts, scaffold-jobs.ts
  tracker/       linear.ts                 — Linear GraphQL adapter
  util/          logger.ts, lock.ts, paths.ts, fs.ts, subprocess.ts
  workspace/     workspace-manager.ts, templates.ts, message.ts
```

### Configuration

All runtime configuration lives in `WORKFLOW.md` (YAML front matter) at the GaggleDispatch
deployment directory. Key fields:

- `tracker.project_slug` — Linear team key (e.g. `SYM`)
- `tracker.active_states` / `terminal_states` — which Linear states trigger/stop dispatch
- `agent.max_concurrent_agents` — global concurrency cap
- `archon.turn_timeout_ms` / `stall_timeout_ms` — per-run timeouts
- `claude.analyzer_model` — Claude model for issue routing (default `claude-sonnet-4-5`)
- `registry.base_folder` — **must be outside this project directory**; holds repo clones and registry.synced.yaml

`$VAR` references in WORKFLOW.md are resolved from environment variables.

### Important Invariants

- **Never hand-edit `WORKFLOW.md`'s `repositories:` list** — use `gaggle repo add/remove` only.
  These commands hold the `.gaggle.lock` file lock; direct edits race with a running orchestrator.
- **`registry.base_folder` must be outside the GaggleDispatch working directory.** The workspace
  manager enforces that all `local_path` values are inside `<base_folder>/repos/`.
- **Linear label names are load-bearing at startup.** Changing `symphony_labels.*` in WORKFLOW.md
  after issues are in-flight will orphan the labels and break crash recovery. Change only when the
  system is idle.
- **`communicates_with` entries in other repos' `symphony.md` files must use the exact `name`
  values defined in their components.** The Issue Analyzer matches on names; typos result in
  dropped targets.

### Test Strategy

Tests use a mix of unit and integration patterns:

- `linear.test.ts` — stubs `globalThis.fetch`; no real network calls
- `analyzer.test.ts` — injects a fake `AnalyzerClient` interface
- `repo-syncer.test.ts` — uses a local bare git repo + a Node.js `gh` shim binary
- `orchestrator.test.ts` — full tick cycle with fake tracker/analyzer/workspace/registry
- `lock.test.ts` — real filesystem locking with `proper-lockfile`

There is no mocking of the filesystem in registry/config tests — they write to temp directories.

### External Dependencies

| System | Purpose | Auth |
|---|---|---|
| Linear GraphQL API (`api.linear.app/graphql`) | Issue read/write, labels, comments, sub-issues | `LINEAR_API_KEY` env var |
| Anthropic Claude API | Issue routing analysis | `ANTHROPIC_API_KEY` env var |
| Archon CLI (`archon`) | Agentic workflow execution | Must be in PATH |
| GitHub CLI (`gh`) | SHA polling + repo clone for private repos | `gh auth login` or `GH_TOKEN` |
| `git` | Clone, pull, current SHA | Must be in PATH |
