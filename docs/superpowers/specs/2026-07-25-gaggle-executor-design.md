# Gaggle Executor — replacing Archon with an in-house workflow engine

Date: 2026-07-25
Status: Implemented. See §13 for where the build diverged from this design.

**Settled decisions:** in-process engine · PostgreSQL only (no SQLite) · keep Archon's
YAML syntax · bundled command files with per-repo override · `bash:` nodes require
Git Bash on PATH · **clean cut — Archon is removed entirely, no dual-executor flag
and no compatibility shims.**

## 1. Goal

Replace Archon as GaggleDispatch's execution substrate with a first-party workflow
engine that:

- runs YAML-defined DAG workflows where each node is a Claude instance, a shell
  script, a loop, or a human approval gate;
- lets each node **select its context** — which upstream outputs, which prior
  conversation, which artifacts — explicitly;
- persists everything to **PostgreSQL** so runs are **resumable** across
  gate pauses, crashes, and restarts;
- keeps GaggleDispatch's orchestrator, state machine, and Linear integration
  essentially unchanged.

## 2. What Archon does for us today

GaggleDispatch consumes a narrow slice of Archon. The full dependency surface:

| Capability | Where we touch it | Notes |
|---|---|---|
| DAG workflow execution | `archon workflow run <wf> --cwd <path> "<msg>"` | [src/executor/archon.ts:105](../../../src/executor/archon.ts) |
| Run-id discovery | scraped from a log line via `WORKFLOW_RUN_ID_REGEX` | [src/executor/archon.ts:31](../../../src/executor/archon.ts) — brittle |
| Gate pause detection | regex on stderr + HTTP poll | [src/executor/archon.ts:57](../../../src/executor/archon.ts), [src/executor/archon-poller.ts:169](../../../src/executor/archon-poller.ts) |
| Run status API | `GET /api/workflows/runs[/:id]` | [src/executor/archon-client.ts:59](../../../src/executor/archon-client.ts) |
| Approve / reject / cancel / abandon | HTTP POST + `archon workflow approve` subprocess | [src/executor/archon-client.ts:101](../../../src/executor/archon-client.ts), [src/executor/archon.ts:223](../../../src/executor/archon.ts) |
| Git worktree isolation | implicit on `workflow run`; `archon isolation list`, `archon complete` | [src/executor/archon-cleanup.ts:146](../../../src/executor/archon-cleanup.ts) — parses human text |
| Run persistence + resume | `~/.archon/archon.db` (SQLite) or `DATABASE_URL` | we never read it directly |
| Web UI + deep links | `archon serve`, `/runs/{run_id}` | [src/hub/archon-supervisor.ts](../../../src/hub/archon-supervisor.ts) |
| Claude invocation | Claude Agent SDK per node | same SDK we already depend on |
| **Bundled command library** | `command:` nodes in our own templates | **see §3 — the sleeper dependency** |

Config surface: `cfg.archon.{command,api_url,poll_interval_ms,turn_timeout_ms,stall_timeout_ms,default_workflow,gate_timeout_ms,startup_cleanup_age_days}`
([src/config/service-config.ts:260](../../../src/config/service-config.ts)) plus
`HubArchonConfig` ([src/hub/config.ts:24](../../../src/hub/config.ts)).

What we do **not** use, and therefore need not rebuild: Slack/Telegram/Discord/GitHub
chat adapters, `archon chat`, the Codex and Pi providers, Archon's own bundled
workflows, the natural-language approval router, `archon setup`, and the web UI's
authoring features.

## 3. Hidden dependencies — the things that will bite

**3.1 Ten bundled command files we don't own.** Our shipped templates in
[src/cli/templates-default.ts](../../../src/cli/templates-default.ts) reference
`command:` nodes that resolve to **Archon's built-in command library**, not to
anything in this repo:

```
archon-pr-review-scope        archon-code-review-agent      archon-error-handling-agent
archon-test-coverage-agent    archon-comment-quality-agent  archon-docs-impact-agent
archon-synthesize-review      archon-self-fix-all           archon-simplify-changes
archon-issue-completion-report
```

That is the entire post-PR review-and-self-fix phase of both `gaggle-fix-issue`
and `gaggle-supervised`. Cutting Archon means authoring these ourselves. Budget
real effort here — it is prompt-engineering work, not engine work, and it is on
the critical path to feature parity.

**3.2 Archon's private source clone.** Archon keeps its own clone at
`~/.archon/workspaces/<owner>/<repo>/source` and creates worktrees from it, which
forced us to sync workflow templates into a second location
([src/workspace/templates.ts:56](../../../src/workspace/templates.ts)). Owning the
worktree layer deletes that hack outright — worktrees branch straight off the
repo-syncer checkout at `<base_folder>/repos/<slug>`.

