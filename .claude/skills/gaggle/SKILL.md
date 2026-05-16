---
name: gaggle
description: |
  Use when: This repo is managed by GaggleDispatch and the user wants to run a gaggle
  workflow, signal a cross-repo blocker, check orchestration status, start/stop the
  orchestrator (nest), update gaggle.md, or understand how GaggleDispatch routed this issue.
  Triggers (run): "use gaggle to", "run gaggle", "gaggle workflow", "dispatch this issue",
            "have gaggle fix", "let gaggle handle", "gaggle fix issue".
  Triggers (status/start): "start the nest", "start the orchestrator", "gaggle status",
            "what is gaggle doing", "is gaggle running", "orchestrator status".
  Triggers (blocker): "signal a blocker", "cross-repo dependency", "need a change in another repo",
            "blocker-request", "blocked by another service".
  Triggers (config): "update gaggle.md", "regenerate gaggle.md", "scaffold gaggle.md",
            "what does this repo do in gaggle", "gaggle routing".
  Capability: Orchestrates multi-repo AI coding workflows via Linear issues. GaggleDispatch
  reads this repo's gaggle.md, routes issues to it, and dispatches Archon workflows.
argument-hint: "[workflow] [issue number or description]"
---

# GaggleDispatch Skill

GaggleDispatch is the multi-repo orchestrator that dispatched work to this repository. It reads
issues from Linear, analyzes which repos are affected using each repo's `gaggle.md`, and runs
Archon DAG workflows in isolated git worktrees. It never writes code itself.

## Available Gaggle Workflows (live)

!`archon workflow list 2>&1 | grep -i gaggle || echo "No gaggle workflows found — run 'gaggle sync' from the GaggleDispatch repo to sync templates into .archon/workflows/gaggle/."`

## Routing

| Intent | Action |
|--------|--------|
| **Run a gaggle workflow** | Continue with "Running Workflows" below |
| **Signal a cross-repo blocker** | Read "Signaling a Blocker" section below |
| **Start / restart the orchestrator** | Read "Orchestrator Commands" below |
| **Check what GaggleDispatch is doing** | Run `gaggle status` from the GaggleDispatch project dir |
| **Update this repo's routing description** | Read "The gaggle.md File" section below |
| **Regenerate gaggle.md from scratch** | Run `archon workflow run gaggle/gaggle-scaffold --branch scaffold/gaggle-md "Generate gaggle.md"` |
| **Set up GaggleDispatch for the first time** | Use the `gaggle-setup` skill from the GaggleDispatch repo |

---

## Running Workflows

Gaggle workflows are Archon DAG workflows synced by GaggleDispatch into `.archon/workflows/gaggle/`.
Run them like any other Archon workflow — always in a worktree, always in the background:

```bash
archon workflow run gaggle/gaggle-fix-issue --branch fix/issue-42 "Fix issue #42"
```

### Workflow Selection

| User Intent | Workflow | Branch Pattern |
|------------|----------|----------------|
| Fix a bug or implement a feature (default) | `gaggle/gaggle-fix-issue` | `fix/issue-{N}` or `feat/{name}` |
| Risky change needing human plan approval | `gaggle/gaggle-supervised` | `feat/{name}` |
| Generate or regenerate `gaggle.md` | `gaggle/gaggle-scaffold` | `scaffold/gaggle-md` |

**CRITICAL RULES** (same as Archon):
1. **Always run in background** — use `run_in_background: true` in the Bash tool.
2. **Always use `--branch`** — worktree isolation prevents conflicts.
3. **One workflow per shell** — each workflow blocks its shell.

---

## Signaling a Cross-repo Blocker

If you (or an Archon workflow agent) discover mid-implementation that work in **another repository**
is needed before this repo can proceed, signal a blocker:

