# Supervised Workflow Improvements — Design Spec

**Date:** 2026-05-14  
**Status:** Approved

---

## Overview

Two related improvements to the GaggleDispatch workflow system:

1. **Supervised workflow**: Add a human-in-the-loop clarification phase before planning, and post an architectural analysis summary to the Linear issue comment (+ plan-gate message) after planning.
2. **Issue Analyzer**: Complexity-based workflow routing — the analyzer decides `gaggle-fix-issue` vs `gaggle-supervised` based on issue complexity, overriding the repo's `default_workflow`.

---

## Change 1: Supervised Workflow

### Affected files

| File | Change |
|---|---|
| `src/cli/templates-default.ts` | Add clarification phase + summarize/post-summary nodes |
| `C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml` | Same |
| `C:/Repos/trialmatch/repos/TrialMatch-FE/.archon/workflows/gaggle/gaggle-supervised.yaml` | Same |
| `C:/Repos/trialmatch/repos/TrialMatch-BE/.archon/workflows/gaggle/gaggle-supervised.yaml` | Same |

### Phase 2.5: Clarification (new, inserted after `classify`, before `plan`/`investigate`)

The agent drives the conversation — the human only answers. Two rounds maximum.

#### Nodes

**`clarify`** (LLM, haiku, `context: fresh`, `depends_on: [classify]`)  
Reads the issue from `$USER_MESSAGE`. Determines if there are ambiguous, underspecified, or missing requirements that would meaningfully change the implementation approach. Runs before `investigate`/`plan` so answers can shape the plan.

- If questions exist: writes them as a numbered list to `$ARTIFACTS_DIR/questions.md`
- If nothing is unclear: writes the single word `NONE` to `$ARTIFACTS_DIR/questions.md`

Questions should be targeted and concrete. Do not ask for information that can be inferred from the codebase.

**`clarify-needed`** (bash)  
Reads `questions.md`. Outputs `YES` if content is not `NONE`, otherwise `NO`.

**`clarify-post-round-1`** (bash, `when: "$clarify-needed.output == 'YES'"`)  
Posts the questions to the Linear issue as a comment via the Linear GraphQL API using `$GAGGLE_ISSUE_ID` and `$LINEAR_API_KEY`. Writes the questions to `$ARTIFACTS_DIR/answers.md` as a header for context tracking.

**`clarify-gate-round-1`** (approval, `when: "$clarify-needed.output == 'YES'"`)  
Presents the questions to the human. Uses `capture_response: true`. No `on_reject` — the human simply answers. Gate message:

```
## Clarifying Questions

$(cat "$ARTIFACTS_DIR/questions.md")

Please answer these questions. Your response will be used to shape the implementation plan.
```

**`clarify-evaluate-round-1`** (LLM, haiku, `when: "$clarify-needed.output == 'YES'"`)  
Receives the human's answers via `$clarify-gate-round-1.output`. Evaluates whether the answers are sufficient to proceed to planning. 

Output format:
```json
{
  "complete": "true" | "false",
  "followup_questions": "numbered list of remaining questions, or empty string if complete"
}
```

Appends answers to `$ARTIFACTS_DIR/answers.md`. If not complete, writes follow-up questions to `$ARTIFACTS_DIR/questions.md`.

**`clarify-post-round-2`** (bash, `when: "$clarify-evaluate-round-1.output.complete == 'false'"`)  
Posts follow-up questions to Linear (same mechanism as round 1).

**`clarify-gate-round-2`** (approval, `when: "$clarify-evaluate-round-1.output.complete == 'false'"`)  
Same structure as round 1. Captures human answers. After this gate the chain always proceeds to planning regardless — two rounds is the maximum.

After the clarification chain, the existing `investigate` / `plan` nodes are updated to also read `$ARTIFACTS_DIR/answers.md` if it exists, incorporating the gathered context.

---

### Phase 2.7: Architectural Summary (new, inserted after `bridge-artifacts`, before `plan-gate`)

#### Nodes

**`summarize`** (LLM, haiku, `context: fresh`)  
Reads `$ARTIFACTS_DIR/investigation.md` (the full plan) and produces `$ARTIFACTS_DIR/plan-summary.md`.

The summary is an **architectural analysis for a human reviewer** — not a task list. The prompt explicitly forbids:
- File names and line numbers
- Numbered implementation steps
- Low-level "what the code will do" detail

The summary must cover (omitting sections not applicable):
- **Approach rationale** — why this approach over alternatives (1–2 sentences)
- **Architecture & component design** — which layers/systems are touched and how they relate
- **UX / interaction patterns** — new flows, state transitions, user-facing behaviour changes
- **Key design decisions** — trade-offs made, conventions followed, patterns chosen
- **Risks at a design level** — things that could go wrong at the architectural level
- **Questions & Clarifications** *(optional)* — anything remaining ambiguous after the clarification phase that the human should be aware of; omit entirely if nothing is unclear

**`post-summary`** (bash)  
Posts `plan-summary.md` content to the Linear issue as a comment and also saves the content to `$ARTIFACTS_DIR/post-summary-result.txt` for error visibility. Uses `$GAGGLE_ISSUE_ID` and `$LINEAR_API_KEY`.

