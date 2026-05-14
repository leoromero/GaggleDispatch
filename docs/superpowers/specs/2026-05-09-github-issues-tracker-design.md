# GitHub Issues Tracker — Design Spec

**Date:** 2026-05-09  
**Status:** Draft  
**Scope:** Add `tracker.kind: github` as a first-class alternative to `tracker.kind: linear`

---

## 1. Problem Statement

GaggleDispatch currently hard-codes Linear as the only issue tracker. `TrackerConfig.kind` is validated against the string `'linear'` at config-load time; the orchestrator holds a `LinearClient` reference directly. Teams that use GitHub Issues as their primary planning surface cannot use GaggleDispatch without also adopting Linear.

The spec (Section 12) already anticipates this:

> New `tracker.kind` values (for example `github`, `jira`) SHOULD implement the same ten operations. The orchestrator, analyzer, and workspace modules MUST depend only on the abstract operations and remain ignorant of the concrete tracker.

This spec defines what needs to change to make that a reality for `tracker.kind: github`.

---

## 2. Goals and Non-Goals

### Goals

- Add `tracker.kind: github` that polls a single GitHub repository's issues as the work queue.
- GitHub labels replace Linear workflow states; open/closed + labels replace Linear state transitions.
- Symphony's four durable state-machine labels (`symphony:claimed`, etc.) are auto-created as GitHub labels on startup.
- Multi-repo fan-out creates linked child issues in the same repo when `create_sub_issues: true`.
- All orchestrator logic (poll loop, retry, gate bridging, readiness checks) is unchanged.
- The `setup` wizard gains a GitHub PAT validation step for `tracker.kind: github`.
- Full backward compatibility: existing `tracker.kind: linear` WORKFLOW.md files are unaffected.

### Non-Goals

- GitHub Projects v2 / milestones as state machines.
- Org-level issue aggregation across multiple repos.
- GitHub Actions webhooks / event-driven polling (still a timed poll loop).
- Jira or any other tracker kind (this spec is GitHub only).

---

## 3. Architecture

### 3.1 TrackerAdapter Interface

Introduce `src/tracker/adapter.ts` defining the `TrackerAdapter` interface. All 10 required operations become typed method signatures.

```typescript
// src/tracker/adapter.ts
import type { Issue } from '../domain/types.ts';
import type { IssueCommentRecord } from './linear.ts';

export interface TrackerAdapter {
  /** 1. Candidate issues in active states (with optional assigned-to-me filter). */
  fetchCandidateIssues(): Promise<Issue[]>;

  /** 2. Issues currently in the named states — used for startup terminal cleanup. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;

  /** 3. Snapshot of named issues by id — used for active-run reconciliation. */
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;

  /** 4. Create a child issue under a parent. Returns {id, identifier}. */
  createSubIssue(args: {
    parent_id: string;
    title: string;
    assignee_id: string | null;
    state_name: string;
  }): Promise<{ id: string; identifier: string }>;

  /** 5. Transition an issue to a named state. */
  updateIssueState(issue_id: string, state_name: string): Promise<void>;

  /** 6. Post a comment. Returns the comment id. */
  postComment(issue_id: string, body: string): Promise<{ id: string }>;

  /** 7. Apply a named label to an issue. Creates the label if it does not exist. */
  applyLabel(issue_id: string, label_name: string): Promise<void>;

  /** 8. Remove a named label from an issue. */
  removeLabel(issue_id: string, label_name: string): Promise<void>;

  /** 9. Fetch issues carrying a specific label. */
  fetchIssuesByLabel(label_name: string): Promise<Issue[]>;

  /** 10. Fetch all comments on an issue. */
  fetchIssueComments(issue_id: string): Promise<IssueCommentRecord[]>;

  /** Called once at startup to create/verify required state-machine labels. */
  ensureSymphonyLabels(): Promise<void>;
}
```

`LinearClient` implements `TrackerAdapter` without changes to its logic — only the class declaration gets `implements TrackerAdapter` added.

### 3.2 Orchestrator Type Change