1. Write `$ARTIFACTS_DIR/blocker-request.md` (inside the running Archon workflow's artifacts dir):

```markdown
---
title: "Need <short description of the required upstream change>"
description: "<Which repo>, <what change>, <why this repo is blocked>"
target_repo: "repo-alias-or-github-url"   # optional — omit if unknown
---

Narrative description of what is needed and why this repo cannot proceed without it.
```

2. Exit the workflow (or let the current node complete normally).

GaggleDispatch detects `blocker-request.md`, creates an upstream Linear issue in the target repo,
marks the current issue as blocked, and automatically re-queues this repo's work once the blocker
is resolved. **No further action needed from the agent.**

---

## Approval Gates

When a gaggle workflow pauses at an `approval` node:

1. GaggleDispatch detects the pause from Archon, frees the concurrency slot.
2. It posts the gate message as a comment on the Linear issue.
3. A `gaggle:waiting-human` label is applied.
4. A human replies in Linear with `approve` / `lgtm` / `yes` or `reject` / `no` / `cancel`.
5. GaggleDispatch resumes the workflow via Archon, injecting the human's reply.

**No agent action required** — the orchestrator handles all gate communication.

---

## The gaggle.md File

`gaggle.md` at the root of this repo is its **routing self-description**. GaggleDispatch's Issue
Analyzer reads it to decide whether a Linear issue should be dispatched here, and which workflow
to use.

**When to update it:**
- You add a new component, service, or external integration
- This repo starts or stops talking to another system
- The default workflow should change

**Structure:**
```yaml
---
name: kebab-case-alias         # globally unique across all registered repos
description: "1–3 dense sentences describing what this repo does"
default_workflow: gaggle/gaggle-fix-issue
available_workflows:
  - gaggle/gaggle-fix-issue
  - gaggle/gaggle-supervised
components:
  - name: component-name
    component_type: worker | cli | api | other
    description: "what it does"
    communicates_with:
      - component: external-system-name
        method: graphql | http | grpc | subprocess | queue
        direction: bidirectional | produces | reads
---

Narrative markdown explaining the repo's role in the system...
```

After editing `gaggle.md`, run `gaggle sync` from the GaggleDispatch project to pick up the change.

---

## Orchestrator Commands

Run these from the **GaggleDispatch project directory** (where `WORKFLOW.md` lives):

```bash
# Start the orchestrator (single-instance mode)
gaggle start

# Start the hub / nest (multi-deployment mode with dashboard)
gaggle hub start

# Check what the orchestrator sees right now
gaggle status

# Check registered repos and their sync status
gaggle repo list

# Force a sync of all registered repos (re-reads gaggle.md from each)
gaggle sync

# Add this repo to GaggleDispatch (if not already registered)
gaggle repo add https://github.com/<org>/<this-repo>

# Scaffold a gaggle.md PR for a repo missing one
gaggle repo scaffold https://github.com/<org>/<repo>
```

### Linear Labels (read-only state machine)

GaggleDispatch writes these labels to Linear issues — do not create or remove them manually:

| Label | Meaning |
|-------|---------|
| `gaggle:claimed` | Issue locked for analysis |
| `gaggle:analyzing` | Issue Analyzer (Claude) running |
| `gaggle:queued` | Analysis done, waiting for dispatch |
| `gaggle:running` | Archon workflow in progress |
| `gaggle:waiting-human` | Approval gate active |
| `gaggle:retrying` | Retry in progress after failure |
| `gaggle:failed` | Workflow failed, needs manual review |

---

## Example Interactions

**User**: "Use gaggle to fix issue #42"
```bash
archon workflow run gaggle/gaggle-fix-issue --branch fix/issue-42 "Fix issue #42"
```

**User**: "Run the supervised workflow for this risky migration"
```bash
archon workflow run gaggle/gaggle-supervised --branch feat/migration "Perform the database migration"
```

**User**: "Start the orchestrator"
→ `cd <gaggle-dispatch-project-dir> && gaggle start`

**User**: "What is GaggleDispatch doing right now?"
→ `cd <gaggle-dispatch-project-dir> && gaggle status`

**User**: "This repo needs a change in shared-auth-lib before I can proceed"
→ Write `$ARTIFACTS_DIR/blocker-request.md` with the required change description and exit.

**User**: "Update gaggle.md to add the new payments component"
→ Edit `gaggle.md` directly, then `gaggle sync` from the GaggleDispatch project.
