---
name: gaggle-setup
description: Use when the user wants to install, configure, or initialize GaggleDispatch — including first-time setup, adding repositories, scaffolding gaggle.md files, or starting the orchestrator.
---

# GaggleDispatch Setup Wizard

Interactive setup guide. Follow these steps in order, using AskUserQuestion for multiple-choice decisions and plain text for freeform input.

**IMPORTANT — AskUserQuestion vs plain text:**
- **AskUserQuestion**: Only for multiple-choice decisions (pick A or B).
- **Plain text**: For freeform input (paths, URLs, tokens, slugs). Ask directly in your message — never wrap freeform input in AskUserQuestion.

---

## Prerequisites

Run these checks first:

```powershell
bun --version
git --version
gh --version
claude --version
archon version
```

**Claude Code is a direct prerequisite** — GaggleDispatch's Issue Analyzer uses the Claude Agent SDK, which invokes the `claude` binary for authentication (same mechanism as Archon). No separate `ANTHROPIC_API_KEY` is needed; run `claude /login` to authenticate.

**If `bun` is missing:**
```powershell
irm bun.sh/install.ps1 | iex
```
Verify: `bun --version`

**If `git` is missing:**
```powershell
winget install Git.Git
```

**If `gh` (GitHub CLI) is missing:**
```powershell
winget install GitHub.cli
# Then authenticate:
gh auth login
```

**If `claude` is missing or not authenticated:**
```powershell
irm https://claude.ai/install.ps1 | iex   # install
claude /login                              # authenticate
```

**If `archon` is missing:** Install it, then verify:

```powershell
# Windows (quick install)
irm https://archon.diy/install.ps1 | iex
archon version
```

```bash
# macOS / Linux (quick install)
curl -fsSL https://archon.diy/install | bash
archon version
```

Or from source (any platform):
```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
cd packages/cli && bun link
archon version
```

After installing, verify Claude Code is configured for Archon:
```bash
which claude   # must be in PATH
claude --version
```

If `archon version` shows a missing `CLAUDE_BIN_PATH` warning, set it:
```powershell
# Windows
$env:CLAUDE_BIN_PATH = (Get-Command claude).Source
[Environment]::SetEnvironmentVariable('CLAUDE_BIN_PATH', (Get-Command claude).Source, 'User')
```
```bash
# macOS / Linux
export CLAUDE_BIN_PATH=$(which claude)
echo "export CLAUDE_BIN_PATH=$(which claude)" >> ~/.zshrc   # or .bashrc
```

---

## Step 1: Locate or Clone GaggleDispatch

Use **AskUserQuestion**:

```
Header: "GaggleDispatch location"
Question: "Where is your GaggleDispatch installation?"
Options:
  1. "Use existing local clone" — provide the path
  2. "Clone from GitHub" — provide a GitHub URL
```

If "Use existing local clone": ask for the path in plain text. Store as `<gaggle-repo>`.

If "Clone from GitHub": ask for the URL in plain text, then:
```powershell
git clone <url> "$env:USERPROFILE\.gaggle\gaggledispatch"
```
Set `<gaggle-repo>` to the cloned directory.

---

## Step 2: Install and Link the CLI

```powershell
cd "<gaggle-repo>"
bun install
bun link
```

Verify:
```powershell
gaggle --version
```

If `gaggle: command not found` after `bun link`, open a new terminal — the PATH update takes effect in new shells.

---

## Step 3: Configure API Keys

`gaggle setup` requires masked interactive input — it **cannot** run via Bash inside Claude Code. Tell the user:

> "Time to configure your API keys. This must run in a separate terminal so your keys stay private — I won't see them.
>
> Open a new terminal, `cd` to the project directory, and run:
> ```
> gaggle setup
> ```
>
> It will prompt you for:
> 1. **LINEAR_API_KEY** — Linear → Settings → API → Personal API keys
>
> The Anthropic API key is **not** required here — GaggleDispatch inherits it from Claude Code's credential store, the same way Archon does.
>
> Keys are saved to `<base_folder>/.env` (the path shown when `gaggle init` ran). This file is scoped to this deployment and loaded automatically every time a `gaggle` command starts — no terminal restart needed.
>
> Come back here when the wizard completes."