`OrchestratorDeps` and the `Orchestrator` class change `tracker: LinearClient` to `tracker: TrackerAdapter`. This is a one-line change per location; no logic changes anywhere in the orchestrator.

### 3.3 GitHubIssuesClient

New file `src/tracker/github.ts` implements `TrackerAdapter` against the GitHub REST API v3 (used via `fetch`). Authentication is a Personal Access Token (PAT) passed as `Authorization: Bearer <token>`.

The client targets a single repository identified by `tracker.project_slug: 'owner/repo'`.

### 3.4 TrackerConfig Kind Union

`TrackerConfig.kind` changes from `'linear'` to `'linear' | 'github'`. All other `TrackerConfig` fields are shared; GitHub-specific behaviour is captured by which fields are relevant for each kind.

---

## 4. GitHub Issues State Machine Mapping

### 4.1 Concept Map

| Symphony / Linear concept | GitHub Issues equivalent |
|---|---|
| Workflow state name (e.g. "In Progress") | Label name (e.g. `status:in-progress`) |
| `active_states` list | List of state label names whose presence makes an issue a dispatch candidate |
| `terminal_states` list | Closed issues (always terminal) PLUS optional terminal label names for open issues |
| `update_issue_state(id, "Done")` | Close the issue + remove active state label |
| `update_issue_state(id, "Cancelled")` | Close the issue + apply `status:cancelled` label |
| `update_issue_state(id, "In Progress")` | Re-open the issue + apply `status:in-progress` label |
| `project_slug` | `owner/repo` string |
| `api_key` | GitHub Personal Access Token (`$GITHUB_TOKEN` by default) |
| `assigned_to_me` | Filter by `assignee:@me` |
| Sub-issue | New GitHub issue created in the same repo with parent reference in body |

### 4.2 Active States and Candidate Fetching

`tracker.active_states` for GitHub kind is a list of **label names** (not GitHub state names). An issue qualifies as a dispatch candidate if:

1. It is **open**, AND
2. It carries **at least one** of the labels listed in `tracker.active_states`, AND
3. If `assigned_to_me: true`, it is assigned to the authenticated user.

Default value for `tracker.active_states` when `kind: github`: `["status:todo", "status:in-progress"]`

**REST query:**

```
GET /repos/{owner}/{repo}/issues?state=open&assignee=@me&labels=status:in-progress&per_page=100
```

When `active_states` has more than one label, multiple requests are made (one per label) and results are deduplicated by issue number. This avoids the GitHub REST API limitation that `labels=` is an AND filter.

### 4.3 Terminal States

`tracker.terminal_states` for GitHub kind is interpreted as:

- **`"closed"`** (always included) — any closed issue is terminal.
- Any other string is treated as a label name. An open issue carrying that label is also considered terminal (e.g. `"status:cancelled"`, `"wontfix"`).

Default: `["closed", "status:cancelled", "status:done"]`

The `update_issue_state(id, state_name)` operation handles the transition:

| `state_name` | GitHub action |
|---|---|
| Value ∈ `terminal_states` and is `"closed"` | Close the issue via `PATCH /repos/{owner}/{repo}/issues/{number}` with `{"state": "closed"}` |
| Value ∈ `terminal_states` and is a label name | Close the issue AND apply that label |
| Value ∈ `active_states` (a label name) | Re-open the issue (if closed) + remove all other state labels + apply this label |
| Any other value | Apply as label, do not change open/closed state (graceful degradation) |

### 4.4 Issue Identifier and ID

GitHub issues have an integer `number` and a URL. The `Issue.id` field stores the **number as a string** (e.g. `"42"`); `Issue.identifier` stores the display form `owner/repo#42`. The `issue_id` parameter throughout the adapter accepts the issue number string.

### 4.5 Branch Name

GitHub provides a `pull_request.head.ref` field on issues that have a linked PR. This is surfaced as `Issue.branch_name` if present. Otherwise `null`.

The GitHub REST `GET /repos/{owner}/{repo}/issues/{number}` response does not include branch name directly. The client fetches it via `GET /repos/{owner}/{repo}/issues/{number}/timeline` or reads the linked PR ref from `pull_request.head.ref` on issue detail.

