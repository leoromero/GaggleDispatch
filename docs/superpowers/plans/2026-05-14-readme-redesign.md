# README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `README.md` as a proper open-source GitHub page with a hero, architecture diagram, Archon DAG explanation, and Symphony extension callouts — followed by the existing reference content in the correct order.

**Architecture:** Single-file rewrite of `README.md`. Four new top sections replace the old opening. Three existing standalone sections are absorbed or removed. Two existing sections get targeted line-level fixes (stale `symphony.md` and `symphony-*` template names). All other existing sections kept verbatim and reordered.

**Tech Stack:** Markdown, Bun (for verifying no build breakage)

**Spec:** `docs/superpowers/specs/2026-05-14-readme-redesign-design.md`

---

## File map

| File | Change |
|---|---|
| `README.md` | Full rewrite — structure below |

### Sections removed from current README

- `## What it does` — replaced by `### What you get` bullets in hero
- `## How the federation works` — replaced by `## How it works`
- `## Multi-repo fan-out and dependency ordering` — absorbed into `## Built on the Symphony specification`
- `## Crash safety / startup recovery` — absorbed into `## How it works` and `## Built on the Symphony specification`

### Sections kept verbatim (reordered)

- `## Requirements`
- `## Quick start`  
- `## Authenticating with Linear`
- `## Configuration cheatsheet (WORKFLOW.md)`
- `## Development` (including test coverage table)
- `## Conformance`
- `## License`

### Sections kept with targeted fixes

- `## CLI reference` — one cell updated: `symphony.md` → `gaggle.md`
- `## Workflow templates` — template names updated: `symphony-*` → `gaggle-*`; `symphony.md` → `gaggle.md`
- `## Supervised gates` — heading and intro line updated to remove stale `loop.interactive` mention; body kept

### Sections added (new)

1. Hero (title + tagline + pitch + what-you-get)
2. `## How it works` (gaggle.md origin + ASCII diagram + state-machine principle)
3. `## The Archon connection` (DAG table + YAML snippet + gate/blocker bridging)
4. `## Built on the Symphony specification` (spec credit + 4 extensions)

### Project layout tree

- `hub/` directory added — currently missing from tree

---

## Task 1: Write the complete new README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README.md with the full rewrite**

Write the following content verbatim to `README.md`:

````markdown
# GaggleDispatch

*Like a paragliding gaggle — each pilot flies their own line, but the formation stays coherent.*

**Multi-repo AI coding orchestrator.** GaggleDispatch reads issues from a project tracker, figures
out which of your repositories are affected, and dispatches AI workflow sessions to work on each
one in parallel. It handles cross-repo dependency ordering, supervised human-approval gates, and
crash recovery. It never writes code itself.

> Built on the [Symphony specification](SPEC_SYMPHONY.md) · Extended for multi-repo federation  
> Default stack: **Linear** (tracker) · **Claude** (analyzer) · **Archon** (executor) — each is
> swappable behind a clean interface.

### What you get

- **Automatic routing** — an AI analyzer reads each repo's `gaggle.md` self-description and
  decides which repos and which workflows an issue requires. No manual triage.
- **Multi-repo fan-out** — one issue spawns sub-issues per repo, dispatched in dependency order,
  with blockers auto-created when an agent detects a cross-repo constraint.
- **Deterministic AI execution** — the executor runs YAML-declared DAG workflows, not open-ended
  agent loops. You know exactly which phases run, in what order, with human-approval gates at
  defined checkpoints.
- **Pluggable adapters** — tracker, AI model, and workflow executor are each defined by a narrow
  interface. Swap Linear for Jira, Claude for another model, or Archon for your own runner without
  touching the orchestration core.

## How it works

### The federated registry — `gaggle.md`

Every registered repository owns a `gaggle.md` at its root: a structured self-description of what
the repo does, its components, and its external dependencies. GaggleDispatch uses this file to
route issues without any central architecture document.

You don't write `gaggle.md` by hand. Run:

```bash
gaggle repo scaffold https://github.com/myorg/my-service
```

