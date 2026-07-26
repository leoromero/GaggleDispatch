# Gaggle Control Plane — Postgres state machine + dashboard-driven dispatch

**Date:** 2026-07-25
**Status:** Implemented — all phases A–H, including the orchestrator cutover. See
§19 for what was built, where the build departs from this spec, and what remains.
**Companion spec:** [2026-07-25-gaggle-executor-design.md](2026-07-25-gaggle-executor-design.md)
(in-house workflow engine, replaces Archon). The two specs **share one PostgreSQL
database**; see §3 for the coordination contract.

**Settled decisions:** Linear is an import source and a write-only sink, never a
control surface · dispatch happens when an operator clicks, never from a poll ·
one PostgreSQL database shared with the executor · gates are answered in the
dashboard only · Analyze and Start are two separate operator actions.

---

## 1. Goal

Today Linear **is** GaggleDispatch's state machine. Issue labels are the durable
record of where every unit of work sits, the poll loop treats any unlabelled
active issue as a dispatch command, recovery after a restart is reconstructed by
reading `gaggle:*` labels back off the Linear API, and approval gates are resolved
by polling issue comments and asking Claude to classify the human's intent.

Replace that with:

1. **A `tickets` table as the authoritative record.** Linear issues are imported
   into Postgres. Every status decision reads and writes Postgres.
2. **Operator-triggered dispatch.** Importing a ticket starts nothing. An operator
   presses **Analyze** to fan the ticket out into repo targets, reviews the
   fan-out, then presses **Start**. Nothing spawns an agent without a click.
3. **A dashboard that is the control surface**, showing every imported ticket, its
   status, its repo targets, what is running right now, and the open approval
   gates — with the buttons that drive all of it.
4. **Linear reduced to a sink.** We still move an issue's state at milestones and
   post comments (plan summaries, PR links, failures) so the team sees progress in
   Linear. No code path ever *reads* Linear to decide anything.

### Why this is worth doing

The current design has four structural problems that all trace back to the same
root cause:

| Problem | Cause |
|---|---|
| A human moving a Linear label changes engine behaviour, silently | labels are input, not output |
| Recovery reconstructs state from a projection, so drift is unrecoverable | ~400 lines of label classification ([orchestrator.ts:2050](../../../src/orchestrator/orchestrator.ts)) |
| Gate replies need an LLM to guess intent, and can be ambiguous | free-text comments are the input channel ([gate-classifier.ts](../../../src/orchestrator/gate-classifier.ts)) |
| Runs start themselves; an operator can only react | `shouldDispatch()` is the trigger ([orchestrator.ts:373](../../../src/orchestrator/orchestrator.ts)) |

A database with explicit statuses and an explicit operator action removes all four.

---

## 2. What changes, in one picture

```
BEFORE                                    AFTER

Linear                                    Linear
  │ labels = state (read+write)             │ issues (read)          comments,
  │ comments = gate input                   ▼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  state ▲
  ▼                                       ┌──────────────┐  outbox         │
┌──────────────────────┐                  │ ticket sync  │────────────────►┘
│ poll → shouldDispatch│                  └──────┬───────┘
│  → auto-dispatch     │                         ▼
│                      │                  ┌─────────────────────────────┐
│ in-memory Maps       │                  │  PostgreSQL                 │
│ 5 JSON/YAML files    │                  │  tickets · ticket_targets   │
│ 1 SQLite file        │                  │  control_events · outbox    │
└──────────────────────┘                  │  workflow_runs (executor)   │
        │                                 └───────┬──────────────┬──────┘
        ▼                                         │ reconcile    │ read
  dashboard (read-only)                    ┌──────▼──────┐  ┌────▼─────────┐
                                           │ gaggle      │  │ dashboard    │
                                           │ daemon      │  │ (read+write) │
                                           │ drains      │  │ Analyze/Start│
                                           │ ready work  │  │ Approve/etc  │
                                           └─────────────┘  └──────────────┘
```

The daemon no longer decides *what* to work on. It reconciles: it drains targets
an operator has marked `ready`, subject to the concurrency limit, and reflects run
outcomes back into the tables. All intent enters through the dashboard as a status
write.

**Consequence worth stating plainly:** every run now requires a human click. That
is the requested change, but it removes today's fire-and-forget ergonomics (label
an issue in Linear from your phone, come back to a PR). §12 records a deferred
per-repo `auto_start` opt-in for teams that want the old behaviour back on
low-risk repos.

---

## 3. Shared-database coordination with the executor spec

Both specs land on branches off `develop` and both need the same Postgres
instance. The contract:

**Ownership.** The executor branch owns `src/store/client.ts` (connection pool,
transaction helper) and `src/store/migrate.ts` (numbered migration runner), plus
`docker-compose.yml` and the `gaggle doctor` database check. This spec **consumes**
them. If this branch is ready to land first, it creates those files against the
contract below and the executor branch adopts them instead of writing its own.

**Store contract this spec depends on:**

```ts
// src/store/client.ts
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;   // rolls back on throw
  close(): Promise<void>;
}
export function openDb(url: string): Db;
```

**Migration number ranges** — mechanical, so the two branches never collide on a
filename:

| Range | Owner |
|---|---|
| `001`–`099` | executor: `workflow_runs`, `workflow_run_nodes`, `workflow_run_loop_iterations`, `workflow_run_events`, `workflow_approvals`, `worktrees` |
| `100`–`199` | this spec: `tickets`, `ticket_targets`, `control_events`, `tracker_outbox`, `scaffold_jobs` |
| `200`–`299` | hub history migration (§10) |
| `300`+ | cross-cutting migrations that require both halves present |

**Cross-table foreign keys are deferred to the 300 range.** `ticket_targets.run_id`
is declared as a bare `UUID` in migration `10x`, and `300_link_runs.sql` adds
`REFERENCES workflow_runs(id) ON DELETE SET NULL` once both halves exist. This
makes migration order irrelevant and lets either branch merge first.

**Config key.** One key names the database: `cfg.database.url` (env override
`DATABASE_URL`). Both specs read it. If the executor branch has already landed
`cfg.executor.database_url`, this spec adopts that name rather than adding a
second key — whichever merges first wins, and the second rebases. This is the
only naming decision that must be reconciled between the branches.

**Prerequisite:** PostgreSQL ≥ 13 (for built-in `gen_random_uuid()` and
`GENERATED ALWAYS AS IDENTITY`).

---

## 4. Schema

### 4.1 `tickets`

One row per imported tracker issue. `status` is the authoritative parent-level
state; it replaces `ParentState` and the `gaggle:analyzing` / `gaggle:claimed`
labels.

```sql
CREATE TYPE ticket_status AS ENUM (
  'imported',            -- synced from the tracker; nothing done
  'analysis_requested',  -- operator pressed Analyze; daemon has not claimed it
  'analyzing',           -- IssueAnalyzer running
  'analyzed',            -- fan-out in ticket_targets, awaiting Start  ← the manual gate
  'analysis_failed',     -- analyzer errored or matched zero repos
  'running',             -- >=1 target dispatched, not all terminal
  'done',                -- all targets succeeded
  'cancelled',           -- operator cancelled
  'archived'             -- dismissed without running, or terminal in the tracker
);

CREATE TABLE tickets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace            TEXT NOT NULL,          -- hub workspace / gaggle name
  tracker_kind         TEXT NOT NULL DEFAULT 'linear',
  external_id          TEXT NOT NULL,          -- Linear issue id
  identifier           TEXT NOT NULL,          -- e.g. GAG-123
  title                TEXT NOT NULL,
  description          TEXT,
  priority             INT,
  url                  TEXT,
  branch_name          TEXT,
  parent_external_id   TEXT,                   -- set for tracker sub-issues
  external_state       TEXT NOT NULL,          -- tracker workflow state name
  external_labels      JSONB NOT NULL DEFAULT '[]',
  blocked_by           JSONB NOT NULL DEFAULT '[]',   -- BlockerRef[]
  status               ticket_status NOT NULL DEFAULT 'imported',
  analysis_summary     TEXT,
  complexity           TEXT,                   -- 'simple' | 'complex' | NULL
  analysis_error       TEXT,
  external_created_at  TIMESTAMPTZ,
  external_updated_at  TIMESTAMPTZ,
  first_imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- last appeared in candidate query
  external_terminal_at TIMESTAMPTZ,            -- went terminal in tracker while we ran it
  status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,            -- operator pressed Start
  completed_at         TIMESTAMPTZ,
  UNIQUE (workspace, tracker_kind, external_id)
);
```