Wait for user confirmation before proceeding.

**Verify the keys are set:**
```powershell
# Print the .env file — the base_folder path was shown during `gaggle init`
Get-Content "<base_folder>\.env"
```

Both `LINEAR_API_KEY` and `ANTHROPIC_API_KEY` lines should have values (not blank after `=`).

**Optional — GH_TOKEN (needed for `gaggle repo scaffold`):**
`GH_TOKEN` can be added to `<base_folder>/.env` manually, or via `gh auth login`:
```powershell
gh auth status
```
If not authenticated: `gh auth login` (this sets the token in the `gh` credential store; alternatively add `GH_TOKEN=ghp_xxx` directly to `<base_folder>/.env`).

---

## Step 4: Bootstrap the Project

Run in the directory that will contain `WORKFLOW.md` (typically the GaggleDispatch repo root or a dedicated config directory):

```powershell
gaggle init
```

This creates:
- **`WORKFLOW.md`** — deployment configuration (YAML front matter + docs)
- **`workflow_templates/`** — default Archon DAG workflow files (`gaggle-fix-issue.yaml`, `gaggle-supervised.yaml`, `gaggle-scaffold.yaml`)

Store this directory as `<project-dir>`.

---

## Step 5: Configure WORKFLOW.md

Open `<project-dir>/WORKFLOW.md` and set at minimum:

| Field | Where to get it | Example |
|---|---|---|
| `tracker.project_slug` | Linear → Settings → team key | `SYM` |
| `tracker.active_states` | Linear board column names | `[Todo, In Progress]` |
| `tracker.terminal_states` | Linear board column names | `[Done, Cancelled]` |
| `registry.base_folder` | Any directory **outside** `<project-dir>` | `C:\Users\you\.gaggle` |
| `archon.default_workflow` | Leave as `gaggle/gaggle-fix-issue` | — |

Ask the user for their **Linear team key** in plain text: "What is your Linear team key? (e.g., `SYM`, `ENG` — visible in Linear → Settings)"

A minimal correct `WORKFLOW.md` front matter:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: <team-key>
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
  assigned_to_me: true
  create_sub_issues: true

polling:
  interval_ms: 30000

agent:
  max_concurrent_agents: 4

archon:
  command: archon workflow run
  turn_timeout_ms: 7200000
  stall_timeout_ms: 600000
  default_workflow: gaggle/gaggle-fix-issue

claude:
  api_key: $ANTHROPIC_API_KEY
  analyzer_model: claude-sonnet-4-6

workflow_templates:
  path: workflow_templates/
  target_subdir: gaggle

registry:
  base_folder: $GAGGLE_BASE_FOLDER
  sync_interval_ms: 900000
  sync_on_startup: true