**3.3 Text-scraped interfaces.** `parseIsolationList` parses indented human output;
run ids are regex-scraped from log lines; gate pauses are detected by keyword match.
All three vanish when the engine is in-process.

**3.4 The approve split-brain.** Today HTTP `approveRun` stores an approval without
resuming, so we shell out to `archon workflow approve` to preserve the human comment
as `$<gate-id>.output` ([src/executor/archon.ts:214](../../../src/executor/archon.ts)).
One code path in the new engine.

**3.5 Windows.** `bash:` nodes assume `bash -c`. GaggleDispatch runs on Windows.
**Decided: require Git Bash on PATH.** The engine resolves `bash` at startup and
fails fast with an actionable error if it is missing, rather than failing at node 12
of 18. `gaggle doctor` should check for it alongside `git` and `gh`.

## 4. Recommended architecture

**Run the engine in-process, inside the GaggleDispatch daemon, backed by a database.**

```
┌─ gaggle (bun process) ─────────────────────────────────────────┐
│  Orchestrator ── state machine ── effect applier ── Linear     │
│        │                                                        │
│        ▼  WorkflowExecutor (interface)                          │
│  ┌─ src/executor/engine/ ─────────────────────────────────┐    │
│  │  loader     YAML → WorkflowDef, validate DAG            │    │
│  │  planner    topo layers, trigger rules, when-conditions │    │
│  │  runner     node dispatch, substitution, streaming      │    │
│  │  nodes/     prompt · command · bash · script · loop ·   │    │
│  │             approval · cancel                            │    │
│  │  providers/ claude (Agent SDK)                          │    │
│  │  isolation/ git worktree create/list/cleanup            │    │
│  │  store/     postgres.ts (+ memory.ts, a test double)    │    │
│  └─────────────────────────────────────────────────────────┘    │
│  hub/server.ts ── /api/workflows/runs* (read) + dashboard       │
└─────────────────────────────────────────────────────────────────┘
```

Why in-process rather than a replacement daemon:

- We already depend on `@anthropic-ai/claude-agent-sdk` and already invoke it
  directly in [src/analyzer/issue-analyzer.ts](../../../src/analyzer/issue-analyzer.ts).
- Node lifecycle events become **direct callbacks**. No run-id scraping, no HTTP
  poller, no health probe, no adopt-vs-spawn logic, no stall false positives.
  Roughly 600 lines of workaround code in `src/executor/` and `src/hub/` disappear.
- Durability moves to the database, where it belongs. Process liveness stops being
  the unit of run liveness.

The cost: the daemon owns the Claude subprocesses, so a daemon crash interrupts
in-flight nodes. That is what §7 is for — and it is already true of today's watcher.
Keep the engine behind a `WorkflowExecutor` interface so it can be hosted out-of-process
later without touching the orchestrator.

## 5. Workflow schema

**Keep Archon's YAML syntax verbatim for v1.** Our three shipped templates (~1,100
lines) and `.archon/workflows/generate-gaggle-md.yaml` then load unchanged, and the
`.claude/skills/archon/` docs stay accurate as an authoring reference.

Must support in v1 (everything our own workflows use):