`workspace` is a discriminator, not decoration: the hub already manages several
gaggle processes ([hub/process-manager.ts](../../../src/hub/process-manager.ts)),
each with its own registry and tracker team, and they will share one database.

### 4.2 `ticket_targets`

One row per (ticket, repo). Replaces `RepoTarget` in `pending_targets`, the
`gaggle:*` target labels, `gaggle-runs.json`, and the `[alias] title` parsing
contract for sub-issues.

```sql
CREATE TYPE target_status AS ENUM (
  'excluded',      -- operator removed it from the fan-out
  'blocked',       -- upstream sibling or tracker blocker unsatisfied
  'ready',         -- dispatchable; waiting only on a concurrency slot
  'dispatching',   -- daemon is spawning the run
  'running',
  'gate_waiting',
  'succeeded',
  'failed',
  'cancelled'
);

CREATE TABLE ticket_targets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo_alias          TEXT NOT NULL,
  repo_url            TEXT NOT NULL,
  local_path          TEXT NOT NULL,
  workflow            TEXT NOT NULL,           -- operator-editable
  rationale           TEXT,
  components          JSONB NOT NULL DEFAULT '[]',
  depends_on          JSONB NOT NULL DEFAULT '[]',  -- sibling repo_aliases
  ready_when          TEXT,
  status              target_status NOT NULL DEFAULT 'blocked',
  external_target_id  TEXT,                    -- tracker sub-issue id; NULL for mono-repo
  external_target_url TEXT,
  run_id              UUID,                    -- FK added in 300_link_runs.sql
  attempt             INT NOT NULL DEFAULT 0,
  failure_reason      TEXT,
  cancel_requested    BOOLEAN NOT NULL DEFAULT false,
  status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at       TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  UNIQUE (ticket_id, repo_alias)
);
```

`external_target_id` is `NULL` in the mono-repo case, where the target's tracker
issue *is* the ticket. That replaces the `target_issue_id === parent_issue_id`
convention in [state-machine.ts:44](../../../src/orchestrator/state-machine.ts) —
resolution is `COALESCE(external_target_id, tickets.external_id)`.

### 4.3 `control_events`

The audit log. Every transition, whoever caused it. One table serves both levels
(`target_id IS NULL` means ticket-level), so `from_status`/`to_status` are `TEXT`
rather than either enum.

```sql
CREATE TABLE control_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  target_id   UUID REFERENCES ticket_targets(id) ON DELETE CASCADE,
  event_kind  TEXT NOT NULL,          -- 'start_requested', 'worker_started', 'gate_approved', …
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,          -- 'operator' | 'daemon' | 'sync'
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This is a new capability, not a port: today the only record of *why* a target
moved is a log line. The dashboard renders this as a per-ticket timeline.

### 4.4 `tracker_outbox`

Linear writes become durable. Today every tracker call is fire-and-forget with the
failure logged and swallowed ([effect-applier.ts:97](../../../src/orchestrator/effect-applier.ts)),
so a Linear outage silently loses the "moved to Done" write. An outbox row is
inserted **inside the same transaction as the transition**, then drained with
retries.

```sql
CREATE TABLE tracker_outbox (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace   TEXT NOT NULL,
  external_id TEXT NOT NULL,     -- tracker issue to write to
  op          TEXT NOT NULL,     -- 'set_state' | 'post_comment' | 'apply_label' | 'remove_label'
  payload     JSONB NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);
```

Rows are dropped after a configurable number of failed attempts
(`cfg.tracker.outbox_max_attempts`, default 5) with an `error`-level log — the
tracker is a sink, so a permanently-failing write must never block work.

### 4.5 `scaffold_jobs`

Direct port of `scaffold_jobs.yaml`
([registry/scaffold-jobs.ts](../../../src/registry/scaffold-jobs.ts)); same
fields, `run_id UUID` in place of `archon_run_id`, plus a `workspace` column.

### 4.6 Indexes

```sql
CREATE INDEX ON tickets (workspace, status);
CREATE INDEX ON tickets (workspace, external_updated_at DESC);   -- board default sort
CREATE INDEX ON ticket_targets (ticket_id);
CREATE INDEX ON ticket_targets (status) WHERE status IN ('ready','dispatching','running','gate_waiting');
CREATE INDEX ON control_events (ticket_id, id DESC);
CREATE INDEX ON tracker_outbox (id) WHERE sent_at IS NULL;
```

The partial index on `ticket_targets(status)` backs the daemon's hot query; the
partial index on the outbox backs its drain query.

### 4.7 What is **not** migrated

| Store | Decision |
|---|---|
| `<base>/registry.synced.yaml` | **Stays on disk.** Derived output of the repo syncer, human-inspectable, hot-reloaded by a file watcher ([loader.ts:101](../../../src/registry/loader.ts)). Moving it means replacing the watcher with polling for no gain. |
| `auth.json` (chmod 600) | **Stays on disk.** Secrets in a shared database is a different threat model than a 600 file the operator owns. |
| `gaggle-analysis.json` | **Deleted, not migrated** — see §7.3. |
| `gaggle-runs.json` | **Deleted, not migrated** — see §7.2 and §8.3. |

---

## 5. Ticket lifecycle

```
                    ┌─────────────────────────────────────────┐
   sync ───────────►│ imported │                              │
                    └────┬─────┘                              │
        operator: Analyze│  sync: terminal in tracker, from   │
                         │  ANY pre-run status (§7.1 rule 3)  │
                         ▼                                    ▼
              ┌────────────────────┐                    ┌──────────┐
              │ analysis_requested │                    │ archived │◄── operator: Archive
              └─────────┬──────────┘                    └────┬─────┘
              daemon claims                       operator: Restore
                         ▼                                   │
                  ┌───────────┐   error / zero repos    ┌────▼─────┐
                  │ analyzing ├────────────────────────►│ analysis │
                  └─────┬─────┘                         │ _failed  │
                 >=1 target                             └────┬─────┘
                        ▼                     operator: Analyze
                  ┌──────────┐◄──────────────────────────────┘
                  │ analyzed │──── operator: Analyze (re-analyze, replaces targets)
                  └────┬─────┘
        operator: Start│
                       ▼
                 ┌─────────┐  all targets succeeded   ┌──────┐
                 │ running │─────────────────────────►│ done │
                 └────┬────┘                          └──────┘
       operator: Cancel│
                       ▼
                 ┌───────────┐
                 │ cancelled │
                 └───────────┘