repositories: []
```

Set `GAGGLE_BASE_FOLDER` as a user environment variable pointing outside `<project-dir>`:
```powershell
[Environment]::SetEnvironmentVariable('GAGGLE_BASE_FOLDER', "$env:USERPROFILE\.gaggle\data", 'User')
```

---

## Step 6: Register Repositories

Ask the user (plain text): "Which GitHub repositories should GaggleDispatch orchestrate? Provide their full URLs, one per line."

For each URL:
```powershell
gaggle repo add <url>
```

This registers the repo in `WORKFLOW.md`. The CLI acquires an advisory lock — run commands one at a time, not in parallel.

Verify:
```powershell
gaggle repo list
```

---

## Step 7: Sync Repos

Clone all registered repos and parse their `gaggle.md` files:

```powershell
gaggle sync
```

This creates `$GAGGLE_BASE_FOLDER/repos/` with local checkouts and writes `$GAGGLE_BASE_FOLDER/registry.synced.yaml`.

---

## Step 8: Scaffold Missing gaggle.md Files

Check which repos are missing `gaggle.md`:

```powershell
gaggle status
```

Look for repos with `gaggle_md: missing` in the output. For each:

```powershell
gaggle repo scaffold <url>
```

This launches an Archon workflow that reads the repo source code and opens a draft PR with a generated `gaggle.md`. It runs asynchronously — use `--async` if you want to return control immediately:

```powershell
gaggle repo scaffold <url> --async
gaggle scaffold status   # check job progress
```

Once PRs are merged into each target repo, run `gaggle sync` again to pull in the new files.

**Repos without `gaggle.md` will be skipped** by the Issue Analyzer — this is expected until the file is merged.

---

## Step 9: Verify

```powershell
gaggle status
```

Healthy output shows:
- Each registered repo with `sync_status: ok` (or `gaggle_md: present`)
- No unresolved errors

```powershell
gaggle repo list
```

Confirm all repos appear with their aliases.

---

## Step 10: Start the Orchestrator

```powershell
gaggle start
```

GaggleDispatch will:
1. Restore any in-flight issues from Linear labels (crash recovery)
2. Begin the poll loop (default every 30s)
3. Analyze new issues via Claude and dispatch Archon workflows to registered repos

To run in the background on Windows, wrap in a PowerShell job or use Windows Task Scheduler. For long-running deployments, use `gaggle hub start` (multi-repo hub mode).

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `gaggle: command not found` | `bun link` not run or PATH not updated | Re-run `bun link` in `<gaggle-repo>`, open a new terminal |
| `LINEAR_API_KEY not set` | Env var missing or new terminal needed | Re-run `gaggle setup`, open new terminal |
| `GAGGLE_BASE_FOLDER not set` | Env var not persisted | Set via `[Environment]::SetEnvironmentVariable(...)` and open new terminal |
| `registry.synced.yaml not found` | `gaggle sync` not run | Run `gaggle sync` |
| Issue routed to no repos | Repos missing `gaggle.md` | Run `gaggle repo scaffold <url>` for each repo, merge the PR |
| `.gaggle.lock` timeout | Another gaggle command running | Wait 10s and retry; kill stale processes if needed |
| `archon: command not found` | Archon not installed or not in PATH | Install Archon (use the `archon` skill), then retry |
| Linear 401 errors | Invalid or expired API key | Re-run `gaggle setup` with a fresh key |

---

## Final Summary

Tell the user what was configured:
- `<project-dir>/WORKFLOW.md` — orchestration config
- `<project-dir>/workflow_templates/` — default Archon DAG workflows (synced to each repo on dispatch)
- `<project-dir>/.claude/skills/gaggle/` — Claude Code skill (copied automatically by `gaggle init`)
- `$GAGGLE_BASE_FOLDER/repos/` — local checkouts of registered repos
- `$GAGGLE_BASE_FOLDER/registry.synced.yaml` — merged routing registry

The `gaggle` skill lets Claude Code in this project understand how to run gaggle workflows, signal cross-repo blockers, start the orchestrator, and update `gaggle.md` files. Open Claude Code here and say: **"Start the orchestrator"** or **"Use gaggle to fix issue #42"**.

Next steps:
1. Merge any pending `gaggle.md` PRs in registered repos
2. Run `gaggle sync` after merges to update the registry
3. Assign a Linear issue to yourself in an active state — GaggleDispatch will pick it up on the next poll
4. To customize routing, edit a repo's `gaggle.md` (components, workflows, external integrations)
5. To add workflow templates, drop YAML files into `workflow_templates/` — they propagate to all repos on next dispatch

> "To adjust concurrency, polling interval, gate timeouts, or Linear OAuth, ask me to help you configure `WORKFLOW.md` — I'll walk you through each field."