| Area | Fields |
|---|---|
| Workflow | `name`, `description`, `provider`, `model`, `interactive`, `worktree.enabled` |
| Node types | `prompt`, `command`, `bash`, `script` (+`runtime`, `deps`), `loop`, `approval`, `cancel` |
| Graph | `depends_on`, `when` (`==` `!=` `<` `>` `<=` `>=`, `&&`/`||`, dot-notation), `trigger_rule` (`all_success`, `one_success`, `none_failed_min_one_success`, `all_done`) |
| Node opts | `model`, `context: fresh\|shared`, `allowed_tools`, `denied_tools`, `output_format`, `timeout`, `idle_timeout`, `retry` |
| Loop | `prompt`, `until`, `max_iterations`, `fresh_context`, `until_bash`, `interactive`, `gate_message` |
| Approval | `message`, `capture_response`, `on_reject.{prompt,max_attempts}` |
| Variables | `$ARGUMENTS`/`$USER_MESSAGE`, `$WORKFLOW_ID`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$CONTEXT`, `$nodeId.output[.field]`, `$LOOP_USER_INPUT`, `$REJECTION_REASON` |

Defer to v2 (unused by our workflows, and each maps 1:1 onto an Agent SDK option —
verified against the installed typings): `hooks`, `mcp`, `skills`, `agents`,
`sandbox`, `effort`, `thinking`, `betas`, `fallbackModel`, `maxBudgetUsd`,
`systemPrompt`, and the `codex` provider.

Discovery is `.gaggle/workflows/` and `.gaggle/commands/`. No `.archon/` fallback —
this repo's `.archon/workflows/generate-gaggle-md.yaml` and `.archon/config.yaml`
are moved once as part of phase 7, and the `.archon/` directory is deleted along
with everything else.

### Command resolution

The ten review commands (§3.1) ship as **bundled defaults compiled into the gaggle
binary**, mirroring how Archon supplies them today — a freshly registered repo gets
the full review phase with no files on disk. Resolution order for `command: <name>`:

1. `<checkout>/.gaggle/commands/<name>.md` — per-repo override
2. bundled default

Per-repo override is the reason this is a command library rather than inlined
prompts: a Rust service and a TypeScript CLI want different review criteria, and
overriding one prompt should not require forking a 550-line workflow. Inlining would
also duplicate all ten prompts across `gaggle-fix-issue` and `gaggle-supervised`,
which share every one of them.

### New: explicit side-effect marking

Add one field Archon lacks, because it is the difference between safe and unsafe
resume:

```yaml
- id: create-pr
  prompt: ...
  side_effects: at_most_once     # default: idempotent
```

An `at_most_once` node that was interrupted mid-flight is **never silently retried**
on resume — the run pauses at a synthetic gate asking the human whether the effect
landed. `create-pr`, `post-summary`, and the Linear-comment bash nodes are the
obvious candidates.

## 6. Context and artifact wiring

This is the part you specifically want, so it gets first-class treatment. Three
independent mechanisms, and a node picks any combination:

**6.1 Output injection (explicit, bounded).** `$nodeId.output` substitutes an
upstream node's full text; `$nodeId.output.field` parses its structured output and
pulls one field. Shell-quoted in `bash:` bodies, raw in `script:` bodies, plain in
prompts. This is how `classify` routes to `investigate` vs `plan`.

**6.2 Conversation inheritance (`context:`).** `fresh` starts a clean Claude session.
`shared` threads the previous node's conversation — implemented with the Agent SDK's
`resume: <session_id>` against the `claude_session_id` persisted on the upstream node
row. Default: `fresh` for nodes in a parallel layer, inherited for sequential chains
(Archon's rule; keep it).

**6.3 Filesystem artifacts (`$ARTIFACTS_DIR`).** A per-run directory created before
node 0. Nodes write there, downstream nodes read there. This is the only channel that
survives `fresh_context: true` loops and process restarts, which is why our
`implement` loop reads `$ARTIFACTS_DIR/investigation.md` on every iteration rather
than depending on conversation state. On resume the same directory is re-bound from
`workflow_runs.artifacts_dir`.

**Proposed v2 addition — declarative inputs.** Make context selection data rather
than prose:

```yaml
- id: implement
  inputs:
    - from: investigate        # upstream node output
    - artifact: investigation.md
    - artifact: prior-review.md
      optional: true
```

The runner assembles a labelled context block and prepends it to the prompt. Same
effect as hand-writing `$investigate.output` today, but machine-readable — the
engine can then validate that every referenced artifact was actually produced, and
the dashboard can show what each node was given.

## 7. Persistence and resumability

### 7.1 Store

**PostgreSQL only.** No SQLite driver, no dual-dialect abstraction. That buys real
`JSONB`, `TIMESTAMPTZ`, transactional multi-row state transitions, conditional
leasing, and `LISTEN/NOTIFY` if we later want push instead of poll for the
dashboard.

Built on **Bun's native SQL driver**, which costs no dependency and gives
parameterization from tagged templates. Migrations are versioned SQL strings in
`store/migrations.ts` rather than `.sql` files on disk, so
`bun build --target=bun` still produces a self-contained binary — a compiled CLI
that must locate a migrations directory at runtime is a deployment footgun.
Ordering and one-time application are unchanged.

A `MemoryStore` implements the same `Store` interface as a test double. It is
not a second backend: it exists so engine semantics can be tested without a
database, and a shared conformance suite runs against both so drift surfaces as
a test failure.

Trade-off accepted: Postgres becomes a hard runtime prerequisite for `gaggle start`.
Mitigate with a `docker-compose.yml` in the repo, a `DATABASE_URL` check in
`gaggle doctor`, and a clear first-run error. `gaggle init` should offer to start
the compose service.

**Scope note.** Five stores are file-backed today and one is already SQLite. §12.2
settles which of those follow the executor into Postgres and which stay on disk,
and why.

### 7.2 Schema

Statuses are TEXT with a CHECK constraint rather than Postgres ENUMs:
`ALTER TYPE ... ADD VALUE` cannot run inside a transaction on older servers,
which would make adding a status a migration hazard for no real benefit.

```sql
CREATE TABLE workflow_runs (
  id                UUID PRIMARY KEY,
  workflow_name     TEXT NOT NULL,
  workflow_source   TEXT NOT NULL,        -- path the YAML was loaded from
  workflow_hash     TEXT NOT NULL,        -- sha256 of normalized YAML; guards resume
  user_message      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending','running','paused','completed','failed','cancelled','interrupted')),
  repo_slug         TEXT,
  working_path      TEXT,                 -- worktree or live checkout
  base_branch       TEXT,
  branch            TEXT,
  artifacts_dir     TEXT,
  env               JSONB NOT NULL DEFAULT '{}',
  metadata          JSONB NOT NULL DEFAULT '{}',  -- { approval: {nodeId,message}, cancel_reason, … }
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,
  lease_owner       TEXT,                 -- "<host>:<pid>" of the executing process
  lease_expires_at  TIMESTAMPTZ           -- heartbeat; expiry ⇒ crashed
);