**Simplification:** `branch_name` is set to `null` for GitHub issues; if a branch name is needed downstream (e.g. by the message builder), the spec already handles `null` gracefully by omitting it from the message.

### 4.6 Blocker / Dependency Relations

Linear has native blocker relations surfaced as `inverseRelations`. GitHub has no equivalent in the REST issues model. The GitHub adapter always returns `blocked_by: []`. Cross-issue dependency ordering via Claude analysis (`depends_on` in `IssueAnalysis`) continues to work; only the Linear-native blocker check is unavailable.

**Consequence:** `tracker.blocker_satisfied_states` and `tracker.blocker_default_readiness` have no effect when `kind: github`. This is documented in the config reference as an explicit limitation.

---

## 5. Sub-Issue Handling

GitHub Issues has no native parent-child relationship. When `tracker.create_sub_issues: true` and fan-out width > 1:

1. `createSubIssue(parent_id, title, assignee_id, state_name)` creates a **new GitHub issue** in the same repo with:
   - Title: `[<repo_alias>] <parent issue title>` (same format as Linear)
   - Body: `Part of #<parent_number>\n\n_Auto-created by GaggleDispatch for repo target \`<repo_alias>\`._`
   - Assignee: same as parent (if `assignee_id` is non-null)
   - Labels: the `state_name` label (e.g. `status:in-progress`) + `symphony:running`
2. The created issue's number string becomes `sub_issue_id` in the live session.
3. On completion, the child issue is closed (terminal state transition).
4. The parent issue is never auto-closed (same policy as Linear).

**Default for GitHub kind:** `create_sub_issues: false`. Multi-repo fan-out still works; Symphony just manages labels and comments on the parent issue for all targets. Operators can opt in to `create_sub_issues: true`.

---

## 6. Configuration

### 6.1 WORKFLOW.md Changes

```yaml
tracker:
  kind: github                         # NEW value
  project_slug: owner/repo             # REQUIRED for kind=github; format: "owner/repo"
  api_key: $GITHUB_TOKEN               # default env var; PAT with repo scope
  endpoint: https://api.github.com     # default; override for GHES
  active_states:
    - status:in-progress
    - status:todo
  terminal_states:
    - closed
    - status:cancelled
  assigned_to_me: true
  create_sub_issues: false             # default false for github kind
  gate_waiting_state: null
  gate_resume_state: null
  symphony_labels:
    claimed: symphony:claimed
    queued: symphony:queued
    running: symphony:running
    waiting_human: symphony:waiting-human
```

### 6.2 Config Validation Changes (`service-config.ts`)

- `tracker.kind` MUST be `'linear'` or `'github'`.
- When `kind: github`, `project_slug` MUST match the pattern `owner/repo` (no protocol prefix, no `.git` suffix).
- When `kind: github`, `create_sub_issues` defaults to `false` (overridable).
- When `kind: github`, `active_states` defaults to `["status:in-progress", "status:todo"]`.
- When `kind: github`, `terminal_states` defaults to `["closed", "status:cancelled", "status:done"]`.
- When `kind: github`, `api_key` resolves from `$GITHUB_TOKEN` by default (if `api_key` is not set).
- When `kind: github`, `endpoint` defaults to `https://api.github.com`.
- Linear-specific fields (`deploy_env_labels`, `blocker_satisfied_states`, `blocker_default_readiness`) are still parsed but no-ops when `kind: github`; no validation error is raised.

### 6.3 TrackerConfig Type

```typescript
export interface TrackerConfig {
  kind: 'linear' | 'github';   // changed from 'linear'
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
  symphony_labels: SymphonyLabels;
}
```

---

## 7. GitHubIssuesClient Implementation Detail

### 7.1 File: `src/tracker/github.ts`

```
class GitHubIssuesClient implements TrackerAdapter
```

Authentication: `Authorization: Bearer <api_key>` header on every request. Default endpoint `https://api.github.com`.