```

**`running` is sticky while any target has failed.** If every target is terminal
but at least one failed, the ticket stays `running` so it remains on the operator's
board. This preserves today's behaviour exactly — the parent state machine holds
`claimed` while any target sits in `failed`
([state-machine.ts:428](../../../src/orchestrator/state-machine.ts)).

**Analyze on an `analyzed` ticket** deletes the existing `ticket_targets` rows and
re-runs the analyzer. Refused if any target is non-terminal (409), because
replacing the fan-out under a live run would orphan it.

---

## 6. Target lifecycle

```
 excluded ──include──► blocked ──blockers satisfied──► ready ──slot free──► dispatching
                         ▲                              ▲                        │
                         │ gate: create blocker         │ re-dispatch     run started
                         │                              │                        ▼
              gate_waiting ◄── gate opens ────────────────────────────────── running
                    │  │  │                             │                    │    │
        approve ────┘  │  └── reject (rework) ──────────────────────────────►│    │
                       │      reject (exhausted) / timeout                        │
                       │                    │                    run ok ──► succeeded
                       │                    ▼                                     │
                       │                 failed ◄──────────── run failed ─────────┘
                       │                    │                              │
                       └─► blocked          └─► ready (re-dispatch)        │
                                                                           │
        cancelled ◄── cancel (pre-dispatch: immediate; live: via daemon) ───┘
            └─► ready (re-dispatch)
```

Full transition table:

| From | Event | To |
|---|---|---|
| any pre-dispatch | `exclude_requested` | `excluded` |
| `excluded` | `include_requested` | `blocked` |
| `blocked` | `blockers_satisfied` | `ready` |
| `ready` | `blockers_unsatisfied` | `blocked` |
| `ready` | `dispatch_claimed` (daemon, slot free) | `dispatching` |
| `dispatching` | `run_started` | `running` |
| `dispatching` | `run_failed` (spawn failed) | `failed` |
| `running` | `run_succeeded` | `succeeded` |
| `running` | `run_failed` | `failed` |
| `running` | `gate_opened` | `gate_waiting` |
| `gate_waiting` | `gate_approved` | `running` |
| `gate_waiting` | `gate_rejected`, workflow has `on_reject` with attempts left | `running` |
| `gate_waiting` | `gate_rejected`, no `on_reject` or attempts exhausted | `failed` |
| `gate_waiting` | `gate_blocker_created` | `blocked` |
| `gate_waiting` | `gate_timed_out` | `failed` |
| `excluded`, `blocked`, `ready` | `cancel_requested` | `cancelled` (same transaction) |
| `dispatching`, `running`, `gate_waiting` | `cancel_requested` | status unchanged; `cancel_requested = true` |
| `dispatching`, `running`, `gate_waiting` | `cancel_confirmed` (daemon killed the process) | `cancelled` |
| `failed`, `cancelled` | `redispatch_requested` | `ready` |
| `succeeded` | — | terminal |

### 6.1 Two deliberate behaviour changes

**`queued` splits into `blocked` and `ready`.** Today one state covers both
"waiting on an upstream repo" and "waiting on a free slot", and the dashboard
cannot tell them apart. Since the point of this work is a board that explains
itself, they become distinct. `blocked → ready` is evaluated by the daemon using
`readiness.ts` logic unchanged (§9.4).

**Reject drives the workflow's rework loop instead of parking the target.** Today
`gate_rejected` routes through `retryOrFail` and parks the target in `failed`
([state-machine.ts:616](../../../src/orchestrator/state-machine.ts)). But the
supervised workflow's `plan-gate` explicitly advertises "reject: `<feedback>` —
triggers a revised plan", and the executor spec supports
`approval.on_reject.{prompt,max_attempts}`. So: Reject passes the reason to
`executor.reject(runId, reason)`, the workflow runs its `on_reject` prompt, and the
target stays `running`. Only when the workflow has no `on_reject`, or its
`max_attempts` is exhausted, does the run fail and the target land in `failed`
through the normal path. This makes the engine match what the gate message already
promises the operator.

### 6.2 Cancellation

`POST /api/targets/:id/cancel` sets `cancel_requested = true` and — if the target
is `dispatching` or `running` — leaves the status alone. The owning daemon observes
the flag on its next tick, kills the subprocess, and transitions to `cancelled`.
A pre-dispatch target (`blocked`, `ready`) transitions to `cancelled` immediately
in the same transaction, since no process exists.

Worst-case cancel latency is one tick. §9.6 records `LISTEN/NOTIFY` as the
deferred fix if that proves annoying in practice.

---

## 7. Ticket sync

`syncTickets()` replaces the dispatch half of `tick()`. It runs every
`cfg.polling.interval_ms` and on demand via **Sync now**.

### 7.1 Rules

1. Call `tracker.fetchCandidateIssues()` — **unchanged**
   ([linear.ts:188](../../../src/tracker/linear.ts)). `cfg.tracker.active_states`
   is now purely an *import filter*; it no longer gates dispatch.
2. `INSERT … ON CONFLICT (workspace, tracker_kind, external_id) DO UPDATE` the
   tracker-owned columns: `title`, `description`, `priority`, `url`, `branch_name`,
   `external_state`, `external_labels`, `blocked_by`, `external_updated_at`,
   `last_synced_at`, `last_seen_at`.
3. **Sync never writes `status`**, with two exceptions:
   - Ticket is pre-run (`imported`, `analyzed`, `analysis_failed`) and the tracker
     state is now terminal → `archived`, `actor='sync'`.
   - Ticket is `running` and the tracker state is now terminal → set
     `external_terminal_at` and **do not touch status**. The dashboard shows a
     warning badge; the operator decides whether to cancel.

     *This is a change from today*, where `parent_externally_terminal` cancels the
     work outright. Under operator control, silently killing an in-flight run
     because someone closed a Linear ticket is the wrong default.
4. Tickets that stop appearing in the candidate query keep their row and their
   status. `last_seen_at` going stale is surfaced on the board as a "no longer
   active in Linear" marker — they are ours now, not Linear's.
5. **Tracker sub-issues are not imported as tickets.** Rows where
   `parent_external_id` matches a known ticket are skipped: the fan-out lives in
   `ticket_targets`. This deletes the `[alias] title` string-parsing contract
   (`parseAliasFromTitle`, `shouldDispatchSubIssue`, `dispatchSubIssueFromPoll`,
   `buildRepoTargetFromSubIssue`).

Sub-issue *creation* is unchanged — we still create them when a ticket fans out to
multiple repos, because that is how the team sees per-repo progress in Linear. We
just never read them back as dispatch commands.

### 7.2 Deleted: the PR-linked re-dispatch guard

`hasLinkedGitHubPR()` exists solely because Linear's GitHub integration can move
an issue backwards from `In Review` to `In Progress`, which today looks like a
fresh dispatch command ([orchestrator.ts:442](../../../src/orchestrator/orchestrator.ts)).
Once nothing dispatches without a click, an issue moving backwards in Linear is
just a `external_state` column update. The guard, and its per-tick Linear API
call, are deleted.

### 7.3 Deleted: the analysis cache

`gaggle-analysis.json` and its TTL exist so a re-dispatch can reuse an expensive
Claude call. The analysis now *is* `tickets.analysis_summary` + `tickets.complexity`
+ the `ticket_targets` rows, held for the ticket's whole life. Re-analysis is an
explicit button. So `analysis-registry.ts`, `cfg.registry.analysis_cache_ttl_ms`,
`state.analysis_cache`, the `invalidate_analysis_cache` effect, and the registry-
reload cache invalidation hook ([orchestrator.ts:114](../../../src/orchestrator/orchestrator.ts))
all go away.

One behaviour note: today a registry change (a `gaggle.md` edit) invalidates cached
analyses so the next dispatch re-analyses. Now a stale fan-out persists until the
operator presses Analyze again. The board shows `analyzed_at` against the registry's
`last_synced_at` and flags the ticket as "analysis predates a registry change" so
the staleness is visible rather than silent.

---

## 8. Transitions as code

The existing design — pure transition functions returning effects as data, applied
by an `EffectApplier` — is good and is kept. What changes is where state lives and
who calls the functions.

### 8.1 Shared module

`src/control/transitions.ts` holds both transition tables as pure functions:

```ts
export type Actor = 'operator' | 'daemon' | 'sync';