Implementation:
```bash
BODY=$(cat "$ARTIFACTS_DIR/plan-summary.md")
# Escape body for JSON embedding
ESCAPED=$(printf '%s' "$BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
curl -sf -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --data "{\"query\": \"mutation { commentCreate(input: { issueId: \\\"$GAGGLE_ISSUE_ID\\\", body: $ESCAPED }) { success comment { id } } }\"}" \
  -o "$ARTIFACTS_DIR/post-summary-result.txt" || echo "WARNING: failed to post summary to Linear" >&2
```

Failure does **not** abort the workflow — it logs a warning only.

**`plan-gate`** (updated message)  
The existing gate message is replaced with:

```
## Architectural Summary

$(cat "$ARTIFACTS_DIR/plan-summary.md")

---

The full implementation plan is in the Archon run output above.

- **approve** (optionally with answers to any questions above) — starts implementation immediately
- **reject: <your feedback>** — triggers a revised plan addressing your concerns

You have up to 3 revision cycles before the workflow proceeds automatically.
```

---

## Change 2: Complexity-Based Workflow Routing

### Affected files

| File | Change |
|---|---|
| `src/analyzer/issue-analyzer.ts` | Update `buildPrompt` + parse `complexity` field |

### Prompt change

Add a `complexity` field to the JSON output schema with this rubric embedded in the instructions:

```
"simple"  — ALL of the following: touches a single component, no new UX flows or
            architectural decisions, clear and fully specified scope, no cross-repo
            dependencies introduced. Examples: fix a typo, adjust a config value,
            add a null check, update a label.

"complex" — ANY of the following: spans multiple components or repos; introduces
            new UX flows, screens, or interaction patterns; requires architectural
            decisions (state shape, API contracts, auth changes, shared
            infrastructure); has ambiguous or underspecified requirements that a
            human should validate before implementation begins.
```

The prompt instructs Claude to assign `complexity` first, then use it — not the repo's `default_workflow` — to determine `archon_workflow`:
- `"simple"` → `gaggle/gaggle-fix-issue`
- `"complex"` → `gaggle/gaggle-supervised`

The instruction to "use the workflow from gaggle.md available_workflows, or its default_workflow" is replaced with: "use complexity to decide the workflow as above, then verify it appears in the repo's available_workflows list."

### Analyzer code change

In `IssueAnalyzer.analyze()`:

1. Parse `complexity` from the JSON (`"simple"` | `"complex"`, default to `"complex"` if missing/invalid).
2. Determine the target workflow name from complexity:
   - `simple` → `gaggle/gaggle-fix-issue`
   - `complex` → `gaggle/gaggle-supervised`
3. For each `RepoTarget`, override `archon_workflow` with the complexity-derived value.
4. Validation: check that the chosen workflow appears in the repo's `available_workflows` (read from the parsed `gaggle.md` context if available). If it doesn't, fall back to `matched.default_workflow` with a `logger.warn` call.
5. Prepend `[complexity: simple]` or `[complexity: complex]` to `analysis_summary` so it's visible in logs and the GaggleDispatch dashboard.

### Type change

`IssueAnalysis` in `src/domain/types.ts` gains an optional `complexity` field:
```ts
complexity?: 'simple' | 'complex';
```

This is surfaced in the dashboard and logs but has no other runtime effect beyond workflow selection.

---

## Node insertion order in the supervised workflow

Final node sequence after both changes:

```
classify
  → clarify                               [NEW]
  → clarify-needed                        [NEW]
  → clarify-post-round-1                  [NEW, conditional]
  → clarify-gate-round-1                  [NEW, conditional]
  → clarify-evaluate-round-1             [NEW, conditional]
  → clarify-post-round-2                  [NEW, conditional]
  → clarify-gate-round-2                  [NEW, conditional]
  → investigate (bug) / plan (non-bug)   [EXISTING - updated to depend on clarify chain + read answers.md]
  → bridge-artifacts
  → summarize                             [NEW]
  → post-summary                          [NEW]
  → plan-gate                             [EXISTING - updated message]
  → implement
  → validate-script → validate
  → create-pr → verify-pr-base
  → review-scope → review-classify
  → code-review / error-handling / test-coverage / comment-quality / docs-impact
  → synthesize → self-fix → simplify
  → report
```

---

## Out of scope

- Changing the `gaggle-fix-issue` workflow (no supervised gate, no clarification loop)
- Changing `gaggle-scaffold.yaml`
- Modifying how GaggleDispatch handles gate replies (existing approve/reject keywords unchanged)
- Adding clarification loops to the `gaggle-fix-issue` workflow

---

## Open questions / risks

- `python3` is assumed available in the bash environment for JSON escaping of the summary body. If unavailable, `jq` or a pure bash escaping approach must be used as fallback.
- `python3` is assumed available in the bash environment for JSON escaping the summary body. If unavailable, `jq` must be used as fallback — implementer should check what's reliably present in Archon's bash environment.
- `available_workflows` from `gaggle.md` is not currently parsed into the `RegistryRepo` type — a type update may be needed to validate the complexity-chosen workflow against available options.