Caches:
- `owner` and `repo` parsed once from `project_slug` at construction.
- `viewerLogin` resolved once via `GET /user` and cached.
- `labelIdCache: Map<string, number>` — label name → label id, populated on first `ensureSymphonyLabels`.

### 7.2 Issue Normalization

```
GET /repos/{owner}/{repo}/issues/{number}
```

Maps to `Issue` as:
- `id`: `String(issue.number)`
- `identifier`: `owner/repo#<number>`
- `title`: `issue.title`
- `description`: `issue.body ?? null`
- `priority`: `null` (GitHub has no priority field)
- `state`: derived state label name (see §7.3)
- `branch_name`: `null`
- `url`: `issue.html_url`
- `labels`: all label names on the issue (lowercased)
- `blocked_by`: `[]`
- `created_at`: `issue.created_at`
- `updated_at`: `issue.updated_at`
- `parent_id`: `null` for normal issues; parsed from body `Part of #<number>` pattern for sub-issues (best-effort)

### 7.3 Derived State Name

The `Issue.state` field is the first matching `active_states` label found on the issue. If the issue is closed, `state` is `"closed"`. If no active state label matches but the issue is open, `state` is `"open"` (a neutral value the orchestrator will not dispatch but also will not terminate).

### 7.4 Pagination

All list endpoints use `per_page=100` with `Link` header pagination. Results are collected until no `next` link is present. A max-pages guard (20 pages = 2000 issues) prevents infinite loops.

### 7.5 Rate Limiting

On HTTP 429 or `X-RateLimit-Remaining: 0`, the client waits until `X-RateLimit-Reset` (parsed as Unix epoch seconds) before retrying. One retry; on second failure, throws `GitHubTrackerError`.

### 7.6 Error Type

```typescript
export class GitHubTrackerError extends Error {
  override name = 'GitHubTrackerError';
  constructor(message: string, public payload?: unknown) {
    super(message);
  }
}
```

---

## 8. `ensureSymphonyLabels` for GitHub

On startup, `ensureSymphonyLabels()` calls `GET /repos/{owner}/{repo}/labels` and creates any missing symphony labels via `POST /repos/{owner}/{repo}/labels`. Label colors:

| Label | Color |
|---|---|
| `symphony:claimed` | `#0052CC` (blue) |
| `symphony:queued` | `#6554C0` (purple) |
| `symphony:running` | `#00875A` (green) |
| `symphony:waiting-human` | `#FF991F` (orange) |

---

## 9. Startup and `start.ts` Changes

`start.ts` selects the tracker client by `cfg.tracker.kind`:

```typescript
const tracker: TrackerAdapter =
  cfg.tracker.kind === 'github'
    ? new GitHubIssuesClient(cfg)
    : new LinearClient(cfg);
```

The preflight check for `tracker.api_key` is kind-aware:

- `kind: linear` → error message references `LINEAR_API_KEY`
- `kind: github` → error message references `GITHUB_TOKEN`

### 9.1 `gaggle setup` Wizard

The `KEYS` array in `setup.ts` gains a conditional GitHub PAT step:

```
If tracker.kind == 'github' OR tracker.kind is absent (user is setting up fresh):
  - Prompt for GITHUB_TOKEN
  - Validate via GET https://api.github.com/user
  - Persist as user env var
```

The wizard reads the existing WORKFLOW.md (if present) to decide which step to include. If no WORKFLOW.md exists, it prompts for both keys and skips validation for whichever is not needed.

---

## 10. Startup Recovery (Section 12.4 equivalent for GitHub)

The label-driven recovery sequence is identical for GitHub — the four symphony labels are GitHub labels, so `fetchIssuesByLabel("symphony:claimed")` etc. work without change. The `GitHubIssuesClient.fetchIssuesByLabel` implementation calls:

```
GET /repos/{owner}/{repo}/issues?state=all&labels=symphony:claimed&per_page=100
```

`state=all` is required so that closed issues with the label are also recovered.

---

## 11. Human Gate Bridging

The gate-comment flow is unchanged. `postComment(issue_id, body)` posts to:

