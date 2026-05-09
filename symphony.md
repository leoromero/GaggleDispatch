---
name: gaggledispatch
description: GaggleDispatch is a federated, multi-repo AI coding orchestrator. It reads work items from Linear, routes each issue to the correct repositories using Claude analysis of per-repo symphony.md self-descriptions, and dispatches Archon workflow runs in isolated per-issue workspaces. It acts as the central scheduler and coordinator for autonomous AI coding agents across a distributed multi-service system.
default_workflow: symphony/symphony-fix-issue
components:
  - name: cli
    description: Commander-based CLI (gaggle / symphony) providing setup, init, repo management, scaffold, sync, status, and start subcommands
    component_type: cli
    communicates_with:
      - orchestrator
      - registry
      - repo-syncer
  - name: orchestrator
    description: Long-running poll loop that fetches Linear issues, invokes the analyzer, fans out to per-repo workers, manages retry/backoff, supervised gates, and reconciliation
    component_type: worker
    communicates_with:
      - linear-tracker
      - issue-analyzer
      - archon-executor
      - workspace-manager
      - registry
  - name: issue-analyzer
    description: Calls the Anthropic Claude API with the full RegistryContext and a normalized issue to produce a JSON routing decision mapping the issue to one or more RepoTargets with workflow selections
    component_type: service
    communicates_with:
      - Anthropic Claude API
      - registry
  - name: archon-executor
    description: Spawns and supervises archon workflow run processes, streaming stderr line-by-line, detecting gate-pause events via UUID pattern matching, and emitting typed lifecycle events
    component_type: worker
    communicates_with:
      - Archon CLI
  - name: linear-tracker
    description: GraphQL adapter for the Linear API handling issue fetch, label management, state transitions, comment posting, sub-issue creation, and viewer resolution
    component_type: api
    communicates_with:
      - Linear GraphQL API
  - name: registry
    description: Federated source registry that clones and syncs registered repositories, parses their symphony.md front matter and narrative, and exposes a RegistryContext to the analyzer and orchestrator
    component_type: service
    communicates_with:
      - registered-repos
      - repo-syncer
  - name: repo-syncer
    description: Background service that periodically git-pulls each registered repository and updates the synced-registry YAML with sync status, last commit SHA, parsed frontmatter, and narrative
    component_type: worker
    communicates_with:
      - registered-repos
      - registry
  - name: workspace-manager
    description: Validates and prepares per-issue per-repo working directories, runs before/after hooks, and syncs Archon workflow templates into each checkout before dispatch
    component_type: service
    communicates_with:
      - archon-executor
      - repo-syncer
available_workflows:
  - symphony/symphony-fix-issue
  - symphony/generate-symphony-md
---

## Role in the Broader System

GaggleDispatch is the top-level orchestration layer for a distributed, AI-assisted engineering workflow. It sits above all other service repositories and acts as the decision-making daemon that turns Linear project management work into autonomous coding agent activity. Every other repository in the system is a *target* that GaggleDispatch reads, analyzes, and dispatches work into — GaggleDispatch itself is never a target of another orchestrator.

The system depends on per-repo `symphony.md` files as the single source of truth for system topology. GaggleDispatch clones all registered repositories, reads their `symphony.md` front matter and narrative bodies, and assembles a `RegistryContext` that it feeds verbatim to Claude for issue routing. This means topology knowledge is decentralized: each service team owns its own self-description, and GaggleDispatch stays topology-agnostic.

## Key Architectural Decisions

**Federated registry over a central architecture document.** Earlier designs used a single `ARCH.md` maintained by hand. This was replaced by per-repo `symphony.md` files that each team controls. GaggleDispatch's `repo-syncer` assembles the live picture from git. Stale documentation is structurally impossible when the registry is derived from the repos themselves.

**Claude as the router.** Rather than hand-written routing rules, GaggleDispatch passes the full `RegistryContext` plus the normalized issue to Claude and receives a JSON `IssueAnalysis` with typed `RepoTarget` entries. This trades determinism for adaptability: new repositories and components are automatically considered once their `symphony.md` is registered and synced, with no code changes required in GaggleDispatch.

**Archon as the execution substrate.** GaggleDispatch does not implement its own agentic loop. It shells out to `archon workflow run` and monitors stderr for gate-pause events (UUID + keyword pattern). This keeps GaggleDispatch thin — it manages concurrency, retry, and observability while Archon manages the Claude turn loop and tool execution.

**Supervised gates for human checkpoints.** When Archon pauses at an approval gate, GaggleDispatch frees the concurrency slot, posts a comment on the Linear issue, and polls for a human `approve` / `reject` reply. This allows long-running agentic tasks to include mandatory human review steps without blocking other work.

**Per-issue workspace isolation.** Each `(issue, repo)` pair gets an isolated checkout directory inside the registry base folder. Workers run with `--cwd` pointing at this directory, so agent file operations are scoped and cleanup is deterministic on issue completion or cancellation.

**WORKFLOW.md as versioned policy.** The agent prompt template, model selection, and runtime knobs (concurrency, timeouts, retry limits) live in a `WORKFLOW.md` file in the GaggleDispatch deployment directory, not in application code. Teams version their orchestration policy alongside their infrastructure code.

## Integration Points

| External System | Direction | Purpose |
|---|---|---|
| Linear GraphQL API | reads + writes | Fetch candidate issues; apply labels (`symphony:claimed`, `symphony:running`, `symphony:queued`, `symphony:waiting-human`); post gate comments; create sub-issues; update state |
| Anthropic Claude API | produces requests | Issue routing analysis via `claude-3-5-sonnet` (configurable); returns JSON `IssueAnalysis` |
| Archon CLI | spawns subprocess | Execute per-repo workflow runs; receive approve/reject signals for supervised gates |
| Registered git repos | clones + pulls | Source of `symphony.md` documents that define the federated registry |
