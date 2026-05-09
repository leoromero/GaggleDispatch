# GaggleDispatch

A federated, multi-repository AI coding orchestrator. Implements the **Symphony** specification (`SPEC_SYMPHONY.md`, Draft v2) in TypeScript on Bun.

GaggleDispatch reads work from Linear, analyzes each issue against a federated registry of repository self-descriptions (per-repo `symphony.md` documents), routes the work to the right repositories, and runs Archon-powered Claude workflow sessions in per-issue isolated workspaces.

## What it does

1. **Polls Linear** for active issues assigned to you (or your team).
2. **Analyzes** each issue with Claude against the federated registry to decide which repos and which Archon workflows are relevant.
3. **Fans out** to multiple repos in parallel when an issue spans services (with declared `depends_on` ordering between sub-issues).
4. **Dispatches** `archon workflow run <workflow> --cwd <repo-checkout> "<issue message>"` for each repo target.
5. **Bridges supervised gates**: when an Archon workflow pauses for a human (e.g. clarifying question, approval gate), GaggleDispatch posts a Linear comment, frees the concurrency slot, and waits for the human to reply with `approve` / `reject`.
6. **Reconciles** state every poll: stops workers when issue states change, retries on failure with exponential backoff, refreshes sibling sub-issue readiness, and recovers from crashes via durable Linear labels.

GaggleDispatch is the **scheduler / analyzer / runner**. Linear writes (state changes, comments, labels) belong to GaggleDispatch. Code, git, and PR creation belong to Archon/Claude.

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

# 4. Sync — clones repos, parses each repo's symphony.md, builds the synced registry.
gaggle sync

# 5. For repos missing a symphony.md, scaffold one via Archon (opens a draft PR).
gaggle repo scaffold https://github.com/myorg/shared-auth-lib

# 6. Inspect what GaggleDispatch sees.
gaggle status

# 7. Start the orchestrator.
gaggle start
```

## How the federation works

Every registered repository owns a `symphony.md` at its root that declares:

```yaml
---
name: patient-ingestion-service
description: >
  Receives HL7 FHIR messages over HTTPS, validates them, and publishes
  inbound events to downstream queues.
default_workflow: symphony/symphony-fix-issue
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/symphony-supervised
components:
  - name: patient-ingestion-api
    component_type: ecs_service
    description: REST API surface that accepts FHIR payloads.
    communicates_with:
      - component: ingestion-queue
        method: sqs
        direction: produces
---

# Patient Ingestion Service