export type TicketEvent =
  | { kind: 'analyze_requested' }
  | { kind: 'analysis_claimed' }
  | { kind: 'analysis_succeeded'; targets: TargetSpec[] }
  | { kind: 'analysis_failed'; error: string }
  | { kind: 'start_requested' }
  | { kind: 'cancel_requested' }
  | { kind: 'archive_requested' }
  | { kind: 'restore_requested' }
  | { kind: 'external_terminal' }
  | { kind: 'targets_settled' };          // recomputed after any target reaches a terminal status

export type TargetEvent =
  | { kind: 'blockers_satisfied' } | { kind: 'blockers_unsatisfied' }
  | { kind: 'dispatch_claimed' }  | { kind: 'run_started'; run_id: string }
  | { kind: 'run_succeeded' }     | { kind: 'run_failed'; reason: string }
  | { kind: 'gate_opened'; approval_id: string; message: string }
  | { kind: 'gate_approved'; comment: string | null }
  | { kind: 'gate_rejected'; reason: string }
  | { kind: 'gate_blocker_created'; blocker: BlockerSpec }
  | { kind: 'gate_timed_out' }
  | { kind: 'cancel_requested' }  | { kind: 'cancel_confirmed' }
  | { kind: 'redispatch_requested' }
  | { kind: 'exclude_requested' } | { kind: 'include_requested' };

export function ticketTransition(from: TicketStatus, ev: TicketEvent, ctx: TicketCtx): Transition;
export function targetTransition(from: TargetStatus, ev: TargetEvent, ctx: TargetCtx): Transition;
```

Illegal pairs throw `InvalidTransitionError`, exactly as today. Both the hub (for
operator actions) and the daemon (for reconciliation) import this module, so an
operator clicking Start twice gets a clean 409 rather than two runs.

### 8.2 The transaction envelope

Every event, from either process, runs the same envelope:

```
BEGIN
  SELECT … FROM ticket_targets WHERE id = $1 FOR UPDATE     -- serialize concurrent clicks
  transition = targetTransition(row.status, event, ctx)      -- throws if illegal
  UPDATE ticket_targets SET status = …, status_changed_at = now(), …
  INSERT INTO control_events (…)
  INSERT INTO tracker_outbox (…)                             -- tracker-facing effects only
  if the target became terminal: re-evaluate the ticket via ticketTransition
COMMIT
then: apply out-of-band effects (spawn worker, cancel subprocess, call executor)
```

`FOR UPDATE` is what makes double-clicks and a hub/daemon race safe. The status
precondition inside the transaction is the idempotency guard.

**Commit before side effects, deliberately.** A crash between the commit and the
spawn leaves a target in `dispatching` with no process — which is precisely what
`dispatching` was designed to represent, and the startup sweep (§9.5) re-dispatches
it. The reverse order would risk a live agent with no record of it.

### 8.3 Effects the applier no longer performs

The `Effect` union in [state-machine.ts:202](../../../src/orchestrator/state-machine.ts)
shrinks. `apply_label`, `remove_label`, `set_linear_state`, and `post_comment`
become outbox inserts inside the transaction. `persist_run`, `delete_run`,
`persist_retry`, `delete_retry`, and `schedule_retry_timer` disappear with the
files and timers behind them. `register_supervised_gate` and
`register_detached_run` disappear because there is no in-memory registry to
register into. What remains is genuinely out-of-band: `spawn_worker`,
`cancel_worker`, `cleanup_workspace`, `create_sub_issue`, `create_blocker_issue`,
`executor_approve`, `executor_reject`, and `log`.

### 8.4 Deleted: the retry queue

Tracing every `scheduleRetry` caller shows the timer machinery has no remaining
purpose:

| Caller | Today | New model |
|---|---|---|
| success path, 1 s "verify" retry ([orchestrator.ts:1547](../../../src/orchestrator/orchestrator.ts)) | `executeRetry` sees `succeeded`, short-circuits, and calls `maybeReleaseClaim` — a deferred parent-completion check, nothing more | parent completion is evaluated in the same transaction as the target's terminal transition |
| `executeRetry`, no slots available | re-queues with the same attempt number | target simply stays `ready`; the drain loop picks it up next tick |
| `executeRetry`, no cached analysis | re-queues after 5 s hoping a re-analysis happened | analysis is a column; the case cannot arise |
| `schedule_retry_timer` effect | never emitted under the no-auto-retry policy | removed from the union |

So `scheduleRetry`, `executeRetry`, `RetryEntry`, `state.retry_attempts`,
`maybeReleaseClaim`, the `retries` half of `gaggle-runs.json`,
`cfg.agent.max_retry_backoff_ms`, and the `retrying` target state are all deleted.
No `retry_schedule` table is created. Retry becomes exactly one thing: an operator
pressing **Re-dispatch**, which moves a `failed` or `cancelled` target back to
`ready`.

---

## 9. The daemon loop

```
tick():
  1. syncTickets()             — tracker → tickets (every cfg.polling.interval_ms)
  2. drainAnalysisRequests()   — claim `analysis_requested`, run IssueAnalyzer
  3. reconcileRuns()           — reflect executor run status into ticket_targets
  4. promoteBlockedTargets()   — blocked → ready when readiness is satisfied
  5. drainReadyTargets()       — ready → dispatching, up to the slot limit
  6. applyCancelRequests()     — honour cancel_requested
  7. drainOutbox()             — send pending tracker writes
```

### 9.1 Claiming work

Steps 2 and 5 claim rows with `FOR UPDATE SKIP LOCKED`, so two daemons pointed at
one database can never double-dispatch:

```sql
SELECT t.* FROM ticket_targets t
  JOIN tickets k ON k.id = t.ticket_id
 WHERE k.workspace = $1 AND t.status = 'ready'
 ORDER BY k.priority NULLS LAST, k.external_created_at
   FOR UPDATE OF t SKIP LOCKED
 LIMIT $2                                    -- $2 = available slots
```

The `ORDER BY` preserves today's `sortForDispatch` ordering (priority, then
creation time) as a SQL clause; the function is deleted.

### 9.2 Analysis

`drainAnalysisRequests` claims `analysis_requested` tickets, transitions to
`analyzing`, calls `IssueAnalyzer.analyze()` — **prompt and code unchanged** — and
writes the result:

- ≥1 target → insert `ticket_targets` (status `blocked`), set `analysis_summary`
  and `complexity`, ticket → `analyzed`.
- 0 targets or a thrown error → ticket → `analysis_failed`, `analysis_error` set.
  Today an analysis failure reverts to `unclaimed` and gets silently re-picked on
  the next tick, burning a Claude call each pass; now it parks visibly and needs a
  click.

Analysis concurrency is bounded by `cfg.agent.max_concurrent_agents`, shared with
worker slots, as today.

### 9.3 Run reconciliation

`reconcileRuns` joins `ticket_targets.run_id` against the executor's
`workflow_runs` / `workflow_approvals` and emits the corresponding target events:
run `paused` with a pending approval → `gate_opened`; `completed` → `run_succeeded`;
`failed`/`cancelled` → `run_failed`.

With the in-process executor this is a **backstop**, not the primary path — the
executor delivers node lifecycle events as direct callbacks (executor spec §4).
It matters for runs adopted after a daemon restart, and it is the whole mechanism
while Archon is still the executor, which lets this spec land independently of the
executor rewrite.

### 9.4 Readiness

`blockersSatisfied` and `repoTargetReady`
([readiness.ts](../../../src/orchestrator/readiness.ts)) keep their logic
**verbatim**. Only the input changes: blockers come from `tickets.blocked_by`
(refreshed by sync) instead of a live Linear response, and sibling states come
from `ticket_targets.status` instead of an in-memory map. `promoteBlockedTargets`
also runs the reverse check, so a target whose upstream regresses returns
`ready → blocked`.

### 9.5 Startup

Recovery becomes a query. `recoverFromLinearLabels()` and its six helpers
(`loadRecoveryContext`, `recoverClaimedParents`, `recoverRunningIssues`,
`recoverQueuedIssues`, `recoverRetryingIssues`, `releaseOrphanedClaims`,
`recoverWaitingIssues`, ~400 lines) plus `classifyParentState` and
`classifyTargetState` and their input types (~100 lines) are deleted. In their
place:

```sql
-- targets the daemon believed were live but whose process is gone
UPDATE ticket_targets SET status = 'ready', attempt = attempt + 1
 WHERE status = 'dispatching' RETURNING *;         -- no process was ever spawned