Archon launches a Claude agent that reads the repo's source code, maps its components and
integrations, and opens a draft PR with the generated `gaggle.md`. Once merged, GaggleDispatch
syncs it automatically. Every subsequent issue is routed using that living document.

### Orchestration flow

```
                        ┌─────────────────────────────────────────────────────┐
                        │                  GaggleDispatch                     │
                        │                                                     │
  Linear ───issues──▶  │  Analyzer (Claude)                                  │
  (or any tracker)      │    reads gaggle.md ──▶ IssueAnalysis                │
                        │    from every repo         │                        │
                        │                      repo_targets                   │
                        │                      depends_on                     │
                        │                      ready_when                     │
                        │                            │                        │
                        │              ┌─────────────┼─────────────┐          │
                        │              ▼             ▼             ▼          │
                        │          [repo-a]      [repo-b]      [repo-c]       │
                        │         sub-issue     sub-issue     sub-issue       │
                        │              │             │             │          │
                        └──────────────┼─────────────┼─────────────┼──────────┘
                                       │             │             │
                          archon workflow run         │             │
                                       │        (blocked until     │
                                       │         repo-a merged)    │
                                       ▼                           ▼
                               ┌──────────────┐           ┌──────────────┐
                               │   Archon     │           │   Archon     │
                               │  DAG workflow│           │  DAG workflow│
                               │  (YAML-dec.) │           │  (YAML-dec.) │
                               │  classify    │           │              │
                               │  research    │           │              │
                               │  implement ◀─┼── gate ───┼── Linear    │
                               │  validate    │  (human   │   comment   │
                               │  PR + review │   reply)  │             │
                               └──────┬───────┘           └──────┬──────┘
                                      │                          │
                                      ▼                          ▼
                                  GitHub PR                  GitHub PR
                                      │
                               CI/CD pipeline
                               posts deploy label
                               ──▶ unblocks repo-b
```

GaggleDispatch is the **scheduler, analyzer, and runner**. It owns tracker writes (state changes,
comments, labels) and orchestration policy (routing, concurrency, retries, crash recovery). Code,
git, and PR creation belong entirely to the workflow executor.

A core principle from the Symphony specification: **the tracker is the state machine.** No local
database. GaggleDispatch persists no scheduler state to disk — Linear labels (`gaggle:claimed`,
`gaggle:running`, `gaggle:waiting-human`) are the durable record. On crash or restart,
GaggleDispatch reads those labels and reconstructs exactly where it left off.

## The Archon connection