```
POST /repos/{owner}/{repo}/issues/{number}/comments
```

`fetchIssueComments(issue_id)` polls:

```
GET /repos/{owner}/{repo}/issues/{number}/comments?per_page=100
```

Comments are normalized to `IssueCommentRecord` with `author.name` set to the GitHub login. The orchestrator's `approve`/`reject` keyword regex runs against `comment.body` exactly as it does today.

---

## 12. Files Changed / Added

| Path | Change type | Notes |
|---|---|---|
| `src/tracker/adapter.ts` | **New** | `TrackerAdapter` interface |
| `src/tracker/github.ts` | **New** | `GitHubIssuesClient` |
| `src/tracker/linear.ts` | **Modified** | Add `implements TrackerAdapter` |
| `src/domain/types.ts` | **Modified** | `TrackerConfig.kind: 'linear' \| 'github'` |
| `src/config/service-config.ts` | **Modified** | Accept `github` kind, new defaults, `project_slug` format validation |
| `src/orchestrator/orchestrator.ts` | **Modified** | `tracker: TrackerAdapter` in `OrchestratorDeps` and class field |
| `src/cli/start.ts` | **Modified** | Conditional tracker instantiation; kind-aware preflight messages |
| `src/cli/setup.ts` | **Modified** | GitHub PAT validation step |
| `src/__tests__/github.test.ts` | **New** | Unit tests for `GitHubIssuesClient` |

---

## 13. Testing Requirements

- Unit tests for `GitHubIssuesClient` mirror existing `src/__tests__/linear.test.ts` in structure: mock `fetch`, cover the 10 operations, normalization edge cases, and `ensureSymphonyLabels`.
- `fetchCandidateIssues` deduplication test: issue with two active state labels appears once.
- `updateIssueState` test covering: terminal label, active label re-open, unknown state graceful pass-through.
- Rate limit backoff test: `X-RateLimit-Remaining: 0` triggers a wait.
- Config validation tests: `project_slug` format rejection (bare repo name, full URL), `kind: github` defaults.
- Integration smoke test: existing `smoke.test.ts` still passes unmodified (no `kind` specified defaults to `linear`).

---

## 14. Known Limitations

| Limitation | Impact |
|---|---|
| No native sub-issue relationship | Fan-out sub-issues are linked by body text only; GitHub UI shows no hierarchy. |
| No blocker relations | `blocked_by` is always `[]`; cross-issue dependency ordering relies entirely on Claude analysis. |
| No priority field | `Issue.priority` is always `null`; priority-based dispatch ordering is unavailable. |
| No branch name | `Issue.branch_name` is always `null`; issue message omits the branch line. |
| Label-based states | State is implicit from labels; an issue with no active-state label is visible but never dispatched. |
| REST API rate limit | 5000 req/hour for authenticated PAT; large orgs may need polling interval tuning. |

---

## 15. Migration and Backward Compatibility

- No breaking changes to the Linear path. `tracker.kind: linear` WORKFLOW.md files work without modification.
- `TrackerAdapter` is a new interface; `LinearClient` is retroactively typed as implementing it.
- The `tracker: LinearClient` field on `OrchestratorDeps` becomes `tracker: TrackerAdapter`; TypeScript ensures correctness at compile time.
- The `IssueCommentRecord` type (currently exported from `linear.ts`) is re-exported from `adapter.ts` as the canonical location; `linear.ts` re-exports from there for backward compatibility.

---

## 16. Open Questions (Not Blocking)

1. **GHES (GitHub Enterprise Server):** The `endpoint` field already allows override. GHES REST path format differs slightly. Full GHES support is deferred; the field is plumbed but only `api.github.com` is tested.
2. **GraphQL vs REST:** GitHub's GraphQL API would enable fetching linked issues, milestones, and project fields in one request. Current design uses REST for simplicity; GraphQL migration is a future optimization.
3. **`setup` wizard automatic detection:** Should `gaggle setup` auto-detect which tracker kind to configure? Current proposal reads WORKFLOW.md; if absent, prompts for both. This could be refined with a `tracker.kind` prompt in the wizard.
