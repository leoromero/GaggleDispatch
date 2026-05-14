# README Redesign — Design Spec

Date: 2026-05-14  
Status: Approved

## Goal

Rewrite `README.md` as a proper open-source GitHub page targeting two audiences:

- **B — Engineering teams evaluating automated coding tools**: know Linear, maybe Claude, Archon is
  new; need the "why this vs. just running Claude directly" pitch before they dig into docs.
- **C — Open-source contributors**: want to understand the codebase, fork it, extend it;
  architecture depth matters.

The current README has all the right content but leads with setup instead of value. We reorder and
add four new sections at the top; everything else follows verbatim.

---

## Structure

```
# GaggleDispatch
  [paragliding tagline — one italic line]
  [hero paragraph — what it is, what it does, what it doesn't do]
  [Symphony spec + default stack note — pluggability callout]
  ### What you get [4 bullets: routing, fan-out, deterministic execution, pluggable adapters]

## How it works
  ### The federated registry — gaggle.md
    gaggle repo scaffold explanation: Claude researches the repo and opens a draft PR
  ### Orchestration flow
    ASCII diagram: tracker → GaggleDispatch (analyzer) → repo targets → Archon sessions → PRs
  [closing paragraph: scheduler/analyzer/runner boundary]
  [tracker-as-state-machine paragraph — Symphony spec principle]

## The Archon connection
  [free-form loop vs DAG table]
  [minimal YAML snippet showing classify → investigate → implement nodes]
  [gate bridging: approval node → tracker comment → human reply → archon approve]
  [blocker protocol: blocker-request.md → GaggleDispatch creates upstream issue → restarts]

## Built on the Symphony specification
  [spec credit + conforming implementation statement]
  ### Multi-repo fan-out with self-discovered dependencies
    yaml snippet showing repo_targets with depends_on + ready_when
  ### Automatic sub-issue creation
  ### Agent-driven blocker creation
  ### Startup crash recovery via tracker labels

## Requirements          [existing — unchanged]
## Quick start           [existing — unchanged]
## CLI reference         [existing — unchanged]
## Authenticating with Linear  [existing — unchanged]
## Configuration cheatsheet    [existing — unchanged]
## Workflow templates          [existing — unchanged]
## Supervised gates            [existing — trimmed: gate detail now in Archon section]
## Project layout              [existing — hub/ added to directory tree]
## Development                 [existing — unchanged]
## Conformance                 [existing — unchanged]
## License                     [existing — unchanged]
```

---

## Section content (approved)

### Hero

```markdown
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
```

---

### How it works

```markdown
## How it works

### The federated registry — `gaggle.md`

Every registered repository owns a `gaggle.md` at its root: a structured self-description of what
the repo does, its components, and its external dependencies. GaggleDispatch uses this file to
route issues without any central architecture document.

You don't write `gaggle.md` by hand. Run:

\`\`\`bash
gaggle repo scaffold https://github.com/myorg/my-service
\`\`\`

Archon launches a Claude agent that reads the repo's source code, maps its components and
integrations, and opens a draft PR with the generated `gaggle.md`. Once merged, GaggleDispatch
syncs it automatically. Every subsequent issue is routed using that living document.

### Orchestration flow

\`\`\`
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
\`\`\`

GaggleDispatch is the **scheduler, analyzer, and runner**. It owns tracker writes (state changes,
comments, labels) and orchestration policy (routing, concurrency, retries, crash recovery). Code,
git, and PR creation belong entirely to the workflow executor.

A core principle from the Symphony specification: **the tracker is the state machine.** No local
database. GaggleDispatch persists no scheduler state to disk — Linear labels (`gaggle:claimed`,
`gaggle:running`, `gaggle:waiting-human`) are the durable record. On crash or restart,
GaggleDispatch reads those labels and reconstructs exactly where it left off.
```

---

### The Archon connection

```markdown
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

\`\`\`yaml
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
\`\`\`

GaggleDispatch bridges Archon with the tracker on two critical events:

- **Approval gates** — when a workflow hits an `approval` node, GaggleDispatch frees the
  concurrency slot, posts the gate message as a tracker comment, and polls for a human reply.
  `approve` or `reject` resumes the workflow via the Archon API.
- **Cross-repo blockers** — if an agent discovers mid-implementation that it needs a change in
  another repository, it writes a structured `blocker-request.md` and exits. GaggleDispatch
  detects the file, creates the upstream issue in the tracker, marks the current issue as blocked,
  and restarts implementation automatically once the blocker is resolved. The agent never needs to
  know about cross-repo orchestration — it just signals the constraint.
```

---

### Built on Symphony

```markdown
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

\`\`\`yaml
repo_targets:
  - repo: shared-auth-lib
    workflow: gaggle/gaggle-fix-issue
  - repo: patient-ingestion-service
    workflow: gaggle/gaggle-fix-issue
    depends_on: [shared-auth-lib]
    ready_when: merged
\`\`\`

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
```

---

## What changes vs. current README

| Section | Change |
|---|---|
| Hero | Entirely new — paragliding tagline, pitch paragraph, 4-bullet value prop |
| How it works | Entirely new — gaggle.md origin story, ASCII diagram, state-machine principle |
| The Archon connection | Entirely new — DAG table, YAML snippet, gate + blocker bridging |
| Built on Symphony | Entirely new — spec credit, 4 extensions |
| Multi-repo fan-out | Removed as standalone section — absorbed into "Built on Symphony" |
| Crash safety | Removed as standalone section — absorbed into "How it works" + "Built on Symphony" |
| Supervised gates | Kept, trimmed — gate mechanics now introduced in "Archon connection" |
| Project layout | Kept — `hub/` directory added to tree |
| All other sections | Kept verbatim |

## Out of scope

- Adding badges (CI, npm, license) — future task
- Docs subdirectory split — future task if README grows further
- Any code changes