[Archon](https://github.com/coleam00/Archon) is the workflow executor GaggleDispatch dispatches
to. Rather than giving Claude an open-ended chat loop and hoping for the best, Archon runs
**YAML-declared DAG workflows** — directed acyclic graphs where each node is an explicit phase
with defined inputs, outputs, tools, and conditions.

This is what "deterministic AI execution" means in practice:

| Free-form agent loop | Archon DAG workflow |
|---|---|
| LLM decides what to do next | Control flow declared in YAML |
| Any tool at any time | Per-node `allowed_tools` restrictions |
| One growing context window | `context: fresh` per node — no hallucination cascade |
| Untyped natural language between steps | `output_format` JSON schema — downstream nodes get typed data |
| Unbounded retries | `loop` nodes with `max_iterations` cap |
| No defined handoff points | `approval` gate nodes — explicit human checkpoints |

A minimal example from GaggleDispatch's default workflow:

```yaml
- id: classify
  model: haiku
  allowed_tools: []
  output_format:
    type: object
    properties:
      issue_type: { type: string, enum: [bug, feature, enhancement, refactor] }
    required: [issue_type]

- id: investigate
  depends_on: [classify]
  when: "$classify.output.issue_type == 'bug'"
  context: fresh
  prompt: |
    Investigate the root cause. Save findings to ${ARTIFACTS_DIR}/investigation.md.

- id: implement
  depends_on: [investigate]
  model: opus
  loop:
    until: COMPLETE
    max_iterations: 20
    fresh_context: true
```

GaggleDispatch bridges Archon with the tracker on two critical events:

- **Approval gates** — when a workflow hits an `approval` node, GaggleDispatch frees the
  concurrency slot, posts the gate message as a tracker comment, and polls for a human reply.
  `approve` or `reject` resumes the workflow via the Archon API.
- **Cross-repo blockers** — if an agent discovers mid-implementation that it needs a change in
  another repository, it writes a structured `blocker-request.md` and exits. GaggleDispatch
  detects the file, creates the upstream issue in the tracker, marks the current issue as blocked,
  and restarts implementation automatically once the blocker is resolved. The agent never needs to
  know about cross-repo orchestration — it just signals the constraint.

## Built on the Symphony specification

GaggleDispatch implements [**Symphony**](SPEC_SYMPHONY.md), a language-agnostic specification by
Anthropic for orchestrating AI coding agents across a distributed system. The spec defines the
contracts for issue tracking, federated registry, workspace isolation, workflow dispatch, gate
handling, and crash recovery.

GaggleDispatch is a **conforming implementation** — every REQUIRED item in the Symphony spec is
covered — and extends it in four meaningful ways:

### Multi-repo fan-out with self-discovered dependencies

The original Symphony spec targets a single repository per issue. GaggleDispatch removes that
limit. The Issue Analyzer reads every registered repo's `gaggle.md` and returns multiple
`repo_targets` — one Archon session per repo, dispatched in parallel.

Dependency ordering is declared by the analyzer, not hardcoded:

```yaml
repo_targets:
  - repo: shared-auth-lib
    workflow: gaggle/gaggle-fix-issue
  - repo: patient-ingestion-service
    workflow: gaggle/gaggle-fix-issue
    depends_on: [shared-auth-lib]
    ready_when: merged
```

`shared-auth-lib` runs first. `patient-ingestion-service` waits until it reaches the `merged`
state. Your CI/CD pipeline posts the deploy labels; GaggleDispatch watches them.

### Automatic sub-issue creation

When an issue fans out to multiple repos, GaggleDispatch creates a tracker sub-issue per repo —
each titled `[repo-alias] <parent title>`. Sub-issues carry their own labels, state transitions,
and comments, giving the team full per-repo visibility without manual triage.

### Agent-driven blocker creation

If an Archon agent discovers mid-implementation that it needs a change in another repository, it
writes a `blocker-request.md` with a title and description, then exits. GaggleDispatch detects
the file, creates the upstream issue in the tracker, marks the current issue as blocked, and
restarts implementation automatically once the blocker is resolved. The agent never needs to know
about cross-repo orchestration — it just signals the constraint.

### Startup crash recovery via tracker labels

On any restart, GaggleDispatch reads tracker labels to reconstruct full in-flight state — no
local state file, no manual recovery. A crash between label-write and process-launch is safe:
the orphaned label is detected and the work is re-queued on the next tick.

## Requirements

- **Bun** ≥ 1.1.0 ([install](https://bun.sh))
- **git** in PATH
- **gh** ([GitHub CLI](https://cli.github.com/)) authenticated (`gh auth login` or `GH_TOKEN`)
- **Archon CLI** (`archon`) in PATH
- **Linear API key** (Settings → API → Personal API keys)
- **Anthropic API key** (console.anthropic.com)

## Install

```bash
git clone https://github.com/<you>/GaggleDispatch.git
cd GaggleDispatch
bun install
bun link  # makes `gaggle` (and alias `symphony`) available globally
```

Or run any command directly with `bun run src/cli/index.ts <subcommand>`.

## Quick start

```bash
# 1. One-time API key setup (masked input, never logged).
gaggle setup

# 2. Bootstrap a new project — creates WORKFLOW.md and workflow_templates/.
gaggle init

# 3. Register repositories (the only sanctioned way to mutate WORKFLOW.md).
gaggle repo add https://github.com/myorg/patient-ingestion-service
gaggle repo add https://github.com/myorg/shared-auth-lib

# 4. Sync — clones repos, parses each repo's gaggle.md, builds the synced registry.
gaggle sync

# 5. For repos missing a gaggle.md, scaffold one via Archon (opens a draft PR).
gaggle repo scaffold https://github.com/myorg/shared-auth-lib

# 6. Inspect what GaggleDispatch sees.
gaggle status

# 7. Start the orchestrator.
gaggle start
```

## CLI reference

| Command | Purpose |
|---|---|
| `gaggle setup` | Interactive API key wizard (LINEAR_API_KEY, ANTHROPIC_API_KEY) |
| `gaggle init` | Bootstrap WORKFLOW.md and workflow_templates/ |
| `gaggle auth linear` | Run the Linear OAuth authorization flow (when `tracker.auth.mode: oauth`) |
| `gaggle repo add <url>` | Register a repository in the Source Registry |
| `gaggle repo remove <url\|slug>` | Deregister a repository (preserves local checkout) |
| `gaggle repo list [--json]` | List registered repos with sync status |
| `gaggle repo scaffold <url> [--async]` | Generate a draft `gaggle.md` PR via Archon |
| `gaggle scaffold status [--json] [--refresh-pr]` | Refresh and list scaffold jobs |
| `gaggle scaffold cancel <slug>` | Abandon a scaffold job |
| `gaggle sync [--repo <slug>] [--quiet]` | Run a single Repo Syncer pass |
| `gaggle status [--json]` | Print runtime snapshot |
| `gaggle start` | Start the orchestrator service |

All commands accept `--cwd <path>` to point at a different project directory.

The CLI is the **only** sanctioned way to mutate `WORKFLOW.md`'s `repositories` list — operators must not hand-edit it. All mutating commands acquire an advisory lock at `<base_folder>/.gaggle.lock` (10s timeout, with informative holder messaging on contention).

## Authenticating with Linear

GaggleDispatch supports two ways of authenticating against the Linear API.

### API key (default, simplest)

Set `LINEAR_API_KEY` in your environment with a personal API key from Linear → Settings → API → Personal API keys. All API calls (comments, label changes, state transitions) are attributed to that user.

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  # auth section omitted — defaults to mode: api_key
```

### OAuth `actor=app` (recommended for teams)

Acts as a dedicated OAuth application instead of impersonating a personal user. Comments and labels are attributed to the registered app with its own icon and name. Required for team-shared gaggles where you don't want every action coming from one person's account.

**One-time setup**:

1. **Register the OAuth app in Linear** — Settings → API → OAuth applications → Create new application. Set the redirect URI to `http://127.0.0.1:8765/oauth/callback` (or your own; whatever you register here must match `tracker.auth.redirect_uri` exactly).

2. **Save the client_id and client_secret**. Export the secret:
   ```bash
   export LINEAR_OAUTH_CLIENT_SECRET=lin_oauth_csec_xxx
   ```

3. **Configure WORKFLOW.md**:
   ```yaml
   tracker:
     kind: linear
     # api_key still required for backward-compat (validation), but ignored when mode is oauth
     api_key: $LINEAR_API_KEY
     auth:
       mode: oauth
       client_id: lin_oauth_xxx
       # client_secret defaults to $LINEAR_OAUTH_CLIENT_SECRET — env var picks it up
       # redirect_uri defaults to http://127.0.0.1:8765/oauth/callback
       # scopes defaults to [read, write]
   ```

4. **Authorize**:
   ```bash
   gaggle auth linear
   ```
   This opens your browser to Linear's authorize page, captures the redirect, exchanges the code for tokens, and stores them at `~/.config/gaggle/auth.json` (Unix) or `%APPDATA%\gaggle\auth.json` (Windows). The orchestrator refreshes the access token silently on every request — no further interaction is needed unless tokens are revoked.

5. **Run the orchestrator**:
   ```bash
   gaggle start         # or gaggle hub start
   ```

**Troubleshooting**:

- **`Port 8765 is already in use`** — another `gaggle init` or `gaggle auth linear` is running, or a stale process is bound to the port. Stop it and retry, or change `tracker.auth.redirect_uri` to a different port (and update the Linear OAuth app's registered redirect URI to match).
- **`Linear OAuth tokens not found`** — run `gaggle auth linear` to authorize.
- **`Linear HTTP 401` after working previously** — the refresh token was probably revoked in Linear admin. Re-run `gaggle auth linear`.
- **Redirect URI mismatch** — the URI in `tracker.auth.redirect_uri` must match the one registered in your Linear OAuth app character-for-character, including the path and port.

## Configuration cheatsheet (WORKFLOW.md)

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY                # used when auth.mode = api_key (default)
  project_slug: SYM                       # Linear team key
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Closed]
  assigned_to_me: true                    # default — only your issues
  create_sub_issues: true                 # one sub-issue per repo on fan-out > 1
  gate_waiting_state: Waiting for Review  # parked lane on the board
  gate_resume_state: In Progress
  auth:                                   # optional — omit for api_key mode
    mode: oauth                           # api_key | oauth
    client_id: lin_oauth_xxx              # from your Linear OAuth app
    client_secret: $LINEAR_OAUTH_CLIENT_SECRET
    redirect_uri: http://127.0.0.1:8765/oauth/callback
    scopes: [read, write]

polling:
  interval_ms: 30000

agent:
  max_concurrent_agents: 8
  max_retry_backoff_ms: 600000

archon:
  command: archon workflow run
  turn_timeout_ms: 7200000
  stall_timeout_ms: 600000
  default_workflow: gaggle/gaggle-fix-issue
  gate_timeout_ms: 86400000               # 24h auto-reject for stale gates

claude:
  api_key: $ANTHROPIC_API_KEY
  analyzer_model: claude-sonnet-4-5

workflow_templates:
  path: workflow_templates/               # local, version-controlled with WORKFLOW.md
  target_subdir: gaggle                   # synced into <repo>/.archon/workflows/gaggle/

registry:
  base_folder: $GAGGLE_BASE_FOLDER        # MUST be outside this project directory
  sync_interval_ms: 900000                # 15 min
  sync_on_startup: true

repositories:                             # managed by `gaggle repo add/remove`
  - url: https://github.com/myorg/svc-a
    default_branch: main
  - url: https://github.com/myorg/svc-b
    default_branch: main
```

See `SPEC_SYMPHONY.md` Section 6.4 for the full cheatsheet.

## Workflow templates

GaggleDispatch is the **single source of truth** for Archon workflow YAML files. Edit a file once in `workflow_templates/` and it propagates to every registered repo's `.archon/workflows/gaggle/` on the next dispatch.

Default templates created by `gaggle init`:

- `gaggle-fix-issue.yaml` — autonomous, with one optional clarifying-question gate
- `gaggle-supervised.yaml` — explicit plan-approval gate before any code changes
- `gaggle-scaffold.yaml` — drafts a `gaggle.md` and opens a PR (used by `gaggle repo scaffold`)

Add your own by dropping new YAML files into `workflow_templates/` and referencing them from a repo's `gaggle.md`:

```yaml
default_workflow: gaggle/my-custom-workflow
available_workflows:
  - gaggle/gaggle-fix-issue
  - gaggle/my-custom-workflow
```

## Supervised gates

When a workflow pauses at an `approval` node:

1. GaggleDispatch detects the pause from Archon stderr (capturing the run-id UUID).
2. Worker moves from `running` → `supervised_gates`. **The concurrency slot is freed** — a paused process consumes no slot.
3. The gate message is posted as a tracker comment on the (sub-)issue.
4. The `gaggle:waiting-human` label is applied; if `tracker.gate_waiting_state` is configured, the issue is moved to that parked lane.
5. GaggleDispatch polls `fetch_issue_comments` every tick. When a human replies with `approve|approved|yes|y|lgtm` or `reject|rejected|no|n|cancel`, GaggleDispatch:
   - Removes `gaggle:waiting-human` and restores the active state.
   - Calls `archon workflow approve <run-id> --comment "<reply>"` (or `reject ... --reason ...`).
   - Worker resumes with the human reply injected into the next loop iteration.
6. If `archon.gate_timeout_ms > 0`, gates auto-reject after the timeout.

## Project layout

```
GaggleDispatch/
├── src/
│   ├── analyzer/          # Issue Analyzer (Claude routing call)
│   ├── cli/               # All CLI commands (setup, init, repo, sync, status, start, scaffold)
│   ├── config/            # WORKFLOW.md loader, service-config builder, file watcher
│   ├── domain/            # Types, errors
│   ├── executor/          # Archon subprocess executor (gate detection, stall, timeout)
│   ├── hub/               # Multi-workspace hub server, dashboard, SQLite history
│   ├── orchestrator/      # Tick loop, state machine, fan-out, retry, reconciliation
│   ├── registry/          # Synced registry I/O, Repo Syncer, gaggle.md parser, scaffold-jobs
│   ├── tracker/           # Linear adapter (10 ops from Section 12.1)
│   ├── util/              # Logger, lock, paths, fs, subprocess helpers
│   └── workspace/         # Workspace manager, message construction, template sync
├── dashboard/             # Hub dashboard SPA (HTML/CSS/JS)
├── SPEC_SYMPHONY.md       # The specification this codebase implements
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # full suite (124 tests across 9 files)
bun run cli -- --help
```

### Test coverage

| Suite                              | What it covers                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `smoke.test.ts`                    | Config loader, `gaggle.md` parser, name-collision detection, util helpers, readiness predicate, issue-message construction, orchestrator state init |
| `linear.test.ts`                   | `LinearClient` with `globalThis.fetch` stubbed: viewer/team/state/label resolution, all 10 mutations, GraphQL error propagation, label caching, `ensureGaggleLabels` |
| `analyzer.test.ts`                 | `IssueAnalyzer` with an injected fake `AnalyzerClient`: clean JSON, ```-fenced JSON, prose-surrounded JSON, alias-only reconciliation, `depends_on` + `ready_when` preservation, alias mismatch dropping, zero-targets failure, malformed-JSON failure, model/max_tokens propagation, SDK-error wrapping, fallback workflow, alias sanitization |
| `executor.test.ts`                 | `RUN_ID_REGEX`, `PAUSE_REGEX`, `detectGatePause`, `tokenizeArchonCommand` (quoting), `buildArchonRunArgv` |
| `orchestrator-helpers.test.ts`     | `classifyApprovalIntent` approve/reject/ambiguous, `findHumanReplyAfter` bot/anonymous filtering and timestamp ordering |
| `orchestrator.test.ts`             | Full-cycle with fakes: `ensureGaggleLabels` on start, `resolveViewerId` opt-in, label-driven recovery (claimed parents + `[alias]`-prefixed running sub-issues), analysis-cache invalidation on registry change, `stop()` cancels every `LiveSession` |
| `registry-roundtrip.test.ts`       | `registry.synced.yaml` write→load round-trip with all `SyncStatus` values, banner emission, malformed/empty YAML errors; `scaffold_jobs.yaml` round-trip, `upsertJob`/`removeJobBySlug` purity, `loadScaffoldJobs` graceful malformed handling |
| `lock.test.ts`                     | `withLock` returns body value, serializes contention, releases on throw, writes the holder JSON sidecar, `LockTimeout` carries the lock target path |
| `repo-syncer.test.ts`              | End-to-end sync against a local bare git repo with a `node`-based `gh` shim: success, missing `gaggle.md`, partial failure, duplicate slug rejection; `applyNameCollisions` edge cases (empty input, mixed status, repo+component name collisions, order preservation) |

## Conformance

This implementation targets the REQUIRED items in `SPEC_SYMPHONY.md` Section 19.1:

- ✅ Workflow loader with YAML front matter + prompt body split
- ✅ Repo Registry Loader with hot-reload watcher
- ✅ Repo Syncer (clone, gh-api SHA polling, ff-only pull, name collision detection, atomic write)
- ✅ Typed config layer with defaults and `$VAR` resolution (all fields in Section 6.4)
- ✅ Issue Analyzer (Claude with full RegistryContext)
- ✅ Multi-repo incremental fan-out via `pending_targets`
- ✅ Sibling readiness predicate (`depends_on` + `ready_when`)
- ✅ Gate-pause detection from Archon stderr; slot-freeing supervised_gates
- ✅ Gate state-transition support (`gate_waiting_state` / `gate_resume_state`)
- ✅ Linear adapter — all 10 operations
- ✅ Sub-issue creation on fan-out > 1
- ✅ Label-driven startup recovery
- ✅ Workspace template sync (Section 10.5)
- ✅ Workspace hooks with timeout
- ✅ Stall + turn timeout enforcement
- ✅ Exponential retry with cap
- ✅ Reconciliation that stops workers on terminal/non-active state
- ✅ Startup terminal workspace cleanup
- ✅ Structured logs (`issue_id`, `issue_identifier`, `repo_alias`, `session_id`)
- ✅ Full CLI command surface (Section 21)
- ✅ Advisory file locking on all writes (Section 21.10)

## License

MIT
````

- [ ] **Step 2: Verify key sections rendered correctly**

Open `README.md` and confirm:
- Title is `# GaggleDispatch` with italic tagline on next line
- ASCII diagram is inside a fenced code block (no mangled characters)
- `## How it works` comes before `## The Archon connection`
- `## Built on the Symphony specification` comes before `## Requirements`
- `## Multi-repo fan-out and dependency ordering` does NOT appear (absorbed)
- `## Crash safety / startup recovery` does NOT appear (absorbed)
- `## What it does` does NOT appear (replaced by hero bullets)
- `## How the federation works` does NOT appear (replaced by new section)
- CLI table row for scaffold says `gaggle.md` not `symphony.md`
- Workflow templates list `gaggle-fix-issue.yaml`, `gaggle-supervised.yaml`, `gaggle-scaffold.yaml`
- Project layout tree includes `hub/` and `dashboard/`
- Supervised gates heading has no `loop.interactive` reference

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for open-source audience

- Hero section with paragliding tagline, pitch, and what-you-get bullets
- Architecture diagram with tracker-as-state-machine principle
- Archon DAG explanation: free-form loop vs declared workflow table + YAML snippet
- Symphony spec section: 4 GaggleDispatch extensions over the base spec
- Removed absorbed standalone sections (fan-out, crash safety, federation)
- Updated stale symphony.md/symphony-* references to gaggle.md/gaggle-*
- Added hub/ and dashboard/ to project layout tree

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement | Covered in plan |
|---|---|
| Hero with paragliding tagline | ✅ Task 1 Step 1 |
| How it works: gaggle.md origin story | ✅ Task 1 Step 1 |
| How it works: ASCII diagram | ✅ Task 1 Step 1 |
| Tracker-as-state-machine principle | ✅ Task 1 Step 1 |
| Archon: DAG vs loop table | ✅ Task 1 Step 1 |
| Archon: YAML snippet | ✅ Task 1 Step 1 |
| Archon: gate bridging + blocker protocol | ✅ Task 1 Step 1 |
| Symphony: spec credit + conformance | ✅ Task 1 Step 1 |
| Symphony: 4 extensions | ✅ Task 1 Step 1 |
| Pluggable adapters callout in hero | ✅ Task 1 Step 1 |
| Remove absorbed sections | ✅ Task 1 Step 2 verification |
| CLI table: symphony.md → gaggle.md | ✅ Task 1 Step 1 |
| Workflow templates: symphony-* → gaggle-* | ✅ Task 1 Step 1 |
| hub/ added to project layout | ✅ Task 1 Step 1 |
| dashboard/ added to project layout | ✅ Task 1 Step 1 |

**Placeholder scan:** None found.

**Type consistency:** N/A (documentation only).