(Free-form Markdown narrative consumed verbatim by the Issue Analyzer.)
```

GaggleDispatch's **Repo Syncer** clones each registered repo into `<base_folder>/repos/<slug>/`, polls the remote SHA via `gh api repos/{owner}/{repo}/commits/{branch}`, parses `symphony.md` on changes, and writes the merged result to `<base_folder>/registry.synced.yaml` atomically. Name collisions (repo or component) are detected and surfaced with actionable messages.

The **Issue Analyzer** then sends Claude the full registry context (front matter + narrative for every successfully synced repo) plus the normalized Linear issue, and asks Claude to return a strict JSON `IssueAnalysis` with `repo_targets`, `depends_on`, and `ready_when`.

## CLI reference

| Command | Purpose |
|---|---|
| `gaggle setup` | Interactive API key wizard (LINEAR_API_KEY, ANTHROPIC_API_KEY) |
| `gaggle init` | Bootstrap WORKFLOW.md and workflow_templates/ |
| `gaggle repo add <url>` | Register a repository in the Source Registry |
| `gaggle repo remove <url\|slug>` | Deregister a repository (preserves local checkout) |
| `gaggle repo list [--json]` | List registered repos with sync status |
| `gaggle repo scaffold <url> [--async]` | Generate a draft `symphony.md` PR via Archon |
| `gaggle scaffold status [--json] [--refresh-pr]` | Refresh and list scaffold jobs |
| `gaggle scaffold cancel <slug>` | Abandon a scaffold job |
| `gaggle sync [--repo <slug>] [--quiet]` | Run a single Repo Syncer pass |
| `gaggle status [--json]` | Print runtime snapshot |
| `gaggle start` | Start the orchestrator service |

All commands accept `--cwd <path>` to point at a different project directory.

The CLI is the **only** sanctioned way to mutate `WORKFLOW.md`'s `repositories` list — operators must not hand-edit it. All mutating commands acquire an advisory lock at `<base_folder>/.gaggle.lock` (10s timeout, with informative holder messaging on contention).

## Configuration cheatsheet (WORKFLOW.md)

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: SYM                       # Linear team key
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Closed]
  assigned_to_me: true                    # default — only your issues
  create_sub_issues: true                 # one sub-issue per repo on fan-out > 1
  gate_waiting_state: Waiting for Review  # parked lane on the board
  gate_resume_state: In Progress

polling:
  interval_ms: 30000

agent:
  max_concurrent_agents: 8
  max_retry_backoff_ms: 600000

archon:
  command: archon workflow run
  turn_timeout_ms: 7200000
  stall_timeout_ms: 600000
  default_workflow: symphony/symphony-fix-issue
  gate_timeout_ms: 86400000               # 24h auto-reject for stale gates

claude:
  api_key: $ANTHROPIC_API_KEY
  analyzer_model: claude-sonnet-4-5

workflow_templates:
  path: workflow_templates/               # local, version-controlled with WORKFLOW.md
  target_subdir: symphony                 # synced into <repo>/.archon/workflows/symphony/

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

GaggleDispatch is the **single source of truth** for Symphony-managed Archon workflow YAML files. Edit a file once in `workflow_templates/` and it propagates to every registered repo's `.archon/workflows/symphony/` on the next dispatch.

Default templates created by `gaggle init`:

- `symphony-fix-issue.yaml` — autonomous, with one optional clarifying-question gate
- `symphony-supervised.yaml` — explicit plan-approval gate before any code changes
- `symphony-scaffold.yaml` — drafts a `symphony.md` and opens a PR (used by `gaggle repo scaffold`)

Add your own by dropping new YAML files into `workflow_templates/` and referencing them from a repo's `symphony.md`:

```yaml
default_workflow: symphony/my-custom-workflow
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/my-custom-workflow
```

## Multi-repo fan-out and dependency ordering

When an issue affects multiple repos, the Issue Analyzer returns multiple `RepoTarget` entries. Each becomes its own worker and (by default) its own Linear sub-issue titled `[<repo_alias>] <parent title>`.

Workers can declare `depends_on` and `ready_when`:

- `ready_when: deployed` (default) — wait until the upstream sub-issue carries the `deployed:dev` label (or whichever `tracker.default_ready_env` is configured)
- `ready_when: merged` — wait until the upstream sub-issue reaches a terminal state
- `ready_when: deployed:prod` — wait for production deployment

GaggleDispatch never writes deploy labels — your CI/CD pipeline does. See `SPEC_SYMPHONY.md` Section 7.5 for a GitHub Action sketch.

## Supervised gates (loop.interactive / approval)

When a Symphony workflow pauses at a `loop.interactive` or `approval` node:

1. GaggleDispatch detects the pause from Archon stderr (capturing the run-id UUID).
2. Worker moves from `running` → `supervised_gates`. **The concurrency slot is freed** — a paused process consumes no slot.
3. The gate message is posted as a Linear comment on the (sub-)issue.
4. The `symphony:waiting-human` label is applied; if `tracker.gate_waiting_state` is configured, the issue is moved to that parked lane.
5. GaggleDispatch polls `fetch_issue_comments` every tick. When a human replies with `approve|approved|yes|y|lgtm` or `reject|rejected|no|n|cancel`, GaggleDispatch:
   - Removes `symphony:waiting-human` and restores the active state.
   - Calls `archon workflow approve <run-id> --comment "<reply>"` (or `reject ... --reason ...`).
   - Worker resumes; loop runs the next iteration with `$LOOP_USER_INPUT` set.
6. If `archon.gate_timeout_ms > 0`, gates auto-reject after the timeout.

## Crash safety / startup recovery

GaggleDispatch persists no scheduler state to disk — **Linear labels are the durable record**. On startup it reads:

- `symphony:claimed` issues → reconstructs `state.claimed`
- `symphony:running` (sub-)issues → re-queues each as a crashed worker (the Archon process is gone, so we retry)
- `symphony:queued` (sub-)issues → re-analyzes the parent on the next tick to recover full `RepoTarget` records
- `symphony:waiting-human` (sub-)issues → reconstructs `supervised_gates` (the run-id is lost, so resolution is human-cleanup-only after restart)

**Write-before-launch ordering** is enforced: labels are applied before Archon is launched. If GaggleDispatch crashes between label-write and process-launch, recovery sees the orphaned label and re-queues.

## Project layout

```
GaggleDispatch/
├── src/
│   ├── analyzer/          # Issue Analyzer (Claude routing call)
│   ├── cli/               # All CLI commands (setup, init, repo, sync, status, start, scaffold)
│   ├── config/            # WORKFLOW.md loader, service-config builder, file watcher
│   ├── domain/            # Types, errors
│   ├── executor/          # Archon subprocess executor (gate detection, stall, timeout)
│   ├── orchestrator/      # Tick loop, state machine, fan-out, retry, reconciliation
│   ├── registry/          # Synced registry I/O, Repo Syncer, symphony.md parser, scaffold-jobs
│   ├── tracker/           # Linear adapter (10 ops from Section 12.1)
│   ├── util/              # Logger, lock, paths, fs, subprocess helpers
│   └── workspace/         # Workspace manager, message construction, template sync
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
| `smoke.test.ts`                    | Config loader, `symphony.md` parser, name-collision detection, util helpers, readiness predicate, issue-message construction, orchestrator state init |
| `linear.test.ts`                   | `LinearClient` with `globalThis.fetch` stubbed: viewer/team/state/label resolution, all 10 mutations, GraphQL error propagation, label caching, `ensureSymphonyLabels` |
| `analyzer.test.ts`                 | `IssueAnalyzer` with an injected fake `AnalyzerClient`: clean JSON, ```-fenced JSON, prose-surrounded JSON, alias-only reconciliation, `depends_on` + `ready_when` preservation, alias mismatch dropping, zero-targets failure, malformed-JSON failure, model/max_tokens propagation, SDK-error wrapping, fallback workflow, alias sanitization |
| `executor.test.ts`                 | `RUN_ID_REGEX`, `PAUSE_REGEX`, `detectGatePause`, `tokenizeArchonCommand` (quoting), `buildArchonRunArgv` |
| `orchestrator-helpers.test.ts`     | `classifyApprovalIntent` approve/reject/ambiguous, `findHumanReplyAfter` bot/anonymous filtering and timestamp ordering |
| `orchestrator.test.ts`             | Full-cycle with fakes: `ensureSymphonyLabels` on start, `resolveViewerId` opt-in, label-driven recovery (claimed parents + `[alias]`-prefixed running sub-issues), analysis-cache invalidation on registry change, `stop()` cancels every `LiveSession` |
| `registry-roundtrip.test.ts`       | `registry.synced.yaml` write→load round-trip with all `SyncStatus` values, banner emission, malformed/empty YAML errors; `scaffold_jobs.yaml` round-trip, `upsertJob`/`removeJobBySlug` purity, `loadScaffoldJobs` graceful malformed handling |
| `lock.test.ts`                     | `withLock` returns body value, serializes contention, releases on throw, writes the holder JSON sidecar, `LockTimeout` carries the lock target path |
| `repo-syncer.test.ts`              | End-to-end sync against a local bare git repo with a `node`-based `gh` shim: success, missing `symphony.md`, partial failure, duplicate slug rejection; `applyNameCollisions` edge cases (empty input, mixed status, repo+component name collisions, order preservation) |

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