CREATE TABLE workflow_run_nodes (
  run_id            UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id           TEXT NOT NULL,
  node_type         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending','running','completed','failed','skipped','cancelled','interrupted')),
  attempt           INT NOT NULL DEFAULT 0,
  output            TEXT,                 -- resolves $nodeId.output
  output_json       JSONB,                -- parsed when output_format is set
  error             TEXT,
  claude_session_id TEXT,                 -- context: shared, and mid-node resume
  side_effects      TEXT NOT NULL DEFAULT 'idempotent',
  input_tokens      INT NOT NULL DEFAULT 0,
  output_tokens     INT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE workflow_run_loop_iterations (
  run_id     UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  iteration  INT  NOT NULL,
  output     TEXT,
  user_input TEXT,                        -- $LOOP_USER_INPUT for this iteration
  completed  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id, iteration)
);

CREATE TABLE workflow_run_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id     UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  node_id    TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_approvals (
  id              UUID PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,
  message         TEXT NOT NULL,
  decision        TEXT,                   -- approved|rejected|timeout|NULL while pending
  comment         TEXT,
  rework_attempts INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);

CREATE TABLE worktrees (
  id               UUID PRIMARY KEY,
  repo_slug        TEXT NOT NULL,
  branch           TEXT NOT NULL,
  path             TEXT NOT NULL,
  base_branch      TEXT,
  run_id           UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_slug, branch)
);
```

`workflow_run_events.id` is `BIGINT GENERATED ALWAYS AS IDENTITY`, which gives a
monotonic per-table sequence and removes the hand-maintained `seq` column the
portable draft needed.

Indexes: `workflow_runs(status)`, `workflow_runs(working_path)`,
`workflow_runs(repo_slug, started_at DESC)`, `workflow_run_events(run_id, id)`,
and a partial index `workflow_runs(lease_expires_at) WHERE status = 'running'`
for the startup recovery sweep.

### 7.3 Four levels of resume

| Level | Scenario | Mechanism |
|---|---|---|
| **R1** | Run failed at node N | Re-plan the DAG; nodes with `status='completed'` and matching `workflow_hash` are skipped and their stored `output` reused. Archon parity. |
| **R2** | Run paused at an approval gate, possibly for hours | `status='paused'` + a pending `workflow_approvals` row. `approve(runId, comment)` writes the decision, re-binds the worktree and artifacts dir, and continues from the DAG frontier. **Works across a full daemon restart** — this is the level supervised workflows actually need. |
| **R3** | Daemon crashed mid-node | On startup, runs whose `lease_expires_at` is past with no live owner flip to `interrupted`; their `running` nodes reset to `pending` (idempotent) or park at a synthetic gate (`at_most_once`). Then R1 applies. |
| **R4** | Resume a long AI node without redoing it | Persist the Agent SDK `session_id` per node and resume the conversation via `query({ resume })`. Optimization, not correctness — ship after R1–R3. |

`workflow_hash` is the guard: if the YAML changed since the run started, refuse a
silent resume and require an explicit `--force-resume` that discards cached node
outputs. Otherwise a resumed run mixes outputs from two different workflow versions.

Postgres earns its keep in R3. Claiming a run for execution is a single statement —
`SELECT … WHERE status = 'running' AND lease_expires_at < now() FOR UPDATE SKIP
LOCKED` — which is race-free even if two gaggle daemons ever point at the same
database, and needs no file locking (`proper-lockfile` drops out of this path).

## 8. Isolation

Reimplement `archon isolation` on plain git, recorded in the `worktrees` table:

- create: `git worktree add -b <branch> <path> <base>` from
  `<base_folder>/repos/<slug>`, branch defaulting to `{workflow}-{timestamp}`,
  path under `<base_folder>/worktrees/<slug>/<branch>`;
- `copyFiles` support for git-ignored files (`.env`, `.env.local`);
- `gaggle isolation list --json` — replaces `parseIsolationList` with structured output;
- `gaggle isolation cleanup [days] [--merged]` and `gaggle complete <branch>` —
  keep the existing preserve-if-PR-open policy from
  [src/executor/archon-cleanup.ts](../../../src/executor/archon-cleanup.ts) verbatim;
- resume re-binds the recorded worktree and verifies branch + existence before continuing.

## 9. The integration seam

One interface. The `RunRecord` shape stays structurally close to today's
`ArchonRunRecord` — not for compatibility, but because `state-machine.ts`,
`effect-applier.ts`, `run-registry.ts`, and the startup recovery classifier
genuinely need exactly those fields. Keeping the shape keeps their diffs to renames:

```ts
export interface WorkflowExecutor {
  startRun(req: StartRunRequest, onEvent: (e: RunEvent) => void): Promise<RunHandle>;
  resumeRun(runId: string, onEvent: (e: RunEvent) => void): Promise<RunHandle>;
  approve(runId: string, comment?: string): Promise<void>;   // stores AND resumes
  reject(runId: string, reason?: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  abandon(runId: string): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(filter?: RunFilter): Promise<RunRecord[]>;
}
```

`RunRecord` keeps `{ id, workflow_name, user_message, status, started_at,
completed_at, last_activity_at, working_path, metadata.approval.message }`.

Consequences per file:

| File | Change |
|---|---|
| [src/executor/archon.ts](../../../src/executor/archon.ts) | replaced by `engine/` + a thin adapter; `startRun` returns the run id, so `WORKFLOW_RUN_ID_REGEX` and `detectGatePause` are deleted |
| [src/executor/archon-poller.ts](../../../src/executor/archon-poller.ts) | deleted for in-process runs; a much smaller DB-backed watcher covers runs adopted after restart |
| [src/executor/archon-client.ts](../../../src/executor/archon-client.ts) | reimplemented over `Store`; same method names and shapes |
| [src/executor/archon-cleanup.ts](../../../src/executor/archon-cleanup.ts) | keeps its policy, swaps text parsing for `isolation list --json` |
| [src/hub/archon-supervisor.ts](../../../src/hub/archon-supervisor.ts) | deleted; deep links point at our own dashboard |
| [src/orchestrator/worker.ts](../../../src/orchestrator/worker.ts) | swaps `startArchon` for `executor.startRun`; event names renamed |
| [src/config/service-config.ts](../../../src/config/service-config.ts) | `cfg.archon` → `cfg.executor` (`database_url`, `default_workflow`, timeouts). No alias — `gaggle doctor` errors on a leftover `archon:` block with a pointer to the new key |
| [src/domain/types.ts](../../../src/domain/types.ts) | `RepoTarget.archon_workflow` → `workflow`; `LiveSession.archon_*` → `run_*`; mechanical rename |
| [src/cli/templates-default.ts](../../../src/cli/templates-default.ts) | `command:` targets repointed at first-party commands (§3.1) |

`hub/server.ts` continues to serve `/api/workflows/runs*` from our own store, so
[dashboard/app.js](../../../dashboard/app.js) needs little or no change.

## 10. Delivery plan

Each phase is independently reviewable; the orchestrator only changes in phase 8.

| Phase | Scope | Rough size |
|---|---|---|
| 0 | Define `WorkflowExecutor`; do the mechanical renames (`RepoTarget.archon_workflow` → `workflow`, `LiveSession.archon_*` → `run_*`, `cfg.archon` → `cfg.executor`) as one reviewable commit with the suite green. Keeps the engine diff readable. | S |
| 1 | Postgres store, schema, migration runner, `docker-compose.yml`, `gaggle doctor` checks. | M |
| 1.5 | Migrate the non-executor stores per §12.2: analysis cache, scaffold jobs, synced registry (+ `LISTEN/NOTIFY` replacing the file watcher), hub history off SQLite. Lands independently; must precede phase 8. | M |
| 2 | YAML loader + DAG validator + `gaggle workflow validate`. Must load our 3 existing templates clean. | M |
| 3 | Engine core: topological layers, trigger rules, `when` evaluation, variable substitution, `bash`/`script` nodes, `prompt`/`command` nodes on the Agent SDK, `output_format`. | L |
| 4 | `loop` (incl. `until_bash`, `fresh_context`, interactive) and `approval` (incl. `on_reject`) and `cancel` nodes; gate pause/resume. | L |
| 5 | Worktree isolation, `$ARTIFACTS_DIR`, cleanup commands. | M |
| 6 | Resume R1–R3, leases + heartbeat, startup recovery sweep. | M |
| 7 | Author the 10 bundled command files; port the 3 workflow templates; move `.archon/workflows/generate-gaggle-md.yaml` → `.gaggle/`. | M–L (prompt work) |
| 8 | Delete Archon: `executor/archon*.ts`, `hub/archon-supervisor.ts`, `cfg.archon`, `register-archon-repos.mjs`, `.archon/`, and the README / `gaggle.md` sections describing it. Rewrite `.claude/skills/archon/` as a `gaggle` workflow-authoring skill — we keep the YAML syntax, so the reference content survives; only the CLI and setup guides are replaced. | S |

Critical path is 3 → 4 → 6. Phase 7 is parallelizable and is the most commonly
underestimated item.

### Validating a clean cut

There is no runtime fallback, so validation has to happen **before the branch
merges** — Archon keeps working on `develop` until then. Three gates, in order:

1. **Dry-run mode.** The engine executes the full DAG with AI nodes stripped of
   Write/Edit/Bash and PR creation skipped. Exercises layer ordering, `when`
   conditions, substitution, gate pause/resume, and crash recovery with zero side
   effects. Build this in phase 3 — it is the primary development harness, not just
   a cutover tool.
2. **Kill-and-resume tests.** Hard-stop the process mid-node and assert the run
   completes on restart. One test per resume level (R1–R3) and one per node type.
3. **Live canary on the branch.** Run `gaggle-scaffold` end-to-end against a scratch
   repo (lowest stakes — generates a `gaggle.md`, opens a PR, blocks nobody), then
   `gaggle-fix-issue` on a real but low-priority issue. Only then merge.

Ship phase 8 as its own commit so the deletion is trivially revertable if the canary
surfaces something after merge.

Testing: the existing suite is a strong asset —
[src/\_\_tests\_\_/executor.test.ts](../../../src/__tests__/executor.test.ts),
[archon-poller.test.ts](../../../src/__tests__/archon-poller.test.ts),
[state-machine.test.ts](../../../src/__tests__/state-machine.test.ts), and the
2,400-line [orchestrator.test.ts](../../../src/__tests__/orchestrator.test.ts)
already pin the contract. Add golden-file DAG tests (workflow YAML → planned layer
order) and kill-and-resume tests that hard-stop the process mid-node and assert the
run completes on restart.

## 11. Risks

1. **Command-library parity (§3.1).** Highest-probability schedule risk, and a clean
   cut removes the ability to fall back. Mitigate by authoring the ten commands early
   (phase 7 can start as soon as phase 3 lands) and comparing their output against
   Archon's on the same PR while Archon still runs on `develop`.
2. **Loop-node semantics.** `fresh_context`, `until_bash`, `$LOOP_USER_INPUT`
   visibility on exactly one resumed iteration, and iteration accounting across a
   restart. Pin these with tests taken from the Archon docs table.
3. **Losing upstream improvements.** Archon is actively developed; we take on
   maintenance of the engine, the provider integration, and the isolation layer.
   Balanced against no longer working around a black box we don't control.
4. **Concurrency.** With the engine in-process, `max_concurrent_agents` now bounds
   real subprocesses in our own daemon. Verify memory and file-handle headroom at
   the configured ceiling.
5. **Postgres as a hard prerequisite.** `gaggle start` no longer runs on a bare
   checkout. Ship the compose file and the doctor check in phase 1, not later.

## 12. Decisions

### 12.1 Settled

| # | Decision |
|---|---|
| 1 | **In-process engine** inside the gaggle daemon, behind a `WorkflowExecutor` interface |
| 2 | **PostgreSQL only** — no SQLite driver, no dual-dialect abstraction |
| 3 | **Keep Archon's YAML syntax** — zero rewrite of the ~1,100 lines of shipped templates |
| 4 | **Bundled command files** compiled into the binary, with `.gaggle/commands/` as a per-repo override layer |
| 5 | **`bash:` nodes require Git Bash on PATH**, checked at startup and by `gaggle doctor` |
| 6 | **Clean cut** — no `executor.kind` flag, no config alias, no `.archon/` fallback. Archon is deleted in phase 8 |
| 7 | **Storage boundary** — Postgres for operational state; files only for git-managed config, secrets, and process discovery. See §12.2 |

### 12.2 Storage boundary — what lives where

GaggleDispatch currently spreads state across four storage technologies: YAML files,
JSON files, a SQLite database, and (via Archon) Postgres or SQLite. That sprawl is
the actual problem; "move things to Postgres" is only the answer where it makes the
design simpler. The boundary:

> **Postgres holds operational state the daemon mutates and must reason about
> consistently. Files hold exactly three things: source-of-truth config that is
> git-managed and human-edited, secrets protected by filesystem permissions, and
> process-discovery data that must work before a database connection exists.**

Applying it:

| Store | Today | Decision |
|---|---|---|
| Workflow runs, nodes, events, approvals, worktrees | Archon's DB | **Postgres** — §7.2 |
| Run registry | `<base>/gaggle-runs.json` | **Postgres, and mostly deleted.** It exists to rebind to the right Archon run after a restart ([run-registry.ts:6](../../../src/registry/run-registry.ts)); once we own `workflow_runs` that is a query. Only the retry schedule survives, as a table |
| Analysis cache | `<base>/gaggle-analysis.json` | **Postgres.** Keyed by issue id with a TTL, and expensive to regenerate — it is a Claude call, so durability matters more than lookup speed |
| Scaffold jobs | `<base>/scaffold_jobs.yaml` | **Postgres.** A polled job queue with status transitions. Textbook table |
| Hub history | SQLite ([hub/history.ts](../../../src/hub/history.ts)) | **Postgres.** Already SQL, so the port is mostly dialect — and leaving it is the one outcome strictly worse than either alternative, since it means running two databases |
| Synced registry | `<base>/registry.synced.yaml` | **Postgres** (`repos` + `repo_components`) — reversing the earlier draft, see below |
| Linear OAuth tokens | `auth.json`, chmod 600 | **File** |
| Hub sidecar | `.gaggle/hub.json` | **File** |
| `WORKFLOW.md`, config, workflow + command YAML | files | **File** |

**Why the synced registry moves.** The draft kept it on disk because a file watcher
hot-reloads it ([loader.ts:101](../../../src/registry/loader.ts)). That reasoning was
wrong: `startPeriodicSyncer` and `startRegistryLoader` run in the *same process*
([start.ts:75](../../../src/cli/start.ts)), so in the common path the watcher is the
daemon writing a file in order to notify itself 250 ms later. The one genuine
cross-process case — an operator running `gaggle sync` against a live daemon — is
served better by `LISTEN/NOTIFY` than by chokidar. Moving it also lets the hub and
the analyzer query repos and components with SQL instead of reparsing YAML, and it
puts the registry next to the analyses that are derived from it. Being derived and
regenerable argues that the migration is *cheap*, not that it must stay on disk.

**Why the tokens do not move.** Not inertia — blast radius. A token column in
Postgres is plaintext in `pg_dump` output, in every replica, and reachable by any
role with `SELECT` on the table, including the dashboard's. A chmod-600 file is
readable by one OS user. Encrypting the column would restore parity but needs a key,
which has to live in a file or env anyway, so the file is where the secret ends up
regardless. Revisit only if gaggle ever runs multi-host, and then with a real secret
manager rather than a table.

**Why the sidecar does not move.** It answers "is a daemon running here, and on what
port" — a question that must be answerable before any database connection exists, and
whose answer is meaningless off-host.

**Sequencing.** Phase 1 builds the store, schema, and migration runner. The
non-executor stores migrate in a **phase 1.5** that lands independently: they are
mechanical, off the 3 → 4 → 6 critical path, and keeping them out of the executor PRs
keeps those reviewable.

The plan had 1.5 landing before phase 8, so the deletion commit would remove all
the old persistence at once. In practice it did not — phase 8 went first and 1.5
is partly done, so the tree currently runs Postgres, a SQLite hub history, and
three file stores. That interim state is the cost of the reordering; it is
tolerable because the file stores still work, but it is not where this should
come to rest.

### 12.3 Phase 1.5 status

| Store | State |
|---|---|
| Schema (migrations 002, 003) | **Done.** All tables exist; both Store implementations carry the methods; 82 conformance tests cover them against MemoryStore and real Postgres |
| Analysis cache | **Done.** `analysis-registry.ts` deleted |
| Run registry | **Not started.** `external_key` and `retry_schedule` exist and are tested, but nothing writes them yet. The lookup half should disappear rather than be ported — see above |
| Scaffold jobs | **Not started.** Store methods exist; ~10 CLI call sites still read the YAML file |
| Synced registry | **Not started.** Store methods exist; the repo syncer and loader still use the file, and the chokidar watcher still needs replacing with a poll of `registry_meta.synced_at` |
| Hub history | **Not started.** `hub_*` tables exist; `hub/history.ts` is still SQLite. This is the largest remaining piece because its API is synchronous and making it async ripples into `hub/server.ts` |

**Deviation from the plan:** Bun's SQL driver exposes no `listen`/`notify`, so
the `LISTEN/NOTIFY` this section promised is not reachable without adding a
dependency. Polling the single `registry_meta` marker row achieves the same
thing for the case that motivated it — an operator running `gaggle sync`
against a live daemon — at negligible cost.

**Known collision:** another branch has its own `control_plane` migration
(version 100) and its own `scaffold_jobs` table, with a `workspace` column this
one does not have. The two need reconciling before both land. The conformance
suite now uses a dedicated `gaggle_exec_test` database so they stop colliding
during development.


---

## 13. What actually got built

The design held. This records where the implementation diverged, and what the
tests found along the way — the parts worth knowing before touching this code.

### Divergences

| Design said | Built | Why |
|---|---|---|
| `CREATE TYPE ... AS ENUM` for statuses | `TEXT` + `CHECK` | `ALTER TYPE ADD VALUE` cannot run in a transaction on older servers, making a new status a migration hazard |
| Numbered `migrations/NNN_*.sql` files | Versioned SQL strings in `store/migrations.ts` | `bun build --target=bun` must stay a self-contained binary; locating a migrations directory at runtime is a deployment footgun |
| `postgres` or `pg` npm driver | Bun's built-in SQL | Zero dependency, parameterization from tagged templates |
| Port 5433 | 55432 | 5432 and 5433 were both already bound on the development host |
| Postgres only | Plus a `MemoryStore` test double | Not a second backend — it lets engine semantics be tested with no database. A shared conformance suite runs against both so drift fails a test |
| Workflow-level `interactive:` honoured | Parsed, no behaviour | Vestigial: it existed because an Archon background worker had no channel to deliver a gate message. Gates here always pause the run and persist the prompt |
| `self-fix` / `simplify` marked `at_most_once` | Left idempotent | They re-read state and fix what remains; marking them would force a human into every crash for no gain. Only `create-pr`, `report` and `post-summary` are marked |

### Bugs the tests caught

Each of these would have mattered in production, and none was visible by
reading the code:

1. **`hashWorkflow` excluded every node body.** It used `JSON.stringify(v, keys)`,
   whose replacer-array form is an allowlist applied at *every* nesting level.
   The resume guard would have accepted an edited prompt and reused stale
   cached output.
2. **A node could ignore its timeout entirely.** `proc.kill()` terminates bash
   but not its children, so `sleep 30` outlived the kill and held the stdout
   pipe open — the runner never observed the exit. Fixed with a process-tree
   kill and by letting exit, not the output pumps, drive completion. The shell
   suite went from 61s to 2.5s. The same failure mode then reappeared in the
   crash-recovery test, where a killed child kept renewing its lease.
3. **Resume was a no-op.** `failed` counted as settled and carried forward, so
   every resume re-reported the same failure without retrying anything. Only
   `completed` survives now.
4. **Bun stored JSONB as a string scalar.** `${JSON.stringify(obj)}::jsonb`
   produces a jsonb *string*, not an object; passing the object directly is
   correct. The reader's string-parsing masked it, so the round-trip test
   passed while the stored data was wrong — only the metadata *merge* test
   surfaced it.
5. **Bun rejects array parameters** (`= ANY($1)` → "malformed array literal")
   and **mangles a cast on a placeholder inside `sql.unsafe()`**, silently
   yielding `{}`.
6. **`\$NAME` was still substituted** in shell bodies when escapes were off,
   turning `"\$HOME"` into `"\<value>"`.

### Verification

835 tests. `store-conformance` runs against MemoryStore always and real
Postgres when `TEST_DATABASE_URL` is set. `engine.test.ts` drives the public
`WorkflowExecutor` interface with a stubbed model, covering routing, gates,
loops, retries, resume and dry-run without an API key. `recovery.test.ts` ends
by killing a real child process mid-node and driving the run to completion from
a fresh process against Postgres.

The parity check that phase 7 existed for is in `commands.test.ts`: every
`command:` node in the shipped templates resolves.

### Not done

**§12.2 phase 1.5** — the analysis cache, scaffold jobs, synced registry and
hub history are still on their original storage. The boundary and the reasoning
stand; the migration is independent of the executor and can land separately.
