---
name: gaggledispatch
description: >
  GaggleDispatch is the top-level orchestration daemon for a federated, multi-repo AI coding
  workflow. It polls Linear for active issues, uses Claude to route each issue against a live
  registry of per-repo gaggle.md self-descriptions, fans out to one or more target repositories,
  and dispatches Archon workflow runs in isolated per-issue checkouts. It is the single authority
  for Linear state transitions, concurrency management, retry/backoff, and supervised human-gate
  bridging — it never writes code or touches git history itself.
default_workflow: gaggle/gaggle-fix-issue
available_workflows:
  - gaggle/gaggle-fix-issue
  - gaggle/gaggle-supervised
  - gaggle/generate-gaggle-md
components:
  - name: gaggledispatch-orchestrator
    component_type: worker
    description: >
      The core long-running poll loop (started by `gaggle start`). Each tick reconciles running
      workers (stall detection, cancellation on state change), polls supervised gates for human
      approve/reject replies, drains pending fan-out targets, fetches candidate Linear issues,
      routes each with Claude (with TTL cache), and dispatches per-repo workers. Owns all runtime
      state: running sessions, claimed issues, retry queue, supervised gates, sibling sub-issue map.
      Recovers in-flight state from Linear labels on startup — no on-disk scheduler state.
    communicates_with:
      - component: linear-graphql-api
        method: graphql
        direction: bidirectional
      - component: anthropic-claude-api
        method: http
        direction: produces
      - component: archon-cli
        method: subprocess
        direction: produces

  - name: gaggledispatch-issue-analyzer
    component_type: other
    description: >
      Calls the Anthropic Claude API with the full RegistryContext (every synced repo's gaggle.md
      front matter + narrative) plus the normalized Linear issue. Returns a typed IssueAnalysis with
      repo_targets, depends_on, and ready_when for multi-repo dependency ordering. Reconciles
      Claude's returned aliases against the live registry; unmatched targets are dropped with a
      warning. Results are TTL-cached per issue; the cache is invalidated on registry hot-reload.
    communicates_with:
      - component: anthropic-claude-api
        method: http
        direction: produces

  - name: gaggledispatch-repo-syncer
    component_type: worker
    description: >
      Clones and incrementally updates all registered repositories under
      <base_folder>/repos/<slug>/. Polls each repo's remote HEAD SHA via `gh api`; only pulls when
      the SHA has changed. Parses each repo's gaggle.md after every pull and writes the merged
      result to <base_folder>/registry.synced.yaml atomically under a file lock. Validates
      uniqueness of repository and component names across the federation; collisions downgrade the
      offending entry to sync_status=error. Runs on a 15-minute interval or on-demand via
      `gaggle sync`. Also handles `gaggle repo scaffold`, which triggers an Archon workflow to
      generate a draft gaggle.md PR for repos that lack one.
    communicates_with:
      - component: github-api
        method: http
        direction: reads
      - component: archon-cli
        method: subprocess
        direction: produces

  - name: gaggledispatch-linear-tracker
    component_type: other
    description: >
      GraphQL adapter for the Linear API implementing all 10 operations from the GaggleDispatch spec:
      fetchCandidateIssues, fetchIssuesByStates, fetchIssueStatesByIds, createSubIssue,
      updateIssueState, postComment, applyLabel, removeLabel, fetchIssuesByLabel,
      fetchIssueComments. Caches team, label, and workflow-state IDs to avoid redundant lookups.
      Auto-creates the four gaggle state-machine labels on startup (claimed, queued, running,
      waiting-human).
    communicates_with:
      - component: linear-graphql-api
        method: graphql
        direction: bidirectional

  - name: gaggledispatch-cli
    component_type: cli
    description: >
      Commander-based CLI (invoked as `gaggle`) and the sole operator-facing surface.
      Provides setup (API key wizard), init (bootstrap WORKFLOW.md + workflow_templates/), repo
      add/remove/list/scaffold, sync, status, and start. All commands that mutate WORKFLOW.md or
      the synced registry acquire an advisory file lock. `gaggle repo add/remove` are the only
      sanctioned ways to modify the registered repository list.
    communicates_with:
      - component: linear-graphql-api
        method: graphql
        direction: reads
---

GaggleDispatch is the scheduling and routing layer that sits above all other service repositories in a federated AI coding system. It never writes code or modifies git history — those operations belong to Archon/Claude running inside the target repos. Its responsibilities are reading Linear, deciding where work goes, dispatching Archon processes, and writing Linear state back (labels, comments, sub-issues, state transitions).

The federation works through per-repo `gaggle.md` documents. The Repo Syncer clones all registered repositories, polls for SHA changes via the GitHub API, parses each repo's `gaggle.md` on change, and writes a merged `registry.synced.yaml` atomically. The Registry Loader hot-watches this file and projects it into a typed `RegistryContext` consumed by the Issue Analyzer. The orchestrator invalidates its analysis cache on every registry reload, so topology changes in any registered repo propagate to routing within one sync cycle.

The Issue Analyzer is the routing brain: it sends Claude the full `RegistryContext` plus the normalized Linear issue and receives back a JSON `IssueAnalysis` identifying which repos should receive work, in what order (`depends_on`), and under what readiness condition (`ready_when: merged | deployed | deployed:prod`). When an issue fans out to multiple repos, each target becomes its own worker and optionally its own Linear sub-issue. Sibling readiness is checked on every orchestrator tick — a downstream worker does not start until its upstream dependency reaches the declared ready state.

Archon is the execution substrate: GaggleDispatch shells out to `archon workflow run` and monitors its stderr for gate-pause events (a UUID + keyword regex match). When a gate pause is detected, the concurrency slot is freed, a Linear comment posts the gate message, and the orchestrator polls issue comments for a human `approve`/`reject` reply. Linear labels are the only durable state: `gaggle:claimed`, `gaggle:queued`, `gaggle:running`, and `gaggle:waiting-human` are written before process launch and read back on startup to reconstruct in-flight work after a crash.

Issues targeting the **orchestrator** cover the poll loop, state machine, fan-out logic, retry/backoff, gate bridging, and crash recovery. Issues targeting the **issue analyzer** cover routing accuracy, Claude prompt quality, and alias reconciliation. Issues targeting the **repo syncer** cover clone/pull mechanics, gaggle.md parsing, name collision detection, and the scaffold workflow. Issues targeting the **linear tracker** cover GraphQL operations, label management, and sub-issue creation. Issues targeting the **CLI** cover the operator command surface, WORKFLOW.md mutation, and the advisory file lock.