-- 'running' / 'gate_waiting' targets are re-bound to their workflow_runs row
-- by reconcileRuns; the executor's own lease sweep (executor spec §7.3 R3)
-- decides whether the run is resumable or interrupted.
```

`startupTerminalCleanup()` is deleted — its job was clearing labels off issues
that went terminal while we were down, which sync now handles as an `archived`
transition.

### 9.6 Deferred: push instead of poll

`LISTEN/NOTIFY` on `control_events` would cut operator-action latency from one
tick to milliseconds. Not in v1: the poll is simple, correct, and the tick is
already short. Revisit if the click-to-spawn delay is felt.

---

## 10. Hub history

[hub/history.ts](../../../src/hub/history.ts) is already SQL, on its own SQLite
file, holding `workspaces`, `runs`, `log_events`, `gate_events`, `token_daily`.
Migrating it to Postgres (range `200`–`299`) removes the second database and lets
the board join run history to tickets in one query. The port is mostly dialect:
`INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY`, `TEXT`
timestamps → `TIMESTAMPTZ`, `INSERT OR REPLACE` → `ON CONFLICT DO UPDATE`.

`gate_events` is subsumed by `control_events` and dropped rather than ported. The
`diffGates` inference in [hub/server.ts:133](../../../src/hub/server.ts) — which
watches gates appear and disappear in state snapshots and admits it cannot tell
how they resolved ("recording a generic 'approved' would be wrong") — is deleted.
Gate resolution is now a first-class `control_events` row with the actor and the
comment on it.

Existing history is not migrated. It is observability data; the SQLite file is
left in place for archaeology and the new database starts empty.

---

## 11. Dashboard

### 11.1 Read/write split

**Reads go straight to Postgres from the hub.** The board renders even when every
gaggle process is down, which is a real improvement over today's fan-out to
per-gaggle APIs.

**Writes are status writes to Postgres**, also from the hub. There is deliberately
no command channel to the daemon: Start means "set targets to `ready`", and the
daemon drains them whenever it is running. The one exception is **Sync now**, which
proxies to the owning gaggle's API (following the existing `/redispatch` precedent
at [hub/server.ts:289](../../../src/hub/server.ts)) because it needs the gaggle's
tracker credentials — and it is meaningless when that gaggle is down anyway.

**Live worker telemetry stays on the existing WebSocket** from each gaggle
([hub/gaggle-api.ts](../../../src/hub/gaggle-api.ts)): tokens, turn counts, the
current node, recent output. That is per-process, high-frequency, and does not
belong in the control-plane tables.

### 11.2 API

```
GET   /api/board?workspace=&status=&q=     tickets + nested targets + run summary
GET   /api/tickets/:id                     detail, targets, control_events timeline
POST  /api/tickets/:id/analyze             → analysis_requested
POST  /api/tickets/:id/start               → running; targets → blocked|ready
POST  /api/tickets/:id/cancel
POST  /api/tickets/:id/archive
POST  /api/tickets/:id/restore
POST  /api/targets/:id/start               single target → ready
POST  /api/targets/:id/exclude | /include
POST  /api/targets/:id/cancel              sets cancel_requested
POST  /api/targets/:id/redispatch          failed|cancelled → ready
PATCH /api/targets/:id                     { workflow }
GET   /api/gates                           pending workflow_approvals ⋈ tickets
POST  /api/gates/:id/approve               { comment }
POST  /api/gates/:id/reject                { reason }
POST  /api/gates/:id/create-blocker        { title, description }
POST  /api/sync                            proxied to the owning gaggle
```

Every `POST` returns `409` with the current status when the transition is illegal.

### 11.3 UI

New primary panel, **Board**, above the existing Workers panel:

- Filter chips per status with counts; text search over identifier and title; sort
  by priority or last update.
- A row is one ticket: `GAG-123 · title · priority · Linear state · status pill ·
  target chips (alias + status colour) · actions`.
- Actions are status-dependent: `imported` → **Analyze**, **Archive**; `analyzed` →
  **Start**, **Re-analyze**, **Archive**; `running` → **Cancel**; `analysis_failed`
  → **Retry analysis**.
- Expanding a row shows the targets table (per-target status, workflow — editable
  via a select, run link, per-target actions) and the `control_events` timeline.
- Badges for `external_terminal_at` ("closed in Linear while running") and stale
  `last_seen_at`.

New **Gates** panel: one card per pending approval — ticket, repo, elapsed time,
the gate message rendered as markdown, and **Approve** / **Reject** / a free-text
answer box that is passed through as the approval comment (which is what the
workflow reads as `$<gate-id>.output`).

Workers, Gaggles, and Logs panels are unchanged. The Archon chip in the topbar
([index.html:19](../../../dashboard/index.html)) is removed by the executor spec.

The dashboard stays a no-build-step plain-ES-module SPA
([dashboard/app.js](../../../dashboard/app.js)); the board is new render functions
plus a `board` WebSocket message type. The hub polls the control tables every 2 s
— matching the existing state ticker — and broadcasts when the max
`control_events.id` advances.

### 11.4 Access control

The dashboard becomes a surface that can spawn agents which write code and open
PRs. Today it is read-only. The hub binds to `127.0.0.1` by default
([hub/server.ts:228](../../../src/hub/server.ts)) and that stays the only control:
**v1 adds no authentication.** Anyone who can reach the port can dispatch work.
Exposing the hub beyond loopback requires an auth story and is explicitly out of
scope — `gaggle doctor` should warn when `ui.host` is not a loopback address.

### 11.5 CLI

`gaggle status` currently reconstructs state from `fetchIssuesByLabel`
([cli/status.ts:107](../../../src/cli/status.ts)); it reads the board query
instead. New `gaggle tickets list|show|analyze|start|cancel` subcommands cover the
same actions headlessly.

---

## 12. Linear write-back

Reduced to a sink, driven entirely by the outbox:

| Trigger | Write |
|---|---|
| Gate opens | comment with the gate message **plus a dashboard deep link and an explicit "reply here has no effect — answer in the dashboard" line**; optionally state → `cfg.tracker.gate_waiting_state` |
| Gate resolved | state → `cfg.tracker.gate_resume_state` |
| Plan summary produced | comment (workflow-driven, unchanged) |
| PR opened | comment (workflow-driven, unchanged) |
| Target failed | comment with the reason |
| All targets succeeded | state → `completedState(cfg)` |
| Multi-repo fan-out | create sub-issues (unchanged) |

**Labels become optional and one-way.** `cfg.tracker.mirror_labels` (default
`false`) mirrors the existing `gaggle_labels` set for team visibility in Linear.
The invariant, enforced by review and by there being no reader left in the
codebase: **no code path reads a gaggle label to make a decision.**

The mirror needs only the two write methods, `applyLabel` and `removeLabel`. So
`fetchIssuesByLabel()` — a read, used today only by label recovery, failed-target
polling, and `gaggle status` — is deleted outright, as is `ensureGaggleLabels()`
(the mirror creates labels lazily on first use when enabled).

**Deferred: `auto_start`.** A per-repo or per-label opt-in that sets targets to
`ready` at import, restoring today's fire-and-forget for low-risk repos. Not in
v1 — the whole point is to establish the manual path first. It is a one-line
default change in `syncTickets` once wanted.

---

## 13. Config changes

| Key | Change |
|---|---|
| `cfg.database.url` | **New.** Postgres connection string; `DATABASE_URL` overrides. Shared with the executor spec (§3) |
| `cfg.tracker.mirror_labels` | **New**, default `false` |
| `cfg.tracker.outbox_max_attempts` | **New**, default `5` |
| `cfg.tracker.active_states` | Semantics change: import filter, no longer a dispatch gate |
| `cfg.tracker.gaggle_labels` | Used only by the optional mirror |
| `cfg.claude.gate_classifier_model` | **Deleted** — no intent classification |
| `cfg.registry.analysis_cache_ttl_ms` | **Deleted** (§7.3) |
| `cfg.agent.max_retry_backoff_ms` | **Deleted** (§8.4) |
| `cfg.polling.interval_ms` | Semantics change: ticket sync + reconcile cadence |

`gaggle doctor` gains: database reachable, migrations current, `ui.host` is
loopback.

---

## 14. Deletion inventory

Approximate, traced against the current tree:

| What | Where | ~Lines |
|---|---|---|
| Label-based recovery + 6 helpers | orchestrator.ts:2050–2445 | 400 |
| Gate comment polling + state restore | orchestrator.ts:1362–1458 | 96 |
| Failed-target comment polling | orchestrator.ts:1115–1230 | 115 |
| Dispatch eligibility + sub-issue poll path | orchestrator.ts:360–482, 661–705 | 165 |
| Retry queue | orchestrator.ts:1709–1848 | 140 |
| Comment/intent helpers | orchestrator.ts:2511–2578 | 68 |
| SM label classifiers + recovery types | state-machine.ts:302–353, 684–767 | 100 |
| LLM gate classifier | gate-classifier.ts | 134 |
| File-backed stores | run-registry.ts, analysis-registry.ts, scaffold-jobs.ts | 243 |
| **Total production code removed** | | **~1,460** |

Plus the tests that pin them: `orchestrator-helpers.test.ts`,
`analysis-registry.test.ts`, `run-registry.test.ts`, and the label/gate-classifier
suites in `state-machine.test.ts` and `orchestrator.test.ts`.

Net line count **goes up** — the store layer, transition module, board API, and
dashboard UI are more code than this. The win is that the remaining code has one
source of truth instead of a projection it has to reverse-engineer.

---

## 15. Delivery plan

Each phase is independently reviewable and leaves the suite green. Phases B and C
are shadow-mode: the old auto-dispatch path still runs, so nothing is at risk
until D.

| Phase | Scope | Size |
|---|---|---|
| **A** | Adopt or create `src/store/` per §3; migrations `100–10x` for `tickets`, `ticket_targets`, `control_events`, `tracker_outbox`, `scaffold_jobs`; `gaggle doctor` DB checks; per-schema test harness | M |
| **B** | `syncTickets()` + `TicketStore`. **Shadow mode**: sync mirrors Linear into Postgres, the old poll loop still dispatches. Validates import fidelity against live data with zero behavioural risk | M |
| **C** | `src/control/transitions.ts` (pure, fully unit-tested) + the transaction envelope + outbox drain. Still not wired to dispatch | M |
| **D** | **Flip the trigger.** Delete `shouldDispatch` and the sub-issue poll path; add `drainAnalysisRequests` / `promoteBlockedTargets` / `drainReadyTargets` / `applyCancelRequests` / `reconcileRuns`; delete the retry queue and the analysis cache | L |
| **E** | Board API + dashboard Board panel + per-ticket detail and timeline | L |
| **F** | Gates panel + `workflow_approvals` wiring; delete `pollSupervisedGates`, `gate-classifier.ts`, `pollFailedTargets`, and the comment/intent helpers | M |
| **G** | Delete label recovery, `startupTerminalCleanup`, the file stores, `ensureGaggleLabels`, `fetchIssuesByLabel`; reduce write-back to §12; `gaggle tickets` CLI; `gaggle status` reads Postgres | M |
| **H** | Hub history → Postgres (`200–2xx`); retire the SQLite database | M |

Critical path is A → C → D. Phase E is the largest single deliverable and can run
in parallel with D once C's schema is fixed. Phase H is independent and can land
any time after A.

**Ordering against the executor spec.** Land the executor's phases 0–1 first so
`src/store/` and the mechanical `archon → executor` renames exist before this
branch touches `orchestrator.ts`; otherwise both branches rewrite the same 2,500
lines and the merge is miserable. This spec's phase A then becomes a no-op adopt.
If that ordering slips, phase A creates the store against the §3 contract and the
executor branch adopts it.

### Cutover

There is no dual-mode flag. Validation happens before merge:

1. **Shadow-mode diff (phase B).** Run sync against the live Linear team for a few
   days on the branch and assert the `tickets` table matches what `gaggle status`
   reports from labels. Catches import-fidelity bugs with no behavioural risk.
2. **Manual-path walkthrough (phase E).** Import → Analyze → review the fan-out →
   Start → gate → Approve → PR, on a scratch repo, with `gaggle-scaffold` (lowest
   stakes) and then `gaggle-fix-issue` on a real low-priority issue.
3. **Kill-and-restart.** Hard-stop the daemon in each of `analyzing`,
   `dispatching`, `running`, and `gate_waiting`, and assert the board is correct on
   restart and the work resumes or parks as designed.

**Upgrade requires a drain.** The file-backed stores are not migrated. Operators
finish or abandon in-flight runs, upgrade, and the board starts from a fresh
import. Document this in the release notes; `gaggle doctor` errors if
`gaggle-runs.json` contains live entries.

---

## 16. Testing

The existing suite is a real asset and a real cost. `orchestrator.test.ts` is 2,400
lines and a large share of it pins the poll→dispatch contract that phase D removes.
Being honest about this: **rewriting those tests is the single largest line item in
this spec.**

| Area | Approach |
|---|---|
| `src/control/transitions.ts` | Pure unit tests mirroring `state-machine.test.ts`'s posture: every legal pair asserted, every illegal pair asserted to throw |
| Store + envelope | Postgres integration tests. `CREATE SCHEMA gaggle_test_<n>` per test file with `search_path` set, dropped in teardown — no new dependency, no container orchestration |
| Concurrency | Two concurrent Start calls on one ticket → exactly one dispatch, one 409. Two daemons draining `ready` → each target claimed once (`SKIP LOCKED`) |
| Sync | Fake tracker client + real DB: UPSERT preserves `status`; terminal-while-pre-run archives; terminal-while-running only sets `external_terminal_at`; sub-issues skipped; vanished tickets retained |
| Preserved plumbing | Keep the `orchestrator.test.ts` cases covering `launchWorker`, `handleWorkerExit`, gate-pause detection, and fan-out ordering; rewrite their setup to seed the DB instead of stubbing Linear label responses |
| Deleted paths | Delete the eligibility, label-recovery, comment-intent, and retry-queue suites outright rather than porting them |
| Board API | Route-level tests over a seeded DB for each action's happy path and its 409 |

---

## 17. Risks

1. **`orchestrator.test.ts` rewrite scale.** The most underestimated item. Mitigate
   by rewriting it in phase D as part of the flip, not deferring it — a green suite
   that no longer describes the system is worse than a red one.
2. **Merge collision with the executor branch.** Both touch `orchestrator.ts`,
   `state-machine.ts`, `domain/types.ts`, `service-config.ts`, and `src/store/`.
   Mitigated by the §3 ownership split, the migration ranges, and landing executor
   phases 0–1 first. This is a coordination risk, not a technical one, and it is
   the most likely thing to actually hurt.
3. **Postgres becomes a hard prerequisite** for `gaggle start`. Shared with the
   executor spec; the compose file and doctor check land in phase A.
4. **Operator friction.** Every run needs a click. If the team finds this
   intolerable for routine work, the answer is the deferred `auto_start` opt-in
   (§12), not a return to label-driven dispatch.
5. **Shadow-mode dual write (phase B).** Sync writes to Postgres while labels still
   drive behaviour. Bounded because nothing reads the new tables until phase D, but
   a sync bug could churn the tracker via the outbox — keep the outbox drain
   disabled until phase G.
6. **`external_terminal_at` needs a human.** Deciding not to auto-cancel means a
   ticket closed in Linear can keep burning agent time until someone looks at the
   board. The badge must be loud, and it belongs in the failure-and-warning summary
   at the top of the board, not only on the row.

---

## 18. Out of scope

- The workflow engine itself — that is the companion executor spec.
- The GitHub Issues tracker backend
  ([2026-05-09-github-issues-tracker-design.md](2026-05-09-github-issues-tracker-design.md)).
  The `tracker_kind` column and the `external_*` naming leave room for it; nothing
  else here anticipates it.
- Dashboard authentication and non-loopback exposure (§11.4).
- Migrating `registry.synced.yaml` or `auth.json` (§4.7).
- Migrating existing hub history rows (§10).
- Editing a ticket's description or adding targets by hand in the dashboard —
  Analyze produces the fan-out; the operator may exclude targets and change
  workflows, but not author new ones.
- `LISTEN/NOTIFY` push updates (§9.6).

---

## 19. Implementation notes — where the build departs from this spec

Recorded during implementation. Each of these is a deliberate change, not drift.

**19.1 The control plane never reads `workflow_runs` (supersedes §9.3).** The spec
had the reconciler join the engine's tables. It does not. Run state arrives through
two injected interfaces — `ExecutorPort` (spawn, kill, approve, reject) and
`RunStatusPort` (`observeRun`) — and a target holds only an opaque `run_id` it
never interprets. Three things fall out: this branch does not depend on the
engine's migrations existing, it works unchanged against Archon today and the
in-house engine later, and the whole plane is testable against fakes. `run_id`
stays a bare `UUID`; the FK still belongs in the 300 range.

**19.2 Gate answers are intent columns, not hub-side transitions (refines §11.1).**
Answering a gate means resuming a run, and only the process holding the executor
can do that — the hub cannot. So `POST /gates/:id/approve` writes
`ticket_targets.gate_decision` and the daemon's `applyGateDecisions()` step
converts it into a transition. This is the same shape as `cancel_requested`, and
it means a gate answered while the daemon is down is honoured when it restarts.
The conditional update (`status = 'gate_waiting' AND gate_decision IS NULL`) is
what makes two operators racing on one gate resolve to the first answer.

**19.3 The retry queue is deleted outright, and `retry_schedule` was never
created (confirms §8.4).** Tracing every `scheduleRetry` caller confirmed the
prediction: the post-success 1 s retry always short-circuits on `succeeded` and
exists only to defer `maybeReleaseClaim`, which is now a query in the same
transaction as the target's terminal transition. No timers, no table.

**19.4 Statuses are `TEXT` + `CHECK`, not Postgres `ENUM`s (supersedes §4.1).**
`ALTER TYPE … ADD VALUE` cannot run inside a transaction block on older servers,
which makes adding a status later a migration hazard for no benefit. This also
matches the engine's tables, which chose the same on the same reasoning.

**19.5 Migrations are inline SQL strings, not `.sql` files (supersedes §3).** The
engine branch established this so `bun build --target=bun` produces a
self-contained binary with no migrations directory to locate at run time. Version
ranges are unchanged: control plane owns 100–199 over the shared
`schema_migrations` table.

**19.6 `database.url` with `executor.database_url` as an alias (resolves §20.1).**
Both names are accepted and resolve to the same connection, so neither branch
blocks the other and no operator config has to change on merge.

**19.7 `ticket_targets` carries the sub-issue's tracker state.** Two columns the
spec omitted, `external_target_state` and `external_target_labels`, refreshed by
sync. Without them, env-gated readiness (`ready_when: deployed:staging`) could
only be evaluated for mono-repo targets — a functional regression against today's
`subissue_snapshot`.

**19.8 The readiness predicate is shared, not reimplemented.**
`src/orchestrator/readiness.ts` gained `isBlockerSatisfiedWith` /
`blockersSatisfiedWith`, taking a narrow `BlockerReadinessConfig` that
`ServiceConfig['tracker']` satisfies structurally. The existing signatures
delegate to them, so no caller or test changed. The deploy-label and
terminal-state rules exist in exactly one place.

**19.9 Sync never writes `status`, enforced by the type system.** `UpsertTicketInput`
has no `status` field and the SQL's `ON CONFLICT DO UPDATE` list omits it. A sync
pass cannot move work backwards even if someone tries.

**19.10 `ticket_targets.run_id` is `TEXT`, not `UUID`.** Archon's run ids are 32
hex characters with no dashes. A `UUID` column accepts that form but normalizes it
to dashed form on the way out — and Archon does not recognize the dashed form when
handed back, so approve and cancel would have silently addressed a run that does
not exist. An opaque identifier from an unknown producer gets an opaque column
type. A conformance test pins the byte-exact round trip.

**19.11 The concurrency limit is a ceiling, counted from the store.** The old
`availableSlots` subtracted the in-memory `running` map from the configured max,
so a restart forgot every live run and let concurrency drift. The reconciler now
counts `dispatching`/`running`/`gate_waiting` rows and passes the number to
`SlotPort`. `gate_waiting` counts: a paused run still owns its worktree.

**19.12 The Pipeline panel is gone.** It summarised queued targets, gates, retries
and failures from each gaggle's in-memory state. The Board and Gates panels show
the same things from the durable record, with real statuses and while every gaggle
process is stopped. Keeping both would have meant two answers to one question.

**19.13 `gaggle ps` reads the control plane.** It used to fan out over
`fetchIssuesByLabel` and reconstruct state from whichever labels happened to be
present. It now runs the board query, so it needs no tracker credentials.

**19.14 `pollMergedPRs` survived, as its own module.**
`src/orchestrator/pr-merge-watcher.ts`. It observes GitHub and writes the tracker
with no reference to tickets, targets or runs, so it is not part of the control
plane and should not have been buried in the poll loop.

**19.15 The dashboard has parse and wiring guards.** It has no build step, so a
syntax error surfaces only as every panel rendering empty — which happened during
this work. `dashboard-assets.test.ts` parses `app.js`, checks that every `$('#id')`
resolves against `index.html`, checks the new CSS classes exist, and asserts that
nothing still reads the state fields that moved to Postgres.

### 19.16 Corrections from code review

An adversarial review of the finished branch found fifteen findings, most
demonstrated with scripts against the real code. The ones that changed behaviour:

**A run can end while its gate is open.** `gate_waiting` had no `run_succeeded` /
`run_failed` exit, so a gate whose Archon run then crashed made the reconciler
throw — and because the loop had no per-target isolation, that one row stopped
every other target in the workspace from being reconciled, forever, showing up
only as one log line per tick. Both halves fixed: the transitions exist, and each
target is reconciled inside its own try.

**An unverifiable clean exit no longer guesses.** Archon exits 0 when a workflow
pauses, so a clean exit is checked against the run's real status — but when that
check *failed*, the old code trusted the exit code and marked the target
`succeeded`, which is terminal. That closed the tracker issue, left a still-paused
run holding its worktree, and left the operator with no button. It now decides
nothing and leaves the question to the reconciler, which retries it every tick.
Same for a run reporting `running` or `pending`.

**The outbox is workspace-scoped and locked.** `claimOutbox` took neither, so two
daemons drained each other's rows — posting every comment twice, through the wrong
tracker client, with the wrong state names. It now filters by workspace and claims
with `FOR UPDATE SKIP LOCKED` inside the drainer's transaction. Relatedly, outbox
rows are stamped from the *ticket's* workspace, not from config, which is what
makes the hub's writes claimable at all.

**Startup recovery no longer steals a live peer's claim.** `dispatching` means
"claimed, not yet spawned", which is unambiguous for our own crash and identical
to a peer that is mid-spawn right now. Requeueing the latter started a second run
on the same worktree whose id was never recorded, so it could never be cancelled.
A claim younger than `stranded_claim_grace_ms` is left alone.

**A ticket stranded in `analyzing` is recoverable.** Only `analysis_requested` is
claimable and the dashboard offers no action from `analyzing`, so a crash mid
analysis needed manual SQL. Recovery now returns it to the queue.

**Re-analysis no longer destroys the audit trail.**
`control_events.target_id` was `ON DELETE CASCADE`, and `replaceTargets` deletes
rows — so pressing Re-analyze erased the record of everything the previous targets
did. Now `ON DELETE SET NULL`: the events survive with their target reference
cleared.

**An approved gate is not re-opened while the executor is still resuming.** Archon
keeps reporting the old gate for a moment after being resumed, which made the
reconciler post a second comment and then approve a second time. There is now a
settle window, and the reconciler no longer approves on the operator's behalf when
a gated run reports `running` — a desynced gate is safer visible than guessed at.

**Two guards that could not start work now refuse it.** Re-dispatching a target of
a *cancelled* ticket used to spawn a run the operator had explicitly cancelled,
leaving a ticket that could never settle. And starting a ticket whose whole fan-out
is excluded parked it in `running` with nothing to run and no way out; `Start` now
refuses, and excluding the last target after the fact settles the ticket instead.

**Re-dispatch goes through `blocked`, not straight to `ready`**, so it cannot
bypass tracker blockers or `depends_on`, and it resets the gate rework budget.

**Migrations are serialized by a transaction-scoped advisory lock.** `gaggle nest
start` migrates from every daemon and then the hub, so a concurrent first-boot
migration is the normal case — and the loser did not fail politely, it died inside
`CREATE TABLE`. Worth recording how the *fix* went wrong first: a session-level
`pg_advisory_lock` looks correct but, over a connection pool, the matching unlock
can run on a different connection where it silently returns false. That left the
lock held by an idle backend and every later migration hanging on it — observed
directly in `pg_locks`. `pg_advisory_xact_lock` inside the migration transaction
has no such failure mode.

**Two tests were not testing what they claimed.** The dashboard parse guard used
`new vm.Script`, which does not eagerly parse in Bun — it accepted
`function f( {` — so it was green while the real file was unloadable, the exact
failure it existed to catch. It uses `Bun.Transpiler` now, verified by
reintroducing the corruption. And the transition matrix only asserted "returns a
valid status or throws the right type", which a table where every pair throws would
also satisfy; it could not detect a *missing* transition, which is precisely the
first finding above. The accepted set is now written out explicitly, and it
immediately caught two undocumented pairs.

Also corrected: the `create-blocker` gate outcome was implemented end to end with
no button to trigger it; `FakeExecutor` handed every target the same run id, which
silently collided in any test keying observations by run id; and the in-memory
store's "monotonic" clock returned timestamps in the *future*, which inverted every
age comparison written against it.

**Not fixed, deliberately.** The concurrency ceiling still is not atomic across two
daemons sharing one workspace: the count and the claim are separate statements, so
both can see the same free slots. Row-level exclusivity holds, so the failure mode
is "more concurrent runs than configured", not corruption — and one daemon per
workspace is the supported configuration, enforced by the pid sidecar. Making it
atomic means computing the ceiling inside the claim statement. The comment on
`SlotPort` now says this rather than claiming otherwise.

### What is built

All phases A–H, plus the orchestrator flip. **602 tests pass, `tsc --noEmit` is
clean** (including three pre-existing errors in `src/hub/` fixed along the way).

| Spec phase | State |
|---|---|
| A — store foundation | `src/store/` shared layer; `src/control/store/` with Postgres and in-memory implementations held to one 110-assertion conformance suite that runs against both |
| B — ticket sync | `src/control/sync.ts`, two-pass discover/track |
| C — transitions + envelope | `transitions.ts` (pure, exhaustive matrix), `service.ts`, `outbox.ts` |
| D — reconciler + the flip | `reconciler.ts` (eight steps + `recoverOnStartup`), wired into `Orchestrator.start()`. `orchestrator.ts` went from 2,564 lines to ~330 |
| E — board API | `src/control/api.ts`, mounted at `/api/control/*` on both the hub and each gaggle |
| F — gates | Dashboard-only, via the intent path (19.2) |
| G — deletions | See below |
| H — hub history | Migrations 200–299; `bun:sqlite` no longer appears anywhere in `src/` |

**Deleted:** `effect-applier.ts`, `gate-classifier.ts`, `state-machine.ts`,
`archon-poller.ts`, `run-registry.ts`, `analysis-registry.ts`, and from the
orchestrator the poll-loop eligibility checks, label recovery and its six helpers,
the comment-driven gate and failed-target pollers, the comment-intent classifiers,
and the retry timers. `fetchIssuesByLabel` is gone from the tracker client, so
there is no longer a way to query by label — the invariant is enforced by absence
rather than by discipline. Nine dead types went with them.

Net: **2,090 lines added, 8,989 deleted** across tracked files, plus ~5,900 lines
of new control-plane code and ~4,700 lines of tests.

`orchestrator.test.ts` was rewritten rather than ported. The old 2,400-line suite
mostly pinned the poll-then-dispatch contract; the new one drives real ticks
against an in-memory control plane with only the process boundaries faked, and
leads with the property the whole redesign exists for: a tick over an imported
ticket starts nothing.

### What remains

Not blockers, but worth naming:

1. **Scaffold jobs are still a YAML file.** `scaffold_jobs.yaml` and
   `src/registry/scaffold-jobs.ts` remain; the Postgres table and store methods
   exist and are tested but the CLI has not been rewired. It is an isolated store
   that never caused the dual-truth problem, which is why it was left last.
2. **`gaggle-runs.json` / `gaggle-analysis.json` may exist on disk** from a
   previous version. Nothing reads them. `gaggle doctor` should learn to say so.
3. **The live canary.** §15's third validation gate — `gaggle-scaffold` end to end
   against a scratch repo, then `gaggle-fix-issue` on a real low-priority issue —
   has not been run. Everything below it has: the suite, a hand-driven UI pass over
   a seeded board, and a crash-recovery test.
4. **Merge coordination with the executor branch** (§17.2) is unchanged and is
   still the most likely thing to hurt.

## 20. Open questions

1. ~~**Config key name** for the database.~~ Resolved in implementation: both
   `database.url` and `executor.database_url` are accepted (§19.6).
2. **Gate timeout default.** `cfg.archon.gate_timeout_ms` already defaults to `0`
   (never). Under operator control that is almost certainly right, but it means a
   forgotten gate holds a concurrency slot indefinitely. Recommendation: keep `0`
   and surface gate age prominently on the board rather than adding a timeout.
3. **Board scope across workspaces.** The board is workspace-filtered with an
   "all" view. Whether the "all" view should allow bulk actions (Start every
   analyzed ticket across workspaces) is unresolved; recommendation is no bulk
   actions in v1.
