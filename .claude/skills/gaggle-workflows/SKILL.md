---
name: gaggle-workflows
description: |
  Use when: Authoring, editing, validating, or debugging GaggleDispatch workflow
  YAML — the DAG files under `.gaggle/workflows/` — or the command prompts under
  `.gaggle/commands/`.
  Triggers: "create a workflow", "write a workflow", "author a workflow",
            "new workflow", "edit a workflow", "workflow yaml", "add a node",
            "approval gate", "loop node", "when condition", "trigger_rule",
            "$nodeId.output", "validate my workflow", "make a command",
            "override a bundled command".
  Capability: The workflow document model GaggleDispatch's engine executes —
  node types, dependency and condition semantics, variable substitution, gates,
  loops, and resume behaviour.
  NOT for: Routing decisions or orchestration (see the `gaggle` skill), or
  GaggleDispatch setup (see `gaggle-setup`).
argument-hint: "[workflow name]"
---

# Authoring GaggleDispatch workflows

A workflow is a YAML file describing a DAG. Each node runs a Claude prompt, a
shell script, a loop, or an approval gate. Independent nodes run concurrently,
conditions route between branches, and data moves between nodes through
`$nodeId.output` and files in `$ARTIFACTS_DIR`.

The engine runs inside the GaggleDispatch process and records every run, node,
and gate to Postgres, which is what makes a run resumable across a crash or a
gate that waits overnight.

## Where things live

```
.gaggle/
├── workflows/     # DAG definitions (.yaml) — committed
├── commands/      # Reusable prompts (.md) for `command:` nodes — committed
└── scripts/       # Named scripts for `script:` nodes (.ts/.js → bun, .py → uv)
```

A workflow's identity is its `name:` field, not its path. A repo-local
definition shadows a synced template of the same name, and a
`.gaggle/commands/<name>.md` overrides the bundled command of that name.

## Reference

| File | Covers |
|---|---|
| `references/workflow-dag.md` | The document schema: node types, dependencies, conditions, trigger rules, structured output, loops, approval gates, cancel nodes |
| `references/variables.md` | Variable substitution and where each variable applies |
| `references/dag-advanced.md` | Retry semantics and error classification |
| `references/cli-commands.md` | Run lifecycle and CLI surface |
| `examples/dag-workflow.yaml` | A worked example |
| `examples/command-template.md` | Command file shape |

Those references were written against Archon's YAML, which this engine
deliberately kept — the document model is the same. Where they describe the
`archon` CLI or its web UI, see the differences below.

## Always validate before finishing

```bash
gaggle workflow validate <name>
```

This catches what would otherwise surface twenty minutes into a run:
dependency cycles, `$node.output` references to nodes that do not exist or are
not upstream, unparseable `when:` expressions, missing command files, and node
bodies declaring two mutually exclusive types.

## Differences from the Archon documents

**`side_effects: at_most_once`** is new. It marks a node whose effect reaches
outside the run — opening a pull request, posting a comment. Such a node is
never retried automatically, and if a crash interrupts it the run parks at a
gate for a human rather than guessing whether the effect already landed.

```yaml
- id: create-pr
  side_effects: at_most_once
  prompt: "Open a draft PR for the changes on this branch."
```

**`interactive:`** is parsed but has no effect. It existed because a workflow
dispatched to a background worker had no channel to deliver a gate message;
here a gate always pauses the run and persists its message, and whoever is
driving — the orchestrator via Linear, or a human via `gaggle` — reads it from
there.

**Approve and resume are one operation.** There is no separate "store the
approval" step that leaves the run parked.

**Resume** skips nodes that already completed and reuses their output, guarded
by a hash of the normalized document. If the YAML changed since the run
started, resume is refused rather than mixing outputs from two versions; force
it only when you accept discarding the cached outputs.

**`bash:` nodes need a POSIX shell.** On Windows that means Git Bash, or
`GAGGLE_BASH` pointing at one. `gaggle doctor` checks it.
